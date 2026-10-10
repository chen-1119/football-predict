'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {buildPack}=require('./fixedPrematchEvidencePack.cjs');
const {loadCollectorTrustRegistry}=require('../src/services/collectorAttestation.cjs');
function main(){const [input,output,businessDate]=process.argv.slice(2);assert(input&&output&&path.isAbsolute(input)&&path.isAbsolute(output),'absolute input/output paths required');
 const st=fs.lstatSync(input);assert(st.isFile()&&!st.isSymbolicLink()&&st.size<=10*1024*1024,'input bound');
 const capture=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
 const pack=buildPack(capture,{businessDate,asOf:new Date().toISOString(),trustRegistry:loadCollectorTrustRegistry(path.resolve(__dirname,'../deploy/light-server/collector-trust-registry.json'))});
 fs.writeFileSync(output,JSON.stringify(pack,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({output,contentHash:pack.contentHash,records:pack.records.length,analysisNeeded:pack.records.filter(r=>r.recommendation.status==='analysis-needed').length,productionWrites:0}));}
if(require.main===module)main();
