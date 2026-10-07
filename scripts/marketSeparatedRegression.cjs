'use strict';

// Pure evaluation of an already obtained, bounded production export. This
// module has no database, collector, publisher, fitting or network entry point.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { epochNanoseconds: clock } = require('../src/services/prematchV3Clock.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const { validDecision } = require('./recommendationPlatform/decision.cjs');
const { validResultEvent } = require('./recommendationPlatform/results.cjs');
const { validSupplementaryEventEvidence, supplementaryOfficialEvidence } = require('./recommendationPlatform/officialResults.cjs');
const { isTrustedOfficialFinal } = require('../src/services/matchLifecycle.cjs');

const VERSION = 'market-separated-frozen-regression-v1';
const INPUT_VERSION = 'market-separated-production-readonly-export-v1';
const CODES = Object.freeze(['1', 'X', '2']);
const MAX_EVENTS = 500, MAX_BYTES = 32 * 1024 * 1024;
// These are explicit existing publication paths, not a /^sporttery/ trust rule.
const LEDGER_SOURCES = new Set(['sporttery:official-api', 'sporttery:official-correction', 'sporttery:sqlite-fast-result-receipt']);
const SUPPLEMENT_SOURCES = new Set(['uefa:official-match-api', 'official-club:result-page', 'k-league:official-schedule-api']);
const SHA = /^[a-f0-9]{64}$/;
const check = (value, reason) => { if (!value) throw new Error(`MARKET_REGRESSION_${reason}`); };
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const shaBytes = value => crypto.createHash('sha256').update(value).digest('hex');
const eventKey = row => typeof row?.sourceMatchId === 'string' && /^[0-9]{1,16}$/.test(row.sourceMatchId)
  && clock(row.eventVersion) !== null ? JSON.stringify([row.sourceMatchId, clock(row.eventVersion).toString()]) : null;
const deltaMs = (later, earlier) => Number(clock(later) - clock(earlier)) / 1000000;
const distribution = p => p && !Array.isArray(p) && CODES.every(c => typeof p[c] === 'number'
  && Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1) && Math.abs(CODES.reduce((a, c) => a + p[c], 0) - 1) < 1e-8;
function uniqueLeader(p) {
  if (!distribution(p)) return null;
  const max = Math.max(...CODES.map(c => p[c]));
  const top = CODES.filter(c => p[c] === max);
  return top.length === 1 ? top[0] : null;
}
function marketProbabilities(odds) {
  if (!odds || !CODES.every(c => typeof odds[c] === 'number' && Number.isFinite(odds[c]) && odds[c] > 1)) return null;
  const sum = CODES.reduce((n, c) => n + 1 / odds[c], 0);
  return Object.fromEntries(CODES.map(c => [c, (1 / odds[c]) / sum]));
}
function decisionIssue(d, observedAt, trustRegistry) {
  try { if (!validDecision(d, trustRegistry ? { trustRegistry } : null)) return 'invalid-frozen-decision'; } catch { return 'invalid-frozen-decision'; }
  if (!eventKey(d) || !date(d.businessDate) || !['homeTeamId', 'awayTeamId'].every(k => typeof d[k] === 'string' && d[k])) return 'event-identity-invalid';
  const names = ['eventVersion', 'kickoffTime', 'cutoffTime', 'publishedAt', 'quoteObservedAt', 'modelGeneratedAt'];
  if (names.some(k => clock(d[k]) === null)) return 'clock-invalid';
  // Existing immutable records bind millisecond event IDs. Do not silently
  // round a fabricated submillisecond event into that older identity domain.
  if (clock(d.eventVersion) % 1000000n !== 0n || clock(d.kickoffTime) !== clock(d.eventVersion)) return 'event-clock-precision-or-identity';
  if (clock(d.publishedAt) > clock(observedAt) || clock(d.publishedAt) >= clock(d.cutoffTime)
    || clock(d.publishedAt) >= clock(d.kickoffTime) || clock(d.quoteObservedAt) > clock(d.publishedAt)
    || clock(d.modelGeneratedAt) > clock(d.publishedAt)) return 'prepublication-clock-invalid';
  if (!distribution(d.probabilities)) return 'model-distribution-invalid';
  return null;
}
function frozenHandicap(d) {
  const h = d.handicapAnalysis;
  if (!h || !Number.isSafeInteger(h.handicapLine) || h.handicapLine === 0) return null;
  const code = d.primaryPickPolicyVersion === 'coherent-market-primary-v1' ? d.coherentPrimary?.hhadCode
    : d.primaryPickPolicyVersion === 'independent-market-primary-v1' ? h.overallTipCode : h.tipCode;
  if (!CODES.includes(code)) return null;
  // The conditional companion vector is deliberately never scored as a
  // marginal three-outcome forecast. Old records without marginal p remain
  // eligible for their original hit accounting, with proper-score coverage 0.
  const p = distribution(h.overallProbabilities) ? h.overallProbabilities
    : h.probabilityBasis === 'conditional-on-straight-primary' ? null
    : distribution(h.probabilities) ? h.probabilities : null;
  return { market: 'HHAD', line: h.handicapLine, code, p, odds: h.marketReference?.odds || null,
    quoteObservedAt: h.marketReference?.observedAt || null,
    probabilityBasis: p ? 'unconditional' : 'conditional-or-unavailable',
    frozenProbabilityBasis: h.probabilityBasis || 'legacy-unspecified' };
}
function frozenPrimary(d, had, hhad) {
  if (d.primaryPickPolicyVersion === 'coherent-market-primary-v1') {
    const c = d.coherentPrimary, item = c?.anchorMarket === 'HAD' ? had : c?.anchorMarket === 'HHAD' ? hhad : null;
    return item && item.code === c.anchorCode ? { ...item, identityBasis: 'frozen-coherent-anchor' } : null;
  }
  // The independent and older policies publish separate market directions;
  // they do not retain an unambiguous unique primary field. Never invent one.
  return null;
}
function resultFor(d, heads, evidenceRows, observedAt) {
  const matching = heads.filter(h => eventKey(h) === eventKey(d));
  if (!matching.length) return { state: 'PENDING', reason: 'no-result-head', eventId: null, revision: null, retainedRegularTimeEvidenceVerified: false };
  const distinct = [...new Map(matching.map(h => [hash(h), h])).values()];
  if (distinct.length !== 1) return { state: 'DISPUTED', reason: 'conflicting-current-result-heads', eventId: null, revision: null, retainedRegularTimeEvidenceVerified: false };
  const h = distinct[0], base = { eventId: h.eventId || null, revision: h.revision ?? null, source: h.source || null,
    observedAt: h.observedAt || null, settlementAdmission: 'admitted-ledger', provider90Reverified: false,
    retainedRegularTimeEvidenceVerified: false };
  let valid = false; try { valid = validResultEvent(h); } catch { /* malformed evidence fails closed */ }
  if (!valid || clock(h.observedAt) === null || clock(h.observedAt) > clock(observedAt)
    || (h.state === 'FINAL' && clock(h.observedAt) < clock(d.eventVersion))
    || clock(h.eventVersion) !== clock(d.eventVersion)) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'invalid-result-or-observation-clock' };
  if (h.homeTeamId !== d.homeTeamId || h.awayTeamId !== d.awayTeamId) return { ...base, state: 'DISPUTED', reason: 'ordered-team-conflict' };
  if (h.state === 'DISPUTED') return { ...base, state: 'DISPUTED', reason: 'ledger-disputed' };
  const supplement = SUPPLEMENT_SOURCES.has(h.source);
  if (!LEDGER_SOURCES.has(h.source) && !supplement) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'unsupported-result-source' };
  if (h.state === 'VOID') return h.source === 'sporttery:official-api'
    ? { ...base, state: 'VOID', reason: 'official-ledger-void' }
    : { ...base, state: 'UNVERIFIED_RESULT', reason: 'unsupported-void-source' };
  if (h.state !== 'FINAL') return { ...base, state: 'PENDING', reason: 'not-final' };
  if (![h.scoreHome, h.scoreAway].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100)) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'invalid-final-score' };
  if (supplement && (!validSupplementaryEventEvidence(h) || h.officialResultEvidence?.provenance?.scoreKind !== 'regular-time')) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'regular-time-evidence-invalid' };
  if (supplement && [h.sourceResultObservedAt, h.officialResultEvidence.provenance.observedAt].some(at => clock(at) === null
    || clock(at) > clock(h.observedAt) || clock(at) < clock(d.eventVersion))) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'supplement-observation-clock-invalid' };
  // Only an independently admitted same-revision official provider row may
  // contradict a head. Unknown/generic rows and missing revisions have no
  // veto or proof authority. Do not prefilter by score: that hides disputes.
  const rows = evidenceRows.filter(r => eventKey(r) === eventKey(d) && r.homeTeamId === d.homeTeamId && r.awayTeamId === d.awayTeamId
    && Number.isSafeInteger(r.resultRevision) && r.resultRevision === h.revision
    && (LEDGER_SOURCES.has(r.resultSource) || SUPPLEMENT_SOURCES.has(r.resultProvenance?.source))
    && clock(r.resultObservedAt) !== null && clock(r.resultObservedAt) <= clock(observedAt)
    && clock(r.resultObservedAt) >= clock(d.eventVersion) && isTrustedOfficialFinal(r));
  for (const r of rows) {
    if (r.scoreHome !== h.scoreHome || r.scoreAway !== h.scoreAway) return { ...base, state: 'DISPUTED', reason: 'official-provider-row-score-conflict' };
    if (r.resultProvenance?.scoreKind !== undefined && r.resultProvenance.scoreKind !== 'regular-time') return { ...base, state: 'UNVERIFIED_RESULT', reason: 'explicit-non-regulation-score' };
  }
  let retainedRegularTimeEvidenceVerified = supplement;
  if (supplement && rows.length) {
    retainedRegularTimeEvidenceVerified = rows.some(r => {
      try { return supplementaryOfficialEvidence(r, Number(clock(observedAt) / 1000000n))?.officialResultEvidenceHash === h.officialResultEvidenceHash; } catch { return false; }
    });
    if (!retainedRegularTimeEvidenceVerified) return { ...base, state: 'UNVERIFIED_RESULT', reason: 'provider-row-receipt-conflict' };
  }
  return { ...base, state: 'FINAL', reason: supplement ? 'retained-regular-time-supplement' : 'official-production-ledger-final',
    scoreHome: h.scoreHome, scoreAway: h.scoreAway, settlementOnly: h.settlementOnly === true,
    promotionEligible: false, retainedRegularTimeEvidenceVerified, trustedSameRevisionProviderRows: rows.length };
}
function side(item) {
  if (item.market === 'HAD') {
    const baseline = marketProbabilities(item.odds), favorite = uniqueLeader(baseline);
    return item.code === 'X' ? 'draw' : favorite === null || favorite === 'X' ? 'favorite-unknown' : item.code === favorite ? 'market-favorite' : 'market-nonfavorite';
  }
  if (item.code === 'X') return 'exact-handicap-margin';
  return (item.line < 0 && item.code === '1') || (item.line > 0 && item.code === '2') ? 'upper' : 'lower';
}
function scoredItem(d, item, result, kind) {
  const quoteAt = clock(item.quoteObservedAt), publishedAt = clock(d.publishedAt);
  const quoteAgeMs = quoteAt === null ? null : Number(publishedAt - quoteAt) / 1000000;
  const quoteClockValid = quoteAt !== null && quoteAt <= publishedAt && quoteAgeMs <= 15 * 60000;
  const rawMarket = marketProbabilities(item.odds), market = quoteClockValid ? rawMarket : null;
  const actual = result.state === 'FINAL' ? (result.scoreHome + item.line > result.scoreAway ? '1'
    : result.scoreHome + item.line < result.scoreAway ? '2' : 'X') : null;
  const p = distribution(item.p) ? item.p : null;
  const selectedP = p && CODES.includes(item.code) ? p[item.code] : null;
  const sp = market && CODES.includes(item.code) ? item.odds[item.code] : null;
  const expectedReturn = selectedP !== null && sp !== null ? selectedP * sp : null;
  const edge = market && selectedP !== null ? selectedP - market[item.code] : null;
  const marketCode = uniqueLeader(market);
  return { kind, market: item.market, line: item.line, code: item.code, probabilityBasis: item.probabilityBasis || 'unconditional',
    frozenProbabilityBasis: item.frozenProbabilityBasis || null, identityBasis: item.identityBasis || null,
    p, marketProbabilities: market, marketCode, selectedOdds: sp, quoteObservedAt: item.quoteObservedAt, quoteAgeMs,
    quoteState: market ? 'frozen-fresh-same-market' : !rawMarket ? 'missing-same-market-odds' : 'invalid-or-stale-quote-clock',
    side: side(item), resultState: result.state, actual,
    won: actual === null || item.code === null ? null : actual === item.code,
    marketWon: actual === null || marketCode === null ? null : actual === marketCode,
    retainedRegularTimeEvidenceVerified: result.retainedRegularTimeEvidenceVerified,
    valueDiagnostic: { p: selectedP, sp, expectedReturn, edge, expectedReturnThreshold: 1.05, edgeThreshold: 0.05,
      passes: expectedReturn !== null && edge !== null && expectedReturn > 1.05 && edge > 0.05,
      researchOnly: true, formalEligible: false } };
}
function metrics(items, verifiedOnly = false) {
  const eligible = items.filter(i => i.resultState === 'FINAL' && (!verifiedOnly || i.retainedRegularTimeEvidenceVerified));
  const hit = eligible.filter(i => i.code !== null), proper = eligible.filter(i => distribution(i.p));
  const paired = proper.filter(i => distribution(i.marketProbabilities));
  const baselineHits = eligible.filter(i => i.marketCode !== null);
  const scores = (rows, pick) => {
    if (!rows.length) return { denominator: 0, brier: null, logLoss: null };
    let brier = 0, loss = 0, infinite = false;
    for (const i of rows) { const p = pick(i); brier += CODES.reduce((a, c) => a + (p[c] - (c === i.actual ? 1 : 0)) ** 2, 0);
      if (p[i.actual] === 0) infinite = true; else loss -= Math.log(p[i.actual]); }
    return { denominator: rows.length, brier: brier / rows.length, logLoss: infinite ? null : loss / rows.length,
      logLossInfinite: infinite, logLossZeroProbabilityCount: rows.filter(i => pick(i)[i.actual] === 0).length };
  };
  const stateCounts = Object.fromEntries(['FINAL', 'PENDING', 'VOID', 'DISPUTED', 'UNVERIFIED_RESULT'].map(s => [s, items.filter(i => i.resultState === s).length]));
  return { eventCount: items.length, stateCounts, hit: { numerator: hit.filter(i => i.won).length, denominator: hit.length,
    rate: hit.length ? hit.filter(i => i.won).length / hit.length : null, tiesOrMissingDirection: eligible.length - hit.length },
    model: scores(proper, i => i.p), paired: { model: scores(paired, i => i.p), market: scores(paired, i => i.marketProbabilities),
      modelHit: { numerator: paired.filter(i => i.code !== null && i.won).length, denominator: paired.filter(i => i.code !== null).length },
      marketHit: { numerator: paired.filter(i => i.marketCode !== null && i.marketWon).length, denominator: paired.filter(i => i.marketCode !== null).length } },
    marketBaseline: { ...scores(eligible.filter(i => distribution(i.marketProbabilities)), i => i.marketProbabilities),
      hit: { numerator: baselineHits.filter(i => i.marketWon).length, denominator: baselineHits.length,
        rate: baselineHits.length ? baselineHits.filter(i => i.marketWon).length / baselineHits.length : null } },
    quoteCoverage: { fresh: items.filter(i => i.quoteState === 'frozen-fresh-same-market').length,
      missing: items.filter(i => i.quoteState === 'missing-same-market-odds').length,
      invalidOrStale: items.filter(i => i.quoteState === 'invalid-or-stale-quote-clock').length },
    valueDiagnosticCount: items.filter(i => i.valueDiagnostic.passes).length,
    valueDiagnosticSettled: { numerator: hit.filter(i => i.valueDiagnostic.passes && i.won).length,
      denominator: hit.filter(i => i.valueDiagnostic.passes).length,
      model: scores(proper.filter(i => i.valueDiagnostic.passes), i => i.p),
      market: scores(paired.filter(i => i.valueDiagnostic.passes), i => i.marketProbabilities),
      retrospectiveSelectedSubset: true, formalPromotion: false },
    directions: Object.fromEntries(CODES.map(c => [c, items.filter(i => i.code === c).length])),
    sides: Object.fromEntries([...new Set(items.map(i => i.side))].sort().map(s => [s, items.filter(i => i.side === s).length])) };
}
function validateEnvelope(input) {
  check(input?.version === INPUT_VERSION && input.readOnly === 'on' && input.isolation === 'repeatable read'
    && input.productionWrites === 0, 'NOT_READONLY_EXPORT');
  check(clock(input.observedAt) !== null && date(input.from) && date(input.through) && input.from <= input.through
    && Date.parse(input.through) - Date.parse(input.from) <= 31 * 86400000, 'RANGE_OR_CLOCK');
  check(input.runtime?.stable === true && SHA.test(input.runtime.runtimeSha || '') && input.runtime.runtimeSha === input.runtime.completeSha, 'RUNTIME_BINDING');
  check(input.generation?.data_publication_mode === 'active-generation' && /^g-[a-f0-9]{64}$/.test(input.generation.data_generation_id || '')
    && SHA.test(input.generation.manifest_hash || '') && clock(input.generation.committed_at) !== null
    && clock(input.generation.committed_at) <= clock(input.observedAt), 'GENERATION_BINDING');
  check(Array.isArray(input.decisions) && input.decisions.length <= MAX_EVENTS && Array.isArray(input.resultHeads)
    && input.resultHeads.length <= MAX_EVENTS && Array.isArray(input.resultEvidenceRows) && input.resultEvidenceRows.length <= MAX_EVENTS * 2
    && Array.isArray(input.reviewPages) && input.reviewPages.length <= 20, 'ROW_BOUND');
  return input;
}
function validatePages(input) {
  const groups = new Map(), originals = new Map(input.decisions.map(d => [d.decisionId, hash(d)]));
  for (const p of input.reviewPages) {
    const f = p?.filters;
    check(p?.ok === true && p.version === 'recommendation-review-page-v1' && clock(p.updatedAt) === clock(input.observedAt)
      && f?.kind === 'single' && ['HAD', 'HHAD'].includes(f.market) && f.state === 'ALL' && f.q === '' && f.date === '' && f.version === '', 'REVIEW_PAGE_SCOPE');
    check(Number.isSafeInteger(p.total) && p.total >= 0 && p.total <= MAX_EVENTS && Number.isSafeInteger(p.pageCount)
      && p.pageCount === Math.ceil(p.total / p.pageSize) && p.pageSize === 50 && p.page === f.page && p.pageSize === f.pageSize
      && p.page >= 1 && p.page <= Math.max(1, p.pageCount) && Array.isArray(p.rows) && p.rows.length <= 50, 'REVIEW_PAGE_BOUND');
    const group = groups.get(f.market) || { total: p.total, pageCount: p.pageCount, pages: new Map() };
    check(group.total === p.total && group.pageCount === p.pageCount, 'REVIEW_PAGE_MIXED_SNAPSHOT');
    const old = group.pages.get(p.page); check(!old || hash(old) === hash(p), 'REVIEW_PAGE_CONFLICT');
    for (const r of p.rows) check(r.selectedMarket === f.market && originals.get(r.decision?.decisionId) === hash(r.decision), 'REVIEW_FROZEN_MEMBERSHIP');
    group.pages.set(p.page, p); groups.set(f.market, group);
  }
  check(groups.size === 2, 'BOTH_REVIEW_MARKETS_REQUIRED');
  return Object.fromEntries([...groups].map(([market, g]) => {
    const rows = [...g.pages.values()].flatMap(p => p.rows), seen = new Set(rows.map(r => r.decision.decisionId));
    const complete = g.pages.size === Math.max(1, g.pageCount) && rows.length === g.total && seen.size === rows.length;
    return [market, { expectedRows: g.total, rowsObtained: rows.length, uniqueDecisions: seen.size, pagesObtained: g.pages.size, complete }];
  }));
}
function buildMarketSeparatedRegression(input, { trustRegistry = null } = {}) {
  validateEnvelope(input);
  const pageCoverage = validatePages(input), issues = [], grouped = new Map();
  for (const d of input.decisions) {
    const issue = decisionIssue(d, input.observedAt, trustRegistry);
    if (issue || !date(d.businessDate) || d.businessDate < input.from || d.businessDate > input.through) {
      issues.push({ decisionId: d?.decisionId || null, reason: issue || 'outside-business-date-range' }); continue;
    }
    const k = eventKey(d), group = grouped.get(k) || []; group.push(d); grouped.set(k, group);
  }
  const selected = [];
  for (const [k, group] of grouped) {
    const identities = new Set(group.map(d => hash([d.homeTeamId, d.awayTeamId, d.businessDate])));
    if (identities.size !== 1) { issues.push({ eventKey: k, reason: 'conflicting-frozen-event-identity' }); continue; }
    const distinct = [...new Map(group.map(d => [d.recordHash, d])).values()].sort((a, b) => clock(a.publishedAt) < clock(b.publishedAt) ? 1 : clock(a.publishedAt) > clock(b.publishedAt) ? -1 : a.recordHash.localeCompare(b.recordHash));
    if (distinct.length > 1 && clock(distinct[0].publishedAt) === clock(distinct[1].publishedAt)) { issues.push({ eventKey: k, reason: 'ambiguous-latest-freeze' }); continue; }
    selected.push(distinct[0]);
  }
  selected.sort((a, b) => a.businessDate.localeCompare(b.businessDate) || eventKey(a).localeCompare(eventKey(b)));
  const events = selected.map(d => {
    const result = resultFor(d, input.resultHeads, input.resultEvidenceRows, input.observedAt);
    const had = { market: 'HAD', line: 0, code: d.tipCode, p: d.probabilities, odds: d.quoteOdds, quoteObservedAt: d.quoteObservedAt }, hhad = frozenHandicap(d);
    const primary = frozenPrimary(d, had, hhad);
    const items = [scoredItem(d, had, result, 'frozenHAD'),
      scoredItem(d, { ...had, code: uniqueLeader(had.p) }, result, 'hadArgmaxResearch'),
      ...(hhad ? [scoredItem(d, hhad, result, 'frozenHHAD')] : []),
      ...(primary ? [scoredItem(d, primary, result, 'originalPrimary')] : [])];
    return { eventKey: eventKey(d), sourceMatchId: d.sourceMatchId, eventVersion: d.eventVersion, homeTeamId: d.homeTeamId,
      awayTeamId: d.awayTeamId, businessDate: d.businessDate, decisionId: d.decisionId, recordHash: d.recordHash,
      publishedAt: d.publishedAt, modelGeneratedAt: d.modelGeneratedAt, quoteObservedAt: d.quoteObservedAt,
      modelAgeAtPublicationMs: deltaMs(d.publishedAt, d.modelGeneratedAt), primaryPickPolicyVersion: d.primaryPickPolicyVersion || null,
      upstreamModelVersion: d.upstreamModelVersion || 'unknown',
      hadArgmaxChangedFromFrozen: uniqueLeader(d.probabilities) !== null && uniqueLeader(d.probabilities) !== d.tipCode,
      missingHHAD: !hhad, missingExplicitPrimary: !primary, result, items };
  });
  const all = events.flatMap(e => e.items);
  const tracks = {};
  for (const kind of ['frozenHAD', 'hadArgmaxResearch', 'frozenHHAD', 'originalPrimary']) {
    const items = all.filter(i => i.kind === kind);
    // Even original primary proper scores stay separated by market and line.
    const markets = [...new Set(items.map(i => `${i.market}:${i.line}`))].sort();
    const policies = [...new Set(events.map(e => e.primaryPickPolicyVersion || 'legacy-unspecified'))].sort();
    tracks[kind] = { hitOnly: { ...metrics(items).hit }, coverage: { events: items.length, expected: events.length },
      byPolicyAndMarketAndLine: Object.fromEntries(policies.map(policy => [policy,
        Object.fromEntries(markets.map(k => [k, metrics(events.filter(e => (e.primaryPickPolicyVersion || 'legacy-unspecified') === policy)
          .flatMap(e => e.items).filter(i => i.kind === kind && `${i.market}:${i.line}` === k))]))])),
      byMarketAndLine: Object.fromEntries(markets.map(k => { const rows = items.filter(i => `${i.market}:${i.line}` === k);
        return [k, { admittedLedgerMetrics: metrics(rows), verified90Metrics: metrics(rows, true) }]; })) };
  }
  const anchorDay = new Date(Number(clock(input.observedAt) / 1000000n) + 8 * 3600000).toISOString().slice(0, 10);
  const window = days => { const from = new Date(Date.parse(anchorDay + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
    return { from, through: anchorDay, fullyCoveredByExportRange: input.from <= from && input.through >= anchorDay,
      byTrackAndMarket: Object.fromEntries(Object.keys(tracks).map(kind => [kind, Object.fromEntries([...new Set(all.filter(i => i.kind === kind).map(i => `${i.market}:${i.line}`))].sort().map(k => [k,
        metrics(events.filter(e => e.businessDate >= from && e.businessDate <= anchorDay).flatMap(e => e.items).filter(i => i.kind === kind && `${i.market}:${i.line}` === k))]))])) }; };
  const byDate = Object.fromEntries([...new Set(events.map(e => e.businessDate))].sort().map(day => [day,
    Object.fromEntries(Object.keys(tracks).map(kind => [kind, { hitOnly: metrics(events.filter(e => e.businessDate === day).flatMap(e => e.items).filter(i => i.kind === kind)).hit }]))]));
  const body = { version: VERSION, observedAt: input.observedAt, evaluationMode: 'retrospective-frozen-evaluation',
    trainingPerformed: false, outOfSampleTrainingEvidence: false, productionWrites: 0, formalPromotion: false,
    crossMarketSelectionPerformed: false, provider90Reverified: false,
    definition: 'latest-unambiguous-valid-precutoff-freeze-per-exact-event;separate-market-and-line;unknown-results-excluded',
    sourceBinding: { inputContentHash: hash(input), runtime: input.runtime, generation: input.generation,
      transport: input.transport || null, readOnly: input.readOnly, isolation: input.isolation,
      provenanceScope: 'caller-supplied-production-readonly-envelope;not-new-provider-attestation' },
    range: { from: input.from, through: input.through, anchorBusinessDate: anchorDay }, pageCoverage,
    coverage: { inputDecisionRows: input.decisions.length, uniqueEvents: events.length,
      validInputDecisionRows: [...grouped.values()].reduce((n, rows) => n + rows.length, 0),
      nonSelectedValidRows: [...grouped.values()].reduce((n, rows) => n + rows.length, 0) - events.length,
      missingHHAD: events.filter(e => e.missingHHAD).length, missingExplicitPrimary: events.filter(e => e.missingExplicitPrimary).length,
      hadArgmaxChangedFromFrozen: events.filter(e => e.hadArgmaxChangedFromFrozen).length },
    tracks, byDate, windows: { last7: window(7), last30: window(30) }, issues, events,
    limitations: ['Immutable decision validation replays the historical policy; this evaluator never selects a new cross-market primary.',
      'HAD argmax is retrospective research of already frozen probabilities; no new independent or trained probabilities are produced.',
      'Sporttery FINAL uses exact allowed-source admitted PG ledger semantics, without independently refetching regulation scores.',
      'verified90Metrics is a strict subset with revalidated retained regular-time supplementary evidence; it is not a new official fetch.',
      'Unknown, disputed and void results never count as losses. Missing HHAD odds never borrow HAD odds.',
      'Same-market value conditions are diagnostic only. Publication times do not establish historical feature knowledge or OOS training.'] };
  return { ...body, contentHash: hash(body) };
}
function runLocal({ input: source, output }) {
  const target = path.resolve(output), inputPath = path.resolve(source), s = fs.lstatSync(inputPath);
  check(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= MAX_BYTES, 'INPUT_FILE');
  check(!fs.existsSync(target) && fs.statSync(path.dirname(target)).isDirectory(), 'CREATE_ONLY_OUTPUT');
  const raw = fs.readFileSync(inputPath), after = fs.lstatSync(inputPath);
  check(raw.length === s.size && s.size === after.size && s.mtimeMs === after.mtimeMs && s.ino === after.ino, 'INPUT_CHANGED');
  const report = buildMarketSeparatedRegression(JSON.parse(raw.toString('utf8')));
  const wrapper = { report, inputFile: { path: inputPath, sha256: shaBytes(raw), bytes: raw.length } };
  fs.writeFileSync(target, JSON.stringify(wrapper, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output: target, events: report.coverage.uniqueEvents, contentHash: report.contentHash, productionWrites: 0 };
}
function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) { check(['--input', '--output'].includes(args[i]) && !Object.hasOwn(o, args[i]) && typeof args[i + 1] === 'string' && args[i + 1], 'ARGUMENTS'); o[args[i]] = args[i + 1]; }
  check(o['--input'] && o['--output'], 'ARGUMENTS'); return { input: o['--input'], output: o['--output'] };
}
if (require.main === module) {
  try { console.log(JSON.stringify(runLocal(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(/^MARKET_REGRESSION_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'MARKET_REGRESSION_FAILED'); process.exitCode = 1; }
}
module.exports = { VERSION, INPUT_VERSION, MAX_EVENTS, MAX_BYTES, eventKey, uniqueLeader, marketProbabilities,
  decisionIssue, frozenHandicap, resultFor, metrics, validateEnvelope, validatePages, buildMarketSeparatedRegression, runLocal, parseArgs };
