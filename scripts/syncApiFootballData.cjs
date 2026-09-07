const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const path = require("path");
const { fixtureTeamCategoryAudit } = require("./teamCategoryIdentity.cjs");
const {
  eventSafeExistingSignal,
  stampSignalEvent,
} = require("./externalSignalEventIdentity.cjs");
const {
  applyFixtureMappingEvidence,
  fixtureIdentityHashFor,
  loadEntityRegistry,
  providerIdentityScore,
  qualifyingFixtureMapping,
  stableStringify,
  writeEntityRegistryAtomic,
} = require("./entityResolutionRegistry.cjs");
const {
  API_FOOTBALL_SHADOW_MODE,
  apiFootballRuntimePolicyFor,
  configuredKeyFor,
} = require("../src/services/apiFootballRuntimePolicy.cjs");
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_DIR = path.resolve(process.env.API_FOOTBALL_DATA_DIR || path.join(PUBLIC_DIR, "data"));
const CURRENT_MATCHES_FILE = path.resolve(
  process.env.API_FOOTBALL_CURRENT_MATCHES_FILE || path.join(DATA_DIR, "matches-current.json"),
);
const FALLBACK_MATCHES_FILE = path.resolve(
  process.env.API_FOOTBALL_FALLBACK_MATCHES_FILE || path.join(PUBLIC_DIR, "matches.json"),
);
const EXTERNAL_SIGNALS_FILE = path.resolve(
  process.env.API_FOOTBALL_EXTERNAL_SIGNALS_FILE || path.join(DATA_DIR, "external-signals.json"),
);
const CACHE_FILE = path.resolve(
  process.env.API_FOOTBALL_CACHE_FILE || path.join(DATA_DIR, "api-football-cache.json"),
);
const META_FILE = path.resolve(
  process.env.API_FOOTBALL_META_FILE || path.join(DATA_DIR, "api-football-meta.json"),
);
const SERVER_STORE_DIR = path.resolve(process.env.SERVER_STORE_DIR || path.join(PROJECT_ROOT, "server-data"));
const ENTITY_REGISTRY_FILE = path.resolve(
  process.env.ENTITY_RESOLUTION_REGISTRY_FILE
    || path.join(SERVER_STORE_DIR, "entity-resolution", "team-registry.json")
);

const API_BASE = (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");
const API_KEY = configuredKeyFor(process.env);
const runtimePolicyFor = apiFootballRuntimePolicyFor;
const RUNTIME_POLICY = Object.freeze(runtimePolicyFor(process.env));
const ENABLED = RUNTIME_POLICY.enabled;
const TIME_ZONE = process.env.API_FOOTBALL_TIMEZONE || "Asia/Shanghai";
const maxCallsPerSyncFor = (env = {}) => {
  const raw = env.API_FOOTBALL_MAX_CALLS_PER_SYNC;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 12;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 12;
};
const MAX_CALLS_PER_SYNC = maxCallsPerSyncFor(process.env);
const LOOKAHEAD_DAYS = Math.max(1, Number(process.env.API_FOOTBALL_LOOKAHEAD_DAYS || 7));
const LOOKBACK_HOURS = Math.max(0, Number(process.env.API_FOOTBALL_LOOKBACK_HOURS || 8));
const FIXTURE_SEARCH_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_FIXTURE_SEARCH_REFRESH_MINUTES || 720));
const ACCESS_ERROR_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_ACCESS_ERROR_REFRESH_MINUTES || 120));
const STATUS_REFRESH_MINUTES = Math.max(5, Number(process.env.API_FOOTBALL_STATUS_REFRESH_MINUTES || 30));
const SUSPENSION_PROBE_MINUTES = Math.max(60, Number(process.env.API_FOOTBALL_SUSPENSION_PROBE_MINUTES || 1440));
const INJURY_LOOKAHEAD_HOURS = Math.max(1, Number(process.env.API_FOOTBALL_INJURY_LOOKAHEAD_HOURS || 48));
const INJURY_REFRESH_MINUTES = Math.max(60, Number(process.env.API_FOOTBALL_INJURY_REFRESH_MINUTES || 360));
const ODDS_LOOKAHEAD_HOURS = Math.max(1, Number(process.env.API_FOOTBALL_ODDS_LOOKAHEAD_HOURS || 48));
const ODDS_REFRESH_MINUTES = Math.max(30, Number(process.env.API_FOOTBALL_ODDS_REFRESH_MINUTES || 180));
const LINEUP_LOOKAHEAD_MINUTES = Math.max(15, Number(process.env.API_FOOTBALL_LINEUP_LOOKAHEAD_MINUTES || 90));
const LINEUP_LOOKBACK_MINUTES = Math.max(15, Number(process.env.API_FOOTBALL_LINEUP_LOOKBACK_MINUTES || 120));
const LINEUP_REFRESH_MINUTES = Math.max(10, Number(process.env.API_FOOTBALL_LINEUP_REFRESH_MINUTES || 20));
const MIN_MATCH_CONFIDENCE = Math.max(0.1, Math.min(1, Number(process.env.API_FOOTBALL_MIN_MATCH_CONFIDENCE || 0.74)));
const INJURIES_ENABLED = RUNTIME_POLICY.features.injuries;
const LINEUPS_ENABLED = RUNTIME_POLICY.features.lineups;
const ODDS_ENABLED = RUNTIME_POLICY.features.odds;
const LIVE_SCORE_ENABLED = RUNTIME_POLICY.features.liveScore;
const LIVE_SCORE_REFRESH_SECONDS = Math.max(10, Number(process.env.API_FOOTBALL_LIVE_SCORE_REFRESH_SECONDS || 30));
const LIVE_SCORE_PRE_KICKOFF_MINUTES = Math.max(0, Number(process.env.API_FOOTBALL_LIVE_SCORE_PRE_KICKOFF_MINUTES || 10));
const LIVE_SCORE_POST_KICKOFF_MINUTES = Math.max(120, Number(process.env.API_FOOTBALL_LIVE_SCORE_POST_KICKOFF_MINUTES || 210));
const LIVE_SCORE_CACHE_MAX_SECONDS = Math.max(60, Number(process.env.API_FOOTBALL_LIVE_SCORE_CACHE_MAX_SECONDS || 300));

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
  "\u5c24\u6587\u56fe\u65af": ["juventus"],
  "\u5df4\u9ece\u5723\u65e5\u5c14\u66fc": ["paris saint germain", "paris sg", "psg"],
  "\u963f\u65af\u987f\u7ef4\u62c9": ["aston villa"],
  "\u666e\u62c9\u6ed5\u65af": ["platense", "club atletico platense"],
  "\u79d1\u91d1\u535a\u8054": ["coquimbo unido", "coquimbo"],
  "\u5e15\u5c14\u6885\u62c9\u65af": ["palmeiras", "se palmeiras"],
  "\u6ce2\u7279\u8bfa\u5c71\u4e18": ["cerro porteno", "cerro porteno asuncion"],
  "\u6770\u5c14": ["eto fc gyor", "gyori eto", "gyor"],
  "\u96f7\u514b\u96c5\u672a\u514b\u7ef4\u4eac\u4eba": ["vikingur reykjavik", "vikingur r"],
  "\u65b0\u5723\u5f92": ["the new saints", "the new saints fc", "tns"],
  "\u8428\u5df4\u8d6b": ["sabah", "sabah fc"],
  "\u6bd4\u68ee\u963f\u6cf0\u5c14": ["atert bissen", "fc atert bissen"],
  "\u514b\u62c9\u514b\u65af\u7ef4\u514b": ["ki klaksvik", "klaksvik"],
  "\u82cf\u6377\u65af\u5361": ["sutjeska", "fk sutjeska", "sutjeska niksic"],
  "\u963f\u62c9\u6728\u56fe\u51ef\u62c9\u7279": ["kairat almaty", "fc kairat almaty", "kairat"],
  "\u74e6\u52d2\u4f26\u52a0": ["valerenga", "valerenga if"],
  "\u5965\u52d2\u677e": ["aalesund", "aalesunds fk"],
  "\u5fb7\u91cc\u57ce": ["derry city", "derry city fc"],
  "\u7d22\u83f2\u4e9a\u4e2d\u592e\u9646\u519b": ["cska sofia", "pfc cska sofia"],
  "\u8d39\u4f26\u8328\u74e6\u7f57\u65af": ["ferencvaros", "ferencvarosi tc"],
  "\u4f0f\u4f0a\u4f0f\u4e01\u90a3": ["vojvodina", "fk vojvodina"],
  "\u65e5\u5229\u7eb3": ["zilina", "msk zilina"],
  "\u65af\u666e\u5229\u7279\u6d77\u675c\u514b": ["hajduk split", "hnk hajduk split"],
  "\u535a\u5854\u5f17\u6208": ["botafogo", "botafogo rj"],
  "\u6851\u6258\u65af": ["santos", "santos fc"],
  "\u7ef4\u591a\u5229\u4e9a": ["vitoria", "ec vitoria"],
  "\u74e6\u65af\u79d1\u8fbe\u4f3d\u9a6c": ["vasco da gama", "vasco da gama saf"],
  "\u8499\u7279\u5229\u5c14CF": ["cf montreal", "montreal impact"],
  "\u591a\u4f26\u591aFC": ["toronto fc"],
  "\u829d\u52a0\u54e5\u706b\u7130": ["chicago fire", "chicago fire fc"],
  "\u6e29\u54e5\u534e\u767d\u5e3d": ["vancouver whitecaps", "vancouver whitecaps fc"],
  "\u5723\u8def\u6613\u65af\u57ce": ["st louis city", "st louis city sc"],
  "\u582a\u8428\u65af\u57ce\u7ade\u6280": ["sporting kansas city"],
  "\u897f\u96c5\u56fe\u6d77\u6e7e\u4eba": ["seattle sounders", "seattle sounders fc"],
  "\u6ce2\u7279\u5170\u4f10\u6728\u5de5": ["portland timbers"]
};

const LEAGUE_ALIASES = {
  "\u56fd\u9645\u8d5b": ["friendly", "friendlies", "international"],
  "\u4e16\u754c\u676f": ["world cup", "fifa world cup"],
  "\u4e16\u9884\u8d5b": ["world cup qualification", "world cup qualifiers"],
  "\u6b27\u51a0": ["uefa champions league", "champions league"],
  "\u6b27\u8054": ["uefa europa league", "europa league"],
  "\u6b27\u7f57\u5df4": ["uefa europa league", "europa league"],
  "\u632a\u8d85": ["norwegian eliteserien", "eliteserien"],
  "\u5df4\u7532": ["serie a", "brasileirao serie a", "brazil serie a"],
  "\u5df4\u897f\u676f": ["copa do brasil", "brazil cup"],
  "\u7f8e\u804c": ["major league soccer", "mls"],
  "\u82f1\u8d85": ["premier league"],
  "\u897f\u7532": ["la liga"],
  "\u5fb7\u7532": ["bundesliga"],
  "\u610f\u7532": ["serie a"],
  "\u6cd5\u7532": ["ligue 1"],
  "\u6b27\u6d32\u8d85\u7ea7\u676f": ["uefa super cup", "super cup"],
  "\u89e3\u653e\u8005\u676f": ["copa libertadores", "conmebol libertadores"]
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

const createRequestBudget = (limit = MAX_CALLS_PER_SYNC) => ({
  limit: Number.isFinite(Number(limit)) && Number(limit) >= 0
    ? Math.floor(Number(limit))
    : 12,
  attempts: 0,
  byEndpoint: {},
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

const credentialFingerprintFor = (key) => (
  key ? sha256(`api-football-credential-v1:${key}`).slice(0, 20) : null
);

const statusRefreshMinutesFor = (status) => (
  status?.suspended === true || status?.blockers?.includes?.("account-suspended")
    ? SUSPENSION_PROBE_MINUTES
    : STATUS_REFRESH_MINUTES
);

const synchronizeCredentialState = (cache, credentialFingerprint = credentialFingerprintFor(API_KEY)) => {
  if (!credentialFingerprint) return { changed: false, configured: false };
  const previous = cache.apiAccess?.credentialFingerprint || null;
  if (previous && previous !== credentialFingerprint) {
    // A provider-level block belongs to one credential. A replacement key
    // must receive an immediate /status preflight instead of inheriting the
    // old key's suspension cooldown or plan restrictions.
    cache.apiAccess = {
      credentialFingerprint,
      credentialChangedAt: nowIso(),
    };
    return { changed: true, configured: true };
  }
  cache.apiAccess = {
    ...(cache.apiAccess || {}),
    credentialFingerprint,
  };
  return { changed: false, configured: true };
};

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
  goals: {
    home: Number.isInteger(item?.goals?.home) ? item.goals.home : null,
    away: Number.isInteger(item?.goals?.away) ? item.goals.away : null
  },
  score: item?.score && typeof item.score === "object" ? item.score : null,
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

const confidenceForFixture = (match, fixture, entityRegistry = null) => {
  const teamCategory = fixtureTeamCategoryAudit(match, { home: fixture?.teams?.home?.name, away: fixture?.teams?.away?.name });
  const homeTargets = targetTeamAliases(match, "home");
  const awayTargets = targetTeamAliases(match, "away");
  const leagueTargets = targetLeagueAliases(match);
  const homeScore = nameScore(homeTargets, fixture?.teams?.home?.name);
  const awayScore = nameScore(awayTargets, fixture?.teams?.away?.name);
  const reversedHomeScore = nameScore(homeTargets, fixture?.teams?.away?.name);
  const reversedAwayScore = nameScore(awayTargets, fixture?.teams?.home?.name);
  const directTeamScore = (homeScore + awayScore) / 2;
  const reversedTeamScore = (reversedHomeScore + reversedAwayScore) / 2 * 0.78;
  const nameBasedTeamScore = Math.max(directTeamScore, reversedTeamScore);
  const entityIdentity = providerIdentityScore(entityRegistry, match, fixture);
  const identityAwareDirectScore = entityIdentity.available && !entityIdentity.conflict
    ? (["home", "away"].reduce((total, side) => {
        if (entityIdentity.expected?.[side]) {
          return total + (entityIdentity.expected[side] === entityIdentity.actual?.[side] ? 1 : 0);
        }
        return total + (side === "home" ? homeScore : awayScore);
      }, 0) / 2)
    : nameBasedTeamScore;
  const teamScore = !teamCategory.compatible ? 0 : entityIdentity.exact
    ? 1
    : entityIdentity.conflict
      ? Math.min(nameBasedTeamScore, 0.2)
      : entityIdentity.partialExact
        ? identityAwareDirectScore
        : nameBasedTeamScore;

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
    reversed: reversedTeamScore > directTeamScore,
    entityIdentity,
    teamCategory
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
    reason: message,
    // A previous credential may have left a suspension bit behind.  A
    // plan-date range error is not an account suspension and must clear that
    // stale bit while retaining the discovered free-plan date window.
    suspended: /account is suspended|suspended/i.test(message)
  };
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

const isBulkIdsUnsupportedError = (error) => {
  const message = error?.message || String(error || "");
  return /\/injuries/i.test(message)
    && /\bids\b|access|forbidden|plan|subscription|parameter/i.test(message)
    && /do not have access|not have access|forbidden|plan|subscription|not allowed|invalid.*ids|ids.*invalid/i.test(message);
};

const rememberInjuryAccessError = (cache, error, mode = "fixture") => {
  const message = error?.message || String(error);
  if (!/do not have access|not have access|forbidden|plan|subscription|not allowed|invalid.*ids|ids.*invalid/i.test(message)) return;
  const previous = cache.apiAccess?.injuries || {};
  const updatedAt = nowIso();
  cache.apiAccess = {
    ...(cache.apiAccess || {}),
    injuries: mode === "bulk"
      ? {
        ...previous,
        updatedAt,
        bulkIdsUnsupported: true,
        bulkReason: message
      }
      : {
        ...previous,
        updatedAt,
        fixtureUnsupported: true,
        reason: message
      }
  };
};

const injuryAccessSkipReason = (cache) => {
  const access = cache.apiAccess?.injuries;
  if (!access || !isFresh(access.updatedAt, ACCESS_ERROR_REFRESH_MINUTES)) return "";
  if (!access.fixtureUnsupported) return "";
  return access.reason || "API-Football injuries skipped because per-fixture access is unavailable.";
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

const booleanOrNull = (value) => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
};

const optionalNumber = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return toNumber(value);
};

const normalizeAccountStatus = (payload, options = {}) => {
  const checkedAt = options.checkedAt || nowIso();
  const rawResponse = Array.isArray(payload?.response) ? payload.response[0] : payload?.response;
  const response = rawResponse && typeof rawResponse === "object" ? rawResponse : null;
  const subscription = response?.subscription && typeof response.subscription === "object" ? response.subscription : {};
  const requests = response?.requests && typeof response.requests === "object" ? response.requests : {};
  const rateLimit = options.rateLimit && typeof options.rateLimit === "object" ? options.rateLimit : {};
  const active = booleanOrNull(subscription.active);
  const current = optionalNumber(requests.current ?? requests.used);
  const dailyLimit = optionalNumber(requests.limit_day ?? requests.limit);
  const headerRemaining = optionalNumber(rateLimit.requestsRemaining ?? rateLimit.remaining);
  const computedRemaining = current !== null && dailyLimit !== null ? Math.max(0, dailyLimit - current) : null;
  const remaining = headerRemaining !== null ? headerRemaining : computedRemaining;
  const statusMessages = [
    ...formatApiErrors(payload?.errors),
    compactText(payload?.message),
    compactText(response?.message),
    compactText(response?.account?.status),
    compactText(subscription?.status)
  ].filter(Boolean);
  const message = statusMessages.join("; ");
  const suspended = /suspend|disabled|terminated/i.test(message);
  const inactive = active === false;
  const quotaUnavailable = remaining !== null && remaining <= 0;
  const valid = Boolean(response)
    && Boolean(response.account || response.subscription || response.requests);
  const blockers = [];
  if (!valid) blockers.push("status-response-invalid");
  if (suspended) blockers.push("account-suspended");
  if (inactive) blockers.push("subscription-inactive");
  if (quotaUnavailable) blockers.push("provider-quota-unavailable");
  return {
    checkedAt,
    eligible: blockers.length === 0,
    blocked: blockers.length > 0,
    blockers,
    reason: blockers.length
      ? `${blockers.join(", ")}${message ? `: ${message}` : ""}`
      : "API-Football account and quota preflight passed.",
    suspended,
    active,
    plan: compactText(subscription.plan) || null,
    quota: {
      current,
      dailyLimit,
      remaining
    },
    rateLimit
  };
};

const isGlobalAccountError = (error, statusCode = null) => {
  const message = error?.message || String(error || "");
  return Number(statusCode) === 429
    || /account.*suspend|suspend.*account|subscription.*inactive|quota.*(?:exceed|unavailable|limit)|daily.*(?:request|quota).*limit|rate limit|too many requests/i.test(message);
};

const rememberGlobalAccountError = (cache, error, statusCode = null) => {
  if (!isGlobalAccountError(error, statusCode)) return false;
  const checkedAt = nowIso();
  const message = error?.message || String(error);
  const quotaUnavailable = Number(statusCode) === 429 || /quota|rate limit|too many requests|daily.*limit/i.test(message);
  cache.apiAccess = {
    ...(cache.apiAccess || {}),
    status: {
      checkedAt,
      eligible: false,
      blocked: true,
      blockers: [quotaUnavailable ? "provider-quota-unavailable" : "account-suspended"],
      reason: message,
      suspended: !quotaUnavailable,
      active: null,
      plan: null,
      quota: {
        current: null,
        dailyLimit: null,
        remaining: quotaUnavailable ? 0 : null
      },
      rateLimit: {}
    }
  };
  return true;
};

const accountAccessSkipReason = (cache) => {
  const status = cache.apiAccess?.status;
  if (!status || !isFresh(status.checkedAt, statusRefreshMinutesFor(status))) return "";
  return status.eligible === true ? "" : (status.reason || "API-Football account preflight blocked this sync.");
};

const preflightAccountStatus = async (cache, requestBudget) => {
  const cached = cache.apiAccess?.status;
  if (cached && isFresh(cached.checkedAt, statusRefreshMinutesFor(cached))) return cached;
  try {
    const checkedAt = nowIso();
    const { payload, rateLimit } = await apiGet(cache, "/status", {}, requestBudget);
    const status = normalizeAccountStatus(payload, { checkedAt, rateLimit });
    cache.apiAccess = {
      ...(cache.apiAccess || {}),
      status
    };
    return status;
  } catch (error) {
    const checkedAt = nowIso();
    const rememberedGlobalBlock = cache.apiAccess?.status?.blocked === true
      && isFresh(cache.apiAccess.status.checkedAt, statusRefreshMinutesFor(cache.apiAccess.status))
      ? cache.apiAccess.status
      : null;
    const status = rememberedGlobalBlock
      ? {
        ...rememberedGlobalBlock,
        checkedAt,
        reason: error?.message || rememberedGlobalBlock.reason || String(error)
      }
      : {
        checkedAt,
        eligible: false,
        blocked: true,
        blockers: ["status-preflight-failed"],
        diagnostics: require("./providerFailure.cjs").providerFailure(error),
        reason: error?.message || String(error),
        suspended: /suspend/i.test(error?.message || String(error)),
        active: null,
        plan: null,
        quota: { current: null, dailyLimit: null, remaining: null },
        rateLimit: {}
      };
    cache.apiAccess = {
      ...(cache.apiAccess || {}),
      status
    };
    appendError(cache, error);
    return status;
  }
};

const reserveRequestAttempt = (cache, requestBudget, endpoint) => {
  ensureLedgerDate(cache);
  const budget = requestBudget && typeof requestBudget === "object"
    ? requestBudget
    : createRequestBudget();
  if (budget.attempts >= budget.limit) {
    throw new Error(`API_FOOTBALL_MAX_CALLS_PER_SYNC reached (${budget.limit})`);
  }
  budget.attempts += 1;
  budget.byEndpoint[endpoint] = Number(budget.byEndpoint[endpoint] || 0) + 1;
  cache.requestLedger.count += 1;
  cache.requestLedger.byEndpoint[endpoint] = Number(cache.requestLedger.byEndpoint[endpoint] || 0) + 1;
  return budget;
};

const apiGet = (cache, endpoint, params = {}, requestBudget = createRequestBudget()) => new Promise((resolve, reject) => {
  ensureLedgerDate(cache);
  if (endpoint !== "/status") {
    const skipReason = accountAccessSkipReason(cache);
    if (skipReason) {
      reject(new Error(`API-Football global fail-closed: ${skipReason}`));
      return;
    }
  }
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  try {
    reserveRequestAttempt(cache, requestBudget, endpoint);
  } catch (error) {
    reject(error);
    return;
  }

  const req = https.request(url, {
    method: "GET",
    // The production host has working IPv4 but no IPv6 route. Keep the
    // transport deterministic; an explicit 0 opts into platform auto-selection.
    family: [0, 4, 6].includes(Number(process.env.API_FOOTBALL_ADDRESS_FAMILY ?? 4))
      ? Number(process.env.API_FOOTBALL_ADDRESS_FAMILY ?? 4) : 4,
    headers: {
      "accept": "application/json",
      "x-apisports-key": API_KEY
    }
  }, (res) => {
    let body = "";
    res.on("error", reject);
    res.on("aborted", () => reject(Object.assign(new Error(`${endpoint} response aborted`), { code: "ECONNRESET" })));
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy(Object.assign(new Error(`${endpoint} response too large`), { code: "ERR_BODY_TOO_LARGE" }));
      }
    });
    res.on("end", () => {
      const payload = safeJsonParse(body, null);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const error = new Error(`${endpoint} HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
        rememberGlobalAccountError(cache, error, res.statusCode);
        reject(error);
        return;
      }
      if (!payload) {
        reject(new Error(`${endpoint} returned invalid JSON`));
        return;
      }
      const apiErrors = formatApiErrors(payload.errors);
      if (apiErrors.length) {
        const error = new Error(`${endpoint} API error: ${apiErrors.join("; ")}`);
        rememberGlobalAccountError(cache, error, res.statusCode);
        reject(error);
        return;
      }
      const rateLimit = {
        limit: res.headers["x-ratelimit-limit"] || null,
        remaining: res.headers["x-ratelimit-remaining"] || null,
        requestsLimit: res.headers["x-ratelimit-requests-limit"] || null,
        requestsRemaining: res.headers["x-ratelimit-requests-remaining"] || null
      };
      const requestsRemaining = optionalNumber(rateLimit.requestsRemaining ?? rateLimit.remaining);
      if (endpoint !== "/status" && requestsRemaining !== null && requestsRemaining <= 0) {
        rememberGlobalAccountError(cache, new Error("API-Football provider quota unavailable after this response."), 429);
      }
      resolve({
        payload,
        rateLimit
      });
    });
  });

  // Covers DNS, connect, TLS and response, not just socket inactivity.
  const deadline = setTimeout(() => {
    req.destroy(Object.assign(new Error(`${endpoint} timeout`), { code: "ETIMEDOUT" }));
  }, 20000);
  deadline.unref?.();
  req.once("close", () => clearTimeout(deadline));
  req.on("error", reject);
  req.end();
});

const fetchFixturesForDate = async (cache, date, options = {}, requestBudget) => {
  const cached = cache.fixturesByDate[date];
  if (options.forceLive !== true
      && cached
      && isFresh(cached.fetchedAt, FIXTURE_SEARCH_REFRESH_MINUTES)) {
    return { fixtures: cached.fixtures || [], trustContext: null };
  }

  const { payload, rateLimit } = await apiGet(
    cache,
    "/fixtures",
    { date, timezone: TIME_ZONE },
    requestBudget,
  );
  const fixtures = Array.isArray(payload.response) ? payload.response.map(summarizeFixture).filter((item) => item.fixtureId) : [];
  const fetchedAt = nowIso();
  const providerResponseSha256 = sha256(stableStringify(payload.response || []));
  cache.fixturesByDate[date] = {
    fetchedAt,
    count: fixtures.length,
    rateLimit,
    fixtures
  };
  return {
    fixtures,
    trustContext: {
      live: true,
      providerResponseSha256,
      responseFetchedAt: fetchedAt,
    },
  };
};

const fixtureProjectionForMapping = (mapping) => ({
  teams: {
    home: { id: mapping?.homeTeamId },
    away: { id: mapping?.awayTeamId },
  },
});

const LIVE_STATUS_CODES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

const liveScorePhaseFor = (statusCode) => ({
  "1H": "first-half",
  HT: "half-time",
  "2H": "second-half",
  ET: "extra-time",
  BT: "extra-time-break",
  P: "penalties",
  SUSP: "suspended",
  INT: "interrupted",
  LIVE: "live"
}[statusCode] || null);

const buildLiveScoreObservation = (entry, fixture, context = {}) => {
  const statusCode = compactText(fixture?.status?.short || fixture?.status?.code || fixture?.status).toUpperCase();
  const scoreHome = Number.isInteger(fixture?.goals?.home) ? fixture.goals.home : null;
  const scoreAway = Number.isInteger(fixture?.goals?.away) ? fixture.goals.away : null;
  if (!LIVE_STATUS_CODES.has(statusCode) || scoreHome === null || scoreAway === null) return null;
  const observedAt = context.observedAt || nowIso();
  const minute = Number.isInteger(fixture?.status?.elapsed) ? Math.max(0, fixture.status.elapsed) : null;
  return {
    version: "live-score-observation-v1",
    provider: "api-football",
    source: "api-football:/fixtures",
    sourceMatchId: sourceMatchIdFor(entry?.match || {}),
    providerMatchId: fixture?.fixtureId ?? entry?.map?.fixtureId ?? null,
    kickoffTime: entry?.match?.kickoffTime || null,
    statusCode,
    phase: liveScorePhaseFor(statusCode),
    minute,
    scoreHome,
    scoreAway,
    observedAt,
    receivedAt: observedAt,
    providerResponseSha256: context.providerResponseSha256 || null,
    mappingConfidence: Number(entry?.map?.confidence || 0),
    mappingVerification: "registry-exact",
    usagePolicy: {
      mode: RUNTIME_POLICY.mode,
      shadowOnly: true,
      ...RUNTIME_POLICY.authority
    },
    official: false,
    trusted: true,
    settlementEligible: false
  };
};

const mappingVerificationState = (match, mapping, entityRegistry, options = {}) => {
  const blockers = [];
  const teamCategory = fixtureTeamCategoryAudit(match, { home: mapping?.homeTeamName, away: mapping?.awayTeamName });
  blockers.push(...teamCategory.blockers);
  const key = matchKey(match);
  const identity = providerIdentityScore(
    entityRegistry,
    match,
    fixtureProjectionForMapping(mapping),
  );
  if (!mapping?.fixtureId) blockers.push("provider-fixture-id-missing");
  if (!Number.isFinite(Number(mapping?.confidence))
      || Number(mapping.confidence) < MIN_MATCH_CONFIDENCE) {
    blockers.push("fixture-confidence-below-sync-threshold");
  }
  if (mapping?.score?.reversed === true) blockers.push("reversed-fixture-not-eligible");
  if (mapping?.sportteryMatchId && String(mapping.sportteryMatchId) !== String(key)) {
    blockers.push("sporttery-match-key-mismatch");
  }
  const expectedSourceMatchId = sourceMatchIdFor(match);
  if (mapping?.sourceMatchId
      && expectedSourceMatchId
      && String(mapping.sourceMatchId) !== String(expectedSourceMatchId)) {
    blockers.push("source-match-id-mismatch");
  }
  const kickoffMs = Date.parse(String(match?.kickoffTime || ""));
  const fixtureMs = Date.parse(String(mapping?.fixtureDate || ""));
  if (!Number.isFinite(kickoffMs)
      || !Number.isFinite(fixtureMs)
      || Math.abs(kickoffMs - fixtureMs) > 4 * 60 * 60 * 1000) {
    blockers.push("provider-fixture-time-mismatch");
  }
  if (!identity.exact) {
    blockers.push(identity.conflict ? "provider-entity-conflict" : "provider-entity-registry-not-exact");
  }

  const trustContext = options.liveTrustContext || null;
  const currentCycleQualification = trustContext?.live === true
    ? qualifyingFixtureMapping(mapping, {}, { match, trustContext })
    : null;
  return {
    verified: blockers.length === 0,
    verificationSource: blockers.length
      ? "audit-only"
      : (currentCycleQualification?.eligible === true
        ? "registry-exact+live-current-cycle"
        : "registry-exact"),
    blockers: uniq(blockers),
    identity,
    teamCategory,
    currentCycleQualification,
  };
};

const buildFixtureResolutionPlan = (matches, cache, entityRegistry) => {
  const byDate = new Map();
  const reusableKeys = new Set();
  const audits = [];
  for (const match of matches || []) {
    const key = matchKey(match);
    const cached = cache?.fixtureMap?.[key];
    const verification = mappingVerificationState(match, cached, entityRegistry);
    const freshLastSearchIgnored = Boolean(
      !verification.verified
      && cached?.lastSearchAt
      && isFresh(cached.lastSearchAt, FIXTURE_SEARCH_REFRESH_MINUTES)
    );
    audits.push({ key, verification, freshLastSearchIgnored });
    if (verification.verified) {
      reusableKeys.add(key);
      continue;
    }
    const date = dateFromMatch(match);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(match);
  }
  return { byDate, reusableKeys, audits };
};

const buildVerifiedMappingSet = (
  matches,
  cache,
  entityRegistry,
  liveTrustContexts = new Map(),
) => {
  const verified = new Set();
  for (const match of matches || []) {
    const key = matchKey(match);
    const mapping = cache?.fixtureMap?.[key];
    const state = mappingVerificationState(match, mapping, entityRegistry, {
      liveTrustContext: liveTrustContexts.get(key) || null,
    });
    if (state.verified) verified.add(key);
  }
  return verified;
};

const restrictToVerifiedMappings = (mappedMatches, verifiedMappingSet) => {
  if (!(verifiedMappingSet instanceof Set)) return [];
  return (mappedMatches || []).filter((entry) => verifiedMappingSet.has(matchKey(entry?.match || {})));
};

const selectVerifiedMappedMatches = (matches, cache, verifiedMappingSet) => restrictToVerifiedMappings(
  (matches || []).map((match) => ({ match, map: cache?.fixtureMap?.[matchKey(match)] })),
  verifiedMappingSet,
).filter((entry) => entry.map?.fixtureId);

const resolveFixtureMaps = async (matches, cache, stats, entityRegistry = null, requestBudget) => {
  const eligible = matches.filter(isEligibleMatch);
  const plan = buildFixtureResolutionPlan(eligible, cache, entityRegistry);
  const byDate = plan.byDate;
  const liveTrustContexts = new Map();
  stats.cachedFixtureMatches += plan.reusableKeys.size;
  stats.cachedEntityConflicts += plan.audits.filter((audit) => audit.verification.identity.conflict).length;
  stats.unverifiedFreshCacheRevalidations += plan.audits.filter((audit) => audit.freshLastSearchIgnored).length;

  for (const [date, dateMatches] of byDate.entries()) {
    const skipReason = fixtureAccessSkipReason(cache, date);
    if (skipReason) {
      stats.fixtureDatesSkippedByAccess += 1;
      continue;
    }

    let fixtures = [];
    let trustContext = null;
    try {
      // Every row in this plan lacks an exact registry mapping. A fresh fixture
      // list or lastSearchAt from a previous cycle is audit-only and cannot
      // establish current-cycle provider trust, so force a live response.
      const fixtureBatch = await fetchFixturesForDate(cache, date, { forceLive: true }, requestBudget);
      fixtures = fixtureBatch.fixtures;
      trustContext = fixtureBatch.trustContext;
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
          score: confidenceForFixture(match, fixture, entityRegistry)
        }))
        .sort((a, b) => b.score.confidence - a.score.confidence);
      const best = ranked[0];
      const previous = cache.fixtureMap[key] || {};
      if (best && best.score.confidence >= MIN_MATCH_CONFIDENCE && best.score.teamScore >= 0.54 && best.score.timeScore >= 0.36) {
        const learnedMapping = {
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
        if (trustContext?.live === true) {
          learnedMapping.providerEvidence = {
            responseSha256: trustContext.providerResponseSha256,
            responseFetchedAt: trustContext.responseFetchedAt,
            fixtureIdentitySha256: fixtureIdentityHashFor(learnedMapping),
          };
          liveTrustContexts.set(key, trustContext);
        }
        cache.fixtureMap[key] = learnedMapping;
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
  return liveTrustContexts;
};

const absorbEntityResolutionEvidence = (matches, cache, registry, trustContexts = new Map()) => {
  const matchesByKey = new Map();
  for (const match of matches || []) {
    for (const key of [matchKey(match), sourceMatchIdFor(match)]) {
      if (key) matchesByKey.set(String(key), match);
    }
  }
  let nextRegistry = registry;
  let changedRows = 0;
  let conflictsAdded = 0;
  const blockers = {};
  for (const mapping of Object.values(cache.fixtureMap || {})) {
    const match = matchesByKey.get(String(mapping?.sportteryMatchId || ""))
      || matchesByKey.get(String(mapping?.sourceMatchId || ""));
    if (!match) continue;
    const result = applyFixtureMappingEvidence({
      registry: nextRegistry,
      match: {
        ...match,
        // The fixture scorer already proved these aliases against the live
        // provider response.  Pass the same canonical alias set into the
        // append-only entity registry so a Chinese display name does not
        // fail a second, raw-name-only comparison.
        homeTeamAliases: targetTeamAliases(match, "home"),
        awayTeamAliases: targetTeamAliases(match, "away"),
      },
      mapping,
      observedAt: mapping?.matchedAt || nowIso(),
      trustContext: trustContexts.get(String(mapping?.sportteryMatchId || "")) || null,
    });
    if (result.changed) {
      nextRegistry = result.registry;
      changedRows += 1;
      conflictsAdded += result.conflictsAdded;
    }
    for (const blocker of result.blockers || []) blockers[blocker] = Number(blockers[blocker] || 0) + 1;
  }
  return { registry: nextRegistry, changedRows, conflictsAdded, blockers };
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

const temporalEligibilityFor = (fetchedAt, cutoff) => {
  const fetchedMs = Date.parse(fetchedAt || "");
  const cutoffMs = Date.parse(cutoff || "");
  const eligible = Number.isFinite(fetchedMs) && Number.isFinite(cutoffMs) && fetchedMs <= cutoffMs;
  return {
    eligible,
    fetchedAt: fetchedAt || null,
    cutoff: cutoff || null,
    basis: "fetchedAt<=cutoff",
    reason: eligible
      ? "Observed no later than the pre-match cutoff."
      : "Observed after cutoff or cutoff could not be proven."
  };
};

const prematchCutoffFor = (entry) => [
  entry?.match?.buyEndTime,
  entry?.match?.predictionMeta?.cutoffTime,
  entry?.match?.cutoffTime,
  entry?.match?.kickoffTime,
  entry?.map?.fixtureDate
].map(compactText).find(Boolean) || null;

const buildPieceMetadata = ({ entry, providerFixtureId, endpoint, observedAt, sourceUpdatedAt, query = {} }) => {
  const fetchedAt = observedAt || nowIso();
  const updatedAt = sourceUpdatedAt || fetchedAt;
  const cutoff = prematchCutoffFor(entry);
  return {
    source: "api-football",
    observedAt: fetchedAt,
    sourceUpdatedAt: updatedAt,
    providerFixtureId: providerFixtureId ?? entry?.map?.fixtureId ?? null,
    provenance: {
      provider: "api-football",
      endpoint,
      query,
      fetchedAt,
      sourceUpdatedAt: updatedAt
    },
    usagePolicy: {
      mode: RUNTIME_POLICY.mode,
      shadowOnly: true,
      ...RUNTIME_POLICY.authority
    },
    temporalEligibility: temporalEligibilityFor(fetchedAt, cutoff)
  };
};

const normalizeInjuryPlayer = (row, side, fixtureId, observedAt) => ({
  playerId: row?.player?.id ?? null,
  name: compactText(row?.player?.name) || "Unknown player",
  type: compactText(row?.player?.type || row?.type) || null,
  reason: compactText(row?.player?.reason || row?.reason) || null,
  teamId: row?.team?.id ?? null,
  side,
  fixtureId,
  observedAt
});

const buildInjuriesByFixture = (mappedMatches, response, context = {}) => {
  const byFixture = new Map();
  for (const row of Array.isArray(response) ? response : []) {
    const fixtureId = row?.fixture?.id ?? context.providerFixtureId;
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
    byFixture.get(fixtureId)[side].push({
      label: multi(formatPerson(row)),
      player: normalizeInjuryPlayer(row, side, fixtureId, context.observedAt || nowIso())
    });
  }

  const result = new Map();
  for (const [fixtureId, value] of byFixture.entries()) {
    const entry = matchForFixtureId(mappedMatches, fixtureId);
    const homeDetails = value.home.map((item) => item.player);
    const awayDetails = value.away.map((item) => item.player);
    const metadata = buildPieceMetadata({
      entry,
      providerFixtureId: fixtureId,
      endpoint: context.endpoint || "/injuries",
      observedAt: context.observedAt,
      sourceUpdatedAt: context.sourceUpdatedAt,
      query: context.query || {}
    });
    result.set(String(fixtureId), {
      ...metadata,
      home: value.home.slice(0, 8).map((item) => item.label),
      away: value.away.slice(0, 8).map((item) => item.label),
      homeDetails,
      awayDetails,
      players: homeDetails.concat(awayDetails),
      summary: multi(`API-FOOTBALL injuries: home ${homeDetails.length}, away ${awayDetails.length}.`)
    });
  }
  return result;
};

const mergeApiPiece = (apiPieces, fixtureId, piece) => {
  if (!piece || !fixtureId) return;
  apiPieces[String(fixtureId)] = {
    ...(apiPieces[String(fixtureId)] || {}),
    ...piece
  };
};

const cachedApiPieces = (signalState) => {
  if (!signalState || typeof signalState !== "object") return null;
  const pieces = {};
  if (LIVE_SCORE_ENABLED
      && signalState.liveScore?.settlementEligible === false
      && ageMinutes(signalState.liveScore.observedAt) * 60 <= LIVE_SCORE_CACHE_MAX_SECONDS) {
    pieces.liveScore = signalState.liveScore;
  }
  if (INJURIES_ENABLED && signalState.injuries?.temporalEligibility?.eligible === true) pieces.injuries = signalState.injuries;
  if (LINEUPS_ENABLED && signalState.lineups?.temporalEligibility?.eligible === true) pieces.lineups = signalState.lineups;
  if (ODDS_ENABLED && signalState.apiFootballOdds?.temporalEligibility?.eligible === true) pieces.apiFootballOdds = signalState.apiFootballOdds;
  return Object.keys(pieces).length ? pieces : null;
};

const shouldFetchLiveScore = (entry, signalState, now = Date.now()) => {
  if (!LIVE_SCORE_ENABLED) return false;
  const kickoffMs = Date.parse(entry?.match?.kickoffTime || "");
  if (!Number.isFinite(kickoffMs)) return false;
  const minutesFromKickoff = (now - kickoffMs) / 60000;
  if (minutesFromKickoff < -LIVE_SCORE_PRE_KICKOFF_MINUTES
      || minutesFromKickoff > LIVE_SCORE_POST_KICKOFF_MINUTES) return false;
  const lastFetchMs = Date.parse(signalState?.liveScoreFetchedAt || "");
  return !Number.isFinite(lastFetchMs) || now - lastFetchMs >= LIVE_SCORE_REFRESH_SECONDS * 1000;
};

const buildLiveScoreRequestPlan = (mappedMatches, cache, verifiedMappingSet, now = Date.now()) => {
  const due = restrictToVerifiedMappings(mappedMatches, verifiedMappingSet)
    .filter((entry) => shouldFetchLiveScore(entry, cache.fixtureSignals[String(entry.map.fixtureId)], now));
  return chunk(due, 20).map((entries) => ({
    endpoint: "/fixtures",
    params: { ids: entries.map((entry) => entry.map.fixtureId).join("-"), timezone: TIME_ZONE },
    entries
  }));
};

const recordLiveScoreResponse = ({ cache, apiPieces, request, payload, observedAt }) => {
  const response = Array.isArray(payload?.response) ? payload.response : [];
  const providerResponseSha256 = sha256(stableStringify(response));
  const fixturesById = new Map(response
    .map(summarizeFixture)
    .filter((fixture) => fixture.fixtureId)
    .map((fixture) => [String(fixture.fixtureId), fixture]));
  let observations = 0;
  for (const entry of request.entries) {
    const fixtureId = String(entry.map.fixtureId);
    const fixture = fixturesById.get(fixtureId);
    const liveScore = fixture
      ? buildLiveScoreObservation(entry, fixture, { observedAt, providerResponseSha256 })
      : null;
    const state = {
      ...(cache.fixtureSignals[fixtureId] || {}),
      liveScoreFetchedAt: observedAt
    };
    if (liveScore) {
      state.liveScore = liveScore;
      mergeApiPiece(apiPieces, fixtureId, { liveScore });
      observations += 1;
    } else {
      delete state.liveScore;
    }
    cache.fixtureSignals[fixtureId] = state;
  }
  return observations;
};

const fetchLiveScores = async (
  mappedMatches,
  cache,
  stats,
  apiPieces,
  verifiedMappingSet,
  requestBudget,
) => {
  const queue = buildLiveScoreRequestPlan(mappedMatches, cache, verifiedMappingSet);
  stats.liveScoreEligibleMatches = queue.reduce((sum, request) => sum + request.entries.length, 0);
  for (const request of queue) {
    if (requestBudget.attempts >= requestBudget.limit) {
      stats.liveScoreSkippedByBudget += request.entries.length;
      continue;
    }
    try {
      const { payload } = await apiGet(cache, request.endpoint, request.params, requestBudget);
      const observedAt = nowIso();
      stats.liveScoreCalls += 1;
      stats.liveScoreObservations += recordLiveScoreResponse({ cache, apiPieces, request, payload, observedAt });
    } catch (error) {
      appendError(cache, error);
      stats.liveScoreErrors += 1;
      if (accountAccessSkipReason(cache) || /API_FOOTBALL_MAX_CALLS_PER_SYNC/.test(error?.message || "")) break;
    }
  }
};

const hydrateCachedApiPieces = (mappedMatches, cache, apiPieces, verifiedMappingSet) => {
  for (const entry of restrictToVerifiedMappings(mappedMatches, verifiedMappingSet)) {
    const fixtureId = String(entry.map.fixtureId);
    const pieces = cachedApiPieces(cache.fixtureSignals[fixtureId]);
    if (pieces) mergeApiPiece(apiPieces, fixtureId, pieces);
  }
};

const hasCachedBulkIdsRestriction = (cache) => {
  const access = cache.apiAccess?.injuries;
  return Boolean(access?.bulkIdsUnsupported)
    && isFresh(access.updatedAt, ACCESS_ERROR_REFRESH_MINUTES);
};

const buildInjuryRequestPlan = (cache, fixtureIds) => {
  const uniqueIds = uniq((fixtureIds || []).map(String));
  if (hasCachedBulkIdsRestriction(cache)) {
    return uniqueIds.map((fixtureId) => ({
      mode: "fixture",
      endpoint: "/injuries",
      params: { fixture: fixtureId },
      fixtureIds: [fixtureId]
    }));
  }
  return chunk(uniqueIds, 20).map((ids) => ({
    mode: "bulk",
    endpoint: "/injuries",
    params: { ids: ids.join("-") },
    fixtureIds: ids
  }));
};

const fixtureInjuryRequests = (fixtureIds) => uniq((fixtureIds || []).map(String)).map((fixtureId) => ({
  mode: "fixture",
  endpoint: "/injuries",
  params: { fixture: fixtureId },
  fixtureIds: [fixtureId]
}));

const recordInjuryResponse = ({ mappedMatches, cache, apiPieces, request, payload, rateLimit, observedAt }) => {
  const byFixture = buildInjuriesByFixture(mappedMatches, payload.response, {
    endpoint: request.endpoint,
    query: request.params,
    providerFixtureId: request.mode === "fixture" ? request.fixtureIds[0] : null,
    observedAt,
    sourceUpdatedAt: observedAt
  });
  for (const fixtureId of request.fixtureIds) {
    const injuries = byFixture.get(String(fixtureId)) || null;
    const state = {
      ...(cache.fixtureSignals[fixtureId] || {}),
      injuriesFetchedAt: observedAt,
      injuriesRows: Array.isArray(injuries?.players) ? injuries.players.length : 0,
      injuriesRateLimit: rateLimit,
      injuriesFetchMode: request.mode
    };
    if (injuries) state.injuries = injuries;
    cache.fixtureSignals[fixtureId] = state;
    if (injuries?.temporalEligibility?.eligible === true) {
      mergeApiPiece(apiPieces, fixtureId, { injuries });
    }
  }
};

const fetchInjuries = async (
  mappedMatches,
  cache,
  stats,
  apiPieces,
  verifiedMappingSet,
  requestBudget,
) => {
  mappedMatches = restrictToVerifiedMappings(mappedMatches, verifiedMappingSet);
  const skipReason = injuryAccessSkipReason(cache);
  if (skipReason) {
    stats.injurySkippedByAccess = (stats.injurySkippedByAccess || 0) + 1;
    return;
  }

  const due = mappedMatches
    .filter((entry) => shouldFetchInjuries(entry.match, cache.fixtureSignals[entry.map.fixtureId]))
    .map((entry) => entry.map.fixtureId);
  const uniqueIds = uniq(due.map(String));

  const queue = buildInjuryRequestPlan(cache, uniqueIds);
  while (queue.length) {
    if (requestBudget.attempts >= requestBudget.limit) {
      stats.injurySkippedByBudget = (stats.injurySkippedByBudget || 0) + queue.reduce((sum, item) => sum + item.fixtureIds.length, 0);
      break;
    }
    const request = queue.shift();
    try {
      const { payload, rateLimit } = await apiGet(cache, request.endpoint, request.params, requestBudget);
      const observedAt = nowIso();
      recordInjuryResponse({ mappedMatches, cache, apiPieces, request, payload, rateLimit, observedAt });
      stats.injuryCalls += 1;
      if (request.mode === "fixture") stats.injuryFixtureFallbackCalls = (stats.injuryFixtureFallbackCalls || 0) + 1;
    } catch (error) {
      appendError(cache, error);
      if (request.mode === "bulk" && isBulkIdsUnsupportedError(error)) {
        rememberInjuryAccessError(cache, error, "bulk");
        const remainingFixtureIds = request.fixtureIds.concat(queue.flatMap((item) => item.fixtureIds));
        queue.splice(0, queue.length, ...fixtureInjuryRequests(remainingFixtureIds));
        stats.injuryBulkFallbacks = (stats.injuryBulkFallbacks || 0) + 1;
        continue;
      }
      rememberInjuryAccessError(cache, error, request.mode);
      if (accountAccessSkipReason(cache) || /API_FOOTBALL_MAX_CALLS_PER_SYNC/.test(error?.message || "")) break;
      if (request.mode === "fixture" && injuryAccessSkipReason(cache)) break;
    }
  }
};

const normalizeLineupPlayer = (row) => {
  const player = row?.player && typeof row.player === "object" ? row.player : row || {};
  return {
    playerId: player.id ?? null,
    name: compactText(player.name) || null,
    number: player.number ?? null,
    position: compactText(player.pos || player.position) || null,
    grid: compactText(player.grid) || null
  };
};

const normalizeTeamLineup = (row) => {
  if (!row || typeof row !== "object") return null;
  const coach = row.coach && typeof row.coach === "object" ? row.coach : {};
  return {
    teamId: row.team?.id ?? null,
    name: compactText(row.team?.name) || null,
    coach: {
      id: coach.id ?? null,
      name: compactText(coach.name) || null
    },
    formation: compactText(row.formation) || null,
    startXI: (Array.isArray(row.startXI) ? row.startXI : []).map(normalizeLineupPlayer),
    substitutes: (Array.isArray(row.substitutes) ? row.substitutes : []).map(normalizeLineupPlayer)
  };
};

const buildLineups = (entry, response, context = {}) => {
  const rows = Array.isArray(response) ? response : [];
  const homeRow = rows.find((row) => Number(row?.team?.id) === Number(entry.map.homeTeamId));
  const awayRow = rows.find((row) => Number(row?.team?.id) === Number(entry.map.awayTeamId));
  if (!homeRow && !awayRow) return null;
  const home = normalizeTeamLineup(homeRow);
  const away = normalizeTeamLineup(awayRow);
  const homeFormation = home?.formation || "";
  const awayFormation = away?.formation || "";
  const homeStart = home?.startXI?.length || 0;
  const awayStart = away?.startXI?.length || 0;
  const metadata = buildPieceMetadata({
    entry,
    providerFixtureId: entry.map.fixtureId,
    endpoint: "/fixtures/lineups",
    observedAt: context.observedAt,
    sourceUpdatedAt: context.sourceUpdatedAt,
    query: { fixture: String(entry.map.fixtureId) }
  });
  return {
    ...metadata,
    home,
    away,
    homeFormation: homeFormation || undefined,
    awayFormation: awayFormation || undefined,
    summary: multi(`API-FOOTBALL lineups: ${homeFormation || "--"} / ${awayFormation || "--"}, starters ${homeStart}/${awayStart}.`)
  };
};

const fetchLineups = async (
  mappedMatches,
  cache,
  stats,
  apiPieces,
  verifiedMappingSet,
  requestBudget,
) => {
  mappedMatches = restrictToVerifiedMappings(mappedMatches, verifiedMappingSet);
  const due = mappedMatches.filter((entry) => shouldFetchLineups(entry.match, cache.fixtureSignals[entry.map.fixtureId]));
  for (const entry of due) {
    const fixtureId = String(entry.map.fixtureId);
    try {
      const { payload, rateLimit } = await apiGet(
        cache,
        "/fixtures/lineups",
        { fixture: fixtureId },
        requestBudget,
      );
      const observedAt = nowIso();
      const lineups = buildLineups(entry, payload.response, {
        observedAt,
        sourceUpdatedAt: observedAt
      });
      cache.fixtureSignals[fixtureId] = {
        ...(cache.fixtureSignals[fixtureId] || {}),
        lineupsFetchedAt: observedAt,
        lineupsRows: Array.isArray(payload.response) ? payload.response.length : 0,
        lineupsRateLimit: rateLimit
      };
      if (lineups) {
        cache.fixtureSignals[fixtureId].lineups = lineups;
        if (lineups.temporalEligibility.eligible) {
          mergeApiPiece(apiPieces, fixtureId, { lineups });
        } else {
          stats.lineupsRejectedPostCutoff = (stats.lineupsRejectedPostCutoff || 0) + 1;
        }
      }
      stats.lineupCalls += 1;
    } catch (error) {
      appendError(cache, error);
      if (accountAccessSkipReason(cache) || /API_FOOTBALL_MAX_CALLS_PER_SYNC/.test(error?.message || "")) break;
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

const fetchOdds = async (
  mappedMatches,
  cache,
  stats,
  apiPieces,
  verifiedMappingSet,
  requestBudget,
) => {
  mappedMatches = restrictToVerifiedMappings(mappedMatches, verifiedMappingSet);
  const due = mappedMatches.filter((entry) => shouldFetchOdds(entry.match, cache.fixtureSignals[entry.map.fixtureId]));
  for (const entry of due) {
    const fixtureId = String(entry.map.fixtureId);
    try {
      const { payload, rateLimit } = await apiGet(cache, "/odds", { fixture: fixtureId }, requestBudget);
      const observedAt = nowIso();
      const oneXTwo = pickOneXTwoOdds(entry, payload.response);
      cache.fixtureSignals[fixtureId] = {
        ...(cache.fixtureSignals[fixtureId] || {}),
        oddsFetchedAt: observedAt,
        oddsRows: Array.isArray(payload.response) ? payload.response.length : 0,
        oddsRateLimit: rateLimit
      };
      if (oneXTwo) {
        const summary = `API-FOOTBALL ${oneXTwo.bookmaker} 1X2: ${oneXTwo.odds.odds1.toFixed(2)} / ${oneXTwo.odds.oddsX.toFixed(2)} / ${oneXTwo.odds.odds2.toFixed(2)}.`;
        const metadata = buildPieceMetadata({
          entry,
          providerFixtureId: fixtureId,
          endpoint: "/odds",
          observedAt,
          sourceUpdatedAt: oneXTwo.updatedAt || observedAt,
          query: { fixture: fixtureId }
        });
        const apiFootballOdds = {
          ...metadata,
          bookmaker: oneXTwo.bookmaker,
          bet: oneXTwo.bet,
          updatedAt: oneXTwo.updatedAt,
          had: oneXTwo.odds,
          summary: multi(summary)
        };
        cache.fixtureSignals[fixtureId].apiFootballOdds = apiFootballOdds;
        if (apiFootballOdds.temporalEligibility.eligible) {
          mergeApiPiece(apiPieces, fixtureId, { apiFootballOdds });
        } else {
          stats.oddsRejectedPostCutoff = (stats.oddsRejectedPostCutoff || 0) + 1;
        }
      }
      stats.oddsCalls += 1;
    } catch (error) {
      appendError(cache, error);
      if (accountAccessSkipReason(cache) || /API_FOOTBALL_MAX_CALLS_PER_SYNC/.test(error?.message || "")) break;
    }
  }
};

const mergeSourceName = (existingSource, nextSource) => {
  const parts = String(existingSource || "")
    .split("+")
    .concat(String(nextSource || "").split("+"))
    .map((item) => item.trim())
    .filter(Boolean);
  return uniq(parts).join("+") || nextSource || existingSource || "api-football";
};

const localizedSummaryText = (piece) => compactText(
  typeof piece?.summary === "string"
    ? piece.summary
    : piece?.summary?.en || piece?.summary?.zh || ""
);

const isApiFootballPiece = (piece) => /api-football/i.test(`${piece?.source || ""} ${localizedSummaryText(piece)}`);

const stripLegacyGenericApiFootballOdds = (signal) => {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) return signal;
  const genericExternalOdds = isApiFootballPiece(signal.externalOdds);
  const genericBookmakerHad = /api-football/i.test(signal.bookmakerOdds?.had?.source || "");
  if (!genericExternalOdds && !genericBookmakerHad) return signal;
  const next = { ...signal };
  if (genericExternalOdds) delete next.externalOdds;
  if (genericBookmakerHad) {
    next.bookmakerOdds = { ...(signal.bookmakerOdds || {}) };
    delete next.bookmakerOdds.had;
    if (Object.keys(next.bookmakerOdds).length === 0) delete next.bookmakerOdds;
  }
  return next;
};

const retainExistingPrematchPiece = (piece, featureEnabled = true) => {
  if (!piece) return false;
  if (!isApiFootballPiece(piece)) return true;
  return featureEnabled && piece.temporalEligibility?.eligible === true;
};

const hasApiFootballPrematchFeatures = (signal) => Boolean(
  isApiFootballPiece(signal?.liveScore)
  || isApiFootballPiece(signal?.injuries)
  || isApiFootballPiece(signal?.lineups)
  || isApiFootballPiece(signal?.externalOdds)
  || signal?.bookmakerOdds?.apiFootball
  || /api-football/i.test(signal?.bookmakerOdds?.had?.source || "")
);

const stripUnverifiedApiFootballFeatures = (signal, audit = {}) => {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) return signal;
  if (!hasApiFootballPrematchFeatures(signal) && !signal.apiFootball && !audit.fixtureId) return signal;
  const next = { ...signal };
  for (const key of ["liveScore", "injuries", "lineups", "externalOdds"]) {
    if (isApiFootballPiece(next[key])) delete next[key];
  }
  if (next.bookmakerOdds && typeof next.bookmakerOdds === "object") {
    const bookmakerOdds = { ...next.bookmakerOdds };
    delete bookmakerOdds.apiFootball;
    if (/api-football/i.test(bookmakerOdds.had?.source || "")) delete bookmakerOdds.had;
    if (Object.keys(bookmakerOdds).length) next.bookmakerOdds = bookmakerOdds;
    else delete next.bookmakerOdds;
  }
  next.apiFootball = {
    ...(signal.apiFootball || {}),
    ...(audit.fixtureId ? { fixtureId: audit.fixtureId } : {}),
    mappingVerified: false,
    enrichmentEligible: false,
    verificationStatus: "audit-only",
    verificationBlockers: uniq(audit.blockers || ["provider-entity-registry-not-exact"]),
    lastCheckedAt: audit.checkedAt || nowIso(),
  };
  return next;
};

const mergeSignal = (existing, apiSignal) => {
  existing = stripLegacyGenericApiFootballOdds(eventSafeExistingSignal(existing, apiSignal));
  apiSignal = stripLegacyGenericApiFootballOdds(apiSignal);
  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...apiSignal,
    source: mergeSourceName(existing?.source, "api-football"),
    updatedAt: apiSignal.updatedAt || existing?.updatedAt || nowIso(),
    apiFootball: {
      ...(existing?.apiFootball || {}),
      ...(apiSignal.apiFootball || {})
    }
  };

  if (existing?.injuries && !apiSignal.injuries) {
    if (retainExistingPrematchPiece(existing.injuries, INJURIES_ENABLED)) next.injuries = existing.injuries;
    else delete next.injuries;
  }
  if (existing?.lineups && !apiSignal.lineups) {
    if (retainExistingPrematchPiece(existing.lineups, LINEUPS_ENABLED)) next.lineups = existing.lineups;
    else delete next.lineups;
  }
  if (existing?.externalOdds && !apiSignal.externalOdds) {
    if (retainExistingPrematchPiece(existing.externalOdds, ODDS_ENABLED)) next.externalOdds = existing.externalOdds;
    else delete next.externalOdds;
  }
  if (existing?.liveScore && !apiSignal.liveScore) delete next.liveScore;

  next.bookmakerOdds = {
    ...(existing?.bookmakerOdds || {})
  };

  if (!apiSignal.bookmakerOdds && next.bookmakerOdds.apiFootball
      && !retainExistingPrematchPiece(next.bookmakerOdds.apiFootball, ODDS_ENABLED)) {
    delete next.bookmakerOdds.apiFootball;
    if (/api-football/i.test(next.bookmakerOdds.had?.source || "")) delete next.bookmakerOdds.had;
  }

  if (apiSignal.bookmakerOdds) {
    next.bookmakerOdds = {
      ...next.bookmakerOdds,
      ...apiSignal.bookmakerOdds
    };
  }

  return next;
};

const mergeExternalSignals = (matches, cache, apiPieces, stats, verifiedMappingSet = new Set()) => {
  const existing = readJsonFile(EXTERNAL_SIGNALS_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  const outputMatches = existing?.matches && typeof existing.matches === "object" && !Array.isArray(existing.matches)
    ? { ...existing.matches }
    : {};
  for (const [signalKey, signal] of Object.entries(outputMatches)) {
    outputMatches[signalKey] = stripLegacyGenericApiFootballOdds(signal);
  }
  const updatedAt = nowIso();

  for (const match of matches) {
    const key = matchKey(match);
    const map = cache.fixtureMap[key];
    if (!(verifiedMappingSet instanceof Set) || !verifiedMappingSet.has(key)) {
      const verification = mappingVerificationState(match, map, null);
      let sanitizedRows = 0;
      for (const signalKey of externalSignalKeys(match)) {
        if (!outputMatches[signalKey]) continue;
        const sanitized = stripUnverifiedApiFootballFeatures(outputMatches[signalKey], {
          fixtureId: map?.fixtureId || outputMatches[signalKey]?.apiFootball?.fixtureId || null,
          blockers: verification.blockers,
          checkedAt: updatedAt,
        });
        if (sanitized !== outputMatches[signalKey]) sanitizedRows += 1;
        outputMatches[signalKey] = sanitized;
      }
      if (map?.fixtureId) stats.unverifiedCacheAuditRows += 1;
      stats.unverifiedApiSignalRowsSanitized += sanitizedRows;
      continue;
    }
    if (!map?.fixtureId || map.confidence < MIN_MATCH_CONFIDENCE) continue;
    const fixtureId = String(map.fixtureId);
    const pieces = apiPieces[fixtureId] || {};
    const apiFootballOdds = pieces.apiFootballOdds;
    const apiSignal = stampSignalEvent({
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
        mappingVerified: true,
        enrichmentEligible: true,
        verificationStatus: "registry-exact",
        lastCheckedAt: updatedAt,
        syncMode: RUNTIME_POLICY.mode,
        shadowOnly: true,
        authority: RUNTIME_POLICY.authority
      },
      ...(pieces.injuries ? { injuries: pieces.injuries } : {}),
      ...(pieces.lineups ? { lineups: pieces.lineups } : {}),
      ...(pieces.liveScore ? { liveScore: pieces.liveScore } : {}),
      ...(apiFootballOdds ? {
        bookmakerOdds: {
          apiFootball: apiFootballOdds
        }
      } : {})
    }, match);

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
      syncMode: RUNTIME_POLICY.mode,
      shadowOnly: true,
      features: RUNTIME_POLICY.features,
      authority: RUNTIME_POLICY.authority,
      fixtureMatches: stats.cachedFixtureMatches + stats.newFixtureMatches,
      mappedSignals: stats.signalsMapped,
      callsThisSync: stats.callsThisSync,
      injuryCalls: stats.injuryCalls,
      injurySkippedByAccess: stats.injurySkippedByAccess || 0,
      lineupCalls: stats.lineupCalls,
      oddsCalls: stats.oddsCalls,
      liveScoreCalls: stats.liveScoreCalls,
      liveScoreObservations: stats.liveScoreObservations,
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
  const credentialState = synchronizeCredentialState(cache);
  ensureLedgerDate(cache);
  const requestBudget = createRequestBudget();
  const stats = {
    ok: true,
    startedAt,
    finishedAt: null,
    configured: Boolean(API_KEY),
    enabled: ENABLED,
    runtimePolicy: RUNTIME_POLICY,
    matchCount: 0,
    eligibleMatches: 0,
    cachedFixtureMatches: 0,
    cachedEntityConflicts: 0,
    unverifiedFreshCacheRevalidations: 0,
    verifiedMappingCount: 0,
    unverifiedMappingCount: 0,
    unverifiedCacheAuditRows: 0,
    unverifiedApiSignalRowsSanitized: 0,
    newFixtureMatches: 0,
    lowConfidenceMatches: 0,
    fixtureDatesSkippedByAccess: 0,
    mappedMatches: 0,
    signalsMapped: 0,
    injuryCalls: 0,
    injurySkippedByAccess: 0,
    injuryBulkFallbacks: 0,
    injuryFixtureFallbackCalls: 0,
    injurySkippedByBudget: 0,
    lineupCalls: 0,
    lineupsRejectedPostCutoff: 0,
    oddsCalls: 0,
    oddsRejectedPostCutoff: 0,
    liveScoreCalls: 0,
    liveScoreEligibleMatches: 0,
    liveScoreObservations: 0,
    liveScoreSkippedByBudget: 0,
    liveScoreErrors: 0,
    entityRegistryFile: ENTITY_REGISTRY_FILE,
    entityEvidenceRows: 0,
    entityConflictsAdded: 0,
    entityEvidenceBlockers: {},
    callsThisSync: 0,
    maxCallsPerSync: MAX_CALLS_PER_SYNC,
    credentialState,
    suspensionProbeMinutes: SUSPENSION_PROBE_MINUTES,
    errors: []
  };

  const currentMatches = readJsonFile(CURRENT_MATCHES_FILE, readJsonFile(FALLBACK_MATCHES_FILE, []));
  const matches = Array.isArray(currentMatches) ? currentMatches : [];
  stats.matchCount = matches.length;
  stats.eligibleMatches = matches.filter(isEligibleMatch).length;

  if (!ENABLED || !API_KEY) {
    // Disabled provider access must not preserve old, unverified numeric
    // fragments. Existing registry-exact rows remain eligible for cached use;
    // every other API-Football fragment is reduced to audit metadata.
    try {
      const committedRegistry = loadEntityRegistry(ENTITY_REGISTRY_FILE, { createdAt: startedAt });
      const eligibleMatches = matches.filter(isEligibleMatch);
      const committedVerifiedSet = buildVerifiedMappingSet(eligibleMatches, cache, committedRegistry);
      stats.verifiedMappingCount = committedVerifiedSet.size;
      stats.unverifiedMappingCount = eligibleMatches.filter((match) => (
        cache.fixtureMap[matchKey(match)]?.fixtureId
        && !committedVerifiedSet.has(matchKey(match))
      )).length;
      mergeExternalSignals(matches, cache, {}, stats, committedVerifiedSet);
    } catch (error) {
      stats.ok = false;
      stats.errors.push(error.message || String(error));
    }
    const skipped = {
      ...stats,
      skipped: true,
      reason: !RUNTIME_POLICY.requested
        ? "ENABLE_API_FOOTBALL_SYNC must be exactly 1"
        : !RUNTIME_POLICY.modeSupported
          ? `unsupported API_FOOTBALL_SYNC_MODE: ${RUNTIME_POLICY.mode}`
          : "API_FOOTBALL_KEY is not configured",
      finishedAt: nowIso()
    };
    writeMeta(skipped);
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  let verifiedMappingSet = new Set();
  let externalSignalsMerged = false;

  try {
    const entityRegistryFileExisted = fs.existsSync(ENTITY_REGISTRY_FILE);
    let entityRegistry = loadEntityRegistry(ENTITY_REGISTRY_FILE, { createdAt: startedAt });
    let persistedEntityRegistryHash = entityRegistryFileExisted ? entityRegistry.registryHash : null;
    const absorbKnownFixtureMaps = (trustContexts = new Map()) => {
      const learned = absorbEntityResolutionEvidence(matches, cache, entityRegistry, trustContexts);
      entityRegistry = learned.registry;
      stats.entityEvidenceRows += learned.changedRows;
      stats.entityConflictsAdded += learned.conflictsAdded;
      for (const [blocker, count] of Object.entries(learned.blockers)) {
        stats.entityEvidenceBlockers[blocker] = Number(stats.entityEvidenceBlockers[blocker] || 0) + Number(count || 0);
      }
      if (learned.changedRows > 0 || !fs.existsSync(ENTITY_REGISTRY_FILE)) {
        writeEntityRegistryAtomic(ENTITY_REGISTRY_FILE, entityRegistry, {
          expectedRegistryHash: persistedEntityRegistryHash,
        });
        persistedEntityRegistryHash = entityRegistry.registryHash;
      }
    };
    absorbKnownFixtureMaps();
    const initiallyCommittedRegistry = loadEntityRegistry(ENTITY_REGISTRY_FILE);
    if (initiallyCommittedRegistry.registryHash !== entityRegistry.registryHash) {
      throw new Error("initial entity registry commit hash mismatch; provider enrichment remains blocked");
    }
    entityRegistry = initiallyCommittedRegistry;
    verifiedMappingSet = buildVerifiedMappingSet(
      matches.filter(isEligibleMatch),
      cache,
      entityRegistry,
    );
    stats.verifiedMappingCount = verifiedMappingSet.size;
    stats.unverifiedMappingCount = matches.filter(isEligibleMatch).filter((match) => (
      cache.fixtureMap[matchKey(match)]?.fixtureId
      && !verifiedMappingSet.has(matchKey(match))
    )).length;
    const accountStatus = await preflightAccountStatus(cache, requestBudget);
    stats.accountStatus = accountStatus;
    if (!accountStatus.eligible) {
      stats.ok = false;
      stats.skipped = true;
      stats.failClosed = true;
      stats.reason = accountStatus.reason || "API-Football account preflight blocked this sync.";
      return;
    }

    const liveTrustContexts = await resolveFixtureMaps(
      matches,
      cache,
      stats,
      entityRegistry,
      requestBudget,
    );
    if (liveTrustContexts.size > 0) absorbKnownFixtureMaps(liveTrustContexts);
    // A current-cycle mapping is not consumable merely because the in-memory
    // learning call succeeded. Re-read the committed registry and require the
    // exact content hash before constructing the downstream allow-list.
    const committedEntityRegistry = loadEntityRegistry(ENTITY_REGISTRY_FILE);
    if (committedEntityRegistry.registryHash !== entityRegistry.registryHash) {
      throw new Error("entity registry commit hash mismatch; provider enrichment remains blocked");
    }
    entityRegistry = committedEntityRegistry;
    const fixtureBlockReason = accountAccessSkipReason(cache);
    if (fixtureBlockReason) {
      stats.ok = false;
      stats.skipped = true;
      stats.failClosed = true;
      stats.reason = fixtureBlockReason;
      return;
    }
    const eligibleMatches = matches.filter(isEligibleMatch);
    verifiedMappingSet = buildVerifiedMappingSet(
      eligibleMatches,
      cache,
      entityRegistry,
      liveTrustContexts,
    );
    const mappedMatches = selectVerifiedMappedMatches(
      eligibleMatches,
      cache,
      verifiedMappingSet,
    );
    stats.verifiedMappingCount = verifiedMappingSet.size;
    stats.unverifiedMappingCount = eligibleMatches.filter((match) => (
      cache.fixtureMap[matchKey(match)]?.fixtureId
      && !verifiedMappingSet.has(matchKey(match))
    )).length;
    stats.mappedMatches = mappedMatches.length;

    const apiPieces = {};
    if (LIVE_SCORE_ENABLED) {
      await fetchLiveScores(mappedMatches, cache, stats, apiPieces, verifiedMappingSet, requestBudget);
    }
    if (INJURIES_ENABLED && !accountAccessSkipReason(cache)) {
      await fetchInjuries(mappedMatches, cache, stats, apiPieces, verifiedMappingSet, requestBudget);
    }
    if (LINEUPS_ENABLED && !accountAccessSkipReason(cache)) {
      await fetchLineups(mappedMatches, cache, stats, apiPieces, verifiedMappingSet, requestBudget);
    }
    if (ODDS_ENABLED && !accountAccessSkipReason(cache)) {
      await fetchOdds(mappedMatches, cache, stats, apiPieces, verifiedMappingSet, requestBudget);
    }
    const enrichmentBlockReason = accountAccessSkipReason(cache);
    if (enrichmentBlockReason) {
      stats.ok = false;
      stats.skipped = true;
      stats.failClosed = true;
      stats.reason = enrichmentBlockReason;
      return;
    }
    hydrateCachedApiPieces(mappedMatches, cache, apiPieces, verifiedMappingSet);
    stats.callsThisSync = requestBudget.attempts;

    mergeExternalSignals(matches, cache, apiPieces, stats, verifiedMappingSet);
    externalSignalsMerged = true;
  } catch (error) {
    stats.ok = false;
    stats.errors.push(error.message || String(error));
    appendError(cache, error);
  } finally {
    if (!externalSignalsMerged) {
      try {
        mergeExternalSignals(matches, cache, {}, stats, verifiedMappingSet);
        externalSignalsMerged = true;
      } catch (error) {
        stats.ok = false;
        stats.errors.push(`fail-closed external signal cleanup failed: ${error.message || String(error)}`);
        appendError(cache, error);
      }
    }
    cache.updatedAt = nowIso();
    writeJsonFile(CACHE_FILE, cache);
    const meta = {
      ...stats,
      callsThisSync: requestBudget.attempts,
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  TEAM_ALIASES,
  LEAGUE_ALIASES,
  accountAccessSkipReason,
  absorbEntityResolutionEvidence,
  aliasesFor,
  buildFixtureResolutionPlan,
  buildInjuriesByFixture,
  buildInjuryRequestPlan,
  buildLiveScoreObservation,
  buildLiveScoreRequestPlan,
  buildLineups,
  buildPieceMetadata,
  buildVerifiedMappingSet,
  createCache,
  createRequestBudget,
  credentialFingerprintFor,
  confidenceForFixture,
  isBulkIdsUnsupportedError,
  fixtureAccessSkipReason,
  mappingVerificationState,
  rememberFixtureAccessError,
  apiGet,
  main,
  maxCallsPerSyncFor,
  mergeSignal,
  normalizeAccountStatus,
  normalizeCache,
  normalizeName,
  runtimePolicyFor,
  statusRefreshMinutesFor,
  synchronizeCredentialState,
  prematchCutoffFor,
  restrictToVerifiedMappings,
  selectVerifiedMappedMatches,
  stripLegacyGenericApiFootballOdds,
  stripUnverifiedApiFootballFeatures,
  temporalEligibilityFor
};
