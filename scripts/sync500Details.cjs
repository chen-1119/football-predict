const fs = require("fs");
const https = require("https");
const path = require("path");
const { execFileSync } = require("child_process");
const iconv = require("iconv-lite");
const { eventSafeExistingSignal } = require("./externalSignalEventIdentity.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const DETAILS_FILE = path.join(DATA_DIR, "five-hundred-details.json");
const EXTERNAL_SIGNALS_FILE = path.join(DATA_DIR, "external-signals.json");
const SOURCE_URL = process.env.FIVE_HUNDRED_JCZQ_URL || "https://trade.500.com/jczq/";
// Current detail links are served by odds.500.com. Rewriting them to the
// trade host turns valid detail pages into redirects that end in 404s.
const DETAIL_BASE_URL = String(process.env.FIVE_HUNDRED_DETAIL_BASE_URL || "https://odds.500.com").replace(/\/+$/, "");
const MAX_MATCHES = Math.max(1, Number(process.env.FIVE_HUNDRED_DETAILS_MAX_MATCHES || 24));
const REFRESH_MINUTES = Math.max(30, Number(process.env.FIVE_HUNDRED_DETAILS_REFRESH_MINUTES || 180));
const NEAR_REFRESH_MINUTES = Math.max(20, Math.min(
  REFRESH_MINUTES,
  Number(process.env.FIVE_HUNDRED_DETAILS_NEAR_REFRESH_MINUTES || 60),
));
const URGENT_REFRESH_MINUTES = Math.max(10, Math.min(
  NEAR_REFRESH_MINUTES,
  Number(process.env.FIVE_HUNDRED_DETAILS_URGENT_REFRESH_MINUTES || 20),
));
const RESULT_LOOKBACK_HOURS = Math.max(1, Number(process.env.FIVE_HUNDRED_RESULT_LOOKBACK_HOURS || 48));
const DETAIL_TIMEOUT_SECONDS = Math.max(5, Number(process.env.FIVE_HUNDRED_DETAILS_TIMEOUT_SECONDS || 10));
const MAX_ERRORS = Math.max(1, Number(process.env.FIVE_HUNDRED_DETAILS_MAX_ERRORS || 3));
const RESULT_ONLY_MODE = process.env.FIVE_HUNDRED_RESULT_ONLY === "1";
const RESULT_ONLY_ARCHIVE_MAX_DATES = Math.max(
  1,
  Math.min(4, Number(process.env.FIVE_HUNDRED_RESULT_ARCHIVE_MAX_DATES || 3)),
);
const USER_AGENT = process.env.FIVE_HUNDRED_USER_AGENT
  || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const REQUEST_HEADERS = Object.freeze({
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  Referer: "https://www.500.com/",
});

const nowIso = () => new Date().toISOString();

const parseObservedTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(/\s+/, "T")}${text.length === 16 ? ":00" : ""}+08:00`
    : text;
  return Date.parse(normalized);
};

const observedIso = (value) => {
  const time = parseObservedTime(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const preMatchValidUntil = (match) => (
  observedIso(match?.buyEndTime)
  || observedIso(match?.kickoffTime)
  || null
);

const preMatchComponentTiming = (match, sourceObservedAt, receivedAt = sourceObservedAt) => {
  const observed = observedIso(sourceObservedAt);
  const received = observedIso(receivedAt) || observed;
  const validUntil = preMatchValidUntil(match);
  const observedMs = parseObservedTime(observed);
  const validUntilMs = parseObservedTime(validUntil);
  const usableForPreMatch = Number.isFinite(observedMs)
    && Number.isFinite(validUntilMs)
    && observedMs <= validUntilMs;
  return {
    sourceObservedAt: observed,
    receivedAt: received,
    validUntil,
    usableForPreMatch,
    observationPhase: usableForPreMatch ? "pre-match" : "post-cutoff",
  };
};

const resultComponentTiming = (sourceObservedAt, receivedAt = sourceObservedAt) => ({
  sourceObservedAt: observedIso(sourceObservedAt),
  receivedAt: observedIso(receivedAt) || observedIso(sourceObservedAt),
  validUntil: null,
  usableForPreMatch: false,
  observationPhase: "post-match-result",
});

const withComponentTiming = (component, timing) => {
  if (!component || typeof component !== "object" || Array.isArray(component)) return component;
  return {
    ...component,
    ...timing,
    // Compatibility field: component.updatedAt now means when this component
    // was observed, never the later time at which a result-only merge ran.
    updatedAt: timing.sourceObservedAt || component.updatedAt || null,
  };
};

const timingForAvailableComponent = (timing, available = true) => ({
  ...timing,
  usableForPreMatch: Boolean(available && timing?.usableForPreMatch),
  observationPhase: available
    ? timing?.observationPhase || "unknown"
    : "unavailable",
});

const htmlDecode = (value) => String(value || "")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .trim();

const norm = (value) => htmlDecode(value).replace(/\s+/g, " ").trim();
const textOnly = (html) => norm(String(html || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " "));

const toNum = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(number) ? number : null;
};

const compactNumber = (value, digits = 2) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const isFresh = (iso, minutes) => {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) && Date.now() - time < minutes * 60000;
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

const readJson = (file, fallback) => {
  try {
    return JSON.parse(withFileRetry(() => fs.readFileSync(file, "utf8"), `read ${file}`));
  } catch {
    return fallback;
  }
};

const writeJson = (file, payload) => {
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

const httpGetBuffer = (url, referer = SOURCE_URL) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: "GET",
    headers: {
      ...REQUEST_HEADERS,
      Referer: referer,
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const preview = iconv.decode(body.slice(0, 220), "gbk").replace(/\s+/g, " ");
        reject(new Error(`${url} -> HTTP ${res.statusCode} ${preview}`));
        return;
      }
      resolve(body);
    });
  });
  req.setTimeout(DETAIL_TIMEOUT_SECONDS * 1000, () => req.destroy(new Error(`timeout: ${url}`)));
  req.on("error", reject);
  req.end();
});

const curlGetBuffer = (url, referer = SOURCE_URL, cause) => {
  try {
    return execFileSync("curl", [
      "-fsSL",
      "--connect-timeout", String(Math.min(8, DETAIL_TIMEOUT_SECONDS)),
      "--max-time", String(DETAIL_TIMEOUT_SECONDS),
      "-A", USER_AGENT,
      "-H", `Accept: ${REQUEST_HEADERS.Accept}`,
      "-H", `Accept-Language: ${REQUEST_HEADERS["Accept-Language"]}`,
      "-H", "Accept-Encoding: identity",
      "-H", `Referer: ${referer}`,
      url,
    ], {
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${cause?.message || cause || "https request failed"}; curl fallback failed: ${error.message || error}`);
  }
};

const shouldUseCurlFirst = (url) => (
  process.env.FIVE_HUNDRED_USE_CURL === "1"
  || /:\/\/odds\.500\.com\//i.test(String(url || ""))
);

const httpGetHtml = async (url, referer) => {
  if (shouldUseCurlFirst(url)) {
    return iconv.decode(curlGetBuffer(url, referer), "gbk");
  }
  try {
    return iconv.decode(await httpGetBuffer(url, referer), "gbk");
  } catch (error) {
    return iconv.decode(curlGetBuffer(url, referer, error), "gbk");
  }
};

const parseAttrs = (attrText) => {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(attrText))) attrs[match[1]] = htmlDecode(match[2]);
  return attrs;
};

const absoluteUrl = (href) => {
  const value = norm(href);
  if (!value || value === "javascript:;") return "";
  const rewriteDetailHost = (url) => {
    try {
      const parsed = new URL(url);
      if (/^odds\.500\.com$/i.test(parsed.hostname)) {
        const base = new URL(DETAIL_BASE_URL);
        parsed.protocol = base.protocol;
        parsed.host = base.host;
      }
      return parsed.toString();
    } catch {
      return url;
    }
  };
  if (/^https?:\/\//i.test(value)) return rewriteDetailHost(value);
  if (value.startsWith("//")) return rewriteDetailHost(`https:${value}`);
  if (value.startsWith("/")) return `${DETAIL_BASE_URL}${value}`;
  return value;
};

const parseOdds = (rowHtml, type) => {
  const odds = {};
  const re = new RegExp(`<p[^>]*data-type="${type}"[^>]*data-value="([310])"[^>]*data-sp="([^"]*)"`, "g");
  let match;
  while ((match = re.exec(rowHtml))) {
    const sp = toNum(match[2]);
    if (!sp) continue;
    if (match[1] === "3") odds.odds1 = sp;
    if (match[1] === "1") odds.oddsX = sp;
    if (match[1] === "0") odds.odds2 = sp;
  }
  return odds.odds1 && odds.oddsX && odds.odds2 ? odds : null;
};

const parseScore = (value) => {
  const match = String(value || "").match(/(\d+)\s*[:：]\s*(\d+)/);
  return match ? { home: Number(match[1]), away: Number(match[2]) } : null;
};

const scoreFromTradeRow = (rowHtml) => {
  const html = String(rowHtml || "");
  const scoreHtml = (html.match(/<a[^>]*class="[^"]*\bscore\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1]
    || (html.match(/<i[^>]*class="[^"]*\bteam-vs\b[^"]*"[^>]*>([\s\S]*?)<\/i>/i) || [])[1]
    || "";
  return parseScore(textOnly(scoreHtml));
};

const availabilityFor = (raw) => {
  const output = {};
  String(raw || "").split(",").forEach((pair) => {
    const [key, value] = pair.split(":").map((item) => norm(item));
    if (key) output[key] = value === "1";
  });
  return output;
};

const signalKeys = (match) => {
  const keys = new Set();
  [match.sourceMatchId, match.fixtureId, match.infoMatchId].filter(Boolean).forEach((key) => keys.add(String(key)));
  if (match.processDate && match.matchNo) keys.add(`${match.processDate}:${match.matchNo}`);
  if (match.matchDate && match.homeTeamName && match.awayTeamName) keys.add(`${match.matchDate}:${match.homeTeamName}:${match.awayTeamName}`);
  return Array.from(keys);
};

const parseTradeRows = (html) => {
  const rows = [];
  const receivedAt = nowIso();
  const re = /<tr\b([^>]*class="[^"]*\bbet-tb-tr\b[^"]*"[^>]*)>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttrs(match[1]);
    const rowHtml = match[2];
    const fixtureId = norm(attrs["data-fixtureid"]);
    const sourceMatchId = norm(attrs["data-id"]);
    if (!fixtureId || !sourceMatchId) continue;
    const score = scoreFromTradeRow(rowHtml);
    const isEnded = norm(attrs["data-isend"]) === "1" || /\bbet-tb-end\b/.test(match[0]);
    const links = {};
    const linkRe = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let linkMatch;
    while ((linkMatch = linkRe.exec(rowHtml))) {
      const href = absoluteUrl(linkMatch[1]);
      const label = textOnly(linkMatch[2]);
      if (label === "析") links.analysis = href;
      if (label === "欧") links.europeOdds = href;
      if (label === "亚") links.asianHandicap = href;
      if (label === "荐") links.recommendation = href;
    }
    rows.push({
      sourceMatchId,
      fixtureId,
      infoMatchId: norm(attrs["data-infomatchid"]),
      matchNo: norm(attrs["data-matchnum"]),
      processDate: norm(attrs["data-processdate"]),
      homeTeamName: norm(attrs["data-homesxname"]),
      awayTeamName: norm(attrs["data-awaysxname"]),
      homeTeamId: norm(attrs["data-homeid"]),
      awayTeamId: norm(attrs["data-awayid"]),
      leagueName: norm(attrs["data-simpleleague"]),
      leagueId: norm(attrs["data-matchid"]),
      matchDate: norm(attrs["data-matchdate"]),
      matchTime: norm(attrs["data-matchtime"]),
      kickoffTime: attrs["data-matchdate"] && attrs["data-matchtime"] ? `${norm(attrs["data-matchdate"])}T${norm(attrs["data-matchtime"])}:00+08:00` : "",
      buyEndTime: norm(attrs["data-buyendtime"]),
      status: score ? "FINISHED" : "SCHEDULED",
      scoreHome: score?.home ?? null,
      scoreAway: score?.away ?? null,
      resultSource: score ? "500.com:jczq-result" : undefined,
      resultUpdatedAt: score ? receivedAt : undefined,
      resultSourceUpdatedAt: score ? null : undefined,
      resultObservedAt: score ? receivedAt : undefined,
      resultObservationSource: score ? "500.com-response-received-at" : undefined,
      resultObservationFallback: score ? true : undefined,
      eventVersion: score && attrs["data-matchdate"] && attrs["data-matchtime"]
        ? `${norm(attrs["data-matchdate"])}T${norm(attrs["data-matchtime"])}:00+08:00`
        : undefined,
      isEnded,
      handicapLine: norm(attrs["data-rangqiu"]),
      availability: availabilityFor(attrs["data-subactive"]),
      had: parseOdds(rowHtml, "nspf"),
      hhad: parseOdds(rowHtml, "spf"),
      urls: links,
    });
  }
  return rows;
};

const buildDateUrl = (date) => {
  const url = new URL(SOURCE_URL);
  if (!/\/index\.php$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/index.php`;
  }
  url.searchParams.set("date", date);
  return url.toString();
};

const isRecentResultCandidate = (match) => {
  const kickoff = Date.parse(match?.kickoffTime || "");
  if (!Number.isFinite(kickoff)) return false;
  const ageHours = (Date.now() - kickoff) / 3600000;
  return ageHours >= 0 && ageHours <= RESULT_LOOKBACK_HOURS;
};

const uniqueBySourceMatchId = (rows) => {
  const byId = new Map();
  const scoreRank = (row) => (Number.isFinite(row?.scoreHome) && Number.isFinite(row?.scoreAway) ? 2 : row?.isEnded ? 1 : 0);
  for (const row of rows) {
    if (!row?.sourceMatchId) continue;
    const previous = byId.get(row.sourceMatchId);
    byId.set(row.sourceMatchId, !previous || scoreRank(row) >= scoreRank(previous) ? { ...previous, ...row } : previous);
  }
  return Array.from(byId.values());
};

const resultArchiveDatesForRows = (...collections) => {
  const dates = new Set();
  for (const collection of collections) {
    for (const match of collection || []) {
      if (!isRecentResultCandidate(match)) continue;
      [
        match.processDate,
        match.businessDate,
        match.matchDate,
        String(match.kickoffTime || "").slice(0, 10),
      ].map(norm).filter(Boolean).forEach((date) => dates.add(date));
    }
  }
  return Array.from(dates).sort();
};

const boundedResultArchiveDatesForRows = (maxDates, ...collections) => {
  const dates = resultArchiveDatesForRows(...collections);
  const limit = Math.max(1, Math.min(4, Number(maxDates || dates.length || 1)));
  return dates.slice(-limit);
};

const fetchRecentResultRows = async (
  existingDetails,
  supportingMatches = [],
  { maxDates = 4 } = {},
) => {
  const dates = boundedResultArchiveDatesForRows(
    maxDates,
    Object.values(existingDetails?.matches || {}),
    supportingMatches,
  );

  const attempts = await Promise.all(dates.map(async (date) => {
    try {
      const html = await httpGetHtml(buildDateUrl(date), SOURCE_URL);
      return { date, rows: parseTradeRows(html), error: null };
    } catch (error) {
      return { date, rows: [], error: { date, message: error.message || String(error) } };
    }
  }));

  return {
    rows: attempts.flatMap((attempt) => attempt.rows),
    errors: attempts.map((attempt) => attempt.error).filter(Boolean),
    dates,
  };
};

const extractTables = (html) => {
  const tables = [];
  const re = /<table([^>]*)>([\s\S]*?)<\/table>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrText = match[1];
    const body = match[2];
    const attrs = parseAttrs(attrText);
    const before = textOnly(html.slice(Math.max(0, match.index - 700), match.index));
    const text = textOnly(body);
    if (text.length > 15) tables.push({ attrs, body, before, text });
  }
  return tables;
};

const tableCells = (tableBody) => {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tableBody))) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const value = textOnly(cellMatch[1]);
      if (value) cells.push(value);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
};

const parseFifaRanks = (tables, matchInfo) => {
  const rankTables = tables.filter((table) => /月份 世界排名 排名变化 积分/.test(table.text));
  const parseOne = (table, teamName) => {
    if (!table) return null;
    const rows = tableCells(table.body).filter((row) => row.length >= 5 && /\d{4}年\d{2}月/.test(row[0]));
    const latest = rows[0] || [];
    return {
      teamName,
      fifaRank: toNum(latest[1]),
      rankChange: toNum(latest[2]),
      fifaPoints: toNum(latest[3]),
      pointsChange: toNum(latest[4]),
      sampleMonth: latest[0] || null,
    };
  };
  return {
    home: parseOne(rankTables[0], matchInfo.homeTeamName),
    away: parseOne(rankTables[1], matchInfo.awayTeamName),
  };
};

const rowTexts = (tableBody) => {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tableBody))) {
    const text = textOnly(rowMatch[1]);
    if (text) rows.push(text);
  }
  return rows;
};

const parseRecentTextRow = (text) => {
  const value = norm(text);
  const scorePattern = "(?:\\d+\\s*[:：]\\s*\\d+|VS)";
  const handicapPattern = "(?:-?\\d+(?:\\.\\d+)?|平手(?:/半球)?|半球(?:/一球)?|一球(?:/球半)?|球半(?:/两球)?|两球(?:/两球半)?|两球半(?:/三球)?|三球(?:/三球半)?|-)";
  const re = new RegExp(`^(\\S+)\\s+(\\d{2}-\\d{2}-\\d{2})\\s+(.+?)\\s+(${scorePattern})\\s+(.+?)\\s+(${handicapPattern})\\s+(${scorePattern}|-)\\s+([胜平负-])\\s+([赢输走-])\\s+([大小-])`);
  const match = value.match(re);
  if (!match) return null;
  return {
    competition: match[1],
    date: match[2],
    homeTeamName: norm(match[3]),
    scoreText: norm(match[4]),
    awayTeamName: norm(match[5]),
    handicap: norm(match[6]),
    halfTime: norm(match[7]),
    result: norm(match[8]),
    handicapResult: norm(match[9]),
    totalGoalsResult: norm(match[10]),
  };
};

const parseRecentTable = (table, teamName) => {
  if (!table) return null;
  const rows = rowTexts(table.body)
    .map(parseRecentTextRow)
    .filter(Boolean)
    .filter((row) => row.scoreText !== "VS")
    .slice(0, 12)
    .filter((row) => row.scoreText);

  const settled = rows.filter((row) => parseScore(row.scoreText));
  const totals = settled.reduce((acc, row) => {
    const score = parseScore(row.scoreText);
    const isHome = row.homeTeamName === teamName;
    const goalsFor = isHome ? score.home : score.away;
    const goalsAgainst = isHome ? score.away : score.home;
    acc.wins += goalsFor > goalsAgainst ? 1 : 0;
    acc.draws += goalsFor === goalsAgainst ? 1 : 0;
    acc.losses += goalsFor < goalsAgainst ? 1 : 0;
    acc.goalsFor += goalsFor;
    acc.goalsAgainst += goalsAgainst;
    acc.over25 += score.home + score.away >= 3 ? 1 : 0;
    acc.btts += score.home > 0 && score.away > 0 ? 1 : 0;
    acc.handicapWins += row.handicapResult === "赢" ? 1 : 0;
    return acc;
  }, { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, over25: 0, btts: 0, handicapWins: 0 });
  const sample = settled.length;
  return {
    teamName,
    sampleSize: sample,
    record: `${totals.wins}-${totals.draws}-${totals.losses}`,
    goalsForAvg: sample ? compactNumber(totals.goalsFor / sample) : null,
    goalsAgainstAvg: sample ? compactNumber(totals.goalsAgainst / sample) : null,
    over25Rate: sample ? compactNumber(totals.over25 / sample, 3) : null,
    bttsRate: sample ? compactNumber(totals.btts / sample, 3) : null,
    handicapWinRate: sample ? compactNumber(totals.handicapWins / sample, 3) : null,
    rows: rows.slice(0, 8),
  };
};

const parseFutureTable = (table) => {
  if (!table) return null;
  const rows = rowTexts(table.body)
    .map((text) => {
      const match = norm(text).match(/^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+VS\s+(.+?)\s+(\d+)天/);
      if (!match) return null;
      return {
        competition: match[1] || "",
        date: match[2] || "",
        homeTeamName: norm(match[3]),
        awayTeamName: norm(match[4]),
        gapText: `${match[5]}天`,
        gapDays: toNum(match[5]),
      };
    })
    .filter(Boolean)
    .slice(0, 8)
    .filter((row) => row.date);
  return {
    nextGapDays: rows[0]?.gapDays ?? null,
    rows,
  };
};

const playerNamesFromTable = (table) => {
  if (!table) return [];
  return tableCells(table.body)
    .flat()
    .filter((cell) => /\(\S+\)/.test(cell))
    .map((cell) => norm(cell))
    .slice(0, 30);
};

const parseMacauTip = (table) => {
  if (!table) return null;
  const text = table.text;
  const pick = (text.match(/推介\s*-\s*([^\s]+)/) || [])[1] || "";
  return {
    pick: pick || null,
    summary: text.slice(0, 420),
  };
};

const parseAnalysisPage = async (url, matchInfo) => {
  if (!url) return null;
  const html = await httpGetHtml(url);
  const tables = extractTables(html);
  const rank = parseFifaRanks(tables, matchInfo);
  const recentTables = tables.filter((table) => /^赛事 比赛日期 主队 比分 客队 盘口 半场 赛果 盘路 大小/.test(table.text));
  const futureTables = tables.filter((table) => /^赛事 比赛日期 主队 客队 相隔/.test(table.text));
  const lineupTables = tables.filter((table) => /首发|替补|伤病|停赛/.test(table.text) && /\(\S+\)/.test(table.text));
  const macauTable = tables.find((table) => /澳门心水推荐|推介 -/.test(`${table.before} ${table.text}`));
  return {
    url,
    rank,
    recentForm: {
      home: parseRecentTable(recentTables[0], matchInfo.homeTeamName),
      away: parseRecentTable(recentTables[1], matchInfo.awayTeamName),
    },
    futureSchedule: {
      home: parseFutureTable(futureTables[0]),
      away: parseFutureTable(futureTables[1]),
    },
    projectedSquads: {
      source: "500.com",
      home: playerNamesFromTable(lineupTables[0]),
      away: playerNamesFromTable(lineupTables[1]),
    },
    macauTip: parseMacauTip(macauTable),
  };
};

const parseTriplet = (cells, start) => ({
  odds1: toNum(cells[start]),
  oddsX: toNum(cells[start + 1]),
  odds2: toNum(cells[start + 2]),
});

const validTriplet = (triplet) => Boolean(triplet && triplet.odds1 && triplet.oddsX && triplet.odds2);

const implied = (odds) => {
  if (!validTriplet(odds)) return null;
  const inv = [1 / odds.odds1, 1 / odds.oddsX, 1 / odds.odds2];
  const sum = inv.reduce((a, b) => a + b, 0);
  return {
    home: compactNumber(inv[0] / sum, 4),
    draw: compactNumber(inv[1] / sum, 4),
    away: compactNumber(inv[2] / sum, 4),
  };
};

const averageTriplets = (rows, key) => {
  const values = rows.map((row) => row[key]).filter(validTriplet);
  if (!values.length) return null;
  return {
    odds1: compactNumber(values.reduce((sum, row) => sum + row.odds1, 0) / values.length),
    oddsX: compactNumber(values.reduce((sum, row) => sum + row.oddsX, 0) / values.length),
    odds2: compactNumber(values.reduce((sum, row) => sum + row.odds2, 0) / values.length),
  };
};

const topLevelRowBlocks = (html) => {
  const blocks = [];
  const re = /<tr\s+class="tr[12]"[^>]*xls="row"[\s\S]*?(?=<tr\s+class="tr[12]"[^>]*xls="row"|<\/table>\s*(?:<div|<\/div|$)|$)/gi;
  let match;
  while ((match = re.exec(html))) blocks.push(match[0]);
  return blocks;
};

const numbersFromText = (text) => (norm(text).match(/\d+(?:\.\d+)?%?/g) || []);

const cellsFromBlock = (block) => Array.from(String(block || "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
  .map((match) => textOnly(match[1]))
  .filter(Boolean);

const parseEuropeOdds = async (url) => {
  if (!url) return null;
  const html = await httpGetHtml(url);
  const rows = [];
  for (const block of topLevelRowBlocks(html)) {
    const cells = cellsFromBlock(block);
    if (cells.length < 16) continue;
    const company = htmlDecode(
      (block.match(/class="tb_plgs"[^>]*title="([^"]*)"/i) || [])[1]
      || (block.match(/<a[^>]*title="([^"]*)"/i) || [])[1]
      || cells[1]
      || ""
    );
    const current = parseTriplet(cells, 2);
    const initial = parseTriplet(cells, 5);
    if (!validTriplet(current) || !validTriplet(initial)) continue;
    rows.push({
      company,
      current,
      initial,
      currentProbability: implied(current),
      initialProbability: implied(initial),
      returnRateCurrent: toNum(cells[14]),
      returnRateInitial: toNum(cells[15]),
      kellyCurrent: parseTriplet(cells, 16),
    });
  }
  const currentAverage = averageTriplets(rows, "current");
  const initialAverage = averageTriplets(rows, "initial");
  const official = rows.find((row) => /竞/.test(row.company)) || null;
  return {
    url,
    rows: rows.slice(0, 24),
    companies: rows.length,
    currentAverage,
    initialAverage,
    currentProbabilityAverage: implied(currentAverage),
    official,
    summary: currentAverage
      ? `500欧赔均值 ${currentAverage.odds1.toFixed(2)} / ${currentAverage.oddsX.toFixed(2)} / ${currentAverage.odds2.toFixed(2)}`
      : "",
  };
};

const handicapToNumber = (text) => {
  const value = norm(text);
  const map = {
    平手: 0,
    "平手/半球": 0.25,
    半球: 0.5,
    "半球/一球": 0.75,
    一球: 1,
    "一球/球半": 1.25,
    球半: 1.5,
    "球半/两球": 1.75,
    两球: 2,
    "两球/两球半": 2.25,
    "两球半": 2.5,
    "两球半/三球": 2.75,
    三球: 3,
    "三球/三球半": 3.25,
    "三球半": 3.5,
  };
  const positive = map[value];
  if (positive !== undefined) return positive;
  return null;
};

const averageLine = (rows, key) => {
  const valueKey = key === "currentLine" ? "currentLineValue" : key === "initialLine" ? "initialLineValue" : "";
  const nums = rows
    .map((row) => {
      const signedValue = valueKey ? row[valueKey] : null;
      return Number.isFinite(signedValue) ? signedValue : handicapToNumber(row[key]);
    })
    .filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return compactNumber(nums.reduce((sum, value) => sum + value, 0) / nums.length, 3);
};

const parseAsianHandicap = async (url) => {
  if (!url) return null;
  const html = await httpGetHtml(url);
  const rows = [];
  for (const block of topLevelRowBlocks(html)) {
    const company = htmlDecode(
      (block.match(/class="tb_plgs"[^>]*title="([^"]*)"/i) || [])[1]
      || (block.match(/<a[^>]*title="([^"]*)"/i) || [])[1]
      || ""
    );
    const lineCells = Array.from(block.matchAll(/<td[^>]*ref="(-?\d+(?:\.\d+)?)"[^>]*>([\s\S]*?)<\/td>/gi))
      .map((match) => ({ value: toNum(match[1]), text: textOnly(match[2]) }));
    const waterCells = Array.from(block.matchAll(/<td[^>]*width="58"[^>]*>([\s\S]*?)<\/td>/gi))
      .map((match) => toNum(textOnly(match[1])));
    const currentLine = lineCells[0]?.text || "";
    const initialLine = lineCells[1]?.text || "";
    const currentHomeWater = waterCells[0] ?? null;
    const currentAwayWater = waterCells[1] ?? null;
    const initialHomeWater = waterCells[2] ?? null;
    const initialAwayWater = waterCells[3] ?? null;
    if (!currentLine && !initialLine) continue;
    rows.push({
      company,
      currentHomeWater,
      currentLine,
      currentLineValue: lineCells[0]?.value ?? handicapToNumber(currentLine),
      currentAwayWater,
      initialHomeWater,
      initialLine,
      initialLineValue: lineCells[1]?.value ?? handicapToNumber(initialLine),
      initialAwayWater,
    });
  }
  const currentAverageLine = averageLine(rows, "currentLine");
  const initialAverageLine = averageLine(rows, "initialLine");
  return {
    url,
    rows: rows.slice(0, 24),
    companies: rows.length,
    currentAverageLine,
    initialAverageLine,
    lineMovement: currentAverageLine !== null && initialAverageLine !== null
      ? compactNumber(currentAverageLine - initialAverageLine, 3)
      : null,
    summary: currentAverageLine !== null
      ? `500亚盘均线 ${currentAverageLine}${initialAverageLine !== null ? `，初盘 ${initialAverageLine}` : ""}`
      : "",
  };
};

const marketConsensus = (match, europeOdds, asianHandicap) => {
  const had = match.had || null;
  const hhad = match.hhad || null;
  const api = europeOdds?.currentAverage || null;
  const officialProb = implied(had);
  const marketProb = implied(api);
  const homeProbGap = officialProb && marketProb ? compactNumber(officialProb.home - marketProb.home, 4) : null;
  const lineGap = asianHandicap?.currentAverageLine !== null && asianHandicap?.currentAverageLine !== undefined && match.handicapLine
    ? compactNumber(Number(match.handicapLine) - Number(asianHandicap.currentAverageLine), 3)
    : null;
  const notes = [];
  if (homeProbGap !== null && Math.abs(homeProbGap) >= 0.04) notes.push(homeProbGap > 0 ? "竞彩主胜热度高于欧赔均值" : "竞彩主胜热度低于欧赔均值");
  if (lineGap !== null && Math.abs(lineGap) >= 0.25) notes.push(lineGap < 0 ? "竞彩让球浅于亚盘均线" : "竞彩让球深于亚盘均线");
  return {
    officialHadProbability: officialProb,
    europeAverageProbability: marketProb,
    homeProbabilityGap: homeProbGap,
    handicapLineGap: lineGap,
    hhadAvailable: Boolean(hhad),
    riskLevel: notes.length >= 2 ? "high" : notes.length === 1 ? "medium" : "low",
    notes,
  };
};

const buildLegacyDetailSignal = (match, details, updatedAt) => {
  const europeOdds = details.europeOdds || null;
  const asianHandicap = details.asianHandicap || null;
  const analysis = details.analysis || null;
  const consensus = marketConsensus(match, europeOdds, asianHandicap);
  const projectedHome = analysis?.projectedSquads?.home || [];
  const projectedAway = analysis?.projectedSquads?.away || [];
  const bookmakerOdds = {
    ...(match.had ? {
      had: {
        ...match.had,
        source: "500.com:jczq",
        updatedAt,
      },
    } : {}),
    ...(match.hhad ? {
      hhad: {
        ...match.hhad,
        source: "500.com:jczq",
        handicapLine: match.handicapLine,
        updatedAt,
      },
    } : {}),
  };
  const lineupSummary = projectedHome.length || projectedAway.length
    ? {
      zh: `500预计名单：${match.homeTeamName} ${projectedHome.slice(0, 4).join("、") || "--"}；${match.awayTeamName} ${projectedAway.slice(0, 4).join("、") || "--"}。`,
      en: `500 projected squads: ${match.homeTeamName} ${projectedHome.slice(0, 4).join(", ") || "--"}; ${match.awayTeamName} ${projectedAway.slice(0, 4).join(", ") || "--"}.`,
    }
    : undefined;
  return {
    source: "500.com:jczq+500.com:details",
    updatedAt,
    handicapLine: match.handicapLine || undefined,
    ...(Object.keys(bookmakerOdds).length ? { bookmakerOdds } : {}),
    fiveHundred: {
      source: "500.com",
      updatedAt,
      fixtureId: match.fixtureId,
      infoMatchId: match.infoMatchId,
      matchNo: match.matchNo,
      urls: match.urls,
      sale: {
        buyEndTime: match.buyEndTime,
        availability: match.availability,
      },
      ...(Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway) ? {
        result: {
          source: match.resultSource || "500.com:jczq-result",
          updatedAt,
          sourceUpdatedAt: null,
          observationSource: match.resultObservationSource || "500.com-response-received-at",
          resultObservationFallback: true,
          eventVersion: match.eventVersion || match.kickoffTime || null,
          status: "FINISHED",
          scoreHome: match.scoreHome,
          scoreAway: match.scoreAway,
          scoreText: `${match.scoreHome}:${match.scoreAway}`,
        },
      } : {}),
      rank: analysis?.rank || undefined,
      recentForm: analysis?.recentForm || undefined,
      futureSchedule: analysis?.futureSchedule || undefined,
      europeOdds: europeOdds || undefined,
      asianHandicap: asianHandicap || undefined,
      marketConsensus: consensus,
      macauTip: analysis?.macauTip || undefined,
    },
    ...(lineupSummary ? {
      projectedRoster: {
        source: "500.com:projected-roster",
        evidenceType: "projected-roster",
        verified: false,
        summary: lineupSummary,
      },
    } : {}),
    ...(europeOdds?.currentAverage ? {
      externalOdds: {
        source: "500.com:average-europe",
        odds1: europeOdds.currentAverage.odds1,
        oddsX: europeOdds.currentAverage.oddsX,
        odds2: europeOdds.currentAverage.odds2,
        summary: {
          zh: `${europeOdds.summary || "500欧赔均值"}；风险 ${consensus.riskLevel}。`,
          en: `${europeOdds.summary || "500 Europe odds average"}; risk ${consensus.riskLevel}.`,
        },
      },
    } : {}),
  };
};

const hasComponentData = {
  sale: (value) => Boolean(value && (value.buyEndTime || Object.keys(value.availability || {}).length)),
  rank: (value) => Boolean(value && (
    (value.home?.fifaRank !== null && value.home?.fifaRank !== undefined)
    || (value.away?.fifaRank !== null && value.away?.fifaRank !== undefined)
  )),
  recentForm: (value) => Number(value?.home?.sampleSize || 0) > 0 || Number(value?.away?.sampleSize || 0) > 0,
  futureSchedule: (value) => Boolean(
    value?.home?.rows?.length
    || value?.away?.rows?.length
    || Number.isFinite(value?.home?.nextGapDays)
    || Number.isFinite(value?.away?.nextGapDays)
  ),
  europeOdds: (value) => Boolean(value && (Number(value.companies || 0) > 0 || validTriplet(value.currentAverage))),
  asianHandicap: (value) => Boolean(value && (
    Number(value.companies || 0) > 0
    || (value.currentAverageLine !== null && value.currentAverageLine !== undefined)
  )),
  marketConsensus: (value) => Boolean(value && (
    value.officialHadProbability
    || value.europeAverageProbability
    || (value.homeProbabilityGap !== null && value.homeProbabilityGap !== undefined)
    || (value.handicapLineGap !== null && value.handicapLineGap !== undefined)
    || value.hhadAvailable
    || value.notes?.length
  )),
  macauTip: (value) => Boolean(value && (value.pick || value.summary)),
  projectedRoster: (value) => Boolean(value?.summary),
  lineups: (value) => Boolean(value?.summary || value?.homeFormation || value?.awayFormation),
  externalOdds: (value) => validTriplet(value),
};

const preMatchComponentEntries = (signal) => [
  ["bookmakerOdds.had", signal?.bookmakerOdds?.had],
  ["bookmakerOdds.hhad", signal?.bookmakerOdds?.hhad],
  ["handicapLine", signal?.handicapLineMeta],
  ["fiveHundred.sale", signal?.fiveHundred?.sale],
  ["fiveHundred.rank", signal?.fiveHundred?.rank],
  ["fiveHundred.recentForm", signal?.fiveHundred?.recentForm],
  ["fiveHundred.futureSchedule", signal?.fiveHundred?.futureSchedule],
  ["fiveHundred.europeOdds", signal?.fiveHundred?.europeOdds],
  ["fiveHundred.asianHandicap", signal?.fiveHundred?.asianHandicap],
  ["fiveHundred.marketConsensus", signal?.fiveHundred?.marketConsensus],
  ["fiveHundred.macauTip", signal?.fiveHundred?.macauTip],
  ["projectedRoster", signal?.projectedRoster],
  ["confirmedLineup", signal?.confirmedLineup],
  ["lineups", signal?.lineups],
  ["externalOdds", signal?.externalOdds],
].filter(([, value]) => value && typeof value === "object");

const addTimingManifest = (signal) => {
  const entries = preMatchComponentEntries(signal);
  return {
    ...signal,
    preMatchUsableComponents: entries
      .filter(([, component]) => component.usableForPreMatch === true)
      .map(([name]) => name),
    preMatchIneligibleComponents: entries
      .filter(([, component]) => component.usableForPreMatch !== true)
      .map(([name]) => name),
    postMatchOnlyComponents: signal?.fiveHundred?.result
      ? Array.from(new Set([...(signal.postMatchOnlyComponents || []), "fiveHundred.result"]))
      : signal.postMatchOnlyComponents || [],
  };
};

const ensurePreMatchComponentTiming = (component, match, fallbackObservedAt, available = true) => {
  if (!component || typeof component !== "object" || Array.isArray(component)) return component;
  const sourceObservedAt = component.sourceObservedAt || component.updatedAt || fallbackObservedAt;
  const receivedAt = component.receivedAt || sourceObservedAt;
  const derived = preMatchComponentTiming(match, sourceObservedAt, receivedAt);
  const validUntil = observedIso(component.validUntil) || derived.validUntil;
  const observedMs = parseObservedTime(derived.sourceObservedAt);
  const validUntilMs = parseObservedTime(validUntil);
  const timing = {
    ...derived,
    validUntil,
    usableForPreMatch: Boolean(
      available
      && component.usableForPreMatch !== false
      && Number.isFinite(observedMs)
      && Number.isFinite(validUntilMs)
      && observedMs <= validUntilMs
    ),
  };
  timing.observationPhase = !available
    ? "unavailable"
    : timing.usableForPreMatch ? "pre-match" : "post-cutoff";
  return withComponentTiming(component, timing);
};

const ensureSignalComponentTiming = (signal, match, fallbackObservedAt) => {
  if (!signal || typeof signal !== "object") return signal;
  const sourceObservedAt = signal.sourceObservedAt || signal.updatedAt || fallbackObservedAt;
  const rootTiming = preMatchComponentTiming(
    match,
    sourceObservedAt,
    signal.receivedAt || sourceObservedAt,
  );
  const fiveHundred = signal.fiveHundred && typeof signal.fiveHundred === "object"
    ? { ...signal.fiveHundred }
    : undefined;
  const fiveObservedAt = fiveHundred?.sourceObservedAt || fiveHundred?.updatedAt || rootTiming.sourceObservedAt;

  if (fiveHundred) {
    const fiveTiming = preMatchComponentTiming(
      match,
      fiveObservedAt,
      fiveHundred.receivedAt || fiveObservedAt,
    );
    fiveHundred.sourceObservedAt = fiveTiming.sourceObservedAt;
    fiveHundred.receivedAt = fiveTiming.receivedAt;
    fiveHundred.validUntil = observedIso(fiveHundred.validUntil) || fiveTiming.validUntil;
    fiveHundred.updatedAt = fiveTiming.sourceObservedAt || fiveHundred.updatedAt || null;
    fiveHundred.sale = ensurePreMatchComponentTiming(
      fiveHundred.sale,
      match,
      fiveObservedAt,
      hasComponentData.sale(fiveHundred.sale),
    );
    fiveHundred.rank = ensurePreMatchComponentTiming(
      fiveHundred.rank,
      match,
      fiveObservedAt,
      hasComponentData.rank(fiveHundred.rank),
    );
    fiveHundred.recentForm = ensurePreMatchComponentTiming(
      fiveHundred.recentForm,
      match,
      fiveObservedAt,
      hasComponentData.recentForm(fiveHundred.recentForm),
    );
    fiveHundred.futureSchedule = ensurePreMatchComponentTiming(
      fiveHundred.futureSchedule,
      match,
      fiveObservedAt,
      hasComponentData.futureSchedule(fiveHundred.futureSchedule),
    );
    fiveHundred.europeOdds = ensurePreMatchComponentTiming(
      fiveHundred.europeOdds,
      match,
      fiveObservedAt,
      hasComponentData.europeOdds(fiveHundred.europeOdds),
    );
    fiveHundred.asianHandicap = ensurePreMatchComponentTiming(
      fiveHundred.asianHandicap,
      match,
      fiveObservedAt,
      hasComponentData.asianHandicap(fiveHundred.asianHandicap),
    );
    fiveHundred.marketConsensus = ensurePreMatchComponentTiming(
      fiveHundred.marketConsensus,
      match,
      fiveObservedAt,
      hasComponentData.marketConsensus(fiveHundred.marketConsensus),
    );
    fiveHundred.macauTip = ensurePreMatchComponentTiming(
      fiveHundred.macauTip,
      match,
      fiveObservedAt,
      hasComponentData.macauTip(fiveHundred.macauTip),
    );
    if (fiveHundred.result) {
      const resultObservedAt = fiveHundred.result.sourceObservedAt
        || fiveHundred.result.updatedAt
        || match?.resultUpdatedAt
        || fallbackObservedAt;
      fiveHundred.result = withComponentTiming(
        {
          ...fiveHundred.result,
          sourceUpdatedAt: fiveHundred.result.sourceUpdatedAt || null,
          observationSource: fiveHundred.result.observationSource || "500.com-response-received-at",
          resultObservationFallback: true,
          eventVersion: fiveHundred.result.eventVersion || match?.eventVersion || match?.kickoffTime || null,
        },
        resultComponentTiming(resultObservedAt, fiveHundred.result.receivedAt || resultObservedAt),
      );
    }
  }

  const output = {
    ...signal,
    timingPolicy: "component-as-of-v1",
    timingUpdateKind: signal.timingUpdateKind || "component-observation",
    sourceObservedAt: rootTiming.sourceObservedAt,
    receivedAt: rootTiming.receivedAt,
    validUntil: observedIso(signal.validUntil) || rootTiming.validUntil,
    latestReceivedAt: observedIso(signal.latestReceivedAt) || rootTiming.receivedAt,
    updatedAt: rootTiming.sourceObservedAt || signal.updatedAt || null,
    ...(fiveHundred ? { fiveHundred } : {}),
  };
  if (output.bookmakerOdds) {
    output.bookmakerOdds = {
      ...output.bookmakerOdds,
      had: ensurePreMatchComponentTiming(
        output.bookmakerOdds.had,
        match,
        rootTiming.sourceObservedAt,
        validTriplet(output.bookmakerOdds.had),
      ),
      hhad: ensurePreMatchComponentTiming(
        output.bookmakerOdds.hhad,
        match,
        rootTiming.sourceObservedAt,
        validTriplet(output.bookmakerOdds.hhad),
      ),
    };
  }
  output.handicapLineMeta = ensurePreMatchComponentTiming(
    output.handicapLineMeta || (output.handicapLine !== undefined ? {
      source: "500.com:jczq",
      line: output.handicapLine,
    } : undefined),
    match,
    rootTiming.sourceObservedAt,
    output.handicapLine !== undefined && output.handicapLine !== null && output.handicapLine !== "",
  );
  output.projectedRoster = ensurePreMatchComponentTiming(
    output.projectedRoster,
    match,
    rootTiming.sourceObservedAt,
    hasComponentData.projectedRoster(output.projectedRoster),
  );
  output.confirmedLineup = ensurePreMatchComponentTiming(
    output.confirmedLineup,
    match,
    rootTiming.sourceObservedAt,
    hasComponentData.lineups(output.confirmedLineup),
  );
  output.lineups = ensurePreMatchComponentTiming(
    output.lineups,
    match,
    rootTiming.sourceObservedAt,
    hasComponentData.lineups(output.lineups),
  );
  output.externalOdds = ensurePreMatchComponentTiming(
    output.externalOdds,
    match,
    rootTiming.sourceObservedAt,
    hasComponentData.externalOdds(output.externalOdds),
  );
  return addTimingManifest(output);
};

const signalIdentityForMatch = (match) => ({
  sourceMatchId: norm(match?.sourceMatchId) || undefined,
  fixtureId: norm(match?.fixtureId) || undefined,
  infoMatchId: norm(match?.infoMatchId) || undefined,
  matchNo: norm(match?.matchNo) || undefined,
  processDate: norm(match?.processDate) || undefined,
  matchDate: norm(match?.matchDate || String(match?.kickoffTime || "").slice(0, 10)) || undefined,
  leagueName: norm(match?.leagueName) || undefined,
  homeTeamName: norm(match?.homeTeamName) || undefined,
  awayTeamName: norm(match?.awayTeamName) || undefined,
  kickoffTime: norm(match?.kickoffTime) || undefined,
  buyEndTime: norm(match?.buyEndTime) || undefined,
});

const buildDetailSignal = (match, details, updatedAt) => {
  const sourceObservedAt = observedIso(updatedAt);
  const timing = preMatchComponentTiming(match, sourceObservedAt, updatedAt);
  const timed = (component, available = true) => withComponentTiming(
    component,
    timingForAvailableComponent(timing, available),
  );
  const europeOdds = details.europeOdds || null;
  const asianHandicap = details.asianHandicap || null;
  const analysis = details.analysis || null;
  const consensus = marketConsensus(match, europeOdds, asianHandicap);
  const projectedHome = analysis?.projectedSquads?.home || [];
  const projectedAway = analysis?.projectedSquads?.away || [];
  const sale = {
    buyEndTime: match.buyEndTime,
    availability: match.availability,
  };
  const bookmakerOdds = {
    ...(match.had ? {
      had: timed({
        ...match.had,
        source: "500.com:jczq",
      }, validTriplet(match.had)),
    } : {}),
    ...(match.hhad ? {
      hhad: timed({
        ...match.hhad,
        source: "500.com:jczq",
        handicapLine: match.handicapLine,
      }, validTriplet(match.hhad)),
    } : {}),
  };
  const lineupSummary = projectedHome.length || projectedAway.length
    ? {
      zh: `500 projected squads: ${match.homeTeamName} ${projectedHome.slice(0, 4).join(", ") || "--"}; ${match.awayTeamName} ${projectedAway.slice(0, 4).join(", ") || "--"}.`,
      en: `500 projected squads: ${match.homeTeamName} ${projectedHome.slice(0, 4).join(", ") || "--"}; ${match.awayTeamName} ${projectedAway.slice(0, 4).join(", ") || "--"}.`,
    }
    : undefined;
  const hasResult = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
  const result = hasResult
    ? withComponentTiming({
      source: match.resultSource || "500.com:jczq-result",
      sourceUpdatedAt: match.resultSourceUpdatedAt || null,
      observationSource: match.resultObservationSource || "500.com-response-received-at",
      resultObservationFallback: true,
      eventVersion: match.eventVersion || match.kickoffTime || null,
      status: "FINISHED",
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
      scoreText: `${match.scoreHome}:${match.scoreAway}`,
    }, resultComponentTiming(match.resultUpdatedAt || updatedAt, updatedAt))
    : undefined;
  const signal = {
    source: "500.com:jczq+500.com:details",
    ...signalIdentityForMatch(match),
    timingPolicy: "component-as-of-v1",
    timingUpdateKind: "component-observation",
    sourceObservedAt: timing.sourceObservedAt,
    receivedAt: timing.receivedAt,
    validUntil: timing.validUntil,
    latestReceivedAt: timing.receivedAt,
    updatedAt: timing.sourceObservedAt || updatedAt,
    handicapLine: match.handicapLine || undefined,
    ...(match.handicapLine !== undefined && match.handicapLine !== null && match.handicapLine !== "" ? {
      handicapLineMeta: timed({
        source: "500.com:jczq",
        line: match.handicapLine,
      }),
    } : {}),
    ...(Object.keys(bookmakerOdds).length ? { bookmakerOdds } : {}),
    fiveHundred: {
      source: "500.com",
      sourceObservedAt: timing.sourceObservedAt,
      receivedAt: timing.receivedAt,
      validUntil: timing.validUntil,
      updatedAt: timing.sourceObservedAt || updatedAt,
      fixtureId: match.fixtureId,
      infoMatchId: match.infoMatchId,
      matchNo: match.matchNo,
      urls: match.urls,
      sale: timed(sale, hasComponentData.sale(sale)),
      ...(result ? { result } : {}),
      rank: analysis?.rank ? timed(analysis.rank, hasComponentData.rank(analysis.rank)) : undefined,
      recentForm: analysis?.recentForm
        ? timed(analysis.recentForm, hasComponentData.recentForm(analysis.recentForm))
        : undefined,
      futureSchedule: analysis?.futureSchedule
        ? timed(analysis.futureSchedule, hasComponentData.futureSchedule(analysis.futureSchedule))
        : undefined,
      europeOdds: europeOdds ? timed(europeOdds, hasComponentData.europeOdds(europeOdds)) : undefined,
      asianHandicap: asianHandicap
        ? timed(asianHandicap, hasComponentData.asianHandicap(asianHandicap))
        : undefined,
      marketConsensus: timed(consensus, hasComponentData.marketConsensus(consensus)),
      macauTip: analysis?.macauTip
        ? timed(analysis.macauTip, hasComponentData.macauTip(analysis.macauTip))
        : undefined,
    },
    ...(lineupSummary ? {
      projectedRoster: timed({
        source: "500.com:projected-roster",
        evidenceType: "projected-roster",
        verified: false,
        summary: lineupSummary,
      }),
    } : {}),
    ...(europeOdds?.currentAverage ? {
      externalOdds: timed({
        source: "500.com:average-europe",
        odds1: europeOdds.currentAverage.odds1,
        oddsX: europeOdds.currentAverage.oddsX,
        odds2: europeOdds.currentAverage.odds2,
        summary: {
          zh: `${europeOdds.summary || "500 Europe odds average"}; risk ${consensus.riskLevel}.`,
          en: `${europeOdds.summary || "500 Europe odds average"}; risk ${consensus.riskLevel}.`,
        },
      }, validTriplet(europeOdds.currentAverage)),
    } : {}),
  };
  return addTimingManifest(signal);
};

const buildResultMergeSignal = (
  match,
  existingSignal,
  receivedAt,
  cachedDetails = {},
  cachedObservedAt,
) => {
  const fallbackObservedAt = cachedObservedAt || receivedAt;
  const base = existingSignal
    ? ensureSignalComponentTiming(existingSignal, match, fallbackObservedAt)
    : buildDetailSignal(match, cachedDetails, fallbackObservedAt);
  const resultObservedAt = match.resultUpdatedAt || receivedAt;
  const result = withComponentTiming({
    ...(base?.fiveHundred?.result || {}),
    source: match.resultSource || "500.com:jczq-result",
    sourceUpdatedAt: match.resultSourceUpdatedAt || null,
    observationSource: match.resultObservationSource || "500.com-response-received-at",
    resultObservationFallback: true,
    eventVersion: match.eventVersion || match.kickoffTime || null,
    status: "FINISHED",
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
    scoreText: `${match.scoreHome}:${match.scoreAway}`,
  }, resultComponentTiming(resultObservedAt, receivedAt));
  return addTimingManifest({
    ...base,
    ...signalIdentityForMatch(match),
    timingPolicy: "component-as-of-v1",
    timingUpdateKind: "result-only",
    latestReceivedAt: observedIso(receivedAt) || base?.latestReceivedAt || null,
    resultUpdatedAt: result.sourceObservedAt,
    fiveHundred: {
      ...(base?.fiveHundred || {}),
      result,
    },
  });
};

const mergeSourceName = (existingSource, nextSource) => {
  const parts = String(existingSource || "")
    .split("+")
    .concat(String(nextSource || "").split("+"))
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join("+") || nextSource || existingSource || "500.com:details";
};

const mergeSignal = (existing, next) => {
  existing = eventSafeExistingSignal(existing, next);
  const resultOnly = next?.timingUpdateKind === "result-only";
  const preserveExistingObservation = Boolean(resultOnly && existing);
  const output = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...next,
    source: mergeSourceName(existing?.source, next.source),
    sourceObservedAt: preserveExistingObservation
      ? existing.sourceObservedAt || existing.updatedAt || next.sourceObservedAt
      : next.sourceObservedAt || next.updatedAt || existing?.sourceObservedAt || existing?.updatedAt,
    receivedAt: preserveExistingObservation
      ? existing.receivedAt || existing.sourceObservedAt || existing.updatedAt
      : next.receivedAt || next.sourceObservedAt || next.updatedAt || existing?.receivedAt,
    validUntil: preserveExistingObservation
      ? existing.validUntil || next.validUntil
      : next.validUntil || existing?.validUntil,
    latestReceivedAt: next.latestReceivedAt
      || next.receivedAt
      || existing?.latestReceivedAt
      || existing?.receivedAt
      || null,
    updatedAt: preserveExistingObservation
      ? existing.updatedAt || existing.sourceObservedAt || next.updatedAt
      : next.updatedAt || existing?.updatedAt || nowIso(),
  };
  output.bookmakerOdds = resultOnly && existing?.bookmakerOdds
    ? { ...(next.bookmakerOdds || {}), ...existing.bookmakerOdds }
    : { ...(existing?.bookmakerOdds || {}), ...(next.bookmakerOdds || {}) };
  if (existing?.injuries && !next.injuries) output.injuries = existing.injuries;
  if (existing?.projectedRoster && next.projectedRoster) {
    output.projectedRoster = resultOnly
      ? { ...next.projectedRoster, ...existing.projectedRoster }
      : { ...existing.projectedRoster, ...next.projectedRoster };
  }
  if (existing?.projectedRoster && !next.projectedRoster) output.projectedRoster = existing.projectedRoster;
  if (existing?.confirmedLineup && !next.confirmedLineup) output.confirmedLineup = existing.confirmedLineup;
  if (existing?.lineups && next.lineups) {
    output.lineups = resultOnly
      ? { ...next.lineups, ...existing.lineups }
      : { ...existing.lineups, ...next.lineups };
  }
  if (existing?.lineups && !next.lineups) output.lineups = existing.lineups;
  if (existing?.apiFootball && !next.apiFootball) output.apiFootball = existing.apiFootball;
  if (existing?.fiveHundred && next.fiveHundred) {
    output.fiveHundred = resultOnly
      ? {
        ...next.fiveHundred,
        ...existing.fiveHundred,
        result: next.fiveHundred.result || existing.fiveHundred.result,
      }
      : { ...existing.fiveHundred, ...next.fiveHundred };
  }
  if (resultOnly && existing?.handicapLineMeta) output.handicapLineMeta = existing.handicapLineMeta;
  if (resultOnly && existing?.externalOdds) output.externalOdds = existing.externalOdds;
  return addTimingManifest(output);
};

const selectTargets = (rows, cache) => {
  const now = Date.now();
  const refreshMinutesFor = (row) => {
    const kickoff = Date.parse(row?.kickoffTime || "");
    if (!Number.isFinite(kickoff)) return REFRESH_MINUTES;
    const minutesUntilKickoff = (kickoff - now) / 60000;
    if (minutesUntilKickoff <= 90) return URGENT_REFRESH_MINUTES;
    if (minutesUntilKickoff <= 6 * 60) return NEAR_REFRESH_MINUTES;
    return REFRESH_MINUTES;
  };
  return rows
    .filter((row) => row.urls.analysis || row.urls.europeOdds || row.urls.asianHandicap)
    .filter((row) => {
      const kickoff = Date.parse(row.kickoffTime || "");
      if (Number.isFinite(kickoff) && kickoff + 2 * 3600000 < now) return false;
      const cached = cache.matches?.[row.sourceMatchId];
      return !cached || !isFresh(cached.updatedAt, refreshMinutesFor(row));
    })
    .sort((a, b) => {
      const aCached = cache.matches?.[a.sourceMatchId] ? 1 : 0;
      const bCached = cache.matches?.[b.sourceMatchId] ? 1 : 0;
      return aCached - bCached
        || Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || "");
    })
    .slice(0, MAX_MATCHES);
};

const main = async () => {
  const updatedAt = nowIso();
  const existingDetails = readJson(DETAILS_FILE, { version: 1, source: "500.com:details", matches: {} });
  const external = readJson(EXTERNAL_SIGNALS_FILE, { version: 1, source: "external-signals", matches: {}, sources: {} });
  // Result-only mode skips the unrelated current fixture page and queries only
  // the newest business/kickoff dates represented by unresolved cached rows.
  // The date cap and concurrent requests keep the hot settlement path bounded
  // while still working after 500.com has moved yesterday's games to archives.
  const currentTradeRows = RESULT_ONLY_MODE
    ? []
    : parseTradeRows(await httpGetHtml(SOURCE_URL, "https://www.500.com/"));
  const recentResults = await fetchRecentResultRows(
    existingDetails,
    Object.values(external.matches || {}),
    { maxDates: RESULT_ONLY_MODE ? RESULT_ONLY_ARCHIVE_MAX_DATES : 4 },
  );
  const tradeRows = uniqueBySourceMatchId([...currentTradeRows, ...recentResults.rows]);
  const currentResultRows = currentTradeRows.filter(
    (row) => Number.isFinite(row.scoreHome) && Number.isFinite(row.scoreAway)
  ).length;
  const resultRows = tradeRows.filter(
    (row) => Number.isFinite(row.scoreHome) && Number.isFinite(row.scoreAway)
  ).length;
  const targets = RESULT_ONLY_MODE ? [] : selectTargets(tradeRows, existingDetails);
  const detailsMatches = { ...(existingDetails.matches || {}) };
  const externalMatches = { ...(external.matches || {}) };
  const errors = [];
  let requestedPages = recentResults.dates.length + (RESULT_ONLY_MODE ? 0 : 1);
  let updated = 0;
  let cachedMerged = 0;
  let resultMerged = 0;
  const mergedCacheIds = new Set();

  const mergeCachedSignal = (match, cached) => {
    const kickoff = Date.parse(match.kickoffTime || cached?.kickoffTime || "");
    const hasMatchResult = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
    const hasCachedResult = Number.isFinite(cached?.signal?.fiveHundred?.result?.scoreHome)
      && Number.isFinite(cached?.signal?.fiveHundred?.result?.scoreAway);
    if (!hasMatchResult && !cached?.signal) return;
    if (!hasMatchResult && !hasCachedResult && Number.isFinite(kickoff) && kickoff + 2 * 3600000 < Date.now()) return;
    const signal = hasMatchResult
      ? buildResultMergeSignal(
        match,
        cached?.signal,
        updatedAt,
        cached?.details || {},
        cached?.sourceObservedAt || cached?.updatedAt,
      )
      : ensureSignalComponentTiming(
        cached.signal,
        match,
        cached?.sourceObservedAt || cached?.updatedAt,
      );
    const keys = signalKeys(match);
    const externalResultChanged = hasMatchResult && keys.some((key) => {
      const externalResult = externalMatches[key]?.fiveHundred?.result;
      return externalResult?.scoreHome !== match.scoreHome
        || externalResult?.scoreAway !== match.scoreAway;
    });
    if (hasMatchResult) {
      if (
        !cached?.signal ||
        !hasCachedResult ||
        cached?.signal?.fiveHundred?.result?.scoreHome !== match.scoreHome ||
        cached?.signal?.fiveHundred?.result?.scoreAway !== match.scoreAway ||
        externalResultChanged
      ) {
        resultMerged += 1;
      }
      detailsMatches[match.sourceMatchId] = {
        ...cached,
        ...match,
        sourceObservedAt: cached?.sourceObservedAt || signal.sourceObservedAt || cached?.updatedAt || updatedAt,
        receivedAt: cached?.receivedAt || signal.receivedAt || cached?.updatedAt || updatedAt,
        validUntil: cached?.validUntil || signal.validUntil || preMatchValidUntil(match),
        latestReceivedAt: updatedAt,
        resultUpdatedAt: signal.resultUpdatedAt || match.resultUpdatedAt || updatedAt,
        updatedAt: cached?.updatedAt || signal.updatedAt || updatedAt,
        details: cached?.details || {},
        signal,
      };
    }
    for (const key of keys) {
      externalMatches[key] = mergeSignal(externalMatches[key], signal);
    }
    mergedCacheIds.add(match.sourceMatchId || cached?.sourceMatchId);
    cachedMerged += 1;
  };

  for (const match of tradeRows) {
    const cached = detailsMatches[match.sourceMatchId];
    mergeCachedSignal(match, cached);
  }

  for (const cached of Object.values(detailsMatches)) {
    if (!cached?.sourceMatchId || mergedCacheIds.has(cached.sourceMatchId)) continue;
    mergeCachedSignal(cached, cached);
  }

  for (const match of targets) {
    try {
      const details = {
        analysis: match.urls.analysis ? await parseAnalysisPage(match.urls.analysis, match) : null,
        europeOdds: match.urls.europeOdds ? await parseEuropeOdds(match.urls.europeOdds) : null,
        asianHandicap: match.urls.asianHandicap ? await parseAsianHandicap(match.urls.asianHandicap) : null,
      };
      requestedPages += [match.urls.analysis, match.urls.europeOdds, match.urls.asianHandicap].filter(Boolean).length;
      const signal = buildDetailSignal(match, details, updatedAt);
      const payload = {
        ...match,
        sourceObservedAt: observedIso(updatedAt),
        receivedAt: observedIso(updatedAt),
        validUntil: preMatchValidUntil(match),
        latestReceivedAt: observedIso(updatedAt),
        updatedAt,
        details,
        signal,
      };
      detailsMatches[match.sourceMatchId] = payload;
      for (const key of signalKeys(match)) {
        externalMatches[key] = mergeSignal(externalMatches[key], signal);
      }
      updated += 1;
      sleepMs(250);
    } catch (error) {
      errors.push({
        sourceMatchId: match.sourceMatchId,
        message: error.message || String(error),
      });
      if (errors.length >= MAX_ERRORS) break;
    }
  }

  const detailsPayload = {
    version: 1,
    source: "500.com:details",
    mode: RESULT_ONLY_MODE ? "result-only-recent-archive" : "full-details",
    updatedAt,
    url: SOURCE_URL,
    maxMatches: MAX_MATCHES,
    refreshMinutes: REFRESH_MINUTES,
    nearRefreshMinutes: NEAR_REFRESH_MINUTES,
    urgentRefreshMinutes: URGENT_REFRESH_MINUTES,
    timeoutSeconds: DETAIL_TIMEOUT_SECONDS,
    maxErrors: MAX_ERRORS,
    scannedRows: currentTradeRows.length,
    resultArchiveDates: recentResults.dates,
    currentResultRows,
    resultRows,
    updated,
    detailsUpdatedThisRun: updated,
    resultMerged,
    cachedMerged,
    detailsStoredTotal: Object.keys(detailsMatches).length,
    currentEligibleRows: currentTradeRows.filter((row) => (
      row.urls?.analysis || row.urls?.europeOdds || row.urls?.asianHandicap
    )).length,
    currentMatchesWithDetails: currentTradeRows.filter((row) => Boolean(detailsMatches[row.sourceMatchId]?.signal)).length,
    requestedPages,
    errors: [...recentResults.errors, ...errors],
    matches: detailsMatches,
  };
  writeJson(DETAILS_FILE, detailsPayload);

  const externalPayload = {
    version: 1,
    source: "external-signals",
    updatedAt: (updated || resultMerged) ? updatedAt : (external.updatedAt || updatedAt),
    sources: {
      ...(external.sources || {}),
      "500.com:details": {
        url: SOURCE_URL,
        mode: RESULT_ONLY_MODE ? "result-only-recent-archive" : "full-details",
        updatedAt,
        scannedRows: currentTradeRows.length,
        resultArchiveDates: recentResults.dates,
        currentResultRows,
        resultRows,
        updated,
        detailsUpdatedThisRun: updated,
        resultMerged,
        cachedMerged,
        detailsStoredTotal: Object.keys(detailsMatches).length,
        currentEligibleRows: currentTradeRows.filter((row) => (
          row.urls?.analysis || row.urls?.europeOdds || row.urls?.asianHandicap
        )).length,
        currentMatchesWithDetails: currentTradeRows.filter((row) => Boolean(detailsMatches[row.sourceMatchId]?.signal)).length,
        requestedPages,
        refreshMinutes: REFRESH_MINUTES,
        nearRefreshMinutes: NEAR_REFRESH_MINUTES,
        urgentRefreshMinutes: URGENT_REFRESH_MINUTES,
        timeoutSeconds: DETAIL_TIMEOUT_SECONDS,
        maxErrors: MAX_ERRORS,
        errors: recentResults.errors.length + errors.length,
      },
    },
    matches: externalMatches,
  };
  writeJson(EXTERNAL_SIGNALS_FILE, externalPayload);

  const allErrors = [...recentResults.errors, ...errors];
  const hasUsableDetails = updated > 0 || cachedMerged > 0;

  console.log(JSON.stringify({
    ok: allErrors.length === 0 || hasUsableDetails,
    degraded: allErrors.length > 0 && hasUsableDetails,
    source: "500.com:details",
    mode: RESULT_ONLY_MODE ? "result-only-recent-archive" : "full-details",
    scannedRows: currentTradeRows.length,
    resultArchiveDates: recentResults.dates,
    currentResultRows,
    resultRows,
    targets: targets.length,
    updated,
    detailsUpdatedThisRun: updated,
    resultMerged,
    cachedMerged,
    detailsStoredTotal: Object.keys(detailsMatches).length,
    currentEligibleRows: currentTradeRows.filter((row) => (
      row.urls?.analysis || row.urls?.europeOdds || row.urls?.asianHandicap
    )).length,
    currentMatchesWithDetails: currentTradeRows.filter((row) => Boolean(detailsMatches[row.sourceMatchId]?.signal)).length,
    requestedPages,
    warnings: allErrors.length > 0 && hasUsableDetails ? allErrors : [],
    errors: hasUsableDetails ? [] : allErrors,
    output: path.relative(PROJECT_ROOT, DETAILS_FILE),
  }, null, 2));
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
} else {
  module.exports = {
    absoluteUrl,
    buildDetailSignal,
    buildResultMergeSignal,
    ensureSignalComponentTiming,
    mergeSignal,
    preMatchComponentTiming,
    resultComponentTiming,
    resultArchiveDatesForRows,
    boundedResultArchiveDatesForRows,
    signalIdentityForMatch,
  };
}
