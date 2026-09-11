"use strict";
// Database primitive for a future signed native publisher, not a CLI or a
// migration authorization. The publisher must first verify its accepted
// bootstrap, durable v4 recovery journal, data parity and stopped writers.
// No database is dropped, restored, copied or forcibly disconnected here.
const assert = require("node:assert/strict");
const quote = name => {
  assert.match(name, /^(football|football_(release|legacy)_[a-f0-9]{12}_[0-9]{1,10})$/);
  return '"' + name + '"';
};
function validate(contract) {
  assert.equal(contract?.version, "native-app-data-forward-v1");
  assert.equal(contract.kind, "initial-cutover");
  assert.match(contract.clusterId, /^[0-9]{10,20}$/);
  assert.match(contract.compatibleRuntimeSha256, /^[a-f0-9]{64}$/);
  assert.match(contract.candidateDatabase, /^football_release_[a-f0-9]{12}_[0-9]{1,10}$/);
  assert.match(contract.archiveDatabase, /^football_legacy_[a-f0-9]{12}_[0-9]{1,10}$/);
  for (const oid of [contract.oldDatabaseOid, contract.newDatabaseOid]) {
    assert.match(oid, /^[1-9][0-9]{0,9}$/); assert.ok(BigInt(oid) <= 4294967295n);
  }
  assert.notEqual(contract.oldDatabaseOid, contract.newDatabaseOid);
}
async function topology(client, contract) {
  const identity = (await client.query("SELECT current_database() AS database, current_user AS username, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS administrator, (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id")).rows[0];
  assert.equal(identity.database, "postgres", "cutover connection must use the maintenance database");
  assert.equal(identity.administrator, true, "cutover requires the local database administrator");
  assert.equal(identity.cluster_id, contract.clusterId, "database cluster changed");
  const rows = (await client.query("SELECT datname AS name, oid::text AS oid, pg_get_userbyid(datdba) AS owner, datallowconn AS allows_connections FROM pg_database WHERE datname = ANY($1::text[])", [["football", contract.candidateDatabase, contract.archiveDatabase]])).rows;
  return Object.fromEntries(rows.map(row => [row.name, row]));
}
async function switchNativeDatabase(client, contract) {
  validate(contract);
  let begun = false;
  try {
    begun = true; await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
    assert.equal((await client.query("SELECT pg_try_advisory_xact_lock(hashtext('football-native-database-cutover-v1')) AS locked")).rows[0].locked, true, "database cutover already running");
    const before = await topology(client, contract);
    assert.equal(before.football?.oid, contract.oldDatabaseOid, "old database identity changed or switch already committed");
    assert.equal(before[contract.candidateDatabase]?.oid, contract.newDatabaseOid, "candidate database identity changed");
    assert.equal(before[contract.archiveDatabase], undefined, "archive database already exists");
    assert.equal(before.football.owner, "football"); assert.equal(before[contract.candidateDatabase].owner, "football");
    const names = ["football", contract.candidateDatabase];
    assert.equal((await client.query("SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=ANY($1::text[])", [names])).rows[0].connections, 0, "application or candidate connections have not drained");
    assert.equal((await client.query("SELECT count(*)::int AS transactions FROM pg_prepared_xacts WHERE database=ANY($1::text[])", [names])).rows[0].transactions, 0, "prepared database transactions remain");
    await client.query("ALTER DATABASE football ALLOW_CONNECTIONS false");
    await client.query("ALTER DATABASE " + quote(contract.candidateDatabase) + " ALLOW_CONNECTIONS false");
    // Both catalog renames commit together. PostgreSQL's rename locks also
    // reject a racing connection; a failure rolls both names and flags back.
    await client.query("ALTER DATABASE football RENAME TO " + quote(contract.archiveDatabase));
    await client.query("ALTER DATABASE " + quote(contract.candidateDatabase) + " RENAME TO football");
    await client.query("ALTER DATABASE football ALLOW_CONNECTIONS true");
    const after = await topology(client, contract);
    assert.equal(after.football?.oid, contract.newDatabaseOid); assert.equal(after.football.allows_connections, true);
    assert.equal(after[contract.archiveDatabase]?.oid, contract.oldDatabaseOid); assert.equal(after[contract.archiveDatabase].allows_connections, false);
    assert.equal(after[contract.candidateDatabase], undefined);
    await client.query("COMMIT"); begun = false;
    return { ok: true, version: "native-database-cutover-v1", clusterId: contract.clusterId, before, after,
      databaseDrops: 0, databaseRestores: 0, terminatedConnections: 0, applicationActivated: false };
  } catch (error) {
    if (begun) try { await client.query("ROLLBACK"); } catch { /* Preserve the original error; recovery must observe the actual OIDs. */ }
    throw error;
  }
}
module.exports = { switchNativeDatabase };
