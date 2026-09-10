"use strict";
const crypto = require("node:crypto");
const common = require("./openFootballObservationStore.cjs");
const { auditNativeClient, writeTransaction, cursorRows } = require("./postgresObservationStore.cjs");
const specs = Object.freeze([
  { legacy: "source_contents", native: "research_source_contents", keys: ["source_url", "content_hash", "raw", "first_received_at", "first_receipt_hash"], order: "source_url,content_hash" },
  { legacy: "observations", native: "research_observations", keys: ["sequence", "source_url", "content_hash", "received_at", "receipt_json", "receipt_hash"], order: "sequence" },
]);
const addHash = (hash, spec, row) => hash.update(JSON.stringify([spec.legacy, spec.keys.map(key => key === "raw"
  ? [row.raw.length, common.digest(Buffer.from(row.raw))] : row[key])]) + "\n");
async function postgresObservationHash(client) {
  const hash = crypto.createHash("sha256");
  for (const spec of specs) {
    for await (const row of cursorRows(client, "research_import_hash", `SELECT * FROM football.${spec.native} ORDER BY ${spec.order}`, spec.legacy === "source_contents" ? 1 : 128)) addHash(hash, spec, row);
  }
  return hash.digest("hex");
}
function importPostgresObservationStore({ pool, storeDir }) {
  // Explicit one-time legacy read, not a runtime fallback. Keep the actual
  // SQLite read transaction open until PostgreSQL COMMIT or ROLLBACK finishes.
  return common.readAuditedObservationStore(storeDir, async (db, sourceAudit) => {
    const hash = crypto.createHash("sha256");
    for (const spec of specs) {
      for (const row of db.prepare(`SELECT * FROM ${spec.legacy} ORDER BY ${spec.order}`).iterate()) addHash(hash, spec, row);
    }
    const sourceHash = hash.digest("hex");
    return writeTransaction(pool, async client => {
      const meta = (await client.query("SELECT key,value FROM football.research_observation_meta ORDER BY key")).rows;
      const hasRows = (await client.query("SELECT EXISTS(SELECT 1 FROM football.research_observations) OR EXISTS(SELECT 1 FROM football.research_source_contents) AS populated")).rows[0].populated;
      if (meta.length || hasRows) {
        if (meta.find(row => row.key === "schema")?.value !== common.VERSION || await postgresObservationHash(client) !== sourceHash) throw new Error("refuse to overwrite nonidentical native research receipts");
        await auditNativeClient(client);
        return { ok: true, idempotent: true, sourceHash, sourceAudit };
      }
      for (const spec of specs) {
        const sql = `INSERT INTO football.${spec.native}(${spec.keys.join(",")}) VALUES(${spec.keys.map((_, i) => "$" + (i + 1)).join(",")})`;
        for (const row of db.prepare(`SELECT * FROM ${spec.legacy} ORDER BY ${spec.order}`).iterate()) {
          await client.query(sql, spec.keys.map(key => key === "raw" ? Buffer.from(row.raw) : row[key]));
        }
      }
      const targetAudit = await auditNativeClient(client, { allowUninitialized: true });
      if (JSON.stringify(targetAudit) !== JSON.stringify(sourceAudit) || await postgresObservationHash(client) !== sourceHash) throw new Error("research receipt import changed bytes, clocks or hash chain");
      await client.query("INSERT INTO football.research_observation_meta VALUES('schema',$1),('import_source_hash',$2)", [common.VERSION, sourceHash]);
      return { ok: true, idempotent: false, sourceHash, sourceAudit };
    });
  });
}
module.exports = { importPostgresObservationStore, postgresObservationHash };
