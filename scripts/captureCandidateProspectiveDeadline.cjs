"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  CAPTURE_FINALIZATION_GRACE_SECONDS,
  CAPTURE_FINALIZATION_POLICY_VERSION,
  CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  atomicDecisionRecordValid,
  buildDecisionEvent,
  canonicalize,
  captureFinalizationFor,
  classifyCandidateDecisionEvidence,
  decisionDeadlineFor,
  sameCohortIdentity,
  selectSnapshotAtDeadline,
  settleCandidateProspectiveRegistry,
  sha256,
  updateCandidateProspectiveLedger,
  verifyRegistry,
  withCandidateProspectiveRegistryLock,
} = require("./candidateProspectiveLedger.cjs");
const {
  buildResultProvenance,
  canonicalSourceMatchId,
  eventVersionOf,
  isOfficialSportteryFinal,
} = require("../src/services/matchLifecycle.cjs");
const {
  AUDIT_VERSION: CHALLENGER_SUITE_AUDIT_VERSION,
  buildCalibrationDeescalationPlan,
  settleCalibrationChallengerSuite,
  updateCalibrationChallengerSuite,
} = require("./candidateProspectiveChallengerSuite.cjs");
const {
  AUDIT_VERSION: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
  buildTemperatureNeutralizationPlan,
  futureOnlyMatchesForSuite,
  settleTemperatureNeutralizationSuite,
  trialLedgersFor: temperatureNeutralizationLedgersFor,
  updateTemperatureNeutralizationSuite,
} = require("./candidateProspectiveTemperatureNeutralizationSuite.cjs");
const {
  AUDIT_VERSION: COMMON_COHORT_G2_AUDIT_VERSION,
  buildCommonCohortShadowG2Plan,
  inputEligibilityFor: commonCohortG2InputEligibility,
  settleCommonCohortShadowG2Suite,
  trialLedgersFor: commonCohortG2LedgersFor,
  updateCommonCohortShadowG2Suite,
} = require("./candidateCommonCohortShadowG2.cjs");
const {
  buildBenchmarkProspectiveAudit,
  cohortKeyFor: benchmarkCohortKeyFor,
  decisionCutoffFor: benchmarkDecisionCutoffFor,
} = require("./benchmarkProspectiveLedger.cjs");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
} = require("../src/services/benchmarkSelectionPolicy.cjs");
const {
  loadCollectorTrustRegistry,
} = require("../src/services/collectorAttestation.cjs");
const {
  collectorQuorumForDecision,
} = require("../server/collectorQuorumEvidence.cjs");

let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  sqliteLoadError = error;
}

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const storeDir = path.resolve(
  process.env.SERVER_STORE_DIR
  || process.env.DATA_STORE_DIR
  || path.join(rootDir, "server-data"),
);
const registryFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_REGISTRY_FILE
  || path.join(storeDir, "model-artifacts", "candidate-prospective-registry.json"),
);
const benchmarkLedgerFile = path.resolve(
  process.env.BENCHMARK_PROSPECTIVE_LEDGER_FILE
  || path.join(storeDir, "model-artifacts", "benchmark-prospective-ledger.json"),
);
const benchmarkStatusFile = path.resolve(
  process.env.BENCHMARK_PROSPECTIVE_CAPTURE_STATUS_FILE
  || path.join(storeDir, "benchmark-prospective-capture-status.json"),
);
const challengerSuiteFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_CHALLENGER_SUITE_FILE
  || path.join(storeDir, "model-artifacts", "candidate-prospective-challenger-suite.json"),
);
const temperatureNeutralizationSuiteFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_TEMPERATURE_NEUTRALIZATION_SUITE_FILE
  || path.join(
    storeDir,
    "model-artifacts",
    "candidate-prospective-temperature-neutralization-suite.json",
  ),
);
const legacyCommonCohortG2V1SuiteFile = path.resolve(
  process.env.CANDIDATE_COMMON_COHORT_SHADOW_G2_FILE
  || path.join(
    storeDir,
    "model-artifacts",
    "candidate-common-cohort-shadow-g2.json",
  ),
);
const commonCohortG2SuiteFile = path.resolve(
  process.env.CANDIDATE_COMMON_COHORT_SHADOW_G2_V2_FILE
  || path.join(
    storeDir,
    "model-artifacts",
    "candidate-common-cohort-shadow-g2-v2.json",
  ),
);
const modelEvaluationFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_MODEL_EVALUATION_FILE
  || path.join(publicDataDir, "model-evaluation.json"),
);
const statusFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE
  || path.join(storeDir, "candidate-prospective-capture-status.json"),
);
const sqliteDbPath = path.resolve(
  process.env.DATASTORE_SQLITE_PATH
  || path.join(storeDir, "football.db"),
);
const collectorEvidenceStoreFile = path.resolve(
  process.env.SPORTTERY_COLLECTOR_EVIDENCE_STORE_PATH
  || path.join(storeDir, "sporttery-collector-evidence.json"),
);
const collectorTrustRegistryFile = path.resolve(
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || path.join(rootDir, "deploy", "light-server", "collector-trust-registry.json"),
);
const currentMatchesFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE
  || path.join(publicDataDir, "matches-current.json"),
);
const historyMatchesFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE
  || path.join(publicDataDir, "matches-history.json"),
);
const publicSnapshotsFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE
  || path.join(publicDataDir, "prediction-snapshots.json"),
);
const publicOddsFile = path.resolve(
  process.env.BENCHMARK_PROSPECTIVE_PUBLIC_ODDS_FILE
  || path.join(publicDataDir, "odds-history.json"),
);
const evaluatedAt = new Date(
  process.env.CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT || Date.now(),
).toISOString();
const lockTimeoutMs = Math.max(
  0,
  Number(process.env.CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS || 5_000),
);
const snapshotLimit = Math.max(
  100,
  Number(process.env.CANDIDATE_PROSPECTIVE_CAPTURE_SNAPSHOT_LIMIT || 20_000),
);
const oddsLimit = Math.max(
  100,
  Number(process.env.BENCHMARK_PROSPECTIVE_CAPTURE_ODDS_LIMIT || 20_000),
);
const readinessPreviewLimit = Math.max(
  1,
  Math.min(
    100,
    Number(process.env.CANDIDATE_PROSPECTIVE_READINESS_PREVIEW_LIMIT || 16),
  ),
);
const readinessSnapshotsPerMatchLimit = Math.max(
  8,
  Math.min(
    512,
    Number(process.env.CANDIDATE_PROSPECTIVE_READINESS_SNAPSHOTS_PER_MATCH_LIMIT || 64),
  ),
);
const dueSnapshotsPerMatchLimit = Math.max(
  readinessSnapshotsPerMatchLimit,
  Math.min(
    snapshotLimit,
    Number(process.env.CANDIDATE_PROSPECTIVE_DUE_SNAPSHOTS_PER_MATCH_LIMIT || 128),
  ),
);
const benchmarkSnapshotsPerMatchLimit = Math.max(
  8,
  Math.min(
    512,
    Number(process.env.BENCHMARK_PROSPECTIVE_SNAPSHOTS_PER_MATCH_LIMIT || 64),
  ),
);
const publicSnapshotPrefixMaxBytes = Math.max(
  64 * 1024,
  Math.min(
    32 * 1024 * 1024,
    Number(process.env.CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOT_PREFIX_MAX_BYTES || 8 * 1024 * 1024),
  ),
);
const captureStartedAt = process.hrtime.bigint();
const DEADLINE_ONLY_FLAG = "--deadline-only";
const BENCHMARK_ONLY_FLAG = "--benchmark-only";

const captureExecutionMode = (argv = process.argv.slice(2)) => {
  const deadlineOnly = Array.isArray(argv) && argv.includes(DEADLINE_ONLY_FLAG);
  const benchmarkOnly = Array.isArray(argv) && argv.includes(BENCHMARK_ONLY_FLAG);
  if (deadlineOnly && benchmarkOnly) {
    throw new Error("deadline-only and benchmark-only are mutually exclusive");
  }
  return {
    deadlineOnly,
    benchmarkOnly,
    mode: deadlineOnly ? "deadline-only" : benchmarkOnly ? "benchmark-only" : "full",
  };
};
const captureMode = captureExecutionMode().mode;

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempFile, filePath);
  } finally {
    if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
  }
};

const sha256File = (filePath) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
};

const activeLedgerFor = (registry) => (
  Array.isArray(registry?.ledgers)
    ? registry.ledgers.find((ledger) => ledger?.ledgerId === registry.activeLedgerId) || null
    : null
);

const challengerLedgersFor = (suite) => (Array.isArray(suite?.trials)
  ? suite.trials.map((trial) => activeLedgerFor(trial?.registry)).filter(Boolean)
  : []);

const uniqueMatches = (matches) => mergeMatchRows(matches);

const implementationDrift = (ledger) => {
  const expected = ledger?.header?.candidateImplementation || {};
  const blockers = [];
  const semanticHashes = expected.semanticHashes || {};
  if (Object.keys(semanticHashes).length > 0) {
    if (
      expected.commitmentVersion !== CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION
    ) {
      blockers.push("semantic-commitment-version-mismatch");
    }
    const expectedEvaluatorHash =
      semanticHashes["candidate-probability-evaluator"];
    if (
      !expectedEvaluatorHash
      || expectedEvaluatorHash !== CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH
    ) {
      blockers.push(
        "semantic-hash-mismatch:candidate-probability-evaluator",
      );
    }
  }
  for (const [relativeFile, expectedHash] of Object.entries(expected.sourceHashes || {})) {
    const actualHash = sha256File(path.join(rootDir, relativeFile));
    if (!actualHash || actualHash !== expectedHash) {
      blockers.push(`source-hash-mismatch:${relativeFile}`);
    }
  }
  const dependencyLockHash = sha256File(path.join(rootDir, "package-lock.json"));
  if (
    expected.dependencyLockHash
    && dependencyLockHash !== expected.dependencyLockHash
  ) {
    blockers.push("dependency-lock-hash-mismatch");
  }
  return [...new Set(blockers)].sort();
};

const arrayRows = (payload, keys = []) => {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
};

const matchRowsFromPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  for (const key of ["matches", "items", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return null;
};

const parseProjectedJson = (value) => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const compactDefined = (payload) => Object.fromEntries(
  Object.entries(payload).filter(([, value]) => (
    value !== null
    && value !== undefined
    && value !== ""
  )),
);

const matchMergeIdentityKeys = (row) => {
  const kickoffMs = Date.parse(
    row?.kickoffAt
    || row?.kickoffTime
    || row?.matchDate
    || row?.kickoff
    || "",
  );
  if (!Number.isFinite(kickoffMs)) return [];
  const kickoffAt = new Date(kickoffMs).toISOString();
  const market = String(row?.market || "HAD").trim().toUpperCase();
  return matchIdentityValues(row).map((identity) => (
    `${kickoffAt}|${market}|${identity}`
  ));
};

const mergeMatchRows = (...sources) => {
  const merged = [];
  // The old implementation searched every accumulated row with findIndex.
  // At the production history size this made each 30-second heartbeat spend
  // tens of seconds in an O(n^2) alias scan. Index the exact cohort tuple used
  // by sameCohortIdentity (kickoff + market + any normalized alias) while
  // retaining the first-match and source-overlay semantics.
  const indexesByIdentityKey = new Map();
  const removeIdentityIndex = (key, index) => {
    const indexes = indexesByIdentityKey.get(key);
    if (!indexes) return;
    indexes.delete(index);
    if (indexes.size === 0) indexesByIdentityKey.delete(key);
  };
  const addIdentityIndex = (key, index) => {
    const indexes = indexesByIdentityKey.get(key) || new Set();
    indexes.add(index);
    indexesByIdentityKey.set(key, indexes);
  };
  for (const row of sources.flatMap((source) => (Array.isArray(source) ? source : []))) {
    if (!row || typeof row !== "object") continue;
    const identityKeys = matchMergeIdentityKeys(row);
    const matchingIndexes = identityKeys.flatMap((key) => (
      [...(indexesByIdentityKey.get(key) || [])]
    ));
    const index = matchingIndexes.length ? Math.min(...matchingIndexes) : -1;
    if (index < 0) {
      const nextIndex = merged.length;
      const incoming = compactDefined({ ...row });
      merged.push(incoming);
      for (const key of matchMergeIdentityKeys(incoming)) {
        addIdentityIndex(key, nextIndex);
      }
      continue;
    }
    const prior = merged[index];
    const priorIdentityKeys = matchMergeIdentityKeys(prior);
    const incoming = compactDefined({ ...row });
    const updated = compactDefined({
      ...prior,
      ...incoming,
      predictionMeta: prior.predictionMeta || incoming.predictionMeta
        ? compactDefined({
            ...(prior.predictionMeta || {}),
            ...(incoming.predictionMeta || {}),
          })
        : undefined,
    });
    merged[index] = updated;
    for (const key of priorIdentityKeys) removeIdentityIndex(key, index);
    for (const key of matchMergeIdentityKeys(updated)) {
      addIdentityIndex(key, index);
    }
  }
  return merged;
};

const mergeMatchUniverseSources = ({
  publicCurrent = [],
  publicHistory = [],
  sqliteCurrent = [],
  sqliteHistory = [],
} = {}) => {
  // Public rows retain fields outside the bounded SQLite projection. SQLite is
  // applied last within each dataset because it is the durable server state;
  // history is then applied over current so an official final cannot be hidden
  // by a stale scheduled row for the same event.
  const currentMatches = mergeMatchRows(publicCurrent, sqliteCurrent);
  const historyMatches = mergeMatchRows(publicHistory, sqliteHistory);
  return {
    currentMatches,
    historyMatches,
    matches: mergeMatchRows(currentMatches, historyMatches),
  };
};

const sqliteProjectedMatchUniverse = (
  databasePath = sqliteDbPath,
  { historyIdentityValues = null } = {},
) => {
  if (!DatabaseSync) {
    return {
      ok: false,
      currentMatches: [],
      historyMatches: [],
      reason: sqliteLoadError?.message || "node:sqlite unavailable",
    };
  }
  if (!fs.existsSync(databasePath)) {
    return {
      ok: false,
      currentMatches: [],
      historyMatches: [],
      reason: "sqlite database missing",
    };
  }

  let db = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const historyIdentities = Array.isArray(historyIdentityValues)
      ? [...new Set(historyIdentityValues.map((value) => String(value || "").trim()).filter(Boolean))]
      : null;
    const projectionQuery = (predicate) => `
      SELECT
        id AS storage_id,
        dataset,
        match_id,
        source_match_id,
        kickoff_time,
        status,
        json_extract(payload, '$.effectiveStatus') AS effective_status,
        json_extract(payload, '$.id') AS payload_id,
        json_extract(payload, '$.matchId') AS payload_match_id,
        json_extract(payload, '$.sourceMatchId') AS payload_source_match_id,
        json_extract(payload, '$.kickoffTime') AS payload_kickoff_time,
        json_extract(payload, '$.matchDate') AS match_date,
        json_extract(payload, '$.kickoff') AS kickoff,
        json_extract(payload, '$.kickoffAt') AS kickoff_at,
        json_extract(payload, '$.buyEndTime') AS buy_end_time,
        json_extract(payload, '$.cutoffTime') AS cutoff_time,
        json_extract(payload, '$.predictionMeta.cutoffTime') AS prediction_meta_cutoff_time,
        json_extract(payload, '$.scoreHome') AS score_home,
        json_extract(payload, '$.scoreAway') AS score_away,
        json_extract(payload, '$.score90Home') AS score_90_home,
        json_extract(payload, '$.score90Away') AS score_90_away,
        json_extract(payload, '$.ft90Home') AS ft_90_home,
        json_extract(payload, '$.ft90Away') AS ft_90_away,
        json_extract(payload, '$.resultObservedAt') AS result_observed_at,
        json_extract(payload, '$.resultMeta') AS result_meta,
        json_extract(payload, '$.resultAudit') AS result_audit,
        json_extract(payload, '$.resultCrossCheck') AS result_cross_check,
        json_extract(payload, '$.resultProvenance') AS result_provenance,
        json_extract(payload, '$.actualKickoffAt') AS actual_kickoff_at,
        json_extract(payload, '$.actualKickoffTime') AS actual_kickoff_time,
        json_extract(payload, '$.actualKickoffSource') AS actual_kickoff_source,
        json_extract(payload, '$.firstInPlayObservedAt') AS first_in_play_observed_at,
        json_extract(payload, '$.inPlayObservationSource') AS in_play_observation_source,
        json_extract(payload, '$.businessDate') AS business_date,
        json_extract(payload, '$.competitionName') AS competition_name,
        json_extract(payload, '$.leagueId') AS league_id,
        json_extract(payload, '$.leagueName') AS league_name,
        json_extract(payload, '$.leagueShortName') AS league_short_name,
        json_extract(payload, '$.homeTeamId') AS home_team_id,
        json_extract(payload, '$.homeTeamName') AS home_team_name,
        json_extract(payload, '$.awayTeamId') AS away_team_id,
        json_extract(payload, '$.awayTeamName') AS away_team_name
      FROM match_snapshots
      WHERE (${predicate})
        AND json_valid(payload) = 1
      ORDER BY
        CASE dataset WHEN 'current' THEN 0 ELSE 1 END,
        kickoff_time ASC,
        match_id ASC
    `;
    const rowsByStorageId = new Map();
    const appendRows = (rows) => {
      for (const row of rows) {
        rowsByStorageId.set(`${row.dataset}|${row.storage_id}`, row);
      }
    };
    appendRows(db.prepare(projectionQuery("dataset = 'current'")).all());
    if (historyIdentities === null) {
      appendRows(db.prepare(projectionQuery("dataset = 'history'")).all());
    } else {
      // Each identity is bound twice (source_match_id and match_id). Keep the
      // statement comfortably below SQLite builds that retain the historical
      // 999-host-parameter limit. This stays bounded at 500+ formal samples
      // and also avoids a writable temp table on the read-only production DB.
      const historyIdentityChunkSize = 300;
      for (
        let offset = 0;
        offset < historyIdentities.length;
        offset += historyIdentityChunkSize
      ) {
        const chunk = historyIdentities.slice(offset, offset + historyIdentityChunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        appendRows(db.prepare(projectionQuery(`
          dataset = 'history' AND (
            source_match_id IN (${placeholders})
            OR match_id IN (${placeholders})
          )
        `)).all(...chunk, ...chunk));
      }
    }
    const rows = [...rowsByStorageId.values()].sort((left, right) => (
      (left.dataset === "current" ? 0 : 1) - (right.dataset === "current" ? 0 : 1)
      || String(left.kickoff_time || "").localeCompare(String(right.kickoff_time || ""))
      || String(left.match_id || "").localeCompare(String(right.match_id || ""))
    ));

    const projected = rows.map((row) => compactDefined({
      id: row.payload_id || row.match_id,
      matchId: row.payload_match_id || row.match_id,
      sourceMatchId: row.payload_source_match_id || row.source_match_id,
      kickoffTime: row.payload_kickoff_time || row.kickoff_time,
      matchDate: row.match_date,
      kickoff: row.kickoff,
      kickoffAt: row.kickoff_at,
      buyEndTime: row.buy_end_time,
      cutoffTime: row.cutoff_time,
      predictionMeta: row.prediction_meta_cutoff_time
        ? { cutoffTime: row.prediction_meta_cutoff_time }
        : null,
      status: row.status,
      effectiveStatus: row.effective_status,
      scoreHome: row.score_home,
      scoreAway: row.score_away,
      score90Home: row.score_90_home,
      score90Away: row.score_90_away,
      ft90Home: row.ft_90_home,
      ft90Away: row.ft_90_away,
      resultObservedAt: row.result_observed_at,
      resultMeta: parseProjectedJson(row.result_meta),
      resultAudit: parseProjectedJson(row.result_audit),
      resultCrossCheck: parseProjectedJson(row.result_cross_check),
      resultProvenance: parseProjectedJson(row.result_provenance),
      actualKickoffAt: row.actual_kickoff_at,
      actualKickoffTime: row.actual_kickoff_time,
      actualKickoffSource: row.actual_kickoff_source,
      firstInPlayObservedAt: row.first_in_play_observed_at,
      inPlayObservationSource: row.in_play_observation_source,
      businessDate: row.business_date,
      competitionName: row.competition_name,
      leagueId: row.league_id,
      leagueName: row.league_name,
      leagueShortName: row.league_short_name,
      homeTeamId: row.home_team_id,
      homeTeamName: row.home_team_name,
      awayTeamId: row.away_team_id,
      awayTeamName: row.away_team_name,
      __dataset: row.dataset,
    }));
    return {
      ok: true,
      currentMatches: projected
        .filter((match) => match.__dataset === "current")
        .map(({ __dataset, ...match }) => match),
      historyMatches: projected
        .filter((match) => match.__dataset === "history")
        .map(({ __dataset, ...match }) => match),
      reason: null,
    };
  } catch (error) {
    return {
      ok: false,
      currentMatches: [],
      historyMatches: [],
      reason: `sqlite match projection read failed: ${String(
        error?.message || error || "unknown error",
      ).slice(0, 240)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The public JSON fallback remains available during atomic replacement.
    }
  }
};

let matchUniverseCache = null;
const publicHistoryRowsForMatchUniverse = ({
  sqliteReady = false,
  readHistory = () => readJson(historyMatchesFile, []),
} = {}) => (
  sqliteReady
    ? []
    : arrayRows(readHistory(), ["matches", "items", "data"])
);

const settlementHistoryIdentityValues = ({
  artifactFiles = [
    registryFile,
    benchmarkLedgerFile,
    challengerSuiteFile,
    temperatureNeutralizationSuiteFile,
    legacyCommonCohortG2V1SuiteFile,
    commonCohortG2SuiteFile,
  ],
  readArtifact = (filePath) => readJson(filePath, null),
} = {}) => {
  const identities = new Set();
  const visited = new Set();
  const addIdentity = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    identities.add(normalized);
    const withoutPrefix = normalized.replace(/^sporttery_/, "");
    if (withoutPrefix) identities.add(withoutPrefix);
    if (/^[A-Za-z0-9-]+$/.test(withoutPrefix)) {
      identities.add(`sporttery_${withoutPrefix}`);
    }
  };
  const visit = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (!Array.isArray(value)) {
      const hasMatchIdentity = value.matchId != null || value.sourceMatchId != null;
      const looksLikeMatchEvidence = Boolean(
        value.kickoffAt
        || value.kickoffTime
        || value.decisionDeadlineAt
        || ["decision", "exclusion", "settlement", "settlement_hold"]
          .includes(value.type),
      );
      if (hasMatchIdentity && looksLikeMatchEvidence) {
        addIdentity(value.matchId);
        addIdentity(value.sourceMatchId);
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
  };
  for (const filePath of artifactFiles) visit(readArtifact(filePath));
  return [...identities].sort();
};

const matchUniverse = () => {
  if (matchUniverseCache) return matchUniverseCache;

  // Settlement only needs history rows corresponding to immutable decisions
  // already present in one of the active research ledgers. Projecting every
  // historical payload makes SQLite parse thousands of large JSON documents
  // on every heartbeat and competes directly with the generation exporter.
  // Keep all current rows, but bound history to the exact persisted decision
  // identities. If SQLite is unavailable the existing full public-history
  // fallback remains fail-closed.
  const historyIdentityValues = settlementHistoryIdentityValues({
    artifactFiles: captureMode === "deadline-only"
      ? [registryFile]
      : captureMode === "benchmark-only"
        ? [benchmarkLedgerFile]
        : [
            registryFile,
            benchmarkLedgerFile,
            challengerSuiteFile,
            temperatureNeutralizationSuiteFile,
            legacyCommonCohortG2V1SuiteFile,
            commonCohortG2SuiteFile,
          ],
  });
  const sqlite = sqliteProjectedMatchUniverse(sqliteDbPath, {
    historyIdentityValues,
  });
  const currentPayload = readJson(currentMatchesFile, null);
  const publicCurrent = matchRowsFromPayload(currentPayload) || [];
  // The SQLite projection already contains the authoritative result fields
  // needed to settle candidate rows. Re-reading the full public history on
  // every 15-second heartbeat adds tens of megabytes of JSON parsing while
  // the exporter may be writing the same history into SQLite. On the small
  // production host that can push capture beyond the 120-second freshness
  // window. Keep the public history only as the fail-closed fallback when the
  // durable projection cannot be opened.
  const publicHistory = publicHistoryRowsForMatchUniverse({
    sqliteReady: sqlite.ok,
  });
  const merged = mergeMatchUniverseSources({
    publicCurrent,
    publicHistory,
    sqliteCurrent: sqlite.ok ? sqlite.currentMatches : [],
    sqliteHistory: sqlite.ok ? sqlite.historyMatches : [],
  });
  const source = sqlite.ok
    ? "public-json+sqlite-authoritative-merge"
    : "public-json-fallback";

  matchUniverseCache = {
    ...merged,
    source,
    sqliteStatus: sqlite.ok ? "ready" : "degraded",
    sqliteReason: sqlite.reason,
  };
  return matchUniverseCache;
};

const matchIdentityValues = (match) => [...new Set([
  match?.id,
  match?.matchId,
  match?.sourceMatchId,
  String(match?.id || "").replace(/^sporttery_/, ""),
  String(match?.matchId || "").replace(/^sporttery_/, ""),
  String(match?.sourceMatchId || "").replace(/^sporttery_/, ""),
].map((value) => String(value || "").trim()).filter(Boolean))];

const kickoffMsFor = (match) => Date.parse(match?.kickoffTime || match?.matchDate || "");

const pendingCaptureMatches = (ledger, matches, atMs) => {
  const frozenMs = Date.parse(ledger?.header?.frozenAt || "");
  const existing = (ledger?.events || [])
    .filter((event) => event?.type === "decision" || event?.type === "exclusion");
  return matches.filter((match) => {
    const kickoffMs = kickoffMsFor(match);
    if (!Number.isFinite(kickoffMs) || !Number.isFinite(frozenMs)) return false;
    if (
      kickoffMs <= frozenMs
      || existing.some((event) => sameCohortIdentity(event, match))
    ) return false;
    const finalization = captureFinalizationFor(match);
    return Number.isFinite(finalization?.millis) && atMs >= finalization.millis;
  });
};

const parsePayloadRows = (rows) => rows
  .map((row) => {
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  })
  .filter((row) => row && typeof row === "object");

const timestampValue = (value) => {
  if (typeof value === "string") return value;
  if (Number.isFinite(value?.millis)) return new Date(value.millis).toISOString();
  return value?.value || value?.at || null;
};

const sqliteSnapshotsForMatches = (matches, frozenAt, {
  dbPath = sqliteDbPath,
  upperBoundForMatch = () => evaluatedAt,
  perMatchLimit = readinessSnapshotsPerMatchLimit,
  ensureSelectable = false,
} = {}) => {
  if (!matches.length) {
    return {
      ok: true,
      complete: true,
      rows: [],
      selectedRows: 0,
      queriedMatches: 0,
      saturatedMatches: 0,
      expandedMatches: 0,
      unresolvedTruncationMatches: 0,
      queryMode: "per-match-latest-before-cutoff-v1",
      reason: "no-due-matches",
    };
  }
  if (!DatabaseSync) {
    return {
      ok: false,
      complete: false,
      rows: [],
      selectedRows: 0,
      reason: sqliteLoadError?.message || "node:sqlite unavailable",
    };
  }
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      complete: false,
      rows: [],
      selectedRows: 0,
      reason: "sqlite database missing",
    };
  }
  const rows = [];
  let queriedMatches = 0;
  let saturatedMatches = 0;
  let expandedMatches = 0;
  let unresolvedTruncationMatches = 0;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const match of matches) {
      const ids = matchIdentityValues(match);
      if (!ids.length) continue;
      const upperBound = timestampValue(upperBoundForMatch(match)) || evaluatedAt;
      if (!Number.isFinite(Date.parse(upperBound))) continue;
      queriedMatches += 1;
      const placeholders = ids.map(() => "?").join(",");
      const statement = db.prepare(`
        SELECT payload
        FROM prediction_snapshots
        WHERE captured_at >= ?
          AND captured_at <= ?
          AND (
            source_match_id IN (${placeholders})
            OR match_id IN (${placeholders})
          )
        ORDER BY captured_at DESC
        LIMIT ?
      `);
      let limit = Math.max(1, Math.floor(Number(perMatchLimit) || 1));
      let selected = [];
      let saturated = false;
      while (true) {
        const queried = statement.all(
          frozenAt,
          upperBound,
          ...ids,
          ...ids,
          Math.min(snapshotLimit, limit) + 1,
        );
        saturated = queried.length > Math.min(snapshotLimit, limit);
        selected = queried.slice(0, Math.min(snapshotLimit, limit));
        if (!ensureSelectable || !saturated) break;
        const parsed = parsePayloadRows(selected);
        const selection = selectSnapshotAtDeadline({
          match,
          snapshots: parsed,
          frozenAt,
          deadlineAt: upperBound,
        });
        if (selection.snapshot) break;
        if (limit >= snapshotLimit) break;
        expandedMatches += 1;
        limit = Math.min(snapshotLimit, limit * 4);
      }
      if (saturated) saturatedMatches += 1;
      if (saturated && ensureSelectable) {
        const parsed = parsePayloadRows(selected);
        const selection = selectSnapshotAtDeadline({
          match,
          snapshots: parsed,
          frozenAt,
          deadlineAt: upperBound,
        });
        if (!selection.snapshot && selected.length >= snapshotLimit) {
          unresolvedTruncationMatches += 1;
        }
      }
      rows.push(...selected);
    }
  } catch (error) {
    return {
      ok: false,
      complete: false,
      rows: [],
      selectedRows: 0,
      reason: `sqlite prediction snapshot read failed: ${String(
        error?.message || error || "unknown error",
      ).slice(0, 240)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The next heartbeat retries against the atomically published database.
    }
  }
  const unqueriedMatches = Math.max(0, matches.length - queriedMatches);
  const complete = unresolvedTruncationMatches === 0 && unqueriedMatches === 0;
  return {
    ok: true,
    complete,
    rows: parsePayloadRows(rows).sort((left, right) => (
      Date.parse(left?.capturedAt || left?.firstSeenAt || "")
      - Date.parse(right?.capturedAt || right?.firstSeenAt || "")
    )),
    selectedRows: rows.length,
    queriedMatches,
    saturatedMatches,
    expandedMatches,
    unresolvedTruncationMatches,
    unqueriedMatches,
    queryMode: "per-match-latest-before-cutoff-v1",
    perMatchLimit: Math.max(1, Math.floor(Number(perMatchLimit) || 1)),
    reason: unresolvedTruncationMatches > 0
      ? "latest selectable snapshot not found before global safety limit"
      : unqueriedMatches > 0
        ? "one or more matches could not be queried before cutoff"
        : null,
  };
};

const sqliteOddsForMatches = (matches, activatedAt) => {
  if (!matches.length) {
    return { ok: true, rows: [], selectedRows: 0, reason: "no-tracked-matches" };
  }
  if (!DatabaseSync) {
    return {
      ok: false,
      rows: [],
      selectedRows: 0,
      reason: sqliteLoadError?.message || "node:sqlite unavailable",
    };
  }
  if (!fs.existsSync(sqliteDbPath)) {
    return { ok: false, rows: [], selectedRows: 0, reason: "sqlite database missing" };
  }
  const ids = [...new Set(matches.flatMap(matchIdentityValues))];
  if (!ids.length) return { ok: true, rows: [], selectedRows: 0, reason: "match-identities-missing" };
  const rows = [];
  let db = null;
  try {
    db = new DatabaseSync(sqliteDbPath, { readOnly: true });
    const chunkSize = 300;
    for (let offset = 0; offset < ids.length && rows.length < oddsLimit; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const remaining = oddsLimit - rows.length;
      const statement = db.prepare(`
        SELECT payload
        FROM odds_snapshots
        WHERE captured_at >= ?
          AND (
            source_match_id IN (${placeholders})
            OR match_id IN (${placeholders})
          )
        ORDER BY captured_at ASC
        LIMIT ?
      `);
      rows.push(...statement.all(activatedAt, ...chunk, ...chunk, remaining));
    }
  } catch (error) {
    return {
      ok: false,
      rows: [],
      selectedRows: 0,
      reason: `sqlite odds snapshot read failed: ${String(
        error?.message || error || "unknown error",
      ).slice(0, 240)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The next heartbeat retries against the atomically published database.
    }
  }
  return {
    ok: true,
    rows: parsePayloadRows(rows),
    selectedRows: rows.length,
    reason: null,
  };
};

const readTopLevelArrayProperty = (
  filePath,
  property,
  {
    maxBytes = publicSnapshotPrefixMaxBytes,
    chunkBytes = 64 * 1024,
  } = {},
) => {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const fileBytes = fs.fstatSync(fd).size;
    const byteLimit = Math.min(fileBytes, Math.max(1, Math.floor(maxBytes)));
    const readChunkBytes = Math.min(
      byteLimit,
      Math.max(4 * 1024, Math.floor(Number(chunkBytes) || 64 * 1024)),
    );
    const buffer = Buffer.allocUnsafe(readChunkBytes);
    const escapedProperty = String(property).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const propertyPattern = new RegExp(`"${escapedProperty}"\\s*:\\s*\\[`);
    let bytesRead = 0;
    let source = "";
    let arrayStart = -1;
    let scanIndex = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (bytesRead < byteLimit) {
      const requested = Math.min(buffer.length, byteLimit - bytesRead);
      const chunkLength = fs.readSync(fd, buffer, 0, requested, bytesRead);
      if (chunkLength <= 0) break;
      bytesRead += chunkLength;
      source += buffer.subarray(0, chunkLength).toString("utf8");
      if (arrayStart < 0) {
        const match = propertyPattern.exec(source);
        if (!match) continue;
        arrayStart = source.indexOf("[", match.index + match[0].indexOf(":"));
        scanIndex = arrayStart;
      }
      for (; scanIndex < source.length; scanIndex += 1) {
        const char = source[scanIndex];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "[") depth += 1;
        else if (char === "]") {
          depth -= 1;
          if (depth === 0) {
            const rows = JSON.parse(source.slice(arrayStart, scanIndex + 1));
            return {
              ok: Array.isArray(rows),
              rows: Array.isArray(rows) ? rows : [],
              bytesRead,
              fileBytes,
              reason: Array.isArray(rows) ? null : "property-is-not-array",
            };
          }
        }
      }
    }
    return {
      ok: false,
      rows: [],
      bytesRead,
      fileBytes,
      reason: arrayStart < 0
        ? "property-not-found-in-prefix"
        : "array-exceeds-prefix-limit",
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      bytesRead: 0,
      fileBytes: 0,
      reason: String(error?.message || error || "prefix-read-failed").slice(0, 240),
    };
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      // The next heartbeat can retry the immutable public snapshot file.
    }
  }
};

let publicSnapshotObservationCache = null;
let publicSnapshotAllRowsCache = null;
let publicSnapshotReadAudit = {
  version: "candidate-public-snapshot-read-audit-v1",
  mode: "not-read",
  bytesRead: 0,
  fileBytes: 0,
  rowsLoaded: 0,
  reason: null,
};

const publicSnapshotRows = ({ observationsOnly = false } = {}) => {
  if (observationsOnly && publicSnapshotObservationCache) {
    return publicSnapshotObservationCache;
  }
  if (!observationsOnly && publicSnapshotAllRowsCache) return publicSnapshotAllRowsCache;
  if (observationsOnly) {
    const prefix = readTopLevelArrayProperty(publicSnapshotsFile, "observations");
    if (prefix.ok) {
      publicSnapshotObservationCache = prefix.rows;
      publicSnapshotReadAudit = {
        version: "candidate-public-snapshot-read-audit-v1",
        mode: "observations-prefix",
        bytesRead: prefix.bytesRead,
        fileBytes: prefix.fileBytes,
        rowsLoaded: prefix.rows.length,
        reason: null,
      };
      return publicSnapshotObservationCache;
    }
    publicSnapshotReadAudit = {
      version: "candidate-public-snapshot-read-audit-v1",
      mode: "full-json-fallback",
      bytesRead: prefix.bytesRead,
      fileBytes: prefix.fileBytes,
      rowsLoaded: 0,
      reason: prefix.reason,
    };
  }
  const payload = readJson(publicSnapshotsFile, []);
  if (Array.isArray(payload)) return payload;
  publicSnapshotObservationCache = Array.isArray(payload?.observations)
    ? payload.observations
    : [];
  publicSnapshotAllRowsCache = [
    ...arrayRows(payload, ["rows", "snapshots", "items", "data"]),
    // Current-cycle observations must win when their semantic key and
    // capturedAt match an updated state row. The state row intentionally
    // preserves its historical firstSeenAt, which can predate candidate
    // activation; using it here would incorrectly reject a fresh observation.
    ...publicSnapshotObservationCache,
  ];
  publicSnapshotReadAudit = {
    version: "candidate-public-snapshot-read-audit-v1",
    mode: "full-json-fallback",
    bytesRead: (() => {
      try { return fs.statSync(publicSnapshotsFile).size; } catch { return 0; }
    })(),
    fileBytes: (() => {
      try { return fs.statSync(publicSnapshotsFile).size; } catch { return 0; }
    })(),
    rowsLoaded: publicSnapshotAllRowsCache.length,
    reason: publicSnapshotReadAudit.reason,
  };
  return publicSnapshotAllRowsCache;
};

const publicOddsRows = () => arrayRows(
  readJson(publicOddsFile, []),
  ["rows", "snapshots", "items", "data", "oddsHistory"],
);

const dedupeSnapshots = (rows) => {
  const selected = new Map();
  for (const row of rows) {
    const key = [
      row?.sourceMatchId || row?.matchId || "",
      row?.phase || "",
      row?.signature || "",
      row?.featureSnapshotHash || row?.featureSnapshot?.hash || "legacy",
      row?.capturedAt || row?.firstSeenAt || "",
    ].join("|");
    selected.set(key, row);
  }
  return [...selected.values()];
};

const countValues = (values) => values.reduce((counts, value) => {
  const key = String(value || "unknown");
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {});

const summarizeDeadlineBatches = (rows, atMs) => {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const deadlineAt = row?.decisionDeadlineAt || null;
    const key = deadlineAt || "missing-decision-deadline";
    const existing = groups.get(key) || {
      version: "candidate-deadline-batch-summary-v1",
      deadlineAt,
      finalizationAt: row?.captureFinalizationAt || null,
      totalMatches: 0,
      readyNow: 0,
      awaitingMarket: 0,
      blocked: 0,
      excluded: 0,
      terminalDecisions: 0,
      terminalExclusions: 0,
      duplicateTerminalEvents: 0,
      terminalKeysWithDuplicates: 0,
    };
    existing.totalMatches += 1;
    if (row?.status === "ready-now") existing.readyNow += 1;
    if (row?.status === "awaiting-market") existing.awaitingMarket += 1;
    if (row?.status === "blocked") existing.blocked += 1;
    if (row?.status === "excluded") existing.excluded += 1;
    const terminalEventCount = Math.max(
      0,
      Number(row?.terminalEventCount || 0),
    );
    if (terminalEventCount > 0 && row?.status === "ready-now") {
      existing.terminalDecisions += 1;
    }
    if (terminalEventCount > 0 && row?.status === "excluded") {
      existing.terminalExclusions += 1;
    }
    if (terminalEventCount > 1) {
      existing.duplicateTerminalEvents += terminalEventCount - 1;
      existing.terminalKeysWithDuplicates += 1;
    }
    if (
      row?.captureFinalizationAt
      && (
        !existing.finalizationAt
        || Date.parse(row.captureFinalizationAt) < Date.parse(existing.finalizationAt)
      )
    ) {
      existing.finalizationAt = row.captureFinalizationAt;
    }
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((batch) => {
      const deadlineMs = Date.parse(batch.deadlineAt || "");
      const finalizationMs = Date.parse(batch.finalizationAt || "");
      const statusTotal =
        batch.readyNow
        + batch.awaitingMarket
        + batch.blocked
        + batch.excluded;
      const terminalMatches =
        batch.terminalDecisions + batch.terminalExclusions;
      const phase = !Number.isFinite(deadlineMs)
        ? "deadline-missing"
        : atMs < deadlineMs
          ? "upcoming"
          : Number.isFinite(finalizationMs) && atMs < finalizationMs
            ? "finalization-grace"
            : "post-finalization";
      const dueUnrecorded = phase === "post-finalization"
        ? Math.max(0, batch.totalMatches - terminalMatches)
        : 0;
      const readyDueUnrecorded = phase === "post-finalization"
        ? Math.max(0, batch.readyNow - batch.terminalDecisions)
        : 0;
      const pendingMatches = Math.max(
        0,
        batch.totalMatches - terminalMatches,
      );
      return {
        ...batch,
        phase,
        actionableMatches: Math.max(0, batch.totalMatches - batch.excluded),
        terminalMatches,
        pendingMatches,
        dueUnrecorded,
        readyDueUnrecorded,
        invariantOk:
          statusTotal === batch.totalMatches
          && terminalMatches <= batch.totalMatches
          && batch.duplicateTerminalEvents === 0
          && batch.terminalKeysWithDuplicates === 0
          && readyDueUnrecorded <= dueUnrecorded
          && (
            phase !== "post-finalization"
            || dueUnrecorded === 0
          ),
      };
    })
    .sort((left, right) => {
      const leftMs = Date.parse(left.deadlineAt || "");
      const rightMs = Date.parse(right.deadlineAt || "");
      if (!Number.isFinite(leftMs)) return 1;
      if (!Number.isFinite(rightMs)) return -1;
      return leftMs - rightMs;
    });
};

const candidateReadinessPreview = ({
  ledger,
  matches,
  snapshots,
  evaluatedAt: previewEvaluatedAt,
  trustedCollectorCount,
  trustedCollectorResolver = null,
}) => {
  const atMs = Date.parse(previewEvaluatedAt);
  const frozenMs = Date.parse(ledger?.header?.frozenAt || "");
  const terminalEvents = (Array.isArray(ledger?.events) ? ledger.events : [])
    .filter((event) => event?.type === "decision" || event?.type === "exclusion");
  const upcoming = (Array.isArray(matches) ? matches : [])
    .filter((match) => {
      const kickoffMs = kickoffMsFor(match);
      return Number.isFinite(atMs)
        && Number.isFinite(frozenMs)
        && Number.isFinite(kickoffMs)
        && kickoffMs > atMs
        && kickoffMs > frozenMs;
    })
    .sort((left, right) => kickoffMsFor(left) - kickoffMsFor(right));
  const evaluatedRows = upcoming.map((match) => {
    const deadline = decisionDeadlineFor(match);
    const finalization = captureFinalizationFor(match);
    const matchingTerminalEvents = terminalEvents.filter(
      (event) => sameCohortIdentity(event, match),
    );
    const terminalEvent = matchingTerminalEvents.at(-1) || null;
    const terminalEventCount = matchingTerminalEvents.length;
    if (!deadline || !Number.isFinite(deadline.millis)) {
      return {
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        kickoffAt: Number.isFinite(kickoffMsFor(match))
          ? new Date(kickoffMsFor(match)).toISOString()
          : null,
        decisionDeadlineAt: null,
        decisionDeadlineSource: null,
        captureFinalizationAt: null,
        captureFinalizationGraceSeconds: CAPTURE_FINALIZATION_GRACE_SECONDS,
        terminalEventCount,
        status: "blocked",
        blockers: ["decision-deadline-missing"],
        atomicEvidenceValid: false,
        decisionSnapshotObserved: false,
        officialHadMarketPresent: false,
        strictOfficialMarketEvidenceComplete: false,
        marketState: "decision-deadline-missing",
        awaitingReason: null,
      };
    }
    if (terminalEvent?.type === "exclusion") {
      const officialHadMarketPresent =
        terminalEvent.officialHadMarketPresent === true;
      const strictOfficialMarketEvidenceComplete =
        terminalEvent.strictOfficialMarketEvidenceComplete === true;
      return {
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        kickoffAt: new Date(kickoffMsFor(match)).toISOString(),
        decisionDeadlineAt: terminalEvent.decisionDeadlineAt || deadline.value,
        decisionDeadlineSource:
          terminalEvent.decisionDeadlineSource || deadline.source,
        captureFinalizationAt:
          terminalEvent.captureFinalizationAt || finalization?.value || null,
        captureFinalizationGraceSeconds:
          terminalEvent.captureFinalizationGraceSeconds
          ?? finalization?.graceSeconds
          ?? CAPTURE_FINALIZATION_GRACE_SECONDS,
        snapshotCapturedAt: terminalEvent.snapshotCapturedAt || null,
        terminalRecordedAt: terminalEvent.recordedAt || null,
        terminalEventHash: terminalEvent.eventHash || null,
        terminalEventCount,
        status: "excluded",
        blockers: Array.isArray(terminalEvent.blockers)
          ? [...new Set(terminalEvent.blockers.map(String))].sort()
          : [],
        atomicEvidenceValid: false,
        decisionSnapshotObserved: Boolean(terminalEvent.snapshotCapturedAt),
        officialHadMarketPresent,
        strictOfficialMarketEvidenceComplete,
        marketState:
          terminalEvent.marketState || "terminal-exclusion-unclassified",
        awaitingReason: null,
      };
    }
    if (terminalEvent?.type === "decision") {
      const atomicEvidenceValid = atomicDecisionRecordValid(terminalEvent);
      return {
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        kickoffAt: new Date(kickoffMsFor(match)).toISOString(),
        decisionDeadlineAt: terminalEvent.decisionDeadlineAt || deadline.value,
        decisionDeadlineSource:
          terminalEvent.decisionDeadlineSource || deadline.source,
        captureFinalizationAt:
          terminalEvent.captureFinalizationAt || finalization?.value || null,
        captureFinalizationGraceSeconds:
          terminalEvent.captureFinalizationGraceSeconds
          ?? finalization?.graceSeconds
          ?? CAPTURE_FINALIZATION_GRACE_SECONDS,
        snapshotCapturedAt: terminalEvent.snapshotCapturedAt || null,
        terminalRecordedAt: terminalEvent.recordedAt || null,
        terminalEventHash: terminalEvent.eventHash || null,
        terminalEventCount,
        status: atomicEvidenceValid ? "ready-now" : "blocked",
        blockers: atomicEvidenceValid
          ? []
          : ["atomic-decision-record-invalid"],
        atomicEvidenceValid,
        decisionSnapshotObserved: true,
        officialHadMarketPresent: true,
        strictOfficialMarketEvidenceComplete: atomicEvidenceValid,
        marketState: atomicEvidenceValid
          ? "atomic-ready"
          : "terminal-atomic-invalid",
        awaitingReason: null,
      };
    }
    const previewCutoffAt = new Date(Math.min(atMs, deadline.millis)).toISOString();
    const selection = selectSnapshotAtDeadline({
      match,
      snapshots,
      frozenAt: ledger.header.frozenAt,
      deadlineAt: previewCutoffAt,
    });
    if (!selection.snapshot) {
      return {
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        kickoffAt: new Date(kickoffMsFor(match)).toISOString(),
        decisionDeadlineAt: deadline.value,
        decisionDeadlineSource: deadline.source,
        captureFinalizationAt: finalization?.value || null,
        captureFinalizationGraceSeconds:
          finalization?.graceSeconds ?? CAPTURE_FINALIZATION_GRACE_SECONDS,
        terminalEventCount,
        status: "awaiting-market",
        blockers: selection.blockers,
        atomicEvidenceValid: false,
        decisionSnapshotObserved: false,
        officialHadMarketPresent: false,
        strictOfficialMarketEvidenceComplete: false,
        marketState: "decision-snapshot-not-observed",
        awaitingReason: "eligible-decision-snapshot-not-observed",
      };
    }
    const event = buildDecisionEvent({
      ledger,
      match,
      snapshot: selection.snapshot,
      evaluatedAt: previewEvaluatedAt,
      phase: "formal",
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    const had = selection.snapshot?.decisionSnapshot?.markets?.HAD || {};
    const isDecision = event?.type === "decision";
    const atomicEvidenceValid = isDecision && atomicDecisionRecordValid(event);
    const blockers = [
      ...(Array.isArray(event?.blockers) ? event.blockers : []),
      ...(isDecision && !atomicEvidenceValid
        ? ["atomic-decision-record-invalid"]
        : []),
    ];
    const evidenceClassification = classifyCandidateDecisionEvidence({
      had,
      blockers,
      atomicEvidenceValid,
    });
    const {
      officialHadMarketPresent,
      strictOfficialMarketEvidenceComplete,
      marketState,
    } = evidenceClassification;
    return {
      matchId: String(match?.id || match?.matchId || ""),
      sourceMatchId: String(match?.sourceMatchId || ""),
      kickoffAt: new Date(kickoffMsFor(match)).toISOString(),
      decisionDeadlineAt: deadline.value,
      decisionDeadlineSource: deadline.source,
      captureFinalizationAt: finalization?.value || null,
      captureFinalizationGraceSeconds:
        finalization?.graceSeconds ?? CAPTURE_FINALIZATION_GRACE_SECONDS,
      terminalEventCount,
      snapshotCapturedAt:
        selection.snapshot?.decisionSnapshot?.capturedAt
        || selection.snapshot?.capturedAt
        || null,
      status: isDecision
        ? atomicEvidenceValid
          ? "ready-now"
          : "blocked"
        : officialHadMarketPresent
          ? "blocked"
          : "awaiting-market",
      blockers: [...new Set(blockers)].sort(),
      atomicEvidenceValid,
      decisionSnapshotObserved: true,
      officialHadMarketPresent,
      strictOfficialMarketEvidenceComplete,
      marketState,
      awaitingReason: officialHadMarketPresent
        ? null
        : "official-had-market-not-published",
    };
  });
  // Terminal exclusions are already reconciled outcomes, not operational
  // capture blockers. Keep their reasons visible without making an otherwise
  // healthy upcoming cohort look blocked.
  const blockerCounts = countValues(evaluatedRows
    .filter((row) => row.status !== "excluded")
    .flatMap((row) => row.blockers || []));
  const excludedReasonCounts = countValues(evaluatedRows
    .filter((row) => row.status === "excluded")
    .flatMap((row) => row.blockers || []));
  const readyNow = evaluatedRows.filter((row) => row.status === "ready-now").length;
  const atomicReadyNow = evaluatedRows.filter((row) => (
    row.status === "ready-now" && row.atomicEvidenceValid === true
  )).length;
  const awaitingMarket = evaluatedRows.filter((row) => row.status === "awaiting-market").length;
  const blocked = evaluatedRows.filter((row) => row.status === "blocked").length;
  const excluded = evaluatedRows.filter((row) => row.status === "excluded").length;
  const awaitingReasonCounts = countValues(evaluatedRows
    .filter((row) => row.status === "awaiting-market")
    .map((row) => row.awaitingReason)
    .filter(Boolean));
  const marketStateCounts = countValues(evaluatedRows
    .map((row) => row.marketState)
    .filter(Boolean));
  const decisionSnapshotObservedMatches = evaluatedRows
    .filter((row) => row.decisionSnapshotObserved === true).length;
  const officialHadPublishedMatches = evaluatedRows
    .filter((row) => row.officialHadMarketPresent === true).length;
  const strictMarketEvidenceCompleteMatches = evaluatedRows
    .filter((row) => row.strictOfficialMarketEvidenceComplete === true).length;
  const awaitingUnpublishedMatches = evaluatedRows
    .filter((row) => (
      row.status === "awaiting-market"
      && row.awaitingReason === "official-had-market-not-published"
    )).length;
  const awaitingSnapshotMissingMatches = evaluatedRows
    .filter((row) => (
      row.status === "awaiting-market"
      && row.awaitingReason === "eligible-decision-snapshot-not-observed"
    )).length;
  const publishedChainGapMatches = evaluatedRows
    .filter((row) => (
      row.status === "blocked"
      && row.officialHadMarketPresent === true
    )).length;
  const awaitingClassifiedMatches =
    awaitingUnpublishedMatches + awaitingSnapshotMissingMatches;
  const marketCoverage = {
    version: "candidate-official-market-coverage-preview-v1",
    evaluatedMatches: evaluatedRows.length,
    decisionSnapshotObservedMatches,
    officialHadPublishedMatches,
    strictMarketEvidenceCompleteMatches,
    atomicReadyMatches: atomicReadyNow,
    awaitingUnpublishedMatches,
    awaitingSnapshotMissingMatches,
    publishedChainGapMatches,
    terminalExcludedMatches: excluded,
    awaitingClassifiedMatches,
    awaitingClassificationComplete: awaitingClassifiedMatches === awaitingMarket,
    marketStateCounts,
  };
  const readyInvariantOk = (
    atomicReadyNow === readyNow
    && readyNow + awaitingMarket + blocked + excluded === evaluatedRows.length
    && marketCoverage.awaitingClassificationComplete
  );
  const rows = evaluatedRows.slice(0, readinessPreviewLimit);
  const nearestUnresolved = evaluatedRows
    .filter((row) => (
      row.status !== "excluded"
      && Number(row?.terminalEventCount || 0) === 0
      && Number.isFinite(Date.parse(row?.decisionDeadlineAt || ""))
    ))
    .sort((left, right) => (
      Date.parse(left?.decisionDeadlineAt || "")
      - Date.parse(right?.decisionDeadlineAt || "")
    ))[0] || null;
  const deadlineBatches = summarizeDeadlineBatches(evaluatedRows, atMs);
  const nearestDeadlineBatch = deadlineBatches.find(
    (batch) => batch.pendingMatches > 0 && batch.deadlineAt,
  ) || null;
  return {
    version: "candidate-prospective-readiness-preview-v2",
    evaluatedAt: previewEvaluatedAt,
    candidateRevisionId: ledger?.header?.candidateRevisionId || null,
    captureFinalizationPolicyVersion: CAPTURE_FINALIZATION_POLICY_VERSION,
    captureFinalizationGraceSeconds: CAPTURE_FINALIZATION_GRACE_SECONDS,
    previewLimit: readinessPreviewLimit,
    evaluatedMatches: evaluatedRows.length,
    detailedMatches: rows.length,
    rowsTruncated: Math.max(0, evaluatedRows.length - rows.length),
    upcomingMatches: evaluatedRows.length,
    readyNow,
    atomicReadyNow,
    awaitingMarket,
    blocked,
    excluded,
    readyInvariantOk,
    readinessRatio: evaluatedRows.length
      ? Number((readyNow / evaluatedRows.length).toFixed(6))
      : 1,
    nearestDeadlineAt: nearestUnresolved?.decisionDeadlineAt || null,
    nearestFinalizationAt: nearestUnresolved?.captureFinalizationAt || null,
    nearestStatus: nearestUnresolved?.status || null,
    deadlineBatches,
    nearestDeadlineBatch,
    blockerCounts,
    awaitingReasonCounts,
    excludedReasonCounts,
    marketCoverage,
    rows,
  };
};

const dedupeOdds = (rows) => {
  const selected = new Map();
  for (const row of rows) {
    const key = [
      row?.sourceMatchId || row?.matchId || "",
      row?.poolCode || row?.pool || "",
      row?.handicapLine ?? "",
      row?.capturedAt || row?.firstSeenAt || "",
      row?.stateSignature || "",
    ].join("|");
    selected.set(key, row);
  }
  return [...selected.values()];
};

const benchmarkPendingMatches = (ledger, matches, atMs) => {
  const decided = new Set(
    (ledger?.events || [])
      .filter((event) => event?.type === "selection" || event?.type === "exclusion")
      .map((event) => event.cohortKey),
  );
  return matches.filter((match) => {
    const cohortKey = benchmarkCohortKeyFor(match);
    const deadline = benchmarkDecisionCutoffFor(match, GOODWIN_BENCHMARK_SHADOW_POLICY);
    const kickoffMs = kickoffMsFor(match);
    if (!cohortKey || decided.has(cohortKey) || !deadline || !Number.isFinite(kickoffMs)) {
      return false;
    }
    return atMs >= deadline.millis && atMs < kickoffMs;
  });
};

const benchmarkTrackedMatches = (ledger, matches, dueMatches) => {
  const selectedSourceIds = new Set(
    (ledger?.events || [])
      .filter((event) => event?.type === "selection")
      .map((event) => String(event.sourceMatchId || "").replace(/^sporttery_/, ""))
      .filter(Boolean),
  );
  const dueKeys = new Set(dueMatches.map(benchmarkCohortKeyFor).filter(Boolean));
  return matches.filter((match) => (
    dueKeys.has(benchmarkCohortKeyFor(match))
    || selectedSourceIds.has(
      String(match?.sourceMatchId || match?.matchId || match?.id || "")
        .replace(/^sporttery_/, ""),
    )
  ));
};

const compactBenchmarkAudit = (audit) => audit ? {
  version: audit.version || null,
  status: audit.status || null,
  rootHash: audit.prospective?.rootHash || null,
  chainValid: audit.prospective?.chainValid === true,
  eventCount: Number(audit.prospective?.eventCount || 0),
  cohort: audit.prospective?.cohort || null,
  metrics: audit.prospective?.metrics ? {
    settled: Number(audit.prospective.metrics.settled || 0),
    won: Number(audit.prospective.metrics.won || 0),
    lost: Number(audit.prospective.metrics.lost || 0),
    hitRate: audit.prospective.metrics.hitRate ?? null,
  } : null,
  promotionReviewReady: audit.promotionReviewReady === true,
} : null;

const compactAudit = (audit) => audit ? {
  version: audit.version || null,
  evaluatedAt: audit.evaluatedAt || null,
  state: audit.state || null,
  candidateRevisionId: audit.candidateRevisionId || null,
  rootHash: audit.rootHash || null,
  chainValid: audit.chainValid === true,
  decisionRecord: audit.decisionRecord || null,
  settlementRecord: audit.settlementRecord || null,
  cohort: audit.cohort || null,
  metrics: audit.metrics ? {
    formalRows: Number(audit.metrics.formalRows || 0),
    logLossImprovement: audit.metrics.logLossImprovement ?? null,
    brierImprovement: audit.metrics.brierImprovement ?? null,
    invalidShare: audit.metrics.invalidShare ?? null,
    singleAttestorShare: audit.metrics.singleAttestorShare ?? null,
    diagnostics: audit.metrics.diagnostics || null,
    bootstrap: audit.metrics.bootstrap || null,
    windows: Array.isArray(audit.metrics.windows) ? audit.metrics.windows : [],
    windowEvaluation: audit.metrics.windowEvaluation || null,
  } : null,
  // Keep the aliases for older operational readers while the canonical shape
  // follows auditLedger and can be projected without waiting for a backtest.
  shadow: audit.cohort?.shadow || null,
  formal: audit.cohort?.formal || null,
  activationAt: audit.activationAt || null,
  promotionReviewReady: audit.promotionReviewReady === true,
  blockers: Array.isArray(audit.blockers) ? audit.blockers : [],
} : null;

// Research suites only settle against trusted official results. Their input
// must therefore change when (and only when) an official settlement candidate
// changes; live odds and unrelated presentation fields must not force all
// research arms to rescan the complete historical universe every heartbeat.
const researchSettlementInputFingerprint = (matches = []) => sha256(canonicalize(
  (Array.isArray(matches) ? matches : [])
    .map((match) => {
      const officialFinal = isOfficialSportteryFinal(match);
      return {
        sourceMatchId: canonicalSourceMatchId(
          match?.sourceMatchId ?? match?.matchId ?? match?.id,
        ) || null,
        eventVersion: eventVersionOf(match),
        officialFinal,
        scoreHome: officialFinal && Number.isInteger(match?.scoreHome)
          ? match.scoreHome
          : null,
        scoreAway: officialFinal && Number.isInteger(match?.scoreAway)
          ? match.scoreAway
          : null,
        provenance: officialFinal ? buildResultProvenance(match) : null,
      };
    })
    .sort((left, right) => (
      String(left.sourceMatchId || "").localeCompare(String(right.sourceMatchId || ""))
      || String(left.eventVersion || "").localeCompare(String(right.eventVersion || ""))
      || Number(left.officialFinal) - Number(right.officialFinal)
      || Number(left.scoreHome ?? -1) - Number(right.scoreHome ?? -1)
      || Number(left.scoreAway ?? -1) - Number(right.scoreAway ?? -1)
      || sha256(left).localeCompare(sha256(right))
    )),
));

const healthyReusableResearchStatus = (status, version) => Boolean(
  status
  && typeof status === "object"
  && status.version === version
  && status.ok === true
  && status.available === true
  && status.chainValid === true
  && Array.isArray(status.blockers)
  && status.blockers.length === 0,
);

const researchHeartbeatReuseDecision = ({
  priorStatus = null,
  settlementInputFingerprint = null,
  settlementChanged = false,
  challengerDueMatches = 0,
  temperatureDueMatches = 0,
  commonCohortG2DueMatches = 0,
} = {}) => {
  const settlementInputUnchanged = Boolean(
    settlementInputFingerprint
    && priorStatus?.researchSettlementInputFingerprint === settlementInputFingerprint,
  );
  const suitesHealthy = Boolean(
    healthyReusableResearchStatus(
      priorStatus?.challengerSuite,
      CHALLENGER_SUITE_AUDIT_VERSION,
    )
    && healthyReusableResearchStatus(
      priorStatus?.temperatureNeutralizationSuite,
      TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
    )
    && healthyReusableResearchStatus(
      priorStatus?.commonCohortG2,
      COMMON_COHORT_G2_AUDIT_VERSION,
    )
  );
  const noDueMatches = [
    challengerDueMatches,
    temperatureDueMatches,
    commonCohortG2DueMatches,
  ].every((value) => Number(value || 0) === 0);
  return {
    settlementInputUnchanged,
    suitesHealthy,
    reuseSettlement: settlementInputUnchanged && suitesHealthy,
    reuseCapture:
      settlementInputUnchanged
      && suitesHealthy
      && settlementChanged !== true
      && noDueMatches,
  };
};

const reusedResearchStatus = (status, { dueMatches = 0 } = {}) => ({
  ...status,
  evaluatedAt,
  ok: true,
  skipped: false,
  changed: false,
  settlementsAdded: 0,
  dueMatches: Number(dueMatches || 0),
  reused: true,
  reason: status.reason || null,
  reuseReason: "unchanged-research-heartbeat",
  blockers: [],
});

const deferredResearchStatus = (status, { dueMatches = 0 } = {}) => ({
  ...reusedResearchStatus(status, { dueMatches }),
  skipped: true,
  deferredForPrimaryDeadlineCapture: true,
  reason: "deferred-for-primary-deadline-capture",
  reuseReason: "primary-formal-ledger-priority",
});

const deadlineOnlyResearchStatus = (status, version) => ({
  ...(status && typeof status === "object" ? status : {
    version,
    available: false,
    onlineEffect: false,
    chainValid: false,
  }),
  // Deferring research does not repair its prior failure or make an absent
  // suite available. Keep those reasons separate from the formal heartbeat.
  ok: status?.ok !== false,
  skipped: true,
  changed: false,
  deferredForPrimaryDeadlineCapture: true,
  reason: "deadline-only-research-deferred",
  reuseReason: "production-critical-formal-heartbeat-only",
  blockers: Array.isArray(status?.blockers) && status.blockers.length
    ? [...status.blockers]
    : status?.available === true ? [] : ["deadline-only-research-unavailable"],
});

const settleCalibrationChallengers = ({ matches }) => {
  try {
    return withCandidateProspectiveRegistryLock(
      challengerSuiteFile,
      () => {
        const priorSuite = readJson(challengerSuiteFile, null);
        const update = settleCalibrationChallengerSuite({
          priorSuite,
          matches,
          evaluatedAt,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(challengerSuiteFile, update.suite);
        }
        return {
          ...(update.audit || {
            version: CHALLENGER_SUITE_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
            trials: [],
          }),
          ok: update.chainValid,
          skipped: !priorSuite,
          changed: update.changed === true,
          settlementsAdded: Number(update.settlementsAdded || 0),
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: CHALLENGER_SUITE_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(challengerSuiteFile),
      ok: false,
      skipped: true,
      changed: false,
      settlementsAdded: 0,
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "challenger-suite-lock-busy"
        : "challenger-suite-settlement-failed",
      errorCode: error?.code || null,
      onlineEffect: false,
      chainValid: false,
      blockers: [error?.message || String(error)],
      trials: [],
    };
  }
};

const captureCalibrationChallengers = ({
  activeLedger,
  activeAudit,
  matches,
  snapshots,
  challengerDueMatches = 0,
  challengerEvidenceQueryComplete = true,
  trustedCollectorCount,
  trustedCollectorResolver = null,
}) => {
  try {
    return withCandidateProspectiveRegistryLock(
      challengerSuiteFile,
      () => {
        const priorSuite = readJson(challengerSuiteFile, null);
        if (challengerDueMatches > 0 && !challengerEvidenceQueryComplete) {
          return {
            version: CHALLENGER_SUITE_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            ok: false,
            skipped: true,
            reason: "challenger-deadline-evidence-query-incomplete",
            onlineEffect: false,
            dueMatches: challengerDueMatches,
            chainValid: true,
            blockers: ["challenger-deadline-evidence-query-incomplete"],
            trials: [],
          };
        }
        const evaluation = readJson(modelEvaluationFile, null);
        const plan = priorSuite ? null : buildCalibrationDeescalationPlan({
          candidates: evaluation?.shadowCandidates?.candidates || [],
          activeLedger,
          activeAudit,
          evaluatedAt,
        });
        const update = updateCalibrationChallengerSuite({
          priorSuite,
          plan,
          matches,
          snapshots,
          evaluatedAt,
          trustedCollectorCount,
          trustedCollectorResolver,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(challengerSuiteFile, update.suite);
        }
        return {
          ...(update.audit || {
            version: CHALLENGER_SUITE_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
            trials: [],
          }),
          ok: update.chainValid,
          skipped: false,
          changed: update.changed === true,
          dueMatches: challengerDueMatches,
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: CHALLENGER_SUITE_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(challengerSuiteFile),
      ok: false,
      skipped: true,
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "challenger-suite-lock-busy"
        : "challenger-suite-update-failed",
      errorCode: error?.code || null,
      onlineEffect: false,
      dueMatches: challengerDueMatches,
      chainValid: false,
      blockers: [error?.message || String(error)],
      trials: [],
    };
  }
};

const settleTemperatureNeutralization = ({ matches }) => {
  try {
    return withCandidateProspectiveRegistryLock(
      temperatureNeutralizationSuiteFile,
      () => {
        const priorSuite = readJson(temperatureNeutralizationSuiteFile, null);
        const update = settleTemperatureNeutralizationSuite({
          priorSuite,
          matches,
          evaluatedAt,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(temperatureNeutralizationSuiteFile, update.suite);
        }
        return {
          ...(update.audit || {
            version: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
            trials: [],
          }),
          ok: update.chainValid,
          skipped: !priorSuite,
          changed: update.changed === true,
          settlementsAdded: Number(update.settlementsAdded || 0),
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(temperatureNeutralizationSuiteFile),
      ok: false,
      skipped: true,
      changed: false,
      settlementsAdded: 0,
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "temperature-neutralization-suite-lock-busy"
        : "temperature-neutralization-suite-settlement-failed",
      errorCode: error?.code || null,
      onlineEffect: false,
      chainValid: false,
      blockers: [error?.message || String(error)],
      trials: [],
    };
  }
};

const captureTemperatureNeutralization = ({
  activeLedger,
  matches,
  snapshots,
  dueMatches = 0,
  evidenceQueryComplete = true,
  trustedCollectorCount,
  trustedCollectorResolver = null,
  settlementStatus = null,
}) => {
  try {
    return withCandidateProspectiveRegistryLock(
      temperatureNeutralizationSuiteFile,
      () => {
        const priorSuite = readJson(temperatureNeutralizationSuiteFile, null);
        if (dueMatches > 0 && !evidenceQueryComplete) {
          return {
            ...(settlementStatus || {
              version: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
              evaluatedAt,
              available: Boolean(priorSuite),
              onlineEffect: false,
              trials: [],
            }),
            ok: false,
            skipped: true,
            changed: settlementStatus?.changed === true,
            reason: "temperature-neutralization-deadline-evidence-query-incomplete",
            dueMatches,
            onlineEffect: false,
            chainValid: true,
            blockers: [
              "temperature-neutralization-deadline-evidence-query-incomplete",
            ],
          };
        }
        const calibrationChallengerSuite = readJson(challengerSuiteFile, null);
        const plan = priorSuite ? null : buildTemperatureNeutralizationPlan({
          activeLedger,
          calibrationChallengerSuite,
          evaluatedAt,
        });
        const update = updateTemperatureNeutralizationSuite({
          priorSuite,
          plan,
          matches,
          snapshots,
          evaluatedAt,
          trustedCollectorCount,
          trustedCollectorResolver,
          dueMatches,
          evidenceQueryComplete,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(temperatureNeutralizationSuiteFile, update.suite);
        }
        const unavailable = update.audit?.available !== true;
        return {
          ...(update.audit || {
            version: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
            trials: [],
          }),
          ok: update.chainValid,
          skipped: unavailable,
          changed: update.changed === true || settlementStatus?.changed === true,
          settlementsAdded: Number(settlementStatus?.settlementsAdded || 0),
          reason: unavailable
            ? "temperature-neutralization-plan-not-registered"
            : null,
          dueMatches,
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(temperatureNeutralizationSuiteFile),
      ok: false,
      skipped: true,
      changed: settlementStatus?.changed === true,
      settlementsAdded: Number(settlementStatus?.settlementsAdded || 0),
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "temperature-neutralization-suite-lock-busy"
        : "temperature-neutralization-suite-update-failed",
      errorCode: error?.code || null,
      onlineEffect: false,
      dueMatches,
      chainValid: false,
      blockers: [error?.message || String(error)],
      trials: [],
    };
  }
};

const settleCommonCohortG2 = ({ matches }) => {
  try {
    return withCandidateProspectiveRegistryLock(
      commonCohortG2SuiteFile,
      () => {
        const priorSuite = readJson(commonCohortG2SuiteFile, null);
        const update = settleCommonCohortShadowG2Suite({
          priorSuite,
          matches,
          evaluatedAt,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(commonCohortG2SuiteFile, update.suite);
        }
        return {
          ...(update.audit || {
            version: COMMON_COHORT_G2_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
          }),
          ok: update.chainValid,
          artifactGeneration: "G2-v2",
          artifactNamespaceVersion: "v2",
          legacyV1Preserved: fs.existsSync(legacyCommonCohortG2V1SuiteFile),
          legacyV1IgnoredForV2: true,
          skipped: !priorSuite,
          changed: update.changed === true,
          settlementsAdded: Number(update.settlementsAdded || 0),
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: COMMON_COHORT_G2_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(commonCohortG2SuiteFile),
      ok: false,
      skipped: true,
      changed: false,
      settlementsAdded: 0,
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "common-cohort-G2-lock-busy"
        : "common-cohort-G2-settlement-failed",
      onlineEffect: false,
      artifactGeneration: "G2-v2",
      artifactNamespaceVersion: "v2",
      legacyV1Preserved: fs.existsSync(legacyCommonCohortG2V1SuiteFile),
      legacyV1IgnoredForV2: true,
      chainValid: false,
      blockers: [error?.message || String(error)],
    };
  }
};

const captureCommonCohortG2 = ({
  activeLedger,
  matches,
  snapshots,
  dueMatches = 0,
  evidenceQueryComplete = true,
  trustedCollectorCount,
  trustedCollectorResolver = null,
  settlementStatus = null,
}) => {
  try {
    return withCandidateProspectiveRegistryLock(
      commonCohortG2SuiteFile,
      () => {
        const priorSuite = readJson(commonCohortG2SuiteFile, null);
        const sourceChallengerSuite = readJson(challengerSuiteFile, null);
        const sourceTemperatureSuite = readJson(temperatureNeutralizationSuiteFile, null);
        const plan = priorSuite ? null : buildCommonCohortShadowG2Plan({
            activeLedger,
            evaluatedAt,
            sourceChallengerSuite,
            sourceTemperatureSuite,
          });
        const update = updateCommonCohortShadowG2Suite({
          priorSuite,
          plan,
          matches,
          snapshots,
          evaluatedAt,
          trustedCollectorCount,
          trustedCollectorResolver,
          dueMatches,
          evidenceQueryComplete,
        });
        if (update.chainValid && update.changed && update.suite) {
          writeJsonAtomic(commonCohortG2SuiteFile, update.suite);
        }
        const unavailable = update.audit?.available !== true;
        return {
          ...(update.audit || {
            version: COMMON_COHORT_G2_AUDIT_VERSION,
            evaluatedAt,
            available: Boolean(priorSuite),
            onlineEffect: false,
          }),
          ok: update.chainValid,
          artifactGeneration: "G2-v2",
          artifactNamespaceVersion: "v2",
          legacyV1Preserved: fs.existsSync(legacyCommonCohortG2V1SuiteFile),
          legacyV1IgnoredForV2: true,
          skipped: unavailable,
          changed: update.changed === true || settlementStatus?.changed === true,
          settlementsAdded: Number(settlementStatus?.settlementsAdded || 0),
          reason: unavailable
            ? priorSuite
              ? "common-cohort-G2-registration-invalid"
              : "common-cohort-G2-plan-not-registered"
            : null,
          dueMatches,
          blockers: Array.isArray(update.blockers) ? update.blockers : [],
        };
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    return {
      version: COMMON_COHORT_G2_AUDIT_VERSION,
      evaluatedAt,
      available: fs.existsSync(commonCohortG2SuiteFile),
      ok: false,
      skipped: true,
      changed: settlementStatus?.changed === true,
      settlementsAdded: Number(settlementStatus?.settlementsAdded || 0),
      reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
        ? "common-cohort-G2-lock-busy"
        : "common-cohort-G2-update-failed",
      onlineEffect: false,
      artifactGeneration: "G2-v2",
      artifactNamespaceVersion: "v2",
      legacyV1Preserved: fs.existsSync(legacyCommonCohortG2V1SuiteFile),
      legacyV1IgnoredForV2: true,
      dueMatches,
      chainValid: false,
      blockers: [error?.message || String(error)],
    };
  }
};

const priorCaptureStatus = readJson(statusFile, null);
const priorBenchmarkCaptureStatus = readJson(benchmarkStatusFile, null);
let currentResearchSettlementInputFingerprint = null;
let benchmarkCaptureStatus = (
  priorBenchmarkCaptureStatus?.version === "goodwin-benchmark-deadline-capture-v1"
    ? priorBenchmarkCaptureStatus
    : priorCaptureStatus?.benchmark?.version === "goodwin-benchmark-deadline-capture-v1"
    ? priorCaptureStatus.benchmark
    : {
        version: "goodwin-benchmark-deadline-capture-v1",
        evaluatedAt,
        ok: true,
        skipped: true,
        reason: "awaiting-first-heartbeat",
      }
);

const writeStatus = (payload) => {
  const body = {
    version: "prospective-deadline-heartbeat-v2",
    evaluatedAt,
    captureMode,
    captureDurationMs: Number(
      (Number(process.hrtime.bigint() - captureStartedAt) / 1_000_000).toFixed(3),
    ),
    registryFile,
    benchmarkLedgerFile,
    benchmarkStatusFile,
    temperatureNeutralizationSuiteFile,
    commonCohortG2SuiteFile,
    sqliteDbPath,
    researchSettlementInputFingerprint: currentResearchSettlementInputFingerprint,
    publicSnapshotRead: publicSnapshotReadAudit,
    benchmark: benchmarkCaptureStatus,
    ...payload,
  };
  writeJsonAtomic(statusFile, body);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return body;
};

const publishBenchmarkCaptureStatus = (status) => {
  writeJsonAtomic(benchmarkStatusFile, status);
  try {
    withCandidateProspectiveRegistryLock(
      registryFile,
      () => {
        const currentStatus = readJson(statusFile, null);
        if (currentStatus?.version !== "prospective-deadline-heartbeat-v2") return;
        writeJsonAtomic(statusFile, {
          ...currentStatus,
          benchmark: status,
        });
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch {
    // The sidecar is authoritative for the independent benchmark scheduler.
    // The next formal heartbeat merges it without weakening cutoff freshness.
  }
  return status;
};

const captureBenchmark = () => {
  // Prepare the read-only match universe before taking the append-only ledger
  // lock. SQLite replacement or JSON fallback can be slow under export load,
  // but none of that work needs to block another cutoff writer.
  const universe = matchUniverse();
  return withCandidateProspectiveRegistryLock(
    benchmarkLedgerFile,
    () => {
    const { currentMatches, historyMatches, matches } = universe;
    const priorLedger = readJson(benchmarkLedgerFile, null);
    const atMs = Date.parse(evaluatedAt);
    const dueMatches = benchmarkPendingMatches(priorLedger, matches, atMs);
    const trackedMatches = benchmarkTrackedMatches(priorLedger, matches, dueMatches);
    const sqliteSnapshots = sqliteSnapshotsForMatches(
      dueMatches,
      GOODWIN_BENCHMARK_SHADOW_POLICY.activatedAt,
      {
        upperBoundForMatch: (match) => benchmarkDecisionCutoffFor(
          match,
          GOODWIN_BENCHMARK_SHADOW_POLICY,
        ),
        perMatchLimit: benchmarkSnapshotsPerMatchLimit,
      },
    );
    const snapshots = dueMatches.length
      ? dedupeSnapshots([
          ...sqliteSnapshots.rows,
          ...publicSnapshotRows({ observationsOnly: sqliteSnapshots.ok }),
        ])
      : [];
    const sqliteOdds = sqliteOddsForMatches(
      trackedMatches,
      GOODWIN_BENCHMARK_SHADOW_POLICY.activatedAt,
    );
    const oddsRows = trackedMatches.length
      ? dedupeOdds([
          ...sqliteOdds.rows,
          ...publicOddsRows(),
        ])
      : [];
    const beforeEvents = priorLedger?.events?.length || 0;
    const {
      ledgerUpdate,
      audit,
    } = buildBenchmarkProspectiveAudit({
      priorLedger,
      matches,
      snapshots,
      oddsRows,
      evaluatedAt,
      researchAudit: null,
    });
    const afterEvents = ledgerUpdate.ledger?.events?.length || 0;
    const eventsAdded = Math.max(0, afterEvents - beforeEvents);
    if (ledgerUpdate.chainValid && ledgerUpdate.changed) {
      writeJsonAtomic(benchmarkLedgerFile, ledgerUpdate.ledger);
    }
    return {
      version: "goodwin-benchmark-deadline-capture-v1",
      evaluatedAt,
      captureMode: "benchmark-only",
      ok: ledgerUpdate.chainValid === true,
      skipped: false,
      changed: ledgerUpdate.changed === true,
      reason: dueMatches.length
        ? "deadline-cohort-evaluated"
        : trackedMatches.length
          ? "selection-settlement-heartbeat"
          : "universe-heartbeat",
      dueMatches: dueMatches.length,
      trackedMatches: trackedMatches.length,
      currentMatches: currentMatches.length,
      historyMatches: historyMatches.length,
      matchUniverseSource: universe.source,
      matchUniverseSqliteStatus: universe.sqliteStatus,
      matchUniverseSqliteReason: universe.sqliteReason,
      sqliteSnapshots: sqliteSnapshots.selectedRows,
      sqliteSnapshotStatus: sqliteSnapshots.ok ? "ready" : "degraded",
      sqliteSnapshotReason: sqliteSnapshots.reason,
      sqliteSnapshotQueryMode: sqliteSnapshots.queryMode || null,
      sqliteSnapshotQueriedMatches: sqliteSnapshots.queriedMatches || 0,
      sqliteSnapshotSaturatedMatches: sqliteSnapshots.saturatedMatches || 0,
      mergedSnapshots: snapshots.length,
      sqliteOdds: sqliteOdds.selectedRows,
      sqliteOddsStatus: sqliteOdds.ok ? "ready" : "degraded",
      sqliteOddsReason: sqliteOdds.reason,
      mergedOdds: oddsRows.length,
      eventsAdded,
      audit: compactBenchmarkAudit(audit),
      blockers: ledgerUpdate.blockers || [],
    };
  },
    { timeoutMs: lockTimeoutMs },
  );
};

const capture = ({ deadlineOnly = false } = {}) => {
  // The universe is immutable for this evaluatedAt. Build it outside the
  // registry lock so the 1.22GB SQLite export lane cannot turn preparation
  // I/O into candidate-ledger lock contention.
  const universe = matchUniverse();
  return withCandidateProspectiveRegistryLock(
    registryFile,
    () => {
    let registry = readJson(registryFile, null);
    const verification = verifyRegistry(registry);
    if (!verification.valid) {
      return writeStatus({
        ok: false,
        skipped: true,
        reason: "registry-invalid",
        blockers: verification.blockers,
      });
    }
    let ledger = activeLedgerFor(registry);
    if (!ledger) {
      return writeStatus({
        ok: true,
        skipped: true,
        reason: "active-ledger-missing",
        blockers: ["active-ledger-missing"],
      });
    }
    const { currentMatches, historyMatches, matches } = universe;
    currentResearchSettlementInputFingerprint = deadlineOnly
      ? priorCaptureStatus?.researchSettlementInputFingerprint || null
      : researchSettlementInputFingerprint(matches);
    const settlementUpdate = settleCandidateProspectiveRegistry({
      priorRegistry: registry,
      matches,
      evaluatedAt,
    });
    if (!settlementUpdate.chainValid) {
      return writeStatus({
        ok: false,
        skipped: true,
        changed: false,
        reason: "settlement-registry-invalid",
        settlementEventsAdded: 0,
        blockers: settlementUpdate.blockers,
      });
    }
    if (settlementUpdate.changed) {
      writeJsonAtomic(registryFile, settlementUpdate.registry);
      registry = settlementUpdate.registry;
      ledger = activeLedgerFor(registry) || ledger;
    }
    const initialResearchReuse = deadlineOnly ? null : researchHeartbeatReuseDecision({
      priorStatus: priorCaptureStatus,
      settlementInputFingerprint: currentResearchSettlementInputFingerprint,
      settlementChanged: settlementUpdate.changed === true,
    });
    const challengerSettlement = deadlineOnly
      ? deadlineOnlyResearchStatus(
          priorCaptureStatus?.challengerSuite,
          CHALLENGER_SUITE_AUDIT_VERSION,
        )
      : initialResearchReuse.reuseSettlement
        ? reusedResearchStatus(priorCaptureStatus.challengerSuite)
        : settleCalibrationChallengers({ matches });
    const temperatureNeutralizationSettlement = deadlineOnly
      ? deadlineOnlyResearchStatus(
          priorCaptureStatus?.temperatureNeutralizationSuite,
          TEMPERATURE_NEUTRALIZATION_AUDIT_VERSION,
        )
      : initialResearchReuse.reuseSettlement
        ? reusedResearchStatus(priorCaptureStatus.temperatureNeutralizationSuite)
        : settleTemperatureNeutralization({ matches });
    const commonCohortG2Settlement = deadlineOnly
      ? deadlineOnlyResearchStatus(
          priorCaptureStatus?.commonCohortG2,
          COMMON_COHORT_G2_AUDIT_VERSION,
        )
      : initialResearchReuse.reuseSettlement
        ? reusedResearchStatus(priorCaptureStatus.commonCohortG2)
        : settleCommonCohortG2({ matches });
    const settlementEventsAdded = Number(settlementUpdate.settlementsAdded || 0);
    const driftBlockers = implementationDrift(ledger);
    if (driftBlockers.length) {
      return writeStatus({
        ok: true,
        skipped: true,
        changed: settlementUpdate.changed === true,
        reason: "candidate-implementation-drift-awaiting-refreeze",
        candidateRevisionId: ledger.header?.candidateRevisionId || null,
        settlementEventsAdded,
        challengerSettlement,
        temperatureNeutralizationSuite: temperatureNeutralizationSettlement,
        commonCohortG2: commonCohortG2Settlement,
        audit: compactAudit(settlementUpdate.audit),
        blockers: driftBlockers,
      });
    }
    const atMs = Date.parse(evaluatedAt);
    const dueMatches = pendingCaptureMatches(ledger, matches, atMs);
    const priorChallengerSuite = deadlineOnly
      ? null
      : readJson(challengerSuiteFile, null);
    const challengerDueMatchRows = uniqueMatches(
      challengerLedgersFor(priorChallengerSuite)
        .flatMap((challengerLedger) => pendingCaptureMatches(
          challengerLedger,
          matches,
          atMs,
        )),
    );
    const priorTemperatureNeutralizationSuite = deadlineOnly
      ? null
      : readJson(temperatureNeutralizationSuiteFile, null);
    const temperatureNeutralizationDueMatchRows = uniqueMatches(
      futureOnlyMatchesForSuite(
        priorTemperatureNeutralizationSuite,
        temperatureNeutralizationLedgersFor(priorTemperatureNeutralizationSuite)
          .flatMap((temperatureLedger) => pendingCaptureMatches(
            temperatureLedger,
            matches,
            atMs,
          )),
      ),
    );
    const priorCommonCohortG2Suite = deadlineOnly
      ? null
      : readJson(commonCohortG2SuiteFile, null);
    const commonCohortG2EligibleMatches = priorCommonCohortG2Suite
      ? commonCohortG2InputEligibility({
          plan: priorCommonCohortG2Suite.header?.frozenPlan,
          matches,
        }).eligible
      : [];
    const commonCohortG2DueMatchRows = uniqueMatches(
      commonCohortG2LedgersFor(priorCommonCohortG2Suite)
        .flatMap((g2Ledger) => pendingCaptureMatches(
          g2Ledger,
          commonCohortG2EligibleMatches,
          atMs,
        )),
    );
    // Formal customer-facing decisions are the only time-critical writes in
    // this process. Research suites consume the same immutable pre-deadline
    // snapshots and can safely catch up on the next heartbeat. When all three
    // suites already have a healthy persisted state, keep the due heartbeat
    // bounded by capturing the formal ledger first instead of multiplying the
    // SQLite deadline query and write work inside one 45-second child budget.
    const deferResearchCapture = deadlineOnly || Boolean(
      dueMatches.length > 0
      && initialResearchReuse.suitesHealthy
    );
    const researchSnapshotQueryMatches = deferResearchCapture
      ? []
      : [
          ...challengerDueMatchRows,
          ...temperatureNeutralizationDueMatchRows,
          ...commonCohortG2DueMatchRows,
        ];
    const snapshotQueryMatches = uniqueMatches([
      ...dueMatches,
      ...researchSnapshotQueryMatches,
    ]);
    const upcomingMatches = matches.filter((match) => {
      const kickoffMs = kickoffMsFor(match);
      return Number.isFinite(kickoffMs) && kickoffMs > atMs;
    });
    const sqlite = sqliteSnapshotsForMatches(
      snapshotQueryMatches,
      ledger.header?.frozenAt || evaluatedAt,
      {
        upperBoundForMatch: (match) => decisionDeadlineFor(match),
        perMatchLimit: dueSnapshotsPerMatchLimit,
        ensureSelectable: true,
      },
    );
    const snapshots = snapshotQueryMatches.length
      ? dedupeSnapshots([
          ...sqlite.rows,
          ...publicSnapshotRows({ observationsOnly: sqlite.ok }),
        ])
      : [];
    const readinessSqlite = sqliteSnapshotsForMatches(
      upcomingMatches,
      ledger.header?.frozenAt || evaluatedAt,
      {
        upperBoundForMatch: (match) => {
          const deadline = decisionDeadlineFor(match);
          return Number.isFinite(deadline?.millis)
            ? new Date(Math.min(atMs, deadline.millis)).toISOString()
            : evaluatedAt;
        },
        perMatchLimit: readinessSnapshotsPerMatchLimit,
      },
    );
    const readinessSnapshots = upcomingMatches.length
      ? dedupeSnapshots([
          ...readinessSqlite.rows,
          ...publicSnapshotRows({ observationsOnly: readinessSqlite.ok }),
        ])
      : [];
    const trustedCollectorCount = Math.max(
      0,
      Number(process.env.TRUSTED_SPORTTERY_COLLECTOR_COUNT || 1),
    );
    const collectorEvidenceStore = readJson(collectorEvidenceStoreFile, null);
    const collectorTrustRegistry = loadCollectorTrustRegistry(collectorTrustRegistryFile);
    const trustedCollectorResolver = collectorTrustRegistry
      ? ({ snapshot, deadlineAt }) => collectorQuorumForDecision({
          snapshot,
          deadlineAt,
          evidenceStore: collectorEvidenceStore,
          trustRegistry: collectorTrustRegistry,
        })
      : null;
    let readiness = candidateReadinessPreview({
      ledger,
      matches,
      snapshots: readinessSnapshots,
      evaluatedAt,
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    const sqliteEvidenceQueryComplete = sqlite.ok === true && sqlite.complete === true;
    const dueEvidenceQueryComplete = sqliteEvidenceQueryComplete || dueMatches.every((match) => {
      const deadline = decisionDeadlineFor(match);
      if (!Number.isFinite(deadline?.millis)) return false;
      return Boolean(selectSnapshotAtDeadline({
        match,
        snapshots,
        frozenAt: ledger.header?.frozenAt || evaluatedAt,
        deadlineAt: deadline.value,
      }).snapshot);
    });
    const challengerEvidenceQueryComplete = sqliteEvidenceQueryComplete
      || challengerDueMatchRows.every((match) => {
        const deadline = decisionDeadlineFor(match);
        if (!Number.isFinite(deadline?.millis)) return false;
        return Boolean(selectSnapshotAtDeadline({
          match,
          snapshots,
          frozenAt: challengerLedgersFor(priorChallengerSuite)[0]?.header?.frozenAt
            || evaluatedAt,
          deadlineAt: deadline.value,
        }).snapshot);
      });
    const temperatureNeutralizationEvidenceQueryComplete =
      sqliteEvidenceQueryComplete
      || temperatureNeutralizationDueMatchRows.every((match) => {
        const deadline = decisionDeadlineFor(match);
        if (!Number.isFinite(deadline?.millis)) return false;
        return Boolean(selectSnapshotAtDeadline({
          match,
          snapshots,
          frozenAt:
            temperatureNeutralizationLedgersFor(
              priorTemperatureNeutralizationSuite,
            )[0]?.header?.frozenAt || evaluatedAt,
          deadlineAt: deadline.value,
        }).snapshot);
      });
    const commonCohortG2EvidenceQueryComplete =
      sqliteEvidenceQueryComplete
      || commonCohortG2DueMatchRows.every((match) => {
        const deadline = decisionDeadlineFor(match);
        if (!Number.isFinite(deadline?.millis)) return false;
        return Boolean(selectSnapshotAtDeadline({
          match,
          snapshots,
          frozenAt: commonCohortG2LedgersFor(
            priorCommonCohortG2Suite,
          )[0]?.header?.frozenAt || evaluatedAt,
          deadlineAt: deadline.value,
        }).snapshot);
      });
    const readinessReadyDueUnrecorded = (readiness.deadlineBatches || [])
      .reduce((sum, batch) => sum + Number(batch?.readyDueUnrecorded || 0), 0);
    if (!dueEvidenceQueryComplete) {
      return writeStatus({
        ok: false,
        skipped: false,
        changed: settlementUpdate.changed === true,
        reason: "deadline-evidence-query-incomplete",
        settlementEventsAdded,
        dueMatches: dueMatches.length,
        dueCaptureEventsAdded: 0,
        dueDecisionEventsAdded: 0,
        dueExclusionEventsAdded: 0,
        dueAtomicDecisionEventsAdded: 0,
        dueCaptureComplete: false,
        dueAtomicComplete: false,
        dueUnrecorded: dueMatches.length,
        readyDueUnrecorded: readinessReadyDueUnrecorded,
        currentMatches: currentMatches.length,
        historyMatches: historyMatches.length,
        matchUniverseSource: universe.source,
        matchUniverseSqliteStatus: universe.sqliteStatus,
        matchUniverseSqliteReason: universe.sqliteReason,
        sqliteSnapshots: sqlite.selectedRows,
        sqliteSnapshotStatus: "degraded",
        sqliteSnapshotReason: sqlite.reason,
        sqliteSnapshotQueryMode: sqlite.queryMode || null,
        sqliteSnapshotQueriedMatches: sqlite.queriedMatches || 0,
        sqliteSnapshotSaturatedMatches: sqlite.saturatedMatches || 0,
        sqliteSnapshotExpandedMatches: sqlite.expandedMatches || 0,
        sqliteSnapshotUnresolvedTruncationMatches:
          sqlite.unresolvedTruncationMatches || 0,
        readinessSqliteSnapshots: readinessSqlite.selectedRows,
        readinessSqliteStatus: readinessSqlite.ok ? "ready" : "degraded",
        readinessSqliteReason: readinessSqlite.reason,
        readiness,
        challengerSettlement,
        temperatureNeutralizationSuite: {
          ...temperatureNeutralizationSettlement,
          skipped: true,
          reason: "primary-deadline-evidence-query-incomplete",
        },
        commonCohortG2: {
          ...commonCohortG2Settlement,
          skipped: true,
          reason: "primary-deadline-evidence-query-incomplete",
        },
        eventsAdded: settlementUpdate.eventsAdded || 0,
        audit: compactAudit(settlementUpdate.audit) || priorCaptureStatus?.audit || null,
        blockers: ["deadline-evidence-query-incomplete"],
      });
    }
    const beforeEvents = ledger.events?.length || 0;
    const update = updateCandidateProspectiveLedger({
      priorRegistry: registry,
      candidates: [],
      selectedCandidate: null,
      robustness: null,
      matches,
      snapshots,
      evaluatedAt,
      implementationCommitment: {},
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    if (!update.chainValid) {
      return writeStatus({
        ok: false,
        skipped: true,
        changed: settlementUpdate.changed === true,
        reason: "updated-registry-invalid",
        settlementEventsAdded,
        challengerSettlement,
        temperatureNeutralizationSuite: temperatureNeutralizationSettlement,
        commonCohortG2: commonCohortG2Settlement,
        blockers: update.blockers,
      });
    }
    const updatedLedger = activeLedgerFor(update.registry);
    readiness = candidateReadinessPreview({
      ledger: updatedLedger || ledger,
      matches,
      snapshots: readinessSnapshots,
      evaluatedAt,
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    const finalResearchReuse = deadlineOnly ? null : researchHeartbeatReuseDecision({
      priorStatus: priorCaptureStatus,
      settlementInputFingerprint: currentResearchSettlementInputFingerprint,
      settlementChanged: settlementUpdate.changed === true,
      challengerDueMatches: challengerDueMatchRows.length,
      temperatureDueMatches: temperatureNeutralizationDueMatchRows.length,
      commonCohortG2DueMatches: commonCohortG2DueMatchRows.length,
    });
    const challengerSuite = deadlineOnly
      ? challengerSettlement
      : deferResearchCapture
      ? deferredResearchStatus(priorCaptureStatus?.challengerSuite, {
          dueMatches: challengerDueMatchRows.length,
        })
      : finalResearchReuse.reuseCapture
      ? reusedResearchStatus(priorCaptureStatus.challengerSuite)
      : captureCalibrationChallengers({
          activeLedger: updatedLedger || ledger,
          activeAudit: update.audit,
          matches,
          snapshots,
          challengerDueMatches: challengerDueMatchRows.length,
          challengerEvidenceQueryComplete,
          trustedCollectorCount,
          trustedCollectorResolver,
        });
    const temperatureNeutralizationSuite = deadlineOnly
      ? temperatureNeutralizationSettlement
      : deferResearchCapture
      ? deferredResearchStatus(
          priorCaptureStatus?.temperatureNeutralizationSuite,
          { dueMatches: temperatureNeutralizationDueMatchRows.length },
        )
      : finalResearchReuse.reuseCapture
      ? reusedResearchStatus(priorCaptureStatus.temperatureNeutralizationSuite)
      : captureTemperatureNeutralization({
          activeLedger: updatedLedger || ledger,
          matches,
          snapshots,
          dueMatches: temperatureNeutralizationDueMatchRows.length,
          evidenceQueryComplete: temperatureNeutralizationEvidenceQueryComplete,
          trustedCollectorCount,
          trustedCollectorResolver,
          settlementStatus: temperatureNeutralizationSettlement,
        });
    const commonCohortG2 = deadlineOnly
      ? commonCohortG2Settlement
      : deferResearchCapture
      ? deferredResearchStatus(priorCaptureStatus?.commonCohortG2, {
          dueMatches: commonCohortG2DueMatchRows.length,
        })
      : finalResearchReuse.reuseCapture
      ? reusedResearchStatus(priorCaptureStatus.commonCohortG2)
      : captureCommonCohortG2({
          activeLedger: updatedLedger || ledger,
          matches,
          snapshots,
          dueMatches: commonCohortG2DueMatchRows.length,
          evidenceQueryComplete: commonCohortG2EvidenceQueryComplete,
          trustedCollectorCount,
          trustedCollectorResolver,
          settlementStatus: commonCohortG2Settlement,
        });
    const afterEvents = updatedLedger?.events?.length || 0;
    const eventsAdded = Math.max(0, afterEvents - beforeEvents);
    const totalEventsAdded = eventsAdded + Number(settlementUpdate.eventsAdded || 0);
    const dueIdentityValues = new Set(
      dueMatches.flatMap((match) => [
        match?.id,
        match?.matchId,
        match?.sourceMatchId,
      ])
        .map((value) => String(value || "").replace(/^sporttery_/, "").trim())
        .filter(Boolean),
    );
    const appendedDueEvents = (updatedLedger?.events || [])
      .slice(beforeEvents)
      .filter((event) => {
        if (!["decision", "exclusion"].includes(event?.type)) return false;
        const identities = [
          event?.matchId,
          event?.sourceMatchId,
        ]
          .map((value) => String(value || "").replace(/^sporttery_/, "").trim())
          .filter(Boolean);
        return identities.some((value) => dueIdentityValues.has(value));
      });
    const dueDecisionEventsAdded = appendedDueEvents
      .filter((event) => event.type === "decision").length;
    const dueExclusionEventsAdded = appendedDueEvents
      .filter((event) => event.type === "exclusion").length;
    const dueAtomicDecisionEventsAdded = appendedDueEvents
      .filter((event) => event.type === "decision" && atomicDecisionRecordValid(event))
      .length;
    const dueCaptureEventsAdded = dueDecisionEventsAdded + dueExclusionEventsAdded;
    const dueCaptureComplete = dueCaptureEventsAdded === dueMatches.length;
    const dueAtomicComplete =
      dueAtomicDecisionEventsAdded === dueDecisionEventsAdded;
    const dueUnrecorded = (readiness.deadlineBatches || [])
      .reduce((sum, batch) => sum + Number(batch?.dueUnrecorded || 0), 0);
    const readyDueUnrecorded = (readiness.deadlineBatches || [])
      .reduce((sum, batch) => sum + Number(batch?.readyDueUnrecorded || 0), 0);
    const captureBlockers = [
      ...(Array.isArray(update.blockers) ? update.blockers : []),
      ...(!dueCaptureComplete ? ["deadline-cohort-capture-incomplete"] : []),
      ...(!dueAtomicComplete ? ["deadline-cohort-atomic-decision-incomplete"] : []),
      ...(dueUnrecorded !== 0 ? ["deadline-cohort-due-unrecorded"] : []),
      ...(readyDueUnrecorded !== 0 ? ["deadline-cohort-ready-due-unrecorded"] : []),
    ];
    if (eventsAdded > 0) {
      writeJsonAtomic(registryFile, update.registry);
    }
    return writeStatus({
      ok: update.chainValid
        && dueCaptureComplete
        && dueAtomicComplete
        && dueUnrecorded === 0
        && readyDueUnrecorded === 0,
      skipped: false,
      changed: totalEventsAdded > 0,
      reason: dueMatches.length ? "deadline-cohort-evaluated" : "settlement-heartbeat",
      settlementEventsAdded,
      dueMatches: dueMatches.length,
      dueCaptureEventsAdded,
      dueDecisionEventsAdded,
      dueExclusionEventsAdded,
      dueAtomicDecisionEventsAdded,
      dueCaptureComplete,
      dueAtomicComplete,
      dueUnrecorded,
      readyDueUnrecorded,
      currentMatches: currentMatches.length,
      historyMatches: historyMatches.length,
      matchUniverseSource: universe.source,
      matchUniverseSqliteStatus: universe.sqliteStatus,
      matchUniverseSqliteReason: universe.sqliteReason,
      sqliteSnapshots: sqlite.selectedRows,
      sqliteSnapshotStatus: sqlite.ok ? "ready" : "degraded",
      sqliteSnapshotReason: sqlite.reason,
      sqliteSnapshotQueryMode: sqlite.queryMode || null,
      sqliteSnapshotQueriedMatches: sqlite.queriedMatches || 0,
      sqliteSnapshotSaturatedMatches: sqlite.saturatedMatches || 0,
      sqliteSnapshotExpandedMatches: sqlite.expandedMatches || 0,
      sqliteSnapshotUnresolvedTruncationMatches:
        sqlite.unresolvedTruncationMatches || 0,
      mergedSnapshots: snapshots.length,
      readinessSqliteSnapshots: readinessSqlite.selectedRows,
      readinessSqliteStatus: readinessSqlite.ok ? "ready" : "degraded",
      readinessSqliteReason: readinessSqlite.reason,
      readinessSqliteQueryMode: readinessSqlite.queryMode || null,
      readinessSqliteQueriedMatches: readinessSqlite.queriedMatches || 0,
      readinessSqliteSaturatedMatches: readinessSqlite.saturatedMatches || 0,
      readiness,
      challengerSuite,
      temperatureNeutralizationSuite,
      commonCohortG2,
      eventsAdded: totalEventsAdded,
      audit: compactAudit(update.audit),
      blockers: [...new Set(captureBlockers)].sort(),
    });
  },
    { timeoutMs: lockTimeoutMs },
  );
};

const main = () => {
  const { deadlineOnly, benchmarkOnly } = captureExecutionMode();
  if (benchmarkOnly) {
    try {
      benchmarkCaptureStatus = publishBenchmarkCaptureStatus(captureBenchmark());
      process.stdout.write(`${JSON.stringify(benchmarkCaptureStatus, null, 2)}\n`);
      if (
        benchmarkCaptureStatus?.ok !== true
        || benchmarkCaptureStatus?.skipped === true
      ) process.exitCode = 1;
    } catch (error) {
      benchmarkCaptureStatus = {
        version: "goodwin-benchmark-deadline-capture-v1",
        evaluatedAt,
        captureMode: "benchmark-only",
        ok: false,
        skipped: true,
        reason: error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
          ? "ledger-lock-busy"
          : "benchmark-capture-failed",
        error: error?.message || String(error),
        errorCode: error?.code || null,
        blockers: [
          error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT"
            ? "ledger-lock-busy"
            : "benchmark-deadline-capture-failed",
        ],
      };
      publishBenchmarkCaptureStatus(benchmarkCaptureStatus);
      process.stderr.write(`${JSON.stringify(benchmarkCaptureStatus)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  // The candidate ledger is the production-critical cutoff lane. Publish it
  // before the heavier research benchmark work so a worker timeout cannot
  // leave the formal heartbeat stale.
  try {
    const result = capture({ deadlineOnly });
    if (result?.ok !== true) process.exitCode = 1;
  } catch (error) {
    const lockBusy = error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT";
    const priorStatus = lockBusy ? readJson(statusFile, null) : null;
    const priorHealthyHeartbeat = (
      priorStatus?.version === "prospective-deadline-heartbeat-v2"
      && priorStatus.ok === true
      && priorStatus.skipped === false
      && priorStatus.readiness
      && typeof priorStatus.readiness === "object"
    );
    if (priorHealthyHeartbeat) {
      process.stdout.write(`${JSON.stringify({
        ...priorStatus,
        transientAttempt: {
          evaluatedAt,
          reason: "registry-lock-busy",
          error: error?.message || String(error),
          errorCode: error?.code || null,
          blockers: ["registry-lock-busy"],
        },
      }, null, 2)}\n`);
    } else {
      writeStatus({
        ok: lockBusy,
        skipped: true,
        reason: lockBusy ? "registry-lock-busy" : "capture-failed",
        error: error?.message || String(error),
        errorCode: error?.code || null,
        blockers: [lockBusy ? "registry-lock-busy" : "candidate-deadline-capture-failed"],
      });
    }
    if (!lockBusy) process.exitCode = 1;
  }

  // The worker and release keeper need only the exact, fail-closed cutoff
  // heartbeat above. Benchmark collection runs through the independent
  // benchmark-only resident lane (and remains part of the default full mode),
  // so a large odds-history scan cannot turn a safely committed formal
  // heartbeat into a child-process timeout.
  if (deadlineOnly) return;

  try {
    benchmarkCaptureStatus = publishBenchmarkCaptureStatus(captureBenchmark());
  } catch (error) {
    const lockBusy = error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT";
    benchmarkCaptureStatus = {
      version: "goodwin-benchmark-deadline-capture-v1",
      evaluatedAt,
      captureMode: "benchmark-only",
      ok: lockBusy,
      skipped: true,
      reason: lockBusy ? "ledger-lock-busy" : "benchmark-capture-failed",
      error: error?.message || String(error),
      errorCode: error?.code || null,
      blockers: [lockBusy ? "ledger-lock-busy" : "benchmark-deadline-capture-failed"],
    };
    publishBenchmarkCaptureStatus(benchmarkCaptureStatus);
  }
};

if (require.main === module) main();

module.exports = {
  BENCHMARK_ONLY_FLAG,
  DEADLINE_ONLY_FLAG,
  candidateReadinessPreview,
  captureExecutionMode,
  implementationDrift,
  main,
  mergeMatchUniverseSources,
  publicHistoryRowsForMatchUniverse,
  readTopLevelArrayProperty,
  researchHeartbeatReuseDecision,
  deferredResearchStatus,
  deadlineOnlyResearchStatus,
  researchSettlementInputFingerprint,
  settlementHistoryIdentityValues,
  sqliteSnapshotsForMatches,
  sqliteProjectedMatchUniverse,
  summarizeDeadlineBatches,
};
