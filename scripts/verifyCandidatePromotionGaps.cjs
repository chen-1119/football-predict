'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./lib/loadReviewTsForVerification.cjs');
const root = path.resolve(__dirname, '..');

// Synthetic-only UI fixture. Not a live candidate, research result or admission proof.
const createSyntheticCandidatePromotionFixture = () => ({ syntheticOnly: true,
  candidateRevisionId: 'synthetic-promotion-gap-fixture', evaluatedAt: '2026-09-08T00:00:00.000Z',
  state: 'ACTIVE', frozenAt: '2026-09-06T00:00:00.000Z', activationAt: '2026-09-07T00:00:00.000Z', chainValid: true,
  promotionReviewReady: false, formalPromotionEligible: false, blockers: ['fixture-other-gate-pending'],
  cohort: { formal: { settled: 500, finalized: 520, admitted: 510, denominatorReconciled: true } },
  metrics: { formalRows: 500, logLossImprovement: .1, brierImprovement: .1,
    adjustedLogLossLowerBound: .01, adjustedBrierLowerBound: .02,
    invalidShare: .02, singleAttestorShare: .2, registeredCalendarWindows: 6,
    calendarWindows: 6, winningCalendarWindows: 5, requiredWinningCalendarWindows: 5, calendarWindowGatePassed: true } });

function verifyCandidatePromotionGaps({ onlyCases } = {}) {
  if (onlyCases !== undefined) {
    assert.ok(Array.isArray(onlyCases) && onlyCases.length > 0, 'onlyCases must be a nonempty array');
    assert.ok(onlyCases.every(name => typeof name === 'string' && name.length > 0), 'onlyCases names must be nonempty strings');
    assert.equal(new Set(onlyCases).size, onlyCases.length, 'onlyCases must not contain duplicates');
  }
  const started = process.hrtime.bigint(), checks = [], cases = [];
  const check = (name, action) => { cases.push({ name, action }); };
  const { CandidatePromotionGaps } = load(ts, path.join(root, 'src/components/predictions/CandidatePromotionGaps.tsx'));
  const base = createSyntheticCandidatePromotionFixture;
  const render = (candidate, language = 'zh') => renderToStaticMarkup(React.createElement(CandidatePromotionGaps, { candidate, language }));
  const row = (html, id) => {
    const match = new RegExp('<article[^>]*data-candidate-gate="' + id + '"[\\s\\S]*?</article>').exec(html);
    assert.ok(match, 'missing rendered gate: ' + id); return match[0];
  };
  const state = (html, id, expected) => assert.ok(row(html, id).includes('data-gate-state="' + expected + '"'), id + ': ' + expected);
  const current = (html, id) => { const found = /<dt>当前<\/dt><dd>([\s\S]*?)<\/dd>/.exec(row(html, id)); assert.ok(found); return found[1]; };
  check('missing public candidate renders all 14 conditions without zero or neutral current-value backfill', () => {
    const html = render(null);
    assert.equal((html.match(/data-candidate-gate=/g) || []).length, 14);
    assert.equal((html.match(/data-gate-state="unknown"/g) || []).length, 14);
    assert.equal((html.match(/<dt>当前<\/dt><dd>—<\/dd>/g) || []).length, 14);
    assert.ok(html.includes('待证据')); assert.equal(html.includes('data-gate-state="met"'), false);
  });
  check('known zero cohorts show count deficits but no observed 0 percent ratios or calibrated bounds', () => {
    const value = base(); value.cohort.formal = { settled: 0, finalized: 0, admitted: 0 };
    value.metrics = { formalRows: 0, invalidShare: 0, singleAttestorShare: 0, registeredCalendarWindows: 0, winningCalendarWindows: 0 };
    const html = render(value); assert.ok(row(html, 'settled').includes('还缺 500'));
    for (const id of ['invalid-share', 'single-attestor-share', 'log-loss-lower', 'brier-lower']) { state(html, id, 'unknown'); assert.equal(current(html, id), '—'); }
  });
  check('actual numeric gaps use valid counts and never merge exclusions into valid settlements', () => {
    const value = base(); Object.assign(value.cohort.formal, { settled: 123, finalized: 200, invalid: 77 });
    Object.assign(value.metrics, { registeredCalendarWindows: 4, winningCalendarWindows: 2 });
    const html = render(value);
    for (const [id, gap] of [['settled', 377], ['finalized', 300], ['registered-windows', 2], ['winning-windows', 3]]) assert.ok(row(html, id).includes('还缺 ' + gap));
  });
  check('registration must equal six, not just exceed it', () => {
    const value = base(); value.metrics.registeredCalendarWindows = 7;
    const html = render(value); state(html, 'registered-windows', 'unmet'); assert.ok(row(html, 'registered-windows').includes('多出 1'));
  });
  check('positive average improvement does not pass negative adjusted lower bounds', () => {
    const value = base(); value.metrics.adjustedLogLossLowerBound = -.03; value.metrics.adjustedBrierLowerBound = -.02;
    const html = render(value); state(html, 'log-loss-lower', 'unmet'); state(html, 'brier-lower', 'unmet');
    assert.ok(row(html, 'log-loss-lower').includes('需提高超过 0.03')); assert.ok(html.includes('平均改善为正也不能代替校正下界通过'));
  });
  check('zero lower bound is not positive and tiny positive values do not display as zero', () => {
    const value = base(); value.metrics.adjustedLogLossLowerBound = 0; value.metrics.adjustedBrierLowerBound = 1e-7;
    const html = render(value); state(html, 'log-loss-lower', 'unmet'); state(html, 'brier-lower', 'met');
    assert.ok(row(html, 'log-loss-lower').includes('等于零仍不达标')); assert.equal(current(html, 'brier-lower'), '1.00e-7');
  });
  check('missing and malformed adjusted bounds are evidence pending rather than coerced numbers', () => {
    for (const bad of [null, undefined, NaN, Infinity, false, '', '0.1']) {
      const value = base(); value.metrics.adjustedLogLossLowerBound = bad;
      const html = render(value); state(html, 'log-loss-lower', 'unknown'); assert.equal(current(html, 'log-loss-lower'), '—');
    }
  });
  check('positive bound payload without actual paired rows cannot certify the condition', () => {
    for (const rows of [0, undefined, null, -1, '500']) {
      const value = base(); value.metrics.formalRows = rows; const html = render(value);
      state(html, 'log-loss-lower', 'unknown'); state(html, 'brier-lower', 'unknown');
    }
  });
  check('rounded ratio equality remains evidence pending while visible excess is expressed in percentage points', () => {
    const value = base(); value.metrics.invalidShare = .05; value.metrics.singleAttestorShare = .3;
    const boundary = render(value); state(boundary, 'invalid-share', 'unknown'); state(boundary, 'single-attestor-share', 'unknown');
    for (const id of ['invalid-share', 'single-attestor-share']) assert.ok(row(boundary, id).includes('公开比例已舍入且位于上限'));
    value.metrics.invalidShare = .07; value.metrics.singleAttestorShare = .35;
    const excess = render(value); state(excess, 'invalid-share', 'unmet'); state(excess, 'single-attestor-share', 'unmet');
    assert.ok(row(excess, 'invalid-share').includes('超出 2 个百分点')); assert.ok(row(excess, 'single-attestor-share').includes('超出 5 个百分点'));
  });
  check('actual six-place ratio rounding cannot turn raw over-limit records into passing conditions', () => {
    const value = base(), invalidRaw = 100001 / 2000001, singleRaw = 900001 / 3000001;
    assert.ok(invalidRaw > .05); assert.ok(singleRaw > .3);
    Object.assign(value.cohort.formal, { invalid: 100001, finalized: 2000001, admitted: 3000001 });
    Object.assign(value.metrics, { invalidShare: Number(invalidRaw.toFixed(6)), singleAttestorShare: Number(singleRaw.toFixed(6)) });
    assert.equal(value.metrics.invalidShare, .05); assert.equal(value.metrics.singleAttestorShare, .3);
    const unknown = render(value);
    state(unknown, 'invalid-share', 'unknown'); state(unknown, 'single-attestor-share', 'unknown');
    assert.equal(current(unknown, 'invalid-share'), '5%'); assert.equal(current(unknown, 'single-attestor-share'), '30%');
    // Invalid counts are not used to manufacture a different precision contract.
    for (const invalid of [undefined, null, -1, '100001', 2000002]) {
      value.cohort.formal.invalid = invalid; state(render(value), 'invalid-share', 'unknown');
    }
    value.blockers = ['invalid-share-above-preregistered-limit', 'single-attestor-share-above-preregistered-limit'];
    const blocked = render(value);
    for (const id of ['invalid-share', 'single-attestor-share']) {
      state(blocked, id, 'unmet'); assert.ok(row(blocked, id).includes('已舍入比例不能覆盖该结论'));
      assert.equal(row(blocked, id).includes('此项达标'), false);
    }
    assert.ok(row(render(value, 'en'), 'invalid-share').includes('public server blocker'));
  });
  check('each public ratio blocker vetoes a passing display without inventing missing ratios or affecting the other gate', () => {
    for (const [id, blocker] of [['invalid-share', 'invalid-share-above-preregistered-limit'],
      ['single-attestor-share', 'single-attestor-share-above-preregistered-limit']]) {
      const value = base(); value.blockers = [blocker];
      const other = id === 'invalid-share' ? 'single-attestor-share' : 'invalid-share';
      state(render(value), id, 'unmet'); state(render(value), other, 'met');
      value.cohort.formal = { finalized: 0, admitted: 0 };
      const empty = render(value); state(empty, id, 'unmet'); assert.equal(current(empty, id), '—');
      state(empty, other, 'unknown'); assert.equal(row(empty, id).includes('此项达标'), false);
    }
  });
  check('each ratio checks its own denominator and rejects malformed values', () => {
    const value = base(); delete value.cohort.formal.admitted;
    state(render(value), 'single-attestor-share', 'unknown'); state(render(value), 'invalid-share', 'met');
    for (const bad of [-1, 2, NaN, false, null, '0']) {
      const next = base(); next.metrics.invalidShare = bad; state(render(next), 'invalid-share', 'unknown');
    }
  });
  check('invalid count representations remain unknown rather than zero', () => {
    for (const bad of [-1, 1.5, false, '500', NaN, null]) { const value = base(); value.cohort.formal.settled = bad; state(render(value), 'settled', 'unknown'); }
  });
  check('six nonempty windows never substitute for six eligible per-window cohorts', () => {
    const value = base(); value.metrics.calendarWindowGatePassed = false;
    const html = render(value); state(html, 'window-integrity', 'unmet');
    assert.ok(row(html, 'window-integrity').includes('有样本窗口 6')); assert.ok(row(html, 'window-integrity').includes('不能计算每窗还缺几条'));
  });
  check('combined backend window check does not manufacture per-window counts or boundaries', () => {
    const html = render(base()); state(html, 'window-integrity', 'met');
    assert.ok(row(html, 'window-integrity').includes('后端综合检查通过')); assert.ok(row(html, 'window-integrity').includes('接口未提供逐窗条数和边界'));
    assert.ok(row(html, 'window-integrity').includes('窗口综合门槛（样本、胜窗与归属）'));
    assert.ok(row(html, 'window-integrity').includes('≥ 5 个胜窗；窗口不重叠且全部行唯一归属'));
    const missing = base(); delete missing.metrics.calendarWindowGatePassed; state(render(missing), 'window-integrity', 'unknown');
  });
  check('six sufficiently sampled nonoverlapping windows with only four wins still fail the combined window gate', () => {
    // These are synthetic private window details, not extra fields asserted to exist in the public API.
    const windows = Array.from({ length: 6 }, (_, index) => ({ rows: 50, winsBothMetrics: index < 4,
      start: index * 30, end: (index + 1) * 30 }));
    assert.ok(windows.every(window => window.rows >= 50));
    assert.ok(windows.every((window, index) => index === 0 || windows[index - 1].end === window.start));
    const value = base(); value.metrics.winningCalendarWindows = windows.filter(window => window.winsBothMetrics).length;
    value.metrics.calendarWindowGatePassed = windows.length === 6 && value.metrics.winningCalendarWindows >= 5;
    const html = render(value); state(html, 'window-integrity', 'unmet'); state(html, 'winning-windows', 'unmet');
    assert.ok(row(html, 'winning-windows').includes('还缺 1'));
    assert.ok(row(html, 'window-integrity').includes('样本、胜窗与归属'));
    assert.ok(row(html, 'window-integrity').includes('≥ 5 个胜窗；窗口不重叠且全部行唯一归属'));
    assert.ok(row(html, 'window-integrity').includes('接口未提供逐窗条数和边界'));
    assert.equal(row(html, 'window-integrity').includes('逐窗样本与不重叠归属'), false);
    assert.ok(row(render(value, 'en'), 'window-integrity').includes('every row assigned exactly once'));
  });
  check('integrity details and last review checkpoint remain explicit evidence gaps even when headline conditions pass', () => {
    const html = render(base()); state(html, 'integrity-detail', 'unknown'); state(html, 'review-checkpoint', 'unknown');
    assert.ok(row(html, 'review-checkpoint').includes('首次 500 条，随后每增 100 条'));
    assert.ok(row(html, 'review-checkpoint').includes('无法计算距离下一次评审'));
  });
  check('hash chain and denominator flags are strict booleans; activation clock must be recorded with a timezone', () => {
    const value = base(); value.chainValid = false; delete value.cohort.formal.denominatorReconciled; value.activationAt = '2026-09-07T00:00:00';
    const html = render(value); state(html, 'hash-chain', 'unmet'); state(html, 'denominator', 'unknown'); state(html, 'activation', 'unknown');
  });
  check('impossible calendar dates and invalid timezone offsets cannot certify activation', () => {
    for (const time of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-09-31T00:00:00Z',
      '2026-09-07T24:00:00Z', '2026-09-07T00:00:00+14:01', '2026-09-07T00:00:00+15:00']) {
      const value = base(); value.frozenAt = '2026-01-01T00:00:00Z'; value.activationAt = time;
      state(render(value), 'activation', 'unknown');
    }
    const leap = base(); leap.frozenAt = '2024-02-28T00:00:00Z'; leap.activationAt = '2024-02-29T00:00:00Z';
    state(render(leap), 'activation', 'met');
  });
  check('activation requires a valid freeze timestamp and respects absolute chronology across offsets', () => {
    for (const time of [null, undefined, 'invalid', '2026-02-30T00:00:00Z', '2026-09-08T00:00:00Z']) {
      const value = base(); value.frozenAt = time; state(render(value), 'activation', 'unknown');
    }
    const value = base(); value.frozenAt = '2026-09-07T01:00:00Z'; value.activationAt = '2026-09-07T08:30:00+08:00';
    state(render(value), 'activation', 'unknown');
    value.activationAt = '2026-09-07T09:00:00+08:00'; state(render(value), 'activation', 'met');
  });
  check('local condition displays never override false server review or eligibility flags', () => {
    const value = base(), before = JSON.stringify(value); Object.freeze(value);
    const html = render(value); assert.equal(JSON.stringify(value), before);
    assert.ok(html.includes('可进入晋级复核 否')); assert.ok(html.includes('正式晋级评审资格 否'));
    assert.ok(html.includes('不覆盖候选状态，不自动上线')); assert.ok(html.includes('不是客户正式推荐'));
  });
  check('all published blocker codes including unfamiliar reasons remain visible and HTML escaped', () => {
    const value = base(); value.blockers = ['family-wise-adjusted-lower-bounds-not-positive', 'unknown-future-gate:<script>alert(1)</script>'];
    const html = render(value); assert.ok(html.includes('family-wise-adjusted-lower-bounds-not-positive'));
    assert.ok(html.includes('unknown-future-gate:&lt;script&gt;')); assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('最多提供 24 项'));
    value.blockers = []; assert.ok(render(value).includes('公开列表为空，仍以后台评审状态和完整证据为准'));
  });
  check('English SSR retains evidence boundaries and a keyboard-native closed disclosure', () => {
    const html = render(base(), 'en'); assert.match(html, /^<details class="candidate-promotion-gaps" data-testid="candidate-promotion-gaps">/);
    assert.ok(html.includes('<summary>')); assert.ok(html.includes('not customer formal picks')); assert.ok(html.includes('Last reviewed checkpoint is not supplied'));
  });
  check('the actual candidate card integrates the component without repeating misleading six-window shorthand', () => {
    const source = fs.readFileSync(path.join(root, 'src/pages/PredictionsList.tsx'), 'utf8');
    assert.ok(source.includes('<CandidatePromotionGaps candidate={candidateProspective} language={language} />'));
    assert.ok(source.includes('逐项门槛与窗口证据缺口见下方'));
    assert.equal(source.includes('}/6 固定窗口'), false);
  });
  check('local presentation constants remain bound to the actual frozen backend thresholds', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/candidateProspectiveLedger.cjs'), 'utf8');
    for (const [name, value] of [['MIN_FORMAL_SETTLED', 500], ['MIN_WINDOWS', 6], ['MIN_WINNING_WINDOWS', 5], ['MIN_FORMAL_ROWS_PER_WINDOW', 50],
      ['WINDOW_DAYS', 30], ['WINDOW_COUNT', 6], ['REVIEW_INTERVAL', 100], ['MAX_INVALID_SHARE', .05], ['MAX_SINGLE_ATTESTOR_SHARE', .3]]) {
      const found = new RegExp('const ' + name + ' = ([\\d.]+);').exec(source); assert.ok(found, name); assert.equal(Number(found[1]), value, name);
    }
    assert.ok(source.includes('const MIN_FORMAL_FINALIZED = MIN_FORMAL_SETTLED;'));
    assert.ok(source.includes('finite(adjusted?.logLossImprovement?.lower, null) > 0'));
    assert.ok(source.includes('finite(adjusted?.brierImprovement?.lower, null) > 0'));
    const html = render(base()); assert.ok(row(html, 'window-integrity').includes('6 个 30 天窗口，每窗 ≥ 50 条'));
    assert.equal(current(html, 'invalid-share'), '2%'); assert.ok(row(html, 'invalid-share').includes('≤ 5%')); assert.ok(row(html, 'single-attestor-share').includes('≤ 30%'));
  });
  check('responsive CSS has bounded columns, wrapping evidence codes and focus-visible disclosure', () => {
    const css = fs.readFileSync(path.join(root, 'src/components/predictions/candidate-promotion-gaps.css'), 'utf8');
    for (const expected of ['minmax(0, 1fr)', '@media (max-width: 720px)', 'overflow-wrap: anywhere', 'summary:focus-visible']) assert.ok(css.includes(expected));
    assert.doesNotMatch(css, /color:\s*var\(--text-(?:primary|secondary|muted)\b/);
    for (const token of ['--text-1', '--text-2', '--text-3']) assert.ok(css.includes('color: var(' + token + ','));
    const tokens = fs.readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
    for (const token of ['--text-1', '--text-2', '--text-3']) assert.match(tokens, new RegExp(token + ':\\s*var\\(--shell-text(?:-secondary|-muted)?\\)'));
  });
  assert.equal(new Set(cases.map(entry => entry.name)).size, cases.length, 'duplicate verifier case');
  if (onlyCases) for (const name of onlyCases) assert.ok(cases.some(entry => entry.name === name), 'unknown onlyCases name: ' + name);
  const selected = onlyCases ? cases.filter(entry => onlyCases.includes(entry.name)) : cases;
  for (const entry of selected) { entry.action(); checks.push({ name: entry.name, ok: true }); }
  return { ok: true, checks, selection: onlyCases ? 'targeted-delta' : 'all', totalAvailableCases: cases.length,
    skippedCases: cases.length - checks.length, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, actualReactSsr: true,
    cssExecution: false, browserLayoutVerified: false, productionWrites: 0, networkCalls: 0, buildRun: false,
    scope: 'Current candidate promotion-gap component only; not a full-page, browser, model or production acceptance.' };
}
module.exports = { verifyCandidatePromotionGaps, createSyntheticCandidatePromotionFixture };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyCandidatePromotionGaps(), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
