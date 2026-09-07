export interface ApiFootballCollectorDiagnostics {
  version: 'api-football-collector-diagnostics-v1';
  scope: 'collector-only-not-frozen-decision';
  provider: 'api-football';
  fixtureId: string | null;
  checkedAt: string | null;
  mappingStatus: 'recorded' | 'unverified' | 'conflicting';
  features: Array<{
    key: 'injuries' | 'lineups' | 'apiFootballOdds';
    state: 'not-received' | 'clock-rejected' | 'receipt-recorded' | 'legacy-unverified';
    receivedAt: string | null;
    sourceUpdatedAt: string | null;
    sourceTimeStatus: 'missing' | 'recorded' | 'invalid' | 'after-receipt' | 'unverified';
  }>;
}
export function compactApiFootballDiagnostics(signals: unknown): ApiFootballCollectorDiagnostics | null;
