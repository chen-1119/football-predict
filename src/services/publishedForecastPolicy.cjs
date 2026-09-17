'use strict';

const crypto = require('node:crypto');
const POLICY = 'published-forecast-v1';
const TRACK = 'published-forecast';
const CODES = Object.freeze(['1', 'X', '2']);
const OFFSET = 8 * 3600000;
const text = v => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
const numeric = v => (typeof v === 'number' || (typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()))) && Number.isFinite(Number(v)) ? Number(v) : null;
function time(v) {
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(s)) return NaN;
  const d = s.slice(0, 10), ms = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== d) return NaN;
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}+08:00`);
}
const iso = v => Number.isFinite(time(v)) ? new Date(time(v)).toISOString() : null;
const day = now => new Date(now + OFFSET).toISOString().slice(0, 10);
const sourceId = v => text(v).replace(/^sporttery_/, '');
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])]));
  return v;
}
const hash = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function probabilities(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = [v.home ?? v['1'], v.draw ?? v.X, v.away ?? v['2']].map(numeric);
  if (raw.some(x => x === null || x < 0)) return null;
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(Math.abs(total - 1) <= .02 || Math.abs(total - 100) <= .5)) return null;
  // Normalize by the actual total even when percentages have been rounded.
  return Object.fromEntries(CODES.map((c, i) => [c, raw[i] / total]));
}
function dataPublishable(meta, publication, now) {
  const stamp = time(meta?.api?.currentFreshnessTime || meta?.updatedAt);
  return Number.isFinite(now) && Number.isFinite(stamp) && stamp <= now && now - stamp <= 15 * 60000
    && meta?.api?.currentStale !== true
    && /^[a-f0-9]{64}$/.test(text(publication?.manifestHash)) && Boolean(text(publication?.generationId))
    && meta?.publication?.manifestHash === publication.manifestHash
    && meta?.publication?.generationId === publication.generationId;
}
function evaluateForecast(match, { now, publication } = {}) {
  match = require('./prospectiveForecastInput.cjs').forecastInputFor(match);
  const fail = reason => ({ eligible: false, reason, candidate: null });
  if (!Number.isFinite(now)) return fail('clock-invalid');
  if (match?.status !== 'SCHEDULED' || match.resultDisposition === 'VOID') return fail('not-pregame');
  if (match.isOnSale === false || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(text(match.saleStatus).toUpperCase())) return fail('not-on-sale');
  if (!text(match.id) || !sourceId(match.sourceMatchId || match.id)) return fail('identity-missing');
  if (![match.homeTeamId, match.awayTeamId, match.homeTeamName, match.awayTeamName].every(text) || match.homeTeamId === match.awayTeamId) return fail('team-identity-invalid');
  const kickoff = time(match.kickoffTime), eventVersion = iso(match.eventVersion || match.kickoffTime);
  if (!Number.isFinite(kickoff) || !eventVersion || time(eventVersion) !== kickoff) return fail('event-version-conflict');
  const businessDate = text(match.businessDate || match.matchDate || match.kickoffDate).slice(0, 10) || day(kickoff);
  if (businessDate !== day(now)) return fail('different-business-day');
  const midnight = Date.parse(`${businessDate}T00:00:00+08:00`);
  const dow = new Date(midnight + OFFSET).getUTCDay();
  const deadlines = [kickoff, midnight + ([0, 6].includes(dow) ? 23 : 22) * 3600000];
  for (const v of [match.buyEndTime, match.predictionMeta?.cutoffTime]) {
    if (v == null || v === '') continue;
    if (!Number.isFinite(time(v))) return fail('cutoff-invalid');
    deadlines.push(time(v));
  }
  const deadline = Math.min(...deadlines);
  if (now >= deadline) return fail('after-cutoff');
  if (!/^[a-f0-9]{64}$/.test(text(publication?.manifestHash)) || !text(publication?.generationId)) return fail('publication-identity-missing');
  const model = match.probabilityModel;
  const p = probabilities(model?.oneXTwo?.final);
  const modelAt = time(model?.generatedAt || match.predictionMeta?.generatedAt);
  const ageLimit = kickoff - now <= 2 * 3600000 ? 3600000 : kickoff - now <= 6 * 3600000 ? 3 * 3600000 : 12 * 3600000;
  if (!p || !Number.isFinite(modelAt) || modelAt > now || modelAt >= deadline || now - modelAt > ageLimit) return fail('model-data-invalid-or-stale');
  if (model.eventVersion && iso(model.eventVersion) !== eventVersion) return fail('model-event-conflict');
  if (model.sourceMatchId && sourceId(model.sourceMatchId) !== sourceId(match.sourceMatchId || match.id)) return fail('model-match-conflict');
  const ranked = CODES.slice().sort((a, b) => p[b] - p[a]);
  if (p[ranked[0]] - p[ranked[1]] <= 1e-9) return fail('no-unique-first-direction');
  const had = match.externalSignals?.bookmakerOdds?.had;
  const candidates = [
    { odds: match.odds, source: match.oddsSource, at: match.oddsReceivedAt || match.oddsUpdatedAt, id: match.sourceMatchId, event: match.eventVersion },
    { odds: had, source: had?.source, at: had?.receivedAt || had?.updatedAt, id: had?.sourceMatchId, event: had?.eventVersion },
  ].map(q => ({ ...q, atMs: time(q.at), values: [q.odds?.odds1, q.odds?.oddsX, q.odds?.odds2].map(numeric) }))
    .filter(q => /^sporttery:had(?:$|:)/i.test(text(q.source)) && q.values.every(v => v !== null && v > 1)
      && Number.isFinite(q.atMs) && q.atMs <= now && q.atMs < deadline && now - q.atMs <= 15 * 60000
      && (!q.id || sourceId(q.id) === sourceId(match.sourceMatchId || match.id)) && (!q.event || iso(q.event) === eventVersion))
    .sort((a, b) => b.atMs - a.atMs);
  const q = candidates[0];
  if (!q) return fail('official-had-quote-unavailable');
  const odds = Object.fromEntries(CODES.map((c, i) => [c, q.values[i]]));
  const inverseTotal = q.values.reduce((sum, v) => sum + 1 / v, 0);
  const market = Object.fromEntries(CODES.map(c => [c, (1 / odds[c]) / inverseTotal]));
  const tipCode = ranked[0];
  return { eligible: true, reason: 'ready-for-publication', candidate: {
    policyVersion: POLICY, statisticsTrack: TRACK, matchId: text(match.id), sourceMatchId: sourceId(match.sourceMatchId || match.id),
    eventVersion, businessDate, kickoffTime: new Date(kickoff).toISOString(), cutoffTime: new Date(deadline).toISOString(),
    matchNo: text(match.matchNo || match.matchNumStr || match.matchNum) || null,
    homeTeamId: text(match.homeTeamId), awayTeamId: text(match.awayTeamId), homeTeamName: text(match.homeTeamName), awayTeamName: text(match.awayTeamName),
    leagueId: text(match.leagueId) || null, market: 'HAD', handicapLine: 0, tipCode, odds: odds[tipCode], probabilities: p,
    marketProbabilities: market, modelProbability: p[tipCode], modelMarketGap: p[tipCode] - market[tipCode],
    modelExpectedValue: p[tipCode] * odds[tipCode] - 1, modelValidation: 'unvalidated',
    sourceVerification: 'source-label-and-publication-binding',
    modelGeneratedAt: new Date(modelAt).toISOString(), quoteSource: q.source, quoteObservedAt: new Date(q.atMs).toISOString(), quoteOdds: odds,
    publication: { generationId: publication.generationId, manifestHash: publication.manifestHash },
    inputHash: hash({ id: match.id, eventVersion, p, odds, quoteAt: q.atMs, modelAt }),
  } };
}
function buildRecord(candidate, now) {
  if (!candidate || candidate.statisticsTrack !== TRACK || now < time(candidate.modelGeneratedAt)
    || now < time(candidate.quoteObservedAt) || now >= time(candidate.cutoffTime)) throw new Error('Invalid publication clock');
  const id = `forecast_${hash([TRACK, candidate.sourceMatchId, candidate.eventVersion, candidate.market])}`;
  const payload = { ...candidate, id, publishedAt: new Date(now).toISOString(), publicationStatus: 'PUBLISHED', immutable: true };
  const result = structuredClone({ ...payload, recordHash: hash(payload) });
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(result);
}
function verifyRecord(record) {
  if (!record || record.policyVersion !== POLICY || record.statisticsTrack !== TRACK || record.publicationStatus !== 'PUBLISHED'
    || record.market !== 'HAD' || record.handicapLine !== 0 || record.modelValidation !== 'unvalidated' || record.immutable !== true) return false;
  const { recordHash, ...payload } = record;
  const p = probabilities(record.probabilities), market = probabilities(record.marketProbabilities);
  if (!p || !market || !CODES.includes(record.tipCode) || numeric(record.odds) === null || record.odds <= 1) return false;
  if (!record.quoteOdds || CODES.some(c => numeric(record.quoteOdds[c]) === null || record.quoteOdds[c] <= 1)) return false;
  if (record.quoteOdds[record.tipCode] !== record.odds || Math.abs(record.modelProbability - p[record.tipCode]) > 1e-9) return false;
  if (!/^[a-f0-9]{64}$/.test(text(record.publication?.manifestHash)) || !text(record.publication?.generationId)) return false;
  if (!/^[a-f0-9]{64}$/.test(text(record.inputHash))) return false;
  const published = time(record.publishedAt);
  return Boolean(recordHash === hash(payload)
    && published < time(record.cutoffTime) && published < time(record.kickoffTime)
    && time(record.quoteObservedAt) <= published && time(record.modelGeneratedAt) <= published
    && CODES.every(c => c === record.tipCode || p[record.tipCode] - p[c] > 1e-9)
    && record.id === `forecast_${hash([TRACK, record.sourceMatchId, record.eventVersion, record.market])}`);
}
function evaluateBatch(matches, context) {
  const groups = new Map(), reasons = {}, candidates = [];
  for (const m of matches || []) { const key = sourceId(m?.sourceMatchId || m?.id); const rows = groups.get(key) || []; rows.push(m); groups.set(key, rows); }
  for (const rows of groups.values()) {
    if (new Set(rows.map(m => JSON.stringify([iso(m?.eventVersion || m?.kickoffTime), m?.homeTeamId, m?.awayTeamId]))).size !== 1) { reasons['conflicting-event-identity'] = (reasons['conflicting-event-identity'] || 0) + 1; continue; }
    const assessed = rows.map(m => evaluateForecast(m, context));
    const accepted = assessed.filter(x => x.eligible).map(x => x.candidate).sort((a, b) => time(b.modelGeneratedAt) - time(a.modelGeneratedAt) || time(b.quoteObservedAt) - time(a.quoteObservedAt));
    if (accepted[0]) candidates.push(accepted[0]);
    else { const reason = assessed[0]?.reason || 'empty'; reasons[reason] = (reasons[reason] || 0) + 1; }
  }
  return { candidates: candidates.sort((a, b) => time(a.kickoffTime) - time(b.kickoffTime) || a.sourceMatchId.localeCompare(b.sourceMatchId)), reasons };
}
module.exports = { POLICY, TRACK, CODES, probabilities, evaluateForecast, evaluateBatch, buildRecord, verifyRecord, dataPublishable, time, iso, day, hash };
