import React, { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  ChevronRight,
  Flame,
  Gauge,
  Gift,
  Medal,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Star,
  Trophy,
  Users,
  Vote,
  Zap
} from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import { getPredictionTipDisplay, getSportteryPoolRows } from '../services/bettingDisplay';
import { getLeagueById, getTeamById } from '../services/entities';
import { getBestPrediction, getDaysUntilWorldCup, getMatchTrust, getWorldCupWatchMatches } from '../services/worldCupData';
import {
  fanPoll,
  fanRanks,
  fanTasks,
  featuredMatch,
  highlightTypeLabels,
  highlights,
  liveMetrics,
  liveTimeline,
  momentumPoints,
  playerLeaders,
  roadToFinal,
  scheduleFilterLabels,
  scheduleFilters,
  scheduleMatches,
  scheduleStatusLabels,
  standingStatusLabels,
  standings,
  type EventTeam,
  type EventText,
  type ScheduleMatch,
  type Tone
} from '../services/worldCupExperience';

interface WorldCupProps {
  onSelectMatch: (matchId: string) => void;
}

type Locale = 'zh' | 'en';
type FilterKey = (typeof scheduleFilters)[number];

const toneClass = (tone: Tone) => `is-${tone}`;
const text = (value: EventText, language: Locale) => value[language];

const formatDateTime = (isoTime: string, language: Locale) => {
  return new Date(isoTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const formatMatchStatus = (status: string, language: Locale) => {
  const statusMap: Record<string, EventText> = {
    FINISHED: { zh: '已完场', en: 'Finished' },
    LIVE: { zh: '进行中', en: 'Live' },
    PENDING_RESULT: { zh: '待赛果', en: 'Result pending' },
    SCHEDULED: { zh: '待开赛', en: 'Scheduled' }
  };

  return statusMap[status]?.[language] ?? (language === 'zh' ? '待开赛' : 'Scheduled');
};

const TeamCodeCard = ({
  team,
  language,
  align = 'left'
}: {
  team: EventTeam;
  language: Locale;
  align?: 'left' | 'right';
}) => (
  <div className={`event-team-card is-${align}`} style={{ '--team-color': team.color } as React.CSSProperties}>
    <span className="event-team-flag" aria-hidden="true">{team.flag ?? team.code}</span>
    <span className="event-team-seed">{language === 'zh' ? `FIFA 排名 ${team.seed}` : `FIFA rank ${team.seed}`}</span>
    <strong>{text(team.name, language)}</strong>
    <small>{team.code}</small>
  </div>
);

const SignalBar = ({ value, tone }: { value: number; tone: Tone }) => (
  <span className={`event-signal-bar ${toneClass(tone)}`} style={{ '--value': `${value}%` } as React.CSSProperties}>
    <span />
  </span>
);

const copy = {
  heroKicker: { zh: '2026 世界杯专题', en: '2026 World Cup Event' },
  heroTitle: { zh: '主宰世界', en: 'Own the World' },
  heroSubtitle: {
    zh: '一屏看懂焦点赛、实时走势、晋级路线、球迷挑战和赛程动态。这里不是普通预测表，而是为世界杯准备的沉浸式赛事看板。',
    en: 'A high-energy command center for featured matches, live momentum, qualification routes, fan challenges and matchday flow.'
  },
  heroCta: { zh: '进入赛程中心', en: 'Explore matches' },
  heroAltCta: { zh: '查看球迷区', en: 'Open fan zone' },
  hostCountries: { zh: '加拿大 / 墨西哥 / 美国', en: 'Canada / Mexico / USA' },
  teamCount: { zh: '48 支球队', en: '48 teams' },
  matchCount: { zh: '104 场比赛', en: '104 matches' },
  stadiumLabel: { zh: '全球足球之夜', en: 'Global football night' },
  countdown: { zh: '距开赛', en: 'Kickoff in' },
  days: { zh: '天', en: 'days' },
  featured: { zh: '焦点对决', en: 'Featured Match' },
  liveBuildUp: { zh: '赛前焦点', en: 'Pre-match focus' },
  probabilityScan: { zh: '开售后接入官方 SP', en: 'Official SP after release' },
  matchCenter: { zh: '赛前数据中心', en: 'Pre-match Data Center' },
  liveStatus: { zh: '世界杯正赛未开赛 / 等待官方临场数据', en: 'Tournament not started / awaiting official live data' },
  livePulse: { zh: '开赛后自动切换比分、事件和走势', en: 'Live score, events and momentum switch on after kickoff' },
  momentum: { zh: '赛事时间线', en: 'Tournament Timeline' },
  tournamentHub: { zh: '赛事枢纽', en: 'Tournament Hub' },
  hubTitle: { zh: '分组、晋级路线和球队指数一屏呈现', en: 'Groups, route and team index in one view' },
  groupPulse: { zh: '小组脉搏', en: 'Group Pulse' },
  ptsGd: { zh: '积分 / 净胜球', en: 'Pts / GD' },
  groupPrefix: { zh: '小组', en: 'Group' },
  playerIndex: { zh: '球队指数', en: 'Team Index' },
  fanZone: { zh: '球迷互动区', en: 'Fan Zone' },
  fanTitle: { zh: '预测比分、参与投票、冲击榜单', en: 'Predict. Vote. Climb the stand.' },
  fanSubtitle: {
    zh: '比分选择、球迷任务、投票热度和积分榜放在一起，让世界杯专题更像活动场，而不是一张静态表。',
    en: 'Score picks, fan missions, voting heat and reward progress sit together so this feels like a campaign, not a static table.'
  },
  fanPoll: { zh: '球迷投票', en: 'Fan poll' },
  leaderboard: { zh: '球迷榜单', en: 'Leaderboard' },
  schedule: { zh: '赛程日历', en: 'Match Schedule' },
  scheduleTitle: { zh: '按官方赛程状态快速筛选', en: 'Official matchday flow with status chips' },
  highlights: { zh: '高光与资讯', en: 'Highlights / News' },
  highlightTitle: { zh: '赛程速览、规则说明和球迷互动', en: 'Schedule notes, rules and fan activity' },
  footerBrand: { zh: '主宰世界', en: 'Own the World' },
  footerSchedule: { zh: '赛程', en: 'Schedule' },
  footerFanZone: { zh: '球迷区', en: 'Fan Zone' },
  footerTerms: { zh: '服务条款', en: 'Terms' },
  footerPrivacy: { zh: '隐私政策', en: 'Privacy' },
  footerDisclaimer: {
    zh: '本页面为世界杯专题活动页与数据可视化看板。预测与互动内容仅供娱乐和研究参考，请理性看球。',
    en: 'This page is an event-site prototype and data visualization desk. Forecasts and fan content are for entertainment and research only.'
  },
  actualFixtures: { zh: '世界杯竞彩场次', en: 'World Cup fixtures' },
  prediction: { zh: '模型倾向', en: 'Model lean' },
  trust: { zh: '可信度', en: 'Trust' },
  noFixtures: {
    zh: '当前暂无已开售的世界杯竞彩场次；页面展示官方赛程与分组专题，开售后会自动并入实时 SP。',
    en: 'No released World Cup Sporttery fixtures yet. Official schedule and group content are shown until SP is available.'
  }
};

export const WorldCup: React.FC<WorldCupProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const shouldReduceMotion = useReducedMotion();
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [selectedScore, setSelectedScore] = useState('2 - 1');
  const daysLeft = getDaysUntilWorldCup();
  const actualWorldCupMatches = useMemo(() => getWorldCupWatchMatches(matches, 4), [matches]);
  const filteredSchedule = useMemo(() => {
    if (activeFilter === 'all') return scheduleMatches;
    return scheduleMatches.filter((match) => match.status === activeFilter);
  }, [activeFilter]);

  const reveal = (delay = 0) => shouldReduceMotion ? {} : {
    initial: { opacity: 0, y: 28 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.18 },
    transition: { duration: 0.6, delay }
  };

  const updatedAt = dataSync.lastCheckedAt ? formatDateTime(dataSync.lastCheckedAt, language) : '--';

  return (
    <div id="top" className="event-page">
      <div className="event-sky" aria-hidden="true">
        <span className="event-beam event-beam-a" />
        <span className="event-beam event-beam-b" />
        <span className="event-speed-lines" />
        <span className="event-particles" />
      </div>

      <motion.section className="event-hero" {...reveal()}>
        <div className="event-hero-copy">
          <span className="event-eyebrow">
            <Trophy size={16} />
            {copy.heroKicker[language]}
          </span>
          <h1>{copy.heroTitle[language]}</h1>
          <p>{copy.heroSubtitle[language]}</p>
          <div className="event-hero-actions">
            <a href="#event-schedule" className="event-action is-primary">
              {copy.heroCta[language]}
              <ArrowRight size={17} />
            </a>
            <a href="#event-fans" className="event-action">
              {copy.heroAltCta[language]}
              <Users size={17} />
            </a>
          </div>
          <div className="event-hero-badges" aria-label="Event meta">
            <span>{copy.hostCountries[language]}</span>
            <span>{copy.teamCount[language]}</span>
            <span>{copy.matchCount[language]}</span>
          </div>
        </div>

        <div className="event-hero-visual">
          <div className="event-stadium-card">
            <span className="event-ring" />
            <span className="event-field-lines" />
            <strong>26</strong>
            <small>{copy.stadiumLabel[language]}</small>
          </div>
          <div className="event-countdown">
            <small>{copy.countdown[language]}</small>
            <strong>{daysLeft}</strong>
            <span>{copy.days[language]}</span>
          </div>
        </div>
      </motion.section>

      <motion.section className="event-featured" {...reveal(0.05)}>
        <div className="event-section-head">
          <span className="event-eyebrow">
            <Flame size={16} />
            {copy.featured[language]}
          </span>
          <h2>{text(featuredMatch.home.name, language)} vs {text(featuredMatch.away.name, language)}</h2>
          <p>{text(featuredMatch.stage, language)} / {text(featuredMatch.venue, language)} / {text(featuredMatch.kickoff, language)}</p>
        </div>

        <div className="event-featured-grid">
          <TeamCodeCard team={featuredMatch.home} language={language} />
          <div className="event-versus">
            <span>{copy.liveBuildUp[language]}</span>
            <strong>VS</strong>
            <small>{copy.probabilityScan[language]}</small>
          </div>
          <TeamCodeCard team={featuredMatch.away} language={language} align="right" />
        </div>

        <div className="event-count-strip">
          {featuredMatch.countdown.map((item) => (
            <span key={item.label.en}>
              <strong>{item.value}</strong>
              <small>{text(item.label, language)}</small>
            </span>
          ))}
        </div>

        <div className="event-odds-strip">
          {featuredMatch.odds.map((item) => (
            <span key={item.label.en}>
              <small>{text(item.label, language)}</small>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      </motion.section>

      <motion.section className="event-live" {...reveal(0.08)}>
        <div className="event-live-score">
          <span className="event-eyebrow">
            <Radio size={16} />
            {copy.matchCenter[language]}
          </span>
          <div className="event-scoreline">
            <span>{featuredMatch.home.code}</span>
            <strong>VS</strong>
            <span>{featuredMatch.away.code}</span>
          </div>
          <small>{copy.liveStatus[language]}</small>
          <div className="event-live-pulse">
            <Activity size={16} />
            {copy.livePulse[language]}
          </div>
        </div>

        <div className="event-metrics">
          {liveMetrics.map((metric) => (
            <article key={metric.label.en}>
              <header>
                <span>{text(metric.label, language)}</span>
                <strong>{metric.home}{metric.suffix ?? ''} / {metric.away}{metric.suffix ?? ''}</strong>
              </header>
              <div className="event-dual-meter">
                <span style={{ width: `${Math.min(100, metric.home)}%` }} />
                <b style={{ width: `${Math.min(100, metric.away)}%` }} />
              </div>
            </article>
          ))}
        </div>

        <div className="event-momentum-card">
          <header>
            <span>{copy.momentum[language]}</span>
            <Gauge size={18} />
          </header>
          <div className="event-momentum-bars">
            {momentumPoints.map((point, index) => (
              <span key={`${point}-${index}`} style={{ height: `${point}%` }} />
            ))}
          </div>
        </div>

        <div className="event-timeline">
          {liveTimeline.map((item) => (
            <article key={item.minute} className={toneClass(item.tone)}>
              <span>{item.minute}</span>
              <div>
                <strong>{text(item.title, language)}</strong>
                <p>{text(item.detail, language)}</p>
              </div>
            </article>
          ))}
        </div>
      </motion.section>

      <motion.section className="event-hub" {...reveal(0.1)}>
        <div className="event-section-head">
          <span className="event-eyebrow">
            <ShieldCheck size={16} />
            {copy.tournamentHub[language]}
          </span>
          <h2>{copy.hubTitle[language]}</h2>
        </div>

        <div className="event-hub-grid">
          <div className="event-standings">
            <header>
              <strong>{copy.groupPulse[language]}</strong>
              <span>{copy.ptsGd[language]}</span>
            </header>
            {standings.map((row) => (
              <article key={`${row.group}-${row.team.code}`}>
                <span>{copy.groupPrefix[language]} {row.group}</span>
                <b>{row.team.code}</b>
                <strong>{row.points}</strong>
                <small>{row.goalDiff}</small>
                <em>{text(standingStatusLabels[row.status], language)}</em>
              </article>
            ))}
          </div>

          <div className="event-road">
            {roadToFinal.map((node) => (
              <article key={node.round.en}>
                <span>{text(node.date, language)}</span>
                <strong>{text(node.round, language)}</strong>
                <small>{text(node.teams, language)}</small>
                <p>{text(node.highlight, language)}</p>
              </article>
            ))}
          </div>

          <div className="event-leaders">
            <header>
              <Medal size={18} />
              <strong>{copy.playerIndex[language]}</strong>
            </header>
            {playerLeaders.map((player) => (
              <article key={player.name.en} className={toneClass(player.tone)}>
                <span>{text(player.name, language)}</span>
                <div>
                  <strong>{player.value}</strong>
                  <small>{text(player.team, language)} / {text(player.stat, language)}</small>
                </div>
              </article>
            ))}
          </div>
        </div>
      </motion.section>

      <motion.section id="event-fans" className="event-fans" {...reveal(0.12)}>
        <div className="event-fan-copy">
          <span className="event-eyebrow">
            <Sparkles size={16} />
            {copy.fanZone[language]}
          </span>
          <h2>{copy.fanTitle[language]}</h2>
          <p>{copy.fanSubtitle[language]}</p>
          <div className="event-score-picker">
            {['1 - 0', '2 - 1', '1 - 1', '3 - 2'].map((score) => (
              <button
                key={score}
                type="button"
                className={selectedScore === score ? 'active' : ''}
                onClick={() => setSelectedScore(score)}
              >
                {score}
              </button>
            ))}
          </div>
        </div>

        <div className="event-fan-panel">
          <header>
            <Vote size={18} />
            <strong>{copy.fanPoll[language]}</strong>
            <span>{selectedScore}</span>
          </header>
          {fanPoll.map((option) => (
            <article key={option.label.en}>
              <span>{text(option.label, language)}</span>
              <SignalBar value={option.value} tone={option.tone} />
              <strong>{option.value}%</strong>
            </article>
          ))}
        </div>

        <div className="event-task-list">
          {fanTasks.map((task) => (
            <article key={task.title.en} className={toneClass(task.tone)}>
              <header>
                <Gift size={17} />
                <span>{text(task.reward, language)}</span>
              </header>
              <strong>{text(task.title, language)}</strong>
              <SignalBar value={task.progress} tone={task.tone} />
            </article>
          ))}
        </div>

        <div className="event-rank-list">
          <header>
            <Star size={18} />
            <strong>{copy.leaderboard[language]}</strong>
          </header>
          {fanRanks.map((rank, index) => (
            <article key={rank.name.en}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{text(rank.name, language)}</strong>
              <b>{rank.points}</b>
              <small>{text(rank.streak, language)}</small>
            </article>
          ))}
        </div>
      </motion.section>

      <motion.section id="event-schedule" className="event-schedule" {...reveal(0.14)}>
        <div className="event-section-head">
          <span className="event-eyebrow">
            <CalendarDays size={16} />
            {copy.schedule[language]}
          </span>
          <h2>{copy.scheduleTitle[language]}</h2>
          <p>{copy.actualFixtures[language]} / {updatedAt}</p>
        </div>

        <div className="event-filter-row">
          {scheduleFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              className={activeFilter === filter ? 'active' : ''}
              onClick={() => setActiveFilter(filter)}
            >
              {text(scheduleFilterLabels[filter], language)}
            </button>
          ))}
        </div>

        <div className="event-schedule-grid">
          {filteredSchedule.map((match) => (
            <ScheduleCard key={match.id} match={match} language={language} />
          ))}
        </div>

        <div className="event-connected-fixtures">
          <header>
            <BadgeCheck size={18} />
            <strong>{copy.actualFixtures[language]}</strong>
          </header>
          {actualWorldCupMatches.length === 0 ? (
            <p>{copy.noFixtures[language]}</p>
          ) : (
            actualWorldCupMatches.map((match) => {
              const home = getTeamById(match.homeTeamId);
              const away = getTeamById(match.awayTeamId);
              const league = getLeagueById(match.leagueId);
              const prediction = getBestPrediction(match);
              const trust = getMatchTrust(match);
              const poolRows = getSportteryPoolRows(match, language);
              const odds = poolRows.find((row) => row.odds)?.odds;

              return (
                <button key={match.id} type="button" onClick={() => onSelectMatch(match.id)}>
                  <span className="event-fixture-time">
                    {formatDateTime(match.kickoffTime, language)}
                    <small>{formatMatchStatus(match.status, language)}</small>
                  </span>
                  <span className="event-fixture-teams">
                    <TeamBadge team={home} size="sm" />
                    <strong>{home.shortName[language]} vs {away.shortName[language]}</strong>
                    <TeamBadge team={away} size="sm" />
                  </span>
                  <span className="event-fixture-meta">
                    {league.name[language]}
                    <small>{copy.prediction[language]} {prediction ? getPredictionTipDisplay(prediction, language) : '--'}</small>
                  </span>
                  <span className="event-fixture-odds">
                    {odds ? `${odds.odds1.toFixed(2)} / ${odds.oddsX.toFixed(2)} / ${odds.odds2.toFixed(2)}` : 'SP --'}
                    <small>{copy.trust[language]} {trust ? `${trust}%` : '--'}</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              );
            })
          )}
        </div>
      </motion.section>

      <motion.section className="event-highlights" {...reveal(0.16)}>
        <div className="event-section-head">
          <span className="event-eyebrow">
            <Play size={16} />
            {copy.highlights[language]}
          </span>
          <h2>{copy.highlightTitle[language]}</h2>
        </div>
        <div className="event-highlight-grid">
          {highlights.map((item) => (
            <article key={item.title.en} className={toneClass(item.tone)}>
              <span>{text(highlightTypeLabels[item.type], language)}</span>
              <div className="event-video-mark">
                {item.type === 'video' ? <Play size={26} /> : <Zap size={26} />}
              </div>
              <strong>{text(item.title, language)}</strong>
              <p>{text(item.detail, language)}</p>
              <small>{text(item.meta, language)}</small>
            </article>
          ))}
        </div>
      </motion.section>

      <footer className="event-footer">
        <div>
          <span className="event-brand-mark">AI</span>
          <strong>{copy.footerBrand[language]}</strong>
          <p>{copy.footerDisclaimer[language]}</p>
        </div>
        <nav aria-label="World Cup footer">
          <a href="#event-schedule">{copy.footerSchedule[language]}</a>
          <a href="#event-fans">{copy.footerFanZone[language]}</a>
          <a href="#top">{copy.footerTerms[language]}</a>
          <a href="#top">{copy.footerPrivacy[language]}</a>
        </nav>
      </footer>
    </div>
  );
};

const ScheduleCard = ({ match, language }: { match: ScheduleMatch; language: Locale }) => (
  <article className={`event-schedule-card ${toneClass(match.tone)}`}>
    <header>
      <span>{text(scheduleStatusLabels[match.status], language)}</span>
      <strong>{text(match.time, language)}</strong>
    </header>
    <div className="event-schedule-teams">
      <TeamCodeCard team={match.home} language={language} />
      <div>
        <b>{match.score ?? 'VS'}</b>
        <small>{text(match.stage, language)}</small>
      </div>
      <TeamCodeCard team={match.away} language={language} align="right" />
    </div>
    <div className="event-schedule-tags">
      {match.tags.map((tag) => (
        <span key={tag.en}>{text(tag, language)}</span>
      ))}
    </div>
  </article>
);
