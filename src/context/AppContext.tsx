import React, { useState, useEffect, useRef } from 'react';
import type { Match } from '../services/mockData';
import { matchesPool, registerTeam, registerLeague, registerCountry } from '../services/mockData';
import { AppContext } from './AppContextCore';
import type { DataSyncState, HitAndWinSubmission, Language, User } from './AppContextCore';
import {
  clearStoredAccessSession,
  getAccessAuthHeaders,
  isAccessSessionValid,
  persistAccessSession,
  readStoredAccessSession,
  type AccessSession
} from '../services/accessControl';
import { buildApiUrl, buildStaticUrl, getDataApiBase, normalizeRuntimeBase } from '../services/runtimeUrls';

type SyncedMatch = Match & {
  homeTeamName?: string;
  homeTeamNameEn?: string;
  homeTeamLogo?: string;
  homeTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  homeTeamCountryIso?: string;
  homeTeamColor?: string;
  awayTeamName?: string;
  awayTeamNameEn?: string;
  awayTeamLogo?: string;
  awayTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  awayTeamCountryIso?: string;
  awayTeamColor?: string;
  leagueName?: string;
  leagueNameEn?: string;
  leagueShortName?: string;
  leagueShortNameEn?: string;
  countryName?: string;
  countryNameEn?: string;
  countryFlag?: string;
  homeTeamValue?: string;
  awayTeamValue?: string;
};

type SyncMeta = {
  updatedAt?: string;
  capturedAt?: string;
  lastAttemptAt?: string;
  api?: {
    checkedAt?: string;
    freshnessTime?: string | null;
    ageSeconds?: number | null;
    stale?: boolean;
    staleAfterSeconds?: number;
    syncTriggered?: boolean;
    source?: string;
  };
  byStatus?: Partial<Record<Match['status'], number>>;
  files?: {
    current?: number;
    history?: number;
    teams?: number;
  };
  attempt?: {
    officialOddsMatches?: number;
    officialHandicapOddsMatches?: number;
    officialResultMatches?: number;
    publishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    combinedPublishableMatches?: number;
  };
  fallback?: {
    keptExisting?: boolean;
    mergedPartialFresh?: boolean;
    reason?: string;
    existingMatches?: number;
    freshPublishableMatches?: number;
    sportteryPublishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    fiveHundredResultMatches?: number;
  };
  refreshPolicy?: {
    workflowMinutes?: number;
    pagePollSeconds?: number;
  };
};

type RuntimeConfig = {
  dataApiBase?: string;
  apiBase?: string;
  eventStreamPath?: string;
  disableDataApi?: boolean;
  preferDataApi?: boolean;
  currentPollSeconds?: number;
};

const CURRENT_REFRESH_MS = 30 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const DATA_FETCH_TIMEOUT_MS = 12 * 1000;
const ENV_DATA_API_BASE = getDataApiBase();
const ENV_DISABLE_DATA_API = import.meta.env.VITE_DISABLE_DATA_API === '1';
const ENV_PREFER_DATA_API = import.meta.env.VITE_PREFER_DATA_API !== '0';
const ENV_ENABLE_MOCK_FALLBACK = import.meta.env.DEV && import.meta.env.VITE_ENABLE_MOCK_FALLBACK === '1';

const emptyDataSyncState = (): DataSyncState => ({
  currentLoading: false,
  currentLoaded: false,
  historyLoaded: false,
  historyLoading: false,
  currentCount: 0,
  historyCount: 0,
  totalCount: 0
});

type DataChannel = 'api' | 'static' | 'mock';

type DataCandidate = {
  url: string;
  channel: Exclude<DataChannel, 'mock'>;
};

type DataFetchResult<T> = {
  data: T;
  url: string;
  channel: Exclude<DataChannel, 'mock'>;
};

const readStoredLanguage = (): Language => {
  const savedLang = localStorage.getItem('nerdy_lang');
  return savedLang === 'zh' || savedLang === 'en' ? savedLang : 'zh';
};

const readJsonFromStorage = <T,>(key: string): T | null => {
  const savedValue = localStorage.getItem(key);
  if (!savedValue) return null;

  try {
    return JSON.parse(savedValue) as T;
  } catch {
    return null;
  }
};

const readStoredUser = (): User | null => readJsonFromStorage<User>('nerdy_user');

const readStoredHitAndWinSubmission = (): HitAndWinSubmission | null => {
  return readJsonFromStorage<HitAndWinSubmission>('nerdy_hw_submission');
};

const isSyncedMatchArray = (data: unknown): data is SyncedMatch[] => {
  return Array.isArray(data);
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join('\n');
  }
  return String(error);
};

const fetchJson = async <T,>(url: string, accessToken = ''): Promise<T> => {
  const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const separator = url.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DATA_FETCH_TIMEOUT_MS);

  try {
    const accessHeaders = accessToken
      ? { authorization: `Bearer ${accessToken}` }
      : getAccessAuthHeaders();
    const res = await fetch(`${url}${separator}v=${cacheBuster}`, {
      cache: 'no-store',
      headers: Object.keys(accessHeaders).length ? accessHeaders : undefined,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
  }
};

const fetchFirstAvailable = async <T,>(candidates: DataCandidate[], accessToken = ''): Promise<DataFetchResult<T>> => {
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return {
        data: await fetchJson<T>(candidate.url, accessToken),
        url: candidate.url,
        channel: candidate.channel
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const isUnauthorizedFetchError = (error: unknown) => {
  return error instanceof Error && /\bHTTP 401\b/.test(error.message);
};

const normalizeApiBase = normalizeRuntimeBase;

const readMetaCount = (value: number | undefined) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

const mergeMatches = (baseMatches: Match[], nextMatches: Match[]) => {
  const byId = new Map<string, Match>();

  [...baseMatches, ...nextMatches].forEach((match) => {
    byId.set(match.id, match);
  });

  return Array.from(byId.values()).sort((a, b) => new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime());
};

const registerSyncedMatches = (data: SyncedMatch[]) => {
  data.forEach((m) => {
    if (m.homeTeamId) {
      registerTeam({
        id: m.homeTeamId,
        name: { zh: m.homeTeamName || '未知主队', en: m.homeTeamNameEn || m.homeTeamName || 'Home Team' },
        shortName: { zh: m.homeTeamName || '未知', en: m.homeTeamNameEn || m.homeTeamName || 'Home' },
        logo: m.homeTeamLogoType === 'flag' && m.homeTeamCountryIso
          ? m.homeTeamCountryIso
          : m.homeTeamLogo || m.homeTeamCountryIso || (m.homeTeamName || 'FC').substring(0, 2),
        logoType: m.homeTeamLogoType || (m.homeTeamCountryIso ? 'flag' : undefined),
        value: m.homeTeamValue || '',
        color: m.homeTeamColor || '#7f8c8d'
      });
    }

    if (m.awayTeamId) {
      registerTeam({
        id: m.awayTeamId,
        name: { zh: m.awayTeamName || '未知客队', en: m.awayTeamNameEn || m.awayTeamName || 'Away Team' },
        shortName: { zh: m.awayTeamName || '未知', en: m.awayTeamNameEn || m.awayTeamName || 'Away' },
        logo: m.awayTeamLogoType === 'flag' && m.awayTeamCountryIso
          ? m.awayTeamCountryIso
          : m.awayTeamLogo || m.awayTeamCountryIso || (m.awayTeamName || 'FC').substring(0, 2),
        logoType: m.awayTeamLogoType || (m.awayTeamCountryIso ? 'flag' : undefined),
        value: m.awayTeamValue || '',
        color: m.awayTeamColor || '#95a5a6'
      });
    }

    if (m.leagueId) {
      registerLeague({
        id: m.leagueId,
        name: { zh: m.leagueName || '未知联赛', en: m.leagueNameEn || m.leagueName || 'League' },
        shortName: { zh: m.leagueShortName || m.leagueName || '未知', en: m.leagueShortNameEn || m.leagueNameEn || m.leagueName || 'League' },
        countryId: m.countryId || 'oth',
        isImportant: false
      });
    }

    if (m.countryId) {
      registerCountry({
        id: m.countryId,
        name: { zh: m.countryName || '其他', en: m.countryNameEn || m.countryName || 'Other' },
        flag: m.countryFlag || '🏳️'
      });
    }
  });
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  const [accessSession, setAccessSession] = useState<AccessSession | null>(readStoredAccessSession);
  const [currentUser, setCurrentUser] = useState<User | null>(() => (
    isAccessSessionValid(readStoredAccessSession()) ? readStoredUser() : null
  ));
  const [hitAndWinSubmission, setHitAndWinSubmission] = useState<HitAndWinSubmission | null>(readStoredHitAndWinSubmission);
  const [matches, setMatches] = useState<Match[]>([]);
  const isAccessVerified = isAccessSessionValid(accessSession);
  const lastMetaRef = useRef<{ sourceUpdatedAt?: string; finishedCount?: number }>({});
  const refreshMsRef = useRef(CURRENT_REFRESH_MS);
  const apiBaseRef = useRef<string | null>(ENV_DATA_API_BASE);
  const apiDisabledRef = useRef(ENV_DISABLE_DATA_API);
  const preferApiRef = useRef(ENV_PREFER_DATA_API);
  const pollSecondsOverrideRef = useRef<number | null>(null);
  const eventStreamPathRef = useRef<string | null>(null);
  const apiFailureCountRef = useRef(0);
  const [dataSync, setDataSync] = useState<DataSyncState>(emptyDataSyncState);

  const clearAccessSession = () => {
    setAccessSession(null);
    setCurrentUser(null);
    clearStoredAccessSession();
    localStorage.removeItem('nerdy_user');
  };

  const verifyAccessCode = async (code: string): Promise<AccessSession> => {
    const response = await fetch(buildApiUrl('/api/access/verify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.session?.token || !payload.session.expiresAt) {
      throw new Error(payload?.error || (language === 'zh' ? '校验码无效或已过期' : 'Invalid or expired access code'));
    }

    const session = payload.session as AccessSession;
    persistAccessSession(session);
    setAccessSession(session);
    const verifiedUser = { username: language === 'zh' ? '已认证' : 'Verified' };
    setCurrentUser(verifiedUser);
    localStorage.setItem('nerdy_user', JSON.stringify(verifiedUser));
    return session;
  };

  useEffect(() => {
    if (!accessSession) return;
    const expiresAt = Date.parse(accessSession.expiresAt);
    const delay = expiresAt - Date.now();

    if (!Number.isFinite(expiresAt) || delay <= 0) {
      setAccessSession(null);
      setCurrentUser(null);
      clearStoredAccessSession();
      localStorage.removeItem('nerdy_user');
      return;
    }

    const timer = window.setTimeout(() => {
      setAccessSession(null);
      setCurrentUser(null);
      clearStoredAccessSession();
      localStorage.removeItem('nerdy_user');
    }, Math.min(delay + 1000, 2_147_483_647));

    return () => window.clearTimeout(timer);
  }, [accessSession]);

  // Load current matches first, then fill historical results in the background.
  useEffect(() => {
    if (!isAccessVerified) {
      lastMetaRef.current = {};
      setMatches([]);
      setDataSync(emptyDataSyncState());
      return;
    }

    let cancelled = false;
    const activeAccessToken = accessSession?.token || '';

    const metaToState = (
      meta: SyncMeta | null,
      checkedAt: string,
      fetchInfo?: Pick<DataFetchResult<unknown>, 'url' | 'channel'>
    ) => {
      const sourceUpdatedAt = meta?.api?.freshnessTime || meta?.lastAttemptAt || meta?.updatedAt || meta?.capturedAt;
      const configuredPollSeconds =
        pollSecondsOverrideRef.current ||
        meta?.refreshPolicy?.pagePollSeconds ||
        CURRENT_REFRESH_MS / 1000;
      const pagePollSeconds = Math.min(30, Math.max(10, configuredPollSeconds));
      refreshMsRef.current = pagePollSeconds * 1000;

      return {
        updatedAt: sourceUpdatedAt || checkedAt,
        sourceUpdatedAt,
        lastCheckedAt: checkedAt,
        lastAttemptAt: meta?.lastAttemptAt,
        refreshIntervalSeconds: pagePollSeconds,
        backendRefreshMinutes: meta?.refreshPolicy?.workflowMinutes || 5,
        byStatus: meta?.byStatus,
        sourceAgeSeconds: meta?.api?.ageSeconds,
        sourceStale: meta?.api?.stale,
        syncTriggered: meta?.api?.syncTriggered,
        dataApiSource: meta?.api?.source,
        dataChannel: fetchInfo?.channel,
        lastDataUrl: fetchInfo?.url,
        dataApiBase: apiBaseRef.current || undefined,
        apiFailureCount: apiFailureCountRef.current,
        sourceAttempt: meta?.attempt,
        sourceFallback: meta?.fallback
      };
    };

    const fetchSyncMeta = async (): Promise<SyncMeta | null> => {
      try {
        return (await fetchFirstAvailable<SyncMeta>(dataUrls('/sync-meta', [buildStaticUrl('data/sync-meta.json')]), activeAccessToken)).data;
      } catch {
        return null;
      }
    };

    const loadRuntimeConfig = async () => {
      if (apiBaseRef.current || apiDisabledRef.current) return;

      try {
        const config = await fetchJson<RuntimeConfig>(buildStaticUrl('data/runtime-config.json'), activeAccessToken);
        if (config.disableDataApi) {
          apiDisabledRef.current = true;
          return;
        }

        apiBaseRef.current = normalizeApiBase(config.dataApiBase || config.apiBase);
        preferApiRef.current = config.preferDataApi ?? true;
        eventStreamPathRef.current = config.eventStreamPath || null;
        if (typeof config.currentPollSeconds === 'number' && Number.isFinite(config.currentPollSeconds)) {
          pollSecondsOverrideRef.current = Math.min(30, Math.max(10, config.currentPollSeconds));
          refreshMsRef.current = pollSecondsOverrideRef.current * 1000;
        }
      } catch {
        // Runtime config is optional; same-origin /api remains the first fast path.
      }
    };

    const applyData = (data: unknown, mode: 'current' | 'history') => {
      if (cancelled) return 0;

      try {
        if (isSyncedMatchArray(data)) {
          if (data.length === 0) {
            if (mode === 'current') {
              setMatches((current) => current.filter((match) => match.status === 'FINISHED'));
            }
            return 0;
          }

          registerSyncedMatches(data);
          setMatches((current) => {
            if (mode === 'current') {
              const nextIds = new Set(data.map((match) => match.id));
              const retained = current.filter((match) => {
                if (nextIds.has(match.id)) return false;
                return match.status === 'FINISHED';
              });
              return mergeMatches(retained, data);
            }

            return mergeMatches(current, data);
          });
          return data.length;
        }
      } catch (error: unknown) {
        console.error(error);
        setDataSync((current) => ({
          ...current,
          historyLoading: false,
          error: formatError(error),
          lastCheckedAt: new Date().toISOString()
        }));
      }

      return 0;
    };

    const loadCurrent = async (isInitial = false) => {
      const checkedAt = new Date().toISOString();
      if (!cancelled) {
        setDataSync((current) => ({
          ...current,
          currentLoading: true,
          error: isInitial ? undefined : current.error,
          lastCheckedAt: checkedAt
        }));
      }
      try {
        const [dataResult, meta, sourceHealth] = await Promise.all([
          fetchFirstAvailable<unknown>(
            dataUrls('/matches/current?view=list', [buildStaticUrl('data/matches-current.json'), buildStaticUrl('matches.json')]),
            activeAccessToken
          ),
          fetchSyncMeta(),
          fetchSourceHealth()
        ]);
        apiFailureCountRef.current = dataResult.channel === 'api' ? 0 : apiFailureCountRef.current + 1;
        const currentCount = applyData(dataResult.data, 'current');
        const metaState = metaToState(meta, checkedAt, dataResult);
        const metaCurrentCount = readMetaCount(meta?.files?.current);
        const metaHistoryCount = readMetaCount(meta?.files?.history);
        const finishedCount = meta?.byStatus?.FINISHED;
        const shouldRefreshHistory = !isInitial && Boolean(metaState.sourceUpdatedAt) && (
          lastMetaRef.current.sourceUpdatedAt !== metaState.sourceUpdatedAt ||
          (typeof finishedCount === 'number' && lastMetaRef.current.finishedCount !== finishedCount)
        );
        lastMetaRef.current = {
          sourceUpdatedAt: metaState.sourceUpdatedAt,
          finishedCount
        };
        if (cancelled) return;
        setDataSync((current) => ({
          ...current,
          currentLoading: false,
          currentLoaded: currentCount > 0,
          historyLoading: isInitial ? true : current.historyLoading,
          currentCount: metaCurrentCount ?? currentCount,
          historyCount: Math.max(current.historyCount, metaHistoryCount ?? 0),
          totalCount: (metaCurrentCount ?? currentCount) + Math.max(current.historyCount, metaHistoryCount ?? 0),
          error: undefined,
          sourceHealth: sourceHealth || current.sourceHealth,
          ...metaState
        }));
        if (shouldRefreshHistory) {
          window.setTimeout(() => {
            void loadHistory();
          }, 250);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        console.error(error);

        apiFailureCountRef.current += 1;

        if (isUnauthorizedFetchError(error)) {
          setAccessSession(null);
          setCurrentUser(null);
          clearStoredAccessSession();
          localStorage.removeItem('nerdy_user');
        }

        if (isInitial && ENV_ENABLE_MOCK_FALLBACK) {
          setMatches(matchesPool);
          setDataSync({
            currentLoading: false,
            currentLoaded: false,
            historyLoaded: false,
            historyLoading: false,
            currentCount: 0,
            historyCount: 0,
            totalCount: matchesPool.length,
            error: formatError(error),
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds: CURRENT_REFRESH_MS / 1000,
            backendRefreshMinutes: 5,
            dataChannel: 'mock',
            apiFailureCount: apiFailureCountRef.current
          });
          // 降级使用静态 mock 引擎数据
          console.log('Using static fallback matchesPool data.');
          return;
        }

        if (isInitial) {
          setMatches([]);
          setDataSync({
            currentLoading: false,
            currentLoaded: false,
            historyLoaded: false,
            historyLoading: false,
            currentCount: 0,
            historyCount: 0,
            totalCount: 0,
            error: formatError(error),
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds: CURRENT_REFRESH_MS / 1000,
            backendRefreshMinutes: 5,
            apiFailureCount: apiFailureCountRef.current
          });
          console.warn('Initial match data unavailable; mock fallback is disabled.');
          return;
        }

        setDataSync((current) => ({
          ...current,
          currentLoading: false,
          error: formatError(error),
          lastCheckedAt: checkedAt
        }));
      }
    };

    const loadHistory = async () => {
      try {
        const historyData = await fetchFirstAvailable<unknown>(
          dataUrls('/matches/history?view=list&limit=600', [], {
            preferStatic: false
          }),
          activeAccessToken
        );
        const historyCount = applyData(historyData.data, 'history');
        if (cancelled) return;
        setDataSync((current) => ({
          ...current,
          historyLoaded: historyCount > 0,
          historyLoading: false,
          historyCount,
          totalCount: current.currentCount + historyCount,
          dataChannel: current.dataChannel || historyData.channel,
          lastDataUrl: current.lastDataUrl || historyData.url
        }));
      } catch (error: unknown) {
        console.warn('History data is unavailable; current matches remain usable.', error);
        if (cancelled) return;
        setDataSync((current) => ({
          ...current,
          historyLoaded: false,
          historyLoading: false,
          error: formatError(error)
        }));
      }
    };

    const dataUrls = (
      endpoint: string,
      staticUrls: string[],
      options: { preferStatic?: boolean } = {}
    ): DataCandidate[] => {
      const staticCandidates = staticUrls.map((url) => ({ url, channel: 'static' as const }));
      if (apiDisabledRef.current || !preferApiRef.current) return staticCandidates;

      const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      const apiBase = apiBaseRef.current || '/api';
      const apiCandidate = { url: `${apiBase}${normalizedEndpoint}`, channel: 'api' as const };
      return options.preferStatic ? [...staticCandidates, apiCandidate] : [apiCandidate, ...staticCandidates];
    };

    const fetchSourceHealth = async (): Promise<DataSyncState['sourceHealth'] | undefined> => {
      try {
        const result = await fetchFirstAvailable<DataSyncState['sourceHealth']>(dataUrls('/data/sources', []), activeAccessToken);
        return result.data;
      } catch {
        return undefined;
      }
    };

    let eventSource: EventSource | undefined;
    let eventRefreshTimer: number | undefined;

    const refreshFromServerEvent = (type: string) => {
      if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer);
      eventRefreshTimer = window.setTimeout(() => {
        if (cancelled) return;
        setDataSync((current) => ({
          ...current,
          liveUpdates: 'sse',
          lastServerEventAt: new Date().toISOString(),
          lastServerEventType: type
        }));
        void loadCurrent(false).then(() => {
          if (type === 'sync_completed' || type === 'gpt_prediction_completed') {
            void loadHistory();
          }
        });
      }, 350);
    };

    const openEventStream = () => {
      if (apiDisabledRef.current || typeof EventSource === 'undefined') return;
      const apiBase = apiBaseRef.current || '/api';
      const configuredPath = eventStreamPathRef.current;
      const streamUrl = configuredPath
        ? (configuredPath.startsWith('http') ? configuredPath : configuredPath)
        : `${apiBase}/events`;
      eventSource = new EventSource(streamUrl);
      eventSource.onopen = () => {
        if (cancelled) return;
        setDataSync((current) => ({ ...current, liveUpdates: 'sse' }));
      };
      eventSource.onerror = () => {
        if (cancelled) return;
        setDataSync((current) => ({ ...current, liveUpdates: 'poll' }));
      };
      const handleServerEvent = (event: MessageEvent) => {
        refreshFromServerEvent(event.type || 'message');
      };
      eventSource.addEventListener('sync_completed', handleServerEvent);
      eventSource.addEventListener('sync_failed', handleServerEvent);
      eventSource.addEventListener('gpt_prediction_completed', handleServerEvent);
    };

    void loadRuntimeConfig().finally(() => {
      openEventStream();
      return loadCurrent(true);
    }).then(() => {
      window.setTimeout(() => {
        void loadHistory();
      }, 250);
    });

    let currentTimer: number | undefined;
    const scheduleCurrentRefresh = () => {
      currentTimer = window.setTimeout(() => {
        void loadCurrent(false).finally(() => {
          if (!cancelled) scheduleCurrentRefresh();
        });
      }, refreshMsRef.current);
    };
    scheduleCurrentRefresh();

    const refreshOnWake = () => {
      if (document.visibilityState === 'visible') {
        void loadCurrent(false);
      }
    };
    window.addEventListener('focus', refreshOnWake);
    document.addEventListener('visibilitychange', refreshOnWake);

    const historyTimer = window.setInterval(() => {
      void loadHistory();
    }, HISTORY_REFRESH_MS);

    return () => {
      cancelled = true;
      if (currentTimer) window.clearTimeout(currentTimer);
      if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer);
      eventSource?.close();
      window.removeEventListener('focus', refreshOnWake);
      document.removeEventListener('visibilitychange', refreshOnWake);
      window.clearInterval(historyTimer);
    };
  }, [isAccessVerified, accessSession?.token]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('nerdy_lang', lang);
  };

  const submitHitAndWin = (selections: HitAndWinSubmission): boolean => {
    setHitAndWinSubmission(selections);
    localStorage.setItem('nerdy_hw_submission', JSON.stringify(selections));
    return true;
  };

  const login = (username: string) => {
    const u: User = { username };
    setCurrentUser(u);
    localStorage.setItem('nerdy_user', JSON.stringify(u));
  };

  const register = (username: string) => {
    login(username); // 注册即登录
  };

  const logout = () => {
    clearAccessSession();
    setHitAndWinSubmission(null);
    localStorage.removeItem('nerdy_slip_count');
    localStorage.removeItem('nerdy_hw_submission');
  };

  return (
    <AppContext.Provider value={{
      language,
      setLanguage,
      currentUser,
      setCurrentUser,
      accessSession,
      isAccessVerified,
      hitAndWinSubmission,
      submitHitAndWin,
      verifyAccessCode,
      clearAccessSession,
      login,
      register,
      logout,
      matches,
      dataSync
    }}>
      {children}
    </AppContext.Provider>
  );
};
