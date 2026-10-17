'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { encodeFastResultPublisherOutput } = require('../scripts/fastResultPublisherProtocol.cjs');
const { createWorkerShutdownController } = require('../scripts/runSyncWorker.cjs');
const root = path.resolve(__dirname, '..'), file = path.join(root, 'scripts/workerFastResultPublisher.cjs');
const nativeRequire = createRequire(file), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publication = { ok: true, skipped: false, phase: 'official-result-fast-published', publishedRows: 1, storage: 'postgres', original: { scoreHome: 2, scoreAway: 1 } };
function fixture({ pid = 12345, spawnError = null } = {}) {
  const child = new EventEmitter(); child.pid = pid; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  const calls = [], module = { exports: {} }, localRequire = name => name === 'node:child_process'
    ? { spawn(...args) { calls.push(args); if (spawnError) throw spawnError; return child; } } : nativeRequire(name);
  localRequire.resolve = nativeRequire.resolve;
  const processView = { execPath: process.execPath, platform: process.platform, env: { ORIGINAL_FIXTURE: 'preserved' }, execArgv: ['--max-old-space-size=128', '--inspect=1234', '--max-semi-space-size=4'] };
  // Compile in the ordinary realm, so the real protocol and owner see the
  // same Array/Error identities as normal CommonJS. Only spawn is replaced.
  new Function('require', 'module', '__dirname', 'process', fs.readFileSync(file, 'utf8'))(localRequire, module, path.dirname(file), processView);
  const owner = createWorkerShutdownController({ terminate: (value, signal) => value.kill(signal), terminateGraceMs: 25 });
  const run = options => module.exports.runWorkerFastResultPublisher({ shutdownController: owner, timeoutMs: 1000, terminateGraceMs: 25, ...options });
  const close = (code = 0, signal = null) => child.emit('close', code, signal);
  const output = value => child.stdout.write(encodeFastResultPublisherOutput(value));
  return { child, calls, owner, run, close, output };
}
test('the fixed original publisher inherits only heap CLI flags and the existing environment', async () => {
  const f = fixture(), work = f.run();
  assert.equal(f.owner.activeCount, 1); assert.equal(f.calls.length, 1);
  const [exe, args, options] = f.calls[0]; assert.equal(exe, process.execPath);
  assert.deepEqual(args, ['--max-old-space-size=128', '--max-semi-space-size=4', path.join(root, 'scripts/publishOfficialResultsFast.cjs')]);
  assert.equal(options.cwd, root); assert.deepEqual(options.env, { ORIGINAL_FIXTURE: 'preserved', FAST_RESULT_PUBLISHER_MACHINE_MODE: '1' });
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  f.output(publication); f.close(); assert.deepEqual(await work, publication); assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('exit and valid output do not release the writer before actual close', async () => {
  const f = fixture(); let settled = false; const work = f.run().then(value => { settled = true; return value; });
  f.output(publication); f.child.emit('exit', 0, null); await sleep(10);
  assert.equal(settled, false); assert.equal(f.owner.activeCount, 1);
  await assert.rejects(f.run(), { code: 'SYNC_WORKER_FAST_PUBLISHER_BUSY' }); assert.equal(f.calls.length, 1);
  f.close(); assert.deepEqual(await work, publication); assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('timeout escalates, stays rejected even after late exit zero, and retains ownership until close', async () => {
  const f = fixture(); let settled = false; const work = f.run({ timeoutMs: 20 }).finally(() => { settled = true; });
  const rejected = assert.rejects(work, { code: 'PUBLISHER_TIMEOUT' }); await sleep(70);
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false); assert.equal(f.owner.activeCount, 1);
  await assert.rejects(f.run(), { code: 'SYNC_WORKER_FAST_PUBLISHER_BUSY' }); f.output(publication); f.close(); await rejected;
  assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('a no-PID spawn error cannot release unconfirmed child close', async () => {
  const f = fixture({ pid: undefined }), error = new Error('spawn failed'), work = f.run(); f.child.pid = undefined;
  f.child.emit('error', error); await assert.rejects(work, value => value === error);
  await assert.rejects(f.run(), { code: 'SYNC_WORKER_FAST_PUBLISHER_BUSY' }); assert.equal(f.owner.activeCount, 1);
  f.close(-2); assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('a synchronous spawn throw has no process owner and does not manufacture a result', async () => {
  const error = new Error('synchronous spawn failure'), f = fixture({ spawnError: error });
  await assert.rejects(f.run(), value => value === error); assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('a live child error terminates and waits for actual close', async () => {
  const f = fixture(), error = new Error('live child failure'), work = f.run(), rejected = assert.rejects(work, value => value === error);
  f.child.emit('error', error); assert.deepEqual(f.child.signals, ['SIGTERM']); assert.equal(f.owner.activeCount, 1);
  f.close(1); await rejected; assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('shutdown before admission never starts the publisher', async () => {
  const f = fixture(); f.owner.requestShutdown(); await assert.rejects(f.run(), { code: 'SYNC_WORKER_INTERRUPTED' }); assert.equal(f.calls.length, 0); f.owner.dispose();
});
test('shutdown during publication remains interrupted even if the child later returns valid output', async () => {
  const f = fixture(), work = f.run(), rejected = assert.rejects(work, { code: 'SYNC_WORKER_INTERRUPTED' });
  f.owner.requestShutdown(); assert.equal(f.owner.activeCount, 1); f.output(publication); f.close(); await rejected;
  assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
for (const stream of ['stdout', 'stderr']) test(`${stream} retains the existing one MiB output bound and actual-close barrier`, async () => {
  const f = fixture(), work = f.run(), rejected = assert.rejects(work, { code: 'PUBLISHER_OUTPUT_LIMIT' });
  f.child[stream].write('x'.repeat(1024 * 1024 + 1)); assert.deepEqual(f.child.signals, ['SIGTERM']); assert.equal(f.owner.activeCount, 1);
  f.close(0); await rejected; f.owner.dispose();
});
for (const value of [null, { ...publication, ok: 'true' }, { ...publication, phase: 'invented' }]) test(`invalid original machine protocol is refused: ${JSON.stringify(value)}`, async () => {
  const f = fixture(), work = f.run(), rejected = assert.rejects(work, { code: 'PUBLISHER_OUTPUT_INVALID' });
  f.child.stdout.write(JSON.stringify(value)); f.close(); await rejected; assert.equal(f.owner.activeCount, 0); f.owner.dispose();
});
test('nonzero child exit cannot be accepted because its stdout looked successful', async () => {
  const f = fixture(), work = f.run(), rejected = assert.rejects(work, { code: 'PUBLISHER_EXIT_FAILED' }); f.output(publication); f.close(1); await rejected; f.owner.dispose();
});
test('skipped and false results stay exact rather than becoming positive publication', async () => {
  for (const value of [{ ...publication, skipped: true, publishedRows: 0, reason: 'trusted-relay-snapshot-unavailable' }, { ...publication, ok: false, publishedRows: 0 }]) {
    const f = fixture(), work = f.run(); f.output(value); f.close(); assert.deepEqual(await work, value); f.owner.dispose();
  }
});
test('the worker caller changes only the old inline publisher body, keeping all other worker bytes', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/runSyncWorker.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('        const result = await require("./workerFastResultPublisher.cjs")'), end = source.indexOf('\n      }\n    );', begin);
  assert(begin > 0 && end > begin);
  // SHA of every other byte from merged cca7e238, with that single callback
  // body replaced by this marker. It works in signed bundles without Git.
  assert.equal(crypto.createHash('sha256').update(source.slice(0, begin) + '<fixed-fast-publisher-body>' + source.slice(end)).digest('hex'), '28f5e75f5891d2ca0f888c1916710bd408a6f5227ab7aa3d4eb8fde114de8a15');
  assert.match(source.slice(begin, end), /timeoutMs: commandTimeoutMs, terminateGraceMs: commandTerminateGraceMs/);
});
