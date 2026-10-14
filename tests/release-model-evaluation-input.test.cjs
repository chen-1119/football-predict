'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),c=require('node:crypto');
const {inspectModelEvaluationFile:inspect}=require('../scripts/releaseModelEvaluationInput.cjs');
test('model input preserves exact admitted bytes; missing, malformed and changed protocols fail closed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-model-input-')),file=path.join(root,'evaluation.json');
 try{
  a.equal(inspect(file).ok,false);
  const value={ok:true,version:'rolling-backtest-v19',walkForwardValidation:{version:'walk-forward-promotion-validation-v3',protocolVersion:'nested-expanding-window-candidate-selection-v2'}};
  const raw=JSON.stringify(value)+'\n';fs.writeFileSync(file,raw);
  a.deepEqual(inspect(file),{ok:true,bytes:Buffer.byteLength(raw),sha256:c.createHash('sha256').update(raw).digest('hex'),version:value.version});
  for(const changed of [{...value,ok:false},{...value,version:'old'}, {...value,walkForwardValidation:{...value.walkForwardValidation,protocolVersion:'unknown'}}]){
   fs.writeFileSync(file,JSON.stringify(changed));a.equal(inspect(file).ok,false);
  }
  fs.writeFileSync(file,'{');a.equal(inspect(file).ok,false);fs.writeFileSync(file,'');a.equal(inspect(file).ok,false);
  fs.writeFileSync(file,raw);fs.linkSync(file,path.join(root,'alias.json'));a.equal(inspect(file).ok,false);
 }finally{a.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));a(path.basename(root).startsWith('release-model-input-'));fs.rmSync(root,{recursive:true,force:true});}
});
test('fixed broker task budget accommodates both Node runtimes and their worker threads',()=>{
 const unit=fs.readFileSync(path.join(__dirname,'../deploy/light-server/football-research-broker.service'),'utf8');
 a.match(unit,/^TasksMax=32\r?$/m);a.match(unit,/^KillMode=control-group\r?$/m);a.match(unit,/^MemoryMax=512M\r?$/m);
 a.match(unit,/^NoNewPrivileges=true\r?$/m);a.match(unit,/^RestrictSUIDSGID=true\r?$/m);
});
