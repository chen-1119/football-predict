'use strict';
// Fixed local transport. The signed root socket must be installed separately;
// this client cannot install/start it. API NoNewPrivileges stays on.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { createHash } = require('node:crypto');
const { decodeRequest, MAX_REQUEST_BYTES } = require('./researchWriteService.cjs');
const { reportKey, prepare } = require('./researchReportStore.cjs');
const ROOT = '/opt/football-predict', NODE = '/opt/node-v22.22.1/bin/node';
const CONFIG = '/usr/local/libexec/football-research-broker/runtime-binding.json';
const SOCKET = '/run/football-research-broker/submit.sock';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024, DEADLINE_MS = 80000;
const sha = raw => createHash('sha256').update(raw).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code, retryWriteAutomatically: false }); };
function installedContext() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.execPath !== NODE
    || process.execArgv.length || process.argv.length !== 2 || process.argv[1] !== ROOT + '/server/index.cjs') fail('RESEARCH_FIXED_API_CALLER_REQUIRED');
  for (let p = path.dirname(CONFIG); ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) fail('RESEARCH_CLIENT_BINDING_IDENTITY');
    if (p === '/') break;
  }
  const s = fs.lstatSync(CONFIG);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o022) || s.size > 16384)
    fail('RESEARCH_CLIENT_BINDING_IDENTITY');
  const fd = fs.openSync(CONFIG, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let binding;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size) fail('RESEARCH_CLIENT_BINDING_IDENTITY');
    binding = JSON.parse(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
  const t = binding.transport;
  if (binding.version !== 'research-broker-binding-v1' || !/^[a-f0-9]{64}$/.test(binding.releaseSha || '')
    || !t || Object.keys(t).sort().join(',') !== 'apiSourceSha,clientSourceSha,footballGid,footballUid,peerSourceSha,version'
    || t.version !== 'research-unix-socket-v1' || !Number.isSafeInteger(t.footballUid) || t.footballUid < 1
    || !Number.isSafeInteger(t.footballGid) || t.footballGid < 1 || process.getuid() !== t.footballUid
    || process.getgid() !== t.footballGid || ['apiSourceSha','clientSourceSha','peerSourceSha'].some(k => !/^[a-f0-9]{64}$/.test(t[k] || '')))
    fail('RESEARCH_CLIENT_BINDING_IDENTITY');
  if (sha(fs.readFileSync(ROOT + '/server/index.cjs')) !== t.apiSourceSha
    || sha(fs.readFileSync(ROOT + '/server/researchBrokerClient.cjs')) !== t.clientSourceSha) fail('RESEARCH_CLIENT_SOURCE_CHANGED');
  for (const file of ['.release-bundle-sha256', '.release-live-complete']) {
    if (fs.readFileSync(ROOT + '/' + file, 'utf8').trim() !== binding.releaseSha) fail('RESEARCH_CLIENT_RELEASE_CHANGED');
  }
  const directory = fs.lstatSync(path.dirname(SOCKET)), socket = fs.lstatSync(SOCKET);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || directory.gid !== t.footballGid
    || (directory.mode & 0o777) !== 0o750 || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0
    || socket.gid !== t.footballGid || (socket.mode & 0o777) !== 0o660) fail('RESEARCH_CLIENT_SOCKET_IDENTITY');
  return { releaseSha: binding.releaseSha };
}
function decodeBrokerResponse(bytes, raw, context, startedAt, finishedBy) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES
    || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('RESEARCH_BROKER_RESPONSE_BOUND');
  let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED'); }
  let replayed = false, receiptUpperBound = finishedBy;
  if (result?.version === 'research-broker-replay-v1') {
    if (Object.keys(result).sort().join(',') !== 'automaticWriteRetry,deliveredAt,originalReceiptBase64,originalReceiptSha256,releaseSha,requestSha,version'
      || result.requestSha !== sha(raw) || result.releaseSha !== context.releaseSha || result.automaticWriteRetry !== false
      || typeof result.originalReceiptBase64 !== 'string'
      || typeof result.deliveredAt !== 'string' || !Number.isFinite(Date.parse(result.deliveredAt))
      || new Date(result.deliveredAt).toISOString() !== result.deliveredAt || Date.parse(result.deliveredAt) < startedAt
      || Date.parse(result.deliveredAt) > finishedBy || !['archive','publish','revision-publish','combo-revision-publish'].includes(decodeRequest(raw).action)) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    const saved = Buffer.from(result.originalReceiptBase64,'base64');
    if(saved.toString('base64')!==result.originalReceiptBase64||saved.length>3*1024*1024-4096
      ||sha(saved)!==result.originalReceiptSha256||!Buffer.from(saved.toString()).equals(saved)) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    receiptUpperBound = Date.parse(result.deliveredAt);
    try { result = JSON.parse(saved.toString()); } catch { fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED'); }
    replayed = true;
  }
  if (!result || Object.keys(result).sort().join(',') !== 'automaticWriteRetry,code,finishedAt,overflow,releaseSha,requestSha,stderr,stdout,version'
    || result.version !== 'research-broker-result-v1' || result.requestSha !== sha(raw) || result.releaseSha !== context.releaseSha
    || result.code !== 0 || result.overflow !== false || result.automaticWriteRetry !== false || result.stderr !== ''
    || typeof result.stdout !== 'string' || typeof result.finishedAt !== 'string' || !Number.isFinite(Date.parse(result.finishedAt))
    || new Date(result.finishedAt).toISOString() !== result.finishedAt || (!replayed && Date.parse(result.finishedAt) < startedAt)
    || Date.parse(result.finishedAt) > receiptUpperBound) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
  let value; try { value = JSON.parse(result.stdout); } catch { fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED'); }
  if (!value || value.ok !== true || value.retryWriteAutomatically !== false) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
  const request = decodeRequest(raw);
  if (request.action.startsWith('archive')) {
    const original = request.action === 'archive' ? JSON.parse(request.json) : request;
    const key = reportKey(original.businessDate, original.reportKind);
    if (value.key !== key || !['report-archived', 'not-observed'].includes(value.state)
      || (request.action === 'archive' && (value.state !== 'report-archived' || value.commitAcknowledged !== true))
      || (value.state === 'report-archived' && (value.sha256 !== request.sha256 || value.readbackVerified !== true
        || value.verificationScope !== 'archive-byte-integrity-only' || value.published !== false
        || value.recommendationEligibilityVerified !== false))) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    if (value.state === 'report-archived') {
      if (typeof value.originalJson !== 'string') fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
      const exact = prepare(Buffer.from(value.originalJson), request.sha256);
      if (exact.key !== key || exact.bytes !== value.bytes || exact.generatedAt !== value.generatedAt
        || typeof value.receivedAt !== 'string' || !Number.isFinite(Date.parse(value.receivedAt))
        || new Date(value.receivedAt).toISOString() !== value.receivedAt
        || Date.parse(value.receivedAt) < Date.parse(exact.generatedAt)
        || Date.parse(value.receivedAt) > Date.parse(result.finishedAt)) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    }
  } else if(request.action.startsWith('combo-revision-')) {
    const r=JSON.parse(request.json),key=require('./researchComboRevision.cjs').validate(r);
    if(value.key!==key||!['not-observed','record-present-ack-missing','committed-and-acknowledged'].includes(value.state)
      ||(value.state==='committed-and-acknowledged'&&(value.verified!==true||value.revision!==r.revision
        ||value.baseArchiveKey!==r.baseArchiveKey||value.baseArchiveSha256!==r.baseArchiveSha256||value.previousRevisionHash!==r.previousRevisionHash
        ||value.originalSettlementPreserved!==true||value.independentEventIncrement!==0
        ||['payloadSha256','ackSha256','baseIdentity'].some(k=>!/^[a-f0-9]{64}$/.test(value[k]||''))))
      ||(value.state!=='committed-and-acknowledged'&&value.verified!==false)) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    if(value.verified){
      const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),ds=value.latestDecisions,first=value.originalDecisions,c=value.combo;
      if(!Array.isArray(ds)||!Array.isArray(first)||ds.length!==r.size||first.length!==r.size||!c||c.band!==r.band
        ||!Array.isArray(c.legs)||c.legs.length!==r.size||value.baseIdentity!==policy.hash({baseArchiveKey:r.baseArchiveKey,baseArchiveSha256:r.baseArchiveSha256,bases:r.bases,size:r.size,band:r.band}))fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
      for(let i=0;i<r.size;i++){
        const d=ds[i],o=first[i],pick=r.draft.singles[i],leg=c.legs[i];
        if(!d||!o||d.eventId!==r.bases[i].eventId||o.eventId!==d.eventId||d.eventVersion!==o.eventVersion||d.market!==pick.market||d.selection!==pick.selection
          ||(d.handicap??null)!==pick.handicap||policy.hash(d.scores)!==policy.hash(pick.scores)||d.homeTeamName!==pick.teams[0]||d.awayTeamName!==pick.teams[1]
          ||d.homeTeamId!==o.homeTeamId||d.awayTeamId!==o.awayTeamId||d.modelProbability!==null||d.modelVersion!==null||d.formalEligible!==false
          ||['eventId','matchNum','market','selection','sp'].some(k=>leg[k]!==d[k])||(leg.handicap??null)!==(d.handicap??null))fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
      }
      if(c.product!==require('../scripts/recommendationPlatform/reviewedComboHistory.cjs').exactProduct(c.legs)||c.product<r.band)fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    }
  } else if(request.action.startsWith('revision-')) {
    const r=JSON.parse(request.json),key=require('./researchReviewedRevision.cjs').validate(r);
    if(value.key!==key||!['not-observed','record-present-ack-missing','committed-and-acknowledged'].includes(value.state)
      ||(value.state==='committed-and-acknowledged'&&(value.verified!==true||value.revision!==r.revision||value.baseRecordKey!==r.baseRecordKey
        ||value.basePayloadSha256!==r.basePayloadSha256||value.previousRevisionHash!==r.previousRevisionHash||value.originalSettlementPreserved!==true||value.independentEventIncrement!==0
        ||['payloadSha256','ackSha256','originalDecisionHash'].some(k=>!/^[a-f0-9]{64}$/.test(value[k]||''))))
      ||(value.state!=='committed-and-acknowledged'&&value.verified!==false))fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    if(value.verified){
      const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),pick=r.draft.singles[0],latest=value.latestDecision,first=value.originalDecision;
      if(!latest||!first||policy.hash(first)!==value.originalDecisionHash||latest.eventId!==r.eventId||first.eventId!==r.eventId
        ||latest.eventVersion!==first.eventVersion||latest.market!==pick.market||latest.selection!==pick.selection
        ||(latest.handicap??null)!==pick.handicap||policy.hash(latest.scores)!==policy.hash(pick.scores)
        ||latest.homeTeamName!==pick.teams[0]||latest.awayTeamName!==pick.teams[1]||latest.homeTeamId!==first.homeTeamId||latest.awayTeamId!==first.awayTeamId
        ||latest.modelProbability!==null||latest.modelVersion!==null||latest.formalEligible!==false)fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
    }
  } else {
    const key = request.action === 'publish' ? 'reviewed-analysis-' + JSON.parse(request.json).businessDate + '-batch-' + request.draftHash : request.recordKey;
    if (value.recordKey !== key || !['not-observed','orphan-ack-unverified','record-present-ack-missing','committed-and-acknowledged'].includes(value.state)
      || (value.state === 'committed-and-acknowledged' && (value.verified !== true || !Array.isArray(value.records)
        || value.records.length < 1 || value.records.length > 32 || ['payloadSha256','ackSha256','recordHash'].some(k => !/^[a-f0-9]{64}$/.test(value[k] || ''))))
      || (value.state !== 'committed-and-acknowledged' && value.verified !== false)) fail('RESEARCH_BROKER_RESPONSE_UNVERIFIED');
  }
  return replayed ? { ...value, replayedReceipt: true, originalFinishedAt: result.finishedAt } : value;
}
async function submitResearchRequest(raw) {
  decodeRequest(raw);
  const request = Buffer.from(raw), context = installedContext(), startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET }), chunks = []; let bytes = 0, expected, settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(Object.assign(Error(error), { code: error, retryWriteAutomatically: false }));
      else { try { resolve(decodeBrokerResponse(Buffer.concat(chunks).subarray(4), request, context, startedAt, Date.now())); }
        catch (e) { reject(e); } }
    };
    const timer = setTimeout(() => finish('RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST'), DEADLINE_MS);
    socket.once('connect', () => { const header = Buffer.alloc(4); header.writeUInt32BE(request.length); socket.end(Buffer.concat([header, request])); });
    socket.on('data', b => {
      bytes += b.length;
      if (bytes > MAX_RESPONSE_BYTES + 4) return finish('RESEARCH_BROKER_RESPONSE_BOUND');
      chunks.push(b);
      if (expected === undefined && bytes >= 4) { expected = Buffer.concat(chunks).readUInt32BE(0);
        if (expected < 2 || expected > MAX_RESPONSE_BYTES) return finish('RESEARCH_BROKER_RESPONSE_BOUND'); }
      if (expected !== undefined && bytes > expected + 4) finish('RESEARCH_BROKER_RESPONSE_BOUND');
    });
    socket.once('end', () => finish(expected !== undefined && bytes === expected + 4 ? null : 'RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST'));
    socket.once('error', () => finish('RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST'));
    socket.once('close', () => { if (!settled) finish('RESEARCH_SOCKET_UNCONFIRMED_READ_FIRST'); });
  });
}
module.exports = { submitResearchRequest, decodeBrokerResponse, MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES };
