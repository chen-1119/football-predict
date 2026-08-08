import {
  getOfficialMatchOdds,
  isPredictionOfficialResultPoolAvailable,
} from './bettingDisplay';
import type { Match, PredictionDetail } from './mockData';
import { isBeforeMatchSaleCutoff } from './matchLifecycle';
import { getVisiblePrediction } from './predictionVisibility';
import {
  isCalibratedMarketAnalysisReferenceEligible,
  isDirectionalAnalysisReferenceEligible,
  isModelOnlyAnalysisReferenceEligible,
} from './analysisReferenceEligibility';
import { buildFiveHundredMarketReferencePresentation } from './externalOddsReferencePresentation';

export type AnalysisReferenceSource =
  | 'official-calibrated-market'
  | 'official-market-consensus'
  | 'five-hundred-market'
  | 'strong-model'
  | 'official-low-evidence-market'
  | 'five-hundred-low-evidence-market'
  | 'model-only'
  | 'model-low-evidence'
  | 'atomic-dual-market-reference';

export interface AnalysisReferenceSelection {
  prediction: PredictionDetail;
  source: AnalysisReferenceSource;
  displayOdds: number | null;
  sourceUpdatedAt: string | null;
  rankScore: number;
}

export interface AnalysisReferenceSelectionOptions {
  allowModelOnly?: boolean;
  candidate?: PredictionDetail;
  now?: number;
}

const isDirection = (value: string | undefined) => value === '1' || value === 'X' || value === '2';
type OutcomeCode = '1' | 'X' | '2';
type NormalizedOutcomeProbabilities = Record<OutcomeCode, number>;

const normalizedModelOutcomeProbabilities = (match: Match): NormalizedOutcomeProbabilities | null => {
  const final = match.probabilityModel?.oneXTwo?.final;
  if (!final) return null;
  const raw: NormalizedOutcomeProbabilities = {
    '1': Number(final.home),
    X: Number(final.draw),
    '2': Number(final.away),
  };
  if (Object.values(raw).some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  return {
    '1': raw['1'] / total,
    X: raw.X / total,
    '2': raw['2'] / total,
  };
};

const modelOutcomeLeader = (
  probabilities: NormalizedOutcomeProbabilities | null,
  preferredCode?: OutcomeCode,
) => {
  if (!probabilities) return null;
  const neutralPriority: Record<OutcomeCode, number> = { X: 0, '1': 1, '2': 2 };
  return (Object.entries(probabilities) as Array<[OutcomeCode, number]>)
    .sort(([leftCode, left], [rightCode, right]) => {
      const probabilityDelta = right - left;
      if (Math.abs(probabilityDelta) >= MARKET_LEADER_TIE_EPSILON) return probabilityDelta;
      if (preferredCode) {
        if (leftCode === preferredCode && rightCode !== preferredCode) return -1;
        if (rightCode === preferredCode && leftCode !== preferredCode) return 1;
      }
      return neutralPriority[leftCode] - neutralPriority[rightCode];
    })[0] || null;
};

const OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY = 0.55;
const OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP = 0.08;
const MARKET_REFERENCE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MARKET_REFERENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MARKET_LEADER_TIE_EPSILON = 0.005;
export const FIVE_HUNDRED_LOW_EVIDENCE_TIER = 'five-hundred-had-low-evidence-market-leader';
export const OFFICIAL_LOW_EVIDENCE_TIER = 'official-had-low-evidence-market-leader';
export const MODEL_LOW_EVIDENCE_TIER = 'model-low-evidence-data-pick';
export const ATOMIC_DUAL_MARKET_REFERENCE_TIER = 'atomic-dual-market-bound-reference';

type HadOddsTriplet = { odds1: number; oddsX: number; odds2: number };
type LowEvidenceMarketProvider = 'official' | 'five-hundred';

interface HadMarketCandidate {
  provider: LowEvidenceMarketProvider;
  odds: HadOddsTriplet;
  sourceUpdatedAt: string | null;
}

const normalizeHadOdds = (value: Partial<HadOddsTriplet> | null | undefined): HadOddsTriplet | null => {
  if (!value) return null;
  const odds = {
    odds1: Number(value.odds1),
    oddsX: Number(value.oddsX),
    odds2: Number(value.odds2),
  };
  return Object.values(odds).every((item) => Number.isFinite(item) && item > 1)
    ? odds
    : null;
};

const rankDeViggedHad = (
  odds: HadOddsTriplet,
  preferredCode?: '1' | 'X' | '2',
) => {
  const entries = [
    { code: '1' as const, odds: odds.odds1 },
    { code: 'X' as const, odds: odds.oddsX },
    { code: '2' as const, odds: odds.odds2 },
  ];
  const inverseTotal = entries.reduce((sum, entry) => sum + 1 / entry.odds, 0);
  return entries
    .map((entry) => ({ ...entry, probability: (1 / entry.odds) / inverseTotal }))
    .sort((left, right) => {
      const probabilityDelta = right.probability - left.probability;
      if (Math.abs(probabilityDelta) >= MARKET_LEADER_TIE_EPSILON) return probabilityDelta;
      if (preferredCode) {
        if (left.code === preferredCode && right.code !== preferredCode) return -1;
        if (right.code === preferredCode && left.code !== preferredCode) return 1;
      }
      // Never let the source array order silently turn an unresolved market
      // tie into a systematic home-win bias.
      const neutralPriority = { X: 0, '1': 1, '2': 2 } as const;
      return neutralPriority[left.code] - neutralPriority[right.code];
    });
};

const isFiveHundredHadSource = (value: unknown) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '500.com:jczq'
    || normalized === '500.com:had'
    || normalized.startsWith('500.com:had:');
};

const parseSourceTime = (value: string | null) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

type MarketClockState = 'fresh' | 'missing' | 'future' | 'stale' | 'after-cutoff';

const marketClockState = (
  match: Match,
  sourceUpdatedAt: string | null,
  now: number,
): MarketClockState => {
  const observedAt = Date.parse(sourceUpdatedAt || '');
  if (!Number.isFinite(observedAt)) return 'missing';
  if (observedAt > now + MARKET_REFERENCE_FUTURE_SKEW_MS) return 'future';
  const cutoffAt = Math.min(
    ...[match.predictionMeta?.cutoffTime, match.buyEndTime, match.kickoffTime]
      .map((value) => Date.parse(String(value || '')))
      .filter(Number.isFinite),
  );
  if (Number.isFinite(cutoffAt) && observedAt >= cutoffAt) return 'after-cutoff';
  if (now - observedAt > MARKET_REFERENCE_MAX_AGE_MS) return 'stale';
  return 'fresh';
};

const getFiveHundredHadCandidate = (match: Match): HadMarketCandidate | undefined => {
  const signals = match.externalSignals;
  const inheritedSource = signals?.source;
  const inheritedUpdatedAt = signals?.updatedAt;
  const externalOdds = signals?.externalOdds as
    | (Partial<HadOddsTriplet> & { source?: string; updatedAt?: string })
    | undefined;
  const matchOdds = match.odds as
    | (Partial<HadOddsTriplet> & { updatedAt?: string })
    | undefined;
  const candidates = [
    {
      odds: normalizeHadOdds(matchOdds),
      source: match.oddsSource,
      sourceUpdatedAt: match.oddsUpdatedAt || matchOdds?.updatedAt || null,
    },
    {
      odds: normalizeHadOdds(signals?.bookmakerOdds?.had),
      source: signals?.bookmakerOdds?.had?.source || inheritedSource,
      sourceUpdatedAt: signals?.bookmakerOdds?.had?.updatedAt || inheritedUpdatedAt || null,
    },
    {
      odds: normalizeHadOdds(externalOdds),
      source: externalOdds?.source || inheritedSource,
      sourceUpdatedAt: externalOdds?.updatedAt || inheritedUpdatedAt || null,
    },
  ]
    .filter((candidate) => candidate.odds && isFiveHundredHadSource(candidate.source))
    .sort((left, right) => (
      parseSourceTime(right.sourceUpdatedAt) - parseSourceTime(left.sourceUpdatedAt)
    ));
  const selected = candidates[0];
  return selected?.odds
    ? {
        provider: 'five-hundred',
        odds: selected.odds,
        sourceUpdatedAt: selected.sourceUpdatedAt,
      }
    : undefined;
};

const referenceDirectionLabel = (code: '1' | 'X' | '2') => {
  if (code === '1') return { zh: '\u4e3b\u80dc', en: 'Home win' };
  if (code === 'X') return { zh: '\u5e73\u5c40', en: 'Draw' };
  return { zh: '\u5ba2\u80dc', en: 'Away win' };
};

const handicapDirectionLabel = (code: '1' | 'X' | '2') => {
  if (code === '1') return { zh: '\u8ba9\u80dc', en: 'Handicap home' };
  if (code === 'X') return { zh: '\u8ba9\u5e73', en: 'Handicap draw' };
  return { zh: '\u8ba9\u8d1f', en: 'Handicap away' };
};

const canonicalReferencePool = (match: Match, prediction: PredictionDetail | undefined): 'HAD' | 'HHAD' => {
  if (prediction?.oddsPoolCode === 'HAD' || prediction?.oddsPoolCode === 'HHAD') {
    return prediction.oddsPoolCode;
  }
  return match.probabilityModel?.unifiedPosterior?.selectedMarket === 'HHAD' ? 'HHAD' : 'HAD';
};

const canonicalReferencePrediction = (
  match: Match,
  prediction: PredictionDetail,
): PredictionDetail => {
  const poolCode = canonicalReferencePool(match, prediction);
  const tipCode = prediction.tipCode as OutcomeCode;
  return {
    ...prediction,
    oddsPoolCode: poolCode,
    handicapLine: poolCode === 'HHAD'
      ? prediction.handicapLine ?? match.handicapLine
      : '0',
    tipLabel: poolCode === 'HHAD'
      ? handicapDirectionLabel(tipCode)
      : referenceDirectionLabel(tipCode),
  };
};

const hasFreshCompleteOfficialHad = (match: Match, now: number) => {
  const official = getOfficialMatchOdds(match).had;
  if (!official || !normalizeHadOdds(official.odds)) return false;
  const sourceUpdatedAt = official.updatedAt || match.oddsUpdatedAt || null;
  return marketClockState(match, sourceUpdatedAt, now) === 'fresh';
};

const buildOfficialMarketConsensusReference = (
  match: Match,
  candidate: PredictionDetail | undefined,
  now: number,
): AnalysisReferenceSelection | undefined => {
  const official = getOfficialMatchOdds(match).had;
  if (!official) return undefined;
  const sourceUpdatedAt = official.updatedAt || match.oddsUpdatedAt || null;
  if (marketClockState(match, sourceUpdatedAt, now) !== 'fresh') return undefined;

  const entries = [
    { code: '1' as const, odds: Number(official.odds.odds1) },
    { code: 'X' as const, odds: Number(official.odds.oddsX) },
    { code: '2' as const, odds: Number(official.odds.odds2) },
  ];
  if (!entries.every((entry) => Number.isFinite(entry.odds) && entry.odds > 1)) return undefined;
  const inverseTotal = entries.reduce((sum, entry) => sum + 1 / entry.odds, 0);
  const ranked = entries
    .map((entry) => ({ ...entry, probability: (1 / entry.odds) / inverseTotal }))
    .sort((left, right) => right.probability - left.probability);
  const leader = ranked[0];
  const runnerUp = ranked[1];
  if (
    !leader
    || !runnerUp
    || leader.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY
    || leader.probability - runnerUp.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP
  ) return undefined;

  // Only a complete directional-reference candidate may veto a clear market
  // leader. A high headline score alone is not enough: if the opposite model
  // misses any directional gate, the official market reference stays visible.
  // When this does veto, the caller immediately falls through to the same
  // directional candidate, so the match never becomes an empty card.
  const strongOppositeModel = Boolean(
    candidate
    && candidate.tipCode !== leader.code
    && isDirectionalAnalysisReferenceEligible(match, candidate, now),
  );
  if (strongOppositeModel) return undefined;

  const label = referenceDirectionLabel(leader.code);
  const leaderPercent = (leader.probability * 100).toFixed(1);
  const gapPercent = ((leader.probability - runnerUp.probability) * 100).toFixed(1);
  const prediction: PredictionDetail = {
    marketType: 'BEST',
    oddsPoolCode: 'HAD',
    tipCode: leader.code,
    tipLabel: label,
    odds: leader.odds,
    trustScore: Math.round(leader.probability * 100),
    recommendationAction: 'reference',
    recommendationTier: 'official-had-market-consensus-reference',
    explanation: {
      zh: `\u5b98\u65b9 HAD \u53bb\u6c34\u540e\u9996\u4f4d\u65b9\u5411\u4e3a${label.zh}\uff0c\u9690\u542b\u6982\u7387 ${leaderPercent}%\uff0c\u9886\u5148\u7b2c\u4e8c\u65b9\u5411 ${gapPercent} \u4e2a\u767e\u5206\u70b9\u3002\u8fd9\u662f\u76d8\u53e3\u53c2\u8003\u63a8\u8350\uff0c\u4e0d\u8ba1\u5165\u6b63\u5f0f\u547d\u4e2d\u7387\u6216\u4e32\u5173\u3002`,
      en: `The official de-vigged HAD market leads with ${label.en} at ${leaderPercent}%, ${gapPercent} points ahead of the runner-up. This is a market reference pick and is excluded from formal hit-rate and bet-slip statistics.`,
    },
    analysisItems: [{
      zh: `\u5c55\u793a\u95e8\u69db\uff1a\u53bb\u6c34\u540e\u9996\u4f4d\u6982\u7387\u81f3\u5c11 55%\uff0c\u4e14\u9886\u5148\u7b2c\u4e8c\u65b9\u5411\u81f3\u5c11 8 \u4e2a\u767e\u5206\u70b9\u3002`,
      en: 'Display gate: de-vigged leader probability at least 55% and an 8-point lead over the runner-up.',
    }],
    riskTags: [{
      zh: '\u5b98\u65b9\u5e02\u573a\u53c2\u8003\uff0c\u4e0d\u8ba1\u6b63\u5f0f\u6218\u7ee9',
      en: 'Official market reference; excluded from formal record',
    }],
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING',
  };

  return {
    prediction,
    source: 'official-market-consensus',
    displayOdds: leader.odds,
    sourceUpdatedAt,
    rankScore: referenceRankScore(prediction, 'official-market-consensus'),
  };
};

const buildLowEvidenceMarketLeaderReference = (
  match: Match,
  now: number,
  allowFiveHundred: boolean,
  preferredCode?: '1' | 'X' | '2',
  candidateOverride?: HadMarketCandidate,
): AnalysisReferenceSelection | undefined => {
  const official = getOfficialMatchOdds(match).had;
  const officialOdds = normalizeHadOdds(official?.odds);
  const candidate: HadMarketCandidate | undefined = candidateOverride || (officialOdds
    ? {
        provider: 'official',
        odds: officialOdds,
        sourceUpdatedAt: official?.updatedAt || match.predictionMeta?.generatedAt || null,
      }
    : allowFiveHundred
      ? getFiveHundredHadCandidate(match)
      : undefined);
  if (!candidate) return undefined;

  const ranked = rankDeViggedHad(candidate.odds, preferredCode);
  const leader = ranked[0];
  const runnerUp = ranked[1];
  if (!leader || !runnerUp) return undefined;

  const leaderGap = leader.probability - runnerUp.probability;
  const leaderPercent = (leader.probability * 100).toFixed(1);
  const gapPercent = (leaderGap * 100).toFixed(1);
  const label = referenceDirectionLabel(leader.code);
  const evidenceRisks: string[] = [];
  const evidenceRisksEn: string[] = [];
  const clockState = marketClockState(match, candidate.sourceUpdatedAt, now);
  const tieBreakApplied = leaderGap < MARKET_LEADER_TIE_EPSILON;
  if (leader.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY) {
    evidenceRisks.push(`\u53bb\u6c34\u9996\u4f4d\u6982\u7387 ${leaderPercent}% \u4f4e\u4e8e 55%`);
    evidenceRisksEn.push(`the ${leaderPercent}% leader probability is below 55%`);
  }
  if (leaderGap < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP) {
    evidenceRisks.push(`\u9886\u5148\u5e45\u5ea6 ${gapPercent} \u4e2a\u767e\u5206\u70b9\u4f4e\u4e8e 8 \u4e2a\u767e\u5206\u70b9`);
    evidenceRisksEn.push(`the ${gapPercent}-point lead is below 8 points`);
  }
  if (clockState === 'missing') {
    evidenceRisks.push(`${candidate.provider === 'five-hundred' ? '500 ' : '\u5b98\u65b9'}\u6765\u6e90\u672a\u63d0\u4f9b\u53ef\u6838\u9a8c\u65f6\u95f4`);
    evidenceRisksEn.push(`${candidate.provider === 'five-hundred' ? 'the 500.com' : 'the official'} source has no verifiable timestamp`);
  } else if (clockState === 'future') {
    evidenceRisks.push('\u6765\u6e90\u65f6\u95f4\u5f02\u5e38');
    evidenceRisksEn.push('the source timestamp is in the future');
  } else if (clockState === 'after-cutoff') {
    evidenceRisks.push('\u6765\u6e90\u65f6\u95f4\u4e0d\u65e9\u4e8e\u622a\u6b62\u65f6\u95f4');
    evidenceRisksEn.push('the source timestamp is not earlier than the sale cutoff');
  } else if (clockState === 'stale') {
    evidenceRisks.push('\u6765\u6e90\u5df2\u8d85\u8fc7 12 \u5c0f\u65f6');
    evidenceRisksEn.push('the source is older than 12 hours');
  }
  if (tieBreakApplied) {
    evidenceRisks.push(`\u9996\u4e24\u4f4d\u5dee\u503c\u4f4e\u4e8e ${(MARKET_LEADER_TIE_EPSILON * 100).toFixed(1)} \u4e2a\u767e\u5206\u70b9\uff0c\u4f7f\u7528\u663e\u5f0f\u4e2d\u6027\u5e73\u5c40/\u6a21\u578b\u65b9\u5411\u7834\u540c\u5206`);
    evidenceRisksEn.push(`the top-two gap is below ${(MARKET_LEADER_TIE_EPSILON * 100).toFixed(1)} points, so an explicit neutral/model tie-break was used`);
  }
  if (evidenceRisks.length === 0) {
    evidenceRisks.push('\u672a\u8fdb\u5165\u66f4\u9ad8\u8bc1\u636e\u7684\u6a21\u578b\u6216\u5e02\u573a\u63a8\u8350\u8def\u5f84');
    evidenceRisksEn.push('the match did not enter a higher-evidence model or market path');
  }

  const isOfficial = candidate.provider === 'official';
  const providerZh = isOfficial ? '\u5b98\u65b9' : '500 \u975e\u5b98\u65b9';
  const providerEn = isOfficial ? 'official' : 'non-official 500.com';
  const source: AnalysisReferenceSource = isOfficial
    ? 'official-low-evidence-market'
    : 'five-hundred-low-evidence-market';
  const recommendationTier = isOfficial
    ? OFFICIAL_LOW_EVIDENCE_TIER
    : FIVE_HUNDRED_LOW_EVIDENCE_TIER;
  const prediction: PredictionDetail = {
    marketType: 'BEST',
    oddsPoolCode: 'HAD',
    tipCode: leader.code,
    tipLabel: label,
    // An official quote may be shown as its labelled SP. A 500.com quote stays
    // outside prediction.odds so it cannot satisfy any official-SP gate.
    odds: isOfficial ? leader.odds : 0,
    trustScore: Math.round(leader.probability * 100),
    recommendationAction: 'reference',
    recommendationTier,
    explanation: {
      zh: `${providerZh} HAD \u5b8c\u6574\u8d54\u7387\u53bb\u6c34\u540e\uff0c\u6982\u7387\u9996\u4f4d\u4e3a${label.zh} ${leaderPercent}%\uff0c\u9886\u5148\u7b2c\u4e8c\u65b9\u5411 ${gapPercent} \u4e2a\u767e\u5206\u70b9\u3002\u8fd9\u662f\u4f4e\u8bc1\u636e\u6570\u636e\u63a8\u8350\uff1a${evidenceRisks.join('\uff1b')}\uff1b\u4e0d\u8ba1\u5165\u6b63\u5f0f\u547d\u4e2d\u7387\u6216\u4e32\u5173\u3002`,
      en: `After de-vigging the complete ${providerEn} HAD market, ${label.en} ranks first at ${leaderPercent}%, ${gapPercent} points ahead of the runner-up. This is a low-evidence data pick because ${evidenceRisksEn.join('; ')}; it is excluded from formal hit-rate and bet-slip statistics.`,
    },
    analysisItems: [
      {
        zh: `HAD \u8d54\u7387\uff1a\u4e3b\u80dc ${candidate.odds.odds1.toFixed(2)} / \u5e73\u5c40 ${candidate.odds.oddsX.toFixed(2)} / \u5ba2\u80dc ${candidate.odds.odds2.toFixed(2)}\u3002\u65b9\u5411\u6309\u53bb\u6c34\u540e\u6982\u7387\u6392\u540d\u9009\u62e9\u3002`,
        en: `HAD odds: home ${candidate.odds.odds1.toFixed(2)} / draw ${candidate.odds.oddsX.toFixed(2)} / away ${candidate.odds.odds2.toFixed(2)}. The direction is selected by de-vigged probability rank.`,
      },
      {
        zh: `\u4f4e\u8bc1\u636e\u98ce\u9669\uff1a${evidenceRisks.join('\uff1b')}\u3002`,
        en: `Low-evidence risk: ${evidenceRisksEn.join('; ')}.`,
      },
    ],
    riskTags: [
      {
        zh: `${providerZh} HAD \u4f4e\u8bc1\u636e\u6982\u7387\u9996\u4f4d`,
        en: `${providerEn} HAD low-evidence probability leader`,
      },
      {
        zh: '\u72ec\u7acb\u590d\u76d8\uff0c\u4e0d\u8ba1\u6b63\u5f0f\u6218\u7ee9',
        en: 'Separate review; excluded from formal record',
      },
    ],
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING',
  };

  return {
    prediction,
    source,
    displayOdds: leader.odds,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    rankScore: referenceRankScore(prediction, source),
  };
};

const retainLockedPreCutoffReference = (
  selection: AnalysisReferenceSelection,
): AnalysisReferenceSelection => ({
  ...selection,
  prediction: {
    ...selection.prediction,
    explanation: {
      zh: `\u552e\u5356\u622a\u6b62\u540e\u4ec5\u4fdd\u7559\u622a\u6b62\u524d\u5df2\u89c2\u6d4b\u7684\u6570\u636e\u65b9\u5411\uff0c\u4e0d\u53ef\u6267\u884c\u3002${selection.prediction.explanation?.zh || ''}`,
      en: `Locked pre-cutoff data pick retained after sales closed; it is not executable. ${selection.prediction.explanation?.en || ''}`,
    },
    analysisItems: [
      {
        zh: '\u8be5\u65b9\u5411\u4ec5\u7531\u622a\u6b62\u524d\u7684\u53ef\u6838\u9a8c\u8d54\u7387\u5feb\u7167\u91cd\u73b0\uff0c\u4e0d\u662f\u622a\u6b62\u540e\u8ffd\u52a0\u9884\u6d4b\u3002',
        en: 'This direction is replayed only from a verifiable pre-cutoff odds snapshot; it is not a post-cutoff prediction.',
      },
      ...(selection.prediction.analysisItems || []),
    ],
    riskTags: [
      {
        zh: '\u5df2\u622a\u6b62\uff0c\u4ec5\u4f9b\u590d\u76d8',
        en: 'Sales closed; review only',
      },
      ...(selection.prediction.riskTags || []),
    ],
  },
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Replays the immutable HAD leg that the server already bound before cutoff.
 * This is the only post-cutoff fallback that does not depend on a fresh market
 * or model clock: its direction, odds, source clock and strategy versions were
 * committed together and the server verified the public binding hash.
 */
const buildAtomicDualMarketHadReference = (
  match: Match,
  candidate: PredictionDetail | undefined,
): AnalysisReferenceSelection | undefined => {
  const binding = match.predictionMeta?.dualMarketDecision;
  const had = binding?.had;
  const clocks = binding?.sourceClocks;
  const versions = binding?.strategyVersions;
  const decisionAt = Date.parse(String(clocks?.decisionAt || ''));
  const cutoffAt = Date.parse(String(clocks?.cutoffTime || ''));
  const kickoffAt = Date.parse(String(match.kickoffTime || ''));
  const hadObservedAt = Date.parse(String(clocks?.hadObservedAt || ''));
  const hadReceivedAt = Date.parse(String(clocks?.hadReceivedAt || ''));
  const odds = Number(had?.odds);
  const modelProbability = Number(had?.modelProbability);
  const marketProbability = Number(had?.marketProbability);

  if (
    binding?.version !== 'dual-market-decision-binding-v1'
    || binding.integrityVerified !== true
    || binding.integrityVersion !== 'dual-market-decision-integrity-v1'
    || binding.publicBindingVersion !== 'dual-market-public-binding-v1'
    || !SHA256_PATTERN.test(String(binding.bindingHash || ''))
    || !SHA256_PATTERN.test(String(binding.publicBindingHash || ''))
    || !String(binding.sourceCycleId || '').trim()
    || !String(binding.decisionSnapshotVersion || '').trim()
    || had?.poolCode !== 'HAD'
    || !isDirection(had.code)
    || !Number.isFinite(odds)
    || odds <= 1
    || !Number.isFinite(modelProbability)
    || modelProbability < 0
    || modelProbability > 1
    || !Number.isFinite(marketProbability)
    || marketProbability < 0
    || marketProbability > 1
    || !Number.isFinite(decisionAt)
    || !Number.isFinite(cutoffAt)
    || !Number.isFinite(kickoffAt)
    || !Number.isFinite(hadObservedAt)
    || !Number.isFinite(hadReceivedAt)
    || hadObservedAt > hadReceivedAt
    || hadReceivedAt > cutoffAt
    || decisionAt > cutoffAt
    || cutoffAt > kickoffAt
    || !String(versions?.predictionPolicy || '').trim()
    || !String(versions?.model || '').trim()
    || !String(versions?.calibration || '').trim()
  ) return undefined;

  const tipCode = had.code as OutcomeCode;
  const tipLabel = referenceDirectionLabel(tipCode);
  const sameStoredDirection = candidate?.oddsPoolCode === 'HAD' && candidate.tipCode === tipCode;
  const prediction: PredictionDetail = {
    ...(sameStoredDirection ? candidate : {}),
    marketType: 'BEST',
    oddsPoolCode: 'HAD',
    handicapLine: '0',
    tipCode,
    tipLabel,
    odds,
    trustScore: Math.round(modelProbability * 100),
    recommendationAction: 'reference',
    recommendationTier: ATOMIC_DUAL_MARKET_REFERENCE_TIER,
    explanation: {
      zh: `售前原子决策已锁定 HAD ${tipLabel.zh}，决策快照 SP ${odds.toFixed(2)}。该方向仅用于截止后展示与复盘，不计入正式推荐。`,
      en: `The pre-cutoff atomic decision locked HAD ${tipLabel.en} at snapshot SP ${odds.toFixed(2)}. It is retained only for post-cutoff display and review, not as a formal pick.`,
    },
    analysisItems: [
      {
        zh: '方向、赔率、来源时钟与策略版本来自同一条验签通过的双市场绑定；截止后不得改向或用新赔率重算。',
        en: 'Direction, odds, source clocks, and strategy versions come from one verified dual-market binding and cannot be recomputed after cutoff.',
      },
      ...(sameStoredDirection ? candidate?.analysisItems || [] : []),
    ],
    riskTags: [
      {
        zh: '原子绑定赛前方向 · 截止后仅展示',
        en: 'Atomically bound pre-match direction · display only after cutoff',
      },
      ...(sameStoredDirection ? candidate?.riskTags || [] : []),
    ],
    visibilityStatus: candidate?.visibilityStatus || 'FREE',
    resultStatus: 'PENDING',
  };

  return {
    prediction,
    source: 'atomic-dual-market-reference',
    displayOdds: odds,
    sourceUpdatedAt: new Date(decisionAt).toISOString(),
    rankScore: referenceRankScore(prediction, 'atomic-dual-market-reference'),
  };
};

const modelReferenceTimestamp = (match: Match): string | null => {
  const candidates = [
    match.probabilityModel?.unifiedPosterior?.generatedAt,
    match.predictionMeta?.generatedAt,
  ];
  const selected = candidates.find((value) => (
    typeof value === 'string'
    && Number.isFinite(Date.parse(value))
  ));
  return typeof selected === 'string' ? selected : null;
};

const buildLowEvidenceModelReference = (
  match: Match,
  candidate: PredictionDetail | undefined,
): AnalysisReferenceSelection | undefined => {
  const posteriorCode = match.probabilityModel?.unifiedPosterior?.selectedCode;
  const modelProbabilities = normalizedModelOutcomeProbabilities(match);
  const probabilityLeader = modelOutcomeLeader(
    modelProbabilities,
    isDirection(posteriorCode) ? posteriorCode as OutcomeCode : undefined,
  );
  const tipCode = isDirection(candidate?.tipCode)
    ? candidate?.tipCode as '1' | 'X' | '2'
    : isDirection(posteriorCode)
      ? posteriorCode as '1' | 'X' | '2'
      : probabilityLeader?.[0];
  if (!tipCode) return undefined;

  const poolCode = canonicalReferencePool(match, candidate);
  const handicapLine = candidate?.handicapLine ?? match.handicapLine;
  // An HHAD direction without the home-team line has no stable meaning. Let
  // the caller fall through to a real HAD/market reference instead of silently
  // presenting the same 1/X/2 code as an unhandicapped result.
  if (poolCode === 'HHAD' && !String(handicapLine ?? '').trim()) return undefined;
  const label = poolCode === 'HHAD'
    ? handicapDirectionLabel(tipCode)
    : referenceDirectionLabel(tipCode);
  const rawPosteriorProbability = Number(match.probabilityModel?.unifiedPosterior?.selectedProbability);
  const posteriorProbability = Number.isFinite(rawPosteriorProbability)
    ? (rawPosteriorProbability > 1 && rawPosteriorProbability <= 100
      ? rawPosteriorProbability / 100
      : rawPosteriorProbability)
    : modelProbabilities?.[tipCode] ?? null;
  const hasPosteriorProbability = posteriorProbability !== null
    && Number.isFinite(posteriorProbability)
    && posteriorProbability > 0
    && posteriorProbability <= 1;
  const evidenceScore = Number(candidate?.multiFactorEvidence?.evidenceScore);
  const trustScore = hasPosteriorProbability
    ? Math.round(posteriorProbability * 100)
    : Number.isFinite(Number(candidate?.trustScore))
      ? Math.max(0, Math.min(100, Math.round(Number(candidate?.trustScore))))
      : 0;
  const sourceUpdatedAt = modelReferenceTimestamp(match);
  const prediction: PredictionDetail = {
    ...(candidate || {}),
    marketType: 'BEST',
    oddsPoolCode: poolCode,
    handicapLine: poolCode === 'HHAD' ? String(handicapLine) : '0',
    tipCode,
    tipLabel: label,
    odds: 0,
    trustScore,
    recommendationAction: 'reference',
    recommendationTier: MODEL_LOW_EVIDENCE_TIER,
    explanation: {
      zh: `当前没有可核验的在售 ${poolCode} 赔率，按已生成的赛前模型方向给出${label.zh}。这是低置信数据推荐${Number.isFinite(evidenceScore) ? `，证据评分 ${Math.round(evidenceScore)}/100` : ''}；不计入正式命中率或串关。`,
      en: `No verifiable on-sale ${poolCode} price is available, so the stored pre-match model direction is shown as ${label.en}. This is a low-confidence data pick${Number.isFinite(evidenceScore) ? ` with an evidence score of ${Math.round(evidenceScore)}/100` : ''}; it is excluded from formal hit-rate and bet-slip statistics.`,
    },
    analysisItems: [
      {
        zh: '本方向只用于避免无内容空卡；赔率、阵容和数据质量补齐后会重新校验，不会自动升级为正式推荐。',
        en: 'This direction prevents an empty card only. It is rechecked when odds, lineups, and data quality improve and never auto-promotes to a formal pick.',
      },
      ...(candidate?.analysisItems || []),
    ],
    riskTags: [
      {
        zh: '无在售 SP · 模型低置信推荐',
        en: 'No on-sale SP · Low-confidence model pick',
      },
      {
        zh: '独立复盘，不计正式战绩',
        en: 'Separate review; excluded from formal record',
      },
      ...(candidate?.riskTags || []),
    ],
    visibilityStatus: candidate?.visibilityStatus || 'FREE',
    resultStatus: 'PENDING',
  };
  return {
    prediction,
    source: 'model-low-evidence',
    displayOdds: null,
    sourceUpdatedAt,
    rankScore: referenceRankScore(prediction, 'model-low-evidence'),
  };
};

const getFreshOfficialReferenceQuote = (
  match: Match,
  prediction: PredictionDetail,
  now: number,
) => {
  if (!isDirection(prediction.tipCode)) return null;
  const official = getOfficialMatchOdds(match);
  const pool = prediction.oddsPoolCode === 'HHAD' ? official.hhad : official.had;
  if (!pool || marketClockState(match, pool.updatedAt || null, now) !== 'fresh') return null;
  const value = prediction.tipCode === '1'
    ? pool.odds.odds1
    : prediction.tipCode === 'X'
      ? pool.odds.oddsX
      : pool.odds.odds2;
  return Number.isFinite(value) && Number(value) > 1
    ? { odds: Number(value), updatedAt: pool.updatedAt || null }
    : null;
};

const buildStableLowEvidenceModelReference = (
  match: Match,
  candidate: PredictionDetail | undefined,
  now: number,
): AnalysisReferenceSelection | undefined => {
  const base = buildLowEvidenceModelReference(match, candidate);
  if (!base) return undefined;

  const quote = getFreshOfficialReferenceQuote(match, base.prediction, now);
  const poolCode = base.prediction.oddsPoolCode || 'HAD';
  const label = base.prediction.tipLabel || referenceDirectionLabel(base.prediction.tipCode as OutcomeCode);
  const evidenceScore = Number(base.prediction.multiFactorEvidence?.evidenceScore);
  const quoteZh = quote
    ? `\u5f53\u524d\u5b98\u65b9 ${poolCode} ${label.zh} SP ${quote.odds.toFixed(2)} \u4ec5\u7528\u4e8e\u8865\u5145\u4ef7\u683c\uff0c\u5e02\u573a\u6982\u7387\u9996\u4f4d\u4e0d\u4f1a\u6539\u5199\u5df2\u751f\u6210\u65b9\u5411\u3002`
    : `\u5f53\u524d\u6ca1\u6709\u53ef\u6838\u9a8c\u7684\u65b0\u9c9c\u5b98\u65b9 ${poolCode} SP\uff0c\u65b9\u5411\u4ecd\u6cbf\u7528\u5df2\u751f\u6210\u7684\u8d5b\u524d BEST/\u6a21\u578b\u7ed3\u679c\u3002`;
  const quoteEn = quote
    ? `The current official ${poolCode} ${label.en} SP ${quote.odds.toFixed(2)} supplements price only; the market probability leader cannot overwrite the generated direction.`
    : `No fresh verifiable official ${poolCode} SP is available, so the generated pre-match BEST/model direction is retained.`;
  const prediction: PredictionDetail = {
    ...base.prediction,
    odds: quote?.odds || 0,
    explanation: {
      zh: `\u4e3b\u65b9\u5411\u6cbf\u7528\u5df2\u751f\u6210\u7684\u8d5b\u524d BEST/\u6a21\u578b\u7ed3\u679c\uff1a${label.zh}\u3002${quoteZh}\u8fd9\u662f\u4f4e\u7f6e\u4fe1\u6570\u636e\u63a8\u8350${Number.isFinite(evidenceScore) ? `\uff0c\u8bc1\u636e\u8bc4\u5206 ${Math.round(evidenceScore)}/100` : ''}\uff1b\u4e0d\u8ba1\u5165\u6b63\u5f0f\u547d\u4e2d\u7387\u6216\u4e32\u5173\u3002`,
      en: `The main direction retains the generated pre-match BEST/model result: ${label.en}. ${quoteEn} This is a low-confidence data pick${Number.isFinite(evidenceScore) ? ` with an evidence score of ${Math.round(evidenceScore)}/100` : ''}; it is excluded from formal hit-rate and bet-slip statistics.`,
    },
    analysisItems: [
      {
        zh: '\u65b9\u5411\u5728\u540c\u4e00\u8d5b\u524d\u7248\u672c\u5185\u4fdd\u6301\u7a33\u5b9a\uff1b\u8d54\u7387\u3001\u9635\u5bb9\u548c\u5916\u90e8\u5e02\u573a\u53ea\u7528\u4e8e\u8865\u5145\u8bc1\u636e\u4e0e\u98ce\u9669\uff0c\u4e0d\u5f97\u91cd\u65b0\u9009\u62e9\u4e3b\u65b9\u5411\u3002',
        en: 'The direction stays stable within the same pre-match version; odds, lineups, and external markets may supplement evidence and risk but cannot reselect the main direction.',
      },
      ...(candidate?.analysisItems || []),
    ],
    riskTags: [
      {
        zh: quote
          ? `\u5b98\u65b9 SP ${quote.odds.toFixed(2)} \u00b7 \u65b9\u5411\u5df2\u9501\u5b9a`
          : '\u6682\u65e0\u65b0\u9c9c\u5b98\u65b9 SP \u00b7 \u65b9\u5411\u5df2\u9501\u5b9a',
        en: quote
          ? `Official SP ${quote.odds.toFixed(2)} \u00b7 Direction locked`
          : 'No fresh official SP \u00b7 Direction locked',
      },
      {
        zh: '\u72ec\u7acb\u590d\u76d8\uff0c\u4e0d\u8ba1\u6b63\u5f0f\u6218\u7ee9',
        en: 'Separate review; excluded from formal record',
      },
      ...(candidate?.riskTags || []),
    ],
  };

  return {
    ...base,
    prediction,
    displayOdds: quote?.odds || null,
    rankScore: referenceRankScore(prediction, 'model-low-evidence'),
  };
};

export const getOfficialReferenceOdds = (
  match: Match,
  prediction: PredictionDetail | undefined,
) => {
  if (!prediction || !isDirection(prediction.tipCode)) return 0;
  const official = getOfficialMatchOdds(match);
  const odds = prediction.oddsPoolCode === 'HHAD' ? official.hhad?.odds : official.had?.odds;
  const value = prediction.tipCode === '1'
    ? odds?.odds1
    : prediction.tipCode === 'X'
      ? odds?.oddsX
      : odds?.odds2;
  return Number.isFinite(value) && Number(value) > 1 ? Number(value) : 0;
};

const referenceRankScore = (prediction: PredictionDetail, source: AnalysisReferenceSource) => {
  const sourcePriority: Record<AnalysisReferenceSource, number> = {
    'official-calibrated-market': 400,
    'official-market-consensus': 350,
    'five-hundred-market': 300,
    'strong-model': 200,
    'official-low-evidence-market': 175,
    'five-hundred-low-evidence-market': 150,
    'model-only': 100,
    'model-low-evidence': 75,
    'atomic-dual-market-reference': 500,
  };
  return sourcePriority[source]
    + Number(prediction.multiFactorEvidence?.evidenceScore || 0)
    + Number(prediction.trustScore || 0) / 10;
};

/**
 * Selects one non-executable pre-match direction for analysis display.
 *
 * Once a BEST/model direction exists, official or 500.com odds may supplement
 * its price and risk evidence but may never replace that direction. Market
 * leaders may create a fallback direction only when no stored or derived model
 * direction exists. Low-evidence fallbacks remain excluded from formal
 * recommendation statistics.
 */
export const selectOnSaleAnalysisReference = (
  match: Match,
  options: AnalysisReferenceSelectionOptions = {},
): AnalysisReferenceSelection | undefined => {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const kickoffAt = Date.parse(String(match.kickoffTime || ''));
  if (
    match.resultDisposition === 'VOID'
    || match.status !== 'SCHEDULED'
    || !Number.isFinite(kickoffAt)
    || now >= kickoffAt
  ) return undefined;

  const storedBest = options.candidate || getVisiblePrediction(match, 'BEST');
  if (!isBeforeMatchSaleCutoff(match, now)) {
    if (options.allowModelOnly === false) return undefined;
    const atomicReference = buildAtomicDualMarketHadReference(match, storedBest);
    if (atomicReference) return retainLockedPreCutoffReference(atomicReference);
    const lockedModelReference = buildStableLowEvidenceModelReference(match, storedBest, now);
    if (
      lockedModelReference?.sourceUpdatedAt
      && marketClockState(match, lockedModelReference.sourceUpdatedAt, now) === 'fresh'
    ) {
      return retainLockedPreCutoffReference(lockedModelReference);
    }
    const lockedFiveHundredCandidate = getFiveHundredHadCandidate(match);
    if (
      lockedFiveHundredCandidate
      && marketClockState(match, lockedFiveHundredCandidate.sourceUpdatedAt, now) === 'fresh'
    ) {
      const lockedReference = buildLowEvidenceMarketLeaderReference(
        match,
        now,
        true,
        isDirection(storedBest?.tipCode) ? storedBest?.tipCode as '1' | 'X' | '2' : undefined,
        lockedFiveHundredCandidate,
      );
      if (lockedReference) return retainLockedPreCutoffReference(lockedReference);
    }
    return undefined;
  }

  // Public fixture cards call this selector with allowModelOnly=false. In that
  // lane a direction is publishable only when a complete, fresh official HAD
  // price can be bound to it. This prevents missing-SP fixtures from inheriting
  // a model placeholder (the production symptom was a batch of synthetic draw
  // labels beside "未开售" odds).
  if (options.allowModelOnly === false && !hasFreshCompleteOfficialHad(match, now)) {
    return undefined;
  }

  if (storedBest && isCalibratedMarketAnalysisReferenceEligible(match, storedBest, now)) {
    const officialOdds = getOfficialReferenceOdds(match, storedBest);
    if (isPredictionOfficialResultPoolAvailable(match, storedBest) && officialOdds > 1) {
      const prediction = { ...storedBest, odds: officialOdds };
      return {
        prediction,
        source: 'official-calibrated-market',
        displayOdds: officialOdds,
        sourceUpdatedAt: match.predictionMeta?.generatedAt || null,
        rankScore: referenceRankScore(prediction, 'official-calibrated-market'),
      };
    }
  }

  if (storedBest && isDirectionalAnalysisReferenceEligible(match, storedBest, now)) {
    const canonicalPrediction = canonicalReferencePrediction(match, storedBest);
    const officialOdds = getOfficialReferenceOdds(match, canonicalPrediction);
    const prediction = { ...canonicalPrediction, odds: officialOdds > 1 ? officialOdds : 0 };
    return {
      prediction,
      source: 'strong-model',
      displayOdds: officialOdds > 1 ? officialOdds : null,
      sourceUpdatedAt: typeof match.probabilityModel?.unifiedPosterior?.generatedAt === 'string'
        ? match.probabilityModel.unifiedPosterior.generatedAt
        : null,
      rankScore: referenceRankScore(prediction, 'strong-model'),
    };
  }

  if (
    storedBest
    && options.allowModelOnly !== false
    && isModelOnlyAnalysisReferenceEligible(match, storedBest, now)
  ) {
    const prediction = canonicalReferencePrediction(match, { ...storedBest, oddsPoolCode: 'HAD', odds: 0 });
    return {
      prediction,
      source: 'model-only',
      displayOdds: null,
      sourceUpdatedAt: typeof match.probabilityModel?.unifiedPosterior?.generatedAt === 'string'
        ? match.probabilityModel.unifiedPosterior.generatedAt
        : null,
      rankScore: referenceRankScore(prediction, 'model-only'),
    };
  }

  if (options.allowModelOnly !== false) {
    const stableModelReference = buildStableLowEvidenceModelReference(match, storedBest, now);
    if (stableModelReference) return stableModelReference;
  }

  const officialMarketConsensus = buildOfficialMarketConsensusReference(match, undefined, now);
  if (officialMarketConsensus) return officialMarketConsensus;

  // Low-evidence market ranking deliberately remains available to internal
  // analysis/replay callers. Public cards must not turn an unresolved market
  // tie into a direction; the old neutral tie-break preferred X and could make
  // an entire low-evidence batch look like a confident all-draw recommendation.
  if (options.allowModelOnly === false) return undefined;

  const fiveHundred = buildFiveHundredMarketReferencePresentation(match, now);
  if (fiveHundred) {
    return {
      prediction: fiveHundred.prediction,
      source: 'five-hundred-market',
      displayOdds: fiveHundred.reference.selectedSourceOdds,
      sourceUpdatedAt: fiveHundred.reference.sourceUpdatedAt || null,
      rankScore: referenceRankScore(fiveHundred.prediction, 'five-hundred-market'),
    };
  }

  const lowEvidenceMarket = buildLowEvidenceMarketLeaderReference(
    match,
    now,
    true,
  );
  if (lowEvidenceMarket) return lowEvidenceMarket;
  return undefined;
};

export const getOnSaleAnalysisReference = (
  match: Match,
  options: AnalysisReferenceSelectionOptions = {},
) => selectOnSaleAnalysisReference(match, options)?.prediction;
