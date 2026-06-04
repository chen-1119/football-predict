import React, { useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { Match, PredictionDetail } from '../services/mockData';
import {
  getMarketLabel,
  getPredictionCodeHint,
  getPredictionExplanationDisplay,
  getPredictionValueLabel,
  getPredictionTipDisplay,
  getSportteryPoolRows
} from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal } from '../services/matchSignal';
import { buildMatchInsight } from '../services/predictionInsight';
import { TeamBadge } from '../components/TeamBadge';
import { ArrowLeft, Lock, Trophy } from 'lucide-react';

interface MatchDetailProps {
  matchId: string;
  onBack: () => void;
}

type Language = 'zh' | 'en';

type FinishedMatch = Match & {
  scoreHome: number;
  scoreAway: number;
};

const HISTORY_LOOKBACK_DAYS = 365;
const TEAM_HISTORY_DISPLAY_LIMIT = 12;
const H2H_DISPLAY_LIMIT = 10;
const MIN_RATE_SAMPLE_SIZE = 3;

interface TeamHistoryResult {
  id: string;
  dateLabel: string;
  competition: string;
  opponentName: string;
  venueLabel: string;
  ourScore: number;
  oppScore: number;
  result: 'win' | 'draw' | 'loss';
}

interface TeamHistorySummary {
  rows: TeamHistoryResult[];
  sampleSize: number;
  wins: number;
  draws: number;
  losses: number;
  over25Count: number;
  bothScoreCount: number;
  over25Rate: number | null;
  bothScoreRate: number | null;
}

interface HeadToHeadSummary {
  rows: HeadToHeadResult[];
  sampleSize: number;
}

interface HeadToHeadResult {
  id: string;
  dateLabel: string;
  competition: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
}

const formatNumber = (value: number) => {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
};

const formatSquadValue = (value: string | undefined, language: Language) => {
  const rawValue = value?.trim();

  if (!rawValue || rawValue === '-' || rawValue.startsWith('#')) {
    return language === 'zh' ? '身价数据暂缺' : 'Value unavailable';
  }

  const matchedValue = rawValue.match(/^([\d.]+)\s*([BM])\s*€$/i);

  if (!matchedValue) {
    return language === 'zh' ? `阵容估值：${rawValue}` : `Squad value: ${rawValue}`;
  }

  const amount = Number(matchedValue[1]);
  const unit = matchedValue[2].toUpperCase();

  if (!Number.isFinite(amount)) {
    return language === 'zh' ? '身价数据暂缺' : 'Value unavailable';
  }

  if (language === 'zh') {
    const cnAmount = unit === 'B'
      ? `${formatNumber(amount * 10)}亿`
      : `${formatNumber(amount * 100)}万`;

    return `阵容估值：约 ${cnAmount}欧元`;
  }

  return `Squad value: ${rawValue}`;
};

const isFinishedWithScore = (match: Match): match is FinishedMatch => {
  return match.status === 'FINISHED' && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
};

const getMatchSortTime = (match: Match) => new Date(match.kickoffTime).getTime();

const getHistoryStartTime = (match: Match) => {
  return getMatchSortTime(match) - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
};

const getMatchDateValue = (match: Match) => {
  return match.matchDate || match.kickoffDate || match.businessDate || match.kickoffTime.slice(0, 10);
};

const formatHistoryDate = (match: Match, language: Language) => {
  const date = getMatchDateValue(match);

  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Shanghai'
  });
};

const formatCoverageDate = (date: string, language: Language) => {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai'
  });
};

const getHistoryCoverageLabel = (allMatches: Match[], language: Language) => {
  const dates = allMatches
    .filter(isFinishedWithScore)
    .map(getMatchDateValue)
    .filter(Boolean)
    .sort();

  if (dates.length === 0) {
    return language === 'zh' ? '暂无官方历史覆盖' : 'no official history coverage yet';
  }

  return `${formatCoverageDate(dates[0], language)} - ${formatCoverageDate(dates[dates.length - 1], language)}`;
};

const getTeamNameInMatch = (match: Match, teamId: string, language: Language) => {
  const team = getTeamById(teamId);
  const fallback = teamId === match.homeTeamId
    ? (language === 'zh' ? match.homeTeamName : match.homeTeamNameEn) || match.homeTeamName
    : (language === 'zh' ? match.awayTeamName : match.awayTeamNameEn) || match.awayTeamName;

  return fallback || team.shortName[language] || team.name[language];
};

const getCompetitionName = (match: Match, language: Language) => {
  const league = getLeagueById(match.leagueId);
  return (language === 'zh' ? match.leagueShortName || match.leagueName : match.leagueShortNameEn || match.leagueNameEn) || league.shortName[language] || league.name[language];
};

const buildTeamHistory = (
  allMatches: Match[],
  teamId: string,
  currentMatch: Match,
  language: Language
): TeamHistorySummary => {
  const cutoffTime = getMatchSortTime(currentMatch);
  const startTime = getHistoryStartTime(currentMatch);
  const allRows = allMatches
    .filter(isFinishedWithScore)
    .filter((item) => item.id !== currentMatch.id)
    .filter((item) => item.homeTeamId === teamId || item.awayTeamId === teamId)
    .filter((item) => {
      const matchTime = getMatchSortTime(item);
      return matchTime <= cutoffTime && matchTime >= startTime;
    })
    .sort((a, b) => getMatchSortTime(b) - getMatchSortTime(a))
    .map<TeamHistoryResult>((item) => {
      const isHomeSide = item.homeTeamId === teamId;
      const ourScore = isHomeSide ? item.scoreHome : item.scoreAway;
      const oppScore = isHomeSide ? item.scoreAway : item.scoreHome;
      const result = ourScore > oppScore ? 'win' : ourScore === oppScore ? 'draw' : 'loss';
      const opponentId = isHomeSide ? item.awayTeamId : item.homeTeamId;

      return {
        id: item.id,
        dateLabel: formatHistoryDate(item, language),
        competition: getCompetitionName(item, language),
        opponentName: getTeamNameInMatch(item, opponentId, language),
        venueLabel: isHomeSide ? (language === 'zh' ? '主' : 'H') : (language === 'zh' ? '客' : 'A'),
        ourScore,
        oppScore,
        result
      };
    });

  const rows = allRows.slice(0, TEAM_HISTORY_DISPLAY_LIMIT);
  const wins = allRows.filter((item) => item.result === 'win').length;
  const draws = allRows.filter((item) => item.result === 'draw').length;
  const losses = allRows.length - wins - draws;
  const over25 = allRows.filter((item) => item.ourScore + item.oppScore >= 3).length;
  const bothScore = allRows.filter((item) => item.ourScore > 0 && item.oppScore > 0).length;
  const hasRateSample = allRows.length >= MIN_RATE_SAMPLE_SIZE;

  return {
    rows,
    sampleSize: allRows.length,
    wins,
    draws,
    losses,
    over25Count: over25,
    bothScoreCount: bothScore,
    over25Rate: hasRateSample ? Math.round((over25 / allRows.length) * 100) : null,
    bothScoreRate: hasRateSample ? Math.round((bothScore / allRows.length) * 100) : null
  };
};

const buildHeadToHead = (
  allMatches: Match[],
  homeTeamId: string,
  awayTeamId: string,
  currentMatch: Match,
  language: Language
): HeadToHeadSummary => {
  const cutoffTime = getMatchSortTime(currentMatch);
  const startTime = getHistoryStartTime(currentMatch);

  const rows = allMatches
    .filter(isFinishedWithScore)
    .filter((item) => item.id !== currentMatch.id)
    .filter((item) => {
      const teamIds = new Set([item.homeTeamId, item.awayTeamId]);
      return teamIds.has(homeTeamId) && teamIds.has(awayTeamId);
    })
    .filter((item) => {
      const matchTime = getMatchSortTime(item);
      return matchTime <= cutoffTime && matchTime >= startTime;
    })
    .sort((a, b) => getMatchSortTime(b) - getMatchSortTime(a))
    .map<HeadToHeadResult>((item) => ({
      id: item.id,
      dateLabel: formatHistoryDate(item, language),
      competition: getCompetitionName(item, language),
      homeName: getTeamNameInMatch(item, item.homeTeamId, language),
      awayName: getTeamNameInMatch(item, item.awayTeamId, language),
      homeScore: item.scoreHome,
      awayScore: item.scoreAway
    }));

  return {
    rows: rows.slice(0, H2H_DISPLAY_LIMIT),
    sampleSize: rows.length
  };
};

export const MatchDetail: React.FC<MatchDetailProps> = ({ matchId, onBack }) => {
  const { language, isPremium, togglePremium, matches } = useApp();
  const [activeTab, setActiveTab] = useState<'predictions' | 'stats' | 'form' | 'h2h' | 'standings'>('predictions');

  // 获取比赛详情
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return (
      <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
        <p>{language === 'zh' ? '比赛不存在' : 'Match not found'}</p>
        <button onClick={onBack} className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ArrowLeft size={16} /> {language === 'zh' ? '返回列表' : 'Back'}
        </button>
      </div>
    );
  }

  const homeTeam = getTeamById(match.homeTeamId);
  const awayTeam = getTeamById(match.awayTeamId);
  const league = getLeagueById(match.leagueId);
  const country = getCountryById(match.countryId);
  
  const isFinished = match.status === 'FINISHED';
  const isLive = match.status === 'LIVE';
  
  const formattedDate = new Date(match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
  const businessDateLabel = match.matchDate
    ? new Date(`${match.matchDate}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      timeZone: 'Asia/Shanghai'
    })
    : '';

  const translations = {
    backBtn: { zh: '返回列表', en: 'Back' },
    predictionsTab: { zh: 'AI 预测推荐', en: 'Predictions' },
    statsTab: { zh: '数据统计', en: 'Match Stats' },
    formTab: { zh: '近期战绩', en: 'Form & Streaks' },
    h2hTab: { zh: '交锋历史', en: 'Head-to-Head' },
    standingsTab: { zh: '联赛积分榜', en: 'Standings' },
    market: { zh: '推荐市场', en: 'Market' },
    tip: { zh: '推荐选项', en: 'Tip' },
    odds: { zh: 'SP', en: 'Odds' },
    trust: { zh: '可信度', en: 'Confidence' },
    analysis: { zh: '模型深度解析', en: 'AI Analysis' },
    scorePrediction: { zh: 'AI 比分推演', en: 'AI Score Prediction' },
    teamValue: { zh: '阵容估值', en: 'Squad Value' },
    kickoff: { zh: '开赛时间', en: 'Kickoff' },
    lockedText: { zh: '此高阶 AI 预测数据仅对高级会员公开。一键模拟升级以解锁。', en: 'This advanced AI prediction is for Premium members only. Click to simulate unlock.' },
    unlockBtn: { zh: '解锁所有预测', en: 'Unlock All Data' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };
  const poolRows = getSportteryPoolRows(match, language);
  const hasPredictions = match.predictions.length > 0;
  const homeValueText = formatSquadValue(homeTeam.value, language);
  const awayValueText = formatSquadValue(awayTeam.value, language);
  const homeHistory = buildTeamHistory(matches, homeTeam.id, match, language);
  const awayHistory = buildTeamHistory(matches, awayTeam.id, match, language);
  const headToHead = buildHeadToHead(matches, homeTeam.id, awayTeam.id, match, language);
  const historyCoverageLabel = getHistoryCoverageLabel(matches, language);
  const matchSignal = getMatchSignal(match);
  const matchInsight = buildMatchInsight(match, {
    homeSampleSize: homeHistory.sampleSize,
    awaySampleSize: awayHistory.sampleSize,
    h2hSampleSize: headToHead.sampleSize,
    coverageLabel: historyCoverageLabel
  });
  const projectedScoreText = isFinished
    ? `${match.scoreHome} - ${match.scoreAway}`
    : `${match.projectedScoreHome ?? Math.round(match.stats?.xG.home ?? 1)} - ${match.projectedScoreAway ?? Math.round(match.stats?.xG.away ?? 1)}`;

  // 渲染预测详细行
  const renderPredictionBlock = (pred: PredictionDetail) => {
    // 免费版对活跃比赛的高级推荐锁定
    const isLocked = !isFinished && pred.visibilityStatus === 'PREMIUM' && !isPremium;
    const codeHint = getPredictionCodeHint(pred, language);
    const valueLabel = getPredictionValueLabel(pred, language);

    return (
      <div 
        key={pred.marketType}
        className="card" 
        style={{ 
          position: 'relative', 
          backgroundColor: 'hsl(var(--bg))', 
          borderColor: isLocked ? 'hsl(var(--premium) / 0.3)' : 'hsl(var(--border))',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflow: 'hidden'
        }}
      >
        {isLocked && (
          <div className="lock-overlay">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', padding: '1rem', textAlign: 'center' }}>
              <Lock size={20} style={{ color: 'hsl(var(--premium))' }} />
              <span style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))', fontWeight: '500', maxWidth: '300px' }}>
                {t('lockedText')}
              </span>
              <button 
                onClick={togglePremium} 
                className="btn btn-premium" 
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
              >
                {t('unlockBtn')}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', filter: isLocked ? 'blur(3px)' : 'none' }}>
          <div>
            <span style={{ 
              fontSize: '0.75rem', 
              color: 'hsl(var(--text-secondary))', 
              textTransform: 'uppercase', 
              fontWeight: '700', 
              letterSpacing: '0.5px' 
            }}>
              {getMarketLabel(pred.marketType, language)}
            </span>
            <h4 style={{ fontSize: '1.1rem', fontWeight: '800', color: pred.marketType === 'BEST' ? 'hsl(var(--primary))' : 'hsl(var(--text-primary))', marginTop: '0.2rem' }}>
              {getPredictionTipDisplay(pred, language)}
            </h4>
            {codeHint && <span className="prediction-code-hint">{codeHint}</span>}
            {pred.riskTags && pred.riskTags.length > 0 && (
              <div className="risk-tag-row">
                {pred.riskTags.map((tag) => (
                  <span key={`${pred.marketType}-${tag.zh}`} className="risk-tag">{tag[language]}</span>
                ))}
              </div>
            )}
          </div>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{valueLabel}</span>
              <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--accent))' }}>{pred.odds.toFixed(2)}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('trust')}</span>
              <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--primary))' }}>{pred.trustScore}%</span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem', filter: isLocked ? 'blur(3px)' : 'none' }}>
          <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block', marginBottom: '0.25rem', fontWeight: '600' }}>
            {t('analysis')}
          </span>
          <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.6' }}>
            {getPredictionExplanationDisplay(pred, language)}
          </p>
          {pred.analysisItems && pred.analysisItems.length > 0 && (
            <ul className="prediction-analysis-list">
              {pred.analysisItems.map((item, index) => (
                <li key={`${pred.marketType}-${index}`}>{item[language]}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  const formatRate = (value: number | null) => (value === null ? '--' : `${value}%`);
  const formatRateNote = (count: number, sampleSize: number) => {
    if (sampleSize === 0) return language === 'zh' ? '近一年无样本' : 'No yearly sample';
    if (sampleSize < MIN_RATE_SAMPLE_SIZE) return language === 'zh' ? `样本不足 · ${count}/${sampleSize}` : `Small sample · ${count}/${sampleSize}`;
    return language === 'zh' ? `${count}/${sampleSize} 场` : `${count}/${sampleSize} matches`;
  };

  const renderFormSummaryCard = (teamName: string, teamColor: string, summary: TeamHistorySummary) => (
    <div className="form-summary-card">
      <h4>
        <span style={{ backgroundColor: teamColor }} />
        {teamName} {language === 'zh' ? '近一年官方赛果' : 'Last-Year Official Results'}
      </h4>
      <div className="form-stat-grid">
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '胜 - 平 - 负' : 'W - D - L'}</span>
          <strong>{summary.wins} - {summary.draws} - {summary.losses}</strong>
          <em>{language === 'zh' ? `样本 ${summary.sampleSize} 场` : `${summary.sampleSize} samples`}</em>
        </div>
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '大 2.5 球率' : 'Over 2.5'}</span>
          <strong>{formatRate(summary.over25Rate)}</strong>
          <em>{formatRateNote(summary.over25Count, summary.sampleSize)}</em>
        </div>
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '双方进球率' : 'BTTS'}</span>
          <strong>{formatRate(summary.bothScoreRate)}</strong>
          <em>{formatRateNote(summary.bothScoreCount, summary.sampleSize)}</em>
        </div>
      </div>
      <p>
        {summary.sampleSize
          ? (language === 'zh'
            ? `近一年窗口已匹配 ${summary.sampleSize} 场官方已完场记录，列表展示最近 ${summary.rows.length} 场。历史库覆盖：${historyCoverageLabel}。`
            : `${summary.sampleSize} finished official records found in the last-year window. Showing latest ${summary.rows.length}. History coverage: ${historyCoverageLabel}.`)
          : (language === 'zh'
            ? `近一年历史库暂无该队已完场记录。历史库覆盖：${historyCoverageLabel}。`
            : `No finished official records in the last-year window. History coverage: ${historyCoverageLabel}.`)}
      </p>
    </div>
  );

  const renderHistoryColumn = (teamName: string, summary: TeamHistorySummary) => (
    <div className="team-history-column">
      <h5>{teamName}</h5>
      {summary.rows.length > 0 ? (
        <div className="team-history-list">
          {summary.rows.map((item) => (
            <div key={item.id} className="team-history-row">
              <div className="history-row-copy">
                <div className="history-row-meta">
                  <span>{item.dateLabel}</span>
                  <span>{item.competition}</span>
                </div>
                <strong>{item.venueLabel} vs {item.opponentName}</strong>
              </div>
              <span className={`history-score is-${item.result}`}>
                {item.ourScore} - {item.oppScore}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="history-empty">
          {language === 'zh' ? '暂无可匹配的官方历史赛果' : 'No matching official results yet'}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 1. 面包屑与返回 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))' }}>
          {language === 'zh' ? '首页' : 'Home'} / {country.name[language]} / {league.name[language]} / {homeTeam.shortName[language]} vs {awayTeam.shortName[language]}
        </div>
        <button onClick={onBack} className="btn btn-secondary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <ArrowLeft size={16} />
          <span>{t('backBtn')}</span>
        </button>
      </div>

      {/* 2. 比赛详情头部看板 */}
      <div className="card" style={{ 
        background: 'linear-gradient(135deg, hsl(var(--bg-card)) 0%, hsl(var(--bg-card-hover)) 100%)',
        display: 'flex', 
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
        gap: '1.5rem'
      }}>
        
        {/* 联赛与时间 */}
        <div>
          <span style={{ fontSize: '0.8rem', color: 'hsl(var(--primary))', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px' }}>
            {league.name[language]}
          </span>
          <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', marginTop: '0.25rem' }}>
            {formattedDate}
          </div>
          {(match.matchNo || businessDateLabel) && (
            <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', marginTop: '0.35rem' }}>
              {match.matchNo ? `${match.matchNo}` : ''}
              {match.matchNo && businessDateLabel ? ' · ' : ''}
              {businessDateLabel ? (language === 'zh' ? `竞彩日 ${businessDateLabel}` : `Match day ${businessDateLabel}`) : ''}
            </div>
          )}
        </div>

        {/* 球队比分对阵大面板 */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-around', 
          alignItems: 'center', 
          width: '100%', 
          maxWidth: '700px',
          flexWrap: 'wrap',
          gap: '1.5rem'
        }}>
          {/* 主队 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={homeTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {homeTeam.name[language]}
            </h3>
            <span className="match-team-value">{homeValueText}</span>
          </div>

          {/* 比分 / 状态 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            {isFinished ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--primary))' }}>
                  {match.scoreHome} - {match.scoreAway}
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh' ? '已结束' : 'Finished'}
                </span>
              </div>
            ) : isLive ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--danger))' }}>
                  {match.scoreHome} - {match.scoreAway}
                </div>
                <span className="badge badge-live">LIVE</span>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                  {language === 'zh' ? '未开赛' : 'Scheduled'}
                </span>
              </div>
            )}
          </div>

          {/* 客队 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={awayTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {awayTeam.name[language]}
            </h3>
            <span className="match-team-value">{awayValueText}</span>
          </div>

        </div>

        {/* 底部 SP 展示 */}
        {poolRows.length > 0 && (
          <div style={{
            borderTop: '1px solid hsl(var(--border))',
            width: '100%',
            paddingTop: '1rem',
            display: 'flex',
            justifyContent: 'center',
            fontSize: '0.875rem'
          }}>
            <div className="detail-pool-table">
              <div className="sporttery-pool-head">
                <span>{language === 'zh' ? '让球' : 'Line'}</span>
                <span>{language === 'zh' ? '胜' : 'H'}</span>
                <span>{language === 'zh' ? '平' : 'D'}</span>
                <span>{language === 'zh' ? '负' : 'A'}</span>
                <span>{language === 'zh' ? '支持率' : 'Prob.'}</span>
              </div>
              {poolRows.map((row) => (
                <div key={row.poolCode} className={`sporttery-pool-row ${row.odds ? '' : 'is-closed'}`}>
                  <span className="pool-line">{row.handicap || '--'}</span>
                  {row.odds ? (
                    <>
                      <strong>{row.odds.odds1.toFixed(2)}</strong>
                      <strong>{row.odds.oddsX.toFixed(2)}</strong>
                      <strong>{row.odds.odds2.toFixed(2)}</strong>
                      <span className="pool-prob">
                        {row.probabilities
                          ? `${row.probabilities.home}/${row.probabilities.draw}/${row.probabilities.away}%`
                          : '--'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>{language === 'zh' ? '未开售' : 'Closed'}</span>
                      <span>--</span>
                      <span>--</span>
                      <span>--</span>
                    </>
                  )}
                </div>
              ))}
              <div className="odds-source detail-odds-source">
                {language === 'zh' ? '官方竞彩 HAD / HHAD' : 'Official Sporttery HAD / HHAD'}
              </div>
              {match.oddsTrend && (
                <div className={`sp-trend-box is-${match.oddsTrend.direction}`}>
                  <strong>{language === 'zh' ? '官方 SP 走势' : 'Official SP Trend'}</strong>
                  <span>{match.oddsTrend.summary[language]}</span>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* 3. 导航 Tabs */}
      <div className="tabs-container">
        <button className={`tab-btn ${activeTab === 'predictions' ? 'active' : ''}`} onClick={() => setActiveTab('predictions')}>{t('predictionsTab')}</button>
        <button className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>{t('statsTab')}</button>
        <button className={`tab-btn ${activeTab === 'form' ? 'active' : ''}`} onClick={() => setActiveTab('form')}>{t('formTab')}</button>
        <button className={`tab-btn ${activeTab === 'h2h' ? 'active' : ''}`} onClick={() => setActiveTab('h2h')}>{t('h2hTab')}</button>
        <button className={`tab-btn ${activeTab === 'standings' ? 'active' : ''}`} onClick={() => setActiveTab('standings')}>{t('standingsTab')}</button>
      </div>

      {/* 4. Tab 内容区域 */}
      <div>
        
        {/* Tab 1: AI 推荐 */}
        {activeTab === 'predictions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div className={`card signal-summary-card is-${matchSignal.category}`}>
              <div>
                <span className={`signal-badge is-${matchSignal.category}`}>{matchSignal.label[language]}</span>
                <h3>{language === 'zh' ? 'AI 初筛结论' : 'AI Signal Summary'}</h3>
                <p>{matchSignal.note[language]}</p>
              </div>
              <div className="signal-summary-meta">
                <span>{language === 'zh' ? '可信度' : 'Trust'} <strong>{matchSignal.trustScore ? `${matchSignal.trustScore}%` : '--'}</strong></span>
                <span>{language === 'zh' ? '风险项' : 'Risks'} <strong>{matchSignal.riskCount}</strong></span>
                {match.oddsTrend && (
                  <span>{language === 'zh' ? 'SP快照' : 'SP snapshots'} <strong>{match.oddsTrend.sampleSize}</strong></span>
                )}
              </div>
              {match.oddsTrend && (
                <p className="signal-summary-trend">{match.oddsTrend.summary[language]}</p>
              )}
            </div>

            <div className={`card insight-card is-${matchInsight.tone}`}>
              <div className="insight-head">
                <div>
                  <span className={`insight-action is-${matchInsight.tone}`}>{matchInsight.action[language]}</span>
                  <h3>{matchInsight.title[language]}</h3>
                  <p>{matchInsight.summary[language]}</p>
                </div>
                <div className="insight-score">
                  <span>{language === 'zh' ? '综合评分' : 'Score'}</span>
                  <strong>{matchInsight.score === null ? '--' : matchInsight.score}</strong>
                </div>
              </div>

              <div className="insight-metric-grid">
                {matchInsight.metrics.map((metric) => (
                  <div key={`${metric.label.zh}-${metric.value.zh}`} className={`insight-metric is-${metric.tone}`}>
                    <span>{metric.label[language]}</span>
                    <strong>{metric.value[language]}</strong>
                  </div>
                ))}
              </div>

              <div className="insight-section-grid">
                <div>
                  <h4>{language === 'zh' ? '支撑因素' : 'Drivers'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.drivers.map((point) => (
                      <div key={point.title.zh} className={`insight-point is-${point.tone}`}>
                        <strong>{point.title[language]}</strong>
                        <p>{point.body[language]}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4>{language === 'zh' ? '观察风险' : 'Watchpoints'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.watchpoints.map((point) => (
                      <div key={point.title.zh} className={`insight-point is-${point.tone}`}>
                        <strong>{point.title[language]}</strong>
                        <p>{point.body[language]}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            
            {/* 比分推演卡片 */}
            {hasPredictions && (
              <div className="card" style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.05) 0%, transparent 100%)',
                borderColor: 'hsl(var(--primary) / 0.2)',
                position: 'relative',
                overflow: 'hidden'
              }}>
                {!isPremium && !isFinished && (
                  <div className="lock-overlay">
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', textAlign: 'center' }}>
                      <Lock size={16} style={{ color: 'hsl(var(--premium))' }} />
                      <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-secondary))' }}>
                        {language === 'zh' ? '比分预测属高级会员独享' : 'Score prediction is locked'}
                      </span>
                    </div>
                  </div>
                )}
                <h4 style={{ fontSize: '0.9rem', color: 'hsl(var(--primary))', textTransform: 'uppercase', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Trophy size={16} />
                  {t('scorePrediction')}
                </h4>
                <div style={{ fontSize: '2.5rem', fontWeight: '900', fontFamily: 'var(--font-title)', margin: '0.75rem 0', filter: (!isPremium && !isFinished) ? 'blur(4px)' : 'none' }}>
                  {projectedScoreText}
                </div>
                <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', filter: (!isPremium && !isFinished) ? 'blur(4px)' : 'none' }}>
                  {language === 'zh'
                    ? `模型基于官方 SP 反推预期进球，当前热区约 ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}。`
                    : `Derived from official SP-implied xG. Current heat zone is about ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}.`}
                </p>
              </div>
            )}

            {/* 预测列表 */}
            {hasPredictions ? (
              match.predictions.map(pred => renderPredictionBlock(pred))
            ) : (
              <div className="card" style={{ color: 'hsl(var(--text-secondary))', lineHeight: 1.6 }}>
                {language === 'zh'
                  ? isFinished
                    ? '这场是官方历史赛果记录，只展示比分与赛程信息。'
                    : '本场普通胜平负暂未开售，当前先展示官方让球胜平负赔率；HAD 开售后再生成模型推荐。'
                  : isFinished
                    ? 'This is an official historical result record with score and schedule information only.'
                    : 'The standard 1X2 pool is not on sale yet. Official handicap 1X2 odds are shown, and model tips will be generated after HAD opens.'}
              </div>
            )}

          </div>
        )}

        {/* Tab 2: 统计数据 */}
        {activeTab === 'stats' && (
          match.stats ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {language === 'zh' ? 'AI 模型参数预测' : 'AI Model Parameters'}
            </h3>
            
            {/* 进度条统计 */}
            {[
              { label: 'xG (期望进球)', home: match.stats.xG.home, away: match.stats.xG.away, unit: '' },
              { label: '控球率 (Possession)', home: match.stats.possession.home, away: match.stats.possession.away, unit: '%' },
              { label: '射门数 (Shots)', home: match.stats.shots.home, away: match.stats.shots.away, unit: '' },
              { label: '射正数 (Shots on Target)', home: match.stats.shotsOnTarget.home, away: match.stats.shotsOnTarget.away, unit: '' },
              { label: '角球 (Corners)', home: match.stats.corners.home, away: match.stats.corners.away, unit: '' },
              { label: '黄牌 (Yellow Cards)', home: match.stats.yellowCards.home, away: match.stats.yellowCards.away, unit: '' },
            ].map((stat, idx) => {
              const total = stat.home + stat.away;
              const homePct = total === 0 ? 50 : Math.round((stat.home / total) * 100);
              const awayPct = 100 - homePct;

              return (
                <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: '500' }}>
                    <span>{stat.home}{stat.unit}</span>
                    <span style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>{stat.label}</span>
                    <span>{stat.away}{stat.unit}</span>
                  </div>
                  {/* 双向进度条 */}
                  <div style={{ display: 'flex', width: '100%', height: '8px', backgroundColor: 'hsl(var(--border))', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${homePct}%`, backgroundColor: homeTeam.color, transition: 'width 0.3s' }} />
                    <div style={{ width: `${awayPct}%`, backgroundColor: awayTeam.color, transition: 'width 0.3s' }} />
                  </div>
                </div>
              );
            })}
            </div>
          ) : (
            <div className="card data-quality-note">
              {language === 'zh'
                ? '这场比赛当前只有官方赛果记录，没有可验证的赛前模型参数，因此不展示模拟统计。'
                : 'This match only has an official result record, so no simulated model stats are shown.'}
            </div>
          )
        )}

        {/* Tab 3: 近期战绩 */}
        {activeTab === 'form' && (
          <div className="form-history-stack">
            <div className="form-summary-grid">
              {renderFormSummaryCard(homeTeam.shortName[language], homeTeam.color, homeHistory)}
              {renderFormSummaryCard(awayTeam.shortName[language], awayTeam.color, awayHistory)}
            </div>

            <div className="card team-history-card">
              <div className="history-card-head">
                <div>
                  <h4>{language === 'zh' ? '双方近一年官方赛果' : 'Last-Year Official Team Results'}</h4>
                  <p>
                    {language === 'zh'
                      ? `从已同步的中国竞彩网历史赛果中追溯近一年同队比赛，单队最多展示最近 ${TEAM_HISTORY_DISPLAY_LIMIT} 场。当前历史库覆盖：${historyCoverageLabel}。`
                      : `Matched from synced official Sporttery results in the last-year window. Showing up to ${TEAM_HISTORY_DISPLAY_LIMIT} recent matches per team. Coverage: ${historyCoverageLabel}.`}
                  </p>
                </div>
              </div>
              <div className="team-history-grid">
                {renderHistoryColumn(homeTeam.shortName[language], homeHistory)}
                {renderHistoryColumn(awayTeam.shortName[language], awayHistory)}
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: 交锋历史 */}
        {activeTab === 'h2h' && (
          <div className="card h2h-card">
            <div className="history-card-head">
              <div>
                <h3>{language === 'zh' ? '近一年直接交锋' : 'Last-Year Head-to-Head'}</h3>
                <p>
                  {language === 'zh'
                    ? `仅展示当前历史库里近一年已同步到的双方正式交锋结果，最多展示 ${H2H_DISPLAY_LIMIT} 场。当前历史库覆盖：${historyCoverageLabel}。`
                    : `Only official head-to-head results in the last-year window are shown, up to ${H2H_DISPLAY_LIMIT} matches. Coverage: ${historyCoverageLabel}.`}
                </p>
              </div>
            </div>

            {headToHead.rows.length > 0 ? (
              <div className="h2h-list">
                {headToHead.rows.map((item) => (
                  <div key={item.id} className="h2h-row">
                    <div className="history-row-meta">
                      <span>{item.dateLabel}</span>
                      <span>{item.competition}</span>
                    </div>
                    <div className="h2h-match-line">
                      <span>{item.homeName}</span>
                      <strong>{item.homeScore} - {item.awayScore}</strong>
                      <span>{item.awayName}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="history-empty">
                {language === 'zh'
                  ? '近一年官方历史库暂未匹配到这两队的直接交锋。'
                  : 'No direct head-to-head result found in the last-year official history window.'}
              </div>
            )}
            {headToHead.sampleSize > headToHead.rows.length && (
              <p className="history-overflow-note">
                {language === 'zh'
                  ? `已匹配 ${headToHead.sampleSize} 场，当前仅展示最近 ${headToHead.rows.length} 场。`
                  : `${headToHead.sampleSize} matches found. Showing latest ${headToHead.rows.length}.`}
              </p>
            )}
          </div>
        )}

        {/* Tab 5: 积分榜 */}
        {activeTab === 'standings' && (
          match.standings && match.standings.length > 0 ? (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <div style={{ padding: '1rem', backgroundColor: 'hsl(var(--bg-card-hover))', borderBottom: '1px solid hsl(var(--border))', fontWeight: '700' }}>
                {league.name[language]} - {language === 'zh' ? '最新排名' : 'Standings Table'}
              </div>

              <table className="responsive-table">
                <thead>
                  <tr>
                    <th style={{ width: '60px', textAlign: 'center' }}>排名</th>
                    <th>球队</th>
                    <th style={{ textAlign: 'center' }}>已赛</th>
                    <th style={{ textAlign: 'center' }}>胜</th>
                    <th style={{ textAlign: 'center' }}>平</th>
                    <th style={{ textAlign: 'center' }}>负</th>
                    <th style={{ textAlign: 'center' }}>进/失球</th>
                    <th style={{ textAlign: 'center', fontWeight: '700' }}>积分</th>
                  </tr>
                </thead>
                <tbody>
                  {match.standings.map((row) => {
                    const teamObj = getTeamById(row.teamId);
                    const isCurrentMatchTeam = teamObj.id === homeTeam.id || teamObj.id === awayTeam.id;

                    return (
                      <tr
                        key={row.position}
                        style={{
                          backgroundColor: isCurrentMatchTeam ? 'hsl(var(--primary) / 0.08)' : 'transparent',
                          fontWeight: isCurrentMatchTeam ? '700' : 'normal'
                        }}
                      >
                        <td data-label="排名" style={{ textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-flex', width: '22px', height: '22px', borderRadius: '50%',
                            backgroundColor: row.position <= 3 ? 'hsl(var(--primary) / 0.15)' : 'transparent',
                            color: row.position <= 3 ? 'hsl(var(--primary))' : 'hsl(var(--text-secondary))',
                            alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: '700'
                          }}>
                            {row.position}
                          </span>
                        </td>
                        <td data-label="球队">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: teamObj.color }} />
                            <span>{teamObj.name[language]}</span>
                          </div>
                        </td>
                        <td data-label="已赛" style={{ textAlign: 'center' }}>{row.played}</td>
                        <td data-label="胜" style={{ textAlign: 'center', color: 'hsl(var(--primary))' }}>{row.wins}</td>
                        <td data-label="平" style={{ textAlign: 'center' }}>{row.draws}</td>
                        <td data-label="负" style={{ textAlign: 'center', color: 'hsl(var(--danger))' }}>{row.losses}</td>
                        <td data-label="得失球" style={{ textAlign: 'center', color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>
                          {row.goalsFor}:{row.goalsAgainst}
                        </td>
                        <td data-label="积分" style={{ textAlign: 'center', fontWeight: '800', color: 'hsl(var(--primary))' }}>{row.points}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card data-quality-note">
              {language === 'zh'
                ? '暂未接入中国竞彩网官方积分榜数据，因此不展示模拟排名，避免误导判断。'
                : 'Official standings are not connected yet, so no simulated table is shown.'}
            </div>
          )
        )}

      </div>

    </div>
  );
};
