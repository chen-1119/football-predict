const fs = require("fs");
const https = require("https");
const path = require("path");
const iconv = require("iconv-lite");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const OUTPUT_FILE = path.join(PUBLIC_DIR, "data", "external-signals.json");
const SOURCE_URL = process.env.FIVE_HUNDRED_JCZQ_URL || "https://trade.500.com/jczq/";

const REQUEST_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  Referer: "https://www.500.com/",
});

function htmlDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function norm(value) {
  return htmlDecode(value).replace(/\s+/g, " ").trim();
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers: REQUEST_HEADERS }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = iconv.decode(body.slice(0, 200), "gbk").replace(/\s+/g, " ");
          reject(new Error(`${url} -> HTTP ${res.statusCode} ${preview}`));
          return;
        }
        resolve(body);
      });
    });
    req.setTimeout(20000, () => {
      req.destroy(new Error(`timeout: ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(attrText))) {
    attrs[match[1]] = htmlDecode(match[2]);
  }
  return attrs;
}

function parseOdds(rowHtml, type) {
  const odds = {};
  const re = new RegExp(`<p[^>]*data-type="${type}"[^>]*data-value="([310])"[^>]*data-sp="([^"]*)"`, "g");
  let match;
  while ((match = re.exec(rowHtml))) {
    const value = match[1];
    const sp = toNum(match[2]);
    if (!sp) continue;
    if (value === "3") odds.odds1 = sp;
    if (value === "1") odds.oddsX = sp;
    if (value === "0") odds.odds2 = sp;
  }
  return odds.odds1 && odds.oddsX && odds.odds2 ? odds : null;
}

function signalKeys(attrs) {
  const keys = new Set();
  const sourceId = norm(attrs["data-id"]);
  const matchNo = norm(attrs["data-matchnum"]);
  const processDate = norm(attrs["data-processdate"]);
  const matchDate = norm(attrs["data-matchdate"]);
  const home = norm(attrs["data-homesxname"]);
  const away = norm(attrs["data-awaysxname"]);
  const fixtureId = norm(attrs["data-fixtureid"]);
  const infoMatchId = norm(attrs["data-infomatchid"]);
  [sourceId, fixtureId, infoMatchId].filter(Boolean).forEach((key) => keys.add(key));
  if (processDate && matchNo) keys.add(`${processDate}:${matchNo}`);
  if (matchDate && home && away) keys.add(`${matchDate}:${home}:${away}`);
  return Array.from(keys);
}

function buildSignal(attrs, rowHtml, updatedAt) {
  const had = parseOdds(rowHtml, "nspf");
  const hhad = parseOdds(rowHtml, "spf");
  const handicapLine = norm(attrs["data-rangqiu"]);
  const matchDate = norm(attrs["data-matchdate"]);
  const matchTime = norm(attrs["data-matchtime"]);
  const home = norm(attrs["data-homesxname"]);
  const away = norm(attrs["data-awaysxname"]);
  const leagueName = norm(attrs["data-simpleleague"]);
  const sourceMatchId = norm(attrs["data-id"]);
  const fixtureId = norm(attrs["data-fixtureid"]);
  const matchNo = norm(attrs["data-matchnum"]);

  const externalOdds = had
    ? {
      source: "500.com",
      odds1: had.odds1,
      oddsX: had.oddsX,
      odds2: had.odds2,
      summary: {
        zh: `500彩票网胜平负参考：${had.odds1.toFixed(2)} / ${had.oddsX.toFixed(2)} / ${had.odds2.toFixed(2)}`,
        en: `500.com 1X2 reference: ${had.odds1.toFixed(2)} / ${had.oddsX.toFixed(2)} / ${had.odds2.toFixed(2)}`,
      },
    }
    : hhad
      ? {
        source: "500.com",
        odds1: hhad.odds1,
        oddsX: hhad.oddsX,
        odds2: hhad.odds2,
        summary: {
          zh: `500彩票网让球参考(${handicapLine || "--"})：${hhad.odds1.toFixed(2)} / ${hhad.oddsX.toFixed(2)} / ${hhad.odds2.toFixed(2)}`,
          en: `500.com handicap reference (${handicapLine || "--"}): ${hhad.odds1.toFixed(2)} / ${hhad.oddsX.toFixed(2)} / ${hhad.odds2.toFixed(2)}`,
        },
      }
      : undefined;

  return {
    source: "500.com:jczq",
    updatedAt,
    sourceMatchId,
    fixtureId,
    matchNo,
    leagueName,
    homeTeamName: home,
    awayTeamName: away,
    kickoffTime: matchDate && matchTime ? `${matchDate}T${matchTime}:00+08:00` : undefined,
    buyEndTime: norm(attrs["data-buyendtime"]) || undefined,
    handicapLine: handicapLine || undefined,
    externalOdds,
    bookmakerOdds: {
      had: had || undefined,
      hhad: hhad || undefined,
    },
  };
}

function parseRows(html, updatedAt) {
  const rows = [];
  const re = /<tr\s+class="bet-tb-tr"([^>]*)>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttrs(match[1]);
    const rowHtml = match[2];
    const keys = signalKeys(attrs);
    if (!keys.length) continue;
    const signal = buildSignal(attrs, rowHtml, updatedAt);
    if (!signal.externalOdds && !signal.bookmakerOdds.had && !signal.bookmakerOdds.hhad) continue;
    rows.push({ keys, signal });
  }
  return rows;
}

function readExisting() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return { version: 1, source: "external-signals", matches: {} };
  }
  try {
    const parsed = JSON.parse(withFileRetry(() => fs.readFileSync(OUTPUT_FILE, "utf8"), `read ${OUTPUT_FILE}`));
    return parsed && typeof parsed === "object" ? parsed : { version: 1, source: "external-signals", matches: {} };
  } catch {
    return { version: 1, source: "external-signals", matches: {} };
  }
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
}

async function main() {
  const updatedAt = new Date().toISOString();
  const body = await httpGetBuffer(SOURCE_URL);
  const html = iconv.decode(body, "gbk");
  const rows = parseRows(html, updatedAt);
  const existing = readExisting();
  const matches = { ...(existing.matches || {}) };

  let mapped = 0;
  for (const row of rows) {
    for (const key of row.keys) {
      matches[key] = row.signal;
      mapped += 1;
    }
  }

  const payload = {
    version: 1,
    source: "external-signals",
    updatedAt,
    sources: {
      "500.com:jczq": {
        url: SOURCE_URL,
        updatedAt,
        rows: rows.length,
        mapped,
      },
    },
    matches,
  };
  writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify({
    ok: true,
    source: "500.com:jczq",
    rows: rows.length,
    mapped,
    output: path.relative(PROJECT_ROOT, OUTPUT_FILE),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
