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
  highlights,
  liveMetrics,
  liveTimeline,
  momentumPoints,
  playerLeaders,
  roadToFinal,
  scheduleFilters,
  scheduleMatches,
  standings,
  type EventTeam,
  type ScheduleMatch,
  type Tone
} from '../services/worldCupExperience';

interface WorldCupProps {
  onSelectMatch: (matchId: string) => void;
}

type Locale = 'zh' | 'en';
type FilterKey = (typeof scheduleFilters)[number];

const toneClass = (tone: Tone) => `is-${tone}`;

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
  const statusMap: Record<string, { zh: string; en: string }> = {
    FINISHED: { zh: '已完场', en: 'Finished' },
    LIVE: { zh: '进行中', en: 'Live' },
    SCHEDULED: { zh: '待开赛', en: 'Scheduled' }
  };

  return statusMap[status]?.[language] ?? (language === 'zh' ? '待开赛' : 'Scheduled');
};

const TeamCodeCard = ({ team, align = 'left' }: { team: EventTeam; align?: 'left' | 'right' }) => (
  <div className={`event-team-card is-${align}`} style={{ '--team-color': team.color } as React.CSSProperties}>
    <span className="event-team-seed">Seed {team.seed}</span>
    <strong>{team.name}</strong>
    <small>{team.code}</small>
  </div>
);

const SignalBar = ({ value, tone }: { value: number; tone: Tone }) => (
  <span className={`event-signal-bar ${toneClass(tone)}`} style={{ '--value': `${value}%` } as React.CSSProperties}>
    <span />
  </span>
);

const copy = {
  heroKicker: { zh: '2026 世界杯活动官网', en: '2026 World Cup Event' },
  heroTitle: { zh: 'OWN THE WORLD', en: 'OWN THE WORLD' },
  heroSubtitle: {
    zh: '一屏看懂焦点赛、实时走势、晋级路线、球迷挑战和赛程动态。不是普通预测表，而是为世界杯做的高能互动看板。',
    en: 'A high-energy command center for featured matches, live momentum, qualification routes, fan challenges and matchday flow.'
  },
  heroCta: { zh: '进入赛程中心', en: 'Explore matches' },
  heroAltCta: { zh: '查看球迷区', en: 'Open fan zone' },
  countdown: { zh: '距揭幕', en: 'Kickoff in' },
  featured: { zh: '焦点对决', en: 'Featured Match' },
  matchCenter: { zh: '实时比赛中心', en: 'Live Match Center' },
  tournamentHub: { zh: '赛事枢纽', en: 'Tournament Hub' },
  fanZone: { zh: '球迷互动区', en: 'Fan Zone' },
  schedule: { zh: '赛程日历', en: 'Match Schedule' },
  highlights: { zh: '高光与资讯', en: 'Highlights / News' },
  footerDisclaimer: {
    zh: '本页面为活动官网原型与赛事数据可视化展示，预测与互动内容仅供娱乐和研究参考，请理性看球。',
    en: 'This page is an event-site prototype and data visualization desk. Forecasts and fan content are for entertainment and research only.'
  },
  actualFixtures: { zh: '已接入当前赛程', en: 'Connected fixtures' },
  openAnalysis: { zh: '进入分析', en: 'Open analysis' },
  prediction: { zh: '模型倾向', en: 'Model lean' },
  trust: { zh: '可信度', en: 'Trust' },
  noFixtures: { zh: '当前暂无世界杯相关竞彩赛程，页面先展示活动官网样例。', en: 'No World Cup-related live fixtures yet. Showing event-site samples.' }
};

export const WorldCup: React.FC<WorldCupProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const shouldReduceMotion = useReducedMotion();
  const [activeFilter, setActiveFilter] = useState<FilterKey>('All');
  const [selectedScore, setSelectedScore] = useState('2 - 1');
  const daysLeft = getDaysUntilWorldCup();
  const actualWorldCupMatches = useMemo(() => getWorldCupWatchMatches(matches, 4), [matches]);
  const filteredSchedule = useMemo(() => {
    if (activeFilter === 'All') return scheduleMatches;
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
            <span>Canada / Mexico / USA</span>
            <span>48 teams</span>
            <span>104 matches</span>
          </div>
        </div>

        <div className="event-hero-visual">
          <div className="event-stadium-card">
            <span className="event-ring" />
            <span className="event-field-lines" />
            <strong>26</strong>
            <small>Global football night</small>
          </div>
          <div className="event-countdown">
            <small>{copy.countdown[language]}</small>
            <strong>{daysLeft}</strong>
            <span>days</span>
          </div>
        </div>
      </motion.section>

      <motion.section className="event-featured" {...reveal(0.05)}>
        <div className="event-section-head">
          <span className="event-eyebrow">
            <Flame size={16} />
            {copy.featured[language]}
          </span>
          <h2>Brazil vs France</h2>
          <p>{featuredMatch.stage} / {featuredMatch.venue} / {featuredMatch.kickoff}</p>
        </div>

        <div className="event-featured-grid">
          <TeamCodeCard team={featuredMatch.home} />
          <div className="event-versus">
            <span>LIVE BUILD-UP</span>
            <strong>VS</strong>
            <small>market probability scan</small>
          </div>
          <TeamCodeCard team={featuredMatch.away} align="right" />
        </div>

        <div className="event-count-strip">
          {featuredMatch.countdown.map((item) => (
            <span key={item.label}>
              <strong>{item.value}</strong>
              <small>{item.label}</small>
            </span>
          ))}
        </div>

        <div className="event-odds-strip">
          {featuredMatch.odds.map((item) => (
            <span key={item.label}>
              <small>{item.label}</small>
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
            <span>BRA</span>
            <strong>2 : 1</strong>
            <span>FRA</span>
          </div>
          <small>68' / transition pressure rising</small>
          <div className="event-live-pulse">
            <Activity size={16} />
            Momentum +18 in last 10 minutes
          </div>
        </div>

        <div className="event-metrics">
          {liveMetrics.map((metric) => (
            <article key={metric.label}>
              <header>
                <span>{metric.label}</span>
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
            <span>Momentum</span>
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
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
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
          <h2>Standings, route and leaders in one view</h2>
        </div>

        <div className="event-hub-grid">
          <div className="event-standings">
            <header>
              <strong>Group Pulse</strong>
              <span>Pts / GD</span>
            </header>
            {standings.map((row) => (
              <article key={`${row.group}-${row.team.name}`}>
                <span>Group {row.group}</span>
                <b>{row.team.code}</b>
                <strong>{row.points}</strong>
                <small>{row.goalDiff}</small>
                <em>{row.status}</em>
              </article>
            ))}
          </div>

          <div className="event-road">
            {roadToFinal.map((node) => (
              <article key={node.round}>
                <span>{node.date}</span>
                <strong>{node.round}</strong>
                <small>{node.teams}</small>
                <p>{node.highlight}</p>
              </article>
            ))}
          </div>

          <div className="event-leaders">
            <header>
              <Medal size={18} />
              <strong>Player Index</strong>
            </header>
            {playerLeaders.map((player) => (
              <article key={player.name} className={toneClass(player.tone)}>
                <span>{player.name}</span>
                <div>
                  <strong>{player.value}</strong>
                  <small>{player.team} / {player.stat}</small>
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
          <h2>Predict. Vote. Climb the stand.</h2>
          <p>Score picks, fan missions, voting heat and reward progress sit together so this feels like a campaign, not a static table.</p>
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
            <strong>Fan poll</strong>
            <span>{selectedScore}</span>
          </header>
          {fanPoll.map((option) => (
            <article key={option.label}>
              <span>{option.label}</span>
              <SignalBar value={option.value} tone={option.tone} />
              <strong>{option.value}%</strong>
            </article>
          ))}
        </div>

        <div className="event-task-list">
          {fanTasks.map((task) => (
            <article key={task.title} className={toneClass(task.tone)}>
              <header>
                <Gift size={17} />
                <span>{task.reward}</span>
              </header>
              <strong>{task.title}</strong>
              <SignalBar value={task.progress} tone={task.tone} />
            </article>
          ))}
        </div>

        <div className="event-rank-list">
          <header>
            <Star size={18} />
            <strong>Leaderboard</strong>
          </header>
          {fanRanks.map((rank, index) => (
            <article key={rank.name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{rank.name}</strong>
              <b>{rank.points}</b>
              <small>{rank.streak}</small>
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
          <h2>Matchday flow with status chips</h2>
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
              {filter}
            </button>
          ))}
        </div>

        <div className="event-schedule-grid">
          {filteredSchedule.map((match) => (
            <ScheduleCard key={match.id} match={match} />
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
          <h2>Video energy, tactical bites and fan news</h2>
        </div>
        <div className="event-highlight-grid">
          {highlights.map((item) => (
            <article key={item.title} className={toneClass(item.tone)}>
              <span>{item.type}</span>
              <div className="event-video-mark">
                {item.type === 'Video' ? <Play size={26} /> : <Zap size={26} />}
              </div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              <small>{item.meta}</small>
            </article>
          ))}
        </div>
      </motion.section>

      <footer className="event-footer">
        <div>
          <span className="event-brand-mark">AI</span>
          <strong>OWN THE WORLD</strong>
          <p>{copy.footerDisclaimer[language]}</p>
        </div>
        <nav aria-label="World Cup footer">
          <a href="#event-schedule">Schedule</a>
          <a href="#event-fans">Fan Zone</a>
          <a href="#top">Terms</a>
          <a href="#top">Privacy</a>
        </nav>
      </footer>
    </div>
  );
};

const ScheduleCard = ({ match }: { match: ScheduleMatch }) => (
  <article className={`event-schedule-card ${toneClass(match.tone)}`}>
    <header>
      <span>{match.status}</span>
      <strong>{match.time}</strong>
    </header>
    <div className="event-schedule-teams">
      <TeamCodeCard team={match.home} />
      <div>
        <b>{match.score ?? 'VS'}</b>
        <small>{match.stage}</small>
      </div>
      <TeamCodeCard team={match.away} align="right" />
    </div>
    <div className="event-schedule-tags">
      {match.tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  </article>
);
