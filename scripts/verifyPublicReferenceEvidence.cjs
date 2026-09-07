"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bindPublicReferenceDecision: bind, attestPublicReferenceDecision: attest, pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");
const { digest, verifyPublicReferenceEvidence: verify, collectPublicReferenceEvidence: collect } = require("../src/services/publicReferenceEvidence.cjs");
const { appendPredictionSnapshots, predictionSnapshotRow } = require("./syncData.cjs");
const { buildPublicReferenceArchive, resolvePublicReferenceEvidence: resolve } = require("../server/publicReferenceArchive.cjs");
const { compactPredictionSnapshotAudit } = require("../server/predictionSnapshotAudit.cjs");
const clone = (v) => JSON.parse(JSON.stringify(v));
let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const at = "2026-09-07T01:00:00.000Z";
const match = {
  id: "sporttery_991001", sourceMatchId: "991001", status: "SCHEDULED", businessDate: "2026-09-07",
  kickoffTime: "2026-09-07T12:00:00.000Z", eventVersion: "2026-09-07T12:00:00.000Z", buyEndTime: "2026-09-07T11:55:00.000Z",
  odds: { odds1: 2, oddsX: 3.4, odds2: 4 },
  predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4 }],
  predictionMeta: { generatedAt: at, decisionId: "evidence-test-1", modelVersion: "test-model", policyVersion: "test-policy",
    featureSnapshot: { version: "test-feature", capturedAt: at, sourceMatchId: "991001", kickoffTime: "2026-09-07T12:00:00.000Z", modelInputs: { form: { sampleSize: 3 } } } },
  probabilityModel: { version: "test-model", generatedAt: at, oneXTwo: { final: { home: 35, draw: 40, away: 25 } } },
};
const published = bind(match, null, "2026-09-07T01:00:01.000Z");
const record = published.predictionMeta.publicReferenceDecision;
const entry = pending(published);
check("new public record binds its exact feature and model artifacts", () => {
  assert.equal(record.version, "public-reference-decision-v2");
  assert.equal(record.prediction.tipCode, "X");
  assert.equal(record.evidenceBinding.featureHash, digest(match.predictionMeta.featureSnapshot));
  assert.equal(record.evidenceBinding.modelHash, digest(match.probabilityModel));
  assert.equal(verify(entry, record), true);
});
for (const key of ["featureSnapshot", "probabilityModel", "sourceProof", "publicPrediction", "sourceMatchId", "decisionId", "eventVersion", "decisionAt"]) {
  check("tampered evidence rejected: " + key, () => {
    const bad = clone(entry); bad.evidence[key] = { tampered: true };
    assert.equal(verify(bad, record), false);
    assert.throws(() => collect([record], [bad]), /BINDING_INVALID/);
  });
}
check("a changed binding invalidates the public record hash", () => {
  const bad = clone(record); bad.evidenceBinding.featureHash = "a".repeat(64);
  assert.equal(attest(bad, match), null);
});
check("missing companion fails closed rather than reconstructing history", () => {
  assert.throws(() => collect([record], []), /BINDING_MISSING/);
});
check("private archive resolver verifies both archive and original public record hashes", () => {
  const archive = buildPublicReferenceArchive({ publicReferenceDecisions: [record], publicReferenceEvidence: [entry] });
  assert.equal(resolve(archive, record.contentHash).ok, true);
  const bad = clone(archive); bad.rows[0].prediction.tipCode = "1";
  assert.equal(resolve(bad, record.contentHash).reason, "archive-integrity-invalid");
  bad.contentHash = digest(bad.rows);
  assert.equal(resolve(bad, record.contentHash).reason, "reference-integrity-invalid");
  const badEvidence = clone(archive); badEvidence.evidence[0].evidence.probabilityModel.version = "tampered";
  badEvidence.evidenceContentHash = digest(badEvidence.evidence);
  assert.equal(resolve(badEvidence, record.contentHash).reason, "evidence-integrity-invalid");
});
check("post-capture object mutation cannot modify evidence", () => {
  const m = clone(match); const p = bind(m, null, "2026-09-07T01:00:01.000Z");
  m.probabilityModel.oneXTwo.final.home = 99;
  assert.equal(pending(p).evidence.probabilityModel.oneXTwo.final.home, 35);
});
check("full companion is not serialized into a public match", () => {
  assert.equal(Object.hasOwn(published.predictionMeta, "publicReferenceEvidence"), false);
  assert.equal(JSON.stringify(published).includes('"sourceProof"'), false);
});
for (const mutation of [m => delete m.predictionMeta.featureSnapshot, m => { m.predictionMeta.featureSnapshot.migrated = true; },
  m => { m.predictionMeta.featureSnapshot.capturedAt = "2026-09-07T02:00:00.000Z"; },
  m => { m.predictionMeta.featureSnapshot.sourceMatchId = "wrong"; }, m => delete m.eventVersion]) {
  check("missing, migrated, future or wrong-event inputs never get a binding", () => {
    const m = clone(match); mutation(m); const p = bind(m, null, "2026-09-07T01:00:01.000Z");
    assert.equal(p.predictionMeta.publicReferenceDecision.evidenceBinding, null);
    assert.equal(pending(p), null);
  });
}
check("v1 unchanged reference keeps its exact original hash with no retroactive binding", () => {
  const { evidenceBinding, contentHash, integrityVerified, ...old } = clone(record);
  old.version = "public-reference-decision-v1";
  old.contentHash = digest(old);
  assert.ok(attest(old, match));
  assert.equal(resolve(buildPublicReferenceArchive({ publicReferenceDecisions: [old] }), old.contentHash).reason, "evidence-not-recorded");
  const oldMatch = { ...match, predictionMeta: { ...match.predictionMeta, publicReferenceDecision: old } };
  const again = bind(oldMatch, oldMatch, "2026-09-07T02:00:00.000Z");
  assert.equal(again.predictionMeta.publicReferenceDecision.contentHash, old.contentHash);
  assert.equal(pending(again), null);
});
check("cutoff preserves public draw even when private current model prefers home", () => {
  const m = clone(published); m.status = "LIVE"; m.predictions[0].tipCode = "1";
  const after = bind(m, published, "2026-09-07T12:01:00.000Z");
  assert.equal(after.predictionMeta.publicReferenceDecision.contentHash, record.contentHash);
  assert.equal(pending(after), null);
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-public-evidence-test-"));
try {
  check("real snapshot appender persists companions outside candidate semantics", () => {
    const payload = appendPredictionSnapshots(temp, [published], at, { observationMatches: [] });
    assert.equal(payload.publicReferenceDecisions.length, 1);
    assert.equal(payload.publicReferenceEvidence.length, 1);
    assert.equal(verify(payload.publicReferenceEvidence[0], record), true);
    fs.writeFileSync(path.join(temp, "prediction-snapshots.json"), JSON.stringify(payload));
    const refreshed = bind(published, published, "2026-09-07T02:00:00.000Z");
    const next = appendPredictionSnapshots(temp, [refreshed], at, { observationMatches: [] });
    assert.deepEqual(next.publicReferenceEvidence, payload.publicReferenceEvidence);
    const archive = buildPublicReferenceArchive(next);
    assert.equal(archive.evidence[0].referenceHash, record.contentHash);
    assert.equal(archive.evidenceContentHash, digest(archive.evidence));
  });
  check("admin snapshot pointer survives compacting without exposing full evidence", () => {
    const raw = predictionSnapshotRow(published, at);
    const compact = compactPredictionSnapshotAudit(raw);
    assert.equal(compact.eventVersion, match.eventVersion);
    assert.equal(compact.publicReferenceHash, record.contentHash);
    assert.equal(compact.publicReferenceEvidenceHash, entry.evidenceHash);
    assert.equal(Object.hasOwn(compact, "featureSnapshot"), false);
    assert.equal(Object.hasOwn(compact, "sourceProof"), false);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: true, checks, productionDataTouched: false, admissionChanged: false }, null, 2));
