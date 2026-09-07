import type { Match } from './mockData';
import { compactApiFootballDiagnostics } from 'football-collector-diagnostics';

// Deliberately separate from getDataAdoptionReport: current collector records
// cannot change a frozen decision's rows, totals, direction or evidence hash.
export const getCollectorDiagnostics = (match: Match) => compactApiFootballDiagnostics(match.externalSignals);

export type AdoptionState = 'available-not-adopted' | 'not-yet-published' | 'missing' | 'unknown' | 'stale' | 'conflicting' | 'unverified' | 'after-decision';
const FAMILIES = [
  ['officialOdds', '官方赔率', 'Official odds'], ['externalMarket', '外部市场', 'External market'],
  ['homeForm', '主队近期', 'Home form'], ['awayForm', '客队近期', 'Away form'], ['elo', '球队实力', 'Team strength'],
  ['standings', '积分排名', 'Standings'], ['lineup', '首发阵容', 'Lineup'],
  ['injuries', '伤停信息', 'Injuries'], ['xg', '预期进球', 'Expected goals'],
  ['weather', '天气场地', 'Weather'], ['referee', '裁判数据', 'Referee'],
  ['teamCards', '球队牌数', 'Team cards'],
] as const;
const object = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const clock = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)
    ? `${value.replace(' ', 'T')}+08:00` : value;
  // Date.parse normalizes impossible dates (e.g. February 30). Only accept
  // real calendar dates and explicit zones, apart from the Beijing legacy form.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] || '0'].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (parts[8] !== 'Z' && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4, 6)) > 59)) return null;
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 160) : null;
const formResultEvidence = (value: unknown, samples: number | null) => {
  const evidence = object(value);
  if (!evidence || evidence.version !== 'recent-form-result-evidence-v1' || evidence.sourceVerified !== false
    || typeof evidence.selectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.selectionHash) || samples === null) return null;
  const keys = ['sampleRows', 'homeRows', 'awayRows', 'observedRows', 'missingObservedAtRows', 'missingSourceRows', 'beforeKickoffRows', 'afterDecisionRows'] as const;
  if (keys.some(key => count(evidence[key]) === null)) return null;
  const counts = Object.fromEntries(keys.map(key => [key, count(evidence[key])])) as Record<typeof keys[number], number>;
  const latestObservedAt = clock(evidence.latestObservedAt);
  const decisionAt = clock(evidence.decisionAt);
  if (counts.sampleRows !== samples || counts.homeRows + counts.awayRows !== samples
    || counts.observedRows + counts.missingObservedAtRows !== samples || keys.some(key => counts[key] > samples)
    || (counts.observedRows > 0 && !latestObservedAt) || (counts.observedRows === 0 && latestObservedAt)) return null;
  const content = object(evidence.contentObservation);
  const received = count(content?.receivedRows); const missing = count(content?.missingReceiptRows);
  const late = count(content?.afterDecisionRows); const latestReceiptAt = clock(content?.latestFirstObservedAt);
  const receiptDecisionAt = clock(content?.decisionAt);
  const contentObservation = content?.version === 'recent-form-content-receipt-summary-v1' && content.scope === 'local-content-receipt-only'
    && content.sourceVerified === false && content.sampleRows === samples && received !== null && received > 0 && missing !== null
    && received + missing === samples && late !== null && late <= received && latestReceiptAt && receiptDecisionAt
    && Date.parse(receiptDecisionAt) === (decisionAt ? Date.parse(decisionAt) : NaN)
    && (Date.parse(latestReceiptAt) > Date.parse(receiptDecisionAt)) === (late > 0)
    ? { receivedRows: received, missingReceiptRows: missing, afterDecisionRows: late, latestFirstObservedAt: latestReceiptAt, decisionAt: receiptDecisionAt } : null;
  return { ...counts, latestObservedAt, decisionAt, contentObservation };
};

/** Presence is not a model-usage receipt. Never infer adoption from connected=true. */
export function getDataAdoptionReport(match: Match) {
  const record = match.predictionMeta?.publicReferenceDecision;
  const frozen = record?.integrityVerified === true ? record : null;
  // Invalid public records cannot silently fall back to a current model.
  const gaps = object(frozen ? frozen.dataGaps : record ? null : match.predictionMeta?.decisionDataGaps);
  const connected = object(gaps?.connected);
  const components = object(object(gaps?.preMatchQuality)?.components);
  const summaries = frozen?.evidenceBinding ? object(gaps?.inputSummaries) : null;
  const usage = frozen?.evidenceBinding ? object(gaps?.calculationUsage) : null;
  const calculationRows = usage?.version === 'model-input-usage-v1' && usage.scope === 'base-calculation-only'
    && usage.sourceVerified === false && Array.isArray(usage.rows) ? usage.rows.map(object).filter((r): r is Record<string, unknown> => !!r)
      .filter(r => typeof r.weight === 'number' && Number.isFinite(r.weight) && r.weight >= 0 && r.weight <= 1
        && typeof r.used === 'boolean' && r.used === (r.weight > 0) && typeof r.receiptHash === 'string' && /^[a-f0-9]{64}$/.test(r.receiptHash)
        && ['base-outcome-blend', 'form-lambda-blend'].includes(String(r.stage)))
      .map(r => ({ key: String(r.key), stage: String(r.stage), used: r.used as boolean, weight: r.weight as number,
        receiptHash: String(r.receiptHash), poolCode: text(r.poolCode), source: text(r.source), fallbackMetrics: count(r.fallbackMetrics) })) : [];
  const asOf = clock(frozen?.decisionAt || (!record ? match.predictionMeta?.decisionGeneratedAt || match.predictionMeta?.generatedAt : null));
  const rows = FAMILIES.map(([key, zh, en]) => {
    // Combined market/motivation components cannot attest either individual source.
    const component = object(components?.[key]);
    const status = component?.availabilityState || component?.status;
    let state: AdoptionState = 'unknown';
    let reason = 'usage-not-recorded';
    let observedAt = clock(component?.sourceObservedAt);
    let sampleSize: number | null = null;
    let resultObservation: ReturnType<typeof formResultEvidence> = null;
    let source = text(component?.source);
    if (status === 'conflicting' || status === 'conflict') { state = 'conflicting'; reason = 'source-conflict'; }
    else if (observedAt && asOf && Date.parse(observedAt) > Date.parse(asOf)) { state = 'after-decision'; reason = 'after-decision'; }
    else if (status === 'published_after_cutoff') { state = 'after-decision'; reason = 'after-decision'; }
    else if (status === 'not_yet_publishable') { state = 'not-yet-published'; reason = 'publication-window'; }
    else if (status === 'stale') { state = 'stale'; reason = 'source-stale'; }
    else if (['stale_or_unverified', 'estimated_pre_cutoff', 'estimated', 'partial'].includes(String(status))) { state = 'unverified'; reason = 'source-unverified'; }
    else if (status === 'missing' || status === 'missing_overdue') { state = 'missing'; reason = 'missing-at-decision'; }
    else if (status === 'verified_pre_cutoff' || status === 'verified') {
      state = observedAt && asOf ? 'available-not-adopted' : 'unverified';
      reason = observedAt && asOf ? 'usage-not-recorded' : 'clock-missing';
    } else if (connected?.[key] === true) { state = 'unverified'; reason = 'connected-only'; }
    else if (connected?.[key] === false) { state = 'missing'; reason = 'missing-at-decision'; }
    const sourceState = state;
    const sourceReason = reason;
    if (key === 'homeForm' || key === 'awayForm') {
      const form = object(summaries?.form);
      const side = object(form?.[key === 'homeForm' ? 'home' : 'away']);
      sampleSize = count(side?.sampleSize); observedAt = clock(side?.lastMatchAt); source = text(form?.source);
      resultObservation = formResultEvidence(side?.resultEvidence, sampleSize);
      if (sampleSize === 0) { state = 'missing'; reason = 'zero-samples'; }
      else if (sampleSize !== null && sampleSize > 0) {
        state = 'unverified'; reason = 'history-receipt-unverified';
        if (observedAt && asOf && Date.parse(observedAt) >= Date.parse(asOf)) { state = 'after-decision'; reason = 'after-decision'; }
        else if (observedAt && asOf && Date.parse(asOf) - Date.parse(observedAt) > 60 * 86400000) { state = 'stale'; reason = 'aged-history'; }
        if (resultObservation?.afterDecisionRows || (asOf && resultObservation?.latestObservedAt && Date.parse(resultObservation.latestObservedAt) > Date.parse(asOf))
          || (asOf && resultObservation?.decisionAt && Date.parse(resultObservation.decisionAt) > Date.parse(asOf))) { state = 'after-decision'; reason = 'after-decision'; }
        else if (resultObservation?.beforeKickoffRows) { state = 'conflicting'; reason = 'result-clock-conflict'; }
        else if (state === 'unverified' && resultObservation?.missingObservedAtRows) reason = 'result-clock-missing';
        if (resultObservation?.contentObservation && (resultObservation.contentObservation.afterDecisionRows > 0
          || (asOf && Date.parse(resultObservation.contentObservation.latestFirstObservedAt) > Date.parse(asOf))) && state !== 'conflicting') {
          state = 'after-decision'; reason = 'after-decision';
        }
      }
    }
    if (key === 'elo') {
      const elo = object(summaries?.elo);
      const home = count(elo?.homeMatches); const away = count(elo?.awayMatches); source = text(elo?.source);
      if (home === 0 || away === 0) { state = 'missing'; reason = 'zero-samples'; }
      else if (home !== null && away !== null) { state = 'unverified'; reason = 'usage-not-recorded'; }
    }
    // Sample presence cannot erase a source conflict, late observation or stale
    // source. More specific adverse history evidence can still strengthen it.
    const adversePriority = (value: AdoptionState) => value === 'conflicting' ? 3 : value === 'after-decision' ? 2 : value === 'stale' ? 1 : 0;
    if (adversePriority(sourceState) > adversePriority(state)) { state = sourceState; reason = sourceReason; }
    if (calculationRows.some(row => row.key === key) && ['usage-not-recorded', 'connected-only'].includes(reason)) reason = 'base-usage-recorded';
    return { key, zh, en, state, reason, observedAt, sampleSize, source, resultObservation };
  });
  return { rows, calculationRows, asOf, bound: !!frozen, referenceHash: frozen?.contentHash || null, modelVersion: frozen?.evidenceBinding?.modelVersion || null };
}
export const getDataAdoptionFacts = (match: Match) => getDataAdoptionReport(match).rows;

export const adoptionLabel: Record<AdoptionState, { zh: string; en: string }> = {
  'available-not-adopted': { zh: '有证据 · 采用未证实', en: 'Evidence present · usage unconfirmed' },
  'not-yet-published': { zh: '当时尚未公布', en: 'Not published at decision' },
  missing: { zh: '本版缺失', en: 'Missing in decision' },
  unknown: { zh: '本版未记录', en: 'Not recorded' },
  stale: { zh: '陈旧数据', en: 'Aged data' },
  conflicting: { zh: '来源冲突', en: 'Source conflict' },
  unverified: { zh: '采用未核验', en: 'Usage unverified' },
  'after-decision': { zh: '晚于决策 · 不可回填', en: 'After decision · no backfill' },
};

export const adoptionReason: Record<string, { zh: string; en: string }> = {
  'result-clock-missing': { zh: '部分近期赛果没有观测时间，不能证明决策时已收到。', en: 'Some recent results have no observation clock; receipt by decision time is unproven.' },
  'result-clock-conflict': { zh: '赛果观测时间不晚于开赛或开赛时间缺失，时序证据冲突。', en: 'Result observation is not after kickoff, or kickoff is missing; temporal evidence conflicts.' },
  'base-usage-recorded': { zh: '基础计算使用已记录；来源质量与最终决策贡献仍需核验。', en: 'Base usage recorded; source quality and final-decision contribution remain unverified.' },
  'usage-not-recorded': { zh: '缺少模型实际采用回执，不计为已采用。', en: 'No model usage receipt; not counted as adopted.' },
  'source-conflict': { zh: '需核对赛事与来源，不能任选一个值。', en: 'Resolve event and source conflicts first.' },
  'after-decision': { zh: '数据晚于本次决策，不能补作赛前证据。', en: 'Later data cannot become evidence for this decision.' },
  'publication-window': { zh: '未到正常公布窗口，不等于采集故障。', en: 'Before publication window; not a collection failure.' },
  'source-stale': { zh: '需重新核验来源时效。', en: 'Revalidate source freshness.' },
  'source-unverified': { zh: '来源为估算、过期或未完成核验。', en: 'Estimated, stale or unverified source.' },
  'missing-at-decision': { zh: '当时未取得，不等于真实值为零。', en: 'Unavailable then; not a real-world zero.' },
  'clock-missing': { zh: '缺少观测时间或决策时间。', en: 'Observation or decision clock missing.' },
  'connected-only': { zh: '仅有接通标记，不能证明参与计算。', en: 'Connection flag does not prove use in calculation.' },
  'zero-samples': { zh: '缺少可核验样本，不能据此确认状态分有效。', en: 'No auditable samples; cannot validate a form score.' },
  'history-receipt-unverified': { zh: '有历史样本，但赛果首次收到时间与采用链路未确认。', en: 'History exists; result receipt time and usage unconfirmed.' },
  'aged-history': { zh: '最近比赛距决策超过 60 天；仅标记陈旧，不在页面改动模型权重。', en: 'Over 60 days old; this label does not change model weights.' },
};
