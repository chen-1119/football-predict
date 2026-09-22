'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto');
function storage(){const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),dump:()=>[...m.values()]};}
function compile(file,requireFn,globals={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:requireFn,URL,URLSearchParams,Date,AbortController,setTimeout,clearTimeout,crypto,...globals});return module.exports;}
function service(globals={}){return compile('../src/services/accountApi.ts',id=>{if(id==='./runtimeUrls')return{buildApiUrl:p=>p};throw Error(id);},{sessionStorage:storage(),...globals});}
function hooks(){const cells=[];let cursor=0;return {reset(){cursor=0;},react:{createContext:()=>({Provider:'provider'}),useContext:()=>null,useCallback:fn=>fn,useEffect:()=>{},useMemo:fn=>fn(),useState:initial=>{const n=cursor++;if(!(n in cells))cells[n]=typeof initial==='function'?initial():initial;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},useRef:initial=>{const n=cursor++;if(!(n in cells))cells[n]={current:initial};return cells[n];}}};}
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
test('following refreshes verified results on entry, visible polling and focus, then cleans up',()=>{
 const effects=[],timers=new Map(),listeners=new Map();let calls=0,next=0;
 const h=hooks(),account={...guest(),user:{id:'u'},refreshFollowing:async()=>{calls++;}};
 const eventTarget={addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
 const doc={...eventTarget,visibilityState:'visible'};
 const win={...eventTarget,setInterval:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id)};
 const api=service(),mod=compile('../src/pages/Following.tsx',id=>{
  if(id==='react')return{...h.react,useEffect:fn=>effects.push(fn)};
  if(id==='react/jsx-runtime')return jsx;
  if(id==='react-router-dom')return{Link:'a',useLocation:()=>({pathname:'/following',search:''}),useSearchParams:()=>[new URLSearchParams(),()=>{}]};
  if(id.endsWith('/AccountContext'))return{useAccount:()=>account};
  if(id.endsWith('/AppContextCore'))return{useApp:()=>({language:'zh'})};
  if(id.endsWith('/accountApi'))return api;
  if(id==='lucide-react'||id.endsWith('.css'))return{};
  throw Error(id);
 },{window:win,document:doc});
 h.reset();mod.Following();const cleanups=effects.map(fn=>fn());assert.equal(calls,1);
 const poll=[...timers.values()].find(row=>row.ms===60000);assert(poll);poll.fn();assert.equal(calls,2);
 doc.visibilityState='hidden';poll.fn();listeners.get('focus')();assert.equal(calls,2);
 doc.visibilityState='visible';listeners.get('visibilitychange')();assert.equal(calls,3);
 cleanups.forEach(fn=>fn?.());assert.equal(timers.size,0);assert.equal(listeners.size,0);
});
const words=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(words).join(''):typeof n==='object'?words(n.props?.children):String(n);
const nodes=(n,p)=>n&&typeof n==='object'?(Array.isArray(n)?n.flatMap(v=>nodes(v,p)):[...(p(n)?[n]:[]),...nodes(n.props?.children,p)]):[];
const button=(tree,label)=>nodes(tree,n=>n.type==='button'&&words(n).trim()===label)[0];
const input=(tree,id)=>nodes(tree,n=>n.type==='input'&&n.props.id===id)[0];
const change=(tree,id,value)=>input(tree,id).props.onChange({target:{value}});
function ui(file,exportName,account,route={pathname:'/auth',search:'',hash:'',state:null},props={}){
  const h=hooks(),store=storage(),api=service({sessionStorage:store}),navigations=[],legacy=[],app={language:'zh',verifyAccessCode:async code=>legacy.push(code)};
  const mod=compile(file,id=>{if(id==='react')return h.react;if(id==='react/jsx-runtime')return jsx;if(id==='lucide-react')return new Proxy({},{get:()=>()=>null});if(id==='react-router-dom')return{Link:'a',useLocation:()=>route,useNavigate:()=>((...args)=>navigations.push(args)),useSearchParams:()=>[new URLSearchParams(route.search||''),next=>{route.search='?'+next.toString();}]};if(id.endsWith('/AccountContext'))return{useAccount:()=>account};if(id.endsWith('/AppContextCore'))return{useApp:()=>app};if(id.endsWith('/accountApi'))return api;if(id.endsWith('/accessControl'))return{formatAccessCode:v=>v};if(id.endsWith('.css'))return{};throw Error(id);},{navigator:{clipboard:{writeText:async()=>{}}}});
  return{api,store,navigations,legacy,render(){h.reset();return mod[exportName](props);}};
}
const guest=()=>({user:null,loading:false,sessionError:null,authMethods:{password:true,sms:false},access:{active:false,kind:null,expiresAt:null,trialAvailable:false},following:[],followingLoading:false,followingError:null});

test('returnTo rejects external, scheme-relative, backslash, encoded control and auth loops',()=>{
 const api=service();for(const path of ['https://evil.example/x','//evil.example/x','/\\evil.example','/%2f%2fevil.example','/%5cevil','/a%0db','/auth?returnTo=/auth'])assert.equal(api.safeAccountReturnTo(path),'/best',path);
 assert.equal(api.safeAccountReturnTo('/match/sporttery_1?tab=history#result'),'/match/sporttery_1?tab=history#result');
});
test('pending follow keeps only stable identity and local return path, expires and clears the matching intent',()=>{
 const store=storage(),api=service({sessionStorage:store});const p=api.savePendingFollow({matchId:'sporttery_42',decisionId:'decision_frozen',returnTo:'//evil.example'});
 assert.equal(p.returnTo,'/best');assert.equal(api.readPendingFollow().decisionId,'decision_frozen');assert.equal(api.readPendingFollow(store,p.createdAt+1800001),null);
 api.clearPendingFollow('different');assert(api.readPendingFollow());api.clearPendingFollow(p.intentId);assert.equal(api.readPendingFollow(),null);
 assert(!store.dump().join('').match(/password|csrf|token/i));
});
test('account transport uses cookies and CSRF without bearer tokens or user ownership fields',async()=>{
 const calls=[],api=service({fetch:async(url,options)=>{calls.push({url,options});return{ok:true,status:200,json:async()=>({ok:true,row:{id:'own'}})};}});
 await api.accountRequest('/follows',{method:'POST',body:{matchId:'m',decisionId:'d'},csrfToken:'session-csrf'});
 assert.equal(calls[0].url,'/api/account/follows');assert.equal(calls[0].options.credentials,'include');assert.equal(calls[0].options.headers['x-csrf-token'],'session-csrf');assert.equal(calls[0].options.headers.authorization,undefined);assert.deepEqual(JSON.parse(calls[0].options.body),{matchId:'m',decisionId:'d'});
});
test('account API errors are reported rather than treated as empty data',async()=>{
 const api=service({fetch:async()=>({ok:false,status:401,json:async()=>({ok:false,error:{code:'session_expired',message:'登录已失效'}})})});await assert.rejects(api.accountRequest('/follows'),e=>e.status===401&&e.message==='登录已失效');
});
test('following groups require explicit official status; pending or disputed scores are not settled wins',()=>{
 const api=service(),now=Date.parse('2026-09-22T06:00:00Z'),base={homeTeamName:'阿森纳',awayTeamName:'对手',kickoffTime:'2026-09-22T07:00:00Z',decision:null,result:null};
 assert.equal(api.followGroup(base,now),'upcoming');assert.equal(api.followGroup({...base,kickoffTime:'2026-09-21T07:00:00Z',result:{state:'DISPUTED',score:'2-1'}},now),'pending');assert.equal(api.followGroup({...base,result:{state:'WON',score:'2-1'}},now),'settled');assert.equal(api.followGroup({...base,result:{state:'FINISHED',score:'2-1'}},now),'settled');
 assert.equal(api.filterFollowing([base], ' 阿森纳 ', 'upcoming',now).length,1);assert.equal(api.filterFollowing([base],'不存在','all',now).length,0);
});
test('guest follow preserves match, frozen decision and current view through login',async()=>{
 const account=guest(),route={pathname:'/match/sporttery_42',search:'?tab=history',hash:'#saved',state:null},u=ui('../src/components/FollowButton.tsx','FollowButton',account,route,{matchId:'sporttery_42',decisionId:'frozen-42'});
 await button(u.render(),'关注比赛').props.onClick();assert.equal(u.api.readPendingFollow().decisionId,'frozen-42');assert.match(u.navigations[0][0],/^\/auth\?returnTo=/);assert.equal(u.navigations[0][1].state.returnTo,'/match/sporttery_42?tab=history#saved');
});
test('registration shows recovery once and requires save acknowledgement before resuming follow and return',async()=>{
 const account=guest();let resumes=0,trials=0;account.register=async()=>{account.user={id:'u',displayName:'新用户'};return'ONE-TIME-RECOVERY';};account.resumePendingFollow=async()=>{resumes++;return true;};account.claimTrial=async()=>{trials++;};
 const u=ui('../src/pages/Auth.tsx','Auth',account,{pathname:'/auth',search:'?returnTo=%2Fmatch%2Fsporttery_42',state:null});u.api.savePendingFollow({matchId:'sporttery_42',returnTo:'/match/sporttery_42'});
 let tree=u.render();button(tree,'注册账号').props.onClick();tree=u.render();change(tree,'account-username','footballfan');change(tree,'account-password','a long secure passphrase');change(tree,'account-confirm-password','a long secure passphrase');tree=u.render();await nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});tree=u.render();
 assert.match(words(tree),/ONE-TIME-RECOVERY/);assert.equal(button(tree,'保存并继续').props.disabled,true);assert.equal(u.navigations.length,0);assert.equal(trials,0);nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});tree=u.render();await button(tree,'保存并继续').props.onClick();assert.equal(resumes,1);assert.equal(u.navigations[0][0],'/match/sporttery_42');
});
test('registration mismatch does not call backend and passwords have 15-character minimum',async()=>{
 const account=guest();let calls=0;account.register=async()=>{calls++;};const u=ui('../src/pages/Auth.tsx','Auth',account);let t=u.render();button(t,'注册账号').props.onClick();t=u.render();assert.equal(input(t,'account-password').props.minLength,15);change(t,'account-password','one long passphrase');change(t,'account-confirm-password','different passphrase');t=u.render();await nodes(t,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});assert.equal(calls,0);assert.match(words(u.render()),/两次输入的密码不一致/);
});
test('password recovery shows rotated code and returns to login without auto-sign-in',async()=>{
 const account=guest();let calls=0;account.recoverPassword=async()=>{calls++;return'ROTATED-CODE';};const u=ui('../src/pages/Auth.tsx','Auth',account);let t=u.render();button(t,'忘记密码？使用恢复码').props.onClick();t=u.render();change(t,'account-username','footballfan');change(t,'account-recovery-input','OLD-CODE');change(t,'account-password','a new long passphrase');change(t,'account-confirm-password','a new long passphrase');t=u.render();await nodes(t,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});t=u.render();assert.equal(calls,1);assert.match(words(t),/ROTATED-CODE/);nodes(t,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});t=u.render();await button(t,'返回登录').props.onClick();assert.equal(u.navigations.length,0);assert.match(words(u.render()),/密码已重置/);assert.equal(account.user,null);
});
test('following without saved decision never claims personal hit from result flags',()=>{
 const account={...guest(),user:{id:'u'},following:[{id:'f',matchId:'m',homeTeamName:'甲队',awayTeamName:'乙队',kickoffTime:'2026-09-20T00:00:00Z',createdAt:'2026-09-19T00:00:00Z',decision:null,result:{state:'WON',score:'2-1'}}]};const u=ui('../src/pages/Following.tsx','Following',account),text=words(u.render());assert.match(text,/当时没有可保存的推荐/);assert.match(text,/仅展示比赛结果，不计个人命中/);assert.doesNotMatch(text,/命中2-1/);
});
test('AccountProvider coalesces pending-follow resume and clears private rows when account changes',async()=>{
 const store=storage(),h=hooks();let activeUser=null,followCalls=0;const profile=()=>({ok:true,user:activeUser,access:{active:false,kind:null,expiresAt:null,trialAvailable:true},authMethods:{password:true,sms:false},csrfToken:'csrf'});
 const api=service({sessionStorage:store,fetch:async(url,options)=>{if(url.endsWith('/login')){activeUser={id:JSON.parse(options.body).username,username:'person'};return{ok:true,status:200,json:async()=>profile()};}if(url.endsWith('/follows')&&options.method==='POST'){followCalls++;await new Promise(r=>setTimeout(r,5));return{ok:true,status:200,json:async()=>({ok:true,row:{id:'f',matchId:'m'}})};}return{ok:true,status:200,json:async()=>profile()};}});
 const mod=compile('../src/context/AccountContext.tsx',id=>{if(id==='react')return h.react;if(id==='react/jsx-runtime')return jsx;if(id.endsWith('/accountApi'))return api;throw Error(id);});const render=()=>{h.reset();return mod.AccountProvider({children:null}).props.value;};
 let c=render();await c.refresh();c=render();await c.login('first','correct password');c=render();api.savePendingFollow({matchId:'m',returnTo:'/match/m'});await Promise.all([c.resumePendingFollow(),c.resumePendingFollow()]);c=render();assert.equal(followCalls,1);assert.equal(c.following.length,1);assert.equal(api.readPendingFollow(),null);await c.login('second','correct password');c=render();assert.equal(c.user.id,'second');assert.equal(c.following.length,0);
});

test('following reads result tab and search from URL and preserves both through changes and guest login',()=>{
 const rows=[{id:'a',matchId:'a',homeTeamName:'目标球队',awayTeamName:'客队',kickoffTime:'2026-09-20T00:00:00Z',decision:null,result:{state:'FINISHED',score:'1-0'}},{id:'b',matchId:'b',homeTeamName:'另一队',awayTeamName:'客队',kickoffTime:'2099-01-01T00:00:00Z',decision:null,result:null}];const route={pathname:'/following',search:'?tab=settled&q=%E7%9B%AE%E6%A0%87',hash:'',state:null};const a={...guest(),user:{id:'u'},following:rows};const u=ui('../src/pages/Following.tsx','Following',a,route);let t=u.render();assert.match(words(t),/目标球队/);assert.doesNotMatch(words(t),/另一队/);assert.equal(nodes(t,n=>n.type==='button'&&n.props['aria-pressed']===true)[0].props.children[0],'已结算');nodes(t,n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:'客队'}});assert.match(route.search,/tab=settled/);assert.match(route.search,/q=/);
 const anonymous=ui('../src/pages/Following.tsx','Following',guest(),route);const login=nodes(anonymous.render(),n=>n.type==='a')[0];assert.equal(new URLSearchParams(login.props.to.split('?')[1]).get('returnTo'),'/following'+route.search);
});
test('failed password login keeps anonymous CSRF and password form available for another attempt',async()=>{
 const h=hooks(),requests=[],profile={ok:true,user:null,access:{active:false,kind:null,expiresAt:null,trialAvailable:false},authMethods:{password:true,sms:false},csrfToken:'anon-csrf'};const api=service({fetch:async(url,options)=>{requests.push({url,options});return url.endsWith('/login')?{ok:false,status:401,json:async()=>({ok:false,error:'invalid_credentials'})}:{ok:true,status:200,json:async()=>profile};}});const mod=compile('../src/context/AccountContext.tsx',id=>id==='react'?h.react:id==='react/jsx-runtime'?jsx:id.endsWith('/accountApi')?api:require(id));const render=()=>{h.reset();return mod.AccountProvider({children:null}).props.value;};let c=render();await c.refresh();c=render();await assert.rejects(c.login('person','wrong password'),/账号或密码不正确/);c=render();assert.equal(c.authMethods.password,true);await assert.rejects(c.login('person','another wrong password'));assert.equal(requests.filter(x=>x.url.endsWith('/me')).length,1);assert.equal(requests.at(-1).options.headers['x-csrf-token'],'anon-csrf');
});
test('blocked account me refresh clears previous account and its saved rows',async()=>{
 const h=hooks();let blocked=false;const api=service({fetch:async()=>blocked?{ok:false,status:403,json:async()=>({ok:false,error:'account_blocked'})}:{ok:true,status:200,json:async()=>({ok:true,user:{id:'first',username:'first'},access:{active:true,kind:'trial',expiresAt:'2099-01-01T00:00:00Z',trialAvailable:false},authMethods:{password:true,sms:false},csrfToken:'csrf'})}});const mod=compile('../src/context/AccountContext.tsx',id=>id==='react'?h.react:id==='react/jsx-runtime'?jsx:id.endsWith('/accountApi')?api:require(id));const render=()=>{h.reset();return mod.AccountProvider({children:null}).props.value;};let c=render();await c.refresh();assert.equal(render().user.id,'first');blocked=true;await assert.rejects(c.refresh());c=render();assert.equal(c.user,null);assert.equal(c.access.active,false);assert.equal(c.following.length,0);
});
