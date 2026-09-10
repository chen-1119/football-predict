"use strict";
// One-time retirement audit only. This is deliberately not a normal release
// step: it streams every original projection row once, never sampled payloads.
const path = require("node:path"), crypto = require("node:crypto");
const { openPostgresRuntimeReadSession } = require("./postgresRuntimeReadSession.cjs");
const definitions = Object.freeze({
  match_snapshots: ["id", "dataset", "match_id", "source_match_id", "kickoff_time", "status", "payload"],
  source_snapshots: ["id", "source", "captured_at", "payload"],
  odds_snapshots: ["id", "state_key", "match_id", "source_match_id", "pool", "bookmaker", "handicap_line", "captured_at", "first_seen_at", "last_seen_at", "seen_count", "payload"],
  prediction_snapshots: ["id", "state_key", "match_id", "source_match_id", "phase", "captured_at", "first_seen_at", "last_seen_at", "seen_count", "payload"],
  private_model_artifacts: ["artifact_key", "artifact_version", "generated_at", "updated_at", "payload", "payload_sha256", "payload_bytes"],
});
const normal = (key, value) => {
  if (key === "payload") { if (typeof value !== "string") throw new Error("retirement audit requires raw payload text"); return value; }
  if (value === null || value === undefined || value === "") return null;
  if (["captured_at", "first_seen_at", "last_seen_at", "kickoff_time", "generated_at", "updated_at"].includes(key)) {
    const time = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(time.getTime())) throw new Error("invalid retirement audit clock");
    return time.toISOString();
  }
  if (["seen_count", "handicap_line", "payload_bytes"].includes(key)) {
    const number = Number(value); if (!Number.isFinite(number)) throw new Error("invalid retirement audit number"); return number;
  }
  return String(value);
};
const encoded = (row, columns) => JSON.stringify(columns.map(key => normal(key, row[key])));
const add = (hash, raw) => { hash.update(String(Buffer.byteLength(raw))); hash.update(":"); hash.update(raw); };

async function verifyPostgresRetirementParity(options = {}) {
  const session = await openPostgresRuntimeReadSession({ ...options, protectReceipt: true });
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const file = path.resolve(options.sqlitePath || process.env.DATASTORE_SQLITE_PATH || path.join(options.storeDir || process.env.SERVER_STORE_DIR || "server-data", "football.db"));
    db = new DatabaseSync(file, { readOnly: true }); db.exec("PRAGMA busy_timeout=1000; BEGIN");
    const identityKeys = { data_publication_mode: "mode", data_generation_id: "generationId", manifest_hash: "manifestHash",
      data_generation_source_cycle_id: "sourceCycleId", committed_at: "committedAt" };
    const meta = new Map(db.prepare("SELECT key,value,updated_at FROM schema_meta ORDER BY key").all().map(row => [row.key, row]));
    for (const [key, field] of Object.entries(identityKeys)) if (meta.get(key)?.value !== session.identity[field])
      throw new Error("retirement publication identity differs: " + field);
    const fastKeys = [...meta.keys()].filter(key => key.startsWith("fast_result_"));
    const pgMeta = (await session.client.query("SELECT key,value,updated_at FROM football.projection_meta WHERE key LIKE 'fast_result_%' ORDER BY key COLLATE \"C\"")).rows;
    if (pgMeta.length !== fastKeys.length) throw new Error("retirement fast receipt metadata membership differs");
    for (const row of pgMeta) {
      const original = meta.get(row.key);
      if (!original || original.value !== row.value || normal("updated_at", original.updated_at) !== normal("updated_at", row.updated_at))
        throw new Error("retirement fast receipt metadata bytes or clock differ");
    }
    await session.guardedFinals(); // Validate the complete signed receipt/high-water relationship, not only equality.
    const tables = {};
    for (const [table, columns] of Object.entries(definitions)) {
      const key = columns[0], where = table === "match_snapshots" ? "WHERE dataset IN ('current','history')" : "";
      const sqliteColumns = columns.map(column => column === "payload" && table === "private_model_artifacts" ? "payload_json AS payload" : column).join(",");
      const original = db.prepare(`SELECT ${sqliteColumns} FROM ${table} ${where} ORDER BY ${key} COLLATE BINARY`).iterate();
      const pgColumns = columns.map(column => column === "payload" ? "payload::text AS payload" : column).join(",");
      await session.client.query(`DECLARE retirement_rows NO SCROLL CURSOR FOR SELECT ${pgColumns} FROM football.${table} ${where} ORDER BY ${key} COLLATE "C"`);
      const sourceHash = crypto.createHash("sha256"), targetHash = crypto.createHash("sha256");
      let count = 0, payloadBytes = 0;
      while (true) {
        const batch = await session.client.query("FETCH FORWARD 128 FROM retirement_rows");
        if (!batch.rows.length) break;
        for (const row of batch.rows) {
          const previous = original.next();
          if (previous.done) throw new Error(`retirement row membership differs: ${table}`);
          const before = encoded(previous.value, columns), after = encoded(row, columns);
          if (before !== after) throw new Error(`retirement original row differs: ${table} at position ${count}`);
          add(sourceHash, before); add(targetHash, after); count++; payloadBytes += Buffer.byteLength(row.payload);
        }
      }
      if (!original.next().done) throw new Error(`retirement missing PostgreSQL rows: ${table}`);
      await session.client.query("CLOSE retirement_rows");
      tables[table] = { rows: count, payloadBytes, sourceHash: sourceHash.digest("hex"), postgresHash: targetHash.digest("hex") };
    }
    return { ok: true, version: "postgres-retirement-full-parity-v1", checkedAt: new Date().toISOString(), publication: session.identity,
      tables, fastReceiptMetadataRows: pgMeta.length, sampled: false, productionWrites: 0, permitsRetirement: false,
      remainingGate: "independent candidate, backup recovery and complete native runtime acceptance" };
  } finally { try { db?.close(); } finally { await session.close(); } }
}
module.exports = { verifyPostgresRetirementParity };
if (require.main === module) verifyPostgresRetirementParity().then(report => console.log(JSON.stringify(report, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
