"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const native = require("./postgresObservationStore.cjs");
const { LEAGUES } = require("./auditOpenFootballCurrentSeason.cjs");

async function verifyPostgresObservationStore(pool) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-observations-")), checks = [];
  const raw = league => Buffer.from(JSON.stringify({ name: `${LEAGUES[league]} 2026/27`, matches: [
    { date: "2026-08-31", team1: "Alpha FC", team2: "Beta FC", score: { ft: [1, 0] } },
  ] }));
  try {
    await assert.rejects(native.auditPostgresObservationStore({ pool }), /requires verified import/);
    const code = `const c=require('./scripts/openFootballObservationStore.cjs'),m=require('./scripts/importPostgresObservationStore.cjs'),{Pool}=require('pg');
      const pool=new Pool({connectionString:process.env.EVIDENCE_TEST_POSTGRES_URL,ssl:false});
      const raw=Buffer.from(JSON.stringify({name:'English Premier League 2026/27',matches:[{date:'2026-08-31',team1:'Alpha FC',team2:'Beta FC',score:{ft:[1,0]}}]}));
      const args={storeDir:process.argv[1],season:'2026-27',league:'en.1',raw,requestStartedAt:'2026-09-07T12:00:00.000Z',receivedAt:'2026-09-07T12:00:00.000Z'};
      (async()=>{c.recordSourceObservation(args);const first=await m.importPostgresObservationStore({pool,storeDir:process.argv[1]});
        const repeat=await m.importPostgresObservationStore({pool,storeDir:process.argv[1]});if(first.idempotent||!repeat.idempotent)throw new Error('import idempotence failed');
        console.log(JSON.stringify({ok:true,first}));})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>pool.end());`;
    const child = spawnSync(process.execPath, ["-e", code, temp], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).ok, true);
    assert.equal((await native.auditPostgresObservationStore({ pool })).observations, 1);
    await assert.rejects(native.initializeEmptyObservationStore({ pool }), /nonempty/);
    checks.push({ name: "real legacy research receipt imports raw bytes and original clocks idempotently without resetting history", ok: true });
    const beforeMatches = (await pool.query("SELECT count(*) n FROM football.match_snapshots")).rows[0].n;
    const at = "2026-09-08T12:00:00.000Z";
    const initialContent = (await pool.query("SELECT * FROM football.research_source_contents")).rows[0];
    const repeated = await native.recordPostgresObservation({ pool, season: "2026-27", league: "en.1", raw: initialContent.raw,
      requestStartedAt: at, receivedAt: at });
    assert.equal(repeated.reusedContent, true); assert.equal(repeated.firstObservedAt, initialContent.first_received_at);
    assert.equal(repeated.previousContentReceiptHash, initialContent.first_receipt_hash);
    assert.equal(repeated.sourceVerified, false); assert.equal(repeated.productionEligible, false); assert.equal(repeated.officialSettlementAllowed, false);
    const collection = await native.collectPostgresSeasonObservations({ pool, storeDir: temp, season: "2026-27", clock: () => at,
      fetchImpl: async url => new Response(raw(Object.keys(LEAGUES).find(league => url.endsWith(league + ".json")))) });
    assert.equal(collection.ok, true, JSON.stringify(collection)); assert.equal(collection.providerRequests, Object.keys(LEAGUES).length);
    assert.equal(collection.productionAdmittedRows, 0); assert.equal(collection.officialResultWrites, 0); assert.equal(collection.predictionWrites, 0);
    assert.equal((await pool.query("SELECT count(*) n FROM football.match_snapshots")).rows[0].n, beforeMatches);
    checks.push({ name: "native five-source collector retains first receipt time and never promotes unverified community data to matches", ok: true });
    const receipt = (await pool.query("SELECT * FROM football.research_observations ORDER BY sequence LIMIT 1")).rows[0];
    try {
      await pool.query("UPDATE football.research_observations SET receipt_json='{}' WHERE sequence=$1", [receipt.sequence]);
      const count = (await pool.query("SELECT count(*) n FROM football.research_observations")).rows[0].n;
      await assert.rejects(native.recordPostgresObservation({ pool, season: "2026-27", league: "en.1", raw: raw("en.1"), requestStartedAt: at, receivedAt: at }), /integrity/);
      assert.equal((await pool.query("SELECT count(*) n FROM football.research_observations")).rows[0].n, count);
    } finally { await pool.query("UPDATE football.research_observations SET receipt_json=$1 WHERE sequence=$2", [receipt.receipt_json, receipt.sequence]); }
    assert.equal((await native.auditPostgresObservationStore({ pool })).ok, true);
    checks.push({ name: "native receipt corruption rolls back the entire new observation without resetting or truncating prior audit", ok: true });
    return { ok: true, checks, legacyMigrationSqliteProcesses: 1, externalProviderRequests: 0 };
  } finally {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-native-observations-")); fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyPostgresObservationStore };
