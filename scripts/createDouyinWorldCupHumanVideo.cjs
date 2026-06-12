const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-intro");
const workDir = path.join(outDir, "worldcup-human");
const siteUrl = process.env.INTRO_SITE_URL || "http://127.0.0.1:5173/";
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const width = 1080;
const height = 1920;
const fps = 30;

const scenes = [
  {
    key: "open",
    source: "groupsTop",
    badge: "Codex 做的网站",
    title: "我做了个世界杯预测网站",
    subtitle: "先把分组、赛程和路线放进去，后面按组慢慢拆。",
    line: "我用 Codex 做了一个世界杯预测网站，先把分组、赛程和出线路线放进去。",
    chips: ["网站入口", "分组预测", "路线图"]
  },
  {
    key: "groups",
    source: "groups",
    badge: "先看小组",
    title: "谁稳？谁悬？谁可能抢第三",
    subtitle: "强队也不是闭眼出线，有些组的第三名反而很关键。",
    line: "打开网站先看十二个小组，哪些队稳，哪些队悬，哪些第三名还有戏。",
    chips: ["A-L 组", "出线形势", "第三名"]
  },
  {
    key: "route",
    source: "knockout",
    badge: "再看路线",
    title: "世界杯很多时候，签位比热度更要命",
    subtitle: "不是谁名气大谁就一路平推，半路撞强队很伤。",
    line: "然后看淘汰赛路线，有些队不是不强，是半路可能提前撞硬仗。",
    chips: ["32 强", "半区", "硬仗"]
  },
  {
    key: "upset",
    source: "groupsTop",
    badge: "留意冷门",
    title: "热门不等于稳",
    subtitle: "杯赛最有意思的地方，就是总有人能偷一场。",
    line: "我还在网站里留了冷门观察点，热门队要看，但被忽略的比赛更容易出内容。",
    chips: ["冷门", "偷分", "翻车点"]
  },
  {
    key: "close",
    source: "groupsTop",
    badge: "评论区开拆",
    title: "你想先看哪一组？",
    subtitle: "我后面按组慢慢拆，先从呼声最高的组开始。",
    line: "后面我就按这个网站一组一组拆，你想先看哪组，评论区直接打 A 到 L。",
    chips: ["A 组", "死亡组", "冠军路"]
  }
];

const capturePlan = {
  groupsTop: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  groups: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  groupsBottom: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelectorAll('.worldcup-group-card')[6]?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  knockout: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-knockout-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  stage: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-stage-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  }
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
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

async function withChrome(metrics, callback) {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);

  const userDataDir = path.join(workDir, `chrome-profile-${Date.now()}`);
  ensureDir(userDataDir);
  const port = 10080 + Math.floor(Math.random() * 300);
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
    const target = await requestJson(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    try {
      return await callback(cdp);
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill();
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function captureSiteShots() {
  const shotDir = path.join(workDir, "site-shots");
  ensureDir(shotDir);
  const files = {};

  await withChrome({ width: 1440, height: 960 }, async (cdp) => {
    const load = cdp.waitFor("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: siteUrl });
    await load;
    await sleep(2300);

    for (const [key, plan] of Object.entries(capturePlan)) {
      await cdp.send("Runtime.evaluate", { expression: plan.action, awaitPromise: true });
      await sleep(plan.delay);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      const file = path.join(shotDir, `${key}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      files[key] = file;
    }
  });

  return files;
}

function sceneHtml(scene, shots) {
  const imageUrl = pathToFileURL(shots[scene.source]).href;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; }
    body {
      color: #fff;
      background: linear-gradient(180deg, #151613 0%, #070806 45%, #020302 100%);
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    .wrap { position: absolute; inset: 42px 50px 34px; }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .brand { font-size: 34px; font-weight: 900; }
    .tagline { color: rgba(255,255,255,.58); font-size: 23px; font-weight: 700; }
    .shot {
      height: 820px;
      border-radius: 22px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.14);
      background: #090a08;
      box-shadow: 0 28px 80px rgba(0,0,0,.44);
    }
    .shot img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center top;
      display: block;
      background: #070807;
    }
    .badge {
      margin-top: 24px;
      display: inline-flex;
      min-height: 50px;
      align-items: center;
      padding: 10px 20px;
      border-radius: 999px;
      color: #16110a;
      background: #ffd45a;
      font-size: 24px;
      font-weight: 900;
    }
    h1 {
      margin: 22px 0 0;
      font-size: 54px;
      line-height: 1.14;
      font-weight: 900;
      max-width: 950px;
      text-wrap: balance;
    }
    .subtitle {
      margin: 14px 0 0;
      font-size: 28px;
      line-height: 1.42;
      color: rgba(255,255,255,.74);
      max-width: 940px;
    }
    .chips {
      margin-top: 22px;
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
    }
    .chips span {
      min-height: 52px;
      padding: 12px 18px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.07);
      color: #f1f0e8;
      font-size: 23px;
      font-weight: 900;
    }
    .caption {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 44px;
      padding: 26px 28px;
      border-radius: 22px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(18, 18, 16, .92);
      box-shadow: 0 18px 48px rgba(0,0,0,.26);
    }
    .caption span {
      display: block;
      color: #ffd45a;
      font-size: 22px;
      font-weight: 900;
      margin-bottom: 10px;
    }
    .caption strong {
      display: block;
      color: #fff;
      font-size: 32px;
      line-height: 1.38;
      font-weight: 900;
    }
    .footer {
      position: absolute;
      left: 0;
      right: 0;
      bottom: -26px;
      padding-top: 15px;
      border-top: 1px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.42);
      font-size: 19px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand">世界杯看球笔记</div>
      <div class="tagline">不是答案，是思路</div>
    </div>
    <section class="shot"><img src="${imageUrl}" alt=""></section>
    <div class="badge">${htmlEscape(scene.badge)}</div>
    <h1>${htmlEscape(scene.title)}</h1>
    <p class="subtitle">${htmlEscape(scene.subtitle)}</p>
    <div class="chips">${scene.chips.map((item) => `<span>${htmlEscape(item)}</span>`).join("")}</div>
    <div class="caption">
      <span>口播</span>
      <strong>${htmlEscape(scene.line)}</strong>
    </div>
    <div class="footer">
      <span>看球讨论，不代表结果保证</span>
      <span>评论区打组别</span>
    </div>
  </main>
</body>
</html>`;
}

async function renderFrames(shots) {
  const htmlDir = path.join(workDir, "html");
  const frameDir = path.join(workDir, "frames");
  ensureDir(htmlDir);
  ensureDir(frameDir);

  const frames = [];
  for (const scene of scenes) {
    fs.writeFileSync(path.join(htmlDir, `${scene.key}.html`), sceneHtml(scene, shots), "utf8");
  }

  await withChrome({ width, height }, async (cdp) => {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const load = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: pathToFileURL(path.join(htmlDir, `${scene.key}.html`)).href });
      await load;
      await sleep(450);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      const file = path.join(frameDir, `${String(index + 1).padStart(2, "0")}-${scene.key}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      frames.push(file);
    }
  });

  return frames;
}

function synthesizeVoice() {
  const ttsDir = path.join(workDir, "tts");
  ensureDir(ttsDir);
  const linesJson = path.join(ttsDir, "lines.json");
  const pyScript = path.join(ttsDir, "edge_tts_lines.py");
  fs.writeFileSync(linesJson, JSON.stringify(scenes.map((scene) => scene.line), null, 2), "utf8");
  fs.writeFileSync(pyScript, `
import asyncio
import json
import pathlib
import sys
import edge_tts

lines_path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2])
lines = json.loads(lines_path.read_text(encoding="utf-8"))

async def main():
    for index, line in enumerate(lines, start=1):
        out = out_dir / f"line_{index:02d}.mp3"
        communicate = edge_tts.Communicate(line, "zh-CN-XiaoyiNeural", rate="+8%", pitch="+2Hz")
        await communicate.save(str(out))

asyncio.run(main())
`, "utf8");
  run("py", ["-3", pyScript, linesJson, ttsDir]);

  const silence = path.join(ttsDir, "silence.mp3");
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", "0.2",
    "-q:a", "9",
    "-acodec", "libmp3lame",
    silence
  ]);

  const concatFile = path.join(ttsDir, "voice-concat.txt");
  const concatLines = [];
  const segments = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const mp3 = path.join(ttsDir, `line_${String(index + 1).padStart(2, "0")}.mp3`);
    const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp3]));
    segments.push(duration + 0.55);
    concatLines.push(`file '${mp3.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    if (index < scenes.length - 1) concatLines.push(`file '${silence.replace(/\\/g, "/")}'`);
  }
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf8");

  const voice = path.join(workDir, "worldcup-human-voice.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-q:a", "3", voice]);
  return { voice, segments };
}

function createVideo(frames, voice, segments) {
  const inputs = [];
  const filterParts = [];

  frames.forEach((frame, index) => {
    const duration = Math.max(5.1, segments[index] || 5.2);
    inputs.push("-loop", "1", "-t", duration.toFixed(3), "-i", frame);
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = frames.map((_, index) => `[v${index}]`).join("");
  const silent = path.join(workDir, "worldcup-human-silent.mp4");
  const finalVideo = path.join(outDir, "worldcup-human-notes.mp4");

  run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    `${filterParts.join(";")};${concatInputs}concat=n=${frames.length}:v=1:a=0[v]`,
    "-map", "[v]",
    "-r", String(fps),
    "-pix_fmt", "yuv420p",
    silent
  ]);

  run("ffmpeg", [
    "-y",
    "-i", silent,
    "-i", voice,
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
  ensureDir(workDir);
  console.log("Capturing World Cup screenshots...");
  const shots = await captureSiteShots();
  console.log("Rendering human-style frames...");
  const frames = await renderFrames(shots);
  console.log("Synthesizing casual voiceover...");
  const { voice, segments } = synthesizeVoice();
  console.log("Compositing human-style video...");
  const finalVideo = createVideo(frames, voice, segments);
  const meta = {
    finalVideo,
    voice,
    frames,
    shots,
    scenes,
    segments,
    size: `${width}x${height}`,
    style: "worldcup-human-notes"
  };
  fs.writeFileSync(path.join(workDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(workDir, "script.txt"), scenes.map((scene, index) => `${index + 1}. ${scene.line}`).join("\n"), "utf8");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
