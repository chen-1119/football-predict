"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const protocol = require("../scripts/postgresWorkerReadProtocol.cjs");
const input = { storeDir: path.resolve("fixture-store"), publicDataDir: path.resolve("fixture-public"),
  phase: "readiness", validationStep: { ok: true }, generationStep: { ok: true }, projectionStep: { ok: true } };
const identity = { mode: "active-generation", generationId: "generation-fixture", manifestHash: "a".repeat(64), sourceCycleId: "cycle-fixture", committedAt: "2026-10-17T00:00:00Z" };
const countResult = { ok: true, storage: "postgres", counts: { oddsSnapshots: 3, predictionSnapshots: 7 }, publicationIdentity: identity };
function fixture(behavior) {
  const children = new Set(), spawned = [], signals = [];
  const owner = { requested: false, register: child => children.add(child), unregister: child => children.delete(child),
    interruptionError: () => Object.assign(Error("interrupted"), { code: "SYNC_WORKER_INTERRUPTED" }) };
  const module = { exports: {} }, file = require.resolve("../scripts/postgresWorkerReadProcess.cjs");
  const nativeRequire = require("node:module").createRequire(file);
  const mockRequire = name => name === "node:child_process" ? { spawn(...args) {
    spawned.push(args);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.kill = signal => { signals.push(signal); behavior.kill?.(child, signal); return true; };
    let buffer = Buffer.alloc(0);
    child.stdin.on("data", b => { buffer = Buffer.concat([buffer, b]); });
    child.stdin.once("finish", () => behavior.run?.(child, JSON.parse(buffer)));
    return child;
  } } : nativeRequire(name);
  mockRequire.resolve = nativeRequire.resolve;
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { require: mockRequire, module, Buffer, TextDecoder, process, setTimeout, clearTimeout, Error });
  const run = (action = "counts", overrides = {}) => module.exports.readPostgresWorkerInChild(action, input,
    { timeoutMs: 1000, terminateGraceMs: 20, forceSettleMs: 20, shutdownController: owner, ...overrides });
  return { owner, children, spawned, signals, run };
}
const respond = (child, request, result = countResult) => child.stdout.write(JSON.stringify({ version: protocol.VERSION, id: request.id, action: request.action, result }));
test("fixed owned child keeps inherited environment and only heap CLI flags", async () => {
  let instance;
  const f = fixture({ run(child, request) { instance = child; respond(child, request); child.emit("exit", 0, null); } });
  let resolved = false;
  const pending = f.run().then(result => { resolved = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(resolved, false); assert.equal(f.children.size, 1);
  instance.emit("close", 0, null);
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), countResult); assert.equal(f.children.size, 0);
  const [exe, args, options] = f.spawned[0];
  assert.equal(exe, process.execPath); assert.equal(args.at(-1), require.resolve("../scripts/postgresWorkerReadChild.cjs"));
  assert(args.slice(0, -1).every(arg => /^--max-(old|semi)-space-size=\d+$/.test(arg)));
  assert.equal(options.env, process.env); assert.equal(options.shell, undefined); assert.equal(options.detached, false);
});
for (const kind of ["malformed", "wrong-id", "wrong-action", "negative-count", "identity-missing", "utf8", "extra-output"]) {
  test("IPC refuses " + kind, async () => {
    const f = fixture({ run(child, request) {
      if (kind === "malformed") child.stdout.write("{");
      else if (kind === "utf8") child.stdout.write(Buffer.from([0xc0, 0xaf]));
      else {
        const result = JSON.parse(JSON.stringify(countResult));
        if (kind === "negative-count") result.counts.oddsSnapshots = -1;
        if (kind === "identity-missing") delete result.publicationIdentity.manifestHash;
        respond(child, { ...request, ...(kind === "wrong-id" ? { id: "b".repeat(32) } : {}), ...(kind === "wrong-action" ? { action: "observation" } : {}) }, result);
        if (kind === "extra-output") child.stdout.write("another reply");
      }
      child.emit("close", 0, null);
    } });
    await assert.rejects(f.run(), { code: "SYNC_WORKER_READ_PROTOCOL" }); assert.equal(f.children.size, 0);
  });
}
test("oversized output is bounded and waits for owned close after SIGTERM", async () => {
  const f = fixture({ run(child) { child.stdout.write(Buffer.alloc(protocol.MAX_RESPONSE_BYTES + 1)); },
    kill(child) { setImmediate(() => child.emit("close", null, "SIGTERM")); } });
  await assert.rejects(f.run(), { code: "SYNC_WORKER_READ_IPC_LIMIT" }); assert.deepEqual(f.signals, ["SIGTERM"]); assert.equal(f.children.size, 0);
});
test("genuine over-budget completion stays rejected even with exit zero and valid data", async () => {
  const f = fixture({ run(child, request) { setTimeout(() => { respond(child, request); child.emit("close", 0, null); }, 35); } });
  await assert.rejects(f.run("counts", { timeoutMs: 20, terminateGraceMs: 30 }), { code: "SYNC_WORKER_COMMAND_TIMEOUT" });
  assert.equal(f.children.size, 0); assert.deepEqual(f.signals, ["SIGTERM"]);
});
test("unconfirmed close remains owned and cannot be accepted or forgotten", async () => {
  let child;
  const f = fixture({ run(value) { child = value; } });
  await assert.rejects(f.run("counts", { timeoutMs: 10 }), { code: "SYNC_WORKER_READ_CHILD_UNCONFIRMED" });
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]); assert.equal(f.children.size, 1);
  await assert.rejects(f.run(), { code: "SYNC_WORKER_READ_CHILD_UNCONFIRMED" }); assert.equal(f.spawned.length, 1);
  child.emit("close", null, "SIGKILL"); assert.equal(f.children.size, 0);
});
test("shutdown before spawn refuses and shutdown during read cannot return success", async () => {
  const f = fixture({ run(child, request) { f.owner.requested = true; respond(child, request); child.emit("close", 0, null); } });
  await assert.rejects(f.run(), { code: "SYNC_WORKER_INTERRUPTED" }); assert.equal(f.children.size, 0);
  await assert.rejects(f.run(), { code: "SYNC_WORKER_INTERRUPTED" }); assert.equal(f.spawned.length, 1);
});
test("a failed exit never promotes a syntactically valid reply", async () => {
  const f = fixture({ run(child, request) { respond(child, request); child.emit("close", 1, null); } });
  await assert.rejects(f.run(), { code: "SYNC_WORKER_READ_FAILED" });
});
test("request strips caller pools and arbitrary extra objects and retains skipped gates", () => {
  const request = protocol.createRequest("observation", { ...input, pool: {}, projectionStep: { ok: true, skipped: true } }, "a".repeat(32));
  assert.equal(request.input.pool, undefined); assert.equal(request.input.projectionStep.skipped, true);
  assert.throws(() => protocol.validateRequest({ ...request, action: "query" }));
  assert.throws(() => protocol.validateRequest({ ...request, input: { ...request.input, sql: "SELECT 1" } }));
});
