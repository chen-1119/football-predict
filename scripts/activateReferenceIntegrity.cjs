"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const ROOT = "/opt/football-predict", PREVIOUS = "/opt/football-predict.previous";
const NODE = "/opt/node-v22.22.1/bin/node", UNIT = "football-sync-worker.service";
const DROPIN = "/etc/systemd/system/football-sync-worker.service.d/zz-original-reference-partition.conf";
const CONTENT = "[Service]\nEnvironment=ORIGINAL_REFERENCE_PARTITION=1\n";
const JOURNAL = "/var/lib/football-release/reference-partition-activation";
const AUTH = "deploy/light-server/manual-official-recovery-authorization.json";
const VERSION = "reference-partition-activation-v1";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = (value, names) => Object.fromEntries(names.map(name => [name, value[name]]));

function parseProperties(text) {
  const result = {};
  for (const line of String(text).trim().split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) fail("REFERENCE_ACTIVATION_PROPERTIES");
    const key = line.slice(0, index), value = line.slice(index + 1);
    if (Object.hasOwn(result, key)) {
      if (key !== "EnvironmentFiles") fail("REFERENCE_ACTIVATION_PROPERTIES");
      result[key] += " " + value;
    } else result[key] = value;
  }
  return result;
}

function validateReleasePair(current, previous) {
  for (const release of [current, previous]) {
    assert.match(release.sha256 || "", /^[a-f0-9]{64}$/);
    assert.equal(release.status.status, "complete"); assert.equal(release.status.ok, "1"); assert.equal(release.status.exitCode, "0");
    assert.equal(release.status.bundleSha256, release.sha256);
    assert.equal(Number(release.status.releaseSequence), release.sequence);
    assert.equal(release.authorization.version, "reference-integrity-compatibility-preparation-v6");
    assert.equal(release.authorization.reason, "install-backward-compatible-original-partition-readers-with-writer-disabled");
    assert.equal(release.engineering.engineeringAccepted, true);
    assert.equal(release.engineering.bundleSha256, release.sha256);
    assert.equal(release.engineering.dataPlane, "code-only");
    assert.equal(release.engineering.databaseOid, "28598409");
  }
  assert.notEqual(current.sha256, previous.sha256);
  assert(current.sequence > previous.sequence);
  assert.equal(current.authorization.baseRuntimeSha256, previous.sha256);
  assert(current.authorization.files.every(entry => entry.beforeSha256 === entry.afterSha256), "second release must preserve identical compatible sources");
  assert.deepEqual(current.sources, previous.sources, "current and normal rollback source closures must be identical");
  for (const name of ["scripts/activateReferenceIntegrity.cjs", "scripts/installReferenceIntegrityInputs.cjs", "server/referenceIntegrityPartition.cjs",
    "server/dataGenerationStore.cjs", "server/dataGenerationBundle.cjs", "scripts/postgresGenerationSource.cjs", "scripts/syncData.cjs"]) {
    assert(current.sources.some(entry => entry.path === name), "complete compatible activation closure required: " + name);
  }
  return true;
}

function validateService(service, worker = false) {
  assert.equal(service.ActiveState, "active"); assert.equal(service.SubState, "running");
  assert.match(service.MainPID || "", /^[1-9]\d*$/); assert.equal(service.ControlPID, "0");
  assert.equal(service.User, "football"); assert.equal(service.Group, "football");
  assert.equal(service.WorkingDirectory, ROOT);
  if (worker) assert.equal(service.KillMode, "control-group");
  return service;
}

function validateEnvironmentFiles(contents) {
  for (const text of contents) {
    if (String(text).split(/\r?\n/).some(line => /^\s*(?:export\s+)?ORIGINAL_REFERENCE_PARTITION\s*=/.test(line))) {
      fail("REFERENCE_ACTIVATION_ENVIRONMENT_OVERRIDE");
    }
  }
  return true;
}

function systemctl(args) {
  return cp.execFileSync("/usr/bin/systemctl", args, { encoding: "utf8", timeout: 60000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", TZ: "UTC" }, maxBuffer: 1024 * 1024 });
}
function service(name) {
  return parseProperties(systemctl(["show", name, "--property=ActiveState,SubState,MainPID,ControlPID,User,Group,WorkingDirectory,KillMode,ControlGroup,EnvironmentFiles,DropInPaths,ExecMainStartTimestampMonotonic"]));
}
function processEnvironment(pid) {
  const buffer = fs.readFileSync("/proc/" + pid + "/environ");
  if (buffer.length > 256 * 1024) fail("REFERENCE_ACTIVATION_PROCESS_ENV_BOUND");
  return Object.fromEntries(buffer.toString().split("\0").filter(Boolean).map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
}
function assertProcess(observed, expectedProgram) {
  assert.equal(fs.readlinkSync("/proc/" + observed.MainPID + "/cwd"), ROOT);
  const command = fs.readFileSync("/proc/" + observed.MainPID + "/cmdline", "utf8").split("\0").filter(Boolean);
  assert.equal(fs.realpathSync(command[0]), NODE);
  assert(command.includes(ROOT + "/" + expectedProgram));
}
function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function createOnly(file, bytes, mode = 0o600) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(file));
}
function cgroupProcesses(controlGroup) {
  assert.match(controlGroup, /^\/system\.slice\/football-sync-worker\.service$/);
  const directory = "/sys/fs/cgroup" + controlGroup;
  if (!fs.existsSync(directory)) return [];
  return fs.readFileSync(directory + "/cgroup.procs", "utf8").trim().split(/\s+/).filter(Boolean);
}

async function inspect() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  assert.equal(fs.realpathSync(path.resolve(__dirname, "..")), ROOT);
  require("../server/researchReleaseLock.cjs").findHeldReleaseLock();
  const read = require("./researchReleaseBroker.cjs").trustedFile;
  const site = read("/etc/football-release/expected-site", 128).toString().trim();
  const channel = read("/etc/football-release/expected-channel", 128).toString().trim();
  const releases = [];
  for (const directory of [ROOT, PREVIOUS]) {
    const sha256 = read(directory + "/.release-bundle-sha256", 128).toString().trim();
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.equal(read(directory + "/.release-live-complete", 128).toString().trim(), sha256);
    const status = parseProperties(read("/var/lib/football-release/status/" + sha256 + ".status", 8192));
    const sequence = Number(status.releaseSequence);
    const retained = await require("./releaseSourceBaseline.cjs").verifyRetained({ sha256, sequence, site, channel });
    const manifest = JSON.parse(read(retained.directory + "/manifest.json", 1024 * 1024));
    const inventory = new Map(manifest.archiveSourceEvidence.inventory.entries.map(entry => [entry.path, entry.sha256]));
    const authorizationBytes = read(directory + "/" + AUTH, 128 * 1024);
    assert.equal(digest(authorizationBytes), inventory.get(AUTH));
    const authorization = JSON.parse(authorizationBytes);
    const names = [...new Set([...authorization.files, ...authorization.baselineClosure, ...authorization.dataContract].map(entry => entry.path))].filter(name => name !== AUTH).sort();
    const verifiedSources = new Map();
    const visitedDependencies = new Set();
    function visit(name, recursive = false) {
      if (verifiedSources.has(name) && (!recursive || visitedDependencies.has(name))) return;
      assert(/^[a-zA-Z0-9_./-]+$/.test(name) && !name.startsWith("/") && !name.split("/").includes(".."));
      const bytes = read(directory + "/" + name, 8 * 1024 * 1024);
      const sha = digest(bytes);
      assert.equal(sha, inventory.get(name), "signed source mismatch: " + name);
      verifiedSources.set(name, sha);
      if (!recursive) return;
      visitedDependencies.add(name);
      for (const match of bytes.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const dependency = require.resolve(path.resolve(directory, path.dirname(name), match[1]));
        assert(dependency.startsWith(directory + "/"), "source dependency outside installed release");
        visit(path.relative(directory, dependency), true);
      }
    }
    for (const name of names) visit(name);
    for (const name of ["scripts/activateReferenceIntegrity.cjs", "scripts/installReferenceIntegrityInputs.cjs"]) visit(name, true);
    const sources = [...verifiedSources].sort(([left], [right]) => left.localeCompare(right)).map(([name, sha256]) => ({ path: name, sha256 }));
    const capability = require(directory + "/server/dataGenerationStore.cjs").buildManifest({
      sourceCycleId: "reference-partition-read-only-capability", coreFiles: ["reference-integrity.json"],
      files: [{ relativePath: "reference-integrity.json", bytes: Buffer.from("{}"), rows: 0 }],
    });
    assert.equal(capability.schemaVersion, 2);
    assert.equal(typeof require(directory + "/server/referenceIntegrityPartition.cjs").validateSnapshotIntegrity, "function");
    releases.push({ sha256, sequence, status, authorization, sources,
      engineering: JSON.parse(read(directory + "/.release-code-acceptance.json", 16384)) });
  }
  const [current, previous] = releases;
  validateReleasePair(current, previous);
  require("../server/researchReleaseLock.cjs").releaseBoundary(ROOT, current.sha256);
  assert.equal(Number(read("/var/lib/football-release/highest-accepted-sequence", 128).toString()), current.sequence);
  for (const pending of ["/var/lib/football-release/recovery/current", "/var/lib/football-release/frontend-policy-bootstrap/pending.json", "/opt/football-predict.next"]) {
    assert.equal(present(pending), false, "unresolved release boundary: " + pending);
  }
  const api = validateService(service("football-predict.service"));
  const worker = validateService(service(UNIT), true);
  assertProcess(api, "server/index.cjs"); assertProcess(worker, "scripts/runSyncWorker.cjs");
  const environmentPaths = [...worker.EnvironmentFiles.matchAll(/(?:^|\s)(\/[^\s]+) \(ignore_errors=no\)/g)].map(match => match[1]);
  assert.deepEqual(environmentPaths.sort(), ["/etc/football-predict/env", "/etc/football-predict/worker-memory.env"].sort());
  const environmentContents = environmentPaths.map(file => read(file, 256 * 1024));
  validateEnvironmentFiles(environmentContents);
  const flag = processEnvironment(worker.MainPID).ORIGINAL_REFERENCE_PARTITION;
  assert(flag === undefined || flag === "0", "partition writer already enabled or invalid");
  assert.equal(present(DROPIN), false, "dedicated activation drop-in already exists");
  const configuration = ["/etc/systemd/system/football-sync-worker.service", ...worker.DropInPaths.split(" ").filter(Boolean), ...environmentPaths]
    .map(file => ({ path: file, sha256: digest(read(file, 256 * 1024)) }));
  const workerStatus = JSON.parse(fs.readFileSync("/var/lib/football-predict/sync-worker-status.json", "utf8"));
  assert.equal(workerStatus.pid, Number(worker.MainPID));
  assert(["sleeping", "failed", "relay-catchup-pending"].includes(workerStatus.phase), "wait for natural worker cycle boundary");
  assert.deepEqual(cgroupProcesses(worker.ControlGroup), [worker.MainPID], "wait for active worker child processes to finish");
  assert.equal(present(JOURNAL), false, "prior activation needs explicit receipt inspection");
  return { version: VERSION, checkedAt: new Date().toISOString(), currentSha256: current.sha256, previousSha256: previous.sha256,
    currentSequence: current.sequence, previousSequence: previous.sequence, sourceClosureHash: digest(JSON.stringify(current.sources)),
    api, worker, configuration, workerPhase: workerStatus.phase, dropinPath: DROPIN, dropinSha256: digest(CONTENT),
    enabled: false, businessAccepted: false, productionDataWrites: 0 };
}

async function executeActivation(plan, actions) {
  const installed = await actions.installInputs();
  assert.equal(installed.originalRecords, 29); assert.equal(installed.copiedFiles, 3);
  assert.equal(installed.originalBytesChanged, false); assert.equal(installed.originalPermissionsChanged, false);
  await actions.assertUnchanged();
  await actions.intent({ ...plan, installed });
  await actions.stopWorker();
  await actions.assertStopped();
  await actions.createDropin();
  await actions.reload();
  await actions.startWorker();
  const observed = await actions.verifyStarted();
  const result = { version: VERSION, currentSha256: plan.currentSha256, previousSha256: plan.previousSha256,
    sourceClosureHash: plan.sourceClosureHash, enabledAt: new Date().toISOString(), worker: observed,
    enabled: true, businessAccepted: false, businessState: "awaiting-complete-natural-cycle-and-edge-verification",
    originalRecords: 29, originalBytesChanged: false, originalPermissionsChanged: false, directDatabaseWrites: 0, directPointerWrites: 0 };
  await actions.complete(result);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 1); assert(["check", "activate"].includes(argv[0]));
  const plan = await inspect();
  if (argv[0] === "check") return plan;
  const broker = require("./researchReleaseBroker.cjs"), read = broker.trustedFile;
  return executeActivation(plan, {
    installInputs: () => require("../server/referenceIntegrityPartition.cjs").installReferenceIntegrityInputs(),
    assertUnchanged: () => {
      require("../server/researchReleaseLock.cjs").releaseBoundary(ROOT, plan.currentSha256);
      assert.deepEqual(service(UNIT), plan.worker);
      assert.deepEqual(service("football-predict.service"), plan.api);
      for (const entry of plan.configuration) assert.equal(digest(read(entry.path, 256 * 1024)), entry.sha256);
      assert.deepEqual(cgroupProcesses(plan.worker.ControlGroup), [plan.worker.MainPID]);
    },
    intent: value => { fs.mkdirSync(JOURNAL, { mode: 0o700 }); syncDirectory(path.dirname(JOURNAL)); createOnly(JOURNAL + "/intent.json", JSON.stringify(value) + "\n"); },
    stopWorker: () => systemctl(["stop", UNIT]),
    assertStopped: () => {
      const stopped = service(UNIT);
      assert.equal(stopped.ActiveState, "inactive"); assert.equal(stopped.MainPID, "0"); assert.equal(stopped.ControlPID, "0");
      assert.deepEqual(cgroupProcesses(plan.worker.ControlGroup), []);
    },
    createDropin: () => { read(path.dirname(DROPIN) + "/99-worker-reference-recovery.conf", 16384); createOnly(DROPIN, CONTENT, 0o644); },
    reload: () => systemctl(["daemon-reload"]),
    startWorker: () => systemctl(["start", UNIT]),
    verifyStarted: () => {
      const started = validateService(service(UNIT), true); assert.notEqual(started.MainPID, plan.worker.MainPID);
      assertProcess(started, "scripts/runSyncWorker.cjs");
      assert.equal(processEnvironment(started.MainPID).ORIGINAL_REFERENCE_PARTITION, "1");
      assert.equal(digest(read(DROPIN, 4096)), digest(CONTENT));
      for (const entry of plan.configuration) assert.equal(digest(read(entry.path, 256 * 1024)), entry.sha256);
      assert.deepEqual(service("football-predict.service"), plan.api);
      require("../server/researchReleaseLock.cjs").releaseBoundary(ROOT, plan.currentSha256);
      return plain(started, ["MainPID", "ExecMainStartTimestampMonotonic", "ActiveState", "SubState"]);
    },
    complete: value => createOnly(JOURNAL + "/enabled.json", JSON.stringify(value) + "\n"),
  });
}
module.exports = { VERSION, ROOT, PREVIOUS, DROPIN, CONTENT, JOURNAL, parseProperties, validateReleasePair, validateService, validateEnvironmentFiles, executeActivation, inspect, main };
if (require.main === module) main().then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.code || error.message, enabled: null, businessAccepted: false, automaticRetryAllowed: false }));
  process.exitCode = 1;
});
