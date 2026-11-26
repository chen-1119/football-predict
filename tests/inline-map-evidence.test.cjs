'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {canonicalMapValuesLowerBound}=require('../scripts/inlineRowIncidentEvidence.cjs');
const {streamInlineObjectEntries}=require('../scripts/streamedInlineObjectEntries.cjs');
function withFile(text,fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inline-map-test-')),file=path.join(dir,'original.json'),b=Buffer.from(text);fs.writeFileSync(file,b);try{return fn(file,{bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});}finally{fs.rmSync(dir,{recursive:true,force:true});}}
for(const [label,text] of [
 ['escaped unicode and slash','{"matches":{"a":{"x":"\\u4e2d\\/"},"b":"\\ud83d\\ude00"},"other":1}'],
 ['numeric canonicalization','{"matches":{"a":1e20,"b":1e400,"c":-0,"d":0.000001}}'],
 ['duplicate nested keys','{"matches":{"a":{"x":1,"x":2,"y":[1,{"z":3,"z":4}]}}}'],
 ['prototype-shaped map keys','{"matches":{"__proto__":{"x":1},"constructor":null,"0":[],"toString":true}}'],
 ['chunk boundary strings',JSON.stringify({matches:{a:'中😀'.repeat(20000),b:{x:'\\"'.repeat(40000)}}})],
 ['all JSON value types','{"matches":{"a":[],"b":{},"c":null,"d":false,"e":[1,null,"x"]}}'],
])test('canonical map lower bound: '+label,()=>withFile(text,(file,entry)=>{const values=Object.values(JSON.parse(text).matches),expected=2+values.reduce((n,v)=>n+Buffer.byteLength(JSON.stringify(v)),0)+Math.max(0,values.length-1);const observed=canonicalMapValuesLowerBound(file,entry);a.equal(observed,expected);a(observed<=Buffer.byteLength(JSON.stringify(JSON.parse(text))));a.equal(fs.readFileSync(file,'utf8'),text);}));
for(const [label,text] of [
 ['duplicate map entry','{"matches":{"a":1,"a":2}}'],['duplicate escaped map entry','{"matches":{"a":1,"\\u0061":2}}'],
 ['duplicate root map','{"matches":{"a":1},"matches":{"b":2}}'],['duplicate other root key','{"x":1,"x":2,"matches":{"a":1}}'],
 ['wrong container','{"matches":[1,2]}'],['missing map','{"other":{}}'],['empty map','{"matches":{}}'],
 ['malformed nested value','{"matches":{"a":[1,]}}'],['trailing input','{"matches":{"a":1}}{}'],
])test('rejects '+label,()=>withFile(text,(file,entry)=>a.throws(()=>canonicalMapValuesLowerBound(file,entry))));
test('rejects hash mismatch after full parse',()=>withFile('{"matches":{"a":1}}',(file,entry)=>a.throws(()=>canonicalMapValuesLowerBound(file,{...entry,sha256:'0'.repeat(64)}))));
test('rejects invalid UTF8 even in skipped field',()=>withFile('{"matches":{"a":1},"other":"x"}',(file,entry)=>{const b=fs.readFileSync(file);b[b.length-3]=255;fs.writeFileSync(file,b);a.throws(()=>canonicalMapValuesLowerBound(file,{...entry,sha256:crypto.createHash('sha256').update(b).digest('hex')}));}));
test('enforces item allocation limit before a large value is retained',()=>withFile(JSON.stringify({matches:{a:'x'.repeat(65536)}}),(file,entry)=>a.throws(()=>streamInlineObjectEntries(file,{keys:['matches'],onItem:()=>{},expectedBytes:entry.bytes,expectedSha256:entry.sha256,maxItemChars:1024}))));
test('rejects source symlink',()=>{if(process.platform==='win32')return;withFile('{"matches":{"a":1}}',(file,entry)=>{const link=file+'.link';fs.symlinkSync(file,link);a.throws(()=>canonicalMapValuesLowerBound(link,entry));});});
