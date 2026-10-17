"use strict";
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, createRequest, validateResponse, decode } = require("./postgresWorkerReadProtocol.cjs");
const unconfirmedChildren = new Set();

function readPostgresWorkerInChild(action, input, { timeoutMs, terminateGraceMs, forceSettleMs, shutdownController } = {}) {
  for (const n of [timeoutMs, terminateGraceMs, forceSettleMs]) if (!Number.isSafeInteger(n) || n < 1) throw Error("invalid native worker read deadline");
  if (!shutdownController || typeof shutdownController.register !== "function" || typeof shutdownController.unregister !== "function") throw Error("native worker read requires owner");
  if (shutdownController.requested) return Promise.reject(shutdownController.interruptionError());
  if (unconfirmedChildren.size) return Promise.reject(Object.assign(Error("previous native worker read child close unconfirmed"), { code: "SYNC_WORKER_READ_CHILD_UNCONFIRMED" }));
  const request = createRequest(action, input, randomBytes(16).toString("hex")), payload = Buffer.from(JSON.stringify(request));
  if (payload.length > MAX_REQUEST_BYTES) throw Error("native worker read request limit");
  return new Promise((resolve, reject) => {
    // Fixed executable/entrypoint, no shell, no caller-supplied code or pool.
    // Keep the parent's configured heap instead of granting the capture heap.
    const heapArgs = process.execArgv.filter(arg => /^--max-(?:old|semi)-space-size=\d+$/.test(arg));
    const child = spawn(process.execPath, [...heapArgs, require.resolve("./postgresWorkerReadChild.cjs")], {
      env: process.env, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false, closed = false, failure = null, size = 0;
    let timeout, terminateTimer, closeTimer;
    const chunks = [];
    const error = (code, message) => Object.assign(new Error(message), { code });
    const finish = (err, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(terminateTimer); clearTimeout(closeTimer);
      // An unconfirmed child remains registered until its actual close event.
      if (closed) shutdownController.unregister(child);
      else unconfirmedChildren.add(child);
      if (err) reject(err); else resolve(value);
    };
    const signal = name => { try { child.kill(name); } catch { /* close or bounded refusal still required */ } };
    const stop = reason => {
      if (failure || closed || settled) return;
      failure = reason; chunks.length = 0;
      signal("SIGTERM");
      terminateTimer = setTimeout(() => {
        signal("SIGKILL");
        closeTimer = setTimeout(() => finish(error("SYNC_WORKER_READ_CHILD_UNCONFIRMED", "native worker read child close unconfirmed")), forceSettleMs);
      }, terminateGraceMs);
    };
    child.stdout.on("data", chunk => {
      if (failure) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) stop(error("SYNC_WORKER_READ_IPC_LIMIT", "native worker read response limit"));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => stop(error("SYNC_WORKER_READ_INPUT_FAILED", "native worker read input failed")));
    child.on("error", () => stop(error("SYNC_WORKER_READ_SPAWN_FAILED", "native worker read spawn failed")));
    child.once("close", (code, signalName) => {
      closed = true; unconfirmedChildren.delete(child); shutdownController.unregister(child);
      if (shutdownController.requested) return finish(shutdownController.interruptionError());
      if (failure) return finish(failure);
      if (code !== 0 || signalName) return finish(error("SYNC_WORKER_READ_FAILED", "native worker read child failed"));
      try { finish(null, validateResponse(decode(Buffer.concat(chunks), MAX_RESPONSE_BYTES), request)); }
      catch { finish(error("SYNC_WORKER_READ_PROTOCOL", "native worker read response invalid")); }
    });
    shutdownController.register(child);
    timeout = setTimeout(() => stop(error("SYNC_WORKER_COMMAND_TIMEOUT", "native worker read timed out")), timeoutMs);
    child.stdin.end(payload);
  });
}
module.exports = { readPostgresWorkerInChild };
