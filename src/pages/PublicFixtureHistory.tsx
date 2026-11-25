import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { buildApiUrl } from '../services/runtimeUrls';
import '../styles/public-browse.css';

interface ArchiveFixture {
  id: string;
  matchNo: string;
  leagueName: string;
  homeTeamName: string;
  awayTeamName: string;
  kickoffTime: string;
  status: 'FINISHED' | 'VOID' | 'PENDING_RESULT' | 'CONFLICT';
  scoreHome: number | null;
  scoreAway: number | null;
}
interface Archive {
  dates: string[];
  businessDate: string | null;
  latestResultDate: string | null;
  sourceAvailable: {native: boolean; signed: boolean};
  incomplete: boolean;
  matches: ArchiveFixture[];
}

const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export default function PublicFixtureHistory() {
  const { language } = useApp();
  const zh = language === 'zh';
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || '';
  const query = params.get('q') || '';
  const [result, setResult] = useState<{date: string; archive: Archive} | null>(null);
  const [error, setError] = useState<{date: string; invalid: boolean} | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const suffix = date ? '?date=' + encodeURIComponent(date) : '';
        const response = await fetch(buildApiUrl('/api/public/fixtures/history' + suffix), {signal: controller.signal});
        if (!response.ok) throw Object.assign(new Error('Archive unavailable'), {status: response.status});
        const archive = await response.json() as Archive;
        if (!Array.isArray(archive.dates) || !Array.isArray(archive.matches) || !archive.sourceAvailable
          || (date && archive.businessDate !== date)) throw new Error('Invalid archive response');
        if (active) { setResult({date, archive}); setError(null); }
      } catch (cause) {
        if (active) setError({date, invalid: typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 400});
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [date, retry]);

  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  }
  const archive = result?.date === date ? result.archive : null;
  const issue = error?.date === date ? error : null;
  const selected = date || archive?.businessDate || '';
  const term = query.trim().normalize('NFKC').toLowerCase();
  const rows = archive?.matches.filter(row =>
    [row.matchNo, row.leagueName, row.homeTeamName, row.awayTeamName].some(value => value.normalize('NFKC').toLowerCase().includes(term)));
  return <section className="public-browse">
    <header className="public-hero"><div><h1>{zh ? '历史比赛与赛果' : 'Historical fixtures and results'}</h1>
      <p>{zh ? '按竞彩日查看，跨午夜开球的比赛仍归原竞彩日。' : 'Matches stay with their Sporttery issue date, including kickoffs after midnight.'}</p>
    </div><Link className="public-back" to="/fixtures">{zh ? '返回今日赛程' : 'Today’s fixtures'}</Link></header>
    <div>
      <div className="public-filters">
        <label>{zh ? '选择竞彩日' : 'Match day'}<input type="date" value={selected} onChange={event => change('date', event.target.value)}/></label>
        {archive && archive.dates.length > 0 && <label>{zh ? '已收录日期' : 'Archived dates'}
          <select value={archive.dates.includes(selected) ? selected : ''} onChange={event => change('date', event.target.value)}>
            {!archive.dates.includes(selected) && <option value="" disabled>{zh ? '选择日期' : 'Select a date'}</option>}
            {archive.dates.map(value => <option key={value}>{value}</option>)}
          </select></label>}
        <label className="public-search">{zh ? '搜索' : 'Search'}<input value={query} placeholder={zh ? '球队、联赛或编号' : 'Team, league or number'} onChange={event => change('q', event.target.value)}/></label>
      </div>
      {issue ? <p className="public-notice" role="alert">{issue.invalid ? (zh ? '日期无效，请重新选择竞彩日。' : 'Choose a valid match day.')
        : (zh ? '暂时无法读取历史赛果，请重试。' : 'Historical results are temporarily unavailable.')}
        {!issue.invalid && <button onClick={() => { setError(null); setRetry(value => value + 1); }}>{zh ? '重试' : 'Retry'}</button>}</p>
        : !archive ? <p role="status">{zh ? '正在读取历史赛果…' : 'Loading historical results…'}</p> : <>
          <p className="public-caption">{archive.latestResultDate ? (zh ? '最近有已核终场比分的竞彩日' : 'Latest issue with a verified final score') + ' · ' + archive.latestResultDate
            : (zh ? '归档中尚无已核终场比分。' : 'The archive has no verified final scores yet.')}</p>
          {(!archive.sourceAvailable.native || !archive.sourceAvailable.signed || archive.incomplete) && <p className="public-notice" role="status">
            {!archive.sourceAvailable.native && (zh ? '较早的比赛归档暂不可用。' : 'The older fixture archive is currently unavailable. ')}
            {!archive.sourceAvailable.signed && (zh ? '近期官方赛果暂不可用。' : 'The recent official results are currently unavailable. ')}
            {archive.incomplete && (zh ? '官方此竞彩日的分页记录不完整。' : 'Official page coverage for this match day is incomplete.')}
          </p>}
          {!archive.matches.length ? <p className="public-empty" role="status">{!archive.sourceAvailable.native || !archive.sourceAvailable.signed || archive.incomplete
            ? (zh ? '所查日暂无可展示的记录，覆盖尚未核全。' : 'No records can be shown for this day while coverage is incomplete.')
            : (zh ? '归档尚未覆盖所查竞彩日。' : 'The archive does not cover this match day yet.')}</p>
           : !rows?.length ? <p className="public-empty" role="status">{zh ? '此竞彩日没有匹配的比赛。' : 'No fixtures match this search.'}</p>
           : <div className="public-grid">{rows.map(row => <article className="public-fixture" key={row.id + row.kickoffTime}>
              <div className="public-fixture-meta"><span>{[row.matchNo, row.leagueName].filter(Boolean).join(' · ')}</span>
                <time dateTime={row.kickoffTime}>{clock.format(new Date(row.kickoffTime))} {zh ? '北京时间' : 'Beijing'}</time></div>
              <Link className="public-matchup" to={`/match/${encodeURIComponent(row.id)}?date=${archive.businessDate}`} state={{openedFromList:true,fromPath:"/fixtures/history?"+params.toString()}}><span><strong>{row.homeTeamName}</strong></span>
                <b>{row.status === 'FINISHED' ? row.scoreHome + ' : ' + row.scoreAway : '—'}</b><span><strong>{row.awayTeamName}</strong></span></Link>
              <span className="public-caption">{row.status === 'FINISHED' ? (zh ? '全场比分' : 'Full time') : row.status === 'VOID' ? (zh ? '官方作废' : 'Voided') : row.status === 'CONFLICT' ? (zh ? '归档记录冲突，比分待核' : 'Conflicting records; final score unverified') : (zh ? '终场比分待核' : 'Final score unverified')}</span>
            </article>)}</div>}
        </>}
    </div>
  </section>;
}
