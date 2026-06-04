import React, { useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { HitAndWinPick, HitAndWinSubmission } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { Trophy, Send, Check, ShieldAlert } from 'lucide-react';

interface HitAndWinProps {
  onGoToAuth: () => void;
}

type MatchWithOdds = Match & { odds: NonNullable<Match['odds']> };

const hasOdds = (match: Match): match is MatchWithOdds => Boolean(match.odds);

export const HitAndWin: React.FC<HitAndWinProps> = ({ onGoToAuth }) => {
  const { language, currentUser, hitAndWinSubmission, submitHitAndWin, matches } = useApp();
  
  // 筛选 10 场即将开赛的精选比赛
  const hitMatches = React.useMemo(() => {
    return matches.filter((m: Match): m is MatchWithOdds => m.status === 'SCHEDULED' && hasOdds(m)).slice(0, 10);
  }, [matches]);

  // 用户当前的选择 { [matchId]: '1' | 'X' | '2' }
  const [selections, setSelections] = useState<HitAndWinSubmission>(() => hitAndWinSubmission ?? {});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const translations = {
    title: { zh: '命中赢奖 • 终身 VIP 大挑战', en: 'Hit & Win • Lifetime VIP Challenge' },
    rulesCard: { zh: '挑战规则', en: 'Rules & Rewards' },
    rule1: { zh: '1. 平台每日精选 10 场热门赛事。', en: '1. We feature 10 selected matches daily.' },
    rule2: { zh: '2. 针对每场比赛，选择主胜 / 平局 / 客胜；对应竞彩代码为 3 / 1 / 0。', en: '2. Pick Home, Draw, or Away for each match.' },
    rule3: { zh: '3. 每日仅限提交一张竞猜票据，提交后不可修改。', en: '3. Strictly 1 ticket per day. No edits after submission.' },
    rule4: { zh: '4. 全部 10 场预测完美命中，即刻赢取平台【终身免费 PRO 订阅】！', en: '4. Predict all 10 correctly and win Lifetime PRO Membership!' },
    notLoggedIn: { zh: '您当前未登录。提交预测前请先登录账户。', en: 'You are not logged in. Please sign in to submit.' },
    loginBtn: { zh: '前往登录 / 注册', en: 'Log In / Register' },
    submitBtn: { zh: '提交今日竞猜', en: 'Submit Predictions' },
    resetBtn: { zh: '重置选择', en: 'Reset Picks' },
    submittedText: { zh: '您已提交今日的命中赢奖竞猜！请关注赛后结算。', en: 'Predictions submitted! Awaiting matches results.' },
    unselectedWarning: { zh: '请在提交前完成全部 10 场比赛的预测选择！', en: 'Please select predictions for all 10 matches before submitting!' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  const handleSelect = (matchId: string, pick: HitAndWinPick) => {
    if (hitAndWinSubmission) return; // 已提交不可更改
    setSelections({
      ...selections,
      [matchId]: pick
    });
    setErrorMsg(null);
  };

  const handleReset = () => {
    if (hitAndWinSubmission) return;
    setSelections({});
    setErrorMsg(null);
  };

  const handleSubmit = () => {
    if (!currentUser) {
      setErrorMsg(t('notLoggedIn'));
      return;
    }

    // 检查是否填满 10 场
    if (Object.keys(selections).length < hitMatches.length) {
      setErrorMsg(t('unselectedWarning'));
      return;
    }

    submitHitAndWin(selections);
    setErrorMsg(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 头部装饰 */}
      <div style={{ textAlign: 'center', maxWidth: '700px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h2>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem' }}>
          {language === 'zh' ? '展示您的足球推演天赋，完美命中即可免单。' : 'Show off your football analysis skills and claim your reward.'}
        </p>
      </div>

      {/* 规则面板 */}
      <div className="card premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--premium))', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Trophy size={18} />
          {t('rulesCard')}
        </h3>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.85rem', color: 'hsl(var(--text-secondary))' }}>
          <li>{t('rule1')}</li>
          <li>{t('rule2')}</li>
          <li>{t('rule3')}</li>
          <li style={{ color: 'hsl(var(--primary))', fontWeight: '700' }}>{t('rule4')}</li>
        </ul>
      </div>

      {/* 错误提示或成功提示 */}
      {errorMsg && (
        <div className="card" style={{ border: '1px solid hsl(var(--danger) / 0.3)', backgroundColor: 'hsl(var(--danger) / 0.1)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', borderRadius: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ShieldAlert size={18} style={{ color: 'hsl(var(--danger))' }} />
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))' }}>{errorMsg}</span>
          </div>
          {!currentUser && (
            <button onClick={onGoToAuth} className="btn btn-accent" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}>
              {t('loginBtn')}
            </button>
          )}
        </div>
      )}

      {hitAndWinSubmission && (
        <div className="card" style={{ border: '1px solid hsl(var(--primary) / 0.3)', backgroundColor: 'hsl(var(--primary) / 0.1)', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem', borderRadius: '12px' }}>
          <Check size={20} style={{ color: 'hsl(var(--primary))' }} />
          <span style={{ fontSize: '0.875rem', color: 'hsl(var(--text-primary))', fontWeight: '700' }}>
            {t('submittedText')}
          </span>
        </div>
      )}

      {/* 10 场比赛卡片列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {hitMatches.map((match, index) => {
          const homeTeam = getTeamById(match.homeTeamId);
          const awayTeam = getTeamById(match.awayTeamId);
          const userPick = selections[match.id];
          const isSubmitted = !!hitAndWinSubmission;

          return (
            <div 
              key={match.id}
              className="card"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1rem',
                padding: '1.25rem',
                backgroundColor: 'hsl(var(--bg-card))',
                borderColor: userPick ? 'hsl(var(--accent) / 0.4)' : 'hsl(var(--border))'
              }}
            >
              {/* 左侧：场次序号与对阵 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: '220px' }}>
                <span style={{ 
                  width: '28px', height: '28px', borderRadius: '50%', backgroundColor: 'hsl(var(--border))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', fontSize: '0.85rem'
                }}>
                  {index + 1}
                </span>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: '700', fontSize: '0.95rem', flexWrap: 'wrap' }}>
                    <TeamBadge team={homeTeam} size="sm" />
                    <span>{homeTeam.shortName[language]}</span>
                    <span style={{ color: 'hsl(var(--text-muted))' }}>vs</span>
                    <TeamBadge team={awayTeam} size="sm" />
                    <span>{awayTeam.shortName[language]}</span>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                    {new Date(match.kickoffTime).toLocaleDateString()} {new Date(match.kickoffTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                  </span>
                </div>
              </div>

              {/* 右侧：1 / X / 2 竞猜单选钮组 */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {([
                  { key: '1', label: language === 'zh' ? '主胜' : 'Home', code: language === 'zh' ? '代码3' : '', odds: match.odds.odds1 },
                  { key: 'X', label: language === 'zh' ? '平局' : 'Draw', code: language === 'zh' ? '代码1' : '', odds: match.odds.oddsX },
                  { key: '2', label: language === 'zh' ? '客胜' : 'Away', code: language === 'zh' ? '代码0' : '', odds: match.odds.odds2 },
                ] satisfies { key: HitAndWinPick; label: string; code: string; odds: number }[]).map(opt => {
                  const isChosen = userPick === opt.key;
                  return (
                    <button
                      key={opt.key}
                      disabled={isSubmitted}
                      onClick={() => handleSelect(match.id, opt.key)}
                      className="btn"
                      style={{
                        padding: '0.5rem 1rem',
                        fontSize: '0.8rem',
                        borderRadius: '8px',
                        backgroundColor: isChosen ? 'hsl(var(--primary))' : 'hsl(var(--bg))',
                        color: isChosen ? '#000' : 'hsl(var(--text-primary))',
                        border: '1px solid hsl(var(--border))',
                        cursor: isSubmitted ? 'not-allowed' : 'pointer',
                        opacity: isSubmitted && !isChosen ? 0.4 : 1,
                        minWidth: '90px',
                        textAlign: 'center'
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ fontWeight: '700' }}>{opt.label}</span>
                        {opt.code && <span style={{ fontSize: '0.6rem', opacity: 0.58 }}>{opt.code}</span>}
                        <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>@{opt.odds.toFixed(2)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

            </div>
          );
        })}
      </div>

      {/* 提交面板 */}
      {!hitAndWinSubmission && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem' }}>
          <button onClick={handleReset} className="btn btn-secondary" style={{ width: '150px' }}>
            {t('resetBtn')}
          </button>
          <button onClick={handleSubmit} className="btn btn-primary" style={{ width: '200px' }}>
            <Send size={14} />
            <span>{t('submitBtn')}</span>
          </button>
        </div>
      )}

    </div>
  );
};
