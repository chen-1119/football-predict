'use strict';
// SYNTHETIC fixtures only: no claim about production accuracy or coverage.
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {triplet,featureAudit,inspectRow,verifyEnvelope,analyzeCapture}=require('../scripts/historyRegressionAdmission.cjs');
const {createCollectorAttestationTestContext}=require('../scripts/collectorAttestationTestFixture.cjs');
const {buildCandidateDecisionSnapshot,isDecisionClockAuditEligible}=require('../src/services/decisionSnapshot.cjs');
const context=createCollectorAttestationTestContext({keyId:'history-regression-synthetic-ed25519'});
test.after(()=>context.cleanup());
const clone=value=>structuredClone(value);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function signedRow(){
  const sourceMatchId='history-synthetic-123',cycle='history-synthetic-source-cycle';
  const prematch={
    id:'sporttery_'+sourceMatchId,sourceMatchId,kickoffTime:'2026-09-10T12:00:00.000Z',buyEndTime:'2026-09-10T11:50:00.000Z',
    odds:{odds1:1.9,oddsX:3.3,odds2:4.1},
    oddsMarketProvenance:context.buildSignedMarketProvenance({
      poolCode:'HAD',sourceMatchId,odds:{'1':1.9,X:3.3,'2':4.1},sourceUrl:'https://webapi.sporttery.cn/test',
      providerObservedAt:'2026-09-10T10:25:00.000Z',
      sourceTiming:{sourceCycleId:cycle,requestedAt:'2026-09-10T10:24:00.000Z',receivedAt:'2026-09-10T10:26:00.000Z',
        sourceRequest:{method:'GET',role:'history-regression-synthetic-fixture'},httpStatus:200,rawSha256:'c'.repeat(64),rawBytes:1024},
    }),
    predictionMeta:{generatedAt:'2026-09-10T10:40:00.000Z',decisionGeneratedAt:'2026-09-10T10:40:00.000Z',
      sourceCycleId:cycle,cutoffTime:'2026-09-10T11:50:00.000Z',modelVersion:'synthetic-published-model-v1'},
    probabilityModel:{version:'synthetic-published-model-v1',generatedAt:'2026-09-10T10:37:00.000Z',
      oneXTwo:{final:{home:52,draw:28,away:20}},
      unifiedPosterior:{generatedAt:'2026-09-10T10:39:00.000Z',selectedMarket:'HAD',selectedCode:'1',dataQuality:.8,
        candidates:[{market:'HAD',code:'1',probability:52,odds:1.9}]}},
  };
  const decisionSnapshot=buildCandidateDecisionSnapshot(prematch,'2026-09-10T10:20:00.000Z',{collectorTrustRegistry:context.registry});
  const match={id:prematch.id,sourceMatchId,leagueName:'SYNTHETIC ONLY',kickoffTime:prematch.kickoffTime,eventVersion:prematch.kickoffTime,
    status:'FINISHED',scoreHome:2,scoreAway:1,resultSource:'sporttery:official-api',
    resultProvenance:{version:'result-provenance-v2',provider:'sporttery',official:true,trusted:true,source:'sporttery:official-api',
      sourceMatchId,sourceStatus:'FINISHED',scoreHome:2,scoreAway:1,kickoffTime:prematch.kickoffTime,eventVersion:prematch.kickoffTime,
      observedAt:'2026-09-10T14:10:00.000Z',observationSource:'synthetic-sporttery-receipt',sourceUrl:'https://webapi.sporttery.cn/test'},
    inputFileRowIndex:0,originalObjectCanonicalSha256:'b'.repeat(64)};
  const snapshot={decisionId:'synthetic-frozen-decision-123',phase:'prematch',sourceMatchId,kickoffTime:prematch.kickoffTime,
    inputFileRowIndex:0,originalObjectCanonicalSha256:'d'.repeat(64),decisionSnapshot};
  return {matchId:sourceMatchId,market:'HAD',match,snapshot,snapshotSelectionAudit:{snapshotsSeen:1,preCutoffDecisions:1},conflictingMatchRows:false};
}

function rebindRaw(capture){
  const {transport,...remote}=capture;
  const rawResponseBytes=Buffer.from(JSON.stringify(remote)+'\n');
  capture.transport={...transport,responseByteSha256:sha(rawResponseBytes)};
  return {rawResponseBytes};
}

function captureFixture(rows=[signedRow()]){
  const publication={generationId:'g-'+'a'.repeat(64),manifestHash:'a'.repeat(64),sourceCycleId:'synthetic-cycle',committedAt:'2026-09-30T15:00:00Z'};
  const capture={version:'bounded-online-history-export-v1',ok:true,productionWrites:false,source:'online-immutable-active-generation',sameSnapshot:true,
    observedAt:'2026-10-02T01:00:00Z',completedAt:'2026-10-02T01:01:00Z',publication,
    pointerSha256:'e'.repeat(64),manifestFileSha256:'f'.repeat(64),rowsCanonicalSha256:'9'.repeat(64),
    selection:{from:'2026-09-01T00:00:00+08:00',until:'2026-10-01T00:00:00+08:00',maxMatches:500,pageSize:50},rows,
    files:['matches-history.json','prediction-snapshots.json'].map(path=>({path,bytes:10,sha256:'f'.repeat(64)})),
    pages:rows.length?[{offset:0,rows:rows.length,matchIds:rows.map(row=>row.matchId),canonicalSha256:'8'.repeat(64)}]:[],
    collectorTrustRegistry:context.registry,collectorTrustRegistryEvidence:{path:'/synthetic/public-registry.json',bytes:2048,fileSha256:'7'.repeat(64),stableBeforeAfter:true},
    transport:{sourceHost:'synthetic.invalid',pinnedSshFingerprint:'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to',exporterSha256:'6'.repeat(64),receivedAt:'2026-10-02T01:01:01Z'},
  };
  return {capture,...rebindRaw(capture)};
}
test('synthetic probability input fails closed rather than normalizing arbitrary numbers',()=>{
  assert.deepEqual(triplet({home:.5,draw:.3,away:.2}),{home:.5,draw:.3,away:.2});
  for(const p of [{home:50,draw:30,away:20},{home:-.1,draw:.5,away:.6},{home:null,draw:.4,away:.6},{home:NaN,draw:.4,away:.6},{home:.2,draw:.2,away:.2}])assert.equal(triplet(p),null);
  assert.equal(triplet({home:1,draw:3,away:4},{odds:true}),null);
});
test('synthetic frozen feature binding and time are necessary, presence never grants candidate authority',()=>{
  const d={decisionAt:'2026-09-10T10:00:00Z',featureSnapshotHash:'f1'};
  const s={featureSnapshot:{hash:'f1',capturedAt:'2026-09-10T09:59:00Z',modelInputs:{elo:{home:1500}}}};
  const audit=featureAudit(s,d);assert.equal(audit.bound,true);assert.equal(audit.timeValid,true);assert.equal(audit.groups.elo.available,true);assert.equal(audit.candidateEligible,false);
  s.featureSnapshot.capturedAt='2026-09-10T10:01:00Z';assert.equal(featureAudit(s,d).groups.elo.available,false);
  s.featureSnapshot.hash='bad';assert.equal(featureAudit(s,d).bound,false);
});
test('synthetic missing snapshot remains explicit and cannot be replaced with current data',()=>{
  const row={matchId:'123',market:'HAD',match:{sourceMatchId:'123',status:'FINISHED',kickoffTime:'2026-09-10T10:00:00Z',scoreHome:1,scoreAway:0},snapshot:null};
  const result=inspectRow(row);assert.equal(result.pairedEligible,false);assert.equal(result.originalEligible,false);
  assert(result.reasons.includes('frozen-decision-missing'));assert(result.reasons.includes('result-observation-ineligible'));assert.equal(result.record.decision.probabilities,null);
});
test('synthetic capture identity prevents mixed generations and duplicate independent samples',()=>{
  const {capture,rawResponseBytes}=captureFixture(),p=capture.publication;
  assert.doesNotThrow(()=>verifyEnvelope(capture,{expectedPublication:p,rawResponseBytes}));
  assert.throws(()=>verifyEnvelope(capture,{expectedPublication:{...p,sourceCycleId:'other'},rawResponseBytes}),/PUBLICATION_MISMATCH/);
  capture.rows.push(clone(capture.rows[0]));assert.throws(()=>verifyEnvelope(capture,rebindRaw(capture)),/DUPLICATE_MATCH_MARKET/);
});

test('synthetic signed constructor fixture admits original and same-decision paired records',()=>{
  const row=signedRow();
  assert.equal(isDecisionClockAuditEligible(row.snapshot.decisionSnapshot,{collectorTrustRegistry:context.registry}),true);
  const inspection=inspectRow(row,{collectorTrustRegistry:context.registry});
  assert.deepEqual(inspection.reasons,[]);
  assert.equal(inspection.originalEligible,true);assert.equal(inspection.pairedEligible,true);
  assert.deepEqual(inspection.record.decision.probabilities,{home:.52,draw:.28,away:.2});
  assert.equal(inspection.record.result.observedAt,'2026-09-10T14:10:00.000Z');
  assert.equal(inspection.record.result.lineage.sourceMatchId,row.matchId);
  const {capture,rawResponseBytes}=captureFixture([row]);
  const report=analyzeCapture(capture,{rawResponseBytes,expectedPublication:capture.publication,expectedManifestFileSha256:capture.manifestFileSha256});
  assert.equal(report.funnel.frozenProbabilityScorable,1);assert.equal(report.funnel.sameDecisionPaired,1);
  assert.equal(report.pairedReview.rows,1);assert.equal(report.originalRecords.length,1);
  assert.equal(report.source.envelopeVerification.rawResponseVerified,true);
  assert.equal(report.source.envelopeVerification.pythonCanonicalHashesRecomputed,false);
});

test('synthetic original forecast remains separate from missing or tampered signed-market evidence',()=>{
  const row=signedRow();
  const withoutTrust=inspectRow(row);
  assert.equal(withoutTrust.originalEligible,true);assert.equal(withoutTrust.pairedEligible,false);
  for(const mutation of [
    copy=>{copy.snapshot.decisionSnapshot.markets.HAD.odds['1']=2.2;},
    copy=>{copy.snapshot.decisionSnapshot.markets.HAD.provenance.extraction.odds['1']=2.2;},
    copy=>{copy.snapshot.decisionSnapshot.markets.HAD.receivedAt='2026-09-10T10:45:00.000Z';},
    copy=>{copy.snapshot.decisionSnapshot.markets.HAD.provenanceHash='0'.repeat(64);},
  ]){
    const copy=clone(row);mutation(copy);
    const inspection=inspectRow(copy,{collectorTrustRegistry:context.registry});
    assert.equal(inspection.originalEligible,true);assert.equal(inspection.pairedEligible,false);
  }
  const wrongTrust=clone(context.registry);wrongTrust.keys[0].enabled=false;
  assert.equal(inspectRow(row,{collectorTrustRegistry:wrongTrust}).pairedEligible,false);
});

test('synthetic clock tampering rejects the original forecast independently of market signing',()=>{
  for(const mutation of [
    d=>{d.decisionAt='2026-09-10T10:41:00.000Z';},
    d=>{d.sourceTimestamps.baseModelGeneratedAt='2026-09-10T10:41:00.000Z';},
    d=>{d.clockAudit.baseModelGeneratedAt='2026-09-10T10:41:00.000Z';d.sourceTimestamps.baseModelGeneratedAt=d.clockAudit.baseModelGeneratedAt;},
    d=>{d.capturedAt='2026-09-10T10:50:00.000Z';},
    d=>{d.decisionAt='2026-09-10T12:00:00.000Z';d.cutoffTime=d.decisionAt;d.clockAudit.decisionAt=d.decisionAt;d.clockAudit.cutoffTime=d.decisionAt;},
    d=>{d.capturedAt='2026-02-30T10:20:00Z';},
  ]){
    const row=signedRow();mutation(row.snapshot.decisionSnapshot);
    const inspection=inspectRow(row,{collectorTrustRegistry:context.registry});
    assert.equal(inspection.originalEligible,false);assert.equal(inspection.pairedEligible,false);
    assert(inspection.reasons.some(reason=>/clock/.test(reason)));
  }
});

test('synthetic result observation receipt must belong to the same event, score and version',()=>{
  for(const mutation of [
    match=>{match.resultProvenance.sourceMatchId='wrong-event';},
    match=>{match.resultProvenance.scoreHome=0;},
    match=>{match.resultProvenance.eventVersion='2026-09-10T12:01:00Z';},
    match=>{match.resultProvenance.observedAt='2026-09-10T11:59:00Z';},
    match=>{match.resultProvenance.observationSource='kickoff-plus-two-hours-fallback';},
    match=>{match.resultObservationFallback=true;},
    match=>{match.eventVersion='2026-02-30T12:00:00Z';},
  ]){
    const row=signedRow();mutation(row.match);
    const inspection=inspectRow(row,{collectorTrustRegistry:context.registry});
    assert.equal(inspection.originalEligible,false);assert.equal(inspection.pairedEligible,false);
    assert(inspection.reasons.some(reason=>reason.startsWith('result-observation')));
  }
  const late=signedRow();late.match.resultProvenance.observedAt='2026-10-01T00:00:00Z';
  const inspection=inspectRow(late,{collectorTrustRegistry:context.registry,publication:{committedAt:'2026-09-30T15:00:00Z'}});
  assert(inspection.reasons.includes('result-observation-after-publication'));
});

test('synthetic equivalent timezone event versions pass but wrong frozen event and probability units fail',()=>{
  const equivalent=signedRow();equivalent.match.eventVersion='2026-09-10T20:00:00+08:00';equivalent.match.resultProvenance.eventVersion=equivalent.match.eventVersion;
  equivalent.snapshot.decisionSnapshot.eventVersion=equivalent.match.eventVersion;
  assert.equal(inspectRow(equivalent,{collectorTrustRegistry:context.registry}).pairedEligible,true);
  for(const mutation of [
    row=>{row.snapshot.decisionSnapshot.sourceMatchId='wrong-event';},
    row=>{row.snapshot.sourceMatchId='wrong-event';},
    row=>{row.snapshot.decisionSnapshot.version='candidate-decision-snapshot-v1';},
    row=>{row.snapshot.decisionSnapshot.probabilities.HAD={home:52,draw:28,away:20};},
    row=>{row.snapshot.decisionSnapshot.probabilities.HAD={home:.52,draw:.28,away:.2,'1':.2};},
    row=>{row.snapshot.decisionSnapshot.probabilities.HAD={home:null,draw:.28,away:.2,'1':.52};},
  ]){
    const row=signedRow();mutation(row);assert.equal(inspectRow(row,{collectorTrustRegistry:context.registry}).originalEligible,false);
  }
});

test('synthetic raw exporter bytes are mandatory and local edits cannot keep an old receipt hash',()=>{
  const {capture,rawResponseBytes}=captureFixture();
  assert.throws(()=>verifyEnvelope(capture),/RAW_RESPONSE_PROOF_REQUIRED/);
  assert.throws(()=>verifyEnvelope(capture,{rawResponseBytes:Buffer.concat([rawResponseBytes,Buffer.from(' ')])}),/RAW_RESPONSE_HASH_MISMATCH/);
  capture.rows[0].snapshot.decisionSnapshot.probabilities.HAD['1']=.6;
  assert.throws(()=>verifyEnvelope(capture,{rawResponseBytes}),/CAPTURE_DIFFERS_FROM_RAW_RESPONSE/);
});

test('synthetic envelope validates limits, dates, row proofs, pages, registry and prior manifest binding',()=>{
  for(const [mutation,reason] of [
    [capture=>{capture.selection.maxMatches=501;},/SELECTION_LIMIT_INVALID/],
    [capture=>{capture.selection.maxMatches='500';},/SELECTION_LIMIT_INVALID/],
    [capture=>{capture.selection.maxMatches=0;},/SELECTION_LIMIT_INVALID/],
    [capture=>{capture.selection.pageSize=500;},/SELECTION_LIMIT_INVALID/],
    [capture=>{capture.selection.from='2026-02-30T00:00:00+08:00';},/SELECTION_DATE_INVALID/],
    [capture=>{capture.selection.until=capture.selection.from;},/SELECTION_DATE_INVALID/],
    [capture=>{capture.rows[0].match.kickoffTime=capture.selection.until;},/ROW_OUTSIDE_SELECTION_WINDOW/],
    [capture=>{capture.rows[0].match.originalObjectCanonicalSha256='invalid';},/SOURCE_ROW_PROOF_MISSING/],
    [capture=>{capture.files[0].bytes=-1;},/SOURCE_FILE_PROOF_MISSING/],
    [capture=>{capture.pages[0].matchIds=['other'];},/PAGE_PROOF_INVALID/],
    [capture=>{capture.collectorTrustRegistryEvidence.stableBeforeAfter=false;},/COLLECTOR_REGISTRY_PROOF_MISSING/],
    [capture=>{capture.collectorTrustRegistry.keys[0].fingerprint='0'.repeat(64);},/COLLECTOR_REGISTRY_INVALID/],
    [capture=>{capture.manifestFileSha256='invalid';},/CONTROL_HASH_MISSING/],
  ]){
    const fixture=captureFixture();const capture=clone(fixture.capture);mutation(capture);
    assert.throws(()=>verifyEnvelope(capture,rebindRaw(capture)),reason);
  }
  const {capture,rawResponseBytes}=captureFixture();
  assert.throws(()=>verifyEnvelope(capture,{rawResponseBytes,expectedManifestFileSha256:'a'.repeat(64)}),/MANIFEST_FILE_HASH_MISMATCH/);
});

test('synthetic exporter omission is the primary blocker rather than fabricated decision corruption',()=>{
  const row=signedRow();
  row.snapshot.decisionSnapshot={omitted:'field-over-byte-limit',bytes:14993,canonicalSha256:'a'.repeat(64)};
  const result=inspectRow(row,{collectorTrustRegistry:context.registry});
  assert.equal(result.primaryReason,'projection-evidence-omitted');
  assert.equal(result.originalEligible,false);assert.equal(result.pairedEligible,false);
  assert.deepEqual(result.reasons,['projection-evidence-omitted']);
  assert.equal(result.record.decision.probabilities,null);
});

test('synthetic feature export omissions and unknown projection presence are distinct from saved-field absence',()=>{
  const decision={decisionAt:'2026-09-10T10:40:00Z',featureSnapshotHash:'f1'};
  for(const featureSnapshot of [
    {omitted:'field-over-byte-limit',canonicalSha256:'a'.repeat(64)},
    {hash:'f1',capturedAt:'2026-09-10T10:30:00Z',modelInputs:{omitted:'field-over-byte-limit',canonicalSha256:'a'.repeat(64)}},
  ]){
    const audit=featureAudit({featureSnapshot,featureSnapshotProjection:true},decision);
    assert.equal(audit.groups.elo.status,'export-omitted');assert.equal(audit.exportOmitted.length,9);
    assert.equal(audit.sourceSnapshotMissing.length,0);assert.equal(audit.groups.elo.available,false);
  }
  const projected=featureAudit({featureSnapshotProjection:true,featureSnapshot:{hash:'f1',capturedAt:'2026-09-10T10:30:00Z',modelInputs:{}}},decision);
  assert.equal(projected.groups.elo.status,'not-present-in-exported-feature-projection');assert.equal(projected.sourceSnapshotMissing.length,0);
  const missing=featureAudit({},decision);assert.equal(missing.groups.elo.status,'source-snapshot-field-missing');
  const zeroValue=featureAudit({featureSnapshot:{hash:'f1',capturedAt:'2026-09-10T10:30:00Z',modelInputs:{form:0}}},decision);
  assert.equal(zeroValue.groups.form.available,true);assert.equal(zeroValue.groups.form.candidateEligible,false);
});
