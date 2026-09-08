import { createRoot } from 'react-dom/client';
import { DataAdoptionDetails } from '../../../src/components/predictions/DataAdoptionDetails';
import type { Match } from '../../../src/services/mockData';
import '../../../src/index.css';
import '../../../src/styles/recommendation-evidence.css';

// Synthetic consumer fixture only: integrity flags here are not publication proof.
const params = new URLSearchParams(location.search);
const language = params.get('lang') === 'en' ? 'en' : 'zh';
const match = params.get('mode') === 'missing' ? {} : { predictionMeta: { publicReferenceDecision: {
  integrityVerified: true, decisionAt: '2026-09-07T01:00:00Z', contentHash: 'a'.repeat(64),
  evidenceBinding: { modelVersion: `synthetic-model-${'long-version-'.repeat(20)}` },
  dataGaps: { calculationUsage: {
    version: 'model-input-usage-v1', scope: 'base-calculation-only', sourceVerified: false,
    rows: [{ key: 'form', stage: 'form-lambda-blend', weight: .3, used: true, receiptHash: 'b'.repeat(64),
      sources: ['500-recent-form'], fallbackMetrics: 2 },
    { key: 'elo', stage: 'base-outcome-blend', weight: 0, used: false, receiptHash: 'c'.repeat(64) }],
  }, preMatchQuality: { components: {
    homeForm: { status: 'conflicting' }, elo: { status: 'stale' },
    referee: { status: 'published_after_cutoff' }, lineup: { status: 'not_yet_publishable' },
    weather: { status: 'verified', sourceObservedAt: '2026-09-07T00:00:00Z' }, injuries: { status: 'missing' },
  } }, inputSummaries: { form: { home: { sampleSize: 4, lastMatchAt: '2026-09-01T12:00:00Z', resultEvidence: {
    version: 'recent-form-result-evidence-v1', sourceVerified: false, sampleRows: 4, homeRows: 3, awayRows: 1,
    observedRows: 0, missingObservedAtRows: 4, missingSourceRows: 4, beforeKickoffRows: 0, afterDecisionRows: 0,
    latestObservedAt: null, decisionAt: '2026-09-07T01:00:00Z', temporalStatus: 'unverified', selectionHash: 'd'.repeat(64),
    contentObservation: { version: 'recent-form-content-receipt-summary-v1', scope: 'local-content-receipt-only', sourceVerified: false,
      sampleRows: 4, receivedRows: 3, missingReceiptRows: 1, afterDecisionRows: 0, latestFirstObservedAt: '2026-09-06T18:00:00.000Z', decisionAt: '2026-09-07T01:00:00Z' },
  } }, away: { sampleSize: 0 } },
    elo: { homeMatches: 20, awayMatches: 20 } } }
} } };
const collector = params.get('mode') === 'collector' ? { apiFootball: { fixtureId: 991222, lastCheckedAt: '2026-09-07T14:00:00Z',
  mappingVerified: false, verificationBlockers: ['provider-entity-registry-not-exact'],
  fixtureAccess: { version: 'api-football-fixture-access-diagnostic-v1', state: 'outside-recorded-window',
    requestedDate: '2026-09-09', allowedFrom: '2026-09-06', allowedTo: '2026-09-08',
    checkedAt: '2026-09-07T14:00:00Z', restrictionRecordedAt: '2026-09-07T13:45:00Z', refreshMinutes: 120, suspended: false },
  temporalRejections: ['lineups:clock-evidence-not-verifiable'] } } : undefined;
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 900, margin: '0 auto', padding: 16 }}>
  <p>本地合成数据验收 · 不代表线上比赛或来源核验</p>
  <h1 style={{ fontSize: 26, margin: '16px 0' }}>数据采用与缺口</h1>
  <DataAdoptionDetails match={{ ...match, externalSignals: collector } as unknown as Match} language={language} />
</main>);
