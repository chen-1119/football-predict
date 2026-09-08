"use strict";
const assert = require("node:assert/strict");
const c = require("./candidateProspectiveLedger.cjs"), r = require("./candidateReleaseContinuity.cjs");
const { nominationSelectionPolicyCommitment } = require("./shadowCandidateRobustness.cjs");
function run() {
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const clone = value => JSON.parse(JSON.stringify(value)), at = "2026-09-07T00:00:00.000Z", later = "2026-09-07T01:00:00.000Z";
  const candidate = { id: "fixed-transition-draft", role: "shadow-model-candidate", featureSet: ["market"], weights: { market: 1, model: 0, temperature: 1 } };
  const releaseIdentity = { bundleSha256: "d".repeat(64), releaseSequence: 711 };
  const make = semanticHashes => {
    const implementation = { commitmentVersion: c.CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
      semanticHashes, sourceHashes: {}, dependencyLockHash: "" };
    const commitment = c.buildCandidateCommitment(candidate, implementation), registry = c.createRegistry(at);
    const ledger = c.createLedger({ commitment, inventory: c.candidateInventory([candidate], implementation),
      evaluatedAt: at, totalCandidatesEverTested: 1, nominationPolicyCommitment: nominationSelectionPolicyCommitment() });
    registry.ledgers.push(ledger); registry.activeLedgerId = ledger.ledgerId;
    registry.candidateRegistry.push({ candidateRevisionId: commitment.candidateRevisionId, baseCandidateId: candidate.id,
      candidateSpecHash: commitment.candidateSpecHash, firstSeenAt: at });
    return registry;
  };
  for (const [label, sourceHashes] of Object.entries({
    original: { "candidate-probability-evaluator": c.CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH },
    priorTimeline: { "candidate-probability-evaluator": c.CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
      "result-input-timeline": "d6df711e018d849041a6590af112bc618e9a71b33d0c955129a1fd9d20134e7a" },
  })) {
    const registry = make(sourceHashes), original = JSON.stringify(registry), prior = registry.ledgers[0];
    const contract = r.buildRevisionTransitionContract(registry);
    check(`${label}: deterministic draft preserves the exact source and hypothesis`, () => {
      assert.equal(JSON.stringify(registry), original);
      assert.deepEqual(r.buildRevisionTransitionContract(registry), contract);
      assert.deepEqual(contract.sourceDefinition, prior.header.candidateDefinition);
      assert.deepEqual(contract.sourceImplementation, prior.header.candidateImplementation);
      assert.equal(contract.sourceLedgerId, registry.activeLedgerId);
      assert.equal(contract.from.candidateSpecHash, prior.header.candidateSpecHash);
      assert.equal(contract.onlineEffect, false); assert.deepEqual(r.transitionContractBlockers(contract), []);
    });
    const before = r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: contract });
    check(`${label}: changing a returned draft cannot mutate source weights or evidence`, () => {
      const detached = r.buildRevisionTransitionContract(registry);
      detached.sourceDefinition.weights.model = 999;
      detached.sourceImplementation.semanticHashes["candidate-probability-evaluator"] = "bad";
      assert.equal(JSON.stringify(registry), original);
    });
    const implementation = { ...contract.sourceImplementation, semanticHashes: c.candidateEvaluatorSemanticHashes() };
    const inventory = c.candidateInventory([candidate], implementation);
    const next = c.updateCandidateProspectiveLedger({ priorRegistry: registry, candidates: [candidate], selectedCandidate: candidate,
      robustness: { candidateReadyForProspectiveTest: false, selectedCandidate: { id: candidate.id }, family: { inventoryHash: inventory.hash } },
      matches: [], snapshots: [], evaluatedAt: later, implementationCommitment: implementation,
      nominationPolicyCommitment: prior.header.nominationPolicyCommitment, trustedCollectorCount: 2 });
    check(`${label}: real refreeze keeps the old prefix and starts a new empty shadow`, () => {
      const report = r.verifyContinuity(before, next.registry, { checkedAt: later, releaseIdentity, revisionTransition: contract });
      assert.equal(report.ok, true, JSON.stringify(report.blockers)); assert.equal(r.revisionTransitionReportValid(report), true);
      assert.deepEqual(next.registry.ledgers[0].header, prior.header);
      assert.deepEqual(next.registry.ledgers[0].events.slice(0, prior.events.length), prior.events);
      assert.deepEqual(report.continuedLedger.counts, before.counts);
      assert.ok(Object.values(report.after.counts).every(value => value === 0)); assert.equal(next.audit.state, "SHADOW");
    });
    check(`${label}: same implementation cannot manufacture another reset`, () => {
      assert.throws(() => r.buildRevisionTransitionContract(next.registry), /no valid implementation-only transition/);
    });
    check(`${label}: a copied declaration cannot bind a different live ledger`, () => {
      const wrong = clone(contract); wrong.sourceLedgerId = "candidate-" + "a".repeat(24);
      assert.throws(() => r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: wrong }), /cannot be bound/);
    });
    for (const [name, mutate] of Object.entries({
      sourceHash: draft => { draft.sourceImplementation.semanticHashes.uncommitted = "f".repeat(64); },
      weights: draft => { draft.sourceDefinition.weights.model = 1; },
      partial: draft => { delete draft.sourceImplementation; },
    })) check(`${label}: reject tampered ${name} source description`, () => {
      const wrong = clone(contract); mutate(wrong);
      assert.ok(r.transitionContractBlockers(wrong).some(value => value.startsWith("transition-source-description-")));
      assert.throws(() => r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: wrong }), /cannot be bound/);
    });
  }
  check("absent or broken registry cannot produce a plausible declaration", () => {
    assert.throws(() => r.buildRevisionTransitionContract(null), /invalid or absent/);
    const bad = make({ previous: "old-fixture" }); bad.ledgers[0].events[0].recordedAt = later;
    assert.throws(() => r.buildRevisionTransitionContract(bad), /invalid or absent/);
  });
  return { ok: true, checks, productionWrites: 0, providerRequests: 0,
    scope: "pure declaration producer plus actual isolated continuity consumer; no live source identity, signing or activation" };
}
module.exports = { run };
if (require.main === module) console.log(JSON.stringify(run(), null, 2));
