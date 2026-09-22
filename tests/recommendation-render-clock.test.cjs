'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ts=require('typescript');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,validators}=require('./recommendationFixture.cjs');
function compile(file,requireFn){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:requireFn,Date});return module.exports;}
test('incoming lane timestamp between timer ticks stays visible without accepting future inputs',async()=>{
  const p=memoryPorts(),runtime=createRuntime(p,{validators});await runtime.publishingCycle();
  const V=compile(require.resolve('../src/services/recommendationCenterView.ts'),require);let data=V.parseRecommendationCenter({recommendationCenter:p.state.view});
  const original=Date.now;let now=p.now,index=0;const state=[];
  Date.now=()=>now;
  try{
    const component=compile(require.resolve('../src/components/recommendations/RecommendationCenter.tsx'),id=>{
      if(id==='react')return{useEffect:()=>{},useState:initial=>{const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],()=>{}];}};
      if(id==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
      if(id==='../../hooks/useRecommendationCenter')return{useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
      if(id==='../FollowButton')return {FollowButton:()=>null};
    if(id==='../TeamBadge')return{TeamBadge:()=>null};
      if(id==='../../services/recommendationCenterView')return V;
      if(id==='lucide-react')return{};if(id.endsWith('.css'))return{};throw Error(id);
    });
    const hasCombo=node=>!!node&&typeof node==='object'&&(node.type?.name==='ComboCard'||Object.values(node).some(value=>Array.isArray(value)?value.some(hasCombo):hasCombo(value)));
    const render=()=>{index=0;return component.RecommendationCenter({language:'zh',initialTab:'two',onSelectMatch:()=>{}});};
    assert.equal(hasCombo(render()),true);
    // No interval tick occurs. The HTTP response is newer than the initial
    // render but older than receipt time; retaining a tick would hide it.
    p.now+=5000;await runtime.publishingCycle();data=V.parseRecommendationCenter({recommendationCenter:p.state.view});now=p.now+1000;
    assert.equal(hasCombo(render()),true);
    now=p.now-1000;assert.equal(hasCombo(render()),false);
    now=p.now+16*60000;assert.equal(hasCombo(render()),false);
  }finally{Date.now=original;}
});
