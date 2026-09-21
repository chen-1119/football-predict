import {
  getImpliedProbabilities,
  getOfficialMatchOdds,
  getOfficialResultPoolAvailability,
  getPredictionValueLabel,
  isPredictionOfficialResultPoolAvailable
} from './bettingDisplay';
import { getTeamById } from './entities';
import type { Match, PredictionDetail, Team } from './mockData';
import { isOfficialRecommendationEligible } from './officialRecommendationEligibility';
import {
  isLiveRecommendationEligible,
  isLiveRecommendationWindowOpen,
  isPublishedLiveRecommendationEligible
} from './liveRecommendationEligibility';
import { isBeforeMatchSaleCutoff } from './matchLifecycle';
import { formatCalibratedModelProbability, formatEvidenceScore } from './predictionPresentation';

type Language = 'zh' | 'en';

type OutcomeCode = '1' | 'X' | '2';
type HandicapCompanionPriority = 'preferred' | 'caution' | 'supplement';
type OutcomeProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

type DisplayRecommendationKind = 'prediction' | 'handicap' | 'outcome' | 'score';

export interface DisplayRecommendationCompanion {
  kind: 'handicap';
  priority: HandicapCompanionPriority;
  prediction: PredictionDetail;
  tipCode: string;
  label: string;
  title: string;
  meta: string;
  probability: number | null;
  support: number | null;
  reason: string;
  lineAudit?: HandicapLineResolution;
}

export type HandicapLineSource =
  | 'official-sporttery'
  | 'prediction-reference'
  | 'external-bookmaker-reference'
  | 'external-signal-reference'
  | 'match-reference'
  | 'stored-prediction-reference'
  | 'none';

export type HandicapLineAuditReason =
  | 'official-current-line'
  | 'official-line-invalid'
  | 'stale-prediction-line-conflict'
  | 'reference-line-conflict'
  | 'prediction-reference-line'
  | 'external-bookmaker-reference-line'
  | 'external-signal-reference-line'
  | 'match-reference-line'
  | 'stored-prediction-reference-line'
  | 'handicap-line-missing';

export interface HandicapLineResolution {
  line: number | null;
  source: HandicapLineSource;
  official: boolean;
  conflict: boolean;
  reason: HandicapLineAuditReason;
  conflictingLines: number[];
}

export interface DualMarketCompanionAudit {
  status: 'bound' | 'blocked' | 'not-applicable';
  blockers: string[];
  prediction?: PredictionDetail;
  lineAudit?: HandicapLineResolution;
}

export interface DisplayRecommendation {
  kind: DisplayRecommendationKind;
  publicationTrack?: 'formal' | 'live';
  prediction?: PredictionDetail;
  tipCode?: string;
  label: string;
  meta: string;
  probability: number | null;
  support: number | null;
  reason: string;
  companion?: DisplayRecommendationCompanion;
  companionAudit?: DualMarketCompanionAudit;
}

type RankedOutcome = { code: OutcomeCode; probability: number };

const isOutcomeCode = (code: string | undefined): code is OutcomeCode => code === '1' || code === 'X' || code === '2';

export const getOfficialRecommendationOdds = (
  match: Match,
  prediction: PredictionDetail | undefined
) => {
  if (!prediction || !isOutcomeCode(prediction.tipCode)) return 0;
  if (prediction.oddsPoolCode === 'HHAD' && resolveHandicapLine(match, prediction) === null) return 0;
  const official = getOfficialMatchOdds(match);
  const odds = prediction.oddsPoolCode === 'HHAD' ? official.hhad?.odds : official.had?.odds;
  const value = prediction.tipCode === '1'
    ? odds?.odds1
    : prediction.tipCode === 'X'
      ? odds?.oddsX
      : odds?.odds2;
  return Number.isFinite(value) && Number(value) > 1 ? Number(value) : 0;
};

export const getOfficialRecommendationHandicapLine = (
  match: Match,
  prediction: PredictionDetail | undefined
) => prediction?.oddsPoolCode === 'HHAD'
  ? getOfficialMatchOdds(match).hhad?.handicap
  : 0;

export const isFormalRecommendationPrediction = (
  match: Match,
  prediction: PredictionDetail | undefined
) => {
  if (!prediction || !isPredictionOfficialResultPoolAvailable(match, prediction)) return false;
  if (prediction.oddsPoolCode === 'HHAD' && resolveHandicapLine(match, prediction) === null) return false;
  return isOfficialRecommendationEligible(
    prediction,
    getOfficialRecommendationOdds(match, prediction),
    getOfficialRecommendationHandicapLine(match, prediction)
  );
};

export const getFormalRecommendationPrediction = (match: Match): PredictionDetail | undefined => {
  if (match.status !== 'SCHEDULED' || !isBeforeMatchSaleCutoff(match)) return undefined;
  return (match.predictions || []).find((prediction) => (
    prediction.marketType === 'BEST'
    && isFormalRecommendationPrediction(match, prediction)
  ));
};

export const isLiveRecommendationPrediction = (
  match: Match,
  prediction: PredictionDetail | undefined
) => {
  if (!prediction || !isPredictionOfficialResultPoolAvailable(match, prediction)) return false;
  if (prediction.oddsPoolCode === 'HHAD' && resolveHandicapLine(match, prediction) === null) return false;
  const officialOdds = getOfficialRecommendationOdds(match, prediction);
  const officialHandicapLine = getOfficialRecommendationHandicapLine(match, prediction);
  return isLiveRecommendationEligible(
    prediction,
    officialOdds,
    officialHandicapLine,
    match
  ) || isPublishedLiveRecommendationEligible(
    prediction,
    officialOdds,
    officialHandicapLine,
    match
  );
};

const getPublishedLiveRecommendationPrediction = (
  match: Match,
  prediction: PredictionDetail | undefined
): PredictionDetail | undefined => {
  const publication = prediction?.livePublicationEvidence;
  const publishedOdds = Number(publication?.officialSp);
  const publishedMarket = publication?.market;
  const publishedCode = publication?.code;
  const publishedLine = publishedMarket === 'HHAD'
    ? parseHandicapLine(publication?.handicapLine)
    : 0;
  if (
    !prediction
    || !publication
    || (publishedMarket !== 'HAD' && publishedMarket !== 'HHAD')
    || (publishedCode !== '1' && publishedCode !== 'X' && publishedCode !== '2')
    || !Number.isFinite(publishedOdds)
    || publishedOdds <= 1
    || (publishedMarket === 'HHAD' && publishedLine === null)
    || !isPublishedLiveRecommendationEligible(
      prediction,
      publishedOdds,
      publishedLine,
      match
    )
  ) return undefined;

  return {
    ...prediction,
    oddsPoolCode: publishedMarket,
    tipCode: publishedCode,
    tipLabel: publishedMarket === 'HHAD'
      ? {
          zh: getSimpleHandicapLabel(publishedCode, 'zh'),
          en: getSimpleHandicapLabel(publishedCode, 'en')
        }
      : {
          zh: getSimpleOutcomeLabel(match, publishedCode, 'zh'),
          en: getSimpleOutcomeLabel(match, publishedCode, 'en')
        },
    odds: publishedOdds,
    handicapLine: publishedMarket === 'HHAD' && publishedLine !== null
      ? serializeHandicapLine(publishedLine)
      : '0'
  };
};

export const getLiveRecommendationPrediction = (match: Match): PredictionDetail | undefined => {
  const predictions = match.predictions || [];
  const publishedPrediction = predictions
    .filter((prediction) => prediction.marketType === 'BEST')
    .map((prediction) => getPublishedLiveRecommendationPrediction(match, prediction))
    .find(Boolean);
  if (publishedPrediction) return publishedPrediction;
  if (!isLiveRecommendationWindowOpen(match)) return undefined;
  return predictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && isLiveRecommendationPrediction(match, prediction)
  ));
};

export const getMatchDisplayTeam = (match: Match, side: 'home' | 'away'): Team => {
  const base = getTeamById(side === 'home' ? match.homeTeamId : match.awayTeamId);
  const teamName = side === 'home' ? match.homeTeamName : match.awayTeamName;
  const teamNameEn = side === 'home' ? match.homeTeamNameEn : match.awayTeamNameEn;
  const teamLogo = side === 'home' ? match.homeTeamLogo : match.awayTeamLogo;
  const teamLogoType = side === 'home' ? match.homeTeamLogoType : match.awayTeamLogoType;
  const teamCountryIso = side === 'home' ? match.homeTeamCountryIso : match.awayTeamCountryIso;
  const teamColor = side === 'home' ? match.homeTeamColor : match.awayTeamColor;
  const teamValue = side === 'home' ? match.homeTeamValue : match.awayTeamValue;
  const nameZh = teamName || base.name.zh;
  const nameEn = teamNameEn || teamName || base.name.en;

  return {
    ...base,
    name: { zh: nameZh, en: nameEn },
    shortName: { zh: nameZh, en: nameEn },
    // A club's country is not its crest. Preserve supplied artwork, and use an
    // ISO fallback only when the match explicitly identifies a national flag.
    logo: teamLogo || (teamLogoType === 'flag' ? teamCountryIso : undefined) || base.logo,
    logoType: teamLogoType || base.logoType,
    value: teamValue || base.value,
    color: teamColor || base.color
  };
};

const getRankedOutcomeProbabilities = (probabilities: OutcomeProbabilityTriplet): RankedOutcome[] => ([
  { code: '1' as OutcomeCode, probability: probabilities?.home },
  { code: 'X' as OutcomeCode, probability: probabilities?.draw },
  { code: '2' as OutcomeCode, probability: probabilities?.away }
])
  .map((item) => ({ ...item, probability: Number(item.probability) }))
  .filter((item): item is RankedOutcome => Number.isFinite(item.probability))
  .sort((a, b) => b.probability - a.probability);

const getOutcomeProbability = (match: Match, code: OutcomeCode, prediction?: PredictionDetail) => {
  const final = prediction?.oddsPoolCode === 'HHAD'
    ? getHandicapModelProbabilities(match)
    : match.probabilityModel?.oneXTwo?.unifiedPosterior
      || match.probabilityModel?.oneXTwo?.final
      || match.probabilityModel?.oneXTwo?.market;
  if (!final) return null;
  const value = code === '1' ? final.home : code === 'X' ? final.draw : final.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const getTopOutcomeFromProbabilities = (probabilities: OutcomeProbabilityTriplet) => (
  getRankedOutcomeProbabilities(probabilities)[0] || null
);

const getHandicapModelProbabilities = (match: Match) => (
  resolveHandicapLine(match) === null
    ? null
    : match.probabilityModel?.handicap?.unifiedPosterior
    || match.probabilityModel?.handicap?.scoreImplied
    || match.probabilityModel?.handicap?.poisson
    || match.probabilityModel?.handicap?.market
);

const getHandicapRead = (match: Match) => {
  const hasHandicapLine = resolveHandicapLine(match) !== null;
  const modelRows = getRankedOutcomeProbabilities(
    getHandicapModelProbabilities(match)
  );
  const resolvedOdds = getOfficialMatchOdds(match);
  const marketRows = getRankedOutcomeProbabilities(
    hasHandicapLine ? (match.probabilityModel?.handicap?.market
      || getImpliedProbabilities(resolvedOdds.hhad?.odds)
    ) : null
  );
  const modelTop = modelRows[0] || null;
  const modelSecond = modelRows[1] || null;
  const marketTop = marketRows[0] || null;
  const marketSecond = marketRows[1] || null;
  const marketSupport = modelTop
    ? marketRows.find((item) => item.code === modelTop.code)?.probability ?? null
    : null;

  return {
    modelTop,
    modelGap: modelTop && modelSecond ? modelTop.probability - modelSecond.probability : 0,
    marketTop,
    marketGap: marketTop && marketSecond ? marketTop.probability - marketSecond.probability : 0,
    marketSupport,
    modelMarketSpread: modelTop && marketSupport !== null ? Math.abs(modelTop.probability - marketSupport) : null
  };
};

const isCloseHandicapDecision = (read: ReturnType<typeof getHandicapRead> | null | undefined) => (
  Boolean(read?.modelTop && read?.marketTop && Number(read.marketGap) <= 1.5)
);

const isHandicapImpossibleWithPrimary = (
  primaryPrediction: PredictionDetail | undefined,
  displayCode: OutcomeCode,
  lineValue: number | null
) => (
  Boolean(
    primaryPrediction
    && primaryPrediction.oddsPoolCode !== 'HHAD'
    && isOutcomeCode(primaryPrediction.tipCode)
    && !isHandicapCodeCompatible(primaryPrediction.tipCode, displayCode, lineValue)
  )
);

const getHandicapCompanionPriority = ({
  handicapPrediction,
  primaryPrediction,
  probability,
  support,
  read,
  displayCode,
  lineValue
}: {
  handicapPrediction?: PredictionDetail;
  primaryPrediction?: PredictionDetail;
  probability: number | null;
  support: number | null;
  read?: ReturnType<typeof getHandicapRead> | null;
  displayCode: OutcomeCode;
  lineValue: number | null;
}): HandicapCompanionPriority => {
  const primaryTrust = Number(primaryPrediction?.trustScore || 0);
  const handicapTrust = Number(handicapPrediction?.trustScore || 0);
  const isBestHandicap = handicapPrediction?.marketType === 'BEST' && handicapPrediction.oddsPoolCode === 'HHAD';
  const impossibleWithPrimary = isHandicapImpossibleWithPrimary(primaryPrediction, displayCode, lineValue);
  const modelAgreesWithDisplay = read?.modelTop?.code === displayCode;
  const supportOk = support === null || support >= 34;
  const probabilityOk = probability !== null && probability >= 48;
  const strongModelRead = Boolean(
    modelAgreesWithDisplay
    && probabilityOk
    && (read?.modelGap ?? 0) >= 8
    && supportOk
  );
  const bestHandicapEdge = Boolean(
    isBestHandicap
    && modelAgreesWithDisplay
    && supportOk
    && (probability === null || probability >= 42)
    && handicapTrust >= Math.max(54, primaryTrust + 8)
  );
  const weakPrimaryRescue = Boolean(
    modelAgreesWithDisplay
    && supportOk
    && primaryTrust > 0
    && primaryTrust <= 52
    && probability !== null
    && probability >= 45
  );

  if (impossibleWithPrimary) return 'caution';
  return strongModelRead || bestHandicapEdge || weakPrimaryRescue ? 'preferred' : 'supplement';
};

export const getHandicapCompanionHeading = (
  companion: DisplayRecommendationCompanion,
  language: Language
) => (
  companion.priority === 'preferred'
    ? (language === 'zh' ? '让球附加推荐' : 'HHAD add-on pick')
    : companion.priority === 'caution'
      ? (language === 'zh' ? '让球谨慎推荐' : 'HHAD cautious pick')
      : (language === 'zh' ? '让球参考推荐' : 'HHAD reference pick')
);

const getHandicapCompanionTitle = (
  label: string,
  language: Language,
  priority: HandicapCompanionPriority
) => (
  priority === 'preferred'
    ? (language === 'zh' ? `让球附加推荐 ${label}` : `HHAD add-on pick ${label}`)
    : priority === 'caution'
      ? (language === 'zh' ? `让球谨慎推荐 ${label}` : `HHAD cautious pick ${label}`)
      : (language === 'zh' ? `让球参考推荐 ${label}` : `HHAD reference pick ${label}`)
);

const getCloseHandicapReason = (language: Language) => (
  language === 'zh'
    ? '让球胜负差距很小，本场按赛前综合信息给出当前推荐。'
    : 'The handicap sides are close, so this pick uses the full pre-match read.'
);

const isHandicapMarketContradicted = (match: Match, prediction?: PredictionDetail) => {
  if (prediction?.oddsPoolCode !== 'HHAD' || !isOutcomeCode(prediction.tipCode)) return false;
  const read = getHandicapRead(match);
  const support = read.marketSupport;
  return Boolean(
    read.modelTop
    && read.marketTop
    && read.modelTop.code === prediction.tipCode
    && read.marketTop.code !== prediction.tipCode
    && support !== null
    && support < 38
  );
};

const getOutcomeOddsValue = (match: Match, poolCode: 'HAD' | 'HHAD', code: OutcomeCode) => {
  const resolvedOdds = getOfficialMatchOdds(match);
  const odds = poolCode === 'HHAD' ? resolvedOdds.hhad?.odds : resolvedOdds.had?.odds;
  const value = code === '1' ? odds?.odds1 : code === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) ? Number(value) : 0;
};

const getSimpleHandicapLabel = (code: OutcomeCode, language: Language) => {
  if (language === 'zh') {
    if (code === '1') return '让胜';
    if (code === 'X') return '让平';
    return '让负';
  }

  if (code === '1') return 'Handicap home';
  if (code === 'X') return 'Handicap draw';
  return 'Handicap away';
};

const getSimpleOutcomeLabel = (match: Match, code: OutcomeCode, language: Language) => {
  const homeTeam = getMatchDisplayTeam(match, 'home');
  const awayTeam = getMatchDisplayTeam(match, 'away');
  const homeName = homeTeam.shortName[language] || homeTeam.name[language];
  const awayName = awayTeam.shortName[language] || awayTeam.name[language];

  if (language === 'zh') {
    if (code === '1') return `主胜 ${homeName}`;
    if (code === 'X') return '平局';
    return `客胜 ${awayName}`;
  }

  if (code === '1') return `Home ${homeName}`;
  if (code === 'X') return 'Draw';
  return `Away ${awayName}`;
};

const formatHandicapLine = (line: string | undefined, language: Language) => {
  if (!line) return language === 'zh' ? '让球' : 'HHAD';
  return language === 'zh' ? `让球 ${line}` : `HHAD ${line}`;
};

export const parseHandicapLine = (line: unknown): number | null => {
  if (typeof line === 'number') return Number.isFinite(line) ? line : null;
  if (typeof line !== 'string') return null;
  const normalized = line
    .trim()
    .replace(/\uFF0B/g, '+')
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
  const matched = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
};

const hasExplicitHhadMarker = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    record.poolCode,
    record.oddsPoolCode,
    record.market,
    record.marketType,
    record.externalOddsPoolCode,
    record.handicapOddsPoolCode
  ].some((marker) => String(marker || '').trim().toUpperCase() === 'HHAD');
};

const uniqueHandicapLines = (values: Array<number | null>) => Array.from(new Set(
  values.filter((value): value is number => value !== null)
));

const lineConflict = (left: number, right: number) => Math.abs(left - right) > 0.000001;

/**
 * Resolves the home-team HHAD line with an explicit provenance contract.
 * A current Sporttery HHAD market always wins. Stored prediction lines are
 * never allowed to override it; a disagreement is an auditable fail-closed
 * state so an old -1 row cannot silently turn a current +1 market around.
 * Non-official lines remain usable only as clearly labelled reference input.
 */
export const getHandicapLineResolution = (
  match: Match,
  prediction?: PredictionDetail
): HandicapLineResolution => {
  const officialHhad = getOfficialMatchOdds(match).hhad;
  const officialLine = parseHandicapLine(officialHhad?.handicap);
  const storedHhadRows = (match.predictions || []).filter((item) => item.oddsPoolCode === 'HHAD');
  const storedParsedLines = storedHhadRows.map((item) => parseHandicapLine(item.handicapLine));
  const storedInvalidLine = storedHhadRows.some((item, index) => (
    String(item.handicapLine ?? '').trim().length > 0 && storedParsedLines[index] === null
  ));

  if (officialHhad) {
    if (officialLine === null) {
      return {
        line: null,
        source: 'official-sporttery',
        official: true,
        conflict: true,
        reason: 'official-line-invalid',
        conflictingLines: uniqueHandicapLines(storedParsedLines)
      };
    }
    const conflictingLines = uniqueHandicapLines(storedParsedLines)
      .filter((line) => lineConflict(line, officialLine));
    if (storedInvalidLine || conflictingLines.length > 0) {
      return {
        line: null,
        source: 'official-sporttery',
        official: true,
        conflict: true,
        reason: 'stale-prediction-line-conflict',
        conflictingLines
      };
    }
    return {
      line: officialLine,
      source: 'official-sporttery',
      official: true,
      conflict: false,
      reason: 'official-current-line',
      conflictingLines: []
    };
  }

  const bookmakerHhad = match.externalSignals?.bookmakerOdds?.hhad;
  const bookmakerLine = parseHandicapLine(bookmakerHhad?.handicapLine);
  const externalLine = parseHandicapLine(match.externalSignals?.handicapLine);
  const hasBookmakerHhadOdds = Boolean(
    bookmakerHhad
    && [bookmakerHhad.odds1, bookmakerHhad.oddsX, bookmakerHhad.odds2]
      .every((odd) => Number.isFinite(Number(odd)) && Number(odd) > 1)
  );
  const allowExternalLine = externalLine !== null
    && (hasBookmakerHhadOdds || hasExplicitHhadMarker(bookmakerHhad) || hasExplicitHhadMarker(match.externalSignals));
  const predictionLine = prediction?.oddsPoolCode === 'HHAD'
    ? parseHandicapLine(prediction.handicapLine)
    : null;
  const matchLine = parseHandicapLine(match.handicapLine);
  const candidates: Array<{
    line: number | null;
    source: HandicapLineSource;
    reason: HandicapLineAuditReason;
  }> = [
    { line: predictionLine, source: 'prediction-reference', reason: 'prediction-reference-line' },
    { line: bookmakerLine, source: 'external-bookmaker-reference', reason: 'external-bookmaker-reference-line' },
    { line: allowExternalLine ? externalLine : null, source: 'external-signal-reference', reason: 'external-signal-reference-line' },
    { line: matchLine, source: 'match-reference', reason: 'match-reference-line' },
    ...storedParsedLines.map((line) => ({
      line,
      source: 'stored-prediction-reference' as const,
      reason: 'stored-prediction-reference-line' as const
    }))
  ];
  const referenceLines = uniqueHandicapLines(candidates.map((candidate) => candidate.line));
  if (referenceLines.length > 1 || storedInvalidLine) {
    return {
      line: null,
      source: 'none',
      official: false,
      conflict: true,
      reason: 'reference-line-conflict',
      conflictingLines: referenceLines
    };
  }
  const selected = candidates.find((candidate) => candidate.line !== null);
  if (selected?.line !== null && selected?.line !== undefined) {
    return {
      line: selected.line,
      source: selected.source,
      official: false,
      conflict: false,
      reason: selected.reason,
      conflictingLines: []
    };
  }
  return {
    line: null,
    source: 'none',
    official: false,
    conflict: false,
    reason: 'handicap-line-missing',
    conflictingLines: []
  };
};

export const resolveHandicapLine = (
  match: Match,
  prediction?: PredictionDetail
): number | null => getHandicapLineResolution(match, prediction).line;

const serializeHandicapLine = (line: number): string => {
  if (line === 0) return '0';
  const absolute = Math.abs(line);
  const value = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(2).replace(/\.?0+$/, '');
  return `${line > 0 ? '+' : '-'}${value}`;
};

const getHandicapOutcomeProbability = (match: Match, code: OutcomeCode) => {
  if (resolveHandicapLine(match) === null) return null;
  const probabilities = getHandicapModelProbabilities(match);
  if (!probabilities) return null;
  const value = code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const getHandicapMarketSupport = (match: Match, code: OutcomeCode) => {
  if (resolveHandicapLine(match) === null) return null;
  const resolvedOdds = getOfficialMatchOdds(match);
  const probabilities = match.probabilityModel?.handicap?.market
    || getImpliedProbabilities(resolvedOdds.hhad?.odds);
  if (!probabilities) return null;
  const value = code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const doesPrimaryMatchMargin = (primaryCode: OutcomeCode, margin: number) => {
  if (primaryCode === '1') return margin > 0;
  if (primaryCode === 'X') return margin === 0;
  return margin < 0;
};

const getHandicapCodeForMargin = (margin: number, line: number): OutcomeCode => {
  const adjustedMargin = margin + line;
  if (adjustedMargin > 0) return '1';
  if (adjustedMargin < 0) return '2';
  return 'X';
};

const isHandicapCodeCompatible = (
  primaryCode: OutcomeCode,
  handicapCode: OutcomeCode,
  lineValue: number | null
) => {
  if (lineValue === null) return true;

  for (let margin = -20; margin <= 20; margin += 1) {
    if (doesPrimaryMatchMargin(primaryCode, margin) && getHandicapCodeForMargin(margin, lineValue) === handicapCode) {
      return true;
    }
  }

  return false;
};

const getCompatibleHandicapCode = (
  match: Match,
  primaryPrediction: PredictionDetail | undefined,
  proposedCode: OutcomeCode
): OutcomeCode => {
  if (!primaryPrediction || !isOutcomeCode(primaryPrediction.tipCode) || primaryPrediction.oddsPoolCode === 'HHAD') {
    return proposedCode;
  }

  const lineValue = resolveHandicapLine(match);
  if (isHandicapCodeCompatible(primaryPrediction.tipCode, proposedCode, lineValue)) {
    return proposedCode;
  }

  const compatibleCodes = (['1', 'X', '2'] as OutcomeCode[]).filter((code) => (
    isHandicapCodeCompatible(primaryPrediction.tipCode as OutcomeCode, code, lineValue)
  ));

  if (compatibleCodes.includes('X')) return 'X';

  return compatibleCodes
    .map((code) => ({ code, probability: getHandicapOutcomeProbability(match, code) ?? getHandicapMarketSupport(match, code) ?? 0 }))
    .sort((a, b) => b.probability - a.probability)[0]?.code || proposedCode;
};

const getCompanionReason = (
  match: Match,
  primaryPrediction: PredictionDetail,
  handicapCode: OutcomeCode,
  language: Language
) => {
  const homeTeam = getMatchDisplayTeam(match, 'home');
  const awayTeam = getMatchDisplayTeam(match, 'away');
  const homeName = homeTeam.shortName[language] || homeTeam.name[language];
  const awayName = awayTeam.shortName[language] || awayTeam.name[language];
  const resolvedLine = resolveHandicapLine(match);
  const line = formatHandicapLine(
    resolvedLine === null ? undefined : serializeHandicapLine(resolvedLine),
    language
  );
  const handicapLabel = getSimpleHandicapLabel(handicapCode, language);

  if (language === 'zh') {
    if (primaryPrediction.tipCode === '1' && handicapCode === '2') {
      return `胜平负主线看${homeName}取胜，但${line}提示穿盘压力，附加看${handicapLabel}。`;
    }
    if (primaryPrediction.tipCode === '2' && handicapCode === '1') {
      return `胜平负主线看${awayName}取胜，但${line}提示受让一方更稳，附加看${handicapLabel}。`;
    }
    if (primaryPrediction.tipCode !== handicapCode) {
      return `胜平负和${line}指向不同，主推不变，附加看${handicapLabel}。`;
    }
    return `胜平负和${line}同向，附加看${handicapLabel}确认穿盘方向。`;
  }

  if (primaryPrediction.tipCode === '1' && handicapCode === '2') {
    return `The 1X2 pick stays with ${homeName}, while ${line} points to cover pressure; add ${handicapLabel}.`;
  }
  if (primaryPrediction.tipCode === '2' && handicapCode === '1') {
    return `The 1X2 pick stays with ${awayName}, while ${line} favours the receiving side; add ${handicapLabel}.`;
  }
  if (primaryPrediction.tipCode !== handicapCode) {
    return `1X2 and ${line} point to different reads; keep the main pick and add ${handicapLabel}.`;
  }
  return `1X2 and ${line} align; add ${handicapLabel} as the handicap read.`;
};

const buildHandicapCompanionFromPrediction = (
  match: Match,
  handicapPrediction: PredictionDetail | undefined,
  primaryPrediction: PredictionDetail | undefined,
  language: Language
): DisplayRecommendationCompanion | null => {
  if (!handicapPrediction || handicapPrediction.oddsPoolCode !== 'HHAD' || !isOutcomeCode(handicapPrediction.tipCode)) {
    return null;
  }
  if (!primaryPrediction || !isOutcomeCode(primaryPrediction.tipCode)) return null;
  const lineAudit = getHandicapLineResolution(match, handicapPrediction);
  const lineValue = lineAudit.line;
  if (lineValue === null) return null;

  // A server-verified dual-market binding is already the immutable decision
  // record. Compatibility heuristics may shape an unbound live supplement,
  // but must never rewrite an atomically committed HHAD code after the fact.
  const isAtomicallyBoundCompanion = handicapPrediction.recommendationTier === 'handicap-companion-bound';
  const displayCode = isAtomicallyBoundCompanion
    ? handicapPrediction.tipCode
    : getCompatibleHandicapCode(match, primaryPrediction, handicapPrediction.tipCode);
  const adjustedPredictionBase: PredictionDetail = displayCode === handicapPrediction.tipCode
    ? handicapPrediction
    : {
        ...handicapPrediction,
        tipCode: displayCode,
        tipLabel: { zh: getSimpleHandicapLabel(displayCode, 'zh'), en: getSimpleHandicapLabel(displayCode, 'en') },
        odds: getOutcomeOddsValue(match, 'HHAD', displayCode)
      };
  const adjustedPrediction: PredictionDetail = {
    ...adjustedPredictionBase,
    handicapLine: serializeHandicapLine(lineValue)
  };
  const probability = getOutcomeProbability(match, displayCode, adjustedPrediction);
  const read = getHandicapRead(match);
  const support = read.modelTop?.code === displayCode
    ? read.marketSupport ?? null
    : getHandicapMarketSupport(match, displayCode);
  const label = getSimpleHandicapLabel(displayCode, language);
  const priority = getHandicapCompanionPriority({
    handicapPrediction,
    primaryPrediction,
    probability: Number.isFinite(probability) ? Number(probability) : null,
    support,
    read,
    displayCode,
    lineValue
  });

  return {
    kind: 'handicap',
    priority,
    prediction: adjustedPrediction,
    tipCode: displayCode,
    label,
    title: getHandicapCompanionTitle(label, language, priority),
    meta: `${formatHandicapLine(serializeHandicapLine(lineValue), language)}${lineAudit.official ? '' : (language === 'zh' ? ' · 参考让球线' : ' · Reference HHAD line')} · ${formatDisplayMeta(match, adjustedPrediction, language)}`,
    probability: Number.isFinite(probability) ? Number(probability) : null,
    support,
    reason: getCompanionReason(match, primaryPrediction, displayCode, language),
    lineAudit
  };
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const validProbability = (value: unknown) => (
  Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1
);

const validTimestamp = (value: unknown) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Replays only the compact dual-market record that the server attested before
 * cutoff. Formal/live callers must never substitute a fresh HHAD model read.
 */
export const getDualMarketCompanionAudit = (
  match: Match,
  primaryPrediction: PredictionDetail | undefined
): DualMarketCompanionAudit => {
  if (!primaryPrediction || primaryPrediction.oddsPoolCode === 'HHAD') {
    return { status: 'not-applicable', blockers: [] };
  }

  const binding = match.predictionMeta?.dualMarketDecision;
  const had = binding?.had;
  const hhad = binding?.hhad;
  const clocks = binding?.sourceClocks;
  const versions = binding?.strategyVersions;
  const hashes = binding?.hashes;
  const lineAudit = getHandicapLineResolution(match);
  const officialLine = lineAudit.line;
  const boundLine = Number(hhad?.handicapLine);
  const odds = Number(hhad?.odds);
  const probability = Number(hhad?.modelProbability);
  const blockers: string[] = [];
  const push = (condition: boolean, blocker: string) => {
    if (condition) blockers.push(blocker);
  };

  push(!binding, 'dual-market-binding-missing');
  push(binding?.version !== 'dual-market-decision-binding-v1', 'binding-version-invalid');
  push(binding?.decisionSnapshotVersion !== 'candidate-decision-snapshot-v2', 'decision-snapshot-version-invalid');
  push(binding?.integrityVerified !== true, 'binding-not-server-attested');
  push(binding?.integrityVersion !== 'dual-market-decision-integrity-v1', 'binding-integrity-version-invalid');
  push(binding?.publicBindingVersion !== 'dual-market-public-binding-v1', 'public-binding-version-invalid');
  push(!SHA256_PATTERN.test(String(binding?.bindingHash || '')), 'binding-hash-missing-or-invalid');
  push(!SHA256_PATTERN.test(String(binding?.publicBindingHash || '')), 'public-binding-hash-missing-or-invalid');
  push(!String(binding?.sourceCycleId || '').trim(), 'source-cycle-id-missing');
  push(!String(binding?.featureSnapshotHash || '').trim(), 'feature-snapshot-hash-missing');
  push(had?.poolCode !== 'HAD', 'had-binding-missing-or-invalid');
  push(!isOutcomeCode(had?.code), 'had-code-invalid');
  push(primaryPrediction.oddsPoolCode !== 'HAD', 'primary-pool-not-had');
  push(!isOutcomeCode(primaryPrediction.tipCode), 'primary-code-invalid');
  push(isOutcomeCode(primaryPrediction.tipCode) && had?.code !== primaryPrediction.tipCode, 'primary-had-direction-mismatch');
  push(!Number.isFinite(Number(had?.odds)) || Number(had?.odds) <= 1, 'had-odds-missing-or-invalid');
  push(!validProbability(had?.modelProbability), 'had-model-probability-missing-or-invalid');
  push(!validProbability(had?.marketProbability), 'had-market-probability-missing-or-invalid');
  push(hhad?.poolCode !== 'HHAD', 'hhad-binding-missing-or-invalid');
  push(!isOutcomeCode(hhad?.code), 'hhad-code-invalid');
  push(!lineAudit.official, 'official-hhad-line-unavailable');
  push(lineAudit.conflict, `handicap-line-${lineAudit.reason}`);
  push(officialLine === null, 'official-hhad-line-missing-or-invalid');
  push(!Number.isFinite(boundLine), 'bound-hhad-line-missing-or-invalid');
  push(
    officialLine !== null && Number.isFinite(boundLine) && lineConflict(officialLine, boundLine),
    'bound-hhad-line-mismatch'
  );
  push(!Number.isFinite(odds) || odds <= 1, 'hhad-odds-missing-or-invalid');
  push(!validProbability(probability), 'hhad-model-probability-missing-or-invalid');
  push(!validProbability(hhad?.marketProbability), 'hhad-market-probability-missing-or-invalid');

  const timestampKeys = [
    'capturedAt',
    'decisionAt',
    'cutoffTime',
    'modelGeneratedAt',
    'hadObservedAt',
    'hadReceivedAt',
    'hhadObservedAt',
    'hhadReceivedAt'
  ] as const;
  const parsedClocks = Object.fromEntries(
    timestampKeys.map((key) => [key, validTimestamp(clocks?.[key])])
  ) as Record<typeof timestampKeys[number], number | null>;
  for (const key of timestampKeys) {
    push(parsedClocks[key] === null, `${key}-missing-or-invalid`);
  }
  const pushClockOrder = (
    left: typeof timestampKeys[number],
    right: typeof timestampKeys[number],
    blocker: string
  ) => {
    const leftAt = parsedClocks[left];
    const rightAt = parsedClocks[right];
    push(leftAt !== null && rightAt !== null && leftAt > rightAt, blocker);
  };
  pushClockOrder('capturedAt', 'cutoffTime', 'binding-captured-after-cutoff');
  pushClockOrder('modelGeneratedAt', 'decisionAt', 'model-generated-after-decision');
  pushClockOrder('decisionAt', 'cutoffTime', 'decision-after-cutoff');
  pushClockOrder('hadObservedAt', 'hadReceivedAt', 'had-observed-after-received');
  pushClockOrder('hadReceivedAt', 'decisionAt', 'had-received-after-decision');
  pushClockOrder('hhadObservedAt', 'hhadReceivedAt', 'hhad-observed-after-received');
  pushClockOrder('hhadReceivedAt', 'decisionAt', 'hhad-received-after-decision');
  const kickoffAt = validTimestamp(match.kickoffTime);
  push(kickoffAt === null, 'kickoff-time-missing-or-invalid');
  push(
    parsedClocks.cutoffTime !== null && kickoffAt !== null && parsedClocks.cutoffTime > kickoffAt,
    'cutoff-after-kickoff'
  );

  for (const key of ['predictionPolicy', 'prompt', 'model', 'calibration', 'hhadCompanion'] as const) {
    push(!String(versions?.[key] || '').trim(), `${key}-version-missing`);
  }
  for (const key of [
    'policyHash',
    'hadMarketProvenanceHash',
    'hhadMarketProvenanceHash',
    'strategyHash',
    'revisionHash',
    'exposureHash',
    'pairHash'
  ] as const) {
    push(!SHA256_PATTERN.test(String(hashes?.[key] || '')), `${key}-missing-or-invalid`);
  }

  if (blockers.length > 0 || !hhad || !isOutcomeCode(hhad.code)) {
    return { status: 'blocked', blockers: Array.from(new Set(blockers)), lineAudit };
  }

  const prediction: PredictionDetail = {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: serializeHandicapLine(boundLine),
    tipCode: hhad.code,
    tipLabel: {
      zh: getSimpleHandicapLabel(hhad.code, 'zh'),
      en: getSimpleHandicapLabel(hhad.code, 'en')
    },
    odds,
    trustScore: Math.round(probability * 100),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-companion-bound',
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING'
  };

  return { status: 'bound', blockers: [], prediction, lineAudit };
};

export const getListHandicapSupplement = (
  match: Match,
  language: Language,
  primaryPrediction?: PredictionDetail
): DisplayRecommendationCompanion | null => {
  const lineAudit = getHandicapLineResolution(match);
  const lineValue = lineAudit.line;
  if (lineValue === null) return null;
  const requiresVerifiedBinding = primaryPrediction?.recommendationAction === 'recommend'
    || Boolean(primaryPrediction?.livePublicationEvidence);
  const { hasHhad } = getAvailableResultPools(match);
  const referenceLineAvailable = !requiresVerifiedBinding && !lineAudit.official;
  if ((!hasHhad && !referenceLineAvailable) || primaryPrediction?.oddsPoolCode === 'HHAD') return null;

  const predictions = match.predictions || [];
  const pairedOutcomePrediction = getPairedOutcomePrediction(match, primaryPrediction);
  const sharesPrimaryRoute = (prediction?: PredictionDetail) => (
    !pairedOutcomePrediction
    || pairedOutcomePrediction.oddsPoolCode !== 'HAD'
    || !isOutcomeCode(pairedOutcomePrediction.tipCode)
    || prediction?.tipCode === pairedOutcomePrediction.tipCode
  );
  const bindingAudit = getDualMarketCompanionAudit(match, pairedOutcomePrediction);
  const boundHandicapPrediction = bindingAudit.status === 'bound' ? bindingAudit.prediction : undefined;
  // A verified dual-market record is one atomic HAD/HHAD pair. If the primary
  // direction no longer matches its HAD leg, fail the companion closed rather
  // than mixing an old HHAD leg with a different current/list direction.
  if (match.predictionMeta?.dualMarketDecision && !boundHandicapPrediction) return null;
  // The immutable formal/live lane must never fall through to a current model
  // recalculation when its dual-market binding is absent or invalid.
  if (requiresVerifiedBinding && !boundHandicapPrediction) return null;
  const handicapPrediction = boundHandicapPrediction
    || predictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && prediction.oddsPoolCode === 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  )) || predictions.find((prediction) => (
    prediction.oddsPoolCode === 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  ));

  if (handicapPrediction) {
    return sharesPrimaryRoute(handicapPrediction)
      ? buildHandicapCompanionFromPrediction(match, handicapPrediction, pairedOutcomePrediction, language)
      : null;
  }

  const read = getHandicapRead(match);
  const top = read.modelTop || read.marketTop;
  if (!top) return null;

  const displayCode = getCompatibleHandicapCode(match, pairedOutcomePrediction, top.code);
  const label = getSimpleHandicapLabel(displayCode, language);
  const probability = getHandicapOutcomeProbability(match, displayCode)
    ?? (displayCode === top.code && Number.isFinite(top.probability) ? Number(top.probability) : null);
  const support = displayCode === read.modelTop?.code ? read.marketSupport : getHandicapMarketSupport(match, displayCode);
  const priority = getHandicapCompanionPriority({
    handicapPrediction,
    primaryPrediction: pairedOutcomePrediction,
    probability,
    support,
    read,
    displayCode,
    lineValue
  });
  const prediction: PredictionDetail = {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: serializeHandicapLine(lineValue),
    tipCode: displayCode,
    tipLabel: { zh: getSimpleHandicapLabel(displayCode, 'zh'), en: getSimpleHandicapLabel(displayCode, 'en') },
    odds: getOutcomeOddsValue(match, 'HHAD', displayCode),
    trustScore: Math.round(probability || 0),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-companion',
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING'
  };

  if (!sharesPrimaryRoute(prediction)) return null;

  return {
    kind: 'handicap',
    priority,
    prediction,
    tipCode: displayCode,
    label,
    title: getHandicapCompanionTitle(label, language, priority),
    meta: `${formatHandicapLine(serializeHandicapLine(lineValue), language)}${lineAudit.official ? '' : (language === 'zh' ? ' · 参考让球线' : ' · Reference HHAD line')} · ${formatDisplayMeta(match, prediction, language)}`,
    probability,
    support,
    reason: pairedOutcomePrediction && isOutcomeCode(pairedOutcomePrediction.tipCode)
      ? getCompanionReason(match, pairedOutcomePrediction, displayCode, language)
      : getDisplayReasonForKind('handicap', language),
    lineAudit
  };
};

/**
 * A server-published analysis reference is already one complete public
 * identity. The client may not attach a second direction to it, even when a
 * dual-market audit record is present on the match; only an explicit
 * publishedRecommendation.companion from the formal/live publication lane is
 * eligible for display.
 */
export const getAnalysisReferenceHandicapSupplement = (
  match: Match,
  language: Language,
  primaryPrediction: PredictionDetail | undefined,
  referenceSource: string | undefined
): DisplayRecommendationCompanion | null => (
  referenceSource === 'published-reference'
    ? null
    : getListHandicapSupplement(match, language, primaryPrediction)
);

const getOneXTwoSupport = (match: Match, code: string | undefined, prediction?: PredictionDetail) => {
  if (!isOutcomeCode(code)) return null;
  const resolvedOdds = getOfficialMatchOdds(match);
  const probabilities = getImpliedProbabilities(
    prediction?.oddsPoolCode === 'HHAD'
      ? resolvedOdds.hhad?.odds
      : resolvedOdds.had?.odds
  );
  if (!probabilities) return null;
  return code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
};

const isPredictionPoolAvailable = (match: Match, prediction: PredictionDetail | undefined) => {
  return isFormalRecommendationPrediction(match, prediction);
};

const buildOutcomeReferencePrediction = (match: Match, code: OutcomeCode): PredictionDetail => ({
  marketType: '1X2',
  oddsPoolCode: 'HAD',
  tipCode: code,
  tipLabel: { zh: getSimpleOutcomeLabel(match, code, 'zh'), en: getSimpleOutcomeLabel(match, code, 'en') },
  odds: getOutcomeOddsValue(match, 'HAD', code),
  trustScore: Math.round(getOutcomeProbability(match, code) || 0),
  recommendationAction: 'reference',
  recommendationTier: 'reference',
  explanation: { zh: '', en: '' },
  visibilityStatus: 'FREE',
  resultStatus: 'PENDING'
});

const getPairedOutcomePrediction = (
  match: Match,
  primaryPrediction?: PredictionDetail
): PredictionDetail | undefined => {
  if (primaryPrediction && primaryPrediction.oddsPoolCode !== 'HHAD' && isOutcomeCode(primaryPrediction.tipCode)) {
    return primaryPrediction;
  }

  const storedOutcome = (match.predictions || []).find((prediction) => (
    prediction.marketType === '1X2'
    && prediction.oddsPoolCode !== 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  ));
  if (storedOutcome) return storedOutcome;

  const unified = match.probabilityModel?.unifiedPosterior;
  if (
    unified
    && (unified.selectedMarket === 'HAD' || unified.selectedMarket === '1X2')
    && isOutcomeCode(unified.selectedCode)
  ) {
    return buildOutcomeReferencePrediction(match, unified.selectedCode);
  }

  const outcomeTop = getTopOutcomeFromProbabilities(
    match.probabilityModel?.oneXTwo?.unifiedPosterior
      || match.probabilityModel?.oneXTwo?.final
      || match.probabilityModel?.oneXTwo?.scoreImplied
      || match.probabilityModel?.oneXTwo?.poisson
      || match.probabilityModel?.oneXTwo?.market
  );
  return outcomeTop ? buildOutcomeReferencePrediction(match, outcomeTop.code) : undefined;
};

const formatDisplayMeta = (
  match: Match,
  prediction: PredictionDetail | undefined,
  language: Language
) => {
  if (prediction && Number.isFinite(prediction.odds) && prediction.odds > 0) {
    return `${getPredictionValueLabel(prediction, language)} ${prediction.odds.toFixed(2)}`;
  }
  const modelProbability = formatCalibratedModelProbability(match, prediction);
  if (modelProbability) {
    return `${language === 'zh' ? '模型概率' : 'Model probability'} ${modelProbability}`;
  }
  const evidenceScore = formatEvidenceScore(prediction);
  if (evidenceScore !== '--') {
    return `${language === 'zh' ? '证据评分' : 'Evidence score'} ${evidenceScore}`;
  }
  return '--';
};

const getDisplayReasonForKind = (
  kind: DisplayRecommendationKind,
  language: Language
) => {
  const reasons: Record<DisplayRecommendationKind, Record<Language, string>> = {
    prediction: {
      zh: '按已开售玩法给出推荐，临场赔率变化时再复核。',
      en: 'Recommendation uses an on-sale market and should be rechecked against late odds.'
    },
    handicap: {
      zh: '胜平负未开售或不适合主推，本场直接看让球胜平负。',
      en: '1X2 is unavailable or weak, so this fixture uses the handicap result.'
    },
    outcome: {
      zh: '让球未开售时，按胜平负已开售玩法给出方向。',
      en: 'HHAD is unavailable, so the recommendation uses the on-sale 1X2 market.'
    },
    score: {
      zh: '比分只做推演，不作为胜负推荐。',
      en: 'Score heat is analysis only, not a result recommendation.'
    }
  };

  return reasons[kind][language];
};

export const getAvailableResultPools = (match: Match) => {
  const availability = getOfficialResultPoolAvailability(match);
  return {
    ...availability,
    hasHhad: availability.hasHhad && resolveHandicapLine(match) !== null
  };
};

const buildDisplayRecommendation = (
  match: Match,
  language: Language,
  promotedPrediction: PredictionDetail | undefined,
  publicationTrack: 'formal' | 'live'
): DisplayRecommendation | null => {
  if (!promotedPrediction || !isOutcomeCode(promotedPrediction.tipCode)) return null;
  if (publicationTrack === 'formal' && isHandicapMarketContradicted(match, promotedPrediction)) return null;

  const formalTipCode: OutcomeCode = promotedPrediction.tipCode;
  const publishedLiveOdds = Number(promotedPrediction.livePublicationEvidence?.officialSp);
  const officialOdds = publicationTrack === 'live' && Number.isFinite(publishedLiveOdds) && publishedLiveOdds > 1
    ? publishedLiveOdds
    : getOfficialRecommendationOdds(match, promotedPrediction);
  const formalHandicapLine = promotedPrediction.oddsPoolCode === 'HHAD'
    ? (publicationTrack === 'live'
      ? parseHandicapLine(promotedPrediction.livePublicationEvidence?.handicapLine)
      : resolveHandicapLine(match, promotedPrediction))
    : null;
  const formalPrediction = {
    ...promotedPrediction,
    odds: officialOdds,
    ...(formalHandicapLine !== null
      ? { handicapLine: serializeHandicapLine(formalHandicapLine) }
      : {})
  };
  const probability = getOutcomeProbability(match, formalTipCode, formalPrediction);
  const cleanProbability = Number.isFinite(probability) ? Number(probability) : null;
  const label = formalPrediction.oddsPoolCode === 'HHAD'
    ? getSimpleHandicapLabel(formalTipCode, language)
    : getSimpleOutcomeLabel(match, formalTipCode, language);
  const handicapRead = formalPrediction.oddsPoolCode === 'HHAD' ? getHandicapRead(match) : null;
  const companionAudit = formalPrediction.oddsPoolCode === 'HAD'
    ? getDualMarketCompanionAudit(match, formalPrediction)
    : { status: 'not-applicable' as const, blockers: [] };
  const companion = companionAudit.status === 'bound'
    ? buildHandicapCompanionFromPrediction(match, companionAudit.prediction, formalPrediction, language) || undefined
    : undefined;

  return {
    kind: 'prediction',
    publicationTrack,
    prediction: formalPrediction,
    tipCode: formalTipCode,
    label,
    meta: formatDisplayMeta(match, formalPrediction, language),
    probability: cleanProbability,
    support: getOneXTwoSupport(match, formalTipCode, formalPrediction),
    reason: formalPrediction.oddsPoolCode === 'HHAD' && isCloseHandicapDecision(handicapRead)
      ? getCloseHandicapReason(language)
      : getDisplayReasonForKind('prediction', language),
    companion,
    companionAudit
  };
};

export const getDisplayRecommendation = (match: Match, language: Language): DisplayRecommendation | null => (
  buildDisplayRecommendation(match, language, getFormalRecommendationPrediction(match), 'formal')
);

export const getLiveDisplayRecommendation = (match: Match, language: Language): DisplayRecommendation | null => (
  buildDisplayRecommendation(match, language, getLiveRecommendationPrediction(match), 'live')
);
