'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { finiteOdd, handicap: parseHandicap } = require('../collectors/market/policy.cjs');
const { sourceInstant: instant } = require('./sourceClock.cjs');
const FIELDS = ['schedule', 'officialSP', 'officialHhadSP', 'lineup', 'injuries', 'players', 'weather', 'realXg'];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const clock = value => instant(value) === null ? null : value;
function officialEndpoint(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'webapi.sporttery.cn'
    && !u.port && !u.username && !u.password && !u.hash; } catch { return false; }
}
function marketField(row, pool) {
  const handicap = pool === 'HHAD';
  const prefix = handicap ? 'handicapOdds' : 'odds';
  const p = row[prefix + 'MarketProvenance'];
  const odds = row[prefix];
  const present = ['odds1', 'oddsX', 'odds2'].every(k => finiteOdd(odds?.[k]) !== null);
  const cycle = p?.attestation?.commitment?.collectorCycleId || null;
  const rawHash = typeof p?.response?.rawSha256 === 'string' && /^[a-f0-9]{64}$/.test(p.response.rawSha256) ? p.response.rawSha256 : null;
  const verified = present && row[prefix + 'Source'] === 'sporttery:' + pool
    && p?.provider?.id === 'sporttery' && p?.provider?.official === true
    && p?.strict?.eligible === true && p?.strict?.diagnosticOnly === false
    && officialEndpoint(p?.endpoint?.url) && Boolean(cycle && rawHash)
    && p?.market?.poolCode === pool && Boolean(row.sourceMatchId && p?.market?.sourceMatchId)
    && String(p.market.sourceMatchId) === String(row.sourceMatchId)
    && p?.extraction?.poolCode === pool
    && (!handicap || (parseHandicap(row.handicapLine) !== null
      && parseHandicap(row.handicapLine) === parseHandicap(p?.extraction?.handicapLine)))
    && ['odds1', 'oddsX', 'odds2'].every((k, i) => Number(odds[k]) === Number(p?.extraction?.odds?.[['1','X','2'][i]]));
  return { present, verified, poolCode: pool, handicapLine: handicap ? parseHandicap(row.handicapLine) : null,
    source: row[prefix + 'Source'] || null,
    sourceUrl: p?.endpoint?.url || null, observedAt: p?.timing?.providerObservedAt || row[prefix + 'ObservedAt'],
    receivedAt: p?.timing?.receivedAt || row[prefix + 'ReceivedAt'], providerUpdatedAt: null,
    sourceCycleId: cycle, confidence: verified ? 'stored-strict-source-eligible' : 'unverified',
    reason: 'missing-or-nonofficial-or-unbound-SP', rawSha256: rawHash };
}
function field(value, asOf, maxAgeMs) {
  const observed = clock(value.observedAt);
  const received = clock(value.receivedAt);
  const updated = clock(value.providerUpdatedAt);
  const hasClock = Boolean(observed || received);
  const timestamp = observed || received;
  const futureClock = [observed, received, updated].some(value => value && instant(value) > asOf);
  let state = value.present ? 'unknown' : 'missing';
  let reason = value.reason;
  if (value.present && value.verified && hasClock && !futureClock) {
    state = asOf - instant(timestamp) > maxAgeMs ? 'stale' : 'available';
    reason = state === 'stale' ? 'observation-exceeds-report-age-limit' : 'source-evidence-recorded';
  } else if (value.present && futureClock) reason = 'observation-after-report-clock';
  return { ...value, observedAt: observed, receivedAt: received, providerUpdatedAt: updated,
    providerClockKnown: Boolean(updated), state, reason };
}
function sourceCoverageReport(rows, receipt, options = {}) {
  const asOf = instant(options.asOf || receipt.observedAt);
  const maxAgeMs = options.maxAgeMs ?? 86400000;
  if (asOf === null || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error('Invalid report clock/age');
  if (!Array.isArray(rows)) throw new Error('Expected match array');
  if (receipt.source !== 'online-immutable-active-generation' || receipt.sameSnapshot !== true
    || !receipt.publication?.generationId || !receipt.publication?.sourceCycleId
    || instant(receipt.publication?.committedAt) === null || instant(receipt.observedAt) === null
    || asOf < instant(receipt.publication.committedAt)) throw new Error('Unbound online publication receipt');
  const matches = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid match row');
    const components = row.externalSignals?.preMatch?.quality?.components || {};
    const schedulePresent = Boolean(row.id && row.homeTeamId && row.awayTeamId && clock(row.kickoffTime));
    const fields = {
      schedule: { present: schedulePresent, verified: row.source === 'sporttery' && Boolean(row.sourceMatchId && row.sourceCycleId) && officialEndpoint(row.sourceUrl),
        source: row.source || null, sourceUrl: row.sourceUrl || null, observedAt: row.sourceObservedAt,
        receivedAt: row.sourceReceivedAt, providerUpdatedAt: null, sourceCycleId: row.sourceCycleId || null,
        confidence: 'recorded-source-identity', reason: 'missing-schedule-identity-or-provenance' },
      officialSP: marketField(row, 'HAD'),
      officialHhadSP: marketField(row, 'HHAD'),
    };
    for (const [name, key] of [['lineup','lineup'], ['injuries','injuries'], ['weather','weather'], ['realXg','xg']]) {
      const c = components[key] || {};
      // Serialized quality summaries are not raw provider coverage proofs. In particular,
      // estimated xG and Poisson/odds-derived values never count as measured xG.
      const present = ['verified', 'estimated', 'available'].includes(c.status);
      fields[name] = { present, verified: false, source: c.source === 'missing' ? null : c.source || null,
        sourceUrl: c.sourceUrl || null, observedAt: c.sourceObservedAt, receivedAt: c.sourceReceivedAt,
        providerUpdatedAt: c.sourceUpdatedAt, sourceCycleId: c.sourceCycleId || null,
        confidence: 'summary-only', evidenceType: c.evidenceType || null,
        observationClockRole: 'quality-assessment-clock-not-proof-of-feature-receipt',
        availabilityState: c.availabilityState || null,
        reason: name === 'realXg' && c.evidenceType === 'pre-match-xg-estimate' ? 'estimate-is-not-measured-xg'
          : present ? 'raw-feature-provenance-not-in-export' : c.note?.en || 'no-field-evidence-in-export' };
    }
    fields.players = { present: false, verified: false, source: null, sourceUrl: null,
      confidence: 'unknown', reason: 'no-player-level-source-adapter-in-this-export' };
    return { matchId: row.id || null, lifecycle: row.status || null,
      fields: Object.fromEntries(FIELDS.map(name => [name, field(fields[name], asOf, maxAgeMs)])) };
  });
  const coverage = Object.fromEntries(FIELDS.map(name => {
    const count = state => matches.filter(m => m.fields[name].state === state).length;
    const present = matches.filter(m => m.fields[name].present).length;
    const available = count('available'), stale = count('stale');
    return [name, { total: rows.length, present, available, stale, missing: count('missing'), unknown: count('unknown'),
      evidencedRatio: rows.length ? (available + stale) / rows.length : null,
      freshRatio: rows.length ? available / rows.length : null }];
  }));
  return { version: 'source-coverage-report-v1', asOf: new Date(asOf).toISOString(), maxAgeMs,
    publication: receipt.publication, exportObservedAt: receipt.observedAt,
    scope: 'Recorded fields in hash-bound online export; officialSP=HAD and officialHhadSP=HHAD. Other pools are not assessed. Not a fresh fetch, signature revalidation, provider coverage or recommendation eligibility proof.',
    batchLabel: 'Published batch committed at ' + receipt.publication.committedAt,
    coverage, matches };
}
function reportFromFiles(receiptPath, matchesPath, options = {}) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const raw = fs.readFileSync(matchesPath);
  const entry = receipt.files?.find(f => f.name === 'matches-current.json');
  if (!entry || entry.bytes !== raw.length || entry.sha256 !== sha256(raw)
    || entry.provenance?.generationId !== receipt.publication?.generationId
    || entry.provenance?.manifestHash !== receipt.publication?.manifestHash
    || entry.provenance?.manifestEntry?.sha256 !== entry.sha256) throw new Error('Online export hash/binding mismatch');
  const report = sourceCoverageReport(JSON.parse(raw.toString('utf8')), receipt, options);
  return { ...report, input: { name: path.basename(matchesPath), bytes: raw.length, sha256: entry.sha256 } };
}
module.exports = { sourceCoverageReport, reportFromFiles };
if (require.main === module) {
  try {
    const [receiptPath, matchesPath, asOf] = process.argv.slice(2);
    if (!receiptPath || !matchesPath) throw new Error('Usage: node scripts/sourceCoverageReport.cjs RECEIPT MATCHES [AS_OF]');
    console.log(JSON.stringify(reportFromFiles(receiptPath, matchesPath, asOf ? { asOf } : {}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
