const fs = require("fs");
const path = require("path");
const https = require("https");

const SPORTTERY_BASE = "https://webapi.sporttery.cn";
const VERIFY_MODE = String(process.env.ODDS_VERIFY_MODE || "strict").toLowerCase();
const SOURCES = [
  `${SPORTTERY_BASE}/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=hhad,had&channel=c`,
  `${SPORTTERY_BASE}/gateway/uniform/football/getMatchListV1.qry?clientCode=3001`,
];
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

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizeOdds(raw) {
  const odds1 = toNum(raw?.odds1);
  const oddsX = toNum(raw?.oddsX);
  const odds2 = toNum(raw?.odds2);
  if (odds1 > 1.01 && oddsX > 1.01 && odds2 > 1.01) return { odds1, oddsX, odds2 };
  return null;
}

function officialHadOdds(row) {
  const rows = Array.isArray(row?.oddsList) ? row.oddsList : [];
  const hadRow =
    rows.find((item) => String(item?.poolCode || "").toUpperCase() === "HAD") ||
    row?.had ||
    (row?.h || row?.d || row?.a ? row : null);

  return sanitizeOdds({
    odds1: hadRow?.h,
    oddsX: hadRow?.d,
    odds2: hadRow?.a,
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers: SPORTTERY_REQUEST_HEADERS }, (res) => {
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
          resolve(JSON.parse(body));
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

async function loadOfficialOdds() {
  const official = new Map();

  for (const url of SOURCES) {
    const payload = await httpGetJson(url);
    for (const day of payload?.value?.matchInfoList || []) {
      for (const row of day.subMatchList || []) {
        const matchId = String(row.matchId || "");
        const odds = officialHadOdds(row);
        if (matchId && odds) {
          official.set(matchId, { odds, url });
        }
      }
    }
  }

  return official;
}

function almostEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.001;
}

async function main() {
  const publicDir = path.join(__dirname, "..", "public");
  const currentMatchesPath = path.join(publicDir, "data", "matches-current.json");
  const matchesPath = fs.existsSync(currentMatchesPath)
    ? currentMatchesPath
    : path.join(publicDir, "matches.json");
  const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
  const official = await loadOfficialOdds();
  const errors = [];
  let checked = 0;

  for (const match of matches) {
    if (match.source !== "sporttery") continue;
    const sourceMatchId = String(match.sourceMatchId || match.id || "").replace(/^sporttery_/, "");
    const officialMatch = official.get(sourceMatchId);
    if (!officialMatch) continue;

    checked += 1;
    const local = sanitizeOdds(match.odds);
    if (!local) {
      errors.push(`${match.id}: local odds are invalid`);
      continue;
    }

    const remote = officialMatch.odds;
    if (
      !almostEqual(local.odds1, remote.odds1) ||
      !almostEqual(local.oddsX, remote.oddsX) ||
      !almostEqual(local.odds2, remote.odds2)
    ) {
      errors.push(
        `${match.id}: local ${local.odds1}/${local.oddsX}/${local.odds2} != official ${remote.odds1}/${remote.oddsX}/${remote.odds2}`
      );
    }
  }

  if (checked === 0 && official.size > 0) {
    errors.push("No local matches overlap with current official Sporttery odds.");
  }

  if (official.size === 0) {
    console.log(JSON.stringify({
      ok: true,
      officialMatches: 0,
      checked: 0,
      unavailable: true,
      note: "Sporttery returned no official HAD rows for the current verification window.",
    }, null, 2));
    return;
  }

  if (errors.length > 0) {
    const message = errors.join("\n");
    if (VERIFY_MODE === "warn") {
      console.warn(message);
      console.log(JSON.stringify({ ok: false, mode: "warn", officialMatches: official.size, checked, warnings: errors.length }, null, 2));
      return;
    }

    console.error(message);
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, officialMatches: official.size, checked }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
