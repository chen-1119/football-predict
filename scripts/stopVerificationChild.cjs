"use strict";

// Only for ChildProcess objects owned by a verifier, never a PID or service.
// Wait for close (including stdio), cancel losing timers, and do not let a
// successful kill() call stand in for observed process completion.
function stopVerificationChild(child, { graceMs = 3000, killWaitMs = 3000 } = {}) {
  for (const value of [graceMs, killWaitMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 30000) throw new Error("invalid verifier shutdown deadline");
  }
  if (!child) return Promise.resolve({ closed: true, forced: false });
  if (typeof child.once !== "function" || typeof child.kill !== "function") throw new Error("owned ChildProcess required");
  const exited = () => child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
  const pipesClosed = () => (child.stdio || [child.stdout, child.stderr])
    .filter(Boolean).every(stream => stream.closed === true || stream.destroyed === true);
  if (exited() && pipesClosed()) return Promise.resolve({ closed: true, forced: false });
  return new Promise((resolve, reject) => {
    let graceTimer, deadlineTimer, done = false, forced = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      if (error) reject(error); else resolve({ closed: true, forced });
    };
    const onClose = () => finish();
    // A spawn/kill error is not proof of termination; the close event or the
    // bounded failure below must still be observed before fixture removal.
    const onError = () => {};
    const signal = name => { try { child.kill(name); } catch { /* observe close or fail */ } };
    child.once("close", onClose);
    child.on("error", onError);
    graceTimer = setTimeout(() => {
      if (!exited()) { forced = true; signal("SIGKILL"); }
    }, graceMs);
    deadlineTimer = setTimeout(() => {
      const error = new Error("verifier child did not close; fixture must be retained");
      error.code = "VERIFIER_CHILD_NOT_CLOSED";
      finish(error);
    }, graceMs + killWaitMs);
    if (!exited()) signal("SIGTERM");
  });
}

module.exports = { stopVerificationChild };
