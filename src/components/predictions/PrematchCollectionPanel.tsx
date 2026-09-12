import { useEffect, useState } from 'react';
import { getAccessAuthHeaders } from '../../services/accessControl';
import { buildApiUrl } from '../../services/runtimeUrls';

type Player = { name: string; side: 'home' | 'away'; reason?: string; position?: string; expectedReturn?: string };
type Section = { status: string; observedAt: string | null; lastAttemptAt: string | null; previousValue: boolean;
  data: { players?: Player[]; teams?: Array<{ side: 'home' | 'away'; formation: string; starters: Player[]; substitutes: Player[] }> } | null };
type Evidence = { matchId: string; status: string; predictionEligible: false; sections?: { injuries: Section; lineup: Section };
  collection?: { enabled: boolean; state: string; statusFresh: boolean; lastRunAt: string | null;
    lastSuccessAt: string | null; nextAttemptAt: string | null; sourceState: string | null;
    sourceHttpStatus: number | null; fixtureState: string | null; eligibleMatches: number | null } };
const labels: Record<string, [string, string]> = {
  available: ['已采集', 'Collected'], source_empty: ['暂未公布', 'Not announced'],
  missing: ['尚未采集', 'Not collected'], unavailable: ['采集结果暂不可用', 'Collection unavailable'],
  stale: ['采集结果已过期', 'Collection expired'], disabled: ['采集尚未启用', 'Collection not enabled'],
  ineligible: ['不在今天、明天的赛前采集范围', 'Outside the today/tomorrow pre-match window'],
  blocked: ['采集通道访问受限', 'Collection access restricted'], login_required: ['采集会话需更新', 'Collection session expired'],
  conflict: ['比赛身份待核对', 'Match identity needs checking'], parse_error: ['数据解析失败', 'Data parsing failed'],
  loading: ['读取中', 'Loading'], unauthorized: ['请先验证访问权限', 'Access verification required'],
  'fixture-stale': ['比赛输入快照已过期', 'Fixture snapshot expired'], 'fixture-unavailable': ['比赛输入暂不可用', 'Fixture input unavailable'],
  'collection-paused': ['采集等待恢复', 'Collection awaiting recovery'], 'browser-unavailable': ['浏览器环境不可用', 'Browser unavailable'],
  'source-unavailable': ['采集通道暂不可用', 'Collection source unavailable'], 'runtime-error': ['采集运行异常', 'Collection error'],
  running: ['采集中', 'Collecting'], completed: ['本轮完成', 'Run completed'], 'no-due-tasks': ['本轮没有到期任务', 'No tasks due'],
  'budget-exhausted': ['剩余任务下轮继续', 'Remaining tasks deferred'],
};

export function PrematchCollectionPanel({ matchId, language }: { matchId: string; language: 'zh' | 'en' }) {
  const [result, setResult] = useState<Evidence | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setRefreshTick(value => value + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  const evidence = result?.matchId === matchId ? result : null;
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 10000);
    fetch(buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}/prematch-evidence`), {
      headers: getAccessAuthHeaders(), cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : 'unavailable');
      const value = await response.json() as Evidence;
      if (value.matchId !== matchId || value.predictionEligible !== false) throw new Error('unavailable');
      if (!controller.signal.aborted) setResult(value);
    }).catch(error => {
      if (!disposed) setResult({ matchId, status: error.message === 'unauthorized' ? 'unauthorized' : 'unavailable', predictionEligible: false });
    }).finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [matchId, refreshTick]);
  const label = (status: string) => (labels[status] || labels.unavailable)[language === 'zh' ? 0 : 1];
  const time = (value: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(Date.parse(value)) : '--';
  return <section className="card captured-match-data" data-testid="prematch-collection" aria-live="polite">
    <h3>{language === 'zh' ? '赛前采集资料' : 'Pre-match collection'}</h3>
    <p>{language === 'zh' ? '北京时间今天、明天的未开赛比赛。资料仅供参考，不计入正式推荐。' : 'Today/tomorrow in Beijing time, before kickoff. Reference information only.'}</p>
    {evidence?.collection && <div data-testid="prematch-scheduler-status">
      <p><strong>{language === 'zh' ? (evidence.collection.enabled ? '定时采集已启用' : '定时采集未启用') : (evidence.collection.enabled ? 'Scheduled collection enabled' : 'Scheduled collection disabled')}</strong> · {label(evidence.collection.state)}</p>
      {!evidence.collection.statusFresh && <p>{language === 'zh' ? '运行状态更新已延迟' : 'Scheduler status update delayed'}</p>}
      <p>{language === 'zh' ? '每 5 分钟检查；伤停每 6 小时更新；阵容在赛前 90、60、30 分钟检查，未公布时在 20、10 分钟补查。' : 'Checks every 5 minutes; injuries every 6 hours; lineups at 90/60/30 minutes, with 20/10 minute follow-ups.'}</p>
      <p>{language === 'zh' ? '最近执行：' : 'Last run: '}{time(evidence.collection.lastRunAt)} · {language === 'zh' ? '下次取数：' : 'Next attempt: '}{time(evidence.collection.nextAttemptAt)}</p>
      {evidence.collection.sourceState === 'blocked' && <p>{language === 'zh' ? '数据通道访问受限，保留已有数据并按间隔重试。' : 'Source access restricted; retaining existing data and retrying at the scheduled interval.'}</p>}
      {evidence.collection.fixtureState === 'stale' && <p>{language === 'zh' ? '网站比赛输入快照已过期，等待更新后继续对应比赛。' : 'Website fixture snapshot expired; waiting for an updated match list.'}</p>}
    </div>}
    {evidence?.status !== 'ok' && <p>{label(evidence?.status || 'loading')}</p>}
    {(['injuries', 'lineup'] as const).map(kind => {
      const section = evidence?.sections?.[kind];
      return <div className="captured-match-data__section" key={kind}>
        <h4>{kind === 'injuries' ? (language === 'zh' ? '伤停' : 'Injuries') : (language === 'zh' ? '阵容' : 'Lineup')} · {label(section?.status || 'missing')}</h4>
        <p>{language === 'zh' ? '采集时间（北京时间）：' : 'Collected (Beijing): '}{time(section?.observedAt || null)}</p>
        {section?.previousValue && <p>{language === 'zh' ? '最近采集未成功，以下保留上次成功记录。' : 'Latest attempt failed; showing the last successful record.'}</p>}
        {section?.data?.players?.map((player, i) => <p key={i}>{player.side === 'home' ? (language === 'zh' ? '主队' : 'Home') : (language === 'zh' ? '客队' : 'Away')} · {player.name} · {player.reason || '--'} · {player.expectedReturn || '--'}</p>)}
        {section?.data?.teams?.map(team => <div key={team.side}><strong>{team.side === 'home' ? (language === 'zh' ? '主队' : 'Home') : (language === 'zh' ? '客队' : 'Away')} · {team.formation || '--'}</strong><p>{team.starters.map(player => player.name).join('、')}</p></div>)}
      </div>;
    })}
  </section>;
}
