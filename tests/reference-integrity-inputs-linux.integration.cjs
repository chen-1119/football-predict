'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module'),cp=require('node:child_process');
function verify(){
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
  const base=fs.mkdtempSync('/var/tmp/football-partition-input-test-');
  const sourceRoot='/var/lib/football-original-custody';
  const destination='/var/lib/football-reference-integrity-input';
  const baseline=require('../server/data/public-reference-unresolved-baseline.json');
  const source=path.join(sourceRoot,baseline.custodyManifestSha256);
  const snapshot=()=>Object.fromEntries(fs.readdirSync(source).map(name=>{const stat=fs.lstatSync(path.join(source,name));return[name,{ino:stat.ino,size:stat.size,mode:stat.mode,uid:stat.uid,gid:stat.gid,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs}];}));
  const before=snapshot();
  const map=value=>typeof value==='string'&&(value===destination||value.startsWith(destination+'/'))?base+value.slice(destination.length):value;
  const methods=new Set(['lstatSync','existsSync','mkdirSync','mkdtempSync','chownSync','chmodSync','openSync','readdirSync']);
  const mappedFs=new Proxy(fs,{get(target,key){if(key==='renameSync')return(first,second)=>target.renameSync(map(first),map(second));if(key==='mkdtempSync')return prefix=>destination+target.mkdtempSync(map(prefix)).slice(base.length);if(methods.has(key))return(first,...rest)=>target[key](map(first),...rest);return target[key];}});
  const filename=require.resolve('../server/referenceIntegrityPartition.cjs');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded.require=name=>name==='node:fs'?mappedFs:Module.prototype.require.call(loaded,name);
  loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  const group=Number(cp.execFileSync('/usr/bin/getent',['group','football'],{encoding:'utf8'}).trim().split(':')[2]);
  fs.chownSync(base,0,group);fs.chmodSync(base,0o750);
  const priorUmask=process.umask(0o077);
  try{
    const installed=loaded.exports.installReferenceIntegrityInputs();
    assert.equal(installed.originalRecords,29);assert.equal(installed.copiedFiles,3);assert.equal(installed.collectionEnabled,false);
    const directory=map(installed.directory);
    const first=Object.fromEntries(fs.readdirSync(directory).map(name=>[name,fs.statSync(path.join(directory,name)).ino]));
    assert.deepEqual(loaded.exports.installReferenceIntegrityInputs(),installed);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(directory).map(name=>[name,fs.statSync(path.join(directory,name)).ino])),first);
    assert.equal(loaded.exports.originalRecordsForContext(loaded.exports.loadInstalledReferencePartition()).length,29);
    for(const name of ['seal.json','manifest.json','current.json']){
      const file=path.join(directory,name);
      assert.equal(cp.spawnSync('/usr/sbin/runuser',['-u','football','--','/usr/bin/test','-r',file]).status,0);
      assert.notEqual(cp.spawnSync('/usr/sbin/runuser',['-u','football','--','/usr/bin/test','-w',file]).status,0);
      assert.deepEqual(fs.readFileSync(file),fs.readFileSync(path.join(source,name)));
    }
    assert.notEqual(cp.spawnSync('/usr/sbin/runuser',['-u','football','--','/usr/bin/test','-r',source+'/warehouse.json']).status,0);
    fs.writeFileSync(directory+'/extra.json','{}',{flag:'wx'});
    assert.throws(()=>loaded.exports.installReferenceIntegrityInputs(),/INPUT_MEMBERSHIP/);
    assert.deepEqual(snapshot(),before);
    console.log(JSON.stringify({ok:true,base,originalRecords:29,workerReadOnly:true,idempotent:true,originalMetadataUnchanged:true,unexpectedFileRejected:true,productionWrites:0}));
  }finally{process.umask(priorUmask);}
}
if(require.main===module)verify();
module.exports={verify};
