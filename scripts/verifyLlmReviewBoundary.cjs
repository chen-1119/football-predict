const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");

const FORBIDDEN_LLM_FIELDS = ["probabilities", "recommendation", "predictions", "probabilityModel", "odds"];

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const parseShanghaiDateTime = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    return Date.parse(`${raw.replace(/\s+/, "T")}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(`${raw}+08:00`);
  }
  return Date.parse(raw);
};

const predictionAuditSignature = (match) => {
  const payload = {
    predictions: Array.isArray(match?.predictions)
      ? match.predictions.map((prediction) => ({
        marketType: prediction.marketType,
        oddsPoolCode: prediction.oddsPoolCode,
        tipCode: prediction.tipCode,
        recommendationTier: prediction.recommendationTier,
        recommendationAction: prediction.recommendationAction
      }))
      : [],
    probabilityModelVersion: match?.probabilityModel?.version || null,
    oneXTwoFinal: match?.probabilityModel?.oneXTwo?.final || null,
    handicapFinal: match?.probabilityModel?.handicap?.final || null,
    lockedAt: match?.predictionMeta?.lockedAt || null,
    cutoffTime: match?.predictionMeta?.cutoffTime || match?.buyEndTime || null
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
};

const reviewCutoffValue = (match, row) => (
  row?.llmReview?.audit?.cutoffTime
  || match?.predictionMeta?.cutoffTime
  || match?.buyEndTime
  || match?.externalSignals?.buyEndTime
  || match?.externalSignals?.fiveHundred?.sale?.buyEndTime
  || row?.kickoffTime
  || match?.kickoffTime
  || ""
);

const run = () => {
  const checks = [];
  const currentPayload = readJson(path.join(publicDataDir, "matches-current.json"), []);
  const currentMatches = Array.isArray(currentPayload) ? currentPayload : (currentPayload?.matches || []);
  const currentById = new Map(currentMatches.map((match) => [match.id, match]));
  const gptPayload = readJson(path.join(publicDataDir, "gpt-predictions.json"), {
    version: 2,
    rows: []
  });
  const rows = Array.isArray(gptPayload.rows) ? gptPayload.rows : [];

  pushCheck(checks, "llm review file schema", Number(gptPayload.version) === 2 && Array.isArray(gptPayload.rows), {
    version: gptPayload.version ?? null,
    rows: rows.length,
    source: gptPayload.source || null
  });

  const staleRows = rows.filter((row) => !currentById.has(row.matchId));
  pushCheck(checks, "llm rows reference current matches", staleRows.length === 0, {
    staleRows: staleRows.length,
    sample: staleRows.slice(0, 5).map((row) => row.matchId || null)
  });

  const rowsAfterCutoff = rows.filter((row) => {
    const match = currentById.get(row.matchId);
    const generatedMs = Date.parse(row.generatedAt || "");
    const cutoffMs = parseShanghaiDateTime(reviewCutoffValue(match, row));
    return Number.isFinite(generatedMs) && Number.isFinite(cutoffMs) && generatedMs > cutoffMs;
  });
  pushCheck(checks, "llm reviews generated before cutoff", rowsAfterCutoff.length === 0, {
    afterCutoff: rowsAfterCutoff.length,
    sample: rowsAfterCutoff.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      generatedAt: row.generatedAt || null,
      cutoffTime: row.llmReview?.audit?.cutoffTime || null
    }))
  });

  const forbiddenRows = rows.filter((row) => {
    const review = row.llmReview || {};
    const denied = review.audit?.deniedOutputFields || [];
    return FORBIDDEN_LLM_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(review, field))
      || denied.length > 0;
  });
  pushCheck(checks, "llm review has no forbidden output fields", forbiddenRows.length === 0, {
    forbiddenRows: forbiddenRows.length,
    forbiddenFields: FORBIDDEN_LLM_FIELDS,
    sample: forbiddenRows.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      deniedOutputFields: row.llmReview?.audit?.deniedOutputFields || []
    }))
  });

  const boundaryFailures = rows.filter((row) => {
    const review = row.llmReview || {};
    return review.reviewRole !== "llm-risk-review"
      || review.tierAdjustment?.canChangeRecommendationDirection !== false
      || review.tierAdjustment?.canChangeProbabilities !== false
      || review.audit?.canOverrideProbabilities !== false
      || review.audit?.canOverrideRecommendationDirection !== false
      || review.audit?.generatedBeforeCutoff !== true;
  });
  pushCheck(checks, "llm review boundary audit fields", boundaryFailures.length === 0, {
    failures: boundaryFailures.length,
    sample: boundaryFailures.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      reviewRole: row.llmReview?.reviewRole || null,
      canOverrideProbabilities: row.llmReview?.audit?.canOverrideProbabilities ?? null,
      canOverrideRecommendationDirection: row.llmReview?.audit?.canOverrideRecommendationDirection ?? null,
      generatedBeforeCutoff: row.llmReview?.audit?.generatedBeforeCutoff ?? null
    }))
  });

  const signatureFailures = rows.filter((row) => {
    const match = currentById.get(row.matchId);
    if (!match) return true;
    return row.llmReview?.audit?.sourcePredictionSignature !== predictionAuditSignature(match);
  });
  pushCheck(checks, "llm review source prediction signature", signatureFailures.length === 0, {
    failures: signatureFailures.length,
    sample: signatureFailures.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      storedSignature: row.llmReview?.audit?.sourcePredictionSignature || null,
      expectedSignature: currentById.has(row.matchId) ? predictionAuditSignature(currentById.get(row.matchId)) : null
    }))
  });

  const lockedWithPredictions = currentMatches.filter((match) => (
    match?.predictionMeta?.lockedAt
    && Array.isArray(match?.predictions)
    && match.predictions.length > 0
  ));
  const lockedWithoutSnapshot = lockedWithPredictions.filter((match) => !match.predictionMeta?.snapshot?.latestSignature);
  pushCheck(checks, "locked recommendation directions have pre-cutoff snapshot", lockedWithoutSnapshot.length === 0, {
    lockedWithPredictions: lockedWithPredictions.length,
    missing: lockedWithoutSnapshot.length,
    sample: lockedWithoutSnapshot.slice(0, 5).map((match) => match.id)
  });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      currentMatches: currentMatches.length,
      llmRows: rows.length,
      updatedAt: gptPayload.updatedAt || null
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
