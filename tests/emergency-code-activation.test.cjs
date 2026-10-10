'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTransitionLease, verifyTransitionLease, validateEmergencyCodeAuthorization,
  readEmergencyCodeAuthorization } = require('../scripts/releaseTransitionLease.cjs');
const AT = '2026-10-10T13:00:00.000Z', BOOT = '12345678-1234-1234-1234-123456789abc';
const authorization = () => ({ version:'emergency-code-activation-v1', mode:'code-only-ignore-schedule',
  reason:'user-requested-immediate-ui-repair', authorizedAt:'2026-10-10T12:58:00.000Z', expiresAt:'2026-10-10T14:58:00.000Z' });
const rows = () => [{ id:'sporttery_123', sourceMatchId:'123', status:'SCHEDULED', kickoffTime:'2026-10-10T13:01:00.000Z',
  buyEndTime:'2026-10-10T13:01:00.000Z', predictionMeta:{cutoffTime:'2026-10-10T13:01:00.000Z'} }];
const options = () => ({ refreshAt:AT, verifierRuntimeMaxSeconds:300, preverifyRefreshBudgetSeconds:570,
  atomicSwapMarginSeconds:30, dataPlane:'code-only', emergencyAuthorization:authorization(), clockProof:{bootId:BOOT,uptimeSeconds:1000} });
const later = seconds => new Date(Date.parse(AT)+seconds*1000).toISOString();
const verify = (data, lease, seconds=120, extra={}) => verifyTransitionLease(data,lease,{verifiedAt:later(seconds),
  dataPlane:'code-only', emergencyAuthorization:authorization(), clockProof:{bootId:BOOT,uptimeSeconds:1000+seconds}, ...extra});

test('normal release still rejects the closed schedule window',()=>{
  const opts=options();delete opts.emergencyAuthorization;
  assert.throws(()=>createTransitionLease(rows(),opts),/horizon is too short/);
});
test('explicit code-only authorization permits schedule crossing without changing original rows',()=>{
  const data=rows(), original=JSON.stringify(data),lease=createTransitionLease(data,options());
  assert.equal(lease.minimumHorizonSeconds,900);assert.equal(lease.emergency.lifetimeSeconds,900);
  const proof=verify(data,lease);assert.equal(proof.scheduleWindowIgnored,true);assert.equal(proof.emergencyRemainingSeconds,780);
  assert.equal(JSON.stringify(data),original);
});
test('database or unknown data planes cannot use emergency authorization',()=>{
  for(const dataPlane of ['database','runtime-only',null,'unknown'])
    assert.throws(()=>createTransitionLease(rows(),{...options(),dataPlane}),/database release/);
});
test('authorization shape, purpose and two-hour validity are fixed',()=>{
  for(const change of [{extra:true},{reason:'anything'},{mode:'database'},
    {expiresAt:'2026-10-11T14:58:00.000Z'},{authorizedAt:'2026-10-10T13:01:00.000Z'},
    {expiresAt:'2026-10-10T12:59:00.000Z'}])
    assert.throws(()=>validateEmergencyCodeAuthorization({...authorization(),...change},{at:AT}));
  assert.equal(validateEmergencyCodeAuthorization(authorization(),{at:AT}).authorizationHash.length,64);
});
test('all 900 seconds must fit inside signed authorization and cannot be shortened',()=>{
  assert.throws(()=>createTransitionLease(rows(),{...options(),preverifyRefreshBudgetSeconds:1}),/complete 900/);
  assert.throws(()=>createTransitionLease(rows(),{...options(),emergencyAuthorization:{...authorization(),expiresAt:later(899)}}),/complete 900/);
});
test('verification requires the same signed authorization, never a lease flag alone',()=>{
  const lease=createTransitionLease(rows(),options());
  assert.throws(()=>verify(rows(),lease,120,{emergencyAuthorization:null}),/same signed/);
  assert.throws(()=>verify(rows(),lease,120,{emergencyAuthorization:{...authorization(),authorizedAt:'2026-10-10T12:59:00.000Z'}}),/authorization changed/);
  assert.throws(()=>verify(rows(),{...lease,emergency:null}),/same signed/);
});
test('wall-clock lifetime and requested rollback margin remain mandatory',()=>{
  const lease=createTransitionLease(rows(),options());
  assert.throws(()=>verify(rows(),lease,901,{clockProof:{bootId:BOOT,uptimeSeconds:1010}}),/lifetime/);
  assert.throws(()=>verify(rows(),lease,610,{requiredMarginSeconds:300}),/lifetime/);
  assert.equal(verify(rows(),lease,590,{requiredMarginSeconds:300}).emergencyRemainingSeconds,310);
});
test('monotonic lifetime cannot be extended by moving wall clock backwards',()=>{
  const lease=createTransitionLease(rows(),options());
  assert.throws(()=>verify(rows(),lease,10,{clockProof:{bootId:BOOT,uptimeSeconds:1901}}),/lifetime/);
  assert.throws(()=>verify(rows(),lease,10,{clockProof:{bootId:BOOT,uptimeSeconds:999}}),/monotonic/);
  assert.throws(()=>verify(rows(),lease,10,{clockProof:{bootId:'22345678-1234-1234-1234-123456789abc',uptimeSeconds:1010}}),/monotonic/);
  assert.throws(()=>verify(rows(),lease,-1),/verification time/);
});
test('schedule changes and identity changes still fail digest checks',()=>{
  const lease=createTransitionLease(rows(),options());
  for(const patch of [{sourceMatchId:'456'}, {kickoffTime:'2026-10-10T13:02:00.000Z'}])
    assert.throws(()=>verify([{...rows()[0],...patch}],lease));
});
test('malformed clocks and duplicate identity are not masked by authorization',()=>{
  assert.throws(()=>createTransitionLease([{...rows()[0],kickoffTime:'unknown'}],options()));
  assert.throws(()=>createTransitionLease([rows()[0],{...rows()[0],kickoffTime:'2026-10-10T13:03:00.000Z'}],options()));
});
test('bounded authorization file reader binds the exact file and rejects large or foreign paths',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'emergency-auth-test-'));
  const file=path.join(dir,'code-release-activation-authorization.json');
  try {
    fs.writeFileSync(file,JSON.stringify(authorization()));
    assert.deepEqual(readEmergencyCodeAuthorization(file,{at:AT}),validateEmergencyCodeAuthorization(authorization(),{at:AT}));
    assert.throws(()=>readEmergencyCodeAuthorization(file,{at:AT,dataPlane:'database'}),/database release/);
    assert.throws(()=>readEmergencyCodeAuthorization(path.join(dir,'other.json'),{at:AT}),/unexpected/);
    fs.writeFileSync(file,' '.repeat(4097));assert.throws(()=>readEmergencyCodeAuthorization(file,{at:AT}),/bounded/);
  } finally { fs.rmSync(dir,{recursive:true}); }
});
test('post-swap urgent branch retains lease verification and normal branch retains schedule verification',()=>{
  const shell=fs.readFileSync(path.join(__dirname,'../deploy/light-server/release-native.sh'),'utf8');
  assert.match(shell,/if \[ "\$CODE_EMERGENCY_ACTIVE" = 1 \]; then\s+native_code_verify_cutover_lease 30 "\$APP_DIR"\s+else\s+verify_post_swap_transition_window 30 code-service-handover/);
  assert.match(shell,/emergency authorization refuses database migration/);
  assert.match(shell,/native_data final/);assert.match(shell,/native_data drop-candidate-access/);
});
