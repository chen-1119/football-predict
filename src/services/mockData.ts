// 足球预测数据 mock 服务

export interface MultiLangString {
  zh: string;
  en: string;
}

export interface Team {
  id: string;
  name: MultiLangString;
  shortName: MultiLangString;
  logo: string; // 队徽占位字符或CSS图形配色
  logoType?: 'flag' | 'crest' | 'crest-placeholder';
  value: string; // 球队身价，如 "1.2B €"
  color: string; // 队色，主色和副色，用于绘制炫酷队标
}

export interface League {
  id: string;
  name: MultiLangString;
  shortName: MultiLangString;
  countryId: string;
  isImportant: boolean; // 是否是核心/重要联赛
}

export interface Country {
  id: string;
  name: MultiLangString;
  flag: string; // 国旗Emoji
}

export interface Odds {
  odds1: number; // 胜 SP
  oddsX: number; // 平 SP
  odds2: number; // 负 SP
}

export interface PredictionDetail {
  marketType: '1X2' | 'GOALS' | 'GG_NG' | 'BEST';
  oddsPoolCode?: 'HAD' | 'HHAD';
  handicapLine?: string;
  tipCode: string; // 比如 '1', 'X', '2', '1X', 'X2', 'O1.5', 'O2.5', 'U2.5', 'GG', 'NG'
  tipLabel: MultiLangString;
  odds: number;
  trustScore: number; // 0-100
  explanation: MultiLangString;
  analysisItems?: MultiLangString[];
  riskTags?: MultiLangString[];
  visibilityStatus: 'FREE' | 'PREMIUM';
  resultStatus: 'WON' | 'LOST' | 'PENDING';
}

export interface MatchStats {
  xG: { home: number; away: number };
  possession: { home: number; away: number };
  shots: { home: number; away: number };
  shotsOnTarget: { home: number; away: number };
  corners: { home: number; away: number };
  fouls: { home: number; away: number };
  offsides: { home: number; away: number };
  yellowCards: { home: number; away: number };
  redCards: { home: number; away: number };
}

export interface ExternalMatchSignals {
  updatedAt?: string;
  source?: string;
  leagueName?: string;
  handicapLine?: string;
  injuries?: {
    home?: MultiLangString[];
    away?: MultiLangString[];
    summary?: MultiLangString;
  };
  lineups?: {
    homeFormation?: string;
    awayFormation?: string;
    summary?: MultiLangString;
  };
  weather?: {
    temperatureC?: number;
    condition?: MultiLangString;
    windKph?: number;
    summary?: MultiLangString;
  };
  referee?: {
    name?: string;
    cardsPerMatch?: number;
    penaltiesPerMatch?: number;
    summary?: MultiLangString;
  };
  expectedGoals?: {
    homeXg?: number;
    awayXg?: number;
    homeXga?: number;
    awayXga?: number;
    summary?: MultiLangString;
  };
  externalOdds?: {
    source?: string;
    odds1?: number;
    oddsX?: number;
    odds2?: number;
    summary?: MultiLangString;
  };
  bookmakerOdds?: {
    had?: Odds & { source?: string; updatedAt?: string };
    hhad?: Odds & { source?: string; handicapLine?: string; updatedAt?: string };
    apiFootball?: {
      source?: string;
      bookmaker?: string;
      bet?: string;
      updatedAt?: string;
      had?: Odds;
      summary?: MultiLangString;
    };
  };
  apiFootball?: {
    fixtureId?: number;
    leagueId?: number;
    leagueName?: string;
    season?: number;
    homeTeamId?: number;
    awayTeamId?: number;
    homeTeamName?: string;
    awayTeamName?: string;
    fixtureDate?: string;
    confidence?: number;
    matchedAt?: string | null;
    lastCheckedAt?: string;
  };
  fiveHundred?: {
    source?: string;
    updatedAt?: string;
    fixtureId?: string;
    infoMatchId?: string;
    matchNo?: string;
    sale?: {
      buyEndTime?: string;
      availability?: Record<string, boolean>;
    };
    rank?: {
      home?: {
        teamName?: string;
        fifaRank?: number | null;
        fifaPoints?: number | null;
        sampleMonth?: string | null;
      } | null;
      away?: {
        teamName?: string;
        fifaRank?: number | null;
        fifaPoints?: number | null;
        sampleMonth?: string | null;
      } | null;
    };
    recentForm?: {
      home?: {
        sampleSize?: number;
        record?: string;
        goalsForAvg?: number | null;
        goalsAgainstAvg?: number | null;
        over25Rate?: number | null;
        bttsRate?: number | null;
      } | null;
      away?: {
        sampleSize?: number;
        record?: string;
        goalsForAvg?: number | null;
        goalsAgainstAvg?: number | null;
        over25Rate?: number | null;
        bttsRate?: number | null;
      } | null;
    };
    futureSchedule?: {
      home?: { nextGapDays?: number | null } | null;
      away?: { nextGapDays?: number | null } | null;
    };
    europeOdds?: {
      companies?: number;
      currentAverage?: Odds | null;
      currentProbabilityAverage?: { home: number; draw: number; away: number } | null;
      summary?: string;
    };
    asianHandicap?: {
      companies?: number;
      currentAverageLine?: number | null;
      initialAverageLine?: number | null;
      lineMovement?: number | null;
      summary?: string;
    };
    marketConsensus?: {
      riskLevel?: 'low' | 'medium' | 'high' | string;
      homeProbabilityGap?: number | null;
      handicapLineGap?: number | null;
      notes?: string[];
    };
    macauTip?: {
      pick?: string | null;
      summary?: string;
    };
  };
}

export interface PredictionMeta {
  policyVersion?: string;
  promptVersion?: string;
  generatedAt?: string;
  updatedAt?: string;
  lockedAt?: string;
  snapshot?: {
    phase: 'baseline' | 'mid' | 'late' | 'final' | 'locked' | 'review';
    total: number;
    phases: Record<string, number>;
    latestAt?: string;
    latestSignature?: string;
  };
  dataPolicy?: MultiLangString;
  updateReason?: MultiLangString;
  forecastPlan?: {
    baseline: MultiLangString;
    late: MultiLangString;
    lock: MultiLangString;
    review: MultiLangString;
  };
}

export interface GptPredictionRecord {
  matchId: string;
  generatedAt: string;
  source?: string;
  relay?: {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    model?: string;
    parsed?: {
      summary?: string;
      probabilities?: {
        home?: number;
        draw?: number;
        away?: number;
        over25?: number;
        bttsYes?: number;
      };
      recommendation?: {
        market?: string;
        pick?: string;
        confidence?: number;
        risk?: string;
      };
      reasons?: string[];
      missingData?: string[];
      reviewPlan?: string;
    };
  };
}

export interface OutcomeProbability {
  home: number;
  draw: number;
  away: number;
}

export interface ScoreProbability {
  home: number;
  away: number;
  label: string;
  probability: number;
}

export interface MatchProbabilityModel {
  version: string;
  generatedAt?: string;
  basis: MultiLangString;
  ensembleWeights?: {
    market: number;
    elo: number;
    poisson: number;
  };
  dynamicCalibration?: {
    version: string;
    profileKey: string;
    gate: {
      minProbabilityBoost?: number;
      minModelGapBoost?: number;
      minHandicapSupportBoost?: number;
      trustPenalty?: number;
      maxRiskTags?: number;
      goalsMinBoost?: number;
      reason?: string;
    } | null;
    metrics: {
      oneXTwoBrier?: number | null;
      oneXTwoLogLoss?: number | null;
      oneXTwoHitRate?: number | null;
      goalsHitRate?: number | null;
      bestHitRate?: number | null;
    } | null;
  };
  calibrationAdjustment?: {
    oneXTwo?: {
      applied: boolean;
      reasons: string[];
      adjustments: Array<{
        code: string;
        reason: string;
        penalty: number;
      }>;
      before: OutcomeProbability | null;
      after: OutcomeProbability | null;
    };
    goals?: {
      applied: boolean;
      reasons: string[];
      shrinkFactor: number;
      before: {
        over25: number;
        btts: number;
      };
      after: {
        over25: number;
        btts: number;
      };
    } | null;
  };
  lambdaBlend?: {
    marketHomeLambda: number;
    marketAwayLambda: number;
    formHomeLambda: number | null;
    formAwayLambda: number | null;
    formWeight: number;
  };
  oneXTwo: {
    market: OutcomeProbability | null;
    elo?: OutcomeProbability | null;
    poisson: OutcomeProbability | null;
    final: OutcomeProbability | null;
  };
  elo?: {
    homeRating: number;
    awayRating: number;
    diff: number;
    homeMatches: number;
    awayMatches: number;
    lastUpdatedAt?: string;
  } | null;
  form?: {
    version: string;
    lookbackMatches: number;
    sampleSize: number;
    home: {
      sampleSize: number;
      wins: number;
      draws: number;
      losses: number;
      pointsPerMatch: number | null;
      goalsForAvg: number | null;
      goalsAgainstAvg: number | null;
      goalDiffAvg: number | null;
      over25Rate: number | null;
      bttsRate: number | null;
      cleanSheetRate: number | null;
      failedScoreRate: number | null;
      lastMatchAt?: string | null;
      restDays?: number | null;
      matchesLast14?: number;
      matchesLast30?: number;
    };
    away: {
      sampleSize: number;
      wins: number;
      draws: number;
      losses: number;
      pointsPerMatch: number | null;
      goalsForAvg: number | null;
      goalsAgainstAvg: number | null;
      goalDiffAvg: number | null;
      over25Rate: number | null;
      bttsRate: number | null;
      cleanSheetRate: number | null;
      failedScoreRate: number | null;
      lastMatchAt?: string | null;
      restDays?: number | null;
      matchesLast14?: number;
      matchesLast30?: number;
    };
    h2h: {
      sampleSize: number;
      over25Rate: number | null;
      bttsRate: number | null;
      drawRate: number | null;
      lastMeetingAt?: string | null;
    };
  } | null;
  modelHealth?: {
    version: string;
    total: PredictionHealthBucket;
    byMarket: Record<string, PredictionHealthBucket>;
    byTip?: Record<string, PredictionHealthBucket>;
    byProfile?: Record<string, PredictionHealthBucket>;
    byMarketProfile?: Record<string, PredictionHealthBucket>;
    byOddsBucket?: Record<string, PredictionHealthBucket>;
    oneXTwo?: {
      byTip?: Record<string, PredictionHealthBucket>;
      byProfile?: Record<string, PredictionHealthBucket>;
      byOddsBucket?: Record<string, PredictionHealthBucket>;
      lowSpSide?: PredictionHealthBucket;
    };
    goals?: {
      byTip?: Record<string, PredictionHealthBucket>;
      byProfile?: Record<string, PredictionHealthBucket>;
    };
    homeFavorite: PredictionHealthBucket;
    awayFavorite?: PredictionHealthBucket;
    lowSpSide?: PredictionHealthBucket;
    under25: PredictionHealthBucket;
  } | null;
  scoreDistribution: ScoreProbability[];
  goalLines: {
    over25: number;
    under25: number;
  };
  bothTeamsToScore: {
    yes: number;
    no: number;
  };
  handicap?: {
    line: string;
    market: OutcomeProbability | null;
    poisson: OutcomeProbability | null;
  } | null;
  calibration: {
    status: 'baseline' | 'calibrated' | 'backtesting';
    zh: string;
    en: string;
  };
}

export interface PredictionHealthBucket {
  settled: number;
  won: number;
  lost: number;
  hitRate: number | null;
  cooldown: boolean;
}

export interface H2HRecord {
  date: string;
  homeScore: number;
  awayScore: number;
  homeTeamId: string;
  awayTeamId: string;
  competition: MultiLangString;
}

export interface TeamRecentForm {
  recentMatches: {
    opponentId: string;
    opponentName: MultiLangString;
    isHome: boolean;
    ourScore: number;
    oppScore: number;
    date: string;
    competition: MultiLangString;
  }[];
  statsLast10: {
    wins: number;
    draws: number;
    losses: number;
    over1_5: number; // 大1.5场次比例 (%)
    over2_5: number; // 大2.5场次比例 (%)
    over3_5: number;
    bothToScore: number; // 双方进球比例 (%)
    upsetWins: number; // 爆冷胜利场次
    upsetLosses: number; // 爆冷失败场次
  };
}

export interface StandingRow {
  position: number;
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface Match {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  leagueId: string;
  countryId: string;
  kickoffTime: string; // ISO string
  status: 'SCHEDULED' | 'LIVE' | 'PENDING_RESULT' | 'FINISHED';
  scoreHome?: number;
  scoreAway?: number;
  projectedScoreHome?: number;
  projectedScoreAway?: number;
  oddsTrend?: {
    sampleSize: number;
    firstCapturedAt: string;
    lastCapturedAt: string;
    odds1Change: number;
    oddsXChange: number;
    odds2Change: number;
    direction: 'home' | 'draw' | 'away' | 'mixed' | 'flat';
    summary: MultiLangString;
  };
  odds?: Odds | null;
  handicapOdds?: Odds | null;
  handicapLine?: string;
  oddsSource?: string;
  oddsPoolCode?: string;
  oddsSourceMethod?: string;
  oddsUpdatedAt?: string;
  oddsSourceUrl?: string;
  handicapOddsSource?: string;
  handicapOddsPoolCode?: string;
  handicapOddsSourceMethod?: string;
  handicapOddsUpdatedAt?: string;
  handicapOddsSourceUrl?: string;
  predictions: PredictionDetail[];
  predictionMeta?: PredictionMeta;
  gptPrediction?: GptPredictionRecord;
  probabilityModel?: MatchProbabilityModel;
  stats?: MatchStats;
  externalSignals?: ExternalMatchSignals;
  recentForm?: {
    home: TeamRecentForm;
    away: TeamRecentForm;
  };
  h2h?: H2HRecord[];
  standings?: StandingRow[];
  matchDate?: string;
  kickoffDate?: string;
  businessDate?: string;
  homeTeamName?: string;
  homeTeamNameEn?: string;
  homeRank?: string;
  homeTeamLogo?: string;
  homeTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  homeTeamCountryIso?: string;
  homeTeamColor?: string;
  awayTeamName?: string;
  awayTeamNameEn?: string;
  awayRank?: string;
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
  source?: string;
  sourceMethod?: string;
  sourceUrl?: string;
  sourceMatchId?: string;
  matchNo?: string;
}

// 模拟的基础实体数据
export const countries: Country[] = [
  { id: 'eng', name: { zh: '英格兰', en: 'England' }, flag: '🇬🇧' },
  { id: 'esp', name: { zh: '西班牙', en: 'Spain' }, flag: '🇪🇸' },
  { id: 'deu', name: { zh: '德国', en: 'Germany' }, flag: '🇩🇪' },
  { id: 'ita', name: { zh: '意大利', en: 'Italy' }, flag: '🇮🇹' },
  { id: 'fra', name: { zh: '法国', en: 'France' }, flag: '🇫🇷' },
  { id: 'eur', name: { zh: '欧洲', en: 'Europe' }, flag: '🇪🇺' },
];

export const leagues: League[] = [
  { id: 'epl', name: { zh: '英格兰超级联赛', en: 'Premier League' }, shortName: { zh: '英超', en: 'EPL' }, countryId: 'eng', isImportant: true },
  { id: 'laliga', name: { zh: '西班牙甲级联赛', en: 'La Liga' }, shortName: { zh: '西甲', en: 'La Liga' }, countryId: 'esp', isImportant: true },
  { id: 'bundesliga', name: { zh: '德国甲级联赛', en: 'Bundesliga' }, shortName: { zh: '德甲', en: 'Bundesliga' }, countryId: 'deu', isImportant: true },
  { id: 'seriea', name: { zh: '意大利甲级联赛', en: 'Serie A' }, shortName: { zh: '意甲', en: 'Serie A' }, countryId: 'ita', isImportant: true },
  { id: 'ligue1', name: { zh: '法国甲级联赛', en: 'Ligue 1' }, shortName: { zh: '法甲', en: 'Ligue 1' }, countryId: 'fra', isImportant: true },
  { id: 'ucl', name: { zh: '欧洲冠军联赛', en: 'UEFA Champions League' }, shortName: { zh: '欧冠', en: 'UCL' }, countryId: 'eur', isImportant: true },
];

export const teams: Team[] = [
  // 英超
  { id: 'mci', name: { zh: '曼彻斯特城', en: 'Manchester City' }, shortName: { zh: '曼城', en: 'Man City' }, logo: 'MC', value: '1.27B €', color: '#6cabdd' },
  { id: 'liv', name: { zh: '利物浦', en: 'Liverpool' }, shortName: { zh: '利物浦', en: 'Liverpool' }, logo: 'LIV', value: '921M €', color: '#c8102e' },
  { id: 'ars', name: { zh: '阿森纳', en: 'Arsenal' }, shortName: { zh: '阿森纳', en: 'Arsenal' }, logo: 'ARS', value: '1.12B €', color: '#ef0107' },
  { id: 'che', name: { zh: '切尔西', en: 'Chelsea' }, shortName: { zh: '切尔西', en: 'Chelsea' }, logo: 'CHE', value: '960M €', color: '#034694' },
  { id: 'mun', name: { zh: '曼彻斯特联', en: 'Manchester United' }, shortName: { zh: '曼联', en: 'Man Utd' }, logo: 'MU', value: '858M €', color: '#da291c' },
  { id: 'tot', name: { zh: '托特纳姆热刺', en: 'Tottenham Hotspur' }, shortName: { zh: '热刺', en: 'Spurs' }, logo: 'TOT', value: '765M €', color: '#132257' },
  { id: 'cry', name: { zh: '水晶宫', en: 'Crystal Palace' }, shortName: { zh: '水晶宫', en: 'Crystal Palace' }, logo: 'CRY', value: '380M €', color: '#1b458f' },
  { id: 'avl', name: { zh: '阿斯顿维拉', en: 'Aston Villa' }, shortName: { zh: '维拉', en: 'Aston Villa' }, logo: 'AVL', value: '590M €', color: '#95bfe5' },
  
  // 西甲
  { id: 'rma', name: { zh: '皇家马德里', en: 'Real Madrid' }, shortName: { zh: '皇马', en: 'Real Madrid' }, logo: 'RMA', value: '1.34B €', color: '#ffffff' },
  { id: 'bar', name: { zh: '巴塞罗那', en: 'Barcelona' }, shortName: { zh: '巴萨', en: 'Barcelona' }, logo: 'FCB', value: '875M €', color: '#004d98' },
  { id: 'atm', name: { zh: '马德里竞技', en: 'Atlético Madrid' }, shortName: { zh: '马竞', en: 'Atlético' }, logo: 'ATM', value: '510M €', color: '#cb3524' },
  { id: 'rso', name: { zh: '皇家社会', en: 'Real Sociedad' }, shortName: { zh: '皇家社会', en: 'R. Sociedad' }, logo: 'RSO', value: '#10529d', color: '#10529d' },
  
  // 德甲
  { id: 'fcb', name: { zh: '拜仁慕尼黑', en: 'Bayern Munich' }, shortName: { zh: '拜仁', en: 'Bayern' }, logo: 'FCB', value: '970M €', color: '#dc052d' },
  { id: 'bvb', name: { zh: '多特蒙德', en: 'Borussia Dortmund' }, shortName: { zh: '多特', en: 'Dortmund' }, logo: 'BVB', value: '#fde100', color: '#fde100' },
  { id: 'b04', name: { zh: '勒沃库森', en: 'Bayer Leverkusen' }, shortName: { zh: '勒沃库森', en: 'Leverkusen' }, logo: 'B04', value: '620M €', color: '#e32219' },
  
  // 意甲
  { id: 'int', name: { zh: '国际米兰', en: 'Inter Milan' }, shortName: { zh: '国米', en: 'Inter' }, logo: 'INT', value: '670M €', color: '#0066b2' },
  { id: 'mil', name: { zh: 'AC米兰', en: 'AC Milan' }, shortName: { zh: 'AC米兰', en: 'AC Milan' }, logo: 'ACM', value: '530M €', color: '#d31018' },
  { id: 'juv', name: { zh: '尤文图斯', en: 'Juventus' }, shortName: { zh: '尤文', en: 'Juventus' }, logo: 'JUV', value: '580M €', color: '#000000' },
];

const BEIJING_TIME_ZONE = 'Asia/Shanghai';

export function formatBeijingDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const getPart = (type: string) => parts.find((part) => part.type === type)?.value || '';

  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
}

// 辅助函数，按中国竞彩网口径生成北京时间日期字符串 (YYYY-MM-DD)
export function getDateStringOffset(offsetDays: number): string {
  return formatBeijingDateString(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));
}

// 模拟的历史交锋数据源
const generateMockH2H = (hId: string, aId: string): H2HRecord[] => {
  return [
    { date: '2025-11-12', homeScore: 2, awayScore: 1, homeTeamId: hId, awayTeamId: aId, competition: { zh: '联赛', en: 'League' } },
    { date: '2025-04-18', homeScore: 1, awayScore: 1, homeTeamId: aId, awayTeamId: hId, competition: { zh: '联赛', en: 'League' } },
    { date: '2024-12-05', homeScore: 3, awayScore: 0, homeTeamId: hId, awayTeamId: aId, competition: { zh: '联赛', en: 'League' } },
    { date: '2024-03-20', homeScore: 1, awayScore: 2, homeTeamId: aId, awayTeamId: hId, competition: { zh: '杯赛', en: 'Cup' } },
    { date: '2023-10-22', homeScore: 0, awayScore: 2, homeTeamId: hId, awayTeamId: aId, competition: { zh: '联赛', en: 'League' } },
  ];
};

// 模拟的近期战绩
const generateMockForm = (): TeamRecentForm => {
  return {
    recentMatches: [
      { opponentId: 'opp1', opponentName: { zh: '对手A', en: 'Opponent A' }, isHome: true, ourScore: 2, oppScore: 1, date: '2026-05-20', competition: { zh: '联赛', en: 'League' } },
      { opponentId: 'opp2', opponentName: { zh: '对手B', en: 'Opponent B' }, isHome: false, ourScore: 3, oppScore: 2, date: '2026-05-15', competition: { zh: '联赛', en: 'League' } },
      { opponentId: 'opp3', opponentName: { zh: '对手C', en: 'Opponent C' }, isHome: true, ourScore: 0, oppScore: 1, date: '2026-05-10', competition: { zh: '欧战', en: 'UCL' } },
      { opponentId: 'opp4', opponentName: { zh: '对手D', en: 'Opponent D' }, isHome: false, ourScore: 1, oppScore: 1, date: '2026-05-06', competition: { zh: '联赛', en: 'League' } },
      { opponentId: 'opp5', opponentName: { zh: '对手E', en: 'Opponent E' }, isHome: true, ourScore: 4, oppScore: 0, date: '2026-05-01', competition: { zh: '联赛', en: 'League' } },
    ],
    statsLast10: {
      wins: 6,
      draws: 2,
      losses: 2,
      over1_5: 90,
      over2_5: 70,
      over3_5: 40,
      bothToScore: 60,
      upsetWins: 1,
      upsetLosses: 1
    }
  };
};

// 模拟的联赛积分榜数据
const generateMockStandings = (leagueId: string): StandingRow[] => {
  // 我们只用当前定义的几只球队简单排出积分榜
  const targetTeamIds = leagueId === 'epl'
    ? ['mci', 'ars', 'liv', 'che', 'avl', 'tot', 'mun', 'cry']
    : leagueId === 'laliga'
      ? ['rma', 'bar', 'atm', 'rso']
      : leagueId === 'bundesliga'
        ? ['fcb', 'b04', 'bvb']
        : leagueId === 'seriea'
          ? ['int', 'mil', 'juv']
          : ['mci', 'rma', 'fcb', 'liv', 'bar', 'int'];
  
  return targetTeamIds.map((tId, idx) => {
    const wins = 25 - idx * 2 - Math.floor(Math.random() * 2);
    const draws = 5 + Math.floor(Math.random() * 3);
    const losses = 38 - wins - draws;
    const played = 38;
    const goalsFor = 80 - idx * 5;
    const goalsAgainst = 25 + idx * 4;
    const points = wins * 3 + draws;
    
    return {
      position: idx + 1,
      teamId: tId,
      played,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      points
    };
  });
};

// 构建静态的比赛预测数据池，利用 offset 适配时间，每次重新渲染都是真实的昨天/今天/明天
const generateMatchPool = (): Match[] => {
  const pool: Match[] = [];
  
  // 我们设定一些经典的比赛组合
  const matchSchemes = [
    // 昨天 (已结束)
    { homeId: 'mci', awayId: 'cry', leagueId: 'epl', countryId: 'eng', timeOffset: -1, status: 'FINISHED' as const, score: [3, 1] as [number, number], odds: { odds1: 1.25, oddsX: 6.00, odds2: 11.00 } },
    { homeId: 'liv', awayId: 'che', leagueId: 'epl', countryId: 'eng', timeOffset: -1, status: 'FINISHED' as const, score: [2, 2] as [number, number], odds: { odds1: 1.85, oddsX: 3.80, odds2: 3.90 } },
    { homeId: 'rma', awayId: 'bar', leagueId: 'laliga', countryId: 'esp', timeOffset: -1, status: 'FINISHED' as const, score: [3, 2] as [number, number], odds: { odds1: 2.10, oddsX: 3.60, odds2: 3.20 } },
    { homeId: 'fcb', awayId: 'bvb', leagueId: 'bundesliga', countryId: 'deu', timeOffset: -1, status: 'FINISHED' as const, score: [4, 1] as [number, number], odds: { odds1: 1.45, oddsX: 4.80, odds2: 6.00 } },
    
    // 今天 (有些 LIVE 正在进行，有些即将开赛)
    { homeId: 'ars', awayId: 'mun', leagueId: 'epl', countryId: 'eng', timeOffset: 0, timeHour: '16:00', status: 'LIVE' as const, score: [1, 0] as [number, number], odds: { odds1: 1.65, oddsX: 4.00, odds2: 5.00 } },
    { homeId: 'tot', awayId: 'avl', leagueId: 'epl', countryId: 'eng', timeOffset: 0, timeHour: '19:30', status: 'SCHEDULED' as const, odds: { odds1: 2.20, oddsX: 3.50, odds2: 3.10 } },
    { homeId: 'atm', awayId: 'rso', leagueId: 'laliga', countryId: 'esp', timeOffset: 0, timeHour: '21:00', status: 'SCHEDULED' as const, odds: { odds1: 1.95, oddsX: 3.30, odds2: 4.20 } },
    { homeId: 'int', awayId: 'juv', leagueId: 'seriea', countryId: 'ita', timeOffset: 0, timeHour: '23:45', status: 'SCHEDULED' as const, odds: { odds1: 2.05, oddsX: 3.20, odds2: 3.90 } },
    
    // 明天 (即将开赛)
    { homeId: 'che', awayId: 'ars', leagueId: 'epl', countryId: 'eng', timeOffset: 1, timeHour: '15:00', status: 'SCHEDULED' as const, odds: { odds1: 3.40, oddsX: 3.60, odds2: 2.05 } },
    { homeId: 'bar', awayId: 'atm', leagueId: 'laliga', countryId: 'esp', timeOffset: 1, timeHour: '18:00', status: 'SCHEDULED' as const, odds: { odds1: 1.80, oddsX: 3.75, odds2: 4.30 } },
    { homeId: 'bvb', awayId: 'b04', leagueId: 'bundesliga', countryId: 'deu', timeOffset: 1, timeHour: '20:30', status: 'SCHEDULED' as const, odds: { odds1: 2.45, oddsX: 3.60, odds2: 2.70 } },
    { homeId: 'mil', awayId: 'int', leagueId: 'seriea', countryId: 'ita', timeOffset: 1, timeHour: '22:45', status: 'SCHEDULED' as const, odds: { odds1: 2.90, oddsX: 3.40, odds2: 2.40 } },

    // 后天与大后天 (投注单生成器可用)
    { homeId: 'liv', awayId: 'tot', leagueId: 'epl', countryId: 'eng', timeOffset: 2, timeHour: '15:00', status: 'SCHEDULED' as const, odds: { odds1: 1.55, oddsX: 4.50, odds2: 5.25 } },
    { homeId: 'rma', awayId: 'rso', leagueId: 'laliga', countryId: 'esp', timeOffset: 2, timeHour: '18:00', status: 'SCHEDULED' as const, odds: { odds1: 1.35, oddsX: 5.00, odds2: 8.50 } },
    { homeId: 'juv', awayId: 'mil', leagueId: 'seriea', countryId: 'ita', timeOffset: 2, timeHour: '20:30', status: 'SCHEDULED' as const, odds: { odds1: 2.15, oddsX: 3.25, odds2: 3.50 } },
    { homeId: 'mun', awayId: 'avl', leagueId: 'epl', countryId: 'eng', timeOffset: 3, timeHour: '15:00', status: 'SCHEDULED' as const, odds: { odds1: 2.10, oddsX: 3.55, odds2: 3.30 } },
    { homeId: 'fcb', awayId: 'b04', leagueId: 'bundesliga', countryId: 'deu', timeOffset: 3, timeHour: '18:00', status: 'SCHEDULED' as const, odds: { odds1: 1.70, oddsX: 4.10, odds2: 4.50 } },
  ];

  matchSchemes.forEach((scheme, index) => {
    // 构造时间
    const dateStr = getDateStringOffset(scheme.timeOffset);
    const timeStr = scheme.timeHour ? `T${scheme.timeHour}:00Z` : 'T18:00:00Z';
    const kickoff = new Date(`${dateStr}${timeStr}`).toISOString();

    const homeTeam = teams.find(t => t.id === scheme.homeId)!;
    const awayTeam = teams.find(t => t.id === scheme.awayId)!;
    const sfpPicks = [
      { code: '1', odds: scheme.odds.odds1, zh: `主胜 ${homeTeam.shortName.zh}`, en: `Home Win (${homeTeam.shortName.en})` },
      { code: 'X', odds: scheme.odds.oddsX, zh: '平局', en: 'Draw' },
      { code: '2', odds: scheme.odds.odds2, zh: `客胜 ${awayTeam.shortName.zh}`, en: `Away Win (${awayTeam.shortName.en})` }
    ].sort((a, b) => a.odds - b.odds);
    const sfpPick = sfpPicks[0];
    const totalGoalsPick = scheme.score ? Math.min(scheme.score[0] + scheme.score[1], 7) : 3 + (index % 2);
    const totalGoalsCode = totalGoalsPick >= 7 ? '7+' : String(totalGoalsPick);

    // 默认预测详情
    const predictions: PredictionDetail[] = [
      {
        marketType: '1X2',
        tipCode: sfpPick.code,
        tipLabel: {
          zh: sfpPick.zh,
          en: sfpPick.en
        },
        odds: sfpPick.odds,
        trustScore: Math.floor(60 + Math.random() * 30),
        explanation: {
          zh: `基于胜平负 SP，当前倾向为 ${sfpPick.zh}。模型同时参考赛程状态、主客场和近期攻防数据。`,
          en: `${homeTeam.shortName.en} has been dominant at home recently, with key attackers in red-hot form. On the other hand, ${awayTeam.shortName.en} is struggling with defensive issues. We expect the stronger side to secure all three points.`
        },
        visibilityStatus: 'FREE',
        resultStatus: scheme.status === 'FINISHED' ? 'WON' : 'PENDING'
      },
      {
        marketType: 'GOALS',
        tipCode: totalGoalsCode,
        tipLabel: { zh: totalGoalsCode === '7+' ? '总进球数 7+' : `总进球数 ${totalGoalsCode}球`, en: totalGoalsCode === '7+' ? 'Total Goals 7+' : `Total Goals ${totalGoalsCode}` },
        odds: 1.68 + (index % 5) * 0.05,
        trustScore: Math.floor(55 + Math.random() * 35),
        explanation: {
          zh: '总进球数参考来自胜平负 SP、双方近期进失球和节奏模型。',
          en: 'Both teams play open offensive football. Their recent matches have seen plenty of goals, making the Over 2.5 market highly viable.'
        },
        visibilityStatus: 'PREMIUM', // 高级预测锁定
        resultStatus: scheme.status === 'FINISHED' ? (scheme.score && (totalGoalsCode === '7+' ? scheme.score[0] + scheme.score[1] >= 7 : scheme.score[0] + scheme.score[1] === Number(totalGoalsCode)) ? 'WON' : 'LOST') : 'PENDING'
      },
      {
        marketType: 'GG_NG',
        tipCode: 'GG',
        tipLabel: { zh: '双方进球 是', en: 'Both Teams to Score' },
        odds: 1.75 + (index % 3) * 0.08,
        trustScore: Math.floor(58 + Math.random() * 30),
        explanation: {
          zh: '两队前锋线效率极高，且防守并非铜墙铁壁，双方均取得进球的概率较大。',
          en: 'Both frontlines are highly efficient, while defensive clean sheets are rare for either side. GG is highly probable.'
        },
        visibilityStatus: 'PREMIUM',
        resultStatus: scheme.status === 'FINISHED' ? (scheme.score && scheme.score[0] > 0 && scheme.score[1] > 0 ? 'WON' : 'LOST') : 'PENDING'
      }
    ];

    // 添加 Best Tip (这在 Nerdytips 是最核心最亮眼的推荐)
    // 根据 SP 与可信度综合生成一个
    const bestChoice = predictions[0].trustScore > 75 ? predictions[0] : (predictions[1].trustScore > predictions[2].trustScore ? predictions[1] : predictions[2]);
    
    // 克隆并置为 Best
    predictions.push({
      marketType: 'BEST',
      tipCode: bestChoice.tipCode,
      tipLabel: {
        zh: `模型首选 ${bestChoice.tipLabel.zh}`,
        en: `Best: ${bestChoice.tipLabel.en}`
      },
      odds: bestChoice.odds,
      trustScore: Math.min(99, bestChoice.trustScore + 2), // Best Tip 信度偏高一点点
      explanation: {
        zh: `【AI 精选】这是本场比赛数学模型跑出的最高价值推荐。结合了两队伤停、战意和 SP 倾斜，防守兜底极佳。`,
        en: `[AI Choice] This is the highest-value recommendation computed by our model for this match. Balanced for form, motivation, and line movements.`
      },
      visibilityStatus: 'PREMIUM', // Best Tip 活跃比赛需要是 Premium
      resultStatus: bestChoice.resultStatus
    });

    // 统计数据
    const stats: MatchStats = {
      xG: { home: parseFloat((1.2 + Math.random() * 1.5).toFixed(2)), away: parseFloat((0.8 + Math.random() * 1.2).toFixed(2)) },
      possession: { home: Math.floor(45 + Math.random() * 20), away: 0 }, // 会在下面动态补足 away
      shots: { home: Math.floor(10 + Math.random() * 10), away: Math.floor(7 + Math.random() * 8) },
      shotsOnTarget: { home: Math.floor(3 + Math.random() * 5), away: Math.floor(2 + Math.random() * 4) },
      corners: { home: Math.floor(3 + Math.random() * 7), away: Math.floor(2 + Math.random() * 6) },
      fouls: { home: Math.floor(8 + Math.random() * 7), away: Math.floor(9 + Math.random() * 6) },
      offsides: { home: Math.floor(Math.random() * 4), away: Math.floor(Math.random() * 4) },
      yellowCards: { home: Math.floor(Math.random() * 4), away: Math.floor(Math.random() * 5) },
      redCards: { home: Math.random() > 0.9 ? 1 : 0, away: Math.random() > 0.92 ? 1 : 0 },
    };
    stats.possession.away = 100 - stats.possession.home;

    pool.push({
      id: `match_${index + 1}`,
      homeTeamId: scheme.homeId,
      awayTeamId: scheme.awayId,
      leagueId: scheme.leagueId,
      countryId: scheme.countryId,
      kickoffTime: kickoff,
      status: scheme.status,
      scoreHome: scheme.score ? scheme.score[0] : ((scheme.status as string) === 'LIVE' ? 1 : undefined),
      scoreAway: scheme.score ? scheme.score[1] : ((scheme.status as string) === 'LIVE' ? 0 : undefined),
      odds: scheme.odds,
      predictions,
      stats,
      recentForm: {
        home: generateMockForm(),
        away: generateMockForm()
      },
      h2h: generateMockH2H(scheme.homeId, scheme.awayId),
      standings: generateMockStandings(scheme.leagueId)
    });
  });

  return pool;
};

export const matchesPool = generateMatchPool();

// 获取某天的比赛
export const getMatchesByDate = (dateStr: string): Match[] => {
  return matchesPool.filter(m => m.kickoffTime.startsWith(dateStr));
};

// 全局投注术语
export const bettingGlossary = [
  { term: '主胜', name: { zh: '主队胜（代码3）', en: 'Home Win' }, desc: { zh: '竞彩足球胜平负选项，表示主队在全场90分钟（含伤停补时）内获胜；官方赛果代码为 3。', en: 'The home team wins in regular time.' } },
  { term: '平局', name: { zh: '平局（代码1）', en: 'Draw' }, desc: { zh: '竞彩足球胜平负选项，表示比赛在全场90分钟（含伤停补时）结束时为平局；官方赛果代码为 1。', en: 'The match ends in a draw in regular time.' } },
  { term: '客胜', name: { zh: '客队胜（代码0）', en: 'Away Win' }, desc: { zh: '竞彩足球胜平负选项，表示主队在全场90分钟（含伤停补时）内告负，也就是客队获胜；官方赛果代码为 0。', en: 'The away team wins in regular time.' } },
  { term: 'SP', name: { zh: '固定奖金指数', en: 'Starting Price' }, desc: { zh: '页面中的胜平负 SP 来自官方竞彩数据源或其同步快照，表示对应选项的固定奖金指数。', en: 'Displayed odds value for the selected market.' } },
  { term: '总进球数', name: { zh: '0/1/2/3/4/5/6/7+', en: 'Total Goals' }, desc: { zh: '预测全场90分钟（含伤停补时）主客队进球数之和，竞彩常见选项为 0、1、2、3、4、5、6、7+。', en: 'Predict the total number of goals in regular time.' } },
];

export function registerTeam(t: Team) {
  if (!teams.some(existing => existing.id === t.id)) {
    teams.push(t);
  }
}

export function registerLeague(l: League) {
  if (!leagues.some(existing => existing.id === l.id)) {
    leagues.push(l);
  }
}

export function registerCountry(c: Country) {
  if (!countries.some(existing => existing.id === c.id)) {
    countries.push(c);
  }
}
