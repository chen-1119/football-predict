"use strict";
const path = require("node:path");
const { readStorageMode } = require("../server/storageMode.cjs");
const { loadOddsHistory, currentMatchBoundaries, canonicalBackfillRows, mergeOddsHistoryBackfill } = require("./oddsHistoryStore.cjs");
const { readPublicationJson } = require("../server/dataGenerationBundle.cjs");

async function loadPostgresOddsHistory(publicDir, options = {}) {
  const session = await require("./postgresRuntimeReadSession.cjs").openPostgresRuntimeReadSession({
    ...options, publicDataDir: options.publicDataDir || path.join(publicDir, "data"),
  });
  try {
    const matches = readPublicationJson(session.publication, "matches-current.json", null);
    if (!Array.isArray(matches)) throw new Error("native odds history requires verified current matches");
    const boundaries = currentMatchBoundaries(publicDir, matches);
    // Keep the canonical file's retention policy, but never probe the retired
    // database even when an old file remains available for disaster recovery.
    const selected = loadOddsHistory(publicDir, { sqliteBackfill: false });
    if (!boundaries.size) return selected;
    await session.client.query(`DECLARE native_odds_backfill NO SCROLL CURSOR FOR
      SELECT source_match_id,pool,captured_at,payload::text AS payload
      FROM football.odds_snapshots WHERE source_match_id=ANY($1::text[])
      ORDER BY captured_at ASC,id ASC LIMIT 120001`, [[...boundaries.keys()]]);
    const records = [];
    while (true) {
      const result = await session.client.query("FETCH FORWARD 128 FROM native_odds_backfill");
      if (!result.rows.length) break;
      records.push(...result.rows);
      if (records.length > 120000) throw new Error("native odds history exceeds audited backfill bound");
    }
    return mergeOddsHistoryBackfill(selected, canonicalBackfillRows(records, boundaries));
  } finally { await session.close(); }
}

async function loadRuntimeOddsHistory(publicDir, options = {}) {
  return readStorageMode().postgresOnly ? loadPostgresOddsHistory(publicDir, options) : loadOddsHistory(publicDir, options);
}
module.exports = { loadRuntimeOddsHistory, loadPostgresOddsHistory };
