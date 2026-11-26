"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const activation = require("../scripts/activateReferenceIntegrity.cjs");
const sourcePaths = ["scripts/activateReferenceIntegrity.cjs", "scripts/installReferenceIntegrityInputs.cjs", "server/referenceIntegrityPartition.cjs",
  "server/dataGenerationStore.cjs", "server/dataGenerationBundle.cjs", "scripts/postgresGenerationSource.cjs", "scripts/syncData.cjs"];
const currentSha = "a".repeat(64), previousSha = "b".repeat(64), sourceSha = "c".repeat(64);
function release(sha256, sequence) {
  return { sha256, sequence, status: { status: "complete", ok: "1", exitCode: "0", bundleSha256: sha256, releaseSequence: String(sequence) },
    authorization: { version: "reference-integrity-compatibility-preparation-v6", reason: "install-backward-compatible-original-partition-readers-with-writer-disabled",
      baseRuntimeSha256: previousSha, files: sourcePaths.map(name => ({ path: name, beforeSha256: sourceSha, afterSha256: sourceSha })) },
    sources: sourcePaths.map(name => ({ path: name, sha256: sourceSha })),
    engineering: { engineeringAccepted: true, bundleSha256: sha256, dataPlane: "code-only", databaseOid: "28598409" } };
}
const current = () => release(currentSha, 914), previous = () => release(previousSha, 913);
test("activation requires two completed matching source releases, not merely two release numbers", () => {
  assert.equal(activation.validateReleasePair(current(), previous()), true);
  for (const change of [
    value => value.status.status = "running",
    value => value.authorization.baseRuntimeSha256 = "d".repeat(64),
    value => value.authorization.files[0].beforeSha256 = "d".repeat(64),
    value => value.sources[0].sha256 = "d".repeat(64),
    value => value.sources.pop(),
    value => value.engineering.databaseOid = "9999",
    value => value.engineering.engineeringAccepted = false,
  ]) { const changed = current(); change(changed); assert.throws(() => activation.validateReleasePair(changed, previous())); }
  const legacyRollback = previous(); legacyRollback.authorization.version = "legacy";
  assert.throws(() => activation.validateReleasePair(current(), legacyRollback));
});
test("systemd repeated EnvironmentFiles are parsed without allowing duplicate service identity fields", () => {
  assert.deepEqual(activation.parseProperties("MainPID=42\nEnvironmentFiles=/etc/one (ignore_errors=no)\nEnvironmentFiles=/etc/two (ignore_errors=no)\n"),
    { MainPID: "42", EnvironmentFiles: "/etc/one (ignore_errors=no) /etc/two (ignore_errors=no)" });
  assert.throws(() => activation.parseProperties("MainPID=42\nMainPID=43"), /PROPERTIES/);
});
test("environment files cannot override the dedicated worker flag", () => {
  assert.equal(activation.validateEnvironmentFiles(["A=1\n# ORIGINAL_REFERENCE_PARTITION=0\n"]), true);
  for (const value of ["ORIGINAL_REFERENCE_PARTITION=0", "ORIGINAL_REFERENCE_PARTITION=1", " export ORIGINAL_REFERENCE_PARTITION = 0"]) {
    assert.throws(() => activation.validateEnvironmentFiles([value]), /ENVIRONMENT_OVERRIDE/);
  }
  assert.equal(activation.CONTENT, "[Service]\nEnvironment=ORIGINAL_REFERENCE_PARTITION=1\n");
  assert.equal(activation.DROPIN.endsWith("/zz-original-reference-partition.conf"), true);
  assert.equal(activation.CONTENT.includes("Memory"), false);
});
test("worker identity requires the actual active unprivileged whole-control-group service", () => {
  const service = { ActiveState: "active", SubState: "running", MainPID: "42", ControlPID: "0", User: "football", Group: "football",
    WorkingDirectory: activation.ROOT, KillMode: "control-group" };
  assert.equal(activation.validateService(service, true), service);
  for (const [key, value] of [["ActiveState", "activating"], ["MainPID", "0"], ["ControlPID", "1"], ["User", "root"], ["KillMode", "process"]]) {
    assert.throws(() => activation.validateService({ ...service, [key]: value }, true));
  }
});
function actions(events) {
  return Object.fromEntries(["installInputs", "assertUnchanged", "intent", "stopWorker", "assertStopped", "createDropin", "reload", "startWorker", "verifyStarted", "complete"]
    .map(name => [name, async () => {
      events.push(name);
      if (name === "installInputs") return { originalRecords: 29, copiedFiles: 3, originalBytesChanged: false, originalPermissionsChanged: false };
      if (name === "verifyStarted") return { MainPID: "43", ActiveState: "active", SubState: "running" };
    }]));
}
test("input-install failure changes no worker, service configuration or activation journal", async () => {
  const events = [], dependencies = actions(events);
  dependencies.installInputs = async () => { events.push("installInputs"); throw new Error("input-install-failed"); };
  await assert.rejects(activation.executeActivation({}, dependencies), /input-install-failed/);
  assert.deepEqual(events, ["installInputs"]);
});
test("check returns the read-only plan without loading or calling any installer", async () => {
  const plan = { version: activation.VERSION, enabled: false, productionDataWrites: 0 };
  const inspected = require("node:vm").runInNewContext("(" + activation.main.toString() + ")", {
    assert, inspect: async () => plan, require: () => { throw new Error("check loaded mutating dependencies"); },
  });
  assert.equal(await inspected(["check"]), plan);
});

test("standalone input installer requires the installed signed release pair before any copy", async () => {
  const main = require("../scripts/installReferenceIntegrityInputs.cjs").main;
  for (const accepted of [false, true]) {
    const events = [];
    const inspected = require("node:vm").runInNewContext("(" + main.toString() + ")", {
      assert, process: { argv: ["node", "installer"] }, __dirname: activation.ROOT + "/scripts",
      fs: { realpathSync: value => value }, path: { resolve: () => activation.ROOT },
      console: { log: () => events.push("receipt") },
      require(name) {
        if (name === "./activateReferenceIntegrity.cjs") return { inspect: async () => {
          events.push("signed-pair");
          if (!accepted) throw new Error("signed-pair-rejected");
          return { currentSha256: currentSha };
        } };
        assert.equal(name, "../server/referenceIntegrityPartition.cjs");
        return { installReferenceIntegrityInputs: () => { events.push("copy"); return {}; } };
      },
    });
    if (accepted) await inspected();
    else await assert.rejects(inspected(), /signed-pair-rejected/);
    assert.deepEqual(events, accepted ? ["signed-pair", "copy", "receipt"] : ["signed-pair"]);
  }
});
test("activation journals intent, drains one worker and enables only after verified inputs", async () => {
  const events = [], result = await activation.executeActivation({ currentSha256: currentSha, previousSha256: previousSha, sourceClosureHash: sourceSha }, actions(events));
  assert.deepEqual(events, ["installInputs", "assertUnchanged", "intent", "stopWorker", "assertStopped", "createDropin", "reload", "startWorker", "verifyStarted", "complete"]);
  assert.equal(result.enabled, true); assert.equal(result.businessAccepted, false);
  assert.equal(result.directDatabaseWrites, 0); assert.equal(result.directPointerWrites, 0);
  assert.equal(result.originalBytesChanged, false);
});
test("uncertain stop or configuration failure never starts another writer or attempts automatic rollback", async () => {
  for (const failed of ["assertUnchanged", "intent", "stopWorker", "assertStopped", "createDropin", "reload"]) {
    const events = [], dependencies = actions(events);
    dependencies[failed] = async () => { events.push(failed); throw new Error("injected-" + failed); };
    await assert.rejects(activation.executeActivation({}, dependencies), new RegExp("injected-" + failed));
    assert.equal(events.includes("startWorker"), false); assert.equal(events.includes("complete"), false);
    assert.equal(events.at(-1), failed);
  }
});
