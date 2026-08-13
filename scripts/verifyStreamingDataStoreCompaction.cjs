const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-compact-"));
const dbDir = path.join(tempDir, "db");
fs.mkdirSync(dbDir, { recursive: true });

try {
  const now = Date.now();
  const oldAt = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const freshAt = new Date(now - 60 * 60 * 1000).toISOString();
  const rows = [
    ...Array.from({ length: 200 }, (_, index) => ({ id: `old-${index}`, at: oldAt })),
    ...Array.from({ length: 1300 }, (_, index) => ({ id: `fresh-${index}`, at: freshAt, payload: "x".repeat(64) })),
  ];
  const target = path.join(dbDir, "odds-snapshots.jsonl");
  fs.writeFileSync(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "compactDataStore.cjs")], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_STORE_DIR: tempDir,
      DATASTORE_COMPACT_RETENTION_DAYS: "14",
      DATASTORE_COMPACT_MAX_ROWS: "1000",
      DRY_RUN: "0",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const compacted = payload.results.find((entry) => entry.table === "odds-snapshots");
  assert.equal(compacted.mode, "two-pass-streaming-atomic-swap");
  assert.equal(compacted.scanned, 1500);
  assert.equal(compacted.kept, 1000);

  const kept = fs.readFileSync(target, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0].id, "fresh-300");
  assert.equal(kept.at(-1).id, "fresh-1299");
  assert.equal(fs.readdirSync(dbDir).some((name) => name.includes(".compact-") && /\.(tmp|bak)$/.test(name)), false);

  const inodeBeforeNoop = fs.statSync(target).ino;
  const second = spawnSync(process.execPath, [path.join(rootDir, "scripts", "compactDataStore.cjs")], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_STORE_DIR: tempDir,
      DATASTORE_COMPACT_RETENTION_DAYS: "14",
      DATASTORE_COMPACT_MAX_ROWS: "1000",
      DRY_RUN: "0",
    },
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondPayload = JSON.parse(second.stdout);
  const noOp = secondPayload.results.find((entry) => entry.table === "odds-snapshots");
  assert.equal(noOp.mode, "two-pass-streaming-noop");
  assert.equal(noOp.unchanged, true);
  assert.equal(fs.statSync(target).ino, inodeBeforeNoop, "a no-op compaction must preserve the JSONL cursor inode");

  console.log(JSON.stringify({ ok: true, checks: 12, compacted, noOp }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
