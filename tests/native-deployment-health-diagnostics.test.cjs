"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { assessHealth, requireHealth } = require("../scripts/verifyNativeDeploymentCore.cjs");
function valid() {
  return { status: { fastResultIntegrityOk: true, recommendationProjectionParityOk: true, recommendationReliable: false },
    data: { currentRead: { source: "postgres" }, recommendations: { projectionParity: { checkedRows: 80, mismatchRows: 0 } } },
    storage: { primary: "postgres", sqlite: { retired: true, available: false, readSource: "postgres" },
      fastResultIntegrity: { valid: true }, postgres: { available: true, baseReady: true,
        publication: { mode: "active-generation", generationId: "g-"+"a".repeat(64), manifestHash: "b".repeat(64), sourceCycleId: "cycle", committedAt: "2026-10-09T10:00:00Z" } } } };
}
test("unchanged complete serving contract passes", () => {
  assert.equal(assessHealth(valid()).ok, true); assert.equal(requireHealth(valid()).ok, true);
});
for (const [key, expected, code] of [
  ["fastResultIntegrityOk", true, "fast-result-integrity-not-ready"],
  ["recommendationProjectionParityOk", true, "recommendation-projection-parity-not-ready"],
  ["recommendationReliable", false, "reference-model-reliability-contract-invalid"],
]) {
  for (const value of [!expected, undefined, null, String(expected), 0]) {
    test(`${key} rejects ${String(value)}`, () => {
      const h = valid(); h.status[key] = value;
      assert(assessHealth(h).blockers.includes(code));
      assert.throws(() => requireHealth(h), e => e.message === "NATIVE_DEPLOYMENT_HEALTH_REJECTED" && e.diagnostic.blockers.includes(code));
    });
  }
}
test("storage gates still reject invalid current generation", () => {
  const h=valid(); h.storage.postgres.publication.generationId="old";
  assert(assessHealth(h).blockers.includes("native-publication-identity-incomplete"));
  assert.throws(()=>requireHealth(h));
});
test("failure records missing archives without accepting or exposing raw predictions", () => {
  const h=valid(); h.status.recommendationProjectionParityOk=false;
  h.data.recommendations.projectionParity={checkedRows:80,listCanonicalMissingRows:1,detailCanonicalMissingRows:1,mismatchRows:1,privatePayload:"SECRET"};
  h.secret="SECRET";
  const original=JSON.stringify(h);
  assert.throws(()=>requireHealth(h),e=>e.diagnostic.projectionCounts.mismatchRows===1&&!JSON.stringify(e.diagnostic).includes("SECRET"));
  assert.equal(JSON.stringify(h),original);
});
test("diagnostic counters are bounded typed aggregates", () => {
  const h=valid(); h.data.recommendations.projectionParity={checkedRows:"secret",mismatchRows:-1};
  assert.equal(assessHealth(h).projectionCounts.checkedRows,null);
  assert.equal(assessHealth(h).projectionCounts.mismatchRows,null);
});
