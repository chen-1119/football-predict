import { useMemo, useState } from 'react';
import type { Match } from '../../services/mockData';
import { buildCapturedReferenceAnalysis } from '../../services/capturedReferenceAnalysis';
import type { CapturedReferenceUnavailableReason } from '../../services/capturedReferenceAnalysis';
import type { SavedMatchCapture } from './CapturedMatchData';
import { formatSourceNeutralText } from './sourceNeutralText';
import '../../styles/captured-reference-analysis.css';

type Language = 'zh' | 'en';
type AnalysisTab = 'interpretation' | 'parameters';
type Props = { match: Match; capture: SavedMatchCapture; language: Language; now: number };

const unavailableCopy: Record<CapturedReferenceUnavailableReason, { zh: string; en: string }> = {
  'capture-missing': { zh: '尚无本场已保存记录。', en: 'No saved records are available for this match.' },
  'invalid-match-identity': { zh: '比赛身份信息不完整，暂不生成参考分析。', en: 'The match identity is incomplete; reference analysis is unavailable.' },
  'capture-identity-mismatch': { zh: '记录与当前比赛不匹配，暂不生成参考分析。', en: 'The saved record does not match this fixture.' },
  'capture-not-reference-only': { zh: '记录的使用范围未确认，暂不生成参考分析。', en: 'The record is not confirmed for this reference-only use.' },
  'invalid-time': { zh: '记录时间或开赛时间未确认，暂不生成参考分析。', en: 'The capture or kickoff time is not confirmed.' },
  'match-not-scheduled': { zh: '本场已不处于待开赛状态，不再生成赛前参考。', en: 'This match is no longer scheduled; pre-match reference generation is closed.' },
  'match-started': { zh: '已到开赛时间，不再生成赛前参考。', en: 'Kickoff has been reached; pre-match reference generation is closed.' },
  'manual-odds-missing': { zh: '尚无完整的人工核对胜平负三价。', en: 'No complete manually checked 1X2 prices are available.' },
  'unsupported-capture-method': { zh: '三价记录的核对方式尚未确认。', en: 'The price-record verification method is not confirmed.' },
  'invalid-odds': { zh: '胜平负三价不完整或格式无效，暂不计算。', en: 'The 1X2 prices are incomplete or invalid.' },
  'observation-in-future': { zh: '记录时间晚于当前时间，需先核对时间。', en: 'The record is dated in the future and needs a time check.' },
  'observation-not-prematch': { zh: '未确认这是开赛前的三价记录，暂不计算。', en: 'The prices are not confirmed as a pre-kickoff observation.' },
  'fit-quality-insufficient': { zh: '当前三价无法在误差范围内拟合，暂不提供比分与进球参考。', en: 'These prices could not be fitted within the allowed error; score and goal references are unavailable.' },
  'truncation-quality-insufficient': { zh: '比分概率覆盖不足，暂不提供参考分析。', en: 'The score-probability matrix has insufficient coverage.' }
};

const percent = (value: number | undefined, digits = 2) => (
  typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--'
);
const decimal = (value: number, digits = 4) => Number.isFinite(value) ? value.toFixed(digits) : '--';
const beijingTime = (value: string, language: Language) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return language === 'zh' ? '时间未确认' : 'Time unconfirmed';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Shanghai'
  }).format(timestamp) + (language === 'zh' ? '（北京时间）' : ' (Beijing time)');
};

export function CapturedReferenceAnalysisPanel({ match, capture, language, now }: Props) {
  const analysis = useMemo(() => buildCapturedReferenceAnalysis(match, capture, now), [match, capture, now]);
  const [activeTab, setActiveTab] = useState<AnalysisTab>('interpretation');
  const show = (value: string | null | undefined) => formatSourceNeutralText(value, language, '--');
  const title = language === 'zh' ? '赛前推荐 · 参考' : 'Pre-match picks · Reference';
  if (analysis.status === 'unavailable') return (
    <section className="captured-reference-analysis is-unavailable" aria-labelledby="captured-reference-heading">
      <h2 id="captured-reference-heading">{title}</h2>
      <p>{unavailableCopy[analysis.reason]?.[language] || (language === 'zh' ? '当前记录暂不能生成参考分析。' : 'The saved record cannot currently produce a reference analysis.')}</p>
      <a href="#captured-match-data-heading">{language === 'zh' ? '查看已采集记录' : 'View saved records'}</a>
    </section>
  );

  const outcomeLabels = language === 'zh' ? { home: '主胜', draw: '平局', away: '客胜' } : { home: 'Home win', draw: 'Draw', away: 'Away win' };
  const leadingScore = analysis.scores[0];
  const distribution = (['home', 'draw', 'away'] as const).map(code => ({ code, label: outcomeLabels[code], probability: analysis.market[code] }));
  const historyCount = (capture.teamHistory || []).reduce((sum, team) => sum + team.matches.length, 0);
  return (
    <section className="captured-reference-analysis" aria-labelledby="captured-reference-heading">
      <header className="captured-reference-analysis__header">
        <div><span className="captured-reference-analysis__eyebrow">{language === 'zh' ? '基于已保存的胜平负赔率' : 'Based on saved 1X2 odds'}</span><h2 id="captured-reference-heading">{title}</h2></div>
        <span className="captured-reference-analysis__badge">{language === 'zh' ? '参考 · 未校准' : 'Reference · Uncalibrated'}</span>
      </header>
      <p className="captured-reference-analysis__intro">{language === 'zh' ? '以下为市场参考概率与独立泊松假设下的结果。输入价不是竞彩 SP；分析未回测校准，不属于正式推荐，不计入命中率。' : 'These are market-reference probabilities and results under an independent Poisson assumption. Inputs are not Sporttery SP. This analysis is not backtested or calibrated, is not a formal pick, and does not enter hit-rate statistics.'}</p>

      <div className="captured-reference-analysis__cards">
        <article className="captured-reference-analysis__pick">
          <h3>{language === 'zh' ? '胜平负方向' : '1X2 direction'}</h3>
          <strong className="captured-reference-analysis__choice">{outcomeLabels[analysis.outcome.code]}</strong>
          <p>{show(analysis.outcome.code === 'home' ? match.homeTeamName : analysis.outcome.code === 'away' ? match.awayTeamName : (language === 'zh' ? '双方打平' : 'A drawn match'))}</p>
          <div className="captured-reference-analysis__probability"><strong>{percent(analysis.outcome.probability)}</strong><span>{language === 'zh' ? '市场参考概率' : 'Market-reference probability'}</span></div>
          <small>{language === 'zh' ? '领先次选 ' : 'Lead over second choice: '}{decimal(analysis.outcome.gap * 100, 2)}{language === 'zh' ? ' 个百分点' : ' percentage points'}</small>
        </article>
        <article className="captured-reference-analysis__pick">
          <h3>{language === 'zh' ? '比分第一候选' : 'Leading score candidate'}</h3>
          <strong className="captured-reference-analysis__choice">{leadingScore ? `${leadingScore.home} - ${leadingScore.away}` : '--'}</strong>
          <div className="captured-reference-analysis__probability"><strong>{percent(leadingScore?.probability)}</strong><span>{language === 'zh' ? '假设模型概率' : 'Assumed-model probability'}</span></div>
          <ul className="captured-reference-analysis__score-list">{analysis.scores.slice(1).map(score => <li key={score.home + ':' + score.away}><span>{score.home} - {score.away}</span><strong>{percent(score.probability)}</strong></li>)}</ul>
        </article>
        <article className="captured-reference-analysis__pick">
          <h3>{language === 'zh' ? '进球数首选' : 'Leading total-goals candidate'}</h3>
          <strong className="captured-reference-analysis__choice">{show(analysis.goalsPick.label)}{language === 'zh' ? ' 球' : ' goals'}</strong>
          <div className="captured-reference-analysis__probability"><strong>{percent(analysis.goalsPick.probability)}</strong><span>{language === 'zh' ? '假设模型概率' : 'Assumed-model probability'}</span></div>
          <p>{language === 'zh' ? '总进球强度 λ ' : 'Total goal intensity λ '}{decimal(analysis.model.totalLambda)}</p>
          <small>{language === 'zh' ? '单一候选概率不等于预测准确率。' : 'A candidate probability is not prediction accuracy.'}</small>
        </article>
      </div>

      <div className="captured-reference-analysis__navigation">
        <div role="tablist" aria-label={language === 'zh' ? '参考分析内容' : 'Reference analysis views'} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next: AnalysisTab = event.key === 'Home' ? 'interpretation' : event.key === 'End' ? 'parameters'
            : activeTab === 'interpretation' ? 'parameters' : 'interpretation';
          setActiveTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>('#captured-reference-tab-' + next)?.focus();
        }}>
          <button type="button" role="tab" id="captured-reference-tab-interpretation" tabIndex={activeTab === 'interpretation' ? 0 : -1} aria-selected={activeTab === 'interpretation'} aria-controls="captured-reference-interpretation" onClick={() => setActiveTab('interpretation')}>{language === 'zh' ? '推荐解读' : 'Interpretation'}</button>
          <button type="button" role="tab" id="captured-reference-tab-parameters" tabIndex={activeTab === 'parameters' ? 0 : -1} aria-selected={activeTab === 'parameters'} aria-controls="captured-reference-parameters" onClick={() => setActiveTab('parameters')}>{language === 'zh' ? '分析参数' : 'Parameters'}</button>
        </div>
        <a href="#captured-match-data-heading">{language === 'zh' ? '采集记录' : 'Saved records'} <span aria-hidden="true">↓</span></a>
      </div>

      {activeTab === 'interpretation' ? <div className="captured-reference-analysis__body" role="tabpanel" tabIndex={0} id="captured-reference-interpretation" aria-labelledby="captured-reference-tab-interpretation">
        <div className="captured-reference-analysis__distributions">
          <section><h3>{language === 'zh' ? '胜平负概率分布' : '1X2 probability distribution'}</h3>
            <div className="captured-reference-analysis__bars">{distribution.map(row => <div key={row.code}>
              <div><span>{row.label}</span><strong>{percent(row.probability)}</strong></div>
              <div className="captured-reference-analysis__track" aria-hidden="true"><span style={{ width: `${row.probability * 100}%` }} /></div>
            </div>)}</div>
            <p className="captured-reference-analysis__note">{language === 'zh' ? '三项来自输入赔率倒数归一。最高概率仅表示三项中相对占优。' : 'The three probabilities normalize the inverse input prices. The largest is only the relative leader among these outcomes.'}</p>
          </section>
          <section><h3>{language === 'zh' ? '进球数概率分布' : 'Total-goals distribution'}</h3>
            <div className="captured-reference-analysis__goals">{analysis.totalGoals.map(row => <div key={row.label}><span>{show(row.label)}{language === 'zh' ? ' 球' : ' goals'}</span><strong>{percent(row.probability)}</strong></div>)}</div>
          </section>
        </div>
        <dl className="captured-reference-analysis__secondary">
          <div><dt>{language === 'zh' ? '大于 2.5 球' : 'Over 2.5 goals'}</dt><dd>{percent(analysis.over25)}</dd></div>
          <div><dt>{language === 'zh' ? '小于 2.5 球' : 'Under 2.5 goals'}</dt><dd>{percent(analysis.under25)}</dd></div>
          <div><dt>{language === 'zh' ? '双方均进球' : 'Both teams score'}</dt><dd>{percent(analysis.btts)}</dd></div>
        </dl>
        <p className="captured-reference-analysis__note">{language === 'zh' ? '比分、进球数、大小球与双方进球共用同一独立泊松模型。比分首选与胜平负方向可能不同，均保留原计算结果。' : 'Scores, goal totals, over/under and both-teams-to-score share one independent Poisson model. The leading score may imply a different outcome than the leading 1X2 result; both calculations are retained.'}</p>
      </div> : <div className="captured-reference-analysis__body" role="tabpanel" tabIndex={0} id="captured-reference-parameters" aria-labelledby="captured-reference-tab-parameters">
        <h3>{language === 'zh' ? '已计算参数' : 'Calculated parameters'}</h3>
        <dl className="captured-reference-analysis__parameters">
          <div><dt>{language === 'zh' ? '主队 λ · 拟合进球强度' : 'Home λ · fitted goal intensity'}</dt><dd>{decimal(analysis.model.homeLambda)}</dd></div>
          <div><dt>{language === 'zh' ? '客队 λ · 拟合进球强度' : 'Away λ · fitted goal intensity'}</dt><dd>{decimal(analysis.model.awayLambda)}</dd></div>
          <div><dt>{language === 'zh' ? '总 λ' : 'Total λ'}</dt><dd>{decimal(analysis.model.totalLambda)}</dd></div>
          <div><dt>{language === 'zh' ? '赔率隐含概率超额' : 'Implied-probability overround'}</dt><dd>{percent(analysis.market.overround)}</dd></div>
          <div><dt>{language === 'zh' ? '三项拟合最大误差' : 'Maximum 1X2 fitting error'}</dt><dd>{decimal(analysis.model.fitMaxError * 100, 6)} <small>{language === 'zh' ? '个百分点' : 'pp'}</small></dd></div>
          <div><dt>{language === 'zh' ? '比分矩阵概率覆盖' : 'Score-matrix probability mass'}</dt><dd>{percent(analysis.model.matrixMass, 6)}</dd></div>
          <div><dt>{language === 'zh' ? '矩阵外尾部概率' : 'Omitted tail probability'}</dt><dd>{percent(analysis.model.tailMass, 6)}</dd></div>
        </dl>
        <section><h3>{language === 'zh' ? '拟合后的胜平负概率' : 'Fitted 1X2 probabilities'}</h3>
          <dl className="captured-reference-analysis__secondary">{(['home', 'draw', 'away'] as const).map(code => <div key={code}><dt>{outcomeLabels[code]}</dt><dd>{percent(analysis.model.fittedOutcome[code])}</dd></div>)}</dl>
        </section>
        <div className="captured-reference-analysis__inputs">
          <h3>{language === 'zh' ? '使用的数据' : 'Input data'}</h3>
          <p>{language === 'zh' ? '采集时间：' : 'Captured: '}{show(beijingTime(analysis.inputObservedAt, language))}</p>
          <dl className="captured-reference-analysis__secondary">{analysis.inputOdds.map((value, index) => <div key={index}><dt>{Object.values(outcomeLabels)[index]}{language === 'zh' ? '输入价' : ' input price'}</dt><dd>{decimal(value, 2)}</dd></div>)}</dl>
          <p className="captured-reference-analysis__note">{language === 'zh' ? '人工核对三价，非竞彩 SP。概率超额 = 三价倒数之和 − 1；归一后得到市场参考概率。' : 'Manually checked prices, not Sporttery SP. Overround is the sum of the three inverse prices minus one; normalization produces the market-reference probabilities.'}</p>
        </div>
        <section className="captured-reference-analysis__assumptions"><h3>{language === 'zh' ? '模型假设与边界' : 'Model assumptions and limits'}</h3>
          <ul>
            <li>{language === 'zh' ? '假设主客队进球相互独立且符合泊松分布，拟合 λ 使胜平负分布接近输入三价。λ 是拟合参数，不是观测 xG。' : 'Home and away goals are assumed independent and Poisson-distributed. Fitted λ values approximate the input 1X2 distribution; they are not observed xG.'}</li>
            <li>{language === 'zh' ? '双 λ 搜索范围为 0.02–8；三项最大误差不超过 0.5 个百分点；比分矩阵概率覆盖至少 99.9999%。' : 'Each λ is searched within 0.02–8. Maximum 1X2 error is at most 0.5 percentage points, with at least 99.9999% score-matrix probability coverage.'}</li>
            <li>{language === 'zh' ? '该算法尚未回测或校准，也未计算 Elo 或真实命中率。数学拟合通过不代表预测效果已验证。' : 'This algorithm has not been backtested or calibrated and does not calculate Elo or an observed hit rate. A successful mathematical fit does not establish predictive performance.'}</li>
          </ul>
        </section>
        <section className="captured-reference-analysis__assumptions"><h3>{language === 'zh' ? '未参与本次计算' : 'Not used in this calculation'}</h3>
          <p>{language === 'zh' ? '伤停、阵容、排名、天气、' : 'Absences, lineup, ranks, weather, '}{historyCount > 0 ? show(String(historyCount)) + (language === 'zh' ? ' 场已保存历史样本' : ' saved historical matches') : (language === 'zh' ? '历史样本' : 'historical matches')}{language === 'zh' ? '，以及方向和水位格式未确认的盘口原值。它们仍可在采集记录中查看。' : ', and raw markets with unconfirmed handicap direction or price format. They remain available in the saved records.'}</p>
        </section>
      </div>}
    </section>
  );
}
