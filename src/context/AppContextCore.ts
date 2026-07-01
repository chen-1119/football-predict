import { createContext, useContext } from 'react';
import type { Match } from '../services/mockData';
import type { AccessSession } from '../services/accessControl';

export type Language = 'zh' | 'en';
export type HitAndWinPick = '1' | 'X' | '2';
export type HitAndWinSubmission = Record<string, HitAndWinPick>;

export interface User {
  username: string;
}

export interface DataSyncState {
  currentLoading?: boolean;
  currentLoaded: boolean;
  historyLoaded: boolean;
  historyLoading: boolean;
  currentCount: number;
  historyCount: number;
  totalCount: number;
  error?: string;
  updatedAt?: string;
  lastCheckedAt?: string;
  lastAttemptAt?: string;
  sourceUpdatedAt?: string;
  refreshIntervalSeconds?: number;
  backendRefreshMinutes?: number;
  byStatus?: Partial<Record<Match['status'], number>>;
  sourceAgeSeconds?: number | null;
  sourceStale?: boolean;
  syncTriggered?: boolean;
  dataApiSource?: string;
  dataChannel?: 'api' | 'static' | 'mock';
  liveUpdates?: 'sse' | 'poll';
  lastServerEventAt?: string;
  lastServerEventType?: string;
  dataApiBase?: string;
  lastDataUrl?: string;
  apiFailureCount?: number;
  sourceAttempt?: {
    officialOddsMatches?: number;
    officialHandicapOddsMatches?: number;
    officialResultMatches?: number;
    publishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    combinedPublishableMatches?: number;
  };
  sourceFallback?: {
    keptExisting?: boolean;
    mergedPartialFresh?: boolean;
    reason?: string;
    existingMatches?: number;
    freshPublishableMatches?: number;
    sportteryPublishableMatches?: number;
    fiveHundredFallbackMatches?: number;
    fiveHundredResultMatches?: number;
  };
  modelEvaluation?: {
    ok?: boolean;
    apiVersion?: string;
    generatedAt?: string | null;
    backtest?: {
      version?: string | null;
      generatedAt?: string | null;
      sample?: {
        probabilityRows?: number;
        marketBaselineRows?: number;
        predictionSnapshots?: number;
      } | null;
      shadowCandidates?: {
        version?: string;
        bestCandidateId?: string;
        sample?: {
          rows?: number;
        };
      } | null;
      policy?: {
        promotionGate?: string;
        llmRole?: string;
      } | null;
    } | null;
    calibration?: {
      version?: string | null;
    } | null;
    strategy?: {
      version?: string | null;
      generatedAt?: string | null;
      activation?: {
        mode?: string;
        onlineEffect?: string;
        promotionGate?: {
          status?: string;
          reasons?: string[];
          sample?: {
            marketBaselineRows?: number;
            probabilityRows?: number;
            shadowCandidateRows?: number;
          };
          thresholds?: {
            minMarketBaselineRows?: number;
          };
        };
      };
    } | null;
    policy?: {
      baselineRequired?: string;
      splitPolicy?: string;
      llmRole?: string;
    };
  };
  sourceHealth?: {
    ok?: boolean;
    checkedAt?: string;
    mode?: {
      enable500Sync?: boolean;
      enable500DetailsSync?: boolean;
      enableWeatherSync?: boolean;
      enableApiFootballSync?: boolean;
      enablePreMatchSignalsSync?: boolean;
      requireExternalSignals?: boolean;
      skipSportteryFetch?: boolean;
    };
    sources?: Array<{
      id?: string;
      label?: string;
      role?: string;
      enabled?: boolean;
      required?: boolean;
      status?: string;
      score?: number;
      updatedAt?: string | null;
      ageMinutes?: number | null;
      maxAgeMinutes?: number | null;
      stale?: boolean;
      metrics?: Record<string, unknown>;
    }>;
    sourceScores?: Record<string, {
      status?: string;
      score?: number;
      stale?: boolean;
      updatedAt?: string | null;
      ageMinutes?: number | null;
    }>;
    externalSignals?: {
      fiveHundredRows?: number;
      fiveHundredMapped?: number;
      fiveHundredDetailsCachedMerged?: number;
      fiveHundredDetailsErrors?: number;
      apiFootballConfigured?: boolean;
      apiFootballEnabled?: boolean;
      apiFootballMappedSignals?: number;
      apiFootballCallsThisSync?: number;
      apiFootballCallsTodayEstimate?: number;
    };
    preMatchSignals?: {
      exists?: boolean;
      updatedAt?: string | null;
      ageMinutes?: number | null;
      matchKeys?: number;
      high?: number;
      medium?: number;
      low?: number;
      warningCount?: number;
    };
    currentMatches?: {
      count?: number;
      withExternalSignals?: number;
      externalCoverage?: number;
      withSportteryOdds?: number;
      withFiveHundredDetails?: number;
      withWeather?: number;
      withPreMatchSignals?: number;
    };
    errors?: string[];
  };
}

export interface AppContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  accessSession: AccessSession | null;
  isAccessVerified: boolean;
  hitAndWinSubmission: HitAndWinSubmission | null;
  submitHitAndWin: (selections: HitAndWinSubmission) => boolean;
  verifyAccessCode: (code: string) => Promise<AccessSession>;
  clearAccessSession: () => void;
  login: (username: string) => void;
  register: (username: string) => void;
  logout: () => void;
  matches: Match[];
  dataSync: DataSyncState;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
