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
  exclusions?: Record<string, number>;
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
