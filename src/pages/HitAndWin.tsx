import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { HitAndWinPick, HitAndWinSubmission } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { Check, MessageSquare, NotebookPen, Save, ShieldAlert } from 'lucide-react';

type MatchWithOdds = Match & { odds: NonNullable<Match['odds']> };

interface PersonalReviewEntry {
  id: string;
  nickname: string;
  comment: string;
  createdAt: string;
  selections: HitAndWinSubmission;
  fixtures?: Record<string, PersonalReviewFixture>;
}

interface PersonalReviewFixture {
  sourceMatchId?: string | null;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeamName?: string;
  homeTeamNameEn?: string;
  awayTeamName?: string;
  awayTeamNameEn?: string;
  kickoffTime?: string;
}

const STORAGE_KEY = 'football_worldcup_prediction_wall';

const hasOdds = (match: Match): match is MatchWithOdds => Boolean(match.odds);

const readPersonalReviewEntries = (): PersonalReviewEntry[] => {
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

const normalizeMatchIdentity = (value: unknown) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^sporttery[_:-]/, '');

const findReviewMatch = (
  matchId: string,
  fixture: PersonalReviewFixture | undefined,
  matches: Match[]
) => {
  const directMatch = matches.find((match) => match.id === matchId);
  if (directMatch) return directMatch;

  const identities = new Set([
    normalizeMatchIdentity(matchId),
    normalizeMatchIdentity(fixture?.sourceMatchId)
  ].filter(Boolean));
  if (identities.size === 0) return undefined;

  return matches.find((match) => (
    identities.has(normalizeMatchIdentity(match.id))
    || identities.has(normalizeMatchIdentity(match.sourceMatchId))
  ));
};

const scoreEntry = (entry: PersonalReviewEntry, matches: Match[]) => {
  const rows = Object.entries(entry.selections).map(([matchId, pick]) => {
    const fixture = entry.fixtures?.[matchId];
    const match = findReviewMatch(matchId, fixture, matches);
    const resultPick = match ? matchResultPick(match) : null;
    const isSettled = Boolean(resultPick);
    return {
      match,
      fixture,
      pick,
      resultPick,
      isSettled,
      isHit: isSettled && resultPick === pick,
      state: isSettled ? 'settled' : match ? 'waiting' : 'unavailable'
    };
  });

  return {
    total: rows.length,
    settled: rows.filter((row) => row.isSettled).length,
    hits: rows.filter((row) => row.isHit).length,
    waiting: rows.filter((row) => row.state === 'waiting').length,
    unavailable: rows.filter((row) => row.state === 'unavailable').length,
    rows
  };
};

const createPersonalReviewEntry = (
  comment: string,
  selections: HitAndWinSubmission,
  matches: Match[]
): PersonalReviewEntry => ({
  id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  nickname: '',
  comment: comment.trim().slice(0, 140),
  createdAt: new Date().toISOString(),
  selections,
  // Keep an on-device pre-match fixture snapshot. A settled history row can
  // legitimately receive a storage-row id different from the current lane;
  // the snapshot lets the review remain understandable while it is resolved.
  fixtures: Object.fromEntries(Object.keys(selections).map((matchId) => {
    const match = matches.find((candidate) => candidate.id === matchId);
    return [matchId, {
      sourceMatchId: match?.sourceMatchId || null,
      homeTeamId: match?.homeTeamId,
      awayTeamId: match?.awayTeamId,
      homeTeamName: match?.homeTeamName,
      homeTeamNameEn: match?.homeTeamNameEn,
      awayTeamName: match?.awayTeamName,
      awayTeamNameEn: match?.awayTeamNameEn,
      kickoffTime: match?.kickoffTime
    }];
  }))
});

export const HitAndWin: React.FC = () => {
  const { language, matches } = useApp();

  const hitMatches = useMemo(() => {
    return matches
      .filter((match: Match): match is MatchWithOdds => (
        match.status === 'SCHEDULED' && isBeforeMatchSaleCutoff(match) && hasOdds(match)
      ))
      .slice(0, 10);
  }, [matches]);

  const systemReviewMatches = useMemo(() => matches
    .filter((match) => match.status === 'FINISHED' || Boolean(match.postMatchReview))
    .sort((left, right) => {
      const leftAt = Date.parse(left.postMatchReview?.generatedAt || left.resultUpdatedAt || left.kickoffTime || '') || 0;
      const rightAt = Date.parse(right.postMatchReview?.generatedAt || right.resultUpdatedAt || right.kickoffTime || '') || 0;
      return rightAt - leftAt;
    })
    .slice(0, 12), [matches]);

  const [selections, setSelections] = useState<HitAndWinSubmission>({});
  const [comment, setComment] = useState('');
  const [entries, setEntries] = useState<PersonalReviewEntry[]>(readPersonalReviewEntries);
  const [notice, setNotice] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);

  const translations = {
    title: { zh: '个人赛前复盘笔记', en: 'Personal Pre-match Review Notes' },
    subtitle: {
      zh: '记录你自己的赛前方向和判断依据，赛后按真实赛果复盘。内容只保存在当前设备，不是本站官方推荐或公开挑战。',
      en: 'Record your own pre-match direction and reasoning, then review it against the final result. Notes stay on this device and are neither official picks nor a public challenge.'
    },
    rulesCard: { zh: '个人笔记说明', en: 'Personal note guide' },
    rule1: { zh: '选择当前可用场次的主胜 / 平局 / 客胜，记录你自己的赛前判断。', en: 'Choose home / draw / away to record your own pre-match view.' },
    rule2: { zh: '保存后只会写入当前浏览器的 localStorage，并在本页显示。', en: 'Saving writes only to this browser localStorage and displays the entry on this page.' },
    rule3: { zh: '这不是社区、排行榜或命中挑战；清理浏览器数据后记录会丢失。', en: 'This is not a community, leaderboard, or hit challenge. Clearing browser data removes the notes.' },
    rule4: { zh: '个人选择与本站正式推荐分开统计，不会影响模型命中率。', en: 'Personal selections are separate from formal picks and never affect model hit-rate statistics.' },
    comment: { zh: '判断依据 / 复盘笔记', en: 'Reasoning / review note' },
    commentPlaceholder: { zh: '写下判断依据，例如：主队控场占优，但让球盘存在穿盘风险。', en: 'Write your reasoning, e.g. home control but handicap-cover risk.' },
    submitBtn: { zh: '保存个人笔记', en: 'Save Personal Note' },
    resetBtn: { zh: '重置方向', en: 'Reset Directions' },
    submittedText: { zh: '个人笔记已保存在本设备，未上传到服务器。', en: 'Personal note saved on this device; nothing was uploaded.' },
    unselectedWarning: { zh: '请至少选择 1 场比赛。', en: 'Please pick at least one match.' },
    commentWarning: { zh: '请填写判断依据或复盘笔记。', en: 'Please add your reasoning or review note.' },
    noMatches: { zh: '当前暂无可记录的赛前场次，等待下一轮官方赛程与赔率。', en: 'No pre-match fixture is available for notes yet. Wait for the next schedule and odds update.' },
    boardTitle: { zh: '本设备个人笔记', en: 'Personal Notes on This Device' },
    noEntries: { zh: '当前设备还没有个人复盘笔记。', en: 'No personal review note is saved on this device yet.' },
    pickCount: { zh: '方向', en: 'Directions' },
    settled: { zh: '已结算', en: 'Settled' },
    hits: { zh: '命中', en: 'Hits' },
    hitContent: { zh: '赛后复盘结果', en: 'Post-match review result' },
    reviewFeedback: { zh: '复盘反馈', en: 'Review feedback' },
    actualResult: { zh: '实际赛果', en: 'Actual result' },
    hit: { zh: '命中', en: 'Hit' },
    miss: { zh: '未命中', en: 'Miss' },
    waiting: { zh: '等待完场结算', en: 'Waiting for settlement' },
    unavailable: { zh: '暂未加载这场历史赛果', en: 'Historical result is not loaded yet' },
    settledFeedback: { zh: '已按最终比分完成结算；个人笔记不会计入本站模型样本或正式命中率。', en: 'Settled against the final score. Personal notes do not enter model samples or formal hit rates.' },
    waitingFeedback: { zh: '尚未获得官方终场赛果，保持等待，不会使用赛后赔率补造结论。', en: 'Official final result is not available yet. The review stays pending and never invents a post-match conclusion.' },
    unavailableFeedback: { zh: '这条旧笔记尚未在已加载的历史赛果中找到对应比赛；刷新历史数据后会自动重新对齐。', en: 'This older note is not in the loaded result history yet. It will reconcile automatically once that history is available.' },
    score: { zh: '比分', en: 'Score' },
    systemReviewTitle: { zh: '系统赛后复盘', en: 'System Post-match Reviews' },
    systemReviewSubtitle: { zh: '依据官方终场赛果与赛前冻结记录展示；没有冻结方向的场次只显示赛果，不补造推荐。', en: 'Built from official final results and frozen pre-match records. Matches without a frozen direction show the result only; no pick is reconstructed after kickoff.' },
    noSystemReview: { zh: '已加载的历史中暂无可展示的赛后复盘，正在等待官方赛果或历史同步。', en: 'No post-match review is available in loaded history yet; waiting for final results or history sync.' },
    systemDirection: { zh: '赛前方向结算', en: 'Pre-match direction' },
    resultOnly: { zh: '仅赛果归档（未保存赛前方向）', en: 'Result archive only (no pre-match direction saved)' },
    formalHit: { zh: '正式推荐命中', en: 'Formal pick hit' },
    formalMiss: { zh: '正式推荐未命中', en: 'Formal pick missed' },
    referenceHit: { zh: '分析参考符合赛果', en: 'Analysis reference matched result' },
    referenceMiss: { zh: '分析参考未符合赛果', en: 'Analysis reference missed result' },
    reviewReason: { zh: '原因复盘', en: 'Reason review' },
    nextAdjustment: { zh: '后续调整', en: 'Next adjustment' }
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

    if (!comment.trim()) {
      setNotice({ type: 'danger', text: t('commentWarning') });
      return;
    }

    const entry = createPersonalReviewEntry(comment, selections, matches);
    const nextEntries = [entry, ...entries].slice(0, 30);
    setEntries(nextEntries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries));
    setSelections({});
    setComment('');
    setNotice({ type: 'success', text: t('submittedText') });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h1>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
      </div>

      <div className="card premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.5rem', borderColor: 'hsl(var(--primary) / 0.28)' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--primary))', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <NotebookPen size={18} />
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
        <div
          className="card"
          role={notice.type === 'danger' ? 'alert' : 'status'}
          aria-live={notice.type === 'danger' ? 'assertive' : 'polite'}
          style={{
          border: `1px solid hsl(var(--${notice.type === 'success' ? 'primary' : 'danger'}) / 0.3)`,
          backgroundColor: `hsl(var(--${notice.type === 'success' ? 'primary' : 'danger'}) / 0.1)`,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '1rem',
          borderRadius: '12px'
          }}
        >
          {notice.type === 'success'
            ? <Check size={18} style={{ color: 'hsl(var(--primary))' }} />
            : <ShieldAlert size={18} style={{ color: 'hsl(var(--danger))' }} />}
          <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))' }}>{notice.text}</span>
        </div>
      )}

      <section className="card premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.25rem', borderColor: 'hsl(var(--primary) / 0.28)' }}>
        <div>
          <h2 style={{ fontSize: '1.2rem', fontWeight: '900', color: 'hsl(var(--text-primary))' }}>{t('systemReviewTitle')}</h2>
          <p style={{ marginTop: '0.35rem', color: 'hsl(var(--text-secondary))', fontSize: '0.82rem', lineHeight: 1.5 }}>{t('systemReviewSubtitle')}</p>
        </div>
        {systemReviewMatches.length === 0 ? (
          <p style={{ padding: '1.25rem', textAlign: 'center', color: 'hsl(var(--text-muted))', border: '1px dashed hsl(var(--border))', borderRadius: '10px' }}>{t('noSystemReview')}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem' }}>
            {systemReviewMatches.map((match) => {
              const review = match.postMatchReview;
              const home = getTeamById(match.homeTeamId);
              const away = getTeamById(match.awayTeamId);
              const homeName = match.homeTeamName || home.shortName[language];
              const awayName = match.awayTeamName || away.shortName[language];
              const finalScore = review?.finalScore || (Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
                ? `${match.scoreHome}:${match.scoreAway}`
                : '--');
              const actualResult = review?.actual?.had?.label?.[language] || '--';
              const formalStatus = review?.predictionReview?.formalBestStatus || null;
              const referenceStatus = review?.predictionReview?.referenceBestStatus || null;
              const directionLabel = formalStatus === 'WON'
                ? t('formalHit')
                : formalStatus === 'LOST'
                  ? t('formalMiss')
                  : referenceStatus === 'WON'
                    ? t('referenceHit')
                    : referenceStatus === 'LOST'
                      ? t('referenceMiss')
                      : t('resultOnly');
              const directionColor = formalStatus === 'WON' || referenceStatus === 'WON'
                ? 'hsl(var(--primary))'
                : formalStatus === 'LOST' || referenceStatus === 'LOST'
                  ? 'hsl(var(--danger))'
                  : 'hsl(var(--text-muted))';
              return (
                <article key={`system-review-${match.id}`} style={{ border: '1px solid hsl(var(--border))', borderRadius: '10px', padding: '0.9rem', backgroundColor: 'hsl(var(--bg))', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}>
                    <strong style={{ color: 'hsl(var(--text-primary))', fontSize: '0.9rem' }}>{homeName} vs {awayName}</strong>
                    <span style={{ color: 'hsl(var(--primary))', fontWeight: '900', whiteSpace: 'nowrap' }}>{finalScore}</span>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'hsl(var(--text-secondary))', display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    <span>{t('actualResult')} {actualResult}</span>
                    <span>·</span>
                    <span style={{ color: directionColor, fontWeight: '800' }}>{t('systemDirection')}：{directionLabel}</span>
                  </div>
                  {(review?.modelDiagnosis?.length || review?.nextAdjustment?.length) ? (
                    <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.5rem', fontSize: '0.75rem', color: 'hsl(var(--text-muted))', lineHeight: 1.5 }}>
                      {review?.modelDiagnosis?.slice(0, 1).map((item) => <p key={`reason-${item.code}`}><strong>{t('reviewReason')}：</strong>{item[language]}</p>)}
                      {review?.nextAdjustment?.slice(0, 1).map((item) => <p key={`adjust-${item.code}`}><strong>{t('nextAdjustment')}：</strong>{item[language]}</p>)}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '1.5rem', alignItems: 'start' }}>
        <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {hitMatches.length === 0 ? (
            <div className="card" style={{ padding: '3rem 2rem', textAlign: 'center', color: 'hsl(var(--text-secondary))' }}>
              <NotebookPen size={36} style={{ color: 'hsl(var(--border))', marginBottom: '0.75rem' }} />
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
                    { key: '1', label: pickLabels['1'][language], odds: match.odds.odds1 },
                    { key: 'X', label: pickLabels.X[language], odds: match.odds.oddsX },
                    { key: '2', label: pickLabels['2'][language], odds: match.odds.odds2 },
                  ] satisfies { key: HitAndWinPick; label: string; odds: number }[]).map((option) => {
                    const isChosen = userPick === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        aria-pressed={isChosen}
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
            <Save size={18} />
            <span>{t('submitBtn')}</span>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="hit-win-comment">{t('comment')}</label>
            <textarea
              id="hit-win-comment"
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
              <Save size={14} />
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
            {entries.length} {language === 'zh' ? '条笔记' : 'notes'}
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
                      <strong style={{ fontSize: '0.95rem' }}>{language === 'zh' ? '个人笔记' : 'Personal note'}</strong>
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

                  <div aria-hidden="true" style={{ display: 'none' }}>
                    <strong>{t('hitContent')}</strong>
                    {/*
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
                      <p style={{ display: 'none' }}>
                        {null}
                      </p>
                    */}
                  </div>

                  <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem' }}>
                    <strong style={{ fontSize: '0.8rem', color: 'hsl(var(--text-secondary))' }}>{t('hitContent')}</strong>
                    <ul style={{ listStyle: 'none', marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                      {score.rows.map((row, index) => {
                        const match = row.match;
                        const fixture = row.fixture;
                        const home = match ? getTeamById(match.homeTeamId) : null;
                        const away = match ? getTeamById(match.awayTeamId) : null;
                        const homeName = match?.homeTeamName
                          || fixture?.[language === 'zh' ? 'homeTeamName' : 'homeTeamNameEn']
                          || fixture?.homeTeamName
                          || home?.shortName[language]
                          || (language === 'zh' ? '主队' : 'Home');
                        const awayName = match?.awayTeamName
                          || fixture?.[language === 'zh' ? 'awayTeamName' : 'awayTeamNameEn']
                          || fixture?.awayTeamName
                          || away?.shortName[language]
                          || (language === 'zh' ? '客队' : 'Away');
                        const stateLabel = row.state === 'settled'
                          ? (row.isHit ? t('hit') : t('miss'))
                          : row.state === 'waiting' ? t('waiting') : t('unavailable');
                        const stateColor = row.state === 'settled'
                          ? (row.isHit ? 'hsl(var(--primary))' : 'hsl(var(--danger))')
                          : 'hsl(var(--text-muted))';
                        return (
                          <li key={`${entry.id}-${match?.id || index}`} style={{ border: '1px solid hsl(var(--border))', borderRadius: '8px', padding: '0.55rem 0.6rem', fontSize: '0.76rem', color: 'hsl(var(--text-secondary))' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                              <strong style={{ color: 'hsl(var(--text-primary))' }}>{homeName} vs {awayName}</strong>
                              <span style={{ color: stateColor, fontWeight: '800', whiteSpace: 'nowrap' }}>{stateLabel}</span>
                            </div>
                            <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem', color: 'hsl(var(--text-muted))' }}>
                              <span>{pickLabels[row.pick][language]}</span>
                              {row.isSettled && match && (
                                <>
                                  <span>·</span>
                                  <span>{t('score')} {match.scoreHome}:{match.scoreAway}</span>
                                  <span>·</span>
                                  <span>{t('actualResult')} {row.resultPick ? pickLabels[row.resultPick][language] : '--'}</span>
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <p style={{ marginTop: '0.55rem', color: 'hsl(var(--text-muted))', fontSize: '0.76rem', lineHeight: 1.5 }}>
                      <strong style={{ color: 'hsl(var(--text-secondary))' }}>{t('reviewFeedback')}：</strong>
                      {score.settled > 0
                        ? t('settledFeedback')
                        : score.waiting > 0
                          ? t('waitingFeedback')
                          : t('unavailableFeedback')}
                    </p>
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
