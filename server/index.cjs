const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const {
  TABLES,
  ensureDataStore,
  getDataStoreStatus,
  getHistoryMatchesForList,
  getLatestCurrentMatches,
  getLatestMatchById,
  getMatchTimeline,
  persistDataSnapshot,
  readOddsHistoryRows,
  readDataStoreRows
} = require("./dataStore.cjs");
const {
  getSqliteStatus,
  readSqliteCurrentMatches,
  readSqliteHistoryMatchesForList,
  readSqliteMatchById,
  readSqliteOddsHistoryRows
} = require("./sqliteStore.cjs");
const { acquireSyncLock } = require("./syncLock.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");
const distDir = path.join(rootDir, "dist");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const sqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"));
const snapshotsDir = path.join(storeDir, "snapshots");
const trainingIndexPaths = [
  path.join(storeDir, "training", "historical-training-index.json"),
  path.join(rootDir, "server-data", "training", "historical-training-index.json")
];

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "0.0.0.0";
const syncIntervalSeconds = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS || 300));
const gptIntervalSeconds = Math.max(300, Number(process.env.GPT_INTERVAL_SECONDS || 900));
const llmReviewPromptVersion = "llm-risk-review-v1";
const snapshotRetentionDays = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS || 14));
const enableFullHistoryFileFallback = process.env.ENABLE_FULL_HISTORY_FILE_FALLBACK === "1" || process.env.NODE_ENV !== "production";
const datastoreCompactOnSync = process.env.DATASTORE_COMPACT_ON_SYNC !== "0";
const datastoreCompactIntervalMs = Math.max(5, Number(process.env.DATASTORE_COMPACT_INTERVAL_MINUTES || 60)) * 60 * 1000;
const datastoreReadSource = String(process.env.DATASTORE_READ_SOURCE || "").toLowerCase();
const sqliteExportOnSync = process.env.ENABLE_SQLITE_EXPORT === "1"
  || datastoreReadSource === "sqlite"
  || process.env.CURRENT_MATCH_SOURCE === "sqlite";
const currentMatchDbMaxStaleMs = Math.max(5, Number(process.env.CURRENT_MATCH_DB_MAX_STALE_SECONDS || 30)) * 1000;
const sqliteReadStatusCacheMs = Math.max(100, Number(process.env.SQLITE_READ_STATUS_CACHE_MS || 1000));
const adminToken = process.env.ADMIN_TOKEN || "";
const allowLocalAdmin = process.env.ALLOW_LOCAL_ADMIN === "1";
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const accessCodeTtlSeconds = Math.max(60, Number(process.env.ACCESS_CODE_TTL_SECONDS || 6 * 60 * 60));
const accessCodeSecret = process.env.ACCESS_CODE_SECRET
  || process.env.ACCESS_SESSION_SECRET
  || adminToken
  || "football-predict-local-access-secret";
const accessCodesFile = path.join(storeDir, "access-codes.json");
const publicApiBase = process.env.PUBLIC_DATA_API_BASE || "/api";
const publicApiV1Base = process.env.PUBLIC_DATA_API_V1_BASE
  || (publicApiBase.replace(/\/+$/, "") === "/api" ? "/api/v1" : publicApiBase);
const enable500Sync = process.env.ENABLE_500_SYNC !== "0";
const enable500DetailsSync = process.env.ENABLE_500_DETAILS_SYNC === "1";
const enableWeatherSync = process.env.ENABLE_WEATHER_SYNC !== "0";
const enableApiFootballSync = process.env.ENABLE_API_FOOTBALL_SYNC === "1";
const enablePreMatchSignalsSync = process.env.ENABLE_PREMATCH_SIGNALS_SYNC !== "0";
const requireExternalSignals = process.env.REQUIRE_EXTERNAL_SIGNALS !== "0";
const historicalLookbackDays = 365;

const apiFiles = {
  "/api/sync-meta": path.join(dataDir, "sync-meta.json"),
  "/api/matches/history": path.join(dataDir, "matches-history.json"),
  "/api/matches/root": path.join(publicDir, "matches.json"),
  "/api/odds/history": path.join(dataDir, "odds-history.json"),
  "/api/predictions/snapshots": path.join(dataDir, "prediction-snapshots.json"),
  "/api/predictions/gpt": path.join(dataDir, "gpt-predictions.json"),
  "/api/model/calibration": path.join(dataDir, "model-calibration.json"),
  "/api/model/strategy": path.join(dataDir, "model-strategy.json"),
  "/api/teams/index": path.join(dataDir, "team-index.json"),
  "/api/data/external-signals": path.join(dataDir, "external-signals.json"),
  "/api/data/five-hundred-details": path.join(dataDir, "five-hundred-details.json"),
  "/api/data/pre-match-signals": path.join(dataDir, "pre-match-signals.json"),
  "/api/data/api-football": path.join(dataDir, "api-football-meta.json")
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
let lastDataPersist = null;
let lastDataCompact = null;
const sseClients = new Set();
let historyListCache = null;
let currentMatchesCache = null;
let sourceHealthCache = null;
const v1CurrentPayloadCache = new Map();
const v1CurrentPayloadInflight = new Map();
const v1HistoryPayloadCache = new Map();
const v1HistoryPayloadInflight = new Map();
const v1MatchPayloadCache = new Map();
const v1MatchPayloadInflight = new Map();
let lastCurrentRead = null;
let sqliteReadStatusCache = null;
let sqliteReadStatusInflight = null;

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
  await ensureDataStore(storeDir);
};

const readJsonFile = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const fileMtimeMs = async (filePath) => {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
};

const writeJsonFile = async (filePath, data) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const safeSecretEqual = (actual, expected) => {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
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

const writeSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const broadcastEvent = (event) => {
  for (const res of Array.from(sseClients)) {
    try {
      writeSse(res, event.type || "message", event);
    } catch {
      sseClients.delete(res);
    }
  }
};

const appendEvent = async (event) => {
  await ensureStore();
  const row = {
    id: crypto.randomUUID(),
    at: nowIso(),
    ...event
  };
  try {
    await fsp.appendFile(path.join(storeDir, "events.jsonl"), `${JSON.stringify(row)}\n`);
  } catch (error) {
    console.warn("[football-server] failed to append event log", {
      code: error?.code,
      message: error?.message || String(error)
    });
  }
  broadcastEvent(row);
  return row;
};

const isCompressibleType = (contentType = "") => {
  return /^(text\/|application\/json|application\/javascript|image\/svg\+xml)/i.test(contentType);
};

const HISTORICAL_TEAM_ALIASES = Object.freeze({
  "阿根廷": "argentina",
  "冰岛": "iceland",
  "葡萄牙": "portugal",
  "尼日利亚": "nigeria",
  "英格兰": "england",
  "哥斯达": "costa rica",
  "哥斯达黎加": "costa rica",
  "墨西哥": "mexico",
  "南非": "south africa",
  "韩国": "south korea",
  "捷克": "czech republic",
  "加拿大": "canada",
  "波黑": "bosnia and herzegovina",
  "美国": "united states",
  "巴拉圭": "paraguay",
  "卡塔尔": "qatar",
  "瑞士": "switzerland",
  "巴西": "brazil",
  "摩洛哥": "morocco",
  "海地": "haiti",
  "苏格兰": "scotland",
  "澳大利亚": "australia",
  "土耳其": "turkey",
  "德国": "germany",
  "库拉索": "curacao",
  "荷兰": "netherlands",
  "日本": "japan",
  "瑞典": "sweden",
  "突尼斯": "tunisia",
  "西班牙": "spain",
  "佛得角": "cape verde",
  "比利时": "belgium",
  "埃及": "egypt",
  "沙特": "saudi arabia",
  "沙特阿拉伯": "saudi arabia",
  "乌拉圭": "uruguay",
  "伊朗": "iran",
  "新西兰": "new zealand",
  "丹麦": "denmark",
  "塞内加尔": "senegal",
  "哥伦比亚": "colombia",
  "克罗地亚": "croatia",
  "法国": "france",
  "加纳": "ghana",
  "挪威": "norway",
  "喀麦隆": "cameroon",
  "意大利": "italy",
  "洪都拉斯": "honduras",
  "智利": "chile",
  "牙买加": "jamaica",
  "波兰": "poland",
  "阿尔及利亚": "algeria",
  "中国": "china",
  "泰国": "thailand",
  "匈牙利": "hungary",
  "哈萨": "kazakhstan",
  "哈萨克": "kazakhstan",
  "哈萨克斯坦": "kazakhstan",
  "塞尔维亚": "serbia",
  "玻利": "bolivia",
  "玻利维亚": "bolivia",
  "厄瓜多尔": "ecuador",
  "巴拿马": "panama",
  "乌克兰": "ukraine",
  "奥地利": "austria",
  "伊拉克": "iraq",
  "约旦": "jordan",
  "秘鲁": "peru",
  "委内": "venezuela",
  "委内瑞拉": "venezuela",
  "罗马尼亚": "romania",
  "斯洛伐克": "slovakia",
  "斯洛文尼亚": "slovenia",
  "北马其顿": "north macedonia",
  "黑山": "montenegro",
  "爱尔兰": "ireland",
  "北爱尔兰": "northern ireland",
  "威尔士": "wales",
  "芬兰": "finland",
  "希腊": "greece"
});

const HISTORICAL_NAME_ZH = Object.freeze(Object.entries(HISTORICAL_TEAM_ALIASES)
  .reduce((acc, [zh, key]) => {
    if (!acc[key] || zh.length > acc[key].length) acc[key] = zh;
    return acc;
  }, {}));

const normalizeHistoricalTeamKey = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const titleCaseTeam = (value) => String(value || "")
  .split(/\s+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

let trainingIndexCache = null;
let trainingIndexCachePath = "";

const readTrainingIndex = async () => {
  for (const filePath of trainingIndexPaths) {
    try {
      const stat = await fsp.stat(filePath);
      if (
        trainingIndexCache &&
        trainingIndexCachePath === filePath &&
        trainingIndexCache.mtimeMs === stat.mtimeMs
      ) {
        return trainingIndexCache.data;
      }
      const data = JSON.parse(await fsp.readFile(filePath, "utf8"));
      trainingIndexCache = { data, mtimeMs: stat.mtimeMs };
      trainingIndexCachePath = filePath;
      return data;
    } catch {
      // Try the next location.
    }
  }
  return null;
};

const resolveHistoricalKey = (index, ...values) => {
  const fileAliases = index?.teamAliases?.aliases && typeof index.teamAliases.aliases === "object"
    ? index.teamAliases.aliases
    : {};

  for (const value of values) {
    const normalized = normalizeHistoricalTeamKey(value);
    if (!normalized) continue;
    const mapped = fileAliases[normalized] || HISTORICAL_TEAM_ALIASES[value] || HISTORICAL_TEAM_ALIASES[normalized] || normalized;
    if (index?.teams?.[mapped]) return mapped;
  }

  return "";
};

const historicalName = (key, locale = "en") => {
  if (locale === "zh") return HISTORICAL_NAME_ZH[key] || titleCaseTeam(key);
  return titleCaseTeam(key);
};

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const formatShanghaiDateFromTime = (time) => {
  if (!Number.isFinite(time)) return "";
  const parts = shanghaiDateFormatter.formatToParts(new Date(time))
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const normalizeTrainingRow = (row, currentMatch) => {
  const date = String(row.kickoffTime || "").slice(0, 10);
  return {
    id: `training_${row.homeKey}_${row.awayKey}_${date}_${row.scoreHome}_${row.scoreAway}`.replace(/[^a-z0-9_-]+/gi, "_"),
    source: row.source || "historical-training",
    division: row.division,
    tournament: row.tournament || row.division || "Historical",
    neutral: Boolean(row.neutral),
    kickoffTime: row.kickoffTime,
    date,
    homeKey: row.homeKey,
    awayKey: row.awayKey,
    homeName: historicalName(row.homeKey, "en"),
    awayName: historicalName(row.awayKey, "en"),
    homeNameZh: historicalName(row.homeKey, "zh"),
    awayNameZh: historicalName(row.awayKey, "zh"),
    scoreHome: row.scoreHome,
    scoreAway: row.scoreAway,
    relativeTo: currentMatch?.id
  };
};

const buildHistoricalTeamRows = (index, teamKey, currentMatch) => {
  const cutoffTime = Date.parse(currentMatch?.kickoffTime || "");
  if (!teamKey || !Number.isFinite(cutoffTime)) return [];
  const startTime = cutoffTime - historicalLookbackDays * 24 * 60 * 60 * 1000;
  const recent = Array.isArray(index?.teams?.[teamKey]?.recent) ? index.teams[teamKey].recent : [];

  return recent
    .filter((row) => Number.isFinite(Date.parse(row.kickoffTime || "")))
    .filter((row) => {
      const time = Date.parse(row.kickoffTime);
      return time <= cutoffTime && time >= startTime;
    })
    .sort((a, b) => Date.parse(b.kickoffTime) - Date.parse(a.kickoffTime))
    .map((row) => normalizeTrainingRow(row, currentMatch));
};

const enrichMatchHistoricalTraining = async (match) => {
  const index = await readTrainingIndex();
  if (!match || !index?.teams) return match;

  const homeKey = resolveHistoricalKey(index, match.homeTeamNameEn, match.homeTeamName);
  const awayKey = resolveHistoricalKey(index, match.awayTeamNameEn, match.awayTeamName);
  if (!homeKey && !awayKey) return match;

  const cutoffTime = Date.parse(match.kickoffTime || "");
  const startTime = Number.isFinite(cutoffTime)
    ? cutoffTime - historicalLookbackDays * 24 * 60 * 60 * 1000
    : NaN;
  const homeRows = buildHistoricalTeamRows(index, homeKey, match);
  const awayRows = buildHistoricalTeamRows(index, awayKey, match);
  const h2hById = new Map();
  [...homeRows, ...awayRows].forEach((row) => {
    if (!homeKey || !awayKey) return;
    const teams = new Set([row.homeKey, row.awayKey]);
    if (teams.has(homeKey) && teams.has(awayKey)) h2hById.set(row.id, row);
  });
  const h2hRows = Array.from(h2hById.values())
    .sort((a, b) => Date.parse(b.kickoffTime) - Date.parse(a.kickoffTime));

  return {
    ...match,
    historicalTrainingDetail: {
      version: index.version,
      source: index.source?.name || index.source || "historical-training",
      rows: index.sample?.rows,
      lastMatchDate: index.sample?.lastMatchDate,
      windowDays: historicalLookbackDays,
      windowStart: formatShanghaiDateFromTime(startTime),
      windowEnd: formatShanghaiDateFromTime(cutoffTime),
      homeKey,
      awayKey,
      home: {
        key: homeKey,
        name: historicalName(homeKey, "en"),
        nameZh: historicalName(homeKey, "zh"),
        rows: homeRows
      },
      away: {
        key: awayKey,
        name: historicalName(awayKey, "en"),
        nameZh: historicalName(awayKey, "zh"),
        rows: awayRows
      },
      h2h: {
        rows: h2hRows
      }
    }
  };
};

const encodeBody = (res, status, body, headers) => {
  if (status === 204 || status === 304) return { body, headers };

  const request = res.__request;
  const method = request?.method || "GET";
  const acceptEncoding = String(request?.headers?.["accept-encoding"] || "");
  const contentType = headers["content-type"] || headers["Content-Type"] || "";
  const source = Buffer.isBuffer(body) ? body : Buffer.from(String(body));

  if (
    method !== "HEAD"
    && source.length >= 1024
    && !headers["content-encoding"]
    && isCompressibleType(contentType)
    && /\bgzip\b/i.test(acceptEncoding)
  ) {
    return {
      body: zlib.gzipSync(source),
      headers: {
        ...headers,
        "content-encoding": "gzip",
        "vary": "Accept-Encoding"
      }
    };
  }

  return { body: source, headers };
};

const send = (res, status, body, headers = {}) => {
  const encoded = encodeBody(res, status, body, headers);
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, if-none-match, x-access-token",
    "access-control-expose-headers": "cache-control, etag",
    "cache-control": "no-store",
    ...encoded.headers
  });
  res.end(res.__request?.method === "HEAD" ? undefined : encoded.body);
};

const sendJson = (res, payload, status = 200, headers = {}) => {
  send(res, status, JSON.stringify(payload), {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
};

const etagForJson = (body) => {
  return `"sha256-${crypto.createHash("sha256").update(body).digest("base64url")}"`;
};

const sendJsonCached = (req, res, payload, options = {}) => {
  const body = JSON.stringify(payload);
  const etag = etagForJson(body);
  const maxAgeSeconds = Math.max(0, Number(options.maxAgeSeconds || 0));
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": maxAgeSeconds > 0
      ? `private, max-age=${maxAgeSeconds}, must-revalidate`
      : "no-store",
    etag,
    ...options.headers
  };
  if (req.headers["if-none-match"] === etag) {
    return send(res, 304, "", headers);
  }
  return send(res, options.status || 200, body, headers);
};

const getStaticCacheControl = (filePath, ext) => {
  if (ext === ".html") return "no-store";
  const distRelative = path.relative(distDir, filePath).replace(/\\/g, "/");
  if (distRelative.startsWith("assets/")) return "public, max-age=31536000, immutable";
  if (filePath.startsWith(dataDir) || ext === ".json") return "no-store";
  return "public, max-age=3600";
};

const handleEventStream = (req, res) => {
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });
  writeSse(res, "hello", {
    ok: true,
    service: "football-predict-server",
    at: nowIso(),
    syncRunning,
    lastSync
  });
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      writeSse(res, "heartbeat", { at: nowIso(), syncRunning });
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
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
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  void url;
  return safeSecretEqual(bearer, adminToken);
};

const isAccessCodeAdminAuthorized = (req, url) => {
  if (!accessCodeAdminToken) return false;
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  void url;
  return safeSecretEqual(bearer, accessCodeAdminToken);
};

const accessCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const normalizeAccessCode = (value) => String(value || "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "")
  .slice(0, 12);

const formatAccessCode = (value) => normalizeAccessCode(value)
  .replace(/(.{4})/g, "$1-")
  .replace(/-$/, "");

const generateAccessCodeText = () => {
  let value = "";
  for (let index = 0; index < 12; index += 1) {
    value += accessCodeAlphabet[crypto.randomInt(0, accessCodeAlphabet.length)];
  }
  return formatAccessCode(value);
};

const hmacText = (value, encoding = "hex") => crypto
  .createHmac("sha256", accessCodeSecret)
  .update(String(value))
  .digest(encoding);

const hashAccessCode = (code) => hmacText(normalizeAccessCode(code));

const readAccessCodeStore = async () => {
  const store = await readJsonFile(accessCodesFile, { version: 1, codes: [] });
  return {
    version: 1,
    codes: Array.isArray(store?.codes) ? store.codes : []
  };
};

const writeAccessCodeStore = async (store) => {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const codes = store.codes
    .filter((code) => {
      const expiresAt = Date.parse(code.expiresAt || "");
      return !Number.isFinite(expiresAt) || expiresAt >= cutoff;
    })
    .slice(0, 500);
  await writeJsonFile(accessCodesFile, { version: 1, codes });
};

const getAccessCodeStatus = (record, now = Date.now()) => {
  if (record?.revokedAt) return "revoked";
  const expiresAt = Date.parse(record?.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
  return "active";
};

const publicAccessCodeRecord = (record) => ({
  id: record.id,
  label: record.label || "",
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  revokedAt: record.revokedAt || null,
  usedAt: record.usedAt || record.lastUsedAt || null,
  lastUsedAt: record.lastUsedAt || record.usedAt || null,
  usedCount: Number.isFinite(Number(record.usedCount)) ? Number(record.usedCount) : (record.usedAt ? 1 : 0),
  ttlSeconds: record.ttlSeconds || accessCodeTtlSeconds,
  status: getAccessCodeStatus(record)
});

const createAccessCode = async ({ label = "" } = {}) => {
  const now = Date.now();
  const code = generateAccessCodeText();
  const record = {
    id: crypto.randomUUID(),
    label: String(label || "").trim().slice(0, 80),
    codeHash: hashAccessCode(code),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + accessCodeTtlSeconds * 1000).toISOString(),
    ttlSeconds: accessCodeTtlSeconds
  };
  const store = await readAccessCodeStore();
  store.codes.unshift(record);
  await writeAccessCodeStore(store);
  return {
    ...publicAccessCodeRecord(record),
    code
  };
};

const listAccessCodes = async () => {
  const store = await readAccessCodeStore();
  return store.codes.map(publicAccessCodeRecord);
};

const revokeAccessCode = async (id) => {
  const codeId = String(id || "").trim();
  if (!codeId) return { ok: false, error: "access code id required", status: 400 };

  const store = await readAccessCodeStore();
  const record = store.codes.find((item) => item.id === codeId);
  if (!record) return { ok: false, error: "access code not found", status: 404 };

  if (!record.revokedAt) {
    record.revokedAt = nowIso();
    await writeAccessCodeStore(store);
  }

  return { ok: true, row: publicAccessCodeRecord(record) };
};

const signAccessSession = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmacText(encoded, "base64url")}`;
};

const readAccessSession = (token) => {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return null;
  const expected = hmacText(encoded, "base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  const payload = safeJsonParse(Buffer.from(encoded, "base64url").toString("utf8"), null);
  if (!payload || payload.scope !== "recommendations") return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
  return payload;
};

const createAccessSession = (record) => {
  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiresAt);
  const payload = {
    scope: "recommendations",
    sub: record.id,
    iat: now,
    exp: expiresAtMs
  };
  return {
    token: signAccessSession(payload),
    issuedAt: new Date(now).toISOString(),
    expiresAt: record.expiresAt,
    codeId: record.id
  };
};

const getRequestAccessToken = (req, url) => {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return req.headers["x-access-token"] || url.searchParams.get("access_token") || "";
};

const getRequestAccessSession = (req, url) => readAccessSession(getRequestAccessToken(req, url));

const getActiveRequestAccessSession = async (req, url) => {
  const session = getRequestAccessSession(req, url);
  if (!session?.sub) return null;
  const store = await readAccessCodeStore();
  const record = store.codes.find((item) => item.id === session.sub);
  return record && getAccessCodeStatus(record) === "active" ? session : null;
};

const hasRecommendationAccess = async (req, url) => Boolean(await getActiveRequestAccessSession(req, url));

const verifyAccessCode = async (code) => {
  const normalizedCode = normalizeAccessCode(code);
  if (!normalizedCode) {
    return { ok: false, error: "access code required", status: 400 };
  }

  const codeHash = hashAccessCode(normalizedCode);
  const store = await readAccessCodeStore();
  const record = store.codes.find((item) => item.codeHash === codeHash);
  if (!record) {
    return { ok: false, error: "invalid access code", status: 401 };
  }

  const status = getAccessCodeStatus(record);
  if (status !== "active") {
    return { ok: false, error: `access code ${status}`, status: 401 };
  }

  const usedAt = nowIso();
  record.usedAt = record.usedAt || usedAt;
  record.lastUsedAt = usedAt;
  record.usedCount = (Number(record.usedCount) || 0) + 1;
  await writeAccessCodeStore(store);

  return {
    ok: true,
    session: createAccessSession(record),
    code: publicAccessCodeRecord(record)
  };
};

const protectedApiPaths = new Set([
  "/api/matches/current",
  "/api/matches/history",
  "/api/matches/root",
  "/api/odds/history",
  "/api/predictions/snapshots",
  "/api/predictions/gpt",
  "/api/model/calibration",
  "/api/model/strategy",
  "/api/data/external-signals",
  "/api/data/five-hundred-details",
  "/api/data/pre-match-signals",
  "/api/data/api-football",
  "/api/analytics/summary"
]);

const isProtectedApiPath = (pathname) => {
  if (protectedApiPaths.has(pathname)) return true;
  if (pathname === "/api/v1/matches/current") return true;
  if (pathname === "/api/v1/matches/history") return true;
  if (pathname === "/api/v1/odds/history") return true;
  if (/^\/api\/v1\/matches\/[^/]+$/.test(pathname)) return true;
  return /^\/api\/matches\/[^/]+(?:\/timeline)?$/.test(pathname);
};

const isProtectedStaticDataPath = (pathname) => {
  const normalized = pathname.replace(/\\/g, "/");
  if (normalized === "/data/runtime-config.json") return false;
  if (normalized === "/matches.json" || normalized === "/odds-history.json") return true;
  return normalized.startsWith("/data/") && normalized.endsWith(".json");
};

const runCommand = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
    stdio: ["ignore", "inherit", "inherit"]
  });

  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolve({ stdout: "", stderr: "" });
    else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
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

const parseShanghaiDateTime = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    return Date.parse(`${raw.replace(/\s+/, "T")}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(`${raw}+08:00`);
  }
  return Date.parse(raw);
};

const maybeCompactDataStore = async (npmCommand, source) => {
  if (!datastoreCompactOnSync) return null;
  const now = Date.now();
  const previous = Date.parse(lastDataCompact?.finishedAt || "");
  if (Number.isFinite(previous) && now - previous < datastoreCompactIntervalMs) {
    return { ok: true, skipped: true, reason: "compact interval not reached", lastDataCompact };
  }
  const startedAt = nowIso();
  try {
    await runCommand(npmCommand, ["run", "compact:datastore"], {
      DATA_STORE_DIR: storeDir,
      FOOTBALL_STORE_DIR: storeDir
    });
    lastDataCompact = { ok: true, source, startedAt, finishedAt: nowIso() };
    await appendEvent({ type: "datastore_compacted", ...lastDataCompact });
    return lastDataCompact;
  } catch (error) {
    lastDataCompact = {
      ok: false,
      source,
      startedAt,
      finishedAt: nowIso(),
      error: error.message || String(error)
    };
    await appendEvent({ type: "datastore_compact_failed", ...lastDataCompact });
    return lastDataCompact;
  }
};

const maybeExportSqlite = async (npmCommand, source) => {
  if (!sqliteExportOnSync) return null;
  const startedAt = nowIso();
  try {
    await runCommand(npmCommand, ["run", "datastore:sqlite"], {
      SERVER_STORE_DIR: storeDir,
      DATASTORE_SQLITE_PATH: sqliteDbPath
    });
    const result = { ok: true, source, startedAt, finishedAt: nowIso(), dbPath: sqliteDbPath };
    await appendEvent({ type: "sqlite_exported", ...result });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      source,
      startedAt,
      finishedAt: nowIso(),
      dbPath: sqliteDbPath,
      error: error.message || String(error)
    };
    await appendEvent({ type: "sqlite_export_failed", ...result });
    return result;
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
  let syncLock = null;
  try {
    syncLock = await acquireSyncLock({
      owner: "football-api-sync",
      source,
      waitMs: Number(process.env.API_SYNC_LOCK_WAIT_MS || 0)
    });
    if (!syncLock.acquired) {
      lastSync = {
        ok: true,
        skipped: true,
        reason: syncLock.reason,
        source,
        startedAt,
        finishedAt: nowIso(),
        lock: {
          owner: syncLock.info?.owner || null,
          source: syncLock.info?.source || null,
          pid: syncLock.info?.pid || null,
          startedAt: syncLock.info?.startedAt || null,
          ageMs: Math.round(syncLock.ageMs || 0)
        }
      };
      await appendEvent({ type: "sync_skipped", ...lastSync });
      return lastSync;
    }
    await appendEvent({ type: "sync_started", source });
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    if (enable500Sync) {
      await runCommand(npmCommand, ["run", "sync:500"]);
    }
    if (enable500DetailsSync) {
      await runCommand(npmCommand, ["run", "sync:500:details"]);
    }
    if (enableWeatherSync) {
      await runCommand(npmCommand, ["run", "sync:weather"]);
    }
    if (enableApiFootballSync) {
      await runCommand(npmCommand, ["run", "sync:api-football"]);
    }
    if (enablePreMatchSignalsSync) {
      await runCommand(npmCommand, ["run", "sync:prematch"]);
    }
    const syncEnv = {
      PAGE_POLL_SECONDS: process.env.PAGE_POLL_SECONDS || "20",
      SYNC_WORKFLOW_MINUTES: String(Math.max(1, Math.round(syncIntervalSeconds / 60)))
    };
    if (process.env.SKIP_SPORTTERY_FETCH === "1") {
      syncEnv.SKIP_SPORTTERY_FETCH = "1";
    }
    await runCommand("node", ["scripts/syncData.cjs"], {
      ...syncEnv
    });
    await runCommand(npmCommand, ["run", "validate:data"]);
    await runCommand(npmCommand, ["run", "validate:sources"], {
      REQUIRE_EXTERNAL_SIGNALS: requireExternalSignals ? "1" : "0"
    });
    await captureCurrentSnapshot(source);
    const sourceHealth = await getSourceHealth().catch((error) => ({
      ok: false,
      error: error.message || String(error)
    }));
    lastDataPersist = await persistDataSnapshot({
      storeDir,
      dataDir,
      source,
      sourceHealth
    });
    const dataCompact = await maybeCompactDataStore(npmCommand, source);
    const sqliteExport = await maybeExportSqlite(npmCommand, source);
    const syncOk = sqliteExport?.ok !== false;
    lastSync = { ok: syncOk, source, startedAt, finishedAt: nowIso(), dataStore: lastDataPersist, dataCompact, sqliteExport };
    await appendEvent({ type: syncOk ? "sync_completed" : "sync_completed_with_warnings", ...lastSync });
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
    if (syncLock?.release) await syncLock.release();
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

const buildLlmReviewPrompt = (match) => {
  return [
    "You are a second-pass football risk reviewer. Use only the pre-match data below.",
    "Do not create or override probabilities, picks, odds, model outputs, or recommendation direction.",
    "Your job is limited to risk review, tier-adjustment advice, explanation text, and missing-data flags.",
    "Return strict JSON only. Required fields: riskReview{level,tags,summary,notes[]}, tierAdjustment{direction,maxDelta,reason}, explanation{zh,en}, missingData[], auditNotes[].",
    "Allowed tierAdjustment.direction values: none, down, up, watchOnly. maxDelta must be -1, 0, or 1.",
    "If data is weak, prefer direction=down or watchOnly. Never output probabilities, recommendation, predictions, or probabilityModel.",
    `Match: ${match.homeTeamName || match.homeTeamId} vs ${match.awayTeamName || match.awayTeamId}`,
    `League: ${match.leagueName || match.leagueId}`,
    `Kickoff: ${match.kickoffTime}`,
    `Cutoff: ${match.predictionMeta?.cutoffTime || match.buyEndTime || "unknown"}`,
    `Status: ${match.status}`,
    `Official odds: ${summarizeOdds(match)}`,
    `Existing algorithm predictions: ${JSON.stringify(match.predictions || []).slice(0, 2500)}`,
    `Algorithm probability model: ${JSON.stringify(match.probabilityModel || null).slice(0, 2500)}`,
    `Pre-match context sample: ${JSON.stringify({
      recentForm: match.recentForm,
      h2h: match.h2h,
      standings: match.standings,
      stats: match.stats,
      externalSignals: match.externalSignals
    }).slice(0, 3500)}`
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
        { role: "user", content: buildLlmReviewPrompt(match) }
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

const textOrNull = (value, maxLength = 1200) => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
};

const stringList = (value, maxItems = 8, maxLength = 180) => {
  const source = Array.isArray(value) ? value : (value ? [value] : []);
  return source
    .map((item) => textOrNull(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
};

const normalizeRiskLevel = (value) => {
  const risk = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high", "critical"].includes(risk)) return risk;
  if (["watch", "watchonly", "watch-only"].includes(risk)) return "medium";
  return "unknown";
};

const normalizeTierDirection = (value) => {
  const direction = String(value || "").trim().toLowerCase();
  if (["up", "increase", "promote"].includes(direction)) return "up";
  if (["down", "decrease", "demote"].includes(direction)) return "down";
  if (["watch", "watchonly", "watch-only"].includes(direction)) return "watchOnly";
  return "none";
};

const predictionAuditSignature = (match) => {
  const payload = {
    predictions: Array.isArray(match?.predictions)
      ? match.predictions.map((prediction) => ({
        marketType: prediction.marketType,
        oddsPoolCode: prediction.oddsPoolCode,
        tipCode: prediction.tipCode,
        recommendationTier: prediction.recommendationTier,
        recommendationAction: prediction.recommendationAction
      }))
      : [],
    probabilityModelVersion: match?.probabilityModel?.version || null,
    oneXTwoFinal: match?.probabilityModel?.oneXTwo?.final || null,
    handicapFinal: match?.probabilityModel?.handicap?.final || null,
    lockedAt: match?.predictionMeta?.lockedAt || null,
    cutoffTime: match?.predictionMeta?.cutoffTime || match?.buyEndTime || null
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
};

const llmReviewCutoffValue = (match) => (
  match?.predictionMeta?.cutoffTime
  || match?.buyEndTime
  || match?.externalSignals?.buyEndTime
  || match?.externalSignals?.fiveHundred?.sale?.buyEndTime
  || match?.kickoffTime
  || ""
);

const llmReviewCutoffMs = (match) => parseShanghaiDateTime(llmReviewCutoffValue(match));

const llmReviewWindowOpen = (match, nowMs = Date.now()) => {
  const cutoffMs = llmReviewCutoffMs(match);
  return Number.isFinite(cutoffMs) && Number.isFinite(nowMs) && nowMs < cutoffMs;
};

const gptReviewRowAllowed = (row, match = null) => {
  const generatedMs = Date.parse(row?.generatedAt || "");
  const cutoffMs = parseShanghaiDateTime(
    row?.llmReview?.audit?.cutoffTime
    || llmReviewCutoffValue(match)
    || row?.cutoffTime
    || row?.kickoffTime
  );
  if (Number.isFinite(generatedMs) && Number.isFinite(cutoffMs) && generatedMs > cutoffMs) return false;
  if (match && row?.llmReview?.audit?.sourcePredictionSignature) {
    return row.llmReview.audit.sourcePredictionSignature === predictionAuditSignature(match);
  }
  return true;
};

const normalizeLlmReview = (match, relayResult, generatedAt) => {
  const parsed = relayResult?.parsed && typeof relayResult.parsed === "object" ? relayResult.parsed : {};
  const deniedOutputFields = ["probabilities", "recommendation", "predictions", "probabilityModel", "odds"]
    .filter((field) => Object.prototype.hasOwnProperty.call(parsed, field));
  const riskSource = parsed.riskReview && typeof parsed.riskReview === "object" ? parsed.riskReview : {};
  const tierSource = parsed.tierAdjustment && typeof parsed.tierAdjustment === "object" ? parsed.tierAdjustment : {};
  const explanationSource = parsed.explanation && typeof parsed.explanation === "object" ? parsed.explanation : {};
  const fallbackSummary = textOrNull(parsed.summary || riskSource.summary || relayResult?.reason, 500);
  const direction = normalizeTierDirection(tierSource.direction);
  const requestedDelta = Number(tierSource.maxDelta);
  const maxDelta = direction === "up"
    ? Math.min(1, Math.max(0, Number.isFinite(requestedDelta) ? requestedDelta : 0))
    : direction === "down" || direction === "watchOnly"
      ? Math.max(-1, Math.min(0, Number.isFinite(requestedDelta) ? requestedDelta : -1))
      : 0;

  return {
    version: llmReviewPromptVersion,
    reviewRole: "llm-risk-review",
    generatedAt,
    ok: Boolean(relayResult?.ok),
    skipped: Boolean(relayResult?.skipped),
    model: relayResult?.model || null,
    riskReview: {
      level: normalizeRiskLevel(riskSource.level || parsed.risk || parsed.recommendation?.risk),
      tags: stringList(riskSource.tags || parsed.riskTags || parsed.missingData, 8, 60),
      summary: textOrNull(riskSource.summary || parsed.summary || parsed.reviewPlan, 500),
      notes: stringList(riskSource.notes || parsed.reasons || parsed.auditNotes, 8, 240)
    },
    tierAdjustment: {
      direction,
      maxDelta,
      reason: textOrNull(tierSource.reason || parsed.reviewPlan || fallbackSummary, 500),
      canChangeRecommendationDirection: false,
      canChangeProbabilities: false
    },
    explanation: {
      zh: textOrNull(explanationSource.zh || explanationSource.cn || fallbackSummary, 700),
      en: textOrNull(explanationSource.en || fallbackSummary, 700)
    },
    missingData: stringList(parsed.missingData || riskSource.missingData, 10, 160),
    audit: {
      promptVersion: llmReviewPromptVersion,
      allowedOutputs: ["riskReview", "tierAdjustment", "explanation", "missingData", "auditNotes"],
      deniedOutputFields,
      canOverrideProbabilities: false,
      canOverrideRecommendationDirection: false,
      sourceProbabilityModelVersion: match?.probabilityModel?.version || null,
      sourcePredictionSignature: predictionAuditSignature(match),
      cutoffTime: match?.predictionMeta?.cutoffTime || match?.buyEndTime || null,
      lockedAt: match?.predictionMeta?.lockedAt || null,
      generatedBeforeCutoff: llmReviewWindowOpen(match, Date.parse(generatedAt || ""))
    },
    schemaWarnings: deniedOutputFields.length
      ? [`Relay returned denied fields: ${deniedOutputFields.join(", ")}`]
      : []
  };
};

const publicGptPrediction = (row) => {
  if (!row || typeof row !== "object") return null;
  return {
    matchId: row.matchId || null,
    generatedAt: row.generatedAt || null,
    source: row.source || null,
    reviewRole: row.reviewRole || row.llmReview?.reviewRole || "llm-risk-review",
    llmReview: row.llmReview || null
  };
};

const readGptPredictions = async () => readJsonFile(path.join(dataDir, "gpt-predictions.json"), {
  version: 2,
  source: "llm-risk-review",
  updatedAt: null,
  rows: []
});

const writeGptPredictions = async (rows) => {
  const payload = {
    version: 2,
    source: "llm-risk-review",
    promptVersion: llmReviewPromptVersion,
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
    const matchById = new Map(matches.map((match) => [match.id, match]));
    const eligibleBeforeLimit = matches
      .filter((match) => match.status === "SCHEDULED")
      .filter((match) => matchIds.length === 0 || matchIds.includes(match.id))
      .filter((match) => Date.parse(match.kickoffTime || "") > now);
    const skippedAfterCutoff = eligibleBeforeLimit.filter((match) => !llmReviewWindowOpen(match, now));
    const candidates = matches
      .filter((match) => match.status === "SCHEDULED")
      .filter((match) => matchIds.length === 0 || matchIds.includes(match.id))
      .filter((match) => Date.parse(match.kickoffTime || "") > now)
      .filter((match) => llmReviewWindowOpen(match, now))
      .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""))
      .slice(0, Math.max(1, Number(limit || 8)));

    const existing = await readGptPredictions();
    const validExistingRows = (existing.rows || []).filter((row) => {
      const match = matchById.get(row.matchId);
      return match && gptReviewRowAllowed(row, match);
    });
    const removedRows = (existing.rows || []).length - validExistingRows.length;
    const rowsById = new Map(validExistingRows.map((row) => [row.matchId, row]));
    const results = [];

    for (const match of candidates) {
      const relayResult = await callGptRelay(match);
      const generatedAt = nowIso();
      const llmReview = normalizeLlmReview(match, relayResult, generatedAt);
      const row = {
        matchId: match.id,
        generatedAt,
        source,
        reviewRole: "llm-risk-review",
        leagueId: match.leagueId,
        leagueName: match.leagueName,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        kickoffTime: match.kickoffTime,
        status: match.status,
        llmReview,
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
    lastDataPersist = await persistDataSnapshot({
      storeDir,
      dataDir,
      source,
      sourceHealth: await getSourceHealth().catch((error) => ({
        ok: false,
        error: error.message || String(error)
      }))
    });
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const sqliteExport = await maybeExportSqlite(npmCommand, source);
    v1CurrentPayloadCache.clear();
    v1MatchPayloadCache.clear();
    const predictionOk = sqliteExport?.ok !== false;
    lastPredictionRun = {
      ok: predictionOk,
      source,
      startedAt,
      finishedAt: nowIso(),
      requested: candidates.length,
      skippedAfterCutoff: skippedAfterCutoff.length,
      removedInvalidRows: removedRows,
      generated: results.length,
      dataStore: lastDataPersist,
      sqliteExport
    };
    await appendEvent({ type: predictionOk ? "gpt_prediction_completed" : "gpt_prediction_completed_with_warnings", ...lastPredictionRun });
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

const mergeGptIntoMatches = async (matches) => {
  const gpt = await readGptPredictions();
  if (!Array.isArray(matches)) return matches;
  const byId = new Map((gpt.rows || []).map((row) => [row.matchId, row]));
  return matches.map((match) => {
    const gptPrediction = byId.get(match.id);
    return gptPrediction && gptReviewRowAllowed(gptPrediction, match)
      ? { ...match, gptPrediction: publicGptPrediction(gptPrediction) }
      : match;
  });
};

const readCurrentFileMatches = async () => {
  const filePath = path.join(dataDir, "matches-current.json");
  const mtimeMs = await fileMtimeMs(filePath);
  if (currentMatchesCache && currentMatchesCache.mtimeMs === mtimeMs) {
    return currentMatchesCache.matches;
  }

  const matches = await readJsonFile(filePath, []);
  currentMatchesCache = { mtimeMs, matches };
  return matches;
};

const currentMetaTime = (meta) => {
  for (const value of [meta?.api?.freshnessTime, meta?.updatedAt, meta?.capturedAt]) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const syncMetaDataVersionTime = (meta) => {
  for (const value of [meta?.updatedAt, meta?.capturedAt, meta?.api?.freshnessTime, meta?.lastAttemptAt]) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const shouldPreferSqliteRead = () => {
  return datastoreReadSource === "sqlite" || process.env.CURRENT_MATCH_SOURCE === "sqlite";
};

const getSqliteReadStatus = async (meta = null) => {
  const status = await getSqliteStatus(sqliteDbPath);
  const metaUpdatedTime = syncMetaDataVersionTime(meta);
  const sqliteUpdatedTime = Date.parse(status.syncMetaUpdatedAt || status.exportedAt || status.mtime || "");
  const stale = Boolean(status.available)
    && Number.isFinite(metaUpdatedTime)
    && (!Number.isFinite(sqliteUpdatedTime) || sqliteUpdatedTime + currentMatchDbMaxStaleMs < metaUpdatedTime);
  return {
    ...status,
    readSource: datastoreReadSource || process.env.CURRENT_MATCH_SOURCE || "default",
    stale,
    maxStaleSeconds: Math.round(currentMatchDbMaxStaleMs / 1000)
  };
};

const sqliteStatusMetaKey = (meta = null) => [
  meta?.updatedAt || "",
  meta?.capturedAt || "",
  meta?.api?.freshnessTime || "",
  meta?.lastAttemptAt || ""
].join("|");

const getCachedSqliteReadStatus = async (meta = null) => {
  const metaKey = sqliteStatusMetaKey(meta);
  const now = Date.now();
  if (
    sqliteReadStatusCache
    && sqliteReadStatusCache.metaKey === metaKey
    && now - sqliteReadStatusCache.createdAt <= sqliteReadStatusCacheMs
  ) {
    return sqliteReadStatusCache.status;
  }
  if (sqliteReadStatusInflight?.metaKey === metaKey) {
    return sqliteReadStatusInflight.promise;
  }
  const promise = getSqliteReadStatus(meta).then((status) => {
    sqliteReadStatusCache = { metaKey, status, createdAt: Date.now() };
    return status;
  }).finally(() => {
    if (sqliteReadStatusInflight?.promise === promise) sqliteReadStatusInflight = null;
  });
  sqliteReadStatusInflight = { metaKey, promise };
  return promise;
};

const sqliteFreshEnough = (status, countKey = "currentMatches", requiredCount = 1) => {
  return Boolean(status?.available)
    && !status.stale
    && Number(status?.counts?.[countKey] || 0) >= requiredCount;
};

const sqliteReadCacheToken = async (meta = null) => {
  if (!shouldPreferSqliteRead()) return "sqlite:not-preferred";
  const status = await getCachedSqliteReadStatus(meta);
  return [
    status.available ? "sqlite:available" : "sqlite:unavailable",
    status.stale ? "stale" : "fresh",
    status.syncMetaUpdatedAt || "",
    status.exportedAt || "",
    status.mtime || "",
    status.counts?.currentMatches || 0,
    status.counts?.historyMatches || 0,
    status.counts?.oddsSnapshots || 0,
    status.counts?.predictionSnapshots || 0
  ].join("|");
};

const readCurrentDataStoreMeta = async () => {
  const filePath = path.join(storeDir, "db", "current-matches.json");
  const payload = await readJsonFile(filePath, null);
  const stat = await fsp.stat(filePath).catch(() => null);
  const updatedAt = payload?.updatedAt || (stat ? stat.mtime.toISOString() : null);
  return {
    exists: Boolean(payload),
    updatedAt,
    rows: Array.isArray(payload?.rows) ? payload.rows.length : 0
  };
};

const readCurrentMatchesDetailed = async () => {
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const metaUpdatedTime = currentMetaTime(meta);
  let sqliteFallbackRead = null;

  if (shouldPreferSqliteRead()) {
    const sqliteStatus = await getCachedSqliteReadStatus(meta);
    if (sqliteFreshEnough(sqliteStatus, "currentMatches", 1)) {
      const sqliteMatches = await readSqliteCurrentMatches(sqliteDbPath);
      if (sqliteMatches.length > 0) {
        const rows = await mergeGptIntoMatches(sqliteMatches);
        lastCurrentRead = {
          source: "sqlite",
          stale: false,
          count: rows.length,
          dbUpdatedAt: sqliteStatus.syncMetaUpdatedAt || sqliteStatus.exportedAt || sqliteStatus.mtime || null,
          fileUpdatedAt: meta?.updatedAt || meta?.capturedAt || null,
          checkedAt: nowIso()
        };
        return { rows, ...lastCurrentRead };
      }
    }
    sqliteFallbackRead = {
      source: sqliteStatus.available
        ? (sqliteStatus.stale ? "file-sqlite-stale" : "file-sqlite-empty")
        : "file-sqlite-unavailable",
      dbUpdatedAt: sqliteStatus.syncMetaUpdatedAt || sqliteStatus.exportedAt || sqliteStatus.mtime || null
    };
  }

  if (process.env.CURRENT_MATCH_SOURCE === "db") {
    const [dbMatches, dbMeta] = await Promise.all([
      getLatestCurrentMatches(storeDir),
      readCurrentDataStoreMeta()
    ]);
    const dbUpdatedTime = Date.parse(dbMeta.updatedAt || "");
    const dbFreshEnough = dbMatches.length > 0
      && (!Number.isFinite(metaUpdatedTime) || (Number.isFinite(dbUpdatedTime) && dbUpdatedTime + currentMatchDbMaxStaleMs >= metaUpdatedTime));
    if (dbFreshEnough) {
      const rows = await mergeGptIntoMatches(dbMatches);
      lastCurrentRead = {
        source: "server-db",
        stale: false,
        count: rows.length,
        dbUpdatedAt: dbMeta.updatedAt,
        fileUpdatedAt: meta?.updatedAt || meta?.capturedAt || null,
        checkedAt: nowIso()
      };
      return { rows, ...lastCurrentRead };
    }
    const fileMatches = await readCurrentFileMatches();
    const rows = await mergeGptIntoMatches(fileMatches);
    lastCurrentRead = {
      source: dbMatches.length > 0 ? "file-db-stale" : "file-db-empty",
      stale: false,
      count: rows.length,
      dbUpdatedAt: dbMeta.updatedAt,
      fileUpdatedAt: meta?.updatedAt || meta?.capturedAt || null,
      checkedAt: nowIso()
    };
    return { rows, ...lastCurrentRead };
  }

  const fileMatches = await readCurrentFileMatches();
  const rows = await mergeGptIntoMatches(fileMatches);
  lastCurrentRead = {
    source: sqliteFallbackRead?.source || "file",
    stale: false,
    count: rows.length,
    dbUpdatedAt: sqliteFallbackRead?.dbUpdatedAt || null,
    fileUpdatedAt: meta?.updatedAt || meta?.capturedAt || null,
    checkedAt: nowIso()
  };
  return { rows, ...lastCurrentRead };
};

const readCurrentMatches = async () => {
  return (await readCurrentMatchesDetailed()).rows;
};

const compactCurrentReadStatus = (detail) => {
  if (!detail || typeof detail !== "object") return null;
  return {
    source: detail.source || null,
    stale: Boolean(detail.stale),
    count: Number(detail.count || 0),
    dbUpdatedAt: detail.dbUpdatedAt || null,
    fileUpdatedAt: detail.fileUpdatedAt || null,
    checkedAt: detail.checkedAt || null
  };
};

const compactProbabilityModel = (model) => {
  if (!model || typeof model !== "object") return model;
  return {
    version: model.version,
    generatedAt: model.generatedAt,
    basis: model.basis,
    ensembleWeights: model.ensembleWeights,
    dynamicCalibration: model.dynamicCalibration,
    oneXTwo: model.oneXTwo,
    scoreDistribution: model.scoreDistribution,
    goalLines: model.goalLines,
    bothTeamsToScore: model.bothTeamsToScore,
    lambdaBlend: model.lambdaBlend,
    worldCupPrior: model.worldCupPrior,
    modelHealth: model.modelHealth,
    calibrationAdjustment: model.calibrationAdjustment
  };
};

const compactPredictionMeta = (meta) => {
  if (!meta || typeof meta !== "object") return meta;
  return {
    policyVersion: meta.policyVersion,
    promptVersion: meta.promptVersion,
    generatedAt: meta.generatedAt,
    updatedAt: meta.updatedAt,
    lockedAt: meta.lockedAt,
    dataPolicy: meta.dataPolicy,
    updateReason: meta.updateReason,
    snapshot: meta.snapshot
  };
};

const compactDataGapProfileForList = (profile) => {
  if (!profile || typeof profile !== "object") return profile || null;
  return {
    version: profile.version,
    coverageScore: profile.coverageScore,
    sourceQuality: profile.sourceQuality,
    severeMissingCount: profile.severeMissingCount,
    trustPenalty: profile.trustPenalty,
    missing: Array.isArray(profile.missing)
      ? profile.missing.slice(0, 3).map((item) => ({
          key: item.key,
          zh: item.zh,
          en: item.en,
          severity: item.severity
        }))
      : []
  };
};

const compactPreMatchQualityForList = (quality) => {
  if (!quality || typeof quality !== "object") return quality || null;
  return {
    score: quality.score,
    sourceQuality: quality.sourceQuality,
    severeMissingCount: quality.severeMissingCount,
    missing: Array.isArray(quality.missing)
      ? quality.missing.slice(0, 3).map((item) => ({
          key: item.key,
          zh: item.zh,
          en: item.en,
          severity: item.severity
        }))
      : []
  };
};

const compactProbabilityTripletForList = (probabilities) => {
  if (!probabilities || typeof probabilities !== "object") return probabilities || null;
  return {
    home: Number.isFinite(Number(probabilities.home)) ? Number(probabilities.home) : probabilities.home ?? null,
    draw: Number.isFinite(Number(probabilities.draw)) ? Number(probabilities.draw) : probabilities.draw ?? null,
    away: Number.isFinite(Number(probabilities.away)) ? Number(probabilities.away) : probabilities.away ?? null
  };
};

const compactProbabilityLaneForList = (lane) => {
  if (!lane || typeof lane !== "object") return lane || null;
  return {
    market: compactProbabilityTripletForList(lane.market),
    final: compactProbabilityTripletForList(lane.final),
    unifiedPosterior: compactProbabilityTripletForList(lane.unifiedPosterior),
    scoreImplied: compactProbabilityTripletForList(lane.scoreImplied),
    poisson: compactProbabilityTripletForList(lane.poisson)
  };
};

const compactRiskContextForList = (context) => {
  if (!context || typeof context !== "object") return context || null;
  return {
    dataQuality: context.dataQuality,
    total: context.total,
    maxPressure: context.maxPressure,
    rotationRisk: context.rotationRisk,
    expectedYellowCards: context.expectedYellowCards
      ? { total: context.expectedYellowCards.total }
      : null,
    redCardRisk: context.redCardRisk
      ? { total: context.redCardRisk.total }
      : null,
    foulPressure: context.foulPressure
      ? { total: context.foulPressure.total }
      : null
  };
};

const compactContextSignalsForList = (signals) => {
  if (!signals || typeof signals !== "object") return signals || null;
  return {
    rankingPressure: compactRiskContextForList(signals.rankingPressure),
    discipline: compactRiskContextForList(signals.discipline),
    dataGaps: compactDataGapProfileForList(signals.dataGaps)
  };
};

const compactStatsForList = (stats) => {
  if (!stats || typeof stats !== "object") return stats || null;
  return {
    xG: stats.xG,
    attackIntent: compactRiskContextForList(stats.attackIntent),
    rankingPressure: compactRiskContextForList(stats.rankingPressure),
    discipline: compactRiskContextForList(stats.discipline),
    dataGaps: compactDataGapProfileForList(stats.dataGaps)
  };
};

const compactUnifiedPosteriorForList = (posterior) => {
  if (!posterior || typeof posterior !== "object") return posterior || null;
  return {
    version: posterior.version,
    generatedAt: posterior.generatedAt,
    selectedMarket: posterior.selectedMarket,
    selectedCode: posterior.selectedCode,
    selectedLabelZh: posterior.selectedLabelZh,
    selectedLabelEn: posterior.selectedLabelEn,
    selectedHandicapLine: posterior.selectedHandicapLine,
    selectedProbability: posterior.selectedProbability,
    selectedGap: posterior.selectedGap,
    selectedPosteriorScore: posterior.selectedPosteriorScore
  };
};

const compactProbabilityModelForCurrentList = (model) => {
  if (!model || typeof model !== "object") return model || null;
  return {
    version: model.version,
    generatedAt: model.generatedAt,
    dynamicCalibration: model.dynamicCalibration
      ? {
          version: model.dynamicCalibration.version,
          profileKey: model.dynamicCalibration.profileKey
        }
      : null,
    oneXTwo: compactProbabilityLaneForList(model.oneXTwo),
    handicap: model.handicap
      ? {
          line: model.handicap.line,
          ...compactProbabilityLaneForList(model.handicap)
        }
      : null,
    unifiedPosterior: compactUnifiedPosteriorForList(model.unifiedPosterior),
    modelHealth: model.modelHealth,
    contextSignals: compactContextSignalsForList(model.contextSignals)
  };
};

const compactPredictionMetaForList = (meta) => {
  if (!meta || typeof meta !== "object") return meta || null;
  return {
    policyVersion: meta.policyVersion,
    promptVersion: meta.promptVersion,
    strategyVersion: meta.strategyVersion,
    trainingVersion: meta.trainingVersion,
    generatedAt: meta.generatedAt,
    updatedAt: meta.updatedAt,
    lockedAt: meta.lockedAt,
    lockedReason: meta.lockedReason,
    cutoffTime: meta.cutoffTime
  };
};

const compactPredictionForCurrentList = (prediction) => {
  if (!prediction || typeof prediction !== "object") return null;
  return {
    marketType: prediction.marketType,
    oddsPoolCode: prediction.oddsPoolCode,
    handicapLine: prediction.handicapLine,
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel,
    odds: prediction.odds,
    trustScore: prediction.trustScore,
    recommendationAction: prediction.recommendationAction,
    recommendationTier: prediction.recommendationTier,
    valueLabel: prediction.valueLabel,
    riskTags: Array.isArray(prediction.riskTags) ? prediction.riskTags.slice(0, 3) : [],
    visibilityStatus: prediction.visibilityStatus,
    resultStatus: prediction.resultStatus
  };
};

const compactRecentFormForList = (form) => {
  if (!form || typeof form !== "object") return form || null;
  return {
    teamName: form.teamName,
    sampleSize: form.sampleSize,
    record: form.record,
    goalsForAvg: form.goalsForAvg,
    goalsAgainstAvg: form.goalsAgainstAvg,
    over25Rate: form.over25Rate,
    bttsRate: form.bttsRate,
    handicapWinRate: form.handicapWinRate
  };
};

const compactFutureScheduleForList = (schedule) => {
  if (!schedule || typeof schedule !== "object") return schedule || null;
  return {
    nextGapDays: schedule.nextGapDays
  };
};

const compactFiveHundredForList = (signal) => {
  if (!signal || typeof signal !== "object") return signal || null;
  return {
    source: signal.source,
    updatedAt: signal.updatedAt,
    fixtureId: signal.fixtureId,
    infoMatchId: signal.infoMatchId,
    matchNo: signal.matchNo,
    sale: signal.sale
      ? {
          buyEndTime: signal.sale.buyEndTime,
          availability: signal.sale.availability
        }
      : null,
    rank: signal.rank
      ? {
          home: signal.rank.home
            ? { teamName: signal.rank.home.teamName, fifaRank: signal.rank.home.fifaRank }
            : null,
          away: signal.rank.away
            ? { teamName: signal.rank.away.teamName, fifaRank: signal.rank.away.fifaRank }
            : null
        }
      : null,
    marketConsensus: signal.marketConsensus
      ? {
          riskLevel: signal.marketConsensus.riskLevel
        }
      : null
  };
};

const compactBookmakerOddsForList = (bookmakerOdds) => {
  if (!bookmakerOdds || typeof bookmakerOdds !== "object") return bookmakerOdds || null;
  const compactOdds = (odds) => {
    if (!odds || typeof odds !== "object") return odds || null;
    return {
      odds1: odds.odds1,
      oddsX: odds.oddsX,
      odds2: odds.odds2,
      handicapLine: odds.handicapLine,
      source: odds.source,
      updatedAt: odds.updatedAt
    };
  };
  return {
    source: bookmakerOdds.source,
    updatedAt: bookmakerOdds.updatedAt,
    providerCount: bookmakerOdds.providerCount,
    riskLevel: bookmakerOdds.riskLevel,
    had: compactOdds(bookmakerOdds.had),
    hhad: compactOdds(bookmakerOdds.hhad),
    apiFootball: compactOdds(bookmakerOdds.apiFootball)
  };
};

const compactExternalSignalsForList = (signals) => {
  if (!signals || typeof signals !== "object") return signals || null;
  return {
    source: signals.source,
    updatedAt: signals.updatedAt,
    sourceMatchId: signals.sourceMatchId,
    fixtureId: signals.fixtureId,
    matchNo: signals.matchNo,
    leagueName: signals.leagueName,
    homeTeamName: signals.homeTeamName,
    awayTeamName: signals.awayTeamName,
    kickoffTime: signals.kickoffTime,
    buyEndTime: signals.buyEndTime,
    handicapLine: signals.handicapLine,
    externalOdds: signals.externalOdds,
    bookmakerOdds: compactBookmakerOddsForList(signals.bookmakerOdds),
    fiveHundred: compactFiveHundredForList(signals.fiveHundred),
    preMatch: signals.preMatch
      ? {
          source: signals.preMatch.source,
          updatedAt: signals.preMatch.updatedAt,
          quality: compactPreMatchQualityForList(signals.preMatch.quality)
        }
      : null,
    lineups: signals.lineups
      ? {
          source: signals.lineups.source,
          available: true,
          homeFormation: signals.lineups.homeFormation,
          awayFormation: signals.lineups.awayFormation
        }
      : null,
    injuries: signals.injuries
      ? {
          source: signals.injuries.source,
          summary: signals.injuries.summary,
          home: Array.isArray(signals.injuries.home) ? signals.injuries.home.slice(0, 3) : signals.injuries.home,
          away: Array.isArray(signals.injuries.away) ? signals.injuries.away.slice(0, 3) : signals.injuries.away
        }
      : null,
    referee: signals.referee
      ? {
          source: signals.referee.source,
          name: signals.referee.name,
          summary: signals.referee.summary,
          cardsPerMatch: signals.referee.cardsPerMatch,
          penaltiesPerMatch: signals.referee.penaltiesPerMatch
        }
      : null,
    expectedGoals: signals.expectedGoals
      ? {
          source: signals.expectedGoals.source,
          summary: signals.expectedGoals.summary,
          homeXg: signals.expectedGoals.homeXg,
          awayXg: signals.expectedGoals.awayXg,
          homeXga: signals.expectedGoals.homeXga,
          awayXga: signals.expectedGoals.awayXga
        }
      : null,
    weather: signals.weather
      ? {
        source: signals.weather.source,
        provider: signals.weather.provider,
        updatedAt: signals.weather.updatedAt,
        verified: signals.weather.verified,
        confidence: signals.weather.confidence,
        condition: signals.weather.condition,
        riskLevel: signals.weather.riskLevel
      }
      : null,
    venue: signals.venue
      ? {
          name: signals.venue.name,
          city: signals.venue.city,
          country: signals.venue.country,
          verified: signals.venue.verified,
          source: signals.venue.source
        }
      : null
  };
};

const compactCurrentMatchForList = (match) => {
  if (!match || typeof match !== "object") return match;
  return {
    id: match.id,
    sourceMatchId: match.sourceMatchId,
    matchNo: match.matchNo,
    source: match.source,
    sourceMethod: match.sourceMethod,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    leagueId: match.leagueId,
    countryId: match.countryId,
    kickoffTime: match.kickoffTime,
    kickoffDate: match.kickoffDate,
    businessDate: match.businessDate,
    matchDate: match.matchDate,
    buyEndTime: match.buyEndTime,
    status: match.status,
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
    projectedScoreHome: match.projectedScoreHome,
    projectedScoreAway: match.projectedScoreAway,
    homeTeamName: match.homeTeamName,
    homeTeamNameEn: match.homeTeamNameEn,
    homeRank: match.homeRank,
    homeTeamLogo: match.homeTeamLogo,
    homeTeamLogoType: match.homeTeamLogoType,
    homeTeamCountryIso: match.homeTeamCountryIso,
    homeTeamColor: match.homeTeamColor,
    homeTeamValue: match.homeTeamValue,
    awayTeamName: match.awayTeamName,
    awayTeamNameEn: match.awayTeamNameEn,
    awayRank: match.awayRank,
    awayTeamLogo: match.awayTeamLogo,
    awayTeamLogoType: match.awayTeamLogoType,
    awayTeamCountryIso: match.awayTeamCountryIso,
    awayTeamColor: match.awayTeamColor,
    awayTeamValue: match.awayTeamValue,
    leagueName: match.leagueName,
    leagueNameEn: match.leagueNameEn,
    leagueShortName: match.leagueShortName,
    leagueShortNameEn: match.leagueShortNameEn,
    countryName: match.countryName,
    countryNameEn: match.countryNameEn,
    countryFlag: match.countryFlag,
    odds: match.odds,
    handicapOdds: match.handicapOdds,
    handicapLine: match.handicapLine,
    oddsSource: match.oddsSource,
    oddsPoolCode: match.oddsPoolCode,
    oddsUpdatedAt: match.oddsUpdatedAt,
    handicapOddsSource: match.handicapOddsSource,
    handicapOddsPoolCode: match.handicapOddsPoolCode,
    handicapOddsUpdatedAt: match.handicapOddsUpdatedAt,
    oddsTrend: match.oddsTrend,
    predictions: Array.isArray(match.predictions)
      ? match.predictions.map(compactPredictionForCurrentList).filter(Boolean)
      : [],
    predictionMeta: compactPredictionMetaForList(match.predictionMeta),
    gptPrediction: match.gptPrediction,
    probabilityModel: compactProbabilityModelForCurrentList(match.probabilityModel),
    externalSignals: compactExternalSignalsForList(match.externalSignals),
    postMatchReview: compactPostMatchReviewForList(match.postMatchReview)
  };
};

const compactMatchForList = compactCurrentMatchForList;

const compactPredictionForHistoryList = (prediction) => {
  if (!prediction || typeof prediction !== "object") return null;
  return {
    marketType: prediction.marketType,
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel,
    odds: prediction.odds,
    trustScore: prediction.trustScore,
    resultStatus: prediction.resultStatus,
    recommendationAction: prediction.recommendationAction,
    recommendationTier: prediction.recommendationTier,
    valueLabel: prediction.valueLabel,
    riskTags: Array.isArray(prediction.riskTags) ? prediction.riskTags.slice(0, 3) : []
  };
};

const compactPredictionReviewRowForList = (row) => {
  if (!row || typeof row !== "object") return null;
  return {
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode,
    handicapLine: row.handicapLine,
    tipCode: row.tipCode,
    tipLabel: row.tipLabel,
    odds: row.odds,
    actualCode: row.actualCode,
    actualLabel: row.actualLabel,
    resultStatus: row.resultStatus,
    trustScore: row.trustScore,
    recommendationAction: row.recommendationAction,
    recommendationTier: row.recommendationTier,
    reviewRole: row.reviewRole
  };
};

const compactPostMatchReviewForList = (review) => {
  if (!review || typeof review !== "object") return null;
  return {
    version: review.version,
    generatedAt: review.generatedAt,
    matchId: review.matchId,
    sourceMatchId: review.sourceMatchId,
    matchNo: review.matchNo,
    teams: review.teams,
    finalScore: review.finalScore,
    actual: review.actual,
    predictionReview: {
      settled: review.predictionReview?.settled || 0,
      won: review.predictionReview?.won || 0,
      hitRate: review.predictionReview?.hitRate ?? null,
      mainSettled: review.predictionReview?.mainSettled || 0,
      mainWon: review.predictionReview?.mainWon || 0,
      allSettled: review.predictionReview?.allSettled || 0,
      allWon: review.predictionReview?.allWon || 0,
      referenceSettled: review.predictionReview?.referenceSettled || 0,
      referenceWon: review.predictionReview?.referenceWon || 0,
      bestStatus: review.predictionReview?.bestStatus || null,
      oneXTwoStatus: review.predictionReview?.oneXTwoStatus || null,
      handicapHit: Boolean(review.predictionReview?.handicapHit),
      missedHandicapLane: Boolean(review.predictionReview?.missedHandicapLane),
      rows: (review.predictionReview?.rows || []).map(compactPredictionReviewRowForList).filter(Boolean)
    }
  };
};

const compactHistoryMatchForList = (match) => ({
  id: match.id,
  homeTeamId: match.homeTeamId,
  awayTeamId: match.awayTeamId,
  leagueId: match.leagueId,
  countryId: match.countryId,
  kickoffTime: match.kickoffTime,
  kickoffDate: match.kickoffDate,
  businessDate: match.businessDate,
  matchDate: match.matchDate,
  status: match.status,
  scoreHome: match.scoreHome,
  scoreAway: match.scoreAway,
  projectedScoreHome: match.projectedScoreHome,
  projectedScoreAway: match.projectedScoreAway,
  homeTeamName: match.homeTeamName,
  homeTeamNameEn: match.homeTeamNameEn,
  homeTeamLogo: match.homeTeamLogo,
  homeTeamLogoType: match.homeTeamLogoType,
  homeTeamCountryIso: match.homeTeamCountryIso,
  homeTeamColor: match.homeTeamColor,
  awayTeamName: match.awayTeamName,
  awayTeamNameEn: match.awayTeamNameEn,
  awayTeamLogo: match.awayTeamLogo,
  awayTeamLogoType: match.awayTeamLogoType,
  awayTeamCountryIso: match.awayTeamCountryIso,
  awayTeamColor: match.awayTeamColor,
  leagueName: match.leagueName,
  leagueNameEn: match.leagueNameEn,
  leagueShortName: match.leagueShortName,
  leagueShortNameEn: match.leagueShortNameEn,
  countryName: match.countryName,
  countryNameEn: match.countryNameEn,
  countryFlag: match.countryFlag,
  matchNo: match.matchNo,
  odds: match.odds,
  handicapOdds: match.handicapOdds,
  handicapLine: match.handicapLine,
  predictions: Array.isArray(match.predictions)
    ? match.predictions
      .filter((prediction) => prediction.marketType === "BEST" || prediction.marketType === "1X2")
      .map(compactPredictionForHistoryList)
      .filter(Boolean)
    : [],
  postMatchReview: compactPostMatchReviewForList(match.postMatchReview)
});

const readHistoryMatchesForListDetailed = async (limit = 600) => {
  const safeLimit = Math.max(1, Math.min(1200, Number(limit || 600)));
  if (shouldPreferSqliteRead()) {
    const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
    const sqliteStatus = await getCachedSqliteReadStatus(meta);
    if (sqliteFreshEnough(sqliteStatus, "historyMatches", 1)) {
      const sqliteRows = await readSqliteHistoryMatchesForList(sqliteDbPath, safeLimit);
      if (sqliteRows.length > 0) {
        return {
          source: "sqlite",
          dbUpdatedAt: sqliteStatus.syncMetaUpdatedAt || sqliteStatus.exportedAt || sqliteStatus.mtime || null,
          rows: sqliteRows
            .filter((row) => row && typeof row === "object")
            .map(compactHistoryMatchForList)
            .filter(Boolean)
        };
      }
    }
  }

  const dbRows = await getHistoryMatchesForList(storeDir, safeLimit);
  if (dbRows.length > 0) {
    return { source: "server-db", rows: dbRows };
  }
  if (!enableFullHistoryFileFallback) return { source: "unavailable", rows: [] };

  const filePath = path.join(dataDir, "matches-history.json");
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return { source: "file-missing", rows: [] };

  if (
    historyListCache
    && historyListCache.mtimeMs === stat.mtimeMs
    && historyListCache.limit >= safeLimit
  ) {
    return { source: "file-cache", rows: historyListCache.rows.slice(0, safeLimit) };
  }

  const history = await readJsonFile(filePath, []);
  const rows = Array.isArray(history)
    ? history
      .slice()
      .sort((a, b) => Date.parse(b.kickoffTime || b.matchDate || 0) - Date.parse(a.kickoffTime || a.matchDate || 0))
      .slice(0, safeLimit)
      .map(compactHistoryMatchForList)
    : [];

  historyListCache = {
    mtimeMs: stat.mtimeMs,
    limit: safeLimit,
    rows
  };
  return { source: "file", rows };
};

const readHistoryMatchesForList = async (limit = 600) => {
  const result = await readHistoryMatchesForListDetailed(limit);
  return result.rows;
};

const readMatchById = async (matchId) => {
  const decodedId = decodeURIComponent(matchId || "");
  const current = await readCurrentMatches();
  const currentMatch = Array.isArray(current) ? current.find((match) => match.id === decodedId) : null;
  if (currentMatch) return enrichMatchHistoricalTraining(currentMatch);

  if (shouldPreferSqliteRead()) {
    const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
    const sqliteStatus = await getSqliteReadStatus(meta);
    if (sqliteFreshEnough(sqliteStatus, "historyMatches", 1)) {
      const sqliteMatch = await readSqliteMatchById(sqliteDbPath, decodedId);
      if (sqliteMatch) return enrichMatchHistoricalTraining(sqliteMatch);
    }
  }

  const dbMatch = await getLatestMatchById(storeDir, decodedId);
  if (dbMatch) return enrichMatchHistoricalTraining(dbMatch);
  if (!enableFullHistoryFileFallback) return null;

  const history = await readJsonFile(path.join(dataDir, "matches-history.json"), []);
  const historyMatch = Array.isArray(history) ? history.find((match) => match.id === decodedId) || null : null;
  return historyMatch ? enrichMatchHistoricalTraining(historyMatch) : null;
};

const readOddsHistoryPage = async (url) => {
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
  if (shouldPreferSqliteRead()) {
    const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
    const sqliteStatus = await getSqliteReadStatus(meta);
    if (sqliteFreshEnough(sqliteStatus, "oddsSnapshots", 1)) {
      const rows = await readSqliteOddsHistoryRows(sqliteDbPath, {
        limit,
        matchId: url.searchParams.get("matchId") || "",
        sourceMatchId: url.searchParams.get("sourceMatchId") || "",
        pool: url.searchParams.get("pool") || ""
      });
      if (rows.length > 0 || url.searchParams.get("matchId") || url.searchParams.get("sourceMatchId") || url.searchParams.get("pool")) {
        return {
          ok: true,
          source: "sqlite",
          limit,
          rows,
          note: "odds history is paginated from the SQLite data warehouse"
        };
      }
    }
  }

  const rows = await readOddsHistoryRows(storeDir, {
    limit,
    matchId: url.searchParams.get("matchId") || "",
    sourceMatchId: url.searchParams.get("sourceMatchId") || "",
    pool: url.searchParams.get("pool") || ""
  });
  return {
    ok: true,
    source: "server-db",
    limit,
    rows,
    note: "odds history is paginated from the server data store; full static payload is disabled"
  };
};

const summarizeExternalSignal = (matchId, signal) => ({
  matchId,
  source: signal?.source || null,
  updatedAt: signal?.updatedAt || null,
  sourceMatchId: signal?.sourceMatchId || null,
  fixtureId: signal?.fixtureId || signal?.apiFootball?.fixtureId || null,
  handicapLine: signal?.handicapLine ?? signal?.bookmakerOdds?.hhad?.handicapLine ?? null,
  hasHad: Boolean(signal?.bookmakerOdds?.had || signal?.externalOdds),
  hasHhad: Boolean(signal?.bookmakerOdds?.hhad),
  hasApiFootball: Boolean(signal?.apiFootball || signal?.bookmakerOdds?.apiFootball),
  hasFiveHundred: Boolean(signal?.fiveHundred),
  hasLineups: Boolean(signal?.lineups),
  hasInjuries: Boolean(signal?.injuries),
  buyEndTime: signal?.buyEndTime || null
});

const readExternalSignalsPage = async (url) => {
  const payload = await readJsonFile(path.join(dataDir, "external-signals.json"), { matches: {} });
  const matches = payload?.matches && typeof payload.matches === "object" && !Array.isArray(payload.matches)
    ? payload.matches
    : {};
  const matchId = url.searchParams.get("matchId") || url.searchParams.get("sourceMatchId") || "";
  if (matchId) {
    return {
      ok: true,
      version: payload.version || 1,
      source: payload.source || "external-signals",
      updatedAt: payload.updatedAt || null,
      sources: payload.sources || {},
      matchId,
      signal: matches[matchId] || null
    };
  }

  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 120)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const entries = Object.entries(matches);
  return {
    ok: true,
    version: payload.version || 1,
    source: payload.source || "external-signals",
    updatedAt: payload.updatedAt || null,
    sources: payload.sources || {},
    total: entries.length,
    limit,
    offset,
    rows: entries.slice(offset, offset + limit).map(([id, signal]) => summarizeExternalSignal(id, signal))
  };
};

const summarizeFiveHundredDetail = (matchId, detail) => ({
  matchId,
  sourceMatchId: detail?.sourceMatchId || matchId,
  fixtureId: detail?.fixtureId || null,
  infoMatchId: detail?.infoMatchId || null,
  matchNo: detail?.matchNo || null,
  matchDate: detail?.matchDate || null,
  kickoffTime: detail?.kickoffTime || null,
  leagueName: detail?.leagueName || null,
  homeTeamName: detail?.homeTeamName || null,
  awayTeamName: detail?.awayTeamName || null,
  buyEndTime: detail?.buyEndTime || null,
  handicapLine: detail?.handicapLine ?? null,
  had: detail?.had || null,
  hhad: detail?.hhad || null,
  availability: detail?.availability || null
});

const readFiveHundredDetailsPage = async (url) => {
  const payload = await readJsonFile(path.join(dataDir, "five-hundred-details.json"), { matches: {} });
  const matches = payload?.matches && typeof payload.matches === "object" && !Array.isArray(payload.matches)
    ? payload.matches
    : {};
  const matchId = url.searchParams.get("matchId") || url.searchParams.get("sourceMatchId") || "";
  if (matchId) {
    return {
      ok: true,
      version: payload.version || 1,
      source: payload.source || "500.com:details",
      updatedAt: payload.updatedAt || null,
      matchId,
      detail: matches[matchId] || null
    };
  }

  const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit") || 80)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const entries = Object.entries(matches);
  return {
    ok: true,
    version: payload.version || 1,
    source: payload.source || "500.com:details",
    updatedAt: payload.updatedAt || null,
    total: entries.length,
    limit,
    offset,
    scannedRows: payload.scannedRows || 0,
    resultRows: payload.resultRows || 0,
    cachedMerged: payload.cachedMerged || 0,
    errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 5) : [],
    rows: entries.slice(offset, offset + limit).map(([id, detail]) => summarizeFiveHundredDetail(id, detail))
  };
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

const fileInfoWithPath = async (filePath) => ({
  path: filePath,
  ...(await fileInfo(filePath))
});

const minutesSince = (iso) => {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / 60000;
};

const matchHasExternalSignal = (match) => {
  const signals = match?.externalSignals;
  if (!signals || typeof signals !== "object") return false;
  return Boolean(
    signals.externalOdds
    || signals.bookmakerOdds?.had
    || signals.bookmakerOdds?.hhad
    || signals.bookmakerOdds?.apiFootball
    || signals.apiFootball
    || signals.fiveHundred
    || signals.injuries
    || signals.lineups
  );
};

const ratio = (value, total) => {
  const numerator = Number(value);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
};

const sourceFreshness = (updatedAt, maxAgeMinutes) => {
  const safeMaxAge = Math.max(1, Number(maxAgeMinutes || 1));
  const age = minutesSince(updatedAt);
  return {
    updatedAt: updatedAt || null,
    ageMinutes: Number.isFinite(age) ? Number(age.toFixed(2)) : null,
    maxAgeMinutes: safeMaxAge,
    stale: !Number.isFinite(age) || age > safeMaxAge
  };
};

const sourceStatus = ({ enabled = true, exists = true, stale = false, score = 0, required = false, errors = 0 }) => {
  if (!enabled) return "disabled";
  if (!exists) return required ? "missing" : "unavailable";
  if (stale) return required ? "stale" : "stale";
  if (errors > 0) return "degraded";
  if (score >= 80) return "healthy";
  if (score >= 50) return "degraded";
  return "weak";
};

const getSourceHealth = async () => {
  const maxAgeMinutes = Math.max(1, Number(process.env.SOURCE_MAX_AGE_MINUTES || 20));
  const minExternalRows = Math.max(0, Number(process.env.SOURCE_MIN_500_ROWS || 1));
  const minExternalMapped = Math.max(0, Number(process.env.SOURCE_MIN_500_MAPPED || 1));
  const minCurrentMatches = Math.max(0, Number(process.env.SOURCE_MIN_CURRENT_MATCHES || 1));
  const minCurrentCoverage = Math.max(0, Math.min(1, Number(process.env.SOURCE_MIN_EXTERNAL_COVERAGE || 0.5)));
  const requirePreMatchSignals = process.env.REQUIRE_PREMATCH_SIGNALS === "1";
  const minPreMatchRows = Math.max(0, Number(process.env.SOURCE_MIN_PREMATCH_ROWS || minCurrentMatches));
  const cacheKey = [
    await fileMtimeMs(path.join(dataDir, "sync-meta.json")),
    await fileMtimeMs(path.join(dataDir, "external-signals.json")),
    await fileMtimeMs(path.join(dataDir, "pre-match-signals.json")),
    await fileMtimeMs(path.join(dataDir, "api-football-meta.json")),
    await fileMtimeMs(path.join(dataDir, "matches-current.json")),
    requireExternalSignals ? "require" : "optional",
    requirePreMatchSignals ? "prematch-required" : "prematch-optional",
    maxAgeMinutes,
    minExternalRows,
    minExternalMapped,
    minCurrentMatches,
    minCurrentCoverage,
    minPreMatchRows
  ].join(":");

  if (sourceHealthCache?.key === cacheKey) {
    return {
      ...sourceHealthCache.value,
      checkedAt: nowIso(),
      cached: true
    };
  }

  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const external = await readJsonFile(path.join(dataDir, "external-signals.json"), null);
  const preMatch = await readJsonFile(path.join(dataDir, "pre-match-signals.json"), null);
  const apiFootballMeta = await readJsonFile(path.join(dataDir, "api-football-meta.json"), null);
  const current = await readCurrentFileMatches();
  const externalMatches = external?.matches && typeof external.matches === "object" && !Array.isArray(external.matches)
    ? external.matches
    : {};
  const preMatchMatches = preMatch?.matches && typeof preMatch.matches === "object" && !Array.isArray(preMatch.matches)
    ? preMatch.matches
    : {};
  const source500 = external?.sources?.["500.com:jczq"] || {};
  const source500Details = external?.sources?.["500.com:details"] || {};
  const sourceWeather = external?.sources?.["open-meteo:forecast"] || {};
  const sourceApiFootball = external?.sources?.["api-football"] || {};
  const externalCount = Object.keys(externalMatches).length;
  const preMatchCount = Object.keys(preMatchMatches).length;
  const preMatchSummary = preMatch?.summary || {};
  const externalAge = minutesSince(external?.updatedAt);
  const preMatchAge = minutesSince(preMatch?.updatedAt);
  const currentCount = Array.isArray(current) ? current.length : 0;
  const currentWithExternal = Array.isArray(current) ? current.filter(matchHasExternalSignal).length : 0;
  const currentWithFiveHundredDetails = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.fiveHundred)).length
    : 0;
  const currentWithApiFootball = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.apiFootball)).length
    : 0;
  const currentWithWeather = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.weather)).length
    : 0;
  const currentWithPreMatch = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.preMatch)).length
    : 0;
  const sportteryCurrent = Array.isArray(current)
    ? current.filter((match) => String(match?.source || "").toLowerCase() === "sporttery" || String(match?.id || "").startsWith("sporttery_")).length
    : 0;
  const sportteryOddsMatches = Array.isArray(current)
    ? current.filter((match) => (
      String(match?.oddsSource || "").startsWith("sporttery")
      || String(match?.handicapOddsSource || "").startsWith("sporttery")
    )).length
    : 0;
  const currentCoverage = currentCount > 0 ? currentWithExternal / currentCount : 0;
  const sportteryFreshnessBase = sourceFreshness(meta?.api?.freshnessTime || meta?.updatedAt || meta?.capturedAt || meta?.lastSync, maxAgeMinutes);
  const sportteryFreshness = {
    ...sportteryFreshnessBase,
    stale: Boolean(meta?.api?.stale) || sportteryFreshnessBase.stale
  };
  const fiveHundredFreshness = sourceFreshness(source500.updatedAt || external?.updatedAt, maxAgeMinutes);
  const fiveHundredDetailsFreshness = sourceFreshness(
    source500Details.updatedAt || source500.updatedAt || external?.updatedAt,
    Math.max(maxAgeMinutes, Number(source500Details.refreshMinutes || 0) || 0)
  );
  const weatherFreshness = sourceFreshness(
    sourceWeather.updatedAt || external?.updatedAt,
    Math.max(maxAgeMinutes, Number(sourceWeather.maxAgeMinutes || 0) || 0)
  );
  const preMatchFreshness = sourceFreshness(preMatch?.updatedAt, maxAgeMinutes);
  const sportteryScore = Math.round(
    (currentCount >= minCurrentMatches ? 35 : 0)
    + (sportteryFreshness.stale ? 0 : 25)
    + (ratio(sportteryCurrent, Math.max(currentCount, minCurrentMatches)) * 20)
    + (ratio(sportteryOddsMatches, Math.max(currentCount, 1)) * 20)
  );
  const fiveHundredScore = enable500Sync ? Math.round(
    (((source500.rows || 0) >= minExternalRows) ? 25 : 0)
    + (((source500.mapped || 0) >= minExternalMapped) ? 25 : 0)
    + (fiveHundredFreshness.stale ? 0 : 20)
    + (ratio(Math.max(source500Details.cachedMerged || 0, currentWithFiveHundredDetails), Math.max(currentCount, 1)) * 20)
    + ((source500Details.errors || 0) > 0 ? 0 : 10)
  ) : 0;
  const weatherScore = enableWeatherSync ? Math.round(
    (((sourceWeather.rows || 0) > 0) ? 25 : 0)
    + (((sourceWeather.mapped || 0) > 0) ? 25 : 0)
    + (weatherFreshness.stale ? 0 : 25)
    + (ratio(currentWithWeather, Math.max(currentCount, 1)) * 25)
  ) : 0;
  const preMatchUsableRows = Number(preMatchSummary.high || 0) + Number(preMatchSummary.medium || 0);
  const preMatchScore = enablePreMatchSignalsSync ? Math.round(
    ((preMatchCount >= minPreMatchRows) ? 25 : 0)
    + (preMatchFreshness.stale ? 0 : 25)
    + (ratio(currentWithPreMatch, Math.max(currentCount, 1)) * 25)
    + (ratio(preMatchUsableRows, Math.max(preMatchCount, 1)) * 25)
  ) : 0;
  const errors = [];
  const warnings = [];

  if (!sportteryFreshness.updatedAt) errors.push("sporttery sync metadata missing");
  if (sportteryFreshness.stale) errors.push(`sporttery sync stale ${sportteryFreshness.ageMinutes ?? "unknown"}m`);
  if (requireExternalSignals) {
    if (!external) errors.push("external-signals missing");
    if (external && externalAge > maxAgeMinutes) errors.push(`external-signals stale ${externalAge.toFixed(1)}m`);
    if ((source500.rows || 0) < minExternalRows) errors.push(`500 rows ${source500.rows || 0} < ${minExternalRows}`);
    if ((source500.mapped || 0) < minExternalMapped) errors.push(`500 mapped ${source500.mapped || 0} < ${minExternalMapped}`);
    if (currentCount > 0 && currentCoverage < minCurrentCoverage) {
      warnings.push(`external coverage ${(currentCoverage * 100).toFixed(1)}% < ${(minCurrentCoverage * 100).toFixed(1)}%`);
    }
  }
  if (!preMatch) {
    const message = "pre-match-signals missing";
    if (requirePreMatchSignals) errors.push(message);
    else warnings.push(message);
  } else {
    if (preMatchAge > maxAgeMinutes) {
      const message = `pre-match-signals stale ${preMatchAge.toFixed(1)}m`;
      if (requirePreMatchSignals) errors.push(message);
      else warnings.push(message);
    }
    if (preMatchCount < minPreMatchRows) {
      const message = `pre-match rows ${preMatchCount} < ${minPreMatchRows}`;
      if (requirePreMatchSignals) errors.push(message);
      else warnings.push(message);
    }
  }
  if (!Array.isArray(current)) errors.push("current matches invalid");
  if (currentCount < minCurrentMatches) errors.push(`current matches ${currentCount} < ${minCurrentMatches}`);

  const sources = [
    {
      id: "sporttery",
      label: "China Sporttery",
      role: "primary-fixture-odds",
      enabled: true,
      required: true,
      status: sourceStatus({
        exists: Boolean(currentCount),
        stale: sportteryFreshness.stale,
        score: sportteryScore,
        required: true
      }),
      score: sportteryScore,
      ...sportteryFreshness,
      metrics: {
        currentMatches: currentCount,
        sportteryMatches: sportteryCurrent,
        officialOddsMatches: sportteryOddsMatches,
        officialOddsCoverage: Number(ratio(sportteryOddsMatches, Math.max(currentCount, 1)).toFixed(4))
      }
    },
    {
      id: "five-hundred",
      label: "500.com",
      role: "supplemental-market-signal",
      enabled: enable500Sync,
      required: requireExternalSignals,
      status: sourceStatus({
        enabled: enable500Sync,
        exists: Boolean(external && (source500.rows || source500.mapped || currentWithFiveHundredDetails)),
        stale: fiveHundredFreshness.stale,
        score: fiveHundredScore,
        required: requireExternalSignals,
        errors: source500Details.errors || 0
      }),
      score: fiveHundredScore,
      ...fiveHundredFreshness,
      detailsFreshness: fiveHundredDetailsFreshness,
      metrics: {
        rows: source500.rows || 0,
        mapped: source500.mapped || 0,
        detailsRows: source500Details.rows || source500Details.updated || 0,
        detailsCachedMerged: Math.max(source500Details.cachedMerged || 0, currentWithFiveHundredDetails),
        currentMatchesWithDetails: currentWithFiveHundredDetails,
        currentCoverage: Number(ratio(currentWithFiveHundredDetails, Math.max(currentCount, 1)).toFixed(4)),
        errors: source500Details.errors || 0
      }
    },
    {
      id: "weather",
      label: "Open-Meteo weather",
      role: "environment-risk-signal",
      enabled: enableWeatherSync,
      required: false,
      status: sourceStatus({
        enabled: enableWeatherSync,
        exists: Boolean(sourceWeather.rows || sourceWeather.mapped || currentWithWeather),
        stale: weatherFreshness.stale,
        score: weatherScore,
        required: false,
        errors: sourceWeather.errors || 0
      }),
      score: weatherScore,
      ...weatherFreshness,
      metrics: {
        rows: sourceWeather.rows || 0,
        mapped: sourceWeather.mapped || 0,
        currentMatchesWithWeather: currentWithWeather,
        currentCoverage: Number(ratio(currentWithWeather, Math.max(currentCount, 1)).toFixed(4)),
        errors: sourceWeather.errors || 0
      }
    },
    {
      id: "pre-match",
      label: "Pre-match signals",
      role: "injury-lineup-referee-risk-signal",
      enabled: enablePreMatchSignalsSync,
      required: requirePreMatchSignals,
      status: sourceStatus({
        enabled: enablePreMatchSignalsSync,
        exists: Boolean(preMatch),
        stale: preMatchFreshness.stale,
        score: preMatchScore,
        required: requirePreMatchSignals
      }),
      score: preMatchScore,
      ...preMatchFreshness,
      metrics: {
        rows: preMatchCount,
        high: preMatchSummary.high || 0,
        medium: preMatchSummary.medium || 0,
        low: preMatchSummary.low || 0,
        usableRows: preMatchUsableRows,
        currentMatchesWithPreMatch: currentWithPreMatch,
        currentCoverage: Number(ratio(currentWithPreMatch, Math.max(currentCount, 1)).toFixed(4)),
        warningCount: Array.isArray(preMatchSummary.warnings) ? preMatchSummary.warnings.length : 0
      }
    }
  ];
  const sourceScores = Object.fromEntries(sources.map((source) => [source.id, {
    status: source.status,
    score: source.score,
    stale: source.stale,
    updatedAt: source.updatedAt,
    ageMinutes: source.ageMinutes
  }]));

  const health = {
    ok: errors.length === 0,
    checkedAt: nowIso(),
    cached: false,
    mode: {
      enable500Sync,
      enable500DetailsSync,
      enableWeatherSync,
      enablePreMatchSignalsSync,
      enableApiFootballSync,
      requireExternalSignals,
      skipSportteryFetch: process.env.SKIP_SPORTTERY_FETCH === "1",
    },
    thresholds: {
      maxAgeMinutes,
      minExternalRows,
      minExternalMapped,
      minCurrentMatches,
      minCurrentCoverage,
      requirePreMatchSignals,
      minPreMatchRows,
    },
    sources,
    sourceScores,
    externalSignals: {
      exists: Boolean(external),
      updatedAt: external?.updatedAt || null,
      ageMinutes: Number.isFinite(externalAge) ? Number(externalAge.toFixed(2)) : null,
      matchKeys: externalCount,
      fiveHundredRows: source500.rows || 0,
      fiveHundredMapped: source500.mapped || 0,
      fiveHundredUrl: source500.url || null,
      fiveHundredDetailsUpdatedAt: source500Details.updatedAt || null,
      fiveHundredDetailsRows: source500Details.rows || source500Details.updated || 0,
      fiveHundredDetailsCachedMerged: Math.max(source500Details.cachedMerged || 0, currentWithFiveHundredDetails),
      fiveHundredDetailsRequestedPages: source500Details.requestedPages || 0,
      fiveHundredDetailsRefreshMinutes: source500Details.refreshMinutes || 0,
      fiveHundredDetailsErrors: source500Details.errors || 0,
      apiFootballConfigured: Boolean(process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY),
      apiFootballEnabled: enableApiFootballSync,
      apiFootballUpdatedAt: sourceApiFootball.updatedAt || apiFootballMeta?.finishedAt || null,
      apiFootballMappedSignals: Math.max(sourceApiFootball.mappedSignals || 0, apiFootballMeta?.signalsMapped || 0, currentWithApiFootball),
      apiFootballCallsThisSync: apiFootballMeta?.callsThisSync || 0,
      apiFootballCallsTodayEstimate: apiFootballMeta?.callsTodayEstimate || 0,
      apiFootballFixtureDatesSkippedByAccess: apiFootballMeta?.fixtureDatesSkippedByAccess || 0,
      apiFootballAccess: apiFootballMeta?.apiAccess?.fixtures || null,
    },
    preMatchSignals: {
      exists: Boolean(preMatch),
      updatedAt: preMatch?.updatedAt || null,
      ageMinutes: Number.isFinite(preMatchAge) ? Number(preMatchAge.toFixed(2)) : null,
      matchKeys: preMatchCount,
      high: preMatchSummary.high || 0,
      medium: preMatchSummary.medium || 0,
      low: preMatchSummary.low || 0,
      warningCount: Array.isArray(preMatchSummary.warnings) ? preMatchSummary.warnings.length : 0,
    },
    currentMatches: {
      count: currentCount,
      withExternalSignals: currentWithExternal,
      externalCoverage: Number(currentCoverage.toFixed(4)),
      withSportteryOdds: sportteryOddsMatches,
      withFiveHundredDetails: currentWithFiveHundredDetails,
      withWeather: currentWithWeather,
      withPreMatchSignals: currentWithPreMatch,
    },
    warnings,
    errors,
  };
  sourceHealthCache = { key: cacheKey, value: health };
  return health;
};

const getHealth = async () => {
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const gpt = await readGptPredictions();
  const apiFootballMeta = await readJsonFile(path.join(dataDir, "api-football-meta.json"), null);
  const sources = await getSourceHealth();
  const sqlite = await getSqliteReadStatus(meta);
  const currentRead = compactCurrentReadStatus(await readCurrentMatchesDetailed().catch(() => lastCurrentRead));
  return {
    ok: sources.ok,
    service: "football-predict-server",
    checkedAt: nowIso(),
    syncRunning,
    predictRunning,
    lastSync,
    lastPredictionRun,
    lastDataPersist,
    lastDataCompact,
    api: {
      publicApiBase,
      apiFootballConfigured: Boolean(process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY),
      apiFootballEnabled: enableApiFootballSync,
      apiFootballLastRun: apiFootballMeta?.finishedAt || null,
      apiFootballCallsTodayEstimate: apiFootballMeta?.callsTodayEstimate || 0,
      apiFootballFixtureDatesSkippedByAccess: apiFootballMeta?.fixtureDatesSkippedByAccess || 0,
      apiFootballAccess: apiFootballMeta?.apiAccess?.fixtures || null,
      gptConfigured: Boolean(process.env.GPT_RELAY_BASE_URL && process.env.GPT_RELAY_API_KEY),
      adminProtected: Boolean(adminToken),
      accessCodeAdminProtected: Boolean(accessCodeAdminToken),
      syncCron: process.env.ENABLE_SYNC_CRON === "1" ? `${syncIntervalSeconds}s` : "off",
      gptCron: process.env.ENABLE_GPT_CRON === "1" ? `${gptIntervalSeconds}s` : "off",
      datastoreCompact: datastoreCompactOnSync ? `${Math.round(datastoreCompactIntervalMs / 60000)}m` : "off",
      fullHistoryFileFallback: enableFullHistoryFileFallback
    },
    memory: process.memoryUsage(),
    database: await getDataStoreStatus(storeDir),
    storage: {
      sqlite
    },
    files: {
      current: await fileInfo(path.join(dataDir, "matches-current.json")),
      history: await fileInfo(path.join(dataDir, "matches-history.json")),
      meta: await fileInfo(path.join(dataDir, "sync-meta.json")),
      gptPredictions: await fileInfo(path.join(dataDir, "gpt-predictions.json"))
    },
    currentRead,
    meta,
    sources,
    gptRows: Array.isArray(gpt.rows) ? gpt.rows.length : 0
  };
};

const publicSourceHealth = (health) => ({
  ok: Boolean(health?.ok),
  checkedAt: health?.checkedAt || nowIso(),
  cached: Boolean(health?.cached),
  mode: {
    enable500Sync: Boolean(health?.mode?.enable500Sync),
    enable500DetailsSync: Boolean(health?.mode?.enable500DetailsSync),
    enableWeatherSync: Boolean(health?.mode?.enableWeatherSync),
    enablePreMatchSignalsSync: Boolean(health?.mode?.enablePreMatchSignalsSync),
    enableApiFootballSync: Boolean(health?.mode?.enableApiFootballSync),
    requireExternalSignals: Boolean(health?.mode?.requireExternalSignals),
    skipSportteryFetch: Boolean(health?.mode?.skipSportteryFetch)
  },
  sources: Array.isArray(health?.sources) ? health.sources.map((source) => ({
    id: source.id,
    label: source.label,
    role: source.role,
    enabled: Boolean(source.enabled),
    required: Boolean(source.required),
    status: source.status,
    score: source.score,
    updatedAt: source.updatedAt || null,
    ageMinutes: source.ageMinutes ?? null,
    maxAgeMinutes: source.maxAgeMinutes ?? null,
    stale: Boolean(source.stale),
    metrics: source.metrics || {}
  })) : [],
  sourceScores: health?.sourceScores || {},
  externalSignals: {
    exists: Boolean(health?.externalSignals?.exists),
    updatedAt: health?.externalSignals?.updatedAt || null,
    ageMinutes: health?.externalSignals?.ageMinutes ?? null,
    matchKeys: health?.externalSignals?.matchKeys || 0,
    fiveHundredRows: health?.externalSignals?.fiveHundredRows || 0,
    fiveHundredMapped: health?.externalSignals?.fiveHundredMapped || 0,
    fiveHundredDetailsRows: health?.externalSignals?.fiveHundredDetailsRows || 0,
    fiveHundredDetailsCachedMerged: health?.externalSignals?.fiveHundredDetailsCachedMerged || 0,
    apiFootballEnabled: Boolean(health?.externalSignals?.apiFootballEnabled),
    apiFootballMappedSignals: health?.externalSignals?.apiFootballMappedSignals || 0,
    apiFootballUpdatedAt: health?.externalSignals?.apiFootballUpdatedAt || null
  },
  preMatchSignals: {
    exists: Boolean(health?.preMatchSignals?.exists),
    updatedAt: health?.preMatchSignals?.updatedAt || null,
    ageMinutes: health?.preMatchSignals?.ageMinutes ?? null,
    matchKeys: health?.preMatchSignals?.matchKeys || 0,
    high: health?.preMatchSignals?.high || 0,
    medium: health?.preMatchSignals?.medium || 0,
    low: health?.preMatchSignals?.low || 0,
    warningCount: health?.preMatchSignals?.warningCount || 0
  },
  currentMatches: health?.currentMatches || { count: 0, withExternalSignals: 0, externalCoverage: 0 },
  warnings: Array.isArray(health?.warnings) ? health.warnings : [],
  errors: Array.isArray(health?.errors) ? health.errors : []
});

const compactErrorList = (items, limit = 10) => {
  if (!items) return [];
  const rows = Array.isArray(items) ? items : [items];
  return rows
    .filter((item) => item !== null && item !== undefined && item !== "")
    .slice(-Math.max(1, Math.min(50, Number(limit || 10))))
    .map((item) => {
      if (typeof item === "string") return { message: item };
      if (typeof item !== "object") return { message: String(item) };
      return {
        at: item.at || item.updatedAt || item.date || null,
        matchId: item.matchId || item.id || item.fixtureId || null,
        source: item.source || item.url || null,
        message: item.message || item.error || item.reason || JSON.stringify(item).slice(0, 500)
      };
    });
};

const publicPathForData = (fileName) => `/data/${fileName}`;

const getAdminSourceHealth = async (health) => {
  const [
    external,
    fiveHundredDetails,
    preMatch,
    apiFootballMeta,
    apiFootballCache,
    syncWorkerStatus,
    syncMeta
  ] = await Promise.all([
    readJsonFile(path.join(dataDir, "external-signals.json"), null),
    readJsonFile(path.join(dataDir, "five-hundred-details.json"), null),
    readJsonFile(path.join(dataDir, "pre-match-signals.json"), null),
    readJsonFile(path.join(dataDir, "api-football-meta.json"), null),
    readJsonFile(path.join(dataDir, "api-football-cache.json"), null),
    readJsonFile(path.join(storeDir, "sync-worker-status.json"), null),
    readJsonFile(path.join(dataDir, "sync-meta.json"), null)
  ]);
  const source500 = external?.sources?.["500.com:jczq"] || {};
  const source500Details = external?.sources?.["500.com:details"] || {};
  const sourceWeather = external?.sources?.["open-meteo:forecast"] || {};
  const sourceApiFootball = external?.sources?.["api-football"] || {};
  const apiFootballRecentErrors = compactErrorList(apiFootballCache?.errors || apiFootballMeta?.recentErrors || [], 12);
  const fiveHundredDetailErrors = compactErrorList(fiveHundredDetails?.errors || [], 12);
  const preMatchWarnings = compactErrorList(preMatch?.summary?.warnings || [], 12);

  return {
    ...publicSourceHealth(health),
    admin: {
      checkedAt: nowIso(),
      files: {
        syncMeta: { publicPath: publicPathForData("sync-meta.json"), ...(await fileInfoWithPath(path.join(dataDir, "sync-meta.json"))) },
        currentMatches: { publicPath: publicPathForData("matches-current.json"), ...(await fileInfoWithPath(path.join(dataDir, "matches-current.json"))) },
        externalSignals: { publicPath: publicPathForData("external-signals.json"), ...(await fileInfoWithPath(path.join(dataDir, "external-signals.json"))) },
        fiveHundredDetails: { publicPath: publicPathForData("five-hundred-details.json"), ...(await fileInfoWithPath(path.join(dataDir, "five-hundred-details.json"))) },
        preMatchSignals: { publicPath: publicPathForData("pre-match-signals.json"), ...(await fileInfoWithPath(path.join(dataDir, "pre-match-signals.json"))) },
        apiFootballMeta: { publicPath: publicPathForData("api-football-meta.json"), ...(await fileInfoWithPath(path.join(dataDir, "api-football-meta.json"))) },
        apiFootballCache: { publicPath: publicPathForData("api-football-cache.json"), ...(await fileInfoWithPath(path.join(dataDir, "api-football-cache.json"))) },
        syncWorkerStatus: await fileInfoWithPath(path.join(storeDir, "sync-worker-status.json")),
        sqlite: await fileInfoWithPath(sqliteDbPath)
      },
      crawlerErrors: {
        fiveHundred: {
          count: Number(source500Details.errors || fiveHundredDetails?.errors?.length || 0),
          recent: fiveHundredDetailErrors
        },
        weather: {
          count: Number(sourceWeather.errors || 0),
          recent: []
        },
        apiFootball: {
          count: apiFootballRecentErrors.length,
          recent: apiFootballRecentErrors
        },
        preMatch: {
          count: preMatchWarnings.length,
          recent: preMatchWarnings
        },
        health: {
          warnings: compactErrorList(health?.warnings || [], 12),
          errors: compactErrorList(health?.errors || [], 12)
        }
      },
      crawlerSources: {
        sporttery: {
          source: syncMeta?.source || null,
          updatedAt: syncMeta?.updatedAt || syncMeta?.capturedAt || null,
          lastAttemptAt: syncMeta?.lastAttemptAt || null,
          officialOddsMatches: syncMeta?.officialOddsMatches || 0,
          officialHandicapOddsMatches: syncMeta?.officialHandicapOddsMatches || 0,
          skippedWithoutOfficialOdds: syncMeta?.skippedWithoutOfficialOdds || 0,
          attempt: syncMeta?.attempt || null
        },
        fiveHundred: {
          url: source500.url || source500Details.url || fiveHundredDetails?.url || null,
          updatedAt: source500.updatedAt || null,
          rows: source500.rows || 0,
          mapped: source500.mapped || 0,
          details: {
            updatedAt: source500Details.updatedAt || fiveHundredDetails?.updatedAt || null,
            scannedRows: source500Details.scannedRows || fiveHundredDetails?.scannedRows || 0,
            resultRows: source500Details.resultRows || fiveHundredDetails?.resultRows || 0,
            updated: source500Details.updated || fiveHundredDetails?.updated || 0,
            cachedMerged: source500Details.cachedMerged || fiveHundredDetails?.cachedMerged || 0,
            requestedPages: source500Details.requestedPages || fiveHundredDetails?.requestedPages || 0,
            refreshMinutes: source500Details.refreshMinutes || fiveHundredDetails?.refreshMinutes || 0,
            timeoutSeconds: source500Details.timeoutSeconds || fiveHundredDetails?.timeoutSeconds || 0,
            maxErrors: source500Details.maxErrors || fiveHundredDetails?.maxErrors || 0
          }
        },
        weather: {
          url: sourceWeather.url || null,
          provider: sourceWeather.provider || null,
          updatedAt: sourceWeather.updatedAt || null,
          rows: sourceWeather.rows || 0,
          mapped: sourceWeather.mapped || 0,
          skipped: sourceWeather.skipped || 0,
          maxAgeMinutes: sourceWeather.maxAgeMinutes || null,
          lookaheadDays: sourceWeather.lookaheadDays || null
        },
        apiFootball: {
          enabled: Boolean(health?.mode?.enableApiFootballSync),
          configured: Boolean(process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY),
          updatedAt: sourceApiFootball.updatedAt || apiFootballMeta?.finishedAt || null,
          callsThisSync: apiFootballMeta?.callsThisSync || 0,
          callsTodayEstimate: apiFootballMeta?.callsTodayEstimate || 0,
          fixtureDatesSkippedByAccess: apiFootballMeta?.fixtureDatesSkippedByAccess || 0,
          access: apiFootballMeta?.apiAccess?.fixtures || null,
          mappedSignals: sourceApiFootball.mappedSignals || apiFootballMeta?.signalsMapped || 0
        }
      },
      taskTimings: {
        workerStatusPath: path.join(storeDir, "sync-worker-status.json"),
        workerCheckedAt: syncWorkerStatus?.checkedAt || null,
        loop: Boolean(syncWorkerStatus?.loop),
        cadence: syncWorkerStatus?.cadence || null,
        lastCycle: syncWorkerStatus?.lastCycle || null,
        nextWakeAt: syncWorkerStatus?.nextWakeAt || null,
        serverLastSync: lastSync,
        lastDataPersist,
        lastDataCompact
      },
      thresholds: health?.thresholds || {},
      rawMode: health?.mode || {}
    }
  };
};

const getPublicV1Health = async () => {
  const health = await getHealth();
  const metaTime = currentMetaTime(health.meta);
  const maxAgeSeconds = Math.max(60, Number(process.env.V1_HEALTH_STALE_AFTER_SECONDS || 10 * 60));
  const ageSeconds = Number.isFinite(metaTime) ? Math.max(0, Math.floor((Date.now() - metaTime) / 1000)) : null;
  const dataFresh = ageSeconds !== null && ageSeconds <= maxAgeSeconds && Boolean(health.sources?.ok);
  const calibrationSample = Number(health.meta?.modelCalibration?.sample?.recommendationPool || 0);
  return {
    ok: Boolean(health.ok && dataFresh),
    apiVersion: "v1",
    service: health.service,
    checkedAt: health.checkedAt,
    status: {
      serviceOk: true,
      dataFresh,
      recommendationReliable: calibrationSample >= Number(process.env.MODEL_RELIABILITY_MIN_ROWS || 30)
    },
    sync: {
      running: Boolean(health.syncRunning),
      cron: health.api?.syncCron || "off",
      lastSync: health.lastSync,
      lastDataPersist: health.lastDataPersist,
      lastDataCompact: health.lastDataCompact
    },
    data: {
      source: health.meta?.source || null,
      updatedAt: health.meta?.updatedAt || health.meta?.capturedAt || null,
      ageSeconds,
      currentCount: health.meta?.files?.current || health.files?.current?.rows || 0,
      historyCount: health.meta?.files?.history || 0,
      currentRead: health.currentRead || null,
      staleAfterSeconds: maxAgeSeconds
    },
    storage: {
      sqlite: health.storage?.sqlite || null
    },
    model: {
      calibrationVersion: health.meta?.modelCalibration?.version || null,
      trainingSignature: health.meta?.historicalTraining?.signature || null,
      strategyVersion: health.meta?.modelStrategy?.version || null,
      recommendationSample: calibrationSample
    },
    sources: publicSourceHealth(health.sources)
  };
};

const compactMetricSummary = (metrics) => {
  if (!metrics || typeof metrics !== "object") return null;
  return {
    rows: metrics.rows ?? null,
    brier: metrics.brier ?? null,
    logLoss: metrics.logLoss ?? null,
    accuracy: metrics.accuracy ?? null,
    calibrationByConfidence: metrics.calibrationByConfidence || null
  };
};

const compactShadowCandidate = (candidate) => {
  if (!candidate || typeof candidate !== "object") return null;
  return {
    id: candidate.id || null,
    label: candidate.label || null,
    role: candidate.role || null,
    featureSet: Array.isArray(candidate.featureSet) ? candidate.featureSet.slice(0, 12) : [],
    metrics: compactMetricSummary(candidate.metrics),
    comparison: candidate.comparison || null,
    rolling: candidate.rolling || null
  };
};

const compactShadowCandidates = (shadowCandidates) => {
  if (!shadowCandidates || typeof shadowCandidates !== "object") return null;
  return {
    version: shadowCandidates.version || null,
    generatedAt: shadowCandidates.generatedAt || null,
    sample: shadowCandidates.sample || null,
    baselineId: shadowCandidates.baselineId || null,
    bestCandidateId: shadowCandidates.bestCandidateId || null,
    bestCandidate: compactShadowCandidate(shadowCandidates.bestCandidate),
    summary: shadowCandidates.summary || null,
    selectionPolicy: shadowCandidates.selectionPolicy || null,
    policy: shadowCandidates.policy || null,
    publicView: true,
    hiddenFields: ["candidates", "weights", "internalSampleRows"]
  };
};

const compactStrategyForPublic = (strategy) => {
  if (!strategy || typeof strategy !== "object") return null;
  return {
    version: strategy.version || null,
    generatedAt: strategy.generatedAt || null,
    activation: strategy.activation || null,
    sample: strategy.sample || null,
    publicView: true,
    hiddenFields: ["activeGates", "recommendations", "internalRuleWeights"]
  };
};

const getModelEvaluation = async ({ admin = false } = {}) => {
  const [evaluation, calibration, strategy, meta] = await Promise.all([
    readJsonFile(path.join(dataDir, "model-evaluation.json"), null),
    readJsonFile(path.join(dataDir, "model-calibration.json"), null),
    readJsonFile(path.join(dataDir, "model-strategy.json"), null),
    readJsonFile(path.join(dataDir, "sync-meta.json"), null)
  ]);
  return {
    ok: true,
    apiVersion: "v1",
    checkedAt: nowIso(),
    generatedAt: evaluation?.generatedAt || calibration?.generatedAt || strategy?.generatedAt || null,
    backtest: evaluation ? {
      version: evaluation.version || null,
      generatedAt: evaluation.generatedAt || null,
      source: evaluation.source || null,
      sample: evaluation.sample || null,
      probabilityMetrics: evaluation.probabilityMetrics || null,
      marketBaseline: evaluation.marketBaseline || null,
      closingLineValue: evaluation.closingLineValue || null,
      rollingWindows: evaluation.rollingWindows || [],
      shadowCandidates: admin ? (evaluation.shadowCandidates || null) : compactShadowCandidates(evaluation.shadowCandidates),
      recommendationMetrics: evaluation.recommendationMetrics || null,
      policy: evaluation.policy || null
    } : null,
    calibration: {
      version: calibration?.version || null,
      sample: calibration?.sample || null,
      metrics: calibration?.metrics || null,
      scoreCalibration: calibration?.scoreCalibration ? {
        version: calibration.scoreCalibration.version,
        sample: calibration.scoreCalibration.sample,
        reasons: calibration.scoreCalibration.reasons || []
      } : null
    },
    strategy: admin ? (strategy ? {
      version: strategy.version || null,
      generatedAt: strategy.generatedAt || null,
      activation: strategy.activation || null,
      sample: strategy.sample || null,
      activeGates: strategy.activeGates || null,
      recommendations: strategy.recommendations || []
    } : null) : compactStrategyForPublic(strategy),
    training: meta?.historicalTraining || null,
    policy: {
      baselineRequired: "market-implied probability remains the benchmark",
      splitPolicy: "time-ordered rolling backtests only",
      llmRole: "risk review and explanation only"
    },
    ...(admin ? {
      admin: {
        detail: true,
        includesInternalCandidates: Boolean(evaluation?.shadowCandidates?.candidates),
        includesStrategyRules: Boolean(strategy?.activeGates || strategy?.recommendations)
      }
    } : {
      publicView: true,
      hiddenFields: ["backtest.shadowCandidates.candidates", "strategy.activeGates", "strategy.recommendations"]
    })
  };
};

const sendFile = async (res, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const stat = await fsp.stat(filePath);
    const request = res.__request;
    const acceptEncoding = String(request?.headers?.["accept-encoding"] || "");
    const contentType = mimeTypes[ext] || "application/octet-stream";
    const shouldGzip = request?.method !== "HEAD"
      && stat.size >= 1024
      && isCompressibleType(contentType)
      && /\bgzip\b/i.test(acceptEncoding);
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, if-none-match, x-access-token",
      "access-control-expose-headers": "cache-control, etag",
      "cache-control": getStaticCacheControl(filePath, ext),
      "content-type": contentType,
      ...(shouldGzip ? { "content-encoding": "gzip", "vary": "Accept-Encoding" } : { "content-length": stat.size })
    };
    res.writeHead(200, headers);
    if (request?.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) sendJson(res, { ok: false, error: "not found" }, 404);
      else res.destroy();
    });
    return shouldGzip ? stream.pipe(zlib.createGzip()).pipe(res) : stream.pipe(res);
  } catch {
    sendJson(res, { ok: false, error: "not found" }, 404);
  }
};

const parseLimit = (value, fallback = 50, max = 200) => {
  return Math.max(1, Math.min(max, Number(value || fallback)));
};

const decodeCursor = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  try {
    const decoded = safeJsonParse(Buffer.from(raw, "base64url").toString("utf8"), null);
    return Math.max(0, Number(decoded?.offset || 0));
  } catch {
    return 0;
  }
};

const encodeCursor = (offset) => {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
};

const paginateRows = (rows, url, fallbackLimit = 50, maxLimit = 200) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const limit = parseLimit(url.searchParams.get("limit"), fallbackLimit, maxLimit);
  let offset = decodeCursor(url.searchParams.get("cursor"));
  const cursorId = url.searchParams.get("cursorId");
  if (cursorId) {
    const index = sourceRows.findIndex((row) => row?.id === cursorId || row?.sourceMatchId === cursorId);
    if (index >= 0) offset = index + 1;
  }
  const safeOffset = Math.min(offset, sourceRows.length);
  const pageRows = sourceRows.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageRows.length;
  return {
    rows: pageRows,
    pageInfo: {
      limit,
      count: pageRows.length,
      nextCursor: nextOffset < sourceRows.length ? encodeCursor(nextOffset) : null,
      hasMore: nextOffset < sourceRows.length,
      totalAvailable: sourceRows.length
    }
  };
};

const buildV1CurrentPayload = async (url) => {
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const sqliteCacheToken = await sqliteReadCacheToken(meta);
  const cacheKey = [
    meta?.updatedAt || meta?.capturedAt || "no-version",
    sqliteCacheToken,
    url.searchParams.get("view") || "list",
    url.searchParams.get("since") || ""
  ].join(":");
  const now = Date.now();
  const cached = v1CurrentPayloadCache.get(cacheKey);
  if (cached && now - cached.createdAt <= 5_000) return cached.payload;
  if (v1CurrentPayloadInflight.has(cacheKey)) return v1CurrentPayloadInflight.get(cacheKey);

  const promise = (async () => {
    const detail = await readCurrentMatchesDetailed();
    const rows = url.searchParams.get("view") === "full"
      ? detail.rows
      : detail.rows.map(compactMatchForList);
    const versionTime = meta?.updatedAt || meta?.capturedAt || detail.fileUpdatedAt || null;
    const sinceTime = Date.parse(url.searchParams.get("since") || "");
    const versionMs = Date.parse(versionTime || "");
    const payload = {
      ok: true,
      apiVersion: "v1",
      version: versionTime,
      notModified: Number.isFinite(sinceTime) && Number.isFinite(versionMs) && sinceTime >= versionMs,
      sourceUpdatedAt: versionTime,
      stale: Boolean(meta?.api?.stale),
      dataSource: detail.source,
      currentRead: {
        source: detail.source,
        count: detail.count,
        dbUpdatedAt: detail.dbUpdatedAt,
        fileUpdatedAt: detail.fileUpdatedAt,
        checkedAt: versionTime || detail.checkedAt
      },
      rows
    };
    v1CurrentPayloadCache.set(cacheKey, { createdAt: Date.now(), payload });
    while (v1CurrentPayloadCache.size > 20) {
      const oldestKey = v1CurrentPayloadCache.keys().next().value;
      v1CurrentPayloadCache.delete(oldestKey);
    }
    return payload;
  })();
  v1CurrentPayloadInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    v1CurrentPayloadInflight.delete(cacheKey);
  }
};

const buildV1HistoryPayload = async (url) => {
  const meta = await readJsonFile(path.join(dataDir, "sync-meta.json"), null);
  const versionTime = meta?.updatedAt || meta?.capturedAt || null;
  const sqliteCacheToken = await sqliteReadCacheToken(meta);
  const cacheKey = [
    versionTime || "no-version",
    sqliteCacheToken,
    url.searchParams.get("cursor") || "",
    url.searchParams.get("cursorId") || "",
    url.searchParams.get("limit") || "50"
  ].join(":");
  const now = Date.now();
  const cached = v1HistoryPayloadCache.get(cacheKey);
  if (cached && now - cached.createdAt <= 30_000) return cached.payload;
  if (v1HistoryPayloadInflight.has(cacheKey)) return v1HistoryPayloadInflight.get(cacheKey);

  const promise = (async () => {
    const detail = await readHistoryMatchesForListDetailed(1200);
    const page = paginateRows(detail.rows, url, 50, 200);
    const payload = {
      ok: true,
      apiVersion: "v1",
      version: versionTime,
      sourceUpdatedAt: versionTime,
      stale: Boolean(meta?.api?.stale),
      source: detail.source,
      dbUpdatedAt: detail.dbUpdatedAt || null,
      ...page
    };
    v1HistoryPayloadCache.set(cacheKey, { createdAt: Date.now(), payload });
    while (v1HistoryPayloadCache.size > 50) {
      const oldestKey = v1HistoryPayloadCache.keys().next().value;
      v1HistoryPayloadCache.delete(oldestKey);
    }
    return payload;
  })();
  v1HistoryPayloadInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    v1HistoryPayloadInflight.delete(cacheKey);
  }
};

const buildV1MatchPayload = async (matchId) => {
  const decodedId = decodeURIComponent(matchId || "");
  const [meta, gptMtime] = await Promise.all([
    readJsonFile(path.join(dataDir, "sync-meta.json"), null),
    fileMtimeMs(path.join(dataDir, "gpt-predictions.json"))
  ]);
  const versionTime = meta?.updatedAt || meta?.capturedAt || null;
  const sqliteCacheToken = await sqliteReadCacheToken(meta);
  const cacheKey = [decodedId, versionTime || "no-version", sqliteCacheToken, gptMtime || 0].join(":");
  const now = Date.now();
  const cached = v1MatchPayloadCache.get(cacheKey);
  if (cached && now - cached.createdAt <= 10_000) return cached.payload;
  if (v1MatchPayloadInflight.has(cacheKey)) return v1MatchPayloadInflight.get(cacheKey);

  const promise = (async () => {
    const [match, sources] = await Promise.all([
      readMatchById(decodedId),
      getSourceHealth().catch(() => null)
    ]);
    if (!match) return null;
    const payload = {
      ok: true,
      apiVersion: "v1",
      version: versionTime,
      sourceUpdatedAt: versionTime,
      stale: Boolean(meta?.api?.stale),
      predictionLock: {
        lockedAt: match.predictionMeta?.lockedAt || null,
        lockedReason: match.predictionMeta?.lockedReason || null,
        cutoffTime: match.predictionMeta?.cutoffTime || match.buyEndTime || null
      },
      sourceHealth: publicSourceHealth(sources),
      match
    };
    v1MatchPayloadCache.set(cacheKey, { createdAt: Date.now(), payload });
    while (v1MatchPayloadCache.size > 100) {
      const oldestKey = v1MatchPayloadCache.keys().next().value;
      v1MatchPayloadCache.delete(oldestKey);
    }
    return payload;
  })();
  v1MatchPayloadInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    v1MatchPayloadInflight.delete(cacheKey);
  }
};

const handleApi = async (req, res, url) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/api/access/verify") {
    if (req.method !== "POST") return sendJson(res, { ok: false, error: "method not allowed" }, 405);
    const body = await readRequestJson(req);
    const result = await verifyAccessCode(body.code);
    return sendJson(res, result, result.ok ? 200 : result.status || 401);
  }

  if (url.pathname === "/api/access/status") {
    const session = await getActiveRequestAccessSession(req, url);
    return sendJson(res, {
      ok: true,
      authorized: Boolean(session),
      expiresAt: session ? new Date(session.exp).toISOString() : null
    });
  }

  const accessCodeRevokeMatch = url.pathname.match(/^\/api\/admin\/access-codes\/([^/]+)\/revoke$/);
  if (accessCodeRevokeMatch) {
    if (!accessCodeAdminToken) {
      return sendJson(res, { ok: false, error: "access code admin token not configured" }, 503);
    }
    if (!isAccessCodeAdminAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    if (req.method !== "POST" && req.method !== "DELETE") {
      return sendJson(res, { ok: false, error: "method not allowed" }, 405);
    }
    const result = await revokeAccessCode(decodeURIComponent(accessCodeRevokeMatch[1]));
    return sendJson(res, result, result.ok ? 200 : result.status || 400);
  }

  if (url.pathname === "/api/admin/access-codes") {
    if (!accessCodeAdminToken) {
      return sendJson(res, { ok: false, error: "access code admin token not configured" }, 503);
    }
    if (!isAccessCodeAdminAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    if (req.method === "GET") {
      return sendJson(res, { ok: true, rows: await listAccessCodes() });
    }
    if (req.method === "POST") {
      const body = await readRequestJson(req);
      return sendJson(res, await createAccessCode({ label: body.label }));
    }
    return sendJson(res, { ok: false, error: "method not allowed" }, 405);
  }

  if (isProtectedApiPath(url.pathname) && !(await hasRecommendationAccess(req, url))) {
    return sendJson(res, { ok: false, error: "access code required" }, 401);
  }

  if (url.pathname === "/api/events") {
    if (!(await hasRecommendationAccess(req, url))) return sendJson(res, { ok: false, error: "access code required" }, 401);
    return handleEventStream(req, res);
  }

  if (url.pathname === "/api/v1/events") {
    if (!(await hasRecommendationAccess(req, url))) return sendJson(res, { ok: false, error: "access code required" }, 401);
    return handleEventStream(req, res);
  }

  if (url.pathname === "/api/v1/health") {
    return sendJsonCached(req, res, await getPublicV1Health(), { maxAgeSeconds: 5 });
  }

  if (url.pathname === "/api/v1/source-health") {
    const detail = url.searchParams.get("detail") === "admin";
    if (detail && !isAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    const health = await getSourceHealth();
    return sendJsonCached(req, res, detail ? await getAdminSourceHealth(health) : publicSourceHealth(health), { maxAgeSeconds: detail ? 0 : 10 });
  }

  if (url.pathname === "/api/v1/sync-meta") {
    return sendJsonCached(req, res, await readJsonFile(path.join(dataDir, "sync-meta.json"), null), { maxAgeSeconds: 5 });
  }

  if (url.pathname === "/api/v1/model/evaluation") {
    const detail = url.searchParams.get("detail") === "admin";
    if (detail && !isAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    return sendJsonCached(req, res, await getModelEvaluation({ admin: detail }), { maxAgeSeconds: detail ? 0 : 60 });
  }

  if (url.pathname === "/api/v1/matches/current") {
    return sendJsonCached(req, res, await buildV1CurrentPayload(url), { maxAgeSeconds: 5 });
  }

  if (url.pathname === "/api/v1/matches/history") {
    return sendJsonCached(req, res, await buildV1HistoryPayload(url), { maxAgeSeconds: 30 });
  }

  if (url.pathname === "/api/v1/odds/history") {
    return sendJsonCached(req, res, await readOddsHistoryPage(url), { maxAgeSeconds: 20 });
  }

  const v1MatchDetailRoute = url.pathname.match(/^\/api\/v1\/matches\/([^/]+)$/);
  if (v1MatchDetailRoute) {
    const payload = await buildV1MatchPayload(v1MatchDetailRoute[1]);
    return payload
      ? sendJsonCached(req, res, payload, { maxAgeSeconds: 10 })
      : sendJson(res, { ok: false, error: "match not found" }, 404);
  }

  if (url.pathname === "/api/health") {
    return sendJson(res, await getHealth());
  }

  if (url.pathname === "/api/data/sources") {
    return sendJson(res, await getSourceHealth());
  }

  if (url.pathname === "/api/matches/current") {
    const matches = await readCurrentMatches();
    return sendJson(res, url.searchParams.get("view") === "list" && Array.isArray(matches)
      ? matches.map(compactMatchForList)
      : matches);
  }

  if (url.pathname === "/api/matches/history") {
    return sendJson(res, await readHistoryMatchesForList(url.searchParams.get("limit") || 600));
  }

  if (url.pathname === "/api/odds/history") {
    return sendJson(res, await readOddsHistoryPage(url));
  }

  if (url.pathname === "/api/data/external-signals") {
    return sendJson(res, await readExternalSignalsPage(url));
  }

  if (url.pathname === "/api/data/five-hundred-details") {
    return sendJson(res, await readFiveHundredDetailsPage(url));
  }

  if (url.pathname.startsWith("/api/db/") && !isAuthorized(req, url)) {
    return sendJson(res, { ok: false, error: "unauthorized" }, 401);
  }

  const matchDetailRoute = url.pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (matchDetailRoute) {
    const match = await readMatchById(matchDetailRoute[1]);
    return match
      ? sendJson(res, match)
      : sendJson(res, { ok: false, error: "match not found" }, 404);
  }

  if (url.pathname === "/api/db/events") {
    return sendJson(res, {
      ok: true,
      rows: await readRecentEvents(url.searchParams.get("limit") || 80, url.searchParams.get("type") || "")
    });
  }

  if (url.pathname === "/api/db/status") {
    return sendJson(res, await getDataStoreStatus(storeDir));
  }

  if (url.pathname === "/api/db/sync-runs") {
    return sendJson(res, {
      ok: true,
      rows: await readDataStoreRows(storeDir, TABLES.syncRuns, {
        limit: url.searchParams.get("limit") || 80
      })
    });
  }

  if (url.pathname === "/api/db/match-snapshots") {
    return sendJson(res, {
      ok: true,
      rows: await readDataStoreRows(storeDir, TABLES.matchSnapshots, {
        limit: url.searchParams.get("limit") || 120,
        matchId: url.searchParams.get("matchId") || "",
        sourceMatchId: url.searchParams.get("sourceMatchId") || ""
      })
    });
  }

  if (url.pathname === "/api/db/odds-snapshots") {
    return sendJson(res, {
      ok: true,
      rows: await readDataStoreRows(storeDir, TABLES.oddsSnapshots, {
        limit: url.searchParams.get("limit") || 120,
        matchId: url.searchParams.get("matchId") || "",
        sourceMatchId: url.searchParams.get("sourceMatchId") || "",
        pool: url.searchParams.get("pool") || ""
      })
    });
  }

  if (url.pathname === "/api/db/prediction-runs") {
    return sendJson(res, {
      ok: true,
      rows: await readDataStoreRows(storeDir, TABLES.predictionRuns, {
        limit: url.searchParams.get("limit") || 120,
        matchId: url.searchParams.get("matchId") || "",
        sourceMatchId: url.searchParams.get("sourceMatchId") || ""
      })
    });
  }

  const matchHistoryRoute = url.pathname.match(/^\/api\/matches\/([^/]+)\/timeline$/);
  if (matchHistoryRoute) {
    return sendJson(res, {
      ok: true,
      matchId: decodeURIComponent(matchHistoryRoute[1]),
      rows: await getMatchTimeline(storeDir, decodeURIComponent(matchHistoryRoute[1]), url.searchParams.get("limit") || 120)
    });
  }

  if (url.pathname === "/api/analytics/summary") {
    return sendJson(res, {
      ok: true,
      checkedAt: nowIso(),
      calibration: await readJsonFile(path.join(dataDir, "model-calibration.json"), null),
      syncMeta: await readJsonFile(path.join(dataDir, "sync-meta.json"), null),
      gptPredictions: await readGptPredictions(),
      database: await getDataStoreStatus(storeDir),
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

  if (url.pathname === "/api/admin/model/run") {
    if (req.method !== "POST") return sendJson(res, { ok: false, error: "method not allowed" }, 405);
    if (!isAuthorized(req, url)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    const body = await readRequestJson(req);
    return sendJson(res, await runGptPredictions({
      source: "server-model-manual",
      matchIds: Array.isArray(body.matchIds) ? body.matchIds : [],
      limit: body.limit || 8
    }));
  }

  const filePath = apiFiles[url.pathname];
  if (filePath) return sendFile(res, filePath);

  return sendJson(res, { ok: false, error: "unknown api resource" }, 404);
};

const handleRuntimeConfig = (res) => {
  return sendJson(res, {
    dataApiBase: publicApiV1Base,
    legacyDataApiBase: publicApiBase,
    eventStreamPath: `${publicApiV1Base}/events`,
    preferDataApi: true,
    historyPreferStatic: false,
    currentPollSeconds: Number(process.env.PAGE_POLL_SECONDS || 20),
    access: {
      required: true,
      ttlSeconds: accessCodeTtlSeconds
    }
  });
};

const handleStatic = async (req, res, url) => {
  if (url.pathname === "/data/runtime-config.json") return handleRuntimeConfig(res);

  const pathname = decodeURIComponent(url.pathname);
  const disabledLargeStaticPayloads = new Map([
    ["/matches.json", "/api/v1/matches/current?view=list"],
    ["/data/matches-current.json", "/api/v1/matches/current?view=list"],
    ["/data/matches-history.json", "/api/v1/matches/history?limit=50"],
    ["/data/odds-history.json", "/api/v1/odds/history?limit=200"],
    ["/odds-history.json", "/api/v1/odds/history?limit=200"],
    ["/data/post-match-reviews.json", "/api/v1/matches/{matchId}"],
    ["/data/external-signals.json", "/api/v1/source-health"],
    ["/data/five-hundred-details.json", "/api/v1/source-health"],
    ["/data/prediction-snapshots.json", "/api/v1/model/evaluation"],
    ["/data/model-calibration.json", "/api/v1/model/evaluation"],
    ["/data/model-strategy.json", "/api/v1/model/evaluation"],
    ["/data/gpt-predictions.json", "/api/v1/model/evaluation"]
  ]);
  const replacementApi = disabledLargeStaticPayloads.get(pathname);
  if (replacementApi) {
    return sendJson(res, {
      ok: false,
      error: "large static payload disabled",
      use: replacementApi
    }, 410);
  }

  if (isProtectedStaticDataPath(pathname) && !(await hasRecommendationAccess(req, url))) {
    return sendJson(res, { ok: false, error: "access code required" }, 401);
  }

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
  res.__request = req;
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
    console.log(`[football-server] access-code admin protected: ${accessCodeAdminToken ? "yes" : "no"}`);
  });
  startTimers();
});
