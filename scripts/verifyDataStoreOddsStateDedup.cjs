const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { persistDataSnapshot, readDataStoreRows, TABLES } = require("../server/dataStore.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-state-dedup-"));
const storeDir = path.join(root, "store");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const write = (name, payload) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(payload, null, 2)}\n`);

(async () => {
  try {
    const match = {
      id: "sporttery_1001",
      sourceMatchId: "1001",
      status: "SCHEDULED",
      kickoffTime: "2026-07-13T20:00:00+08:00",
      source: "sporttery",
      odds: { odds1: 1.9, oddsX: 3.2, odds2: 3.6 },
      oddsUpdatedAt: "2026-07-12T10:00:00.000Z",
      oddsSource: "sporttery:HAD",
    };
    const historyRow = {
      sourceMatchId: "1001",
      capturedAt: "2026-07-12T09:55:00.000Z",
      lastSeenAt: "2026-07-12T10:05:00.000Z",
      poolCode: "HAD",
      handicapLine: 0,
      odds1: 1.9,
      oddsX: 3.2,
      odds2: 3.6,
      oddsSource: "sporttery:HAD",
    };
    write("matches-current.json", [match]);
    write("matches-history.json", []);
    write("sync-meta.json", { updatedAt: "2026-07-12T10:05:00.000Z", capturedAt: "2026-07-12T10:05:00.000Z" });
    write("odds-history.json", { rows: [historyRow] });
    write("prediction-snapshots.json", { rows: [] });
    write("gpt-predictions.json", { rows: [] });
    write("external-signals.json", { updatedAt: null, matches: {} });

    const first = await persistDataSnapshot({ storeDir, dataDir, source: "test" });
    const firstRows = await readDataStoreRows(storeDir, TABLES.oddsSnapshots, { sourceMatchId: "1001", limit: 20 });
    assert.equal(first.oddsSnapshots, 1, "current and odds-history copies of one state must append once");
    assert.equal(firstRows.length, 1);

    match.oddsUpdatedAt = "2026-07-12T10:10:00.000Z";
    historyRow.lastSeenAt = "2026-07-12T10:10:00.000Z";
    write("matches-current.json", [match]);
    write("odds-history.json", { rows: [historyRow] });
    write("sync-meta.json", { updatedAt: "2026-07-12T10:10:00.000Z", capturedAt: "2026-07-12T10:10:00.000Z" });
    const second = await persistDataSnapshot({ storeDir, dataDir, source: "test" });
    const secondRows = await readDataStoreRows(storeDir, TABLES.oddsSnapshots, { sourceMatchId: "1001", limit: 20 });
    assert.equal(second.oddsSnapshots, 0, "timestamp-only changes must not create a new market state");
    assert.equal(secondRows.length, 1);
    assert.equal(secondRows[0].id, firstRows[0].id);

    match.odds = { odds1: 1.85, oddsX: 3.25, odds2: 3.7 };
    write("matches-current.json", [match]);
    const third = await persistDataSnapshot({ storeDir, dataDir, source: "test" });
    const thirdRows = await readDataStoreRows(storeDir, TABLES.oddsSnapshots, { sourceMatchId: "1001", limit: 20 });
    assert.equal(third.oddsSnapshots, 1, "a real SP change must remain a distinct state");
    assert.equal(thirdRows.length, 2);

    console.log(JSON.stringify({ ok: true, checks: 8, ids: thirdRows.map((row) => row.id) }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
