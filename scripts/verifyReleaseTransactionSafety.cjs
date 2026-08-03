const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");
const bundleReleasePath = path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh");
const releaseRecoveryPath = path.join(rootDir, "deploy", "light-server", "football-release-recovery.cjs");
const releaseWrapperPath = path.join(rootDir, "deploy", "light-server", "football-release");
const deployReleaseBundlePath = path.join(rootDir, "scripts", "deployReleaseBundle.cjs");
const compactPublicOddsHistoryPath = path.join(rootDir, "scripts", "compactPublicOddsHistory.cjs");
const sqliteReleaseSealPath = path.join(rootDir, "scripts", "sqliteReleaseSeal.cjs");
const releasePrebuildPolicyPath = path.join(rootDir, "scripts", "releasePrebuildPolicy.cjs");
const releaseHeartbeatKeeperPath = path.join(
  rootDir,
  "scripts",
  "runReleaseCandidateHeartbeatKeeper.cjs",
);
const {
  captureScheduleDelayMs,
  exactHeartbeatMatches,
  validateKeeperOptions,
} = require(releaseHeartbeatKeeperPath);
const {
  captureSeal,
  copyRollbackSnapshot,
  finalizeRecoverySnapshot,
  verifyMetadataSeal,
} = require(sqliteReleaseSealPath);
const {
  DEFAULT_MAX_APP_MEMORY_CURRENT_MIB,
  DEFAULT_MAX_APP_WORKING_SET_MIB,
  DEFAULT_MIN_MEM_AVAILABLE_MIB,
  evaluateCapacity,
  evaluateFreshness,
  resolveCapacityLimits,
} = require(releasePrebuildPolicyPath);

const checks = [];

function check(name, callback) {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error });
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fixture(entries = {}) {
  return new Map(Object.entries(entries).map(([entryPath, entry]) => [entryPath, clone(entry)]));
}

function snapshotPaths(fileSystem, managedPaths) {
  return managedPaths.map((entryPath) => ({
    path: entryPath,
    state: fileSystem.has(entryPath)
      ? clone(fileSystem.get(entryPath))
      : { kind: "absent" },
  }));
}

function restorePaths(fileSystem, manifest) {
  for (const record of manifest) {
    fileSystem.delete(record.path);
    if (record.state.kind !== "absent") {
      fileSystem.set(record.path, clone(record.state));
    }
  }
}

function snapshotTimers(timers, names) {
  return names.map((name) => ({
    name,
    state: timers.has(name)
      ? { exists: true, ...clone(timers.get(name)) }
      : { exists: false },
  }));
}

function restoreTimers(timers, manifest) {
  for (const record of manifest) {
    if (!record.state.exists) {
      timers.delete(record.name);
      continue;
    }
    timers.set(record.name, {
      enabled: record.state.enabled,
      active: record.state.active,
    });
  }
}

function rollbackTree({ live, backup, failed }, failAt = "") {
  const state = { live, backup, failed };
  const events = [];
  const failStop = (operation) => ({ ok: false, operation, state: clone(state), events: [...events] });

  if (!state.backup) return failStop("missing-backup");
  if (state.failed) {
    events.push("remove-failed");
    if (failAt === "remove-failed") return failStop("remove-failed");
    state.failed = null;
  }
  if (state.live) {
    events.push("move-live-to-failed");
    if (failAt === "move-live-to-failed") return failStop("move-live-to-failed");
    state.failed = state.live;
    state.live = null;
  }
  events.push("move-backup-to-live");
  if (failAt === "move-backup-to-live") return failStop("move-backup-to-live");
  state.live = state.backup;
  state.backup = null;
  events.push("restore-dependent-state");
  return { ok: true, state, events };
}

function runAuthorizedRelease(sequenceState, releaseSequence, guardedRelease) {
  const events = [];
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence <= sequenceState.highestAccepted) {
    return { ok: false, rejected: true, events, highestAccepted: sequenceState.highestAccepted };
  }

  // Authorization is single-use. Burning it before execution makes a failed release non-replayable.
  sequenceState.highestAccepted = releaseSequence;
  events.push(`burn:${releaseSequence}`);
  const ok = guardedRelease(events);
  events.push(ok ? "status:complete" : "status:failed");
  return { ok, rejected: false, events, highestAccepted: sequenceState.highestAccepted };
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function extractFunction(source, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMatch = new RegExp(`^${escapedName}\\(\\) \\{\\n`, "m").exec(source);
  assert.ok(startMatch, `missing shell function: ${functionName}`);
  const bodyStart = startMatch.index + startMatch[0].length;
  const endMatch = /^}\n/m.exec(source.slice(bodyStart));
  assert.ok(endMatch, `unterminated shell function: ${functionName}`);
  return source.slice(bodyStart, bodyStart + endMatch.index);
}

function extractFunctionHeredoc(source, functionName, delimiter) {
  const functionMarker = `${functionName}() {\n`;
  const functionStart = source.indexOf(functionMarker);
  assert.ok(functionStart >= 0, `missing shell function: ${functionName}`);
  const heredocMarker = `<<'${delimiter}'\n`;
  const heredocStart = source.indexOf(heredocMarker, functionStart + functionMarker.length);
  assert.ok(heredocStart >= 0, `missing ${delimiter} heredoc in shell function: ${functionName}`);
  const bodyStart = heredocStart + heredocMarker.length;
  const bodyEnd = source.indexOf(`\n${delimiter}\n`, bodyStart);
  assert.ok(bodyEnd >= 0, `unterminated ${delimiter} heredoc in shell function: ${functionName}`);
  return source.slice(bodyStart, bodyEnd);
}

function assertOrdered(source, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    assert.ok(current >= 0, `${label}: missing marker ${JSON.stringify(marker)}`);
    assert.ok(current > previous, `${label}: marker is out of order ${JSON.stringify(marker)}`);
    previous = current;
  }
}

function countLiteral(source, literal) {
  return source.split(literal).length - 1;
}

function durableSqliteManifest(entries) {
  return ["base", "wal"].map((token) => {
    const entry = entries[token];
    return entry
      ? [token, 1, entry.bytes, entry.sha256, entry.uid, entry.gid, entry.mode].join("\t")
      : [token, 0, "-", "-", "-", "-", "-"].join("\t");
  }).join("\n");
}

function durableSqliteManifestFromPath(sqlitePath) {
  const entries = {};
  for (const [token, suffix] of [["base", ""], ["wal", "-wal"]]) {
    const filePath = `${sqlitePath}${suffix}`;
    if (!fs.existsSync(filePath)) continue;
    const info = fs.lstatSync(filePath);
    assert.equal(info.isFile(), true, `${token} must be a regular file`);
    assert.equal(info.isSymbolicLink(), false, `${token} must not be a symlink`);
    assert.equal(info.nlink, 1, `${token} must have exactly one hard link`);
    const bytes = fs.readFileSync(filePath);
    entries[token] = {
      bytes: info.size,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      uid: info.uid,
      gid: info.gid,
      mode: (info.mode & 0o777).toString(8),
    };
  }
  return durableSqliteManifest(entries);
}

function prebuiltSqliteCasMatches(prebuildSourceManifest, rollbackManifest) {
  const rollbackDurable = String(rollbackManifest || "")
    .split(/\r?\n/u)
    .filter((row) => /^(base|wal)\t/u.test(row))
    .join("\n");
  return prebuildSourceManifest === rollbackDurable;
}

function exactHeartbeatFixture(evaluatedAt, overrides = {}) {
  return {
    version: "prospective-deadline-heartbeat-v2",
    ok: true,
    skipped: false,
    dueCaptureComplete: true,
    dueAtomicComplete: true,
    dueUnrecorded: 0,
    readyDueUnrecorded: 0,
    evaluatedAt,
    audit: {
      evaluatedAt,
      state: "ACTIVE",
      chainValid: true,
      rootHash: "a".repeat(64),
      candidateRevisionId: "candidate@test",
      decisionRecord: {
        version: "candidate-atomic-decision-record-v3",
        admittedRows: 0,
        atomicRows: 0,
        completeRows: 0,
        failedRows: 0,
        coverage: 1,
        complete: true,
      },
    },
    blockers: [],
    readiness: {
      version: "candidate-prospective-readiness-preview-v2",
      evaluatedAt,
      candidateRevisionId: "candidate@test",
      evaluatedMatches: 0,
      detailedMatches: 0,
      rowsTruncated: 0,
      upcomingMatches: 0,
      readyNow: 0,
      atomicReadyNow: 0,
      awaitingMarket: 0,
      blocked: 0,
      excluded: 0,
      readyInvariantOk: true,
      nearestDeadlineAt: null,
      nearestFinalizationAt: null,
      nearestStatus: null,
      deadlineBatches: [],
      nearestDeadlineBatch: null,
    },
    ...overrides,
  };
}

function mainProgram(source) {
  const trapFunctionStart = source.indexOf("release_exit_trap() {");
  assert.ok(trapFunctionStart >= 0, "missing release_exit_trap shell function");
  const trapFunctionEnd = source.indexOf("\n}\n", trapFunctionStart);
  assert.ok(trapFunctionEnd >= 0, "unterminated release_exit_trap shell function");
  return source.slice(trapFunctionEnd + 3);
}

function runHeartbeatKeeperIntegration(mode) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-heartbeat-keeper-"));
  const storeDir = path.join(tempRoot, "store");
  const controlDir = path.join(tempRoot, "control");
  fs.mkdirSync(storeDir);
  fs.mkdirSync(controlDir);
  const captureScript = path.join(tempRoot, "fake-capture.cjs");
  const heartbeatStatusFile = path.join(storeDir, "candidate-prospective-capture-status.json");
  const controlFile = path.join(controlDir, "keeper-status.json");
  const counterFile = path.join(storeDir, "counter.txt");
  fs.writeFileSync(captureScript, `
const fs = require("node:fs");
const counterFile = process.env.FAKE_CAPTURE_COUNTER;
const statusFile = process.env.FAKE_HEARTBEAT_STATUS;
const prior = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : 0);
const count = prior + 1;
fs.writeFileSync(counterFile, String(count));
if (process.env.FAKE_KEEPER_MODE === "fail-second" && count >= 2) process.exit(7);
if (process.env.FAKE_KEEPER_MODE === "fail-during-stop-second" && count >= 2) {
  setTimeout(() => process.exit(7), 700);
} else if (process.env.FAKE_KEEPER_MODE === "lock-busy-first" && count === 1) {
  process.stdout.write(JSON.stringify({ transientAttempt: { reason: "registry-lock-busy" } }));
  process.exit(0);
}
if (process.env.FAKE_KEEPER_MODE === "timeout-second" && count >= 2) {
  setTimeout(() => {}, 30_000);
} else {
  const publish = () => {
    const evaluatedAt = process.env.CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT;
    fs.writeFileSync(statusFile, JSON.stringify({
      version: "prospective-deadline-heartbeat-v2",
      ok: true,
      skipped: false,
      dueCaptureComplete: true,
      dueAtomicComplete: true,
      dueUnrecorded: 0,
      readyDueUnrecorded: 0,
      evaluatedAt,
      audit: {
        evaluatedAt,
        state: "ACTIVE",
        chainValid: true,
        rootHash: "a".repeat(64),
        candidateRevisionId: "candidate@test",
        decisionRecord: {
          version: "candidate-atomic-decision-record-v3",
          admittedRows: 0,
          atomicRows: 0,
          completeRows: 0,
          failedRows: 0,
          coverage: 1,
          complete: true,
        },
      },
      blockers: [],
      readiness: {
        version: "candidate-prospective-readiness-preview-v2",
        evaluatedAt,
        candidateRevisionId: "candidate@test",
        evaluatedMatches: 0,
        detailedMatches: 0,
        rowsTruncated: 0,
        upcomingMatches: 0,
        readyNow: 0,
        atomicReadyNow: 0,
        awaitingMarket: 0,
        blocked: 0,
        excluded: 0,
        readyInvariantOk: true,
        nearestDeadlineAt: null,
        nearestFinalizationAt: null,
        nearestStatus: null,
        deadlineBatches: [],
        nearestDeadlineBatch: null,
      },
    }));
  };
  if (process.env.FAKE_KEEPER_MODE === "signal-during-second" && count >= 2) {
    setTimeout(publish, 700);
  } else {
    publish();
  }
}
`, "utf8");

  const args = [
    releaseHeartbeatKeeperPath,
    "--instance-id", `integration-${mode}.service`,
    "--capture-script", captureScript,
    "--heartbeat-status-file", heartbeatStatusFile,
    "--control-file", controlFile,
    "--working-directory", tempRoot,
    "--store-dir", storeDir,
    "--sqlite-path", path.join(storeDir, "football.db"),
    "--interval-seconds", "5",
    "--attempt-timeout-ms", mode === "timeout-second" ? "1500" : "4000",
    "--lock-timeout-ms", "1000",
  ];
  const env = {
    ...process.env,
    FAKE_KEEPER_MODE: mode,
    FAKE_CAPTURE_COUNTER: counterFile,
    FAKE_HEARTBEAT_STATUS: heartbeatStatusFile,
  };
  const harness = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = JSON.parse(process.env.KEEPER_ARGS);
const mode = process.env.FAKE_KEEPER_MODE;
const stopDuringSecond = ["signal-during-second", "fail-during-stop-second"].includes(mode);
const failureMode = !["signal", "signal-during-second", "fail-during-stop-second"].includes(mode);
const child = spawn(process.execPath, args, {
  cwd: process.env.KEEPER_CWD,
  env: process.env,
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
let observedControl = null;
let aliveBeforeSignal = false;
let capturesAtObservation = null;
let capturesBeforeSignal = null;
let stopScheduled = false;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
const readCaptures = () => Number(
  fs.existsSync(process.env.FAKE_CAPTURE_COUNTER)
    ? fs.readFileSync(process.env.FAKE_CAPTURE_COUNTER, "utf8")
    : 0,
);
const requestExplicitStop = () => {
  if (process.platform === "win32") {
    // Windows terminates Node immediately for child.kill("SIGTERM") instead
    // of delivering the registered POSIX handler. Exercise that same handler
    // over the keeper's private IPC control channel on Windows; Linux CI and
    // production use the real signal path below.
    child.send({ type: "release-candidate-heartbeat-keeper-signal", signal: "SIGTERM" });
  } else {
    child.kill("SIGTERM");
  }
};
const deadline = Date.now() + 25000;
const poll = setInterval(() => {
  if (Date.now() >= deadline) {
    clearInterval(poll);
    child.kill("SIGKILL");
    return;
  }
  // Once the stop request has been scheduled, stop reopening the keeper's
  // control file. On Windows, a concurrent reader can transiently prevent the
  // keeper's final atomic rename and leave the preceding failed-latched record
  // on disk even though the keeper drained and exited cleanly. Production uses
  // Linux, but the regression harness must not manufacture that sharing race.
  if (stopScheduled) return;
  try {
    const control = JSON.parse(fs.readFileSync(process.env.KEEPER_CONTROL, "utf8"));
    const reachedTarget = stopDuringSecond
      ? control.state === "running" && control.activeAttempt?.sequence >= 2
      : failureMode
        ? control.state === "failed-latched" && control.awaitingExplicitStop === true
        : control.state === "running" && control.captureSequence >= 1 && control.activeAttempt == null;
    if (reachedTarget && !stopScheduled) {
      stopScheduled = true;
      observedControl = control;
      aliveBeforeSignal = child.exitCode === null && child.signalCode === null;
      capturesAtObservation = readCaptures();
      const signalAfterSecondCaptureStarts = () => {
        if (stopDuringSecond && readCaptures() < 2 && Date.now() < deadline) {
          setTimeout(signalAfterSecondCaptureStarts, 10);
          return;
        }
        capturesBeforeSignal = readCaptures();
        requestExplicitStop();
      };
      setTimeout(
        signalAfterSecondCaptureStarts,
        stopDuringSecond ? 10 : 300,
      );
    }
  } catch {}
}, 25);
child.on("close", (code, signal) => {
  clearInterval(poll);
  process.stdout.write(JSON.stringify({
    code,
    signal,
    observedControl,
    aliveBeforeSignal,
    capturesAtObservation,
    capturesBeforeSignal,
    stderr,
  }));
  process.exitCode = code === 0 && !signal ? 0 : 1;
});
`;
  const result = spawnSync(process.execPath, ["-e", harness], {
    cwd: rootDir,
    env: {
      ...env,
      KEEPER_ARGS: JSON.stringify(args),
      KEEPER_CWD: rootDir,
      KEEPER_CONTROL: controlFile,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  let observed = null;
  try {
    observed = JSON.parse(result.stdout || "null");
  } catch {}
  const control = fs.existsSync(controlFile)
    ? JSON.parse(fs.readFileSync(controlFile, "utf8"))
    : null;
  const captures = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : 0);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  return { result, control, captures, observed };
}

check("runtime env snapshot restores exact bytes and metadata", () => {
  const envPath = "/etc/football-predict/env";
  const before = {
    kind: "file",
    bytesHex: Buffer.from("ACCESS_TOKEN=old\nBINARY=\\u0000tail", "utf8").toString("hex"),
    mode: "0640",
    owner: "root",
    group: "football",
  };
  const fileSystem = fixture({ [envPath]: before });
  const manifest = snapshotPaths(fileSystem, [envPath]);
  fileSystem.set(envPath, { kind: "file", bytesHex: "00", mode: "0666", owner: "build", group: "build" });
  restorePaths(fileSystem, manifest);
  assert.deepEqual(fileSystem.get(envPath), before);
});

check("runtime env restore deletes a file that did not exist before release", () => {
  const envPath = "/etc/football-predict/env";
  const fileSystem = fixture();
  const manifest = snapshotPaths(fileSystem, [envPath]);
  fileSystem.set(envPath, { kind: "file", bytesHex: "736563726574", mode: "0640", owner: "root", group: "football" });
  restorePaths(fileSystem, manifest);
  assert.equal(fileSystem.has(envPath), false);
  assert.deepEqual(manifest, [{ path: envPath, state: { kind: "absent" } }]);
});

check("managed config manifest exactly restores files, symlinks, and absent paths", () => {
  const managedPaths = [
    "/etc/systemd/system/football-monitor.service",
    "/etc/nginx/sites-available/football-predict",
    "/etc/nginx/sites-enabled/football-predict",
    "/etc/nginx/snippets/football-predict-server.conf",
  ];
  const before = fixture({
    [managedPaths[0]]: { kind: "file", bytesHex: "6f6c642d756e6974", mode: "0644", owner: "root", group: "root" },
    [managedPaths[1]]: { kind: "file", bytesHex: "6f6c642d6e67696e78", mode: "0600", owner: "root", group: "root" },
    [managedPaths[2]]: { kind: "symlink", target: "../sites-available/custom-before-release", owner: "root", group: "root" },
  });
  const manifest = snapshotPaths(before, managedPaths);

  before.set(managedPaths[0], { kind: "file", bytesHex: "6e6577", mode: "0777", owner: "build", group: "build" });
  before.set(managedPaths[1], { kind: "symlink", target: "/wrong/type" });
  before.set(managedPaths[2], { kind: "file", bytesHex: "77726f6e672d74797065", mode: "0644" });
  before.set(managedPaths[3], { kind: "file", bytesHex: "6e65772d66696c65", mode: "0644", owner: "root", group: "root" });
  restorePaths(before, manifest);

  assert.deepEqual(before, fixture({
    [managedPaths[0]]: { kind: "file", bytesHex: "6f6c642d756e6974", mode: "0644", owner: "root", group: "root" },
    [managedPaths[1]]: { kind: "file", bytesHex: "6f6c642d6e67696e78", mode: "0600", owner: "root", group: "root" },
    [managedPaths[2]]: { kind: "symlink", target: "../sites-available/custom-before-release", owner: "root", group: "root" },
  }));
  assert.equal(before.has(managedPaths[3]), false, "an originally absent managed file must be removed");
});

check("external model artifact rollback exactly restores all external model artifacts", () => {
  const strategyPath = "/var/lib/football-predict/model-strategy.json";
  const evaluationPath = "/var/lib/football-predict/model-artifacts/evaluation.json";
  const registryPath = "/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json";
  const challengerPath = "/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json";
  const temperatureSuitePath = "/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json";
  const beforeStrategy = {
    kind: "file",
    bytesHex: Buffer.from('{"version":"before"}\n', "utf8").toString("hex"),
    mode: "0640",
    owner: "football",
    group: "football",
  };
  const beforeRegistry = {
    kind: "file",
    bytesHex: Buffer.from('{"version":"candidate-before"}\n', "utf8").toString("hex"),
    mode: "0640",
    owner: "football",
    group: "football",
  };
  const fileSystem = fixture({
    [strategyPath]: beforeStrategy,
    [registryPath]: beforeRegistry,
  });
  const manifest = snapshotPaths(fileSystem, [
    strategyPath,
    evaluationPath,
    registryPath,
    challengerPath,
    temperatureSuitePath,
  ]);
  fileSystem.set(strategyPath, { kind: "file", bytesHex: "00", mode: "0666", owner: "build", group: "build" });
  fileSystem.set(evaluationPath, { kind: "file", bytesHex: "ff", mode: "0644", owner: "football", group: "football" });
  fileSystem.set(registryPath, { kind: "file", bytesHex: "11", mode: "0666", owner: "build", group: "build" });
  fileSystem.set(challengerPath, { kind: "file", bytesHex: "22", mode: "0644", owner: "football", group: "football" });
  fileSystem.set(temperatureSuitePath, { kind: "file", bytesHex: "33", mode: "0644", owner: "football", group: "football" });
  restorePaths(fileSystem, manifest);
  assert.deepEqual(fileSystem.get(strategyPath), beforeStrategy);
  assert.deepEqual(fileSystem.get(registryPath), beforeRegistry);
  assert.equal(fileSystem.has(evaluationPath), false, "an originally absent evaluation artifact must be removed");
  assert.equal(fileSystem.has(challengerPath), false, "an originally absent challenger artifact must be removed");
  assert.equal(fileSystem.has(temperatureSuitePath), false, "an originally absent temperature suite artifact must be removed");
  assert.equal(manifest.length, 5, "the current recovery contract contains exactly five external model artifacts");
});

check("HHAD companion private audit follows the SQLite rollback image", () => {
  const sqlitePath = "/var/lib/football-predict/football.db";
  const beforeSqlite = {
    kind: "file",
    bytesHex: Buffer.from(
      "sqlite-before-release\nprivate_model_artifacts:hhad-companion-audit=old-hhad-companion-audit\n",
      "utf8"
    ).toString("hex"),
    mode: "0640",
    owner: "football",
    group: "football",
  };
  const fileSystem = fixture({ [sqlitePath]: beforeSqlite });
  const manifest = snapshotPaths(fileSystem, [sqlitePath]);
  fileSystem.set(sqlitePath, {
    ...beforeSqlite,
    bytesHex: Buffer.from(
      "sqlite-after-release\nprivate_model_artifacts:hhad-companion-audit=new-hhad-companion-audit\n",
      "utf8"
    ).toString("hex"),
  });
  restorePaths(fileSystem, manifest);
  assert.deepEqual(fileSystem.get(sqlitePath), beforeSqlite);
  assert.match(
    Buffer.from(fileSystem.get(sqlitePath).bytesHex, "hex").toString("utf8"),
    /private_model_artifacts:hhad-companion-audit=old-hhad-companion-audit/
  );
});

check("timer rollback independently restores every enabled/active combination", () => {
  const timers = new Map([
    ["enabled-active.timer", { enabled: true, active: true }],
    ["enabled-inactive.timer", { enabled: true, active: false }],
    ["disabled-active.timer", { enabled: false, active: true }],
    ["disabled-inactive.timer", { enabled: false, active: false }],
  ]);
  const names = [...timers.keys(), "missing.timer"];
  const before = clone([...timers.entries()]);
  const manifest = snapshotTimers(timers, names);
  for (const name of names) timers.set(name, { enabled: true, active: true });
  restoreTimers(timers, manifest);
  assert.deepEqual([...timers.entries()], before);
  assert.equal(timers.has("missing.timer"), false);
});

check("rollback tree move failures stop before unsafe follow-on moves", () => {
  const missingBackup = rollbackTree({ live: "candidate", backup: null, failed: null });
  assert.equal(missingBackup.ok, false);
  assert.equal(missingBackup.operation, "missing-backup");
  assert.deepEqual(missingBackup.events, []);
  assert.deepEqual(missingBackup.state, { live: "candidate", backup: null, failed: null });

  const cleanupFailure = rollbackTree({ live: "candidate", backup: "previous", failed: "stale" }, "remove-failed");
  assert.equal(cleanupFailure.ok, false);
  assert.deepEqual(cleanupFailure.events, ["remove-failed"]);
  assert.deepEqual(cleanupFailure.state, { live: "candidate", backup: "previous", failed: "stale" });

  const liveMoveFailure = rollbackTree({ live: "candidate", backup: "previous", failed: null }, "move-live-to-failed");
  assert.equal(liveMoveFailure.ok, false);
  assert.deepEqual(liveMoveFailure.events, ["move-live-to-failed"]);
  assert.equal(liveMoveFailure.state.backup, "previous");

  const backupMoveFailure = rollbackTree({ live: "candidate", backup: "previous", failed: null }, "move-backup-to-live");
  assert.equal(backupMoveFailure.ok, false);
  assert.deepEqual(backupMoveFailure.events, ["move-live-to-failed", "move-backup-to-live"]);
  assert.deepEqual(backupMoveFailure.state, { live: null, backup: "previous", failed: "candidate" });
  assert.equal(backupMoveFailure.events.includes("restore-dependent-state"), false);

  const success = rollbackTree({ live: "candidate", backup: "previous", failed: null });
  assert.equal(success.ok, true);
  assert.deepEqual(success.state, { live: "previous", backup: null, failed: "candidate" });
});

check("release sequence is burned before execution and remains burned on failure", () => {
  const state = { highestAccepted: 40 };
  const failed = runAuthorizedRelease(state, 41, (events) => {
    events.push("guarded-release:start");
    return false;
  });
  assert.deepEqual(failed.events, ["burn:41", "guarded-release:start", "status:failed"]);
  assert.equal(state.highestAccepted, 41);

  const replay = runAuthorizedRelease(state, 41, () => true);
  assert.equal(replay.rejected, true);
  assert.deepEqual(replay.events, []);

  const success = runAuthorizedRelease(state, 42, (events) => {
    events.push("guarded-release:start");
    return true;
  });
  assert.deepEqual(success.events, ["burn:42", "guarded-release:start", "status:complete"]);
  assert.equal(state.highestAccepted, 42);
});

const bundleRelease = readText(bundleReleasePath);
const releaseRecovery = readText(releaseRecoveryPath);
const releaseWrapper = readText(releaseWrapperPath);

check("signed bundle release uses the fixed root-owned recovery transaction directory", () => {
  assert.ok(
    bundleRelease.includes("/var/lib/football-release/recovery/current"),
    "missing fixed recovery transaction directory",
  );
});

check("signed bundle release snapshots runtime env before mutation and restores it during rollback", () => {
  const main = mainProgram(bundleRelease);
  const snapshotBody = extractFunction(bundleRelease, "snapshot_runtime_env_for_rollback");
  const restoreBody = extractFunction(bundleRelease, "restore_runtime_env_after_rollback");
  const initializeBody = extractFunction(bundleRelease, "initialize_release_recovery_snapshot");
  const restoreTransactionBody = extractFunction(bundleRelease, "restore_pre_swap_transaction");
  assertOrdered(initializeBody, [
    "snapshot_runtime_env_for_rollback",
    "snapshot_managed_config_for_rollback",
  ], "signed bundle release recovery initialization");
  assertOrdered(main, ["initialize_release_recovery_snapshot", "prepare_runtime_env"], "signed bundle release main program");
  assert.match(snapshotBody, /RUNTIME_ENV/);
  assert.match(snapshotBody, /absent|missing|did_not_exist|EXISTED/i);
  assert.match(restoreBody, /RUNTIME_ENV/);
  assert.match(restoreBody, /absent|missing|did_not_exist|EXISTED/i);
  assert.match(restoreBody, /rmdir -- "\$env_parent"[\s\S]*?return 1/);
  assert.match(restoreBody, /parent_state[\s\S]*?parent-metadata/);
  assert.match(restoreTransactionBody, /restore_runtime_env_after_rollback\s*\|\|/);
});

check("signed bundle release snapshots and exactly restores managed config and timer state", () => {
  const main = mainProgram(bundleRelease);
  const snapshotBody = extractFunction(bundleRelease, "snapshot_managed_config_for_rollback");
  const restoreBody = extractFunction(bundleRelease, "restore_managed_config_after_rollback");
  const unitRestoreBody = extractFunction(bundleRelease, "restore_managed_unit_states_after_rollback");
  const timerRestoreBody = extractFunction(bundleRelease, "restore_timer_states_after_rollback");
  const restoreTransactionBody = extractFunction(bundleRelease, "restore_pre_swap_transaction");
  assertOrdered(main, ["initialize_release_recovery_snapshot", "install_systemd_units"], "signed bundle release main program");
  assert.match(bundleRelease, /sites-enabled\/football-predict/);
  assert.match(snapshotBody, /is-enabled/);
  assert.match(snapshotBody, /is-active/);
  assertOrdered(snapshotBody, [
    'install -d -o root -g root -m 0700 -- "$snapshot_dir"',
    'install -d -o root -g root -m 0700 -- "$entries_dir"',
  ], "managed config snapshot directory creation");
  assert.match(restoreBody, /readlink|symlink|ln -s/);
  assert.match(restoreBody, /absent|missing|did_not_exist/i);
  assert.match(restoreBody, /systemctl daemon-reload/);
  assert.match(timerRestoreBody, /systemctl (enable|disable)/);
  assert.match(timerRestoreBody, /systemctl (start|stop)/);
  assert.match(unitRestoreBody, /managed-config\/units\.tsv/);
  assert.match(unitRestoreBody, /wait_for_health/);
  assert.match(unitRestoreBody, /football-predict\.service/);
  assert.match(unitRestoreBody, /football-sync-worker\.service/);
  assertOrdered(restoreTransactionBody, [
    "restore_managed_config_after_rollback",
    "restore_managed_unit_states_after_rollback",
    "restore_timer_states_after_rollback",
    "clear_release_recovery_snapshot",
  ], "signed bundle release recovery restore");
});

check("signed bundle release rollback app-tree moves are fail-stop", () => {
  const moveBody = extractFunction(bundleRelease, "restore_app_tree_after_rollback");
  assert.match(moveBody, /mv [^\n]*APP_DIR[^\n]*FAILED_DIR[\s\S]*?\|\|\s*\{[^}]*return 1;/);
  assert.match(moveBody, /mv [^\n]*BACKUP_DIR[^\n]*APP_DIR[\s\S]*?\|\|\s*\{[^}]*return 1;/);
  assert.doesNotMatch(moveBody, /mv [^\n]*\|\| rollback_failed=1/);
  const rollbackBody = extractFunction(bundleRelease, "rollback");
  assert.match(rollbackBody, /restore_app_tree_after_rollback\s*\|\|\s*\{/);
  assertOrdered(rollbackBody, [
    "restore_app_tree_after_rollback",
    "restore_live_sqlite_after_rollback",
    "restore_external_model_artifacts_after_rollback",
    "restore_runtime_env_after_rollback",
    "restore_managed_config_after_rollback",
    "restore_managed_unit_states_after_rollback",
    "restore_timer_states_after_rollback",
    "clear_release_recovery_snapshot",
  ], "signed bundle release rollback");
  assert.doesNotMatch(rollbackBody, /rollback_failed/);
});

check("signed bundle release wires recovery into pre-swap failure and successful commit paths", () => {
  const main = mainProgram(bundleRelease);
  const exitTrapBody = extractFunction(bundleRelease, "release_exit_trap");
  const restoreBody = extractFunction(bundleRelease, "restore_pre_swap_transaction");
  assert.match(exitTrapBody, /(?:if\s+!\s+)?restore_pre_swap_transaction(?:\s*\|\|)?/);
  assert.doesNotMatch(exitTrapBody, /restart_service_if_needed|restart_worker_if_needed/);
  assertOrdered(restoreBody, [
    "restore_runtime_env_after_rollback",
    "restore_managed_config_after_rollback",
    "restore_managed_unit_states_after_rollback",
    "restore_timer_states_after_rollback",
    "clear_release_recovery_snapshot",
  ], "pre-swap recovery retains credentials until units, health, and timers are restored");
  assertOrdered(main, [
    "initialize_release_recovery_snapshot",
    "clear_release_recovery_snapshot",
  ], "signed bundle release recovery lifecycle");
});

check("signed wrapper burns the accepted sequence before guarded release execution", () => {
  const burn = 'consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"';
  assert.equal(countLiteral(releaseWrapper, burn), 1, "sequence must be burned exactly once");
  const consumeBody = extractFunction(releaseWrapper, "consume_release_sequence_before_execution");
  assert.match(consumeBody, /HIGHEST_SEQUENCE_FILE/);
  assert.match(consumeBody, /mv -fT/);
  assertOrdered(releaseWrapper, [
    'readonly MANIFEST_SEQUENCE="$manifest_sequence"',
    burn,
    "env -i \\",
    'bash "$RELEASE_SCRIPT_PATH" "$TRUSTED_SOURCE_DIR"',
    'if [ "$release_status" -ne 0 ]',
  ], "signed release wrapper");
  const failedBranchStart = releaseWrapper.indexOf('if [ "$release_status" -ne 0 ]');
  const failedBranchEnd = releaseWrapper.indexOf("\nfi", failedBranchStart);
  const failedBranch = releaseWrapper.slice(failedBranchStart, failedBranchEnd);
  assert.doesNotMatch(failedBranch, /HIGHEST_SEQUENCE_FILE|highest.accepted.sequence|consume_release_sequence/i);
});

check("fixed wrapper exclusively publishes terminal release status after child completion", () => {
  assert.doesNotMatch(bundleRelease, /RELEASE_STATUS_FILE|status=complete/);
  assert.match(releaseWrapper, /write_status "running"/);
  assert.match(releaseWrapper, /write_status "failed"/);
  assert.match(releaseWrapper, /write_status "complete"/);
  const main = mainProgram(bundleRelease);
  const commitBody = extractFunction(bundleRelease, "commit_release_transaction");
  const rollbackBody = extractFunction(bundleRelease, "rollback");
  const exitTrapBody = extractFunction(bundleRelease, "release_exit_trap");
  assertOrdered(commitBody, [
    "TRANSACTION_FINALIZING=1",
    'write_recovery_phase "finalizing"',
    'write_recovery_phase "committed"',
    "TRANSACTION_COMMITTED=1",
    "SWAP_STARTED=0",
    "TRANSACTION_FINALIZING=0",
  ], "signed bundle release commit boundary");
  assertOrdered(main, [
    "commit_release_transaction",
    "clear_release_recovery_snapshot",
    "trap - EXIT",
  ], "signed bundle release commit cleanup");
  assertOrdered(rollbackBody, [
    "TRANSACTION_COMMITTED",
    'if [ "${SWAP_STARTED:-0}" != "1" ]',
  ], "rollback rejects a committed transaction before inspecting swap state");
  assertOrdered(exitTrapBody, [
    "TRANSACTION_FINALIZING",
    'if [ "$status" -ne 0 ] && [ "${SWAP_STARTED:-0}" = "1" ]',
    "restore_pre_swap_transaction",
  ], "exit trap fail-stops finalized transactions before any restoration");
  const clearBody = extractFunction(bundleRelease, "clear_release_recovery_snapshot");
  assert.match(clearBody, /\.resolved\./);
  assert.match(clearBody, /mv -T -- "\$RECOVERY_DIR" "\$RECOVERY_RESOLVED_DIR"/);
  assert.match(clearBody, /sync -f "\$RECOVERY_ROOT"/);
  assert.doesNotMatch(bundleRelease, /clear_release_recovery_snapshot\s*\|\|\s*rollback/);
});

check("sqlite recovery uses explicit tokens, validates snapshots, and quiesces maintenance first", () => {
  const main = mainProgram(bundleRelease);
  const snapshotBody = extractFunction(bundleRelease, "backup_live_sqlite_for_rollback");
  const restoreBody = extractFunction(bundleRelease, "restore_live_sqlite_after_rollback");
  const quiesceBody = extractFunction(bundleRelease, "quiesce_managed_maintenance_for_sqlite_snapshot");
  assert.match(snapshotBody, /sqlite_tokens=\(base wal shm\)/);
  assert.match(snapshotBody, /ALLOW_STOPPED_WINDOW_SQLITE_EXPORT/);
  assert.match(snapshotBody, /sha256sum/);
  assert.match(snapshotBody, /stat -c '%s'/);
  assert.match(restoreBody, /line_count[^\n]*-eq 3/);
  assert.match(restoreBody, /actual_digest=.*sha256sum/);
  assertOrdered(restoreBody, [
    "while IFS=$'\\t' read -r token present bytes digest uid gid mode extra",
    "[ \"$line_count\" -eq 3 ]",
    'temporary="${LIVE_SQLITE_PATH}${suffix}.rollback.',
    'rm -f -- "${LIVE_SQLITE_PATH}${suffix}"',
  ], "sqlite recovery validates before deleting live state");
  assert.match(quiesceBody, /football-cleanup\.service/);
  assert.match(quiesceBody, /football-monitor\.service/);
  assert.match(quiesceBody, /systemctl stop/);
  assertOrdered(main, [
    "managed maintenance could not be quiesced before watcher pause",
    "sync worker could not be paused before live SQLite prebuild",
    "current fast result watcher could not be paused for live SQLite prebuild",
    "live SQLite prebuild capacity gate rejected the release host",
    "candidate deadline capture heartbeat refresh failed before live SQLite prebuild",
    'prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
    "candidate deadline capture heartbeat exceeded 90 seconds after live SQLite prebuild",
    "post-pressure live SQLite prebuild capacity gate rejected the release host",
    "candidate deadline capture heartbeat exceeded 110 seconds before second refresh",
    "candidate deadline capture heartbeat refresh failed after live SQLite prebuild",
    "stop_service_for_release_window || abort_before_swap \"live service could not be paused before swap\"",
    "snapshot_external_model_artifacts_for_rollback",
    'candidateReleaseContinuity.cjs" snapshot',
    "verify_live_sqlite_prebuild_after_freeze",
    "SWAP_STARTED=1",
  ], "maintenance is quiesced before service stop, sqlite snapshot and swap");
});

check("release transaction bounds the old watcher memory pause and restores the canonical service environment", () => {
  const main = mainProgram(bundleRelease);
  const writeBody = extractFunction(bundleRelease, "write_release_fast_watcher_pause_override");
  const removeBody = extractFunction(bundleRelease, "remove_release_fast_watcher_pause_override");
  const pauseBody = extractFunction(bundleRelease, "pause_current_fast_watcher_for_live_prebuild");
  const cgroupDrainBody = extractFunction(bundleRelease, "wait_for_current_service_cgroup_reclaimed");
  const pauseOverrideBody = extractFunction(bundleRelease, "assert_release_fast_watcher_pause_override");
  const pauseGuardBody = extractFunction(bundleRelease, "assert_release_fast_watcher_pause_guard");
  const restoreBody = extractFunction(bundleRelease, "restore_release_fast_watcher_after_failed_pre_swap");
  const processStateBody = extractFunction(bundleRelease, "assert_release_fast_watcher_process_state");
  const capacityBody = extractFunction(bundleRelease, "assert_live_sqlite_prebuild_capacity");
  const stopBody = extractFunction(bundleRelease, "stop_service_for_release_window");
  const restartBody = extractFunction(bundleRelease, "restart_service_if_needed");
  const preSwapRestoreBody = extractFunction(bundleRelease, "restore_pre_swap_transaction");
  const managedRestoreBody = extractFunction(bundleRelease, "restore_managed_unit_states_after_rollback");
  const rollbackBody = extractFunction(bundleRelease, "rollback");
  const exitTrapBody = extractFunction(bundleRelease, "release_exit_trap");

  assert.match(bundleRelease, /RELEASE_FAST_WATCHER_PAUSE_ENV_FILE="\/run\/football-release-fast-watcher-pause\.env"/);
  assert.match(bundleRelease, /RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR="\/run\/systemd\/system\/\$\{SERVICE_NAME\}\.service\.d"/);
  assert.match(writeBody, /EnvironmentFile=\nEnvironmentFile=\$\{RUNTIME_ENV_FILE\}\nEnvironmentFile=\$\{RELEASE_FAST_WATCHER_PAUSE_ENV_FILE\}/);
  assert.match(writeBody, /RELAY_FAST_WATCHER_ENABLED=0/);
  assert.match(writeBody, /root:football:640:1/);
  assert.match(writeBody, /root:root:644:1/);
  assert.match(writeBody, /sync -f "\$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE"/);
  assert.match(writeBody, /systemctl daemon-reload/);
  assert.match(removeBody, /rm -f -- "\$target"/);
  assert.match(removeBody, /systemctl daemon-reload/);
  assert.match(processStateBody, /\/proc\/\$\{main_pid\}\/environ/);
  assert.match(processStateBody, /grep -Fxc "RELAY_FAST_WATCHER_ENABLED=\$\{expected\}"/);
  assert.match(pauseOverrideBody, /root:football:640:1/);
  assert.match(pauseOverrideBody, /root:root:644:1/);
  assert.match(pauseOverrideBody, /RELAY_FAST_WATCHER_ENABLED=0/);
  assert.match(pauseOverrideBody, /systemctl cat "\$SERVICE_NAME"/);
  assertOrdered(pauseGuardBody, [
    "assert_release_fast_watcher_pause_override",
    "assert_release_fast_watcher_process_state 0",
    "assert_release_fast_watcher_health_state 0",
  ], "pause guard proves both the restart policy and the running watcher state");
  assert.match(cgroupDrainBody, /expected_control_group="\/system\.slice\/\$\{SERVICE_NAME\}\.service"/);
  assert.match(cgroupDrainBody, /--property=ActiveState --value/);
  assert.match(cgroupDrainBody, /cgroup\.events/);
  assert.match(cgroupDrainBody, /memory\.current/);
  assert.match(cgroupDrainBody, /populated" = "0".*memory_current" = "0"/s);
  assert.match(cgroupDrainBody, /for attempt in \$\(seq 1 150\)/);
  assert.match(cgroupDrainBody, /\[ ! -e "\$cgroup_dir" \] && \[ ! -L "\$cgroup_dir" \] && return 0/);
  assert.doesNotMatch(cgroupDrainBody, /memory\.reclaim|MemoryMax|MemoryHigh/);
  assert.match(pauseBody, /WORKER_STOPPED_FOR_SWAP/);
  assert.match(pauseBody, /release fast watcher pause refuses an active sync worker/);
  assertOrdered(pauseBody, [
    "write_release_fast_watcher_pause_override",
    "RELEASE_FAST_WATCHER_PAUSED_PROCESS=1",
    'systemctl stop "$SERVICE_NAME"',
    'systemctl is-active --quiet "$SERVICE_NAME" && return 1',
    'wait_for_current_service_cgroup_reclaimed "$old_control_group"',
    'systemctl start "$SERVICE_NAME"',
    "assert_release_fast_watcher_pause_guard",
  ], "restore is armed before stop-drain-start and remains installed during live prebuild");
  assert.doesNotMatch(pauseBody, /systemctl restart "\$SERVICE_NAME"/);
  assert.doesNotMatch(pauseBody, /remove_release_fast_watcher_pause_override/);
  assert.match(capacityBody, /assert_release_fast_watcher_pause_guard/);
  assertOrdered(stopBody, [
    'systemctl stop "$SERVICE_NAME"',
    'systemctl is-active --quiet "$SERVICE_NAME" && return 1',
    "remove_release_fast_watcher_pause_override",
  ], "Restart=always remains pinned to watcher=0 until the old service is confirmed stopped");
  assert.match(restoreBody, /remove_release_fast_watcher_pause_override/);
  assert.match(restoreBody, /RELEASE_FAST_WATCHER_PAUSED_PROCESS/);
  assert.match(restoreBody, /RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE/);
  assert.match(restoreBody, /restore_required=1/);
  assertOrdered(restoreBody, [
    "restore_required=1",
    "remove_release_fast_watcher_pause_override",
    'systemctl is-active --quiet "$SERVICE_NAME"',
    'systemctl restart "$SERVICE_NAME"',
    'systemctl start "$SERVICE_NAME"',
    "assert_release_fast_watcher_process_state 1",
    "assert_release_fast_watcher_health_state 1",
  ], "pre-swap failure restarts or starts the old service with watcher=1");
  assertOrdered(managedRestoreBody, [
    'wait_for_health "http://${HOST}:${PORT}" "pre-swap-restored-service"',
    "restore_release_fast_watcher_after_failed_pre_swap",
    'unit="football-sync-worker.service"',
  ], "original app watcher=1 is restored before the writer resumes");
  assertOrdered(preSwapRestoreBody, [
    "restore_runtime_env_after_rollback",
    "restore_managed_config_after_rollback",
    "restore_managed_unit_states_after_rollback",
    "restore_release_fast_watcher_after_failed_pre_swap",
    "restore_timer_states_after_rollback",
    "clear_release_recovery_snapshot",
  ], "pre-swap recovery restores watcher=1 before persistent timers and commits only afterward");
  assertOrdered(rollbackBody, [
    "restore_runtime_env_after_rollback",
    "restore_managed_config_after_rollback",
    "restore_managed_unit_states_after_rollback",
    "restore_timer_states_after_rollback",
    "clear_release_recovery_snapshot",
  ], "rollback delegates watcher restoration to managed unit recovery before timers and evidence cleanup");
  assertOrdered(main, [
    "quiesce_managed_maintenance_for_sqlite_snapshot",
    "stop_worker_for_release_window",
    "pause_current_fast_watcher_for_live_prebuild",
    "assert_live_sqlite_prebuild_capacity",
    "start_release_sync_write_barrier",
    "fast watcher pause guard failed after live SQLite prebuild",
    "fast watcher pause guard failed after current HTTP pressure gate",
    "post-pressure live SQLite prebuild capacity gate rejected the release host",
    "fast watcher pause guard failed before the live service stop",
    "stop_service_for_release_window",
  ], "maintenance and writer are quiesced before the old app cgroup recycle and capacity gate");
  assertOrdered(exitTrapBody, [
    "restore_pre_swap_transaction",
    'if [ "$status" -eq 0 ] && ! restore_release_fast_watcher_after_failed_pre_swap',
  ], "failed pre-swap recovery is not restarted against candidate config before exact restoration");
  assert.match(restartBody, /assert_release_fast_watcher_process_state 1/);
  assertOrdered(main, [
    'wait_for_health "http://${HOST}:${PORT}" "post-swap-service"',
    "assert_release_fast_watcher_health_state 1",
  ], "the candidate watcher is confirmed through health after the new service is ready");
  assert.match(bundleRelease, /set_env_value "\$env_file" "RELAY_FAST_WATCHER_ENABLED" "1"/);
  assert.equal((main.match(/assert_live_sqlite_prebuild_capacity/g) || []).length, 2);
  assert.match(bundleRelease, /set_env_value "\$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB" "640"/);
  assert.match(bundleRelease, /set_env_value "\$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB" "512"/);
});

check("watcher pause recycle rejects unsafe cgroups, drains fail-closed, and restores an inactive old app", () => {
  const cgroupDrainBody = extractFunction(bundleRelease, "wait_for_current_service_cgroup_reclaimed");
  const pauseBody = extractFunction(bundleRelease, "pause_current_fast_watcher_for_live_prebuild");
  const restoreBody = extractFunction(bundleRelease, "restore_release_fast_watcher_after_failed_pre_swap");
  assert.match(cgroupDrainBody, /\[ "\$control_group" = "\$expected_control_group" \] \|\|/);
  assert.match(cgroupDrainBody, /\[ ! -e "\$cgroup_dir" \] && \[ ! -L "\$cgroup_dir" \] && return 0/g);
  assert.match(cgroupDrainBody, /timed out draining service cgroup/);
  assert.match(pauseBody, /release fast watcher pause requires the sync worker to be stopped first/);
  assertOrdered(restoreBody, [
    "remove_release_fast_watcher_pause_override",
    'if systemctl is-active --quiet "$SERVICE_NAME"',
    'systemctl restart "$SERVICE_NAME"',
    "else",
    'systemctl start "$SERVICE_NAME"',
    'assert_release_fast_watcher_process_state 1',
  ], "inactive pause-start failure is recoverable after removing the override");

  if (process.platform !== "linux" || !fs.existsSync("/bin/bash")) return;
  const testRoot = `/tmp/release-watcher-cgroup-${process.pid}-${Date.now()}`;
  const adaptedCgroupDrain = cgroupDrainBody
    .replace(
      'cgroup_dir="/sys/fs/cgroup${control_group}"',
      'cgroup_dir="${TEST_CGROUP_ROOT}${control_group}"',
    )
    .replace("for attempt in $(seq 1 150)", 'for attempt in $(seq 1 "$TEST_MAX_ATTEMPTS")')
    .replace(
      '    if [ ! -d "$cgroup_dir" ] || [ -L "$cgroup_dir" ]; then',
      '    if [ "${TEST_REMOVE_BEFORE_METADATA:-0}" = "1" ]; then\n'
        + '      rm -rf -- "$cgroup_dir"\n'
        + '      TEST_REMOVE_BEFORE_METADATA=0\n'
        + '    fi\n'
        + '    if [ ! -d "$cgroup_dir" ] || [ -L "$cgroup_dir" ]; then',
    );
  assert.notEqual(adaptedCgroupDrain, cgroupDrainBody);
  const cgroupHarness = `
set -euo pipefail
TEST_CGROUP_ROOT=${JSON.stringify(testRoot)}
TEST_MAX_ATTEMPTS=2
TEST_REMOVE_BEFORE_METADATA=0
SERVICE_NAME=football-predict
MOCK_ACTIVE_STATE=inactive
log() { :; }
sleep() { :; }
systemctl() {
  [ "$1" = "show" ] || return 1
  printf '%s\\n' "$MOCK_ACTIVE_STATE"
}
wait_for_current_service_cgroup_reclaimed() {
${adaptedCgroupDrain}
}
mkdir -p -- "$TEST_CGROUP_ROOT/system.slice"
if wait_for_current_service_cgroup_reclaimed "/system.slice/untrusted.service"; then exit 11; fi
cgroup_dir="$TEST_CGROUP_ROOT/system.slice/football-predict.service"
mkdir -- "$cgroup_dir"
printf 'populated 0\\n' >"$cgroup_dir/cgroup.events"
printf '0\\n' >"$cgroup_dir/memory.current"
TEST_REMOVE_BEFORE_METADATA=1
wait_for_current_service_cgroup_reclaimed "/system.slice/football-predict.service"
test ! -e "$cgroup_dir"
mkdir -- "$cgroup_dir"
printf 'populated 1\\n' >"$cgroup_dir/cgroup.events"
printf '65536\\n' >"$cgroup_dir/memory.current"
if wait_for_current_service_cgroup_reclaimed "/system.slice/football-predict.service"; then exit 12; fi
rm -rf -- "$TEST_CGROUP_ROOT"
`;
  const cgroupResult = spawnSync("/bin/bash", ["-s"], {
    input: cgroupHarness,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(cgroupResult.status, 0, cgroupResult.stderr || cgroupResult.stdout);

  const pauseHarness = `
set -euo pipefail
SERVICE_NAME=football-predict
WORKER_SERVICE_NAME=football-sync-worker
HOST=127.0.0.1
PORT=8787
MANAGED_TIMERS=()
WORKER_STOPPED_FOR_SWAP=0
WORKER_ACTIVE=1
APP_ACTIVE=1
CURRENT_WATCHER=1
OVERRIDE_ACTIVE=0
FAIL_STARTS=0
EVENTS=""
RELEASE_FAST_WATCHER_PAUSED_PROCESS=0
RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=0
record() { EVENTS="$EVENTS,$1"; }
systemctl() {
  local action="$1"
  shift
  case "$action" in
    cat) return 0 ;;
    show)
      printf '/system.slice/football-predict.service\\n'
      ;;
    is-active)
      [ "$1" != "--quiet" ] || shift
      case "$1" in
        "$SERVICE_NAME") [ "$APP_ACTIVE" = "1" ] ;;
        "$WORKER_SERVICE_NAME") [ "$WORKER_ACTIVE" = "1" ] ;;
        *) return 1 ;;
      esac
      ;;
    stop)
      [ "$1" = "$SERVICE_NAME" ] || return 1
      record app-stop
      APP_ACTIVE=0
      CURRENT_WATCHER=-1
      ;;
    start)
      [ "$1" = "$SERVICE_NAME" ] || return 1
      if [ "$FAIL_STARTS" -gt 0 ]; then
        FAIL_STARTS=$((FAIL_STARTS - 1))
        record app-start-failed
        return 1
      fi
      record app-start
      APP_ACTIVE=1
      if [ "$OVERRIDE_ACTIVE" = "1" ]; then CURRENT_WATCHER=0; else CURRENT_WATCHER=1; fi
      ;;
    restart)
      [ "$1" = "$SERVICE_NAME" ] || return 1
      record app-restart
      APP_ACTIVE=1
      if [ "$OVERRIDE_ACTIVE" = "1" ]; then CURRENT_WATCHER=0; else CURRENT_WATCHER=1; fi
      ;;
    *) return 1 ;;
  esac
}
write_release_fast_watcher_pause_override() {
  record override-write
  OVERRIDE_ACTIVE=1
  RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=1
}
remove_release_fast_watcher_pause_override() {
  record override-remove
  OVERRIDE_ACTIVE=0
  RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=0
}
wait_for_current_service_cgroup_reclaimed() { record cgroup-drain; }
wait_for_health() { record health-wait; }
assert_release_fast_watcher_pause_guard() { [ "$APP_ACTIVE:$CURRENT_WATCHER:$OVERRIDE_ACTIVE" = "1:0:1" ]; }
assert_release_fast_watcher_process_state() { record "process-$1"; [ "$CURRENT_WATCHER" = "$1" ]; }
assert_release_fast_watcher_health_state() { record "health-$1"; [ "$CURRENT_WATCHER" = "$1" ]; }
log() { :; }
pause_current_fast_watcher_for_live_prebuild() {
${pauseBody}
}
restore_release_fast_watcher_after_failed_pre_swap() {
${restoreBody}
}
if pause_current_fast_watcher_for_live_prebuild; then exit 21; fi
test "$EVENTS" = ""
test "$APP_ACTIVE:$CURRENT_WATCHER" = "1:1"
WORKER_ACTIVE=0
WORKER_STOPPED_FOR_SWAP=1
FAIL_STARTS=1
if pause_current_fast_watcher_for_live_prebuild; then exit 22; fi
test "$APP_ACTIVE:$OVERRIDE_ACTIVE:$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "0:1:1"
restore_release_fast_watcher_after_failed_pre_swap
test "$APP_ACTIVE:$CURRENT_WATCHER:$OVERRIDE_ACTIVE:$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1:1:0:0"
test "$EVENTS" = ",override-write,app-stop,cgroup-drain,app-start-failed,override-remove,app-start,health-wait,process-1,health-1"
`;
  const pauseResult = spawnSync("/bin/bash", ["-s"], {
    input: pauseHarness,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(pauseResult.status, 0, pauseResult.stderr || pauseResult.stdout);
});

check("live SQLite prebuild creates a transient rollback snapshot and keeps the normal outage path O(1)", () => {
  const main = mainProgram(bundleRelease);
  const sqliteExporter = readText(path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs"));
  const productionCloneVerifier = readText(path.join(rootDir, "scripts", "verifyFastResultProductionClone.cjs"));
  const generationBundle = readText(path.join(rootDir, "server", "dataGenerationBundle.cjs"));
  const runBody = extractFunction(bundleRelease, "run_live_sqlite_prebuild_step");
  const prepareBody = extractFunction(bundleRelease, "prepare_live_sqlite_prebuild");
  const verifyBody = extractFunction(bundleRelease, "verify_live_sqlite_prebuild_after_freeze");
  const activateBody = extractFunction(bundleRelease, "activate_prebuilt_live_sqlite");
  const backupBody = extractFunction(bundleRelease, "backup_live_sqlite_for_rollback");
  const cleanupBody = extractFunction(bundleRelease, "cleanup_live_sqlite_prebuild");
  const registerPrebuildCleanupBody = extractFunction(
    bundleRelease,
    "register_live_sqlite_prebuild_cleanup_state",
  );
  const capacityBody = extractFunction(bundleRelease, "assert_live_sqlite_prebuild_capacity");
  const freshnessBody = extractFunction(bundleRelease, "assert_candidate_capture_heartbeat_refresh_fresh");
  const captureRefreshBody = extractFunction(bundleRelease, "refresh_candidate_capture_heartbeat_for_readiness");
  const startBarrierBody = extractFunction(bundleRelease, "start_release_sync_write_barrier");
  const stopBarrierBody = extractFunction(bundleRelease, "stop_release_sync_write_barrier");
  const barrierHealthBody = extractFunction(bundleRelease, "release_sync_write_barrier_is_healthy");
  const pointerKeeperStartBody = extractFunction(bundleRelease, "start_release_pointer_commit_keeper");
  const pointerKeeperHealthBody = extractFunction(bundleRelease, "release_pointer_commit_keeper_is_healthy");
  const pointerKeeperStopBody = extractFunction(bundleRelease, "stop_release_pointer_commit_keeper");
  const pointerKeeperCleanupBody = extractFunction(
    bundleRelease,
    "cleanup_release_pointer_commit_keeper_runtime",
  );
  const pointerKeeperHelper = extractFunctionHeredoc(
    bundleRelease,
    "write_release_pointer_commit_keeper_helper",
    "POINTER_KEEPER",
  );
  const rootBody = extractFunction(bundleRelease, "assert_recovery_root_safe");
  const validatePublicationNode = extractFunctionHeredoc(
    bundleRelease,
    "validate_prebuilt_live_sqlite_publication",
    "NODE",
  );
  const barrierHelper = readText(path.join(rootDir, "scripts", "runReleaseSyncWriteBarrier.cjs"));
  const prebuildPolicy = readText(releasePrebuildPolicyPath);
  assert.match(runBody, /--uid=root --working-directory="\$NEXT_DIR"/);
  assert.match(runBody, /ReadOnlyPaths=\$NEXT_DIR \$RUNTIME_ENV_FILE \/var\/lib\/football-release \$LIVE_STORE_DIR/);
  assert.match(runBody, /ReadWritePaths=\$LIVE_SQLITE_PREBUILD_DIR \$LIVE_STORE_DIR\/data-generations/);
  assert.match(runBody, /CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE/);
  assert.match(sqliteExporter, /SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY/);
  assert.match(productionCloneVerifier, /fast-result-production-clone-v1/);
  assert.match(productionCloneVerifier, /migrateLegacyFastResultIntegrity/);
  assert.match(productionCloneVerifier, /legacy midnight alias leaked into authority high-water/);
  assert.match(productionCloneVerifier, /repeated clone migration changed a receipt or authority root/);
  assert.match(prepareBody, /verify_production_clone_migration\(\)/);
  assertOrdered(prepareBody, [
    "run_prebuild_stage copy-rollback copy_rollback_stage",
    "run_prebuild_stage production-clone-migration verify_production_clone_migration",
    "run_prebuild_stage stage-copy stage_copy_stage",
  ], "production clone migration gate runs after the sealed copy and before SQLite export");
  assert.match(sqliteExporter, /if \(sourcePointerReadOnly && !generationInputActive\) \{/);
  assert.match(sqliteExporter, /assertActivePublicationUnchanged/);
  assert.match(sqliteExporter, /ACTIVE_GENERATION_FAST_PATH_VERSION/);
  assert.match(sqliteExporter, /`identity-mismatch:\$\{key\}`/);
  assert.match(sqliteExporter, /\["data_publication_mode", inputPublication\.identity\.mode\]/);
  assert.match(sqliteExporter, /\["data_generation_id", inputPublication\.identity\.generationId/);
  assert.match(sqliteExporter, /\["manifest_hash", inputPublication\.identity\.manifestHash/);
  assert.match(sqliteExporter, /\["data_generation_source_cycle_id", inputPublication\.identity\.sourceCycleId/);
  assert.match(sqliteExporter, /\["committed_at", inputPublication\.identity\.committedAt/);
  assert.match(sqliteExporter, /prediction-identity-version-mismatch/);
  assert.match(sqliteExporter, /warehouse-policy-mismatch/);
  assert.match(sqliteExporter, /ACTIVE_GENERATION_FAST_PATH_REQUIRED_TABLES/);
  assert.match(sqliteExporter, /required-table-missing:/);
  assert.match(sqliteExporter, /pathTargetsSameFile\(dbPath, liveDbPath\)/);
  assert.match(sqliteExporter, /activeGenerationFastPathFileMismatch\(\)/);
  assert.match(sqliteExporter, /clone-file-changed/);
  assertOrdered(sqliteExporter, [
    "const activeGenerationFastPath = inspectActiveGenerationFastPath()",
    "const loadBaseProjection = !activeGenerationFastPath.eligible",
    'const currentMatchesPayload = loadBaseProjection ? readCoreJson("matches-current.json", null) : null',
  ], "same-generation release eligibility is decided before large base JSON parsing");
  assert.match(sqliteExporter, /if \(activeGenerationFastPath\.eligible\) \{/);
  assert.match(sqliteExporter, /sqlite_export_fast_path/);
  assert.match(generationBundle, /const assertActivePublicationPointerUnchanged/);
  assert.match(sqliteExporter, /commitWithActivePublicationPointerLock\(\{/);
  assert.match(sqliteExporter, /commit: \(\) => db\.exec\("COMMIT"\)/);
  assert.match(generationBundle, /const commitWithActivePublicationPointerLock/);
  assert.match(generationBundle, /DATA_GENERATION_POINTER_CHANGED/);
  assert.match(generationBundle, /"schemaVersion",\s*"generationId",\s*"manifestHash",\s*"sourceCycleId",\s*"committedAt"/s);
  assert.match(runBody, /--property="Nice=10"/);
  assert.match(runBody, /--property="IOSchedulingPriority=4"/);
  assert.match(runBody, /--property="IOWeight=50"/);
  assert.match(runBody, /--property="MemoryHigh=768M"/);
  assert.match(runBody, /--property="MemoryMax=1024M"/);
  assert.match(runBody, /--property="MemorySwapMax=256M"/);
  assert.match(runBody, /--property="OOMPolicy=stop"/);
  assert.match(bundleRelease, /RELEASE_LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS:-120/);
  const runtimeBounds = /\[ "\$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -ge ([0-9]+) \][\s\S]*?\[ "\$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -le ([0-9]+) \]/.exec(bundleRelease);
  assert.ok(runtimeBounds, "live SQLite prebuild RuntimeMaxSec must have explicit numeric bounds");
  const runtimeMin = Number(runtimeBounds[1]);
  const runtimeMax = Number(runtimeBounds[2]);
  const runtimeAccepted = (value) => Number.isInteger(value) && value >= runtimeMin && value <= runtimeMax;
  assert.equal(runtimeAccepted(119), true);
  assert.equal(runtimeAccepted(120), true);
  assert.equal(runtimeAccepted(121), false);
  assert.equal(runtimeAccepted(59), false);
  assert.deepEqual({ runtimeMin, runtimeMax }, { runtimeMin: 60, runtimeMax: 120 });
  assert.match(prepareBody, /case "\$store_dir" in/);
  assert.match(prepareBody, /"\$sqlite_path" = "\$\{store_dir%\/\}\/football\.db"/);
  assert.match(prepareBody, /--source-base "\$sqlite_path"/);
  assert.match(prepareBody, /"\$helper_path" "\$sqlite_path" "\$stage_path"/);
  assert.match(runBody, /RuntimeMaxSec=\$\{LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS\}s/);
  assert.match(prepareBody, /WORKER_STOPPED_FOR_SWAP/);
  assert.match(prepareBody, /live SQLite prebuild refuses to overlap an active sync worker/);
  assert.match(prepareBody, /release_sync_write_barrier_is_healthy/);
  assert.match(prepareBody, /systemctl is-active --quiet "\$WORKER_SERVICE_NAME"/);
  assert.match(prepareBody, /mktemp -d \/var\/lib\/football-release\/live-sqlite-prebuild\.XXXXXX/);
  assertOrdered(prepareBody, [
    'stage_dir="$(mktemp -d /var/lib/football-release/live-sqlite-prebuild.XXXXXX)"',
    'register_live_sqlite_prebuild_cleanup_state "$stage_dir"',
    'seal_helper="${NEXT_DIR}/scripts/sqliteReleaseSeal.cjs"',
    'install -d -o root -g root -m 0700 -- "$rollback_dir"',
  ], "prebuild cleanup identity is registered before every post-mktemp fallible operation");
  assert.match(registerPrebuildCleanupBody, /LIVE_SQLITE_PREBUILD_DIR="\$stage_dir"/);
  assert.match(registerPrebuildCleanupBody, /LIVE_SQLITE_PREBUILD_DIR_DEVICE="\$device"/);
  assert.match(registerPrebuildCleanupBody, /LIVE_SQLITE_PREBUILD_DIR_INODE="\$inode"/);
  assert.match(registerPrebuildCleanupBody, /stat -c '%d:%i:%u:%g:%a:%h'/);
  assert.match(registerPrebuildCleanupBody, /"\$mode" = "700".*"\$links" = "2"/s);
  assert.match(prepareBody, /set -o noclobber/);
  assert.match(prepareBody, /sqliteReleaseSeal\.cjs/);
  assert.match(prepareBody, /copy-rollback/);
  assert.match(prepareBody, /--max-attempts 4/);
  assert.match(prepareBody, /--retry-delay-ms 250/);
  assert.match(registerPrebuildCleanupBody, /rollback-seal\.json/);
  assert.match(bundleRelease, /cp --reflink=auto --sparse=always/);
  assert.match(bundleRelease, /"\$node_bin" "\$next_dir\/scripts\/exportDataStoreSqlite\.cjs"/);
  assert.match(prepareBody, /SQLITE_VACUUM_AFTER_EXPORT=0/);
  assert.doesNotMatch(prepareBody, /SQLITE_VACUUM_AFTER_EXPORT=1/);
  assert.match(bundleRelease, /SQLITE_MAINTENANCE_WINDOW=release-stopped/);
  assert.match(bundleRelease, /SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY=1/);
  assert.match(bundleRelease, /validate_prebuilt_live_sqlite_publication/);
  assert.match(validatePublicationNode, /SELECT key, value FROM schema_meta/);
  assert.doesNotMatch(validatePublicationNode, /SELECT key, value FROM meta\b/);
  for (const stage of ["copy-rollback", "stage-copy", "export", "quick_check", "seal"]) {
    assert.match(bundleRelease, new RegExp(`run_prebuild_stage ${stage.replace("-", "\\-")}`));
  }
  assert.match(bundleRelease, /\[release-live-sqlite-prebuild\] stage=%s event=start at=%s/);
  assert.match(bundleRelease, /event=finish at=%s elapsedSeconds=%s status=%s exitCode=%s/);
  assert.match(verifyBody, /finalize-recovery/);
  assert.match(verifyBody, /verify-metadata/);
  assert.match(verifyBody, /mv -T -- "\$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" "\$\{RECOVERY_DIR\}\/sqlite"/);
  assert.match(verifyBody, /sync -f "\$RECOVERY_DIR"/);
  assert.match(verifyBody, /write_recovery_phase "sqlite-snapshotted"/);
  assert.match(verifyBody, /validate_prebuilt_live_sqlite_publication/);
  assert.doesNotMatch(verifyBody, /sha256sum|quick_check|datastore:sqlite|exportDataStoreSqlite|backup_live_sqlite_for_rollback/);
  assert.match(activateBody, /SERVICE_STOPPED_FOR_SWAP/);
  assert.match(activateBody, /WORKER_STOPPED_FOR_SWAP/);
  assert.match(activateBody, /LIVE_SQLITE_PREBUILD_STAGE_MANIFEST/);
  assert.match(activateBody, /verify-metadata/);
  assertOrdered(activateBody, [
    'verify-metadata \\',
    'rm -f -- "${LIVE_SQLITE_PATH}-wal" "${LIVE_SQLITE_PATH}-shm"',
    'mv -fT -- "$stage_path" "$LIVE_SQLITE_PATH"',
  ], "stage nanosecond seal is rechecked immediately before destructive activation");
  assert.match(activateBody, /mv -fT -- "\$stage_path" "\$LIVE_SQLITE_PATH"/);
  assert.doesNotMatch(activateBody, /sha256sum|quick_check|datastore:sqlite|exportDataStoreSqlite/);
  assert.match(backupBody, /ALLOW_STOPPED_WINDOW_SQLITE_EXPORT/);
  assert.match(backupBody, /explicit break-glass/);
  assert.match(cleanupBody, /refusing to clean unsafe live sqlite prebuild directory/);
  assert.match(cleanupBody, /rm -rf --one-file-system -- "\$stage_dir"/);
  assert.match(cleanupBody, /"\$expected_device" = "\$device".*"\$expected_inode" = "\$inode"/s);
  assert.match(cleanupBody, /"\$links" -ge 2.*"\$links" -le 3/s);
  assert.match(cleanupBody, /find "\$stage_dir" -mindepth 1 -maxdepth 1 -print -quit/);
  assert.match(rootBody, /\/var\/lib\/football-release/);
  assert.match(rootBody, /8#022/);
  assert.match(capacityBody, /WORKER_STOPPED_FOR_SWAP/);
  assert.match(capacityBody, /systemctl is-active --quiet "\$SERVICE_NAME"/);
  assert.match(capacityBody, /app-memory-current-bytes/);
  assert.match(capacityBody, /memory\.current/);
  assert.match(capacityBody, /memory\.stat/);
  assert.match(capacityBody, /inactive_file/);
  assert.match(capacityBody, /for memory_sample in 1 2/);
  assert.match(capacityBody, /sample_current > app_memory_current/);
  assert.match(capacityBody, /sample_inactive_file < app_inactive_file/);
  assert.equal((bundleRelease.match(/RELAY_FAST_WATCHER_ENABLED=0 SYNC_WORKER_EVENT_BRIDGE=0/g) || []).length, 2);
  assert.match(capacityBody, /root:football:640:1/);
  assert.match(capacityBody, /run_as_service_user_with_runtime_env/);
  assert.match(capacityBody, /policy_script="\$NEXT_DIR\/scripts\/releasePrebuildPolicy\.cjs"/);
  assert.match(capacityBody, /"\$policy_script" capacity/);
  assert.match(prebuildPolicy, /RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB/);
  assert.match(prebuildPolicy, /RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB/);
  assert.match(prebuildPolicy, /RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB/);
  assert.match(prebuildPolicy, /DEFAULT_MIN_MEM_AVAILABLE_MIB = 1152/);
  assert.match(prebuildPolicy, /DEFAULT_MAX_APP_MEMORY_CURRENT_MIB = 640/);
  assert.match(prebuildPolicy, /DEFAULT_MAX_APP_WORKING_SET_MIB = 512/);
  assert.match(captureRefreshBody, /CANDIDATE_CAPTURE_HEARTBEAT_REFRESH_SUCCESS_EPOCH_SECONDS="\$success_epoch_seconds"/);
  assert.match(freshnessBody, /policy_script="\$NEXT_DIR\/scripts\/releasePrebuildPolicy\.cjs"/);
  assert.match(freshnessBody, /"\$policy_script" freshness/);
  assert.match(freshnessBody, /--refreshed-at-epoch-seconds/);
  assert.match(bundleRelease, /readonly LIVE_SQLITE_PREBUILD_HEARTBEAT_MAX_AGE_SECONDS=90/);
  assert.match(bundleRelease, /readonly POST_PREBUILD_HTTP_HEARTBEAT_MAX_AGE_SECONDS=110/);
  assert.match(startBarrierBody, /runReleaseSyncWriteBarrier\.cjs/);
  assert.match(startBarrierBody, /--uid=football/);
  assert.match(startBarrierBody, /--lock-dir "\$lock_dir"/);
  assert.match(startBarrierBody, /--property="PrivateNetwork=yes"/);
  assert.match(startBarrierBody, /--property="RestrictAddressFamilies=AF_UNIX"/);
  assert.match(startBarrierBody, /--property="ReadWritePaths=\$locks_parent \$runtime_dir"/);
  assert.doesNotMatch(startBarrierBody, /ReadWritePaths=\$LIVE_STORE_DIR(?:\s|"|$)/);
  assertOrdered(startBarrierBody, [
    'RELEASE_SYNC_WRITE_BARRIER_RUNTIME_DIR="$runtime_dir"',
    'locks_parent="$LIVE_STORE_DIR/locks"',
    'install -d -o football -g football -m 0700 -- "$locks_parent"',
  ], "barrier runtime cleanup state is registered before fallible live lock-parent setup");
  assert.match(barrierHealthBody, /release-sync-write-barrier-v1/);
  assert.match(barrierHealthBody, /lock\?\.pid !== mainPid/);
  assert.match(stopBarrierBody, /release_sync_write_barrier_is_healthy/);
  assert.match(stopBarrierBody, /stop_service_for_release_window/);
  assert.match(stopBarrierBody, /cleanup_release_sync_write_barrier_owned_lock/);
  assert.match(stopBarrierBody, /\[ ! -e "\$lock_dir" \]/);
  assert.match(barrierHelper, /require\("\.\.\/server\/syncLock\.cjs"\)/);
  assert.match(barrierHelper, /await acquireSyncLock/);
  assert.match(barrierHelper, /current\.pid === expected\.pid/);
  assert.match(barrierHelper, /await lock\.release\(\)/);
  assert.match(barrierHelper, /cleanupDeadOwnedLock/);
  assert.match(barrierHelper, /foreign-lock/);
  assert.match(bundleRelease, /abort before swap:[^]*stop_release_sync_write_barrier/);
  assert.match(bundleRelease, /release_exit_trap\(\)[^]*stop_release_sync_write_barrier/);
  assert.match(pointerKeeperHelper, /acquirePointerCommitLock/);
  assert.match(pointerKeeperHelper, /storePaths\(storeDir\)/);
  assert.match(pointerKeeperHelper, /release-pointer-commit-keeper-v1/);
  assert.match(pointerKeeperHelper, /recover-dead-owner-identity/);
  assert.match(pointerKeeperHelper, /canonicalLockOwner/);
  assert.match(pointerKeeperHelper, /ownerTokenPattern/);
  assert.match(pointerKeeperHelper, /owner\.hostname !== os\.hostname\(\)/);
  assert.match(pointerKeeperHelper, /processAlive\(expectedPid\)/);
  assert.match(pointerKeeperHelper, /cleanup-dead-owned/);
  assert.match(pointerKeeperHelper, /ownerMatches\((?:owner|initial\.owner), expectedPid, expectedToken\)/);
  assert.match(pointerKeeperHelper, /processAlive\(expectedPid\)/);
  const pointerDeadCleanupStart = pointerKeeperHelper.indexOf("const runCleanupDeadOwned = () => {");
  const pointerDeadCleanupEnd = pointerKeeperHelper.indexOf("\n\ntry {", pointerDeadCleanupStart);
  assert.ok(pointerDeadCleanupStart >= 0 && pointerDeadCleanupEnd > pointerDeadCleanupStart);
  const pointerDeadCleanupBody = pointerKeeperHelper.slice(pointerDeadCleanupStart, pointerDeadCleanupEnd);
  assert.doesNotMatch(pointerDeadCleanupBody, /acquirePointerCommitLock/);
  assertOrdered(pointerDeadCleanupBody, [
    "const initial = canonicalLockEvidence()",
    "fs.renameSync(ownerPath, claimPath)",
    "claimed = lockEvidence(paths.pointerLockDir, claimName)",
    "fs.renameSync(paths.pointerLockDir, quarantinePath)",
    "const quarantined = lockEvidence(quarantinePath, claimName)",
    "fs.unlinkSync(quarantined.ownerPath)",
    "fs.rmdirSync(quarantinePath)",
  ], "dead pointer owner cleanup claims exact metadata before inode quarantine");
  assert.match(pointerKeeperStartBody, /WORKER_STOPPED_FOR_SWAP/);
  assert.match(pointerKeeperStartBody, /release_sync_write_barrier_is_healthy/);
  assert.match(pointerKeeperStartBody, /systemctl is-active --quiet "\$SERVICE_NAME"/);
  assert.doesNotMatch(pointerKeeperStartBody, /SERVICE_STOPPED_FOR_SWAP/);
  assert.match(pointerKeeperStartBody, /\/run\/football-release-pointer-lock\.XXXXXX/);
  assert.match(pointerKeeperStartBody, /install -d -o football -g football -m 0700 -- "\$control_dir"/);
  assert.match(pointerKeeperStartBody, /dataGenerationStore\.cjs" "\$module_file"/);
  assert.match(pointerKeeperStartBody, /root:football:440:1/);
  assert.match(pointerKeeperStartBody, /sha256sum "\$TRUSTED_SOURCE_DIR\/server\/dataGenerationStore\.cjs"/);
  assert.match(pointerKeeperStartBody, /sha256sum "\$module_file"/);
  assert.match(pointerKeeperStartBody, /runuser -u football -- "\$NODE_HOME\/bin\/node"/);
  assert.match(pointerKeeperStartBody, /runtimeModule\.acquirePointerCommitLock/);
  assert.match(pointerKeeperStartBody, /--working-directory="\$runtime_dir"/);
  assert.match(pointerKeeperStartBody, /ReadOnlyPaths=\$runtime_dir/);
  assert.match(pointerKeeperStartBody, /ReadWritePaths=\$generation_root \$control_dir/);
  assert.doesNotMatch(pointerKeeperStartBody, /ReadWritePaths=\$generation_root \$runtime_dir/);
  assert.doesNotMatch(pointerKeeperStartBody, /--working-directory="\$TRUSTED_SOURCE_DIR"/);
  assert.doesNotMatch(pointerKeeperStartBody, /--module "\$TRUSTED_SOURCE_DIR/);
  assert.match(pointerKeeperStartBody, /PrivateNetwork=yes/);
  assert.match(pointerKeeperStartBody, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(pointerKeeperStartBody, /RuntimeMaxSec=120s/);
  assert.match(pointerKeeperHealthBody, /"\$helper_file" verify/);
  assert.match(pointerKeeperStopBody, /cleanup-dead-owned/);
  assert.match(pointerKeeperStopBody, /ExecMainPID/);
  assert.match(pointerKeeperStopBody, /recover-dead-owner-identity/);
  assert.match(pointerKeeperStopBody, /verify-released/);
  assert.doesNotMatch(pointerKeeperStopBody, /\[ ! -e "\$lock_dir" \]/);
  assertOrdered(pointerKeeperStopBody, [
    'assert_transient_unit_cleared "$unit" || return 1',
    "recover-dead-owner-identity",
    "cleanup-dead-owned",
  ], "no-control owner recovery waits for unit death before exact dead-owner cleanup");
  assert.match(pointerKeeperCleanupBody, /RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE/);
  assert.match(pointerKeeperCleanupBody, /RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE/);
  assert.match(pointerKeeperCleanupBody, /root:root:600:1\|root:football:600:1\|root:football:550:1/);
  assert.match(pointerKeeperCleanupBody, /root:root:600:1\|root:football:600:1\|root:football:440:1/);
  assert.match(pointerKeeperCleanupBody, /football:football:700:2/);
  assertOrdered(main, [
    "candidate deadline capture heartbeat refresh failed after live SQLite prebuild",
    "start_release_pointer_commit_keeper",
    'stop_service_for_release_window || abort_before_swap "live service could not be paused before swap"',
    "stop_release_sync_write_barrier clean",
    "verify_live_sqlite_prebuild_after_freeze",
    "generation pointer-commit keeper failed immediately before app swap",
    "SWAP_STARTED=1",
    'mv "$APP_DIR" "$BACKUP_DIR"',
    'mv "$NEXT_DIR" "$APP_DIR"',
    "generation pointer-commit keeper failed before prebuilt SQLite activation",
    "activate_prebuilt_live_sqlite",
    "stop_release_pointer_commit_keeper clean",
    "restart_service_if_needed",
  ], "canonical pointer lock overlaps sync barrier and spans final CAS, tree swap, and SQLite activation");
  const abortBody = extractFunction(bundleRelease, "abort_before_swap");
  const rollbackBody = extractFunction(bundleRelease, "rollback");
  const exitTrapBody = extractFunction(bundleRelease, "release_exit_trap");
  assert.match(abortBody, /stop_release_pointer_commit_keeper/);
  assert.match(rollbackBody, /stop_release_pointer_commit_keeper/);
  assert.match(exitTrapBody, /stop_release_pointer_commit_keeper/);
  assertOrdered(main, [
    "sync worker could not be paused for candidate readiness",
    "sync worker could not resume during isolated candidate verification",
    "run_trusted_candidate_verifier",
    "managed maintenance could not be quiesced before watcher pause",
    "sync worker could not be paused before live SQLite prebuild",
    "current fast result watcher could not be paused for live SQLite prebuild",
    "live SQLite prebuild capacity gate rejected the release host",
    "candidate deadline capture heartbeat refresh failed before live SQLite prebuild",
    "canonical live sync write barrier could not be acquired before sqlite snapshot",
    'prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
    "candidate deadline capture heartbeat exceeded 90 seconds after live SQLite prebuild",
    "current HTTP pressure gate failed after live SQLite prebuild",
    "candidate deadline capture heartbeat exceeded 110 seconds before second refresh",
    "candidate deadline capture heartbeat refresh failed after live SQLite prebuild",
    'stop_service_for_release_window || abort_before_swap "live service could not be paused before swap"',
    "canonical live sync write barrier did not drain cleanly after service stop",
    "verify_live_sqlite_prebuild_after_freeze",
    "SWAP_STARTED=1",
    "sync_model_artifact_mirrors",
    "activate_prebuilt_live_sqlite",
    "verify_store_write_permissions",
    "restart_service_if_needed",
  ], "prebuild is prepared online, CAS-checked against the frozen rollback image, then activated");
  const readinessWorkerStop = main.indexOf("sync worker could not be paused for candidate readiness");
  const boundedWorkerStop = main.indexOf("sync worker could not be paused before live SQLite prebuild");
  const prebuildStart = main.indexOf('prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"');
  assert.ok(readinessWorkerStop >= 0 && boundedWorkerStop > readinessWorkerStop && prebuildStart > boundedWorkerStop);
  assert.equal(
    main.slice(readinessWorkerStop, boundedWorkerStop).includes("restart_worker_if_needed"),
    true,
    "the live worker must resume during isolated candidate verification",
  );
  assert.equal(
    main.slice(boundedWorkerStop, prebuildStart).includes("restart_worker_if_needed"),
    false,
    "heavy SQLite prebuild must not overlap a restarted sync worker",
  );
  const prebuildFailure = main.indexOf("live SQLite prebuild failed before service stop; refusing a long stopped-window export");
  const serviceStop = main.indexOf('stop_service_for_release_window || abort_before_swap "live service could not be paused before swap"');
  const normalSealCas = main.indexOf("verify_live_sqlite_prebuild_after_freeze", serviceStop);
  assert.ok(prebuildFailure >= 0 && prebuildFailure < serviceStop);
  assert.ok(serviceStop >= 0 && normalSealCas > serviceStop);
  assert.doesNotMatch(
    main.slice(serviceStop, normalSealCas),
    /backup_live_sqlite_for_rollback|sha256sum|quick_check|datastore:sqlite|exportDataStoreSqlite/,
    "normal outage plan must reach O(1) seal CAS without a large file operation",
  );
  assert.match(main, /ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" != "1"[\s\S]*?abort_before_swap "live SQLite prebuild failed before service stop/);
  assert.match(main, /post-live-sqlite-prebuild/);
  assert.match(main, /PERF_REQUESTS=12 PERF_CONCURRENCY=3/);
  assert.match(main, /post-freeze SQLite seal CAS rejected the prebuild; restart without swapping/);
  assert.match(main, /BREAK-GLASS:[^\n]*stopped-window snapshot\/export/);
  assert.equal(countLiteral(main, 'backup_live_sqlite_for_rollback "$LIVE_SQLITE_PATH"'), 2);
  assert.match(main, /else[\s\S]*ALLOW_STOPPED_WINDOW_SQLITE_EXPORT[\s\S]*refresh_live_store_after_swap[\s\S]*post-swap live store refresh failed/);
});

check("prebuilt SQLite publication validation reads the canonical schema_meta table", () => {
  const validateNode = extractFunctionHeredoc(
    bundleRelease,
    "validate_prebuilt_live_sqlite_publication",
    "NODE",
  );
  const queryMatch = /const rows = db\.prepare\(`([\s\S]*?)`\)\.all\(\);/.exec(validateNode);
  assert.ok(queryMatch, "prebuilt publication metadata query must be extractable");
  assert.match(queryMatch[1], /FROM schema_meta\b/);
  assert.doesNotMatch(queryMatch[1], /FROM meta\b/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prebuild-publication-"));
  const dbPath = path.join(tempRoot, "football.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_meta (key, value, updated_at) VALUES
        ('data_publication_mode', 'active-generation', '2026-08-02T00:00:00.000Z'),
        ('data_generation_id', 'generation@test', '2026-08-02T00:00:00.000Z'),
        ('manifest_hash', '${"a".repeat(64)}', '2026-08-02T00:00:00.000Z'),
        ('data_generation_source_cycle_id', 'cycle@test', '2026-08-02T00:00:00.000Z'),
        ('committed_at', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
    `);
    const rows = db.prepare(queryMatch[1]).all();
    const actual = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    assert.deepEqual(actual, {
      data_publication_mode: "active-generation",
      data_generation_id: "generation@test",
      manifest_hash: "a".repeat(64),
      data_generation_source_cycle_id: "cycle@test",
      committed_at: "2026-08-02T00:00:00.000Z",
    });
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("post-freeze publication validation is pointer-only and rejects every sealed identity drift", () => {
  const validatorSource = extractFunctionHeredoc(
    bundleRelease,
    "validate_prebuilt_live_sqlite_publication",
    "NODE",
  );
  assert.doesNotMatch(
    validatorSource.slice(validatorSource.indexOf('} else {')),
    /resolveActivePublication|validateGenerationBundle/,
    "the pointer-only branch must not reference the full generation resolver",
  );
  assert.match(validatorSource, /observeStableRegularFileMetadata\(sqlitePath\)/);
  assert.doesNotMatch(
    validatorSource,
    /openStableRegularFile\(sqlitePath\)/,
    "neither validation mode may stream and hash the large SQLite file",
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-freeze-publication-"));
  const validatorPath = path.join(tempRoot, "validator.cjs");
  const readGuardPath = path.join(tempRoot, "reject-sqlite-read.cjs");
  fs.writeFileSync(validatorPath, validatorSource);
  fs.writeFileSync(readGuardPath, String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const blocked = path.resolve(process.env.REJECT_READ_FILE);
    const original = fs.readFileSync;
    fs.readFileSync = function guardedReadFileSync(target, ...args) {
      if (typeof target === "string" && path.resolve(target) === blocked) {
        throw new Error("pointer-only validator attempted to read the full SQLite file");
      }
      return original.call(this, target, ...args);
    };
  `);
  const syntax = spawnSync(process.execPath, ["--check", validatorPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  let sequence = 0;
  const buildFixture = () => {
    sequence += 1;
    const root = path.join(tempRoot, `fixture-${sequence}`);
    const moduleRoot = path.join(root, "module");
    const storeDir = path.join(root, "store");
    const publicDataDir = path.join(root, "public-data");
    const stageDir = path.join(root, "stage");
    const moduleServerDir = path.join(moduleRoot, "server");
    const generationHash = crypto.createHash("sha256").update(`generation-${sequence}`).digest("hex");
    const generationId = `g-${generationHash}`;
    const manifestHash = generationHash;
    const sourceCycleId = `cycle-${sequence}`;
    const committedAt = `2026-08-02T00:00:0${sequence}.000Z`;
    const generationDir = path.join(
      storeDir,
      "data-generations",
      "generations",
      generationId,
    );
    const pointerPath = path.join(storeDir, "data-generations", "current.json");
    const payloadPath = path.join(generationDir, "matches-current.json");
    const sqlitePath = path.join(stageDir, "football.db");
    const stageSealPath = path.join(stageDir, "stage-seal.json");
    const publicationSealPath = path.join(stageDir, "publication-seal.json");
    fs.mkdirSync(moduleServerDir, { recursive: true });
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(publicDataDir, { recursive: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const payloadBytes = Buffer.from(`${JSON.stringify({ matches: [{ id: sequence }] })}\n`);
    fs.writeFileSync(payloadPath, payloadBytes);
    const payloadHash = crypto.createHash("sha256").update(payloadBytes).digest("hex");
    const manifest = {
      schemaVersion: 1,
      sourceCycleId,
      coreFiles: ["matches-current.json"],
      files: [{
        path: "matches-current.json",
        sha256: payloadHash,
        bytes: payloadBytes.length,
        rows: 1,
        core: true,
      }],
      generationId,
      manifestHash,
    };
    fs.writeFileSync(path.join(generationDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const pointer = {
      schemaVersion: 1,
      generationId,
      sourceCycleId,
      manifestHash,
      committedAt,
    };
    fs.writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    const identity = {
      version: "immutable-base-generation-v1",
      mode: "active-generation",
      generationId,
      manifestHash,
      sourceCycleId,
      committedAt,
      active: true,
    };
    const resolverModule = `module.exports.resolveActivePublication = () => (${JSON.stringify({
      mode: "active-generation",
      context: { generationDir, manifest, pointer },
      publicDataDir,
      identity,
    })});\n`;
    const resolverPath = path.join(moduleServerDir, "dataGenerationBundle.cjs");
    fs.writeFileSync(resolverPath, resolverModule);
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const insert = db.prepare("INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)");
      for (const [key, value] of [
        ["data_publication_mode", "active-generation"],
        ["data_generation_id", generationId],
        ["manifest_hash", manifestHash],
        ["data_generation_source_cycle_id", sourceCycleId],
        ["committed_at", committedAt],
      ]) insert.run(key, value, committedAt);
    } finally {
      db.close();
    }
    fs.writeFileSync(stageSealPath, `${JSON.stringify(captureSeal(sqlitePath), null, 2)}\n`);
    const args = [
      moduleRoot,
      storeDir,
      publicDataDir,
      sqlitePath,
      "0",
      "full-capture",
      publicationSealPath,
      stageSealPath,
    ];
    const captured = spawnSync(process.execPath, [validatorPath, ...args], { encoding: "utf8" });
    assert.equal(captured.status, 0, captured.stderr || captured.stdout);
    fs.writeFileSync(
      resolverPath,
      'throw new Error("full resolver must not run during pointer-only freeze validation");\n',
    );
    return {
      args,
      committedAt,
      payloadPath,
      pointer,
      pointerPath,
      resolverPath,
      sqlitePath,
    };
  };
  const runPointerOnly = (fixture) => {
    const args = [...fixture.args];
    args[5] = "pointer-only";
    return spawnSync(process.execPath, [validatorPath, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${readGuardPath}`,
        REJECT_READ_FILE: fixture.sqlitePath,
      },
    });
  };

  try {
    const unchanged = buildFixture();
    const accepted = runPointerOnly(unchanged);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    const generationDrift = buildFixture();
    const payloadStat = fs.statSync(generationDrift.payloadPath);
    fs.utimesSync(
      generationDrift.payloadPath,
      payloadStat.atime,
      new Date(payloadStat.mtimeMs + 10_000),
    );
    const generationRejected = runPointerOnly(generationDrift);
    assert.notEqual(generationRejected.status, 0, "generation metadata drift must fail closed");

    const generationFileSetDrift = buildFixture();
    fs.writeFileSync(
      path.join(path.dirname(generationFileSetDrift.payloadPath), "unexpected.json"),
      "{}\n",
    );
    const generationFileSetRejected = runPointerOnly(generationFileSetDrift);
    assert.notEqual(
      generationFileSetRejected.status,
      0,
      "an extra generation file must fail the exact-set seal",
    );

    const pointerDrift = buildFixture();
    fs.writeFileSync(pointerDrift.pointerPath, `${JSON.stringify({
      ...pointerDrift.pointer,
      sourceCycleId: "drifted-cycle",
    }, null, 2)}\n`);
    const pointerRejected = runPointerOnly(pointerDrift);
    assert.notEqual(pointerRejected.status, 0, "pointer drift must fail closed");

    const sqliteMetaDrift = buildFixture();
    const driftDb = new DatabaseSync(sqliteMetaDrift.sqlitePath);
    try {
      driftDb.prepare("UPDATE schema_meta SET value = ? WHERE key = 'committed_at'")
        .run("2026-08-02T23:59:59.000Z");
    } finally {
      driftDb.close();
    }
    const sqliteMetaRejected = runPointerOnly(sqliteMetaDrift);
    assert.notEqual(sqliteMetaRejected.status, 0, "SQLite publication metadata drift must fail closed");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("release pointer-commit keeper blocks concurrent rotation and cleans graceful and crashed owners", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-pointer-keeper-"));
  try {
    const helperPath = path.join(tempRoot, "keeper.cjs");
    const helperSource = extractFunctionHeredoc(
      bundleRelease,
      "write_release_pointer_commit_keeper_helper",
      "POINTER_KEEPER",
    );
    fs.writeFileSync(helperPath, helperSource);
    const syntax = spawnSync(process.execPath, ["--check", helperPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

    const harness = String.raw`
      "use strict";
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const path = require("node:path");
      const { spawn, spawnSync } = require("node:child_process");
      const helperPath = ${JSON.stringify(helperPath)};
      const modulePath = ${JSON.stringify(path.join(rootDir, "server", "dataGenerationStore.cjs"))};
      const root = ${JSON.stringify(tempRoot)};
      const { acquirePointerCommitLock, storePaths } = require(modulePath);
      const waitUntil = async (predicate, label, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try { if (predicate()) return; } catch { /* wait for atomic publication */ }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
      };
      const waitForExit = (child) => new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const startKeeper = async (name) => {
        const storeDir = path.join(root, "store");
        const controlDir = path.join(root, name);
        const controlFile = path.join(controlDir, "keeper-status.json");
        const stopFile = path.join(controlDir, "stop");
        fs.mkdirSync(storePaths(storeDir).root, { recursive: true });
        fs.mkdirSync(controlDir, { recursive: true });
        const child = spawn(process.execPath, [
          helperPath, "hold", "--module", modulePath, "--store-dir", storeDir,
          "--control-file", controlFile, "--instance-id", name,
          "--wait-ms", "1000", "--stop-file", stopFile,
        ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const exit = waitForExit(child);
        await waitUntil(() => JSON.parse(fs.readFileSync(controlFile, "utf8")).state === "HELD", name);
        return { child, exit, stderr: () => stderr, storeDir, controlFile, stopFile };
      };
      const makeDeadLock = async (lockDir, label) => {
        const child = spawn(process.execPath, ["-e", [
          'const { acquirePointerCommitLock } = require(process.argv[1]);',
          'acquirePointerCommitLock({ lockDir: process.argv[2], timeoutMs: 1000 });',
          'setInterval(() => {}, 1000);',
        ].join("\n"), modulePath, lockDir], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const exit = waitForExit(child);
        const ownerPath = path.join(lockDir, "owner.json");
        let owner = null;
        await waitUntil(() => {
          if (!fs.existsSync(ownerPath)) return false;
          const candidate = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          if (candidate?.pid !== child.pid || typeof candidate?.token !== "string") return false;
          owner = candidate;
          return true;
        }, label + " complete owner publication");
        child.kill("SIGKILL");
        await exit;
        assert.equal(owner.pid, child.pid, stderr);
        return owner;
      };
      const cleanupHookPath = path.join(root, "pointer-cleanup-race-hook.cjs");
      fs.writeFileSync(cleanupHookPath, [
        '"use strict";',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const originalRename = fs.renameSync.bind(fs);',
        'const pause = () => {',
        '  fs.writeFileSync(process.env.POINTER_KEEPER_RACE_READY, "ready\\n");',
        '  const sleeper = new Int32Array(new SharedArrayBuffer(4));',
        '  const deadline = Date.now() + 10000;',
        '  while (!fs.existsSync(process.env.POINTER_KEEPER_RACE_RELEASE)) {',
        '    if (Date.now() >= deadline) throw new Error("cleanup race hook timed out");',
        '    Atomics.wait(sleeper, 0, 0, 20);',
        '  }',
        '};',
        'fs.renameSync = (source, destination) => {',
        '  const mode = process.env.POINTER_KEEPER_RACE_MODE;',
        '  const sourceName = path.basename(String(source));',
        '  const destinationName = path.basename(String(destination));',
        '  if (mode === "before-owner-claim" && sourceName === "owner.json"',
        '    && destinationName.startsWith(".owner.release-claim.")) pause();',
        '  if (mode === "throw-before-lock-quarantine" && sourceName === ".pointer-commit.lock"',
        '    && destinationName.startsWith(".pointer-commit.lock.release-quarantine.")) {',
        '    throw new Error("injected pointer quarantine rename failure");',
        '  }',
        '  const result = originalRename(source, destination);',
        '  if (mode === "after-lock-quarantine" && sourceName === ".pointer-commit.lock"',
        '    && destinationName.startsWith(".pointer-commit.lock.release-quarantine.")) pause();',
        '  return result;',
        '};',
      ].join("\n"));
      (async () => {
        const graceful = await startKeeper("graceful");
        const paths = storePaths(graceful.storeDir);
        assert.throws(
          () => acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100, staleMs: 60_000 }),
          (error) => error?.code === "POINTER_LOCK_TIMEOUT",
          "a concurrent pointer rotation must remain blocked while the keeper is HELD",
        );
        fs.writeFileSync(graceful.stopFile, "stop\n");
        const gracefulExit = await graceful.exit;
        assert.equal(gracefulExit.code, 0, graceful.stderr());
        assert.equal(JSON.parse(fs.readFileSync(graceful.controlFile, "utf8")).state, "RELEASED");
        assert.equal(fs.existsSync(paths.pointerLockDir), false);
        const afterGraceful = acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100 });
        const gracefulControl = JSON.parse(fs.readFileSync(graceful.controlFile, "utf8"));
        const successorAccepted = spawnSync(process.execPath, [
          helperPath, "verify-released", "--module", modulePath,
          "--store-dir", graceful.storeDir, "--control-file", graceful.controlFile,
          "--instance-id", "graceful", "--expected-pid", String(gracefulControl.pid),
          "--expected-token", gracefulControl.ownerToken,
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(successorAccepted.status, 0, successorAccepted.stderr || successorAccepted.stdout);
        assert.equal(fs.existsSync(paths.pointerLockDir), true, "a successor pointer writer must be preserved");
        afterGraceful.release();

        const noControlDir = path.join(root, "no-control");
        const noControlFile = path.join(noControlDir, "keeper-status.json");
        const noControlMarker = path.join(noControlDir, "acquired.marker");
        const raceModulePath = path.join(root, "race-data-generation-store.cjs");
        fs.mkdirSync(noControlDir, { recursive: true });
        fs.writeFileSync(raceModulePath, [
          '"use strict";',
          'const fs = require("node:fs");',
          'const actual = require(' + JSON.stringify(modulePath) + ');',
          'module.exports = { ...actual, acquirePointerCommitLock(options) {',
          '  const handle = actual.acquirePointerCommitLock(options);',
          '  fs.writeFileSync(process.env.POINTER_KEEPER_TEST_ACQUIRED_FILE, "acquired\\n");',
          '  const sleeper = new Int32Array(new SharedArrayBuffer(4));',
          '  while (true) Atomics.wait(sleeper, 0, 0, 1000);',
          '  return handle;',
          '} };',
        ].join("\n"));
        const noControlChild = spawn(process.execPath, [
          helperPath, "hold", "--module", raceModulePath, "--store-dir", graceful.storeDir,
          "--control-file", noControlFile, "--instance-id", "no-control", "--wait-ms", "1000",
        ], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, POINTER_KEEPER_TEST_ACQUIRED_FILE: noControlMarker },
        });
        let noControlStderr = "";
        noControlChild.stderr.on("data", (chunk) => { noControlStderr += chunk; });
        const noControlExit = waitForExit(noControlChild);
        await waitUntil(() => fs.existsSync(noControlMarker), "post-acquire pre-control marker");
        assert.equal(fs.existsSync(noControlFile), false, "the regression must kill before HELD publication");
        const noControlOwner = JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8"));
        assert.equal(noControlOwner.pid, noControlChild.pid);
        noControlChild.kill("SIGKILL");
        await noControlExit;
        const recovered = spawnSync(process.execPath, [
          helperPath, "recover-dead-owner-identity", "--module", modulePath,
          "--store-dir", graceful.storeDir, "--control-file", noControlFile,
          "--expected-pid", String(noControlChild.pid),
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(recovered.status, 0, recovered.stderr || noControlStderr || recovered.stdout);
        assert.equal(recovered.stdout, String(noControlChild.pid) + "\t" + noControlOwner.token);
        const preparedSuccessorPath = path.join(paths.root, ".prepared-dead-successor");
        const parkedOriginalPath = path.join(paths.root, ".parked-original-lock");
        const preparedSuccessorOwner = await makeDeadLock(preparedSuccessorPath, "prepared dead successor");
        const beforeClaimReady = path.join(noControlDir, "before-claim.ready");
        const beforeClaimRelease = path.join(noControlDir, "before-claim.release");
        const beforeClaimCleanup = spawn(process.execPath, ["--require", cleanupHookPath,
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", graceful.storeDir,
          "--expected-pid", String(noControlChild.pid), "--expected-token", noControlOwner.token,
        ], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            POINTER_KEEPER_RACE_MODE: "before-owner-claim",
            POINTER_KEEPER_RACE_READY: beforeClaimReady,
            POINTER_KEEPER_RACE_RELEASE: beforeClaimRelease,
          },
        });
        let beforeClaimStderr = "";
        beforeClaimCleanup.stderr.on("data", (chunk) => { beforeClaimStderr += chunk; });
        const beforeClaimExit = waitForExit(beforeClaimCleanup);
        await waitUntil(() => fs.existsSync(beforeClaimReady), "cleanup pre-claim race hook");
        fs.renameSync(paths.pointerLockDir, parkedOriginalPath);
        fs.renameSync(preparedSuccessorPath, paths.pointerLockDir);
        fs.writeFileSync(beforeClaimRelease, "release\n");
        const beforeClaimResult = await beforeClaimExit;
        assert.equal(beforeClaimResult.code, 3, beforeClaimStderr);
        assert.deepEqual(fs.readdirSync(paths.pointerLockDir), ["owner.json"]);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8")).token,
          preparedSuccessorOwner.token,
          "a dead successor swapped after validation must be restored and preserved",
        );
        fs.renameSync(paths.pointerLockDir, preparedSuccessorPath);
        fs.renameSync(parkedOriginalPath, paths.pointerLockDir);
        fs.rmSync(preparedSuccessorPath, { recursive: true, force: true });

        const noControlCleanup = spawnSync(process.execPath, [
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", graceful.storeDir,
          "--expected-pid", String(noControlChild.pid), "--expected-token", noControlOwner.token,
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(noControlCleanup.status, 0, noControlCleanup.stderr || noControlCleanup.stdout);
        assert.equal(fs.existsSync(paths.pointerLockDir), false, "no-control dead owner must be reclaimed");

        const failedQuarantineOwner = await makeDeadLock(paths.pointerLockDir, "failed quarantine original");
        const failedQuarantine = spawnSync(process.execPath, ["--require", cleanupHookPath,
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", graceful.storeDir,
          "--expected-pid", String(failedQuarantineOwner.pid),
          "--expected-token", failedQuarantineOwner.token,
        ], {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, POINTER_KEEPER_RACE_MODE: "throw-before-lock-quarantine" },
        });
        assert.equal(failedQuarantine.status, 1, failedQuarantine.stderr || failedQuarantine.stdout);
        assert.deepEqual(fs.readdirSync(paths.pointerLockDir), ["owner.json"]);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8")).token,
          failedQuarantineOwner.token,
          "failed directory quarantine must restore the exact dead owner",
        );
        assert.equal(
          fs.readdirSync(paths.root).some((entry) => entry.startsWith(".owner.release-claim.")),
          false,
          "failed directory quarantine must not leave a claim in canonical",
        );
        const failedQuarantineCleanup = spawnSync(process.execPath, [
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", graceful.storeDir,
          "--expected-pid", String(failedQuarantineOwner.pid),
          "--expected-token", failedQuarantineOwner.token,
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(
          failedQuarantineCleanup.status,
          0,
          failedQuarantineCleanup.stderr || failedQuarantineCleanup.stdout,
        );

        const liveNoControlOwner = acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100 });
        const foreignNoControl = spawnSync(process.execPath, [
          helperPath, "recover-dead-owner-identity", "--module", modulePath,
          "--store-dir", graceful.storeDir, "--control-file", noControlFile,
          "--expected-pid", String(process.pid),
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(foreignNoControl.status, 3, foreignNoControl.stderr || foreignNoControl.stdout);
        assert.equal(fs.existsSync(paths.pointerLockDir), true, "live no-control owner must be preserved");
        liveNoControlOwner.release();

        const postQuarantineOwner = await makeDeadLock(paths.pointerLockDir, "post-quarantine original");
        const postQuarantineReady = path.join(noControlDir, "post-quarantine.ready");
        const postQuarantineRelease = path.join(noControlDir, "post-quarantine.release");
        const postQuarantineCleanup = spawn(process.execPath, ["--require", cleanupHookPath,
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", graceful.storeDir,
          "--expected-pid", String(postQuarantineOwner.pid), "--expected-token", postQuarantineOwner.token,
        ], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            POINTER_KEEPER_RACE_MODE: "after-lock-quarantine",
            POINTER_KEEPER_RACE_READY: postQuarantineReady,
            POINTER_KEEPER_RACE_RELEASE: postQuarantineRelease,
          },
        });
        let postQuarantineStderr = "";
        postQuarantineCleanup.stderr.on("data", (chunk) => { postQuarantineStderr += chunk; });
        const postQuarantineExit = waitForExit(postQuarantineCleanup);
        await waitUntil(() => fs.existsSync(postQuarantineReady), "post-quarantine successor hook");
        assert.equal(fs.existsSync(paths.pointerLockDir), false, "exact old inode must already be quarantined");
        const postQuarantineSuccessor = acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100 });
        fs.writeFileSync(postQuarantineRelease, "release\n");
        const postQuarantineResult = await postQuarantineExit;
        assert.equal(postQuarantineResult.code, 0, postQuarantineStderr);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8")).token,
          postQuarantineSuccessor.owner.token,
          "a successor acquired after quarantine must remain canonical",
        );
        postQuarantineSuccessor.release();

        fs.rmSync(graceful.controlFile, { force: true });
        fs.rmSync(graceful.stopFile, { force: true });
        const crashed = await startKeeper("crashed");
        const crashedControl = JSON.parse(fs.readFileSync(crashed.controlFile, "utf8"));
        crashed.child.kill("SIGKILL");
        await crashed.exit;
        assert.equal(fs.existsSync(paths.pointerLockDir), true, "SIGKILL must leave exact ownership evidence");
        const cleanup = spawnSync(process.execPath, [
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", crashed.storeDir,
          "--expected-pid", String(crashedControl.pid),
          "--expected-token", crashedControl.ownerToken,
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
        assert.equal(fs.existsSync(paths.pointerLockDir), false);

        const foreign = acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100 });
        const blockedDir = path.join(root, "blocked");
        const blockedControl = path.join(blockedDir, "keeper-status.json");
        fs.mkdirSync(blockedDir, { recursive: true });
        const blocked = spawn(process.execPath, [
          helperPath, "hold", "--module", modulePath, "--store-dir", crashed.storeDir,
          "--control-file", blockedControl, "--instance-id", "blocked", "--wait-ms", "100",
        ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const blockedPid = blocked.pid;
        const blockedExit = await waitForExit(blocked);
        assert.equal(blockedExit.code, 1);
        const blockedStatus = JSON.parse(fs.readFileSync(blockedControl, "utf8"));
        assert.equal(blockedStatus.state, "FAILED");
        assert.equal(blockedStatus.ownerToken, null);
        const verifyUnacquired = spawnSync(process.execPath, [
          helperPath, "verify-unacquired-failure", "--module", modulePath,
          "--store-dir", crashed.storeDir, "--control-file", blockedControl,
          "--instance-id", "blocked", "--expected-pid", String(blockedPid),
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(verifyUnacquired.status, 0, verifyUnacquired.stderr || verifyUnacquired.stdout);
        assert.equal(fs.existsSync(paths.pointerLockDir), true, "failed acquisition must preserve the foreign lock");
        const foreignCleanup = spawnSync(process.execPath, [
          helperPath, "cleanup-dead-owned", "--module", modulePath,
          "--store-dir", crashed.storeDir,
          "--expected-pid", String(process.pid),
          "--expected-token", "00000000-0000-4000-8000-000000000000",
        ], { encoding: "utf8", windowsHide: true });
        assert.equal(foreignCleanup.status, 3);
        assert.equal(fs.existsSync(paths.pointerLockDir), true, "foreign lock must be preserved");
        foreign.release();
      })().catch((error) => {
        console.error(error?.stack || error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("live SQLite prebuild cleanup removes every registered post-mktemp failure stage", () => {
  const registerBody = extractFunction(bundleRelease, "register_live_sqlite_prebuild_cleanup_state");
  const cleanupBody = extractFunction(bundleRelease, "cleanup_live_sqlite_prebuild");
  assertOrdered(extractFunction(bundleRelease, "prepare_live_sqlite_prebuild"), [
    'stage_dir="$(mktemp -d /var/lib/football-release/live-sqlite-prebuild.XXXXXX)"',
    'register_live_sqlite_prebuild_cleanup_state "$stage_dir"',
    'seal_helper="${NEXT_DIR}/scripts/sqliteReleaseSeal.cjs"',
    'install -d -o root -g root -m 0700 -- "$rollback_dir"',
    'for file in "$stage_path"',
    'cat >"$helper_path"',
    'chown root:root "$helper_path"',
    'chmod 0500 "$helper_path"',
  ], "every fallible preparation stage follows global cleanup registration");

  if (process.platform !== "linux" || !fs.existsSync("/bin/bash")) return;
  const testRoot = `/tmp/release-prebuild-cleanup-${process.pid}-${Date.now()}`;
  const adapt = (body) => body
    .replaceAll("/var/lib/football-release", testRoot)
    .replaceAll('[ "$uid" = "0" ] && [ "$gid" = "0" ]', '[ "$uid" = "$TEST_UID" ] && [ "$gid" = "$TEST_GID" ]');
  const harness = `
set -euo pipefail
TEST_ROOT=${JSON.stringify(testRoot)}
TEST_UID="$(id -u)"
TEST_GID="$(id -g)"
mkdir -m 0700 -- "$TEST_ROOT"
LIVE_SQLITE_PREBUILD_DIR=""
LIVE_SQLITE_PREBUILD_DIR_DEVICE=""
LIVE_SQLITE_PREBUILD_DIR_INODE=""
LIVE_SQLITE_PREBUILD_PATH=""
LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST=""
LIVE_SQLITE_PREBUILD_STAGE_MANIFEST=""
LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL=""
LIVE_SQLITE_PREBUILD_ROLLBACK_DIR=""
LIVE_SQLITE_PREBUILD_ROLLBACK_PATH=""
LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL=""
LIVE_SQLITE_PREBUILD_READY=0
LIVE_SQLITE_PREBUILD_ACTIVATED=0
LIVE_SQLITE_PREBUILD_ADOPTED=0
register_live_sqlite_prebuild_cleanup_state() {
${adapt(registerBody)}
}
cleanup_live_sqlite_prebuild() {
${adapt(cleanupBody)}
}
for point in registered rollback-dir regular-file ready adopted; do
  stage_dir="$(mktemp -d "$TEST_ROOT/live-sqlite-prebuild.XXXXXX")"
  register_live_sqlite_prebuild_cleanup_state "$stage_dir"
  case "$point" in
    rollback-dir) mkdir -m 0700 -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" ;;
    regular-file) : >"$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST"; chmod 0600 "$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST" ;;
    ready) mkdir -m 0700 -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR"; LIVE_SQLITE_PREBUILD_READY=1 ;;
    adopted) mkdir -m 0700 -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR"; rmdir -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR"; LIVE_SQLITE_PREBUILD_ADOPTED=1 ;;
  esac
  cleanup_live_sqlite_prebuild
  test ! -e "$stage_dir"
  test -z "$LIVE_SQLITE_PREBUILD_DIR"
done
stage_dir="$(mktemp -d "$TEST_ROOT/live-sqlite-prebuild.XXXXXX")"
LIVE_SQLITE_PREBUILD_DIR="$stage_dir"
LIVE_SQLITE_PREBUILD_PATH="$stage_dir/football.db"
LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST="$stage_dir/source-seal.json"
LIVE_SQLITE_PREBUILD_STAGE_MANIFEST="$stage_dir/stage-seal.json"
LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL="$stage_dir/publication-seal.json"
LIVE_SQLITE_PREBUILD_ROLLBACK_DIR="$stage_dir/rollback"
LIVE_SQLITE_PREBUILD_ROLLBACK_PATH="$stage_dir/rollback/football.db"
LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL="$stage_dir/rollback-seal.json"
cleanup_live_sqlite_prebuild
test ! -e "$stage_dir"
stage_dir="$(mktemp -d "$TEST_ROOT/live-sqlite-prebuild.XXXXXX")"
register_live_sqlite_prebuild_cleanup_state "$stage_dir"
mv -- "$stage_dir" "$stage_dir.original"
mkdir -m 0700 -- "$stage_dir"
if cleanup_live_sqlite_prebuild; then exit 91; fi
test -d "$stage_dir"
rm -rf -- "$stage_dir" "$stage_dir.original"
LIVE_SQLITE_PREBUILD_DIR=""
rm -rf -- "$TEST_ROOT"
`;
  const result = spawnSync("/bin/bash", ["-s"], {
    input: harness,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

check("pointer keeper runtime cleanup covers helper and launch partial-initialization failures", () => {
  const startBody = extractFunction(bundleRelease, "start_release_pointer_commit_keeper");
  const cleanupBody = extractFunction(bundleRelease, "cleanup_release_pointer_commit_keeper_runtime");
  assertOrdered(startBody, [
    'runtime_dir="$(mktemp -d /run/football-release-pointer-lock.XXXXXX)"',
    'RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR="$runtime_dir"',
    'install -d -o football -g football -m 0700 -- "$control_dir"',
    'write_release_pointer_commit_keeper_helper "$helper_file"',
    'chown root:football "$helper_file"',
    'chmod 0550 "$helper_file"',
    'dataGenerationStore.cjs" "$module_file"',
    'chown root:football "$module_file"',
    'chmod 0440 "$module_file"',
    "mapfile -t generation_paths",
    "RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=1",
    "systemd-run --quiet --collect",
  ], "runtime identity registration precedes helper write, metadata changes, path discovery, and launch");
  assert.match(cleanupBody, /RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED/);
  assert.match(cleanupBody, /root:root:600:1\|root:football:600:1\|root:football:550:1/);
  assert.match(cleanupBody, /root:root:600:1\|root:football:600:1\|root:football:440:1/);
  assert.match(cleanupBody, /keeper-status\.json\|keeper-status\.json\.\*\.tmp/);

  if (process.platform !== "linux" || !fs.existsSync("/bin/bash")) return;
  const testRoot = `/tmp/release-pointer-runtime-${process.pid}-${Date.now()}`;
  const user = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
  const adaptedCleanup = cleanupBody
    .replaceAll("/run/football-release-pointer-lock", `${testRoot}/football-release-pointer-lock`)
    .replaceAll('[ "$owner" = "root" ] && [ "$group" = "football" ]', `[ "$owner" = "${user}" ] && [ "$group" = "${group}" ]`)
    .replaceAll("root:root:600:1", `${user}:${group}:600:1`)
    .replaceAll("root:football:600:1", `${user}:${group}:600:1`)
    .replaceAll("root:football:550:1", `${user}:${group}:550:1`)
    .replaceAll("root:football:440:1", `${user}:${group}:440:1`)
    .replaceAll("football:football:700:2", `${user}:${group}:700:2`)
    .replaceAll("football:football:600:1", `${user}:${group}:600:1`);
  const harness = `
set -euo pipefail
TEST_ROOT=${JSON.stringify(testRoot)}
mkdir -m 0700 -- "$TEST_ROOT"
cleanup_release_pointer_commit_keeper_runtime() {
${adaptedCleanup}
}
reset_runtime() {
  runtime_dir="$(mktemp -d "$TEST_ROOT/football-release-pointer-lock.XXXXXX")"
  chmod 0750 "$runtime_dir"
  identity="$(stat -c '%d:%i' -- "$runtime_dir")"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR="$runtime_dir"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE="${'${identity%%:*}'}"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE="${'${identity##*:}'}"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=0
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR="$runtime_dir/control"
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE="$runtime_dir/control/keeper-status.json"
  RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE="$runtime_dir/keeper.cjs"
  RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE="$runtime_dir/dataGenerationStore.cjs"
  RELEASE_POINTER_COMMIT_KEEPER_LOCK_DIR="/unused/.pointer-commit.lock"
}
for point in registered control helper-write helper-chown helper-chmod module-write module-chown module-chmod mapfile systemd-run; do
  reset_runtime
  case "$point" in
    registered) ;;
    control) mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR" ;;
    helper-write|helper-chown)
      mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"; chmod 0600 "$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
      ;;
    helper-chmod)
      mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"; chmod 0550 "$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
      ;;
    module-write|module-chown)
      mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"; chmod 0550 "$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"; chmod 0600 "$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"
      ;;
    module-chmod|mapfile)
      mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"; chmod 0550 "$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"; chmod 0440 "$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"
      ;;
    systemd-run)
      mkdir -m 0700 -- "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"; chmod 0550 "$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"; chmod 0440 "$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"
      : >"$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE"; chmod 0600 "$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE"
      RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=1
      ;;
  esac
  cleanup_release_pointer_commit_keeper_runtime
  test ! -e "$runtime_dir"
  test -z "$RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR"
done
rm -rf -- "$TEST_ROOT"
`;
  const result = spawnSync("/bin/bash", ["-s"], {
    input: harness,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

check("release prebuild capacity and heartbeat freshness gates enforce inclusive safe boundaries", () => {
  assert.equal(DEFAULT_MIN_MEM_AVAILABLE_MIB, 1152);
  assert.equal(DEFAULT_MAX_APP_MEMORY_CURRENT_MIB, 640);
  assert.equal(DEFAULT_MAX_APP_WORKING_SET_MIB, 512);
  assert.deepEqual(resolveCapacityLimits({}), {
    minMemAvailableMiB: 1152,
    maxAppMemoryCurrentMiB: 640,
    maxAppWorkingSetMiB: 512,
  });
  assert.throws(
    () => resolveCapacityLimits({ RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB: "1151" }),
    /between 1152 and 65536/,
  );
  assert.throws(
    () => resolveCapacityLimits({ RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB: "641" }),
    /between 64 and 640/,
  );
  assert.throws(
    () => resolveCapacityLimits({ RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB: "513" }),
    /between 64 and 512/,
  );
  for (const invalid of ["", " 1152", "+1152", "1152.0", "1e3", "-1"]) {
    assert.throws(
      () => resolveCapacityLimits({ RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB: invalid }),
      /unsigned base-10 integer/,
    );
  }

  const thresholdMeminfo = `MemAvailable: ${1152 * 1024} kB\n`;
  const atCapacityBoundary = evaluateCapacity({
    meminfoText: thresholdMeminfo,
    appMemoryCurrentBytes: String(640 * 1024 * 1024),
    appInactiveFileBytes: String(128 * 1024 * 1024),
    env: {},
  });
  assert.equal(atCapacityBoundary.ok, true);
  assert.equal(evaluateCapacity({
    meminfoText: `MemAvailable: ${1152 * 1024 - 1} kB\n`,
    appMemoryCurrentBytes: String(640 * 1024 * 1024),
    appInactiveFileBytes: String(128 * 1024 * 1024),
    env: {},
  }).ok, false, "one KiB below the host threshold must fail closed");
  assert.equal(evaluateCapacity({
    meminfoText: thresholdMeminfo,
    appMemoryCurrentBytes: String(640 * 1024 * 1024 + 1),
    appInactiveFileBytes: String(128 * 1024 * 1024 + 1),
    env: {},
  }).ok, false, "one byte above the raw app threshold must fail closed");
  assert.equal(evaluateCapacity({
    meminfoText: thresholdMeminfo,
    appMemoryCurrentBytes: String(512 * 1024 * 1024 + 1),
    appInactiveFileBytes: "0",
    env: {},
  }).ok, false, "one byte above the app working-set threshold must fail closed");
  assert.equal(evaluateCapacity({
    meminfoText: thresholdMeminfo,
    appMemoryCurrentBytes: String(512 * 1024 * 1024 + 1),
    appInactiveFileBytes: "1",
    env: {},
  }).ok, true, "one reclaimable byte must not be charged to the working set");
  assert.throws(() => evaluateCapacity({
    meminfoText: thresholdMeminfo,
    appMemoryCurrentBytes: "1",
    appInactiveFileBytes: "2",
    env: {},
  }), /inactive_file must not exceed/);
  const r399ObservedCurrent = 544_145_408;
  assert.equal(evaluateCapacity({
    meminfoText: `MemAvailable: ${1_266_688} kB\n`,
    appMemoryCurrentBytes: String(r399ObservedCurrent),
    appInactiveFileBytes: String(128 * 1024 * 1024),
    env: {},
  }).ok, true, "the r399 raw footprint passes only when its bounded working set and host runway pass");
  assert.equal(evaluateCapacity({
    meminfoText: `MemAvailable: ${1_266_688} kB\n`,
    appMemoryCurrentBytes: String(r399ObservedCurrent),
    appInactiveFileBytes: String(r399ObservedCurrent - 512 * 1024 * 1024 - 1),
    env: {},
  }).ok, false, "the same raw footprint fails when its working set exceeds 512 MiB by one byte");

  assert.equal(evaluateFreshness({
    refreshedAtEpochSeconds: 1_000,
    nowEpochSeconds: 1_090,
    maxAgeSeconds: 90,
    phase: "post-live-sqlite-prebuild",
  }).ok, true);
  assert.equal(evaluateFreshness({
    refreshedAtEpochSeconds: 1_000,
    nowEpochSeconds: 1_091,
    maxAgeSeconds: 90,
    phase: "post-live-sqlite-prebuild",
  }).ok, false);
  assert.equal(evaluateFreshness({
    refreshedAtEpochSeconds: 1_000,
    nowEpochSeconds: 1_110,
    maxAgeSeconds: 110,
    phase: "post-live-sqlite-http-pressure",
  }).ok, true);
  assert.equal(evaluateFreshness({
    refreshedAtEpochSeconds: 1_000,
    nowEpochSeconds: 1_111,
    maxAgeSeconds: 110,
    phase: "post-live-sqlite-http-pressure",
  }).ok, false);
  assert.equal(evaluateFreshness({
    refreshedAtEpochSeconds: 1_001,
    nowEpochSeconds: 1_000,
    maxAgeSeconds: 90,
    phase: "clock-regression",
  }).ok, false, "clock regression must fail closed");
  assert.throws(() => evaluateFreshness({
    refreshedAtEpochSeconds: 1_000,
    nowEpochSeconds: 1_001,
    maxAgeSeconds: 301,
    phase: "invalid-limit",
  }), /between 1 and 300/);
});

check("SQLite nanosecond seals reject same-size writes, inode swaps, links, and WAL transitions", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-sqlite-seal-"));
  const sealSource = readText(sqliteReleaseSealPath);
  const makeFixture = (name, walPresent = true) => {
    const directory = path.join(tempRoot, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const base = path.join(directory, "football.db");
    fs.writeFileSync(base, Buffer.from("sqlite-base-before-freeze\n"));
    if (walPresent) fs.writeFileSync(`${base}-wal`, Buffer.from("sqlite-wal-before-freeze\n"));
    return { directory, base, seal: captureSeal(base) };
  };
  try {
    assert.match(sealSource, /O_NOFOLLOW/);
    assert.match(sealSource, /mtimeNs/);
    assert.match(sealSource, /ctimeNs/);
    assert.match(sealSource, /sameMetadata\(metadataFromStat\(pathStat\), metadataFromStat\(stat\)\)/);
    assert.match(sealSource, /directoryStat\.uid !== 0n/);
    assert.match(sealSource, /directoryStat\.gid !== 0n/);

    const stable = makeFixture("stable");
    verifyMetadataSeal(stable.base, stable.seal);

    const sameSize = makeFixture("same-size");
    const originalSecond = Math.floor(Number(BigInt(sameSize.seal.entries[0].mtimeNs) / 1_000_000_000n));
    fs.writeFileSync(sameSize.base, Buffer.from("sqlite-base-after--freeze\n"));
    fs.utimesSync(sameSize.base, originalSecond, originalSecond);
    assert.throws(() => verifyMetadataSeal(sameSize.base, sameSize.seal), /seal CAS mismatch/u);

    const inodeSwap = makeFixture("inode-swap");
    const replacement = `${inodeSwap.base}.replacement`;
    fs.writeFileSync(replacement, fs.readFileSync(inodeSwap.base));
    fs.renameSync(replacement, inodeSwap.base);
    assert.throws(() => verifyMetadataSeal(inodeSwap.base, inodeSwap.seal), /seal CAS mismatch/u);

    const hardLink = makeFixture("hard-link");
    fs.linkSync(hardLink.base, `${hardLink.base}.alias`);
    assert.throws(() => verifyMetadataSeal(hardLink.base, hardLink.seal), /unsafe SQLite release/u);

    const symlink = makeFixture("symlink");
    const symlinkTarget = `${symlink.base}.target`;
    fs.renameSync(symlink.base, symlinkTarget);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(symlinkTarget, symlink.base, "file");
      symlinkCreated = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
    }
    if (symlinkCreated) {
      assert.throws(() => verifyMetadataSeal(symlink.base, symlink.seal), /unsafe SQLite release path/u);
    }

    const walRemoved = makeFixture("wal-removed");
    fs.rmSync(`${walRemoved.base}-wal`);
    assert.throws(() => verifyMetadataSeal(walRemoved.base, walRemoved.seal), /wal/u);
    const walAppeared = makeFixture("wal-appeared", false);
    fs.writeFileSync(`${walAppeared.base}-wal`, Buffer.from("late-wal\n"));
    assert.throws(() => verifyMetadataSeal(walAppeared.base, walAppeared.seal), /wal/u);

    const copied = makeFixture("copied");
    const rollbackDirectory = path.join(copied.directory, "rollback");
    fs.mkdirSync(rollbackDirectory, { mode: 0o700 });
    fs.chmodSync(rollbackDirectory, 0o700);
    const snapshotBase = path.join(rollbackDirectory, "football.db");
    const sourceSealPath = path.join(copied.directory, "source-seal.json");
    const snapshotSealPath = path.join(copied.directory, "snapshot-seal.json");
    copyRollbackSnapshot({
      sourceBase: copied.base,
      snapshotBase,
      sourceSealOutput: sourceSealPath,
      snapshotSealOutput: snapshotSealPath,
      requireRootOwner: false,
    });
    fs.writeFileSync(`${copied.base}-shm`, Buffer.from("small-shm\n"));
    const livePathOutput = path.join(rollbackDirectory, "live-path");
    const manifestOutput = path.join(rollbackDirectory, "manifest.tsv");
    finalizeRecoverySnapshot({
      liveBase: copied.base,
      snapshotBase,
      sourceSealPath,
      snapshotSealPath,
      livePathOutput,
      manifestOutput,
    });
    const manifest = fs.readFileSync(manifestOutput, "utf8").trim().split("\n");
    assert.equal(manifest.length, 3);
    assert.deepEqual(manifest.map((line) => line.split("\t")[0]), ["base", "wal", "shm"]);

    const retried = makeFixture("retried");
    const retriedRollbackDirectory = path.join(retried.directory, "rollback");
    fs.mkdirSync(retriedRollbackDirectory, { mode: 0o700 });
    fs.chmodSync(retriedRollbackDirectory, 0o700);
    const retriedSnapshotBase = path.join(retriedRollbackDirectory, "football.db");
    const retriedSourceSealPath = path.join(retried.directory, "source-seal.json");
    const retriedSnapshotSealPath = path.join(retried.directory, "snapshot-seal.json");
    const originalCopyFileSync = fs.copyFileSync;
    let injectedWalChurn = false;
    const retryEvents = [];
    fs.copyFileSync = (source, target, flags) => {
      originalCopyFileSync(source, target, flags);
      if (!injectedWalChurn
          && source === `${retried.base}-wal`
          && target === `${retriedSnapshotBase}-wal`) {
        injectedWalChurn = true;
        fs.appendFileSync(`${retried.base}-wal`, Buffer.from("bounded-online-write\n"));
      }
    };
    let retriedResult;
    try {
      retriedResult = copyRollbackSnapshot({
        sourceBase: retried.base,
        snapshotBase: retriedSnapshotBase,
        sourceSealOutput: retriedSourceSealPath,
        snapshotSealOutput: retriedSnapshotSealPath,
        requireRootOwner: false,
        maxAttempts: 3,
        retryDelayMs: 0,
        onRetry: (event) => retryEvents.push(event),
      });
    } finally {
      fs.copyFileSync = originalCopyFileSync;
    }
    assert.equal(retriedResult.attempts, 2);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].error.code, "SQLITE_SOURCE_CHANGED");
    assert.deepEqual(
      fs.readFileSync(`${retriedSnapshotBase}-wal`),
      fs.readFileSync(`${retried.base}-wal`),
      "the accepted retry must copy the final stable WAL bytes",
    );

    const exhausted = makeFixture("retry-exhausted");
    const exhaustedRollbackDirectory = path.join(exhausted.directory, "rollback");
    fs.mkdirSync(exhaustedRollbackDirectory, { mode: 0o700 });
    fs.chmodSync(exhaustedRollbackDirectory, 0o700);
    const exhaustedSnapshotBase = path.join(exhaustedRollbackDirectory, "football.db");
    const exhaustedSourceSealPath = path.join(exhausted.directory, "source-seal.json");
    const exhaustedSnapshotSealPath = path.join(exhausted.directory, "snapshot-seal.json");
    fs.copyFileSync = (source, target, flags) => {
      originalCopyFileSync(source, target, flags);
      if (source === `${exhausted.base}-wal`
          && target === `${exhaustedSnapshotBase}-wal`) {
        fs.appendFileSync(`${exhausted.base}-wal`, Buffer.from("persistent-online-write\n"));
      }
    };
    try {
      assert.throws(() => copyRollbackSnapshot({
        sourceBase: exhausted.base,
        snapshotBase: exhaustedSnapshotBase,
        sourceSealOutput: exhaustedSourceSealPath,
        snapshotSealOutput: exhaustedSnapshotSealPath,
        requireRootOwner: false,
        maxAttempts: 2,
        retryDelayMs: 0,
      }), /did not stabilize after 2 rollback snapshot attempts: wal/u);
    } finally {
      fs.copyFileSync = originalCopyFileSync;
    }
    assert.equal(fs.existsSync(exhaustedSnapshotBase), false);
    assert.equal(fs.existsSync(`${exhaustedSnapshotBase}-wal`), false);
    assert.equal(fs.existsSync(exhaustedSourceSealPath), false);
    assert.equal(fs.existsSync(exhaustedSnapshotSealPath), false);

    const stageSeal = captureSeal(snapshotBase);
    fs.appendFileSync(snapshotBase, Buffer.from("tampered-stage\n"));
    assert.throws(() => verifyMetadataSeal(snapshotBase, stageSeal), /base/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("live SQLite rollback restores exact bytes at every prebuild activation crash point", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-sqlite-activation-crash-"));
  const livePath = path.join(tempRoot, "football.db");
  const stagePath = path.join(tempRoot, "stage.db");
  const backupDir = path.join(tempRoot, "backup");
  const oldState = {
    base: Buffer.from("old-base\n"),
    wal: Buffer.from("old-wal\n"),
    shm: Buffer.from("old-shm\n"),
  };
  const suffixFor = { base: "", wal: "-wal", shm: "-shm" };
  try {
    fs.mkdirSync(backupDir);
    for (const [token, bytes] of Object.entries(oldState)) {
      fs.writeFileSync(`${livePath}${suffixFor[token]}`, bytes);
      fs.writeFileSync(path.join(backupDir, token), bytes);
    }
    const resetStage = () => {
      fs.writeFileSync(stagePath, Buffer.from("new-base\n"));
      fs.writeFileSync(`${stagePath}-wal`, Buffer.from("new-wal\n"));
    };
    const restore = () => {
      for (const token of ["base", "wal", "shm"]) {
        const destination = `${livePath}${suffixFor[token]}`;
        const temporary = `${destination}.rollback`;
        fs.copyFileSync(path.join(backupDir, token), temporary);
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
      }
    };
    const assertRestored = () => {
      for (const [token, bytes] of Object.entries(oldState)) {
        assert.deepEqual(fs.readFileSync(`${livePath}${suffixFor[token]}`), bytes);
      }
    };
    for (const crashPoint of ["after-sidecar-delete", "after-base-rename", "after-wal-rename"]) {
      restore();
      resetStage();
      fs.rmSync(`${livePath}-wal`, { force: true });
      fs.rmSync(`${livePath}-shm`, { force: true });
      if (crashPoint !== "after-sidecar-delete") {
        fs.renameSync(stagePath, livePath);
      }
      if (crashPoint === "after-wal-rename") {
        fs.renameSync(`${stagePath}-wal`, `${livePath}-wal`);
      }
      restore();
      assertRestored();
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("the sync worker stays live during long isolated work and pauses only for bounded handoffs", () => {
  const main = mainProgram(bundleRelease);
  const exitTrapBody = extractFunction(bundleRelease, "release_exit_trap");
  assert.doesNotMatch(main, /pause the sync worker before current-service health preflight/);
  assertOrdered(main, [
    'wait_for_health "http://${HOST}:${PORT}" "preflight-before-build"',
    "sync worker could not be paused for candidate cache snapshot",
    'preserve_live_public_data_cache "$APP_DIR" "$BUILD_DIR"',
    "sync worker could not resume during isolated candidate build",
    "run_build_step npm-ci",
    "run_build_step application-build",
    'wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server"',
    "sync worker could not be paused for candidate readiness",
    "candidate deadline capture heartbeat refresh failed after candidate worker freeze",
    "candidate could not stop for archive refresh",
    "candidate-archive-refresh",
    "candidate-sqlite-refresh",
    'wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server-refreshed"',
    "sync worker could not resume during isolated candidate verification",
    "run_trusted_candidate_verifier",
    "sync worker could not be paused before live SQLite prebuild",
    "candidate deadline capture heartbeat refresh failed before live SQLite prebuild",
    'prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
    "candidate deadline capture heartbeat refresh failed after live SQLite prebuild",
    "candidateReleaseContinuity.cjs\" snapshot",
  ], "worker resumes for isolated candidate verification and pauses only for the bounded SQLite handoff");
  assert.match(exitTrapBody, /restore_pre_swap_transaction/);
});

check("candidate odds compaction executes a signed file without inline systemd argument expansion", () => {
  const main = mainProgram(bundleRelease);
  const compactBody = extractFunction(bundleRelease, "compact_public_odds_history");
  assert.match(compactBody, /"\$NODE_HOME\/bin\/node" scripts\/compactPublicOddsHistory\.cjs/);
  assert.doesNotMatch(compactBody, /node\s+-e|<<['"]?NODE|compact_script/);
  assertOrdered(main, [
    'preserve_live_public_data_cache "$APP_DIR" "$BUILD_DIR"',
    'compact_public_odds_history "$BUILD_DIR"',
    "run_build_step candidate-datastore",
  ], "candidate odds cache is preserved, compacted by the signed helper, then projected to SQLite");
});

check("candidate odds compaction preserves recent non-empty rows and verifies both mirrors", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-odds-compact-"));
  try {
    const dataDir = path.join(tempRoot, "public", "data");
    const publicDir = path.join(tempRoot, "public");
    fs.mkdirSync(dataDir, { recursive: true });
    const now = Date.now();
    const recentA = new Date(now - 60_000).toISOString();
    const recentB = new Date(now - 120_000).toISOString();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sourcePayload = {
      version: "odds-history-v2",
      rows: [
        { sourceMatchId: "recent-a", pool: "HAD", capturedAt: recentA, lastSeenAt: recentA },
        { sourceMatchId: "old", pool: "HAD", capturedAt: old, lastSeenAt: old },
        { sourceMatchId: "recent-b", pool: "HHAD", capturedAt: recentB, lastSeenAt: recentB },
      ],
    };
    fs.writeFileSync(path.join(dataDir, "odds-history.json"), `${JSON.stringify(sourcePayload)}\n`);
    fs.writeFileSync(path.join(publicDir, "odds-history.json"), `${JSON.stringify({ version: "stale", rows: [] })}\n`);

    const result = spawnSync(process.execPath, [compactPublicOddsHistoryPath], {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPACT_APP_DIR: tempRoot,
        COMPACT_RETENTION_DAYS: "14",
        COMPACT_MAX_ROWS: "12000",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(report.beforeRows, 3);
    assert.equal(report.keptRows, 2);
    assert.equal(report.mirrorDigestsMatch, true);
    assert.equal(report.outputs.length, 2);
    assert.ok(report.bytes > 2, "non-empty compaction cannot produce the one-byte r361 failure payload");

    const dataBody = fs.readFileSync(path.join(dataDir, "odds-history.json"));
    const publicBody = fs.readFileSync(path.join(publicDir, "odds-history.json"));
    const digest = (body) => crypto.createHash("sha256").update(body).digest("hex");
    assert.deepEqual(dataBody, publicBody);
    assert.equal(digest(dataBody), report.sha256);
    assert.deepEqual(report.outputs.map((output) => output.sha256), [report.sha256, report.sha256]);
    const installed = JSON.parse(dataBody.toString("utf8"));
    assert.deepEqual(installed.rows.map((row) => row.sourceMatchId), ["recent-a", "recent-b"]);

    const candidateStoreDir = path.join(tempRoot, "server-data");
    const candidateSqlitePath = path.join(candidateStoreDir, "football.db");
    const sqliteExport = spawnSync(process.execPath, [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")], {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        SQLITE_EXPORT_PUBLIC_DATA_DIR: dataDir,
        SERVER_STORE_DIR: candidateStoreDir,
        DATASTORE_SQLITE_PATH: candidateSqlitePath,
      },
    });
    assert.equal(sqliteExport.status, 0, sqliteExport.stderr || sqliteExport.stdout);
    const sqliteReport = JSON.parse(sqliteExport.stdout.trim());
    assert.equal(sqliteReport.incremental.publicOddsRows, 2);
    assert.equal(sqliteReport.counts.oddsSnapshots, 2, "fresh candidate SQLite must retain compacted odds rows");

    const invalidRoot = path.join(tempRoot, "invalid");
    const invalidDataDir = path.join(invalidRoot, "public", "data");
    const invalidPublicDir = path.join(invalidRoot, "public");
    fs.mkdirSync(invalidDataDir, { recursive: true });
    const invalidInput = "{not-json\n";
    const untouchedMirror = `${JSON.stringify({ version: "untouched", rows: [] })}\n`;
    fs.writeFileSync(path.join(invalidDataDir, "odds-history.json"), invalidInput);
    fs.writeFileSync(path.join(invalidPublicDir, "odds-history.json"), untouchedMirror);
    const invalid = spawnSync(process.execPath, [compactPublicOddsHistoryPath], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, COMPACT_APP_DIR: invalidRoot },
    });
    assert.notEqual(invalid.status, 0, "invalid source JSON must fail closed");
    assert.equal(fs.readFileSync(path.join(invalidDataDir, "odds-history.json"), "utf8"), invalidInput);
    assert.equal(fs.readFileSync(path.join(invalidPublicDir, "odds-history.json"), "utf8"), untouchedMirror);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check("post-swap live sqlite refresh inherits the prepared production runtime env", () => {
  const main = mainProgram(bundleRelease);
  const refreshBody = extractFunction(bundleRelease, "refresh_live_store_after_swap");
  const runtimeEnvBody = extractFunction(bundleRelease, "run_as_service_user_with_runtime_env");
  assert.match(runtimeEnvBody, /\. "\$1"/);
  assert.match(refreshBody, /run_as_service_user_with_runtime_env env SERVER_STORE_DIR="\$store_dir"/);
  assert.doesNotMatch(refreshBody, /run_as_service_user env SERVER_STORE_DIR="\$store_dir"/);
  assert.match(refreshBody, /SQLITE_MAINTENANCE_WINDOW=release-stopped/);
  assert.match(refreshBody, /npm run datastore:sqlite/);
  assert.match(bundleRelease, /set_env_value "\$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"/);
  assertOrdered(main, [
    "prepare_runtime_env",
    "SWAP_STARTED=1",
    'refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
  ], "post-swap live sqlite runtime env boundary");
});

check("post-swap app mirrors authoritative store artifacts without package fallback", () => {
  const main = mainProgram(bundleRelease);
  const mirrorBody = extractFunction(bundleRelease, "sync_model_artifact_mirrors");
  assert.match(
    main,
    /sync_model_artifact_mirrors "\$LIVE_STORE_DIR" "\$APP_DIR" store-only[\s\\]*\|\| rollback "post-swap model artifact mirror failed"/,
  );
  assert.match(mirrorBody, /local mode="\$\{3:-bidirectional\}"/);
  assert.match(mirrorBody, /bidirectional\|store-only/);
  assert.equal(countLiteral(mirrorBody, 'elif [ "$mode" = "store-only" ]; then'), 2);
  assert.match(mirrorBody, /elif \[ "\$mode" = "store-only" \]; then\n\s+return 1\n\s+elif \[ -f "\$\{public_data_dir\}\/model-strategy\.json" \]/);
  assert.match(mirrorBody, /elif \[ "\$mode" = "store-only" \]; then\n\s+return 1\n\s+elif \[ -f "\$\{public_data_dir\}\/model-evaluation\.json" \]/);
  assert.match(
    extractFunction(bundleRelease, "run_candidate_model_artifact_catchup"),
    /sync_model_artifact_mirrors "\$store_dir" "\$BUILD_DIR" \|\| return 1/,
  );
  assertOrdered(main, [
    "mv \"$NEXT_DIR\" \"$APP_DIR\"",
    'sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR" store-only',
    'refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
    "restart_service_if_needed",
    "scripts/verifyProductionReadiness.cjs",
  ], "external model artifacts remain identical to their public mirrors across swap");
});

check("release heartbeat keeper requires an exact successful heartbeat and a bounded cadence", () => {
  const evaluatedAt = "2026-08-01T00:00:00.000Z";
  const exact = exactHeartbeatFixture(evaluatedAt);
  assert.equal(exactHeartbeatMatches(exact, evaluatedAt), true);
  assert.equal(exactHeartbeatMatches({ ...exact, skipped: true }, evaluatedAt), false);
  assert.equal(exactHeartbeatMatches({ ...exact, evaluatedAt: "2026-08-01T00:00:01.000Z" }, evaluatedAt), false);
  const preSwapLegacy = structuredClone(exact);
  delete preSwapLegacy.dueUnrecorded;
  delete preSwapLegacy.readyDueUnrecorded;
  assert.equal(
    exactHeartbeatMatches(preSwapLegacy, evaluatedAt),
    false,
    "legacy top-level due omission must fail under the strict default",
  );
  assert.equal(
    exactHeartbeatMatches(preSwapLegacy, evaluatedAt, {
      allowPreSwapLegacyTopLevelDueOmission: true,
    }),
    true,
    "pre-swap compatibility may accept only an omitted legacy top-level pair",
  );
  const partialLegacy = structuredClone(preSwapLegacy);
  partialLegacy.dueUnrecorded = 0;
  assert.equal(
    exactHeartbeatMatches(partialLegacy, evaluatedAt, {
      allowPreSwapLegacyTopLevelDueOmission: true,
    }),
    false,
    "pre-swap compatibility must reject a partially omitted top-level pair",
  );
  assert.equal(
    exactHeartbeatMatches({ ...exact, dueUnrecorded: 1 }, evaluatedAt, {
      allowPreSwapLegacyTopLevelDueOmission: true,
    }),
    false,
    "pre-swap compatibility must never accept an explicit due gap",
  );
  for (const [label, mutate] of [
    ["due capture", (row) => { row.dueCaptureComplete = false; }],
    ["due atomic", (row) => { row.dueAtomicComplete = false; }],
    ["top-level due", (row) => { row.dueUnrecorded = 1; }],
    ["top-level ready due", (row) => { row.readyDueUnrecorded = 1; }],
    ["evaluated/upcoming", (row) => { row.readiness.evaluatedMatches = 1; }],
    ["detail coverage", (row) => { row.readiness.rowsTruncated = 1; }],
    ["atomic ready", (row) => { row.readiness.atomicReadyNow = 1; }],
    ["partition", (row) => { row.readiness.blocked = 1; }],
    ["invariant marker", (row) => { row.readiness.readyInvariantOk = false; }],
    ["excluded nearest", (row) => { row.readiness.nearestStatus = "excluded"; }],
    ["chain", (row) => { row.audit.chainValid = false; }],
    ["audit time", (row) => { row.audit.evaluatedAt = "2026-08-01T00:00:01.000Z"; }],
    ["candidate identity", (row) => { row.readiness.candidateRevisionId = "other@test"; }],
    ["decision version", (row) => { row.audit.decisionRecord.version = "candidate-atomic-decision-record-v2"; }],
    ["decision failed rows", (row) => { row.audit.decisionRecord.failedRows = 1; }],
    ["decision coverage", (row) => { row.audit.decisionRecord.coverage = 0.99; }],
    ["capture blockers", (row) => { row.blockers = ["unexpected-gap"]; }],
  ]) {
    const invalid = structuredClone(exact);
    mutate(invalid);
    assert.equal(exactHeartbeatMatches(invalid, evaluatedAt), false, `${label} must fail closed`);
  }
  const excludedTerminal = exactHeartbeatFixture(evaluatedAt);
  Object.assign(excludedTerminal.readiness, {
    evaluatedMatches: 1,
    detailedMatches: 1,
    upcomingMatches: 1,
    excluded: 1,
    deadlineBatches: [{
      version: "candidate-deadline-batch-summary-v1",
      deadlineAt: "2026-08-01T01:00:00.000Z",
      finalizationAt: "2026-08-01T01:02:00.000Z",
      totalMatches: 1,
      readyNow: 0,
      awaitingMarket: 0,
      blocked: 0,
      excluded: 1,
      actionableMatches: 0,
      terminalMatches: 1,
      terminalDecisions: 0,
      terminalExclusions: 1,
      duplicateTerminalEvents: 0,
      terminalKeysWithDuplicates: 0,
      pendingMatches: 0,
      dueUnrecorded: 0,
      readyDueUnrecorded: 0,
      phase: "upcoming",
      invariantOk: true,
    }],
  });
  assert.equal(exactHeartbeatMatches(excludedTerminal, evaluatedAt), true);
  const dueGap = structuredClone(excludedTerminal);
  dueGap.readiness.deadlineBatches[0].dueUnrecorded = 1;
  assert.equal(exactHeartbeatMatches(dueGap, evaluatedAt), false, "dueUnrecorded must be zero");
  delete dueGap.dueUnrecorded;
  delete dueGap.readyDueUnrecorded;
  assert.equal(
    exactHeartbeatMatches(dueGap, evaluatedAt, {
      allowPreSwapLegacyTopLevelDueOmission: true,
    }),
    false,
    "pre-swap compatibility remains fail-closed when readiness reports a due gap",
  );
  const dynamicDecisionCount = exactHeartbeatFixture(evaluatedAt);
  Object.assign(dynamicDecisionCount.audit.decisionRecord, {
    admittedRows: 17,
    atomicRows: 17,
    completeRows: 17,
  });
  assert.equal(
    exactHeartbeatMatches(dynamicDecisionCount, evaluatedAt),
    true,
    "atomic decision rows are dynamic and must not be hard-coded to one cohort size",
  );
  assert.equal(captureScheduleDelayMs({ attemptStartedAtMs: 1_000, nowMs: 4_000, intervalMs: 20_000 }), 17_000);
  assert.equal(captureScheduleDelayMs({ attemptStartedAtMs: 1_000, nowMs: 40_000, intervalMs: 20_000 }), 0);
  const options = validateKeeperOptions({
    instanceId: "keeper-test.service",
    captureScript: path.join(rootDir, "scripts", "captureCandidateProspectiveDeadline.cjs"),
    heartbeatStatusFile: path.join(rootDir, "server-data", "capture-status.json"),
    controlFile: path.join(rootDir, ".codex-tmp", "keeper-status.json"),
    workingDirectory: rootDir,
    storeDir: path.join(rootDir, "server-data"),
    sqlitePath: path.join(rootDir, "server-data", "football.db"),
    intervalSeconds: 30,
    attemptTimeoutMs: 25_000,
    lockTimeoutMs: 10_000,
  });
  assert.equal(options.intervalSeconds, 30);
  assert.throws(() => validateKeeperOptions({ ...options, intervalSeconds: 31 }), /intervalSeconds/);
  assert.throws(() => validateKeeperOptions({ ...options, lockTimeoutMs: 25_000 }), /lockTimeoutMs/);
});

check("release heartbeat keeper latches a later capture failure and only exits on explicit stop", () => {
  const { result, control, captures, observed } = runHeartbeatKeeperIntegration("fail-second");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(captures, 2);
  assert.equal(observed?.aliveBeforeSignal, true);
  assert.equal(observed?.capturesAtObservation, 2);
  assert.equal(observed?.capturesBeforeSignal, 2);
  assert.equal(observed?.observedControl?.version, "release-candidate-heartbeat-keeper-v2");
  assert.equal(observed?.observedControl?.state, "failed-latched");
  assert.equal(observed?.observedControl?.ok, false);
  assert.equal(observed?.observedControl?.failedClosed, true);
  assert.equal(observed?.observedControl?.awaitingExplicitStop, true);
  assert.equal(observed?.observedControl?.captureSequence, 1);
  assert.equal(observed?.observedControl?.reason, "capture-process-failed");
  assert.equal(control?.version, "release-candidate-heartbeat-keeper-v2");
  assert.equal(control?.state, "stopped", observed?.stderr || result.stderr || result.stdout);
  assert.equal(control?.ok, false);
  assert.equal(control?.failedClosed, true);
  assert.equal(control?.stopSignal, "SIGTERM");
  assert.equal(control?.captureSequence, 1);
  assert.equal(control?.failure?.reason, "capture-process-failed");
  assert.match(control?.lastEvaluatedAt || "", /^\d{4}-\d{2}-\d{2}T/);
});

check("release heartbeat keeper latches the production lock-busy exact-gate failure", () => {
  const { result, control, captures, observed } = runHeartbeatKeeperIntegration("lock-busy-first");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(captures, 1);
  assert.equal(observed?.aliveBeforeSignal, true);
  assert.equal(observed?.capturesAtObservation, observed?.capturesBeforeSignal);
  assert.equal(observed?.observedControl?.state, "failed-latched");
  assert.equal(observed?.observedControl?.reason, "exact-heartbeat-not-published");
  assert.equal(observed?.observedControl?.observedTransientReason, "registry-lock-busy");
  assert.equal(observed?.observedControl?.captureSequence, 0);
  assert.equal(control?.state, "stopped");
  assert.equal(control?.failure?.observedTransientReason, "registry-lock-busy");
  assert.equal(control?.captureSequence, 0);
});

check("release heartbeat keeper survives the r385 capture-timeout shape until explicit reap", () => {
  const { result, control, captures, observed } = runHeartbeatKeeperIntegration("timeout-second");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(captures, 2);
  assert.equal(observed?.aliveBeforeSignal, true);
  assert.equal(observed?.capturesAtObservation, 2);
  assert.equal(observed?.capturesBeforeSignal, 2);
  assert.equal(observed?.observedControl?.state, "failed-latched");
  assert.equal(observed?.observedControl?.reason, "capture-timeout");
  assert.equal(observed?.observedControl?.captureSequence, 1);
  assert.equal(control?.state, "stopped");
  assert.equal(control?.failedClosed, true);
  assert.equal(control?.failure?.reason, "capture-timeout");
  assert.equal(control?.stopSignal, "SIGTERM");
});

check("release heartbeat keeper exits cleanly on SIGTERM after its first exact heartbeat", () => {
  const { result, control, captures } = runHeartbeatKeeperIntegration("signal");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.ok([1, 2].includes(captures));
  assert.equal(control?.version, "release-candidate-heartbeat-keeper-v2");
  assert.equal(control?.state, "stopped");
  assert.equal(control?.ok, true);
  assert.equal(control?.failedClosed, false);
  assert.equal(control?.stopSignal, "SIGTERM");
  assert.equal(control?.stopDrained, true);
  assert.equal(control?.activeAttempt, null);
  assert.equal(control?.failure, null);
  assert.equal(control?.captureSequence, captures);
  assert.match(control?.lastEvaluatedAt || "", /^\d{4}-\d{2}-\d{2}T/);
});

check("release heartbeat keeper drains an in-flight second capture before clean stop", () => {
  const { result, control, captures, observed } = runHeartbeatKeeperIntegration("signal-during-second");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(observed?.observedControl?.activeAttempt?.sequence, 2);
  assert.ok([1, 2].includes(observed?.capturesAtObservation));
  assert.equal(observed?.capturesBeforeSignal, 2);
  assert.equal(captures, 2);
  assert.equal(control?.state, "stopped");
  assert.equal(control?.ok, true);
  assert.equal(control?.failedClosed, false);
  assert.equal(control?.stopDrained, true);
  assert.equal(control?.activeAttempt, null);
  assert.equal(control?.failure, null);
  assert.equal(control?.captureSequence, 2);
});

check("release heartbeat keeper records a second-capture failure requested during stop", () => {
  const { result, control, captures, observed } = runHeartbeatKeeperIntegration("fail-during-stop-second");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(observed?.observedControl?.activeAttempt?.sequence, 2);
  assert.ok([1, 2].includes(observed?.capturesAtObservation));
  assert.equal(observed?.capturesBeforeSignal, 2);
  assert.equal(captures, 2);
  assert.equal(control?.state, "stopped");
  assert.equal(control?.ok, false);
  assert.equal(control?.failedClosed, true);
  assert.equal(control?.stopDrained, true);
  assert.equal(control?.activeAttempt, null);
  assert.equal(control?.captureSequence, 1);
  assert.equal(control?.failure?.reason, "capture-process-failed");
});

check("frozen worker handoff drains a live timer capture but ignores its reaped zombie", () => {
  const liveChildren = (mainPid, rows) => rows
    .filter((row) => String(row.pid) !== String(mainPid))
    .filter((row) => !["", "Z", "X"].includes(row.state))
    .map((row) => row.pid);
  const mainPid = 4100;
  const firstPoll = liveChildren(mainPid, [
    { pid: mainPid, state: "T" },
    { pid: 4101, state: "D", command: "captureCandidateProspectiveDeadline.cjs" },
  ]);
  const secondPoll = liveChildren(mainPid, [
    { pid: mainPid, state: "T" },
    { pid: 4101, state: "Z", command: "captureCandidateProspectiveDeadline.cjs" },
  ]);
  assert.deepEqual(firstPoll, [4101]);
  assert.deepEqual(secondPoll, []);
  assert.equal(firstPoll.length > 0 && secondPoll.length === 0, true);
  const persistentPolls = Array.from({ length: 3 }, () => firstPoll);
  assert.equal(persistentPolls.every((rows) => rows.length > 0), true);
});

check("release cleanup initializes live store paths before the strict EXIT trap", () => {
  const liveStoreAssignments = bundleRelease.match(/^LIVE_STORE_DIR="\/var\/lib\/football-predict"$/gmu) || [];
  const liveSqliteAssignments = bundleRelease.match(/^LIVE_SQLITE_PATH="\$\{LIVE_STORE_DIR\}\/football\.db"$/gmu) || [];
  const liveStoreIndex = bundleRelease.indexOf('LIVE_STORE_DIR="/var/lib/football-predict"');
  const liveSqliteIndex = bundleRelease.indexOf('LIVE_SQLITE_PATH="${LIVE_STORE_DIR}/football.db"');
  const trapIndex = bundleRelease.indexOf("trap release_exit_trap EXIT");
  assert.equal(liveStoreAssignments.length, 1);
  assert.equal(liveSqliteAssignments.length, 1);
  assert.doesNotMatch(bundleRelease, /^LIVE_SQLITE_PATH=""$/gmu);
  assert.ok(liveStoreIndex >= 0 && liveStoreIndex < trapIndex);
  assert.ok(liveSqliteIndex > liveStoreIndex && liveSqliteIndex < trapIndex);
});

check("post-swap readiness freezes only a fresh completed worker idle window and keeps heartbeat live", () => {
  const main = mainProgram(bundleRelease);
  const freezeBody = extractFunction(bundleRelease, "freeze_worker_for_readiness");
  const resumeBody = extractFunction(bundleRelease, "resume_worker_after_readiness");
  const captureRefreshBody = extractFunction(
    bundleRelease,
    "refresh_candidate_capture_heartbeat_for_readiness",
  );
  const captureValidatorBody = extractFunction(
    bundleRelease,
    "validate_candidate_capture_heartbeat_status",
  );
  const keeperStartBody = extractFunction(bundleRelease, "start_release_candidate_heartbeat_keeper");
  const workerDrainBody = extractFunction(bundleRelease, "wait_for_frozen_worker_children_to_drain");
  const workerChildBody = extractFunction(bundleRelease, "frozen_worker_live_child_pids");
  const keeperHealthBody = extractFunction(bundleRelease, "release_candidate_heartbeat_keeper_is_healthy");
  const keeperBaselineBody = extractFunction(
    bundleRelease,
    "release_candidate_heartbeat_keeper_clean_baseline",
  );
  const keeperStoppedEvidenceBody = extractFunction(
    bundleRelease,
    "release_candidate_heartbeat_keeper_clean_stop_evidence_is_valid",
  );
  const keeperFailureBody = extractFunction(
    bundleRelease,
    "release_candidate_heartbeat_keeper_has_latched_failure",
  );
  const keeperStopBody = extractFunction(bundleRelease, "stop_release_candidate_heartbeat_keeper");
  const stopBody = extractFunction(bundleRelease, "stop_worker_for_release_window");
  const officialWaitBody = extractFunction(bundleRelease, "wait_for_worker_official_publish_after");
  const readinessWaitBody = extractFunction(bundleRelease, "wait_for_worker_readiness_idle_after");
  const transitionGuardBody = extractFunction(bundleRelease, "verify_post_swap_transition_window");
  const priorityPrepareBody = extractFunction(bundleRelease, "prepare_release_worker_priority_request");
  const priorityClearBody = extractFunction(bundleRelease, "clear_release_worker_priority_request");
  assert.match(bundleRelease, /readinessIdleEvidenceAfter/);
  assert.match(bundleRelease, /RELEASE_WORKER_READINESS_IDLE_TIMEOUT_SECONDS/);
  assert.match(bundleRelease, /RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS:-600/);
  assert.match(bundleRelease, /officialPublishEvidenceAfter/);
  assert.match(bundleRelease, /RELEASE_POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS:-120/);
  assert.match(transitionGuardBody, /releaseTransitionLease\.cjs" verify/);
  assert.match(transitionGuardBody, /--required-margin-seconds "\$required_margin_seconds"/);
  assert.match(officialWaitBody, /verify_post_swap_transition_window "\$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS"/);
  assert.match(readinessWaitBody, /verify_post_swap_transition_window "\$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS"/);
  assert.doesNotMatch(officialWaitBody, /official-result-fast-published/);
  assert.match(bundleRelease, /WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS \+ POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS/);
  assert.match(priorityPrepareBody, /prepare-priority/);
  assert.match(priorityPrepareBody, /--bundle-sha "\$BUNDLE_SHA256"/);
  assert.match(priorityPrepareBody, /--release-sequence "\$RELEASE_SEQUENCE"/);
  assert.match(priorityClearBody, /rm -f -- "\$request_path"/);
  assert.match(freezeBody, /systemctl is-active --quiet "\$WORKER_SERVICE_NAME"/);
  assert.match(freezeBody, /systemctl show "\$WORKER_SERVICE_NAME" --property=MainPID --value/);
  assert.match(freezeBody, /--kill-who=main --signal=SIGSTOP/);
  assert.match(freezeBody, /worker_process_is_stopped "\$main_pid"/);
  assert.match(freezeBody, /worker_status_is_readiness_idle_after "\$worker_started_at" "\$status_file" "\$main_pid"/);
  assert.match(freezeBody, /wait_for_worker_readiness_idle_after "\$worker_started_at" "\$status_file"/);
  assertOrdered(freezeBody, [
    "--signal=SIGSTOP",
    "worker_status_is_readiness_idle_after",
    "--signal=SIGCONT",
  ], "worker idle state is revalidated after the process is frozen");
  assert.match(resumeBody, /--kill-who=main --signal=SIGCONT/);
  assert.match(resumeBody, /current_pid" = "\$WORKER_FROZEN_MAIN_PID/);
  assert.match(captureRefreshBody, /CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT/);
  assert.match(captureRefreshBody, /captureCandidateProspectiveDeadline\.cjs/);
  assert.match(captureRefreshBody, /validate_candidate_capture_heartbeat_status/);
  assert.match(captureValidatorBody, /exactHeartbeatMatches/);
  assert.match(captureValidatorBody, /requireFresh: true/);
  assert.match(captureValidatorBody, /pre-swap-legacy-top-level-due/);
  assert.match(captureValidatorBody, /allowPreSwapLegacyTopLevelDueOmission/);
  assert.match(captureValidatorBody, /validationMode === "pre-swap-legacy-top-level-due"/);
  assert.match(captureValidatorBody, /SWAP_STARTED:-0/);
  assert.match(captureValidatorBody, /expected_validation_mode="strict"/);
  assert.match(captureValidatorBody, /expected_validation_mode="pre-swap-legacy-top-level-due"/);
  assert.match(captureValidatorBody, /"\$validation_mode" = "\$expected_validation_mode"/);
  assert.match(captureValidatorBody, /systemd-run --quiet --wait --collect --pipe --service-type=exec/);
  assert.match(captureValidatorBody, /--uid=football/);
  assert.match(captureValidatorBody, /ProtectSystem=strict/);
  assert.match(captureValidatorBody, /PrivateNetwork=yes/);
  assert.match(captureValidatorBody, /ReadOnlyPaths=\$APP_DIR/);
  assert.match(captureValidatorBody, /ReadOnlyPaths=\$validator_root/);
  assert.match(captureValidatorBody, /ReadOnlyPaths=\$LIVE_STORE_DIR/);
  assert.match(captureValidatorBody, /InaccessiblePaths=-\/etc\/football-predict -\/etc\/football-release -\/var\/lib\/football-release/);
  assert.match(captureValidatorBody, /assert_transient_unit_cleared "\$unit"/);
  assert.doesNotMatch(captureValidatorBody, /ReadWritePaths|run_as_service_user/);
  assert.match(captureRefreshBody, /runtime_root="\$\{1:-\}"/);
  assert.match(captureRefreshBody, /validator_root="\$\{2:-\}"/);
  assert.match(captureRefreshBody, /\[ "\$#" -eq 2 \]/);
  assert.match(captureRefreshBody, /\[ "\$runtime_root" = "\$APP_DIR" \]/);
  assert.match(captureRefreshBody, /candidate deadline capture must use active app root/);
  assert.match(captureRefreshBody, /SWAP_STARTED:-0/);
  assert.match(captureRefreshBody, /expected_validator_root="\$APP_DIR"/);
  assert.match(captureRefreshBody, /expected_validator_root="\$NEXT_DIR"/);
  assert.match(captureRefreshBody, /validation_mode="strict"/);
  assert.match(captureRefreshBody, /validation_mode="pre-swap-legacy-top-level-due"/);
  assert.match(captureRefreshBody, /"\$validator_root" "\$validation_mode"/);
  assert.match(captureRefreshBody, /\[ "\$validator_root" = "\$expected_validator_root" \]/);
  assert.match(captureRefreshBody, /candidate deadline capture validator root does not match release phase/);
  assert.doesNotMatch(captureRefreshBody, /if \[ ! -d "\$runtime_root" \].*runtime_root="\$APP_DIR"/s);
  assert.match(captureRefreshBody, /matcher_module="\$validator_root\/scripts\/runReleaseCandidateHeartbeatKeeper\.cjs"/);
  assert.match(captureRefreshBody, /capture_script="\$runtime_root\/scripts\/captureCandidateProspectiveDeadline\.cjs"/);
  assert.match(captureRefreshBody, /collector_trust_registry="\$runtime_root\/deploy\/light-server\/collector-trust-registry\.json"/);
  assert.match(captureRefreshBody, /SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH="\$collector_trust_registry"/);
  assert.match(captureRefreshBody, /stat -c '%h' -- "\$collector_trust_registry"/);
  assert.match(captureRefreshBody, /candidate deadline capture runtime scripts are unavailable/);
  assert.doesNotMatch(captureRefreshBody, /TRUSTED_SOURCE_DIR\/scripts\/(?:captureCandidateProspectiveDeadline|runReleaseCandidateHeartbeatKeeper)\.cjs/);
  assert.equal(
    (main.match(/refresh_candidate_capture_heartbeat_for_readiness "\$APP_DIR" "\$NEXT_DIR"/g) || []).length,
    3,
    "every pre-swap live heartbeat refresh must use active capture code and the validated candidate matcher",
  );
  assert.equal(
    (main.match(/refresh_candidate_capture_heartbeat_for_readiness "\$APP_DIR" "\$APP_DIR"/g) || []).length,
    1,
    "the post-swap heartbeat refresh must use only the newly active app tree",
  );
  assert.equal(
    (main.match(/refresh_candidate_capture_heartbeat_for_readiness/g) || []).length,
    4,
    "live heartbeat refreshes must not have implicit-root call sites",
  );
  assert.match(captureRefreshBody, /RELEASE_CANDIDATE_CAPTURE_REFRESH_ATTEMPTS/);
  assert.match(captureRefreshBody, /RELEASE_CANDIDATE_CAPTURE_REFRESH_RETRY_SECONDS/);
  assert.match(captureRefreshBody, /RELEASE_CANDIDATE_CAPTURE_LOCK_TIMEOUT_MS/);
  assert.match(captureRefreshBody, /CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS="\$capture_lock_timeout_ms"/);
  assert.match(captureRefreshBody, /while \[ "\$attempt" -le "\$max_attempts" \]/);
  assert.match(captureRefreshBody, /status\/registry not yet available|registry\/status not yet available/);
  assert.match(captureRefreshBody, /attempt=\$\(\(attempt \+ 1\)\)/);
  assert.match(keeperStartBody, /--uid=football/);
  assert.match(keeperStartBody, /runReleaseCandidateHeartbeatKeeper\.cjs/);
  assert.match(keeperStartBody, /--interval-seconds "\$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS"/);
  assert.match(keeperStartBody, /--attempt-timeout-ms "\$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS"/);
  assert.match(keeperStartBody, /release_candidate_heartbeat_keeper_is_healthy/);
  assert.match(keeperStartBody, /release_candidate_heartbeat_keeper_has_latched_failure/);
  assert.doesNotMatch(keeperStartBody, /RuntimeMaxSec/);
  assert.match(keeperStartBody, /--property="KillMode=mixed"/);
  assert.match(keeperStartBody, /--property="TimeoutStopSec=35s"/);
  assert.match(keeperStartBody, /--property="MemoryHigh=900M"/);
  assert.match(keeperStartBody, /--property="MemoryMax=1200M"/);
  assert.match(keeperStartBody, /--property="MemorySwapMax=256M"/);
  assert.match(keeperStartBody, /--property="TasksMax=64"/);
  assert.match(keeperStartBody, /--property="LimitNOFILE=4096"/);
  assert.match(workerDrainBody, /--property=ControlGroup --value/);
  assert.match(workerDrainBody, /\/sys\/fs\/cgroup\$\{control_group\}\/cgroup\.procs/);
  assert.match(workerDrainBody, /WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS/);
  assert.match(workerDrainBody, /worker_process_is_stopped "\$expected_main_pid"/);
  assert.match(workerDrainBody, /frozen_worker_live_child_pids "\$expected_main_pid" "\$cgroup_file"/);
  assert.match(workerDrainBody, /timed out after %ss waiting for frozen worker children to drain/);
  assert.match(workerChildBody, /\[ "\$pid" != "\$main_pid" \]/);
  assert.match(workerChildBody, /""\|Z\|X\) continue/);
  assert.match(keeperHealthBody, /exactHeartbeatMatches/);
  assert.doesNotMatch(keeperHealthBody, /allowPreSwapLegacyTopLevelDueOmission/);
  assert.match(keeperHealthBody, /release-candidate-heartbeat-keeper-v2/);
  assert.match(keeperHealthBody, /control\?\.lastRegistryRootHash !== heartbeat\?\.audit\?\.rootHash/);
  assert.match(keeperHealthBody, /control\?\.captureSequence/);
  assert.match(keeperFailureBody, /release-candidate-heartbeat-keeper-v2/);
  assert.match(keeperFailureBody, /control\?\.state !== "failed-latched"/);
  assert.match(keeperFailureBody, /control\?\.awaitingExplicitStop !== true/);
  assert.match(keeperStopBody, /systemctl stop "\$unit"/);
  assert.match(keeperStopBody, /--kill-who=all --signal=KILL/);
  assert.match(keeperStopBody, /assert_transient_unit_cleared "\$unit"/);
  assert.match(keeperStopBody, /mode="\$\{1:-cleanup\}"/);
  assert.match(keeperStopBody, /release_candidate_heartbeat_keeper_clean_baseline/);
  assert.match(keeperStopBody, /release_candidate_heartbeat_keeper_clean_stop_evidence_is_valid/);
  assert.match(keeperBaselineBody, /verifyRegistry/);
  assert.match(keeperBaselineBody, /ledgerState\(active\) !== "ACTIVE"/);
  assert.match(keeperStoppedEvidenceBody, /control\?\.stopDrained !== true/);
  assert.match(keeperStoppedEvidenceBody, /control\?\.failure !== null/);
  assert.match(keeperStoppedEvidenceBody, /exactHeartbeatMatches/);
  assert.doesNotMatch(keeperStoppedEvidenceBody, /allowPreSwapLegacyTopLevelDueOmission/);
  assert.match(keeperStoppedEvidenceBody, /verifyRegistry/);
  assert.match(keeperStoppedEvidenceBody, /active\.ledgerId !== baseline\.activeLedgerId/);
  assert.match(keeperStoppedEvidenceBody, /heartbeat\?\.audit\?\.rootHash !== rootHash/);
  const workerFreezeIndex = main.indexOf(
    'freeze_worker_for_readiness "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"',
  );
  const workerIdleIndex = main.indexOf(
    'wait_for_worker_readiness_idle_after "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"',
  );
  const localReadinessIndex = main.indexOf(
    "scripts/verifyProductionReadiness.cjs",
    workerFreezeIndex,
  );
  const remoteReadinessIndex = main.indexOf(
    "scripts/verifyRemotePublicReadiness.cjs",
    localReadinessIndex,
  );
  const firstCaptureRefreshIndex = main.indexOf(
    "refresh_candidate_capture_heartbeat_for_readiness",
    workerIdleIndex,
  );
  const keeperStartIndex = main.indexOf("start_release_candidate_heartbeat_keeper", workerFreezeIndex);
  const workerDrainIndex = main.indexOf(
    'wait_for_frozen_worker_children_to_drain "$WORKER_FROZEN_MAIN_PID"',
    workerFreezeIndex,
  );
  const keeperHealthAfterLocalIndex = main.indexOf(
    "release_candidate_heartbeat_keeper_is_healthy",
    localReadinessIndex,
  );
  const keeperStopIndex = main.indexOf("stop_release_candidate_heartbeat_keeper clean", remoteReadinessIndex);
  assert.ok(firstCaptureRefreshIndex > workerIdleIndex && firstCaptureRefreshIndex < workerFreezeIndex);
  assert.ok(workerFreezeIndex < localReadinessIndex);
  assert.ok(workerDrainIndex > workerFreezeIndex && workerDrainIndex < keeperStartIndex);
  assert.ok(keeperStartIndex > workerFreezeIndex && keeperStartIndex < localReadinessIndex);
  assert.ok(keeperHealthAfterLocalIndex > localReadinessIndex && keeperHealthAfterLocalIndex < remoteReadinessIndex);
  assert.ok(keeperStopIndex > remoteReadinessIndex);
  assertOrdered(stopBody, [
    "stop_release_candidate_heartbeat_keeper",
    "resume_worker_after_readiness",
    "systemctl stop \"$WORKER_SERVICE_NAME\"",
  ], "worker stop thaws a readiness-frozen process before systemd stop");
  assertOrdered(main, [
    "prepare_release_worker_priority_request",
    "start_worker_for_live_release",
    "wait_for_worker_official_publish_after",
    "wait_for_worker_readiness_idle_after",
    "refresh_candidate_capture_heartbeat_for_readiness",
    'freeze_worker_for_readiness "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json"',
    'wait_for_frozen_worker_children_to_drain "$WORKER_FROZEN_MAIN_PID"',
    "start_release_candidate_heartbeat_keeper",
    "clear_release_worker_priority_request",
    "scripts/verifyProductionReadiness.cjs",
    "release_candidate_heartbeat_keeper_is_healthy",
    "scripts/verifyRemotePublicReadiness.cjs",
    "stop_release_candidate_heartbeat_keeper",
    "resume_worker_after_readiness",
    'write_recovery_phase "readiness-passed"',
  ], "worker readiness quiescence window");
  assert.match(
    main,
    /releaseTransitionLease\.cjs" verify[\s\S]*?--required-margin-seconds "\$POST_SWAP_TRANSITION_START_BUDGET_SECONDS"[\s\S]*?SWAP_STARTED=1/,
  );
});

  check("service health readiness tolerates bounded transients and preserves timeout evidence", () => {
  const main = mainProgram(bundleRelease);
  const probeBody = extractFunction(bundleRelease, "probe_health_endpoint");
  const waitBody = extractFunction(bundleRelease, "wait_for_health");
  const evidenceBody = extractFunction(bundleRelease, "persist_health_failure_evidence");
  const rollbackBody = extractFunction(bundleRelease, "rollback");

  assert.match(probeBody, /--connect-timeout 2 --max-time 8 --max-filesize 1048576/);
  assert.match(probeBody, /payload\?\.apiVersion !== "v1"/);
  assert.match(probeBody, /acceptance="\$\{2:-full\}"/);
  assert.match(probeBody, /payload\?\.status\?\.serviceOk === false/);
  assert.match(probeBody, /acceptance === "full" && payload\?\.ok === false/);
  assert.match(waitBody, /required_successes="\$\{4:-2\}"/);
  assert.match(waitBody, /acceptance="\$\{5:-full\}"/);
  assert.match(waitBody, /probe_health_endpoint "\$\{base_url\}\/api\/v1\/health" "\$acceptance"/);
  assert.match(waitBody, /consecutive_successes=\$\(\(consecutive_successes \+ 1\)\)/);
  assert.match(waitBody, /consecutive_successes=0/);
  assert.match(waitBody, /timeout_seconds" -ge 10/);
  assert.match(waitBody, /timeout_seconds" -le 600/);
  assert.match(waitBody, /persist_health_failure_evidence "\$base_url" "\$label" "\$attempt" "\$elapsed"/);
  assert.match(evidenceBody, /READINESS_EVIDENCE_ROOT/);
  assert.match(evidenceBody, /stat -c '%u:%g:%a'/);
  assert.match(evidenceBody, /systemctl show "\$observed_unit"/);
  assert.match(evidenceBody, /systemctl status "\$observed_unit"/);
  assert.match(evidenceBody, /journalctl -u "\$observed_unit" --no-pager -n 120/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{PORT\}" "preflight-before-topology-cleanup" 90 2 service/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{PORT\}" "preflight-before-build" 90 2 service/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{CANDIDATE_PORT\}" "candidate-server" 90 2 service/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{PORT\}" "post-preswap-nginx-reload" 90 2 service/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{PORT\}" "post-swap-service" 120 2 service/);
  assert.match(main, /wait_for_health "http:\/\/\$\{HOST\}:\$\{PORT\}" "post-deferred-model-catchup"[\s\\]*"\$\{RELEASE_DEFERRED_HEALTH_TIMEOUT_SECONDS:-180\}" 2 service[\s\\]*\|\| rollback "service health failed after deferred model catchup"/);
  const unitRestoreBody = extractFunction(bundleRelease, "restore_managed_unit_states_after_rollback");
  assert.match(rollbackBody, /restore_managed_unit_states_after_rollback/);
  assertOrdered(unitRestoreBody, [
    "football-predict.service",
    'wait_for_health "http://${HOST}:${PORT}" "pre-swap-restored-service" 120 2 service',
    'unit="football-sync-worker.service"',
  ], "rollback restores and health-checks the old service before resuming the original worker state");
  assert.doesNotMatch(bundleRelease, /curl -fsS --max-time 8 "\$1" >\/dev\/null/);
  });

  check("candidate refreeze refreshes its exact-revision deadline audit before candidate startup", () => {
    const catchupBody = extractFunction(bundleRelease, "run_candidate_model_artifact_catchup");
    const candidateRefreshBody = extractFunction(bundleRelease, "run_candidate_refresh_step");
    const main = mainProgram(bundleRelease);
    assertOrdered(catchupBody, [
      "run_build_step model-backtest",
      "run_build_step optimize-strategy",
      "run_build_step candidate-datastore-reconciled",
      "run_build_step candidate-deadline-capture",
      "npm\" run candidate:capture-deadline",
    ], "candidate strategy and deadline audit");
    assert.match(catchupBody, /SERVER_STORE_DIR="\$store_dir"/);
    assert.match(catchupBody, /DATASTORE_SQLITE_PATH="\$sqlite_path"/);
    assert.match(candidateRefreshBody, /--working-directory="\$NEXT_DIR"/);
    assert.match(candidateRefreshBody, /InaccessiblePaths=-\/etc\/football-predict -\/etc\/football-release -\/var\/lib\/football-predict -\/var\/lib\/football-release/);
    assert.match(main, /candidate-deadline-capture-refresh[\s\S]*?SERVER_STORE_DIR="\$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="\$CANDIDATE_SQLITE_PATH"[\s\S]*?scripts\/captureCandidateProspectiveDeadline\.cjs/);
    assertOrdered(main, [
      'run_candidate_model_artifact_catchup "$CANDIDATE_STORE_DIR" "$CANDIDATE_SQLITE_PATH"',
      'start root-owned assembled candidate',
    ], "candidate deadline audit must exist before candidate server verification");
  });

  check("candidate restores honest model-only archives before SQLite verification", () => {
    const main = mainProgram(bundleRelease);
    const refreshWindowStart = main.indexOf("sync worker could not be paused for candidate readiness");
    const refreshWindowEnd = main.indexOf("run_trusted_candidate_verifier", refreshWindowStart);
    const refreshWindow = main.slice(refreshWindowStart, refreshWindowEnd);
    assert.match(bundleRelease, /run_build_step archive-migration/);
    assert.match(bundleRelease, /PUBLIC_DATA_DIR="\$BUILD_DIR\/public\/data"/);
    assert.match(bundleRelease, /ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR="\$BUILD_DIR\/\.release-archive-evidence"/);
    assert.match(bundleRelease, /npm" run datastore:migrate-archives/);
    assert.match(bundleRelease, /signed pre-match archive evidence could not be preserved/);
    assert.match(bundleRelease, /signed current archive evidence could not be preserved/);
    assert.match(bundleRelease, /candidate pre-match archive migration failed/);
    assert.match(bundleRelease, /ARCHIVE_MIGRATION_CAPTURED_AT="\$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT"/);
    assert.match(bundleRelease, /ReadOnlyPaths=\$BUILD_DIR\/\.release-archive-evidence/);
    assert.equal(
      (main.match(/CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT="\$\("/g) || []).length,
      1,
      "the dynamic archive refresh must capture exactly one immutable evaluation instant"
    );
    assert.deepEqual(
      [...refreshWindow.matchAll(/"\$NODE_HOME\/bin\/npm" run ([^\s\\]+)/g)]
        .map((match) => match[1]),
      ["datastore:migrate-archives", "datastore:sqlite"],
      "the stopped-worker refresh window may attach existing archives, rebuild SQLite, and capture the same-asOf deadline only"
    );
    assert.doesNotMatch(
      refreshWindow,
      /preserve_live_public_data_cache|sync:data|collectSportterySnapshot|model:backtest|optimize:strategy/,
      "the cutoff refresh must not collect, predict, optimize, or import mutable live cache data"
    );
    assertOrdered(main, [
      '"$BUILD_DIR/.release-archive-evidence/prediction-snapshots.json"',
      '"$BUILD_DIR/.release-archive-evidence/matches-current.json"',
      'preserve_live_public_data_cache "$APP_DIR" "$BUILD_DIR"',
      "run_build_step archive-migration",
      "run_build_step candidate-datastore",
      'start root-owned assembled candidate',
    ], "preserved snapshots must repair archives before candidate SQLite and API verification");
    assertOrdered(main, [
      'wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server"',
      "candidate transition lease instant could not be captured",
      "releaseTransitionLease.cjs\" create",
      "candidate transition horizon is unsafe before worker pause",
      "sync worker could not be paused for candidate readiness",
      "candidate deadline capture heartbeat refresh failed after candidate worker freeze",
      "candidate could not stop for archive refresh",
      "candidate-archive-refresh",
      'PUBLIC_DATA_DIR="$NEXT_DIR/public/data"',
      'ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR="$BUILD_DIR/.release-archive-evidence"',
      'ARCHIVE_MIGRATION_CAPTURED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT"',
      "candidate-sqlite-refresh",
      'DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH"',
      "candidate-deadline-capture-refresh",
      'CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT"',
      'node" scripts/captureCandidateProspectiveDeadline.cjs',
      "refreshed candidate transient unit failed to start",
      'wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server-refreshed"',
      "run_trusted_candidate_verifier",
    ], "a stopped candidate reattaches only existing pre-cutoff evidence, refreshes SQLite, restarts healthy, then verifies");
    assert.match(main, /candidate pre-verification archive refresh failed/);
    assert.match(main, /candidate sqlite refresh after archive migration failed/);
    assert.match(main, /candidate deadline capture failed at archive refresh instant/);
    assert.match(main, /refreshed candidate transient unit failed to start/);
    assert.match(main, /refreshed candidate health failed/);
  });

  check("candidate transition lease bounds refresh, verifier runtime, and the final atomic swap", () => {
    const main = mainProgram(bundleRelease);
    const verifierBody = extractFunction(bundleRelease, "run_trusted_candidate_verifier");
    assert.match(verifierBody, /RuntimeMaxSec=\$\{CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS\}s/);
    const refreshBody = extractFunction(bundleRelease, "run_candidate_refresh_step");
    assert.match(refreshBody, /RuntimeMaxSec=\$\{CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS\}s/);
    assert.match(bundleRelease, /RELEASE_CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS:-600/);
    assert.match(bundleRelease, /RELEASE_CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS:-420/);
    assert.match(bundleRelease, /RELEASE_CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS:-30/);
    assert.match(bundleRelease, /RELEASE_CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS:-90/);
    assert.match(main, /--verifier-runtime-max-seconds "\$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS"/);
    assert.match(main, /--preverify-refresh-budget-seconds "\$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS"/);
    assert.match(main, /--atomic-swap-margin-seconds "\$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS"/);
    assert.equal(
      (main.match(/CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT="\$\("/g) || []).length,
      1,
      "archive migration and deadline capture must share the one pre-pause asOf"
    );
    assertOrdered(main, [
      'wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server"',
      "CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT=",
      'releaseTransitionLease.cjs" create',
      "candidate transition horizon is unsafe before worker pause",
      "sync worker could not be paused for candidate readiness",
      "candidate deadline capture heartbeat refresh failed after candidate worker freeze",
      'ARCHIVE_MIGRATION_CAPTURED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT"',
      'CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT"',
      "run_trusted_candidate_verifier",
      "cleanup_build_tree",
      'write_recovery_phase "swap-starting"',
      'releaseTransitionLease.cjs" verify',
      "candidate transition crossed or atomic swap margin expired",
      "SWAP_STARTED=1",
    ], "lease is acquired before worker pause and revalidated immediately before swap");
    const pausedWindowStart = main.indexOf("sync worker could not be paused for candidate readiness");
    const swapStart = main.indexOf("SWAP_STARTED=1", pausedWindowStart);
    const pausedWindow = main.slice(pausedWindowStart, swapStart);
    assert.doesNotMatch(
      pausedWindow,
      /\bsleep\b/,
      "release must never wait for a transition window after pausing the worker"
    );
  });

  check("signed release installs static SPA continuity before pausing the live service", () => {
  const main = mainProgram(bundleRelease);
  assertOrdered(main, [
    'write_recovery_phase "candidate-validated"',
    "HOST_CONFIG_DIRTY=1",
    'write_recovery_phase "host-config-changing"',
    'install_systemd_units "$TRUSTED_SOURCE_DIR"',
    'install_nginx_config "$TRUSTED_SOURCE_DIR"',
    "systemctl daemon-reload",
    'write_recovery_phase "host-config-applied"',
    'wait_for_health "http://${HOST}:${PORT}" "post-preswap-nginx-reload"',
    'stop_service_for_release_window',
    "SWAP_STARTED=1",
  ], "nginx SPA continuity must be active and healthy before the service pause");
});

check("post-swap cutover verifies permissions without repeating recursive tree repair or host reload", () => {
  const main = mainProgram(bundleRelease);
  const stopAt = main.indexOf("stop_service_for_release_window || abort_before_swap");
  const healthyAt = main.indexOf('wait_for_health "http://${HOST}:${PORT}" "post-swap-service"', stopAt);
  assert.ok(stopAt >= 0 && healthyAt > stopAt);
  const outageWindow = main.slice(stopAt, healthyAt);
  assert.match(outageWindow, /verify_store_write_permissions/);
  assert.match(outageWindow, /verify_worker_write_permissions/);
  assert.doesNotMatch(outageWindow, /fix_store_permissions/);
  assert.doesNotMatch(outageWindow, /fix_app_permissions/);
  assert.doesNotMatch(outageWindow, /fix_worker_write_permissions/);
  assert.doesNotMatch(outageWindow, /install_systemd_units/);
  assert.doesNotMatch(outageWindow, /install_nginx_config/);
  const permissionProbe = extractFunction(bundleRelease, "verify_store_write_permissions");
  assert.match(permissionProbe, /runuser -u football/);
  assert.match(permissionProbe, /release-write-probe/);
  assert.match(bundleRelease, /fs\.accessSync\(sqlitePath, fs\.constants\.R_OK \| fs\.constants\.W_OK\)/);
});

check("external model artifacts are validated and exactly restored without rollback code execution", () => {
  const main = mainProgram(bundleRelease);
  const snapshotBody = extractFunction(bundleRelease, "snapshot_external_model_artifacts_for_rollback");
  const restoreBody = extractFunction(bundleRelease, "restore_external_model_artifacts_after_rollback");
  const rollbackBody = extractFunction(bundleRelease, "rollback");
  assert.match(bundleRelease, /MODEL_ARTIFACT_TOKENS=\(strategy evaluation candidate-registry candidate-challenger-suite candidate-temperature-suite candidate-common-cohort-g2-v1 candidate-common-cohort-g2-v2 candidate-capture-status benchmark-prospective-ledger\)/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-strategy\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/evaluation\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/candidate-prospective-registry\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/candidate-prospective-challenger-suite\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/candidate-prospective-temperature-neutralization-suite\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/candidate-common-cohort-shadow-g2\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/candidate-common-cohort-shadow-g2-v2\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/candidate-prospective-capture-status\.json/);
  assert.match(bundleRelease, /\/var\/lib\/football-predict\/model-artifacts\/benchmark-prospective-ledger\.json/);
  assert.match(releaseRecovery, /\["candidate-registry", `\$\{STORE_PATH\}\/model-artifacts\/candidate-prospective-registry\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-challenger-suite", `\$\{STORE_PATH\}\/model-artifacts\/candidate-prospective-challenger-suite\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-temperature-suite", `\$\{STORE_PATH\}\/model-artifacts\/candidate-prospective-temperature-neutralization-suite\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-common-cohort-g2-v1", `\$\{STORE_PATH\}\/model-artifacts\/candidate-common-cohort-shadow-g2\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-common-cohort-g2-v2", `\$\{STORE_PATH\}\/model-artifacts\/candidate-common-cohort-shadow-g2-v2\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-capture-status", `\$\{STORE_PATH\}\/candidate-prospective-capture-status\.json`\]/);
  assert.match(releaseRecovery, /\["benchmark-prospective-ledger", `\$\{STORE_PATH\}\/model-artifacts\/benchmark-prospective-ledger\.json`\]/);
  assert.match(releaseRecovery, /\["candidate-common-cohort-g2", COMMON_COHORT_G2_V1_PATH\]/);
  assert.match(releaseRecovery, /const LEGACY_MODEL_ARTIFACT_COUNTS = new Set\(\[2, 4, 5, 6, 7\]\)/);
  assert.doesNotMatch(bundleRelease, /hhad[_-]companion[_-]audit/i);
  assert.match(snapshotBody, /--no-dereference/);
  assert.match(snapshotBody, /stat -c '%h'/);
  assert.match(snapshotBody, /stat -c '%s'/);
  assert.match(snapshotBody, /sha256sum/);
  assert.match(snapshotBody, /\$\{#MODEL_ARTIFACT_TOKENS\[@\]\}[^\n]*-eq[^\n]*\$\{#MODEL_ARTIFACT_PATHS\[@\]\}/);
  assert.match(restoreBody, /\$\{#MODEL_ARTIFACT_TOKENS\[@\]\}[^\n]*-eq[^\n]*\$\{#MODEL_ARTIFACT_PATHS\[@\]\}/);
  assert.match(restoreBody, /line_count[^\n]*-eq "\$\{#MODEL_ARTIFACT_TOKENS\[@\]\}"/);
  assert.match(restoreBody, /actual_digest=.*sha256sum/);
  assertOrdered(restoreBody, [
    "while IFS=$'\\t' read -r token artifact_path present bytes digest uid gid mode extra",
    '[ "$line_count" -eq "${#MODEL_ARTIFACT_TOKENS[@]}" ]',
    'temporary="$(mktemp',
    'mv -fT -- "$temporary" "$artifact_path"',
  ], "external model artifact recovery validates all snapshots before mutation");
  assertOrdered(main, [
    "quiesce_managed_maintenance_for_sqlite_snapshot",
    "stop_service_for_release_window",
    "snapshot_external_model_artifacts_for_rollback",
    'candidateReleaseContinuity.cjs" snapshot',
    "verify_live_sqlite_prebuild_after_freeze",
    "SWAP_STARTED=1",
    "refresh_live_store_after_swap",
  ], "external model artifacts are snapshotted before any live refresh");
  assertOrdered(rollbackBody, [
    "restore_live_sqlite_after_rollback",
    "restore_external_model_artifacts_after_rollback",
    "restore_runtime_env_after_rollback",
  ], "external model artifacts are restored inside the rollback transaction");
  assert.doesNotMatch(rollbackBody, /restore_model_artifacts_after_rollback|run_model_artifact_catchup|sync_model_artifact_mirrors/);
});

check("candidate ledger continuity is snapshotted before mutation and verified before public readiness", () => {
  const main = mainProgram(bundleRelease);
  assert.match(bundleRelease, /scripts\/candidateReleaseContinuity\.cjs" snapshot/);
  assert.match(bundleRelease, /scripts\/candidateReleaseContinuity\.cjs" verify/);
  assert.match(bundleRelease, /candidate-release-continuity-before\.json/);
  assert.match(bundleRelease, /candidate-release-continuity-after\.json/);
  assert.match(bundleRelease, /\.release-candidate-continuity\.json/);
  assertOrdered(main, [
    "sync worker could not be paused before live SQLite prebuild",
    "stop_service_for_release_window",
    "snapshot_external_model_artifacts_for_rollback",
    'candidateReleaseContinuity.cjs" snapshot',
    "SWAP_STARTED=1",
    'refresh_candidate_capture_heartbeat_for_readiness',
    'candidateReleaseContinuity.cjs" verify',
    '"${APP_DIR}/.release-candidate-continuity.json"',
    "verify public origin",
    "resume_worker_after_readiness",
  ], "candidate continuity must cover the complete mutation window while the worker is frozen");
  assert.match(bundleRelease, /\|\| abort_before_swap "candidate release continuity baseline could not be captured"/);
  assert.match(bundleRelease, /\|\| rollback "candidate release continuity verification failed"/);
  assert.match(bundleRelease, /--registry "\$RECOVERY_DIR\/external-model-artifacts\/candidate-registry"/);
  assert.match(bundleRelease, /--bundle-sha256 "\$BUNDLE_SHA256"/);
  assert.match(bundleRelease, /--release-sequence "\$RELEASE_SEQUENCE"/);
  assert.match(bundleRelease, /mv -fT -- "\$\{APP_DIR\}\/\.release-candidate-continuity\.next"/);
  assert.match(bundleRelease, /stat -c '%u:%g:%a:%h'/);
  assert.match(bundleRelease, /sync -f "\$\{APP_DIR\}\/\.release-candidate-continuity\.json"/);
});

check("signed release uploads retry transient SCP disconnects without bypassing host-key pinning", () => {
  const deployReleaseBundle = readText(deployReleaseBundlePath);
  assert.match(deployReleaseBundle, /RELEASE_DEPLOY_UPLOAD_ATTEMPTS/);
  assert.match(deployReleaseBundle, /RELEASE_DEPLOY_UPLOAD_RETRY_DELAY_MS/);
  assert.match(deployReleaseBundle, /for \(let attempt = 1; attempt <= uploadAttempts; attempt \+= 1\)/);
  assert.match(deployReleaseBundle, /if \(upload\.status === 0 \|\| upload\.dryRun\) break/);
  assert.match(deployReleaseBundle, /sleepSync\(uploadRetryDelayMs\)/);
  assert.match(deployReleaseBundle, /attempts: uploadRuns/);
  assert.match(deployReleaseBundle, /buildPinnedSshBaseOptions/);
  assert.match(deployReleaseBundle, /\.\.\.baseSshOptions/);
  assert.doesNotMatch(deployReleaseBundle, /StrictHostKeyChecking=(?:no|accept-new)/);
});

for (const result of checks) {
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    console.error(`FAIL ${result.name}`);
    console.error(result.error?.stack || result.error);
  }
}

const failed = checks.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`release transaction safety verification failed: ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}

console.log(`release transaction safety verification passed: ${checks.length}/${checks.length} checks`);
