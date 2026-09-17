'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
test('default browser timers retain their window receiver and settle the first request',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../src/services/pollingController.ts'),'utf8');
  const code=ts.transpileModule(source,{reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  assert.deepEqual(code.diagnostics,[]);
  let next=0,received=null,settled=0;const timers=new Map();
  const context={exports:{},AbortController,windowBrand:true,setTimeout:function(callback){assert.equal(this.windowBrand,true,'native timer receiver must be Window');timers.set(++next,callback);return next;},clearTimeout:function(id){assert.equal(this.windowBrand,true);timers.delete(id);}};
  vm.runInNewContext(code.outputText,context);
  const controller=context.exports.createPollingController({request:async()=>({published:2}),onData:data=>{received=data;},onError:error=>{throw error;},onSettled:()=>{settled++;}});
  controller.start();await new Promise(setImmediate);
  assert.deepEqual(received,{published:2});assert.equal(settled,1);assert.equal(timers.size,1);
  controller.stop();assert.equal(timers.size,0);
});

