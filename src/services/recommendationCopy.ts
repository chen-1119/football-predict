import type { Match, MultiLangString, PredictionDetail } from './mockData';

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
  pending_sale: { zh: 'SP待补齐', en: 'SP pending' },
  thin_value: { zh: '赔率优势一般', en: 'Limited price edge' },
  handicap_soft: { zh: '让球盘支持偏弱', en: 'Handicap support is soft' },
  market_split: { zh: '临场需要复核', en: 'Late recheck needed' },
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
  return cleaned || (language === 'zh' ? '暂无主推' : 'No pick');
};

const marketLabelForPrediction = (prediction: PredictionDetail | undefined, language: Language) => {
  if (!prediction) return language === 'zh' ? '暂无玩法' : 'No market';
  if (prediction.oddsPoolCode === 'HHAD') return language === 'zh' ? '让球玩法' : 'Handicap';
  if (prediction.marketType === 'GOALS') return language === 'zh' ? '进球数' : 'Goals';
  return language === 'zh' ? '胜平负' : '1X2';
};

const strengthFromTrust = (
  prediction: PredictionDetail | undefined,
  publicRisks: MultiLangString[]
): { label: MultiLangString; tone: StrengthTone } => {
  if (!prediction || prediction.tipCode === 'WATCH') {
    return { label: { zh: '待补齐', en: 'Pending' }, tone: 'pending' };
  }

  const trust = Number(prediction.trustScore || 0);
  const hardRiskCount = publicRisks.length;

  if (trust >= 76 && hardRiskCount <= 2) return { label: { zh: '中高', en: 'Medium-high' }, tone: 'strong' };
  if (trust >= 58) return { label: { zh: '中', en: 'Medium' }, tone: 'medium' };
  return { label: { zh: '低', en: 'Low' }, tone: 'low' };
};

const hasPublicRisk = (risks: MultiLangString[], zh: string) => risks.some((risk) => risk.zh === zh);

export const buildPublicRecommendationCopy = (
  match: Match,
  prediction: PredictionDetail | undefined,
  language: Language,
  options: { pickLabel?: string; fallbackReason?: string; isLocked?: boolean } = {}
): PublicRecommendationCopy => {
  const publicRisks = getPublicRiskTags(prediction?.riskTags, 3);
  const strength = strengthFromTrust(prediction, publicRisks);
  const pickLabel = cleanPickLabel(options.pickLabel || prediction?.tipLabel?.[language] || '', language);
  const hasPick = Boolean(prediction && prediction.tipCode !== 'WATCH');
  const marketLabel = marketLabelForPrediction(prediction, language);
  const oddsValue = Number(prediction?.odds || 0);
  const oddsLabel = oddsValue > 0
    ? (language === 'zh' ? `赔率 ${oddsValue.toFixed(2)}` : `Odds ${oddsValue.toFixed(2)}`)
    : (language === 'zh' ? 'SP待开售' : 'SP pending');
  const title = hasPick
    ? (language === 'zh' ? `主推 ${pickLabel}` : `Pick ${pickLabel}`)
    : (language === 'zh' ? '暂无可推方向' : 'No qualified pick');

  const reasons: string[] = [];
  if (!hasPick) {
    reasons.push(language === 'zh' ? '当前还没有达到推荐门槛的已开售方向。' : 'No on-sale direction has passed the pick gate yet.');
  } else if (oddsValue <= 0) {
    reasons.push(language === 'zh' ? '当前方向已生成，官方 SP 未开售；开售后按最新赔率复核。' : 'The direction is available, but official SP is not open yet; recheck once odds open.');
  } else if (prediction?.oddsPoolCode === 'HHAD') {
    reasons.push(language === 'zh' ? '本场按让球玩法给出主推，重点看让球线是否继续支持。' : 'The pick uses the handicap market; recheck whether the line still supports it.');
  } else {
    reasons.push(language === 'zh' ? '本场按胜平负玩法给出主推，赔率和赛前信息相对支持当前方向。' : 'The pick uses 1X2; odds and pre-match information support this direction.');
  }

  if (hasPublicRisk(publicRisks, '需要防平') || hasPublicRisk(publicRisks, '胜负差距不大')) {
    reasons.push(language === 'zh' ? '胜负差距不算大，推荐强度不会拉满。' : 'The edge is not wide enough for a full-confidence pick.');
  } else if (hasPublicRisk(publicRisks, '让球盘支持偏弱') || hasPublicRisk(publicRisks, '临场需要复核')) {
    reasons.push(language === 'zh' ? '盘口没有完全同向，临场需要再确认。' : 'The market is not fully aligned, so a late check matters.');
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
    : [language === 'zh' ? '临场信息变化仍需留意' : 'Late information can still change confidence'];

  const updateRule = match.status === 'FINISHED'
    ? (language === 'zh' ? '本场已完场，只保留赛前方向和赛后复盘。' : 'This match is finished; only the pre-match pick and review are kept.')
    : options.isLocked
      ? (language === 'zh' ? '推荐方向已锁定，后续只做赛后复盘。' : 'The pick is locked; later updates are review only.')
      : (language === 'zh' ? '停售前如赔率或让球线明显变化，会重新计算；停售后方向锁定。' : 'Before cutoff, major odds or line movement recalculates the pick; after cutoff, it is locked.');

  return {
    title,
    marketLabel,
    oddsLabel,
    strengthLabel: language === 'zh' ? `推荐强度 ${strength.label.zh}` : `Strength ${strength.label.en}`,
    strengthTone: strength.tone,
    statusLabel: match.status === 'FINISHED'
      ? (language === 'zh' ? '赛后复盘' : 'Review')
      : oddsValue > 0
        ? (language === 'zh' ? '已开售' : 'On sale')
        : (language === 'zh' ? 'SP待开' : 'SP pending'),
    reasons: reasons.slice(0, 3),
    risks,
    updateRule
  };
};
