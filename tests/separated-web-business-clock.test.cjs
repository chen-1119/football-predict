'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const data = require('../apps/web/lib/data.cjs');

const generationId = 'g-' + 'a'.repeat(64);
function snapshot(businessDate, extra = {}) {
  return { ok: true, storage: 'postgres', businessDate, stale: false,
    publication: { generationId, committedAt: '2026-10-12T23:37:00Z' },
    observedAt: '2026-10-13T00:00:00Z', nextCursor: null,
    matches: [{ id: 'sporttery_42', businessDate, matchNo: '001', leagueName: '测试联赛',
      homeTeamName: '测试主队', awayTeamName: '测试客队', kickoffTime: '2026-10-13T12:00:00Z',
      buyEndTime: '2026-10-13T11:00:00Z', odds: { home: 1.5, draw: 3.4, away: 4.2 },
      sourceUpdatedAt: '2026-10-12T23:01:00Z', quoteStatus: 'recent' }], ...extra };
}
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const failedFetch = async () => { throw new Error('simulated API outage'); };

test('Beijing business day changes at 16:00 UTC, including month and year boundaries', () => {
  for (const [instant, expected] of [
    ['2026-10-12T15:59:59.999Z', '2026-10-12'], ['2026-10-12T16:00:00.000Z', '2026-10-13'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01'], ['2028-02-28T16:00:00.000Z', '2028-02-29'],
  ]) assert.equal(data.beijingBusinessDate(Date.parse(instant)), expected);
});

test('Beijing business date does not follow the server local timezone', () => {
  const modulePath = path.resolve(__dirname, '../apps/web/lib/data.cjs');
  const script = 'process.stdout.write(require(process.argv[1]).beijingBusinessDate(Date.parse(process.argv[2])))';
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const result = execFileSync(process.execPath, ['-e', script, modulePath, '2026-10-12T16:00:00Z'],
      { encoding: 'utf8', env: { ...process.env, TZ }, windowsHide: true });
    assert.equal(result, '2026-10-13');
  }
});

test('default API request has an explicit Beijing day; explicit date and pagination stay unchanged', async () => {
  const now = () => Date.parse('2026-10-12T16:00:00Z');
  const queries = [];
  const fetchImpl = async url => {
    const query = new URL(url).searchParams;
    queries.push(Object.fromEntries(query));
    return response(snapshot(query.get('date')));
  };
  await data.loadFixtures({}, { now, fetchImpl });
  const selected = { date: '2026-10-11', cursor: 'generation-bound-cursor', limit: '2' };
  await data.loadFixtures(selected, { now, fetchImpl });
  assert.deepEqual(queries, [{ date: '2026-10-13' }, selected]);
  assert.deepEqual(selected, { date: '2026-10-11', cursor: 'generation-bound-cursor', limit: '2' });
});

test('a successful default-day snapshot cannot become next-day fixtures during an outage', async () => {
  const before = Date.parse('2031-04-08T15:59:59.000Z'), after = before + 2000;
  const initial = await data.loadFixtures({}, { now: () => before,
    fetchImpl: async () => response(snapshot('2031-04-08')) });
  assert.equal(initial.availability, 'available');
  const nextDay = await data.loadFixtures({}, { now: () => after, fetchImpl: failedFetch });
  assert.equal(nextDay.ok, false); assert.equal(nextDay.availability, 'unavailable');
  assert.deepEqual(nextDay.matches, []);
  const selectedPreviousDay = await data.loadFixtures({ date: '2031-04-08' }, { now: () => after, fetchImpl: failedFetch });
  assert.equal(selectedPreviousDay.businessDate, '2031-04-08');
  assert.equal(selectedPreviousDay.availability, 'last-committed-snapshot');
  assert.equal(selectedPreviousDay.matches[0].quoteStatus, 'expired');
});

test('a changed generation still rejects cached pagination instead of falling back', async () => {
  const now = () => Date.parse('2031-04-09T00:00:00Z');
  const query = { date: '2031-04-09', cursor: 'old-generation-cursor' };
  await data.loadFixtures(query, { now, fetchImpl: async () => response(snapshot(query.date)) });
  const changed = await data.loadFixtures(query, { now,
    fetchImpl: async () => new Response('{"error":"CURSOR_GENERATION_CHANGED"}', { status: 409 }) });
  assert.equal(changed.availability, 'generation-changed');
  assert.equal(changed.ok, false); assert.deepEqual(changed.matches, []);
});

async function renderHome(searchParams, result, at) {
  const filename = path.resolve(__dirname, '../apps/web/app/page.jsx');
  const nativeRequire = createRequire(filename), module = { exports: {} }, queries = [];
  const clockedData = { ...data, fixtureQuery: query => data.fixtureQuery(query, at),
    loadFixtures: async query => { queries.push(query); return result; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, Date, Intl, URLSearchParams,
    require: id => id === '../lib/data.cjs' ? clockedData : id === 'next/link'
      ? ({ children, ...props }) => React.createElement('a', props, children) : nativeRequire(id) });
  const tree = await module.exports.default({ searchParams: Promise.resolve(searchParams) });
  return { html: renderToStaticMarkup(tree), queries };
}

test('SSR displays the selected day and distinct version, read and quote clocks; links retain the day', async () => {
  const selected = '2026-10-11', at = Date.parse('2026-10-12T16:00:00Z');
  const { html, queries } = await renderHome({ date: selected, cursor: 'page-one' },
    snapshot(selected, { nextCursor: 'page-two' }), at);
  assert.deepEqual(JSON.parse(JSON.stringify(queries)), [{ date: selected, cursor: 'page-one' }]);
  assert.match(html, /2026-10-11 竞彩日 · 北京时间/);
  assert.match(html, /数据版本时间：10\/13 07:37/);
  assert.match(html, /本页读取：10\/13 08:00/);
  assert.match(html, /报价观察：10\/13 07:01/);
  assert.doesNotMatch(html, /赛程入库时间|事务完成时间/);
  assert.match(html, /href="\/\?date=2026-10-11&amp;cursor=page-two"/);
  const today = await renderHome({}, snapshot('2026-10-13'), at);
  assert.match(today.html, /2026-10-13 竞彩日 · 北京时间/);
  assert.deepEqual(JSON.parse(JSON.stringify(today.queries)), [{ date: '2026-10-13' }]);
});

test('SSR generation-change link restarts on the same selected business date', async () => {
  const { html } = await renderHome({ date: '2026-10-11', cursor: 'old-page' },
    { ok: false, matches: [], stale: true, availability: 'generation-changed' }, Date.parse('2026-10-13T00:00:00Z'));
  assert.match(html, /href="\/\?date=2026-10-11"/);
  assert.doesNotMatch(html, /href="[^"]*old-page/);
});
