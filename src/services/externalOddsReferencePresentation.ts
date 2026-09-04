import type { Match, PredictionDetail } from './mockData';
import {
  buildExternalOddsAnalysisReference,
  type ExternalOddsAnalysisReference
} from './externalOddsAnalysisReference';

export const FIVE_HUNDRED_MARKET_REFERENCE_TIER = 'five-hundred-market-reference';
export const FIVE_HUNDRED_LOW_EVIDENCE_MARKET_REFERENCE_TIER =
  'five-hundred-had-low-evidence-market-leader';
export const IMMUTABLE_FIVE_HUNDRED_MARKET_REFERENCE_TIER =
  'immutable-five-hundred-analysis-reference';
export const FIVE_HUNDRED_REFERENCE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface FiveHundredMarketReferencePresentation {
  prediction: PredictionDetail;
  reference: ExternalOddsAnalysisReference;
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const points = (value: number) => `${(value * 100).toFixed(1)}`;

export const buildFiveHundredMarketReferencePresentation = (
  match: Match | null | undefined,
  now = Date.now()
): FiveHundredMarketReferencePresentation | null => {
  const reference = buildExternalOddsAnalysisReference(match, now);
  if (!reference) return null;
  const sourceObservedAt = Date.parse(reference.sourceUpdatedAt || '');
  if (
    !Number.isFinite(sourceObservedAt)
    || sourceObservedAt > now + 5 * 60 * 1000
    || now - sourceObservedAt > FIVE_HUNDRED_REFERENCE_MAX_AGE_MS
  ) return null;

  const direction = reference.hadDirection.label;
  const handicapRiskZh = reference.handicapRisk
    ? `；让球盘与胜平负首位方向冲突，${reference.handicapRisk.label.zh}`
    : '';
  const handicapRiskEn = reference.handicapRisk
    ? `; the handicap leader conflicts with HAD, so ${reference.handicapRisk.label.en.toLowerCase()}`
    : '';

  return {
    reference,
    prediction: {
      marketType: 'BEST',
      oddsPoolCode: 'HAD',
      tipCode: reference.tipCode,
      tipLabel: { zh: direction.zh, en: direction.en },
      // Deliberately keep the recommendation price at zero. The actual 500
      // quote is rendered as a labelled external reference and cannot satisfy
      // any official-SP, live-publication or bet-slip gate.
      odds: 0,
      trustScore: Math.round(reference.leaderProbability * 100),
      recommendationAction: 'reference',
      recommendationTier: FIVE_HUNDRED_MARKET_REFERENCE_TIER,
      explanation: {
        zh: `500网非官方HAD去水后首位方向为${direction.zh}，隐含概率${percent(reference.leaderProbability)}，领先第二方向${points(reference.leaderGap)}个百分点${handicapRiskZh}。作为数据推荐独立复盘，不并入正式推荐、实时推荐或串关。`,
        en: `The non-official 500.com HAD leader supports the data pick ${direction.en} at ${percent(reference.leaderProbability)}, ahead of the runner-up by ${points(reference.leaderGap)} points${handicapRiskEn}. It is reviewed separately and excluded from formal picks, live picks and bet slips.`
      },
      analysisItems: [
        {
          zh: `\u5c55\u793a\u95e8\u69db\uff1a\u53bb\u6c34\u540e\u9996\u4f4d\u6982\u7387\u81f3\u5c11 ${percent(reference.minimumLeaderProbability)}\uff0c\u4e14\u9886\u5148\u7b2c\u4e8c\u65b9\u5411\u81f3\u5c11 ${points(reference.minimumLeaderGap)} \u4e2a\u767e\u5206\u70b9\u3002`,
          en: `Display gate: the de-vigged leader must be at least ${percent(reference.minimumLeaderProbability)} and lead the runner-up by at least ${points(reference.minimumLeaderGap)} points.`
        },
        {
          zh: `500网HAD参考价：主胜 ${reference.sourceOdds.odds1.toFixed(2)} / 平 ${reference.sourceOdds.oddsX.toFixed(2)} / 客胜 ${reference.sourceOdds.odds2.toFixed(2)}。`,
          en: `500.com HAD reference: home ${reference.sourceOdds.odds1.toFixed(2)} / draw ${reference.sourceOdds.oddsX.toFixed(2)} / away ${reference.sourceOdds.odds2.toFixed(2)}.`
        },
        {
          zh: `去水概率首位${direction.zh} ${percent(reference.leaderProbability)}，领先第二方向 ${points(reference.leaderGap)} 个百分点；最低展示门槛为 ${points(reference.minimumLeaderGap)} 个百分点。`,
          en: `De-vigged leader ${direction.en} ${percent(reference.leaderProbability)}, with a ${points(reference.leaderGap)}-point lead; minimum display margin is ${points(reference.minimumLeaderGap)} points.`
        },
        ...(reference.handicapRisk ? [reference.handicapRisk.reason] : [])
      ],
      riskTags: [
        { zh: '500非官方数据推荐', en: '500.com non-official data pick' },
        { zh: '独立复盘统计', en: 'Separate review statistics' },
        ...(reference.handicapRisk
          ? [{ zh: reference.handicapRisk.label.zh, en: reference.handicapRisk.label.en }]
          : [])
      ],
      visibilityStatus: 'FREE',
      resultStatus: 'PENDING'
    }
  };
};

export const isFiveHundredMarketReferencePrediction = (
  prediction: Pick<PredictionDetail, 'recommendationAction' | 'recommendationTier'> | null | undefined
) => Boolean(
  prediction
  && prediction.recommendationAction === 'reference'
  && (
    prediction.recommendationTier === FIVE_HUNDRED_MARKET_REFERENCE_TIER
    || prediction.recommendationTier === FIVE_HUNDRED_LOW_EVIDENCE_MARKET_REFERENCE_TIER
    || prediction.recommendationTier === IMMUTABLE_FIVE_HUNDRED_MARKET_REFERENCE_TIER
  )
);
