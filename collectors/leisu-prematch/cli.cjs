'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const scope=require('./scope.cjs');
const store=require('./store.cjs');
const browser=require('./browser.cjs');
const runtime=require('./runtime-policy.cjs');
const {shouldPauseSource}=require('./failure-policy.cjs');

function args(argv){
  const command=argv[0]||'doctor', options={};
  if(!['doctor','plan','login','probe','collect-once','migrate','export','resume','discover'].includes(command)) throw new Error('Unknown command');
  for(let i=1;i<argv.length;i+=2){
    const key=argv[i];
    if(!['--fixtures','--mappings','--now','--site-match-id'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--')) throw new Error('Unknown or incomplete option');
    options[key.slice(2)]=argv[i+1];
  }
  if(command!=='plan'&&(options.now||options.fixtures)) throw new Error('Offline fixtures and --now are allowed only for plan; never for collection');
  if(options['site-match-id']&&command!=='probe') throw new Error('--site-match-id is only for probe');
  return {command,options};
}
function config(env=process.env){
  const stateDir=path.resolve(env.LEISU_STATE_DIR||path.join(__dirname,'state'));
  const maxAge=Number(env.LEISU_FIXTURE_MAX_AGE_MINUTES||60);
  if(!Number.isFinite(maxAge)||maxAge<=0||maxAge>360) throw new Error('Invalid fixture freshness limit');
  const leagueUrls=JSON.parse(env.LEISU_LEAGUE_URLS_JSON||'[]');
  if(!Array.isArray(leagueUrls)||leagueUrls.some(u=>!/^https:\/\/www\.leisu\.com\/data\/zuqiu\/comp-[1-9]\d*$/.test(u)))throw new Error('Invalid league URL allowlist');
  const maxPages=Number(env.LEISU_MAX_PAGES_PER_RUN||12),maxRunSeconds=Number(env.LEISU_MAX_RUN_SECONDS||480);
  runtime.createRunPolicy({maxPages,maxRunSeconds});
  return {stateDir,leagueUrls,aliasesFile:env.LEISU_TEAM_ALIASES_FILE?path.resolve(env.LEISU_TEAM_ALIASES_FILE):null,
    profileDir:path.resolve(env.LEISU_PROFILE_DIR||path.join(stateDir,'browser')),
    mappingsFile:path.resolve(env.LEISU_MAPPINGS_FILE||path.join(__dirname,'mappings.example.json')),
    outputFile:path.resolve(env.LEISU_OUTPUT_FILE||path.join(stateDir,'latest-evidence.json')),
    fixtureUrl:env.LEISU_FIXTURE_DATABASE_URL||'',databaseUrl:env.LEISU_DATABASE_URL||'',maxAge,maxPages,maxRunSeconds,
    enabled:env.LEISU_ENABLED==='1',accessValidated:env.LEISU_ACCESS_VALIDATED==='1',
    headless:!['0','false'].includes(env.LEISU_HEADLESS||'true')};
}
function loadMappings(cfg,file){
  const manual=readJson(file);
  if(!Array.isArray(manual))throw new Error('Mappings file must be a JSON array');
  const autoFile=path.join(cfg.stateDir,'auto-mappings.json');
  const auto=fs.existsSync(autoFile)?readJson(autoFile).mappings:[];
  if(!Array.isArray(auto))throw new Error('Invalid discovered mappings file');
  const manualIds=new Set(manual.map(m=>m.siteMatchId));
  return [...manual,...auto.filter(m=>!manualIds.has(m.siteMatchId))];
}
async function discoverMappings(cfg,getContext,input,policy,readLatestFeed){
  if(!cfg.leagueUrls.length)throw new Error('No approved league pages configured in LEISU_LEAGUE_URLS_JSON');
  const leagueUrls=[...new Set(cfg.leagueUrls)].sort();
  const today=scope.windowFor().today,progressFile=path.join(cfg.stateDir,'discovery-progress.json');
  const previous=fs.existsSync(progressFile)?readJson(progressFile):null;
  let age=NaN;
  if(typeof previous?.startedAt==='string'){
    try{age=Date.now()-Date.parse(scope.windowFor(previous.startedAt).nowUtc);}catch{}
  }
  const reusable=previous?.today===today&&Number.isFinite(age)&&age>=0&&age<=6*3600000
    &&JSON.stringify(previous.leagueUrls)===JSON.stringify(leagueUrls)
    &&Array.isArray(previous.completedUrls)&&new Set(previous.completedUrls).size===previous.completedUrls.length
    &&previous.completedUrls.every(url=>leagueUrls.includes(url))&&Array.isArray(previous.candidates)
    &&previous.candidates.every(candidate=>previous.completedUrls.includes(candidate?.sourceUrl))
    &&(previous.failureAttempts===undefined||Array.isArray(previous.failureAttempts));
  const progress=reusable?previous:{today,leagueUrls,startedAt:new Date().toISOString(),completedUrls:[],candidates:[]};
  progress.failureAttempts ||= [];
  const deferred=[];
  for(const url of leagueUrls.filter(url=>!progress.completedUrls.includes(url))){
    const failures=progress.failureAttempts.filter(attempt=>attempt.sourceUrl===url);
    if(failures.length>=2){deferred.push({sourceUrl:url,reason:'discovery-retries-exhausted'});continue;}
    const lastFailure=failures.at(-1),retryAt=lastFailure?Date.parse(lastFailure.receivedAt)+10*60000:null;
    if(lastFailure&&(!Number.isFinite(retryAt)||Date.now()<retryAt)){
      deferred.push({sourceUrl:url,reason:'discovery-retry-wait',retryAt:Number.isFinite(retryAt)?new Date(retryAt).toISOString():null});continue;
    }
    if(policy?.stopReason())return {completed:false,reason:policy.stopReason(),deferred};
    // Launch lazily: a cursor waiting for retry does not need Chromium.
    const context=typeof getContext==='function'?await getContext():getContext;
    if(!context||(policy&&!policy.tryStartPage()))return {completed:false,reason:policy?.stopReason()||'browser-unavailable',deferred};
    let result;
    try{result=await browser.collectLeague(context,url);}catch{
      result={status:'parse_error',reason:'unexpected-league-discovery-error',httpStatus:null};
    }
    if(policy?.interruptionReason())return {completed:false,reason:policy.interruptionReason()};
    if(scope.windowFor().today!==today)return {completed:false,reason:'discovery-window-changed'};
    if(result?.status==='available'&&(!Array.isArray(result.candidates)||!result.candidates.length))result={status:'parse_error',reason:'invalid-league-rows',httpStatus:result.httpStatus};
    if(result?.status!=='available'){
      const failure={sourceUrl:url,receivedAt:new Date().toISOString(),status:result?.status||'parse_error',
        reason:result?.reason||'invalid-league-result',httpStatus:Number.isInteger(result?.httpStatus)?result.httpStatus:null};
      progress.failureAttempts.push(failure);progress.updatedAt=failure.receivedAt;
      atomicJson(progressFile,progress);
      if(shouldPauseSource(failure))return {completed:false,reason:'league-discovery-failed',failure,deferred};
      deferred.push({sourceUrl:url,reason:failures.length?'discovery-retries-exhausted':'discovery-retry-wait',
        retryAt:failures.length?null:new Date(Date.parse(failure.receivedAt)+10*60000).toISOString()});
      continue;
    }
    progress.completedUrls.push(url);
    progress.candidates.push(...result.candidates);
    progress.updatedAt=new Date().toISOString();
    atomicJson(progressFile,progress);
  }
  if(policy?.interruptionReason())return {completed:false,reason:policy.interruptionReason()};
  if(deferred.length)return {completed:false,reason:'discovery-retry-pending',deferred};
  const current=readLatestFeed?await readLatestFeed():input;
  if(policy?.interruptionReason())return {completed:false,reason:policy.interruptionReason()};
  const aliases=cfg.aliasesFile?readJson(cfg.aliasesFile):{};
  const selected=scope.selectFixtures(current.matches,new Date());
  if(selected.window.today!==today)return {completed:false,reason:'discovery-window-changed'};
  const result=require('./mapping.cjs').reconcileMappings(selected.selected,progress.candidates,aliases,new Date());
  const record={generatedAt:new Date().toISOString(),window:selected.window,...result};
  atomicJson(path.join(cfg.stateDir,'auto-mappings.json'),record);
  if(fs.existsSync(progressFile))fs.unlinkSync(progressFile);
  return {...record,completed:true};
}
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temp,file);
}
function lock(cfg){
  fs.mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});
  const file=path.join(cfg.stateDir,'collector.lock');
  const fd=fs.openSync(file,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  fs.closeSync(fd);
  return ()=>fs.unlinkSync(file);
}
function requireUrl(value,label){if(!value)throw new Error(label+' is not configured');return value;}
async function withPool(url,label,fn){const pool=store.createPool(requireUrl(url,label));try{return await fn(pool);}finally{await pool.end();}}
async function feed(cfg,options){
  if(options.fixtures){
    const parsed=readJson(path.resolve(options.fixtures));
    if(!Array.isArray(parsed.matches))throw new Error('Offline file must contain matches[]');
    return {...parsed,offline:true};
  }
  return withPool(cfg.fixtureUrl,'LEISU_FIXTURE_DATABASE_URL',p=>store.readFixtureFeed(p,cfg.maxAge));
}
function buildPlan(input,mappings,attempts,now){
  const selected=scope.selectFixtures(input.matches,now);
  const scheduled=scope.buildTasks(selected.selected,mappings,schedulingAttempts(attempts,now),now);
  scheduled.tasks=runtime.prioritizeTasks(scheduled.tasks);
  return {mode:input.offline?'offline-sample-plan':'server-fixture-plan',feedGeneratedAt:input.generatedAt,
    generationId:input.generationId||null,...selected,...scheduled,
    summary:{eligibleMatches:selected.selected.length,excludedMatches:selected.excluded.length,
      dueTasks:scheduled.tasks.length,unmappedMatches:scheduled.skipped.filter(s=>s.reason==='unmapped').length},
    productionWritten:false,automaticOddsEnabled:false};
}
function mappingNeedsRefresh(record,now=new Date()){
  const age=new Date(now).getTime()-Date.parse(record?.generatedAt);
  return !Number.isFinite(age)||age<0||age>6*3600000||record?.window?.today!==scope.windowFor(now).today;
}
function schedulingAttempts(attempts,now){
  const ms=new Date(now).getTime(),groups=new Map(),held=[];
  for(const a of attempts){if(!groups.has(a.taskKey))groups.set(a.taskKey,[]);groups.get(a.taskKey).push(a);}
  for(const group of groups.values()){
    const good=group.find(a=>['available','source_empty'].includes(a.status));
    if(good){held.push(good);continue;}
    group.sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
    // At most two real attempts per due slot, with a ten-minute gap. Source
    // blocking still requires an operator to clear the circuit before retry.
    if(group.length>=2 || !Number.isFinite(Date.parse(group[0].receivedAt)) || ms-Date.parse(group[0].receivedAt)<10*60000)held.push(group[0]);
  }
  return held;
}
function filterEvidence(evidence,fixture,providerMatchId){
  const copy=structuredClone(evidence);
  for(const section of Object.values(copy.sections)){
    for(const field of ['latestValid','latestAttempt']){
      const observation=section[field];if(!observation)continue;
      const p=observation.data;
      if(!providerMatchId||observation.providerMatchId!==providerMatchId||observation.siteMatchId!==fixture.siteMatchId||observation.eventVersion!==fixture.eventVersion||
        (p&&(p.homeName!==fixture.homeName||p.awayName!==fixture.awayName||p.kickoffUtc!==fixture.kickoffUtc))){
        section[field]=null;section.rejection='identity-or-mapping-changed';
      }
    }
  }
  return copy;
}
function redact(error,cfg){
  let value=error?.message||String(error);
  for(const secret of [cfg?.databaseUrl,cfg?.fixtureUrl].filter(Boolean))value=value.split(secret).join('[database connection]');
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi,'[database connection]').slice(0,500);
}
async function exportEvidence(cfg,writePool,input,mappings=loadMappings(cfg,cfg.mappingsFile),policy){
  const interrupted=()=>policy?.interruptionReason()?{exportSkipped:'run-interrupted'}:null;
  let stopped=interrupted();
  if(stopped)return stopped;
  const selection=scope.selectFixtures(input.matches,new Date());
  const validMappings=new Map(scope.buildTasks(selection.selected,mappings,[],new Date()).tasks.map(t=>[t.fixture.siteMatchId,t.providerMatchId]));
  const items=[];
  for(let offset=0;offset<selection.selected.length;offset+=500){
    stopped=interrupted();
    if(stopped)return stopped;
    const fixtures=selection.selected.slice(offset,offset+500);
    let evidences;
    try{evidences=await store.getEvidenceBatch(writePool,fixtures);}catch(error){
      stopped=interrupted();
      if(stopped)return stopped;
      throw error;
    }
    stopped=interrupted();
    if(stopped)return stopped;
    for(let index=0;index<fixtures.length;index++){
      const fixture=fixtures[index],evidence=evidences[index];
      items.push({fixture,evidence:filterEvidence(evidence,fixture,validMappings.get(fixture.siteMatchId))});
    }
  }
  const result={generatedAt:new Date().toISOString(),window:selection.window,source:'leisu',
    fixtureGenerationId:input.generationId,fixtureManifestHash:input.manifestHash,
    predictionEligible:false,items};
  stopped=interrupted();
  if(stopped)return stopped;
  atomicJson(cfg.outputFile,result);
  return {exportedMatches:items.length,outputFile:cfg.outputFile};
}

async function main(argv=process.argv.slice(2),env=process.env){
  const {command,options}=args(argv),cfg=config(env);
  const mappingsPath=path.resolve(options.mappings||cfg.mappingsFile);
  if(command==='doctor'){
    let executablePath=null,browserInstalled=false;
    try{executablePath=require('playwright').chromium.executablePath();browserInstalled=fs.existsSync(executablePath);}catch{}
    const circuitPath=path.join(cfg.stateDir,'circuit.json');
    const circuit=fs.existsSync(circuitPath)?readJson(circuitPath):null;
    const result={command,platform:process.platform,node:process.version,window:scope.windowFor(),
      databaseConfigured:Boolean(cfg.databaseUrl),fixtureDatabaseConfigured:Boolean(cfg.fixtureUrl),
      mappingsExist:fs.existsSync(mappingsPath),browserInstalled,profileExists:fs.existsSync(cfg.profileDir),
      enabled:cfg.enabled,accessValidated:cfg.accessValidated,automaticOddsEnabled:false,
      lockPresent:fs.existsSync(path.join(cfg.stateDir,'collector.lock')),
      circuitPaused:circuit?.paused===true,circuitStatus:circuit?.status||null,circuitSince:circuit?.at||null,
      stateDir:cfg.stateDir,checksAreReadOnly:true};
    console.log(JSON.stringify(result,null,2));return result;
  }
  if(command==='migrate')return withPool(cfg.databaseUrl,'LEISU_DATABASE_URL',async p=>{
    await store.migrate(p);console.log(JSON.stringify({migratedSchema:'leisu_prematch'}));
  });
  if(command==='plan'){
    const input=await feed(cfg,options),mappings=input.offline?readJson(mappingsPath):loadMappings(cfg,mappingsPath);
    const attempts=input.offline||!cfg.databaseUrl?[]:await withPool(cfg.databaseUrl,'LEISU_DATABASE_URL',store.getAttempts);
    const result=buildPlan(input,mappings,attempts,options.now||new Date());
    console.log(JSON.stringify(result,null,2));return result;
  }
  if(command==='collect-once'&&(!cfg.enabled||!cfg.accessValidated))throw new Error('Collection disabled: enable only after site optimization and server access validation');
  const release=lock(cfg);
  const policy=runtime.createRunPolicy(cfg);
  let context,contextClosePromise,fixturePool;
  const readCurrentFeed=async()=>{
    fixturePool ||= store.createPool(requireUrl(cfg.fixtureUrl,'LEISU_FIXTURE_DATABASE_URL'));
    // Reuse the connection pool, never the snapshot: every call opens a fresh
    // read-only transaction through readFixtureFeed.
    return store.readFixtureFeed(fixturePool,cfg.maxAge);
  };
  const closeContext=()=>{
    if(!context)return Promise.resolve();
    contextClosePromise ||= Promise.resolve().then(()=>context.close()).catch(()=>{});
    return contextClosePromise;
  };
  const interrupt=reason=>{policy.cancel(reason);void closeContext();};
  const onTerm=()=>interrupt('SIGTERM'),onInt=()=>interrupt('SIGINT');
  process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
  const budgetTimer=['collect-once','discover','probe','export'].includes(command)
    ? setTimeout(()=>interrupt('time-budget'),policy.remainingMs()) : null;
  budgetTimer?.unref();
  const openContext=async()=>{
    if(policy.stopReason())return false;
    if(!context)context=await browser.openBrowser(cfg.profileDir,cfg.headless);
    // A signal may arrive while Chromium is starting. Never visit a page with
    // the newly returned context if that run has already been cancelled.
    if(policy.interruptionReason()){await closeContext();return false;}
    return true;
  };
  const stoppedStatus=()=>['SIGTERM','SIGINT','cancelled'].includes(policy.stopReason())?'cancelled':'budget-exhausted';
  const circuitFile=path.join(cfg.stateDir,'circuit.json');
  const pauseSource=failure=>atomicJson(circuitFile,{paused:true,status:failure.status,reason:failure.reason||null,
    httpStatus:Number.isInteger(failure.httpStatus)?failure.httpStatus:null,at:new Date().toISOString()});
  try{
    if(command==='resume'){
      // A prior process may leave a lock after SIGKILL; no automated deletion of
      // that lock is attempted. Inspect the recorded PID before manual recovery.
      atomicJson(path.join(cfg.stateDir,'circuit.json'),{paused:false,resumedAt:new Date().toISOString()});
      console.log(JSON.stringify({resumed:true,enabled:cfg.enabled}));return;
    }
    if(command==='login'){
      if(cfg.headless)throw new Error('Login needs the controlled server display and LEISU_HEADLESS=0');
      if(!await openContext())return {status:stoppedStatus(),runtime:policy.snapshot()};
      const page=await context.newPage();await page.goto('https://www.leisu.com/',{waitUntil:'domcontentloaded'});
      console.log('Complete normal login in the controlled server browser, then close its window. No credentials are printed.');
      await new Promise(resolve=>context.once('close',resolve));context=null;return;
    }
    if(['collect-once','discover'].includes(command)&&fs.existsSync(circuitFile)&&readJson(circuitFile).paused){
      const circuit=readJson(circuitFile);
      const result={status:'paused',reason:'source-circuit-paused',circuitStatus:circuit.status||null,circuitSince:circuit.at||null,runtime:policy.snapshot()};
      console.log(JSON.stringify(result));return result;
    }
    const input=await readCurrentFeed();
    if(policy.interruptionReason()&&['collect-once','discover','probe','export'].includes(command)){
      return {status:stoppedStatus(),runtime:policy.snapshot(),exportSkipped:'run-interrupted'};
    }
    let mappings=loadMappings(cfg,mappingsPath);
    if(command==='discover'){
      if(!scope.selectFixtures(input.matches,new Date()).selected.length)return {status:'no-eligible-fixtures',runtime:policy.snapshot()};
      const result=await discoverMappings(cfg,async()=>await openContext()?context:null,input,policy,readCurrentFeed);
      if(!result.completed){
        if(result.failure&&shouldPauseSource(result.failure))pauseSource(result.failure);
        const status=result.failure?'paused':policy.stopReason()?stoppedStatus():'discovery-pending';
        const pending={...result,status,runtime:policy.snapshot()};console.log(JSON.stringify(pending));return pending;
      }
      console.log(JSON.stringify({generatedAt:result.generatedAt,mapped:result.mappings.length,unmatched:result.unmatched,conflicts:result.conflicts},null,2));return result;
    }
    if(command==='export')return await withPool(cfg.databaseUrl,'LEISU_DATABASE_URL',async p=>{
      const exported=await exportEvidence(cfg,p,input,mappings,policy);
      const result={status:policy.interruptionReason()?stoppedStatus():'completed',runtime:policy.snapshot(),...exported};
      console.log(JSON.stringify(result));return result;
    });
    if(command==='probe'){
      const plan=buildPlan(input,mappings,[],new Date());
      const task=plan.tasks.find(t=>t.kind==='injuries'&&(!options['site-match-id']||t.fixture.siteMatchId===options['site-match-id']));
      if(!task)throw new Error('No verified today/tomorrow fixture mapping is available for probe');
      if(!await openContext()||!policy.tryStartPage())return {status:stoppedStatus(),runtime:policy.snapshot()};
      const result=await browser.collectTask(context,task);
      if(policy.interruptionReason())return {status:stoppedStatus(),runtime:policy.snapshot()};
      const record={checkedAt:new Date().toISOString(),platform:process.platform,siteMatchId:task.fixture.siteMatchId,
        providerMatchId:task.providerMatchId,receivedAt:result.receivedAt,httpStatus:result.httpStatus,
        status:result.status,reason:result.reason||null,injuryRows:result.data?.injuries?.length||0,
        freshBrowserProcess:true,productionWritten:false};
      atomicJson(path.join(cfg.stateDir,'probe-'+Date.now()+'.json'),record);
      console.log(JSON.stringify(record,null,2));if(result.status!=='available')process.exitCode=2;return record;
    }
    return await withPool(cfg.databaseUrl,'LEISU_DATABASE_URL',async writePool=>{
      const attempts=await store.getAttempts(writePool),results=[];
      let runId=null,runStatus='completed',discoveryPending=false,discoveryState=null;
      const runTasks=async tasks=>{
        for(const task of tasks){
          if(policy.stopReason()){runStatus=stoppedStatus();return;}
          // Every page uses a new authoritative snapshot, despite pool reuse.
          const fresh=await readCurrentFeed();
          if(policy.interruptionReason()){runStatus=stoppedStatus();return;}
          const livePlan=buildPlan(fresh,mappings,attempts,new Date());
          if(!livePlan.tasks.some(t=>t.taskKey===task.taskKey)){
            results.push({taskKey:task.taskKey,status:'scope-changed'});continue;
          }
          if(!runId)runId=await store.startRun(writePool);
          if(!await openContext()||!policy.tryStartPage()){runStatus=stoppedStatus();return;}
          let result;
          try{result=await browser.collectTask(context,task);}catch(error){
            if(policy.interruptionReason()){runStatus=stoppedStatus();return;}
            throw error;
          }
          if(policy.interruptionReason()){runStatus=stoppedStatus();return;}
          const after=await readCurrentFeed();
          if(policy.interruptionReason()){runStatus=stoppedStatus();return;}
          if(!scope.selectFixtures(after.matches,new Date()).selected.some(f=>f.siteMatchId===task.fixture.siteMatchId&&f.eventVersion===task.fixture.eventVersion&&f.homeName===task.fixture.homeName&&f.awayName===task.fixture.awayName)){
            result={receivedAt:new Date().toISOString(),status:'conflict',data:null,reason:'fixture-changed-during-page-read'};
          }
          const observation={runId,taskKey:task.taskKey,fixture:task.fixture,providerMatchId:task.providerMatchId,
            kind:task.kind,receivedAt:result.receivedAt,sourceUrl:task.sourceUrl,status:result.status,data:result.data};
          try{await store.saveObservation(writePool,observation);}catch(error){
            if(result.status!=='available')throw error;
            result={receivedAt:new Date().toISOString(),status:'parse_error',data:null,reason:'observation-validation-failed'};
            await store.saveObservation(writePool,{...observation,...result});
          }
          results.push({taskKey:task.taskKey,status:result.status,receivedAt:result.receivedAt});
          attempts.push({taskKey:task.taskKey,status:result.status,receivedAt:result.receivedAt});
          if(policy.interruptionReason()){runStatus=stoppedStatus();return;}
          if(shouldPauseSource(result)){
            runStatus='paused';pauseSource(result);return;
          }
        }
      };
      const initialPlan=buildPlan(input,mappings,attempts,new Date());
      try{
        // Existing verified near-kickoff lineups get the first pages. Discovery
        // uses only the remaining budget; injuries follow refreshed mappings.
        await runTasks(initialPlan.tasks.filter(task=>task.kind==='lineup'));
        if(runStatus==='completed'&&!policy.stopReason()){
          const current=await readCurrentFeed();
          const autoFile=path.join(cfg.stateDir,'auto-mappings.json');
          const staleMapping=!fs.existsSync(autoFile)||mappingNeedsRefresh(readJson(autoFile));
          if(cfg.leagueUrls.length&&staleMapping&&scope.selectFixtures(current.matches,new Date()).selected.length&&!policy.stopReason()){
            const discovery=await discoverMappings(cfg,async()=>await openContext()?context:null,current,policy,readCurrentFeed);
            discoveryPending=!discovery.completed;
            discoveryState=discovery.completed?null:discovery;
            if(discovery.completed)mappings=loadMappings(cfg,mappingsPath);
            if(discovery.failure&&shouldPauseSource(discovery.failure)){
              runStatus='paused';pauseSource(discovery.failure);
            }
          }
        }
        // Once interrupted, do not begin another data read or export. The
        // already-running query may finish under its own timeout; finalization
        // below releases the active run and resources without renewing old data.
        if(policy.interruptionReason()){
          runStatus=stoppedStatus();
          const result={runId,status:runStatus,results,deferredTasks:Math.max(0,initialPlan.tasks.length-results.length),
            runtime:policy.snapshot(),exportSkipped:'run-interrupted'};
          console.log(JSON.stringify(result));return result;
        }
        const current=await readCurrentFeed();
        const plan=buildPlan(current,mappings,attempts,new Date());
        if(runStatus==='completed'&&!policy.stopReason())await runTasks(plan.tasks);
        if(policy.interruptionReason()){
          runStatus=stoppedStatus();
          const result={runId,status:runStatus,results,deferredTasks:Math.max(0,initialPlan.tasks.length-results.length),
            runtime:policy.snapshot(),exportSkipped:'run-interrupted'};
          console.log(JSON.stringify(result));return result;
        }
        const finalInput=await readCurrentFeed();
        if(policy.interruptionReason()){
          runStatus=stoppedStatus();
          const result={runId,status:runStatus,results,runtime:policy.snapshot(),exportSkipped:'run-interrupted'};
          console.log(JSON.stringify(result));return result;
        }
        const remaining=buildPlan(finalInput,mappings,attempts,new Date()).tasks.length;
        if(runStatus==='completed'&&policy.stopReason()&&(remaining||discoveryPending))runStatus=stoppedStatus();
        const exported=await exportEvidence(cfg,writePool,finalInput,mappings,policy);
        if(policy.interruptionReason())runStatus=stoppedStatus();
        const status=runStatus==='completed'&&!runId?'no-due-tasks':runStatus;
        const result={runId,status,results,deferredTasks:remaining,discoveryPending,discoveryState,runtime:policy.snapshot(),...exported};
        console.log(JSON.stringify(result,null,2));return result;
      }catch(error){if(runStatus!=='paused')runStatus=policy.interruptionReason()?stoppedStatus():'failed';throw error;}
      finally{if(runId)await store.finishRun(writePool,runId,runStatus);}
    });
  }finally{
    if(budgetTimer)clearTimeout(budgetTimer);
    process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);
    try{await closeContext();}finally{try{if(fixturePool)await fixturePool.end();}finally{release();}}
  }
}
module.exports={args,config,buildPlan,mappingNeedsRefresh,schedulingAttempts,filterEvidence,main};
if(require.main===module)main().then(result=>{if(result?.status==='paused')process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({ok:false,error:redact(error,{databaseUrl:process.env.LEISU_DATABASE_URL,fixtureUrl:process.env.LEISU_FIXTURE_DATABASE_URL})}));process.exitCode=1;});
