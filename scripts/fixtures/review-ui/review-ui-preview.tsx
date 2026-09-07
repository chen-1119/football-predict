import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppContext } from '../../../src/context/AppContextCore';
import { HitAndWin } from '../../../src/pages/HitAndWin';
import '../../../src/index.css';

// Synthetic QA only. No production credentials, requests or match mutations.
const mode = new URLSearchParams(location.search).get('mode') || 'complete';
const zh = new URLSearchParams(location.search).get('lang') !== 'en';
const summary = (reference: boolean) => {
  const value = {
  version: reference ? 'reference-review-performance-v1' : 'formal-review-performance-v1',
  generatedAt: '2026-09-06T16:00:00Z', startDate: '2026-08-16', timezone: 'Asia/Shanghai',
  cumulative: reference ? { won: 610, lost: 640, settled: 1250 } : { won: 0, lost: 0, settled: 0 },
  daily: reference ? [{ date: '2026-08-16', won: 604, lost: 633, settled: 1237 }, { date: '2026-09-06', won: 6, lost: 7, settled: 13 }] : [],
  policy: { sourceScope: 'server-complete-history', unit: 'match-best' },
  };
  const empty = { cumulative: { won: 0, lost: 0, settled: 0 }, daily: [] };
  return { ...value, marketBreakdown: { version: 'review-best-market-v1', HAD: { cumulative: value.cumulative, daily: value.daily }, HHAD: empty, UNKNOWN: empty } };
};
const scorecard = mode === 'missing' ? {} : {
  formalReviewPerformance: summary(false), referenceReviewPerformance: summary(true),
  shadowTracks: { CANDIDATE_PROSPECTIVE: { candidateRevisionId: `candidate-${'abcdef'.repeat(20)}`, frozenAt: '2026-09-01T10:00:00Z', evaluatedAt: '2026-09-07T04:00:00Z', cohort: { shadow: { settled: 123 } } } },
};
const matches = mode === 'missing' ? [] : [{
  id: 'qa-only-no-real-match', businessDate: '2026-09-06', status: 'FINISHED', homeTeamId: 'qa-home', awayTeamId: 'qa-away',
  homeTeamName: '合成验收主队名称特别长的足球俱乐部', awayTeamName: '合成验收客队', kickoffTime: '2026-09-06T12:00:00Z', scoreHome: 1, scoreAway: 1,
  postMatchReview: { generatedAt: '2026-09-06T15:00:00Z', finalScore: '1-1', predictionReview: { rows: [{ marketType: 'BEST', performanceTrack: 'reference', recommendationAction: 'reference', reviewRole: 'reference', resultStatus: 'WON', tipCode: 'X', tipLabel: { zh: '平局', en: 'Draw' }, actualLabel: { zh: '平局', en: 'Draw' }, oddsPoolCode: 'HAD', odds: 3.6 }] } },
}];
const context = { language: zh ? 'zh' : 'en', matches, dataSync: { modelEvaluation: { publicScorecard: scorecard } } };
createRoot(document.getElementById('root')!).render(<MemoryRouter><AppContext.Provider value={context as any}>
  <main style={{ maxWidth: 1280, margin: '0 auto', padding: 16 }}>
    <p style={{ color: '#d5b35f', marginBottom: 16 }}>本地合成数据验收 · 不代表线上命中率</p><HitAndWin />
  </main>
</AppContext.Provider></MemoryRouter>);
