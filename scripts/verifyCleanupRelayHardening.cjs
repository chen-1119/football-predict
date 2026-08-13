const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const cleanupService = fs.readFileSync(path.join(rootDir, "deploy", "light-server", "football-cleanup.service"), "utf8");
const cleanupScriptPath = path.join(rootDir, "scripts", "cleanupServerArtifacts.cjs");
const cleanupScript = fs.readFileSync(cleanupScriptPath, "utf8");
const relayPromoter = fs.readFileSync(path.join(rootDir, "deploy", "light-server", "football-relay-promote"), "utf8");

const checks = [];
const push = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });

push("cleanup unit runs unprivileged", cleanupService.includes("User=football")
  && cleanupService.includes("Group=football")
  && /^CapabilityBoundingSet=\s*$/m.test(cleanupService));
push("cleanup unit only writes the state directory", cleanupService.includes("ProtectSystem=strict")
  && cleanupService.includes("ReadWritePaths=/var/lib/football-predict")
  && !cleanupService.includes("ReadWritePaths=/opt/football-predict"));
push("root-owned cleanup classes are disabled", cleanupService.includes("SERVER_CLEANUP_APP_BACKUPS=0")
  && cleanupService.includes("SERVER_CLEANUP_APP_ARTIFACTS=0")
  && cleanupService.includes("SERVER_CLEANUP_TMP_ARTIFACTS=0")
  && cleanupService.includes("SERVER_CLEANUP_SYSTEM_LOGS=0"));
push("cleanup uses atomic inode-checked staging", cleanupScript.includes("fs.renameSync(sourcePath, stagedPath)")
  && cleanupScript.includes("sameIdentity(staged, item.identity)")
  && cleanupScript.includes("cleanup apply is restricted to the state directory")
  && cleanupScript.includes("fs.linkSync(tmpTarget, resolvedTarget)"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-hardening-"));
try {
  const storeDir = path.join(tmpRoot, "store");
  fs.mkdirSync(storeDir, { recursive: true });
  const newest = path.join(storeDir, "football.db.backup-new");
  const compressible = path.join(storeDir, "football.db.backup-old");
  fs.writeFileSync(newest, "newest");
  fs.writeFileSync(compressible, "compress-me");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(compressible, twoDaysAgo, twoDaysAgo);
  const cleanupRun = spawnSync(process.execPath, [cleanupScriptPath], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      SERVER_STORE_DIR: storeDir,
      SERVER_CLEANUP_STORE_DIR: storeDir,
      SERVER_CLEANUP_APPLY: "1",
      SERVER_CLEANUP_SQLITE_BACKUP_KEEP: "1",
      SERVER_CLEANUP_SQLITE_BACKUP_RETENTION_DAYS: "10",
      SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS: "1",
      SERVER_CLEANUP_APP_BACKUPS: "0",
      SERVER_CLEANUP_APP_ARTIFACTS: "0",
      SERVER_CLEANUP_TMP_ARTIFACTS: "0",
      SERVER_CLEANUP_SYSTEM_LOGS: "0"
    }
  });
  let cleanupPayload = null;
  try {
    cleanupPayload = JSON.parse(cleanupRun.stdout);
  } catch {
    // Report the process output below.
  }
  push("state-directory cleanup still functions", cleanupRun.status === 0
    && cleanupPayload?.ok === true
    && fs.existsSync(`${compressible}.gz`)
    && !fs.existsSync(compressible)
    && fs.existsSync(newest), {
      status: cleanupRun.status,
      stderr: cleanupRun.stderr.trim(),
      summary: cleanupPayload?.summary || null
    });

  const heredocMatch = relayPromoter.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/);
  push("relay validator heredoc is discoverable", Boolean(heredocMatch));
  if (heredocMatch) {
    const validator = heredocMatch[1];
    const makeRows = (count, offset) => Array.from({ length: count }, (_, index) => ({ matchId: offset + index }));
    const makeSnapshot = (capturedAt) => ({
      version: 1,
      source: "sporttery-relay-snapshot",
      capturedAt,
      summary: { endpoints: 2, usableEndpoints: 2, rows: 100 },
      endpoints: [
        { id: "current", method: "current", ok: true, rows: 50, payload: { value: { matchInfoList: [{ subMatchList: makeRows(50, 1) }] } } },
        { id: "calculator", method: "calculator", ok: true, rows: 50, payload: { value: { matchInfoList: [{ subMatchList: makeRows(50, 1001) }] } } }
      ]
    });
    const incomingPath = path.join(tmpRoot, "incoming.json");
    const currentPath = path.join(tmpRoot, "current.json");
    const runValidator = (incoming, current = null) => {
      fs.writeFileSync(incomingPath, JSON.stringify(incoming));
      if (current) fs.writeFileSync(currentPath, JSON.stringify(current));
      else fs.rmSync(currentPath, { force: true });
      return spawnSync(process.execPath, ["-", incomingPath, currentPath], {
        input: validator,
        encoding: "utf8"
      });
    };

    const now = Date.now();
    const valid = makeSnapshot(new Date(now - 30_000).toISOString());
    const validRun = runValidator(valid);
    push("relay accepts a structurally honest fresh snapshot", validRun.status === 0, {
      stderr: validRun.stderr.trim()
    });

    const dishonest = structuredClone(valid);
    dishonest.summary.rows = 101;
    const dishonestRun = runValidator(dishonest);
    push("relay rejects forged summary counts", dishonestRun.status !== 0
      && dishonestRun.stderr.includes("summary.rows does not match"), {
      status: dishonestRun.status,
      stderr: dishonestRun.stderr.trim()
    });

    const dishonestUsable = structuredClone(valid);
    dishonestUsable.summary.usableEndpoints = 3;
    const dishonestUsableRun = runValidator(dishonestUsable);
    push("relay rejects forged usable endpoint counts", dishonestUsableRun.status !== 0
      && dishonestUsableRun.stderr.includes("summary.usableEndpoints does not match"), {
      status: dishonestUsableRun.status,
      stderr: dishonestUsableRun.stderr.trim()
    });

    const current = makeSnapshot(new Date(now - 10_000).toISOString());
    const rollbackRun = runValidator(valid, current);
    push("relay rejects capturedAt rollback", rollbackRun.status !== 0
      && rollbackRun.stderr.includes("strictly newer"), {
      status: rollbackRun.status,
      stderr: rollbackRun.stderr.trim()
    });

    const newer = makeSnapshot(new Date(now).toISOString());
    const newerRun = runValidator(newer, current);
    push("relay accepts a strictly newer snapshot", newerRun.status === 0, {
      stderr: newerRun.stderr.trim()
    });
  }

  push("relay wrapper serializes promotions", relayPromoter.includes("flock -x 9")
    && relayPromoter.includes("football-relay-promote.lock"));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  checks
}, null, 2));
if (!ok) process.exitCode = 1;
