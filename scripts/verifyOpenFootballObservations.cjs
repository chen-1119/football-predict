"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");
const { recordSourceObservation, collectSeasonObservations, auditObservationStore } = require("./openFootballObservationStore.cjs");
const { fetchSourceBytes, LEAGUES } = require("./auditOpenFootballCurrentSeason.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-community-observations-"));
const store = path.join(temp, "receipts");
let checks = 0;
const check = fn => { fn(); checks++; };
const data = (score = 1, league = "en.1") => Buffer.from(JSON.stringify({ name: `${LEAGUES[league]} 2026/27`, matches: [
  { date: "2026-08-31", team1: "Alpha FC", team2: "Beta FC", score: { ft: [score, 0] } },
] }));
const clocks = ["2026-09-07T12:00:00.000Z", "2026-09-07T12:00:01.000Z", "2026-09-07T12:00:02.000Z"];
const args = { storeDir: store, season: "2026-27", league: "en.1", raw: data(), requestStartedAt: clocks[0], receivedAt: clocks[0] };
const edit = sql => { const db = new DatabaseSync(path.join(store, "observations.sqlite")); try { db.exec(sql); } finally { db.close(); } };

async function main() {
  try {
    const first = recordSourceObservation(args);
    check(() => assert.equal(first.firstObservedAt, clocks[0]));
    check(() => assert.equal(first.sourceVerified, false));
    check(() => assert.equal(first.productionEligible, false));
    check(() => assert.equal(first.officialSettlementAllowed, false));
    check(() => assert.equal(first.sequence, 1));
    const repeat = recordSourceObservation({ ...args, receivedAt: clocks[1] });
    check(() => assert.equal(repeat.reusedContent, true));
    check(() => assert.equal(repeat.firstObservedAt, clocks[0]));
    check(() => assert.equal(repeat.previousContentReceiptHash, first.receiptHash));
    check(() => assert.equal(repeat.previousReceiptHash, first.receiptHash));
    const changed = recordSourceObservation({ ...args, raw: data(2), receivedAt: clocks[1] });
    check(() => assert.equal(changed.reusedContent, false));
    check(() => assert.equal(changed.firstObservedAt, clocks[1]));
    check(() => assert.notEqual(changed.contentSha256, first.contentSha256));
    const reverted = recordSourceObservation({ ...args, receivedAt: clocks[2] });
    check(() => assert.equal(reverted.firstObservedAt, clocks[0]));
    check(() => assert.equal(reverted.previousContentReceiptHash, first.receiptHash));
    const audit = auditObservationStore(store);
    check(() => assert.equal(audit.observations, 4));
    check(() => assert.equal(audit.sourceContents, 2));
    check(() => assert.equal(audit.lastReceiptHash, reverted.receiptHash));
    check(() => assert.equal(audit.writes, 0));
    // A new process must recover the persisted first clock, not restamp it.
    const child = spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(require.resolve('./openFootballObservationStore.cjs'))});console.log(JSON.stringify(m.auditObservationStore(process.argv[1])));`, store], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    check(() => assert.equal(child.status, 0, child.stderr));
    check(() => assert.deepEqual(JSON.parse(child.stdout), audit));
    for (const bad of [{ receivedAt: clocks[0] }, { receivedAt: "2026-02-30T00:00:00Z" },
      { requestStartedAt: "2026-09-08T00:00:00Z" }, { league: "../../x" },
      { raw: Buffer.from('{"name":"wrong","matches":[]}') }, { raw: Buffer.from([255]) }]) {
      check(() => assert.throws(() => recordSourceObservation({ ...args, ...bad })));
      check(() => assert.deepEqual(auditObservationStore(store), audit));
    }
    // Failed requests do not reset successful receipt clocks or change the DB.
    let calls = 0;
    const failure = await collectSeasonObservations({ storeDir: store, season: "2026-27", fetchImpl: async () => { calls++; return new Response("unavailable", { status: 503 }); } });
    check(() => assert.equal(calls, 5));
    check(() => assert.equal(failure.ok, false));
    check(() => assert.deepEqual(auditObservationStore(store), audit));
    let tick = 0;
    const response = await fetchSourceBytes("2026-27", "en.1", async (_url, options) => {
      assert.equal(options.redirect, "error");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(data().subarray(0, 25)); controller.enqueue(data().subarray(25)); controller.close(); } }));
    }, () => clocks[tick++]);
    check(() => assert.equal(response.requestStartedAt, clocks[0]));
    check(() => assert.equal(response.receivedAt, clocks[1]));
    check(() => assert.ok(response.raw.equals(data())));
    tick = 0;
    await assert.rejects(fetchSourceBytes("2026-27", "en.1", async () => new Response(data()), () => [clocks[1], clocks[0]][tick++])); checks++;
    const separate = path.join(temp, "partial");
    const partial = await collectSeasonObservations({ storeDir: separate, season: "2026-27", clock: () => clocks[2], fetchImpl: async url => {
      const league = Object.keys(LEAGUES).find(key => url.endsWith(`/${key}.json`));
      return league === "es.1" ? new Response("unavailable", { status: 503 }) : new Response(data(1, league));
    } });
    check(() => assert.equal(partial.ok, false));
    check(() => assert.equal(partial.sources.filter(s => s.ok).length, 4));
    check(() => assert.equal(auditObservationStore(separate).sourceContents, 4));
    check(() => assert.equal(partial.predictionWrites, 0));
    check(() => assert.equal(partial.officialResultWrites, 0));
    edit("UPDATE observations SET receipt_json='{}' WHERE sequence=2");
    check(() => assert.throws(() => auditObservationStore(store), /integrity/));
    check(() => assert.throws(() => recordSourceObservation({ ...args, receivedAt: clocks[2] }), /integrity/));
    const corruptDb = new DatabaseSync(path.join(store, "observations.sqlite"), { readOnly: true });
    check(() => assert.equal(corruptDb.prepare("SELECT count(*) n FROM observations").get().n, 4)); corruptDb.close();
    const hardlinked = path.join(temp, "hardlinked"); fs.mkdirSync(hardlinked);
    fs.linkSync(path.join(separate, "observations.sqlite"), path.join(hardlinked, "observations.sqlite"));
    check(() => assert.throws(() => recordSourceObservation({ ...args, storeDir: hardlinked }), /Unsafe/));
    const wrong = path.join(temp, "unknown"); fs.mkdirSync(wrong);
    const unknown = new DatabaseSync(path.join(wrong, "observations.sqlite")); unknown.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('keep')"); unknown.close();
    check(() => assert.throws(() => recordSourceObservation({ ...args, storeDir: wrong })));
    const verify = new DatabaseSync(path.join(wrong, "observations.sqlite"), { readOnly: true });
    check(() => assert.equal(verify.prepare("SELECT value FROM untouched").get().value, "keep")); verify.close();
    check(() => assert.throws(() => recordSourceObservation({ ...args, storeDir: "relative-path" })));
    console.log(JSON.stringify({ ok: true, checks, providerRequests: 0, productionDataTouched: false,
      scope: "isolated SQLite receipts, synthetic complete HTTP streams, persisted restart and corruption tests" }));
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-community-observations-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
