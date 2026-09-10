"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resultTimelineSemanticHash } = require("./asOfResultTimeline.cjs");
const {
  pairedCircularBlockBootstrap,
} = require("./shadowCandidateRobustness.cjs");
const {
  buildResultProvenance,
  canonicalSourceMatchId,
  eventVersionOf,
  isOfficialSportteryFinal,
} = require("../src/services/matchLifecycle.cjs");
const {
  COLLECTOR_QUORUM_VERSION,
} = require("../server/collectorQuorumEvidence.cjs");

const REGISTRY_VERSION = "candidate-prospective-registry-v1";
const LEDGER_VERSION = "candidate-prospective-ledger-v1";
const AUDIT_VERSION = "candidate-prospective-audit-v1";
const CANDIDATE_EVALUATOR_VERSION = "frozen-shadow-candidate-evaluator-v3";
const CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION =
  "candidate-evaluator-semantic-commitment-v1";
const DECISION_RECORD_VERSION = "candidate-atomic-decision-record-v3";
const ATOMIC_DECISION_VALIDATION_VERSION =
  "candidate-atomic-decision-validation-v2";
const SETTLEMENT_RECORD_VERSION = "candidate-official-settlement-record-v1";
const SETTLEMENT_VALIDATION_VERSION =
  "candidate-official-settlement-validation-v1";
const DUAL_MARKET_DECISION_RECORD_VERSION =
  "candidate-dual-market-decision-record-v1";
const LEAGUE_NORMALIZATION_VERSION = "candidate-league-normalization-v1";
const SETTLEMENT_REQUIRED_FIELDS = Object.freeze([
  "decision-link",
  "official-result-identity",
  "score-outcome-consistency",
  "result-observation-clock",
  "result-provenance-hash",
]);
const ATOMIC_DECISION_REQUIRED_FIELDS = Object.freeze([
  "identity",
  "official-market-provenance",
  "odds",
  "base-model-probabilities",
  "candidate-probabilities",
  "devigged-market-probabilities",
  "feature-snapshot",
  "strategy-versions",
  "source-clock",
  "dual-market-decision-record",
  "dual-market-decision-hash",
  "temporal-ordering",
  "atomic-decision-hash",
]);
const GENESIS_HASH = "0".repeat(64);
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const DECISION_OFFSET_MINUTES = 10;
const DECISION_DEADLINE_POLICY_VERSION = "official-cutoff-first-v1";
const CAPTURE_FINALIZATION_POLICY_VERSION = "deadline-evidence-grace-v1";
const CAPTURE_FINALIZATION_GRACE_SECONDS = 120;
const REVIEW_CHECKPOINT_AUDIT_VERSION =
  "candidate-review-checkpoint-prefix-audit-v1";
const REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION =
  "candidate-review-checkpoint-settlement-prefix-v1";
const MIN_FORMAL_SETTLED = 500;
// Kept as a compatibility alias for older audit consumers. Promotion is now
// gated on valid official settlements, never on exclusions or invalid rows.
const MIN_FORMAL_FINALIZED = MIN_FORMAL_SETTLED;
const MIN_WINDOWS = 6;
const MIN_WINNING_WINDOWS = 5;
const MIN_FORMAL_ROWS_PER_WINDOW = 50;
const WINDOW_DAYS = 30;
const WINDOW_COUNT = 6;
const REVIEW_INTERVAL = 100;
const MAX_INVALID_SHARE = 0.05;
const MAX_SINGLE_ATTESTOR_SHARE = 0.3;
const DEFAULT_REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_REGISTRY_LOCK_STALE_MS = 5 * 60_000;
const REGISTRY_LOCK_OWNER_METADATA_GRACE_MS = 1_000;
const REGISTRY_LOCK_VERSION = "candidate-prospective-registry-lock-v2";

const finite = (value, fallback = null) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const parseTime = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const isoTime = (value) => {
  const parsed = parseTime(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const normalizedLeagueText = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
};

// League identity is captured with the pre-match decision. Settlement data is
// deliberately not consulted so later result enrichment cannot rewrite the
// diagnostic stratum of an already-recorded forecast.
const normalizedLeagueForMatch = (match) => {
  const namedCandidates = [
    match?.leagueName,
    match?.league?.name,
    match?.league,
    match?.competitionName,
    match?.competition?.name,
    match?.competition,
    match?.tournamentName,
    match?.tournament?.name,
    match?.tournament,
    match?.leagueNameEn,
  ];
  for (const candidate of namedCandidates) {
    const normalized = normalizedLeagueText(candidate);
    if (normalized) return normalized;
  }
  for (const [prefix, candidate] of [
    ["league-id", match?.leagueId],
    ["competition-id", match?.competitionId],
    ["tournament-id", match?.tournamentId],
  ]) {
    const normalized = normalizedLeagueText(candidate);
    if (normalized) return `${prefix}:${normalized}`;
  }
  return "unknown";
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return Object.is(value, -0) ? 0 : value;
    }
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const sha256 = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const sleepSync = (milliseconds) => {
  const timeout = Math.max(0, Number(milliseconds || 0));
  if (!timeout) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, timeout);
};

const registryLockFileFor = (registryFile) => `${path.resolve(registryFile)}.lock`;

const processStartTimeForPid = (
  pid,
  {
    platform = process.platform,
    readFileSync = fs.readFileSync,
  } = {},
) => {
  const normalizedPid = Number(pid);
  if (platform !== "linux" || !Number.isSafeInteger(normalizedPid) || normalizedPid <= 0) {
    return null;
  }
  try {
    const statText = String(readFileSync(`/proc/${normalizedPid}/stat`, "utf8"));
    // The comm field is parenthesized and may contain spaces or parentheses.
    // Everything after its final ')' starts at proc(5) field 3; starttime is
    // field 22, therefore index 19 in this suffix.
    const commEnd = statText.lastIndexOf(")");
    if (commEnd < 0) return null;
    const fields = statText.slice(commEnd + 1).trim().split(/\s+/u);
    const startTime = String(fields[19] || "").trim();
    return /^\d+$/u.test(startTime) ? startTime : null;
  } catch {
    // /proc is Linux-specific and may be unavailable in constrained
    // containers. PID liveness still fails closed when start time is unknown.
    return null;
  }
};

const registryLockFileIdentity = (stat) => {
  if (!stat) return null;
  const device = stat.dev === undefined || stat.dev === null ? null : String(stat.dev);
  const inode = stat.ino === undefined || stat.ino === null ? null : String(stat.ino);
  if (device === null || inode === null) return null;
  return `${device}:${inode}`;
};

const REGISTRY_LOCK_TRANSIENT_FS_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EBUSY",
]);

const isRegistryLockTransientFsError = (error) => (
  REGISTRY_LOCK_TRANSIENT_FS_ERROR_CODES.has(String(error?.code || ""))
);

const readRegistryLockSnapshot = (
  lockFile,
  {
    statSync = fs.statSync,
    readFileSync = fs.readFileSync,
  } = {},
) => {
  try {
    const statBefore = statSync(lockFile);
    const raw = readFileSync(lockFile, "utf8");
    const statAfter = statSync(lockFile);
    const identityBefore = registryLockFileIdentity(statBefore);
    const identityAfter = registryLockFileIdentity(statAfter);
    if (identityBefore !== identityAfter) return null;
    let metadata = null;
    try {
      metadata = JSON.parse(raw);
    } catch {
      // A legacy/crashed owner may have left partial metadata. The raw digest
      // still lets a reclaimer prove the file did not change under it.
    }
    return {
      identity: identityAfter,
      mtimeMs: statAfter.mtimeMs,
      metadata,
      rawDigest: crypto.createHash("sha256").update(raw).digest("hex"),
    };
  } catch (error) {
    // Windows can expose a short delete-pending interval where stat succeeds
    // but open/read fails with EPERM or EACCES. Treat all of these collision
    // codes as an unavailable snapshot: callers wait and retry, never delete.
    if (isRegistryLockTransientFsError(error)) return null;
    throw error;
  }
};

const sameRegistryLockSnapshot = (left, right) => Boolean(
  left
  && right
  && left.identity !== null
  && left.identity === right.identity
  && left.rawDigest === right.rawDigest
);

const removeRegistryLockIfSnapshotMatches = (lockFile, expectedSnapshot) => {
  const currentSnapshot = readRegistryLockSnapshot(lockFile);
  if (!sameRegistryLockSnapshot(expectedSnapshot, currentSnapshot)) return false;
  try {
    fs.rmSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const removeRegistryLockIfIdentityMatches = (lockFile, expectedIdentity) => {
  const currentSnapshot = readRegistryLockSnapshot(lockFile);
  if (!currentSnapshot || currentSnapshot.identity !== expectedIdentity) return false;
  try {
    fs.rmSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const registryLockMetadataMatchesOwner = (metadata, owner) => Boolean(
  metadata
  && owner
  && metadata.version === REGISTRY_LOCK_VERSION
  && typeof metadata.ownerToken === "string"
  && metadata.ownerToken === owner.ownerToken
  && Number(metadata.pid) === owner.pid
  && (metadata.processStartTime ?? null) === (owner.processStartTime ?? null)
  && path.resolve(String(metadata.registryFile || "")) === owner.registryFile
);

const releaseCandidateProspectiveRegistryLock = (lockFile, owner) => {
  const currentSnapshot = readRegistryLockSnapshot(lockFile);
  if (
    !currentSnapshot
    || currentSnapshot.identity !== owner?.identity
    || !registryLockMetadataMatchesOwner(currentSnapshot.metadata, owner)
  ) {
    return false;
  }
  return removeRegistryLockIfSnapshotMatches(lockFile, currentSnapshot);
};

const registryLockOwnerIsAlive = (lockFile, {
  nowMs = Date.now(),
  metadataGraceMs = REGISTRY_LOCK_OWNER_METADATA_GRACE_MS,
  killProcess = process.kill.bind(process),
  readProcessStartTime = processStartTimeForPid,
} = {}) => {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return null;
  }
  if (nowMs - stat.mtimeMs < Math.max(1, Number(metadataGraceMs || 0))) {
    return null;
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
  const ownerPid = Number(metadata?.pid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
  try {
    killProcess(ownerPid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but is owned by another user. Unknown
    // platform errors must also fail closed instead of deleting a live lock.
    return true;
  }
  const expectedStartTime = typeof metadata?.processStartTime === "string"
    && metadata.processStartTime.trim()
    ? metadata.processStartTime.trim()
    : null;
  if (expectedStartTime !== null) {
    const observedStartTime = readProcessStartTime(ownerPid);
    if (observedStartTime !== null && String(observedStartTime) !== expectedStartTime) {
      // The PID was reused; the process that acquired this lock is gone.
      return false;
    }
  }
  return true;
};

const withCandidateProspectiveRegistryLock = (
  registryFile,
  callback,
  {
    timeoutMs = DEFAULT_REGISTRY_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_REGISTRY_LOCK_STALE_MS,
    retryMs = 50,
    ownerPid = process.pid,
    ownerTokenFactory = () => crypto.randomUUID(),
    readProcessStartTime = processStartTimeForPid,
  } = {},
) => {
  if (typeof callback !== "function") {
    throw new TypeError("candidate prospective registry lock callback is required");
  }
  const resolvedRegistryFile = path.resolve(registryFile);
  const lockFile = registryLockFileFor(resolvedRegistryFile);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const startedAt = Date.now();
  let descriptor = null;
  let owner = null;
  while (descriptor === null) {
    let openedIdentity = null;
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      openedIdentity = registryLockFileIdentity(fs.fstatSync(descriptor));
      const acquiredAt = new Date().toISOString();
      const normalizedOwnerPid = Number(ownerPid);
      if (!Number.isSafeInteger(normalizedOwnerPid) || normalizedOwnerPid <= 0) {
        throw new TypeError("candidate prospective registry lock owner PID is invalid");
      }
      const ownerToken = String(ownerTokenFactory() || "").trim();
      if (!ownerToken) {
        throw new TypeError("candidate prospective registry lock owner token is required");
      }
      const processStartTime = readProcessStartTime(normalizedOwnerPid);
      const metadata = {
        version: REGISTRY_LOCK_VERSION,
        ownerToken,
        pid: normalizedOwnerPid,
        processStartTime: processStartTime === null
          ? null
          : String(processStartTime),
        acquiredAt,
        registryFile: resolvedRegistryFile,
      };
      fs.writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
      owner = {
        ...metadata,
        identity: openedIdentity,
      };
    } catch (error) {
      const lockPathContended = error?.code === "EEXIST"
        || (descriptor === null && isRegistryLockTransientFsError(error));
      if (!lockPathContended) {
        if (descriptor !== null) {
          try {
            fs.closeSync(descriptor);
          } finally {
            descriptor = null;
          }
        }
        try {
          removeRegistryLockIfIdentityMatches(lockFile, openedIdentity);
        } catch {
          // Preserve the original acquisition error; a later contender may
          // safely recover this incomplete lock after its stale threshold.
        }
        throw error;
      }
      descriptor = null;
      let stale = false;
      let ownerAlive = null;
      let observedSnapshot = null;
      try {
        observedSnapshot = readRegistryLockSnapshot(lockFile);
        stale = observedSnapshot
          ? Date.now() - observedSnapshot.mtimeMs > Math.max(1_000, Number(staleMs || 0))
          : false;
        ownerAlive = registryLockOwnerIsAlive(lockFile, { readProcessStartTime });
      } catch (snapshotError) {
        if (snapshotError?.code !== "ENOENT") throw snapshotError;
      }
      // A positively identified live owner is never displaced merely because
      // its lock is old. Unknown/legacy malformed metadata is only reclaimed
      // after the stale threshold; a confirmed dead or PID-reused owner may be
      // reclaimed immediately after the metadata grace period.
      if (ownerAlive === false || (ownerAlive === null && stale)) {
        let reclaimed = false;
        try {
          reclaimed = removeRegistryLockIfSnapshotMatches(lockFile, observedSnapshot);
        } catch {
          // Another process may have replaced or removed the stale lock.
        }
        if (reclaimed) continue;
      }
      if (Date.now() - startedAt >= Math.max(0, Number(timeoutMs || 0))) {
        const lockError = new Error(
          `candidate prospective registry lock timed out: ${lockFile}`,
        );
        lockError.code = "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT";
        lockError.lockFile = lockFile;
        throw lockError;
      }
      sleepSync(Math.max(10, Number(retryMs || 0)));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.closeSync(descriptor); }
    finally {
      try { releaseCandidateProspectiveRegistryLock(lockFile, owner); }
      catch { /* protected work has finished; cleanup remains best effort */ }
    }
  };
  try {
    const result = callback({
      registryFile: resolvedRegistryFile,
      lockFile,
      acquiredAt: owner.acquiredAt,
      ownerToken: owner.ownerToken,
      pid: owner.pid,
      processStartTime: owner.processStartTime,
    });
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) { release(); throw error; }
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const normalizeTriplet = (value) => {
  const parsed = Object.fromEntries(
    OUTCOMES.map((code) => [code, finite(value?.[code], null)]),
  );
  if (OUTCOMES.some((code) => parsed[code] === null || parsed[code] < 0)) return null;
  const total = OUTCOMES.reduce((sum, code) => sum + parsed[code], 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(OUTCOMES.map((code) => [code, round(parsed[code] / total, 12)]));
};

const marketProbabilitiesFromOdds = (odds) => {
  const inverse = Object.fromEntries(
    OUTCOMES.map((code) => [code, 1 / finite(odds?.[code], 0)]),
  );
  if (OUTCOMES.some((code) => !Number.isFinite(inverse[code]) || inverse[code] <= 0)) {
    return null;
  }
  return normalizeTriplet(inverse);
};

const STRICT_OFFICIAL_HAD_EVIDENCE_BLOCKERS = new Set([
  "same-decision-devigged-market-missing",
  "odds-observed-at-missing",
  "odds-received-at-missing",
  "collector-attestation-key-id-missing",
  "collector-attestation-commitment-hash-missing",
  "market-provenance-hash-missing",
]);

const classifyCandidateDecisionEvidence = ({
  had,
  blockers = [],
  atomicEvidenceValid = false,
} = {}) => {
  const normalizedBlockers = [...new Set(
    (Array.isArray(blockers) ? blockers : [])
      .map((value) => String(value || ""))
      .filter(Boolean),
  )].sort();
  const officialHadMarketPresent = Boolean(
    normalizeTriplet(had?.marketProbabilities)
    || marketProbabilitiesFromOdds(had?.odds),
  );
  const strictOfficialMarketEvidenceComplete = officialHadMarketPresent
    && !normalizedBlockers.some((blocker) => (
      STRICT_OFFICIAL_HAD_EVIDENCE_BLOCKERS.has(blocker)
    ));
  const hhadCompanionEvidenceComplete = !normalizedBlockers.some((blocker) => (
    blocker.startsWith("hhad-")
    || blocker.startsWith("dual-market-")
  ));
  const marketState = atomicEvidenceValid
    ? "atomic-ready"
    : !officialHadMarketPresent
      ? "official-had-market-not-published"
      : !strictOfficialMarketEvidenceComplete
        ? "official-had-evidence-incomplete"
        : !hhadCompanionEvidenceComplete
          ? "hhad-companion-evidence-incomplete"
          : normalizedBlockers.length
            ? "atomic-decision-evidence-incomplete"
            : "official-had-evidence-complete";
  return {
    officialHadMarketPresent,
    strictOfficialMarketEvidenceComplete,
    hhadCompanionEvidenceComplete,
    marketState,
    primaryExclusionReason: atomicEvidenceValid || normalizedBlockers.length === 0
      ? null
      : marketState,
  };
};

const temperatureTriplet = (probabilities, temperature) => {
  const normalized = normalizeTriplet(probabilities);
  const parsedTemperature = finite(temperature, null);
  if (!normalized || !(parsedTemperature > 0)) return null;
  const powered = Object.fromEntries(
    OUTCOMES.map((code) => [code, normalized[code] ** (1 / parsedTemperature)]),
  );
  return normalizeTriplet(powered);
};

const logPoolTriplet = (
  marketProbabilities,
  modelProbabilities,
  {
    marketWeight,
    modelWeight,
    temperature = 1,
    outcomeBiasLogOffsets = null,
  } = {},
) => {
  const market = normalizeTriplet(marketProbabilities);
  const model = normalizeTriplet(modelProbabilities);
  const parsedMarketWeight = finite(marketWeight, null);
  const parsedModelWeight = finite(modelWeight, null);
  const parsedTemperature = finite(temperature, null);
  if (
    !market
    || !model
    || parsedMarketWeight === null
    || parsedModelWeight === null
    || !(parsedTemperature > 0)
  ) return null;
  const inverseTemperature = 1 / parsedTemperature;
  return normalizeTriplet(Object.fromEntries(OUTCOMES.map((code) => {
    const logProbability = parsedMarketWeight * Math.log(Math.max(1e-12, market[code]))
      + parsedModelWeight * Math.log(Math.max(1e-12, model[code]));
    const outcomeBias = finite(outcomeBiasLogOffsets?.[code], 0);
    return [code, Math.exp(logProbability * inverseTemperature + outcomeBias)];
  })));
};

const candidateProbabilities = (
  candidate,
  marketProbabilities,
  baseModelProbabilities = null,
) => {
  const weights = candidate?.weights || {};
  const marketWeight = finite(weights.market, null);
  const modelWeight = finite(weights.model, null);
  const temperature = finite(weights.temperature, null);
  if (
    marketWeight !== null
    && modelWeight !== null
    && modelWeight !== 0
    && temperature !== null
  ) {
    return logPoolTriplet(marketProbabilities, baseModelProbabilities, {
      marketWeight,
      modelWeight,
      temperature,
      outcomeBiasLogOffsets: weights.outcomeBiasLogOffsets,
    });
  }
  if (marketWeight === 1 && modelWeight === 0 && temperature !== null) {
    return temperatureTriplet(marketProbabilities, temperature);
  }
  if (candidate?.id === "market-baseline" && marketWeight === 1 && modelWeight === 0) {
    return normalizeTriplet(marketProbabilities);
  }
  return null;
};

// The prospective trial must restart when probability semantics change, but
// not when unrelated orchestration, UI, release or dependency-lock files are
// edited. Bind the revision to the exact pure evaluator functions used by the
// decision record. Function source is deterministic in the deployed CommonJS
// artifact and keeps the implementation commitment independently verifiable.
// Git may check the same blob out as CRLF on Windows and LF on Linux. Function
// source preserves those line endings, so canonicalize them before hashing;
// otherwise a byte-formatting difference can falsely retire an ACTIVE trial.
const canonicalFunctionSource = (fn) => fn.toString().replace(/\r\n?/gu, "\n");

const CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH = sha256({
  version: CANDIDATE_EVALUATOR_VERSION,
  finite: canonicalFunctionSource(finite),
  round: canonicalFunctionSource(round),
  normalizeTriplet: canonicalFunctionSource(normalizeTriplet),
  marketProbabilitiesFromOdds: canonicalFunctionSource(marketProbabilitiesFromOdds),
  temperatureTriplet: canonicalFunctionSource(temperatureTriplet),
  logPoolTriplet: canonicalFunctionSource(logPoolTriplet),
  candidateProbabilities: canonicalFunctionSource(candidateProbabilities),
});

const candidateEvaluatorSemanticHashes = () => ({
  "candidate-probability-evaluator": CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
  "result-input-timeline": resultTimelineSemanticHash(),
});

const candidateDefinition = (candidate) => ({
  id: String(candidate?.id || ""),
  role: String(candidate?.role || ""),
  featureSet: Array.isArray(candidate?.featureSet)
    ? candidate.featureSet.map((value) => String(value))
    : [],
  weights: candidate?.weights || {},
});

const normalizeCandidateImplementation = (implementationCommitment = {}) => ({
  evaluatorVersion: CANDIDATE_EVALUATOR_VERSION,
  commitmentVersion: String(
    implementationCommitment?.commitmentVersion
    || CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION
  ),
  semanticHashes: canonicalize(implementationCommitment?.semanticHashes || {}),
  sourceHashes: canonicalize(implementationCommitment?.sourceHashes || {}),
  dependencyLockHash: String(implementationCommitment?.dependencyLockHash || ""),
});

const buildCandidateCommitment = (
  candidate,
  implementationCommitment = {},
) => {
  const definition = candidateDefinition(candidate);
  const implementation = normalizeCandidateImplementation(
    implementationCommitment,
  );
  const candidateSpecHash = sha256({ definition, implementation });
  return {
    baseCandidateId: definition.id,
    candidateRevisionId: `${definition.id}@${candidateSpecHash.slice(0, 16)}`,
    candidateSpecHash,
    definition,
    implementation,
  };
};

const candidateInventory = (candidates, implementationCommitment = {}) => {
  const entries = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => buildCandidateCommitment(candidate, implementationCommitment))
    .filter((entry) => entry.baseCandidateId)
    .sort((left, right) => left.candidateRevisionId.localeCompare(right.candidateRevisionId));
  const definitions = (Array.isArray(candidates) ? candidates : [])
    .map(candidateDefinition)
    .filter((entry) => entry.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    count: entries.length,
    hash: sha256(definitions),
    commitmentHash: sha256(entries),
    definitions,
    entries,
  };
};

const eventHashFor = (ledgerId, sequence, previousHash, event) => sha256({
  ledgerId,
  sequence,
  previousHash,
  event,
});

const appendEvent = (ledger, event) => {
  const sequence = ledger.events.length + 1;
  const previousHash = ledger.events.at(-1)?.eventHash || GENESIS_HASH;
  const canonicalEvent = canonicalize(event);
  const eventHash = eventHashFor(ledger.ledgerId, sequence, previousHash, canonicalEvent);
  ledger.events.push({
    sequence,
    previousHash,
    eventHash,
    ...canonicalEvent,
  });
  ledger.rootHash = eventHash;
  return ledger.events.at(-1);
};

const verifyLedger = (ledger, { verifyReviewCheckpoints = true } = {}) => {
  const blockers = [];
  if (!ledger || ledger.version !== LEDGER_VERSION || !Array.isArray(ledger.events)) {
    return { valid: false, blockers: ["ledger-shape-invalid"] };
  }
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < ledger.events.length; index += 1) {
    const event = ledger.events[index];
    const sequence = index + 1;
    const {
      eventHash,
      previousHash: declaredPreviousHash,
      sequence: declaredSequence,
      ...payload
    } = event || {};
    if (declaredSequence !== sequence) blockers.push(`event-${sequence}-sequence-invalid`);
    if (declaredPreviousHash !== previousHash) blockers.push(`event-${sequence}-previous-hash-invalid`);
    const expectedHash = eventHashFor(ledger.ledgerId, sequence, previousHash, payload);
    if (eventHash !== expectedHash) blockers.push(`event-${sequence}-hash-invalid`);
    previousHash = eventHash;
  }
  if ((ledger.events.at(-1)?.eventHash || GENESIS_HASH) !== ledger.rootHash) {
    blockers.push("root-hash-invalid");
  }
  if (sha256(ledger.header) !== ledger.headerHash) blockers.push("header-hash-invalid");
  if (ledger?.header?.gateSpec?.decisionRecordVersion === DECISION_RECORD_VERSION) {
    for (const event of ledger.events.filter((row) => row?.type === "decision")) {
      const prefix = `event-${event.sequence}`;
      blockers.push(...atomicDecisionRecordBlockers(event)
        .map((blocker) => `${prefix}-${blocker}`));
    }
  }
  // A production ledger can contain thousands of immutable decisions. Comparing
  // each cohort event with every prior event makes every heartbeat O(n^2) and
  // can exhaust the bounded pre-swap capture window. Index the exact identity
  // relation used by sameCohortIdentity instead: normalized kickoff + market +
  // every accepted id alias. This preserves duplicate detection while making
  // verification linear in the number of events and aliases.
  const cohortIdentityKeys = new Set();
  for (const event of ledger.events.filter((row) => (
    row?.type === "decision" || row?.type === "exclusion"
  ))) {
    const kickoffAt = cohortKickoffFor(event);
    const market = String(event?.market || "HAD").trim().toUpperCase();
    const keys = kickoffAt
      ? [...identityValues(event)].map((identity) => JSON.stringify([kickoffAt, market, identity]))
      : [];
    if (keys.some((key) => cohortIdentityKeys.has(key))) {
      blockers.push(`event-${event.sequence}-duplicate-cohort-key`);
    }
    for (const key of keys) cohortIdentityKeys.add(key);
  }
  const decisionHashes = new Map(
    ledger.events
      .filter((event) => event?.type === "decision")
      .map((event) => [event.eventHash, event]),
  );
  const settledDecisionHashes = new Set();
  for (const event of ledger.events.filter((row) => row?.type === "settlement")) {
    const decision = decisionHashes.get(event.decisionEventHash);
    if (!decision) blockers.push(`event-${event.sequence}-orphan-settlement`);
    if (settledDecisionHashes.has(event.decisionEventHash)) {
      blockers.push(`event-${event.sequence}-duplicate-settlement`);
    }
    settledDecisionHashes.add(event.decisionEventHash);
    if (decision && event.phase !== decision.phase) {
      blockers.push(`event-${event.sequence}-settlement-phase-mismatch`);
    }
    if (ledger?.header?.gateSpec?.settlementRecordVersion
        === SETTLEMENT_RECORD_VERSION) {
      blockers.push(...settlementRecordBlockers(event, decision)
        .map((blocker) => `event-${event.sequence}-${blocker}`));
    }
  }
  if (
    verifyReviewCheckpoints
    && ledger?.header?.gateSpec?.minimumFormalSettled === MIN_FORMAL_SETTLED
  ) {
    for (const event of ledger.events.filter((row) => row?.type === "review")) {
      const checkpoint = Number(
        event.checkpointSettled ?? event.checkpointFinalized,
      );
      const dataset = formalSettledReviewDataset(ledger, checkpoint);
      if (event.datasetHashVersion !== "candidate-formal-settled-pairs-v1") {
        blockers.push(`event-${event.sequence}-review-dataset-version-invalid`);
      }
      if (!Number.isInteger(checkpoint)
          || checkpoint < MIN_FORMAL_SETTLED
          || (checkpoint - MIN_FORMAL_SETTLED) % REVIEW_INTERVAL !== 0) {
        blockers.push(`event-${event.sequence}-review-checkpoint-invalid`);
      }
      if (Number(event.datasetRows) !== checkpoint || dataset.length !== checkpoint) {
        blockers.push(`event-${event.sequence}-review-dataset-row-count-invalid`);
      }
      if (event.datasetHash !== sha256(dataset)) {
        blockers.push(`event-${event.sequence}-review-dataset-hash-invalid`);
      }
      if (event.checkpointAuditVersion !== undefined) {
        const evidence = buildReviewCheckpointEvidence(ledger, checkpoint, {
          totalCandidatesEverTested: event.totalCandidatesEverTested,
        });
        if (event.checkpointAuditVersion !== REVIEW_CHECKPOINT_AUDIT_VERSION) {
          blockers.push(`event-${event.sequence}-review-audit-version-invalid`);
        }
        if (
          event.checkpointSourceBoundaryVersion
          !== REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION
        ) {
          blockers.push(`event-${event.sequence}-review-source-boundary-version-invalid`);
        }
        if (!evidence.complete) {
          blockers.push(`event-${event.sequence}-review-source-prefix-incomplete`);
        } else {
          if (
            JSON.stringify(canonicalize(event.checkpointSourceBoundary))
            !== JSON.stringify(canonicalize(evidence.sourceBoundary))
          ) {
            blockers.push(`event-${event.sequence}-review-source-boundary-invalid`);
          }
          if (event.checkpointSourceBoundaryHash !== evidence.sourceBoundaryHash) {
            blockers.push(`event-${event.sequence}-review-source-boundary-hash-invalid`);
          }
          if (
            JSON.stringify(canonicalize(event.checkpointAudit))
            !== JSON.stringify(canonicalize(evidence.audit))
          ) {
            blockers.push(`event-${event.sequence}-review-audit-mismatch`);
          }
          if (event.checkpointAuditHash !== evidence.auditHash) {
            blockers.push(`event-${event.sequence}-review-audit-hash-invalid`);
          }
          if (event.passed !== evidence.audit.promotionReviewReady) {
            blockers.push(`event-${event.sequence}-review-pass-mismatch`);
          }
          if (
            JSON.stringify(event.blockers || [])
            !== JSON.stringify(evidence.audit.blockers || [])
          ) {
            blockers.push(`event-${event.sequence}-review-blockers-mismatch`);
          }
        }
      }
    }
  }
  return { valid: blockers.length === 0, blockers };
};

const verifyRegistry = (registry) => {
  if (!registry) return { valid: true, blockers: [] };
  const blockers = [];
  if (registry.version !== REGISTRY_VERSION || !Array.isArray(registry.ledgers)) {
    return { valid: false, blockers: ["registry-shape-invalid"] };
  }
  const ids = new Set();
  for (const ledger of registry.ledgers) {
    if (ids.has(ledger?.ledgerId)) blockers.push(`duplicate-ledger-id:${ledger?.ledgerId || "missing"}`);
    ids.add(ledger?.ledgerId);
    const verification = verifyLedger(ledger);
    blockers.push(...verification.blockers.map((blocker) => `${ledger?.ledgerId || "unknown"}:${blocker}`));
  }
  if (registry.activeLedgerId && !ids.has(registry.activeLedgerId)) {
    blockers.push("active-ledger-missing");
  }
  return { valid: blockers.length === 0, blockers };
};

const fixedGateSpec = () => ({
  primaryEndpoints: [
    "paired-log-loss-improvement-vs-same-decision-devigged-market",
    "paired-brier-improvement-vs-same-decision-devigged-market",
  ],
  minimumFormalSettled: MIN_FORMAL_SETTLED,
  minimumFormalFinalized: MIN_FORMAL_FINALIZED,
  minimumIndependentCalendarWindows: MIN_WINDOWS,
  minimumWinningCalendarWindows: MIN_WINNING_WINDOWS,
  minimumFormalRowsPerCalendarWindow: MIN_FORMAL_ROWS_PER_WINDOW,
  windowDays: WINDOW_DAYS,
  windowCount: WINDOW_COUNT,
  windowEvaluationPolicy:
    "six preregistered non-overlapping chronological windows; a winning window must improve both Brier and Log Loss versus the same-match devigged market; at least five windows must win",
  reviewFirstSettled: MIN_FORMAL_SETTLED,
  reviewFirstFinalized: MIN_FORMAL_FINALIZED,
  reviewInterval: REVIEW_INTERVAL,
  familyWiseAlpha: 0.05,
  requireBothFamilyWiseAdjustedLowerBoundsAboveZero: true,
  maximumInvalidShare: MAX_INVALID_SHARE,
  maximumSingleAttestorShare: MAX_SINGLE_ATTESTOR_SHARE,
  decisionOffsetMinutes: DECISION_OFFSET_MINUTES,
  decisionDeadlinePolicyVersion: DECISION_DEADLINE_POLICY_VERSION,
  decisionDeadlinePolicy:
    "earliest valid official predictionMeta.cutoffTime, buyEndTime or cutoffTime; kickoff offset is fallback only",
  captureFinalizationPolicyVersion: CAPTURE_FINALIZATION_POLICY_VERSION,
  captureFinalizationGraceSeconds: CAPTURE_FINALIZATION_GRACE_SECONDS,
  captureFinalizationPolicy:
    "wait for the fixed post-deadline persistence grace, then admit only evidence whose observation, receipt and decision clocks are no later than the immutable decision deadline",
  decisionRecordVersion: DECISION_RECORD_VERSION,
  decisionRecordPolicy:
    "each admitted decision embeds canonical odds, frozen base-model, candidate and market probabilities, feature snapshot, source clock and strategy versions in one hash-chained event",
  settlementRecordVersion: SETTLEMENT_RECORD_VERSION,
  settlementRecordPolicy:
    "each valid settlement binds the official Sporttery result identity, score, outcome and observation clock to its immutable decision event",
  admissionMarket: "HAD",
  admissionSourceClass: "official",
  backfillPolicy: "forbidden",
  missingFieldPolicy: "count-in-denominator-as-invalid",
  candidateMutationPolicy: "new-candidate-revision-id-and-new-ledger",
  activeCandidateSelectionPolicy:
    "once activated, retrospective ranking changes cannot replace the active prospective candidate; a versioned nomination-policy change may refreeze only before any post-activation cohort or review evidence exists, and after evidence only a changed or removed frozen implementation revision starts a new ledger",
  reportPolicy: "intermediate reports are observational; promotion review only uses frozen checkpoints",
});

const normalizeNominationPolicyCommitment = (value) => {
  if (!value || typeof value !== "object" || !String(value.version || "").trim()) {
    return null;
  }
  return canonicalize(value);
};

const nominationPolicyHashFor = (value) => {
  const commitment = normalizeNominationPolicyCommitment(value);
  return commitment ? sha256(commitment) : null;
};

const createRegistry = (evaluatedAt) => ({
  version: REGISTRY_VERSION,
  createdAt: isoTime(evaluatedAt),
  updatedAt: isoTime(evaluatedAt),
  activeLedgerId: null,
  candidateRegistry: [],
  ledgers: [],
});

const createLedger = ({
  commitment,
  inventory,
  evaluatedAt,
  totalCandidatesEverTested,
  nominationPolicyCommitment = null,
}) => {
  const frozenAt = isoTime(evaluatedAt);
  const gateSpec = fixedGateSpec();
  const normalizedNominationPolicyCommitment =
    normalizeNominationPolicyCommitment(nominationPolicyCommitment);
  const header = canonicalize({
    version: LEDGER_VERSION,
    candidateRevisionId: commitment.candidateRevisionId,
    baseCandidateId: commitment.baseCandidateId,
    candidateSpecHash: commitment.candidateSpecHash,
    candidateDefinition: commitment.definition,
    candidateImplementation: commitment.implementation,
    frozenAt,
    gateRegisteredAt: frozenAt,
    retrospectiveSelectionDisclosed: true,
    retrospectiveSelectionNote:
      "The candidate was selected after retrospective inspection; only post-activation formal rows can confirm it.",
    inventoryHashAtFreeze: inventory.hash,
    inventoryCommitmentHashAtFreeze: inventory.commitmentHash,
    candidateCountAtFreeze: inventory.count,
    totalCandidatesEverTestedAtFreeze: totalCandidatesEverTested,
    nominationPolicyCommitment: normalizedNominationPolicyCommitment,
    nominationPolicyHash: nominationPolicyHashFor(
      normalizedNominationPolicyCommitment,
    ),
    gateSpec,
    gateSpecHash: sha256(gateSpec),
  });
  const ledgerId = `candidate-${sha256(header).slice(0, 24)}`;
  const ledger = {
    version: LEDGER_VERSION,
    ledgerId,
    header,
    headerHash: sha256(header),
    events: [],
    rootHash: GENESIS_HASH,
  };
  appendEvent(ledger, {
    type: "freeze",
    recordedAt: frozenAt,
    candidateRevisionId: commitment.candidateRevisionId,
    candidateSpecHash: commitment.candidateSpecHash,
    inventoryHashAtFreeze: inventory.hash,
    totalCandidatesEverTested,
    state: "FROZEN",
    onlineEffect: false,
  });
  appendEvent(ledger, {
    type: "shadow-start",
    recordedAt: frozenAt,
    candidateRevisionId: commitment.candidateRevisionId,
    state: "SHADOW",
    samplesBeforeFormalActivation: "observational-only",
    onlineEffect: false,
  });
  return ledger;
};

const ledgerEvent = (ledger, type) => ledger.events.find((event) => event.type === type) || null;
const ledgerEvents = (ledger, type) => ledger.events.filter((event) => event.type === type);
const ledgerRetired = (ledger) => Boolean(ledgerEvent(ledger, "retirement"));
const ledgerActivation = (ledger) => ledgerEvent(ledger, "activation");

// An implementation-only revision of a previously activated fixed trial is
// still that trial's hypothesis, even while its NEW evidence window is SHADOW.
// Follow existing immutable retirement links; never inherit activation, rows,
// eligibility, or a lock across a changed definition/gate/nomination policy.
const hasActivatedTrialLineage = (registry, ledger) => {
  const visited = new Set();
  let current = ledger;
  while (current && !visited.has(current.ledgerId)) {
    visited.add(current.ledgerId);
    if (ledgerActivation(current)) return true;
    const predecessors = registry.ledgers.filter((prior) => prior.ledgerId !== current.ledgerId
      && prior.header.gateSpecHash === current.header.gateSpecHash
      && prior.header.nominationPolicyHash === current.header.nominationPolicyHash
      && sha256(prior.header.candidateDefinition) === sha256(current.header.candidateDefinition)
      && prior.events.some((event) => event.type === "retirement"
        && event.reason === "active-candidate-implementation-revision-changed-or-removed"
        && event.replacementCandidateRevisionId === current.header.candidateRevisionId
        && event.recordedAt === current.header.frozenAt && event.onlineEffect === false));
    if (predecessors.length !== 1) return false;
    current = predecessors[0];
  }
  return false;
};
const PROSPECTIVE_EVIDENCE_EVENT_TYPES = new Set([
  "decision",
  "exclusion",
  "settlement",
  "review",
  "promotion",
]);

const postActivationEvidenceEvents = (ledger) => {
  const activation = ledgerActivation(ledger);
  if (!activation) return [];
  return ledger.events.filter((event) => (
    event.sequence > activation.sequence
    && PROSPECTIVE_EVIDENCE_EVENT_TYPES.has(event.type)
  ));
};

const GATE_SPEC_RESET_AUTHORIZATION_VERSION =
  "candidate-prospective-gate-reset-authorization-v1";

const candidateGateSpecCompatibility = ({
  priorRegistry = null,
  expectedGateSpec = fixedGateSpec(),
  resetAuthorization = "",
} = {}) => {
  const active = priorRegistry?.ledgers?.find(
    (ledger) => ledger?.ledgerId === priorRegistry?.activeLedgerId,
  ) || null;
  const previousGateSpecHash = active?.header?.gateSpecHash || null;
  const replacementGateSpecHash = sha256(expectedGateSpec);
  const postActivationEvidenceCount = active
    ? postActivationEvidenceEvents(active).length
    : 0;
  const resetRequired = Boolean(
    active
    && !ledgerRetired(active)
    && previousGateSpecHash
    && previousGateSpecHash !== replacementGateSpecHash
  );
  const expectedResetAuthorization = resetRequired
    ? [
        GATE_SPEC_RESET_AUTHORIZATION_VERSION,
        previousGateSpecHash,
        replacementGateSpecHash,
      ].join(":")
    : null;
  const resetAuthorized = Boolean(
    resetRequired
    && postActivationEvidenceCount > 0
    && String(resetAuthorization || "").trim() === expectedResetAuthorization
  );
  const blocksAutomaticReset = Boolean(
    resetRequired
    && postActivationEvidenceCount > 0
    && !resetAuthorized
  );
  return {
    version: GATE_SPEC_RESET_AUTHORIZATION_VERSION,
    ok: !blocksAutomaticReset,
    resetRequired,
    resetAuthorized,
    activeLedgerId: active?.ledgerId || null,
    candidateRevisionId: active?.header?.candidateRevisionId || null,
    previousGateSpecHash,
    replacementGateSpecHash,
    postActivationEvidenceCount,
    expectedResetAuthorization,
    blockers: blocksAutomaticReset
      ? ["active-gate-spec-reset-requires-explicit-authorization"]
      : [],
  };
};

const ledgerState = (ledger) => {
  if (ledgerRetired(ledger)) return "RETIRED";
  if (ledgerEvent(ledger, "promotion")) return "PROMOTED";
  if (ledgerActivation(ledger)) return "ACTIVE";
  return "SHADOW";
};

const buildWindowBoundaries = (activationAt) => {
  const start = parseTime(activationAt);
  if (start === null) return [];
  const duration = WINDOW_DAYS * 86_400_000;
  return Array.from({ length: WINDOW_COUNT }, (_, index) => ({
    index: index + 1,
    startAt: new Date(start + index * duration).toISOString(),
    endAt: new Date(start + (index + 1) * duration).toISOString(),
  }));
};

const identityValues = (value) => new Set([
  value?.id,
  value?.matchId,
  value?.sourceMatchId,
  String(value?.id || "").replace(/^sporttery_/, ""),
  String(value?.matchId || "").replace(/^sporttery_/, ""),
  String(value?.sourceMatchId || "").replace(/^sporttery_/, ""),
].map((item) => String(item || "").trim()).filter(Boolean));

const identitiesMatch = (left, right) => {
  const leftValues = identityValues(left);
  const rightValues = identityValues(right);
  return [...leftValues].some((value) => rightValues.has(value));
};

const cohortKickoffFor = (value) => isoTime(
  value?.kickoffAt
  || value?.kickoffTime
  || value?.matchDate
  || value?.kickoff,
);

const sameCohortIdentity = (left, right) => {
  const leftKickoff = cohortKickoffFor(left);
  const rightKickoff = cohortKickoffFor(right);
  const leftMarket = String(left?.market || "HAD").trim().toUpperCase();
  const rightMarket = String(right?.market || "HAD").trim().toUpperCase();
  return Boolean(
    leftKickoff
    && rightKickoff
    && leftKickoff === rightKickoff
    && leftMarket === rightMarket
    && identitiesMatch(left, right)
  );
};

const kickoffFor = (match) => isoTime(match?.kickoffTime || match?.matchDate);

const decisionDeadlineFor = (match) => {
  const kickoffAt = kickoffFor(match);
  const kickoffMs = parseTime(kickoffAt);
  if (!Number.isFinite(kickoffMs)) return null;
  const fallbackMs = kickoffMs - DECISION_OFFSET_MINUTES * 60_000;
  const candidates = [
    {
      source: "prediction-meta-cutoff-time",
      value: match?.predictionMeta?.cutoffTime,
    },
    {
      source: "buy-end-time",
      value: match?.buyEndTime,
    },
    {
      source: "match-cutoff-time",
      value: match?.cutoffTime,
    },
  ]
    .map((candidate) => ({
      ...candidate,
      at: isoTime(candidate.value),
      millis: parseTime(candidate.value),
    }))
    .filter((candidate) => (
      Number.isFinite(candidate.millis)
      && candidate.millis <= kickoffMs
    ))
    .sort((left, right) => left.millis - right.millis);
  const official = candidates[0] || null;
  const millis = Math.min(fallbackMs, official?.millis ?? fallbackMs);
  return {
    version: DECISION_DEADLINE_POLICY_VERSION,
    value: new Date(millis).toISOString(),
    millis,
    source: official && official.millis <= fallbackMs
      ? official.source
      : "kickoff-offset-fallback",
    officialCutoffAt: official?.at || null,
    kickoffOffsetAt: new Date(fallbackMs).toISOString(),
    kickoffAt,
    offsetMinutes: DECISION_OFFSET_MINUTES,
  };
};

const captureFinalizationFor = (match) => {
  const deadline = decisionDeadlineFor(match);
  if (!deadline) return null;
  const millis = deadline.millis + CAPTURE_FINALIZATION_GRACE_SECONDS * 1000;
  return {
    version: CAPTURE_FINALIZATION_POLICY_VERSION,
    value: new Date(millis).toISOString(),
    millis,
    decisionDeadlineAt: deadline.value,
    graceSeconds: CAPTURE_FINALIZATION_GRACE_SECONDS,
  };
};

const decisionSnapshotFor = (snapshot) => snapshot?.decisionSnapshot || null;

const snapshotTimes = (snapshot) => {
  const decision = decisionSnapshotFor(snapshot);
  return {
    capturedAt: isoTime(decision?.capturedAt || snapshot?.capturedAt),
    firstSeenAt: isoTime(snapshot?.firstSeenAt),
    decisionAt: isoTime(decision?.decisionAt),
  };
};

const selectSnapshotAtDeadline = ({
  match,
  snapshots,
  frozenAt,
  deadlineAt,
}) => {
  const frozenMs = parseTime(frozenAt);
  const deadlineMs = parseTime(deadlineAt);
  const candidates = (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => identitiesMatch(match, snapshot))
    .map((snapshot) => ({ snapshot, times: snapshotTimes(snapshot) }))
    .filter(({ snapshot, times }) => {
      const decision = decisionSnapshotFor(snapshot);
      const capturedMs = parseTime(times.capturedAt);
      const firstSeenMs = parseTime(times.firstSeenAt);
      const decisionMs = parseTime(times.decisionAt);
      return decision?.version === "candidate-decision-snapshot-v2"
        && decision?.clockAudit?.eligible === true
        && Number.isFinite(capturedMs)
        && Number.isFinite(firstSeenMs)
        && Number.isFinite(decisionMs)
        && capturedMs >= frozenMs
        && firstSeenMs >= frozenMs
        && capturedMs <= deadlineMs
        && firstSeenMs <= deadlineMs
        && decisionMs <= deadlineMs;
    })
    .sort((left, right) => (
      parseTime(right.times.capturedAt) - parseTime(left.times.capturedAt)
      || parseTime(right.times.firstSeenAt) - parseTime(left.times.firstSeenAt)
      || sha256(right.snapshot).localeCompare(sha256(left.snapshot))
    ));
  if (!candidates.length) return { snapshot: null, blockers: ["eligible-deadline-snapshot-missing"] };
  const latestMs = parseTime(candidates[0].times.capturedAt);
  const tied = candidates.filter((entry) => parseTime(entry.times.capturedAt) === latestMs);
  if (tied.length > 1) {
    const hashes = new Set(tied.map((entry) => sha256(entry.snapshot)));
    if (hashes.size > 1) return { snapshot: null, blockers: ["conflicting-latest-snapshot-tie"] };
  }
  return { snapshot: candidates[0].snapshot, blockers: [] };
};

const resultOutcome = (match) => {
  const home = finite(match?.scoreHome, null);
  const away = finite(match?.scoreAway, null);
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;
  return home > away ? "1" : home < away ? "2" : "X";
};

const officialResultState = (match) => {
  const provenance = buildResultProvenance(match);
  const provider = String(provenance?.provider || "").toLowerCase();
  const observedAt = isoTime(provenance?.observedAt);
  const kickoffAt = isoTime(match?.kickoffTime ?? match?.kickoff);
  const matchSourceId = canonicalSourceMatchId(
    match?.sourceMatchId ?? match?.matchId ?? match?.id,
  );
  const resultSourceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const matchEventVersion = eventVersionOf(match);
  const resultEventVersion = eventVersionOf({
    eventVersion: provenance?.eventVersion,
    kickoffTime: provenance?.kickoffTime,
  });
  const scoreConsistent = Number.isInteger(provenance?.scoreHome)
    && Number.isInteger(provenance?.scoreAway)
    && provenance.scoreHome === match?.scoreHome
    && provenance.scoreAway === match?.scoreAway;
  const eligible = Boolean(
    isOfficialSportteryFinal(match)
    && provenance
    && provider === "sporttery"
    && provenance.official === true
    && provenance.trusted === true
    && provenance.promotionEligible === true
    && provenance.resultObservationFallback === false
    && provenance.eventVersionConsistent === true
    && matchSourceId
    && resultSourceId === matchSourceId
    && matchEventVersion
    && resultEventVersion === matchEventVersion
    && observedAt
    && kickoffAt
    && parseTime(observedAt) >= parseTime(kickoffAt)
    && scoreConsistent
  );
  const settlementEvidence = canonicalize({
    version: SETTLEMENT_RECORD_VERSION,
    provider: provider || null,
    sourceMatchId: resultSourceId || null,
    eventVersion: resultEventVersion,
    kickoffAt,
    observedAt,
    scoreHome: Number.isInteger(provenance?.scoreHome)
      ? provenance.scoreHome
      : null,
    scoreAway: Number.isInteger(provenance?.scoreAway)
      ? provenance.scoreAway
      : null,
    provenanceVersion: provenance?.version || null,
    observationSource: provenance?.observationSource || null,
    official: provenance?.official === true,
    trusted: provenance?.trusted === true,
    promotionEligible: provenance?.promotionEligible === true,
    resultObservationFallback: provenance?.resultObservationFallback === true,
  });
  return {
    eligible,
    observedAt,
    provider: provider || null,
    eventVersion: resultEventVersion,
    sourceMatchId: resultSourceId || null,
    scoreHome: settlementEvidence.scoreHome,
    scoreAway: settlementEvidence.scoreAway,
    settlementEvidence,
    provenanceHash: sha256(settlementEvidence),
  };
};

const selectOfficialSettlementMatch = (matches, decision) => {
  const matching = (Array.isArray(matches) ? matches : [])
    .filter((row) => (
      identitiesMatch(row, decision)
      && kickoffFor(row) === decision?.kickoffAt
    ))
    .map((match) => ({
      match,
      result: officialResultState(match),
    }))
    .filter((entry) => entry.result.eligible === true);
  if (!matching.length) return null;
  const scoreKeys = new Set(matching.map(({ result }) => (
    `${result.scoreHome}:${result.scoreAway}`
  )));
  // Two independently trusted rows for the same event must agree on the
  // official score. Never let array order choose between conflicting finals.
  if (scoreKeys.size !== 1) return null;
  return matching
    .sort((left, right) => (
      (parseTime(right.result.observedAt) || 0)
      - (parseTime(left.result.observedAt) || 0)
      || sha256(right.result.settlementEvidence)
        .localeCompare(sha256(left.result.settlementEvidence))
    ))[0].match;
};

const settlementEvidenceFromEvent = (event) => canonicalize({
  version: event?.settlementRecordVersion || null,
  provider: event?.resultProvider || null,
  sourceMatchId: canonicalSourceMatchId(event?.resultSourceMatchId),
  eventVersion: event?.resultEventVersion || null,
  kickoffAt: isoTime(event?.kickoffAt),
  observedAt: isoTime(event?.resultObservedAt),
  scoreHome: Number.isInteger(event?.scoreHome) ? event.scoreHome : null,
  scoreAway: Number.isInteger(event?.scoreAway) ? event.scoreAway : null,
  provenanceVersion: event?.resultProvenanceVersion || null,
  observationSource: event?.resultObservationSource || null,
  official: event?.resultOfficial === true,
  trusted: event?.resultTrusted === true,
  promotionEligible: event?.resultPromotionEligible === true,
  resultObservationFallback: event?.resultObservationFallback === true,
});

const settlementRecordBlockers = (event, decision) => {
  const blockers = [];
  const expectedSourceMatchId = canonicalSourceMatchId(decision?.sourceMatchId);
  const resultSourceMatchId = canonicalSourceMatchId(event?.resultSourceMatchId);
  const kickoffAt = isoTime(event?.kickoffAt);
  const observedAt = isoTime(event?.resultObservedAt);
  const scoreHome = finite(event?.scoreHome, null);
  const scoreAway = finite(event?.scoreAway, null);
  const actual = Number.isInteger(scoreHome) && Number.isInteger(scoreAway)
    ? (scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X")
    : null;
  if (event?.settlementRecordVersion !== SETTLEMENT_RECORD_VERSION) {
    blockers.push("settlement-record-version-invalid");
  }
  if (!decision) blockers.push("settlement-decision-missing");
  if (event?.valid !== true) blockers.push("settlement-validity-invalid");
  if (event?.phase !== decision?.phase) blockers.push("settlement-phase-mismatch");
  if (event?.candidateRevisionId !== decision?.candidateRevisionId) {
    blockers.push("settlement-candidate-revision-mismatch");
  }
  if (String(event?.matchId || "") !== String(decision?.matchId || "")) {
    blockers.push("settlement-match-id-mismatch");
  }
  if (!expectedSourceMatchId || resultSourceMatchId !== expectedSourceMatchId) {
    blockers.push("settlement-source-match-id-mismatch");
  }
  if (event?.market !== "HAD" || decision?.market !== "HAD") {
    blockers.push("settlement-market-invalid");
  }
  if (!kickoffAt || kickoffAt !== isoTime(decision?.kickoffAt)) {
    blockers.push("settlement-kickoff-mismatch");
  }
  if (!observedAt || !kickoffAt || parseTime(observedAt) < parseTime(kickoffAt)) {
    blockers.push("settlement-observation-clock-invalid");
  }
  if (event?.resultProvider !== "sporttery") {
    blockers.push("settlement-provider-invalid");
  }
  if (!event?.resultEventVersion
      || isoTime(event.resultEventVersion) !== isoTime(decision?.kickoffAt)) {
    blockers.push("settlement-event-version-mismatch");
  }
  if (!Number.isInteger(scoreHome)
      || !Number.isInteger(scoreAway)
      || scoreHome < 0
      || scoreAway < 0) {
    blockers.push("settlement-score-invalid");
  }
  if (!actual || event?.actual !== actual || !OUTCOMES.includes(event?.actual)) {
    blockers.push("settlement-outcome-score-mismatch");
  }
  if (event?.resultOfficial !== true
      || event?.resultTrusted !== true
      || event?.resultPromotionEligible !== true
      || event?.resultObservationFallback !== false) {
    blockers.push("settlement-result-provenance-ineligible");
  }
  if (!event?.resultProvenanceHash
      || event.resultProvenanceHash !== sha256(settlementEvidenceFromEvent(event))) {
    blockers.push("settlement-provenance-hash-invalid");
  }
  return [...new Set(blockers)];
};

const trustedCollectorCountFor = (snapshot, fallback = 1) => {
  const decision = decisionSnapshotFor(snapshot);
  const declared = finite(
    decision?.markets?.HAD?.provenance?.strict?.trustedCollectorCount
    ?? decision?.clockAudit?.trustedCollectorCount,
    null,
  );
  return Number.isInteger(declared) && declared >= 0
    ? declared
    : Math.max(0, Number(fallback || 0));
};

const featureSnapshotFor = (snapshot, decision) => {
  const value = snapshot?.featureSnapshot || decision?.featureSnapshot || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return canonicalize(value);
};

const strategyVersionsFor = ({
  ledger,
  snapshot,
  decision,
  featureSnapshot,
}) => canonicalize({
  candidateRevisionId: ledger?.header?.candidateRevisionId || null,
  candidateEvaluatorVersion:
    ledger?.header?.candidateImplementation?.evaluatorVersion || null,
  predictionPolicyVersion:
    decision?.policyVersion
    || decision?.evidenceReplayPolicy?.predictionPolicyVersion
    || snapshot?.policyVersion
    || null,
  promptVersion:
    decision?.promptVersion
    || decision?.evidenceReplayPolicy?.promptVersion
    || snapshot?.promptVersion
    || null,
  modelVersion:
    decision?.modelVersion
    || decision?.evidenceReplayPolicy?.modelVersion
    || featureSnapshot?.modelVersion
    || snapshot?.modelVersion
    || snapshot?.probabilityModelVersion
    || null,
  calibrationVersion:
    decision?.calibrationVersion
    || decision?.evidenceReplayPolicy?.calibrationVersion
    || featureSnapshot?.calibrationVersion
    || snapshot?.calibrationVersion
    || null,
  featureSnapshotVersion: featureSnapshot?.version || null,
  evidenceReplayVersion: decision?.evidenceReplayPolicy?.evidenceReplayVersion || null,
  multiFactorPolicyVersion:
    decision?.evidenceReplayPolicy?.multiFactorPolicyVersion || null,
  unifiedPosteriorVersion:
    decision?.evidenceReplayPolicy?.unifiedPosteriorVersion || null,
});

const sourceClockFor = ({
  snapshot,
  decision,
  featureSnapshot,
  times,
  observedAt,
  receivedAt,
}) => canonicalize({
  sourceCycleId:
    decision?.sourceCycleId
    || decision?.clockAudit?.sourceCycleId
    || featureSnapshot?.sourceCycleId
    || snapshot?.sourceCycleId
    || null,
  snapshotCapturedAt: times?.capturedAt || null,
  snapshotFirstSeenAt: times?.firstSeenAt || null,
  decisionAt: times?.decisionAt || null,
  featureSnapshotCapturedAt: isoTime(featureSnapshot?.capturedAt),
  modelGeneratedAt: isoTime(
    decision?.sourceTimestamps?.modelGeneratedAt
    || featureSnapshot?.modelGeneratedAt
    || snapshot?.modelGeneratedAt,
  ),
  baseModelGeneratedAt: isoTime(
    decision?.sourceTimestamps?.baseModelGeneratedAt
    || snapshot?.baseModelGeneratedAt,
  ),
  unifiedPosteriorGeneratedAt: isoTime(
    decision?.sourceTimestamps?.unifiedPosteriorGeneratedAt
    || snapshot?.unifiedPosteriorGeneratedAt,
  ),
  oddsObservedAt: observedAt,
  oddsReceivedAt: receivedAt,
});

const outcomeCode = (value) => {
  const code = String(value || "").toUpperCase();
  return OUTCOMES.includes(code) ? code : null;
};

const recommendationCodeFor = (snapshot, decision, market) => {
  const poolCode = String(market || "").toUpperCase();
  if (poolCode === "HAD") {
    const tips = [snapshot?.best, snapshot?.oneXTwo];
    const tip = tips.find((row) => (
      String(row?.oddsPoolCode || row?.poolCode || "").toUpperCase() === "HAD"
      && outcomeCode(row?.tipCode || row?.code)
    ));
    if (tip) return outcomeCode(tip.tipCode || tip.code);
  }
  if (poolCode === "HHAD") {
    const companion =
      decision?.exposure?.shadowTracks?.HHAD_COMPANION?.selection;
    const companionCode = outcomeCode(companion?.code);
    if (companionCode) return companionCode;
  }
  const candidates = Array.isArray(decision?.candidates) ? decision.candidates : [];
  const selected = candidates.find((row) => (
    String(row?.market || "").toUpperCase() === poolCode
    && row?.selected === true
    && outcomeCode(row?.code)
  ));
  if (selected) return outcomeCode(selected.code);
  return outcomeCode(
    candidates.find((row) => (
      String(row?.market || "").toUpperCase() === poolCode
      && outcomeCode(row?.code)
    ))?.code,
  );
};

const dualMarketDecisionRecordFor = ({ snapshot, decision }) => {
  const had = decision?.markets?.HAD;
  const hhad = decision?.markets?.HHAD;
  const hadOdds = isPlainObject(had?.odds) ? canonicalize(had.odds) : null;
  const hhadOdds = isPlainObject(hhad?.odds) ? canonicalize(hhad.odds) : null;
  const hadMarketProbabilities = normalizeTriplet(had?.marketProbabilities)
    || marketProbabilitiesFromOdds(hadOdds);
  const hhadMarketProbabilities = normalizeTriplet(hhad?.marketProbabilities)
    || marketProbabilitiesFromOdds(hhadOdds);
  const hadModelProbabilities = normalizeTriplet(decision?.probabilities?.HAD);
  const hhadModelProbabilities = normalizeTriplet(
    decision?.probabilities?.HHAD?.outcomes
    || decision?.probabilities?.HHAD,
  );
  const hadCode = recommendationCodeFor(snapshot, decision, "HAD");
  const hhadCode = recommendationCodeFor(snapshot, decision, "HHAD");
  const hhadLine = finite(
    hhad?.line ?? decision?.probabilities?.HHAD?.line,
    null,
  );
  const recommendation = (code, odds, modelProbabilities, marketProbabilities) => (
    code
      ? canonicalize({
          code,
          odds: finite(odds?.[code], null),
          modelProbability: finite(modelProbabilities?.[code], null),
          marketProbability: finite(marketProbabilities?.[code], null),
        })
      : null
  );
  return canonicalize({
    version: DUAL_MARKET_DECISION_RECORD_VERSION,
    formalMetricMarket: "HAD",
    companionMarket: "HHAD",
    markets: {
      HAD: {
        poolCode: "HAD",
        line: 0,
        odds: hadOdds,
        modelProbabilities: hadModelProbabilities,
        marketProbabilities: hadMarketProbabilities,
        recommendation: recommendation(
          hadCode,
          hadOdds,
          hadModelProbabilities,
          hadMarketProbabilities,
        ),
      },
      HHAD: {
        poolCode: "HHAD",
        line: hhadLine,
        odds: hhadOdds,
        modelProbabilities: hhadModelProbabilities,
        marketProbabilities: hhadMarketProbabilities,
        recommendation: recommendation(
          hhadCode,
          hhadOdds,
          hhadModelProbabilities,
          hhadMarketProbabilities,
        ),
      },
    },
    marketProvenanceHashes: {
      HAD: String(had?.provenanceHash || had?.provenance?.hash || ""),
      HHAD: String(hhad?.provenanceHash || hhad?.provenance?.hash || ""),
    },
    collectorAttestations: {
      HAD: {
        keyId: String(had?.provenance?.strict?.collectorAttestationKeyId || ""),
        commitmentHash: String(
          had?.provenance?.strict?.collectorAttestationCommitmentHash || "",
        ),
      },
      HHAD: {
        keyId: String(hhad?.provenance?.strict?.collectorAttestationKeyId || ""),
        commitmentHash: String(
          hhad?.provenance?.strict?.collectorAttestationCommitmentHash || "",
        ),
      },
    },
    sourceClocks: {
      HAD: {
        observedAt: isoTime(
          had?.observedAt || had?.provenance?.timing?.providerObservedAt,
        ),
        receivedAt: isoTime(
          had?.receivedAt || had?.provenance?.timing?.receivedAt,
        ),
      },
      HHAD: {
        observedAt: isoTime(
          hhad?.observedAt || hhad?.provenance?.timing?.providerObservedAt,
        ),
        receivedAt: isoTime(
          hhad?.receivedAt || hhad?.provenance?.timing?.receivedAt,
        ),
      },
    },
  });
};

const atomicDecisionHashFor = (record) => sha256({
  decisionRecordVersion: record?.decisionRecordVersion,
  atomicDecisionValidationVersion: record?.atomicDecisionValidationVersion,
  candidateSpecHash: record?.candidateSpecHash,
  leagueNormalizationVersion: record?.leagueNormalizationVersion,
  league: record?.league,
  odds: record?.odds,
  baseModelProbabilities: record?.baseModelProbabilities,
  probabilities: record?.probabilities,
  marketProbabilities: record?.marketProbabilities,
  featureSnapshotHash: record?.featureSnapshotHash,
  strategyVersionsHash: record?.strategyVersionsHash,
  sourceClockHash: record?.sourceClockHash,
  dualMarketDecisionHash: record?.dualMarketDecisionHash,
});

const isPlainObject = (value) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value),
);

const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;

const isSha256 = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));

const normalizedTripletDifference = (value, normalized) => Math.max(
  ...OUTCOMES.map((code) => Math.abs(Number(value?.[code]) - Number(normalized?.[code]))),
);

const sameInstant = (left, right) => {
  const leftIso = isoTime(left);
  const rightIso = isoTime(right);
  return Boolean(leftIso && rightIso && leftIso === rightIso);
};

const dualMarketDecisionRecordBlockers = (event) => {
  const blockers = [];
  const record = isPlainObject(event?.dualMarketDecision)
    ? event.dualMarketDecision
    : null;
  if (!record) return ["dual-market-decision-record-missing"];
  if (record.version !== DUAL_MARKET_DECISION_RECORD_VERSION) {
    blockers.push("dual-market-decision-record-version-invalid");
  }
  if (record.formalMetricMarket !== "HAD" || record.companionMarket !== "HHAD") {
    blockers.push("dual-market-role-invalid");
  }
  for (const market of ["HAD", "HHAD"]) {
    const row = isPlainObject(record?.markets?.[market])
      ? record.markets[market]
      : null;
    if (!row || row.poolCode !== market) {
      blockers.push(`${market.toLowerCase()}-record-missing-or-invalid`);
      continue;
    }
    if (
      (market === "HAD" && finite(row.line, null) !== 0)
      || (market === "HHAD" && !Number.isInteger(finite(row.line, null)))
    ) {
      blockers.push(`${market.toLowerCase()}-line-invalid`);
    }
    const odds = isPlainObject(row.odds) ? row.odds : null;
    if (!odds || OUTCOMES.some((code) => !(finite(odds?.[code], 0) > 1))) {
      blockers.push(`${market.toLowerCase()}-odds-triplet-invalid`);
    }
    const modelProbabilities = normalizeTriplet(row.modelProbabilities);
    const marketProbabilities = normalizeTriplet(row.marketProbabilities);
    if (
      !modelProbabilities
      || normalizedTripletDifference(row.modelProbabilities, modelProbabilities) > 1e-9
    ) {
      blockers.push(`${market.toLowerCase()}-model-probabilities-invalid`);
    }
    if (
      !marketProbabilities
      || normalizedTripletDifference(row.marketProbabilities, marketProbabilities) > 1e-9
    ) {
      blockers.push(`${market.toLowerCase()}-market-probabilities-invalid`);
    }
    const oddsDerivedMarket = odds ? marketProbabilitiesFromOdds(odds) : null;
    if (
      marketProbabilities
      && (
        !oddsDerivedMarket
        || normalizedTripletDifference(marketProbabilities, oddsDerivedMarket) > 1e-6
      )
    ) {
      blockers.push(`${market.toLowerCase()}-market-probabilities-odds-mismatch`);
    }
    const recommendation = isPlainObject(row.recommendation)
      ? row.recommendation
      : null;
    const code = outcomeCode(recommendation?.code);
    if (!code) {
      blockers.push(`${market.toLowerCase()}-recommendation-code-invalid`);
    } else {
      if (finite(recommendation?.odds, null) !== finite(odds?.[code], null)) {
        blockers.push(`${market.toLowerCase()}-recommendation-odds-mismatch`);
      }
      if (
        finite(recommendation?.modelProbability, null)
        !== finite(modelProbabilities?.[code], null)
      ) {
        blockers.push(`${market.toLowerCase()}-recommendation-model-probability-mismatch`);
      }
      if (
        finite(recommendation?.marketProbability, null)
        !== finite(marketProbabilities?.[code], null)
      ) {
        blockers.push(`${market.toLowerCase()}-recommendation-market-probability-mismatch`);
      }
    }
    if (!isSha256(record?.marketProvenanceHashes?.[market])) {
      blockers.push(`${market.toLowerCase()}-market-provenance-hash-invalid`);
    }
    const attestation = record?.collectorAttestations?.[market];
    if (!isNonEmptyText(attestation?.keyId)) {
      blockers.push(`${market.toLowerCase()}-collector-id-missing`);
    }
    if (!isSha256(attestation?.commitmentHash)) {
      blockers.push(`${market.toLowerCase()}-collector-attestation-hash-invalid`);
    }
    const observedAt = parseTime(record?.sourceClocks?.[market]?.observedAt);
    const receivedAt = parseTime(record?.sourceClocks?.[market]?.receivedAt);
    const decisionAt = parseTime(event?.decisionAt);
    if (observedAt === null) blockers.push(`${market.toLowerCase()}-observed-at-invalid`);
    if (receivedAt === null) blockers.push(`${market.toLowerCase()}-received-at-invalid`);
    if (observedAt !== null && receivedAt !== null && observedAt > receivedAt) {
      blockers.push(`${market.toLowerCase()}-observed-after-received`);
    }
    if (receivedAt !== null && decisionAt !== null && receivedAt > decisionAt) {
      blockers.push(`${market.toLowerCase()}-received-after-decision`);
    }
  }
  if (!isSha256(event?.dualMarketDecisionHash)) {
    blockers.push("dual-market-decision-hash-invalid");
  } else if (event.dualMarketDecisionHash !== sha256(record)) {
    blockers.push("dual-market-decision-hash-mismatch");
  }
  return [...new Set(blockers)].sort();
};

const sortedUniqueText = (values) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean),
)].sort();

const collectorQuorumRecordBlockers = (event) => {
  const blockers = [];
  const trustedCollectorCount = finite(event?.trustedCollectorCount, null);
  const record = isPlainObject(event?.collectorQuorum) ? event.collectorQuorum : null;
  // Existing append-only v2 decision rows predate the quorum extension. They
  // remain valid without a record; every newly attached quorum record is
  // nevertheless verified completely and the production capture path never
  // derives a multi-collector count from an unbound environment label.
  if (!record) return blockers;
  if (record.version !== COLLECTOR_QUORUM_VERSION) {
    blockers.push("collector-quorum-version-invalid");
  }
  if (!sameInstant(record.deadlineAt, event?.decisionDeadlineAt)) {
    blockers.push("collector-quorum-deadline-mismatch");
  }
  const marketDomains = {};
  for (const poolCode of ["HAD", "HHAD"]) {
    const market = isPlainObject(record?.markets?.[poolCode])
      ? record.markets[poolCode]
      : null;
    if (!market || !isSha256(market.extractionHash)) {
      blockers.push(`${poolCode.toLowerCase()}-collector-quorum-extraction-invalid`);
      marketDomains[poolCode] = [];
      continue;
    }
    const domains = sortedUniqueText(market.independenceDomains);
    if (JSON.stringify(domains) !== JSON.stringify(market.independenceDomains || [])) {
      blockers.push(`${poolCode.toLowerCase()}-collector-quorum-domains-invalid`);
    }
    const proofs = Array.isArray(market.proofs) ? market.proofs : [];
    if (proofs.length !== domains.length) {
      blockers.push(`${poolCode.toLowerCase()}-collector-quorum-proof-count-mismatch`);
    }
    for (const proof of proofs) {
      if (!isNonEmptyText(proof?.keyId) || !domains.includes(proof?.independenceDomain)) {
        blockers.push(`${poolCode.toLowerCase()}-collector-quorum-proof-identity-invalid`);
      }
      if (proof?.poolCode !== poolCode || proof?.extractionHash !== market.extractionHash) {
        blockers.push(`${poolCode.toLowerCase()}-collector-quorum-proof-market-mismatch`);
      }
      if (!isSha256(proof?.commitmentHash)) {
        blockers.push(`${poolCode.toLowerCase()}-collector-quorum-proof-commitment-invalid`);
      }
      if (proof?.source === "collector-evidence-store") {
        if (!isSha256(proof?.evidenceId)) {
          blockers.push(`${poolCode.toLowerCase()}-collector-quorum-evidence-id-invalid`);
        }
        const acceptedAt = parseTime(proof?.acceptedAt);
        const receivedAt = parseTime(proof?.receivedAt);
        const deadlineAt = parseTime(event?.decisionDeadlineAt);
        if (acceptedAt === null || receivedAt === null) {
          blockers.push(`${poolCode.toLowerCase()}-collector-quorum-evidence-clock-invalid`);
        } else if (deadlineAt !== null && (acceptedAt > deadlineAt || receivedAt > deadlineAt)) {
          blockers.push(`${poolCode.toLowerCase()}-collector-quorum-evidence-after-deadline`);
        }
      } else if (proof?.source !== "atomic-decision-snapshot") {
        blockers.push(`${poolCode.toLowerCase()}-collector-quorum-proof-source-invalid`);
      }
    }
    marketDomains[poolCode] = domains;
  }
  const hhadDomains = new Set(marketDomains.HHAD || []);
  const expectedJoint = (marketDomains.HAD || []).filter((domain) => hhadDomains.has(domain));
  const joint = sortedUniqueText(record.jointIndependenceDomains);
  if (
    JSON.stringify(joint) !== JSON.stringify(record.jointIndependenceDomains || [])
    || JSON.stringify(joint) !== JSON.stringify(expectedJoint)
  ) {
    blockers.push("collector-quorum-joint-domains-invalid");
  }
  if (
    record.trustedCollectorCount !== joint.length
    || record.trustedCollectorCount !== trustedCollectorCount
  ) {
    blockers.push("collector-quorum-count-mismatch");
  }
  if (record.singleAttestor !== (joint.length < 2) || record.singleAttestor !== event.singleAttestor) {
    blockers.push("collector-quorum-single-attestor-mismatch");
  }
  const { hash: _declaredHash, ...core } = record;
  if (!isSha256(record.hash) || record.hash !== sha256(core)) {
    blockers.push("collector-quorum-hash-invalid");
  }
  if (event.collectorQuorumHash !== record.hash) {
    blockers.push("collector-quorum-event-hash-mismatch");
  }
  return [...new Set(blockers)].sort();
};

const atomicDecisionRecordBlockers = (event) => {
  const blockers = [];
  if (!isPlainObject(event) || event.type !== "decision") {
    return ["decision-event-shape-invalid"];
  }
  if (event.decisionRecordVersion !== DECISION_RECORD_VERSION) {
    blockers.push("decision-record-version-invalid");
  }
  const atomicValidationVersion = String(
    event.atomicDecisionValidationVersion || "",
  );
  if (
    atomicValidationVersion
    && atomicValidationVersion !== ATOMIC_DECISION_VALIDATION_VERSION
  ) {
    blockers.push("atomic-decision-validation-version-invalid");
  }
  if (event.market !== "HAD") blockers.push("decision-market-invalid");
  if (event.sourceClass !== "official") blockers.push("decision-source-class-invalid");
  if (event.admissionEligible !== true) blockers.push("decision-admission-ineligible");
  if (Array.isArray(event.blockers) && event.blockers.length > 0) {
    blockers.push("decision-declared-blockers-present");
  }
  if (!isSha256(event.candidateSpecHash)) blockers.push("candidate-spec-hash-invalid");
  if (!isNonEmptyText(event.matchId) || !isNonEmptyText(event.sourceMatchId)) {
    blockers.push("decision-identity-missing");
  }
  if (!isNonEmptyText(event.collectorId)) blockers.push("collector-id-missing");
  if (event.leagueNormalizationVersion !== undefined) {
    if (event.leagueNormalizationVersion !== LEAGUE_NORMALIZATION_VERSION) {
      blockers.push("league-normalization-version-invalid");
    }
    const normalizedLeague = normalizedLeagueText(event.league);
    if (!normalizedLeague) blockers.push("league-at-decision-missing");
    if (normalizedLeague && normalizedLeague !== event.league) {
      blockers.push("league-at-decision-not-normalized");
    }
  }
  if (!isSha256(event.collectorAttestationCommitmentHash)) {
    blockers.push("collector-attestation-commitment-hash-invalid");
  }
  if (!isSha256(event.marketProvenanceHash)) {
    blockers.push("market-provenance-hash-invalid");
  }
  if (!isSha256(event.gateSpecHash)) blockers.push("gate-spec-hash-invalid");
  const trustedCollectorCount = finite(event.trustedCollectorCount, null);
  if (!Number.isInteger(trustedCollectorCount) || trustedCollectorCount < 1) {
    blockers.push("trusted-collector-count-invalid");
  }
  if (
    Number.isInteger(trustedCollectorCount)
    && event.singleAttestor !== (trustedCollectorCount < 2)
  ) {
    blockers.push("single-attestor-flag-inconsistent");
  }
  blockers.push(...collectorQuorumRecordBlockers(event));

  const odds = isPlainObject(event.odds) ? event.odds : null;
  if (!odds || OUTCOMES.some((code) => !(finite(odds?.[code], 0) > 1))) {
    blockers.push("odds-triplet-invalid");
  }
  const baseModelProbabilities = normalizeTriplet(event.baseModelProbabilities);
  const candidateProbabilitiesValue = normalizeTriplet(event.probabilities);
  const marketProbabilities = normalizeTriplet(event.marketProbabilities);
  if (!baseModelProbabilities
      || normalizedTripletDifference(event.baseModelProbabilities, baseModelProbabilities) > 1e-9) {
    blockers.push("base-model-probabilities-invalid");
  }
  if (!candidateProbabilitiesValue
      || normalizedTripletDifference(event.probabilities, candidateProbabilitiesValue) > 1e-9) {
    blockers.push("candidate-probabilities-invalid");
  }
  if (!marketProbabilities
      || normalizedTripletDifference(event.marketProbabilities, marketProbabilities) > 1e-9) {
    blockers.push("market-probabilities-invalid");
  }
  const oddsDerivedMarket = odds ? marketProbabilitiesFromOdds(odds) : null;
  if (
    marketProbabilities
    && (
      !oddsDerivedMarket
      || normalizedTripletDifference(marketProbabilities, oddsDerivedMarket) > 1e-6
    )
  ) {
    blockers.push("market-probabilities-odds-mismatch");
  }

  const featureSnapshot = isPlainObject(event.featureSnapshot)
    ? event.featureSnapshot
    : null;
  if (!featureSnapshot) blockers.push("feature-snapshot-missing");
  if (!isSha256(event.featureSnapshotHash)
      || !featureSnapshot
      || event.featureSnapshotHash !== sha256(featureSnapshot)) {
    blockers.push("feature-snapshot-hash-invalid");
  }
  if (!isPlainObject(featureSnapshot?.modelInputs)) {
    blockers.push("feature-model-inputs-missing");
  }

  const strategyVersions = isPlainObject(event.strategyVersions)
    ? event.strategyVersions
    : null;
  if (!strategyVersions) blockers.push("strategy-versions-missing");
  if (!isSha256(event.strategyVersionsHash)
      || !strategyVersions
      || event.strategyVersionsHash !== sha256(strategyVersions)) {
    blockers.push("strategy-versions-hash-invalid");
  }
  for (const field of [
    "candidateRevisionId",
    "candidateEvaluatorVersion",
    "predictionPolicyVersion",
    "modelVersion",
    "calibrationVersion",
    "featureSnapshotVersion",
  ]) {
    if (!isNonEmptyText(strategyVersions?.[field])) {
      blockers.push(`strategy-${field}-missing`);
    }
  }
  if (
    isNonEmptyText(strategyVersions?.candidateRevisionId)
    && strategyVersions.candidateRevisionId !== event.candidateRevisionId
  ) {
    blockers.push("strategy-candidate-revision-mismatch");
  }
  if (
    isNonEmptyText(strategyVersions?.featureSnapshotVersion)
    && isNonEmptyText(featureSnapshot?.version)
    && strategyVersions.featureSnapshotVersion !== featureSnapshot.version
  ) {
    blockers.push("feature-snapshot-version-mismatch");
  }

  const sourceClock = isPlainObject(event.sourceClock) ? event.sourceClock : null;
  if (!sourceClock) blockers.push("source-clock-missing");
  if (!isSha256(event.sourceClockHash)
      || !sourceClock
      || event.sourceClockHash !== sha256(sourceClock)) {
    blockers.push("source-clock-hash-invalid");
  }
  if (!isNonEmptyText(sourceClock?.sourceCycleId)) blockers.push("source-cycle-id-missing");
  const requiredClockFields = [
    "snapshotCapturedAt",
    "snapshotFirstSeenAt",
    "decisionAt",
    "featureSnapshotCapturedAt",
    "modelGeneratedAt",
    "oddsObservedAt",
    "oddsReceivedAt",
  ];
  for (const field of requiredClockFields) {
    if (parseTime(sourceClock?.[field]) === null) blockers.push(`source-clock-${field}-invalid`);
  }
  for (const field of [
    "snapshotCapturedAt",
    "snapshotFirstSeenAt",
    "decisionAt",
    "oddsObservedAt",
    "oddsReceivedAt",
  ]) {
    if (!sameInstant(event[field], sourceClock?.[field])) {
      blockers.push(`source-clock-${field}-mismatch`);
    }
  }
  if (!sameInstant(featureSnapshot?.capturedAt, sourceClock?.featureSnapshotCapturedAt)) {
    blockers.push("source-clock-featureSnapshotCapturedAt-mismatch");
  }

  const kickoffAt = parseTime(event.kickoffAt);
  const deadlineAt = parseTime(event.decisionDeadlineAt);
  const recordedAt = parseTime(event.recordedAt);
  const snapshotCapturedAt = parseTime(sourceClock?.snapshotCapturedAt);
  const snapshotFirstSeenAt = parseTime(sourceClock?.snapshotFirstSeenAt);
  const decisionAt = parseTime(sourceClock?.decisionAt);
  const featureCapturedAt = parseTime(sourceClock?.featureSnapshotCapturedAt);
  const modelGeneratedAt = parseTime(sourceClock?.modelGeneratedAt);
  const oddsObservedAt = parseTime(sourceClock?.oddsObservedAt);
  const oddsReceivedAt = parseTime(sourceClock?.oddsReceivedAt);
  if (kickoffAt === null) blockers.push("kickoff-at-invalid");
  if (deadlineAt === null) blockers.push("decision-deadline-at-invalid");
  if (recordedAt === null) blockers.push("recorded-at-invalid");
  if (event.decisionDeadlinePolicyVersion !== DECISION_DEADLINE_POLICY_VERSION) {
    blockers.push("decision-deadline-policy-version-invalid");
  }
  const orderedPairs = [
    ["odds-observed-after-received", oddsObservedAt, oddsReceivedAt],
    ["odds-received-after-decision", oddsReceivedAt, decisionAt],
    ["snapshot-captured-after-decision", snapshotCapturedAt, decisionAt],
    ["snapshot-first-seen-after-decision", snapshotFirstSeenAt, decisionAt],
    ["feature-captured-after-decision", featureCapturedAt, decisionAt],
    ["model-generated-after-decision", modelGeneratedAt, decisionAt],
    ["decision-after-deadline", decisionAt, deadlineAt],
    ["decision-deadline-after-kickoff", deadlineAt, kickoffAt],
    ["recorded-after-kickoff", recordedAt, kickoffAt],
  ];
  for (const [blocker, earlier, later] of orderedPairs) {
    if (earlier !== null && later !== null && earlier > later) blockers.push(blocker);
  }

  if (!isSha256(event.atomicDecisionHash)
      || event.atomicDecisionHash !== atomicDecisionHashFor(event)) {
    blockers.push("atomic-decision-hash-invalid");
  }
  // v3 decision rows already existed before the dual-market extension. Those
  // append-only rows must keep validating against their original commitment;
  // rewriting them would invalidate the ledger root. Every row created by the
  // v2 validator is explicitly version-bound into atomicDecisionHash and must
  // carry the complete HAD + HHAD companion record.
  if (atomicValidationVersion === ATOMIC_DECISION_VALIDATION_VERSION) {
    blockers.push(...dualMarketDecisionRecordBlockers(event));
  }
  return [...new Set(blockers)].sort();
};

const atomicDecisionRecordValid = (event) => (
  atomicDecisionRecordBlockers(event).length === 0
);

const buildDecisionEvent = ({
  ledger,
  match,
  snapshot,
  evaluatedAt,
  phase,
  trustedCollectorCount,
  trustedCollectorResolver = null,
}) => {
  const decision = decisionSnapshotFor(snapshot);
  const had = decision?.markets?.HAD || {};
  const times = snapshotTimes(snapshot);
  const kickoffAt = kickoffFor(match);
  const deadline = decisionDeadlineFor(match);
  const deadlineAt = deadline?.value || null;
  const finalization = captureFinalizationFor(match);
  const marketProbabilities = normalizeTriplet(had?.marketProbabilities)
    || marketProbabilitiesFromOdds(had?.odds);
  const featureSnapshot = featureSnapshotFor(snapshot, decision);
  const baseModelProbabilities = normalizeTriplet(
    decision?.probabilities?.HAD
    || {
      "1": featureSnapshot?.modelInputs?.oneXTwoFinal?.home,
      X: featureSnapshot?.modelInputs?.oneXTwoFinal?.draw,
      "2": featureSnapshot?.modelInputs?.oneXTwoFinal?.away,
    },
  );
  const probabilities = candidateProbabilities(
    ledger.header.candidateDefinition,
    marketProbabilities,
    baseModelProbabilities,
  );
  const receivedAt = isoTime(had?.receivedAt || had?.provenance?.timing?.receivedAt);
  const observedAt = isoTime(
    had?.observedAt
    || had?.provenance?.timing?.providerObservedAt,
  );
  const strict = had?.provenance?.strict || {};
  const strategyVersions = strategyVersionsFor({
    ledger,
    snapshot,
    decision,
    featureSnapshot,
  });
  const sourceClock = sourceClockFor({
    snapshot,
    decision,
    featureSnapshot,
    times,
    observedAt,
    receivedAt,
  });
  const featureSnapshotHash = featureSnapshot ? sha256(featureSnapshot) : null;
  const strategyVersionsHash = sha256(strategyVersions);
  const sourceClockHash = sha256(sourceClock);
  const dualMarketDecision = dualMarketDecisionRecordFor({ snapshot, decision });
  const dualMarketDecisionHash = sha256(dualMarketDecision);
  const blockers = [];
  if (decision?.clockAudit?.eligible !== true) blockers.push("decision-clock-audit-ineligible");
  if (!marketProbabilities) blockers.push("same-decision-devigged-market-missing");
  if (!baseModelProbabilities) blockers.push("base-model-probabilities-missing");
  if (marketProbabilities && baseModelProbabilities && !probabilities) {
    blockers.push("candidate-evaluator-unsupported-or-invalid");
  }
  if (!observedAt) blockers.push("odds-observed-at-missing");
  if (!receivedAt) blockers.push("odds-received-at-missing");
  if (!strict?.collectorAttestationKeyId) blockers.push("collector-attestation-key-id-missing");
  if (!strict?.collectorAttestationCommitmentHash) {
    blockers.push("collector-attestation-commitment-hash-missing");
  }
  if (!had?.provenanceHash && !had?.provenance?.hash) blockers.push("market-provenance-hash-missing");
  blockers.push(
    ...dualMarketDecisionRecordBlockers({
      type: "decision",
      decisionAt: times.decisionAt,
      dualMarketDecision,
      dualMarketDecisionHash,
    }),
  );
  if (!featureSnapshot) blockers.push("feature-snapshot-missing");
  if (!featureSnapshot?.modelInputs || typeof featureSnapshot.modelInputs !== "object") {
    blockers.push("feature-model-inputs-missing");
  }
  if (!strategyVersions.predictionPolicyVersion) blockers.push("prediction-policy-version-missing");
  if (!strategyVersions.modelVersion) blockers.push("model-version-missing");
  if (!strategyVersions.calibrationVersion) blockers.push("calibration-version-missing");
  if (!strategyVersions.featureSnapshotVersion) blockers.push("feature-snapshot-version-missing");
  if (!sourceClock.sourceCycleId) blockers.push("source-cycle-id-missing");
  if (!sourceClock.featureSnapshotCapturedAt) blockers.push("feature-captured-at-missing");
  if (!sourceClock.modelGeneratedAt) blockers.push("model-generated-at-missing");
  if (parseTime(receivedAt) !== null && parseTime(receivedAt) > parseTime(deadlineAt)) {
    blockers.push("odds-received-after-decision-deadline");
  }
  if (parseTime(times.firstSeenAt) > parseTime(deadlineAt)) {
    blockers.push("snapshot-first-seen-after-decision-deadline");
  }
  if (parseTime(evaluatedAt) > parseTime(kickoffAt)) blockers.push("ledger-appended-after-kickoff");
  let collectorQuorum = null;
  if (typeof trustedCollectorResolver === "function") {
    try {
      collectorQuorum = trustedCollectorResolver({
        ledger,
        match,
        snapshot,
        decision,
        deadlineAt,
      }) || null;
    } catch {
      collectorQuorum = null;
    }
  }
  const resolvedCollectorCount = finite(collectorQuorum?.trustedCollectorCount, null);
  if (!Number.isInteger(resolvedCollectorCount) || resolvedCollectorCount < 1) {
    collectorQuorum = null;
  }
  const collectors = Number.isInteger(resolvedCollectorCount) && resolvedCollectorCount >= 1
    ? resolvedCollectorCount
    : trustedCollectorCountFor(snapshot, trustedCollectorCount);
  const sourceClass = blockers.length ? "low-confidence" : "official";
  const league = normalizedLeagueForMatch(match);
  const common = {
    recordedAt: isoTime(evaluatedAt),
    phase,
    candidateRevisionId: ledger.header.candidateRevisionId,
    candidateSpecHash: ledger.header.candidateSpecHash,
    matchId: String(match?.id || match?.matchId || ""),
    sourceMatchId: String(match?.sourceMatchId || decision?.sourceMatchId || ""),
    leagueNormalizationVersion: LEAGUE_NORMALIZATION_VERSION,
    league,
    market: "HAD",
    kickoffAt,
    decisionDeadlineAt: deadlineAt,
    decisionDeadlinePolicyVersion: deadline?.version || null,
    decisionDeadlineSource: deadline?.source || null,
    officialCutoffAt: deadline?.officialCutoffAt || null,
    kickoffOffsetAt: deadline?.kickoffOffsetAt || null,
    captureFinalizationAt: finalization?.value || null,
    captureFinalizationPolicyVersion: finalization?.version || null,
    captureFinalizationGraceSeconds: finalization?.graceSeconds || 0,
    snapshotCapturedAt: times.capturedAt,
    snapshotFirstSeenAt: times.firstSeenAt,
    decisionAt: times.decisionAt,
    oddsObservedAt: observedAt,
    oddsReceivedAt: receivedAt,
    snapshotHash: sha256(snapshot),
    decisionSnapshotHash: sha256(decision),
    pairSnapshotHash: sha256({
      candidateSpecHash: ledger.header.candidateSpecHash,
      decisionSnapshot: decision,
      marketProbabilities,
      baseModelProbabilities,
      candidateProbabilities: probabilities,
    }),
    sourceClass,
    collectorId: String(strict?.collectorAttestationKeyId || ""),
    collectorAttestationCommitmentHash: String(
      strict?.collectorAttestationCommitmentHash || "",
    ),
    marketProvenanceHash: String(had?.provenanceHash || had?.provenance?.hash || ""),
    marketExtractionHash: String(had?.provenance?.extraction?.hash || ""),
    trustedCollectorCount: collectors,
    singleAttestor: collectors < 2,
    ...(collectorQuorum ? {
      collectorQuorum,
      collectorQuorumHash: collectorQuorum.hash || null,
    } : {}),
    gateSpecHash: ledger.header.gateSpecHash,
    decisionRecordVersion: DECISION_RECORD_VERSION,
    atomicDecisionValidationVersion: ATOMIC_DECISION_VALIDATION_VERSION,
    baseModelProbabilities,
    featureSnapshot,
    featureSnapshotHash,
    declaredFeatureSnapshotHash: String(
      snapshot?.featureSnapshotHash
      || decision?.featureSnapshotHash
      || featureSnapshot?.hash
      || "",
    ),
    strategyVersions,
    strategyVersionsHash,
    sourceClock,
    sourceClockHash,
    dualMarketDecision,
    dualMarketDecisionHash,
  };
  if (blockers.length) {
    const evidenceClassification = classifyCandidateDecisionEvidence({
      had,
      blockers,
    });
    return {
      type: "exclusion",
      ...common,
      ...evidenceClassification,
      blockers: [...new Set(blockers)].sort(),
      admissionEligible: false,
      onlineEffect: false,
    };
  }
  return {
    type: "decision",
    ...common,
    probabilities,
    marketProbabilities,
    odds: canonicalize(had?.odds || {}),
    atomicDecisionHash: atomicDecisionHashFor({
      decisionRecordVersion: DECISION_RECORD_VERSION,
      atomicDecisionValidationVersion: ATOMIC_DECISION_VALIDATION_VERSION,
      candidateSpecHash: ledger.header.candidateSpecHash,
      leagueNormalizationVersion: LEAGUE_NORMALIZATION_VERSION,
      league,
      odds: canonicalize(had?.odds || {}),
      baseModelProbabilities,
      probabilities,
      marketProbabilities,
      featureSnapshotHash,
      strategyVersionsHash,
      sourceClockHash,
      dualMarketDecisionHash,
    }),
    admissionEligible: true,
    onlineEffect: false,
  };
};

const captureCohort = ({
  ledger,
  matches,
  snapshots,
  evaluatedAt,
  trustedCollectorCount,
  trustedCollectorResolver = null,
}) => {
  const nowMs = parseTime(evaluatedAt);
  const frozenMs = parseTime(ledger.header.frozenAt);
  const activation = ledgerActivation(ledger);
  const activationMs = parseTime(activation?.activationAt);
  const existing = ledger.events
    .filter((event) => event.type === "decision" || event.type === "exclusion");
  const rows = (Array.isArray(matches) ? matches : [])
    .filter((match) => parseTime(kickoffFor(match)) > frozenMs)
    .sort((left, right) => parseTime(kickoffFor(left)) - parseTime(kickoffFor(right)));
  for (const match of rows) {
    if (existing.some((event) => sameCohortIdentity(event, match))) continue;
    const kickoffAt = kickoffFor(match);
    const kickoffMs = parseTime(kickoffAt);
    const deadline = decisionDeadlineFor(match);
    if (!deadline) continue;
    const deadlineAt = deadline.value;
    const finalization = captureFinalizationFor(match);
    if (!finalization || nowMs < finalization.millis) continue;
    const phase = Number.isFinite(activationMs) && deadline.millis >= activationMs
      ? "formal"
      : "pre-gate-shadow";
    if (nowMs > kickoffMs) {
      appendEvent(ledger, {
        type: "exclusion",
        recordedAt: isoTime(evaluatedAt),
        phase,
        candidateRevisionId: ledger.header.candidateRevisionId,
        candidateSpecHash: ledger.header.candidateSpecHash,
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        leagueNormalizationVersion: LEAGUE_NORMALIZATION_VERSION,
        league: normalizedLeagueForMatch(match),
        market: "HAD",
        kickoffAt,
        decisionDeadlineAt: deadlineAt,
        decisionDeadlinePolicyVersion: deadline.version,
        decisionDeadlineSource: deadline.source,
        officialCutoffAt: deadline.officialCutoffAt,
        kickoffOffsetAt: deadline.kickoffOffsetAt,
        captureFinalizationAt: finalization.value,
        captureFinalizationPolicyVersion: finalization.version,
        captureFinalizationGraceSeconds: finalization.graceSeconds,
        sourceClass: "unknown",
        officialHadMarketPresent: false,
        strictOfficialMarketEvidenceComplete: false,
        hhadCompanionEvidenceComplete: false,
        marketState: "capture-missed-before-kickoff",
        primaryExclusionReason: "pre-match-ledger-capture-missed",
        admissionEligible: false,
        blockers: ["pre-match-ledger-capture-missed"],
        gateSpecHash: ledger.header.gateSpecHash,
        onlineEffect: false,
      });
      existing.push(ledger.events.at(-1));
      continue;
    }
    const selection = selectSnapshotAtDeadline({
      match,
      snapshots,
      frozenAt: ledger.header.frozenAt,
      deadlineAt,
    });
    if (!selection.snapshot) {
      appendEvent(ledger, {
        type: "exclusion",
        recordedAt: isoTime(evaluatedAt),
        phase,
        candidateRevisionId: ledger.header.candidateRevisionId,
        candidateSpecHash: ledger.header.candidateSpecHash,
        matchId: String(match?.id || match?.matchId || ""),
        sourceMatchId: String(match?.sourceMatchId || ""),
        leagueNormalizationVersion: LEAGUE_NORMALIZATION_VERSION,
        league: normalizedLeagueForMatch(match),
        market: "HAD",
        kickoffAt,
        decisionDeadlineAt: deadlineAt,
        decisionDeadlinePolicyVersion: deadline.version,
        decisionDeadlineSource: deadline.source,
        officialCutoffAt: deadline.officialCutoffAt,
        kickoffOffsetAt: deadline.kickoffOffsetAt,
        captureFinalizationAt: finalization.value,
        captureFinalizationPolicyVersion: finalization.version,
        captureFinalizationGraceSeconds: finalization.graceSeconds,
        sourceClass: "unknown",
        officialHadMarketPresent: false,
        strictOfficialMarketEvidenceComplete: false,
        hhadCompanionEvidenceComplete: false,
        marketState: "decision-snapshot-not-observed",
        primaryExclusionReason: "eligible-decision-snapshot-not-observed",
        admissionEligible: false,
        blockers: selection.blockers,
        gateSpecHash: ledger.header.gateSpecHash,
        onlineEffect: false,
      });
      existing.push(ledger.events.at(-1));
      continue;
    }
    const appended = appendEvent(ledger, buildDecisionEvent({
      ledger,
      match,
      snapshot: selection.snapshot,
      evaluatedAt,
      phase,
      trustedCollectorCount,
      trustedCollectorResolver,
    }));
    existing.push(appended);
  }
};

const settleCohort = ({ ledger, matches, evaluatedAt }) => {
  const settledDecisionHashes = new Set(
    ledgerEvents(ledger, "settlement").map((event) => event.decisionEventHash),
  );
  for (const decision of ledgerEvents(ledger, "decision")) {
    if (settledDecisionHashes.has(decision.eventHash)) continue;
    const match = selectOfficialSettlementMatch(matches, decision);
    const actual = resultOutcome(match);
    if (!match || !actual) continue;
    const result = officialResultState(match);
    // Display/audit supplements (for example official-club or UEFA finals) are
    // intentionally not promotion evidence. Keep the decision pending so a
    // later exact Sporttery result can still settle it; an invalid terminal
    // settlement would otherwise permanently poison the prospective cohort.
    if (!result.eligible) continue;
    appendEvent(ledger, {
      type: "settlement",
      recordedAt: isoTime(evaluatedAt),
      phase: decision.phase,
      decisionEventHash: decision.eventHash,
      candidateRevisionId: ledger.header.candidateRevisionId,
      matchId: decision.matchId,
      sourceMatchId: decision.sourceMatchId,
      market: "HAD",
      kickoffAt: decision.kickoffAt,
      resultObservedAt: result.observedAt,
      resultProvider: result.provider,
      resultSourceMatchId: result.sourceMatchId,
      resultEventVersion: result.eventVersion,
      scoreHome: result.scoreHome,
      scoreAway: result.scoreAway,
      actual,
      valid: true,
      settlementRecordVersion: SETTLEMENT_RECORD_VERSION,
      resultProvenanceVersion: result.settlementEvidence?.provenanceVersion || null,
      resultObservationSource: result.settlementEvidence?.observationSource || null,
      resultOfficial: result.settlementEvidence?.official === true,
      resultTrusted: result.settlementEvidence?.trusted === true,
      resultPromotionEligible:
        result.settlementEvidence?.promotionEligible === true,
      resultObservationFallback:
        result.settlementEvidence?.resultObservationFallback === true,
      resultProvenanceHash: result.provenanceHash,
      blockers: [],
      onlineEffect: false,
    });
  }
};

const scoreDelta = (decision, settlement) => {
  if (!decision || !settlement?.valid || !OUTCOMES.includes(settlement.actual)) return null;
  const candidate = normalizeTriplet(decision.probabilities);
  const market = normalizeTriplet(decision.marketProbabilities);
  if (!candidate || !market) return null;
  const actual = settlement.actual;
  const logLoss = (probabilities) => -Math.log(Math.max(1e-12, probabilities[actual]));
  const brier = (probabilities) => OUTCOMES.reduce((sum, code) => (
    sum + (probabilities[code] - (code === actual ? 1 : 0)) ** 2
  ), 0);
  const candidateLogLoss = logLoss(candidate);
  const marketLogLoss = logLoss(market);
  const candidateBrier = brier(candidate);
  const marketBrier = brier(market);
  return {
    decisionEventHash: decision.eventHash || null,
    matchId: decision.matchId || null,
    kickoffTime: decision.kickoffAt,
    league: decision.league || "unknown",
    probabilities: candidate,
    marketProbabilities: market,
    actual,
    market: { odds: decision.odds || null },
    candidateLogLoss,
    marketLogLoss,
    candidateBrier,
    marketBrier,
    logLossImprovement: marketLogLoss - candidateLogLoss,
    brierImprovement: marketBrier - candidateBrier,
  };
};

const METRIC_DIAGNOSTIC_VERSION = "candidate-formal-metric-diagnostic-v1";
const METRIC_DIAGNOSTIC_ROW_LIMIT = 100;

const strongestOutcome = (probabilities) => OUTCOMES.reduce((best, code) => (
  Number(probabilities?.[code] || 0) > Number(probabilities?.[best] || 0)
    ? code
    : best
), OUTCOMES[0]);

const metricAttribution = (row) => {
  const candidatePick = strongestOutcome(row.probabilities);
  const marketPick = strongestOutcome(row.marketProbabilities);
  const candidateHit = candidatePick === row.actual;
  const marketHit = marketPick === row.actual;
  if (!candidateHit && marketHit) return "direction-regression";
  if (candidateHit && !marketHit) return "direction-gain";
  return row.logLossImprovement < 0
    ? "calibration-regression"
    : "calibration-gain";
};

const buildFormalMetricDiagnostics = (rows, limit = METRIC_DIAGNOSTIC_ROW_LIMIT) => {
  const safeLimit = Math.max(1, Math.min(
    METRIC_DIAGNOSTIC_ROW_LIMIT,
    Number(limit || METRIC_DIAGNOSTIC_ROW_LIMIT),
  ));
  const ordered = rows
    .slice()
    .sort((left, right) => (
      String(left.kickoffTime || "").localeCompare(String(right.kickoffTime || ""))
      || String(left.decisionEventHash || "").localeCompare(
        String(right.decisionEventHash || ""),
      )
    ));
  const selected = ordered.slice(-safeLimit).map((row) => {
    const candidatePick = strongestOutcome(row.probabilities);
    const marketPick = strongestOutcome(row.marketProbabilities);
    return {
      matchId: row.matchId,
      kickoffTime: row.kickoffTime,
      league: row.league,
      actual: row.actual,
      candidatePick,
      marketPick,
      candidateHit: candidatePick === row.actual,
      marketHit: marketPick === row.actual,
      picksDiffer: candidatePick !== marketPick,
      candidateActualProbability: round(row.probabilities[row.actual]),
      marketActualProbability: round(row.marketProbabilities[row.actual]),
      actualProbabilityImprovement: round(
        row.probabilities[row.actual] - row.marketProbabilities[row.actual],
      ),
      candidateLogLoss: round(row.candidateLogLoss),
      marketLogLoss: round(row.marketLogLoss),
      logLossImprovement: round(row.logLossImprovement),
      candidateBrier: round(row.candidateBrier),
      marketBrier: round(row.marketBrier),
      brierImprovement: round(row.brierImprovement),
      attribution: metricAttribution(row),
    };
  });
  const count = (attribution) => selected.filter(
    (row) => row.attribution === attribution,
  ).length;
  return {
    version: METRIC_DIAGNOSTIC_VERSION,
    totalRows: ordered.length,
    detailedRows: selected.length,
    rowsTruncated: Math.max(0, ordered.length - selected.length),
    rowLimit: safeLimit,
    attributionCounts: {
      directionRegression: count("direction-regression"),
      directionGain: count("direction-gain"),
      calibrationRegression: count("calibration-regression"),
      calibrationGain: count("calibration-gain"),
    },
    bothMetricsImproved: selected.filter((row) => (
      row.logLossImprovement > 0 && row.brierImprovement > 0
    )).length,
    bothMetricsRegressed: selected.filter((row) => (
      row.logLossImprovement < 0 && row.brierImprovement < 0
    )).length,
    rows: selected,
  };
};

const mean = (values) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
);

const summarizeWindow = (rows, window) => {
  const start = parseTime(window.startAt);
  const end = parseTime(window.endAt);
  const selected = rows.filter((row) => {
    const kickoff = parseTime(row.kickoffTime);
    return kickoff >= start && kickoff < end;
  });
  const candidateLogLoss = mean(selected.map((row) => row.candidateLogLoss));
  const marketLogLoss = mean(selected.map((row) => row.marketLogLoss));
  const candidateBrier = mean(selected.map((row) => row.candidateBrier));
  const marketBrier = mean(selected.map((row) => row.marketBrier));
  const logLossImprovement = mean(selected.map((row) => row.logLossImprovement));
  const brierImprovement = mean(selected.map((row) => row.brierImprovement));
  return {
    ...window,
    rows: selected.length,
    candidateLogLoss: round(candidateLogLoss),
    marketLogLoss: round(marketLogLoss),
    candidateBrier: round(candidateBrier),
    marketBrier: round(marketBrier),
    logLossImprovement: round(logLossImprovement),
    brierImprovement: round(brierImprovement),
    improvesBoth: selected.length > 0
      && logLossImprovement > 0
      && brierImprovement > 0,
  };
};

const assessWindowPerformance = (rows, boundaries) => {
  const windows = Array.isArray(boundaries)
    ? boundaries.map((window) => summarizeWindow(rows, window))
    : [];
  const parsedBoundaries = windows
    .map((window) => ({
      start: parseTime(window.startAt),
      end: parseTime(window.endAt),
    }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
    .sort((left, right) => left.start - right.start);
  const boundariesValid = parsedBoundaries.length === windows.length
    && parsedBoundaries.every((window) => window.end > window.start);
  const boundariesNonOverlapping = boundariesValid
    && parsedBoundaries.every((window, index) => (
      index === 0 || parsedBoundaries[index - 1].end <= window.start
    ));
  const assignmentCounts = rows.map((row) => {
    const kickoff = parseTime(row.kickoffTime);
    return parsedBoundaries.filter((window) => (
      kickoff >= window.start && kickoff < window.end
    )).length;
  });
  const eligibleWindows = windows.filter(
    (window) => window.rows >= MIN_FORMAL_ROWS_PER_WINDOW,
  );
  const winningWindows = eligibleWindows.filter((window) => window.improvesBoth);
  const rowsAssigned = assignmentCounts.filter((count) => count === 1).length;
  const unassignedRows = assignmentCounts.filter((count) => count === 0).length;
  const reusedRows = assignmentCounts.filter((count) => count > 1).length;
  return {
    windows,
    registeredWindows: windows.length,
    eligibleWindows: eligibleWindows.length,
    winningWindows: winningWindows.length,
    requiredWindows: MIN_WINDOWS,
    requiredWinningWindows: MIN_WINNING_WINDOWS,
    minimumRowsPerWindow: MIN_FORMAL_ROWS_PER_WINDOW,
    rowsAssigned,
    unassignedRows,
    reusedRows,
    boundariesValid,
    boundariesNonOverlapping,
    passes:
      windows.length === WINDOW_COUNT
      && eligibleWindows.length >= MIN_WINDOWS
      && winningWindows.length >= MIN_WINNING_WINDOWS
      && unassignedRows === 0
      && reusedRows === 0
      && boundariesNonOverlapping,
  };
};

const auditLedger = (ledger, {
  totalCandidatesEverTested = 1,
  evaluatedAt = new Date().toISOString(),
  verifyReviewCheckpoints = true,
} = {}) => {
  const verification = verifyLedger(ledger, { verifyReviewCheckpoints });
  const decisions = ledgerEvents(ledger, "decision");
  const exclusions = ledgerEvents(ledger, "exclusion");
  const settlements = ledgerEvents(ledger, "settlement");
  const settlementByDecision = new Map(
    settlements.map((event) => [event.decisionEventHash, event]),
  );
  const phaseSummary = (phase) => {
    const phaseDecisions = decisions.filter((event) => event.phase === phase);
    const phaseExclusions = exclusions.filter((event) => event.phase === phase);
    const phaseSettlements = phaseDecisions
      .map((decision) => settlementByDecision.get(decision.eventHash))
      .filter(Boolean);
    const validSettlements = phaseSettlements.filter((event) => event.valid);
    const invalidSettlements = phaseSettlements.filter((event) => !event.valid);
    const finalized = phaseExclusions.length + phaseSettlements.length;
    return {
      universe: phaseDecisions.length + phaseExclusions.length,
      admitted: phaseDecisions.length,
      excluded: phaseExclusions.length,
      pending: phaseDecisions.length - phaseSettlements.length,
      settled: validSettlements.length,
      invalidSettlements: invalidSettlements.length,
      invalid: phaseExclusions.length + invalidSettlements.length,
      finalized,
      denominatorReconciled:
        phaseDecisions.length + phaseExclusions.length
        === phaseDecisions.length - phaseSettlements.length
          + phaseSettlements.length
          + phaseExclusions.length,
    };
  };
  const shadow = phaseSummary("pre-gate-shadow");
  const formal = phaseSummary("formal");
  const atomicDecisionValidation = decisions.map((event) => ({
    event,
    blockers: atomicDecisionRecordBlockers(event),
  }));
  const atomicDecisionRows = atomicDecisionValidation
    .filter((row) => row.blockers.length === 0).length;
  const atomicDecisionBlockerCounts = Object.fromEntries(
    [...new Set(atomicDecisionValidation.flatMap((row) => row.blockers))]
      .sort()
      .map((blocker) => [
        blocker,
        atomicDecisionValidation.filter((row) => row.blockers.includes(blocker)).length,
      ]),
  );
  const decisionByHash = new Map(
    decisions.map((event) => [event.eventHash, event]),
  );
  const settlementValidation = settlements.map((event) => ({
    event,
    blockers: settlementRecordBlockers(
      event,
      decisionByHash.get(event.decisionEventHash),
    ),
  }));
  const completeSettlementRows = settlementValidation
    .filter((row) => row.blockers.length === 0).length;
  const settlementBlockerCounts = Object.fromEntries(
    [...new Set(settlementValidation.flatMap((row) => row.blockers))]
      .sort()
      .map((blocker) => [
        blocker,
        settlementValidation.filter((row) => row.blockers.includes(blocker)).length,
      ]),
  );
  const formalRows = decisions
    .filter((event) => event.phase === "formal")
    .map((decision) => scoreDelta(decision, settlementByDecision.get(decision.eventHash)))
    .filter(Boolean);
  const metricDiagnostics = buildFormalMetricDiagnostics(formalRows);
  const activation = ledgerActivation(ledger);
  const windowEvaluation = assessWindowPerformance(
    formalRows,
    activation?.windowBoundaries,
  );
  const windows = windowEvaluation.windows;
  const bootstrap = pairedCircularBlockBootstrap(formalRows, {
    candidateId: ledger.header.candidateRevisionId,
    testedCandidateCount: Math.max(
      Number(totalCandidatesEverTested || 1),
      Number(ledger.header.totalCandidatesEverTestedAtFreeze || 1),
    ),
  });
  const adjusted = bootstrap?.familyWiseAdjusted;
  const lowerBoundsPositive = finite(adjusted?.logLossImprovement?.lower, null) > 0
    && finite(adjusted?.brierImprovement?.lower, null) > 0;
  const invalidShare = formal.finalized ? formal.invalid / formal.finalized : 0;
  const formalDecisions = decisions.filter((event) => event.phase === "formal");
  const singleAttestorShare = formalDecisions.length
    ? formalDecisions.filter((event) => event.singleAttestor).length / formalDecisions.length
    : 0;
  const blockers = [];
  if (!verification.valid) blockers.push("hash-chain-invalid");
  if (!activation) blockers.push("formal-activation-missing");
  if (formal.settled < MIN_FORMAL_SETTLED) {
    blockers.push(`formal-settled:${formal.settled}<${MIN_FORMAL_SETTLED}`);
  }
  if (formal.finalized < MIN_FORMAL_FINALIZED) {
    blockers.push(`formal-finalized:${formal.finalized}<${MIN_FORMAL_FINALIZED}`);
  }
  if (windowEvaluation.registeredWindows !== WINDOW_COUNT) {
    blockers.push(
      `preregistered-calendar-windows:${windowEvaluation.registeredWindows}!=${WINDOW_COUNT}`,
    );
  }
  if (windowEvaluation.eligibleWindows < MIN_WINDOWS) {
    blockers.push(
      `independent-calendar-windows:${windowEvaluation.eligibleWindows}<${MIN_WINDOWS}`,
    );
  }
  if (windowEvaluation.winningWindows < MIN_WINNING_WINDOWS) {
    blockers.push(
      `winning-calendar-windows:${windowEvaluation.winningWindows}<${MIN_WINNING_WINDOWS}`,
    );
  }
  if (!windowEvaluation.boundariesNonOverlapping) {
    blockers.push("preregistered-calendar-windows-overlap-or-invalid");
  }
  if (windowEvaluation.reusedRows > 0) {
    blockers.push(`formal-row-reuse-across-windows:${windowEvaluation.reusedRows}`);
  }
  if (windowEvaluation.unassignedRows > 0) {
    blockers.push(`formal-rows-outside-preregistered-windows:${windowEvaluation.unassignedRows}`);
  }
  if (!lowerBoundsPositive) blockers.push("family-wise-adjusted-lower-bounds-not-positive");
  if (invalidShare > MAX_INVALID_SHARE) blockers.push("invalid-share-above-preregistered-limit");
  if (singleAttestorShare > MAX_SINGLE_ATTESTOR_SHARE) {
    blockers.push("single-attestor-share-above-preregistered-limit");
  }
  const latestReview = ledgerEvents(ledger, "review")
    .slice()
    .sort((left, right) => (
      Number(right.checkpointSettled ?? right.checkpointFinalized)
      - Number(left.checkpointSettled ?? left.checkpointFinalized)
    ))[0]
    || null;
  const promotionReviewReady = blockers.length === 0;
  return {
    version: AUDIT_VERSION,
    evaluatedAt: isoTime(evaluatedAt),
    ledgerId: ledger.ledgerId,
    candidateRevisionId: ledger.header.candidateRevisionId,
    baseCandidateId: ledger.header.baseCandidateId,
    candidateSpecHash: ledger.header.candidateSpecHash,
    state: ledgerState(ledger),
    onlineEffect: false,
    chainValid: verification.valid,
    chainBlockers: verification.blockers,
    rootHash: ledger.rootHash,
    headerHash: ledger.headerHash,
    frozenAt: ledger.header.frozenAt,
    activationAt: activation?.activationAt || null,
    gateSpecHash: ledger.header.gateSpecHash,
    inventoryHashAtFreeze: ledger.header.inventoryHashAtFreeze,
    totalCandidatesEverTested: Math.max(
      Number(totalCandidatesEverTested || 1),
      Number(ledger.header.totalCandidatesEverTestedAtFreeze || 1),
    ),
    decisionRecord: {
      version: ledger.header.gateSpec?.decisionRecordVersion || null,
      validationVersion: ATOMIC_DECISION_VALIDATION_VERSION,
      dualMarketDecisionRecordVersion: DUAL_MARKET_DECISION_RECORD_VERSION,
      formalMetricMarket: "HAD",
      companionMarket: "HHAD",
      decisionDeadlinePolicyVersion:
        ledger.header.gateSpec?.decisionDeadlinePolicyVersion || null,
      requiredFields: [...ATOMIC_DECISION_REQUIRED_FIELDS],
      admittedRows: decisions.length,
      atomicRows: atomicDecisionRows,
      completeRows: atomicDecisionRows,
      failedRows: decisions.length - atomicDecisionRows,
      blockerCounts: atomicDecisionBlockerCounts,
      coverage: decisions.length ? round(atomicDecisionRows / decisions.length) : 1,
      complete: atomicDecisionRows === decisions.length,
    },
    settlementRecord: {
      version: ledger.header.gateSpec?.settlementRecordVersion || null,
      validationVersion: SETTLEMENT_VALIDATION_VERSION,
      requiredFields: [...SETTLEMENT_REQUIRED_FIELDS],
      rows: settlements.length,
      completeRows: completeSettlementRows,
      failedRows: settlements.length - completeSettlementRows,
      blockerCounts: settlementBlockerCounts,
      coverage: settlements.length
        ? round(completeSettlementRows / settlements.length)
        : 1,
      complete: completeSettlementRows === settlements.length,
    },
    cohort: { shadow, formal },
    metrics: {
      formalRows: formalRows.length,
      logLossImprovement: round(mean(formalRows.map((row) => row.logLossImprovement))),
      brierImprovement: round(mean(formalRows.map((row) => row.brierImprovement))),
      invalidShare: round(invalidShare),
      singleAttestorShare: round(singleAttestorShare),
      diagnostics: metricDiagnostics,
      bootstrap,
      windows,
      windowEvaluation: {
        registeredWindows: windowEvaluation.registeredWindows,
        eligibleWindows: windowEvaluation.eligibleWindows,
        winningWindows: windowEvaluation.winningWindows,
        requiredWindows: windowEvaluation.requiredWindows,
        requiredWinningWindows: windowEvaluation.requiredWinningWindows,
        minimumRowsPerWindow: windowEvaluation.minimumRowsPerWindow,
        rowsAssigned: windowEvaluation.rowsAssigned,
        unassignedRows: windowEvaluation.unassignedRows,
        reusedRows: windowEvaluation.reusedRows,
        boundariesValid: windowEvaluation.boundariesValid,
        boundariesNonOverlapping: windowEvaluation.boundariesNonOverlapping,
        passes: windowEvaluation.passes,
      },
    },
    promotionReviewReady,
    formalPromotionEligible: promotionReviewReady && latestReview?.passed === true,
    latestReview: latestReview ? {
      checkpointSettled: Number(
        latestReview.checkpointSettled ?? latestReview.checkpointFinalized ?? 0,
      ),
      observedSettled: Number(
        latestReview.observedSettled ?? latestReview.observedFinalized ?? 0,
      ),
      checkpointFinalized: Number(latestReview.checkpointFinalized || 0),
      observedFinalized: Number(latestReview.observedFinalized || 0),
      recordedAt: latestReview.recordedAt || null,
      datasetHash: latestReview.datasetHash || null,
      datasetHashVersion: latestReview.datasetHashVersion || null,
      datasetRows: Number(latestReview.datasetRows || 0),
      passed: latestReview.passed === true,
    } : null,
    blockers,
    policy:
      "A frozen candidate remains shadow-only until a preregistered checkpoint independently confirms both probability endpoints on post-activation rows.",
  };
};

const reviewCheckpointFor = (count) => {
  if (count < MIN_FORMAL_SETTLED) return null;
  return MIN_FORMAL_SETTLED
    + Math.floor((count - MIN_FORMAL_SETTLED) / REVIEW_INTERVAL) * REVIEW_INTERVAL;
};

const formalSettledReviewDataset = (ledger, checkpoint) => {
  const decisions = new Map(
    ledgerEvents(ledger, "decision")
      .filter((event) => event.phase === "formal")
      .map((event) => [event.eventHash, event]),
  );
  const seenDecisionHashes = new Set();
  return ledgerEvents(ledger, "settlement")
    .filter((event) => event.valid === true && decisions.has(event.decisionEventHash))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .filter((settlement) => {
      if (seenDecisionHashes.has(settlement.decisionEventHash)) return false;
      seenDecisionHashes.add(settlement.decisionEventHash);
      return true;
    })
    .slice(0, checkpoint)
    .map((settlement) => ({
      decision: decisions.get(settlement.decisionEventHash),
      settlement,
    }));
};

const reviewCheckpointAuditProjection = (audit) => ({
  version: REVIEW_CHECKPOINT_AUDIT_VERSION,
  evaluatedAt: audit?.evaluatedAt || null,
  chainValid: audit?.chainValid === true,
  totalCandidatesEverTested: Number(audit?.totalCandidatesEverTested || 0),
  cohort: {
    formal: canonicalize(audit?.cohort?.formal || {}),
  },
  decisionRecord: canonicalize(audit?.decisionRecord || {}),
  settlementRecord: canonicalize(audit?.settlementRecord || {}),
  metrics: {
    formalRows: Number(audit?.metrics?.formalRows || 0),
    logLossImprovement: audit?.metrics?.logLossImprovement ?? null,
    brierImprovement: audit?.metrics?.brierImprovement ?? null,
    invalidShare: audit?.metrics?.invalidShare ?? null,
    singleAttestorShare: audit?.metrics?.singleAttestorShare ?? null,
    bootstrap: canonicalize(audit?.metrics?.bootstrap || {}),
    windows: canonicalize(audit?.metrics?.windows || []),
    windowEvaluation: canonicalize(audit?.metrics?.windowEvaluation || {}),
  },
  promotionReviewReady: audit?.promotionReviewReady === true,
  blockers: [...(audit?.blockers || [])],
});

const buildReviewCheckpointEvidence = (ledger, checkpoint, {
  totalCandidatesEverTested = 1,
} = {}) => {
  const dataset = formalSettledReviewDataset(ledger, checkpoint);
  const boundarySettlement = dataset.length === checkpoint
    ? dataset.at(-1)?.settlement || null
    : null;
  const boundarySequence = Number(boundarySettlement?.sequence || 0);
  if (
    !Number.isInteger(checkpoint)
    || checkpoint < 1
    || dataset.length !== checkpoint
    || !Number.isInteger(boundarySequence)
    || boundarySequence < 1
    || ledger.events[boundarySequence - 1]?.eventHash !== boundarySettlement.eventHash
  ) {
    return {
      complete: false,
      dataset,
      sourceBoundary: null,
      sourceBoundaryHash: null,
      audit: null,
      auditHash: null,
    };
  }
  const prefixEvents = ledger.events.slice(0, boundarySequence);
  const prefixLedger = {
    ...ledger,
    events: prefixEvents,
    rootHash: prefixEvents.at(-1)?.eventHash || GENESIS_HASH,
  };
  const checkpointAudit = auditLedger(prefixLedger, {
    totalCandidatesEverTested,
    evaluatedAt: boundarySettlement.recordedAt,
    verifyReviewCheckpoints: false,
  });
  const sourceBoundary = {
    version: REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION,
    checkpointSettled: checkpoint,
    settlementSequence: boundarySequence,
    settlementEventHash: boundarySettlement.eventHash,
    decisionEventHash: boundarySettlement.decisionEventHash,
    prefixRootHash: prefixLedger.rootHash,
  };
  const projectedAudit = reviewCheckpointAuditProjection(checkpointAudit);
  return {
    complete: true,
    dataset,
    sourceBoundary,
    sourceBoundaryHash: sha256(sourceBoundary),
    audit: projectedAudit,
    auditHash: sha256(projectedAudit),
  };
};

const appendDueReview = (ledger, audit, evaluatedAt) => {
  const due = reviewCheckpointFor(audit.cohort.formal.settled);
  if (!due) return;
  const existing = new Set(
    ledgerEvents(ledger, "review").map((event) => Number(
      event.checkpointSettled ?? event.checkpointFinalized,
    )),
  );
  for (
    let checkpoint = MIN_FORMAL_SETTLED;
    checkpoint <= due;
    checkpoint += REVIEW_INTERVAL
  ) {
    if (existing.has(checkpoint)) continue;
    const evidence = buildReviewCheckpointEvidence(ledger, checkpoint, {
      totalCandidatesEverTested: audit.totalCandidatesEverTested,
    });
    if (!evidence.complete) continue;
    appendEvent(ledger, {
      type: "review",
      recordedAt: isoTime(evaluatedAt),
      checkpointSettled: checkpoint,
      observedSettled: evidence.audit.cohort.formal.settled,
      observedCurrentSettled: audit.cohort.formal.settled,
      // Compatibility fields retain the old public shape, but their values now
      // refer to valid settled rows rather than exclusions plus settlements.
      checkpointFinalized: checkpoint,
      observedFinalized: evidence.audit.cohort.formal.finalized,
      datasetHashVersion: "candidate-formal-settled-pairs-v1",
      datasetRows: evidence.dataset.length,
      datasetHash: sha256(evidence.dataset),
      checkpointAuditVersion: REVIEW_CHECKPOINT_AUDIT_VERSION,
      checkpointAudit: evidence.audit,
      checkpointAuditHash: evidence.auditHash,
      checkpointSourceBoundaryVersion: REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION,
      checkpointSourceBoundary: evidence.sourceBoundary,
      checkpointSourceBoundaryHash: evidence.sourceBoundaryHash,
      totalCandidatesEverTested: evidence.audit.totalCandidatesEverTested,
      passed: evidence.audit.promotionReviewReady,
      blockers: evidence.audit.blockers,
      onlineEffect: false,
      requiresIndependentHumanAndGlobalGovernanceReview: true,
    });
  }
};

const updateCandidateRegistry = (registry, inventory, evaluatedAt) => {
  const existing = new Set(
    registry.candidateRegistry.map((entry) => entry.candidateRevisionId),
  );
  for (const commitment of inventory.entries) {
    if (existing.has(commitment.candidateRevisionId)) continue;
    registry.candidateRegistry.push({
      candidateRevisionId: commitment.candidateRevisionId,
      baseCandidateId: commitment.baseCandidateId,
      candidateSpecHash: commitment.candidateSpecHash,
      firstSeenAt: isoTime(evaluatedAt),
    });
    existing.add(commitment.candidateRevisionId);
  }
  registry.candidateRegistry.sort((left, right) => (
    left.firstSeenAt.localeCompare(right.firstSeenAt)
    || left.candidateRevisionId.localeCompare(right.candidateRevisionId)
  ));
};

const settleCandidateProspectiveRegistry = ({
  priorRegistry = null,
  matches = [],
  evaluatedAt = new Date().toISOString(),
} = {}) => {
  const priorVerification = verifyRegistry(priorRegistry);
  if (!priorVerification.valid) {
    return {
      registry: priorRegistry,
      chainValid: false,
      changed: false,
      eventsAdded: 0,
      settlementsAdded: 0,
      blockers: priorVerification.blockers,
      audit: null,
    };
  }
  const registry = deepClone(priorRegistry);
  const active = registry?.ledgers?.find(
    (ledger) => ledger?.ledgerId === registry.activeLedgerId,
  ) || null;
  if (!active) {
    return {
      registry,
      chainValid: true,
      changed: false,
      eventsAdded: 0,
      settlementsAdded: 0,
      blockers: ["active-ledger-missing"],
      audit: null,
    };
  }

  const beforeEvents = active.events.length;
  const beforeSettlements = ledgerEvents(active, "settlement").length;
  settleCohort({ ledger: active, matches, evaluatedAt });
  const settlementsAdded = Math.max(
    0,
    ledgerEvents(active, "settlement").length - beforeSettlements,
  );
  let audit = auditLedger(active, {
    totalCandidatesEverTested: registry.candidateRegistry.length,
    evaluatedAt,
  });
  if (settlementsAdded > 0) {
    appendDueReview(active, audit, evaluatedAt);
    audit = auditLedger(active, {
      totalCandidatesEverTested: registry.candidateRegistry.length,
      evaluatedAt,
    });
  }
  const eventsAdded = Math.max(0, active.events.length - beforeEvents);
  if (eventsAdded > 0) registry.updatedAt = isoTime(evaluatedAt);
  const finalVerification = verifyRegistry(registry);
  return {
    registry,
    chainValid: finalVerification.valid,
    changed: eventsAdded > 0,
    eventsAdded,
    settlementsAdded,
    blockers: finalVerification.blockers,
    audit,
  };
};

const updateCandidateProspectiveLedger = ({
  priorRegistry = null,
  candidates = [],
  selectedCandidate = null,
  robustness = null,
  matches = [],
  snapshots = [],
  evaluatedAt = new Date().toISOString(),
  implementationCommitment = {},
  nominationPolicyCommitment = null,
  trustedCollectorCount = 1,
  trustedCollectorResolver = null,
} = {}) => {
  const priorVerification = verifyRegistry(priorRegistry);
  if (!priorVerification.valid) {
    return {
      registry: priorRegistry,
      chainValid: false,
      changed: false,
      blockers: priorVerification.blockers,
      audit: null,
    };
  }
  const registry = priorRegistry
    ? deepClone(priorRegistry)
    : createRegistry(evaluatedAt);
  const beforeHash = sha256(registry);
  const inventory = candidateInventory(candidates, implementationCommitment);
  const inventorySupplied = Array.isArray(candidates) && candidates.length > 0;
  updateCandidateRegistry(registry, inventory, evaluatedAt);
  let commitment = selectedCandidate
    ? buildCandidateCommitment(selectedCandidate, implementationCommitment)
    : null;
  let active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId) || null;
  const activeInventoryCommitment = active
    ? inventory.entries.find((entry) => (
        entry.baseCandidateId === active.header.baseCandidateId
      )) || null
    : null;
  const activeImplementationChanged = Boolean(
    active
    && inventorySupplied
    && sha256(active.header.candidateImplementation || {})
      !== sha256(normalizeCandidateImplementation(implementationCommitment)),
  );
  const activeDefinitionChanged = Boolean(
    activeInventoryCommitment
    && activeInventoryCommitment.candidateRevisionId
      !== active.header.candidateRevisionId
  );
  const activeRevisionChanged = Boolean(
    active
    && inventorySupplied
    && (activeImplementationChanged || activeDefinitionChanged),
  );
  const retrospectiveSelectionChanged = Boolean(
    active
    && commitment
    && active.header.candidateRevisionId !== commitment.candidateRevisionId
  );
  const activeProspectiveTrialLocked = Boolean(active && hasActivatedTrialLineage(registry, active));
  const sameDefinitionRevisions = active ? inventory.entries.filter((entry) => (
    sha256(entry.definition) === sha256(active.header.candidateDefinition)
  )) : [];
  if (activeImplementationChanged && activeProspectiveTrialLocked && sameDefinitionRevisions.length === 1) {
    // Daily retrospective ranking is not authorization to swap the fixed
    // hypothesis during an implementation revision. Its own new proof is needed.
    commitment = sameDefinitionRevisions[0];
  }
  const incomingGateSpecHash = sha256(fixedGateSpec());
  const activeGateSpecChanged = Boolean(
    active
    && active.header.gateSpecHash !== incomingGateSpecHash
  );
  const incomingNominationPolicyCommitment =
    normalizeNominationPolicyCommitment(nominationPolicyCommitment);
  const incomingNominationPolicyHash = nominationPolicyHashFor(
    incomingNominationPolicyCommitment,
  );
  const activeNominationPolicyHash =
    active?.header?.nominationPolicyHash || null;
  const activePostActivationEvidence =
    active ? postActivationEvidenceEvents(active) : [];
  const nominationPolicyChanged = Boolean(
    active
    && incomingNominationPolicyHash
    && activeNominationPolicyHash !== incomingNominationPolicyHash
  );
  const zeroEvidenceNominationPolicyRefreeze = Boolean(
    activeProspectiveTrialLocked
    && nominationPolicyChanged
    && activePostActivationEvidence.length === 0
  );
  if (active
      && !ledgerRetired(active)
      && (
        activeRevisionChanged
        || activeGateSpecChanged
        || zeroEvidenceNominationPolicyRefreeze
        || (
          retrospectiveSelectionChanged
          && !activeProspectiveTrialLocked
        )
      )) {
    appendEvent(active, {
      type: "retirement",
      recordedAt: isoTime(evaluatedAt),
      state: "RETIRED",
      reason: activeRevisionChanged
        ? "active-candidate-implementation-revision-changed-or-removed"
        : activeGateSpecChanged
          ? "active-gate-spec-revision-changed"
        : zeroEvidenceNominationPolicyRefreeze
          ? "zero-evidence-nomination-policy-revision-changed"
          : "pre-activation-selected-candidate-revision-changed",
      replacementCandidateRevisionId: commitment?.candidateRevisionId || null,
      previousNominationPolicyHash: activeNominationPolicyHash,
      replacementNominationPolicyHash: incomingNominationPolicyHash,
      postActivationEvidenceCount: activePostActivationEvidence.length,
      onlineEffect: false,
    });
    registry.activeLedgerId = null;
    active = null;
  }
  if (!active && commitment) {
    active = createLedger({
      commitment,
      inventory,
      evaluatedAt,
      totalCandidatesEverTested: registry.candidateRegistry.length,
      nominationPolicyCommitment: incomingNominationPolicyCommitment,
    });
    registry.ledgers.push(active);
    registry.activeLedgerId = active.ledgerId;
  }
  if (!active) {
    registry.updatedAt = isoTime(evaluatedAt);
    return {
      registry,
      chainValid: true,
      changed: sha256(registry) !== beforeHash,
      blockers: ["selected-candidate-missing"],
      audit: null,
    };
  }
  const robustnessBound = robustness?.selectedCandidate?.id === active.header.baseCandidateId
    && robustness?.family?.inventoryHash === active.header.inventoryHashAtFreeze;
  if (!ledgerActivation(active)
      && robustnessBound
      && robustness?.candidateReadyForProspectiveTest === true) {
    const activationAt = isoTime(evaluatedAt);
    appendEvent(active, {
      type: "activation",
      recordedAt: activationAt,
      activationAt,
      state: "ACTIVE",
      candidateRevisionId: active.header.candidateRevisionId,
      candidateSpecHash: active.header.candidateSpecHash,
      gateSpecHash: active.header.gateSpecHash,
      robustnessVersion: robustness?.version || null,
      robustnessInventoryHash: robustness?.family?.inventoryHash || null,
      robustnessEvidenceHash: sha256(robustness),
      windowBoundaries: buildWindowBoundaries(activationAt),
      shadowRowsBeforeActivationAreObservationalOnly: true,
      onlineEffect: false,
    });
  }
  captureCohort({
    ledger: active,
    matches,
    snapshots,
    evaluatedAt,
    trustedCollectorCount,
    trustedCollectorResolver,
  });
  settleCohort({ ledger: active, matches, evaluatedAt });
  let audit = auditLedger(active, {
    totalCandidatesEverTested: registry.candidateRegistry.length,
    evaluatedAt,
  });
  appendDueReview(active, audit, evaluatedAt);
  audit = auditLedger(active, {
    totalCandidatesEverTested: registry.candidateRegistry.length,
    evaluatedAt,
  });
  registry.updatedAt = isoTime(evaluatedAt);
  const finalVerification = verifyRegistry(registry);
  return {
    registry,
    chainValid: finalVerification.valid,
    changed: sha256(registry) !== beforeHash,
    blockers: finalVerification.blockers,
    audit,
  };
};

module.exports = {
  REGISTRY_VERSION,
  LEDGER_VERSION,
  AUDIT_VERSION,
  CANDIDATE_EVALUATOR_VERSION,
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
  DECISION_RECORD_VERSION,
  ATOMIC_DECISION_VALIDATION_VERSION,
  ATOMIC_DECISION_REQUIRED_FIELDS,
  SETTLEMENT_RECORD_VERSION,
  SETTLEMENT_VALIDATION_VERSION,
  SETTLEMENT_REQUIRED_FIELDS,
  METRIC_DIAGNOSTIC_VERSION,
  METRIC_DIAGNOSTIC_ROW_LIMIT,
  DUAL_MARKET_DECISION_RECORD_VERSION,
  LEAGUE_NORMALIZATION_VERSION,
  GENESIS_HASH,
  DECISION_OFFSET_MINUTES,
  DECISION_DEADLINE_POLICY_VERSION,
  CAPTURE_FINALIZATION_POLICY_VERSION,
  CAPTURE_FINALIZATION_GRACE_SECONDS,
  REVIEW_CHECKPOINT_AUDIT_VERSION,
  REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION,
  MIN_FORMAL_SETTLED,
  MIN_FORMAL_FINALIZED,
  MIN_WINDOWS,
  MIN_WINNING_WINDOWS,
  MIN_FORMAL_ROWS_PER_WINDOW,
  WINDOW_COUNT,
  WINDOW_DAYS,
  REVIEW_INTERVAL,
  DEFAULT_REGISTRY_LOCK_TIMEOUT_MS,
  DEFAULT_REGISTRY_LOCK_STALE_MS,
  REGISTRY_LOCK_OWNER_METADATA_GRACE_MS,
  REGISTRY_LOCK_VERSION,
  GATE_SPEC_RESET_AUTHORIZATION_VERSION,
  canonicalize,
  sha256,
  registryLockFileFor,
  processStartTimeForPid,
  readRegistryLockSnapshot,
  registryLockOwnerIsAlive,
  withCandidateProspectiveRegistryLock,
  normalizeTriplet,
  normalizedLeagueForMatch,
  classifyCandidateDecisionEvidence,
  canonicalFunctionSource,
  candidateEvaluatorSemanticHashes,
  marketProbabilitiesFromOdds,
  temperatureTriplet,
  logPoolTriplet,
  candidateProbabilities,
  buildCandidateCommitment,
  candidateInventory,
  nominationPolicyHashFor,
  postActivationEvidenceEvents,
  candidateGateSpecCompatibility,
  appendEvent,
  verifyLedger,
  verifyRegistry,
  fixedGateSpec,
  assessWindowPerformance,
  buildFormalMetricDiagnostics,
  buildReviewCheckpointEvidence,
  createRegistry,
  createLedger,
  ledgerState,
  buildWindowBoundaries,
  decisionDeadlineFor,
  captureFinalizationFor,
  sameCohortIdentity,
  selectSnapshotAtDeadline,
  buildDecisionEvent,
  atomicDecisionHashFor,
  atomicDecisionRecordBlockers,
  atomicDecisionRecordValid,
  collectorQuorumRecordBlockers,
  dualMarketDecisionRecordFor,
  dualMarketDecisionRecordBlockers,
  settlementRecordBlockers,
  selectOfficialSettlementMatch,
  auditLedger,
  settleCandidateProspectiveRegistry,
  updateCandidateProspectiveLedger,
};
