import type { Match } from '../../services/mockData';
import { adoptionLabel, getDataAdoptionFacts } from '../../services/dataAdoption';

export function DataAdoptionDetails({ match, language }: { match: Match; language: 'zh' | 'en' }) {
  const rows = getDataAdoptionFacts(match);
  const used = rows.filter((row) => row.state === 'adopted').length;
  return (
    <details className="data-adoption-details">
      <summary>
        <span>{language === 'zh' ? '数据采用与缺口' : 'Data adoption & gaps'}</span>
        <span>{language === 'zh' ? `已确认 ${used}/${rows.length} 项` : `${used}/${rows.length} confirmed`}</span>
      </summary>
      <p>{language === 'zh'
        ? '以下核对本版决策快照。已采集不等于已用于推荐；未知不按完整计算。'
        : 'Checked against this decision snapshot. Collection does not prove adoption; unknown is not complete.'}</p>
      <dl>{rows.map((row) => (
        <div key={row.key} data-state={row.state}>
          <dt>{row[language]}</dt><dd>{adoptionLabel[row.state][language]}</dd>
        </div>
      ))}</dl>
      <p>{language === 'zh'
        ? '待补充：先排查采集，再验证球队映射和时间范围；首发未公布时保持缺失，不用估算冒充。'
        : 'Next: check source access, verified team mapping and time coverage. Unpublished lineups stay missing.'}</p>
    </details>
  );
}
