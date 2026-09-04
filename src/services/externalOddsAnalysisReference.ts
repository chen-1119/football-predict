export const EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION = 'external-odds-analysis-reference-v5';
export const EXTERNAL_ODDS_MIN_LEADER_GAP = 0.08;
// In a three-way football market a clear leader does not need an absolute
// majority. Keep the fallback selective by requiring both a 40% de-vigged
// share and an eight-point lead over the runner-up.
export const EXTERNAL_ODDS_MIN_LEADER_PROBABILITY = 0.40;
export const OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS = 20 * 60 * 1000;

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
  predictionMeta?: {
    cutoffTime?: unknown;
  } | null;
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
  label: {
    zh: string;
    en: string;
  };
}

export interface ExternalOddsHandicapRisk {
  code: 'avoid-handicap';
  severity: 'high';
  label: {
    zh: '不碰让球';
    en: 'Avoid handicap';
  };
  reason: {
    zh: string;
    en: string;
  };
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
    label: {
      zh: '500网非官方赔率';
      en: '500.com non-official odds';
    };
  };
  sourceUpdatedAt?: string;
  sourceOdds: {
    odds1: number;
    oddsX: number;
    odds2: number;
  };
  selectedSourceOdds: number;
  deviggedProbabilities: ExternalOddsProbabilitySet;
  leaderProbability: number;
  runnerUpProbability: number;
  leaderGap: number;
  minimumLeaderGap: typeof EXTERNAL_ODDS_MIN_LEADER_GAP;
  minimumLeaderProbability: typeof EXTERNAL_ODDS_MIN_LEADER_PROBABILITY;
  handicapRisk: ExternalOddsHandicapRisk | null;
  notice: {
    zh: string;
    en: string;
  };
  executable: false;
  formalEligible: false;
  liveEligible: false;
  betSlipEligible: false;
}

interface ValidOddsTriplet {
  odds1: number;
  oddsX: number;
  odds2: number;
}

interface OddsCandidate {
  odds: ValidOddsTriplet;
  source: string;
  updatedAt?: string;
}

interface RankedDirection {
  code: ExternalOddsDirectionCode;
  probability: number;
}

const DIRECTION_LABELS: Record<ExternalOddsDirectionCode, ExternalOddsDirection['label']> = {
  '1': { zh: '主胜', en: 'Home win' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away win' },
};

const rounded = (value: number) => Number(value.toFixed(6));

const sourceText = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const isFiveHundredPoolSource = (value: unknown, pool: 'HAD' | 'HHAD') => {
  const normalized = sourceText(value).toLowerCase();
  return normalized === '500.com:jczq'
    || normalized === `500.com:${pool.toLowerCase()}`
    || normalized.startsWith(`500.com:${pool.toLowerCase()}:`);
};

const isOfficialHadSource = (value: unknown) => sourceText(value).toLowerCase().startsWith('sporttery:had');

const validOddsTriplet = (value: ExternalOddsTripletInput | null | undefined): ValidOddsTriplet | null => {
  if (!value) return null;
  const odds = [value.odds1, value.oddsX, value.odds2];
  if (!odds.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 1)) return null;
  return {
    odds1: value.odds1 as number,
    oddsX: value.oddsX as number,
    odds2: value.odds2 as number,
  };
};

const parseTimestamp = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  return Date.parse(value);
};

const parseHandicapLine = (value: unknown): string | number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/\uFF0B/g, '+')
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
  const match = normalized.match(/^(?:(?:让球|HHAD|handicap)\s*[:：]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*球)?$/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) ? line : null;
};

const direction = (code: ExternalOddsDirectionCode): ExternalOddsDirection => ({
  code,
  label: { ...DIRECTION_LABELS[code] },
});

const devig = (odds: ValidOddsTriplet) => {
  const inverseHome = 1 / odds.odds1;
  const inverseDraw = 1 / odds.oddsX;
  const inverseAway = 1 / odds.odds2;
  const inverseTotal = inverseHome + inverseDraw + inverseAway;
  const probabilities = {
    home: inverseHome / inverseTotal,
    draw: inverseDraw / inverseTotal,
    away: inverseAway / inverseTotal,
  };
  const ranked: RankedDirection[] = [
    { code: '1', probability: probabilities.home },
    { code: 'X', probability: probabilities.draw },
    { code: '2', probability: probabilities.away },
  ];
  ranked.sort((left, right) => right.probability - left.probability);
  return { probabilities, ranked };
};

const fiveHundredCandidate = (
  odds: ExternalOddsTripletInput | null | undefined,
  source: unknown,
  pool: 'HAD' | 'HHAD',
  updatedAt?: unknown,
): OddsCandidate | null => {
  if (!isFiveHundredPoolSource(source, pool)) return null;
  const validOdds = validOddsTriplet(odds);
  if (!validOdds) return null;
  const normalizedUpdatedAt = sourceText(updatedAt ?? odds?.updatedAt);
  return {
    odds: validOdds,
    source: sourceText(source),
    ...(normalizedUpdatedAt ? { updatedAt: normalizedUpdatedAt } : {}),
  };
};

const hasFreshOfficialHadSource = (match: ExternalOddsAnalysisMatchInput, now: number) => {
  const externalSignals = match.externalSignals;
  const candidates = [
    {
      odds: match.odds,
      source: match.oddsSource,
      updatedAt: match.oddsUpdatedAt ?? match.odds?.updatedAt,
    },
    {
      odds: externalSignals?.bookmakerOdds?.had,
      source: externalSignals?.bookmakerOdds?.had?.source,
      updatedAt: externalSignals?.bookmakerOdds?.had?.updatedAt,
    },
    {
      odds: externalSignals?.externalOdds,
      source: externalSignals?.externalOdds?.source,
      updatedAt: externalSignals?.externalOdds?.updatedAt,
    },
  ];
  return candidates.some((candidate) => {
    if (!isOfficialHadSource(candidate.source) || !validOddsTriplet(candidate.odds)) return false;
    const observedAt = parseTimestamp(candidate.updatedAt);
    return Number.isFinite(observedAt)
      && observedAt <= now + 5 * 60 * 1000
      && now - observedAt <= OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS;
  });
};

const selectHadCandidate = (match: ExternalOddsAnalysisMatchInput): OddsCandidate | null => {
  const externalSignals = match.externalSignals;
  const inheritedSource = externalSignals?.source;
  const inheritedUpdatedAt = externalSignals?.updatedAt;
  const candidates = [
    fiveHundredCandidate(match.odds, match.oddsSource, 'HAD', match.oddsUpdatedAt ?? match.odds?.updatedAt),
    fiveHundredCandidate(
      externalSignals?.bookmakerOdds?.had,
      externalSignals?.bookmakerOdds?.had?.source || inheritedSource,
      'HAD',
      externalSignals?.bookmakerOdds?.had?.updatedAt || inheritedUpdatedAt,
    ),
    fiveHundredCandidate(
      externalSignals?.externalOdds,
      isFiveHundredPoolSource(externalSignals?.externalOdds?.source, 'HAD')
        ? externalSignals?.externalOdds?.source
        : inheritedSource,
      'HAD',
      externalSignals?.externalOdds?.updatedAt || inheritedUpdatedAt,
    ),
  ];
  return candidates
    .filter((candidate): candidate is OddsCandidate => candidate !== null)
    .sort((left, right) => {
      const leftUpdatedAt = parseTimestamp(left.updatedAt);
      const rightUpdatedAt = parseTimestamp(right.updatedAt);
      const leftHasClock = Number.isFinite(leftUpdatedAt);
      const rightHasClock = Number.isFinite(rightUpdatedAt);
      if (leftHasClock && rightHasClock) return rightUpdatedAt - leftUpdatedAt;
      if (leftHasClock) return -1;
      if (rightHasClock) return 1;
      return 0;
    })[0] ?? null;
};

const selectHhadRisk = (
  match: ExternalOddsAnalysisMatchInput,
  hadLeaderCode: ExternalOddsDirectionCode,
): ExternalOddsHandicapRisk | null => {
  const bookmakerHhad = match.externalSignals?.bookmakerOdds?.hhad;
  const inheritedSource = match.externalSignals?.source;
  const inheritedUpdatedAt = match.externalSignals?.updatedAt;
  const candidates = [
    {
      candidate: fiveHundredCandidate(
        match.handicapOdds,
        match.handicapOddsSource,
        'HHAD',
        match.handicapOddsUpdatedAt ?? match.handicapOdds?.updatedAt,
      ),
      line: parseHandicapLine(match.handicapLine ?? match.handicapOdds?.handicapLine),
    },
    {
      candidate: fiveHundredCandidate(
        bookmakerHhad,
        bookmakerHhad?.source || inheritedSource,
        'HHAD',
        bookmakerHhad?.updatedAt || inheritedUpdatedAt,
      ),
      line: parseHandicapLine(bookmakerHhad?.handicapLine),
    },
  ];
  const selected = candidates.find((entry) => entry.candidate !== null && entry.line !== null);
  if (!selected?.candidate || selected.line === null) return null;

  const hhad = devig(selected.candidate.odds);
  const hhadLeader = hhad.ranked[0];
  if (!hhadLeader || hhadLeader.code === hadLeaderCode) return null;

  return {
    code: 'avoid-handicap',
    severity: 'high',
    label: { zh: '不碰让球', en: 'Avoid handicap' },
    reason: {
      zh: `500网让球盘首位方向${DIRECTION_LABELS[hhadLeader.code].zh}与胜平负强势方向${DIRECTION_LABELS[hadLeaderCode].zh}冲突，仅提示回避让球。`,
      en: `The 500.com handicap leader (${DIRECTION_LABELS[hhadLeader.code].en}) conflicts with the HAD leader (${DIRECTION_LABELS[hadLeaderCode].en}); avoid the handicap market.`,
    },
    handicapLine: selected.line,
    hhadDirection: direction(hhadLeader.code),
    deviggedProbabilities: {
      home: rounded(hhad.probabilities.home),
      draw: rounded(hhad.probabilities.draw),
      away: rounded(hhad.probabilities.away),
    },
  };
};

/**
 * Builds a non-executable, pre-match analysis reference from non-official
 * 500.com HAD odds. It intentionally omits every field consumed by the formal,
 * live, and bet-slip recommendation gates.
 */
export const buildExternalOddsAnalysisReference = (
  match: ExternalOddsAnalysisMatchInput | null | undefined,
  now = Date.now(),
): ExternalOddsAnalysisReference | null => {
  if (!match || match.status !== 'SCHEDULED' || match.resultDisposition === 'VOID' || !Number.isFinite(now)) return null;

  const kickoffAt = parseTimestamp(match.kickoffTime);
  if (!Number.isFinite(kickoffAt) || now >= kickoffAt) return null;
  const cutoffs = [
    parseTimestamp(match.predictionMeta?.cutoffTime),
    parseTimestamp(match.buyEndTime),
    kickoffAt,
  ].filter(Number.isFinite);
  const cutoffAt = Math.min(...cutoffs);
  if (now >= cutoffAt || hasFreshOfficialHadSource(match, now)) return null;

  const candidate = selectHadCandidate(match);
  if (!candidate) return null;
  const had = devig(candidate.odds);
  const leader = had.ranked[0];
  const runnerUp = had.ranked[1];
  if (!leader || !runnerUp) return null;
  const leaderGap = leader.probability - runnerUp.probability;
  if (leader.probability + Number.EPSILON < EXTERNAL_ODDS_MIN_LEADER_PROBABILITY) return null;
  if (leaderGap + Number.EPSILON < EXTERNAL_ODDS_MIN_LEADER_GAP) return null;

  const selectedSourceOdds = leader.code === '1'
    ? candidate.odds.odds1
    : leader.code === 'X'
      ? candidate.odds.oddsX
      : candidate.odds.odds2;

  return {
    version: EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION,
    kind: 'external-odds-analysis-reference',
    referenceAction: 'reference',
    publicationTrack: 'analysis-only',
    statisticsTrack: 'analysis-only',
    market: 'HAD',
    tipCode: leader.code,
    hadDirection: direction(leader.code),
    source: {
      provider: '500.com',
      official: false,
      rawSource: candidate.source,
      label: {
        zh: '500网非官方赔率',
        en: '500.com non-official odds',
      },
    },
    ...(candidate.updatedAt ? { sourceUpdatedAt: candidate.updatedAt } : {}),
    sourceOdds: { ...candidate.odds },
    selectedSourceOdds,
    deviggedProbabilities: {
      home: rounded(had.probabilities.home),
      draw: rounded(had.probabilities.draw),
      away: rounded(had.probabilities.away),
    },
    leaderProbability: rounded(leader.probability),
    runnerUpProbability: rounded(runnerUp.probability),
    leaderGap: rounded(leaderGap),
    minimumLeaderGap: EXTERNAL_ODDS_MIN_LEADER_GAP,
    minimumLeaderProbability: EXTERNAL_ODDS_MIN_LEADER_PROBABILITY,
    handicapRisk: selectHhadRisk(match, leader.code),
    notice: {
      zh: '非官方500网赔率用于数据补充推荐；独立复盘，不并入正式推荐、实时推荐或串关。',
      en: 'Non-official 500.com odds support a separate data-pick track; reviewed independently and excluded from formal picks, live picks, and bet slips.',
    },
    executable: false,
    formalEligible: false,
    liveEligible: false,
    betSlipEligible: false,
  };
};
