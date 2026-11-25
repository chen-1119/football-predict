'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const fixture = require('./fixtures/reviewed-research.cjs');
const policy = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const { decodeRequest, createResearchWriteService } = require('../server/researchWriteService.cjs');
const helperFile = require.resolve('../src/services/researchEvidenceArchiveClient.ts');
const componentFile = require.resolve('../src/components/ResearchEvidenceArchive.tsx');
const pack = () => fixture.setup().packets[0];
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function compile(filename, imports = () => { throw Error('unexpected import'); }, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require: imports, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, AbortController, Date, Error, setTimeout, clearTimeout, atob, btoa, ...extra });
  return module.exports;
}
const api = compile(helperFile);
const prepare = async (packet = pack()) => { const raw = bytes(packet); return api.prepareEvidenceUpload(raw, policy.sha(raw)); };
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }
function harness(prepared, options = {}) {
  const calls = [], saved = options.storage || storage();
  const committed = { ok: true, state: 'committed-readback-verified', key: prepared.key, payloadSha256: prepared.payloadSha256, contentHash: prepared.contentHash,
    verified: true, archiveOnly: true, commitAcknowledged: true, published: false, retryWriteAutomatically: false,
    archivedAt: fixture.stamp(fixture.NOW + 1), observedAt: fixture.stamp(fixture.NOW + 2) };
  const profile = { ok: true, user: { id: 'operator-1', role: 'operator', status: 'active' }, csrfToken: 'c'.repeat(43), sessionExpiresAt: fixture.stamp(fixture.NOW + 60000) };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (options.wait) await options.wait(url, init);
    let response = url === '/api/account/me' ? { ...profile, ...options.profile } : { ...committed, ...(url.endsWith('/evidence') ? { submitted: true, ...options.archive } : options.read) };
    if (options.respond) response = await options.respond(url, init, response);
    return { ok: options.httpOk !== false, text: async () => typeof response === 'string' ? response : JSON.stringify(response) };
  };
  return { calls, saved, committed, profile, client: api.createEvidenceArchiveClient({ fetcher, storage: saved, now: () => fixture.NOW + 10000 }) };
}

test('packet and exact archive request validate file, payload, content and raw hashes with normal decoder', async () => {
  const packet = pack(), prepared = await prepare(packet);
  assert.equal(prepared.contentHash, packet.contentHash);
  assert.equal(prepared.payloadSha256, policy.sha(JSON.stringify(packet)));
  assert.equal(prepared.requestSha256, policy.sha(prepared.archiveBody));
  assert.equal(decodeRequest(bytes(prepared.archiveBody)).action, 'evidence-archive');
  assert.equal(decodeRequest(bytes(prepared.readBody)).action, 'evidence-read');
  const request = bytes(JSON.stringify(JSON.parse(prepared.archiveBody), null, 2));
  const result = await api.prepareEvidenceUpload(request, policy.sha(request));
  assert.equal(result.archiveBody, request.toString());
  assert.equal(result.payloadSha256, prepared.payloadSha256);
  assert.equal(Object.isFrozen(result), true);
});

test('pretty packet is preserved as input, with a separately identified canonical request', async () => {
  const packet = pack(), raw = bytes(JSON.stringify(packet, null, 2)), result = await api.prepareEvidenceUpload(raw, policy.sha(raw));
  assert.equal(result.fileSha256, policy.sha(raw));
  assert.equal(result.payloadSha256, policy.sha(JSON.stringify(packet)));
  assert.equal(JSON.parse(result.archiveBody).json, JSON.stringify(packet));
});

for (const [label, change] of [
  ['wrong version', value => value.version = 'reviewed-analysis-publication-v1'],
  ['wrong content hash', value => value.contentHash = '0'.repeat(64)],
  ['formal eligibility', value => { value.formalEligible = true; value.contentHash = policy.hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentHash'))); }],
  ['changed raw bytes despite resealed packet', value => { value.sources[0].rawBase64 = Buffer.from('changed').toString('base64'); value.contentHash = policy.hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentHash'))); }],
  ['non-finite JSON number', value => value.nonFinite = Infinity],
]) test('local file validation rejects ' + label, async () => { const value = pack(); change(value); await assert.rejects(prepare(value)); });

test('wrong external hash, bad UTF8 and oversized files are rejected before network', async () => {
  await assert.rejects(api.prepareEvidenceUpload(bytes(pack()), '0'.repeat(64)), /SHA-256/);
  const invalid = Buffer.from([0xc3, 0x28]); await assert.rejects(api.prepareEvidenceUpload(invalid, policy.sha(invalid)));
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(pack())]); await assert.rejects(api.prepareEvidenceUpload(bom, policy.sha(bom)), /无损 UTF-8/);
  await assert.rejects(api.prepareEvidenceUpload(Buffer.alloc(api.EVIDENCE_REQUEST_LIMIT + 1), '0'.repeat(64)), /1 MiB/);
});

for (const action of ['publish', 'publication-retry', 'archive', 'evidence-read']) test('uploaded request cannot invoke ' + action, async () => {
  const prepared = await prepare(), request = JSON.parse(prepared.archiveBody); request.action = action;
  await assert.rejects(api.prepareEvidenceUpload(bytes(request), policy.sha(bytes(request))), /evidence-archive/);
});

test('extra request fields, wrong payload hash and noncanonical inner JSON are rejected', async () => {
  const prepared = await prepare(), base = JSON.parse(prepared.archiveBody);
  for (const value of [{ ...base, actor: 'root' }, { ...base, sha256: '0'.repeat(64) }, { ...base, json: JSON.stringify(JSON.parse(base.json), null, 2), sha256: policy.sha(JSON.stringify(JSON.parse(base.json), null, 2)) }]) {
    await assert.rejects(api.prepareEvidenceUpload(bytes(value), policy.sha(bytes(value))));
  }
});

test('envelope growth cannot exceed the same one MiB broker bound', async () => {
  let packet = pack(); const { contentHash, ...body } = packet; void contentHash;
  packet = policy.seal({ ...body, extra: '"'.repeat(470000) });
  const raw = bytes(packet); assert.ok(raw.length < api.EVIDENCE_REQUEST_LIMIT);
  await assert.rejects(api.prepareEvidenceUpload(raw, policy.sha(raw)), /封装后/);
});

test('normal session, same-origin POST and independent read are required before success', async () => {
  const prepared = await prepare(), value = harness(prepared);
  const result = await value.client.archive(prepared, 'operator-1');
  assert.equal(result.state, 'committed-readback-verified');
  assert.deepEqual(value.calls.map(call => call.url), ['/api/account/me', '/api/operator/research/evidence', '/api/account/me', '/api/operator/research/evidence-read']);
  for (const call of value.calls) {
    assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.mode, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers.Cookie, undefined);
    if (call.init.method === 'POST') assert.equal(call.init.headers['x-csrf-token'], 'c'.repeat(43));
  }
  assert.equal(value.calls[1].init.body, prepared.archiveBody);
  assert.equal(value.calls[3].init.body, prepared.readBody);
  assert.equal(value.client.canArchive(prepared, 'operator-1'), false);
  assert.equal([...value.saved.values.values()].join(''), 'read-only-after-attempt');
});

for (const [label, profile] of [
  ['anonymous', { user: null }], ['regular user', { user: { id: 'operator-1', role: 'user', status: 'active' } }],
  ['blocked', { user: { id: 'operator-1', role: 'operator', status: 'blocked' } }],
  ['different actor', { user: { id: 'other', role: 'admin', status: 'active' } }],
  ['expired session', { sessionExpiresAt: fixture.stamp(fixture.NOW) }], ['missing CSRF', { csrfToken: '' }],
]) test(label + ' cannot POST an archive or read via this operator client', async () => {
  const prepared = await prepare(), value = harness(prepared, { profile });
  await assert.rejects(value.client.archive(prepared, 'operator-1'));
  await assert.rejects(value.client.read(prepared, 'operator-1'));
  assert.equal(value.calls.some(call => call.init.method === 'POST'), false);
});

for (const [label, patch] of [
  ['HTTP200 error', { ok: false }], ['wrong key', { key: 'team-evidence-' + '0'.repeat(64) }],
  ['wrong payload', { payloadSha256: '0'.repeat(64) }], ['wrong content', { contentHash: '0'.repeat(64) }],
  ['fake ACK', { commitAcknowledged: false }], ['missing verification', { verified: false }],
  ['claim published', { published: true }], ['not archive only', { archiveOnly: false }],
  ['allows automatic retry', { retryWriteAutomatically: true }], ['future observation', { observedAt: fixture.stamp(fixture.NOW + 60000) }],
  ['reverse clocks', { archivedAt: fixture.stamp(fixture.NOW + 5) }], ['missing submitted', { submitted: undefined }],
]) test(label + ' blocks success and a second write, leaving only readback', async () => {
  const prepared = await prepare(), value = harness(prepared, { archive: patch });
  await assert.rejects(value.client.archive(prepared, 'operator-1'));
  assert.equal(value.client.canArchive(prepared, 'operator-1'), false);
  await assert.rejects(value.client.archive(prepared, 'operator-1'));
  assert.equal(value.calls.filter(call => call.url.endsWith('/evidence')).length, 1);
  assert.equal((await value.client.read(prepared, 'operator-1')).state, 'committed-readback-verified');
});

test('double click is synchronously latched before the first session request resolves', async () => {
  const prepared = await prepare(); let unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const value = harness(prepared, { wait: () => waiting });
  const first = value.client.archive(prepared, 'operator-1');
  await assert.rejects(value.client.archive(prepared, 'operator-1'), /正在进行/);
  unblock(); await first;
  assert.equal(value.calls.filter(call => call.url.endsWith('/evidence')).length, 1);
});

test('lost response, abort and reload retain read-only state without retrying the mutation', async () => {
  const prepared = await prepare(), saved = storage(), controller = new AbortController();
  const value = harness(prepared, { storage: saved, respond(url, init, response) { if (url.endsWith('/evidence')) { controller.abort(); throw Error('lost response'); } return response; } });
  await assert.rejects(value.client.archive(prepared, 'operator-1', controller.signal));
  const reload = harness(prepared, { storage: saved });
  await assert.rejects(reload.client.archive(prepared, 'operator-1'), /仅允许独立读回/);
  assert.equal(reload.calls.length, 0);
  assert.equal((await reload.client.read(prepared, 'operator-1')).state, 'committed-readback-verified');
  assert.equal(reload.calls.some(call => call.url.endsWith('/evidence')), false);
  const marker = [...saved.values.keys()][0];
  assert.ok(marker.includes('operator-1.' + prepared.key + '.' + prepared.payloadSha256));
  assert.equal(marker.includes(prepared.archiveBody), false);
});

test('HTTP failure and malformed HTTP200 leave only readback, without automatic retries', async () => {
  const prepared = await prepare();
  for (const response of ['not json', '{}']) {
    const value = harness(prepared, { respond: (url, init, original) => url.endsWith('/evidence') ? response : original });
    await assert.rejects(value.client.archive(prepared, 'operator-1'));
    await assert.rejects(value.client.archive(prepared, 'operator-1'));
    assert.equal(value.calls.filter(call => call.url.endsWith('/evidence')).length, 1);
  }
  const saved = storage(); let posts = 0;
  const value = api.createEvidenceArchiveClient({ storage: saved, now: () => fixture.NOW + 10000, fetcher: async (url, init) => {
    if (init.method === 'POST') { posts++; return { ok: false }; }
    return { ok: true, text: async () => JSON.stringify({ ok: true, user: { id: 'operator-1', role: 'admin', status: 'active' }, csrfToken: 'c'.repeat(43), sessionExpiresAt: fixture.stamp(fixture.NOW + 60000) }) };
  } });
  await assert.rejects(value.archive(prepared, 'operator-1')); await assert.rejects(value.archive(prepared, 'operator-1'));
  assert.equal(posts, 1);
});

test('same-tab independent clients recheck the durable latch after asynchronous session reads', async () => {
  const prepared = await prepare(), saved = storage(); let unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const first = harness(prepared, { storage: saved, wait: () => waiting }), second = harness(prepared, { storage: saved, wait: () => waiting });
  const results = Promise.allSettled([first.client.archive(prepared, 'operator-1'), second.client.archive(prepared, 'operator-1')]);
  unblock(); const outcomes = await results;
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal([...first.calls, ...second.calls].filter(call => call.url.endsWith('/evidence')).length, 1);
});

test('abort before dispatch never sends a mutation', async () => {
  const prepared = await prepare(), value = harness(prepared), controller = new AbortController(); controller.abort();
  await assert.rejects(value.client.archive(prepared, 'operator-1', controller.signal));
  assert.equal(value.calls.length, 0); assert.equal(value.client.canArchive(prepared, 'operator-1'), true);
});

test('disabled storage fails closed for writes but permits independent reads', async () => {
  const prepared = await prepare(), value = harness(prepared, { storage: { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); } } });
  await assert.rejects(value.client.archive(prepared, 'operator-1')); assert.equal(value.calls.length, 0);
  assert.equal((await value.client.read(prepared, 'operator-1')).state, 'committed-readback-verified');
});

test('independent read must match ACK and cannot silently reclassify success as absent', async () => {
  const prepared = await prepare();
  for (const read of [{ payloadSha256: '0'.repeat(64) }, { archivedAt: fixture.stamp(fixture.NOW + 2) }, { observedAt: fixture.stamp(fixture.NOW + 1) }, { state: 'not-observed', verified: false, commitAcknowledged: undefined, payloadSha256: undefined, contentHash: undefined }]) {
    const value = harness(prepared, { read }); await assert.rejects(value.client.archive(prepared, 'operator-1')); assert.equal(value.client.canArchive(prepared, 'operator-1'), false);
  }
});

test('not-observed is an explicit non-success and never triggers a write', async () => {
  const prepared = await prepare(), value = harness(prepared, { read: { state: 'not-observed', verified: false, commitAcknowledged: undefined, payloadSha256: undefined, contentHash: undefined } });
  assert.equal((await value.client.read(prepared, 'operator-1')).state, 'not-observed');
  assert.equal(value.calls.some(call => call.url.endsWith('/evidence')), false);
});

test('actual write service and separate transactions feed the client readback; no publication action', async () => {
  const prepared = await prepare(); let committed = new Map(), pending, clock = fixture.NOW, inserts = 0, reads = 0;
  const pool = { async connect() { return { release() {}, async query(sql, params = []) {
    if (sql.startsWith('BEGIN')) { pending = new Map(committed); if (sql.includes('READ ONLY')) reads++; return { rows: [] }; }
    if (sql === 'COMMIT') { committed = pending; pending = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
    if (sql.startsWith('SET ') || sql.includes('pg_advisory')) return { rows: [] };
    if (sql.includes('clock_timestamp')) return { rows: [{ now: fixture.stamp(++clock) }] };
    if (sql.startsWith('INSERT')) { const [artifact_key, artifact_version, generated_at, updated_at, payload_json, payload_sha256, payload_bytes] = params;
      assert.equal(pending.has(artifact_key), false); inserts++; pending.set(artifact_key, { artifact_key, artifact_version, generated_at, updated_at, payload_json, payload_sha256, payload_bytes }); return { rows: [] }; }
    const row = (pending || committed).get(params[0]);
    if (sql.includes('octet_length')) return { rows: row ? [{ payload_bytes: row.payload_bytes, actual_bytes: Buffer.byteLength(row.payload_json) }] : [] };
    if (sql.startsWith('SELECT')) return { rows: row ? [structuredClone(row)] : [] };
    throw Error('unexpected SQL');
  } }; } };
  const service = createResearchWriteService({ pool, runExclusive: action => action() });
  const value = harness(prepared, { async respond(url, init, response) { return url === '/api/account/me' ? response : { ok: true, ...await service.execute(Buffer.from(init.body)) }; } });
  assert.equal((await value.client.archive(prepared, 'operator-1')).state, 'committed-readback-verified');
  assert.equal(inserts, 1); assert.ok(reads >= 3); assert.equal(committed.get(prepared.key).payload_sha256, prepared.payloadSha256);
});

const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
const words = node => Array.isArray(node) ? node.map(words).join('') : node && typeof node === 'object' ? words(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node);
function mount(client) {
  const states = [], refs = [], effects = [], scheduled = []; let stateIndex, refIndex, effectIndex, tree;
  const react = { useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] || (refs[index] = { current: initial }); },
    useEffect(callback, deps) { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, offset) => value !== previous.deps[offset])) { effects[index] = { deps }; scheduled.push(callback); } } };
  const loaded = compile(componentFile, name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/researchEvidenceArchiveClient')) return { ...api, createEvidenceArchiveClient: () => client };
    throw Error(name);
  });
  function render() { stateIndex = refIndex = effectIndex = 0; tree = loaded.ResearchEvidenceArchive({ userId: 'operator-1' }); while (scheduled.length) scheduled.shift()(); return tree; }
  const find = predicate => flatten(tree).find(predicate), field = id => find(node => node.props?.id === id);
  render(); render();
  return { render, find, field, text: () => words(tree), async select(prepared) {
    const raw = bytes(pack()); field('research-evidence-file').props.onChange({ target: { files: [{ size: raw.length, arrayBuffer: async () => raw }] } }); render();
    field('research-evidence-hash').props.onChange({ target: { value: prepared.fileSha256 } }); render();
    await find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render();
  } };
}

test('actual card demands file hash and explicit archive-only confirmation, latches double clicks', async () => {
  const prepared = await prepare(), value = harness(prepared), view = mount(value.client); await view.select(prepared);
  const button = () => view.find(node => node.type === 'button' && words(node) === '仅归档，不发布');
  assert.equal(button().props.disabled, true); assert.match(view.text(), /不是发布/);
  view.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); view.render();
  button().props.onClick(); button().props.onClick();
  await new Promise(resolve => setTimeout(resolve, 20)); view.render();
  assert.equal(value.calls.filter(call => call.url.endsWith('/evidence')).length, 1);
  assert.equal(button().props.disabled, true); assert.match(view.text(), /仅证据归档已独立读回验证；不是推荐发布/);
});

test('card keeps unknown results distinct and offers only independent readback', async () => {
  const prepared = await prepare(), value = harness(prepared, { archive: { commitAcknowledged: false } }), view = mount(value.client); await view.select(prepared);
  view.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); view.render();
  view.find(node => node.type === 'button' && words(node) === '仅归档，不发布').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 20)); view.render();
  assert.match(view.text(), /提交确认不符/); assert.doesNotMatch(view.text(), /仅证据归档已独立读回验证/);
  assert.equal(view.find(node => node.type === 'button' && words(node) === '仅归档，不发布').props.disabled, true);
  assert.equal(view.find(node => node.type === 'button' && words(node) === '独立读回（不写入）').props.disabled, false);
  await view.select(prepared);
  assert.equal(view.find(node => node.type === 'button' && words(node) === '仅归档，不发布').props.disabled, true);
  assert.equal(value.calls.filter(call => call.url.endsWith('/evidence')).length, 1);
});

test('card stop-waiting aborts the request but keeps the already attempted archive read-only', async () => {
  const prepared = await prepare(), value = harness(prepared, { wait(url, init) {
    if (url.endsWith('/evidence')) return new Promise((resolve, reject) => { void resolve; init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
  } }), view = mount(value.client); await view.select(prepared);
  view.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); view.render();
  view.find(node => node.type === 'button' && words(node) === '仅归档，不发布').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); view.render();
  view.find(node => node.type === 'button' && words(node) === '停止等待').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); view.render();
  assert.equal(view.find(node => node.type === 'button' && words(node) === '仅归档，不发布').props.disabled, true);
  assert.equal(view.find(node => node.type === 'button' && words(node) === '独立读回（不写入）').props.disabled, false);
  assert.doesNotMatch(view.text(), /仅证据归档已独立读回验证/);
});
