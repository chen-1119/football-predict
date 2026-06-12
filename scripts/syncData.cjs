const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

const SPORTTERY_BASE = "https://webapi.sporttery.cn";
const CURRENT_URL = `${SPORTTERY_BASE}/gateway/uniform/football/getMatchListV1.qry?clientCode=3001`;
const CALCULATOR_URL = `${SPORTTERY_BASE}/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=hhad,had&channel=c`;
const PAGE_SIZE = Math.max(1, Number(process.env.SPORTTERY_PAGE_SIZE || 80));
const PAGE_DEPTH = Math.max(1, Number(process.env.SPORTTERY_PAGE_DEPTH || 120));
const WINDOW_BACK_DAYS = Math.max(0, Number(process.env.MATCH_WINDOW_BACK_DAYS || 365));
const WINDOW_FORWARD_DAYS = Math.max(1, Number(process.env.MATCH_WINDOW_FORWARD_DAYS || 14));
const ODDS_HISTORY_RETENTION_DAYS = Math.max(1, Number(process.env.ODDS_HISTORY_RETENTION_DAYS || 365));
const ODDS_HISTORY_BUCKET_MINUTES = Math.max(1, Number(process.env.ODDS_HISTORY_BUCKET_MINUTES || 5));
const PAGE_POLL_SECONDS = Math.max(15, Number(process.env.PAGE_POLL_SECONDS || 30));
const ANALYST_PROMPT_VERSION = "professional-football-analyst-v16";
const PREDICTION_POLICY_VERSION = "sporttery-day-formula-trace-v33";
const ANALYST_RUNTIME = Object.freeze({
  model: "5.5",
  reasoningEffort: "high",
  promptDocument: "docs/professional-analysis-prompt.md",
});
const FORM_LOOKBACK_MATCHES = 12;
const PREDICTION_SNAPSHOT_RETENTION_DAYS = Math.max(30, Number(process.env.PREDICTION_SNAPSHOT_RETENTION_DAYS || 365));
const PREDICTION_SNAPSHOT_MAX_ROWS = Math.max(500, Number(process.env.PREDICTION_SNAPSHOT_MAX_ROWS || 5000));
const METHODS = (process.env.SPORTTERY_METHODS || "concern,live,result,all")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const STATUS_PRIORITY = { FINISHED: 6, LIVE: 5, PENDING_RESULT: 4, SCHEDULED: 2 };
const PREDICTION_DATA_POLICY = {
  zh: "竞彩截止前，赛前分析先由 Elo 强度、长期历史样本、近一年状态、赛程密度、世界杯先验、比分分布与公开赛前信息层生成独立预测；官方 HAD/HHAD SP 和 SP 走势只用于校验市场分歧与价值风险。截止后保留历史预测，只结算赛果，不回写旧推荐。",
  en: "Before the Sporttery cutoff, pre-match reads first build an independent forecast from Elo strength, long-run history, recent form, schedule density, World Cup priors, score distribution, and public pre-match signals. Official HAD/HHAD SP and SP movement are used only to validate market disagreement and value risk. After cutoff, the historical prediction is kept and only settlement is added.",
};
const PREDICTION_MODEL_BASIS = {
  zh: "模型按竞彩日归档、按官方开赛时间排序；先用 Elo、长期历史样本、近一年状态、世界杯先验、赛程密度与 Poisson 比分分布生成独立足球预测。官方 SP/让球 SP 只用于市场校验、价值差比较和风险标签，不再驱动最终概率。",
  en: "Schedules are grouped by Sporttery day and sorted by official kickoff time. The model first builds an independent football forecast from Elo, long-run history, recent form, World Cup priors, and Poisson score distribution. Official SP/handicap SP are used only for market validation, value comparison, and risk tags; they do not drive the final probability.",
};
const ANALYST_OUTPUT_SECTIONS = Object.freeze([
  { id: "baseline", zh: "一、比赛基本面分析", en: "1. Fixture baseline" },
  { id: "recent-form", zh: "二、近期状态分析", en: "2. Recent form" },
  { id: "home-away", zh: "三、主客场表现分析", en: "3. Home and away split" },
  { id: "attack", zh: "四、进攻能力分析", en: "4. Attack" },
  { id: "defense", zh: "五、防守能力分析", en: "5. Defense" },
  { id: "lineup", zh: "六、伤停与首发阵容分析", en: "6. Injuries and starting XI" },
  { id: "tactics", zh: "七、战术风格与克制关系分析", en: "7. Tactical matchup" },
  { id: "schedule-motivation", zh: "八、赛程体能与战意分析", en: "8. Schedule, fitness, motivation" },
  { id: "h2h", zh: "九、历史交锋分析", en: "9. Head to head" },
  { id: "environment-referee", zh: "十、天气、场地与裁判因素", en: "10. Weather, pitch, referee" },
  { id: "market", zh: "十一、赔率与盘口分析", en: "11. Odds and market" },
  { id: "verdict", zh: "十二、综合判断与预测结论", en: "12. Verdict" },
]);
const PROBABILITY_FORECASTING_PRINCIPLES = Object.freeze({
  zh: [
    "先输出胜平负、比分分布、大小球、双方进球和让球概率，不把任务简化成只猜胜负。",
    "独立概率先由 Elo 强度、Poisson 比分模型、近一年攻防、长期历史样本、世界杯先验和赛程密度生成；官方 SP 只作为市场校验和价值差参考。",
    "推荐阈值跟随 model-calibration 动态变化；低命中联赛、市场或方向自动降权并提高概率差与让球支持要求。",
    "回测必须按时间滚动，严禁赛后 xG、赛后射门、最终排名、未公开首发或时间点不一致的临场赔率泄漏。",
    "评估以 log loss、Brier score、校准误差和分桶可靠性为主，命中率只作为辅助观察。",
  ],
  en: [
    "Output 1X2, score distribution, totals, BTTS, and handicap probabilities first instead of reducing the task to one winner.",
    "Independent probabilities are generated first from Elo strength, Poisson score modelling, last-year attack/defense form, long-run history, World Cup priors, and schedule density; official SP is only market validation and value-gap reference.",
    "Recommendation gates follow model-calibration dynamically; cold leagues, markets, or directions are down-weighted with higher probability-gap and handicap-support requirements.",
    "Backtests must be time-ordered and must not leak post-match xG, post-match shots, final table rank, unpublished lineups, or late odds into earlier forecast nodes.",
    "Evaluate with log loss, Brier score, calibration error, and bucket reliability; hit rate is only a secondary diagnostic.",
  ],
});
const FORECAST_TARGET_SCHEMA = Object.freeze([
  { id: "one-x-two", zh: "胜平负：主胜、平局、客胜三项概率", en: "1X2: home, draw, away probabilities" },
  { id: "score-distribution", zh: "比分分布：2-3 个最高概率比分", en: "Score distribution: top 2-3 scorelines" },
  { id: "goal-lines", zh: "大小球：大/小 2.5 概率", en: "Goal line: over/under 2.5 probabilities" },
  { id: "btts", zh: "双方进球：BTTS Yes/No 概率", en: "BTTS: yes/no probabilities" },
  { id: "handicap", zh: "让球概率：当前官方让球线支持率", en: "Handicap: support at the current official line" },
]);
const MODELING_STACK = Object.freeze([
  { id: "independent-baseline", zh: "独立基准：Elo、历史样本、世界杯先验与 Poisson 概率", en: "Independent baseline: Elo, historical samples, World Cup priors, and Poisson probabilities" },
  { id: "elo", zh: "Elo/Glicko 强度：球队动态评分、主场优势和强弱差", en: "Elo/Glicko strength: dynamic rating, home advantage, team gap" },
  { id: "poisson", zh: "Poisson/Dixon-Coles：进球期望、比分矩阵、大小球和让球聚合", en: "Poisson/Dixon-Coles: goal expectations, score matrix, totals, handicap aggregation" },
  { id: "ml", zh: "机器学习层：仅在基准稳定并完成时间滚动回测后加入", en: "ML layer: added only after stable baselines and time-ordered backtests" },
  { id: "ensemble", zh: "集成层：用滚动验证集优化强度/Elo/Poisson/ML 权重", en: "Ensemble: optimize strength/Elo/Poisson/ML weights on rolling validation" },
  { id: "calibration", zh: "校准层：可靠性曲线、Platt、isotonic、联赛和场景分桶", en: "Calibration: reliability curves, Platt, isotonic, league and profile buckets" },
]);
const FEATURE_PRIORITY = Object.freeze([
  "long-term-team-strength",
  "independent-model-probability",
  "xg-xga-gap-when-connected",
  "home-away-split-and-travel",
  "injuries-and-lineup-quality",
  "rest-days-and-schedule-density",
  "style-matchup",
  "motivation",
  "weather-and-pitch",
  "referee-tendency",
]);
const QUALITY_STANDARDS = Object.freeze({
  zh: [
    "必须输出概率，而不是只输出胜负结论。",
    "必须按时间滚动回测，不能随机切分。",
    "必须校准概率，并按联赛、场景和赔率区间分桶评估。",
    "必须避免未来信息泄漏。",
    "必须长期接近或优于简单赔率基准，否则不升格为推荐。",
    "必须保留赛前快照，赛后只结算和复盘，不改写原方向。",
  ],
  en: [
    "Output probabilities, not just a winner.",
    "Use time-ordered rolling backtests, not random splits.",
    "Calibrate probabilities and evaluate by league, profile, and odds bucket.",
    "Avoid future-information leakage.",
    "Approach or beat the simple market baseline long term before promoting recommendations.",
    "Keep pre-match snapshots; after kickoff only settle and review, never rewrite the original direction.",
  ],
});
const PREDICTION_ANALYST_FRAMEWORK = Object.freeze({
  version: ANALYST_PROMPT_VERSION,
  role: {
    zh: "专业足球赛事分析师",
    en: "Professional football analyst",
  },
  runtime: ANALYST_RUNTIME,
  outputSections: ANALYST_OUTPUT_SECTIONS,
  probabilityPrinciples: PROBABILITY_FORECASTING_PRINCIPLES,
  forecastTargets: FORECAST_TARGET_SCHEMA,
  modelingStack: MODELING_STACK,
  featurePriority: FEATURE_PRIORITY,
  qualityStandards: QUALITY_STANDARDS,
  finalVerdict: {
    zh: "结论必须区分稳妥方向和激进方向；胜平负与让球方向保持一致；数据不足时明确标注，不为推荐而硬推。",
    en: "The verdict must split conservative and aggressive directions; 1X2 and handicap views must stay consistent; missing data is labelled and no pick is forced.",
  },
});

const SPORTTERY_REQUEST_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  Referer: "https://m.sporttery.cn/mjc/zqhh/?tab=all",
  Origin: "https://m.sporttery.cn",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

function sportteryOutboundProxy() {
  return normText(process.env.SPORTTERY_OUTBOUND_PROXY || process.env.SPORTTERY_HTTP_PROXY || "");
}

function curlHeaderArgs(tab = "all") {
  return Object.entries({
    ...SPORTTERY_REQUEST_HEADERS,
    Referer: `https://m.sporttery.cn/mjc/zqhh/?tab=${encodeURIComponent(tab || "all")}`,
  }).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
}
function normText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function toNum(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 2166136261;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function seeded(seed) {
  let x = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i += 1) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
}

function colorFromName(name) {
  let hash = 2166136261;
  const text = String(name || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `#${(hash >>> 8).toString(16).slice(0, 6).padStart(6, "0")}`;
}

const FIFA_TO_ISO = {
  ALB: "AL",
  ALG: "DZ",
  ARG: "AR",
  ARM: "AM",
  AUS: "AU",
  AUT: "AT",
  BEL: "BE",
  BIH: "BA",
  BRA: "BR",
  BUL: "BG",
  CAN: "CA",
  CHI: "CL",
  CHN: "CN",
  CIV: "CI",
  COL: "CO",
  CRC: "CR",
  CRO: "HR",
  CUW: "CW",
  CYP: "CY",
  CZE: "CZ",
  DEN: "DK",
  ECU: "EC",
  ENG: "GB",
  ESP: "ES",
  FRA: "FR",
  GER: "DE",
  GRE: "GR",
  HAI: "HT",
  HUN: "HU",
  IRL: "IE",
  ISR: "IL",
  ITA: "IT",
  JOR: "JO",
  JPN: "JP",
  KOR: "KR",
  MEX: "MX",
  MAR: "MA",
  NED: "NL",
  NGA: "NG",
  NIR: "GB",
  NOR: "NO",
  PAR: "PY",
  PER: "PE",
  POL: "PL",
  POR: "PT",
  QAT: "QA",
  ROU: "RO",
  SCO: "GB",
  SRB: "RS",
  SLO: "SI",
  SUI: "CH",
  SVK: "SK",
  SWE: "SE",
  THA: "TH",
  TUR: "TR",
  UKR: "UA",
  URU: "UY",
  UZB: "UZ",
  USA: "US",
  WAL: "GB",
};

const TEAM_NAME_TO_ISO = {
  "\u4e2d\u56fd": "CN",
  "\u5308\u7259\u5229": "HU",
  "\u4f0a\u62c9\u514b": "IQ",
  "\u65af\u6d1b\u4f10\u514b": "SK",
  "\u65b0\u52a0\u5761": "SG",
  "斯洛文尼亚": "SI",
  "塞浦路斯": "CY",
  "瑞典": "SE",
  "希腊": "GR",
  "法国": "FR",
  "科特迪瓦": "CI",
  "墨西哥": "MX",
  "塞尔维亚": "RS",
  "哥伦比亚": "CO",
  "哥斯达黎加": "CR",
  "荷兰": "NL",
  "西班牙": "ES",
  "意大利": "IT",
  "英格兰": "GB",
  "德国": "DE",
  "葡萄牙": "PT",
  "巴西": "BR",
  "阿根廷": "AR",
  "美国": "US",
  "日本": "JP",
  "韩国": "KR",
  "乌兹别克斯坦": "UZ",
  "保加利亚": "BG",
  "克罗地亚": "HR",
  "冰岛": "IS",
  "刚果(金)": "CD",
  "刚果": "CG",
  "加拿大": "CA",
  "加纳": "GH",
  "北马其顿": "MK",
  "卡塔尔": "QA",
  "土耳其": "TR",
  "塞内加尔": "SN",
  "奥地利": "AT",
  "威尔士": "GB-WLS",
  "卢森堡": "LU",
  "巴拿马": "PA",
  "库拉索": "CW",
  "挪威": "NO",
  "捷克": "CZ",
  "格鲁吉亚": "GE",
  "比利时": "BE",
  "波黑": "BA",
  "澳大利亚": "AU",
  "爱尔兰": "IE",
  "瑞士": "CH",
  "科索沃": "XK",
  "突尼斯": "TN",
  "约旦": "JO",
  "罗马尼亚": "RO",
  "芬兰": "FI",
  "苏格兰": "GB-SCT",
  "黑山": "ME",
  "阿尔及利亚": "DZ",
  "丹麦": "DK",
  "波兰": "PL",
  "尼日利亚": "NG",
  "秘鲁": "PE",
  "北爱尔兰": "GB",
  "泰国": "TH",
  "哈萨": "KZ",
  "哈萨克斯坦": "KZ",
  "南非": "ZA",
  "巴拉": "PY",
  "巴拉圭": "PY",
  "摩洛": "MA",
  "摩洛哥": "MA",
  "海地": "HT",
  "厄瓜": "EC",
  "厄瓜多尔": "EC",
  "乌兹别克": "UZ",
  "乌兹别克斯坦": "UZ",
  "乌拉圭": "UY",
  "委内": "VE",
  "委内瑞拉": "VE",
  "埃及": "EG",
  "新西兰": "NZ",
  "刚果民主共和国": "CD",
  "刚果金": "CD",
};

function flagEmojiFromIso(isoCode) {
  const code = normText(isoCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...code.split("").map((letter) => 127397 + letter.charCodeAt(0)));
}

const J_LEAGUE_LOGO_BASE = "./team-logos/jleague";

const CLUB_LOGO_BY_NAME = {
  "\u5766\u4f69\u96f7\u5c71\u732b": "https://media.api-sports.io/football/teams/1163.png",
  "Ilves": "https://media.api-sports.io/football/teams/1163.png",
  "TPS\u56fe\u5c14\u5e93": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "TPS Turku": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "Turun Palloseura": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "\u56fd\u9645\u56fe\u5c14\u5e93": "https://media.api-sports.io/football/teams/1164.png",
  "Inter Turku": "https://media.api-sports.io/football/teams/1164.png",
  "AC\u5965\u5362": "https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg",
  "AC Oulu": "https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg",
  "\u96c5\u7f57": "https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg",
  "FF Jaro": "https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg",
  "\u8d6b\u5c14\u8f9b\u57fa": "https://media.api-sports.io/football/teams/649.png",
  "HJK Helsinki": "https://media.api-sports.io/football/teams/649.png",
  "\u74e6\u8428": "https://media.api-sports.io/football/teams/650.png",
  "VPS": "https://media.api-sports.io/football/teams/650.png",
  "\u5e93\u5965\u76ae\u5965": "https://media.api-sports.io/football/teams/1165.png",
  "KuPS": "https://media.api-sports.io/football/teams/1165.png",
  "\u739b\u4e3d\u6e2f": "https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg",
  "IFK Mariehamn": "https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg",
  "\u8d6b\u5c14\u8f9b\u57fa\u706b\u82b1": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "IF Gnistan": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "Gnistan": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "\u62c9\u8d6b\u8482": "https://media.api-sports.io/football/teams/1166.png",
  "Lahti": "https://media.api-sports.io/football/teams/1166.png",
  "\u585e\u4f0a\u5948\u7ea6\u57fa": "https://media.api-sports.io/football/teams/689.png",
  "SJK": "https://media.api-sports.io/football/teams/689.png",
  "\u9e7f\u5c9b\u9e7f\u89d2": `${J_LEAGUE_LOGO_BASE}/kashima-antlers.png`,
  "\u795e\u6237\u80dc\u5229\u8239": `${J_LEAGUE_LOGO_BASE}/vissel-kobe.png`,
  "\u753a\u7530\u6cfd\u7ef4\u4e9a": `${J_LEAGUE_LOGO_BASE}/machida-zelvia.png`,
  "\u540d\u53e4\u5c4b\u9cb8\u516b": `${J_LEAGUE_LOGO_BASE}/nagoya-grampus.png`,
  "\u540d\u53e4\u5c4b\u9cb8": `${J_LEAGUE_LOGO_BASE}/nagoya-grampus.png`,
  "\u6d66\u548c\u7ea2\u94bb": `${J_LEAGUE_LOGO_BASE}/urawa-red-diamonds.png`,
  "\u5188\u5c71\u7eff\u96c9": `${J_LEAGUE_LOGO_BASE}/fagiano-okayama.png`,
  "\u6a2a\u6ee8\u6c34\u624b": `${J_LEAGUE_LOGO_BASE}/yokohama-f-marinos.png`,
  "\u6e05\u6c34\u9f13\u52a8": `${J_LEAGUE_LOGO_BASE}/shimizu-s-pulse.png`,
  "\u67cf\u592a\u9633\u795e": `${J_LEAGUE_LOGO_BASE}/kashiwa-reysol.png`,
  "\u4eac\u90fd\u4e0d\u6b7b\u9e1f": `${J_LEAGUE_LOGO_BASE}/kyoto-sanga.png`,
  "\u5ddd\u5d0e\u524d\u950b": `${J_LEAGUE_LOGO_BASE}/kawasaki-frontale.png`,
  "\u5e7f\u5c9b\u4e09\u7bad": `${J_LEAGUE_LOGO_BASE}/sanfrecce-hiroshima.png`,
  "FC\u4e1c\u4eac": `${J_LEAGUE_LOGO_BASE}/fc-tokyo.png`,
  "\u4e1c\u4eacFC": `${J_LEAGUE_LOGO_BASE}/fc-tokyo.png`,
  "\u4e1c\u4eac\u7eff\u8335": `${J_LEAGUE_LOGO_BASE}/tokyo-verdy.png`,
  "\u6a2a\u6ee8FC": `${J_LEAGUE_LOGO_BASE}/yokohama-fc.png`,
  "\u6e58\u5357\u6d77\u6d0b": `${J_LEAGUE_LOGO_BASE}/shonan-bellmare.png`,
  "\u5927\u962a\u94a2\u5df4": `${J_LEAGUE_LOGO_BASE}/gamba-osaka.png`,
  "\u5927\u962a\u98de\u811a": `${J_LEAGUE_LOGO_BASE}/gamba-osaka.png`,
  "\u5927\u962a\u6a31\u82b1": `${J_LEAGUE_LOGO_BASE}/cerezo-osaka.png`,
  "\u798f\u5188\u9ec4\u8702": `${J_LEAGUE_LOGO_BASE}/avispa-fukuoka.png`,
  "\u65b0\u6cfb\u5929\u9e45": `${J_LEAGUE_LOGO_BASE}/albirex-niigata.png`,
  "\u5317\u6d77\u9053\u672d\u5e4c\u5188\u8428\u591a": `${J_LEAGUE_LOGO_BASE}/consadole-sapporo.png`,
  "\u672d\u5e4c\u5188\u8428\u591a": `${J_LEAGUE_LOGO_BASE}/consadole-sapporo.png`,
  "\u78d0\u7530\u559c\u60a6": `${J_LEAGUE_LOGO_BASE}/jubilo-iwata.png`,
  "\u9e1f\u6816\u6c99\u5ca9": `${J_LEAGUE_LOGO_BASE}/sagan-tosu.png`,
  "\u9e1f\u6816\u7802\u5ca9": `${J_LEAGUE_LOGO_BASE}/sagan-tosu.png`,
  "曼彻斯特城": "https://media.api-sports.io/football/teams/50.png",
  "曼城": "https://media.api-sports.io/football/teams/50.png",
  "利物浦": "https://media.api-sports.io/football/teams/40.png",
  "阿森纳": "https://media.api-sports.io/football/teams/42.png",
  "切尔西": "https://media.api-sports.io/football/teams/49.png",
  "曼彻斯特联": "https://media.api-sports.io/football/teams/33.png",
  "曼联": "https://media.api-sports.io/football/teams/33.png",
  "托特纳姆热刺": "https://media.api-sports.io/football/teams/47.png",
  "热刺": "https://media.api-sports.io/football/teams/47.png",
  "水晶宫": "https://media.api-sports.io/football/teams/52.png",
  "阿斯顿维拉": "https://media.api-sports.io/football/teams/66.png",
  "皇家马德里": "https://media.api-sports.io/football/teams/541.png",
  "皇马": "https://media.api-sports.io/football/teams/541.png",
  "巴塞罗那": "https://media.api-sports.io/football/teams/529.png",
  "巴萨": "https://media.api-sports.io/football/teams/529.png",
  "马德里竞技": "https://media.api-sports.io/football/teams/530.png",
  "马竞": "https://media.api-sports.io/football/teams/530.png",
  "皇家社会": "https://media.api-sports.io/football/teams/548.png",
  "拜仁慕尼黑": "https://media.api-sports.io/football/teams/157.png",
  "拜仁": "https://media.api-sports.io/football/teams/157.png",
  "多特蒙德": "https://media.api-sports.io/football/teams/165.png",
  "多特": "https://media.api-sports.io/football/teams/165.png",
  "勒沃库森": "https://media.api-sports.io/football/teams/168.png",
  "国际米兰": "https://media.api-sports.io/football/teams/505.png",
  "国米": "https://media.api-sports.io/football/teams/505.png",
  "AC米兰": "https://media.api-sports.io/football/teams/489.png",
  "尤文图斯": "https://media.api-sports.io/football/teams/496.png",
  "尤文": "https://media.api-sports.io/football/teams/496.png",
};

function isoFromTeam(teamName, teamCode) {
  return FIFA_TO_ISO[normText(teamCode).toUpperCase()] || TEAM_NAME_TO_ISO[normText(teamName)] || "";
}

function flagImageFromIso(isoCode) {
  const code = normText(isoCode).toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{3})?$/.test(code)) return "";
  return `https://flagcdn.com/w80/${code}.png`;
}

function initialsFromName(teamName, teamCode) {
  const code = normText(teamCode).toUpperCase();
  if (/^[A-Z]{2,4}$/.test(code)) return code.slice(0, 3);
  return normText(teamName, "FC").slice(0, 2).toUpperCase();
}

function normalizeLogoUrl(rawLogo) {
  const logo = normText(rawLogo);
  if (!logo) return "";
  if (/^https?:\/\//i.test(logo)) return logo;
  if (logo.startsWith("//")) return `https:${logo}`;
  if (logo.startsWith("/")) return `${SPORTTERY_BASE}${logo}`;
  return logo;
}

function teamLogoInfo(teamName, teamCode, rawLogo) {
  const suppliedLogo = normalizeLogoUrl(rawLogo);
  if (suppliedLogo) return { logo: suppliedLogo, logoType: "crest" };

  const isoCode = isoFromTeam(teamName, teamCode);
  if (isoCode) {
    return {
      logo: flagImageFromIso(isoCode) || flagEmojiFromIso(isoCode),
      logoType: "flag",
      countryIso: isoCode,
    };
  }

  const clubLogo = CLUB_LOGO_BY_NAME[normText(teamName)];
  if (clubLogo) return { logo: clubLogo, logoType: "crest" };

  return { logo: initialsFromName(teamName, teamCode), logoType: "crest-placeholder" };
}

function scoreFromSections(section) {
  const match = normText(section).match(/(\d+)\s*[:\-]\s*(\d+)/);
  if (!match) return { home: null, away: null };
  return { home: Number(match[1]), away: Number(match[2]) };
}

function scoreFromRow(row) {
  const sectionScore = scoreFromSections(
    row.sectionsNo999 ||
    row.sectionsNo1 ||
    row.fullScore ||
    row.finalScore ||
    row.matchScore ||
    row.currentScore ||
    row.liveScore ||
    row.score
  );
  const home = toNum(
    row.homeScore,
    toNum(
      row.homeTeamScore,
      toNum(row.homeGoals, toNum(row.homeGoal, toNum(row.homeFullScore, toNum(row.homeLiveScore, sectionScore.home))))
    )
  );
  const away = toNum(
    row.awayScore,
    toNum(
      row.awayTeamScore,
      toNum(row.awayGoals, toNum(row.awayGoal, toNum(row.awayFullScore, toNum(row.awayLiveScore, sectionScore.away))))
    )
  );
  return { home, away };
}

function parseKickoff(matchDate, matchTime) {
  const date = normText(matchDate);
  const time = normText(matchTime);
  if (!date) return new Date().toISOString();
  const hhmm = /^\d{2}:\d{2}$/.test(time)
    ? `${time}:00`
    : /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? time
      : "00:00:00";
  return `${date}T${hhmm}+08:00`;
}

const SPORTTERY_WEEKDAY_INDEX = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6
};

function beijingDateOffset(ymd, offsetDays) {
  const baseMs = Date.parse(`${ymd}T00:00:00+08:00`);
  if (!Number.isFinite(baseMs)) return "";
  return new Date(baseMs + offsetDays * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function beijingWeekday(ymd) {
  const baseMs = Date.parse(`${ymd}T00:00:00+08:00`);
  if (!Number.isFinite(baseMs)) return null;
  return new Date(baseMs + 8 * 60 * 60 * 1000).getUTCDay();
}

function inferSportteryBusinessDate(matchNo, kickoffDate) {
  const rawMatchNo = normText(matchNo);
  const ymd = normText(kickoffDate);
  if (!rawMatchNo || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";

  const weekdayMatch = rawMatchNo.match(/周([日天一二三四五六])/);
  const targetWeekday = weekdayMatch ? SPORTTERY_WEEKDAY_INDEX[weekdayMatch[1]] : undefined;
  if (targetWeekday === undefined) return "";

  for (let offset = 0; offset >= -6; offset -= 1) {
    const candidate = beijingDateOffset(ymd, offset);
    if (candidate && beijingWeekday(candidate) === targetWeekday) return candidate;
  }

  return "";
}

function beijingStartOfToday() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const ymd = beijing.toISOString().slice(0, 10);
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

function inMatchWindow(match) {
  const t = Date.parse(match.kickoffTime);
  if (!Number.isFinite(t)) return true;
  const start = beijingStartOfToday() - WINDOW_BACK_DAYS * 24 * 60 * 60 * 1000;
  const end = beijingStartOfToday() + (WINDOW_FORWARD_DAYS + 1) * 24 * 60 * 60 * 1000;
  return t >= start && t < end;
}

function statusFromSporttery(matchStatus, sellStatus, statusName = "", kickoffTime = "") {
  const matchRaw = String(matchStatus || "").trim();
  const sellRaw = String(sellStatus || "").trim();
  const nameRaw = String(statusName || "").trim();
  const lower = `${matchRaw} ${sellRaw} ${nameRaw}`.toLowerCase();
  const kickoffAt = Date.parse(kickoffTime);
  const kickoffStarted = Number.isFinite(kickoffAt) && Date.now() >= kickoffAt;
  const hasAnyName = (names) => names.some((name) => nameRaw.includes(name));

  if (["finished", "result", "ended", "completed"].some((status) => lower.includes(status))) return "FINISHED";
  if (matchRaw === "10" || hasAnyName(["待开奖", "待赛果", "待派奖", "等待开奖"])) return "PENDING_RESULT";
  if (["11", "12", "13"].includes(matchRaw)) return "FINISHED";
  if (hasAnyName(["完成", "完场", "赛果", "已开奖", "已派奖"])) return "FINISHED";
  if (!kickoffStarted) return "SCHEDULED";

  if (["playing", "live", "inplay", "firsthalf", "secondhalf"].some((status) => lower.includes(status))) return "LIVE";
  if (hasAnyName(["进行中", "比赛中", "上半场", "下半场", "中场", "加时", "点球", "暂停"])) return "LIVE";
  if (["4", "5", "6", "7", "8", "9"].includes(matchRaw)) return "LIVE";
  if (matchRaw === "3" || sellRaw === "3" || nameRaw.includes("暂停销售")) return kickoffStarted ? "LIVE" : "SCHEDULED";
  if (kickoffStarted && ["2", "3"].includes(matchRaw)) return "LIVE";
  if (kickoffStarted && ["selling", "sell"].some((status) => lower.includes(status))) return "LIVE";
  return "SCHEDULED";
}

function normalizeStatusWithScore(status, kickoffTime, scoreHome, scoreAway) {
  const hasScore = Number.isFinite(scoreHome) && Number.isFinite(scoreAway);
  if (status === "FINISHED") return status;
  if (status === "PENDING_RESULT") return hasScore ? "FINISHED" : status;
  const kickoffAt = Date.parse(kickoffTime);
  if (!Number.isFinite(kickoffAt) || !hasScore) return status;

  const elapsedMinutes = Math.floor((Date.now() - kickoffAt) / 60000);
  if (elapsedMinutes >= 125) return "FINISHED";
  if (elapsedMinutes >= 0) return "LIVE";
  return status;
}

function sanitizeOdds(raw) {
  const odds1 = toNum(raw?.odds1, null);
  const oddsX = toNum(raw?.oddsX, null);
  const odds2 = toNum(raw?.odds2, null);
  if (odds1 > 1.01 && oddsX > 1.01 && odds2 > 1.01) return { odds1, oddsX, odds2 };
  return null;
}

function sportteryPoolOdds(row, poolCode, sourceUrl, sourceMethod) {
  const rows = Array.isArray(row?.oddsList) ? row.oddsList : [];
  const code = String(poolCode).toUpperCase();
  const poolRow =
    rows.find((item) => String(item?.poolCode || "").toUpperCase() === code) ||
    row?.[code.toLowerCase()] ||
    (code === "HAD" && (row?.h || row?.d || row?.a) ? row : null);
  const odds = sanitizeOdds({
    odds1: poolRow?.h,
    oddsX: poolRow?.d,
    odds2: poolRow?.a,
  });

  if (!odds) return null;

  const updateDate = normText(poolRow?.updateDate);
  const updateTime = normText(poolRow?.updateTime);
  const handicap = code === "HAD" ? "0" : normText(poolRow?.goalLine || poolRow?.goalLineValue || row?.hhad?.goalLine, "");
  return {
    odds,
    handicap,
    oddsSource: `sporttery:${code}`,
    oddsPoolCode: code,
    oddsSourceMethod: sourceMethod,
    oddsUpdatedAt: [updateDate, updateTime].filter(Boolean).join(" ") || undefined,
    oddsSourceUrl: sourceUrl,
  };
}

function sportteryOddsInfo(row, sourceUrl, sourceMethod) {
  return {
    had: sportteryPoolOdds(row, "HAD", sourceUrl, sourceMethod),
    hhad: sportteryPoolOdds(row, "HHAD", sourceUrl, sourceMethod),
  };
}

function impliedProbabilities(odds) {
  const inv1 = 1 / odds.odds1;
  const invX = 1 / odds.oddsX;
  const inv2 = 1 / odds.odds2;
  const total = inv1 + invX + inv2 || 1;
  return { home: inv1 / total, draw: invX / total, away: inv2 / total };
}

function pct(value) {
  return Math.round(value * 100);
}

function pct1(value) {
  return Number((clamp(value, 0, 1) * 100).toFixed(1));
}

function poissonProbability(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return (Math.exp(-lambda) * lambda ** goals) / factorial;
}

function projectedScore(homeLambda, awayLambda) {
  let best = { home: 0, away: 0, probability: 0 };
  for (let home = 0; home <= 5; home += 1) {
    for (let away = 0; away <= 5; away += 1) {
      const probability = poissonProbability(homeLambda, home) * poissonProbability(awayLambda, away);
      if (probability > best.probability) best = { home, away, probability };
    }
  }
  return best;
}

function scoreMatrix(homeLambda, awayLambda, maxGoals = 8) {
  const rows = [];
  for (let home = 0; home <= maxGoals; home += 1) {
    for (let away = 0; away <= maxGoals; away += 1) {
      rows.push({
        home,
        away,
        probability: poissonProbability(homeLambda, home) * poissonProbability(awayLambda, away),
      });
    }
  }
  return rows;
}

function representativeScoreRank(row, homeLambda, awayLambda, modeProbability, preferredCode, context = {}) {
  const totalLambda = homeLambda + awayLambda;
  const totalGoals = row.home + row.away;
  const over25Probability = Number(context.over25Probability);
  const bttsProbability = Number(context.bttsProbability);
  const probabilityScore = row.probability / Math.max(modeProbability, 0.000001);
  const lambdaCloseness = 1 - Math.min(1, (Math.abs(row.home - homeLambda) + Math.abs(row.away - awayLambda)) / 4);
  const totalCloseness = 1 - Math.min(1, Math.abs(totalGoals - totalLambda) / 3);
  const diffCloseness = 1 - Math.min(1, Math.abs((row.home - row.away) - (homeLambda - awayLambda)) / 3);
  let rank = probabilityScore * 0.52 + lambdaCloseness * 0.22 + totalCloseness * 0.16 + diffCloseness * 0.1;

  if (preferredCode && oneXTwoCodeForScore(row.home, row.away) === preferredCode) rank += 0.12;
  if (totalLambda >= 2.45 && totalGoals >= 3) rank += 0.08;
  if (totalLambda >= 2.75 && totalGoals >= 4) rank += 0.05;
  if (totalLambda <= 2.05 && totalGoals <= 2) rank += 0.05;
  if (totalLambda >= 2.45 && totalGoals <= 1) rank -= 0.22;
  if (totalLambda >= 2.15 && row.home === 0 && row.away === 0) rank -= 0.18;
  if (homeLambda >= 1.55 && row.home >= 2) rank += 0.05;
  if (awayLambda >= 1.55 && row.away >= 2) rank += 0.05;
  if (Number.isFinite(over25Probability)) {
    if (over25Probability >= 0.56 && totalGoals >= 3) rank += 0.16;
    else if (over25Probability >= 0.5 && totalGoals >= 3) rank += 0.09;
    if (over25Probability <= 0.46 && totalGoals <= 2) rank += 0.11;
    if (over25Probability <= 0.42 && totalGoals >= 4) rank -= 0.14;
  }
  if (Number.isFinite(bttsProbability)) {
    if (bttsProbability >= 0.52 && row.home > 0 && row.away > 0) rank += 0.14;
    if (bttsProbability <= 0.45 && (row.home === 0 || row.away === 0)) rank += 0.08;
  }

  return rank;
}

function representativeProjectedScore(homeLambda, awayLambda, preferredCode = null, context = {}) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 8);
  const mode = matrix.reduce((best, row) => (row.probability > best.probability ? row : best), matrix[0]);
  const modeProbability = mode?.probability || 0.000001;
  let cleanPreferredCode = ["1", "X", "2"].includes(preferredCode) ? preferredCode : null;
  if (cleanPreferredCode) {
    const modeCode = oneXTwoCodeForScore(mode.home, mode.away);
    const directionalBest = matrix
      .filter((row) => oneXTwoCodeForScore(row.home, row.away) === cleanPreferredCode)
      .sort((a, b) => b.probability - a.probability)[0];
    const lambdaDiff = homeLambda - awayLambda;
    const conflictsWithLambda = (cleanPreferredCode === "1" && lambdaDiff < -0.18)
      || (cleanPreferredCode === "2" && lambdaDiff > 0.18);
    const supportThreshold = cleanPreferredCode === modeCode
      ? 0.38
      : conflictsWithLambda
        ? 0.82
        : 0.64;

    if (!directionalBest || directionalBest.probability < modeProbability * supportThreshold) {
      cleanPreferredCode = null;
    }
  }
  const directionalPool = cleanPreferredCode
    ? matrix.filter((row) => oneXTwoCodeForScore(row.home, row.away) === cleanPreferredCode)
    : matrix;
  const minProbability = modeProbability * (cleanPreferredCode ? 0.2 : 0.42);
  const plausible = directionalPool.filter((row) => (
    row.probability >= minProbability
    && row.home + row.away <= 7
  ));
  const pool = plausible.length ? plausible : directionalPool.length ? directionalPool : matrix;

  return [...pool].sort((a, b) => {
    const rankDiff = representativeScoreRank(b, homeLambda, awayLambda, modeProbability, cleanPreferredCode, context)
      - representativeScoreRank(a, homeLambda, awayLambda, modeProbability, cleanPreferredCode, context);
    if (Math.abs(rankDiff) > 0.000001) return rankDiff;
    return b.probability - a.probability;
  })[0] || projectedScore(homeLambda, awayLambda);
}

function poissonOutcomeProbabilities(homeLambda, awayLambda) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 10);
  const totals = matrix.reduce((acc, row) => {
    if (row.home > row.away) acc.home += row.probability;
    else if (row.home === row.away) acc.draw += row.probability;
    else acc.away += row.probability;
    acc.mass += row.probability;
    return acc;
  }, { home: 0, draw: 0, away: 0, mass: 0 });
  const mass = totals.mass || 1;
  return {
    home: totals.home / mass,
    draw: totals.draw / mass,
    away: totals.away / mass,
  };
}

function topScoreProbabilities(homeLambda, awayLambda, limit = 5, context = {}) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => row.home + row.away <= 8);
  const mode = matrix.reduce((best, row) => (row.probability > best.probability ? row : best), matrix[0]);
  const modeProbability = mode?.probability || 0.000001;
  const ranked = matrix
    .map((row) => ({
      ...row,
      rank: representativeScoreRank(row, homeLambda, awayLambda, modeProbability, null, context),
    }))
    .sort((a, b) => {
      const rankDiff = b.rank - a.rank;
      if (Math.abs(rankDiff) > 0.000001) return rankDiff;
      return b.probability - a.probability;
    });
  const over25Probability = Number(context.over25Probability);
  const bttsProbability = Number(context.bttsProbability);
  const selected = [];
  const seen = new Set();
  const scoreKey = (row) => `${row.home}-${row.away}`;
  const addCandidate = (predicate, minRatio = 0.22) => {
    const candidate = ranked.find((row) => (
      !seen.has(scoreKey(row))
      && row.probability >= modeProbability * minRatio
      && predicate(row)
    ));
    if (candidate) {
      selected.push(candidate);
      seen.add(scoreKey(candidate));
    }
  };

  addCandidate(() => true, 0);
  if (Number.isFinite(over25Probability)) {
    if (over25Probability >= 0.5) addCandidate((row) => row.home + row.away >= 3, 0.18);
    if (over25Probability <= 0.49) addCandidate((row) => row.home + row.away <= 2, 0.18);
  }
  if (Number.isFinite(bttsProbability)) {
    if (bttsProbability >= 0.5) addCandidate((row) => row.home > 0 && row.away > 0, 0.18);
    if (bttsProbability <= 0.45) addCandidate((row) => row.home === 0 || row.away === 0, 0.18);
  }
  for (const code of ["1", "X", "2"]) {
    if (selected.length >= Math.max(3, limit)) break;
    addCandidate((row) => oneXTwoCodeForScore(row.home, row.away) === code, 0.24);
  }
  for (const row of ranked) {
    if (selected.length >= limit) break;
    if (seen.has(scoreKey(row))) continue;
    selected.push(row);
    seen.add(scoreKey(row));
  }

  return selected
    .slice(0, limit)
    .map((row) => ({
      home: row.home,
      away: row.away,
      label: `${row.home}-${row.away}`,
      probability: pct1(row.probability),
    }));
}

function parseHandicapLine(line) {
  const value = Number(String(line || "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function handicapOutcomeProbabilities(homeLambda, awayLambda, line) {
  const handicap = parseHandicapLine(line);
  if (handicap === null) return null;

  const matrix = scoreMatrix(homeLambda, awayLambda, 10);
  const totals = matrix.reduce((acc, row) => {
    const adjustedHome = row.home + handicap;
    if (adjustedHome > row.away) acc.home += row.probability;
    else if (adjustedHome === row.away) acc.draw += row.probability;
    else acc.away += row.probability;
    acc.mass += row.probability;
    return acc;
  }, { home: 0, draw: 0, away: 0, mass: 0 });
  const mass = totals.mass || 1;
  return {
    home: totals.home / mass,
    draw: totals.draw / mass,
    away: totals.away / mass,
  };
}

function scoreOutcomeWithHandicap(home, away, handicap) {
  const diff = home + handicap - away;
  if (Math.abs(diff) < 1e-9) return "X";
  return diff > 0 ? "1" : "2";
}

function alignedScoreForHandicapPick(homeLambda, awayLambda, line, code) {
  const handicap = parseHandicapLine(line);
  if (handicap === null || !["1", "X", "2"].includes(code)) return null;

  return scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => scoreOutcomeWithHandicap(row.home, row.away, handicap) === code)
    .sort((a, b) => {
      const probabilityDiff = b.probability - a.probability;
      if (Math.abs(probabilityDiff) > 0.000001) return probabilityDiff;
      return (a.home + a.away) - (b.home + b.away);
    })[0] || null;
}

function alignLambdaToScore(currentLambda, goals, maxLambda) {
  return clamp(currentLambda * 0.25 + (goals + 0.35) * 0.75, 0.25, maxLambda);
}

function alignedHandicapForecast(homeLambda, awayLambda, line, code) {
  const score = alignedScoreForHandicapPick(homeLambda, awayLambda, line, code);
  if (!score) return null;

  return {
    score: {
      home: score.home,
      away: score.away
    },
    homeLambda: alignLambdaToScore(homeLambda, score.home, 5.2),
    awayLambda: alignLambdaToScore(awayLambda, score.away, 5.2)
  };
}

function normalizeOutcomeProbabilities(probabilities) {
  if (!probabilities) return null;
  const total = probabilities.home + probabilities.draw + probabilities.away || 1;
  return {
    home: probabilities.home / total,
    draw: probabilities.draw / total,
    away: probabilities.away / total,
  };
}

function formConfidence(formSnapshot) {
  const sampleSize = Number(formSnapshot?.sampleSize || 0);
  if (sampleSize <= 0) return 0;
  return clamp(sampleSize / 24, 0, 1);
}

function recentFormNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function recentFormCandidate(form, marketHomeLambda, marketAwayLambda, confidence, source) {
  if (!form?.home || !form?.away || confidence <= 0) return null;

  const homeAttack = recentFormNumber(form.home.goalsForAvg, marketHomeLambda);
  const homeDefense = recentFormNumber(form.home.goalsAgainstAvg, marketAwayLambda);
  const awayAttack = recentFormNumber(form.away.goalsForAvg, marketAwayLambda);
  const awayDefense = recentFormNumber(form.away.goalsAgainstAvg, marketHomeLambda);

  return {
    homeLambda: clamp(homeAttack * 0.58 + awayDefense * 0.42, 0.25, 3.6),
    awayLambda: clamp(awayAttack * 0.58 + homeDefense * 0.42, 0.25, 3.6),
    confidence,
    source,
  };
}

function fiveHundredRecentFormSnapshot(match) {
  const recentForm = match?.externalSignals?.fiveHundred?.recentForm;
  if (!recentForm?.home || !recentForm?.away) return null;

  const homeSample = Number(recentForm.home.sampleSize || 0);
  const awaySample = Number(recentForm.away.sampleSize || 0);
  const pairedSample = Math.min(homeSample, awaySample);
  if (!Number.isFinite(pairedSample) || pairedSample <= 0) return null;

  return {
    home: recentForm.home,
    away: recentForm.away,
    sampleSize: pairedSample,
    confidence: clamp(pairedSample / 12, 0, 1),
  };
}

function blendLambdasWithForm(match, marketHomeLambda, marketAwayLambda) {
  const trainingCandidate = recentFormCandidate(
    match.formSnapshot,
    marketHomeLambda,
    marketAwayLambda,
    formConfidence(match.formSnapshot),
    "training-history"
  );
  const fiveHundredForm = fiveHundredRecentFormSnapshot(match);
  const fiveHundredCandidate = recentFormCandidate(
    fiveHundredForm,
    marketHomeLambda,
    marketAwayLambda,
    fiveHundredForm?.confidence || 0,
    "500-recent-form"
  );
  const candidates = [trainingCandidate, fiveHundredCandidate].filter(Boolean);

  if (!candidates.length) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      formWeight: 0,
      formHomeLambda: null,
      formAwayLambda: null,
    };
  }

  const confidenceTotal = candidates.reduce((sum, item) => sum + item.confidence, 0) || 1;
  const formHomeLambda = clamp(
    candidates.reduce((sum, item) => sum + item.homeLambda * item.confidence, 0) / confidenceTotal,
    0.25,
    3.6
  );
  const formAwayLambda = clamp(
    candidates.reduce((sum, item) => sum + item.awayLambda * item.confidence, 0) / confidenceTotal,
    0.25,
    3.6
  );
  const profile = matchVolatilityProfile(match);
  const maxWeight = profile.isInternational ? 0.34 : 0.42;
  const strongestConfidence = Math.max(...candidates.map((item) => item.confidence));
  const formWeight = clamp(strongestConfidence * maxWeight, 0, maxWeight);

  return {
    homeLambda: clamp(marketHomeLambda * (1 - formWeight) + formHomeLambda * formWeight, 0.25, 3.4),
    awayLambda: clamp(marketAwayLambda * (1 - formWeight) + formAwayLambda * formWeight, 0.25, 3.4),
    formWeight: Number(formWeight.toFixed(3)),
    formHomeLambda: Number(formHomeLambda.toFixed(2)),
    formAwayLambda: Number(formAwayLambda.toFixed(2)),
    formSource: candidates.map((item) => item.source).join("+"),
  };
}

function blendLambdasWithLeaguePrior(match, marketHomeLambda, marketAwayLambda) {
  const prior = match.leaguePrior;
  const matches = Number(prior?.matches || 0);
  if (!prior || matches < 120) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      leagueWeight: 0,
      leagueHomeLambda: null,
      leagueAwayLambda: null,
      leaguePriorKey: null,
    };
  }

  const priorHome = Number(prior.homeGoalsAvg);
  const priorAway = Number(prior.awayGoalsAvg);
  if (!Number.isFinite(priorHome) || !Number.isFinite(priorAway)) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      leagueWeight: 0,
      leagueHomeLambda: null,
      leagueAwayLambda: null,
      leaguePriorKey: null,
    };
  }

  const sourceWeight = prior.source === "historical-global-prior" ? 0.08 : 0.16;
  const sampleWeight = clamp(Math.log10(matches) / 4, 0.08, sourceWeight);
  return {
    homeLambda: clamp(marketHomeLambda * (1 - sampleWeight) + priorHome * sampleWeight, 0.25, 3.4),
    awayLambda: clamp(marketAwayLambda * (1 - sampleWeight) + priorAway * sampleWeight, 0.25, 3.4),
    leagueWeight: Number(sampleWeight.toFixed(3)),
    leagueHomeLambda: Number(priorHome.toFixed(2)),
    leagueAwayLambda: Number(priorAway.toFixed(2)),
    leaguePriorKey: prior.key || prior.source || "historical-prior",
  };
}

function independentBaseLambdas(match, probabilities) {
  const rand = seeded(`${match.sourceMatchId}-${match.homeTeam}-${match.awayTeam}-independent-lambda`);
  const profile = matchVolatilityProfile(match);
  const strengthEdge = clamp(Number(probabilities.home || 0) - Number(probabilities.away || 0), -0.62, 0.62);
  const drawPressure = clamp(Number(probabilities.draw || 0), 0.16, 0.34);
  const baseTotal = profile.isInternational ? 2.34 : 2.52;
  const totalLambda = clamp(
    baseTotal
      + Math.abs(strengthEdge) * 0.46
      + (0.26 - drawPressure) * 0.38
      + (rand() - 0.5) * 0.16,
    1.62,
    3.28
  );
  const homeShare = clamp(
    0.5 + strengthEdge * 0.58 + (profile.isInternational ? 0.008 : 0.035) + (rand() - 0.5) * 0.035,
    0.22,
    0.78
  );

  return {
    homeLambda: clamp(totalLambda * homeShare, 0.28, 3.2),
    awayLambda: clamp(totalLambda * (1 - homeShare), 0.28, 3.2),
    totalLambda: Number(totalLambda.toFixed(2)),
    homeShare: Number(homeShare.toFixed(3)),
  };
}

function blendOutcomeProbabilities(match, market, poisson, eloSnapshot, formSnapshot) {
  const teamStrength = syntheticModelOnlyProbabilities(match);
  const elo = normalizeOutcomeProbabilities(eloSnapshot?.probabilities);
  const eloSample = (eloSnapshot?.homeMatches || 0) + (eloSnapshot?.awayMatches || 0);
  const formSample = Number(formSnapshot?.sampleSize || 0);
  const worldCupPrior = worldCupPriorOutcomeProbabilities(match);
  const formReady = formSample >= 8;
  let weights = elo && eloSample >= 6 && formReady
    ? { market: 0, teamStrength: 0.22, elo: 0.34, poisson: 0.44 }
    : elo && eloSample >= 6
      ? { market: 0, teamStrength: 0.32, elo: 0.38, poisson: 0.3 }
      : formReady
        ? { market: 0, teamStrength: 0.46, elo: 0, poisson: 0.54 }
        : { market: 0, teamStrength: 0.58, elo: 0, poisson: 0.42 };
  const worldCupPriorWeight = worldCupPrior
    ? 0.18
    : 0;
  if (worldCupPriorWeight > 0) {
    weights = {
      market: Number((weights.market * (1 - worldCupPriorWeight)).toFixed(3)),
      teamStrength: Number((weights.teamStrength * (1 - worldCupPriorWeight)).toFixed(3)),
      elo: Number((weights.elo * (1 - worldCupPriorWeight)).toFixed(3)),
      poisson: Number((weights.poisson * (1 - worldCupPriorWeight)).toFixed(3)),
      worldCupPrior: worldCupPriorWeight,
    };
  }
  const blended = {
    home: market.home * weights.market + teamStrength.home * weights.teamStrength + (elo?.home || 0) * weights.elo + poisson.home * weights.poisson + (worldCupPrior?.home || 0) * (weights.worldCupPrior || 0),
    draw: market.draw * weights.market + teamStrength.draw * weights.teamStrength + (elo?.draw || 0) * weights.elo + poisson.draw * weights.poisson + (worldCupPrior?.draw || 0) * (weights.worldCupPrior || 0),
    away: market.away * weights.market + teamStrength.away * weights.teamStrength + (elo?.away || 0) * weights.elo + poisson.away * weights.poisson + (worldCupPrior?.away || 0) * (weights.worldCupPrior || 0),
  };
  const total = blended.home + blended.draw + blended.away || 1;
  return {
    probabilities: {
      home: blended.home / total,
      draw: blended.draw / total,
      away: blended.away / total,
    },
    weights,
    teamStrength,
  };
}

function outcomeLeader(probabilities) {
  return [
    { code: "1", probability: probabilities.home },
    { code: "X", probability: probabilities.draw },
    { code: "2", probability: probabilities.away },
  ].sort((a, b) => b.probability - a.probability)[0];
}

function outcomeKeyForCode(code) {
  if (code === "1") return "home";
  if (code === "X") return "draw";
  if (code === "2") return "away";
  return null;
}

function preserveOutcomeLeader(probabilities, code, minGap = 0.006) {
  const key = outcomeKeyForCode(code);
  const normalized = normalizeOutcomeProbabilities(probabilities);
  if (!key) return normalized;

  const otherKeys = ["home", "draw", "away"].filter((item) => item !== key);
  const maxOther = Math.max(...otherKeys.map((item) => Number(normalized[item] || 0)));
  if (Number(normalized[key] || 0) >= maxOther + minGap) return normalized;

  const target = clamp(maxOther + minGap, 0.08, 0.82);
  const otherTotal = otherKeys.reduce((sum, item) => sum + Number(normalized[item] || 0), 0) || 1;
  const remaining = Math.max(0.02, 1 - target);
  return normalizeOutcomeProbabilities({
    ...normalized,
    [key]: target,
    [otherKeys[0]]: remaining * (Number(normalized[otherKeys[0]] || 0) / otherTotal),
    [otherKeys[1]]: remaining * (Number(normalized[otherKeys[1]] || 0) / otherTotal),
  });
}

function redistributeOutcomePenalty(probabilities, code, penalty) {
  const adjusted = { ...probabilities };
  const safePenalty = clamp(penalty, 0, Math.max(0, adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"] - 0.05));
  if (safePenalty <= 0) return adjusted;

  if (code === "1") {
    adjusted.home -= safePenalty;
    adjusted.draw += safePenalty * 0.55;
    adjusted.away += safePenalty * 0.45;
  } else if (code === "2") {
    adjusted.away -= safePenalty;
    adjusted.draw += safePenalty * 0.55;
    adjusted.home += safePenalty * 0.45;
  } else {
    adjusted.draw -= safePenalty;
    adjusted.home += safePenalty * 0.5;
    adjusted.away += safePenalty * 0.5;
  }

  return normalizeOutcomeProbabilities(adjusted);
}

function calibrateOutcomeProbabilities(match, probabilities, marketProbabilities) {
  let adjusted = normalizeOutcomeProbabilities(probabilities);
  const reasons = [];
  const adjustments = [];
  const profile = matchVolatilityProfile(match);
  const profileKey = predictionProfileKey(match);
  const health = match.predictionHealth;
  const marketLeader = outcomeLeader(marketProbabilities);
  const modelLeader = outcomeLeader(adjusted);
  const preCalibrationLeader = modelLeader;
  const homeFavoriteBucket = health?.homeFavorite;
  const oneXTwoBucket = health?.byMarket?.["1X2"];
  const modelTipBucket = health?.oneXTwo?.byTip?.[modelLeader.code];
  const profileBucket = health?.oneXTwo?.byProfile?.[profileKey];
  const marketLeaderOdds = Number(match.odds?.[`odds${marketLeader.code}`]);
  const marketLeaderOddsBucket = predictionOddsBucket(marketLeaderOdds);
  const oddsBucket = health?.oneXTwo?.byOddsBucket?.[marketLeaderOddsBucket];
  const lowSpSideBucket = health?.oneXTwo?.lowSpSide;
  const profileMarketBucket = health?.byMarketProfile?.[`1X2:${profileKey}`];

  const applyPenalty = (code, penalty, reason) => {
    const before = adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"];
    adjusted = redistributeOutcomePenalty(adjusted, code, penalty);
    const after = adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"];
    if (after < before) {
      reasons.push(reason);
      adjustments.push({
        code,
        reason,
        penalty: Number((before - after).toFixed(3)),
      });
    }
  };

  if (isCoolingBucket(homeFavoriteBucket) && marketLeader.code === "1") {
    const missPressure = homeFavoriteBucket.hitRate === null ? 0.06 : clamp((0.45 - homeFavoriteBucket.hitRate) * 0.3, 0.025, 0.08);
    applyPenalty("1", missPressure, "home-favorite-hit-rate-cooldown");
  }

  if (isCoolingBucket(modelTipBucket) && modelLeader.code !== "X") {
    const missPressure = modelTipBucket.hitRate === null ? 0.035 : clamp((0.44 - modelTipBucket.hitRate) * 0.2, 0.018, 0.05);
    applyPenalty(modelLeader.code, missPressure, `tip-${modelLeader.code}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(profileBucket) && modelLeader.code !== "X") {
    const missPressure = profileBucket.hitRate === null ? 0.025 : clamp((0.44 - profileBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(modelLeader.code, missPressure, `${profileKey}-1x2-hit-rate-cooldown`);
  }

  if (isCoolingBucket(oddsBucket) && marketLeader.code !== "X") {
    const missPressure = oddsBucket.hitRate === null ? 0.025 : clamp((0.44 - oddsBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(marketLeader.code, missPressure, `${marketLeaderOddsBucket}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(lowSpSideBucket) && marketLeader.code !== "X" && marketLeaderOdds <= 1.7) {
    const missPressure = lowSpSideBucket.hitRate === null ? 0.025 : clamp((0.44 - lowSpSideBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(marketLeader.code, missPressure, "low-sp-side-hit-rate-cooldown");
  }

  if (isCoolingBucket(oneXTwoBucket) && modelLeader.code !== "X") {
    const missPressure = oneXTwoBucket.hitRate === null ? 0.035 : clamp((0.45 - oneXTwoBucket.hitRate) * 0.22, 0.02, 0.055);
    applyPenalty(modelLeader.code, missPressure, "one-x-two-hit-rate-cooldown");
  }

  if (isCoolingBucket(profileMarketBucket) && marketLeader.code !== "X") {
    const missPressure = profileMarketBucket.hitRate === null ? 0.03 : clamp((0.45 - profileMarketBucket.hitRate) * 0.18, 0.02, 0.055);
    applyPenalty(marketLeader.code, missPressure, `${profileKey}-short-form-brake`);
  }

  if (profile.isInternational && marketLeader.code !== "X" && marketLeaderOdds <= 1.7) {
    applyPenalty(marketLeader.code, 0.05, "international-low-sp-shrink");
  }

  if (profile.isJapan && marketLeader.code !== "X" && marketLeaderOdds <= 2.05) {
    applyPenalty(marketLeader.code, 0.07, "jleague-favorite-shrink");
  }

  const postCalibrationLeader = outcomeLeader(adjusted);
  if (preCalibrationLeader?.code && postCalibrationLeader?.code && preCalibrationLeader.code !== postCalibrationLeader.code) {
    adjusted = preserveOutcomeLeader(adjusted, preCalibrationLeader.code);
    reasons.push("calibration-leader-preserved");
    adjustments.push({
      code: preCalibrationLeader.code,
      reason: "calibration-leader-preserved",
      penalty: 0,
    });
  }

  return {
    probabilities: normalizeOutcomeProbabilities(adjusted),
    applied: adjustments.length > 0,
    reasons,
    adjustments,
  };
}

function calibrateGoalProbabilities(match, over25Probability, bttsProbability) {
  const profile = matchVolatilityProfile(match);
  const goalsBucket = match.predictionHealth?.byMarket?.GOALS;
  const profileKey = predictionProfileKey(match);
  const profileBucket = match.predictionHealth?.goals?.byProfile?.[profileKey];
  const directionKey = over25Probability >= 0.5 ? "O2.5" : "U2.5";
  const directionBucket = match.predictionHealth?.goals?.byTip?.[directionKey];
  let over25 = over25Probability;
  let btts = bttsProbability;
  const reasons = [];
  let shrinkFactor = 1;

  if (isCoolingBucket(goalsBucket)) {
    shrinkFactor *= 0.55;
    reasons.push("goals-hit-rate-cooldown");
  }

  if (isCoolingBucket(directionBucket)) {
    shrinkFactor *= 0.76;
    reasons.push(`${directionKey}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(profileBucket)) {
    shrinkFactor *= 0.8;
    reasons.push(`${profileKey}-goals-hit-rate-cooldown`);
  }

  if (profile.isInternational) {
    shrinkFactor *= 0.82;
    reasons.push("international-goal-volatility");
  }

  if (shrinkFactor < 1) {
    over25 = 0.5 + (over25 - 0.5) * shrinkFactor;
    btts = 0.5 + (btts - 0.5) * shrinkFactor;
  }

  return {
    over25: clamp(over25, 0.05, 0.95),
    btts: clamp(btts, 0.05, 0.95),
    meta: {
      applied: shrinkFactor < 1,
      reasons,
      shrinkFactor: Number(shrinkFactor.toFixed(3)),
      before: {
        over25: pct1(over25Probability),
        btts: pct1(bttsProbability),
      },
      after: {
        over25: pct1(over25),
        btts: pct1(btts),
      },
    },
  };
}

function asPercentTriplet(probabilities) {
  if (!probabilities) return null;
  return {
    home: pct1(probabilities.home),
    draw: pct1(probabilities.draw),
    away: pct1(probabilities.away),
  };
}

function formulaNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function formulaPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${numeric.toFixed(1).replace(/\.0$/, "")}%`;
}

function formulaWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formulaOutcomeExpression(side, components, resultPercent) {
  const terms = components
    .filter((component) => Number(component.weight) > 0 && component.probabilities)
    .map((component) => `${formulaWeight(component.weight)}*${formulaPercent(component.probabilities?.[side])}`);
  return `${terms.length ? terms.join(" + ") : "0"} = ${formulaPercent(resultPercent)}`;
}

function buildProbabilityCalculationTrace(match, context) {
  const weights = context.weights || {};
  const teamStrength = asPercentTriplet(context.teamStrength);
  const market = asPercentTriplet(context.market);
  const elo = asPercentTriplet(context.elo);
  const poisson = asPercentTriplet(context.poisson);
  const worldCupPrior = asPercentTriplet(context.worldCupPrior);
  const raw = asPercentTriplet(context.raw);
  const final = asPercentTriplet(context.final);
  const officialOddsAvailable = Boolean(sanitizeOdds(match.odds) || sanitizeOdds(match.handicapOdds));
  const componentRows = [
    {
      key: "teamStrength",
      label: { zh: "球队强度/长期样本", en: "Team strength / long sample" },
      weight: formulaNumber(weights.teamStrength || 0, 3),
      probabilities: teamStrength,
      role: "model",
    },
    {
      key: "elo",
      label: { zh: "Elo 强弱差", en: "Elo strength gap" },
      weight: formulaNumber(weights.elo || 0, 3),
      probabilities: elo,
      role: "model",
    },
    {
      key: "poisson",
      label: { zh: "Poisson 比分分布", en: "Poisson score distribution" },
      weight: formulaNumber(weights.poisson || 0, 3),
      probabilities: poisson,
      role: "model",
    },
    {
      key: "worldCupPrior",
      label: { zh: "世界杯先验", en: "World Cup prior" },
      weight: formulaNumber(weights.worldCupPrior || 0, 3),
      probabilities: worldCupPrior,
      role: "model",
    },
    {
      key: "market",
      label: { zh: "官方 SP 去水", en: "Official SP de-vig" },
      weight: formulaNumber(weights.market || 0, 3),
      probabilities: market,
      role: officialOddsAvailable ? "validation-only" : "unavailable",
    },
  ].filter((component) => component.probabilities || component.key === "market");

  const lambdaBlend = context.lambdaBlend || {};
  const calibration = context.outcomeCalibration || {};
  const calibrationAdjustments = Array.isArray(calibration.adjustments)
    ? calibration.adjustments.map((adjustment) => ({
      code: adjustment.code,
      reason: adjustment.reason,
      penalty: formulaNumber(adjustment.penalty, 3),
    }))
    : [];

  return {
    version: "formula-trace-v2",
    policy: {
      zh: "公式先算独立足球概率，官方 SP 只做市场校验和风险提示，权重固定为 0。",
      en: "The formula first computes independent football probabilities. Official SP is validation and risk context only, with weight fixed at 0.",
    },
    outcome: {
      formula: {
        zh: "P_raw(o)=w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o)；P_final(o)=calibrate(normalize(P_raw(o)))。",
        en: "P_raw(o)=w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o); P_final(o)=calibrate(normalize(P_raw(o))).",
      },
      weights: {
        market: formulaNumber(weights.market || 0, 3),
        teamStrength: formulaNumber(weights.teamStrength || 0, 3),
        elo: formulaNumber(weights.elo || 0, 3),
        poisson: formulaNumber(weights.poisson || 0, 3),
        worldCupPrior: formulaNumber(weights.worldCupPrior || 0, 3),
      },
      components: componentRows,
      raw,
      final,
      expressions: raw ? {
        home: formulaOutcomeExpression("home", componentRows, raw.home),
        draw: formulaOutcomeExpression("draw", componentRows, raw.draw),
        away: formulaOutcomeExpression("away", componentRows, raw.away),
      } : null,
      calibration: {
        applied: Boolean(calibration.applied),
        reasons: calibration.reasons || [],
        adjustments: calibrationAdjustments,
        before: asPercentTriplet(context.raw),
        after: final,
      },
    },
    expectedGoals: {
      formula: {
        zh: "lambda0 来自独立强度差和战平压力；lambda_league=(1-wL)*lambda0+wL*leagueAvg；lambda_final=(1-wF)*lambda_league+wF*formLambda。",
        en: "lambda0 comes from independent strength edge and draw pressure; lambda_league=(1-wL)*lambda0+wL*leagueAvg; lambda_final=(1-wF)*lambda_league+wF*formLambda.",
      },
      values: {
        independentHome: formulaNumber(lambdaBlend.independentHomeLambda ?? lambdaBlend.marketHomeLambda, 2),
        independentAway: formulaNumber(lambdaBlend.independentAwayLambda ?? lambdaBlend.marketAwayLambda, 2),
        independentTotal: formulaNumber(lambdaBlend.independentTotalLambda, 2),
        independentHomeShare: formulaNumber(lambdaBlend.independentHomeShare, 3),
        leagueHome: formulaNumber(lambdaBlend.leagueHomeLambda, 2),
        leagueAway: formulaNumber(lambdaBlend.leagueAwayLambda, 2),
        leagueWeight: formulaNumber(lambdaBlend.leagueWeight || 0, 3),
        formHome: formulaNumber(lambdaBlend.formHomeLambda, 2),
        formAway: formulaNumber(lambdaBlend.formAwayLambda, 2),
        formWeight: formulaNumber(lambdaBlend.formWeight || 0, 3),
        finalHome: formulaNumber(context.homeLambda, 2),
        finalAway: formulaNumber(context.awayLambda, 2),
      },
    },
    poisson: {
      formula: {
        zh: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away)，其中 Pois(k;lambda)=e^-lambda*lambda^k/k!。",
        en: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away), where Pois(k;lambda)=e^-lambda*lambda^k/k!.",
      },
      lambdas: {
        home: formulaNumber(context.homeLambda, 2),
        away: formulaNumber(context.awayLambda, 2),
      },
      topScores: context.scoreDistribution || [],
    },
    goals: {
      formula: {
        zh: "P(大2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away)；P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away)。",
        en: "P(Over2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away); P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away).",
      },
      values: {
        over25: pct1(context.over25Probability),
        under25: pct1(1 - context.over25Probability),
        bttsYes: pct1(context.bttsProbability),
        bttsNo: pct1(1 - context.bttsProbability),
      },
    },
    marketUse: {
      formula: "marketWeight=0",
      zh: "SP 不进入最终概率加权，只用于比较模型方向与市场是否偏离，并生成风险/价值提示。",
      en: "SP is not weighted into final probabilities; it only compares model direction against the market for risk/value notes.",
    },
  };
}

function buildCalculationTraceFromPublishedModel(match, model) {
  if (!model || typeof model !== "object") return null;

  const weights = model.ensembleWeights || {};
  const oneXTwo = model.oneXTwo || {};
  const componentRows = [
    {
      key: "teamStrength",
      label: { zh: "球队强度/长期样本", en: "Team strength / long sample" },
      weight: formulaNumber(weights.teamStrength || 0, 3),
      probabilities: oneXTwo.teamStrength || null,
      role: "model",
    },
    {
      key: "elo",
      label: { zh: "Elo 强弱差", en: "Elo strength gap" },
      weight: formulaNumber(weights.elo || 0, 3),
      probabilities: oneXTwo.elo || null,
      role: "model",
    },
    {
      key: "poisson",
      label: { zh: "Poisson 比分分布", en: "Poisson score distribution" },
      weight: formulaNumber(weights.poisson || 0, 3),
      probabilities: oneXTwo.poisson || null,
      role: "model",
    },
    {
      key: "worldCupPrior",
      label: { zh: "世界杯先验", en: "World Cup prior" },
      weight: formulaNumber(weights.worldCupPrior || 0, 3),
      probabilities: oneXTwo.worldCupPrior || null,
      role: "model",
    },
    {
      key: "market",
      label: { zh: "官方 SP 去水", en: "Official SP de-vig" },
      weight: formulaNumber(weights.market || 0, 3),
      probabilities: oneXTwo.market || null,
      role: oneXTwo.market ? "validation-only" : "unavailable",
    },
  ].filter((component) => component.probabilities || component.key === "market");

  const final = oneXTwo.final || null;
  const lambdaBlend = model.lambdaBlend || {};
  const finalHomeLambda = Number.isFinite(Number(lambdaBlend.finalHomeLambda))
    ? Number(lambdaBlend.finalHomeLambda)
    : Number.isFinite(Number(match?.stats?.xG?.home))
      ? Number(match.stats.xG.home)
      : null;
  const finalAwayLambda = Number.isFinite(Number(lambdaBlend.finalAwayLambda))
    ? Number(lambdaBlend.finalAwayLambda)
    : Number.isFinite(Number(match?.stats?.xG?.away))
      ? Number(match.stats.xG.away)
      : null;
  const calibration = model.calibrationAdjustment?.oneXTwo || {};

  const expressionResult = calibration.before || final;

  return {
    version: "formula-trace-v2",
    policy: {
      zh: "公式先算独立足球概率，官方 SP 只做市场校验和风险提示，权重固定为 0。",
      en: "The formula first computes independent football probabilities. Official SP is validation and risk context only, with weight fixed at 0.",
    },
    outcome: {
      formula: {
        zh: "P_raw(o)=w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o)；P_final(o)=calibrate(normalize(P_raw(o)))。",
        en: "P_raw(o)=w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o); P_final(o)=calibrate(normalize(P_raw(o))).",
      },
      weights: {
        market: formulaNumber(weights.market || 0, 3),
        teamStrength: formulaNumber(weights.teamStrength || 0, 3),
        elo: formulaNumber(weights.elo || 0, 3),
        poisson: formulaNumber(weights.poisson || 0, 3),
        worldCupPrior: formulaNumber(weights.worldCupPrior || 0, 3),
      },
      components: componentRows,
      raw: calibration.before || final,
      final,
      expressions: expressionResult ? {
        home: formulaOutcomeExpression("home", componentRows, expressionResult.home),
        draw: formulaOutcomeExpression("draw", componentRows, expressionResult.draw),
        away: formulaOutcomeExpression("away", componentRows, expressionResult.away),
      } : null,
      calibration: {
        applied: Boolean(calibration.applied),
        reasons: calibration.reasons || [],
        adjustments: (calibration.adjustments || []).map((adjustment) => ({
          code: adjustment.code,
          reason: adjustment.reason,
          penalty: formulaNumber(adjustment.penalty, 3),
        })),
        before: calibration.before || final,
        after: calibration.after || final,
      },
    },
    expectedGoals: {
      formula: {
        zh: "lambda0 来自独立强度差和战平压力；lambda_league=(1-wL)*lambda0+wL*leagueAvg；lambda_final=(1-wF)*lambda_league+wF*formLambda。",
        en: "lambda0 comes from independent strength edge and draw pressure; lambda_league=(1-wL)*lambda0+wL*leagueAvg; lambda_final=(1-wF)*lambda_league+wF*formLambda.",
      },
      values: {
        independentHome: formulaNumber(lambdaBlend.independentHomeLambda ?? lambdaBlend.marketHomeLambda, 2),
        independentAway: formulaNumber(lambdaBlend.independentAwayLambda ?? lambdaBlend.marketAwayLambda, 2),
        independentTotal: formulaNumber(lambdaBlend.independentTotalLambda, 2),
        independentHomeShare: formulaNumber(lambdaBlend.independentHomeShare, 3),
        leagueHome: formulaNumber(lambdaBlend.leagueHomeLambda, 2),
        leagueAway: formulaNumber(lambdaBlend.leagueAwayLambda, 2),
        leagueWeight: formulaNumber(lambdaBlend.leagueWeight || 0, 3),
        formHome: formulaNumber(lambdaBlend.formHomeLambda, 2),
        formAway: formulaNumber(lambdaBlend.formAwayLambda, 2),
        formWeight: formulaNumber(lambdaBlend.formWeight || 0, 3),
        finalHome: formulaNumber(finalHomeLambda, 2),
        finalAway: formulaNumber(finalAwayLambda, 2),
      },
    },
    poisson: {
      formula: {
        zh: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away)，其中 Pois(k;lambda)=e^-lambda*lambda^k/k!。",
        en: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away), where Pois(k;lambda)=e^-lambda*lambda^k/k!.",
      },
      lambdas: {
        home: formulaNumber(finalHomeLambda, 2),
        away: formulaNumber(finalAwayLambda, 2),
      },
      topScores: model.scoreDistribution || [],
    },
    goals: {
      formula: {
        zh: "P(大2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away)；P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away)。",
        en: "P(Over2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away); P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away).",
      },
      values: {
        over25: formulaNumber(model.goalLines?.over25, 1),
        under25: formulaNumber(model.goalLines?.under25, 1),
        bttsYes: formulaNumber(model.bothTeamsToScore?.yes, 1),
        bttsNo: formulaNumber(model.bothTeamsToScore?.no, 1),
      },
    },
    marketUse: {
      formula: "marketWeight=0",
      zh: "SP 不进入最终概率加权，只用于比较模型方向与市场是否偏离，并生成风险/价值提示。",
      en: "SP is not weighted into final probabilities; it only compares model direction against the market for risk/value notes.",
    },
  };
}

function compactWorldCupPriorForModel(prior) {
  if (!prior) return null;
  const compactSide = (side) => side ? {
    key: side.key,
    nameZh: side.nameZh,
    nameEn: side.nameEn,
    group: side.group,
    fifaRank: side.fifaRank,
    elo: side.elo,
    squadValueM: side.squadValueM,
    avgAge: side.avgAge,
    corePlayer: side.corePlayer,
    qualityTier: side.qualityTier,
    modelStrengthNormalized: side.modelStrengthNormalized,
    recent10: side.recent10,
    groupOutlook: side.groupOutlook,
  } : null;

  return {
    source: prior.source,
    version: prior.version,
    signature: prior.signature,
    policy: prior.policy,
    rawPolicy: prior.rawPolicy,
    strengthDiff: prior.strengthDiff,
    fixture: prior.fixture,
    home: compactSide(prior.home),
    away: compactSide(prior.away),
  };
}

function buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration) {
  const poisson1x2 = poissonOutcomeProbabilities(homeLambda, awayLambda);
  const blended = blendOutcomeProbabilities(match, probabilities, poisson1x2, match.eloSnapshot, match.formSnapshot);
  const outcomeCalibration = calibrateOutcomeProbabilities(match, blended.probabilities, probabilities);
  const final1x2 = outcomeCalibration.probabilities;
  const handicapPoisson = handicapOutcomeProbabilities(homeLambda, awayLambda, match.handicapLine);
  const calibration = profileCalibration(match);
  const worldCupPrior = worldCupPriorOutcomeProbabilities(match);
  const scoreDistribution = topScoreProbabilities(homeLambda, awayLambda, 6, {
    over25Probability,
    bttsProbability,
  });
  const calculationTrace = buildProbabilityCalculationTrace(match, {
    weights: blended.weights,
    teamStrength: blended.teamStrength,
    market: probabilities,
    elo: match.eloSnapshot?.probabilities,
    poisson: poisson1x2,
    worldCupPrior,
    raw: blended.probabilities,
    final: final1x2,
    outcomeCalibration,
    lambdaBlend,
    homeLambda,
    awayLambda,
    over25Probability,
    bttsProbability,
    scoreDistribution,
  });
  return {
    version: "independent-elo-form-poisson-v7",
    generatedAt: new Date().toISOString(),
    basis: PREDICTION_MODEL_BASIS,
    ensembleWeights: blended.weights,
    calculationTrace,
    dynamicCalibration: {
      version: match.modelCalibration?.version || "none",
      profileKey: calibration.profileKey,
      gate: calibration.gate || null,
      metrics: calibration.metrics || null,
      strategy: calibration.strategy ? {
        version: calibration.strategy.version,
        generatedAt: calibration.strategy.generatedAt,
        onlineEffect: calibration.strategy.activation?.onlineEffect || "unknown",
        activeGates: calibration.strategy.activeGates || null,
      } : null,
    },
    calibrationAdjustment: {
      oneXTwo: {
        applied: outcomeCalibration.applied,
        reasons: outcomeCalibration.reasons,
        adjustments: outcomeCalibration.adjustments,
        before: asPercentTriplet(blended.probabilities),
        after: asPercentTriplet(final1x2),
      },
      goals: goalCalibration?.meta || null,
    },
    lambdaBlend: lambdaBlend ? {
      marketHomeLambda: Number(lambdaBlend.marketHomeLambda.toFixed(2)),
      marketAwayLambda: Number(lambdaBlend.marketAwayLambda.toFixed(2)),
      independentHomeLambda: lambdaBlend.independentHomeLambda,
      independentAwayLambda: lambdaBlend.independentAwayLambda,
      independentTotalLambda: lambdaBlend.independentTotalLambda,
      independentHomeShare: lambdaBlend.independentHomeShare,
      leagueHomeLambda: lambdaBlend.leagueHomeLambda,
      leagueAwayLambda: lambdaBlend.leagueAwayLambda,
      leagueWeight: lambdaBlend.leagueWeight || 0,
      leaguePriorKey: lambdaBlend.leaguePriorKey || null,
      formHomeLambda: lambdaBlend.formHomeLambda,
      formAwayLambda: lambdaBlend.formAwayLambda,
      formWeight: lambdaBlend.formWeight,
    } : undefined,
    oneXTwo: {
      market: asPercentTriplet(probabilities),
      teamStrength: asPercentTriplet(blended.teamStrength),
      elo: asPercentTriplet(match.eloSnapshot?.probabilities),
      poisson: asPercentTriplet(poisson1x2),
      worldCupPrior: asPercentTriplet(worldCupPrior),
      final: asPercentTriplet(final1x2),
    },
    worldCupPrior: compactWorldCupPriorForModel(match.worldCupPrior || match.externalSignals?.worldCupPrior),
    elo: match.eloSnapshot ? {
      homeRating: Math.round(match.eloSnapshot.homeRating),
      awayRating: Math.round(match.eloSnapshot.awayRating),
      diff: Math.round(match.eloSnapshot.diff),
      homeMatches: match.eloSnapshot.homeMatches,
      awayMatches: match.eloSnapshot.awayMatches,
      historicalSource: match.eloSnapshot.historicalSource || null,
      lastUpdatedAt: match.eloSnapshot.lastUpdatedAt,
    } : null,
    form: match.formSnapshot ? {
      version: match.formSnapshot.version,
      lookbackMatches: match.formSnapshot.lookbackMatches,
      sampleSize: match.formSnapshot.sampleSize,
      home: match.formSnapshot.home,
      away: match.formSnapshot.away,
      h2h: match.formSnapshot.h2h,
      historicalSource: match.formSnapshot.historicalSource || null,
    } : null,
    leaguePrior: match.leaguePrior ? {
      key: match.leaguePrior.key,
      source: match.leaguePrior.source,
      matches: match.leaguePrior.matches,
      homeGoalsAvg: match.leaguePrior.homeGoalsAvg,
      awayGoalsAvg: match.leaguePrior.awayGoalsAvg,
      totalGoalsAvg: match.leaguePrior.totalGoalsAvg,
      over25Rate: match.leaguePrior.over25Rate,
      bttsRate: match.leaguePrior.bttsRate,
      drawRate: match.leaguePrior.drawRate,
      lastMatchDate: match.leaguePrior.lastMatchDate,
      trainingVersion: match.leaguePrior.trainingVersion,
      trainingSignature: match.leaguePrior.trainingSignature,
    } : null,
    modelHealth: match.predictionHealth ? {
      version: match.predictionHealth.version,
      total: match.predictionHealth.total,
      byMarket: match.predictionHealth.byMarket,
      byTip: match.predictionHealth.byTip,
      byProfile: match.predictionHealth.byProfile,
      byMarketProfile: match.predictionHealth.byMarketProfile,
      byOddsBucket: match.predictionHealth.byOddsBucket,
      oneXTwo: match.predictionHealth.oneXTwo,
      goals: match.predictionHealth.goals,
      homeFavorite: match.predictionHealth.homeFavorite,
      awayFavorite: match.predictionHealth.awayFavorite,
      lowSpSide: match.predictionHealth.lowSpSide,
      under25: match.predictionHealth.under25,
    } : null,
    scoreDistribution,
    goalLines: {
      over25: pct1(over25Probability),
      under25: pct1(1 - over25Probability),
    },
    bothTeamsToScore: {
      yes: pct1(bttsProbability),
      no: pct1(1 - bttsProbability),
    },
    handicap: match.handicapLine ? {
      line: match.handicapLine,
      market: asPercentTriplet(hhadProbabilities),
      poisson: asPercentTriplet(handicapPoisson),
    } : null,
    calibration: {
      status: "baseline",
      zh: "当前为轻量级赛前校准：已加入历史 form 修正和近期命中率冷却；后续仍需要用时间滚动回测做 Brier / log loss / reliability 正式校准。",
      en: "This is a lightweight pre-match calibration with rolling-form correction and recent hit-rate cooldown; Brier, log loss, and reliability calibration are still needed.",
    },
  };
}

function eloExpectedScore(homeRating, awayRating, homeAdvantage = 62) {
  return 1 / (1 + 10 ** (-((homeRating + homeAdvantage) - awayRating) / 400));
}

function eloOutcomeProbabilities(homeRating, awayRating, homeAdvantage = 62) {
  const strengthHome = eloExpectedScore(homeRating, awayRating, homeAdvantage);
  const draw = clamp(0.305 - Math.abs(strengthHome - 0.5) * 0.26, 0.17, 0.31);
  const home = clamp((1 - draw) * strengthHome, 0.05, 0.88);
  const away = clamp(1 - draw - home, 0.05, 0.88);
  return normalizeOutcomeProbabilities({ home, draw, away });
}

const TEAM_KEY_ALIASES = Object.freeze({
  "阿根廷": "argentina",
  "冰岛": "iceland",
  "葡萄牙": "portugal",
  "尼日利亚": "nigeria",
  "英格兰": "england",
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
  "哈萨克": "kazakhstan",
});

const CURRENT_TEAM_KEY_ALIASES = Object.freeze({
  "\u963f\u6839\u5ef7": "argentina",
  "\u51b0\u5c9b": "iceland",
  "\u8461\u8404\u7259": "portugal",
  "\u5c3c\u65e5\u5229\u4e9a": "nigeria",
  "\u82f1\u683c\u5170": "england",
  "\u54e5\u65af\u8fbe\u9ece\u52a0": "costa rica",
  "\u58a8\u897f\u54e5": "mexico",
  "\u5357\u975e": "south africa",
  "\u97e9\u56fd": "south korea",
  "\u6377\u514b": "czech republic",
  "\u52a0\u62ff\u5927": "canada",
  "\u6ce2\u9ed1": "bosnia and herzegovina",
  "\u7f8e\u56fd": "united states",
  "\u5df4\u62c9\u572d": "paraguay",
  "\u5361\u5854\u5c14": "qatar",
  "\u745e\u58eb": "switzerland",
  "\u5df4\u897f": "brazil",
  "\u6469\u6d1b\u54e5": "morocco",
  "\u6d77\u5730": "haiti",
  "\u82cf\u683c\u5170": "scotland",
  "\u6fb3\u5927\u5229\u4e9a": "australia",
  "\u571f\u8033\u5176": "turkey",
  "\u5fb7\u56fd": "germany",
  "\u5e93\u62c9\u7d22": "curacao",
  "\u8377\u5170": "netherlands",
  "\u65e5\u672c": "japan",
  "\u745e\u5178": "sweden",
  "\u7a81\u5c3c\u65af": "tunisia",
  "\u897f\u73ed\u7259": "spain",
  "\u4f5b\u5f97\u89d2": "cape verde",
  "\u6bd4\u5229\u65f6": "belgium",
  "\u57c3\u53ca": "egypt",
  "\u6c99\u7279\u963f\u62c9\u4f2f": "saudi arabia",
  "\u4e4c\u62c9\u572d": "uruguay",
  "\u4f0a\u6717": "iran",
  "\u65b0\u897f\u5170": "new zealand",
  "\u4e39\u9ea6": "denmark",
  "\u585e\u5185\u52a0\u5c14": "senegal",
  "\u54e5\u4f26\u6bd4\u4e9a": "colombia",
  "\u514b\u7f57\u5730\u4e9a": "croatia",
  "\u6cd5\u56fd": "france",
  "\u52a0\u7eb3": "ghana",
  "\u632a\u5a01": "norway",
  "\u5580\u9ea6\u9686": "cameroon",
  "\u610f\u5927\u5229": "italy",
  "\u6d2a\u90fd\u62c9\u65af": "honduras",
  "\u667a\u5229": "chile",
  "\u7259\u4e70\u52a0": "jamaica",
  "\u6ce2\u5170": "poland",
  "\u963f\u5c14\u53ca\u5229\u4e9a": "algeria",
  "\u4e2d\u56fd": "china",
  "\u6cf0\u56fd": "thailand",
  "\u5308\u7259\u5229": "hungary",
  "\u54c8\u8428\u514b": "kazakhstan",
});

function normalizedTeamKey(teamName) {
  return normText(teamName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function teamKey(teamName) {
  const key = normalizedTeamKey(teamName);
  return CURRENT_TEAM_KEY_ALIASES[key] || TEAM_KEY_ALIASES[key] || key;
}

function pairKey(homeTeam, awayTeam) {
  return [teamKey(homeTeam), teamKey(awayTeam)].sort().join("__");
}

function matchSideTeamName(match, side) {
  return side === "home"
    ? (match.homeTeamName || match.homeTeam || match.homeName || "")
    : (match.awayTeamName || match.awayTeam || match.awayName || "");
}

const KIMI_WORLD_CUP_KEY_ALIASES = Object.freeze({
  "united-states": "usa",
  "czech-republic": "czechia",
  "bosnia-and-herzegovina": "bosnia",
  "south-africa": "south-africa",
  "south-korea": "south-korea",
  "saudi-arabia": "saudi-arabia",
  "new-zealand": "new-zealand",
  "cape-verde": "cape-verde",
  "ivory-coast": "ivory-coast",
  "dr-congo": "dr-congo",
  "democratic-republic-of-congo": "dr-congo",
  "congo-dr": "dr-congo",
});

function kimiWorldCupKey(value) {
  const key = teamKey(value).replace(/\s+/g, "-");
  return KIMI_WORLD_CUP_KEY_ALIASES[key] || key;
}

function worldCupTeamMap(dataset) {
  const map = new Map();
  for (const team of dataset?.teams || []) {
    [
      team.key,
      team.nameZh,
      team.nameEn,
    ].filter(Boolean).forEach((value) => {
      map.set(kimiWorldCupKey(value), team);
    });
  }
  return map;
}

function compactWorldCupTeamPrior(team) {
  if (!team) return null;
  return {
    key: team.key,
    nameZh: team.nameZh,
    nameEn: team.nameEn,
    group: team.group,
    fifaRank: team.fifaRank,
    elo: team.elo,
    squadValueM: team.squadValueM,
    avgAge: team.avgAge,
    corePlayer: team.corePlayer,
    qualityTier: team.qualityTier,
    recent10: team.recent10,
    groupOutlook: team.groupOutlook,
    modelStrengthNormalized: team.modelStrengthNormalized,
  };
}

function fixturePriorForMatch(dataset, match) {
  const homeKey = kimiWorldCupKey(matchSideTeamName(match, "home"));
  const awayKey = kimiWorldCupKey(matchSideTeamName(match, "away"));
  return (dataset?.fixtures || []).find((fixture) => {
    const fixtureHome = kimiWorldCupKey(fixture.homeKey || fixture.homeNameZh);
    const fixtureAway = kimiWorldCupKey(fixture.awayKey || fixture.awayNameZh);
    return fixtureHome === homeKey && fixtureAway === awayKey;
  }) || null;
}

function isWorldCupMatchCandidate(match) {
  const text = [
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.countryName,
    match.countryNameEn,
    match.externalSignals?.leagueName,
  ].filter(Boolean).join(" ");
  return /世界杯|FIFA\s*World\s*Cup|World\s*Cup/i.test(text);
}

function worldCupPriorForMatch(dataset, match) {
  if (!dataset?.teams || !isWorldCupMatchCandidate(match)) return null;
  const teams = worldCupTeamMap(dataset);
  const home = teams.get(kimiWorldCupKey(matchSideTeamName(match, "home")));
  const away = teams.get(kimiWorldCupKey(matchSideTeamName(match, "away")));
  if (!home || !away) return null;

  const fixture = fixturePriorForMatch(dataset, match);
  const homeStrength = Number(home.modelStrengthNormalized);
  const awayStrength = Number(away.modelStrengthNormalized);
  return {
    source: "kimi-worldcup-dataset",
    version: dataset.version,
    signature: dataset.signature,
    policy: dataset.quality?.curated?.policy || "pre-match-prior",
    rawPolicy: dataset.quality?.raw?.policy || "audit-only",
    strengthDiff: Number.isFinite(homeStrength) && Number.isFinite(awayStrength)
      ? Number((homeStrength - awayStrength).toFixed(4))
      : null,
    fixture: fixture ? {
      matchNo: fixture.matchNo,
      kickoffLabel: fixture.kickoffLabel,
      kickoffTime: fixture.kickoffTime,
      venue: fixture.venue,
      city: fixture.city,
      sourceQuality: fixture.sourceQuality,
      note: fixture.note,
    } : null,
    home: compactWorldCupTeamPrior(home),
    away: compactWorldCupTeamPrior(away),
  };
}

function attachWorldCupPrior(match, dataset) {
  const worldCupPrior = worldCupPriorForMatch(dataset, match);
  if (!worldCupPrior) return match;
  return {
    ...match,
    worldCupPrior,
    externalSignals: {
      ...(match.externalSignals || {}),
      worldCupPrior,
    },
  };
}

function loadHistoricalTrainingIndex() {
  const file = path.join(__dirname, "..", "server-data", "training", "historical-training-index.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadWorldCupKimiDataset() {
  const candidates = [
    path.join(__dirname, "..", "server-data", "worldcup", "kimi-worldcup-dataset.json"),
    path.join(__dirname, "..", "public", "data", "worldcup-kimi-dataset.json"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function worldCupDatasetSummary(dataset) {
  if (!dataset) return null;
  return {
    version: dataset.version || "unknown",
    source: dataset.source?.zipFile || "kimi-worldcup-dataset",
    signature: dataset.signature || null,
    teams: Array.isArray(dataset.teams) ? dataset.teams.length : 0,
    fixtures: Array.isArray(dataset.fixtures) ? dataset.fixtures.length : 0,
    policy: dataset.quality?.curated?.policy || "pre-match-prior",
    rawPolicy: dataset.quality?.raw?.policy || null,
  };
}

function trainingSourceSummary(trainingIndex) {
  if (!trainingIndex) return null;
  const source = trainingIndex.source?.name || "historical-training";
  const rows = trainingIndex.sample?.rows || 0;
  const lastMatchDate = trainingIndex.sample?.lastMatchDate || null;
  return {
    version: trainingIndex.version,
    source,
    rows,
    lastMatchDate,
    signature: [trainingIndex.version || "unknown", source, rows, lastMatchDate || "none"].join("|"),
  };
}

function seedTeamHistoryFromTraining(teamHistory, trainingIndex) {
  if (!trainingIndex?.teams) return 0;
  let seeded = 0;
  for (const [key, team] of Object.entries(trainingIndex.teams)) {
    const recent = Array.isArray(team?.recent) ? team.recent : [];
    if (!key || !recent.length) continue;
    teamHistory.set(key, recent.slice(-40));
    seeded += 1;
  }
  return seeded;
}

function seedEloFromTraining(ratings, counts, trainingIndex) {
  if (!trainingIndex?.teams) return 0;
  let seeded = 0;
  for (const [key, team] of Object.entries(trainingIndex.teams)) {
    const rating = Number(team?.latestElo);
    if (!key || !Number.isFinite(rating)) continue;
    ratings.set(key, rating);
    counts.set(key, Number(team?.matches || 0));
    seeded += 1;
  }
  return seeded;
}

function leaguePriorKey(value) {
  return teamKey(value);
}

function leaguePriorForMatch(trainingIndex, match) {
  if (!trainingIndex?.leaguePriors) return null;
  const trainingSource = trainingSourceSummary(trainingIndex);
  const profile = matchVolatilityProfile(match);
  if (profile.isInternational) {
    const prior = trainingIndex.leaguePriors.international;
    return prior && Number(prior.matches || 0) >= 500 ? {
      ...prior,
      key: "international",
      source: "historical-international-prior",
      trainingVersion: trainingIndex.version,
      trainingSignature: trainingSource?.signature || trainingIndex.version || null,
    } : null;
  }

  const candidates = [
    match.countryNameEn,
    match.countryName,
    match.leagueNameEn,
    match.leagueName,
  ].map(leaguePriorKey).filter(Boolean);

  for (const key of candidates) {
    const prior = trainingIndex.leaguePriors.countries?.[key];
    if (prior && Number(prior.matches || 0) >= 120) {
      return {
        ...prior,
        key,
        source: "historical-country-prior",
        trainingVersion: trainingIndex.version,
        trainingSignature: trainingSource?.signature || trainingIndex.version || null,
      };
    }
  }

  const global = trainingIndex.leaguePriors.global;
  if (global && Number(global.matches || 0) >= 1000) {
    return {
      ...global,
      key: "global",
      source: "historical-global-prior",
      trainingVersion: trainingIndex.version,
      trainingSignature: trainingSource?.signature || trainingIndex.version || null,
    };
  }
  return null;
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / 86400000);
}

function countSince(rows, kickoffTime, days) {
  const kickoff = Date.parse(kickoffTime);
  if (!Number.isFinite(kickoff)) return 0;
  const from = kickoff - days * 86400000;
  return rows.filter((row) => {
    const time = Date.parse(row.kickoffTime);
    return Number.isFinite(time) && time < kickoff && time >= from;
  }).length;
}

function summarizeTeamForm(rows, key, kickoffTime) {
  const recent = rows.slice(-FORM_LOOKBACK_MATCHES);
  const last = rows[rows.length - 1];
  const empty = {
    sampleSize: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsPerMatch: null,
    goalsForAvg: null,
    goalsAgainstAvg: null,
    goalDiffAvg: null,
    over25Rate: null,
    bttsRate: null,
    cleanSheetRate: null,
    failedScoreRate: null,
    lastMatchAt: last?.kickoffTime || null,
    restDays: last?.kickoffTime ? daysBetween(last.kickoffTime, kickoffTime) : null,
    matchesLast14: countSince(rows, kickoffTime, 14),
    matchesLast30: countSince(rows, kickoffTime, 30),
  };
  if (!recent.length) return empty;

  const totals = recent.reduce((acc, row) => {
    const isHome = row.homeKey === key;
    const goalsFor = isHome ? row.scoreHome : row.scoreAway;
    const goalsAgainst = isHome ? row.scoreAway : row.scoreHome;
    const totalGoals = row.scoreHome + row.scoreAway;
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
    acc.wins += points === 3 ? 1 : 0;
    acc.draws += points === 1 ? 1 : 0;
    acc.losses += points === 0 ? 1 : 0;
    acc.points += points;
    acc.goalsFor += goalsFor;
    acc.goalsAgainst += goalsAgainst;
    acc.over25 += totalGoals >= 3 ? 1 : 0;
    acc.btts += row.scoreHome > 0 && row.scoreAway > 0 ? 1 : 0;
    acc.cleanSheet += goalsAgainst === 0 ? 1 : 0;
    acc.failedScore += goalsFor === 0 ? 1 : 0;
    return acc;
  }, {
    wins: 0,
    draws: 0,
    losses: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    over25: 0,
    btts: 0,
    cleanSheet: 0,
    failedScore: 0,
  });

  const sampleSize = recent.length;
  return {
    sampleSize,
    wins: totals.wins,
    draws: totals.draws,
    losses: totals.losses,
    pointsPerMatch: Number((totals.points / sampleSize).toFixed(2)),
    goalsForAvg: Number((totals.goalsFor / sampleSize).toFixed(2)),
    goalsAgainstAvg: Number((totals.goalsAgainst / sampleSize).toFixed(2)),
    goalDiffAvg: Number(((totals.goalsFor - totals.goalsAgainst) / sampleSize).toFixed(2)),
    over25Rate: Number((totals.over25 / sampleSize).toFixed(3)),
    bttsRate: Number((totals.btts / sampleSize).toFixed(3)),
    cleanSheetRate: Number((totals.cleanSheet / sampleSize).toFixed(3)),
    failedScoreRate: Number((totals.failedScore / sampleSize).toFixed(3)),
    lastMatchAt: last?.kickoffTime || null,
    restDays: last?.kickoffTime ? daysBetween(last.kickoffTime, kickoffTime) : null,
    matchesLast14: countSince(rows, kickoffTime, 14),
    matchesLast30: countSince(rows, kickoffTime, 30),
  };
}

function summarizeHeadToHead(rows) {
  const recent = rows.slice(-8);
  if (!recent.length) {
    return {
      sampleSize: 0,
      over25Rate: null,
      bttsRate: null,
      drawRate: null,
      lastMeetingAt: null,
    };
  }

  const totals = recent.reduce((acc, row) => {
    const totalGoals = row.scoreHome + row.scoreAway;
    acc.over25 += totalGoals >= 3 ? 1 : 0;
    acc.btts += row.scoreHome > 0 && row.scoreAway > 0 ? 1 : 0;
    acc.draws += row.scoreHome === row.scoreAway ? 1 : 0;
    return acc;
  }, { over25: 0, btts: 0, draws: 0 });

  return {
    sampleSize: recent.length,
    over25Rate: Number((totals.over25 / recent.length).toFixed(3)),
    bttsRate: Number((totals.btts / recent.length).toFixed(3)),
    drawRate: Number((totals.draws / recent.length).toFixed(3)),
    lastMeetingAt: recent[recent.length - 1]?.kickoffTime || null,
  };
}

function buildFormSnapshots(matches, historicalTraining = null) {
  const teamHistory = new Map();
  const h2hHistory = new Map();
  const snapshots = new Map();
  const seededTeams = seedTeamHistoryFromTraining(teamHistory, historicalTraining);
  const historicalSource = trainingSourceSummary(historicalTraining);
  const readRows = (map, key) => map.get(key) || [];
  const appendRow = (map, key, row) => {
    const rows = map.get(key) || [];
    rows.push(row);
    if (rows.length > 40) rows.splice(0, rows.length - 40);
    map.set(key, rows);
  };

  const sorted = [...matches].sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
  for (const match of sorted) {
    const sourceMatchId = normText(match.sourceMatchId);
    const homeKey = teamKey(match.homeTeam);
    const awayKey = teamKey(match.awayTeam);
    if (!sourceMatchId || !homeKey || !awayKey) continue;

    const homeForm = summarizeTeamForm(readRows(teamHistory, homeKey), homeKey, match.kickoffTime);
    const awayForm = summarizeTeamForm(readRows(teamHistory, awayKey), awayKey, match.kickoffTime);
    const h2h = summarizeHeadToHead(readRows(h2hHistory, pairKey(match.homeTeam, match.awayTeam)));
    const sampleSize = homeForm.sampleSize + awayForm.sampleSize;
    snapshots.set(sourceMatchId, {
      version: historicalSource ? "rolling-form-v2-historical-seeded" : "rolling-form-v1",
      lookbackMatches: FORM_LOOKBACK_MATCHES,
      sampleSize,
      historicalSource: historicalSource ? { ...historicalSource, seededTeams } : null,
      home: homeForm,
      away: awayForm,
      h2h,
    });

    if (match.status !== "FINISHED" || !Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;

    const row = {
      sourceMatchId,
      homeKey,
      awayKey,
      kickoffTime: match.kickoffTime,
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
    };
    appendRow(teamHistory, homeKey, row);
    appendRow(teamHistory, awayKey, row);
    appendRow(h2hHistory, pairKey(match.homeTeam, match.awayTeam), row);
  }

  return snapshots;
}

function buildEloSnapshots(matches, historicalTraining = null) {
  const baseRating = 1500;
  const kFactor = 22;
  const ratings = new Map();
  const counts = new Map();
  const snapshots = new Map();
  const seededTeams = seedEloFromTraining(ratings, counts, historicalTraining);
  const historicalSource = trainingSourceSummary(historicalTraining);

  const ratingFor = (key) => ratings.get(key) ?? baseRating;
  const countFor = (key) => counts.get(key) ?? 0;
  const setRating = (key, value) => ratings.set(key, value);
  const addCount = (key) => counts.set(key, countFor(key) + 1);

  const sorted = [...matches].sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
  for (const match of sorted) {
    const sourceMatchId = normText(match.sourceMatchId);
    const homeKey = teamKey(match.homeTeam);
    const awayKey = teamKey(match.awayTeam);
    if (!sourceMatchId || !homeKey || !awayKey) continue;

    const homeRating = ratingFor(homeKey);
    const awayRating = ratingFor(awayKey);
    const probabilities = eloOutcomeProbabilities(homeRating, awayRating);
    snapshots.set(sourceMatchId, {
      version: historicalSource ? "elo-v2-historical-seeded" : "elo-v1-window",
      homeRating,
      awayRating,
      diff: homeRating - awayRating + 62,
      probabilities,
      homeMatches: countFor(homeKey),
      awayMatches: countFor(awayKey),
      historicalSource: historicalSource ? { ...historicalSource, seededTeams } : null,
      lastUpdatedAt: match.kickoffTime,
    });

    if (match.status !== "FINISHED" || !Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;

    const actualHome = match.scoreHome > match.scoreAway ? 1 : match.scoreHome === match.scoreAway ? 0.5 : 0;
    const expectedHome = eloExpectedScore(homeRating, awayRating);
    const goalDiff = Math.abs(match.scoreHome - match.scoreAway);
    const marginMultiplier = goalDiff <= 1 ? 1 : Math.min(1.75, Math.log(goalDiff + 1));
    const delta = kFactor * marginMultiplier * (actualHome - expectedHome);
    setRating(homeKey, homeRating + delta);
    setRating(awayKey, awayRating - delta);
    addCount(homeKey);
    addCount(awayKey);
  }

  return snapshots;
}

function resultStatus(match, expected, marketType = "") {
  if (expected === "WATCH") return "PENDING";
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
  if ((marketType === "HHAD" || marketType === "BEST_HHAD") && ["1", "X", "2"].includes(expected)) {
    const handicap = parseHandicapLine(match.handicapLine);
    if (handicap === null) return "PENDING";
    const adjustedHome = match.scoreHome + handicap;
    const actualHhad = adjustedHome > match.scoreAway ? "1" : adjustedHome < match.scoreAway ? "2" : "X";
    return expected === actualHhad ? "WON" : "LOST";
  }
  if ((marketType === "1X2" || marketType === "BEST" || marketType === "") && ["1", "X", "2"].includes(expected)) {
    return expected === actual1x2 ? "WON" : "LOST";
  }
  if (/^[0-6]$/.test(expected)) return total === Number(expected) ? "WON" : "LOST";
  if (expected === "7+") return total >= 7 ? "WON" : "LOST";
  if (expected === "O2.5") return total > 2.5 ? "WON" : "LOST";
  if (expected === "U2.5") return total < 2.5 ? "WON" : "LOST";
  if (expected === "GG") return match.scoreHome > 0 && match.scoreAway > 0 ? "WON" : "LOST";
  if (expected === "NG") return match.scoreHome === 0 || match.scoreAway === 0 ? "WON" : "LOST";
  return expected === actual1x2 ? "WON" : "LOST";
}

function isReferencePrediction(prediction) {
  return prediction?.recommendationAction === "reference"
    || prediction?.recommendationTier === "reference";
}

function predictionProfileKey(match) {
  const profile = matchVolatilityProfile(match);
  if (profile.isJapan) return "japan";
  if (profile.isInternational) return "international";
  return "other";
}

function predictionOddsBucket(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
}

function buildPredictionHealth(existingMatches) {
  const summarize = (rows, minSettled = 24, minHitRate = 0.38) => {
    const settledRows = rows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
    const won = settledRows.filter((row) => row.resultStatus === "WON").length;
    const lost = settledRows.filter((row) => row.resultStatus === "LOST").length;
    const settled = won + lost;
    const hitRate = settled ? won / settled : null;
    return {
      settled,
      won,
      lost,
      hitRate: hitRate === null ? null : Number(hitRate.toFixed(3)),
      urgentCooldown: settled >= Math.min(3, minSettled) && hitRate !== null && hitRate < Math.min(minHitRate, 0.35),
      hot: settled >= Math.min(3, minSettled) && hitRate !== null && hitRate >= Math.max(minHitRate + 0.16, 0.58),
      cooldown: settled >= minSettled && hitRate < minHitRate,
    };
  };
  const summarizeBy = (items, keyFn, minSettled = 14, minHitRate = 0.36) => {
    const output = {};
    for (const row of items) {
      const key = keyFn(row);
      if (!key) continue;
      if (!output[key]) output[key] = [];
      output[key].push(row);
    }
    return Object.fromEntries(Object.entries(output).map(([key, group]) => [key, summarize(group, minSettled, minHitRate)]));
  };

  const rows = [];
  for (const match of existingMatches || []) {
    for (const prediction of match.predictions || []) {
      if (!prediction || prediction.tipCode === "WATCH") continue;
      if (isReferencePrediction(prediction)) continue;
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const profileKey = predictionProfileKey(match);
      const odds = Number(prediction.odds || 0);
      const marketType = prediction.oddsPoolCode === "HHAD" && prediction.marketType === "1X2"
        ? "HHAD"
        : prediction.marketType;
      rows.push({
        marketType,
        tipCode: prediction.tipCode,
        odds,
        oddsBucket: predictionOddsBucket(odds),
        profileKey,
        isSidePick: prediction.tipCode === "1" || prediction.tipCode === "2",
        isHomePick: prediction.tipCode === "1",
        isAwayPick: prediction.tipCode === "2",
        isLowSpSide: (prediction.tipCode === "1" || prediction.tipCode === "2") && odds > 0 && odds <= 1.7,
        resultStatus: prediction.resultStatus,
      });
    }
  }

  const byMarket = {};
  for (const marketType of ["1X2", "HHAD", "GOALS", "BEST"]) {
    const minSettled = marketType === "BEST" ? 5 : 10;
    const minHitRate = marketType === "BEST" ? 0.5 : 0.4;
    byMarket[marketType] = summarize(rows.filter((row) => row.marketType === marketType), minSettled, minHitRate);
  }

  return {
    version: "settled-prediction-health-v3",
    generatedAt: new Date().toISOString(),
    total: summarize(rows),
    byMarket,
    byTip: summarizeBy(rows, (row) => row.tipCode, 5, 0.42),
    byProfile: summarizeBy(rows, (row) => row.profileKey, 5, 0.42),
    byMarketProfile: summarizeBy(rows, (row) => `${row.marketType}:${row.profileKey}`, 10, 0.4),
    byOddsBucket: summarizeBy(rows.filter((row) => row.isSidePick), (row) => row.oddsBucket, 6, 0.42),
    oneXTwo: {
      byTip: summarizeBy(rows.filter((row) => row.marketType === "1X2"), (row) => row.tipCode, 8, 0.4),
      byProfile: summarizeBy(rows.filter((row) => row.marketType === "1X2"), (row) => row.profileKey, 10, 0.4),
      byOddsBucket: summarizeBy(rows.filter((row) => row.marketType === "1X2" && row.isSidePick), (row) => row.oddsBucket, 5, 0.42),
      lowSpSide: summarize(rows.filter((row) => row.marketType === "1X2" && row.isLowSpSide), 7, 0.42),
    },
    goals: {
      byTip: summarizeBy(rows.filter((row) => row.marketType === "GOALS"), (row) => row.tipCode, 8, 0.4),
      byProfile: summarizeBy(rows.filter((row) => row.marketType === "GOALS"), (row) => row.profileKey, 10, 0.4),
    },
    homeFavorite: summarize(rows.filter((row) => row.tipCode === "1"), 8, 0.42),
    awayFavorite: summarize(rows.filter((row) => row.tipCode === "2"), 8, 0.42),
    lowSpSide: summarize(rows.filter((row) => row.isLowSpSide), 7, 0.42),
    under25: summarize(rows.filter((row) => row.tipCode === "U2.5"), 8, 0.42),
  };
}

function isCoolingBucket(bucket) {
  return Boolean(bucket?.cooldown || bucket?.urgentCooldown);
}

function isHotBucket(bucket, minSettled = 3, minHitRate = 0.58) {
  return Boolean(
    bucket
    && Number(bucket.settled || 0) >= minSettled
    && Number(bucket.hitRate || 0) >= minHitRate
  );
}

function bucketHitRate(bucket) {
  return Number.isFinite(bucket?.hitRate) ? bucket.hitRate : null;
}

function hardCoolingBucket(bucket, minSettled = 5, maxHitRate = 0.42) {
  const settled = Number(bucket?.settled || 0);
  const hitRate = bucketHitRate(bucket);
  return settled >= minSettled && hitRate !== null && hitRate < maxHitRate;
}

function predictionRowsFromMatches(existingMatches) {
  const rows = [];
  for (const match of existingMatches || []) {
    if (match?.status !== "FINISHED") continue;
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;
    const actual = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
    const totalGoals = match.scoreHome + match.scoreAway;
    const finalProbabilities = match.probabilityModel?.oneXTwo?.final;
    const marketProbabilities = match.probabilityModel?.oneXTwo?.market;
    const profileKey = predictionProfileKey(match);

    for (const prediction of match.predictions || []) {
      if (!prediction || prediction.tipCode === "WATCH") continue;
      if (isReferencePrediction(prediction)) continue;
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const isOneXTwo = prediction.marketType === "1X2" || prediction.marketType === "BEST";
      const probability = isOneXTwo && finalProbabilities
        ? prediction.tipCode === "1"
          ? finalProbabilities.home
          : prediction.tipCode === "X"
            ? finalProbabilities.draw
            : prediction.tipCode === "2"
              ? finalProbabilities.away
              : null
        : null;
      rows.push({
        sourceMatchId: normText(match.sourceMatchId || String(match.id || "").replace(/^sporttery_/, "")),
        marketType: prediction.marketType,
        tipCode: prediction.tipCode,
        odds: Number(prediction.odds || 0),
        oddsBucket: predictionOddsBucket(prediction.odds),
        profileKey,
        policyVersion: match.predictionMeta?.policyVersion || "unknown",
        promptVersion: match.predictionMeta?.promptVersion || "unknown",
        resultStatus: prediction.resultStatus,
        kickoffTime: match.kickoffTime,
        actual,
        totalGoals,
        probability,
        finalProbabilities,
        marketProbabilities,
      });
    }
  }
  return rows;
}

function summarizeCalibrationRows(rows) {
  const won = rows.filter((row) => row.resultStatus === "WON").length;
  const lost = rows.filter((row) => row.resultStatus === "LOST").length;
  const settled = won + lost;
  return {
    settled,
    won,
    lost,
    hitRate: settled ? Number((won / settled).toFixed(3)) : null,
  };
}

function summarizeCalibrationBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries()).map(([key, group]) => [key, summarizeCalibrationRows(group)])
  );
}

function brierScore(rows) {
  const scored = rows.filter((row) => row.finalProbabilities && ["1", "X", "2"].includes(row.actual));
  if (!scored.length) return null;
  const total = scored.reduce((sum, row) => {
    const actual = {
      home: row.actual === "1" ? 1 : 0,
      draw: row.actual === "X" ? 1 : 0,
      away: row.actual === "2" ? 1 : 0,
    };
    const probabilities = row.finalProbabilities;
    return sum
      + Math.pow((probabilities.home || 0) / 100 - actual.home, 2)
      + Math.pow((probabilities.draw || 0) / 100 - actual.draw, 2)
      + Math.pow((probabilities.away || 0) / 100 - actual.away, 2);
  }, 0);
  return Number((total / scored.length).toFixed(4));
}

function logLossScore(rows) {
  const scored = rows.filter((row) => row.finalProbabilities && ["1", "X", "2"].includes(row.actual));
  if (!scored.length) return null;
  const total = scored.reduce((sum, row) => {
    const probability = row.actual === "1"
      ? row.finalProbabilities.home
      : row.actual === "X"
        ? row.finalProbabilities.draw
        : row.finalProbabilities.away;
    return sum - Math.log(clamp((probability || 1) / 100, 0.01, 0.99));
  }, 0);
  return Number((total / scored.length).toFixed(4));
}

function calibrationWeightForProfile(summary, profileKey) {
  const profile = summary.byProfile?.[profileKey];
  const marketProfile = summary.byMarketProfile?.[`1X2:${profileKey}`];
  const settled = Number(marketProfile?.settled || profile?.settled || 0);
  const hitRate = Number.isFinite(marketProfile?.hitRate) ? marketProfile.hitRate : profile?.hitRate;

  let market = 0.58;
  let elo = 0.22;
  let poisson = 0.2;
  if (profileKey === "international") {
    market = 0.62;
    elo = 0.2;
    poisson = 0.18;
  } else if (profileKey === "japan") {
    market = 0.6;
    elo = 0.18;
    poisson = 0.22;
  }

  if (settled >= 8 && hitRate !== null && hitRate < 0.38) {
    market += 0.06;
    elo -= 0.02;
    poisson -= 0.04;
  } else if (settled >= 8 && hitRate !== null && hitRate >= 0.55) {
    market -= 0.04;
    poisson += 0.04;
  }

  const total = market + elo + poisson;
  return {
    market: Number((market / total).toFixed(3)),
    elo: Number((elo / total).toFixed(3)),
    poisson: Number((poisson / total).toFixed(3)),
    sample: settled,
    hitRate: hitRate ?? null,
  };
}

function calibrationGateForProfile(summary, profileKey) {
  const profile = summary.byMarketProfile?.[`1X2:${profileKey}`] || summary.byProfile?.[profileKey];
  const goalsProfile = summary.byMarketProfile?.[`GOALS:${profileKey}`];
  const settled = Number(profile?.settled || 0);
  const hitRate = Number.isFinite(profile?.hitRate) ? profile.hitRate : null;
  const goalsHitRate = Number.isFinite(goalsProfile?.hitRate) ? goalsProfile.hitRate : null;
  const cold = settled >= 5 && hitRate !== null && hitRate < 0.4;
  const veryCold = settled >= 5 && hitRate !== null && hitRate < 0.32;
  const hot = settled >= 5 && hitRate !== null && hitRate >= 0.56;

  return {
    minProbabilityBoost: veryCold ? 0.07 : cold ? 0.045 : hot ? -0.015 : 0,
    minModelGapBoost: veryCold ? 0.04 : cold ? 0.025 : hot ? -0.01 : 0,
    minHandicapSupportBoost: profileKey === "international" ? (cold ? 0.06 : 0.035) : profileKey === "japan" ? (cold ? 0.05 : 0.025) : cold ? 0.025 : 0,
    trustPenalty: veryCold ? 12 : cold ? 7 : 0,
    maxRiskTags: veryCold ? 1 : cold ? 2 : 3,
    goalsMinBoost: goalsHitRate !== null && goalsProfile?.settled >= 5 && goalsHitRate < 0.4 ? 0.04 : 0,
    reason: veryCold ? "very-cold-profile" : cold ? "cold-profile" : hot ? "hot-profile" : "neutral-profile",
  };
}

function buildModelCalibration(existingMatches) {
  const rows = predictionRowsFromMatches(existingMatches);
  const oneXTwoRows = rows.filter((row) => row.marketType === "1X2");
  const bestRows = rows.filter((row) => row.marketType === "BEST");
  const goalsRows = rows.filter((row) => row.marketType === "GOALS");
  const summary = {
    total: summarizeCalibrationRows(rows),
    byMarket: summarizeCalibrationBy(rows, (row) => row.marketType),
    byProfile: summarizeCalibrationBy(rows, (row) => row.profileKey),
    byMarketProfile: summarizeCalibrationBy(rows, (row) => `${row.marketType}:${row.profileKey}`),
    byOddsBucket: summarizeCalibrationBy(rows.filter((row) => row.marketType === "1X2" && ["1", "2"].includes(row.tipCode)), (row) => row.oddsBucket),
    byTip: summarizeCalibrationBy(rows, (row) => `${row.marketType}:${row.tipCode}`),
  };
  const profiles = ["international", "japan", "other"];
  const weightsByProfile = Object.fromEntries(profiles.map((profileKey) => [profileKey, calibrationWeightForProfile(summary, profileKey)]));
  const gateByProfile = Object.fromEntries(profiles.map((profileKey) => [profileKey, calibrationGateForProfile(summary, profileKey)]));
  const oneXTwoBrier = brierScore(oneXTwoRows);
  const oneXTwoLogLoss = logLossScore(oneXTwoRows);
  const recommendationPool = [...oneXTwoRows, ...bestRows].filter((row) => row.tipCode !== "WATCH");

  return {
    version: "rolling-calibration-v1",
    generatedAt: new Date().toISOString(),
    source: "settled-pre-match-predictions",
    sample: {
      rows: rows.length,
      oneXTwo: oneXTwoRows.length,
      goals: goalsRows.length,
      best: bestRows.length,
      recommendationPool: recommendationPool.length,
    },
    metrics: {
      oneXTwoBrier,
      oneXTwoLogLoss,
      oneXTwoHitRate: summary.byMarket["1X2"]?.hitRate ?? null,
      goalsHitRate: summary.byMarket.GOALS?.hitRate ?? null,
      bestHitRate: summary.byMarket.BEST?.hitRate ?? null,
    },
    weightsByProfile,
    gateByProfile,
    summary,
    note: {
      zh: "该文件由已结算赛前预测自动生成，只用于动态调权和推荐闸门，不会回写赛后方向。",
      en: "Generated from settled pre-match predictions. It only adjusts weights and gates; it never rewrites post-match picks.",
    },
  };
}

function strategyRuleIsActive(rule) {
  return Boolean(rule && rule.onlineAction === "tighten" && rule.adjustments);
}

function roundGate(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(3));
}

function mergeCalibrationGate(baseGate, strategyGate) {
  if (!strategyRuleIsActive(strategyGate)) return baseGate;
  const base = baseGate || {};
  const rawAdjustment = strategyGate.adjustments || {};
  const adjustment = {
    minProbabilityBoost: clamp(Number(rawAdjustment.minProbabilityBoost || 0), 0, 0.04),
    minModelGapBoost: clamp(Number(rawAdjustment.minModelGapBoost || 0), 0, 0.025),
    minHandicapSupportBoost: clamp(Number(rawAdjustment.minHandicapSupportBoost || 0), 0, 0.025),
    trustPenalty: clamp(Number(rawAdjustment.trustPenalty || 0), 0, 6),
    maxRiskTagsDelta: clamp(Number(rawAdjustment.maxRiskTagsDelta || 0), -1, 0),
    goalsMinBoost: clamp(Number(rawAdjustment.goalsMinBoost || 0), 0, 0.03),
  };
  const baseMaxRiskTags = Number.isFinite(base.maxRiskTags) ? Number(base.maxRiskTags) : 3;
  const maxRiskTagsDelta = Number(adjustment.maxRiskTagsDelta || 0);
  return {
    ...base,
    minProbabilityBoost: roundGate(clamp(Number(base.minProbabilityBoost || 0) + Number(adjustment.minProbabilityBoost || 0), -0.02, 0.11)),
    minModelGapBoost: roundGate(clamp(Number(base.minModelGapBoost || 0) + Number(adjustment.minModelGapBoost || 0), -0.02, 0.07)),
    minHandicapSupportBoost: roundGate(clamp(Number(base.minHandicapSupportBoost || 0) + Number(adjustment.minHandicapSupportBoost || 0), -0.02, 0.09)),
    trustPenalty: Math.round(clamp(Number(base.trustPenalty || 0) + Number(adjustment.trustPenalty || 0), 0, 18)),
    maxRiskTags: Math.round(clamp(baseMaxRiskTags + maxRiskTagsDelta, 1, 5)),
    goalsMinBoost: roundGate(clamp(Number(base.goalsMinBoost || 0) + Number(adjustment.goalsMinBoost || 0), -0.02, 0.07)),
    reason: [base.reason, `strategy:${strategyGate.key || "profile"}`].filter(Boolean).join("+"),
  };
}

function applyModelStrategyToCalibration(calibration, strategy) {
  if (!calibration || !strategy || strategy.activation?.onlineEffect === "shadow") return calibration;
  const next = {
    ...calibration,
    strategy: {
      version: strategy.version,
      generatedAt: strategy.generatedAt,
      activation: strategy.activation,
      sample: strategy.sample,
      activeGates: strategy.activeGates,
      gateByMarket: strategy.gateByMarket || {},
      gateByOddsBucket: strategy.gateByOddsBucket || {},
      gateByTip: strategy.gateByTip || {},
      gateByProfile: strategy.gateByProfile || {},
    },
  };
  next.gateByProfile = { ...(calibration.gateByProfile || {}) };
  for (const [profileKey, rule] of Object.entries(strategy.gateByProfile || {})) {
    next.gateByProfile[profileKey] = mergeCalibrationGate(next.gateByProfile[profileKey], rule);
  }
  return next;
}

function combineStrategyRules(rules) {
  const activeRules = rules.filter(strategyRuleIsActive);
  const combined = {
    minProbabilityBoost: 0,
    minModelGapBoost: 0,
    minHandicapSupportBoost: 0,
    trustPenalty: 0,
    maxRiskTagsDelta: 0,
    goalsMinBoost: 0,
    reasons: [],
  };

  for (const rule of activeRules) {
    const adjustment = rule.adjustments || {};
    combined.minProbabilityBoost += Math.max(0, Number(adjustment.minProbabilityBoost || 0));
    combined.minModelGapBoost += Math.max(0, Number(adjustment.minModelGapBoost || 0));
    combined.minHandicapSupportBoost += Math.max(0, Number(adjustment.minHandicapSupportBoost || 0));
    combined.trustPenalty += Math.max(0, Number(adjustment.trustPenalty || 0));
    combined.maxRiskTagsDelta += Math.min(0, Number(adjustment.maxRiskTagsDelta || 0));
    combined.goalsMinBoost += Math.max(0, Number(adjustment.goalsMinBoost || 0));
    combined.reasons.push(`strategy:${rule.key || "rule"}`);
  }

  return {
    minProbabilityBoost: roundGate(clamp(combined.minProbabilityBoost, 0, 0.08)),
    minModelGapBoost: roundGate(clamp(combined.minModelGapBoost, 0, 0.06)),
    minHandicapSupportBoost: roundGate(clamp(combined.minHandicapSupportBoost, 0, 0.07)),
    trustPenalty: Math.round(clamp(combined.trustPenalty, 0, 12)),
    maxRiskTagsDelta: Math.round(clamp(combined.maxRiskTagsDelta, -2, 0)),
    goalsMinBoost: roundGate(clamp(combined.goalsMinBoost, 0, 0.06)),
    reasons: combined.reasons,
  };
}

function strategyGateForPrediction(match, marketType, tipCode, oddsBucket) {
  const strategy = match.modelCalibration?.strategy;
  if (!strategy || strategy.activation?.onlineEffect === "shadow") return combineStrategyRules([]);
  return combineStrategyRules([
    strategy.gateByMarket?.[marketType],
    strategy.gateByOddsBucket?.[oddsBucket],
    strategy.gateByTip?.[`${marketType}:${tipCode}`],
  ]);
}

function profileCalibration(match) {
  const profileKey = predictionProfileKey(match);
  const calibration = match.modelCalibration;
  return {
    profileKey,
    weights: calibration?.weightsByProfile?.[profileKey],
    gate: calibration?.gateByProfile?.[profileKey],
    metrics: calibration?.metrics,
    strategy: calibration?.strategy || null,
  };
}

function leagueMeta(leagueName) {
  const name = normText(leagueName, "足球赛事");
  const countryNameZh = {
    England: "英格兰",
    Spain: "西班牙",
    Germany: "德国",
    Italy: "意大利",
    France: "法国",
    Europe: "欧洲",
    China: "中国",
    Japan: "日本",
    Korea: "韩国",
    Sweden: "瑞典",
    Finland: "芬兰",
    Norway: "挪威",
    Portugal: "葡萄牙",
    "South America": "南美",
    World: "国际",
  };
  const rules = [
    [/英超|Premier League/i, ["eng", "England", "🇬🇧", "Premier League", "英超"]],
    [/西甲|La Liga/i, ["esp", "Spain", "🇪🇸", "La Liga", "西甲"]],
    [/德甲|Bundesliga/i, ["deu", "Germany", "🇩🇪", "Bundesliga", "德甲"]],
    [/意甲|Serie A/i, ["ita", "Italy", "🇮🇹", "Serie A", "意甲"]],
    [/法甲|Ligue 1/i, ["fra", "France", "🇫🇷", "Ligue 1", "法甲"]],
    [/欧冠|Champions/i, ["eur", "Europe", "🇪🇺", "UEFA Champions League", "欧冠"]],
    [/欧联|Europa/i, ["eur", "Europe", "🇪🇺", "UEFA Europa League", "欧联"]],
    [/欧协联|Conference/i, ["eur", "Europe", "🇪🇺", "UEFA Conference League", "欧协联"]],
    [/解放者杯|Libertadores/i, ["sam", "South America", "🌎", "Copa Libertadores", "解放者杯"]],
    [/中超|Chinese/i, ["chn", "China", "🇨🇳", "Chinese Super League", "中超"]],
    [/日职|J1|日本/i, ["jpn", "Japan", "🇯🇵", "Japan", "日职"]],
    [/韩|K League/i, ["kor", "Korea", "🇰🇷", "K League", "韩职"]],
    [/瑞超|Allsvenskan/i, ["swe", "Sweden", "🇸🇪", "Swedish Allsvenskan", "瑞超"]],
    [/芬超|Veikkausliiga/i, ["fin", "Finland", "🇫🇮", "Finnish Veikkausliiga", "芬超"]],
    [/挪超|Eliteserien/i, ["nor", "Norway", "🇳🇴", "Norwegian Eliteserien", "挪超"]],
    [/葡超|Primeira|Liga Portugal/i, ["por", "Portugal", "🇵🇹", "Primeira Liga", "葡超"]],
    [/国际|友谊|世预|世界杯/i, ["world", "World", "🌐", "International", "国际赛"]],
  ];
  for (const [pattern, meta] of rules) {
    if (pattern.test(name)) {
      return {
        countryId: meta[0],
        countryNameEn: meta[1],
        countryName: countryNameZh[meta[1]] || meta[1],
        countryFlag: meta[2],
        leagueNameEn: meta[3],
        leagueShortName: meta[4],
      };
    }
  }
  return {
    countryId: "oth",
    countryName: "其他",
    countryNameEn: "Other",
    countryFlag: "🏳️",
    leagueNameEn: name,
    leagueShortName: name.slice(0, 4),
  };
}

function httpGetJson(url, tab = "concern") {
  const proxy = sportteryOutboundProxy();
  if (proxy) return httpGetJsonViaCurl(url, tab, proxy);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        ...SPORTTERY_REQUEST_HEADERS,
        Referer: `https://m.sporttery.cn/mjc/zqhh/?tab=${encodeURIComponent(tab || "all")}`,
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = body ? ` ${body.slice(0, 160).replace(/\s+/g, " ")}` : "";
          reject(new Error(`${url} -> HTTP ${res.statusCode}${preview}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (payload?.success === false) {
            reject(new Error(`sporttery_api_${payload.errorCode || "unknown"}`));
            return;
          }
          resolve(payload);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(20000, () => {
      req.destroy(new Error(`timeout: ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpGetJsonViaCurl(url, tab, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      "-fsSL",
      "--connect-timeout",
      String(Math.max(3, Number(process.env.SPORTTERY_CURL_CONNECT_TIMEOUT_SECONDS || 8))),
      "--max-time",
      String(Math.max(8, Number(process.env.SPORTTERY_CURL_MAX_TIME_SECONDS || 25))),
      "--proxy",
      proxy,
      ...curlHeaderArgs(tab),
      url,
    ];

    const child = spawn(process.env.CURL_BIN || "curl", args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });

    let body = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      body += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${url} -> curl proxy exited ${code}${stderr ? ` ${stderr.slice(0, 220).replace(/\s+/g, " ")}` : ""}`));
        return;
      }
      try {
        const payload = JSON.parse(body);
        if (payload?.success === false) {
          reject(new Error(`sporttery_api_${payload.errorCode || "unknown"}`));
          return;
        }
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildPageUrl(method, pageNo = null, pageType = null) {
  const params = new URLSearchParams();
  params.set("method", method);
  params.set("pageSize", String(PAGE_SIZE));
  if (pageNo !== null && pageNo !== undefined) params.set("pageNo", String(pageNo));
  if (pageType !== null && pageType !== undefined) params.set("pageType", String(pageType));
  return `${SPORTTERY_BASE}/gateway/uniform/fb/getMatchDataPageListV1.qry?${params.toString()}`;
}

function flatten(payload, sourceMethod, sourceUrl) {
  const rows = [];
  for (const day of payload?.value?.matchInfoList || []) {
    for (const row of day.subMatchList || []) rows.push(mapSportteryRow(row, sourceMethod, sourceUrl));
  }
  return rows;
}

function mapSportteryRow(row, sourceMethod, sourceUrl) {
  const rowScore = scoreFromRow(row);
  const scoreHome = rowScore.home;
  const scoreAway = rowScore.away;
  const homeTeam = normText(row.homeTeamAllName || row.homeTeamAbbName, "主队");
  const awayTeam = normText(row.awayTeamAllName || row.awayTeamAbbName, "客队");
  const leagueName = normText(row.leagueAllName || row.leagueAbbName, "足球赛事");
  const matchId = String(row.matchId || `${row.matchDate}-${homeTeam}-${awayTeam}`);
  const kickoffTime = parseKickoff(row.matchDate, row.matchTime);
  const rawStatus = statusFromSporttery(row.matchStatus, row.sellStatus, row.matchStatusName, kickoffTime);
  const status = normalizeStatusWithScore(rawStatus, kickoffTime, scoreHome, scoreAway);
  const matchNo = normText(row.matchNumStr);
  const matchDate = normText(row.matchDate);
  const businessDate = normText(row.businessDate || row.matchNumDate)
    || inferSportteryBusinessDate(matchNo, matchDate)
    || matchDate;
  const oddsInfo = sportteryOddsInfo(row, sourceUrl, sourceMethod);
  return {
    source: "sporttery",
    sourceMethod,
    sourceUrl,
    sourceMatchId: matchId,
    matchNo,
    businessDate,
    matchDate,
    buyEndTime: normText(row.buyEndTime || row.matchEndTime || row.sellEndTime || row.stopSaleTime || row.endTime),
    homeTeam,
    awayTeam,
    homeRank: normText(row.homeRank),
    awayRank: normText(row.awayRank),
    homeTeamCode: normText(row.homeTeamCode || row.homeTeamAbbEnName),
    awayTeamCode: normText(row.awayTeamCode || row.awayTeamAbbEnName),
    homeTeamLogo: normText(row.homeTeamLogo || row.homeTeamLogoUrl || row.homeLogoUrl || row.homeTeamFlag),
    awayTeamLogo: normText(row.awayTeamLogo || row.awayTeamLogoUrl || row.awayLogoUrl || row.awayTeamFlag),
    leagueName,
    leagueCode: String(row.leagueId || ""),
    kickoffTime,
    status,
    scoreHome,
    scoreAway,
    odds: oddsInfo.had?.odds || null,
    oddsSource: oddsInfo.had?.oddsSource,
    oddsPoolCode: oddsInfo.had?.oddsPoolCode,
    oddsSourceMethod: oddsInfo.had?.oddsSourceMethod,
    oddsUpdatedAt: oddsInfo.had?.oddsUpdatedAt,
    oddsSourceUrl: oddsInfo.had?.oddsSourceUrl,
    handicapOdds: oddsInfo.hhad?.odds || null,
    handicapLine: oddsInfo.hhad?.handicap,
    handicapOddsSource: oddsInfo.hhad?.oddsSource,
    handicapOddsPoolCode: oddsInfo.hhad?.oddsPoolCode,
    handicapOddsSourceMethod: oddsInfo.hhad?.oddsSourceMethod,
    handicapOddsUpdatedAt: oddsInfo.hhad?.oddsUpdatedAt,
    handicapOddsSourceUrl: oddsInfo.hhad?.oddsSourceUrl,
  };
}

async function fetchCurrentMatches() {
  if (process.env.SKIP_SPORTTERY_FETCH === "1") {
    console.log("Sporttery fetch skipped by SKIP_SPORTTERY_FETCH=1; using existing store and external signals.");
    return [];
  }

  const urls = [
    { url: CALCULATOR_URL, method: "calculator" },
    { url: CURRENT_URL, method: "current" },
    ...(process.env.SPORTTERY_SOURCE_URLS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((url) => ({ url, method: "current" })),
    process.env.SPORTTERY_PROXY_URL ? { url: process.env.SPORTTERY_PROXY_URL, method: "proxy" } : null,
  ].filter(Boolean);
  const allMatches = [];
  for (const item of urls) {
    try {
      const payload = await httpGetJson(item.url, "concern");
      const matches = flatten(payload, item.method, item.url);
      console.log(`Sporttery ${item.method} ok: ${matches.length}`);
      if (matches.length) allMatches.push(...matches);
    } catch (error) {
      console.log(`Sporttery ${item.method} failed: ${error.message || error}`);
    }
  }
  return allMatches;
}

async function fetchMethodMatches(method) {
  const firstUrl = buildPageUrl(method);
  const payloads = [{ payload: await httpGetJson(firstUrl, method), url: firstUrl }];
  if (method === "all" || method === "result") {
    for (let page = 2; page <= PAGE_DEPTH; page += 1) {
      try {
        const pageUrl = buildPageUrl(method, page, 0);
        const payload = await httpGetJson(pageUrl, method);
        if (!(payload?.value?.matchInfoList || []).length) break;
        payloads.push({ payload, url: pageUrl });
        const hasMore = payload?.value?.prePage && String(payload.value.prePage) !== "0";
        if (!hasMore) break;
      } catch (error) {
        console.log(`Sporttery ${method} page ${page} failed: ${error.message || error}`);
        break;
      }
    }
  }
  const matches = payloads.flatMap((entry) => flatten(entry.payload, method, entry.url));
  console.log(`Sporttery ${method} ok: ${matches.length}`);
  return matches;
}

function mergeMatch(prev, next) {
  const nextHasScore = Number.isFinite(next.scoreHome) && Number.isFinite(next.scoreAway);
  const prevHasScore = Number.isFinite(prev.scoreHome) && Number.isFinite(prev.scoreAway);
  const oddsRank = (match) => {
    if (!sanitizeOdds(match.odds)) return 0;
    if (match.oddsSourceMethod === "current") return 5;
    if (match.oddsSourceMethod === "calculator") return 4;
    if (match.oddsUpdatedAt) return 3;
    return 1;
  };
  const handicapOddsRank = (match) => {
    if (!sanitizeOdds(match.handicapOdds)) return 0;
    if (match.handicapOddsSourceMethod === "current") return 5;
    if (match.handicapOddsSourceMethod === "calculator") return 4;
    if (match.handicapOddsUpdatedAt) return 3;
    return 1;
  };
  const oddsMatch = oddsRank(next) >= oddsRank(prev) ? next : prev;
  const handicapOddsMatch = handicapOddsRank(next) >= handicapOddsRank(prev) ? next : prev;
  return {
    ...prev,
    ...next,
    odds: oddsMatch.odds || null,
    oddsSource: oddsMatch.oddsSource,
    oddsPoolCode: oddsMatch.oddsPoolCode,
    oddsSourceMethod: oddsMatch.oddsSourceMethod,
    oddsUpdatedAt: oddsMatch.oddsUpdatedAt,
    oddsSourceUrl: oddsMatch.oddsSourceUrl,
    handicapOdds: handicapOddsMatch.handicapOdds || null,
    handicapLine: handicapOddsMatch.handicapLine,
    handicapOddsSource: handicapOddsMatch.handicapOddsSource,
    handicapOddsPoolCode: handicapOddsMatch.handicapOddsPoolCode,
    handicapOddsSourceMethod: handicapOddsMatch.handicapOddsSourceMethod,
    handicapOddsUpdatedAt: handicapOddsMatch.handicapOddsUpdatedAt,
    handicapOddsSourceUrl: handicapOddsMatch.handicapOddsSourceUrl,
    homeTeamCode: next.homeTeamCode || prev.homeTeamCode,
    awayTeamCode: next.awayTeamCode || prev.awayTeamCode,
    homeTeamLogo: next.homeTeamLogo || prev.homeTeamLogo,
    awayTeamLogo: next.awayTeamLogo || prev.awayTeamLogo,
    businessDate: inferSportteryBusinessDate(next.matchNo || prev.matchNo, next.matchDate || prev.matchDate)
      || next.businessDate
      || prev.businessDate,
    buyEndTime: next.buyEndTime || prev.buyEndTime,
    matchDate: next.matchDate || prev.matchDate,
    sourceUrl: next.sourceUrl || prev.sourceUrl,
    scoreHome: nextHasScore ? next.scoreHome : prevHasScore ? prev.scoreHome : next.scoreHome,
    scoreAway: nextHasScore ? next.scoreAway : prevHasScore ? prev.scoreAway : next.scoreAway,
  };
}

function dedupeMatches(matches) {
  const map = new Map();
  for (const match of matches) {
    const key = match.sourceMatchId;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, match);
      continue;
    }
    const nextPriority = STATUS_PRIORITY[match.status] || 0;
    const prevPriority = STATUS_PRIORITY[prev.status] || 0;
    map.set(key, nextPriority >= prevPriority ? mergeMatch(prev, match) : mergeMatch(match, prev));
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime));
}

function pickByCode(picks, code) {
  return picks.find((pick) => pick[0] === code);
}

function hhadSupportForPick(hhadProbabilities, code) {
  if (!hhadProbabilities) return null;
  if (code === "1") return hhadProbabilities.home;
  if (code === "X") return hhadProbabilities.draw;
  if (code === "2") return hhadProbabilities.away;
  return null;
}

function outcomeProbabilityForCode(probabilities, code) {
  if (!probabilities) return null;
  if (code === "1") return Number(probabilities.home);
  if (code === "X") return Number(probabilities.draw);
  if (code === "2") return Number(probabilities.away);
  return null;
}

function pickValueProfile(pick, modelProbabilities, marketProbabilities) {
  const code = pick?.[0];
  const odds = Number(pick?.[2]);
  const modelProbability = outcomeProbabilityForCode(modelProbabilities, code);
  const marketProbability = outcomeProbabilityForCode(marketProbabilities, code);
  const probabilityEdge = Number.isFinite(modelProbability) && Number.isFinite(marketProbability)
    ? modelProbability - marketProbability
    : null;
  const expectedValue = Number.isFinite(modelProbability) && Number.isFinite(odds)
    ? modelProbability * odds - 1
    : null;

  return {
    code,
    odds,
    modelProbability,
    marketProbability,
    probabilityEdge,
    expectedValue,
  };
}

function matchVolatilityProfile(match) {
  const text = [
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.countryName,
    match.countryNameEn,
    match.homeTeam,
    match.awayTeam,
  ].filter(Boolean).join(" ");

  return {
    isInternational: /(\u56fd\u9645|\u53cb\u8c0a|\u4e16\u754c\u676f|\u4e16\u9884|\u56fd\u5bb6|international|friendly|world cup|qualifier|fifa)/i.test(text),
    isJapan: /(\u65e5\u804c|\u65e5\u8054|\u65e5\u672c|j1|j2|japan)/i.test(text),
  };
}

function evaluateOneXTwoGate(context) {
  const {
    match,
    pick,
    probabilities,
    modelProbabilities,
    hhadProbabilities,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth,
    marketType = "1X2",
  } = context;

  const code = pick[0];
  const odds = pick[2];
  const profile = matchVolatilityProfile(match);
  const isSidePick = code === "1" || code === "2";
  const valueProfile = pickValueProfile(pick, modelProbabilities || probabilities, probabilities);
  const pickProbability = Number.isFinite(valueProfile.modelProbability)
    ? valueProfile.modelProbability
    : outcomeProbabilityForCode(probabilities, code);
  const marketPickProbability = Number.isFinite(valueProfile.marketProbability)
    ? valueProfile.marketProbability
    : outcomeProbabilityForCode(probabilities, code);
  const probabilityEdge = Number.isFinite(valueProfile.probabilityEdge) ? valueProfile.probabilityEdge : 0;
  const expectedValue = Number.isFinite(valueProfile.expectedValue) ? valueProfile.expectedValue : null;
  const handicapSupport = hhadSupportForPick(hhadProbabilities, code);
  const profileKey = predictionProfileKey(match);
  const dynamicGate = profileCalibration(match).gate || {};
  const oddsBucket = predictionOddsBucket(odds);
  const strategyGate = strategyGateForPrediction(match, marketType, code, oddsBucket);
  const drawHealth = predictionHealth?.oneXTwo?.byTip?.X;
  const drawHasPositiveSample = isHotBucket(drawHealth, 3, 0.5);
  const directionCooldown = Boolean(
    isCoolingBucket(predictionHealth?.oneXTwo?.byTip?.[code])
    || isCoolingBucket(predictionHealth?.oneXTwo?.byProfile?.[profileKey])
    || isCoolingBucket(predictionHealth?.oneXTwo?.byOddsBucket?.[oddsBucket])
    || (isSidePick && odds <= 1.7 && isCoolingBucket(predictionHealth?.oneXTwo?.lowSpSide))
    || (code === "1" && isCoolingBucket(predictionHealth?.homeFavorite))
    || (code === "2" && isCoolingBucket(predictionHealth?.awayFavorite))
  );
  const profileMarketCooldown = isCoolingBucket(predictionHealth?.byMarketProfile?.[`1X2:${profileKey}`]);
  const oneXTwoCooldown = Boolean(isCoolingBucket(predictionHealth?.byMarket?.["1X2"]) || profileMarketCooldown || directionCooldown);
  const hasSelectionDisagreement = Boolean(analystSelection.isContrarian || analystSelection.hasValueDisagreement);
  const reasons = [];

  if (hasSelectionDisagreement) reasons.push("market-disagreement");
  if (code === "X") reasons.push("draw-is-not-single-pick");
  if (!isSidePick) reasons.push("no-side-pick");
  if (isSidePick && handicapSupport === null) reasons.push("missing-handicap-confirmation");
  if (isSidePick && handicapSupport !== null && handicapSupport < 0.32) reasons.push("weak-handicap-confirmation");
  if (probabilities.draw >= 0.3) reasons.push("draw-pressure");
  if (probabilityGap < 0.1) reasons.push("thin-market-edge");
  if (modelProbabilityGap < 0.07) reasons.push("thin-model-edge");
  if (probabilityEdge < 0.015) reasons.push("no-model-market-edge");
  if (expectedValue !== null && expectedValue < 0.01) reasons.push("negative-or-flat-ev");
  if (riskTags.length > 0) reasons.push("risk-tags");
  if (isSidePick && odds <= 1.25) reasons.push("low-odds-no-value");
  if (profile.isInternational && isSidePick && odds <= 1.35) reasons.push("international-low-odds");
  if (profile.isJapan && isSidePick && odds <= 1.75) reasons.push("jleague-volatile-favorite");
  if (directionCooldown) reasons.push("direction-hit-rate-cooldown");
  if (oneXTwoCooldown) reasons.push("recent-1x2-hit-rate-cooldown");
  if (code === "X" && oneXTwoCooldown && !drawHasPositiveSample) reasons.push("draw-no-positive-sample");
  if (isSidePick && oneXTwoCooldown && odds <= 2.1) reasons.push("side-short-form-brake");
  if (dynamicGate.reason && dynamicGate.reason !== "neutral-profile") reasons.push(dynamicGate.reason);
  if (strategyGate.reasons.length) reasons.push(...strategyGate.reasons);

  const fragileInternationalFavorite = profile.isInternational
    && isSidePick
    && odds <= 1.35
    && (
      oneXTwoCooldown
      || directionCooldown
      || pickProbability < 0.64
      || handicapSupport === null
      || handicapSupport < 0.42
    );
  if (fragileInternationalFavorite) reasons.push("fragile-international-favorite");

  const minPickProbability = (oneXTwoCooldown ? 0.58 : 0.52) + Number(dynamicGate.minProbabilityBoost || 0) + Number(strategyGate.minProbabilityBoost || 0);
  const minProbabilityGap = (oneXTwoCooldown ? 0.14 : 0.08) + Number(dynamicGate.minModelGapBoost || 0) + Number(strategyGate.minModelGapBoost || 0);
  const minModelGap = (oneXTwoCooldown ? 0.1 : 0.06) + Number(dynamicGate.minModelGapBoost || 0) + Number(strategyGate.minModelGapBoost || 0);
  const minHandicapSupport = (oneXTwoCooldown ? 0.38 : 0.3) + Number(dynamicGate.minHandicapSupportBoost || 0) + Number(strategyGate.minHandicapSupportBoost || 0);
  const minValueEdge = (odds <= 1.45 ? 0.045 : odds <= 1.7 ? 0.032 : 0.02)
    + Number(dynamicGate.minModelGapBoost || 0) * 0.35
    + Number(strategyGate.minModelGapBoost || 0) * 0.35;
  const minExpectedValue = odds <= 1.45 ? 0.045 : odds <= 1.7 ? 0.03 : 0.015;
  const maxDrawPressure = oneXTwoCooldown ? 0.32 : 0.36;
  const maxGateRiskTags = Math.max(0, (Number.isFinite(dynamicGate.maxRiskTags) ? Number(dynamicGate.maxRiskTags) : 3) + Number(strategyGate.maxRiskTagsDelta || 0));

  const strongSidePick = isSidePick
    && !hasSelectionDisagreement
    && pickProbability >= minPickProbability
    && probabilityGap >= minProbabilityGap
    && modelProbabilityGap >= minModelGap
    && probabilityEdge >= minValueEdge
    && (expectedValue === null || expectedValue >= minExpectedValue)
    && handicapSupport !== null
    && handicapSupport >= minHandicapSupport
    && probabilities.draw <= maxDrawPressure
    && odds > 1.08
    && odds <= 2.35
    && riskTags.length <= maxGateRiskTags
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const stricterProfileOk = (!profile.isInternational || odds > 1.35 || (pickProbability >= 0.58 && handicapSupport >= 0.3))
    && (!profile.isJapan || odds > 1.75 || (pickProbability >= 0.56 && handicapSupport >= 0.36));

  const valueSidePick = isSidePick
    && !hasSelectionDisagreement
    && pickProbability >= (oneXTwoCooldown ? 0.56 : 0.49)
    && probabilityGap >= (oneXTwoCooldown ? 0.12 : 0.065)
    && modelProbabilityGap >= (oneXTwoCooldown ? 0.095 : 0.055)
    && probabilityEdge >= Math.max(0.026, minValueEdge - 0.006)
    && (expectedValue === null || expectedValue >= Math.max(0.02, minExpectedValue))
    && handicapSupport !== null
    && handicapSupport >= (oneXTwoCooldown ? 0.38 : 0.34)
    && probabilities.draw <= 0.34
    && odds > 1.25
    && odds <= 2.65
    && riskTags.length <= Math.max(1, maxGateRiskTags - 1)
    && !(profile.isInternational && odds <= 1.34)
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const cooldownValueContrarianOk = oneXTwoCooldown
    && analystSelection.isContrarian
    && code === "X"
    && pickProbability >= 0.285
    && probabilityGap <= 0.14
    && probabilityEdge >= 0.018
    && (expectedValue === null || expectedValue >= 0.035)
    && riskTags.length <= 5;

  const valueContrarianPick = analystSelection.isContrarian
    && (!oneXTwoCooldown || (code === "X" && drawHasPositiveSample && cooldownValueContrarianOk))
    && pickProbability >= (code === "X" ? 0.26 : 0.29)
    && probabilityGap <= 0.18
    && modelProbabilityGap >= (code === "X" ? 0 : 0.035)
    && probabilityEdge >= (code === "X" ? 0.018 : 0.028)
    && (expectedValue === null || expectedValue >= (code === "X" ? 0.035 : 0.045))
    && odds >= (code === "X" ? 2.75 : 2.3)
    && odds <= 7.5
    && riskTags.length <= 4
    && (code === "X" || handicapSupport === null || handicapSupport >= 0.36);

  const tier = !fragileInternationalFavorite && strongSidePick && stricterProfileOk
    ? "strong"
    : !fragileInternationalFavorite && valueSidePick
      ? "value-side"
      : valueContrarianPick
        ? "value-contrarian"
        : "watch";

  return {
    promote: tier !== "watch",
    tier,
    reasons,
    handicapSupport,
    valueProfile: {
      ...valueProfile,
      modelProbability: Number.isFinite(pickProbability) ? pickProbability : null,
      marketProbability: Number.isFinite(marketPickProbability) ? marketPickProbability : null,
      probabilityEdge,
      expectedValue,
    },
    profile,
  };
}

function evaluateGoalsGate(match, goalsTip, goalsProbability, over25Probability, bttsProbability, predictionHealth) {
  const reasons = [];
  const edge = Math.abs(over25Probability - 0.5);
  const profile = matchVolatilityProfile(match);
  const profileKey = predictionProfileKey(match);
  const directionCooldown = Boolean(
    isCoolingBucket(predictionHealth?.goals?.byTip?.[goalsTip])
    || isCoolingBucket(predictionHealth?.goals?.byProfile?.[profileKey])
  );
  const goalsCooldown = Boolean(isCoolingBucket(predictionHealth?.byMarket?.GOALS) || directionCooldown);
  const under25IsHot = goalsTip === "U2.5" && isHotBucket(predictionHealth?.under25, 3, 0.6);
  let minProbability = goalsCooldown ? 0.68 : 0.63;
  let minEdge = goalsCooldown ? 0.18 : 0.13;
  const dynamicGate = profileCalibration(match).gate || {};
  const strategyGate = strategyGateForPrediction(match, "GOALS", goalsTip, "unknown");
  if (Number(dynamicGate.goalsMinBoost || 0) > 0) {
    minProbability += Number(dynamicGate.goalsMinBoost || 0);
    minEdge += Number(dynamicGate.goalsMinBoost || 0) * 0.5;
    reasons.push("dynamic-goals-cooldown");
  }
  if (Number(strategyGate.goalsMinBoost || strategyGate.minProbabilityBoost || 0) > 0) {
    const boost = Number(strategyGate.goalsMinBoost || strategyGate.minProbabilityBoost || 0);
    minProbability += boost;
    minEdge += boost * 0.5;
    reasons.push(...strategyGate.reasons);
  }

  if (under25IsHot) {
    minProbability -= 0.04;
    minEdge -= 0.03;
    reasons.push("under25-hot-sample");
  }

  if (profile.isInternational && goalsTip === "O2.5") {
    minProbability += 0.05;
    minEdge += 0.03;
    reasons.push("international-over-goals-noise");
  }

  if (profile.isJapan && goalsTip === "O2.5") {
    minProbability += 0.03;
    minEdge += 0.02;
    reasons.push("jleague-over-goals-noise");
  }

  if (goalsProbability < minProbability) reasons.push("thin-goal-edge");
  if (edge < minEdge) reasons.push("near-coin-flip-total");
  if (bttsProbability >= 0.46 && bttsProbability <= 0.56) reasons.push("btts-borderline");
  if (directionCooldown) reasons.push("direction-goals-hit-rate-cooldown");
  if (goalsCooldown) reasons.push("recent-goals-hit-rate-cooldown");

  return {
    promote: goalsProbability >= minProbability
      && edge >= minEdge
      && !(bttsProbability >= 0.46 && bttsProbability <= 0.56)
      && (goalsTip === "U2.5" || goalsProbability >= minProbability + 0.04),
    reasons,
  };
}

function selectValueAwareOneXTwo(match, picks, modelProbabilities, marketProbabilities, hhadProbabilities) {
  const modelLeader = picks[0];
  const profiles = picks.map((pick, index) => {
    const value = pickValueProfile(pick, modelProbabilities, marketProbabilities);
    const handicapSupport = hhadSupportForPick(hhadProbabilities, pick[0]);
    return {
      pick,
      code: pick[0],
      modelRank: index + 1,
      handicapSupport,
      ...value,
      score: (
        Math.max(0, Number(value.probabilityEdge || 0)) * 2.2
        + Math.max(0, Math.min(Number(value.expectedValue || 0), 0.28)) * 0.85
        + Number(value.modelProbability || 0) * 0.18
        + (index === 0 ? 0.025 : 0)
        - (pick[0] === "X" ? 0.015 : 0)
      ),
    };
  });
  const marketLeaderProfile = [...profiles]
    .sort((a, b) => Number(b.marketProbability || 0) - Number(a.marketProbability || 0))[0];
  const marketLeader = marketLeaderProfile?.pick || modelLeader;
  const modelLeaderProfile = profiles.find((profile) => profile.code === modelLeader?.[0]) || profiles[0];
  const leaderGap = Number(marketLeaderProfile?.marketProbability || 0)
    - Math.max(...profiles.filter((item) => item.code !== marketLeader?.[0]).map((item) => Number(item.marketProbability || 0)), 0);
  const leaderHandicapSupport = hhadSupportForPick(hhadProbabilities, marketLeader?.[0]);
  const weakHandicapSupport = marketLeader?.[0] !== "X" && leaderHandicapSupport !== null && leaderHandicapSupport < 0.42;
  const modelLeaderProbability = Number(modelLeader?.[1] || 0);
  const marketLeaderOdds = Number(marketLeader?.[2] || 0);
  const marketLeaderIsLowOddsSide = (marketLeader?.[0] === "1" || marketLeader?.[0] === "2")
    && marketLeaderOdds > 0
    && marketLeaderOdds <= 1.45;
  const protectedFavorite = marketLeaderIsLowOddsSide && modelLeader?.[0] === marketLeader?.[0];

  const qualifiesValue = (profile) => {
    const edge = Number(profile.probabilityEdge || 0);
    const ev = Number(profile.expectedValue || 0);
    const modelProbability = Number(profile.modelProbability || 0);
    const odds = Number(profile.odds || 0);
    const isDraw = profile.code === "X";
    const isSide = profile.code === "1" || profile.code === "2";
    const maxModelDiscount = modelLeaderProbability - modelProbability;
    const minEdge = isDraw ? 0.018 : odds <= 1.45 ? 0.05 : odds <= 1.7 ? 0.035 : 0.026;
    const minEv = isDraw ? 0.035 : odds <= 1.45 ? 0.05 : odds <= 1.7 ? 0.032 : 0.025;
    const minProbability = isDraw ? 0.245 : odds <= 1.7 ? 0.44 : 0.29;
    return edge >= minEdge
      && ev >= minEv
      && modelProbability >= minProbability
      && maxModelDiscount <= (isDraw ? 0.12 : 0.14)
      && odds >= (isDraw ? 2.65 : 1.32)
      && odds <= (isDraw ? 6.8 : 5.8)
      && (!isSide || profile.handicapSupport === null || profile.handicapSupport >= 0.34);
  };

  const keepsLowOddsFavoriteDirection = (profile) => {
    if (!protectedFavorite || profile.code === marketLeader?.[0]) return true;
    return Number(profile.modelProbability || 0) >= modelLeaderProbability + 0.015;
  };

  const valueCandidate = profiles
    .filter(qualifiesValue)
    .filter(keepsLowOddsFavoriteDirection)
    .sort((a, b) => b.score - a.score)[0];

  if (valueCandidate) {
    const changesModelLeader = valueCandidate.code !== modelLeader?.[0];
    const isContrarian = valueCandidate.code !== marketLeader?.[0];
    const edgeTextZh = `${pct(valueCandidate.probabilityEdge || 0)} 个百分点`;
    const edgeTextEn = `${pct(valueCandidate.probabilityEdge || 0)} points`;
    const evText = `${Math.round(Number(valueCandidate.expectedValue || 0) * 100)}%`;
    return {
      pick: changesModelLeader ? modelLeader : valueCandidate.pick,
      mode: changesModelLeader
        ? "model-leader-value-disagreement"
        : isContrarian
        ? (valueCandidate.code === "X" ? "value-draw" : "value-underdog")
        : "value-market",
      isContrarian: changesModelLeader ? false : isContrarian,
      hasValueDisagreement: changesModelLeader || isContrarian,
      valueProfile: changesModelLeader ? modelLeaderProfile : valueCandidate,
      disagreementProfile: changesModelLeader ? valueCandidate : null,
      reason: {
        zh: changesModelLeader
          ? `价值分歧：候选方向的模型概率比市场隐含概率高约 ${edgeTextZh}，EV 约 ${evText}；该信号只作为盘口分歧和风险校验，不改写模型首位方向。`
          : isContrarian
          ? `价值修正：不直接跟随最低 SP，候选方向模型概率比市场隐含概率高约 ${edgeTextZh}，EV 约 ${evText}，因此只按价值方向观察。`
          : `价值确认：独立模型先给出该方向，市场只是同步支持；模型概率比市场隐含概率高约 ${edgeTextZh}，EV 约 ${evText}，通过价值边际检查。`,
        en: changesModelLeader
          ? `Value disagreement: the candidate is about ${edgeTextEn} above market-implied probability with EV around ${evText}. This is kept as market-disagreement risk only and does not rewrite the model-leading direction.`
          : isContrarian
          ? `Value adjustment: not blindly following the lowest SP. The candidate is about ${edgeTextEn} above market-implied probability with EV around ${evText}, so it is kept as value-watch.`
          : `Value confirmation: the independent model gives this direction first and the market only agrees; model probability is about ${edgeTextEn} above market-implied probability with EV around ${evText}.`,
      },
    };
  }

  const drawProfile = profiles.find((profile) => profile.code === "X");
  const drawIsLive = drawProfile
    && Number(drawProfile.modelProbability || 0) >= 0.27
    && Number(drawProfile.probabilityEdge || 0) >= 0.012
    && Number(drawProfile.expectedValue || 0) >= 0.025
    && Number(marketLeaderProfile?.marketProbability || 0) <= 0.46
    && (Number(modelLeader?.[1] || 0) - Number(drawProfile.modelProbability || 0)) <= 0.16;

  if (drawIsLive && keepsLowOddsFavoriteDirection(drawProfile) && (weakHandicapSupport || leaderGap <= 0.13)) {
    return {
      pick: modelLeader,
      mode: "value-draw",
      isContrarian: false,
      hasValueDisagreement: true,
      valueProfile: modelLeaderProfile,
      disagreementProfile: drawProfile,
      reason: {
        zh: `防平分歧：最低 SP 方向让球确认不足，平局模型概率较市场高约 ${pct(drawProfile.probabilityEdge || 0)} 个百分点；该信号只提示防平，不改写模型首位方向。`,
        en: `Draw disagreement: the lowest-SP side lacks handicap confirmation, while draw model probability is about ${pct(drawProfile.probabilityEdge || 0)} points above market. This flags draw cover only and does not rewrite the model leader.`,
      },
    };
  }

  return {
    pick: modelLeader,
    mode: "model-leader",
    isContrarian: false,
    hasValueDisagreement: false,
    valueProfile: modelLeaderProfile,
    reason: {
      zh: "模型首位：当前没有发现足够强的冷门/防平价值边际；若该方向只是最低 SP 但边际不足，后续风控会降级为观察。",
      en: "Model lead: no strong draw/upset value edge was found. If this is merely the lowest-SP side without value edge, the gate will downgrade it to watch.",
    },
  };
}

function selectAnalystOneXTwo(match, picks, probabilities, hhadProbabilities) {
  const marketLeader = picks[0];
  const runnerUp = picks[1];
  const drawPick = pickByCode(picks, "X");
  const homePick = pickByCode(picks, "1");
  const awayPick = pickByCode(picks, "2");
  const leaderGap = marketLeader[1] - runnerUp[1];
  const leaderHandicapSupport = hhadSupportForPick(hhadProbabilities, marketLeader[0]);
  const weakHandicapSupport = marketLeader[0] !== "X" && leaderHandicapSupport !== null && leaderHandicapSupport < 0.42;
  const drawIsLive = drawPick && drawPick[1] >= 0.27 && marketLeader[1] <= 0.46 && (marketLeader[1] - drawPick[1]) <= 0.16;
  const underdogPick = [homePick, awayPick]
    .filter(Boolean)
    .filter((pick) => pick[0] !== marketLeader[0])
    .sort((a, b) => b[1] - a[1])[0];
  const underdogHandicapSupport = underdogPick ? hhadSupportForPick(hhadProbabilities, underdogPick[0]) : null;
  const underdogIsLive = underdogPick
    && marketLeader[1] <= 0.44
    && underdogPick[1] >= 0.30
    && (marketLeader[1] - underdogPick[1]) <= 0.12
    && (underdogHandicapSupport === null || underdogHandicapSupport >= 0.4);

  if (drawIsLive && (weakHandicapSupport || leaderGap <= 0.13)) {
    return {
      pick: drawPick,
      mode: "value-draw",
      isContrarian: true,
      reason: {
        zh: `专业修正：不机械追随最低 SP。本场胜平负首选与平局差距不大，平局去水支持率约 ${pct(probabilities.draw)}%，且让球盘对正路支持不足，稳妥方向降为防平观察。`,
        en: `Analyst adjustment: not blindly following the lowest SP. The draw is live at about ${pct(probabilities.draw)}% normalized support, and handicap support for the market favorite is weak.`,
      },
    };
  }

  if (underdogIsLive && weakHandicapSupport) {
    return {
      pick: underdogPick,
      mode: "value-underdog",
      isContrarian: true,
      reason: {
        zh: `专业修正：正路热度与让球盘存在分歧，非热门方向去水支持率约 ${pct(underdogPick[1])}%，本场更适合做冷门价值观察。`,
        en: `Analyst adjustment: the favorite is not fully confirmed by handicap support; the non-favorite side is kept as value-watch.`,
      },
    };
  }

  return {
    pick: marketLeader,
    mode: "market-leader",
    isContrarian: false,
    reason: {
      zh: `市场主线：最低 SP 方向与去水支持率一致，暂未触发足够强的冷门或防平修正。`,
      en: `Market lead: the lowest-SP side remains aligned with normalized support; no strong draw/upset adjustment was triggered.`,
    },
  };
}

function chooseNarrative(match, salt, builders) {
  const rand = seeded(`${match.sourceMatchId}-${salt}`);
  const idx = Math.min(builders.length - 1, Math.floor(rand() * builders.length));
  return builders[idx]();
}

function buildBestNarrative(match, context) {
  const {
    oneXTwo,
    bestShouldWatch,
    analystSelection,
    bestIsSteady,
    bestHasWeakHandicap,
    bestHasThinEdge,
    riskTags,
    probabilityGap,
    modelProbabilityGap,
    bestHandicapSupport,
    totalLambda,
    over25Probability,
    bttsProbability,
    score,
    hhadProbabilities
  } = context;
  const tipZh = oneXTwo.tipLabel.zh;
  const tipEn = oneXTwo.tipLabel.en;
  const marketGapZh = `${pct(probabilityGap)} 个百分点`;
  const modelGapZh = `${pct(modelProbabilityGap)} 个百分点`;
  const marketGapEn = `${pct(probabilityGap)} points`;
  const modelGapEn = `${pct(modelProbabilityGap)} points`;
  const handicapZh = bestHandicapSupport === null
    ? "让球盘暂时不足以验证同向强度"
    : `让球同向支持约 ${pct(bestHandicapSupport)}%`;
  const handicapEn = bestHandicapSupport === null
    ? "handicap confirmation is unavailable"
    : `same-side handicap support is about ${pct(bestHandicapSupport)}%`;
  const riskTextZh = riskTags.length ? riskTags.map((tag) => tag.zh).join("、") : "暂无明显风险标签";
  const riskTextEn = riskTags.length ? riskTags.map((tag) => tag.en).join(", ") : "no major risk tag";
  const hhadTextZh = hhadProbabilities
    ? `让球盘去水支持约 主胜 ${pct(hhadProbabilities.home)}% / 平 ${pct(hhadProbabilities.draw)}% / 客胜 ${pct(hhadProbabilities.away)}%`
    : "让球盘暂无可用去水支持率";
  const hhadTextEn = hhadProbabilities
    ? `handicap normalized support is home ${pct(hhadProbabilities.home)}% / draw ${pct(hhadProbabilities.draw)}% / away ${pct(hhadProbabilities.away)}%`
    : "handicap normalized support is unavailable";
  const goalsZh = `进球侧：比分热区 ${score.home}-${score.away}，总期望 ${totalLambda.toFixed(2)}，大 2.5 约 ${pct(over25Probability)}%，双方进球约 ${pct(bttsProbability)}%。`;
  const goalsEn = `Goals: score heat zone ${score.home}-${score.away}, total xG ${totalLambda.toFixed(2)}, over 2.5 about ${pct(over25Probability)}%, BTTS about ${pct(bttsProbability)}%.`;
  const lateRiskZh = `临场复核：${riskTextZh}。如果赛前 SP 继续降赔但让球支持不上来，仍按参考处理。`;
  const lateRiskEn = `Late check: ${riskTextEn}. If SP shortens without handicap confirmation, keep this as reference-only.`;
  const watchTipZh = analystSelection.isContrarian
    ? analystSelection.mode === "value-draw"
      ? `防平参考 ${tipZh}`
      : `冷门参考 ${tipZh}`
    : tipZh;
  const watchTipEn = analystSelection.isContrarian
    ? analystSelection.mode === "value-draw"
      ? `draw-cover reference ${tipEn}`
      : `upset reference ${tipEn}`
    : tipEn;

  if (bestShouldWatch) {
    const subtype = bestHasWeakHandicap ? "weak-handicap" : bestHasThinEdge ? "thin-edge" : "stacked-risk";
    const explanation = chooseNarrative(match, `best-watch-${subtype}`, [
      () => ({
        zh: analystSelection.isContrarian
          ? `这场先不把${watchTipZh}包装成主推。它的意义是提醒防平/防冷，主盘与让球盘还没有形成完整共振。`
          : `这场先不把${watchTipZh}包装成高可信。HAD 方向虽然清楚，但${handicapZh}，盘口确认不够完整。`,
        en: analystSelection.isContrarian
          ? `This is not packaged as a main pick. ${watchTipEn} is used as draw/upset protection because 1X2 and handicap are not fully aligned.`
          : `This is not packaged as high confidence. ${watchTipEn} leads the HAD read, but ${handicapEn}, so confirmation is incomplete.`
      }),
      () => ({
        zh: `${watchTipZh}只能作为参考，不是主推结论：模型差距约 ${modelGapZh}，真正的问题在让球盘是否愿意继续同向。`,
        en: `${watchTipEn} is a reference only, not the main pick: model edge is ${modelGapEn}, and the key question is handicap confirmation.`
      }),
      () => ({
        zh: `这场有正路倾向，但不适合硬写成稳胆。${handicapZh}，风险标签为 ${riskTextZh}，先按观察单处理。`,
        en: `There is a favorite lean, but not a banker. ${handicapEn}; risk tags: ${riskTextEn}. Keep it in watch mode.`
      }),
      () => ({
        zh: `模型没有否定${watchTipZh}，只是拒绝把它抬到主推：市场第一方向领先 ${marketGapZh}，但让球验证和风险项还没闭合。`,
        en: `The model is not rejecting ${watchTipEn}; it is refusing to upgrade it. Market lead is ${marketGapEn}, but handicap and risk checks are not closed.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        {
          zh: bestHasWeakHandicap
            ? `降级原因：${tipZh}对应 ${handicapZh}；${hhadTextZh}，和普通胜平负主线存在温差。`
            : bestHasThinEdge
              ? `降级原因：独立模型首选优势约 ${modelGapZh}，未达到强推荐阈值；市场差距约 ${marketGapZh}，仅作为校验。`
              : `降级原因：风险标签叠加为 ${riskTextZh}，当前不适合只给单一方向。`,
          en: bestHasWeakHandicap
            ? `Downgrade reason: ${tipEn} has ${handicapEn}; ${hhadTextEn}, not fully aligned with HAD.`
            : bestHasThinEdge
              ? `Downgrade reason: independent model edge is about ${modelGapEn}, below the strong-pick threshold; market gap is about ${marketGapEn} and is validation only.`
              : `Downgrade reason: risk tags overlap: ${riskTextEn}. A single pick is not justified yet.`
        },
        { zh: goalsZh, en: goalsEn },
        { zh: lateRiskZh, en: lateRiskEn }
      ]
    };
  }

  if (analystSelection.isContrarian) {
    const isDrawValue = analystSelection.mode === "value-draw";
    const explanation = chooseNarrative(match, `best-contrarian-${analystSelection.mode}`, [
      () => ({
        zh: isDrawValue
          ? `这场重点不是追低赔，而是平局拉力。主线没有拉开足够距离，让球盘也没有把正路完全坐实。`
          : `低赔方向有热度，但让球盘没有同步确认。模型把${tipZh}保留为价值观察，而不是常规正路。`,
        en: isDrawValue
          ? `The key is draw pressure rather than chasing the lowest SP. The main line has not separated enough, and handicap support is incomplete.`
          : `The low-SP side is warm, but handicap support does not fully confirm it. ${tipEn} is kept as value-watch, not a standard favorite.`
      }),
      () => ({
        zh: isDrawValue
          ? `平局在这场不是陪衬项：胜平负差距偏窄，正路让球支持偏弱，因此优先看防平价值。`
          : `${tipZh}属于盘口分歧下的冷门观察。它不是最高确定性方向，但比机械追随热门更有赔率解释空间。`,
        en: isDrawValue
          ? `The draw is not a filler here: the 1X2 spread is narrow and favorite handicap support is weak, so draw cover has value.`
          : `${tipEn} is an upset watch under market disagreement. It is not high-certainty, but has more price logic than blindly following the favorite.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        {
          zh: `盘口分歧：${analystSelection.reason.zh.replace(/^专业修正：/, "")} 市场差异约 ${marketGapZh}，只用于解释分歧；独立模型首选优势约 ${modelGapZh}。`,
          en: `Market disagreement: ${analystSelection.reason.en.replace(/^Analyst adjustment: /, "")} Market gap is about ${marketGapEn} and is explanatory only; independent model edge is about ${modelGapEn}.`
        },
        { zh: goalsZh, en: goalsEn },
        {
          zh: `风险边界：这是价值观察，不是高确定性推荐；若临场平局 SP 被明显抬高或让球盘重新支持热门，需要下调权重。`,
          en: `Risk boundary: this is value-watch, not high certainty. If late draw SP drifts or handicap support returns to the favorite, downgrade it.`
        }
      ]
    };
  }

  if (bestIsSteady) {
    const explanation = chooseNarrative(match, "best-steady", [
      () => ({
        zh: `这场能进入候选，不是因为赔率低，而是官方 SP、模型概率和风险标签没有互相打架：${tipZh}同时得到多项支持。`,
        en: `This makes the shortlist not because the odds are low, but because official SP, model probability, and risk checks are aligned for ${tipEn}.`
      }),
      () => ({
        zh: `${tipZh}是本场较完整的一条主线：市场领先 ${marketGapZh}，模型领先 ${modelGapZh}，风险标签控制在低位。`,
        en: `${tipEn} is the cleanest main line here: market edge ${marketGapEn}, model edge ${modelGapEn}, and risk tags remain contained.`
      }),
      () => ({
        zh: `这场的优势来自一致性。普通胜平负、进球模型和风险过滤都没有明显反向信号，${tipZh}可列入赛前候选。`,
        en: `The edge comes from alignment. 1X2, goal model, and risk filter do not send a strong opposite signal, so ${tipEn} stays on the shortlist.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        { zh: `主线确认：市场第一方向领先约 ${marketGapZh}，模型第一方向领先约 ${modelGapZh}，${handicapZh}。`, en: `Main-line check: market edge about ${marketGapEn}, model edge about ${modelGapEn}, ${handicapEn}.` },
        { zh: goalsZh, en: goalsEn },
        { zh: `风险提示：即便进入候选，也只代表赛前概率更优；临场若出现 ${riskTextZh} 加重，需要重新降级。`, en: `Risk note: shortlist only means better pre-match probability. If ${riskTextEn} worsens late, downgrade it.` }
      ]
    };
  }

  const explanation = chooseNarrative(match, "best-model-lean", [
    () => ({
      zh: `${tipZh}是模型首选，但还不到“稳”的级别。当前优势来自概率排序，后续仍要看 SP 是否继续支持。`,
      en: `${tipEn} is the model lean, but not a steady pick. The edge comes from probability ranking and still needs late SP support.`
    }),
    () => ({
      zh: `这场有方向，但不是强方向。${tipZh}领先第二选择约 ${modelGapZh}，足够进入跟踪，不足以直接升为高可信。`,
      en: `There is a lean, not a strong lean. ${tipEn} leads the second option by about ${modelGapEn}, enough to track but not enough to upgrade.`
    })
  ]);

  return {
    explanation,
    analysisItems: [
      { zh: `独立模型排序：${tipZh}暂列第一，模型优势约 ${modelGapZh}；市场差距约 ${marketGapZh}，仅用于校验风险。`, en: `Independent model ranking: ${tipEn} is first with model edge about ${modelGapEn}; market gap is about ${marketGapEn} and is used only for risk validation.` },
      { zh: goalsZh, en: goalsEn },
      { zh: `观察点：${riskTextZh}；若临场 SP 与让球盘分歧扩大，不建议强行升档。`, en: `Watch point: ${riskTextEn}. If late SP and handicap diverge further, do not upgrade it.` }
    ]
  };
}

const MODEL_ONLY_TEAM_STRENGTH = new Map(Object.entries({
  "阿根廷": 0.92,
  "法国": 0.9,
  "英格兰": 0.88,
  "葡萄牙": 0.87,
  "巴西": 0.87,
  "西班牙": 0.86,
  "德国": 0.82,
  "荷兰": 0.81,
  "比利时": 0.78,
  "克罗地亚": 0.76,
  "意大利": 0.75,
  "乌拉圭": 0.73,
  "哥伦比亚": 0.72,
  "丹麦": 0.7,
  "瑞士": 0.69,
  "美国": 0.66,
  "墨西哥": 0.65,
  "日本": 0.65,
  "韩国": 0.62,
  "尼日利亚": 0.62,
  "匈牙利": 0.61,
  "塞内加尔": 0.61,
  "摩洛哥": 0.61,
  "波兰": 0.6,
  "奥地利": 0.6,
  "捷克": 0.57,
  "哥斯达黎加": 0.5,
  "冰岛": 0.47,
  "南非": 0.45,
  "中国": 0.38,
  "哈萨克斯坦": 0.34,
  "泰国": 0.34,
}));

function canonicalTeamNameForModel(value) {
  return normText(value).toLowerCase().replace(/\s+/g, "");
}

function rankToStrength(rank) {
  const value = toNum(rank);
  if (!Number.isFinite(value) || value <= 0) return null;
  return clamp(1 - (value - 1) / 140, 0.22, 0.94);
}

function externalFifaRank(match, side) {
  const rank = match.externalSignals?.fiveHundred?.rank?.[side]?.fifaRank;
  return Number.isFinite(Number(rank)) ? Number(rank) : null;
}

function worldCupPriorSide(match, side) {
  const prior = match.worldCupPrior || match.externalSignals?.worldCupPrior;
  return prior?.[side] || null;
}

function worldCupPriorStrength(match, side) {
  const strength = Number(worldCupPriorSide(match, side)?.modelStrengthNormalized);
  return Number.isFinite(strength) ? clamp(strength, 0.18, 0.96) : null;
}

function worldCupPriorOutcomeProbabilities(match) {
  const home = worldCupPriorSide(match, "home");
  const away = worldCupPriorSide(match, "away");
  const homeStrength = Number(home?.modelStrengthNormalized);
  const awayStrength = Number(away?.modelStrengthNormalized);
  if (!Number.isFinite(homeStrength) || !Number.isFinite(awayStrength)) return null;

  const homeAdvance = Number(home?.groupOutlook?.advanceProbability);
  const awayAdvance = Number(away?.groupOutlook?.advanceProbability);
  const advanceDiff = Number.isFinite(homeAdvance) && Number.isFinite(awayAdvance)
    ? (homeAdvance - awayAdvance) / 100
    : 0;
  const diff = clamp((homeStrength - awayStrength) * 0.82 + advanceDiff * 0.14, -0.38, 0.38);
  const draw = clamp(0.27 - Math.abs(diff) * 0.18, 0.18, 0.3);
  const homeProbability = clamp((1 - draw) * (0.5 + diff), 0.08, 0.84);
  const awayProbability = clamp(1 - draw - homeProbability, 0.08, 0.84);
  return normalizeOutcomeProbabilities({
    home: homeProbability,
    draw,
    away: awayProbability,
  });
}

function teamModelStrength(match, side, rand) {
  const priorStrength = worldCupPriorStrength(match, side);
  if (priorStrength !== null) return priorStrength;

  const name = side === "home" ? match.homeTeam : match.awayTeam;
  const directRank = side === "home" ? match.homeRank : match.awayRank;
  const rankStrength = rankToStrength(directRank) || rankToStrength(externalFifaRank(match, side));
  if (rankStrength !== null) return rankStrength;

  const normalizedName = canonicalTeamNameForModel(name);
  for (const [teamName, strength] of MODEL_ONLY_TEAM_STRENGTH.entries()) {
    if (normalizedName.includes(canonicalTeamNameForModel(teamName))) return strength;
  }

  return clamp(0.47 + (rand() - 0.5) * 0.12, 0.32, 0.62);
}

function syntheticModelOnlyProbabilities(match) {
  const rand = seeded(`${match.sourceMatchId}-${match.homeTeam}-${match.awayTeam}-model-only`);
  const profile = matchVolatilityProfile(match);
  const homeStrength = teamModelStrength(match, "home", rand);
  const awayStrength = teamModelStrength(match, "away", rand);
  const homeAdvantage = profile.isInternational ? 0.012 : 0.055;
  const strengthDiff = clamp((homeStrength - awayStrength) * 0.62 + homeAdvantage + (rand() - 0.5) * 0.045, -0.34, 0.34);
  const draw = clamp(0.255 - Math.abs(strengthDiff) * 0.18 + (rand() - 0.5) * 0.035, 0.18, 0.3);
  const home = clamp((1 - draw) * clamp(0.5 + strengthDiff, 0.16, 0.84), 0.08, 0.82);
  const away = clamp(1 - draw - home, 0.08, 0.82);
  return normalizeOutcomeProbabilities({ home, draw, away });
}

function oneXTwoCodeForScore(home, away) {
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
}

function alignedScoreForOneXTwoPick(homeLambda, awayLambda, code) {
  if (!["1", "X", "2"].includes(code)) return null;

  return scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => oneXTwoCodeForScore(row.home, row.away) === code)
    .sort((a, b) => {
      const probabilityDiff = b.probability - a.probability;
      if (Math.abs(probabilityDiff) > 0.000001) return probabilityDiff;
      return (a.home + a.away) - (b.home + b.away);
    })[0] || null;
}

function alignedModelOnlyForecast(homeLambda, awayLambda, code) {
  const score = alignedScoreForOneXTwoPick(homeLambda, awayLambda, code);
  if (!score) return null;

  return {
    score: { home: score.home, away: score.away },
    homeLambda: alignLambdaToScore(homeLambda, score.home, 4.4),
    awayLambda: alignLambdaToScore(awayLambda, score.away, 4.4),
  };
}

function modelOnlyPickEntries(probabilities) {
  return [
    { code: "1", probability: probabilities.home, labelZh: "主胜", labelEn: "Home win" },
    { code: "X", probability: probabilities.draw, labelZh: "平局", labelEn: "Draw" },
    { code: "2", probability: probabilities.away, labelZh: "客胜", labelEn: "Away win" },
  ].sort((a, b) => b.probability - a.probability);
}

function buildModelOnlyProbabilityModel(match, probabilities, homeLambda, awayLambda) {
  const rawOver25Probability = clamp(1 - [0, 1, 2].reduce((sum, goals) => sum + poissonProbability(homeLambda + awayLambda, goals), 0), 0, 1);
  const rawBttsProbability = clamp((1 - Math.exp(-homeLambda)) * (1 - Math.exp(-awayLambda)), 0, 1);
  const goalCalibration = calibrateGoalProbabilities(match, rawOver25Probability, rawBttsProbability);
  const lambdaBlend = {
    marketHomeLambda: homeLambda,
    marketAwayLambda: awayLambda,
    homeLambda,
    awayLambda,
    formWeight: 0,
    formHomeLambda: null,
    formAwayLambda: null,
  };
  const probabilityModel = buildProbabilityModel(
    match,
    probabilities,
    null,
    homeLambda,
    awayLambda,
    goalCalibration.over25,
    goalCalibration.btts,
    lambdaBlend,
    goalCalibration
  );

  return {
    probabilityModel: {
      ...probabilityModel,
      version: "model-only-no-official-sp-v1",
      basis: {
        zh: "未开售模型参考：官方 SP/让球 SP 暂无时，按球队强弱、历史样本、赛程与 Poisson 比分分布生成观察方向；不作为串关 SP。",
        en: "Model-only reference while official SP/handicap SP is unavailable. It uses team strength, historical samples, schedule context, and Poisson score distribution, and is not a parlay SP."
      },
      calibration: {
        status: "baseline",
        zh: "当前为未开售低权重参考；开售后会切回中国竞彩网官方 SP/让球 SP 重新评估。",
        en: "Low-weight reference before official prices open; once Sporttery SP/handicap SP is available, the model switches back to official-odds evaluation."
      }
    },
    over25Probability: goalCalibration.over25,
    bttsProbability: goalCalibration.btts,
  };
}

function predictionSetWithoutOfficialOdds(match) {
  const probabilities = syntheticModelOnlyProbabilities(match);
  const leader = outcomeLeader(probabilities);
  const rand = seeded(`${match.sourceMatchId}-model-only-goals`);
  const totalLambdaSeed = 2.18 + (1 - probabilities.draw) * 0.38 + Math.abs(probabilities.home - probabilities.away) * 0.52 + (rand() - 0.5) * 0.22;
  const totalLambda = clamp(totalLambdaSeed, 1.65, 3.35);
  const sideBias = clamp((probabilities.home - probabilities.away) * 1.45, -0.75, 0.75);
  let homeLambda = clamp(totalLambda / 2 + sideBias, 0.35, 3.2);
  let awayLambda = clamp(totalLambda - homeLambda, 0.35, 3.2);
  let score = representativeProjectedScore(homeLambda, awayLambda, leader.code);
  let aligned = alignedModelOnlyForecast(homeLambda, awayLambda, leader.code);
  if (aligned) {
    homeLambda = aligned.homeLambda;
    awayLambda = aligned.awayLambda;
    score = representativeProjectedScore(homeLambda, awayLambda, leader.code);
  }

  let modelBundle = buildModelOnlyProbabilityModel(match, probabilities, homeLambda, awayLambda);
  let picks = modelOnlyPickEntries(modelBundle.probabilityModel.oneXTwo.final || asPercentTriplet(probabilities));
  const modelLeader = picks[0];
  const scoreCode = oneXTwoCodeForScore(score.home, score.away);
  if (scoreCode !== modelLeader.code) {
    aligned = alignedModelOnlyForecast(homeLambda, awayLambda, modelLeader.code);
    if (aligned) {
      homeLambda = aligned.homeLambda;
      awayLambda = aligned.awayLambda;
      score = representativeProjectedScore(homeLambda, awayLambda, modelLeader.code);
      modelBundle = buildModelOnlyProbabilityModel(match, probabilities, homeLambda, awayLambda);
      picks = modelOnlyPickEntries(modelBundle.probabilityModel.oneXTwo.final || asPercentTriplet(probabilities));
    }
  }

  const bestPick = picks[0];
  const secondPick = picks[1];
  const probabilityGap = Math.max(0, bestPick.probability - secondPick.probability);
  const bestProbability = Number(bestPick.probability);
  const trustScore = clamp(Math.round(bestProbability + probabilityGap * 0.75 + 5), 45, 78);
  const shouldPromote = bestProbability >= 39 && probabilityGap >= 4;
  const riskTags = [
    { zh: "未开售无官方SP", en: "No official SP" },
    { zh: "仅模型参考", en: "Model-only reference" },
    ...(probabilityGap < 8 ? [{ zh: "优势不厚", en: "Thin edge" }] : []),
  ];
  const final = modelBundle.probabilityModel.oneXTwo.final || { home: 0, draw: 0, away: 0 };
  const probabilityTextZh = `主胜 ${Number(final.home || 0).toFixed(1)}% / 平 ${Number(final.draw || 0).toFixed(1)}% / 客胜 ${Number(final.away || 0).toFixed(1)}%`;
  const probabilityTextEn = `home ${Number(final.home || 0).toFixed(1)}% / draw ${Number(final.draw || 0).toFixed(1)}% / away ${Number(final.away || 0).toFixed(1)}%`;
  const tipLabel = {
    zh: shouldPromote ? `模型参考 ${bestPick.labelZh}` : "观察为主 等待官方SP",
    en: shouldPromote ? `Model reference: ${bestPick.labelEn}` : "Watch first: wait for official SP",
  };

  const oneXTwo = {
    marketType: "1X2",
    tipCode: shouldPromote ? bestPick.code : "WATCH",
    tipLabel,
    odds: 0,
    trustScore,
    explanation: {
      zh: shouldPromote
        ? `本场胜平负暂未开售，先用球队强弱、历史样本和比分分布给出参考方向：${bestPick.labelZh}。该值不是官方 SP，不进入串关。`
        : "本场胜平负暂未开售，模型差距不够厚，暂时只保留参考位，等待中国竞彩网 SP/让球 SP 更新。",
      en: shouldPromote
        ? `Official 1X2 is not open yet. Team strength, history, and score distribution lean to ${bestPick.labelEn}. This is not official SP and is excluded from parlays.`
        : "Official 1X2 is not open yet and the model edge is thin, so this remains reference-only until Sporttery SP/handicap SP updates.",
    },
    analysisItems: [
      {
        zh: `模型概率：${probabilityTextZh}；第一方向领先第二方向约 ${probabilityGap.toFixed(1)} 个百分点。`,
        en: `Model probabilities: ${probabilityTextEn}; the first lane leads the second by about ${probabilityGap.toFixed(1)} points.`,
      },
      {
        zh: `比分热区已和方向校准在 ${score.home}-${score.away} 附近，避免出现方向与比分互相打架。`,
        en: `Score heat is aligned around ${score.home}-${score.away}, keeping the scoreline consistent with the directional lean.`,
      },
      {
        zh: "开售后优先读取中国竞彩网 HAD/HHAD SP，并用官方赔率重算；当前内容只做赛前讨论参考。",
        en: "Once Sporttery HAD/HHAD opens, official SP is used first and this model-only read is recalculated.",
      },
    ],
    riskTags,
    visibilityStatus: "FREE",
    resultStatus: shouldPromote ? resultStatus(match, bestPick.code, "1X2") : "PENDING",
  };

  const best = {
    marketType: "BEST",
    tipCode: oneXTwo.tipCode,
    tipLabel: {
      zh: shouldPromote ? `模型参考 ${bestPick.labelZh}` : "观察为主 等待官方SP",
      en: shouldPromote ? `Model reference: ${bestPick.labelEn}` : "Watch first: wait for official SP",
    },
    odds: 0,
    trustScore: clamp(trustScore - (shouldPromote ? 0 : 8), 35, 76),
    explanation: oneXTwo.explanation,
    analysisItems: oneXTwo.analysisItems,
    riskTags,
    visibilityStatus: "FREE",
    resultStatus: oneXTwo.resultStatus,
  };

  return {
    predictions: [oneXTwo, best],
    homeLambda,
    awayLambda,
    projectedScore: score,
    probabilityModel: modelBundle.probabilityModel,
  };
}

function oddsAnchorSourceInfo(match, isHhad, handicapLine) {
  const source = isHhad ? match.handicapOddsSource : match.oddsSource;
  const isSporttery = String(source || "").startsWith("sporttery:");
  const isFiveHundred = String(source || "").startsWith("500.com");
  if (isSporttery) {
    return {
      source,
      isOfficial: true,
      labelZh: isHhad ? `官方 HHAD 让球胜平负(${handicapLine || "--"})` : "中国竞彩网官方 HAD 胜平负",
      labelEn: isHhad ? `official Sporttery HHAD (${handicapLine || "--"})` : "official Sporttery HAD",
      snapshotZh: "本次中国竞彩网同步快照",
      snapshotEn: "this Sporttery sync snapshot",
    };
  }

  if (isFiveHundred) {
    return {
      source,
      isOfficial: false,
      labelZh: isHhad ? `500 网 HHAD 让球胜平负参考(${handicapLine || "--"})` : "500 网 HAD 胜平负参考",
      labelEn: isHhad ? `500.com HHAD reference (${handicapLine || "--"})` : "500.com HAD reference",
      snapshotZh: "本次 500 网参考快照",
      snapshotEn: "this 500.com reference snapshot",
    };
  }

  return {
    source,
    isOfficial: false,
    labelZh: isHhad ? `让球胜平负参考(${handicapLine || "--"})` : "胜平负参考",
    labelEn: isHhad ? `handicap 1X2 reference (${handicapLine || "--"})` : "1X2 reference",
    snapshotZh: "本次参考数据快照",
    snapshotEn: "this reference snapshot",
  };
}

function predictionSet(match) {
  const hadOdds = sanitizeOdds(match.odds);
  const hhadOdds = sanitizeOdds(match.handicapOdds);
  const anchorOdds = hadOdds || hhadOdds;
  const anchorPoolCode = hadOdds ? "HAD" : "HHAD";
  const anchorIsHhad = anchorPoolCode === "HHAD";
  const anchorHandicapLine = anchorIsHhad ? (match.handicapLine || "") : "0";
  const anchorMarketType = anchorIsHhad ? "HHAD" : "1X2";
  const anchorSourceInfo = oddsAnchorSourceInfo(match, anchorIsHhad, anchorHandicapLine);
  const anchorLabelZh = anchorSourceInfo.labelZh;
  const anchorLabelEn = anchorSourceInfo.labelEn;
  const probabilities = impliedProbabilities(anchorOdds);
  const hhadProbabilities = hhadOdds ? impliedProbabilities(hhadOdds) : null;
  const independentProbabilities = syntheticModelOnlyProbabilities(match);
  const independentLambda = independentBaseLambdas(match, independentProbabilities);
  const marketHomeLambda = independentLambda.homeLambda;
  const marketAwayLambda = independentLambda.awayLambda;
  const leagueLambda = blendLambdasWithLeaguePrior(match, independentLambda.homeLambda, independentLambda.awayLambda);
  const formLambda = blendLambdasWithForm(match, leagueLambda.homeLambda, leagueLambda.awayLambda);
  const lambdaBlend = {
    marketHomeLambda,
    marketAwayLambda,
    independentHomeLambda: Number(independentLambda.homeLambda.toFixed(2)),
    independentAwayLambda: Number(independentLambda.awayLambda.toFixed(2)),
    independentTotalLambda: independentLambda.totalLambda,
    independentHomeShare: independentLambda.homeShare,
    leagueHomeLambda: leagueLambda.leagueHomeLambda,
    leagueAwayLambda: leagueLambda.leagueAwayLambda,
    leagueWeight: leagueLambda.leagueWeight,
    leaguePriorKey: leagueLambda.leaguePriorKey,
    ...formLambda,
  };
  let homeLambda = lambdaBlend.homeLambda;
  let awayLambda = lambdaBlend.awayLambda;
  let score = projectedScore(homeLambda, awayLambda);
  const alignedForecast = null;
  if (alignedForecast) {
    homeLambda = alignedForecast.homeLambda;
    awayLambda = alignedForecast.awayLambda;
    score = alignedForecast.score;
    lambdaBlend.marketHomeLambda = alignedForecast.homeLambda;
    lambdaBlend.marketAwayLambda = alignedForecast.awayLambda;
    lambdaBlend.homeLambda = alignedForecast.homeLambda;
    lambdaBlend.awayLambda = alignedForecast.awayLambda;
  }
  const totalLambda = homeLambda + awayLambda;
  const rawOver25Probability = clamp(1 - [0, 1, 2].reduce((sum, goals) => sum + poissonProbability(totalLambda, goals), 0), 0, 1);
  const rawBttsProbability = clamp((1 - Math.exp(-homeLambda)) * (1 - Math.exp(-awayLambda)), 0, 1);
  const goalCalibration = calibrateGoalProbabilities(match, rawOver25Probability, rawBttsProbability);
  const over25Probability = goalCalibration.over25;
  const bttsProbability = goalCalibration.btts;
  const goalsTip = over25Probability >= 0.52 ? "O2.5" : "U2.5";
  const goalsProbability = goalsTip === "O2.5" ? over25Probability : 1 - over25Probability;
  const goalsOdds = Number(clamp(1 / Math.max(goalsProbability, 0.36), 1.2, 2.78).toFixed(2));
  const goalsTipLabel = goalsTip === "O2.5"
    ? { zh: "大2.5球（≥3球）", en: "Over 2.5 goals" }
    : { zh: "小2.5球（≤2球）", en: "Under 2.5 goals" };
  const probabilityModel = buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration);
  const finalOneXTwoProbabilities = {
    home: (probabilityModel.oneXTwo.final?.home || pct1(independentProbabilities.home)) / 100,
    draw: (probabilityModel.oneXTwo.final?.draw || pct1(independentProbabilities.draw)) / 100,
    away: (probabilityModel.oneXTwo.final?.away || pct1(independentProbabilities.away)) / 100,
  };
  const hhadModelProbabilities = anchorIsHhad && probabilityModel.handicap?.poisson
    ? {
      home: Number(probabilityModel.handicap.poisson.home || 0) / 100,
      draw: Number(probabilityModel.handicap.poisson.draw || 0) / 100,
      away: Number(probabilityModel.handicap.poisson.away || 0) / 100,
    }
    : null;
  const modelProbabilities = hhadModelProbabilities || finalOneXTwoProbabilities;
  const homePickLabelZh = anchorIsHhad ? `让球主胜 ${match.homeTeam}` : `主胜 ${match.homeTeam}`;
  const drawPickLabelZh = anchorIsHhad ? "让球平" : "平局";
  const awayPickLabelZh = anchorIsHhad ? `让球客胜 ${match.awayTeam}` : `客胜 ${match.awayTeam}`;
  const homePickLabelEn = anchorIsHhad ? `Handicap Home Win (${match.homeTeam})` : `Home Win (${match.homeTeam})`;
  const drawPickLabelEn = anchorIsHhad ? "Handicap Draw" : "Draw";
  const awayPickLabelEn = anchorIsHhad ? `Handicap Away Win (${match.awayTeam})` : `Away Win (${match.awayTeam})`;
  const picks = [
    ["1", modelProbabilities.home, anchorOdds.odds1, homePickLabelZh, homePickLabelEn],
    ["X", modelProbabilities.draw, anchorOdds.oddsX, drawPickLabelZh, drawPickLabelEn],
    ["2", modelProbabilities.away, anchorOdds.odds2, awayPickLabelZh, awayPickLabelEn],
  ].sort((a, b) => b[1] - a[1]);
  const marketPicks = [
    ["1", probabilities.home, anchorOdds.odds1],
    ["X", probabilities.draw, anchorOdds.oddsX],
    ["2", probabilities.away, anchorOdds.odds2],
  ].sort((a, b) => b[1] - a[1]);
  const marketLeader = marketPicks[0];
  const marketSecond = marketPicks[1];
  const analystSelection = selectValueAwareOneXTwo(match, picks, modelProbabilities, probabilities, hhadProbabilities);
  const hasSelectionDisagreement = Boolean(analystSelection.isContrarian || analystSelection.hasValueDisagreement);
  const best1x2 = analystSelection.pick;
  score = representativeProjectedScore(homeLambda, awayLambda, anchorIsHhad ? null : best1x2[0], {
    over25Probability,
    bttsProbability,
  });
  const probabilityGap = marketLeader[1] - marketSecond[1];
  const modelProbabilityGap = Math.max(0, picks[0][1] - picks[1][1]);
  const selectedMarketProbability = outcomeProbabilityForCode(probabilities, best1x2[0]) || 0;
  const selectionDiscount = Math.max(0, marketLeader[1] - selectedMarketProbability);
  const candidateHandicapSupport = hhadSupportForPick(hhadProbabilities, best1x2[0]);
  const candidateIsLowOddsFavorite = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.55;
  const candidateIsOverheated = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.35;
  const candidateHasWeakHandicap = ["1", "2"].includes(best1x2[0])
    && candidateHandicapSupport !== null
    && candidateHandicapSupport < 0.42;
  const dynamicGate = profileCalibration(match).gate || {};
  const oneXTwoStrategyGate = strategyGateForPrediction(match, anchorMarketType, best1x2[0], predictionOddsBucket(best1x2[2]));
  const rawTrust = hasSelectionDisagreement
    ? clamp(Math.round(best1x2[1] * 100 + 31 - selectionDiscount * 42), 54, 76)
    : clamp(Math.round(best1x2[1] * 100 + modelProbabilityGap * 48 + 10), 52, 93);
  const trustPenalty =
    (candidateIsOverheated ? 11 : candidateIsLowOddsFavorite ? 5 : 0)
    + (candidateHasWeakHandicap ? 9 : 0)
    + (probabilities.draw >= 0.28 ? 4 : 0)
    + (bttsProbability >= 0.45 && bttsProbability < 0.65 ? 3 : 0)
    + Number(dynamicGate.trustPenalty || 0)
    + Number(oneXTwoStrategyGate.trustPenalty || 0);
  const baseTrust = clamp(
    rawTrust - trustPenalty,
    hasSelectionDisagreement ? 50 : 48,
    candidateIsOverheated || candidateHasWeakHandicap ? 82 : 91
  );
  const probabilityTextZh = `主胜 ${pct(probabilities.home)}% / 平局 ${pct(probabilities.draw)}% / 客胜 ${pct(probabilities.away)}%`;
  const probabilityTextEn = `home ${pct(probabilities.home)}% / draw ${pct(probabilities.draw)}% / away ${pct(probabilities.away)}%`;
  const oddsText = `${anchorOdds.odds1.toFixed(2)} / ${anchorOdds.oddsX.toFixed(2)} / ${anchorOdds.odds2.toFixed(2)}`;
  const sourceUpdatedAt = anchorIsHhad ? match.handicapOddsUpdatedAt : match.oddsUpdatedAt;
  const sourceTextZh = sourceUpdatedAt
    ? `${anchorLabelZh} SP 更新时间：${sourceUpdatedAt}`
    : `${anchorLabelZh} SP 来自${anchorSourceInfo.snapshotZh}`;
  const sourceTextEn = sourceUpdatedAt
    ? `${anchorLabelEn} SP updated at ${sourceUpdatedAt}`
    : `${anchorLabelEn} SP came from ${anchorSourceInfo.snapshotEn}`;
  const drawRiskZh = probabilities.draw >= 0.28
    ? "平局支持率偏高，胜平负方向需要防平。"
    : "平局支持率未明显压低主方向，但仍需留意赛前 SP 变化。";
  const drawRiskEn = probabilities.draw >= 0.28
    ? "Draw support is high, so cover the draw risk."
    : "Draw support is not dominant, but late SP movement still matters.";
  const volatilityProfile = matchVolatilityProfile(match);
  const riskTags = [];
  const candidateValueProfile = analystSelection.valueProfile || pickValueProfile(best1x2, modelProbabilities, probabilities);
  const candidateProbabilityEdge = Number(candidateValueProfile?.probabilityEdge);
  const candidateExpectedValue = Number(candidateValueProfile?.expectedValue);

  if (!anchorSourceInfo.isOfficial) {
    riskTags.push({ zh: "非官方参考源", en: "Non-official reference" });
  }

  if (Number.isFinite(candidateProbabilityEdge) && candidateProbabilityEdge < 0.015) {
    riskTags.push({ zh: "价值边际不足", en: "No value edge" });
  }
  if (Number.isFinite(candidateExpectedValue) && candidateExpectedValue < 0.01) {
    riskTags.push({ zh: "EV不足", en: "Flat expected value" });
  }

  if (probabilities.draw >= 0.28) {
    riskTags.push({ zh: "防平", en: "Draw risk" });
  }
  if (best1x2[2] <= 1.25) {
    riskTags.push({ zh: "热门过热", en: "Heavy favorite" });
  }
  if (volatilityProfile.isInternational && ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.35) {
    riskTags.push({ zh: "国际赛低赔", en: "International low-SP favorite" });
  }
  if (probabilityGap < 0.12) {
    riskTags.push({ zh: "胜负接近", en: "Tight 1X2" });
  }
  if (hhadProbabilities && best1x2[0] === "1" && hhadProbabilities.home < 0.42) {
    riskTags.push({ zh: "让球支持不足", en: "Handicap support weak" });
  }
  if (hhadProbabilities && best1x2[0] === "2" && hhadProbabilities.away < 0.42) {
    riskTags.push({ zh: "让球支持不足", en: "Handicap support weak" });
  }
  if (bttsProbability >= 0.45 && bttsProbability < 0.65) {
    riskTags.push({ zh: "进球临界", en: "Goal-model borderline" });
  }
  if (hasSelectionDisagreement) {
    riskTags.push({ zh: "盘口分歧", en: "Market disagreement" });
  }

  const oneXTwoGate = evaluateOneXTwoGate({
    match,
    pick: best1x2,
    probabilities,
    modelProbabilities,
    hhadProbabilities,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth: match.predictionHealth,
    marketType: anchorMarketType,
  });
  const anchorGatePromote = false;
  const oneXTwoPromote = !anchorIsHhad && (oneXTwoGate.promote || anchorGatePromote);
  const oneXTwoWatchLabel = {
    zh: anchorIsHhad ? "观察为主 让球盘不强推" : "\u89c2\u5bdf\u4e3a\u4e3b \u80dc\u5e73\u8d1f\u4e0d\u5f3a\u63a8",
    en: anchorIsHhad ? "Watch first: no HHAD pick" : "Watch first: no 1X2 pick",
  };
  const oneXTwoHealthCooldown = Boolean(
    !anchorIsHhad
    && (
      isCoolingBucket(match.predictionHealth?.byMarket?.["1X2"])
      || isCoolingBucket(match.predictionHealth?.homeFavorite)
    )
  );
  const oneXTwoMarketHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.byMarket?.["1X2"], 8, 0.42);
  const bestMarketHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.byMarket?.BEST, 5, 0.45);
  const homeFavoriteHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.homeFavorite, 6, 0.42);
  const healthCooldownTag = oneXTwoHealthCooldown
    ? [{ zh: "\u8fd1\u671f\u547d\u4e2d\u7387\u51b7\u5374", en: "Recent hit-rate cooldown" }]
    : [];
  const oneXTwoRiskTags = oneXTwoPromote
    ? riskTags
    : [
        ...riskTags,
        ...healthCooldownTag,
        { zh: "条件未齐", en: "Conditions not aligned" },
      ];
  const oneXTwoTrust = oneXTwoGate.promote
    ? baseTrust
    : oneXTwoPromote
      ? clamp(baseTrust - 6, 46, 72)
      : clamp(baseTrust - (oneXTwoMarketHardCooldown ? 26 : 18), 34, 62);
  const oneXTwoGateZh = anchorIsHhad
    ? `参考理由：普通胜平负未开售，本场按独立 Poisson 让球概率给参考方向；模型优势约 ${pct(modelProbabilityGap)} 个百分点，盘口仅作校验，条件未完全闭合时不强推单一让球方向。`
    : `参考理由：独立模型优势约 ${pct(modelProbabilityGap)} 个百分点，市场分歧约 ${pct(probabilityGap)} 个百分点，让球同向支持${oneXTwoGate.handicapSupport === null ? "不足" : `约 ${pct(oneXTwoGate.handicapSupport)}%`}；条件没有同时闭合，暂不输出单一胜平负方向。`;
  const oneXTwoGateEn = anchorIsHhad
    ? `Watch reason: standard 1X2 is not open, so the reference direction comes from independent Poisson handicap probabilities. Model edge is about ${pct(modelProbabilityGap)} points; the board is only a validation layer.`
    : `Watch reason: independent model edge is about ${pct(modelProbabilityGap)} points, market disagreement about ${pct(probabilityGap)} points, same-side handicap support ${oneXTwoGate.handicapSupport === null ? "unavailable" : `about ${pct(oneXTwoGate.handicapSupport)}%`}; no single 1X2 pick is promoted.`;
  const modelLean = {
    tipCode: best1x2[0],
    tipLabel: { zh: best1x2[3], en: best1x2[4] },
    odds: best1x2[2],
    trustScore: baseTrust,
    resultStatus: resultStatus(match, best1x2[0], anchorMarketType),
  };
  const oneXTwoReferenceLabel = {
    zh: `\u53c2\u8003\u503e\u5411 ${modelLean.tipLabel.zh}`,
    en: `Reference lean: ${modelLean.tipLabel.en}`,
  };

  const oneXTwo = {
    marketType: "1X2",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: modelLean.tipCode,
    tipLabel: oneXTwoPromote ? modelLean.tipLabel : oneXTwoReferenceLabel,
    odds: modelLean.odds,
    trustScore: oneXTwoTrust,
    recommendationAction: oneXTwoPromote ? "recommend" : "reference",
    recommendationTier: oneXTwoPromote ? oneXTwoGate.tier : "reference",
    explanation: {
      zh: oneXTwoPromote
        ? `本场先由独立模型给出${best1x2[3]}方向；${anchorLabelZh} SP 只用于校验市场分歧、价值差和风险标签，不作为预测主轴。`
        : `${anchorLabelZh}条件未齐：低赔、平局压力、让球确认或风险标签存在不一致，只保留为参考推荐。`,
      en: oneXTwoPromote
        ? `This pick comes from the independent model as ${best1x2[4]}. ${anchorLabelEn} odds are used only for market disagreement, value gap, and risk tags.`
        : `Reference lean: ${modelLean.tipLabel.en}. This ${anchorIsHhad ? "HHAD" : "1X2"} market did not pass the strong recommendation gate, so the direction is shown for user judgement only.`,
    },
    analysisItems: [
      {
        zh: `${anchorLabelZh} SP：${anchorIsHhad ? "让球主胜" : "主胜"} ${anchorOdds.odds1.toFixed(2)} / ${anchorIsHhad ? "让球平" : "平局"} ${anchorOdds.oddsX.toFixed(2)} / ${anchorIsHhad ? "让球客胜" : "客胜"} ${anchorOdds.odds2.toFixed(2)}；去水支持率约 ${probabilityTextZh}。`,
        en: `${anchorLabelEn} SP: ${oddsText}; normalized support is about ${probabilityTextEn}.`,
      },
      {
        zh: !oneXTwoPromote
          ? oneXTwoGateZh
          : analystSelection.isContrarian
          ? `${analystSelection.reason.zh} 当前模型可信度 ${baseTrust}%，该方向属于价值观察而非高确定性推荐。`
          : `独立模型差距：第一方向领先第二方向约 ${pct(modelProbabilityGap)} 个百分点；市场差距仅作校验，当前模型可信度 ${baseTrust}%。`,
        en: !oneXTwoPromote
          ? oneXTwoGateEn
          : analystSelection.isContrarian
          ? `${analystSelection.reason.en} Model confidence is ${baseTrust}%; this is a value-watch, not a high-certainty banker.`
          : `Independent model separation: the top direction leads by about ${pct(modelProbabilityGap)} percentage points; market separation is validation only. Model confidence: ${baseTrust}%.`,
      },
      {
        zh: `${drawRiskZh} ${sourceTextZh}。`,
        en: `${drawRiskEn} ${sourceTextEn}.`,
      },
    ],
    riskTags: oneXTwoRiskTags,
    visibilityStatus: "FREE",
    resultStatus: modelLean.resultStatus,
  };

  const goalsGate = evaluateGoalsGate(match, goalsTip, goalsProbability, over25Probability, bttsProbability, match.predictionHealth);
  const goalsWatchLabel = {
    zh: "观察为主 进球数不强推",
    en: "Watch first: no total-goals pick",
  };
  const goalsReferenceLabel = {
    zh: `\u8fdb\u7403\u53c2\u8003 ${goalsTipLabel.zh}`,
    en: `Goals reference: ${goalsTipLabel.en}`,
  };
  const goalsRiskTags = goalsGate.promote
    ? riskTags.filter((tag) => tag.en === "Goal-model borderline")
    : [
        ...riskTags.filter((tag) => tag.en === "Goal-model borderline"),
        ...(isCoolingBucket(match.predictionHealth?.byMarket?.GOALS) ? [{ zh: "进球命中率冷却", en: "Goals hit-rate cooldown" }] : []),
        { zh: "进球条件未齐", en: "Goals conditions not aligned" },
      ];

  const goals = {
    marketType: "GOALS",
    tipCode: goalsTip,
    tipLabel: goalsGate.promote ? goalsTipLabel : goalsReferenceLabel,
    odds: goalsOdds,
    trustScore: goalsGate.promote
      ? clamp(Math.round(goalsProbability * 100 + 12), 50, 78)
      : clamp(Math.round(goalsProbability * 100 - 2), 42, 58),
    recommendationAction: goalsGate.promote ? "recommend" : "reference",
    recommendationTier: goalsGate.promote ? "goals" : "reference",
    explanation: {
      zh: goalsGate.promote
        ? `进球趋势为模型参考项，基于胜平负 SP 反推出主队 ${homeLambda.toFixed(2)}、客队 ${awayLambda.toFixed(2)} 的预期进球，当前总进球期望约 ${totalLambda.toFixed(2)}。`
        : `进球趋势条件未齐：总进球期望约 ${totalLambda.toFixed(2)}，大 2.5 概率约 ${pct(over25Probability)}%，边际不足时不强行给大/小球方向。`,
      en: goalsGate.promote
        ? `The goals trend derives expected goals from 1X2 odds: home ${homeLambda.toFixed(2)}, away ${awayLambda.toFixed(2)}, total ${totalLambda.toFixed(2)}.`
        : `The goals trend did not pass the recommendation gate. Total expected goals are about ${totalLambda.toFixed(2)}, over 2.5 probability about ${pct(over25Probability)}%, so no over/under pick is promoted.`,
    },
    analysisItems: [
      {
        zh: goalsGate.promote
          ? `比分热区：${score.home}-${score.away} 附近；${goalsTipLabel.zh} 的模型概率约 ${pct(goalsProbability)}%。`
          : `比分热区：${score.home}-${score.away} 附近；候选方向 ${goalsTipLabel.zh} 的模型概率约 ${pct(goalsProbability)}%，低于强推阈值。`,
        en: goalsGate.promote
          ? `Score heat zone: around ${score.home}-${score.away}; model probability for ${goalsTipLabel.en} is about ${pct(goalsProbability)}%.`
          : `Score heat zone: around ${score.home}-${score.away}; candidate ${goalsTipLabel.en} is about ${pct(goalsProbability)}%, below the promotion threshold.`,
      },
      {
        zh: `大 2.5 球概率约 ${pct(over25Probability)}%，该指标用于走势参考，不等同于官方总进球 SP。`,
        en: `Over 2.5 probability is about ${pct(over25Probability)}%. This is a model reference, not official Sporttery total-goals SP.`,
      },
    ],
    riskTags: goalsRiskTags,
    visibilityStatus: goalsGate.promote ? "PREMIUM" : "FREE",
    resultStatus: resultStatus(match, goalsTip, "GOALS"),
  };

  const bestIsSteady = oneXTwoPromote
    && !hasSelectionDisagreement
    && best1x2[1] >= 0.58
    && modelProbabilityGap >= 0.18
    && baseTrust >= 84
    && riskTags.length === 0;
  const bestHandicapSupport = hhadSupportForPick(hhadProbabilities, modelLean.tipCode);
  const bestHasWeakHandicap = ["1", "2"].includes(modelLean.tipCode)
    && bestHandicapSupport !== null
    && bestHandicapSupport < 0.3;
  const bestHasThinEdge = !hasSelectionDisagreement && (modelProbabilityGap < 0.18 || best1x2[1] < 0.62);
  const bestHasOverheatedFavorite = ["1", "2"].includes(modelLean.tipCode)
    && modelLean.odds <= 1.7
    && (bestHandicapSupport === null || bestHandicapSupport < 0.3 || riskTags.length >= 4);
  const severeRiskCountForBest = riskTags.filter((tag) => (
    !hasSelectionDisagreement
    || !["Draw risk", "Tight 1X2", "Market disagreement"].includes(tag.en)
  )).length;
  const bestHasSevereRisk = severeRiskCountForBest >= 4
    || (bestHasWeakHandicap && modelLean.odds <= 1.7)
    || (!hasSelectionDisagreement && modelProbabilityGap < 0.06 && best1x2[1] < 0.52);
  const bestLaneHardCooldown = Boolean(
    bestMarketHardCooldown
    || oneXTwoMarketHardCooldown
    || (modelLean.tipCode === "1" && homeFavoriteHardCooldown)
  );
  const bestShouldWatch = !oneXTwoPromote
    || bestLaneHardCooldown
    || bestHasWeakHandicap
    || bestHasOverheatedFavorite
    || bestHasSevereRisk;
  const goalsCanCarryBest = bestShouldWatch
    && goalsGate.promote
    && goals.tipCode !== "WATCH"
    && goalsTip === "U2.5"
    && goals.trustScore >= 62
    && goals.riskTags.length <= 2;
  const bestPrefix = bestShouldWatch
    ? { zh: "观察为主", en: "Watch first" }
    : analystSelection.isContrarian
    ? { zh: "价值观察", en: "Value watch" }
    : bestIsSteady
      ? { zh: "稳妥方向", en: "Steady lean" }
      : { zh: "模型首选", en: "Model lean" };
  const watchUsefulnessScore = (() => {
    const leadProbability = Math.max(modelProbabilities.home, modelProbabilities.draw, modelProbabilities.away);
    const handicapBonus = bestHandicapSupport === null ? 0 : Math.min(10, bestHandicapSupport * 16);
    const edgeBonus = modelProbabilityGap * 42;
    const riskPenalty = riskTags.length * 6
      + (oneXTwoGate.reasons || []).filter((reason) => (
        reason.includes("cooldown")
        || reason.includes("weak")
        || reason.includes("thin")
        || reason.includes("risk")
      )).length * 3
      + (bestHasOverheatedFavorite ? 7 : 0)
      + (hasSelectionDisagreement ? 4 : 0);
    return clamp(Math.round(leadProbability * 100 + edgeBonus + handicapBonus - riskPenalty), 28, 68);
  })();
  const bestTrustScore = bestShouldWatch
    ? clamp(watchUsefulnessScore - (bestLaneHardCooldown ? 12 : 0), 22, 62)
    : hasSelectionDisagreement
    ? clamp(oneXTwo.trustScore, 54, 76)
    : bestIsSteady
      ? clamp(oneXTwo.trustScore + 2, 57, 96)
      : clamp(oneXTwo.trustScore - (bestHasThinEdge ? 2 : 0), 52, 82);
  const bestWatchLabelZh = !oneXTwoPromote
    ? "观察为主 条件未齐"
    : bestLaneHardCooldown
    ? "观察为主 命中冷却"
    : bestHasWeakHandicap
    ? "观察为主 防正路过热"
    : bestHasThinEdge
      ? "观察为主 胜平负差距小"
      : "观察为主 风险叠加";
  const bestWatchLabelEn = !oneXTwoPromote
    ? "Watch first: conditions not aligned"
    : bestLaneHardCooldown
    ? "Watch first: hit-rate cooldown"
    : bestHasWeakHandicap
    ? "Watch first: favorite overheated"
    : bestHasThinEdge
      ? "Watch first: thin 1X2 edge"
      : "Watch first: stacked risk";
  const bestNarrative = buildBestNarrative(match, {
    oneXTwo: modelLean,
    bestShouldWatch,
    analystSelection,
    bestIsSteady,
    bestHasWeakHandicap,
    bestHasThinEdge,
    riskTags,
    probabilityGap,
    modelProbabilityGap,
    bestHandicapSupport,
    totalLambda,
    over25Probability,
    bttsProbability,
    score,
    hhadProbabilities
  });

  const best = goalsCanCarryBest ? {
    marketType: "BEST",
    tipCode: goals.tipCode,
    tipLabel: {
      zh: `进球精选 ${goalsTipLabel.zh}`,
      en: `Goals pick: ${goalsTipLabel.en}`,
    },
    odds: goals.odds,
    trustScore: clamp(goals.trustScore, 62, 76),
    recommendationAction: "recommend",
    recommendationTier: "goals",
    explanation: {
      zh: `胜平负方向处于命中率冷却或盘口分歧中，本场 AI精选切到回测更稳的进球数方向：${goalsTipLabel.zh}。`,
      en: `The 1X2 side is under hit-rate cooldown or market disagreement, so the best tip switches to the better-tested totals lane: ${goalsTipLabel.en}.`,
    },
    analysisItems: [
      ...goals.analysisItems,
      {
        zh: "胜平负条件未齐，精选不强行追正路；仅在进球数边际和回测方向同时满足时输出。",
        en: "The 1X2 gate was not met, so the best tip does not chase the favourite. Totals are promoted only when edge and historical lane agree.",
      },
    ],
    riskTags: goals.riskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, goals.tipCode, "GOALS"),
  } : {
    marketType: "BEST",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: modelLean.tipCode,
    tipLabel: {
      zh: bestShouldWatch ? `\u53c2\u8003\u503e\u5411 ${modelLean.tipLabel.zh}` : `${bestPrefix.zh} ${modelLean.tipLabel.zh}`,
      en: bestShouldWatch ? `Reference lean: ${modelLean.tipLabel.en}` : `${bestPrefix.en}: ${modelLean.tipLabel.en}`,
    },
    odds: modelLean.odds,
    trustScore: bestTrustScore,
    recommendationAction: bestShouldWatch ? "reference" : "recommend",
    recommendationTier: bestShouldWatch ? "reference" : bestPrefix.en.toLowerCase().replace(/\s+/g, "-").replace(/:$/, ""),
    explanation: bestNarrative.explanation,
    analysisItems: bestNarrative.analysisItems,
    riskTags: bestShouldWatch
      ? [
          ...oneXTwoRiskTags,
          ...(bestLaneHardCooldown ? [{ zh: "精选赛道冷却", en: "Best-lane hit-rate cooldown" }] : []),
        ]
      : riskTags,
    visibilityStatus: "FREE",
    resultStatus: modelLean.resultStatus,
  };

  return { predictions: [oneXTwo, goals, best], homeLambda, awayLambda, projectedScore: score, probabilityModel };
}

function shouldBuildModelOnlyReference(match) {
  const kickoffMs = Date.parse(match?.kickoffTime);
  if (!Number.isFinite(kickoffMs)) return false;
  const now = Date.now();
  const forwardMs = (WINDOW_FORWARD_DAYS + 1) * 24 * 60 * 60 * 1000;
  const recentGraceMs = 3 * 60 * 60 * 1000;
  return (
    (!match?.source || match.source === "sporttery") &&
    match?.status === "SCHEDULED" &&
    kickoffMs >= now - recentGraceMs &&
    kickoffMs <= now + forwardMs
  );
}

function emptyPredictionSet() {
  return {
    predictions: [],
    homeLambda: 0,
    awayLambda: 0,
    projectedScore: undefined,
    probabilityModel: undefined,
  };
}

function toAppMatch(match) {
  const meta = leagueMeta(match.leagueName);
  const homeTeamId = `team_${hashString(match.homeTeam)}`;
  const awayTeamId = `team_${hashString(match.awayTeam)}`;
  const leagueId = `league_${hashString(match.leagueName)}`;
  const hasOfficialDisplayOdds = match.oddsSource === "sporttery:HAD" || match.handicapOddsSource === "sporttery:HHAD";
  const hasFiveHundredDisplayOdds = String(match.oddsSource || "").startsWith("500.com")
    || String(match.handicapOddsSource || "").startsWith("500.com");
  const appSource = !hasOfficialDisplayOdds && hasFiveHundredDisplayOdds
    ? "five-hundred"
    : match.source || (String(match.sourceMethod || "").startsWith("500") ? "five-hundred" : "sporttery");
  const odds = sanitizeOdds(match.odds);
  const handicapOdds = sanitizeOdds(match.handicapOdds);
  const hasPredictionModel = Boolean(odds || handicapOdds);
  const model = hasPredictionModel
    ? predictionSet({ ...match, odds, handicapOdds })
    : shouldBuildModelOnlyReference(match)
      ? predictionSetWithoutOfficialOdds({ ...match, odds: undefined, handicapOdds: undefined })
      : emptyPredictionSet();
  const scoreHome = Number.isFinite(match.scoreHome) ? match.scoreHome : undefined;
  const scoreAway = Number.isFinite(match.scoreAway) ? match.scoreAway : undefined;
  const rand = seeded(match.sourceMatchId);
  const possessionHome = 48 + Math.floor(rand() * 12);
  const homeLogo = teamLogoInfo(match.homeTeam, match.homeTeamCode, match.homeTeamLogo);
  const awayLogo = teamLogoInfo(match.awayTeam, match.awayTeamCode, match.awayTeamLogo);
  const kickoffDate = match.matchDate || String(match.kickoffTime || "").slice(0, 10);
  const businessDate = inferSportteryBusinessDate(match.matchNo, kickoffDate)
    || match.businessDate
    || kickoffDate;
  return {
    id: `${appSource === "five-hundred" ? "fivehundred" : "sporttery"}_${match.sourceMatchId}`,
    homeTeamId,
    awayTeamId,
    leagueId,
    countryId: meta.countryId,
    kickoffTime: match.kickoffTime,
    status: match.status,
    scoreHome,
    scoreAway,
    projectedScoreHome: model.projectedScore?.home,
    projectedScoreAway: model.projectedScore?.away,
    probabilityModel: model.probabilityModel,
    odds: odds || undefined,
    handicapOdds: handicapOdds || undefined,
    predictions: model.predictions,
    worldCupPrior: match.worldCupPrior || undefined,
    externalSignals: match.worldCupPrior
      ? { ...(match.externalSignals || {}), worldCupPrior: match.worldCupPrior }
      : match.externalSignals || undefined,
    ...(model.probabilityModel ? {
    stats: {
      xG: {
        home: Number((Number.isFinite(model.homeLambda) ? model.homeLambda : (scoreHome ?? 0)).toFixed(2)),
        away: Number((Number.isFinite(model.awayLambda) ? model.awayLambda : (scoreAway ?? 0)).toFixed(2)),
      },
      possession: { home: possessionHome, away: 100 - possessionHome },
      shots: { home: Math.floor(model.homeLambda * 6 + rand() * 4), away: Math.floor(model.awayLambda * 6 + rand() * 4) },
      shotsOnTarget: { home: Math.floor(model.homeLambda * 2 + rand() * 3), away: Math.floor(model.awayLambda * 2 + rand() * 3) },
      corners: { home: 3 + Math.floor(rand() * 5), away: 2 + Math.floor(rand() * 5) },
      fouls: { home: 8 + Math.floor(rand() * 8), away: 8 + Math.floor(rand() * 8) },
      offsides: { home: Math.floor(rand() * 4), away: Math.floor(rand() * 4) },
      yellowCards: { home: Math.floor(rand() * 4), away: Math.floor(rand() * 4) },
      redCards: { home: 0, away: 0 },
    },
    } : {}),
    matchDate: kickoffDate,
    kickoffDate,
    businessDate,
    buyEndTime: match.buyEndTime || match.externalSignals?.buyEndTime || match.externalSignals?.fiveHundred?.sale?.buyEndTime,
    homeTeamName: match.homeTeam,
    homeTeamNameEn: match.homeTeam,
    homeRank: match.homeRank,
    homeTeamLogo: homeLogo.logo,
    homeTeamLogoType: homeLogo.logoType,
    homeTeamCountryIso: homeLogo.countryIso,
    homeTeamColor: colorFromName(match.homeTeam),
    awayTeamName: match.awayTeam,
    awayTeamNameEn: match.awayTeam,
    awayRank: match.awayRank,
    awayTeamLogo: awayLogo.logo,
    awayTeamLogoType: awayLogo.logoType,
    awayTeamCountryIso: awayLogo.countryIso,
    awayTeamColor: colorFromName(match.awayTeam),
    leagueName: match.leagueName,
    leagueNameEn: meta.leagueNameEn,
    leagueShortName: meta.leagueShortName,
    leagueShortNameEn: meta.leagueNameEn.slice(0, 12),
    countryName: meta.countryName,
    countryNameEn: meta.countryNameEn,
    countryFlag: meta.countryFlag,
    source: appSource,
    sourceMethod: match.sourceMethod,
    sourceUrl: match.sourceUrl,
    sourceMatchId: match.sourceMatchId,
    matchNo: match.matchNo,
    oddsSource: match.oddsSource,
    oddsPoolCode: match.oddsPoolCode,
    oddsSourceMethod: match.oddsSourceMethod,
    oddsUpdatedAt: match.oddsUpdatedAt,
    oddsSourceUrl: match.oddsSourceUrl,
    handicapLine: match.handicapLine,
    handicapOddsSource: match.handicapOddsSource,
    handicapOddsPoolCode: match.handicapOddsPoolCode,
    handicapOddsSourceMethod: match.handicapOddsSourceMethod,
    handicapOddsUpdatedAt: match.handicapOddsUpdatedAt,
    handicapOddsSourceUrl: match.handicapOddsSourceUrl,
  };
}

function modelStrategySummary(modelCalibration) {
  return modelCalibration?.strategy ? {
    version: modelCalibration.strategy.version,
    generatedAt: modelCalibration.strategy.generatedAt,
    onlineEffect: modelCalibration.strategy.activation?.onlineEffect || "unknown",
    activeGates: modelCalibration.strategy.activeGates || null,
  } : null;
}

function attachCalibrationMetadataToAppMatch(match, modelCalibration) {
  if (!match?.probabilityModel || !modelCalibration) return match;
  const profileKey = predictionProfileKey(match);
  return {
    ...match,
    probabilityModel: {
      ...match.probabilityModel,
      dynamicCalibration: {
        ...(match.probabilityModel.dynamicCalibration || {}),
        version: modelCalibration.version,
        profileKey,
        gate: modelCalibration.gateByProfile?.[profileKey] || match.probabilityModel.dynamicCalibration?.gate || null,
        metrics: modelCalibration.metrics || match.probabilityModel.dynamicCalibration?.metrics || null,
        strategy: modelStrategySummary(modelCalibration),
      },
    },
  };
}

function kickoffHasStarted(match, capturedAt) {
  const kickoffAt = Date.parse(match?.kickoffTime);
  const capturedTime = Date.parse(capturedAt);
  return Number.isFinite(kickoffAt) && Number.isFinite(capturedTime) && capturedTime >= kickoffAt;
}

function parseBeijingDateTime(value) {
  const raw = normText(value);
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    return Date.parse(`${raw.replace(/\s+/, "T")}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(`${raw}+08:00`);
  }
  return Date.parse(raw);
}

function matchCutoffValue(match) {
  return match?.buyEndTime
    || match?.externalSignals?.buyEndTime
    || match?.externalSignals?.fiveHundred?.sale?.buyEndTime
    || match?.kickoffTime
    || "";
}

function cutoffHasPassed(match, capturedAt) {
  const cutoffAt = parseBeijingDateTime(matchCutoffValue(match));
  const capturedTime = Date.parse(capturedAt);
  return Number.isFinite(cutoffAt) && Number.isFinite(capturedTime) && capturedTime >= cutoffAt;
}

function predictionSignature(predictions) {
  const byMarket = new Map((predictions || []).map((prediction) => [prediction.marketType, prediction]));
  return ["1X2", "BEST", "GOALS"]
    .map((marketType) => {
      const prediction = byMarket.get(marketType);
      return prediction ? `${marketType}:${prediction.oddsPoolCode || ""}:${prediction.tipCode}:${prediction.recommendationAction || "recommend"}` : `${marketType}:-`;
    })
    .join("|");
}

function marketSignalSignatureForMatch(match) {
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeOdds(match?.handicapOdds);
  const oddsSignature = odds
    ? `${odds.odds1.toFixed(2)}/${odds.oddsX.toFixed(2)}/${odds.odds2.toFixed(2)}`
    : "--";
  const hhadSignature = handicapOdds
    ? `${match?.handicapLine || ""}:${handicapOdds.odds1.toFixed(2)}/${handicapOdds.oddsX.toFixed(2)}/${handicapOdds.odds2.toFixed(2)}`
    : "--";
  return `${oddsSignature}|${hhadSignature}`;
}

function resultMarketForPrediction(prediction) {
  if (prediction?.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(prediction.tipCode)) {
    return prediction.marketType === "BEST" ? "BEST_HHAD" : "HHAD";
  }
  return prediction?.marketType || "";
}

function settlePredictionsForMatch(match, predictions) {
  return (predictions || []).map((prediction) => ({
    ...prediction,
    resultStatus: prediction.marketType === "BEST" && prediction.tipCode === "WATCH"
      ? "PENDING"
      : resultStatus(match, prediction.tipCode, resultMarketForPrediction(prediction)),
  }));
}

function predictionContentLocked(match, capturedAt = new Date().toISOString()) {
  const reason = normText(match?.predictionMeta?.lockedReason);
  return Boolean(
    match?.predictionMeta?.lockedAt
    || reason
    || match?.status === "LIVE"
    || match?.status === "PENDING_RESULT"
    || match?.status === "FINISHED"
    || kickoffHasStarted(match, capturedAt)
    || cutoffHasPassed(match, capturedAt)
  );
}

const LOCKED_PREDICTION_CONTENT_FIELDS = Object.freeze([
  "probabilityModel",
  "projectedScoreHome",
  "projectedScoreAway",
  "stats",
  "gptPrediction",
  "odds",
  "oddsSource",
  "oddsPoolCode",
  "oddsSourceMethod",
  "oddsUpdatedAt",
  "oddsSourceUrl",
  "handicapOdds",
  "handicapLine",
  "handicapOddsSource",
  "handicapOddsPoolCode",
  "handicapOddsSourceMethod",
  "handicapOddsUpdatedAt",
  "handicapOddsSourceUrl",
  "oddsTrend",
]);

const LOCKED_PUBLISHED_IDENTITY_FIELDS = Object.freeze([
  "id",
  "source",
  "sourceMethod",
  "sourceUrl",
  "sourceMatchId",
]);

function pickDefinedFields(source, keys) {
  const picked = {};
  if (!source) return picked;
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

const LOCKED_PREDICTION_UPDATE_REASON = Object.freeze({
  zh: "竞彩截止或开赛后，历史预测已冻结；后续同步只更新赛果和命中结算，不重算推荐、概率和预测比分。",
  en: "After Sporttery cutoff or kickoff, the historical forecast is frozen; later syncs only settle results and never recalculate picks, probabilities, or projected score.",
});

const NO_PRE_CUTOFF_PREDICTION_REASON = Object.freeze({
  zh: "\u7ade\u5f69\u622a\u6b62\u6216\u5f00\u8d5b\u524d\u6ca1\u6709\u53ef\u7528\u7684\u5386\u53f2\u9884\u6d4b\u5feb\u7167\uff1b\u4e0d\u5728\u622a\u6b62\u540e\u8865\u751f\u65b0\u63a8\u8350\uff0c\u53ea\u4fdd\u7559\u8d5b\u7a0b\u4e0e\u7ed3\u679c\u4fe1\u606f\u3002",
  en: "No usable pre-cutoff prediction snapshot exists; no new recommendation is backfilled after cutoff or kickoff, and only schedule/result data is kept.",
});

const MARKET_UNCHANGED_PREDICTION_UPDATE_REASON = Object.freeze({
  zh: "\u5b98\u65b9 SP \u6216\u8ba9\u7403\u76d8\u6ca1\u6709\u5b9e\u8d28\u53d8\u5316\uff0c\u539f\u8d5b\u524d\u65b9\u5411\u7ee7\u7eed\u4fdd\u7559\uff1b\u5206\u6790\u7248\u672c\u53ef\u66f4\u65b0\uff0c\u4f46\u4e0d\u91cd\u7b97\u63a8\u8350\u65b9\u5411\u3002",
  en: "Official SP and handicap signals did not materially change, so the pre-match direction is preserved; analysis versions may update, but the recommendation direction is not recalculated.",
});

function preserveLockedPredictionContent(next, existing, force = false) {
  if (!existing || (!force && !predictionContentLocked(existing))) return next;
  const existingPredictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const settledPredictions = existingPredictions.length && next?.status === "FINISHED"
    ? settlePredictionsForMatch(next, existingPredictions)
    : existingPredictions;
  const nextWithoutPredictionContent = { ...(next || {}) };
  delete nextWithoutPredictionContent.predictions;
  for (const key of LOCKED_PREDICTION_CONTENT_FIELDS) {
    delete nextWithoutPredictionContent[key];
  }
  const identityFields = shouldPreferPublishedIdentity(existing, next)
    ? pickDefinedFields(existing, LOCKED_PUBLISHED_IDENTITY_FIELDS)
    : {};
  return {
    ...nextWithoutPredictionContent,
    ...identityFields,
    ...pickDefinedFields(existing, LOCKED_PREDICTION_CONTENT_FIELDS),
    predictions: settledPredictions,
    predictionMeta: {
      ...(existing.predictionMeta || next.predictionMeta || {}),
      lockedAt: existing.predictionMeta?.lockedAt || next.predictionMeta?.lockedAt,
      lockedReason: existing.predictionMeta?.lockedReason || next.predictionMeta?.lockedReason,
      cutoffTime: existing.predictionMeta?.cutoffTime || next.predictionMeta?.cutoffTime,
      updateReason: LOCKED_PREDICTION_UPDATE_REASON,
    },
  };
}

function enabledPredictions(predictions) {
  return (predictions || []).filter((prediction) => prediction.marketType !== "GG_NG");
}

function applyPredictionPersistence(match, existing, capturedAt) {
  const existingPredictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const nextPredictions = enabledPredictions(Array.isArray(match?.predictions) ? match.predictions : []);
  const started = kickoffHasStarted(match, capturedAt) || match.status === "LIVE" || match.status === "FINISHED";
  const cutoffPassed = cutoffHasPassed(match, capturedAt);
  const locked = started || cutoffPassed;
  const cutoffTime = matchCutoffValue(match) || undefined;
  const lockedReason = cutoffPassed ? "cutoff" : started ? "kickoff" : undefined;
  const strategyVersion = match?.probabilityModel?.dynamicCalibration?.strategy?.version || "none";
  const trainingVersion = match?.probabilityModel?.leaguePrior?.trainingVersion
    || match?.probabilityModel?.form?.historicalSource?.version
    || match?.probabilityModel?.elo?.historicalSource?.version
    || "none";
  const trainingSource = match?.probabilityModel?.form?.historicalSource?.source
    || match?.probabilityModel?.elo?.historicalSource?.source
    || match?.probabilityModel?.leaguePrior?.source
    || "none";
  const trainingSignature = match?.probabilityModel?.leaguePrior?.trainingSignature
    || match?.probabilityModel?.form?.historicalSource?.signature
    || match?.probabilityModel?.elo?.historicalSource?.signature
    || trainingVersion;
  const worldCupPriorSignature = match?.probabilityModel?.worldCupPrior?.signature || null;
  const dataSignature = [trainingSignature, worldCupPriorSignature].filter(Boolean).join("|") || trainingVersion;
  const generatedMeta = {
    policyVersion: PREDICTION_POLICY_VERSION,
    promptVersion: ANALYST_PROMPT_VERSION,
    strategyVersion,
    trainingVersion,
    trainingSource,
    trainingSignature: dataSignature,
    worldCupPriorSignature,
    generatedAt: existing?.predictionMeta?.generatedAt || capturedAt,
    updatedAt: capturedAt,
    lockedAt: locked ? (existing?.predictionMeta?.lockedAt || capturedAt) : undefined,
    lockedReason,
    cutoffTime,
    dataPolicy: PREDICTION_DATA_POLICY,
    analystRuntime: ANALYST_RUNTIME,
    analystFramework: PREDICTION_ANALYST_FRAMEWORK,
  };

  if (isOfficialResultMatch(match) && !hasOfficialDisplayOdds(match)) {
    const { stats, probabilityModel, projectedScoreHome, projectedScoreAway, ...rest } = match;
    void stats;
    void probabilityModel;
    void projectedScoreHome;
    void projectedScoreAway;
    return {
      ...rest,
      predictions: [],
      predictionMeta: generatedMeta,
    };
  }

  if (locked && existingPredictions.length) {
    const lockedMatch = preserveLockedPredictionContent({
      ...match,
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        lockedAt: existing?.predictionMeta?.lockedAt || capturedAt,
        lockedReason: lockedReason === "cutoff" ? "cutoff" : (existing?.predictionMeta?.lockedReason || lockedReason),
        cutoffTime: existing?.predictionMeta?.cutoffTime || cutoffTime,
        updateReason: LOCKED_PREDICTION_UPDATE_REASON,
      },
    }, existing, true);
    return {
      ...lockedMatch,
      predictions: started ? settlePredictionsForMatch(match, existingPredictions) : existingPredictions,
    };
  }

  if (locked) {
    const {
      predictions,
      probabilityModel,
      projectedScoreHome,
      projectedScoreAway,
      stats,
      ...matchWithoutPredictionContent
    } = match;
    void predictions;
    void probabilityModel;
    void projectedScoreHome;
    void projectedScoreAway;
    void stats;
    return {
      ...matchWithoutPredictionContent,
      predictions: [],
      ...(existing?.probabilityModel ? { probabilityModel: existing.probabilityModel } : {}),
      ...(existing?.projectedScoreHome !== undefined ? { projectedScoreHome: existing.projectedScoreHome } : {}),
      ...(existing?.projectedScoreAway !== undefined ? { projectedScoreAway: existing.projectedScoreAway } : {}),
      ...(existing?.stats ? { stats: existing.stats } : {}),
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        lockedAt: existing?.predictionMeta?.lockedAt || capturedAt,
        lockedReason,
        cutoffTime: existing?.predictionMeta?.cutoffTime || cutoffTime,
        updateReason: NO_PRE_CUTOFF_PREDICTION_REASON,
      },
    };
  }

  if (!existingPredictions.length || !nextPredictions.length) {
    return { ...match, predictionMeta: generatedMeta };
  }

  const sameDirection = predictionSignature(existingPredictions) === predictionSignature(nextPredictions);
  const sameMarketSignals = marketSignalSignatureForMatch(existing || {}) === marketSignalSignatureForMatch(match || {});
  const existingProbabilityStrategyVersion = existing?.probabilityModel?.dynamicCalibration?.strategy?.version || "none";
  const policyChanged = existing?.predictionMeta?.policyVersion !== PREDICTION_POLICY_VERSION
    || existing?.predictionMeta?.promptVersion !== ANALYST_PROMPT_VERSION
    || (existing?.predictionMeta?.strategyVersion || "none") !== strategyVersion
    || existingProbabilityStrategyVersion !== strategyVersion
    || (existing?.predictionMeta?.trainingSignature || existing?.predictionMeta?.trainingVersion || "none") !== (dataSignature || "none");

  if (sameMarketSignals && !policyChanged) {
    return {
      ...match,
      predictions: existingPredictions,
      projectedScoreHome: existing?.projectedScoreHome ?? match.projectedScoreHome,
      projectedScoreAway: existing?.projectedScoreAway ?? match.projectedScoreAway,
      stats: existing?.stats || match.stats,
      probabilityModel: existing?.probabilityModel || match.probabilityModel,
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        updatedAt: capturedAt,
        dataPolicy: PREDICTION_DATA_POLICY,
        analystRuntime: ANALYST_RUNTIME,
        analystFramework: PREDICTION_ANALYST_FRAMEWORK,
        updateReason: MARKET_UNCHANGED_PREDICTION_UPDATE_REASON,
      },
    };
  }

  if (sameDirection && policyChanged) {
    return {
      ...match,
      predictionMeta: {
        ...generatedMeta,
        updateReason: {
          zh: "提示词与展示规则已升级，赛前方向未发生实质变化；保留原预测，只更新分析说明。",
          en: "Prompt and display rules were upgraded while the pre-match direction did not materially change; the old forecast is kept and only the analysis text is refreshed.",
        },
      },
    };
  }

  return {
    ...match,
    predictionMeta: {
      ...generatedMeta,
      updateReason: {
        zh: "赛前赔率或让球信号发生实质变化，已生成新的临场预测；开赛后将锁定这版记录。",
        en: "Pre-match odds or handicap signals changed materially, so a new late forecast was generated and will be locked after kickoff.",
      },
    },
  };
}

async function fetchSportteryMatches() {
  if (process.env.SKIP_SPORTTERY_FETCH === "1") {
    console.log("Sporttery fetch skipped by SKIP_SPORTTERY_FETCH=1; using existing store and external signals.");
    return [];
  }

  const lists = [];
  const current = await fetchCurrentMatches();
  if (current.length) lists.push(current);

  const results = await Promise.allSettled(METHODS.map((method) => fetchMethodMatches(method)));
  results.forEach((result, idx) => {
    if (result.status === "fulfilled" && result.value.length) {
      lists.push(result.value);
    } else if (result.status === "rejected") {
      console.log(`Sporttery ${METHODS[idx]} failed: ${result.reason?.message || result.reason}`);
    }
  });

  return dedupeMatches(lists.flat());
}

function readJsonArray(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadExistingMatches() {
  const publicDir = path.join(__dirname, "..", "public");
  const files = [
    path.join(publicDir, "matches.json"),
    path.join(publicDir, "data", "matches-current.json"),
    path.join(publicDir, "data", "matches-history.json"),
  ];
  const byId = new Map();
  for (const file of files) {
    for (const match of readJsonArray(file)) {
      const key = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
      if (!key) continue;
      const existing = byId.get(key);
      if (!existing || shouldPreferPublishedIdentity(match, existing)) byId.set(key, match);
    }
  }
  return Array.from(byId.values());
}

function publishedIdentityRank(match) {
  let rank = 0;
  if (String(match?.id || "").startsWith("sporttery_")) rank += 8;
  if (match?.source === "sporttery") rank += 4;
  if (hasPublishedOfficialOdds(match)) rank += 2;
  if (match?.predictionMeta?.lockedAt || match?.predictionMeta?.snapshot?.latestSignature) rank += 1;
  return rank;
}

function shouldPreferPublishedIdentity(candidate, existing) {
  const candidateRank = publishedIdentityRank(candidate);
  const existingRank = publishedIdentityRank(existing);
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  const candidateUpdated = Date.parse(candidate?.predictionMeta?.updatedAt || candidate?.oddsUpdatedAt || candidate?.kickoffTime || "");
  const existingUpdated = Date.parse(existing?.predictionMeta?.updatedAt || existing?.oddsUpdatedAt || existing?.kickoffTime || "");
  return Number.isFinite(candidateUpdated) && Number.isFinite(existingUpdated) && candidateUpdated > existingUpdated;
}

function loadExistingSyncMeta(publicDir) {
  const file = path.join(publicDir, "data", "sync-meta.json");
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadExistingJsonObject(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadExternalSignals(publicDir) {
  const file = path.join(publicDir, "data", "external-signals.json");
  if (!fs.existsSync(file)) return { version: 1, updatedAt: null, matches: {}, count: 0 };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const matches = parsed && typeof parsed.matches === "object" && !Array.isArray(parsed.matches)
      ? parsed.matches
      : {};
    return {
      version: Number(parsed?.version || 1),
      updatedAt: parsed?.updatedAt || null,
      source: parsed?.source || "external-signals",
      matches,
      count: Object.keys(matches).length,
    };
  } catch (error) {
    console.warn(`external-signals.json ignored: ${error.message}`);
    return { version: 1, updatedAt: null, matches: {}, count: 0, error: error.message };
  }
}

function fallbackSourceUpdatedAt(signal, externalSignals) {
  return signal?.updatedAt
    || signal?.bookmakerOdds?.had?.updatedAt
    || signal?.bookmakerOdds?.hhad?.updatedAt
    || signal?.externalOdds?.updatedAt
    || externalSignals?.updatedAt
    || new Date().toISOString();
}

function fiveHundredMatchUrl(signal, kind = "analysis") {
  return signal?.fiveHundred?.urls?.[kind]
    || signal?.fiveHundred?.urls?.analysis
    || "https://trade.500.com/jczq/";
}

function signalFallbackId(signal) {
  return normText(signal?.sourceMatchId || signal?.matchId || signal?.fixtureId || "");
}

function fiveHundredResultScore(signal) {
  const result = signal?.fiveHundred?.result || signal?.result || {};
  const home = toNum(result.scoreHome, toNum(signal?.scoreHome, null));
  const away = toNum(result.scoreAway, toNum(signal?.scoreAway, null));
  return Number.isFinite(home) && Number.isFinite(away)
    ? {
      scoreHome: home,
      scoreAway: away,
      source: result.source || signal?.resultSource || "500.com:jczq-result",
      updatedAt: result.updatedAt || signal?.updatedAt,
    }
    : null;
}

function buildFiveHundredFallbackMatches(externalSignals) {
  if (process.env.ENABLE_500_MATCH_FALLBACK === "0") return [];

  const signals = externalSignals?.matches || {};
  const seen = new Set();
  const rows = [];
  const now = Date.now();
  const staleStartedGraceMs = 3 * 60 * 60 * 1000;
  const resultLookbackMs = Math.max(6, Number(process.env.FIVE_HUNDRED_RESULT_OUTPUT_LOOKBACK_HOURS || 72)) * 60 * 60 * 1000;

  for (const signal of Object.values(signals)) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;

    const sourceMatchId = signalFallbackId(signal);
    if (!sourceMatchId || seen.has(sourceMatchId)) continue;

    const kickoffTime = normText(signal.kickoffTime);
    const kickoffMs = Date.parse(kickoffTime);
    const resultScore = fiveHundredResultScore(signal);
    const resultIsFresh = resultScore && Number.isFinite(kickoffMs) && kickoffMs >= now - resultLookbackMs;
    if (!Number.isFinite(kickoffMs) || (!resultIsFresh && kickoffMs < now - staleStartedGraceMs)) continue;

    const homeTeam = normText(signal.homeTeamName || signal.homeTeam);
    const awayTeam = normText(signal.awayTeamName || signal.awayTeam);
    if (!homeTeam || !awayTeam) continue;

    const bookmakerOdds = signal.bookmakerOdds || {};
    const hadOdds = sanitizeOdds(bookmakerOdds.had)
      || (!signal.handicapLine ? sanitizeOdds(signal.externalOdds) : null);
    const hhadOdds = sanitizeOdds(bookmakerOdds.hhad)
      || (!hadOdds && signal.handicapLine ? sanitizeOdds(signal.externalOdds) : null);
    if (!resultScore && !hadOdds && !hhadOdds) continue;

    const updatedAt = fallbackSourceUpdatedAt(signal, externalSignals);
    const matchDate = kickoffTime.slice(0, 10);
    const matchNo = normText(signal.matchNo);
    const businessDate = inferSportteryBusinessDate(matchNo, matchDate) || matchDate;
    seen.add(sourceMatchId);
    rows.push({
      source: "five-hundred",
      sourceMethod: "500-fallback",
      sourceUrl: fiveHundredMatchUrl(signal, "analysis"),
      sourceMatchId,
      fixtureId: normText(signal.fixtureId),
      matchNo,
      businessDate,
      matchDate,
      buyEndTime: normText(signal.buyEndTime || signal.fiveHundred?.sale?.buyEndTime),
      homeTeam,
      awayTeam,
      homeRank: normText(signal.fiveHundred?.rank?.home?.fifaRank),
      awayRank: normText(signal.fiveHundred?.rank?.away?.fifaRank),
      homeTeamCode: normText(signal.homeTeamCode),
      awayTeamCode: normText(signal.awayTeamCode),
      leagueName: normText(signal.leagueName, "足球赛事"),
      kickoffTime,
      status: resultScore ? "FINISHED" : "SCHEDULED",
      scoreHome: resultScore?.scoreHome,
      scoreAway: resultScore?.scoreAway,
      resultSource: resultScore?.source,
      resultUpdatedAt: resultScore?.updatedAt,
      odds: hadOdds,
      oddsSource: hadOdds ? "500.com:HAD" : undefined,
      oddsPoolCode: hadOdds ? "HAD" : undefined,
      oddsSourceMethod: hadOdds ? "500-fallback" : undefined,
      oddsUpdatedAt: hadOdds ? updatedAt : undefined,
      oddsSourceUrl: hadOdds ? fiveHundredMatchUrl(signal, "europeOdds") : undefined,
      handicapOdds: hhadOdds,
      handicapLine: hhadOdds
        ? normText(bookmakerOdds.hhad?.handicapLine || signal.handicapLine)
        : undefined,
      handicapOddsSource: hhadOdds ? "500.com:HHAD" : undefined,
      handicapOddsPoolCode: hhadOdds ? "HHAD" : undefined,
      handicapOddsSourceMethod: hhadOdds ? "500-fallback" : undefined,
      handicapOddsUpdatedAt: hhadOdds ? updatedAt : undefined,
      handicapOddsSourceUrl: hhadOdds ? fiveHundredMatchUrl(signal, "asianHandicap") : undefined,
      externalSignals: {
        ...signal,
        source: signal.source || externalSignals?.source || "external-signals",
        updatedAt,
      },
    });
  }

  return dedupeMatches(rows);
}

function externalSignalKeys(match) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  return [
    sourceMatchId,
    normText(match?.matchNo && match?.businessDate ? `${match.businessDate}:${match.matchNo}` : ""),
    normText(match?.kickoffDate && match?.homeTeamName && match?.awayTeamName
      ? `${match.kickoffDate}:${match.homeTeamName}:${match.awayTeamName}`
      : ""),
    normText(match?.kickoffDate && match?.homeTeam && match?.awayTeam
      ? `${match.kickoffDate}:${match.homeTeam}:${match.awayTeam}`
      : ""),
  ].filter(Boolean);
}

function attachExternalSignals(matches, externalSignals) {
  const signalMap = externalSignals?.matches || {};
  if (!signalMap || !Object.keys(signalMap).length) return matches;

  return matches.map((match) => {
    const key = externalSignalKeys(match).find((candidate) => signalMap[candidate]);
    if (!key) return match;
    const value = signalMap[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) return match;
    return {
      ...match,
      externalSignals: {
        ...value,
        source: value.source || externalSignals.source || "external-signals",
        updatedAt: value.updatedAt || externalSignals.updatedAt || undefined,
      },
    };
  });
}

function applyExternalResultSignal(match) {
  const resultScore = fiveHundredResultScore(match?.externalSignals);
  if (!resultScore) return match;

  const hasScore = Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway);
  const currentResultSource = normText(match?.resultSource || match?.externalSignals?.fiveHundred?.result?.source);
  if (hasScore && isOfficialResultMatch(match)) return match;
  if (hasScore && match.status === "FINISHED" && !currentResultSource.startsWith("500.com")) return match;

  const settled = {
    ...match,
    status: "FINISHED",
    scoreHome: resultScore.scoreHome,
    scoreAway: resultScore.scoreAway,
    resultSource: resultScore.source,
    resultUpdatedAt: resultScore.updatedAt || match?.resultUpdatedAt,
  };

  if (Array.isArray(match?.predictions) && match.predictions.length) {
    return {
      ...settled,
      predictions: settlePredictionsForMatch(settled, match.predictions),
    };
  }

  return settled;
}

function normalizeProbabilityModelForPublish(model) {
  if (!model || typeof model !== "object") return model;
  return {
    ...model,
    basis: String(model.version || "").includes("model-only")
      ? (model.basis || {
        zh: "未开售模型参考：官方 SP/让球 SP 暂无时，按球队强弱、历史样本、赛程与 Poisson 比分分布生成观察方向；不作为串关 SP。",
        en: "Model-only reference while official SP/handicap SP is unavailable. It uses team strength, historical samples, schedule context, and Poisson score distribution, and is not a parlay SP.",
      })
      : PREDICTION_MODEL_BASIS,
  };
}

function normalizePredictionMetaForPublish(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const { forecastPlan, ...rest } = meta;
  void forecastPlan;
  return {
    ...rest,
    policyVersion: rest.policyVersion || PREDICTION_POLICY_VERSION,
    promptVersion: rest.promptVersion || ANALYST_PROMPT_VERSION,
    dataPolicy: PREDICTION_DATA_POLICY,
    analystRuntime: rest.analystRuntime || ANALYST_RUNTIME,
    analystFramework: rest.analystFramework || PREDICTION_ANALYST_FRAMEWORK,
  };
}

function normalizePublishedPredictionText(match) {
  if (!match || typeof match !== "object") return match;
  const enriched = enrichPublishedCalculationTrace(match);
  return {
    ...enriched,
    probabilityModel: normalizeProbabilityModelForPublish(enriched.probabilityModel),
    predictionMeta: normalizePredictionMetaForPublish(enriched.predictionMeta),
  };
}

const REFERENCE_COPY_REPLACEMENTS = Object.freeze([
  ["赛前观察项", "参考推荐"],
  ["赛前观察方向", "参考方向"],
  ["只保留观察位", "只保留参考位"],
  ["保留赛前观察", "保留参考方向"],
  ["观察理由：", "参考理由："],
  ["观察处理", "参考处理"],
  ["watch-only", "reference-only"],
  ["pre-match watch", "reference-only"],
  ["Pre-match watch", "Reference-only"],
]);

function sanitizeReferenceCopyText(text) {
  if (typeof text !== "string") return text;
  return REFERENCE_COPY_REPLACEMENTS.reduce(
    (current, [from, to]) => current.split(from).join(to),
    text
  );
}

function sanitizeReferenceCopyValue(value) {
  if (typeof value === "string") return sanitizeReferenceCopyText(value);
  if (Array.isArray(value)) return value.map(sanitizeReferenceCopyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeReferenceCopyValue(entry)])
  );
}

function sanitizePublishedReferenceCopy(match) {
  if (!match || typeof match !== "object") return match;
  return {
    ...match,
    predictions: Array.isArray(match.predictions)
      ? match.predictions.map(sanitizeReferenceCopyValue)
      : match.predictions,
    oddsTrend: match.oddsTrend ? sanitizeReferenceCopyValue(match.oddsTrend) : match.oddsTrend,
    predictionMeta: match.predictionMeta ? sanitizeReferenceCopyValue(match.predictionMeta) : match.predictionMeta,
  };
}

function normalizePublishedStatus(match, capturedAt) {
  if (!match) return match;
  const kickoffMs = Date.parse(match.kickoffTime);
  const capturedMs = Date.parse(capturedAt);
  const hasScore = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(capturedMs)) return match;
  const elapsedMinutes = Math.floor((capturedMs - kickoffMs) / 60000);
  if (match.status === "FINISHED") return hasScore ? match : { ...match, status: "PENDING_RESULT" };
  if (match.status === "LIVE") {
    return !hasScore && elapsedMinutes >= 125 ? { ...match, status: "PENDING_RESULT" } : match;
  }
  if (match.status === "PENDING_RESULT") return match;
  if (capturedMs < kickoffMs) return match;
  if (hasScore && elapsedMinutes >= 125) return { ...match, status: "FINISHED" };
  if (!hasScore && elapsedMinutes >= 125) return { ...match, status: "PENDING_RESULT" };
  return { ...match, status: "LIVE" };
}

function isTrustedOddsMatch(match) {
  return (
    match?.source === "sporttery" &&
    match?.oddsSource === "sporttery:HAD" &&
    String(match?.oddsSourceUrl || "").includes("webapi.sporttery.cn") &&
    Boolean(sanitizeOdds(match?.odds))
  );
}

function isOfficialResultMatch(match) {
  return (
    match?.status === "FINISHED" &&
    Number.isFinite(match?.scoreHome) &&
    Number.isFinite(match?.scoreAway) &&
    String(match?.sourceUrl || "").includes("webapi.sporttery.cn")
  );
}

function isFallbackResultMatch(match) {
  return (
    match?.status === "FINISHED" &&
    Number.isFinite(match?.scoreHome) &&
    Number.isFinite(match?.scoreAway) &&
    String(match?.resultSource || match?.externalSignals?.fiveHundred?.result?.source || "").startsWith("500.com")
  );
}

function hasOfficialDisplayOdds(match) {
  return Boolean(sanitizeOdds(match?.odds) || sanitizeOdds(match?.handicapOdds));
}

function captureBucketIso(capturedAt) {
  const time = Date.parse(capturedAt);
  const bucketMs = ODDS_HISTORY_BUCKET_MINUTES * 60 * 1000;
  return new Date(Math.floor(time / bucketMs) * bucketMs).toISOString();
}

function loadOddsHistory(publicDir) {
  const file = path.join(publicDir, "odds-history.json");
  if (!fs.existsSync(file)) {
    return { version: 1, source: "sporttery:HAD", rows: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: 1,
      source: "sporttery:HAD",
      rows: Array.isArray(parsed?.rows) ? parsed.rows : [],
    };
  } catch {
    return { version: 1, source: "sporttery:HAD", rows: [] };
  }
}

function latestOddsSnapshotForMatch(match, historyRows) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId) return null;

  const kickoffAt = Date.parse(match.kickoffTime);
  const rows = historyRows
    .filter((row) => normText(row?.sourceMatchId) === sourceMatchId)
    .filter((row) => sanitizeOdds({ odds1: row?.odds1, oddsX: row?.oddsX, odds2: row?.odds2 }))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  if (!rows.length) return null;

  const beforeKickoff = Number.isFinite(kickoffAt)
    ? rows.filter((row) => Date.parse(row.capturedAt) <= kickoffAt)
    : rows;
  return beforeKickoff.at(-1) || rows.at(-1) || null;
}

function enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, historyRows) {
  if (sanitizeOdds(match.odds)) return match;

  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  const existing = existingBySourceId.get(sourceMatchId);
  const existingOdds = sanitizeOdds(existing?.odds);
  if (existingOdds) {
    return {
      ...match,
      odds: existingOdds,
      oddsSource: existing.oddsSource || "sporttery:HAD",
      oddsPoolCode: existing.oddsPoolCode || "HAD",
      oddsSourceMethod: existing.oddsSourceMethod || "preserved",
      oddsUpdatedAt: existing.oddsUpdatedAt,
      oddsSourceUrl: existing.oddsSourceUrl,
      handicapOdds: sanitizeOdds(existing.handicapOdds) || match.handicapOdds,
      handicapLine: existing.handicapLine || match.handicapLine,
      handicapOddsSource: existing.handicapOddsSource || match.handicapOddsSource,
      handicapOddsPoolCode: existing.handicapOddsPoolCode || match.handicapOddsPoolCode,
      handicapOddsSourceMethod: existing.handicapOddsSourceMethod || match.handicapOddsSourceMethod,
      handicapOddsUpdatedAt: existing.handicapOddsUpdatedAt || match.handicapOddsUpdatedAt,
      handicapOddsSourceUrl: existing.handicapOddsSourceUrl || match.handicapOddsSourceUrl,
    };
  }

  const snapshot = latestOddsSnapshotForMatch(match, historyRows);
  if (!snapshot) return match;

  return {
    ...match,
    odds: {
      odds1: Number(snapshot.odds1),
      oddsX: Number(snapshot.oddsX),
      odds2: Number(snapshot.odds2),
    },
    oddsSource: "sporttery:HAD",
    oddsPoolCode: "HAD",
    oddsSourceMethod: "snapshot",
    oddsUpdatedAt: snapshot.oddsUpdatedAt || snapshot.capturedAt,
    oddsSourceUrl: snapshot.oddsSourceUrl,
  };
}

function oddsHistoryRow(match, capturedAt) {
  const odds = sanitizeOdds(match?.odds);
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId || !odds || !isTrustedOddsMatch(match)) return null;

  return {
    capturedAt,
    captureBucket: captureBucketIso(capturedAt),
    sourceMatchId,
    matchNo: normText(match.matchNo),
    kickoffTime: match.kickoffTime,
    status: match.status,
    leagueName: match.leagueName,
    countryName: match.countryName,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    homeTeamLogo: match.homeTeamLogo,
    awayTeamLogo: match.awayTeamLogo,
    odds1: odds.odds1,
    oddsX: odds.oddsX,
    odds2: odds.odds2,
    oddsSource: match.oddsSource,
    oddsSourceMethod: match.oddsSourceMethod,
    oddsUpdatedAt: match.oddsUpdatedAt,
    oddsSourceUrl: match.oddsSourceUrl,
  };
}

function appendOddsHistory(publicDir, matches, capturedAt) {
  const history = loadOddsHistory(publicDir);
  const cutoff = Date.parse(capturedAt) - ODDS_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byMatchAndBucket = new Map();

  for (const row of history.rows) {
    const rowTime = Date.parse(row?.capturedAt);
    const sourceMatchId = normText(row?.sourceMatchId);
    const captureBucket = normText(row?.captureBucket);
    if (!Number.isFinite(rowTime) || rowTime < cutoff || !sourceMatchId || !captureBucket) continue;
    byMatchAndBucket.set(`${sourceMatchId}|${captureBucket}`, {
      ...row,
      sourceMatchId,
      captureBucket,
    });
  }

  let appended = 0;
  let updated = 0;
  for (const match of matches) {
    const row = oddsHistoryRow(match, capturedAt);
    if (!row) continue;
    const key = `${row.sourceMatchId}|${row.captureBucket}`;
    const existing = byMatchAndBucket.get(key);
    if (!existing) {
      appended += 1;
    } else if (JSON.stringify(existing) !== JSON.stringify(row)) {
      updated += 1;
    }
    byMatchAndBucket.set(key, row);
  }

  const rows = Array.from(byMatchAndBucket.values()).sort((a, b) => {
    const byTime = Date.parse(a.capturedAt) - Date.parse(b.capturedAt);
    if (byTime !== 0) return byTime;
    return String(a.sourceMatchId).localeCompare(String(b.sourceMatchId));
  });

  const payload = {
    version: 1,
    source: "sporttery:HAD",
    updatedAt: capturedAt,
    retentionDays: ODDS_HISTORY_RETENTION_DAYS,
    bucketMinutes: ODDS_HISTORY_BUCKET_MINUTES,
    rows,
  };
  writeJson(path.join(publicDir, "odds-history.json"), payload);
  return { rows: rows.length, appended, updated };
}

function loadPredictionSnapshots(publicDir) {
  const files = [
    path.join(publicDir, "data", "prediction-snapshots.json"),
    path.join(publicDir, "prediction-snapshots.json"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        version: 1,
        source: "sporttery:prediction-snapshots",
        updatedAt: parsed?.updatedAt || null,
        retentionDays: Number(parsed?.retentionDays || PREDICTION_SNAPSHOT_RETENTION_DAYS),
        maxRows: Number(parsed?.maxRows || PREDICTION_SNAPSHOT_MAX_ROWS),
        rows: Array.isArray(parsed?.rows) ? parsed.rows : [],
      };
    } catch {
      return {
        version: 1,
        source: "sporttery:prediction-snapshots",
        updatedAt: null,
        retentionDays: PREDICTION_SNAPSHOT_RETENTION_DAYS,
        maxRows: PREDICTION_SNAPSHOT_MAX_ROWS,
        rows: [],
      };
    }
  }
  return {
    version: 1,
    source: "sporttery:prediction-snapshots",
    updatedAt: null,
    retentionDays: PREDICTION_SNAPSHOT_RETENTION_DAYS,
    maxRows: PREDICTION_SNAPSHOT_MAX_ROWS,
    rows: [],
  };
}

function predictionPhase(match, capturedAt) {
  const kickoffAt = Date.parse(match?.kickoffTime);
  const capturedTime = Date.parse(capturedAt);
  if (match?.status === "FINISHED") return "review";
  if (!Number.isFinite(kickoffAt) || !Number.isFinite(capturedTime)) return "baseline";
  const minutesToKickoff = Math.floor((kickoffAt - capturedTime) / 60000);
  if (minutesToKickoff <= 0 || match?.status === "LIVE") return "locked";
  if (minutesToKickoff <= 30) return "final";
  if (minutesToKickoff <= 90) return "late";
  if (minutesToKickoff <= 360) return "mid";
  return "baseline";
}

function snapshotTip(predictions, marketType) {
  const prediction = (predictions || []).find((item) => item.marketType === marketType);
  if (!prediction) return null;
  return {
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel,
    odds: prediction.odds || 0,
    trustScore: prediction.trustScore || 0,
    resultStatus: prediction.resultStatus,
    riskCount: (prediction.riskTags || []).length,
  };
}

function snapshotSignatureForMatch(match) {
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeOdds(match?.handicapOdds);
  const final = match?.probabilityModel?.oneXTwo?.final;
  const tipSignature = predictionSignature(match?.predictions || []);
  const oddsSignature = odds
    ? `${odds.odds1.toFixed(2)}/${odds.oddsX.toFixed(2)}/${odds.odds2.toFixed(2)}`
    : "--";
  const hhadSignature = handicapOdds
    ? `${match.handicapLine || ""}:${handicapOdds.odds1.toFixed(2)}/${handicapOdds.oddsX.toFixed(2)}/${handicapOdds.odds2.toFixed(2)}`
    : "--";
  const probabilitySignature = final
    ? `${Math.round(final.home)}/${Math.round(final.draw)}/${Math.round(final.away)}`
    : "--";
  return `${tipSignature}|${oddsSignature}|${hhadSignature}|${probabilitySignature}`;
}

function predictionSnapshotRow(match, capturedAt) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  const predictions = enabledPredictions(match?.predictions || []);
  if (!sourceMatchId || predictions.length === 0) return null;
  const phase = predictionPhase(match, capturedAt);
  const signature = snapshotSignatureForMatch(match);
  const finalProbabilities = match?.probabilityModel?.oneXTwo?.final || null;
  return {
    capturedAt,
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    seenCount: 1,
    phase,
    signature,
    policyVersion: match.predictionMeta?.policyVersion || PREDICTION_POLICY_VERSION,
    promptVersion: match.predictionMeta?.promptVersion || ANALYST_PROMPT_VERSION,
    sourceMatchId,
    matchId: match.id,
    matchNo: match.matchNo,
    businessDate: match.businessDate,
    kickoffTime: match.kickoffTime,
    status: match.status,
    leagueName: match.leagueName,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    scoreHome: Number.isFinite(match.scoreHome) ? match.scoreHome : null,
    scoreAway: Number.isFinite(match.scoreAway) ? match.scoreAway : null,
    odds: sanitizeOdds(match.odds),
    handicapLine: match.handicapLine,
    handicapOdds: sanitizeOdds(match.handicapOdds),
    oddsTrend: match.oddsTrend || null,
    probabilityFinal: finalProbabilities,
    probabilityModelVersion: match.probabilityModel?.version || null,
    best: snapshotTip(predictions, "BEST"),
    oneXTwo: snapshotTip(predictions, "1X2"),
    goals: snapshotTip(predictions, "GOALS"),
  };
}

function predictionSnapshotComparable(row) {
  if (!row || typeof row !== "object") return "";
  return JSON.stringify({
    ...row,
    capturedAt: undefined,
    firstSeenAt: undefined,
    lastSeenAt: undefined,
    seenCount: undefined,
  });
}

function appendPredictionSnapshots(publicDir, matches, capturedAt) {
  const history = loadPredictionSnapshots(publicDir);
  const cutoff = Date.parse(capturedAt) - PREDICTION_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byKey = new Map();

  for (const row of history.rows) {
    const rowTime = Date.parse(row?.lastSeenAt || row?.capturedAt);
    const sourceMatchId = normText(row?.sourceMatchId);
    const phase = normText(row?.phase);
    const signature = normText(row?.signature);
    if (!Number.isFinite(rowTime) || rowTime < cutoff || !sourceMatchId || !phase || !signature) continue;
    byKey.set(`${sourceMatchId}|${phase}|${signature}`, row);
  }

  let appended = 0;
  let updated = 0;
  for (const match of matches || []) {
    if (match?.predictionMeta?.lockedAt && match?.predictionMeta?.snapshot?.latestSignature) {
      continue;
    }
    const row = predictionSnapshotRow(match, capturedAt);
    if (!row) continue;
    const key = `${row.sourceMatchId}|${row.phase}|${row.signature}`;
    const existing = byKey.get(key);
    if (existing) {
      if (predictionSnapshotComparable(existing) !== predictionSnapshotComparable(row)) {
        updated += 1;
        byKey.set(key, {
          ...existing,
          ...row,
          firstSeenAt: existing.firstSeenAt || existing.capturedAt || row.firstSeenAt,
          lastSeenAt: capturedAt,
          seenCount: Number(existing.seenCount || 1) + 1,
        });
      }
    } else {
      appended += 1;
      byKey.set(key, row);
    }
  }

  const rows = Array.from(byKey.values())
    .sort((a, b) => Date.parse(a.firstSeenAt || a.capturedAt) - Date.parse(b.firstSeenAt || b.capturedAt))
    .slice(-PREDICTION_SNAPSHOT_MAX_ROWS);
  const byPhase = rows.reduce((acc, row) => {
    acc[row.phase] = (acc[row.phase] || 0) + 1;
    return acc;
  }, {});
  const payload = {
    version: 1,
    source: "sporttery:prediction-snapshots",
    updatedAt: appended || updated ? capturedAt : (history.updatedAt || capturedAt),
    retentionDays: PREDICTION_SNAPSHOT_RETENTION_DAYS,
    maxRows: PREDICTION_SNAPSHOT_MAX_ROWS,
    rows,
    summary: {
      total: rows.length,
      byPhase,
      appended,
      updated,
    },
  };
  return payload;
}

function attachPredictionSnapshotSummary(matches, snapshotPayload, capturedAt) {
  const rowsByMatch = new Map();
  for (const row of snapshotPayload?.rows || []) {
    const key = normText(row?.sourceMatchId);
    if (!key) continue;
    if (!rowsByMatch.has(key)) rowsByMatch.set(key, []);
    rowsByMatch.get(key).push(row);
  }

  return (matches || []).map((match) => {
    const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
    const rows = rowsByMatch.get(sourceMatchId) || [];
    const lockedSnapshot = match?.predictionMeta?.snapshot;
    if (predictionContentLocked(match, capturedAt) && lockedSnapshot?.latestSignature) {
      return {
        ...match,
        predictionMeta: {
          ...(match.predictionMeta || {}),
          snapshot: lockedSnapshot,
        },
      };
    }
    const phases = rows.reduce((acc, row) => {
      acc[row.phase] = (acc[row.phase] || 0) + 1;
      return acc;
    }, {});
    const latest = rows
      .slice()
      .sort((a, b) => Date.parse(b.lastSeenAt || b.capturedAt) - Date.parse(a.lastSeenAt || a.capturedAt))[0];

    return {
      ...match,
      predictionMeta: {
        ...(match.predictionMeta || {}),
        snapshot: {
          phase: predictionPhase(match, capturedAt),
          total: rows.length,
          phases,
          latestAt: latest?.lastSeenAt || latest?.capturedAt,
          latestSignature: latest?.signature,
        },
      },
    };
  });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileRetry(operation, label) {
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
}

function writeJson(file, payload) {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const previous = withFileRetry(() => fs.readFileSync(file, "utf8"), `read ${file}`);
    if (previous === next) return false;
  }
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  withFileRetry(() => {
    fs.writeFileSync(tmpFile, next, "utf8");
    try {
      fs.renameSync(tmpFile, file);
    } catch (error) {
      fs.copyFileSync(tmpFile, file);
      fs.unlinkSync(tmpFile);
      void error;
    }
  }, `write ${file}`);
  return true;
}

function preserveRootTimestamps(next, existing, keys) {
  if (!next || !existing || typeof next !== "object" || typeof existing !== "object") return next;
  const sanitizedNext = { ...next };
  const sanitizedExisting = { ...existing };
  for (const key of keys) {
    delete sanitizedNext[key];
    delete sanitizedExisting[key];
  }
  if (JSON.stringify(sanitizedNext) !== JSON.stringify(sanitizedExisting)) return next;
  const merged = { ...next };
  for (const key of keys) {
    if (existing[key] !== undefined) merged[key] = existing[key];
  }
  return merged;
}

function spChange(value) {
  const rounded = Number(value.toFixed(2));
  if (Object.is(rounded, -0)) return 0;
  return rounded;
}

function formatSpChange(value) {
  const rounded = spChange(value);
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

function oddsMovePhrase(item) {
  const amount = formatSpChange(item.change);
  return {
    zh: `${item.zh} ${amount}`,
    en: `${item.en} ${amount}`,
  };
}

function oddsTrendSummary(rows, direction, strongest, candidates) {
  const moved = candidates
    .filter((item) => Math.abs(item.change) >= 0.03)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  if (direction === "flat") {
    return {
      zh: `已记录 ${rows.length} 次官方 SP 快照，胜平负主盘基本没动；这种场次不把静态赔率写成推荐，临场继续看让球盘是否补强。`,
      en: `${rows.length} official SP snapshots recorded; the 1X2 board is essentially flat, so a static board is not packaged as a pick. Keep watching handicap confirmation.`,
    };
  }

  if (direction === "mixed") {
    const moveTextZh = moved.slice(0, 2).map((item) => oddsMovePhrase(item).zh).join("，");
    const moveTextEn = moved.slice(0, 2).map((item) => oddsMovePhrase(item).en).join(", ");
    return {
      zh: `已记录 ${rows.length} 次官方 SP 快照，主要变化：${moveTextZh || "暂无单项大幅变化"}；盘面在拉扯，先按参考处理。`,
      en: `${rows.length} official SP snapshots recorded. Main moves: ${moveTextEn || "no single strong move"}; the board is mixed, so keep it as reference-only.`,
    };
  }

  const strongestPhrase = oddsMovePhrase(strongest);
  const otherMoves = candidates
    .filter((item) => item.key !== strongest.key && Math.abs(item.change) >= 0.03)
    .slice(0, 2);
  return {
    zh: `已记录 ${rows.length} 次官方 SP 快照，${strongestPhrase.zh}，市场对该方向有增温迹象${otherMoves.length ? `；同步变化：${otherMoves.map((item) => oddsMovePhrase(item).zh).join("，")}` : ""}。`,
    en: `${rows.length} official SP snapshots recorded. ${strongestPhrase.en}; that side is warming${otherMoves.length ? `, with secondary moves ${otherMoves.map((item) => oddsMovePhrase(item).en).join(", ")}` : ""}.`,
  };
}

function oddsTrendForMatch(match, historyRows) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId) return undefined;

  const rows = historyRows
    .filter((row) => normText(row?.sourceMatchId) === sourceMatchId)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  if (rows.length < 2) return undefined;

  const first = rows[0];
  const latest = rows[rows.length - 1];
  const changes = {
    odds1Change: spChange(Number(latest.odds1) - Number(first.odds1)),
    oddsXChange: spChange(Number(latest.oddsX) - Number(first.oddsX)),
    odds2Change: spChange(Number(latest.odds2) - Number(first.odds2)),
  };
  const candidates = [
    { key: "home", change: changes.odds1Change, zh: "主胜", en: "home win" },
    { key: "draw", change: changes.oddsXChange, zh: "平局", en: "draw" },
    { key: "away", change: changes.odds2Change, zh: "客胜", en: "away win" },
  ].sort((a, b) => a.change - b.change);
  const strongest = candidates[0];
  const hasMove = candidates.some((item) => Math.abs(item.change) >= 0.03);
  const direction = hasMove && strongest.change < -0.02 ? strongest.key : hasMove ? "mixed" : "flat";

  return {
    sampleSize: rows.length,
    firstCapturedAt: first.capturedAt,
    lastCapturedAt: latest.capturedAt,
    ...changes,
    direction,
    summary: oddsTrendSummary(rows, direction, strongest, candidates),
  };
}

function attachOddsTrends(matches, publicDir) {
  const history = loadOddsHistory(publicDir);
  return matches.map((match) => {
    const trend = oddsTrendForMatch(match, history.rows);
    return trend ? { ...match, oddsTrend: trend } : match;
  });
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function shanghaiDateKey(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(new Date(time))
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function outputDateCandidates(match) {
  return Array.from(new Set([
    normText(match?.businessDate),
    normText(match?.kickoffDate),
    normText(match?.matchDate),
    shanghaiDateKey(match?.kickoffTime),
  ].filter(Boolean)));
}

function isSameOutputDay(match, capturedAt) {
  const today = shanghaiDateKey(capturedAt);
  return Boolean(today && outputDateCandidates(match).includes(today));
}

function splitMatchesForOutput(matches, capturedAt = new Date().toISOString()) {
  const current = matches.filter((match) => match.status !== "FINISHED" || isSameOutputDay(match, capturedAt));
  const history = matches.filter((match) => match.status === "FINISHED");
  return { current, history };
}

function staleOrPartialFetchReason(existingMatches, nextMatches, rawMatchesWithOdds, rawResultMatches) {
  if (existingMatches.length < 100) return "";

  const existingSplit = splitMatchesForOutput(existingMatches);
  const nextSplit = splitMatchesForOutput(nextMatches);

  if (rawMatchesWithOdds.length === 0 && nextMatches.length < existingMatches.length) {
    return `fresh Sporttery odds unavailable; keeping existing ${existingMatches.length} matches`;
  }

  if (
    existingSplit.history.length >= 100 &&
    nextSplit.history.length < existingSplit.history.length * 0.8 &&
    rawResultMatches.length < existingSplit.history.length * 0.8
  ) {
    return `fresh result coverage ${rawResultMatches.length} is far below existing history ${existingSplit.history.length}`;
  }

  return "";
}

function matchStoreKey(match) {
  return normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
}

function hasPublishedOfficialOdds(match) {
  return match?.oddsSource === "sporttery:HAD" || match?.handicapOddsSource === "sporttery:HHAD";
}

function hasPublishedReferenceOdds(match) {
  return String(match?.oddsSource || "").startsWith("500.com")
    || String(match?.handicapOddsSource || "").startsWith("500.com");
}

function predictionInputFromPublishedMatch(match) {
  return {
    ...match,
    homeTeam: match.homeTeam || match.homeTeamName,
    awayTeam: match.awayTeam || match.awayTeamName,
    leagueName: match.leagueName || match.leagueShortName,
    leagueNameEn: match.leagueNameEn || match.leagueShortNameEn,
    countryName: match.countryName,
    countryNameEn: match.countryNameEn,
  };
}

function rebuildPublishedPredictionModel(match) {
  if (predictionContentLocked(match)) return match;
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeOdds(match?.handicapOdds);
  if (!odds && !handicapOdds) return match;

  const rebuilt = predictionSet(predictionInputFromPublishedMatch({ ...match, odds, handicapOdds }));
  return {
    ...match,
    predictions: rebuilt.predictions,
    probabilityModel: rebuilt.probabilityModel,
    projectedScoreHome: rebuilt.projectedScore?.home,
    projectedScoreAway: rebuilt.projectedScore?.away,
  };
}

function enrichPublishedCalculationTrace(match) {
  if (!match?.probabilityModel) return match;
  if (match.probabilityModel.calculationTrace?.version === "formula-trace-v2") return match;

  const calculationTrace = buildCalculationTraceFromPublishedModel(match, match.probabilityModel);
  if (!calculationTrace) return match;

  return {
    ...match,
    probabilityModel: {
      ...match.probabilityModel,
      calculationTrace,
    },
  };
}

function publishedOddsForPrediction(match, prediction) {
  const odds = prediction?.oddsPoolCode === "HHAD" ? match?.handicapOdds : match?.odds;
  if (prediction?.tipCode === "1") return odds?.odds1;
  if (prediction?.tipCode === "X") return odds?.oddsX;
  if (prediction?.tipCode === "2") return odds?.odds2;
  return undefined;
}

function predictionsAlignWithPublishedOdds(match) {
  for (const prediction of match?.predictions || []) {
    if (!["1X2", "BEST"].includes(prediction?.marketType)) continue;
    if (!["1", "X", "2"].includes(prediction?.tipCode)) continue;
    if (!Number.isFinite(Number(prediction?.odds)) || Number(prediction?.odds) <= 0) continue;
    const expected = publishedOddsForPrediction(match, prediction);
    if (!Number.isFinite(Number(expected))) continue;
    if (Math.abs(Number(expected) - Number(prediction.odds)) > 1e-9) return false;
  }
  return true;
}

function mergePublishedMatches(existing, fresh) {
  if (!existing) return fresh;

  const merged = { ...existing, ...fresh };
  const existingHasOfficial = hasPublishedOfficialOdds(existing);
  const freshHasOfficial = hasPublishedOfficialOdds(fresh);
  const freshIsReference = hasPublishedReferenceOdds(fresh);
  const existingPredictionLocked = predictionContentLocked(existing);
  const predictionPolicyChanged = existing?.predictionMeta?.policyVersion !== fresh?.predictionMeta?.policyVersion
    || existing?.predictionMeta?.promptVersion !== fresh?.predictionMeta?.promptVersion
    || existing?.predictionMeta?.trainingSignature !== fresh?.predictionMeta?.trainingSignature;

  if (existingHasOfficial && !freshHasOfficial && freshIsReference) {
    Object.assign(merged, {
      id: existing.id,
      source: existing.source,
      oddsTrend: existing.oddsTrend,
    });

    if (existingPredictionLocked) {
      Object.assign(merged, preserveLockedPredictionContent(merged, existing));
    } else if (!predictionPolicyChanged) {
      Object.assign(merged, {
        predictions: merged.status === "FINISHED"
          ? settlePredictionsForMatch(merged, existing.predictions)
          : existing.predictions,
        probabilityModel: existing.probabilityModel,
        projectedScoreHome: existing.projectedScoreHome,
        projectedScoreAway: existing.projectedScoreAway,
        stats: existing.stats,
      });
    }
  }

  if (existing.oddsSource === "sporttery:HAD" && fresh.oddsSource !== "sporttery:HAD") {
    Object.assign(merged, {
      odds: existing.odds,
      oddsSource: existing.oddsSource,
      oddsPoolCode: existing.oddsPoolCode,
      oddsSourceMethod: existing.oddsSourceMethod,
      oddsUpdatedAt: existing.oddsUpdatedAt,
      oddsSourceUrl: existing.oddsSourceUrl,
    });
  }

  if (existing.handicapOddsSource === "sporttery:HHAD" && fresh.handicapOddsSource !== "sporttery:HHAD") {
    Object.assign(merged, {
      handicapOdds: existing.handicapOdds,
      handicapLine: existing.handicapLine,
      handicapOddsSource: existing.handicapOddsSource,
      handicapOddsPoolCode: existing.handicapOddsPoolCode,
      handicapOddsSourceMethod: existing.handicapOddsSourceMethod,
      handicapOddsUpdatedAt: existing.handicapOddsUpdatedAt,
      handicapOddsSourceUrl: existing.handicapOddsSourceUrl,
    });
  }

  if (
    existingHasOfficial
    && !freshHasOfficial
    && freshIsReference
    && !existingPredictionLocked
    && (predictionPolicyChanged || !predictionsAlignWithPublishedOdds(merged))
  ) {
    return rebuildPublishedPredictionModel(merged);
  }

  return existingPredictionLocked ? preserveLockedPredictionContent(merged, existing) : merged;
}

function mergeFreshWithExistingStore(existingMatches, freshMatches) {
  const byId = new Map();
  const orderedIds = [];
  const upsert = (match, preferFresh = false) => {
    const key = matchStoreKey(match);
    if (!key) return;
    if (!byId.has(key)) orderedIds.push(key);
    const previous = byId.get(key);
    byId.set(key, previous && !preferFresh ? previous : mergePublishedMatches(previous, match));
  };

  for (const match of existingMatches || []) upsert(match, false);
  for (const match of freshMatches || []) upsert(match, true);

  return orderedIds
    .map((key) => byId.get(key))
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.kickoffTime || 0) - Date.parse(b.kickoffTime || 0));
}

function buildTeamIndex(matches) {
  const byTeam = new Map();
  const upsert = (match, side) => {
    const isHome = side === "home";
    const teamId = isHome ? match.homeTeamId : match.awayTeamId;
    if (!teamId) return;
    const existing = byTeam.get(teamId) || {
      teamId,
      teamName: isHome ? match.homeTeamName : match.awayTeamName,
      teamNameEn: isHome ? match.homeTeamNameEn : match.awayTeamNameEn,
      logo: isHome ? match.homeTeamLogo : match.awayTeamLogo,
      logoType: isHome ? match.homeTeamLogoType : match.awayTeamLogoType,
      countryIso: isHome ? match.homeTeamCountryIso : match.awayTeamCountryIso,
      color: isHome ? match.homeTeamColor : match.awayTeamColor,
      matchCount: 0,
      finishedCount: 0,
      firstMatchDate: "",
      lastMatchDate: "",
    };
    const date = match.kickoffDate || String(match.kickoffTime || "").slice(0, 10) || match.matchDate || match.businessDate;
    existing.matchCount += 1;
    if (match.status === "FINISHED") existing.finishedCount += 1;
    if (date && (!existing.firstMatchDate || date < existing.firstMatchDate)) existing.firstMatchDate = date;
    if (date && (!existing.lastMatchDate || date > existing.lastMatchDate)) existing.lastMatchDate = date;
    byTeam.set(teamId, existing);
  };

  for (const match of matches) {
    upsert(match, "home");
    upsert(match, "away");
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: "sporttery",
    note: "Team names are kept exactly as synced from China Sporttery.",
    teams: Array.from(byTeam.values()).sort((a, b) => String(a.teamName).localeCompare(String(b.teamName), "zh-CN")),
  };
}

async function sync() {
  const capturedAt = new Date().toISOString();
  const publicDir = path.join(__dirname, "..", "public");
  const dataDir = path.join(publicDir, "data");
  fs.mkdirSync(publicDir, { recursive: true });
  const existingMatches = loadExistingMatches();
  const existingSyncMeta = loadExistingSyncMeta(publicDir);
  const existingModelCalibration = loadExistingJsonObject(path.join(dataDir, "model-calibration.json"));
  const existingModelStrategy = loadExistingJsonObject(path.join(dataDir, "model-strategy.json"))
    || loadExistingJsonObject(path.join(__dirname, "..", "server-data", "model-strategy.json"));
  const existingTeamIndex = loadExistingJsonObject(path.join(dataDir, "team-index.json"));
  const externalSignals = loadExternalSignals(publicDir);
  const historicalTraining = loadHistoricalTrainingIndex();
  const worldCupKimiDataset = loadWorldCupKimiDataset();
  const predictionHealth = buildPredictionHealth(existingMatches);
  const modelCalibration = preserveRootTimestamps(
    applyModelStrategyToCalibration(buildModelCalibration(existingMatches), existingModelStrategy),
    existingModelCalibration,
    ["generatedAt"]
  );
  const existingBySourceId = new Map(
    existingMatches
      .map((match) => [matchStoreKey(match), match])
      .filter(([sourceMatchId]) => sourceMatchId)
  );
  const oddsHistoryBeforeSync = loadOddsHistory(publicDir);
  const allRawMatches = await fetchSportteryMatches();
  const rawMatches = allRawMatches.filter(inMatchWindow);
  const rawFiveHundredFallbackMatches = buildFiveHundredFallbackMatches(externalSignals).filter(inMatchWindow);
  const rawMatchesWithOdds = rawMatches.filter((match) => sanitizeOdds(match.odds));
  const rawMatchesWithHandicapOdds = rawMatches.filter((match) => sanitizeOdds(match.handicapOdds));
  const rawResultMatches = rawMatches.filter(isOfficialResultMatch);
  const rawFallbackResultMatches = rawFiveHundredFallbackMatches.filter(isFallbackResultMatch);
  const rawMatchesForOutput = rawMatches.filter((match) => (
    match.status !== "FINISHED" ||
    hasOfficialDisplayOdds(match) ||
    isOfficialResultMatch(match)
  ));
  const rawFiveHundredFallbackForOutput = rawFiveHundredFallbackMatches.filter((match) => (
    (match.status !== "FINISHED" && hasOfficialDisplayOdds(match)) ||
    isFallbackResultMatch(match)
  ));
  const combinedRawMatchesForOutput = dedupeMatches([
    ...rawFiveHundredFallbackForOutput,
    ...rawMatchesForOutput,
  ]);
  const modelingRawMatches = rawMatches.length ? rawMatches : rawFiveHundredFallbackMatches;
  const eloSnapshots = buildEloSnapshots(modelingRawMatches, historicalTraining);
  const formSnapshots = buildFormSnapshots(modelingRawMatches, historicalTraining);
  const usedFreshOdds = rawMatchesWithOdds.length > 0;
  let output = combinedRawMatchesForOutput
    .map((match) => enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, oddsHistoryBeforeSync.rows))
    .map((match) => attachWorldCupPrior(match, worldCupKimiDataset))
    .map((match) => ({ ...match, eloSnapshot: eloSnapshots.get(normText(match.sourceMatchId)) || null }))
    .map((match) => ({
      ...match,
      formSnapshot: formSnapshots.get(normText(match.sourceMatchId)) || null,
      leaguePrior: leaguePriorForMatch(historicalTraining, match),
      predictionHealth,
      modelCalibration,
    }))
    .map((match) => {
      const appMatch = attachCalibrationMetadataToAppMatch(toAppMatch(match), modelCalibration);
      const existing = existingBySourceId.get(normText(appMatch?.sourceMatchId || String(appMatch?.id || "").replace(/^sporttery_/, "")));
      return applyPredictionPersistence(appMatch, existing, capturedAt);
    });

  let keptExistingReason = staleOrPartialFetchReason(existingMatches, output, rawMatchesWithOdds, rawResultMatches);
  let mergedPartialFresh = false;

  if (!output.length) {
    output = existingMatches;
    keptExistingReason = "Sporttery returned no publishable matches; kept existing match store";
    if (!output.length) throw new Error("Sporttery returned no matches and no existing matches.json is available.");
    console.log(`${keptExistingReason} (${output.length}).`);
  } else if (keptExistingReason) {
    const freshCount = output.length;
    output = mergeFreshWithExistingStore(existingMatches, output);
    mergedPartialFresh = true;
    console.log(`${keptExistingReason}; merged ${freshCount} fresh rows with existing store (${output.length}).`);
  }

  const oddsHistory = usedFreshOdds && (mergedPartialFresh || !keptExistingReason)
    ? appendOddsHistory(publicDir, output, capturedAt)
    : { rows: loadOddsHistory(publicDir).rows.length, appended: 0, updated: 0, skipped: keptExistingReason || "no fresh official odds" };
  output = attachOddsTrends(output, publicDir);
  output = attachExternalSignals(output, externalSignals);
  output = output.map(applyExternalResultSignal);
  output = output.map(normalizePublishedPredictionText);
  output = output.map(sanitizePublishedReferenceCopy);
  output = output.map((match) => normalizePublishedStatus(match, capturedAt));
  const predictionSnapshotsPayload = appendPredictionSnapshots(publicDir, output, capturedAt);
  output = attachPredictionSnapshotSummary(output, predictionSnapshotsPayload, capturedAt);
  const split = splitMatchesForOutput(output, capturedAt);
  const teamIndex = preserveRootTimestamps(buildTeamIndex(output), existingTeamIndex, ["updatedAt"]);
  const oddsHistoryPayload = loadOddsHistory(publicDir);
  const publishedOddsMatches = split.current.filter((match) => sanitizeOdds(match.odds)).length;
  const publishedHandicapOddsMatches = split.current.filter((match) => sanitizeOdds(match.handicapOdds)).length;
  const publishedOfficialOddsMatches = split.current.filter(isTrustedOddsMatch).length;
  const publishedOfficialHandicapOddsMatches = split.current.filter((match) => (
    match?.source === "sporttery" &&
    match?.handicapOddsSource === "sporttery:HHAD" &&
    String(match?.handicapOddsSourceUrl || "").includes("webapi.sporttery.cn") &&
    Boolean(sanitizeOdds(match?.handicapOdds))
  )).length;
  const publishedReferenceOddsMatches = split.current.filter((match) => String(match?.oddsSource || "").startsWith("500.com")).length;
  const publishedReferenceHandicapOddsMatches = split.current.filter((match) => String(match?.handicapOddsSource || "").startsWith("500.com")).length;
  const publishedResultMatches = split.history.filter(isOfficialResultMatch).length
    || split.history.filter((match) => match.status === "FINISHED" && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)).length;
  const publishedFallbackResultMatches = split.history.filter(isFallbackResultMatch).length;
  const byStatus = output.reduce((acc, match) => {
    acc[match.status] = (acc[match.status] || 0) + 1;
    return acc;
  }, {});
  const outputDates = output
    .map((match) => match.businessDate || match.kickoffDate || String(match.kickoffTime || "").slice(0, 10) || match.matchDate)
    .filter(Boolean)
    .sort();
  const shouldPreserveSourceTimestamp = Boolean(keptExistingReason && !mergedPartialFresh);
  const sourcePublishedAt = shouldPreserveSourceTimestamp
    ? (existingSyncMeta?.updatedAt || existingSyncMeta?.capturedAt || capturedAt)
    : capturedAt;
  const syncMeta = {
    version: 1,
    source: "sporttery",
    updatedAt: sourcePublishedAt,
    capturedAt: sourcePublishedAt,
    lastAttemptAt: capturedAt,
    officialOddsMatches: publishedOfficialOddsMatches,
    officialHandicapOddsMatches: publishedOfficialHandicapOddsMatches,
    displayOddsMatches: publishedOddsMatches,
    displayHandicapOddsMatches: publishedHandicapOddsMatches,
    referenceOddsMatches: publishedReferenceOddsMatches,
    referenceHandicapOddsMatches: publishedReferenceHandicapOddsMatches,
    officialResultMatches: publishedResultMatches,
    skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
    byStatus,
    coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
    window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
    files: {
      current: split.current.length,
      history: split.history.length,
      teams: teamIndex.teams.length,
      predictionSnapshots: predictionSnapshotsPayload.rows.length,
      externalSignals: externalSignals.count || 0,
    },
    refreshPolicy: {
      workflowMinutes: Math.max(5, Number(process.env.SYNC_WORKFLOW_MINUTES || 5)),
      pagePollSeconds: PAGE_POLL_SECONDS,
      oddsHistoryBucketMinutes: ODDS_HISTORY_BUCKET_MINUTES,
      note: "GitHub Pages serves static JSON. The page checks for newer JSON regularly; GitHub Actions refreshes the source files on schedule.",
    },
    attempt: {
      capturedAt,
      officialOddsMatches: rawMatchesWithOdds.length,
      officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
      officialResultMatches: rawResultMatches.length,
      fallbackResultMatches: publishedFallbackResultMatches,
      publishableMatches: rawMatchesForOutput.length,
      fiveHundredFallbackMatches: rawFiveHundredFallbackForOutput.length,
      combinedPublishableMatches: combinedRawMatchesForOutput.length,
    },
    oddsHistory,
    predictionSnapshots: predictionSnapshotsPayload.summary,
    externalSignals: {
      source: externalSignals.source || "external-signals",
      updatedAt: externalSignals.updatedAt,
      matches: externalSignals.count || 0,
    },
    modelCalibration: {
      version: modelCalibration.version,
      sample: modelCalibration.sample,
      metrics: modelCalibration.metrics,
    },
    modelStrategy: modelCalibration.strategy ? {
      version: modelCalibration.strategy.version,
      generatedAt: modelCalibration.strategy.generatedAt,
      activation: modelCalibration.strategy.activation,
      sample: modelCalibration.strategy.sample,
      activeGates: modelCalibration.strategy.activeGates,
    } : null,
    historicalTraining: trainingSourceSummary(historicalTraining),
    worldCupKimiData: worldCupDatasetSummary(worldCupKimiDataset),
    ...(keptExistingReason ? {
      fallback: {
        keptExisting: true,
        mergedPartialFresh,
        reason: keptExistingReason,
        existingMatches: existingMatches.length,
        freshPublishableMatches: combinedRawMatchesForOutput.length,
        sportteryPublishableMatches: rawMatchesForOutput.length,
        fiveHundredFallbackMatches: rawFiveHundredFallbackForOutput.length,
        fiveHundredResultMatches: publishedFallbackResultMatches,
      },
    } : {}),
  };

  writeJson(path.join(publicDir, "matches.json"), split.current);
  writeJson(path.join(dataDir, "matches-current.json"), split.current);
  writeJson(path.join(dataDir, "matches-history.json"), split.history);
  writeJson(path.join(dataDir, "team-index.json"), teamIndex);
  writeJson(path.join(dataDir, "odds-history.json"), oddsHistoryPayload);
  writeJson(path.join(dataDir, "prediction-snapshots.json"), predictionSnapshotsPayload);
  writeJson(path.join(dataDir, "model-calibration.json"), modelCalibration);
  if (modelCalibration.strategy) writeJson(path.join(dataDir, "model-strategy.json"), modelCalibration.strategy);
  writeJson(path.join(dataDir, "sync-meta.json"), syncMeta);
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "sporttery",
        count: output.length,
        scanned: allRawMatches.length,
        fiveHundredFallbackScanned: rawFiveHundredFallbackMatches.length,
        officialOddsMatches: publishedOfficialOddsMatches,
        officialHandicapOddsMatches: publishedOfficialHandicapOddsMatches,
        displayOddsMatches: publishedOddsMatches,
        displayHandicapOddsMatches: publishedHandicapOddsMatches,
        referenceOddsMatches: publishedReferenceOddsMatches,
        referenceHandicapOddsMatches: publishedReferenceHandicapOddsMatches,
        fallbackResultMatches: publishedFallbackResultMatches,
        officialResultMatches: publishedResultMatches,
        skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
        window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
        coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
        files: {
          current: split.current.length,
          history: split.history.length,
          teams: teamIndex.teams.length,
        },
        oddsHistory,
        historicalTraining: trainingSourceSummary(historicalTraining),
        worldCupKimiData: worldCupDatasetSummary(worldCupKimiDataset),
        byStatus,
      },
      null,
      2
    )
  );
}

sync().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
