import { useEffect, useState } from 'react';
import { getAccessAuthHeaders } from '../../services/accessControl';
import { buildApiUrl } from '../../services/runtimeUrls';
import '../../styles/prematch-collection.css';

type Player = { name: string; side?: 'home' | 'away'; reason?: string; position?: string; expectedReturn?: string; jersey?: string };
type Provider = 'leisu' | 'api-football';
type SourcePage = { url: string; scope: 'match' | 'provider'; reason?: string };
type Section = { status: string; observedAt: string | null; lastAttemptAt: string | null; previousValue: boolean;
  provider?: Provider | null; statusProvider?: Provider | null; fallback?: boolean; missingReason?: string | null; sourcePage?: SourcePage;
  data: { players?: Player[]; teams?: Array<{ side: 'home' | 'away'; formation: string; coach?: string; starters: Player[]; substitutes: Player[] }> } | null };
type Collection = { provider?: Provider; enabled: boolean; state: string; statusFresh: boolean; lastRunAt: string | null;
    lastSuccessAt: string | null; nextAttemptAt: string | null; sourceState: string | null;
    sourceHttpStatus: number | null; fixtureState: string | null; eligibleMatches: number | null };
type Source = { provider: Provider; status: string; mappingState: string; sourcePage?: SourcePage; sections: Record<'injuries' | 'lineup', Omit<Section, 'data'>>; collection?: Collection };
type Evidence = { matchId: string; status: string; provider?: Provider | 'mixed' | null; predictionEligible: false; sections?: { injuries: Section; lineup: Section };
  sources?: Partial<Record<Provider, Source>>; collection?: Collection };
type RefreshRequest = { matchId: string; state: 'queued' | 'cooldown' | 'error'; nextAllowedAt?: string; error?: string };
const labels: Record<string, [string, string]> = {
  ok: ['资料校验通过', 'Evidence verified'],
  available: ['已有资料', 'Available'], source_empty: ['来源暂未提供', 'No source records'], missing: ['资料待补充', 'Awaiting data'],
  unavailable: ['资料暂不可用', 'Unavailable'], stale: ['资料已过期', 'Expired'], disabled: ['采集尚未启用', 'Collection disabled'],
  ineligible: ['不在赛前采集范围', 'Outside collection window'], partial: ['部分资料待补充', 'Partial coverage'],
  blocked: ['自动采集暂不可用', 'Automatic collection unavailable'], login_required: ['采集会话需更新', 'Session expired'],
  conflict: ['比赛身份待核对', 'Match identity unverified'], parse_error: ['来源数据解析失败', 'Source parsing failed'],
  loading: ['正在读取资料', 'Loading data'], unauthorized: ['请先验证访问权限', 'Access verification required'],
  'fixture-stale': ['比赛输入已过期', 'Fixture input expired'], 'fixture-unavailable': ['比赛输入暂不可用', 'Fixture unavailable'],
  'collection-paused': ['采集等待恢复', 'Collection paused'], 'browser-unavailable': ['采集环境不可用', 'Collector unavailable'],
  'source-unavailable': ['数据来源暂不可用', 'Source unavailable'], 'runtime-error': ['本轮采集异常', 'Collection error'],
  running: ['正在采集', 'Collecting'], completed: ['本轮检查完成', 'Check completed'],
  'no-due-tasks': ['本轮检查完成，等待更新窗口', 'Checked; awaiting refresh window'], 'budget-exhausted': ['剩余资料下轮补充', 'Remaining data deferred'],
  unmapped: ['比赛尚未匹配', 'Fixture not mapped'], 'not-due': ['未到采集窗口', 'Outside collection window'],
};
const reasonLabels: Record<string, string> = {
  'Achilles Tendon Injury': '跟腱伤情', 'Groin Injury': '腹股沟伤情', 'Knee Injury': '膝部伤情', 'Ankle Injury': '踝部伤情',
  'Muscle Injury': '肌肉伤情', 'Hamstring Injury': '腿后肌伤情', 'Thigh Injury': '大腿伤情', 'Calf Injury': '小腿伤情',
  'Foot Injury': '足部伤情', 'Back Injury': '背部伤情', 'Shoulder Injury': '肩部伤情', Illness: '身体不适',
  Injury: '伤情未详述', Inactive: '未激活（来源标记）', Suspended: '停赛', 'Red Card': '红牌停赛',
  'Yellow Cards': '累计黄牌停赛', Rest: '休整', 'Missing Fixture': '缺席（来源标记）',
};
const positions: Record<string, string> = { G: '门将', D: '后卫', M: '中场', F: '前锋', Goalkeeper: '门将', Defender: '后卫', Midfielder: '中场', Attacker: '前锋' };

// Public webpages only. Do not turn collection endpoints or arbitrary response URLs into links.
function publicSourcePage(provider: Provider, page?: SourcePage): SourcePage {
  if (provider === 'leisu' && page?.scope === 'match' && /^https:\/\/live\.leisu\.com\/(?:shujufenxi|detail)-[1-9]\d*$/.test(page.url)) return page;
  return provider === 'leisu'
    ? { url: 'https://www.leisu.com/', scope: 'provider', reason: 'no-verified-match-page' }
    : { url: 'https://www.api-football.com/', scope: 'provider', reason: 'provider-only' };
}

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
  const sourceName = (provider?: Provider | null) => provider === 'api-football' ? 'API-Football' : provider === 'leisu' ? (zh ? '雷速' : 'Leisu') : (zh ? '暂无有效来源' : 'No verified source');
  const sourceRows: Source[] = (['leisu', 'api-football'] as const).map(provider => evidence?.sources?.[provider] || {
    provider, status: evidence?.status || 'loading', mappingState: 'unknown', sections: {
      injuries: { status: evidence?.status || 'loading', observedAt: null, lastAttemptAt: null, previousValue: false },
      lineup: { status: evidence?.status || 'loading', observedAt: null, lastAttemptAt: null, previousValue: false },
    },
  });
  const mappingLabel = (state: string) => state === 'verified' ? (zh ? '比赛已匹配' : 'Fixture verified') : state === 'unmapped'
    ? label('unmapped') : state === 'conflict' ? label('conflict') : (zh ? '比赛匹配待确认' : 'Fixture mapping unknown');
  const time = (value?: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(Date.parse(value)) : '—';
  const sideName = (side: 'home' | 'away') => (side === 'home' ? homeName : awayName) || (side === 'home' ? (zh ? '主队' : 'Home') : (zh ? '客队' : 'Away'));
  const injuries = evidence?.sections?.injuries, lineup = evidence?.sections?.lineup;
  const players = injuries?.data?.players || [], teams = lineup?.data?.teams || [];
  const observed = [injuries?.observedAt, lineup?.observedAt].filter((at): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at))).sort();
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
  const emptyReason = (section?: Section) => section?.missingReason || section?.status || (evidence ? 'missing' : 'loading');
  const sectionSource = (section?: Section) => `${!section?.data ? (zh ? '状态来源：' : 'Status source: ') : ''}${sourceName(section?.provider || section?.statusProvider || (evidence?.provider === 'api-football' ? 'api-football' : null))}${section?.fallback ? (zh ? ' · 补充来源' : ' · Fallback') : ''}`;
  const sectionTiming = (section?: Section) => section?.data
    ? `${zh ? '资料时间：' : 'Received: '}${time(section.observedAt)}`
    : `${zh ? '最近尝试：' : 'Last attempt: '}${time(section?.lastAttemptAt)}`;
  const nextCheck = (collection?: Collection) => {
    if (collectingStopped) return zh ? '已开赛，停止赛前采集' : 'Kickoff passed; collection stopped';
    const next = collection?.nextAttemptAt ? Date.parse(collection.nextAttemptAt) : NaN;
    if (Number.isFinite(next) && next > Date.now() && collection?.statusFresh) return time(collection.nextAttemptAt);
    return !collection?.statusFresh || ['blocked', 'login_required', 'parse_error'].includes(collection?.sourceState || '')
      ? (zh ? '等待来源恢复' : 'Waiting for source recovery') : (zh ? '等待下轮检查' : 'Awaiting the next check');
  };
  const sourceLinks = (source: Source) => {
    const main = publicSourcePage(source.provider, source.sourcePage);
    const pages = main.scope === 'match'
      ? [main, ...Object.values(source.sections).map(section => publicSourcePage(source.provider, section.sourcePage))]
        .filter((page, index, all) => page.scope === 'match' && all.findIndex(item => item.url === page.url) === index)
      : [main];
    return <div className="prematch-report__source-pages">
      <strong>{zh ? '数据来源网页' : 'Source webpages'}</strong>
      {pages.map(page => <a key={page.url} href={page.url} target="_blank" rel="noopener noreferrer" className="prematch-report__source-link">
        <span>{page.scope === 'match'
          ? page.url.includes('/detail-') ? (zh ? '本场阵容原页面' : 'Match lineup page') : (zh ? '本场分析原页面' : 'Match analysis page')
          : source.provider === 'leisu' ? (zh ? '雷速体育官网' : 'Leisu website') : (zh ? 'API-Football 数据提供方官网' : 'API-Football provider website')} ↗</span>
        <small>{page.url}</small>
      </a>)}
      {main.scope === 'provider' && <p>{source.provider === 'leisu'
        ? (zh ? '尚未核对本场对应页面，先提供来源官网。' : 'The exact match page is not verified; this opens the provider website.')
        : (zh ? '此链接为数据提供方官网，不是本场比赛详情页。' : 'This opens the provider website, not a match detail page.')}</p>}
    </div>;
  };
  return <section className="card prematch-report" data-testid="prematch-collection" aria-labelledby={`prematch-heading-${matchId}`} aria-busy={fetching}>
    <header className="prematch-report__head">
      <div><span className="prematch-report__eyebrow">{zh ? '最新补充资料' : 'LATEST MATCH DATA'}</span><h3 id={`prematch-heading-${matchId}`}>{zh ? '伤停与比赛阵容' : 'Injuries & lineups'}</h3>
        <p>{zh ? '查看本场实际采集的球员明细。新增资料仅供参考，推荐是否采用以决策记录为准。' : 'Collected player details for this match. Reference data; adoption is determined by the recorded decision.'}</p></div>
      <div className="prematch-report__actions"><button type="button" className="prematch-report__refresh" disabled={fetching} onClick={() => setRefreshTick(value => value + 1)}>{fetching ? (zh ? '读取中…' : 'Loading…') : (zh ? '刷新资料' : 'Refresh data')}</button>
        <button type="button" className="prematch-report__refresh" disabled={requesting || requestCooling || !canRequest} onClick={requestRefresh}>{requesting ? (zh ? '提交中…' : 'Queuing…') : requestCooling ? (zh ? '补采请求已提交' : 'Refresh requested') : (zh ? '优先补采本场' : 'Prioritize this match')}</button></div>
    </header>
    {activeRequest && <p className="prematch-report__notice" role="status">{activeRequest.state === 'error'
      ? activeRequest.error === 'request-denied' ? (zh ? '补采请求未通过验证，请重新打开本站后重试。' : 'Request verification failed. Reopen this site and retry.') : label(activeRequest.error || 'unavailable')
      : (zh ? '已加入补采队列，5分钟内检查，受来源与额度限制。自动定时采集仍会继续。' : 'Queued for a check within 5 minutes, subject to source availability and quota. Automatic collection continues.')}
      {requestCooling && ` ${zh ? '可再次请求：' : 'Request again after: '}${time(activeRequest.nextAllowedAt)}`}</p>}
    <div className="prematch-report__metrics" aria-live="polite">
      <div><span>{zh ? '伤停记录' : 'Injury records'}</span><strong>{evidence ? players.length : '—'}<small>{zh ? ' 条' : ' records'}</small></strong><p>{players.length ? (zh ? `主队 ${players.filter(p => p.side === 'home').length} · 客队 ${players.filter(p => p.side === 'away').length}` : `Home ${players.filter(p => p.side === 'home').length} · Away ${players.filter(p => p.side === 'away').length}`) : (evidence ? (zh ? '暂无可展示记录' : 'No records available') : label('loading'))}</p></div>
      <div><span>{zh ? '确认首发' : 'Confirmed lineup'}</span><strong>{evidence ? teams.length : '—'}<small> / 2 {zh ? '队' : 'teams'}</small></strong><p>{teams.length ? (zh ? '首发与替补名单可查' : 'Starters and bench available') : beforeLineupWindow ? (zh ? '尚未到阵容采集窗口' : 'Awaiting lineup window') : (zh ? '等待来源提供名单' : 'Awaiting source lineup')}</p></div>
      <div><span>{zh ? '资料采集时间 · 北京' : 'Data received · Beijing'}</span><strong className="prematch-report__time">{time(observed.at(-1))}</strong><p>{observed.length ? (zh ? '以实际收到资料的时间为准' : 'Actual data receipt time') : (zh ? '取得有效资料后显示' : 'Shown after data is received')}</p></div>
    </div>
    {evidence && !['ok', 'missing', 'unavailable'].includes(evidence.status) && <p className="prematch-report__notice" role="status">{label(evidence.status)}</p>}
    {evidence?.status === 'unavailable' && <p className="prematch-report__notice" role="status">{zh ? '本场资料暂不可用，可刷新重试；这不代表球队没有伤停。' : 'Match data is unavailable. Retry to check; this does not confirm an injury-free squad.'}</p>}
    {sourceRows.length > 0 && <div className="prematch-report__sources" aria-label={zh ? '双源采集状态' : 'Collection source status'}>{sourceRows.map(source => <article key={source.provider} data-testid={`prematch-source-${source.provider}`}>
      <header><strong>{sourceName(source.provider)}</strong><span>{mappingLabel(source.mappingState)}</span></header>
      <p>{source.collection?.sourceState === 'available' ? (zh ? '来源可访问' : 'Source reachable') : label(source.collection?.sourceState || source.status)}{source.collection?.sourceState && source.status !== 'ok' && ` · ${label(source.status)}`}</p>
      {sourceLinks(source)}
      <dl><div><dt>{zh ? '伤停' : 'Injuries'}</dt><dd>{label(source.sections.injuries.status)}{source.sections.injuries.previousValue && (zh ? ' · 保留上次记录' : ' · Previous record')}</dd></div>
        <div><dt>{zh ? '阵容' : 'Lineup'}</dt><dd>{label(source.sections.lineup.status)}{source.sections.lineup.previousValue && (zh ? ' · 保留上次名单' : ' · Previous list')}</dd></div>
        <div><dt>{zh ? '最近尝试 · 伤停 / 阵容' : 'Last attempt · injuries / lineup'}</dt><dd>{time(source.sections.injuries.lastAttemptAt)} / {time(source.sections.lineup.lastAttemptAt)}</dd></div>
        <div><dt>{zh ? '最近检查' : 'Last check'}</dt><dd>{time(source.collection?.lastRunAt)}</dd></div>
        <div><dt>{zh ? '下次检查' : 'Next check'}</dt><dd>{nextCheck(source.collection)}</dd></div></dl>
      {source.collection && <p>{label(source.collection.state)}{!source.collection.statusFresh && (zh ? ' · 状态更新延迟' : ' · Status update delayed')}{source.collection.fixtureState === 'stale' && ` · ${label('fixture-stale')}`}</p>}
    </article>)}</div>}
    <div className="prematch-report__section-head"><h4>{zh ? '伤停名单' : 'Injury list'}</h4><span>{sectionSource(injuries)}<br />{label(injuries?.status || (evidence ? 'missing' : 'loading'))}<br />{sectionTiming(injuries)}</span></div>
    {injuries?.previousValue && <p className="prematch-report__notice">{zh ? '最近尝试未成功，以下为上次成功采集的记录。' : 'Latest attempt failed; these are the previous successful records.'}</p>}
    <div className="prematch-report__teams">{(['home', 'away'] as const).map(side => {
      const rows = players.filter(p => p.side === side);
      return <section className="prematch-report__team" key={side} aria-label={`${sideName(side)} ${zh ? '伤停名单' : 'injury list'}`}>
        <header><div><span className={`prematch-report__side is-${side}`}>{side === 'home' ? (zh ? '主' : 'H') : (zh ? '客' : 'A')}</span><h5>{sideName(side)}</h5></div><span>{rows.length} {zh ? '条记录' : 'records'}</span></header>
        {rows.length ? <ul className="prematch-report__players">{rows.map((player, i) => <li key={`${player.name}-${i}`} data-testid="prematch-injury-row">
          <div><strong>{player.name}</strong>{player.position && <small>{position(player.position)}</small>}</div>
          <div><span className="prematch-report__reason">{player.reason ? (zh ? reasonLabels[player.reason] || player.reason : player.reason) : (zh ? '原因暂未提供' : 'Reason unavailable')}</span>
            {zh && player.reason && reasonLabels[player.reason] && <small lang="en">{player.reason}</small>}
            {player.expectedReturn && <small>{zh ? '预计回归：' : 'Expected return: '}{player.expectedReturn}</small>}</div>
        </li>)}</ul> : <div className="prematch-report__empty"><strong>{injuries?.data ? (zh ? '本来源未列出该队伤停记录' : 'This source lists no injury records for this team') : label(emptyReason(injuries))}</strong><p>{zh ? '没有可展示记录，不代表全员健康或无人停赛。' : 'No displayable records; this does not confirm a fully available squad.'}</p></div>}
      </section>;
    })}</div>
    <div className="prematch-report__section-head"><h4>{zh ? '首发与替补' : 'Starting XI & substitutes'}</h4><span>{sectionSource(lineup)}<br />{label(lineup?.status || (evidence ? 'missing' : 'loading'))}<br />{sectionTiming(lineup)}</span></div>
    {lineup?.previousValue && <p className="prematch-report__notice">{zh ? '最近阵容更新未成功，以下为上次成功采集的名单。' : 'Latest lineup update failed; showing the previous successful list.'}</p>}
    {teams.length ? <div className="prematch-report__teams">{teams.map(team => <section className="prematch-report__team" key={team.side}>
      <header><div><span className={`prematch-report__side is-${team.side}`}>{team.side === 'home' ? (zh ? '主' : 'H') : (zh ? '客' : 'A')}</span><h5>{sideName(team.side)}</h5></div><span>{team.formation || (zh ? '阵型未提供' : 'Formation unavailable')}</span></header>
      {team.coach && <p className="prematch-report__coach">{zh ? '教练：' : 'Coach: '}{team.coach}</p>}
      <ol className="prematch-report__lineup">{team.starters.map((p, i) => <li key={`${p.name}-${i}`}><span>{p.jersey || String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong><small>{position(p.position)}</small></li>)}</ol>
      <details className="prematch-report__bench"><summary>{zh ? '替补名单' : 'Substitutes'} · {team.substitutes.length}</summary><ul>{team.substitutes.map((p, i) => <li key={`${p.name}-${i}`}><strong>{p.name}</strong><small>{position(p.position)}</small></li>)}</ul>{!team.substitutes.length && <p>{zh ? '来源暂未提供替补名单' : 'Source has not supplied a bench list'}</p>}</details>
    </section>)}</div> : <div className="prematch-report__empty prematch-report__lineup-empty"><strong>{collectingStopped ? (zh ? '本场暂无已采集的赛前阵容' : 'No collected pre-match lineup') : label(emptyReason(lineup))}</strong><p>{collectingStopped ? (zh ? '比赛已开赛，赛前采集停止；不补造首发名单。' : 'Kickoff has passed and pre-match collection has stopped.') : beforeLineupWindow ? (zh ? `API-Football 阵容窗口从 ${time(lineupWindow)} 开始；各来源可能尚未公布名单。` : `The API-Football lineup window opens at ${time(lineupWindow)}; sources may not have published a list yet.`) : (zh ? '按各来源采集计划自动更新；来源空、未匹配和访问失败会分别显示，不补造首发名单。' : 'Updated on each source schedule. Empty, unmapped and failed sources are shown separately; no lineup is invented.')}</p></div>}
    <footer className="prematch-report__footer"><span>{zh ? '按资料分源补充' : 'Per-section sources'}</span><p>{zh ? '伤停和阵容分别核验，优先展示雷速有效资料，缺失时采用 API-Football 有效记录。检查时间不等于资料更新时间，补充资料不改写已冻结推荐。' : 'Injuries and lineups are verified separately. Valid Leisu data is preferred, with valid API-Football data filling gaps. Check times are separate from receipt times; frozen picks are unchanged.'}</p></footer>
    {!sourceRows.length && evidence?.collection && <p className="prematch-report__schedule" data-testid="prematch-scheduler-status">{label(evidence.collection.state)} · {zh ? '最近检查' : 'Last check'} {time(evidence.collection.lastRunAt)} · {zh ? '下次检查' : 'Next check'} {nextCheck(evidence.collection)}</p>}
  </section>;
}
