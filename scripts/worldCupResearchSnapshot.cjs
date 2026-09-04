const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  metricsForRows,
} = require("./auditWorldCupHitRate.cjs");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
} = require("../src/services/benchmarkSelectionPolicy.cjs");

const SNAPSHOT_VERSION = "world-cup-research-benchmark-snapshot-v1";
const DEFAULT_SNAPSHOT_FILE = path.resolve(
  __dirname,
  "..",
  "model-research",
  "world-cup-research-benchmark.json",
);

const numericEqual = (left, right, epsilon = 1e-9) => (
  Number.isFinite(Number(left))
  && Number.isFinite(Number(right))
  && Math.abs(Number(left) - Number(right)) <= epsilon
);

const parseShanghaiDeadline = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const validateWorldCupResearchSnapshot = (snapshot) => {
  const blockers = [];
  const policy = GOODWIN_BENCHMARK_SHADOW_POLICY;
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];

  if (snapshot?.version !== SNAPSHOT_VERSION) blockers.push("snapshot-version-mismatch");
  if (snapshot?.role !== "retrospective-research-only") blockers.push("snapshot-role-invalid");
  if (snapshot?.promotionEligible !== false) blockers.push("snapshot-promotion-flag-invalid");
  if (snapshot?.auditVersion !== "world-cup-hit-rate-audit-v3") blockers.push("snapshot-audit-version-mismatch");
  if (snapshot?.policyVersion !== policy.version) blockers.push("snapshot-policy-version-mismatch");
  if (snapshot?.criteria?.marketType !== policy.marketType) blockers.push("snapshot-market-mismatch");
  if (snapshot?.criteria?.oddsPoolCode !== policy.oddsPoolCode) blockers.push("snapshot-pool-mismatch");
  if (!numericEqual(snapshot?.criteria?.minimumEvidenceScore, policy.minimumEvidenceScore)) {
    blockers.push("snapshot-evidence-threshold-mismatch");
  }
  if (!numericEqual(snapshot?.criteria?.minimumOdds, policy.minimumOdds)) {
    blockers.push("snapshot-minimum-odds-mismatch");
  }
  if (!numericEqual(snapshot?.criteria?.maximumOdds, policy.maximumOdds)) {
    blockers.push("snapshot-maximum-odds-mismatch");
  }
  if (!rows.length) blockers.push("snapshot-rows-missing");
  if (!Number.isInteger(Number(snapshot?.foldCount)) || Number(snapshot.foldCount) < 1) {
    blockers.push("snapshot-fold-count-invalid");
  }

  const matchKeys = new Set();
  for (const row of rows) {
    const matchKey = String(row?.matchKey || "").trim();
    if (!matchKey) blockers.push("snapshot-match-key-missing");
    else if (matchKeys.has(matchKey)) blockers.push("snapshot-match-key-duplicate");
    else matchKeys.add(matchKey);
    if (row?.oddsPoolCode !== policy.oddsPoolCode) blockers.push("snapshot-row-pool-invalid");
    if (!["1", "X", "2"].includes(String(row?.tipCode || ""))) blockers.push("snapshot-row-tip-invalid");
    if (!["WON", "LOST"].includes(String(row?.resultStatus || ""))) blockers.push("snapshot-row-result-invalid");
    if (Number(row?.trustScore) < policy.minimumEvidenceScore) blockers.push("snapshot-row-evidence-below-threshold");
    if (Number(row?.odds) < policy.minimumOdds || Number(row?.odds) > policy.maximumOdds) {
      blockers.push("snapshot-row-odds-outside-policy");
    }
    const observedAt = Date.parse(String(row?.snapshotLatestAt || ""));
    const deadlineAt = parseShanghaiDeadline(row?.deadlineAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt) || observedAt >= deadlineAt) {
      blockers.push("snapshot-row-clock-invalid");
    }
  }

  const rowsSha256 = sha256(JSON.stringify(rows));
  if (snapshot?.sourceEvidence?.rowsSha256 !== rowsSha256) blockers.push("snapshot-row-hash-mismatch");
  if (!/^[a-f0-9]{64}$/.test(String(snapshot?.sourceEvidence?.matchesHistorySha256 || ""))) {
    blockers.push("snapshot-match-source-hash-invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(String(snapshot?.sourceEvidence?.postMatchReviewsSha256 || ""))) {
    blockers.push("snapshot-review-source-hash-invalid");
  }

  const metrics = metricsForRows(rows);
  for (const key of [
    "settled",
    "won",
    "lost",
    "hitRate",
    "hitRatePercent",
    "pricedRows",
    "averageOdds",
    "netUnits",
    "roiPercent",
  ]) {
    if (!numericEqual(snapshot?.metrics?.[key], metrics[key])) {
      blockers.push(`snapshot-metric-${key}-mismatch`);
    }
  }
  const declaredInterval = snapshot?.metrics?.confidence95Percent;
  const computedInterval = metrics.confidence95Percent;
  if (
    !Array.isArray(declaredInterval)
    || !Array.isArray(computedInterval)
    || declaredInterval.length !== 2
    || !numericEqual(declaredInterval[0], computedInterval[0])
    || !numericEqual(declaredInterval[1], computedInterval[1])
  ) {
    blockers.push("snapshot-metric-confidence-interval-mismatch");
  }

  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    rowsSha256,
    metrics,
    rows: rows.map((row) => ({ ...row })),
  };
};

const loadWorldCupResearchSnapshot = (filePath = DEFAULT_SNAPSHOT_FILE) => {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      missing: error?.code === "ENOENT",
      filePath,
      blockers: [error?.code === "ENOENT" ? "snapshot-file-missing" : "snapshot-file-invalid"],
      error: error?.message || String(error),
    };
  }
  const validation = validateWorldCupResearchSnapshot(snapshot);
  return {
    ...validation,
    missing: false,
    filePath,
    snapshot,
  };
};

const researchAuditFromSnapshot = (validation) => {
  if (validation?.ok !== true) return null;
  const snapshot = validation.snapshot;
  return {
    source: "release-bundled-frozen-research-snapshot",
    snapshotVersion: snapshot.version,
    snapshotGeneratedAt: snapshot.generatedAt || null,
    snapshotRowsSha256: validation.rowsSha256,
    walkForward: {
      selectedRows: validation.rows.length,
      foldCount: Number(snapshot.foldCount || 0),
      metrics: validation.metrics,
    },
  };
};

module.exports = {
  SNAPSHOT_VERSION,
  DEFAULT_SNAPSHOT_FILE,
  validateWorldCupResearchSnapshot,
  loadWorldCupResearchSnapshot,
  researchAuditFromSnapshot,
};
