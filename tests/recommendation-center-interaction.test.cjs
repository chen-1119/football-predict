'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,validators}=require('./recommendationFixture.cjs');
function compile(file,requireFn){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:requireFn,Date,window:{setInterval:()=>0,clearInterval:()=>{},setTimeout:fn=>{fn();return 0;},clearTimeout:()=>{}}});return module.exports;}
function aggregate(rows){const values=rows.map(row=>row.settlement?.state||'PENDING'),count=state=>values.filter(value=>value===state).length;const won=count('WON'),lost=count('LOST'),settled=won+lost;return{published:rows.length,settled,won,lost,pending:count('PENDING'),void:count('VOID'),disputed:count('DISPUTED'),hitRate:settled?won/settled:null};}
async function harness({missingInputEvidence=false,reviewFailure=false}={}){
  const p=memoryPorts();if(missingInputEvidence)for(const m of p.current){const {version,generatedAt,oneXTwo}=m.probabilityModel;m.probabilityModel={version,generatedAt,oneXTwo};}
  await createRuntime(p,{validators}).publishingCycle();
  const view=compile(require.resolve('../src/services/recommendationCenterView.ts'),require),data=view.parseRecommendationCenter({recommendationCenter:p.state.view});
  const original=data.current[0];data.review.singles=Array.from({length:69},(_,index)=>({...original,decision:{...original.decision,decisionId:'ui-'+index,sourceMatchId:String(index+1),homeTeamName:index===68?'目标球队':'主队'+(index+1),awayTeamName:'客队'+(index+1)},settlement:{state:index%2===0?'WON':'LOST',score:'1-0'}}));
  data.review.statistics.single={published:69,settled:69,won:35,lost:34,pending:0,void:0,disputed:0,hitRate:35/69};
  let cursor=0;const state=[],versionKey='a'.repeat(64);
  const reviewPage=filters=>{
    if(reviewFailure)return {data:null,loading:false,failed:true,authorizationRequired:false,refresh:()=>{}};
    const all=filters.kind==='single'?data.review.singles:data.review.combos.filter(row=>row.combo.size===(filters.kind==='two'?2:3));
    const marketRows=all.filter(row=>{
      if(filters.kind==='single')return filters.market!=='MIXED'&&(filters.market!=='HHAD'||Boolean(row.decision.handicapAnalysis?.tipCode));
      if(filters.market==='ALL')return true;
      const markets=new Set((row.combo.selections||[]).map(s=>s.market));
      return filters.market==='MIXED'?markets.size>1:markets.size===1&&markets.has(filters.market);
    });
    const cohort=marketRows.filter(row=>!filters.version||filters.version===versionKey),needle=filters.q.toLocaleLowerCase();
    const filtered=cohort.filter(row=>(!filters.date||(row.decision?.businessDate||row.combo?.businessDate)===filters.date)&&(!needle||[...(row.decision?[row.decision]:row.combo.legs)].flatMap(d=>[d.homeTeamName,d.awayTeamName,d.matchNo,d.sourceMatchId]).join(' ').normalize('NFKC').toLocaleLowerCase().includes(needle))&&(filters.state==='ALL'||row.settlement?.state===filters.state));
    const rows=filtered.slice((filters.page-1)*filters.pageSize,filters.page*filters.pageSize).map(row=>({...row,selectedMarket:filters.kind==='single'?(filters.market==='HHAD'?'HHAD':'HAD'):'HAD',selectedSettlement:row.settlement,selectedOdds:row.decision?.odds||row.combo?.totalOdds||null,oddsState:'available',versionKey,versionLabel:'fixture-model · fixture-policy'}));
    return {data:{rows,total:filtered.length,page:filters.page,pageCount:Math.ceil(filtered.length/filters.pageSize),summary:{all:aggregate(cohort),windows:{last7:aggregate(cohort),last30:aggregate(cohort)}},versions:[{key:versionKey,label:'fixture-model · fixture-policy',count:all.length}]},loading:false,failed:false,authorizationRequired:false,refresh:()=>{}};
  };
  const component=compile(require.resolve('../src/components/recommendations/RecommendationCenter.tsx'),id=>{
    if(id==='react')return {useEffect:callback=>callback(),useState:initial=>{const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];}};
    if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
    if(id==='./SelectionQualityNote')return require('./fixtures/selection-quality-note-module.cjs');
    if(id==='./DayCoverage')return {DayCoverage:()=>null};
    if(id==='./MarketComparison')return {MarketComparison:()=>null};
    if(id==='../../hooks/useRecommendationCenter')return {useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
    if(id==='../../hooks/useRecommendationReviewPage')return {useRecommendationReviewPage:reviewPage};
    if(id==='../FollowButton')return {FollowButton:()=>null};
    if(id==='../TeamBadge')return {TeamBadge:({team,size})=>({type:'span',props:{'data-badge-name':team.name.zh,'data-badge-id':team.id,'data-badge-size':size}})};
    if(id==='../../services/recommendationCenterView')return view;if(id==='./DualResearchV2')return {DualResearchV2:()=>null};if(id==='lucide-react')return new Proxy({},{get:()=>()=>null});if(id.endsWith('.css'))return {};throw Error(id);
  });
  const expand=node=>Array.isArray(node)?node.map(expand):node&&typeof node==='object'?(typeof node.type==='function'?expand(node.type(node.props)):{...node,props:{...node.props,children:expand(node.props?.children)}}):node;
  return {data,render(){cursor=0;return expand(component.RecommendationCenter({language:'zh',mode:'review',onSelectMatch:()=>{}}));},renderSettled(){this.render();return this.render();}};
}
function nodes(node,predicate){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(n=>nodes(n,predicate));return [...(predicate(node)?[node]:[]),...nodes(node.props?.children,predicate)];}
function words(node){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(words).join('');return typeof node==='object'?words(node.props?.children):String(node);}
const byClass=(tree,name)=>nodes(tree,n=>(n.props?.className||'').split(' ').includes(name));
const button=(tree,label)=>nodes(tree,n=>n.type==='button'&&words(n)===label)[0];

test('review reads real pages of twelve out of sixty-nine without changing aggregate statistics',async()=>{
  const ui=await harness();let tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,12);assert.match(words(tree),/共 69 条明细 · 第 1 页，每页 12 条/);assert.match(words(byClass(tree,'rc-stats')[0]),/50\.7%/);
  const first=byClass(tree,'rc-pick')[0].props['data-decision-id'];
  button(tree,'下一页').props.onClick();tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,12);assert.notEqual(byClass(tree,'rc-pick')[0].props['data-decision-id'],first);assert.match(words(tree),/第 2 \/ 6 页/);assert.match(words(byClass(tree,'rc-stats')[0]),/35 \/ 69/);
});

test('actual shared quality component distinguishes ready reference from watch without rewriting the frozen pick',async()=>{
  const ready=await harness(),readyTree=ready.render(),readyNotes=byClass(readyTree,'selection-quality-note');
  assert.equal(readyNotes.length,12);assert(readyNotes.every(n=>n.props['data-selection-status']==='reference-qualified'));
  assert.match(words(readyNotes[0]),/参考入选 · 待验证/);assert.match(words(readyNotes[0]),/不代表已经验证命中率或回报/);
  const watch=await harness({missingInputEvidence:true}),before=JSON.stringify(watch.data),watchTree=watch.render(),watchNotes=byClass(watchTree,'selection-quality-note');
  assert.equal(watchNotes.length,12);assert(watchNotes.every(n=>n.props['data-selection-status']==='watch'));
  assert.match(words(watchNotes[0]),/观望 · 保留模型方向/);assert.match(words(watchNotes[0]),/本次模型输入计算尚未核验|本次模型输入依据尚未完整存档/);assert.match(words(watchNotes[0]),/暂不进入新串关/);
  assert.equal(JSON.stringify(watch.data),before);
});

test('server-side team and result filters compose, retain the cohort denominator, and clear',async()=>{
  const ui=await harness();let tree=ui.render();nodes(tree,n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:'目标球队'}});tree=ui.renderSettled();assert.equal(byClass(tree,'rc-pick').length,1);assert.match(words(tree),/共 1 条符合条件的明细/);assert.match(words(byClass(tree,'rc-stats')[0]),/35 \/ 69/);
  nodes(tree,n=>n.type==='select')[2].props.onChange({target:{value:'LOST'}});tree=ui.render();assert.equal(byClass(tree,'rc-pick').length,0);assert.match(words(tree),/此条件暂无复盘记录/);assert.doesNotMatch(words(tree),/暂时没有可展示的推荐/);
  button(tree,'清除筛选').props.onClick();tree=ui.renderSettled();assert.equal(byClass(tree,'rc-pick').length,12);assert.equal(nodes(tree,n=>n.type==='select')[2].props.value,'ALL');assert.equal(nodes(tree,n=>n.type==='input'&&n.props.type==='search')[0].props.value,'');
});

test('match-day filter resets pagination and keeps seven/thirty-day summaries visible',async()=>{
  const ui=await harness();let tree=ui.render();button(tree,'下一页').props.onClick();tree=ui.render();assert.match(words(tree),/第 2 \/ 6 页/);
  nodes(tree,n=>n.type==='input'&&n.props.type==='date')[0].props.onChange({target:{value:'2026-09-18'}});tree=ui.render();
  assert.match(words(tree),/共 0 条符合条件的明细 · 第 1 页/);assert.equal(byClass(tree,'rc-pick').length,0);
  assert.match(words(tree),/近7日/);assert.match(words(tree),/近30日/);
  assert.equal(nodes(tree,n=>n.type==='select').length,3);
});

test('failed review read with archived records never claims zero or no matching history',async()=>{
  const ui=await harness({reviewFailure:true});
  assert.equal(ui.data.review.singles.length,69);
  const tree=ui.render(),copy=words(tree);
  assert.match(copy,/当前筛选读取失败，条数不可用/);
  assert.match(copy,/复盘暂不可用/);
  assert.match(copy,/重试读取/);
  assert.doesNotMatch(copy,/共 0 条/);
  assert.doesNotMatch(copy,/此条件暂无复盘记录|没有符合条件的串关/);
  assert.equal(byClass(tree,'rc-pick').length,0);
});

test('versioned performance and per-match probability details are closed by default while their contents remain available',async()=>{
  const ui=await harness(),tree=ui.render();const insights=byClass(tree,'rc-review-insights')[0];assert.equal(insights.type,'details');assert.notEqual(insights.props.open,true);assert.match(words(insights),/分母：全部该版已结算场次/);assert.match(words(insights),/仅胜平负首选命中的场次/);
  assert.equal(byClass(tree,'rc-analysis').length,12);assert(byClass(tree,'rc-analysis').every(node=>node.type==='details'&&!node.props.open));assert(byClass(tree,'rc-details').every(node=>!node.props.open));
  const first=byClass(tree,'rc-pick')[0],children=first.props.children;assert(children.findIndex(node=>node.props?.className==='rc-pick__main')<children.findIndex(node=>node.props?.className==='rc-primary-picks'));assert.match(words(first),/1 : 0/);
});

test('changing review kind resets pagination and searches archived combo legs',async()=>{
  const ui=await harness();const base=ui.data.previews.find(combo=>combo.size===2);ui.data.review.combos=Array.from({length:15},(_,index)=>({combo:{...base,id:'combo-ui-'+index,frozenAt:base.generatedAt,legs:base.legs.map((leg,i)=>({...leg,homeTeamName:index===14&&i===0?'指定串关球队':leg.homeTeamName}))},settlement:{state:index===14?'WON':'PENDING'}}));
  let tree=ui.render();button(tree,'下一页').props.onClick();tree=ui.render();button(tree,'2串1SP≥2.50').props.onClick();tree=ui.render();assert.equal(byClass(tree,'rc-combo').length,12);assert.match(words(tree),/共 15 条明细 · 第 1 页，每页 12 条/);
  nodes(tree,n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:'指定串关球队'}});tree=ui.renderSettled();assert.equal(byClass(tree,'rc-combo').length,1);assert.match(words(tree),/指定串关球队/);assert.match(words(tree),/冻结/);
});

test('single and combo badges use frozen team names without substituting current fixture identities',async()=>{
  const ui=await harness();
  const row=ui.data.review.singles[0];
  row.decision=Object.freeze({...row.decision,homeTeamName:'冻结主队',awayTeamName:'冻结客队'});
  ui.data.review.singles=[row];
  ui.data.current[0].decision={...ui.data.current[0].decision,homeTeamName:'当前不同主队',awayTeamName:'当前不同客队'};
  const base=ui.data.previews.find(combo=>combo.size===2);
  const combo={...base,frozenAt:base.generatedAt,legs:base.legs.map((leg,i)=>Object.freeze({...leg,homeTeamName:`历史串关主队${i}`,awayTeamName:`历史串关客队${i}`}))};
  ui.data.review.combos=[{combo,settlement:{state:'PENDING'}}];
  const before=JSON.stringify({row,combo});
  let tree=ui.render();
  const badges=()=>nodes(tree,node=>Boolean(node.props?.['data-badge-name']));
  assert.deepEqual(badges().map(node=>node.props['data-badge-name']),['冻结主队','冻结客队']);
  assert(badges().every(node=>node.props['data-badge-size']==='sm'));
  button(tree,'2串1SP≥2.50').props.onClick();tree=ui.render();
  assert.deepEqual(badges().map(node=>node.props['data-badge-name']),['历史串关主队0','历史串关客队0','历史串关主队1','历史串关客队1']);
  assert.equal(JSON.stringify({row,combo}),before);
});
