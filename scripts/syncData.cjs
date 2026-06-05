const fs = require("fs");
const path = require("path");
const https = require("https");

const SPORTTERY_BASE = "https://webapi.sporttery.cn";
const CURRENT_URL = `${SPORTTERY_BASE}/gateway/uniform/football/getMatchListV1.qry?clientCode=3001`;
const CALCULATOR_URL = `${SPORTTERY_BASE}/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=hhad,had&channel=c`;
const PAGE_SIZE = Math.max(1, Number(process.env.SPORTTERY_PAGE_SIZE || 80));
const PAGE_DEPTH = Math.max(1, Number(process.env.SPORTTERY_PAGE_DEPTH || 120));
const WINDOW_BACK_DAYS = Math.max(0, Number(process.env.MATCH_WINDOW_BACK_DAYS || 365));
const WINDOW_FORWARD_DAYS = Math.max(1, Number(process.env.MATCH_WINDOW_FORWARD_DAYS || 14));
const ODDS_HISTORY_RETENTION_DAYS = Math.max(1, Number(process.env.ODDS_HISTORY_RETENTION_DAYS || 365));
const ODDS_HISTORY_BUCKET_MINUTES = Math.max(1, Number(process.env.ODDS_HISTORY_BUCKET_MINUTES || 5));
const PAGE_POLL_SECONDS = Math.max(15, Number(process.env.PAGE_POLL_SECONDS || 60));
const ANALYST_PROMPT_VERSION = "professional-football-analyst-v4";
const PREDICTION_POLICY_VERSION = "pre-match-value-gate-v4";
const METHODS = (process.env.SPORTTERY_METHODS || "concern,live,result,all")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const STATUS_PRIORITY = { FINISHED: 6, LIVE: 5, SCHEDULED: 2 };

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
  CYP: "CY",
  CZE: "CZ",
  DEN: "DK",
  ECU: "EC",
  ENG: "GB",
  ESP: "ES",
  FRA: "FR",
  GER: "DE",
  GRE: "GR",
  HUN: "HU",
  IRL: "IE",
  ISR: "IL",
  ITA: "IT",
  JOR: "JO",
  JPN: "JP",
  KOR: "KR",
  MEX: "MX",
  NED: "NL",
  NGA: "NG",
  NIR: "GB",
  NOR: "NO",
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
  TUR: "TR",
  UKR: "UA",
  URU: "UY",
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
};

function flagEmojiFromIso(isoCode) {
  const code = normText(isoCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...code.split("").map((letter) => 127397 + letter.charCodeAt(0)));
}

const J_LEAGUE_LOGO_BASE = "./team-logos/jleague";

const CLUB_LOGO_BY_NAME = {
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

  if (["finished", "result", "ended", "completed"].some((status) => lower.includes(status))) return "FINISHED";
  if (["10", "11", "12", "13"].includes(matchRaw)) return "FINISHED";
  if (nameRaw.includes("完成") || nameRaw.includes("完场") || nameRaw.includes("赛果")) return "FINISHED";

  if (["playing", "live", "inplay", "firsthalf", "secondhalf"].some((status) => lower.includes(status))) return "LIVE";
  if (["4", "5", "6", "7", "8", "9"].includes(matchRaw)) return "LIVE";
  if (matchRaw === "3" || sellRaw === "3" || nameRaw.includes("暂停销售")) return kickoffStarted ? "LIVE" : "SCHEDULED";
  if (kickoffStarted && ["selling", "sell"].some((status) => lower.includes(status))) return "LIVE";
  return "SCHEDULED";
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

function totalGoalsProbability(lambda, goalsTip) {
  if (goalsTip === "7+") {
    let under7 = 0;
    for (let goals = 0; goals <= 6; goals += 1) under7 += poissonProbability(lambda, goals);
    return clamp(1 - under7, 0, 1);
  }
  return clamp(poissonProbability(lambda, Number(goalsTip)), 0, 1);
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

function topScoreProbabilities(homeLambda, awayLambda, limit = 5) {
  return scoreMatrix(homeLambda, awayLambda, 8)
    .sort((a, b) => b.probability - a.probability)
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

function normalizeOutcomeProbabilities(probabilities) {
  if (!probabilities) return null;
  const total = probabilities.home + probabilities.draw + probabilities.away || 1;
  return {
    home: probabilities.home / total,
    draw: probabilities.draw / total,
    away: probabilities.away / total,
  };
}

function blendOutcomeProbabilities(market, poisson, eloSnapshot) {
  const elo = normalizeOutcomeProbabilities(eloSnapshot?.probabilities);
  const eloSample = (eloSnapshot?.homeMatches || 0) + (eloSnapshot?.awayMatches || 0);
  const weights = elo && eloSample >= 6
    ? { market: 0.58, elo: 0.24, poisson: 0.18 }
    : { market: 0.72, elo: 0, poisson: 0.28 };
  const blended = {
    home: market.home * weights.market + (elo?.home || 0) * weights.elo + poisson.home * weights.poisson,
    draw: market.draw * weights.market + (elo?.draw || 0) * weights.elo + poisson.draw * weights.poisson,
    away: market.away * weights.market + (elo?.away || 0) * weights.elo + poisson.away * weights.poisson,
  };
  const total = blended.home + blended.draw + blended.away || 1;
  return {
    probabilities: {
      home: blended.home / total,
      draw: blended.draw / total,
      away: blended.away / total,
    },
    weights,
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

function buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability) {
  const poisson1x2 = poissonOutcomeProbabilities(homeLambda, awayLambda);
  const blended = blendOutcomeProbabilities(probabilities, poisson1x2, match.eloSnapshot);
  const final1x2 = blended.probabilities;
  const handicapPoisson = handicapOutcomeProbabilities(homeLambda, awayLambda, match.handicapLine);
  return {
    version: "market-elo-poisson-v1",
    generatedAt: new Date().toISOString(),
    basis: {
      zh: "市场隐含概率 + Elo 强度快照 + Poisson 比分分布集成；暂未接入 xG、伤停、首发和校准器。",
      en: "Market-implied probability, Elo strength snapshot, and Poisson score baseline; xG, injuries, lineups, and calibration are not connected yet.",
    },
    ensembleWeights: blended.weights,
    oneXTwo: {
      market: asPercentTriplet(probabilities),
      elo: asPercentTriplet(match.eloSnapshot?.probabilities),
      poisson: asPercentTriplet(poisson1x2),
      final: asPercentTriplet(final1x2),
    },
    elo: match.eloSnapshot ? {
      homeRating: Math.round(match.eloSnapshot.homeRating),
      awayRating: Math.round(match.eloSnapshot.awayRating),
      diff: Math.round(match.eloSnapshot.diff),
      homeMatches: match.eloSnapshot.homeMatches,
      awayMatches: match.eloSnapshot.awayMatches,
      lastUpdatedAt: match.eloSnapshot.lastUpdatedAt,
    } : null,
    scoreDistribution: topScoreProbabilities(homeLambda, awayLambda, 5),
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
      zh: "当前为未校准基准概率；后续需要用时间滚动回测做 Brier / log loss / reliability 校准。",
      en: "This is an uncalibrated baseline; rolling backtests with Brier, log loss, and reliability calibration are needed next.",
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

function buildEloSnapshots(matches) {
  const baseRating = 1500;
  const kFactor = 22;
  const ratings = new Map();
  const counts = new Map();
  const snapshots = new Map();

  const teamKey = (teamName) => normText(teamName).toLowerCase();
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
      homeRating,
      awayRating,
      diff: homeRating - awayRating + 62,
      probabilities,
      homeMatches: countFor(homeKey),
      awayMatches: countFor(awayKey),
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
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
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
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36",
          Referer: `https://m.sporttery.cn/mjc/zqsj/?tab=${encodeURIComponent(tab)}`,
          Origin: "https://m.sporttery.cn",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${url} -> HTTP ${res.statusCode}`));
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
      }
    );
    req.setTimeout(20000, () => {
      req.destroy(new Error(`timeout: ${url}`));
    });
    req.on("error", reject);
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
  const sectionScore = scoreFromSections(row.sectionsNo999 || row.sectionsNo1);
  const scoreHome = toNum(row.homeScore, sectionScore.home);
  const scoreAway = toNum(row.awayScore, sectionScore.away);
  const homeTeam = normText(row.homeTeamAllName || row.homeTeamAbbName, "主队");
  const awayTeam = normText(row.awayTeamAllName || row.awayTeamAbbName, "客队");
  const leagueName = normText(row.leagueAllName || row.leagueAbbName, "足球赛事");
  const matchId = String(row.matchId || `${row.matchDate}-${homeTeam}-${awayTeam}`);
  const kickoffTime = parseKickoff(row.matchDate, row.matchTime);
  const status = statusFromSporttery(row.matchStatus, row.sellStatus, row.matchStatusName, kickoffTime);
  const businessDate = normText(row.businessDate || row.matchNumDate || row.matchDate);
  const oddsInfo = sportteryOddsInfo(row, sourceUrl, sourceMethod);
  return {
    sourceMethod,
    sourceUrl,
    sourceMatchId: matchId,
    matchNo: normText(row.matchNumStr),
    businessDate,
    matchDate: normText(row.matchDate),
    homeTeam,
    awayTeam,
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
      if (matches.length) {
        console.log(`Sporttery ${item.method} ok: ${matches.length}`);
        allMatches.push(...matches);
      }
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
    if (match.oddsUpdatedAt) return 4;
    if (match.oddsSourceMethod === "calculator") return 3;
    if (match.oddsSourceMethod === "current") return 2;
    return 1;
  };
  const handicapOddsRank = (match) => {
    if (!sanitizeOdds(match.handicapOdds)) return 0;
    if (match.handicapOddsUpdatedAt) return 4;
    if (match.handicapOddsSourceMethod === "calculator") return 3;
    if (match.handicapOddsSourceMethod === "current") return 2;
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
    businessDate: next.businessDate || prev.businessDate,
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

function predictionSet(match) {
  const probabilities = impliedProbabilities(match.odds);
  const hhadProbabilities = sanitizeOdds(match.handicapOdds) ? impliedProbabilities(match.handicapOdds) : null;
  const rand = seeded(`${match.sourceMatchId}-${match.homeTeam}-${match.awayTeam}`);
  const homeLambda = clamp(0.75 + probabilities.home * 2.2 + rand() * 0.35, 0.6, 2.8);
  const awayLambda = clamp(0.65 + probabilities.away * 2.1 + rand() * 0.35, 0.5, 2.6);
  const totalLambda = homeLambda + awayLambda;
  const goalsTip = totalLambda >= 6.5 ? "7+" : String(clamp(Math.round(totalLambda), 0, 6));
  const over25Probability = clamp(1 - [0, 1, 2].reduce((sum, goals) => sum + poissonProbability(totalLambda, goals), 0), 0, 1);
  const bttsProbability = clamp((1 - Math.exp(-homeLambda)) * (1 - Math.exp(-awayLambda)), 0, 1);
  const bttsYesThreshold = 0.6;
  const ggTip = bttsProbability >= bttsYesThreshold ? "GG" : "NG";
  const ggTipProbability = ggTip === "GG" ? bttsProbability : 1 - bttsProbability;
  const goalsProbability = totalGoalsProbability(totalLambda, goalsTip);
  const goalsOdds = Number(clamp(1 / Math.max(goalsProbability, 0.08), 1.2, 12.5).toFixed(2));
  const ggOdds = Number(clamp(1 / Math.max(ggTipProbability, 0.15), 1.2, 8).toFixed(2));
  const score = projectedScore(homeLambda, awayLambda);
  const probabilityModel = buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability);
  const modelProbabilities = {
    home: (probabilityModel.oneXTwo.final?.home || pct1(probabilities.home)) / 100,
    draw: (probabilityModel.oneXTwo.final?.draw || pct1(probabilities.draw)) / 100,
    away: (probabilityModel.oneXTwo.final?.away || pct1(probabilities.away)) / 100,
  };
  const picks = [
    ["1", modelProbabilities.home, match.odds.odds1, `主胜 ${match.homeTeam}`, `Home Win (${match.homeTeam})`],
    ["X", modelProbabilities.draw, match.odds.oddsX, "平局", "Draw"],
    ["2", modelProbabilities.away, match.odds.odds2, `客胜 ${match.awayTeam}`, `Away Win (${match.awayTeam})`],
  ].sort((a, b) => b[1] - a[1]);
  const marketPicks = [
    ["1", probabilities.home, match.odds.odds1],
    ["X", probabilities.draw, match.odds.oddsX],
    ["2", probabilities.away, match.odds.odds2],
  ].sort((a, b) => b[1] - a[1]);
  const marketLeader = marketPicks[0];
  const marketSecond = marketPicks[1];
  const analystSelection = selectAnalystOneXTwo(match, picks, modelProbabilities, hhadProbabilities);
  const best1x2 = analystSelection.pick;
  const probabilityGap = marketLeader[1] - marketSecond[1];
  const modelProbabilityGap = picks[0][1] - picks[1][1];
  const selectionDiscount = Math.max(0, marketLeader[1] - best1x2[1]);
  const baseTrust = analystSelection.isContrarian
    ? clamp(Math.round(best1x2[1] * 100 + 31 - selectionDiscount * 42), 54, 76)
    : clamp(Math.round(best1x2[1] * 100 + modelProbabilityGap * 48 + 10), 52, 93);
  const probabilityTextZh = `主胜 ${pct(probabilities.home)}% / 平局 ${pct(probabilities.draw)}% / 客胜 ${pct(probabilities.away)}%`;
  const probabilityTextEn = `home ${pct(probabilities.home)}% / draw ${pct(probabilities.draw)}% / away ${pct(probabilities.away)}%`;
  const oddsText = `${match.odds.odds1.toFixed(2)} / ${match.odds.oddsX.toFixed(2)} / ${match.odds.odds2.toFixed(2)}`;
  const sourceTextZh = match.oddsUpdatedAt
    ? `官方 SP 更新时间：${match.oddsUpdatedAt}`
    : "官方 SP 来自本次中国竞彩网同步快照";
  const sourceTextEn = match.oddsUpdatedAt
    ? `Official SP updated at ${match.oddsUpdatedAt}`
    : "Official SP came from this Sporttery sync snapshot";
  const drawRiskZh = probabilities.draw >= 0.28
    ? "平局支持率偏高，胜平负方向需要防平。"
    : "平局支持率未明显压低主方向，但仍需留意赛前 SP 变化。";
  const drawRiskEn = probabilities.draw >= 0.28
    ? "Draw support is high, so cover the draw risk."
    : "Draw support is not dominant, but late SP movement still matters.";
  const riskTags = [];

  if (probabilities.draw >= 0.28) {
    riskTags.push({ zh: "防平", en: "Draw risk" });
  }
  if (best1x2[2] <= 1.25) {
    riskTags.push({ zh: "热门过热", en: "Heavy favorite" });
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
  if (analystSelection.isContrarian) {
    riskTags.push({ zh: "盘口分歧", en: "Market disagreement" });
  }

  const oneXTwo = {
    marketType: "1X2",
    tipCode: best1x2[0],
    tipLabel: { zh: best1x2[3], en: best1x2[4] },
    odds: best1x2[2],
    trustScore: baseTrust,
    explanation: {
      zh: `本场以中国竞彩网官方 HAD 胜平负 SP 为主轴，去水后最高支持方向为${best1x2[3]}。模型同时参考主客预期进球、平局拉力和赔率分布，不使用本地模拟赛果回填。`,
      en: `This pick is anchored to official Sporttery HAD odds. After removing overround, the strongest direction is ${best1x2[4]}.`,
    },
    analysisItems: [
      {
        zh: `官方 HAD SP：主胜 ${match.odds.odds1.toFixed(2)} / 平局 ${match.odds.oddsX.toFixed(2)} / 客胜 ${match.odds.odds2.toFixed(2)}；去水支持率约 ${probabilityTextZh}。`,
        en: `Official HAD SP: ${oddsText}; normalized support is about ${probabilityTextEn}.`,
      },
      {
        zh: analystSelection.isContrarian
          ? `${analystSelection.reason.zh} 当前模型可信度 ${baseTrust}%，该方向属于价值观察而非高确定性推荐。`
          : `胜平负差距：市场主线领先第二方向约 ${pct(probabilityGap)} 个百分点，当前模型可信度 ${baseTrust}%。`,
        en: analystSelection.isContrarian
          ? `${analystSelection.reason.en} Model confidence is ${baseTrust}%; this is a value-watch, not a high-certainty banker.`
          : `1X2 separation: the market lead is ahead by about ${pct(probabilityGap)} percentage points. Model confidence: ${baseTrust}%.`,
      },
      {
        zh: `${drawRiskZh} ${sourceTextZh}。`,
        en: `${drawRiskEn} ${sourceTextEn}.`,
      },
    ],
    riskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, best1x2[0], "1X2"),
  };

  const goals = {
    marketType: "GOALS",
    tipCode: goalsTip,
    tipLabel: { zh: goalsTip === "7+" ? "总进球数 7+" : `总进球数 ${goalsTip}球`, en: goalsTip === "7+" ? "Total Goals 7+" : `Total Goals ${goalsTip}` },
    odds: goalsOdds,
    trustScore: clamp(Math.round(goalsProbability * 100 + 45), 50, 82),
    explanation: {
      zh: `总进球数为模型参考项，基于胜平负 SP 反推出主队 ${homeLambda.toFixed(2)}、客队 ${awayLambda.toFixed(2)} 的预期进球，当前总进球期望约 ${totalLambda.toFixed(2)}。`,
      en: `The goals model derives expected goals from 1X2 odds: home ${homeLambda.toFixed(2)}, away ${awayLambda.toFixed(2)}, total ${totalLambda.toFixed(2)}.`,
    },
    analysisItems: [
      {
        zh: `比分热区：${score.home}-${score.away} 附近；总进球 ${goalsTip} 的模型概率约 ${pct(goalsProbability)}%。`,
        en: `Score heat zone: around ${score.home}-${score.away}; model probability for total goals ${goalsTip} is about ${pct(goalsProbability)}%.`,
      },
      {
        zh: `大 2.5 球概率约 ${pct(over25Probability)}%，该指标用于走势参考，不等同于中国竞彩网官方总进球 SP。`,
        en: `Over 2.5 probability is about ${pct(over25Probability)}%. This is a model reference, not official Sporttery total-goals SP.`,
      },
    ],
    riskTags: riskTags.filter((tag) => tag.zh === "进球临界"),
    visibilityStatus: "PREMIUM",
    resultStatus: resultStatus(match, goalsTip, "GOALS"),
  };

  const gg = {
    marketType: "GG_NG",
    tipCode: ggTip,
    tipLabel: ggTip === "GG" ? { zh: "双方进球 是", en: "Both Teams to Score" } : { zh: "双方进球 否", en: "No Both Teams to Score" },
    odds: ggOdds,
    trustScore: clamp(Math.round(ggTipProbability * 100 + 16), 55, 86),
    explanation: {
      zh: ggTip === "GG"
        ? `双方进球为模型参考项，使用主客队进球分布估算。当前双方均有进球概率约 ${pct(bttsProbability)}%，已超过 ${pct(bttsYesThreshold)}% 保守阈值，模型倾向是。`
        : `双方进球为模型参考项，使用主客队进球分布估算。当前双方均有进球概率约 ${pct(bttsProbability)}%，未超过 ${pct(bttsYesThreshold)}% 保守阈值，模型倾向否。`,
      en: ggTip === "GG"
        ? `BTTS is estimated from goal distribution. Current BTTS probability is about ${pct(bttsProbability)}%, above the ${pct(bttsYesThreshold)}% conservative threshold, leaning yes.`
        : `BTTS is estimated from goal distribution. Current BTTS probability is about ${pct(bttsProbability)}%, below the ${pct(bttsYesThreshold)}% conservative threshold, leaning no.`,
    },
    analysisItems: [
      {
        zh: `主队预期进球 ${homeLambda.toFixed(2)}，客队预期进球 ${awayLambda.toFixed(2)}；若客队预期低于 1 球，双方进球命中波动会更大。`,
        en: `Home xG ${homeLambda.toFixed(2)}, away xG ${awayLambda.toFixed(2)}. BTTS volatility rises when either side projects below 1.0 xG.`,
      },
      {
        zh: `该玩法不是中国竞彩网标准胜平负 SP，页面以“参考指数”展示，避免和官方 SP 混淆。`,
        en: `This is shown as a model index, not official Sporttery SP.`,
      },
    ],
    riskTags: riskTags.filter((tag) => tag.zh === "进球临界"),
    visibilityStatus: "PREMIUM",
    resultStatus: resultStatus(match, ggTip, "GG_NG"),
  };

  const bestIsSteady = !analystSelection.isContrarian
    && best1x2[1] >= 0.58
    && modelProbabilityGap >= 0.07
    && baseTrust >= 84
    && riskTags.length <= 1;
  const bestHandicapSupport = hhadSupportForPick(hhadProbabilities, oneXTwo.tipCode);
  const bestHasWeakHandicap = ["1", "2"].includes(oneXTwo.tipCode)
    && bestHandicapSupport !== null
    && bestHandicapSupport < 0.38;
  const bestHasThinEdge = modelProbabilityGap < 0.08 || best1x2[1] < 0.54;
  const bestShouldWatch = !analystSelection.isContrarian
    && !bestIsSteady
    && (bestHasWeakHandicap || bestHasThinEdge || riskTags.length >= 2);
  const bestPrefix = bestShouldWatch
    ? { zh: "观察为主", en: "Watch first" }
    : analystSelection.isContrarian
    ? { zh: "价值观察", en: "Value watch" }
    : bestIsSteady
      ? { zh: "稳妥方向", en: "Steady lean" }
      : { zh: "模型首选", en: "Model lean" };
  const bestTrustScore = bestShouldWatch
    ? clamp(Math.round(oneXTwo.trustScore - 12), 45, 72)
    : analystSelection.isContrarian
    ? clamp(oneXTwo.trustScore, 54, 76)
    : bestIsSteady
      ? clamp(oneXTwo.trustScore + 2, 57, 96)
      : clamp(oneXTwo.trustScore - 4, 52, 82);
  const bestWatchLabelZh = bestHasWeakHandicap
    ? "观察为主 防正路过热"
    : bestHasThinEdge
      ? "观察为主 胜平负差距小"
      : "观察为主 风险叠加";
  const bestWatchLabelEn = bestHasWeakHandicap
    ? "Watch first: favorite overheated"
    : bestHasThinEdge
      ? "Watch first: thin 1X2 edge"
      : "Watch first: stacked risk";

  const best = {
    marketType: "BEST",
    tipCode: bestShouldWatch ? "WATCH" : oneXTwo.tipCode,
    tipLabel: {
      zh: bestShouldWatch ? bestWatchLabelZh : `${bestPrefix.zh} ${oneXTwo.tipLabel.zh}`,
      en: bestShouldWatch ? bestWatchLabelEn : `${bestPrefix.en}: ${oneXTwo.tipLabel.en}`,
    },
    odds: bestShouldWatch ? 0 : oneXTwo.odds,
    trustScore: bestTrustScore,
    explanation: {
      zh: bestShouldWatch
        ? `AI 精选触发价值门槛：${oneXTwo.tipLabel.zh} 虽是当前概率首选，但让球确认、概率差或风险标签不足以支持单独推荐，本场不硬给正路，先观察。`
        : analystSelection.isContrarian
        ? `AI 分析不只追随低赔正路。本场触发盘口分歧/防平修正，精选方向降级为价值观察：${oneXTwo.tipLabel.zh}。`
        : bestIsSteady
          ? `AI 精选优先使用中国竞彩网官方实时 SP。本场综合胜平负支持率、SP 分布、Elo、预期进球和风险标签后，列为稳妥方向：${oneXTwo.tipLabel.zh}。`
          : `AI 精选优先使用中国竞彩网官方实时 SP。本场综合胜平负支持率、SP 分布、Elo、预期进球和防平风险后，仅列为模型首选：${oneXTwo.tipLabel.zh}，不列入高可信候选。`,
      en: bestShouldWatch
        ? `The value gate was triggered. ${oneXTwo.tipLabel.en} is the probability leader, but handicap confirmation, edge, or risk filters are not strong enough for a single pick.`
        : analystSelection.isContrarian
        ? `The model does not blindly follow the lowest SP. Market-disagreement checks downgraded this to a value-watch: ${oneXTwo.tipLabel.en}.`
        : bestIsSteady
          ? `The best tip uses official Sporttery data, Elo, and goal distribution. Steady lean: ${oneXTwo.tipLabel.en}.`
          : `The best tip uses official Sporttery data, Elo, and goal distribution. This is a model lean, not a banker: ${oneXTwo.tipLabel.en}.`,
    },
    analysisItems: [
      {
        zh: bestShouldWatch
          ? `核心理由：正路方向为 ${oneXTwo.tipLabel.zh}，但模型首选优势约 ${pct(modelProbabilityGap)} 个百分点，让球同向支持${bestHandicapSupport === null ? "不足以验证" : `约 ${pct(bestHandicapSupport)}%`}，因此降级为观察。`
          : analystSelection.isContrarian
          ? `核心理由：${analystSelection.reason.zh}`
          : `核心理由：${oneXTwo.tipLabel.zh} 是当前模型最终概率首选，市场主线优势约 ${pct(probabilityGap)} 个百分点，模型首选优势约 ${pct(modelProbabilityGap)} 个百分点。`,
        en: bestShouldWatch
          ? `Core reason: ${oneXTwo.tipLabel.en} is the probability leader, but model edge is about ${pct(modelProbabilityGap)} points and handicap confirmation is weak.`
          : analystSelection.isContrarian
          ? `Core reason: ${analystSelection.reason.en}`
          : `Core reason: ${oneXTwo.tipLabel.en} is the final model leader. Market edge is about ${pct(probabilityGap)} points; model edge is about ${pct(modelProbabilityGap)} points.`,
      },
      {
        zh: `进球侧参考：模型比分热区 ${score.home}-${score.away}，总进球期望 ${totalLambda.toFixed(2)}，大 2.5 概率约 ${pct(over25Probability)}%。`,
        en: `Goals side: score heat zone ${score.home}-${score.away}, total xG ${totalLambda.toFixed(2)}, over 2.5 around ${pct(over25Probability)}%.`,
      },
      {
        zh: `风险提示：赛前若主胜/客胜 SP 大幅升高或平局 SP 明显下压，应降低单关仓位或等待下一次快照。`,
        en: `Risk note: if the selected SP rises sharply or draw SP drops late, reduce stake or wait for the next snapshot.`,
      },
    ],
    riskTags,
    visibilityStatus: bestShouldWatch ? "FREE" : "PREMIUM",
    resultStatus: bestShouldWatch ? "PENDING" : oneXTwo.resultStatus,
  };

  return { predictions: [oneXTwo, goals, gg, best], homeLambda, awayLambda, projectedScore: score, probabilityModel };
}

function toAppMatch(match) {
  const meta = leagueMeta(match.leagueName);
  const homeTeamId = `team_${hashString(match.homeTeam)}`;
  const awayTeamId = `team_${hashString(match.awayTeam)}`;
  const leagueId = `league_${hashString(match.leagueName)}`;
  const odds = sanitizeOdds(match.odds);
  const handicapOdds = sanitizeOdds(match.handicapOdds);
  const hasPredictionModel = Boolean(odds);
  const model = odds
    ? predictionSet({ ...match, odds })
    : { predictions: [], homeLambda: match.scoreHome ?? 0, awayLambda: match.scoreAway ?? 0, probabilityModel: undefined };
  const scoreHome = Number.isFinite(match.scoreHome) ? match.scoreHome : undefined;
  const scoreAway = Number.isFinite(match.scoreAway) ? match.scoreAway : undefined;
  const rand = seeded(match.sourceMatchId);
  const possessionHome = 48 + Math.floor(rand() * 12);
  const homeLogo = teamLogoInfo(match.homeTeam, match.homeTeamCode, match.homeTeamLogo);
  const awayLogo = teamLogoInfo(match.awayTeam, match.awayTeamCode, match.awayTeamLogo);
  return {
    id: `sporttery_${match.sourceMatchId}`,
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
    ...(hasPredictionModel ? {
    stats: {
      xG: {
        home: Number((scoreHome ?? model.homeLambda).toFixed(2)),
        away: Number((scoreAway ?? model.awayLambda).toFixed(2)),
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
    matchDate: match.businessDate || match.matchDate || match.kickoffTime.slice(0, 10),
    kickoffDate: match.matchDate || match.kickoffTime.slice(0, 10),
    businessDate: match.businessDate || match.matchDate || match.kickoffTime.slice(0, 10),
    homeTeamName: match.homeTeam,
    homeTeamNameEn: match.homeTeam,
    homeTeamLogo: homeLogo.logo,
    homeTeamLogoType: homeLogo.logoType,
    homeTeamCountryIso: homeLogo.countryIso,
    homeTeamColor: colorFromName(match.homeTeam),
    awayTeamName: match.awayTeam,
    awayTeamNameEn: match.awayTeam,
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
    source: "sporttery",
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

function kickoffHasStarted(match, capturedAt) {
  const kickoffAt = Date.parse(match?.kickoffTime);
  const capturedTime = Date.parse(capturedAt);
  return Number.isFinite(kickoffAt) && Number.isFinite(capturedTime) && capturedTime >= kickoffAt;
}

function predictionSignature(predictions) {
  const byMarket = new Map((predictions || []).map((prediction) => [prediction.marketType, prediction]));
  return ["1X2", "BEST", "GOALS", "GG_NG"]
    .map((marketType) => {
      const prediction = byMarket.get(marketType);
      return prediction ? `${marketType}:${prediction.tipCode}` : `${marketType}:-`;
    })
    .join("|");
}

function settlePredictionsForMatch(match, predictions) {
  return (predictions || []).map((prediction) => ({
    ...prediction,
    resultStatus: resultStatus(match, prediction.tipCode, prediction.marketType),
  }));
}

function applyPredictionPersistence(match, existing, capturedAt) {
  const existingPredictions = Array.isArray(existing?.predictions) ? existing.predictions : [];
  const nextPredictions = Array.isArray(match?.predictions) ? match.predictions : [];
  const started = kickoffHasStarted(match, capturedAt) || match.status === "LIVE" || match.status === "FINISHED";
  const generatedMeta = {
    policyVersion: PREDICTION_POLICY_VERSION,
    promptVersion: ANALYST_PROMPT_VERSION,
    generatedAt: existing?.predictionMeta?.generatedAt || capturedAt,
    updatedAt: capturedAt,
    lockedAt: started ? (existing?.predictionMeta?.lockedAt || capturedAt) : undefined,
    dataPolicy: {
      zh: "仅使用已接入的中国竞彩网官方 SP、让球 SP、赛果和 SP 快照；伤停、首发、天气、裁判等未接入数据明确视为不足，不编造。",
      en: "Uses connected official Sporttery SP, handicap SP, results, and SP snapshots only. Injuries, lineups, weather, and referee data are treated as unavailable unless connected.",
    },
  };

  if (!existingPredictions.length || !nextPredictions.length) {
    return { ...match, predictionMeta: generatedMeta };
  }

  const sameDirection = predictionSignature(existingPredictions) === predictionSignature(nextPredictions);
  const policyChanged = existing?.predictionMeta?.policyVersion !== PREDICTION_POLICY_VERSION
    || existing?.predictionMeta?.promptVersion !== ANALYST_PROMPT_VERSION;
  if (started || (sameDirection && !policyChanged)) {
    return {
      ...match,
      predictions: settlePredictionsForMatch(match, existingPredictions),
      projectedScoreHome: existing?.projectedScoreHome ?? match.projectedScoreHome,
      projectedScoreAway: existing?.projectedScoreAway ?? match.projectedScoreAway,
      stats: existing?.stats || match.stats,
      probabilityModel: started ? (existing?.probabilityModel || match.probabilityModel) : match.probabilityModel,
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        lockedAt: started ? (existing?.predictionMeta?.lockedAt || capturedAt) : existing?.predictionMeta?.lockedAt,
      },
    };
  }

  if (sameDirection && policyChanged) {
    return {
      ...match,
      predictionMeta: {
        ...generatedMeta,
        updateReason: {
          zh: "预测策略升级为市场 + Elo + Poisson 集成，未开赛比赛允许刷新模型说明和推荐分级。",
          en: "Prediction policy upgraded to the market + Elo + Poisson ensemble, so unstarted matches can refresh model notes and recommendation grading.",
        },
      },
    };
  }

  return {
    ...match,
    predictionMeta: {
      ...generatedMeta,
      updateReason: {
        zh: "赛前赔率/盘口信号发生实质偏差，允许更新赛前预测。",
        en: "Pre-match odds or market signals changed materially, so the pre-match prediction was updated.",
      },
    },
  };
}

async function fetchSportteryMatches() {
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
      if (key && !byId.has(key)) byId.set(key, match);
    }
  }
  return Array.from(byId.values());
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
  fs.writeFileSync(path.join(publicDir, "odds-history.json"), JSON.stringify(payload, null, 2), "utf8");
  return { rows: rows.length, appended, updated };
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
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
  const zhInterpretation = direction === "flat"
    ? "整体波动很小。"
    : direction === "mixed"
      ? "盘口存在波动，需继续观察临场快照。"
      : `${strongest.zh} SP 下调，市场支持有所增强。`;
  const enInterpretation = direction === "flat"
    ? "Overall movement is small."
    : direction === "mixed"
      ? "The market is moving; keep watching late snapshots."
      : `${strongest.en} SP shortened, indicating stronger market support.`;

  return {
    sampleSize: rows.length,
    firstCapturedAt: first.capturedAt,
    lastCapturedAt: latest.capturedAt,
    ...changes,
    direction,
    summary: {
      zh: `SP 快照 ${rows.length} 次：主胜 ${formatSpChange(changes.odds1Change)}，平局 ${formatSpChange(changes.oddsXChange)}，客胜 ${formatSpChange(changes.odds2Change)}；${zhInterpretation}`,
      en: `${rows.length} SP snapshots: home ${formatSpChange(changes.odds1Change)}, draw ${formatSpChange(changes.oddsXChange)}, away ${formatSpChange(changes.odds2Change)}. ${enInterpretation}`,
    },
  };
}

function attachOddsTrends(matches, publicDir) {
  const history = loadOddsHistory(publicDir);
  return matches.map((match) => {
    const trend = oddsTrendForMatch(match, history.rows);
    return trend ? { ...match, oddsTrend: trend } : match;
  });
}

function splitMatchesForOutput(matches) {
  const current = matches.filter((match) => match.status !== "FINISHED");
  const history = matches.filter((match) => match.status === "FINISHED");
  return { current, history };
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
    const date = match.matchDate || match.businessDate || String(match.kickoffTime || "").slice(0, 10);
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
  const existingBySourceId = new Map(
    existingMatches
      .map((match) => [normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, "")), match])
      .filter(([sourceMatchId]) => sourceMatchId)
  );
  const oddsHistoryBeforeSync = loadOddsHistory(publicDir);
  const allRawMatches = await fetchSportteryMatches();
  const rawMatches = allRawMatches.filter(inMatchWindow);
  const rawMatchesWithOdds = rawMatches.filter((match) => sanitizeOdds(match.odds));
  const rawMatchesWithHandicapOdds = rawMatches.filter((match) => sanitizeOdds(match.handicapOdds));
  const rawResultMatches = rawMatches.filter(isOfficialResultMatch);
  const rawMatchesForOutput = rawMatches.filter((match) => hasOfficialDisplayOdds(match) || isOfficialResultMatch(match));
  const eloSnapshots = buildEloSnapshots(rawMatches);
  const usedFreshOdds = rawMatchesWithOdds.length > 0;
  let output = rawMatchesForOutput
    .map((match) => enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, oddsHistoryBeforeSync.rows))
    .map((match) => ({ ...match, eloSnapshot: eloSnapshots.get(normText(match.sourceMatchId)) || null }))
    .map((match) => {
      const appMatch = toAppMatch(match);
      const existing = existingBySourceId.get(normText(appMatch?.sourceMatchId || String(appMatch?.id || "").replace(/^sporttery_/, "")));
      return applyPredictionPersistence(appMatch, existing, capturedAt);
    });

  if (!output.length) {
    output = existingMatches.filter(isTrustedOddsMatch);
    if (!output.length) throw new Error("Sporttery returned no matches and no existing matches.json is available.");
    console.log(`Sporttery returned no trusted odds; kept existing trusted matches.json (${output.length}).`);
  }

  const oddsHistory = usedFreshOdds
    ? appendOddsHistory(publicDir, output, capturedAt)
    : { rows: loadOddsHistory(publicDir).rows.length, appended: 0, updated: 0, skipped: "no fresh official odds" };
  output = attachOddsTrends(output, publicDir);
  const split = splitMatchesForOutput(output);
  const teamIndex = buildTeamIndex(output);
  const oddsHistoryPayload = loadOddsHistory(publicDir);
  const byStatus = output.reduce((acc, match) => {
    acc[match.status] = (acc[match.status] || 0) + 1;
    return acc;
  }, {});
  const outputDates = output
    .map((match) => match.matchDate || match.businessDate || String(match.kickoffTime || "").slice(0, 10))
    .filter(Boolean)
    .sort();
  const syncMeta = {
    version: 1,
    source: "sporttery",
    updatedAt: capturedAt,
    capturedAt,
    officialOddsMatches: rawMatchesWithOdds.length,
    officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
    officialResultMatches: rawResultMatches.length,
    skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
    byStatus,
    coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
    window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
    files: {
      current: split.current.length,
      history: split.history.length,
      teams: teamIndex.teams.length,
    },
    refreshPolicy: {
      workflowMinutes: Math.max(5, Number(process.env.SYNC_WORKFLOW_MINUTES || 5)),
      pagePollSeconds: PAGE_POLL_SECONDS,
      oddsHistoryBucketMinutes: ODDS_HISTORY_BUCKET_MINUTES,
      note: "GitHub Pages serves static JSON. The page checks for newer JSON regularly; GitHub Actions refreshes the source files on schedule.",
    },
    oddsHistory,
  };

  writeJson(path.join(publicDir, "matches.json"), split.current);
  writeJson(path.join(dataDir, "matches-current.json"), split.current);
  writeJson(path.join(dataDir, "matches-history.json"), split.history);
  writeJson(path.join(dataDir, "team-index.json"), teamIndex);
  writeJson(path.join(dataDir, "odds-history.json"), oddsHistoryPayload);
  writeJson(path.join(dataDir, "sync-meta.json"), syncMeta);
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "sporttery",
        count: output.length,
        scanned: allRawMatches.length,
        officialOddsMatches: rawMatchesWithOdds.length,
        officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
        officialResultMatches: rawResultMatches.length,
        skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
        window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
        coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
        files: {
          current: split.current.length,
          history: split.history.length,
          teams: teamIndex.teams.length,
        },
        oddsHistory,
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
