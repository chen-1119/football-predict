import { useEffect, useState } from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { parseRecommendationReviewPage, type ReviewFilters, type ReviewPage } from '../services/recommendationReviewPage';

interface State { key: string; data: ReviewPage | null; loading: boolean; failed: boolean; authorizationRequired: boolean }

export function useRecommendationReviewPage(filters: ReviewFilters, enabled: boolean) {
  const { kind, market, date, version, state, q, page, pageSize } = filters;
  const [refreshToken, setRefreshToken] = useState(0);
  const key = JSON.stringify([kind, market, date, version, state, q, page, pageSize]);
  const [snapshot, setSnapshot] = useState<State>({ key: '', data: null, loading: true, failed: false, authorizationRequired: false });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setSnapshot(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, failed: false, authorizationRequired: false }));
    const params = new URLSearchParams({ coverage: 'separate', kind, market, state, page: String(page), pageSize: String(pageSize) });
    if (date) params.set('date', date);
    if (version) params.set('version', version);
    if (q) params.set('q', q);
    (async () => {
      try {
        const response = await fetch(buildApiUrl(`/api/v1/recommendations/review?${params}`), {
          headers: getAccessAuthHeaders(), credentials: 'include', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw Object.assign(new Error('Review request failed'), { status: response.status });
        const data = parseRecommendationReviewPage(await response.json());
        if (JSON.stringify([data.filters.kind, data.filters.market, data.filters.date, data.filters.version, data.filters.state, data.filters.q, data.filters.page, data.filters.pageSize]) !== key) throw new Error('Mismatched review page');
        if (controller.signal.aborted) throw new Error('Review request timed out');
        if (active) setSnapshot({ key, data, loading: false, failed: false, authorizationRequired: false });
      } catch (error) {
        if (!active) return;
        const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
        const authorizationRequired = status === 401 || status === 403;
        setSnapshot(previous => ({ key, data: authorizationRequired ? null : previous.key === key ? previous.data : null, loading: false, failed: true, authorizationRequired }));
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, key, kind, market, date, version, state, q, page, pageSize, refreshToken]);
  return { ...snapshot, failed: enabled && snapshot.key === key && snapshot.failed, authorizationRequired: enabled && snapshot.authorizationRequired, data: enabled && snapshot.key === key ? snapshot.data : null, loading: enabled && (snapshot.key !== key || snapshot.loading), refresh: () => setRefreshToken(token => token + 1) };
}
