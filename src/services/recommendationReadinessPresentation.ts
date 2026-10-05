import type { Decision, SelectionQuality } from './recommendationCenterView';

// Read-only presentation of an existing service record. This never evaluates
// promotion gates, creates a recommendation or changes a frozen probability.
// The current Decision contract carries no positive formal-promotion receipt.
export function recommendationReadinessPresentation(
  decision: Decision | null,
  quality: SelectionQuality | null | undefined,
  language: 'zh' | 'en',
) {
  const zh = language === 'zh';
  const labels: Record<string, [string, string]> = {
    'input-evidence-unavailable': ['本次模型输入依据尚未完整存档', 'Model input evidence is not fully archived'],
    'input-arithmetic-unverified': ['本次模型输入计算尚未核验', 'Model input arithmetic is unverified'],
    'team-samples-insufficient': ['实际参与模型的球队样本不足', 'Too few team samples in the active model'],
    'model-lead-too-thin': ['首位与第二方向差距较小', 'The lead over the second outcome is narrow'],
    'material-model-market-disagreement': ['模型与同期市场概率明显分歧', 'The model materially disagrees with the same-time market'],
    'cross-track-direction-conflict': ['同场已核验赛前方向存在冲突', 'Verified pre-match directions conflict'],
    'direction-override-mismatch': ['方向选择记录尚待核对', 'Direction-selection records need verification'],
  };
  const generic = zh ? '还有参考资格限制待核验' : 'Additional reference restrictions need verification';
  const reasons = !decision
    ? [zh ? '当前尚无统一发布记录；资料到达后更新' : 'No unified publication is available; awaiting its recorded evidence']
    : !quality
      ? [zh ? '单场参考资格尚未提供' : 'Single-reference qualification has not been supplied']
      : [...new Set(quality.reasons.map(reason => labels[reason]?.[zh ? 0 : 1] || generic))];
  return {
    stage: decision ? 'analysis-reference' : 'waiting-for-data',
    label: decision ? (zh ? '分析参考' : 'Analysis reference') : (zh ? '等待资料' : 'Waiting for data'),
    formalStatus: decision?.modelValidation === 'unvalidated' ? 'model-unvalidated' : 'not-provided',
    formalLabel: decision?.modelValidation === 'unvalidated'
      ? (zh ? '尚未通过模型验证' : 'Model validation pending')
      : (zh ? '正式资格未提供' : 'Formal qualification unavailable'),
    reasons,
    referencePassed: Boolean(decision && quality?.status === 'reference-qualified' && quality.qualified && !reasons.length),
    nextStep: !decision
      ? (zh ? '等待发布记录；其他参考资料见各自区块。' : 'Awaiting publication; other reference material remains in its own section.')
      : (zh ? '查看冻结赔率及资料缺口；新资料须经新决策采用。'
        : 'Check frozen prices and evidence gaps; new data requires a new decision.'),
  };
}
