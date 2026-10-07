'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const compile=(file,req,globals={})=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:req,URL,URLSearchParams,Date,Intl,AbortController,setTimeout,clearTimeout,...globals});return module.exports;};
const words=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(words).join(''):typeof n==='object'?words(n.props?.children):String(n);
const nodes=(n,p)=>n&&typeof n==='object'?(Array.isArray(n)?n.flatMap(v=>nodes(v,p)):[...(p(n)?[n]:[]),...nodes(n.props?.children,p)]):[];
const fixtures=[{id:'sporttery_a',sourceMatchId:'a',matchNo:'周二001',businessDate:'2026-09-22',homeTeamName:'阿森纳',homeTeamNameEn:'Arsenal',awayTeamName:'切尔西',leagueName:'英超',status:'SCHEDULED',kickoffTime:'2026-09-22T12:00:00Z',odds:{home:1.8,draw:3.2,away:null},oddsSource:'500-sp',sourceUpdatedAt:'2026-09-22T05:55:00Z',quoteStatus:'missing'},{id:'sporttery_b',sourceMatchId:'b',matchNo:'周三002',businessDate:'2026-09-23',homeTeamName:'乌迪内斯',awayTeamName:'博洛尼亚',leagueName:'意甲',status:'SCHEDULED',kickoffTime:'2026-09-23T12:00:00Z',odds:{home:2.1,draw:null,away:3.3},quoteStatus:'missing'},{id:'sporttery_c',sourceMatchId:'c',matchNo:'周三003',businessDate:'2026-09-23',homeTeamName:'马德里竞技',awayTeamName:'塞维利亚',leagueName:'西甲',status:'SCHEDULED',kickoffTime:'2026-09-23T13:00:00Z',odds:{home:1.9,draw:3.2,away:4.1},sourceUpdatedAt:null,quoteStatus:'unverified'}];
const overview=()=>({businessDate:'2026-09-22',sourceUpdatedAt:'2026-09-22T05:59:00Z',stale:false,matches:structuredClone(fixtures),review:{updatedAt:'2026-09-22T05:00:00Z',summary:{settled:20,won:8,pending:4,hitRate:.4},example:{decisionId:'decision_saved',matchId:'sporttery_review',homeTeamName:'历史主队',awayTeamName:'历史客队',publishedAt:'2026-09-21T00:00:00Z',cutoffTime:'2026-09-21T01:00:00Z',tipCode:'2',odds:2.35,state:'LOST',score:'2-0',quoteSource:'official-archived-sp',quoteObservedAt:'2026-09-20T23:50:00Z'}}});
async function harness({data=overview(),failure=false,matchId,route={pathname:'/fixtures',search:'',hash:'',state:null},user=null,access={active:false,trialAvailable:false,expiresAt:null}}={}){
 let cursor=0,search=route.search,requestedId=matchId,responder=null,now=0,nextTimer=0;const cells=[],effects=[],fetches=[],requests=[],timers=new Map();
 const surface=()=>{const listeners=new Map();return{addEventListener(type,fn){const set=listeners.get(type)||new Set();set.add(fn);listeners.set(type,set);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},fire(type){for(const fn of [...(listeners.get(type)||[])])fn();},count(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);}};};
 const document={...surface(),visibilityState:'visible'},window=surface();
 const setTimer=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,at:now+delay});return id;},clearTimer=id=>timers.delete(id);
 const flush=async()=>{await new Promise(setImmediate);};
 const polling=compile('../src/services/pollingController.ts',require,{setTimeout:setTimer,clearTimeout:clearTimer});
 const accountApi=compile('../src/services/accountApi.ts',id=>id==='./runtimeUrls'?{buildApiUrl:p=>p}:require(id));
 const mod=compile('../src/pages/PublicBrowse.tsx',id=>{
 if(id==='react')return{useState:initial=>{const n=cursor++;if(!(n in cells))cells[n]=typeof initial==='function'?initial():initial;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},useRef:initial=>{const n=cursor++;if(!(n in cells))cells[n]={current:initial};return cells[n];},useEffect:(fn,deps)=>{const n=cursor++,old=cells[n];if(!old||deps.some((value,i)=>value!==old.deps[i])){cells[n]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[n].cleanup?.();cells[n].cleanup=fn();});}}};
 if(id==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
 if(id==='react-router-dom')return{Link:'a',useLocation:()=>({...route,search}),useParams:()=>({matchId:requestedId}),useSearchParams:()=>[new URLSearchParams(search),(next)=>{search='?'+next.toString();}]};
 if(id==='lucide-react')return new Proxy({},{get:()=>()=>null});if(id.endsWith('/AccountContext'))return{useAccount:()=>({user,access})};if(id.endsWith('/AppContextCore'))return{useApp:()=>({language:'zh'})};if(id.endsWith('/FollowButton'))return{FollowButton:'follow'};if(id.endsWith('/TeamBadge'))return{TeamBadge:'badge'};if(id.endsWith('/runtimeUrls'))return{buildApiUrl:p=>p};if(id.endsWith('/accountApi'))return accountApi;if(id.endsWith('/pollingController'))return polling;if(id.endsWith('.css'))return{};throw Error(id);
 },{document,window,setTimeout:setTimer,clearTimeout:clearTimer,fetch:async(url,options)=>{fetches.push(url);requests.push({url,...options});if(responder)return responder(url,options);if(failure)return{ok:false,status:503};return{ok:true,json:async()=>url.includes('/matches/')?{match:data.matches[0]}:data};}});
 const render=()=>{cursor=0;const tree=mod.PublicBrowse();while(effects.length)effects.shift()();return tree;};let tree=render();assert.match(words(tree),/正在读取/);await flush();return{render,fetches,requests,document,window,timers,flush,setResponder:fn=>{responder=fn;},route:next=>{requestedId=next;route.pathname='/match/'+next;return render();},async advance(ms){const end=now+ms;for(;;){const due=[...timers].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}now=end;await flush();},unmount(){for(const cell of cells)cell?.cleanup?.();},get search(){return search;}};
}
const cards=t=>nodes(t,n=>n.type==='article'&&n.props.className==='public-fixture');
test('public fixtures select current business date and keep search/date in URL',async()=>{const u=await harness();let t=u.render();assert.equal(cards(t).length,1);assert.match(words(cards(t)[0]),/阿森纳/);nodes(t,n=>n.type==='select')[0].props.onChange({target:{value:'2026-09-23'}});t=u.render();assert.equal(cards(t).length,2);assert.match(words(cards(t)[0]),/乌迪内斯/);assert.match(u.search,/date=2026-09-23/);nodes(t,n=>n.type==='input')[0].props.onChange({target:{value:'  博洛尼亚  '}});assert.equal(cards(u.render()).length,1);assert.match(u.search,/q=/);});
test('case-insensitive English search and clear-filter empty action are usable',async()=>{const u=await harness();let t=u.render();nodes(t,n=>n.type==='input')[0].props.onChange({target:{value:' ARSENAL '}});assert.equal(cards(u.render()).length,1);nodes(u.render(),n=>n.type==='input')[0].props.onChange({target:{value:'不存在'}});t=u.render();assert.equal(cards(t).length,0);assert.match(words(t),/没有匹配的比赛/);nodes(t,n=>n.type==='button'&&words(n)==='清除搜索')[0].props.onClick();assert.equal(cards(u.render()).length,1);});
test('public quote snapshots distinguish missing prices from unverified time without exposing providers or inventing odds',async()=>{const u=await harness(),t=u.render(),c=cards(t)[0];assert.match(words(c),/胜平负 SP 有缺项/);assert.match(words(c),/报价记录 09\/22 13:55/);assert.match(words(c),/1\.80/);assert.match(words(c),/客胜—/);assert.doesNotMatch(words(c),/500-sp|报价来源|官方赔率/);nodes(t,n=>n.type==='select')[0].props.onChange({target:{value:'2026-09-23'}});const dayCards=cards(u.render());const missing=words(dayCards[0]),unverified=words(dayCards[1]);assert.match(missing,/胜平负 SP 有缺项/);assert.match(missing,/平局—/);assert.doesNotMatch(missing,/来源未标注/);assert.match(unverified,/赛程胜平负 SP 已取得，报价时间未核验/);assert.match(unverified,/主胜1\.90平局3\.20客胜4\.10/);assert.doesNotMatch(unverified,/报价记录|胜平负 SP 有缺项/);});
test('network failure has retry and does not announce zero fixtures as a successful empty day',async()=>{const u=await harness({failure:true}),text=words(u.render());assert.match(text,/内容更新失败，已读取内容可能滞后，请重试/);assert.doesNotMatch(text,/这个竞彩日暂无比赛/);assert.equal(nodes(u.render(),n=>n.type==='button'&&words(n)==='重试').length,1);});
test('public historical sample reports actual loss and auditable quote fields; missing totals stay unknown',async()=>{const data=overview();data.review.summary=null;const u=await harness({data,route:{pathname:'/review',search:'',hash:'',state:null}}),t=u.render(),text=words(t);assert.equal(cards(t).length,0);assert.match(text,/未命中/);assert.match(text,/official-archived-sp/);assert.match(text,/decision_saved/);assert.match(text,/历史命中率—/);assert.doesNotMatch(text,/历史命中率0\.0%/);});
test('unknown requested date stays visible in picker and yields genuine no-fixture state',async()=>{const u=await harness({route:{pathname:'/fixtures',search:'?date=2026-10-01',hash:'',state:null}}),t=u.render();assert.equal(cards(t).length,0);assert.match(words(t),/2026-10-01 · 暂无赛程/);assert.match(words(t),/这个竞彩日暂无比赛/);});
test('public detail drops unsafe back path and preserves its route as the sign-in return',async()=>{const u=await harness({matchId:'sporttery_a',route:{pathname:'/match/sporttery_a',search:'?tab=history',hash:'#evidence',state:{fromPath:'/\\evil.example'}}}),t=u.render();assert.equal(nodes(t,n=>n.type==='a'&&n.props.className==='public-back')[0].props.to,'/fixtures');assert.equal(nodes(t,n=>n.type==='a'&&n.props.className==='public-cta')[0].props.to,'/auth?returnTo=%2Fmatch%2Fsporttery_a%3Ftab%3Dhistory%23evidence');assert.equal(u.fetches.length,2);});

test('public sample includes only actual published probability values and preserves missing outcomes',async()=>{const data=overview();data.review.example.probabilities={'1':.4,X:null,'2':.35};const u=await harness({data,route:{pathname:'/review',search:'',hash:'',state:null}}),t=u.render(),sample=nodes(t,n=>n.props?.className==='public-example')[0];assert.match(words(sample),/发布时胜平负模型概率（参考）/);assert.match(words(sample),/主胜40\.0%/);assert.match(words(sample),/平局—/);assert.match(words(sample),/客胜35\.0%/);});

test('guest recommendation preview retains both combo entries and exact login return tabs without private reads',async()=>{
 const u=await harness({route:{pathname:'/best',search:'?tab=three',hash:'',state:null}}),t=u.render();
 const section=nodes(t,n=>n.props?.['aria-label']==='每日串关入口')[0];assert(section);assert.match(words(section),/2串1SP≥2\.50/);assert.match(words(section),/3串1SP≥5\.00/);assert.match(words(section),/尚未登录/);assert.match(words(section),/不代表今天没有组合/);
 const links=nodes(section,n=>n.type==='a');assert.equal(links.length,2);
 for(const [index,link] of links.entries()){assert.equal(link.props.to.split('?')[0],'/auth');assert.equal(new URLSearchParams(link.props.to.split('?')[1]).get('returnTo'),`/best?tab=${index?'three':'two'}`);}
 assert.deepEqual(u.fetches,['/api/public/overview']);assert.doesNotMatch(words(section),/decision_saved|历史主队|3\.60|5\.69/);
});

test('inactive account combo entry distinguishes unclaimed trial from expired access and retains target',async()=>{
 for(const scenario of [{access:{active:false,trialAvailable:true,expiresAt:null},message:'尚未领取体验',action:'领取3天体验'},{access:{active:false,trialAvailable:false,expiresAt:'2020-01-01T00:00:00Z'},message:'内容权益已到期',action:'管理内容权益'},{access:{active:false,trialAvailable:false,expiresAt:null},message:'暂无有效内容权益',action:'管理内容权益'}]){
  const u=await harness({route:{pathname:'/best',search:'',hash:'',state:null},user:{id:'u'},access:scenario.access}),section=nodes(u.render(),n=>n.props?.['aria-label']==='每日串关入口')[0];
  assert.match(words(section),new RegExp(scenario.message));assert.match(words(section),new RegExp(scenario.action));
  const link=nodes(section,n=>n.type==='a')[1];assert.equal(link.props.to.split('?')[0],'/account');assert.equal(new URLSearchParams(link.props.to.split('?')[1]).get('returnTo'),'/best?tab=three');assert.deepEqual(u.fetches,['/api/public/overview']);
 }
});

test('public fixture and review pages do not acquire an unrelated locked combo section',async()=>{
 for(const pathname of ['/fixtures','/review']){const u=await harness({route:{pathname,search:'',hash:'',state:null}});assert.equal(nodes(u.render(),n=>n.props?.['aria-label']==='每日串关入口').length,0);}
});

const response=body=>({ok:true,status:200,json:async()=>body});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

test('visible public fixtures refresh changed SP after 30 seconds without resetting URL filters',async()=>{
 const u=await harness(),next=overview();next.sourceUpdatedAt='2026-09-22T06:29:00Z';next.matches[0].odds.home=1.65;
 nodes(u.render(),n=>n.type==='input')[0].props.onChange({target:{value:'Arsenal'}});
 u.setResponder(()=>response(next));await u.advance(29999);assert.equal(u.fetches.length,1);
 await u.advance(1);assert.equal(u.fetches.length,2);assert.match(words(cards(u.render())[0]),/主胜1\.65/);
 assert.match(words(u.render()),/赛程源更新 · 09\/22 14:29 · 北京时间/);assert.match(u.search,/q=Arsenal/);
 assert(u.requests.every(request=>request.cache==='no-store'));u.unmount();
});

test('hidden pages stop polling; visibility and focus refresh immediately without overlapping requests',async()=>{
 const u=await harness(),pending=deferred();u.document.visibilityState='hidden';u.document.fire('visibilitychange');
 await u.advance(60000);u.window.fire('focus');await u.flush();assert.equal(u.fetches.length,1);
 u.setResponder(()=>pending.promise);u.document.visibilityState='visible';u.document.fire('visibilitychange');u.window.fire('focus');
 await u.flush();assert.equal(u.fetches.length,2);
 pending.resolve(response(overview()));await u.flush();u.window.fire('focus');await u.flush();assert.equal(u.fetches.length,3);u.unmount();
});

test('manual refresh is available after success and updates the public snapshot',async()=>{
 const u=await harness(),next=overview();next.matches[0].odds.home=1.72;u.setResponder(()=>response(next));
 const button=nodes(u.render(),n=>n.type==='button'&&words(n)==='刷新资料')[0];assert(button);button.props.onClick();await u.flush();
 assert.equal(u.fetches.length,2);assert.match(words(cards(u.render())[0]),/主胜1\.72/);u.unmount();
});

test('background errors retain the last successful snapshot with a delay message, and recovery clears the error',async()=>{
 const u=await harness();u.setResponder(()=>({ok:false,status:503}));await u.advance(30000);
 assert.equal(cards(u.render()).length,1);assert.match(words(cards(u.render())[0]),/主胜1\.80/);assert.match(words(u.render()),/内容更新失败，已读取内容可能滞后/);
 const next=overview();next.matches[0].odds.home=1.68;u.setResponder(()=>response(next));await u.advance(30000);
 assert.match(words(cards(u.render())[0]),/主胜1\.68/);assert.doesNotMatch(words(u.render()),/内容更新失败/);u.unmount();
});

test('route switches hide the previous detail immediately and ignore an older HTTP response after cleanup',async()=>{
 const u=await harness({matchId:'sporttery_a',route:{pathname:'/match/sporttery_a',search:'',hash:'',state:null}}),pending=deferred();let oldSignal;
 u.setResponder((url,options)=>{if(url.endsWith('/sporttery_b')){oldSignal=options.signal;return pending.promise;}return response(overview());});
 const transition=u.route('sporttery_b');assert.equal(cards(transition).length,0);await u.flush();assert(oldSignal);assert.equal(oldSignal.aborted,false);
 const c={...fixtures[2],homeTeamName:'新的主队',awayTeamName:'新的客队'};
 u.setResponder(url=>response(url.includes('/matches/')?{match:c}:overview()));u.route('sporttery_c');await u.flush();assert.equal(oldSignal.aborted,true);
 const current=u.render();assert.match(words(cards(current)[0]),/新的主队/,JSON.stringify({text:words(current),fetches:u.fetches}));pending.resolve(response({match:fixtures[1]}));await u.flush();
 assert.equal(cards(u.render()).length,1);assert.match(words(cards(u.render())[0]),/新的主队/);assert.doesNotMatch(words(u.render()),/乌迪内斯/);u.unmount();
});

test('an unknown detail 404 cannot display a previous match or treat overview data as its detail',async()=>{
 const u=await harness({matchId:'sporttery_a',route:{pathname:'/match/sporttery_a',search:'',hash:'',state:null}});
 assert.equal(cards(u.render()).length,1);u.setResponder(url=>url.includes('/matches/')?{ok:false,status:404}:response(overview()));
 assert.equal(cards(u.route('unknown_event')).length,0);await u.flush();assert.equal(cards(u.render()).length,0);
 assert.match(words(u.render()),/暂时没有这场比赛的资料/);assert.doesNotMatch(words(u.render()),/阿森纳/);u.unmount();
});

test('same-detail 404 removes an earlier success while a transient error preserves it',async()=>{
 const u=await harness({matchId:'sporttery_a',route:{pathname:'/match/sporttery_a',search:'',hash:'',state:null}});
 u.setResponder(url=>url.includes('/matches/')?{ok:false,status:503}:response(overview()));await u.advance(30000);assert.equal(cards(u.render()).length,1);
 u.setResponder(url=>url.includes('/matches/')?{ok:false,status:404}:response(overview()));await u.advance(30000);
 assert.equal(cards(u.render()).length,0);assert.match(words(u.render()),/暂时没有这场比赛的资料/);u.unmount();
});

test('15-second request timeout aborts acquisition; unmount removes timers/listeners and prevents late state writes',async()=>{
 const u=await harness();let timedSignal;
 u.setResponder((_url,{signal})=>{timedSignal=signal;return new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(new Error('Aborted')),{once:true}));});
 nodes(u.render(),n=>n.type==='button'&&words(n)==='刷新资料')[0].props.onClick();await u.flush();
 await u.advance(14999);assert.equal(timedSignal.aborted,false);await u.advance(1);assert.equal(timedSignal.aborted,true);assert.equal(cards(u.render()).length,1);assert.match(words(u.render()),/可能滞后/);
 const pending=deferred();let stoppedSignal;u.setResponder((_url,{signal})=>{stoppedSignal=signal;return pending.promise;});
 nodes(u.render(),n=>n.type==='button'&&words(n)==='刷新资料')[0].props.onClick();await u.flush();u.unmount();
 assert.equal(stoppedSignal.aborted,true);assert.equal(u.timers.size,0);assert.equal(u.document.count(),0);assert.equal(u.window.count(),0);
 const next=overview();next.matches[0].odds.home=9.99;pending.resolve(response(next));await u.flush();assert.doesNotMatch(words(u.render()),/主胜9\.99/);
});
