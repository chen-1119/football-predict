const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");
const distDir = path.join(rootDir, "dist");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const snapshotsDir = path.join(storeDir, "snapshots");

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "0.0.0.0";
const syncIntervalSeconds = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS || 300));
const gptIntervalSeconds = Math.max(300, Number(process.env.GPT_INTERVAL_SECONDS || 900));
const snapshotRetentionDays = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS || 30));
const adminToken = process.env.ADMIN_TOKEN || "";
const allowLocalAdmin = process.env.ALLOW_LOCAL_ADMIN === "1";
const publicApiBase = process.env.PUBLIC_DATA_API_BASE || "/api";

const apiFiles = {
  "/api/sync-meta": path.join(dataDir, "sync-meta.json"),
  "/api/matches/history": path.join(dataDir, "matches-history.json"),
  "/api/matches/root": path.join(publicDir, "matches.json"),
  "/api/odds/history": path.join(dataDir, "odds-history.json"),
  "/api/predictions/snapshots": path.join(dataDir, "prediction-snapshots.json"),
  "/api/predictions/gpt": path.join(dataDir, "gpt-predictions.json"),
  "/api/model/calibration": path.join(dataDir, "model-calibration.json"),
  "/api/teams/index": path.join(dataDir, "team-index.json")
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

let syncRunning = false;
let predictRunning = false;
let lastSync = null;
let lastPredictionRun = null;

const nowIso = () => new Date().toISOString();

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const ensureStore = async () => {
  await fsp.mkdir(storeDir, { recursive: true });
  await fsp.mkdir(snapshotsDir, { recursive: true });
};

const readJsonFile = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (filePath, data) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const ensureGeneratedFiles = async () => {
  const gptPath = path.join(dataDir, "gpt-predictions.json");
  if (!fs.existsSync(gptPath)) {
    await writeJsonFile(gptPath, {
      version: 1,
      source: "gpt-relay",
      updatedAt: null,
      rows: []
    });
  }
};

const appendEvent = async (event) => {
  await ensureStore();
  const row = {
    id: crypto.randomUUID(),
    at: nowIso(),
    ...event
  };
  await fsp.appendFile(path.join(storeDir, "events.jsonl"), `${JSON.stringify(row)}\n`);
  return row;
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
};

const sendJson = (res, payload, status = 200) => {
  send(res, status, JSON.stringify(payload, null, 2), {
    "content-type": "application/json; charset=utf-8"
  });
};

const readRequestJson = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      req.destroy(new Error("request body too large"));
    }
  });
  req.on("end", () => resolve(body ? safeJsonParse(body, {}) : {}));
  req.on("error", reject);
});

const isAuthorized = (req, url) => {
  const remote = req.socket.remoteAddress || "";
  const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!adminToken) return allowLocalAdmin && isLocal;
  const queryToken = url.searchParams.get("token");
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  return queryToken === adminToken || bearer === adminToken;
};

const runCommand = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32"
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
  });
});

const cleanupOldSnapshots = async () => {
  const cutoff = Date.now() - snapshotRetentionDays * 24 * 60 * 60 * 1000;
  try {
    const files = await fsp.readdir(snapshotsDir);
    await Promise.all(files.map(async (fileName) => {
      if (!fileName.endsWith(".json")) return;
      const filePath = path.join(snapshotsDir, fileName);
      const stat = await fsp.stat(filePath);
      if (stat.mtimeMs < cutoff) await fsp.unlink(filePath);
    }));
  } catch {
    // Snapshot cleanup is best effort.
  }
};

const captureCurrentSnapshot = async (source) => {
  const matches = await readJsonFile(path.join(dataDir, "matches-current.json"), []);
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), {});
  const stamp = nowIso().replace(/[:.]/g, "-");
  const snapshotFile = path.join(snapshotsDir, `current-${stamp}.json`);
  await writeJsonFile(snapshotFile, {
    source,
    capturedAt: nowIso(),
    count: Array.isArray(matches) ? matches.length : 0,
    meta,
    matches
  });
  await cleanupOldSnapshots();
  await appendEvent({
    type: "current_snapshot",
    source,
    matchCount: Array.isArray(matches) ? matches.length : 0,
    metaUpdatedAt: meta.updatedAt || meta.capturedAt || null,
    snapshotFile: path.relative(rootDir, snapshotFile).replace(/\\/g, "/")
  });
};

const runSync = async (source = "server-cron") => {
  if (syncRunning) {
    return { ok: true, skipped: true, reason: "sync already running", lastSync };
  }

  syncRunning = true;
  const startedAt = nowIso();
  try {
    await appendEvent({ type: "sync_started", source });
    await runCommand("node", ["scripts/syncData.cjs"], {
      PAGE_POLL_SECONDS: process.env.PAGE_POLL_SECONDS || "20",
      SYNC_WORKFLOW_MINUTES: String(Math.max(1, Math.round(syncIntervalSeconds / 60)))
    });
    await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "validate:data"]);
    await captureCurrentSnapshot(source);
    lastSync = { ok: true, source, startedAt, finishedAt: nowIso() };
    await appendEvent({ type: "sync_completed", ...lastSync });
    return lastSync;
  } catch (error) {
    lastSync = {
      ok: false,
      source,
      startedAt,
      finishedAt: nowIso(),
      error: error.message || String(error)
    };
    await appendEvent({ type: "sync_failed", ...lastSync });
    return lastSync;
  } finally {
    syncRunning = false;
  }
};

const summarizeOdds = (match) => {
  const pools = [
    match.odds ? `HAD ${match.odds.odds1}/${match.odds.oddsX}/${match.odds.odds2}` : "",
    match.handicapOdds
      ? `HHAD(${match.handicapLine || match.handicap || 0}) ${match.handicapOdds.odds1}/${match.handicapOdds.oddsX}/${match.handicapOdds.odds2}`
      : ""
  ].filter(Boolean);
  return pools.length ? pools.join("; ") : "暂无";
};

const buildMatchPrompt = (match) => {
  return [
    "你是一名专业足球赛事分析师。只使用下方赛前数据，不要编造伤停、首发、天气、裁判或外部赔率。",
    "如果数据不足，必须降级为观察或低优先级；只有盘口、概率优势、历史样本和风险同时通过时才给推荐。",
    "请输出严格 JSON，不要 Markdown。字段包含：summary、probabilities{home,draw,away,over25,bttsYes}、recommendation{market,pick,confidence,risk}、reasons[]、missingData[]、reviewPlan。",
    `比赛：${match.homeTeamName || match.homeTeamId} vs ${match.awayTeamName || match.awayTeamId}`,
    `赛事：${match.leagueName || match.leagueId}`,
    `竞彩开赛时间：${match.kickoffTime}`,
    `状态：${match.status}`,
    `官方赔率：${summarizeOdds(match)}`,
    `当前模型可信度：${match.aiConfidence ?? match.trustScore ?? "未知"}`,
    `已有预测：${JSON.stringify(match.predictions || []).slice(0, 2500)}`,
    `赛前概率模型：${JSON.stringify(match.probabilityModel || null).slice(0, 2500)}`,
    `近期/交锋/赛果样本：${JSON.stringify({ recentForm: match.recentForm, h2h: match.h2h, standings: match.standings, stats: match.stats }).slice(0, 3500)}`
  ].join("\n");
};

const callGptRelay = async (match) => {
  const base = (process.env.GPT_RELAY_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.GPT_RELAY_API_KEY || "";
  const model = process.env.GPT_MODEL || "gpt-4o-mini";
  const pathName = process.env.GPT_RELAY_CHAT_PATH || "/v1/chat/completions";

  if (!base || !apiKey) {
    return {
      ok: false,
      skipped: true,
      reason: "GPT_RELAY_BASE_URL or GPT_RELAY_API_KEY is not configured"
    };
  }

  const response = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: Number(process.env.GPT_TEMPERATURE || 0.2),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你只输出严格 JSON，不输出 Markdown，不编造缺失数据。" },
        { role: "user", content: buildMatchPrompt(match) }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT relay ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  return {
    ok: true,
    model,
    raw: payload,
    parsed: safeJsonParse(content, { summary: content })
  };
};

const readGptPredictions = async () => readJsonFile(path.join(dataDir, "gpt-predictions.json"), {
  version: 1,
  source: "gpt-relay",
  updatedAt: null,
  rows: []
});

const writeGptPredictions = async (rows) => {
  const payload = {
    version: 1,
    source: "gpt-relay",
    updatedAt: nowIso(),
    rows
  };
  await writeJsonFile(path.join(dataDir, "gpt-predictions.json"), payload);
  return payload;
};

const runGptPredictions = async ({ matchIds = [], limit = 8, source = "server-manual" } = {}) => {
  if (predictRunning) {
    return { ok: true, skipped: true, reason: "prediction already running", lastPredictionRun };
  }

  predictRunning = true;
  const startedAt = nowIso();
  try {
    const matches = await readJsonFile(path.join(dataDir, "matches-current.json"), []);
    const now = Date.now();
    const candidates = matches
      .filter((match) => match.status === "SCHEDULED")
      .filter((match) => matchIds.length === 0 || matchIds.includes(match.id))
      .filter((match) => Date.parse(match.kickoffTime || "") > now)
      .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""))
      .slice(0, Math.max(1, Number(limit || 8)));

    const existing = await readGptPredictions();
    const rowsById = new Map((existing.rows || []).map((row) => [row.matchId, row]));
    const results = [];

    for (const match of candidates) {
      const relayResult = await callGptRelay(match);
      const row = {
        matchId: match.id,
        generatedAt: nowIso(),
        source,
        leagueId: match.leagueId,
        leagueName: match.leagueName,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        kickoffTime: match.kickoffTime,
        status: match.status,
        relay: relayResult
      };
      rowsById.set(match.id, row);
      results.push(row);
      await appendEvent({
        type: "gpt_prediction",
        matchId: match.id,
        source,
        ok: relayResult.ok,
        skipped: relayResult.skipped
      });
      if (relayResult.skipped) break;
    }

    const payload = await writeGptPredictions(Array.from(rowsById.values()).sort((a, b) => {
      return Date.parse(b.generatedAt || "") - Date.parse(a.generatedAt || "");
    }));
    lastPredictionRun = {
      ok: true,
      source,
      startedAt,
      finishedAt: nowIso(),
      requested: candidates.length,
      generated: results.length
    };
    await appendEvent({ type: "gpt_prediction_completed", ...lastPredictionRun });
    return { ...lastPredictionRun, payload };
  } catch (error) {
    lastPredictionRun = {
      ok: false,
      source,
      startedAt,
      finishedAt: nowIso(),
      error: error.message || String(error)
    };
    await appendEvent({ type: "gpt_prediction_failed", ...lastPredictionRun });
    return lastPredictionRun;
  } finally {
    predictRunning = false;
  }
};

const mergeGptIntoMatches = async () => {
  const matches = await readJsonFile(path.join(dataDir, "matches-current.json"), []);
  const gpt = await readGptPredictions();
  if (!Array.isArray(matches)) return matches;
  const byId = new Map((gpt.rows || []).map((row) => [row.matchId, row]));
  return matches.map((match) => {
    const gptPrediction = byId.get(match.id);
    return gptPrediction ? { ...match, gptPrediction } : match;
  });
};

const readRecentEvents = async (limit = 50, type = "") => {
  try {
    const text = await fsp.readFile(path.join(storeDir, "events.jsonl"), "utf8");
    return text
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line, null))
      .filter(Boolean)
      .filter((event) => !type || event.type === type)
      .slice(-Math.max(1, Math.min(500, Number(limit || 50))))
      .reverse();
  } catch {
    return [];
  }
};

const fileInfo = async (filePath) => {
  try {
    const stat = await fsp.stat(filePath);
    return { exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, updatedAt: null };
  }
};

const getHealth = async () => {
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const gpt = await readGptPredictions();
  return {
    ok: true,
    service: "football-predict-server",
    checkedAt: nowIso(),
    syncRunning,
    predictRunning,
    lastSync,
    lastPredictionRun,
    api: {
      publicApiBase,
      gptConfigured: Boolean(process.env.GPT_RELAY_BASE_URL && process.env.GPT_RELAY_API_KEY),
      adminProtected: Boolean(adminToken),
      syncCron: process.env.ENABLE_SYNC_CRON === "1" ? `${syncIntervalSeconds}s` : "off",
      gptCron: process.env.ENABLE_GPT_CRON === "1" ? `${gptIntervalSeconds}s` : "off"
    },
    files: {
      current: await fileInfo(path.join(dataDir, "matches-current.json")),
      history: await fileInfo(path.join(dataDir, "matches-history.json")),
      meta: await fileInfo(path.join(dataDir, "sync-meta.json")),
      gptPredictions: await fileInfo(path.join(dataDir, "gpt-predictions.json"))
    },
    meta,
    gptRows: Array.isArray(gpt.rows) ? gpt.rows.length : 0
  };
};

const sendFile = async (res, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const data = await fsp.readFile(filePath);
    send(res, 200, data, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=60"
    });
  } catch {
    sendJson(res, { ok: false, error: "not found" }, 404);
  }
};

const handleApi = async (req, res, url) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/api/health") {
    return sendJson(res, await getHealth());
  }

  if (url.pathname === "/api/matches/current") {
    return sendJson(res, await mergeGptIntoMatches());
  }

  if (url.pathname === "/api/db/events") {
    return sendJson(res, {
      ok: true,
      rows: await readRecentEvents(url.searchParams.get("limit") || 80, url.searchParams.get("type") || "")
    });
  }

  if (url.pathname === "/api/analytics/summary") {
    return sendJson(res, {
      ok: true,
      checkedAt: nowIso(),
      calibration: await readJsonFile(path.join(dataDir, "model-calibration.json"), null),
      syncMeta: await readJsonFile(path.join(dataDir, "sync-meta.json"), null),
      gptPredictions: await readGptPredictions(),
      recentEvents: await readRecentEvents(20)
    });
  }

  if (url.pathname === "/api/admin/sync") {
    if (req.method !== "POST") return sendJson(res, { ok: false, error: "method not allowed" }, 405);
    if (!isAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    return sendJson(res, await runSync("server-manual"));
  }

  if (url.pathname === "/api/admin/predict") {
    if (req.method !== "POST") return sendJson(res, { ok: false, error: "method not allowed" }, 405);
    if (!isAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    const body = await readRequestJson(req);
    return sendJson(res, await runGptPredictions({
      source: "server-manual",
      matchIds: Array.isArray(body.matchIds) ? body.matchIds : [],
      limit: body.limit || url.searchParams.get("limit") || 8
    }));
  }

  const filePath = apiFiles[url.pathname];
  if (filePath) return sendFile(res, filePath);

  return sendJson(res, { ok: false, error: "unknown api resource" }, 404);
};

const handleRuntimeConfig = (res) => {
  return sendJson(res, {
    dataApiBase: publicApiBase,
    preferDataApi: true,
    historyPreferStatic: true,
    currentPollSeconds: Number(process.env.PAGE_POLL_SECONDS || 20)
  });
};

const handleStatic = async (_req, res, url) => {
  if (url.pathname === "/data/runtime-config.json") return handleRuntimeConfig(res);

  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(distDir, `.${requested}`);
  if (!filePath.startsWith(distDir)) return sendJson(res, { ok: false, error: "bad path" }, 400);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  return sendFile(res, path.join(distDir, "index.html"));
};

const startTimers = () => {
  if (process.env.ENABLE_SYNC_CRON === "1") {
    setTimeout(() => runSync("server-startup"), 1500);
    setInterval(() => runSync("server-cron"), syncIntervalSeconds * 1000);
  }

  if (process.env.ENABLE_GPT_CRON === "1") {
    setTimeout(() => runGptPredictions({
      source: "gpt-startup",
      limit: Number(process.env.GPT_PREDICT_LIMIT || 8)
    }), 10_000);
    setInterval(() => {
      runGptPredictions({
        source: "gpt-cron",
        limit: Number(process.env.GPT_PREDICT_LIMIT || 8)
      });
    }, gptIntervalSeconds * 1000);
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await handleStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, { ok: false, error: error.message || String(error) }, 500);
  }
});

Promise.all([ensureStore(), ensureGeneratedFiles()]).then(() => {
  server.listen(port, host, () => {
    console.log(`[football-server] listening on http://${host}:${port}`);
    console.log(`[football-server] sync cron: ${process.env.ENABLE_SYNC_CRON === "1" ? `${syncIntervalSeconds}s` : "off"}`);
    console.log(`[football-server] gpt cron: ${process.env.ENABLE_GPT_CRON === "1" ? `${gptIntervalSeconds}s` : "off"}`);
    console.log(`[football-server] admin protected: ${adminToken ? "yes" : "no"}`);
  });
  startTimers();
});
