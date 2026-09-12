'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { shouldPauseSource } = require('./failure-policy.cjs');
test('recognized network failures may retry without relaxing access or identity checks', () => {
  for (const reason of ['page-timeout', 'page-read-failed']) assert.equal(shouldPauseSource({status:'parse_error',reason}),false);
  assert.equal(shouldPauseSource({status:'parse_error',reason:'non-success-http-status',httpStatus:503}),false);
  for(const status of ['blocked','login_required','conflict']) assert.equal(shouldPauseSource({status,reason:'page-read-failed'}),true);
});
test('malformed documents and unknown errors pause; empty source remains a data state', () => {
  assert.equal(shouldPauseSource({status:'parse_error',reason:'injury-tables-not-complete'}),true);
  assert.equal(shouldPauseSource({status:'parse_error'}),true);
  assert.equal(shouldPauseSource({status:'source_empty'}),false);
  assert.equal(shouldPauseSource({status:'available'}),false);
  assert.equal(shouldPauseSource({status:'parse_error',reason:'non-success-http-status',httpStatus:405}),true);
});
