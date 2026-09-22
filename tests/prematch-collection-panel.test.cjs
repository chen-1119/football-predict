'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const NOW = Date.parse('2026-09-22T06:00:00.000Z');
const words = n => n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(words).join('') : typeof n === 'object' ? words(n.props?.children) : String(n);
const nodes = (n, p) => n && typeof n === 'object' ? Array.isArray(n) ? n.flatMap(v => nodes(v, p)) : [...(p(n) ? [n] : []), ...nodes(n.props?.children, p)] : [];
const section = (status = 'missing', data = null, provider = null) => ({ status, data, provider, observedAt: data ? '2026-09-22T05:50:00.000Z' : null, lastAttemptAt: '2026-09-22T05:55:00.000Z', previousValue: false, missingReason: data ? null : status });
function evidence() {
  const injured = section('available', { players: [{ side: 'home', name: '球员甲', reason: 'Knee Injury' }] }, 'api-football'); injured.fallback = true;
  return { matchId: 'sporttery_123', status: 'ok', provider: 'api-football', predictionEligible: false,
    sections: { injuries: injured, lineup: section('not-due') }, sources: {
      leisu: { provider: 'leisu', status: 'unavailable', mappingState: 'unknown', sections: { injuries: section('blocked'), lineup: section('blocked') }, collection: { enabled: true, state: 'blocked', sourceState: 'blocked', sourceHttpStatus: 405, lastRunAt: '2026-09-22T05:58:00.000Z', nextAttemptAt: '2026-09-22T06:05:00.000Z', statusFresh: true } },
      'api-football': { provider: 'api-football', status: 'ok', mappingState: 'verified', sections: { injuries: injured, lineup: section('not-due') }, collection: { enabled: true, state: 'partial', sourceState: 'available', lastRunAt: '2026-09-22T05:55:00.000Z', nextAttemptAt: '2026-09-22T06:00:00.000Z', statusFresh: true } }
    } };
}
async function harness({ data = evidence(), getStatus = 200, getError = null, postStatus = 200, postState = 'queued', kickoffTime = '2026-09-22T12:00:00Z' } = {}) {
  let cursor = 0, initial = true, clock = NOW; const cells = [], effects = [], fetches = [], intervals = [];
  class Clock extends Date { static now() { return clock; } }
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/components/predictions/PrematchCollectionPanel.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Date: Clock, Intl, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    fetch: async (url, options) => { fetches.push({ url, options }); if (options.method !== 'POST' && getError) throw getError; return options.method === 'POST' ? { ok: postStatus === 200, status: postStatus, json: async () => ({ ok: true, state: postState, referenceOnly: true, nextAllowedAt: '2026-09-22T06:10:00.000Z' }) } : { ok: getStatus === 200, status: getStatus, json: async () => data }; },
    require: id => { if (id === 'react') return { useState: v => { const n = cursor++; if (!(n in cells)) cells[n] = v; return [cells[n], v => { cells[n] = typeof v === 'function' ? v(cells[n]) : v; }]; }, useEffect: fn => { if (initial) effects.push(fn); } }; if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }; if (id.endsWith('/accessControl')) return { getAccessAuthHeaders: () => ({ 'x-test-auth': 'present' }) }; if (id.endsWith('/runtimeUrls')) return { buildApiUrl: p => p }; if (id.endsWith('.css')) return {}; throw Error(id); }
  });
  const render = () => { cursor = 0; const result = module.exports.PrematchCollectionPanel({ matchId: data.matchId, language: 'zh', homeName: '主队', awayName: '客队', kickoffTime }); initial = false; return result; };
  render(); effects.forEach(fn => fn()); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  return { render, fetches, intervals, advance: ms => { clock += ms; } };
}

function assertDataOnly(tree) {
  assert.equal(nodes(tree, n => n.type === 'a' || n.props?.href).length, 0, 'data panel must not render source links');
  assert.equal(nodes(tree, n => /^prematch-source-/.test(n.props?.['data-testid'] || '') || /prematch-report__source|prematch-report__schedule/.test(n.props?.className || '')).length, 0);
  assert.doesNotMatch(words(tree), /雷速|API-Football|HTTP|\b405\b|https?:\/\/|javascript:|匹配|身份待核|mapping|下次检查|Next check|最近检查|Last check|最近尝试|Last attempt/i);
}
function withLineups(data = evidence()) {
  data.sections.lineup = { ...section('available', { teams: [
    { side: 'home', formation: '4-3-3', coach: '主队教练甲', starters: [{ name: '主队首发门将', jersey: '31', position: 'G' }, { name: '主队首发前锋', jersey: '9', position: 'F' }], substitutes: [{ name: '主队替补后卫', position: 'D' }] },
    { side: 'away', formation: '3-5-2', coach: '客队教练乙', starters: [{ name: '客队首发门将', jersey: '21', position: 'G' }, { name: '客队首发中场', jersey: '8', position: 'M' }], substitutes: [{ name: '客队替补前锋', position: 'F' }] },
  ] }, 'leisu'), observedAt: '2026-09-22T05:52:00.000Z' };
  return data;
}

test('data-only detail keeps actual injury fields and receipt time without source attribution or attempt clocks', async () => {
  const data = evidence(); data.sections.injuries.data.players = [
    { side: 'home', name: '球员甲', position: 'D', reason: 'Knee Injury', expectedReturn: '2026-10-03' },
    { side: 'away', name: '球员乙', position: 'F', reason: 'Suspended' },
  ];
  const u = await harness({ data }), tree = u.render(), rows = nodes(tree, n => n.props?.['data-testid'] === 'prematch-injury-row');
  assert.equal(rows.length, 2); assert.match(words(rows[0]), /球员甲.*后卫.*膝部伤情.*Knee Injury.*预计回归：2026-10-03/);
  assert.match(words(rows[1]), /球员乙.*前锋.*停赛.*Suspended/);
  assert.match(words(tree), /主队 1 · 客队 1/); assert.match(words(tree), /资料时间：09\/22 13:50/);
  assert.doesNotMatch(words(tree), /13:55|13:58|14:05/); assertDataOnly(tree);
});

test('both team lineups retain formation, coach, real shirt numbers, starters and substitutes', async () => {
  const data = withLineups(), u = await harness({ data }), tree = u.render();
  const lineups = nodes(tree, n => n.props?.className === 'prematch-report__lineup');
  assert.equal(lineups.length, 2); assert.match(words(lineups[0]), /31主队首发门将门将9主队首发前锋前锋/);
  assert.match(words(lineups[1]), /21客队首发门将门将8客队首发中场中场/);
  const coaches = nodes(tree, n => n.props?.className === 'prematch-report__coach');
  assert.deepEqual(coaches.map(words), ['教练：主队教练甲', '教练：客队教练乙']);
  const benches = nodes(tree, n => n.props?.className === 'prematch-report__bench');
  assert.equal(benches.length, 2); assert.match(words(benches[0]), /替补名单 · 1主队替补后卫后卫/); assert.match(words(benches[1]), /替补名单 · 1客队替补前锋前锋/);
  assert.match(words(tree), /4-3-3/); assert.match(words(tree), /3-5-2/); assert.match(words(tree), /资料时间：09\/22 13:52/);
  const metric = nodes(tree, n => n.props?.className === 'prematch-report__time')[0]; assert.equal(words(metric), '09/22 13:52'); assertDataOnly(tree);
});

test('previousValue keeps the actual injury and lineup records with original receipt times', async () => {
  const data = withLineups();
  for (const item of Object.values(data.sections)) { item.previousValue = true; item.status = 'stale'; item.lastAttemptAt = '2026-09-22T05:59:00.000Z'; }
  data.sections.injuries.observedAt = '2026-09-21T02:20:00.000Z'; data.sections.lineup.observedAt = '2026-09-21T02:30:00.000Z';
  const tree = (await harness({ data })).render();
  assert.match(words(tree), /上次记录/); assert.match(words(tree), /保留上次记录/); assert.match(words(tree), /保留上次名单/);
  for (const value of ['球员甲', '主队首发门将', '客队首发中场', '主队替补后卫', '客队教练乙']) assert.ok(words(tree).includes(value));
  assert.match(words(tree), /09\/21 10:20/); assert.match(words(tree), /09\/21 10:30/); assert.doesNotMatch(words(tree), /13:59/); assertDataOnly(tree);
});

test('empty and failed data states never invent players, successful receipt times or collector diagnostics', async () => {
  for (const status of ['ok', 'missing', 'source_empty', 'unavailable', 'partial', 'stale', 'blocked', 'login_required', 'unmapped', 'conflict', 'parse_error']) {
    const data = evidence(); data.status = status;
    data.sections = { injuries: { ...section(status), observedAt: '2026-09-22T05:58:00.000Z' }, lineup: section(status) };
    const tree = (await harness({ data })).render();
    assert.equal(nodes(tree, n => n.props?.['data-testid'] === 'prematch-injury-row').length, 0);
    assert.equal(nodes(tree, n => n.props?.className === 'prematch-report__lineup').length, 0);
    assert.match(words(tree), /不代表全员健康或无人停赛/); assert.match(words(tree), /取得有效资料后显示/);
    assert.equal(words(nodes(tree, n => n.props?.className === 'prematch-report__time')[0]), '—');
    assert.doesNotMatch(words(tree), /球员甲|主队教练|13:58/); assertDataOnly(tree);
  }
});

test('GET failures stay readable without exposing source cards or remote URLs', async () => {
  for (const options of [{ getStatus: 401 }, { getStatus: 503 }, { getError: new Error('Timeout fetching https://private.example/?token=secret') }]) {
    const u = await harness(options), tree = u.render();
    assertDataOnly(tree); assert.doesNotMatch(words(tree), /secret|private\.example/);
    assert.equal(nodes(tree, n => n.props?.['data-testid'] === 'prematch-injury-row').length, 0);
    assert.match(words(tree), options.getStatus === 401 ? /请先验证访问权限/ : /本场资料暂不可用/);
    assert.equal(u.fetches.length, 1); assert.equal(u.fetches[0].options.headers['x-test-auth'], 'present'); assert.equal(u.fetches[0].options.cache, 'no-store');
  }
});

test('source metadata including legitimate and malicious sourcePage URLs is omitted in every display state', async () => {
  for (const status of ['ok', 'source_empty', 'unavailable']) for (const url of ['https://live.leisu.com/shujufenxi-4558551', 'https://www.api-football.com/', 'javascript:alert(1)', 'https://v3.football.api-sports.io/injuries?fixture=123', 'https://live.leisu.com/detail-123?token=secret', 'https://live.leisu.com@evil.test/detail-123']) {
    const data = evidence(); data.status = status;
    if (status !== 'ok') data.sections = { injuries: section(status), lineup: section(status) };
    for (const source of Object.values(data.sources)) { source.sourcePage = { url, scope: 'match' }; source.sections.injuries.sourcePage = source.sourcePage; }
    const u = await harness({ data }), tree = u.render(); assertDataOnly(tree);
    assert.doesNotMatch(JSON.stringify(tree), /secret|evil\.test|api-sports\.io|leisu\.com|api-football\.com|javascript:/);
    assert.equal(u.fetches.length, 1, 'metadata display must not invoke sources or priority collection');
  }
});

test('explicit priority POST keeps authentication, single submission and cooldown while automatic reads stay separate', async () => {
  for (const postState of ['queued', 'cooldown']) {
    const u = await harness({ postState }), button = () => nodes(u.render(), n => n.type === 'button')[1];
    assert.equal(u.fetches.length, 1); assert.equal(u.fetches[0].options.method, undefined); assert.equal(u.fetches[0].options.headers['x-test-auth'], 'present');
    await button().props.onClick(); assert.equal(u.fetches.length, 2);
    const post = u.fetches[1]; assert.match(post.url, /\/sporttery_123\/prematch-refresh$/); assert.equal(post.options.method, 'POST'); assert.equal(post.options.credentials, 'same-origin');
    assert.equal(post.options.headers['x-prematch-request'], '1'); assert.equal(post.options.headers['x-test-auth'], 'present'); assert.equal(post.options.body, undefined);
    assert.equal(button().props.disabled, true); assert.match(words(u.render()), /更新请求已提交，有新资料后会自动显示/); assertDataOnly(u.render());
    await button().props.onClick(); assert.equal(u.fetches.length, 2);
    u.intervals.forEach(fn => fn()); u.render(); assert.equal(u.fetches.filter(r => r.options.method === 'POST').length, 1);
    u.advance(11 * 60000); u.intervals.forEach(fn => fn()); assert.equal(button().props.disabled, false);
  }
});

test('priority errors remain visible and kicked-off matches cannot queue requests or fabricate lineups', async () => {
  for (const [postStatus, message] of [[401, '请先验证访问权限'], [409, '不在赛前采集范围'], [403, '补采请求未通过验证'], [503, '资料暂不可用']]) {
    const u = await harness({ postStatus }); await nodes(u.render(), n => n.type === 'button')[1].props.onClick(); assert.match(words(u.render()), new RegExp(message)); assertDataOnly(u.render());
  }
  const u = await harness({ kickoffTime: '2026-09-22T05:00:00Z' }), button = nodes(u.render(), n => n.type === 'button')[1];
  assert.equal(button.props.disabled, true); await button.props.onClick(); assert.equal(u.fetches.length, 1);
  assert.equal(nodes(u.render(), n => n.props?.className === 'prematch-report__lineup').length, 0); assert.match(words(u.render()), /不补造首发名单/); assertDataOnly(u.render());
});
