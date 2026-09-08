import type { DataSyncState } from '../../context/AppContextCore';
import './candidate-promotion-gaps.css';

type Scorecard = NonNullable<NonNullable<DataSyncState['modelEvaluation']>['publicScorecard']>;
type Candidate = NonNullable<NonNullable<Scorecard['shadowTracks']>['CANDIDATE_PROSPECTIVE']>;
type Props = { candidate?: Candidate | null; language: 'zh' | 'en' };
type GateState = 'met' | 'unmet' | 'unknown';
type GateRow = { id: string; label: string; current: string; required: string; gap: string; state: GateState };

// Presentation of the existing frozen policy, never an admission decision.
// The targeted verifier binds these numbers to candidateProspectiveLedger.cjs.
const POLICY = { settled: 500, finalized: 500, windows: 6, winningWindows: 5, rowsPerWindow: 50,
  windowDays: 30, invalidShare: 0.05, singleAttestorShare: 0.3, reviewInterval: 100 };
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const ratio = (value: unknown) => { const n = finite(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
const decimal = (n: number) => n === 0 ? '0' : Math.abs(n) < 0.0001 ? n.toExponential(2) : String(Number(n.toFixed(6)));
const percent = (n: number) => `${decimal(n * 100)}%`;
const strictInstant = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (parts[7] !== 'Z' && (Number(parts[8]) > 14 || Number(parts[9]) > 59
    || (Number(parts[8]) === 14 && Number(parts[9]) !== 0))) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
};

export function CandidatePromotionGaps({ candidate, language }: Props) {
  const zh = language === 'zh', text = (cn: string, en: string) => zh ? cn : en;
  const pending = text('待证据', 'Evidence pending'), formal = candidate?.cohort?.formal, metrics = candidate?.metrics;
  const blockers = Array.isArray(candidate?.blockers) ? candidate.blockers.filter((value): value is string => typeof value === 'string' && value.length > 0) : null;
  const rows: GateRow[] = [];
  const minimum = (id: string, label: string, value: unknown, target: number, exact = false) => {
    const n = count(value), met = n !== null && (exact ? n === target : n >= target);
    rows.push({ id, label, current: n === null ? '—' : String(n), required: `${exact ? '=' : '≥'} ${target}`,
      state: n === null ? 'unknown' : met ? 'met' : 'unmet',
      gap: n === null ? pending : met ? text('数量条件已达到', 'Count condition met')
        : n < target ? text(`还缺 ${target - n}`, `${target - n} more needed`)
          : text(`多出 ${n - target}，需核对预注册范围`, `${n - target} excess; reconcile registration`) });
  };
  minimum('settled', text('有效官方前瞻结算', 'Valid official prospective settlements'), formal?.settled, POLICY.settled);
  minimum('finalized', text('前瞻已定案总数', 'Finalized prospective records'), formal?.finalized, POLICY.finalized);
  minimum('registered-windows', text('预注册窗口数', 'Preregistered windows'), metrics?.registeredCalendarWindows, POLICY.windows, true);
  minimum('winning-windows', text('双指标优于同组基准的胜窗', 'Windows beating the paired baseline on both metrics'), metrics?.winningCalendarWindows, POLICY.winningWindows);
  const windowGate = metrics?.calendarWindowGatePassed;
  rows.push({ id: 'window-integrity', label: text('窗口综合门槛（样本、胜窗与归属）', 'Combined window gate (samples, wins and assignment)'),
    current: typeof windowGate === 'boolean' ? text(windowGate ? '后端综合检查通过' : '后端综合检查未通过', windowGate ? 'Server combined check passed' : 'Server combined check not passed') : '—',
    required: text(`${POLICY.windows} 个 ${POLICY.windowDays} 天窗口，每窗 ≥ ${POLICY.rowsPerWindow} 条；≥ ${POLICY.winningWindows} 个胜窗；窗口不重叠且全部行唯一归属`,
      `${POLICY.windows} × ${POLICY.windowDays}-day windows; ≥ ${POLICY.rowsPerWindow} rows each; ≥ ${POLICY.winningWindows} winning windows; no overlap and every row assigned exactly once`),
    state: typeof windowGate !== 'boolean' ? 'unknown' : windowGate ? 'met' : 'unmet',
    gap: text(`有样本窗口 ${count(metrics?.calendarWindows) ?? '—'}；接口未提供逐窗条数和边界，不能计算每窗还缺几条。`,
      `Non-empty windows: ${count(metrics?.calendarWindows) ?? '—'}. Per-window counts and boundaries are not supplied; individual deficits cannot be calculated.`) });
  const pairedRows = count(metrics?.formalRows);
  for (const [id, label, value] of [
    ['log-loss-lower', 'Log Loss', metrics?.adjustedLogLossLowerBound],
    ['brier-lower', 'Brier', metrics?.adjustedBrierLowerBound],
  ] as const) {
    const n = pairedRows !== null && pairedRows > 0 ? finite(value) : null;
    rows.push({ id, label: text(`${label} 校正后置信下界`, `${label} adjusted confidence lower bound`),
      current: n === null ? '—' : decimal(n), required: '> 0', state: n === null ? 'unknown' : n > 0 ? 'met' : 'unmet',
      gap: n === null ? text('缺少有效配对样本或校正下界', 'Valid paired samples or adjusted lower bound unavailable')
        : n > 0 ? text('此项下界为正，仍须满足其余条件', 'This lower bound is positive; other gates still apply')
          : n === 0 ? text('必须严格转正；等于零仍不达标', 'Must be strictly positive; zero does not pass')
            : text(`需提高超过 ${decimal(-n)} 才能转正`, `Must improve by more than ${decimal(-n)} to become positive`) });
  }
  for (const [id, label, value, denominator, maximum, blocker] of [
    ['invalid-share', text('无效记录占比', 'Invalid-record share'), metrics?.invalidShare, formal?.finalized, POLICY.invalidShare, 'invalid-share-above-preregistered-limit'],
    ['single-attestor-share', text('单一证明方标记占比', 'Single-attestor share'), metrics?.singleAttestorShare, formal?.admitted, POLICY.singleAttestorShare, 'single-attestor-share-above-preregistered-limit'],
  ] as const) {
    const total = count(denominator), n = total !== null && total > 0 ? ratio(value) : null;
    // Public ratios are rounded to six places, while the server gates raw ratios.
    // Do not infer an exact numerator or let a rounded value override a blocker.
    const blocked = blockers?.includes(blocker) === true;
    rows.push({ id, label, current: n === null ? '—' : percent(n), required: `≤ ${percent(maximum)}`,
      state: blocked ? 'unmet' : n === null || n === maximum ? 'unknown' : n < maximum ? 'met' : 'unmet',
      gap: blocked ? text('后端公开阻断项判定超过上限；已舍入比例不能覆盖该结论，也不能据此计算精确差额。',
        'A public server blocker reports this limit exceeded; the rounded ratio cannot override it or establish an exact deficit.')
        : n === null ? text('分母或比例未提供；零样本不记作 0%', 'Denominator or ratio unavailable; zero samples are not 0%')
          : n === maximum ? text('公开比例已舍入且位于上限；缺少精确比值，待证据，不能据此认定达标。',
            'The rounded public ratio is at the limit; the exact ratio is unavailable, so this condition remains evidence pending.')
            : n < maximum ? text('公开比例低于上限；仅解释此项，不替代后台完整评审', 'The public ratio is below the limit; this condition does not replace full server review')
          : text(`超出 ${decimal((n - maximum) * 100)} 个百分点；未来样本需求不能预估`, `${decimal((n - maximum) * 100)} percentage points over; future sample needs are unknown`) });
  }
  const booleanRow = (id: string, label: string, value: unknown, requirement: string) => rows.push({ id, label,
    current: value === true ? text('已核验', 'Verified') : value === false ? text('未通过', 'Not passed') : '—', required: requirement,
    state: value === true ? 'met' : value === false ? 'unmet' : 'unknown', gap: value === true ? text('仅此项已核验', 'This condition only is verified') : pending } as GateRow);
  booleanRow('hash-chain', text('候选账本哈希链', 'Candidate ledger hash chain'), candidate?.chainValid, text('完整有效', 'Valid and complete'));
  booleanRow('denominator', text('前瞻分母对账', 'Prospective denominator reconciliation'), formal?.denominatorReconciled, text('对账一致', 'Reconciled'));
  const activationAt = strictInstant(candidate?.activationAt), frozenAt = strictInstant(candidate?.frozenAt);
  const activated = activationAt !== null && frozenAt !== null && activationAt >= frozenAt;
  rows.push({ id: 'activation', label: text('冻结后的前瞻激活', 'Post-freeze prospective activation'), current: activated ? candidate!.activationAt! : '—',
    required: text('有效激活时间 ≥ 有效冻结时间', 'Valid activation time ≥ valid freeze time'), state: activated ? 'met' : 'unknown',
    gap: activated ? text('仅证明登记时间顺序，不代表可给客户推荐', 'Recorded time order only, not customer-pick authorization')
      : text('冻结或激活时间缺失、非法或顺序未核验；影子样本不补入前瞻分母', 'Freeze or activation time is missing, invalid or out of order; shadow rows cannot backfill the prospective cohort') });
  rows.push({ id: 'integrity-detail', label: text('身份、时钟、来源明细', 'Identity, clock and source details'), current: '—',
    required: text('全部完整性条件通过', 'All integrity conditions pass'), state: 'unknown',
    gap: text('公开接口未提供逐项量化明细；哈希链正常不能替代这些检查。请同时查看下方后端阻断项。',
      'Per-condition details are not public. A valid hash chain cannot replace these checks; also inspect the server blockers below.') });
  rows.push({ id: 'review-checkpoint', label: text('固定检查点评审', 'Fixed-checkpoint review'), current: '—',
    required: text(`首次 ${POLICY.settled} 条，随后每增 ${POLICY.reviewInterval} 条`, `First ${POLICY.settled} rows, then every ${POLICY.reviewInterval}`), state: 'unknown',
    gap: text('接口未提供上次评审检查点；无法计算距离下一次评审的条数，不据当前样本自动触发评审。',
      'Last reviewed checkpoint is not supplied. The next review deficit is unknown; counts never trigger a review here.') });
  const serverFlag = (value: unknown) => value === true ? text('是', 'Yes') : value === false ? text('否', 'No') : pending;
  return <details className="candidate-promotion-gaps" data-testid="candidate-promotion-gaps">
    <summary><strong>{text('晋级条件 · 还缺什么', 'Promotion conditions · Remaining gaps')}</strong>
      <span>{text(`未达标 ${rows.filter(row => row.state === 'unmet').length} 项 · 待证据 ${rows.filter(row => row.state === 'unknown').length} 项`,
        `${rows.filter(row => row.state === 'unmet').length} unmet · ${rows.filter(row => row.state === 'unknown').length} awaiting evidence`)}</span></summary>
    <p className="candidate-promotion-gaps__notice">{text('内部冻结候选前瞻，不是客户正式推荐。市场赔率是同组比较基准，不是独立模型优势；平均改善为正也不能代替校正下界通过。',
      'Internal frozen-candidate evidence, not customer formal picks. Market odds are the paired baseline, not independent model advantage; positive average improvement does not replace adjusted lower bounds.')}</p>
    <p data-candidate-server-status>{text('后端报告', 'Server reports')}：{text('可进入晋级复核', 'Ready for promotion review')} {serverFlag(candidate?.promotionReviewReady)} · {text('正式晋级评审资格', 'Formal promotion eligibility')} {serverFlag(candidate?.formalPromotionEligible)}。
      {text('本表只解释条件，不覆盖候选状态，不自动上线。', 'This table explains conditions only; it never overrides candidate state or deploys a model.')}</p>
    <div className="candidate-promotion-gaps__grid">{rows.map(row => <article key={row.id} data-candidate-gate={row.id} data-gate-state={row.state}>
      <div className="candidate-promotion-gaps__row-heading"><h4>{row.label}</h4><span className={`candidate-promotion-gaps__badge is-${row.state}`}>
        {row.state === 'met' ? text('此项达标', 'Condition met') : row.state === 'unmet' ? text('未达标', 'Unmet') : pending}</span></div>
      <dl><div><dt>{text('当前', 'Current')}</dt><dd>{row.current}</dd></div><div><dt>{text('要求', 'Required')}</dt><dd>{row.required}</dd></div></dl><p>{row.gap}</p>
    </article>)}</div>
    <section className="candidate-promotion-gaps__blockers" data-candidate-blockers>
      <h4>{text('后端公开阻断项', 'Public server blockers')}</h4>
      <p>{text('接口最多提供 24 项，不是完整原始审计；空列表也不能据此认定晋级。', 'The API provides at most 24 items, not the complete raw audit; an empty list does not establish promotion.')}</p>
      {blockers?.length ? <ul>{blockers.map((blocker, index) => <li key={`${index}:${blocker}`}><code>{blocker}</code></li>)}</ul>
        : <p>{blockers === null ? pending : text('当前公开列表为空，仍以后台评审状态和完整证据为准。', 'Public list is empty; server review state and complete evidence still govern.')}</p>}
    </section>
  </details>;
}
