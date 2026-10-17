"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { runFastPublisherChild } = require("../server/relayFastResultWatcher.cjs");
const { FAST_RESULT_PUBLISHER_MACHINE_ENV, FAST_RESULT_PUBLISHER_PROTOCOL } = require("./fastResultPublisherProtocol.cjs");

// The worker keeps one original publisher permit until its actual OS close.
// Native generation validation and publication stay together in that child.
let activePublisher = null;
async function runWorkerFastResultPublisher({ shutdownController, timeoutMs, terminateGraceMs }) {
  assert(shutdownController && typeof shutdownController.register === "function"
    && typeof shutdownController.unregister === "function"
    && typeof shutdownController.interruptionError === "function");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isSafeInteger(terminateGraceMs) && terminateGraceMs > 0);
  if (shutdownController.requested) throw shutdownController.interruptionError();
  if (activePublisher) throw Object.assign(Error("previous worker fast publisher close is unconfirmed"), { code: "SYNC_WORKER_FAST_PUBLISHER_BUSY" });
  const token = {}; activePublisher = token;
  const root = path.resolve(__dirname, ".."), publisherPath = require.resolve("./publishOfficialResultsFast.cjs");
  const heapArgs = process.execArgv.filter(arg => /^--max-(?:old|semi)-space-size=\d+$/.test(arg));
  let child = null, closed = false;
  try {
    const result = await runFastPublisherChild({
      publisherPath, cwd: root, env: process.env, timeoutMs, terminationGraceMs: terminateGraceMs,
      // This adapter accepts only the existing fixed CLI, never caller code.
      spawnImpl(executable, args) {
        assert.equal(executable, process.execPath); assert.deepEqual(args, [publisherPath]);
        child = spawn(process.execPath, [...heapArgs, require.resolve("./publishOfficialResultsFast.cjs")], {
          cwd: root, env: { ...process.env, [FAST_RESULT_PUBLISHER_MACHINE_ENV]: "1" },
          detached: process.platform !== "win32", shell: false, windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        shutdownController.register(child);
        child.once("close", () => {
          closed = true; shutdownController.unregister(child);
          if (activePublisher === token) activePublisher = null;
        });
        return child;
      },
    });
    if (shutdownController.requested) throw shutdownController.interruptionError();
    assert.equal(closed, true); assert.equal(result.protocol, FAST_RESULT_PUBLISHER_PROTOCOL);
    const { protocol, ...publication } = result;
    assert.equal(protocol, FAST_RESULT_PUBLISHER_PROTOCOL);
    return publication;
  } catch (error) {
    if (shutdownController.requested) throw shutdownController.interruptionError();
    throw error;
  } finally {
    if ((!child || closed) && activePublisher === token) activePublisher = null;
  }
}
module.exports = { runWorkerFastResultPublisher };
