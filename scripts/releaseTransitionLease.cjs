"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  captureFinalizationFor,
  decisionDeadlineFor,
} = require("./candidateProspectiveLedger.cjs");
const {
  liveRecommendationCutoffMs,
  parseShanghaiDateTime,
} = require("../src/services/liveRecommendationEligibility.cjs");

const LEASE_VERSION = "candidate-transition-lease-v2";
const DIGEST_VERSION = "candidate-transition-semantic-digest-v2";
const SOURCE_CLOCK_DIGEST_VERSION = "candidate-transition-source-clock-digest-v1";
const TRANSITION_TYPES = Object.freeze({
  decision: "candidate-decision-deadline",
  finalization: "candidate-capture-finalization",
  live: "live-recommendation-cutoff",
  kickoff: "kickoff-archive",
});

class ReleaseTransitionLeaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReleaseTransitionLeaseError";
    this.details = details;
  }
}

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

const sha256 = (value) => crypto
  .createHash("sha256")
  .update(typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(canonicalize(value)))
  .digest("hex");

const nonempty = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const finiteInstant = (value) => {
  const millis = parseShanghaiDateTime(value);
  return Number.isFinite(millis) ? millis : null;
};

const matchIdentityFor = (match, index) => nonempty(
  match?.sourceMatchId || match?.matchId || match?.id,
) || `row-${index}`;

const currentRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.rows)) return payload.rows;
  throw new ReleaseTransitionLeaseError("candidate current JSON has no match array");
};

const assertedOptionalInstant = (value, label, identity) => {
  if (value === undefined || value === null || String(value).trim() === "") return;
  if (!Number.isFinite(parseShanghaiDateTime(value))) {
    throw new ReleaseTransitionLeaseError("candidate current contains an invalid transition clock", {
      matchId: identity,
      field: label,
      value: String(value),
    });
  }
};

const transitionProjection = (payload, refreshAt) => {
  const refreshAtMs = finiteInstant(refreshAt);
  if (!Number.isFinite(refreshAtMs)) {
    throw new ReleaseTransitionLeaseError("refreshAt is invalid", { refreshAt });
  }
  const rows = currentRows(payload);
  const transitionInputRows = [];
  const inventoryRows = [];
  const sourceClockRows = [];
  const byEpoch = new Map();
  const seenIdentities = new Set();

  const addTransition = (epochMs, type, identity) => {
    if (!Number.isFinite(epochMs)) {
      throw new ReleaseTransitionLeaseError("calculated transition epoch is invalid", {
        matchId: identity,
        type,
      });
    }
    if (epochMs <= refreshAtMs) return;
    const key = String(epochMs);
    const existing = byEpoch.get(key) || {
      epochMs,
      at: new Date(epochMs).toISOString(),
      types: new Set(),
      matchIds: new Set(),
      matchesByType: new Map(),
    };
    existing.types.add(type);
    existing.matchIds.add(identity);
    const typeMatches = existing.matchesByType.get(type) || new Set();
    typeMatches.add(identity);
    existing.matchesByType.set(type, typeMatches);
    byEpoch.set(key, existing);
  };

  rows.forEach((match, index) => {
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw new ReleaseTransitionLeaseError("candidate current contains a non-object match", { index });
    }
    const identity = matchIdentityFor(match, index);
    if (seenIdentities.has(identity)) {
      throw new ReleaseTransitionLeaseError("candidate current contains duplicate match identity", {
        matchId: identity,
      });
    }
    seenIdentities.add(identity);
    const kickoffRaw = match?.kickoffTime ?? match?.matchDate;
    assertedOptionalInstant(kickoffRaw, "kickoffTime", identity);
    assertedOptionalInstant(match?.predictionMeta?.cutoffTime, "predictionMeta.cutoffTime", identity);
    assertedOptionalInstant(match?.buyEndTime, "buyEndTime", identity);
    assertedOptionalInstant(match?.cutoffTime, "cutoffTime", identity);

    const kickoffMs = finiteInstant(kickoffRaw);
    if (!Number.isFinite(kickoffMs)) {
      throw new ReleaseTransitionLeaseError("candidate current match has no valid kickoff", {
        matchId: identity,
      });
    }
    const decision = decisionDeadlineFor(match);
    const finalization = captureFinalizationFor(match);
    const liveCutoffMs = liveRecommendationCutoffMs(match);
    if (!Number.isFinite(decision?.millis)
      || !Number.isFinite(finalization?.millis)
      || !Number.isFinite(liveCutoffMs)) {
      throw new ReleaseTransitionLeaseError("candidate transition policy could not resolve every clock", {
        matchId: identity,
      });
    }

    sourceClockRows.push({
      identity,
      kickoffTime: nonempty(kickoffRaw),
      predictionMetaCutoffTime: nonempty(match?.predictionMeta?.cutoffTime),
      buyEndTime: nonempty(match?.buyEndTime),
      cutoffTime: nonempty(match?.cutoffTime),
    });
    const semanticRow = {
      identity,
      kickoffEpochMs: kickoffMs,
      decisionDeadlineEpochMs: decision.millis,
      captureFinalizationEpochMs: finalization.millis,
      liveRecommendationCutoffEpochMs: liveCutoffMs,
    };
    inventoryRows.push(semanticRow);
    if ([decision.millis, finalization.millis, liveCutoffMs, kickoffMs]
      .some((epochMs) => epochMs > refreshAtMs)) {
      transitionInputRows.push(semanticRow);
    }

    // Do not filter by recommendation/admission state. In particular, an
    // excluded candidate still crosses the immutable kickoff archive boundary.
    addTransition(decision.millis, TRANSITION_TYPES.decision, identity);
    addTransition(finalization.millis, TRANSITION_TYPES.finalization, identity);
    addTransition(liveCutoffMs, TRANSITION_TYPES.live, identity);
    addTransition(kickoffMs, TRANSITION_TYPES.kickoff, identity);
  });

  transitionInputRows.sort((left, right) => (
    left.identity.localeCompare(right.identity)
    || left.kickoffEpochMs - right.kickoffEpochMs
  ));
  inventoryRows.sort((left, right) => (
    left.identity.localeCompare(right.identity)
    || left.kickoffEpochMs - right.kickoffEpochMs
  ));
  sourceClockRows.sort((left, right) => left.identity.localeCompare(right.identity));
  const transitions = [...byEpoch.values()]
    .sort((left, right) => left.epochMs - right.epochMs)
    .map((row) => ({
      epochMs: row.epochMs,
      at: row.at,
      types: [...row.types].sort(),
      matchIds: [...row.matchIds].sort(),
      events: [...row.matchesByType.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, matchIds]) => ({ type, matchIds: [...matchIds].sort() })),
    }));
  const digestPayload = {
    version: DIGEST_VERSION,
    rows: transitionInputRows,
  };
  const sourceClockDigestPayload = {
    version: SOURCE_CLOCK_DIGEST_VERSION,
    rows: sourceClockRows,
  };
  const inventoryDigestPayload = {
    version: DIGEST_VERSION,
    scope: "all-current-rows-telemetry-only",
    rows: inventoryRows,
  };
  return {
    refreshAt: new Date(refreshAtMs).toISOString(),
    refreshAtMs,
    matches: rows.length,
    activeMatches: transitionInputRows.length,
    dataDigest: sha256(digestPayload),
    inventoryDigest: sha256(inventoryDigestPayload),
    sourceClockDigest: sha256(sourceClockDigestPayload),
    transitionDigest: sha256(transitions),
    transitions,
    nextTransition: transitions[0]?.at || null,
    nextTransitionEpochMs: transitions[0]?.epochMs ?? null,
  };
};

const positiveInteger = (value, label, { allowZero = false } = {}) => {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ReleaseTransitionLeaseError(`${label} must be an integer >= ${minimum}`, { value });
  }
  return parsed;
};

const transitionWindowDiagnostics = (projection, minimumHorizonSeconds) => {
  const transitions = Array.isArray(projection?.transitions) ? projection.transitions : [];
  const upcomingTransitions = transitions.slice(0, 24).map((row, index) => {
    const nextEpochMs = transitions[index + 1]?.epochMs ?? null;
    return {
      at: row.at,
      types: row.types,
      eventCount: row.events.reduce((total, event) => total + event.matchIds.length, 0),
      horizonAfterSeconds: nextEpochMs === null ? null : (nextEpochMs - row.epochMs) / 1000,
    };
  });
  let nextSafeWindow = null;
  for (let index = 0; index < transitions.length; index += 1) {
    const row = transitions[index];
    const next = transitions[index + 1] || null;
    const horizonAfterSeconds = next === null ? null : (next.epochMs - row.epochMs) / 1000;
    if (next === null || horizonAfterSeconds >= minimumHorizonSeconds) {
      nextSafeWindow = {
        refreshStrictlyAfter: row.at,
        nextTransition: next?.at || null,
        horizonAfterSeconds,
      };
      break;
    }
  }
  return {
    upcomingTransitionCount: transitions.length,
    upcomingTransitions,
    nextSafeWindow,
  };
};

const createTransitionLease = (payload, {
  refreshAt,
  verifierRuntimeMaxSeconds,
  preverifyRefreshBudgetSeconds,
  atomicSwapMarginSeconds,
} = {}) => {
  const runtimeSeconds = positiveInteger(verifierRuntimeMaxSeconds, "verifierRuntimeMaxSeconds");
  const refreshBudgetSeconds = positiveInteger(
    preverifyRefreshBudgetSeconds,
    "preverifyRefreshBudgetSeconds",
    { allowZero: true },
  );
  const swapMarginSeconds = positiveInteger(atomicSwapMarginSeconds, "atomicSwapMarginSeconds");
  const projection = transitionProjection(payload, refreshAt);
  const minimumHorizonSeconds = runtimeSeconds + refreshBudgetSeconds + swapMarginSeconds;
  const availableHorizonSeconds = projection.nextTransitionEpochMs === null
    ? null
    : (projection.nextTransitionEpochMs - projection.refreshAtMs) / 1000;
  if (availableHorizonSeconds !== null && availableHorizonSeconds < minimumHorizonSeconds) {
    throw new ReleaseTransitionLeaseError("candidate transition horizon is too short", {
      refreshAt: projection.refreshAt,
      nextTransition: projection.nextTransition,
      availableHorizonSeconds,
      minimumHorizonSeconds,
      ...transitionWindowDiagnostics(projection, minimumHorizonSeconds),
    });
  }
  return {
    version: LEASE_VERSION,
    digestVersion: DIGEST_VERSION,
    refreshAt: projection.refreshAt,
    nextTransition: projection.nextTransition,
    dataDigest: projection.dataDigest,
    inventoryDigest: projection.inventoryDigest,
    sourceClockDigest: projection.sourceClockDigest,
    transitionDigest: projection.transitionDigest,
    matches: projection.matches,
    activeMatches: projection.activeMatches,
    futureTransitionEpochs: projection.transitions.length,
    transitions: projection.transitions,
    verifierRuntimeMaxSeconds: runtimeSeconds,
    preverifyRefreshBudgetSeconds: refreshBudgetSeconds,
    atomicSwapMarginSeconds: swapMarginSeconds,
    minimumHorizonSeconds,
    availableHorizonSeconds,
  };
};

const verifyTransitionLease = (payload, lease, { verifiedAt, requiredMarginSeconds = null } = {}) => {
  if (lease?.version !== LEASE_VERSION || lease?.digestVersion !== DIGEST_VERSION) {
    throw new ReleaseTransitionLeaseError("transition lease version is invalid");
  }
  const verifiedAtMs = finiteInstant(verifiedAt);
  const refreshAtMs = finiteInstant(lease.refreshAt);
  if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(refreshAtMs) || verifiedAtMs < refreshAtMs) {
    throw new ReleaseTransitionLeaseError("transition lease verification time is invalid", {
      refreshAt: lease?.refreshAt,
      verifiedAt,
    });
  }
  const projection = transitionProjection(payload, lease.refreshAt);
  if (projection.dataDigest !== lease.dataDigest
    || projection.transitionDigest !== lease.transitionDigest
    || projection.nextTransition !== lease.nextTransition
    || projection.activeMatches !== lease.activeMatches) {
    throw new ReleaseTransitionLeaseError("candidate transition data changed after lease creation", {
      expectedDataDigest: lease.dataDigest,
      actualDataDigest: projection.dataDigest,
      expectedInventoryDigest: lease.inventoryDigest || null,
      actualInventoryDigest: projection.inventoryDigest,
      expectedSourceClockDigest: lease.sourceClockDigest || null,
      actualSourceClockDigest: projection.sourceClockDigest,
      expectedTransitionDigest: lease.transitionDigest,
      actualTransitionDigest: projection.transitionDigest,
      expectedActiveMatches: lease.activeMatches,
      actualActiveMatches: projection.activeMatches,
    });
  }
  const swapMarginSeconds = positiveInteger(
    lease.atomicSwapMarginSeconds,
    "atomicSwapMarginSeconds",
  );
  const requiredTransitionMarginSeconds = requiredMarginSeconds === null
    || requiredMarginSeconds === undefined
    ? swapMarginSeconds
    : Math.max(
        swapMarginSeconds,
        positiveInteger(requiredMarginSeconds, "requiredMarginSeconds"),
      );
  const nextTransitionMs = projection.nextTransitionEpochMs;
  const remainingSeconds = nextTransitionMs === null
    ? null
    : (nextTransitionMs - verifiedAtMs) / 1000;
  if (nextTransitionMs !== null && verifiedAtMs >= nextTransitionMs) {
    throw new ReleaseTransitionLeaseError("candidate transition was crossed during verification", {
      verifiedAt: new Date(verifiedAtMs).toISOString(),
      nextTransition: projection.nextTransition,
    });
  }
  if (remainingSeconds !== null && remainingSeconds < requiredTransitionMarginSeconds) {
    throw new ReleaseTransitionLeaseError("candidate transition lease lacks required transition margin", {
      remainingSeconds,
      atomicSwapMarginSeconds: swapMarginSeconds,
      requiredMarginSeconds: requiredTransitionMarginSeconds,
    });
  }
  return {
    ok: true,
    version: LEASE_VERSION,
    refreshAt: projection.refreshAt,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    nextTransition: projection.nextTransition,
    remainingSeconds,
    atomicSwapMarginSeconds: swapMarginSeconds,
    requiredMarginSeconds: requiredTransitionMarginSeconds,
    dataDigest: projection.dataDigest,
    inventoryDigest: projection.inventoryDigest,
    inventoryChanged: Boolean(
      lease.inventoryDigest && projection.inventoryDigest !== lease.inventoryDigest
    ),
    sourceClockDigest: projection.sourceClockDigest,
    sourceClockChanged: Boolean(
      lease.sourceClockDigest && projection.sourceClockDigest !== lease.sourceClockDigest
    ),
    transitionDigest: projection.transitionDigest,
    matches: projection.matches,
    matchesChanged: projection.matches !== lease.matches,
    activeMatches: projection.activeMatches,
    futureTransitionEpochs: projection.transitions.length,
  };
};

const readRegularJson = (filePath, label) => {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new ReleaseTransitionLeaseError(`${label} must be a single-link regular file`, { filePath });
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const writeLeaseAtomic = (filePath, lease) => {
  const parent = path.dirname(filePath);
  const parentInfo = fs.lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new ReleaseTransitionLeaseError("lease parent must be a real directory", { parent });
  }
  if (fs.existsSync(filePath) || fs.lstatSync(filePath, { throwIfNoEntry: false })) {
    throw new ReleaseTransitionLeaseError("transition lease output already exists", { filePath });
  }
  const temporary = `${filePath}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
};

const parseCli = (argv) => {
  const [mode, ...tokens] = argv;
  if (!new Set(["probe", "create", "verify"]).has(mode)) {
    throw new ReleaseTransitionLeaseError("mode must be probe, create or verify");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new ReleaseTransitionLeaseError("invalid CLI option", { flag });
    }
    options[flag.slice(2)] = value;
  }
  return { mode, options };
};

const main = (argv = process.argv.slice(2)) => {
  const { mode, options } = parseCli(argv);
  const currentPath = path.resolve(options.current || "");
  if (mode === "probe" && options.lease !== undefined) {
    throw new ReleaseTransitionLeaseError("read-only probe does not accept --lease");
  }
  if (!options.current || !options.at || (mode !== "probe" && !options.lease)) {
    if (mode === "probe") {
      throw new ReleaseTransitionLeaseError("--current and --at are required");
    }
    throw new ReleaseTransitionLeaseError("--current, --lease and --at are required");
  }
  const payload = readRegularJson(currentPath, "candidate current JSON");
  if (mode === "probe" || mode === "create") {
    const lease = createTransitionLease(payload, {
      refreshAt: options.at,
      verifierRuntimeMaxSeconds: options["verifier-runtime-max-seconds"],
      preverifyRefreshBudgetSeconds: options["preverify-refresh-budget-seconds"],
      atomicSwapMarginSeconds: options["atomic-swap-margin-seconds"],
    });
    // A successful probe is advisory only: it neither creates a lease nor
    // reserves a window. The candidate and final CAS must still be checked.
    if (mode === "create") writeLeaseAtomic(path.resolve(options.lease), lease);
    process.stdout.write(`${JSON.stringify({ ok: true, mode, ...lease })}\n`);
    return lease;
  }
  const lease = readRegularJson(path.resolve(options.lease), "transition lease");
  const result = verifyTransitionLease(payload, lease, {
    verifiedAt: options.at,
    requiredMarginSeconds: options["required-margin-seconds"] ?? null,
  });
  process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`);
  return result;
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error?.message || String(error),
      details: error?.details || null,
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  DIGEST_VERSION,
  LEASE_VERSION,
  SOURCE_CLOCK_DIGEST_VERSION,
  ReleaseTransitionLeaseError,
  TRANSITION_TYPES,
  createTransitionLease,
  main,
  transitionProjection,
  verifyTransitionLease,
};
