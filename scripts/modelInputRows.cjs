"use strict";

const payloadRowKey = (row, label) => label === "predictionSnapshots"
  ? [row?.sourceMatchId || row?.matchId || "", row?.phase || "", row?.signature || "",
    row?.featureSnapshotHash || row?.featureSnapshot?.hash || "legacy", row?.capturedAt || row?.firstSeenAt || ""].join("|")
  : [row?.sourceMatchId || row?.matchId || "", row?.poolCode || row?.oddsPoolCode || "HAD",
    row?.handicapLine ?? 0, row?.stateSignature || row?.captureBucket || row?.capturedAt || ""].join("|");

const createModelInputCollector = (table, options = {}) => {
  if (!["prediction_snapshots", "odds_snapshots"].includes(table)) throw new Error("model input table rejected");
  const label = table === "prediction_snapshots" ? "predictionSnapshots" : "oddsHistory";
  const maxRowsPerMatch = Math.max(0, Number(options.maxRowsPerMatch || 0));
  const rowsByKey = new Map(), retainedKeysByMatch = new Map();
  const audit = { selectedRows: 0, parsedRows: 0, invalidRows: 0, duplicateRows: 0, filteredRows: 0, compactedRows: 0,
    peakHeapUsed: options.observeMemory === true ? process.memoryUsage().heapUsed : null };
  return {
    add(row) {
      audit.selectedRows += 1;
      let payload;
      try { payload = JSON.parse(row.payload); } catch { /* invalid payload counted below */ }
      if (!payload || typeof payload !== "object") { audit.invalidRows += 1; return; }
      audit.parsedRows += 1;
      if (typeof options.acceptPayload === "function" && options.acceptPayload(payload) !== true) {
        audit.filteredRows += 1; return;
      }
      const key = payloadRowKey(payload, label);
      if (rowsByKey.has(key)) {
        audit.duplicateRows += 1;
        if (options.preferLatestRows === true) return;
      }
      if (maxRowsPerMatch > 0) {
        const matchKey = String(payload.sourceMatchId || payload.matchId || "").trim();
        if (matchKey && !rowsByKey.has(key)) {
          const retainedKeys = retainedKeysByMatch.get(matchKey) || [];
          if (retainedKeys.length >= maxRowsPerMatch) {
            audit.compactedRows += 1;
            if (options.preferLatestRows === true) return;
            const evictedKey = retainedKeys.shift();
            if (evictedKey) rowsByKey.delete(evictedKey);
          }
          retainedKeys.push(key);
          retainedKeysByMatch.set(matchKey, retainedKeys);
        }
      }
      rowsByKey.set(key, payload);
      if (options.observeMemory === true && audit.selectedRows % 128 === 0) {
        audit.peakHeapUsed = Math.max(audit.peakHeapUsed, process.memoryUsage().heapUsed);
      }
    },
    finish() {
      if (options.observeMemory === true) audit.peakHeapUsed = Math.max(audit.peakHeapUsed, process.memoryUsage().heapUsed);
      const rows = Array.from(rowsByKey.values());
      if (options.preferLatestRows === true) rows.sort((a, b) => Date.parse(a?.capturedAt || a?.firstSeenAt || "")
        - Date.parse(b?.capturedAt || b?.firstSeenAt || ""));
      return { ok: true, rows, limit: options.limit, ...audit, uniqueRows: rows.length };
    },
  };
};

module.exports = { payloadRowKey, createModelInputCollector };
