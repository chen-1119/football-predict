"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const c = require("./candidateProspectiveLedger.cjs");
const r = require("./candidateReleaseContinuity.cjs");
const { nominationSelectionPolicyCommitment } = require("./shadowCandidateRobustness.cjs");

const run = () => {
  const passed = [];
  const check = (name, fn) => { fn(); passed.push(name); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const at = "2026-09-07T00:00:00.000Z", later = "2026-09-07T01:00:00.000Z";
  const releaseIdentity = { bundleSha256: "b".repeat(64), releaseSequence: 700 };
  const candidate = { id: "timeline-transition-fixture", role: "shadow-model-candidate",
    featureSet: ["market"], weights: { market: 1, currentModel: 0, temperature: 1 } };
  const implementation = { commitmentVersion: c.CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes: { "candidate-probability-evaluator": c.CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH },
    sourceHashes: {}, dependencyLockHash: "" };
  const nomination = nominationSelectionPolicyCommitment();
  const inventory = c.candidateInventory([candidate], implementation);
  const oldCommitment = c.buildCandidateCommitment(candidate, implementation);
  const registry = c.createRegistry(at);
  const ledger = c.createLedger({ commitment: oldCommitment, inventory, evaluatedAt: at,
    totalCandidatesEverTested: 1, nominationPolicyCommitment: nomination });
  registry.activeLedgerId = ledger.ledgerId;
  registry.ledgers.push(ledger);
  registry.candidateRegistry.push({ candidateRevisionId: oldCommitment.candidateRevisionId,
    baseCandidateId: oldCommitment.baseCandidateId, candidateSpecHash: oldCommitment.candidateSpecHash, firstSeenAt: at });
  const nextImplementation = { ...implementation, semanticHashes: c.candidateEvaluatorSemanticHashes() };
  const nextCommitment = c.buildCandidateCommitment(candidate, nextImplementation);
  const side = (commitment) => ({ candidateRevisionId: commitment.candidateRevisionId,
    candidateSpecHash: commitment.candidateSpecHash, implementationHash: c.sha256(commitment.implementation) });
  const contract = { version: r.TRANSITION_VERSION, reason: "result-input-timeline-commitment",
    sourceLedgerId: ledger.ledgerId, definitionHash: c.sha256(oldCommitment.definition),
    gateSpecHash: ledger.header.gateSpecHash, nominationPolicyHash: ledger.header.nominationPolicyHash,
    from: side(oldCommitment), to: side(nextCommitment), onlineEffect: false };
  const nextInventory = c.candidateInventory([candidate], nextImplementation);
  const updated = c.updateCandidateProspectiveLedger({ priorRegistry: registry, candidates: [candidate],
    selectedCandidate: candidate, robustness: { candidateReadyForProspectiveTest: false,
      selectedCandidate: { id: candidate.id }, family: { inventoryHash: nextInventory.hash } },
    matches: [], snapshots: [], evaluatedAt: later, implementationCommitment: nextImplementation,
    nominationPolicyCommitment: nomination, trustedCollectorCount: 2 });
  assert.equal(updated.chainValid, true);
  const before = r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: contract });
  const verify = (current = updated.registry, baseline = before, declaration = contract) => r.verifyContinuity(
    baseline, current, { checkedAt: later, releaseIdentity, revisionTransition: declaration },
  );
  const rebuild = (row, mutate) => {
    const payloads = row.events.map(({ sequence, previousHash, eventHash, ...payload }) => payload);
    mutate(payloads);
    row.events = []; row.rootHash = c.GENESIS_HASH;
    payloads.forEach((event) => c.appendEvent(row, event));
  };
  check("real refreeze passes only an exact bound declaration; old events retained", () => {
    const report = verify();
    assert.equal(report.ok, true, JSON.stringify(report.blockers));
    assert.equal(report.eventsAdded, 1);
    assert.equal(report.continuedLedger.activeLedgerId, before.activeLedgerId);
    assert.notEqual(report.after.activeLedgerId, before.activeLedgerId);
    assert.equal(report.policy.activeIdentityStable, false);
    assert.equal(report.revisionTransition.required, true);
  });
  check("default continuity still rejects the same real refreeze", () => {
    const plain = r.registrySnapshot(registry, { capturedAt: at, releaseIdentity });
    assert.equal(verify(updated.registry, plain, null).ok, false);
  });
  check("remote marker validates old continuity and actual new identity separately", () => {
    assert.equal(r.revisionTransitionReportValid(verify()), true);
    const bad = verify(); bad.continuedLedger.activeLedgerId = bad.after.activeLedgerId;
    assert.equal(r.revisionTransitionReportValid(bad), false);
  });
  check("remote marker rejects missing or altered bindings", () => {
    for (const mutate of [
      (x) => { delete x.before.revisionTransition; },
      (x) => { x.revisionTransition.contractHash = "c".repeat(64); },
      (x) => { x.after.releaseIdentity.bundleSha256 = "c".repeat(64); },
      (x) => { x.after.activeCommitment.implementationHash = "c".repeat(64); },
      (x) => { x.after.registryContinuity.ledgerContinuity.shift(); },
    ]) {
      const bad = clone(verify()); mutate(bad);
      assert.equal(r.revisionTransitionReportValid(bad), false);
    }
  });
  check("declaration cannot be removed after snapshot", () => assert.equal(verify(updated.registry, before, null).ok, false));
  check("required transition cannot silently stay on old implementation", () => assert.equal(verify(registry).ok, false));
  check("release identity required before binding", () => assert.throws(() => r.registrySnapshot(registry,
    { capturedAt: at, revisionTransition: contract }), /release identity/));
  check("release identity cannot be replayed across bundles", () => assert.equal(r.verifyContinuity(before, updated.registry,
    { checkedAt: later, releaseIdentity: { ...releaseIdentity, bundleSha256: "c".repeat(64) }, revisionTransition: contract }).ok, false));
  for (const field of ["sourceLedgerId", "definitionHash", "gateSpecHash", "nominationPolicyHash"]) {
    check(`wrong ${field} rejected before live mutation`, () => {
      const bad = { ...contract, [field]: field === "sourceLedgerId" ? `candidate-${"a".repeat(24)}` : "a".repeat(64) };
      assert.throws(() => r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: bad }));
    });
  }
  check("declared target must equal actual deployed evaluator commitment", () => {
    const bad = clone(contract); bad.to.implementationHash = "a".repeat(64);
    assert.throws(() => r.registrySnapshot(registry, { capturedAt: at, releaseIdentity, revisionTransition: bad }));
  });
  check("changed contract between snapshot and verification rejected", () => {
    assert.equal(verify(updated.registry, before, { ...contract, onlineEffect: true }).ok, false);
  });
  check("old valid-chain event rewrite rejected", () => {
    const bad = clone(updated.registry);
    rebuild(bad.ledgers[0], (events) => { events[0].recordedAt = later; });
    assert.equal(c.verifyRegistry(bad).valid, true);
    assert.ok(verify(bad).blockers.includes(`ledger-event-prefix-mismatch:${ledger.ledgerId}`));
  });
  check("old header rewrite rejected even when rehashed", () => {
    const bad = clone(updated.registry); bad.ledgers[0].header.retrospectiveSelectionNote = "changed";
    bad.ledgers[0].headerHash = c.sha256(bad.ledgers[0].header);
    assert.equal(c.verifyRegistry(bad).valid, true);
    assert.ok(verify(bad).blockers.includes(`ledger-header-changed:${ledger.ledgerId}`));
  });
  check("old audit count regression not hidden by new active cohort", () => {
    const bad = clone(before); bad.counts.admitted += 1;
    assert.ok(verify(updated.registry, bad).blockers.includes("admitted-count-regressed"));
  });
  check("old ledger removal rejected", () => {
    const bad = clone(updated.registry); bad.ledgers.shift(); assert.equal(verify(bad).ok, false);
  });
  check("registry prefix rewrite rejected", () => {
    const bad = clone(updated.registry); bad.candidateRegistry[0].firstSeenAt = later;
    assert.ok(verify(bad).blockers.includes("candidate-registry-prefix-mismatch"));
  });
  check("retirement without exact replacement rejected", () => {
    const bad = clone(updated.registry);
    rebuild(bad.ledgers[0], (events) => { events.at(-1).replacementCandidateRevisionId = "unknown"; });
    assert.ok(verify(bad).blockers.includes("transition-retirement-invalid"));
  });
  check("new ledger cannot predate frozen release baseline", () => {
    const bad = clone(updated.registry); bad.ledgers[1].header.frozenAt = "2026-09-06T00:00:00Z";
    bad.ledgers[1].headerHash = c.sha256(bad.ledgers[1].header);
    assert.ok(verify(bad).blockers.includes("transition-freeze-clock-invalid"));
  });
  check("new event cannot import old observation clocks", () => {
    const bad = clone(updated.registry);
    rebuild(bad.ledgers[1], (events) => { events[1].recordedAt = at; });
    assert.ok(verify(bad).blockers.includes("transition-new-event-clock-or-effect-invalid"));
  });
  check("migration cannot grant automatic online promotion", () => {
    const bad = clone(updated.registry);
    rebuild(bad.ledgers[1], (events) => { events[1].onlineEffect = true; });
    assert.ok(verify(bad).blockers.includes("transition-new-event-clock-or-effect-invalid"));
  });
  check("activation must use fresh preregistered windows", () => {
    const bad = clone(updated.registry);
    c.appendEvent(bad.ledgers[1], { type: "activation", recordedAt: later, activationAt: later,
      windowBoundaries: c.buildWindowBoundaries(at), onlineEffect: false });
    assert.ok(verify(bad).blockers.includes("transition-activation-window-invalid"));
  });
  check("declaration already applied does not permit another active switch", () => {
    const baseline = r.registrySnapshot(updated.registry, { capturedAt: later, releaseIdentity, revisionTransition: contract });
    assert.equal(baseline.revisionTransition.mode, "already-applied");
    assert.equal(verify(updated.registry, baseline).ok, true);
    const bad = clone(updated.registry); bad.activeLedgerId = ledger.ledgerId;
    assert.equal(verify(bad, baseline).ok, false);
  });
  check("signed production declaration matches current target semantics", () => {
    const production = require("../deploy/light-server/candidate-revision-transition.json");
    assert.deepEqual(r.transitionContractBlockers(production), []);
    const definition = { featureSet: ["sporttery-market", "current-probability-model", "negative-model-residual", "temperature-calibration"],
      id: "market-current-model-residual-minus-20-temperature-0_9", role: "shadow-model-candidate",
      weights: { market: 1.2, model: -0.2, temperature: 0.9 } };
    const target = c.buildCandidateCommitment(definition, {
      ...(production.sourceImplementation || implementation), semanticHashes: c.candidateEvaluatorSemanticHashes(),
    });
    assert.deepEqual(production.to, side(target));
    // New implementation-only transitions may start from an already revised
    // ledger. Its exact normalized inputs are bound by the signed declaration
    // and rechecked against the actual source registry by the release runner.
    const sourceDefinition = production.sourceDefinition || definition;
    assert.deepEqual(sourceDefinition, definition, "production hypothesis cannot change with an implementation-only transition");
    assert.deepEqual(production.from, side(c.buildCandidateCommitment(sourceDefinition,
      production.sourceImplementation || implementation)));
    assert.equal(production.gateSpecHash, c.sha256(c.fixedGateSpec()));
    assert.equal(production.nominationPolicyHash, c.sha256(nomination));
  });
  check("actual CLI binds declaration and verifies real refreeze", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-revision-transition-"));
    try {
      for (const [name, data] of Object.entries({ registry, contract, updated: updated.registry })) {
        fs.writeFileSync(path.join(temp, `${name}.json`), JSON.stringify(data));
      }
      const cli = (mode, input, extra) => spawnSync(process.execPath, [path.join(__dirname, "candidateReleaseContinuity.cjs"), mode,
        "--registry", path.join(temp, `${input}.json`), "--revision-transition", path.join(temp, "contract.json"),
        "--bundle-sha256", releaseIdentity.bundleSha256, "--release-sequence", String(releaseIdentity.releaseSequence), ...extra], { encoding: "utf8" });
      const snapshot = cli("snapshot", "registry", ["--at", at, "--output", path.join(temp, "before.json")]);
      assert.equal(snapshot.status, 0, snapshot.stderr);
      const result = cli("verify", "updated", ["--at", later, "--snapshot", path.join(temp, "before.json")]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).revisionTransition.required, true);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  return { checks: passed.length, passed };
};

if (require.main === module) console.log(JSON.stringify({ ok: true, ...run() }, null, 2));
module.exports = { run };
