const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-intro");
const topicDir = path.join(outDir, "topic");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const siteUrl = process.env.INTRO_SITE_URL || "http://127.0.0.1:5173/";
const width = 1080;
const height = 1920;
const fps = 30;

const voiceLines = [
  "最近全网都在吵，哪个 AI 预测世界杯更准。",
  "我直接做了一个看板，拿中国竞彩网的数据跑一遍。",
  "先看官方 SP 和赔率变化，不靠感觉乱猜。",
  "每场开赛前锁定预测，完场以后再拿比分复盘。",
  "小组赛、淘汰赛、冠军路径，都放到同一个看板里。",
  "你觉得今年冠军是谁？评论区给我一个名字。"
];

const scenePlan = [
  {
    key: "hook",
    source: "worldcup",
    headline: "网上都在吵：AI 预测谁更准？",
    badge: "2026 世界杯 · AI预测对决",
    caption: "5个AI预测世界杯，冠军会是谁？",
    variant: "hero"
  },
  {
    key: "dashboard",
    source: "home",
    headline: "做个看板，拿数据说话",
    badge: "不是口嗨，先把数据摊开",
    caption: "竞彩 SP、赛程、历史库、模型概率都在看板里。"
  },
  {
    key: "odds",
    source: "list",
    headline: "先看官方 SP，不靠感觉乱猜",
    badge: "中国竞彩网官方数据",
    caption: "胜平负、让球、总进球，先看赛前市场怎么走。"
  },
  {
    key: "review",
    source: "detail",
    headline: "开赛前锁定，完场后复盘",
    badge: "赛前快照留档",
    caption: "预测不赛后改答案，完场比分直接对照。"
  },
  {
    key: "worldcup",
    source: "groups",
    headline: "小组赛到冠军路径，都放进去",
    badge: "世界杯专栏",
    caption: "从小组出线到冠军概率，做成一张图看。"
  },
  {
    key: "comment",
    source: "worldcup",
    headline: "你觉得冠军是谁？评论区见",
    badge: "你来押一个方向",
    caption: "别盲目跟单，理性看球，评论区聊聊。"
  }
];

const sourceShots = {
  home: {
    action: "window.scrollTo(0, 0);",
    delay: 1400
  },
  worldcup: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); window.scrollTo(0, 0);",
    delay: 1600
  },
  list: {
    action: "document.querySelector('.league-stack')?.scrollIntoView({ block: 'start' });",
    delay: 1200
  },
  detail: {
    action: "document.querySelector('.details-button')?.click(); setTimeout(() => document.querySelector('.probability-panel')?.scrollIntoView({ block: 'start' }), 400);",
    delay: 1800
  },
  groups: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' }), 400);",
    delay: 1800
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

async function withChrome(metrics, callback) {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);

  const userDataDir = path.join(topicDir, `chrome-profile-${Date.now()}`);
  ensureDir(userDataDir);
  const port = 9611 + Math.floor(Math.random() * 200);
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

async function captureSiteShots() {
  const siteShotDir = path.join(topicDir, "site-shots");
  ensureDir(siteShotDir);
  const files = {};

  await withChrome({ width: 1280, height: 720 }, async (cdp) => {
    const load = cdp.waitFor("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: siteUrl });
    await load;
    await sleep(2200);

    for (const [key, config] of Object.entries(sourceShots)) {
      await cdp.send("Runtime.evaluate", {
        expression: config.action,
        awaitPromise: true
      });
      await sleep(config.delay);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      const file = path.join(siteShotDir, `${key}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      files[key] = file;
    }
  });

  return files;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function douyinSceneHtml(scene, imagePath) {
  const imageUrl = pathToFileURL(imagePath).href;
  const isHero = scene.variant === "hero";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; }
    body {
      background: radial-gradient(circle at 50% 34%, #11142a 0%, #050507 42%, #000 100%);
      color: #fff;
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    .status {
      position: absolute;
      top: 58px;
      left: 76px;
      right: 78px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 42px;
      font-weight: 700;
    }
    .signal { display: flex; gap: 10px; align-items: center; font-size: 34px; }
    .battery {
      border: 4px solid #fff;
      border-radius: 11px;
      width: 78px;
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      line-height: 1;
    }
    .nav {
      position: absolute;
      top: 164px;
      left: 42px;
      right: 48px;
      display: grid;
      grid-template-columns: 62px repeat(7, 1fr) 58px;
      align-items: center;
      column-gap: 14px;
      color: rgba(255,255,255,.72);
      font-size: 35px;
      font-weight: 600;
      white-space: nowrap;
    }
    .nav .active { color: #fff; position: relative; }
    .nav .active::after {
      content: "";
      position: absolute;
      left: 20%;
      right: 20%;
      bottom: -20px;
      height: 4px;
      border-radius: 999px;
      background: #fff;
    }
    .hamburger, .search { font-size: 54px; font-weight: 300; color: #fff; }
    .media {
      position: absolute;
      top: 458px;
      left: 70px;
      width: 830px;
      height: 555px;
      border-radius: 28px;
      overflow: hidden;
      background: #10111a;
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 26px 90px rgba(0,0,0,.6), 0 0 0 8px rgba(255,255,255,.035);
    }
    .media img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: ${isHero ? "center top" : "center top"};
      filter: saturate(1.08) contrast(1.05) brightness(.9);
      transform: scale(${isHero ? 1.04 : 1.02});
    }
    .media::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(0,0,0,.15), transparent 42%, rgba(0,0,0,.48));
      pointer-events: none;
    }
    .play {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 138px;
      height: 138px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: rgba(255,255,255,.2);
      backdrop-filter: blur(6px);
    }
    .play::before {
      content: "";
      position: absolute;
      left: 55px;
      top: 37px;
      border-top: 32px solid transparent;
      border-bottom: 32px solid transparent;
      border-left: 48px solid rgba(255,255,255,.75);
    }
    .heroBoard {
      position: absolute;
      left: 104px;
      right: 104px;
      top: 506px;
      height: 462px;
      border-radius: 26px;
      background: linear-gradient(145deg, rgba(16,22,62,.96), rgba(10,15,38,.94));
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 18px 70px rgba(0,0,0,.48);
      padding: 42px 46px;
    }
    .heroBoard h1 {
      margin: 0;
      text-align: center;
      font-size: 49px;
      line-height: 1.12;
      color: #fff5c6;
    }
    .heroBoard .sub {
      text-align: center;
      margin-top: 14px;
      font-size: 20px;
      color: rgba(255,255,255,.48);
    }
    .timer {
      margin: 35px auto 36px;
      display: grid;
      width: 420px;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }
    .timer div {
      height: 72px;
      border-radius: 14px;
      background: rgba(255,255,255,.06);
      text-align: center;
      color: #ffd437;
      font-size: 34px;
      font-weight: 900;
      padding-top: 9px;
    }
    .timer span {
      display: block;
      color: rgba(255,255,255,.45);
      font-size: 16px;
      margin-top: 2px;
      font-weight: 500;
    }
    .aiRow {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
    }
    .aiCard {
      min-height: 98px;
      border-radius: 15px;
      background: rgba(255,255,255,.07);
      padding: 14px 12px;
      font-size: 19px;
      color: rgba(255,255,255,.78);
    }
    .aiCard strong {
      display: block;
      margin-top: 6px;
      color: #ffe66b;
      font-size: 25px;
      white-space: nowrap;
    }
    .badge {
      position: absolute;
      left: 72px;
      top: 1062px;
      max-width: 760px;
      padding: 12px 22px;
      border-radius: 999px;
      background: rgba(255,214,61,.12);
      border: 1px solid rgba(255,214,61,.38);
      color: #ffd73a;
      font-size: 28px;
      font-weight: 800;
    }
    .headline {
      position: absolute;
      left: 72px;
      right: 155px;
      bottom: 372px;
      color: #fff;
      font-size: 58px;
      line-height: 1.18;
      font-weight: 900;
      text-shadow: 0 5px 18px rgba(0,0,0,.8), 0 0 2px rgba(0,0,0,.9);
    }
    .author {
      position: absolute;
      left: 58px;
      bottom: 206px;
      font-size: 34px;
      font-weight: 700;
      color: #fff;
    }
    .chapter {
      display: inline-block;
      margin-left: 14px;
      padding: 8px 18px;
      border-radius: 10px;
      background: rgba(255,255,255,.16);
      color: rgba(255,255,255,.82);
      font-size: 25px;
      font-weight: 500;
    }
    .caption {
      position: absolute;
      left: 58px;
      right: 110px;
      bottom: 115px;
      font-size: 30px;
      line-height: 1.32;
      color: rgba(255,255,255,.9);
    }
    .rightRail {
      position: absolute;
      right: 24px;
      bottom: 232px;
      width: 92px;
      display: grid;
      gap: 30px;
      justify-items: center;
      text-align: center;
      font-size: 24px;
      color: #fff;
      font-weight: 700;
    }
    .avatar {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ffe9b0, #1fe0ad);
      border: 4px solid #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #111;
      font-size: 30px;
      font-weight: 900;
    }
    .plus {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #ff2f64;
      margin-top: -44px;
      font-size: 34px;
      line-height: 45px;
    }
    .railIcon {
      font-size: 62px;
      line-height: 1;
      text-shadow: 0 4px 16px rgba(0,0,0,.65);
    }
    .progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 84px;
      height: 5px;
      background: rgba(255,255,255,.22);
    }
    .progress::before {
      content: "";
      display: block;
      height: 100%;
      width: ${scenePlan.findIndex((item) => item.key === scene.key) / (scenePlan.length - 1) * 100}%;
      background: rgba(255,255,255,.78);
    }
    .bottomNav {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 84px;
      background: #171717;
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      align-items: center;
      text-align: center;
      color: rgba(255,255,255,.72);
      font-size: 31px;
      font-weight: 700;
    }
    .bottomNav .post {
      width: 75px;
      height: 55px;
      line-height: 48px;
      margin: 0 auto;
      border: 4px solid #fff;
      border-radius: 18px;
      color: #fff;
      font-size: 40px;
    }
  </style>
</head>
<body>
  <div class="status"><div>14:46</div><div class="signal">▮▮▮  WiFi <div class="battery">69</div></div></div>
  <div class="nav"><div class="hamburger">≡</div><div>热点</div><div>经验</div><div>长治</div><div>团购</div><div>关注</div><div>朋友</div><div class="active">推荐</div><div class="search">⌕</div></div>

  <div class="media"><img src="${imageUrl}" alt=""></div>
  ${isHero ? `<div class="heroBoard">
    <h1>2026世界杯 · AI预测对决</h1>
    <div class="sub">Claude / GPT / Gemini / DeepSeek / 豆包，谁更像预言家？</div>
    <div class="timer"><div>6<span>天</span></div><div>08<span>时</span></div><div>42<span>分</span></div><div>06<span>秒</span></div></div>
    <div class="aiRow">
      <div class="aiCard">Claude<strong>法国</strong></div>
      <div class="aiCard">GPT<strong>巴西</strong></div>
      <div class="aiCard">Gemini<strong>英格兰</strong></div>
      <div class="aiCard">DeepSeek<strong>西班牙</strong></div>
      <div class="aiCard">豆包<strong>法国</strong></div>
    </div>
  </div>` : `<div class="play"></div>`}

  <div class="badge">${htmlEscape(scene.badge)}</div>
  <div class="headline">${htmlEscape(scene.headline)}</div>
  <div class="rightRail">
    <div><div class="avatar">AI</div><div class="plus">+</div></div>
    <div><div class="railIcon">♡</div><div>548</div></div>
    <div><div class="railIcon">●●●</div><div>118</div></div>
    <div><div class="railIcon">★</div><div>187</div></div>
    <div><div class="railIcon">↗</div><div>104</div></div>
  </div>
  <div class="author">@AI足球预测 <span class="chapter">章节要点</span></div>
  <div class="caption">${htmlEscape(scene.caption)}</div>
  <div class="progress"></div>
  <div class="bottomNav"><div>首页</div><div>商城</div><div class="post">+</div><div>消息</div><div>我</div></div>
</body>
</html>`;
}

async function captureDesignedScenes(siteShots) {
  const frameDir = path.join(topicDir, "frames");
  ensureDir(frameDir);
  const htmlDir = path.join(topicDir, "html");
  ensureDir(htmlDir);
  const files = [];

  for (const scene of scenePlan) {
    const htmlFile = path.join(htmlDir, `${scene.key}.html`);
    fs.writeFileSync(htmlFile, douyinSceneHtml(scene, siteShots[scene.source]), "utf8");
  }

  await withChrome({ width, height }, async (cdp) => {
    for (let index = 0; index < scenePlan.length; index += 1) {
      const scene = scenePlan[index];
      const htmlFile = path.join(htmlDir, `${scene.key}.html`);
      const load = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: pathToFileURL(htmlFile).href });
      await load;
      await sleep(450);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      const file = path.join(frameDir, `${String(index + 1).padStart(2, "0")}-${scene.key}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      files.push(file);
    }
  });

  return files;
}

function writeVoiceScript() {
  const ttsDir = path.join(topicDir, "tts");
  ensureDir(ttsDir);
  const linesJson = path.join(ttsDir, "lines.json");
  const pyScript = path.join(ttsDir, "edge_tts_lines.py");
  fs.writeFileSync(linesJson, JSON.stringify(voiceLines, null, 2), "utf8");
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
        communicate = edge_tts.Communicate(line, "zh-CN-YunxiNeural", rate="+10%", pitch="+0Hz")
        await communicate.save(str(out))

asyncio.run(main())
`, "utf8");
  return { ttsDir, linesJson, pyScript };
}

function synthesizeVoice() {
  const { ttsDir, linesJson, pyScript } = writeVoiceScript();
  run("py", ["-3", pyScript, linesJson, ttsDir]);

  const silence = path.join(ttsDir, "silence.mp3");
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", "0.18",
    "-q:a", "9",
    "-acodec", "libmp3lame",
    silence
  ]);

  const concatFile = path.join(ttsDir, "voice-concat.txt");
  const concatLines = [];
  const segments = [];
  let total = 0;
  for (let index = 0; index < voiceLines.length; index += 1) {
    const mp3 = path.join(ttsDir, `line_${String(index + 1).padStart(2, "0")}.mp3`);
    const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp3]));
    const sceneDuration = duration + 0.32;
    segments.push(sceneDuration);
    total += sceneDuration;
    concatLines.push(`file '${mp3.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    if (index < voiceLines.length - 1) concatLines.push(`file '${silence.replace(/\\/g, "/")}'`);
  }

  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf8");
  const voice = path.join(topicDir, "topic-voice.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-q:a", "3", voice]);
  return { voice, segments, duration: total };
}

function createVideo(frameFiles, voice, segments) {
  const inputs = [];
  const filterParts = [];
  frameFiles.forEach((file, index) => {
    const sceneDuration = Math.max(2.7, segments[index] || 3.2);
    inputs.push("-loop", "1", "-t", sceneDuration.toFixed(3), "-i", file);
    const frames = Math.ceil(sceneDuration * fps);
    const zoomSpeed = index % 2 === 0 ? "0.00055" : "0.00035";
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `zoompan=z='min(zoom+${zoomSpeed},1.032)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},` +
      `trim=duration=${sceneDuration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = frameFiles.map((_, index) => `[v${index}]`).join("");
  const silent = path.join(topicDir, "topic-silent.mp4");
  const finalVideo = path.join(outDir, "ai-football-douyin-topic.mp4");

  run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    `${filterParts.join(";")};${concatInputs}concat=n=${frameFiles.length}:v=1:a=0[v]`,
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
  ensureDir(topicDir);
  console.log("Capturing source website shots...");
  const siteShots = await captureSiteShots();
  console.log("Rendering Douyin-style frames...");
  const frameFiles = await captureDesignedScenes(siteShots);
  console.log("Synthesizing neural voiceover...");
  const { voice, segments, duration } = synthesizeVoice();
  console.log("Compositing topic video...");
  const finalVideo = createVideo(frameFiles, voice, segments);
  const meta = {
    finalVideo,
    voice,
    frameFiles,
    siteShots,
    duration,
    lines: voiceLines,
    size: `${width}x${height}`,
    style: "douyin-topic-worldcup"
  };
  fs.writeFileSync(path.join(topicDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(topicDir, "topic-script.txt"), voiceLines.map((line, index) => `${index + 1}. ${line}`).join("\n"), "utf8");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
