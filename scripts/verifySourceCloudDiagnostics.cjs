'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { diagnoseSourceCollection: diagnose } = require('./sourceCollectionDiagnostic.cjs');
const { sourceCoverageReport: report, reportFromFiles } = require('./sourceCoverageReport.cjs');
const observedAt = '2026-10-02T12:00:00Z';
const receipt = () => ({ source: 'online-immutable-active-generation', sameSnapshot: true, observedAt,
  publication: { generationId: 'g-test', manifestHash: 'test', sourceCycleId: 'cycle-original', committedAt: '2026-09-30T15:52:07Z' } });
const row = () => ({ id: 'sporttery_1', sourceMatchId: '1', homeTeamId: 'h', awayTeamId: 'a',
  kickoffTime: '2026-09-30T18:30:00+08:00', source: 'sporttery',
  sourceUrl: 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry',
  sourceObservedAt: '2026-09-30T10:31:46Z', sourceCycleId: 'old-cycle',
  odds: { odds1: 2, oddsX: 3, odds2: 4 }, oddsSource: 'sporttery:HAD',
  oddsMarketProvenance: { provider: { id: 'sporttery', official: true },
    response: { rawSha256: 'a'.repeat(64) }, attestation: { commitment: { collectorCycleId: 'original-cycle' } },
    strict: { eligible: true, diagnosticOnly: false }, market: { poolCode: 'HAD', sourceMatchId: '1' },
    endpoint: { url: 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry' },
    timing: { providerObservedAt: '2026-09-30T09:00:00Z', receivedAt: '2026-09-30T10:00:00Z' },
    extraction: { poolCode: 'HAD', odds: { '1': 2, X: 3, '2': 4 } } },
  externalSignals: { preMatch: { quality: { components: { xg: { status: 'estimated', source: 'poisson',
    evidenceType: 'pre-match-xg-estimate', sourceObservedAt: observedAt } } } } } });
const attempt = () => ({ source: 'sporttery', scope: 'current-schedule', observedAt,
  httpStatus: 200, schemaValid: true, providerSuccess: true, rows: 0, sourceDataUpdatedAt: '2026-09-30T15:34:00Z',
  closure: { verified: true, scope: 'current-schedule', noticeUrl: 'https://www.sporttery.cn/notice.html',
    startsAt: '2026-10-01T00:00:00+08:00', endsAt: '2026-10-05T00:00:00+08:00', verifiedAt: '2026-10-02T11:00:00Z' } });
test('verified closure preserves original data clock and proposes low-frequency observation', () => {
  const input = attempt(), before = JSON.stringify(input), r = diagnose(input);
  assert.equal(r.state, 'closed'); assert.equal(r.retryAfterSeconds, 21600);
  assert.equal(r.sourceDataUpdatedAt, input.sourceDataUpdatedAt); assert.equal(r.publicationAction, 'none');
  assert.equal(JSON.stringify(input), before); assert.equal(r.consecutiveFailures, 0);
});
test('closure cannot conceal transport, WAF, parsing or invalid row-count failures', () => {
  for (const [change, state] of [[{ httpStatus: 567 }, 'blocked'], [{ httpStatus: 0 }, 'failed'],
    [{ schemaValid: false }, 'failed'], [{ providerSuccess: false }, 'failed'], [{ providerSuccess: undefined }, 'failed'],
    [{ rows: null }, 'failed'], [{ rows: -1 }, 'failed']]) {
    assert.equal(diagnose({ ...attempt(), ...change }).state, state);
  }
});
test('verified Finance Ministry notice is supported and response evidence is retained', () => {
  const input = attempt(); input.closure.noticeUrl = 'https://www.mof.gov.cn/gp/xxgkml/zhs/202512/t20251225_3980248.htm';
  input.sourceCycleId = 'original-cycle'; input.rawSha256 = 'a'.repeat(64);
  const r = diagnose(input); assert.equal(r.state, 'closed');
  assert.deepEqual(r.audit, { sourceCycleId: 'original-cycle', rawSha256: 'a'.repeat(64) });
});
test('empty without valid official window and scope remains unknown with backoff', () => {
  const cases = [null, { ...attempt().closure, verified: false }, { ...attempt().closure, noticeUrl: 'https://example.org' },
    { ...attempt().closure, startsAt: '2026-10-03T00:00:00Z' }, { ...attempt().closure, endsAt: observedAt },
    { ...attempt().closure, verifiedAt: '2026-10-03T00:00:00Z' }];
  for (const closure of cases) assert.equal(diagnose({ ...attempt(), closure }).state, 'unknown-empty');
  assert.equal(diagnose({ ...attempt(), scope: 'archive' }).state, 'unknown-empty');
  assert.equal(diagnose({ ...attempt(), source: '500.com' }).state, 'unknown-empty');
});
test('nonempty valid response during closure remains available', () => {
  assert.equal(diagnose({ ...attempt(), rows: 2 }).state, 'available');
});
test('ordinary and blocked backoff saturate and respect Retry-After', () => {
  assert.equal(diagnose({ ...attempt(), httpStatus: 500 }).retryAfterSeconds, 60);
  assert.equal(diagnose({ ...attempt(), httpStatus: 500, consecutiveFailures: 1000 }).retryAfterSeconds, 3600);
  assert.equal(diagnose({ ...attempt(), httpStatus: 567 }).retryAfterSeconds, 21600);
  assert.equal(diagnose({ ...attempt(), httpStatus: 429, consecutiveFailures: 1000 }).retryAfterSeconds, 86400);
  assert.equal(diagnose({ ...attempt(), httpStatus: 500, retryAfterSeconds: 5000 }).retryAfterSeconds, 5000);
});
test('invalid clocks/counters/provider delay fail closed', () => {
  for (const change of [{ observedAt: 'bad' }, { observedAt: '2026-02-30T12:00:00Z' },
    { consecutiveFailures: NaN }, { consecutiveFailures: -1 }, { retryAfterSeconds: 90000 }]) {
    assert.throws(() => diagnose({ ...attempt(), ...change }));
  }
});
test('old official evidence is stale, not fresh or updated by export observation', () => {
  const r = report([row()], receipt());
  assert.equal(r.coverage.schedule.stale, 1); assert.equal(r.coverage.officialSP.stale, 1);
  assert.equal(r.coverage.officialSP.evidencedRatio, 1); assert.equal(r.coverage.officialSP.freshRatio, 0);
  assert.equal(r.matches[0].fields.schedule.observedAt, row().sourceObservedAt);
  assert.equal(r.publication.sourceCycleId, 'cycle-original');
  assert.equal(r.matches[0].fields.officialSP.providerUpdatedAt, null);
});
test('estimated xG is never counted as measured coverage and missing injuries are not zero', () => {
  const r = report([row()], receipt());
  assert.equal(r.coverage.realXg.evidencedRatio, 0); assert.equal(r.matches[0].fields.realXg.state, 'unknown');
  assert.equal(r.matches[0].fields.realXg.reason, 'estimate-is-not-measured-xg');
  assert.equal(r.matches[0].fields.injuries.present, false); assert.equal(r.matches[0].fields.players.present, false);
});
test('strict summaries cannot promote mismatched or unofficial SP', () => {
  const cases = [r => r.odds.odds1 = 2.1, r => r.oddsSource = '500.com:HAD',
    r => r.oddsMarketProvenance.market.sourceMatchId = '2', r => r.oddsMarketProvenance.provider.official = false,
    r => r.oddsMarketProvenance.endpoint.url = 'https://example.org', r => r.odds.oddsX = null,
    r => { delete r.sourceMatchId; delete r.oddsMarketProvenance.market.sourceMatchId; },
    r => delete r.oddsMarketProvenance.response.rawSha256];
  for (const change of cases) { const item = row(); change(item); assert.equal(report([item], receipt()).coverage.officialSP.evidencedRatio, 0); }
});
test('missing/future observation clocks cannot borrow export timestamp', () => {
  const r = row(); delete r.sourceObservedAt; r.oddsMarketProvenance.timing = {};
  assert.equal(report([r], receipt()).coverage.schedule.unknown, 1);
  assert.equal(report([r], receipt()).coverage.officialSP.unknown, 1);
  r.sourceObservedAt = '2026-10-03T00:00:00Z';
  assert.equal(report([r], receipt()).matches[0].fields.schedule.reason, 'observation-after-report-clock');
  r.oddsMarketProvenance.timing = { providerObservedAt: '2026-09-30T09:00:00Z', receivedAt: '2026-10-03T00:00:00Z' };
  assert.equal(report([r], receipt()).coverage.officialSP.evidencedRatio, 0);
});
test('HHAD coverage checks its own pool, signed extraction and handicap line', () => {
  const item = row(); item.handicapOdds = { ...item.odds }; item.handicapOddsSource = 'sporttery:HHAD'; item.handicapLine = '+1';
  item.handicapOddsMarketProvenance = structuredClone(item.oddsMarketProvenance);
  item.handicapOddsMarketProvenance.market.poolCode = 'HHAD';
  item.handicapOddsMarketProvenance.extraction.poolCode = 'HHAD';
  item.handicapOddsMarketProvenance.extraction.handicapLine = '1';
  assert.equal(report([item], receipt()).coverage.officialHhadSP.evidencedRatio, 1);
  item.handicapLine = '-1'; assert.equal(report([item], receipt()).coverage.officialHhadSP.evidencedRatio, 0);
});
test('empty cohort has null ratios and retains publication; invalid publication is rejected', () => {
  assert.equal(report([], receipt()).coverage.schedule.freshRatio, null);
  assert.throws(() => report([], { ...receipt(), sameSnapshot: false }));
  assert.throws(() => report([], receipt(), { asOf: '2026-09-29T00:00:00Z' }));
});
test('microsecond Python receipt clocks preserve originals with millisecond comparison', () => {
  const input = receipt(); input.observedAt = '2026-10-02T11:54:44.265464Z';
  const r = report([row()], input);
  assert.equal(r.exportObservedAt, input.observedAt); assert.equal(r.asOf, '2026-10-02T11:54:44.265Z');
  assert.throws(() => report([], { ...input, observedAt: '2026-02-30T11:54:44.265464Z' }));
});
test('file reader verifies hashes and generation binding before any coverage computation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cloud-test-'));
  try {
    const raw = Buffer.from(JSON.stringify([row()])); const matches = path.join(dir, 'matches.json'), rec = path.join(dir, 'receipt.json');
    const hash = createHash('sha256').update(raw).digest('hex'), input = receipt();
    input.files = [{ name: 'matches-current.json', bytes: raw.length, sha256: hash,
      provenance: { generationId: 'g-test', manifestHash: 'test', manifestEntry: { sha256: hash } } }];
    fs.writeFileSync(matches, raw); fs.writeFileSync(rec, JSON.stringify(input));
    assert.equal(reportFromFiles(rec, matches).coverage.schedule.total, 1);
    input.files[0].provenance.generationId = 'other'; fs.writeFileSync(rec, JSON.stringify(input));
    assert.throws(() => reportFromFiles(rec, matches), /binding mismatch/);
    input.files[0].provenance.generationId = 'g-test'; fs.writeFileSync(rec, JSON.stringify(input));
    fs.appendFileSync(matches, ' '); assert.throws(() => reportFromFiles(rec, matches), /hash\/binding mismatch/);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('source-cloud-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
