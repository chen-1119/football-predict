"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { compactApiFootballDiagnostics: project } = require("../src/services/apiFootballDiagnostics.cjs");
const { buildPieceMetadata } = require("./syncApiFootballData.cjs");
const store = require("../server/dataStore.cjs");
let checks = 0;
const check = (fn) => { fn(); checks++; };
const at = "2026-09-07T13:00:00Z", cutoff = "2026-09-07T14:00:00Z";
const match = { id: "sporttery_991222", sourceMatchId: "991222", kickoffTime: cutoff,
  status: "SCHEDULED", homeTeamName: "Home", awayTeamName: "Away", odds: { odds1: 2, oddsX: 3, odds2: 4 },
  externalSignals: { apiFootball: { fixtureId: 991222, lastCheckedAt: at, mappingVerified: false,
    verificationBlockers: ["provider-entity-registry-not-exact"], temporalRejections: ["lineups:clock-evidence-not-verifiable"],
    privateToken: "NEVER_PUBLIC", error: "NEVER_PUBLIC" } } };
const expected = project(match.externalSignals);
const src = fs.readFileSync(path.resolve(__dirname, "../server/index.cjs"), "utf8");
const section = (start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a); return src.slice(a, b); };
// Execute the actual list projection including its real five-hundred and
// bookmaker compaction. This fixture never invokes the pre-match branch.
const compact = new Function("compactApiFootballDiagnostics", "compactPreMatchQualityForList",
  section("const compactFiveHundredForList =", "const compactProvisionalResultForList =") + ";return compactExternalSignalsForList;")
  (project, () => { throw new Error("Unexpected unrelated pre-match branch"); });

async function main() {
  check(() => assert.equal(project(null), null));
  check(() => assert.equal(project({ source: "another-provider" }), null));
  check(() => assert.equal(expected.mappingStatus, "unverified"));
  check(() => assert.equal(expected.features[1].state, "clock-rejected"));
  check(() => assert.equal(expected.features[0].state, "not-received"));
  check(() => assert.ok(!JSON.stringify(expected).includes("NEVER_PUBLIC")));
  check(() => assert.deepEqual(compact(match.externalSignals).apiFootballDiagnostics, expected));
  check(() => assert.deepEqual(project(compact(match.externalSignals)), expected));
  check(() => assert.deepEqual(project({ apiFootballDiagnostics: { ...expected, privateRaw: "NEVER_PUBLIC" } }), expected));
  check(() => assert.equal(project({ apiFootball: { ...match.externalSignals.apiFootball, mappingVerified: true } }).mappingStatus, "recorded"));
  check(() => assert.equal(project({ apiFootball: { ...match.externalSignals.apiFootball, mappingVerified: true, fixtureId: false } }).mappingStatus, "unverified"));
  check(() => assert.equal(project({ apiFootball: { ...match.externalSignals.apiFootball, mappingVerified: true, lastCheckedAt: "2026-02-30T00:00:00Z" } }).checkedAt, null));
  check(() => assert.equal(project({ apiFootball: { ...match.externalSignals.apiFootball, verificationBlockers: ["provider-entity-conflict"] } }).mappingStatus, "conflicting"));
  const piece = buildPieceMetadata({ entry: { match: { buyEndTime: cutoff } }, endpoint: "/injuries", observedAt: at });
  const signals = { ...match.externalSignals, injuries: piece };
  check(() => assert.equal(project(signals).features[0].state, "receipt-recorded"));
  check(() => assert.equal(project(signals).features[0].sourceTimeStatus, "missing"));
  check(() => assert.equal(project({ ...signals, injuries: { ...piece, clockEvidence: { ...piece.clockEvidence, sourceTimeStatus: "recorded" } } }).features[0].state, "clock-rejected"));
  check(() => assert.deepEqual(project(compact(signals)), project(signals)));
  check(() => assert.equal(project({ ...signals, injuries: { ...piece, clockEvidence: null } }).features[0].state, "legacy-unverified"));
  check(() => assert.equal(project({ ...signals, injuries: { ...piece, observedAt: "2026-09-07T14:01:00Z" } }).features[0].state, "clock-rejected"));
  check(() => assert.equal(project({ ...signals, injuries: { source: "another-provider" } }).features[0].state, "not-received"));
  check(() => assert.ok(Buffer.byteLength(JSON.stringify(expected)) < 1600));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "football-collector-diagnostics-"));
  try {
    const dataDir = path.join(tmp,"data"), storeDir = path.join(tmp,"store"); fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir,"matches-current.json"), JSON.stringify([match]));
    fs.writeFileSync(path.join(dataDir,"matches-history.json"), "[]");
    await store.persistDataSnapshot({ storeDir, dataDir, source: "isolated-collector-diagnostics-test" });
    const rows = await store.readDataStoreRows(storeDir, store.TABLES.matchSnapshots, { limit: 10 });
    const found = rows.find(row => row.matchId === match.id);
    check(() => assert.deepEqual(found?.external?.apiFootballDiagnostics, expected));
    const latest = await store.getLatestMatchById(storeDir, match.id);
    check(() => assert.deepEqual(project(latest?.externalSignals), expected));
    check(() => assert.deepEqual(compact(latest.externalSignals).apiFootballDiagnostics, expected));
  } finally {
    const resolved = path.resolve(tmp), parent = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith("football-collector-diagnostics-")) throw new Error("Unsafe temporary cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, checks, scope: "pure projection, actual list projection and isolated JSON datastore persistence", productionDataWritten: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
