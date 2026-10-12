'use strict';
// Actual candidate compatibility check only. It cannot authorize a registry
// write, rename the candidate schema, or fabricate a V3 training request.
const fs=require('node:fs'),path=require('node:path');
const {hash}=require('./collectLeagueTextHistory.cjs');
const {experiment,VERSION:EXPERIMENT_VERSION}=require('./runLeagueBaselineExperiment.cjs');
const {verifyTrainingRun}=require('./registerPrematchV3Parameters.cjs');
const {validateStoredPrematchV3Artifact}=require('../src/services/prematchV3ModelRegistry.cjs');
function inspect(historyBytes,reportBytes,asOf=new Date().toISOString()){
  if(historyBytes.length>16*1024*1024||reportBytes.length>16*1024*1024)throw Error('REGISTRATION_PREPARE_OVERSIZED');
  const history=JSON.parse(historyBytes),report=JSON.parse(reportBytes);
  const {contentHash:historyHash,...historyBody}=history,{contentHash:reportHash,...reportBody}=report;
  if(hash(JSON.stringify(historyBody))!==historyHash||hash(JSON.stringify(reportBody))!==reportHash
    ||report.version!==EXPERIMENT_VERSION||report.inputSha256!==hash(historyBytes)||report.historyContentHash!==historyHash)
    throw Error('REGISTRATION_PREPARE_INPUT_BINDING');
  if(report.implementationSha256!==hash(fs.readFileSync(require.resolve('./runLeagueBaselineExperiment.cjs')))
    ||report.parserSha256!==hash(fs.readFileSync(require.resolve('./collectLeagueTextHistory.cjs'))))throw Error('REGISTRATION_PREPARE_IMPLEMENTATION');
  const expected=experiment(history.rows);
  if(hash(JSON.stringify(expected.reports))!==hash(JSON.stringify(report.reports)))throw Error('REGISTRATION_PREPARE_FIT_REPLAY');
  let trainingVerifier;
  try{verifyTrainingRun(historyBytes,report);trainingVerifier={accepted:true};}
  catch(e){trainingVerifier={accepted:false,code:/^V3_[A-Z_]+$/.test(e.message)?e.message:'V3_FORMAT_REJECTED'};}
  // Exercise the real loader against the unmodified report, with its actual
  // version and actual creation clock. This is a local hypothetical row only.
  const payloadJson=JSON.stringify(report),stored={storage:'postgres',artifactKey:'prematch-v3-baseline',
    artifactVersion:report.version,generatedAt:report.completedAt,updatedAt:report.completedAt,
    payload:report,payloadJson,payloadBytes:Buffer.byteLength(payloadJson),payloadSha256:hash(payloadJson)};
  const loader=validateStoredPrematchV3Artifact(stored,'baseline',asOf);
  return {version:'league-model-registration-preparation-v1',observedAt:asOf,
    researchFitReplayed:true,candidateSha256:hash(reportBytes),historySha256:hash(historyBytes),
    originalTrainingVersion:report.version,trainingVerifier,existingLoader:{accepted:loader.valid===true,reasons:loader.blockers},
    readyToRegister:false,registrationCommand:null,productionWrites:0,formalEligible:false,
    blockers:['research-candidate-format-has-no-reviewed-V3-adapter','validated-V3-feature-parameter-packet-missing',
      'same-time-market-heldout-comparison-missing','canonical-team-and-venue-mapping-unapproved'],
    unchangedProbabilityModel:true};
}
function prepare(input,report,output){
  if(![input,report,output].every(p=>typeof p==='string'&&path.isAbsolute(p))||fs.existsSync(output))throw Error('REGISTRATION_PREPARE_NEW_OUTPUT');
  const result=inspect(fs.readFileSync(input),fs.readFileSync(report));
  fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return {output,...result};
}
if(require.main===module){try{console.log(JSON.stringify(prepare(...process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={inspect,prepare};
