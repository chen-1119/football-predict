"use strict";
const assert = require("node:assert/strict");
const { MAX_BYTES, sourceUrl, inspectSource, fetchSource, auditSeason } = require("./auditOpenFootballCurrentSeason.cjs");
let checks = 0;
const test = (fn) => { fn(); checks++; };
const options = { season: "2026-27", league: "en.1", receivedAt: "2026-09-07T13:30:00Z" };
const row = { date: "2026-08-31", team1: "Alpha FC", team2: "Beta FC", score: { ft: [1, 0] } };
const raw = (matches, name = "English Premier League 2026/27") => Buffer.from(JSON.stringify({ name, matches }));
const inspect = (matches) => inspectSource(raw(matches), options);
async function main() {
  test(() => assert.equal(inspect([row]).candidateRows, 1));
  test(() => assert.equal(inspect([row]).productionAdmittedRows, 0));
  test(() => assert.equal(inspect([row]).receipt.sourceVerified, false));
  test(() => assert.equal(inspect([row]).candidates[0].resultObservedAt, null));
  test(() => assert.equal(inspect([row]).candidates[0].kickoff, null));
  test(() => assert.equal(inspect([row]).teamCoverage.length, 2));
  test(() => assert.throws(() => sourceUrl("2026-28", "en.1")));
  test(() => assert.throws(() => sourceUrl("2026-27", "../../en.1")));
  test(() => assert.throws(() => inspectSource(raw([row], "Other League"), options)));
  test(() => assert.throws(() => inspectSource(raw([row]), { ...options, receivedAt: "2026-02-30T00:00:00Z" })));
  test(() => assert.throws(() => inspectSource(Buffer.alloc(MAX_BYTES + 1), options)));
  test(() => assert.throws(() => inspectSource(Buffer.from([0xff]), options)));
  for (const score of [null, false, "", "1", [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(() => assert.equal(inspect([{ ...row, score: { ft: [score, 0] } }]).candidateRows, 0));
  }
  for (const date of ["2026-02-30", "2026-06-30", "2027-07-01", "2026-09-07", "2026-09-08", null]) {
    test(() => assert.equal(inspect([{ ...row, date }]).candidateRows, 0));
  }
  for (const team1 of ["", " Alpha FC", "Beta FC", null, "Alpha\nFC"]) {
    test(() => assert.equal(inspect([{ ...row, team1 }]).candidateRows, 0));
  }
  test(() => assert.equal(inspect([{ ...row, score: {} }]).excluded["no-full-time-score"], 1));
  test(() => assert.equal(inspect([row, row]).excluded["duplicate-identity"], 2));
  test(() => assert.equal(inspect([row, { ...row, score: { ft: [0, 1] } }]).candidateRows, 0));
  test(() => assert.equal(inspect([row, { ...row, score: {} }]).candidateRows, 0));
  test(() => assert.equal(inspect([row, { ...row, team1: "Alpha FC B" }]).teamCoverage.length, 3));
  test(() => {
    const report = inspect([row, { ...row, date: "2026-08-30" }]);
    assert.equal(report.latestResultDate, "2026-08-31");
    assert.equal(report.teamCoverage[0].rows, 2);
  });
  await assert.rejects(fetchSource("2026-27", "en.1", async () => new Response("unavailable", { status: 503 }))); checks++;
  await assert.rejects(fetchSource("2026-27", "en.1", async () => new Response(Buffer.alloc(MAX_BYTES + 1)))); checks++;
  const fetched = await fetchSource("2026-27", "en.1", async (_url, config) => {
    assert.equal(config.redirect, "error"); return new Response(raw([row]));
  });
  test(() => assert.equal(fetched.candidateRows, 1));
  let calls = 0;
  const failures = await auditSeason("2026-27", async () => { calls++; throw new Error("test unavailable"); });
  test(() => assert.equal(calls, 5));
  test(() => assert.equal(failures.ok, false));
  test(() => assert.equal(failures.productionDataWritten, false));
  test(() => assert.equal(failures.candidateRows, 0));
  test(() => assert.ok(failures.sources.every((source) => !source.ok)));
  console.log(JSON.stringify({ ok: true, checks, scope: "isolated-readonly-source-audit" }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
