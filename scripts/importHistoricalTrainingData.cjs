const fs = require("fs");
const path = require("path");
const https = require("https");
const { pipeline } = require("stream/promises");
const readline = require("readline");

const VERSION = "historical-training-v1";
const MATCHES_URL = process.env.HISTORICAL_MATCHES_CSV_URL
  || "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv";
const INTERNATIONAL_RESULTS_URL = process.env.HISTORICAL_INTERNATIONAL_RESULTS_CSV_URL
  || "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";
const rootDir = path.resolve(__dirname, "..");
const trainingDir = path.join(rootDir, "server-data", "training");
const rawDir = path.join(trainingDir, "raw");
const rawMatchesFile = path.join(rawDir, "xgabora-Matches.csv");
const rawInternationalFile = path.join(rawDir, "martj42-international-results.csv");
const indexFile = path.join(trainingDir, "historical-training-index.json");
const aliasesFile = path.join(trainingDir, "team-aliases.json");
const RECENT_MATCH_LIMIT = Math.max(12, Number(process.env.HISTORICAL_RECENT_MATCH_LIMIT || 32));

const BUILTIN_TEAM_ALIASES = Object.freeze({
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

const CURRENT_TEAM_ALIASES = Object.freeze({
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, payload) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJsonObject(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function requestStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "user-agent": "football-predict-training-import/1.0",
        accept: "text/csv, text/plain, */*",
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(requestStream(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`download failed ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      resolve(res);
    });
    req.setTimeout(90000, () => {
      req.destroy(new Error(`download timed out for ${url}`));
    });
    req.on("error", reject);
  });
}

async function downloadIfNeeded(url, file) {
  ensureDir(path.dirname(file));
  const refresh = process.env.HISTORICAL_TRAINING_REFRESH === "1";
  if (fs.existsSync(file) && !refresh) {
    return { downloaded: false, file, bytes: fs.statSync(file).size };
  }

  const tmp = `${file}.tmp`;
  const stream = await requestStream(url);
  await pipeline(stream, fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return { downloaded: true, file, bytes: fs.statSync(file).size };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTeamKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function loadAliases() {
  if (!fs.existsSync(aliasesFile)) {
    writeJson(aliasesFile, {
      version: 1,
      aliases: {},
      note: "Map normalized current team names to normalized historical team names, for example { \"man utd\": \"manchester united\" }.",
    });
  }
  const parsed = readJsonObject(aliasesFile, { aliases: {} });
  return parsed.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {};
}

function aliasKey(rawName, aliases) {
  const key = normalizeTeamKey(rawName);
  return aliases[key] || CURRENT_TEAM_ALIASES[key] || BUILTIN_TEAM_ALIASES[key] || key;
}

function divisionCountry(division) {
  const code = String(division || "").toUpperCase();
  if (/^E/.test(code)) return "England";
  if (/^SC/.test(code)) return "Scotland";
  if (/^SP/.test(code)) return "Spain";
  if (/^D/.test(code)) return "Germany";
  if (/^I/.test(code)) return "Italy";
  if (/^F/.test(code)) return "France";
  if (/^N/.test(code)) return "Netherlands";
  if (/^B/.test(code)) return "Belgium";
  if (/^P/.test(code)) return "Portugal";
  if (/^T/.test(code)) return "Turkey";
  if (/^G/.test(code)) return "Greece";
  if (/^ARG/.test(code)) return "Argentina";
  if (/^BRA/.test(code)) return "Brazil";
  if (/^MEX/.test(code)) return "Mexico";
  if (/^USA/.test(code)) return "United States";
  if (/^JPN/.test(code)) return "Japan";
  if (/^CHN/.test(code)) return "China";
  if (/^RUS/.test(code)) return "Russia";
  if (/^SWE/.test(code)) return "Sweden";
  if (/^NOR/.test(code)) return "Norway";
  if (/^FIN/.test(code)) return "Finland";
  if (/^DEN/.test(code)) return "Denmark";
  if (/^AUT/.test(code)) return "Austria";
  if (/^SWZ|^SUI/.test(code)) return "Switzerland";
  return "";
}

function normalizedCountryKey(value) {
  return normalizeTeamKey(value);
}

function emptyAggregate() {
  return {
    matches: 0,
    homeWins: 0,
    draws: 0,
    awayWins: 0,
    goalsHome: 0,
    goalsAway: 0,
    over25: 0,
    btts: 0,
    firstMatchDate: "",
    lastMatchDate: "",
  };
}

function addAggregate(aggregate, row) {
  aggregate.matches += 1;
  aggregate.homeWins += row.scoreHome > row.scoreAway ? 1 : 0;
  aggregate.draws += row.scoreHome === row.scoreAway ? 1 : 0;
  aggregate.awayWins += row.scoreHome < row.scoreAway ? 1 : 0;
  aggregate.goalsHome += row.scoreHome;
  aggregate.goalsAway += row.scoreAway;
  aggregate.over25 += row.scoreHome + row.scoreAway >= 3 ? 1 : 0;
  aggregate.btts += row.scoreHome > 0 && row.scoreAway > 0 ? 1 : 0;
  if (!aggregate.firstMatchDate || row.matchDate < aggregate.firstMatchDate) aggregate.firstMatchDate = row.matchDate;
  if (!aggregate.lastMatchDate || row.matchDate > aggregate.lastMatchDate) aggregate.lastMatchDate = row.matchDate;
}

function finalizeAggregate(aggregate) {
  const matches = aggregate.matches || 0;
  if (!matches) return null;
  return {
    matches,
    homeGoalsAvg: Number((aggregate.goalsHome / matches).toFixed(3)),
    awayGoalsAvg: Number((aggregate.goalsAway / matches).toFixed(3)),
    totalGoalsAvg: Number(((aggregate.goalsHome + aggregate.goalsAway) / matches).toFixed(3)),
    homeWinRate: Number((aggregate.homeWins / matches).toFixed(3)),
    drawRate: Number((aggregate.draws / matches).toFixed(3)),
    awayWinRate: Number((aggregate.awayWins / matches).toFixed(3)),
    over25Rate: Number((aggregate.over25 / matches).toFixed(3)),
    bttsRate: Number((aggregate.btts / matches).toFixed(3)),
    firstMatchDate: aggregate.firstMatchDate || null,
    lastMatchDate: aggregate.lastMatchDate || null,
  };
}

function teamRecord(name) {
  return {
    name,
    matches: 0,
    latestElo: null,
    eloUpdatedAt: null,
    firstMatchDate: "",
    lastMatchDate: "",
    recent: [],
  };
}

function addTeamMatch(team, row, side) {
  const isHome = side === "home";
  const elo = isHome ? row.homeElo : row.awayElo;
  team.matches += 1;
  if (Number.isFinite(elo)) {
    team.latestElo = Number(elo.toFixed(2));
    team.eloUpdatedAt = row.matchDate;
  }
  if (!team.firstMatchDate || row.matchDate < team.firstMatchDate) team.firstMatchDate = row.matchDate;
  if (!team.lastMatchDate || row.matchDate > team.lastMatchDate) team.lastMatchDate = row.matchDate;
  team.recent.push({
    source: "xgabora",
    division: row.division,
    kickoffTime: `${row.matchDate}T12:00:00+01:00`,
    homeKey: row.homeKey,
    awayKey: row.awayKey,
    scoreHome: row.scoreHome,
    scoreAway: row.scoreAway,
  });
  if (team.recent.length > RECENT_MATCH_LIMIT) team.recent.splice(0, team.recent.length - RECENT_MATCH_LIMIT);
}

function eloExpected(homeRating, awayRating, homeAdvantage) {
  return 1 / (1 + 10 ** (-((homeRating + homeAdvantage) - awayRating) / 400));
}

function updateInternationalElo(ratings, counts, row) {
  const homeRating = ratings.get(row.homeKey) ?? 1500;
  const awayRating = ratings.get(row.awayKey) ?? 1500;
  const homeAdvantage = row.neutral ? 0 : 50;
  const expectedHome = eloExpected(homeRating, awayRating, homeAdvantage);
  const actualHome = row.scoreHome > row.scoreAway ? 1 : row.scoreHome === row.scoreAway ? 0.5 : 0;
  const goalDiff = Math.abs(row.scoreHome - row.scoreAway);
  const marginMultiplier = goalDiff <= 1 ? 1 : Math.min(1.8, Math.log(goalDiff + 1));
  const delta = 26 * marginMultiplier * (actualHome - expectedHome);
  ratings.set(row.homeKey, homeRating + delta);
  ratings.set(row.awayKey, awayRating - delta);
  counts.set(row.homeKey, (counts.get(row.homeKey) || 0) + 1);
  counts.set(row.awayKey, (counts.get(row.awayKey) || 0) + 1);
}

function addInternationalTeamMatch(team, row, side, rating, count) {
  team.matches = Math.max(team.matches || 0, count || 0);
  team.latestElo = Number(rating.toFixed(2));
  team.eloUpdatedAt = row.matchDate;
  if (!team.firstMatchDate || row.matchDate < team.firstMatchDate) team.firstMatchDate = row.matchDate;
  if (!team.lastMatchDate || row.matchDate > team.lastMatchDate) team.lastMatchDate = row.matchDate;
  team.recent.push({
    source: "martj42",
    division: "INT",
    tournament: row.tournament,
    neutral: row.neutral,
    kickoffTime: `${row.matchDate}T12:00:00+00:00`,
    homeKey: row.homeKey,
    awayKey: row.awayKey,
    scoreHome: row.scoreHome,
    scoreAway: row.scoreAway,
  });
  if (team.recent.length > RECENT_MATCH_LIMIT) team.recent.splice(0, team.recent.length - RECENT_MATCH_LIMIT);
}

async function addInternationalResults(file, state, aliases) {
  if (!fs.existsSync(file)) return { rows: 0, skipped: 0, teams: 0, firstMatchDate: "", lastMatchDate: "" };
  const ratings = new Map();
  const counts = new Map();
  let header = null;
  let rows = 0;
  let skipped = 0;
  let firstMatchDate = "";
  let lastMatchDate = "";

  const stream = fs.createReadStream(file, "utf8");
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const record = Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
    const scoreHome = toNum(record.home_score);
    const scoreAway = toNum(record.away_score);
    const matchDate = record.date;
    const homeTeam = record.home_team;
    const awayTeam = record.away_team;
    if (!matchDate || !homeTeam || !awayTeam || scoreHome === null || scoreAway === null) {
      skipped += 1;
      continue;
    }
    const row = {
      division: "INT",
      country: "World",
      tournament: record.tournament || "International",
      matchDate,
      homeTeam,
      awayTeam,
      homeKey: aliasKey(homeTeam, aliases),
      awayKey: aliasKey(awayTeam, aliases),
      neutral: /^true$/i.test(record.neutral || ""),
      scoreHome,
      scoreAway,
    };

    rows += 1;
    if (!firstMatchDate || matchDate < firstMatchDate) firstMatchDate = matchDate;
    if (!lastMatchDate || matchDate > lastMatchDate) lastMatchDate = matchDate;

    if (!state.teams[row.homeKey]) state.teams[row.homeKey] = teamRecord(homeTeam);
    if (!state.teams[row.awayKey]) state.teams[row.awayKey] = teamRecord(awayTeam);

    updateInternationalElo(ratings, counts, row);
    addInternationalTeamMatch(state.teams[row.homeKey], row, "home", ratings.get(row.homeKey), counts.get(row.homeKey));
    addInternationalTeamMatch(state.teams[row.awayKey], row, "away", ratings.get(row.awayKey), counts.get(row.awayKey));

    if (!state.divisions.INT) state.divisions.INT = emptyAggregate();
    addAggregate(state.divisions.INT, row);
    if (!state.international) state.international = emptyAggregate();
    addAggregate(state.international, row);
  }

  return {
    rows,
    skipped,
    teams: ratings.size,
    firstMatchDate,
    lastMatchDate,
  };
}

async function buildIndex(file) {
  const aliases = loadAliases();
  const teams = {};
  const divisions = {};
  const countries = {};
  const global = emptyAggregate();
  const state = { teams, divisions, countries, international: emptyAggregate() };
  let header = null;
  let rowCount = 0;
  let skipped = 0;
  let firstMatchDate = "";
  let lastMatchDate = "";

  const stream = fs.createReadStream(file, "utf8");
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const record = Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
    const scoreHome = toNum(record.FTHome);
    const scoreAway = toNum(record.FTAway);
    const matchDate = record.MatchDate;
    const homeTeam = record.HomeTeam;
    const awayTeam = record.AwayTeam;
    if (!matchDate || !homeTeam || !awayTeam || scoreHome === null || scoreAway === null) {
      skipped += 1;
      continue;
    }

    const row = {
      division: record.Division || "unknown",
      country: divisionCountry(record.Division),
      matchDate,
      homeTeam,
      awayTeam,
      homeKey: aliasKey(homeTeam, aliases),
      awayKey: aliasKey(awayTeam, aliases),
      homeElo: toNum(record.HomeElo),
      awayElo: toNum(record.AwayElo),
      form5Home: toNum(record.Form5Home),
      form5Away: toNum(record.Form5Away),
      scoreHome,
      scoreAway,
    };

    rowCount += 1;
    if (!firstMatchDate || matchDate < firstMatchDate) firstMatchDate = matchDate;
    if (!lastMatchDate || matchDate > lastMatchDate) lastMatchDate = matchDate;

    if (!state.teams[row.homeKey]) state.teams[row.homeKey] = teamRecord(homeTeam);
    if (!state.teams[row.awayKey]) state.teams[row.awayKey] = teamRecord(awayTeam);
    addTeamMatch(state.teams[row.homeKey], row, "home");
    addTeamMatch(state.teams[row.awayKey], row, "away");

    if (!state.divisions[row.division]) state.divisions[row.division] = emptyAggregate();
    addAggregate(state.divisions[row.division], row);

    const countryKey = normalizedCountryKey(row.country);
    if (countryKey) {
      if (!state.countries[countryKey]) state.countries[countryKey] = emptyAggregate();
      addAggregate(state.countries[countryKey], row);
    }
    addAggregate(global, row);
  }

  const international = await addInternationalResults(rawInternationalFile, state, aliases);

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      name: "xgabora/Club-Football-Match-Data-2000-2025 + martj42/international_results",
      clubUrl: "https://github.com/xgabora/Club-Football-Match-Data-2000-2025",
      internationalUrl: "https://github.com/martj42/international_results",
      matchesCsvUrl: MATCHES_URL,
      internationalResultsCsvUrl: INTERNATIONAL_RESULTS_URL,
      clubLicense: "MIT",
    },
    raw: {
      matchesCsv: {
        file: path.relative(rootDir, file).replace(/\\/g, "/"),
        bytes: fs.statSync(file).size,
      },
      internationalResultsCsv: fs.existsSync(rawInternationalFile) ? {
        file: path.relative(rootDir, rawInternationalFile).replace(/\\/g, "/"),
        bytes: fs.statSync(rawInternationalFile).size,
      } : null,
    },
    sample: {
      rows: rowCount + international.rows,
      clubRows: rowCount,
      internationalRows: international.rows,
      skipped: skipped + international.skipped,
      teams: Object.keys(teams).length,
      divisions: Object.keys(divisions).length,
      countries: Object.keys(countries).length,
      firstMatchDate: [firstMatchDate, international.firstMatchDate].filter(Boolean).sort()[0] || "",
      lastMatchDate: [lastMatchDate, international.lastMatchDate].filter(Boolean).sort().at(-1) || "",
      recentMatchLimit: RECENT_MATCH_LIMIT,
    },
    teamAliases: {
      file: path.relative(rootDir, aliasesFile).replace(/\\/g, "/"),
      entries: Object.keys(aliases).length,
    },
    teams,
    leaguePriors: {
      divisions: Object.fromEntries(Object.entries(divisions).map(([key, value]) => [key, finalizeAggregate(value)])),
      countries: Object.fromEntries(Object.entries(countries).map(([key, value]) => [key, finalizeAggregate(value)])),
      international: finalizeAggregate(state.international),
      global: finalizeAggregate(global),
    },
  };
}

(async () => {
  ensureDir(trainingDir);
  const download = await downloadIfNeeded(MATCHES_URL, rawMatchesFile);
  const internationalDownload = await downloadIfNeeded(INTERNATIONAL_RESULTS_URL, rawInternationalFile);
  const index = await buildIndex(rawMatchesFile);
  writeJson(indexFile, index);
  console.log(JSON.stringify({
    ok: true,
    version: index.version,
    downloaded: download.downloaded,
    internationalDownloaded: internationalDownload.downloaded,
    rawBytes: download.bytes,
    internationalRawBytes: internationalDownload.bytes,
    output: indexFile,
    sample: index.sample,
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
