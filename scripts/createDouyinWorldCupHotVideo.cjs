const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-intro");
const workDir = path.join(outDir, "worldcup-hot");
const siteUrl = process.env.INTRO_SITE_URL || "http://127.0.0.1:5173/";
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const width = 1080;
const height = 1920;
const fps = 30;

const scenes = [
  {
    key: "hero",
    source: "hero",
    badge: "2026 世界杯",
    title: "别只猜冠军，先看路径",
    subtitle: "小组赛、32 强路线、冠军候选，先把逻辑摆出来。",
    line: "世界杯真要来了，别再只问冠军是谁，先看小组和路径。",
    cards: ["12 组预测", "32 强路径", "冠军候选"]
  },
  {
    key: "groups",
    source: "groups",
    badge: "小组赛预测",
    title: "谁头名？谁出线？谁当最好第三",
    subtitle: "每组不是简单排实力，还要看分组强度、东道主加成和路线。",
    line: "这页先把十二个小组摆出来：谁头名、谁出线、谁可能当最好第三，一眼就能追。",
    cards: ["头名概率", "晋级概率", "最好第三"]
  },
  {
    key: "knockout",
    source: "knockout",
    badge: "淘汰赛路线",
    title: "冠军概率，很多时候输在签位",
    subtitle: "同样是强队，提前撞强敌和一路避开热门，完全不是一回事。",
    line: "重点是淘汰赛路线，同样的强队，签位不同，冠军概率完全不是一个故事。",
    cards: ["32 强", "半决赛", "冠军概率"]
  },
  {
    key: "radar",
    source: "radar",
    badge: "爆冷雷达",
    title: "热门过热，也要提前标出来",
    subtitle: "不是一味推强队，冷门、偷分、盘口过热，都要提前盯。",
    line: "我还单独做了冠军候选和冷门雷达，热门过热、弱队偷分，都要提前标出来。",
    cards: ["冠军候选", "冷门风险", "市场热度"]
  },
  {
    key: "sp",
    source: "watch",
    badge: "赛前更新",
    title: "SP 一上线，模型自动滚动",
    subtitle: "赛前锁定预测，完场直接复盘，不赛后改答案。",
    line: "后面中国竞彩网世界杯 SP 一上线，单场赔率会自动进模型，赛前锁定，完场复盘。想先拆哪组，评论区打出来。",
    cards: ["官方 SP", "赛前锁定", "完场复盘"]
  }
];

const capturePlan = {
  hero: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); window.scrollTo(0, 0);",
    delay: 1700
  },
  groups: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  knockout: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-knockout-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  radar: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-scout-grid')?.scrollIntoView({ block: 'start' }), 450);",
    delay: 1900
  },
  watch: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-match-grid, .worldcup-stage-grid')?.scrollIntoView({ block: 'start' }), 450);",
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
  const port = 9930 + Math.floor(Math.random() * 300);
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
      background:
        radial-gradient(circle at 50% 12%, rgba(255, 207, 64, .22), transparent 34%),
        linear-gradient(180deg, #121815 0%, #050706 45%, #020303 100%);
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    .wrap { position: absolute; inset: 48px 54px 44px; }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 34px; font-weight: 900; }
    .logo {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: #19d690;
      color: #06100c;
      font-weight: 900;
    }
    .tagline { color: rgba(255,255,255,.68); font-size: 24px; font-weight: 700; }
    .shot {
      height: 690px;
      border-radius: 24px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.16);
      background: #090b0a;
      box-shadow: 0 30px 90px rgba(0,0,0,.48);
    }
    .shot img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #080a09;
    }
    .badge {
      margin-top: 34px;
      display: inline-flex;
      align-items: center;
      min-height: 52px;
      padding: 10px 20px;
      border-radius: 999px;
      color: #151008;
      background: linear-gradient(90deg, #ffd75a, #ffb627);
      font-size: 26px;
      font-weight: 900;
    }
    h1 {
      margin: 26px 0 0;
      font-size: 62px;
      line-height: 1.14;
      font-weight: 900;
      max-width: 960px;
      text-wrap: balance;
    }
    .subtitle {
      margin: 18px 0 0;
      font-size: 31px;
      line-height: 1.42;
      color: rgba(255,255,255,.74);
      max-width: 940px;
    }
    .chips {
      margin-top: 28px;
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
    }
    .chips span {
      border: 1px solid rgba(31, 221, 150, .45);
      background: rgba(31, 221, 150, .12);
      color: #38e8a5;
      min-height: 54px;
      padding: 12px 18px;
      border-radius: 999px;
      font-size: 25px;
      font-weight: 900;
    }
    .subtitle-box {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 72px;
      padding: 26px 28px;
      border-radius: 22px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.07);
      box-shadow: 0 18px 50px rgba(0,0,0,.28);
    }
    .subtitle-box span {
      display: block;
      color: #ffd65b;
      font-size: 23px;
      font-weight: 900;
      margin-bottom: 10px;
    }
    .subtitle-box strong {
      display: block;
      font-size: 34px;
      line-height: 1.38;
      color: #fff;
      font-weight: 900;
    }
    .footer {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding-top: 15px;
      border-top: 1px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.42);
      font-size: 21px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand"><div class="logo">AI</div><span>世界杯预测</span></div>
      <div class="tagline">小组赛 · 淘汰赛 · 冠军路径</div>
    </div>
    <section class="shot"><img src="${imageUrl}" alt=""></section>
    <div class="badge">${htmlEscape(scene.badge)}</div>
    <h1>${htmlEscape(scene.title)}</h1>
    <p class="subtitle">${htmlEscape(scene.subtitle)}</p>
    <div class="chips">${scene.cards.map((item) => `<span>${htmlEscape(item)}</span>`).join("")}</div>
    <div class="subtitle-box">
      <span>口播字幕</span>
      <strong>${htmlEscape(scene.line)}</strong>
    </div>
    <div class="footer">
      <span>仅作数据分析参考，不代表结果保证</span>
      <span>评论区发组别 / 队名</span>
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
        communicate = edge_tts.Communicate(line, "zh-CN-YunxiNeural", rate="+12%", pitch="+4Hz")
        await communicate.save(str(out))

asyncio.run(main())
`, "utf8");
  run("py", ["-3", pyScript, linesJson, ttsDir]);

  const silence = path.join(ttsDir, "silence.mp3");
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", "0.22",
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

  const voice = path.join(workDir, "worldcup-hot-voice.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-q:a", "3", voice]);
  return { voice, segments };
}

function createVideo(frames, voice, segments) {
  const inputs = [];
  const filterParts = [];

  frames.forEach((frame, index) => {
    const duration = Math.max(4.9, segments[index] || 5.2);
    inputs.push("-loop", "1", "-t", duration.toFixed(3), "-i", frame);
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = frames.map((_, index) => `[v${index}]`).join("");
  const silent = path.join(workDir, "worldcup-hot-silent.mp4");
  const finalVideo = path.join(outDir, "ai-football-douyin-worldcup-hot.mp4");

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
  console.log("Rendering World Cup hot frames...");
  const frames = await renderFrames(shots);
  console.log("Synthesizing younger voiceover...");
  const { voice, segments } = synthesizeVoice();
  console.log("Compositing World Cup video...");
  const finalVideo = createVideo(frames, voice, segments);
  const meta = {
    finalVideo,
    voice,
    frames,
    shots,
    scenes,
    segments,
    size: `${width}x${height}`,
    style: "worldcup-hot-stable"
  };
  fs.writeFileSync(path.join(workDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(workDir, "script.txt"), scenes.map((scene, index) => `${index + 1}. ${scene.line}`).join("\n"), "utf8");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
