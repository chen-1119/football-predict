'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {verifyOnlineRead,MAX_BYTES,IDENTITY_VERSION,loadTrustedRegistry,identityOptionsFor} = require('./readPrematchV3OnlineInputs.cjs');
const {buildPrematchV3Assessment} = require('../src/services/prematchV3Assessment.cjs');
const {freezePrematchV3Record} = require('../src/services/prematchV3FrozenRecord.cjs');
const {epochNanoseconds:clock} = require('../src/services/prematchV3Clock.cjs');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');
const HASH = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const VERSION = 'prematch-v3-online-shadow-report-v1';
const IMPLEMENTATION_FILES = ['scripts/runPrematchV3Shadow.cjs','scripts/readPrematchV3OnlineInputs.cjs',
  'src/services/prematchV3OnlineResponse.cjs',
  'src/services/prematchV3InputIdentity.cjs','src/services/collectorAttestation.cjs',
  'scripts/recommendationPlatform/liveOfficialHad.cjs','scripts/storedResultTeamIdentity.cjs',
  'server/relayCollectorEvidence.cjs','scripts/sportteryEndpointContract.cjs',
  'scripts/dynamicGoalStrengthModel.cjs','src/services/prematchV3Assessment.cjs','src/services/prematchV3Clock.cjs',
  'src/services/prematchTeamEvidenceV3.cjs','src/services/prematchEvidenceCoverage.cjs','src/services/asianHandicapEvidenceV3.cjs',
  'src/services/prematchV3Learning.cjs','src/services/prematchV3FeedbackLoop.cjs','src/services/prematchV3FrozenRecord.cjs',
  'src/services/prematchV3ModelRegistry.cjs','src/services/formNeedPressure.cjs','src/services/prospectiveForecastInput.cjs',
  'src/services/strictInstant.cjs','src/services/sportteryDeadlineClock.cjs','src/services/webConsensusEvidence.cjs','src/services/goalDistribution.cjs',
  'src/services/matchLifecycle.cjs','scripts/historicalAsOfFeatureBuilder.cjs',
  'scripts/modelLearningRegistry.cjs','scripts/releaseSshHostKeyPin.cjs'];
function check(value, code) {if (!value) throw Error(`V3_SHADOW_${code}`);}
function parseArgs(args) {
  const result = {};
  for(let i=0;i<args.length;i+=2) {
    check(['--input','--output'].includes(args[i]) && !result[args[i]] && typeof args[i+1]==='string' && !args[i+1].startsWith('--'),'ARGS');
    result[args[i]]=args[i+1];
  }
  check(result['--input'] && result['--output'],'ARGS');
  return {input:result['--input'],output:result['--output']};
}
function buildReport(input, {asOf,implementationHashes,gitHead,trustRegistry}) {
  check(clock(asOf)!==null && clock(input.observedAt)!==null && clock(asOf)>=clock(input.observedAt)
    &&(input.version!==IDENTITY_VERSION||(clock(input.identitySource?.inputCapturedAt)!==null
      &&clock(asOf)>=clock(input.identitySource.inputCapturedAt))),'CALCULATION_CLOCK');
  const modelRead = require('../src/services/prematchV3ModelRegistry.cjs').readPrematchV3RegistryFromOnlineInput(input,{asOf,trustRegistry});
  const assessmentOptions={asOf,baseline:modelRead.baseline,parameters:modelRead.parameters,
    modelRegistry:{asOf:modelRead.asOf,status:modelRead.status,storage:modelRead.storage,
      blockers:modelRead.blockers,receipts:modelRead.receipts,parameterValidation:modelRead.parameterValidation||null}};
  const rows = input.matches.map((match,index) => {
    const options={...assessmentOptions,...identityOptionsFor(input,index,trustRegistry)};
    const assessment=buildPrematchV3Assessment(match,options);
    return {id:match.id,sourceMatchId:match.sourceMatchId,homeTeamName:match.homeTeamName,awayTeamName:match.awayTeamName,
      assessment, frozenLearningRecord:freezePrematchV3Record(assessment,{match,options})};
  });
  const known = family => rows.filter(row => ['home','away'].every(side => Object.entries(row.assessment.teamSnapshot.features)
    .some(([key,value]) => key.startsWith(`${side}.${family}.`) && typeof value==='number'))).length;
  const blockers = {};
  rows.forEach(row => row.assessment.blockers.forEach(reason => {blockers[reason]=(blockers[reason]||0)+1;}));
  const body = {version:VERSION,calculatedAt:asOf,formalEligible:false,productionEligible:false,
    input:{businessDate:input.businessDate,observedAt:input.observedAt,generation:input.generation,
      remoteResponseSha256:input.transport.remoteResponseSha256,readOnly:input.readOnly,productionWrites:input.productionWrites,
      transportClock:input.transport.observedClockOrder,
      evidenceScope:'replay-of-recorded-pinned-online-read;content-binding-is-not-source-or-model-admission'},
    implementation:{gitHead,files:implementationHashes,nodeVersion:process.version},
    summary:{matches:rows.length,marketReferences:rows.filter(row=>row.assessment.comparisons.marketOnly.available).length,
      zeroMarketBaselines:rows.filter(row=>row.assessment.baseline.status==='shadow-ready').length,
      calculatedTeamCandidates:rows.filter(row=>row.assessment.comparisons.teamOnly).length,
      asianTimelines:rows.filter(row=>row.assessment.asianTimeline.available).length,
      bothTeamsWithKnownV3Features:Object.fromEntries(['roster','injuries','fatigue','history','xg'].map(family=>[family,known(family)])),
      modelArtifactsInOnlineInventory:input.modelArtifactInventory.length,
      modelRegistryReadStatus:modelRead.status,
      newFrozenLearningRecords:rows.filter(row=>row.frozenLearningRecord).length,formalRecommendations:0,blockers},
    learning:{status:'not-trained-on-this-read',accuracyMeasured:false,hitRate:null,
      reason:'current-input-coverage-is-not-a-settled-prospective-training-or-test-set'},
    invariants:{productionWrites:0,originalInputChanged:false,frozenDecisionsChanged:false,forcedCombos:0},rows};
  return {...body,contentHash:stableHash(body)};
}
function run({input,output}) {
  check(require.main===module,'STANDALONE_CLI_REQUIRED');
  check(Number(process.versions.node.split('.')[0])===22,'NODE22_REQUIRED');
  const inputPath=path.resolve(input),outputPath=path.resolve(output);
  check(!fs.existsSync(outputPath) && fs.statSync(path.dirname(outputPath)).isDirectory(),'NEW_OUTPUT_REQUIRED');
  check(fs.statSync(inputPath).size<=MAX_BYTES*2,'INPUT_BOUND');
  const inputBytes=fs.readFileSync(inputPath),value=JSON.parse(inputBytes.toString('utf8'));
  const rawPath=path.join(path.dirname(inputPath),value.transport?.remoteResponseFile || '');
  check(path.dirname(rawPath)===path.dirname(inputPath) && rawPath!==inputPath && fs.statSync(rawPath).size<=MAX_BYTES,'RAW_INPUT_BOUND');
  const raw=fs.readFileSync(rawPath);
  const trustRegistry=value.version===IDENTITY_VERSION?loadTrustedRegistry():undefined;
  check(verifyOnlineRead(value,{date:value.businessDate,rawResponse:raw,trustRegistry}),'ONLINE_READ_BINDING');
  const repo=path.resolve(__dirname,'..');
  const implementationHashes=Object.fromEntries(IMPLEMENTATION_FILES.map(file=>[file,HASH(fs.readFileSync(path.join(repo,file)))]));
  const gitHead=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  const report=buildReport(value,{asOf:new Date().toISOString(),implementationHashes,gitHead,trustRegistry});
  const implementationAfter=Object.fromEntries(IMPLEMENTATION_FILES.map(file=>[file,HASH(fs.readFileSync(path.join(repo,file)))]));
  check(stableHash(implementationAfter)===stableHash(implementationHashes),'IMPLEMENTATION_CHANGED_DURING_RUN');
  check(HASH(fs.readFileSync(inputPath))===HASH(inputBytes) && HASH(fs.readFileSync(rawPath))===HASH(raw),'INPUT_CHANGED');
  fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return {output:outputPath,contentHash:report.contentHash,calculatedAt:report.calculatedAt,summary:report.summary,productionWrites:0};
}
if(require.main===module) {
  try {console.log(JSON.stringify(run(parseArgs(process.argv.slice(2)))));}
  catch(error) {console.error(/^V3_SHADOW_[A-Z0-9_]+$/.test(error.message)?error.message:'V3_SHADOW_FAILED');process.exitCode=1;}
}
module.exports={VERSION,IMPLEMENTATION_FILES,parseArgs,buildReport,run};
