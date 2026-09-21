'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const catalog=require('../src/services/teamCrestCatalog.json');
const codes=['ph','mv','ae','jp','th','cn','kr','sa'];
const assets=Object.fromEntries([...catalog.map(row=>[row.key,'/assets/'+row.key+'.fixture.png']),...codes.map(code=>['flag-'+code,'/assets/flag-'+code+'.fixture.png'])]);
function compile(file,requireFn){
  const module={exports:{}};
  const output=ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(output,{module,exports:module.exports,require:requireFn,console});return module.exports;
}
const visuals=compile('../src/services/teamVisuals.ts',id=>{
  if(id==='./teamCrestCatalog.json')return catalog;
  if(id==='./teamBadgeAssets')return {teamBadgeAssets:assets};
  throw Error('Unexpected visual dependency '+id);
});
const team=(name,extra={})=>({id:'test-'+name,name:{zh:name,en:name},shortName:{zh:name,en:name},logo:'',color:'#64748b',value:'-',...extra});
const entryFor=name=>{const row=catalog.find(row=>row.aliases.includes(name));assert(row,'Missing verified catalog alias '+name);return row;};
function nodes(node,predicate){if(Array.isArray(node))return node.flatMap(n=>nodes(n,predicate));if(!node||typeof node!=='object')return [];return [...(predicate(node)?[node]:[]),...nodes(node.props?.children,predicate)];}
function words(node){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(words).join('');return typeof node==='object'?words(node.props?.children):String(node);}
function mount(initial){
  let current=initial,tree,active=null;const instances=new Map();
  const react={useState:initial=>{assert(active,'Hooks require a mounted component');const cell=active,index=cell.cursor++;if(!(index in cell.state))cell.state[index]=typeof initial==='function'?initial():initial;return[cell.state[index],value=>{cell.state[index]=typeof value==='function'?value(cell.state[index]):value;}];}};
  const jsx=(type,props,key)=>({type,props,key});
  const {TeamBadge}=compile('../src/components/TeamBadge.tsx',id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'fragment'}:id==='lucide-react'?{Shield:props=>jsx('svg',{...props,'data-test-icon':'shield'})}:id==='../services/teamVisuals'?visuals:(()=>{throw Error('Unexpected badge dependency '+id);})());
  function render(next=current){
    current=next;const used=new Set();
    function expand(node,path){
      if(Array.isArray(node))return node.map((child,index)=>expand(child,path+'.'+index));
      if(!node||typeof node!=='object')return node;
      if(typeof node.type==='function'){
        const key=path+'|'+node.type.name+'|'+String(node.key??'');used.add(key);let cell=instances.get(key);if(!cell){cell={state:[],cursor:0};instances.set(key,cell);}cell.cursor=0;
        const previous=active;active=cell;const child=node.type(node.props);active=previous;return expand(child,key);
      }
      return {...node,props:{...node.props,children:expand(node.props?.children,path+'.children')}};
    }
    tree=expand(jsx(TeamBadge,{team:current,size:'sm'}),'root');for(const key of instances.keys())if(!used.has(key))instances.delete(key);return tree;
  }
  render();return {render,img:()=>nodes(tree,n=>n.type==='img')[0],root:()=>tree,find:predicate=>nodes(tree,predicate),get tree(){return tree;}};
}

test('national names and competition suffixes resolve the correct country, including new Asian aliases',()=>{
  const cases=[['菲律宾女足','ph'],['Philippines Women','ph'],['马尔代夫','mv'],['Maldives U23','mv'],['阿联酋亚运男足','ae'],['United Arab Emirates U23','ae'],['日本亚足','jp'],['Japan U23','jp'],['泰国亚运男足','th'],['中国亚运男足','cn'],['韩国亚运男足','kr'],['沙特阿拉伯亚足','sa']];
  for(const [name,code] of cases){const visual=visuals.resolveTeamVisual(team(name));assert.equal(visual.logoType,'flag',name);assert.equal(visual.logo,assets['flag-'+code],name);assert(visual.candidates.includes('https://flagcdn.com/w80/'+code+'.png'),name);assert(visual.nativeFlag,name);}
});

test('explicit national flag codes ph, mv and ae remain supported without interpreting club abbreviations',()=>{
  for(const code of ['ph','mv','ae'])assert.equal(visuals.resolveTeamVisual(team('待补全国家队名',{logo:code,logoType:'flag'})).logo,assets['flag-'+code]);
  for(const abbreviation of ['CO','PY','MC','FC']){
    const visual=visuals.resolveTeamVisual(team('Unmapped Football Club',{logo:abbreviation,shortName:{zh:abbreviation,en:abbreviation}}));
    assert.equal(visual.logoType,'crest-placeholder',abbreviation);assert.equal(visual.isImage,false,abbreviation);assert.equal(visual.nativeFlag,'',abbreviation);
  }
});

test('verified catalog mappings cover current club aliases and use bundled badges before provider fallbacks',()=>{
  for(const name of ['乌迪内斯','西雅图海湾人','莱比锡红牛','米尔顿凯恩斯','PSV埃因霍温']){
    const entry=entryFor(name),visual=visuals.resolveTeamVisual(team(name));
    assert.equal(visual.logoType,'crest',name);assert.equal(visual.logo,assets[entry.key],name);assert(visual.candidates.includes(entry.logoUrl),name);assert.equal(visual.source,entry.provider,name);
  }
});

test('the original supplied club image is retained as a fallback after the verified local asset',()=>{
  const entry=entryFor('乌迪内斯'),original='https://example.test/udinese-original.png',visual=visuals.resolveTeamVisual(team('乌迪内斯',{logo:original}));
  assert.equal(visual.candidates[0],assets[entry.key]);assert(visual.candidates.indexOf(original)>0);assert(visual.candidates.includes(entry.logoUrl));
  assert.equal(new Set(visual.candidates).size,visual.candidates.length);
});

test('matching original and provider URLs produce one fallback attempt rather than duplicates',()=>{
  const entry=entryFor('乌迪内斯'),visual=visuals.resolveTeamVisual(team('乌迪内斯',{logo:entry.logoUrl}));
  assert.equal(visual.candidates.filter(url=>url===entry.logoUrl).length,1);assert.equal(visual.candidates[0],assets[entry.key]);
});

test('women and youth clubs do not borrow a senior male crest through a shortened display name',()=>{
  const entry=entryFor('乌迪内斯');
  for(const name of ['乌迪内斯女足','Udinese Women','乌迪内斯U23','Udinese U19']){
    const visual=visuals.resolveTeamVisual(team(name,{shortName:{zh:'乌迪内斯',en:'Udinese'}}));
    assert.notEqual(visual.logo,assets[entry.key],name);assert(!visual.candidates.includes(entry.logoUrl),name);assert.equal(visual.logoType,'crest-placeholder',name);
  }
});

test('a verified club is never relabelled as a national flag by country metadata in its raw image',()=>{
  const visual=visuals.resolveTeamVisual(team('乌迪内斯',{logo:'https://flagcdn.com/w80/it.png',logoType:'flag'}));
  assert.equal(visual.logoType,'crest');assert(!visual.candidates.some(url=>url.includes('flagcdn.com')));assert.equal(visual.nativeFlag,'');
});

test('badge load state is visible and moves to the next candidate only after an actual error',()=>{
  const h=mount(team('乌迪内斯',{logo:'https://example.test/original.png'})),first=h.img();
  assert.equal(h.root().props['data-logo-state'],'loading');first.props.onLoad();h.render();assert.equal(h.root().props['data-logo-state'],'loaded');assert.match(h.img().props.className,/is-loaded/);
  first.props.onError();h.render();assert.notEqual(h.img().props.src,first.props.src);assert.equal(h.root().props['data-logo-state'],'loading');
});

test('duplicate or delayed errors from an old image cannot skip a subsequent fallback',()=>{
  const h=mount(team('乌迪内斯',{logo:'https://example.test/original.png'})),first=h.img();first.props.onError();first.props.onError();h.render();
  const second=h.img().props.src;first.props.onError();h.render();assert.equal(h.img().props.src,second);
  first.props.onLoad();h.render();assert.equal(h.root().props['data-logo-state'],'loading');
});

test('failed club image candidates are attempted once and same-team rerenders do not restart the loop',()=>{
  const t=team('乌迪内斯',{logo:'https://example.test/original.png'}),visual=visuals.resolveTeamVisual(t),h=mount(t),attempted=[];
  while(h.img()&&attempted.length<20){attempted.push(h.img().props.src);h.img().props.onError();h.render();}
  assert.deepEqual(attempted,Array.from(visual.candidates));assert.equal(h.img(),undefined);assert.equal(h.root().props['data-logo-state'],'unavailable');
  for(let i=0;i<5;i++)h.render({...t,name:{...t.name},shortName:{...t.shortName}});
  assert.equal(h.img(),undefined);assert.match(h.root().props['aria-label'],/队徽暂缺/);assert.equal(h.find(n=>n.props?.['data-test-icon']==='shield').length,1);
});

test('a reused row starts image loading again after its team identity changes',()=>{
  const t=team('乌迪内斯'),h=mount(t);
  while(h.img()){h.img().props.onError();h.render();}
  h.render({...t,id:'different-fixture-team'});assert.equal(h.img().props.src,visuals.resolveTeamVisual(t).candidates[0]);assert.equal(h.root().props['data-logo-state'],'loading');
  const other=team('西雅图海湾人');h.render(other);assert.equal(h.img().props.src,visuals.resolveTeamVisual(other).candidates[0]);
});

test('a country uses its native flag only after every local and remote image has failed',()=>{
  const t=team('菲律宾女足'),visual=visuals.resolveTeamVisual(t),h=mount(t),attempted=[];
  assert(visual.candidates.length>=2);
  while(h.img()){
    assert.equal(h.find(n=>n.props?.className==='team-badge-native-flag').length,0);
    attempted.push(h.img().props.src);h.img().props.onError();h.render();
  }
  assert.deepEqual(attempted,Array.from(visual.candidates));assert.equal(h.root().props['data-logo-state'],'native-flag');
  assert.equal(words(h.find(n=>n.props?.className==='team-badge-native-flag')[0]),visual.nativeFlag);assert.match(h.root().props['aria-label'],/国旗/);
});

test('an unknown club displays a neutral shield without fabricated initials or country flags',()=>{
  const h=mount(team('尚未映射足球俱乐部',{logo:'CO'}));assert.equal(h.img(),undefined);assert.equal(h.root().props['data-logo-state'],'unavailable');
  assert.equal(h.find(n=>n.props?.['data-test-icon']==='shield').length,1);assert.equal(words(h.tree),'');assert.match(h.root().props['aria-label'],/队徽暂缺/);
});

test('missing team data renders an accessible placeholder rather than throwing',()=>{
  const h=mount(undefined);assert.equal(h.img(),undefined);assert.equal(h.root().props.role,'img');assert.match(h.root().props['aria-label'],/队徽暂缺/);
});
