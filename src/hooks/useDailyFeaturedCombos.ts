import * as React from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { parseDailyComboLedger, type DailyComboLedgerView } from '../services/dailyComboView';
import { createPollingController } from '../services/pollingController';

export interface DailyComboQueryState {
  ledger: DailyComboLedgerView | null;
  loading: boolean;
  failed: boolean;
  lastSuccessAt: number | null;
  refresh: () => void;
}
export function useDailyFeaturedCombos(): DailyComboQueryState {
  const [ledger, setLedger] = React.useState<DailyComboLedgerView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [lastSuccessAt, setLastSuccessAt] = React.useState<number | null>(null);
  const refreshRef = React.useRef<() => void>(() => undefined);
  const refresh = React.useCallback(() => refreshRef.current(), []);

  React.useEffect(() => {
    let newestLedgerAt = Number.NEGATIVE_INFINITY;
    const controller = createPollingController<DailyComboLedgerView>({
      request: async (signal) => {
        const response = await fetch(buildApiUrl('/api/v1/daily-featured-combos'), {
          headers: getAccessAuthHeaders(), cache: 'no-store', credentials: 'same-origin', signal,
        });
        if (!response.ok) throw Object.assign(new Error('Combo API request failed'), { status: response.status });
        return parseDailyComboLedger(await response.json());
      },
      onData: (payload) => {
        const stamp = Date.parse(payload.updatedAt || '');
        if (!Number.isFinite(stamp) || stamp < newestLedgerAt || stamp > Date.now() + 300000) {
          throw new Error('Refusing a regressed or invalid ledger clock');
        }
        newestLedgerAt = stamp;
        setLedger(payload); setFailed(false); setLastSuccessAt(Date.now());
      },
      onError: () => setFailed(true),
      onSettled: () => setLoading(false),
      isVisible: () => document.visibilityState === 'visible',
    });
    refreshRef.current = () => controller.refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') controller.refresh(); };
    const onVisibility = () => controller.visibilityChanged();
    controller.start();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      refreshRef.current = () => undefined;
      controller.stop();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return { ledger, loading, failed, lastSuccessAt, refresh };
}
