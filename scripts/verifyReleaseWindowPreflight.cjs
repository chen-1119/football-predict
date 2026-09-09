"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildManifest } = require("../server/dataGenerationStore.cjs");

const START = Date.parse("2026-09-08T00:00:00.000Z");
const SHA = "a".repeat(64);
const DATA = "/var/lib/football-predict/data-generations";
const APP = "/opt/football-predict";
const iso = value => new Date(value).toISOString();
const readSource = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");

function observation({ horizonSeconds = 10800, payload, committedAt = START } = {}) {
  const matches = payload === undefined ? [{ id: "window-fixture", sourceMatchId: "window-fixture", status: "SCHEDULED",
    kickoffTime: iso(START + (horizonSeconds + 3600) * 1000),
    predictionMeta: { cutoffTime: iso(START + horizonSeconds * 1000) } }] : payload;
  const bytes = Buffer.from(JSON.stringify(matches));
  const manifest = buildManifest({ sourceCycleId: "window-fixture-cycle", coreFiles: ["matches-current.json"],
    files: [{ relativePath: "matches-current.json", bytes, rows: Array.isArray(matches) ? matches.length : 1 }] });
  const pointer = { schemaVersion: 1, generationId: manifest.generationId, manifestHash: manifest.manifestHash,
    sourceCycleId: manifest.sourceCycleId, committedAt: iso(committedAt) };
  return { version: "release-window-observation-v1", checkedAt: iso(START), releaseMarker: SHA, liveComplete: SHA,
    pointer, pointerAfter: { ...pointer }, manifest, currentBase64: bytes.toString("base64"), productionWrites: 0 };
}

// Only these mocked read-only syscalls exist. An unexpected path, dependency,
// filesystem method or child execution fails rather than accessing the host.
function collectorFixture(input, options = {}) {
  const generation = DATA + "/generations/" + input.pointer.generationId;
  const directories = ["/", "/var", "/var/lib", "/var/lib/football-predict", DATA, DATA + "/generations", generation, "/opt", APP];
  const records = new Map(); let inode = 10;
  for (const directory of directories) records.set(directory, { directory: true, uid: directory.startsWith("/var/lib/football-predict") ? 1001 : 0, ino: inode++ });
  for (const [file, bytes] of [
    [APP + "/.release-bundle-sha256", Buffer.from(input.releaseMarker + "\n")],
    [APP + "/.release-live-complete", Buffer.from(input.liveComplete + "\n")],
    [DATA + "/current.json", Buffer.from(JSON.stringify(input.pointer))],
    [generation + "/manifest.json", Buffer.from(JSON.stringify(input.manifest))],
    [generation + "/matches-current.json", Buffer.from(input.currentBase64, "base64")],
  ]) records.set(file, { bytes, uid: file.startsWith(APP) ? 0 : 1001, ino: inode++ });
  const calls = [], counts = new Map(), descriptors = new Map(); let nextFd = 10;
  const stat = (file, method) => {
    const record = records.get(file); assert.ok(record, "unexpected read-only fixture path: " + file);
    const key = method + ":" + file, count = (counts.get(key) || 0) + 1; counts.set(key, count);
    const info = { dev: 1, ino: record.ino, uid: record.uid, gid: record.uid, nlink: 1,
      size: record.bytes?.length || 0, mode: record.directory ? 0o40755 : 0o100644, mtimeMs: 100, ctimeMs: 100,
      isFile: () => !record.directory, isDirectory: () => record.directory === true, isSymbolicLink: () => false };
    return { ...info, ...options.stat?.({ file, method, count, info, calls }) };
  };
  const mockFs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    lstatSync(file) { calls.push({ method: "lstat", file }); return stat(file, "lstat"); },
    realpathSync(file) { calls.push({ method: "realpath", file }); assert.ok(records.has(file)); return options.realpath?.(file) || file; },
    openSync(file, flags) {
      assert.equal(flags, 0x20000, "collector must use O_RDONLY | O_NOFOLLOW");
      const record = records.get(file); assert.ok(record?.bytes, "only fixed regular inputs may open");
      calls.push({ method: "open", file, flags });
      const fd = nextFd++, openCount = calls.filter(row => row.method === "open" && row.file === file).length;
      descriptors.set(fd, { file, offset: 0, bytes: options.bytes?.({ file, openCount, bytes: record.bytes }) || record.bytes }); return fd;
    },
    fstatSync(fd) { const handle = descriptors.get(fd); assert.ok(handle); calls.push({ method: "fstat", file: handle.file }); return stat(handle.file, "fstat"); },
    readSync(fd, output, offset, length, position) {
      const handle = descriptors.get(fd); assert.ok(handle); assert.equal(position, null);
      assert.ok(length >= 0 && length <= 16 * 1024 * 1024, "read length must be bounded");
      const count = Math.min(length, handle.bytes.length - handle.offset);
      handle.bytes.copy(output, offset, handle.offset, handle.offset + count); handle.offset += count;
      calls.push({ method: "read", file: handle.file, requested: length, count }); return count;
    },
    closeSync(fd) { assert.ok(descriptors.has(fd)); calls.push({ method: "close", file: descriptors.get(fd).file }); descriptors.delete(fd); },
  };
  let printed;
  const requires = [], context = { Buffer, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [START])); } static now() { return START; } },
    require: name => { requires.push(name); if (name === "node:fs") return mockFs; assert.equal(name, "node:assert/strict"); return assert; },
    console: { log: text => { assert.equal(printed, undefined); printed = JSON.parse(text); } },
  };
  return { calls, descriptors, requires, generation,
    run(helper) { vm.runInNewContext(helper.buildReadOnlyWindowProbe(), context, { timeout: 1000 }); return printed; } };
}

const DEFAULTS = [
  ["CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS", "RELEASE_CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS", 900],
  ["CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS", "RELEASE_CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS", 900],
  ["CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS", "RELEASE_CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS", 30],
  ["LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS", "RELEASE_LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS", 900],
  ["WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS", "RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS", 1500],
  ["POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS", "RELEASE_POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS", 120],
  ["RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS", "RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS", 900000],
];
const POST_EXPRESSION = "WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS + POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS";
const PRE_EXPRESSION = "CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS + WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS + 2 * ((RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS + 999) / 1000) + LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS + POST_SWAP_TRANSITION_START_BUDGET_SECONDS - CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS";
function assertShellBudget(source) {
  const values = {};
  for (const [name, env, expected] of DEFAULTS) {
    const lines = source.split("\n").filter(line => line.startsWith(name + "="));
    assert.deepEqual(lines, [name + '="${' + env + ":-" + expected + '}"'], "reviewed default changed: " + name);
    values[name] = expected;
  }
  for (const [name, expected] of [["POST_SWAP_TRANSITION_START_BUDGET_SECONDS", POST_EXPRESSION], ["CANDIDATE_PREVERIFY_AND_BARRIER_BUDGET_SECONDS", PRE_EXPRESSION]]) {
    const matches = [...source.matchAll(new RegExp("^ *" + name + "=\\$\\(\\(([\\s\\S]*?)\\n *\\)\\)", "gm"))];
    assert.equal(matches.length, 1, "unique reviewed composition: " + name);
    assert.equal(matches[0][1].trim().replace(/\s+/g, " "), expected, "reviewed composition changed: " + name);
  }
  const post = values.WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS + values.POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS;
  const pre = values.CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS + values.WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS
    + 2 * Math.ceil(values.RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS / 1000) + values.LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS
    + post - values.CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS;
  assert.equal(post, 1620); assert.equal(pre, 6690);
  assert.equal(values.CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS + pre + values.CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS, 7620);
}

function runCreatePrefix(source, options = {}) {
  const end = source.indexOf("const prebuiltDistManifest ="); assert.ok(end > 0);
  const calls = [], logs = [], exited = {};
  const env = { RELEASE_KIND: options.kind || "full", ...(options.offline ? {} : { RELEASE_DEPLOY_KEY: "fixture-pin-not-a-real-key" }) };
  const signing = { loadReleasePrivateKey: () => ({ publicKeyPem: "fixture" }), ensureMatchingPublicKeyFile: () => ({}),
    resolvePublicKeyPath: () => "/fixture/public", resolveReleaseManifestConfig: () => ({ createdAt: iso(START), site: "fixture", channel: "fixture" }),
    reserveReleaseSequence: () => { calls.push("reserve"); return { releaseSequence: 1 }; } };
  const context = { __dirname: "/fixture/scripts", Buffer,
    process: { env, execPath: "/fixed/node", platform: "linux", umask: () => {}, stderr: { write: () => {} }, exit: status => { assert.equal(status, 0); throw exited; } },
    console: { error: text => logs.push(JSON.parse(text)) },
    require: name => {
      if (name === "node:path") return path.posix;
      if (name === "node:crypto") return {};
      if (name === "node:fs") return {
        readFileSync: file => {
          assert.equal(file, "/fixture/deploy/light-server/football-release");
          const wrapper = readSource("deploy/light-server/football-release");
          const { BURN } = require("./releaseSequencePreflight.cjs");
          return options.invalidSequence ? wrapper.replace(BURN, BURN + "\n" + BURN) : wrapper;
        },
        lstatSync: file => { assert.equal(file, "/fixture/.release-actions"); throw Object.assign(new Error("absent"), { code: "ENOENT" }); }
      };
      if (name === "./releaseSequencePreflight.cjs") return { validateSequenceBranches: wrapper => {
        calls.push("sequence-preflight");
        return require("./releaseSequencePreflight.cjs").validateSequenceBranches(wrapper);
      } };
      if (name === "node:child_process") return { spawnSync: (command, args) => {
        if (args[0] === "/fixture/scripts/createFrontendReleaseBundle.cjs") { assert.equal(command, "/fixed/node"); calls.push("ui-source"); }
        else if (args[0] === "scripts/verifyReleaseVerifierContracts.cjs") { assert.equal(command, "/fixed/node"); calls.push("preSign"); }
        else { assert.equal(command, "npm"); assert.deepEqual(Array.from(args), ["run", "build"]); calls.push("build"); }
        return { status: 0 };
      } };
      if (name === "./releaseSigning.cjs") return signing;
      if (name === "./historicalTrainingReleaseArtifact.cjs") return { HISTORICAL_TRAINING_RELEASE_ENTRY: "fixture.json", inspectHistoricalTrainingFile: () => ({ ok: true }) };
      if (["./releaseWorkspaceFreshness.cjs", "./releaseBundlePolicy.cjs", "./releasePrebuiltDist.cjs", "./releaseArchiveSourceInventory.cjs"].includes(name)) return {};
      if (name === "./runReleaseWindowPreflight.cjs") return { runLiveReleaseWindowPreflight: ({ stage }) => {
        assert.equal(stage, "before-build");
        calls.push("window"); if (options.windowThrows) throw new Error("fixture window unavailable"); return { ok: options.windowOpen !== false, readyToCutover: false };
      } };
      assert.equal(name, "./runReleaseArchivePreflight.cjs"); return { runLiveArchivePreflight: () => { calls.push("archive"); return { report: { ok: true } }; } };
    },
  };
  try { vm.runInNewContext(source.slice(0, end), context, { timeout: 1000 }); return { ok: true, calls, logs }; }
  catch (error) { return { ok: error === exited, calls, logs, error: error.message }; }
}

function verifyReleaseWindowPreflight() {
  const helper = require("./runReleaseWindowPreflight.cjs");
  const checks = [], check = (name, action) => { try { action(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.stack }); } };
  const evaluate = (value = observation(), now = START, stage = "before-build") => helper.evaluateReleaseWindowObservation(value, now, { stage });
  const reject = mutate => { const value = observation(); mutate(value); assert.throws(() => evaluate(value)); };
  const noAuthority = result => {
    for (const field of ["readyToCutover", "windowReserved", "windowPreauthorized", "leaseCreated"]) assert.equal(result[field], false, field);
    assert.equal(result.productionWrites, 0);
  };
  check("before-build preserves 7620 release + 900 upload + 900 build + 5 observation seconds and grants no authority", () => {
    const result = evaluate(); assert.equal(result.ok, true); assert.equal(result.safeToStartPreparation, true);
    assert.equal(result.releaseHorizonSeconds, 7620); assert.equal(result.preparationSeconds, 1800);
    assert.equal(result.stage, "before-build"); assert.equal(result.uploadPreparationSeconds, 900); assert.equal(result.buildPreparationSeconds, 900);
    assert.equal(result.observationReserveSeconds, 5); assert.equal(result.minimumHorizonSeconds, 9425); noAuthority(result);
    assert.equal(result.latestStartBeforeNextTransition, iso(START + 1375_000));
  });
  check("before-upload retains the complete original 900-second allowance and server horizon", () => {
    const result = evaluate(observation(), START, "before-upload");
    assert.equal(result.minimumHorizonSeconds, 8525); assert.equal(result.releaseHorizonSeconds, 7620);
    assert.equal(result.preparationSeconds, 900); assert.equal(result.buildPreparationSeconds, 0);
    assert.equal(result.uploadPreparationSeconds, 900); assert.equal(result.stage, "before-upload");
    assert.equal(result.latestStartBeforeNextTransition, iso(START + 2275_000)); noAuthority(result);
  });
  check("r722 boundary regression is rejected before spending build time, not by lowering the upload gate", () => {
    const input = observation({ horizonSeconds: 8601 });
    assert.equal(evaluate(input, START, "before-upload").ok, true);
    assert.equal(evaluate(input).ok, false);
    input.checkedAt = iso(START + 217_000);
    assert.equal(evaluate(input, START + 217_000, "before-upload").ok, false);
  });
  check("planned build allowance leaves the full later upload allowance when fixtures stay unchanged", () => {
    const input = observation({ horizonSeconds: 9425 });
    assert.equal(evaluate(input).ok, true);
    input.checkedAt = iso(START + 900_000);
    const upload = evaluate(input, START + 900_000, "before-upload");
    assert.equal(upload.ok, true); assert.equal(upload.availableHorizonSeconds, 8525);
    input.checkedAt = iso(START + 901_000);
    assert.equal(evaluate(input, START + 901_000, "before-upload").ok, false);
  });
  check("both stage boundaries reject even a one-second shortage and unknown stages fail before SSH", () => {
    for (const [stage, minimum] of [["before-build", 9425], ["before-upload", 8525]]) {
      assert.equal(evaluate(observation({ horizonSeconds: minimum }), START, stage).ok, true);
      assert.equal(evaluate(observation({ horizonSeconds: minimum - 1 }), START, stage).ok, false);
    }
    for (const stage of ["", "skip", "before-swap", 0, null]) {
      assert.throws(() => evaluate(observation(), START, stage), /unknown release preparation stage/);
      assert.throws(() => helper.runLiveReleaseWindowPreflight({ stage }), /unknown release preparation stage/);
    }
  });
  check("a nominal 8520-second window is closed once observation reserve is included", () => {
    const result = evaluate(observation({ horizonSeconds: 8520 })); assert.equal(result.ok, false);
    assert.equal(result.reason, "transition-window-closed"); assert.equal(result.minimumHorizonSeconds, 9425);
    assert.equal(result.safeToStartPreparation, false); noAuthority(result);
  });
  check("positive observation age is rounded upward and projection stays anchored to remote checkedAt", () => {
    const result = evaluate(observation(), START + 4501);
    assert.equal(result.observationReserveSeconds, 10); assert.equal(result.minimumHorizonSeconds, 9430);
    assert.equal(result.availableHorizonSeconds, 10800); assert.equal(result.nextTransition, iso(START + 10800_000));
  });
  check("permitted negative local clock skew cannot make remote transition time disappear", () => {
    const result = evaluate(observation(), START - 4000); assert.equal(result.observationReserveSeconds, 5);
    assert.equal(result.availableHorizonSeconds, 10800); assert.equal(result.minimumHorizonSeconds, 9425);
    const crossed = observation({ horizonSeconds: 1 }); assert.equal(evaluate(crossed, START + 2000).ok, false);
  });
  check("stale, future and invalid observation clocks are rejected", () => {
    for (const now of [START + 60001, START - 5001]) assert.throws(() => evaluate(observation(), now));
    reject(value => { value.checkedAt = "not-a-date"; });
  });
  check("semantic no-op generation age is telemetry, never provider freshness proof; future publication still fails", () => {
    const old = evaluate(observation({ committedAt: START - 7 * 86400_000 }));
    assert.equal(old.ok, true); assert.equal(old.generationAgeMs, 7 * 86400_000); assert.equal(old.providerFreshnessVerified, false);
    assert.throws(() => evaluate(observation({ committedAt: START + 5001 })));
    assert.equal(evaluate(observation({ committedAt: START }), START - 4000).ok, true);
  });
  check("generation identifier and authenticated manifest projection cannot drift", () => {
    reject(value => { value.pointer.generationId = "../../other"; });
    reject(value => { value.manifest = { ...value.manifest, sourceCycleId: "changed" }; });
    reject(value => { value.pointer.manifestHash = "b".repeat(64); });
  });
  check("current payload requires exact bytes, canonical base64 and bounded encoded length", () => {
    reject(value => { value.currentBase64 = Buffer.from("[]").toString("base64"); });
    reject(value => { value.currentBase64 += "\n"; });
    reject(value => { value.currentBase64 = "A".repeat(24 * 1024 * 1024 + 1); });
  });
  check("authenticated empty or non-array inventories do not imply a safe window", () => {
    for (const payload of [[], { matches: [] }, { rows: [] }, { missing: [] }]) assert.throws(() => evaluate(observation({ payload })));
  });
  check("all second-pointer identity fields bind the same immutable generation", () => {
    for (const field of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) reject(value => { value.pointerAfter[field] += "changed"; });
  });
  check("both accepted runtime markers and observation write claims are checked", () => {
    reject(value => { value.releaseMarker = "A".repeat(64); }); reject(value => { value.liveComplete = "b".repeat(64); });
    reject(value => { value.productionWrites = 1; }); reject(value => { value.version = "unreviewed"; });
  });
  check("actual collector source reads only fixed bounded nofollow inputs and loads no APP policy", () => {
    const fixture = collectorFixture(observation()), result = fixture.run(helper);
    assert.equal(evaluate(result).ok, true); assert.equal(fixture.descriptors.size, 0);
    assert.deepEqual(fixture.requires, ["node:fs", "node:assert/strict"]);
    const opened = new Set(fixture.calls.filter(row => row.method === "open").map(row => row.file));
    assert.deepEqual([...opened].sort(), [APP + "/.release-bundle-sha256", APP + "/.release-live-complete", DATA + "/current.json",
      fixture.generation + "/manifest.json", fixture.generation + "/matches-current.json"].sort());
    assert.ok(fixture.calls.filter(row => row.method === "read").every(row => row.requested <= 16 * 1024 * 1024));
  });
  check("collector rejects symlinks, hard links, nonregular files, unsafe owners and writable file modes", () => {
    for (const change of [{ isSymbolicLink: () => true }, { nlink: 2 }, { isFile: () => false }, { uid: 9999 }, { gid: 9999 }, { mode: 0o100666 }]) {
      const fixture = collectorFixture(observation(), { stat: ({ file }) => file === DATA + "/current.json" ? change : {} });
      assert.throws(() => fixture.run(helper)); assert.equal(fixture.descriptors.size, 0);
    }
    const marker = collectorFixture(observation(), { stat: ({ file }) => file === APP + "/.release-bundle-sha256" ? { uid: 1001 } : {} });
    assert.throws(() => marker.run(helper));
  });
  check("fixed data-store owner and group can use 0775/0664 while root runtime inputs remain non-group-writable", () => {
    const fixture = collectorFixture(observation(), { stat: ({ file, info }) => file.startsWith("/var/lib/football-predict")
      ? { gid: 1002, mode: info.isDirectory() ? 0o40775 : 0o100664 } : {} });
    assert.equal(evaluate(fixture.run(helper)).ok, true);
    for (const change of [{ gid: 1002 }, { mode: 0o100664 }]) {
      const rootInput = collectorFixture(observation(), { stat: ({ file }) => file === APP + "/.release-bundle-sha256" ? change : {} });
      assert.throws(() => rootInput.run(helper));
    }
  });
  check("collector rejects empty or oversized files before allocating or opening their data", () => {
    for (const size of [0, 64 * 1024 + 1]) {
      const target = DATA + "/current.json", fixture = collectorFixture(observation(), { stat: ({ file }) => file === target ? { size } : {} });
      assert.throws(() => fixture.run(helper)); assert.equal(fixture.calls.some(row => row.method === "open" && row.file === target), false);
    }
  });
  check("collector opened descriptor must match the inspected file identity", () => {
    const fixture = collectorFixture(observation(), { stat: ({ file, method, info }) => file === DATA + "/current.json" && method === "fstat" ? { ino: info.ino + 1 } : {} });
    assert.throws(() => fixture.run(helper)); assert.equal(fixture.descriptors.size, 0);
  });
  check("collector rejects descriptor metadata changes and closes the descriptor on failure", () => {
    for (const change of [{ mtimeMs: 101 }, { ctimeMs: 101 }, { size: 1 }]) {
      const fixture = collectorFixture(observation(), { stat: ({ file, method, count }) => file === DATA + "/current.json" && method === "fstat" && count > 1 ? change : {} });
      assert.throws(() => fixture.run(helper)); assert.equal(fixture.descriptors.size, 0);
    }
  });
  check("collector catches path replacement after open even if the old descriptor remains stable", () => {
    for (const change of [{ ino: 9999 }, { uid: 9999 }, { gid: 9999 }, { mode: 0o100666 }]) {
      const fixture = collectorFixture(observation(), { stat: ({ file, method, count }) => file === DATA + "/current.json" && method === "lstat" && count > 1 ? change : {} });
      assert.throws(() => fixture.run(helper)); assert.equal(fixture.descriptors.size, 0);
    }
  });
  check("collector refuses linked, foreign-owned or writable ancestors and late ancestor identity drift", () => {
    for (const options of [
      { realpath: file => file === DATA ? "/linked/data" : file },
      { stat: ({ file }) => file === "/var" ? { uid: 9999 } : {} },
      { stat: ({ file }) => file === DATA ? { mode: 0o40777 } : {} },
      { stat: ({ file, method, count, info }) => file === "/var" && method === "lstat" && count > 1 ? { ino: info.ino + 1 } : {} },
    ]) assert.throws(() => collectorFixture(observation(), options).run(helper));
  });
  check("collector observes both markers again and evaluator rejects the second pointer changing", () => {
    for (const file of [APP + "/.release-bundle-sha256", APP + "/.release-live-complete"]) {
      const fixture = collectorFixture(observation(), { bytes: args => args.file === file && args.openCount > 1 ? Buffer.from("b".repeat(64) + "\n") : args.bytes });
      assert.throws(() => fixture.run(helper));
    }
    const input = observation(), changed = { ...input.pointer, committedAt: iso(START + 1000) };
    const fixture = collectorFixture(input, { bytes: args => args.file === DATA + "/current.json" && args.openCount > 1 ? Buffer.from(JSON.stringify(changed)) : args.bytes });
    assert.throws(() => evaluate(fixture.run(helper)));
  });
  const create = readSource("scripts/createReleaseBundle.cjs");
  check("actual deploy prefix requests upload stage and blocks clone or upload after a rejected observation", () => {
    const deploy = readSource("scripts/deployReleaseBundle.cjs");
    const start = deploy.indexOf("  // Reject a closed window before the archive scan, local clone, or uploads.");
    const end = deploy.indexOf("  const localCloneVerifier =", start); assert.ok(start >= 0 && end > start);
    for (const outcome of ["open", "closed", "throws"]) {
      const calls = [];
      const context = { dryRun: false, releaseWindowPreflight: null,
        fail: message => { throw new Error(message); }, require: name => {
          if (name === "./runReleaseWindowPreflight.cjs") return { runLiveReleaseWindowPreflight: ({ stage }) => {
            assert.equal(stage, "before-upload"); calls.push("window");
            if (outcome === "throws") throw new Error("observation unavailable"); return { ok: outcome === "open" };
          } };
          assert.equal(name, "./runReleaseArchivePreflight.cjs"); return { runLiveArchivePreflight: () => { calls.push("archive"); return { report: { ok: true } }; } };
        } };
      const run = () => vm.runInNewContext(deploy.slice(start, end), context, { timeout: 1000 });
      if (outcome === "open") { run(); assert.deepEqual(calls, ["window", "archive"]); }
      else { assert.throws(run); assert.deepEqual(calls, ["window"]); }
    }
  });
  check("actual online create prefix runs window before archive, preSign, sequence reservation and build", () => {
    const result = runCreatePrefix(create); assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.calls, ["sequence-preflight", "window", "archive", "preSign", "reserve", "build"]);
    for (const options of [{ windowOpen: false }, { windowThrows: true }]) {
      const rejected = runCreatePrefix(create, options); assert.equal(rejected.ok, false); assert.deepEqual(rejected.calls, ["sequence-preflight", "window"]);
    }
  });
  check("actual offline create prefix makes no live calls and explicitly reports no window authority", () => {
    const result = runCreatePrefix(create, { offline: true, windowThrows: true }); assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.calls, ["sequence-preflight", "preSign", "reserve", "build"]);
    assert.equal(result.logs[0].windowChecked, false); assert.equal(result.logs[0].readyToCutover, false);
  });
  check("actual UI create dispatch exits before live gates, full verification and local build", () => {
    const result = runCreatePrefix(create, { kind: "frontend-only", windowThrows: true }); assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.calls, ["ui-source"]);
    const unknown = runCreatePrefix(create, { kind: "unknown" }); assert.equal(unknown.ok, false); assert.deepEqual(unknown.calls, []);
  });
  check("actual invalid sequence branch stops before network, signing, reservation and build", () => {
    const result = runCreatePrefix(create, { invalidSequence: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.calls, ["sequence-preflight"]);
  });
  const shell = readSource("deploy/light-server/release-from-bundle.sh");
  check("seven exact signed-shell budget defaults compose 7620 seconds and each default drift is rejected", () => {
    assertShellBudget(shell);
    for (const [name, env, value] of DEFAULTS) {
      const old = name + '="${' + env + ":-" + value + '}"';
      const changed = shell.replace(old, name + '="${' + env + ":-" + (value + 1) + '}"');
      assert.notEqual(changed, shell); assert.throws(() => assertShellBudget(changed));
    }
  });
  check("post-swap and composite preverify expressions are pinned and operator or multiplier drift is rejected", () => {
    for (const [before, after] of [[POST_EXPRESSION, POST_EXPRESSION.replace(" + ", " - ")],
      ["2 * ((RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS + 999) / 1000)", "1 * ((RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS + 999) / 1000)"]]) {
      const changed = shell.replace(before, after); assert.notEqual(changed, shell); assert.throws(() => assertShellBudget(changed));
    }
  });
  return { ok: checks.every(row => row.ok), checks, productionWrites: 0, networkCalls: 0,
    actualEvaluationAndCollectorSource: true, filesystemAndTransportMocked: true, realPreSignBuildOrSequenceReservation: false,
    budgetContractScope: "Local verifier rejects signed-shell budget drift; no server gate or lease is bypassed." };
}

module.exports = { verifyReleaseWindowPreflight };
if (require.main === module) {
  const report = verifyReleaseWindowPreflight(); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
}
