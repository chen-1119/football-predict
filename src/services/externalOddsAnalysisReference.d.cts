export const EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION: 'external-odds-analysis-reference-v5';
export const EXTERNAL_ODDS_MIN_LEADER_GAP: 0.08;
export const EXTERNAL_ODDS_MIN_LEADER_PROBABILITY: 0.40;
export const OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS: number;

export type ExternalOddsDirectionCode = '1' | 'X' | '2';

export interface ExternalOddsTripletInput {
  odds1?: unknown;
  oddsX?: unknown;
  odds2?: unknown;
  source?: unknown;
  updatedAt?: unknown;
  handicapLine?: unknown;
}

export interface ExternalOddsAnalysisMatchInput {
  status?: unknown;
  resultDisposition?: unknown;
  kickoffTime?: unknown;
  buyEndTime?: unknown;
  odds?: ExternalOddsTripletInput | null;
  oddsSource?: unknown;
  oddsUpdatedAt?: unknown;
  handicapOdds?: ExternalOddsTripletInput | null;
  handicapOddsSource?: unknown;
  handicapOddsUpdatedAt?: unknown;
  handicapLine?: unknown;
  predictionMeta?: { cutoffTime?: unknown } | null;
  externalSignals?: {
    source?: unknown;
    updatedAt?: unknown;
    externalOdds?: ExternalOddsTripletInput | null;
    bookmakerOdds?: {
      had?: ExternalOddsTripletInput | null;
      hhad?: ExternalOddsTripletInput | null;
    } | null;
    fiveHundred?: {
      source?: unknown;
      updatedAt?: unknown;
      europeOdds?: {
        currentAverage?: ExternalOddsTripletInput | null;
      } | null;
    } | null;
  } | null;
}

export interface ExternalOddsProbabilitySet {
  home: number;
  draw: number;
  away: number;
}

export interface ExternalOddsDirection {
  code: ExternalOddsDirectionCode;
  label: { zh: string; en: string };
}

export interface ExternalOddsHandicapRisk {
  code: 'avoid-handicap';
  severity: 'high';
  label: { zh: '不碰让球'; en: 'Avoid handicap' };
  reason: { zh: string; en: string };
  handicapLine: string | number;
  hhadDirection: ExternalOddsDirection;
  deviggedProbabilities: ExternalOddsProbabilitySet;
}

export interface ExternalOddsAnalysisReference {
  version: typeof EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION;
  kind: 'external-odds-analysis-reference';
  referenceAction: 'reference';
  publicationTrack: 'analysis-only';
  statisticsTrack: 'analysis-only';
  market: 'HAD';
  tipCode: ExternalOddsDirectionCode;
  hadDirection: ExternalOddsDirection;
  source: {
    provider: '500.com';
    official: false;
    rawSource: string;
    label: { zh: '500网非官方赔率'; en: '500.com non-official odds' };
  };
  sourceUpdatedAt?: string;
  sourceOdds: { odds1: number; oddsX: number; odds2: number };
  selectedSourceOdds: number;
  deviggedProbabilities: ExternalOddsProbabilitySet;
  leaderProbability: number;
  runnerUpProbability: number;
  leaderGap: number;
  minimumLeaderGap: typeof EXTERNAL_ODDS_MIN_LEADER_GAP;
  minimumLeaderProbability: typeof EXTERNAL_ODDS_MIN_LEADER_PROBABILITY;
  handicapRisk: ExternalOddsHandicapRisk | null;
  notice: { zh: string; en: string };
  executable: false;
  formalEligible: false;
  liveEligible: false;
  betSlipEligible: false;
}

export function buildExternalOddsAnalysisReference(
  match: ExternalOddsAnalysisMatchInput | null | undefined,
  now?: number,
): ExternalOddsAnalysisReference | null;
