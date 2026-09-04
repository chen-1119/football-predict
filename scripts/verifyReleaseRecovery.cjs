const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const helperPath = path.join(rootDir, "deploy", "light-server", "football-release-recovery.cjs");
const helperSource = fs.readFileSync(helperPath, "utf8");
const bundleSha = "a".repeat(64);
const hhadCompanionAuditArtifactKey = "hhad-companion-audit";
const liveSqliteFixture = `sqlite image after release\nprivate_model_artifacts:${hhadCompanionAuditArtifactKey}=new-hhad-companion-audit\n`;
const rollbackSqliteFixture = `sqlite image before release\nprivate_model_artifacts:${hhadCompanionAuditArtifactKey}=old-hhad-companion-audit\n`;

const rollbackPhases = [
  "prepared",
  "runtime-env-updating",
  "runtime-env-updated",
  "candidate-validated",
  "host-config-changing",
  "host-config-applied",
  "external-model-artifacts-snapshotted",
  "sqlite-snapshotted",
  "swap-starting",
  "swap-complete",
  "readiness-passed",
  "rollback-starting",
  "recovering-rollback",
  "rolled-back"
];
const preSwapPhases = new Set(rollbackPhases.slice(0, 8));
const sqlitePhases = new Set(rollbackPhases.slice(7));
const modelPhases = new Set(rollbackPhases.slice(6));
const forwardPhases = ["finalizing", "committed", "recovering-commit"];

const managedConfigPaths = [
  "/etc/systemd/system/football-predict.service",
  "/etc/systemd/system/football-sync-worker.service",
  "/etc/systemd/system/football-cleanup.service",
  "/etc/systemd/system/football-cleanup.timer",
  "/etc/systemd/system/football-monitor.service",
  "/etc/systemd/system/football-monitor.timer",
  "/etc/nginx/conf.d/football-predict-common.conf",
  "/etc/nginx/snippets/football-predict-server.conf",
  "/etc/nginx/snippets/football-predict-security-headers.conf",
  "/etc/nginx/sites-available/football-predict",
  "/etc/nginx/sites-enabled/default",
  "/etc/nginx/sites-enabled/football-predict"
];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const mapped = (root, absolutePath) => path.join(root, absolutePath.slice(1));
const octalMode = (target) => (fs.lstatSync(target).mode & 0o7777).toString(8);

const mkdir = (target, mode = 0o700) => {
  fs.mkdirSync(target, { recursive: true, mode });
  try { fs.chmodSync(target, mode); } catch {}
};

const write = (target, value, mode = 0o600) => {
  mkdir(path.dirname(target));
  fs.writeFileSync(target, value, { mode });
  try { fs.chmodSync(target, mode); } catch {}
};

const identityFor = (treePath, recordedPath) => {
  const treeMarkerPath = path.join(treePath, ".release-tree-identity");
  if (!fs.existsSync(treeMarkerPath)) {
    fs.writeFileSync(treeMarkerPath, `${crypto.randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  }
  const stat = fs.lstatSync(treePath, { bigint: true });
  return {
    path: recordedPath,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: Number(stat.mode & 0o7777n).toString(8),
    treeMarker: fs.readFileSync(treeMarkerPath, "utf8").trim(),
    bundleMarker: "-",
    liveMarker: "-"
  };
};

const defaultSystemState = () => ({
  health: true,
  nginxValid: true,
  mountpoints: [],
  units: {
    "football-predict.service": { exists: true, enabled: true, active: true },
    "football-sync-worker.service": { exists: true, enabled: true, active: true },
    "football-cleanup.service": { exists: true, enabled: false, active: false },
    "football-monitor.service": { exists: true, enabled: false, active: false },
    "football-cleanup.timer": { exists: true, enabled: true, active: true },
    "football-monitor.timer": { exists: true, enabled: false, active: false },
    "nginx.service": { exists: true, enabled: true, active: true },
    [`football-release-${bundleSha.slice(0, 12)}-candidate.service`]: { exists: true, enabled: false, active: true }
  }
});

const createFixture = (phase, { health = true, modelArtifactCount = 2, legacyManagedConfig = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-recovery-"));
  const current = mapped(root, "/var/lib/football-release/recovery/current");
  const recoveryRoot = path.dirname(current);
  mkdir(recoveryRoot, 0o700);
  mkdir(current, 0o700);
  write(mapped(root, "/etc/football-release/expected-site"), "football-predict\n", 0o644);
  write(mapped(root, "/etc/football-release/expected-channel"), "production\n", 0o644);

  const app = mapped(root, "/opt/football-predict");
  const next = mapped(root, "/opt/football-predict.next");
  const backup = mapped(root, "/opt/football-predict.previous");
  const failed = mapped(root, "/opt/football-predict.failed");
  mkdir(path.dirname(app), 0o755);
  mkdir(app, 0o755);
  mkdir(next, 0o755);
  write(path.join(app, "tree-id"), "old\n", 0o644);
  write(path.join(next, "tree-id"), "new\n", 0o644);
  const oldIdentity = identityFor(app, "/opt/football-predict");
  const newIdentity = identityFor(next, "/opt/football-predict.next");
  const postSwap = !preSwapPhases.has(phase) || forwardPhases.includes(phase);
  if (postSwap) {
    fs.renameSync(app, backup);
    fs.renameSync(next, app);
  }
  if (forwardPhases.includes(phase)) {
    write(path.join(app, ".release-bundle-sha256"), `${bundleSha}\n`, 0o644);
    write(path.join(app, ".release-live-complete"), `${bundleSha}\n`, 0o644);
  }

  for (const [name, value] of [
    ["transaction-version", "3"],
    ["bundle-sha256", bundleSha],
    ["site", "football-predict"],
    ["channel", "production"],
    ["release-sequence", "42"],
    ["phase", phase]
  ]) write(path.join(current, name), `${value}\n`);
  mkdir(path.join(current, "trees"), 0o700);
  write(path.join(current, "trees", "old-app.json"), `${JSON.stringify(oldIdentity)}\n`);
  write(path.join(current, "trees", "new-app.json"), `${JSON.stringify(newIdentity)}\n`);

  const envTarget = mapped(root, "/etc/football-predict/env");
  mkdir(path.dirname(envTarget), 0o750);
  write(envTarget, "RELEASE_STATE=new\n", 0o600);
  const envSnapshot = "RELEASE_STATE=old\n";
  const envStat = fs.lstatSync(envTarget);
  const envDir = path.join(current, "runtime-env");
  mkdir(envDir, 0o700);
  write(path.join(envDir, "env"), envSnapshot);
  write(path.join(envDir, "manifest.tsv"), [
    "env",
    "/etc/football-predict/env",
    "1",
    String(Buffer.byteLength(envSnapshot)),
    sha256(envSnapshot),
    String(envStat.uid),
    String(envStat.gid),
    octalMode(envTarget)
  ].join("\t") + "\n");
  const envParentStat = fs.lstatSync(path.dirname(envTarget));
  write(path.join(envDir, "parent-state"), "present\n");
  write(path.join(envDir, "parent-metadata"), `${envParentStat.uid} ${envParentStat.gid} ${octalMode(path.dirname(envTarget))}\n`);

  const configDir = path.join(current, "managed-config");
  const configEntries = path.join(configDir, "entries");
  mkdir(configEntries, 0o700);
  managedConfigPaths.forEach((target) => mkdir(path.dirname(mapped(root, target)), 0o755));
  const fixtureManagedConfigPaths = legacyManagedConfig
    ? managedConfigPaths.filter((target) => target !== "/etc/nginx/sites-enabled/default")
    : managedConfigPaths;
  write(path.join(configDir, "manifest.tsv"), fixtureManagedConfigPaths
    .map((target, index) => `${index + 1}\tabsent\t${target}\t-\t-`)
    .join("\n") + "\n");
  write(path.join(configDir, "timers.tsv"), [
    "football-cleanup.timer\t1\t1",
    "football-monitor.timer\t0\t0"
  ].join("\n") + "\n");
  write(path.join(configDir, "units.tsv"), [
    "football-predict.service\t1\t1",
    "football-sync-worker.service\t1\t1",
    "nginx.service\t1\t1"
  ].join("\n") + "\n");

  const store = mapped(root, "/var/lib/football-predict");
  mkdir(store, 0o750);
  const sqliteTarget = path.join(store, "football.db");
  write(sqliteTarget, liveSqliteFixture, 0o640);
  if (sqlitePhases.has(phase) || forwardPhases.includes(phase)) {
    const sqliteDir = path.join(current, "sqlite");
    mkdir(sqliteDir, 0o700);
    const sqliteSnapshot = rollbackSqliteFixture;
    write(path.join(sqliteDir, "football.db"), sqliteSnapshot);
    write(path.join(sqliteDir, "live-path"), "/var/lib/football-predict/football.db\n");
    const targetStat = fs.lstatSync(sqliteTarget);
    write(path.join(sqliteDir, "manifest.tsv"), [
      ["base", "1", String(Buffer.byteLength(sqliteSnapshot)), sha256(sqliteSnapshot), String(targetStat.uid), String(targetStat.gid), octalMode(sqliteTarget)].join("\t"),
      "wal\t0\t-\t-\t-\t-\t-",
      "shm\t0\t-\t-\t-\t-\t-"
    ].join("\n") + "\n");
  }

  const strategyTarget = path.join(store, "model-strategy.json");
  const evaluationTarget = path.join(store, "model-artifacts", "evaluation.json");
  const registryTarget = path.join(store, "model-artifacts", "candidate-prospective-registry.json");
  const challengerTarget = path.join(store, "model-artifacts", "candidate-prospective-challenger-suite.json");
  const temperatureSuiteTarget = path.join(store, "model-artifacts", "candidate-prospective-temperature-neutralization-suite.json");
  const commonCohortG2V1Target = path.join(store, "model-artifacts", "candidate-common-cohort-shadow-g2.json");
  const commonCohortG2V2Target = path.join(store, "model-artifacts", "candidate-common-cohort-shadow-g2-v2.json");
  const captureStatusTarget = path.join(store, "candidate-prospective-capture-status.json");
  const benchmarkProspectiveTarget = path.join(store, "model-artifacts", "benchmark-prospective-ledger.json");
  mkdir(path.dirname(evaluationTarget), 0o750);
  write(strategyTarget, "{\"state\":\"new\"}\n", 0o640);
  write(evaluationTarget, "{\"state\":\"new\"}\n", 0o640);
  write(registryTarget, "{\"state\":\"registry-new\"}\n", 0o640);
  write(challengerTarget, "{\"state\":\"challenger-new\"}\n", 0o640);
  write(temperatureSuiteTarget, "{\"state\":\"temperature-new\"}\n", 0o640);
  write(commonCohortG2V1Target, "{\"state\":\"common-cohort-v1-new\"}\n", 0o640);
  write(commonCohortG2V2Target, "{\"state\":\"common-cohort-v2-new\"}\n", 0o640);
  write(captureStatusTarget, "{\"state\":\"capture-status-new\"}\n", 0o640);
  write(benchmarkProspectiveTarget, "{\"state\":\"benchmark-prospective-new\"}\n", 0o640);
  if (modelPhases.has(phase) || forwardPhases.includes(phase)) {
    assert.ok([2, 4, 5, 6, 7, 9].includes(modelArtifactCount), "model artifact fixture must use a supported contract length");
    const modelDir = path.join(current, "external-model-artifacts");
    mkdir(modelDir, 0o700);
    const artifacts = [
      {
        token: "strategy",
        recordedPath: "/var/lib/football-predict/model-strategy.json",
        target: strategyTarget,
        snapshot: "{\"state\":\"old\"}\n",
      },
      {
        token: "evaluation",
        recordedPath: "/var/lib/football-predict/model-artifacts/evaluation.json",
        target: evaluationTarget,
        snapshot: null,
      },
      {
        token: "candidate-registry",
        recordedPath: "/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json",
        target: registryTarget,
        snapshot: "{\"state\":\"registry-old\"}\n",
      },
      {
        token: "candidate-challenger-suite",
        recordedPath: "/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json",
        target: challengerTarget,
        snapshot: null,
      },
      {
        token: "candidate-temperature-suite",
        recordedPath: "/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json",
        target: temperatureSuiteTarget,
        snapshot: "{\"state\":\"temperature-old\"}\n",
      },
    ];
    if (modelArtifactCount <= 5) {
      artifacts.length = modelArtifactCount;
    } else if (modelArtifactCount === 6) {
      artifacts.push({
        token: "candidate-common-cohort-g2",
        recordedPath: "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json",
        target: commonCohortG2V1Target,
        snapshot: "{\"state\":\"common-cohort-v1-old\"}\n",
      });
    } else if (modelArtifactCount >= 7) {
      artifacts.push(
        {
          token: "candidate-common-cohort-g2-v1",
          recordedPath: "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json",
          target: commonCohortG2V1Target,
          snapshot: "{\"state\":\"common-cohort-v1-old\"}\n",
        },
        {
          token: "candidate-common-cohort-g2-v2",
          recordedPath: "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json",
          target: commonCohortG2V2Target,
          snapshot: "{\"state\":\"common-cohort-v2-old\"}\n",
        },
      );
      if (modelArtifactCount === 9) {
        artifacts.push(
          {
            token: "candidate-capture-status",
            recordedPath: "/var/lib/football-predict/candidate-prospective-capture-status.json",
            target: captureStatusTarget,
            snapshot: "{\"state\":\"capture-status-old\"}\n",
          },
          {
            token: "benchmark-prospective-ledger",
            recordedPath: "/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json",
            target: benchmarkProspectiveTarget,
            snapshot: null,
          },
        );
      }
    }
    const manifestRows = artifacts.map((artifact) => {
      if (artifact.snapshot === null) {
        return [artifact.token, artifact.recordedPath, "0", "-", "-", "-", "-", "-"].join("\t");
      }
      write(path.join(modelDir, artifact.token), artifact.snapshot);
      const targetStat = fs.lstatSync(artifact.target);
      return [
        artifact.token,
        artifact.recordedPath,
        "1",
        String(Buffer.byteLength(artifact.snapshot)),
        sha256(artifact.snapshot),
        String(targetStat.uid),
        String(targetStat.gid),
        octalMode(artifact.target),
      ].join("\t");
    });
    write(path.join(modelDir, "manifest.tsv"), `${manifestRows.join("\n")}\n`);
  }

  const systemState = defaultSystemState();
  systemState.health = health;
  write(mapped(root, "/mock-systemd.json"), `${JSON.stringify(systemState, null, 2)}\n`);
  return {
    root,
    current,
    app,
    next,
    backup,
    failed,
    envTarget,
    sqliteTarget,
    strategyTarget,
    evaluationTarget,
    registryTarget,
    challengerTarget,
    temperatureSuiteTarget,
    commonCohortG2V1Target,
    commonCohortG2V2Target,
    captureStatusTarget,
    benchmarkProspectiveTarget,
  };
};

const runRecovery = (fixture) => spawnSync(process.execPath, [helperPath], {
  cwd: rootDir,
  encoding: "utf8",
  env: {
    ...process.env,
    FOOTBALL_RELEASE_RECOVERY_TEST_MODE: "1",
    FOOTBALL_RELEASE_RECOVERY_TEST_ROOT: fixture.root
  }
});

const readTreeId = (tree) => fs.readFileSync(path.join(tree, "tree-id"), "utf8").trim();
const assertAbsent = (target) => assert.equal(fs.existsSync(target), false, `expected absent: ${target}`);

let assertions = 0;
{
  const start = helperSource.indexOf("const recoverForward =");
  const end = helperSource.indexOf("\nconst recover =", start);
  const body = helperSource.slice(start, end);
  assert.ok(start >= 0 && body.indexOf("system.waitForHealth()") < body.indexOf("for (const timer of TIMER_UNITS)"),
    "roll-forward must prove health before enabling timers");
  assertions += 1;
}
for (const phase of rollbackPhases) {
  const fixture = createFixture(phase);
  try {
    const first = runRecovery(fixture);
    assert.equal(first.status, 0, `${phase}: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).action, "rollback", phase);
    assert.equal(readTreeId(fixture.app), "old", phase);
    assertAbsent(fixture.current);
    assertAbsent(fixture.failed);
    assert.equal(fs.readFileSync(fixture.envTarget, "utf8"), "RELEASE_STATE=old\n", phase);
    if (sqlitePhases.has(phase)) {
      const restoredSqlite = fs.readFileSync(fixture.sqliteTarget, "utf8");
      assert.equal(restoredSqlite, rollbackSqliteFixture, phase);
      assert.match(restoredSqlite, /private_model_artifacts:hhad-companion-audit=old-hhad-companion-audit/, `${phase}: HHAD private artifact table must follow the SQLite rollback image`);
      const recoveredSystemState = JSON.parse(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"));
      assert.equal(recoveredSystemState.publicationAffinityRebuilds, 1, `${phase}: serving-generation SQLite must be rebuilt before restart`);
    }
    if (modelPhases.has(phase)) {
      assert.equal(fs.readFileSync(fixture.strategyTarget, "utf8"), "{\"state\":\"old\"}\n", phase);
      assertAbsent(fixture.evaluationTarget);
    }
    const second = runRecovery(fixture);
    assert.equal(second.status, 0, `${phase} idempotence: ${second.stderr}`);
    assert.equal(JSON.parse(second.stdout).action, "noop", `${phase} idempotence`);
    assertions += sqlitePhases.has(phase) ? 10 : 9;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("candidate-validated");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    fs.rmSync(fixture.next, { recursive: true, force: true });
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `disposed pre-swap candidate recovery: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, "rollback");
    assert.equal(readTreeId(fixture.app), "old");
    assertAbsent(fixture.current);
    assertAbsent(fixture.failed);
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("candidate-validated");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    const mockPath = mapped(fixture.root, "/mock-systemd.json");
    const before = fs.readFileSync(mockPath, "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "missing candidate identity with live NEXT must be rejected");
    assert.match(result.stderr, /required new-app app identity is missing/);
    assert.equal(readTreeId(fixture.app), "old");
    assert.equal(readTreeId(fixture.next), "new");
    assert.equal(fs.readFileSync(mockPath, "utf8"), before,
      "identity rejection must happen before quiesce or restore");
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("candidate-validated", { legacyManagedConfig: true });
  try {
    const unmanagedLegacyDefault = mapped(fixture.root, "/etc/nginx/sites-enabled/default");
    write(unmanagedLegacyDefault, "legacy-unmanaged-default\n", 0o644);
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `legacy managed config recovery: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, "rollback");
    assert.equal(fs.readFileSync(unmanagedLegacyDefault, "utf8"), "legacy-unmanaged-default\n");
    assertAbsent(fixture.current);
    assertions += 4;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("candidate-validated", { legacyManagedConfig: true });
  try {
    const manifestPath = path.join(fixture.current, "managed-config", "manifest.tsv");
    const beforeSystemState = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace(
      "/etc/nginx/sites-enabled/football-predict",
      "/etc/nginx/sites-enabled/untrusted"
    ));
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unknown legacy config target must be rejected");
    assert.match(result.stderr, /managed config manifest order mismatch/);
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), beforeSystemState);
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("recovering-rollback");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    fs.rmSync(fixture.app, { recursive: true, force: true });
    fs.renameSync(fixture.backup, fixture.app);
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `converged rollback resume: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, "rollback");
    assert.equal(readTreeId(fixture.app), "old");
    assertAbsent(fixture.current);
    assertAbsent(fixture.failed);
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("recovering-rollback");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    fs.rmSync(fixture.app, { recursive: true, force: true });
    fs.renameSync(fixture.backup, fixture.app);
    fs.rmSync(path.join(fixture.current, "sqlite"), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.current, "external-model-artifacts"), { recursive: true, force: true });
    const sqliteBefore = fs.readFileSync(fixture.sqliteTarget, "utf8");
    const strategyBefore = fs.readFileSync(fixture.strategyTarget, "utf8");
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `converged pre-snapshot rollback resume: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, "rollback");
    assert.equal(fs.readFileSync(fixture.sqliteTarget, "utf8"), sqliteBefore);
    assert.equal(fs.readFileSync(fixture.strategyTarget, "utf8"), strategyBefore);
    assertAbsent(fixture.current);
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("recovering-rollback");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    fs.rmSync(fixture.app, { recursive: true, force: true });
    fs.renameSync(fixture.backup, fixture.app);
    fs.rmSync(path.join(fixture.current, "external-model-artifacts"), { recursive: true, force: true });
    const beforeSystemState = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "sqlite-only rollback snapshot layout must be rejected");
    assert.match(result.stderr, /sqlite rollback snapshot exists without its preceding model snapshot/);
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), beforeSystemState);
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("recovering-rollback");
  try {
    fs.rmSync(path.join(fixture.current, "trees", "new-app.json"));
    const mockPath = mapped(fixture.root, "/mock-systemd.json");
    const before = fs.readFileSync(mockPath, "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "missing candidate identity with post-swap topology must be rejected");
    assert.match(result.stderr, /required new-app app identity is missing/);
    assert.equal(readTreeId(fixture.app), "new");
    assert.equal(readTreeId(fixture.backup), "old");
    assert.equal(fs.readFileSync(mockPath, "utf8"), before,
      "post-swap identity rejection must happen before quiesce or restore");
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const modelArtifactCount of [4, 5, 6, 7, 9]) {
  const fixture = createFixture("external-model-artifacts-snapshotted", { modelArtifactCount });
  try {
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `${modelArtifactCount}-artifact recovery: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, "rollback");
    assert.equal(fs.readFileSync(fixture.strategyTarget, "utf8"), "{\"state\":\"old\"}\n");
    assertAbsent(fixture.evaluationTarget);
    assert.equal(fs.readFileSync(fixture.registryTarget, "utf8"), "{\"state\":\"registry-old\"}\n");
    assertAbsent(fixture.challengerTarget);
    assert.equal(
      fs.readFileSync(fixture.temperatureSuiteTarget, "utf8"),
      modelArtifactCount >= 5
        ? "{\"state\":\"temperature-old\"}\n"
        : "{\"state\":\"temperature-new\"}\n",
      `${modelArtifactCount}-artifact recovery must restore only the exact signed prefix`,
    );
    assert.equal(
      fs.readFileSync(fixture.commonCohortG2V1Target, "utf8"),
      modelArtifactCount >= 6
        ? "{\"state\":\"common-cohort-v1-old\"}\n"
        : "{\"state\":\"common-cohort-v1-new\"}\n",
      `${modelArtifactCount}-artifact recovery must preserve the exact v1 G2 state`,
    );
    assert.equal(
      fs.readFileSync(fixture.commonCohortG2V2Target, "utf8"),
      modelArtifactCount >= 7
        ? "{\"state\":\"common-cohort-v2-old\"}\n"
        : "{\"state\":\"common-cohort-v2-new\"}\n",
      `${modelArtifactCount}-artifact recovery must not reinterpret v1 as v2`,
    );
    assert.equal(
      fs.readFileSync(fixture.captureStatusTarget, "utf8"),
      modelArtifactCount === 9
        ? "{\"state\":\"capture-status-old\"}\n"
        : "{\"state\":\"capture-status-new\"}\n",
      `${modelArtifactCount}-artifact recovery must restore the exact capture heartbeat state`,
    );
    if (modelArtifactCount === 9) assertAbsent(fixture.benchmarkProspectiveTarget);
    else assert.equal(
      fs.readFileSync(fixture.benchmarkProspectiveTarget, "utf8"),
      "{\"state\":\"benchmark-prospective-new\"}\n",
      `${modelArtifactCount}-artifact recovery must not reinterpret a legacy manifest`,
    );
    assertAbsent(fixture.current);
    assertions += 12;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("external-model-artifacts-snapshotted", { modelArtifactCount: 7 });
  try {
    const modelDir = path.join(fixture.current, "external-model-artifacts");
    const manifestPath = path.join(modelDir, "manifest.tsv");
    const rows = fs.readFileSync(manifestPath, "utf8").trimEnd().split("\n");
    rows[6] = [
      "candidate-common-cohort-g2-v2",
      "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json",
      "0", "-", "-", "-", "-", "-",
    ].join("\t");
    fs.writeFileSync(manifestPath, `${rows.join("\n")}\n`);
    fs.rmSync(path.join(modelDir, "candidate-common-cohort-g2-v2"));
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `absent v2 artifact recovery: ${result.stderr}`);
    assert.equal(
      fs.readFileSync(fixture.commonCohortG2V1Target, "utf8"),
      "{\"state\":\"common-cohort-v1-old\"}\n",
      "v1 must restore independently when v2 was absent before release",
    );
    assertAbsent(fixture.commonCohortG2V2Target);
    assertAbsent(fixture.current);
    assertions += 5;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("external-model-artifacts-snapshotted", { modelArtifactCount: 4 });
  try {
    const manifestPath = path.join(fixture.current, "external-model-artifacts", "manifest.tsv");
    const rows = fs.readFileSync(manifestPath, "utf8").trimEnd().split("\n");
    fs.writeFileSync(manifestPath, `${rows.slice(0, 3).join("\n")}\n`);
    const before = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unsupported three-artifact manifest must be rejected");
    assert.equal(fs.readFileSync(fixture.strategyTarget, "utf8"), "{\"state\":\"new\"}\n");
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), before,
      "manifest rejection must happen before quiesce or restore");
    assert.equal(fs.readFileSync(path.join(fixture.current, "phase"), "utf8").trim(),
      "external-model-artifacts-snapshotted");
    assertions += 4;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const phase of forwardPhases) {
  const fixture = createFixture(phase);
  try {
    const first = runRecovery(fixture);
    assert.equal(first.status, 0, `${phase}: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).action, "commit", phase);
    assert.equal(readTreeId(fixture.app), "new", phase);
    assert.equal(readTreeId(fixture.backup), "old", phase);
    assertAbsent(fixture.current);
    const second = runRecovery(fixture);
    assert.equal(second.status, 0, `${phase} idempotence: ${second.stderr}`);
    assert.equal(JSON.parse(second.stdout).action, "noop", `${phase} idempotence`);
    assertions += 7;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("sqlite-snapshotted");
  try {
    fs.appendFileSync(path.join(fixture.current, "sqlite", "football.db"), "tamper");
    const before = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "tampered snapshot must be rejected");
    assert.equal(readTreeId(fixture.app), "old");
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), before, "tamper rejection must happen before quiesce");
    assert.equal(fs.readFileSync(path.join(fixture.current, "phase"), "utf8").trim(), "sqlite-snapshotted");
    assertions += 4;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("swap-complete");
  try {
    fs.rmSync(fixture.app, { recursive: true, force: true });
    mkdir(fixture.app, 0o755);
    write(path.join(fixture.app, "tree-id"), "unknown\n", 0o644);
    const before = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unknown APP identity must be rejected");
    assert.equal(readTreeId(fixture.app), "unknown");
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), before, "unknown topology rejection must happen before quiesce");
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("swap-complete");
  try {
    write(path.join(fixture.app, ".release-tree-identity"), `${"b".repeat(64)}\n`, 0o600);
    const before = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unexpected tree nonce must be rejected");
    assert.equal(readTreeId(fixture.app), "new");
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), before,
      "tree nonce rejection must happen before quiesce");
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("swap-complete");
  try {
    write(path.join(fixture.app, ".release-bundle-sha256"), `${"b".repeat(64)}\n`, 0o644);
    const mockPath = mapped(fixture.root, "/mock-systemd.json");
    const before = fs.readFileSync(mockPath, "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unexpected app marker must be rejected");
    assert.equal(readTreeId(fixture.app), "new");
    assert.equal(fs.readFileSync(mockPath, "utf8"), before, "marker refusal must happen before quiesce");
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("committed", { health: false });
  try {
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "failed committed health must retain transaction");
    assert.equal(readTreeId(fixture.app), "new", "committed recovery must never roll back APP");
    assert.equal(readTreeId(fixture.backup), "old", "committed recovery must retain old BACKUP");
    assert.equal(fs.existsSync(fixture.current), true, "committed failure must retain recovery/current");
    assert.equal(fs.readFileSync(path.join(fixture.current, "phase"), "utf8").trim(), "recovering-commit");
    assertAbsent(fixture.failed);
    assertions += 6;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("unknown-phase");
  try {
    const before = fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "unknown phase must be rejected");
    assert.equal(fs.readFileSync(path.join(fixture.current, "phase"), "utf8").trim(), "unknown-phase");
    assert.equal(fs.readFileSync(mapped(fixture.root, "/mock-systemd.json"), "utf8"), before);
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("swap-complete");
  try {
    const mockPath = mapped(fixture.root, "/mock-systemd.json");
    const state = JSON.parse(fs.readFileSync(mockPath, "utf8"));
    state.mountpoints = ["/opt/football-predict"];
    fs.writeFileSync(mockPath, `${JSON.stringify(state, null, 2)}\n`);
    const before = fs.readFileSync(mockPath, "utf8");
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "mountpoint APP topology must be rejected");
    assert.equal(readTreeId(fixture.app), "new");
    assert.equal(fs.readFileSync(mockPath, "utf8"), before, "mountpoint refusal must happen before quiesce");
    assertions += 3;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  rollbackPhases: rollbackPhases.length,
  forwardPhases: forwardPhases.length,
  assertions
}, null, 2));
