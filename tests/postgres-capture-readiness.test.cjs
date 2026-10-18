"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { queryReadinessSnapshotBatch, overlapReadinessInputs } = require("../scripts/postgresCaptureReadiness.cjs");
const { runtimeSnapshotsForMatches } = require("../scripts/captureCandidateProspectiveDeadline.cjs");
const request = { ordinal: 0, ids: ["event"], upperBound: "2026-10-18T10:00:00Z", frozenAt: "2026-09-09T00:00:00Z" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("native bounded readiness requests use one statement and preserve per-event clocks, order and lookahead", async () => {
  let calls = 0;
  const session = { client: { query: async (sql, args) => {
    calls++; assert.match(sql, /CROSS JOIN LATERAL/); assert.match(sql, /ORDER BY captured_at DESC,id DESC LIMIT \$3/);
    assert.equal(args[2], 3); assert.equal(args[0], request.frozenAt);
    const requests = JSON.parse(args[1]); assert.deepEqual(requests.map(row => row.ordinal), [0, 1, 3]);
    assert.deepEqual(requests[0].identities, ["sporttery_event", "event"]);
    return { rows: [{ ordinal: 0, payload: '{"id":"new","capturedAt":"2026-10-18T09:00:00Z"}' },
      { ordinal: 0, payload: '{"id":"old","capturedAt":"2026-10-18T08:00:00Z"}' },
      { ordinal: 0, payload: '{"id":"lookahead","capturedAt":"2026-10-18T07:00:00Z"}' },
      { ordinal: 1, payload: '{"id":"other","capturedAt":"2026-10-18T08:00:00Z"}' }] };
  } } };
  let clocks = 0;
  const result = await runtimeSnapshotsForMatches([{ id: "sporttery_event" }, { sourceMatchId: "other" }, {}, { id: "none" }, { id: "invalid" }], request.frozenAt,
    { session, perMatchLimit: 2, upperBoundForMatch: match => { clocks++; return match.id === "invalid" ? "bad-clock" : request.upperBound; } });
  assert.equal(calls, 1); assert.equal(clocks, 4); assert.equal(result.queriedMatches, 3); assert.equal(result.unqueriedMatches, 2);
  assert.equal(result.saturatedMatches, 1); assert.equal(result.selectedRows, 3); assert.equal(result.complete, false);
  assert.deepEqual(result.rows.map(row => row.id), ["old", "other", "new"]);
});

test("due selectable search retains the original independent per-match query and adaptive path", async () => {
  let calls = 0;
  const session = { client: { query: async (sql, args) => { calls++; assert.doesNotMatch(sql, /LATERAL/); assert.equal(args[3], 3); return { rows: [] }; } } };
  const out = await runtimeSnapshotsForMatches([{ id: "event" }], request.frozenAt,
    { session, ensureSelectable: true, perMatchLimit: 2, upperBoundForMatch: () => request.upperBound });
  assert.equal(calls, 1); assert.equal(out.complete, true); assert.equal(out.expandedMatches, 0);
});

test("empty readiness cannot dispatch a query", async () => {
  assert.deepEqual(await queryReadinessSnapshotBatch({ query: () => { throw Error("unexpected query"); } }, [], 65), new Map());
});
for (const kind of ["ordinal", "overflow", "payload", "limit"]) test("batch refuses invalid " + kind, async () => {
  const rows = kind === "ordinal" ? [{ ordinal: 1, payload: "{}" }] : kind === "payload" ? [{ ordinal: 0, payload: {} }]
    : [{ ordinal: 0, payload: "{}" }, { ordinal: 0, payload: "{}" }];
  await assert.rejects(queryReadinessSnapshotBatch({ query: async () => ({ rows }) }, [request], kind === "limit" ? NaN : 1));
});

test("both read operations start and the caller retains ownership until both complete", async () => {
  const events = []; let finishSql, finishPublic, returned = false;
  const work = overlapReadinessInputs(() => { events.push("sql-start"); return new Promise(resolve => { finishSql = () => { events.push("sql-finish"); resolve({ rows: [1] }); }; }); },
    () => { events.push("public-start"); return new Promise(resolve => { finishPublic = () => { events.push("public-finish"); resolve([2]); }; }); }).then(value => { returned = true; return value; });
  await tick(); assert.deepEqual(events, ["sql-start", "public-start"]); finishPublic(); await tick(); assert.equal(returned, false);
  finishSql(); assert.deepEqual(await work, { snapshots: { rows: [1] }, publicRows: [2] });
});
for (const failure of ["sql", "public", "both"]) test("rejection drains both reads before release: " + failure, async () => {
  let finishSql, finishPublic, returned = false;
  const sqlError = new Error("query failed"), publicError = new Error("strict full read failed");
  const work = overlapReadinessInputs(() => new Promise((resolve, reject) => { finishSql = () => failure !== "public" ? reject(sqlError) : resolve({ rows: [] }); }),
    () => new Promise((resolve, reject) => { finishPublic = () => failure !== "sql" ? reject(publicError) : resolve([]); }));
  const observed = work.catch(error => { returned = true; return error; });
  await tick(); finishSql(); await tick(); assert.equal(returned, false); finishPublic();
  assert.equal(await observed, failure === "public" ? publicError : sqlError);
});
