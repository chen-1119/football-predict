const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
  "prediction-runs",
];

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

const rowTime = (row) => {
  for (const key of ["at", "capturedAt", "oddsCapturedAt", "oddsUpdatedAt", "kickoffTime", "businessDate"]) {
    const time = Date.parse(row?.[key] || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const sameFile = (left, right) => Boolean(left && right)
  && String(left.dev) === String(right.dev)
  && String(left.ino) === String(right.ino)
  && Number(left.size) === Number(right.size)
  && Number(left.mtimeMs) === Number(right.mtimeMs);

const scanRows = async (filePath, stat, onEligible = null) => {
  if (!stat.size) return { scanned: 0, eligible: 0, malformed: 0 };
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: 0,
    end: stat.size - 1,
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;
  let eligible = 0;
  let malformed = 0;
  for await (const line of lines) {
    if (!line) continue;
    scanned += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const time = rowTime(row);
    if (Number.isFinite(time) && time < cutoff) continue;
    eligible += 1;
    if (onEligible) await onEligible(row, eligible);
  }
  return { scanned, eligible, malformed };
};

const compactTable = async (table) => {
  const filePath = path.join(dbDir, `${table}.jsonl`);
  let before = null;
  try {
    before = await fsp.stat(filePath);
  } catch {
    return { table, exists: false };
  }
  if (!before.isFile()) return { table, exists: true, skipped: true, reason: "not-regular-file" };

  const firstPass = await scanRows(filePath, before);
  const skipEligible = Math.max(0, firstPass.eligible - maxRows);
  const alreadyCompliant = firstPass.malformed === 0
    && firstPass.eligible === firstPass.scanned
    && skipEligible === 0;
  if (alreadyCompliant) {
    return {
      table,
      exists: true,
      dryRun,
      mode: "two-pass-streaming-noop",
      unchanged: true,
      beforeBytes: before.size,
      afterBytes: before.size,
      scanned: firstPass.scanned,
      eligible: firstPass.eligible,
      malformed: 0,
      skippedByRetentionOrLimit: 0,
      kept: firstPass.eligible,
      retentionDays,
      maxRows,
    };
  }
  const tempPath = path.join(dbDir, `.${table}.compact-${process.pid}-${crypto.randomUUID()}.tmp`);
  const backupPath = path.join(dbDir, `.${table}.compact-${process.pid}-${crypto.randomUUID()}.bak`);
  let handle = null;
  let pending = "";
  let nextBytes = 0;
  let kept = 0;

  const flush = async () => {
    if (!handle || !pending) return;
    await handle.write(pending);
    pending = "";
  };

  try {
    if (!dryRun) handle = await fsp.open(tempPath, "wx", before.mode & 0o777);
    await scanRows(filePath, before, async (row, eligibleIndex) => {
      if (eligibleIndex <= skipEligible) return;
      const line = `${JSON.stringify(row)}\n`;
      nextBytes += Buffer.byteLength(line);
      kept += 1;
      if (!handle) return;
      pending += line;
      if (Buffer.byteLength(pending) >= 1024 * 1024) await flush();
    });
    await flush();
    if (handle) {
      await handle.sync();
      await handle.close();
      handle = null;
    }

    if (!dryRun) {
      const afterScan = await fsp.stat(filePath).catch(() => null);
      if (!sameFile(before, afterScan)) {
        await fsp.rm(tempPath, { force: true });
        return {
          table,
          exists: true,
          skipped: true,
          reason: "source-changed-during-streaming-compaction",
          beforeBytes: before.size,
          scanned: firstPass.scanned,
          eligible: firstPass.eligible,
          malformed: firstPass.malformed,
        };
      }
      await fsp.rename(filePath, backupPath);
      try {
        await fsp.rename(tempPath, filePath);
        await fsp.rm(backupPath, { force: true });
      } catch (error) {
        await fsp.rename(backupPath, filePath).catch(() => {});
        throw error;
      }
    }

    return {
      table,
      exists: true,
      dryRun,
      mode: "two-pass-streaming-atomic-swap",
      beforeBytes: before.size,
      afterBytes: nextBytes,
      scanned: firstPass.scanned,
      eligible: firstPass.eligible,
      malformed: firstPass.malformed,
      skippedByRetentionOrLimit: Math.max(0, firstPass.scanned - kept - firstPass.malformed),
      kept,
      retentionDays,
      maxRows,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
};

(async () => {
  const results = [];
  await fsp.mkdir(dbDir, { recursive: true });
  for (const table of tables) results.push(await compactTable(table));
  console.log(JSON.stringify({ ok: true, storeDir, dbDir, results }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
