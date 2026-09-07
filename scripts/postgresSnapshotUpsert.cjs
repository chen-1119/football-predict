"use strict";
// Retain full inventory/hash/pruning and exact json text, but avoid redundant
// UPDATE/TOAST rewrites. ON CONFLICT still locks rows; this is not a zero-I/O path.
const definitions = Object.freeze({
  match_snapshots: { key: "id", columns: ["dataset", "match_id", "source_match_id", "kickoff_time", "status", "payload"] },
  source_snapshots: { key: "id", columns: ["source", "captured_at", "payload"] },
  odds_snapshots: { key: "id", columns: ["state_key", "match_id", "source_match_id", "pool", "bookmaker", "handicap_line", "captured_at", "first_seen_at", "last_seen_at", "seen_count", "payload"], mergeSeen: true },
  prediction_snapshots: { key: "id", columns: ["state_key", "match_id", "source_match_id", "phase", "captured_at", "first_seen_at", "last_seen_at", "seen_count", "payload"], mergeSeen: true },
  private_model_artifacts: { key: "artifact_key", columns: ["artifact_version", "generated_at", "updated_at", "payload", "payload_sha256", "payload_bytes"] },
});
function snapshotUpsertConflict(table) {
  if (!Object.hasOwn(definitions, table)) throw new Error("Unsupported snapshot upsert table");
  const config = definitions[table];
  const target = `football.${table}`;
  const replacement = column => {
    if (config.mergeSeen && ["first_seen_at", "last_seen_at", "seen_count"].includes(column)) {
      return `${column === "first_seen_at" ? "LEAST" : "GREATEST"}(${target}.${column}, EXCLUDED.${column})`;
    }
    return `EXCLUDED.${column}`;
  };
  const previous = config.columns.map(column => `${target}.${column}${column === "payload" ? "::text" : ""}`);
  const incoming = config.columns.map(column => `${replacement(column)}${column === "payload" ? "::text" : ""}`);
  return `ON CONFLICT (${config.key}) DO UPDATE SET\n${config.columns.map(column => `${column} = ${replacement(column)}`).join(",\n")}\nWHERE ROW(${previous.join(", ")}) IS DISTINCT FROM ROW(${incoming.join(", ")})`;
}
module.exports = { snapshotUpsertConflict };
