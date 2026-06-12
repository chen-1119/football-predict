import React, { useMemo } from 'react';
import { ArrowRight, CalendarDays, Radio, Trophy, Zap } from 'lucide-react';
import { TeamBadge } from './TeamBadge';
import type { Match } from '../services/mockData';
import { getPredictionTipDisplay, getSportteryPoolRows } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import { getBestPrediction, getDaysUntilWorldCup, getWorldCupWatchMatches } from '../services/worldCupData';

interface WorldCupSpotlightProps {
  matches: Match[];
  language: 'zh' | 'en';
  onOpenWorldCup: () => void;
  onSelectMatch: (matchId: string) => void;
}

const formatKickoff = (kickoffTime: string, language: 'zh' | 'en') => {
  return new Date(kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

export const WorldCupSpotlight: React.FC<WorldCupSpotlightProps> = ({
  matches,
  language,
  onOpenWorldCup,
  onSelectMatch
}) => {
  const watchMatches = useMemo(() => getWorldCupWatchMatches(matches, 3), [matches]);
  const featuredMatch = watchMatches[0];
  const featuredPrediction = featuredMatch ? getBestPrediction(featuredMatch) : undefined;
  const poolRows = featuredMatch ? getSportteryPoolRows(featuredMatch, language) : [];
  const featuredOddsRow = poolRows.find((row) => row.odds);
  const homeTeam = featuredMatch ? getTeamById(featuredMatch.homeTeamId) : null;
  const awayTeam = featuredMatch ? getTeamById(featuredMatch.awayTeamId) : null;
  const daysLeft = getDaysUntilWorldCup();

  const copy = {
    kicker: { zh: '世界杯专题', en: 'World Cup Special' },
    title: { zh: '世界因足球而沸腾', en: 'Football Unites The World' },
    subtitle: {
      zh: '热爱不分国界，荣耀即将开战；进入专题看诸神黄昏、小组路径、竞彩开售场次与淘汰赛推演。',
      en: 'Passion has no borders. Open the desk for the last dance, group paths, released fixtures and knockout routes.'
    },
    countdown: { zh: '距揭幕', en: 'Kickoff in' },
    days: { zh: '天', en: 'days' },
    teams: { zh: '48 支球队 / 104 场比赛', en: '48 teams / 104 matches' },
    momentum: { zh: '实时走势', en: 'Live momentum' },
    open: { zh: '进入世界杯专栏', en: 'Open World Cup' },
    today: { zh: '当前观察', en: 'Watch match' },
    empty: { zh: '等待官方赛程同步，先进入专栏查看世界杯活动页。', en: 'Waiting for official fixtures. Open the event page first.' },
    model: { zh: '模型', en: 'Model' },
    sp: { zh: 'SP', en: 'SP' }
  };

  const t = (key: keyof typeof copy) => copy[key][language];

  return (
    <section className="event-spotlight" aria-label={t('kicker')}>
      <div className="event-spotlight-copy">
        <span>
          <Trophy size={15} />
          {t('kicker')}
        </span>
        <h2>{t('title')}</h2>
        <p>{t('subtitle')}</p>
        <div className="event-spotlight-meta">
          <b>
            <CalendarDays size={14} />
            {t('countdown')} {daysLeft} {t('days')}
          </b>
          <b>
            <Zap size={14} />
            {t('teams')}
          </b>
          <b>
            <Radio size={14} />
            {t('momentum')}
          </b>
        </div>
      </div>

      <div className="event-spotlight-card">
        {featuredMatch && homeTeam && awayTeam ? (
          <button type="button" onClick={() => onSelectMatch(featuredMatch.id)}>
            <span>{t('today')}</span>
            <strong>
              <TeamBadge team={homeTeam} size="sm" />
              {homeTeam.shortName[language]}
              <em>VS</em>
              {awayTeam.shortName[language]}
              <TeamBadge team={awayTeam} size="sm" />
            </strong>
            <small>
              {formatKickoff(featuredMatch.kickoffTime, language)}
              {featuredPrediction ? ` / ${t('model')} ${getPredictionTipDisplay(featuredPrediction, language)}` : ''}
            </small>
            {featuredOddsRow?.odds && (
              <small>
                {t('sp')} {featuredOddsRow.odds.odds1.toFixed(2)} / {featuredOddsRow.odds.oddsX.toFixed(2)} / {featuredOddsRow.odds.odds2.toFixed(2)}
              </small>
            )}
          </button>
        ) : (
          <p>{t('empty')}</p>
        )}
        <button type="button" className="event-spotlight-open" onClick={onOpenWorldCup}>
          {t('open')}
          <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
};
