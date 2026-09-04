const fs = require("node:fs");
const {
  buildEloSnapshots,
  buildFormSnapshots,
  loadHistoricalTrainingIndex,
  predictionSet,
} = require("./syncData.cjs");

const inputPath = process.argv.find((arg) => arg.startsWith("--input="))?.slice("--input=".length);
const businessDate = process.argv.find((arg) => arg.startsWith("--business-date="))?.slice("--business-date=".length);
const rebuildFeatures = process.argv.includes("--rebuild-features");
const base64Input = process.argv.includes("--base64-input");
const inputRaw = inputPath
  ? fs.readFileSync(inputPath, "utf8")
  : fs.readFileSync(0, "utf8");
const raw = base64Input
  ? Buffer.from(inputRaw.replace(/\s+/g, ""), "base64").toString("utf8")
  : inputRaw;
const matches = JSON.parse(raw);
if (!Array.isArray(matches)) throw new Error("matches-current payload must be an array");
const historicalTraining = rebuildFeatures ? loadHistoricalTrainingIndex() : null;
const eloSnapshots = rebuildFeatures ? buildEloSnapshots(matches, historicalTraining) : null;
const formSnapshots = rebuildFeatures ? buildFormSnapshots(matches, historicalTraining) : null;

const rows = matches
  .filter((match) => match?.status === "SCHEDULED")
  .filter((match) => !businessDate || match.businessDate === businessDate)
  .map((match) => {
    const sourceMatchId = String(match?.sourceMatchId || "").trim();
    const rebuilt = predictionSet(rebuildFeatures ? {
      ...match,
      eloSnapshot: eloSnapshots?.get(sourceMatchId) || match.eloSnapshot,
      formSnapshot: formSnapshots?.get(sourceMatchId) || match.formSnapshot,
    } : match);
    const best = rebuilt.predictions.find((prediction) => prediction.marketType === "BEST") || null;
    return {
      businessDate: match.businessDate || null,
      matchNo: match.matchNo || null,
      home: match.homeTeamName || match.homeTeam || null,
      away: match.awayTeamName || match.awayTeam || null,
      code: best?.tipCode || null,
      pool: best?.oddsPoolCode || null,
      tier: best?.recommendationTier || null,
      odds: best?.odds || 0,
      inputSufficient: rebuilt.probabilityModel?.inputSufficiency?.sufficient ?? null,
      inputFallback: rebuilt.probabilityModel?.unifiedPosterior?.inputFallback?.applied === true,
      posterior: rebuilt.probabilityModel?.oneXTwo?.unifiedPosterior || null,
      independentFinal: rebuilt.probabilityModel?.oneXTwo?.final || null,
      selectionMode: rebuilt.probabilityModel?.unifiedPosterior?.selectionPolicy
        || rebuilt.probabilityModel?.unifiedPosterior?.selection?.mode
        || rebuilt.probabilityModel?.selection?.mode
        || null,
    };
  });

const distribution = rows.reduce((summary, row) => {
  const key = `${row.pool || "-"}:${row.code || "-"}`;
  summary[key] = (summary[key] || 0) + 1;
  return summary;
}, {});
const hadRows = rows.filter((row) => row.pool === "HAD" && ["1", "X", "2"].includes(row.code));
const hadHomeRows = hadRows.filter((row) => row.code === "1").length;
const hadDrawRows = hadRows.filter((row) => row.code === "X").length;
const hadAwayRows = hadRows.filter((row) => row.code === "2").length;
const hadHomeRatio = hadRows.length ? hadHomeRows / hadRows.length : null;
const hadDrawRatio = hadRows.length ? hadDrawRows / hadRows.length : null;
const hadAwayRatio = hadRows.length ? hadAwayRows / hadRows.length : null;
const directionEntropy = hadRows.length
  ? -[hadHomeRatio, hadDrawRatio, hadAwayRatio]
    .filter((ratio) => ratio > 0)
    .reduce((sum, ratio) => sum + ratio * Math.log(ratio), 0) / Math.log(3)
  : null;

console.log(JSON.stringify({
  ok: true,
  verifier: "recommendation-direction-distribution-audit",
  rebuiltFeatures: rebuildFeatures,
  businessDate: businessDate || null,
  scheduledMatches: rows.length,
  distribution,
  inputSufficientMatches: rows.filter((row) => row.inputSufficient === true).length,
  inputFallbackMatches: rows.filter((row) => row.inputFallback).length,
  hadHomeRatio: hadHomeRatio === null ? null : Number(hadHomeRatio.toFixed(4)),
  hadDrawRatio: hadDrawRatio === null ? null : Number(hadDrawRatio.toFixed(4)),
  hadAwayRatio: hadAwayRatio === null ? null : Number(hadAwayRatio.toFixed(4)),
  directionEntropy: directionEntropy === null ? null : Number(directionEntropy.toFixed(4)),
  homeBiasWarning: hadRows.length >= 8 && hadHomeRatio >= 0.65,
  zeroDrawWarning: hadRows.length >= 8 && hadDrawRows === 0,
  warningPolicy: "diagnostic-only; never mutate or quota-balance match directions",
  suspiciousHomeConcentration: hadRows.length >= 8 && hadHomeRatio >= 0.85,
  suspiciousDrawConcentration: hadRows.length >= 8 && hadDrawRatio >= 0.45,
  suspiciousAnyDirectionConcentration: hadRows.length >= 8
    && Math.max(hadHomeRatio, hadDrawRatio, hadAwayRatio) >= 0.85,
  rows,
}, null, 2));
