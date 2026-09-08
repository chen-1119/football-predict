"use strict";
// Unchanged controller text in a VM. This verifies orchestration, not deployment.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), crypto = require("node:crypto"), zlib = require("node:zlib");
const assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const signing = require("./releaseSigning.cjs"), authorization = require("./frontendReleaseAuthorization.cjs");
const archive = require("./releaseArchiveSourceInventory.cjs"), build = require("./frontendBuildEvidence.cjs"), dist = require("./releasePrebuiltDist.cjs");
const identity = require("../server/frontendReleaseIdentity.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), json = value => Buffer.from(JSON.stringify(value) + "\n"), digest = value => sha(JSON.stringify(value));
const clone = value => JSON.parse(JSON.stringify(value)), APP = "/opt/football-predict", RELEASE = "/var/lib/football-release", INSTALL = "/usr/local/libexec/football-release-frontend";
const NODE = "/opt/node-v22.22.1/bin/node", STATE = RELEASE + "/frontend-state.json", BINDING = RELEASE + "/frontend-runtime-binding.json", CURRENT = RELEASE + "/recovery/current";
const controllerSource = fs.readFileSync(path.join(__dirname, "frontendReleaseController.cjs"), "utf8");
const parserBytes = fs.readFileSync(path.join(__dirname, "../node_modules/typescript/lib/typescript.js"));
const parserPackage = fs.readFileSync(path.join(__dirname, "../node_modules/typescript/package.json"));
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicPem = key.publicKey.export({ type: "spki", format: "pem" });
const tick = () => new Promise(resolve => setImmediate(resolve));
function tar(files) {
  const names = new Set(Object.keys(files));
  for (const name of [...names]) for (let p = path.posix.dirname(name); p !== "."; p = path.posix.dirname(p)) names.add(p);
  const rows = [...names].sort().map(name => ({ path: name, kind: Object.hasOwn(files, name) ? "file" : "directory", bytes: Object.hasOwn(files, name) ? Buffer.from(files[name]) : Buffer.alloc(0) }));
  const chunks = [];
  for (const row of rows) {
    const header = Buffer.alloc(512), field = (offset, size, value) => header.write(value.toString(8).padStart(size - 1, "0") + "\0", offset, size, "ascii");
    header.write(row.path); field(100, 8, row.kind === "file" ? 0o644 : 0o755); field(108, 8, 0); field(116, 8, 0); field(124, 12, row.bytes.length); field(136, 12, 0);
    header.fill(32, 148, 156); header[156] = row.kind === "file" ? 48 : 53; header.write("ustar\0", 257); header.write("00", 263);
    field(148, 8, header.reduce((a, b) => a + b, 0)); chunks.push(header, row.bytes, Buffer.alloc((512 - row.bytes.length % 512) % 512));
  }
  return { bytes: zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])), rows };
}
async function fixture(options = {}) {
  if (process.platform !== "linux") throw new Error("linux-controller-vm-fixture-required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-controller-vm-")); fs.chmodSync(root, 0o700);
  const rootInode = fs.statSync(root).ino, events = [], handles = new Map(), requests = [];
  let sandboxCalls = 0, installedCalls = 0, acceptedCalls = 0, recoveryCalls = 0, beginCalls = 0, lockCalls = 0, pending = null, active = 0, maxActive = 0;
  const physical = name => { assert.equal(typeof name, "string"); assert.ok(name.startsWith("/") && path.posix.normalize(name) === name, "canonical virtual path"); return path.join(root, name.slice(1)); };
  const dir = (name, mode = 0o700) => { fs.mkdirSync(physical(name), { recursive: true, mode }); fs.chmodSync(physical(name), mode); };
  const put = (name, bytes, mode = 0o600) => { dir(path.posix.dirname(name)); fs.writeFileSync(physical(name), bytes, { mode }); fs.chmodSync(physical(name), mode); };
  const get = name => fs.readFileSync(physical(name)), parsed = name => JSON.parse(get(name));
  const stats = (value, bigint) => new Proxy(value, { get(target, field) { if (["uid", "gid"].includes(field)) return bigint ? 0n : 0; const out = Reflect.get(target, field); return typeof out === "function" ? out.bind(target) : out; } });
  const mappedFs = { ...fs,
    realpathSync(name) { const actual = fs.realpathSync(physical(name)); assert.ok(actual === root || actual.startsWith(root + "/")); return "/" + path.relative(root, actual); },
    lstatSync(name, opts) { return stats(fs.lstatSync(physical(name), opts), opts?.bigint); },
    statSync(name, opts) { return stats(fs.statSync(physical(name), opts), opts?.bigint); },
    fstatSync(fd, opts) { return stats(fs.fstatSync(fd, opts), opts?.bigint); },
    existsSync(name) { return fs.existsSync(physical(name)); },
    readdirSync(name, opts) { return fs.readdirSync(physical(name), opts); },
    openSync(name, flags, mode) { const fd = fs.openSync(physical(name), flags, mode); handles.set(fd, name); return fd; },
    closeSync(fd) { fs.closeSync(fd); handles.delete(fd); },
    readSync(fd, ...args) {
      const count = fs.readSync(fd, ...args), name = handles.get(fd);
      if (options.retainedSourceDrift && name === work + "/" + candidateSHA + ".tgz") {
        options.retainedSourceDrift = false; fs.appendFileSync(physical(name), "changed during retention");
      }
      return count;
    },
    readFileSync(name, opts) { return fs.readFileSync(typeof name === "number" ? name : physical(name), opts); },
    writeFileSync(name, bytes, opts) { return fs.writeFileSync(typeof name === "number" ? name : physical(name), bytes, opts); },
    mkdirSync(name, opts) { return fs.mkdirSync(physical(name), opts); },
    chmodSync(name, mode) { return fs.chmodSync(physical(name), mode); },
    renameSync(from, to) { events.push("rename:" + to); return fs.renameSync(physical(from), physical(to)); },
    symlinkSync(target, name) { assert.ok(!path.posix.isAbsolute(target)); return fs.symlinkSync(target, physical(name)); },
    statfsSync(name, opts) { return name === "/sys/fs/cgroup" ? { type: 0x63677270 } : opts?.bigint ? { bavail: 20n * 1024n ** 3n, bsize: 1n } : { bavail: 20 * 1024 ** 3, bsize: 1 }; },
    rmSync(name, opts) { assert.match(name, /^\/var\/lib\/football-release\/frontend-builds\/[a-f0-9]{24}$/); events.push("cleanup-stage"); return fs.rmSync(physical(name), opts); },
  };
  const sourceFiles = {
    "package.json": JSON.stringify({ scripts: { build: build.BUILD_SCRIPT } }), "package-lock.json": "{\"lockfileVersion\":3}\n",
    "src/App.css": "body{color:old}", "server/index.cjs": "module.exports = 'unchanged runtime';\n",
    "scripts/stripLargeStaticPayloads.cjs": "// unchanged fixture strip input\n",
    "dist/index.html": '<script src="/assets/old-aaaaaaaa.js"></script>', "dist/assets/old-aaaaaaaa.js": "old asset",
    "dist/data/runtime-config.json": "{\"source\":\"static fallback differs from live config\"}",
  };
  const oldTar = tar(sourceFiles), nextFiles = { ...sourceFiles, "src/App.css": "body{color:new}" }, nextTar = tar(nextFiles);
  const runtimeSHA = sha(oldTar.bytes), candidateSHA = sha(nextTar.bytes), sequence = 12, runtimeSequence = 11, lockSHA = sha(sourceFiles["package-lock.json"]);
  const work = RELEASE + "/work/" + candidateSHA + ".Fixture", attempt = RELEASE + "/frontend-authorizations/" + candidateSHA;
  for (const name of [INSTALL, RELEASE, RELEASE + "/frontend-builds", RELEASE + "/frontend-dependencies", RELEASE + "/frontend-authorizations", RELEASE + "/recovery", APP, work, "/run", "/sys/fs/cgroup", "/etc/football-release"]) dir(name);
  put("/sys/fs/cgroup/cgroup.controllers", "cpu memory\n");
  const moduleNames = controllerSource.match(/const MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].match(/"[A-Za-z]+\.cjs"/g).map(x => JSON.parse(x));
  for (const name of moduleNames) put(INSTALL + "/" + name, fs.readFileSync(path.join(__dirname, name === "frontendReleaseIdentity.cjs" ? "../server/" + name : name)));
  put(INSTALL + "/node_modules/typescript/lib/typescript.js", parserBytes); put(INSTALL + "/node_modules/typescript/package.json", parserPackage);
  put(NODE, "fixture node binary bytes, never executed", 0o755);
  put("/etc/football-release/signing-public.pem", publicPem); put("/etc/football-release/expected-site", "fixture-site\n"); put("/etc/football-release/expected-channel", "fixture\n"); put("/etc/football-release/public-base-url", "https://fixture.invalid/\n");
  put(RELEASE + "/highest-accepted-sequence", String(sequence) + "\n");
  put(APP + "/.release-bundle-sha256", runtimeSHA + "\n"); put(APP + "/.release-live-complete", runtimeSHA + "\n");
  for (const [name, bytes] of Object.entries(sourceFiles)) if (name.startsWith("dist/")) put(APP + "/" + name, bytes, 0o644);
  put(APP + "/runtime-sentinel", "unchanged runtime"); put(RELEASE + "/database-sentinel", "unchanged database");
  const baselineDir = RELEASE + "/source-baselines/" + runtimeSHA; put(baselineDir + "/original.tgz", oldTar.bytes);
  put(work + "/" + candidateSHA + ".tgz", nextTar.bytes);
  const baselineEvidence = await archive.captureReleaseArchiveSourceEvidence(physical(baselineDir + "/original.tgz"));
  const candidateEvidence = await archive.captureReleaseArchiveSourceEvidence(physical(work + "/" + candidateSHA + ".tgz"));
  const oldDist = dist.inspectPrebuiltDist(physical(APP + "/dist"));
  const fullReceipt = { version: "frontend-full-baseline-acceptance-v1", runtimeSha256: runtimeSHA, runtimeSequence,
    indexSha256: sha(sourceFiles["dist/index.html"]), distTreeHash: oldDist.treeHash, checkedAt: new Date().toISOString(), checks: { runtimeMarkers: true, health: true, sourceBaseline: true } };
  const oldState = { version: identity.VERSION, kind: "full", phase: "accepted", runtimeSha256: runtimeSHA, runtimeSequence,
    frontendSha256: runtimeSHA, frontendSequence: runtimeSequence, indexSha256: fullReceipt.indexSha256, distTreeHash: oldDist.treeHash, acceptanceSha256: sha(json(fullReceipt)) };
  identity.validateFrontendAcceptanceReceipt(json(fullReceipt), oldState);
  put(STATE, json(oldState)); put(APP + "/.frontend-release-state.json", json(oldState), 0o644); put(APP + "/.frontend-release-acceptance.json", json(fullReceipt), 0o644);
  const dependencyRoot = RELEASE + "/frontend-dependencies/" + lockSHA; dir(dependencyRoot);
  dir(dependencyRoot + "/node_modules", 0o755); dir(dependencyRoot + "/node_modules/fixture", 0o755); dir(dependencyRoot + "/node_modules/.bin", 0o755);
  put(dependencyRoot + "/node_modules/fixture/cli.js", "throw new Error('must never execute');", 0o755);
  fs.symlinkSync("../fixture/cli.js", physical(dependencyRoot + "/node_modules/.bin/fixture"));
  fs.chmodSync(physical(dependencyRoot + "/node_modules/fixture"), 0o755);
  const deps = build.snapshotBuildInputs(physical(dependencyRoot), { beforeBuild: true });
  const dependencyRecord = { version: "frontend-build-dependencies-v1", lockSha256: lockSHA, dependencySha256: deps.dependencyHash };
  put(dependencyRoot + "/dependencies.json", json(dependencyRecord)); put(dependencyRoot + "/complete.json", json({ version: dependencyRecord.version, recordSha256: sha(json(dependencyRecord)) }));
  const policies = moduleNames.map(name => ({ name, sha256: sha(get(INSTALL + "/" + name)) }));
  const policy = { authorizationSha256: digest(policies), runtimeBoundarySha256: policies.find(p => p.name === "frontendRuntimeBoundary.cjs").sha256,
    sandboxSha256: digest(policies.filter(p => ["frontendBuildSandbox.cjs", "frontendBuildEvidence.cjs", "releasePrebuiltDist.cjs"].includes(p.name))) };
  const runtime = { nodeSha256: sha(get(NODE)), nodeVersion: "v22.22.1", dependencyLockSha256: lockSHA, buildDependencySha256: deps.dependencyHash, installedRuntimeSha256: sha("fixture installed runtime") };
  const binding = { version: "frontend-runtime-binding-v1", runtimeSha256: runtimeSHA, runtimeSequence, inventorySha256: baselineEvidence.inventorySha256, runtime, policies: policy };
  put(BINDING, json(binding)); put(APP + "/.frontend-release-binding.json", json(binding), 0o644);
  const baseManifest = evidence => ({ manifestVersion: 3, ok: true, sha256: evidence.archiveSha256, bytes: evidence.archiveBytes, entries: evidence.archiveEntryCount,
    site: "fixture-site", channel: "fixture", releaseSequence: runtimeSequence, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    policyVersion: "release-secret-policy-v2", signature: { algorithm: signing.RELEASE_SIGNATURE_ALGORITHM, keyId: signing.publicKeyId(key.publicKey) },
    blockedEntries: [], sensitiveEntries: [], missingEntries: [], releaseActions: [], archiveSourceEvidence: evidence });
  const fullManifest = baseManifest(baselineEvidence); put(baselineDir + "/manifest.json", json(fullManifest)); put(baselineDir + "/manifest.sig", signing.signManifestBytes(json(fullManifest), key.privateKey));
  const manifest = { ...baseManifest(candidateEvidence), releaseSequence: sequence, releaseKind: "frontend-only", frontendAuthorization: {
    version: authorization.VERSION, baseline: { runtimeSha256: runtimeSHA, runtimeSequence, inventorySha256: baselineEvidence.inventorySha256,
      frontendStateSha256: sha(json(oldState)), indexSha256: oldState.indexSha256, distTreeHash: oldState.distTreeHash },
    candidateInventorySha256: candidateEvidence.inventorySha256, runtime, policies: policy, changedPaths: ["src/App.css"] } };
  const sign = () => { put(work + "/" + candidateSHA + ".manifest.json", json(manifest)); put(work + "/" + candidateSHA + ".manifest.sig", signing.signManifestBytes(json(manifest), key.privateKey)); };
  sign();
  const distModule = { ...dist, inspectPrebuiltDist: input => dist.inspectPrebuiltDist(physical(input)) };
  const buildModule = { ...build, snapshotBuildInputs: (input, opts) => build.snapshotBuildInputs(physical(input), opts) };
  const command = (exe, args) => {
    events.push("command:" + exe + ":" + args.join(" "));
    if (exe === "/usr/bin/systemctl" && args.length === 2 && args[0] === "is-active") return { status: options.serviceFailure ? 3 : 0, stdout: options.serviceFailure ? "inactive\n" : "active\n" };
    assert.equal(exe, "/usr/bin/tar", "no full release/build/provider command allowed"); assert.deepEqual(Array.from(args).slice(0, 3), ["--no-same-owner", "--no-same-permissions", "-xzf"]);
    const destination = args[5], packed = sha(get(args[3])) === runtimeSHA ? oldTar : nextTar;
    for (const row of packed.rows) { const target = destination + "/" + row.path; if (row.kind === "directory") dir(target); else put(target, row.bytes); }
    if (options.extractDrift && destination.endsWith("/source")) put(destination + "/server/index.cjs", "changed");
    return { status: 0, stdout: "" };
  };
  const transport = { get(url, _opts, callback) {
    const req = new EventEmitter(); let ended = false;
    req.destroy = error => { if (!ended) { ended = true; active--; req.emit("error", error); } };
    active++; maxActive = Math.max(maxActive, active); requests.push(url.pathname + url.search); events.push("http:" + url.pathname);
    setImmediate(() => {
      if (ended) return;
      if (options.networkFailure) { req.destroy(new Error("fixture-network-offline")); return; }
      let status = 200, bytes;
      if (url.pathname === "/api/v1/health") {
        let state = parsed(APP + "/.frontend-release-state.json"); if (options.healthIdentityDrift) state = { ...state, frontendSha256: runtimeSHA };
        bytes = json({ apiVersion: "v1", status: { serviceOk: !options.healthFailure }, frontendRelease: { available: true, consistent: true, ...state } });
      } else if (url.pathname.startsWith("/api/")) { status = options.protectedLeak ? 200 : 401; bytes = Buffer.from("protected"); }
      else if (["/matches.json", "/odds-history.json", "/data/matches-history.json", "/data/odds-history.json"].includes(url.pathname)) { status = 404; bytes = Buffer.from("absent"); }
      else if (url.pathname === "/data/runtime-config.json") {
        const config = { dataApiBase: "/api/v1", legacyDataApiBase: "/api", eventStreamPath: "/api/v1/events", preferDataApi: true,
          historyPreferStatic: false, access: { required: true, ttlSeconds: 3600 }, currentPollSeconds: 20 };
        options.mutateConfig?.(config); bytes = json(config);
      } else {
        const filename = APP + "/dist/" + (url.pathname === "/" ? "index.html" : url.pathname.slice(1));
        bytes = get(filename); if (options.artifactDrift) bytes = Buffer.concat([bytes, Buffer.from("drift")]);
      }
      const response = new EventEmitter(); response.statusCode = status; callback(response);
      setImmediate(() => { if (ended) return; response.emit("data", bytes); if (ended) return; ended = true; active--; response.emit("end"); });
    }); return req;
  } };
  const vmProcess = { platform: "linux", getuid: () => 0, execPath: NODE, version: "v22.22.1", versions: { node: "22.22.1" }, env: {}, argv: [], exitCode: 0 };
  const evaluate = (code, filename, closure) => {
    const module = { exports: {} };
    const requireFixture = name => {
      if (name === "node:fs") return mappedFs;
      if (name === "node:child_process") return { spawnSync: command };
      if (["node:https", "node:http"].includes(name)) return transport;
      if (Object.hasOwn(closure, name)) return closure[name];
      assert.ok(name.startsWith("node:"), "unexpected VM require " + name); return require(name);
    };
    vm.runInNewContext(code, { require: requireFixture, module, exports: module.exports, __dirname: INSTALL, __filename: filename,
      Buffer, URL, process: vmProcess, console, setTimeout, clearTimeout }, { filename });
    return module.exports;
  };
  const sandboxReader = evaluate(fs.readFileSync(path.join(__dirname, "frontendBuildSandbox.cjs"), "utf8"), INSTALL + "/frontendBuildSandbox.cjs",
    { "./frontendBuildEvidence.cjs": buildModule, "./releasePrebuiltDist.cjs": distModule });
  const transactionModule = {
    assertFrontendReleaseLock() { lockCalls++; events.push("lock"); if (options.lockFailure) throw new Error("fixture-missing-lock"); },
    beginFrontendRelease(input) {
      beginCalls++; events.push("begin"); assert.equal(sha(get(STATE)), input.expectedStateSha256);
      build.validateDistManifest(input.expectedDistManifest); assert.equal(distModule.inspectPrebuiltDist(APP + "/dist").treeHash, input.expectedDistManifest.treeHash);
      assert.equal(sha(input.candidateIndex.bytes), input.candidateIndex.sha256);
      assert.equal(sha(get(attempt + "/authorization.json")), input.authorizationSha256);
      assert.equal(parsed(attempt + "/complete.json").authorizationSha256, input.authorizationSha256);
      dir(CURRENT); put(CURRENT + "/fixture-binding.json", json({ authorizationSha256: input.authorizationSha256, expectedStateSha256: input.expectedStateSha256 }));
      for (const row of input.newAssets) { assert.equal(sha(row.bytes), row.sha256); assert.ok(!mappedFs.existsSync(APP + "/dist/" + row.path)); put(APP + "/dist/" + row.path, row.bytes, 0o644); }
      put(APP + "/dist/index.html", input.candidateIndex.bytes, 0o644);
      pending = { ...oldState, kind: "frontend-only", phase: "pending", frontendSha256: input.frontendSha256, frontendSequence: input.frontendSequence,
        indexSha256: input.candidateIndex.sha256, distTreeHash: distModule.inspectPrebuiltDist(APP + "/dist").treeHash, acceptanceSha256: null };
      identity.validateFrontendReleaseState(pending); put(STATE, json(pending)); put(APP + "/.frontend-release-state.json", json(pending), 0o644);
      if (options.beginFailure) throw new Error("fixture-begin-after-pending");
      return { transactionId: "d".repeat(24), state: pending };
    },
    acceptFrontendRelease(input) {
      acceptedCalls++; events.push("accept"); assert.equal(input.transactionId, "d".repeat(24)); assert.equal(sha(input.acceptanceReceiptBytes), input.acceptanceSha256);
      const state = { ...pending, phase: "accepted", acceptanceSha256: input.acceptanceSha256 };
      identity.validateFrontendAcceptanceReceipt(input.acceptanceReceiptBytes, state);
      assert.equal(JSON.parse(input.acceptanceReceiptBytes).authorizationSha256, parsed(CURRENT + "/fixture-binding.json").authorizationSha256);
      put(CURRENT + "/acceptance.json", input.acceptanceReceiptBytes); put(CURRENT + "/accept-intent.json", json({ version: "frontend-release-transaction-v1", transactionId: input.transactionId, acceptanceSha256: input.acceptanceSha256 }));
      if (options.acceptFailure) throw new Error("fixture-after-accept-intent");
      put(APP + "/.frontend-release-acceptance.json", input.acceptanceReceiptBytes, 0o644); put(STATE, json(state)); put(APP + "/.frontend-release-state.json", json(state), 0o644);
      fs.renameSync(physical(CURRENT), physical(RELEASE + "/recovery/fixture-accepted")); return { state };
    },
    recoverFrontendRelease() {
      recoveryCalls++; events.push("recover"); const accepted = mappedFs.existsSync(CURRENT + "/accept-intent.json");
      if (accepted) {
        const intent = parsed(CURRENT + "/accept-intent.json"), receipt = get(CURRENT + "/acceptance.json"), state = { ...pending, phase: "accepted", acceptanceSha256: intent.acceptanceSha256 };
        identity.validateFrontendAcceptanceReceipt(receipt, state);
      } else if (pending) put(APP + "/dist/index.html", sourceFiles["dist/index.html"], 0o644);
      if (mappedFs.existsSync(CURRENT)) fs.renameSync(physical(CURRENT), physical(RELEASE + "/recovery/fixture-resolved"));
      return { action: accepted ? "rollforward" : "rollback", ok: true };
    },
    initializeFullFrontendState() { throw new Error("full-initialization-must-not-run-in-apply-test"); },
  };
  const closure = {
    frontendReleaseAuthorization: { ...authorization, compareAuthorizedFrontendSources(input) { events.push("source-compare"); return authorization.compareAuthorizedFrontendSources(input); } },
    frontendReleaseTransaction: transactionModule, frontendReleaseIdentity: identity,
    frontendInstalledRuntime: { captureInstalledFrontendRuntime(input) {
      installedCalls++; events.push("installed-runtime"); assert.equal(input.baselineInventory.treeHash, baselineEvidence.inventorySha256);
      return { ok: true, installedRuntimeSha256: options.runtimeDriftAt === installedCalls ? sha("drift") : runtime.installedRuntimeSha256 };
    } },
    frontendRuntimeBoundary: { compareFrontendRuntimeBoundary(input) {
      events.push("runtime-boundary"); assert.equal(input.baseline.authenticatedInventoryHash, baselineEvidence.inventorySha256); assert.equal(input.candidate.authenticatedInventoryHash, candidateEvidence.inventorySha256);
      return { ok: !options.boundaryFailure, blockers: options.boundaryFailure ? ["fixture-unreviewed-runtime"] : [], evidenceHash: digest(input) };
    } },
    frontendBuildSandbox: { ...sandboxReader,
      runSandboxedFrontendBuild(input) {
        sandboxCalls++; events.push("sandbox"); assert.equal(sandboxCalls, 1); assert.equal(input.baselineReleaseSha256, runtimeSHA); assert.equal(input.baselineDist.treeHash, oldDist.treeHash);
        if (options.buildFailure) { const e = new Error("fixture-build-failure"); e.evidence = { rootfsRemoved: false }; throw e; }
        const before = buildModule.snapshotBuildInputs(input.rootDir, { beforeBuild: true });
        const generated = { "index.html": '<script src="/assets/new-bbbbbbbb.js"></script>', "assets/new-bbbbbbbb.js": "new asset",
          "data/runtime-config.json": sourceFiles["dist/data/runtime-config.json"] };
        for (let i = 0; i < 6; i++) generated["assets/chunk" + i + "-bbbbbbbb.js"] = "chunk " + i;
        for (const [name, bytes] of Object.entries(generated)) put(input.rootDir + "/dist/" + name, bytes);
        const artifact = distModule.inspectPrebuiltDist(input.rootDir + "/dist"), directory = "/run/football-frontend-sandbox-" + "e".repeat(24);
        const record = { version: sandboxReader.VERSION, executionAssurance: sandboxReader.ASSURANCE, scope: "isolated-frontend-build", signingEligible: false, deploymentAuthorized: false,
          baseline: { releaseSha256: runtimeSHA, distTreeHash: oldDist.treeHash, manifestHash: digest(oldDist), authentication: "must-be-independently-proven-by-release-controller" },
          sourceHash: before.sourceHash, dependencyHash: before.dependencyHash, artifact, overlay: build.inspectOverlayArtifacts(oldDist, artifact), cacheOutputs: [],
          controllerPolicies: [], runtime: [], environment: clone(sandboxReader.ENV), inputMirror: "bounded-byte-identical-membership-alias-mode-verified-readonly-mirror", commandPolicyHash: digest(sandboxReader.COMMANDS),
          startedAt: Date.now(), finishedAt: Date.now(), runs: [1, 2, 3].map(i => ({ ok: true, cleanup: { quiescent: true }, unit: "football-frontend-build-" + "e".repeat(24) + "-" + i + ".service" })),
          descendantsQuiescent: true, externalInputIsolation: true, productionWrites: 0, providerRequests: 0, rootfsRemoved: true };
        options.mutateReceipt?.(record); const bytes = Buffer.from(JSON.stringify(record)), evidenceHash = sha(bytes);
        put(directory + "/evidence.json", bytes); put(directory + "/complete.json", json({ version: record.version, evidenceHash }));
        if (options.recordByteDrift) put(directory + "/evidence.json", Buffer.concat([bytes, Buffer.from(" ")]));
        if (options.outputDrift) put(input.rootDir + "/dist/index.html", "replaced after evidence");
        if (options.stateDriftDuringBuild) put(STATE, json({ ...oldState, acceptanceSha256: sha("other accepted receipt") }));
        if (options.policyDriftDuringBuild) put(INSTALL + "/frontendReleaseAuthorization.cjs", "changed fixed controller policy");
        return { ...record, directory, evidenceHash };
      },
      readSandboxEvidence(input) { events.push("read-build-receipt"); return sandboxReader.readSandboxEvidence(input); },
    },
    frontendBuildEvidence: buildModule,
    releaseSourceBaseline: { async verifyRetained(input) {
      events.push("retained-baseline"); assert.equal(input.sha256, runtimeSHA); assert.equal(input.sequence, runtimeSequence);
      signing.validateReleaseManifestV3(fullManifest); assert.ok(signing.verifyManifestBytes(get(baselineDir + "/manifest.json"), get(baselineDir + "/manifest.sig"), key.publicKey));
      await archive.verifyArchiveSourceEvidence(physical(baselineDir + "/original.tgz"), fullManifest); return { directory: baselineDir };
    } },
    releaseSigning: { ...signing, verifyManifestBytes(...args) { events.push("signature"); return signing.verifyManifestBytes(...args); } },
    releaseArchiveSourceInventory: { ...archive, async verifyArchiveSourceEvidence(input, value) { events.push("archive-verify"); return archive.verifyArchiveSourceEvidence(physical(input), value); } },
    releasePrebuiltDist: distModule,
  };
  const fixed = Object.fromEntries(Object.entries(closure).map(([name, value]) => [INSTALL + "/" + name + ".cjs", value]));
  const controller = evaluate(controllerSource, INSTALL + "/frontendReleaseController.cjs", fixed);
  return { controller, root, put, get, parsed, physical, dir, sign, manifest, runtimeSHA, candidateSHA, sequence, oldState, oldDist, binding, work, attempt, dependencyRoot,
    events, requests, options, transactionModule, sandboxReader, vmProcess,
    async apply() { return controller.main(["apply", candidateSHA, String(sequence), work]); },
    counters() { return { sandboxCalls, installedCalls, acceptedCalls, recoveryCalls, beginCalls, lockCalls, active, maxActive }; },
    async dispose() { for (let i = 0; i < 20 && active; i++) await tick(); assert.equal(active, 0); assert.equal(handles.size, 0); assert.equal(fs.statSync(root).ino, rootInode); assert.equal(fs.realpathSync(root), root); fs.rmSync(root, { recursive: true }); },
  };
}
async function verify() {
  const checks = [], check = async (name, body) => { try { await body(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: e.stack }); } };
  const withFixture = async (options, body) => { const f = await fixture(options); try { await body(f); } finally { await f.dispose(); } };
  await check("unchanged controller orchestrates signed source to one sandbox record and strict acceptance", () => withFixture({}, async f => {
    const result = await f.apply(); assert.equal(result.ok, true); assert.equal(result.frontendSha256, f.candidateSHA); assert.equal(result.runtimeSha256, f.runtimeSHA);
    assert.equal(result.buildExecutions, 1); assert.equal(f.counters().sandboxCalls, 1); assert.equal(f.counters().beginCalls, 1); assert.equal(f.counters().acceptedCalls, 1);
    assert.equal(f.counters().active, 0); assert.equal(f.counters().maxActive, 4);
    const order = ["signature", "archive-verify", "retained-baseline", "source-compare", "runtime-boundary", "sandbox", "read-build-receipt", "begin", "accept"];
    let prior = -1; for (const event of order) { const index = f.events.indexOf(event); assert.ok(index > prior, event); prior = index; }
    const saved = f.parsed(f.attempt + "/authorization.json"), complete = f.parsed(f.attempt + "/complete.json");
    assert.equal(complete.authorizationSha256, sha(f.get(f.attempt + "/authorization.json")));
    assert.equal(saved.buildEvidenceSha256, sha(f.get(f.attempt + "/build-evidence.json"))); assert.equal(saved.manifestSha256, sha(f.get(f.attempt + "/manifest.json")));
    assert.equal(sha(f.get(f.attempt + "/original.tgz")), f.candidateSHA); assert.equal(saved.stateSha256, sha(json(f.oldState)));
    const accepted = identity.parseFrontendReleaseState(f.get(STATE)); identity.validateFrontendAcceptanceReceipt(f.get(APP + "/.frontend-release-acceptance.json"), accepted);
    assert.equal(f.get(APP + "/.release-live-complete").toString().trim(), f.runtimeSHA); assert.equal(f.get(APP + "/runtime-sentinel").toString(), "unchanged runtime");
    assert.equal(f.get(RELEASE + "/database-sentinel").toString(), "unchanged database");
    assert.ok(f.requests.includes("/data/runtime-config.json")); // Live semantic config differs from committed fallback bytes.
  }));
  const rejected = (name, opts, mutate, pattern, builds = 0, begins = 0) => check(name, () => withFixture(opts, async f => {
    await mutate?.(f); await assert.rejects(f.apply(), pattern); assert.equal(f.counters().sandboxCalls, builds); assert.equal(f.counters().beginCalls, begins); assert.equal(f.counters().acceptedCalls, 0);
    assert.ok(!f.events.some(e => /restart|release-from-bundle|npm|systemd-run/.test(e)));
    if (begins) assert.equal(f.counters().recoveryCalls, 1);
  }));
  await rejected("invalid signature fails before archive/build", {}, f => f.put(f.work + "/" + f.candidateSHA + ".manifest.sig", "bad signature"), /signature-invalid/);
  await rejected("missing inherited lock blocks before authentication/build", { lockFailure: true }, null, /missing-lock/);
  await rejected("validly signed expired manifest cannot reach archive/build", {}, f => {
    f.manifest.createdAt = new Date(Date.now() - 7200000).toISOString(); f.manifest.expiresAt = new Date(Date.now() - 3600000).toISOString(); f.sign();
  }, /expired/);
  await rejected("full kind cannot enter the frontend apply route", {}, f => { f.manifest.releaseKind = "full"; delete f.manifest.frontendAuthorization; f.sign(); }, /identity-or-policy/);
  await rejected("signed state hash drift stops before build", {}, f => f.put(STATE, json({ ...f.oldState, acceptanceSha256: sha("external") })), /signed-current-state/);
  await rejected("public runtime binding drift stops before build", {}, f => f.put(APP + "/.frontend-release-binding.json", json({ ...f.binding, inventorySha256: sha("external") }), 0o644), /runtime-or-policy-binding/);
  await rejected("complete source inventory mismatch cannot pass a valid signature", {}, f => {
    f.manifest.frontendAuthorization.baseline.inventorySha256 = sha("wrong inventory"); f.binding.inventorySha256 = sha("wrong inventory");
    f.put(BINDING, json(f.binding)); f.put(APP + "/.frontend-release-binding.json", json(f.binding), 0o644); f.sign();
  }, /inventory-commitment/);
  await rejected("archive bytes drift is rejected before extraction", {}, f => f.put(f.work + "/" + f.candidateSHA + ".tgz", "not the signed archive"), /header|gzip|archive|compression/);
  await rejected("retained archive is copied from one stable descriptor and detects source growth", { retainedSourceDrift: true }, null, /retained-content-drift/);
  await rejected("extracted file drift fails before any build", { extractDrift: true }, null, /extracted-file-drift|extracted-content-drift/);
  await rejected("dependency record requires complete raw-byte hash", {}, f => f.put(f.dependencyRoot + "/complete.json", json({ version: "frontend-build-dependencies-v1", recordSha256: sha("wrong") })), /dependency-store-binding/);
  await rejected("runtime boundary refusal never falls back to full", { boundaryFailure: true }, null, /runtime-source-boundary/);
  await rejected("installed runtime drift before build is rejected", { runtimeDriftAt: 1 }, null, /installed-runtime-changed/);
  await check("one failed build is retained without retry or cleanup under unproven descendants", () => withFixture({ buildFailure: true }, async f => {
    await assert.rejects(f.apply(), /fixture-build-failure/); assert.equal(f.counters().sandboxCalls, 1); assert.equal(f.counters().beginCalls, 0); assert.ok(!f.events.includes("cleanup-stage"));
  }));
  for (const [name, mutate] of [
    ["source", r => { r.sourceHash = sha("drift"); }], ["dependency", r => { r.dependencyHash = sha("drift"); }],
    ["baseline", r => { r.baseline.distTreeHash = sha("drift"); }], ["HOME", r => { r.environment.HOME = "/tmp"; }],
    ["command", r => { r.commandPolicyHash = sha("drift"); }], ["cgroup proof", r => { r.descendantsQuiescent = false; }],
  ]) await rejected("actual sandbox reader/controller rejects " + name + " receipt drift", { mutateReceipt: mutate }, null, /receipt-input|not-production-build-proof/, 1);
  await rejected("sandbox raw record drift cannot satisfy complete hash", { recordByteDrift: true }, null, /sandbox-evidence-drift/, 1);
  await rejected("export drift after complete record cannot reach transaction", { outputDrift: true }, null, /export-changed/, 1);
  await rejected("current state mutation during build prevents transaction", { stateDriftDuringBuild: true }, null, /current-baseline-changed/, 1);
  await rejected("fixed controller policy drift during build prevents transaction", { policyDriftDuringBuild: true }, null, /controller-drift/, 1);
  await rejected("runtime drift after build prevents transaction", { runtimeDriftAt: 2 }, null, /runtime-or-controller-drift/, 1);
  await rejected("runtime drift after public checks prevents acceptance and rolls back once", { runtimeDriftAt: 3 }, null, /runtime-drift-before-acceptance/, 1, 1);
  await check("public artifact mismatch drains four in-flight reads then rolls back without new requests", () => withFixture({ artifactDrift: true }, async f => {
    await assert.rejects(f.apply(), /public-artifact-mismatch|response-limit/);
    assert.equal(f.counters().active, 0); assert.equal(f.counters().recoveryCalls, 1); assert.equal(f.counters().sandboxCalls, 1); assert.equal(f.requests.length, 4);
    const count = f.requests.length; await tick(); assert.equal(f.requests.length, count);
  }));
  await rejected("public health state drift rolls back without full fallback", { healthIdentityDrift: true }, null, /health-identity-mismatch/, 1, 1);
  await rejected("protected API leak cannot authorize acceptance", { protectedLeak: true }, null, /protected-api-exposed/, 1, 1);
  await rejected("service failure cannot authorize acceptance", { serviceFailure: true }, null, /fixed-command-failed|service-not-active/, 1, 1);
  for (const [name, mutate] of [
    ["API path", c => { c.dataApiBase = "https://external.invalid"; }], ["auth", c => { c.access.required = false; }],
    ["TTL", c => { c.access.ttlSeconds = 0; }], ["poll interval", c => { c.currentPollSeconds = -1; }],
    ["static history", c => { c.historyPreferStatic = true; }],
  ]) await rejected("dynamic runtime config rejects " + name + " mismatch", { mutateConfig: mutate }, null, /runtime-config-invalid/, 1, 1);
  await check("begin throw after pending remains eligible for offline rollback", () => withFixture({ beginFailure: true, networkFailure: true }, async f => {
    await assert.rejects(f.apply(), /begin-after-pending/); assert.equal(f.counters().recoveryCalls, 1); assert.equal(f.counters().sandboxCalls, 1); assert.equal(f.requests.length, 0);
  }));
  await check("recovery with no accept intent is reachable with no health/service network", () => withFixture({ networkFailure: true, serviceFailure: true }, async f => {
    f.dir(CURRENT); const result = await f.controller.main(["recover"]); assert.equal(result.action, "rollback"); assert.equal(f.requests.length, 0); assert.ok(!f.events.some(e => e.includes("systemctl")));
  }));
  await check("valid accept intent rollforward uses fresh health/services without rebuilding", () => withFixture({ acceptFailure: true }, async f => {
    await assert.rejects(f.apply(), /after-accept-intent/); assert.equal(f.counters().acceptedCalls, 1); assert.equal(f.counters().recoveryCalls, 1); assert.equal(f.counters().sandboxCalls, 1);
    assert.equal(f.requests.filter(p => p === "/api/v1/health").length, 2); assert.ok(f.events.indexOf("recover") > f.events.lastIndexOf("http:/api/v1/health"));
  }));
  await check("accept intent cannot roll forward while fresh outer health fails", () => withFixture({ networkFailure: true }, async f => {
    f.put(CURRENT + "/accept-intent.json", json({ version: "frontend-release-transaction-v1" })); await assert.rejects(f.controller.main(["recover"]), /offline/); assert.equal(f.counters().recoveryCalls, 0);
  }));
  await check("fixed CLI rejects aliases extra arguments unsafe sequence and loader env", () => withFixture({}, async f => {
    for (const argv of [[], ["deploy"], ["recover", "/tmp/anything"], ["apply", f.candidateSHA, "012", f.work], ["apply", f.candidateSHA, "NaN", f.work]]) await assert.rejects(f.controller.main(argv), /usage-fixed/);
    f.vmProcess.env.NODE_OPTIONS = "--require=/tmp/untrusted"; await assert.rejects(f.controller.main(["recover"]), /fixed-clean-root/); assert.equal(f.counters().sandboxCalls, 0);
  }));
  return { ok: checks.every(c => c.ok), version: "frontend-controller-orchestration-verification-v1", controllerSha256: sha(controllerSource), checks,
    boundary: "Unchanged controller VM. Real RSA signatures, source archive inventory/schema, dependency snapshots, artifact hashes, sandbox receipt reader and acceptance schema. Root/lock, tar process, runtime capture, sandbox execution, HTTP/services and transaction mutations are explicit test adapters, not production proof.",
    buildExecutions: 0, networkRequests: 0, productionWrites: 0 };
}
module.exports = { verify };
if (require.main === module) verify().then(report => { console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
