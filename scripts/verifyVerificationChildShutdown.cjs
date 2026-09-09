"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { EventEmitter, once } = require("node:events"), { spawn } = require("node:child_process");
const vm = require("node:vm");
const { stopVerificationChild } = require("./stopVerificationChild.cjs");

async function verify() {
  const checks = [];
  const check = async (name, run) => { await run(); checks.push({ name, ok: true }); };
  function fixture() {
    const timers = new Map(), child = new EventEmitter(), kills = [];
    child.exitCode = null; child.signalCode = null;
    child.stdout = { closed: false }; child.stderr = { closed: false };
    child.kill = name => { kills.push(name); return true; };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "stopVerificationChild.cjs"), "utf8"), {
      module, setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
      clearTimeout: id => timers.delete(id),
    });
    const fire = ms => { const timer = [...timers.values()].find(t => t.ms === ms); assert.ok(timer); timer.fn(); };
    return { child, kills, timers, fire, stop: module.exports.stopVerificationChild };
  }
  await check("only bounded deadlines and owned child handles are accepted", async () => {
    for (const graceMs of [0, -1, NaN, Infinity, 30001, 1.5]) assert.throws(() => stopVerificationChild(null, { graceMs }));
    assert.throws(() => stopVerificationChild(123));
    assert.equal((await stopVerificationChild(null)).closed, true);
  });
  await check("normal close cancels both losing timers and removes listeners", async () => {
    const f = fixture(), pending = f.stop(f.child);
    assert.deepEqual(f.kills, ["SIGTERM"]);
    f.child.emit("close", 0);
    assert.equal((await pending).forced, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.child.listenerCount("close") + f.child.listenerCount("error"), 0);
  });
  await check("synchronous close during signal delivery also cancels every timer", async () => {
    const f = fixture(); f.child.kill = () => { f.child.emit("close", 0); return true; };
    assert.equal((await f.stop(f.child)).closed, true); assert.equal(f.timers.size, 0);
  });
  await check("exit with buffered pipes is not accepted until close", async () => {
    const f = fixture(); let settled = false;
    const pending = f.stop(f.child).then(v => { settled = true; return v; });
    f.child.exitCode = 0; f.child.emit("exit", 0); await Promise.resolve();
    assert.equal(settled, false); f.child.emit("close", 0); await pending;
  });
  await check("signal-exited child is not signalled again while pipes drain", async () => {
    const f = fixture(); f.child.signalCode = "SIGTERM";
    const pending = f.stop(f.child); f.fire(3000);
    assert.deepEqual(f.kills, []); f.child.emit("close", null, "SIGTERM"); await pending;
  });
  await check("already exited child with closed streams returns without timers", async () => {
    const f = fixture(); f.child.exitCode = 0; f.child.stdout.closed = f.child.stderr.closed = true;
    await f.stop(f.child); assert.equal(f.timers.size, 0); assert.deepEqual(f.kills, []);
  });
  await check("grace expiry escalates but still requires observed close", async () => {
    const f = fixture(); let settled = false;
    const pending = f.stop(f.child).then(v => { settled = true; return v; });
    f.fire(3000); await Promise.resolve(); assert.equal(settled, false);
    assert.deepEqual(f.kills, ["SIGTERM", "SIGKILL"]);
    f.child.emit("close", null, "SIGKILL"); assert.equal((await pending).forced, true);
  });
  await check("failed kill cannot silently authorize fixture cleanup", async () => {
    const f = fixture(); f.child.kill = () => false;
    const pending = f.stop(f.child); const rejected = assert.rejects(pending, { code: "VERIFIER_CHILD_NOT_CLOSED" });
    f.fire(3000); f.fire(6000); await rejected; assert.equal(f.timers.size, 0);
  });
  await check("thrown kill and child error remain bounded failures", async () => {
    const f = fixture(); f.child.kill = () => { throw new Error("fixture kill failure"); };
    const pending = f.stop(f.child), rejected = assert.rejects(pending, { code: "VERIFIER_CHILD_NOT_CLOSED" });
    f.child.emit("error", new Error("fixture child error")); f.fire(6000); await rejected;
  });
  await check("dead direct child with retained pipes fails without signalling another PID", async () => {
    const f = fixture(); f.child.exitCode = 0;
    const pending = f.stop(f.child), rejected = assert.rejects(pending, { code: "VERIFIER_CHILD_NOT_CLOSED" });
    f.fire(3000); f.fire(6000); await rejected; assert.deepEqual(f.kills, []);
    assert.equal(f.child.stdout.closed, false);
  });
  await check("real owned Node process closes without waiting out five-second grace", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);process.stdout.write('ready');"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const ready = once(child.stdout, "data");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await ready;
      const start = performance.now(), result = await stopVerificationChild(child, { graceMs: 5000 });
      assert.equal(result.closed, true); assert.ok(performance.now() - start < 4000);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) await stopVerificationChild(child); }
  });
  await check("all five scoped verifiers use observed-close cleanup", () => {
    for (const name of ["verifyAccessCodeConcurrency.cjs", "verifyRelaySnapshotUploadSerialization.cjs", "verifySportteryRelayDualLaneServer.cjs", "verifySyncWorkerEventBridge.cjs", "verifyDataGenerationEndToEnd.cjs"]) {
      assert.match(fs.readFileSync(path.join(__dirname, name), "utf8"), /stopVerificationChild/);
    }
  });
  if (process.platform === "linux") await check("real Linux SIGTERM-resistant child is killed and observed closed", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready');"], { stdio: ["ignore", "pipe", "pipe"] });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await once(child.stdout, "data");
      const result = await stopVerificationChild(child, { graceMs: 100 });
      assert.equal(result.forced, true); assert.equal(child.signalCode, "SIGKILL");
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) await stopVerificationChild(child); }
  });
  return { ok: true, verifier: "verification-child-shutdown", checks, platform: process.platform, nativeForcedShutdownTested: process.platform === "linux", productionWrites: 0 };
}
module.exports = { verify };
if (require.main === module) verify().then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => { console.error(e.stack); process.exitCode = 1; });
