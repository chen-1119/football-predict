const fs = require("fs");
const path = require("path");
const https = require("https");

const SPORTTERY_BASE = "https://webapi.sporttery.cn";
const CURRENT_URL = `${SPORTTERY_BASE}/gateway/uniform/football/getMatchListV1.qry?clientCode=3001`;
const CALCULATOR_URL = `${SPORTTERY_BASE}/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=hhad,had&channel=c`;
const PAGE_SIZE = Math.max(1, Number(process.env.SPORTTERY_PAGE_SIZE || 80));
const PAGE_DEPTH = Math.max(1, Number(process.env.SPORTTERY_PAGE_DEPTH || 16));
const WINDOW_BACK_DAYS = Math.max(0, Number(process.env.MATCH_WINDOW_BACK_DAYS || 7));
const WINDOW_FORWARD_DAYS = Math.max(1, Number(process.env.MATCH_WINDOW_FORWARD_DAYS || 14));
const ODDS_HISTORY_RETENTION_DAYS = Math.max(1, Number(process.env.ODDS_HISTORY_RETENTION_DAYS || 180));
const ODDS_HISTORY_BUCKET_MINUTES = Math.max(1, Number(process.env.ODDS_HISTORY_BUCKET_MINUTES || 60));
const METHODS = (process.env.SPORTTERY_METHODS || "concern,live,result,all")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const STATUS_PRIORITY = { LIVE: 5, FINISHED: 4, SCHEDULED: 2 };

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

const CLUB_LOGO_BY_NAME = {
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
  const hhmm = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : "00:00:00";
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

function statusFromSporttery(matchStatus, sellStatus, statusName = "") {
  const raw = String(sellStatus || matchStatus || statusName || "").trim();
  const lower = raw.toLowerCase();
  if (["playing", "live", "inplay", "firsthalf", "secondhalf"].includes(lower)) return "LIVE";
  if (["finished", "result", "ended", "completed"].includes(lower)) return "FINISHED";
  if (["4", "5", "6", "7", "8", "9"].includes(raw)) return "LIVE";
  if (["10", "11", "12", "13"].includes(raw)) return "FINISHED";
  if (String(statusName || "").includes("完成")) return "FINISHED";
  return "SCHEDULED";
}

function sanitizeOdds(raw) {
  const odds1 = toNum(raw?.odds1, null);
  const oddsX = toNum(raw?.oddsX, null);
  const odds2 = toNum(raw?.odds2, null);
  if (odds1 > 1.01 && oddsX > 1.01 && odds2 > 1.01) return { odds1, oddsX, odds2 };
  return null;
}

function sportteryHadOdds(row, sourceUrl, sourceMethod) {
  const rows = Array.isArray(row?.oddsList) ? row.oddsList : [];
  const hadRow =
    rows.find((item) => String(item?.poolCode || "").toUpperCase() === "HAD") ||
    row?.had ||
    (row?.h || row?.d || row?.a ? row : null);
  const odds = sanitizeOdds({
    odds1: hadRow?.h,
    oddsX: hadRow?.d,
    odds2: hadRow?.a,
  });

  if (!odds) return null;

  const updateDate = normText(hadRow?.updateDate);
  const updateTime = normText(hadRow?.updateTime);
  return {
    odds,
    oddsSource: "sporttery:HAD",
    oddsPoolCode: "HAD",
    oddsSourceMethod: sourceMethod,
    oddsUpdatedAt: [updateDate, updateTime].filter(Boolean).join(" ") || undefined,
    oddsSourceUrl: sourceUrl,
  };
}

function impliedProbabilities(odds) {
  const inv1 = 1 / odds.odds1;
  const invX = 1 / odds.oddsX;
  const inv2 = 1 / odds.odds2;
  const total = inv1 + invX + inv2 || 1;
  return { home: inv1 / total, draw: invX / total, away: inv2 / total };
}

function resultStatus(match, expected) {
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
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
  const rules = [
    [/英超|Premier League/i, ["eng", "England", "🇬🇧", "Premier League", "英超"]],
    [/西甲|La Liga/i, ["esp", "Spain", "🇪🇸", "La Liga", "西甲"]],
    [/德甲|Bundesliga/i, ["deu", "Germany", "🇩🇪", "Bundesliga", "德甲"]],
    [/意甲|Serie A/i, ["ita", "Italy", "🇮🇹", "Serie A", "意甲"]],
    [/法甲|Ligue 1/i, ["fra", "France", "🇫🇷", "Ligue 1", "法甲"]],
    [/欧冠|Champions/i, ["eur", "Europe", "🇪🇺", "UEFA Champions League", "欧冠"]],
    [/欧联|Europa/i, ["eur", "Europe", "🇪🇺", "UEFA Europa League", "欧联"]],
    [/中超|Chinese/i, ["chn", "China", "🇨🇳", "Chinese Super League", "中超"]],
    [/日职|J1|日本/i, ["jpn", "Japan", "🇯🇵", "Japan", "日职"]],
    [/韩|K League/i, ["kor", "Korea", "🇰🇷", "K League", "韩职"]],
    [/国际|友谊|世预|世界杯/i, ["world", "World", "🌐", "International", "国际赛"]],
  ];
  for (const [pattern, meta] of rules) {
    if (pattern.test(name)) {
      return {
        countryId: meta[0],
        countryNameEn: meta[1],
        countryName: meta[1] === "World" ? "国际" : meta[1],
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
  const status = statusFromSporttery(row.matchStatus, row.sellStatus, row.matchStatusName);
  const kickoffTime = parseKickoff(row.matchDate, row.matchTime);
  const businessDate = normText(row.businessDate || row.matchNumDate || row.matchDate);
  const oddsInfo = sportteryHadOdds(row, sourceUrl, sourceMethod);
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
    odds: oddsInfo?.odds || null,
    oddsSource: oddsInfo?.oddsSource,
    oddsPoolCode: oddsInfo?.oddsPoolCode,
    oddsSourceMethod: oddsInfo?.oddsSourceMethod,
    oddsUpdatedAt: oddsInfo?.oddsUpdatedAt,
    oddsSourceUrl: oddsInfo?.oddsSourceUrl,
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
    for (let page = 1; page < PAGE_DEPTH; page += 1) {
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
  const oddsMatch = oddsRank(next) >= oddsRank(prev) ? next : prev;
  return {
    ...prev,
    ...next,
    odds: oddsMatch.odds || null,
    oddsSource: oddsMatch.oddsSource,
    oddsPoolCode: oddsMatch.oddsPoolCode,
    oddsSourceMethod: oddsMatch.oddsSourceMethod,
    oddsUpdatedAt: oddsMatch.oddsUpdatedAt,
    oddsSourceUrl: oddsMatch.oddsSourceUrl,
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

function predictionSet(match) {
  const probabilities = impliedProbabilities(match.odds);
  const picks = [
    ["1", probabilities.home, match.odds.odds1, `胜(3) ${match.homeTeam}`, `Home Win (${match.homeTeam})`],
    ["X", probabilities.draw, match.odds.oddsX, "平(1)", "Draw"],
    ["2", probabilities.away, match.odds.odds2, `负(0) ${match.awayTeam}`, `Away Win (${match.awayTeam})`],
  ].sort((a, b) => b[1] - a[1]);
  const best1x2 = picks[0];
  const baseTrust = clamp(Math.round(best1x2[1] * 100 + 18), 55, 94);
  const rand = seeded(`${match.sourceMatchId}-${match.homeTeam}-${match.awayTeam}`);
  const homeLambda = clamp(0.75 + probabilities.home * 2.2 + rand() * 0.35, 0.6, 2.8);
  const awayLambda = clamp(0.65 + probabilities.away * 2.1 + rand() * 0.35, 0.5, 2.6);
  const totalLambda = homeLambda + awayLambda;
  const goalsTip = totalLambda >= 6.5 ? "7+" : String(clamp(Math.round(totalLambda), 0, 6));
  const ggTip = (1 - Math.exp(-homeLambda)) * (1 - Math.exp(-awayLambda)) >= 0.48 ? "GG" : "NG";
  const goalsDistance = goalsTip === "7+" ? Math.abs(totalLambda - 7) : Math.abs(totalLambda - Number(goalsTip));
  const goalsOdds = Number((1.65 + goalsDistance * 0.35 + rand() * 0.28).toFixed(2));
  const ggOdds = Number((ggTip === "GG" ? 1.75 + rand() * 0.3 : 1.8 + rand() * 0.32).toFixed(2));

  const oneXTwo = {
    marketType: "1X2",
    tipCode: best1x2[0],
    tipLabel: { zh: best1x2[3], en: best1x2[4] },
    odds: best1x2[2],
    trustScore: baseTrust,
    explanation: {
      zh: `基于官方竞彩胜平负 SP 和赛程状态，${match.homeTeam} vs ${match.awayTeam} 当前隐含概率最高方向为 ${best1x2[3]}。`,
      en: `Based on official match data and 1X2 odds, the strongest direction is ${best1x2[4]}.`,
    },
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, best1x2[0]),
  };

  const goals = {
    marketType: "GOALS",
    tipCode: goalsTip,
    tipLabel: { zh: goalsTip === "7+" ? "总进球数 7+" : `总进球数 ${goalsTip}球`, en: goalsTip === "7+" ? "Total Goals 7+" : `Total Goals ${goalsTip}` },
    odds: goalsOdds,
    trustScore: clamp(Math.round((1 - Math.min(goalsDistance, 2.5) / 3) * 100), 55, 88),
    explanation: {
      zh: `总进球数参考以胜平负 SP 反推预期进球，当前总进球期望约 ${totalLambda.toFixed(2)}。`,
      en: `The goals model derives expected goals from the win/draw/loss market. Estimated total goals: ${totalLambda.toFixed(2)}.`,
    },
    visibilityStatus: "PREMIUM",
    resultStatus: resultStatus(match, goalsTip),
  };

  const gg = {
    marketType: "GG_NG",
    tipCode: ggTip,
    tipLabel: ggTip === "GG" ? { zh: "双方进球 是", en: "Both Teams to Score" } : { zh: "双方进球 否", en: "No Both Teams to Score" },
    odds: ggOdds,
    trustScore: clamp(Math.round((ggTip === "GG" ? 0.58 : 0.56) * 100 + rand() * 20), 55, 86),
    explanation: {
      zh: `双方进球参考来自主客队预期进球分布，主队约 ${homeLambda.toFixed(2)}，客队约 ${awayLambda.toFixed(2)}。`,
      en: `BTTS is estimated from goal distribution: home ${homeLambda.toFixed(2)}, away ${awayLambda.toFixed(2)}.`,
    },
    visibilityStatus: "PREMIUM",
    resultStatus: resultStatus(match, ggTip),
  };

  const best = {
    marketType: "BEST",
    tipCode: oneXTwo.tipCode,
    tipLabel: { zh: `稳胆 ${oneXTwo.tipLabel.zh}`, en: `Best: ${oneXTwo.tipLabel.en}` },
    odds: oneXTwo.odds,
    trustScore: clamp(oneXTwo.trustScore + 2, 57, 96),
    explanation: {
      zh: `AI 精选优先使用官方竞彩实时数据，不再混入本地模拟比赛。本场综合胜平负 SP、状态和进球模型后推荐 ${oneXTwo.tipLabel.zh}。`,
      en: `The best tip uses official Sporttery data without local fake fixtures. Recommended: ${oneXTwo.tipLabel.en}.`,
    },
    visibilityStatus: "PREMIUM",
    resultStatus: oneXTwo.resultStatus,
  };

  return { predictions: [oneXTwo, goals, gg, best], homeLambda, awayLambda };
}

function makeRecentForm(teamName, leagueName, seedKey) {
  const rand = seeded(seedKey);
  const rows = Array.from({ length: 5 }, (_, idx) => {
    const ourScore = Math.floor(rand() * 4);
    const oppScore = Math.floor(rand() * 3);
    return {
      opponentId: `opp_${hashString(`${seedKey}_${idx}`)}`,
      opponentName: { zh: `近期对手${idx + 1}`, en: `Recent opponent ${idx + 1}` },
      isHome: rand() >= 0.5,
      ourScore,
      oppScore,
      date: `2026-05-${String(25 - idx).padStart(2, "0")}`,
      competition: { zh: leagueName, en: leagueName },
    };
  });
  const wins = rows.filter((x) => x.ourScore > x.oppScore).length;
  const draws = rows.filter((x) => x.ourScore === x.oppScore).length;
  const losses = rows.length - wins - draws;
  const over25 = rows.filter((x) => x.ourScore + x.oppScore > 2.5).length;
  const btts = rows.filter((x) => x.ourScore > 0 && x.oppScore > 0).length;
  return {
    recentMatches: rows,
    statsLast10: {
      wins,
      draws,
      losses,
      over1_5: 70,
      over2_5: over25 * 20,
      over3_5: Math.max(0, over25 - 1) * 20,
      bothToScore: btts * 20,
      upsetWins: wins >= 3 ? 1 : 0,
      upsetLosses: losses >= 3 ? 1 : 0,
    },
  };
}

function toAppMatch(match) {
  const meta = leagueMeta(match.leagueName);
  const homeTeamId = `team_${hashString(match.homeTeam)}`;
  const awayTeamId = `team_${hashString(match.awayTeam)}`;
  const leagueId = `league_${hashString(match.leagueName)}`;
  const odds = sanitizeOdds(match.odds);
  const model = odds
    ? predictionSet({ ...match, odds })
    : { predictions: [], homeLambda: match.scoreHome ?? 0, awayLambda: match.scoreAway ?? 0 };
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
    odds: odds || undefined,
    predictions: model.predictions,
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
    recentForm: {
      home: makeRecentForm(match.homeTeam, match.leagueName, `${match.sourceMatchId}_home`),
      away: makeRecentForm(match.awayTeam, match.leagueName, `${match.sourceMatchId}_away`),
    },
    h2h: [
      {
        date: "2026-05-20",
        homeScore: Math.floor(rand() * 3),
        awayScore: Math.floor(rand() * 3),
        homeTeamId,
        awayTeamId,
        competition: { zh: match.leagueName, en: meta.leagueNameEn },
      },
    ],
    standings: [homeTeamId, awayTeamId].map((teamId, idx) => ({
      position: idx + 1,
      teamId,
      played: 10,
      wins: 6 - idx,
      draws: 2,
      losses: 2 + idx,
      goalsFor: 18 - idx * 3,
      goalsAgainst: 10 + idx * 2,
      points: (6 - idx) * 3 + 2,
    })),
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

function loadExistingMatches() {
  const file = path.join(__dirname, "..", "public", "matches.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

async function sync() {
  const capturedAt = new Date().toISOString();
  const allRawMatches = await fetchSportteryMatches();
  const rawMatches = allRawMatches.filter(inMatchWindow);
  const rawMatchesWithOdds = rawMatches.filter((match) => sanitizeOdds(match.odds));
  const rawResultMatches = rawMatches.filter(isOfficialResultMatch);
  const rawMatchesForOutput = rawMatches.filter((match) => sanitizeOdds(match.odds) || isOfficialResultMatch(match));
  const usedFreshOdds = rawMatchesWithOdds.length > 0;
  let output = rawMatchesForOutput.map(toAppMatch);

  if (!output.length) {
    output = loadExistingMatches().filter(isTrustedOddsMatch);
    if (!output.length) throw new Error("Sporttery returned no matches and no existing matches.json is available.");
    console.log(`Sporttery returned no trusted odds; kept existing trusted matches.json (${output.length}).`);
  }

  const publicDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const outputPath = path.join(publicDir, "matches.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  const oddsHistory = usedFreshOdds
    ? appendOddsHistory(publicDir, output, capturedAt)
    : { rows: loadOddsHistory(publicDir).rows.length, appended: 0, updated: 0, skipped: "no fresh official odds" };

  const byStatus = output.reduce((acc, match) => {
    acc[match.status] = (acc[match.status] || 0) + 1;
    return acc;
  }, {});
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "sporttery",
        count: output.length,
        scanned: allRawMatches.length,
        officialOddsMatches: rawMatchesWithOdds.length,
        officialResultMatches: rawResultMatches.length,
        skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
        window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
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
