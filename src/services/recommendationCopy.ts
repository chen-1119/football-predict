import type { Match, MultiLangString, PredictionDetail } from './mockData';
import { getOfficialMatchOdds } from './bettingDisplay';
import { isFormalRecommendationPrediction } from './displayRecommendation';
import { formatEvidenceScore, getEvidenceScore } from './predictionPresentation';

type Language = 'zh' | 'en';
type StrengthTone = 'strong' | 'medium' | 'low' | 'pending';

export interface PublicRecommendationCopy {
  title: string;
  marketLabel: string;
  oddsLabel: string;
  strengthLabel: string;
  strengthTone: StrengthTone;
  statusLabel: string;
  reasons: string[];
  risks: string[];
  updateRule: string;
}

const publicRiskLabels: Record<string, MultiLangString> = {
  pending_sale: { zh: '等待官方赔率开售', en: 'Await official odds' },
  thin_value: { zh: '赔率优势一般', en: 'Limited price edge' },
  handicap_soft: { zh: '让球盘支持偏弱', en: 'Handicap support is soft' },
  market_split: { zh: '盘口意见不一致', en: 'Market is split' },
  close_result: { zh: '胜负差距不大', en: 'Close result' },
  draw_cover: { zh: '需要防平', en: 'Draw cover needed' },
  goals_unclear: { zh: '进球数不稳定', en: 'Goal range is unstable' },
  hot_favorite: { zh: '热门方向偏热', en: 'Favorite is hot' },
  data_gap: { zh: '赛前资料不完整', en: 'Pre-match data is incomplete' }
};

const hasAny = (text: string, values: string[]) => values.some((value) => text.includes(value));

const publicRiskKey = (tag: MultiLangString | undefined): string | null => {
  const text = `${tag?.zh || ''} ${tag?.en || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (hasAny(text, ['official sp pending', 'no official sp', 'pre-market', '官方sp未开售', '未开售'])) return 'pending_sale';
  if (hasAny(text, ['ev不足', 'value edge', 'thin edge', '价值边际', '优势不厚'])) return 'thin_value';
  if (hasAny(text, ['handicap support weak', '让球支持不足', '让球风险'])) return 'handicap_soft';
  if (hasAny(text, ['market disagreement', '盘口分歧'])) return 'market_split';
  if (hasAny(text, ['close', '胜负接近'])) return 'close_result';
  if (hasAny(text, ['draw', '防平'])) return 'draw_cover';
  if (hasAny(text, ['goal-model borderline', '进球临界', '低比分热区', '进球数'])) return 'goals_unclear';
  if (hasAny(text, ['heavy favorite', '热门过热', '国际赛低赔', '低赔'])) return 'hot_favorite';
  if (hasAny(text, ['key data gaps', 'missing', '关键数据缺口', '数据未接入'])) return 'data_gap';
  if (hasAny(text, ['posterior', '统一后验', 'model-only', '模型独立推荐'])) return null;
  return null;
};

export const getPublicRiskTags = (riskTags: MultiLangString[] | undefined, limit = 3): MultiLangString[] => {
  const seen = new Set<string>();
  const output: MultiLangString[] = [];

  for (const tag of riskTags || []) {
    const key = publicRiskKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(publicRiskLabels[key]);
    if (output.length >= limit) break;
  }

  return output;
};

const cleanPickLabel = (label: string, language: Language) => {
  const cleaned = label
    .replace(/^(推荐方向|主推|参考倾向|参考推荐|模型首选|价值观察|高可信)\s*/u, '')
    .replace(/^(Pick|Main pick|Reference lean|Reference pick|Model lean|Value watch|High confidence)[:：]?\s*/iu, '')
    .trim();
  return cleaned || (language === 'zh' ? '待确认' : 'Pending');
};

const marketLabelForPrediction = (prediction: PredictionDetail | undefined, language: Language) => {
  if (!prediction) return language === 'zh' ? '待确认' : 'Pending';
  if (prediction.oddsPoolCode === 'HHAD') return language === 'zh' ? '让球玩法' : 'Handicap';
  if (
    prediction.marketType === 'BEST'
    && prediction.oddsPoolCode === undefined
    && ['1', 'X', '2'].includes(prediction.tipCode)
  ) return language === 'zh' ? '模型 1X2' : 'Model 1X2';
  if (prediction.marketType === 'GOALS') return language === 'zh' ? '进球数' : 'Goals';
  return language === 'zh' ? '胜平负' : '1X2';
};

const evidenceTone = (
  prediction: PredictionDetail | undefined,
  publicRisks: MultiLangString[]
): StrengthTone => {
  if (!prediction || prediction.tipCode === 'WATCH') {
    return 'pending';
  }

  const score = getEvidenceScore(prediction);
  if (score === null) return 'pending';
  const hardRiskCount = publicRisks.length;

  if (score >= 76 && hardRiskCount <= 2) return 'strong';
  if (score >= 58) return 'medium';
  return 'low';
};

const hasPublicRisk = (risks: MultiLangString[], zh: string) => risks.some((risk) => risk.zh === zh);

const sameHandicapLine = (left: unknown, right: unknown) => {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  if (!leftText || !rightText) return false;
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? leftNumber === rightNumber
    : leftText === rightText;
};

const hasCurrentOfficialResultPoolIdentity = (
  match: Match,
  prediction: PredictionDetail | undefined,
) => {
  if (prediction?.oddsPoolCode === 'HAD') return true;
  if (prediction?.oddsPoolCode !== 'HHAD') return false;
  return sameHandicapLine(
    prediction.handicapLine,
    getOfficialMatchOdds(match).hhad?.handicap,
  );
};

const officialOutcomeOddsForPrediction = (
  match: Match,
  prediction: PredictionDetail | undefined,
) => {
  if (
    !prediction
    || !['1', 'X', '2'].includes(prediction.tipCode)
    || !hasCurrentOfficialResultPoolIdentity(match, prediction)
  ) return 0;
  const official = getOfficialMatchOdds(match);
  const odds = prediction.oddsPoolCode === 'HHAD'
    ? official.hhad?.odds
    : official.had?.odds;
  const value = prediction.tipCode === '1'
    ? odds?.odds1
    : prediction.tipCode === 'X'
      ? odds?.oddsX
      : odds?.odds2;
  return Number.isFinite(Number(value)) && Number(value) > 1 ? Number(value) : 0;
};

export const buildPublicRecommendationCopy = (
  match: Match,
  prediction: PredictionDetail | undefined,
  language: Language,
  options: { pickLabel?: string; fallbackReason?: string; isLocked?: boolean; forceReference?: boolean } = {}
): PublicRecommendationCopy => {
  const publicRisks = getPublicRiskTags(prediction?.riskTags, 3);
  const strengthTone = evidenceTone(prediction, publicRisks);
  const pickLabel = cleanPickLabel(options.pickLabel || prediction?.tipLabel?.[language] || '', language);
  const hasDirection = Boolean(prediction && prediction.tipCode !== 'WATCH');
  const isArchive = match.status === 'FINISHED' || match.status === 'PENDING_RESULT';
  const hasPick = Boolean(
    hasDirection
    && !isArchive
    && !options.forceReference
    && isFormalRecommendationPrediction(match, prediction)
  );
  const hasReference = hasDirection && !hasPick;
  const marketLabel = marketLabelForPrediction(prediction, language);
  const officialOddsValue = officialOutcomeOddsForPrediction(match, prediction);
  const isDirectionalResultPrediction = Boolean(
    prediction && ['1', 'X', '2'].includes(prediction.tipCode)
  );
  const hasResultPoolIdentity = hasCurrentOfficialResultPoolIdentity(match, prediction);
  const forceUnavailableSp = isDirectionalResultPrediction && !hasResultPoolIdentity;
  const storedOddsValue = forceUnavailableSp ? 0 : Number(prediction?.odds || 0);
  const oddsValue = officialOddsValue > 1
    ? officialOddsValue
    : storedOddsValue > 1
      ? storedOddsValue
      : 0;
  const oddsLabel = forceUnavailableSp
    ? 'SP --'
    : oddsValue > 0
    ? (language === 'zh' ? `赔率 ${oddsValue.toFixed(2)}` : `Odds ${oddsValue.toFixed(2)}`)
    : (language === 'zh' ? '赔率待开售' : 'Odds pending');
  const title = isArchive && hasDirection
    ? (language === 'zh' ? `赛前归档 ${pickLabel}` : `Pre-match archive ${pickLabel}`)
    : hasPick
      ? (language === 'zh' ? `正式推荐 ${pickLabel}` : `Pick ${pickLabel}`)
      : hasReference
        ? (language === 'zh' ? `参考推荐 ${pickLabel}` : `Reference pick ${pickLabel}`)
        : (language === 'zh' ? '暂无推荐' : 'No pick');

  const reasons: string[] = [];
  if (!hasDirection) {
    reasons.push(language === 'zh' ? '当前数据尚不能形成可靠方向，等待官方赔率与赛前数据补齐。' : 'Current data cannot form a reliable direction yet; official odds and pre-match inputs are still pending.');
  } else if (isArchive) {
    reasons.push(language === 'zh' ? '这里只还原赛前记录与赛后复盘，不作为当前正式推荐。' : 'This is an archived pre-match record for review, not a current formal pick.');
  } else if (hasReference) {
    reasons.push(language === 'zh' ? '多因素证据门槛尚未全部通过，当前方向降级为参考推荐，不计入正式推荐。' : 'The full multi-factor evidence gate has not passed, so this direction is a reference pick and is not counted as a formal pick.');
  } else if (oddsValue <= 0) {
    reasons.push(language === 'zh' ? '当前方向已生成，官方 SP 未开售；开售后按最新赔率复核。' : 'The direction is available, but official SP is not open yet; recheck once odds open.');
  } else if (prediction?.oddsPoolCode === 'HHAD') {
    reasons.push(language === 'zh' ? '本场按让球玩法给出主推，重点看让球线是否继续支持。' : 'The pick uses the handicap market; keep watching whether the line still supports it.');
  } else {
    reasons.push(language === 'zh' ? '本场按胜平负玩法给出主推，赔率和赛前信息相对支持当前方向。' : 'The pick uses 1X2; odds and pre-match information support this direction.');
  }

  if (hasPublicRisk(publicRisks, '需要防平') || hasPublicRisk(publicRisks, '胜负差距不大')) {
    reasons.push(language === 'zh' ? '胜负差距不算大，证据评分不会拉满。' : 'The edge is not wide enough for a top evidence score.');
  } else if (hasPublicRisk(publicRisks, '让球盘支持偏弱') || hasPublicRisk(publicRisks, '盘口意见不一致')) {
    reasons.push(language === 'zh' ? '盘口没有完全同向，临场需要再确认。' : 'The market is not fully aligned, so a late check matters.');
  } else if (hasReference && !isArchive) {
    reasons.push(language === 'zh'
      ? '参考推荐会继续补充盘口、赔率走势和阵容风险，但不会用市场概率首位改写已生成的主方向。'
      : 'Markets, odds movement, and lineups continue to supplement evidence and risk, but the market probability leader cannot overwrite the generated main direction.');
  } else if (hasPick) {
    reasons.push(language === 'zh' ? '当前方向优先级最高，但仍按临场变化调整强度。' : 'This is the top direction for now, with strength adjusted by late movement.');
  }

  if (publicRisks.length > 0) {
    reasons.push(language === 'zh'
      ? `主要注意：${publicRisks.map((risk) => risk.zh).join('、')}。`
      : `Watch: ${publicRisks.map((risk) => risk.en).join(', ')}.`);
  } else if (options.fallbackReason) {
    reasons.push(options.fallbackReason);
  }

  const risks = publicRisks.length > 0
    ? publicRisks.map((risk) => risk[language])
    : [hasPick
      ? (language === 'zh' ? '临场信息变化仍需留意' : 'Late information can still change the assessment')
      : (language === 'zh' ? '参考推荐，不计入正式推荐' : 'Reference pick; not counted as a formal pick')];

  const updateRule = isArchive
    ? (language === 'zh' ? '本场已完场，只保留赛前归档和赛后复盘。' : 'This match is finished; only the pre-match archive and review are kept.')
    : hasReference
      ? (language === 'zh'
        ? '赛前 BEST 主方向保持稳定；新赔率和数据只补充价格与风险，不因市场首位自动改向。'
        : 'The pre-match BEST direction stays stable; new odds and data supplement price and risk but cannot automatically switch it to the market leader.')
    : hasPick && options.isLocked
      ? (language === 'zh' ? '推荐方向已锁定，后续只做赛后复盘。' : 'The pick is locked; later updates are review only.')
      : hasPick
        ? (language === 'zh' ? '停售前如赔率或让球线明显变化，会重新计算；停售后方向锁定。' : 'Before cutoff, major odds or line movement recalculates the pick; after cutoff, it is locked.')
        : (language === 'zh' ? '当前没有可发布方向，等待下一次完整模型计算。' : 'No direction is publishable yet; waiting for the next complete model calculation.');

  return {
    title,
    marketLabel,
    oddsLabel,
    strengthLabel: language === 'zh'
      ? `证据评分 ${formatEvidenceScore(prediction)}`
      : `Evidence score ${formatEvidenceScore(prediction)}`,
    // A reference row never inherits the positive visual treatment used
    // for a formally publishable recommendation.
    strengthTone: hasPick ? strengthTone : 'pending',
    statusLabel: isArchive
      ? (language === 'zh' ? '赛前归档' : 'Archive')
      : hasPick
        ? (language === 'zh' ? '正式推荐' : 'Formal pick')
        : hasReference
          ? (language === 'zh' ? '参考推荐' : 'Reference pick')
          : (language === 'zh' ? '暂无推荐' : 'No pick'),
    reasons: reasons.slice(0, 3),
    risks,
    updateRule
  };
};
