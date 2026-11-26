'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
test('detail polls without navigation, keeps original clock on failure, and cancels on unmount',async()=>{
 const effects=[],states=[],timers=new Map();let serial=0,calls=0,signal,fail=false;
 const sample={version:'neutral-match-sports-v1',eventId:'1',businessDate:'2026-10-25',kickoff:'2026-10-25T14:00:00Z',names:['Home','Away'],predictionEligible:false,checkedAt:'2026-10-25T10:00:00Z'};
 const fakeWindow={setTimeout:(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;},clearTimeout:id=>timers.delete(id)};
 const fetcher=async(url,options)=>{calls++;signal=options.signal;if(fail)throw Error('offline');return{ok:true,json:async()=>structuredClone(sample)};};
 const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/NeutralSportsData.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,exports={};
 const dependencies={react:{useEffect:fn=>effects.push(fn),useState:initial=>{const entry={value:initial};states.push(entry);return[initial,value=>entry.value=value];}},'../services/accessControl':{getAccessAuthHeaders:()=>({})},'../services/runtimeUrls':{buildApiUrl:url=>url}};
 new Function('require','exports','window','fetch','clearTimeout',source)(name=>dependencies[name]||require(name),exports,fakeWindow,fetcher,fakeWindow.clearTimeout);
 exports.NeutralSportsData({eventId:sample.eventId,businessDate:sample.businessDate,kickoff:sample.kickoff,names:sample.names});const dispose=effects[0]();
 const flush=()=>new Promise(resolve=>setImmediate(resolve));await flush();assert.equal(calls,1);assert.equal(states[0].value.checkedAt,sample.checkedAt);
 const next=()=>{const item=[...timers].find(([,value])=>value.delay===60000);assert(item);timers.delete(item[0]);item[1].fn();};
 fail=true;next();await flush();assert.equal(calls,2);assert.equal(states[1].value,true);assert.equal(states[0].value.checkedAt,sample.checkedAt);
 fail=false;sample.checkedAt='2026-10-25T10:02:00Z';next();await flush();assert.equal(calls,3);assert.equal(states[1].value,false);assert.equal(states[0].value.checkedAt,sample.checkedAt);
 dispose();assert.equal(timers.size,0);assert.equal(signal.aborted,true);
});
