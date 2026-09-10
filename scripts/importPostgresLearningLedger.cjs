"use strict";
const path = require("node:path");
const common = require("./modelLearningLedger.cjs");
const { normalizeRow, pointerProjection, writeTransaction, tables } = require("./postgresLearningLedger.cjs");
const columns = Object.freeze({
  artifacts: ["artifact_hash", "artifact_type", "media_type", "artifact_bytes", "byte_length", "metadata_json", "metadata_hash", "created_at"],
  events: ["sequence", "cycle_sequence", "cycle_id", "event_key", "event_type", "state", "occurred_at", "actor_json", "payload_json", "payload_hash", "artifact_hash", "previous_event_hash", "previous_cycle_event_hash", "previous_cycle_state", "event_hash"],
  pointer: ["singleton", "generation", "artifact_hash", "previous_artifact_hash", "event_hash", "updated_at"],
  leases: ["lease_name", "holder_id", "fencing_token", "acquired_at", "expires_at"],
});
const legacyTables = { artifacts: "model_artifacts", events: "model_learning_events", pointer: "active_model_pointer", leases: "learning_leases" };
const validate = snapshot => {
  for (const [kind, names] of Object.entries(columns)) {
    if (!Array.isArray(snapshot[kind])) throw new Error("missing learning snapshot table");
    for (const row of snapshot[kind]) {
      if (Object.keys(row).sort().join() !== [...names].sort().join()) throw new Error("unexpected learning snapshot columns");
      normalizeRow(row);
    }
  }
  if (snapshot.pointer.length !== 1 || snapshot.pointer[0].singleton !== 1) throw new Error("missing unique learning pointer");
  const verified = common.verifyLearningLedgerRows({ ...snapshot, pointer: pointerProjection(snapshot.pointer[0]) });
  if (!verified.valid) throw new Error("source learning ledger audit failed: " + verified.errors.join(","));
  return verified;
};
const fingerprint = snapshot => common.sha256(common.stableStringify(snapshot));
const normalizedSnapshot = snapshot => Object.fromEntries(Object.keys(columns).map(kind => [kind, snapshot[kind].map(row => {
  const value = normalizeRow(row);
  return { ...value, ...(kind === "artifacts" ? { artifact_bytes: Buffer.from(value.artifact_bytes) } : {}) };
})]));

function readSqliteLearningLedgerSnapshot(file) {
  const { db } = common.openLearningLedger(path.resolve(file), { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = normalizedSnapshot(Object.fromEntries(Object.entries(legacyTables).map(([kind, table]) =>
      [kind, db.prepare(`SELECT * FROM ${table} ORDER BY ${columns[kind][0]}`).all()])));
    validate(snapshot); db.exec("COMMIT"); return snapshot;
  } finally { db.close(); }
}

async function readPostgresLearningLedgerSnapshot(client) {
  const snapshot = {};
  for (const [kind, table] of Object.entries(tables)) {
    snapshot[kind] = (await client.query(`SELECT * FROM football.${table} ORDER BY ${columns[kind][0]}`)).rows;
  }
  return normalizedSnapshot(snapshot);
}

async function importPostgresLearningLedger({ pool, snapshot }) {
  // Deep normalize before opening a transaction; no hash/timestamp regeneration.
  const source = normalizedSnapshot(snapshot), verified = validate(source), sourceHash = fingerprint(source);
  return writeTransaction(pool, async client => {
    const target = await readPostgresLearningLedgerSnapshot(client);
    const meta = (await client.query("SELECT key,value FROM football.learning_ledger_meta ORDER BY key")).rows;
    if (Object.values(target).some(rows => rows.length) || meta.length) {
      if (meta.find(row => row.key === "version")?.value !== common.MODEL_LEARNING_LEDGER_VERSION
        || fingerprint(target) !== sourceHash) throw new Error("refuse to overwrite nonidentical native learning ledger");
      validate(target);
      return { ok: true, idempotent: true, sourceHash, ...verified };
    }
    for (const [kind, table] of Object.entries(tables)) {
      const names = columns[kind];
      for (const row of source[kind]) {
        await client.query(`INSERT INTO football.${table}(${names.join(",")}) VALUES(${names.map((_, index) => "$" + (index + 1)).join(",")})`, names.map(name => row[name]));
      }
    }
    const imported = await readPostgresLearningLedgerSnapshot(client);
    if (fingerprint(imported) !== sourceHash) throw new Error("learning ledger import changed bytes or clocks");
    validate(imported);
    await client.query("INSERT INTO football.learning_ledger_meta VALUES('version',$1),('import_source_hash',$2)", [common.MODEL_LEARNING_LEDGER_VERSION, sourceHash]);
    return { ok: true, idempotent: false, sourceHash, ...verified };
  });
}
module.exports = { readSqliteLearningLedgerSnapshot, readPostgresLearningLedgerSnapshot, importPostgresLearningLedger, fingerprint };
