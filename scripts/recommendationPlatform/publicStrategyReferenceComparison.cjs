'use strict';

const crypto = require('node:crypto');
const { hash } = require('../../src/services/publishedForecastPolicy.cjs');
const { strictInstant } = require('../../src/services/strictInstant.cjs');
const { attestPublicReferenceDecision } = require('../../src/services/publicReferenceDecision.cjs');
const { resolveIndexedPublicReferenceEvidence } = require('../../server/publicReferenceArchive.cjs');
const { validDecision } = require('./decision.cjs');
const { validResultEvent, settleDecision } = require('./results.cjs');

const VERSION = 'public-strategy-reference-comparison-v1';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => value == null ? null : structuredClone(value);
const seal = body => ({ ...body, contentHash: hash(body) });
function instant(value) {
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9, '0'));
}
function safeKey(row) {
  try {
    const id = String(row?.sourceMatchId || '').replace(/^sporttery_/, '');
    const at = instant(row?.eventVersion || row?.kickoffTime);
    return id && at !== null ? JSON.stringify([id, at.toString()]) : null;
  } catch { return null; }
}
const day = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
function assert(value, reason) { if (!value) throw new Error(`PUBLIC_REFERENCE_${reason}`); }
function originalScore(prediction) {
  // A model score matrix is not an originally published score selection.
  const value = prediction?.exactScore;
  if (value == null) return null;
  assert(value && Number.isSafeInteger(value.home) && value.home >= 0
    && Number.isSafeInteger(value.away) && value.away >= 0
    && value.label === `${value.home}-${value.away}`, 'ORIGINAL_SCORE_INVALID');
  return { label: value.label, home: value.home, away: value.away,
    probability: typeof value.probability === 'number' && value.probability >= 0 && value.probability <= 1 ? value.probability : null };
}

/** source is original UTF-8 export bytes, never an object with a claimed hash.
 * Each original order-sensitive record AND its evidence/index proof is verified
 * before producing lightweight rows. The enclosing frozen manifest must bind
 * this archive hash: its content hash is integrity, not independent attestation. */
function buildPublicReferenceArchive(source, finalDecisions, { sourceSha256, businessDate } = {}) {
  assert(Buffer.isBuffer(source) || typeof source === 'string', 'SOURCE_BYTES_REQUIRED');
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  assert(bytes.length > 0 && bytes.length <= 20 * 1024 * 1024, 'SOURCE_BOUND');
  assert(sha(sourceSha256) && crypto.createHash('sha256').update(bytes).digest('hex') === sourceSha256, 'SOURCE_HASH_MISMATCH');
  assert(typeof businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    && Number.isFinite(Date.parse(`${businessDate}T00:00:00Z`))
    && new Date(`${businessDate}T00:00:00Z`).toISOString().slice(0, 10) === businessDate, 'BUSINESS_DATE_INVALID');
  const previousDay = new Date(Date.parse(`${businessDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const input = JSON.parse(bytes.toString('utf8'));
  assert(input.version === 'target-public-reference-order-preserved-readonly-v1'
    && input.readOnly === 'on' && input.productionWrites === 0 && instant(input.observedAt) !== null
    && typeof input.manifestJsonText === 'string' && Array.isArray(input.shards) && input.shards.length <= 1000, 'SOURCE_CONTRACT_INVALID');
  assert(Array.isArray(finalDecisions) && finalDecisions.length > 0 && finalDecisions.length <= 64, 'FINAL_DECISIONS_INVALID');
  const finals = new Map();
  for (const d of finalDecisions) {
    assert(validDecision(d) && d.businessDate === businessDate && d.homeTeamId && d.awayTeamId && safeKey(d), 'FINAL_DECISION_INVALID');
    assert(instant(d.publishedAt) !== null && instant(d.publishedAt) <= instant(input.observedAt), 'FINAL_DECISION_AFTER_SOURCE');
    assert(!finals.has(safeKey(d)), 'DUPLICATE_FINAL_EVENT'); finals.set(safeKey(d), d);
  }
  const manifest = JSON.parse(input.manifestJsonText), seen = new Set(), clocksSeen = new Set(), rows = [];
  for (const item of input.shards) {
    assert(typeof item?.payloadJsonText === 'string', 'ORIGINAL_JSON_REQUIRED');
    const shard = JSON.parse(item.payloadJsonText), record = shard.record;
    const d = finals.get(safeKey(record));
    assert(d && record?.sourceMatchId === d.sourceMatchId, 'EVENT_MISMATCH');
    assert(item.id === `public-reference-index:row:${record.contentHash}` && !seen.has(record.contentHash), 'DUPLICATE_OR_INVALID_RECORD_ID');
    seen.add(record.contentHash);
    assert(attestPublicReferenceDecision(record, record)
      && resolveIndexedPublicReferenceEvidence(manifest, shard, record.contentHash).ok === true, 'RECORD_EVIDENCE_INDEX_INVALID');
    const e = shard.entry.evidence;
    assert(safeKey(e) === safeKey(d) && String(e.featureSnapshot?.sourceMatchId) === d.sourceMatchId
      && instant(e.featureSnapshot.kickoffTime) === instant(d.eventVersion), 'FEATURE_EVENT_MISMATCH');
    // These originals normally have no team IDs. Do not invent them or silently
    // discard a conflicting identity if a future record contains one.
    for (const value of [record, e, e.featureSnapshot]) {
      for (const key of ['homeTeamId', 'awayTeamId']) assert(value[key] == null || value[key] === d[key], 'ORIGINAL_TEAM_MISMATCH');
    }
    const decided = instant(record.decisionAt), recorded = instant(record.recordedAt);
    const ownCutoff = instant(record.cutoffTime), finalCutoff = instant(d.cutoffTime), kickoff = instant(d.eventVersion);
    const cutoff = ownCutoff !== null && finalCutoff !== null ? (ownCutoff < finalCutoff ? ownCutoff : finalCutoff) : null;
    assert(decided !== null && recorded !== null && cutoff !== null && kickoff !== null
      && decided <= recorded && decided < cutoff && recorded < cutoff && recorded < kickoff
      && recorded <= instant(input.observedAt), 'RECORD_CLOCK_INVALID');
    const publicationKey = JSON.stringify([safeKey(record), recorded.toString()]);
    assert(!clocksSeen.has(publicationKey), 'AMBIGUOUS_RECORD_CLOCK'); clocksSeen.add(publicationKey);
    const clocks = [e.featureSnapshot.capturedAt, e.probabilityModel.generatedAt];
    if (e.probabilityModel.unifiedPosterior?.generatedAt != null) clocks.push(e.probabilityModel.unifiedPosterior.generatedAt);
    assert(clocks.every(t => instant(t) !== null && instant(t) <= decided), 'EVIDENCE_CLOCK_INVALID');
    const recordedDay = day(record.recordedAt);
    assert(recordedDay === businessDate || recordedDay === previousDay, 'OUTSIDE_COHORT_DAYS');
    const p = record.prediction, market = p.oddsPoolCode, line = market === 'HAD' ? 0 : Number(p.handicapLine);
    assert(['HAD', 'HHAD'].includes(market) && ['1', 'X', '2'].includes(p.tipCode)
      && Number.isSafeInteger(line) && (market === 'HAD' || line !== 0)
      && typeof p.odds === 'number' && Number.isFinite(p.odds) && p.odds > 1, 'PICK_INVALID');
    const probability = p.confidence?.publicMetrics?.modelProbability;
    assert(probability == null || (typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1), 'PROBABILITY_INVALID');
    const sourceProof = e.sourceProof?.[market];
    rows.push({ id: `public_cohort_${hash([VERSION, record.contentHash, d.recordHash])}`,
      cohort: recordedDay === businessDate ? 'today' : 'previous-day', recordedDay,
      sourceMatchId: d.sourceMatchId, eventVersion: d.eventVersion, kickoffTime: d.kickoffTime,
      homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId, homeTeamName: d.homeTeamName, awayTeamName: d.awayTeamName,
      finalDecisionId: d.decisionId, finalDecisionRecordHash: d.recordHash,
      referenceDecisionId: record.decisionId, referenceHash: record.contentHash, revision: record.revision, previousHash: record.previousHash,
      decisionAt: record.decisionAt, recordedAt: record.recordedAt, cutoffTime: record.cutoffTime, finalCutoffTime: d.cutoffTime,
      modelVersion: record.evidenceBinding.modelVersion, policyVersion: record.evidenceBinding.policyVersion,
      pick: { market, tipCode: p.tipCode, handicapLine: line, probability: probability ?? null, odds: p.odds,
        probabilityOrigin: probability == null ? null : 'original-public-prediction-confidence' },
      exactScore: originalScore(p), originalScoreOrigin: p.exactScore == null ? 'no-original-public-score-pick' : 'original-public-prediction',
      evidenceBinding: clone(record.evidenceBinding), sourceSnapshotId: item.id,
      sourceShardSha256: crypto.createHash('sha256').update(item.payloadJsonText).digest('hex'),
      sourceClocks: { receivedAt: sourceProof?.timing?.receivedAt ?? null, providerObservedAt: sourceProof?.timing?.providerObservedAt ?? null },
      originalTeamIdentityPresent: Boolean(record.homeTeamId && record.awayTeamId),
      teamBinding: 'validated-final-decision-via-exact-event', integrityScope: 'original-record-evidence-and-index',
      sourceVerified: false, formalEligible: false, formalHitRateEligible: false });
  }
  rows.sort((a, b) => a.sourceMatchId.localeCompare(b.sourceMatchId)
    || (instant(a.recordedAt) < instant(b.recordedAt) ? -1 : instant(a.recordedAt) > instant(b.recordedAt) ? 1 : a.id.localeCompare(b.id)));
  return seal({ version: VERSION, kind: 'public-reference-archive', scope: 'reference-only', businessDate, previousDay,
    sourceSha256, sourceObservedAt: input.observedAt, sourceIndexManifestHash: manifest.contentHash,
    finalDecisionBindings: [...finals.values()].map(d => ({ sourceMatchId: d.sourceMatchId, eventVersion: d.eventVersion,
      decisionId: d.decisionId, recordHash: d.recordHash, homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId })),
    productionWrites: 0, formalEligible: false, formalHitRateEligible: false, sourceVerified: false,
    independentMatchCount: new Set(rows.map(safeKey)).size, rows,
    warning: 'Repeated public versions are not independent matches. Content/index integrity is not source attestation or model qualification.' });
}

function validArchive(archive) {
  try {
    const { contentHash, ...body } = archive;
    return sha(contentHash) && contentHash === hash(body) && archive.version === VERSION
      && archive.kind === 'public-reference-archive' && archive.scope === 'reference-only'
      && archive.formalEligible === false && archive.formalHitRateEligible === false && archive.productionWrites === 0
      && sha(archive.sourceSha256) && Array.isArray(archive.rows) && archive.rows.length <= 1000
      && archive.rows.every(r => safeKey(r) && sha(r.referenceHash) && sha(r.finalDecisionRecordHash)
        && r.formalEligible === false && r.formalHitRateEligible === false);
  } catch { return false; }
}
function resultFor(row, heads, asOf) {
  // Malformed unrelated heads are isolated instead of crashing every event.
  const same = heads.filter(h => safeKey(h) !== null && safeKey(h) === safeKey(row));
  if (!same.length) return { state: 'PENDING', score: null, resultEventId: null };
  const head = same.slice().sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  const observed = instant(head.observedAt);
  if (!validResultEvent(head) || observed === null || observed > asOf
    || head.homeTeamId !== row.homeTeamId || head.awayTeamId !== row.awayTeamId
    || (head.state === 'FINAL' && observed < instant(row.eventVersion))
    || same.some(h => h.revision === head.revision && h.eventId !== head.eventId)) {
    return { state: 'DISPUTED', score: null, resultEventId: head.eventId || null, reason: 'unverified-or-conflicting-result' };
  }
  return { state: head.state, score: head.state === 'FINAL' ? `${head.scoreHome}-${head.scoreAway}` : null,
    resultEventId: head.eventId, revision: head.revision, event: head };
}
const counts = rows => {
  const count = state => rows.filter(r => r.settlement.state === state).length;
  return { versions: rows.length, independentMatches: new Set(rows.map(safeKey)).size,
    won: count('WON'), lost: count('LOST'), pending: count('PENDING'), void: count('VOID'), disputed: count('DISPUTED') };
};
function comparePublicReferenceArchive(archive, heads, { asOf } = {}) {
  const at = instant(asOf);
  assert(validArchive(archive) && Array.isArray(heads) && heads.length <= 10000, 'ARCHIVE_OR_HEADS_INVALID');
  assert(at !== null && at >= instant(archive.sourceObservedAt), 'COMPARISON_CLOCK_INVALID');
  const rows = archive.rows.map(row => {
    const result = resultFor(row, heads, at);
    const settlement = result.state === 'FINAL'
      ? settleDecision({ ...row, ...row.pick }, result.event)
      : { state: result.state, score: result.score, resultEventId: result.resultEventId, ...(result.reason ? { reason: result.reason } : {}) };
    const exactScoreSettlement = !row.exactScore ? { state: 'EXCLUDED', reason: 'no-original-public-score-pick' }
      : result.state !== 'FINAL' ? { state: result.state, score: result.score, resultEventId: result.resultEventId }
        : { state: row.exactScore.label === result.score ? 'WON' : 'LOST', score: result.score, resultEventId: result.resultEventId };
    return { ...row, settlement, exactScoreSettlement };
  });
  const cohorts = Object.fromEntries(['today', 'previous-day'].map(cohort => {
    const versions = rows.filter(r => r.cohort === cohort), latest = new Map();
    for (const row of versions) {
      const old = latest.get(safeKey(row));
      if (!old || instant(row.recordedAt) > instant(old.recordedAt)
        || (instant(row.recordedAt) === instant(old.recordedAt) && row.revision > old.revision)) latest.set(safeKey(row), row);
    }
    const unique = [...latest.values()], summary = counts(unique), settled = summary.won + summary.lost;
    return [cohort, { versionCounts: counts(versions), uniqueLatestPerEvent: { ...summary, settled,
      referenceHitRate: settled ? summary.won / settled : null,
      selectionRule: 'latest-recorded-reference-per-event-in-cohort', recordIds: unique.map(r => r.id) } }];
  }));
  return seal({ version: VERSION, kind: 'public-reference-comparison', scope: 'reference-only', asOf,
    archiveContentHash: archive.contentHash, sourceSha256: archive.sourceSha256, productionWrites: 0,
    formalEligible: false, formalHitRateEligible: false, cohorts, rows });
}

module.exports = { VERSION, buildPublicReferenceArchive, comparePublicReferenceArchive, validPublicReferenceArchive: validArchive };
