"use strict";
// Private commands used only by the signed native release lane. Allocation
// and all expensive preparation affect an independent database. Cutover is
// separately guarded by the complete persisted v4 recovery transaction.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process"), { pipeline } = require("node:stream/promises");
const { NativeReleasePostgresPool } = require("./nativeReleasePostgresTransport.cjs");
const { NativeReleaseDatabaseSession } = require("./nativeReleaseDatabaseSession.cjs");
const { assertMirrorSourceCatalog } = require("./postgresReleaseMirror.cjs");
const { BOOTSTRAP_SHA, LEGACY_UNACCEPTED, runtimeTreeSha256, contractFor } = require("./nativeReleaseJournal.cjs");
const ROOT = "/var/lib/football-release/native", STORE = "/var/lib/football-predict";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function secureDirectory(directory) {
  for (let dir = directory;; dir = path.dirname(dir)) {
    const st = fs.lstatSync(dir); assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022));
    if (dir === path.dirname(dir)) break;
  }
}
function read(file) {
  secureDirectory(path.dirname(file)); const st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === 0 && !(st.mode & 0o077) && st.size <= 1024 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const opened = fs.fstatSync(fd); assert.equal(opened.ino, st.ino); return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}
function write(file, value) {
  secureDirectory(path.dirname(file)); const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function topology() {
  const r = spawnSync("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-X", "-q", "-t", "-A", "--set=ON_ERROR_STOP=1", "--dbname=postgres"], {
    input: "BEGIN READ ONLY; SELECT json_build_object('clusterId',(SELECT system_identifier::text FROM pg_control_system()),'databases',(SELECT json_object_agg(datname,oid::text) FROM pg_database)); ROLLBACK;",
    env: { PATH: "/usr/bin:/bin", PGHOST: "/var/run/postgresql", PGCONNECT_TIMEOUT: "5" }, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(r.status, 0, "local PostgreSQL identity probe failed"); return JSON.parse(r.stdout);
}
function pool(state, database, oid) { return new NativeReleasePostgresPool({ database, databaseOid: oid, clusterId: state.clusterId }); }
function mirrorContract(state) {
  return { version: "native-app-data-forward-v1", kind: "initial-cutover", clusterId: state.clusterId,
    oldDatabaseOid: state.oldDatabaseOid, newDatabaseOid: state.candidateOid, candidateDatabase: state.candidateDatabase,
    archiveDatabase: state.archiveDatabase, compatibleRuntimeSha256: state.oldSha };
}
function readOldRuntimeIdentity() {
  secureDirectory("/opt/football-predict");
  const marker = (name, optional = false) => {
    const file = "/opt/football-predict/" + name;
    let st; try { st = fs.lstatSync(file); } catch (error) { if (optional && error.code === "ENOENT") return "-"; throw error; }
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022) && st.nlink === 1 && st.size <= 128,
      "old runtime marker unsafe");
    return fs.readFileSync(file, "utf8").trim();
  };
  const bundleMarker = marker(".release-bundle-sha256"), liveMarker = marker(".release-live-complete", true);
  assert.match(bundleMarker, /^[a-f0-9]{64}$/);
  let serverIndexSha256 = null;
  if (liveMarker === "-") {
    const file = "/opt/football-predict/server/index.cjs", st = fs.lstatSync(file);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022) && st.nlink === 1 && st.size <= 8 * 1024 * 1024,
      "unaccepted runtime entrypoint unsafe");
    serverIndexSha256 = hash(fs.readFileSync(file));
    assert.equal(bundleMarker, LEGACY_UNACCEPTED.bundleSha256, "unaccepted source marker changed");
    assert.equal(serverIndexSha256, LEGACY_UNACCEPTED.serverIndexSha256, "unaccepted source code changed");
  } else assert.equal(liveMarker, bundleMarker, "old runtime has mismatched acceptance marker");
  return { bundleMarker, liveMarker, serverIndexSha256 };
}
async function captureLegacyBaseline({ sha, directory, oldIdentity, topologyBefore }) {
  assert.equal(oldIdentity.liveMarker, "-");
  const source = pool({ clusterId: topologyBefore.clusterId }, "football", topologyBefore.databases.football);
  try {
    const rows = (await source.query("SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE \"C\"")).rows;
    assert.ok(rows.length >= 198 && rows.length <= 100000, "unaccepted baseline frozen recommendation count unsafe");
    const frozen = rows.map(row => ({ decisionId: row.decision_id, sha256: hash(row.record) }));
    const generation = require("../server/dataGenerationStore.cjs").resolveCurrentGeneration({ storeDir: STORE }).pointer;
    const metaRows = (await source.query("SELECT key,value FROM football.projection_meta WHERE key IN ('data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at')")).rows;
    const meta = Object.fromEntries(metaRows.map(row => [row.key, row.value]));
    assert.equal(meta.data_publication_mode, "active-generation", "unaccepted baseline is not a native generation");
    assert.equal(meta.data_generation_id, generation.generationId, "unaccepted baseline PG/generation mismatch");
    assert.equal(meta.manifest_hash, generation.manifestHash, "unaccepted baseline PG/manifest mismatch");
    assert.equal(meta.data_generation_source_cycle_id, generation.sourceCycleId, "unaccepted baseline PG/source mismatch");
    assert.equal(Date.parse(meta.committed_at), Date.parse(generation.committedAt), "unaccepted baseline PG/commit mismatch");
    const receipt = { version: "legacy-unaccepted-baseline-v1", releaseSha256: sha,
      oldBundleSha256: oldIdentity.bundleMarker, oldLiveMarker: "-", serverIndexSha256: oldIdentity.serverIndexSha256,
      runtimeTreeSha256: runtimeTreeSha256("/opt/football-predict"),
      clusterId: topologyBefore.clusterId, databaseOid: topologyBefore.databases.football,
      generationId: generation.generationId, manifestHash: generation.manifestHash,
      sourceCycleId: generation.sourceCycleId, committedAt: generation.committedAt,
      frozen, capturedAt: new Date().toISOString() };
    const bytes = JSON.stringify(receipt) + "\n";
    assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024, "unaccepted baseline receipt oversized");
    write(path.join(directory, "legacy-unaccepted-baseline.json"), receipt);
    return hash(bytes);
  } finally { await source.end(); }
}
function legacyGenerationTransition(baseline, current) {
  const fields = ["generationId", "manifestHash", "sourceCycleId", "committedAt"];
  for (const field of fields) assert.ok(typeof baseline[field] === "string" && typeof current[field] === "string" && current[field],
    "unaccepted baseline generation field missing: " + field);
  assert.match(baseline.generationId, /^g-[a-f0-9]{64}$/);
  assert.match(current.generationId, /^g-[a-f0-9]{64}$/);
  assert.match(baseline.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(current.manifestHash, /^[a-f0-9]{64}$/);
  const fromTime = Date.parse(baseline.committedAt), toTime = Date.parse(current.committedAt);
  assert.ok(Number.isFinite(fromTime) && Number.isFinite(toTime), "unaccepted baseline generation clock invalid");
  const advanced = baseline.generationId !== current.generationId;
  if (advanced) assert.ok(toTime > fromTime, "unaccepted baseline generation regressed");
  else for (const field of fields) assert.equal(current[field], baseline[field], "same generation identity changed: " + field);
  return { from: Object.fromEntries(fields.map(field => [field, baseline[field]])),
    to: Object.fromEntries(fields.map(field => [field, current[field]])), advanced };
}
async function allocate(sha, directory) {
  const oldIdentity = readOldRuntimeIdentity(), oldSha = oldIdentity.bundleMarker;
  const environment = fs.readFileSync("/etc/football-predict/env", "utf8");
  const native = /^FOOTBALL_STORAGE_MODE=postgres-only\s*$/m.test(environment);
  if (!native) { assert.match(BOOTSTRAP_SHA || "", /^[a-f0-9]{64}$/, "accepted bootstrap has not been pinned"); assert.equal(oldSha, BOOTSTRAP_SHA); }
  const before = topology(), suffix = sha.slice(0, 12) + "_" + Math.floor(Date.now() / 1000);
  const candidateDatabase = "football_release_" + suffix, archiveDatabase = "football_legacy_" + suffix;
  assert.equal(before.databases[candidateDatabase], undefined); assert.equal(before.databases[archiveDatabase], undefined);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); secureDirectory(ROOT); fs.mkdirSync(directory, { mode: 0o700 });
  const legacyBaselineSha256 = oldIdentity.liveMarker === "-"
    ? await captureLegacyBaseline({ sha, directory, oldIdentity, topologyBefore: before }) : null;
  const intent = { version: "native-release-preparation-v1", sha, oldSha, kind: native ? "runtime-only" : "initial-cutover", clusterId: before.clusterId,
    maintenanceOid: before.databases.postgres, oldDatabaseOid: before.databases.football, candidateDatabase, archiveDatabase,
    legacyBaselineSha256, key: crypto.randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  write(path.join(directory, "allocation-intent.json"), intent);
  const admin = pool(intent, "postgres", intent.maintenanceOid);
  try {
    await admin.query('CREATE DATABASE "' + candidateDatabase + '" TEMPLATE template0 OWNER football');
    await admin.query('REVOKE ALL ON DATABASE "' + candidateDatabase + '" FROM PUBLIC');
    const after = topology(); assert.equal(after.clusterId, before.clusterId); assert.equal(after.databases.football, intent.oldDatabaseOid);
    const state = { ...intent, candidateOid: after.databases[candidateDatabase] };
    const contract = contractFor({ kind: intent.kind, oldIdentity, topology: after,
      candidateDatabase: native ? null : candidateDatabase, archiveDatabase: native ? null : archiveDatabase,
      nativeAlreadyActive: native, legacyBaselineSha256 });
    write(path.join(directory, "state.json"), { ...state, contract });
    return { ok: true, directory, kind: intent.kind, candidateDatabase, archiveDatabase, candidateOid: state.candidateOid, productionWrites: 0 };
  } finally { await admin.end(); }
}
async function postgresCli(args, input, output) {
  const child = spawn("/usr/sbin/runuser", ["-u", "postgres", "--", ...args], { env: { PATH: "/usr/bin:/bin", PGHOST: "/var/run/postgresql", PGUSER: "postgres", PGCONNECT_TIMEOUT: "5" },
    detached: true, stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-2000); });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  const timer = setTimeout(stop, 720000);
  try {
    await Promise.all([input ? pipeline(input, child.stdin) : Promise.resolve(), output ? pipeline(child.stdout, output) : Promise.resolve()]);
    const result = await closed; assert.equal(result.code, 0, "PostgreSQL backup/restore failed: " + stderr);
  } catch (error) { stop(); await closed.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}
async function copyGenerationAsService(identity, destination) {
  // Preload reviewed code as root, then copy as the existing service account.
  // Its lease is readable by the real generation garbage collector from the
  // moment it is published, including while the official worker is running.
  const gid = Number(spawnSync("/usr/bin/id", ["-g", "football"], { encoding: "utf8" }).stdout.trim()); assert.ok(Number.isSafeInteger(gid) && gid > 0);
  const temporary = fs.mkdtempSync("/var/lib/football-native-copy-"); fs.chownSync(temporary, 0, gid); fs.chmodSync(temporary, 0o770);
  const target = path.join(temporary, "store");
  const source = `const {copyNativeReleaseGeneration}=require(${JSON.stringify(path.join(__dirname, "nativeReleaseGenerationCopy.cjs"))});process.setgroups([]);process.setgid('football');process.setuid('football');console.log(JSON.stringify(copyNativeReleaseGeneration(${JSON.stringify({ sourceStoreDir: STORE, targetStoreDir: target, identity })})));`;
  const child = spawnSync("/opt/node-v22.22.1/bin/node", ["--max-old-space-size=192", "-e", source], {
    env: { PATH: "/usr/bin:/bin", NODE_PATH: "/opt/football-predict/node_modules" }, encoding: "utf8", timeout: 240000, maxBuffer: 16384,
  });
  assert.equal(child.status, 0, "exact generation copy failed: " + (child.stderr || child.error?.message || ""));
  const proof = JSON.parse(child.stdout); assert.equal(proof.ok, true);
  fs.chmodSync(temporary, 0o700);
  function seal(file) { const st = fs.lstatSync(file); assert.ok(!st.isSymbolicLink());
    if (st.isDirectory()) { for (const entry of fs.readdirSync(file)) seal(path.join(file, entry)); fs.chownSync(file, 0, 0); fs.chmodSync(file, 0o700); }
    else { assert.ok(st.isFile() && st.nlink === 1); fs.chownSync(file, 0, 0); fs.chmodSync(file, 0o600); } }
  seal(target); assert.equal(fs.statSync(target).dev, fs.statSync(path.dirname(destination)).dev);
  fs.renameSync(target, destination); fs.rmdirSync(temporary);
  const resolved = require("../server/dataGenerationStore.cjs").resolveCurrentGeneration({ storeDir: destination });
  assert.equal(resolved.manifestHash, identity.manifestHash); return proof;
}
async function prepare(state, directory, seed) {
  const administrator = pool(state, "postgres", state.maintenanceOid), sourcePool = pool(state, "football", state.oldDatabaseOid);
  const candidatePool = pool(state, state.candidateDatabase, state.candidateOid);
  const session = new NativeReleaseDatabaseSession({ administrator, sourcePool, candidatePool, contract: mirrorContract(state), key: Buffer.from(state.key, "hex") });
  const attempt = (seed ? "seed-" : "refresh-") + Date.now(), store = path.join(directory, attempt + "-store");
  write(path.join(directory, attempt + "-started.json"), { startedAt: new Date().toISOString(), sha: state.sha, seed });
  try {
    const identity = await session.beginSnapshot();
    // Check the complete source schema in the held read-only snapshot before
    // spending minutes on a backup/restore that the mirror cannot accept.
    const mirrorCatalog = await assertMirrorSourceCatalog(session.source);
    console.log(JSON.stringify({ phase: "native-source-catalog-preflight", ...mirrorCatalog, productionWrites: 0 }));
    const generation = await copyGenerationAsService(identity, store);
    let backup = null;
    if (seed) {
      assert.equal(fs.existsSync(path.join(directory, "seed-accepted.json")), false);
      const snapshot = (await session.source.query("SELECT pg_export_snapshot() snapshot")).rows[0].snapshot;
      assert.match(snapshot, /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i);
      const archive = path.join(directory, "football.dump");
      await postgresCli(["/usr/bin/pg_dump", "--format=custom", "--compress=1", "--no-owner", "--no-acl", "--snapshot=" + snapshot, "--dbname=football"], null, fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }));
      const fd = fs.openSync(archive, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const digest = crypto.createHash("sha256"); for await (const bytes of fs.createReadStream(archive)) digest.update(bytes);
      backup = { archive, bytes: fs.statSync(archive).size, sha256: digest.digest("hex"), sourceSnapshot: snapshot };
      write(path.join(directory, "backup.json"), backup);
      await postgresCli(["/usr/bin/pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--role=football", "--dbname=" + state.candidateDatabase], fs.createReadStream(archive), null);
      // Prior native releases may carry private mirror bookkeeping; it is
      // transport metadata, never a football business table or recovery copy.
      await candidatePool.query("DROP SCHEMA IF EXISTS football_release_private CASCADE");
    }
    const mirror = await session.mirror(progress => console.log(JSON.stringify({ phase: "native-candidate-mirror", ...progress })));
    if (seed) { assert.equal(mirror.copiedRows, 0, "restored backup differs from its still-held source snapshot"); assert.equal(mirror.removedCandidateRows, 0); assert.equal(mirror.verifiedSeedRows, mirror.inspectedRows); }
    const proof = { ok: true, sha: state.sha, seed, store, identity, generation, mirror, backup, completedAt: new Date().toISOString(), sqliteExports: 0, productionWrites: 0 };
    write(path.join(directory, attempt + "-accepted.json"), proof);
    if (seed) write(path.join(directory, "seed-accepted.json"), proof);
    return proof;
  } finally { await session.close(); await administrator.end(); }
}
function assertWritersStopped() {
  for (const unit of ["football-predict.service", "football-sync-worker.service", "football-monitor.service", "football-cleanup.service", "football-monitor.timer", "football-cleanup.timer"]) {
    const result = spawnSync("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--property=MainPID", "--value"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, "writer state unavailable: " + unit);
    const fields = result.stdout.trim().split("\n");
    assert.ok(fields.includes("inactive") || fields.includes("failed"), "writer still active: " + unit);
    assert.ok(!fields.some(value => /^[1-9][0-9]*$/.test(value)), "writer PID remains: " + unit);
  }
}
async function importLegacyLedgers(candidatePool) {
  const learning = require("./importPostgresLearningLedger.cjs"), observations = require("./importPostgresObservationStore.cjs");
  const file = path.join(STORE, "model-artifacts/model-learning.db");
  const snapshot = learning.readSqliteLearningLedgerSnapshot(file);
  const learningProof = await learning.importPostgresLearningLedger({ pool: candidatePool, snapshot });
  const observationDir = path.join(STORE, "research/openfootball-current-observations-v1");
  const observationProof = await observations.importPostgresObservationStore({ pool: candidatePool, storeDir: observationDir });
  return { ok: true, learning: learningProof, observations: observationProof, productionWrites: 0 };
}
function publisherPointerLock() {
  const { acquirePointerCommitLock, storePaths } = require("../server/dataGenerationStore.cjs");
  const lockDir = storePaths(STORE).pointerLockDir, held = acquirePointerCommitLock({ lockDir, timeoutMs: 10000 });
  try {
    const uid = Number(spawnSync("/usr/bin/id", ["-u", "football"], { encoding: "utf8" }).stdout.trim());
    const gid = Number(spawnSync("/usr/bin/id", ["-g", "football"], { encoding: "utf8" }).stdout.trim());
    assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
    fs.chownSync(path.join(lockDir, "owner.json"), uid, gid); fs.chownSync(lockDir, uid, gid); return held;
  } catch (error) { held.release(); throw error; }
}
async function finalizeRuntime(state, directory) {
  assert.equal(state.kind, "runtime-only"); assert.equal(state.contract.oldDatabaseOid, state.contract.newDatabaseOid); assertWritersStopped();
  if (state.contract.legacyBaselineSha256) {
    const baselineFile = path.join(directory, "legacy-unaccepted-baseline.json"), baselineBytes = fs.readFileSync(baselineFile);
    assert.equal(hash(baselineBytes), state.contract.legacyBaselineSha256, "unaccepted baseline receipt changed");
    const baseline = read(baselineFile), observed = readOldRuntimeIdentity();
    assert.equal(observed.bundleMarker, baseline.oldBundleSha256);
    assert.equal(observed.liveMarker, "-");
    assert.equal(observed.serverIndexSha256, baseline.serverIndexSha256);
    assert.equal(runtimeTreeSha256("/opt/football-predict"), baseline.runtimeTreeSha256,
      "old runtime source tree changed between baseline and stopped cutover");
  }
  const seed = read(path.join(directory, "seed-accepted.json")); assert.equal(seed.ok, true); assert.equal(seed.sha, state.sha);
  write(path.join(directory, "final-started.json"), { sha: state.sha, startedAt: new Date().toISOString() });
  const held = publisherPointerLock(), sourcePool = pool(state, "football", state.oldDatabaseOid); let session;
  try {
    if (state.contract.legacyBaselineSha256) {
      const baseline = read(path.join(directory, "legacy-unaccepted-baseline.json"));
      const observed = (await sourcePool.query("SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE \"C\"")).rows;
      const byId = new Map(observed.map(row => [row.decision_id, hash(row.record)]));
      for (const row of baseline.frozen) assert.equal(byId.get(row.decisionId), row.sha256,
        "frozen recommendation changed since unaccepted baseline: " + row.decisionId);
    }
    const transaction = require("../deploy/light-server/football-release-recovery.cjs").loadTransaction();
    assert.equal(transaction.bundleSha, state.sha); assert.deepEqual(transaction.native.contract, state.contract); assert.ok(transaction.newIdentity);
    session = await require("./postgresRuntimeReadSession.cjs").openPostgresRuntimeReadSession({ pool: sourcePool, storeDir: STORE,
      publicDataDir: "/opt/football-predict/public/data", protectReceipt: true, pointerLockHandle: held });
    await session.guardedFinals(); assertWritersStopped();
    const { storePaths, readPointer } = require("../server/dataGenerationStore.cjs"), pointer = readPointer(storePaths(STORE).currentPointer);
    for (const name of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) assert.equal(pointer[name], session.identity[name]);
    const legacyBaselineTransition = state.contract.legacyBaselineSha256
      ? legacyGenerationTransition(read(path.join(directory, "legacy-unaccepted-baseline.json")), session.identity) : null;
    const proof = { ok: true, sha: state.sha, kind: state.kind, publication: session.identity, databaseOid: state.oldDatabaseOid,
      ...(legacyBaselineTransition ? { legacyBaselineTransition } : {}),
      databaseWrites: 0, databaseRenames: 0, sqliteAccesses: 0, sqliteExports: 0, completedAt: new Date().toISOString() };
    write(path.join(directory, "data-finalized.json"), proof); return proof;
  } finally { if (session) await session.close(); await sourcePool.end(); held.release(); }
}
async function finalize(state, directory) {
  if (state.kind === "runtime-only") return finalizeRuntime(state, directory);
  assert.equal(state.kind, "initial-cutover", "runtime-only data replacement is not permitted");
  assertWritersStopped(); const seed = read(path.join(directory, "seed-accepted.json")); assert.equal(seed.ok, true);
  assert.equal(seed.sha, state.sha); assert.equal(seed.mirror.copiedRows, 0); assert.equal(seed.mirror.inspectedRows, seed.mirror.verifiedSeedRows);
  write(path.join(directory, "final-started.json"), { sha: state.sha, startedAt: new Date().toISOString() });
  const administrator = pool(state, "postgres", state.maintenanceOid), sourcePool = pool(state, "football", state.oldDatabaseOid);
  const candidatePool = pool(state, state.candidateDatabase, state.candidateOid);
  const session = new NativeReleaseDatabaseSession({ administrator, sourcePool, candidatePool, contract: state.contract, key: Buffer.from(state.key, "hex") });
  session.lastMirror = seed.mirror;
  const { storePaths, inspectPointerCommitLockActivity, readPointer } = require("../server/dataGenerationStore.cjs");
  const paths = storePaths(STORE); let held;
  try {
    held = publisherPointerLock();
    // The service account must be able to reap this exact dead-owner lock if
    // the publisher host loses power. Keep root's PID/token, change ownership
    // while every managed writer is stopped; the canonical lock remains held.
    const verifyDurableBarrier = async contract => {
      assertWritersStopped();
      const transaction = require("../deploy/light-server/football-release-recovery.cjs").loadTransaction();
      assert.equal(transaction.bundleSha, state.sha); assert.deepEqual(transaction.native.contract, contract); assert.ok(transaction.newIdentity);
      const activity = inspectPointerCommitLockActivity({ lockDir: paths.pointerLockDir, staleMs: Number.MAX_SAFE_INTEGER });
      assert.equal(activity.active, true); assert.equal(activity.owner.token, held.owner.token); assert.equal(activity.owner.pid, process.pid);
    };
    const verifyGeneration = async identity => {
      const pointer = readPointer(paths.currentPointer);
      for (const name of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) assert.equal(pointer[name], identity[name], "final generation binding changed: " + name);
    };
    let ledgers, parity;
    const completeCandidate = async ({ client, identity }) => {
      const borrowed = { connect: async () => ({ query: client.query.bind(client), release() {} }), query: client.query.bind(client) };
      ledgers = await importLegacyLedgers(borrowed);
      parity = await require("./verifyPostgresRetirementParity.cjs").verifyPostgresRetirementParity({ pool: borrowed,
        storeDir: STORE, publicDataDir: "/opt/football-predict/public/data", sqlitePath: path.join(STORE, "football.db"), pointerLockHandle: held });
      assert.equal(parity.ok, true); assert.deepEqual(parity.publication, identity);
      // Private mirror bookkeeping is not needed in the serving database.
      await client.query("DROP SCHEMA football_release_private CASCADE");
      write(path.join(directory, "final-data-verified.json"), { ok: true, sha: state.sha, identity, parity, ledgers });
    };
    const result = await session.finalMirrorAndSwitch({ verifyDurableBarrier, verifyGeneration, completeCandidate,
      onProgress: progress => console.log(JSON.stringify({ phase: "native-final-mirror", ...progress })) });
    const proof = { ...result, parity, ledgers, sha: state.sha, completedAt: new Date().toISOString() };
    write(path.join(directory, "database-switched.json"), proof); write(path.join(directory, "data-finalized.json"), proof); return proof;
  } finally { await session.close(); await administrator.end(); if (held) held.release(); }
}
async function candidateAccess(state, directory, writable = false) {
  const prefix = writable ? "build" : "candidate", role = "football_" + prefix + "_" + state.candidateDatabase.slice("football_release_".length), password = crypto.randomBytes(32).toString("hex");
  assert.match(role, /^football_(candidate|build)_[a-f0-9]{12}_[0-9]{1,10}$/);
  const admin = pool(state, "postgres", state.maintenanceOid), candidate = pool(state, state.candidateDatabase, state.candidateOid);
  try {
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=$1", [role])).rows[0].n, 0);
    write(path.join(directory, prefix + "-access-intent.json"), { role, database: state.candidateDatabase });
    await admin.query(`SET password_encryption='scram-sha-256'; CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${password}'`);
    await admin.query(`GRANT CONNECT ON DATABASE "${state.candidateDatabase}" TO "${role}"`);
    if (writable) await admin.query(`GRANT TEMPORARY ON DATABASE "${state.candidateDatabase}" TO "${role}"`);
    await candidate.query(`GRANT USAGE ON SCHEMA football TO "${role}"; GRANT ${writable ? "SELECT,INSERT,UPDATE,DELETE" : "SELECT"} ON ALL TABLES IN SCHEMA football TO "${role}"`);
    if (writable) await candidate.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA football TO "${role}"`);
    await admin.query(`ALTER ROLE "${role}" SET default_transaction_read_only=${writable ? "off" : "on"}; ALTER ROLE "${role}" SET statement_timeout='120s'`);
    const production = pool(state, "football", state.oldDatabaseOid);
    try {
      const grants = (await production.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='football' AND c.relkind IN ('r','p','v','m') AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE')", [role])).rows[0].n;
      assert.equal(grants, 0, "candidate role inherited production table privileges");
    } finally { await production.end(); }
    const environmentFile = path.join(directory, prefix + ".env");
    const selectors = require("./nativeReleaseJournal.cjs").NATIVE_SELECTORS;
    const lines = Object.entries(selectors).map(([key, value]) => key + "=" + value);
    lines.push("FOOTBALL_POSTGRES_URL=postgresql://" + role + ":" + password + "@127.0.0.1:5432/" + state.candidateDatabase, "FOOTBALL_POSTGRES_SSL_MODE=disable");
    const fd = fs.openSync(environmentFile, "wx", 0o600); try { fs.writeFileSync(fd, lines.join("\n") + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    write(path.join(directory, prefix + "-access.json"), { role, database: state.candidateDatabase, environmentFile, readOnly: !writable });
    return { ok: true, role, environmentFile, readOnly: !writable, productionGrants: 0 };
  } finally { await candidate.end(); await admin.end(); }
}
async function dropCandidateAccess(state, directory, writable = false) {
  const prefix = writable ? "build" : "candidate", record = read(path.join(directory, prefix + "-access.json")); assert.equal(record.database, state.candidateDatabase);
  assert.match(record.role, /^football_(candidate|build)_[a-f0-9]{12}_[0-9]{1,10}$/);
  const admin = pool(state, "postgres", state.maintenanceOid), candidate = pool(state, state.candidateDatabase, state.candidateOid);
  try {
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1", [record.role])).rows[0].n, 0, "candidate readers have not stopped");
    await candidate.query('DROP OWNED BY "' + record.role + '"'); await admin.query('DROP ROLE "' + record.role + '"');
    const proof = { ok: true, role: record.role, terminatedConnections: 0 }; write(path.join(directory, prefix + "-access-dropped.json"), proof); return proof;
  } finally { await candidate.end(); await admin.end(); }
}
async function main() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0); assert.equal(process.version, "v22.22.1");
  const [action, sha] = process.argv.slice(2); assert.equal(process.argv.length, 4); assert.match(sha || "", /^[a-f0-9]{64}$/);
  assert.ok(["allocate", "seed", "refresh", "candidate-access", "drop-candidate-access", "build-access", "drop-build-access", "import-ledgers", "final"].includes(action));
  const directory = path.join(ROOT, sha);
  if (action === "allocate") return allocate(sha, directory);
  const state = read(path.join(directory, "state.json")); assert.equal(state.sha, sha); assert.match(state.key, /^[a-f0-9]{64}$/);
  const transaction = require("../deploy/light-server/football-release-recovery.cjs").loadTransaction();
  assert.equal(transaction.bundleSha, sha); assert.deepEqual(transaction.native.contract, state.contract);
  if (action === "candidate-access") return candidateAccess(state, directory);
  if (action === "drop-candidate-access") return dropCandidateAccess(state, directory);
  if (action === "build-access") return candidateAccess(state, directory, true);
  if (action === "drop-build-access") return dropCandidateAccess(state, directory, true);
  if (action === "import-ledgers") {
    if (state.kind === "runtime-only") return { ok: true, imported: false, sqliteAccesses: 0 };
    const candidate = pool(state, state.candidateDatabase, state.candidateOid);
    try { return await importLegacyLedgers(candidate); } finally { await candidate.end(); }
  }
  if (action === "final") return finalize(state, directory);
  if (action === "refresh") assert.equal(read(path.join(directory, "seed-accepted.json")).ok, true);
  return prepare(state, directory, action === "seed");
}
module.exports = { allocate, prepare, read, write, copyGenerationAsService, mirrorContract, finalize,
  legacyGenerationTransition, assertWritersStopped, candidateAccess, dropCandidateAccess };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, mirrorProgress: error.mirrorProgress })); process.exitCode = 1; });
