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
  getLatestCurrentMatches,
  getMatchTimeline,
  persistDataSnapshot,
  readDataStoreRows
} = require("./dataStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(publicDir, "data");
const distDir = path.join(rootDir, "dist");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const snapshotsDir = path.join(storeDir, "snapshots");
const trainingIndexPaths = [
  path.join(storeDir, "training", "historical-training-index.json"),
  path.join(rootDir, "server-data", "training", "historical-training-index.json")
];

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "0.0.0.0";
const syncIntervalSeconds = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS || 300));
const gptIntervalSeconds = Math.max(300, Number(process.env.GPT_INTERVAL_SECONDS || 900));
const snapshotRetentionDays = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS || 30));
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
const enable500Sync = process.env.ENABLE_500_SYNC !== "0";
const enable500DetailsSync = process.env.ENABLE_500_DETAILS_SYNC === "1";
const enableWeatherSync = process.env.ENABLE_WEATHER_SYNC !== "0";
const enableApiFootballSync = process.env.ENABLE_API_FOOTBALL_SYNC === "1";
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
const sseClients = new Set();
let historyListCache = null;
let currentMatchesCache = null;
let sourceHealthCache = null;

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
  await fsp.appendFile(path.join(storeDir, "events.jsonl"), `${JSON.stringify(row)}\n`);
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
    "access-control-allow-headers": "authorization, content-type, x-access-token",
    "cache-control": "no-store",
    ...encoded.headers
  });
  res.end(res.__request?.method === "HEAD" ? undefined : encoded.body);
};

const sendJson = (res, payload, status = 200) => {
  send(res, status, JSON.stringify(payload, null, 2), {
    "content-type": "application/json; charset=utf-8"
  });
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
  const queryToken = url.searchParams.get("token");
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  return queryToken === adminToken || bearer === adminToken;
};

const isAccessCodeAdminAuthorized = (req, url) => {
  if (!accessCodeAdminToken) return false;
  const queryToken = url.searchParams.get("token");
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  return queryToken === accessCodeAdminToken || bearer === accessCodeAdminToken;
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

const hasRecommendationAccess = (req, url) => Boolean(getRequestAccessSession(req, url));

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
  "/api/data/api-football",
  "/api/analytics/summary"
]);

const isProtectedApiPath = (pathname) => {
  if (protectedApiPaths.has(pathname)) return true;
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
    lastSync = { ok: true, source, startedAt, finishedAt: nowIso(), dataStore: lastDataPersist };
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
    lastDataPersist = await persistDataSnapshot({
      storeDir,
      dataDir,
      source,
      sourceHealth: await getSourceHealth().catch((error) => ({
        ok: false,
        error: error.message || String(error)
      }))
    });
    lastPredictionRun = {
      ok: true,
      source,
      startedAt,
      finishedAt: nowIso(),
      requested: candidates.length,
      generated: results.length,
      dataStore: lastDataPersist
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

const mergeGptIntoMatches = async (matches) => {
  const gpt = await readGptPredictions();
  if (!Array.isArray(matches)) return matches;
  const byId = new Map((gpt.rows || []).map((row) => [row.matchId, row]));
  return matches.map((match) => {
    const gptPrediction = byId.get(match.id);
    return gptPrediction ? { ...match, gptPrediction } : match;
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

const readCurrentMatches = async () => {
  if (process.env.CURRENT_MATCH_SOURCE === "db") {
    const dbMatches = await getLatestCurrentMatches(storeDir);
    if (dbMatches.length > 0) {
      return mergeGptIntoMatches(dbMatches);
    }
  }
  const fileMatches = await readCurrentFileMatches();
  return mergeGptIntoMatches(fileMatches);
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

const compactMatchForList = (match) => ({
  ...match,
  probabilityModel: compactProbabilityModel(match.probabilityModel),
  predictionMeta: compactPredictionMeta(match.predictionMeta)
});

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
    : []
});

const readHistoryMatchesForList = async (limit = 600) => {
  if (process.env.ENABLE_HISTORY_LIST_API !== "1") {
    return [];
  }

  const filePath = path.join(dataDir, "matches-history.json");
  const safeLimit = Math.max(1, Math.min(1200, Number(limit || 600)));
  const stat = await fsp.stat(filePath);

  if (
    historyListCache
    && historyListCache.mtimeMs === stat.mtimeMs
    && historyListCache.limit >= safeLimit
  ) {
    return historyListCache.rows.slice(0, safeLimit);
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
  return rows;
};

const readMatchById = async (matchId) => {
  const decodedId = decodeURIComponent(matchId || "");
  const current = await readCurrentMatches();
  const currentMatch = Array.isArray(current) ? current.find((match) => match.id === decodedId) : null;
  if (currentMatch) return enrichMatchHistoricalTraining(currentMatch);

  const history = await readJsonFile(path.join(dataDir, "matches-history.json"), []);
  const historyMatch = Array.isArray(history) ? history.find((match) => match.id === decodedId) || null : null;
  return historyMatch ? enrichMatchHistoricalTraining(historyMatch) : null;
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

const getSourceHealth = async () => {
  const maxAgeMinutes = Math.max(1, Number(process.env.SOURCE_MAX_AGE_MINUTES || 20));
  const minExternalRows = Math.max(0, Number(process.env.SOURCE_MIN_500_ROWS || 1));
  const minExternalMapped = Math.max(0, Number(process.env.SOURCE_MIN_500_MAPPED || 1));
  const minCurrentMatches = Math.max(0, Number(process.env.SOURCE_MIN_CURRENT_MATCHES || 1));
  const minCurrentCoverage = Math.max(0, Math.min(1, Number(process.env.SOURCE_MIN_EXTERNAL_COVERAGE || 0.5)));
  const cacheKey = [
    await fileMtimeMs(path.join(dataDir, "external-signals.json")),
    await fileMtimeMs(path.join(dataDir, "api-football-meta.json")),
    await fileMtimeMs(path.join(dataDir, "matches-current.json")),
    requireExternalSignals ? "require" : "optional",
    maxAgeMinutes,
    minExternalRows,
    minExternalMapped,
    minCurrentMatches,
    minCurrentCoverage
  ].join(":");

  if (sourceHealthCache?.key === cacheKey) {
    return {
      ...sourceHealthCache.value,
      checkedAt: nowIso(),
      cached: true
    };
  }

  const external = await readJsonFile(path.join(dataDir, "external-signals.json"), null);
  const apiFootballMeta = await readJsonFile(path.join(dataDir, "api-football-meta.json"), null);
  const current = await readCurrentFileMatches();
  const externalMatches = external?.matches && typeof external.matches === "object" && !Array.isArray(external.matches)
    ? external.matches
    : {};
  const source500 = external?.sources?.["500.com:jczq"] || {};
  const source500Details = external?.sources?.["500.com:details"] || {};
  const sourceApiFootball = external?.sources?.["api-football"] || {};
  const externalCount = Object.keys(externalMatches).length;
  const externalAge = minutesSince(external?.updatedAt);
  const currentCount = Array.isArray(current) ? current.length : 0;
  const currentWithExternal = Array.isArray(current) ? current.filter(matchHasExternalSignal).length : 0;
  const currentWithFiveHundredDetails = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.fiveHundred)).length
    : 0;
  const currentWithApiFootball = Array.isArray(current)
    ? current.filter((match) => Boolean(match?.externalSignals?.apiFootball)).length
    : 0;
  const currentCoverage = currentCount > 0 ? currentWithExternal / currentCount : 0;
  const errors = [];

  if (requireExternalSignals) {
    if (!external) errors.push("external-signals missing");
    if (external && externalAge > maxAgeMinutes) errors.push(`external-signals stale ${externalAge.toFixed(1)}m`);
    if ((source500.rows || 0) < minExternalRows) errors.push(`500 rows ${source500.rows || 0} < ${minExternalRows}`);
    if ((source500.mapped || 0) < minExternalMapped) errors.push(`500 mapped ${source500.mapped || 0} < ${minExternalMapped}`);
    if (currentCount > 0 && currentCoverage < minCurrentCoverage) {
      errors.push(`external coverage ${(currentCoverage * 100).toFixed(1)}% < ${(minCurrentCoverage * 100).toFixed(1)}%`);
    }
  }
  if (!Array.isArray(current)) errors.push("current matches invalid");
  if (currentCount < minCurrentMatches) errors.push(`current matches ${currentCount} < ${minCurrentMatches}`);

  const health = {
    ok: errors.length === 0,
    checkedAt: nowIso(),
    cached: false,
    mode: {
      enable500Sync,
      enable500DetailsSync,
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
    },
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
    currentMatches: {
      count: currentCount,
      withExternalSignals: currentWithExternal,
      externalCoverage: Number(currentCoverage.toFixed(4)),
    },
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
  return {
    ok: sources.ok,
    service: "football-predict-server",
    checkedAt: nowIso(),
    syncRunning,
    predictRunning,
    lastSync,
    lastPredictionRun,
    lastDataPersist,
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
      gptCron: process.env.ENABLE_GPT_CRON === "1" ? `${gptIntervalSeconds}s` : "off"
    },
    memory: process.memoryUsage(),
    database: await getDataStoreStatus(storeDir),
    files: {
      current: await fileInfo(path.join(dataDir, "matches-current.json")),
      history: await fileInfo(path.join(dataDir, "matches-history.json")),
      meta: await fileInfo(path.join(dataDir, "sync-meta.json")),
      gptPredictions: await fileInfo(path.join(dataDir, "gpt-predictions.json"))
    },
    meta,
    sources,
    gptRows: Array.isArray(gpt.rows) ? gpt.rows.length : 0
  };
};

const sendFile = async (res, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const data = await fsp.readFile(filePath);
    send(res, 200, data, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": getStaticCacheControl(filePath, ext)
    });
  } catch {
    sendJson(res, { ok: false, error: "not found" }, 404);
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
    const session = getRequestAccessSession(req, url);
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

  if (isProtectedApiPath(url.pathname) && !hasRecommendationAccess(req, url)) {
    return sendJson(res, { ok: false, error: "access code required" }, 401);
  }

  if (url.pathname === "/api/events") {
    return handleEventStream(req, res);
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

  const filePath = apiFiles[url.pathname];
  if (filePath) return sendFile(res, filePath);

  return sendJson(res, { ok: false, error: "unknown api resource" }, 404);
};

const handleRuntimeConfig = (res) => {
  return sendJson(res, {
    dataApiBase: publicApiBase,
    eventStreamPath: `${publicApiBase}/events`,
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
  if (pathname === "/data/matches-history.json") {
    return sendJson(res, { ok: false, error: "history static payload disabled; use /api/matches/history" }, 410);
  }

  if (isProtectedStaticDataPath(pathname) && !hasRecommendationAccess(req, url)) {
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
