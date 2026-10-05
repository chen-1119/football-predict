"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createCollectorKeyPair, buildCollectorCommitment, signCollectorCommitment, sha256CollectorJson } = require("../src/services/collectorAttestation.cjs");
const { expectedCollectorCommitment } = require("../server/relayCollectorEvidence.cjs");
const { SPORTTERY_CURRENT_URL, SPORTTERY_CALCULATOR_URL } = require("../scripts/sportteryEndpointContract.cjs");
const ROOT = path.resolve(__dirname, "..");
const CODE = ["scripts/proveOfficialClosureRepair.cjs", "scripts/currentMatchRetention.cjs", "scripts/officialClosedScheduleEvidence.cjs",
  "scripts/resultOnlyValidation.cjs", "scripts/sportteryEndpointContract.cjs", "scripts/validateData.cjs", "server/chunkedJsonFile.cjs",
  "server/relayCollectorEvidence.cjs", "src/services/collectorAttestation.cjs", "src/services/dualMarketDecisionBinding.cjs",
  "src/services/hhadCompanionShadow.cjs", "src/services/matchLifecycle.cjs", "src/services/strictInstant.cjs"];
const baseline = spawnSync("git", ["show", "295a173d117cbb0f889197dbeff13501d79dfd15:scripts/validateData.cjs"],
  { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 10000 });
assert.equal(baseline.status, 0, "local pre-repair validator baseline is required");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
function fixture(options = {}) {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), "football-closure-proof-cli-"));
  for (const name of CODE) { const to = path.join(candidate, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, name), to); }
  fs.writeFileSync(path.join(candidate, "scripts/validateData.baseline.cjs"), baseline.stdout);
  const observedAt = new Date(Date.now() - (options.stale ? 21 * 60000 : 1000)).toISOString();
  const currentPolicyAt = new Date().toISOString();
  const pair = createCollectorKeyPair({ keyId: "synthetic-proof-test-key", independenceDomain: "synthetic-proof-runtime" });
  const sourceCycleId = "synthetic-proof-online-cycle";
  const endpoints = [["current", SPORTTERY_CURRENT_URL, { totalCount: 0 }], ["calculator", SPORTTERY_CALCULATOR_URL,
    { vtoolsConfig: { offLineSaleStatus: 1, onLineSaleStatus: options.salesOpen ? 0 : 1,
      offLineStopMessage: "抱歉，本彩种已停止销售", onLineStopMessage: "抱歉，本彩种已停止销售" } }]].map(([method, url, value]) => {
    const entry = { method, page: null, sourceRequest: { url, method: "GET", page: null, role: method }, sourceCycleId,
      requestedAt: observedAt, receivedAt: observedAt, providerObservedAt: null, httpStatus: 200, httpDate: null,
      httpEtag: null, contentType: "application/json", headersSha256: "a".repeat(64), rawSha256: "b".repeat(64), rawBytes: 100,
      ok: true, rows: 0, payload: { success: true, errorCode: "0", value } };
    entry.canonicalPayloadSha256 = sha256CollectorJson(entry.payload);
    entry.collectorAttestation = signCollectorCommitment(buildCollectorCommitment({ ...expectedCollectorCommitment(entry), payload: entry.payload }), pair);
    return entry;
  });
  if (options.invalidSignature) endpoints[0].collectorAttestation.signature = "A".repeat(88);
  write(path.join(candidate, "proof-input/relay.json"), { capturedAt: observedAt, sourceCycleId, endpoints });
  write(path.join(candidate, "proof-input/registry.json"), pair.registry);
  write(path.join(candidate, "public/data/matches-current.json"), options.nonempty ? [{ id: "synthetic-current" }] : []);
  write(path.join(candidate, "public/data/matches-history.json"), [{ id: "sporttery_991981", sourceMatchId: "991981", source: "sporttery",
    sourceUrl: SPORTTERY_CURRENT_URL, status: "FINISHED", kickoffTime: "2026-09-06T12:00:00.000Z",
    homeTeamColor: "#112233", awayTeamColor: "#445566", predictions: [], scoreHome: 1, scoreAway: 1 }]);
  write(path.join(candidate, "public/data/odds-history.json"), { source: "sporttery:HAD", rows: [] });
  write(path.join(candidate, "public/data/sync-meta.json"), { sourceCycleId: "synthetic-publication-cycle", updatedAt: currentPolicyAt,
    files: { current: options.nonempty ? 1 : 0, history: 1, archivedUnsettled: 0 },
    currentListPolicy: { version: "kickoff-retention-v1", evaluatedAt: currentPolicyAt, archivedUnsettled: 0, unsettledRetentionHours: 48 } });
  write(path.join(candidate, "server-data/matches-unresolved-archive.json"), []);
  fs.mkdirSync(path.join(candidate, "dist"));
  const input = { version: "official-closure-repair-proof-input-v1", capsuleSha256: "c".repeat(64), candidate,
    relayPath: path.join(candidate, "proof-input/relay.json"), trustRegistryPath: path.join(candidate, "proof-input/registry.json"),
    baselineValidatorPath: path.join(candidate, "scripts/validateData.baseline.cjs"), storeDir: path.join(candidate, "server-data"),
    flags: { WRITE_LEGACY_STATIC_PAYLOADS: "0", MIRROR_PUBLISHED_DATA_TO_DIST: "0", ALLOW_LARGE_STATIC_DIST: "0" } };
  const inputPath = path.join(candidate, "proof-input/request.json"), outputPath = path.join(candidate, "repair-proof.json");
  write(inputPath, input);
  const beforeMeta = fs.readFileSync(path.join(candidate, "public/data/sync-meta.json"));
  return { candidate, input, inputPath, outputPath, beforeMeta, run() {
    const child = spawnSync(process.execPath, [path.join(candidate, "scripts/proveOfficialClosureRepair.cjs"), "--input", inputPath, "--output", outputPath],
      { cwd: candidate, encoding: "utf8", windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    const report = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath)) : null;
    return { child, report };
  }, close() {
    const resolved = path.resolve(candidate), temp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith("football-closure-proof-cli-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  } };
}
test("synthetic fresh candidate runs real server/public validators, real old-validator contrast and six negative checks", () => {
  const f = fixture();
  try {
    const { child, report } = f.run(); assert.equal(child.status, 0, child.stderr + child.stdout + JSON.stringify(report?.failure));
    assert.equal(report.ok, true); assert.equal(report.actualClockOnly, true); assert.equal(report.capsuleSha256, f.input.capsuleSha256);
    assert.equal(report.baselineRejected, true); assert.equal(report.baseline.length, 2); assert.equal(report.positive.length, 2);
    assert.deepEqual(report.positive.map(row => row.validationScope), ["server-complete", "public-distribution"]);
    assert.equal(report.negative.length, 3); assert.equal(report.negative.flatMap(row => row.validators).length, 6);
    assert.equal(report.dataIntegrityPreserved, true); assert.equal(report.productionWrites, false); assert.equal(report.generationPublished, false);
    assert.equal(report.completeWorkerPipelineVerified, false); assert.equal(report.marketDataPromoted, false);
    const current = fs.readFileSync(path.join(f.candidate, "public/data/matches-current.json")); assert.equal(current.toString(), "[]\n");
    const updated = JSON.parse(fs.readFileSync(path.join(f.candidate, "public/data/sync-meta.json")));
    assert.equal(updated.currentListPolicy.officialClosedSchedule.proof.snapshot.capturedAt, report.closureAdmission.capturedAt);
    delete updated.currentListPolicy.officialClosedSchedule; assert.deepEqual(updated, JSON.parse(f.beforeMeta));
    assert.equal(report.relay.sha256, hash(fs.readFileSync(f.input.relayPath)));
    assert.equal(report.registry.sha256, hash(fs.readFileSync(f.input.trustRegistryPath)));
  } finally { f.close(); }
});
for (const [label, options, blocker] of [
  ["expired signed source", { stale: true }, "closure-envelope-clock-invalid"],
  ["validly signed open-sales response", { salesOpen: true }, "closure-stop-sale-unproven"],
  ["untrusted signature", { invalidSignature: true }, "current:collector-attestation-signature-invalid"],
]) test(label + " fails under the actual clock without changing candidate data", () => {
  const f = fixture(options);
  try {
    const { child, report } = f.run(); assert.equal(child.status, 1); assert.equal(report.ok, false);
    assert.ok(report.closureAdmission.blockers.includes(blocker), JSON.stringify(report.closureAdmission));
    assert.equal(report.dataIntegrityPreserved, true); assert.deepEqual(fs.readFileSync(path.join(f.candidate, "public/data/sync-meta.json")), f.beforeMeta);
    assert.equal(report.positive.length, 0); assert.equal(report.baselineRejected, false);
  } finally { f.close(); }
});
test("nonempty current cannot use maintenance proof", () => {
  const f = fixture({ nonempty: true });
  try { const { child, report } = f.run(); assert.equal(child.status, 1); assert.match(report.failure.message, /explicit empty current/); assert.equal(report.dataIntegrityPreserved, true); }
  finally { f.close(); }
});
test("host store aliases and unshared-input violations are rejected", () => {
  const f = fixture();
  try {
    f.input.storeDir = ROOT; write(f.inputPath, f.input);
    const { child, report } = f.run(); assert.equal(child.status, 1); assert.match(child.stderr, /candidate\/server-data/); assert.equal(report, null);
    f.input.storeDir = path.join(f.candidate, "server-data"); write(f.inputPath, f.input);
    fs.linkSync(path.join(f.candidate, "public/data/matches-current.json"), path.join(f.candidate, "proof-input/hardlinked-current.json"));
    const second = f.run(); assert.equal(second.child.status, 1); assert.match(second.report.failure.message, /unshared regular file/);
  } finally { f.close(); }
});
