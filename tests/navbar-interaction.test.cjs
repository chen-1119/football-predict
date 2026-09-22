'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');

function mount(){
  const states=[],refs=[],effects=[],scheduled=[],listeners=new Map(),elements=new Map();
  let stateIndex=0,refIndex=0,effectIndex=0,tree;
  const document={activeElement:null,addEventListener:(type,handler)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler);},removeEventListener:(type,handler)=>listeners.get(type)?.delete(handler)};
  const react={useState:initial=>{const i=stateIndex++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef:initial=>refs[refIndex++]|| (refs[refIndex-1]={current:initial}),useCallback:fn=>fn,
    useEffect:(effect,deps)=>{const i=effectIndex++,old=effects[i];if(!old||deps.some((value,index)=>value!==old.deps[index]))scheduled.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:effect()};});}};
  const raf=[],window={setInterval:()=>1,clearInterval:()=>{},requestAnimationFrame:fn=>raf.push(fn)};
  const app={isAccessVerified:true,language:'zh',setLanguage:()=>{},currentUser:{username:'完整账户名称'.repeat(8)},logout:()=>{},dataSync:{currentLoaded:true,currentCount:12,recommendationReliable:false,lastCheckedAt:'2026-09-21T02:03:00Z',sourceUpdatedAt:'2026-09-21T02:00:00Z',liveUpdates:'poll',refreshIntervalSeconds:30}};
  const module={exports:{}},source=ts.transpileModule(fs.readFileSync(require.resolve('../src/components/Navbar.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(source,{module,exports:module.exports,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}:id==='lucide-react'?new Proxy({},{get:(_,key)=>String(key)}):id==='../context/AccountContext'?{useAccount:()=>({user:null})}:id==='../context/AppContextCore'?{useApp:()=>app}:(()=>{throw Error(id);})(),document,window,Date,Intl});
  const flat=node=>Array.isArray(node)?node.flatMap(flat):node&&typeof node==='object'?[node,...flat(node.props?.children)]:[];
  function bind(node,parent=null,path='root'){
    if(Array.isArray(node)){node.forEach((n,i)=>bind(n,parent,path+'.'+i));return;}if(!node||typeof node!=='object')return;
    const props=node.props||{},id=props.id||path;
    const element=elements.get(id)||{focus(){document.activeElement=this;},contains(other){for(let n=other;n;n=n.parent)if(n===this)return true;return false;}};
    element.parent=parent;element.node=node;elements.set(id,element);node.element=element;
    if(typeof props.ref==='function')props.ref(element);else if(props.ref)props.ref.current=element;
    bind(props.children,element,path+'.children');
  }
  function render(){stateIndex=refIndex=effectIndex=0;tree=module.exports.Navbar({currentTab:'best',setCurrentTab:()=>{},openGlossary:()=>{}});bind(tree);while(scheduled.length)scheduled.shift()();while(raf.length)raf.shift()();return tree;}
  const find=predicate=>flat(tree).find(predicate),text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
  const fire=(type,event)=>{for(const handler of [...(listeners.get(type)||[])])handler(event);render();};
  render();return{render,find,text,document,fire,app,event:(key)=>({key,preventDefault(){}}),get tree(){return tree;}};
}

test('status button opens truthful data and model details, Escape restores focus, outside click closes',()=>{
  const h=mount(),button=()=>h.find(n=>n.props?.['aria-controls']==='app-status-panel');
  assert.equal(button().props['aria-expanded'],false);assert.match(h.text(button()),/参考模式/);
  button().props.onKeyDown(h.event('ArrowDown'));h.render();
  const panel=h.find(n=>n.props?.id==='app-status-panel');assert(panel);assert.equal(h.document.activeElement,panel.element);
  assert.match(h.text(panel),/参考／影子，尚未通过正式门槛/);assert.match(h.text(panel),/每 30 秒刷新/);assert.match(h.text(panel),/10:00:00/);
  h.fire('keydown',h.event('Escape'));assert.equal(button().props['aria-expanded'],false);assert.equal(h.document.activeElement,button().element);
  button().props.onClick();h.render();h.fire('pointerdown',{target:{}});assert.equal(button().props['aria-expanded'],false);
});

test('account menu opens by keyboard, wraps focus, exposes the full username and closes on Escape',()=>{
  const h=mount(),trigger=()=>h.find(n=>n.props?.['aria-controls']==='app-more-menu');
  trigger().props.onKeyDown(h.event('ArrowDown'));h.render();
  const menu=()=>h.find(n=>n.props?.id==='app-more-menu'),items=()=>{
    const out=[];const walk=n=>{if(Array.isArray(n))n.forEach(walk);else if(n&&typeof n==='object'){if(n.props?.role==='menuitem')out.push(n);walk(n.props?.children);}};walk(menu());return out;
  };
  assert.equal(h.document.activeElement,items()[0].element);assert(h.text(menu()).includes(h.app.currentUser.username));
  menu().props.onKeyDown(h.event('ArrowUp'));assert.equal(h.document.activeElement,items().at(-1).element);
  menu().props.onKeyDown(h.event('Home'));assert.equal(h.document.activeElement,items()[0].element);
  menu().props.onKeyDown(h.event('End'));assert.equal(h.document.activeElement,items().at(-1).element);
  h.fire('keydown',h.event('Escape'));assert.equal(trigger().props['aria-expanded'],false);assert.equal(h.document.activeElement,trigger().element);
});

test('opening another disclosure or moving focus outside dismisses the previous panel',()=>{
  const h=mount(),status=()=>h.find(n=>n.props?.['aria-controls']==='app-status-panel'),more=()=>h.find(n=>n.props?.['aria-controls']==='app-more-menu');
  status().props.onClick();h.render();more().props.onClick();h.render();assert.equal(status().props['aria-expanded'],false);assert.equal(more().props['aria-expanded'],true);
  const root=h.find(n=>n.props?.className==='app-more');root.props.onBlur({currentTarget:root.element,relatedTarget:{}});h.render();assert.equal(more().props['aria-expanded'],false);
});
