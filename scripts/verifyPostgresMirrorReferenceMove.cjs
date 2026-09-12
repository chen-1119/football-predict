"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto"),{Pool}=require("pg");
const {mirrorPostgresCandidate}=require("./postgresReleaseMirror.cjs");
(async()=>{
  const url=new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);assert.equal(url.hostname,"127.0.0.1");assert.match(url.pathname,/^\/q2_evidence_native_[a-f0-9]+$/);
  const source=new Pool({connectionString:url.href,max:1,ssl:false}),name="football_release_"+crypto.randomBytes(6).toString("hex")+"_"+Math.floor(Date.now()/1000);let candidate;
  const schema="CREATE SCHEMA football; CREATE TABLE football.publications(publication_id text PRIMARY KEY,state text NOT NULL); CREATE UNIQUE INDEX one_current ON football.publications(state) WHERE state='current'; CREATE TABLE football.frozen_recommendations(id text PRIMARY KEY,publication_id text NOT NULL REFERENCES football.publications(publication_id),payload json NOT NULL); CREATE TABLE football.prediction_snapshots(id text PRIMARY KEY,payload json); CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text);";
  try{await source.query(schema);await source.query("CREATE DATABASE "+name);const target=new URL(url);target.pathname="/"+name;candidate=new Pool({connectionString:target.href,max:1,ssl:false});await candidate.query(schema);
    await source.query("INSERT INTO football.publications VALUES('original','current'); INSERT INTO football.frozen_recommendations VALUES('frozen-198','original','{ \"tip\": \"draw\" }');");
    const key=crypto.randomBytes(32);const run=async()=>{const client=await source.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");return await mirrorPostgresCandidate({sourceSession:{client,pool:source,identity:{generationId:'fixture'}},candidatePool:candidate,key,expectedSourceDatabase:url.pathname.slice(1)});}finally{await client.query('ROLLBACK');client.release();}};
    await run();await candidate.query("INSERT INTO football.publications VALUES('candidate-only','previous'); UPDATE football.frozen_recommendations SET publication_id='candidate-only';");const repaired=await run();
    assert.equal(repaired.ok,true);assert.equal(repaired.removedCandidateRows,1);assert.equal(repaired.copiedRows,1);
    const read=p=>p.query("SELECT id,publication_id,payload::text FROM football.frozen_recommendations").then(r=>r.rows);
    assert.deepEqual(await read(candidate),await read(source));assert.equal((await candidate.query("SELECT count(*)::int n FROM football.publications WHERE publication_id='candidate-only'")).rows[0].n,0);
    console.log(JSON.stringify({ok:true,verifier:'mirror-retained-child-reference-move',copiedRows:1,removedCandidateParents:1,frozenPayloadUnchanged:true,productionWrites:0}));
  }finally{if(candidate){await candidate.end();await source.query('DROP DATABASE '+name);}await source.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
