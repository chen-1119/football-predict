'use strict';
// Collect every file of the fixed pg dependency tree, including metadata and
// unused branches, so resolution cannot switch to an unbound package later.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{createHash}=require('node:crypto');
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
function collect(root,read=filename=>fs.readFileSync(filename)){
 const modules=path.join(root,'node_modules'),seen=new Set(),entries=[];let total=0;
 function file(filename){
  const s=fs.lstatSync(filename),relative=path.relative(root,filename).split(path.sep).join('/');
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>4*1024*1024||entries.length>=2048||total+s.size>32*1024*1024)fail('RESEARCH_DEPENDENCY_BOUND');
  const raw=read(filename);if(raw.length!==s.size)fail('RESEARCH_DEPENDENCY_CHANGED');
  total+=raw.length;entries.push({path:relative,bytes:raw.length,sha256:hash(raw)});
 }
 function walk(dir){
  const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())fail('RESEARCH_DEPENDENCY_DIRECTORY');
  for(const name of fs.readdirSync(dir).sort()){const target=path.join(dir,name),s=fs.lstatSync(target);if(s.isDirectory())walk(target);else file(target);}
 }
 function visit(directory){
  if(!directory.startsWith(modules+path.sep)||fs.realpathSync(directory)!==directory)fail('RESEARCH_DEPENDENCY_PATH');
  if(seen.has(directory))return;seen.add(directory);
  const metadata=JSON.parse(read(path.join(directory,'package.json')));
  walk(directory);
  const resolve=createRequire(path.join(directory,'package.json'));
  for(const name of Object.keys({...metadata.dependencies,...metadata.optionalDependencies}).sort()){
   if(!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+$/i.test(name))fail('RESEARCH_DEPENDENCY_NAME');
   const candidates=resolve.resolve.paths(name)||[];
   const next=candidates.map(p=>path.join(p,name)).find(p=>fs.existsSync(path.join(p,'package.json')));
   if(!next){if(Object.hasOwn(metadata.optionalDependencies||{},name))continue;fail('RESEARCH_DEPENDENCY_MISSING');}
   visit(next);
  }
 }
 visit(path.join(modules,'pg'));
 entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {version:'research-pg-dependencies-v1',packages:seen.size,bytes:total,entries};
}
function verify(root,expected,read){
 if(!expected||expected.version!=='research-pg-dependencies-v1')fail('RESEARCH_DEPENDENCY_VERSION');
 const actual=collect(root,read);if(hash(JSON.stringify(actual))!==hash(JSON.stringify(expected)))fail('RESEARCH_DEPENDENCY_IDENTITY');
 return actual;
}
module.exports={collect,verify};
