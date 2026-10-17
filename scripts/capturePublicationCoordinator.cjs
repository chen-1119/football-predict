'use strict';

// Coordinate only this worker's two existing capture lanes with its own input
// writers. No kernel locks, deadlines, cadence settings or success records change.
function createCapturePublicationCoordinator({ isInterrupted = () => false,
  interruptionError = () => Object.assign(new Error('worker interrupted'), { code: 'SYNC_WORKER_INTERRUPTED' }),
  onState = () => {} } = {}) {
  const lanes = new Map(), writers = new Map();
  const fail = message => { const error = new Error(message); error.code = 'CAPTURE_PUBLICATION_COORDINATION_INVALID'; throw error; };
  const snapshot = () => Object.freeze({ version: 'capture-publication-coordination-v1',
    inputWriterActive: writers.size > 0, activeWriters: Object.freeze([...writers.values()].map(x => Object.freeze({ ...x }))),
    pausedLanes: Object.freeze([...lanes.values()].filter(x => x.handle.paused).map(x => x.lane)),
    captureSuccessSynthesized: false, deadlineOrCadenceChanged: false });
  const notify = () => { try { onState(snapshot()); } catch { /* Best-effort telemetry grants no admission. */ } };
  const pause = record => {
    if (!record.ownedPause) { record.originalPaused = record.handle.paused === true; record.ownedPause = true; }
    record.handle.pause();
  };
  const attach = (handle, lane) => {
    if (!handle) return;
    if (!['candidate', 'benchmark'].includes(lane) || ['pause', 'resume', 'waitForIdle'].some(key => typeof handle[key] !== 'function'))
      fail('invalid capture lane');
    const existing = lanes.get(handle);
    if (existing) { if (existing.lane !== lane) fail('capture lane identity changed'); return; }
    if (lanes.size >= 2 || [...lanes.values()].some(x => x.lane === lane)) fail('duplicate capture lane');
    const record = { handle, lane, ownedPause: false, originalPaused: false };
    lanes.set(handle, record);
    if (writers.size) pause(record);
    notify();
  };
  const run = async (stage, task, enabled = true) => {
    if (stage !== 'datastore:generation' || typeof task !== 'function' || typeof enabled !== 'boolean' || writers.size >= 16)
      fail('unreviewed or unbounded capture input writer');
    if (!enabled) return await task();
    if (isInterrupted()) throw interruptionError();
    const token = Symbol(), observed = { stage, startedAt: new Date().toISOString() };
    writers.set(token, observed);
    for (const record of lanes.values()) pause(record);
    notify();
    let confirmedIdle = false;
    try {
      // A benchmark lane can attach while the first candidate capture drains.
      // At most the two fixed lanes exist; newly attached lanes are paused too.
      let drained = new Set();
      for (let pass = 0; pass < 2; pass++) {
        const pending = [...lanes.keys()].filter(handle => !drained.has(handle));
        await Promise.all(pending.map(handle => handle.waitForIdle()));
        drained = new Set([...drained, ...pending]);
        if (drained.size === lanes.size) break;
      }
      if ([...lanes.keys()].some(handle => !drained.has(handle) || handle.inFlight === true))
        fail('capture owner has not confirmed idle');
      confirmedIdle = true;
      if (isInterrupted()) throw interruptionError();
      return await task();
    } finally {
      writers.delete(token);
      // Unknown child ownership remains paused and fails closed. A later real
      // idle observation can release our pause; pre-existing pauses stay intact.
      if (!writers.size && confirmedIdle && !isInterrupted()
        && [...lanes.keys()].every(handle => handle.inFlight !== true)) {
        for (const record of lanes.values()) {
          if (record.ownedPause && !record.originalPaused) {
            if (record.lane === 'candidate') record.handle.resume({ recoveryIfStale: true });
            else record.handle.resume();
          }
          record.ownedPause = false;
        }
      }
      notify();
    }
  };
  return Object.freeze({ attach, run, snapshot });
}
module.exports = { createCapturePublicationCoordinator };
