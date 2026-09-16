"use strict";
const assert = require("node:assert/strict");
const { persistLedger } = require("./dailyFeaturedComboLedger.cjs");

async function verify(pool, migration) {
  const client = await pool.connect();
  const schema = `combo_verify_${process.pid}_${Date.now()}`;
  const query = (sql, values) => client.query(sql.replaceAll("football.daily_featured", `${schema}.daily_featured`), values);
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await query(migration);
    const legs = [1, 2].map((id) => ({ matchId: `sporttery_${id}`, sourceMatchId: String(id), eventVersion: "2026-09-16T14:00:00.000Z", market: "HAD", tipCode: "1", odds: 1.7, handicapLine: 0 }));
    const payload = { id: "test-frozen", businessDate: "2026-09-16", size: 2, frozenAt: "2026-09-16T13:00:00Z", totalOdds: 2.89, legs };
    await query("INSERT INTO football.daily_featured_combos VALUES($1,$2,$3,$4,$5)", [payload.id, payload.businessDate, 2, JSON.stringify(payload), JSON.stringify({ status: "PENDING" })]);
    const history = legs.map((leg) => ({ id: leg.matchId, sourceMatchId: leg.sourceMatchId, eventVersion: leg.eventVersion, kickoffTime: leg.eventVersion, status: "FINISHED", official: true, resultSource: "sporttery:official-api", scoreHome: 2, scoreAway: 0 }));
    const options = { now: Date.parse("2026-09-17T02:00:00Z"), current: [], history, publishable: false, publication: { manifestHash: "test" } };
    const output = await persistLedger({ query }, options);
    assert.equal(output.statistics.two.won, 1);
    const record = (await query("SELECT payload,settlement FROM football.daily_featured_combos")).rows[0];
    assert.deepEqual(record.payload, payload, "settlement must not rewrite frozen payload");
    assert.equal(record.settlement.status, "WON");
    await persistLedger({ query }, options);
    assert.equal((await query("SELECT count(*)::int AS n FROM football.daily_featured_combos")).rows[0].n, 1);
    await client.query("SAVEPOINT duplicate_test");
    await assert.rejects(query("INSERT INTO football.daily_featured_combos VALUES($1,$2,2,$3,$4)", ["duplicate", payload.businessDate, JSON.stringify(payload), JSON.stringify({status:"PENDING"})]), { code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_test");
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT to_regnamespace($1) AS n", [schema])).rows[0].n, null);
    return { ok: true, checks: 6, backend: "postgres", transactionRolledBack: true, productionRowsWritten: 0 };
  } finally { await client.query("ROLLBACK"); client.release(); }
}
if (require.main === module) {
  const fs = require("node:fs"), path = require("node:path");
  const pool = require("../server/postgresStore.cjs").createPostgresPool({ max: 1 });
  verify(pool, fs.readFileSync(path.join(__dirname, "../server/postgres/migrations/009_daily_featured_combos.sql"), "utf8"))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
module.exports = { verify };
