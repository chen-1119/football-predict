const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCollectorKeyPair } = require("../src/services/collectorAttestation.cjs");
const { summarizeRecentCollectorEvidenceStore } = require("../server/collectorQuorumEvidence.cjs");
const {
  buildFastLaneSnapshot,
  validateFastLaneUploadUrl,
} = require("./syncServerDirectSportteryEvidence.cjs");

const now = "2026-08-21T15:00:00.000Z";
const pair = createCollectorKeyPair({
  keyId: "server-direct-verifier",
  independenceDomain: "server-direct-verifier-runtime",
});
const row = (method, receivedAt = now) => ({
  evidenceId: `${method}-${receivedAt}`,
  acceptedAt: receivedAt,
  receivedAt,
  method,
  keyId: pair.keyId,
  independenceDomain: "untrusted-claim-is-ignored",
});
const summary = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current"), row("calculator")] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(summary.trustedCollectorCount, 1);
assert.deepEqual(summary.independenceDomains, ["server-direct-verifier-runtime"]);
assert.deepEqual(summary.domains[0].methods, ["calculator", "current"]);

const incomplete = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current")] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(incomplete.trustedCollectorCount, 0, "both official market endpoints are required");

const stale = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [
    row("current", "2026-08-21T14:30:00.000Z"),
    row("calculator", "2026-08-21T14:30:00.000Z"),
  ] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(stale.trustedCollectorCount, 0, "stale collector evidence is not counted");

const disabledRegistry = {
  ...pair.registry,
  keys: pair.registry.keys.map((key) => ({ ...key, enabled: false })),
};
const disabled = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current"), row("calculator")] },
  trustRegistry: disabledRegistry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(disabled.trustedCollectorCount, 0, "disabled trust keys are not counted");

const rootDir = path.resolve(__dirname, "..");
const syncSource = fs.readFileSync(path.join(__dirname, "syncServerDirectSportteryEvidence.cjs"), "utf8");
const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
assert.ok(
  syncSource.indexOf("process.env.ADMIN_TOKEN") < syncSource.indexOf("process.env.FOOTBALL_CLOUD_ADMIN_TOKEN"),
  "the local admin endpoint token must take precedence over unrelated cloud tokens",
);
assert.ok(serverSource.includes("collectorEvidenceStoreSummary.independenceDomains"));

const fastLane = buildFastLaneSnapshot({
  sourceCycleId: "new-server-sporttery:test-cycle",
  endpoints: [
    {
      id: "current",
      method: "current",
      ok: true,
      rows: 32,
      requestedAt: "2026-08-21T14:59:58.000Z",
      receivedAt: "2026-08-21T14:59:59.000Z",
      payload: { value: [] },
    },
    {
      id: "calculator",
      method: "calculator",
      ok: true,
      rows: 32,
      requestedAt: "2026-08-21T14:59:59.000Z",
      receivedAt: now,
      payload: { value: [] },
    },
  ],
  errors: [],
}, { keyId: pair.keyId, maxAgeMinutes: 20 });
assert.equal(fastLane.source, "sporttery-relay-snapshot");
assert.equal(fastLane.summary.rows, 64);
assert.deepEqual(fastLane.summary.methods, ["calculator", "current"]);
assert.equal(fastLane.capturedAt, "2026-08-21T14:59:58.000Z");
assert.equal(fastLane.completedAt, now);
assert.equal(
  validateFastLaneUploadUrl().href,
  "http://127.0.0.1:8788/api/admin/sporttery-relay-fast-lane?runSync=0",
);
assert.throws(
  () => validateFastLaneUploadUrl("http://127.0.0.1/api/admin/sporttery-relay-fast-lane?runSync=1"),
  /invalid/,
);
assert.throws(
  () => buildFastLaneSnapshot({ ...fastLane, endpoints: fastLane.endpoints.slice(0, 1) }, { keyId: pair.keyId }),
  /complete current and calculator/,
);

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: 14,
  trustedCollectorCount: summary.trustedCollectorCount,
  independenceDomains: summary.independenceDomains,
}, null, 2));
