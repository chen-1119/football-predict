"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  GENESIS_HASH,
  auditLedger,
  buildCandidateCommitment,
  buildWindowBoundaries,
  candidateEvaluatorSemanticHashes,
  sha256,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");

const SNAPSHOT_VERSION = "candidate-release-continuity-snapshot-v1";
const VERIFICATION_VERSION = "candidate-release-continuity-verification-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COUNT_FIELDS = ["admitted", "atomic", "settled", "formal", "finalized"];
const TRANSITION_VERSION = "candidate-release-revision-transition-v1";

const commitmentSummary = (ledger) => ({
  headerHash: ledger.headerHash,
  candidateRevisionId: ledger.header.candidateRevisionId,
  candidateSpecHash: ledger.header.candidateSpecHash,
  definitionHash: sha256(ledger.header.candidateDefinition),
  implementationHash: sha256(ledger.header.candidateImplementation),
  semanticHashes: ledger.header.candidateImplementation?.semanticHashes,
  gateSpecHash: ledger.header.gateSpecHash,
  nominationPolicyHash: ledger.header.nominationPolicyHash,
  frozenAt: ledger.header.frozenAt,
});

// This is a declaration shipped INSIDE the signed release bundle, not a reset
// flag or an approval to change selection/gates. Only one exact source ledger
// may move to one exact new implementation of the same candidate definition.
const transitionContractBlockers = (contract) => {
  const blockers = [];
  if (contract?.version !== TRANSITION_VERSION
      || contract?.reason !== "result-input-timeline-commitment"
      || !/^candidate-[a-f0-9]{24}$/.test(contract?.sourceLedgerId || "")
      || contract?.onlineEffect !== false) blockers.push("transition-contract-invalid");
  for (const value of [contract?.definitionHash, contract?.gateSpecHash,
    contract?.nominationPolicyHash, contract?.from?.candidateSpecHash,
    contract?.from?.implementationHash, contract?.to?.candidateSpecHash,
    contract?.to?.implementationHash]) {
    if (!SHA256_PATTERN.test(value || "")) blockers.push("transition-contract-hash-invalid");
  }
  for (const side of [contract?.from, contract?.to]) {
    if (!side?.candidateRevisionId?.endsWith(`@${side?.candidateSpecHash?.slice(0, 16)}`)) {
      blockers.push("transition-contract-revision-invalid");
    }
  }
  if (contract?.from?.candidateRevisionId === contract?.to?.candidateRevisionId
      || contract?.from?.implementationHash === contract?.to?.implementationHash) {
    blockers.push("transition-contract-no-implementation-change");
  }
  return [...new Set(blockers)];
};

const commitmentMatches = (summary, side, contract) => Boolean(summary
  && summary.candidateRevisionId === side?.candidateRevisionId
  && summary.candidateSpecHash === side?.candidateSpecHash
  && summary.implementationHash === side?.implementationHash
  && summary.definitionHash === contract?.definitionHash
  && summary.gateSpecHash === contract?.gateSpecHash
  && summary.nominationPolicyHash === contract?.nominationPolicyHash);

const bindRevisionTransition = (registry, contract, releaseIdentity) => {
  if (!contract) return null;
  const blockers = transitionContractBlockers(contract);
  normalizeReleaseIdentity(releaseIdentity, { required: true });
  const active = activeLedgerFor(registry);
  const summary = active && commitmentSummary(active);
  const alreadyApplied = commitmentMatches(summary, contract.to, contract);
  if (!alreadyApplied && (active?.ledgerId !== contract.sourceLedgerId
      || !commitmentMatches(summary, contract.from, contract))) {
    blockers.push("transition-source-not-exact");
  }
  if (active) {
    const next = buildCandidateCommitment(active.header.candidateDefinition, {
      ...active.header.candidateImplementation,
      semanticHashes: candidateEvaluatorSemanticHashes(),
    });
    if (next.candidateRevisionId !== contract.to?.candidateRevisionId
        || next.candidateSpecHash !== contract.to?.candidateSpecHash
        || sha256(next.implementation) !== contract.to?.implementationHash) {
      blockers.push("transition-target-not-current-implementation");
    }
  }
  if (blockers.length) throw new CandidateReleaseContinuityError(
    "candidate revision transition cannot be bound", { blockers },
  );
  return { contract, contractHash: sha256(contract),
    mode: alreadyApplied ? "already-applied" : "required",
    releaseIdentity: normalizeReleaseIdentity(releaseIdentity, { required: true }) };
};

const verifyRevisionTransition = (before, registry, contract, checkedAt) => {
  const binding = before?.revisionTransition;
  if (!binding && !contract) return { required: false, ok: true, blockers: [] };
  const blockers = transitionContractBlockers(contract);
  if (!binding || binding.contractHash !== sha256(contract)
      || sha256(binding.contract ?? null) !== binding.contractHash
      || sha256(binding.releaseIdentity ?? null) !== sha256(before.releaseIdentity ?? null)
      || !["required", "already-applied"].includes(binding.mode)) {
    blockers.push("transition-snapshot-binding-mismatch");
  }
  const required = binding?.mode === "required";
  const old = registry?.ledgers?.find((row) => row.ledgerId === before?.activeLedgerId);
  const next = activeLedgerFor(registry);
  if (!next || !commitmentMatches(commitmentSummary(next), contract?.to, contract)) {
    blockers.push("transition-target-not-exact");
  }
  if (required) {
    if (before.activeLedgerId !== contract?.sourceLedgerId
        || !commitmentMatches(before.activeCommitment, contract?.from, contract)
        || !old || !commitmentMatches(commitmentSummary(old), contract?.from, contract)) {
      blockers.push("transition-source-not-exact");
    }
    if (before.registryContinuity?.ledgerContinuity?.some((row) => (
      row.ledgerId === next?.ledgerId || row.candidateRevisionId === contract?.to?.candidateRevisionId
    ))) blockers.push("transition-target-ledger-not-new");
    const retirement = old?.events?.filter((row) => row.type === "retirement") || [];
    if (retirement.length !== 1
        || retirement[0].sequence <= before.eventCount
        || retirement[0].reason !== "active-candidate-implementation-revision-changed-or-removed"
        || retirement[0].replacementCandidateRevisionId !== contract?.to?.candidateRevisionId
        || retirement[0].state !== "RETIRED" || retirement[0].onlineEffect !== false) {
      blockers.push("transition-retirement-invalid");
    }
    const frozen = strictInstant(next?.header?.frozenAt);
    const start = strictInstant(before.capturedAt);
    const end = strictInstant(checkedAt);
    const retirementAt = strictInstant(retirement[0]?.recordedAt);
    if (!frozen || !start || !end || !retirementAt
        || Date.parse(frozen) < Date.parse(start) || Date.parse(frozen) > Date.parse(end)
        || Date.parse(retirementAt) < Date.parse(start)
        || Date.parse(retirementAt) > Date.parse(frozen)) {
      blockers.push("transition-freeze-clock-invalid");
    }
    for (const event of next?.events || []) {
      const time = strictInstant(event.recordedAt);
      if (!time || !frozen || !end || Date.parse(time) < Date.parse(frozen)
          || Date.parse(time) > Date.parse(end) || event.onlineEffect !== false) {
        blockers.push("transition-new-event-clock-or-effect-invalid");
      }
      if (event.candidateRevisionId && event.candidateRevisionId !== contract?.to?.candidateRevisionId) {
        blockers.push("transition-new-event-revision-mismatch");
      }
      if (event.type === "decision") {
        for (const key of ["decisionAt", "snapshotCapturedAt", "snapshotFirstSeenAt"]) {
          const clock = strictInstant(event[key]);
          if (!clock || !frozen || Date.parse(clock) < Date.parse(frozen)) {
            blockers.push("transition-pre-freeze-decision-evidence");
          }
        }
      }
      if (event.type === "activation") {
        const activation = strictInstant(event.activationAt);
        if (!activation || !frozen || Date.parse(activation) < Date.parse(frozen)
            || activation !== event.recordedAt
            || sha256(event.windowBoundaries) !== sha256(buildWindowBoundaries(activation))) {
          blockers.push("transition-activation-window-invalid");
        }
      }
    }
    if (next?.events?.[0]?.type !== "freeze" || next?.events?.[1]?.type !== "shadow-start") {
      blockers.push("transition-new-ledger-start-invalid");
    }
  }
  return { required, ok: blockers.length === 0, contractHash: binding?.contractHash || null,
    sourceLedgerId: before?.activeLedgerId, targetLedgerId: next?.ledgerId || null,
    blockers: [...new Set(blockers)] };
};

// Validate the root-owned remote completion report without pretending that the
// actual active identity remained unchanged. This is NOT a replacement for the
// release-time registry verification above; the marker is authenticated by SSH
// and is separately bound to both committed release SHA markers by the caller.
const revisionTransitionReportValid = (report) => {
  try {
    const { before, after, continuedLedger: continued, revisionTransition: transition } = report;
    const binding = before?.revisionTransition, contract = binding?.contract;
    if (binding?.mode !== "required" || transition?.required !== true || transition?.ok !== true
        || transition.blockers?.length !== 0 || transitionContractBlockers(contract).length
        || binding.contractHash !== sha256(contract) || transition.contractHash !== binding.contractHash
        || sha256(normalizeReleaseIdentity(binding.releaseIdentity, { required: true }))
          !== sha256(normalizeReleaseIdentity(report.releaseIdentity, { required: true }))
        || sha256(before.releaseIdentity) !== sha256(report.releaseIdentity)
        || sha256(after.releaseIdentity) !== sha256(report.releaseIdentity)
        || sha256(continued?.releaseIdentity) !== sha256(report.releaseIdentity)
        || before.activeLedgerId !== contract.sourceLedgerId
        || transition.sourceLedgerId !== before.activeLedgerId
        || transition.targetLedgerId !== after.activeLedgerId
        || continued.activeLedgerId !== before.activeLedgerId
        || continued.candidateRevisionId !== before.candidateRevisionId
        || before.activeLedgerId === after.activeLedgerId
        || !commitmentMatches(before.activeCommitment, contract.from, contract)
        || !commitmentMatches(continued.activeCommitment, contract.from, contract)
        || !commitmentMatches(after.activeCommitment, contract.to, contract)
        || before.activeCommitment.headerHash !== continued.activeCommitment.headerHash
        || [before, after, continued].some((snapshot) => snapshotBlockers(snapshot).length)) return false;
    const oldInActualRegistry = after.registryContinuity.ledgerContinuity.find((row) => row.ledgerId === before.activeLedgerId);
    if (!oldInActualRegistry || oldInActualRegistry.headerHash !== continued.activeCommitment.headerHash
        || oldInActualRegistry.rootHash !== continued.rootHash
        || oldInActualRegistry.eventCount !== continued.eventCount
        || sha256(oldInActualRegistry.canonicalEventHashSequence) !== sha256(continued.canonicalEventHashSequence)
        || before.registryContinuity.ledgerContinuity.some((row) => row.ledgerId === after.activeLedgerId)) return false;
    for (const prior of before.registryContinuity.ledgerContinuity) {
      const current = after.registryContinuity.ledgerContinuity.find((row) => row.ledgerId === prior.ledgerId);
      if (!current || prior.candidateRevisionId !== current.candidateRevisionId
          || (prior.headerHash && prior.headerHash !== current.headerHash)
          || current.eventCount < prior.eventCount
          || prior.canonicalEventHashSequence.some((hash, i) => hash !== current.canonicalEventHashSequence[i])) return false;
    }
    if (before.registryContinuity.candidateRegistryHashSequence.some((hash, i) => (
      hash !== after.registryContinuity.candidateRegistryHashSequence[i]
    ))) return false;
    return continued.chainValid === true
      && before.canonicalEventHashSequence.every((hash, i) => hash === continued.canonicalEventHashSequence[i])
      && COUNT_FIELDS.every((field) => continued.counts[field] >= before.counts[field]);
  } catch { return false; }
};

const normalizeReleaseIdentity = (value, { required = false } = {}) => {
  if (value == null && !required) return null;
  const bundleSha256 = String(value?.bundleSha256 || "").trim().toLowerCase();
  const releaseSequence = Number(value?.releaseSequence);
  if (!SHA256_PATTERN.test(bundleSha256)
      || !Number.isSafeInteger(releaseSequence)
      || releaseSequence <= 0) {
    throw new CandidateReleaseContinuityError("release identity is invalid", {
      bundleSha256: bundleSha256 || null,
      releaseSequence: Number.isFinite(releaseSequence) ? releaseSequence : null,
    });
  }
  return { bundleSha256, releaseSequence };
};

class CandidateReleaseContinuityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CandidateReleaseContinuityError";
    this.details = details;
  }
}

const nonNegativeInteger = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
};

const readJsonFile = (filePath, label) => {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new CandidateReleaseContinuityError(`${label} is unavailable`, {
      file: resolved,
      reason: error.message || String(error),
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CandidateReleaseContinuityError(`${label} must be a regular file`, {
      file: resolved,
    });
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new CandidateReleaseContinuityError(`${label} is not valid JSON`, {
      file: resolved,
      reason: error.message || String(error),
    });
  }
};

const writeJsonAtomic = (filePath, payload) => {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  try {
    const existing = fs.lstatSync(resolved);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new CandidateReleaseContinuityError(
        "refusing to replace a non-regular continuity output",
        { file: resolved },
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, resolved);
    try {
      fs.chmodSync(resolved, 0o600);
    } catch {
      // Windows does not implement POSIX modes; the atomic write is still valid.
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return resolved;
};

const activeLedgerFor = (registry) => (
  registry?.ledgers?.find((ledger) => ledger?.ledgerId === registry.activeLedgerId)
  || null
);

const registrySnapshot = (registry, {
  capturedAt = new Date().toISOString(),
  registryPath = null,
  releaseIdentity = null,
  revisionTransition = null,
} = {}) => {
  const chain = verifyRegistry(registry);
  if (!registry || chain.valid !== true) {
    throw new CandidateReleaseContinuityError("candidate registry chain is invalid", {
      blockers: chain.blockers || ["registry-missing"],
    });
  }
  const activeLedger = activeLedgerFor(registry);
  if (!activeLedger) {
    throw new CandidateReleaseContinuityError("candidate registry has no active ledger", {
      activeLedgerId: registry.activeLedgerId || null,
    });
  }
  const audit = auditLedger(activeLedger, {
    totalCandidatesEverTested: Array.isArray(registry.candidateRegistry)
      ? registry.candidateRegistry.length
      : 0,
    evaluatedAt: capturedAt,
  });
  const canonicalEventHashSequence = activeLedger.events.map((event) => (
    String(event?.eventHash || "").toLowerCase()
  ));
  const counts = {
    admitted: nonNegativeInteger(audit?.decisionRecord?.admittedRows),
    atomic: nonNegativeInteger(audit?.decisionRecord?.atomicRows),
    settled: nonNegativeInteger(audit?.settlementRecord?.rows),
    formal: nonNegativeInteger(audit?.metrics?.formalRows),
    finalized: nonNegativeInteger(audit?.cohort?.formal?.finalized),
  };
  const invalidCounts = COUNT_FIELDS.filter((field) => counts[field] === null);
  if (invalidCounts.length) {
    throw new CandidateReleaseContinuityError("candidate audit contains invalid counts", {
      invalidCounts,
      counts,
    });
  }
  const rootHash = String(activeLedger.rootHash || "").toLowerCase();
  if (!SHA256_PATTERN.test(rootHash)
      || canonicalEventHashSequence.some((hash) => !SHA256_PATTERN.test(hash))) {
    throw new CandidateReleaseContinuityError("candidate ledger hashes are invalid", {
      rootHash,
      eventCount: canonicalEventHashSequence.length,
    });
  }
  const ledgerContinuity = (registry.ledgers || []).map((ledger) => ({
    ledgerId: ledger.ledgerId,
    headerHash: ledger.headerHash,
    candidateRevisionId: ledger.header?.candidateRevisionId || null,
    eventCount: Array.isArray(ledger.events) ? ledger.events.length : 0,
    canonicalEventHashSequence: (ledger.events || []).map((event) => (
      String(event?.eventHash || "").toLowerCase()
    )),
    rootHash: String(ledger.rootHash || "").toLowerCase(),
  }));
  const candidateRegistryHashSequence = (registry.candidateRegistry || [])
    .map((entry) => sha256(entry));
  return {
    version: SNAPSHOT_VERSION,
    capturedAt,
    registryPath: registryPath ? path.resolve(registryPath) : null,
    chainValid: true,
    activeLedgerId: activeLedger.ledgerId,
    candidateRevisionId: activeLedger.header?.candidateRevisionId || null,
    activeCommitment: commitmentSummary(activeLedger),
    eventCount: canonicalEventHashSequence.length,
    canonicalEventHashSequence,
    rootHash,
    counts,
    releaseIdentity: normalizeReleaseIdentity(releaseIdentity),
    revisionTransition: bindRevisionTransition(registry, revisionTransition, releaseIdentity),
    registryContinuity: {
      activeLedgerId: registry.activeLedgerId,
      ledgerContinuity,
      candidateRegistryHashSequence,
    },
  };
};

const snapshotBlockers = (snapshot) => {
  const blockers = [];
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
    return ["baseline-snapshot-version-invalid"];
  }
  if (snapshot.chainValid !== true) blockers.push("baseline-chain-not-valid");
  if (!String(snapshot.activeLedgerId || "").trim()) {
    blockers.push("baseline-active-ledger-id-missing");
  }
  if (!String(snapshot.candidateRevisionId || "").trim()) {
    blockers.push("baseline-candidate-revision-id-missing");
  }
  if (!SHA256_PATTERN.test(String(snapshot.rootHash || "").toLowerCase())) {
    blockers.push("baseline-root-hash-invalid");
  }
  if (!Array.isArray(snapshot.canonicalEventHashSequence)) {
    blockers.push("baseline-event-hash-sequence-invalid");
  } else {
    if (snapshot.canonicalEventHashSequence.some((hash) => (
      !SHA256_PATTERN.test(String(hash || "").toLowerCase())
    ))) blockers.push("baseline-event-hash-invalid");
    if (nonNegativeInteger(snapshot.eventCount)
        !== snapshot.canonicalEventHashSequence.length) {
      blockers.push("baseline-event-count-mismatch");
    }
    const expectedRoot = snapshot.canonicalEventHashSequence.at(-1) || GENESIS_HASH;
    if (String(snapshot.rootHash || "").toLowerCase() !== expectedRoot) {
      blockers.push("baseline-root-sequence-mismatch");
    }
  }
  for (const field of COUNT_FIELDS) {
    if (nonNegativeInteger(snapshot.counts?.[field]) === null) {
      blockers.push(`baseline-${field}-count-invalid`);
    }
  }
  if (!snapshot.registryContinuity
      || snapshot.registryContinuity.activeLedgerId !== snapshot.activeLedgerId
      || !Array.isArray(snapshot.registryContinuity.ledgerContinuity)
      || !Array.isArray(snapshot.registryContinuity.candidateRegistryHashSequence)) {
    blockers.push("baseline-registry-continuity-invalid");
  } else {
    if (snapshot.registryContinuity.candidateRegistryHashSequence.some((hash) => (
      !SHA256_PATTERN.test(String(hash || "").toLowerCase())
    ))) blockers.push("baseline-candidate-registry-hash-invalid");
    for (const ledger of snapshot.registryContinuity.ledgerContinuity) {
      const hashes = ledger?.canonicalEventHashSequence;
      const expectedRoot = Array.isArray(hashes) ? (hashes.at(-1) || GENESIS_HASH) : null;
      if (!String(ledger?.ledgerId || "").trim()
          || !String(ledger?.candidateRevisionId || "").trim()
          || !Array.isArray(hashes)
          || hashes.some((hash) => !SHA256_PATTERN.test(String(hash || "").toLowerCase()))
          || nonNegativeInteger(ledger?.eventCount) !== hashes?.length
          || String(ledger?.rootHash || "").toLowerCase() !== expectedRoot) {
        blockers.push("baseline-ledger-continuity-invalid");
        break;
      }
    }
  }
  return blockers;
};

const verifyContinuity = (before, registry, {
  checkedAt = new Date().toISOString(),
  registryPath = null,
  releaseIdentity = null,
  revisionTransition = null,
} = {}) => {
  const blockers = snapshotBlockers(before);
  let expectedReleaseIdentity = null;
  try {
    expectedReleaseIdentity = normalizeReleaseIdentity(releaseIdentity);
  } catch {
    blockers.push("expected-release-identity-invalid");
  }
  if (expectedReleaseIdentity) {
    let baselineReleaseIdentity = null;
    try {
      baselineReleaseIdentity = normalizeReleaseIdentity(before?.releaseIdentity, { required: true });
    } catch {
      blockers.push("baseline-release-identity-invalid");
    }
    if (baselineReleaseIdentity
        && (baselineReleaseIdentity.bundleSha256 !== expectedReleaseIdentity.bundleSha256
          || baselineReleaseIdentity.releaseSequence !== expectedReleaseIdentity.releaseSequence)) {
      blockers.push("baseline-release-identity-mismatch");
    }
  }
  let after = null;
  try {
    after = registrySnapshot(registry, {
      capturedAt: checkedAt,
      registryPath,
      releaseIdentity: expectedReleaseIdentity || before?.releaseIdentity || null,
    });
  } catch (error) {
    if (error instanceof CandidateReleaseContinuityError) {
      blockers.push("current-registry-invalid");
      for (const blocker of error.details?.blockers || []) {
        blockers.push(`current:${blocker}`);
      }
    } else {
      throw error;
    }
  }

  const transition = verifyRevisionTransition(before, registry, revisionTransition, checkedAt);
  blockers.push(...transition.blockers);
  let continuedLedger = null;
  if (transition.required && after && transition.ok) {
    continuedLedger = registrySnapshot({ ...registry, activeLedgerId: before.activeLedgerId }, {
      capturedAt: checkedAt, registryPath, releaseIdentity: after.releaseIdentity,
    });
  }
  if (after) {
    // The old ledger remains the continuity subject during a declared revision
    // migration. The actual new active ledger is still reported in `after`.
    const comparison = continuedLedger || after;
    if (before?.activeLedgerId !== comparison.activeLedgerId) {
      blockers.push("active-ledger-id-changed");
    }
    if (before?.candidateRevisionId !== comparison.candidateRevisionId) {
      blockers.push("candidate-revision-id-changed");
    }
    const beforeHashes = Array.isArray(before?.canonicalEventHashSequence)
      ? before.canonicalEventHashSequence.map((hash) => String(hash).toLowerCase())
      : [];
    const afterHashes = comparison.canonicalEventHashSequence;
    if (afterHashes.length < beforeHashes.length) {
      blockers.push("event-sequence-regressed");
    }
    const sharedLength = Math.min(beforeHashes.length, afterHashes.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (beforeHashes[index] !== afterHashes[index]) {
        blockers.push(`event-prefix-mismatch:${index + 1}`);
        break;
      }
    }
    for (const field of COUNT_FIELDS) {
      const beforeCount = nonNegativeInteger(before?.counts?.[field]);
      const afterCount = nonNegativeInteger(comparison.counts[field]);
      if (beforeCount !== null && afterCount !== null && afterCount < beforeCount) {
        blockers.push(`${field}-count-regressed`);
      }
    }
    if (afterHashes.length === beforeHashes.length
        && String(before?.rootHash || "").toLowerCase() !== comparison.rootHash) {
      blockers.push("root-changed-without-new-events");
    }
    const beforeRegistry = before?.registryContinuity || {};
    const afterRegistry = after.registryContinuity || {};
    const beforeCandidates = Array.isArray(beforeRegistry.candidateRegistryHashSequence)
      ? beforeRegistry.candidateRegistryHashSequence
      : [];
    const afterCandidates = Array.isArray(afterRegistry.candidateRegistryHashSequence)
      ? afterRegistry.candidateRegistryHashSequence
      : [];
    if (afterCandidates.length < beforeCandidates.length) {
      blockers.push("candidate-registry-regressed");
    } else if (beforeCandidates.some((hash, index) => hash !== afterCandidates[index])) {
      blockers.push("candidate-registry-prefix-mismatch");
    }
    const afterLedgers = new Map((afterRegistry.ledgerContinuity || [])
      .map((ledger) => [ledger.ledgerId, ledger]));
    for (const beforeLedger of beforeRegistry.ledgerContinuity || []) {
      const afterLedger = afterLedgers.get(beforeLedger.ledgerId);
      if (!afterLedger) {
        blockers.push(`ledger-missing:${beforeLedger.ledgerId}`);
        continue;
      }
      if (beforeLedger.candidateRevisionId !== afterLedger.candidateRevisionId) {
        blockers.push(`ledger-revision-changed:${beforeLedger.ledgerId}`);
      }
      if (beforeLedger.headerHash && beforeLedger.headerHash !== afterLedger.headerHash) {
        blockers.push(`ledger-header-changed:${beforeLedger.ledgerId}`);
      }
      const priorHashes = beforeLedger.canonicalEventHashSequence || [];
      const currentHashes = afterLedger.canonicalEventHashSequence || [];
      if (currentHashes.length < priorHashes.length) {
        blockers.push(`ledger-events-regressed:${beforeLedger.ledgerId}`);
      } else if (priorHashes.some((hash, index) => hash !== currentHashes[index])) {
        blockers.push(`ledger-event-prefix-mismatch:${beforeLedger.ledgerId}`);
      }
      if (currentHashes.length === priorHashes.length
          && beforeLedger.rootHash !== afterLedger.rootHash) {
        blockers.push(`ledger-root-changed-without-events:${beforeLedger.ledgerId}`);
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    version: VERIFICATION_VERSION,
    ok: uniqueBlockers.length === 0,
    checkedAt,
    releaseIdentity: after?.releaseIdentity || before?.releaseIdentity || null,
    policy: {
      activeIdentityStable: !transition.required,
      exactDeclaredRevisionTransitionOnly: transition.required,
      priorEventsMustBeExactPrefix: true,
      countsMustBeMonotonic: COUNT_FIELDS,
      unchangedEventCountRequiresSameRoot: true,
    },
    before,
    after,
    continuedLedger,
    revisionTransition: transition,
    eventsAdded: after && Number.isInteger(Number(before?.eventCount))
      ? (continuedLedger || after).eventCount - Number(before.eventCount)
      : null,
    blockers: uniqueBlockers,
  };
};

const parseArgs = (argv) => {
  const mode = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new CandidateReleaseContinuityError("unexpected positional argument", { token });
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CandidateReleaseContinuityError("missing option value", { option: token });
    }
    if (!["registry", "snapshot", "before", "output", "at", "bundle-sha256", "release-sequence", "revision-transition"].includes(name)) {
      throw new CandidateReleaseContinuityError("unknown option", { option: token });
    }
    options[name] = value;
    index += 1;
  }
  return { mode, options };
};

const defaultRegistryPath = () => path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_REGISTRY_FILE
  || path.join(
    process.env.SERVER_STORE_DIR || path.resolve(__dirname, "..", "server-data"),
    "model-artifacts",
    "candidate-prospective-registry.json",
  ),
);

const main = (argv = process.argv.slice(2)) => {
  const { mode, options } = parseArgs(argv);
  if (!["snapshot", "verify"].includes(mode)) {
    throw new CandidateReleaseContinuityError(
      "mode must be snapshot or verify",
      { mode: mode || null },
    );
  }
  const registryPath = path.resolve(options.registry || defaultRegistryPath());
  const registry = readJsonFile(registryPath, "candidate registry");
  const at = options.at || new Date().toISOString();
  const revisionTransition = options["revision-transition"]
    ? readJsonFile(options["revision-transition"], "signed candidate revision transition") : null;
  const releaseIdentity = options["bundle-sha256"] || options["release-sequence"]
    ? normalizeReleaseIdentity({
      bundleSha256: options["bundle-sha256"],
      releaseSequence: options["release-sequence"],
    }, { required: true })
    : null;
  let payload;
  if (mode === "snapshot") {
    payload = registrySnapshot(registry, { capturedAt: at, registryPath, releaseIdentity, revisionTransition });
  } else {
    const snapshotPath = options.snapshot || options.before;
    if (!snapshotPath) {
      throw new CandidateReleaseContinuityError(
        "verify mode requires --snapshot",
      );
    }
    const before = readJsonFile(snapshotPath, "candidate continuity snapshot");
    payload = verifyContinuity(before, registry, {
      checkedAt: at,
      registryPath,
      releaseIdentity,
      revisionTransition,
    });
  }
  if (options.output) writeJsonAtomic(options.output, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload.ok !== false;
};

if (require.main === module) {
  try {
    if (!main()) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      version: VERIFICATION_VERSION,
      checkedAt: new Date().toISOString(),
      error: error.message || String(error),
      details: error.details || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  VERIFICATION_VERSION,
  COUNT_FIELDS,
  TRANSITION_VERSION,
  commitmentSummary,
  transitionContractBlockers,
  commitmentMatches,
  bindRevisionTransition,
  verifyRevisionTransition,
  revisionTransitionReportValid,
  CandidateReleaseContinuityError,
  normalizeReleaseIdentity,
  activeLedgerFor,
  registrySnapshot,
  snapshotBlockers,
  verifyContinuity,
  main,
};
