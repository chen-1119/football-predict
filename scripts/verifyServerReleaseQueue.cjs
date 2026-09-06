"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FIXED, POLL_MS, MAX_QUEUE_TTL_MS, MAX_OBSERVE_MS, RELEASE_HORIZON_SECONDS,
  parseOptions, assertRunner, inspectGenerationDocuments, probeWindow, fixedLaunchSpec, runQueue, createStateStore,
} = require("./queueServerRelease.cjs");
const { createTransitionLease } = require("./releaseTransitionLease.cjs");
const { buildManifest, stableStringify } = require("../server/dataGenerationStore.cjs");
const checks = [];
const check = async (name, action) => {
  try { await action(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack || String(error) }); }
};
const SHA = "a".repeat(64);
const START = Date.parse("2026-09-06T12:00:00.000Z");
const options = (extras = []) => parseOptions(["--sha", SHA, "--not-before", new Date(START + 60_000).toISOString(),
  "--expires-at", new Date(START + 24 * 60 * 60_000).toISOString(), ...extras], START);
const fixture = (overrides = {}) => {
  let now = START;
  const writes = [], logs = [], launches = [], waits = [];
  const config = options();
  const runtime = {
    pid: 1001, now: () => now, cancelled: () => false,
    validateBundle: () => ({ identity: "signed-manifest-identity", expiresAtMs: START + MAX_QUEUE_TTL_MS }),
    probe: () => ({ safe: true, minimumHorizonSeconds: 8520, generationId: "g-test" }),
    write: (state) => writes.push(structuredClone(state)), log: (entry) => logs.push(structuredClone(entry)),
    wait: async (ms) => { waits.push(ms); now += ms; },
    launch: (sha) => { assert.equal(writes.at(-1).state, "starting"); assert.equal(writes.at(-1).attempted, true); launches.push(sha); return 2002; },
    observe: () => ({ complete: true }), ...overrides,
  };
  return { config, runtime, writes, logs, launches, waits, setNow: (value) => { now = value; } };
};

const main = async () => {
  await check("queue paths, sudo entrypoint and polling interval are fixed", () => {
    assert.equal(FIXED.entrypoint, "/usr/local/sbin/football-release");
    assert.equal(FIXED.state, "/home/ubuntu/.local/state/football-release-queue");
    assert.equal(FIXED.incoming, "/var/lib/football-release/incoming");
    assert.equal(POLL_MS, 60_000);
    assert.equal(RELEASE_HORIZON_SECONDS, 7620);
    for (const arg of ["--root", "--store", "--state", "--command", "--interval", "--token"]) {
      assert.throws(() => options([arg, "/tmp/override"]), /invalid-arguments/);
    }
  });
  await check("queue rejects root, other users, alternate homes and non-Linux execution", () => {
    assertRunner({ uid: 1000, username: "ubuntu", homedir: FIXED.home }, "linux");
    for (const [identity, platform] of [
      [{ uid: 0, username: "ubuntu", homedir: FIXED.home }, "linux"],
      [{ uid: 1000, username: "football", homedir: FIXED.home }, "linux"],
      [{ uid: 1000, username: "ubuntu", homedir: "/tmp" }, "linux"],
      [{ uid: 1000, username: "ubuntu", homedir: FIXED.home }, "win32"],
    ]) assert.throws(() => assertRunner(identity, platform), /runner-must-be-nonroot-ubuntu/);
  });
  await check("queue validates SHA, canonical bounded TTL and at least 900 seconds preparation", () => {
    assert.equal(options().preparationSeconds, 900);
    assert.equal(options(["--prepare-margin-seconds", "1800"]).preparationSeconds, 1800);
    for (const margin of ["0", "899", "900.1", "0900", "7201", "NaN"]) assert.throws(() => options(["--prepare-margin-seconds", margin]));
    for (const ttl of [0, -1, MAX_QUEUE_TTL_MS + 1]) {
      assert.throws(() => parseOptions(["--sha", SHA, "--expires-at", new Date(START + ttl).toISOString()], START), /invalid-queue-ttl/);
    }
    for (const sha of ["a", "A".repeat(64), `${SHA};sudo bad`]) assert.throws(() => parseOptions(["--sha", sha, "--expires-at", new Date(START + 1000).toISOString()], START));
    assert.throws(() => options(["--sha", SHA]), /invalid-arguments/);
    for (const notBefore of [START - 1, START, START + MAX_QUEUE_TTL_MS]) {
      assert.throws(() => parseOptions(["--sha", SHA, "--not-before", new Date(notBefore).toISOString(),
        "--expires-at", new Date(START + 24 * 60 * 60_000).toISOString()], START), /invalid-not-before/);
    }
  });
  await check("launcher grants no new root entrypoint and carries no inherited secrets or shell", () => {
    const spec = fixedLaunchSpec(SHA);
    assert.equal(spec.command, "/usr/bin/sudo");
    assert.deepEqual(spec.args, ["-n", FIXED.entrypoint, SHA]);
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.shell, false);
    assert.deepEqual(spec.options.stdio, ["ignore", "ignore", "ignore"]);
    assert.deepEqual(Object.keys(spec.options.env).sort(), ["HOME", "LANG", "PATH"]);
    assert.throws(() => fixedLaunchSpec("; bad"), /invalid-bundle-sha/);
    const source = fs.readFileSync(path.join(__dirname, "queueServerRelease.cjs"), "utf8");
    const program = source.slice(source.indexOf("const main = async"));
    assert.doesNotMatch(program, /readImmutableCurrent|readCurrent|runtime\.probe|football-access-code-qa|\/api\//,
      "scheduled production dispatch must not pretend to read inaccessible private fixtures or create QA credentials");
  });
  await check("a 135 minute window is not enough after 127 minute gate plus minimum preparation", () => {
    const payload = [{ id: "fixture", sourceMatchId: "fixture", status: "SCHEDULED",
      kickoffTime: new Date(START + 145 * 60_000).toISOString(),
      predictionMeta: { cutoffTime: new Date(START + 135 * 60_000).toISOString() } }];
    const proof = probeWindow({ payload, generationId: "g-fixture" }, options(), START, createTransitionLease);
    assert.equal(proof.safe, false);
    assert.equal(proof.minimumHorizonSeconds, 8520);
    assert.equal(proof.reason, "transition-window-closed");
  });
  await check("immutable fixture proof binds manifest hash, current bytes, pointer and complete non-empty inventory", () => {
    const bytes = Buffer.from(JSON.stringify([{ id: "one", kickoffTime: "2026-09-07T12:00:00.000Z" }]));
    const manifest = buildManifest({ sourceCycleId: "fixture", files: [{ relativePath: "matches-current.json", bytes, rows: 1 }], coreFiles: ["matches-current.json"] });
    const pointer = { schemaVersion: 1, generationId: manifest.generationId, manifestHash: manifest.manifestHash, sourceCycleId: "fixture", committedAt: new Date(START).toISOString() };
    const args = { pointer, manifest, currentBytes: bytes, pointerAfter: { ...pointer }, stableStringify };
    assert.equal(inspectGenerationDocuments(args).payload.length, 1);
    assert.throws(() => inspectGenerationDocuments({ ...args, currentBytes: Buffer.from("[]") }));
    assert.throws(() => inspectGenerationDocuments({ ...args, pointerAfter: { ...pointer, committedAt: new Date(START + 1).toISOString() } }), /generation-changed/);
    assert.throws(() => inspectGenerationDocuments({ ...args, manifest: { ...manifest, sourceCycleId: "tampered" } }), /invalid-generation-manifest/);
    assert.throws(() => inspectGenerationDocuments({ ...args, pointer: { ...pointer, generationId: "../../other" } }), /invalid-generation-pointer/);
  });
  await check("scheduled launch revalidates signature and durably records attempted without claiming a live window", async () => {
    let validations = 0;
    const f = fixture({ probe: () => { throw new Error("must not read private data"); }, validateBundle: () => { validations++; return { identity: "same", expiresAtMs: START + MAX_QUEUE_TTL_MS }; } });
    const result = await runQueue(f.config, f.runtime);
    assert.equal(result.state, "completed");
    assert.equal(validations, 2);
    assert.deepEqual(f.launches, [SHA]);
    assert.deepEqual(f.writes.map((row) => row.state), ["waiting-not-before", "starting", "running", "completed"]);
    assert.equal(f.writes[2].childPid, 2002);
    assert.equal(f.writes.every((row) => row.windowPreauthorized === false), true);
    assert.equal(f.writes[0].scheduledAt, new Date(f.config.notBeforeMs).toISOString());
  });
  await check("scheduled waiting consumes no sequence and unchanged minute polls do not spam logs", async () => {
    const f = fixture();
    f.config = { ...f.config, notBeforeMs: START + 180_000 };
    await runQueue(f.config, f.runtime);
    assert.deepEqual(f.waits, [60_000, 60_000, 60_000]);
    assert.equal(f.logs.filter((row) => row.state === "waiting-not-before").length, 1);
    assert.equal(f.writes.filter((row) => row.state === "waiting-not-before").every((row) => row.attempted === false), true);
    assert.equal(f.launches.length, 1);
  });
  await check("a missed queue expiry never launches even when the scheduled time has passed", async () => {
    const f = fixture();
    f.config = { ...f.config, expiresAtMs: START + 120_000 };
    f.setNow(START + 180_000);
    const result = await runQueue(f.config, f.runtime);
    assert.equal(result.state, "expired");
    assert.equal(f.launches.length, 0);
  });
  await check("schedule changes are decided by signed early and final guards, never bypassed by the queue", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../deploy/light-server/release-from-bundle.sh"), "utf8");
    const early = source.indexOf('"$TRUSTED_SOURCE_DIR/scripts/releaseTransitionLease.cjs" probe');
    const finalCreate = source.indexOf('"$NEXT_DIR/scripts/releaseTransitionLease.cjs" create');
    const finalVerify = source.indexOf('"$NEXT_DIR/scripts/releaseTransitionLease.cjs" verify');
    assert.ok(early > 0 && finalCreate > early && finalVerify > finalCreate);
    assert.ok(source.indexOf("early release transition horizon is unsafe; no host changes or candidate rebuild performed", early) < finalCreate);
    const f = fixture({ observe: () => ({ failed: true, reason: "signed-release-failed-no-retry" }) });
    const result = await runQueue(f.config, f.runtime);
    assert.equal(result.state, "failed");
    assert.equal(result.windowPreauthorized, false);
    assert.equal(f.launches.length, 1);
  });
  await check("signed manifest changes or queue outliving its signature fail before launch", async () => {
    let validations = 0;
    const f = fixture({ validateBundle: () => ({ identity: `changed-${++validations}`, expiresAtMs: START + MAX_QUEUE_TTL_MS }) });
    assert.equal((await runQueue(f.config, f.runtime)).reason, "signed-bundle-changed-while-waiting");
    assert.equal(f.launches.length, 0);
    const g = fixture({ validateBundle: () => ({ identity: "same", expiresAtMs: START + 1000 }) });
    assert.equal((await runQueue(g.config, g.runtime)).reason, "queue-outlives-signed-manifest");
    assert.equal(g.launches.length, 0);
  });
  await check("launch failure and deployment failure are terminal with no signed sequence retry", async () => {
    const f = fixture({ launch: () => { throw new Error("launch error must not leak"); } });
    const result = await runQueue(f.config, f.runtime);
    assert.equal(result.state, "failed");
    assert.equal(result.attempted, true);
    assert.equal(result.reason, "queue-operation-failed");
    await assert.rejects(() => runQueue(f.config, { ...f.runtime, previous: result }), /queue-already-attempted/);
    const g = fixture({ observe: () => ({ failed: true, reason: "signed-release-failed-no-retry" }) });
    assert.equal((await runQueue(g.config, g.runtime)).state, "failed");
    assert.equal(g.launches.length, 1);
    assert.equal(g.waits.length, 1);
  });
  await check("state persistence failure cannot fall through to privileged launch", async () => {
    const f = fixture({ write: () => { throw new Error("disk full"); } });
    await assert.rejects(() => runQueue(f.config, f.runtime), /disk full/);
    assert.equal(f.launches.length, 0);
  });
  await check("cancellation before dispatch consumes no sequence and observer cancellation never retries", async () => {
    const f = fixture({ cancelled: () => true });
    assert.equal((await runQueue(f.config, f.runtime)).reason, "queue-cancelled-before-launch");
    assert.equal(f.launches.length, 0);
    const g = fixture({ observe: () => ({ complete: false }) });
    g.runtime.cancelled = () => g.launches.length > 0;
    assert.equal((await runQueue(g.config, g.runtime)).reason, "observer-stopped-deployment-may-still-be-running");
    assert.equal(g.launches.length, 1);
  });
  await check("bounded observer timeout does not kill or retry a potentially running deployment", async () => {
    const f = fixture({ observe: () => ({ complete: false }) });
    const result = await runQueue(f.config, f.runtime);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "observer-deadline-deployment-may-still-be-running");
    assert.equal(f.launches.length, 1);
    assert.equal(f.waits.reduce((a, b) => a + b, 0), MAX_OBSERVE_MS + 60_000);
  });
  await check("atomic queue state is bounded, private and preserves explicit attempt identity", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "football-queue-state-"));
    try {
      const store = createStateStore(temporary, SHA, fs.statSync(temporary).uid);
      assert.equal(store.read(), null);
      store.write({ state: "waiting-window", attempted: false, pid: 123 });
      store.write({ state: "starting", attempted: true, pid: 123 });
      assert.deepEqual(store.read(), { state: "starting", attempted: true, pid: 123 });
      assert.deepEqual(fs.readdirSync(temporary), [`${SHA}.json`]);
      assert.throws(() => store.write({ huge: "x".repeat(65536) }), /queue-state-too-large/);
      assert.equal(store.read().attempted, true);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  for (const row of checks) console.log(`${row.ok ? "PASS" : "FAIL"} ${row.name}${row.error ? `\n${row.error}` : ""}`);
  console.log(JSON.stringify({ ok: checks.every((row) => row.ok), checks: checks.length, failed: checks.filter((row) => !row.ok).length }));
  if (checks.some((row) => !row.ok)) process.exitCode = 1;
};
main().catch((error) => { console.error(error); process.exitCode = 1; });
