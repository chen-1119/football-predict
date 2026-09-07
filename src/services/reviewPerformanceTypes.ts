export interface ReviewPerformanceBucket {
  won?: number;
  lost?: number;
  settled?: number;
  hitRate?: number | null;
}

export interface ReviewPerformanceSummary {
  pairedBaseline?: ReferencePairedBaseline | null;
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

export interface ReferencePairCounts {
  settledReferenceEvents: number;
  paired: number;
  excluded: number;
  publishedWon: number;
  baselineWon: number;
  tiedBaselineOdds: number;
  bothWon: number;
  publicOnly: number;
  baselineOnly: number;
  bothLost: number;
}
export interface ReferencePairedBaseline {
  version: string;
  policyVersion: string;
  scope: string;
  generatedAt: string | null;
  recommendationCoverage: null;
  promotionEligible: false;
  parameterRevisionVerified: false;
  sourceBoundary: string;
  resultBoundary: string;
  tieOrder: string[];
  cells: Array<ReferencePairCounts & { date: string; market: string; versionKey: string }>;
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
