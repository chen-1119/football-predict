export interface BenchmarkSelectionPolicy {
  version: string;
  activatedAt: string;
  marketType: 'BEST';
  oddsPoolCode: 'HAD';
  minimumEvidenceScore: number;
  minimumOdds: number;
  maximumOdds: number;
  targetHitRate: number;
  hitRateDisclosureOnly: true;
  decisionOffsetMinutes: number;
  maximumSnapshotStalenessMinutes: number;
  maximumIngestLagMinutes: number;
  reviewCheckpoints: readonly number[];
  minimumSettledRowsForPromotionReview: number;
  minimumChronologicalFolds: number;
  minimumRowsPerWindow: number;
  maximumSingleWindowShare: number;
  minimumCalendarDays: number;
  maximumAbsoluteSpiegelhalterZ: number;
  minimumBrierSkillScore90LowerBound: number;
  minimumPositiveClvRate: number;
  minimumClosingLineCoverage: number;
  minimumLeagueCount: number;
  maximumSingleLeagueShare: number;
  minimumRoiEvidenceRows: number;
  role: 'shadow-only';
  formalOnlineEffect: false;
}

export interface BenchmarkSelectionEvaluation {
  version: string;
  activatedAt: string;
  qualified: boolean;
  role: 'shadow-only';
  formalOnlineEffect: false;
  blockers: string[];
  evidenceScore: number | null;
  odds: number | null;
  criteria: {
    marketType: 'BEST';
    oddsPoolCode: 'HAD';
    minimumEvidenceScore: number;
    minimumOdds: number;
    maximumOdds: number;
  };
}

export const GOODWIN_BENCHMARK_SHADOW_POLICY: Readonly<BenchmarkSelectionPolicy>;
export function evaluateBenchmarkSelection(
  prediction: unknown,
  options?: { policy?: BenchmarkSelectionPolicy },
): BenchmarkSelectionEvaluation;
