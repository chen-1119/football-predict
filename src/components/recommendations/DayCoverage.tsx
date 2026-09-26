import type { DayCoverageData } from '../../services/recommendationCenterView';

type Language = 'zh' | 'en';

interface Props {
  coverage?: DayCoverageData | null;
  businessDate: string;
  qualifiedOnly: boolean;
  onQualifiedOnlyChange: (value: boolean) => void;
  onSelectMatch: (id: string) => void;
  language: Language;
}

const percent = (part: number, total: number) => total > 0 ? `${(part / total * 100).toFixed(0)}%` : '—';

export function DayCoverage({ coverage, businessDate, qualifiedOnly, onQualifiedOnlyChange, onSelectMatch, language }: Props) {
  const zh = language === 'zh';
  const current = coverage?.businessDate === businessDate ? coverage : null;
  return <section className="rc-coverage" aria-label={zh ? '当日比赛与推荐覆盖' : 'Match-day recommendation coverage'}>
    <div className="rc-coverage__heading">
      <div>
        <span className="rc-coverage__eyebrow">{zh ? '当日竞彩' : 'MATCH-DAY COVERAGE'}</span>
        <h2>{zh ? '每场比赛都有明确状态' : 'A clear status for every match'}</h2>
        <p>{zh ? '参考入选还要求模型方向清晰，且不与同期 SP 严重冲突；仍不表示命中率已验证。缺项与观望场次均计入目标比赛。' : 'Reference admission requires usable samples, a clear model lead, and no material contradiction with same-time SP. Accuracy is not yet validated; watch cases remain in the total.'}</p>
      </div>
      <div className="rc-coverage__switch" role="group" aria-label={zh ? '推荐筛选' : 'Recommendation filter'}>
        <button type="button" aria-pressed={!qualifiedOnly} onClick={() => onQualifiedOnlyChange(false)}>{zh ? '全部已发布方向' : 'All published picks'}</button>
        <button type="button" aria-pressed={qualifiedOnly} onClick={() => onQualifiedOnlyChange(true)}>{zh ? '参考入选' : 'Reference-qualified'}</button>
      </div>
    </div>
    {current ? <>
      <div className="rc-coverage__numbers">
        <div><span>{zh ? '目标比赛' : 'Target matches'}</span><strong>{current.targetCount}</strong></div>
        <div><span>{zh ? '已生成参考方向' : 'Published reference picks'}</span><strong>{current.publishableCount}</strong></div>
        <div><span>{zh ? '参考入选' : 'Reference-qualified'}</span><strong>{current.qualifiedCount}</strong></div>
        <div><span>{zh ? '入选覆盖率' : 'Admission coverage'}</span><strong>{percent(current.qualifiedCount, current.targetCount)}</strong></div>
      </div>
      {current.missingTotal || current.missing.length ? <details className="rc-coverage__missing" open={!qualifiedOnly}>
        <summary>{zh ? `查看未入选原因（${current.missingTotal ?? current.missing.length} 场）` : `Why not selected (${current.missingTotal ?? current.missing.length})`}</summary>
        <ul>{current.missing.map((item, index) => <li key={`${item.sourceMatchId || item.matchId || 'missing'}-${index}`}>
          <span><strong>{item.homeTeamName} vs {item.awayTeamName}</strong><small>{item.reasonText}</small></span>
          {item.matchId && <button type="button" onClick={() => onSelectMatch(item.matchId!)}>{zh ? '赛程详情' : 'Match details'}</button>}
        </li>)}</ul>
        {current.hasMore && <p>{zh ? '还有比赛未在此处展开，可在赛程查看全部场次。' : 'See the schedule for the remaining matches.'}</p>}
      </details> : <p className="rc-coverage__note">{current.targetCount===0?(zh?'当前竞彩日暂无目标比赛。':'No target matches for this match day.'):(zh ? '当日目标比赛均已有可核验的入选状态。' : 'All target matches have a verified selection state.')}</p>}
    </> : <p className="rc-coverage__pending" role="status">{zh ? '正在核对当日比赛目标池，覆盖率尚不可用。' : 'Checking the match-day target pool; coverage is not yet available.'}</p>}
  </section>;
}
