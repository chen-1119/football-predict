'use strict';

// Read-only forensic audit. Descriptive source-snapshot counts are not live
// recommendations, results, a backtest, or evidence that accuracy improved.
const fs=require('node:fs'), path=require('node:path');
const {validTriplet,uniquePrimary,CODES}=require('../src/services/primaryDirectionAdmission.cjs');
const tallies=()=>({'1':0,X:0,'2':0,tied:0,missing:0});
function normalize(p){
 if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const v=[p.home??p['1'],p.draw??p.X,p.away??p['2']];
 if(!v.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0))return null;
 const total=v.reduce((a,b)=>a+b,0);
 if(!(Math.abs(total-1)<=.02||Math.abs(total-100)<=.5))return null;
 return Object.fromEntries(CODES.map((c,i)=>[c,v[i]/total]));
}
function marketOdds(raw){
 const v=[raw?.odds1??raw?.['1'],raw?.oddsX??raw?.X,raw?.odds2??raw?.['2']];
 if(!v.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>1))return null;
 const total=v.reduce((a,b)=>a+1/b,0);return Object.fromEntries(CODES.map((c,i)=>[c,(1/v[i])/total]));
}
function register(counts,p){const leader=uniquePrimary(p);counts[leader||(validTriplet(p)?'tied':'missing')]++;return leader;}
function auditRows(rows){
 if(!Array.isArray(rows))throw new TypeError('rows must be an array');
 const stages={preCalibration:tallies(),finalModel:tallies(),market:tallies(),exposedBest:tallies()};
 const components=Object.fromEntries(['market','teamStrength','elo','poisson','worldCupPrior'].map(k=>[k,tallies()]));
 const result={version:'outcome-selection-source-audit-v1',scope:'repository-snapshot-not-live-or-performance',inputRows:rows.length,stages,components,
   primary:{favorite:0,draw:0,nonfavorite:0,marketTied:0,marketMissing:0},thinLeads:{favorite:0,draw:0,nonfavorite:0},
   comparedWithMarket:0,agreesWithMarket:0,preCalibrationToFavorite:0,preCalibrationAwayFromFavorite:0,
   modelEvidence:{verified:0,unknown:0,hasNoIndependentWeightedComponent:0},skipped:[],examples:[],missingFinalDiagnostics:[],alerts:[],forcedQuota:false};
 for(const parent of rows){
   const m=parent?.prospectiveForecastInput||parent,model=m?.probabilityModel;
   if(!m||typeof m!=='object'){result.skipped.push('invalid-row');continue;}
   if(parent.prospectiveForecastInput && (m.id!==parent.id || Date.parse(m.eventVersion||m.kickoffTime)!==Date.parse(parent.eventVersion||parent.kickoffTime))){result.skipped.push('prospective-event-mismatch');continue;}
   const baseReceipt=(Array.isArray(model?.inputUsage)?model.inputUsage:[]).find(r=>r?.stage==='base-outcome-blend');
   const raw=normalize(model?.calibrationAdjustment?.oneXTwo?.before||baseReceipt?.output);
   const final=normalize(model?.oneXTwo?.final);
   const market=normalize(model?.oneXTwo?.market)||marketOdds(m.odds);
   const before=register(stages.preCalibration,raw),after=register(stages.finalModel,final),fav=register(stages.market,market);
   const best=(Array.isArray(parent.predictions)?parent.predictions:[]).find(p=>p?.marketType==='BEST'&&CODES.includes(p.tipCode));stages.exposedBest[best?.tipCode||'missing']++;
   for(const [key,counts] of Object.entries(components))register(counts,normalize(baseReceipt?.inputs?.[key]));
   const e=model?.inputEvidence;
   result.modelEvidence[e?.arithmetic?.status==='verified'?'verified':'unknown']++;
   if(baseReceipt?.weights&&['elo','poisson','teamStrength','worldCupPrior'].every(k=>!baseReceipt.weights[k]))result.modelEvidence.hasNoIndependentWeightedComponent++;
   if(!after){
     if(result.missingFinalDiagnostics.length<5)result.missingFinalDiagnostics.push({matchId:m.id,status:m.status||null,modelVersion:model?.version||null,
       modelKeys:model?Object.keys(model).slice(0,50):[],oneXTwoKeys:model?.oneXTwo?Object.keys(model.oneXTwo):[],
       finalType:model?.oneXTwo?.final===null?'null':typeof model?.oneXTwo?.final,
       finalKeys:model?.oneXTwo?.final&&typeof model.oneXTwo.final==='object'?Object.keys(model.oneXTwo.final):[],
       finalNumericValues:model?.oneXTwo?.final&&typeof model.oneXTwo.final==='object'?Object.fromEntries(Object.entries(model.oneXTwo.final).filter(([,v])=>typeof v==='number')):null,
       calibrationAfterDiagnosticOnly:normalize(model?.calibrationAdjustment?.oneXTwo?.after),
       inputEvidencePresent:Boolean(e),prospectiveInputUsed:Boolean(parent.prospectiveForecastInput),
       publishedReferenceCode:parent.predictionMeta?.publicReferenceDecision?.prediction?.tipCode||null});
     continue;
   }
   const category=after==='X'?'draw':!market?'marketMissing':!fav?'marketTied':after===fav?'favorite':'nonfavorite';
   result.primary[category]++;
   const lead=final[after]-Math.max(...CODES.filter(c=>c!==after).map(c=>final[c]));
   if(lead<.06&&Object.hasOwn(result.thinLeads,category))result.thinLeads[category]++;
   if(fav){result.comparedWithMarket++;result.agreesWithMarket+=Number(after===fav);
     if(before&&before!==after){result.preCalibrationToFavorite+=Number(after===fav);result.preCalibrationAwayFromFavorite+=Number(before===fav);}}
   if(result.examples.length<12&&(after==='X'||after!==fav||lead<.06))result.examples.push({matchId:m.id,source:m.oddsSource||null,home:m.homeTeamName,away:m.awayTeamName,
     modelGeneratedAt:model?.generatedAt||null,raw,final,market,modelLeader:after,marketLeader:fav,category,probabilityLead:lead,exposedBest:best?.tipCode||null,weights:baseReceipt?.weights||null});
 }
 result.marketAgreementRate=result.comparedWithMarket?result.agreesWithMarket/result.comparedWithMarket:null;
 if(result.comparedWithMarket>=5&&result.marketAgreementRate>=.95)result.alerts.push('market-leader-agreement-at-least-95pct-review-inputs');
 if(stages.exposedBest.missing>0)result.alerts.push('legacy-BEST-does-not-cover-all-model-rows');
 if(stages.finalModel.missing>0)result.alerts.push('final-probabilities-unavailable-do-not-infer-live-direction-distribution');
 if(result.preCalibrationToFavorite>0)result.alerts.push('some-precalibration-leaders-flipped-to-market-favorite');
 if(result.modelEvidence.hasNoIndependentWeightedComponent)result.alerts.push('market-only-arithmetic-present');
 return result;
}
function main(){
 const args=process.argv.slice(2),get=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
 const input=path.resolve(get('--input',path.join(__dirname,'../public/data/matches-current.json')));
 const {readChunkedJsonFile}=require('../server/chunkedJsonFile.cjs');
 const loaded=readChunkedJsonFile(input,{maxBytes:1024**3});
 const report={...auditRows(loaded.value),inputEvidence:loaded.evidence};
 const output=get('--output',null); if(output){fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
 console.log('OUTCOME_AUDIT_BEGIN\n'+JSON.stringify(report,null,2)+'\nOUTCOME_AUDIT_END');
}
if(require.main===module)main();
module.exports={normalize,marketOdds,auditRows};
