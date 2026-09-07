"use strict";
const assert = require("node:assert/strict");
const c = require("./candidateProspectiveLedger.cjs");
const r = require("./candidateReleaseContinuity.cjs");
const { nominationSelectionPolicyCommitment } = require("./shadowCandidateRobustness.cjs");
function verifyCandidateRevisionLineage() {
  const candidate = { id: "fixed-hypothesis", role: "shadow-model-candidate", featureSet: ["market"], weights: { market: 1, model: 0, temperature: 0.9 } };
  const challenger = { ...candidate, id: "new-retrospective-winner", weights: { ...candidate.weights, temperature: 1.5 } };
  const candidates = [candidate, challenger], nomination = nominationSelectionPolicyCommitment();
  const implementation = { commitmentVersion: c.CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes: { "candidate-probability-evaluator": c.CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH }, sourceHashes: {}, dependencyLockHash: "" };
  const nextImplementation = { ...implementation, semanticHashes: c.candidateEvaluatorSemanticHashes() };
  const at = "2026-09-07T00:00:00.000Z", later = "2026-09-07T01:00:00.000Z";
  const step = (priorRegistry, impl, selectedCandidate, evaluatedAt, ready, inventory = candidates) => c.updateCandidateProspectiveLedger({
    priorRegistry, candidates: inventory, selectedCandidate, evaluatedAt, implementationCommitment: impl,
    nominationPolicyCommitment: nomination, matches: [], snapshots: [], trustedCollectorCount: 2,
    robustness: { selectedCandidate: { id: selectedCandidate.id }, candidateReadyForProspectiveTest: ready,
      family: { inventoryHash: c.candidateInventory(inventory, impl).hash } } });
  const old = step(null, implementation, candidate, at, true), oldLedger = old.registry.ledgers[0];
  assert.equal(old.audit.state, "ACTIVE");
  const next = step(old.registry, nextImplementation, challenger, later, true);
  const active = value => value.registry.ledgers.find(row => row.ledgerId === value.registry.activeLedgerId);
  const checks = []; const check = (name, fn) => { fn(); checks.push(name); };
  check("implementation revision retains the activated exact hypothesis despite a new winner", () => {
    assert.equal(next.chainValid, true); assert.equal(active(next).header.baseCandidateId, candidate.id);
    assert.deepEqual(active(next).header.candidateDefinition, oldLedger.header.candidateDefinition);
    assert.equal(next.audit.state, "SHADOW"); // challenger readiness is not borrowed
    assert.equal(active(next).events.some(event => event.type === "activation"), false);
  });
  check("old ledger header and entire event prefix survive", () => {
    assert.deepEqual(next.registry.ledgers[0].header, oldLedger.header);
    assert.deepEqual(next.registry.ledgers[0].events.slice(0, oldLedger.events.length), oldLedger.events);
    assert.equal(next.registry.ledgers[0].events.at(-1).replacementCandidateRevisionId, active(next).header.candidateRevisionId);
  });
  check("the next ordinary backtest cannot immediately undo revision continuity", () => {
    const again = step(next.registry, nextImplementation, challenger, "2026-09-07T02:00:00.000Z", true);
    assert.equal(again.chainValid, true); assert.equal(again.registry.activeLedgerId, next.registry.activeLedgerId);
    assert.equal(again.audit.state, "SHADOW"); assert.equal(again.registry.ledgers.length, 2);
  });
  check("multiple implementation-only revisions preserve lineage without activation", () => {
    const thirdImplementation = { ...nextImplementation, semanticHashes: { ...nextImplementation.semanticHashes, "fixture-next-revision": "a".repeat(64) } };
    const third = step(next.registry, thirdImplementation, challenger, "2026-09-07T03:00:00.000Z", true);
    assert.equal(third.chainValid, true); assert.equal(active(third).header.baseCandidateId, candidate.id);
    assert.equal(third.audit.state, "SHADOW"); assert.equal(third.registry.ledgers.length, 3);
  });
  check("ordinary unactivated research ranking still can change its candidate", () => {
    const unfrozen = step(null, implementation, candidate, at, false);
    const changed = step(unfrozen.registry, implementation, challenger, later, false);
    assert.equal(active(changed).header.baseCandidateId, challenger.id);
  });
  check("same ID with changed weights is not an exact-hypothesis continuation", () => {
    const changed = { ...candidate, weights: { ...candidate.weights, temperature: 2 } };
    const result = step(old.registry, nextImplementation, challenger, later, false, [changed, challenger]);
    assert.equal(active(result).header.baseCandidateId, challenger.id);
  });
  for (const boundary of ["gate", "nomination", "definition", "retirement-clock"]) {
    check(`lineage cannot cross a different ${boundary}`, () => {
      const altered = structuredClone(next.registry), prior = altered.ledgers[0];
      if (boundary === "gate") prior.header.gateSpecHash = "a".repeat(64);
      if (boundary === "nomination") prior.header.nominationPolicyHash = "a".repeat(64);
      if (boundary === "definition") prior.header.candidateDefinition.weights.temperature = 7;
      if (boundary === "retirement-clock") {
        const events = prior.events.map(({ sequence, previousHash, eventHash, ...payload }) => payload);
        events.at(-1).recordedAt = "2026-09-07T01:00:01.000Z";
        prior.events = []; prior.rootHash = c.GENESIS_HASH; events.forEach(event => c.appendEvent(prior, event));
      }
      prior.headerHash = c.sha256(prior.header);
      assert.equal(c.verifyRegistry(altered).valid, true, "exercise a rehashed input, not merely the chain rejection");
      const result = step(altered, nextImplementation, challenger, "2026-09-07T02:00:00.000Z", false);
      assert.equal(result.chainValid, true); assert.equal(active(result).header.baseCandidateId, challenger.id);
    });
  }
  check("exact signed transition accepts the real competing-winner update", () => {
    const side = value => ({ candidateRevisionId: value.candidateRevisionId, candidateSpecHash: value.candidateSpecHash,
      implementationHash: c.sha256(value.implementation) });
    const oldCommitment = c.buildCandidateCommitment(candidate, implementation), newCommitment = c.buildCandidateCommitment(candidate, nextImplementation);
    const contract = { version: r.TRANSITION_VERSION, reason: "result-input-timeline-commitment", sourceLedgerId: oldLedger.ledgerId,
      definitionHash: c.sha256(oldCommitment.definition), gateSpecHash: oldLedger.header.gateSpecHash,
      nominationPolicyHash: oldLedger.header.nominationPolicyHash, from: side(oldCommitment), to: side(newCommitment), onlineEffect: false };
    const releaseIdentity = { bundleSha256: "b".repeat(64), releaseSequence: 1 };
    const before = r.registrySnapshot(old.registry, { capturedAt: at, releaseIdentity, revisionTransition: contract });
    const report = r.verifyContinuity(before, next.registry, { checkedAt: later, releaseIdentity, revisionTransition: contract });
    assert.equal(report.ok, true, report.blockers.join(","));
  });
  return { ok: true, checks: checks.length, passed: checks, scope: "real ledger transitions, synthetic candidates; no production writes" };
}
if (require.main === module) console.log(JSON.stringify(verifyCandidateRevisionLineage(), null, 2));
module.exports = { verifyCandidateRevisionLineage };
