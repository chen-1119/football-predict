"use strict";
// Actual readiness entrypoint against a loopback-only synthetic API. A bad
// payload must fail before any verifier child is started.
const assert = require("node:assert/strict"), http = require("node:http"), path = require("node:path");
const { spawn } = require("node:child_process");
const calls = []; let child;
const server = http.createServer(async (req,res) => {
  let raw=""; for await (const chunk of req) raw+=chunk;
  const body=raw?JSON.parse(raw):null; calls.push({method:req.method,url:req.url,body});
  let response;
  if(req.url==="/api/admin/access-codes") {assert.equal(body.ttlSeconds,900);response={id:"synthetic-id",code:"synthetic-code"};}
  else if(req.url==="/api/access/verify") response={session:{token:"synthetic-token"}};
  else if(req.url==="/api/admin/access-codes/synthetic-id/revoke") response={ok:true,row:{status:"revoked"}};
  else if(req.url==="/api/v1/matches/current?view=list") response={rows:[{id:"synthetic-event",testOnlyPadding:"x".repeat(21000)}]};
  else { res.statusCode=404;response={ok:false,error:"unexpected-test-request"}; }
  res.setHeader("content-type","application/json"); res.end(JSON.stringify(response));
});
(async()=>{
  const started=Date.now(); await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const env={...process.env};
    for(const key of Object.keys(env))if(/^(VERIFY_|NODE_OPTIONS$|NODE_PATH$|ADMIN_TOKEN$|ACCESS_CODE_ADMIN_TOKEN$|FOOTBALL_POSTGRES_|DATABASE_URL$)/i.test(key))delete env[key];
    Object.assign(env,{VERIFY_BASE_URL:`http://127.0.0.1:${server.address().port}`,VERIFY_START_SERVER:"0",ADMIN_TOKEN:"synthetic-admin"});
    const result=await new Promise((resolve,reject)=>{
      child=spawn(process.execPath,["scripts/verifyProductionReadiness.cjs"],{cwd:path.resolve(__dirname,".."),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let stdout="",stderr=""; const timer=setTimeout(()=>{child.kill();reject(new Error("early rejection exceeded 10-second test budget"));},10000);
      child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
      child.on("error",error=>{clearTimeout(timer);reject(error);});
      child.on("close",status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
    });
    assert.equal(result.status,1,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.failFast,true);assert.ok(report.summary.failed.includes("early current list compact payload"));
    assert.doesNotMatch(result.stderr,/\[production-readiness\] child-start/);
    assert.equal(calls.filter(c=>c.url.endsWith("/revoke")).length,1);
    assert.equal(calls.length,4);assert.ok(!result.stdout.includes("synthetic-token")&&!result.stdout.includes("synthetic-code"));
    console.log(JSON.stringify({ok:true,elapsedMs:Date.now()-started,actualReadinessEntrypoints:1,expensiveChildrenStarted:0,
      temporaryCredentialsCreated:1,temporaryCredentialsRevoked:1,productionWrites:0}));
  } finally {child?.kill();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
