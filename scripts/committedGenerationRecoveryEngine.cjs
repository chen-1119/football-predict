'use strict';
// Independently signed cold-recovery coordinator. Runtime application source
// stays the authenticated full target. Only two authorization INPUT paths are
// explicitly delegated to new signed recovery documents; originals are kept.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
function authorizationFs(real,bindings){
  assert.equal(bindings.length,2);const map=new Map();
  for(const b of bindings){assert(path.isAbsolute(b.from)&&path.isAbsolute(b.to));assert.equal(path.basename(b.from),path.basename(b.to));assert(['code-release-activation-authorization.json','worker-code-repair-authorization.json'].includes(path.basename(b.from)));assert(!map.has(b.from));map.set(b.from,b.to);}
  const select=p=>typeof p==='string'&&map.has(path.resolve(p))?map.get(path.resolve(p)):p;
  const immutable=new Set([...map.keys(),...map.values()]);
  return new Proxy(real,{get(t,k){if(k==='readFileSync'||k==='lstatSync')return(p,...args)=>t[k](select(p),...args);if(['writeFileSync','unlinkSync','rmSync','renameSync'].includes(k))return(...args)=>{for(const p of args.slice(0,k==='renameSync'?2:1))assert(typeof p!=='string'||!immutable.has(path.resolve(p)),'authorization documents are immutable');return t[k](...args);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
}
function verifiedModules(sourceRoot,manifest,proxy){
  const expected=new Map(manifest.archiveSourceEvidence.inventory.entries.filter(r=>r.kind==='file').map(r=>[r.path,r]));const cache=new Map();
  function load(file){file=path.resolve(file);assert(file.startsWith(sourceRoot+path.sep));if(cache.has(file))return cache.get(file);const relative=path.relative(sourceRoot,file).split(path.sep).join('/'),row=expected.get(relative);assert(row,'unbound recovery engine dependency '+relative);const bytes=fs.readFileSync(file);assert.equal(bytes.length,row.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),row.sha256);const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,m);const fallback=m.require.bind(m);m.require=spec=>{if(spec==='node:fs'||spec==='fs')return proxy;if(spec.startsWith('.')){const child=Module._resolveFilename(spec,m);if(child.startsWith(sourceRoot+path.sep)){const result=load(child);return result.exports;}}return fallback(spec);};if(file.endsWith('.json'))m.exports=JSON.parse(bytes);else if(file.endsWith('.cjs'))m._compile(bytes.toString(),file);else m.exports=Module.createRequire(file)(file);return m;}
  return load;
}
function main(){assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const [dir,sourceRoot,kind,action,sha]=process.argv.slice(2);assert.equal(process.argv.length,7);const controller=require(dir+'/controller.cjs'),p=controller.load(dir);assert.equal(sourceRoot,p.sourceDir);assert.equal(sha,p.targetSha256);assert.equal(p.externalAuthorizationVersion,'cold-full-recovery-authorizations-v1');
  const emergency=dir+'/code-release-activation-authorization.json',worker=dir+'/worker-code-repair-authorization.json';for(const [file,hash]of [[emergency,p.externalEmergencySha256],[worker,p.externalWorkerSha256]])assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);
  const proxy=authorizationFs(fs,[{from:sourceRoot+'/deploy/light-server/code-release-activation-authorization.json',to:emergency},{from:sourceRoot+'/deploy/light-server/worker-code-repair-authorization.json',to:worker}]);
  const manifest=JSON.parse(fs.readFileSync('/var/lib/football-release/source-baselines/'+sha+'/manifest.json'));assert.equal(manifest.sha256,sha);
  const load=verifiedModules(sourceRoot,manifest,proxy),file=sourceRoot+'/scripts/'+(kind==='native'?'nativeReleaseDataPlane.cjs':'nativeCodeReleaseDataPlane.cjs');
  assert(['native','code'].includes(kind));assert((kind==='native'?['seed','final','drop-build-access','candidate-access','drop-candidate-access']:['lease-input','complete-clock']).includes(action));
  process.argv=[process.execPath,file,action,sha];
  // Run the original authenticated CLI body, including all ordinary checks.
  // Relative dependencies are verified byte-for-byte before compilation.
  const oldMain=process.mainModule,entry=new Module(file);entry.filename=file;entry.paths=Module._nodeModulePaths(path.dirname(file));const fallback=entry.require.bind(entry);entry.require=spec=>{if(spec==='node:fs'||spec==='fs')return proxy;if(spec.startsWith('.')){const child=Module._resolveFilename(spec,entry);if(child.startsWith(sourceRoot+path.sep))return load(child).exports;}return fallback(spec);};const row=manifest.archiveSourceEvidence.inventory.entries.find(r=>r.path==='scripts/'+path.basename(file)),bytes=fs.readFileSync(file);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),row.sha256);process.mainModule=entry;try{entry._compile(bytes.toString(),file);}finally{process.mainModule=oldMain;}
}
module.exports={authorizationFs,verifiedModules};
if(require.main===module){try{main();}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}}
