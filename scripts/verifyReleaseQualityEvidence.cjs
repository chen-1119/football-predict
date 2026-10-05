"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { test } = require("node:test");
const { auditOnlineExport, auditContinuity, auditProjection } = require("./releaseQualityEvidence.cjs");
const { buildConfig, runVerificationWithAccess } = require("./verifyRemoteRecommendationParity.cjs");
const { digest } = require("../src/services/publicReferenceEvidence.cjs");
const { protectedResponseDenied } = require("./observeReleaseQualityPublic.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const nowMs = Date.parse("2026-10-02T16:02:00+08:00");
const publication = { mode: "active-generation", generationId: `g-${hash("generation")}`, manifestHash: hash("generation"),
  sourceCycleId: "sporttery-full-sync:2026-09-30T15:34:00Z", committedAt: "2026-09-30T15:52:07Z" };
function capture(at = "2026-10-02T08:00:00Z") {
  const frontendState = { version: "frontend-release-state-v1", kind: "frontend-only", phase: "accepted", runtimeSequence: 785,
    frontendSequence: 787, runtimeSha256: hash("runtime"), frontendSha256: hash("frontend"), indexSha256: hash("index"),
    distTreeHash: hash("tree"), acceptanceSha256: hash("acceptance") };
  const health = { serviceOk: true, readSource: "postgres", postgresAvailable: true, postgresBaseReady: true, dataFresh: false,
    recommendationReliable: false, publication, frontendRelease: { ...frontendState, available: true, consistent: true } };
  return structuredClone({ observedAt: at, productionWrites: 0, ok: true, baselinePublication: publication, frontendState,
    markers: { ".release-bundle-sha256": frontendState.runtimeSha256, ".release-live-complete": frontendState.runtimeSha256 },
    localIndexSha256: frontendState.indexSha256, publicIndexSha256: frontendState.indexSha256, bindingSha256: hash("binding"),
    health, publicHealth: health, services: Object.fromEntries(["football-predict.service", "football-sync-worker.service", "nginx.service"]
      .map((name, i) => [name, { ActiveState: "active", MainPID: String(100 + i), ExecMainStartTimestamp: "2026-09-29 UTC",
        processStartTicks: "12345", scriptMatches: true, fixedNodeMatches: true, cmdlineSha256: hash(name) }])) });
}
test("fresh continuity preserves separate frontend/runtime identities without claiming data/model readiness", () => {
  const result = auditContinuity(capture(), capture("2026-10-02T08:01:00Z"), { nowMs });
  assert.equal(result.ok, true); assert.equal(result.deploymentAuthorized, false);
});
const mutations = [
  ["stale cache across Shanghai midnight", value => { value.observedAt = "2026-10-01T15:59:59Z"; }],
  ["future observation", value => { value.observedAt = "2026-10-02T08:03:00Z"; }],
  ["unknown frontend identity version", value => { value.frontendState.version = "future-unverified"; }],
  ["frontend runtime sequence inversion", value => { value.frontendState.frontendSequence = 784; }],
  ["missing observation", value => { delete value.observedAt; }],
  ["missing index on both accepted state and response", value => { delete value.publicIndexSha256; delete value.frontendState.indexSha256; }],
  ["old index cache", value => { value.publicIndexSha256 = hash("old index"); }],
  ["public private identity drift", value => { value.publicHealth.frontendRelease.frontendSequence = 786; }],
  ["runtime marker drift", value => { value.markers[".release-live-complete"] = hash("different runtime"); }],
  ["DB publication drift", value => { value.baselinePublication.sourceCycleId = "different"; }],
  ["missing DB publication", value => { delete value.baselinePublication; }],
  ["server restart", value => { value.services["football-predict.service"].MainPID = "1010"; }],
  ["PID reuse", value => { value.services["football-sync-worker.service"].processStartTicks = "999"; }],
  ["missing process start", value => { delete value.services["football-predict.service"].processStartTicks; }],
  ["worker script drift", value => { value.services["football-sync-worker.service"].scriptMatches = false; }],
  ["missing nginx", value => { delete value.services["nginx.service"]; }],
  ["binding drift", value => { value.bindingSha256 = hash("new binding"); }],
  ["unproven read-only capture", value => { delete value.productionWrites; }],
  ["capture wrote production", value => { value.productionWrites = 1; }],
];
for (const [name, mutate] of mutations) test(`continuity rejects ${name}`, () => {
  const after = capture("2026-10-02T08:01:00Z"); mutate(after);
  assert.equal(auditContinuity(capture(), after, { nowMs }).ok, false);
});
test("continuity requires an explicit finite clock and rejects reverse capture order", () => {
  assert.equal(auditContinuity(capture(), capture()).ok, false);
  assert.equal(auditContinuity(capture("2026-10-02T08:01:00Z"), capture(), { nowMs }).ok, false);
});
function exportFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "football-quality-export-"));
  const receipt = { version: "online-validation-inputs-v1", productionWrites: false, sameSnapshot: true,
    source: "online-immutable-active-generation", publication, healthBefore: { publication }, healthAfter: { publication }, files: [] };
  for (const name of ["matches-current.json", "model-evaluation.json", "model-strategy.json"]) {
    const bytes = Buffer.from(name === "matches-current.json" ? "[]" : "{}");
    fs.writeFileSync(path.join(directory, name), bytes);
    const entry = { name, bytes: bytes.length, sha256: hash(bytes), provenance: { source: receipt.source,
      generationId: publication.generationId, manifestHash: publication.manifestHash,
      manifestEntry: { path: name, bytes: bytes.length, sha256: hash(bytes) } } };
    receipt.files.push(entry);
  }
  return { directory, receipt, save() { fs.writeFileSync(path.join(directory, "online-validation-inputs-receipt.json"), JSON.stringify(receipt)); } };
}
for (const [name, mutate, expected] of [
  ["valid historical export", () => {}, true],
  ["tampered bytes", f => fs.writeFileSync(path.join(f.directory, "matches-current.json"), "[1]"), false],
  ["missing real input", f => fs.unlinkSync(path.join(f.directory, "model-evaluation.json")), false],
  ["missing receipt file entry", f => f.receipt.files.pop(), false],
  ["duplicate receipt file entry", f => f.receipt.files.push(f.receipt.files[0]), false],
  ["wrong generation binding", f => { f.receipt.files[0].provenance.generationId = "g-other"; }, false],
  ["wrong manifest entry", f => { f.receipt.files[0].provenance.manifestEntry.sha256 = hash("other"); }, false],
  ["pointer changed during export", f => { f.receipt.healthAfter = { publication: { ...publication, sourceCycleId: "other" } }; }, false],
  ["repository data mislabeled online", f => { f.receipt.source = "repository"; }, false],
]) test(`export integrity: ${name}`, () => {
  const f = exportFixture();
  try { mutate(f); f.save(); const result = auditOnlineExport(f.directory); assert.equal(result.ok, expected); assert.equal(result.deploymentAuthorized, false); }
  finally { fs.rmSync(f.directory, { recursive: true }); }
});
const row = { id: "sporttery_quality", sourceMatchId: "quality", status: "SCHEDULED", kickoffTime: "2026-10-03T00:05:00+08:00",
  eventVersion: "2026-10-03T00:05:00+08:00", buyEndTime: "2026-10-03T00:00:00+08:00", oddsSource: "sporttery:had", odds: { odds1: 2, oddsX: 3, odds2: 4 },
  predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", odds: 2, recommendationAction: "reference",
    confidence: { publicMetrics: { modelProbability: 0.5 } }, frozenVersion: { version: "frozen-review-version-v1", modelVersion: "m1", contentHash: hash("frozen") } }] };
const frozenBody = { version: "frozen-review-version-v1", source: "public-reference-decision-v2", referenceHash: hash("reference"),
  evidenceHash: hash("evidence"), featureHash: hash("feature"), modelHash: hash("model"), modelVersion: "m1", policyVersion: "p1",
  decisionAt: "2026-10-02T07:00:00Z", recordedAt: "2026-10-02T07:01:00Z", cutoffTime: "2026-10-02T16:00:00Z", selection: '["HAD","1",0,2]' };
row.predictions[0].frozenVersion = { ...frozenBody, contentHash: digest(frozenBody) };
test("list/detail probability and frozen version coverage is measured separately", () => {
  assert.deepEqual(auditProjection(row, structuredClone(row), nowMs), { ok: true, blockers: [], unavailable: [], probabilityCovered: true, decisionVersionCovered: true });
});
test("canonical BEST probability drift is rejected when WATCH precedes it", () => {
  const list = structuredClone(row);
  list.predictions.unshift({ marketType: "BEST", tipCode: "WATCH", recommendationAction: "withhold",
    confidence: { publicMetrics: { modelProbability: 0.5 } } });
  list.predictions[1].confidence.publicMetrics.modelProbability = 0.6;
  const detail = structuredClone(list);
  assert.equal(auditProjection(list, detail, nowMs).ok, true);
  detail.predictions[1].confidence.publicMetrics.modelProbability = 0.9;
  const result = auditProjection(list, detail, nowMs);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("modelProbability-projection-mismatch"));
  assert.equal(result.probabilityCovered, false);
  assert.equal(result.decisionVersionCovered, true);
});
test("supporting market rows do not replace the canonical BEST probability", () => {
  const list = structuredClone(row);
  list.predictions.unshift(
    { marketType: "1X2", oddsPoolCode: "HAD", tipCode: "1", odds: 2, recommendationAction: "reference" },
    { marketType: "1X2", oddsPoolCode: "HHAD", tipCode: "2", handicapLine: 1, odds: 3, recommendationAction: "reference" });
  assert.deepEqual(auditProjection(list, structuredClone(list), nowMs), {
    ok: true, blockers: [], unavailable: [], probabilityCovered: true, decisionVersionCovered: true,
  });
});
for (const [name, mutate] of [
  ["probability drift", value => { value.predictions[0].confidence.publicMetrics.modelProbability = 0.6; }],
  ["probability missing on detail", value => { delete value.predictions[0].confidence; }],
  ["probability numeric string", value => { value.predictions[0].confidence.publicMetrics.modelProbability = "0.5"; }],
  ["probability out of range", value => { value.predictions[0].confidence.publicMetrics.modelProbability = 1.1; }],
  ["decision version drift", value => { value.predictions[0].frozenVersion.modelVersion = "m2"; }],
]) test(`projection rejects ${name}`, () => {
  const detail = structuredClone(row); mutate(detail); assert.equal(auditProjection(row, detail, nowMs).ok, false);
});
test("missing probability on both projections is unavailable rather than covered", () => {
  const missing = structuredClone(row); delete missing.predictions[0].confidence;
  const result = auditProjection(missing, missing, nowMs); assert.equal(result.ok, true); assert.equal(result.probabilityCovered, false);
  assert.deepEqual(result.unavailable, ["modelProbability"]);
});
test("equal malformed probability or frozen version cannot count as coverage", () => {
  const invalid = structuredClone(row); invalid.predictions[0].frozenVersion = {};
  invalid.predictions[0].confidence.publicMetrics.modelProbability = "0.5";
  const result = auditProjection(invalid, invalid, nowMs);
  assert.equal(result.ok, false); assert.equal(result.probabilityCovered, false); assert.equal(result.decisionVersionCovered, false);
});
test("projection requires input rows and an explicit clock", () => {
  assert.equal(auditProjection(null, null, nowMs).ok, false);
  assert.equal(auditProjection(row, row).ok, false);
});
test("only the explicitly retired static payload can use 410; protected APIs still require auth denial", () => {
  const retired = { status: 410, json: { ok: false, error: "large static payload disabled", use: "/api/v1/matches/current?view=list" } };
  assert.equal(protectedResponseDenied("/data/matches-current.json", retired), true);
  assert.equal(protectedResponseDenied("/api/v1/matches/current?view=list", retired), false);
  assert.equal(protectedResponseDenied("/data/matches-current.json", { status: 410, json: { rows: [{}] } }), false);
  assert.equal(protectedResponseDenied("/api/v1/matches/current?view=list", { status: 200 }), false);
  assert.equal(protectedResponseDenied("/api/v1/matches/current?view=list", { status: 401, json: { ok: false, error: "access code required" } }), true);
  assert.equal(protectedResponseDenied("/api/v1/matches/current?view=list", { status: 401, json: { ok: false, predictions: [{}] } }), false);
});
test("cross midnight kickoff switches to immutable archive and leaves the record unchanged", () => {
  const finished = structuredClone(row);
  finished.archivedPreMatchPrediction = { version: "archived-pre-match-prediction-v1", source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId: "quality", eventVersion: row.eventVersion, capturedAt: "2026-10-02T15:50:00Z", cutoffTime: "2026-10-02T16:00:00Z",
    signature: "fixture", marketEvidenceScope: "result-pool", prediction: structuredClone(row.predictions[0]) };
  const before = JSON.stringify(finished);
  const detail = structuredClone(finished); detail.predictions[0].confidence.publicMetrics.modelProbability = 0.9;
  assert.equal(auditProjection(finished, detail, Date.parse("2026-10-02T16:06:00Z")).ok, true);
  detail.archivedPreMatchPrediction.prediction.confidence.publicMetrics.modelProbability = 0.7;
  assert.equal(auditProjection(finished, detail, Date.parse("2026-10-02T16:06:00Z")).ok, false);
  assert.equal(JSON.stringify(finished), before);
  delete detail.archivedPreMatchPrediction;
  assert.equal(auditProjection(finished, detail, Date.parse("2026-10-02T16:06:00Z")).ok, false);
});
test("existing remote verifier uses supplied login token with GET only; anonymous branch cannot pass", async () => {
  const methods = [];
  const remoteRow = { ...row, kickoffTime: "2099-10-03T00:05:00+08:00", eventVersion: "2099-10-03T00:05:00+08:00",
    buyEndTime: "2099-10-03T00:00:00+08:00" };
  const server = http.createServer((req, res) => {
    methods.push(req.method); res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-quality-token") { res.statusCode = 401; res.end(JSON.stringify({ ok: false })); return; }
    res.end(JSON.stringify(req.url.includes("current?") ? { ok: true, rows: [remoteRow] } : { ok: true, match: remoteRow }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = buildConfig({}, { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "fixture-quality-token", readRetries: 0 });
    const authenticated = await runVerificationWithAccess(config);
    assert.equal(authenticated.ok, true); assert.equal(JSON.stringify(authenticated).includes(config.accessToken), false);
    const anonymous = await runVerificationWithAccess({ ...config, accessToken: "" });
    assert.equal(anonymous.ok, false); assert.equal(anonymous.mismatches[0].reasons[0], "protected-read-token-missing");
    const denied = await runVerificationWithAccess({ ...config, accessToken: "wrong" });
    assert.equal(denied.ok, false); assert.ok(methods.length > 0); assert.ok(methods.every(method => method === "GET"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
