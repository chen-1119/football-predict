"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanPostgresModelInput } = require("../scripts/postgresModelInput.cjs");

function fakeClient(cursorRows, payloads, options = {}) {
  const calls = [];
  let offset = 0;
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("DECLARE ")) return { rows: [] };
      if (sql.startsWith("FETCH FORWARD 128 ")) {
        const rows = cursorRows.slice(offset, offset + 128);
        offset += rows.length;
        return { rows };
      }
      if (sql.startsWith("SELECT id, payload::text AS payload")) {
        if (options.readError) throw options.readError;
        const rows = values[0].map(id => payloads.get(id)).filter(Boolean).reverse();
        return { rows };
      }
      if (sql.startsWith("CLOSE ")) {
        if (options.closeError) throw options.closeError;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("model input sorts narrow IDs, hydrates bounded pages and restores latest-first order", async () => {
  const ids = Array.from({ length: 129 }, (_, index) => `prediction-${String(129 - index).padStart(3, "0")}`);
  const payloads = new Map(ids.map(id => [id, { id, payload: JSON.stringify({ id, note: "x".repeat(8192) }) }]));
  const client = fakeClient(ids.map(id => ({ id })), payloads);
  const received = [];
  await scanPostgresModelInput(client, "prediction_snapshots", { limit: 129, preferLatestRows: true }, row => received.push(JSON.parse(row.payload).id));

  assert.deepEqual(received, ids);
  const declarations = client.calls.filter(call => call.sql.startsWith("DECLARE "));
  assert.equal(declarations.length, 1);
  assert.match(declarations[0].sql, /SELECT id\s+FROM football\.prediction_snapshots\s+ORDER BY captured_at DESC, id DESC LIMIT \$1/);
  assert.doesNotMatch(declarations[0].sql, /payload/);
  assert.deepEqual(declarations[0].values, [129]);
  const pages = client.calls.filter(call => call.sql.startsWith("SELECT id, payload::text AS payload"));
  assert.deepEqual(pages.map(page => page.values[0].length), [128, 1]);
  assert.ok(pages.every(page => !/ORDER BY|LIMIT/i.test(page.sql)), "full payloads must not enter the sort");
  assert.equal(client.calls.at(-1).sql, "CLOSE model_prediction_snapshots");
});

test("model match input keeps dataset attached to each ordered ID", async () => {
  const ids = [{ id: "match-a", dataset: "current" }, { id: "match-b", dataset: "history" }];
  const client = fakeClient(ids, new Map(ids.map(row => [row.id, { id: row.id, payload: JSON.stringify(row) }])));
  const received = [];
  await scanPostgresModelInput(client, "match_snapshots", { limit: 2 }, row => received.push([row.id, row.dataset]));
  assert.deepEqual(received, [["match-a", "current"], ["match-b", "history"]]);
  assert.match(client.calls[0].sql, /SELECT id, dataset\s+FROM football\.match_snapshots WHERE dataset IN \('current', 'history'\)\s+ORDER BY kickoff_time ASC, id ASC LIMIT \$1/);
});

test("model input retains the first database error when closing an aborted cursor", async () => {
  const original = new Error("No space left on device");
  const client = fakeClient([{ id: "snapshot-a" }], new Map(), {
    readError: original, closeError: new Error("current transaction is aborted"),
  });
  await assert.rejects(scanPostgresModelInput(client, "prediction_snapshots", { limit: 1 }, () => {}), error => error === original);
  assert.equal(client.calls.at(-1).sql, "CLOSE model_prediction_snapshots");
});

test("model input fails closed if a selected ID has no payload in the read snapshot", async () => {
  const client = fakeClient([{ id: "snapshot-a" }], new Map());
  await assert.rejects(scanPostgresModelInput(client, "prediction_snapshots", { limit: 1 }, () => {}), /page changed inside read transaction/);
});
