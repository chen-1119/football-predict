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
async function harness({ data = evidence(), postStatus = 200, postState = 'queued', kickoffTime = '2026-09-22T12:00:00Z' } = {}) {
  let cursor = 0, initial = true, clock = NOW; const cells = [], effects = [], fetches = [], intervals = [];
  class Clock extends Date { static now() { return clock; } }
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/components/predictions/PrematchCollectionPanel.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Date: Clock, Intl, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    fetch: async (url, options) => { fetches.push({ url, options }); return options.method === 'POST' ? { ok: postStatus === 200, status: postStatus, json: async () => ({ ok: true, state: postState, referenceOnly: true, nextAllowedAt: '2026-09-22T06:10:00.000Z' }) } : { ok: true, json: async () => data }; },
    require: id => { if (id === 'react') return { useState: v => { const n = cursor++; if (!(n in cells)) cells[n] = v; return [cells[n], v => { cells[n] = typeof v === 'function' ? v(cells[n]) : v; }]; }, useEffect: fn => { if (initial) effects.push(fn); } }; if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }; if (id.endsWith('/accessControl')) return { getAccessAuthHeaders: () => ({ 'x-test-auth': 'present' }) }; if (id.endsWith('/runtimeUrls')) return { buildApiUrl: p => p }; if (id.endsWith('.css')) return {}; throw Error(id); }
  });
  const render = () => { cursor = 0; const result = module.exports.PrematchCollectionPanel({ matchId: data.matchId, language: 'zh', homeName: '主队', awayName: '客队', kickoffTime }); initial = false; return result; };
  render(); effects.forEach(fn => fn()); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  return { render, fetches, intervals, advance: ms => { clock += ms; } };
}

test('both source status cards remain visible when API fallback provides the injury list', async () => {
  const u = await harness(), tree = u.render(), source = id => nodes(tree, n => n.props?.['data-testid'] === id)[0];
  assert.match(words(source('prematch-source-leisu')), /雷速.*自动采集暂不可用/);
  assert.doesNotMatch(words(tree), /HTTP 405/);
  assert.match(words(source('prematch-source-api-football')), /API-Football.*比赛已匹配.*已有资料/);
  assert.match(words(tree), /API-Football · 补充来源/); assert.match(words(tree), /球员甲/);
  assert.match(words(tree), /未到采集窗口/); assert.match(words(tree), /不代表全员健康或无人停赛/);
  assert.match(words(tree), /最近尝试 · 伤停 \/ 阵容/); assert.match(words(tree), /下次检查/);
});

test('empty source, unmapped identity and stale receipt show distinct missing reasons', async () => {
  for (const [status, expected] of [['source_empty', '来源暂未提供'], ['unmapped', '比赛尚未匹配'], ['stale', '资料已过期']]) {
    const data = evidence(); data.sections.injuries = section(status); data.sources['api-football'].sections.injuries = section(status);
    const u = await harness({ data }), tree = u.render(); assert.match(words(tree), new RegExp(expected));
    assert.match(words(tree), /不代表全员健康或无人停赛/); assert.equal(nodes(tree, n => n.props?.['data-testid'] === 'prematch-injury-row').length, 0);
  }
});

test('explicit priority request is authenticated once, separate from reading, and cooldown expires', async () => {
  const u = await harness(), button = () => nodes(u.render(), n => n.type === 'button')[1];
  assert.equal(u.fetches.length, 1); assert.equal(u.fetches[0].options.method, undefined);
  await button().props.onClick(); assert.equal(u.fetches.length, 2);
  const post = u.fetches[1]; assert.match(post.url, /\/sporttery_123\/prematch-refresh$/); assert.equal(post.options.method, 'POST'); assert.equal(post.options.credentials, 'same-origin');
  assert.equal(post.options.headers['x-prematch-request'], '1'); assert.equal(post.options.headers['x-test-auth'], 'present'); assert.equal(post.options.body, undefined);
  assert.equal(button().props.disabled, true); assert.match(words(u.render()), /5分钟内检查，受来源与额度限制/);
  await button().props.onClick(); assert.equal(u.fetches.length, 2);
  u.intervals.forEach(fn => fn()); u.render(); assert.equal(u.fetches.filter(r => r.options.method === 'POST').length, 1);
  u.advance(11 * 60000); u.intervals.forEach(fn => fn()); assert.equal(button().props.disabled, false);
});

test('priority errors remain visible and started matches cannot queue pre-match requests', async () => {
  for (const [postStatus, message] of [[401, '请先验证访问权限'], [409, '不在赛前采集范围'], [403, '补采请求未通过验证'], [503, '资料暂不可用']]) {
    const u = await harness({ postStatus }); await nodes(u.render(), n => n.type === 'button')[1].props.onClick(); assert.match(words(u.render()), new RegExp(message));
  }
  const u = await harness({ kickoffTime: '2026-09-22T05:00:00Z' }), button = nodes(u.render(), n => n.type === 'button')[1];
  assert.equal(button.props.disabled, true); await button.props.onClick(); assert.equal(u.fetches.length, 1);
  assert.match(words(u.render()), /已开赛，停止赛前采集/);
});

test('an empty reachable source is not labeled as having data and stale schedules are not future promises', async () => {
  const data = evidence(); data.status = 'partial'; data.provider = null;
  data.sections.injuries = { ...section('source_empty'), statusProvider: 'api-football' };
  data.sections.lineup = { ...section('not-due'), statusProvider: 'api-football', lastAttemptAt: null };
  data.sources['api-football'].status = 'missing';
  data.sources['api-football'].sections = { injuries: data.sections.injuries, lineup: data.sections.lineup };
  data.sources.leisu.collection.statusFresh = false;
  data.sources.leisu.collection.nextAttemptAt = '2026-09-14T06:00:00.000Z';
  const u = await harness({ data }), tree = u.render();
  const apiCard = nodes(tree, n => n.props?.['data-testid'] === 'prematch-source-api-football')[0];
  assert.match(words(apiCard), /来源可访问/); assert.doesNotMatch(words(apiCard), /已有资料/);
  const headings = nodes(tree, n => n.props?.className === 'prematch-report__section-head');
  assert.match(words(headings[0]), /状态来源：API-Football.*来源暂未提供.*最近尝试：09\/22 13:55/);
  assert.match(words(headings[1]), /状态来源：API-Football.*未到采集窗口.*最近尝试：—/);
  const leisuCard = nodes(tree, n => n.props?.['data-testid'] === 'prematch-source-leisu')[0];
  assert.match(words(leisuCard), /自动采集暂不可用/); assert.match(words(leisuCard), /等待来源恢复/); assert.doesNotMatch(words(leisuCard), /HTTP 405|09\/14/);
  const metrics = nodes(tree, n => n.props?.className === 'prematch-report__metrics')[0];
  assert.match(words(metrics), /取得有效资料后显示/); assert.doesNotMatch(words(tree), /本场资料暂不可用，可刷新重试/);
});

test('source cards link to public provider websites without inventing an unmapped match page', async () => {
  const u = await harness(), tree = u.render(), links = nodes(tree, n => n.type === 'a');
  assert.deepEqual(links.map(n => n.props.href), ['https://www.leisu.com/', 'https://www.api-football.com/']);
  for (const link of links) { assert.equal(link.props.target, '_blank'); assert.equal(link.props.rel, 'noopener noreferrer'); assert.match(words(link), /https:\/\//); }
  assert.match(words(tree), /尚未核对本场对应页面/); assert.match(words(tree), /不是本场比赛详情页/);
  assert.equal(u.fetches.length, 1, 'showing source links must not request a provider or trigger collection');
});

test('verified match links distinguish analysis and lineup pages', async () => {
  const data = evidence(), leisu = data.sources.leisu;
  leisu.sourcePage = { url: 'https://live.leisu.com/shujufenxi-4558551', scope: 'match' };
  leisu.sections.injuries.sourcePage = leisu.sourcePage;
  leisu.sections.lineup.sourcePage = { url: 'https://live.leisu.com/detail-4558551', scope: 'match' };
  const u = await harness({ data }), tree = u.render(), card = nodes(tree, n => n.props?.['data-testid'] === 'prematch-source-leisu')[0];
  assert.deepEqual(nodes(card, n => n.type === 'a').map(n => n.props.href), ['https://live.leisu.com/shujufenxi-4558551', 'https://live.leisu.com/detail-4558551']);
  assert.match(words(card), /本场分析原页面/); assert.match(words(card), /本场阵容原页面/); assert.doesNotMatch(words(card), /尚未核对/);
});

test('provider website links remain available when the match data request is unavailable', async () => {
  const data = { matchId: 'sporttery_123', status: 'unavailable', predictionEligible: false };
  const u = await harness({ data }), tree = u.render();
  assert.deepEqual(nodes(tree, n => n.type === 'a').map(n => n.props.href), ['https://www.leisu.com/', 'https://www.api-football.com/']);
  assert.match(words(tree), /本场资料暂不可用/); assert.match(words(tree), /尚未核对本场对应页面/);
  assert.doesNotMatch(words(tree), /来源可访问|比赛已匹配/);
});

test('endpoint URLs, credentials, query strings and unexpected origins cannot become source links', async () => {
  for (const url of ['javascript:alert(1)', 'https://v3.football.api-sports.io/injuries?fixture=123', 'https://live.leisu.com/detail-123?token=secret', 'https://live.leisu.com@evil.test/detail-123', 'https://evil.test/detail-123']) {
    const data = evidence();
    for (const source of Object.values(data.sources)) { source.sourcePage = { url, scope: 'match' }; source.sections.injuries.sourcePage = source.sourcePage; }
    const u = await harness({ data }), tree = u.render();
    assert.deepEqual(nodes(tree, n => n.type === 'a').map(n => n.props.href), ['https://www.leisu.com/', 'https://www.api-football.com/']);
    assert.doesNotMatch(words(tree), /secret|evil\.test|api-sports\.io|javascript:/);
  }
});
