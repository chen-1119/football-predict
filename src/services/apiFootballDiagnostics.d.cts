export interface ApiFootballCollectorDiagnostics {
  version: 'api-football-collector-diagnostics-v1';
  scope: 'collector-only-not-frozen-decision';
  provider: 'api-football';
  fixtureId: string | null;
  checkedAt: string | null;
  mappingStatus: 'recorded' | 'unverified' | 'conflicting';
  fixtureAccess: {
    version: 'api-football-fixture-access-diagnostic-v1';
    state: 'invalid-record' | 'stale-record' | 'account-restricted' | 'outside-recorded-window' | 'within-recorded-window';
    requestedDate: string | null;
    allowedFrom: string | null;
    allowedTo: string | null;
    checkedAt: string | null;
    restrictionRecordedAt: string | null;
    refreshMinutes: number | null;
    suspended: boolean;
  } | null;
  features: Array<{
    key: 'injuries' | 'lineups' | 'apiFootballOdds';
    state: 'not-received' | 'clock-rejected' | 'receipt-recorded' | 'legacy-unverified';
    receivedAt: string | null;
    sourceUpdatedAt: string | null;
    sourceTimeStatus: 'missing' | 'recorded' | 'invalid' | 'after-receipt' | 'unverified';
  }>;
}
export function compactApiFootballDiagnostics(signals: unknown): ApiFootballCollectorDiagnostics | null;
