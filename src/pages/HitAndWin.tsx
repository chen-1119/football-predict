import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { getTeamById } from '../services/entities';
import { DateScopeBar } from '../components/predictions/DateScopeBar';

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const reviewDateKey = (match: Match) => {
  const explicitDate = String(match.businessDate || match.matchDate || match.kickoffDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) return explicitDate;
  const kickoffAt = new Date(match.kickoffTime || '');
  if (!Number.isFinite(kickoffAt.getTime())) return '';
  const parts = shanghaiDateFormatter.formatToParts(kickoffAt);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
};

const formatReviewDate = (date: string, language: 'zh' | 'en') => {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).format(parsed);
};

export const HitAndWin: React.FC = () => {
  const { language, matches, dataSync } = useApp();
  const navigate = useNavigate();

  const allSystemReviewMatches = useMemo(() => matches
    .filter((match) => match.status === 'FINISHED' || Boolean(match.postMatchReview))
    .sort((left, right) => {
      const leftAt = Date.parse(left.postMatchReview?.generatedAt || left.resultUpdatedAt || left.kickoffTime || '') || 0;
      const rightAt = Date.parse(right.postMatchReview?.generatedAt || right.resultUpdatedAt || right.kickoffTime || '') || 0;
      return rightAt - leftAt;
    }), [matches]);

  const systemReviewDates = useMemo(() => Array.from(new Set(
    allSystemReviewMatches.map(reviewDateKey).filter(Boolean)
  )).sort((left, right) => right.localeCompare(left)), [allSystemReviewMatches]);
  const [selectedReviewDate, setSelectedReviewDate] = useState('');
  const activeReviewDate = selectedReviewDate && systemReviewDates.includes(selectedReviewDate)
    ? selectedReviewDate
    : systemReviewDates[0] || '';
  const quickReviewDates = systemReviewDates.slice(0, 3);
  const olderReviewDates = systemReviewDates.slice(3, 31);
  const selectedOlderReviewDate = olderReviewDates.includes(activeReviewDate) ? activeReviewDate : '';
  const systemReviewMatches = useMemo(() => allSystemReviewMatches.filter((match) => (
    !activeReviewDate || reviewDateKey(match) === activeReviewDate
  )), [activeReviewDate, allSystemReviewMatches]);
  const systemReviewSummary = useMemo(() => systemReviewMatches.reduce((summary, match) => {
    const predictionReview = match.postMatchReview?.predictionReview;
    const settledRows = predictionReview?.rows?.filter((row) => row.resultStatus === 'WON' || row.resultStatus === 'LOST') || [];
    const referenceBestRow = settledRows.find((row) => (
      row.marketType === 'BEST'
      && row.performanceTrack !== 'formal'
      && row.performanceTrack !== 'live-model'
      && (row.recommendationAction === 'reference' || row.reviewRole === 'reference')
    ));
    if (predictionReview?.formalBestStatus === 'WON') summary.formalWon += 1;
    if (predictionReview?.formalBestStatus === 'LOST') summary.formalLost += 1;
    if (referenceBestRow?.resultStatus === 'WON') summary.referenceWon += 1;
    if (referenceBestRow?.resultStatus === 'LOST') summary.referenceLost += 1;
    if (match.postMatchReview) summary.reviewed += 1;
    else summary.resultOnly += 1;
    return summary;
  }, {
    formalWon: 0,
    formalLost: 0,
    referenceWon: 0,
    referenceLost: 0,
    reviewed: 0,
    resultOnly: 0
  }), [systemReviewMatches]);
  const formalReviewPerformance = dataSync.modelEvaluation?.publicScorecard?.formalReviewPerformance;
  const selectedFormalPerformance = formalReviewPerformance?.daily?.find((row) => row.date === activeReviewDate);
  const selectedFormalSettled = Number(selectedFormalPerformance?.settled
    ?? (systemReviewSummary.formalWon + systemReviewSummary.formalLost));
  const selectedFormalWon = Number(selectedFormalPerformance?.won ?? systemReviewSummary.formalWon);
  const selectedFormalHitRate = selectedFormalSettled > 0 ? selectedFormalWon / selectedFormalSettled : null;
  const selectedReferenceSettled = systemReviewSummary.referenceWon + systemReviewSummary.referenceLost;
  const selectedReferenceHitRate = selectedReferenceSettled > 0
    ? systemReviewSummary.referenceWon / selectedReferenceSettled
    : null;
  const cumulativeReferencePerformance = useMemo(() => allSystemReviewMatches.reduce((summary, match) => {
    const date = reviewDateKey(match);
    if (!date || date < (formalReviewPerformance?.startDate || '2026-08-16')) return summary;
    const settledRows = match.postMatchReview?.predictionReview?.rows?.filter((row) => row.resultStatus === 'WON' || row.resultStatus === 'LOST') || [];
    const referenceBestRow = settledRows.find((row) => (
      row.marketType === 'BEST'
      && row.performanceTrack !== 'formal'
      && row.performanceTrack !== 'live-model'
      && (row.recommendationAction === 'reference' || row.reviewRole === 'reference')
    ));
    if (referenceBestRow?.resultStatus === 'WON') summary.won += 1;
    if (referenceBestRow?.resultStatus === 'LOST') summary.lost += 1;
    return summary;
  }, { won: 0, lost: 0 }), [allSystemReviewMatches, formalReviewPerformance?.startDate]);
  const cumulativeReferenceSettled = cumulativeReferencePerformance.won + cumulativeReferencePerformance.lost;
  const cumulativeReferenceHitRate = cumulativeReferenceSettled > 0
    ? cumulativeReferencePerformance.won / cumulativeReferenceSettled
    : null;
  const cumulativeFormalPerformance = formalReviewPerformance?.cumulative;
  const formatHitRate = (rate: number | null | undefined) => (
    typeof rate === 'number' && Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '--'
  );

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
    nextAdjustment: { zh: '后续调整', en: 'Next adjustment' },
    mistakeReason: { zh: '未命中与失误定位', en: 'Miss and error diagnosis' },
    frozenDirection: { zh: '赛前冻结方向', en: 'Frozen pre-match direction' },
    scoreReview: { zh: '比分复盘', en: 'Score review' },
    fullReview: { zh: '查看完整复盘', en: 'Open full review' },
    reviewedCount: { zh: '完整复盘', en: 'Full reviews' },
    resultOnlyCount: { zh: '仅赛果', en: 'Result only' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {language === 'zh' ? '赛后复盘中心' : 'Post-match Review Center'}
        </h1>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {language === 'zh'
            ? '只展示已进入赛果阶段的历史比赛；按比赛日期筛选，点击任一场可查看完整结算、未命中原因和后续调整。'
            : 'Only historical fixtures with results are shown. Filter by match date and open any fixture for settlement, miss diagnosis, and next adjustments.'}
        </p>
      </div>

      <section className="card premium-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.25rem', borderColor: 'hsl(var(--primary) / 0.28)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: '900', color: 'hsl(var(--text-primary))' }}>{t('systemReviewTitle')}</h2>
            <p style={{ marginTop: '0.35rem', color: 'hsl(var(--text-secondary))', fontSize: '0.82rem', lineHeight: 1.5 }}>{t('systemReviewSubtitle')}</p>
          </div>
        </div>
        {systemReviewDates.length > 0 && (
          <DateScopeBar
            selectedDate={activeReviewDate}
            quickOptions={quickReviewDates.map((date, index) => ({
              date,
              label: index === 0
                ? (language === 'zh' ? '最新' : 'Latest')
                : index === 1
                  ? (language === 'zh' ? '上一期' : 'Previous')
                  : (language === 'zh' ? '上两期' : 'Two back'),
              displayDate: formatReviewDate(date, language)
            }))}
            historyOptions={olderReviewDates.map((date) => ({
              date,
              label: language === 'zh' ? '更早' : 'Earlier',
              displayDate: formatReviewDate(date, language)
            }))}
            selectedHistoryDate={selectedOlderReviewDate}
            historyLabel={language === 'zh' ? '更多复盘日期' : 'More review dates'}
            onSelectDate={setSelectedReviewDate}
          />
        )}
        {systemReviewMatches.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.78rem', color: 'hsl(var(--text-secondary))' }}>
            <span className="mini-watch">{t('reviewedCount')} {systemReviewSummary.reviewed}/{systemReviewMatches.length}</span>
            {systemReviewSummary.resultOnly > 0 && <span className="mini-watch">{t('resultOnlyCount')} {systemReviewSummary.resultOnly}</span>}
            <span className="mini-hit" data-review-date-reference-hit-rate={selectedReferenceHitRate ?? ''}>
              {language === 'zh' ? '当日数据推荐命中率' : 'Daily data-pick hit rate'} {formatHitRate(selectedReferenceHitRate)} ({systemReviewSummary.referenceWon}/{selectedReferenceSettled})
            </span>
            {selectedFormalSettled > 0 && (
              <span className="mini-hit" data-review-date-hit-rate={selectedFormalHitRate ?? ''}>
                {language === 'zh' ? '当日正式命中率' : 'Daily formal hit rate'} {formatHitRate(selectedFormalHitRate)} ({selectedFormalWon}/{selectedFormalSettled})
              </span>
            )}
            {cumulativeReferenceSettled > 0 && (
              <span className="mini-hit" data-review-cumulative-reference-hit-rate={cumulativeReferenceHitRate ?? ''}>
                {language === 'zh' ? `数据推荐累计（自 ${formalReviewPerformance?.startDate || '2026-08-16'}）` : `Data-pick cumulative since ${formalReviewPerformance?.startDate || '2026-08-16'}`} {formatHitRate(cumulativeReferenceHitRate)} ({cumulativeReferencePerformance.won}/{cumulativeReferenceSettled})
              </span>
            )}
            {Number(cumulativeFormalPerformance?.settled || 0) > 0 && (
              <span className="mini-hit" data-review-cumulative-hit-rate={cumulativeFormalPerformance?.hitRate ?? ''}>
                {language === 'zh' ? `累计命中率（自 ${formalReviewPerformance?.startDate || '2026-08-16'}）` : `Cumulative since ${formalReviewPerformance?.startDate || '2026-08-16'}`} {formatHitRate(cumulativeFormalPerformance?.hitRate)} ({Number(cumulativeFormalPerformance?.won || 0)}/{Number(cumulativeFormalPerformance?.settled || 0)})
              </span>
            )}
          </div>
        )}
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
              const settledRows = review?.predictionReview?.rows?.filter((row) => row.resultStatus === 'WON' || row.resultStatus === 'LOST') || [];
              const formalReviewRow = settledRows.find((row) => row.marketType === 'BEST' && row.performanceTrack === 'formal')
                || settledRows.find((row) => row.performanceTrack === 'formal');
              const liveReviewRow = settledRows.find((row) => row.marketType === 'BEST' && row.performanceTrack === 'live-model')
                || settledRows.find((row) => row.performanceTrack === 'live-model');
              const referenceReviewRow = settledRows.find((row) => (
                row.marketType === 'BEST'
                && (row.recommendationAction === 'reference' || row.reviewRole === 'reference')
              )) || settledRows.find((row) => row.recommendationAction === 'reference' || row.reviewRole === 'reference');
              // Preserve independent ledgers while still showing the real
              // pre-match direction that the customer saw.
              const primaryReviewRow = formalReviewRow || liveReviewRow || referenceReviewRow;
              const primaryTrack = formalReviewRow
                ? 'formal'
                : liveReviewRow
                  ? 'live-model'
                  : referenceReviewRow
                    ? 'reference'
                    : 'result-only';
              const directionLabel = formalStatus === 'WON'
                ? (language === 'zh' ? '正式推荐 · 命中' : 'Formal pick · Hit')
                : formalStatus === 'LOST'
                  ? (language === 'zh' ? '正式推荐 · 未命中' : 'Formal pick · Miss')
                  : primaryTrack === 'live-model' && primaryReviewRow?.resultStatus === 'WON'
                    ? (language === 'zh' ? '实时推荐 · 命中' : 'Live pick · Hit')
                    : primaryTrack === 'live-model' && primaryReviewRow?.resultStatus === 'LOST'
                      ? (language === 'zh' ? '实时推荐 · 未命中' : 'Live pick · Miss')
                      : primaryTrack === 'reference' && primaryReviewRow?.resultStatus === 'WON'
                        ? (language === 'zh' ? '数据推荐 · 命中（独立统计）' : 'Data pick · Hit (separate record)')
                        : primaryTrack === 'reference' && primaryReviewRow?.resultStatus === 'LOST'
                          ? (language === 'zh' ? '数据推荐 · 未命中（独立统计）' : 'Data pick · Miss (separate record)')
                          : t('resultOnly');
              const directionColor = primaryReviewRow?.resultStatus === 'WON'
                ? 'hsl(var(--primary))'
                : primaryReviewRow?.resultStatus === 'LOST'
                  ? 'hsl(var(--danger))'
                  : 'hsl(var(--text-muted))';
              const frozenDirection = primaryReviewRow?.tipLabel?.[language] || primaryReviewRow?.tipCode || '--';
              const marketLabel = primaryReviewRow?.oddsPoolCode === 'HHAD'
                ? `HHAD${primaryReviewRow.handicapLine ? ` ${primaryReviewRow.handicapLine}` : ''}`
                : primaryReviewRow?.oddsPoolCode === 'HAD' ? 'HAD' : primaryReviewRow?.marketType || '--';
              const primaryMissSummary = primaryReviewRow?.resultStatus === 'LOST'
                ? (language === 'zh'
                  ? `赛前冻结方向为“${frozenDirection}”，实际结算为“${primaryReviewRow.actualLabel?.zh || actualResult}”；本场直接失误是主方向判断错误。其余原因只按已接入证据列出，不用缺失数据倒推事实。`
                  : `The frozen direction was “${frozenDirection}”, while settlement was “${primaryReviewRow.actualLabel?.en || actualResult}”. The direct error was the primary direction call; other causes are listed only when supported by available evidence.`)
                : '';
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
                  {primaryReviewRow && (
                    <div style={{ fontSize: '0.76rem', color: 'hsl(var(--text-secondary))' }}>
                      <span>{t('frozenDirection')}<strong style={{ display: 'block', color: 'hsl(var(--text-primary))' }}>{marketLabel} · {frozenDirection}{Number(primaryReviewRow.odds || 0) > 1 ? ` @${Number(primaryReviewRow.odds).toFixed(2)}` : ''}</strong></span>
                    </div>
                  )}
                  {(review?.modelDiagnosis?.length || review?.nextAdjustment?.length) ? (
                    <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.5rem', fontSize: '0.75rem', color: 'hsl(var(--text-muted))', lineHeight: 1.5 }}>
                      {primaryMissSummary && <p><strong>{t('mistakeReason')}：</strong>{primaryMissSummary}</p>}
                      {review?.modelDiagnosis?.slice(0, 1).map((item, index) => <p key={`reason-${item.code}`}><strong>{index === 0 ? `${t('reviewReason')}：` : ''}</strong>{item[language]}</p>)}
                      {review?.nextAdjustment?.slice(0, 1).map((item, index) => <p key={`adjust-${item.code}`}><strong>{index === 0 ? `${t('nextAdjustment')}：` : ''}</strong>{item[language]}</p>)}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`${t('fullReview')}：${homeName} vs ${awayName}`}
                    onClick={() => navigate(`/match/${encodeURIComponent(match.id)}`, {
                      state: { openedFromList: true, fromPath: '/review' }
                    })}
                    style={{ alignSelf: 'flex-start', marginTop: '0.15rem' }}
                  >
                    {t('fullReview')}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
