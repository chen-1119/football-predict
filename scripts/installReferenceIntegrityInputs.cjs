'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
  assert.equal(process.argv.length,2);
  const root='/opt/football-predict';
  assert.equal(fs.realpathSync(path.resolve(__dirname,'..')),root);
  const plan=await require('./activateReferenceIntegrity.cjs').inspect();
  const result=require('../server/referenceIntegrityPartition.cjs').installReferenceIntegrityInputs();
  console.log(JSON.stringify({ok:true,releaseSha256:plan.currentSha256,...result}));
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={main};
