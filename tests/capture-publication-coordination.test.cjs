'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createCapturePublicationCoordinator: create } = require('../scripts/capturePublicationCoordinator.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function heartbeat({ paused = false, pending = null } = {}) {
  const state = { paused, inFlight: !!pending, resumes: [], pauses: 0,
    lastResult: { ok: false, skipped: false, reason: 'retained-original-failure' } };
  const handle = { get paused() { return state.paused; }, get inFlight() { return state.inFlight; },
    get lastResult() { return state.lastResult; }, pause() { state.pauses++; state.paused = true; },
    resume(options) { state.resumes.push(options); state.paused = false; },
    waitForIdle() { return pending ? pending.promise.then(() => { state.inFlight = false; return state.lastResult; }) : Promise.resolve(state.lastResult); } };
  return { handle, state };
}
test('both lanes pause before the actual owned capture drains; publication cannot start early', async () => {
  const closed = deferred(), a = heartbeat({ pending: closed }), b = heartbeat(), coordinator = create();
  coordinator.attach(a.handle, 'candidate'); coordinator.attach(b.handle, 'benchmark'); let writes = 0;
  const result = coordinator.run('datastore:generation', async () => { writes++; assert.equal(a.state.inFlight, false); assert(a.state.paused && b.state.paused); return { original: true }; });
  await turn(); assert.equal(writes, 0); assert(a.state.paused && b.state.paused);
  closed.resolve(); assert.deepEqual(await result, { original: true }); assert.equal(writes, 1);
  assert.deepEqual(a.state.resumes, [{ recoveryIfStale: true }]); assert.deepEqual(b.state.resumes, [undefined]);
});
test('paused publication never manufactures capture success or clears the previous failure', async () => {
  const h = heartbeat(), original = h.handle.lastResult, coordinator = create(); coordinator.attach(h.handle, 'candidate');
  await coordinator.run('datastore:generation', async () => { assert.equal(h.handle.lastResult, original); assert.equal(coordinator.snapshot().captureSuccessSynthesized, false); });
  assert.equal(h.handle.lastResult, original); assert.equal(original.ok, false);
});
test('concurrent own writers retain the pause until the last actual writer exits', async () => {
  const first = deferred(), second = deferred(), h = heartbeat(), coordinator = create(); coordinator.attach(h.handle, 'candidate');
  const a = coordinator.run('datastore:generation', () => first.promise), b = coordinator.run('datastore:generation', () => second.promise);
  await turn(); assert.equal(coordinator.snapshot().activeWriters.length, 2);
  first.resolve('first'); assert.equal(await a, 'first'); assert.equal(h.state.resumes.length, 0);
  second.resolve('second'); assert.equal(await b, 'second'); assert.equal(h.state.resumes.length, 1);
});
test('nested publication preserves its outer pause and original task return', async () => {
  const h = heartbeat(), coordinator = create(); coordinator.attach(h.handle, 'candidate');
  assert.equal(await coordinator.run('datastore:generation', async () => {
    assert.equal(await coordinator.run('datastore:generation', async () => 7), 7);
    assert.equal(h.state.resumes.length, 0); return 9;
  }), 9); assert.equal(h.state.resumes.length, 1);
});
test('actual publication error remains the same error and does not become a skipped success', async () => {
  const h = heartbeat(), coordinator = create(), error = Object.assign(new Error('55P03'), { code: '55P03' }); coordinator.attach(h.handle, 'candidate');
  await assert.rejects(coordinator.run('datastore:generation', async () => { throw error; }), value => value === error);
  assert.equal(h.state.resumes.length, 1); assert.equal(coordinator.snapshot().inputWriterActive, false);
});
test('an existing external pause is never released by the publication coordinator', async () => {
  const a = heartbeat({ paused: true }), b = heartbeat(), coordinator = create(); coordinator.attach(a.handle, 'candidate'); coordinator.attach(b.handle, 'benchmark');
  await coordinator.run('datastore:generation', async () => {}); assert.equal(a.state.resumes.length, 0); assert.equal(a.state.paused, true); assert.equal(b.state.resumes.length, 1);
});
test('a benchmark lane attached while the first capture drains is also paused and drained', async () => {
  const ca = deferred(), cb = deferred(), a = heartbeat({ pending: ca }), b = heartbeat({ pending: cb }), coordinator = create(); coordinator.attach(a.handle, 'candidate'); let writes = 0;
  const work = coordinator.run('datastore:generation', async () => { writes++; }); await turn(); coordinator.attach(b.handle, 'benchmark'); assert.equal(b.state.paused, true);
  ca.resolve(); await turn(); assert.equal(writes, 0); cb.resolve(); await work; assert.equal(writes, 1);
});
test('unconfirmed live capture ownership refuses the writer and retains its pause', async () => {
  const h = heartbeat(), coordinator = create(); h.state.inFlight = true; coordinator.attach(h.handle, 'candidate');
  await assert.rejects(coordinator.run('datastore:generation', async () => assert.fail('writer admitted')), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  assert.equal(h.state.paused, true); assert.equal(h.state.resumes.length, 0);
  h.state.inFlight = false; await coordinator.run('datastore:generation', async () => {}); assert.equal(h.state.resumes.length, 1);
});
test('shutdown before admission does not start or synthesize any task', async () => {
  const error = new Error('original shutdown'), h = heartbeat(), coordinator = create({ isInterrupted: () => true, interruptionError: () => error }); coordinator.attach(h.handle, 'candidate');
  await assert.rejects(coordinator.run('datastore:generation', async () => assert.fail('started')), value => value === error); assert.equal(h.state.pauses, 0);
});
test('shutdown during a real drain keeps both capture timers paused', async () => {
  const closed = deferred(), h = heartbeat({ pending: closed }); let interrupted = false;
  const coordinator = create({ isInterrupted: () => interrupted }); coordinator.attach(h.handle, 'candidate');
  const work = coordinator.run('datastore:generation', async () => assert.fail('started')); await turn(); interrupted = true; closed.resolve();
  await assert.rejects(work, { code: 'SYNC_WORKER_INTERRUPTED' }); assert.equal(h.state.resumes.length, 0); assert.equal(h.state.paused, true);
});
test('disabled original generation remains disabled without touching either timer', async () => {
  const h = heartbeat(), coordinator = create(); coordinator.attach(h.handle, 'candidate');
  const original = { ok: true, skipped: true, reason: 'disabled' };
  assert.equal(await coordinator.run('datastore:generation', async () => original, false), original); assert.equal(h.state.pauses, 0); assert.equal(h.state.resumes.length, 0);
});
test('unknown writers and duplicate or foreign lanes fail before invoking any callback', async () => {
  const h = heartbeat(), coordinator = create(); coordinator.attach(h.handle, 'candidate');
  await assert.rejects(coordinator.run('model:backtest', () => assert.fail('unknown admitted')), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  await assert.rejects(coordinator.run('sync:data', () => assert.fail('unrelated sync stage admitted')), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  await assert.rejects(coordinator.run('unknown', () => assert.fail('unknown disabled admitted'), false), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  assert.throws(() => coordinator.attach(heartbeat().handle, 'candidate'), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  assert.throws(() => coordinator.attach(h.handle, 'benchmark'), { code: 'CAPTURE_PUBLICATION_COORDINATION_INVALID' });
  assert.equal(h.state.pauses, 0);
});
test('telemetry cannot grant authority or alter an original successful task result', async () => {
  const coordinator = create({ onState: () => { throw new Error('telemetry unavailable'); } }), original = Object.freeze({ ok: false, skipped: false });
  assert.equal(await coordinator.run('datastore:generation', async () => original), original);
  assert.equal(coordinator.snapshot().deadlineOrCadenceChanged, false); assert.throws(() => { coordinator.snapshot().activeWriters.push({}); });
});
function actualHeartbeat({ fresh }) {
  const ts = require('typescript'), file = path.join(__dirname, '../scripts/runSyncWorker.cjs'), source = fs.readFileSync(file, 'utf8'), sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = sf.statements.flatMap(x => ts.isVariableStatement(x) ? [...x.declarationList.declarations] : []).find(x => x.name.getText(sf) === 'startCandidateProspectiveDeadlineHeartbeat');
  const normal = [], retry = [], attempts = [], make = target => (callback, ms) => { const value = { callback, ms, active: true, unref() {} }; target.push(value); return value; }, clear = value => { value.active = false; };
  const factory = vm.runInNewContext('(' + declaration.initializer.getText(sf) + ')', {
    candidateDeadlineCaptureEnabled: true, candidateDeadlineCaptureRetryMs: 2000, candidateDeadlineHeartbeatFreshnessLimitMs: 120000, candidateDeadlineCaptureIntervalMs: 60000,
    exactHeartbeatMatches: status => status.fresh === true, candidateImplementationDriftAwaitingRefreeze: () => false,
  });
  const handle = factory({ immediate: false, retryMs: 2000, readStatus: () => ({ fresh, evaluatedAt: '2026-10-17T18:00:00.000Z' }), now: () => Date.parse('2026-10-17T18:05:00Z'),
    scheduleFor: () => ({ dueAt: '2026-10-17T18:06:00Z', delayMs: 60000 }), budgetFor: input => { attempts.push(input); return { timeoutMs: 79000 }; },
    run: async input => { attempts.push(input); return { ok: false, skipped: false, reason: 'original failure retained' }; },
    timer: make(normal), clearTimer: clear, retryTimer: make(retry), clearRetryTimer: clear });
  return { handle, normal, retry, attempts };
}
test('actual stale resume selects the existing bounded retry path without a doomed primary', async () => {
  const fixture = actualHeartbeat({ fresh: false }); fixture.handle.pause(); fixture.handle.resume({ recoveryIfStale: true });
  assert.equal(fixture.normal.filter(x => x.active).length, 0); const retry = fixture.retry.filter(x => x.active); assert.equal(retry.length, 1); assert.equal(retry[0].ms, 2000);
  await retry[0].callback(); assert.equal(fixture.attempts[0].recoveryAttempt, true); assert.equal(fixture.attempts[1].attemptKind, 'preemptive-recovery');
  assert.equal(fixture.attempts[1].timeoutMs, 79000); assert.equal(fixture.handle.lastResult.ok, false); fixture.handle.stop();
});
test('actual fresh resume keeps the original normal schedule and does not create recovery success', async () => {
  const fixture = actualHeartbeat({ fresh: true }); fixture.handle.pause(); fixture.handle.resume({ recoveryIfStale: true });
  assert.equal(fixture.normal.filter(x => x.active).length, 1); assert.equal(fixture.retry.filter(x => x.active).length, 0); assert.equal(fixture.attempts.length, 0); fixture.handle.stop();
});
test('actual original resume defaults and stopped state remain unchanged', async () => {
  const fixture = actualHeartbeat({ fresh: false }); fixture.handle.pause(); fixture.handle.resume(); assert.equal(fixture.normal.filter(x => x.active).length, 1);
  fixture.handle.stop(); fixture.handle.resume({ recoveryIfStale: true }); assert.equal(fixture.retry.filter(x => x.active).length, 0); assert.equal(fixture.handle.paused, true);
});
test('real Node capture close precedes the isolated writer and later readers retain the barrier', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-capture-writer-')), lock = path.join(dir, '.pointer-commit.lock');
  const child = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(0),100)"], { stdio: 'ignore', windowsHide: true });
  const close = deferred(), h = heartbeat({ pending: close }), coordinator = create(); coordinator.attach(h.handle, 'candidate'); let actualClosed = false;
  child.once('error', close.resolve); child.once('close', code => { actualClosed = true; assert.equal(code, 0); close.resolve(); });
  try {
    await coordinator.run('datastore:generation', async () => { assert.equal(actualClosed, true); fs.mkdirSync(lock); assert.equal(h.state.paused, true);
      assert.throws(() => fs.mkdirSync(lock), { code: 'EEXIST' }); fs.rmdirSync(lock); });
    assert.equal(h.state.paused, false); assert.equal(fs.existsSync(lock), false);
  } finally { const resolved = fs.realpathSync(dir); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('football-capture-writer-')); fs.rmSync(resolved, { recursive: true }); }
});
test('actual official-generation caller drains captures and preserves its original artifact lock', async () => {
  const ts = require('typescript'), source = fs.readFileSync(path.join(__dirname, '../scripts/runSyncWorker.cjs'), 'utf8'), sf = ts.createSourceFile('worker.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(sf) === 'runOfficialArtifactGeneration');
  const closed = deferred(), h = heartbeat({ pending: closed }), coordinator = create(); coordinator.attach(h.handle, 'candidate'); let writes = 0, releases = 0;
  const caller = vm.runInNewContext('(' + declaration.initializer.getText(sf) + ')', {
    acquireSyncLock: () => {}, sharedSlowArtifactLockDir: 'original-fixed-lock', captureInputPublicationCoordinator: coordinator,
    acquireSyncLockInterruptibly: async options => { assert.equal(options.lockDir, 'original-fixed-lock'); assert.equal(options.waitMs, 0); return { acquired: true, release: async () => { releases++; } }; },
  });
  const work = caller({ isInterrupted: () => false, task: async () => { writes++; assert.equal(h.state.inFlight, false); return { original: 'generation' }; } });
  await turn(); assert.equal(writes, 0); closed.resolve(); assert.deepEqual(await work, { original: 'generation' }); assert.equal(releases, 1);
});
test('capture budgets, child termination, heap allocation and cadence retain exact audited source', () => {
  const ts = require('typescript'), crypto = require('node:crypto'), source = fs.readFileSync(path.join(__dirname, '../scripts/runSyncWorker.cjs'), 'utf8').replace(/\r\n/g, '\n'), sf = ts.createSourceFile('worker.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // Exact implementations from the merged 804646cc parent; scheduling wrappers
  // cannot silently extend an existing child budget or change a success gate.
  const expected = { runCommand: '8ebfda0eafdc3bf3cbef80c4ad4d19c4fef3f3cf4874607d89b525ec8e471da0',
    candidateDeadlineAttemptBudget: '8c7b3cc47305d0387da6c8d39df211da8ee80d28574d2942c1275fee78b8805d',
    runCandidateProspectiveDeadlineCapture: '1c5e49e35f5aa6da20771806c9b88d402db29e1fc9168d1398cd8c0f6e98cf64',
    runBenchmarkProspectiveDeadlineCapture: '0c95fc993bdae4f030e318b87738444aaa9effa9421833d64ba3e040d7de73fd',
    candidateDeadlinePreemptiveSchedule: '63e807bed86593fb96c9669024d16569328e677b228f4aa989e97a77e63ff255',
    describeSyncCadence: 'f954c6db79a071401f548f76090e62ab0fd782309c0f8d732f17a4ac0f99f13c' };
  const declarations = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : ts.isFunctionDeclaration(n) ? [n] : []);
  for (const [name, hash] of Object.entries(expected)) { const node = declarations.find(n => n.name?.getText(sf) === name); assert(node, name);
    assert.equal(crypto.createHash('sha256').update((node.initializer || node).getText(sf)).digest('hex'), hash, name); }
  assert(source.includes("captureInputPublicationCoordinator.attach(candidateDeadlineHeartbeat, 'candidate')"));
  assert(source.includes("captureInputPublicationCoordinator.attach(benchmarkDeadlineHeartbeat, 'benchmark')"));
  assert.equal((source.match(/captureInputPublicationCoordinator\.run\('datastore:generation'/g) || []).length, 2);
});
