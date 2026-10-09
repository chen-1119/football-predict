'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const {validate}=require('../scripts/runReleaseCapacityPreflight.cjs'),{planCapacity}=require('../scripts/nativeReleaseCapacity.cjs');
function report(available=100e9){const observation={observedAt:new Date().toISOString(),databaseBytes:8e9,generationBytes:1e9,applicationBytes:2e9,volumes:Object.fromEntries(['postgres','native','application'].map(k=>[k,{device:'1',availableBytes:available}]))};return {version:'release-capacity-preflight-v1',sourceHash:'a'.repeat(64),observation,capacity:planCapacity(observation),ok:planCapacity(observation).ok,productionWrites:0,spaceReserved:false,readyToCutover:false};}
test('fresh capacity observation passes without reservation',()=>a.equal(validate(report(),'a'.repeat(64)).ok,true));
test('insufficient capacity is preserved as rejection',()=>a.equal(validate(report(1),'a'.repeat(64)).ok,false));
for(const[k,change]of Object.entries({stale:r=>r.observation.observedAt='2020-01-01T00:00:00Z',future:r=>r.observation.observedAt=new Date(Date.now()+60000).toISOString(),source:r=>r.sourceHash='b'.repeat(64),budget:r=>r.capacity.checks[0].requiredBytes--,ok:r=>r.ok=false,writes:r=>r.productionWrites=1,lease:r=>r.spaceReserved=true,cutover:r=>r.readyToCutover=true}))test('reject '+k,()=>{const r=report();change(r);a.throws(()=>validate(r,'a'.repeat(64)));});
