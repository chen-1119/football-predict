'use strict';
const { TRACK, CODES, evaluateBatch, buildRecord, verifyRecord, hash, time, iso, day } = require('../src/services/publishedForecastPolicy.cjs');
const keyFor = row => `${String(row?.sourceMatchId || row?.id || '').replace(/^sporttery_/, '')}@${iso(row?.eventVersion || row?.kickoffTime)}`;
const revisionFor = row => Number.isSafeInteger(row?.resultRevision) && row.resultRevision >= 0 ? row.resultRevision
  : Number.isSafeInteger(row?.postMatchReview?.settlement?.resultRevision) ? row.postMatchReview.settlement.resultRevision : 0;
function indexResults(history, { isFinal, isVoid }) {
  const result = new Map();
  for (const row of history) {
    if (!row || (!isFinal(row) && !isVoid(row))) continue;
    const key = keyFor(row), rows = result.get(key) || [];
    rows.push(row); result.set(key, rows);
  }
  return result;
}
function settlementFor(record, index, { isFinal, isVoid }, now) {
  if (now < time(record.eventVersion)) return null;
  const rows = (index.get(keyFor(record)) || []).filter(row =>
    (!row.homeTeamId || row.homeTeamId === record.homeTeamId) && (!row.awayTeamId || row.awayTeamId === record.awayTeamId));
  if (!rows.length) return null;
  const revision = Math.max(...rows.map(revisionFor));
  const latest = rows.filter(row => revisionFor(row) === revision);
  const outcomes = latest.map(row => {
    if (isVoid(row)) return { state: 'VOID', actual: null, score: null };
    if (!isFinal(row) || !Number.isInteger(row.scoreHome) || !Number.isInteger(row.scoreAway) || row.scoreHome < 0 || row.scoreAway < 0) return null;
    const actual = row.scoreHome > row.scoreAway ? '1' : row.scoreHome < row.scoreAway ? '2' : 'X';
    return { state: actual === record.tipCode ? 'WON' : 'LOST', actual, score: `${row.scoreHome}-${row.scoreAway}` };
  }).filter(Boolean);
  if (!outcomes.length) return null;
  const unique = new Set(outcomes.map(hash));
  const outcome = unique.size === 1 ? outcomes[0] : { state: 'DISPUTED', actual: null, score: null };
  const evidence = latest.map(row => ({ source: row.resultSource || row.voidSource || null, observedAt: row.resultObservedAt || null, revision, scoreHome: row.scoreHome ?? null, scoreAway: row.scoreAway ?? null, void: isVoid(row) })).sort((a, b) => hash(a).localeCompare(hash(b)));
  return { ...outcome, resultRevision: revision, evidenceHash: hash(evidence) };
}
function summarize(rows) {
  const settled = rows.filter(r => ['WON','LOST'].includes(r.settlement?.state));
  const won = settled.filter(r => r.settlement.state === 'WON').length;
  let brier = 0, logLoss = 0, marketBrier = 0, scored = 0;
  const bins = Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, count: 0, sumProbability: 0, wins: 0 }));
  for (const { forecast, settlement } of settled) {
    if (!verifyRecord(forecast) || !CODES.includes(settlement.actual)) continue;
    const actual = settlement.actual;
    brier += CODES.reduce((sum, c) => sum + (forecast.probabilities[c] - Number(c === actual)) ** 2, 0);
    marketBrier += CODES.reduce((sum, c) => sum + (forecast.marketProbabilities[c] - Number(c === actual)) ** 2, 0);
    logLoss -= Math.log(Math.max(1e-15, forecast.probabilities[actual])); scored++;
    const bin = bins[Math.min(9, Math.floor(forecast.modelProbability * 10))];
    bin.count++; bin.sumProbability += forecast.modelProbability; bin.wins += Number(settlement.state === 'WON');
  }
  return { published: rows.length, settled: settled.length, won, lost: settled.length - won,
    pending: rows.filter(r => !r.settlement).length, void: rows.filter(r => r.settlement?.state === 'VOID').length,
    disputed: rows.filter(r => r.settlement?.state === 'DISPUTED').length, hitRate: settled.length ? won / settled.length : null,
    scored, brier: scored ? brier / scored : null, logLoss: scored ? logLoss / scored : null,
    marketBrier: scored ? marketBrier / scored : null, logLossEpsilon: 1e-15,
    reliability: bins.map(b => ({ lower: b.lower, upper: b.upper, count: b.count, meanProbability: b.count ? b.sumProbability / b.count : null, hitRate: b.count ? b.wins / b.count : null })) };
}
async function persistPublishedForecasts(client, { current, history, publication, publishable, now, clock = () => now, validators }) {
  if (![current, history].every(Array.isArray) || !Number.isFinite(now)) throw new Error('Invalid forecast inputs');
  // The caller owns the transaction and the product publication lock.
  const previous = (await client.query('SELECT payload FROM football.published_forecasts ORDER BY published_at, id')).rows.map(r => r.payload);
  if (previous.some(record => !verifyRecord(record))) throw new Error('Published forecast integrity failure');
  const existing = new Set(previous.map(r => r.id));
  const assessment = publishable ? evaluateBatch(current, { now, publication }) : { candidates: [], reasons: { 'data-unavailable': current.length } };
  const created = [];
  for (const candidate of assessment.candidates) {
    const stamp = clock();
    if (!Number.isFinite(stamp) || stamp < now || stamp >= time(candidate.cutoffTime)) continue;
    const record = buildRecord(candidate, stamp);
    if (!verifyRecord(record)) throw new Error('Invalid new forecast');
    if (existing.has(record.id)) continue;
    const inserted = await client.query(`INSERT INTO football.published_forecasts
      (id,source_match_id,event_version,market,business_date,published_at,cutoff_at,record_hash,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (source_match_id,event_version,market) DO NOTHING RETURNING payload`,
      [record.id,record.sourceMatchId,record.eventVersion,record.market,record.businessDate,record.publishedAt,record.cutoffTime,record.recordHash,JSON.stringify(record)]);
    if (inserted.rows.length) { created.push(inserted.rows[0].payload); existing.add(record.id); }
  }
  // Re-read persisted rows; drafts never become API publications merely because evaluation passed.
  const records = (await client.query('SELECT payload FROM football.published_forecasts ORDER BY published_at, id')).rows.map(r => r.payload);
  if (records.some(r => !verifyRecord(r)) || created.some(r => !records.some(stored => stored.id === r.id && stored.recordHash === r.recordHash))) throw new Error('Forecast read-back failed');
  const previousResults = (await client.query('SELECT DISTINCT ON (forecast_id) forecast_id, payload FROM football.published_forecast_results ORDER BY forecast_id, sequence DESC')).rows;
  const byId = new Map(previousResults.map(r => [r.forecast_id, r.payload]));
  const index = indexResults(history, validators);
  for (const record of records) {
    const next = settlementFor(record, index, validators, now), old = byId.get(record.id);
    if (!next || next.resultRevision < (old?.resultRevision || 0) || hash(next) === old?.resultHash) continue;
    const resultHash = hash(next);
    const previousEventId = old?.eventId || (old ? hash([record.id, old.resultHash, old.recordedAt]) : null);
    const id = `result_${hash([record.id, resultHash, previousEventId])}`;
    const payload = { ...next, resultHash, eventId: id, previousEventId, recordedAt: new Date(now).toISOString() };
    await client.query(`INSERT INTO football.published_forecast_results(id,forecast_id,state,result_hash,observed_at,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`, [id,record.id,next.state,resultHash,payload.recordedAt,JSON.stringify(payload)]);
    byId.set(record.id, payload);
  }
  const rows = records.map(forecast => ({ forecast, settlement: byId.get(forecast.id) || null }));
  const summary = summarize(rows);
  const recent = days => summarize(rows.filter(r => time(r.forecast.publishedAt) >= now - days * 86400000));
  const asOf = clock();
  if (!Number.isFinite(asOf) || created.some(r => asOf >= time(r.cutoffTime))) throw Object.assign(new Error('Publication crossed cutoff before commit'), { code: 'FORECAST_CUTOFF_CROSSED' });
  return { version: 'published-forecast-public-v1', track: TRACK, updatedAt: new Date(asOf).toISOString(),
    businessDate: day(now), current: rows.filter(r => r.forecast.businessDate === day(now)),
    history: rows.slice().reverse().slice(0, 100), historyLimit: 100, summary, rolling: { days7: recent(7), days30: recent(30) },
    evaluation: { attempted: current.length, eligible: assessment.candidates.length, newlyPublished: created.length, reasons: assessment.reasons },
    modelValidation: 'unvalidated', oldRecordsReclassified: 0,
    commitDeadline: created.length ? new Date(Math.min(...created.map(r => time(r.cutoffTime)))).toISOString() : null };
}
module.exports = { persistPublishedForecasts, settlementFor, indexResults, summarize };
