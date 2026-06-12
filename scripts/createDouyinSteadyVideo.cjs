const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-intro");
const steadyDir = path.join(outDir, "steady");
const siteUrl = process.env.INTRO_SITE_URL || "http://127.0.0.1:5173/";
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const width = 1080;
const height = 1920;
const fps = 30;

const voiceLines = [
  "世界杯临近，我不做玄学猜冠军，先看数据。",
  "这里是今天的赛程截图，官方 SP、让球、总进球和模型可信度放在一起。",
  "第一场横滨水手，主胜方向有，但平局支持不低，所以我标成观察，不写稳胆。",
  "第二场柏太阳神，主胜热度更高，可让球盘没完全跟上，继续等临场变化。",
  "碰到盘口很近的比赛，我宁愿提示防平，也不会硬推热门。",
  "这些预测开赛前锁定，完场后直接复盘。你想看哪场，评论区发队名。"
];

const capturePlan = {
  home: {
    action: "window.scrollTo(0, 0);",
    delay: 1400
  },
  list: {
    action: "document.querySelector('.league-stack')?.scrollIntoView({ block: 'start' });",
    delay: 1400
  },
  detail: {
    action: "document.querySelector('.details-button')?.click(); setTimeout(() => document.querySelector('.probability-panel')?.scrollIntoView({ block: 'start' }), 500);",
    delay: 2000
  },
  worldcup: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); window.scrollTo(0, 0);",
    delay: 1700
  },
  groups: {
    action: "Array.from(document.querySelectorAll('button')).find((button) => button.innerText.includes('世界杯'))?.click(); setTimeout(() => document.querySelector('.worldcup-group-grid')?.scrollIntoView({ block: 'start' }), 500);",
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

  const userDataDir = path.join(steadyDir, `chrome-profile-${Date.now()}`);
  ensureDir(userDataDir);
  const port = 9811 + Math.floor(Math.random() * 200);
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

function asArrayData(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.matches || [];
}

function zh(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.zh || value.en || "";
}

function formatTime(kickoffTime) {
  if (!kickoffTime) return "--:--";
  const match = String(kickoffTime).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "--:--";
}

function bestPrediction(match) {
  return match.predictions?.find((item) => item.marketType === "BEST")
    || match.predictions?.find((item) => item.marketType === "1X2")
    || match.predictions?.[0];
}

function oneXTwoPrediction(match) {
  return match.predictions?.find((item) => item.marketType === "1X2") || bestPrediction(match);
}

function goalsPrediction(match) {
  return match.predictions?.find((item) => item.marketType === "GOALS");
}

function loadRecommendationData() {
  const matches = asArrayData(path.join(root, "public", "data", "matches-current.json"))
    .filter((match) => match.status !== "FINISHED")
    .sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));

  const highlighted = matches.slice(0, 5);
  const cards = highlighted.slice(0, 3).map((match) => {
    const best = bestPrediction(match);
    const one = oneXTwoPrediction(match);
    const goals = goalsPrediction(match);
    return {
      time: formatTime(match.kickoffTime),
      teams: `${match.homeTeamName} vs ${match.awayTeamName}`,
      league: match.leagueShortName || match.leagueName,
      title: zh(best?.tipLabel) || zh(one?.tipLabel),
      trust: best?.trustScore || one?.trustScore || "--",
      odds: one?.odds ? `SP ${one.odds}` : "",
      goals: goals ? zh(goals.tipLabel) : "",
      risks: (best?.riskTags || one?.riskTags || []).map(zh).filter(Boolean).slice(0, 3)
    };
  });

  const first = highlighted[0];
  const second = highlighted[1] || first;
  const tight = highlighted.find((match) => (bestPrediction(match)?.tipCode || "").includes("X")) || highlighted[2] || first;

  return { matches, cards, first, second, tight };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildScenes(siteShots, recData) {
  const firstBest = bestPrediction(recData.first);
  const firstOne = oneXTwoPrediction(recData.first);
  const secondBest = bestPrediction(recData.second);
  const tightBest = bestPrediction(recData.tight);

  return [
    {
      key: "worldcup",
      image: siteShots.worldcup,
      kicker: "截图 01 / 世界杯专栏",
      title: "先看赛程和分组，不直接猜冠军",
      desc: "世界杯内容用来做赛程、分组、冠军路径和赛前模型入口。",
      cards: [
        { label: "赛事入口", value: "小组赛 / 淘汰赛 / 冠军路径" },
        { label: "数据口径", value: "官方 SP + 模型概率 + 历史快照" }
      ]
    },
    {
      key: "today",
      image: siteShots.list,
      kicker: "截图 02 / 今日赛程推荐",
      title: "今日先看这几场，不硬吹稳胆",
      desc: "每场先看官方 SP、让球温差和风险标签，再决定是主推还是观察。",
      matchCards: recData.cards
    },
    {
      key: "first",
      image: siteShots.detail,
      kicker: `截图 03 / ${recData.first?.homeTeamName || "单场"} 推荐拆解`,
      title: `${recData.first?.homeTeamName || ""}这场：${zh(firstBest?.tipLabel) || "观察为主"}`,
      desc: `1X2 方向：${zh(firstOne?.tipLabel)}，可信度 ${firstBest?.trustScore || firstOne?.trustScore || "--"}。平局或让球风险没过关时，宁愿标观察。`,
      cards: [
        { label: "官方 SP", value: firstOne?.analysisItems?.[0] ? zh(firstOne.analysisItems[0]).replace("官方 HAD SP：", "") : "以竞彩官方 SP 为准" },
        { label: "风险标签", value: (firstBest?.riskTags || []).map(zh).join(" / ") || "临场复核" }
      ]
    },
    {
      key: "second",
      image: siteShots.home,
      kicker: `截图 04 / ${recData.second?.homeTeamName || "第二场"} 继续跟盘`,
      title: `${recData.second?.homeTeamName || ""}：热度高，也要看让球确认`,
      desc: `${zh(secondBest?.tipLabel) || "观察为主"}，可信度 ${secondBest?.trustScore || "--"}。热门方向如果让球盘不跟，就不能写成稳胆。`,
      cards: [
        { label: "推荐态度", value: zh(secondBest?.tipLabel) || "观察为主" },
        { label: "判断重点", value: "赛前 SP 是否继续降赔，且让球是否同向确认" }
      ]
    },
    {
      key: "review",
      image: siteShots.groups,
      kicker: "截图 05 / 预测留档复盘",
      title: "开赛前锁定预测，完场后直接复盘",
      desc: "不赛后改答案，完场比分和赛前快照对照，长期看命中率和概率校准。",
      cards: [
        { label: "复盘口径", value: "胜平负 / 让球 / 总进球 / 风险标签" },
        { label: "互动问题", value: `你想看哪场？评论区发队名。${zh(tightBest?.tipLabel) ? `比如：${zh(tightBest.tipLabel)}` : ""}` }
      ]
    }
  ];
}

async function captureSiteShots() {
  const shotDir = path.join(steadyDir, "site-shots");
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

function cardHtml(card) {
  return `
    <div class="info-card">
      <span>${htmlEscape(card.label)}</span>
      <strong>${htmlEscape(card.value)}</strong>
    </div>
  `;
}

function matchCardHtml(card) {
  const risks = card.risks.length ? card.risks.join(" / ") : "临场复核";
  return `
    <div class="match-card">
      <div class="match-time">${htmlEscape(card.time)} · ${htmlEscape(card.league)}</div>
      <strong>${htmlEscape(card.teams)}</strong>
      <p>${htmlEscape(card.title)} · 可信度 ${htmlEscape(card.trust)}</p>
      <small>${htmlEscape(card.odds)} ${card.goals ? `｜${htmlEscape(card.goals)}` : ""}</small>
      <em>${htmlEscape(risks)}</em>
    </div>
  `;
}

function sceneHtml(scene) {
  const imageUrl = pathToFileURL(scene.image).href;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; }
    body {
      background:
        linear-gradient(180deg, rgba(24, 32, 26, .94), rgba(4, 6, 6, 1) 42%),
        radial-gradient(circle at 50% 20%, rgba(37, 214, 148, .18), transparent 42%);
      color: #f8f6ef;
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    .wrap {
      position: absolute;
      inset: 54px 58px 56px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 26px;
      color: rgba(248, 246, 239, .68);
      margin-bottom: 24px;
    }
    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 34px;
      color: #fff;
      font-weight: 900;
    }
    .logo {
      width: 54px;
      height: 54px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: #05120e;
      background: #23d293;
      font-size: 28px;
      font-weight: 900;
    }
    .shot {
      height: 700px;
      border-radius: 22px;
      border: 1px solid rgba(255,255,255,.14);
      background: #090c0b;
      overflow: hidden;
      box-shadow: 0 30px 90px rgba(0,0,0,.45);
    }
    .shot img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #0b0d0c;
    }
    .kicker {
      margin-top: 34px;
      display: inline-flex;
      align-items: center;
      min-height: 54px;
      padding: 10px 20px;
      border-radius: 999px;
      background: rgba(255, 200, 55, .12);
      border: 1px solid rgba(255, 200, 55, .35);
      color: #ffd65b;
      font-size: 26px;
      font-weight: 800;
    }
    h1 {
      margin: 28px 0 0;
      font-size: 58px;
      line-height: 1.16;
      font-weight: 900;
      color: #fff;
    }
    .desc {
      margin: 22px 0 0;
      font-size: 32px;
      line-height: 1.48;
      color: rgba(248, 246, 239, .78);
    }
    .cards {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 72px;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 18px;
    }
    .cards.is-matches {
      grid-template-columns: 1fr;
      bottom: 40px;
      gap: 14px;
    }
    .info-card,
    .match-card {
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,.13);
      background: rgba(255,255,255,.06);
      padding: 22px;
      min-height: 142px;
    }
    .info-card span,
    .match-time {
      display: block;
      color: #25d694;
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 10px;
    }
    .info-card strong,
    .match-card strong {
      display: block;
      color: #fff;
      font-size: 28px;
      line-height: 1.35;
      font-weight: 900;
    }
    .match-card {
      min-height: 154px;
      display: grid;
      grid-template-columns: 1fr auto;
      column-gap: 18px;
    }
    .match-card strong,
    .match-card p,
    .match-card small,
    .match-time {
      grid-column: 1;
    }
    .match-card p {
      margin: 8px 0 0;
      color: #fff;
      font-size: 28px;
      font-weight: 800;
    }
    .match-card small {
      margin-top: 8px;
      color: rgba(248,246,239,.72);
      font-size: 22px;
    }
    .match-card em {
      grid-column: 2;
      grid-row: 1 / span 4;
      align-self: center;
      max-width: 250px;
      color: #ffd65b;
      font-size: 24px;
      line-height: 1.32;
      font-style: normal;
      text-align: right;
      font-weight: 800;
    }
    .footer {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      color: rgba(248, 246, 239, .42);
      font-size: 22px;
      display: flex;
      justify-content: space-between;
      border-top: 1px solid rgba(255,255,255,.1);
      padding-top: 16px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand"><div class="logo">AI</div><span>足球预测</span></div>
      <div>赛前截图讲解版</div>
    </div>
    <section class="shot"><img src="${imageUrl}" alt=""></section>
    <div class="kicker">${htmlEscape(scene.kicker)}</div>
    <h1>${htmlEscape(scene.title)}</h1>
    <p class="desc">${htmlEscape(scene.desc)}</p>
    <section class="cards ${scene.matchCards ? "is-matches" : ""}">
      ${(scene.matchCards ? scene.matchCards.map(matchCardHtml) : scene.cards.map(cardHtml)).join("")}
    </section>
    <div class="footer">
      <span>仅作数据分析参考，不代表结果保证</span>
      <span>理性看球</span>
    </div>
  </main>
</body>
</html>`;
}

async function renderFrames(scenes) {
  const htmlDir = path.join(steadyDir, "html");
  const frameDir = path.join(steadyDir, "frames");
  ensureDir(htmlDir);
  ensureDir(frameDir);

  for (const scene of scenes) {
    fs.writeFileSync(path.join(htmlDir, `${scene.key}.html`), sceneHtml(scene), "utf8");
  }

  const frames = [];
  await withChrome({ width, height }, async (cdp) => {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const load = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: pathToFileURL(path.join(htmlDir, `${scene.key}.html`)).href });
      await load;
      await sleep(500);
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
  const ttsDir = path.join(steadyDir, "tts");
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
        communicate = edge_tts.Communicate(line, "zh-CN-YunyangNeural", rate="-5%", pitch="-2Hz")
        await communicate.save(str(out))

asyncio.run(main())
`, "utf8");
  run("py", ["-3", pyScript, linesJson, ttsDir]);

  const silence = path.join(ttsDir, "silence.mp3");
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", "0.28",
    "-q:a", "9",
    "-acodec", "libmp3lame",
    silence
  ]);

  const concatFile = path.join(ttsDir, "voice-concat.txt");
  const concatLines = [];
  const segments = [];
  for (let index = 0; index < voiceLines.length; index += 1) {
    const mp3 = path.join(ttsDir, `line_${String(index + 1).padStart(2, "0")}.mp3`);
    const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp3]));
    segments.push(duration + 0.75);
    concatLines.push(`file '${mp3.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    if (index < voiceLines.length - 1) concatLines.push(`file '${silence.replace(/\\/g, "/")}'`);
  }
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf8");

  const voice = path.join(steadyDir, "steady-voice.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-q:a", "3", voice]);
  return { voice, segments };
}

function createVideo(frames, voice, segments) {
  const inputs = [];
  const filterParts = [];

  frames.forEach((frame, index) => {
    const trailingVoice = index === frames.length - 1 && segments.length > frames.length
      ? segments.slice(frames.length).reduce((sum, item) => sum + item, 0)
      : 0;
    const duration = Math.max(5.2, (segments[index] || 5.8) + trailingVoice);
    inputs.push("-loop", "1", "-t", duration.toFixed(3), "-i", frame);
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = frames.map((_, index) => `[v${index}]`).join("");
  const silent = path.join(steadyDir, "steady-silent.mp4");
  const finalVideo = path.join(outDir, "ai-football-douyin-steady.mp4");
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
  ensureDir(steadyDir);
  const recData = loadRecommendationData();
  console.log("Capturing site screenshots...");
  const siteShots = await captureSiteShots();
  console.log("Rendering stable frames...");
  const scenes = buildScenes(siteShots, recData);
  const frames = await renderFrames(scenes);
  console.log("Synthesizing optimized voiceover...");
  const { voice, segments } = synthesizeVoice();
  console.log("Compositing steady video...");
  const finalVideo = createVideo(frames, voice, segments);
  const meta = {
    finalVideo,
    voice,
    frames,
    siteShots,
    lines: voiceLines,
    segments,
    size: `${width}x${height}`,
    style: "steady-screenshot-recommendation"
  };
  fs.writeFileSync(path.join(steadyDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(steadyDir, "steady-script.txt"), voiceLines.map((line, index) => `${index + 1}. ${line}`).join("\n"), "utf8");
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
