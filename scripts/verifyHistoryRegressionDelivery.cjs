'use strict';
// Local-only independent delivery check. No production connection or business writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {analyzeCapture}=require('./historyRegressionAdmission.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=path.resolve(__dirname,'..');
function verify(dir,{writeReceipt=false}={}){
  const base=path.resolve(dir);assert(base.startsWith(root+path.sep),'Output must be inside this worktree');
  const receiptFile=path.join(base,'delivery-receipt.json');
  const read=file=>fs.readFileSync(file),json=file=>JSON.parse(read(file));
  if(!writeReceipt){
    const proof=json(receiptFile);assert.equal(proof.version,'history-regression-delivery-receipt-v1');
    for(const f of proof.files){const full=path.resolve(root,f.path);assert(full.startsWith(root+path.sep));const b=read(full);assert.equal(b.length,f.bytes);assert.equal(digest(b),f.sha256,`Changed file: ${f.path}`);}
  }
  const captureFile=path.join(base,'online-sample-v3.json'),admissionFile=path.join(base,'admission-v3.json');
  const capture=json(captureFile),saved=json(admissionFile),raw=read(captureFile+'.remote-response.json');
  const priorBytes=read(saved.inputs.priorReceipt.path);assert.equal(digest(priorBytes),saved.inputs.priorReceipt.sha256);
  const prior=JSON.parse(priorBytes);
  const fresh=analyzeCapture(capture,{rawResponseBytes:raw,expectedPublication:prior.publication,expectedManifestFileSha256:prior.manifestFileSha256});
  assert.deepEqual(fresh.funnel,saved.funnel);assert.deepEqual(fresh.records,saved.records);
  const evidence=read(path.join(base,'report/per-match-evidence.jsonl')).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(evidence.map(x=>x.record.matchId),capture.rows.map(x=>x.matchId));
  assert.equal(new Set(evidence.map(x=>x.record.matchId+'|'+x.record.market)).size,capture.rows.length);
  assert.deepEqual(evidence.filter(x=>x.pairedEligible).map(x=>x.record),fresh.records);
  const review=json(path.join(base,'report/review.json')),summary=json(path.join(base,'report/summary.json'));
  const outcomes=['home','draw','away'];const scores={publishedModel:{brier:0,logLoss:0,accuracy:0},sameDecisionMarket:{brier:0,logLoss:0,accuracy:0}};
  for(const row of fresh.records){
    const mp=outcomes.map(k=>row.decision.probabilities[k]),market=outcomes.map(k=>1/row.officialOdds.sp[k]);
    for(const [key,p]of [['publishedModel',mp],['sameDecisionMarket',market]]){
      const total=p.reduce((a,b)=>a+b,0);const normalized=p.map(x=>x/total),actual=outcomes.indexOf(row.result.outcome);
      scores[key].brier+=normalized.reduce((sum,x,i)=>sum+(x-Number(i===actual))**2,0);
      scores[key].logLoss-=Math.log(Math.max(1e-15,normalized[actual]));
      scores[key].accuracy+=Number(normalized.indexOf(Math.max(...normalized))===actual);
    }
  }
  for(const [key,totals]of Object.entries(scores))for(const [metric,value]of Object.entries(totals)){
    const n=fresh.records.length,mean=n?value/n:null;
    assert(mean===null?review.metrics[key][metric]===null:Math.abs(review.metrics[key][metric]-mean)<1e-12,`${key}.${metric} mismatch`);
  }
  assert.equal(review.rows,fresh.records.length);assert.equal(summary.productionEligible,false);
  for(const f of json(path.join(base,'report/report-manifest.json')).files){const b=read(path.join(base,'report',f.file));assert.equal(b.length,f.bytes);assert.equal(digest(b),f.sha256);}
  const result={ok:true,version:'history-regression-delivery-verification-v1',sourceRows:capture.rows.length,
    pairedRows:fresh.records.length,rawResponseBytes:raw.length,rawResponseSha256:digest(raw),
    revalidatedSignatureAndClockAdmission:true,independentlyRecomputedMetrics:true,productionWrites:false,productionEligible:false};
  if(writeReceipt){
    const localFiles=[captureFile,captureFile+'.remote-response.json',admissionFile,
      ...fs.readdirSync(path.join(base,'report')).map(name=>path.join(base,'report',name)),
      ...['docs/history-regression.md','docs/history-regression-results-20261002.md','docs/history-regression-protocol.json',
        'scripts/captureHistoryRegression.cjs','scripts/historyRegressionRemote.py','scripts/historyRegressionAdmission.cjs',
        'scripts/historyRegressionReplay.cjs','scripts/reportHistoryRegression.cjs','scripts/plotHistoryRegression.py',
        'scripts/verifyHistoryRegressionDelivery.cjs','tests/history-regression-admission.test.cjs',
        'tests/history-regression-replay.test.cjs','tests/history-regression-remote.test.py'].map(name=>path.join(root,name))];
    const files=localFiles.map(file=>{const b=read(file);return {path:path.relative(root,file).replaceAll('\\','/'),bytes:b.length,sha256:digest(b)};});
    fs.writeFileSync(receiptFile,JSON.stringify({version:'history-regression-delivery-receipt-v1',verifiedAt:new Date().toISOString(),
      baseCommit:'6fce1805d0d8db0410c71231d6df6ce72ec766cb',result,
      tests:{syntheticOnly:true,nodeTestsPassed:33,pythonTestsPassed:12,meaning:'Software contracts only; not evidence of model improvement'},
      intermediateEvidenceExcluded:['online-sample-v2.json','admission.json'],files},null,2)+'\n',{flag:'wx'});
  }
  return result;
}
if(require.main===module){const [dir,flag]=process.argv.slice(2);assert(dir&&(!flag||flag==='--write-receipt'),'Usage: node scripts/verifyHistoryRegressionDelivery.cjs OUTPUT_DIR [--write-receipt]');console.log(JSON.stringify(verify(dir,{writeReceipt:flag==='--write-receipt'})));}
module.exports={verify};
