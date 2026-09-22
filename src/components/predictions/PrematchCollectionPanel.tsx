import { useEffect, useState } from 'react';
import { getAccessAuthHeaders } from '../../services/accessControl';
import { buildApiUrl } from '../../services/runtimeUrls';
import '../../styles/prematch-collection.css';

type Player = { name: string; side?: 'home' | 'away'; reason?: string; position?: string; expectedReturn?: string; jersey?: string };
type Section = { status: string; observedAt: string | null; lastAttemptAt: string | null; previousValue: boolean;
  missingReason?: string | null;
  data: { players?: Player[]; teams?: Array<{ side: 'home' | 'away'; formation: string; coach?: string; starters: Player[]; substitutes: Player[] }> } | null };
type Evidence = { matchId: string; status: string; predictionEligible: false; sections?: { injuries: Section; lineup: Section } };
type RefreshRequest = { matchId: string; state: 'queued' | 'cooldown' | 'error'; nextAllowedAt?: string; error?: string };
const labels: Record<string, [string, string]> = {
  ok: ['资料校验通过', 'Evidence verified'],
  available: ['已有资料', 'Available'], source_empty: ['暂无可展示资料', 'No data available'], missing: ['资料待补充', 'Awaiting data'],
  unavailable: ['资料暂不可用', 'Unavailable'], stale: ['资料已过期', 'Expired'], disabled: ['采集尚未启用', 'Collection disabled'],
  ineligible: ['不在赛前采集范围', 'Outside collection window'], partial: ['部分资料待补充', 'Partial coverage'],
  blocked: ['资料暂未更新', 'Awaiting an update'], login_required: ['资料暂未更新', 'Awaiting an update'],
  conflict: ['资料待核对', 'Data unverified'], parse_error: ['资料暂未更新', 'Awaiting an update'],
  loading: ['正在读取资料', 'Loading data'], unauthorized: ['请先验证访问权限', 'Access verification required'],
  'fixture-stale': ['比赛输入已过期', 'Fixture input expired'], 'fixture-unavailable': ['比赛输入暂不可用', 'Fixture unavailable'],
  'collection-paused': ['采集等待恢复', 'Collection paused'], 'browser-unavailable': ['采集环境不可用', 'Collector unavailable'],
  'source-unavailable': ['资料暂不可用', 'Data unavailable'], 'runtime-error': ['资料暂未更新', 'Awaiting an update'],
  running: ['正在采集', 'Collecting'], completed: ['本轮检查完成', 'Check completed'],
  'no-due-tasks': ['本轮检查完成，等待更新窗口', 'Checked; awaiting refresh window'], 'budget-exhausted': ['剩余资料下轮补充', 'Remaining data deferred'],
  unmapped: ['暂无可展示资料', 'No data available'], 'not-due': ['资料待更新', 'Awaiting data'],
};
const reasonLabels: Record<string, string> = {
  'Achilles Tendon Injury': '跟腱伤情', 'Groin Injury': '腹股沟伤情', 'Knee Injury': '膝部伤情', 'Ankle Injury': '踝部伤情',
  'Muscle Injury': '肌肉伤情', 'Hamstring Injury': '腿后肌伤情', 'Thigh Injury': '大腿伤情', 'Calf Injury': '小腿伤情',
  'Foot Injury': '足部伤情', 'Back Injury': '背部伤情', 'Shoulder Injury': '肩部伤情', Illness: '身体不适',
  Injury: '伤情未详述', Inactive: '未激活', Suspended: '停赛', 'Red Card': '红牌停赛',
  'Yellow Cards': '累计黄牌停赛', Rest: '休整', 'Missing Fixture': '缺席',
};
const positions: Record<string, string> = { G: '门将', D: '后卫', M: '中场', F: '前锋', Goalkeeper: '门将', Defender: '后卫', Midfielder: '中场', Attacker: '前锋' };

export function PrematchCollectionPanel({ matchId, language, homeName, awayName, kickoffTime }: {
  matchId: string; language: 'zh' | 'en'; homeName?: string; awayName?: string; kickoffTime?: string;
}) {
  const [result, setResult] = useState<Evidence | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [request, setRequest] = useState<RefreshRequest | null>(null);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => { const timer = setInterval(() => setRefreshTick(value => value + 1), 60000); return () => clearInterval(timer); }, []);
  const evidence = result?.matchId === matchId ? result : null;
  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    setFetching(true);
    const timer = setTimeout(() => controller.abort(), 10000);
    fetch(buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}/prematch-evidence`), {
      headers: getAccessAuthHeaders(), cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : 'unavailable');
      const value = await response.json() as Evidence;
      if (value.matchId !== matchId || value.predictionEligible !== false) throw new Error('unavailable');
      if (!disposed && !controller.signal.aborted) setResult(value);
    }).catch(error => {
      if (!disposed) setResult({ matchId, status: error.message === 'unauthorized' ? 'unauthorized' : 'unavailable', predictionEligible: false });
    }).finally(() => { clearTimeout(timer); if (!disposed) setFetching(false); });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [matchId, refreshTick]);
  const zh = language === 'zh';
  const label = (status: string) => (labels[status] || labels.unavailable)[zh ? 0 : 1];
  const time = (value?: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(Date.parse(value)) : '—';
  const sideName = (side: 'home' | 'away') => (side === 'home' ? homeName : awayName) || (side === 'home' ? (zh ? '主队' : 'Home') : (zh ? '客队' : 'Away'));
  const injuries = evidence?.sections?.injuries, lineup = evidence?.sections?.lineup;
  const players = injuries?.data?.players || [], teams = lineup?.data?.teams || [];
  const observed = [injuries, lineup].filter(section => section?.data).map(section => section?.observedAt).filter((at): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at))).sort();
  const lineupWindow = kickoffTime && Number.isFinite(Date.parse(kickoffTime)) ? new Date(Date.parse(kickoffTime) - 3600000).toISOString() : null;
  const beforeLineupWindow = lineupWindow && Date.now() < Date.parse(lineupWindow);
  const collectingStopped = kickoffTime && Date.now() >= Date.parse(kickoffTime);
  const activeRequest = request?.matchId === matchId ? request : null;
  const requestCooling = Boolean(activeRequest?.nextAllowedAt && Date.parse(activeRequest.nextAllowedAt) > Date.now());
  const canRequest = Boolean(kickoffTime && Date.parse(kickoffTime) > Date.now() && evidence?.status !== 'ineligible');
  const requestRefresh = async () => {
    if (requesting || requestCooling || !canRequest) return;
    setRequesting(true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}/prematch-refresh`), {
        method: 'POST', headers: { ...getAccessAuthHeaders(), 'x-prematch-request': '1' }, credentials: 'same-origin', signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : response.status === 409 ? 'ineligible' : response.status === 403 ? 'request-denied' : 'unavailable');
      const value = await response.json();
      if (value.ok !== true || value.referenceOnly !== true || !['queued', 'cooldown'].includes(value.state)
        || !Number.isFinite(Date.parse(value.nextAllowedAt))) throw new Error('unavailable');
      setRequest({ matchId, state: value.state, nextAllowedAt: value.nextAllowedAt });
    } catch (error) { setRequest({ matchId, state: 'error', error: error instanceof Error ? error.message : 'unavailable' }); }
    finally { clearTimeout(timer); setRequesting(false); }
  };
  const position = (value?: string) => value ? (zh ? positions[value] || value : value) : '';
  const sectionStatus = (section?: Section) => {
    if (section?.data) return section.previousValue ? (zh ? '上次记录' : 'Previous record') : (zh ? '已采集' : 'Collected');
    if (!evidence) return label('loading');
    return section?.status === 'stale' ? (zh ? '资料已过期，等待更新' : 'Expired; awaiting update') : (zh ? '暂无可展示资料' : 'No data available');
  };
  const sectionTiming = (section?: Section) => section?.data && section.observedAt
    ? (zh ? '资料时间：' : 'Received: ') + time(section.observedAt) : null;
  return <section className="card prematch-report" data-testid="prematch-collection" aria-labelledby={`prematch-heading-${matchId}`} aria-busy={fetching}>
    <header className="prematch-report__head">
      <div><span className="prematch-report__eyebrow">{zh ? '最新补充资料' : 'LATEST MATCH DATA'}</span><h3 id={`prematch-heading-${matchId}`}>{zh ? '伤停与比赛阵容' : 'Injuries & lineups'}</h3>
        <p>{zh ? '查看本场实际采集的球员明细。新增资料仅供参考，推荐是否采用以决策记录为准。' : 'Collected player details for this match. Reference data; adoption is determined by the recorded decision.'}</p></div>
      <div className="prematch-report__actions"><button type="button" className="prematch-report__refresh" disabled={fetching} onClick={() => setRefreshTick(value => value + 1)}>{fetching ? (zh ? '读取中…' : 'Loading…') : (zh ? '刷新资料' : 'Refresh data')}</button>
        <button type="button" className="prematch-report__refresh" disabled={requesting || requestCooling || !canRequest} onClick={requestRefresh}>{requesting ? (zh ? '提交中…' : 'Queuing…') : requestCooling ? (zh ? '更新请求已提交' : 'Update requested') : (zh ? '更新本场资料' : 'Update match data')}</button></div>
    </header>
    {activeRequest && <p className="prematch-report__notice" role="status">{activeRequest.state === 'error'
      ? activeRequest.error === 'request-denied' ? (zh ? '补采请求未通过验证，请重新打开本站后重试。' : 'Request verification failed. Reopen this site and retry.') : label(activeRequest.error || 'unavailable')
      : (zh ? '更新请求已提交，有新资料后会自动显示。' : 'Update requested. New data will appear when available.')}
      {requestCooling && ` ${zh ? '可再次请求：' : 'Request again after: '}${time(activeRequest.nextAllowedAt)}`}</p>}
    <div className="prematch-report__metrics" aria-live="polite">
      <div><span>{zh ? '伤停记录' : 'Injury records'}</span><strong>{evidence ? players.length : '—'}<small>{zh ? ' 条' : ' records'}</small></strong><p>{players.length ? (zh ? `主队 ${players.filter(p => p.side === 'home').length} · 客队 ${players.filter(p => p.side === 'away').length}` : `Home ${players.filter(p => p.side === 'home').length} · Away ${players.filter(p => p.side === 'away').length}`) : (evidence ? (zh ? '暂无可展示记录' : 'No records available') : label('loading'))}</p></div>
      <div><span>{zh ? '确认首发' : 'Confirmed lineup'}</span><strong>{evidence ? teams.length : '—'}<small> / 2 {zh ? '队' : 'teams'}</small></strong><p>{teams.length ? (zh ? '首发与替补名单可查' : 'Starters and bench available') : (zh ? '首发名单待更新' : 'Awaiting lineup')}</p></div>
      <div><span>{zh ? '资料采集时间 · 北京' : 'Data received · Beijing'}</span><strong className="prematch-report__time">{time(observed.at(-1))}</strong><p>{observed.length ? (zh ? '以实际收到资料的时间为准' : 'Actual data receipt time') : (zh ? '取得有效资料后显示' : 'Shown after data is received')}</p></div>
    </div>
    {evidence && !['ok', 'missing', 'unavailable'].includes(evidence.status) && <p className="prematch-report__notice" role="status">{label(evidence.status)}</p>}
    {evidence?.status === 'unavailable' && <p className="prematch-report__notice" role="status">{zh ? '本场资料暂不可用，可刷新重试；这不代表球队没有伤停。' : 'Match data is unavailable. Retry to check; this does not confirm an injury-free squad.'}</p>}
    <div className="prematch-report__section-head"><h4>{zh ? '伤停名单' : 'Injury list'}</h4><span>{sectionStatus(injuries)}{injuries?.data && <><br />{sectionTiming(injuries)}</>}</span></div>
    {injuries?.previousValue && <p className="prematch-report__notice">{zh ? '本次暂无更新，以下保留上次记录，请留意资料时间。' : 'No update this time; showing previous records with their original receipt time.'}</p>}
    <div className="prematch-report__teams">{(['home', 'away'] as const).map(side => {
      const rows = players.filter(p => p.side === side);
      return <section className="prematch-report__team" key={side} aria-label={`${sideName(side)} ${zh ? '伤停名单' : 'injury list'}`}>
        <header><div><span className={`prematch-report__side is-${side}`}>{side === 'home' ? (zh ? '主' : 'H') : (zh ? '客' : 'A')}</span><h5>{sideName(side)}</h5></div><span>{rows.length} {zh ? '条记录' : 'records'}</span></header>
        {rows.length ? <ul className="prematch-report__players">{rows.map((player, i) => <li key={`${player.name}-${i}`} data-testid="prematch-injury-row">
          <div><strong>{player.name}</strong>{player.position && <small>{position(player.position)}</small>}</div>
          <div><span className="prematch-report__reason">{player.reason ? (zh ? reasonLabels[player.reason] || player.reason : player.reason) : (zh ? '原因暂未提供' : 'Reason unavailable')}</span>
            {zh && player.reason && reasonLabels[player.reason] && <small lang="en">{player.reason}</small>}
            {player.expectedReturn && <small>{zh ? '预计回归：' : 'Expected return: '}{player.expectedReturn}</small>}</div>
        </li>)}</ul> : <div className="prematch-report__empty"><strong>{injuries?.data ? (zh ? '暂无该队伤停记录' : 'No injury records for this team') : sectionStatus(injuries)}</strong><p>{zh ? '没有可展示记录，不代表全员健康或无人停赛。' : 'No displayable records; this does not confirm a fully available squad.'}</p></div>}
      </section>;
    })}</div>
    <div className="prematch-report__section-head"><h4>{zh ? '首发与替补' : 'Starting XI & substitutes'}</h4><span>{sectionStatus(lineup)}{lineup?.data && <><br />{sectionTiming(lineup)}</>}</span></div>
    {lineup?.previousValue && <p className="prematch-report__notice">{zh ? '本次阵容暂无更新，以下保留上次名单，请留意资料时间。' : 'No lineup update this time; showing the previous list with its original receipt time.'}</p>}
    {teams.length ? <div className="prematch-report__teams">{teams.map(team => <section className="prematch-report__team" key={team.side}>
      <header><div><span className={`prematch-report__side is-${team.side}`}>{team.side === 'home' ? (zh ? '主' : 'H') : (zh ? '客' : 'A')}</span><h5>{sideName(team.side)}</h5></div><span>{team.formation || (zh ? '阵型未提供' : 'Formation unavailable')}</span></header>
      {team.coach && <p className="prematch-report__coach">{zh ? '教练：' : 'Coach: '}{team.coach}</p>}
      <ol className="prematch-report__lineup">{team.starters.map((p, i) => <li key={`${p.name}-${i}`}><span>{p.jersey || String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong><small>{position(p.position)}</small></li>)}</ol>
      <details className="prematch-report__bench"><summary>{zh ? '替补名单' : 'Substitutes'} · {team.substitutes.length}</summary><ul>{team.substitutes.map((p, i) => <li key={`${p.name}-${i}`}><strong>{p.name}</strong><small>{position(p.position)}</small></li>)}</ul>{!team.substitutes.length && <p>{zh ? '暂无替补名单' : 'No bench list available'}</p>}</details>
    </section>)}</div> : <div className="prematch-report__empty prematch-report__lineup-empty"><strong>{collectingStopped ? (zh ? '本场暂无已采集的赛前阵容' : 'No collected pre-match lineup') : sectionStatus(lineup)}</strong><p>{collectingStopped ? (zh ? '比赛已开赛，赛前采集停止；不补造首发名单。' : 'Kickoff has passed and pre-match collection has stopped.') : beforeLineupWindow ? (zh ? '首发通常在临近开赛时公布，资料取得后会自动更新。' : 'Lineups are usually announced near kickoff and will update when available.') : (zh ? '尚未取得可展示的首发名单，资料取得后会自动更新。' : 'No confirmed lineup is available yet. It will update when received.')}</p></div>}
    <footer className="prematch-report__footer"><p>{zh ? '补充资料仅供参考，不改写已冻结的推荐。' : 'Supplementary data is for reference and does not change frozen recommendations.'}</p></footer>
  </section>;
}
