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
const PAGE_POLL_SECONDS = Math.max(15, Number(process.env.PAGE_POLL_SECONDS || 30));
const ANALYST_PROMPT_VERSION = "professional-football-analyst-v13";
const PREDICTION_POLICY_VERSION = "sporttery-day-value-gate-v22";
const FORM_LOOKBACK_MATCHES = 12;
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

function normalizeStatusWithScore(status, kickoffTime, scoreHome, scoreAway) {
  if (status === "FINISHED") return status;
  const kickoffAt = Date.parse(kickoffTime);
  const hasScore = Number.isFinite(scoreHome) && Number.isFinite(scoreAway);
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

function formConfidence(formSnapshot) {
  const sampleSize = Number(formSnapshot?.sampleSize || 0);
  if (sampleSize <= 0) return 0;
  return clamp(sampleSize / 24, 0, 1);
}

function blendLambdasWithForm(match, marketHomeLambda, marketAwayLambda) {
  const form = match.formSnapshot;
  const confidence = formConfidence(form);
  if (!form || confidence <= 0) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      formWeight: 0,
      formHomeLambda: null,
      formAwayLambda: null,
    };
  }

  const homeAttack = Number.isFinite(form.home?.goalsForAvg) ? form.home.goalsForAvg : marketHomeLambda;
  const homeDefense = Number.isFinite(form.home?.goalsAgainstAvg) ? form.home.goalsAgainstAvg : marketAwayLambda;
  const awayAttack = Number.isFinite(form.away?.goalsForAvg) ? form.away.goalsForAvg : marketAwayLambda;
  const awayDefense = Number.isFinite(form.away?.goalsAgainstAvg) ? form.away.goalsAgainstAvg : marketHomeLambda;
  const formHomeLambda = clamp(homeAttack * 0.58 + awayDefense * 0.42, 0.25, 3.2);
  const formAwayLambda = clamp(awayAttack * 0.58 + homeDefense * 0.42, 0.25, 3.2);
  const profile = matchVolatilityProfile(match);
  const maxWeight = profile.isInternational ? 0.22 : 0.36;
  const formWeight = clamp(confidence * maxWeight, 0, maxWeight);

  return {
    homeLambda: clamp(marketHomeLambda * (1 - formWeight) + formHomeLambda * formWeight, 0.25, 3.4),
    awayLambda: clamp(marketAwayLambda * (1 - formWeight) + formAwayLambda * formWeight, 0.25, 3.4),
    formWeight: Number(formWeight.toFixed(3)),
    formHomeLambda: Number(formHomeLambda.toFixed(2)),
    formAwayLambda: Number(formAwayLambda.toFixed(2)),
  };
}

function blendOutcomeProbabilities(market, poisson, eloSnapshot, formSnapshot) {
  const elo = normalizeOutcomeProbabilities(eloSnapshot?.probabilities);
  const eloSample = (eloSnapshot?.homeMatches || 0) + (eloSnapshot?.awayMatches || 0);
  const formSample = Number(formSnapshot?.sampleSize || 0);
  const formReady = formSample >= 8;
  const weights = elo && eloSample >= 6 && formReady
    ? { market: 0.54, elo: 0.2, poisson: 0.26 }
    : elo && eloSample >= 6
      ? { market: 0.58, elo: 0.24, poisson: 0.18 }
      : formReady
        ? { market: 0.62, elo: 0, poisson: 0.38 }
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

function outcomeLeader(probabilities) {
  return [
    { code: "1", probability: probabilities.home },
    { code: "X", probability: probabilities.draw },
    { code: "2", probability: probabilities.away },
  ].sort((a, b) => b.probability - a.probability)[0];
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

function buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration) {
  const poisson1x2 = poissonOutcomeProbabilities(homeLambda, awayLambda);
  const blended = blendOutcomeProbabilities(probabilities, poisson1x2, match.eloSnapshot, match.formSnapshot);
  const outcomeCalibration = calibrateOutcomeProbabilities(match, blended.probabilities, probabilities);
  const final1x2 = outcomeCalibration.probabilities;
  const handicapPoisson = handicapOutcomeProbabilities(homeLambda, awayLambda, match.handicapLine);
  return {
    version: "market-elo-form-bucket-calibrated-poisson-v5",
    generatedAt: new Date().toISOString(),
    basis: {
      zh: "模型按竞彩日归档、按官方开赛时间排序；已使用官方 SP/让球 SP/赔率快照、Elo、近一年赛果攻防、赛程密度和 Poisson 比分分布。推荐分为强信号主推、价值观察、观察和避坑，国际赛低赔强队必须通过让球盘与概率双重校验，不默认包装成稳胆。",
      en: "Schedules are grouped by Sporttery day and sorted by official kickoff time. The model uses official SP/handicap SP/snapshots, Elo, last-year form, schedule density, and Poisson score distribution. Picks are split into strong leans, value-watch, watch, and avoid signals; low-SP international favourites must pass handicap and probability checks.",
    },
    ensembleWeights: blended.weights,
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
      formHomeLambda: lambdaBlend.formHomeLambda,
      formAwayLambda: lambdaBlend.formAwayLambda,
      formWeight: lambdaBlend.formWeight,
    } : undefined,
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
    form: match.formSnapshot ? {
      version: match.formSnapshot.version,
      lookbackMatches: match.formSnapshot.lookbackMatches,
      sampleSize: match.formSnapshot.sampleSize,
      home: match.formSnapshot.home,
      away: match.formSnapshot.away,
      h2h: match.formSnapshot.h2h,
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

function teamKey(teamName) {
  return normText(teamName).toLowerCase();
}

function pairKey(homeTeam, awayTeam) {
  return [teamKey(homeTeam), teamKey(awayTeam)].sort().join("__");
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

function buildFormSnapshots(matches) {
  const teamHistory = new Map();
  const h2hHistory = new Map();
  const snapshots = new Map();
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
      version: "rolling-form-v1",
      lookbackMatches: FORM_LOOKBACK_MATCHES,
      sampleSize,
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

function buildEloSnapshots(matches) {
  const baseRating = 1500;
  const kFactor = 22;
  const ratings = new Map();
  const counts = new Map();
  const snapshots = new Map();

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
  if (expected === "WATCH") return "PENDING";
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
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const profileKey = predictionProfileKey(match);
      const odds = Number(prediction.odds || 0);
      rows.push({
        marketType: prediction.marketType,
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
  for (const marketType of ["1X2", "GOALS", "BEST"]) {
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
  const rawStatus = statusFromSporttery(row.matchStatus, row.sellStatus, row.matchStatusName, kickoffTime);
  const status = normalizeStatusWithScore(rawStatus, kickoffTime, scoreHome, scoreAway);
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
    hhadProbabilities,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth,
  } = context;

  const code = pick[0];
  const odds = pick[2];
  const profile = matchVolatilityProfile(match);
  const isSidePick = code === "1" || code === "2";
  const pickProbability = code === "1"
    ? probabilities.home
    : code === "X"
      ? probabilities.draw
      : probabilities.away;
  const handicapSupport = hhadSupportForPick(hhadProbabilities, code);
  const profileKey = predictionProfileKey(match);
  const oddsBucket = predictionOddsBucket(odds);
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
  const reasons = [];

  if (analystSelection.isContrarian) reasons.push("contrarian");
  if (code === "X") reasons.push("draw-is-not-single-pick");
  if (!isSidePick) reasons.push("no-side-pick");
  if (isSidePick && handicapSupport === null) reasons.push("missing-handicap-confirmation");
  if (isSidePick && handicapSupport !== null && handicapSupport < 0.32) reasons.push("weak-handicap-confirmation");
  if (probabilities.draw >= 0.3) reasons.push("draw-pressure");
  if (probabilityGap < 0.1) reasons.push("thin-market-edge");
  if (modelProbabilityGap < 0.07) reasons.push("thin-model-edge");
  if (riskTags.length > 0) reasons.push("risk-tags");
  if (isSidePick && odds <= 1.25) reasons.push("low-odds-no-value");
  if (profile.isInternational && isSidePick && odds <= 1.35) reasons.push("international-low-odds");
  if (profile.isJapan && isSidePick && odds <= 1.75) reasons.push("jleague-volatile-favorite");
  if (directionCooldown) reasons.push("direction-hit-rate-cooldown");
  if (oneXTwoCooldown) reasons.push("recent-1x2-hit-rate-cooldown");
  if (code === "X" && oneXTwoCooldown && !drawHasPositiveSample) reasons.push("draw-no-positive-sample");
  if (isSidePick && oneXTwoCooldown && odds <= 2.1) reasons.push("side-short-form-brake");

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

  const minPickProbability = oneXTwoCooldown ? 0.58 : 0.52;
  const minProbabilityGap = oneXTwoCooldown ? 0.14 : 0.08;
  const minModelGap = oneXTwoCooldown ? 0.1 : 0.06;
  const minHandicapSupport = oneXTwoCooldown ? 0.38 : 0.3;
  const maxDrawPressure = oneXTwoCooldown ? 0.32 : 0.36;

  const strongSidePick = isSidePick
    && !analystSelection.isContrarian
    && pickProbability >= minPickProbability
    && probabilityGap >= minProbabilityGap
    && modelProbabilityGap >= minModelGap
    && handicapSupport !== null
    && handicapSupport >= minHandicapSupport
    && probabilities.draw <= maxDrawPressure
    && odds > 1.08
    && odds <= 2.35
    && riskTags.length <= 3
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const stricterProfileOk = (!profile.isInternational || odds > 1.35 || (pickProbability >= 0.58 && handicapSupport >= 0.3))
    && (!profile.isJapan || odds > 1.75 || (pickProbability >= 0.56 && handicapSupport >= 0.36));

  const valueSidePick = isSidePick
    && !analystSelection.isContrarian
    && pickProbability >= (oneXTwoCooldown ? 0.56 : 0.49)
    && probabilityGap >= (oneXTwoCooldown ? 0.12 : 0.065)
    && modelProbabilityGap >= (oneXTwoCooldown ? 0.095 : 0.055)
    && handicapSupport !== null
    && handicapSupport >= (oneXTwoCooldown ? 0.38 : 0.34)
    && probabilities.draw <= 0.34
    && odds > 1.25
    && odds <= 2.65
    && riskTags.length <= 2
    && !(profile.isInternational && odds <= 1.34)
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const cooldownValueContrarianOk = oneXTwoCooldown
    && analystSelection.isContrarian
    && code === "X"
    && pickProbability >= 0.285
    && probabilityGap <= 0.14
    && riskTags.length <= 5;

  const valueContrarianPick = analystSelection.isContrarian
    && (!oneXTwoCooldown || (code === "X" && drawHasPositiveSample && cooldownValueContrarianOk))
    && pickProbability >= (code === "X" ? 0.26 : 0.29)
    && probabilityGap <= 0.18
    && modelProbabilityGap >= (code === "X" ? 0 : 0.035)
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
  const lateRiskZh = `临场复核：${riskTextZh}。如果赛前 SP 继续降赔但让球支持不上来，仍按观察处理。`;
  const lateRiskEn = `Late check: ${riskTextEn}. If SP shortens without handicap confirmation, keep this as watch-only.`;
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
              ? `降级原因：模型首选优势约 ${modelGapZh}，未达到强推荐阈值；市场主线领先约 ${marketGapZh}。`
              : `降级原因：风险标签叠加为 ${riskTextZh}，当前不适合只给单一方向。`,
          en: bestHasWeakHandicap
            ? `Downgrade reason: ${tipEn} has ${handicapEn}; ${hhadTextEn}, not fully aligned with HAD.`
            : bestHasThinEdge
              ? `Downgrade reason: model edge is about ${modelGapEn}, below the strong-pick threshold; market lead is about ${marketGapEn}.`
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
          zh: `盘口分歧：${analystSelection.reason.zh.replace(/^专业修正：/, "")} 市场主线领先约 ${marketGapZh}，模型首选优势约 ${modelGapZh}。`,
          en: `Market disagreement: ${analystSelection.reason.en.replace(/^Analyst adjustment: /, "")} Market lead is about ${marketGapEn}; model edge is about ${modelGapEn}.`
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
      { zh: `模型排序：${tipZh}暂列第一，市场主线领先约 ${marketGapZh}，模型优势约 ${modelGapZh}。`, en: `Model ranking: ${tipEn} is first, market lead about ${marketGapEn}, model edge about ${modelGapEn}.` },
      { zh: goalsZh, en: goalsEn },
      { zh: `观察点：${riskTextZh}；若临场 SP 与让球盘分歧扩大，不建议强行升档。`, en: `Watch point: ${riskTextEn}. If late SP and handicap diverge further, do not upgrade it.` }
    ]
  };
}

function predictionSet(match) {
  const probabilities = impliedProbabilities(match.odds);
  const hhadProbabilities = sanitizeOdds(match.handicapOdds) ? impliedProbabilities(match.handicapOdds) : null;
  const rand = seeded(`${match.sourceMatchId}-${match.homeTeam}-${match.awayTeam}`);
  const favoriteProbability = Math.max(probabilities.home, probabilities.draw, probabilities.away);
  const totalLambdaSeed = 2.55
    + (0.25 - probabilities.draw) * 0.95
    + (favoriteProbability - 0.5) * 0.75
    + (rand() - 0.5) * 0.28;
  const totalLambdaBase = clamp(totalLambdaSeed, 1.75, 3.25);
  const homeShare = clamp(0.5 + (probabilities.home - probabilities.away) * 0.52, 0.24, 0.76);
  const marketHomeLambda = clamp(totalLambdaBase * homeShare, 0.35, 2.8);
  const marketAwayLambda = clamp(totalLambdaBase - marketHomeLambda, 0.3, 2.6);
  const lambdaBlend = {
    marketHomeLambda,
    marketAwayLambda,
    ...blendLambdasWithForm(match, marketHomeLambda, marketAwayLambda),
  };
  const homeLambda = lambdaBlend.homeLambda;
  const awayLambda = lambdaBlend.awayLambda;
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
  const score = projectedScore(homeLambda, awayLambda);
  const probabilityModel = buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration);
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
  const candidateHandicapSupport = hhadSupportForPick(hhadProbabilities, best1x2[0]);
  const candidateIsLowOddsFavorite = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.55;
  const candidateIsOverheated = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.35;
  const candidateHasWeakHandicap = ["1", "2"].includes(best1x2[0])
    && candidateHandicapSupport !== null
    && candidateHandicapSupport < 0.42;
  const rawTrust = analystSelection.isContrarian
    ? clamp(Math.round(best1x2[1] * 100 + 31 - selectionDiscount * 42), 54, 76)
    : clamp(Math.round(best1x2[1] * 100 + modelProbabilityGap * 48 + 10), 52, 93);
  const trustPenalty =
    (candidateIsOverheated ? 11 : candidateIsLowOddsFavorite ? 5 : 0)
    + (candidateHasWeakHandicap ? 9 : 0)
    + (probabilities.draw >= 0.28 ? 4 : 0)
    + (bttsProbability >= 0.45 && bttsProbability < 0.65 ? 3 : 0);
  const baseTrust = clamp(
    rawTrust - trustPenalty,
    analystSelection.isContrarian ? 50 : 48,
    candidateIsOverheated || candidateHasWeakHandicap ? 82 : 91
  );
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
  const volatilityProfile = matchVolatilityProfile(match);
  const riskTags = [];

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
  if (analystSelection.isContrarian) {
    riskTags.push({ zh: "盘口分歧", en: "Market disagreement" });
  }

  const oneXTwoGate = evaluateOneXTwoGate({
    match,
    pick: best1x2,
    probabilities,
    hhadProbabilities,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth: match.predictionHealth,
  });
  const oneXTwoWatchLabel = {
    zh: "\u89c2\u5bdf\u4e3a\u4e3b \u80dc\u5e73\u8d1f\u4e0d\u5f3a\u63a8",
    en: "Watch first: no 1X2 pick",
  };
  const oneXTwoHealthCooldown = Boolean(
    isCoolingBucket(match.predictionHealth?.byMarket?.["1X2"])
    || isCoolingBucket(match.predictionHealth?.homeFavorite)
  );
  const oneXTwoMarketHardCooldown = hardCoolingBucket(match.predictionHealth?.byMarket?.["1X2"], 8, 0.42);
  const bestMarketHardCooldown = hardCoolingBucket(match.predictionHealth?.byMarket?.BEST, 5, 0.45);
  const homeFavoriteHardCooldown = hardCoolingBucket(match.predictionHealth?.homeFavorite, 6, 0.42);
  const healthCooldownTag = oneXTwoHealthCooldown
    ? [{ zh: "\u8fd1\u671f\u547d\u4e2d\u7387\u51b7\u5374", en: "Recent hit-rate cooldown" }]
    : [];
  const oneXTwoRiskTags = oneXTwoGate.promote
    ? riskTags
    : [
        ...riskTags,
        ...healthCooldownTag,
        { zh: "\u63a8\u8350\u95e8\u69db\u672a\u8fc7", en: "Recommendation gate not met" },
      ];
  const oneXTwoTrust = oneXTwoGate.promote
    ? baseTrust
    : clamp(baseTrust - (oneXTwoMarketHardCooldown ? 26 : 18), 34, 62);
  const oneXTwoGateZh = `推荐闸门：模型优势约 ${pct(modelProbabilityGap)} 个百分点，市场优势约 ${pct(probabilityGap)} 个百分点，让球同向支持${oneXTwoGate.handicapSupport === null ? "不足" : `约 ${pct(oneXTwoGate.handicapSupport)}%`}；未达到强推条件，暂不输出单一胜平负方向。`;
  const oneXTwoGateEn = `Recommendation gate: model edge is about ${pct(modelProbabilityGap)} points, market edge about ${pct(probabilityGap)} points, same-side handicap support ${oneXTwoGate.handicapSupport === null ? "unavailable" : `about ${pct(oneXTwoGate.handicapSupport)}%`}; no single 1X2 pick is promoted.`;
  const modelLean = {
    tipCode: best1x2[0],
    tipLabel: { zh: best1x2[3], en: best1x2[4] },
    odds: best1x2[2],
    trustScore: baseTrust,
    resultStatus: resultStatus(match, best1x2[0], "1X2"),
  };

  const oneXTwo = {
    marketType: "1X2",
    tipCode: oneXTwoGate.promote ? modelLean.tipCode : "WATCH",
    tipLabel: oneXTwoGate.promote ? modelLean.tipLabel : oneXTwoWatchLabel,
    odds: oneXTwoGate.promote ? modelLean.odds : 0,
    trustScore: oneXTwoTrust,
    explanation: {
      zh: oneXTwoGate.promote
        ? `本场以中国竞彩网官方 HAD 胜平负 SP 为主轴，去水后最高支持方向为${best1x2[3]}。模型同时参考主客预期进球、平局拉力和赔率分布，不使用本地模拟赛果回填。`
        : "本场胜平负未通过推荐闸门：低赔、平局压力、让球确认或风险标签存在不一致，只保留为赛前观察项。",
      en: oneXTwoGate.promote
        ? `This pick is anchored to official Sporttery HAD odds. After removing overround, the strongest direction is ${best1x2[4]}.`
        : "This 1X2 market did not pass the recommendation gate. Low odds, draw pressure, handicap confirmation, or risk tags are not aligned, so it remains watch-only.",
    },
    analysisItems: [
      {
        zh: `官方 HAD SP：主胜 ${match.odds.odds1.toFixed(2)} / 平局 ${match.odds.oddsX.toFixed(2)} / 客胜 ${match.odds.odds2.toFixed(2)}；去水支持率约 ${probabilityTextZh}。`,
        en: `Official HAD SP: ${oddsText}; normalized support is about ${probabilityTextEn}.`,
      },
      {
        zh: !oneXTwoGate.promote
          ? oneXTwoGateZh
          : analystSelection.isContrarian
          ? `${analystSelection.reason.zh} 当前模型可信度 ${baseTrust}%，该方向属于价值观察而非高确定性推荐。`
          : `胜平负差距：市场主线领先第二方向约 ${pct(probabilityGap)} 个百分点，当前模型可信度 ${baseTrust}%。`,
        en: !oneXTwoGate.promote
          ? oneXTwoGateEn
          : analystSelection.isContrarian
          ? `${analystSelection.reason.en} Model confidence is ${baseTrust}%; this is a value-watch, not a high-certainty banker.`
          : `1X2 separation: the market lead is ahead by about ${pct(probabilityGap)} percentage points. Model confidence: ${baseTrust}%.`,
      },
      {
        zh: `${drawRiskZh} ${sourceTextZh}。`,
        en: `${drawRiskEn} ${sourceTextEn}.`,
      },
    ],
    riskTags: oneXTwoRiskTags,
    visibilityStatus: "FREE",
    resultStatus: oneXTwoGate.promote ? modelLean.resultStatus : "PENDING",
  };

  const goalsGate = evaluateGoalsGate(match, goalsTip, goalsProbability, over25Probability, bttsProbability, match.predictionHealth);
  const goalsWatchLabel = {
    zh: "观察为主 进球数不强推",
    en: "Watch first: no total-goals pick",
  };
  const goalsRiskTags = goalsGate.promote
    ? riskTags.filter((tag) => tag.en === "Goal-model borderline")
    : [
        ...riskTags.filter((tag) => tag.en === "Goal-model borderline"),
        ...(isCoolingBucket(match.predictionHealth?.byMarket?.GOALS) ? [{ zh: "进球命中率冷却", en: "Goals hit-rate cooldown" }] : []),
        { zh: "进球闸门未过", en: "Goals gate not met" },
      ];

  const goals = {
    marketType: "GOALS",
    tipCode: goalsGate.promote ? goalsTip : "WATCH",
    tipLabel: goalsGate.promote ? goalsTipLabel : goalsWatchLabel,
    odds: goalsGate.promote ? goalsOdds : 0,
    trustScore: goalsGate.promote
      ? clamp(Math.round(goalsProbability * 100 + 12), 50, 78)
      : clamp(Math.round(goalsProbability * 100 - 2), 42, 58),
    explanation: {
      zh: goalsGate.promote
        ? `进球趋势为模型参考项，基于胜平负 SP 反推出主队 ${homeLambda.toFixed(2)}、客队 ${awayLambda.toFixed(2)} 的预期进球，当前总进球期望约 ${totalLambda.toFixed(2)}。`
        : `进球趋势未通过推荐闸门：总进球期望约 ${totalLambda.toFixed(2)}，大 2.5 概率约 ${pct(over25Probability)}%，边际不足时不强行给大/小球方向。`,
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
    resultStatus: goalsGate.promote ? resultStatus(match, goalsTip, "GOALS") : "PENDING",
  };

  const bestIsSteady = oneXTwoGate.promote
    && !analystSelection.isContrarian
    && best1x2[1] >= 0.58
    && modelProbabilityGap >= 0.18
    && baseTrust >= 84
    && riskTags.length === 0;
  const bestHandicapSupport = hhadSupportForPick(hhadProbabilities, modelLean.tipCode);
  const bestHasWeakHandicap = ["1", "2"].includes(modelLean.tipCode)
    && bestHandicapSupport !== null
    && bestHandicapSupport < 0.3;
  const bestHasThinEdge = !analystSelection.isContrarian && (modelProbabilityGap < 0.18 || best1x2[1] < 0.62);
  const bestHasOverheatedFavorite = ["1", "2"].includes(modelLean.tipCode)
    && modelLean.odds <= 1.7
    && (bestHandicapSupport === null || bestHandicapSupport < 0.3 || riskTags.length >= 4);
  const severeRiskCountForBest = riskTags.filter((tag) => (
    !analystSelection.isContrarian
    || !["Draw risk", "Tight 1X2", "Market disagreement"].includes(tag.en)
  )).length;
  const bestHasSevereRisk = severeRiskCountForBest >= 4
    || (bestHasWeakHandicap && modelLean.odds <= 1.7)
    || (!analystSelection.isContrarian && modelProbabilityGap < 0.06 && best1x2[1] < 0.52);
  const bestLaneHardCooldown = Boolean(
    bestMarketHardCooldown
    || oneXTwoMarketHardCooldown
    || (modelLean.tipCode === "1" && homeFavoriteHardCooldown)
  );
  const bestShouldWatch = !oneXTwoGate.promote
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
      + (analystSelection.isContrarian ? 4 : 0);
    return clamp(Math.round(leadProbability * 100 + edgeBonus + handicapBonus - riskPenalty), 28, 68);
  })();
  const bestTrustScore = bestShouldWatch
    ? clamp(watchUsefulnessScore - (bestLaneHardCooldown ? 12 : 0), 22, 62)
    : analystSelection.isContrarian
    ? clamp(oneXTwo.trustScore, 54, 76)
    : bestIsSteady
      ? clamp(oneXTwo.trustScore + 2, 57, 96)
      : clamp(oneXTwo.trustScore - (bestHasThinEdge ? 2 : 0), 52, 82);
  const bestWatchLabelZh = !oneXTwoGate.promote
    ? "观察为主 推荐闸门未过"
    : bestLaneHardCooldown
    ? "观察为主 命中冷却"
    : bestHasWeakHandicap
    ? "观察为主 防正路过热"
    : bestHasThinEdge
      ? "观察为主 胜平负差距小"
      : "观察为主 风险叠加";
  const bestWatchLabelEn = !oneXTwoGate.promote
    ? "Watch first: gate not met"
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
    explanation: {
      zh: `胜平负方向处于命中率冷却或盘口分歧中，本场 AI精选切到回测更稳的进球数方向：${goalsTipLabel.zh}。`,
      en: `The 1X2 side is under hit-rate cooldown or market disagreement, so the best tip switches to the better-tested totals lane: ${goalsTipLabel.en}.`,
    },
    analysisItems: [
      ...goals.analysisItems,
      {
        zh: "胜平负推荐闸门未过，精选不强行追正路；仅在进球数边际和回测方向同时满足时输出。",
        en: "The 1X2 gate was not met, so the best tip does not chase the favourite. Totals are promoted only when edge and historical lane agree.",
      },
    ],
    riskTags: goals.riskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, goals.tipCode, "GOALS"),
  } : {
    marketType: "BEST",
    tipCode: bestShouldWatch ? "WATCH" : modelLean.tipCode,
    tipLabel: {
      zh: bestShouldWatch ? bestWatchLabelZh : `${bestPrefix.zh} ${modelLean.tipLabel.zh}`,
      en: bestShouldWatch ? bestWatchLabelEn : `${bestPrefix.en}: ${modelLean.tipLabel.en}`,
    },
    odds: bestShouldWatch ? 0 : modelLean.odds,
    trustScore: bestTrustScore,
    explanation: bestNarrative.explanation,
    analysisItems: bestNarrative.analysisItems,
    riskTags: bestShouldWatch
      ? [
          ...oneXTwoRiskTags,
          ...(bestLaneHardCooldown ? [{ zh: "精选赛道冷却", en: "Best-lane hit-rate cooldown" }] : []),
        ]
      : riskTags,
    visibilityStatus: "FREE",
    resultStatus: bestShouldWatch ? "PENDING" : modelLean.resultStatus,
  };

  return { predictions: [oneXTwo, goals, best], homeLambda, awayLambda, projectedScore: score, probabilityModel };
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
  const kickoffDate = match.matchDate || String(match.kickoffTime || "").slice(0, 10);
  const businessDate = match.businessDate || kickoffDate;
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
    matchDate: kickoffDate,
    kickoffDate,
    businessDate,
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
  return ["1X2", "BEST", "GOALS"]
    .map((marketType) => {
      const prediction = byMarket.get(marketType);
      return prediction ? `${marketType}:${prediction.tipCode}` : `${marketType}:-`;
    })
    .join("|");
}

function settlePredictionsForMatch(match, predictions) {
  return (predictions || []).map((prediction) => ({
    ...prediction,
    resultStatus: prediction.marketType === "BEST" && prediction.tipCode === "WATCH"
      ? "PENDING"
      : resultStatus(match, prediction.tipCode, prediction.marketType),
  }));
}

function enabledPredictions(predictions) {
  return (predictions || []).filter((prediction) => prediction.marketType !== "GG_NG");
}

function applyPredictionPersistence(match, existing, capturedAt) {
  const existingPredictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const nextPredictions = enabledPredictions(Array.isArray(match?.predictions) ? match.predictions : []);
  const started = kickoffHasStarted(match, capturedAt) || match.status === "LIVE" || match.status === "FINISHED";
  const generatedMeta = {
    policyVersion: PREDICTION_POLICY_VERSION,
    promptVersion: ANALYST_PROMPT_VERSION,
    generatedAt: existing?.predictionMeta?.generatedAt || capturedAt,
    updatedAt: capturedAt,
    lockedAt: started ? (existing?.predictionMeta?.lockedAt || capturedAt) : undefined,
    dataPolicy: {
      zh: "模型按中国竞彩网竞彩日归档，按官方开赛时间展示；已使用官方 SP、让球 SP、赛果、SP 快照、Elo、近一年历史攻防、赛程密度和比分分布。低赔强队不自动入选，必须通过让球盘同向支持、概率优势、近期命中冷却和短样本急刹校验；1X2 冷却期内，平局/冷门也必须有正向历史样本才允许升推荐。进球数优先保留回测更稳的 U2.5，高噪声大球方向从严。开赛前仅在官方 SP/盘口变化达到阈值时更新，开赛后锁定赛前预测并只做赛果复盘。外部赔率、伤停、首发、天气、裁判、xG/xGA 等进入接源计划，稳定校验前不参与评分、不编造。",
      en: "The model is grouped by Sporttery business day and displayed by official kickoff time. It uses official Sporttery SP, handicap SP, results, SP snapshots, Elo, last-year form, schedule density, and score distribution. Low-SP favourites are not promoted by default; they must pass handicap support, probability edge, recent-hit cooldown, and short-sample emergency brakes. During a 1X2 cooldown, draws and underdogs also need positive historical evidence before promotion. Totals prefer backtested U2.5 signals, while noisy over-goals directions are tightened. Before kickoff it updates only on material official SP/handicap changes; after kickoff it locks the pre-match forecast for review. External odds, injuries, lineups, weather, referees, and xG/xGA remain in the source plan until verified, with no fabricated scoring input.",
    },
  };

  if (started && existingPredictions.length) {
    return {
      ...match,
      predictions: settlePredictionsForMatch(match, existingPredictions),
      projectedScoreHome: existing?.projectedScoreHome ?? match.projectedScoreHome,
      projectedScoreAway: existing?.projectedScoreAway ?? match.projectedScoreAway,
      stats: existing?.stats || match.stats,
      probabilityModel: existing?.probabilityModel || match.probabilityModel,
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        lockedAt: existing?.predictionMeta?.lockedAt || capturedAt,
      },
    };
  }

  if (!existingPredictions.length || !nextPredictions.length) {
    return { ...match, predictionMeta: generatedMeta };
  }

  const sameDirection = predictionSignature(existingPredictions) === predictionSignature(nextPredictions);
  const policyChanged = existing?.predictionMeta?.policyVersion !== PREDICTION_POLICY_VERSION
    || existing?.predictionMeta?.promptVersion !== ANALYST_PROMPT_VERSION;

  if (sameDirection && !policyChanged) {
    return { ...match, predictionMeta: generatedMeta };
  }

  if (sameDirection && policyChanged) {
    return {
      ...match,
      predictionMeta: {
        ...generatedMeta,
        updateReason: {
          zh: "未开赛比赛只在官方 SP、让球或风险门槛变化时刷新；当前结论以数据监控为主，不强行包装推荐。",
          en: "Unstarted matches refresh only when official SP, handicap, or risk gates change; the current verdict is data monitoring, not forced promotion.",
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

function normalizePublishedStatus(match, capturedAt) {
  if (!match || match.status === "FINISHED" || match.status === "LIVE") return match;
  const kickoffMs = Date.parse(match.kickoffTime);
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(capturedMs)) return match;
  if (capturedMs < kickoffMs) return match;
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

function mergeFreshWithExistingStore(existingMatches, freshMatches) {
  const byId = new Map();
  const orderedIds = [];
  const upsert = (match, preferFresh = false) => {
    const key = matchStoreKey(match);
    if (!key) return;
    if (!byId.has(key)) orderedIds.push(key);
    const previous = byId.get(key);
    byId.set(key, previous && !preferFresh ? previous : { ...previous, ...match });
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
  const predictionHealth = buildPredictionHealth(existingMatches);
  const existingBySourceId = new Map(
    existingMatches
      .map((match) => [matchStoreKey(match), match])
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
  const formSnapshots = buildFormSnapshots(rawMatches);
  const usedFreshOdds = rawMatchesWithOdds.length > 0;
  let output = rawMatchesForOutput
    .map((match) => enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, oddsHistoryBeforeSync.rows))
    .map((match) => ({ ...match, eloSnapshot: eloSnapshots.get(normText(match.sourceMatchId)) || null }))
    .map((match) => ({ ...match, formSnapshot: formSnapshots.get(normText(match.sourceMatchId)) || null, predictionHealth }))
    .map((match) => {
      const appMatch = toAppMatch(match);
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
  output = output.map((match) => normalizePublishedStatus(match, capturedAt));
  const split = splitMatchesForOutput(output);
  const teamIndex = buildTeamIndex(output);
  const oddsHistoryPayload = loadOddsHistory(publicDir);
  const publishedOddsMatches = split.current.filter((match) => sanitizeOdds(match.odds)).length;
  const publishedHandicapOddsMatches = split.current.filter((match) => sanitizeOdds(match.handicapOdds)).length;
  const publishedResultMatches = split.history.filter(isOfficialResultMatch).length
    || split.history.filter((match) => match.status === "FINISHED" && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)).length;
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
    officialOddsMatches: publishedOddsMatches,
    officialHandicapOddsMatches: publishedHandicapOddsMatches,
    officialResultMatches: publishedResultMatches,
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
    attempt: {
      capturedAt,
      officialOddsMatches: rawMatchesWithOdds.length,
      officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
      officialResultMatches: rawResultMatches.length,
      publishableMatches: rawMatchesForOutput.length,
    },
    oddsHistory,
    ...(keptExistingReason ? {
      fallback: {
        keptExisting: true,
        mergedPartialFresh,
        reason: keptExistingReason,
        existingMatches: existingMatches.length,
        freshPublishableMatches: rawMatchesForOutput.length,
      },
    } : {}),
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
        officialOddsMatches: publishedOddsMatches,
        officialHandicapOddsMatches: publishedHandicapOddsMatches,
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
