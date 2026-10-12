'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const p = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'), archive = require('../services/recommendation/comboArchive.cjs');
const at = '2030-01-01T10:00:00Z', later = '2030-01-02T10:00:00Z', publication = { generationId: 'g-' + 'a'.repeat(64), committedAt: '2030-01-01T08:00:00Z' };
const filename = path.resolve(__dirname, '../src/services/recommendationCenterView.ts'), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
function view() {
  const records = Array.from({ length: 4 }, (_, i) => ({ eventId: String(100 + i), eventVersion: '2030-01-01T20:00:00Z', businessDate: '2030-01-01', matchNum: '周二00' + (i + 1),
    homeTeamId: 'h' + i, awayTeamId: 'a' + i, homeTeamName: 'Home ' + i, awayTeamName: 'Away ' + i, market: 'HAD', selection: 'h', sp: [1.8, 2, 3.2, 5.2][i], originalSp: 1.8,
    scores: [[2, 0], [2, 1]], confidence: '低', reason: 'Synthetic published evidence', analysisUrl: 'https://example.com/preview', limitations: ['首发未核实'], cutoffAt: '2030-01-01T19:00:00Z', quoteObservedAt: '2030-01-01T08:59:00Z', publicationMethod: 'reviewed-editorial', formalEligible: false, modelProbability: null, modelVersion: null }));
  return p.seal({ version: 'reviewed-analysis-view-v1', businessDate: '2030-01-01', createdAt: '2030-01-01T09:00:00Z', commitObservedAt: '2030-01-01T09:00:01Z', updatedAt: at,
    publicationHash: 'b'.repeat(64), draftHash: 'c'.repeat(64), originalFrozenAt: '2030-01-01T08:59:00Z', records,
    combos: p.combinations(records, 2), threeCombos: p.combinations(records, 3), formalEligible: false });
}
function client() {
  const rows = new Map(), calls = [];
  return { rows, calls, async query(sql, args) {
    calls.push({ sql, args });
    if (sql.startsWith('INSERT INTO')) { const [key, version, clock, json, hash, bytes] = args; assert(!rows.has(key)); rows.set(key, { artifact_key: key, artifact_version: version, generated_at: new Date(clock), updated_at: new Date(clock), payload_json: json, payload_sha256: hash, payload_bytes: bytes }); return { rows: [] }; }
    if (sql.startsWith('SELECT count')) return { rows: [{ total: rows.size }] };
    if (sql.startsWith('SELECT artifact_key FROM')) return { rows: [...rows.keys()].map(artifact_key => ({ artifact_key })) };
    return { rows: rows.has(args[0]) ? [rows.get(args[0])] : [] };
  } };
}
test('committed display archive retains both original combo sizes; it never becomes settlement input', () => {
  const source = view(), before = JSON.stringify(source), value = archive.prepare(source, publication, at);
  assert.equal(value.archive.settlementEligible, false); assert.deepEqual(value.archive.view, source); assert.equal(JSON.stringify(source), before);
  assert.equal(value.archive.view.combos.filter(c => c.legs.length).length, 3);
  assert.equal(value.archive.view.threeCombos.filter(c => c.legs.length).length, 3);
});
test('unchanged combos are stored once despite later view clocks', async () => {
  const c = client(), source = view(); await archive.retain(c, source, publication, at);
  const { contentHash: ignored, ...body } = source; void ignored;
  const again = await archive.retain(c, p.seal({ ...body, updatedAt: '2030-01-01T10:01:00Z' }), publication, '2030-01-01T10:01:00Z');
  assert.equal(again.retained, false); assert.equal(c.rows.size, 1); assert.equal(c.calls.filter(call => call.sql.startsWith('INSERT')).length, 1);
  assert(!c.calls.some(call => /\bUPDATE\b|\bDELETE\b|\bDROP\b/.test(call.sql)));
});
test('next-day read restores exact original combos only for the same frozen records', async () => {
  const c = client(), source = view(); await archive.retain(c, source, publication, at);
  const { contentHash: ignored, ...body } = source; void ignored;
  const history = p.seal({ ...body, updatedAt: later, combos: [], threeCombos: [] });
  const restored = await archive.restore(c, history, later);
  const parsed = m.exports.parseReviewedAnalysisHistory(restored, '2030-01-02', later);
  assert.deepEqual(restored.comboArchive.view.combos, source.combos); assert.equal(parsed.comboArchive.view.threeCombos.filter(c => c.legs.length).length, 3);
  const changed = p.seal({ ...body, updatedAt: later, combos: [], threeCombos: [], records: body.records.map((r, i) => i ? r : { ...r, sp: 2.3 }) });
  assert.equal((await archive.restore(c, changed, later)).comboArchive, undefined);
});
for (const [name, mutate] of [
  ['wrong leg direction', v => { v.combos[0].legs[0].selection = 'a'; }],
  ['changed frozen price', v => { v.threeCombos[0].legs[0].sp = 2.9; }],
  ['incorrect product', v => { v.combos[0].product += 0.01; }],
  ['duplicate event', v => { v.threeCombos[0].legs[2] = v.threeCombos[0].legs[0]; }],
  ['post-cutoff observation', v => { v.records[0].cutoffAt = at; }],
]) test('resealed archive still rejects ' + name, () => {
  const { contentHash: ignored, ...body } = view(); void ignored; mutate(body);
  assert.throws(() => archive.prepare(p.seal(body), publication, at));
});
test('corrupt database bytes and daily archival bounds cannot be hidden as successful history', async () => {
  const c = client(), source = view(); await archive.retain(c, source, publication, at);
  c.rows.values().next().value.payload_sha256 = 'f'.repeat(64);
  await assert.rejects(archive.restore(c, p.seal({ ...source, updatedAt: later, combos: [], threeCombos: [] }), later));
  const bounded = { query: async sql => sql.startsWith('SELECT count') ? { rows: [{ total: 64 }] } : { rows: [] } };
  await assert.rejects(archive.retain(bounded, source, publication, at), /DAILY_BOUND/);
});
