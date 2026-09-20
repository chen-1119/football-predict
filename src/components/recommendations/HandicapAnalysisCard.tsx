import type { HandicapAnalysisView, HandicapSettlementView, HandicapCode } from '../../services/recommendationCenterView';
import '../../styles/handicap-analysis.css';
const codes: HandicapCode[] = ['1', 'X', '2'];
const label = (c: HandicapCode, zh: boolean) => c === '1' ? (zh ? '让胜' : 'Handicap home') : c === 'X' ? (zh ? '让平' : 'Handicap draw') : (zh ? '让负' : 'Handicap away');
function condition(line: number, code: HandicapCode, zh: boolean) {
  const margin = -line;
  if (!zh) return code === '1' ? `Home margin ≥ ${margin + 1}` : code === 'X' ? `Home margin = ${margin}` : `Home margin ≤ ${margin - 1}`;
  if (code === 'X') return margin > 0 ? `主队恰好赢${margin}球` : margin < 0 ? `主队恰好输${-margin}球` : '双方打平';
  if (code === '1') return margin >= 0 ? `主队赢${margin + 1}球及以上` : margin === -1 ? '主队不败' : `主队不败或最多输${-margin - 1}球`;
  return margin <= 0 ? `主队输${1 - margin}球及以上` : margin === 1 ? '主队平局或输球' : `主队平/负或最多赢${margin - 1}球`;
}
export function HandicapAnalysisCard({ analysis, result, language }: { analysis?: HandicapAnalysisView; result?: HandicapSettlementView; language: 'zh' | 'en' }) {
  if (!analysis) return null;
  const zh = language === 'zh';
  if (analysis.status !== 'ready' || analysis.line === null || !analysis.probabilities) return <aside className="hc-analysis hc-analysis--pending">
    {zh ? '让球分析：本次缺少有效净胜球参数或盘口时点，普通胜平负推荐不受影响。' : 'Handicap analysis lacks a valid margin model or line observation; the ordinary pick is retained.'}
  </aside>;
  const line = analysis.line, p = analysis.probabilities;
  const primary = analysis.primaryTipCode === '1' ? (zh ? '主胜' : 'home win') : analysis.primaryTipCode === '2' ? (zh ? '客胜' : 'away win') : (zh ? '平局' : 'draw');
  return <section className="hc-analysis" aria-label={zh ? '净胜球与让球分析' : 'Goal-margin handicap analysis'}>
    <header><div><small>{zh ? '净胜球分析 · 90分钟' : 'Goal margin · Regulation time'}</small><h4>{zh ? (line > 0 ? '主队受让' : '主队让球') : 'Home handicap'} {line > 0 ? '+' : ''}{line}</h4></div>
      <div><small>{zh ? '让球唯一首选' : 'Handicap primary pick'}</small><strong>{analysis.tipCode ? label(analysis.tipCode, zh) : (zh ? '概率并列' : 'Tied probabilities')}</strong></div></header>
    <div className="hc-analysis__grid">{codes.map(c => <div key={c} className={c === analysis.tipCode ? 'is-selected' : ''}>
      <span>{label(c, zh)}</span><strong>{(p[c] * 100).toFixed(1)}%</strong><small>{condition(line, c, zh)}</small>
    </div>)}</div>
    {analysis.conditionalOnPrimary && <details><summary>{zh ? `在“${primary}”成立的前提下，赢球幅度如何分布？` : `Conditional breakdown given ${primary}`}</summary>
      <p>{codes.map(c => `${label(c, zh)} ${(analysis.conditionalOnPrimary![c] * 100).toFixed(1)}%`).join(' · ')}</p>
      <p>{zh ? '这是条件分布，不是完整命中概率；上方首选按包括其他赛果的完整分布决定。' : 'This is conditional, not the full event probability. The pick uses the unconditional distribution above.'}</p>
    </details>}
    {result && <p className="hc-analysis__result">{zh ? '本次让球复盘' : 'Frozen handicap review'}：{result.score ? `${result.score} · ` : ''}
      {result.state === 'WON' ? (zh ? '命中' : 'Won') : result.state === 'LOST' ? (zh ? '未命中' : 'Lost') : result.state === 'VOID' ? (zh ? '无效' : 'Void') : result.state === 'DISPUTED' ? (zh ? '赛果待核' : 'Disputed') : (zh ? '待赛果' : 'Pending')}
    </p>}
    <footer>{zh ? '保留本次胜平负概率，按进球模型拆分净胜球。模型尚未验证；不借用胜平负SP，不自动加入现有串关。' : 'Published HAD probabilities are preserved and split by the goal model. Unvalidated; no borrowed HAD price or automatic combo substitution.'}</footer>
  </section>;
}
