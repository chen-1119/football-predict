'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {VERSION,query,inspect}=require('../scripts/readPrematchModelRegistryStatus.cjs');
const now='2026-10-08T14:30:00.000Z';
const value=()=>({version:VERSION,database:'football',readOnly:'on',productionWrites:0,observedAt:now,artifacts:[]});
test('missing models are reported without claiming adoption or fixture identity',()=>{const r=inspect(value(),now,now);assert.equal(r.registryArtifacts,0);assert.equal(r.keys.length,2);assert.equal(r.recommendationAdoptionConfirmed,false);assert.equal(r.fixtureIdentityVerified,false);});
test('query is bounded to the two model keys and read-only transaction',()=>{const sql=query();assert.match(sql,/REPEATABLE READ READ ONLY/);assert.match(sql,/ROLLBACK/);assert.doesNotMatch(sql,/INSERT|UPDATE |DELETE|DROP|CREATE |match_snapshots/);assert.match(sql,/artifact_key IN \('prematch-v3-baseline','prematch-v3-parameters'\)/);});
test('wrong database, writable transaction, stale clock, duplicate or extra keys fail',()=>{
  for(const patch of [{database:'other'},{readOnly:'off'},{productionWrites:1},{observedAt:'2026-01-01T00:00:00Z'},{artifacts:[{key:'secret'}]},{artifacts:[{key:'prematch-v3-baseline'},{key:'prematch-v3-baseline'}]}])assert.throws(()=>inspect({...value(),...patch},now,now));
});
test('invalid payload commitment fails',()=>assert.throws(()=>inspect({...value(),artifacts:[{key:'prematch-v3-baseline',payloadJson:'{}',bytes:2,sha256:'a'.repeat(64)}]},now,now),/PAYLOAD/));
test('non-V3 research report does not become loadable by storing it',()=>{
  const payloadJson=JSON.stringify({version:'league-elo-poisson-experiment-v1'});
  const row={key:'prematch-v3-baseline',version:'league-elo-poisson-experiment-v1',payloadJson,bytes:Buffer.byteLength(payloadJson),sha256:crypto.createHash('sha256').update(payloadJson).digest('hex')};
  const r=inspect({...value(),artifacts:[row]},now,now);assert.equal(r.registryArtifacts,1);assert.equal(r.loadableArtifacts,0);assert.equal(r.keys[0].loadable,false);
});
