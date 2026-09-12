'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowFor, selectFixtures, buildTasks } = require('./scope.cjs');

const NOW = '2026-09-30T04:00:00Z'; // September 30, 12:00 in Shanghai.
const row = (id = '1', kickoffTime = '2026-09-30T22:00:00+08:00', extra = {}) => ({
  id: `sporttery_${id}`, sourceMatchId: id, kickoffTime,
  homeTeamName: `主队${id}`, awayTeamName: `客队${id}`, leagueName: '样本联赛',
  status: 'SCHEDULED', effectiveStatus: 'SCHEDULED', eventVersion: kickoffTime,
  businessDate: '1999-01-01', ...extra,
});
const selected = (rows = [row()], now = NOW) => selectFixtures(rows, now).selected;
const mapping = (fixture, providerMatchId = '101', extra = {}) => ({
  siteMatchId: fixture.siteMatchId, providerMatchId,
  homeName: fixture.homeName, awayName: fixture.awayName, kickoffUtc: fixture.kickoffUtc,
  verifiedAt: '2026-09-29T23:00:00Z', ...extra,
});
const reasons = result => result.excluded.map(item => item.reason);

test('Shanghai window includes today/tomorrow and rolls over at midnight across months', () => {
  const before = windowFor('2026-09-30T15:59:59Z');
  assert.equal(before.today, '2026-09-30');
  assert.equal(before.tomorrow, '2026-10-01');
  assert.equal(before.startUtc, '2026-09-29T16:00:00.000Z');
  assert.equal(before.endUtc, '2026-10-01T16:00:00.000Z');
  assert.equal(before.startIso, before.startUtc);
  assert.equal(before.endIso, before.endUtc);
  const midnight = windowFor('2026-10-01T00:00:00+08:00');
  assert.equal(midnight.today, '2026-10-01');
  assert.equal(midnight.tomorrow, '2026-10-02');
  assert.equal(midnight.startUtc, '2026-09-30T16:00:00.000Z');
  assert.equal(midnight.endUtc, '2026-10-02T16:00:00.000Z');
  assert.deepEqual(windowFor(new Date(NOW)), windowFor(Date.parse(NOW)));
  assert.throws(() => windowFor('2026-09-30T12:00:00'), /explicit timezone/);
  assert.throws(() => windowFor('2026-02-30T12:00:00Z'), /explicit timezone/);
});

test('date filtering uses kickoff in Shanghai, never businessDate; end is exclusive', () => {
  const result = selectFixtures([
    row('1', '2026-09-30T23:59:59+08:00'),
    row('2', '2026-10-01T23:59:59+08:00'),
    row('3', '2026-10-02T00:00:00+08:00', { businessDate: '2026-09-30' }),
    row('4', '2026-09-30T00:00:00+08:00'),
  ], NOW);
  assert.deepEqual(result.selected.map(f => f.siteMatchId), ['sporttery_1', 'sporttery_2']);
  assert.equal(result.selected[0].businessDate, '1999-01-01');
  assert.deepEqual(reasons(result), ['outside-today-tomorrow', 'kickoff-not-in-future']);
});

test('explicit timezone offsets normalize to the same UTC instant and event', () => {
  const a = selected([row('1', '2026-09-30T22:00:00+08:00')])[0];
  const b = selected([row('1', '2026-09-30T14:00:00Z')])[0];
  assert.deepEqual(a, b);
  assert.equal(a.eventVersion, '2026-09-30T14:00:00.000Z');
  const result = selectFixtures([
    row('2', '2026-09-30T22:00:00'),
    row('3', '2026-09-31T22:00:00+08:00'),
    row('4', '2026-09-30T24:00:00+08:00'),
  ], NOW);
  assert.equal(result.selected.length, 0);
  assert.ok(result.excluded.every(f => f.reason === 'invalid-kickoff-timezone-or-date'));
});

test('kickoff at now/past and every conflicting or unknown lifecycle are excluded', () => {
  const rows = ['LIVE', 'FINISHED', 'PENDING_RESULT', 'CANCELLED', 'POSTPONED', 'UNKNOWN', '推迟']
    .map((state, index) => row(String(index + 1), undefined, { effectiveStatus: state }));
  rows.push(row('20', undefined, { sourceStatus: 'LIVE' }));
  rows.push(row('21', undefined, { status: null, effectiveStatus: null }));
  rows.push(row('22', NOW));
  rows.push(row('23', '2026-09-30T03:59:59Z'));
  const result = selectFixtures(rows, NOW);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded.length, rows.length);
  assert.equal(reasons(result).filter(r => r === 'kickoff-not-in-future').length, 2);
  assert.equal(selected([row('24', undefined, { effectiveStatus: undefined })]).length, 1);
  assert.equal(selected([row('25', undefined, { status: undefined })]).length, 1);
});

test('requires canonical site/source IDs and both actual team names', () => {
  const result = selectFixtures([
    row('1', undefined, { id: '1' }), row('2', undefined, { sourceMatchId: '999' }),
    row('3', undefined, { homeTeamName: '  ' }), row('4', undefined, { awayTeamName: null }),
    row('5', undefined, { awayTeamName: '主队5' }),
  ], NOW);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded.length, 5);
});

test('identical repeated IDs deduplicate, conflicts exclude the entire ID', () => {
  const result = selectFixtures([
    row('1'), row('1'), row('2'), row('2', undefined, { awayTeamName: '另一支球队' }),
    row('3'), row('3', undefined, { effectiveStatus: 'LIVE' }),
  ], NOW);
  assert.deepEqual(result.selected.map(f => f.siteMatchId), ['sporttery_1']);
  assert.deepEqual(reasons(result), ['conflicting-duplicate-id', 'conflicting-duplicate-id']);
});

test('event version defaults to kickoff but rejects stale, naive or opaque versions', () => {
  assert.equal(selected([row('1', undefined, { eventVersion: undefined })]).length, 1);
  for (const eventVersion of ['2026-09-30T13:00:00Z', '2026-09-30T14:00:00', 'revision-2']) {
    assert.deepEqual(reasons(selectFixtures([row('1', undefined, { eventVersion })], NOW)), ['event-version-mismatch']);
  }
});

test('exact verified mapping produces injuries only before the lineup window; odds absent', () => {
  const fixtures = selected();
  const result = buildTasks(fixtures, [mapping(fixtures[0])], [], NOW);
  assert.deepEqual(result.tasks.map(t => t.kind), ['injuries']);
  assert.equal(result.tasks[0].fixture.siteMatchId, 'sporttery_1');
  assert.equal(result.tasks[0].sourceUrl, 'https://live.leisu.com/shujufenxi-101');
  assert.match(result.tasks[0].taskKey, /sporttery_1\|kickoff=2026-09-30T14:00:00.000Z\|event=/);
  assert.equal(result.skipped[0].reason, 'lineup-window-not-open');
});

test('unmapped, wrong names, rescheduled kickoff and missing/future verification do not run', () => {
  const fixtures = selected(), fixture = fixtures[0];
  assert.equal(buildTasks(fixtures, [], [], NOW).skipped[0].reason, 'unmapped');
  const cases = [
    [{ homeName: '主队1 ' }, 'mapping-team-mismatch'],
    [{ homeName: fixture.awayName, awayName: fixture.homeName }, 'mapping-team-mismatch'],
    [{ kickoffUtc: '2026-09-30T13:00:00Z' }, 'mapping-kickoff-mismatch'],
    [{ verifiedAt: null }, 'mapping-not-verified'],
    [{ verifiedAt: '2026-09-30T05:00:00Z' }, 'mapping-not-verified'],
    [{ providerMatchId: '../101' }, 'invalid-provider-match-id'],
  ];
  for (const [extra, reason] of cases) {
    const result = buildTasks(fixtures, [mapping(fixture, '101', extra)], [], NOW);
    assert.equal(result.tasks.length, 0);
    assert.equal(result.skipped[0].reason, reason);
  }
  assert.equal(buildTasks(fixtures, [mapping(fixture, '101', { siteMatchId: 'sporttery_999' })], [], NOW).tasks.length, 0);
});

test('ambiguous site mappings and one provider mapped to two sites are refused', () => {
  const fixtures = selected([row('1'), row('2')]);
  let result = buildTasks([fixtures[0]], [mapping(fixtures[0], '101'), mapping(fixtures[0], '102')], [], NOW);
  assert.equal(result.skipped[0].reason, 'ambiguous-mapping');
  result = buildTasks(fixtures, [mapping(fixtures[0], '101'), mapping(fixtures[1], '101')], [], NOW);
  assert.equal(result.tasks.length, 0);
  assert.ok(result.skipped.every(item => item.reason === 'provider-mapped-to-multiple-sites'));
  assert.equal(buildTasks([fixtures[0]], [mapping(fixtures[0]), mapping(fixtures[0])], [], NOW).tasks.length, 1);
});

test('only explicit provider aliases are carried; empty, identical or ambiguous aliases are rejected', () => {
  const fixtures = selected([row('1', undefined, { homeTeamName: '托特纳姆热刺', awayTeamName: '曼彻斯特联' })]);
  const fixture = fixtures[0];
  const aliases = { providerHomeName: '热刺', providerAwayName: '曼联' };
  const result = buildTasks(fixtures, [mapping(fixture, '101', aliases)], [], NOW);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].providerHomeName, '热刺');
  assert.equal(result.tasks[0].providerAwayName, '曼联');
  assert.equal(result.tasks[0].fixture.homeName, '托特纳姆热刺');
  assert.equal(result.tasks[0].fixture.awayName, '曼彻斯特联');
  const fallback = buildTasks(fixtures, [mapping(fixture)], [], NOW).tasks[0];
  assert.equal(fallback.providerHomeName, fixture.homeName);
  assert.equal(fallback.providerAwayName, fixture.awayName);
  for (const invalid of [
    { providerHomeName: ' ' }, { providerAwayName: '' }, { providerHomeName: null },
    { providerHomeName: '同队', providerAwayName: '同队' },
  ]) {
    const rejected = buildTasks(fixtures, [mapping(fixture, '101', invalid)], [], NOW);
    assert.equal(rejected.tasks.length, 0);
    assert.equal(rejected.skipped[0].reason, 'invalid-provider-team-names');
  }
  const ambiguous = buildTasks(fixtures, [mapping(fixture, '101', aliases),
    mapping(fixture, '101', { ...aliases, providerHomeName: '其他名称' })], [], NOW);
  assert.equal(ambiguous.tasks.length, 0);
  assert.equal(ambiguous.skipped[0].reason, 'ambiguous-mapping');
  const wrongSiteNames = buildTasks(fixtures, [mapping(fixture, '101', { ...aliases, homeName: '热刺' })], [], NOW);
  assert.equal(wrongSiteNames.tasks.length, 0);
  assert.equal(wrongSiteNames.skipped[0].reason, 'mapping-team-mismatch');
});

test('injuries use Shanghai six-hour buckets; every prior attempt suppresses same task', () => {
  const fixtures = selected(), maps = [mapping(fixtures[0])];
  const first = buildTasks(fixtures, maps, [], '2026-09-30T03:59:00Z').tasks[0];
  const repeat = buildTasks(fixtures, maps, [{ taskKey: first.taskKey, status: 'blocked', receivedAt: '2026-09-30T03:59:01Z' }], '2026-09-30T03:59:30Z');
  assert.equal(repeat.tasks.length, 0);
  assert.ok(repeat.skipped.some(item => item.reason === 'already-attempted'));
  const next = buildTasks(fixtures, maps, [{ taskKey: first.taskKey, status: 'available' }], NOW).tasks[0];
  assert.notEqual(next.taskKey, first.taskKey);
  assert.match(next.taskKey, /bucket=2026-09-30T04:00:00.000Z$/);
});

test('lineup schedules only the latest reached 90/60/30 stage without catch-up', () => {
  const fixtures = selected(), maps = [mapping(fixtures[0])];
  const phase = now => buildTasks(fixtures, maps, [], now).tasks.filter(t => t.kind === 'lineup');
  assert.equal(phase('2026-09-30T12:29:59Z').length, 0);
  assert.match(phase('2026-09-30T12:30:00Z')[0].taskKey, /stage=90$/);
  assert.match(phase('2026-09-30T13:00:00Z')[0].taskKey, /stage=60$/);
  assert.match(phase('2026-09-30T13:30:00Z')[0].taskKey, /stage=30$/);
  const late = phase('2026-09-30T13:45:00Z');
  assert.equal(late.length, 1);
  assert.match(late[0].taskKey, /stage=30$/);
  const replay = buildTasks(fixtures, maps, [{ taskKey: late[0].taskKey, status: 'parse_error' }], '2026-09-30T13:50:00Z');
  assert.equal(replay.tasks.filter(t => t.kind === 'lineup').length, 0);
  assert.equal(late[0].sourceUrl, 'https://live.leisu.com/detail-101');
});

const lineupKey = (fixture, stage) => `${fixture.siteMatchId}|kickoff=${fixture.kickoffUtc}|event=${fixture.eventVersion}|lineup|stage=${stage}`;
const lineupAttempts = (fixture, stage, status) => ({ taskKey: lineupKey(fixture, stage), status });
const lineupTasks = (fixtures, attempts, now) => buildTasks(fixtures,
  fixtures.map((fixture, index) => mapping(fixture, String(101 + index))), attempts, now).tasks.filter(task => task.kind === 'lineup');

test('available lineup at 90 and 60 minutes still permits both remaining normal checks', () => {
  const fixtures = selected(), fixture = fixtures[0];
  const stage90 = lineupTasks(fixtures, [], '2026-09-30T12:30:00Z');
  assert.deepEqual(stage90.map(task => task.taskKey), [lineupKey(fixture, 90)]);
  const attempts = [lineupAttempts(fixture, 90, 'available')];
  assert.deepEqual(lineupTasks(fixtures, attempts, '2026-09-30T13:00:00Z').map(task => task.taskKey), [lineupKey(fixture, 60)]);
  attempts.push(lineupAttempts(fixture, 60, 'available'));
  assert.deepEqual(lineupTasks(fixtures, attempts, '2026-09-30T13:30:00Z').map(task => task.taskKey), [lineupKey(fixture, 30)]);
  attempts.push(lineupAttempts(fixture, 30, 'available'));
  assert.equal(lineupTasks(fixtures, attempts, '2026-09-30T13:50:00Z').length, 0);
});

test('empty stage 30 opens one stage-20 follow-up only when due', () => {
  const fixtures = selected(), fixture = fixtures[0];
  const attempts = [lineupAttempts(fixture, 30, 'source_empty')];
  assert.equal(lineupTasks(fixtures, attempts, '2026-09-30T13:39:59Z').length, 0);
  const due = lineupTasks(fixtures, attempts, '2026-09-30T13:40:00Z');
  assert.deepEqual(due.map(task => task.taskKey), [lineupKey(fixture, 20)]);
  attempts.push(lineupAttempts(fixture, 20, 'source_empty'));
  assert.equal(lineupTasks(fixtures, attempts, '2026-09-30T13:49:59Z').length, 0);
});

test('available stage 20 ends follow-ups; empty stage 20 enables stage 10 once', () => {
  const fixtures = selected(), fixture = fixtures[0];
  const base = [lineupAttempts(fixture, 30, 'source_empty')];
  assert.equal(lineupTasks(fixtures, [...base, lineupAttempts(fixture, 20, 'available')], '2026-09-30T13:50:00Z').length, 0);
  const attempts = [...base, lineupAttempts(fixture, 20, 'source_empty')];
  assert.deepEqual(lineupTasks(fixtures, attempts, '2026-09-30T13:50:00Z').map(task => task.taskKey), [lineupKey(fixture, 10)]);
  for (const status of ['available', 'source_empty']) {
    assert.equal(lineupTasks(fixtures, [...attempts, lineupAttempts(fixture, 10, status)], '2026-09-30T13:59:59Z').length, 0);
  }
});

test('missed follow-up slots never catch up; absent stage-30 empty evidence never unlocks them', () => {
  const fixtures = selected(), fixture = fixtures[0];
  const late = '2026-09-30T13:55:00Z';
  assert.deepEqual(lineupTasks(fixtures, [lineupAttempts(fixture, 30, 'source_empty')], late).map(task => task.taskKey), [lineupKey(fixture, 10)]);
  assert.deepEqual(lineupTasks(fixtures, [], late).map(task => task.taskKey), [lineupKey(fixture, 30)]);
  for (const status of ['available', 'blocked', 'parse_error', 'login_required', 'conflict']) {
    assert.equal(lineupTasks(fixtures, [lineupAttempts(fixture, 30, status)], late).length, 0);
  }
});

test('follow-up evidence requires an exact same fixture, kickoff, event and stage task key', () => {
  const fixtures = selected(), fixture = fixtures[0], original = lineupKey(fixture, 30);
  const invalid = [
    original.replace('sporttery_1|', 'sporttery_11|'),
    original.replace('kickoff=2026-09-30T14:00:00.000Z', 'kickoff=2026-09-30T15:00:00.000Z'),
    original.replace('event=2026-09-30T14:00:00.000Z', 'event=2026-09-30T15:00:00.000Z'),
    original.replace('|lineup|', '|injuries|'),
    original.replace('stage=30', 'stage=300'), `${original}\n`, `${original}|extra`,
  ];
  for (const taskKey of invalid) {
    const tasks = lineupTasks(fixtures, [{ taskKey, status: 'source_empty' }], '2026-09-30T13:50:00Z');
    assert.deepEqual(tasks.map(task => task.taskKey), [lineupKey(fixture, 30)]);
  }
  const changed = selected([row('1', '2026-09-30T23:00:00+08:00')]);
  assert.deepEqual(lineupTasks(changed, [lineupAttempts(fixture, 30, 'source_empty')], '2026-09-30T14:50:00Z')
    .map(task => task.taskKey), [lineupKey(changed[0], 30)]);
  const pair = selected([row('1'), row('2')]);
  assert.deepEqual(lineupTasks(pair, [lineupAttempts(pair[0], 30, 'source_empty')], '2026-09-30T13:50:00Z')
    .map(task => task.taskKey), [lineupKey(pair[0], 10), lineupKey(pair[1], 30)]);
});

test('follow-up failures honor caller retry filtering without changing injury buckets', () => {
  const fixtures = selected(), fixture = fixtures[0], now = '2026-09-30T13:45:00Z';
  const base = [lineupAttempts(fixture, 30, 'source_empty')];
  const heldFailure = lineupAttempts(fixture, 20, 'parse_error');
  assert.equal(lineupTasks(fixtures, [...base, heldFailure], now).length, 0);
  assert.deepEqual(lineupTasks(fixtures, base, now).map(task => task.taskKey), [lineupKey(fixture, 20)]);
  const before = buildTasks(fixtures, [mapping(fixture)], [], now).tasks.filter(task => task.kind === 'injuries');
  const after = buildTasks(fixtures, [mapping(fixture)], base, now).tasks.filter(task => task.kind === 'injuries');
  assert.deepEqual(after, before);
});

test('empty lineup evidence never schedules any follow-up at or after kickoff', () => {
  const fixtures = selected(), fixture = fixtures[0];
  const attempts = [lineupAttempts(fixture, 30, 'source_empty'), lineupAttempts(fixture, 20, 'source_empty')];
  for (const now of ['2026-09-30T14:00:00Z', '2026-09-30T14:01:00Z']) {
    const result = buildTasks(fixtures, [mapping(fixture)], attempts, now);
    assert.equal(result.tasks.length, 0);
    assert.equal(result.skipped[0].reason, 'kickoff-not-in-future');
  }
});

test('rescheduling invalidates old mapping and creates a new event task key after reverification', () => {
  const old = selected(), oldMap = mapping(old[0]);
  const oldTasks = buildTasks(old, [oldMap], [], NOW).tasks;
  const changed = selected([row('1', '2026-09-30T23:00:00+08:00')]);
  assert.equal(buildTasks(changed, [oldMap], [], NOW).skipped[0].reason, 'mapping-kickoff-mismatch');
  const next = buildTasks(changed, [mapping(changed[0])], oldTasks.map(t => ({ taskKey: t.taskKey })), NOW);
  assert.equal(next.tasks.length, 1);
  assert.notEqual(next.tasks[0].taskKey, oldTasks[0].taskKey);
});

test('buildTasks checks kickoff again and never emits duplicate or conflicting selected tasks', () => {
  const fixtures = selected(), maps = [mapping(fixtures[0])];
  const atKickoff = buildTasks(fixtures, maps, [], '2026-09-30T14:00:00Z');
  assert.equal(atKickoff.tasks.length, 0);
  assert.equal(atKickoff.skipped[0].reason, 'kickoff-not-in-future');
  assert.equal(buildTasks([...fixtures, ...fixtures], maps, [], NOW).tasks.length, 1);
  const conflict = buildTasks([fixtures[0], { ...fixtures[0], awayName: '其他球队' }], maps, [], NOW);
  assert.equal(conflict.tasks.length, 0);
  assert.equal(conflict.skipped[0].reason, 'conflicting-selected-id');
});
