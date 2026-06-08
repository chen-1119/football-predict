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
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getSportteryPoolRows } from '../services/bettingDisplay';
import { getLeagueById, getTeamById } from '../services/entities';
import type { Match, MultiLangString } from '../services/mockData';
import {
  getBestPrediction,
  getDaysUntilWorldCup,
  getMatchTrust,
  getWorldCupContenders,
  getWorldCupGroupForecasts,
  getWorldCupKnockoutForecast,
  getWorldCupProjectedQualifiers,
  getWorldCupRecentResults,
  getWorldCupUpsetRadar,
  getWorldCupWatchMatches,
  isWorldCupRelevantMatch,
  WORLD_CUP_CONTENT_LANES,
  WORLD_CUP_FORECAST_MODEL,
  WORLD_CUP_KNOCKOUT_ROUNDS,
  WORLD_CUP_OFFICIAL,
  WORLD_CUP_PIPELINE_CARDS,
  WORLD_CUP_STAGE_CARDS,
  type WorldCupTeamForecast
} from '../services/worldCupData';

interface WorldCupProps {
  onSelectMatch: (matchId: string) => void;
}

type Locale = 'zh' | 'en';

const copy = {
  kicker: { zh: '2026 世界杯专题', en: 'World Cup 2026' },
  heroTitle: { zh: '世界杯预测中台', en: 'World Cup Forecast Desk' },
  heroSubtitle: {
    zh: '小组赛路径、最佳第三名、32 强路线、竞彩开售场次和赛后复盘集中展示。世界杯只展示世界杯内容，开售后自动并入官方 SP 与临场信号。',
    en: 'Groups, best third-place routes, Round of 32 pathing, released Sporttery fixtures and post-match review in one desk.'
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
  groupsDesc: { zh: '使用球队强度、东道主加成、新军降权和小组全局竞争进行路径推演；世界杯 SP 上线后会自动进入单场概率。', en: 'Uses team strength, host boost, debutant adjustment and full-group competition.' },
  bestThird: { zh: '最佳第三名竞争线', en: 'Best Third-Place Lane' },
  bestThirdNote: { zh: '第三名不是固定晋级，按积分、净胜球、进球数和强度排序抢 8 个名额。', en: 'Third-place teams compete for eight spots by points, goal difference, goals and strength.' },
  knockout: { zh: '淘汰赛路线', en: 'Knockout Route' },
  knockoutDesc: { zh: '先用小组路径生成 32 强候选，再估算 16 强、8 强、4 强、决赛和冠军层级。', en: 'Group projections seed the Round of 32, then estimate later-round paths.' },
  fixtures: { zh: '世界杯竞彩场次', en: 'World Cup Sporttery Fixtures' },
  fixturesDesc: { zh: '只展示世界杯正赛窗口内的竞彩场次；未开售时保留赛制与路径预测，开售后接入 SP、让球和临场变化。', en: 'Only released tournament fixtures are shown here; SP and handicap join after release.' },
  noFixtures: { zh: '当前还没有已开售的世界杯正赛竞彩场次；页面先展示赛制、小组路径和淘汰赛推演，开售后会自动出现单场卡片。', en: 'No released World Cup Sporttery fixtures yet. Format and route projections remain visible until SP is available.' },
  contenders: { zh: '争冠观察', en: 'Contender Watch' },
  upset: { zh: '爆冷雷达', en: 'Upset Radar' },
  dataStatus: { zh: '数据覆盖', en: 'Data Coverage' },
  dataStatusDesc: { zh: '已覆盖世界杯结构、小组路径、晋级规则、淘汰赛路线和当前竞彩场次；官方 SP、让球、赛果、临场赔率在开售/完场后并入。', en: 'Covers structure, group pathing, rules, knockout routes and released fixtures.' },
  pipeline: { zh: '专题数据流', en: 'Data Pipeline' },
  recent: { zh: '赛果复盘', en: 'Recent Reviews' },
  more: { zh: '查看详情', en: 'Details' },
  noRecent: { zh: '世界杯正赛尚未产生可复盘赛果。', en: 'No tournament results to review yet.' },
  trust: { zh: '可信', en: 'Trust' },
  sp: { zh: 'SP', en: 'SP' },
  recommendation: { zh: '模型倾向', en: 'Model Lean' },
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

const TeamFlag = ({ team, language }: { team: WorldCupTeamForecast; language: Locale }) => (
  <span className={`worldcup-team-flag ${team.id === 'morocco' ? 'is-morocco' : ''}`} aria-label={getTeamName(team, language)}>
    <b>{team.flag}</b>
  </span>
);

const GroupTeamRow = ({ team, language }: { team: WorldCupTeamForecast; language: Locale }) => {
  const status = team.projectedRank <= 2
    ? (language === 'zh' ? '直通区' : 'Direct')
    : team.projectedRank === 3
      ? (language === 'zh' ? '第三名竞争' : 'Third-place race')
      : (language === 'zh' ? '出局风险' : 'Elimination risk');

  return (
    <article className="worldcup-group-team-row">
      <TeamFlag team={team} language={language} />
      <div className="worldcup-team-copy">
        <strong>{getTeamName(team, language)}</strong>
        <small>
          FIFA {team.fifaRank} / {language === 'zh' ? '均分' : 'Pts'} {team.projectedPoints.toFixed(1)}
        </small>
        <em>{status}</em>
      </div>
      <div className="worldcup-team-prob">
        <b>{formatPercent(team.advanceProbability)}</b>
        <small>{language === 'zh' ? '晋级' : 'Advance'}</small>
      </div>
      <div className="worldcup-team-split">
        <small>{language === 'zh' ? '头名' : 'Win'} {formatPercent(team.groupWinProbability)}</small>
        <small>{language === 'zh' ? '直通' : 'Top 2'} {formatPercent(team.directAdvanceProbability)}</small>
        <small>{language === 'zh' ? '第三线' : 'Best 3rd'} {formatPercent(team.bestThirdProbability)}</small>
      </div>
      <span className="worldcup-team-meter" aria-hidden="true">
        <span style={{ '--advance': `${team.advanceProbability}%` } as React.CSSProperties} />
      </span>
    </article>
  );
};

const MatchCard = ({ match, language, onSelectMatch }: { match: Match; language: Locale; onSelectMatch: (id: string) => void }) => {
  const home = getTeamById(match.homeTeamId);
  const away = getTeamById(match.awayTeamId);
  const league = getLeagueById(match.leagueId);
  const prediction = getBestPrediction(match);
  const trust = getMatchTrust(match);
  const pools = getSportteryPoolRows(match, language);
  const had = pools.find((pool) => pool.poolCode === 'HAD');
  const hhad = pools.find((pool) => pool.poolCode === 'HHAD');

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
        <span>{league.shortName[language]}</span>
        <span>{copy.recommendation[language]} {prediction ? getPredictionTipDisplay(prediction, language, true) : copy.waiting[language]}</span>
        <span>{copy.trust[language]} {trust ? `${trust}%` : '--'}</span>
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
        <div className="worldcup-odds-strip is-empty">{copy.waiting[language]} HAD SP</div>
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

export const WorldCup: React.FC<WorldCupProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const shouldReduceMotion = useReducedMotion();
  const daysLeft = getDaysUntilWorldCup();

  const groupForecasts = useMemo(() => getWorldCupGroupForecasts(), []);
  const qualifiers = useMemo(() => getWorldCupProjectedQualifiers(groupForecasts), [groupForecasts]);
  const knockoutRoutes = useMemo(() => getWorldCupKnockoutForecast(groupForecasts), [groupForecasts]);
  const allWorldCupMatches = useMemo(
    () => matches.filter(isWorldCupRelevantMatch).sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime)),
    [matches]
  );
  const watchMatches = useMemo(() => getWorldCupWatchMatches(matches, 8), [matches]);
  const recentResults = useMemo(() => getWorldCupRecentResults(matches, 5), [matches]);
  const contenders = useMemo(() => getWorldCupContenders(matches, 5), [matches]);
  const upsetRadar = useMemo(() => getWorldCupUpsetRadar(matches, 5), [matches]);

  const bestThird = qualifiers.bestThird;
  const updatedAt = dataSync.sourceUpdatedAt || dataSync.updatedAt || dataSync.lastCheckedAt;
  const pageCheckedAt = dataSync.lastCheckedAt;

  const reveal = (delay = 0) => shouldReduceMotion ? {} : {
    initial: { opacity: 0, y: 22 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.16 },
    transition: { duration: 0.46, delay }
  };

  const kpis = [
    { icon: Users, label: copy.kpis.teams[language], value: WORLD_CUP_OFFICIAL.teams, detail: pickText(WORLD_CUP_OFFICIAL.host, language) },
    { icon: CalendarDays, label: copy.kpis.matches[language], value: WORLD_CUP_OFFICIAL.matches, detail: `${WORLD_CUP_OFFICIAL.startDate} - ${WORLD_CUP_OFFICIAL.finalDate}` },
    { icon: Flag, label: copy.kpis.groups[language], value: WORLD_CUP_OFFICIAL.groups, detail: language === 'zh' ? '12 组 x 4 队' : '12 groups x 4 teams' },
    { icon: Trophy, label: copy.kpis.venues[language], value: WORLD_CUP_OFFICIAL.venues, detail: language === 'zh' ? '加拿大 / 墨西哥 / 美国' : 'Canada / Mexico / USA' },
    { icon: Target, label: copy.kpis.sporttery[language], value: allWorldCupMatches.length || watchMatches.length, detail: watchMatches.length ? (language === 'zh' ? '已进入观察池' : 'In watch pool') : copy.waiting[language] },
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
            {copy.kicker[language]}
          </span>
          <h2>{copy.heroTitle[language]}</h2>
          <p>{copy.heroSubtitle[language]}</p>
          <div className="worldcup-spotlight-stats">
            <span><strong>{WORLD_CUP_OFFICIAL.teams}</strong> {copy.kpis.teams[language]}</span>
            <span><strong>{WORLD_CUP_OFFICIAL.matches}</strong> {copy.kpis.matches[language]}</span>
            <span><strong>{WORLD_CUP_OFFICIAL.groups}</strong> {copy.kpis.groups[language]}</span>
            <span><strong>{allWorldCupMatches.length || watchMatches.length}</strong> {copy.kpis.sporttery[language]}</span>
            <span className="worldcup-sync-pill">
              <RefreshCw size={14} />
              {pageCheckedAt ? formatDateTime(pageCheckedAt, language) : '--'}
            </span>
          </div>
          <div className="worldcup-spotlight-hosts">
            <span>加拿大</span>
            <span>墨西哥</span>
            <span>美国</span>
          </div>
        </div>
        <div className="worldcup-spotlight-side">
          {watchMatches.length ? (
            watchMatches.slice(0, 3).map((match) => (
              <button className="worldcup-mini-match" type="button" key={match.id} onClick={() => onSelectMatch(match.id)}>
                <span className="worldcup-mini-label">{formatDateTime(match.kickoffTime, language)}</span>
                <span className="worldcup-mini-teams">
                  <span>{getTeamById(match.homeTeamId).shortName[language]}</span>
                  <b>VS</b>
                  <span>{getTeamById(match.awayTeamId).shortName[language]}</span>
                </span>
                <span className="worldcup-mini-meta">
                  {getBestPrediction(match) ? getPredictionTipDisplay(getBestPrediction(match)!, language, true) : copy.waiting[language]}
                </span>
                <span className="worldcup-mini-action">
                  {copy.more[language]}
                  <ChevronRight size={15} />
                </span>
              </button>
            ))
          ) : (
            knockoutRoutes.slice(0, 3).map((route) => (
              <div className="worldcup-mini-match" key={`fallback-${route.team.id}`}>
                <span className="worldcup-mini-label">{language === 'zh' ? '争冠路径观察' : 'Title route watch'}</span>
                <span className="worldcup-mini-teams">
                  <span>{route.team.flag} {getTeamName(route.team, language)}</span>
                  <b>{formatPercent(route.champion)}</b>
                  <span>{language === 'zh' ? '冠军概率' : 'champion'}</span>
                </span>
                <span className="worldcup-mini-meta">
                  Group {route.team.groupId} / 32强 {formatPercent(route.round32)} / 8强 {formatPercent(route.quarterFinal)}
                </span>
                <span className="worldcup-mini-action">
                  {copy.waiting[language]} SP
                  <ChevronRight size={15} />
                </span>
              </div>
            ))
          )}
        </div>
      </motion.section>

      <motion.section className="worldcup-hero-panel" {...reveal(0.03)}>
        <div className="worldcup-hero-copy">
          <span className="worldcup-kicker">
            <Sparkles size={16} />
            {pickText(WORLD_CUP_OFFICIAL.name, language)}
          </span>
          <h1>OWN THE WORLD</h1>
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
            <small>AI FORECAST</small>
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
          {groupForecasts.map((group) => (
            <article className="worldcup-group-card" key={group.id}>
              <header>
                <span>Group {group.id}</span>
                <strong>{pickText(group.dates, language)}</strong>
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
                <TeamFlag team={team} language={language} />
                {getTeamName(team, language)}
                <small>{formatPercent(team.bestThirdProbability)} / {team.projectedPoints.toFixed(1)}分</small>
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
          <div className="worldcup-route-list">
            {knockoutRoutes.slice(0, 10).map((route) => (
              <article key={route.team.id}>
                <TeamFlag team={route.team} language={language} />
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
        {watchMatches.length ? (
          <div className="worldcup-match-grid">
            {watchMatches.map((match) => (
              <MatchCard key={match.id} match={match} language={language} onSelectMatch={onSelectMatch} />
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
                    <small>{copy.trust[language]}</small>
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
    </div>
  );
};
