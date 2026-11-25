'use strict';

// These functions also run in the fixed, read-only remote probe. Keep imports local.
function validateTimeoutAnchor(anchor) {
  const assert = require('node:assert/strict');
  const keys = ['kind','workerMainPid','workerStartedAt','cycleStartedAt','cycleFinishedAt','bootId','invocationId',
    'journalStartUs','journalEndUs','journalStartCursor','journalEndCursor','journalRows','journalMessageSha256','attemptSha256','originalRecoveryAttempt'];
  assert.deepEqual(Object.keys(anchor).sort(),keys.sort());
  assert(['reconciliation-180s','deadline-recovery'].includes(anchor.kind));
  assert.match(anchor.workerMainPid,/^[1-9][0-9]*$/);
  for (const k of ['bootId','invocationId']) assert.match(anchor[k],/^[0-9a-f]{32}$/);
  for (const k of ['workerStartedAt','cycleStartedAt','cycleFinishedAt']) assert.equal(new Date(anchor[k]).toISOString(),anchor[k]);
  const start=Date.parse(anchor.cycleStartedAt), end=Date.parse(anchor.cycleFinishedAt);
  assert(Date.parse(anchor.workerStartedAt)<=start && start<end);
  for (const k of ['journalStartUs','journalEndUs']) assert.match(anchor[k],/^[1-9][0-9]{15}$/);
  const first=Number(anchor.journalStartUs), last=Number(anchor.journalEndUs);
  assert(first>=end*1000 && last>=first && last<(end+5000)*1000);
  for (const k of ['journalStartCursor','journalEndCursor']) assert.match(anchor[k],/^[a-z0-9=;:-]{1,256}$/);
  assert.notEqual(anchor.journalStartCursor,anchor.journalEndCursor);
  assert(Number.isSafeInteger(anchor.journalRows) && anchor.journalRows>=2 && anchor.journalRows<=1024);
  assert.match(anchor.journalMessageSha256,/^[a-f0-9]{64}$/);
  if(anchor.kind==='reconciliation-180s') {
    assert.equal(anchor.attemptSha256,null); assert.equal(anchor.originalRecoveryAttempt,null);
  } else {
    assert.match(anchor.attemptSha256,/^[a-f0-9]{64}$/);
    assert.equal(typeof anchor.originalRecoveryAttempt,'string');
    assert(require('node:buffer').Buffer.byteLength(anchor.originalRecoveryAttempt)<=4096);
    assert.equal(require('node:crypto').createHash('sha256').update(anchor.originalRecoveryAttempt).digest('hex'),anchor.attemptSha256);
  }
  return anchor;
}

function verifyTimeoutFrame(a, rows, attemptRaw) {
  const assert=require('node:assert/strict'), crypto=require('node:crypto');
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  validateTimeoutAnchor(a);
  assert.equal(rows.length,a.journalRows);
  assert.equal(rows[0].__CURSOR,a.journalStartCursor);
  assert.equal(rows.at(-1).__CURSOR,a.journalEndCursor);
  assert.equal(rows[0].__REALTIME_TIMESTAMP,a.journalStartUs);
  assert.equal(rows.at(-1).__REALTIME_TIMESTAMP,a.journalEndUs);
  const cursors=new Set();
  let previous=Number(a.journalStartUs);
  for(const r of rows) {
    assert.equal(r._SYSTEMD_UNIT,'football-sync-worker.service');
    assert.equal(r._PID,a.workerMainPid);
    assert.equal(r._BOOT_ID,a.bootId);
    assert.equal(r._SYSTEMD_INVOCATION_ID,a.invocationId);
    assert.match(r.__REALTIME_TIMESTAMP,/^[1-9][0-9]{15}$/);
    const at=Number(r.__REALTIME_TIMESTAMP);
    assert(at>=previous && at<=Number(a.journalEndUs));
    previous=at;
    assert.equal(typeof r.MESSAGE,'string');
    assert.match(r.__CURSOR,/^[a-z0-9=;:-]{1,256}$/);
    assert(!cursors.has(r.__CURSOR),'duplicate journal record');
    cursors.add(r.__CURSOR);
  }
  const messages=rows.map(row=>row.MESSAGE).join('\n');
  assert.equal(sha(messages),a.journalMessageSha256);
  const frame=JSON.parse(messages), cycle=frame.lastCycle;
  assert.equal(frame.type,'sync-worker-failed');
  assert.equal(frame.pid,Number(a.workerMainPid));
  assert.equal(frame.ok,false);
  assert.equal(frame.phase,'failed');
  assert.deepEqual(frame.eventCycle,cycle);
  assert.equal(cycle.ok,false);
  assert.equal(cycle.phase,'official-result-failed');
  assert.equal(cycle.startedAt,a.cycleStartedAt);
  assert.equal(cycle.finishedAt,a.cycleFinishedAt);
  assert.equal(cycle.durationMs,Date.parse(a.cycleFinishedAt)-Date.parse(a.cycleStartedAt));
  const recon=a.kind==='reconciliation-180s';
  const error=recon?'npm run reconcile:fast-results-generation timed out after 180000ms':'candidate deadline heartbeat is not exact: candidate-deadline-capture-failed';
  const code=recon?'SYNC_WORKER_COMMAND_TIMEOUT':'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT';
  const timeout=recon?180000:null;
  assert.deepEqual([frame.error,frame.errorCode,frame.timeoutMs,cycle.error,cycle.errorCode,cycle.timeoutMs],[error,code,timeout,error,code,timeout]);
  assert.deepEqual(frame.lastError,{at:a.cycleFinishedAt,message:error,code,command:recon?'npm':null,
    args:recon?['run','reconcile:fast-results-generation']:null,timeoutMs:timeout,exitCode:null,signal:recon?'SIGTERM':null});
  if(recon) {
    assert.equal(attemptRaw,null);
  } else {
    assert.equal(typeof attemptRaw,'string');
    assert.equal(sha(attemptRaw),a.attemptSha256);
    const attempt=JSON.parse(attemptRaw);
    assert.equal(attempt.version,'candidate-prospective-capture-attempt-v1');
    // The parent waitForHealthy explicitly asks for its recovery tick. A primary tick cannot establish the cause.
    assert.equal(attempt.attemptKind,'preemptive-recovery');
    assert.deepEqual([attempt.ok,attempt.skipped,attempt.statusAdvanced,attempt.reason,attempt.errorCode,attempt.signal,attempt.exitCode],
      [false,false,false,'candidate-deadline-capture-failed','SYNC_WORKER_COMMAND_TIMEOUT','SIGTERM',null]);
    assert.deepEqual([attempt.terminateGraceMs,attempt.forceSettleMs],[500,500]);
    assert(Number.isSafeInteger(attempt.childExecutionTimeoutMs) && attempt.childExecutionTimeoutMs>=43000 && attempt.childExecutionTimeoutMs<=44000);
    assert.equal(attempt.timeoutMs,attempt.childExecutionTimeoutMs+1000);
    const child='\/opt/node-v22.22.1/bin/node /opt/football-predict/scripts/captureCandidateProspectiveDeadline.cjs --deadline-only';
    assert.equal(attempt.error,child+' timed out after '+attempt.childExecutionTimeoutMs+'ms');
    const start=Date.parse(attempt.startedAt), end=Date.parse(attempt.finishedAt), parentEnd=Date.parse(a.cycleFinishedAt);
    assert.equal(new Date(start).toISOString(),attempt.startedAt);
    assert.equal(new Date(end).toISOString(),attempt.finishedAt);
    assert(start>=Date.parse(a.cycleStartedAt) && end-start>=attempt.childExecutionTimeoutMs && end<=parentEnd && parentEnd-end<=1000,
      'recovery child does not end with this parent failure');
  }
  return a;
}

function collectTimeoutJournal(anchor) {
  const assert=require('node:assert/strict'), cp=require('node:child_process');
  validateTimeoutAnchor(anchor);
  const epoch=raw=>'@'+raw.slice(0,-6)+'.'+raw.slice(-6);
  const output=cp.execFileSync('/usr/bin/journalctl',['--unit=football-sync-worker.service','_PID='+anchor.workerMainPid,
    '_SYSTEMD_INVOCATION_ID='+anchor.invocationId,'_BOOT_ID='+anchor.bootId,'--since='+epoch(anchor.journalStartUs),
    '--until='+epoch(anchor.journalEndUs),'--no-pager','--output=json','--lines=1025',
    '--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_BOOT_ID'],
    {encoding:'utf8',timeout:8000,maxBuffer:2*1024*1024});
  const rows=output.trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.length,anchor.journalRows,'complete unambiguous journal frame required');
  return rows;
}


function packTimeoutJournal(rows) {
  const assert=require('node:assert/strict');
  assert(rows.length>=2 && rows.length<=1024);
  const names=['_SYSTEMD_UNIT','_PID','_BOOT_ID','_SYSTEMD_INVOCATION_ID'];
  const source=Object.fromEntries(names.map(key=>[key,rows[0][key]]));
  const lines=rows.map(row=>{
    for(const key of names) assert.equal(row[key],source[key],'journal source changed within frame');
    return [row.__REALTIME_TIMESTAMP,row.__CURSOR,row.MESSAGE];
  });
  const messageSha256=require('node:crypto').createHash('sha256').update(lines.map(line=>line[2]).join('\n')).digest('hex');
  return {source,lines,rowCount:rows.length,messageSha256};
}

function unpackTimeoutJournal(packet) {
  const assert=require('node:assert/strict');
  assert.deepEqual(Object.keys(packet).sort(),['lines','messageSha256','rowCount','source']);
  assert.deepEqual(Object.keys(packet.source).sort(),['_BOOT_ID','_PID','_SYSTEMD_INVOCATION_ID','_SYSTEMD_UNIT']);
  assert(Array.isArray(packet.lines) && packet.lines.length>=2 && packet.lines.length<=1024);
  assert.equal(packet.rowCount,packet.lines.length);
  assert.equal(require('node:crypto').createHash('sha256').update(packet.lines.map(line=>line[2]).join('\n')).digest('hex'),packet.messageSha256);
  return packet.lines.map(line=>{
    assert(Array.isArray(line) && line.length===3);
    return {...packet.source,__REALTIME_TIMESTAMP:line[0],__CURSOR:line[1],MESSAGE:line[2]};
  });
}

function currentTimeoutAnchor(original,cycle,rows,attempt) {
  const sha=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  return {...original,cycleStartedAt:cycle.startedAt,cycleFinishedAt:cycle.finishedAt,
    journalStartUs:rows[0].__REALTIME_TIMESTAMP,journalEndUs:rows.at(-1).__REALTIME_TIMESTAMP,
    journalStartCursor:rows[0].__CURSOR,journalEndCursor:rows.at(-1).__CURSOR,journalRows:rows.length,
    journalMessageSha256:sha(rows.map(row=>row.MESSAGE).join('\n')),originalRecoveryAttempt:attempt,
    attemptSha256:attempt===null?null:sha(attempt)};
}

function timeoutIncidentProof(auth,worker,journal,attempt) {
  const assert=require('node:assert/strict'), a=validateTimeoutAnchor(auth.incident);
  assert.equal(worker.serviceAfter.MainPID,a.workerMainPid);
  assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),a.workerStartedAt);
  assert.equal(worker.processMatches,true);
  assert.deepEqual(Object.keys(journal).sort(),['original','repeated']);
  const original=unpackTimeoutJournal(journal.original);
  verifyTimeoutFrame(a,original,a.originalRecoveryAttempt);
  const cycle=worker.status.lastCycle;
  const same=cycle.startedAt===a.cycleStartedAt && cycle.finishedAt===a.cycleFinishedAt;
  if(same) {
    assert.equal(journal.repeated,null);
    assert.equal(attempt,a.originalRecoveryAttempt);
    assert.deepEqual(JSON.parse(original.map(r=>r.MESSAGE).join('\n')).lastCycle,cycle);
    return a;
  }
  assert(Date.parse(cycle.startedAt)>=Date.parse(a.cycleFinishedAt),'cycle regressed');
  const repeated=unpackTimeoutJournal(journal.repeated);
  const latest=currentTimeoutAnchor(a,cycle,repeated,attempt);
  assert(BigInt(latest.journalStartUs)>BigInt(a.journalEndUs));
  verifyTimeoutFrame(latest,repeated,attempt);
  assert.deepEqual(JSON.parse(repeated.map(r=>r.MESSAGE).join('\n')).lastCycle,cycle);
  return latest;
}

function readCurrentTimeoutJournal(anchor,worker) {
  const assert=require('node:assert/strict'),cp=require('node:child_process');
  const original=collectTimeoutJournal(anchor), cycle=worker.status.lastCycle;
  if(cycle.startedAt===anchor.cycleStartedAt && cycle.finishedAt===anchor.cycleFinishedAt)
    return {original:packTimeoutJournal(original),repeated:null};
  assert(Date.parse(cycle.startedAt)>=Date.parse(anchor.cycleFinishedAt));
  const end=Date.parse(cycle.finishedAt), asEpoch=ms=>'@'+(ms/1000).toFixed(3);
  const text=cp.execFileSync('/usr/bin/journalctl',['--unit=football-sync-worker.service','_PID='+anchor.workerMainPid,
    '_SYSTEMD_INVOCATION_ID='+anchor.invocationId,'_BOOT_ID='+anchor.bootId,'--since='+asEpoch(end),'--until='+asEpoch(end+5000),
    '--no-pager','--output=json','--lines=2049','--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_BOOT_ID'],
    {encoding:'utf8',timeout:8000,maxBuffer:2*1024*1024});
  const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line));
  assert(rows.length<2049,'journal location window truncated');
  const matches=[];
  let start=-1;
  for(let i=0;i<rows.length;i++) {
    if(rows[i].MESSAGE==='{') start=i;
    if(rows[i].MESSAGE!=='}' || start<0) continue;
    const frameRows=rows.slice(start,i+1);
    start=-1;
    const frame=JSON.parse(frameRows.map(r=>r.MESSAGE).join('\n'));
    if(frame.type==='sync-worker-failed' && frame.lastCycle?.finishedAt===cycle.finishedAt && frame.lastCycle?.startedAt===cycle.startedAt)
      matches.push(frameRows);
  }
  assert.equal(matches.length,1,'one complete current failed worker frame required');
  return {original:packTimeoutJournal(original),repeated:packTimeoutJournal(matches[0])};
}

function readTimeoutAttempt(anchor) {
  if(anchor.kind==='reconciliation-180s') return null;
  const fs=require('node:fs'), assert=require('node:assert/strict');
  const dir='/var/lib/football-predict', file=dir+'/candidate-prospective-capture-attempt-status.json';
  assert.equal(fs.realpathSync(dir),dir);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const before=fs.fstatSync(fd);
    assert(before.isFile() && before.nlink===1 && before.size>0 && before.size<=16384);
    const raw=fs.readFileSync(fd), after=fs.fstatSync(fd), name=fs.lstatSync(file);
    for(const key of ['dev','ino','size','mtimeMs','ctimeMs','nlink']) {
      assert.equal(before[key],after[key]); assert.equal(after[key],name[key]);
    }
    assert.equal(raw.length,before.size);
    return new (require('node:util').TextDecoder)('utf-8',{fatal:true}).decode(raw);
  } finally {fs.closeSync(fd);}
}
module.exports={validateTimeoutAnchor,verifyTimeoutFrame,packTimeoutJournal,unpackTimeoutJournal,currentTimeoutAnchor,timeoutIncidentProof,collectTimeoutJournal,readCurrentTimeoutJournal,readTimeoutAttempt};

