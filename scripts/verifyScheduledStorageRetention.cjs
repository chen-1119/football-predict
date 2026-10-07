"use strict";

// Exercise the real cold-recovery and cleanup entrypoints in owned fixtures.
// No production path, PostgreSQL, network, installer or systemd is executed.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createFixture, runRecovery, mapped, write, readTreeId, sha256 } = require("./verifyReleaseRecovery.cjs");

const ROOT = path.resolve(__dirname, "..");
const source = relative => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const RECOVERY = "deploy/light-server/football-release-recovery.cjs";
const SHELL = "deploy/light-server/release-from-bundle.sh";
const CLEANUP = "scripts/cleanupServerArtifacts.cjs";
const MONITOR = "scripts/checkServerRuntime.cjs";
const RETENTION_PATHS = [
  "/etc/systemd/system/football-postgres-backup.service",
  "/etc/systemd/system/football-postgres-backup.timer",
  "/usr/local/sbin/football-postgres-backup-v2",
  "/etc/systemd/journald.conf.d/football-retention.conf"
];
const EXTRA_TIMERS = [
  ["football-daily-prematch.timer", true, true],
  ["football-featured-combo.timer", false, false],
  ["football-postgres-backup.timer", true, true]
];
const EXTRA_UNITS = [
  ["football-market-collector.service", true, true],
  ["football-featured-combo.service", false, false],
  ["football-recommendation-settlement.service", false, false]
];
const PINNED_FILES = [RECOVERY, SHELL, CLEANUP, MONITOR,
  "deploy/light-server/football-cleanup.service", "deploy/light-server/football-cleanup.timer",
  "deploy/light-server/football-monitor.service", "deploy/light-server/football-monitor.timer",
  "deploy/light-server/football-postgres-backup.service", "deploy/light-server/football-postgres-backup.timer",
  "deploy/light-server/football-journald-retention.conf", "scripts/runReleaseWindowPreflight.cjs"];
const pins = () => Object.fromEntries(PINNED_FILES.map(file => [file, crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));

function removeOwnedFixture(root, prefix) {
  const target = path.resolve(root), parent = path.resolve(os.tmpdir());
  const relative = path.relative(parent, target);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert(path.basename(target).startsWith(prefix));
  assert(fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink());
  fs.rmSync(target, { recursive: true, force: true });
  assert(!fs.existsSync(target));
}

function extendedFixture(phase, { config = 16, timers = 5, health = true } = {}) {
  const fixture = createFixture(phase, { legacyManagedConfig: config === 11, health });
  assert([11, 12, 16].includes(config));
  assert([2, 4, 5].includes(timers));
  const dir = path.join(fixture.current, "managed-config");
  fixture.retentionFiles = [];
  for (const [index, target] of RETENTION_PATHS.entries()) {
    const oldBytes = Buffer.from(`retention prior configuration ${index}\n`);
    const newBytes = Buffer.from(`retention current configuration ${index}\n`);
    const actual = mapped(fixture.root, target);
    write(actual, newBytes, 0o644);
    fixture.retentionFiles.push({ target: actual, oldBytes, newBytes });
    if (config === 16) {
      write(path.join(dir, "entries", String(13 + index)), oldBytes);
      fs.appendFileSync(path.join(dir, "manifest.tsv"),
        `${13 + index}\tfile\t${target}\t${oldBytes.length}\t${sha256(oldBytes)}\n`);
    }
  }
  fixture.legacyBackupScript = mapped(fixture.root, "/usr/local/sbin/football-postgres-backup");
  fixture.legacyBackupBytes = Buffer.from("#!/usr/bin/env bash\nprintf 'legacy backup fixture\\n'\n");
  write(fixture.legacyBackupScript, fixture.legacyBackupBytes, 0o755);
  fixture.legacyBackupMode = fs.statSync(fixture.legacyBackupScript).mode;
  const selectedTimers = EXTRA_TIMERS.slice(0, timers - 2);
  if (timers > 2) {
    fs.appendFileSync(path.join(dir, "timers.tsv"), selectedTimers.map(([name, enabled, active]) =>
      `${name}\t${Number(enabled)}\t${Number(active)}\n`).join(""));
    fs.appendFileSync(path.join(dir, "units.tsv"), EXTRA_UNITS.map(([name, enabled, active]) =>
      `${name}\t${Number(enabled)}\t${Number(active)}\n`).join(""));
  }
  const statePath = mapped(fixture.root, "/mock-systemd.json");
  const state = JSON.parse(fs.readFileSync(statePath));
  for (const [name, enabled, active] of [...selectedTimers, ...EXTRA_UNITS]) {
    state.units[name] = { exists: true, enabled, active };
  }
  state.units["football-postgres-backup.service"] = { exists: true, enabled: false, active: true };
  state.units["football-daily-prematch.service"] = { exists: true, enabled: false, active: true };
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  fixture.statePath = statePath;
  fixture.timerStates = [
    ["football-cleanup.timer", true, true], ["football-monitor.timer", false, false], ...selectedTimers
  ];
  return fixture;
}

function withFixture(phase, options, run) {
  const fixture = extendedFixture(phase, options);
  try {
    run(fixture);
    assert.deepEqual(fs.readFileSync(fixture.legacyBackupScript), fixture.legacyBackupBytes,
      "legacy backup script must stay outside the new managed path set");
    assert.equal(fs.statSync(fixture.legacyBackupScript).mode, fixture.legacyBackupMode,
      "legacy backup script executable mode must remain unchanged");
  } finally { removeOwnedFixture(fixture.root, "football-release-recovery-"); }
}

function restoredTimers(fixture) {
  const state = JSON.parse(fs.readFileSync(fixture.statePath));
  for (const [name, enabled, active] of fixture.timerStates) {
    assert.equal(state.units[name].enabled, enabled, `${name}: enabled`);
    assert.equal(state.units[name].active, active, `${name}: active`);
  }
  return state;
}

function verifyScheduledStorageRetention() {
  const before = pins(), results = [];
  const check = (name, test) => { test(); results.push({ name, passed: true }); };
  check("new 16 paths and 5 timers are bound by the signed shell and actual recovery", () => {
    const recovery = source(RECOVERY), shell = source(SHELL);
    const constants = recovery.slice(recovery.indexOf("const PRE_RETENTION_MANAGED_CONFIG_PATHS ="),
      recovery.indexOf("const MODEL_ARTIFACTS ="));
    const actual = vm.runInNewContext(`${constants}\n({ MANAGED_CONFIG_PATHS, RETENTION_TIMER_UNITS })`,
      { STORE_PATH: "/var/lib/football-predict" }, { timeout: 1000 });
    const shellPaths = shell.match(/MANAGED_CONFIG_PATHS=\(([\s\S]*?)\n\)/)[1].trim().split(/\s+/);
    const shellTimers = shell.match(/MANAGED_TIMERS=\(([^)]+)\)/)[1].trim().split(/\s+/);
    assert.equal(actual.MANAGED_CONFIG_PATHS.length, 16);
    assert.equal(actual.RETENTION_TIMER_UNITS.length, 5);
    assert.deepEqual(shellPaths, Array.from(actual.MANAGED_CONFIG_PATHS));
    assert.deepEqual(shellTimers, Array.from(actual.RETENTION_TIMER_UNITS));
    assert.deepEqual(shellPaths.slice(-4), RETENTION_PATHS);
  });
  for (const phase of ["candidate-validated", "swap-complete"]) {
    check(`actual cold ${phase} rollback restores all four retention files and five timers`, () => {
      withFixture(phase, {}, fixture => {
        const result = runRecovery(fixture);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).action, "rollback");
        assert.equal(readTreeId(fixture.app), "old");
        for (const file of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(file.target), file.oldBytes);
        const state = restoredTimers(fixture);
        assert.equal(state.units["football-postgres-backup.service"].active, false,
          "oneshot backup is stopped and must not be restored as an active job");
        assert(!fs.existsSync(fixture.current));
        const again = runRecovery(fixture);
        assert.equal(again.status, 0, again.stderr);
        assert.equal(JSON.parse(again.stdout).action, "noop");
      });
    });
  }
  check("committed forward recovery preserves installed retention bytes and restores five timer states", () => {
    withFixture("committed", {}, fixture => {
      const result = runRecovery(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).action, "commit");
      assert.equal(readTreeId(fixture.app), "new");
      for (const file of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(file.target), file.newBytes);
      restoredTimers(fixture);
      assert(!fs.existsSync(fixture.current));
    });
  });
  for (const config of [11, 12]) for (const timers of [2, 4]) {
    check(`legacy ${config} paths/${timers} timers rollback preserves unmanaged retention files`, () => {
      withFixture("candidate-validated", { config, timers }, fixture => {
        const result = runRecovery(fixture);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).action, "rollback");
        for (const file of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(file.target), file.newBytes);
        restoredTimers(fixture);
      });
    });
  }
  for (const [config, timers] of [[16, 2], [16, 4], [11, 5], [12, 5]]) {
    check(`mixed ${config} paths/${timers} timers contract fails before mutation`, () => {
      withFixture("candidate-validated", { config, timers }, fixture => {
        const beforeState = fs.readFileSync(fixture.statePath);
        const result = runRecovery(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /retention config.*timer|retention.*manifest|timer.*retention/);
        assert.deepEqual(fs.readFileSync(fixture.statePath), beforeState);
        for (const file of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(file.target), file.newBytes);
        assert(fs.existsSync(fixture.current));
      });
    });
  }
  check("new 16 paths/5 timers contract rejects legacy three-unit state before mutation", () => {
    withFixture("candidate-validated", {}, fixture => {
      const file = path.join(fixture.current, "managed-config", "units.tsv");
      write(file, fs.readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n") + "\n");
      const beforeState = fs.readFileSync(fixture.statePath), result = runRecovery(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /runtime unit state manifest length mismatch/);
      assert.deepEqual(fs.readFileSync(fixture.statePath), beforeState);
      for (const item of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(item.target), item.newBytes);
    });
  });
  for (const mutation of ["unknown-path", "reordered-path", "hash-mismatch", "unknown-timer",
    "reordered-timer", "invalid-timer-state", "unknown-sixth-timer"]) {
    check(`${mutation} fails before any system state or installed config changes`, () => {
      withFixture("candidate-validated", {}, fixture => {
        const dir = path.join(fixture.current, "managed-config");
        const manifest = path.join(dir, "manifest.tsv"), timerFile = path.join(dir, "timers.tsv");
        if (mutation === "unknown-path") write(manifest, fs.readFileSync(manifest, "utf8")
          .replace(RETENTION_PATHS[3], "/etc/systemd/journald.conf.d/unknown.conf"));
        else if (mutation === "reordered-path") {
          const rows = fs.readFileSync(manifest, "utf8").trimEnd().split("\n");
          [rows[14], rows[15]] = [rows[15], rows[14]];
          write(manifest, `${rows.join("\n")}\n`);
        } else if (mutation === "hash-mismatch") write(path.join(dir, "entries", "16"), "tampered\n");
        else if (mutation === "unknown-timer") write(timerFile, fs.readFileSync(timerFile, "utf8")
          .replace("football-postgres-backup.timer", "football-unknown.timer"));
        else if (mutation === "reordered-timer") {
          const rows = fs.readFileSync(timerFile, "utf8").trimEnd().split("\n");
          [rows[3], rows[4]] = [rows[4], rows[3]];
          write(timerFile, `${rows.join("\n")}\n`);
        } else if (mutation === "invalid-timer-state") write(timerFile, fs.readFileSync(timerFile, "utf8")
          .replace("football-postgres-backup.timer\t1\t1", "football-postgres-backup.timer\t1\t2"));
        else fs.appendFileSync(timerFile, "football-unknown.timer\t0\t0\n");
        const beforeState = fs.readFileSync(fixture.statePath);
        const result = runRecovery(fixture);
        assert.notEqual(result.status, 0, mutation);
        assert.match(result.stderr, /managed config|timer state/);
        assert.deepEqual(fs.readFileSync(fixture.statePath), beforeState);
        for (const file of fixture.retentionFiles) assert.deepEqual(fs.readFileSync(file.target), file.newBytes);
        assert(fs.existsSync(fixture.current));
      });
    });
  }
  check("failed health retains the journal and keeps the new backup timer and service stopped", () => {
    withFixture("swap-complete", { health: false }, fixture => {
      const result = runRecovery(fixture);
      assert.notEqual(result.status, 0);
      assert(fs.existsSync(fixture.current));
      const state = JSON.parse(fs.readFileSync(fixture.statePath));
      for (const [name] of fixture.timerStates) assert.equal(state.units[name].active, false);
      assert.equal(state.units["football-postgres-backup.service"].active, false);
    });
  });
  check("actual cleanup removes only 14-day rotated logs and publishes the latest bounded receipt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-storage-retention-"));
    try {
      const store = path.join(root, "store"), logs = path.join(store, "logs");
      fs.mkdirSync(logs, { recursive: true });
      const names = ["worker.log.1", "worker.log.2", "worker.log", "private.json"];
      const days = [15, 13, 40, 40];
      names.forEach((name, index) => {
        write(path.join(logs, name), `retained fixture ${name}\n`);
        const old = new Date(Date.now() - days[index] * 86400000);
        fs.utimesSync(path.join(logs, name), old, old);
      });
      write(path.join(store, "cleanup-status.json"), '{"old":true}\n', 0o640);
      const env = { ...process.env, SERVER_CLEANUP_APP_DIR: path.join(root, "app"),
        SERVER_CLEANUP_STORE_DIR: store, SERVER_STORE_DIR: store, SERVER_CLEANUP_TMP_DIR: path.join(root, "tmp"),
        SERVER_CLEANUP_APPLY: "1", SERVER_CLEANUP_LOG_RETENTION_DAYS: "14", SERVER_CLEANUP_APP_BACKUPS: "0",
        SERVER_CLEANUP_APP_ARTIFACTS: "0", SERVER_CLEANUP_TMP_ARTIFACTS: "0", SERVER_CLEANUP_SYSTEM_LOGS: "0" };
      const run = () => spawnSync(process.execPath, [path.join(ROOT, CLEANUP)], {
        cwd: ROOT, env, encoding: "utf8", timeout: 15000, maxBuffer: 262144, windowsHide: true
      });
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.policy.logRetentionDays, 14);
      assert.equal(payload.summary.failed, 0);
      assert.equal(payload.summary.removed, 1);
      assert.deepEqual(payload.removed, [path.join(logs, names[0])]);
      assert(!fs.existsSync(path.join(logs, names[0])));
      for (const name of names.slice(1)) assert(fs.existsSync(path.join(logs, name)));
      const receipt = path.join(store, "cleanup-status.json");
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt)), payload);
      assert(fs.lstatSync(receipt).isFile() && !fs.lstatSync(receipt).isSymbolicLink());
      assert(fs.statSync(receipt).size < 65536);
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).summary.removed, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt)), JSON.parse(second.stdout));
    } finally { removeOwnedFixture(root, "football-storage-retention-"); }
  });
  check("the actual disk check observes 80% as watch and preserves the 95% failure threshold", () => {
    const monitor = source(MONITOR);
    const thresholdStart = monitor.indexOf("const diskWarnPercent =");
    const thresholdEnd = monitor.indexOf("const sqliteWarnBytes =", thresholdStart);
    assert(thresholdStart >= 0 && thresholdEnd > thresholdStart);
    const thresholds = vm.runInNewContext(`${monitor.slice(thresholdStart, thresholdEnd)}\n({ diskWarnPercent, diskFailPercent })`,
      { process: { env: {} } }, { timeout: 1000 });
    assert.equal(thresholds.diskWarnPercent, 80); assert.equal(thresholds.diskFailPercent, 95);
    const start = monitor.indexOf("const checkDiskUsage = () => {");
    const end = monitor.indexOf("\nconst checkCleanupDryRun =", start);
    assert(start >= 0 && end > start);
    for (const [percent, expected] of [[79, "ok"], [80, "watch"], [94, "watch"], [95, "failed"], [100, "failed"]]) {
      const checks = [];
      const actual = vm.runInNewContext(`${monitor.slice(start, end)}\ncheckDiskUsage`, {
        checkDisk: true, diskPaths: ["/fixture"], commandTimeoutMs: 1000, diskWarnPercent: 80, diskFailPercent: 95,
        runCommand: (command, args) => { assert.equal(command, "df"); assert.deepEqual(Array.from(args), ["-Pk", "/fixture"]);
          return { status: 0, stdout: "synthetic-df" }; },
        parseDf: text => { assert.equal(text, "synthetic-df"); return [{ usePercent: percent }]; },
        addCheck: (name, status, details) => checks.push({ name, status, details })
      }, { timeout: 1000 });
      actual();
      assert.equal(checks.length, 1); assert.equal(checks[0].status, expected);
      assert.equal(checks[0].details.warnPercent, 80); assert.equal(checks[0].details.failPercent, 95);
    }
  });
  check("actual monitor CLI rejects invalid threshold configuration before writing or making requests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-storage-retention-"));
    try {
      const store = path.join(root, "store");
      fs.mkdirSync(store);
      const invalid = [
        ["bad", "95"], ["Infinity", "95"], ["101", "95"], ["", "95"], ["96", "95"],
        ["80.5", "95"], ["0", "95"], ["80", "NaN"], ["80", "Infinity"], ["80", "101"],
        ["80", ""], ["80", "79"]
      ];
      for (const [warn, fail] of invalid) {
        const result = spawnSync(process.execPath, [path.join(ROOT, MONITOR)], {
          cwd: ROOT, encoding: "utf8", timeout: 5000, maxBuffer: 65536, windowsHide: true,
          env: { ...process.env, SERVER_STORE_DIR: store,
            RUNTIME_MONITOR_STATUS_PATH: path.join(store, "health-monitor-status.json"),
            RUNTIME_MONITOR_BASE_URL: "http://127.0.0.1:1",
            RUNTIME_MONITOR_DISK_WARN_PERCENT: warn, RUNTIME_MONITOR_DISK_FAIL_PERCENT: fail }
        });
        assert.notEqual(result.status, 0, `${warn}/${fail}`);
        assert.match(result.stderr, /disk thresholds require integer 1 <= warn < fail <= 100/);
        assert.equal(result.stdout, "", "early rejection cannot report a successful runtime check");
        assert.deepEqual(fs.readdirSync(store), [], "early rejection must leave the store untouched");
      }
    } finally { removeOwnedFixture(root, "football-storage-retention-"); }
  });
  check("signed installer binds backup and journald plus health-before-timer recovery order", () => {
    const shell = source(SHELL), recovery = source(RECOVERY);
    assert.match(shell, /install_managed_file "\$\{deploy_root\}\/football-postgres-backup\.sh" \/usr\/local\/sbin\/football-postgres-backup-v2 \|\| return 1/);
    assert.match(shell, /install_managed_file "\$\{deploy_root\}\/football-journald-retention\.conf" \/etc\/systemd\/journald\.conf\.d\/football-retention\.conf \|\| return 1/);
    assert.match(shell, /football-postgres-backup\.service football-postgres-backup\.timer; do/);
    assert.match(shell, /systemctl try-restart systemd-journald\.service \|\| abort_before_swap/);
    for (const name of ["recoverRollback", "recoverForward"]) {
      const start = recovery.indexOf(`const ${name} =`), end = recovery.indexOf("\nconst ", start + 1);
      const body = recovery.slice(start, end);
      assert(body.indexOf("system.waitForHealth()") >= 0);
      assert(body.indexOf("system.waitForHealth()") < body.indexOf("restoreTimerStates(transaction.config, system)"));
    }
  });
  check("retention schedules and privilege scopes do not shorten the existing release preparation gates", () => {
    assert.match(source("deploy/light-server/football-cleanup.timer"), /OnCalendar=\*-\*-\* 04:35:00/);
    assert.match(source("deploy/light-server/football-postgres-backup.timer"), /OnCalendar=\*-\*-\* 04:15:00/);
    assert.match(source("deploy/light-server/football-monitor.timer"), /OnUnitActiveSec=5m/);
    assert.match(source("deploy/light-server/football-monitor.service"), /RUNTIME_MONITOR_DISK_WARN_PERCENT=80/);
    const journal = source("deploy/light-server/football-journald-retention.conf");
    assert.match(journal, /^SystemMaxUse=512M$/m); assert.match(journal, /^MaxRetentionSec=14day$/m);
    const cleanup = source("deploy/light-server/football-cleanup.service");
    assert.match(cleanup, /^User=football$/m); assert.match(cleanup, /^ReadWritePaths=\/var\/lib\/football-predict$/m);
    assert.match(cleanup, /SERVER_CLEANUP_LOG_RETENTION_DAYS=14/);
    for (const key of ["APP_BACKUPS", "APP_ARTIFACTS", "TMP_ARTIFACTS", "SYSTEM_LOGS"])
      assert(cleanup.includes(`SERVER_CLEANUP_${key}=0`));
    assert.match(source("deploy/light-server/football-postgres-backup.service"), /FOOTBALL_POSTGRES_BACKUP_RETENTION_DAYS=7/);
    assert.match(source("deploy/light-server/football-postgres-backup.service"), /^ExecStart=\/usr\/bin\/bash \/usr\/local\/sbin\/football-postgres-backup-v2$/m);
    const preparation = require("./runReleaseWindowPreflight.cjs");
    assert.equal(preparation.preparationBudget("before-build").preparationSeconds, 1800);
    assert.equal(preparation.preparationBudget("before-upload").preparationSeconds, 900);
    const shell = source(SHELL);
    for (const [key, value] of [["CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS", 900], ["CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS", 900],
      ["CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS", 30], ["LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS", 900],
      ["WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS", 1500], ["POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS", 120],
      ["RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS", 900000]]) {
      const env = key.startsWith("RELEASE_") ? key : `RELEASE_${key}`;
      assert(shell.includes(`${key}="\${${env}:-${value}}"`), `release default ${key} must remain`);
    }
  });
  assert.deepEqual(pins(), before, "sources changed while the verifier was executing");
  return { version: "scheduled-storage-retention-local-contract-v1", ok: true, checkedAt: new Date().toISOString(),
    checks: results.length, passed: results.length, failed: 0, skipped: 0, results, sourceHashes: before,
    scope: { actualRecoveryEntrypoint: true, actualCleanupEntrypoint: true, monitorFunctionWithSyntheticDf: true,
      systemdMocked: true, ownedFixturesCleaned: true, productionPathsTouched: false, installerExecuted: false,
      postgresAccess: false, network: false, releaseBudgetModified: false } };
}

module.exports = { verifyScheduledStorageRetention };
if (require.main === module) {
  assert.equal(process.argv.length, 2, "unexpected verifier arguments");
  console.log(JSON.stringify(verifyScheduledStorageRetention(), null, 2));
}
