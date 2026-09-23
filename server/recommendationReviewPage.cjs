'use strict';

const { day, hash } = require('../src/services/publishedForecastPolicy.cjs');
const { validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { validCombo } = require('../scripts/recommendationPlatform/comboSelections.cjs');
const {
  key, settleDecision, settleHandicapDecision, settleCombo, summary, validResultEvent,
} = require('../scripts/recommendationPlatform/results.cjs');
const { selectionQuality } = require('../src/services/recommendationSelectionQuality.cjs');
const { buildPublishedScoreDistribution } = require('../src/services/publishedScoreDistribution.cjs');

const VERSION = 'recommendation-review-page-v1';
const MAX_SOURCE_ROWS = 100000;
const STATES = new Set(['ALL', 'WON', 'LOST', 'PENDING', 'VOID', 'DISPUTED']);
const MARKETS = new Set(['ALL', 'HAD', 'HHAD', 'MIXED']);
const KINDS = new Set(['single', 'two', 'three']);
const safeValidDecision = value => { try { return validDecision(value); } catch { return false; } };
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

function badQuery(message) {
  const error = new Error(message);
  error.code = 'INVALID_REVIEW_QUERY';
  error.status = 400;
  return error;
}

function parseReviewQuery(url) {
  const params = url.searchParams;
  const kind = params.get('kind') || 'single';
  const market = params.get('market') || 'ALL';
  const date = params.get('date') || '';
  const version = params.get('version') || '';
  const state = params.get('state') || 'ALL';
  const q = (params.get('q') || '').trim().normalize('NFKC');
  const pageRaw = params.get('page') || '1';
  const pageSizeRaw = params.get('pageSize') || '12';
  if (!KINDS.has(kind) || !MARKETS.has(market) || (date && !dateKey(date))
    || (version && !/^[a-f0-9]{64}$/.test(version)) || !STATES.has(state)
    || q.length > 80 || !/^[1-9]\d{0,5}$/.test(pageRaw)
    || !/^[1-9]\d?$|^100$/.test(pageSizeRaw)) throw badQuery('invalid review filters');
  const page = Number(pageRaw), pageSize = Number(pageSizeRaw);
  if (page > 100000 || pageSize > 50) throw badQuery('review page out of range');
  return { kind, market, date, version, state, q, page, pageSize };
}

const modelVersion = decision => String(decision?.upstreamModelVersion || 'unknown');
const policyVersion = decision => String(decision?.policyVersion || 'unknown');
function versionFor(decisions, markets = null) {
  // HAD keeps its original version key. HHAD also binds the frozen handicap
  // model and companion policy; a later algorithm must not be grouped with an
  // older one merely because the upstream HAD model name stayed the same.
  const versions = [...new Set(decisions.map((d, i) => {
    const market = markets?.[i];
    const basis = [modelVersion(d), policyVersion(d)];
    if (market === 'HHAD') basis.push('HHAD', String(d?.handicapAnalysis?.version || 'unknown'),
      String(d?.handicapAnalysis?.companionPolicyVersion || 'none'));
    else if (market === 'HAD' && markets?.length > 1) basis.push('HAD');
    return JSON.stringify(basis);
  }))].sort();
  const labels = versions.map(item => JSON.parse(item));
  return {
    versionKey: hash(labels),
    versionLabel: labels.length === 1
      ? [labels[0][0], labels[0][1], ...labels[0].slice(2)].join(' · ').slice(0, 240)
      : `混合版本（${labels.length}）`,
  };
}

function comboMarket(combo) {
  const markets = new Set((combo.selections || combo.legs || []).map(row => row.market === 'HHAD' ? 'HHAD' : 'HAD'));
  return markets.size === 1 ? [...markets][0] : 'MIXED';
}

function singleReviewRow(decision, head, market) {
  const settlement = settleDecision(decision, head);
  const handicapSettlement = settleHandicapDecision(decision, head);
  const selectedSettlement = market === 'HHAD' ? handicapSettlement : settlement;
  const selectedOdds = market === 'HHAD'
    ? decision.handicapAnalysis?.marketReference?.selectedOdds ?? null : decision.odds;
  return {
    decision, settlement, handicapSettlement,
    selectedMarket: market, selectedSettlement,
    selectedOdds: Number.isFinite(selectedOdds) && selectedOdds > 1 ? selectedOdds : null,
    oddsState: Number.isFinite(selectedOdds) && selectedOdds > 1 ? 'available' : 'missing',
    ...versionFor([decision], market === 'HHAD' ? ['HHAD'] : null),
  };
}

function comboReviewRow(combo, heads) {
  const selectedOdds = Number.isFinite(combo.totalOdds) && combo.totalOdds > 1 ? combo.totalOdds : null;
  const settlement = settleCombo(combo, heads);
  return {
    combo, settlement, selectedMarket: comboMarket(combo),
    selectedSettlement: settlement, selectedOdds,
    oddsState: selectedOdds === null ? 'missing' : 'available',
    ...versionFor(combo.legs, (combo.selections || combo.legs).map(selection => selection.market === 'HHAD' ? 'HHAD' : 'HAD')),
  };
}

function selectedSummary(rows) {
  const base = summary(rows.map(row => ({ settlement: row.selectedSettlement || { state: 'PENDING' } })));
  return {
    ...base,
    oddsCoverage: {
      available: rows.filter(row => row.oddsState === 'available').length,
      missing: rows.filter(row => row.oddsState === 'missing').length,
      settledWithOdds: rows.filter(row => row.oddsState === 'available' && ['WON', 'LOST'].includes(row.selectedSettlement?.state)).length,
      settledMissingOdds: rows.filter(row => row.oddsState === 'missing' && ['WON', 'LOST'].includes(row.selectedSettlement?.state)).length,
    },
  };
}

const shanghaiDate = value => dateKey(value) ? value : '';
const itemDate = row => shanghaiDate(row.decision?.businessDate || row.combo?.businessDate);
const itemName = row => (row.decision ? [row.decision] : row.combo?.legs || [])
  .flatMap(d => [d.homeTeamName, d.awayTeamName, d.matchNo, d.sourceMatchId])
  .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
const itemTime = row => Date.parse(row.decision?.publishedAt || row.combo?.frozenAt || '') || 0;
const itemId = row => row.decision?.decisionId || row.combo?.id || '';
function selectMarketRows(rows, filters) {
  if (filters.kind !== 'single') return rows.filter(row => filters.market === 'ALL' || row.selectedMarket === filters.market);
  const relevant = rows.filter(row => row.selectedMarket === (filters.market === 'HHAD' ? 'HHAD' : 'HAD'));
  return filters.market === 'MIXED' ? [] : relevant;
}

function groupRows(rows, getKey, keyName) {
  const groups = new Map();
  for (const row of rows) {
    const key = getKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([key, items]) => ({ [keyName]: key, ...selectedSummary(items) }))
    .sort((a, b) => keyName === 'businessDate' ? b.businessDate.localeCompare(a.businessDate) : String(a[keyName]).localeCompare(String(b[keyName])));
}

function buildRecommendationReviewPage(source, filters, now = Date.now()) {
  const heads = new Map(), bound = new Map();
  let excludedCorruptRecords = 0;
  for (const event of source.resultEvents || []) {
    if (!validResultEvent(event)) { excludedCorruptRecords++; continue; }
    heads.set(event.eventKey, event);
  }
  for (const decision of source.boundDecisions || []) {
    if (safeValidDecision(decision)) bound.set(decision.decisionId, decision);
    else excludedCorruptRecords++;
  }
  const allSingles = [];
  for (const decision of source.decisions || []) {
    if (!safeValidDecision(decision) || !dateKey(decision.businessDate)) { excludedCorruptRecords++; continue; }
    const head = heads.get(key(decision));
    allSingles.push(singleReviewRow(decision, head, 'HAD'));
    if (decision.handicapAnalysis?.tipCode) allSingles.push(singleReviewRow(decision, head, 'HHAD'));
  }
  const allCombos = [];
  for (const combo of source.combos || []) {
    try {
      if (!validCombo(combo, { frozen: true }) || !dateKey(combo.businessDate)
        || combo.legs.some(leg => !safeValidDecision(bound.get(leg.decisionId)) || bound.get(leg.decisionId).recordHash !== leg.recordHash)) {
        excludedCorruptRecords++; continue;
      }
      allCombos.push(comboReviewRow(combo, heads));
    } catch {
      excludedCorruptRecords++;
    }
  }
  const kindRows = filters.kind === 'single' ? allSingles : allCombos.filter(row => row.combo.size === (filters.kind === 'two' ? 2 : 3));
  const marketRows = selectMarketRows(kindRows, filters);
  const baseRows = marketRows.filter(row => !filters.version || row.versionKey === filters.version);
  const needle = filters.q.toLocaleLowerCase();
  const filteredRows = baseRows.filter(row => (!filters.date || itemDate(row) === filters.date)
    && (filters.state === 'ALL' || row.selectedSettlement?.state === filters.state)
    && (!needle || itemName(row).includes(needle)));
  const sorted = filteredRows.sort((a, b) => itemTime(b) - itemTime(a) || itemId(b).localeCompare(itemId(a)));
  const through = day(now);
  const window = days => {
    const from = new Date(Date.parse(`${through}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
    return { from, through, ...selectedSummary(baseRows.filter(row => itemDate(row) >= from && itemDate(row) <= through)) };
  };
  const total = sorted.length;
  const first = (filters.page - 1) * filters.pageSize;
  const rows = sorted.slice(first, first + filters.pageSize).map(row => row.decision ? {
    ...row, selectionQuality: selectionQuality(row.decision),
    scoreDistribution: buildPublishedScoreDistribution(row.decision),
  } : row);
  return {
    ok: true, version: VERSION, updatedAt: source.updatedAt || new Date(now).toISOString(),
    filters, rows, total, page: filters.page, pageSize: filters.pageSize,
    pageCount: Math.ceil(total / filters.pageSize),
    summary: {
      all: selectedSummary(baseRows),
      filtered: selectedSummary(sorted),
      windows: { last7: window(7), last30: window(30) },
      byDate: groupRows(baseRows, itemDate, 'businessDate'),
      byMarket: groupRows(kindRows.filter(row => !filters.version || row.versionKey === filters.version), row => row.selectedMarket, 'market'),
      byVersion: groupRows(marketRows, row => row.versionKey, 'versionKey'),
    },
    versions: groupRows(marketRows, row => row.versionKey, 'key').map(row => ({
      key: row.key, label: marketRows.find(item => item.versionKey === row.key)?.versionLabel || row.key,
      count: row.published,
    })),
    excludedCorruptRecords,
    definition: 'latest-published-decision-before-cutoff-per-event; combos-use-exact-bound-versions; pending-and-missing-odds-not-losses',
  };
}

async function readRecommendationReviewPage(pool, url, now = Date.now()) {
  const filters = parseReviewQuery(url);
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout','15000',true)");
    const view = await client.query('SELECT payload FROM football.daily_featured_combo_state WHERE id=1');
    const decisions = await client.query(`SELECT DISTINCT ON (source_match_id,event_version) payload FROM football.recommendation_decisions
      ORDER BY source_match_id,event_version,sequence DESC LIMIT ${MAX_SOURCE_ROWS + 1}`);
    const combos = await client.query(`SELECT payload FROM football.recommendation_combo_records ORDER BY business_date DESC,size,id LIMIT ${MAX_SOURCE_ROWS + 1}`);
    const results = await client.query(`SELECT e.payload FROM football.recommendation_result_heads h
      JOIN football.recommendation_result_events e ON e.id=h.event_id LIMIT ${MAX_SOURCE_ROWS + 1}`);
    if ([decisions, combos, results].some(result => result.rows.length > MAX_SOURCE_ROWS)) {
      const error = new Error('review source exceeds bounded read limit');
      error.code = 'REVIEW_SOURCE_LIMIT';
      throw error;
    }
    const ids = [...new Set(combos.rows.flatMap(row => Array.isArray(row.payload?.decisionIds)
      && row.payload.decisionIds.length <= 3 ? row.payload.decisionIds : []))];
    if (ids.length > MAX_SOURCE_ROWS) throw new Error('review combo bindings exceed bounded read limit');
    const bindings = ids.length ? await client.query('SELECT payload FROM football.recommendation_decisions WHERE id=ANY($1::text[])', [ids]) : { rows: [] };
    if (bindings.rows.length > MAX_SOURCE_ROWS) throw new Error('review combo bindings exceed bounded read limit');
    const center = view.rows[0]?.payload?.recommendationCenter;
    if (!center || center.version !== 'recommendation-center-v1') {
      const error = new Error('review publication unavailable'); error.code = 'REVIEW_UNAVAILABLE'; throw error;
    }
    const page = buildRecommendationReviewPage({
      updatedAt: center.updatedAt,
      decisions: decisions.rows.map(row => row.payload),
      combos: combos.rows.map(row => row.payload),
      resultEvents: results.rows.map(row => row.payload),
      boundDecisions: bindings.rows.map(row => row.payload),
    }, filters, now);
    await client.query('COMMIT');
    return page;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the first failure. */ }
    throw error;
  } finally { client.release(); }
}

module.exports = { VERSION, parseReviewQuery, buildRecommendationReviewPage, readRecommendationReviewPage };
