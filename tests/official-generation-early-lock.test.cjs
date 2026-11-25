'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const { createRequire } = require('node:module');
const { after } = require('node:test');
const ts = require('typescript');

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'football-early-writer-test-'));
process.env.SERVER_STORE_DIR = store;
const lockDir = path.join(store, 'locks', 'sync-enrichment-artifacts.lock');
const worker = require('../scripts/runSyncWorker.cjs');
const { acquireSyncLock } = require('../server/syncLock.cjs');
const { createCapturePublicationCoordinator } = require('../scripts/capturePublicationCoordinator.cjs');
const { admitOfficialDataStep } = require('../scripts/officialDataAdmission.cjs');
const candidate = path.resolve(__dirname, '../scripts/runSyncWorker.cjs');
const FullAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const signal = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

after(() => {
  const target = fs.realpathSync(store);
  assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(target), /^football-early-writer-test-[a-zA-Z0-9]+$/);
  fs.rmSync(target, { recursive: true, force: true });
});

// Use the actual official orchestration and the actual official lock helper,
// following the repository's verifySyncWorkerCadence and capture coordination tests.
function pipeline(file, { admission, coordinator = createCapturePublicationCoordinator(), command, interrupted = () => false }) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decl = ast.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
    .find(n => n.name.getText(ast) === 'runOfficialArtifactGeneration');
  const make = new Function('acquireSyncLockInterruptibly', 'acquireSyncLock', 'sharedSlowArtifactLockDir', 'captureInputPublicationCoordinator',
    'return (' + decl.initializer.getText(ast) + ')');
  const official = make(worker.acquireSyncLockInterruptibly, acquireSyncLock, lockDir, coordinator);
  const begin = text.indexOf('await onBeforeHeavyStep("reconcile:fast-results-generation:official")');
  const end = text.indexOf('let officialPhaseFinishedAt', begin);
  assert(begin > 0 && end > begin);
  const execute = new FullAsyncFunction('onBeforeHeavyStep', 'runOptional', 'commandTimeouts', 'runCommand', 'npmCommand', 'storeDir',
    'runtimeProjectionEnabled', 'runRuntimeProjectionOrReuse', 'storageMode', 'runOfficialArtifactGeneration', 'isInterrupted',
    text.slice(begin, end) + 'return sqliteStep;');
  return () => execute(admission, (_enabled, script, env, options) => command(script, options), worker.commandTimeouts,
    (_npm, args, env, options) => command(args[1], options), 'npm', store, true, ({ options }) => command('postgres:sync', options), { postgresOnly: true }, official, interrupted);
}

// Replay the deployed prematch lock call and its unchanged early return.
// All API/queue/quota work follows this block in the real entry point.
const prematchFile = path.resolve(__dirname, '../scripts/syncDailyPrematchApi.cjs');
const prematchText = fs.readFileSync(prematchFile, 'utf8');
const lockStart = prematchText.indexOf('    lock = await require(');
const lockEnd = prematchText.indexOf('    const runId = ', lockStart);
assert(lockStart > 0 && lockEnd > lockStart);
const dispatchPrematch = new FullAsyncFunction('require', 'store', 'path', 'console',
  'let lock;\n' + prematchText.slice(lockStart, lockEnd) + '\nreturn lock;');
function tick(log = []) {
  return dispatchPrematch(createRequire(prematchFile), store, path, { log: row => log.push(JSON.parse(row)) });
}

function capture() {
  const entered = signal(), close = signal();
  let active = true, paused = false;
  return {
    entered, close,
    lane: { get inFlight() { return active; }, get paused() { return paused; },
      pause() { paused = true; }, resume() { paused = false; },
      async waitForIdle() { entered.resolve(); await close.promise; active = false; return { ok: true }; } },
  };
}

function compete(file, lane, ops, coordinator) {
  return pipeline(file, { coordinator,
    admission: step => step === 'datastore:generation:official' ? admitOfficialDataStep(step, lane) : undefined,
    command: (id, options) => {
      ops.push(id);
      const expected = (id === 'reconcile:fast-results-generation' || id === 'validate:data') ? 180000 : 600000;
      assert.equal(options.timeoutMs, expected);
      if (id === 'datastore:generation') {
        assert.equal(lane.inFlight, false);
        assert.equal(lane.paused, true);
      }
      return { ok: true };
    },
  });
}

test('with the r941 ordering a prematch tick can acquire during an already validated official capture drain',
  { skip: !process.env.R941_WORKER_FOR_COMPARISON }, async () => {
    const c = capture(), coord = createCapturePublicationCoordinator(), ops = [];
    coord.attach(c.lane, 'candidate');
    const job = compete(process.env.R941_WORKER_FOR_COMPARISON, c.lane, ops, coord)();
    await c.entered.promise;
    const prematch = await tick();
    assert.equal(prematch.acquired, true);
    try {
      c.close.resolve();
      await assert.rejects(job, { code: 'SYNC_WORKER_SHARED_ARTIFACT_BUSY' });
      assert.deepEqual(ops, ['reconcile:fast-results-generation', 'validate:data']);
    } finally { await prematch.release(); }
  });

test('a late prematch tick follows its actual five-second contention branch, and can work after release', { timeout: 15000 }, async () => {
  const c = capture(), coord = createCapturePublicationCoordinator(), ops = [], output = [];
  coord.attach(c.lane, 'candidate');
  const job = compete(candidate, c.lane, ops, coord)();
  await c.entered.promise;
  try {
    assert.deepEqual(ops, ['reconcile:fast-results-generation', 'validate:data']);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'lock.json')));
    assert.equal(owner.source, 'shared-artifact:official-generation');
    assert.equal(await tick(output), undefined);
    assert.deepEqual(output, [{ state: 'writer-busy-retry-next-tick' }]);
    assert.equal(c.lane.inFlight, true);
  } finally { c.close.resolve(); }
  assert.deepEqual(await job, { ok: true });
  assert.equal(fs.existsSync(lockDir), false);
  assert.deepEqual(ops, ['reconcile:fast-results-generation', 'validate:data', 'datastore:generation', 'postgres:sync']);
  const next = await tick();
  assert.equal(next.info.owner, 'daily-prematch-api');
  await next.release();
});

test('an earlier prematch writer keeps ownership; official work never publishes while it is busy', async () => {
  const earlier = await tick(), ops = [];
  try {
    const job = pipeline(candidate, { admission: () => {}, command: id => { ops.push(id); return { ok: true }; } });
    await assert.rejects(job(), { code: 'SYNC_WORKER_SHARED_ARTIFACT_BUSY' });
    assert.deepEqual(ops, ['reconcile:fast-results-generation', 'validate:data']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'lock.json'))).owner, 'daily-prematch-api');
  } finally { await earlier.release(); }
});

test('validation denial and interrupted admission both preserve the failure and release any owned lock', async () => {
  for (const fatal of ['validate:data', 'datastore:generation:official']) {
    const ops = [];
    const run = name => { ops.push(name); if (name === fatal) throw new Error(fatal); return { ok: true }; };
    await assert.rejects(pipeline(candidate, { admission: run, command: run })(), e => e.message === fatal);
    assert.equal(ops.includes('datastore:generation'), false);
    assert.equal(ops.includes('postgres:sync'), false);
    assert.equal(fs.existsSync(lockDir), false);
  }
});

test('the existing lock logic reclaims the lock only after its actual process exited', async () => {
  const lockModule = require.resolve('../server/syncLock.cjs');
  const program = "require(process.argv[1]).acquireSyncLock({lockDir:process.argv[2], owner:'football-sync-worker', source:'shared-artifact:official-generation', waitMs:0}).then(lock=>{if(!lock.acquired)process.exitCode=1;})";
  const orphan = child.spawnSync(process.execPath, ['-e', program, lockModule, lockDir], { encoding: 'utf8', windowsHide: true });
  assert.equal(orphan.status, 0);
  const held = JSON.parse(fs.readFileSync(path.join(lockDir, 'lock.json')));
  assert.notEqual(held.pid, process.pid);
  const next = await tick();
  assert.equal(next.acquired, true);
  assert.equal(next.info.owner, 'daily-prematch-api');
  await next.release();
});
