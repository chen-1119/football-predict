import './supplementary-football-facts.css';
export interface SupplementaryData {
  status?: string;
  predictionEligible?: false;
  generatedAt?: string;
  fields?: Record<string, { status?: string; provider?: string | null; attribution?: string | null;
    observedAt?: string | null; expiresAt?: string | null; data?: unknown }>;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const numeric = (v: unknown, digits = 0) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
const text = (v: unknown) => typeof v === 'string' ? v : '—';
const labels: Record<string, [string,string]> = {
  stale:['资料已过期，等待更新','Expired; waiting for update'],
  'venue-unverified':['尚未核实本场球场坐标','Match venue coordinates unverified'],
  'unsupported-league':['当前免费来源未覆盖此联赛','League outside current free-source coverage'],
  'awaiting-source-or-mapping':['等待数据或比赛身份匹配','Awaiting data or fixture mapping'],
  'credentials-missing':['需配置免费接口密钥','Free API token not configured'],
};
export function SupplementaryFootballFacts({data,language}:{data?:SupplementaryData|null;language:'zh'|'en'}) {
  if(!data)return null;
  const zh=language==='zh', keys=['fixture','form','standings','weather'];
  const headings=zh?['赛程核验','近期战绩','联赛排名','比赛天气']:['Fixture cross-check','Recent form','Standings','Match weather'];
  return <section className="supplementary-facts" aria-label={zh?'多来源基础资料':'Supplementary football facts'}>
    <header><h4>{zh?'基础战绩与比赛环境':'Form & match conditions'}</h4><p>{zh?'独立于雷速采集；无资料不按0处理。补充信息不改写已冻结推荐。':'Independent of Leisu. Missing values are not zero. Frozen picks remain unchanged.'}</p></header>
    <div className="supplementary-facts__grid">{keys.map((key,i)=>{
      const field=data.fields?.[key], d=object(field?.data), expiry=Date.parse(field?.expiresAt||'');
      const present=field?.status==='available'&&field.data!=null&&Number.isFinite(expiry)&&expiry>Date.now();
      const status=field?.data&&!present?'stale':field?.status||'awaiting-source-or-mapping';
      return <article key={key}><h5>{headings[i]}</h5>{!present?<p>{(labels[status]||labels['awaiting-source-or-mapping'])[zh?0:1]}</p>:<>
        {key==='fixture'&&<p><strong>{text(d.home)} vs {text(d.away)}</strong><br/>{text(d.status)}{zh?' · 仅供核验，不作竞彩结算':' · Reference, not official settlement'}</p>}
        {key==='form'&&(['home','away'] as const).map(side=>{const v=object(d[side]);return <p key={side}><strong>{side==='home'?(zh?'主队':'Home'):(zh?'客队':'Away')}</strong> · {zh?'样本':'Sample'} {numeric(v.sampleSize)}<br/>{zh?'场均进球 / 失球':'Goals for / against per match'} {numeric(v.goalsForAvg,2)} / {numeric(v.goalsAgainstAvg,2)}</p>;})}
        {key==='standings'&&(['home','away'] as const).map(side=>{const v=object(d[side]);return <p key={side}>{side==='home'?(zh?'主队':'Home'):(zh?'客队':'Away')} · {zh?'排名':'Rank'} {numeric(v.position)} · {zh?'积分':'Points'} {numeric(v.points)} · {zh?'已赛':'Played'} {numeric(v.played)}</p>;})}
        {key==='weather'&&<p>{numeric(d.temperatureC,1)} °C · {zh?'风速':'Wind'} {numeric(d.windKph,1)} km/h<br/>{zh?'小时降水':'Hourly precipitation'} {numeric(d.precipitationMm,1)} mm<br/>{zh?'预报对应时刻':'Forecast valid at'} {text(d.forecastAt)}</p>}
        <small>{field?.attribution||field?.provider||'—'} · {zh?'采集':'Received'} {field?.observedAt?new Date(field.observedAt).toLocaleString(zh?'zh-CN':'en-GB',{timeZone:'Asia/Shanghai',hour12:false}):'—'}</small>
      </>}</article>;
    })}</div>
  </section>;
}
