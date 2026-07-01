const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const hashString = (value) => {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const hasAuditFields = (record) => Boolean(
  record?.modelVersion
  && record?.calibrationVersion
  && record?.cutoffTime
  && record?.featureSnapshot
  && record?.featureSnapshotHash
);

const featureHashMatches = (record) => {
  if (!record?.featureSnapshot || !record?.featureSnapshotHash) return false;
  const { hash, ...withoutHash } = record.featureSnapshot;
  const expected = hash || hashString(JSON.stringify(withoutHash));
  return expected === record.featureSnapshotHash;
};

const run = () => {
  const checks = [];
  const snapshotPayload = readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });
  const modelEvaluation = readJson(path.join(publicDataDir, "model-evaluation.json"), null);
  const currentMatches = readJson(path.join(publicDataDir, "matches-current.json"), []);
  const historyMatches = readJson(path.join(publicDataDir, "matches-history.json"), []);
  const snapshotRows = Array.isArray(snapshotPayload.rows) ? snapshotPayload.rows : [];
  const currentRows = Array.isArray(currentMatches) ? currentMatches : [];
  const historyRows = Array.isArray(historyMatches) ? historyMatches : [];

  const missingAuditRows = snapshotRows.filter((row) => !hasAuditFields(row));
  const badHashRows = snapshotRows.filter((row) => hasAuditFields(row) && !featureHashMatches(row));
  const rowsWithoutVersion = snapshotRows.filter((row) => !row.policyVersion || !row.promptVersion || !row.probabilityModelVersion);
  const rowPhases = snapshotRows.reduce((acc, row) => {
    acc[row.phase || "unknown"] = (acc[row.phase || "unknown"] || 0) + 1;
    return acc;
  }, {});

  pushCheck(checks, "prediction snapshots available", snapshotRows.length > 0, {
    rows: snapshotRows.length,
    byPhase: rowPhases
  });
  pushCheck(checks, "prediction snapshots audit fields", missingAuditRows.length === 0, {
    missing: missingAuditRows.length,
    sample: missingAuditRows.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      sourceMatchId: row.sourceMatchId || null,
      phase: row.phase || null,
      capturedAt: row.capturedAt || null
    }))
  });
  pushCheck(checks, "prediction snapshot feature hashes", badHashRows.length === 0, {
    badHashes: badHashRows.length,
    sample: badHashRows.slice(0, 5).map((row) => ({
      matchId: row.matchId || null,
      sourceMatchId: row.sourceMatchId || null,
      phase: row.phase || null
    }))
  });
  pushCheck(checks, "snapshot model policy versions", rowsWithoutVersion.length === 0, {
    missing: rowsWithoutVersion.length
  });

  const currentWithPredictions = currentRows.filter((match) => Array.isArray(match.predictions) && match.predictions.length > 0);
  const currentMissingAudit = currentWithPredictions.filter((match) => !hasAuditFields(match.predictionMeta));
  const currentBadHash = currentWithPredictions.filter((match) => hasAuditFields(match.predictionMeta) && !featureHashMatches(match.predictionMeta));
  pushCheck(checks, "current prediction meta audit fields", currentMissingAudit.length === 0, {
    currentWithPredictions: currentWithPredictions.length,
    missing: currentMissingAudit.length,
    sample: currentMissingAudit.slice(0, 5).map((match) => match.id)
  });
  pushCheck(checks, "current prediction meta feature hashes", currentBadHash.length === 0, {
    badHashes: currentBadHash.length,
    sample: currentBadHash.slice(0, 5).map((match) => match.id)
  });

  const lockedWithPredictions = [...currentRows, ...historyRows].filter((match) => (
    match?.predictionMeta?.lockedAt
    && Array.isArray(match?.predictions)
    && match.predictions.length > 0
  ));
  const lockedWithoutSnapshot = lockedWithPredictions.filter((match) => !match.predictionMeta?.snapshot?.latestSignature);
  pushCheck(checks, "locked predictions keep snapshot signature", lockedWithoutSnapshot.length === 0, {
    lockedWithPredictions: lockedWithPredictions.length,
    missing: lockedWithoutSnapshot.length,
    sample: lockedWithoutSnapshot.slice(0, 5).map((match) => match.id)
  });

  const leakageGuard = String(modelEvaluation?.policy?.leakageGuard || "");
  pushCheck(checks, "backtest leakage guard excludes review snapshots", /review snapshots are excluded/i.test(leakageGuard), {
    leakageGuard: leakageGuard || null
  });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
