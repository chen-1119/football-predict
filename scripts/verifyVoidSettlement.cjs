const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isOfficialVoidMatch,
  isPredictionSettlementReady,
  officialVoidDisposition,
  resultStatus,
  settlePredictionsForMatch,
} = require('./syncData.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check('official cancellation and abandonment become VOID dispositions', () => {
  for (const label of ['取消竞猜', '比赛取消', '赛事中止', 'ABANDONED', 'Cancelled']) {
    assert.equal(officialVoidDisposition('', '', label)?.resultDisposition, 'VOID', label);
  }
});

check('postponed or suspended matches are not guessed as refunded', () => {
  for (const label of ['比赛延期', 'POSTPONED', 'SUSPENDED', '暂停']) {
    assert.equal(officialVoidDisposition('', '', label), null, label);
  }
});

const voidMatch = {
  id: 'void-fixture',
  status: 'PENDING_RESULT',
  resultDisposition: 'VOID',
  voidReason: '取消竞猜',
  voidSource: 'sporttery:official-api',
  handicapLine: '-1',
};

check('only an attributed official disposition is settlement-ready', () => {
  assert.equal(isOfficialVoidMatch(voidMatch), true);
  assert.equal(isPredictionSettlementReady(voidMatch), true);
  assert.equal(isOfficialVoidMatch({ ...voidMatch, voidSource: 'unknown' }), false);
  assert.equal(isPredictionSettlementReady({ status: 'PENDING_RESULT' }), false);
});

check('void predictions settle to VOID while WATCH remains pending', () => {
  assert.equal(resultStatus(voidMatch, '1', 'BEST'), 'VOID');
  assert.equal(resultStatus(voidMatch, 'WATCH', 'BEST'), 'PENDING');
  const settled = settlePredictionsForMatch(voidMatch, [
    { marketType: 'BEST', oddsPoolCode: 'HHAD', handicapLine: '-1', tipCode: '1' },
    { marketType: 'BEST', tipCode: 'WATCH' },
  ]);
  assert.deepEqual(settled.map((row) => row.resultStatus), ['VOID', 'PENDING']);
});

check('VOID is excluded from hit-rate denominators and exposed to clients', () => {
  const audit = read('scripts/auditPredictions.cjs');
  const server = read('server/index.cjs');
  const types = read('src/services/mockData.ts');
  assert.match(audit, /row\.result === "WON" \|\| row\.result === "LOST"/);
  assert.match(server, /resultDisposition: match\.resultDisposition/);
  assert.match(types, /'WON' \| 'LOST' \| 'PENDING' \| 'VOID'/);
});

check('list and detail UI identify void/refunded records', () => {
  const list = read('src/pages/PredictionsList.tsx');
  const detail = read('src/pages/MatchDetail.tsx');
  assert.match(list, /已取消 \/ 退款/);
  assert.match(list, /不计入命中率分母/);
  assert.match(detail, /本场推荐作废/);
  assert.match(detail, /profit is zero/);
});

check('voided publications never count as active recommendations', () => {
  const list = read('src/pages/PredictionsList.tsx');
  assert.match(list, /match\.resultDisposition !== 'VOID'[\s\S]*getOnSaleDisplayRecommendation/);
  assert.match(list, /const displayRecommendation = isVoid \? null : formalRecommendation \|\| liveRecommendation/);
  assert.match(list, /signal\.category === 'finished' \|\| isVoid/);
  assert.match(list, /const publishedRecommendation = isVoid[\s\S]*\? null/);
});

console.log(JSON.stringify({ ok: true, checks: checks.length, passed: checks }, null, 2));
