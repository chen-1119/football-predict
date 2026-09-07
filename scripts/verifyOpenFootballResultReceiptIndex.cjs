"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { recordSourceObservation, readAuditedObservationStore } = require("./openFootballObservationStore.cjs");
const { buildResultReceiptIndex, VERSION, MAX_REPLAY_BYTES } = require("./openFootballResultReceiptIndex.cjs");
const { LEAGUES, MAX_BYTES } = require("./auditOpenFootballCurrentSeason.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-result-receipt-index-"));
const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
const fixture = (score = [1, 0], extra = {}) => ({ date: "2026-09-07", team1: "Alpha FC", team2: "Beta FC", score: { ft: score }, ...extra });
const raw = (matches, league = "en.1") => Buffer.from(JSON.stringify({ name: `${LEAGUES[league]} 2026/27`, matches }));
const record = (folder, bytes, receivedAt, league = "en.1") => recordSourceObservation({ storeDir: path.join(temp, folder),
  season: "2026-27", league, raw: bytes, receivedAt, requestStartedAt: receivedAt });
const index = (folder, asOf = "2026-09-12T00:00:00Z") => buildResultReceiptIndex({ storeDir: path.join(temp, folder), asOf });
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
try {
  const original = raw([fixture()]);
  const early = record("main", original, "2026-09-07T08:00:00Z");
  check("same-day source score remains quarantined even when queried a week later", () => {
    assert.equal(early.candidateRows, 0);
    assert.equal(index("main").counts.events, 0);
  });
  check("valid explicit cutoff before any receipt yields empty as-of index", () => {
    const report = index("main", "2026-09-07T07:59:59Z");
    assert.equal(report.replayedReceipts, 0); assert.equal(report.replayHead, null); assert.equal(report.rows.length, 0);
  });
  const first = record("main", original, "2026-09-08T06:00:00Z");
  const beforeChange = index("main", first.receivedAt);
  check("unchanged file uses first actually qualifying receipt, not file firstObservedAt", () => {
    assert.equal(first.firstObservedAt, early.receivedAt);
    assert.notEqual(first.firstObservedAt, first.receivedAt);
    assert.equal(beforeChange.rows[0].resultObservedAt, first.receivedAt);
    assert.equal(beforeChange.rows[0].revisions[0].firstReceipt.receiptHash, first.receiptHash);
    assert.equal(beforeChange.rows[0].revisions[0].firstReceipt.contentSha256, first.contentSha256);
  });
  const again = record("main", original, "2026-09-08T07:00:00Z");
  check("repeat retains first clock while binding latest exact receipt", () => {
    const row = index("main").rows[0], rev = row.revisions[0];
    assert.equal(row.resultObservedAt, first.receivedAt); assert.equal(rev.observations, 2);
    assert.equal(rev.lastReceipt.receiptHash, again.receiptHash);
  });
  record("main", raw([fixture([2, 0])]), "2026-09-09T07:00:00Z");
  check("score correction remains two immutable revisions with conflict and no chosen result", () => {
    const row = index("main").rows[0];
    assert.equal(row.researchStatus, "conflicting-results"); assert.equal(row.resultObservedAt, null);
    assert.deepEqual(row.revisions.map(r => r.scoreHome), [1, 2]);
    assert.equal(row.revisions[0].firstQualifyingReceiptAt, first.receivedAt);
    assert.equal(row.revisions[1].firstQualifyingReceiptAt, "2026-09-09T07:00:00.000Z");
  });
  check("appended future evidence does not alter historical index hash or rows", () => {
    const report = index("main", first.receivedAt);
    assert.equal(report.indexHash, beforeChange.indexHash); assert.deepEqual(report.rows, beforeChange.rows);
    assert.notEqual(report.storeAudit.lastReceiptHash, beforeChange.storeAudit.lastReceiptHash);
  });
  record("main", original, "2026-09-10T07:00:00Z");
  check("restoring old score preserves earlier conflict and original clock", () => {
    const row = index("main").rows[0]; assert.equal(row.revisions.length, 2);
    assert.equal(row.revisions[0].firstQualifyingReceiptAt, first.receivedAt);
    assert.equal(row.researchStatus, "conflicting-results");
  });
  record("withdrawn", original, "2026-09-08T00:00:00Z");
  record("withdrawn", raw([fixture(undefined, { score: {} })]), "2026-09-09T00:00:00Z");
  check("score removal preserves evidence but withdraws current research availability", () => {
    const row = index("withdrawn").rows[0]; assert.equal(row.researchStatus, "withdrawn-or-quarantined");
    assert.equal(row.resultObservedAt, null); assert.equal(row.revisions.length, 1);
  });
  record("duplicates", original, "2026-09-08T00:00:00Z");
  record("duplicates", raw([fixture(), fixture([2, 0])]), "2026-09-09T00:00:00Z");
  check("duplicate identity quarantines all copies instead of choosing a winning score", () => {
    const row = index("duplicates").rows[0]; assert.equal(row.latestSourceContainsCandidate, false);
    assert.equal(row.revisions.length, 1); assert.equal(row.researchStatus, "withdrawn-or-quarantined");
  });
  record("metadata", original, "2026-09-08T00:00:00Z");
  record("metadata", raw([fixture([1, 0], { round: "Matchday 1" })]), "2026-09-09T00:00:00Z");
  check("non-score metadata revision binds new row without falsely conflicting score", () => {
    const row = index("metadata").rows[0], rev = row.revisions[0];
    assert.equal(row.revisions.length, 1); assert.equal(row.researchStatus, "observed-unverified");
    assert.notEqual(rev.firstReceipt.rawRowSha256, rev.lastReceipt.rawRowSha256);
  });
  record("identity", raw([fixture(), fixture([1, 0], { team1: "Alpha FC U21" }), fixture([1, 0], { team1: "Alpha FC Women" }),
    fixture([1, 0], { team1: "Beta FC", team2: "Alpha FC" })]), "2026-09-08T00:00:00Z");
  record("identity", raw([fixture()], "es.1"), "2026-09-08T00:00:00Z", "es.1");
  check("league, raw category and home-away identity are never fuzzy merged", () => assert.equal(index("identity").counts.events, 5));
  check("all observed rows remain unverified non-production and non-official", () => {
    const report = index("identity");
    for (const row of report.rows) {
      assert.equal(row.sourceVerified, false); assert.equal(row.productionEligible, false);
      assert.equal(row.officialSettlementAllowed, false); assert.equal(row.entityMappingStatus, "unverified");
      assert.equal(row.kickoff, null); assert.equal(row.upstreamPublishedAt, null);
    }
    assert.equal(report.predictionWrites, 0); assert.equal(report.officialResultWrites, 0); assert.equal(report.productionAdmittedRows, 0);
  });
  check("read-only transaction rejects writes and reread leaves database and files unchanged", () => {
    const directory = path.join(temp, "main"), file = path.join(directory, "observations.sqlite");
    const before = hash(file), files = fs.readdirSync(directory);
    assert.throws(() => readAuditedObservationStore(directory, db => db.exec("DELETE FROM observations")), /readonly|read-only/i);
    index("main"); assert.equal(hash(file), before); assert.deepEqual(fs.readdirSync(directory), files);
  });
  check("independent child process reproduces exact as-of index", () => {
    const child = spawnSync(process.execPath, [require.resolve("./openFootballResultReceiptIndex.cjs"), path.join(temp, "main"), first.receivedAt],
      { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), index("main", first.receivedAt));
  });
  check("missing invalid and relative inputs are rejected without creating a store", () => {
    for (const asOf of [undefined, "2026-02-30T00:00:00Z", "2026-09-07"]) assert.throws(() => index("absent", asOf === undefined ? "" : asOf));
    assert.throws(() => buildResultReceiptIndex({ storeDir: "relative", asOf: first.receivedAt }));
    assert.equal(fs.existsSync(path.join(temp, "absent")), false);
  });
  check("bounded replay fails closed without deleting accumulated receipts", () => {
    const padded = Buffer.concat([original, Buffer.alloc(MAX_BYTES - original.length, 32)]);
    const n = Math.floor(MAX_REPLAY_BYTES / MAX_BYTES) + 1;
    for (let i = 0; i < n; i++) record("capacity", padded, "2026-09-08T00:00:00Z");
    const file = path.join(temp, "capacity", "observations.sqlite"), before = hash(file);
    assert.throws(() => index("capacity"), /capacity exceeded/); assert.equal(hash(file), before);
  });
  const corrupt = new DatabaseSync(path.join(temp, "main", "observations.sqlite"));
  corrupt.exec("UPDATE observations SET receipt_json='{}' WHERE sequence=4"); corrupt.close();
  check("full chain corruption is rejected even when damaged receipt is later than cutoff", () => assert.throws(() => index("main", first.receivedAt), /integrity/));
  console.log(JSON.stringify({ ok: true, verifier: VERSION, checks, providerRequests: 0, productionDataTouched: false,
    scope: "real isolated SQLite history, as-of receipts and independent process replay" }));
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-result-receipt-index-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
