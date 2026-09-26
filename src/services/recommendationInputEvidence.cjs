'use strict';
const {createHash}=require('node:crypto');
const {verifyModelInputUsage,summarizeModelInputUsage}=require('./modelInputUsage.cjs');
const {verifyPredictionClock}=require('./predictionExecutionClock.cjs');
const VERSION='recommendation-input-evidence-v1';
const BASE_KEYS=['market','teamStrength','elo','poisson','worldCupPrior'];
const SIDES=['home','draw','away'];
const MAX_PROOF_BYTES=32768;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const sourceId=value=>typeof value==='string'?value.replace(/^sporttery_/,'').trim():'';
const instant=value=>typeof value==='string'&&value.trim()?Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(value)?value:value.replace(' ','T')+'+08:00'):NaN;
const iso=value=>Number.isFinite(instant(value))?new Date(instant(value)).toISOString():null;
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':object(value)?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function vector(value){return object(value)&&SIDES.every(k=>finite(value[k])&&value[k]>=0&&value[k]<=100)&&SIDES.reduce((n,k)=>n+value[k],0)>0?Object.fromEntries(SIDES.map(k=>[k,value[k]])):null;}
function sameProbability(a,b){const x=vector(a),y=vector(b);if(!x||!y)return false;const total=v=>SIDES.reduce((n,k)=>n+v[k],0);return SIDES.every(k=>Math.abs(x[k]/total(x)-y[k]/total(y))<1e-10);}
function binding(model,match){
 const id=sourceId(match?.sourceMatchId||match?.id),event=iso(match?.eventVersion||match?.kickoffTime),kickoff=iso(match?.kickoffTime),generated=iso(model?.generatedAt),final=vector(model?.oneXTwo?.final);
 if(!id||!event||event!==kickoff||!generated||!final||instant(generated)>=instant(event))return null;
 if(model.sourceMatchId!=null&&sourceId(model.sourceMatchId)!==id)return null;
 if(model.eventVersion!=null&&iso(model.eventVersion)!==event)return null;
 return {sourceMatchId:id,eventVersion:event,modelVersion:typeof model.version==='string'&&model.version.trim()?model.version:null,modelGeneratedAt:generated,final};
}
function samplesFor(model){return {elo:{home:count(model?.elo?.homeMatches),away:count(model?.elo?.awayMatches)},form:{home:count(model?.form?.home?.sampleSize),away:count(model?.form?.away?.sampleSize)}};}
function proofFor(model){
 // JSON strings preserve the original receipt key order through PostgreSQL
 // jsonb. Its existing verifier hashes JSON.stringify, not canonical JSON.
 const receipts=Array.isArray(model?.inputUsage)?model.inputUsage.map(r=>JSON.stringify(r)):[];
 const proof={receipts,baseBefore:vector(model?.calibrationAdjustment?.oneXTwo?.before),calibratedFinal:vector(model?.calibrationAdjustment?.oneXTwo?.after),baseWeights:Object.fromEntries(BASE_KEYS.filter(k=>model?.ensembleWeights?.[k]!==undefined).map(k=>[k,model.ensembleWeights[k]])),formWeight:finite(model?.lambdaBlend?.formWeight)?model.lambdaBlend.formWeight:null,executionClock:model?.executionClock?JSON.stringify(model.executionClock):null};
 return Buffer.byteLength(JSON.stringify(proof),'utf8')<=MAX_PROOF_BYTES?proof:null;
}
function assess(bound,samples,proof){
 const issues=[],invalid=[],stages=[],weights=Object.fromEntries([...BASE_KEYS,'form'].map(k=>[k,null]));
 for(const family of ['elo','form'])for(const side of ['home','away'])if(samples[family][side]===null)issues.push(`${family}-${side}-samples-missing`);
 if(!bound.modelVersion)issues.push('model-version-missing');
 let receipts=[];
 try{receipts=proof.receipts.map(text=>JSON.parse(text));}catch{invalid.push('receipt-json-invalid');}
 if(!receipts.length)issues.push('arithmetic-receipts-missing');
 if(receipts.length>2)invalid.push('unexpected-receipt-count');
 const seen=new Set();
 for(const receipt of receipts){
  const stage=receipt?.stage;
  if(!['base-outcome-blend','form-lambda-blend'].includes(stage)||seen.has(stage)){invalid.push('receipt-stage-invalid-or-duplicate');continue;}
  seen.add(stage);
  let verified=false;try{verified=verifyModelInputUsage(receipt);}catch{}
  if(!verified)invalid.push(`${stage}-arithmetic-invalid`);
  if(sourceId(receipt.sourceMatchId)!==bound.sourceMatchId||iso(receipt.kickoffTime)!==bound.eventVersion)invalid.push(`${stage}-identity-mismatch`);
  if(!iso(receipt.recordedAt)||instant(receipt.recordedAt)>instant(bound.modelGeneratedAt))invalid.push(`${stage}-clock-mismatch`);
  stages.push({stage,verified,receiptHash:typeof receipt.contentHash==='string'?receipt.contentHash:null,recordedAt:iso(receipt.recordedAt)});
 }
 for(const stage of ['base-outcome-blend','form-lambda-blend'])if(!seen.has(stage))issues.push(`${stage}-receipt-missing`);
 const base=receipts.find(r=>r?.stage==='base-outcome-blend'),form=receipts.find(r=>r?.stage==='form-lambda-blend');
 let clock=null;try{clock=proof.executionClock?JSON.parse(proof.executionClock):null;}catch{invalid.push('execution-clock-invalid');}
 if(clock){
  let valid=false;try{valid=verifyPredictionClock(clock);}catch{}
  if(!valid||clock.events.some((e,i)=>i>0&&e.millis<clock.events[i-1].millis))invalid.push('execution-clock-invalid');
  else if(!clock.events.some(e=>e.operation==='iso'&&e.millis===instant(bound.modelGeneratedAt))||receipts.some(r=>!clock.events.some(e=>e.operation==='iso'&&e.millis===instant(r.recordedAt))))invalid.push('receipt-execution-clock-mismatch');
 }else issues.push('execution-clock-missing');
 if(base){
  if(base.ensemblePolicy && ['elo','form'].some(family => ['home','away'].some(side => base.ensemblePolicy.samples?.[family]?.[side] !== samples[family][side])))invalid.push('ensemble-policy-samples-mismatch');
  if(!proof.baseBefore)issues.push('base-output-binding-missing');
  if(!proof.calibratedFinal)issues.push('final-output-binding-missing');
  else if(!sameProbability(proof.calibratedFinal,bound.final))invalid.push('final-output-mismatch');
  for(const key of BASE_KEYS){
   if(key!=='worldCupPrior'&&!Object.hasOwn(proof.baseWeights,key))issues.push(`${key}-weight-binding-missing`);
   if(Object.hasOwn(proof.baseWeights,key)&&(!finite(proof.baseWeights[key])||proof.baseWeights[key]!==base.weights?.[key]))invalid.push(`${key}-weight-mismatch`);
  }
 }
 if(form&&proof.formWeight===null)issues.push('form-weight-binding-missing');
 if(base&&form&&!invalid.length&&proof.baseBefore&&proof.formWeight!==null){
  const normalizedReceipts=receipts.map(r=>({...r}));
  // Keep source identity exactly as recorded for the shared verifier. Binding
  // above already checked its canonical Sporttery identity.
  const model={generatedAt:bound.modelGeneratedAt,inputUsage:normalizedReceipts,calibrationAdjustment:{oneXTwo:{before:proof.baseBefore}},lambdaBlend:{formWeight:proof.formWeight}};
  let summary=null;try{summary=summarizeModelInputUsage(model,{sourceMatchId:receipts[0].sourceMatchId,kickoffTime:bound.eventVersion});}catch{}
  if(!summary)invalid.push('model-arithmetic-binding-mismatch');
  else if(!issues.some(s=>/binding-missing$|execution-clock-missing|model-version-missing/.test(s))){
   for(const key of BASE_KEYS)weights[key]=base.weights[key];weights.form=form.weight;
  }
 }
 const status=invalid.length?'invalid':BASE_KEYS.every(k=>weights[k]!==null)&&weights.form!==null?'verified':'unknown';
 return {weights,arithmetic:{status,scope:'base-calculation-only',sourceVerified:false,stages},issues:[...new Set([...issues,...invalid])].sort()};
}
function buildInputEvidence(model,match){
 try{
  const bound=binding(model,match);if(!bound)return null;
  const samples=samplesFor(model),proof=proofFor(model);if(!proof)return null;
  const body={version:VERSION,...bound,samples,...assess(bound,samples,proof),proof};
  return {...body,contentHash:hash(body)};
 }catch{return null;}
}
function validInputEvidence(evidence,model,match){
 try{
  if(!object(evidence)||evidence.version!==VERSION||typeof evidence.contentHash!=='string'||!object(evidence.proof))return false;
  const {contentHash,...body}=evidence;if(hash(body)!==contentHash||Buffer.byteLength(JSON.stringify(evidence.proof),'utf8')>MAX_PROOF_BYTES)return false;
  const bound=binding(model,match);if(!bound||Object.keys(bound).some(k=>stable(bound[k])!==stable(evidence[k])))return false;
  if(!object(evidence.samples)||Object.keys(evidence.samples).sort().join(',')!=='elo,form')return false;
  for(const key of ['elo','form'])if(!object(evidence.samples[key])||Object.keys(evidence.samples[key]).sort().join(',')!=='away,home'||['home','away'].some(side=>evidence.samples[key][side]!==null&&count(evidence.samples[key][side])===null))return false;
  if(!Array.isArray(evidence.proof.receipts)||evidence.proof.receipts.some(r=>typeof r!=='string'))return false;
  const actual=assess(bound,evidence.samples,evidence.proof);
  if(actual.arithmetic.status==='invalid'||['weights','arithmetic','issues'].some(k=>stable(actual[k])!==stable(evidence[k])))return false;
  // When the full model is available, also reject re-hashed edits to sample
  // summaries or proofs. Compact models can verify the retained arithmetic.
  if(Array.isArray(model?.inputUsage)){
   const currentProof=proofFor(model);if(!currentProof||stable(samplesFor(model))!==stable(evidence.samples))return false;
   const decoded=proof=>({...proof,receipts:proof.receipts.map(r=>JSON.parse(r)),executionClock:proof.executionClock?JSON.parse(proof.executionClock):null});
   // A full model also passes through jsonb, which changes receipt key order.
   // Verify the retained original strings above, then compare their complete
   // content to the current full model without re-hashing its reordered keys.
   if(stable(decoded(currentProof))!==stable(decoded(evidence.proof)))return false;
  }
  return true;
 }catch{return false;}
}
module.exports={VERSION,MAX_PROOF_BYTES,buildInputEvidence,validInputEvidence};
