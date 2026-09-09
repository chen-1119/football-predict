"use strict";
const { readFastResultReceiptState } = require("./fastResultReceiptIntegrity.cjs");
const { loadAuthorityHighWater, persistAuthorityHighWater } = require("./fastResultAuthorityHighWater.cjs");
function createSqliteFastResultRepository(dbPath, migrateLegacy) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const exists = name => Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const matchRows = (dataset, id) => db.prepare(`SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
    FROM match_snapshots WHERE dataset=? AND source_match_id=?`).all(dataset, id);
  return {
    available: () => exists("match_snapshots") && exists("schema_meta"),
    receipt: () => readFastResultReceiptState(db), authority: () => loadAuthorityHighWater(db),
    migrateLegacy: () => migrateLegacy(db),
    begin: () => db.exec("BEGIN IMMEDIATE"), commit: () => db.exec("COMMIT"), rollback: () => db.exec("ROLLBACK"),
    history: id => matchRows("history", id), current: id => matchRows("current", id),
    rowById: id => db.prepare("SELECT id, dataset, payload FROM match_snapshots WHERE id=?").get(id),
    predictions: id => !id || !exists("prediction_snapshots") ? [] : db.prepare(`SELECT payload FROM prediction_snapshots
      WHERE source_match_id=? ORDER BY captured_at ASC,id ASC`).all(id).map(row => {
      try { return JSON.parse(row.payload); } catch { return null; }
    }).filter(row => row && typeof row === "object"),
    insertHistory: (...values) => db.prepare(`INSERT INTO match_snapshots
      (id,dataset,match_id,source_match_id,kickoff_time,status,payload) VALUES(?,'history',?,?,?,'FINISHED',?)`).run(...values),
    updateHistory: (...values) => db.prepare(`UPDATE match_snapshots SET match_id=?,source_match_id=?,kickoff_time=?,status='FINISHED',payload=?
      WHERE id=? AND dataset='history'`).run(...values),
    deleteCurrent: id => db.prepare("DELETE FROM match_snapshots WHERE id=? AND dataset='current'").run(id),
    upsertMeta: (key, value, at) => db.prepare(`INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), at),
    persistAuthority: (merged, at) => persistAuthorityHighWater(db, merged, at),
    close: () => db.close(),
  };
}
module.exports = { createSqliteFastResultRepository };
