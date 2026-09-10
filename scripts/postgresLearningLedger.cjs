"use strict";
const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
const common = require("./modelLearningLedger.cjs");
const { ModelLearningLedgerError: LedgerError, MODEL_LEARNING_LEDGER_VERSION: VERSION, TRANSITIONS,
  sha256, stableStringify, stableValue, canonicalIso, nonempty, assertHash, asBuffer, eventProjection,
  verifyLearningLedgerRows, writeLedgerHeadAnchorFromVerification } = common;
const LOCK = "football-native-learning-ledger-v1";
const tables = Object.freeze({ artifacts: "learning_model_artifacts", events: "learning_events", pointer: "learning_active_model_pointer", leases: "learning_leases" });
const numeric = new Set(["sequence", "cycle_sequence", "byte_length", "generation", "fencing_token", "singleton"]);
const normalizeRow = row => row ? Object.fromEntries(Object.entries(row).map(([key, value]) => {
  if (!numeric.has(key)) return [key, value];
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("unsafe learning ledger integer");
  return [key, number];
})) : null;
const pointerProjection = row => ({ generation: Number(row?.generation || 0), artifactHash: row?.artifact_hash || null,
  previousArtifactHash: row?.previous_artifact_hash || null, eventHash: row?.event_hash || null, updatedAt: row?.updated_at || null });
const one = async (client, sql, values = []) => normalizeRow((await client.query(sql, values)).rows[0]);
const writeTransaction = (pool, task) => withPostgresTransaction(pool, async client => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK]);
  return task(client);
}, { isolationLevel: "READ COMMITTED" });
const assertInitialized = async client => {
  const row = await one(client, "SELECT value FROM football.learning_ledger_meta WHERE key='version'");
  if (row?.value !== VERSION) throw new Error("native learning ledger requires verified import or explicit empty initialization");
  if (!(await one(client, "SELECT singleton FROM football.learning_active_model_pointer WHERE singleton=1"))) throw new Error("native learning pointer missing");
};
const ledgerRows = async client => ({
  artifacts: (await client.query("SELECT * FROM football.learning_model_artifacts ORDER BY artifact_hash")).rows.map(normalizeRow),
  events: (await client.query("SELECT * FROM football.learning_events ORDER BY sequence")).rows.map(normalizeRow),
  pointer: pointerProjection(await one(client, "SELECT * FROM football.learning_active_model_pointer WHERE singleton=1")),
});
const assertFence = async (client, lease) => {
  if (lease == null) return;
  if (typeof lease !== "object" || Array.isArray(lease)) throw new LedgerError("lease fence must be an object", { code: "LEASE_FENCE_INVALID" });
  const name = nonempty(lease.leaseName, "lease.leaseName"), holder = nonempty(lease.holderId, "lease.holderId");
  const token = Math.trunc(Number(lease.fencingToken));
  if (!Number.isSafeInteger(token) || token <= 0) throw new LedgerError("invalid fencing token", { code: "LEASE_FENCE_INVALID" });
  const at = canonicalIso(lease.checkedAt, "lease.checkedAt");
  const row = await one(client, "SELECT * FROM football.learning_leases WHERE lease_name=$1", [name]);
  if (!row || row.holder_id !== holder || row.fencing_token !== token) throw new LedgerError("learning lease ownership changed", { code: "LEASE_FENCE_MISMATCH" });
  if (Date.parse(row.expires_at) <= Date.parse(at)) throw new LedgerError("learning lease expired", { code: "LEASE_EXPIRED" });
};

async function initializeEmptyLearningLedger({ pool, createdAt }) {
  const at = canonicalIso(createdAt, "createdAt");
  return writeTransaction(pool, async client => {
    for (const table of ["learning_ledger_meta", ...Object.values(tables)]) {
      if ((await client.query(`SELECT 1 FROM football.${table} LIMIT 1`)).rows.length) throw new Error("refuse to initialize a nonempty learning ledger");
    }
    await client.query("INSERT INTO football.learning_active_model_pointer VALUES(1,0,NULL,NULL,NULL,$1)", [at]);
    await client.query("INSERT INTO football.learning_ledger_meta VALUES('version',$1)", [VERSION]);
    return { initialized: true, version: VERSION };
  });
}

async function openPostgresLearningLedger(options = {}) {
  const owned = !options.pool, pool = options.pool || createPostgresPool({ max: 2, applicationName: "football-learning-ledger" });
  try { await assertInitialized(pool); } catch (error) { if (owned) await pool.end(); throw error; }
  const write = task => writeTransaction(pool, async client => { await assertInitialized(client); return task(client); });
  const read = task => withPostgresTransaction(pool, async client => { await client.query("SET TRANSACTION READ ONLY"); await assertInitialized(client); return task(client); }, { isolationLevel: "REPEATABLE READ" });
  const verify = () => read(async client => verifyLearningLedgerRows(await ledgerRows(client)));
  return { storage: "postgres", close: async () => { if (owned) await pool.end(); },
    activeModelPointer: () => read(async client => pointerProjection(await one(client, "SELECT * FROM football.learning_active_model_pointer WHERE singleton=1"))),
    verifyLearningLedger: verify,
    writeLedgerHeadAnchor: async (file, config) => writeLedgerHeadAnchorFromVerification(await verify(), file, config),
    acquireLearningLease: ({ leaseName = "model-learning", holderId, now, ttlMs = 900000 }) => write(async client => {
      const name = nonempty(leaseName, "leaseName"), holder = nonempty(holderId, "holderId"), at = canonicalIso(now, "now");
      const safeTtl = Math.max(1000, Math.min(86400000, Math.trunc(Number(ttlMs) || 0)));
      const expires = new Date(Date.parse(at) + safeTtl).toISOString();
      const existing = await one(client, "SELECT * FROM football.learning_leases WHERE lease_name=$1", [name]);
      if (existing && Date.parse(existing.expires_at) > Date.parse(at) && existing.holder_id !== holder) {
        return { acquired: false, leaseName: name, holderId: existing.holder_id, fencingToken: existing.fencing_token, expiresAt: existing.expires_at };
      }
      const token = (existing?.fencing_token || 0) + 1;
      if (!Number.isSafeInteger(token)) throw new Error("learning lease fencing capacity reached");
      await client.query(`INSERT INTO football.learning_leases VALUES($1,$2,$3,$4,$5) ON CONFLICT(lease_name) DO UPDATE SET
        holder_id=EXCLUDED.holder_id,fencing_token=EXCLUDED.fencing_token,acquired_at=EXCLUDED.acquired_at,expires_at=EXCLUDED.expires_at`, [name, holder, token, at, expires]);
      return { acquired: true, leaseName: name, holderId: holder, fencingToken: token, acquiredAt: at, expiresAt: expires };
    }),
    releaseLearningLease: ({ leaseName = "model-learning", holderId, fencingToken }) => write(async client => {
      const result = await client.query("UPDATE football.learning_leases SET expires_at='1970-01-01T00:00:00.000Z' WHERE lease_name=$1 AND holder_id=$2 AND fencing_token=$3",
        [nonempty(leaseName, "leaseName"), nonempty(holderId, "holderId"), Math.trunc(Number(fencingToken))]);
      return { released: result.rowCount === 1 };
    }),
    commitModelArtifact: ({ bytes, artifactType, mediaType = "application/json", metadata = {}, createdAt, declaredHash = null }) => write(async client => {
      const raw = asBuffer(bytes), hash = sha256(raw), type = nonempty(artifactType, "artifactType"), media = nonempty(mediaType, "mediaType");
      const meta = stableStringify(metadata || {}), metaHash = sha256(meta);
      if (declaredHash !== null && assertHash(declaredHash, "declaredHash") !== hash) throw new LedgerError("declared artifact hash does not match bytes", { code: "ARTIFACT_HASH_MISMATCH" });
      const existing = await one(client, "SELECT * FROM football.learning_model_artifacts WHERE artifact_hash=$1", [hash]);
      if (existing) {
        if (!Buffer.from(existing.artifact_bytes).equals(raw)) throw new LedgerError("artifact content conflict", { code: "ARTIFACT_CONTENT_CONFLICT" });
        if (existing.artifact_type !== type || existing.media_type !== media || existing.metadata_hash !== metaHash || existing.metadata_json !== meta) throw new LedgerError("artifact metadata conflict", { code: "ARTIFACT_METADATA_CONFLICT" });
        return { artifactHash: hash, byteLength: raw.length, idempotent: true };
      }
      await client.query("INSERT INTO football.learning_model_artifacts VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [hash, type, media, raw, raw.length, meta, metaHash, canonicalIso(createdAt, "createdAt")]);
      return { artifactHash: hash, byteLength: raw.length, metadataHash: metaHash, idempotent: false };
    }),
    appendLearningEvent: (options) => write(async client => {
      const { cycleId, eventKey, eventType, state, occurredAt, actor, payload = {}, artifactHash = null, lease = null } = options;
      const cycle = assertHash(cycleId, "cycleId"), key = assertHash(eventKey, "eventKey"), next = nonempty(state, "state").toUpperCase(), type = nonempty(eventType, "eventType").toUpperCase();
      // This repository is intentionally shadow-only. Controlled model pointer
      // transitions remain a separate operation; no generic SQL/CAS is exposed.
      if (["PROMOTED", "ROLLED_BACK"].includes(next)) throw new LedgerError("privileged event requires controlled transition API", { code: "PRIVILEGED_EVENT_REQUIRED" });
      await assertFence(client, lease);
      if (!Object.hasOwn(TRANSITIONS, next)) throw new LedgerError("invalid learning state", { code: "INVALID_STATE" });
      const actorValue = stableValue({ type: nonempty(actor?.type, "actor.type"), id: nonempty(actor?.id, "actor.id") });
      const json = stableStringify(stableValue(payload || {})), payloadHash = sha256(json);
      const artifact = artifactHash === null ? null : assertHash(artifactHash, "artifactHash");
      if (artifact && !await one(client, "SELECT artifact_hash FROM football.learning_model_artifacts WHERE artifact_hash=$1", [artifact])) throw new LedgerError("event artifact missing", { code: "ARTIFACT_MISSING" });
      const duplicate = await one(client, "SELECT * FROM football.learning_events WHERE event_key=$1", [key]);
      if (duplicate) {
        if (duplicate.cycle_id !== cycle || duplicate.event_type !== type || duplicate.state !== next || duplicate.artifact_hash !== artifact || stableStringify(JSON.parse(duplicate.payload_json)) !== json) throw new LedgerError("event key content conflict", { code: "EVENT_KEY_CONFLICT" });
        return { event: eventProjection(duplicate), eventHash: duplicate.event_hash, idempotent: true };
      }
      const head = await one(client, "SELECT * FROM football.learning_events ORDER BY sequence DESC LIMIT 1");
      const cycleHead = await one(client, "SELECT * FROM football.learning_events WHERE cycle_id=$1 ORDER BY cycle_sequence DESC LIMIT 1", [cycle]);
      if (!(TRANSITIONS[cycleHead?.state || "__START__"] || []).includes(next)) throw new LedgerError("invalid learning state transition", { code: "INVALID_STATE_TRANSITION" });
      const row = { sequence: (head?.sequence || 0) + 1, cycle_sequence: (cycleHead?.cycle_sequence || 0) + 1, cycle_id: cycle, event_key: key,
        event_type: type, state: next, occurred_at: canonicalIso(occurredAt, "occurredAt"), actor_json: stableStringify(actorValue), payload_json: json,
        payload_hash: payloadHash, artifact_hash: artifact, previous_event_hash: head?.event_hash || null,
        previous_cycle_event_hash: cycleHead?.event_hash || null, previous_cycle_state: cycleHead?.state || null };
      if (![row.sequence, row.cycle_sequence].every(Number.isSafeInteger)) throw new Error("learning event capacity reached");
      const eventHash = sha256(stableStringify(eventProjection(row)));
      await client.query(`INSERT INTO football.learning_events(sequence,cycle_sequence,cycle_id,event_key,event_type,state,occurred_at,actor_json,payload_json,payload_hash,
        artifact_hash,previous_event_hash,previous_cycle_event_hash,previous_cycle_state,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [...Object.values(row), eventHash]);
      return { event: eventProjection(row), eventHash, idempotent: false };
    }),
  };
}
module.exports = { openPostgresLearningLedger, initializeEmptyLearningLedger, normalizeRow, ledgerRows, pointerProjection, writeTransaction, tables };
