const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const storeDir = process.env.DATA_STORE_DIR || process.env.FOOTBALL_STORE_DIR || "/var/lib/football-predict";
const dbDir = path.join(storeDir, "db");
const retentionDays = Math.max(1, Number(process.env.DATASTORE_COMPACT_RETENTION_DAYS || 14));
const maxRows = Math.max(1000, Number(process.env.DATASTORE_COMPACT_MAX_ROWS || 200000));
const dryRun = process.env.DRY_RUN === "1";

const tables = [
  "sync-runs",
  "match-snapshots",
  "odds-snapshots",
  "prediction-runs"
];

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

const rowTime = (row) => {
  for (const key of ["at", "capturedAt", "oddsCapturedAt", "oddsUpdatedAt", "kickoffTime", "businessDate"]) {
    const time = Date.parse(row?.[key] || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const compactTable = async (table) => {
  const filePath = path.join(dbDir, `${table}.jsonl`);
  if (!fs.existsSync(filePath)) return { table, exists: false };

  const stat = await fsp.stat(filePath);
  const kept = [];
  let scanned = 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line) continue;
    scanned += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const time = rowTime(row);
    if (Number.isFinite(time) && time < cutoff) continue;
    kept.push(JSON.stringify(row));
    if (kept.length > maxRows) kept.shift();
  }

  const nextBytes = Buffer.byteLength(`${kept.join("\n")}${kept.length ? "\n" : ""}`);
  if (!dryRun) {
    const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fsp.rename(filePath, backupPath);
    await fsp.writeFile(filePath, `${kept.join("\n")}${kept.length ? "\n" : ""}`);
    await fsp.rm(backupPath, { force: true });
  }

  return {
    table,
    exists: true,
    dryRun,
    beforeBytes: stat.size,
    afterBytes: nextBytes,
    scanned,
    kept: kept.length,
    retentionDays,
    maxRows
  };
};

(async () => {
  const results = [];
  await fsp.mkdir(dbDir, { recursive: true });
  for (const table of tables) {
    results.push(await compactTable(table));
  }
  console.log(JSON.stringify({ ok: true, storeDir, dbDir, results }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
