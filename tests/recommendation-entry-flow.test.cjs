'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,validators}=require('./recommendationFixture.cjs');
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
function compile(file,req,globals={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:req,Date,URLSearchParams,...globals});return module.exports;}
const nodes=(n,p)=>n&&typeof n==='object'?(Array.isArray(n)?n.flatMap(v=>nodes(v,p)):[...(p(n)?[n]:[]),...nodes(n.props?.children,p)]):[];
const words=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(words).join(''):typeof n==='object'?words(n.props?.children):String(n);
test('BestTips honors login return tab, keeps query state through tab changes and browser navigation',()=>{
 let search='?tab=two&q=kept';
 const mod=compile('../src/pages/BestTips.tsx',id=>{
  if(id==='react/jsx-runtime')return jsx;
  if(id==='react-router-dom')return{useSearchParams:()=>[new URLSearchParams(search),p=>{search='?'+p.toString();}]};
  if(id.endsWith('/AppContextCore'))return{useApp:()=>({language:'zh'})};
  if(id.endsWith('/RecommendationCenter'))return{RecommendationCenter:'center'};
  throw Error(id);
 });
 const render=()=>mod.BestTips({onSelectMatch:()=>{}});
 assert.equal(render().props.selectedTab,'two');render().props.onTabChange('three');assert.equal(render().props.selectedTab,'three');assert.equal(new URLSearchParams(search).get('q'),'kept');
 search='?tab=two&q=kept';assert.equal(render().props.selectedTab,'two');render().props.onTabChange('single');assert.equal(new URLSearchParams(search).get('tab'),null);assert.equal(render().props.selectedTab,'single');
 search='?tab=not-a-tab';assert.equal(render().props.selectedTab,'single');
});
async function center(){
 const p=memoryPorts();await createRuntime(p,{validators}).publishingCycle();
 const view=compile('../src/services/recommendationCenterView.ts',require),data=view.parseRecommendationCenter({recommendationCenter:p.state.view});
 let now=p.now,index=0,interval,cleanup,props={selectedTab:'two'};const state=[];let mounted=false;
 class Clock extends Date{static now(){return now;}}
 const mod=compile('../src/components/recommendations/RecommendationCenter.tsx',id=>{
  if(id==='react')return{useState:initial=>{const i=index++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useEffect:fn=>{if(!mounted){cleanup=fn();mounted=true;}}};
  if(id==='react/jsx-runtime')return jsx;
  if(id.endsWith('/useRecommendationCenter'))return{useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh(){}})};
  if(id==='./SelectionQualityNote')return require('./fixtures/selection-quality-note-module.cjs');
  if(id.endsWith('/recommendationCenterView'))return view;
  if(id.endsWith('/TeamBadge'))return{TeamBadge:()=>null};if(id.endsWith('/FollowButton'))return{FollowButton:()=>null};
  if(id==='lucide-react'||id.endsWith('.css'))return{};throw Error(id);
 },{Date:Clock,window:{setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{interval=null;}}});
 return{data,initialNow:p.now,setNow:value=>{now=value;},tick:()=>interval?.(),stop:()=>cleanup?.(),setProps:value=>{props={...props,...value};},render:()=>{index=0;return mod.RecommendationCenter({language:'zh',onSelectMatch:()=>{},...props});}};
}
const combos=t=>nodes(t,n=>n.type?.name==='ComboCard');
test('controlled combo tab responds immediately to URL navigation and click callback',async()=>{
 const h=await center();let selected;h.setProps({onTabChange:value=>{selected=value;}});assert.equal(combos(h.render())[0].props.combo.size,2);
 h.setProps({selectedTab:'three'});assert.equal(combos(h.render())[0].props.combo.size,3);
 nodes(h.render(),n=>n.type==='button'&&words(n).startsWith('2串1'))[0].props.onClick();assert.equal(selected,'two');h.setProps({selectedTab:selected});assert.equal(combos(h.render())[0].props.combo.size,2);h.stop();
});
test('idle clock expiry explains the 15-minute quote limit without calling it insufficient matches',async()=>{
 const h=await center();assert.equal(combos(h.render()).length,1);h.setNow(h.initialNow+15*60000);h.tick();assert.equal(combos(h.render()).length,1);
 h.setNow(h.initialNow+15*60000+1);h.tick();const t=h.render();assert.equal(combos(t).length,0);assert.match(words(t),/报价已超过15分钟有效期，等待新报价后自动重算/);assert.doesNotMatch(words(t),/今日无合格组合|当前可用.*需要/);h.stop();
});
test('source freshness failure stays distinct from SP floor failure and retains frozen records',async()=>{
 const h=await center(),preview=h.data.previews[0];h.data.previews=[];h.data.lanes.combos.status='error';h.data.lanes.combos.errorCode='SOURCE_STALE';h.data.lanes.combos.candidateCount=0;
 assert.match(words(h.render()),/当前报价未通过新鲜度校验/);assert.doesNotMatch(words(h.render()),/当前可用0场/);
 h.setNow(h.initialNow+16*60000);assert.match(words(h.render()),/报价已超过15分钟/);
 h.data.todayCombos=[{combo:{...preview,frozenAt:new Date(h.initialNow).toISOString()},settlement:{state:'PENDING'}}];assert.equal(combos(h.render()).length,1);assert.equal(combos(h.render())[0].props.combo.id,preview.id);h.stop();
});
test('genuinely fresh empty pool keeps its candidate shortage or SP-floor explanation',async()=>{
 const h=await center();h.data.previews=[];h.data.lanes.combos.candidateCount=1;assert.match(words(h.render()),/当前可用1场，2串1需要2场/);assert.doesNotMatch(words(h.render()),/报价已超过15分钟/);
 h.data.lanes.combos.candidateCount=3;assert.match(words(h.render()),/今日无合格组合/);assert.match(words(h.render()),/SP≥2.50/);h.stop();
});
