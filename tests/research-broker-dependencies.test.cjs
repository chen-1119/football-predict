'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collect,verify}=require('../server/researchBrokerDependencies.cjs');
test('complete pg closure detects code, resolution metadata, and newly added files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'football-research-dependency-test-'));
 const packageDir=name=>path.join(root,'node_modules',name);
 try{
  for(const name of ['pg','child']){fs.mkdirSync(packageDir(name),{recursive:true});fs.writeFileSync(path.join(packageDir(name),'index.js'),'module.exports=1;');
   fs.writeFileSync(path.join(packageDir(name),'package.json'),JSON.stringify({name,version:'1.0.0',dependencies:name==='pg'?{child:'1.0.0'}:{}}));}
  const original=collect(root);a.equal(original.packages,2);a.equal(original.entries.length,4);a.deepEqual(verify(root,original),original);
  fs.writeFileSync(path.join(packageDir('child'),'index.js'),'module.exports=2;');a.throws(()=>verify(root,original),{code:'RESEARCH_DEPENDENCY_IDENTITY'});
  fs.writeFileSync(path.join(packageDir('child'),'index.js'),'module.exports=1;');
  fs.writeFileSync(path.join(packageDir('child'),'new.js'),'unexpected-resolution-target');a.throws(()=>verify(root,original),{code:'RESEARCH_DEPENDENCY_IDENTITY'});
  fs.unlinkSync(path.join(packageDir('child'),'new.js'));fs.writeFileSync(path.join(packageDir('pg'),'package.json'),JSON.stringify({name:'pg',dependencies:{missing:'1'}}));
  a.throws(()=>collect(root),{code:'RESEARCH_DEPENDENCY_MISSING'});
 }finally{
  const resolved=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());
  a.equal(path.dirname(resolved),parent);a.ok(path.basename(resolved).startsWith('football-research-dependency-test-'));
  fs.rmSync(resolved,{recursive:true});
 }
});
