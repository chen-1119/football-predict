'use strict';
// Synthetic API responses for the real App entrypoint. Never loaded by production.
const { bindPublicReferenceDecision } = require('../../src/services/publicReferenceDecision.cjs');
const now = '2026-09-07T06:00:00Z', decision = '2026-09-07T05:00:00Z', kickoff = '2026-09-07T12:00:00Z';
const prediction = { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: 'X', odds: 3.6, recommendationAction: 'reference',
  trustScore: 40, tipLabel: { zh: '平局', en: 'Draw' }, explanation: { zh: '合成验收参考，不是实际推荐', en: 'Synthetic QA reference, not a real pick' } };
const base = { id: 'sporttery_991010', sourceMatchId: '991010', status: 'SCHEDULED', sourceStatus: 'SCHEDULED',
  kickoffTime: kickoff, eventVersion: kickoff, buyEndTime: kickoff, businessDate: '2026-09-07', matchDate: '2026-09-07', matchNumStr: '周一001',
  homeTeamId: 'qa-home', awayTeamId: 'qa-away', leagueId: 'qa-league', countryId: 'qa-country',
  homeTeamName: '合成验收主队长名称足球俱乐部', awayTeamName: '合成验收客队', leagueName: '合成验收联赛', countryName: '测试区域',
  homeTeamNameEn: 'Synthetic Long Home Club', awayTeamNameEn: 'Synthetic Away', leagueNameEn: 'Synthetic League',
  odds: { odds1: 2.1, oddsX: 3.6, odds2: 3.1 }, oddsSource: 'sporttery:HAD', oddsUpdatedAt: decision,
  handicapOdds: { odds1: 3.5, oddsX: 3.9, odds2: 1.7 }, handicapLine: '-1', handicapOddsSource: 'sporttery:HHAD',
  predictions: [prediction], probabilityModel: { version: 'synthetic-model', generatedAt: decision,
    probabilities: { home: .4, draw: .35, away: .25 }, oneXTwo: { home: .4, draw: .35, away: .25 } },
  predictionMeta: { generatedAt: decision, decisionId: 'synthetic-full-app', modelVersion: 'synthetic-model', policyVersion: 'synthetic-policy',
    featureSnapshot: { sourceMatchId: '991010', kickoffTime: kickoff, capturedAt: decision, modelInputs: {
      form: { home: { sampleSize: 4, lastMatchAt: '2026-09-01T12:00:00Z', resultEvidence: {
        version: 'recent-form-result-evidence-v1', sourceVerified: false, sampleRows: 4, homeRows: 3, awayRows: 1,
        observedRows: 0, missingObservedAtRows: 4, missingSourceRows: 4, beforeKickoffRows: 0, afterDecisionRows: 0,
        latestObservedAt: null, decisionAt: decision, temporalStatus: 'unverified', selectionHash: 'd'.repeat(64),
        contentObservation: { version: 'recent-form-content-receipt-summary-v1', scope: 'local-content-receipt-only', sourceVerified: false,
          sampleRows: 4, receivedRows: 3, missingReceiptRows: 1, afterDecisionRows: 0, latestFirstObservedAt: '2026-09-06T18:00:00.000Z', decisionAt: decision },
      } }, away: { sampleSize: 0 } },
      elo: { homeMatches: 20, awayMatches: 20 }, dataGaps: { preMatchQuality: { components: {
        homeForm: { status: 'conflicting' }, elo: { status: 'stale' }, referee: { status: 'published_after_cutoff' },
        lineup: { status: 'not_yet_publishable' }, injuries: { status: 'missing' },
        weather: { status: 'verified', sourceObservedAt: decision },
      } } }
    } }
  } };
const current = bindPublicReferenceDecision(base, null, '2026-09-07T05:00:01Z');
const { fixture: frozenReviewFixture } = require('../verifyFrozenReviewVersion.cjs');
const { buildReferenceReviewPerformance, compactReferenceReviewPerformance } = require('../../server/reviewPerformanceSummary.cjs');
const versionHistory = [frozenReviewFixture(), frozenReviewFixture('991004', 'frozen-model-b', 'HHAD'), frozenReviewFixture('991006')];
delete versionHistory[2].postMatchReview.predictionReview.rows[0].frozenVersion;
const versionSummary = compactReferenceReviewPerformance(buildReferenceReviewPerformance({ matches: versionHistory, generatedAt: '2026-09-07T15:00:00.000Z' }));
const history = [true, false].map((won, i) => ({ ...base, id: `sporttery_99102${i}`, sourceMatchId: `99102${i}`,
  status: 'FINISHED', sourceStatus: 'FINISHED', kickoffTime: '2026-09-06T12:00:00Z', buyEndTime: '2026-09-06T12:00:00Z',
  eventVersion: '2026-09-06T12:00:00Z', businessDate: '2026-09-06', matchDate: '2026-09-06', predictionMeta: {},
  scoreHome: won ? 1 : 2, scoreAway: 1,
  resultSource: 'sporttery', resultProvenance: { provider: 'sporttery', official: true, trusted: true, source: 'synthetic-browser-fixture-only' },
  postMatchReview: { generatedAt: now, finalScore: won ? '1-1' : '2-1', predictionReview: { rows: [{ ...prediction,
    performanceTrack: 'reference', reviewRole: 'reference', resultStatus: won ? 'WON' : 'LOST' }] } }
}));
const summary = reference => {
  const cumulative = { won: reference ? 1 : 0, lost: reference ? 1 : 0, settled: reference ? 2 : 0 };
  const daily = reference ? [{ date: '2026-09-06', ...cumulative }] : [];
  const empty = { cumulative: { won: 0, lost: 0, settled: 0 }, daily: [] };
  return { version: reference ? 'reference-review-performance-v1' : 'formal-review-performance-v1', generatedAt: now,
    startDate: '2026-08-16', timezone: 'Asia/Shanghai', cumulative, daily, policy: { sourceScope: 'server-complete-history', unit: 'match-best' },
    exclusions: { beforeStart: 7, invalidDate: 0, invalidIdentity: 1, duplicateEvent: 3, conflictingEvent: 2,
      [reference ? 'withoutFrozenReferenceSettlement' : 'withoutFrozenFormalSettlement']: reference ? 10 : 12 },
    marketBreakdown: { version: 'review-best-market-v1', HAD: { cumulative, daily }, HHAD: empty, UNKNOWN: empty } };
};
function response(pathname, mode = 'complete') {
  const empty = mode === 'missing';
  const currentMatch = mode === 'mutable-home' ? { ...current,
    predictions: [{ ...prediction, tipCode: '1', tipLabel: { zh: '主胜', en: 'Home win' }, odds: 2.1 }],
    probabilityModel: { ...current.probabilityModel, generatedAt: '2026-09-07T05:30:00Z', probabilities: { home: .7, draw: .1, away: .2 } },
  } : current;
  const apiPath = pathname.replace(/^\/api(?:\/v1)?/, '');
  if (pathname === '/data/runtime-config.json') return { dataApiBase: '/api/v1', preferDataApi: true, eventStreamPath: null };
  if (apiPath === '/access/status') return { authorized: true };
  if (apiPath === '/matches/current') return { rows: empty ? [] : [currentMatch], stale: false };
  if (apiPath === '/matches/history') return { rows: empty ? [] : mode === 'versions' ? versionHistory : history, pageInfo: { hasMore: false, nextCursor: null } };
  if (apiPath === '/matches/unresolved-archive') return { rows: [] };
  if (apiPath === '/matches/sporttery_991010') return { match: currentMatch };
  if (apiPath === '/sync-meta') return { updatedAt: now, files: { current: empty ? 0 : 1, history: empty ? 0 : 2 }, api: { stale: false, currentStale: false, source: 'synthetic-only', freshnessTime: now } };
  if (apiPath === '/source-health') return { sources: [], updatedAt: now };
  if (apiPath === '/health') return { apiVersion: 'v1', status: { serviceOk: true, dataFresh: true, recommendationReliable: false }, data: { currentRead: { source: 'synthetic-only' } } };
  if (apiPath === '/model/evaluation') return empty ? {} : { publicScorecard: { version: 'synthetic-full-app-evidence-v1', sample: { predictionRows: 999 },
    ...(mode === 'formal-zero' ? { hitRateAudit: { observed: { settled: 0, hitRate: null }, minimumSettledRows: 500 } } : {}),
    formalReviewPerformance: summary(false), referenceReviewPerformance: mode === 'versions' ? versionSummary : mode === 'exclusion-incomplete'
      ? { ...summary(true), exclusions: { ...summary(true).exclusions, conflictingEvent: null, unrecognized: 1 } } : summary(true) } };
  return undefined;
}
module.exports = { now, current, response, versionSummary };
