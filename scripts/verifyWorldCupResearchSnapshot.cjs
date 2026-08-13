const assert = require("node:assert/strict");
const {
  DEFAULT_SNAPSHOT_FILE,
  loadWorldCupResearchSnapshot,
  researchAuditFromSnapshot,
  validateWorldCupResearchSnapshot,
} = require("./worldCupResearchSnapshot.cjs");

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

const loaded = loadWorldCupResearchSnapshot(DEFAULT_SNAPSHOT_FILE);

check("release-bundled World Cup research snapshot is internally consistent", () => {
  assert.equal(loaded.ok, true, loaded.blockers?.join(", "));
  assert.equal(loaded.metrics.settled, 6);
  assert.equal(loaded.metrics.won, 5);
  assert.equal(loaded.metrics.lost, 1);
  assert.equal(loaded.metrics.hitRatePercent, 83.33);
  assert.deepEqual(loaded.metrics.confidence95Percent, [43.65, 96.99]);
});

check("research snapshot remains explicitly ineligible for promotion", () => {
  assert.equal(loaded.snapshot.promotionEligible, false);
  const audit = researchAuditFromSnapshot(loaded);
  assert.equal(audit.source, "release-bundled-frozen-research-snapshot");
  assert.equal(audit.walkForward.selectedRows, 6);
  assert.equal(audit.walkForward.foldCount, 5);
});

check("minimum odds boundary is enforced on every frozen research row", () => {
  assert.ok(loaded.rows.every((row) => row.odds >= 1.2 && row.odds <= 1.85));
});

check("tampered row content fails the frozen row hash", () => {
  const tampered = structuredClone(loaded.snapshot);
  tampered.rows[0].resultStatus = "LOST";
  const validation = validateWorldCupResearchSnapshot(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.blockers.includes("snapshot-row-hash-mismatch"));
});

check("an under-band odds row fails even if its hash is stale", () => {
  const tampered = structuredClone(loaded.snapshot);
  tampered.rows[0].odds = 1.19;
  const validation = validateWorldCupResearchSnapshot(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.blockers.includes("snapshot-row-odds-outside-policy"));
});

check("promotion flag changes fail closed", () => {
  const tampered = structuredClone(loaded.snapshot);
  tampered.promotionEligible = true;
  const validation = validateWorldCupResearchSnapshot(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.blockers.includes("snapshot-promotion-flag-invalid"));
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "world-cup-research-snapshot",
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks,
  snapshot: {
    file: DEFAULT_SNAPSHOT_FILE,
    rows: loaded.rows.length,
    rowsSha256: loaded.rowsSha256,
    metrics: loaded.metrics,
  },
}, null, 2)}\n`);
