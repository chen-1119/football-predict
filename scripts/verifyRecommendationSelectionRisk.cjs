'use strict';
const assert=require('node:assert/strict');
const {withVerifiedInputEvidence}=require('../tests/fixtures/recommendation-input-helper.cjs');
const {makeDecision,validDecision,chooseCombo}=require('./recommendationPlatform/decision.cjs');
const {selectionQuality,isQualifiedSelection,VERSION,LEGACY_VERSION}=require('../src/services/recommendationSelectionQuality.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {bindPublicReferenceDecision}=require('../src/services/publicReferenceDecision.cjs');
const {crossTrackConflict}=require('../src/services/recommendationCrossTrackConflict.cjs');

const now=Date.parse('2026-09-26T09:00:00Z');
const publication={generationId:'selection-risk-test',manifestHash:'a'.repeat(64)};
function fixture(id,p,odds){
 const match={id:`sporttery_${id}`,sourceMatchId:id,businessDate:'2026-09-26',status:'SCHEDULED',
  homeTeamId:`home_${id}`,awayTeamId:`away_${id}`,homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,
  kickoffTime:'2026-09-26T14:00:00Z',eventVersion:'2026-09-26T14:00:00Z',
  probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:p[0],draw:p[1],away:p[2]}}},
  odds:{odds1:odds[0],oddsX:odds[1],odds2:odds[2]},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString()};
 return withVerifiedInputEvidence(match);
}
function decision(id,p,odds){
 const result=makeDecision(fixture(id,p,odds),{now,publication});
 assert.equal(result.reason,null);
 assert.ok(validDecision(result.decision));
 return result.decision;
}
const thin=decision('thin',[37.1,26.2,36.7],[2,3.5,3.06]);
const shortBrazil=decision('short-brazil',[30,22,48],[6,4,1.12]);
const shortPoland=decision('short-poland',[48.2,26.2,25.6],[1.41,3.8,5]);
const robust=[1,2,3].map(i=>decision(`robust-${i}`,[56,26,18],[2.2,3.4,3.8]));
assert.equal(thin.selectionPolicyVersion,VERSION);
assert.ok(selectionQuality(thin).reasons.includes('model-lead-too-thin'));
for(const d of [shortBrazil,shortPoland]){
 const q=selectionQuality(d);
 assert.equal(q.qualified,false);
 assert.ok(q.reasons.includes('material-model-market-disagreement'));
 assert.equal(q.priceFilterApplied,true);
}
for(const d of robust)assert.equal(selectionQuality(d).qualified,true);
const combo=chooseCombo([thin,shortBrazil,shortPoland,...robust],2,now,{admit:isQualifiedSelection});
assert.ok(combo);
assert.ok(combo.legs.every(d=>d.sourceMatchId.startsWith('robust-')));

// Historical records use their original input-only policy, identity and hash.
const legacyBody={...thin,selectionPolicyVersion:LEGACY_VERSION};
delete legacyBody.recordHash;
legacyBody.inputHash=hash({hadInputHash:thin.hadInputHash,handicapInputHash:thin.handicapAnalysis?.inputHash||null,
 selectionPolicyVersion:LEGACY_VERSION,modelInputEvidenceHash:thin.inputEvidence.model.inputEvidence.contentHash});
legacyBody.decisionId=`decision_${hash([legacyBody.version,legacyBody.sourceMatchId,legacyBody.eventVersion,legacyBody.market,legacyBody.inputHash])}`;
legacyBody.id=legacyBody.decisionId;
const legacy={...legacyBody,recordHash:hash(legacyBody)};
assert.ok(validDecision(legacy));
assert.equal(selectionQuality(legacy).version,LEGACY_VERSION);
assert.equal(selectionQuality(legacy).qualified,true);
assert.equal(selectionQuality(legacy).priceFilterApplied,false);

const referenceFixture=fixture('thin',[37.1,26.2,36.7],[2,3.5,3.06]);
referenceFixture.predictions=[{marketType:'BEST',recommendationAction:'reference',
 oddsPoolCode:'HAD',tipCode:'2',odds:3.06}];
referenceFixture.predictionMeta={decisionGeneratedAt:new Date(now).toISOString(),decisionId:'reference-thin',
 modelVersion:referenceFixture.probabilityModel.version,policyVersion:'reference-test-v1',
 featureSnapshot:{sourceMatchId:'thin',kickoffTime:referenceFixture.kickoffTime,
  capturedAt:new Date(now-1000).toISOString()}};
const referenced=bindPublicReferenceDecision(referenceFixture,null,new Date(now+1000).toISOString());
assert.ok(referenced.predictionMeta.publicReferenceDecision?.evidenceBinding);
assert.equal(crossTrackConflict(referenced,thin,now),null,'future reference cannot rewrite publication-time knowledge');
const later=crossTrackConflict(referenced,thin,now+2000);
assert.equal(later?.reason,'cross-track-direction-conflict');
assert.equal(later?.knownAtPublication,false);
assert.equal(crossTrackConflict({...referenced,sourceMatchId:'different'},thin,now+2000),null);
assert.equal(crossTrackConflict({...referenced,eventVersion:'2026-09-26T15:00:00Z'},thin,now+2000),null);
assert.equal(crossTrackConflict({...referenced,predictionMeta:{...referenced.predictionMeta,
 publicReferenceDecision:{...referenced.predictionMeta.publicReferenceDecision,contentHash:'0'.repeat(64)}}},thin,now+2000),null);
const sameReference=bindPublicReferenceDecision({...referenceFixture,
 predictions:[{...referenceFixture.predictions[0],tipCode:'1',odds:2}]},null,new Date(now+1000).toISOString());
assert.equal(crossTrackConflict(sameReference,thin,now+2000),null);
console.log(JSON.stringify({ok:true,checks:22,policy:VERSION,legacy:LEGACY_VERSION}));
