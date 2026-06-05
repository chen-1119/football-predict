import React, { useMemo } from 'react';
import { ArrowRight, CalendarDays, ShieldCheck, Trophy } from 'lucide-react';
import type { Match } from '../services/mockData';
import { getPredictionTipDisplay, getSportteryPoolRows } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import {
  getBestPrediction,
  getDaysUntilWorldCup,
  getWorldCupWatchMatches,
  WORLD_CUP_OFFICIAL
} from '../services/worldCupData';
import { TeamBadge } from './TeamBadge';

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
  const homeTeam = featuredMatch ? getTeamById(featuredMatch.homeTeamId) : null;
  const awayTeam = featuredMatch ? getTeamById(featuredMatch.awayTeamId) : null;
  const daysLeft = getDaysUntilWorldCup();

  const copy = {
    kicker: { zh: '世界杯专栏', en: 'World Cup Desk' },
    title: { zh: '2026 世界杯观察池已开启', en: 'World Cup 2026 watch pool is live' },
    subtitle: {
      zh: '48 队、104 场、12 个小组；当前先接入竞彩国际赛与世界杯相关赛程，后续世界杯正赛自动进入推荐池。',
      en: '48 teams, 104 matches, 12 groups; Sporttery international and World Cup-related fixtures feed this pool first.'
    },
    countdown: { zh: '距开赛', en: 'Kickoff in' },
    days: { zh: '天', en: 'days' },
    format: { zh: '12组 x 4队', en: '12 groups x 4' },
    fixtures: { zh: '104场', en: '104 matches' },
    official: { zh: '官方赛程窗口', en: 'Official window' },
    enter: { zh: '进入专栏', en: 'Open Desk' },
    match: { zh: '今日观察', en: 'Watch match' },
    noMatch: { zh: '等待中国竞彩网同步世界杯相关赛程', en: 'Waiting for World Cup-related Sporttery fixtures' },
    view: { zh: '查看分析', en: 'View analysis' },
    odds: { zh: '竞彩 SP', en: 'Sporttery SP' },
    model: { zh: '模型倾向', en: 'Model lean' }
  };

  const t = (key: keyof typeof copy) => copy[key][language];

  return (
    <section className="worldcup-spotlight" aria-label={t('kicker')}>
      <div className="worldcup-spotlight-main">
        <span className="worldcup-kicker">
          <Trophy size={15} />
          {t('kicker')}
        </span>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
        <div className="worldcup-spotlight-stats">
          <span>
            <CalendarDays size={14} />
            {t('countdown')} <strong>{daysLeft}</strong> {t('days')}
          </span>
          <span>
            <ShieldCheck size={14} />
            {t('format')}
          </span>
          <span>{t('fixtures')}</span>
          <span>{WORLD_CUP_OFFICIAL.startDate} - {WORLD_CUP_OFFICIAL.finalDate}</span>
        </div>
      </div>

      <div className="worldcup-spotlight-side">
        {featuredMatch && homeTeam && awayTeam ? (
          <button type="button" className="worldcup-mini-match" onClick={() => onSelectMatch(featuredMatch.id)}>
            <span className="worldcup-mini-label">{t('match')}</span>
            <span className="worldcup-mini-teams">
              <span>
                <TeamBadge team={homeTeam} size="sm" />
                {homeTeam.name[language]}
              </span>
              <strong>VS</strong>
              <span>
                <TeamBadge team={awayTeam} size="sm" />
                {awayTeam.name[language]}
              </span>
            </span>
            <span className="worldcup-mini-meta">
              {formatKickoff(featuredMatch.kickoffTime, language)}
              {featuredPrediction ? ` / ${t('model')} ${getPredictionTipDisplay(featuredPrediction, language)}` : ''}
            </span>
            {poolRows[0]?.odds && (
              <span className="worldcup-mini-odds">
                {t('odds')} {poolRows[0].odds.odds1.toFixed(2)} / {poolRows[0].odds.oddsX.toFixed(2)} / {poolRows[0].odds.odds2.toFixed(2)}
              </span>
            )}
            <span className="worldcup-mini-action">
              {t('view')}
              <ArrowRight size={13} />
            </span>
          </button>
        ) : (
          <div className="worldcup-mini-empty">{t('noMatch')}</div>
        )}

        <button type="button" className="worldcup-open-button" onClick={onOpenWorldCup}>
          {t('enter')}
          <ArrowRight size={14} />
        </button>
      </div>
    </section>
  );
};
