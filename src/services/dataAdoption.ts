import type { Match } from './mockData';

export type AdoptionState = 'adopted' | 'available-not-adopted' | 'not-yet-published' | 'missing' | 'unknown';
const FAMILIES = [
  ['officialOdds', '官方赔率', 'Official odds'], ['externalMarket', '外部市场', 'External market'],
  ['standings', '积分排名', 'Standings'], ['lineup', '首发阵容', 'Lineup'],
  ['injuries', '伤停信息', 'Injuries'], ['xg', '预期进球', 'Expected goals'],
  ['weather', '天气场地', 'Weather'], ['referee', '裁判数据', 'Referee'],
  ['teamCards', '球队牌数', 'Team cards'],
] as const;
const object = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

/** Collected now and adopted by a frozen decision are deliberately separate. */
export function getDataAdoptionFacts(match: Match) {
  const inputs = match.predictionMeta?.featureSnapshot?.modelInputs;
  const frozen = object(match.predictionMeta?.publicReferenceDecision?.integrityVerified === true
    ? match.predictionMeta.publicReferenceDecision.dataGaps
    : match.predictionMeta?.decisionDataGaps || object(inputs)?.dataGaps);
  const connected = object(frozen?.connected);
  const current = match.probabilityModel?.contextSignals?.dataGaps;
  const currentConnected = current?.connected as Record<string, unknown> | undefined;
  const pending = current?.preMatchQuality?.notYetPublishable || [];
  return FAMILIES.map(([key, zh, en]) => {
    const state: AdoptionState = connected?.[key] === true ? 'adopted'
      : currentConnected?.[key] === true ? 'available-not-adopted'
        : pending.some((item) => item.key === key) ? 'not-yet-published'
          : connected?.[key] === false ? 'missing' : 'unknown';
    return { key, zh, en, state };
  });
}

export const adoptionLabel: Record<AdoptionState, { zh: string; en: string }> = {
  adopted: { zh: '本版已采用', en: 'Used in this decision' },
  'available-not-adopted': { zh: '当前可用 · 本版未确认采用', en: 'Available now · not confirmed in decision' },
  'not-yet-published': { zh: '尚未公布', en: 'Not published yet' },
  missing: { zh: '本版缺失', en: 'Missing in decision' },
  unknown: { zh: '采用证据未知', en: 'Adoption evidence unknown' },
};
