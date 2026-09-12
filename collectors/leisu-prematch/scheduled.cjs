'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cli = require('./cli.cjs'), store = require('./store.cjs'), browser = require('./browser.cjs');
const { selectFixtures } = require('./scope.cjs');
const STRATEGY = Object.freeze({ timezone: 'Asia/Shanghai', days: 2, checkMinutes: 5,
  injuriesEveryHours: 6, lineupMinutesBeforeKickoff: [90, 60, 30, 20, 10],
  maximumPages: 12, maximumSeconds: 480, automaticOdds: false });
function retryDelay(state) { return ['blocked', 'login_required', 'collection-paused'].includes(state) ? 6 * 3600000 : 5 * 60000; }
function atomic(file, value) {
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(temporary, file);
}
async function tick(env = process.env, overrides = {}) {
  const cfg = cli.config(env), publicDir = env.LEISU_PUBLIC_DIR || path.join(cfg.stateDir, 'public');
  const now = overrides.now || Date.now, open = overrides.openBrowser || browser.openBrowser;
  const readFeed = overrides.readFeed || store.readFixtureFeed, collectLeague = overrides.collectLeague || browser.collectLeague;
  const createPool = overrides.createPool || store.createPool, collect = overrides.collect || cli.main;
  const statusFile = path.join(publicDir, 'collection-status.json');
  fs.mkdirSync(publicDir, { recursive: true });
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
  const base = { version: 'prematch-scheduler-v1', enabled: cfg.enabled, predictionEligible: false,
    strategy: { ...STRATEGY, maximumPages: cfg.maxPages, maximumSeconds: cfg.maxRunSeconds },
    checkedAt: new Date(now()).toISOString(), lastSuccessAt: previous?.lastSuccessAt || null };
  if (!cfg.enabled) { const result = { ...base, state: 'disabled' }; atomic(statusFile, result); return result; }
  const coolingDown = Date.parse(previous?.nextAttemptAt) > now();
  const lockFile = path.join(cfg.stateDir, 'scheduled.lock');
  let lock;
  try { lock = fs.openSync(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { ...base, state: 'running' }; throw error; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: base.checkedAt }));
  if (coolingDown) {
    // Provider backoff must not freeze the independent PostgreSQL input status.
    // Keep the real source attempt and retry times; this is only a local read.
    let fixturePool;
    const result = { ...previous, ...base };
    try {
      fixturePool = createPool(cfg.fixtureUrl);
      const feed = await readFeed(fixturePool, cfg.maxAge);
      result.fixtureInput = { state: 'available', generatedAt: feed.generatedAt,
        eligibleMatches: selectFixtures(feed.matches, now()).selected.length };
    } catch (error) {
      result.fixtureInput = { state: /stale/i.test(error.message) ? 'stale' : 'unavailable' };
    } finally {
      try {
        await fixturePool?.end().catch(() => {});
        atomic(statusFile, result);
      } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
    }
    return result;
  }
  let pool, fixturePool, context;
  const runId = crypto.randomUUID(), startedAt = new Date(now()).toISOString();
  const result = { ...base, runId, lastRunAt: startedAt, state: 'running', sourceAccess: null, fixtureInput: null };
  atomic(statusFile, result);
  try {
    pool = createPool(cfg.databaseUrl); fixturePool = createPool(cfg.fixtureUrl);
    let feed;
    try { feed = await readFeed(fixturePool, cfg.maxAge); result.fixtureInput = { state: 'available', generatedAt: feed.generatedAt,
      eligibleMatches: selectFixtures(feed.matches, now()).selected.length }; }
    catch (error) { result.fixtureInput = { state: /stale/i.test(error.message) ? 'stale' : 'unavailable' }; }
    if (!cfg.leagueUrls.length) throw new Error('league-not-configured');
    if (feed && result.fixtureInput.eligibleMatches === 0) { result.state = 'no-due-tasks'; return result; }
    context = await open(cfg.profileDir, cfg.headless);
    const access = await collectLeague(context, cfg.leagueUrls[0]);
    result.sourceAccess = { state: access.status, httpStatus: access.httpStatus || null, checkedAt: new Date(now()).toISOString() };
    await context.close(); context = null;
    if (access.status !== 'available') result.state = ['blocked', 'login_required'].includes(access.status) ? access.status : 'source-unavailable';
    else if (!feed) result.state = result.fixtureInput.state === 'stale' ? 'fixture-stale' : 'fixture-unavailable';
    else if (cfg.maxPages < 2 || cfg.maxRunSeconds - (now() - Date.parse(startedAt)) / 1000 < 60) result.state = 'budget-exhausted';
    else {
      // This flag describes the successful browser probe performed above.
      // It never turns collected information into an eligible prediction.
      const collected = await collect(['collect-once'], { ...env, LEISU_ACCESS_VALIDATED: '1', LEISU_MAX_PAGES_PER_RUN: String(cfg.maxPages - 1), LEISU_MAX_RUN_SECONDS: String(Math.floor(cfg.maxRunSeconds - (now() - Date.parse(startedAt)) / 1000)) });
      result.state = collected?.status === 'paused' ? 'collection-paused' : collected?.status || 'completed';
      result.collectedRows = (collected?.results || []).filter(row => row.status === 'available').length;
      result.exportedMatches = collected?.exportedMatches || 0;
      if (collected?.outputFile && !collected.exportSkipped) {
        const stat = fs.statSync(cfg.outputFile);
        if (stat.size > 10 * 1024 ** 2) throw new Error('export-too-large');
        const exported = JSON.parse(fs.readFileSync(cfg.outputFile, 'utf8'));
        if (exported.predictionEligible !== false) throw new Error('invalid-export');
        atomic(path.join(publicDir, 'latest-evidence.json'), exported);
      }
      if (['completed', 'no-due-tasks'].includes(result.state)) result.lastSuccessAt = new Date(now()).toISOString();
    }
  } catch (error) {
    result.state = /Executable doesn't exist|browser.*not found/i.test(error.message) ? 'browser-unavailable' : 'runtime-error';
  } finally {
    if (context) await context.close().catch(() => {});
    result.finishedAt = new Date(now()).toISOString();
    result.nextAttemptAt = new Date(now() + retryDelay(result.state)).toISOString();
    try {
      if (pool) await pool.query(`INSERT INTO leisu_prematch.scheduler_runs
        (run_id, started_at, finished_at, status, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [runId, startedAt, result.finishedAt, result.state, JSON.stringify(result)]);
      else result.databaseStatus = 'unavailable';
    } catch { result.databaseStatus = 'unavailable'; }
    atomic(statusFile, result);
    await Promise.allSettled([pool?.end(), fixturePool?.end()]);
    fs.closeSync(lock); fs.unlinkSync(lockFile);
  }
  return result;
}
module.exports = { STRATEGY, retryDelay, tick };
if (require.main === module) tick().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ ok: false, state: 'scheduler-error', error: error.code || 'runtime-error' })); process.exitCode = 1;
});
