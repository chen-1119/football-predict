import type { Match, MultiLangString, Odds, PredictionDetail } from './mockData';
import { getImpliedProbabilities, getPredictionTipDisplay } from './bettingDisplay';
import { getMatchSignal } from './matchSignal';

type ResultCode = '1' | 'X' | '2';
type InsightTone = 'success' | 'warning' | 'danger' | 'muted';

export interface MatchInsightMetric {
  label: MultiLangString;
  value: MultiLangString;
  tone: InsightTone;
}

export interface MatchInsightPoint {
  title: MultiLangString;
  body: MultiLangString;
  tone: InsightTone;
}

export interface MatchInsight {
  title: MultiLangString;
  summary: MultiLangString;
  action: MultiLangString;
  score: number | null;
  tone: InsightTone;
  metrics: MatchInsightMetric[];
  drivers: MatchInsightPoint[];
  watchpoints: MatchInsightPoint[];
  framework: MatchInsightPoint[];
}

export interface MatchInsightContext {
  homeSampleSize: number;
  awaySampleSize: number;
  h2hSampleSize: number;
  coverageLabel: string;
}

const resultLabels: Record<ResultCode, MultiLangString> = {
  '1': { zh: '主胜', en: 'Home win' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away win' }
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isResultCode = (code: string | undefined): code is ResultCode => code === '1' || code === 'X' || code === '2';

const pickProbability = (
  probabilities: { home: number; draw: number; away: number } | undefined,
  code: ResultCode | undefined
) => {
  if (!probabilities || !code) return null;
  if (code === '1') return probabilities.home;
  if (code === 'X') return probabilities.draw;
  return probabilities.away;
};

const oddsText = (odds: Odds | null | undefined) => {
  if (!odds) return '--';
  return `${odds.odds1.toFixed(2)} / ${odds.oddsX.toFixed(2)} / ${odds.odds2.toFixed(2)}`;
};

const percentText = (value: number | null) => (value === null ? '--' : `${value}%`);

const dataGap = {
  zh: '该项数据不足：当前未接入可验证的官方伤停、预计首发、天气、裁判、xG/xGA 或技术统计，不编造。',
  en: 'Data insufficient: verified injuries, lineups, weather, referee, xG/xGA, and event stats are not connected, so they are not invented.'
};

const buildProfessionalFramework = ({
  match,
  context,
  primary,
  tipZh,
  tipEn,
  action,
  trustScore,
  hadSupport,
  hhadSupport,
  sampleText,
  sampleEnough,
  trendText,
  riskTextZh,
  riskTextEn
}: {
  match: Match;
  context: MatchInsightContext;
  primary?: PredictionDetail;
  tipZh: string;
  tipEn: string;
  action: MultiLangString;
  trustScore: number;
  hadSupport: number | null;
  hhadSupport: number | null;
  sampleText: string;
  sampleEnough: boolean;
  trendText: MultiLangString | null;
  riskTextZh: string;
  riskTextEn: string;
}): MatchInsightPoint[] => {
  const hasPrimary = Boolean(primary);
  const latestOdds = oddsText(match.odds);
  const latestHandicapOdds = oddsText(match.handicapOdds);
  const trendZh = match.oddsTrend && trendText
    ? `已记录 ${match.oddsTrend.sampleSize} 次官方 SP 快照，走势为${trendText.zh}。${match.oddsTrend.summary.zh}`
    : '官方 SP 快照样本仍在积累，先以最新 HAD / HHAD 为准。';
  const trendEn = match.oddsTrend && trendText
    ? `${match.oddsTrend.sampleSize} official SP snapshots recorded; movement is ${trendText.en}. ${match.oddsTrend.summary.en}`
    : 'SP snapshots are still accumulating; use latest HAD / HHAD first.';
  const unavailableTone: InsightTone = 'muted';

  return [
    {
      title: { zh: '一、比赛基本面', en: '1. Fixture Baseline' },
      body: {
        zh: `${match.leagueName || '赛事'}：${match.homeTeamName || '主队'} vs ${match.awayTeamName || '客队'}。排名、积分、净胜球和阶段目标暂未接入，因此不把这些当作结论依据。`,
        en: `${match.leagueNameEn || match.leagueName || 'Fixture'}: ${match.homeTeamName || 'Home'} vs ${match.awayTeamName || 'Away'}. Table rank, points, goal difference, and phase targets are not connected.`
      },
      tone: 'warning'
    },
    {
      title: { zh: '二、近期状态', en: '2. Recent Form' },
      body: {
        zh: sampleEnough
          ? `近一年官方历史样本：主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场、交锋 ${context.h2hSampleSize} 场；样本用于辅助，不替代实时阵容和过程数据。`
          : `近一年官方历史样本偏少：${sampleText}，该部分只作辅助。${dataGap.zh}`,
        en: sampleEnough
          ? `Last-year official samples: home ${context.homeSampleSize}, away ${context.awaySampleSize}, H2H ${context.h2hSampleSize}; useful support, not a substitute for lineups or process data.`
          : `Small last-year sample: ${sampleText}; secondary only. ${dataGap.en}`
      },
      tone: sampleEnough ? 'success' : 'warning'
    },
    {
      title: { zh: '三、主客场表现', en: '3. Home/Away' },
      body: {
        zh: `当前只从近一年已完场官方结果追溯球队样本，未接入完整主客场积分榜和旅行数据。覆盖：${context.coverageLabel}。`,
        en: `Uses synced official finished results only. Full home/away table and travel data are not connected. Coverage: ${context.coverageLabel}.`
      },
      tone: 'warning'
    },
    {
      title: { zh: '四、进攻能力', en: '4. Attack' },
      body: {
        zh: hasPrimary
          ? `用官方 SP 反推进攻热区和总进球倾向，当前主推为 ${tipZh}，HAD 去水支持约 ${percentText(hadSupport)}。射门、射正、关键传球等过程数据不足。`
          : `HAD 暂未形成主推方向。${dataGap.zh}`,
        en: hasPrimary
          ? `Attack read is derived from official SP and goal heat zones. Main lean: ${tipEn}, HAD support ${percentText(hadSupport)}. Shots, SOT, and key passes are unavailable.`
          : `No HAD-based main lean yet. ${dataGap.en}`
      },
      tone: hasPrimary ? 'warning' : unavailableTone
    },
    {
      title: { zh: '五、防守能力', en: '5. Defense' },
      body: {
        zh: '防守稳定性只参考官方赛果、比分和 SP 风险标签；被射门、xGA、门将状态、定位球防守暂未接入。',
        en: 'Defensive stability uses official results, scores, and SP risk tags only. Shots allowed, xGA, goalkeeper form, and set-piece defense are unavailable.'
      },
      tone: unavailableTone
    },
    {
      title: { zh: '六、伤停与首发', en: '6. Injuries / XI' },
      body: dataGap,
      tone: unavailableTone
    },
    {
      title: { zh: '七、战术克制', en: '7. Tactics' },
      body: {
        zh: '阵型、高压、反击、边路/中路倾向和关键对位暂未接入可验证来源，本场不编造战术细节。',
        en: 'Formations, pressing, transition style, wing/central routes, and key matchups are not connected from verified sources.'
      },
      tone: unavailableTone
    },
    {
      title: { zh: '八、赛程体能与战意', en: '8. Schedule / Motivation' },
      body: {
        zh: '开赛时间来自中国竞彩网；休息天数、连续客场、杯赛轮换、争冠/保级/晋级战意暂未接入，暂不强行推断。',
        en: 'Kickoff is from Sporttery. Rest days, travel sequence, rotation pressure, and motivation are not connected.'
      },
      tone: unavailableTone
    },
    {
      title: { zh: '九、历史交锋', en: '9. H2H' },
      body: {
        zh: context.h2hSampleSize > 0
          ? `近一年已匹配双方正式交锋 ${context.h2hSampleSize} 场；样本会因阵容/教练变化降低参考价值。`
          : '近一年官方历史库暂未匹配到双方直接交锋，不能用历史印象替代实时数据。',
        en: context.h2hSampleSize > 0
          ? `${context.h2hSampleSize} direct H2H records matched in the last year; coaching/lineup changes can reduce value.`
          : 'No direct H2H found in the last-year official history set.'
      },
      tone: context.h2hSampleSize > 0 ? 'success' : 'warning'
    },
    {
      title: { zh: '十、天气场地裁判', en: '10. Weather / Referee' },
      body: dataGap,
      tone: unavailableTone
    },
    {
      title: { zh: '十一、赔率盘口', en: '11. Odds / Market' },
      body: {
        zh: `官方 HAD：${latestOdds}；官方 HHAD：${latestHandicapOdds}；让球同向支持约 ${hhadSupport === null ? '--' : `${hhadSupport}%`}。${trendZh}`,
        en: `Official HAD: ${latestOdds}; official HHAD: ${latestHandicapOdds}; handicap same-side support ${hhadSupport === null ? '--' : `${hhadSupport}%`}. ${trendEn}`
      },
      tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning'
    },
    {
      title: { zh: '十二、综合结论', en: '12. Verdict' },
      body: {
        zh: hasPrimary
          ? `稳妥方向：${action.zh}，不夸大确定性；激进方向：${tipZh}，可信度 ${trustScore || '--'}%。风险点：${riskTextZh}。`
          : `稳妥方向：等待 HAD 开售或下一次官方快照；激进方向：暂无。风险点：${riskTextZh}。`,
        en: hasPrimary
          ? `Conservative: ${action.en}; aggressive: ${tipEn}, confidence ${trustScore || '--'}%. Risks: ${riskTextEn}.`
          : `Conservative: wait for HAD or next official snapshot. Aggressive: none. Risks: ${riskTextEn}.`
      },
      tone: hasPrimary ? 'warning' : unavailableTone
    }
  ];
};

const getPrimaryPrediction = (match: Match): PredictionDetail | undefined => {
  return match.predictions.find((prediction) => prediction.marketType === 'BEST')
    || match.predictions.find((prediction) => prediction.marketType === '1X2');
};

const trendLabel = (direction: Match['oddsTrend'] extends infer T ? T extends { direction: infer D } ? D : never : never): MultiLangString => {
  const labels = {
    home: { zh: '主胜方向降赔', en: 'home side shortening' },
    draw: { zh: '平局方向降赔', en: 'draw shortening' },
    away: { zh: '客胜方向降赔', en: 'away side shortening' },
    mixed: { zh: '多方向拉扯', en: 'mixed movement' },
    flat: { zh: '整体波动很小', en: 'mostly flat' }
  } as const;

  return labels[direction as keyof typeof labels] || labels.flat;
};

export function buildMatchInsight(match: Match, context: MatchInsightContext): MatchInsight {
  const primary = getPrimaryPrediction(match);
  const signal = getMatchSignal(match);
  const resultCode = isResultCode(primary?.tipCode) ? primary.tipCode : undefined;
  const hadProbabilities = getImpliedProbabilities(match.odds);
  const hhadProbabilities = getImpliedProbabilities(match.handicapOdds);
  const hadSupport = pickProbability(hadProbabilities, resultCode);
  const hhadSupport = pickProbability(hhadProbabilities, resultCode);
  const riskTags = primary?.riskTags || [];
  const riskTextZh = riskTags.length ? riskTags.map((tag) => tag.zh).join('、') : '暂无明显风险标签';
  const riskTextEn = riskTags.length ? riskTags.map((tag) => tag.en).join(', ') : 'no major risk tags';
  const sampleText = `${context.homeSampleSize}/${context.awaySampleSize}/${context.h2hSampleSize}`;
  const sampleEnough = context.homeSampleSize >= 3 && context.awaySampleSize >= 3;
  const trendText = match.oddsTrend ? trendLabel(match.oddsTrend.direction) : null;
  const actionByCategory: Record<typeof signal.category, MultiLangString> = {
    steady: { zh: '可列入候选', en: 'Candidate' },
    watch: { zh: '观察为主', en: 'Watch' },
    avoid: { zh: '降低优先级', en: 'Lower priority' },
    unavailable: { zh: '等待开售', en: 'Wait for sale' },
    finished: { zh: '赛后复盘', en: 'Post-match review' }
  };
  const toneByCategory: Record<typeof signal.category, InsightTone> = {
    steady: 'success',
    watch: 'warning',
    avoid: 'danger',
    unavailable: 'muted',
    finished: 'muted'
  };
  const trustScore = primary?.trustScore || 0;
  const insightScore = primary
    ? clamp(Math.round(trustScore - riskTags.length * 4 + (sampleEnough ? 3 : -4) + (match.oddsTrend?.direction === 'mixed' ? -3 : 0)), 0, 99)
    : null;
  const tipZh = primary ? getPredictionTipDisplay(primary, 'zh', true) : '--';
  const tipEn = primary ? getPredictionTipDisplay(primary, 'en', true) : '--';
  const action = actionByCategory[signal.category];
  const tone = toneByCategory[signal.category];
  const framework = buildProfessionalFramework({
    match,
    context,
    primary,
    tipZh,
    tipEn,
    action,
    trustScore,
    hadSupport,
    hhadSupport,
    sampleText,
    sampleEnough,
    trendText,
    riskTextZh,
    riskTextEn
  });

  if (!primary && match.status === 'FINISHED') {
    return {
      title: { zh: '赛果归档', en: 'Result archived' },
      summary: {
        zh: '本场已完场，历史库仅保留官方赛果与可用赔率快照，不再按未开售比赛生成推荐。',
        en: 'This match is finished. The history store keeps official result and available SP snapshots without generating a pending-sale pick.'
      },
      action,
      score: null,
      tone,
      metrics: [
        { label: { zh: '主推', en: 'Pick' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: '官方SP', en: 'Official SP' }, value: { zh: hadProbabilities ? '已归档' : '无快照', en: hadProbabilities ? 'Archived' : 'No snapshot' }, tone: hadProbabilities ? 'success' : 'muted' },
        { label: { zh: '让球SP', en: 'Handicap SP' }, value: { zh: hhadProbabilities ? '已归档' : '无快照', en: hhadProbabilities ? 'Archived' : 'No snapshot' }, tone: hhadProbabilities ? 'success' : 'muted' },
        { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
      ],
      drivers: [
        {
          title: { zh: '归档状态', en: 'Archive state' },
          body: {
            zh: '完场比赛不显示“待开售”。若历史记录没有官方 SP 快照，页面只展示赛果与复盘样本。',
            en: 'Finished matches are not shown as pending sale. If no official SP snapshot exists, only result and review samples are shown.'
          },
          tone: 'muted'
        }
      ],
      watchpoints: [
        {
          title: { zh: '复盘建议', en: 'Review note' },
          body: {
            zh: '后续回测只使用开赛前已保存的预测与 SP 快照，避免赛后补赔率造成数据泄漏。',
            en: 'Backtesting should only use pre-kickoff predictions and SP snapshots to avoid post-match data leakage.'
          },
          tone: 'muted'
        }
      ],
      framework
    };
  }

  if (!primary) {
    return {
      title: { zh: '待开售观察', en: 'Waiting for HAD' },
      summary: {
        zh: '普通胜平负暂未开售，当前只做盘面观察，不生成主推结论。',
        en: 'Standard HAD is not on sale yet. This match is kept as market observation only.'
      },
      action,
      score: null,
      tone,
      metrics: [
        { label: { zh: '主推', en: 'Pick' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: 'HAD支持', en: 'HAD support' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: '让球验证', en: 'Handicap check' }, value: { zh: hhadProbabilities ? '已开售' : '未开售', en: hhadProbabilities ? 'Open' : 'Closed' }, tone: hhadProbabilities ? 'warning' : 'muted' },
        { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
      ],
      drivers: [
        {
          title: { zh: '当前盘面', en: 'Market state' },
          body: {
            zh: `官方让球胜平负 SP 为 ${oddsText(match.handicapOdds)}，普通胜平负开售后再生成模型推荐。`,
            en: `Official handicap SP is ${oddsText(match.handicapOdds)}. Model pick will be generated after HAD opens.`
          },
          tone: hhadProbabilities ? 'warning' : 'muted'
        }
      ],
      watchpoints: [
        {
          title: { zh: '操作建议', en: 'Action' },
          body: {
            zh: '先记录盘面快照，等待普通胜平负开售或临场 SP 更新。',
            en: 'Record the market snapshot first, then wait for HAD or late SP updates.'
          },
          tone: 'muted'
        }
      ],
      framework
    };
  }

  const handicapBody = hhadSupport === null
    ? {
      zh: '让球胜平负暂未形成可用验证，当前以 HAD 主盘为准。',
      en: 'No usable handicap check yet, so HAD remains the anchor.'
    }
    : {
      zh: `让球盘同方向支持率约 ${hhadSupport}%，${hhadSupport >= 42 ? '与主线基本同向。' : '对主线支持偏弱，需要降温。'}`,
      en: `Handicap same-side support is about ${hhadSupport}%, ${hhadSupport >= 42 ? 'broadly aligned with the pick.' : 'weaker than the main direction.'}`
    };

  return {
    title: { zh: 'AI 综合判断', en: 'AI Decision Brief' },
    summary: {
      zh: `${action.zh}：当前主线为 ${tipZh}，HAD 去水支持率 ${percentText(hadSupport)}，模型可信度 ${trustScore || '--'}%。风险标签：${riskTextZh}。`,
      en: `${action.en}: main lean is ${tipEn}, HAD normalized support ${percentText(hadSupport)}, model confidence ${trustScore || '--'}%. Risk tags: ${riskTextEn}.`
    },
    action,
    score: insightScore,
    tone,
    metrics: [
      { label: { zh: '主推', en: 'Pick' }, value: { zh: tipZh, en: tipEn }, tone },
      { label: { zh: 'HAD支持', en: 'HAD support' }, value: { zh: percentText(hadSupport), en: percentText(hadSupport) }, tone: hadSupport !== null && hadSupport >= 50 ? 'success' : 'warning' },
      { label: { zh: '让球验证', en: 'Handicap check' }, value: { zh: hhadSupport === null ? '--' : `${hhadSupport}%`, en: hhadSupport === null ? '--' : `${hhadSupport}%` }, tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning' },
      { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
    ],
    drivers: [
      {
        title: { zh: '胜平负主线', en: '1X2 anchor' },
        body: {
          zh: `官方 HAD SP 为 ${oddsText(match.odds)}，${resultCode ? resultLabels[resultCode].zh : '首选方向'}去水支持率约 ${percentText(hadSupport)}。`,
          en: `Official HAD SP is ${oddsText(match.odds)}; ${resultCode ? resultLabels[resultCode].en : 'top direction'} normalized support is about ${percentText(hadSupport)}.`
        },
        tone: hadSupport !== null && hadSupport >= 50 ? 'success' : 'warning'
      },
      {
        title: { zh: '让球验证', en: 'Handicap validation' },
        body: handicapBody,
        tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning'
      },
      {
        title: { zh: 'SP走势', en: 'SP movement' },
        body: match.oddsTrend && trendText
          ? {
            zh: `已记录 ${match.oddsTrend.sampleSize} 次官方快照，当前表现为${trendText.zh}。${match.oddsTrend.summary.zh}`,
            en: `${match.oddsTrend.sampleSize} official snapshots recorded; movement is ${trendText.en}. ${match.oddsTrend.summary.en}`
          }
          : {
            zh: '当前快照数量不足，先以最新官方 SP 与后续定时快照对比。',
            en: 'Not enough snapshots yet; compare the latest official SP with later scheduled captures.'
          },
        tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : 'success'
      }
    ],
    watchpoints: [
      {
        title: { zh: '风险标签', en: 'Risk tags' },
        body: {
          zh: riskTags.length ? `需要重点关注：${riskTextZh}。` : '暂未触发明显风险标签，但仍需看临场 SP 是否突变。',
          en: riskTags.length ? `Watch closely: ${riskTextEn}.` : 'No major risk tag triggered, but late SP movement still matters.'
        },
        tone: riskTags.length >= 2 ? 'danger' : riskTags.length === 1 ? 'warning' : 'muted'
      },
      {
        title: { zh: '历史样本质量', en: 'History quality' },
        body: {
          zh: sampleEnough
            ? `近一年样本为主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场、交锋 ${context.h2hSampleSize} 场；覆盖：${context.coverageLabel}。`
            : `近一年样本偏少，主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场、交锋 ${context.h2hSampleSize} 场；该部分仅作辅助。`,
          en: sampleEnough
            ? `Last-year samples: home ${context.homeSampleSize}, away ${context.awaySampleSize}, H2H ${context.h2hSampleSize}. Coverage: ${context.coverageLabel}.`
            : `Small last-year sample: home ${context.homeSampleSize}, away ${context.awaySampleSize}, H2H ${context.h2hSampleSize}; treat this as secondary context.`
        },
        tone: sampleEnough ? 'success' : 'warning'
      }
    ],
    framework
  };
}
