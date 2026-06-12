const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-intro");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const siteUrl = process.env.INTRO_SITE_URL || "http://127.0.0.1:5173/";
const width = 1080;
const height = 1920;
const fps = 25;

const lines = [
  "这是 AI 足球预测，基于中国竞彩网官方数据做赛前分析。",
  "首页可以看到当天赛程、胜平负 SP、让球 SP 和模型可信度。",
  "完场比赛保留赛前预测和官方比分，方便做复盘，不会赛后改答案。",
  "世界杯专栏已经接入小组赛预测、三十二强路径和争冠层级。",
  "每场详情页会展示赔率快照、概率分布、近期战绩和风险提示。",
  "总进球只作为进球模型参考，容易误导的双方进球推荐已经关闭。",
  "数据后台按计划自动同步，页面会显示最新更新时间和历史快照。",
  "想看更多赛事分析、数据合作或会员咨询，可以点右下角微信联系。"
];

const scenes = [
  {
    name: "home",
    action: `window.scrollTo(0, 0);`
  },
  {
    name: "list",
    action: `document.querySelector('.league-stack')?.scrollIntoView({ block: 'start' });`
  },
  {
    name: "detail-top",
    action: `document.querySelector('.details-button')?.click();`
  },
  {
    name: "detail-analysis",
    action: `document.querySelector('.probability-panel')?.scrollIntoView({ block: 'start' });`
  },
  {
    name: "worldcup",
    action: `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.trim() === '世界杯')?.click();`
  },
  {
    name: "worldcup-groups",
    action: `document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' });`
  },
  {
    name: "betslip",
    action: `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.trim() === '投注单')?.click(); window.scrollTo(0, 0);`
  },
  {
    name: "contact",
    action: `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('微信联系'))?.click(); window.scrollTo(0, document.body.scrollHeight);`
  }
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result || {});
        return;
      }

      if (message.method && this.events.has(message.method)) {
        for (const handler of this.events.get(message.method)) handler(message.params || {});
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  waitFor(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Event timeout: ${method}`)), timeoutMs);
      const handler = (params) => {
        clearTimeout(timer);
        const handlers = this.events.get(method) || [];
        this.events.set(method, handlers.filter((item) => item !== handler));
        resolve(params);
      };
      const handlers = this.events.get(method) || [];
      handlers.push(handler);
      this.events.set(method, handlers);
    });
  }

  close() {
    this.ws.close();
  }
}

async function waitForChrome(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      return await requestJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome did not expose the debugging endpoint.");
}

async function captureScreenshots() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);

  const userDataDir = path.join(outDir, "chrome-profile");
  ensureDir(userDataDir);
  const port = 9411 + Math.floor(Math.random() * 200);
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    await waitForChrome(port);
    const target = await requestJson(`http://127.0.0.1:${port}/json/new`, {
      method: "PUT"
    });
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    const load = cdp.waitFor("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: siteUrl });
    await load;
    await sleep(2500);

    const files = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      await cdp.send("Runtime.evaluate", {
        expression: scene.action,
        awaitPromise: true
      });
      await sleep(index === 2 ? 1800 : 1100);
      await cdp.send("Runtime.evaluate", {
        expression: `
          document.querySelectorAll('.contact-panel, .contact-dock-panel').forEach((el) => {
            el.style.maxHeight = '520px';
          });
        `,
        awaitPromise: true
      });
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      const file = path.join(outDir, `${String(index + 1).padStart(2, "0")}-${scene.name}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      files.push(file);
    }

    cdp.close();
    return files;
  } finally {
    chrome.kill();
  }
}

function synthesizeVoice() {
  const ttsDir = path.join(outDir, "tts");
  ensureDir(ttsDir);
  const linesJson = path.join(ttsDir, "lines.json");
  const psPath = path.join(ttsDir, "speak.ps1");
  fs.writeFileSync(linesJson, JSON.stringify(lines, null, 2), "utf8");
  fs.writeFileSync(psPath, `
param([string]$LinesPath, [string]$OutDir)
Add-Type -AssemblyName System.Speech
$lines = Get-Content -Raw -Encoding UTF8 $LinesPath | ConvertFrom-Json
for ($i = 0; $i -lt $lines.Count; $i++) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice('Microsoft Huihui Desktop')
  $synth.Rate = 1
  $synth.Volume = 100
  $file = Join-Path $OutDir ("line_{0:D2}.wav" -f ($i + 1))
  $synth.SetOutputToWaveFile($file)
  $synth.Speak([string]$lines[$i])
  $synth.Dispose()
}
`, "utf8");

  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, linesJson, ttsDir]);
  const silence = path.join(ttsDir, "silence.wav");
  run("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "0.18", silence]);

  const concatFile = path.join(ttsDir, "voice-concat.txt");
  const concatLines = [];
  const timings = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const wav = path.join(ttsDir, `line_${String(index + 1).padStart(2, "0")}.wav`);
    const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", wav]));
    timings.push({ text: lines[index], start: cursor, end: cursor + duration + 0.12 });
    cursor += duration + 0.18;
    concatLines.push(`file '${wav.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    if (index < lines.length - 1) concatLines.push(`file '${silence.replace(/\\/g, "/")}'`);
  }
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf8");

  const voice = path.join(outDir, "voiceover.wav");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", voice]);
  const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", voice]));
  return { voice, timings, duration };
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, "\\N");
}

function wrapAssText(text, maxUnits = 18) {
  const units = (value) => Array.from(value).reduce((total, char) => {
    return total + (char.charCodeAt(0) > 255 ? 2 : 1);
  }, 0);

  const chunks = [];
  let line = "";
  for (const char of String(text)) {
    const next = `${line}${char}`;
    if (line && units(next) > maxUnits * 2) {
      chunks.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) chunks.push(line);

  return escapeAssText(chunks.join("\\N"));
}

function writeSubtitles(timings) {
  const ass = path.join(outDir, "subtitles.ass");
  const header = `[Script Info]
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00222222,&HAA000000,1,0,0,0,100,100,0,0,1,5,1,2,92,92,125,1
Style: Title,Microsoft YaHei,64,&H0000E59B,&H000000FF,&H00222222,&H66000000,1,0,0,0,100,100,0,0,1,5,1,8,70,70,95,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const events = [
    `Dialogue: 1,${assTime(0)},${assTime(Math.min(4.2, timings[1]?.start || 4.2))},Title,,0,0,0,,AI 足球预测｜竞彩数据看板`
  ];
  for (const item of timings) {
    events.push(`Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Default,,0,0,0,,${wrapAssText(item.text)}`);
  }
  fs.writeFileSync(ass, `${header}${events.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "script.txt"), lines.map((line, index) => `${index + 1}. ${line}`).join("\n"), "utf8");
  return ass;
}

function filterPath(file) {
  return file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");
}

function createVideo(imageFiles, voice, subtitles, duration) {
  const sceneDuration = Math.max(3.8, (duration + 0.6) / imageFiles.length);
  const inputs = [];
  const filterParts = [];

  imageFiles.forEach((file, index) => {
    inputs.push("-loop", "1", "-t", String(sceneDuration), "-i", file);
    const frames = Math.ceil(sceneDuration * fps);
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `zoompan=z='min(zoom+0.00045,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},` +
      `trim=duration=${sceneDuration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = imageFiles.map((_, index) => `[v${index}]`).join("");
  const silentVideo = path.join(outDir, "website-intro-silent.mp4");
  const finalVideo = path.join(outDir, "ai-football-douyin-intro.mp4");
  run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    `${filterParts.join(";")};${concatInputs}concat=n=${imageFiles.length}:v=1:a=0[v]`,
    "-map", "[v]",
    "-r", String(fps),
    "-pix_fmt", "yuv420p",
    silentVideo
  ]);

  run("ffmpeg", [
    "-y",
    "-i", silentVideo,
    "-i", voice,
    "-vf", `ass='${filterPath(subtitles)}'`,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-shortest",
    "-movflags", "+faststart",
    finalVideo
  ]);

  return finalVideo;
}

async function main() {
  ensureDir(outDir);
  console.log("Capturing website scenes...");
  const imageFiles = await captureScreenshots();
  console.log("Synthesizing voiceover...");
  const { voice, timings, duration } = synthesizeVoice();
  const subtitles = writeSubtitles(timings);
  console.log("Compositing video...");
  const finalVideo = createVideo(imageFiles, voice, subtitles, duration);
  const meta = {
    finalVideo,
    voice,
    subtitles,
    screenshots: imageFiles,
    duration,
    siteUrl,
    size: `${width}x${height}`
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
