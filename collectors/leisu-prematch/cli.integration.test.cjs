'use strict';

// Simulated browser and database orchestration only. These tests do not prove
// source access, PostgreSQL connectivity, or unattended real-world collection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const scope = require('./scope.cjs');
const store = require('./store.cjs');
const browser = require('./browser.cjs');
const { main } = require('./cli.cjs');

async function scenario(mode, verify) {
  const tempBase = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempBase, 'leisu-cli-integration-'));
  const stateDir = path.join(directory, 'state');
  const mappingsFile = path.join(directory, 'mappings.json');
  const outputFile = path.join(stateDir, 'latest-evidence.json');
  const lockFile = path.join(stateDir, 'collector.lock');
  const circuitFile = path.join(stateDir, 'circuit.json');
  const fixtureUrl = 'postgresql://simulation.invalid/fixtures';
  const observationUrl = 'postgresql://simulation.invalid/observations';
  const kickoffTime = new Date(Math.ceil(Date.now() / 60000) * 60000 + (['page-budget', 'priority-discovery'].includes(mode) ? 45 * 60000 : 3 * 3600000)).toISOString();
  const row = { id: 'sporttery_91001', sourceMatchId: '91001', homeTeamName: '模拟主队', awayTeamName: '模拟客队',
    kickoffTime, eventVersion: kickoffTime, status: 'SCHEDULED', effectiveStatus: 'SCHEDULED', leagueName: '模拟联赛' };
  const fixture = scope.selectFixtures([row], new Date()).selected[0];
  const cancelExport = mode.startsWith('cancel-export-');
  const rows = cancelExport ? Array.from({ length: 501 }, (_, index) => ({ ...row,
    id: 'sporttery_' + (91001 + index), sourceMatchId: String(91001 + index) })) : [row];
  const fixturesById = new Map(scope.selectFixtures(rows, new Date()).selected.map(item => [item.siteMatchId, item]));
  const mappings = [{ siteMatchId: row.id, providerMatchId: '92001', homeName: row.homeTeamName,
    awayName: row.awayTeamName, kickoffUtc: kickoffTime, verifiedAt: new Date(Date.now() - 60000).toISOString() }];
  const env = { LEISU_STATE_DIR: stateDir, LEISU_MAPPINGS_FILE: mappingsFile, LEISU_OUTPUT_FILE: outputFile,
    LEISU_FIXTURE_DATABASE_URL: fixtureUrl, LEISU_DATABASE_URL: observationUrl,
    LEISU_ENABLED: '1', LEISU_ACCESS_VALIDATED: '1' };
  if (mode === 'page-budget') env.LEISU_MAX_PAGES_PER_RUN = '1';
  if (['discovery-budget', 'priority-discovery'].includes(mode)) {
    env.LEISU_MAX_PAGES_PER_RUN = mode === 'priority-discovery' ? '2' : '1';
    env.LEISU_LEAGUE_URLS_JSON = JSON.stringify([84, 82, 83].map(id => 'https://www.leisu.com/data/zuqiu/comp-' + id));
  }
  if (mode === 'discovery-retry') env.LEISU_LEAGUE_URLS_JSON = JSON.stringify(['https://www.leisu.com/data/zuqiu/comp-82']);
  if (mode === 'empty') env.LEISU_LEAGUE_URLS_JSON = JSON.stringify(['https://www.leisu.com/data/zuqiu/comp-82']);
  const calls = { runs: 0, prepaused: 0, opens: 0, collections: 0, closes: 0, saves: [], starts: [], finishes: [], feeds: 0, evidence: 0, pools: [], tasks: [], leagues: [], leagueFailures: [], order: [], batchSizes: [] };
  const observations = [];
  const restore = [];
  const signalCounts = ['SIGTERM', 'SIGINT'].map(signal => [signal, process.listenerCount(signal)]);
  const patch = (target, name, implementation) => {
    const original = target[name];
    target[name] = implementation;
    restore.push(() => { target[name] = original; });
  };
  const payload = (kind = 'injuries') => ({ providerMatchId: '92001', homeName: fixture.homeName, awayName: fixture.awayName,
    kickoffUtc: fixture.kickoffUtc, sourcePublishedAt: null,
    ...(kind === 'lineup' ? { teams: ['home', 'away'].map((side, index) => ({ side,
      name: side === 'home' ? fixture.homeName : fixture.awayName, formation: '4-4-2', coach: null,
      starters: Array.from({ length: 11 }, (_, player) => ({ id: String(94000 + index * 100 + player), name: '模拟首发' + player, jersey: String(player + 1) })), substitutes: [] })) }
      : { injuries: [{ side: 'home', name: '模拟球员', providerPlayerId: '93001', reasonAsDisplayed: '模拟伤情',
        positionAsDisplayed: '中场', returnDateAsDisplayed: null }] }) });
  const toRecord = observation => ({ siteMatchId: observation.fixture.siteMatchId,
    eventVersion: observation.fixture.eventVersion, providerMatchId: observation.providerMatchId,
    kind: observation.kind, taskKey: observation.taskKey, receivedAt: observation.receivedAt,
    sourceUrl: observation.sourceUrl, status: observation.status, data: structuredClone(observation.data),
    sourcePublishedAt: null, predictionEligible: false });
  const firstTask = () => scope.buildTasks([fixture], mappings, [], new Date()).tasks.find(task => task.kind === 'injuries');
  const context = { close: async () => { calls.closes++; } };
  try {
    assert.ok(fixture, 'real system time must produce one eligible fixture');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(mappingsFile, JSON.stringify(['discovery-budget', 'discovery-retry'].includes(mode) ? [] : mappings));
    if (['no-due', 'blocked'].includes(mode)) {
      observations.push({ fixture, providerMatchId: '92001', kind: 'injuries', taskKey: firstTask().taskKey,
        receivedAt: new Date(Date.now() - 3600000).toISOString(), sourceUrl: firstTask().sourceUrl,
        status: 'available', data: payload() });
    }
    if (mode === 'no-due' || cancelExport) fs.writeFileSync(outputFile, JSON.stringify({ generatedAt: '2000-01-01T00:00:00.000Z', sentinel: true }));

    patch(console, 'log', () => {});
    patch(store, 'createPool', url => {
      assert.ok([fixtureUrl, observationUrl].includes(url));
      const pool = { url, ended: false, end: async () => { pool.ended = true; } };
      calls.pools.push(pool);
      return pool;
    });
    patch(store, 'readFixtureFeed', async pool => {
      assert.equal(pool.url, fixtureUrl);
      calls.feeds++;
      if (mode === 'cancel-feed' && calls.feeds === 1) process.emit('SIGTERM');
      return { generatedAt: new Date().toISOString(), generationId: 'simulated-generation', manifestHash: 'f'.repeat(64), matches: mode === 'empty' ? [] : structuredClone(rows) };
    });
    patch(store, 'getAttempts', async pool => {
      assert.equal(pool.url, observationUrl);
      if (mode !== 'no-due') return calls.saves.map(item => ({ taskKey: item.taskKey, status: item.status, receivedAt: item.receivedAt }));
      // Include the immediately adjacent bucket so a real clock crossing a
      // six-hour boundary during this test cannot turn no-due into due.
      const now = Date.now();
      return [-1000, 0, 1000].flatMap(delta => scope.buildTasks([fixture], mappings, [], now + delta).tasks)
        .map(task => ({ taskKey: task.taskKey, status: 'available', receivedAt: new Date(now).toISOString() }));
    });
    patch(store, 'startRun', async pool => {
      assert.equal(pool.url, observationUrl);
      const runId = randomUUID();
      calls.starts.push(runId);
      return runId;
    });
    patch(store, 'saveObservation', async (pool, observation) => {
      assert.equal(pool.url, observationUrl);
      assert.ok(calls.starts.includes(observation.runId));
      assert.equal(observation.fixture.siteMatchId, fixture.siteMatchId);
      assert.ok(['injuries', 'lineup'].includes(observation.kind));
      assert.ok(Date.parse(observation.receivedAt) < Date.parse(fixture.kickoffUtc));
      if (observation.status === 'available') {
        assert.deepEqual(observation.data, payload(observation.kind));
      } else {
        assert.ok(['blocked', 'parse_error'].includes(observation.status));
        assert.equal(observation.data, null);
      }
      observations.push(structuredClone(observation));
      calls.saves.push(structuredClone(observation));
      return { observationId: randomUUID(), latestUpdated: observation.status === 'available' };
    });
    patch(store, 'getEvidence', async (pool, siteMatchId, eventVersion) => {
      assert.equal(pool.url, observationUrl);
      assert.ok(fixturesById.has(siteMatchId));
      assert.equal(eventVersion, fixturesById.get(siteMatchId).eventVersion);
      calls.evidence++;
      const sections = {};
      for (const kind of ['injuries', 'lineup']) {
        const matching = observations.filter(item => item.kind === kind && item.fixture.siteMatchId === siteMatchId);
        const latestAttempt = matching.at(-1);
        const latestValid = matching.filter(item => item.status === 'available').at(-1);
        sections[kind] = { latestValid: latestValid ? toRecord(latestValid) : null, latestAttempt: latestAttempt ? toRecord(latestAttempt) : null };
      }
      return { siteMatchId, eventVersion, predictionEligible: false, sections };
    });
    patch(store, 'getEvidenceBatch', async (pool, fixtures) => {
      calls.batchSizes.push(fixtures.length);
      const evidences = await Promise.all(fixtures.map(item => store.getEvidence(pool, item.siteMatchId, item.eventVersion)));
      if (cancelExport && calls.batchSizes.length === 1) process.emit('SIGTERM');
      return evidences;
    });
    patch(store, 'finishRun', async (pool, runId, status) => {
      assert.equal(pool.url, observationUrl);
      assert.ok(calls.starts.includes(runId));
      calls.finishes.push({ runId, status });
    });
    patch(browser, 'openBrowser', async (profileDir, headless) => {
      assert.equal(profileDir, path.join(stateDir, 'browser'));
      assert.equal(headless, true);
      calls.opens++;
      if (mode === 'cancel-startup') process.emit('SIGTERM');
      return context;
    });
    patch(browser, 'collectTask', async (actualContext, task) => {
      assert.equal(actualContext, context);
      assert.deepEqual(task.fixture, fixture);
      assert.equal(task.providerMatchId, '92001');
      assert.ok(['injuries', 'lineup'].includes(task.kind));
      calls.collections++;
      calls.tasks.push(task);
      calls.order.push('task:' + task.kind);
      if (mode === 'cancel-page') process.emit('SIGINT');
      if (mode === 'transient' && calls.collections === 1) return { status: 'parse_error', data: null, receivedAt: new Date().toISOString(), reason: 'page-timeout' };
      return mode === 'blocked'
        ? { status: 'blocked', data: null, receivedAt: new Date().toISOString(), httpStatus: 403, reason: 'simulated-block' }
        : { status: 'available', data: payload(task.kind), receivedAt: new Date().toISOString(), httpStatus: 200 };
    });
    patch(browser, 'collectLeague', async (actualContext, sourceUrl) => {
      assert.equal(actualContext, context);
      assert.ok(['discovery-budget', 'priority-discovery', 'discovery-retry'].includes(mode), 'unexpected discovery request');
      calls.leagues.push(sourceUrl);
      calls.order.push('league:' + sourceUrl);
      if (calls.cancelNextLeague) { calls.cancelNextLeague = false; process.emit('SIGTERM'); }
      if (calls.blockNextLeague) { calls.blockNextLeague = false; return { status: 'blocked', candidates: [], httpStatus: 403, reason: 'source-block-page' }; }
      if (calls.leagueFailures.length) return { ...calls.leagueFailures.shift(), receivedAt: new Date().toISOString(), candidates: [] };
      return { status: 'available', candidates: [{ providerMatchId: '92001', homeName: fixture.homeName,
        awayName: fixture.awayName, kickoffUtc: fixture.kickoffUtc, sourceUrl }] };
    });

    await verify({ run: async command => {
      calls.runs++;
      const result = await main([command || (mode === 'cancel-export-command' ? 'export' : 'collect-once')], env);
      if (result?.reason === 'source-circuit-paused') calls.prepaused++;
      return result;
    }, doctor: () => main(['doctor'], env),
      runEntrypoint: () => spawnSync(process.execPath, [path.join(__dirname, 'cli.cjs'), 'collect-once'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 }),
      calls, fixture, outputFile, lockFile, circuitFile, stateDir, env,
      readExport: () => JSON.parse(fs.readFileSync(outputFile, 'utf8')) });
    assert.ok(calls.pools.every(pool => pool.ended), 'every simulated database pool is closed');
    assert.equal(calls.pools.filter(pool => pool.url === fixtureUrl).length, calls.runs - calls.prepaused, 'one fixture pool per unpaused main invocation');
    assert.equal(fs.existsSync(lockFile), false, 'lock is released');
    for (const [signal, count] of signalCounts) assert.equal(process.listenerCount(signal), count, 'signal handlers are removed');
  } finally {
    for (const reset of restore.reverse()) reset();
    // Only remove the exact random directory created by this test, after
    // resolving and checking that it is a direct child of the original temp root.
    const resolved = fs.realpathSync(directory);
    const relative = path.relative(tempBase, resolved);
    assert.ok(relative && !path.isAbsolute(relative) && !relative.includes(path.sep)
      && relative.startsWith('leisu-cli-integration-'), 'cleanup must stay inside this test temporary directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('CLI main simulated browser/database integration (no real collection)', { concurrency: false }, async t => {
  await t.test('success saves the observation, exports it, finishes the run and releases resources', async () => {
    await scenario('success', async ({ run, calls, fixture, readExport }) => {
      const startedAt = Date.now();
      const result = await run();
      assert.equal(result.status, 'completed');
      assert.equal(result.exportedMatches, 1);
      assert.equal(calls.opens, 1);
      assert.equal(calls.collections, 1);
      assert.equal(calls.closes, 1);
      assert.equal(calls.saves.length, 1);
      assert.equal(calls.saves[0].status, 'available');
      assert.deepEqual(calls.finishes, [{ runId: result.runId, status: 'completed' }]);
      const doc = readExport();
      assert.ok(Date.parse(doc.generatedAt) >= startedAt);
      assert.equal(doc.predictionEligible, false);
      assert.deepEqual(doc.items[0].fixture, fixture);
      assert.equal(doc.items[0].evidence.sections.injuries.latestValid.data.injuries[0].name, '模拟球员');
      assert.equal(doc.items[0].evidence.sections.injuries.latestAttempt.status, 'available');
      assert.ok(calls.feeds >= 4, 'feed is reread around collection and export');
    });
  });
  await t.test('no-due still refreshes the export without opening a browser or starting a run', async () => {
    await scenario('no-due', async ({ run, calls, readExport }) => {
      const startedAt = Date.now();
      const result = await run();
      assert.equal(result.status, 'no-due-tasks');
      assert.equal(result.exportedMatches, 1);
      assert.equal(calls.opens, 0);
      assert.equal(calls.collections, 0);
      assert.equal(calls.saves.length, 0);
      assert.equal(calls.starts.length, 0);
      assert.equal(calls.finishes.length, 0);
      const doc = readExport();
      assert.equal(doc.sentinel, undefined);
      assert.ok(Date.parse(doc.generatedAt) >= startedAt);
      assert.equal(doc.items[0].evidence.sections.injuries.latestValid.status, 'available');
    });
  });
  await t.test('blocked response saves NULL, preserves earlier success and pauses subsequent runs', async () => {
    await scenario('blocked', async ({ run, doctor, runEntrypoint, calls, circuitFile, lockFile, readExport }) => {
      const result = await run();
      assert.equal(result.status, 'paused');
      assert.equal(calls.saves.length, 1);
      assert.equal(calls.saves[0].status, 'blocked');
      assert.equal(calls.saves[0].data, null);
      assert.deepEqual(calls.finishes, [{ runId: result.runId, status: 'paused' }]);
      assert.equal(JSON.parse(fs.readFileSync(circuitFile, 'utf8')).paused, true);
      const health = await doctor();
      assert.equal(health.circuitPaused, true);
      assert.equal(health.circuitStatus, 'blocked');
      assert.ok(Number.isFinite(Date.parse(health.circuitSince)));
      const sections = readExport().items[0].evidence.sections;
      assert.equal(sections.injuries.latestValid.status, 'available');
      assert.equal(sections.injuries.latestAttempt.status, 'blocked');
      assert.equal(sections.injuries.latestAttempt.data, null);
      const paused = await run();
      assert.equal(paused.status, 'paused');
      assert.equal(paused.reason, 'source-circuit-paused');
      const entry = runEntrypoint();
      assert.equal(entry.status, 2, entry.stderr);
      assert.equal(JSON.parse(entry.stdout).status, 'paused');
      assert.equal(entry.stderr, '');
      assert.equal(calls.opens, 1);
      assert.equal(calls.collections, 1);
      assert.equal(calls.closes, 1);
      assert.equal(calls.saves.length, 1);
      assert.equal(calls.starts.length, 1);
      assert.equal(calls.finishes.length, 1);
      assert.equal(fs.existsSync(lockFile), false);
    });
  });
  await t.test('one-page budget prioritizes lineup and leaves injuries runnable next time', async () => {
    await scenario('page-budget', async ({ run, calls, readExport }) => {
      const first = await run();
      assert.equal(first.status, 'budget-exhausted');
      assert.equal(first.runtime.pagesStarted, 1);
      assert.equal(first.deferredTasks, 1);
      assert.deepEqual(calls.saves.map(item => item.kind), ['lineup']);
      assert.equal(readExport().items[0].evidence.sections.injuries.latestAttempt, null);
      const second = await run();
      assert.equal(second.status, 'completed');
      assert.deepEqual(calls.saves.map(item => item.kind), ['lineup', 'injuries']);
      assert.equal(calls.opens, 2);
      assert.equal(calls.collections, 2);
      assert.equal(calls.closes, 2);
    });
  });
  await t.test('empty fixture scope skips stale mapping discovery and still exports an empty list', async () => {
    await scenario('empty', async ({ run, calls, readExport }) => {
      const result = await run();
      assert.equal(result.status, 'no-due-tasks');
      assert.equal(result.exportedMatches, 0);
      assert.equal(calls.opens, 0);
      assert.equal(calls.collections, 0);
      assert.equal(calls.saves.length, 0);
      assert.deepEqual(readExport().items, []);
    });
  });
  for (const mode of ['cancel-startup', 'cancel-page']) {
    await t.test(mode + ' stops future pages without recording an aborted observation', async () => {
      await scenario(mode, async ({ run, calls, circuitFile }) => {
        const result = await run();
        assert.equal(result.status, 'cancelled');
        assert.equal(calls.opens, 1);
        assert.equal(calls.closes, 1);
        assert.equal(calls.collections, mode === 'cancel-page' ? 1 : 0);
        assert.equal(calls.saves.length, 0);
        assert.equal(result.deferredTasks, 1);
        assert.equal(calls.finishes[0].status, 'cancelled');
        assert.equal(fs.existsSync(circuitFile), false, 'operator cancellation must not pause source access');
      });
    });
  }
  await t.test('cancellation during the initial fixture query does not start another query pool or browser', async () => {
    await scenario('cancel-feed', async ({ run, calls }) => {
      assert.equal((await run()).status, 'cancelled');
      assert.equal(calls.feeds, 1);
      assert.equal(calls.pools.length, 1);
      assert.equal(calls.opens, 0);
      assert.equal(calls.starts.length, 0);
      assert.equal(calls.saves.length, 0);
    });
  });
  await t.test('discovery continues across runs when page budget is smaller than the league allowlist', async () => {
    await scenario('discovery-budget', async ({ run, calls, stateDir }) => {
      const autoFile = path.join(stateDir, 'auto-mappings.json'), progressFile = path.join(stateDir, 'discovery-progress.json');
      for (let completed = 1; completed <= 2; completed++) {
        const result = await run();
        assert.equal(result.status, 'budget-exhausted');
        assert.equal(result.discoveryPending, true);
        assert.equal(fs.existsSync(autoFile), false, 'partial discovery cannot replace published mappings');
        assert.equal(JSON.parse(fs.readFileSync(progressFile, 'utf8')).completedUrls.length, completed);
      }
      const third = await run();
      assert.equal(third.runtime.pagesStarted, 1);
      assert.equal(third.discoveryPending, false);
      assert.equal(JSON.parse(fs.readFileSync(autoFile, 'utf8')).mappings.length, 1);
      assert.equal(fs.existsSync(progressFile), false);
      assert.equal(new Set(calls.leagues).size, 3);
      assert.equal(calls.leagues.length, 3, 'completed league pages are not revisited');
      assert.equal(calls.collections, 0, 'discovery consumed the first three page budgets');
      await run();
      assert.equal(calls.collections, 1, 'match collection continues after complete discovery');
      assert.equal(calls.saves[0].status, 'available');
    });
  });
  await t.test('known imminent lineup uses the first page before discovery gets remaining budget', async () => {
    await scenario('priority-discovery', async ({ run, calls }) => {
      const result = await run();
      assert.equal(result.runtime.pagesStarted, 2);
      assert.equal(calls.order[0], 'task:lineup');
      assert.match(calls.order[1], /^league:/);
      assert.equal(calls.saves.length, 1);
      assert.equal(calls.saves[0].kind, 'lineup');
    });
  });
  await t.test('cancelled or blocked discovery never advances its completed cursor or publishes partial mappings', async () => {
    await scenario('discovery-budget', async ({ run, calls, stateDir }) => {
      const progressFile = path.join(stateDir, 'discovery-progress.json');
      await run();
      const first = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      calls.cancelNextLeague = true;
      assert.equal((await run()).status, 'cancelled');
      assert.deepEqual(JSON.parse(fs.readFileSync(progressFile, 'utf8')), first);
      calls.blockNextLeague = true;
      assert.equal((await run()).status, 'paused');
      const blocked = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      assert.deepEqual(blocked.completedUrls, first.completedUrls);
      assert.deepEqual(blocked.candidates, first.candidates);
      assert.equal(blocked.failureAttempts.length, 1);
      assert.equal(blocked.failureAttempts[0].httpStatus, 403);
      assert.equal(blocked.failureAttempts[0].status, 'blocked');
      assert.equal(fs.existsSync(path.join(stateDir, 'auto-mappings.json')), false);
    });
  });
  for (const command of ['collect-once', 'discover']) {
    await t.test(command + ': transient discovery persists its reason, waits ten minutes and then completes', async () => {
      await scenario('discovery-retry', async ({ run, calls, stateDir, circuitFile }) => {
        const progressFile = path.join(stateDir, 'discovery-progress.json');
        const autoFile = path.join(stateDir, 'auto-mappings.json');
        calls.leagueFailures.push({ status: 'parse_error', reason: 'non-success-http-status', httpStatus: 503 });
        const first = await run(command);
        assert.notEqual(first.status, 'paused');
        assert.equal(fs.existsSync(circuitFile), false);
        assert.equal(fs.existsSync(autoFile), false);
        const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        assert.deepEqual(progress.completedUrls, []);
        assert.deepEqual(progress.candidates, []);
        assert.equal(progress.failureAttempts.length, 1);
        assert.equal(progress.failureAttempts[0].httpStatus, 503);
        assert.equal(progress.failureAttempts[0].reason, 'non-success-http-status');
        await run(command);
        assert.equal(calls.leagues.length, 1, 'retry wait does not revisit the failed page');
        assert.equal(calls.opens, 1, 'retry wait does not open Chromium');
        // Only the persisted attempt is made old; the clock and fixture stay real.
        progress.failureAttempts[0].receivedAt = new Date(Date.now() - 11 * 60000).toISOString();
        fs.writeFileSync(progressFile, JSON.stringify(progress));
        const recovered = await run(command);
        assert.notEqual(recovered.status, 'paused');
        assert.equal(calls.leagues.length, 2);
        assert.equal(JSON.parse(fs.readFileSync(autoFile, 'utf8')).mappings.length, 1);
        assert.equal(fs.existsSync(progressFile), false);
        assert.equal(fs.existsSync(circuitFile), false);
      });
    });
  }
  await t.test('two failed discovery attempts exhaust the six-hour cursor instead of retrying every timer tick', async () => {
    await scenario('discovery-retry', async ({ run, calls, stateDir, circuitFile }) => {
      const progressFile = path.join(stateDir, 'discovery-progress.json');
      calls.leagueFailures.push({ status: 'parse_error', reason: 'non-success-http-status', httpStatus: 502 },
        { status: 'parse_error', reason: 'page-timeout', httpStatus: 0 });
      await run();
      let progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      progress.failureAttempts[0].receivedAt = new Date(Date.now() - 11 * 60000).toISOString();
      fs.writeFileSync(progressFile, JSON.stringify(progress));
      await run();
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      assert.equal(progress.failureAttempts.length, 2);
      assert.equal(progress.failureAttempts[1].reason, 'page-timeout');
      progress.failureAttempts[1].receivedAt = new Date(Date.now() - 11 * 60000).toISOString();
      fs.writeFileSync(progressFile, JSON.stringify(progress));
      const exhausted = await run();
      assert.equal(exhausted.discoveryPending, true);
      assert.equal(exhausted.discoveryState.deferred[0].reason, 'discovery-retries-exhausted');
      assert.equal(calls.leagues.length, 2);
      assert.equal(calls.opens, 2);
      assert.equal(fs.existsSync(path.join(stateDir, 'auto-mappings.json')), false);
      assert.equal(fs.existsSync(circuitFile), false);
      progress.startedAt = new Date(Date.now() - 6 * 3600000 - 1000).toISOString();
      fs.writeFileSync(progressFile, JSON.stringify(progress));
      await run();
      assert.equal(calls.leagues.length, 3, 'a new six-hour cursor can try again');
      assert.equal(fs.existsSync(path.join(stateDir, 'auto-mappings.json')), true);
    });
  });
  for (const invalidation of ['day', 'allowlist', 'age']) {
    await t.test('discovery cursor invalidation: ' + invalidation, async () => {
      await scenario('discovery-budget', async ({ run, calls, stateDir }) => {
        await run();
        const progressFile = path.join(stateDir, 'discovery-progress.json');
        const saved = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        if (invalidation === 'day') saved.today = '1900-01-01';
        if (invalidation === 'allowlist') saved.leagueUrls = ['https://www.leisu.com/data/zuqiu/comp-999'];
        if (invalidation === 'age') saved.startedAt = new Date(Date.now() - 6 * 3600000 - 1000).toISOString();
        fs.writeFileSync(progressFile, JSON.stringify(saved));
        await run();
        assert.equal(calls.leagues[0], calls.leagues[1], 'invalid progress must restart at the first canonical league');
        assert.equal(JSON.parse(fs.readFileSync(progressFile, 'utf8')).completedUrls.length, 1);
      });
    });
  }
  await t.test('recognized transient page failure saves NULL and retries after backoff without pausing', async () => {
    await scenario('transient', async ({ run, calls, circuitFile }) => {
      const first = await run();
      assert.equal(first.status, 'completed');
      assert.equal(calls.saves[0].status, 'parse_error');
      assert.equal(calls.saves[0].data, null);
      assert.equal(fs.existsSync(circuitFile), false);
      assert.equal((await run()).status, 'no-due-tasks');
      assert.equal(calls.collections, 1);
      // Simulate a database containing the same failed attempt from eleven
      // minutes ago; the application's wall clock and fixture time stay real.
      calls.saves[0].receivedAt = new Date(Date.now() - 11 * 60000).toISOString();
      assert.equal((await run()).status, 'completed');
      assert.equal(calls.collections, 2);
      assert.deepEqual(calls.saves.map(item => item.status), ['parse_error', 'available']);
      assert.equal(fs.existsSync(circuitFile), false);
    });
  });
  for (const mode of ['cancel-export-collect', 'cancel-export-command']) {
    await t.test(mode + ': SIGTERM after the first of two export batches keeps the old file unchanged', async () => {
      await scenario(mode, async ({ run, calls, outputFile, stateDir }) => {
        const oldFile = fs.readFileSync(outputFile);
        const result = await run();
        assert.equal(result.status, 'cancelled');
        assert.equal(result.exportSkipped, 'run-interrupted');
        assert.equal(result.exportedMatches, undefined);
        assert.deepEqual(calls.batchSizes, [500], 'the remaining fixture must not trigger a second batch');
        assert.deepEqual(fs.readFileSync(outputFile), oldFile, 'partial or cancelled exports must not replace the previous document');
        assert.equal(fs.readdirSync(stateDir).some(name => name.endsWith('.tmp')), false);
        if (mode === 'cancel-export-collect') {
          assert.equal(calls.saves.length, 1, 'already finished collection remains stored');
          assert.equal(calls.finishes[0].status, 'cancelled');
        } else {
          assert.equal(calls.opens, 0);
          assert.equal(calls.saves.length, 0);
          assert.equal(calls.starts.length, 0);
        }
      });
    });
  }
});
