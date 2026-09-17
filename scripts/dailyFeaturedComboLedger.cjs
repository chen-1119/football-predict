'use strict';
const crypto = require('node:crypto');
const { VERSION, candidatesFor, choose, canPublish, businessDateFor, timeMs } = require('./independentComboSelection.cjs');
const { persistPublishedForecasts } = require('./publishedForecastLedger.cjs');
const { dataPublishable } = require('../src/services/publishedForecastPolicy.cjs');
const lifecycle = () => require('../src/services/matchLifecycle.cjs');
const shanghaiParts = (now = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
};
function settleEntry(entry, history, settledAt) {
  if (['WON', 'LOST', 'VOID'].includes(entry?.settlement?.status)) return entry;
  if (!Array.isArray(entry?.legs) || !entry.legs.length) throw new Error('Invalid frozen combo');
  if (!history.length) return entry;
  const { eventVersionOf, canonicalSourceMatchId, isOfficialSportteryFinal, isOfficialSportteryVoid } = lifecycle();
  const { parseHandicapLine } = require('../src/services/officialRecommendationEligibility.cjs');
  const results = entry.legs.map(leg => {
    const match = history.find(row => canonicalSourceMatchId(row?.sourceMatchId || row?.id) === leg.sourceMatchId && eventVersionOf(row) === leg.eventVersion && (isOfficialSportteryFinal(row) || isOfficialSportteryVoid(row)));
    if (match && isOfficialSportteryVoid(match)) return { sourceMatchId: leg.sourceMatchId, result: 'VOID', finalScore: null };
    const line = leg.market === 'HHAD' ? parseHandicapLine(leg.handicapLine) : 0;
    const scored = match && Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway) && match.scoreHome >= 0 && match.scoreAway >= 0 && line !== null;
    const actual = scored ? match.scoreHome + line > match.scoreAway ? '1' : match.scoreHome + line < match.scoreAway ? '2' : 'X' : null;
    return { sourceMatchId: leg.sourceMatchId, result: actual ? actual === leg.tipCode ? 'WON' : 'LOST' : 'PENDING', finalScore: scored ? `${match.scoreHome}-${match.scoreAway}` : null };
  });
  const status = results.some(r => r.result === 'VOID') ? 'VOID' : results.some(r => r.result === 'PENDING') ? 'PENDING' : results.every(r => r.result === 'WON') ? 'WON' : 'LOST';
  return { ...entry, settlement: { status, results, settledAt: status === 'PENDING' ? null : settledAt } };
}
function summarize(entries, size, track = null) {
  const rows = entries.filter(e => e.size === size && (!track || e.statisticsTrack === track));
  const settled = rows.filter(e => ['WON', 'LOST'].includes(e?.settlement?.status));
  const won = settled.filter(e => e.settlement.status === 'WON').length;
  return { published: rows.length, settled: settled.length, won, lost: settled.length - won, void: rows.filter(e => e?.settlement?.status === 'VOID').length, hitRate: settled.length ? Number((won / settled.length).toFixed(4)) : null };
}
function previewStillAuditable(preview, now) {
  if (!preview || !Array.isArray(preview.legs) || !preview.legs.length) return false;
  const freezeAt = timeMs(preview.freezeAt), updatedAt = timeMs(preview.generatedAt || preview.evaluatedAt || preview.legs[0]?.evaluatedAt);
  if (!Number.isFinite(freezeAt) || !Number.isFinite(updatedAt) || updatedAt > freezeAt || updatedAt > now || now - updatedAt > 15 * 60000) return false;
  return preview.legs.every(leg => {
    const quoteAt = timeMs(leg.quoteObservedAt), cutoff = timeMs(leg.cutoffTime), kickoff = timeMs(leg.kickoffTime);
    return Number.isFinite(quoteAt) && Number.isFinite(cutoff) && Number.isFinite(kickoff) && quoteAt < cutoff && updatedAt < cutoff && updatedAt < kickoff && now < cutoff && now < kickoff;
  });
}
function buildFrozenEntry({ selection, clock, now, publication }) {
  const frozenAt = new Date(now).toISOString();
  const id = crypto.createHash('sha256').update(JSON.stringify({ businessDate: clock.date, size: selection.size, frozenAt, selectionPolicy: selection.selectionPolicy, legs: selection.legs.map(l => [l.sourceMatchId, l.eventVersion, l.tipCode, l.odds, l.quoteHash, l.modelGeneratedAt]) })).digest('hex');
  return { version: 'daily-featured-combo-v3', id: `combo:${id}`, businessDate: clock.date, frozenAt, publication, ...selection, settlement: { status: 'PENDING', settledAt: null } };
}
function buildLedger({ now = Date.now(), current, history, entries: priorEntries, priorState = null, publishable = false, publication }) {
  if (![current, history, priorEntries].every(Array.isArray) || !Number.isFinite(now)) throw new Error('Invalid combo inputs; refusing to replace ledger');
  const clock = shanghaiParts(now);
  let entries = [...priorEntries];
  const candidates = candidatesFor(publishable ? current.filter(match => businessDateFor(match) === clock.date) : [], now);
  const selections = Object.fromEntries([2, 3].map(size => [size, choose(candidates, size)]));
  const priorBySize = new Map(priorState?.businessDate === clock.date && Array.isArray(priorState?.previews) ? priorState.previews.map(row => [row.size, row]) : []);
  for (const size of [2, 3]) {
    if (entries.some(e => e.businessDate === clock.date && e.size === size)) continue;
    const prior = priorBySize.get(size), selection = selections[size] || (previewStillAuditable(prior, now) ? prior : null);
    if (!selection || !Number.isFinite(timeMs(selection.freezeAt)) || now < timeMs(selection.freezeAt)) continue;
    if (!selection.legs.every(l => now < timeMs(l.cutoffTime) && now < timeMs(l.kickoffTime))) continue;
    entries.push(buildFrozenEntry({ selection, clock, now, publication }));
  }
  const stamp = new Date(now).toISOString();
  entries = entries.map(e => settleEntry(e, history, stamp));
  const today = entries.filter(e => e.businessDate === clock.date);
  return { entries, publicPayload: {
    version: 'daily-featured-combo-public-v3', updatedAt: stamp, businessDate: clock.date, source: 'postgres', publishable, publication,
    selectionPolicy: VERSION, statisticsTrack: 'independent-combo-v2', candidateCount: candidates.length, previewStatus: publishable ? 'evaluated' : 'data-unavailable',
    previews: [2, 3].filter(size => !today.some(e => e.size === size)).map(size => selections[size]).filter(Boolean).map(s => ({ ...s, generatedAt: stamp })), today,
    statistics: { two: summarize(entries, 2), three: summarize(entries, 3) },
    independentStatistics: { two: summarize(entries, 2, 'independent-combo-v2'), three: summarize(entries, 3, 'independent-combo-v2') },
    policy: { selection: 'robust-model-market-had-ensemble', requiresFormalRecommendation: false, twoMinimumSp: 2.5, threeMinimumSp: 5, scheduledFreeze: 'weekday-21:00/weekend-22:00 Asia/Shanghai', earlyFreeze: '5 minutes before earliest selected leg cutoff when earlier', forcedOutput: false, immutableDirections: true, calibratedParlayProbability: false, voidPolicy: 'any-official-void-excludes-combo-from-hit-rate' },
  } };
}
async function persistLedger(client, options) {
  const previous = await client.query('SELECT payload, settlement FROM football.daily_featured_combos ORDER BY business_date, size');
  const previousState = await client.query('SELECT payload FROM football.daily_featured_combo_state WHERE id=1');
  const prior = previous.rows.map(row => ({ ...row.payload, settlement: row.settlement }));
  const result = buildLedger({ ...options, entries: prior, priorState: previousState.rows[0]?.payload || null });
  for (const entry of result.entries) {
    const { settlement, ...payload } = entry, old = prior.find(r => r.id === entry.id);
    if (!old) await client.query('INSERT INTO football.daily_featured_combos(id,business_date,size,payload,settlement) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)', [entry.id, entry.businessDate, entry.size, JSON.stringify(payload), JSON.stringify(settlement)]);
    else if (JSON.stringify(old.settlement) !== JSON.stringify(settlement)) await client.query('UPDATE football.daily_featured_combos SET settlement=$2::jsonb WHERE id=$1', [entry.id, JSON.stringify(settlement)]);
  }
  const validators = options.resultValidators || { isFinal: lifecycle().isOfficialSportteryFinal, isVoid: lifecycle().isOfficialSportteryVoid };
  result.publicPayload.publishedForecasts = await persistPublishedForecasts(client, {
    current: options.current, history: options.history, publication: options.publication,
    publishable: options.forecastPublishable === true, now: options.now, clock: options.clock, validators,
  });
  await client.query('INSERT INTO football.daily_featured_combo_state(id,payload) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload', [JSON.stringify(result.publicPayload)]);
  return result.publicPayload;
}
async function run({ now } = {}) {
  const { createPostgresPool, withPostgresTransaction } = require('../server/postgresStore.cjs');
  const { readPostgresPublicationIdentity } = require('../server/postgresProjectionStore.cjs');
  const base = `http://127.0.0.1:${Number(process.env.PORT || 8788)}`;
  const read = async route => { const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(`Readiness unavailable: ${response.status}`); return response.json(); };
  const pool = createPostgresPool({ max: 1, applicationName: 'football-featured-combos' });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [health, meta] = await Promise.all([read('/api/v1/health'), read('/api/v1/sync-meta')]);
      let commitDeadline = null;
      try {
        return await withPostgresTransaction(pool, async client => {
          // Use the deployed v2 lock name to serialize old and new workers during rollout.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('daily-featured-combos-v2'))");
          const identity = await readPostgresPublicationIdentity(client);
          if (!identity.available || !identity.publication?.manifestHash) throw new Error('PostgreSQL publication unavailable');
          const rows = await client.query("SELECT dataset,payload FROM football.match_snapshots WHERE dataset IN ('current','history')");
          const clock = () => now ?? Date.now(), evaluatedAt = clock();
          const payload = await persistLedger(client, {
            now: evaluatedAt, clock, publication: identity.publication,
            publishable: canPublish(health, meta, identity.publication, evaluatedAt),
            forecastPublishable: dataPublishable(meta, identity.publication, evaluatedAt),
            current: rows.rows.filter(row => row.dataset === 'current').map(row => row.payload),
            history: rows.rows.filter(row => row.dataset === 'history').map(row => row.payload),
          });
          commitDeadline = payload.publishedForecasts?.commitDeadline;
          return payload;
        }, { beforeCommit: () => { if (commitDeadline && (now ?? Date.now()) >= Date.parse(commitDeadline)) throw new Error('Forecast cutoff crossed before commit'); } });
      } catch (error) { if (error?.code !== '40001' || attempt === 2) throw error; }
    }
    throw new Error('Transaction retries exhausted');
  } finally { await pool.end(); }
}
if (require.main === module) run().then(payload => console.log(JSON.stringify(payload))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, buildLedger, persistLedger, settleEntry, summarize, shanghaiParts, previewStillAuditable };
