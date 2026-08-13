"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_FILE = path.join(ROOT_DIR, "public", "data", "matches-current.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "public", "data", "recommendation-bias-audit.json");
const VERSION = "recommendation-bias-audit-v1";
const TERMINAL = new Set(["FINISHED", "CANCELLED", "CANCELED", "VOID", "POSTPONED", "ABANDONED"]);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
};

const selectedCode = (match) => {
  const best = (Array.isArray(match?.predictions) ? match.predictions : [])
    .find((row) => row?.marketType === "BEST" && ["1", "X", "2"].includes(row?.tipCode));
  const code = best?.tipCode || match?.probabilityModel?.unifiedPosterior?.selectedCode;
  return ["1", "X", "2"].includes(code) ? code : null;
};

const coldStart = (match) => {
  const elo = match?.predictionMeta?.elo || match?.probabilityModel?.elo || {};
  const form = match?.predictionMeta?.form || match?.probabilityModel?.form || {};
  const freeGrade = match?.externalSignals?.freeFootball?.grade;
  const eloRows = Number(elo.homeMatches || 0) + Number(elo.awayMatches || 0);
  const formRows = Number(form?.home?.sampleSize || 0) + Number(form?.away?.sampleSize || 0);
  return freeGrade === "D" || (eloRows === 0 && formRows === 0);
};

const auditRecommendationBias = (matches, options = {}) => {
  const minimumRows = Math.max(3, Number(options.minimumRows || 5));
  const dominanceThreshold = Math.min(1, Math.max(0.6, Number(options.dominanceThreshold || 0.8)));
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rows = (Array.isArray(matches) ? matches : [])
    .filter((match) => {
      if (TERMINAL.has(String(match?.status || "").toUpperCase())) return false;
      const kickoffMs = Date.parse(match?.kickoffTime || "");
      return !Number.isFinite(kickoffMs)
        || (kickoffMs >= nowMs - 3 * 60 * 60_000 && kickoffMs <= nowMs + 48 * 60 * 60_000);
    })
    .map((match) => ({ match, code: selectedCode(match) }))
    .filter((row) => row.code);
  const counts = { "1": 0, X: 0, "2": 0 };
  for (const row of rows) counts[row.code] += 1;
  const dominant = Object.entries(counts).sort((left, right) => right[1] - left[1])[0];
  const dominantShare = rows.length > 0 ? dominant[1] / rows.length : 0;
  const triggered = rows.length >= minimumRows && dominantShare >= dominanceThreshold;
  const coldStartRows = rows.filter((row) => coldStart(row.match)).length;
  const cause = !triggered
    ? "distribution-within-monitoring-band"
    : coldStartRows / rows.length >= 0.5
      ? "input-degeneracy-cold-start"
      : "model-or-market-cluster-requires-review";
  return {
    version: VERSION,
    rows: rows.length,
    counts,
    distribution: Object.fromEntries(Object.entries(counts).map(([code, count]) => [
      code,
      rows.length > 0 ? Number((count / rows.length).toFixed(4)) : 0,
    ])),
    dominantCode: dominant[0],
    dominantShare: Number(dominantShare.toFixed(4)),
    coldStartRows,
    triggered,
    cause,
    policy: {
      diagnosticOnly: true,
      mutatesRecommendationDirection: false,
      artificialDirectionBalancingAllowed: false,
      minimumRows,
      dominanceThreshold,
    },
  };
};

const main = () => {
  const checkedAt = new Date().toISOString();
  const matches = readJson(CURRENT_FILE, []);
  const audit = auditRecommendationBias(matches);
  const output = { ...audit, checkedAt };
  writeJsonAtomic(OUTPUT_FILE, output);
  console.log(JSON.stringify({ ok: true, ...output, output: path.relative(ROOT_DIR, OUTPUT_FILE) }, null, 2));
};

if (require.main === module) main();

module.exports = {
  auditRecommendationBias,
  selectedCode,
};
