'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const moduleFile = path.join(__dirname, '../server/selectedJsonObjectFile.cjs');
const reader = require(moduleFile), checks = [];
const read = (filePath, options = {}, module = reader) => module.readSelectedJsonObjectFileWithIndependentHash({ filePath, keys: ['observations'], ...options });
async function main() {
  if (process.argv[2] === '--large-child') {
    const result = await read(process.argv[3]);
    assert.equal(result.evidence.sha256, process.argv[4]); assert.equal(result.bytesRead, result.fileBytes * 2);
    assert.deepEqual(result.value.observations, [{ id: 'same', text: '中😀' }]);
    assert.equal(result.timings.hashThreadExited, true);
    console.log(JSON.stringify({ ok: true, fileBytes: result.fileBytes, maxRssKiB: process.resourceUsage().maxRSS, timings: result.timings })); return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-parallel-hash-')), file = path.join(dir, 'snapshot.json');
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  const write = value => fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  const fakeModule = behavior => {
    let latest, exits = 0;
    class Worker extends EventEmitter {
      constructor(_path, options) {
        super(); latest = this; this.data = options.workerData; this.stdout = new PassThrough(); this.stderr = new PassThrough();
        queueMicrotask(() => behavior(this));
      }
      response() { const { nonce, fd, expectedBytes } = this.data; const b = Buffer.alloc(expectedBytes); fs.readSync(fd, b, 0, b.length, 0);
        return { version: 1, action: 'full-sha256', nonce, bytes: b.length, sha256: sha(b), durationMs: 1 }; }
      finish(code = 0) { if (this.stopped) return; this.stopped = true; exits++; assert.doesNotThrow(() => fs.fstatSync(this.data.fd)); this.emit('exit', code); }
      terminate() { return new Promise(resolve => setTimeout(() => { this.finish(1); resolve(1); }, 15)); }
    }
    const localRequire = spec => spec === 'node:worker_threads' ? { Worker } : require(spec);
    localRequire.resolve = spec => require.resolve(path.resolve(path.dirname(moduleFile), spec));
    const context = { require: localRequire, module: { exports: {} }, Buffer, TextDecoder, performance };
    vm.runInNewContext(fs.readFileSync(moduleFile, 'utf8'), context);
    return { module: context.module.exports, latest: () => latest, exits: () => exits };
  };
  try {
    await check('real owned thread and independent complete digests return exact selected values', async () => {
      write({ skip: [{ nested: [true, null, 3.2] }], observations: [{ id: 'same', text: '中😀' }] });
      const result = await read(file); assert.deepEqual(result.value.observations, [{ id: 'same', text: '中😀' }]);
      assert.equal(result.evidence.sha256, sha(fs.readFileSync(file))); assert.equal(result.bytesRead, result.fileBytes * 2);
      assert.equal(result.timings.fullPasses, 2); assert.equal(result.timings.hashThreadExited, true);
    });
    await check('message alone cannot release rows or descriptor; concurrent owner is rejected until exit', async () => {
      const fake = fakeModule(w => { w.emit('message', JSON.stringify(w.response())); });
      let settled = false; const result = read(file, {}, fake.module).finally(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
      await assert.rejects(read(file, {}, fake.module), { code: 'SELECTED_JSON_HASH_BUSY' });
      fake.latest().finish(); await result; assert.equal(fake.exits(), 1);
      assert.throws(() => fs.fstatSync(fake.latest().data.fd), { code: 'EBADF' });
    });
    for (const kind of ['nonce', 'duplicate', 'missing', 'extra', 'stdout', 'bad-json', 'oversize', 'exit-one', 'error']) {
      await check('owned response refuses ' + kind, async () => {
        const fake = fakeModule(w => {
          const response = w.response();
          if (kind === 'nonce') response.nonce = '0'.repeat(32);
          if (kind === 'extra') response.unexpected = true;
          if (kind !== 'missing') w.emit('message', kind === 'bad-json' ? '{' : kind === 'oversize' ? 'x'.repeat(1025) : JSON.stringify(response));
          if (kind === 'duplicate') w.emit('message', JSON.stringify(response));
          if (kind === 'stdout') w.stdout.write('unexpected');
          if (kind === 'error') w.emit('error', new Error('thread failure'));
          w.finish(kind === 'exit-one' ? 1 : 0);
        });
        await assert.rejects(read(file, {}, fake.module), { code: 'SELECTED_JSON_HASH_PROTOCOL' }); assert.equal(fake.exits(), 1);
      });
    }
    await check('different full digest is refused after actual exit', async () => {
      const fake = fakeModule(w => { const response = w.response(); response.sha256 = '0'.repeat(64); w.emit('message', JSON.stringify(response)); w.finish(); });
      await assert.rejects(read(file, {}, fake.module), { code: 'FILE_HASH_MISMATCH' }); assert.equal(fake.exits(), 1);
    });
    await check('parser refusal terminates and awaits the owned reader before closing its descriptor', async () => {
      write('{"observations":[],"skip":[1,]}'); const fake = fakeModule(() => {});
      await assert.rejects(read(file, {}, fake.module), { code: 'FILE_JSON_INVALID' }); assert.equal(fake.exits(), 1);
      assert.throws(() => fs.fstatSync(fake.latest().data.fd), { code: 'EBADF' });
    });
    await check('same-size replacement is refused even when the thread returned a matching digest', async () => {
      write('{"observations":[]}');
      const fake = fakeModule(w => { w.emit('message', JSON.stringify(w.response())); fs.renameSync(file, file + '.old'); write('{"observations":[]}'); w.finish(); });
      await assert.rejects(read(file, {}, fake.module), { code: 'GENERATION_FILE_CHANGED' });
    });
    await check('UTF8, selected memory, skipped scalar, depth and file bounds remain strict', async () => {
      for (const [value, options, code] of [[Buffer.from([123,34,120,34,58,34,255,34,125]), {}, 'FILE_JSON_INVALID'],
        ['{"observations":["' + 'x'.repeat(110) + '"]}', { maxSelectedChars: 100 }, 'SELECTED_JSON_VALUE_LIMIT'],
        ['{"skip":' + '1'.repeat(4097) + '}', {}, 'SELECTED_JSON_SCALAR_LIMIT'],
        ['{"skip":' + '['.repeat(256) + '0' + ']'.repeat(256) + '}', {}, 'SELECTED_JSON_DEPTH_LIMIT'],
        ['{"observations":[]}', { maxFileBytes: 1 }, 'CANDIDATE_SNAPSHOT_FILE_BOUND']]) {
        write(value); await assert.rejects(read(file, options), { code });
      }
    });
    await check('public sync API cannot forge the private deferred hash capability', async () => {
      write('{"observations":[]}'); assert.throws(() => reader.readSelectedJsonObjectFile({ filePath: file,
        expectedBytes: fs.statSync(file).size, expectedSha256: '0'.repeat(64), keys: ['observations'] }, Symbol('independent full hash')), { code: 'FILE_HASH_MISMATCH' });
    });
    await check('real parse failure leaves no live hash owner for the next valid read', async () => {
      write('{"observations":[],"bad":[1,]}'); await assert.rejects(read(file), { code: 'FILE_JSON_INVALID' });
      write('{"observations":[{"number":-1.25e3,"text":"\\u4e2d"}]}');
      const result = await read(file); assert.deepEqual(result.value.observations, [{ number: -1250, text: '中' }]);
    });
    await check('parallel caller refuses a non-array observation property', async () => {
      write('{"observations":{}}');
      await assert.rejects(require('./readCandidatePublicObservations.cjs').readCandidatePublicObservationsParallel(file), { code: 'CANDIDATE_OBSERVATIONS_INVALID' });
    });
    await check('actual capture holds its native lease through the awaited public read', async () => {
      const source = fs.readFileSync(path.join(__dirname, 'captureCandidateProspectiveDeadline.cjs'), 'utf8');
      assert.equal((source.match(/\.\.\.await publicSnapshotRows\(/g) || []).length, 3);
      const start = source.indexOf('const main = async () =>'), end = source.indexOf('\nif (require.main', start);
      const events = [], context = { nativeReadSession: null, require: name => name.includes('storageMode') ? { readStorageMode: () => ({ postgresOnly: true }) }
        : { openPostgresRuntimeReadSession: async () => ({ close: async () => events.push('close') }) },
      runCaptureMain: async () => { await new Promise(resolve => setImmediate(resolve)); events.push('complete'); } };
      await vm.runInNewContext(source.slice(start, end) + '\nmain();', context); assert.deepEqual(events, ['complete', 'close']);
    });
    await check('complete 820511407-byte same-shape file passes with original 128 MiB parent heap', async () => {
      const fd = fs.openSync(file, 'w'), hash = crypto.createHash('sha256');
      const put = b => { const bytes = Buffer.from(b); fs.writeSync(fd, bytes); hash.update(bytes); };
      try { put('{"skipped":['); const row = JSON.stringify({ id: 42, tags: ['one', true, null], detail: { text: '中😀'.repeat(80), n: -1.25e3 } });
        const chunk = (row + ',').repeat(2048); for (let i = 0; i < 640; i++) put(chunk); put(row + '],"observations":[{"id":"same","text":"中😀"}]}');
      } finally { fs.closeSync(fd); }
      const child = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--large-child', file, hash.digest('hex')],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true });
      assert.equal(child.status, 0, child.stderr || child.stdout); const result = JSON.parse(child.stdout);
      assert.ok(result.fileBytes > 512 * 1024 ** 2); assert.ok(result.maxRssKiB < 320 * 1024); checks.push({ name: 'real large reader result', ...result });
    });
    console.log(JSON.stringify({ ok: true, verifier: 'selected-json-parallel-full-v1', checks, productionWrites: 0 }, null, 2));
  } finally { const resolved = fs.realpathSync(dir); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('football-parallel-hash-')); fs.rmSync(resolved, { recursive: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
