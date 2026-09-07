import type { Match } from '../../services/mockData';
import { adoptionLabel, adoptionReason, getDataAdoptionReport, getCollectorDiagnostics } from '../../services/dataAdoption';

const displayTime = (value: string | null, language: 'zh' | 'en') => value
  ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  : (language === 'zh' ? '未记录' : 'Not recorded');

export function DataAdoptionDetails({ match, language }: { match: Match; language: 'zh' | 'en' }) {
  const { rows, calculationRows, asOf, bound, modelVersion, referenceHash } = getDataAdoptionReport(match);
  const collector = getCollectorDiagnostics(match);
  const collectorLabels = {
    'not-received': { zh: '未取得该项记录', en: 'No fragment received' },
    'clock-rejected': { zh: '时间证据未通过', en: 'Time evidence rejected' },
    'receipt-recorded': { zh: '接收时间已记录', en: 'Receipt time recorded' },
    'legacy-unverified': { zh: '旧记录 · 时间待核验', en: 'Legacy record · time unverified' },
  };
  const featureLabels = { injuries: { zh: '伤停', en: 'Injuries' }, lineups: { zh: '首发', en: 'Lineups' }, apiFootballOdds: { zh: '外源赔率', en: 'Provider odds' } };
  const missing = rows.filter((row) => row.state === 'missing').length;
  const unverified = rows.filter((row) => ['unknown', 'unverified', 'available-not-adopted'].includes(row.state)).length;
  const summaryCounts = [
    { key: 'conflicting', count: rows.filter(row => row.state === 'conflicting').length, zh: '来源冲突', en: 'source conflicts' },
    { key: 'after-decision', count: rows.filter(row => row.state === 'after-decision').length, zh: '晚于决策', en: 'after decision' },
    { key: 'stale', count: rows.filter(row => row.state === 'stale').length, zh: '陈旧数据', en: 'aged inputs' },
    { key: 'missing', count: missing, zh: '已知缺失', en: 'known missing' },
    { key: 'unverified', count: unverified, zh: '待核验', en: 'unverified usage' },
    { key: 'not-yet-published', count: rows.filter(row => row.state === 'not-yet-published').length, zh: '当时未公布', en: 'not published then' },
  ].filter(group => group.count > 0);
  return (
    <details className="data-adoption-details">
      <summary>
        <span>{language === 'zh' ? '数据采用与缺口' : 'Data adoption & gaps'}</span>
        <span className="data-adoption-details__counts">{summaryCounts.map(group => <span key={group.key} data-summary-state={group.key}>
          {language === 'zh' ? `${group.zh} ${group.count}` : `${group.count} ${group.en}`}
        </span>)}</span>
      </summary>
      <p>{language === 'zh'
        ? '数据接通不等于参与计算。以下不计算“采用率”，也不代表预测命中率。'
        : 'Connection does not prove model usage. No adoption rate or prediction accuracy is inferred.'}</p>
      <div className="data-adoption-details__identity">
        <span>{language === 'zh' ? '决策时间（北京）' : 'Decision time (Beijing)'}<strong>{displayTime(asOf, language)}</strong></span>
        <span>{language === 'zh' ? '模型版本' : 'Model version'}<strong>{modelVersion || (language === 'zh' ? '未绑定' : 'Unbound')}</strong></span>
        <span>{language === 'zh' ? '记录身份' : 'Record identity'}<strong title={referenceHash || undefined}>{referenceHash ? referenceHash.slice(0, 12) : (language === 'zh' ? '未绑定公开记录' : 'No public record binding')}</strong></span>
      </div>
      {!bound && <p className="data-adoption-details__warning">{language === 'zh' ? '缺少有效公开记录绑定；以下字段不能证明用户当时看到的推荐采用了这些数据。' : 'No valid public record binding; these fields do not prove usage in the published recommendation.'}</p>}
      {collector && <section className="collector-diagnostics" aria-label={language === 'zh' ? '补充源采集记录' : 'Supplemental collector record'}>
        <header><h3>{language === 'zh' ? '补充源采集记录' : 'Supplemental collector record'}</h3><span>API-Football</span></header>
        <p>{language === 'zh' ? '这是本次返回的采集记录，不是冻结决策证据；不回填原推荐，不计入上方缺口统计。' : 'Collector data in this response, not frozen decision evidence. It does not backfill a recommendation or change the counts above.'}</p>
        <div className="collector-diagnostics__meta">
          <span>{language === 'zh' ? '映射状态' : 'Mapping status'}<strong data-mapping-status={collector.mappingStatus}>{collector.mappingStatus === 'recorded'
            ? (language === 'zh' ? '采集器记录了映射' : 'Mapping recorded by collector')
            : collector.mappingStatus === 'conflicting' ? (language === 'zh' ? '身份冲突 · 不采用' : 'Identity conflict · do not use')
              : (language === 'zh' ? '映射未核验' : 'Mapping unverified')}</strong></span>
          <span>{language === 'zh' ? '检查记录（北京）' : 'Check recorded (Beijing)'}<strong>{displayTime(collector.checkedAt, language)}</strong></span>
          <span>{language === 'zh' ? '提供方赛事 ID' : 'Provider fixture ID'}<strong>{collector.fixtureId || '—'}</strong></span>
        </div>
        <ul>{collector.features.map(feature => <li key={feature.key} data-collector-state={feature.state}>
          <div><strong>{featureLabels[feature.key][language]}</strong><span>{collectorLabels[feature.state][language]}</span></div>
          <small>{language === 'zh' ? '接收时间' : 'Receipt time'} · {displayTime(feature.receivedAt, language)}</small>
          <small>{language === 'zh' ? '上游时间标记（未核验）' : 'Upstream clock (unverified)'} · {feature.sourceUpdatedAt ? displayTime(feature.sourceUpdatedAt, language) : (language === 'zh' ? '未提供' : 'Not supplied')}</small>
          <p>{feature.state === 'clock-rejected' ? (language === 'zh' ? '先核对时间与截止限制，不能仅凭缓存标记继续使用。' : 'Check source times and cutoff limits; a cached flag is insufficient.')
            : feature.state === 'not-received' ? (language === 'zh' ? '未取得不等于没有伤停、没有阵容或赔率为零。' : 'Missing data does not mean no injuries, no lineup or zero odds.')
              : (language === 'zh' ? '有采集记录不等于模型已采用，也不证明来源是独立、官方或最新。' : 'A record does not prove model usage or an independent, official, current source.')}</p>
        </li>)}</ul>
      </section>}
      {calculationRows.length > 0 && <section className="data-adoption-details__usage" aria-label={language === 'zh' ? '基础计算使用记录' : 'Base calculation usage'}>
        <h3>{language === 'zh' ? '基础计算使用记录' : 'Base calculation usage'}</h3>
        <p>{language === 'zh' ? '以下系数来自实际计算回执，各阶段不能相加。不代表来源已验证，也不代表最终推荐贡献率。' : 'Coefficients come from execution receipts. Different stages cannot be added; these are not source verification or final recommendation contributions.'}</p>
        <ul>{calculationRows.map(row => <li key={`${row.stage}:${row.key}`}>
          <strong>{row.key === 'form' ? (language === 'zh' ? '近期状态混合层' : 'Form blend') : row.key === 'elo' ? 'Elo' : row.key === 'syntheticAnchor' ? (language === 'zh' ? '合成基础输入（非赔率）' : 'Synthetic base input, not odds') : (language === 'zh' ? `赔率锚 ${row.poolCode || '未确认'}` : `Market anchor ${row.poolCode || 'unknown'}`)}</strong>
          <span>{row.used ? (language === 'zh' ? '已参与基础计算' : 'Used in base calculation') : (language === 'zh' ? '本阶段未使用' : 'Not used in this stage')} · {language === 'zh' ? '系数 ' : 'coefficient '}{row.weight.toFixed(3)}</span>
          {row.fallbackMetrics !== null && row.fallbackMetrics > 0 && <small>{language === 'zh' ? `含 ${row.fallbackMetrics} 项缺失指标回退，不能算完整观测` : `${row.fallbackMetrics} missing-metric fallbacks; not complete observations`}</small>}
          <small title={row.receiptHash}>{language === 'zh' ? '回执 ' : 'Receipt '}{row.receiptHash.slice(0, 12)}</small>
          {row.source && <small>{language === 'zh' ? '输入标记 ' : 'Input label '}{row.source}</small>}
        </li>)}</ul>
      </section>}
      <dl>{rows.map((row) => (
        <div key={row.key} data-state={row.state}>
          <dt>{row[language]}<span>{adoptionLabel[row.state][language]}</span></dt>
          <dd>
            <p>{adoptionReason[row.reason]?.[language]}</p>
            {row.sampleSize !== null && <small>{language === 'zh' ? `实际样本 ${row.sampleSize} 场` : `${row.sampleSize} recorded samples`}</small>}
            {row.observedAt && <small>{row.key.endsWith('Form') ? (language === 'zh' ? '最近比赛' : 'Last match') : (language === 'zh' ? '源观测' : 'Source observed')} · {displayTime(row.observedAt, language)}</small>}
            {row.resultObservation && <>
              <small>{language === 'zh' ? `样本主场 ${row.resultObservation.homeRows} / 客场 ${row.resultObservation.awayRows}` : `Sample venues: home ${row.resultObservation.homeRows} / away ${row.resultObservation.awayRows}`}</small>
              <small>{language === 'zh' ? `有观测时钟 ${row.resultObservation.observedRows} / ${row.resultObservation.sampleRows} · 缺时钟 ${row.resultObservation.missingObservedAtRows} · 缺来源 ${row.resultObservation.missingSourceRows}` : `Observation clocks ${row.resultObservation.observedRows}/${row.resultObservation.sampleRows} · missing clocks ${row.resultObservation.missingObservedAtRows} · missing sources ${row.resultObservation.missingSourceRows}`}</small>
              <small>{language === 'zh' ? '最近赛果观测' : 'Latest result observation'} · {displayTime(row.resultObservation.latestObservedAt, language)}</small>
              {row.resultObservation.contentObservation && <>
                <small>{language === 'zh' ? `另有本地文件接收凭据 ${row.resultObservation.contentObservation.receivedRows} / ${row.resultObservation.sampleRows} · 缺凭据 ${row.resultObservation.contentObservation.missingReceiptRows}` : `Separate local file receipts ${row.resultObservation.contentObservation.receivedRows}/${row.resultObservation.sampleRows} · missing ${row.resultObservation.contentObservation.missingReceiptRows}`}</small>
                <small>{language === 'zh' ? '最近文件首次接收' : 'Latest file first receipt'} · {displayTime(row.resultObservation.contentObservation.latestFirstObservedAt, language)}</small>
                <small>{language === 'zh' ? '文件接收不等于赛果当时可用，也不是独立来源证明。' : 'File receipt is not historical result availability or independent source proof.'}</small>
              </>}
              <small>{language === 'zh' ? '仅记录元数据，不等于来源已核验或首次收到时间已证明。' : 'Metadata only; neither source verification nor first-receipt proof.'}</small>
            </>}
            {row.source && <small>{language === 'zh' ? '来源' : 'Source'} · {row.source}</small>}
          </dd>
        </div>
      ))}</dl>
      <p>{language === 'zh'
        ? '处理顺序：核对赛事/球队映射 → 核对采集时间 → 补充采用回执。同一历史源的近期状态与实力评分，不算两个独立来源。'
        : 'Next: validate event/team mapping, observation times and usage receipts. Form and strength from one history source are not independent sources.'}</p>
    </details>
  );
}
