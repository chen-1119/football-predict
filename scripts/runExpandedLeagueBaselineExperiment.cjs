'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {load}=require('./expandedLeagueTrainingInput.cjs');
const {experiment}=require('./runLeagueBaselineExperiment.cjs');
const {hash}=require('./expandedLeagueHistoryParser.cjs');
const VERSION='expanded-league-elo-poisson-experiment-v2';
const partitions=report=>({...report,reports:report.reports.map(result=>result.split?{...result,split:{...result.split,train:'before-2024'}}:result)});
function implementation(){
  return Object.fromEntries(['runExpandedLeagueBaselineExperiment.cjs','runLeagueBaselineExperiment.cjs','expandedLeagueTrainingInput.cjs','collectExpandedLeagueHistory.cjs','expandedLeagueHistoryParser.cjs',
    '../src/services/leagueBaselineScope.cjs'].map(file=>[file,hash(fs.readFileSync(path.resolve(__dirname,file)))]));
}
function inspect(history,reportBytes,league){
  const report=JSON.parse(reportBytes),{contentHash,...body}=report;
  assert.equal(hash(JSON.stringify(body)),contentHash,'report content hash');
  assert.equal(report.version,VERSION,'report version');
  assert.equal(report.league,league,'report league');
  assert.equal(report.inputSha256,history.sha256,'report input hash');
  assert.equal(report.historyContentHash,history.document.contentHash,'report history binding');
  assert.deepEqual(report.implementation,implementation(),'report implementation');
  assert(Number.isFinite(Date.parse(report.startedAt))&&report.startedAt<=report.completedAt
    &&history.document.knownAt<=report.startedAt,'fit chronology');
  const replay=partitions(experiment(history.rows));
  assert.deepEqual(report.reports,replay.reports,'fit replay');
  return report;
}
function run(input,league,output){
  assert(process.versions.node.split('.')[0]==='22','Node 22 required');
  assert(path.isAbsolute(output)&&!fs.existsSync(output),'new absolute output');
  const history=load(input,league),startedAt=new Date().toISOString(),result=partitions(experiment(history.rows));
  const report={...result,version:VERSION,league,startedAt,completedAt:new Date().toISOString(),inputSha256:history.sha256,
    historyContentHash:history.document.contentHash,implementation:implementation()};
  report.contentHash=hash(JSON.stringify(report));
  fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  const selected=report.reports[0];
  return {output,contentHash:report.contentHash,league,durationMs:Date.parse(report.completedAt)-Date.parse(startedAt),
    status:selected.status,chosenWeight:selected.selection?.weight,statisticalGatePassed:selected.statisticalGatePassed,
    purePoissonEligible:selected.selection?.weight===1,converged:selected.forwardCandidate?.poisson.converged,
    evaluation:selected.evaluation,coverage:selected.coverage,formalEligible:false,productionWrites:0};
}
if(require.main===module){try{console.log(JSON.stringify(run(...process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={VERSION,run,inspect,implementation};
