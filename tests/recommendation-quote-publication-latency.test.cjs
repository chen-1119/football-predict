'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarizeQuotePublicationLatency}=require('../scripts/recommendationPlatform/quotePublicationLatency.cjs');
const origin=Date.parse('2026-10-07T03:00:00Z'),stamp=n=>new Date(origin+n).toISOString();
const decision=(id,lag)=>({sourceMatchId:String(id),eventVersion:stamp(3600000),decisionId:'d'+id,
  quoteSource:'sporttery:HAD:signed-live',publishedAt:stamp(lag),
  quoteProvenance:{version:'signed-live-had-receipt-v1',receiptHash:'a'.repeat(64),requestedAt:stamp(-100),observedAt:stamp(0)}});
test('latency uses real acquisition and publication clocks, not model or generation clocks',()=>{
  const d=decision(1,12345);d.modelGeneratedAt=stamp(-3600000);d.publication={committedAt:stamp(-7200000)};
  const report=summarizeQuotePublicationLatency([d,decision(2,30000)]);
  assert.equal(report.measuredRows,2);assert.equal(report.minMs,12345);assert.equal(report.maxMs,30000);assert.equal(report.p95Ms,30000);
  assert.equal(report.rows[0].collectionDurationMs,100);assert.equal(report.rows[0].acquisitionToPublicationMs,12445);
});
test('empty, bare-label, future, missing and regressing clocks do not invent measurements',()=>{
  const bare={...decision(1,1),quoteSource:'sporttery:HAD'};
  const future=decision(2,-1),missing=decision(3,1);delete missing.quoteProvenance.requestedAt;
  const reversed=decision(4,1);reversed.quoteProvenance.requestedAt=stamp(2);
  const report=summarizeQuotePublicationLatency([bare,future,missing,reversed]);
  assert.equal(report.measuredRows,0);assert.equal(report.minMs,null);assert.equal(report.maxMs,null);assert.equal(report.p95Ms,null);
});
test('versioned V1 and V2 accepted receipts both retain latency clocks without treating unknown versions as measurements',()=>{
  const old=decision(1,1000),fresh=decision(2,2000),unknown=decision(3,3000);
  fresh.quoteProvenance.version='signed-live-had-receipt-v2';unknown.quoteProvenance.version='signed-live-had-receipt-v3';
  const report=summarizeQuotePublicationLatency([old,fresh,unknown]);
  assert.equal(report.measuredRows,2);assert.equal(report.rows[0].sourceMatchId,'1');assert.equal(report.rows[1].sourceMatchId,'2');
  assert.equal(report.rows[1].publicationLagMs,2000);assert.equal(report.maxMs,2000);
});
