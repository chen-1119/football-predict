'use strict';
// Report only: consumes the explicit independently admitted capture, never local business data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {summarizePublishedHistory,runHistoryRegressionReplay}=require('./historyRegressionReplay.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function buildReports(admission,config){
  const records=admission.records;
  const review=summarizePublishedHistory(records,{source:admission.source,timeZone:config.timeZone,bootstrap:config.bootstrap});
  const replay=runHistoryRegressionReplay(records,{...config,source:{...admission.source,...config.source}});
  const modelVersions={},observationDatesUtc={};
  for(const row of records){modelVersions[row.decision.modelVersion]=(modelVersions[row.decision.modelVersion]||0)+1;
    const date=new Date(row.result.observedAt).toISOString().slice(0,10);observationDatesUtc[date]=(observationDatesUtc[date]||0)+1;}
  const lags=records.map(r=>(Date.parse(r.result.observedAt)-Date.parse(r.kickoffAt))/3600000).sort((a,b)=>a-b);
  const maxKey=p=>Object.keys(p).sort((a,b)=>p[b]-p[a])[0];
  const attributions=admission.inspections.map(x=>{
    const r=x.record,tags=[];
    if(r.features.missing.length)tags.push('data-missing-or-unverified');
    if(x.reasons.some(v=>/clock|observation|attestation/.test(v)))tags.push('clock-or-provenance-ineligible');
    let conflict=null;
    if(x.pairedEligible){const market=Object.fromEntries(Object.entries(r.officialOdds.sp).map(([k,v])=>[k,1/v]));
      conflict=maxKey(market)!==maxKey(r.decision.probabilities);if(conflict)tags.push('model-market-direction-conflict');}
    return {matchId:r.matchId,market:r.market,kickoffAt:r.kickoffAt,league:r.league,decisionId:r.decision.id,
      originalEligible:x.originalEligible,pairedEligible:x.pairedEligible,exclusions:x.reasons,
      descriptiveTags:tags,marketConflict:conflict,actual:r.result.outcome,
      prediction:x.originalEligible?maxKey(r.decision.probabilities):null,
      note:'Tags identify evidence and error patterns, not causal proof of why a match was lost.'};
  });
  const summary={version:'history-regression-delivery-v1',productionEligible:false,productionWrites:false,
    publication:admission.source.publication,inputProof:admission.inputs,funnel:admission.funnel,
    coverage:{denominator:admission.funnel.selected,scope:'All independent settled matches selected in the declared September window',
      frozenProbability:admission.funnel.selected?admission.funnel.frozenProbabilityScorable/admission.funnel.selected:null,
      pairedMarket:admission.funnel.selected?admission.funnel.sameDecisionPaired/admission.funnel.selected:null,
      timeAuditedFeatureReplay:0},
    recomputedFrozenPair:{rows:review.rows,matchDays:review.matchDays,metrics:review.metrics,pairedAgainstMarket:review.pairedAgainstMarket},
    recordedClocks:{modelVersions,observationDatesUtc,resultReceiptLagHours:lags.length?{min:lags[0],median:lags[Math.floor(lags.length/2)],max:lags.at(-1)}:null,
      meaning:'Preserved receipt clocks in this generation, not a claim these were the first ever observations.'},
    candidateReplay:{protocolHash:replay.protocolHash,selection:replay.selection,
      folds:replay.folds?.map(f=>({id:f.id,counts:f.counts,pluginStatus:f.pluginStatus})),
      finalTest:{rows:replay.finalTest.rows,metrics:replay.finalTest.metrics,pluginStatus:replay.finalTest.pluginStatus}},
    causalAttributionAvailable:false,causalAttributionReason:'No controlled, time-valid field ablation has been completed.',
    historicalPublished145Reproduced:false,
    historicalPublished145Limitation:'Publication report also filters historical-feature training/watermarks; this batch has its own fixed window and event set.',
    sourceTrustBoundary:'Collector signatures and extraction commitments are independently verified against the captured public trust registry; raw provider HTTP payloads are not re-fetched or independently re-parsed.',
    nextInterfaces:{dataSource:'Export historical feature values with event ID, field, payload SHA, providerObservedAt, receivedAt, availableAt, source/authorization; preserve original missingness.',
      recommendation:'Provide audited pure candidate adapter fit/calibrate/predict with version+implementationHash, fixed before validation; never write shared calibration module here.',
      interface:'Read summary + per-match evidence; show cohort/window/coverage and distinguish frozen review from candidate replay.',
      quality:'Recompute capture byte SHA, publication binding, signature/clock admission, event IDs and per-day paired metrics; synthetic tests are separate.'},
    modelDefects:['Published aggregate model Brier/LogLoss trails its same-decision market baseline; deployment success does not establish model quality.',
      'Original result reception times and feature availability must be preserved; late observations cannot be backdated for training.',
      'A feature hash or connected-source flag is insufficient to audit individual lineup/injury/weather/xG inputs.',
      'The existing strict 145-event sample conflates original frozen probability evidence with reconstructed history feature eligibility.',
      'League/odds/class groups and calibration curves expose patterns but do not establish transferability or causal explanations.'],
    reusableBaselines:{file:'scripts/dynamicGoalStrengthModel.cjs',interfaces:['buildDynamicGoalStrengthArtifact','evaluateDynamicGoalStrengthWalkForward'],
      status:'Identified, not run on unverified seeds. Explicit entity IDs and trustworthy result availability required.',
      clockCaution:'Existing day builder uses UTC day start; enforce forecastBoundary <= originalDecisionAt before adapting Shanghai match days.'},
    methodSources:['https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html','https://scikit-learn.org/stable/modules/calibration.html']};
  return {summary,review,replay,attributions};
}
if(require.main===module){
  const [admissionFile,configFile,outDir]=process.argv.slice(2);if(!outDir)throw Error('Usage: node scripts/reportHistoryRegression.cjs ADMISSION.json PROTOCOL.json OUTPUT_DIR');
  const b=fs.readFileSync(admissionFile),c=fs.readFileSync(configFile),admission=JSON.parse(b),reports=buildReports(admission,JSON.parse(c));
  reports.summary.reportInputs={admission:{path:path.resolve(admissionFile),sha256:sha(b)},protocol:{path:path.resolve(configFile),sha256:sha(c)}};
  reports.summary.validator={runtime:process.version,baseCommit:'6fce1805d0d8db0410c71231d6df6ce72ec766cb',
    meaning:'Offline validators from this branch; does not establish that these fixes execute in production.',
    files:['scripts/historyRegressionAdmission.cjs','scripts/historyRegressionReplay.cjs','scripts/reportHistoryRegression.cjs',
      'src/services/decisionSnapshot.cjs','src/services/decisionEventIdentity.cjs','src/services/marketSourceProvenance.cjs',
      'src/services/collectorAttestation.cjs','scripts/asOfResultTimeline.cjs'].map(file=>({file,sha256:sha(fs.readFileSync(path.join(__dirname,'..',file)))}))};
  fs.mkdirSync(outDir,{recursive:true});
  const files=[];
  for(const [name,value]of Object.entries(reports)){const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),file=name+'.json';fs.writeFileSync(path.join(outDir,file),bytes,{flag:'wx'});files.push({file,bytes:bytes.length,sha256:sha(bytes)});}
  const evidence=Buffer.from(admission.inspections.map(row=>JSON.stringify({record:row.record,originalEligible:row.originalEligible,
    pairedEligible:row.pairedEligible,primaryReason:row.primaryReason,reasons:row.reasons,clockBlockers:row.clockBlockers,
    providerBlockers:row.providerBlockers,snapshotSelectionAudit:row.snapshotSelectionAudit})).join('\n')+'\n');
  fs.writeFileSync(path.join(outDir,'per-match-evidence.jsonl'),evidence,{flag:'wx'});
  files.push({file:'per-match-evidence.jsonl',bytes:evidence.length,sha256:sha(evidence)});
  fs.writeFileSync(path.join(outDir,'report-manifest.json'),JSON.stringify({version:'history-regression-report-manifest-v1',files},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({outDir,rows:reports.review.rows,metrics:reports.review.metrics,selection:reports.replay.selection}));
}
module.exports={buildReports};
