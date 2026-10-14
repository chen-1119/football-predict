'use strict';
const test = require('node:test'), a = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createHash } = require('node:crypto'), { createRequire } = require('node:module');
const client = require('../server/researchBrokerClient.cjs');
const { requestJournalIdentity, replayEnvelope } = require('../scripts/researchReleaseBroker.cjs');
const sha = raw => createHash('sha256').update(raw).digest('hex');
const input = { version: 'research-broker-request-v1', action: 'archive-read', businessDate: '2026-10-14',
  reportKind: 'weekday-2100-full', sha256: 'a'.repeat(64) };
const raw = Buffer.from(JSON.stringify(input)), releaseSha = 'b'.repeat(64);
const key = 'research-report-2026-10-14-weekday-2100-full';
function envelope(change = () => {}) {
  const v = { version: 'research-broker-result-v1', requestSha: sha(raw), releaseSha, finishedAt: new Date().toISOString(),
    code: 0, overflow: false, stdout: JSON.stringify({ ok: true, key, state: 'not-observed', retryWriteAutomatically: false }),
    stderr: '', automaticWriteRetry: false };
  change(v); return Buffer.from(JSON.stringify(v));
}
function socketFixture({ bindingChange = () => {}, processChange = {}, badSocket = false, response = envelope, breakFrame = false } = {}) {
  const filename = require.resolve('../server/researchBrokerClient.cjs'), source = fs.readFileSync(filename), api = Buffer.from('synthetic-api-source');
  const binding = { version: 'research-broker-binding-v1', releaseSha, transport: { version: 'research-unix-socket-v1',
    apiSourceSha: sha(api), clientSourceSha: sha(source), peerSourceSha: 'c'.repeat(64), footballUid: 999, footballGid: 999 } };
  bindingChange(binding);
  const config = '/usr/local/libexec/football-research-broker/runtime-binding.json', base = '/opt/football-predict';
  let connections = 0, transmitted;
  const fileStat = { isFile: () => true, isSymbolicLink: () => false, uid: 0, nlink: 1, mode: 0o444, dev: 1, ino: 2, size: Buffer.byteLength(JSON.stringify(binding)) };
  const fakeFs = {
    constants: fs.constants, lstatSync(p) {
      if (p === config) return fileStat;
      if (p === '/run/football-research-broker/submit.sock') return { isSocket: () => true, isSymbolicLink: () => false, uid: badSocket ? 999 : 0, gid: 999, mode: 0o660 };
      return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 999, mode: p === '/run/football-research-broker' ? 0o750 : 0o755 };
    }, openSync: () => 10, fstatSync: () => fileStat, closeSync() {}, readFileSync(p) {
      if (p === 10) return Buffer.from(JSON.stringify(binding));
      if (p === base + '/server/index.cjs') return api;
      if (p === base + '/server/researchBrokerClient.cjs') return source;
      if (p.startsWith(base + '/.release')) return releaseSha + '\n';
      throw Error('unexpected path');
    },
  };
  const fakeNet = { createConnection(options) {
    connections++; a.deepEqual(Object.keys(options), ['path']); a.equal(options.path, '/run/football-research-broker/submit.sock');
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.end = frame => { transmitted = frame; setImmediate(() => {
      const body = response(), header = Buffer.alloc(4); header.writeUInt32BE(body.length + (breakFrame ? 1 : 0));
      socket.emit('data', header.subarray(0, 2)); socket.emit('data', Buffer.concat([header.subarray(2), body])); socket.emit('end');
    }); };
    setImmediate(() => socket.emit('connect')); return socket;
  } };
  const runtime = { platform: 'linux', getuid: () => 999, getgid: () => 999,
    execPath: '/opt/node-v22.22.1/bin/node', execArgv: [], argv: ['/opt/node-v22.22.1/bin/node', base + '/server/index.cjs'], ...processChange };
  const context = { module: { exports: {} }, Buffer, process: runtime, setTimeout, clearTimeout, Date,
    require(name) { return name === 'node:fs' ? fakeFs : name === 'node:net' ? fakeNet : createRequire(filename)(name); } };
  vm.runInNewContext(source.toString('utf8'), context, { filename });
  return { submit: context.module.exports.submitResearchRequest, connections: () => connections, transmitted: () => transmitted };
}

test('fixed socket adapter frames owned original bytes and preserves not-observed without claiming publication', async () => {
  const f = socketFixture(), r = await f.submit(raw);
  a.equal(r.state, 'not-observed'); a.equal(r.retryWriteAutomatically, false); a.equal(f.connections(), 1);
  a.equal(f.transmitted().readUInt32BE(0), raw.length); a.deepEqual(f.transmitted().subarray(4), raw);
});
for (const [name, options] of [
  ['root caller', { processChange: { getuid: () => 0 } }],
  ['different entry', { processChange: { argv: ['node','/tmp/caller.cjs'] } }],
  ['loader flag', { processChange: { execArgv: ['--require','anything'] } }],
  ['unknown binding', { bindingChange: b => { b.version = 'unknown'; } }],
  ['source drift', { bindingChange: b => { b.transport.apiSourceSha = '0'.repeat(64); } }],
  ['ordinary socket owner', { badSocket: true }],
]) test('fixed socket adapter refuses ' + name + ' before connecting', async () => {
  const f = socketFixture(options); await a.rejects(f.submit(raw)); a.equal(f.connections(), 0);
});
test('truncated response never reports completion or retries the submission', async () => {
  const f = socketFixture({ breakFrame: true });
  await a.rejects(f.submit(raw), { code: 'RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST', retryWriteAutomatically: false }); a.equal(f.connections(), 1);
});
for (const [name, change] of [
  ['different request', r => { r.requestSha = '0'.repeat(64); }],
  ['different release', r => { r.releaseSha = '0'.repeat(64); }],
  ['unknown child result', r => { r.code = null; }],
  ['failed child', r => { r.code = 1; }],
  ['overflow', r => { r.overflow = true; }],
  ['cached old read', r => { r.finishedAt = '2026-10-13T00:00:00.000Z'; }],
  ['wrong report slot', r => { r.stdout = JSON.stringify({ ok: true, key: key + '-other', state: 'not-observed', retryWriteAutomatically: false }); }],
]) test('broker response rejects ' + name, () => {
  a.throws(() => client.decodeBrokerResponse(envelope(change), raw, { releaseSha }, Date.now() - 1000, Date.now() + 1000), { code: 'RESEARCH_BROKER_RESPONSE_UNVERIFIED' });
});
test('fresh exact read journals can observe a later COMMIT while mutation request identities remain stable', () => {
  const first = requestJournalIdentity(raw), second = requestJournalIdentity(raw);
  a.equal(first.requestSha, second.requestSha); a.equal(first.readOnly, true); a.notEqual(first.journalId, second.journalId);
  for (const action of ['archive','publish']) {
    const body = Buffer.from(JSON.stringify({ version: input.version, action }));
    const x = requestJournalIdentity(body), y = requestJournalIdentity(body);
    a.equal(x.readOnly, false); a.equal(x.journalId, y.journalId); a.equal(x.journalId, sha(body));
  }
  a.throws(() => requestJournalIdentity(Buffer.from('{')), { code: 'RESEARCH_REQUEST_JSON' });
  a.throws(() => requestJournalIdentity(Buffer.from(JSON.stringify({ action: 'run-any-program' }))), { code: 'RESEARCH_REQUEST_ACTION' });
});

const originalReport = JSON.stringify({ version: 'cloud-research-report-v1', businessDate: input.businessDate,
  reportKind: input.reportKind, generatedAt: '2026-10-14T02:00:00.000Z', contents: { text: 'Original immutable report' } });
const reportRequest = Buffer.from(JSON.stringify({ ...input, sha256: sha(originalReport) }));
function archivedEnvelope(change = () => {}) {
  const value = { ok: true, key, state: 'report-archived', sha256: sha(originalReport), bytes: Buffer.byteLength(originalReport),
    originalJson: originalReport, generatedAt: '2026-10-14T02:00:00.000Z', receivedAt: '2026-10-14T02:00:01.000Z',
    readbackVerified: true, verificationScope: 'archive-byte-integrity-only', published: false,
    recommendationEligibilityVerified: false, retryWriteAutomatically: false };
  change(value); return envelope(r => { r.requestSha = sha(reportRequest); r.stdout = JSON.stringify(value); });
}
test('report response verifies original JSON bytes and metadata rather than accepting an echoed hash', () => {
  const r = client.decodeBrokerResponse(archivedEnvelope(), reportRequest, { releaseSha }, Date.now() - 1000, Date.now() + 1000);
  a.equal(r.originalJson, originalReport); a.equal(r.published, false);
});
for (const [name, change] of [
  ['altered original bytes', r => { r.originalJson += ' '; }],
  ['wrong size', r => { r.bytes++; }],
  ['missing original', r => { delete r.originalJson; }],
  ['receipt before generation', r => { r.receivedAt = '2026-10-14T01:59:59.000Z'; }],
]) test('report response refuses ' + name, () => {
  a.throws(() => client.decodeBrokerResponse(archivedEnvelope(change), reportRequest, { releaseSha }, Date.now() - 1000, Date.now() + 1000));
});

test('mutation replay preserves the original receipt clock and never launches another write', () => {
  const mutation = Buffer.from(JSON.stringify({ version: input.version, action: 'archive', json: originalReport, sha256: sha(originalReport) }));
  const saved = JSON.parse(archivedEnvelope());
  saved.stdout = JSON.stringify({ ...JSON.parse(saved.stdout), commitAcknowledged: true });
  saved.requestSha = sha(mutation); saved.finishedAt = '2026-10-14T02:00:02.000Z';
  const original = Buffer.from(JSON.stringify(saved) + '\n'), now = new Date().toISOString();
  const replay = replayEnvelope(original, sha(mutation), releaseSha, now);
  a.equal(replay.originalReceiptBase64, original.toString('base64'));
  const verified = client.decodeBrokerResponse(Buffer.from(JSON.stringify(replay)), mutation, { releaseSha }, Date.now()-1000, Date.now()+1000);
  a.equal(verified.replayedReceipt, true); a.equal(verified.originalFinishedAt, saved.finishedAt);
  for (const change of [r => { r.originalReceiptBase64 += ' '; }, r => { r.deliveredAt = saved.finishedAt; },
    r => { r.requestSha = '0'.repeat(64); }, r => { r.automaticWriteRetry = true; }]) {
    const bad = { ...replay }; change(bad);
    a.throws(() => client.decodeBrokerResponse(Buffer.from(JSON.stringify(bad)), mutation, { releaseSha }, Date.now()-1000, Date.now()+1000));
  }
  a.throws(() => client.decodeBrokerResponse(Buffer.from(JSON.stringify({ ...replay, requestSha: sha(reportRequest) })), reportRequest, { releaseSha }, Date.now()-1000, Date.now()+1000));
});
