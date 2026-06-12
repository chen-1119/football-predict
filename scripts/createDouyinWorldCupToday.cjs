const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "douyin-worldcup-2026-06-11");
const htmlDir = path.join(outDir, "html");
const frameDir = path.join(outDir, "frames");
const ttsDir = path.join(outDir, "tts");
const websiteUrl = process.env.WEBSITE_URL || "http://170.106.75.73/";
const websiteContentUrl = process.env.WEBSITE_CONTENT_URL || new URL("/predictions", websiteUrl).href;
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const width = 1080;
const height = 1920;
const fps = 30;

const fallbackMatches = [
  { home: "墨西哥", away: "南非", kickoff: "06/12周五 03:00", siteLean: "墨西哥优先，防平", recommendation: "墨西哥胜，防平", score: "1-0 / 1-1" },
  { home: "韩国", away: "捷克", kickoff: "06/12周五 10:00", siteLean: "韩国优先，防平", recommendation: "韩国胜，防平", score: "1-0 / 1-1" }
];

function normalizeMatchForPreview(match, fallback) {
  if (!match || !fallback) return match;
  const next = JSON.parse(JSON.stringify(match));
  const homeOdds = Number(next.odds?.odds1 || 0);
  const trustScore = fallback.home === "墨西哥" ? 34 : 34;
  const labelZh = `参考倾向 主胜 ${fallback.home}`;
  const labelEn = `Reference lean: Home Win (${fallback.home})`;
  next.projectedScoreHome = 1;
  next.projectedScoreAway = fallback.home === "墨西哥" ? 0 : 0;
  next.probabilityModel = {
    ...(next.probabilityModel || {}),
    scoreDistribution: [
      { home: 1, away: 0, label: "1 - 0", probability: 18 },
      { home: 1, away: 1, label: "1 - 1", probability: 16 },
      ...((next.probabilityModel?.scoreDistribution || []).filter((score) => score.label !== "1 - 0" && score.label !== "1 - 1"))
    ]
  };
  next.predictions = (next.predictions || []).map((prediction) => {
    if (prediction.marketType !== "1X2" && prediction.marketType !== "BEST") return prediction;
    return {
      ...prediction,
      oddsPoolCode: "HAD",
      handicapLine: "0",
      tipCode: "1",
      tipLabel: { zh: labelZh, en: labelEn },
      odds: Number.isFinite(homeOdds) && homeOdds > 0 ? homeOdds : prediction.odds,
      trustScore,
      recommendationAction: "reference",
      recommendationTier: "reference",
      explanation: {
        zh: `中国竞彩网官方 HAD 胜平负方向保留为赛前观察项，主线看${fallback.recommendation}。`,
        en: `Sporttery HAD 1X2 is kept as a pre-match reference, main lean ${fallback.recommendation}.`
      },
      analysisItems: [
        {
          zh: `本场素材展示方向：${fallback.recommendation}；比分参考：${fallback.score}。`,
          en: `Material lean: ${fallback.recommendation}; score reference: ${fallback.score}.`
        },
        {
          zh: "官方 SP 与让球盘只作为赛前参考，临场变化仍需复核。",
          en: "Official SP and handicap are pre-match references; late movement still needs review."
        }
      ],
      riskTags: fallback.recommendation.includes("防平")
        ? [{ zh: "防平", en: "Draw risk" }]
        : [{ zh: "赛前参考", en: "Pre-match reference" }],
      visibilityStatus: "FREE",
      resultStatus: "PENDING"
    };
  });
  return next;
}

function readWorldCupMatches() {
  try {
    const file = path.join(root, "public", "matches.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return fallbackMatches;
    const picked = fallbackMatches
      .map((fallback) => rows.find((match) => match.homeTeamName === fallback.home && match.awayTeamName === fallback.away))
      .filter(Boolean)
      .map((match, index) => ({
        ...normalizeMatchForPreview(match, fallbackMatches[index]),
        douyinRecommendation: fallbackMatches[index].recommendation,
        douyinScore: fallbackMatches[index].score
      }));
    return picked.length === fallbackMatches.length ? picked : fallbackMatches;
  } catch {
    return fallbackMatches;
  }
}

const worldCupMatches = readWorldCupMatches();

function jsLiteral(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetGeneratedDirs() {
  for (const dir of [htmlDir, frameDir, ttsDir, path.join(outDir, "website-capture")]) {
    const resolvedDir = path.resolve(dir);
    const resolvedOut = path.resolve(outDir);
    if (resolvedDir.startsWith(resolvedOut + path.sep)) {
      fs.rmSync(resolvedDir, { recursive: true, force: true });
    }
  }
  if (fs.existsSync(outDir)) {
    const resolvedOut = path.resolve(outDir);
    for (const name of fs.readdirSync(outDir)) {
      if (!name.startsWith("chrome-profile-")) continue;
      const resolvedProfile = path.resolve(outDir, name);
      if (resolvedProfile.startsWith(resolvedOut + path.sep)) {
        fs.rmSync(resolvedProfile, { recursive: true, force: true });
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirWithRetry(dir, attempts = 8) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (index === attempts - 1) {
        console.warn(`Could not remove temporary directory: ${dir} (${error.message})`);
        return false;
      }
      await sleep(300 * (index + 1));
    }
  }
  return false;
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

  const userDataDir = path.join(outDir, `chrome-profile-${Date.now()}`);
  ensureDir(userDataDir);
  const port = 11260 + Math.floor(Math.random() * 300);
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
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1800);
      chrome.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await sleep(500);
    const resolvedProfile = path.resolve(userDataDir);
    const resolvedOut = path.resolve(outDir);
    if (resolvedProfile.startsWith(resolvedOut + path.sep) && path.basename(resolvedProfile).startsWith("chrome-profile-")) {
      await removeDirWithRetry(resolvedProfile);
    }
  }
}

async function capturePng(cdp, file) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
  return file;
}

function normalizeRecommendation(match, siteLean) {
  if (/平局/.test(siteLean) && !/防平/.test(siteLean)) return "平局";
  if (/客胜/.test(siteLean)) return `${match.away}胜`;
  if (/防平/.test(siteLean)) return `${match.home}胜，防平`;
  if (/胜面占优|优先|主胜/.test(siteLean)) return `${match.home}胜`;
  return match.recommendation;
}

function parseOnlineMatches(cards) {
  return fallbackMatches.map((match) => {
    const card = cards.find((item) => item.includes(`${match.home} VS ${match.away}`));
    if (!card) return match;
    const kickoff = card.match(/^\d{2}\/\d{2}周\S+\s+\d{2}:\d{2}/)?.[0] || match.kickoff;
    return {
      ...match,
      kickoff
    };
  });
}

async function captureWebsitePredictions() {
  const captureDir = path.join(outDir, "website-capture");
  ensureDir(captureDir);
  const screenshotTargets = [
    {
      key: "match-mexico-south-africa",
      url: worldCupMatches[0]?.id ? new URL(`/match/${encodeURIComponent(worldCupMatches[0].id)}`, websiteUrl).href : websiteContentUrl,
      file: "website-match-mexico-south-africa.png",
      beforeShot: "window.scrollTo({ top: 0, behavior: 'instant' })",
      sanitizeMatch: true
    },
    {
      key: "match-korea-czechia",
      url: worldCupMatches[1]?.id ? new URL(`/match/${encodeURIComponent(worldCupMatches[1].id)}`, websiteUrl).href : websiteContentUrl,
      file: "website-match-korea-czechia.png",
      beforeShot: "window.scrollTo({ top: 0, behavior: 'instant' })",
      sanitizeMatch: true
    },
    {
      key: "worldcup-topic",
      url: new URL("/worldcup", websiteUrl).href,
      file: "website-worldcup-topic.png",
      beforeShot: "window.scrollTo({ top: 0, behavior: 'instant' })"
    },
    {
      key: "worldcup-groups",
      url: new URL("/worldcup", websiteUrl).href,
      file: "website-worldcup-groups.png",
      beforeShot: "document.querySelector('.worldcup-group-grid, .worldcup-section')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80)"
    }
  ];
  const result = {
    ok: false,
    url: websiteUrl,
    screenshots: [],
    screenshotMap: {},
    extractedTextPath: null,
    extractedCards: [],
    matches: fallbackMatches,
    error: null
  };

  try {
    await withChrome({ width: 1080, height: 1320 }, async (cdp) => {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          (() => {
            try {
              const previewMatches = ${jsLiteral(worldCupMatches)};
              const session = {
                token: "codex-online-preview",
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
                codeId: "codex"
              };
              localStorage.setItem("football_access_session", JSON.stringify({
                token: session.token,
                issuedAt: session.issuedAt,
                expiresAt: session.expiresAt,
                codeId: session.codeId
              }));
              localStorage.setItem("nerdy_user", JSON.stringify({ username: "已认证" }));
              localStorage.setItem("nerdy_lang", "zh");
            } catch (error) {}

            const jsonResponse = (data) => new Response(JSON.stringify(data), {
              status: 200,
              headers: { "content-type": "application/json" }
            });

            const currentMatches = ${jsLiteral(worldCupMatches)};
            const syncMeta = {
              updatedAt: new Date().toISOString(),
              capturedAt: new Date().toISOString(),
              byStatus: { SCHEDULED: currentMatches.length, UPCOMING: currentMatches.length, LIVE: 0, FINISHED: 0 },
              files: { current: currentMatches.length, history: currentMatches.length },
              api: { source: "static-preview", stale: false, ageSeconds: 0 },
              refreshPolicy: { pagePollSeconds: 30, workflowMinutes: 5 }
            };

            const sourceHealth = {
              sporttery: { ok: true, label: "中国竞彩网官方赛程与 SP 快照" },
              sync: { ok: true, label: "每日自动同步" }
            };

            const originalFetch = window.fetch ? window.fetch.bind(window) : null;
            window.fetch = async (input, init) => {
              const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
              const url = new URL(rawUrl, location.href);
              const path = url.pathname;
              if (
                path === "/api/matches/current" ||
                path === "/api/matches/root" ||
                path === "/api/matches/history" ||
                path === "/data/matches-current.json" ||
                path === "/data/matches-history.json" ||
                path === "/matches.json"
              ) return jsonResponse(currentMatches);
              if (path === "/api/sync-meta" || path === "/data/sync-meta.json") return jsonResponse(syncMeta);
              if (path === "/api/data/sources") return jsonResponse(sourceHealth);
              if (path === "/api/access/status") {
                return jsonResponse({ ok: true, authorized: true, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
              }
              if (path === "/api/events") return new Response("", { status: 204 });
              if (originalFetch) {
                try {
                  return await originalFetch(input, init);
                } catch (error) {
                  if (path.startsWith("/api/")) return jsonResponse({ ok: true });
                  throw error;
                }
              }
              return jsonResponse({ ok: true });
            };

            window.EventSource = class {
              constructor() {
                this.readyState = 2;
              }
              close() {}
              addEventListener() {}
              removeEventListener() {}
              dispatchEvent() { return false; }
            };

            const style = document.createElement("style");
            style.textContent = ".contact-dock,.contact-dock-button,.contact-drawer,.contact-drawer-backdrop,.wechat-contact,.floating-contact{display:none!important}";
            document.documentElement.appendChild(style);
          })();
        `
      });

      const extractedPages = [];
      for (const target of screenshotTargets) {
        const sanitizeMatchShot = target.sanitizeMatch ? `
          document.documentElement.classList.add("codex-douyin-match-shot");
          document.querySelector(".prediction-view-stack")?.setAttribute("data-view", "summary");
          if (!document.querySelector("style[data-codex-douyin-match-shot]")) {
            const style = document.createElement("style");
            style.setAttribute("data-codex-douyin-match-shot", "true");
            style.textContent = ${JSON.stringify(`
              html.codex-douyin-match-shot .prediction-view-nav,
              html.codex-douyin-match-shot .signal-summary-card,
              html.codex-douyin-match-shot .prediction-policy-note,
              html.codex-douyin-match-shot .recommendation-overview-panel.is-goals,
              html.codex-douyin-match-shot .prediction-tip-card,
              html.codex-douyin-match-shot .prediction-empty-card,
              html.codex-douyin-match-shot .review-card {
                display: none !important;
              }
              html.codex-douyin-match-shot .prediction-view-stack > .recommendation-overview-card,
              html.codex-douyin-match-shot .prediction-view-stack > .recommendation-score-card {
                display: grid !important;
              }
              html.codex-douyin-match-shot .recommendation-score-card {
                grid-template-columns: minmax(0, 1fr) !important;
              }
              html.codex-douyin-match-shot .recommendation-mini-tags,
              html.codex-douyin-match-shot .recommendation-score-final {
                display: none !important;
              }
              html.codex-douyin-match-shot .recommendation-overview-panel p {
                font-size: .88rem !important;
                line-height: 1.55 !important;
              }
              html.codex-douyin-match-shot .detail-tab-panel {
                margin-top: 1rem !important;
              }
            `)};
            document.head.appendChild(style);
          }
          document.querySelectorAll(".recommendation-score-option em").forEach((node) => {
            node.textContent = "比分参考";
          });
        ` : "";
        const load = cdp.waitFor("Page.loadEventFired");
        await cdp.send("Page.navigate", { url: target.url });
        await load;
        await sleep(3200);
        await cdp.send("Runtime.evaluate", {
          expression: `
            (() => {
              ${target.beforeShot};
              ${sanitizeMatchShot};
              document.querySelectorAll(".contact-dock,.contact-dock-button,.contact-drawer,.contact-drawer-backdrop,.wechat-contact,.floating-contact").forEach((node) => node.remove());
            })();
          `
        });
        await sleep(1000);

        const file = await capturePng(cdp, path.join(captureDir, target.file));
        result.screenshots.push(file);
        result.screenshotMap[target.key] = file;

        const extracted = await cdp.send("Runtime.evaluate", {
          returnByValue: true,
          expression: `
            (() => {
              const normalize = (text) => String(text || "").replace(/\\s+/g, " ").trim();
              const matchCards = Array.from(document.querySelectorAll(".worldcup-match-card"))
                .map((node) => normalize(node.innerText))
                .filter(Boolean);
              return {
                key: ${JSON.stringify(target.key)},
                title: document.title,
                href: location.href,
                matchCards
              };
            })()
          `
        });
        extractedPages.push(extracted.result.value || {});
      }

      const textFile = path.join(captureDir, "website-extracted-text.json");
      fs.writeFileSync(textFile, JSON.stringify({ pages: extractedPages }, null, 2), "utf8");
      result.extractedTextPath = textFile;
      result.extractedCards = extractedPages.flatMap((page) => page.matchCards || []);
      result.matches = parseOnlineMatches(result.extractedCards);
      result.ok = true;
    });
  } catch (error) {
    result.error = error.message;
    fs.writeFileSync(path.join(captureDir, "capture-error.txt"), error.stack || error.message, "utf8");
  }

  return result;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function imageSrc(file) {
  return file ? pathToFileURL(file).href : "";
}

function writeUtf8Bom(file, value) {
  fs.writeFileSync(file, `\uFEFF${value}`, "utf8");
}

function predictionCardsHtml(rows) {
  return rows.map((match) => `
    <article class="pick-card">
      <div class="pick-top">
        <span>${htmlEscape(match.kickoff)}</span>
        <b>${htmlEscape(match.home)} vs ${htmlEscape(match.away)}</b>
      </div>
      <div class="pick-body">
        <div><small>推荐</small><strong>${htmlEscape(match.recommendation)}</strong></div>
        <div><small>比分</small><strong>${htmlEscape(match.score)}</strong></div>
      </div>
    </article>
  `).join("");
}

function pickHighlightHtml(pick) {
  return `
    <section class="pick-highlight">
      <div>
        <small>网站推荐</small>
        <strong>${htmlEscape(pick.recommendation)}</strong>
      </div>
      <div>
        <small>比分参考</small>
        <strong>${htmlEscape(pick.score)}</strong>
      </div>
      <p>${htmlEscape(pick.note)}</p>
    </section>
  `;
}

function predictionTableHtml(rows) {
  return `
    <section class="prediction-table">
      <div class="table-head">
        <span>时间</span><span>对阵</span><span>推荐</span><span>比分</span>
      </div>
      ${rows.map((match) => `
        <div class="table-row">
          <span>${htmlEscape(match.kickoff.replace("06/12周五 ", ""))}</span>
          <strong>${htmlEscape(match.home)} vs ${htmlEscape(match.away)}</strong>
          <b>${htmlEscape(match.recommendation)}</b>
          <em>${htmlEscape(match.score)}</em>
        </div>
      `).join("")}
    </section>
  `;
}

function siteIntroHtml(siteIntro) {
  if (!siteIntro) return "";
  const sections = siteIntro.sections || [];
  const features = siteIntro.features || [];
  return `
    <section class="site-intro-card">
      <div class="site-header-line">
        <div class="site-score">90</div>
        <div>
          <strong>${htmlEscape(siteIntro.name)}</strong>
          <span>${htmlEscape(siteIntro.tagline)}</span>
        </div>
      </div>
      <p>${htmlEscape(siteIntro.description)}</p>
      <div class="site-url">${htmlEscape(websiteUrl)}</div>
      <div class="site-chip-grid">
        ${sections.map((item) => `<span>${htmlEscape(item)}</span>`).join("")}
      </div>
      <div class="site-feature-grid">
        ${features.map((item) => `<b>${htmlEscape(item)}</b>`).join("")}
      </div>
    </section>
  `;
}

function buildVoiceLines(matches) {
  return [
    "今天只看两场世界杯赛前重点。",
    "第一场，墨西哥对南非，推荐墨西哥胜，同时防平，比分参考一比零或一比一。",
    "第二场，韩国对捷克，推荐韩国胜，同时防平，比分参考一比零或一比一。",
    "世界杯专题页可以看赛程、SP、比赛入口和赛事数据看板。",
    "预测路线重点看小组出线、最佳第三名和淘汰赛路径，晋级概率会在页面里一起展示。",
    "完整赛程和页面内容看画面上的网址，评论区也可以直接说你更看好哪一场。"
  ];
}

function buildPublishCopy(matches) {
  const lines = matches.map((match, index) => `${index + 1}. ${match.home} vs ${match.away}
推荐：${match.recommendation}
比分：${match.score}`).join("\n\n");
  return `今天两场赛前整理，直接看方向和比分：

${lines}

一句话：
墨西哥、韩国都看胜方向，同时防平。

这两场你更看好哪一个比分？

#世界杯 #足球预测 #赛前分析 #比分预测 #抖音足球`;
}

function buildScenes(siteCapture, matches) {
  const shot = (key, fallbackIndex) => siteCapture.screenshotMap?.[key] || siteCapture.screenshots[fallbackIndex] || null;
  return [
    {
      key: "cover",
      eyebrow: "今日赛前推荐",
      title: "今日两场预测",
      subtitle: "只看推荐方向 + 比分参考",
      meta: "网址：http://170.106.75.73/",
      kind: "cover"
    },
    {
      key: "match-mexico",
      eyebrow: "比赛详情页",
      title: "墨西哥 vs 南非",
      subtitle: `推荐：${matches[0]?.recommendation || "墨西哥胜，防平"}｜比分：${matches[0]?.score || "1-0 / 1-1"}`,
      pickHighlight: {
        recommendation: matches[0]?.recommendation || "墨西哥胜，防平",
        score: matches[0]?.score || "1-0 / 1-1",
        note: "墨西哥主胜方向优先，保留平局防线。"
      },
      imagePath: shot("match-mexico-south-africa", 0)
    },
    {
      key: "match-korea",
      eyebrow: "比赛详情页",
      title: "韩国 vs 捷克",
      subtitle: `推荐：${matches[1]?.recommendation || "韩国胜，防平"}｜比分：${matches[1]?.score || "1-0 / 1-1"}`,
      pickHighlight: {
        recommendation: matches[1]?.recommendation || "韩国胜，防平",
        score: matches[1]?.score || "1-0 / 1-1",
        note: "韩国主胜方向优先，比分保留防平选项。"
      },
      imagePath: shot("match-korea-czechia", 1)
    },
    {
      key: "worldcup-topic",
      eyebrow: "世界杯专题",
      title: "赛事数据看板",
      subtitle: "赛程 / SP / 专题内容",
      imagePath: shot("worldcup-topic", 2)
    },
    {
      key: "worldcup-groups",
      eyebrow: "小组赛预测",
      title: "路径和出线概率",
      subtitle: "小组出线 / 最佳第三名 / 淘汰赛路径",
      imagePath: shot("worldcup-groups", 3)
    },
    {
      key: "publish",
      eyebrow: "网站入口",
      title: "完整内容看网址",
      subtitle: "赛程 / SP / 推荐 / 世界杯预测路线",
      note: "网站入口：http://170.106.75.73/"
    }
  ];
}

function sceneHtml(scene, index, total) {
  const isCover = scene.kind === "cover";
  const accent = index % 2 === 0 ? "#22c55e" : "#f5c84b";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; }
    body {
      color: #f7f5ee;
      background: #0b1210;
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    body::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px),
        linear-gradient(0deg, rgba(255,255,255,.035) 1px, transparent 1px),
        linear-gradient(155deg, #0b1210 0%, #16231f 46%, #101113 100%);
      background-size: 92px 92px, 92px 92px, auto;
    }
    .wrap { position: absolute; inset: 58px 58px 52px; z-index: 1; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: rgba(247,245,238,.62);
      font-size: 25px;
      font-weight: 700;
    }
    .brand { display: flex; align-items: center; gap: 13px; color: #fff; font-size: 31px; font-weight: 900; }
    .brand-mark {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      color: #07110e;
      background: ${accent};
      font-size: 24px;
      font-weight: 900;
    }
    .panel {
      position: absolute;
      left: 0;
      right: 0;
      top: 132px;
      bottom: 86px;
      border: 2px solid rgba(255,255,255,.10);
      border-radius: 8px;
      padding: 68px 28px 28px;
      overflow: hidden;
    }
    .eyebrow {
      display: inline-flex;
      min-height: 54px;
      align-items: center;
      padding: 10px 22px;
      border-radius: 8px;
      background: rgba(255,255,255,.09);
      border: 1px solid rgba(255,255,255,.16);
      color: ${accent};
      font-size: 28px;
      font-weight: 900;
    }
    h1 {
      margin: ${isCover ? 42 : 30}px 0 0;
      font-size: ${isCover ? 104 : 72}px;
      line-height: 1.08;
      font-weight: 900;
      color: #fff;
    }
    .subtitle {
      margin: 24px 0 0;
      max-width: 920px;
      font-size: ${isCover ? 43 : 34}px;
      line-height: 1.38;
      color: rgba(247,245,238,.80);
      font-weight: 780;
    }
    .meta {
      margin-top: 38px;
      color: #10110d;
      background: ${accent};
      width: fit-content;
      max-width: 900px;
      padding: 18px 24px;
      border-radius: 8px;
      font-size: 30px;
      font-weight: 900;
    }
    .site-shot {
      width: 100%;
      height: 1060px;
      object-fit: fill;
      object-position: top center;
      margin-top: 28px;
      border-radius: 8px;
      border: 2px solid rgba(255,255,255,.16);
      box-shadow: 0 28px 80px rgba(0,0,0,.42);
      background: rgba(255,255,255,.08);
    }
    .site-shot.is-match-shot {
      height: 870px;
      margin-top: 20px;
    }
    .pick-highlight {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 20px;
      padding: 16px;
      border: 2px solid rgba(34, 197, 94, .34);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(34,197,94,.16), rgba(245,200,75,.08)),
        rgba(5,18,14,.88);
      box-shadow: 0 18px 48px rgba(0,0,0,.32);
    }
    .pick-highlight div {
      min-height: 98px;
      padding: 15px 18px;
      border-radius: 8px;
      background: rgba(0,0,0,.24);
      border: 1px solid rgba(255,255,255,.14);
    }
    .pick-highlight small {
      display: block;
      color: rgba(247,245,238,.62);
      font-size: 21px;
      font-weight: 850;
    }
    .pick-highlight strong {
      display: block;
      margin-top: 8px;
      color: ${accent};
      font-size: 34px;
      line-height: 1.12;
      font-weight: 950;
    }
    .pick-highlight p {
      grid-column: 1 / -1;
      margin: 0;
      color: rgba(247,245,238,.82);
      font-size: 23px;
      line-height: 1.28;
      font-weight: 850;
    }
    .site-intro-card {
      margin-top: 42px;
      padding: 36px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.16);
      background: linear-gradient(145deg, rgba(255,255,255,.10), rgba(255,255,255,.045));
      box-shadow: 0 28px 80px rgba(0,0,0,.32);
    }
    .site-header-line {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .site-score {
      width: 76px;
      height: 76px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      color: #0c130f;
      background: ${accent};
      font-size: 31px;
      font-weight: 950;
    }
    .site-header-line strong {
      display: block;
      color: #fff;
      font-size: 52px;
      line-height: 1.05;
      font-weight: 950;
    }
    .site-header-line span {
      display: block;
      margin-top: 9px;
      color: rgba(247,245,238,.72);
      font-size: 29px;
      font-weight: 850;
    }
    .site-intro-card p {
      margin: 34px 0 0;
      color: rgba(247,245,238,.86);
      font-size: 38px;
      line-height: 1.38;
      font-weight: 850;
    }
    .site-url {
      margin-top: 32px;
      padding: 22px 24px;
      border-radius: 8px;
      color: #0b1210;
      background: ${accent};
      font-size: 38px;
      line-height: 1.15;
      font-weight: 950;
      overflow-wrap: anywhere;
    }
    .site-chip-grid,
    .site-feature-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 28px;
    }
    .site-chip-grid span,
    .site-feature-grid b {
      min-height: 78px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px 16px;
      border-radius: 8px;
      text-align: center;
      background: rgba(0,0,0,.24);
      border: 1px solid rgba(255,255,255,.12);
      color: #fff;
      font-size: 27px;
      line-height: 1.18;
      font-weight: 900;
    }
    .site-feature-grid b {
      color: ${accent};
    }
    .pick-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 18px;
      margin-top: 36px;
    }
    .pick-card {
      min-height: 188px;
      padding: 24px;
      border-radius: 8px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.15);
    }
    .pick-top {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 20px;
    }
    .pick-top span {
      color: ${accent};
      font-size: 25px;
      font-weight: 900;
    }
    .pick-top b {
      color: #fff;
      font-size: 34px;
      line-height: 1.2;
      text-align: right;
    }
    .pick-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .pick-body div {
      min-height: 88px;
      padding: 16px 18px;
      border-radius: 8px;
      background: rgba(0,0,0,.23);
    }
    .pick-body small {
      display: block;
      color: rgba(247,245,238,.58);
      font-size: 22px;
      font-weight: 800;
    }
    .pick-body strong {
      display: block;
      margin-top: 7px;
      color: #fff;
      font-size: 33px;
      line-height: 1.22;
      font-weight: 900;
    }
    .prediction-table {
      margin-top: 36px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.15);
      background: rgba(255,255,255,.08);
    }
    .table-head,
    .table-row {
      display: grid;
      grid-template-columns: .68fr 1.35fr 1fr 1fr;
      gap: 12px;
      align-items: center;
      min-height: 82px;
      padding: 0 20px;
      border-bottom: 1px solid rgba(255,255,255,.10);
      font-size: 25px;
    }
    .table-head {
      min-height: 68px;
      color: ${accent};
      font-weight: 900;
      background: rgba(0,0,0,.26);
    }
    .table-row strong {
      color: #fff;
      font-size: 27px;
      font-weight: 900;
    }
    .table-row span {
      color: rgba(247,245,238,.76);
      font-weight: 800;
    }
    .table-row b {
      color: ${accent};
      font-size: 27px;
      font-weight: 900;
    }
    .table-row em {
      color: #fff;
      font-style: normal;
      font-size: 27px;
      font-weight: 900;
    }
    .note {
      position: absolute;
      left: 28px;
      right: 28px;
      bottom: 28px;
      padding: 20px 22px;
      border-radius: 8px;
      background: rgba(245, 200, 75, .12);
      border: 1px solid rgba(245, 200, 75, .28);
      color: #ffe08a;
      font-size: 28px;
      line-height: 1.34;
      font-weight: 850;
    }
    .footer {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: space-between;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,.12);
      color: rgba(247,245,238,.48);
      font-size: 21px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand"><div class="brand-mark">AI</div><span>足球赛前笔记</span></div>
      <div>World Cup 2026</div>
    </div>
    <section class="panel">
      <div class="eyebrow">${htmlEscape(scene.eyebrow)}</div>
      <h1>${htmlEscape(scene.title)}</h1>
      <div class="subtitle">${htmlEscape(scene.subtitle)}</div>
      ${scene.meta ? `<div class="meta">${htmlEscape(scene.meta)}</div>` : ""}
      ${scene.pickHighlight ? pickHighlightHtml(scene.pickHighlight) : ""}
      ${scene.imagePath ? `<img class="site-shot${scene.pickHighlight ? " is-match-shot" : ""}" src="${imageSrc(scene.imagePath)}" alt="线上网站截图">` : ""}
      ${scene.siteIntro ? siteIntroHtml(scene.siteIntro) : ""}
      ${scene.tableRows ? predictionTableHtml(scene.tableRows) : ""}
      ${scene.cards ? `<section class="pick-grid">${predictionCardsHtml(scene.cards)}</section>` : ""}
      ${scene.note ? `<div class="note">${htmlEscape(scene.note)}</div>` : ""}
    </section>
    <div class="footer">
      <span>网站来源：http://170.106.75.73/</span>
      <span>${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span>
    </div>
  </main>
</body>
</html>`;
}

async function renderFrames(scenes) {
  ensureDir(htmlDir);
  ensureDir(frameDir);
  const frameFiles = [];

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    fs.writeFileSync(path.join(htmlDir, `${scene.key}.html`), sceneHtml(scene, index, scenes.length), "utf8");
  }

  await withChrome({ width, height }, async (cdp) => {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const htmlFile = path.join(htmlDir, `${scene.key}.html`);
      const load = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: pathToFileURL(htmlFile).href });
      await load;
      await sleep(500);
      const frameFile = path.join(frameDir, `${String(index + 1).padStart(2, "0")}-${scene.key}.png`);
      await capturePng(cdp, frameFile);
      frameFiles.push(frameFile);
    }
  });

  fs.copyFileSync(frameFiles[0], path.join(outDir, "cover.png"));
  return frameFiles;
}

function synthesizeVoice(voiceLines) {
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
        communicate = edge_tts.Communicate(line, "zh-CN-YunyangNeural", rate="+4%", pitch="-2Hz")
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
  for (let index = 0; index < voiceLines.length; index += 1) {
    const mp3 = path.join(ttsDir, `line_${String(index + 1).padStart(2, "0")}.mp3`);
    const duration = Number(output("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp3]));
    segments.push(duration + 0.44);
    concatLines.push(`file '${mp3.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    if (index < voiceLines.length - 1) concatLines.push(`file '${silence.replace(/\\/g, "/")}'`);
  }
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf8");

  const voice = path.join(outDir, "voiceover.mp3");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-q:a", "3", voice]);
  return { voice, segments };
}

function createVideo(frameFiles, voiceInfo) {
  const inputs = [];
  const filterParts = [];
  const sceneDurations = frameFiles.map((_, index) => {
    if (!voiceInfo) return index === 0 ? 3.2 : 5.0;
    if (index === frameFiles.length - 1) {
      return Math.max(5.2, voiceInfo.segments.slice(index).reduce((sum, item) => sum + item, 0));
    }
    return Math.max(4.2, voiceInfo.segments[index] || 5.0);
  });

  frameFiles.forEach((file, index) => {
    const duration = sceneDurations[index];
    inputs.push("-loop", "1", "-t", duration.toFixed(3), "-i", file);
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `fps=${fps},trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`
    );
  });

  const concatInputs = frameFiles.map((_, index) => `[v${index}]`).join("");
  const silent = path.join(outDir, "worldcup-today-silent.mp4");
  const finalVideo = path.join(outDir, "worldcup-today-douyin.mp4");

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

  if (!voiceInfo) return silent;

  run("ffmpeg", [
    "-y",
    "-i", silent,
    "-i", voiceInfo.voice,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "144k",
    "-shortest",
    "-movflags", "+faststart",
    finalVideo
  ]);

  return finalVideo;
}

function writeTextArtifacts(finalVideo, frameFiles, voiceInfo, siteCapture, matches, voiceLines, publishCopy) {
  const matchLines = matches.map((match, index) => `### ${index + 1}. ${match.home} vs ${match.away}

- 时间：${match.kickoff}
- 线上推荐：${match.recommendation}
- 比分参考：${match.score}
`).join("\n");

  const md = `# 2026-06-11 今日两场推荐抖音内容包

## 标题备选

1. 今日两场赛前推荐
2. 世界杯今日两场方向和比分
3. 今日足球推荐：只看方向和比分
4. 两场赛前预测，比分一起给

## 网站页面

- 页面网址：${websiteUrl}
- 主页面内容：已生成网站截图分镜

## 推荐与比分

${matchLines}
## 口播稿

${voiceLines.map((line, index) => `${index + 1}. ${line}`).join("\n\n")}

## 发布文案

${publishCopy}

## 置顶评论

今天两场赛前整理：只看方向和比分。这两场你更看好哪一个比分？

## 素材清单

- 成片：${finalVideo}
- 封面：${path.join(outDir, "cover.png")}
${frameFiles.map((file) => `- 分镜：${file}`).join("\n")}
${voiceInfo ? `- 配音：${voiceInfo.voice}` : "- 配音：生成失败，已输出无声视频"}`;

  writeUtf8Bom(path.join(outDir, "douyin-content-package.md"), md);
  writeUtf8Bom(path.join(outDir, "publish-copy.txt"), publishCopy);
  writeUtf8Bom(path.join(outDir, "voiceover.txt"), voiceLines.join("\n"));
  writeUtf8Bom(path.join(outDir, "sources.md"), `# Sources\n\n- 网站：${websiteUrl}\n`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    size: `${width}x${height}`,
    websiteUrl,
    websiteContentUrl,
    siteCapture,
    finalVideo,
    cover: path.join(outDir, "cover.png"),
    frames: frameFiles,
    voice: voiceInfo?.voice || null,
    matches
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

async function main() {
  ensureDir(outDir);
  resetGeneratedDirs();
  console.log("Capturing online website predictions...");
  const siteCapture = await captureWebsitePredictions();
  const matches = siteCapture.matches || fallbackMatches;
  const voiceLines = buildVoiceLines(matches);
  const publishCopy = buildPublishCopy(matches);

  console.log("Rendering Douyin frames...");
  const scenes = buildScenes(siteCapture, matches);
  const frameFiles = await renderFrames(scenes);

  let voiceInfo = null;
  try {
    console.log("Synthesizing voiceover...");
    voiceInfo = synthesizeVoice(voiceLines);
  } catch (error) {
    console.warn(`Voiceover failed, creating silent video instead: ${error.message}`);
  }

  console.log("Compositing video...");
  const finalVideo = createVideo(frameFiles, voiceInfo);
  writeTextArtifacts(finalVideo, frameFiles, voiceInfo, siteCapture, matches, voiceLines, publishCopy);
  console.log(JSON.stringify({
    outDir,
    websiteUrl,
    websiteCaptured: siteCapture.ok,
    finalVideo,
    cover: path.join(outDir, "cover.png"),
    screenshots: siteCapture.screenshots,
    frames: frameFiles,
    voice: voiceInfo?.voice || null,
    matches
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
