import * as React from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import {
  parseDailyComboLedger,
  type DailyComboLedgerView,
} from '../services/dailyComboView';

export interface DailyComboQueryState {
  ledger: DailyComboLedgerView | null;
  loading: boolean;
  failed: boolean;
  lastSuccessAt: number | null;
  refresh: () => void;
}

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function useDailyFeaturedCombos(): DailyComboQueryState {
  const [ledger, setLedger] = React.useState<DailyComboLedgerView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [lastSuccessAt, setLastSuccessAt] = React.useState<number | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const refresh = React.useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  React.useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | null = null;

    const load = async () => {
      if (stopped || activeController) return;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(buildApiUrl('/api/v1/daily-featured-combos'), {
          headers: getAccessAuthHeaders(),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: activeController.signal,
        });
        if (!response.ok) throw new Error(`combo api ${response.status}`);
        const payload = parseDailyComboLedger(await response.json());
        if (!stopped) {
          setLedger(payload);
          setFailed(false);
          setLastSuccessAt(Date.now());
        }
      } catch {
        if (!stopped) setFailed(true);
      } finally {
        window.clearTimeout(timeout);
        activeController = null;
        if (!stopped) {
          setLoading(false);
          timer = window.setTimeout(load, POLL_MS);
        }
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };

    if (!ledger) setLoading(true);
    void load();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      activeController?.abort();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshKey]);

  return { ledger, loading, failed, lastSuccessAt, refresh };
}
