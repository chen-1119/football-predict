import React, { useState, useEffect, useRef } from 'react';
import type { Match } from '../services/mockData';
import { matchesPool, registerTeam, registerLeague, registerCountry } from '../services/mockData';
import { AppContext } from './AppContextCore';
import type { DataSyncState, HitAndWinSubmission, Language, User } from './AppContextCore';

type SyncedMatch = Match & {
  homeTeamName?: string;
  homeTeamNameEn?: string;
  homeTeamLogo?: string;
  homeTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  homeTeamColor?: string;
  awayTeamName?: string;
  awayTeamNameEn?: string;
  awayTeamLogo?: string;
  awayTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
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
  refreshPolicy?: {
    workflowMinutes?: number;
    pagePollSeconds?: number;
  };
};

type RuntimeConfig = {
  dataApiBase?: string;
  apiBase?: string;
  disableDataApi?: boolean;
};

const CURRENT_REFRESH_MS = 30 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const ENV_DATA_API_BASE = import.meta.env.VITE_DATA_API_BASE;
const ENV_DISABLE_DATA_API = import.meta.env.VITE_DISABLE_DATA_API === '1';

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

const fetchJson = async <T,>(url: string): Promise<T> => {
  const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${url}?v=${cacheBuster}`, {
    cache: 'no-store',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache'
    }
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
};

const fetchFirstAvailable = async <T,>(urls: string[]): Promise<T> => {
  let lastError: unknown;

  for (const url of urls) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const normalizeApiBase = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
};

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
        logo: m.homeTeamLogo || (m.homeTeamName || 'FC').substring(0, 2),
        logoType: m.homeTeamLogoType,
        value: m.homeTeamValue || '',
        color: m.homeTeamColor || '#7f8c8d'
      });
    }

    if (m.awayTeamId) {
      registerTeam({
        id: m.awayTeamId,
        name: { zh: m.awayTeamName || '未知客队', en: m.awayTeamNameEn || m.awayTeamName || 'Away Team' },
        shortName: { zh: m.awayTeamName || '未知', en: m.awayTeamNameEn || m.awayTeamName || 'Away' },
        logo: m.awayTeamLogo || (m.awayTeamName || 'FC').substring(0, 2),
        logoType: m.awayTeamLogoType,
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
  const [currentUser, setCurrentUser] = useState<User | null>(readStoredUser);
  const [hitAndWinSubmission, setHitAndWinSubmission] = useState<HitAndWinSubmission | null>(readStoredHitAndWinSubmission);
  const [matches, setMatches] = useState<Match[]>([]);
  const lastMetaRef = useRef<{ sourceUpdatedAt?: string; finishedCount?: number }>({});
  const refreshMsRef = useRef(CURRENT_REFRESH_MS);
  const apiBaseRef = useRef<string | null>(normalizeApiBase(ENV_DATA_API_BASE));
  const apiDisabledRef = useRef(ENV_DISABLE_DATA_API);
  const [dataSync, setDataSync] = useState<DataSyncState>({
    currentLoaded: false,
    historyLoaded: false,
    historyLoading: false,
    currentCount: 0,
    historyCount: 0,
    totalCount: 0
  });

  // Load current matches first, then fill historical results in the background.
  useEffect(() => {
    let cancelled = false;

    const metaToState = (meta: SyncMeta | null, checkedAt: string) => {
      const sourceUpdatedAt = meta?.api?.freshnessTime || meta?.lastAttemptAt || meta?.updatedAt || meta?.capturedAt;
      const configuredPollSeconds = meta?.refreshPolicy?.pagePollSeconds || CURRENT_REFRESH_MS / 1000;
      const pagePollSeconds = Math.min(30, Math.max(15, configuredPollSeconds));
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
        dataApiSource: meta?.api?.source
      };
    };

    const fetchSyncMeta = async (): Promise<SyncMeta | null> => {
      try {
        return await fetchFirstAvailable<SyncMeta>(dataUrls('/sync-meta', ['./data/sync-meta.json']));
      } catch {
        return null;
      }
    };

    const loadRuntimeConfig = async () => {
      if (apiBaseRef.current || apiDisabledRef.current) return;

      try {
        const config = await fetchJson<RuntimeConfig>('./data/runtime-config.json');
        if (config.disableDataApi) {
          apiDisabledRef.current = true;
          return;
        }

        apiBaseRef.current = normalizeApiBase(config.dataApiBase || config.apiBase);
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
      try {
        const [data, meta] = await Promise.all([
          fetchFirstAvailable<unknown>(dataUrls('/matches/current', ['./data/matches-current.json', './matches.json'])),
          fetchSyncMeta()
        ]);
        const currentCount = applyData(data, 'current');
        const metaState = metaToState(meta, checkedAt);
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
          currentLoaded: currentCount > 0,
          historyLoading: isInitial ? true : current.historyLoading,
          currentCount: metaCurrentCount ?? currentCount,
          historyCount: Math.max(current.historyCount, metaHistoryCount ?? 0),
          totalCount: (metaCurrentCount ?? currentCount) + Math.max(current.historyCount, metaHistoryCount ?? 0),
          error: undefined,
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

        if (isInitial) {
          setMatches(matchesPool);
          setDataSync({
            currentLoaded: false,
            historyLoaded: false,
            historyLoading: false,
            currentCount: 0,
            historyCount: 0,
            totalCount: matchesPool.length,
            error: formatError(error),
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds: CURRENT_REFRESH_MS / 1000,
            backendRefreshMinutes: 5
          });
          // 降级使用静态 mock 引擎数据
          console.log('Using static fallback matchesPool data.');
          return;
        }

        setDataSync((current) => ({
          ...current,
          error: formatError(error),
          lastCheckedAt: checkedAt
        }));
      }
    };

    const loadHistory = async () => {
      try {
        const historyData = await fetchFirstAvailable<unknown>(dataUrls('/matches/history', ['./data/matches-history.json']));
        const historyCount = applyData(historyData, 'history');
        if (cancelled) return;
        setDataSync((current) => ({
          ...current,
          historyLoaded: historyCount > 0,
          historyLoading: false,
          historyCount,
          totalCount: current.currentCount + historyCount
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

    const dataUrls = (endpoint: string, staticUrls: string[]) => {
      if (apiDisabledRef.current) return staticUrls;

      const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      const apiBase = apiBaseRef.current || '/api';
      return [`${apiBase}${normalizedEndpoint}`, ...staticUrls];
    };

    void loadRuntimeConfig().finally(() => loadCurrent(true)).then(() => {
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
      window.removeEventListener('focus', refreshOnWake);
      document.removeEventListener('visibilitychange', refreshOnWake);
      window.clearInterval(historyTimer);
    };
  }, []);

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
    setCurrentUser(null);
    setHitAndWinSubmission(null);
    localStorage.removeItem('nerdy_user');
    localStorage.removeItem('nerdy_slip_count');
    localStorage.removeItem('nerdy_hw_submission');
  };

  return (
    <AppContext.Provider value={{
      language,
      setLanguage,
      currentUser,
      setCurrentUser,
      hitAndWinSubmission,
      submitHitAndWin,
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
