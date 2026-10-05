'use strict';
const assert = require('node:assert/strict');
const { primarySelectionSummary, handicapExtensionText } = require('../src/services/recommendationCenterView.ts');

function decision(hadCode, handicapCode, line) {
  return {
    primaryPickPolicyVersion: 'independent-market-primary-v1',
    tipCode: hadCode,
    odds: 1.5,
    modelProbability: 0.4,
    handicapAnalysis: {
      handicapLine: line,
      handicapLineText: line > 0 ? `+${line}` : String(line),
      overallTipCode: handicapCode,
      overallProbabilities: { '1': 0.2, X: 0.25, '2': 0.55 },
      probabilities: { '1': 0.1, X: 0.6, '2': 0.3 },
      marketReference: { odds: { '1': 2.4, X: 3.1, '2': 2.2 } }
    }
  };
}

for (const [had, hhad, line] of [['1', '2', -1], ['2', '1', 1]]) {
  const frozen = decision(had, hhad, line);
  const before = JSON.stringify(frozen);
  const view = primarySelectionSummary(frozen);
  assert.equal(view.handicap.status, 'pass');
  assert.equal(view.handicap.code, null);
  assert.equal(view.handicap.riskCode, hhad);
  assert.equal(view.handicap.suggestedCode, null, 'do not manufacture an aligned substitute');
  assert.match(handicapExtensionText(view.handicap, 'zh').title, /不追让球/);
  assert.equal(JSON.stringify(frozen), before, 'display must not mutate a frozen decision');
}

for (const [had, hhad, line] of [['X', '2', -1], ['1', 'X', -1], ['1', '2', -2]]) {
  const view = primarySelectionSummary(decision(had, hhad, line));
  assert.equal(view.handicap.status, 'recommend', `${had}/${hhad}/${line} can win together`);
  assert.equal(view.handicap.code, hhad);
}

console.log(JSON.stringify({ ok: true, cases: 5, policy: 'mutually-exclusive-marginal-leaders-are-risk-only' }));
