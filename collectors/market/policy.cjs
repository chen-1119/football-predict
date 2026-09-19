'use strict';
const { createHash } = require('node:crypto');
const SOURCE = '500.com:jczq';
const { CONTRACT: LOTTERY_SP_CONTRACT } = require('../../src/services/warehouseLotterySp.cjs');
// The root page defaults to single-match HHAD and can be empty while the
// publicly linked mixed-result page contains the day's HAD and HHAD markets.
const DEFAULT_SOURCE_URL = 'https://trade.500.com/jczq/?playid=312&g=2';
const failure = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function integer(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw failure('INVALID_CONFIG', `${name} must be an integer between ${min} and ${max}`);
  return number;
}
function config(env = process.env) {
  const minSeconds = integer(env.MARKET_COLLECTOR_MIN_SECONDS, 60, 60, 21600, 'MIN_SECONDS');
  const maxSeconds = integer(env.MARKET_COLLECTOR_MAX_SECONDS, 1800, minSeconds, 86400, 'MAX_SECONDS');
  const url = new URL(env.FIVE_HUNDRED_JCZQ_URL || DEFAULT_SOURCE_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'trade.500.com' || url.port || url.username || url.password || url.hash
    || !['/jczq/', '/jczq/index.php'].includes(url.pathname)) throw failure('INVALID_SOURCE_URL', 'Use the approved HTTPS JCZQ page');
  return { minSeconds, maxSeconds, sourceUrl: url.href };
}
function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parts = value.slice(0, 10).split('-').map(Number), day = new Date(0);
  day.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || day.getUTCMonth() !== parts[1] - 1 || day.getUTCDate() !== parts[2]) return null;
  // Date.parse allows 24:00 rollover; an observed local clock must be literal.
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function finiteOdd(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? number : null;
}
function handicap(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^[+-]?\d+(?:\.0+)?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? (number === 0 ? 0 : number) : null;
}
function normalizeRows(rows, observedAt) {
  if (!Array.isArray(rows) || instant(observedAt) === null) throw failure('INVALID_INPUT', 'A row array and timezone-explicit receipt time are required');
  const markets = new Map(), rejected = [];
  for (const [index, row] of rows.entries()) {
    const signal = row?.signal || {};
    const sourceMatchId = String(signal.sourceMatchId ?? '').trim();
    const kickoffMs = instant(signal.kickoffTime);
    if (!/^[1-9]\d*$/.test(sourceMatchId) || kickoffMs === null || !text(signal.homeTeamName)
      || !text(signal.awayTeamName) || text(signal.homeTeamName) === text(signal.awayTeamName)) {
      rejected.push({ row: index, reason: 'invalid-fixture' }); continue;
    }
    for (const pool of ['had', 'hhad']) {
      const odds = signal.bookmakerOdds?.[pool];
      if (odds === undefined || odds === null) continue;
      const values = ['odds1', 'oddsX', 'odds2'].map(key => finiteOdd(odds[key]));
      const line = pool === 'hhad' ? handicap(odds.handicapLine ?? signal.handicapLine) : null;
      if (values.includes(null) || (pool === 'hhad' && line === null)) {
        rejected.push({ row: index, pool, reason: values.includes(null) ? 'invalid-odds' : 'unknown-handicap' }); continue;
      }
      const payload = {
        source: SOURCE, sourceMatchId, fixtureId: text(signal.fixtureId), matchNo: text(signal.matchNo),
        matchKeys: Array.isArray(row.keys) ? [...new Set(row.keys.filter(key => typeof key === 'string' && key.trim()))].sort() : [],
        leagueName: text(signal.leagueName), homeTeamName: text(signal.homeTeamName), awayTeamName: text(signal.awayTeamName),
        kickoffTime: new Date(kickoffMs).toISOString(), buyEndTime: text(signal.buyEndTime),
        pool, bookmaker: 'sporttery', handicapLine: line, odds1: values[0], oddsX: values[1], odds2: values[2],
        // Only newly acquired nspf/HAD rows get this schema marker. Old reference rows are not backfilled.
        ...(pool === 'had' && signal.source === SOURCE ? { lotterySpContract: LOTTERY_SP_CONTRACT } : {}),
      };
      const contentHash = hash(payload), key = `${sourceMatchId}|${pool}`;
      if (markets.has(key) && markets.get(key).contentHash !== contentHash) throw failure('CONFLICTING_MARKETS', 'Conflicting prices or event identities within one page');
      markets.set(key, { ...payload, observedAt: new Date(instant(observedAt)).toISOString(), contentHash, payload });
    }
  }
  return { markets: [...markets.values()], rejected };
}
const marketsFromParsedRows = (rows, observedAt) => normalizeRows(rows, observedAt).markets;
function adaptivePollSeconds(markets, nowMs = Date.now(), cfg = config()) {
  const nearest = Math.min(...markets.map(market => instant(market.kickoffTime)).filter(value => value !== null && value > nowMs));
  const minutes = (nearest - nowMs) / 60000;
  const seconds = nearest === Infinity ? 900 : minutes <= 15 ? 60 : minutes <= 60 ? 120
    // Leave room for positive jitter, HTTP latency and the 30-second consumer
    // tick inside the 15-minute SP validity window. Failure backoff is separate.
    : minutes <= 120 ? 300 : minutes <= 1440 ? 600 : 1800;
  return Math.max(cfg.minSeconds, Math.min(cfg.maxSeconds, seconds));
}
function jitteredDelayMs(seconds, random = Math.random, cfg = config()) {
  const value = random();
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(value) || value < 0 || value > 1) throw failure('INVALID_DELAY', 'Invalid delay or random value');
  return Math.max(cfg.minSeconds * 1000, Math.min(cfg.maxSeconds * 1000, Math.round(seconds * 1000 * (0.85 + value * 0.3))));
}
function retryAfterSeconds(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - nowMs) / 1000)) : null;
}
function failureDelaySeconds(error, consecutiveFailures = 1) {
  const blocked = error?.code === 'SOURCE_BLOCKED';
  const ordinary = Math.min(3600, 60 * 2 ** Math.min(6, Math.max(0, consecutiveFailures - 1)));
  const minimum = blocked ? 6 * 3600 : ordinary;
  const sourceDelay = Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
  if (sourceDelay > 2147483647) throw failure('SOURCE_RETRY_TOO_LONG', 'Provider retry requires operator review');
  // Deliberately independent of normal MAX_SECONDS; no negative jitter on backoff.
  return Math.max(minimum, sourceDelay);
}
module.exports = { SOURCE, config, hash, instant, finiteOdd, handicap, normalizeRows, marketsFromParsedRows,
  adaptivePollSeconds, jitteredDelayMs, retryAfterSeconds, failureDelaySeconds, failure };
