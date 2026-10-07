'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VERSION, MAX_BYTES, MAX_MODEL_ARTIFACT_BYTES, MAX_MATCHES, MAX_INVENTORY, CLOCK_SKEW_MS, validDate, parseArgs, query,
  validateResponse, validateTransport, verifyOnlineRead, readInputs } = require('../scripts/readPrematchV3OnlineInputs.cjs');
const { fingerprintSshKeyBlob } = require('../scripts/releaseSshHostKeyPin.cjs');
const attestation=require('../src/services/collectorAttestation.cjs');
const {derivedTeamId}=require('../scripts/storedResultTeamIdentity.cjs');
const identity=require('../src/services/prematchV3InputIdentity.cjs');
const online=require('../src/services/prematchV3OnlineResponse.cjs');
const assessment=require('../src/services/prematchV3Assessment.cjs');
const pair=attestation.createCollectorKeyPair({keyId:'synthetic-identity-only',independenceDomain:'synthetic-current-identity'});
const date = '2026-10-06';
const digest = raw => crypto.createHash('sha256').update(raw).digest('hex');
const payload = (changes = {}) => ({ version: VERSION, readOnly: 'on', productionWrites: 0,
  businessDate: date, observedAt: '2026-10-06T12:00:00Z', generation: { data_generation_id: 'synthetic-generation', manifest_hash: 'a'.repeat(64),
    committed_at: '2026-10-06T11:00:00Z' }, matches: [{ id: 'sporttery_123', sourceMatchId: '123', businessDate: date,
    kickoffTime: '2026-10-06T14:00:00+00:00', eventVersion: '2026-10-06T14:00:00Z' }],
  modelArtifactInventory: [{ key: 'prematch-v3-synthetic', version: 'synthetic-v1', generatedAt: '2026-10-06T11:00:00Z', sha256: 'b'.repeat(64), bytes: 17 }], modelArtifacts: [], ...changes });
function transport(raw, changes = {}) {
  return { hostKeyPinVerified: true, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`,
    startedAt: '2026-10-06T11:59:59Z', finishedAt: '2026-10-06T12:00:01Z',
    remoteResponseSha256: digest(raw), remoteResponseFile: 'synthetic.json.remote-response.json', bytes: raw.length, ...changes };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prematch-v3-reader-test-'));
  t.after(() => { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
  const blob = Buffer.from('synthetic-ed25519-host-key-for-reader-boundaries-only').toString('base64');
  const knownHosts = path.join(directory, 'synthetic.known_hosts'); fs.writeFileSync(knownHosts, `synthetic.invalid ssh-ed25519 ${blob}\n`);
  const registryPath=path.join(directory,'synthetic-public-trust.json');fs.writeFileSync(registryPath,JSON.stringify(pair.registry));
  const liveDate=new Date(Date.now()+32*3600000).toISOString().slice(0,10);
  return { directory,liveDate, output: path.join(directory, 'synthetic.json'), env: { SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH:registryPath,
    RELEASE_DEPLOY_HOST: 'synthetic.invalid', RELEASE_DEPLOY_USER: 'synthetic_user',
    RELEASE_DEPLOY_KEY: path.join(directory, 'synthetic-not-a-real-private-key'), RELEASE_DEPLOY_KNOWN_HOSTS: knownHosts,
    RELEASE_DEPLOY_HOST_KEY_SHA256: fingerprintSshKeyBlob(blob) } };
}

test('CLI and SQL share exact calendar validation; malformed dates cannot reach SQL', () => {
  assert.equal(validDate('2024-02-29'), true);
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '2026-1-6', `${date}' OR true --`, null, false]) {
    assert.equal(validDate(invalid), false); assert.throws(() => query(invalid), /V3_READER_DATE/);
    assert.throws(() => parseArgs(['--date', invalid, '--output', 'synthetic.json']), /V3_READER_ARGS/);
  }
  assert.deepEqual(parseArgs(['--output', 'synthetic.json', '--date', date]), { date, output: 'synthetic.json' });
  for (const args of [[], ['--date', date], ['--date', date, '--date', date], ['--date', date, '--output', '--date'],
    ['--date', date, '--output', 'synthetic\n.json'], ['--date', date, '--output', 'synthetic.json', '--extra', 'x']]) {
    assert.throws(() => parseArgs(args), /V3_READER_ARGS/);
  }
});
test('query is bounded READ ONLY with rollback, two fixed raw model packets and no SQL writes', () => {
  const sql = query(date);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /SET LOCAL statement_timeout='15000'/); assert.match(sql, /SET LOCAL lock_timeout='2000'/);
  assert.match(sql, /LIMIT 129/); assert.match(sql, /LIMIT 25/); assert.match(sql, /ROLLBACK;\n$/);
  assert.match(sql, /payload->>'businessDate'='2026-10-06'/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COPY|CREATE|ALTER|DROP|COMMIT|CALL|DO)\b/i);
  const artifactSelect = sql.slice(sql.indexOf("'modelArtifactInventory'"), sql.indexOf("'modelArtifacts'"));
  assert.doesNotMatch(artifactSelect, /SELECT\s+payload(?:\s|,)/i);
  assert.match(sql, /WHERE artifact_key IN \('prematch-v3-baseline','prematch-v3-parameters'\) ORDER BY artifact_key LIMIT 3/);
  assert.match(sql, /'payloadJson',CASE WHEN payload_bytes<=4194304 AND octet_length\(payload::text\)<=4194304/);
  assert.match(sql, /THEN payload::text ELSE NULL END/);
  assert.doesNotMatch(sql, /'payload',\s*payload/);
});

test('fixed model packet text has exact hashes/bytes; duplicates, foreign keys and oversize content are rejected', () => {
  const json = '{"synthetic":"raw-model-packet-only"}';
  const packet = { artifactKey: 'prematch-v3-baseline', artifactVersion: 'synthetic-v1', generatedAt: '2026-10-06T11:00:00.000001Z',
    updatedAt: '2026-10-06T11:01:00.000002Z', payloadSha256: digest(json), payloadBytes: Buffer.byteLength(json), payloadJson: json, oversized: false };
  assert.equal(validateResponse(payload({ modelArtifacts: [packet] }), date).modelArtifacts, 1);
  for (const changes of [{ payloadSha256: '0'.repeat(64) }, { payloadBytes: 1 }, { payloadBytes: '1' }, { payloadJson: {} },
    { artifactKey: 'legacy-market-lambda' }, { updatedAt: '2026-10-06T10:00:00Z' }, { oversized: true }, { payloadJson: null }]) {
    assert.throws(() => validateResponse(payload({ modelArtifacts: [{ ...packet, ...changes }] }), date), /V3_READER_MODEL_ARTIFACT/);
  }
  assert.throws(() => validateResponse(payload({ modelArtifacts: [packet, packet] }), date), /V3_READER_MODEL_ARTIFACT/);
  assert.throws(() => validateResponse(payload({ modelArtifacts: [packet, packet, packet] }), date), /V3_READER_RESPONSE/);
  const oversized = { ...packet, payloadJson: null, oversized: true, payloadBytes: MAX_MODEL_ARTIFACT_BYTES + 1 };
  assert.equal(validateResponse(payload({ modelArtifacts: [oversized] }), date).modelArtifacts, 1);
  const tooLarge = 'a'.repeat(MAX_MODEL_ARTIFACT_BYTES + 1);
  assert.throws(() => validateResponse(payload({ modelArtifacts: [{ ...packet, payloadJson: tooLarge, payloadBytes: Buffer.byteLength(tooLarge), payloadSha256: digest(tooLarge) }] }), date), /V3_READER_MODEL_ARTIFACT_PAYLOAD/);
});
test('response bounds reject oversize arrays and metadata hashes require exact types', () => {
  assert.deepEqual(validateResponse(payload(), date).missingFields, [{ index: 0, fields: ['cutoff'] }]);
  for (const changes of [{ matches: Array(MAX_MATCHES + 1).fill(payload().matches[0]) },
    { modelArtifactInventory: Array(MAX_INVENTORY + 1).fill(payload().modelArtifactInventory[0]) },
    { modelArtifactInventory: null }, { modelArtifactInventory: {} }, { generation: [] }, { productionWrites: '0' }, { readOnly: true }]) {
    assert.throws(() => validateResponse(payload(changes), date), /^Error: V3_READER_/);
  }
  for (const changes of [{ sha256: 0 }, { sha256: null }, { sha256: { digest: 'b'.repeat(64) } }, { sha256: 'b'.repeat(63) },
    { bytes: '17' }, { bytes: -1 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { version: null }, { key: '' },
    { generatedAt: '2026-10-06T11:00:00' }]) {
    assert.throws(() => validateResponse(payload({ modelArtifactInventory: [{ ...payload().modelArtifactInventory[0], ...changes }] }), date), /V3_READER_ARTIFACT_METADATA/);
  }
  assert.throws(() => validateResponse(payload({ modelArtifactInventory: Array(2).fill(payload().modelArtifactInventory[0]) }), date), /V3_READER_ARTIFACT_METADATA/);
  assert.throws(() => validateResponse(payload({ generation: { data_generation_id: 'synthetic', manifest_hash: 17 } }), date), /V3_READER_GENERATION_METADATA/);
});
test('target business day and bound event identity are mandatory; missing source and cutoff remain missing', () => {
  const lacking = { id: 'sporttery_123', businessDate: date };
  assert.deepEqual(validateResponse(payload({ matches: [lacking] }), date).missingFields,
    [{ index: 0, fields: ['sourceMatchId', 'kickoffTime', 'cutoff'] }]);
  for (const changes of [{ businessDate: '2026-10-05' }, { businessDate: null }, { sourceMatchId: 'other' },
    { id: null, sourceMatchId: null }, { cutoffAt: '' }, { predictionMeta: { cutoffTime: '2026-10-06T13:00:00' } },
    { eventVersion: '2026-10-06T15:00:00Z' }, { eventVersion: '2026-10-06T14:00:00.000000001Z' },
    { kickoffDate: '2026-02-30' }, { id: 'sporttery_', sourceMatchId: null }]) {
    assert.throws(() => validateResponse(payload({ matches: [{ ...payload().matches[0], ...changes }] }), date), /^Error: V3_READER_/);
  }
  assert.throws(() => validateResponse(payload({ businessDate: '2026-10-05' }), date), /V3_READER_RESPONSE/);
});
test('transport preserves actual clocks and labels tolerated skew without authenticating provider time', () => {
  const raw = Buffer.from(JSON.stringify(payload())), base = transport(raw);
  assert.equal(validateTransport(base, payload().observedAt).observedClockSkewMs, 0);
  const behind = validateTransport(base, '2026-10-06T11:58:59Z');
  assert.equal(behind.observedClockSkewMs, -60000); assert.equal(behind.providerClockVerification, 'not-established-by-transport-clock');
  const ahead = validateTransport(base, '2026-10-06T12:01:01Z'); assert.equal(ahead.observedClockSkewMs, 60000);
  for (const observedAt of ['2026-10-06T11:57:58.999Z', '2026-10-06T12:02:01.001Z', '2026-10-06T12:00:00',
    '2026-10-06T12:02:01.000000001Z', '2026-10-06T11:57:58.999999999Z']) {
    assert.throws(() => validateTransport(base, observedAt), /V3_READER_TRANSPORT_CLOCK/);
  }
  assert.throws(() => validateTransport({ ...base, startedAt: '2026-10-06T12:00:02Z' }, payload().observedAt), /V3_READER_TRANSPORT_CLOCK/);
  assert.equal(CLOCK_SKEW_MS, 120000);
});
test('raw companion bytes and payload bind to the receipt; modified data fails independent revalidation', () => {
  const value = payload(), raw = Buffer.from(JSON.stringify(value));
  const readTransport = transport(raw); Object.assign(readTransport, validateTransport(readTransport, value.observedAt));
  const receipt = { ...value, transport: readTransport };
  assert.equal(verifyOnlineRead(receipt, { date, rawResponse: raw }), true);
  assert.equal(verifyOnlineRead(receipt, { date, rawResponse: Buffer.from(`${raw}\n`) }), false);
  assert.equal(verifyOnlineRead({ ...receipt, matches: [] }, { date, rawResponse: raw }), false);
  assert.equal(verifyOnlineRead({ ...receipt, transport: { ...readTransport, bytes: raw.length + 1 } }, { date, rawResponse: raw }), false);
  assert.equal(verifyOnlineRead({ ...receipt, transport: { ...readTransport, providerClockVerification: 'verified' } }, { date, rawResponse: raw }), false);
  assert.equal(verifyOnlineRead(receipt, { date: '2026-10-05', rawResponse: raw }), false);
});
test('mock execution uses pinned SSH, scrubbed remote environment, bounded pipes and append-only output', t => {
  const f = fixture(t); let calls = 0;
  const execute = (binary, args, options) => {
    calls++; assert.equal(binary, 'ssh'); assert.deepEqual(args.slice(0, 2), ['-F', 'none']);
    for (const option of ['IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'HostKeyAlgorithms=ssh-ed25519', 'BatchMode=yes']) assert.ok(args.includes(option));
    assert.ok(args.includes(`UserKnownHostsFile=${f.env.RELEASE_DEPLOY_KNOWN_HOSTS.replace(/\\/g, '/')}`));
    assert.ok(args.includes('synthetic_user@synthetic.invalid')); assert.match(args.at(-1), /sudo -n env -i PATH=\/usr\/bin:\/bin/);
    assert.equal(options.maxBuffer, MAX_BYTES); assert.equal(options.timeout, 45000); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']); assert.match(options.input, /runuser/);
    assert.match(options.input, /READ ONLY/); assert.doesNotMatch(options.input, /PGPASSWORD|dotenv|collectors|syncData/);
    return Buffer.from(JSON.stringify(identityPayload({asOf:new Date().toISOString(),businessDate:f.liveDate}).raw));
  };
  const result = readInputs({ date:f.liveDate, output: f.output }, f.env, execute);
  assert.equal(result.productionWrites, 0); assert.equal(calls, 1);
  const raw = fs.readFileSync(`${f.output}.remote-response.json`), value = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  assert.equal(verifyOnlineRead(value, { date:f.liveDate, rawResponse: raw,trustRegistry:pair.registry }), true);
  assert.equal(result.remoteResponseSha256, digest(raw));
  assert.throws(() => readInputs({ date, output: f.output }, f.env, execute), /V3_READER_NEW_OUTPUT_REQUIRED/);
  assert.equal(calls, 1); assert.equal(fs.readFileSync(`${f.output}.remote-response.json`).equals(raw), true);
});
test('existing raw companion also blocks another read and existing bytes are retained', t => {
  const f = fixture(t), marker = Buffer.from('synthetic-original-immutable-bytes');
  fs.writeFileSync(`${f.output}.remote-response.json`, marker);
  assert.throws(() => readInputs({ date, output: f.output }, f.env, () => assert.fail('should not run')), /V3_READER_NEW_OUTPUT_REQUIRED/);
  assert.equal(fs.readFileSync(`${f.output}.remote-response.json`).equals(marker), true);
});
test('a raced destination is never overwritten; the successfully written raw receipt stays immutable', t => {
  const f = fixture(t), marker = 'synthetic-existing-report';
  const execute = () => { fs.writeFileSync(f.output, marker); return Buffer.from(JSON.stringify(identityPayload({asOf:new Date().toISOString(),businessDate:f.liveDate}).raw)); };
  assert.throws(() => readInputs({ date:f.liveDate, output: f.output }, f.env, execute), /V3_READER_OUTPUT_COMMIT_FAILED/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), marker);
  assert.equal(fs.existsSync(`${f.output}.remote-response.json`), true);
});
test('bad pins and command errors never expose stderr, credentials, SQL or raw malformed data', t => {
  const f = fixture(t), secret = 'SYNTHETIC_SECRET_MUST_NOT_ESCAPE';
  assert.throws(() => readInputs({ date, output: f.output }, { ...f.env, RELEASE_DEPLOY_HOST_KEY_SHA256: secret }, () => assert.fail('should not run')),
    error => error.message === 'V3_READER_SSH_PIN_INVALID');
  assert.throws(() => readInputs({ date, output: f.output }, f.env, () => { const e = Error(secret); e.stderr = Buffer.from(secret); throw e; }),
    error => error.message === 'V3_READER_PINNED_READ_FAILED');
  assert.throws(() => readInputs({ date, output: f.output }, f.env, () => Buffer.from(`not-json-${secret}`)),
    error => error.message === 'V3_READER_RESPONSE_JSON');
  assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(`${f.output}.remote-response.json`), false);
});
test('response size/type, remote clock window and forged transport are checked before writing', t => {
  const f = fixture(t);
  for (const raw of ['', Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1)]) {
    assert.throws(() => readInputs({ date, output: f.output }, f.env, () => raw), /V3_READER_RESPONSE_BOUND/);
  }
  assert.throws(() => readInputs({ date, output: f.output }, f.env, () => Buffer.from(JSON.stringify(payload()))), /V3_READER_TRANSPORT_CLOCK/);
  assert.throws(() => readInputs({ date, output: f.output }, f.env,
    () => Buffer.from(JSON.stringify(payload({ observedAt: new Date().toISOString(), transport: {} })))), /V3_READER_REMOTE_TRANSPORT_FORBIDDEN/);
  assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(`${f.output}.remote-response.json`), false);
});
test('direct read API rejects calendar and SSH argument injection before invoking transport', t => {
  const f = fixture(t), noExecute = () => assert.fail('should not run');
  assert.throws(() => readInputs({ date: `${date}'`, output: f.output }, f.env, noExecute), /V3_READER_DATE/);
  for (const changes of [{ RELEASE_DEPLOY_HOST: '-oProxyCommand=secret' }, { RELEASE_DEPLOY_USER: 'user;echo' },
    { RELEASE_DEPLOY_KEY: '' }, { RELEASE_DEPLOY_HOST: 'synthetic.invalid\nother' }]) {
    assert.throws(() => readInputs({ date, output: f.output }, { ...f.env, ...changes }, noExecute), /V3_READER_SSH_CONFIG/);
  }
});

// Synthetic signed current endpoint: contains a not-yet-open fixture and no
// HAD pool. It is never a provider sample, price prediction or model fit.
function identityPayload({asOf='2026-10-08T10:00:00.000Z',businessDate='2026-10-08',prefix='sporttery'}={}) {
  const at=Date.parse(asOf),kickoff=new Date(Date.parse(businessDate+'T00:00:00Z')+16*3600000).toISOString();
  const receivedAt=new Date(at-2000).toISOString(),requestedAt=new Date(at-3000).toISOString();
  const match={id:`${prefix}_123`,sourceMatchId:'123',businessDate,matchNo:'周四001',
    homeTeamName:'Synthetic Home',awayTeamName:'Synthetic Away',homeTeamId:derivedTeamId('Synthetic Home'),awayTeamId:derivedTeamId('Synthetic Away'),
    kickoffTime:kickoff,eventVersion:kickoff,buyEndTime:businessDate+' 22:00:00',predictionMeta:{cutoffTime:kickoff},
    sourceCycleId:'sporttery-full-sync:synthetic',sourceObservedAt:receivedAt,sourceReceivedAt:receivedAt,status:'SCHEDULED'};
  const bj=new Date(Date.parse(kickoff)+8*3600000).toISOString();
  const row={matchId:123,homeTeamAllName:match.homeTeamName,awayTeamAllName:match.awayTeamName,
    matchDate:bj.slice(0,10),matchTime:bj.slice(11,19),matchNumStr:match.matchNo,matchStatus:'Define',oddsList:[]};
  const sourcePayload={success:true,value:{matchInfoList:[{businessDate,subMatchList:[row]}]}};
  const url='https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001';
  const endpoint={method:'current',page:null,ok:true,url,requestedAt,receivedAt,sourceCycleId:'sporttery-fast:synthetic',
    sourceRequest:{url,method:'GET',page:null,role:'current'},providerObservedAt:null,httpStatus:200,httpDate:null,httpEtag:null,
    contentType:'application/json',headersSha256:'a'.repeat(64),rawSha256:'b'.repeat(64),rawBytes:Buffer.byteLength(JSON.stringify(sourcePayload)),
    canonicalPayloadSha256:attestation.sha256CollectorJson(sourcePayload),payload:sourcePayload};
  const commitment=attestation.buildCollectorCommitment({provider:'sporttery',endpoint:{url,method:'GET',page:null,role:'current'},
    collectorCycleId:endpoint.sourceCycleId,requestedAt,receivedAt,providerObservedAt:null,response:endpoint,payload:sourcePayload});
  endpoint.collectorAttestation=attestation.signCollectorCommitment(commitment,pair);
  const generation={data_generation_id:'g-synthetic',manifest_hash:'c'.repeat(64),committed_at:new Date(at-1000).toISOString(),
    data_publication_mode:'active-generation',data_generation_source_cycle_id:match.sourceCycleId};
  const pgRow={dataset:'current',match_id:match.id,source_match_id:match.sourceMatchId,kickoff_time:kickoff.replace('T',' ').replace('Z','+00')};
  const raw={version:online.IDENTITY_VERSION,readOnly:'on',productionWrites:0,businessDate,observedAt:asOf,generation,
    matches:[match],matchRows:[pgRow],modelArtifactInventory:[],modelArtifacts:[],identitySource:{
      version:'prematch-v3-online-identity-source-v1',sourcePath:identity.CURRENT_SNAPSHOT_NAMESPACE,endpoint,inputCapturedAt:asOf,collectorTrustRegistryHash:attestation.sha256CollectorJson(pair.registry)}};
  return {raw,match,row:pgRow,endpoint,publication:identity.publicationFromMeta(generation),pgObservedAt:asOf,inputCapturedAt:asOf,trustRegistry:pair.registry};
}
function admitted(f) {return require('../scripts/readPrematchV3OnlineInputs.cjs').admitIdentityResponse(f.raw,pair.registry);}
function copy(v){return JSON.parse(JSON.stringify(v));}
test('v3 exact canonical event admits both known IDs without a HAD sale or frozen decision; originals do not change',()=>{
  for(const prefix of ['sporttery','fivehundred']) {
    const f=identityPayload({prefix}),before=JSON.stringify(f.raw),value=admitted(f),proof=value.identityAdmissions[0];
    assert.equal(online.validateResponse(value,f.raw.businessDate,{trustRegistry:pair.registry}).matches,1);
    assert.equal(identity.verifyPrematchV3InputIdentity(proof,f),true);
    assert.equal(proof.cutoffAt,'2026-10-08T14:00:00.000Z');
    assert.notEqual(proof.currentEventIdentity.sourceCycleId,proof.publication.sourceCycleId);
    assert.equal(proof.formalEligible,false);assert.equal(JSON.stringify(f.raw),before);
    const event=assessment.eventFromMatch(f.match,{identityAdmission:proof,identityContext:f});
    assert.equal(require('../src/services/prematchV3Clock.cjs').epochNanoseconds(event.cutoffAt),require('../src/services/prematchV3Clock.cjs').epochNanoseconds('2026-10-08T14:00:00.000Z'));
    assert.equal(event.sourceMatchId,'123');
  }
});
test('v3 rejects unknown prefixes, same suffix with wrong row/event/team/order/no/business day and ns drift',()=>{
  const f=identityPayload({prefix:'fivehundred'});
  for(const mutate of [v=>{v.match.id='other_123';v.row.match_id=v.match.id;},v=>{v.row.source_match_id='124';},
    v=>{v.row.match_id='sporttery_124';},v=>{v.row.kickoff_time='2026-10-08 16:00:00.000000001+00';},
    v=>{v.match.homeTeamId=v.match.awayTeamId;},v=>{[v.match.homeTeamName,v.match.awayTeamName]=[v.match.awayTeamName,v.match.homeTeamName];
      [v.match.homeTeamId,v.match.awayTeamId]=[v.match.awayTeamId,v.match.homeTeamId];},v=>{v.match.matchNo='周四002';},
    v=>{v.match.matchNumStr='周四002';},v=>{v.match.businessDate='2026-10-07';},v=>{v.match.eventVersion='2026-10-08T16:00:00.000000001Z';}]) {
    const bad=copy(f);mutate(bad);assert.equal(identity.createPrematchV3InputIdentity(bad),null);
  }
});
test('current identity cryptographically rejects forged payload/signature/role/url/cycle and caller boolean trust',()=>{
  const f=identityPayload();
  for(const mutate of [v=>{v.endpoint.payload.value.matchInfoList[0].subMatchList[0].homeTeamAllName='Forged';},
    v=>{v.endpoint.collectorAttestation.signature='A'.repeat(88);},v=>{v.endpoint.sourceRequest.role='calculator';},
    v=>{v.endpoint.url='https://example.invalid/current';},v=>{v.endpoint.sourceCycleId='different';},
    v=>{v.endpoint.receivedAt='2026-10-08T10:00:00.001Z';},v=>{v.trustRegistry=true;},v=>{v.trustRegistry={identityAccepted:true};}]) {
    const bad=copy(f);mutate(bad);assert.equal(identity.createPrematchV3InputIdentity(bad),null);
  }
});
test('PG active generation and actual source knowledge must bind; cannot restamp or normalize future ns',()=>{
  const f=identityPayload();
  for(const mutate of [v=>{v.publication.mode='previous';},v=>{v.publication.sourceCycleId='other';},
    v=>{v.publication.manifestHash='wrong';},v=>{v.publication.committedAt='2026-10-08T10:00:00.000000001Z';},
    v=>{v.pgObservedAt='2026-10-08T10:00:00.000000001Z';},v=>{v.match.sourceReceivedAt='2026-10-08T10:00:00.000000001Z';},
    v=>{v.match.sourceObservedAt='2026-10-08T09:59:58.000000001Z';},v=>{v.endpoint.requestedAt='2026-10-08T09:40:00.000Z';}]) {
    const bad=copy(f);mutate(bad);assert.equal(identity.createPrematchV3InputIdentity(bad),null);
  }
});
test('identity endpoint rejects correctly re-signed requested/received/provider clocks later by one nanosecond',()=>{
  for(const mutate of [v=>{v.endpoint.receivedAt='2026-10-08T10:00:00.000000001Z';},
    v=>{v.endpoint.requestedAt='2026-10-08T09:59:58.000000001Z';},
    v=>{v.endpoint.providerObservedAt='2026-10-08T09:59:58.000000001Z';}]) {
    const bad=identityPayload();mutate(bad);
    bad.endpoint.collectorAttestation=attestation.signCollectorCommitment(attestation.buildCollectorCommitment({provider:'sporttery',
      endpoint:bad.endpoint.sourceRequest,collectorCycleId:bad.endpoint.sourceCycleId,requestedAt:bad.endpoint.requestedAt,
      receivedAt:bad.endpoint.receivedAt,providerObservedAt:bad.endpoint.providerObservedAt,response:bad.endpoint,payload:bad.endpoint.payload}),pair);
    assert.equal(require('../scripts/recommendationPlatform/liveOfficialHad.cjs').verifySignedCurrentEndpointIdentity(
      bad.endpoint,{asOf:bad.inputCapturedAt,trustRegistry:pair.registry}),false);
    assert.equal(identity.createPrematchV3InputIdentity(bad),null);
  }
});
test('only signed current binds local buyEndTime; earliest sale wins and late/unknown cutoffs stay blocked',()=>{
  const f=identityPayload({prefix:'fivehundred'}),value=admitted(f),proof=value.identityAdmissions[0];
  assert.equal(assessment.eventFromMatch(f.match).cutoffAt,null);
  assert.equal(identity.resolveIdentityDeadline(f.match,f.match.buyEndTime,{identityAdmission:proof,identityContext:f}).instant,'2026-10-08T22:00:00+08:00');
  for(const mutate of [v=>{v.match.cutoffAt='2026-10-08 21:00:00';},
    v=>{v.match.cutoffAt='2026-10-08T12:00:00Z';v.match.cutoffTime='2026-10-08T12:00:00.000000001Z';},
    v=>{v.inputCapturedAt='2026-10-08T14:00:00.000Z';},v=>{v.match.buyEndTime='2026-02-31 22:00:00';}]) {
    const bad=copy(f);mutate(bad);assert.equal(identity.createPrematchV3InputIdentity(bad),null);
  }
  const invalid=assessment.buildPrematchV3Assessment(f.match,{asOf:f.inputCapturedAt,identityAdmission:{...proof,identityAccepted:true},identityContext:f});
  assert.ok(invalid.blockers.includes('input-identity-admission-invalid'));assert.equal(invalid.primary,null);
  const beforeKnown=assessment.buildPrematchV3Assessment(f.match,{asOf:'2026-10-08T09:59:59.999999999Z',identityAdmission:proof,identityContext:f});
  assert.ok(beforeKnown.blockers.includes('input-identity-not-known-at-as-of'));assert.equal(beforeKnown.baseline.baseRates,null);
});
test('v3 raw and identity sidecars replay fully against external trust; missing/tampered/foreign proofs fail closed',()=>{
  const f=identityPayload(),value=admitted(f),raw=Buffer.from(JSON.stringify(f.raw));
  const tr={...transport(raw),startedAt:'2026-10-08T09:59:59.000Z',finishedAt:'2026-10-08T10:00:01.000Z'};
  Object.assign(tr,validateTransport(tr,f.raw.observedAt));const saved={...value,transport:tr};
  assert.equal(verifyOnlineRead(saved,{date:f.raw.businessDate,rawResponse:raw,trustRegistry:pair.registry}),true);
  assert.equal(verifyOnlineRead({...saved,identityAdmissions:[]},{date:f.raw.businessDate,rawResponse:raw,trustRegistry:pair.registry}),false);
  assert.equal(verifyOnlineRead(saved,{date:f.raw.businessDate,rawResponse:Buffer.from(JSON.stringify({...f.raw,matches:[]})),trustRegistry:pair.registry}),false);
  assert.equal(verifyOnlineRead(saved,{date:f.raw.businessDate,rawResponse:raw,trustRegistry:{version:'forged',keys:[]}}),false);
  for(const mutate of [v=>{delete v.identityAdmissions;},v=>{v.identityAdmissions[0].cutoffAt='2026-10-08T15:00:00Z';},
    v=>{v.matchRows[0].source_match_id='124';},v=>{v.identitySource.collectorTrustRegistryHash='0'.repeat(64);},
    v=>{v.identitySource.inputCapturedAt='2026-10-08T09:59:59Z';}]) {
    const bad=copy(value);mutate(bad);assert.throws(()=>online.validateResponse(bad,f.raw.businessDate,{trustRegistry:pair.registry}),/^Error: V3_READER_/);
  }
});
test('v3 empty input is not positive identity evidence and still validates actual current endpoint signature',()=>{
  const f=identityPayload();f.raw.matches=[];f.raw.matchRows=[];
  assert.equal(admitted(f).identityAdmissions.length,0);
  f.raw.identitySource.endpoint.collectorAttestation.signature='A'.repeat(88);
  assert.throws(()=>admitted(f),/V3_READER_IDENTITY_SOURCE_SIGNATURE/);
});
test('v3 refuses duplicated canonical events and source namespaces even with otherwise valid sealed sidecars',()=>{
  const f=identityPayload(),value=admitted(f),duplicate=copy(value);
  duplicate.matches.push(copy(duplicate.matches[0]));duplicate.matchRows.push(copy(duplicate.matchRows[0]));duplicate.identityAdmissions.push(copy(duplicate.identityAdmissions[0]));
  assert.throws(()=>online.validateResponse(duplicate,f.raw.businessDate,{trustRegistry:pair.registry}),/V3_READER_MATCH_EVENT_AMBIGUOUS/);
  const pathChanged=copy(value);pathChanged.identitySource.sourcePath='/tmp/untrusted-current.json';
  assert.throws(()=>online.validateResponse(pathChanged,f.raw.businessDate,{trustRegistry:pair.registry}),/V3_READER_IDENTITY_SIDECARS/);
});
test('new reader requires v3 and exact raw sidecar transport; old v2 remains a legacy replay, not a new admitted read',t=>{
  const f=fixture(t);
  assert.throws(()=>readInputs({date,output:f.output},f.env,()=>Buffer.from(JSON.stringify(payload({observedAt:new Date().toISOString()})))),/V3_READER_IDENTITY_RESPONSE_REQUIRED/);
  assert.equal(fs.existsSync(f.output),false);
  assert.match(query(date),/prematch-v3-online-readonly-v3/);
  assert.match(query(date),/'matchRows'/);assert.match(query(date),/data_generation_source_cycle_id/);
});
test('detached V3 research facts reuse the original PG identity sidecar, while any other field change fails',()=>{
  const f=identityPayload({prefix:'fivehundred'}),value=admitted(f),before=JSON.stringify(value);
  const options=require('../scripts/readPrematchV3OnlineInputs.cjs').identityOptionsFor(value,0,pair.registry);
  const derived={...f.match,externalSignals:{prematchV3:{version:assessment.SOURCE_VERSION,teamObservations:[],asianHandicapObservations:[]}}};
  const proof=options.identityAdmission,context={...options.identityContext,match:derived};
  assert.equal(identity.verifyPrematchV3InputIdentity(proof,context),false,'the original sidecar is not restamped');
  assert.equal(identity.verifyPrematchV3AssessmentIdentity(proof,context),true);
  assert.equal(assessment.eventFromMatch(derived,options).cutoffAt,'2026-10-08T22:00:00+08:00');
  const result=assessment.buildPrematchV3Assessment(derived,{...options,asOf:f.inputCapturedAt});
  assert.equal(result.blockers.includes('input-identity-admission-invalid'),false);assert.equal(result.formalEligible,false);
  for(const mutate of [v=>{v.odds={odds1:1.5};},v=>{v.buyEndTime='2026-10-08 23:00:00';},
    v=>{v.homeTeamId='different';},v=>{v.externalSignals.other={fake:true};},v=>{v.probabilityModel={fake:true};}]){
    const bad=copy(derived);mutate(bad);
    assert.equal(identity.verifyPrematchV3AssessmentIdentity(proof,{...options.identityContext,match:bad}),false);
    assert.equal(assessment.eventFromMatch(bad,options).cutoffAt,null);
  }
  assert.equal(identity.verifyPrematchV3AssessmentIdentity(proof,{...context,originalMatch:{...f.match,id:'sporttery_124'}}),false);
  assert.equal(identity.verifyPrematchV3AssessmentIdentity(proof,{match:derived,originalMatch:f.match,identityAccepted:true}),false);
  assert.equal(JSON.stringify(value),before);
});
