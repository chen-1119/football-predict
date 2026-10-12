'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const reader = require('../scripts/readRecommendationResultHeads.cjs');
const seal = body => ({ ...body, contentHash: hash(body) });
const reseal = value => { const { contentHash, ...body } = value; return seal(body); };
function fixture() {
  const targets = Array.from({ length: 7 }, (_, i) => ({ sourceMatchId: String(2041805 + i),
    eventVersion: i ? '2026-10-05T18:45:00.000Z' : '2026-10-05T16:00:00.000Z',
    homeTeamId: `h${i}`, awayTeamId: `a${i}`, decisionId: `decision-${i}`, decisionRecordHash: String(i + 1).repeat(64) }));
  const archive = seal({ version: 'strategy-version-comparison-v1', kind: 'original-archive', productionWrites: 0,
    sourceSha256: 'a'.repeat(64), rows: targets.map(({ decisionRecordHash, ...r }) => ({ ...r, recordHash: decisionRecordHash })) });
  const publicArchive = seal({ version: 'public-strategy-reference-comparison-v1', kind: 'public-reference-archive',
    scope: 'reference-only', productionWrites: 0, formalEligible: false, formalHitRateEligible: false,
    sourceSha256: 'b'.repeat(64), rows: [] });
  const shadow = seal({ version: 'strategy-version-comparison-v1', kind: 'shadow-experiment', productionWrites: 0,
    formalHitRateEligible: false, generatedAt: '2026-10-05T15:00:00.000Z', sourceObservedAt: '2026-10-05T14:53:23.123456Z',
    sourceSha256: archive.sourceSha256, archiveContentHash: archive.contentHash,
    publicReferenceArchiveContentHash: publicArchive.contentHash, rows: targets });
  return { targets, shadow, archive, publicArchive };
}
function directoryFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-result-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture();
  fs.writeFileSync(path.join(dir, 'shadow-manifest.json'), JSON.stringify(f.shadow));
  fs.writeFileSync(path.join(dir, 'original-archive-manifest.json'), JSON.stringify(f.archive));
  fs.writeFileSync(path.join(dir, 'public-reference-archive-manifest.json'), JSON.stringify(f.publicArchive));
  return { dir, ...f };
}
const response = (heads = []) => Buffer.from(JSON.stringify({ version: reader.VERSION,
  observedAt: '2026-10-05T18:00:00.123456+00:00', readOnly: 'on', productionWrites: 0,
  currentResultHeads: heads, generation: { data_generation_id: 'live-generation', manifest_hash: 'c'.repeat(64) } }) + '\n');

test('strict CLI accepts exactly the two required options', () => {
  assert.deepEqual(reader.parseArgs(['--experiment', 'frozen', '--output', 'new.json']), { experiment: 'frozen', output: 'new.json' });
  for (const args of [[], ['--experiment', 'x'], ['--output', 'x', '--experiment', 'x', '--output', 'y'],
    ['--experiment', 'x', '--output', 'x', '--host', 'evil'], ['--experiment', '--output', 'x']])
    assert.throws(() => reader.parseArgs(args), /RESULT_READER_ARGUMENTS/);
});
test('valid linked manifests scope exactly seven immutable event keys and retain byte hashes', t => {
  const f = directoryFixture(t), loaded = reader.loadExperiment(f.dir);
  assert.equal(loaded.targets.length, 7);
  assert.equal(loaded.binding.shadowContentHash, f.shadow.contentHash);
  assert.match(loaded.binding.manifestByteHashes.shadow, /^[a-f0-9]{64}$/);
});
test('corrupt or re-sealed mismatched manifest and decision bindings fail before transport', t => {
  const f = directoryFixture(t);
  f.shadow.rows[0].sourceMatchId = '999';
  assert.throws(() => reader.validateExperiment(f.shadow, f.archive, f.publicArchive), /MANIFEST_HASH_INVALID/);
  assert.throws(() => reader.validateExperiment(reseal(f.shadow), f.archive, f.publicArchive), /ARCHIVE_EVENT_OUTSIDE/);
  const fresh = fixture();
  fresh.shadow.archiveContentHash = 'f'.repeat(64);
  assert.throws(() => reader.validateExperiment(reseal(fresh.shadow), fresh.archive, fresh.publicArchive), /BINDING_INVALID/);
  fresh.shadow.archiveContentHash = fresh.archive.contentHash;
  fresh.shadow.rows[0].decisionRecordHash = 'f'.repeat(64);
  assert.throws(() => reader.validateExperiment(reseal(fresh.shadow), fresh.archive, fresh.publicArchive), /FINAL_DECISION_BINDING_INVALID/);
  fs.writeFileSync(path.join(f.dir, 'shadow-manifest.json'), JSON.stringify(f.shadow));
  assert.throws(() => reader.readResultHeads({ experiment: f.dir, output: path.join(f.dir, 'out.json') },
    { execute() { assert.fail('must not run SSH'); } }), /MANIFEST_HASH_INVALID/);
});
test('source ID and clock SQL injection, impossible days, rounding and duplicate keys are rejected', () => {
  for (const id of ["1'); DROP TABLE football.recommendation_result_heads;--", '-1', '1 OR 1=1', 'sporttery_1', '1\n', '1.0']) {
    const { targets } = fixture(); targets[0].sourceMatchId = id;
    assert.throws(() => reader.buildResultQuery(targets), /INVALID_SOURCE_ID/);
  }
  for (const event of ["2026-10-05T16:00:00Z'); SELECT pg_sleep(10);--", '2026-02-30T16:00:00Z',
    '2026-10-05T16:00:00', '2026-10-05T16:00:00.000000001Z']) {
    const { targets } = fixture(); targets[0].eventVersion = event;
    assert.throws(() => reader.buildResultQuery(targets), /INVALID_CLOCK|EVENT_PRECISION_UNSUPPORTED/);
  }
  const { targets } = fixture(); targets[1] = { ...targets[0], eventVersion: '2026-10-06T00:00:00+08:00' };
  assert.throws(() => reader.buildResultQuery(targets), /DUPLICATE_EVENT/);
  assert.throws(() => reader.buildResultQuery(targets.slice(0, 6)), /EXACT_SEVEN_TARGETS_REQUIRED/);
});
test('remote query is bounded READ ONLY with exact event joins, rollback, and no data calculation', () => {
  const sql = reader.buildResultQuery(fixture().targets);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /statement_timeout='15000'/); assert.match(sql, /lock_timeout='2000'/);
  assert.match(sql, /h\.event_version=t\.event_version/);
  assert.match(sql, /e\.event_version=h\.event_version/);
  assert.match(sql, /clock_timestamp\(\)/); assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COPY|COMMIT|pg_sleep)\b/i);
  assert.equal((sql.match(/::timestamptz/g) || []).length, 7);
});
test('remote helper preserves original PostgreSQL bytes and fixed process options', () => {
  const bytes = response(), writes = [];
  vm.runInNewContext(reader.buildRemoteReader(fixture().targets), {
    require(name) { assert.equal(name, 'node:child_process'); return { execFileSync(file, args, options) {
      assert.equal(file, '/usr/sbin/runuser'); assert.deepEqual(Array.from(args.slice(0, 5)), ['-u', 'postgres', '--', '/usr/bin/psql', '-X']);
      assert.equal(options.timeout, 22000); assert.equal(options.maxBuffer, reader.MAX_RESPONSE_BYTES);
      assert.match(options.input, /READ ONLY/); return bytes;
    } }; },
    process: { stdout: { write: out => writes.push(out) }, stderr: { write() { assert.fail('unexpected error'); } } }
  });
  assert.strictEqual(writes[0], bytes);
  assert.equal(reader.REMOTE_COMMAND, 'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -');
});
test('response validation retains unknown as an empty array and isolates explicit event/time scope', () => {
  const f = fixture(), experiment = { targets: f.targets, generatedAt: f.shadow.generatedAt };
  assert.deepEqual(reader.validateResultResponse(response(), experiment).currentResultHeads, []);
  const head = { sourceMatchId: f.targets[0].sourceMatchId, eventVersion: f.targets[0].eventVersion,
    observedAt: '2026-10-05T18:00:00.123456Z', state: 'FINAL', scoreHome: 2, scoreAway: 1 };
  assert.equal(reader.validateResultResponse(response([head]), experiment).currentResultHeads[0].scoreHome, 2);
  assert.throws(() => reader.validateResultResponse(response([{ ...head, sourceMatchId: '999' }]), experiment), /HEAD_EVENT_OUTSIDE/);
  assert.throws(() => reader.validateResultResponse(response([head, head]), experiment), /HEAD_EVENT_OUTSIDE/);
  assert.throws(() => reader.validateResultResponse(response([{ ...head, observedAt: '2026-10-05T18:00:00.123456001Z' }]), experiment), /HEAD_AFTER_OBSERVATION/);
  const wrong = JSON.parse(response()); wrong.readOnly = 'off';
  assert.throws(() => reader.validateResultResponse(Buffer.from(JSON.stringify(wrong)), experiment), /RESPONSE_CONTRACT_INVALID/);
});
test('pinned transport writes exclusive receipt and original byte hash; second capture refuses overwrite', t => {
  const f = directoryFixture(t), known = path.join(f.dir, 'known_hosts');
  const blob = Buffer.from('synthetic-unit-test-host-key');
  fs.writeFileSync(known, `test.example ssh-ed25519 ${blob.toString('base64')}\n`);
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  const env = { RELEASE_DEPLOY_HOST: 'test.example', RELEASE_DEPLOY_USER: 'ubuntu', RELEASE_DEPLOY_KEY: 'test-key',
    RELEASE_DEPLOY_KNOWN_HOSTS: known, RELEASE_DEPLOY_HOST_KEY_SHA256: fingerprint };
  const bytes = response(), output = path.join(f.dir, 'result.json'); let calls = 0;
  const execute = (file, args, options) => { calls++; assert.equal(file, 'ssh'); assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('BatchMode=yes')); assert.equal(args.at(-1), reader.REMOTE_COMMAND); assert.equal(options.timeout, 45000);
    assert.match(options.input, /runuser/); return bytes; };
  const result = reader.readResultHeads({ experiment: f.dir, output }, { env, execute });
  assert.equal(result.productionWrites, 0); assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(`${output}.remote-response.json`), bytes);
  assert.equal(JSON.parse(fs.readFileSync(output)).transport.remoteResponseSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => reader.readResultHeads({ experiment: f.dir, output }, { env, execute }), /OUTPUT_EXISTS/);
  assert.equal(calls, 1);
});
test('pin mismatch rejects transport and remote failures never echo secret-bearing stderr', t => {
  const f = directoryFixture(t), known = path.join(f.dir, 'known_hosts'), output = path.join(f.dir, 'out.json');
  const blob = Buffer.from('synthetic-host-key');
  fs.writeFileSync(known, `test.example ssh-ed25519 ${blob.toString('base64')}\n`);
  const env = { RELEASE_DEPLOY_HOST: 'test.example', RELEASE_DEPLOY_USER: 'ubuntu', RELEASE_DEPLOY_KEY: 'test-key',
    RELEASE_DEPLOY_KNOWN_HOSTS: known, RELEASE_DEPLOY_HOST_KEY_SHA256: 'SHA256:' + 'a'.repeat(43) };
  assert.throws(() => reader.readResultHeads({ experiment: f.dir, output }, { env, execute() { assert.fail('no unpinned SSH'); } }), /fingerprint does not match/);
  env.RELEASE_DEPLOY_HOST_KEY_SHA256 = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  assert.throws(() => reader.readResultHeads({ experiment: f.dir, output }, { env, execute() { throw new Error('credential-secret'); } }),
    error => error.message === 'RESULT_READER_PINNED_SSH_READ_FAILED');
  assert.equal(fs.existsSync(output), false);
});
