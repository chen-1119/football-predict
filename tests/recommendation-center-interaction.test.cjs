'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,validators}=require('./recommendationFixture.cjs');
function compile(file,requireFn){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:requireFn,Date});return module.exports;}
async function harness(){
  const p=memoryPorts();await createRuntime(p,{validators}).publishingCycle();
  const view=compile(require.resolve('../src/services/recommendationCenterView.ts'),require),data=view.parseRecommendationCenter({recommendationCenter:p.state.view});
  const original=data.current[0];data.review.singles=Array.from({length:69},(_,index)=>({...original,decision:{...original.decision,decisionId:'ui-'+index,sourceMatchId:String(index+1),homeTeamName:index===68?'目标球队':'主队'+(index+1),awayTeamName:'客队'+(index+1)},settlement:{state:index%2===0?'WON':'LOST',score:'1-0'}}));
  data.review.statistics.single={published:69,settled:69,won:35,lost:34,pending:0,void:0,disputed:0,hitRate:35/69};
  let cursor=0;const state=[];
  const component=compile(require.resolve('../src/components/recommendations/RecommendationCenter.tsx'),id=>{
    if(id==='react')return {useEffect:()=>{},useState:initial=>{const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];}};
    if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
    if(id==='../../hooks/useRecommendationCenter')return {useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
    if(id==='../../services/recommendationCenterView')return view;if(id==='lucide-react')return new Proxy({},{get:()=>()=>null});if(id.endsWith('.css'))return {};throw Error(id);
  });
  const expand=node=>Array.isArray(node)?node.map(expand):node&&typeof node==='object'?(typeof node.type==='function'?expand(node.type(node.props)):{...node,props:{...node.props,children:expand(node.props?.children)}}):node;
  return {data,render(){cursor=0;return expand(component.RecommendationCenter({language:'zh',mode:'review',onSelectMatch:()=>{}}));}};
}
function nodes(node,predicate){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(n=>nodes(n,predicate));return [...(predicate(node)?[node]:[]),...nodes(node.props?.children,predicate)];}
function words(node){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(words).join('');return typeof node==='object'?words(node.props?.children):String(node);}
const byClass=(tree,name)=>nodes(tree,n=>(n.props?.className||'').split(' ').includes(name));
const button=(tree,label)=>nodes(tree,n=>n.type==='button'&&words(n)===label)[0];

test('review initially renders twelve of sixty-nine records and loads twelve more without changing aggregate statistics',async()=>{
  const ui=await harness();let tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,12);assert.match(words(tree),/共 69 条明细 · 已显示 12 条/);assert.match(words(byClass(tree,'rc-stats')[0]),/50\.7%/);
  button(tree,'再显示12条').props.onClick();tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,24);assert.match(words(tree),/还有 45 条明细/);assert.match(words(byClass(tree,'rc-stats')[0]),/35 \/ 69/);
});

test('team search and result status compose, show a truthful empty filter state and clear back to the first batch',async()=>{
  const ui=await harness();let tree=ui.render();nodes(tree,n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:' 目标球队 '}});tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,1);assert.match(words(tree),/共 1 条符合条件的明细/);assert.match(words(byClass(tree,'rc-stats')[0]),/35 \/ 69/);
  nodes(tree,n=>n.type==='select')[0].props.onChange({target:{value:'LOST'}});tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,0);assert.match(words(tree),/没有符合条件的比赛/);assert.doesNotMatch(words(tree),/暂时没有可展示的推荐/);
  button(tree,'清除筛选').props.onClick();tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,12);assert.equal(nodes(tree,n=>n.type==='select')[0].props.value,'ALL');assert.equal(nodes(tree,n=>n.type==='input')[0].props.value,'');
});

test('versioned performance and per-match probability details are closed by default while their contents remain available',async()=>{
  const ui=await harness(),tree=ui.render();const insights=byClass(tree,'rc-review-insights')[0];assert.equal(insights.type,'details');assert.notEqual(insights.props.open,true);assert.match(words(insights),/分母：全部该版已结算场次/);assert.match(words(insights),/仅胜平负首选命中的场次/);
  assert.equal(byClass(tree,'rc-analysis').length,12);assert(byClass(tree,'rc-analysis').every(node=>node.type==='details'&&!node.props.open));assert(byClass(tree,'rc-details').every(node=>!node.props.open));
  const first=byClass(tree,'rc-pick')[0],children=first.props.children;assert(children.findIndex(node=>node.props?.className==='rc-pick__main')<children.findIndex(node=>node.props?.className==='rc-primary-picks'));assert.match(words(first),/1 : 0/);
});

test('changing review type resets the batch and filters combo legs by team without affecting frozen picks',async()=>{
  const ui=await harness();const base=ui.data.previews.find(combo=>combo.size===2);ui.data.review.combos=Array.from({length:15},(_,index)=>({combo:{...base,id:'combo-ui-'+index,frozenAt:base.generatedAt,legs:base.legs.map((leg,i)=>({...leg,homeTeamName:index===14&&i===0?'指定串关球队':leg.homeTeamName}))},settlement:{state:index===14?'WON':'PENDING'}}));
  let tree=ui.render();button(tree,'再显示12条').props.onClick();tree=ui.render();button(tree,'2串1SP≥2.50').props.onClick();tree=ui.render();assert.equal(byClass(tree,'rc-combo').length,12);assert.match(words(tree),/共 15 条明细 · 已显示 12 条/);
  nodes(tree,n=>n.type==='input')[0].props.onChange({target:{value:'指定串关球队'}});tree=ui.render();assert.equal(byClass(tree,'rc-combo').length,1);assert.match(words(tree),/指定串关球队/);assert.match(words(tree),/冻结/);
});
