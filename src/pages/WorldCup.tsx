import React, { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  Flag,
  Gauge,
  Medal,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  Users,
  Zap
} from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { WorldCupLastDance } from '../components/WorldCupLastDance';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getSportteryPoolRows, type SportteryOddsPoolDisplay } from '../services/bettingDisplay';
import { getDisplayRecommendation, getMatchDisplayTeam as getDisplayTeam } from '../services/displayRecommendation';
import { getLeagueById, getTeamById } from '../services/entities';
import type { Match, MultiLangString, Team } from '../services/mockData';
import { WORLD_CUP_DATASET_SAFETY } from '../services/worldCupDatasetSafety';
import {
  formatCalibratedModelProbability,
  formatEvidenceScore,
  isFormalPresentationAllowed
} from '../services/predictionPresentation';
import {
  getAnalysisReferencePrediction,
  getDaysUntilWorldCup,
  getWorldCupCurrentOfficialStage,
  getWorldCupContenders,
  getWorldCupFixtureForecast,
  getWorldCupGroupForecasts,
  getWorldCupKnockoutForecast,
  getWorldCupLiveGroupStandings,
  getWorldCupRound32Pairings,
  getWorldCupRecentResults,
  getWorldCupOfficialMatchNumber,
  getWorldCupStandingQualifiers,
  getWorldCupUpsetRadar,
  getWorldCupWatchMatches,
  isWorldCupRelevantMatch,
  WORLD_CUP_CONTENT_LANES,
  WORLD_CUP_FORECAST_MODEL,
  WORLD_CUP_KNOCKOUT_ROUNDS,
  WORLD_CUP_OFFICIAL,
  WORLD_CUP_PIPELINE_CARDS,
  WORLD_CUP_STAGE_CARDS,
  type WorldCupGroupForecast,
  type WorldCupRound32Pairing,
  type WorldCupStandingTeam,
  type WorldCupTeamForecast
} from '../services/worldCupData';

interface WorldCupProps {
  onSelectMatch: (matchId: string) => void;
}

type Locale = 'zh' | 'en';

const copy = {
  kicker: { zh: '2026 诸神黄昏', en: 'World Cup 2026' },
  heroTitle: { zh: '世界因足球而沸腾', en: 'Football Unites The World' },
  heroSubtitle: {
    zh: '热爱不分国界，荣耀即将开战。诸神黄昏的最后一舞，新王加冕的第一步，都在这张赛前看板里。',
    en: 'Passion has no borders. Glory is about to begin, with one last dance for legends and a first step for the next era.'
  },
  countdown: { zh: '距开赛', en: 'Kickoff in' },
  days: { zh: '天', en: 'days' },
  kpis: {
    teams: { zh: '参赛队', en: 'Teams' },
    matches: { zh: '总场次', en: 'Matches' },
    groups: { zh: '小组', en: 'Groups' },
    venues: { zh: '举办城市/球场', en: 'Venues' },
    sporttery: { zh: '竞彩开售场次', en: 'Sporttery Fixtures' },
    update: { zh: '数据刷新', en: 'Data Refresh' }
  },
  stage: { zh: '赛制与阶段', en: 'Format & Stages' },
  stageDesc: { zh: '按官方 48 队赛制展示：12 组小组赛，前二直通，8 个最佳第三名补进 32 强。', en: '48 teams, 12 groups, top two plus eight best third-place teams to the Round of 32.' },
  model: { zh: '路径推演', en: 'Route Projection' },
  groups: { zh: '小组赛预测', en: 'Group Forecasts' },
  groupsDesc: { zh: '使用球队强度、东道主加成、新军降权和小组全局竞争进行路径推演；世界杯赔率上线后进入单场分析，只有通过完整门槛才会成为正式推荐。', en: 'Uses team strength, host boost, debutant adjustment and full-group competition; released odds enter match analysis, and only the full gate creates a formal pick.' },
  bestThird: { zh: '最佳第三名竞争线', en: 'Best Third-Place Lane' },
  bestThirdNote: { zh: '第三名不是固定晋级，按积分、净胜球、进球数和强度排序抢 8 个名额。', en: 'Third-place teams compete for eight spots by points, goal difference, goals and strength.' },
  knockout: { zh: '淘汰赛路线', en: 'Knockout Route' },
  knockoutDesc: { zh: '先用小组路径生成 32 强候选，再估算 16 强、8 强、4 强、决赛和冠军层级。', en: 'Group projections seed the Round of 32, then estimate later-round paths.' },
  fixtures: { zh: '世界杯竞彩场次', en: 'World Cup Sporttery Fixtures' },
  fixturesDesc: { zh: '只展示世界杯正赛窗口内的竞彩场次；未开售时保留赛制与路径预测，开售后接入赔率、让球和临场变化。', en: 'Only released tournament fixtures are shown here; odds and handicap join after release.' },
  noFixtures: { zh: '当前还没有已开售的世界杯正赛竞彩场次；页面先展示赛制、小组路径和淘汰赛推演，开售后会自动出现单场卡片。', en: 'No released World Cup Sporttery fixtures yet. Format and route projections remain visible until odds are available.' },
  contenders: { zh: '争冠观察', en: 'Contender Watch' },
  upset: { zh: '爆冷雷达', en: 'Upset Radar' },
  dataStatus: { zh: '数据覆盖', en: 'Data Coverage' },
  dataStatusDesc: { zh: '已覆盖世界杯结构、小组路径、晋级规则、淘汰赛路线和当前竞彩场次；官方赔率、让球、赛果、临场赔率在开售/完场后并入。', en: 'Covers structure, group pathing, rules, knockout routes and released fixtures.' },
  pipeline: { zh: '专题数据流', en: 'Data Pipeline' },
  recent: { zh: '赛果复盘', en: 'Recent Reviews' },
  more: { zh: '查看详情', en: 'Details' },
  noRecent: { zh: '世界杯正赛尚未产生可复盘赛果。', en: 'No tournament results to review yet.' },
  evidenceScore: { zh: '证据评分', en: 'Evidence Score' },
  watchIndex: { zh: '观察指数', en: 'Watch Index' },
  sp: { zh: '赔率', en: 'Odds' },
  recommendation: { zh: '正式推荐', en: 'Formal Pick' },
  analysisReference: { zh: '分析参考', en: 'Analysis Reference' },
  waiting: { zh: '待开售', en: 'Awaiting release' },
  disclaimer: { zh: '提示：本页为赛事数据分析与预测展示，仅供参考和娱乐研究使用，请理性看球。', en: 'Forecasts are for data analysis, reference and entertainment only.' }
} as const;

const pickText = (value: MultiLangString, language: Locale) => value[language] || value.zh || value.en;

const formatPercent = (value: number | null | undefined) => {
  if (!Number.isFinite(value ?? NaN)) return '--';
  return `${Math.round(value as number)}%`;
};

const formatDateTime = (isoTime: string | undefined, language: Locale) => {
  if (!isoTime) return '--';
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return '--';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(timestamp);
};

const currentStageCopy = {
  kicker: { zh: '官方阶段看板', en: 'Official Stage Desk' },
  desc: {
    zh: '当前阶段由官方竞彩赛程编号动态判断；已完赛对阵、待开赛场次、赛前分析和下一轮预告集中展示。',
    en: 'The active stage is derived from official Sporttery fixture numbers, with results, upcoming ties, analysis and the next round in one panel.'
  },
  synced: { zh: '已同步对阵', en: 'Synced ties' },
  finished: { zh: '已完赛', en: 'Finished' },
  upcoming: { zh: '待开赛', en: 'Upcoming' },
  next: { zh: '下一场', en: 'Next' },
  nextRound: { zh: '下一轮预告', en: 'Next-round preview' },
  pending: { zh: '等待赛程补齐', en: 'Waiting for schedule' },
  winner: { zh: '晋级', en: 'Advanced' },
  pick: { zh: '赛前方向', en: 'Pre-match lean' },
  odds: { zh: '赔率', en: 'Odds' },
  score: { zh: '比分', en: 'Score' },
  officialOnly: {
    zh: '只读取官方竞彩世界杯赛程；损坏或未核验的 fallback 不参与阶段判断和展示。',
    en: 'Only official Sporttery World Cup fixtures are used; damaged or unverified fallback data is excluded.'
  }
} as const;

const datasetSafetyReasonLabels: Record<string, MultiLangString> = {
  'invalid-team-groups': { zh: '球队分组异常', en: 'invalid team groups' },
  'team-group-outlook-mismatch': { zh: '球队与分组展望不一致', en: 'team/group outlook mismatch' },
  'team-group-cardinality-invalid': { zh: '小组球队数量异常', en: 'invalid group cardinality' },
  'team-outlook-groups-not-diverse': { zh: '分组展望覆盖不足', en: 'incomplete outlook groups' },
  'invalid-fixture-dates': { zh: '静态赛程日期异常', en: 'invalid static fixture dates' },
  'invalid-fixture-groups': { zh: '静态赛程分组异常', en: 'invalid static fixture groups' },
  'fixture-groups-not-diverse': { zh: '静态赛程分组覆盖不足', en: 'incomplete static fixture groups' },
  'fixture-team-group-mismatch': { zh: '赛程球队与分组不一致', en: 'fixture/team group mismatch' },
  'fixture-quality-untrusted': { zh: '静态赛程来源未核验', en: 'untrusted static fixture source' }
};

const isMatchResolved = (match: Match) => (
  match.status === 'FINISHED'
  || match.status === 'PENDING_RESULT'
  || (Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway))
);

const getCleanStatusLabel = (match: Match, language: Locale) => {
  const hasScore = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
  const score = hasScore ? ` ${match.scoreHome}:${match.scoreAway}` : '';
  if (match.status === 'FINISHED') return language === 'zh' ? `完赛${score}` : `Finished${score}`;
  if (match.status === 'LIVE') return language === 'zh' ? `进行中${score}` : `Live${score}`;
  if (match.status === 'PENDING_RESULT') return language === 'zh' ? '待赛果' : 'Result pending';
  return language === 'zh' ? '待开赛' : 'Scheduled';
};

const getCleanScoreLabel = (match: Match) => (
  Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
    ? `${match.scoreHome}:${match.scoreAway}`
    : 'VS'
);

const getWinnerSide = (match: Match): 'home' | 'away' | null => {
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return null;
  if ((match.scoreHome as number) > (match.scoreAway as number)) return 'home';
  if ((match.scoreAway as number) > (match.scoreHome as number)) return 'away';
  return null;
};

const getTeamShortName = (team: Team, language: Locale) => (
  team.shortName[language]
  || team.name[language]
  || team.shortName.zh
  || team.name.zh
  || team.shortName.en
  || team.name.en
  || team.id
);

const getStatusLabel = (match: Match, language: Locale) => {
  if (match.status === 'FINISHED') {
    const score = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
      ? ` ${match.scoreHome}:${match.scoreAway}`
      : '';
    return language === 'zh' ? `已完场${score}` : `Finished${score}`;
  }
  if (match.status === 'LIVE') {
    const score = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
      ? ` ${match.scoreHome}:${match.scoreAway}`
      : '';
    return language === 'zh' ? `进行中${score}` : `Live${score}`;
  }
  if (match.status === 'PENDING_RESULT') return language === 'zh' ? '待赛果' : 'Result pending';
  return language === 'zh' ? '待开赛' : 'Scheduled';
};

const getTeamName = (team: WorldCupTeamForecast, language: Locale) => pickText(team.shortName, language);

const toWorldCupBadgeTeam = (team: WorldCupTeamForecast): Team => ({
  id: `worldcup_${team.id}`,
  name: team.name,
  shortName: team.shortName,
  logo: team.id,
  logoType: 'flag',
  value: '',
  color: '#0f9f6e'
});

const TeamFlag = ({ team }: { team: WorldCupTeamForecast }) => (
  <TeamBadge
    team={toWorldCupBadgeTeam(team)}
    size="sm"
    className={`worldcup-team-flag ${team.id === 'morocco' ? 'is-morocco' : ''}`}
  />
);

const formatGoalDiff = (value: number) => {
  if (!Number.isFinite(value)) return '0';
  return value > 0 ? `+${value}` : `${value}`;
};

const getStandingSourceLabel = (source: WorldCupStandingTeam['standingSource'], language: Locale) => {
  if (source === 'actual') return language === 'zh' ? '赛果锁定' : 'Locked';
  if (source === 'mixed') return language === 'zh' ? '赛果+预测' : 'Live + model';
  return language === 'zh' ? '预测补位' : 'Projected';
};

const getQualificationLabel = (team: WorldCupStandingTeam, language: Locale) => {
  if (team.qualificationZone === 'direct') return language === 'zh' ? '直接出线区' : 'Direct lane';
  if (team.qualificationZone === 'best-third') return language === 'zh' ? '最佳第三区' : 'Best third lane';
  if (team.qualificationZone === 'eliminated') return language === 'zh' ? '出局' : 'Eliminated';
  if (team.actualRank === 3) return language === 'zh' ? '第三名待比较' : 'Third-place pending';
  return team.standingSource === 'projected'
    ? (language === 'zh' ? '出局风险' : 'Elimination risk')
    : (language === 'zh' ? '待追赶' : 'Chasing');
};

const getStandingLine = (team: WorldCupStandingTeam, language: Locale) => {
  if (team.played > 0) {
    return language === 'zh'
      ? `${team.points}分 / ${team.played}场 / 净胜${formatGoalDiff(team.goalDifference)}`
      : `${team.points} pts / ${team.played} played / GD ${formatGoalDiff(team.goalDifference)}`;
  }

  return language === 'zh'
    ? `预测 ${team.projectedPoints.toFixed(1)}分 / FIFA ${team.fifaRank}`
    : `Projected ${team.projectedPoints.toFixed(1)} pts / FIFA ${team.fifaRank}`;
};

const GroupTeamRow = ({ team, language }: { team: WorldCupStandingTeam; language: Locale }) => {
  const hasResults = team.played > 0;
  const status = getQualificationLabel(team, language);

  return (
    <article className={`worldcup-group-team-row is-${team.qualificationZone}`}>
      <TeamFlag team={team} />
      <div className="worldcup-team-copy">
        <strong>{getTeamName(team, language)}</strong>
        <small>{getStandingLine(team, language)}</small>
        <em>{status}</em>
      </div>
      <div className="worldcup-team-prob">
        <b>{hasResults ? team.points : formatPercent(team.advanceProbability)}</b>
        <small>{hasResults ? (language === 'zh' ? '积分' : 'Points') : (language === 'zh' ? '晋级' : 'Advance')}</small>
      </div>
      <div className="worldcup-team-split">
        <small>{language === 'zh' ? '排名' : 'Rank'} #{team.actualRank}</small>
        <small>{hasResults ? `${team.wins}-${team.draws}-${team.losses}` : `${language === 'zh' ? '头名' : 'Win'} ${formatPercent(team.groupWinProbability)}`}</small>
        <small>{getStandingSourceLabel(team.standingSource, language)}</small>
      </div>
      <span className="worldcup-team-meter" aria-hidden="true">
        <span style={{ '--advance': `${team.advanceProbability}%` } as React.CSSProperties} />
      </span>
    </article>
  );
};

const Round32Side = ({
  team,
  label,
  language
}: {
  team: WorldCupStandingTeam | null;
  label: MultiLangString;
  language: Locale;
}) => (
  <div className="worldcup-r32-side">
    <span>{pickText(label, language)}</span>
    {team ? (
      <div>
        <TeamFlag team={team} />
        <strong>{getTeamName(team, language)}</strong>
        <small>{getStandingLine(team, language)}</small>
      </div>
    ) : (
      <div>
        <strong>{language === 'zh' ? '待定' : 'TBD'}</strong>
        <small>{language === 'zh' ? '等待小组赛果' : 'Waiting for group results'}</small>
      </div>
    )}
  </div>
);

const Round32PairingCard = ({ pairing, language }: { pairing: WorldCupRound32Pairing; language: Locale }) => (
  <article className={`worldcup-r32-card is-${pairing.source}`}>
    <header>
      <strong>{pickText(pairing.title, language)}</strong>
      <span>{getStandingSourceLabel(pairing.source, language)} / {language === 'zh' ? '路径指数' : 'Route index'} {Math.round(pairing.confidence)}/100</span>
    </header>
    <Round32Side team={pairing.left} label={pairing.leftLabel} language={language} />
    <b className="worldcup-r32-vs">VS</b>
    <Round32Side team={pairing.right} label={pairing.rightLabel} language={language} />
    <p>{pickText(pairing.note, language)}</p>
  </article>
);

type WorldCupCardRecommendation = {
  label: string;
  detail: string;
};

const getMarketRecommendation = (
  pools: SportteryOddsPoolDisplay[],
  language: Locale
): WorldCupCardRecommendation | null => {
  const had = pools.find((pool) => pool.poolCode === 'HAD' && pool.odds && pool.probabilities);
  const hhad = pools.find((pool) => pool.poolCode === 'HHAD' && pool.odds && pool.probabilities);
  const labels = {
    home: language === 'zh' ? '主胜' : 'Home',
    draw: language === 'zh' ? '平局' : 'Draw',
    away: language === 'zh' ? '客胜' : 'Away'
  };

  if (had?.probabilities) {
    const ranked = ([
      { key: 'home' as const, value: had.probabilities.home },
      { key: 'draw' as const, value: had.probabilities.draw },
      { key: 'away' as const, value: had.probabilities.away }
    ]).sort((a, b) => b.value - a.value);
    const leader = ranked[0];
    const gap = leader.value - ranked[1].value;
    const hhadText = hhad?.probabilities
      ? (language === 'zh'
          ? `让球${hhad.handicap || '--'}：${hhad.probabilities.home}/${hhad.probabilities.draw}/${hhad.probabilities.away}%`
          : `HHAD ${hhad.handicap || '--'}: ${hhad.probabilities.home}/${hhad.probabilities.draw}/${hhad.probabilities.away}%`)
      : (language === 'zh' ? '让球盘待确认' : 'handicap pending');
    const label = leader.key === 'draw' || gap < 6
      ? (language === 'zh' ? '均势防平' : 'Tight draw watch')
      : gap >= 18
        ? (language === 'zh' ? `${labels[leader.key]}倾向` : `${labels[leader.key]} lean`)
        : (language === 'zh' ? `${labels[leader.key]}优先，防平` : `${labels[leader.key]} first, cover draw`);

    return {
      label,
      detail: language === 'zh'
        ? `HAD 去水：${had.probabilities.home}/${had.probabilities.draw}/${had.probabilities.away}%，概率差 ${gap} 个点；${hhadText}。`
        : `HAD normalized ${had.probabilities.home}/${had.probabilities.draw}/${had.probabilities.away}%, gap ${gap} pts; ${hhadText}.`
    };
  }

  if (hhad?.probabilities) {
    const ranked = ([
      { key: 'home' as const, value: hhad.probabilities.home },
      { key: 'draw' as const, value: hhad.probabilities.draw },
      { key: 'away' as const, value: hhad.probabilities.away }
    ]).sort((a, b) => b.value - a.value);

    return {
      label: language === 'zh'
        ? `让球盘观察 ${hhad.handicap || ''}`.trim()
        : `HHAD watch ${hhad.handicap || ''}`.trim(),
      detail: language === 'zh'
        ? `普通胜平负未开售，先看让球盘 ${labels[ranked[0].key]} 方向，去水 ${hhad.probabilities.home}/${hhad.probabilities.draw}/${hhad.probabilities.away}%。`
        : `1X2 is not released; handicap market leans ${labels[ranked[0].key]} with normalized ${hhad.probabilities.home}/${hhad.probabilities.draw}/${hhad.probabilities.away}%.`
    };
  }

  return null;
};

const MatchCard = ({
  match,
  language,
  groupForecasts,
  formalPresentationAllowed,
  onSelectMatch
}: {
  match: Match;
  language: Locale;
  groupForecasts: WorldCupGroupForecast[];
  formalPresentationAllowed: boolean;
  onSelectMatch: (id: string) => void;
}) => {
  const home = getDisplayTeam(match, 'home');
  const away = getDisplayTeam(match, 'away');
  const league = getLeagueById(match.leagueId);
  const leagueLabel = (language === 'zh'
    ? match.leagueName || match.leagueShortName
    : match.leagueNameEn || match.leagueShortNameEn)
    || league.shortName[language];
  const rawDisplayRecommendation = getDisplayRecommendation(match, language);
  const displayRecommendation = formalPresentationAllowed ? rawDisplayRecommendation : null;
  const analysisReference = !displayRecommendation
    ? rawDisplayRecommendation?.prediction || getAnalysisReferencePrediction(match)
    : undefined;
  const forecast = displayRecommendation || !WORLD_CUP_DATASET_SAFETY.safe
    ? null
    : getWorldCupFixtureForecast(match, groupForecasts);
  const presentedPrediction = displayRecommendation?.prediction || analysisReference;
  const evidenceScore = formatEvidenceScore(presentedPrediction);
  const modelProbability = formatCalibratedModelProbability(match, presentedPrediction);
  const pools = getSportteryPoolRows(match, language);
  const had = pools.find((pool) => pool.poolCode === 'HAD');
  const hhad = pools.find((pool) => pool.poolCode === 'HHAD');
  const marketRecommendation = getMarketRecommendation(pools, language);
  const recommendation = displayRecommendation
    ? displayRecommendation.label
    : analysisReference
      ? getPredictionTipDisplay(analysisReference, language, true)
      : marketRecommendation
        ? marketRecommendation.label
        : forecast
          ? pickText(forecast.tip, language)
          : copy.waiting[language];
  const cardDetail = marketRecommendation?.detail || (forecast ? pickText(forecast.detail, language) : `${copy.waiting[language]} HAD ${copy.sp[language]}`);

  return (
    <article className="worldcup-match-card">
      <header>
        <span>{formatDateTime(match.kickoffTime, language)}</span>
        <strong>{getStatusLabel(match, language)}</strong>
      </header>
      <button className="worldcup-teams-button" type="button" onClick={() => onSelectMatch(match.id)}>
        <span>
          <TeamBadge team={home} size="sm" />
          {home.shortName[language]}
        </span>
        <b>VS</b>
        <span>
          {away.shortName[language]}
          <TeamBadge team={away} size="sm" />
        </span>
      </button>
      <div className="worldcup-card-lines">
        <span>{leagueLabel}</span>
        <span>{displayRecommendation ? copy.recommendation[language] : copy.analysisReference[language]} {recommendation}</span>
        <span>{copy.evidenceScore[language]} {evidenceScore}</span>
        {modelProbability && <span>{language === 'zh' ? '模型概率' : 'Model probability'} {modelProbability}</span>}
        {forecast && (
          <span>
            {language === 'zh' ? '晋级参考' : 'Route reference'} {formatPercent(forecast.homeAdvanceProbability)} / {formatPercent(forecast.awayAdvanceProbability)}
          </span>
        )}
      </div>
      {had?.odds ? (
        <div className="worldcup-odds-strip">
          <span>HAD</span>
          <strong>{had.odds.odds1.toFixed(2)}</strong>
          <strong>{had.odds.oddsX.toFixed(2)}</strong>
          <strong>{had.odds.odds2.toFixed(2)}</strong>
          <span>{had.updatedAt ? formatDateTime(had.updatedAt, language) : copy.sp[language]}</span>
        </div>
      ) : (
        <div className="worldcup-odds-strip is-empty">
          {cardDetail}
        </div>
      )}
      {hhad?.odds && (
        <div className="worldcup-odds-strip">
          <span>HHAD {hhad.handicap}</span>
          <strong>{hhad.odds.odds1.toFixed(2)}</strong>
          <strong>{hhad.odds.oddsX.toFixed(2)}</strong>
          <strong>{hhad.odds.odds2.toFixed(2)}</strong>
          <span>{hhad.updatedAt ? formatDateTime(hhad.updatedAt, language) : copy.sp[language]}</span>
        </div>
      )}
      <button className="worldcup-card-action" type="button" onClick={() => onSelectMatch(match.id)}>
        {copy.more[language]}
        <ChevronRight size={16} />
      </button>
    </article>
  );
};

const OfficialStageMatchCard = ({
  match,
  language,
  stageTitle,
  groupForecasts,
  formalPresentationAllowed,
  onSelectMatch
}: {
  match: Match;
  language: Locale;
  stageTitle: string;
  groupForecasts: WorldCupGroupForecast[];
  formalPresentationAllowed: boolean;
  onSelectMatch: (id: string) => void;
}) => {
  const home = getDisplayTeam(match, 'home');
  const away = getDisplayTeam(match, 'away');
  const homeName = getTeamShortName(home, language);
  const awayName = getTeamShortName(away, language);
  const pools = getSportteryPoolRows(match, language);
  const had = pools.find((pool) => pool.poolCode === 'HAD');
  const rawDisplayRecommendation = getDisplayRecommendation(match, language);
  const displayRecommendation = formalPresentationAllowed ? rawDisplayRecommendation : null;
  const analysisReference = !displayRecommendation
    ? rawDisplayRecommendation?.prediction || getAnalysisReferencePrediction(match)
    : undefined;
  const forecast = displayRecommendation || !WORLD_CUP_DATASET_SAFETY.safe
    ? null
    : getWorldCupFixtureForecast(match, groupForecasts);
  const marketRecommendation = getMarketRecommendation(pools, language);
  const archivedDirectionMissing = isMatchResolved(match) && !displayRecommendation && !analysisReference;
  const recommendation = displayRecommendation
    ? displayRecommendation.label
    : analysisReference
      ? getPredictionTipDisplay(analysisReference, language, true)
      : archivedDirectionMissing
        ? (language === 'zh' ? '未归档' : 'Not archived')
        : marketRecommendation?.label || (forecast ? pickText(forecast.tip, language) : currentStageCopy.pending[language]);
  const presentedPrediction = displayRecommendation?.prediction || analysisReference;
  const evidenceScore = formatEvidenceScore(presentedPrediction);
  const modelProbability = formatCalibratedModelProbability(match, presentedPrediction);
  const winnerSide = getWinnerSide(match);
  const winner = winnerSide === 'home' ? homeName : winnerSide === 'away' ? awayName : '';
  const oddsLabel = had?.odds
    ? `${had.odds.odds1.toFixed(2)} / ${had.odds.oddsX.toFixed(2)} / ${had.odds.odds2.toFixed(2)}`
    : isMatchResolved(match)
      ? (language === 'zh' ? '赛前 SP 未归档' : 'Pre-match SP not archived')
      : currentStageCopy.pending[language];
  const officialMatchNumber = getWorldCupOfficialMatchNumber(match);
  const stageCardLabel = officialMatchNumber !== null
    ? `#${String(officialMatchNumber).padStart(3, '0')}`
    : stageTitle;

  return (
    <button
      className={`worldcup-r16-card ${isMatchResolved(match) ? 'is-finished' : 'is-upcoming'}`}
      type="button"
      onClick={() => onSelectMatch(match.id)}
    >
      <header>
        <span>{stageCardLabel}</span>
        <strong>{getCleanStatusLabel(match, language)}</strong>
      </header>
      <div className="worldcup-r16-teams">
        <span className="worldcup-r16-side">
          <TeamBadge team={home} size="sm" />
          <strong>{homeName}</strong>
        </span>
        <b className="worldcup-r16-score">{getCleanScoreLabel(match)}</b>
        <span className="worldcup-r16-side">
          <strong>{awayName}</strong>
          <TeamBadge team={away} size="sm" />
        </span>
      </div>
      <div className="worldcup-r16-lines">
        <span className="worldcup-r16-line">
          <CalendarDays size={14} />
          {formatDateTime(match.kickoffTime, language)}
        </span>
        <span className="worldcup-r16-line">
          <Target size={14} />
          {displayRecommendation ? copy.recommendation[language] : currentStageCopy.pick[language]} {recommendation}
        </span>
        <span className="worldcup-r16-line">
          <Trophy size={14} />
          {copy.evidenceScore[language]} {evidenceScore}
        </span>
        {modelProbability && (
          <span className="worldcup-r16-line">
            <BarChart3 size={14} />
            {language === 'zh' ? '模型概率' : 'Model probability'} {modelProbability}
          </span>
        )}
        <span className="worldcup-r16-line">
          <BarChart3 size={14} />
          HAD {currentStageCopy.odds[language]} {oddsLabel}
        </span>
      </div>
      {winner && (
        <span className="worldcup-r16-winner">
          <Medal size={14} />
          {currentStageCopy.winner[language]} {winner}
        </span>
      )}
    </button>
  );
};

export const WorldCup: React.FC<WorldCupProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const shouldReduceMotion = useReducedMotion();
  const daysLeft = getDaysUntilWorldCup();
  const formalPresentationAllowed = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode
  );

  const groupForecasts = useMemo(() => getWorldCupGroupForecasts(), []);
  const knockoutRoutes = useMemo(() => getWorldCupKnockoutForecast(groupForecasts), [groupForecasts]);
  const syncedWorldCupMatches = useMemo(
    () => matches.filter(isWorldCupRelevantMatch).sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime)),
    [matches]
  );
  const allWorldCupMatches = syncedWorldCupMatches;
  const officialGroupStageMatches = useMemo(
    () => allWorldCupMatches.filter((match) => {
      const matchNumber = getWorldCupOfficialMatchNumber(match);
      return matchNumber !== null && matchNumber <= 72;
    }),
    [allWorldCupMatches]
  );
  const groupStandings = useMemo(
    () => getWorldCupLiveGroupStandings(officialGroupStageMatches, groupForecasts),
    [officialGroupStageMatches, groupForecasts]
  );
  const qualifiers = useMemo(() => getWorldCupStandingQualifiers(groupStandings), [groupStandings]);
  const round32Pairings = useMemo(() => getWorldCupRound32Pairings(groupStandings), [groupStandings]);
  const watchMatches = useMemo(() => getWorldCupWatchMatches(allWorldCupMatches, 8), [allWorldCupMatches]);
  const fixtureMatches = useMemo(
    () => watchMatches.length
      ? watchMatches
      : allWorldCupMatches.filter((match) => match.status !== 'FINISHED' && match.status !== 'PENDING_RESULT').slice(0, 8),
    [allWorldCupMatches, watchMatches]
  );
  const currentOfficialStage = useMemo(
    () => getWorldCupCurrentOfficialStage(allWorldCupMatches),
    [allWorldCupMatches]
  );
  const currentStageMatches = currentOfficialStage.matches;
  const nextStageMatches = currentOfficialStage.nextMatches;
  const isOfficialKnockoutStage = !['group', 'unknown'].includes(currentOfficialStage.id);
  const showStaticForecastContent = WORLD_CUP_DATASET_SAFETY.safe && !isOfficialKnockoutStage;
  const datasetGateReasons = WORLD_CUP_DATASET_SAFETY.reasons.map((reason) => (
    datasetSafetyReasonLabels[reason]?.[language] || reason
  ));
  const recentResults = useMemo(() => getWorldCupRecentResults(allWorldCupMatches, 5), [allWorldCupMatches]);
  const contenders = useMemo(() => getWorldCupContenders(allWorldCupMatches, 5), [allWorldCupMatches]);
  const upsetRadar = useMemo(() => getWorldCupUpsetRadar(allWorldCupMatches, 5), [allWorldCupMatches]);
  const currentStageFinished = currentStageMatches.filter(isMatchResolved).length;
  const upcomingCurrentStageMatches = currentStageMatches.filter((match) => !isMatchResolved(match));
  const currentStageUpcoming = upcomingCurrentStageMatches.length;
  const nextCurrentStageMatch = upcomingCurrentStageMatches[0] || null;
  const spotlightMatches = (upcomingCurrentStageMatches.length ? upcomingCurrentStageMatches : fixtureMatches).slice(0, 3);

  const bestThird = qualifiers.bestThird;
  const updatedAt = dataSync.sourceUpdatedAt || dataSync.updatedAt || dataSync.lastCheckedAt;
  const pageCheckedAt = dataSync.lastCheckedAt;

  const reveal = (delay = 0) => shouldReduceMotion ? {} : {
    initial: false,
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.32, delay: Math.min(delay, 0.08) }
  };

  const kpis = [
    { icon: Users, label: copy.kpis.teams[language], value: WORLD_CUP_OFFICIAL.teams, detail: pickText(WORLD_CUP_OFFICIAL.host, language) },
    { icon: CalendarDays, label: copy.kpis.matches[language], value: WORLD_CUP_OFFICIAL.matches, detail: `${WORLD_CUP_OFFICIAL.startDate} - ${WORLD_CUP_OFFICIAL.finalDate}` },
    { icon: Flag, label: copy.kpis.groups[language], value: WORLD_CUP_OFFICIAL.groups, detail: language === 'zh' ? '12 组 x 4 队' : '12 groups x 4 teams' },
    { icon: Trophy, label: copy.kpis.venues[language], value: WORLD_CUP_OFFICIAL.venues, detail: language === 'zh' ? '加拿大 / 墨西哥 / 美国' : 'Canada / Mexico / USA' },
    { icon: Target, label: copy.kpis.sporttery[language], value: currentStageMatches.length || allWorldCupMatches.length || fixtureMatches.length, detail: currentOfficialStage.source === 'official-sporttery-schedule' ? currentOfficialStage.title[language] : copy.waiting[language] },
    { icon: Route, label: language === 'zh' ? '晋级名额' : 'Knockout Spots', value: 32, detail: language === 'zh' ? '前二 24 + 第三名 8' : 'Top two 24 + third-place 8' },
    { icon: BarChart3, label: language === 'zh' ? '路径推演' : 'Route Runs', value: WORLD_CUP_FORECAST_MODEL.simulations.toLocaleString(), detail: WORLD_CUP_FORECAST_MODEL.version },
    { icon: RefreshCw, label: copy.kpis.update[language], value: pageCheckedAt ? formatDateTime(pageCheckedAt, language) : '--', detail: updatedAt ? `${language === 'zh' ? '源' : 'Source'} ${formatDateTime(updatedAt, language)}` : '--' }
  ];

  return (
    <div id="top" className="worldcup-page">
      <motion.section className="worldcup-spotlight" {...reveal()}>
        <div className="worldcup-spotlight-main">
          <span className="worldcup-kicker">
            <Trophy size={16} />
            {pickText(WORLD_CUP_OFFICIAL.name, language)}
          </span>
          <h1 style={{ fontSize: '1.55rem', fontFamily: 'var(--font-title)', lineHeight: 1.15 }}>
            {currentOfficialStage.title[language]} · {language === 'zh' ? '官方赛程概览' : 'Official Fixture Overview'}
          </h1>
          <p>{currentStageCopy.desc[language]}</p>
          <div className="worldcup-spotlight-stats">
            <span><strong>{currentStageMatches.length}</strong> {currentStageCopy.synced[language]}</span>
            <span><strong>{currentStageFinished}</strong> {currentStageCopy.finished[language]}</span>
            <span><strong>{currentStageUpcoming}</strong> {currentStageCopy.upcoming[language]}</span>
            <span><strong>{nextStageMatches.length}</strong> {currentStageCopy.nextRound[language]}</span>
            <span className="worldcup-sync-pill">
              <RefreshCw size={14} />
              {pageCheckedAt ? formatDateTime(pageCheckedAt, language) : '--'}
            </span>
          </div>
          <div className="worldcup-spotlight-hosts">
            <span>{language === 'zh' ? '仅官方竞彩赛程' : 'Official Sporttery only'}</span>
            <span>{showStaticForecastContent ? (language === 'zh' ? '静态专题已通过门禁' : 'Static dataset approved') : (language === 'zh' ? '静态专题已隐藏' : 'Static dataset hidden')}</span>
          </div>
        </div>
        <div className="worldcup-spotlight-side">
          {spotlightMatches.length ? (
            spotlightMatches.map((match) => {
              const home = getDisplayTeam(match, 'home');
              const away = getDisplayTeam(match, 'away');
              const forecast = WORLD_CUP_DATASET_SAFETY.safe
                ? getWorldCupFixtureForecast(match, groupForecasts)
                : null;
              const displayRecommendation = getDisplayRecommendation(match, language);
              const analysisReference = !displayRecommendation ? getAnalysisReferencePrediction(match) : undefined;
              const marketRecommendation = getMarketRecommendation(getSportteryPoolRows(match, language), language);
              const miniRecommendation = displayRecommendation
                ? `${copy.recommendation[language]} ${displayRecommendation.label}`
                : `${copy.analysisReference[language]} ${analysisReference
                  ? getPredictionTipDisplay(analysisReference, language, true)
                  : marketRecommendation?.label || (forecast ? pickText(forecast.tip, language) : copy.waiting[language])}`;
              return (
                <button className="worldcup-mini-match" type="button" key={match.id} onClick={() => onSelectMatch(match.id)}>
                  <span className="worldcup-mini-label">{formatDateTime(match.kickoffTime, language)}</span>
                  <span className="worldcup-mini-teams">
                    <span>{home.shortName[language]}</span>
                    <b>VS</b>
                    <span>{away.shortName[language]}</span>
                  </span>
                  <span className="worldcup-mini-meta">
                    {miniRecommendation}
                  </span>
                  <span className="worldcup-mini-action">
                    {copy.more[language]}
                    <ChevronRight size={15} />
                  </span>
                </button>
              );
            })
          ) : <div className="worldcup-empty">{currentStageCopy.pending[language]}</div>}
        </div>
      </motion.section>

      <motion.section className="worldcup-section worldcup-current-stage" {...reveal(0.012)}>
        <div className="worldcup-current-stage-hero">
          <span className="worldcup-kicker">
            <Trophy size={16} />
            {currentStageCopy.kicker[language]}
          </span>
          <div>
            <h2>{currentOfficialStage.title[language]}</h2>
            <p>{currentStageCopy.desc[language]}</p>
          </div>
          <div className="worldcup-current-stage-stats">
            <article>
              <span>{currentStageCopy.synced[language]}</span>
              <strong>{currentStageMatches.length}/{currentOfficialStage.expectedMatches || '--'}</strong>
            </article>
            <article>
              <span>{currentStageCopy.finished[language]}</span>
              <strong>{currentStageFinished}</strong>
            </article>
            <article>
              <span>{currentStageCopy.upcoming[language]}</span>
              <strong>{currentStageUpcoming}</strong>
            </article>
            <article className="is-wide">
              <span>{currentStageCopy.next[language]}</span>
              <strong>
                {nextCurrentStageMatch
                  ? formatDateTime(nextCurrentStageMatch.kickoffTime, language)
                  : '--'}
              </strong>
              <em>
                {nextCurrentStageMatch
                  ? `${getTeamShortName(getDisplayTeam(nextCurrentStageMatch, 'home'), language)} vs ${getTeamShortName(getDisplayTeam(nextCurrentStageMatch, 'away'), language)}`
                  : currentStageCopy.pending[language]}
              </em>
            </article>
          </div>
        </div>

        {currentStageMatches.length ? (
          <div className="worldcup-r16-grid">
            {currentStageMatches.map((match) => (
              <OfficialStageMatchCard
                key={match.id}
                match={match}
                language={language}
                stageTitle={currentOfficialStage.title[language]}
                groupForecasts={groupForecasts}
                formalPresentationAllowed={formalPresentationAllowed}
                onSelectMatch={onSelectMatch}
              />
            ))}
          </div>
        ) : (
          <div className="worldcup-empty">{currentStageCopy.pending[language]}</div>
        )}

        {nextStageMatches.length > 0 && (
          <div className="worldcup-next-round-strip">
            <span className="worldcup-kicker">
              <Medal size={16} />
              {currentOfficialStage.nextTitle?.[language] || currentStageCopy.nextRound[language]}
            </span>
            <div>
              {nextStageMatches.map((match) => (
                <button
                  className="worldcup-next-round-match"
                  type="button"
                  key={match.id}
                  onClick={() => onSelectMatch(match.id)}
                >
                  <strong>{formatDateTime(match.kickoffTime, language)}</strong>
                  <span>
                    {getTeamShortName(getDisplayTeam(match, 'home'), language)}
                    <b>VS</b>
                    {getTeamShortName(getDisplayTeam(match, 'away'), language)}
                  </span>
                  <small>{getCleanStatusLabel(match, language)}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="worldcup-stage-footnote">
          {currentStageCopy.officialOnly[language]}
          {currentOfficialStage.startMatchNo !== null && currentOfficialStage.endMatchNo !== null
            ? ` #${currentOfficialStage.startMatchNo}-${currentOfficialStage.endMatchNo}`
            : ''}
        </p>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.014)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <ShieldCheck size={16} />
              {language === 'zh' ? '专题数据门禁' : 'Tournament Data Gate'}
            </span>
            <p>
              {!WORLD_CUP_DATASET_SAFETY.safe
                ? (language === 'zh'
                  ? '静态专题数据集未通过安全校验：小组预测、静态 32 强/冠军概率、争冠强度和爆冷雷达已全部隐藏。当前页面只读取官方竞彩世界杯赛程。'
                  : 'The static tournament dataset failed safety validation. Group forecasts, static Round-of-32/title probabilities, contender strength and upset radar are hidden; this page now reads only official Sporttery fixtures.')
                : isOfficialKnockoutStage
                  ? (language === 'zh'
                    ? '赛事已进入淘汰赛，历史小组预测和静态路径推演已收起；当前官方阶段与下一阶段优先。'
                    : 'The tournament is in the knockout phase, so old group forecasts and static route projections are collapsed in favor of the current and next official stages.')
                  : (language === 'zh'
                    ? '静态专题数据已通过安全门禁；官方赛程仍优先展示。'
                    : 'The static tournament dataset passed its gate; official fixtures still take priority.')}
            </p>
          </div>
          <span className="worldcup-sync-pill">
            {WORLD_CUP_DATASET_SAFETY.safe
              ? (language === 'zh' ? '数据集通过' : 'Dataset approved')
              : (language === 'zh' ? '数据集拒绝' : 'Dataset rejected')}
          </span>
        </div>
        <div className="worldcup-model-note">
          <strong>{WORLD_CUP_DATASET_SAFETY.version}</strong>
          <p>
            {datasetGateReasons.length
              ? `${language === 'zh' ? '阻断原因' : 'Blocked by'}：${datasetGateReasons.join(language === 'zh' ? '、' : ', ')}`
              : (language === 'zh' ? '没有数据集阻断项。' : 'No dataset blockers.')}
          </p>
          <span>
            {language === 'zh'
              ? `当前阶段：${currentOfficialStage.title.zh} · 官方来源：${currentOfficialStage.source === 'official-sporttery-schedule' ? '已确认' : '等待同步'}`
              : `Current stage: ${currentOfficialStage.title.en} · official source: ${currentOfficialStage.source === 'official-sporttery-schedule' ? 'confirmed' : 'pending'}`}
          </span>
        </div>
      </motion.section>

      {showStaticForecastContent && <>
      <motion.div {...reveal(0.015)}>
        <WorldCupLastDance language={language} />
      </motion.div>

      <motion.section className="worldcup-hero-panel" {...reveal(0.03)}>
        <div className="worldcup-hero-copy">
          <span className="worldcup-kicker">
            <Sparkles size={16} />
            {pickText(WORLD_CUP_OFFICIAL.name, language)}
          </span>
          <h1>THE LAST DANCE</h1>
          <p>{copy.groupsDesc[language]}</p>
          <div className="worldcup-hero-meta">
            <span>48 队</span>
            <span>104 场</span>
            <span>32 强路线</span>
            <span>最佳第三名</span>
            <span>竞彩开售后更新 SP</span>
          </div>
          <div className="worldcup-hero-hosts">
            <span>CA 加拿大</span>
            <span>MX 墨西哥</span>
            <span>US 美国</span>
          </div>
        </div>
        <div className="worldcup-hero-visual">
          <div className="worldcup-countdown-card">
            <span>{copy.countdown[language]}</span>
            <strong>{daysLeft}</strong>
            <small>{copy.days[language]}</small>
          </div>
          <div className="worldcup-cup-emblem" aria-hidden="true">
            <span>2026</span>
            <strong>WC</strong>
            <small>MATCH DESK</small>
          </div>
          <div className="worldcup-route-rail">
            <span>小组赛</span>
            <span>32 强</span>
            <span>16 强</span>
            <span>8 强</span>
            <span>决赛</span>
          </div>
        </div>
      </motion.section>

      <motion.div className="worldcup-kpi-grid" {...reveal(0.05)}>
        {kpis.map((item) => (
          <article key={item.label}>
            <item.icon size={22} />
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
          </article>
        ))}
      </motion.div>

      <motion.section className="worldcup-section" {...reveal(0.07)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <ShieldCheck size={16} />
              {copy.stage[language]}
            </span>
            <p>{copy.stageDesc[language]}</p>
          </div>
          <span className="worldcup-sync-pill">{copy.dataStatus[language]}</span>
        </div>
        <div className="worldcup-stage-grid">
          {WORLD_CUP_STAGE_CARDS.map((stage) => (
            <article className="worldcup-stage-card" key={pickText(stage.title, language)}>
              <span>{pickText(stage.title, language)}</span>
              <strong>{pickText(stage.value, language)}</strong>
              <p>{pickText(stage.detail, language)}</p>
            </article>
          ))}
        </div>
        <div className="worldcup-model-note">
          <strong>{copy.model[language]}</strong>
          <p>{language === 'zh' ? WORLD_CUP_FORECAST_MODEL.zh : WORLD_CUP_FORECAST_MODEL.en}</p>
          <span>{WORLD_CUP_FORECAST_MODEL.version} / {WORLD_CUP_FORECAST_MODEL.simulations.toLocaleString()} 次</span>
        </div>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.09)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <BarChart3 size={16} />
              {copy.groups[language]}
            </span>
            <p>{copy.groupsDesc[language]}</p>
          </div>
          <span className="worldcup-sync-pill">
            {language === 'zh' ? `直通 ${qualifiers.winners.length + qualifiers.runnersUp.length} / 第三名 ${bestThird.length}` : `Direct ${qualifiers.winners.length + qualifiers.runnersUp.length} / third ${bestThird.length}`}
          </span>
        </div>
        <div className="worldcup-group-grid">
          {groupStandings.map((group) => (
            <article className="worldcup-group-card" key={group.id}>
              <header>
                <span>Group {group.id}</span>
                <strong>{pickText(group.dates, language)} · {getStandingSourceLabel(group.source, language)}</strong>
              </header>
              <p>{pickText(group.headline, language)}</p>
              <div className="worldcup-group-team-list">
                {group.teams.map((team) => (
                  <GroupTeamRow key={team.id} team={team} language={language} />
                ))}
              </div>
            </article>
          ))}
        </div>
        <div className="worldcup-third-lane">
          <span>{copy.bestThird[language]}</span>
          <div>
            {bestThird.map((team) => (
              <strong key={team.id}>
                <TeamFlag team={team} />
                {getTeamName(team, language)}
                <small>{team.played > 0 ? `${team.points}分 / 净胜${formatGoalDiff(team.goalDifference)}` : `${formatPercent(team.bestThirdProbability)} / ${team.projectedPoints.toFixed(1)}分`}</small>
              </strong>
            ))}
          </div>
          <p className="worldcup-third-note">{copy.bestThirdNote[language]}</p>
        </div>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.11)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Route size={16} />
              {copy.knockout[language]}
            </span>
            <p>{copy.knockoutDesc[language]}</p>
          </div>
          <span className="worldcup-sync-pill">32 强路径</span>
        </div>
        <div className="worldcup-knockout-grid">
          <div className="worldcup-round-list">
            {WORLD_CUP_KNOCKOUT_ROUNDS.map((round) => (
              <article key={round.id}>
                <span>{pickText(round.dates, language)}</span>
                <strong>{pickText(round.title, language)}</strong>
                <small>{round.matches} 场</small>
                <p>{pickText(round.detail, language)}</p>
              </article>
            ))}
          </div>
          <div className="worldcup-knockout-detail">
            <div className="worldcup-r32-board">
              {round32Pairings.map((pairing) => (
                <Round32PairingCard key={pairing.matchNo} pairing={pairing} language={language} />
              ))}
            </div>
            <div className="worldcup-route-list">
              {knockoutRoutes.slice(0, 6).map((route) => (
                <article key={route.team.id}>
                  <TeamFlag team={route.team} />
                  <div className="worldcup-route-copy">
                    <strong>{getTeamName(route.team, language)}</strong>
                    <small>{pickText(route.tier, language)} / Group {route.team.groupId}</small>
                  </div>
                  <div className="worldcup-route-probs">
                    <b>{formatPercent(route.champion)}</b>
                    <small>{language === 'zh' ? '冠军' : 'Champion'}</small>
                  </div>
                  <div className="worldcup-route-bars">
                    <span>32强 {formatPercent(route.round32)}</span>
                    <span>16强 {formatPercent(route.round16)}</span>
                    <span>8强 {formatPercent(route.quarterFinal)}</span>
                    <span>4强 {formatPercent(route.semiFinal)}</span>
                    <span>决赛 {formatPercent(route.final)}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.13)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Target size={16} />
              {copy.fixtures[language]}
            </span>
            <p>{copy.fixturesDesc[language]}</p>
          </div>
          <span className="worldcup-sync-pill">{updatedAt ? formatDateTime(updatedAt, language) : copy.waiting[language]}</span>
        </div>
        {fixtureMatches.length ? (
          <div className="worldcup-match-grid">
            {fixtureMatches.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                language={language}
                groupForecasts={groupForecasts}
                formalPresentationAllowed={formalPresentationAllowed}
                onSelectMatch={onSelectMatch}
              />
            ))}
          </div>
        ) : (
          <div className="worldcup-empty">{copy.noFixtures[language]}</div>
        )}
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.15)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Gauge size={16} />
              {copy.contenders[language]} / {copy.upset[language]}
            </span>
            <p>{copy.dataStatusDesc[language]}</p>
          </div>
          <span className="worldcup-sync-pill">{copy.disclaimer[language]}</span>
        </div>
        <div className="worldcup-scout-grid">
          <div className="worldcup-contender-list">
            {contenders.length ? contenders.map((item) => {
              const team = getTeamById(item.teamId);
              const opponent = getTeamById(item.opponentId);
              return (
                <button className="worldcup-contender-card" type="button" key={`${item.matchId}-${item.teamId}`} onClick={() => onSelectMatch(item.matchId)}>
                  <span className="worldcup-contender-team">
                    <TeamBadge team={team} size="sm" />
                    <strong>{team.shortName[language]}</strong>
                    <small>vs {opponent.shortName[language]}</small>
                  </span>
                  <span className="worldcup-scorebar" aria-hidden="true">
                    <span style={{ '--score': `${item.score}%` } as React.CSSProperties} />
                  </span>
                  <span className="worldcup-contender-meta">
                    <b>{item.score}</b>
                    <small>{copy.watchIndex[language]}</small>
                  </span>
                  <p>{pickText(item.reason, language)}</p>
                </button>
              );
            }) : <div className="worldcup-empty">世界杯 SP 开售后生成争冠观察池。</div>}
          </div>
          <div className="worldcup-radar-list">
            {upsetRadar.length ? upsetRadar.map((item) => {
              const favorite = getTeamById(item.favoriteTeamId);
              const underdog = getTeamById(item.underdogTeamId);
              return (
                <button type="button" key={`${item.matchId}-${item.underdogTeamId}`} onClick={() => onSelectMatch(item.matchId)}>
                  <span className="worldcup-radar-score">{item.riskScore}</span>
                  <span className="worldcup-radar-copy">
                    <strong>{underdog.shortName[language]} vs {favorite.shortName[language]}</strong>
                    <small>{pickText(item.reason, language)}</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              );
            }) : <div className="worldcup-empty">开售场次不足时不强行给爆冷结论。</div>}
          </div>
        </div>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.17)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Zap size={16} />
              {copy.pipeline[language]}
            </span>
            <p>{copy.dataStatusDesc[language]}</p>
          </div>
        </div>
        <div className="worldcup-two-col">
          <div className="worldcup-pipeline-list">
            {WORLD_CUP_PIPELINE_CARDS.map((card) => (
              <article key={pickText(card.title, language)}>
                <span>{pickText(card.value, language)}</span>
                <strong>{pickText(card.title, language)}</strong>
                <p>{pickText(card.detail, language)}</p>
              </article>
            ))}
          </div>
          <div className="worldcup-result-list">
            {recentResults.length ? recentResults.map((match) => (
              <button type="button" key={match.id} onClick={() => onSelectMatch(match.id)}>
                <span>
                  {getTeamById(match.homeTeamId).shortName[language]} {match.scoreHome}:{match.scoreAway} {getTeamById(match.awayTeamId).shortName[language]}
                </span>
                <strong>{copy.recent[language]}</strong>
              </button>
            )) : <div className="worldcup-empty">{copy.noRecent[language]}</div>}
          </div>
        </div>
      </motion.section>

      <motion.section className="worldcup-section" {...reveal(0.19)}>
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Medal size={16} />
              {copy.dataStatus[language]}
            </span>
            <p>{copy.disclaimer[language]}</p>
          </div>
        </div>
        <div className="worldcup-lane-grid">
          {WORLD_CUP_CONTENT_LANES.map((lane) => (
            <article className="worldcup-lane-card" key={pickText(lane.title, language)}>
              <span>{pickText(lane.status, language)}</span>
              <strong>{pickText(lane.title, language)}</strong>
              <ul>
                {lane.items[language].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </motion.section>
      </>}
    </div>
  );
};
