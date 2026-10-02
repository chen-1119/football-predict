"""Bounded read-only source diagnostic. No app imports, env reads or production writes."""
import os,stat,json,hashlib,datetime,subprocess,re
ROOT='/var/lib/football-predict'
names=['sync-worker-status.json','sporttery-relay-fast-lane.json','sporttery-relay-snapshot.json','sporttery-relay-collector-state.json']
def sha(raw):return hashlib.sha256(raw).hexdigest()
def pick(row,keys):return {name:row.get(name) for name in keys.split()} if isinstance(row,dict) else None
def clean(text):
    value=str(text)
    value=re.sub(r'(?i)(bearer\s+|(?:token|password|cookie|secret|authorization)\s*[=:]\s*)[^\s,;]+',r'\1[REDACTED]',value)
    return value[:1200]
def projection(name,body):
    if name=='sync-worker-status.json':
        result=pick(body,'state running checkedAt startedAt lastSuccessAt nextWakeAt lastCycleDurationMs phase')
        result['lastError']=pick(body.get('lastError'),'at code message timeoutMs')
        result['lastCycle']=pick(body.get('lastCycle'),'ok phase startedAt finishedAt error errorCode durationMs')
        return result
    result=pick(body,'version source capturedAt receivedAt sourceCycleId sourceCycleKind mergeCreatedAt maxAgeMinutes')
    result['summary']=body.get('summary')
    result['producer']=pick(body.get('producer'),'fastResultLane probeMode companionMode resultFingerprint')
    result['endpoints']=[]
    for endpoint in body.get('endpoints',[])[:50]:
        commitment=(endpoint.get('collectorAttestation') or endpoint.get('attestation') or {}).get('commitment') or {}
        result['endpoints'].append({**pick(endpoint,'method endpoint role ok status fetchedAt requestedAt receivedAt sourceCycleId'),
          'collectorProvenance':pick(endpoint.get('collectorProvenance'),'sourceCycleId requestedAt receivedAt providerObservedAt'),
          'commitmentTimes':pick(commitment,'collectorCycleId providerObservedAt requestedAt receivedAt'),
          'response':pick(endpoint.get('response'),'httpStatus rawSha256 httpDate'),
          'payloadCanonicalSha256':sha(json.dumps(endpoint.get('payload'),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()),
          'error':clean(endpoint.get('error')) if endpoint.get('error') else None})
    for field in ['currentLaneState','fullCircuit','lastFailure']:
        if field in body:result[field]=body[field]
    return result
report={'version':'bounded-source-state-read-v1','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionWrites':False,'files':[]}
for name in names:
    file=ROOT+'/'+name
    if not os.path.exists(file):report['files'].append({'path':file,'exists':False});continue
    before=os.lstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_size>16*1024*1024:raise ValueError('FILE_BOUND')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:raw=stream.read(16*1024*1024+1);after=os.fstat(stream.fileno())
    if before.st_ino!=after.st_ino or before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns:raise ValueError('FILE_CHANGED')
    report['files'].append({'path':file,'exists':True,'bytes':len(raw),'sha256':sha(raw),'projection':projection(name,json.loads(raw))})
command=['journalctl','-u','football-sync-worker','--since','2026-10-02 15:00:00 UTC','-n','120','--no-pager','-o','cat',
 '--grep','matches-current.json|sync-meta|invalid SP|missing official|result-only|schedule-only|stale unsettled|validation|validate:data|exited with|must contain|must mirror|odds-history']
logs=subprocess.run(command,capture_output=True,timeout=15,check=False)
report['journal']={'exit':logs.returncode,'bytes':len(logs.stdout),'sha256':sha(logs.stdout),'lines':[clean(line) for line in logs.stdout.decode('utf8','replace').splitlines()[:120]],'truncated':len(logs.stdout)>262144}
report['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
out=json.dumps(report,ensure_ascii=False)
if len(out.encode())>1024*1024:raise ValueError('OUTPUT_BOUND')
print(out)
