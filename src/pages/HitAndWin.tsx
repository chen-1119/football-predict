import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { HitAndWinPick, HitAndWinSubmission } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { Check, MessageSquare, Send, ShieldAlert, Trophy, UploadCloud } from 'lucide-react';

interface HitAndWinProps {
  onGoToAuth: () => void;
}

type MatchWithOdds = Match & { odds: NonNullable<Match['odds']> };

interface CommunityPredictionEntry {
  id: string;
  nickname: string;
  comment: string;
  createdAt: string;
  selections: HitAndWinSubmission;
}

const STORAGE_KEY = 'football_worldcup_prediction_wall';

const hasOdds = (match: Match): match is MatchWithOdds => Boolean(match.odds);

const readCommunityEntries = (): CommunityPredictionEntry[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const pickLabels: Record<HitAndWinPick, { zh: string; en: string }> = {
  '1': { zh: '主胜', en: 'Home' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away' }
};

const matchResultPick = (match: Match): HitAndWinPick | null => {
  if (match.status !== 'FINISHED' || !Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return null;
  if (Number(match.scoreHome) > Number(match.scoreAway)) return '1';
  if (Number(match.scoreHome) < Number(match.scoreAway)) return '2';
  return 'X';
};

const scoreEntry = (entry: CommunityPredictionEntry, matches: Match[]) => {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const rows = Object.entries(entry.selections).map(([matchId, pick]) => {
    const match = matchById.get(matchId);
    const resultPick = match ? matchResultPick(match) : null;
    const isSettled = Boolean(resultPick);
    return {
      match,
      pick,
      resultPick,
      isSettled,
      isHit: isSettled && resultPick === pick
    };
  });

  return {
    total: rows.length,
    settled: rows.filter((row) => row.isSettled).length,
    hits: rows.filter((row) => row.isHit).length,
    hitRows: rows.filter((row) => row.isHit),
    rows
  };
};

const createCommunityPredictionEntry = (
  nickname: string,
  comment: string,
  selections: HitAndWinSubmission
): CommunityPredictionEntry => ({
  id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  nickname: nickname.trim().slice(0, 20),
  comment: comment.trim().slice(0, 140),
  createdAt: new Date().toISOString(),
  selections
});

export const HitAndWin: React.FC<HitAndWinProps> = () => {
  const { language, matches } = useApp();

  const hitMatches = useMemo(() => {
    return matches
      .filter((match: Match): match is MatchWithOdds => match.status === 'SCHEDULED' && hasOdds(match))
      .slice(0, 10);
  }, [matches]);

  const [selections, setSelections] = useState<HitAndWinSubmission>({});
  const [nickname, setNickname] = useState('');
  const [comment, setComment] = useState('');
  const [entries, setEntries] = useState<CommunityPredictionEntry[]>(readCommunityEntries);
  const [notice, setNotice] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);

  const translations = {
    title: { zh: '世界杯预测墙', en: 'World Cup Prediction Wall' },
    subtitle: {
      zh: '上传你的赛前判断和一句理由，大家一起看谁的世界杯方向更准。',
      en: 'Upload your pre-match picks and one short reason, then compare community reads.'
    },
    rulesCard: { zh: '互动说明', en: 'How it works' },
    rule1: { zh: '选择当前可用场次的主胜 / 平局 / 客胜方向。', en: 'Pick home / draw / away for available matches.' },
    rule2: { zh: '提交后会在本页展示昵称、观点、预测数量和后续命中情况。', en: 'After submission, nickname, comment, pick count, and settled hits are shown here.' },
    rule3: { zh: '奖励暂未开放，本区先用于世界杯预测交流与复盘。', en: 'Rewards are not open yet; this area is for World Cup discussion and review.' },
    rule4: { zh: '所有预测仅供参考，不构成投注建议。', en: 'All predictions are for reference only and are not betting advice.' },
    nickname: { zh: '昵称', en: 'Nickname' },
    nicknamePlaceholder: { zh: '例如：何先生', en: 'e.g. Alex' },
    comment: { zh: '预测观点 / 评论', en: 'Prediction comment' },
    commentPlaceholder: { zh: '写一句你的判断依据，例如：看好主队控场，但防平。', en: 'Add a short reason, e.g. home control but draw risk.' },
    submitBtn: { zh: '上传我的预测', en: 'Upload My Picks' },
    resetBtn: { zh: '重置选择', en: 'Reset Picks' },
    submittedText: { zh: '已上传到预测墙。', en: 'Uploaded to the prediction wall.' },
    unselectedWarning: { zh: '请至少选择 1 场比赛。', en: 'Please pick at least one match.' },
    commentWarning: { zh: '请填写昵称和预测观点。', en: 'Please add a nickname and comment.' },
    noMatches: { zh: '当前暂无可上传的赛前场次，等下一轮官方 SP 更新。', en: 'No pre-match fixtures are available yet. Check after the next official SP update.' },
    boardTitle: { zh: '大家的预测', en: 'Community Picks' },
    noEntries: { zh: '还没有人上传预测，先来占个前排。', en: 'No uploads yet. Be the first one.' },
    pickCount: { zh: '预测', en: 'Picks' },
    settled: { zh: '已结算', en: 'Settled' },
    hits: { zh: '命中', en: 'Hits' },
    hitContent: { zh: '命中内容', en: 'Hit picks' },
    waiting: { zh: '等待完场结算', en: 'Waiting for settlement' },
    score: { zh: '比分', en: 'Score' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  const handleSelect = (matchId: string, pick: HitAndWinPick) => {
    setSelections((current) => ({
      ...current,
      [matchId]: pick
    }));
    setNotice(null);
  };

  const handleReset = () => {
    setSelections({});
    setNotice(null);
  };

  const handleSubmit = () => {
    if (Object.keys(selections).length === 0) {
      setNotice({ type: 'danger', text: t('unselectedWarning') });
      return;
    }

    if (!nickname.trim() || !comment.trim()) {
      setNotice({ type: 'danger', text: t('commentWarning') });
      return;
    }

    const entry = createCommunityPredictionEntry(nickname, comment, selections);
    const nextEntries = [entry, ...entries].slice(0, 30);
    setEntries(nextEntries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries));
    setSelections({});
    setNickname('');
    setComment('');
    setNotice({ type: 'success', text: t('submittedText') });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h2>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
      </div>

      <div className="card premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.5rem', borderColor: 'hsl(var(--primary) / 0.28)' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--primary))', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Trophy size={18} />
          {t('rulesCard')}
        </h3>
        <ul style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.5rem', fontSize: '0.85rem', color: 'hsl(var(--text-secondary))' }}>
          <li>{t('rule1')}</li>
          <li>{t('rule2')}</li>
          <li>{t('rule3')}</li>
          <li style={{ color: 'hsl(var(--accent))', fontWeight: '700' }}>{t('rule4')}</li>
        </ul>
      </div>

      {notice && (
        <div className="card" style={{
          border: `1px solid hsl(var(--${notice.type === 'success' ? 'primary' : 'danger'}) / 0.3)`,
          backgroundColor: `hsl(var(--${notice.type === 'success' ? 'primary' : 'danger'}) / 0.1)`,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '1rem',
          borderRadius: '12px'
        }}>
          {notice.type === 'success'
            ? <Check size={18} style={{ color: 'hsl(var(--primary))' }} />
            : <ShieldAlert size={18} style={{ color: 'hsl(var(--danger))' }} />}
          <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))' }}>{notice.text}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '1.5rem', alignItems: 'start' }}>
        <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {hitMatches.length === 0 ? (
            <div className="card" style={{ padding: '3rem 2rem', textAlign: 'center', color: 'hsl(var(--text-secondary))' }}>
              <Trophy size={36} style={{ color: 'hsl(var(--border))', marginBottom: '0.75rem' }} />
              <p>{t('noMatches')}</p>
            </div>
          ) : hitMatches.map((match, index) => {
            const homeTeam = getTeamById(match.homeTeamId);
            const awayTeam = getTeamById(match.awayTeamId);
            const userPick = selections[match.id];

            return (
              <div
                key={match.id}
                className="card"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '1.15rem',
                  backgroundColor: 'hsl(var(--bg-card))',
                  borderColor: userPick ? 'hsl(var(--primary) / 0.42)' : 'hsl(var(--border))'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                  <span style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: '50%',
                    backgroundColor: userPick ? 'hsl(var(--primary) / 0.16)' : 'hsl(var(--bg))',
                    color: userPick ? 'hsl(var(--primary))' : 'hsl(var(--text-muted))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: '800',
                    fontSize: '0.85rem',
                    flex: '0 0 auto'
                  }}>
                    {index + 1}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: '800', fontSize: '0.95rem', flexWrap: 'wrap' }}>
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

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {([
                    { key: '1', label: pickLabels['1'][language], code: language === 'zh' ? '代码3' : '', odds: match.odds.odds1 },
                    { key: 'X', label: pickLabels.X[language], code: language === 'zh' ? '代码1' : '', odds: match.odds.oddsX },
                    { key: '2', label: pickLabels['2'][language], code: language === 'zh' ? '代码0' : '', odds: match.odds.odds2 },
                  ] satisfies { key: HitAndWinPick; label: string; code: string; odds: number }[]).map((option) => {
                    const isChosen = userPick === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => handleSelect(match.id, option.key)}
                        className="btn"
                        style={{
                          padding: '0.5rem 0.85rem',
                          fontSize: '0.8rem',
                          borderRadius: '8px',
                          backgroundColor: isChosen ? 'hsl(var(--primary))' : 'hsl(var(--bg))',
                          color: isChosen ? '#03130c' : 'hsl(var(--text-primary))',
                          border: '1px solid hsl(var(--border))',
                          minWidth: '86px',
                          textAlign: 'center'
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ fontWeight: '800' }}>{option.label}</span>
                          {option.code && <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>{option.code}</span>}
                          <span style={{ fontSize: '0.65rem', opacity: 0.72 }}>@{option.odds.toFixed(2)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>

        <aside className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.25rem', position: 'sticky', top: '96px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'hsl(var(--primary))', fontWeight: '800' }}>
            <UploadCloud size={18} />
            <span>{t('submitBtn')}</span>
          </div>
          <div className="form-group">
            <label className="form-label">{t('nickname')}</label>
            <input className="form-input" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder={t('nicknamePlaceholder')} maxLength={20} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('comment')}</label>
            <textarea
              className="form-input"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('commentPlaceholder')}
              maxLength={140}
              rows={4}
              style={{ resize: 'vertical', minHeight: '96px' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '0.75rem' }}>
            <button type="button" onClick={handleReset} className="btn btn-secondary">
              {t('resetBtn')}
            </button>
            <button type="button" onClick={handleSubmit} className="btn btn-primary">
              <Send size={14} />
              <span>{t('submitBtn')}</span>
            </button>
          </div>
        </aside>
      </div>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem', fontWeight: '900' }}>
            <MessageSquare size={18} style={{ color: 'hsl(var(--primary))' }} />
            {t('boardTitle')}
          </h3>
          <span style={{ color: 'hsl(var(--text-muted))', fontSize: '0.8rem' }}>
            {entries.length} {language === 'zh' ? '条观点' : 'comments'}
          </span>
        </div>

        {entries.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'hsl(var(--text-secondary))', border: '1px dashed hsl(var(--border))', borderRadius: '10px' }}>
            {t('noEntries')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
            {entries.map((entry) => {
              const score = scoreEntry(entry, matches);
              return (
                <article key={entry.id} className="card" style={{ backgroundColor: 'hsl(var(--bg))', display: 'flex', flexDirection: 'column', gap: '0.85rem', padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                    <div>
                      <strong style={{ fontSize: '0.95rem' }}>{entry.nickname}</strong>
                      <p style={{ marginTop: '0.25rem', color: 'hsl(var(--text-secondary))', fontSize: '0.82rem', lineHeight: 1.55 }}>{entry.comment}</p>
                    </div>
                    <span style={{ color: 'hsl(var(--text-muted))', fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                    {[
                      { label: t('pickCount'), value: score.total },
                      { label: t('settled'), value: score.settled },
                      { label: t('hits'), value: score.hits }
                    ].map((item) => (
                      <span key={item.label} style={{ border: '1px solid hsl(var(--border))', borderRadius: '8px', padding: '0.6rem', textAlign: 'center' }}>
                        <small style={{ display: 'block', color: 'hsl(var(--text-muted))', fontSize: '0.68rem' }}>{item.label}</small>
                        <strong style={{ color: 'hsl(var(--primary))', fontSize: '1rem' }}>{item.value}</strong>
                      </span>
                    ))}
                  </div>

                  <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem' }}>
                    <strong style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>{t('hitContent')}</strong>
                    {score.hitRows.length > 0 ? (
                      <ul style={{ listStyle: 'none', marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        {score.hitRows.map((row) => {
                          const match = row.match;
                          if (!match) return null;
                          const home = getTeamById(match.homeTeamId);
                          const away = getTeamById(match.awayTeamId);
                          return (
                            <li key={`${entry.id}-${match.id}`} style={{ fontSize: '0.78rem', color: 'hsl(var(--text-secondary))' }}>
                              <span style={{ color: 'hsl(var(--primary))', fontWeight: '800' }}>{pickLabels[row.pick][language]}</span>
                              {' · '}
                              {home.shortName[language]} vs {away.shortName[language]}
                              {' · '}
                              {t('score')} {match.scoreHome}:{match.scoreAway}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p style={{ marginTop: '0.5rem', color: 'hsl(var(--text-muted))', fontSize: '0.78rem' }}>
                        {score.settled > 0 ? `0 ${t('hits')}` : t('waiting')}
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
