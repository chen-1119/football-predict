'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertResultArchivesReady, assertCodeCutoverArchivesReady, assertCodeArchiveCoverageClock, retryLeaseRead } = require('../scripts/nativeCodeReleaseDataPlane.cjs');
const { isResultPhase } = require('../server/recommendationProjectionParity.cjs');
const at = Date.parse('2026-10-10T13:18:07.000Z');
const match = (id = '2041870', kickoff = '2026-10-10T21:30:00+08:00') => ({
  id: 'sporttery_' + id, sourceMatchId: id, status: 'SCHEDULED', kickoffTime: kickoff,
  eventVersion: kickoff, buyEndTime: kickoff,
  predictions: [{ marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1', odds: 2 }],
});
const archived = row => ({ ...row, archivedPreMatchPrediction: {
  version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
  sourceMatchId: row.sourceMatchId, eventVersion: row.eventVersion, kickoffTime: row.kickoffTime,
  cutoffTime: row.buyEndTime, capturedAt: '2026-10-10T03:05:39.516Z',
  prediction: { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1', odds: 2 },
} });
const pending = count => error => error.code === 'NATIVE_RESULT_ARCHIVE_PENDING' && error.pendingRows === count;

test('r838 timing regression rejects all five missing archives before the producer is paused', () => {
  const rows = ['2041870','2041871','2041872','2041873','2041874'].map(id => match(id));
  const original = JSON.stringify(rows);
  a.equal(assertResultArchivesReady(rows, at).pendingRows, 0);
  a(rows.every(row => !isResultPhase(row, at)));
  a(rows.every(row => isResultPhase(row, Date.parse('2026-10-10T13:30:37.626Z'))));
  a.throws(() => assertCodeCutoverArchivesReady(rows, at), pending(5));
  a.equal(JSON.stringify(rows), original);
});
test('valid immutable archives allow a real kickoff crossing without any schedule window', () => {
  const rows = [archived(match()), archived(match('2041871'))], original = JSON.stringify(rows);
  const proof = assertCodeCutoverArchivesReady(rows, at);
  a.equal(proof.pendingRows, 0); a.equal(proof.checkedRows, 2);
  a.equal(proof.checkedAt, '2026-10-10T13:18:07.000Z');
  a.equal(proof.requiredThrough, '2026-10-10T13:33:07.000Z');
  a.equal(proof.leaseSeconds, 900);
  a.equal(JSON.stringify(rows), original);
});
test('the inclusive end boundary covers final readiness, while later events stay pre-match', () => {
  const end = at + 900_000;
  for (const delta of [-300001, -300000, -1, 0]) {
    a.throws(() => assertCodeCutoverArchivesReady([match('1', new Date(end + delta).toISOString())], at), pending(1));
  }
  a.equal(assertCodeCutoverArchivesReady([match('1', new Date(end + 1).toISOString())], at).pendingRows, 0);
});
test('cutoff alone is not treated as a result-phase transition', () => {
  const row = match('1', new Date(at + 900_001).toISOString()); row.buyEndTime = new Date(at - 1).toISOString();
  a.equal(assertCodeCutoverArchivesReady([row], at).pendingRows, 0);
});
test('status and sourceStatus retain the exact public parity result-phase semantics', () => {
  const future = new Date(at + 86_400_000).toISOString();
  for (const status of ['PENDING_RESULT', 'FINISHED']) {
    a.throws(() => assertCodeCutoverArchivesReady([{ ...match('1', future), status }], at), pending(1));
    a.throws(() => assertCodeCutoverArchivesReady([{ ...match('1', future), sourceStatus: status }], at), pending(1));
  }
  const live = { ...match('1', future), status: 'LIVE' };
  a.equal(isResultPhase(live, at + 900_000), false);
  a.equal(assertCodeCutoverArchivesReady([live], at).pendingRows, 0);
});
test('directionless rows are never assigned a fabricated archive', () => {
  const row = { ...match(), predictions: [{ marketType:'BEST', tipCode:'WATCH', recommendationAction:'withhold' }] };
  a.equal(assertCodeCutoverArchivesReady([row], at).pendingRows, 0);
  a.equal(row.archivedPreMatchPrediction, undefined);
});
test('pre-existing corrupt archives remain permanent errors before service pause', async () => {
  for (const change of [{ sourceMatchId:'wrong' }, { eventVersion:'2026-10-11T13:30:00Z' }, { capturedAt:'2026-10-10T13:30:00Z' }]) {
    const row = archived(match()); Object.assign(row.archivedPreMatchPrediction, change); let calls = 0;
    await a.rejects(retryLeaseRead(async () => { calls++; return assertCodeCutoverArchivesReady([row], at); },
      async () => a.fail('invalid archive must not retry')), /existing archive invalid/);
    a.equal(calls, 1);
  }
});
test('valid independent HHAD archives retain the exact existing archive authority', () => {
  const row = archived(match()); row.predictions[0].oddsPoolCode = 'HHAD'; row.predictions[0].handicapLine = -1;
  row.archivedPreMatchPrediction.prediction = { ...row.predictions[0], handicapLine:-1 };
  a.equal(assertCodeCutoverArchivesReady([row], at).pendingRows, 0);
  a.deepEqual(assertCodeCutoverArchivesReady([row], at).pendingRows,
    assertResultArchivesReady([row], at + 900_000).pendingRows);
});
test('the existing bounded retry closes each read session and waits only for natural data', async () => {
  let active = false, calls = 0, elapsed = 0;
  const proof = await retryLeaseRead(async () => {
    a.equal(active, false); active = true;
    try { return assertCodeCutoverArchivesReady([++calls === 1 ? match() : archived(match())], at + elapsed); }
    finally { active = false; }
  }, async ms => { a.equal(active, false); elapsed += ms; }, () => elapsed);
  a.equal(calls, 2); a.equal(elapsed, 10000); a.equal(proof.pendingRows, 0);
});
test('persistent missing archives still stop after 600 seconds and never extend the lease budget', async () => {
  let elapsed = 0, calls = 0;
  await a.rejects(retryLeaseRead(async () => { calls++; return assertCodeCutoverArchivesReady([match()], at + elapsed); },
    async ms => { elapsed += ms; }, () => elapsed), e => e.code === 'NATIVE_LEASE_PREPARATION_TIMEOUT');
  a.equal(elapsed, 600000); a.equal(calls, 60);
});
test('bounds and invalid clocks remain fail-closed', () => {
  for (const clock of [NaN, Infinity, at + 0.5, Number.MAX_SAFE_INTEGER])
    a.throws(() => assertCodeCutoverArchivesReady([], clock), /clock invalid|horizon invalid/);
  a.throws(() => assertCodeCutoverArchivesReady(Array(513).fill(match()), at), /row bound/);
  a.throws(() => assertCodeCutoverArchivesReady([null], at), /row invalid/);
});
test('same-session horizon proof is obtained before durable lease capture and service pause', () => {
  const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'scripts/nativeCodeReleaseDataPlane.cjs'), 'utf8');
  const once = source.slice(source.indexOf('async function captureLeaseInputOnce'), source.indexOf('async function seed'));
  const queryAt = once.indexOf("SELECT payload FROM football.match_snapshots WHERE dataset='current'");
  const checkAt = once.indexOf('readCodeCutoverArchiveAuthority(session.client, archiveRows.rows.map(row => row.payload), Date.now())');
  a(queryAt > 0 && checkAt > queryAt && checkAt < once.indexOf("'code-lease-current.json'"));
  const shell = fs.readFileSync(path.join(root, 'deploy/light-server/release-native.sh'), 'utf8');
  const captureAt = shell.indexOf('lease-input "$BUNDLE_SHA256"');
  const pauseAt = shell.indexOf('stop_worker_for_release_window', captureAt);
  a(captureAt > 0 && pauseAt > captureAt);
  a(shell.includes('--verifier-runtime-max-seconds 300 --preverify-refresh-budget-seconds 570 --atomic-swap-margin-seconds 30'));
});
test('the actual archive observation horizon cannot be extended by later lease issuance', () => {
  const proof = assertCodeCutoverArchivesReady([archived(match())], at);
  assertCodeArchiveCoverageClock(proof, at); assertCodeArchiveCoverageClock(proof, at + 899999);
  for (const now of [at - 1, at + 900000, at + 900001])
    a.throws(() => assertCodeArchiveCoverageClock(proof, now), /clock expired/);
  for (const changed of [{ leaseSeconds:901 }, { pendingRows:1 }, { requiredThrough:new Date(at+900001).toISOString() }])
    a.throws(() => assertCodeArchiveCoverageClock({ ...proof, ...changed }, at), /proof invalid/);
});
test('final clock verification uses the preserved input instead of a new production generation', () => {
  const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'scripts/nativeCodeReleaseDataPlane.cjs'), 'utf8');
  const final = source.slice(source.indexOf('function verifyCodeCutoverCompletionClock'), source.indexOf('async function captureLeaseInput'));
  a(final.includes("'code-lease-current.json'")); a(final.includes("'code-transition-lease.json'"));
  a(final.includes('input.currentHash')); a(final.includes('state.emergencyActivationAuthorizationHash'));
  a(final.includes('transitions.verifyTransitionLease(current, lease'));
  a(!/pool\(|\.query\(|public\/data/.test(final));
  const shell = fs.readFileSync(path.join(root, 'deploy/light-server/release-native.sh'), 'utf8');
  const finalGate = shell.indexOf('complete-clock "$BUNDLE_SHA256"');
  a(finalGate > shell.lastIndexOf('scripts/verifyRemotePublicReadiness.cjs'));
  a(finalGate < shell.indexOf('scripts/codeReleaseAcceptance.cjs" write'));
  // Invoke the actual completion helper with only filesystem/privileged
  // transport boundaries replaced. Valid current snapshots may exceed the
  // native journal reader's independent 1MiB limit.
  const vm = require('node:vm'), createRequire = require('node:module').createRequire;
  const realRequire = createRequire(path.join(root, 'scripts/nativeCodeReleaseDataPlane.cjs'));
  const transition = realRequire('./releaseTransitionLease.cjs');
  const authorization = {version:'emergency-code-activation-v1',mode:'code-only-ignore-schedule',reason:'user-requested-immediate-ui-repair',
    authorizedAt:'2026-10-10T12:58:00.000Z',expiresAt:'2026-10-10T14:58:00.000Z'};
  const approved = transition.validateEmergencyCodeAuthorization(authorization, {at:new Date(at).toISOString()});
  const clock = {bootId:'12345678-1234-1234-1234-123456789abc',uptimeSeconds:1000};
  const data = [{...match(), padding:'x'.repeat(1024 * 1024)}];
  const lease = transition.createTransitionLease(data, {refreshAt:new Date(at).toISOString(), verifierRuntimeMaxSeconds:300,
    preverifyRefreshBudgetSeconds:570, atomicSwapMarginSeconds:30, emergencyAuthorization:authorization,
    dataPlane:'code-only',clockProof:clock});
  const state = {sha:'a'.repeat(64),dataPlane:'code-only',emergencyActivationAuthorizationHash:approved.authorizationHash};
  const directory = '/fixture/root-owned-native';
  const input = {sha:state.sha,currentHash:realRequire('node:crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    archiveReadiness:assertCodeCutoverArchivesReady([archived(match())],at)};
  const bytes = Buffer.from(JSON.stringify(data)+'\n');
  let mode='valid', closed=0;
  const stat = () => ({ino:1,dev:1,uid:0,mode:0o600,nlink:1,size:mode==='oversize'?32*1024*1024+2:bytes.length,
    mtimeMs:1,ctimeMs:1,isFile:()=>true,isSymbolicLink:()=>mode==='symlink'});
  const fixtureFs = {...fs,lstatSync:file=>{a.equal(file,path.join(directory,'code-lease-current.json'));return stat();},
    openSync:(file,flags)=>{a.equal(file,path.join(directory,'code-lease-current.json'));a.equal(flags,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);return 55;},
    fstatSync:fd=>{a.equal(fd,55);return stat();},readFileSync:fd=>{a.equal(fd,55);return mode==='tamper'?Buffer.from(bytes.toString().replace('2041870','2041879')):bytes;},
    closeSync:fd=>{a.equal(fd,55);closed++;}};
  const native = {secureDirectory:d=>a.equal(d,directory),read:file=>{
    if(file===path.join(directory,'code-lease-input.json'))return input;
    if(file===path.join(directory,'code-transition-lease.json'))return lease;
    a.fail('must not use small journal reader for current or read a live generation');}};
  const exports = {exports:{}};
  const fixtureRequire = name => name==='node:fs'?fixtureFs:name==='./nativeReleaseDataPlane.cjs'?native
    :name==='./releaseTransitionLease.cjs'?{...transition,readEmergencyCodeAuthorization:()=>approved,
      verifyTransitionLease:(payload,value,options)=>transition.verifyTransitionLease(payload,value,{...options,clockProof:{...clock,uptimeSeconds:1120}})}
    :realRequire(name);
  const FrozenDate = class extends Date {constructor(...args){super(...(args.length?args:[at+120000]));}};
  vm.runInNewContext(source,{require:fixtureRequire,module:exports,__dirname:path.join(root,'scripts'),Buffer,Date:FrozenDate,console});
  a.equal(exports.exports.verifyCodeCutoverCompletionClock(state,directory).ok,true); a.equal(closed,1);
  for(const rejected of ['oversize','symlink','tamper']) {
    mode=rejected;a.throws(()=>exports.exports.verifyCodeCutoverCompletionClock(state,directory));
  }
  a.equal(closed,2);
});
test('preserved-input final verification still enforces original wall and monotonic expiry', () => {
  const transitions = require('../scripts/releaseTransitionLease.cjs');
  const authorization = {version:'emergency-code-activation-v1',mode:'code-only-ignore-schedule',reason:'user-requested-immediate-ui-repair',
    authorizedAt:'2026-10-10T12:58:00.000Z',expiresAt:'2026-10-10T14:58:00.000Z'};
  const clock = {bootId:'12345678-1234-1234-1234-123456789abc',uptimeSeconds:1000};
  const rows=[match()], lease=transitions.createTransitionLease(rows,{refreshAt:new Date(at).toISOString(),
    verifierRuntimeMaxSeconds:300,preverifyRefreshBudgetSeconds:570,atomicSwapMarginSeconds:30,
    emergencyAuthorization:authorization,dataPlane:'code-only',clockProof:clock});
  const verify=(wall,elapsed)=>transitions.verifyTransitionLease(rows,lease,{verifiedAt:new Date(at+wall*1000).toISOString(),
    requiredMarginSeconds:30,emergencyAuthorization:authorization,dataPlane:'code-only',clockProof:{...clock,uptimeSeconds:1000+elapsed}});
  a.equal(verify(869,869).ok,true);
  a.throws(()=>verify(900,10),/lifetime/); a.throws(()=>verify(10,900),/lifetime/);
  a.throws(()=>verify(-1,10),/verification time/); a.throws(()=>verify(10,-1),/monotonic/);
});
