"use strict";
// Real private filesystem, RSA signatures and byte commitments. This fixture
// never grants production authority or executes a build/deployment.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), assert = require("node:assert/strict"), { spawnSync } = require("node:child_process");
const attempt = require("./frontendReleaseAttempt.cjs"), signing = require("./releaseSigning.cjs"), authorization = require("./frontendReleaseAuthorization.cjs"), archive = require("./releaseArchiveSourceInventory.cjs"), dist = require("./releasePrebuiltDist.cjs"), identity = require("../server/frontendReleaseIdentity.cjs");
const APP = "/opt/football-predict", RELEASE = "/var/lib/football-release", sha = b => crypto.createHash("sha256").update(b).digest("hex"), json = v => Buffer.from(JSON.stringify(v) + "\n");
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
const fixturePolicies = () => ({ authorizationSha256: sha("policy"), runtimeBoundarySha256: sha("boundary"), sandboxSha256: sha("sandbox") });
function tar(files) {
  const names = new Set(Object.keys(files)); for (const name of [...names]) for (let p = path.posix.dirname(name); p !== "."; p = path.posix.dirname(p)) names.add(p);
  const chunks = [];
  for (const name of [...names].sort()) {
    const file = Object.hasOwn(files, name), bytes = file ? Buffer.from(files[name]) : Buffer.alloc(0), h = Buffer.alloc(512);
    const field = (at, n, v) => h.write(v.toString(8).padStart(n - 1, "0") + "\0", at, n, "ascii");
    h.write(name); field(100, 8, file ? 0o644 : 0o755); field(108, 8, 0); field(116, 8, 0); field(124, 12, bytes.length); field(136, 12, 0); h.fill(32, 148, 156); h[156] = file ? 48 : 53; h.write("ustar\0", 257); h.write("00", 263); field(148, 8, h.reduce((a, b) => a + b, 0));
    chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function fixture() {
  const policies = fixturePolicies(), modules = { signing, authorization, identity, dist, policies };
  const f = attempt.createFrontendReleaseAttemptFixture({ modules });
  const put = (logical, bytes, mode = 0o600) => { const p = f.at(logical); fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, bytes); fs.chmodSync(p, mode); };
  const get = logical => fs.readFileSync(f.at(logical));
  const bundle = tar({ "package.json": "{}\n", "package-lock.json": "{\"lockfileVersion\":3}\n", "src/App.css": "body{color:red}\n" }), sha256 = sha(bundle), workDir = RELEASE + "/work/" + sha256 + ".Fixture";
  put(workDir + "/" + sha256 + ".tgz", bundle); put(workDir + "/" + sha256 + ".sha256", sha256 + "  " + sha256 + ".tgz\n");
  const evidence = await archive.captureReleaseArchiveSourceEvidence(f.at(workDir + "/" + sha256 + ".tgz"));
  put(APP + "/dist/index.html", "<html>accepted existing UI</html>\n", 0o644); const oldDist = dist.inspectPrebuiltDist(f.at(APP + "/dist"));
  const receipt = { version: "frontend-readonly-acceptance-v1", transactionId: "a".repeat(24), runtimeSha256: sha("original runtime"), runtimeSequence: 9, frontendSha256: sha("accepted other frontend"), frontendSequence: 11,
    indexSha256: sha(get(APP + "/dist/index.html")), distTreeHash: oldDist.treeHash, authorizationSha256: sha("old accepted authorization"), checkedAt: "2026-01-01T00:00:00.000Z", checks: { index: true, assets: true, health: true, protected: true, services: true } };
  const state = { version: identity.VERSION, kind: "frontend-only", phase: "accepted", runtimeSha256: receipt.runtimeSha256, runtimeSequence: 9, frontendSha256: receipt.frontendSha256, frontendSequence: 11, indexSha256: receipt.indexSha256, distTreeHash: oldDist.treeHash, acceptanceSha256: sha(json(receipt)) };
  put(RELEASE + "/frontend-state.json", json(state)); put(APP + "/.frontend-release-state.json", json(state), 0o644); put(APP + "/.frontend-release-acceptance.json", json(receipt), 0o644);
  for (const n of [".release-bundle-sha256", ".release-live-complete"]) put(APP + "/" + n, state.runtimeSha256 + "\n", 0o644);
  const runtime = { nodeSha256: sha("node"), nodeVersion: "v22.22.1", dependencyLockSha256: sha("lock"), buildDependencySha256: sha("dependency tree"), installedRuntimeSha256: sha("installed actual runtime") };
  const binding = { version: "frontend-runtime-binding-v1", runtimeSha256: state.runtimeSha256, runtimeSequence: 9, inventorySha256: evidence.inventorySha256, runtime, policies };
  put(RELEASE + "/frontend-runtime-binding.json", json(binding)); put(APP + "/.frontend-release-binding.json", json(binding), 0o644);
  put(RELEASE + "/highest-accepted-sequence", "12\n"); put("/etc/football-release/signing-public.pem", key.publicKey.export({ type: "spki", format: "pem" }), 0o644);
  put("/etc/football-release/upload-owner", "fixture\n", 0o644); put("/etc/football-release/expected-site", "football-predict\n", 0o644); put("/etc/football-release/expected-channel", "production\n", 0o644);
  const oldStatus = Buffer.from("status=failed\nok=0\nstartedAt=2026-01-01T00:00:00Z\nfinishedAt=2026-01-01T00:01:00Z\nexitCode=137\nbundleSha256=" + sha256 + "\nreleaseKind=frontend-only\nreleaseSequence=12\n"), oldLog = Buffer.from("original failed attempt log\n");
  put(RELEASE + "/status/" + sha256 + ".status", oldStatus, 0o640); put(RELEASE + "/logs/" + sha256 + ".log", oldLog, 0o640);
  const legacyRoot = RELEASE + "/frontend-authorizations/" + sha256; put(legacyRoot + "/original.tgz", bundle); put(legacyRoot + "/request.json", json({ version: "legacy", sequence: 12 }));
  const manifest = { manifestVersion: 3, ok: true, policyVersion: "release-secret-policy-v2", sha256, bytes: bundle.length, entries: evidence.archiveEntryCount, site: "football-predict", channel: "production", releaseSequence: 13,
    createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), signature: { algorithm: signing.RELEASE_SIGNATURE_ALGORITHM, keyId: signing.publicKeyId(key.publicKey) },
    blockedEntries: [], sensitiveEntries: [], missingEntries: [], archiveSourceEvidence: evidence, releaseKind: "frontend-only", releaseActions: [], frontendAuthorization: { version: authorization.VERSION,
      baseline: { runtimeSha256: state.runtimeSha256, runtimeSequence: 9, inventorySha256: evidence.inventorySha256, frontendStateSha256: sha(json(state)), indexSha256: state.indexSha256, distTreeHash: state.distTreeHash },
      candidateInventorySha256: evidence.inventorySha256, runtime, policies, changedPaths: ["src/App.css"] } };
  const sign = () => { put(workDir + "/" + sha256 + ".manifest.json", json(manifest)); put(workDir + "/" + sha256 + ".manifest.sig", signing.signManifestBytes(json(manifest), key.privateKey)); };
  sign();
  const request = sequence => ({ sha256, sequence, workDir });
  const status = (sequence, phase, exitCode) => ({ sha256, sequence, phase, exitCode });
  const unchanged = () => { assert.deepEqual(get(RELEASE + "/status/" + sha256 + ".status"), oldStatus); assert.deepEqual(get(RELEASE + "/logs/" + sha256 + ".log"), oldLog); assert.deepEqual(get(RELEASE + "/frontend-state.json"), json(state)); assert.equal(sha(get(legacyRoot + "/original.tgz")), sha256); };
  return { ...f, modules, put, get, sha256, workDir, manifest, sign, request, statusInput: status, oldStatus, oldLog, state, binding, receipt, legacyRoot, unchanged, bundle, evidence };
}
function authorize(f, sequence = 13) {
  const root = RELEASE + "/frontend-authorizations/" + f.sha256 + "." + sequence, buildBytes = Buffer.from("fresh build receipt with distinct execution token " + sequence + "\n"), body = { version: "frontend-built-source-authorization-v1", requestSha256: f.sha256, sequence,
    manifestSha256: sha(f.get(f.workDir + "/" + f.sha256 + ".manifest.json")), stateSha256: sha(json(f.state)), buildEvidenceSha256: sha(buildBytes), runtime: f.manifest.frontendAuthorization.runtime, policies: f.manifest.frontendAuthorization.policies };
  f.put(root + "/authorization.json", json(body)); f.put(root + "/complete.json", json({ version: body.version, authorizationSha256: sha(json(body)) })); f.put(root + "/build-evidence.json", buildBytes); f.put(root + "/original.tgz", f.bundle);
  f.put(root + "/manifest.json", f.get(f.workDir + "/" + f.sha256 + ".manifest.json")); f.put(root + "/manifest.sig", f.get(f.workDir + "/" + f.sha256 + ".manifest.sig"));
  return sha(json(body));
}
function accepted(f) {
  f.put(APP + "/dist/index.html", "<html>new isolated build</html>\n", 0o644); const tree = dist.inspectPrebuiltDist(f.at(APP + "/dist")), authSha = authorize(f);
  const receipt = { ...f.receipt, transactionId: "b".repeat(24), frontendSha256: f.sha256, frontendSequence: 13, indexSha256: sha(f.get(APP + "/dist/index.html")), distTreeHash: tree.treeHash, authorizationSha256: authSha, checkedAt: new Date().toISOString() }, state = { ...f.state, frontendSha256: f.sha256, frontendSequence: 13, indexSha256: receipt.indexSha256, distTreeHash: tree.treeHash, acceptanceSha256: sha(json(receipt)) };
  f.put(RELEASE + "/frontend-state.json", json(state)); f.put(APP + "/.frontend-release-state.json", json(state), 0o644); f.put(APP + "/.frontend-release-acceptance.json", json(receipt), 0o644);
  return state;
}
function ticket(f) {
  const s = fs.statSync(f.root), file = path.join(f.root, "cold-ticket.json");
  fs.writeFileSync(file, json({ root: f.root, rootIdentity: { dev: String(s.dev), ino: String(s.ino) }, sha256: f.sha256, sequence: 13 }), { flag: "wx", mode: 0o600 }); return file;
}
function cold(file, action = "recover", stopAt = "") {
  return spawnSync(process.execPath, [__filename, "--fixture-child", file, action, stopAt], { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
}
async function verifyFrontendReleaseAttempt() {
  const checks = [], startedAt = Date.now(); const check = async (name, body) => { await body(); checks.push({ name, ok: true }); };
  const withFixture = async body => { const f = await fixture(); try { await body(f); } finally { f.dispose(); } };
  const rejected = (name, mutation, pattern) => check(name, () => withFixture(f => { mutation(f); const status = f.get(RELEASE + "/status/" + f.sha256 + ".status"), log = f.get(RELEASE + "/logs/" + f.sha256 + ".log"); assert.throws(() => f.prepare(f.request(f.manifest.releaseSequence)), pattern); assert.deepEqual(f.get(RELEASE + "/status/" + f.sha256 + ".status"), status); assert.deepEqual(f.get(RELEASE + "/logs/" + f.sha256 + ".log"), log); assert.equal(fs.readdirSync(f.at(attempt.ROOT)).length, 0); }));
  await check("real fresh RSA preparation preserves original failed projection and legacy original", () => withFixture(f => {
    const p = f.prepare(f.request(13)); assert.equal(p.deploymentAuthorized, false); f.unchanged();
    assert.deepEqual(f.get(p.directory + "/previous.status"), f.oldStatus); assert.deepEqual(f.get(p.directory + "/previous.log"), f.oldLog); assert.equal(sha(f.get(p.directory + "/original.tgz")), f.sha256);
    assert.throws(() => f.prepare(f.request(13)), /EEXIST/); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); assert.equal(f.verify(f.request(13)).sequence, 13);
    f.status(f.statusInput(13, "running", null)); assert.match(f.get(RELEASE + "/status/" + f.sha256 + ".status").toString(), /^status=running/m); assert.deepEqual(f.get(RELEASE + "/logs/" + f.sha256 + ".log"), f.oldLog);
    fs.appendFileSync(f.at(p.directory + "/output.log"), "new build failed with its own output\n"); f.status(f.statusInput(13, "failed", 137));
    const sealed = f.get(p.directory + "/complete.json"); f.status(f.statusInput(13, "failed", 137)); assert.deepEqual(f.get(p.directory + "/complete.json"), sealed);
    assert.throws(() => f.verify(f.request(13)), /current-state|does-not-match/); assert.throws(() => f.status(f.statusInput(13, "running", null)), /already-started/);
    f.manifest.releaseSequence = 14; f.sign(); const next = f.prepare(f.request(14)); assert.deepEqual(f.get(next.directory + "/previous.status"), f.get(p.directory + "/final.status")); assert.deepEqual(f.get(next.directory + "/previous.log"), f.get(p.directory + "/output.log"));
    assert.deepEqual(f.get(p.directory + "/previous.status"), f.oldStatus); assert.deepEqual(f.get(p.directory + "/previous.log"), f.oldLog); assert.equal(sha(f.get(f.legacyRoot + "/original.tgz")), f.sha256);
  }));
  await rejected("unsigned source cannot replace old status or truncate old log", f => f.put(f.workDir + "/" + f.sha256 + ".manifest.sig", "unsigned"), /signature/);
  await rejected("valid RSA with consumed/replayed sequence cannot claim an attempt", f => { f.manifest.releaseSequence = 12; f.sign(); }, /fresh-sequence/);
  await rejected("expired fresh-attempt manifest cannot claim or overwrite evidence", f => { f.manifest.createdAt = new Date(Date.now() - 7200000).toISOString(); f.manifest.expiresAt = new Date(Date.now() - 3600000).toISOString(); f.sign(); }, /expired/);
  await rejected("wrong source SHA is rejected before evidence mutation", f => f.put(f.workDir + "/" + f.sha256 + ".tgz", "changed source"), /identity/);
  await rejected("state projection drift is not a private acceptance substitute", f => f.put(APP + "/.frontend-release-state.json", json({ ...f.state, frontendSequence: 10 }), 0o644), /current-state/);
  await rejected("signed current state hash mismatch cannot start", f => { f.manifest.frontendAuthorization.baseline.frontendStateSha256 = sha("wrong"); f.sign(); }, /binding/);
  await rejected("public runtime binding drift cannot start", f => f.put(APP + "/.frontend-release-binding.json", json({ ...f.binding, inventorySha256: sha("wrong") }), 0o644), /binding/);
  await rejected("policy change needs a new signed manifest", f => { f.modules.policies = { ...f.modules.policies, sandboxSha256: sha("new policy") }; }, /binding/);
  await rejected("receipt alteration cannot authorize preparation", f => f.put(APP + "/.frontend-release-acceptance.json", json({ ...f.receipt, authorizationSha256: sha("fake") }), 0o644), /receipt/);
  await rejected("recovery current blocks claim including empty actual directory", f => fs.mkdirSync(f.at(RELEASE + "/recovery/current")), /recovery/);
  await rejected("durable unfinished policy bootstrap blocks claim", f => f.put(RELEASE + "/frontend-policy-bootstrap/pending.json", "{}\n"), /recovery/);
  await rejected("success projection cannot be treated as a failed retry", f => f.put(RELEASE + "/status/" + f.sha256 + ".status", f.oldStatus.toString().replace("status=failed", "status=complete").replace("ok=0", "ok=1").replace("exitCode=137", "exitCode=0"), 0o640), /not-failed/);
  await check("typed claim cannot verify before consume and rejects changed signed invocation", () => withFixture(f => {
    f.prepare(f.request(13)); assert.throws(() => f.verify(f.request(13)), /fresh-sequence/); f.put(RELEASE + "/highest-accepted-sequence", "13\n");
    f.manifest.createdAt = new Date().toISOString(); f.sign(); assert.throws(() => f.verify(f.request(13)), /does-not-match/);
  }));
  await check("actual source and immutable prepared bytes are rechecked after consume", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.put(p.directory + "/previous.log", "changed retained failure"); assert.throws(() => f.verify(f.request(13)), /immutable/);
  }));
  await check("CAS refuses externally changed latest projection without overwriting it", () => withFixture(f => {
    f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); const external = Buffer.from("external root status\n"); f.put(RELEASE + "/status/" + f.sha256 + ".status", external, 0o640); assert.throws(() => f.status(f.statusInput(13, "running", null)), /cas-conflict/); assert.deepEqual(f.get(RELEASE + "/status/" + f.sha256 + ".status"), external);
  }));
  for (const phase of ["running", "failed"]) await check("CAS refuses deleted existing latest status before " + phase, () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n");
    if (phase === "failed") f.status(f.statusInput(13, "running", null));
    fs.unlinkSync(f.at(RELEASE + "/status/" + f.sha256 + ".status"));
    assert.throws(() => f.status(f.statusInput(13, phase, phase === "running" ? null : 23)), /cas-conflict/);
    assert.equal(fs.existsSync(f.at(RELEASE + "/status/" + f.sha256 + ".status")), false);
    assert.deepEqual(f.get(p.directory + "/previous.status"), f.oldStatus);
  }));
  await check("no original acceptance or build evidence can make new attempt complete", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null)); assert.throws(() => f.status(f.statusInput(13, "complete", 0)), /state-not-accepted/); assert.equal(fs.existsSync(f.at(p.directory + "/final.status")), false);
  }));
  await check("new sequence requires its own retained build authorization and accepted receipt", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.verify(f.request(13)); f.status(f.statusInput(13, "running", null));
    f.put(APP + "/dist/index.html", "<html>new isolated build</html>\n", 0o644); const tree = dist.inspectPrebuiltDist(f.at(APP + "/dist"));
    const authRoot = RELEASE + "/frontend-authorizations/" + f.sha256 + ".13", buildBytes = Buffer.from("fresh build receipt with distinct execution token\n"), auth = { version: "frontend-built-source-authorization-v1", requestSha256: f.sha256, sequence: 13,
      manifestSha256: sha(f.get(f.workDir + "/" + f.sha256 + ".manifest.json")), stateSha256: sha(json(f.state)), buildEvidenceSha256: sha(buildBytes), runtime: f.manifest.frontendAuthorization.runtime, policies: f.manifest.frontendAuthorization.policies };
    f.put(authRoot + "/authorization.json", json(auth)); f.put(authRoot + "/complete.json", json({ version: auth.version, authorizationSha256: sha(json(auth)) })); f.put(authRoot + "/build-evidence.json", buildBytes); f.put(authRoot + "/original.tgz", f.bundle);
    f.put(authRoot + "/manifest.json", f.get(f.workDir + "/" + f.sha256 + ".manifest.json")); f.put(authRoot + "/manifest.sig", f.get(f.workDir + "/" + f.sha256 + ".manifest.sig"));
    const receipt = { ...f.receipt, transactionId: "b".repeat(24), frontendSha256: f.sha256, frontendSequence: 13, indexSha256: sha(f.get(APP + "/dist/index.html")), distTreeHash: tree.treeHash, authorizationSha256: sha(json(auth)), checkedAt: new Date().toISOString() };
    const state = { ...f.state, frontendSha256: f.sha256, frontendSequence: 13, indexSha256: receipt.indexSha256, distTreeHash: tree.treeHash, acceptanceSha256: sha(json(receipt)) };
    f.put(RELEASE + "/frontend-state.json", json(state)); f.put(APP + "/.frontend-release-state.json", json(state), 0o644); f.put(APP + "/.frontend-release-acceptance.json", json(receipt), 0o644);
    fs.appendFileSync(f.at(p.directory + "/output.log"), "this invocation completed\n"); assert.equal(f.status(f.statusInput(13, "complete", 0)).sealed, true);
    assert.deepEqual(f.get(p.directory + "/previous.status"), f.oldStatus); assert.deepEqual(f.get(p.directory + "/previous.log"), f.oldLog);
    fs.appendFileSync(f.at(p.directory + "/output.log"), "late unexpected append\n"); assert.throws(() => f.status(f.statusInput(13, "complete", 0)), /sealed-attempt/);
  }));
  await check("cold interrupted attempt is classified without modifying accepted old UI", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null));
    const file = ticket(f); fs.appendFileSync(f.at(p.directory + "/output.log"), "root writer was interrupted\n"); const r = cold(file); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).action, "interrupted-attempts-sealed");
    assert.match(f.get(p.directory + "/final.status").toString(), /^exitCode=125$/m); assert.deepEqual(f.get(RELEASE + "/frontend-state.json"), json(f.state)); assert.deepEqual(f.get(APP + "/.frontend-release-acceptance.json"), json(f.receipt));
    assert.deepEqual(f.get(p.directory + "/previous.status"), f.oldStatus); assert.deepEqual(f.get(p.directory + "/previous.log"), f.oldLog);
  }));
  await check("unsealed started attempt blocks every fresh prepare until cold recovery", () => withFixture(f => {
    f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null)); f.manifest.releaseSequence = 14; f.sign(); assert.throws(() => f.prepare(f.request(14)), /recovery-required/);
  }));
  await check("cold recovery refuses unknown state changes and retains the unresolved attempt", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null));
    const receipt = { ...f.receipt, authorizationSha256: sha("other unrelated acceptance") }, state = { ...f.state, acceptanceSha256: sha(json(receipt)) };
    f.put(RELEASE + "/frontend-state.json", json(state)); f.put(APP + "/.frontend-release-state.json", json(state), 0o644); f.put(APP + "/.frontend-release-acceptance.json", json(receipt), 0o644);
    assert.throws(() => f.recover(), /accepted-state-changed/); assert.equal(fs.existsSync(f.at(p.directory + "/final.status")), false);
  }));
  await check("cold recovery can seal an accepted new invocation with its original acceptance bytes", () => withFixture(f => {
    const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null)); const state = accepted(f), receipt = f.get(APP + "/.frontend-release-acceptance.json");
    const r = cold(ticket(f)); assert.equal(r.status, 0, r.stderr); assert.match(f.get(p.directory + "/final.status").toString(), /^status=complete$/m); assert.deepEqual(f.get(RELEASE + "/frontend-state.json"), json(state)); assert.deepEqual(f.get(APP + "/.frontend-release-acceptance.json"), receipt);
  }));
  await check("production API rejects private fixture projection and path options", () => {
    assert.throws(() => attempt.prepareFrontendReleaseAttempt({ sha256: "a".repeat(64), sequence: 13, workDir: "/tmp/private", fixtureRoot: "/tmp/private" }), /fixed-attempt-module/);
  });
  if (process.platform !== "win32") {
    for (const phase of ["attempt-running-status-written", "attempt-status-published"]) await check("real SIGKILL and independent cold recovery after " + phase, () => withFixture(f => {
      const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); const file = ticket(f), killed = cold(file, "running", phase);
      assert.equal(killed.signal, "SIGKILL", killed.stderr); const r = cold(file); assert.equal(r.status, 0, r.stderr); assert.match(f.get(p.directory + "/final.status").toString(), /^status=failed$/m); assert.deepEqual(f.get(RELEASE + "/frontend-state.json"), json(f.state));
    }));
    for (const phase of ["attempt-final-status-written", "attempt-status-published", "attempt-log-published", "attempt-sealed"]) await check("accepted cold continuation preserves bytes after SIGKILL at " + phase, () => withFixture(f => {
      const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null)); const state = accepted(f), receipt = f.get(APP + "/.frontend-release-acceptance.json"), file = ticket(f), killed = cold(file, "complete", phase);
      assert.equal(killed.signal, "SIGKILL", killed.stderr); const r = cold(file); assert.equal(r.status, 0, r.stderr); assert.match(f.get(p.directory + "/final.status").toString(), /^status=complete$/m); assert.deepEqual(f.get(RELEASE + "/frontend-state.json"), json(state)); assert.deepEqual(f.get(APP + "/.frontend-release-acceptance.json"), receipt);
    }));
    await check("actual transaction rollback with retained assets can seal the interrupted attempt", () => withFixture(f => {
      const p = f.prepare(f.request(13)); f.put(RELEASE + "/highest-accepted-sequence", "13\n"); f.status(f.statusInput(13, "running", null)); const authorizationSha256 = authorize(f), transaction = require("./frontendReleaseTransaction.cjs").createFrontendReleaseFixtureAdapter();
      try {
        const t = transaction.paths, put = (file, bytes, mode) => { fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); };
        put(t.state, json(f.state), 0o600); put(t.projection, json(f.state), 0o644); put(t.acceptanceProjection, json(f.receipt), 0o644); put(t.sequence, "13\n", 0o600); put(path.join(t.dist, "index.html"), f.get(APP + "/dist/index.html"), 0o644);
        for (const name of [".release-bundle-sha256", ".release-live-complete"]) put(path.join(t.app, name), f.state.runtimeSha256 + "\n", 0o644);
        const bytes = Buffer.from("new unaccepted index\n"), asset = Buffer.from("new retained asset\n");
        transaction.begin({ expectedStateSha256: sha(json(f.state)), expectedDistManifest: dist.inspectPrebuiltDist(t.dist), candidateIndex: { bytes, sha256: sha(bytes) }, newAssets: [{ path: "assets/retained-12345678.js", bytes: asset, sha256: sha(asset) }], runtimeSha256: f.state.runtimeSha256, runtimeSequence: 9, frontendSha256: f.sha256, frontendSequence: 13, authorizationSha256 });
        const restored = transaction.recover(); assert.equal(restored.action, "rolled-back");
        f.put(RELEASE + "/frontend-state.json", fs.readFileSync(t.state)); f.put(APP + "/.frontend-release-state.json", fs.readFileSync(t.projection), 0o644); f.put(APP + "/.frontend-release-acceptance.json", fs.readFileSync(t.acceptanceProjection), 0o644);
        const copy = (source, logical, mode) => { for (const e of fs.readdirSync(source, { withFileTypes: true })) { if (e.isDirectory()) copy(path.join(source, e.name), logical + "/" + e.name, mode); else f.put(logical + "/" + e.name, fs.readFileSync(path.join(source, e.name)), mode); } };
        copy(t.dist, APP + "/dist", 0o644); copy(restored.archive, RELEASE + "/recovery/" + path.basename(restored.archive), 0o600);
        const stateBytes = f.get(RELEASE + "/frontend-state.json"), receiptBytes = f.get(APP + "/.frontend-release-acceptance.json"), r = cold(ticket(f)); assert.equal(r.status, 0, r.stderr); assert.match(f.get(p.directory + "/final.status").toString(), /^status=failed$/m);
        assert.deepEqual(f.get(RELEASE + "/frontend-state.json"), stateBytes); assert.deepEqual(f.get(APP + "/.frontend-release-acceptance.json"), receiptBytes); assert.equal(f.get(APP + "/dist/assets/retained-12345678.js").toString(), asset.toString());
      } finally { transaction.dispose(); }
    }));
    await check("hard linked latest log is rejected before claim", () => withFixture(f => { fs.linkSync(f.at(RELEASE + "/logs/" + f.sha256 + ".log"), path.join(f.root, "alias")); assert.throws(() => f.prepare(f.request(13)), /unsafe-attempt-file/); }));
    await check("dangling bootstrap marker is fail closed", () => withFixture(f => { const p = f.at(RELEASE + "/frontend-policy-bootstrap/pending.json"); fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.symlinkSync("absent", p); assert.throws(() => f.prepare(f.request(13)), /recovery/); }));
  }
  return { ok: true, version: "frontend-release-attempt-fixture-v1", checks, startedAt, finishedAt: Date.now(), posixMetadataEnforced: process.platform !== "win32", directoryFsyncEnforced: process.platform !== "win32", productionWrites: 0, buildExecutions: 0, deploymentAuthorized: false,
    sourceHashes: ["frontendReleaseAttempt.cjs", "verifyFrontendReleaseAttempt.cjs"].map(name => ({ name, sha256: sha(fs.readFileSync(path.join(__dirname, name))) })) };
}
module.exports = { verifyFrontendReleaseAttempt };
if (require.main === module && process.argv[2] === "--fixture-child") {
  try {
    const t = JSON.parse(fs.readFileSync(process.argv[3])), f = attempt.createFrontendReleaseAttemptFixture({ modules: { signing, authorization, identity, dist, policies: fixturePolicies() }, existingRoot: t.root, rootIdentity: t.rootIdentity,
      onStep(phase) { if (phase === process.argv[5]) process.kill(process.pid, "SIGKILL"); } });
    const result = process.argv[4] === "recover" ? f.recover() : f.status({ sha256: t.sha256, sequence: t.sequence, phase: process.argv[4], exitCode: process.argv[4] === "running" ? null : 0 });
    console.log(JSON.stringify(result));
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
} else if (require.main === module) verifyFrontendReleaseAttempt().then(result => console.log(JSON.stringify(result))).catch(e => { console.error(e.stack); process.exitCode = 1; });
