'use strict';
// Pure research audit of the existing V3 snapshot. No source admission, fetch,
// approval, model probabilities, parameter changes, files or publication.
const {verifyPrematchTeamSnapshot, FEATURE_SCHEMA} = require('../src/services/prematchTeamEvidenceV3.cjs');
const {epochNanoseconds} = require('../src/services/prematchV3Clock.cjs');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');

const VERSION='prematch-team-knowledge-audit-v1';
const SIDES=['home','away'];
const SECTIONS=[['roster','confirmed'],['roster','projected'],['injuries'],['fatigue'],['history'],['xg']];
// Bound plain JSON before calling a verifier; accessors/cycles cannot run during
// a metadata audit. This does not define a second team feature schema.
function boundedJson(value){
  let nodes=0,bytes=0;const seen=new Set();
  function visit(v,depth){
    if(++nodes>100000||depth>24)return false;
    if(v===null||typeof v==='boolean')return true;
    if(typeof v==='number')return Number.isFinite(v);
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);return v.length<=8192&&bytes<=4*1024*1024;}
    if(typeof v!=='object'||seen.has(v))return false;
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
    if(array?(prototype!==Array.prototype||v.length>8192):(prototype!==Object.prototype&&prototype!==null))return false;
    const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=='string'))return false;
    if(array&&(keys.length!==v.length+1||keys.some(k=>k!=='length'&&(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=v.length))))return false;
    seen.add(v);
    for(const k of keys){if(array&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value')||!d.enumerable||!visit(d.value,depth+1))return false;}
    seen.delete(v);return true;
  }
  try{return visit(value,0);}catch{return false;}
}
function stamp(body){return {...body,contentHash:stableHash(body)};}
function blocked(reason){return stamp({version:VERSION,status:'blocked',blockers:[reason],snapshotHash:null,
  event:null,asOf:null,features:null,sides:null,sourceVerification:'unverified',formalEligible:false,
  probabilitiesProduced:false,scope:'pure-team-knowledge-audit;invalid-input-not-projected'});}
function sectionAudit(snapshot,side,parts){
  const section=parts.reduce((v,k)=>v[k],snapshot.sides[side]);
  const prefix=[side,...parts].join('.')+'.';
  const keys=FEATURE_SCHEMA.features.filter(k=>k.startsWith(prefix));
  const values=Object.fromEntries(keys.map(k=>[k,snapshot.features[k]]));
  const observations=snapshot.observations.filter(o=>section.evidenceHashes.includes(o.rowHash));
  const clocks=observations.map(o=>({rowHash:o.rowHash,providerObservedAt:o.providerObservedAt,
    receivedAt:o.receivedAt,sourcePublishedAt:o.sourcePublishedAt,
    identityMappingReviewedAt:o.identityMappingReviewedAt,clockBasis:o.clockBasis,
    knowledgeNotAfterAsOf:epochNanoseconds(o.receivedAt)<=epochNanoseconds(snapshot.asOf)}));
  return {status:section.status,values,knownFields:keys.filter(k=>values[k]!==null).length,
    unknownFields:keys.filter(k=>values[k]===null),zeroFields:keys.filter(k=>values[k]===0),
    issues:[...section.issues],evidenceHashes:[...section.evidenceHashes],clocks,
    sourceVerification:'unverified',formalEligible:false};
}
function rosterMeaning(snapshot,side,kind){
  const section=snapshot.sides[side].roster[kind];
  const selected=snapshot.observations.filter(o=>o.family==='roster'&&o.side===side
    &&o.data.status===kind&&section.evidenceHashes.includes(o.rowHash));
  const validList=selected.some(o=>o.data.players.length===11
    &&o.data.players.every(p=>typeof p.playerId==='string'&&p.playerId.length>0)
    &&new Set(o.data.players.map(p=>p.playerId)).size===11);
  return {providerLabel:kind,elevenDistinctPlayerIdsRetained:validList,
    independentSourceConfirmationProven:false,lineupAnnouncementMeaningVerified:false,
    sourcePublicationClockRecorded:selected.length>0&&selected.every(o=>o.sourcePublishedAt!==null),
    individualAppearanceProbabilities:null,
    scope:kind==='confirmed'?'retained-provider-confirmed-label-only;not-independent-XI-or-early-availability-proof'
      :'projected-list-only;never-substituted-for-confirmed-XI'};
}
function auditPrematchTeamKnowledge(snapshot){
  if(!boundedJson(snapshot)||!verifyPrematchTeamSnapshot(snapshot))return blocked('v3-snapshot-invalid');
  const asOf=epochNanoseconds(snapshot.asOf);
  if(asOf===null||snapshot.status!=='shadow-ready')return blocked('v3-event-not-ready');
  const sides=Object.fromEntries(SIDES.map(side=>{
    const sections=Object.fromEntries(SECTIONS.map(parts=>[parts.join('.'),sectionAudit(snapshot,side,parts)]));
    const injuryRows=snapshot.observations.filter(o=>o.side===side&&o.family==='injuries'
      &&snapshot.sides[side].injuries.evidenceHashes.includes(o.rowHash));
    return [side,{teamId:snapshot.event[side+'TeamId'],sections,
      roster:{confirmed:rosterMeaning(snapshot,side,'confirmed'),projected:rosterMeaning(snapshot,side,'projected')},
      availability:{meaning:injuryRows.map(o=>o.data.availabilityMeaning),
        knownUnavailableInObservedList:snapshot.features[side+'.injuries.knownUnavailablePlayers'],
        individualAppearanceProbabilities:null,medicalCauseVerified:false,wholeTeamNoInjuryProven:false,
        scope:'observed-list-only;news-or-withdrawal-is-not-an-appearance-probability-or-complete-injury-list'},
      fatigue:{completeScheduleProven:false,allCompetitionsCovered:null,playerMinutesCoverage:null,
        restDays:snapshot.features[side+'.fatigue.restDays'],
        scope:'existing-ended-time-and-load-fields-only;V3-has-no-complete-schedule-coverage-contract'},
      xg:{observedPriorSampleCount:snapshot.features[side+'.xg.sampleCount'],completeCoverageProven:false,
        scope:'retained-observed-prior-measurements-only;not-goal-rate-estimate-or-odds-derived-xG'},
    }];
  }));
  return stamp({version:VERSION,status:'research-audited',blockers:[],snapshotHash:snapshot.contentHash,
    event:{...snapshot.event},asOf:snapshot.asOf,featureSchemaHash:snapshot.featureSchemaHash,
    features:{...snapshot.features},knownFeatureCount:Object.values(snapshot.features).filter(v=>v!==null).length,
    unknownFeatureCount:Object.values(snapshot.features).filter(v=>v===null).length,
    rejectedObservations:snapshot.rejected.map(o=>({rowHash:o.rowHash,family:o.family,side:o.side,reasons:[...o.reasons]})),
    sides,missingRepresentation:'null;known-explicit-zero-remains-zero',
    sourceVerification:'unverified',formalEligible:false,probabilitiesProduced:false,
    completeFactorReadinessProven:false,
    scope:'pure-audit-of-existing-V3-content-and-knowledge-contract;no-new-provider-signature-permission-or-factor-admission'});
}
function inspectHandicapMarket(value){
  if(!boundedJson(value)||value===null||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(k=>!['market','line'].includes(k)))return {status:'blocked',reason:'market-fields-invalid',canConvertToJcHhad:false};
  const {market,line}=value;
  if(market==='HHAD'&&typeof line==='number'&&Number.isInteger(line)&&Math.abs(line)<=5)
    return {status:'classified',market:'HHAD',line,settlement:'home-goals-plus-integer-versus-away;draw-is-distinct-outcome',
      canConvertToJcHhad:false,officialPriceBindingProven:false};
  if(market==='AH'&&typeof line==='number'&&Number.isFinite(line)&&Math.abs(line)<=10&&Number.isInteger(line*4))
    return {status:'classified',market:'AH',line,settlement:'asian-market;push-or-split-rules-require-own-contract',
      canConvertToJcHhad:false,officialPriceBindingProven:false};
  return {status:'blocked',reason:'explicit-market-and-valid-line-required',canConvertToJcHhad:false};
}
module.exports={VERSION,auditPrematchTeamKnowledge,inspectHandicapMarket};
