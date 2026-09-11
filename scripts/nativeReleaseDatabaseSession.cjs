"use strict";
// Stateful database side of the signed publisher. The caller retains the
// generation/write barrier and durable v4 recovery journal. This module has
// no CLI, creates no database and cannot stop an application or bypass gates.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { mirrorPostgresCandidate } = require("./postgresReleaseMirror.cjs");
const { fenceNativeDatabaseConnections, switchNativeDatabase } = require("./nativeDatabaseCutover.cjs");
const keys = ["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"];
async function publication(client) {
  const values = Object.fromEntries((await client.query("SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])", [keys])).rows.map(row => [row.key, row.value]));
  const identity = { mode: values[keys[0]], generationId: values[keys[1]], manifestHash: values[keys[2]], sourceCycleId: values[keys[3]], committedAt: values[keys[4]] };
  assert.equal(identity.mode, "active-generation"); assert.match(identity.generationId, /^g-[a-f0-9]{64}$/);
  assert.equal(identity.generationId, "g-" + identity.manifestHash);
  assert.ok(identity.sourceCycleId && Number.isFinite(Date.parse(identity.committedAt)));
  return identity;
}
class NativeReleaseDatabaseSession {
  constructor({ sourcePool, candidatePool, administrator, contract, key = crypto.randomBytes(32) }) {
    assert.notEqual(sourcePool, candidatePool);
    assert.ok(Buffer.isBuffer(key) && key.length === 32);
    this.sourcePool = sourcePool; this.candidatePool = candidatePool; this.administrator = administrator;
    this.contract = contract; this.key = key; this.source = null; this.identity = null;
    this.phase = "ready"; this.poolsClosed = false; this.lastMirror = null;
  }
  async checkDatabase(client, name, oid) {
    const row = (await client.query("SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid")).rows[0];
    assert.equal(row.name, name); assert.equal(row.oid, oid);
  }
  async beginSnapshot() {
    assert.equal(this.phase, "ready"); assert.equal(this.source, null);
    this.source = await this.sourcePool.connect();
    try {
      await this.checkDatabase(this.source, "football", this.contract.oldDatabaseOid);
      await this.source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='2s'");
      this.identity = await publication(this.source); this.phase = "snapshot";
      return this.identity;
    } catch (error) { await this.releaseSnapshot(error); throw error; }
  }
  async mirror(onProgress = () => {}) {
    assert.equal(this.phase, "snapshot");
    const report = await mirrorPostgresCandidate({ sourceSession: { client: this.source, pool: this.sourcePool, identity: this.identity },
      candidatePool: this.candidatePool, key: this.key, expectedSourceDatabase: "football", onProgress });
    assert.equal(report.ok, true); assert.deepEqual(report.publication, this.identity);
    this.lastMirror = report; return report;
  }
  async releaseSnapshot(reason) {
    if (this.source) {
      let error = reason;
      try { await this.source.query("ROLLBACK"); } catch (failure) { error ||= failure; }
      this.source.release(error); this.source = null;
    }
    this.identity = null;
    if (!["fenced", "switched", "failed", "closed"].includes(this.phase)) this.phase = "ready";
  }
  async finalMirrorAndSwitch({ verifyDurableBarrier, verifyGeneration, completeCandidate = async () => {}, onProgress = () => {} }) {
    assert.equal(this.phase, "ready"); assert.equal(this.source, null);
    assert.equal(this.lastMirror?.ok, true, "a tested candidate mirror is required before the stopped window");
    assert.equal(typeof verifyDurableBarrier, "function"); assert.equal(typeof verifyGeneration, "function");
    // The source and target connections must already exist before closing the
    // admission gate. Pools must retain these sessions until this call ends.
    let retainedTarget, fenced = false;
    try {
      this.source = await this.sourcePool.connect(); retainedTarget = await this.candidatePool.connect();
      await this.checkDatabase(this.source, "football", this.contract.oldDatabaseOid);
      await this.checkDatabase(retainedTarget, this.contract.candidateDatabase, this.contract.newDatabaseOid);
      const sourcePid = (await this.source.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const targetPid = (await retainedTarget.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const assertDrained = async () => {
        const other = (await this.administrator.query("SELECT pid,datname FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND pid<>ALL($2::int[])",
          [["football", this.contract.candidateDatabase], [sourcePid, targetPid]])).rows;
        assert.equal(other.length, 0, "unknown application/candidate connections remain; no forced disconnect");
        assert.equal((await this.administrator.query("SELECT count(*)::int n FROM pg_prepared_xacts WHERE database=ANY($1::text[])", [["football", this.contract.candidateDatabase]])).rows[0].n, 0);
      };
      await assertDrained();
      await verifyDurableBarrier(this.contract);
      await fenceNativeDatabaseConnections(this.administrator, this.contract); fenced = true; this.phase = "fenced";
      await assertDrained();
      await this.source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='2s'");
      this.identity = await publication(this.source);
      await verifyGeneration(this.identity);
      // Hold the target session explicitly: an idle timeout or maxUses setting
      // must never attempt a replacement connection after admission is closed.
      const fixedPool = { connect: async () => ({ query: retainedTarget.query.bind(retainedTarget), release: () => {} }) };
      const mirror = await mirrorPostgresCandidate({ sourceSession: { client: this.source, pool: this.sourcePool, identity: this.identity },
        candidatePool: fixedPool, key: this.key, expectedSourceDatabase: "football", onProgress });
      assert.equal(mirror.ok, true);
      // Initial retirement imports the separately audited learning/research
      // ledgers here. Ordinary native releases pass no legacy import hook.
      await completeCandidate({ client: retainedTarget, identity: this.identity });
      assert.deepEqual(await publication(retainedTarget), this.identity);
      await verifyGeneration(this.identity); await verifyDurableBarrier(this.contract); await assertDrained();
      const identity = this.identity;
      await this.releaseSnapshot(); retainedTarget.release(); retainedTarget = null;
      await this.closePools();
      const switched = await switchNativeDatabase(this.administrator, this.contract); this.phase = "switched";
      return { ok: true, publication: identity, mirror, switched, terminatedConnections: 0, sqliteExports: 0 };
    } catch (error) {
      const stage = this.phase; this.phase = "failed";
      error.nativeSession = { fenced, recoveryRequired: fenced, contract: this.contract, stage };
      throw error;
    } finally {
      await this.releaseSnapshot(); if (retainedTarget) retainedTarget.release();
      await this.closePools();
    }
  }
  async closePools() {
    if (!this.poolsClosed) { this.poolsClosed = true; await Promise.all([this.sourcePool.end(), this.candidatePool.end()]); }
  }
  async close() { await this.releaseSnapshot(); await this.closePools(); this.key.fill(0); if (this.phase !== "switched") this.phase = "closed"; }
}
module.exports = { NativeReleaseDatabaseSession, publication };
