import React, { useState, useEffect, useRef } from 'react';
import type { Match } from '../services/mockData';
import { getDateStringOffset, matchesPool, registerTeam, registerLeague, registerCountry } from '../services/mockData';
import { AppContext } from './AppContextCore';
import type { DataSyncState, HitAndWinSubmission, Language, SourceFallbackCoverage, User } from './AppContextCore';
import {
  clearStoredAccessSession,
  getAccessAuthHeaders,
  isAccessSessionValid,
  persistAccessSession,
  readStoredAccessSession,
  type AccessSession
} from '../services/accessControl';
import { buildApiUrl, buildStaticUrl, getDataApiBase, normalizeRuntimeBase } from '../services/runtimeUrls';
import { resolveMatchLifecycle } from '../services/matchLifecycle';
import {
  mergeCurrentRefreshSnapshot,
  mergeMatches
} from '../services/atomicMatchRefresh';
import {
  consumeServerEventRefresh,
  createServerEventRefreshState,
  queueServerEventRefresh,
  settleServerEventRefresh,
  type RefreshableServerEventType,
  type ServerEventPayload
} from '../services/serverEventRefresh';

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
  sourceHealth?: DataSyncState['sourceHealthSummary'];
  sourceAttempt?: DataSyncState['sourceAttempt'];
  sourceFallback?: DataSyncState['sourceFallback'];
  sourceHistoryGuard?: DataSyncState['sourceHistoryGuard'];
  api?: {
    checkedAt?: string;
    freshnessTime?: string | null;
    currentFreshnessTime?: string | null;
    resultFreshnessTime?: string | null;
    historyFreshnessTime?: string | null;
    ageSeconds?: number | null;
    currentAgeSeconds?: number | null;
    resultAgeSeconds?: number | null;
    historyAgeSeconds?: number | null;
    stale?: boolean;
    currentStale?: boolean;
    resultStale?: boolean;
    historyStale?: boolean;
    partialStale?: boolean;
    staleAfterSeconds?: number;
    syncTriggered?: boolean;
    source?: string;
    fallbackCoverage?: SourceFallbackCoverage;
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

type PublicHealth = {
  apiVersion?: string;
  status?: {
    serviceOk?: boolean;
    dataFresh?: boolean;
    sourceHealthOk?: boolean;
    sourceDataFresh?: boolean;
    fallbackDataFresh?: boolean;
    fallbackWithinReliableWindow?: boolean;
    fallbackAgeSeconds?: number | null;
    fallbackMaxAgeSeconds?: number | null;
    servingMode?: string;
    modelEvaluationFresh?: boolean;
    modelEvaluationCoverageOk?: boolean;
    recommendationReliable?: boolean;
  };
  data?: {
    currentRead?: {
      source?: string;
    };
  };
  model?: DataSyncState['modelHealth'];
};

type RuntimeConfig = {
  dataApiBase?: string;
  apiBase?: string;
  eventStreamPath?: string;
  disableDataApi?: boolean;
  preferDataApi?: boolean;
  currentPollSeconds?: number;
};

const CURRENT_REFRESH_MS = 15 * 1000;
const TRANSIENT_CURRENT_REFRESH_MS = 3 * 1000;
const SYNC_META_REFRESH_MS = 30 * 1000;
const SOURCE_HEALTH_REFRESH_MS = 60 * 1000;
const PUBLIC_HEALTH_REFRESH_MS = 60 * 1000;
const MODEL_EVALUATION_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const DATA_FETCH_TIMEOUT_MS = 6 * 1000;
const HISTORY_DATA_FETCH_TIMEOUT_MS = 12 * 1000;
const AUTH_CURRENT_PREFETCH_TIMEOUT_MS = 1200;
const RETAINED_CURRENT_SNAPSHOT_KEY = 'football.currentSnapshot.v1';
const RETAINED_CURRENT_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
const ENV_DATA_API_BASE = getDataApiBase();
const ENV_DISABLE_DATA_API = import.meta.env.VITE_DISABLE_DATA_API === '1';
const ENV_PREFER_DATA_API = import.meta.env.VITE_PREFER_DATA_API !== '0';
const ENV_ENABLE_MOCK_FALLBACK = import.meta.env.DEV && import.meta.env.VITE_ENABLE_MOCK_FALLBACK === '1';

const emptyDataSyncState = (): DataSyncState => ({
  currentLoading: false,
  currentLoaded: false,
  currentRefreshHealthy: false,
  historyLoaded: false,
  historyLoading: false,
  currentCount: 0,
  historyCount: 0,
  totalCount: 0
});

type DataChannel = 'api' | 'static' | 'mock' | 'retained';

type DataCandidate = {
  url: string;
  channel: Extract<DataChannel, 'api' | 'static'>;
};

type DataFetchResult<T> = {
  data: T;
  url: string;
  channel: Extract<DataChannel, 'api' | 'static'>;
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

const matchRowsFromPayload = (data: unknown): SyncedMatch[] | null => {
  if (isSyncedMatchArray(data)) return data;
  if (data && typeof data === 'object' && isSyncedMatchArray((data as { rows?: unknown }).rows)) {
    return (data as { rows: SyncedMatch[] }).rows;
  }
  return null;
};

type HistoryPageInfo = {
  nextCursor?: string | null;
  hasMore?: boolean;
};

const historyPageInfoFromPayload = (data: unknown): HistoryPageInfo | null => {
  if (!data || typeof data !== 'object') return null;
  const pageInfo = (data as { pageInfo?: unknown }).pageInfo;
  return pageInfo && typeof pageInfo === 'object' ? pageInfo as HistoryPageInfo : null;
};

const transitionRowsFromPayload = (data: unknown): SyncedMatch[] => {
  if (!data || typeof data !== 'object') return [];
  const payload = data as { transitionRows?: unknown; recentFinishedRows?: unknown };
  if (isSyncedMatchArray(payload.transitionRows)) return payload.transitionRows;
  // Accept the descriptive alias for forward/backward-compatible API rollout.
  return isSyncedMatchArray(payload.recentFinishedRows) ? payload.recentFinishedRows : [];
};

type RetainedCurrentSnapshot = {
  version: 1;
  savedAt: string;
  session: {
    codeId: string;
    issuedAt: string;
    expiresAt: string;
  };
  data: unknown;
};

const retainedSessionIdentity = (session: AccessSession | null | undefined) => {
  if (!session?.codeId || !session.expiresAt) return '';
  // Re-verifying the same still-active access code issues a new token/issuedAt.
  // The protected snapshot may still be reused because code id and expiry are
  // unchanged; a different code or expiry remains isolated.
  return [session.codeId, session.expiresAt].join('|');
};

const isRetainableMatchRow = (row: unknown): row is SyncedMatch => {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Partial<SyncedMatch>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.kickoffTime === 'string'
    && ['SCHEDULED', 'LIVE', 'PENDING_RESULT', 'FINISHED'].includes(String(candidate.status || ''))
    && Array.isArray(candidate.predictions);
};

const isRetainableCurrentPayload = (data: unknown) => {
  const rows = matchRowsFromPayload(data);
  if (!rows || !rows.every(isRetainableMatchRow)) return false;
  if (!data || typeof data !== 'object') return true;
  const payload = data as { transitionRows?: unknown; recentFinishedRows?: unknown };
  for (const candidate of [payload.transitionRows, payload.recentFinishedRows]) {
    if (candidate !== undefined && (!Array.isArray(candidate) || !candidate.every(isRetainableMatchRow))) {
      return false;
    }
  }
  return true;
};

const clearRetainedCurrentSnapshot = () => {
  try {
    window.sessionStorage.removeItem(RETAINED_CURRENT_SNAPSHOT_KEY);
  } catch {
    // Session storage is an optional continuity layer.
  }
};

const readRetainedCurrentSnapshot = (
  accessSession: AccessSession | null | undefined,
  now = Date.now()
): RetainedCurrentSnapshot | null => {
  try {
    const raw = window.sessionStorage.getItem(RETAINED_CURRENT_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as Partial<RetainedCurrentSnapshot>;
    const savedAtMs = Date.parse(snapshot.savedAt || '');
    const sessionIdentity = retainedSessionIdentity(accessSession);
    if (
      snapshot.version !== 1
      || !sessionIdentity
      || !isAccessSessionValid(accessSession || null, now)
      || retainedSessionIdentity(snapshot.session as AccessSession) !== sessionIdentity
      || !Number.isFinite(savedAtMs)
      || now - savedAtMs < 0
      || now - savedAtMs > RETAINED_CURRENT_SNAPSHOT_MAX_AGE_MS
      || !isRetainableCurrentPayload(snapshot.data)
    ) {
      clearRetainedCurrentSnapshot();
      return null;
    }
    return snapshot as RetainedCurrentSnapshot;
  } catch {
    clearRetainedCurrentSnapshot();
    return null;
  }
};

const retainCurrentSnapshot = (data: unknown, accessSession: AccessSession | null | undefined) => {
  if (!isAccessSessionValid(accessSession || null) || !retainedSessionIdentity(accessSession) || !isRetainableCurrentPayload(data)) return;
  try {
    const snapshot: RetainedCurrentSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      session: {
        codeId: accessSession!.codeId!,
        issuedAt: accessSession!.issuedAt!,
        expiresAt: accessSession!.expiresAt
      },
      data
    };
    window.sessionStorage.setItem(RETAINED_CURRENT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Rendering must not depend on storage availability or quota.
  }
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join('\n');
  }
  return String(error);
};

type JsonResponseCacheEntry = {
  etag: string;
  data: unknown;
};

const jsonResponseCache = new Map<string, JsonResponseCacheEntry>();

const isConditionalApiUrl = (url: string) => /(?:^|\/)api\/v1(?:\/|$)/.test(url);
const transientFetchRetryDelaysMs = [400];

class DataFetchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, cause: unknown) {
    super(`${url}: request timed out after ${timeoutMs}ms`, { cause });
    this.name = 'DataFetchTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

type FetchAbortCause = 'timeout' | 'caller' | null;

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const isSilentFetchCancellation = (error: unknown, signal?: AbortSignal) => (
  Boolean(signal?.aborted) && isAbortError(error)
);

const buildFetchCacheKey = (url: string, headers: Record<string, string>) => [
  url,
  headers.authorization || '',
  headers['x-access-token'] || ''
].join('|');

const sleep = (delayMs: number) => new Promise((resolve) => {
  window.setTimeout(resolve, delayMs);
});

const isTransientFetchError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  if (error instanceof DataFetchTimeoutError) return true;
  if (error.name === 'AbortError') return false;
  return /\bHTTP (408|425|429|500|502|503|504)\b/i.test(error.message)
    || /Failed to fetch|NetworkError|Load failed/i.test(error.message);
};

const fetchJsonOnce = async <T,>(
  url: string,
  accessToken = '',
  requestSignal?: AbortSignal,
  timeoutMs = DATA_FETCH_TIMEOUT_MS
): Promise<T> => {
  const useConditionalRequest = isConditionalApiUrl(url);
  const separator = url.includes('?') ? '&' : '?';
  const requestUrl = useConditionalRequest
    ? url
    : `${url}${separator}v=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  let abortCause: FetchAbortCause = null;
  const abortFromCaller = () => {
    if (abortCause) return;
    abortCause = 'caller';
    controller.abort();
  };
  if (requestSignal?.aborted) abortFromCaller();
  else requestSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    if (abortCause) return;
    abortCause = 'timeout';
    controller.abort();
  }, timeoutMs);

  try {
    const accessHeaders = accessToken
      ? { authorization: `Bearer ${accessToken}` }
      : getAccessAuthHeaders();
    const conditionalCacheKey = buildFetchCacheKey(url, accessHeaders);
    const cached = useConditionalRequest ? jsonResponseCache.get(conditionalCacheKey) : null;
    const headers = {
      ...accessHeaders,
      ...(cached?.etag ? { 'if-none-match': cached.etag } : {})
    };
    const res = await fetch(requestUrl, {
      cache: useConditionalRequest ? 'no-cache' : 'no-store',
      headers: Object.keys(headers).length ? headers : undefined,
      signal: controller.signal
    });
    if (res.status === 304 && cached) {
      return cached.data as T;
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
    const data = await res.json() as T;
    const etag = res.headers.get('etag');
    if (useConditionalRequest && etag) {
      jsonResponseCache.set(conditionalCacheKey, { etag, data });
      if (jsonResponseCache.size > 40) {
        const oldestKey = jsonResponseCache.keys().next().value;
        if (oldestKey) jsonResponseCache.delete(oldestKey);
      }
    }
    return data;
  } catch (error) {
    if (abortCause === 'timeout' && isAbortError(error)) {
      throw new DataFetchTimeoutError(url, timeoutMs, error);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortFromCaller);
  }
};

const fetchJson = async <T,>(
  url: string,
  accessToken = '',
  requestSignal?: AbortSignal,
  timeoutMs = DATA_FETCH_TIMEOUT_MS
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= transientFetchRetryDelaysMs.length; attempt += 1) {
    try {
      requestSignal?.throwIfAborted();
      return await fetchJsonOnce<T>(url, accessToken, requestSignal, timeoutMs);
    } catch (error) {
      lastError = error;
      if (isSilentFetchCancellation(error, requestSignal)) throw error;
      if (!isTransientFetchError(error) || attempt >= transientFetchRetryDelaysMs.length) break;
      await sleep(transientFetchRetryDelaysMs[attempt]);
    }
  }
  throw lastError;
};

type DataFetchValidator<T> = (data: T, candidate: DataCandidate) => void;

const fetchFirstAvailable = async <T,>(
  candidates: DataCandidate[],
  accessToken = '',
  validate?: DataFetchValidator<T>,
  requestSignal?: AbortSignal,
  timeoutMs = DATA_FETCH_TIMEOUT_MS
): Promise<DataFetchResult<T>> => {
  if (!candidates.length) {
    throw new Error('No data endpoint is available.');
  }

  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const data = await fetchJson<T>(candidate.url, accessToken, requestSignal, timeoutMs);
      validate?.(data, candidate);
      return {
        data,
        url: candidate.url,
        channel: candidate.channel
      };
    } catch (error) {
      if (isSilentFetchCancellation(error, requestSignal)) throw error;
      lastError = error;
    }
  }

  throw lastError;
};

const isProtectedAuthFailure = (error: unknown) => (
  error instanceof Error && /\bHTTP (401|403)\b/.test(error.message)
);

const invalidatesRetainedSnapshot = (error: unknown) => (
  error instanceof Error && /\bHTTP (401|403|410)\b/.test(error.message)
);

const matchDateKeys = (match: Pick<Match, 'kickoffDate' | 'businessDate' | 'matchDate' | 'kickoffTime'>) => {
  const kickoffDate = match.kickoffDate || String(match.kickoffTime || '').slice(0, 10) || match.matchDate || '';
  return [kickoffDate, match.businessDate || ''].filter(Boolean);
};

const assertFreshCurrentMatches = (data: unknown, candidate: DataCandidate) => {
  const rows = matchRowsFromPayload(data);
  if (!rows) {
    throw new Error(`${candidate.url}: current payload is not a match array`);
  }
  // An empty current lane is a valid authoritative snapshot: there may simply
  // be no unfinished matches. It must be allowed to clear locally retained rows.
  if (rows.length === 0) return;

  const newestDate = rows
    .flatMap(matchDateKeys)
    .sort()
    .at(-1);
  const staleBeforeDate = getDateStringOffset(-1);
  if (newestDate && newestDate < staleBeforeDate) {
    throw new Error(`${candidate.url}: stale current payload (${newestDate})`);
  }
};

const primeAuthenticatedCurrentSnapshot = async (session: AccessSession) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    AUTH_CURRENT_PREFETCH_TIMEOUT_MS
  );
  const url = buildApiUrl('/api/v1/matches/current?view=list');

  try {
    // Prime both the authenticated ETag cache and the session-bound continuity
    // snapshot before routing away from the access screen. The provider effect
    // can then paint immediately and revalidate the same URL with If-None-Match.
    const data = await fetchJsonOnce<unknown>(url, session.token, controller.signal);
    assertFreshCurrentMatches(data, { url, channel: 'api' });
    retainCurrentSnapshot(data, session);
    return true;
  } catch {
    // Authentication is authoritative. A bounded warm-up miss must never turn
    // a valid access code into a login failure; the normal current-lane loader
    // retains its existing retry and fail-closed session handling.
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
};

const normalizeApiBase = normalizeRuntimeBase;

const readMetaCount = (value: number | undefined) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

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
  const lastMetaRef = useRef<{ resultFreshnessTime?: string | null; finishedCount?: number }>({});
  const diagnosticRefreshAtRef = useRef({
    syncMeta: 0,
    sourceHealth: 0,
    publicHealth: 0,
    modelEvaluation: 0
  });
  const refreshMsRef = useRef(CURRENT_REFRESH_MS);
  const apiBaseRef = useRef<string | null>(ENV_DATA_API_BASE);
  const apiDisabledRef = useRef(ENV_DISABLE_DATA_API);
  const preferApiRef = useRef(ENV_PREFER_DATA_API);
  const pollSecondsOverrideRef = useRef<number | null>(null);
  const eventStreamPathRef = useRef<string | null>(null);
  const apiFailureCountRef = useRef(0);
  const [dataSync, setDataSync] = useState<DataSyncState>(emptyDataSyncState);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const clearAccessSession = () => {
    setAccessSession(null);
    setCurrentUser(null);
    clearStoredAccessSession();
    clearRetainedCurrentSnapshot();
    localStorage.removeItem('nerdy_user');
  };

  const verifyAccessCode = async (code: string): Promise<AccessSession> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DATA_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(buildApiUrl('/api/access/verify'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          language === 'zh' ? '\u6821\u9a8c\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5' : 'Verification timed out. Please try again.',
          { cause: error }
        );
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.session?.token || !payload.session.expiresAt) {
      throw new Error(payload?.error || (language === 'zh' ? '校验码无效或已过期' : 'Invalid or expired access code'));
    }

    const session = payload.session as AccessSession;
    persistAccessSession(session);
    await primeAuthenticatedCurrentSnapshot(session);
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
      clearRetainedCurrentSnapshot();
      localStorage.removeItem('nerdy_user');
      return;
    }

    const timer = window.setTimeout(() => {
      setAccessSession(null);
      setCurrentUser(null);
      clearStoredAccessSession();
      clearRetainedCurrentSnapshot();
      localStorage.removeItem('nerdy_user');
    }, Math.min(delay + 1000, 2_147_483_647));

    return () => window.clearTimeout(timer);
  }, [accessSession]);

  // Load current matches first, then fill historical results in the background.
  useEffect(() => {
    if (!isAccessVerified) {
      lastMetaRef.current = {};
      clearRetainedCurrentSnapshot();
      setMatches([]);
      setDataSync(emptyDataSyncState());
      return;
    }

    let cancelled = false;
    let currentRequestGeneration = 0;
    let currentRequestInFlight: Promise<boolean> | null = null;
    let currentRefreshQueued = false;
    let historyRequestGeneration = 0;
    let historyRequestInFlight: Promise<boolean> | null = null;
    let historyRefreshQueued = false;
    const effectRequestController = new AbortController();
    const effectRequestSignal = effectRequestController.signal;
    const activeAccessToken = accessSession?.token || '';
    const activeAccessSession = accessSession;

    const invalidateActiveAccessSession = (error: unknown) => {
      if (!isProtectedAuthFailure(error)) return false;
      cancelled = true;
      effectRequestController.abort();
      jsonResponseCache.clear();
      lastMetaRef.current = {};
      setAccessSession(null);
      setCurrentUser(null);
      clearStoredAccessSession();
      clearRetainedCurrentSnapshot();
      localStorage.removeItem('nerdy_user');
      setMatches([]);
      setDataSync(emptyDataSyncState());
      return true;
    };

    const setCurrentRefreshCadence = (
      transientFailure: boolean,
      configuredPollSeconds = pollSecondsOverrideRef.current || CURRENT_REFRESH_MS / 1000
    ) => {
      const nextRefreshMs = transientFailure
        ? TRANSIENT_CURRENT_REFRESH_MS
        : Math.min(30, Math.max(10, configuredPollSeconds)) * 1000;
      refreshMsRef.current = nextRefreshMs;
      return nextRefreshMs / 1000;
    };

    const metaToState = (
      meta: SyncMeta | null,
      checkedAt: string,
      fetchInfo?: Pick<DataFetchResult<unknown>, 'url' | 'channel'>
    ) => {
      const sourceUpdatedAt = meta?.api?.currentFreshnessTime || meta?.api?.freshnessTime || meta?.lastAttemptAt || meta?.updatedAt || meta?.capturedAt;
      const configuredPollSeconds =
        pollSecondsOverrideRef.current ||
        meta?.refreshPolicy?.pagePollSeconds ||
        CURRENT_REFRESH_MS / 1000;
      const pagePollSeconds = setCurrentRefreshCadence(false, configuredPollSeconds);

      return {
        updatedAt: sourceUpdatedAt || checkedAt,
        sourceUpdatedAt,
        lastCheckedAt: checkedAt,
        lastAttemptAt: meta?.lastAttemptAt,
        refreshIntervalSeconds: pagePollSeconds,
        backendRefreshMinutes: meta?.refreshPolicy?.workflowMinutes || 5,
        byStatus: meta?.byStatus,
        sourceAgeSeconds: meta?.api?.currentAgeSeconds ?? meta?.api?.ageSeconds,
        sourceStale: meta?.api?.currentStale ?? meta?.api?.stale,
        syncTriggered: meta?.api?.syncTriggered,
        dataApiSource: meta?.api?.source,
        dataChannel: fetchInfo?.channel,
        lastDataUrl: fetchInfo?.url,
        dataApiBase: apiBaseRef.current || undefined,
        apiFailureCount: apiFailureCountRef.current,
        sourceAttempt: meta?.sourceAttempt || meta?.attempt,
        sourceFallback: meta?.sourceFallback || meta?.fallback,
        sourceHistoryGuard: meta?.sourceHistoryGuard,
        sourceHealthSummary: meta?.sourceHealth,
        sourceFallbackCoverage: meta?.api?.fallbackCoverage || (meta?.sourceHealth ? {
          servingMode: meta.sourceHealth.servingMode,
          usable: meta.sourceHealth.usable,
          primaryStale: meta.sourceHealth.primaryStale,
          fallbackReason: meta.sourceHealth.fallbackReason || null
        } : undefined)
      };
    };

    const fetchSyncMeta = async (): Promise<SyncMeta | null> => {
      try {
        return (await fetchFirstAvailable<SyncMeta>(
          dataUrls('/sync-meta', [buildStaticUrl('data/sync-meta.json')]),
          activeAccessToken,
          undefined,
          effectRequestSignal
        )).data;
      } catch {
        return null;
      }
    };

    const loadRuntimeConfig = async () => {
      if (apiBaseRef.current || apiDisabledRef.current) return;

      try {
        const config = await fetchJson<RuntimeConfig>(
          buildStaticUrl('data/runtime-config.json'),
          activeAccessToken,
          effectRequestSignal
        );
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

    const applyData = (data: unknown, mode: 'current' | 'history' | 'archive') => {
      if (cancelled) return 0;

      try {
        const rows = matchRowsFromPayload(data);
        if (rows) {
          if (mode === 'current') {
            const transitionRows = transitionRowsFromPayload(data)
              .filter((match) => resolveMatchLifecycle(match).status === 'FINISHED');
            registerSyncedMatches([...rows, ...transitionRows]);
            setMatches((current) => mergeCurrentRefreshSnapshot(
              current,
              rows,
              transitionRows
            ).matches);
            // Transition rows belong to history and must never inflate the
            // authoritative current-lane count shown in sync diagnostics.
            return rows.length;
          }

          if (rows.length === 0) return 0;

          // Settled history and the protected unresolved archive are separate
          // lanes. The latter preserves immutable pre-match records that have
          // aged out of the compact current payload while official settlement
          // is still delayed.
          const acceptedRows = rows
            .map((match) => resolveMatchLifecycle(match))
            .filter((match) => mode === 'history'
              ? match.status === 'FINISHED'
              : match.status === 'PENDING_RESULT');
          if (acceptedRows.length === 0) return 0;

          registerSyncedMatches(acceptedRows);
          setMatches((current) => mergeMatches(current, acceptedRows));
          return acceptedRows.length;
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

    const runCurrentRequest = async (isInitial = false): Promise<boolean> => {
      const requestGeneration = ++currentRequestGeneration;
      const checkedAt = new Date().toISOString();
      if (!cancelled) {
        setDataSync((current) => ({
          ...current,
          // Background refreshes keep the rendered snapshot interactive. Only
          // the first load is allowed to expose a page-level loading state.
          currentLoading: isInitial && !current.currentLoaded,
          error: isInitial ? undefined : current.error,
          lastCheckedAt: checkedAt
        }));
      }

      // During a cutover, retry only the authoritative current lane. Starting
      // metadata/model/health requests on every three-second probe multiplies
      // outage traffic without helping the fixture cards recover any sooner.
      const recoveryProbeOnly = refreshMsRef.current === TRANSIENT_CURRENT_REFRESH_MS;

      try {
        const dataResult = await fetchFirstAvailable<unknown>(
          dataUrls(`/matches/current?view=list${isInitial ? '' : '&transition=1'}`, []),
          activeAccessToken,
          assertFreshCurrentMatches,
          effectRequestSignal
        );
        if (cancelled || requestGeneration !== currentRequestGeneration) return false;
        apiFailureCountRef.current = dataResult.channel === 'api' ? 0 : apiFailureCountRef.current + 1;
        const refreshIntervalSeconds = setCurrentRefreshCadence(false);
        const currentCount = applyData(dataResult.data, 'current');
        retainCurrentSnapshot(dataResult.data, activeAccessSession);
        setDataSync((current) => ({
          ...current,
          currentLoading: false,
          currentLoaded: true,
          historyLoading: isInitial ? true : current.historyLoading,
          currentCount,
          totalCount: currentCount + current.historyCount,
          error: undefined,
          retainedDataAt: undefined,
          serviceTransitioning: false,
          currentRefreshHealthy: true,
          refreshIntervalSeconds,
          dataChannel: dataResult.channel,
          lastDataUrl: dataResult.url,
          dataApiBase: apiBaseRef.current || undefined,
          apiFailureCount: apiFailureCountRef.current,
          lastCheckedAt: checkedAt
        }));

        // The current schedule owns first paint. Diagnostics start only after
        // it has rendered so cold source-health/model/SQLite work cannot make
        // a newly authenticated customer stare at an empty recovery screen.
        const diagnosticNow = Date.now();
        const diagnosticDue = (
          key: keyof typeof diagnosticRefreshAtRef.current,
          intervalMs: number
        ) => {
          if (recoveryProbeOnly) return false;
          const due = isInitial || diagnosticNow - diagnosticRefreshAtRef.current[key] >= intervalMs;
          if (due) diagnosticRefreshAtRef.current[key] = diagnosticNow;
          return due;
        };
        const metaPromise = diagnosticDue('syncMeta', SYNC_META_REFRESH_MS) ? fetchSyncMeta() : null;
        const sourceHealthPromise = diagnosticDue('sourceHealth', SOURCE_HEALTH_REFRESH_MS)
          ? fetchSourceHealth()
          : null;
        const modelEvaluationPromise = diagnosticDue('modelEvaluation', MODEL_EVALUATION_REFRESH_MS)
          ? fetchModelEvaluation()
          : null;
        const publicHealthPromise = diagnosticDue('publicHealth', PUBLIC_HEALTH_REFRESH_MS)
          ? fetchPublicHealth()
          : null;

        if (metaPromise) void metaPromise.then((meta) => {
          if (cancelled || requestGeneration !== currentRequestGeneration) return;
          const metaState = metaToState(meta, checkedAt, dataResult);
          const metaHistoryCount = readMetaCount(meta?.files?.history);
          const finishedCount = meta?.byStatus?.FINISHED;
          const resultFreshnessTime = meta?.api?.resultFreshnessTime
            || meta?.api?.historyFreshnessTime
            || null;
          const shouldRefreshHistory = !isInitial && (
            (Boolean(resultFreshnessTime) && lastMetaRef.current.resultFreshnessTime !== resultFreshnessTime) ||
            (typeof finishedCount === 'number' && lastMetaRef.current.finishedCount !== finishedCount)
          );
          lastMetaRef.current = {
            resultFreshnessTime,
            finishedCount
          };
          setDataSync((current) => ({
            ...current,
            // The current endpoint is the customer-serving publication and is
            // therefore authoritative for the visible count. Sync-meta may be
            // an older attempt/publication and must never make the UI jump from
            // the rendered 29 rows back to an unrelated 11/34-row count.
            currentCount: current.currentCount,
            historyCount: Math.max(current.historyCount, metaHistoryCount ?? 0),
            totalCount: current.currentCount + Math.max(current.historyCount, metaHistoryCount ?? 0),
            ...metaState
          }));
          if (shouldRefreshHistory) {
            window.setTimeout(() => {
              void loadHistory({ queueIfBusy: true });
            }, 250);
          }
        });

        // Settle diagnostic lanes independently. A slow source-health or
        // public-health request must not hold back the model scorecard, and a
        // slow model artifact must not hide source/runtime status.
        if (sourceHealthPromise) void sourceHealthPromise.then((sourceHealth) => {
          if (cancelled || requestGeneration !== currentRequestGeneration) return;
          setDataSync((current) => ({
            ...current,
            sourceHealth: sourceHealth || current.sourceHealth
          }));
        });
        if (modelEvaluationPromise) void modelEvaluationPromise.then((modelEvaluation) => {
          if (cancelled || requestGeneration !== currentRequestGeneration) return;
          setDataSync((current) => ({
            ...current,
            modelEvaluation: modelEvaluation || current.modelEvaluation
          }));
        });
        if (publicHealthPromise) void publicHealthPromise.then((publicHealth) => {
          if (cancelled || requestGeneration !== currentRequestGeneration) return;
          setDataSync((current) => ({
            ...current,
            modelHealth: publicHealth?.model || current.modelHealth,
            serviceDataFresh: publicHealth?.status?.dataFresh ?? current.serviceDataFresh,
            sourceHealthOk: publicHealth?.status?.sourceHealthOk ?? current.sourceHealthOk,
            sourceDataFresh: publicHealth?.status?.sourceDataFresh ?? current.sourceDataFresh,
            fallbackDataFresh: publicHealth?.status?.fallbackDataFresh ?? current.fallbackDataFresh,
            fallbackWithinReliableWindow: publicHealth?.status?.fallbackWithinReliableWindow ?? current.fallbackWithinReliableWindow,
            fallbackAgeSeconds: publicHealth?.status?.fallbackAgeSeconds ?? current.fallbackAgeSeconds,
            fallbackMaxAgeSeconds: publicHealth?.status?.fallbackMaxAgeSeconds ?? current.fallbackMaxAgeSeconds,
            recommendationReliable: publicHealth?.status?.recommendationReliable ?? current.recommendationReliable,
            healthServingMode: publicHealth?.status?.servingMode || current.healthServingMode,
            healthCurrentReadSource: publicHealth?.data?.currentRead?.source || current.healthCurrentReadSource
          }));
        });
        return true;
      } catch (error: unknown) {
        if (
          cancelled
          || requestGeneration !== currentRequestGeneration
          || isSilentFetchCancellation(error, effectRequestController.signal)
        ) return false;
        console.error(error);

        apiFailureCountRef.current += 1;
        const transientFailure = isTransientFetchError(error);
        const refreshIntervalSeconds = setCurrentRefreshCadence(transientFailure);

        if (invalidatesRetainedSnapshot(error)) {
          clearRetainedCurrentSnapshot();
        }

        if (invalidateActiveAccessSession(error)) return false;

        const retainedSnapshot = isInitial && transientFailure
          ? readRetainedCurrentSnapshot(activeAccessSession)
          : null;
        if (retainedSnapshot) {
          const retainedCount = applyData(retainedSnapshot.data, 'current');
          setDataSync({
            currentLoading: false,
            currentLoaded: true,
            historyLoaded: false,
            historyLoading: false,
            currentCount: retainedCount,
            historyCount: 0,
            totalCount: retainedCount,
            error: formatError(error),
            updatedAt: retainedSnapshot.savedAt,
            sourceUpdatedAt: retainedSnapshot.savedAt,
            retainedDataAt: retainedSnapshot.savedAt,
            serviceTransitioning: true,
            currentRefreshHealthy: false,
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds,
            backendRefreshMinutes: 5,
            dataChannel: 'retained',
            apiFailureCount: apiFailureCountRef.current
          });
          return false;
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
            currentRefreshHealthy: false,
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds,
            backendRefreshMinutes: 5,
            dataChannel: 'mock',
            apiFailureCount: apiFailureCountRef.current
          });
          // 降级使用静态 mock 引擎数据
          console.log('Using static fallback matchesPool data.');
          return false;
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
            serviceTransitioning: transientFailure,
            currentRefreshHealthy: false,
            lastCheckedAt: checkedAt,
            refreshIntervalSeconds,
            backendRefreshMinutes: 5,
            apiFailureCount: apiFailureCountRef.current
          });
          console.warn('Initial match data unavailable; mock fallback is disabled.');
          return false;
        }

        setDataSync((current) => ({
          ...current,
          currentLoading: false,
          serviceTransitioning: transientFailure,
          currentRefreshHealthy: false,
          error: formatError(error),
          lastCheckedAt: checkedAt,
          refreshIntervalSeconds
        }));
        return false;
      }
    };

    const loadHistory = ({ queueIfBusy = false }: { queueIfBusy?: boolean } = {}): Promise<boolean> => {
      if (cancelled) return Promise.resolve(false);
      if (historyRequestInFlight) {
        const activeRequest = historyRequestInFlight;
        if (!queueIfBusy) return activeRequest;
        historyRefreshQueued = true;
        return activeRequest.then((activeSucceeded) => {
          const queuedRequest = historyRequestInFlight;
          return queuedRequest && queuedRequest !== activeRequest
            ? queuedRequest
            : activeSucceeded;
        });
      }

      const requestGeneration = ++historyRequestGeneration;
      const request = (async (): Promise<boolean> => {
        try {
          // Start the optional unresolved archive in parallel, but never make
          // the newest settled-results page wait for it. Both are background
          // lanes with a wider bounded timeout than the first-paint current
          // request; neither can keep the schedule shell blank.
          const unresolvedArchivePromise = fetchFirstAvailable<unknown>(
            dataUrls('/matches/unresolved-archive?view=list&limit=200', []),
            activeAccessToken,
            undefined,
            effectRequestSignal,
            HISTORY_DATA_FETCH_TIMEOUT_MS
          ).catch(() => null);
          const historyData = await fetchFirstAvailable<unknown>(
            dataUrls('/matches/history?view=list&limit=200', []),
            activeAccessToken,
            undefined,
            effectRequestSignal,
            HISTORY_DATA_FETCH_TIMEOUT_MS
          );
          const historyRows = matchRowsFromPayload(historyData.data);
          if (!historyRows) {
            throw new Error('History endpoint returned an invalid match payload.');
          }

          if (cancelled || requestGeneration !== historyRequestGeneration || historyRefreshQueued) return false;

          const accumulatedHistory = [...historyRows];
          let pageInfo = historyPageInfoFromPayload(historyData.data);
          // Hydrate the newest settled fixtures immediately. Fetching the
          // remaining history pages can take several seconds, but recent
          // results and their archived pre-match directions must not stay
          // hidden until the entire 1,200-row background window is ready.
          const progressiveHistoryCount = applyData({ rows: historyRows }, 'history');
          if (progressiveHistoryCount > 0) {
            setDataSync((current) => ({
              ...current,
              historyLoaded: true,
              historyLoading: true,
              historyCount: progressiveHistoryCount,
              totalCount: current.currentCount + progressiveHistoryCount,
              dataChannel: current.dataChannel || historyData.channel,
              lastDataUrl: current.lastDataUrl || historyData.url
            }));
          }

          // The unresolved lane carries immutable pre-match directions for
          // matches waiting on an official result. Merge it as soon as the
          // newest settled page is visible, before paging older history.
          const unresolvedArchiveData = await unresolvedArchivePromise;
          if (cancelled || requestGeneration !== historyRequestGeneration || historyRefreshQueued) return false;
          const progressiveArchiveCount = unresolvedArchiveData
            ? applyData(unresolvedArchiveData.data, 'archive')
            : 0;
          const firstPageLoadedCount = progressiveHistoryCount + progressiveArchiveCount;
          if (progressiveArchiveCount > 0) {
            setDataSync((current) => ({
              ...current,
              historyLoaded: true,
              historyLoading: pageInfo?.hasMore === true,
              historyCount: firstPageLoadedCount,
              totalCount: current.currentCount + firstPageLoadedCount,
              dataChannel: current.dataChannel || historyData.channel,
              lastDataUrl: current.lastDataUrl || historyData.url
            }));
          }

          const seenCursors = new Set<string>();
          while (
            historyData.channel === 'api'
            && pageInfo?.hasMore === true
            && pageInfo.nextCursor
            && accumulatedHistory.length < 1200
          ) {
            const cursor = String(pageInfo.nextCursor);
            if (seenCursors.has(cursor)) break;
            seenCursors.add(cursor);
            const nextPage = await fetchFirstAvailable<unknown>(
              dataUrls(`/matches/history?view=list&limit=200&cursor=${encodeURIComponent(cursor)}`, []),
              activeAccessToken,
              undefined,
              effectRequestSignal,
              HISTORY_DATA_FETCH_TIMEOUT_MS
            );
            const nextRows = matchRowsFromPayload(nextPage.data);
            if (!nextRows || nextRows.length === 0) break;
            accumulatedHistory.push(...nextRows);
            pageInfo = historyPageInfoFromPayload(nextPage.data);
          }
          // If a newer sync asked for history while this request was running,
          // skip the older response and let the single coalesced follow-up win.
          if (cancelled || requestGeneration !== historyRequestGeneration || historyRefreshQueued) return false;
          const historyCount = accumulatedHistory.length === historyRows.length
            ? progressiveHistoryCount
            : applyData({ rows: accumulatedHistory }, 'history');
          const loadedHistoryCount = historyCount + progressiveArchiveCount;
          if (cancelled) return false;
          setDataSync((current) => ({
            ...current,
            historyLoaded: loadedHistoryCount > 0,
            historyLoading: false,
            historyCount: loadedHistoryCount,
            totalCount: current.currentCount + loadedHistoryCount,
            dataChannel: current.dataChannel || historyData.channel,
            lastDataUrl: current.lastDataUrl || historyData.url
          }));
          return true;
        } catch (error: unknown) {
          if (
            cancelled
            || requestGeneration !== historyRequestGeneration
            || historyRefreshQueued
            || isSilentFetchCancellation(error, effectRequestController.signal)
          ) return false;
          if (invalidateActiveAccessSession(error)) return false;
          console.warn('History data is unavailable; current matches remain usable.', error);
          setDataSync((current) => ({
            ...current,
            historyLoading: false,
            error: formatError(error)
          }));
          return false;
        }
      })();

      const trackedRequest = request.finally(() => {
        if (historyRequestInFlight !== trackedRequest) return;
        historyRequestInFlight = null;
        if (historyRefreshQueued && !cancelled) {
          historyRefreshQueued = false;
          void loadHistory();
        }
      });
      historyRequestInFlight = trackedRequest;
      return trackedRequest;
    };

    const loadCurrent = (isInitial = false): Promise<boolean> => {
      if (cancelled) return Promise.resolve(false);
      if (currentRequestInFlight) {
        // SSE, focus and the safety poll can arrive together. Coalesce all of
        // them into one follow-up instead of invalidating an in-flight result.
        const activeRequest = currentRequestInFlight;
        currentRefreshQueued = true;
        return activeRequest.then((activeSucceeded) => {
          const queuedRequest = currentRequestInFlight;
          return queuedRequest && queuedRequest !== activeRequest
            ? queuedRequest
            : activeSucceeded;
        });
      }

      const request = runCurrentRequest(isInitial);
      const trackedRequest = request.finally(() => {
        if (currentRequestInFlight !== trackedRequest) return;
        currentRequestInFlight = null;
        if (currentRefreshQueued && !cancelled) {
          currentRefreshQueued = false;
          void loadCurrent(false);
        }
      });
      currentRequestInFlight = trackedRequest;
      return trackedRequest;
    };

    const dataUrls = (
      endpoint: string,
      staticUrls: string[],
      options: { preferStatic?: boolean } = {}
    ): DataCandidate[] => {
      const staticCandidates = staticUrls.map((url) => ({ url, channel: 'static' as const }));
      if (apiDisabledRef.current || !preferApiRef.current) return staticCandidates;

      const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      const apiBase = apiBaseRef.current || '/api/v1';
      const apiCandidate = { url: `${apiBase}${normalizedEndpoint}`, channel: 'api' as const };
      return options.preferStatic ? [...staticCandidates, apiCandidate] : [apiCandidate, ...staticCandidates];
    };

    const fetchSourceHealth = async (): Promise<DataSyncState['sourceHealth'] | undefined> => {
      try {
        const result = await fetchFirstAvailable<DataSyncState['sourceHealth']>(
          dataUrls('/source-health', []),
          activeAccessToken,
          undefined,
          effectRequestSignal
        );
        return result.data;
      } catch {
        return undefined;
      }
    };

    const fetchModelEvaluation = async (): Promise<DataSyncState['modelEvaluation'] | undefined> => {
      try {
        const result = await fetchFirstAvailable<DataSyncState['modelEvaluation']>(
          dataUrls('/model/evaluation', []),
          activeAccessToken,
          undefined,
          effectRequestSignal
        );
        return result.data;
      } catch {
        return undefined;
      }
    };

    const fetchPublicHealth = async (): Promise<PublicHealth | undefined> => {
      try {
        const result = await fetchFirstAvailable<PublicHealth>(
          dataUrls('/health', []),
          activeAccessToken,
          undefined,
          effectRequestSignal
        );
        return result.data;
      } catch {
        return undefined;
      }
    };

    let eventStreamController: AbortController | undefined;
    let eventReconnectTimer: number | undefined;
    let eventRefreshTimer: number | undefined;
    let serverEventRefreshState = createServerEventRefreshState();
    let serverEventRefreshRunning = false;
    let serverEventRefreshFailureCount = 0;

    const scheduleServerEventRefresh = (delayMs = 350) => {
      if (cancelled || serverEventRefreshRunning || eventRefreshTimer !== undefined) return;
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = undefined;
        if (cancelled || serverEventRefreshRunning) return;
        const consumed = consumeServerEventRefresh(serverEventRefreshState);
        serverEventRefreshState = consumed.state;
        if (!consumed.refresh) return;

        const refresh = consumed.refresh;
        serverEventRefreshRunning = true;
        setDataSync((current) => ({
          ...current,
          liveUpdates: 'sse',
          lastServerEventAt: new Date().toISOString(),
          lastServerEventType: refresh.type
        }));

        void (async () => {
          let applied: boolean;
          try {
            const [currentSucceeded, historySucceeded] = await Promise.all([
              loadCurrent(false),
              refresh.refreshHistory
                ? loadHistory({ queueIfBusy: true })
                : Promise.resolve(true)
            ]);
            applied = currentSucceeded && historySucceeded;
          } catch {
            applied = false;
          }
          if (!cancelled) {
            serverEventRefreshState = settleServerEventRefresh(
              serverEventRefreshState,
              refresh,
              applied
            );
            serverEventRefreshFailureCount = applied
              ? 0
              : serverEventRefreshFailureCount + 1;
          }
          serverEventRefreshRunning = false;
          if (!cancelled && serverEventRefreshState.pendingType) {
            const retryDelayMs = applied
              ? 350
              : Math.min(
                30_000,
                TRANSIENT_CURRENT_REFRESH_MS * (2 ** Math.min(serverEventRefreshFailureCount - 1, 3))
              );
            scheduleServerEventRefresh(retryDelayMs);
          }
        })();
      }, delayMs);
    };

    const refreshFromServerEvent = (type: RefreshableServerEventType, payload: ServerEventPayload) => {
      const queued = queueServerEventRefresh(serverEventRefreshState, type, payload);
      serverEventRefreshState = queued.state;
      if (!queued.shouldSchedule) return;
      scheduleServerEventRefresh();
    };

    const openEventStream = () => {
      if (apiDisabledRef.current || cancelled || eventStreamController) return;
      const apiBase = apiBaseRef.current || '/api/v1';
      const configuredPath = eventStreamPathRef.current;
      const streamUrl = configuredPath
        ? (configuredPath.startsWith('http') ? configuredPath : configuredPath)
        : `${apiBase}/events`;
      const controller = new AbortController();
      eventStreamController = controller;
      void (async () => {
        try {
          const response = await fetch(streamUrl, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: activeAccessToken ? { authorization: `Bearer ${activeAccessToken}` } : undefined,
            signal: controller.signal
          });
          if (!response.ok || !response.body) {
            throw new Error(`event stream HTTP ${response.status}`);
          }
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.toLowerCase().includes('text/event-stream')) {
            throw new Error(`event stream content type ${contentType || 'missing'}`);
          }
          if (!cancelled) setDataSync((current) => ({ ...current, liveUpdates: 'sse' }));
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!cancelled) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const blockLines = block.split(/\r?\n/);
              const eventType = blockLines
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim() || 'message';
              if ([
                'sync_completed',
                'sync_completed_with_warnings',
                'sync_failed',
                'gpt_prediction_completed',
                'gpt_prediction_completed_with_warnings'
              ].includes(eventType)) {
                const dataText = blockLines
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                let payload: ServerEventPayload = {};
                try {
                  const parsed = dataText ? JSON.parse(dataText) : null;
                  if (parsed && typeof parsed === 'object') payload = parsed as ServerEventPayload;
                } catch {
                  // A malformed observability payload must not stop polling.
                }
                refreshFromServerEvent(eventType as RefreshableServerEventType, payload);
              }
            }
          }
          if (!cancelled && !controller.signal.aborted) {
            setDataSync((current) => ({ ...current, liveUpdates: 'poll' }));
          }
        } catch (error) {
          if (invalidateActiveAccessSession(error)) return;
          if (!(error instanceof Error && error.name === 'AbortError') && !cancelled) {
            setDataSync((current) => ({ ...current, liveUpdates: 'poll' }));
          }
        } finally {
          if (eventStreamController === controller) eventStreamController = undefined;
          if (!cancelled) {
            eventReconnectTimer = window.setTimeout(openEventStream, 5000);
          }
        }
      })();
    };

    let currentTimer: number | undefined;
    const scheduleCurrentRefresh = () => {
      currentTimer = window.setTimeout(() => {
        void loadCurrent(false).finally(() => {
          if (!cancelled) scheduleCurrentRefresh();
        });
      }, refreshMsRef.current);
    };

    const retainedBootstrap = readRetainedCurrentSnapshot(activeAccessSession);
    if (retainedBootstrap) {
      const retainedCount = applyData(retainedBootstrap.data, 'current');
      setDataSync({
        currentLoading: false,
        currentLoaded: true,
        historyLoaded: false,
        historyLoading: false,
        currentCount: retainedCount,
        historyCount: 0,
        totalCount: retainedCount,
        updatedAt: retainedBootstrap.savedAt,
        sourceUpdatedAt: retainedBootstrap.savedAt,
        retainedDataAt: retainedBootstrap.savedAt,
        serviceTransitioning: false,
        currentRefreshHealthy: false,
        lastCheckedAt: retainedBootstrap.savedAt,
        refreshIntervalSeconds: refreshMsRef.current / 1000,
        backendRefreshMinutes: 5,
        dataChannel: 'retained',
        apiFailureCount: apiFailureCountRef.current
      });
    }

    // Same-origin /api/v1 is the production fast path. Do not serialize first
    // paint behind optional runtime config; config still finishes before SSE.
    void loadRuntimeConfig().finally(() => {
      if (!cancelled) openEventStream();
    });
    // Current fixtures own the first authenticated request and first paint.
    // Start history in the next task only after current settles (successfully
    // or fail-closed), so an older server that still serializes list builds
    // cannot let a cold 200-row history page occupy the current queue first.
    void loadCurrent(true).finally(() => {
      if (cancelled) return;
      scheduleCurrentRefresh();
      window.setTimeout(() => {
        if (!cancelled) void loadHistory();
      }, 0);
    });

    let wakeRefreshTimer: number | undefined;
    const refreshOnWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (wakeRefreshTimer) window.clearTimeout(wakeRefreshTimer);
      wakeRefreshTimer = window.setTimeout(() => {
        wakeRefreshTimer = undefined;
        if (!cancelled && document.visibilityState === 'visible') {
          void loadCurrent(false);
          void loadHistory({ queueIfBusy: true });
        }
      }, 120);
    };
    window.addEventListener('focus', refreshOnWake);
    document.addEventListener('visibilitychange', refreshOnWake);

    const historyTimer = window.setInterval(() => {
      void loadHistory();
    }, HISTORY_REFRESH_MS);

    return () => {
      cancelled = true;
      effectRequestController.abort();
      if (currentTimer) window.clearTimeout(currentTimer);
      if (eventRefreshTimer !== undefined) window.clearTimeout(eventRefreshTimer);
      if (eventReconnectTimer) window.clearTimeout(eventReconnectTimer);
      if (wakeRefreshTimer) window.clearTimeout(wakeRefreshTimer);
      eventStreamController?.abort();
      window.removeEventListener('focus', refreshOnWake);
      document.removeEventListener('visibilitychange', refreshOnWake);
      window.clearInterval(historyTimer);
    };
  }, [isAccessVerified, accessSession]);

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
