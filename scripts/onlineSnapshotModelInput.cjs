"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function readOnlineSnapshotModelInput({ inputDataDir, manifestFile }) {
  if (!manifestFile) throw new Error("online snapshot input requires MODEL_BACKTEST_ONLINE_SNAPSHOT_MANIFEST");
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestFile), "utf8"));
  const manifest = parsed.manifest || parsed;
  if (manifest.ok !== true || manifest.version !== "readonly-online-postgres-snapshot-export-v1"
      || manifest.sourceHost !== "134.175.132.183" || manifest.productionWrites !== false
      || manifest.databaseSnapshot?.read_only !== "on" || manifest.databaseSnapshot?.isolation !== "repeatable read"
      || ["mode", "generationId", "manifestHash", "sourceCycleId", "committedAt"].some((key) =>
        !manifest.publication?.[key] || manifest.publication[key] !== manifest.expectedPublication?.[key])) {
    throw new Error("online snapshot receipt is not a verified read-only publication");
  }
  const read = (name, isRows) => {
    const descriptors = (manifest.files || []).filter((file) => file.name === name);
    if (descriptors.length !== 1) throw new Error(`online snapshot file descriptor missing or duplicated: ${name}`);
    const descriptor = descriptors[0];
    const file = path.join(inputDataDir, name);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== descriptor.bytes
        || crypto.createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      throw new Error(`online snapshot file hash mismatch: ${name}`);
    }
    const payload = JSON.parse(bytes.toString("utf8"));
    const rows = isRows ? payload?.rows : payload;
    if (!Array.isArray(rows) || rows.length !== descriptor.rows) throw new Error(`online snapshot row count mismatch: ${name}`);
    return rows;
  };
  const current = read("matches-current.json", false);
  const history = read("matches-history.json", false);
  const results = {};
  for (const [table, file] of [["prediction_snapshots", "prediction-snapshots.json"], ["odds_snapshots", "odds-history.json"]]) {
    const rows = read(file, true);
    const audit = manifest.collectorAudit?.[table];
    if (audit?.ok !== true || audit.uniqueRows !== rows.length
        || !Number.isSafeInteger(audit.selectedRows) || !Number.isSafeInteger(audit.parsedRows)
        || audit.selectedRows < audit.parsedRows || audit.parsedRows < rows.length) {
      throw new Error(`online snapshot collector audit invalid: ${table}`);
    }
    results[table] = { ...audit, ok: true, rows, source: "online-snapshot", table,
      publication: manifest.publication, snapshot: manifest.databaseSnapshot.snapshot,
      selectionAlreadyApplied: true, replayPolicy: "preserve-exported-order-and-cohort; no re-filter, dedup, max-per-match selection or public/SQLite merge" };
  }
  return { current, history, ...results, publication: manifest.publication, source: "online-snapshot",
    receipt: { manifestFile: path.resolve(manifestFile), databaseSnapshot: manifest.databaseSnapshot,
      collectorAudit: manifest.collectorAudit, rawTableCounts: manifest.rawTableCounts } };
}

module.exports = { readOnlineSnapshotModelInput };
