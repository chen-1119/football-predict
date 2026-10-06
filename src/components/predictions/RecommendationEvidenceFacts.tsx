import type { Match, PredictionDetail } from '../../services/mockData';
import { DataAdoptionDetails } from './DataAdoptionDetails';
import { hasUnboundLegacyReferenceConflict } from '../../services/legacyReferenceConflict';
import {
  formatCalibrationSample,
  formatEvidenceCompleteness,
  formatFreshnessQuality,
  formatMarketConsistency,
  getPublishedRecommendationEvidenceBreakdown,
} from '../../services/predictionPresentation';
import { formatSourceNeutralText } from './sourceNeutralText';
import '../../styles/recommendation-evidence.css';
import type { Decision, Outcome } from '../../services/recommendationCenterView';
import { publishedPickLabel } from '../../services/publishedMatchRecommendation';
import { publishedDetailPresentation } from '../../services/publishedDetailPresentation';

interface RecommendationEvidenceFactsProps {
  match: Match;
  prediction?: PredictionDetail | null;
  language: 'zh' | 'en';
  className?: string;
  // undefined is legacy mode; null is a missing current publication, not a
  // license to fall back to the legacy BEST/GPT prediction.
  publishedDecision?: Decision | null;
  supplementaryModel?: boolean;
}

const joinClassNames = (...names: Array<string | false | null | undefined>) => (
  names.filter(Boolean).join(' ')
);

const isFrozenHadConditionalBranch = (decision: Decision | null) => (
  decision?.primaryPickPolicyVersion === 'coherent-market-primary-v1'
  && decision.coherentPrimary?.anchorMarket === 'HHAD'
);

export function FrozenHadPosteriorNote({ decision, disagreement, language }: {
  decision: Decision | null;
  disagreement: { published: Outcome; research: Outcome };
  language: 'zh' | 'en';
}) {
  if (!decision) return null;
  const conditionalBranch = isFrozenHadConditionalBranch(decision);
  const published = publishedPickLabel(disagreement.published, language);
  const research = publishedPickLabel(disagreement.research, language);
  return <p className="match-detail-v4__model-disagreement" role="note" data-model-direction-disagreement="true">
    {language === 'zh'
      ? `补充模型快照的研究后验偏向${research}，与原冻结胜平负${conditionalBranch ? '条件分支' : '选择'}${published}不同。两者时间及基础概率一致，但缺少后验内容绑定，不能证明发布时采用过该后验；${conditionalBranch ? '原冻结记录及其历史结算保留，两者均不作为当前正式推荐。' : '原冻结记录的发布方向及历史结算保持不变。'}`
      : `The supplemental model's research posterior favors ${research}, while the original frozen 1X2 ${conditionalBranch ? 'conditional branch' : 'selection'} is ${published}. The times and base probabilities align, but no posterior content binding proves it was used at publication. ${conditionalBranch ? 'The frozen record and its historical settlement are retained; neither is a current formal recommendation.' : 'The original published 1X2 selection and its historical settlement remain unchanged.'}`}
  </p>;
}

type FreshnessClockKind = 'observed-at' | 'source-updated-at' | 'as-of' | 'unavailable';

const resolveFreshnessClock = (
  breakdown: ReturnType<typeof getPublishedRecommendationEvidenceBreakdown>
): { kind: FreshnessClockKind; value: string | null } => {
  if (breakdown.freshnessObservedAt) {
    return { kind: 'observed-at', value: breakdown.freshnessObservedAt };
  }
  if (breakdown.freshnessSourceUpdatedAt) {
    return { kind: 'source-updated-at', value: breakdown.freshnessSourceUpdatedAt };
  }
  if (breakdown.freshnessAsOf) {
    return { kind: 'as-of', value: breakdown.freshnessAsOf };
  }
  return { kind: 'unavailable', value: null };
};

const formatFreshnessClock = (
  clock: { kind: FreshnessClockKind; value: string | null },
  language: 'zh' | 'en'
) => {
  const value = clock.value;
  const observedAt = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(observedAt)) {
    return language === 'zh' ? '观测时间未知' : 'Observation time unknown';
  }
  const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(observedAt);
  const prefix = clock.kind === 'observed-at'
    ? (language === 'zh' ? '观测' : 'Observed')
    : clock.kind === 'source-updated-at'
      ? (language === 'zh' ? '数据更新' : 'Data updated')
      : (language === 'zh' ? '截至' : 'As of');
  return `${prefix} ${formatted}`;
};

export function RecommendationEvidenceFacts({
  match,
  prediction,
  language,
  className,
  publishedDecision,
  supplementaryModel = true,
}: RecommendationEvidenceFactsProps) {
  if (publishedDecision !== undefined) {
    const view = publishedDetailPresentation(publishedDecision);
    const conditionalBranch = isFrozenHadConditionalBranch(publishedDecision);
    return <section className={joinClassNames('recommendation-evidence-facts', className)} data-testid="published-recommendation-evidence" data-decision-id={view?.decisionId} data-record-hash={view?.recordHash}>
      <details className="published-match-pick__basis" data-frozen-record-evidence="HAD"><summary>{language === 'zh' ? '查看原冻结胜平负记录' : 'View original frozen 1X2 record'}</summary>
      <h3>{language === 'zh' ? '原冻结胜平负记录' : 'Original frozen 1X2 record'}</h3>
      {view ? <>
        <strong data-frozen-had-role={conditionalBranch ? 'conditional-branch' : 'selection'}>{conditionalBranch
          ? (language === 'zh' ? '冻结条件分支：' : 'Frozen conditional branch: ')
          : (language === 'zh' ? '冻结选择：' : 'Frozen selection: ')}{publishedPickLabel(view.tipCode, language)} · {language === 'zh' ? '无条件概率' : 'Unconditional probability'} {(view.modelProbability * 100).toFixed(1)}%</strong>
        <p>{conditionalBranch
          ? (language === 'zh' ? '主方向成立时的一个分支，非独立推荐；原记录保留供复盘与版本对照。' : 'One branch if the primary lands, not an independent recommendation; the original record is retained for review and version comparison.')
          : (language === 'zh' ? '原记录保留供复盘与版本对照。' : 'The original record is retained for review and version comparison.')}</p>
        <dl className="recommendation-evidence-facts__grid">
          {(['home', 'draw', 'away'] as const).map((key, index) => <div key={key} data-outcome={['1', 'X', '2'][index]}><dt>{(language === 'zh' ? ['主胜', '平局', '客胜'] : ['Home', 'Draw', 'Away'])[index]}</dt><dd>{view.probabilities[key].toFixed(1)}%</dd></div>)}
        </dl>
        <p>{language === 'zh' ? '模型生成' : 'Model generated'} <time dateTime={view.modelGeneratedAt}>{formatFreshnessClock({ kind: 'as-of', value: view.modelGeneratedAt }, language)}</time></p>
        <p>{language === 'zh' ? '发布时间' : 'Published'} <time dateTime={view.publishedAt}>{formatFreshnessClock({ kind: 'as-of', value: view.publishedAt }, language)}</time></p>
        <p>{language === 'zh' ? 'SP采集' : 'SP observed'} <time dateTime={view.quoteObservedAt}>{formatFreshnessClock({ kind: 'observed-at', value: view.quoteObservedAt }, language)}</time></p>
        <small>{language === 'zh' ? '参考／影子模型概率，尚未验证为真实命中率。以下补充资料不构成本条发布记录的采用凭证。' : 'Reference/shadow model probabilities are not validated hit rates. Supplemental data does not prove adoption by this publication.'}</small>
      </> : <p>{language === 'zh' ? '暂无已发布推荐，等待统一记录；不使用旧模型方向或概率补位。' : 'No published recommendation yet; legacy model directions and probabilities are not substituted.'}</p>}
      {supplementaryModel && <details><summary>{language === 'zh' ? '补充模型快照的数据记录（未绑定本次发布）' : 'Supplemental model data (not bound to this publication)'}</summary><p>{language === 'zh' ? '下列时点、绑定和采用情况仅属于原模型快照，不代表上方已发布方向使用了这些输入。' : 'The times, bindings and adoption below belong only to the original model snapshot, not the published pick above.'}</p><DataAdoptionDetails match={match} language={language} /></details>}
      </details>
    </section>;
  }
  const breakdown = getPublishedRecommendationEvidenceBreakdown(match, prediction);
  const modelProbability = breakdown.modelProbability === null
    ? '--'
    : `${Math.round(breakdown.modelProbability)}%`;
  const evidenceCompleteness = formatEvidenceCompleteness(breakdown, '--');
  const marketConsistency = formatSourceNeutralText(formatMarketConsistency(breakdown, language, '--'), language, '--');
  const freshnessQuality = formatFreshnessQuality(breakdown, '--');
  const calibrationSample = formatCalibrationSample(breakdown, '--');
  const freshnessClock = resolveFreshnessClock(breakdown);
  const freshnessObservedLabel = formatFreshnessClock(freshnessClock, language);

  return (
    <section
      className={joinClassNames('recommendation-evidence-facts', className)}
      data-testid="recommendation-evidence-breakdown"
      data-market-consistency={breakdown.marketConsistency}
      aria-label={language === 'zh' ? '模型概率与数据质量' : 'Model probability and data quality'}
    >
      {hasUnboundLegacyReferenceConflict(match) && (
        <aside className="recommendation-evidence-facts__legacy-conflict" data-testid="legacy-reference-conflict" aria-label={language === 'zh' ? '旧参考记录冲突' : 'Conflicting legacy references'}>
          <strong>{language === 'zh' ? '旧参考记录不一致 · 公开方向待核验' : 'Legacy references disagree · published direction unverified'}</strong>
          <p>{language === 'zh'
            ? '当前数据保留了不同方向的旧参考记录，但缺少独立公开冻结凭证，无法确认当时展示的方向。请勿将其视为可信推荐；原档案保持不变，不能据此补算命中。'
            : 'Retained legacy references contain different directions, without an independent public freeze record proving what was shown. Do not treat them as a reliable pick. Original records remain unchanged; this does not justify adding a hit.'}</p>
        </aside>
      )}
      <dl className="recommendation-evidence-facts__grid">
        <div className={breakdown.modelProbability === null ? 'is-unavailable' : ''}>
          <dt>{language === 'zh' ? '模型概率' : 'Model probability'}</dt>
          <dd>{modelProbability}</dd>
        </div>
        <div className={breakdown.evidenceCompleteness === null ? 'is-unavailable' : ''}>
          <dt title={language === 'zh' ? '方向输入覆盖率，不代表所有数据齐全或预测命中率' : 'Directional input coverage, not full data coverage or accuracy'}>{language === 'zh' ? '方向输入覆盖' : 'Directional input coverage'}</dt>
          <dd>{evidenceCompleteness}</dd>
        </div>
        <div className={`is-market-${breakdown.marketConsistency}`}>
          <dt>{language === 'zh' ? '市场一致性' : 'Market consistency'}</dt>
          <dd>{marketConsistency}</dd>
        </div>
        <div className={breakdown.freshnessQuality === null ? 'is-unavailable' : ''}>
          <dt>{language === 'zh' ? '决策时数据时效' : 'Freshness at decision'}</dt>
          <dd>
            <span>{freshnessQuality}</span>
            <small data-freshness-clock={freshnessClock.kind}>{freshnessObservedLabel}</small>
          </dd>
        </div>
      </dl>
      <p className="recommendation-evidence-facts__sample">
        <span>{language === 'zh' ? '校准样本' : 'Calibration sample'}</span>
        <strong>{calibrationSample}{breakdown.calibrationSample === 0 ? (language === 'zh' ? ' · 尚无校准样本' : ' · No calibration samples') : ''}</strong>
      </p>
      <DataAdoptionDetails match={match} language={language} />
    </section>
  );
}
