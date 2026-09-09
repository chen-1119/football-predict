"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
const modulePath = path.join(__dirname, "frontendReleaseTransaction.cjs"), digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.from(JSON.stringify(value) + "\n"), artifact = text => ({ bytes: Buffer.from(text), sha256: digest(Buffer.from(text)) });
const runtimeSha256 = "a".repeat(64), frontendSha256 = "b".repeat(64), authorizationSha256 = "c".repeat(64);
function observed() {
  const events = [], handles = new Map(), filesystem = { ...fs,
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); handles.set(fd, file); return fd; },
    closeSync(fd) { fs.closeSync(fd); handles.delete(fd); },
    fsyncSync(fd) { events.push({ kind: "fsync", path: handles.get(fd) }); return fs.fsyncSync(fd); },
    renameSync(from, to) { events.push({ kind: "rename", from, to }); return fs.renameSync(from, to); },
  };
  const module = { exports: {} }, code = fs.readFileSync(modulePath, "utf8");
  const evaluate = vm.runInThisContext("(function(require,module,exports,__dirname,__filename){" + code
    + "\nmodule.exports.testOnly={parseLockRows,begin,accept,recover,paths};\n})", { filename: modulePath });
  evaluate(name => name === "node:fs" ? filesystem : require(name), module, module.exports, __dirname, modulePath);
  return { ...module.exports, events, handles };
}
function put(filename, content, mode = 0o644) { fs.writeFileSync(filename, content, { mode }); fs.chmodSync(filename, mode); }
function createFixture() {
  const module = observed(); let armed = null;
  const adapter = module.createFrontendReleaseFixtureAdapter({ onStep: phase => { if (phase === armed) { armed = null; throw new Error("fixture-interruption:" + phase); } } });
  const p = adapter.paths, original = artifact("<main>old UI</main>"), candidate = artifact("<main>new UI</main>"), oldAsset = artifact("old lazy module"), newAsset = artifact("new immutable module");
  put(path.join(p.dist, "index.html"), original.bytes); put(path.join(p.dist, "assets/old-aaaaaaaa.js"), oldAsset.bytes);
  put(path.join(p.dist, "robots.txt"), "unchanged robots"); put(path.join(p.app, "runtime-sentinel"), "unchanged runtime");
  put(path.join(adapter.rootDir, "data-sentinel"), "unchanged data");
  put(path.join(p.app, ".release-bundle-sha256"), runtimeSha256 + "\n"); put(path.join(p.app, ".release-live-complete"), runtimeSha256 + "\n");
  put(p.sequence, "10\n", 0o600);
  // Exact existing football-release write_status date -u format: no millis.
  put(path.join(p.status, runtimeSha256 + ".status"), `status=complete\nok=1\nexitCode=0\nbundleSha256=${runtimeSha256}\nfinishedAt=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\n`, 0o600);
  const fullReceipt = () => bytes({ version: "frontend-full-baseline-acceptance-v1", runtimeSha256, runtimeSequence: 10,
    indexSha256: original.sha256, distTreeHash: inspectPrebuiltDist(p.dist).treeHash, checkedAt: new Date().toISOString(), checks: { runtimeMarkers: true, health: true, sourceBaseline: true } });
  const initialize = () => { const acceptanceReceiptBytes = fullReceipt(); return adapter.initialize({ runtimeSha256, runtimeSequence: 10, acceptanceReceiptBytes, acceptanceSha256: digest(acceptanceReceiptBytes) }); };
  const state = () => JSON.parse(fs.readFileSync(p.state, "utf8"));
  const plan = () => ({ expectedStateSha256: digest(fs.readFileSync(p.state)), expectedDistManifest: inspectPrebuiltDist(p.dist),
    candidateIndex: candidate, newAssets: [{ path: "assets/new-bbbbbbbb.js", ...newAsset }], runtimeSha256, runtimeSequence: 10,
    frontendSha256, frontendSequence: 11, authorizationSha256 });
  const uiReceipt = transactionId => { const value = state(); return bytes({ version: "frontend-readonly-acceptance-v1", transactionId,
    runtimeSha256, runtimeSequence: 10, frontendSha256, frontendSequence: 11, indexSha256: value.indexSha256, distTreeHash: value.distTreeHash,
    authorizationSha256, checkedAt: new Date().toISOString(), checks: { index: true, assets: true, health: true, protected: true, services: true } }); };
  const accept = id => { const acceptanceReceiptBytes = uiReceipt(id); return adapter.accept({ transactionId: id, acceptanceReceiptBytes, acceptanceSha256: digest(acceptanceReceiptBytes) }); };
  const prepared = () => { initialize(); put(p.sequence, "11\n", 0o600); };
  const stable = () => {
    assert.equal(fs.readFileSync(path.join(p.app, "runtime-sentinel"), "utf8"), "unchanged runtime");
    assert.equal(fs.readFileSync(path.join(adapter.rootDir, "data-sentinel"), "utf8"), "unchanged data");
    assert.equal(fs.readFileSync(path.join(p.dist, "robots.txt"), "utf8"), "unchanged robots");
    for (const name of [".release-bundle-sha256", ".release-live-complete"]) assert.equal(fs.readFileSync(path.join(p.app, name), "utf8"), runtimeSha256 + "\n");
    assert.equal(module.handles.size, 0);
  };
  const accepted = expectedSha => {
    stable(); const value = state(); assert.equal(value.phase, "accepted"); assert.equal(value.frontendSha256, expectedSha);
    assert.equal(value.indexSha256, digest(fs.readFileSync(path.join(p.dist, "index.html"))));
    assert.equal(value.distTreeHash, inspectPrebuiltDist(p.dist).treeHash); assert.deepEqual(fs.readFileSync(p.state), fs.readFileSync(p.projection));
    assert.equal(digest(fs.readFileSync(p.acceptanceProjection)), value.acceptanceSha256);
    assert.equal(fs.statSync(p.state).mode & 0o777, 0o600); assert.equal(fs.statSync(p.projection).mode & 0o777, 0o644);
    assert.equal(fs.statSync(p.acceptanceProjection).mode & 0o777, 0o644); assert.equal(fs.statSync(p.acceptanceProjection).nlink, 1);
    assert.equal(fs.existsSync(p.current), false);
  };
  return { module, adapter, p, original, candidate, oldAsset, newAsset, plan, initialize, prepared, accept, uiReceipt, fullReceipt, state,
    arm: phase => { armed = phase; }, accepted, stable, dispose: () => { stable(); adapter.dispose(); assert.equal(fs.existsSync(adapter.rootDir), false); } };
}
function crashChild(args) {
  const [root, action, failAt] = args; assert.equal(process.platform, "linux");
  assert.match(path.basename(root), /^football-frontend-release-fixture-[A-Za-z0-9]+$/); assert.equal(path.dirname(root), fs.realpathSync(require("node:os").tmpdir()));
  assert.equal(fs.realpathSync(root), root); assert.equal(fs.statSync(root).uid, process.getuid()); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const module = observed(), p = module.testOnly.paths({ app: path.join(root, "app"), releaseRoot: path.join(root, "release"), stageRoot: path.join(root, "stages"), lock: path.join(root, "fixture.lock") });
  const context = { paths: p, uid: process.getuid(), boundary: root, fixture: true, assertFixtureLock() {},
    onStep: phase => { if (phase === failAt) process.kill(process.pid, "SIGKILL"); } };
  // This private VM test harness is not part of the production module API.
  if (action === "begin" || action === "begin-next-ui") {
    const next = action === "begin-next-ui";
    module.testOnly.begin(context, { expectedStateSha256: digest(fs.readFileSync(p.state)), expectedDistManifest: inspectPrebuiltDist(p.dist),
      candidateIndex: artifact(next ? "<main>next UI</main>" : "<main>new UI</main>"),
      newAssets: [{ path: next ? "assets/next-dddddddd.js" : "assets/new-bbbbbbbb.js", ...artifact(next ? "next immutable module" : "new immutable module") }],
      runtimeSha256, runtimeSequence: 10, frontendSha256: next ? "d".repeat(64) : frontendSha256,
      frontendSequence: next ? 12 : 11, authorizationSha256: next ? "e".repeat(64) : authorizationSha256 });
  } else if (action === "accept") {
    const record = JSON.parse(fs.readFileSync(path.join(p.current, "frontend-transaction.json"))), value = record.pendingState;
    const acceptanceReceiptBytes = bytes({ version: "frontend-readonly-acceptance-v1", transactionId: record.id, runtimeSha256: value.runtimeSha256,
      runtimeSequence: value.runtimeSequence, frontendSha256: value.frontendSha256, frontendSequence: value.frontendSequence, indexSha256: value.indexSha256,
      distTreeHash: value.distTreeHash, authorizationSha256: record.authorizationSha256, checkedAt: new Date().toISOString(),
      checks: { index: true, assets: true, health: true, protected: true, services: true } });
    module.testOnly.accept(context, { transactionId: record.id, acceptanceReceiptBytes, acceptanceSha256: digest(acceptanceReceiptBytes) });
  } else if (action === "recover") module.testOnly.recover(context);
  else throw new Error("invalid fixture child action");
}
function verify() {
  if (process.platform !== "linux") throw new Error("real Linux atomic rename/directory-fsync/proc-lock fixtures required");
  const checks = [], check = (name, work) => { work(); checks.push({ name, ok: true }); };
  check("fixed production exports have no CLI or injectable path/hook; fixtures have their own private root", () => {
    const f = createFixture(); try {
      assert.equal(f.adapter.fixtureOnly, true); assert.equal(f.adapter.deploymentAuthorized, false);
      assert.deepEqual(Object.keys(require(modulePath)).sort(), ["VERSION", "STATE_VERSION", "FIXED", "assertFrontendReleaseLock", "beginFrontendRelease", "acceptFrontendRelease", "recoverFrontendRelease", "initializeFullFrontendState", "createFrontendReleaseFixtureAdapter"].sort());
      if (process.getuid() !== 0) assert.throws(() => require(modulePath).recoverFrontendRelease(), /fixed-clean-root-node-required/);
    } finally { f.dispose(); }
  });
  check("full baseline requires successful root status, consumed sequence and exact live markers", () => {
    const f = createFixture(); try {
      put(f.p.sequence, "9\n", 0o600); assert.throws(f.initialize, /sequence-mismatch/); put(f.p.sequence, "10\n", 0o600);
      put(path.join(f.p.status, runtimeSha256 + ".status"), "status=running\n", 0o600); assert.throws(f.initialize, /acceptance-not-proven/);
      assert.equal(fs.existsSync(f.p.state), false);
    } finally { f.dispose(); }
  });
  check("full status accepts wrapper canonical seconds and Node milliseconds but rejects loose dates", () => {
    for (const completed of ["2026-09-08T10:00:00Z", "2026-09-08T10:00:00.000Z", "2026-09-08 10:00:00Z", "2026-02-31T10:00:00Z", "2026-09-08T10:00:00+00:00"]) {
      const f = createFixture(); try {
        put(path.join(f.p.status, runtimeSha256 + ".status"), `status=complete\nok=1\nexitCode=0\nbundleSha256=${runtimeSha256}\nfinishedAt=${completed}\n`, 0o600);
        if (["2026-09-08T10:00:00Z", "2026-09-08T10:00:00.000Z"].includes(completed)) { f.initialize(); f.accepted(runtimeSha256); }
        else assert.throws(f.initialize, /acceptance-not-proven/);
      } finally { f.dispose(); }
    }
  });
  check("full initialization and normal UI accept retain runtime identity and atomically publish bound proof", () => {
    const f = createFixture(); try {
      f.prepared(); f.accepted(runtimeSha256); const begin = f.adapter.begin(f.plan());
      assert.equal(begin.action, "pending-acceptance"); assert.equal(f.state().acceptanceSha256, null); assert.equal(fs.existsSync(f.p.current), true);
      const applied = f.accept(begin.transactionId); assert.equal(applied.action, "accepted"); f.accepted(frontendSha256);
      const indexRenames = f.module.events.filter(event => event.kind === "rename" && event.to === path.join(f.p.dist, "index.html"));
      assert.equal(indexRenames.length, 1); assert.equal(fs.statSync(path.dirname(indexRenames[0].from)).dev, fs.statSync(f.p.dist).dev);
      assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "assets/old-aaaaaaaa.js")), f.oldAsset.bytes);
      assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "assets/new-bbbbbbbb.js")), f.newAsset.bytes);
      assert.ok(f.module.events.some(event => event.kind === "fsync" && event.path === f.p.dist));
      assert.equal(f.adapter.recover().action, "noop");
    } finally { f.dispose(); }
  });
  for (const stopAt of ["prepared", "root-state-written", "projection-written", "asset-linked", "asset-installed", "assets-installed", "index-switch-intent", "index-renamed", "index-switched"]) {
    check(`disk recovery without acceptance rolls back after ${stopAt}`, () => {
      const f = createFixture(); try {
        f.prepared(); f.arm(stopAt); assert.throws(() => f.adapter.begin(f.plan()), /fixture-interruption/);
        const result = f.adapter.recover(); assert.equal(result.action, "rolled-back"); assert.equal(result.newFrontendAccepted, false); f.accepted(runtimeSha256);
        assert.equal(JSON.parse(fs.readFileSync(f.p.acceptanceProjection)).newFrontendAccepted, false);
        if (["asset-linked", "asset-installed", "assets-installed", "index-switch-intent", "index-renamed", "index-switched"].includes(stopAt)) assert.equal(fs.existsSync(path.join(f.p.dist, "assets/new-bbbbbbbb.js")), true);
      } finally { f.dispose(); }
    });
  }
  for (const stopAt of ["acceptance-written", "accept-intent-written", "accept-intent", "acceptance-projection-written", "root-state-written", "projection-written", "accepted"]) {
    check(`cold decision uses durable accept intent at ${stopAt}`, () => {
      const f = createFixture(); try {
        f.prepared(); const begun = f.adapter.begin(f.plan()); f.arm(stopAt); assert.throws(() => f.accept(begun.transactionId), /fixture-interruption/);
        const recovered = f.adapter.recover(), forward = stopAt !== "acceptance-written";
        assert.equal(recovered.action, forward ? "accepted" : "rolled-back"); f.accepted(forward ? frontendSha256 : runtimeSha256);
      } finally { f.dispose(); }
    });
  }
  for (const stopAt of ["rollback-intent-written", "rollback-index-renamed", "acceptance-projection-written", "root-state-written", "projection-written", "rolled-back"]) {
    check(`rollback resumes after interruption at ${stopAt}`, () => {
      const f = createFixture(); try {
        f.prepared(); f.adapter.begin(f.plan()); f.arm(stopAt); assert.throws(() => f.adapter.recover(), /fixture-interruption/);
        assert.equal(f.adapter.recover().action, "rolled-back"); f.accepted(runtimeSha256);
      } finally { f.dispose(); }
    });
  }
  for (const stopAt of ["prepared", "full-accept-intent-written", "acceptance-projection-written", "root-state-written", "projection-written"]) {
    check(`full initialization resumes after ${stopAt} without touching index`, () => {
      const f = createFixture(); try {
        f.arm(stopAt); assert.throws(f.initialize, /fixture-interruption/); assert.equal(f.adapter.recover().action, "full-initialized"); f.accepted(runtimeSha256);
        assert.equal(f.module.events.filter(event => event.kind === "rename" && event.to === path.join(f.p.dist, "index.html")).length, 0);
      } finally { f.dispose(); }
    });
  }
  check("receipt hash, identity, fresh timestamp and every required check are enforced", () => {
    const f = createFixture(); try {
      f.prepared(); const start = f.adapter.begin(f.plan());
      for (const change of [r => { r.transactionId = "d".repeat(24); }, r => { r.indexSha256 = "d".repeat(64); }, r => { r.checks.health = false; }, r => { r.checks.extra = true; }, r => { r.checkedAt = "2000-01-01T00:00:00.000Z"; }, r => { r.extra = true; }]) {
        const value = JSON.parse(f.uiReceipt(start.transactionId)); change(value); const raw = bytes(value);
        assert.throws(() => f.adapter.accept({ transactionId: start.transactionId, acceptanceReceiptBytes: raw, acceptanceSha256: digest(raw) }), /receipt/);
      }
      const raw = f.uiReceipt(start.transactionId); assert.throws(() => f.adapter.accept({ transactionId: start.transactionId, acceptanceReceiptBytes: raw, acceptanceSha256: "e".repeat(64) }), /receipt-hash/);
      assert.equal(fs.existsSync(path.join(f.p.current, "accept-intent.json")), false); f.adapter.recover(); f.accepted(runtimeSha256);
    } finally { f.dispose(); }
  });
  for (const identical of [false, true]) check(`cold rollback refuses an external ${identical ? "same-content new inode" : "different index"}`, () => {
    const f = createFixture(); try {
      f.prepared(); f.adapter.begin(f.plan()); const other = path.join(f.adapter.rootDir, "external-index"); put(other, identical ? f.candidate.bytes : "external UI");
      fs.renameSync(other, path.join(f.p.dist, "index.html")); assert.throws(() => f.adapter.recover(), /external-index/);
      assert.equal(fs.existsSync(f.p.current), true); assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "index.html")), identical ? f.candidate.bytes : Buffer.from("external UI"));
    } finally { f.dispose(); }
  });
  check("unknown recovery/staging members and external metadata block recovery", () => {
    const f = createFixture(); try {
      f.prepared(); const start = f.adapter.begin(f.plan()); put(path.join(f.p.current, "unknown"), "unsafe");
      assert.throws(() => f.adapter.recover(), /unknown-frontend-recovery-member/); fs.unlinkSync(path.join(f.p.current, "unknown"));
      const stage = path.join(f.p.stageRoot, start.transactionId); put(path.join(stage, "unknown"), "unsafe"); assert.throws(() => f.adapter.recover(), /unknown-frontend-stage-member/); fs.unlinkSync(path.join(stage, "unknown"));
      const old = fs.readFileSync(f.p.acceptanceProjection); put(f.p.acceptanceProjection, "{}"); assert.throws(() => f.adapter.recover(), /external-public-acceptance-change/); put(f.p.acceptanceProjection, old);
      f.adapter.recover(); f.accepted(runtimeSha256);
    } finally { f.dispose(); }
  });
  check("unsafe immutable paths, collisions, stale state, sparse oversized output and undeclared data fail closed", () => {
    const f = createFixture(); try {
      f.prepared();
      for (const target of ["robots.txt", "../outside.js", "assets/a.js", "assets/.hidden-bbbbbbbb.js", "assets/nested/a-bbbbbbbb.js"]) {
        const plan = f.plan(); plan.newAssets[0].path = target; assert.throws(() => f.adapter.begin(plan), /asset-path/);
      }
      const collision = f.plan(); collision.newAssets[0].path = "assets/old-aaaaaaaa.js"; assert.throws(() => f.adapter.begin(collision), /collision/);
      const stale = f.plan(); stale.expectedStateSha256 = "d".repeat(64); assert.throws(() => f.adapter.begin(stale), /baseline-binding/);
      const huge = path.join(f.p.dist, "huge.bin"), fd = fs.openSync(huge, "wx"); fs.ftruncateSync(fd, 129 * 1024 * 1024); fs.closeSync(fd);
      assert.throws(() => f.adapter.begin(stale), /limit|large|size/); fs.unlinkSync(huge);
      assert.equal(fs.existsSync(f.p.current), false); f.accepted(runtimeSha256);
    } finally { f.dispose(); }
  });
  check("known interrupted atomic metadata files are recovered, unknown bytes are not overwritten", () => {
    const f = createFixture(); try {
      f.prepared(); f.adapter.begin(f.plan()); put(f.p.state + ".frontend-next", fs.readFileSync(f.p.state), 0o600);
      put(path.join(f.p.current, "phase.json.frontend-next"), bytes({ version: f.module.VERSION, phase: "index-switched" }), 0o600);
      f.adapter.recover(); f.accepted(runtimeSha256); assert.equal(fs.existsSync(f.p.state + ".frontend-next"), false);
    } finally { f.dispose(); }
  });
  check("unknown interrupted state bytes and linked public proof are retained for manual recovery", () => {
    const f = createFixture(); try {
      f.prepared(); f.adapter.begin(f.plan()); put(f.p.state + ".frontend-next", "unknown state", 0o600);
      assert.throws(() => f.adapter.recover(), /unknown-interrupted-state-write/); assert.equal(fs.readFileSync(f.p.state + ".frontend-next", "utf8"), "unknown state");
      fs.unlinkSync(f.p.state + ".frontend-next"); const alias = path.join(f.adapter.rootDir, "public-proof-alias"); fs.linkSync(f.p.acceptanceProjection, alias);
      assert.throws(() => f.adapter.recover(), /unsafe-or-oversized/); assert.equal(fs.existsSync(f.p.current), true); fs.unlinkSync(alias);
      f.adapter.recover(); f.accepted(runtimeSha256);
    } finally { f.dispose(); }
  });
  check("actual SIGKILL after index rename recovers from only persisted records in a fresh process", () => {
    const f = createFixture(); try {
      f.prepared(); const child = spawnSync(process.execPath, [__filename, "--fixture-child", f.adapter.rootDir, "begin", "index-renamed"], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.signal, "SIGKILL", child.stderr); assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "index.html")), f.candidate.bytes);
      const recovery = spawnSync(process.execPath, [__filename, "--fixture-child", f.adapter.rootDir, "recover", "never"], { encoding: "utf8", timeout: 10000 });
      assert.equal(recovery.status, 0, recovery.stderr); f.accepted(runtimeSha256);
    } finally { f.dispose(); }
  });
  check("actual SIGKILL after durable acceptance rolls forward in a fresh process", () => {
    const f = createFixture(); try {
      f.prepared(); f.adapter.begin(f.plan());
      const child = spawnSync(process.execPath, [__filename, "--fixture-child", f.adapter.rootDir, "accept", "accept-intent-written"], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.signal, "SIGKILL", child.stderr);
      const recovery = spawnSync(process.execPath, [__filename, "--fixture-child", f.adapter.rootDir, "recover", "never"], { encoding: "utf8", timeout: 10000 });
      assert.equal(recovery.status, 0, recovery.stderr); f.accepted(frontendSha256);
    } finally { f.dispose(); }
  });
  check("actual inherited kernel flock has matching fdinfo and global lock rows even though holder differs from Node", () => {
    const f = createFixture(); try {
      const script = "const fs=require('fs');const s=fs.fstatSync(9,{bigint:true});console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino),fdinfo:fs.readFileSync('/proc/self/fdinfo/9','utf8'),locks:fs.readFileSync('/proc/locks','utf8')}));";
      const child = spawnSync("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock -n 9; exec "$2" -e "$3"', "fixture", f.p.lock, process.execPath, script], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, 0, child.stderr); const observation = JSON.parse(child.stdout), own = f.module.testOnly.parseLockRows(observation.fdinfo), global = f.module.testOnly.parseLockRows(observation.locks);
      const dev = BigInt(observation.dev), major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
      assert.equal(own.length, 1); assert.equal(own[0].major, major); assert.equal(own[0].minor, minor); assert.equal(own[0].ino, BigInt(observation.ino));
      assert.ok(global.some(row => row.major === major && row.minor === minor && row.ino === own[0].ino && row.holder === own[0].holder));
      assert.equal(f.module.testOnly.parseLockRows(observation.fdinfo.replace("WRITE", "READ")).length, 0);
      const unrelated = spawnSync("/bin/bash", ["-c", 'exec 8>"$1"; /usr/bin/flock -n 8; exec 9>"$1"; exec "$2" -e "$3"', "fixture", f.p.lock, process.execPath, script], { encoding: "utf8", timeout: 10000 });
      assert.equal(unrelated.status, 0, unrelated.stderr); const other = JSON.parse(unrelated.stdout);
      assert.equal(f.module.testOnly.parseLockRows(other.fdinfo).length, 0, "same inode held via another open description does not prove fd9 owns it");
      assert.ok(f.module.testOnly.parseLockRows(other.locks).some(row => row.ino === BigInt(other.ino)));
    } finally { f.dispose(); }
  });
  return { ok: true, version: "frontend-release-transaction-verification-v1", node: process.version, checks,
    successiveUiRecovery: verifySuccessiveUiRecovery(),
    actualAtomicRename: true, actualSigkillColdRecovery: true, actualInheritedKernelFlock: true,
    productionWrites: 0, providerRequests: 0, scope: "Private Linux fixture core, fault recovery and real kernel lock observation; not production authorization or deployment." };
}
function verifyStateSchemaDelta() {
  const f = createFixture(); try {
    f.prepared(); const plan = f.plan(); plan.frontendSha256 = runtimeSha256;
    assert.throws(() => f.adapter.begin(plan), /invalid-frontend-release-state/);
    assert.equal(fs.existsSync(f.p.current), false); f.accepted(runtimeSha256);
    return { ok: true, deltaOnly: true, checks: [{ name: "frontend-only state rejects equal runtime and frontend SHA", ok: true }], productionWrites: 0, providerRequests: 0 };
  } finally { f.dispose(); }
}
function verifySuccessiveUiRecovery() {
  if (process.platform !== "linux") throw new Error("successive UI recovery requires real Linux files and SIGKILL");
  const consumer = require("../server/frontendReleaseIdentity.cjs"), checks = [];
  const check = (name, work) => { work(); checks.push({ name, ok: true }); };
  const nextSha = "d".repeat(64), nextIndex = artifact("<main>next UI</main>");
  const start = f => { f.prepared(); f.accept(f.adapter.begin(f.plan()).transactionId); f.accepted(frontendSha256); };
  const nextPlan = (f, sequence = 12) => ({ ...f.plan(), candidateIndex: nextIndex,
    newAssets: [{ path: "assets/next-dddddddd.js", ...artifact("next immutable module") }],
    frontendSha256: nextSha, frontendSequence: sequence, authorizationSha256: "e".repeat(64) });
  const cold = (f, action, failAt = "never") => spawnSync(process.execPath,
    [__filename, "--fixture-child", f.adapter.rootDir, action, failAt], { encoding: "utf8", timeout: 10000 });
  const recover = f => { const r = cold(f, "recover"); assert.equal(r.status, 0, r.stderr); };
  const publicIdentity = f => {
    // Feed the actual durable transaction bytes through the unmodified public
    // reader in its own private filesystem fixture; no fabricated receipt.
    const reader = consumer.createFrontendReleaseIdentityFixture();
    try {
      for (const [to, from] of [[reader.paths.projection, f.p.projection], [reader.paths.acceptance, f.p.acceptanceProjection],
        [reader.paths.index, path.join(f.p.dist, "index.html")], [reader.paths.runtimeMarker, path.join(f.p.app, ".release-bundle-sha256")],
        [reader.paths.acceptedRuntimeMarker, path.join(f.p.app, ".release-live-complete")]]) put(to, fs.readFileSync(from));
      const result = reader.read(); assert.equal(result.available, true); assert.equal(result.consistent, true);
      assert.equal(result.runtimeSha256, runtimeSha256); assert.equal(result.runtimeSequence, 10);
      return result;
    } finally { reader.dispose(); }
  };
  const matches = (identity, sha, sequence) => consumer.frontendIdentityMatchesCandidate(identity,
    { releaseKind: "frontend-only", sha256: sha, releaseSequence: sequence });
  const retained = f => {
    assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "assets/old-aaaaaaaa.js")), f.oldAsset.bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "assets/new-bbbbbbbb.js")), f.newAsset.bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "assets/next-dddddddd.js")), Buffer.from("next immutable module"));
  };
  check("second UI SIGKILL rollback restores accepted UI, not the older full baseline", () => {
    const f = createFixture(); try {
      start(f); const previous = f.state(); put(f.p.sequence, "12\n", 0o600);
      const killed = cold(f, "begin-next-ui", "index-renamed"); assert.equal(killed.signal, "SIGKILL", killed.stderr);
      assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "index.html")), nextIndex.bytes);
      recover(f); f.accepted(frontendSha256); retained(f);
      assert.equal(f.state().kind, "frontend-only"); assert.equal(f.state().frontendSequence, 11);
      assert.deepEqual(fs.readFileSync(path.join(f.p.dist, "index.html")), f.candidate.bytes);
      const receipt = JSON.parse(fs.readFileSync(f.p.acceptanceProjection));
      assert.equal(receipt.version, "frontend-rollback-acceptance-v1"); assert.deepEqual(receipt.previousState, previous);
      assert.equal(receipt.newFrontendAccepted, false); assert.equal(receipt.retainedAssetCount, 1);
      assert.notEqual(f.state().distTreeHash, previous.distTreeHash);
      assert.equal(fs.readFileSync(f.p.sequence, "utf8"), "12\n", "recovery must not rewind the consumed sequence");
      const identity = publicIdentity(f); assert.equal(matches(identity, frontendSha256, 11), true);
      assert.equal(matches(identity, nextSha, 12), false);
      // A later independently authorized sequence may reuse retained immutable
      // assets. This is not replaying the consumed request through the wrapper.
      put(f.p.sequence, "13\n", 0o600); f.adapter.begin(nextPlan(f, 13));
      const accepted = cold(f, "accept"); assert.equal(accepted.status, 0, accepted.stderr);
      f.accepted(nextSha); retained(f); assert.equal(matches(publicIdentity(f), nextSha, 13), true);
      assert.equal(f.adapter.recover().action, "noop");
    } finally { f.dispose(); }
  });
  check("second UI durable accept intent rolls forward after real SIGKILL", () => {
    const f = createFixture(); try {
      start(f); put(f.p.sequence, "12\n", 0o600); f.adapter.begin(nextPlan(f));
      const killed = cold(f, "accept", "accept-intent-written"); assert.equal(killed.signal, "SIGKILL", killed.stderr);
      recover(f); f.accepted(nextSha); retained(f);
      const identity = publicIdentity(f); assert.equal(matches(identity, nextSha, 12), true);
      assert.equal(matches(identity, frontendSha256, 11), false);
      assert.equal(JSON.parse(fs.readFileSync(f.p.acceptanceProjection)).version, "frontend-readonly-acceptance-v1");
    } finally { f.dispose(); }
  });
  check("interrupted rollback of a second UI resumes from every durable rollback phase", () => {
    for (const phase of ["rollback-intent-written", "rollback-index-renamed", "acceptance-projection-written", "root-state-written", "projection-written", "rolled-back"]) {
      const f = createFixture(); try {
        start(f); put(f.p.sequence, "12\n", 0o600); f.adapter.begin(nextPlan(f)); f.arm(phase);
        assert.throws(() => f.adapter.recover(), /fixture-interruption/);
        recover(f); f.accepted(frontendSha256); retained(f);
        assert.equal(matches(publicIdentity(f), nextSha, 12), false);
      } finally { f.dispose(); }
    }
  });
  return { ok: true, version: "successive-ui-cold-recovery-v1", checks, rollbackInterruptionPhases: 6,
    actualSigkillCases: 2, actualPublicReader: true, productionWrites: 0, providerRequests: 0,
    scope: "Linux isolated consecutive UI transactions and public receipt consumption; not a production rollback or full-release timing" };
}
if (require.main === module) {
  try {
    if (process.argv[2] === "--fixture-child") crashChild(process.argv.slice(3));
    else if (process.argv[2] === "--state-schema-delta") console.log(JSON.stringify(verifyStateSchemaDelta()));
    else if (process.argv[2] === "--successive-ui-recovery") console.log(JSON.stringify(verifySuccessiveUiRecovery()));
    else console.log(JSON.stringify(verify()));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { verify, verifyStateSchemaDelta, verifySuccessiveUiRecovery };
