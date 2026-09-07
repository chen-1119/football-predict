export interface ReviewPerformanceBucket {
  won?: number;
  lost?: number;
  settled?: number;
  hitRate?: number | null;
}

export interface ReviewPerformanceSummary {
  version?: string;
  generatedAt?: string | null;
  startDate?: string;
  timezone?: string;
  cumulative?: ReviewPerformanceBucket | null;
  daily?: Array<ReviewPerformanceBucket & { date?: string }>;
  marketBreakdown?: {
    version?: string;
    HAD?: ReviewMarketGroup;
    HHAD?: ReviewMarketGroup;
    UNKNOWN?: ReviewMarketGroup;
  } | null;
  exclusions?: Record<string, number>;
  versionBreakdown?: {
    version?: string;
    scope?: string;
    groups?: ReviewVersionGroup[];
    unknown?: ReviewVersionGroup;
  } | null;
  policy?: {
    denominator?: string;
    includedStatuses?: string[];
    excludedTracks?: string[];
    immutableRecommendationRequired?: boolean;
    sourceScope?: string;
    unit?: string;
    identityVersion?: string;
    conflictingEvents?: string;
  } | null;
}

export interface ReviewMarketGroup {
  cumulative?: ReviewPerformanceBucket | null;
  daily?: Array<ReviewPerformanceBucket & { date?: string }>;
}

export interface ReviewVersionGroup extends ReviewMarketGroup {
  key?: string;
  modelVersion?: string;
  policyVersion?: string;
  marketBreakdown?: ReviewPerformanceSummary['marketBreakdown'];
}
