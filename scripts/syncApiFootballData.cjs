const fs = require("fs");
const https = require("https");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const CURRENT_MATCHES_FILE = path.join(DATA_DIR, "matches-current.json");
const FALLBACK_MATCHES_FILE = path.join(PUBLIC_DIR, "matches.json");
const EXTERNAL_SIGNALS_FILE = path.join(DATA_DIR, "external-signals.json");
const CACHE_FILE = path.join(DATA_DIR, "api-football-cache.json");
const META_FILE = path.join(DATA_DIR, "api-football-meta.json");

const API_BASE = (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || "";
const ENABLED = process.env.ENABLE_API_FOOTBALL_SYNC !== "0";
const TIME_ZONE = process.env.API_FOOTBALL_TIMEZONE || "Asia/Shanghai";
const MAX_CALLS_PER_SYNC = Math.max(0, Number(process.env.API_FOOTBALL_MAX_CALLS_PER_SYNC || 35));
const LOOKAHEAD_DAYS = Math.max(1, Number(process.env.API_FOOTBALL_LOOKAHEAD_DAYS || 7));
const LOOKBACK_HOURS = Math.max(0, Number(process.env.API_FOOTBALL_LOOKBACK_HOURS || 8));
const FIXTURE_SEARCH_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_FIXTURE_SEARCH_REFRESH_MINUTES || 720));
const ACCESS_ERROR_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_ACCESS_ERROR_REFRESH_MINUTES || 120));
const INJURY_LOOKAHEAD_HOURS = Math.max(1, Number(process.env.API_FOOTBALL_INJURY_LOOKAHEAD_HOURS || 48));
const INJURY_REFRESH_MINUTES = Math.max(60, Number(process.env.API_FOOTBALL_INJURY_REFRESH_MINUTES || 360));
const ODDS_LOOKAHEAD_HOURS = Math.max(1, Number(process.env.API_FOOTBALL_ODDS_LOOKAHEAD_HOURS || 48));
const ODDS_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_ODDS_REFRESH_MINUTES || 180));
const LINEUP_LOOKAHEAD_MINUTES = Math.max(15, Number(process.env.API_FOOTBALL_LINEUP_LOOKAHEAD_MINUTES || 90));
const LINEUP_LOOKBACK_MINUTES = Math.max(15, Number(process.env.API_FOOTBALL_LINEUP_LOOKBACK_MINUTES || 120));
const LINEUP_REFRESH_MINUTES = Math.max(10, Number(process.env.API_FOOTBALL_LINEUP_REFRESH_MINUTES || 20));
const MIN_MATCH_CONFIDENCE = Math.max(0.1, Math.min(1, Number(process.env.API_FOOTBALL_MIN_MATCH_CONFIDENCE || 0.74)));

const PREFERRED_BOOKMAKERS = (process.env.API_FOOTBALL_PREFERRED_BOOKMAKERS || "Bet365,10Bet,William Hill,1xBet,Marathonbet")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const TEAM_ALIASES = {
  "\u8377\u5170": ["netherlands", "holland"],
  "\u4e4c\u5179\u522b\u514b": ["uzbekistan"],
  "\u4e4c\u5179\u522b\u514b\u65af\u5766": ["uzbekistan"],
  "\u6cd5\u56fd": ["france"],
  "\u5317\u7231\u5c14\u5170": ["northern ireland"],
  "\u79d8\u9c81": ["peru"],
  "\u897f\u73ed\u7259": ["spain"],
  "\u4e2d\u56fd": ["china", "china pr"],
  "\u6cf0\u56fd": ["thailand"],
  "\u5308\u7259\u5229": ["hungary"],
  "\u54c8\u8428\u514b\u65af\u5766": ["kazakhstan"],
  "\u963f\u6839\u5ef7": ["argentina"],
  "\u51b0\u5c9b": ["iceland"],
  "\u8461\u8404\u7259": ["portugal"],
  "\u5c3c\u65e5\u5229\u4e9a": ["nigeria"],
  "\u82f1\u683c\u5170": ["england"],
  "\u54e5\u65af\u8fbe\u9ece\u52a0": ["costa rica"],
  "\u58a8\u897f\u54e5": ["mexico"],
  "\u5357\u975e": ["south africa"],
  "\u5df4\u897f": ["brazil"],
  "\u5fb7\u56fd": ["germany"],
  "\u610f\u5927\u5229": ["italy"],
  "\u6bd4\u5229\u65f6": ["belgium"],
  "\u745e\u58eb": ["switzerland"],
  "\u5965\u5730\u5229": ["austria"],
  "\u514b\u7f57\u5730\u4e9a": ["croatia"],
  "\u585e\u5c14\u7ef4\u4e9a": ["serbia"],
  "\u4e39\u9ea6": ["denmark"],
  "\u632a\u5a01": ["norway"],
  "\u745e\u5178": ["sweden"],
  "\u82ac\u5170": ["finland"],
  "\u6ce2\u5170": ["poland"],
  "\u6377\u514b": ["czech republic", "czechia"],
  "\u65af\u6d1b\u4f10\u514b": ["slovakia"],
  "\u65af\u6d1b\u6587\u5c3c\u4e9a": ["slovenia"],
  "\u7f57\u9a6c\u5c3c\u4e9a": ["romania"],
  "\u4fdd\u52a0\u5229\u4e9a": ["bulgaria"],
  "\u5e0c\u814a": ["greece"],
  "\u571f\u8033\u5176": ["turkey", "turkiye"],
  "\u7231\u5c14\u5170": ["republic of ireland", "ireland"],
  "\u82cf\u683c\u5170": ["scotland"],
  "\u5a01\u5c14\u58eb": ["wales"],
  "\u4e4c\u514b\u5170": ["ukraine"],
  "\u4fc4\u7f57\u65af": ["russia"],
  "\u7f8e\u56fd": ["usa", "united states"],
  "\u52a0\u62ff\u5927": ["canada"],
  "\u4e4c\u62c9\u572d": ["uruguay"],
  "\u54e5\u4f26\u6bd4\u4e9a": ["colombia"],
  "\u667a\u5229": ["chile"],
  "\u5384\u74dc\u591a\u5c14": ["ecuador"],
  "\u5df4\u62c9\u572d": ["paraguay"],
  "\u6fb3\u5927\u5229\u4e9a": ["australia"],
  "\u65b0\u897f\u5170": ["new zealand"],
  "\u65e5\u672c": ["japan"],
  "\u97e9\u56fd": ["south korea", "korea republic"],
  "\u4f0a\u6717": ["iran"],
  "\u6c99\u7279": ["saudi arabia"],
  "\u5361\u5854\u5c14": ["qatar"],
  "\u6469\u6d1b\u54e5": ["morocco"],
  "\u7a81\u5c3c\u65af": ["tunisia"],
  "\u57c3\u53ca": ["egypt"],
  "\u585e\u5185\u52a0\u5c14": ["senegal"],
  "\u5580\u9ea6\u9686": ["cameroon"],
  "\u52a0\u7eb3": ["ghana"],
  "\u79d1\u7279\u8fea\u74e6": ["ivory coast", "cote d'ivoire"],
  "\u963f\u5c14\u53ca\u5229\u4e9a": ["algeria"],
  "\u5229\u7269\u6d66": ["liverpool"],
  "\u66fc\u57ce": ["manchester city", "man city"],
  "\u66fc\u5f7b\u65af\u7279\u57ce": ["manchester city", "man city"],
  "\u66fc\u8054": ["manchester united", "man united"],
  "\u66fc\u5f7b\u65af\u7279\u8054": ["manchester united", "man united"],
  "\u963f\u68ee\u7eb3": ["arsenal"],
  "\u5207\u5c14\u897f": ["chelsea"],
  "\u70ed\u523a": ["tottenham", "tottenham hotspur", "spurs"],
  "\u6258\u7279\u7eb3\u59c6\u70ed\u523a": ["tottenham", "tottenham hotspur", "spurs"],
  "\u7687\u9a6c": ["real madrid"],
  "\u7687\u5bb6\u9a6c\u5fb7\u91cc": ["real madrid"],
  "\u5df4\u8428": ["barcelona"],
  "\u5df4\u585e\u7f57\u90a3": ["barcelona"],
  "\u9a6c\u7ade": ["atletico madrid", "atl madrid"],
  "\u9a6c\u5fb7\u91cc\u7ade\u6280": ["atletico madrid", "atl madrid"],
  "\u62dc\u4ec1": ["bayern munich", "bayern"],
  "\u62dc\u4ec1\u6155\u5c3c\u9ed1": ["bayern munich", "bayern"],
  "\u591a\u7279": ["borussia dortmund", "dortmund"],
  "\u591a\u7279\u8499\u5fb7": ["borussia dortmund", "dortmund"],
  "\u56fd\u7c73": ["inter", "inter milan"],
  "\u56fd\u9645\u7c73\u5170": ["inter", "inter milan"],
  "ac\u7c73\u5170": ["ac milan", "milan"],
  "\u5c24\u6587": ["juventus"],
  "\u5c24\u6587\u56fe\u65af": ["juventus"]
};

const LEAGUE_ALIASES = {
  "\u56fd\u9645\u8d5b": ["friendly", "friendlies", "international"],
  "\u4e16\u754c\u676f": ["world cup", "fifa world cup"],
  "\u4e16\u9884\u8d5b": ["world cup qualification", "world cup qualifiers"],
  "\u6b27\u51a0": ["uefa champions league", "champions league"],
  "\u6b27\u8054": ["uefa europa league", "europa league"],
  "\u82f1\u8d85": ["premier league"],
  "\u897f\u7532": ["la liga"],
  "\u5fb7\u7532": ["bundesliga"],
  "\u610f\u7532": ["serie a"],
  "\u6cd5\u7532": ["ligue 1"]
};

const nowIso = () => new Date().toISOString();

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const sleepMs = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const withFileRetry = (operation, label) => {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt < 5) sleepMs(80 + attempt * 120);
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
};

const readJsonFile = (file, fallback) => {
  try {
    return JSON.parse(withFileRetry(() => fs.readFileSync(file, "utf8"), `read ${file}`));
  } catch {
    return fallback;
  }
};

const writeJsonFile = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  withFileRetry(() => {
    fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tmpFile, file);
    } catch (error) {
      fs.copyFileSync(tmpFile, file);
      fs.unlinkSync(tmpFile);
      void error;
    }
  }, `write ${file}`);
};

const createCache = () => ({
  version: 1,
  updatedAt: null,
  fixtureMap: {},
  fixturesByDate: {},
  fixtureSignals: {},
  apiAccess: {},
  requestLedger: {
    date: "",
    count: 0,
    byEndpoint: {}
  },
  errors: []
});

const normalizeCache = (cache) => ({
  ...createCache(),
  ...(cache && typeof cache === "object" ? cache : {}),
  fixtureMap: cache?.fixtureMap && typeof cache.fixtureMap === "object" ? cache.fixtureMap : {},
  fixturesByDate: cache?.fixturesByDate && typeof cache.fixturesByDate === "object" ? cache.fixturesByDate : {},
  fixtureSignals: cache?.fixtureSignals && typeof cache.fixtureSignals === "object" ? cache.fixtureSignals : {},
  apiAccess: cache?.apiAccess && typeof cache.apiAccess === "object" ? cache.apiAccess : {},
  requestLedger: cache?.requestLedger && typeof cache.requestLedger === "object" ? cache.requestLedger : createCache().requestLedger,
  errors: Array.isArray(cache?.errors) ? cache.errors.slice(-30) : []
});

const dateKey = () => new Date().toISOString().slice(0, 10);

const ensureLedgerDate = (cache) => {
  const today = dateKey();
  if (cache.requestLedger.date !== today) {
    cache.requestLedger = { date: today, count: 0, byEndpoint: {} };
  }
};

const ageMinutes = (iso) => {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / 60000;
};

const isFresh = (iso, ttlMinutes) => ageMinutes(iso) < ttlMinutes;

const toNumber = (value) => {
  const number = Number(String(value ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(number) ? number : null;
};

const compactText = (value) => String(value || "").replace(/\s+/g, " ").trim();

const deburr = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const normalizeName = (value) => deburr(value)
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(fc|cf|sc|afc|club|football|soccer|team|national|women|men|u23|u21|u20|u19)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const uniq = (items) => Array.from(new Set(items.filter(Boolean)));

const aliasesFor = (value, aliasMap) => {
  const raw = compactText(value);
  const mapped = aliasMap[raw] || [];
  return uniq([raw, ...mapped, normalizeName(raw), ...mapped.map(normalizeName)])
    .map(normalizeName)
    .filter(Boolean);
};

const targetTeamAliases = (match, side) => {
  const primary = side === "home" ? match.homeTeamName : match.awayTeamName;
  const english = side === "home" ? match.homeTeamNameEn : match.awayTeamNameEn;
  return uniq([
    ...aliasesFor(primary, TEAM_ALIASES),
    ...aliasesFor(english, TEAM_ALIASES)
  ]);
};

const targetLeagueAliases = (match) => uniq([
  ...aliasesFor(match.leagueName, LEAGUE_ALIASES),
  ...aliasesFor(match.leagueNameEn, LEAGUE_ALIASES),
  normalizeName(match.leagueShortName),
  normalizeName(match.leagueShortNameEn)
]);

const nameScore = (targets, candidateName) => {
  const candidate = normalizeName(candidateName);
  if (!candidate || !targets.length) return 0;
  let best = 0;
  for (const target of targets) {
    if (!target) continue;
    if (target === candidate) best = Math.max(best, 1);
    else if (candidate.includes(target) || target.includes(candidate)) best = Math.max(best, 0.86);
    else {
      const a = new Set(target.split(" ").filter(Boolean));
      const b = new Set(candidate.split(" ").filter(Boolean));
      const hit = Array.from(a).filter((token) => b.has(token)).length;
      const denom = Math.max(a.size, b.size, 1);
      best = Math.max(best, hit / denom);
    }
  }
  return best;
};

const dateFromMatch = (match) => match.kickoffDate || String(match.kickoffTime || "").slice(0, 10) || match.matchDate || match.businessDate || "";

const matchKey = (match) => match.id || (match.sourceMatchId ? `sporttery_${match.sourceMatchId}` : "");

const sourceMatchIdFor = (match) => compactText(match.sourceMatchId || String(match.id || "").replace(/^sporttery_/, ""));

const externalSignalKeys = (match) => {
  const sourceMatchId = sourceMatchIdFor(match);
  const kickoffDate = dateFromMatch(match);
  return uniq([
    sourceMatchId,
    match.businessDate && match.matchNo ? `${match.businessDate}:${match.matchNo}` : "",
    kickoffDate && match.homeTeamName && match.awayTeamName ? `${kickoffDate}:${match.homeTeamName}:${match.awayTeamName}` : "",
    kickoffDate && match.homeTeam && match.awayTeam ? `${kickoffDate}:${match.homeTeam}:${match.awayTeam}` : ""
  ]);
};

const summarizeFixture = (item) => ({
  fixtureId: item?.fixture?.id || null,
  date: item?.fixture?.date || null,
  timestamp: item?.fixture?.timestamp || null,
  status: item?.fixture?.status || null,
  league: item?.league ? {
    id: item.league.id || null,
    name: item.league.name || null,
    country: item.league.country || null,
    season: item.league.season || null,
    round: item.league.round || null
  } : null,
  teams: item?.teams ? {
    home: {
      id: item.teams.home?.id || null,
      name: item.teams.home?.name || null,
      logo: item.teams.home?.logo || null
    },
    away: {
      id: item.teams.away?.id || null,
      name: item.teams.away?.name || null,
      logo: item.teams.away?.logo || null
    }
  } : null
});

const confidenceForFixture = (match, fixture) => {
  const homeTargets = targetTeamAliases(match, "home");
  const awayTargets = targetTeamAliases(match, "away");
  const leagueTargets = targetLeagueAliases(match);
  const homeScore = nameScore(homeTargets, fixture?.teams?.home?.name);
  const awayScore = nameScore(awayTargets, fixture?.teams?.away?.name);
  const reversedHomeScore = nameScore(homeTargets, fixture?.teams?.away?.name);
  const reversedAwayScore = nameScore(awayTargets, fixture?.teams?.home?.name);
  const directTeamScore = (homeScore + awayScore) / 2;
  const reversedTeamScore = (reversedHomeScore + reversedAwayScore) / 2 * 0.78;
  const teamScore = Math.max(directTeamScore, reversedTeamScore);

  const kickoffMs = Date.parse(match.kickoffTime || "");
  const fixtureMs = Date.parse(fixture?.date || "");
  const diffMinutes = Number.isFinite(kickoffMs) && Number.isFinite(fixtureMs)
    ? Math.abs(kickoffMs - fixtureMs) / 60000
    : 9999;
  const timeScore = diffMinutes <= 15
    ? 1
    : diffMinutes <= 45
      ? 0.88
      : diffMinutes <= 120
        ? 0.62
        : diffMinutes <= 240
          ? 0.36
          : 0;
  const leagueScore = Math.max(
    nameScore(leagueTargets, fixture?.league?.name),
    nameScore(leagueTargets, fixture?.league?.round),
    /international|friendly|world cup/i.test(`${match.leagueNameEn || ""} ${match.leagueName || ""}`)
      && /friendly|world cup|international/i.test(`${fixture?.league?.name || ""} ${fixture?.league?.round || ""}`)
      ? 0.82
      : 0
  );
  const confidence = teamScore * 0.52 + timeScore * 0.36 + leagueScore * 0.12;
  return {
    confidence: Number(confidence.toFixed(4)),
    teamScore: Number(teamScore.toFixed(4)),
    timeScore: Number(timeScore.toFixed(4)),
    leagueScore: Number(leagueScore.toFixed(4)),
    diffMinutes: Math.round(diffMinutes),
    reversed: reversedTeamScore > directTeamScore
  };
};

const isEligibleMatch = (match) => {
  const kickoffMs = Date.parse(match.kickoffTime || "");
  if (!Number.isFinite(kickoffMs)) return false;
  const deltaHours = (kickoffMs - Date.now()) / 3600000;
  if (deltaHours < -LOOKBACK_HOURS) return false;
  if (deltaHours > LOOKAHEAD_DAYS * 24) return false;
  return ["SCHEDULED", "LIVE", "PENDING_RESULT"].includes(String(match.status || "").toUpperCase());
};

const dueByMinutes = (cacheIso, ttlMinutes) => !cacheIso || !isFresh(cacheIso, ttlMinutes);

const fixtureWindowHours = (match) => {
  const kickoffMs = Date.parse(match.kickoffTime || "");
  if (!Number.isFinite(kickoffMs)) return Infinity;
  return (kickoffMs - Date.now()) / 3600000;
};

const shouldFetchInjuries = (match, signalState) => {
  const hours = fixtureWindowHours(match);
  return hours <= INJURY_LOOKAHEAD_HOURS
    && hours >= -LOOKBACK_HOURS
    && dueByMinutes(signalState?.injuriesFetchedAt, INJURY_REFRESH_MINUTES);
};

const shouldFetchOdds = (match, signalState) => {
  const hours = fixtureWindowHours(match);
  return hours <= ODDS_LOOKAHEAD_HOURS
    && hours >= -1
    && dueByMinutes(signalState?.oddsFetchedAt, ODDS_REFRESH_MINUTES);
};

const shouldFetchLineups = (match, signalState) => {
  const minutes = fixtureWindowHours(match) * 60;
  return minutes <= LINEUP_LOOKAHEAD_MINUTES
    && minutes >= -LINEUP_LOOKBACK_MINUTES
    && dueByMinutes(signalState?.lineupsFetchedAt, LINEUP_REFRESH_MINUTES);
};

const parseDateRangeHint = (message) => {
  const match = String(message || "").match(/try from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/i);
  if (!match) return null;
  return { from: match[1], to: match[2] };
};

const rememberFixtureAccessError = (cache, error) => {
  const message = error?.message || String(error);
  const previous = cache.apiAccess?.fixtures || {};
  const next = {
    ...previous,
    updatedAt: nowIso(),
    reason: message
  };
  if (/account is suspended|suspended/i.test(message)) {
    next.suspended = true;
  }
  const range = parseDateRangeHint(message);
  if (range) {
    next.allowedFrom = range.from;
    next.allowedTo = range.to;
  }
  cache.apiAccess = {
    ...(cache.apiAccess || {}),
    fixtures: next
  };
};

const fixtureAccessSkipReason = (cache, date) => {
  const access = cache.apiAccess?.fixtures;
  if (!access || !isFresh(access.updatedAt, ACCESS_ERROR_REFRESH_MINUTES)) return "";
  if (access.suspended) {
    return access.reason || "API-Football fixtures skipped because account access is suspended.";
  }
  if (access.allowedFrom && access.allowedTo && (date < access.allowedFrom || date > access.allowedTo)) {
    return `API-Football fixtures skipped for ${date}; plan allows ${access.allowedFrom} to ${access.allowedTo}.`;
  }
  return "";
};

const appendError = (cache, error) => {
  cache.errors.push({
    at: nowIso(),
    message: error?.message || String(error)
  });
  cache.errors = cache.errors.slice(-30);
};

const formatApiErrors = (errors) => {
  if (!errors) return [];
  if (Array.isArray(errors)) {
    return errors.map((item) => String(item)).filter(Boolean);
  }
  if (typeof errors === "string") {
    return errors ? [errors] : [];
  }
  if (typeof errors === "object") {
    return Object.entries(errors)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .filter(Boolean);
  }
  return [String(errors)].filter(Boolean);
};

const apiGet = (cache, endpoint, params = {}) => new Promise((resolve, reject) => {
  ensureLedgerDate(cache);
  if (cache.requestLedger.count >= MAX_CALLS_PER_SYNC) {
    reject(new Error(`API_FOOTBALL_MAX_CALLS_PER_SYNC reached (${MAX_CALLS_PER_SYNC})`));
    return;
  }

  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const req = https.request(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "x-apisports-key": API_KEY
    }
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      cache.requestLedger.count += 1;
      cache.requestLedger.byEndpoint[endpoint] = (cache.requestLedger.byEndpoint[endpoint] || 0) + 1;
      const payload = safeJsonParse(body, null);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`${endpoint} HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        return;
      }
      if (!payload) {
        reject(new Error(`${endpoint} returned invalid JSON`));
        return;
      }
      const apiErrors = formatApiErrors(payload.errors);
      if (apiErrors.length) {
        reject(new Error(`${endpoint} API error: ${apiErrors.join("; ")}`));
        return;
      }
      resolve({
        payload,
        rateLimit: {
          limit: res.headers["x-ratelimit-limit"] || null,
          remaining: res.headers["x-ratelimit-remaining"] || null,
          requestsLimit: res.headers["x-ratelimit-requests-limit"] || null,
          requestsRemaining: res.headers["x-ratelimit-requests-remaining"] || null
        }
      });
    });
  });

  req.setTimeout(20000, () => {
    req.destroy(new Error(`${endpoint} timeout`));
  });
  req.on("error", reject);
  req.end();
});

const fetchFixturesForDate = async (cache, date) => {
  const cached = cache.fixturesByDate[date];
  if (cached && isFresh(cached.fetchedAt, FIXTURE_SEARCH_REFRESH_MINUTES)) {
    return cached.fixtures || [];
  }

  const { payload, rateLimit } = await apiGet(cache, "/fixtures", { date, timezone: TIME_ZONE });
  const fixtures = Array.isArray(payload.response) ? payload.response.map(summarizeFixture).filter((item) => item.fixtureId) : [];
  cache.fixturesByDate[date] = {
    fetchedAt: nowIso(),
    count: fixtures.length,
    rateLimit,
    fixtures
  };
  return fixtures;
};

const resolveFixtureMaps = async (matches, cache, stats) => {
  const eligible = matches.filter(isEligibleMatch);
  const byDate = new Map();

  for (const match of eligible) {
    const key = matchKey(match);
    const cached = cache.fixtureMap[key];
    if (cached?.fixtureId && cached.confidence >= MIN_MATCH_CONFIDENCE) {
      stats.cachedFixtureMatches += 1;
      continue;
    }
    if (cached?.lastSearchAt && isFresh(cached.lastSearchAt, FIXTURE_SEARCH_REFRESH_MINUTES)) {
      continue;
    }
    const date = dateFromMatch(match);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(match);
  }

  for (const [date, dateMatches] of byDate.entries()) {
    const skipReason = fixtureAccessSkipReason(cache, date);
    if (skipReason) {
      stats.fixtureDatesSkippedByAccess += 1;
      continue;
    }

    let fixtures = [];
    try {
      fixtures = await fetchFixturesForDate(cache, date);
    } catch (error) {
      appendError(cache, error);
      rememberFixtureAccessError(cache, error);
      continue;
    }

    for (const match of dateMatches) {
      const key = matchKey(match);
      const ranked = fixtures
        .map((fixture) => ({
          fixture,
          score: confidenceForFixture(match, fixture)
        }))
        .sort((a, b) => b.score.confidence - a.score.confidence);
      const best = ranked[0];
      const previous = cache.fixtureMap[key] || {};
      if (best && best.score.confidence >= MIN_MATCH_CONFIDENCE && best.score.teamScore >= 0.54 && best.score.timeScore >= 0.36) {
        cache.fixtureMap[key] = {
          fixtureId: best.fixture.fixtureId,
          sportteryMatchId: key,
          sourceMatchId: sourceMatchIdFor(match),
          confidence: best.score.confidence,
          score: best.score,
          matchedAt: nowIso(),
          lastSearchAt: nowIso(),
          homeTeamName: best.fixture.teams?.home?.name || null,
          awayTeamName: best.fixture.teams?.away?.name || null,
          homeTeamId: best.fixture.teams?.home?.id || null,
          awayTeamId: best.fixture.teams?.away?.id || null,
          fixtureDate: best.fixture.date || null,
          leagueId: best.fixture.league?.id || null,
          leagueName: best.fixture.league?.name || null,
          season: best.fixture.league?.season || null
        };
        stats.newFixtureMatches += previous.fixtureId === best.fixture.fixtureId ? 0 : 1;
      } else {
        cache.fixtureMap[key] = {
          ...previous,
          sportteryMatchId: key,
          sourceMatchId: sourceMatchIdFor(match),
          confidence: best?.score?.confidence || 0,
          lastSearchAt: nowIso(),
          lowConfidenceCandidates: ranked.slice(0, 5).map((item) => ({
            fixtureId: item.fixture.fixtureId,
            homeTeamName: item.fixture.teams?.home?.name || null,
            awayTeamName: item.fixture.teams?.away?.name || null,
            fixtureDate: item.fixture.date || null,
            leagueName: item.fixture.league?.name || null,
            score: item.score
          }))
        };
        stats.lowConfidenceMatches += 1;
      }
    }
  }
};

const chunk = (items, size) => {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
};

const matchForFixtureId = (mappedMatches, fixtureId) => mappedMatches.find((entry) => Number(entry.map.fixtureId) === Number(fixtureId));

const formatPerson = (row) => {
  const player = row?.player?.name || "Unknown player";
  const type = row?.player?.type || row?.type || "";
  const reason = row?.player?.reason || row?.reason || "";
  return [player, type, reason].filter(Boolean).join(" - ");
};

const multi = (text) => ({ zh: text, en: text });

const buildInjuriesByFixture = (mappedMatches, response) => {
  const byFixture = new Map();
  for (const row of Array.isArray(response) ? response : []) {
    const fixtureId = row?.fixture?.id;
    if (!fixtureId) continue;
    const mapped = matchForFixtureId(mappedMatches, fixtureId);
    if (!mapped) continue;
    const homeApiTeamId = mapped.map.homeTeamId;
    const awayApiTeamId = mapped.map.awayTeamId;
    const teamId = row?.team?.id;
    const side = Number(teamId) === Number(homeApiTeamId)
      ? "home"
      : Number(teamId) === Number(awayApiTeamId)
        ? "away"
        : null;
    if (!side) continue;
    if (!byFixture.has(fixtureId)) byFixture.set(fixtureId, { home: [], away: [] });
    byFixture.get(fixtureId)[side].push(multi(formatPerson(row)));
  }

  const result = new Map();
  for (const [fixtureId, value] of byFixture.entries()) {
    result.set(String(fixtureId), {
      home: value.home.slice(0, 8),
      away: value.away.slice(0, 8),
      summary: multi(`API-FOOTBALL injuries: home ${value.home.length}, away ${value.away.length}.`)
    });
  }
  return result;
};

const fetchInjuries = async (mappedMatches, cache, stats, apiPieces) => {
  const due = mappedMatches
    .filter((entry) => shouldFetchInjuries(entry.match, cache.fixtureSignals[entry.map.fixtureId]))
    .map((entry) => entry.map.fixtureId);
  const uniqueIds = uniq(due.map(String));

  for (const ids of chunk(uniqueIds, 20)) {
    if (!ids.length) continue;
    try {
      const { payload, rateLimit } = await apiGet(cache, "/injuries", { ids: ids.join("-") });
      const byFixture = buildInjuriesByFixture(mappedMatches, payload.response);
      for (const fixtureId of ids) {
        cache.fixtureSignals[fixtureId] = {
          ...(cache.fixtureSignals[fixtureId] || {}),
          injuriesFetchedAt: nowIso(),
          injuriesRows: byFixture.get(String(fixtureId)) ? (
            (byFixture.get(String(fixtureId)).home || []).length + (byFixture.get(String(fixtureId)).away || []).length
          ) : 0,
          injuriesRateLimit: rateLimit
        };
        if (byFixture.has(String(fixtureId))) {
          apiPieces[String(fixtureId)] = {
            ...(apiPieces[String(fixtureId)] || {}),
            injuries: byFixture.get(String(fixtureId))
          };
        }
      }
      stats.injuryCalls += 1;
    } catch (error) {
      appendError(cache, error);
    }
  }
};

const buildLineups = (entry, response) => {
  const rows = Array.isArray(response) ? response : [];
  const home = rows.find((row) => Number(row?.team?.id) === Number(entry.map.homeTeamId));
  const away = rows.find((row) => Number(row?.team?.id) === Number(entry.map.awayTeamId));
  if (!home && !away) return null;
  const homeFormation = home?.formation || "";
  const awayFormation = away?.formation || "";
  const homeStart = Array.isArray(home?.startXI) ? home.startXI.length : 0;
  const awayStart = Array.isArray(away?.startXI) ? away.startXI.length : 0;
  return {
    homeFormation: homeFormation || undefined,
    awayFormation: awayFormation || undefined,
    summary: multi(`API-FOOTBALL lineups: ${homeFormation || "--"} / ${awayFormation || "--"}, starters ${homeStart}/${awayStart}.`)
  };
};

const fetchLineups = async (mappedMatches, cache, stats, apiPieces) => {
  const due = mappedMatches.filter((entry) => shouldFetchLineups(entry.match, cache.fixtureSignals[entry.map.fixtureId]));
  for (const entry of due) {
    const fixtureId = String(entry.map.fixtureId);
    try {
      const { payload, rateLimit } = await apiGet(cache, "/fixtures/lineups", { fixture: fixtureId });
      const lineups = buildLineups(entry, payload.response);
      cache.fixtureSignals[fixtureId] = {
        ...(cache.fixtureSignals[fixtureId] || {}),
        lineupsFetchedAt: nowIso(),
        lineupsRows: Array.isArray(payload.response) ? payload.response.length : 0,
        lineupsRateLimit: rateLimit
      };
      if (lineups) {
        apiPieces[fixtureId] = {
          ...(apiPieces[fixtureId] || {}),
          lineups
        };
      }
      stats.lineupCalls += 1;
    } catch (error) {
      appendError(cache, error);
    }
  }
};

const oddsValueKey = (value, entry) => {
  const raw = normalizeName(value?.value || value?.name || "");
  const home = normalizeName(entry.map.homeTeamName || entry.match.homeTeamName || "");
  const away = normalizeName(entry.map.awayTeamName || entry.match.awayTeamName || "");
  if (["home", "1", "team 1"].includes(raw) || (home && raw === home)) return "odds1";
  if (["draw", "x", "tie"].includes(raw)) return "oddsX";
  if (["away", "2", "team 2"].includes(raw) || (away && raw === away)) return "odds2";
  return "";
};

const pickOneXTwoOdds = (entry, oddsPayload) => {
  const rows = Array.isArray(oddsPayload) ? oddsPayload : [];
  const fixtureOdds = rows[0];
  const bookmakers = Array.isArray(fixtureOdds?.bookmakers) ? fixtureOdds.bookmakers : [];
  const sortedBookmakers = bookmakers.slice().sort((a, b) => {
    const ai = PREFERRED_BOOKMAKERS.indexOf(String(a?.name || "").toLowerCase());
    const bi = PREFERRED_BOOKMAKERS.indexOf(String(b?.name || "").toLowerCase());
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const bookmaker of sortedBookmakers) {
    const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
    const bet = bets.find((item) => /match winner|1x2|winner|fulltime result/i.test(String(item?.name || "")));
    const values = Array.isArray(bet?.values) ? bet.values : [];
    const odds = {};
    for (const value of values) {
      const key = oddsValueKey(value, entry);
      if (!key) continue;
      const number = toNumber(value.odd);
      if (number) odds[key] = number;
    }
    if (odds.odds1 && odds.oddsX && odds.odds2) {
      return {
        bookmaker: bookmaker.name || "API-FOOTBALL",
        bet: bet.name || "Match Winner",
        updatedAt: fixtureOdds?.update || nowIso(),
        odds
      };
    }
  }
  return null;
};

const fetchOdds = async (mappedMatches, cache, stats, apiPieces) => {
  const due = mappedMatches.filter((entry) => shouldFetchOdds(entry.match, cache.fixtureSignals[entry.map.fixtureId]));
  for (const entry of due) {
    const fixtureId = String(entry.map.fixtureId);
    try {
      const { payload, rateLimit } = await apiGet(cache, "/odds", { fixture: fixtureId });
      const oneXTwo = pickOneXTwoOdds(entry, payload.response);
      cache.fixtureSignals[fixtureId] = {
        ...(cache.fixtureSignals[fixtureId] || {}),
        oddsFetchedAt: nowIso(),
        oddsRows: Array.isArray(payload.response) ? payload.response.length : 0,
        oddsRateLimit: rateLimit
      };
      if (oneXTwo) {
        const summary = `API-FOOTBALL ${oneXTwo.bookmaker} 1X2: ${oneXTwo.odds.odds1.toFixed(2)} / ${oneXTwo.odds.oddsX.toFixed(2)} / ${oneXTwo.odds.odds2.toFixed(2)}.`;
        apiPieces[fixtureId] = {
          ...(apiPieces[fixtureId] || {}),
          apiFootballOdds: {
            source: "api-football",
            bookmaker: oneXTwo.bookmaker,
            bet: oneXTwo.bet,
            updatedAt: oneXTwo.updatedAt,
            had: oneXTwo.odds,
            summary: multi(summary)
          }
        };
      }
      stats.oddsCalls += 1;
    } catch (error) {
      appendError(cache, error);
    }
  }
};

const mergeSignal = (existing, apiSignal) => {
  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...apiSignal,
    source: existing?.source && existing.source !== "api-football"
      ? `${existing.source}+api-football`
      : "api-football",
    updatedAt: apiSignal.updatedAt || existing?.updatedAt || nowIso(),
    apiFootball: {
      ...(existing?.apiFootball || {}),
      ...(apiSignal.apiFootball || {})
    }
  };

  if (existing?.injuries && !apiSignal.injuries) next.injuries = existing.injuries;
  if (existing?.lineups && !apiSignal.lineups) next.lineups = existing.lineups;
  if (existing?.externalOdds && !apiSignal.externalOdds) next.externalOdds = existing.externalOdds;

  next.bookmakerOdds = {
    ...(existing?.bookmakerOdds || {})
  };

  if (apiSignal.bookmakerOdds) {
    next.bookmakerOdds = {
      ...next.bookmakerOdds,
      ...apiSignal.bookmakerOdds
    };
    if (!next.bookmakerOdds.had && apiSignal.bookmakerOdds.apiFootball?.had) {
      next.bookmakerOdds.had = {
        ...apiSignal.bookmakerOdds.apiFootball.had,
        source: "api-football"
      };
    }
  }

  return next;
};

const mergeExternalSignals = (matches, cache, apiPieces, stats) => {
  const existing = readJsonFile(EXTERNAL_SIGNALS_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const outputMatches = existing?.matches && typeof existing.matches === "object" && !Array.isArray(existing.matches)
    ? { ...existing.matches }
    : {};
  const updatedAt = nowIso();

  for (const match of matches) {
    const key = matchKey(match);
    const map = cache.fixtureMap[key];
    if (!map?.fixtureId || map.confidence < MIN_MATCH_CONFIDENCE) continue;
    const fixtureId = String(map.fixtureId);
    const pieces = apiPieces[fixtureId] || {};
    const apiFootballOdds = pieces.apiFootballOdds;
    const apiSignal = {
      updatedAt,
      apiFootball: {
        fixtureId: map.fixtureId,
        leagueId: map.leagueId,
        leagueName: map.leagueName,
        season: map.season,
        homeTeamId: map.homeTeamId,
        awayTeamId: map.awayTeamId,
        homeTeamName: map.homeTeamName,
        awayTeamName: map.awayTeamName,
        fixtureDate: map.fixtureDate,
        confidence: map.confidence,
        matchedAt: map.matchedAt || null,
        lastCheckedAt: updatedAt
      },
      ...(pieces.injuries ? { injuries: pieces.injuries } : {}),
      ...(pieces.lineups ? { lineups: pieces.lineups } : {}),
      ...(apiFootballOdds && !outputMatches[externalSignalKeys(match)[0]]?.externalOdds ? {
        externalOdds: {
          source: `api-football:${apiFootballOdds.bookmaker}`,
          odds1: apiFootballOdds.had.odds1,
          oddsX: apiFootballOdds.had.oddsX,
          odds2: apiFootballOdds.had.odds2,
          summary: apiFootballOdds.summary
        }
      } : {}),
      ...(apiFootballOdds ? {
        bookmakerOdds: {
          apiFootball: apiFootballOdds
        }
      } : {})
    };

    for (const signalKey of externalSignalKeys(match)) {
      outputMatches[signalKey] = mergeSignal(outputMatches[signalKey], apiSignal);
    }
    stats.signalsMapped += 1;
  }

  const sources = {
    ...(existing?.sources || {}),
    "api-football": {
      url: API_BASE,
      updatedAt,
      fixtureMatches: stats.cachedFixtureMatches + stats.newFixtureMatches,
      mappedSignals: stats.signalsMapped,
      callsThisSync: stats.callsThisSync,
      injuryCalls: stats.injuryCalls,
      lineupCalls: stats.lineupCalls,
      oddsCalls: stats.oddsCalls,
      maxCallsPerSync: MAX_CALLS_PER_SYNC
    }
  };

  const payload = {
    version: 1,
    source: "external-signals",
    updatedAt,
    sources,
    matches: outputMatches
  };
  writeJsonFile(EXTERNAL_SIGNALS_FILE, payload);
  return payload;
};

const writeMeta = (payload) => {
  writeJsonFile(META_FILE, {
    version: 1,
    source: "api-football",
    ...payload
  });
};

const main = async () => {
  const startedAt = nowIso();
  const cache = normalizeCache(readJsonFile(CACHE_FILE, null));
  ensureLedgerDate(cache);
  const startingCalls = cache.requestLedger.count;
  const stats = {
    ok: true,
    startedAt,
    finishedAt: null,
    configured: Boolean(API_KEY),
    enabled: ENABLED,
    matchCount: 0,
    eligibleMatches: 0,
    cachedFixtureMatches: 0,
    newFixtureMatches: 0,
    lowConfidenceMatches: 0,
    fixtureDatesSkippedByAccess: 0,
    mappedMatches: 0,
    signalsMapped: 0,
    injuryCalls: 0,
    lineupCalls: 0,
    oddsCalls: 0,
    callsThisSync: 0,
    maxCallsPerSync: MAX_CALLS_PER_SYNC,
    errors: []
  };

  if (!ENABLED || !API_KEY) {
    const skipped = {
      ...stats,
      ok: true,
      skipped: true,
      reason: !ENABLED ? "ENABLE_API_FOOTBALL_SYNC=0" : "API_FOOTBALL_KEY is not configured",
      finishedAt: nowIso()
    };
    writeMeta(skipped);
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const currentMatches = readJsonFile(CURRENT_MATCHES_FILE, readJsonFile(FALLBACK_MATCHES_FILE, []));
  const matches = Array.isArray(currentMatches) ? currentMatches : [];
  stats.matchCount = matches.length;
  stats.eligibleMatches = matches.filter(isEligibleMatch).length;

  try {
    await resolveFixtureMaps(matches, cache, stats);
    const mappedMatches = matches
      .filter(isEligibleMatch)
      .map((match) => ({ match, map: cache.fixtureMap[matchKey(match)] }))
      .filter((entry) => entry.map?.fixtureId && entry.map.confidence >= MIN_MATCH_CONFIDENCE);
    stats.mappedMatches = mappedMatches.length;

    const apiPieces = {};
    await fetchInjuries(mappedMatches, cache, stats, apiPieces);
    await fetchLineups(mappedMatches, cache, stats, apiPieces);
    await fetchOdds(mappedMatches, cache, stats, apiPieces);
    stats.callsThisSync = Math.max(0, cache.requestLedger.count - startingCalls);

    mergeExternalSignals(matches, cache, apiPieces, stats);
  } catch (error) {
    stats.ok = false;
    stats.errors.push(error.message || String(error));
    appendError(cache, error);
  } finally {
    cache.updatedAt = nowIso();
    writeJsonFile(CACHE_FILE, cache);
    const meta = {
      ...stats,
      callsThisSync: Math.max(0, cache.requestLedger.count - startingCalls),
      callsTodayEstimate: cache.requestLedger.count,
      requestLedger: cache.requestLedger,
      apiAccess: cache.apiAccess || {},
      recentErrors: cache.errors.slice(-8),
      finishedAt: nowIso()
    };
    writeMeta(meta);
    console.log(JSON.stringify(meta, null, 2));
  }
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
