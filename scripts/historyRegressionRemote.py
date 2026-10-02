"""Read-only bounded production projection. Fixed window chosen before outcomes.
No live app imports, database access, uploads or writes. Only immutable files.
"""
import os, stat, json, hashlib, datetime, collections, codecs, re, math
ROOT = '/var/lib/football-predict/data-generations'
GENERATION = 'g-79b3788d9a6029e3dccaeb3366d04ef0da49a8c01d24457492fe0c370a867273'
START = '2026-09-01T00:00:00+08:00'
END = '2026-10-01T00:00:00+08:00'
LIMIT, PAGE_SIZE = 500, 50
MAX_OUTPUT_BYTES, MAX_FILE_BYTES, MAX_ITEM_BYTES = 10*1024*1024, 900*1024*1024, 16*1024*1024
READ_CHUNK = 65536
SNAPSHOT_SOFT_BYTES, SNAPSHOT_HARD_BYTES, MODEL_INPUT_BYTES = 22000, 32768, 8192
MODEL_INPUT_KEYS = 'usageSummary oneXTwoFinal market poisson elo form leaguePrior lambdaBlend worldCupPrior dataGaps lineup injuries weather xg scheduleDensity'.split()
REGISTRY = '/opt/football-predict/deploy/light-server/collector-trust-registry.json'
# Verified against src/services/decisionSnapshot.cjs, not inferred from data.
DECISION_VERSION = 'candidate-decision-snapshot-v2'
SAFE_CODES = set('CONTROL_BOUND CONTROL_RACE SOURCE_BOUND SOURCE_RACE FILE_BOUND ITEM_BOUND JSON_SYNTAX JSON_DUPLICATE_KEY JSON_INCOMPLETE JSON_TRAILING_DATA SOURCE_HASH GENERATION_CHANGED MANIFEST_IDENTITY HISTORY_SHAPE PROJECTED_ROW_BOUND OUTPUT_BOUND READ_ONLY_EXPORT_FAILED JSON_NON_FINITE JSON_KEY_BOUND MANIFEST_SHAPE POINTER_SHAPE SOURCE_PATH REGISTRY_INVALID REGISTRY_CHANGED PRIVATE_KEY_FORBIDDEN MANIFEST_HASH'.split())

def unique_object(pairs):
    result={}
    for key,value in pairs:
        assert key not in result,'JSON_DUPLICATE_KEY'
        assert len(key.encode('utf8'))<=256,'JSON_KEY_BOUND'
        result[key]=value
    return result
def reject_constant(value): raise AssertionError('JSON_NON_FINITE')
def finite_float(value):
    number=float(value)
    assert math.isfinite(number),'JSON_NON_FINITE'
    return number
def strict_json(data):
    return json.loads(data,object_pairs_hook=unique_object,parse_constant=reject_constant,parse_float=finite_float)

def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def instant(value):
    try:
        dt=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
        return dt.timestamp() if dt.tzinfo is not None else None
    except (ValueError,TypeError,AttributeError): return None
def sha(value): return hashlib.sha256(value).hexdigest()
def encoded(value): return json.dumps(value,ensure_ascii=False,separators=(',',':'),sort_keys=True,allow_nan=False).encode('utf8')
def pick(value,keys): return {k:value.get(k) for k in keys} if isinstance(value,dict) else None
def bounded(value,limit):
    raw=encoded(value)
    return value if len(raw)<=limit else {'omitted':'field-over-byte-limit','bytes':len(raw),'canonicalSha256':sha(raw)}

def project_model_inputs(source):
    is_object=isinstance(source,dict);projected={};groups={}
    for name in MODEL_INPUT_KEYS:
        present=is_object and name in source
        nonnull=present and source[name] is not None
        value=bounded(source[name],MODEL_INPUT_BYTES) if present else None
        if present:projected[name]=value
        groups[name]={'sourcePresent':present,'sourceNonNull':nonnull,
                      'status':'source-absent' if not present else 'source-null' if not nonnull else 'export-omitted' if isinstance(value,dict) and value.get('omitted') else 'retained'}
    if len(encoded(projected))>MODEL_INPUT_BYTES:
        for name,value in list(projected.items()):
            if not (isinstance(value,dict) and value.get('omitted')):projected[name]=bounded(value,1024)
            if isinstance(projected[name],dict) and projected[name].get('omitted'):groups[name]['status']='export-omitted'
    for name in sorted(projected,key=lambda key:-len(encoded(projected[key]))):
        if len(encoded(projected))<=MODEL_INPUT_BYTES:break
        value=projected[name]
        if value is not None and not (isinstance(value,dict) and value.get('omitted')):
            projected[name]=bounded(value,0);groups[name]['status']='export-omitted'
    assert len(encoded(projected))<=MODEL_INPUT_BYTES,'PROJECTED_ROW_BOUND'
    return projected if is_object else None, {'sourceModelInputsPresent':is_object,
        'sourceCanonicalSha256':sha(encoded(source)) if is_object else None,
        'unrequestedKeyCount':len(set(source)-set(MODEL_INPUT_KEYS)) if is_object else 0,'groups':groups}

def trim_input_diagnostics(snapshot,all_large=False):
    inputs=snapshot.get('featureSnapshot',{}).get('modelInputs') if isinstance(snapshot.get('featureSnapshot'),dict) else None
    if not isinstance(inputs,dict):return
    names=list(inputs) if all_large else ['usageSummary']
    for name in names:
        if name not in inputs or inputs[name] is None:continue
        value=inputs[name]
        if isinstance(value,dict) and value.get('omitted'):continue
        compact=bounded(value,1024 if all_large else 0)
        if isinstance(compact,dict) and compact.get('omitted'):
            inputs[name]=compact
            snapshot['featureProjectionAudit']['groups'][name]['status']='export-omitted'

def project_snapshot(row,index):
    wrapper_keys='id snapshotId matchId sourceMatchId capturedAt firstSeenAt phase decisionId decisionRevision policyVersion probabilityModelVersion featureSnapshotHash sourceCycleId kickoffTime cutoffTime modelGeneratedAt'.split()
    decision_keys='version capturedAt decisionAt sourceCycleId sourceMatchId matchId kickoffTime cutoffTime policyVersion promptVersion modelVersion calibrationVersion policyHash featureSnapshotHash sourceTimestamps clockAudit markets probabilities lambdas dataQuality selectedCandidateKey exposure'.split()
    projected={k:bounded(row.get(k),512) for k in wrapper_keys}
    decision=pick(row.get('decisionSnapshot'),decision_keys)
    for field in ['dataQuality','lambdas','exposure']:decision[field]=bounded(decision.get(field),1024)
    projected['decisionSnapshot']=decision
    source_feature=row.get('featureSnapshot')
    feature=pick(source_feature,'version capturedAt modelGeneratedAt sourceCycleId modelVersion hash cutoffTime sourceMatchId kickoffTime'.split())
    model_inputs,input_audit=project_model_inputs(source_feature.get('modelInputs') if isinstance(source_feature,dict) else None)
    projected['featureProjectionAudit']={**input_audit,'sourceFeaturePresent':isinstance(source_feature,dict)}
    if feature is not None:
        feature={name:bounded(value,512) for name,value in feature.items()}
        feature['modelInputs']=model_inputs
        projected['featureSnapshot']=feature
        projected['featureSnapshotProjection']=True
    projected['inputFileRowIndex']=index;projected['originalObjectCanonicalSha256']=sha(encoded(row))
    # Preserve signed decision evidence even when it exceeds the diagnostic
    # soft limit. Omit optional inputs explicitly, never the complete decision.
    if len(encoded(projected))>SNAPSHOT_SOFT_BYTES:trim_input_diagnostics(projected)
    if len(encoded(projected))>SNAPSHOT_HARD_BYTES:trim_input_diagnostics(projected,all_large=True)
    assert len(encoded(projected))<=SNAPSHOT_HARD_BYTES,'PROJECTED_ROW_BOUND'
    return projected
def identity(s): return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def small(path,limit=262144):
    s=os.lstat(path)
    assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_size<=limit,'CONTROL_BOUND'
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        assert identity(s)==identity(os.fstat(fd)),'CONTROL_RACE'
        chunks=[];size=0
        while size<=limit:
            part=os.read(fd,min(65536,limit+1-size))
            if not part:break
            chunks.append(part);size+=len(part)
        data=b''.join(chunks)
        assert len(data)==s.st_size and identity(s)==identity(os.fstat(fd))==identity(os.lstat(path)),'CONTROL_RACE'
        return data
    finally: os.close(fd)

def public_registry(data):
    assert b'PRIVATE KEY' not in data.upper(),'PRIVATE_KEY_FORBIDDEN'
    registry=strict_json(data)
    assert isinstance(registry,dict) and registry.get('version')=='sporttery-collector-trust-registry-v1','REGISTRY_INVALID'
    keys=registry.get('keys')
    assert isinstance(keys,list) and 0<len(keys)<=64,'REGISTRY_INVALID'
    seen=set();projected=[]
    for row in keys:
        assert isinstance(row,dict),'REGISTRY_INVALID'
        key=row.get('keyId');pem=row.get('publicKeyPem')
        assert isinstance(key,str) and 0<len(key)<=128 and key not in seen,'REGISTRY_INVALID'
        assert row.get('algorithm')=='Ed25519' and isinstance(pem,str) and len(pem)<=4096 and pem.startswith('-----BEGIN PUBLIC KEY-----'),'REGISTRY_INVALID'
        assert re.fullmatch('[a-f0-9]{64}',str(row.get('fingerprint',''))),'REGISTRY_INVALID'
        assert type(row.get('enabled')) is bool,'REGISTRY_INVALID'
        seen.add(key);projected.append(pick(row,['keyId','algorithm','publicKeyPem','fingerprint','independenceDomain','enabled']))
    return {'version':registry['version'],'keys':projected}

class Stream:
    """Strict JSON page reader, one top-level array item at a time."""
    def __init__(self,path,entry):
        self.path=path;self.entry=entry;self.before=os.lstat(path)
        assert stat.S_ISREG(self.before.st_mode) and self.before.st_size==entry['bytes'] and self.before.st_size<=MAX_FILE_BYTES,'SOURCE_BOUND'
        self.f=os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')
        if identity(self.before)!=identity(os.fstat(self.f.fileno())):
            self.f.close();raise AssertionError('SOURCE_RACE')
        self.decoder=codecs.getincrementaldecoder('utf8')('strict')
        self.json=json.JSONDecoder(object_pairs_hook=unique_object,parse_constant=reject_constant,parse_float=finite_float);self.buf='';self.eof=False;self.hash=hashlib.sha256();self.bytes=0
    def more(self):
        b=self.f.read(READ_CHUNK);self.bytes+=len(b);self.hash.update(b)
        assert self.bytes<=MAX_FILE_BYTES,'FILE_BOUND'
        self.buf+=self.decoder.decode(b,final=not b);self.eof=not b
        assert len(self.buf.encode('utf8'))<=MAX_ITEM_BYTES+65536,'ITEM_BOUND'
    def trim(self):
        self.buf=self.buf.lstrip(' \r\n\t')
        while not self.buf and not self.eof:self.more();self.buf=self.buf.lstrip(' \r\n\t')
    def take(self,c):
        self.trim();assert self.buf.startswith(c),'JSON_SYNTAX';self.buf=self.buf[len(c):]
    def value(self):
        self.trim()
        while True:
            try:
                v,end=self.json.raw_decode(self.buf)
            except json.JSONDecodeError:
                assert not self.eof,'JSON_INCOMPLETE';self.more();continue
            # A number at a chunk boundary may continue (12 -> 123 / 12e-3).
            # Require the following delimiter before accepting any scalar.
            if end==len(self.buf) and not self.eof:self.more();continue
            if end<len(self.buf) and self.buf[end] not in ' \r\n\t,:]}':
                assert not self.eof and not any(c in self.buf[end:] for c in ' \r\n\t,:]}'),'JSON_SYNTAX'
                self.more();continue
            assert len(self.buf[:end].encode('utf8'))<=MAX_ITEM_BYTES,'ITEM_BOUND'
            self.buf=self.buf[end:];return v
    def array(self,key):
        self.take('[');self.trim()
        if self.buf.startswith(']'):self.take(']');return
        index=0
        while True:
            yield key,index,self.value();index+=1;self.trim()
            if self.buf.startswith(']'):self.take(']');break
            self.take(',')
    def items(self):
        try:
            self.trim()
            if self.buf.startswith('['):yield from self.array('$')
            else:
                self.take('{');seen=set();self.trim()
                while not self.buf.startswith('}'):
                    key=self.value();assert isinstance(key,str) and key not in seen,'JSON_DUPLICATE_KEY';assert len(key.encode('utf8'))<=256,'JSON_KEY_BOUND';seen.add(key);self.take(':');self.trim()
                    if self.buf.startswith('['):yield from self.array(key)
                    else:self.value()
                    self.trim()
                    if self.buf.startswith('}'):break
                    self.take(',');self.trim();assert not self.buf.startswith('}'),'JSON_SYNTAX'
                self.take('}')
            self.trim();assert self.eof and not self.buf,'JSON_TRAILING_DATA'
            assert self.bytes==self.entry['bytes'] and self.hash.hexdigest()==self.entry['sha256'],'SOURCE_HASH'
            assert identity(self.before)==identity(os.fstat(self.f.fileno()))==identity(os.lstat(self.path)),'SOURCE_RACE'
        finally:self.f.close()

def run():
    began=utc();pointer=small(ROOT+'/current.json');p=strict_json(pointer)
    assert isinstance(p,dict) and isinstance(p.get('sourceCycleId'),str) and re.fullmatch('[a-f0-9]{64}',str(p.get('manifestHash',''))),'POINTER_SHAPE'
    assert p['generationId']==GENERATION,'GENERATION_CHANGED'
    base=ROOT+'/generations/'+GENERATION
    assert os.path.realpath(base)==os.path.abspath(base) and os.path.realpath(ROOT)==os.path.abspath(ROOT),'SOURCE_PATH'
    mb=small(base+'/manifest.json');m=strict_json(mb)
    assert m['generationId']==p['generationId'] and m['manifestHash']==p['manifestHash'] and m['sourceCycleId']==p['sourceCycleId'],'MANIFEST_IDENTITY'
    assert isinstance(m.get('files'),list) and 0<len(m['files'])<=256 and isinstance(m.get('coreFiles'),list),'MANIFEST_SHAPE'
    entries={}
    for e in m['files']:
        assert isinstance(e,dict) and set(e)<=set(['path','sha256','bytes','rows','core']),'MANIFEST_SHAPE'
        name=e.get('path');size=e.get('bytes')
        assert isinstance(name,str) and name not in entries and type(size) is int and 0<=size<=MAX_FILE_BYTES and re.fullmatch('[a-f0-9]{64}',str(e.get('sha256',''))),'MANIFEST_SHAPE'
        assert e.get('rows') is None or type(e['rows']) is int,'MANIFEST_SHAPE'
        entries[name]=e
    # This manifest's value domain is strings, booleans, null and safe integers;
    # its fixed ASCII keys have identical ordering in Python and JS.
    projection=pick(m,['schemaVersion','sourceCycleId','coreFiles','files'])
    assert sha(encoded(projection))==p['manifestHash'] and GENERATION=='g-'+p['manifestHash'],'MANIFEST_HASH'
    rb=small(REGISTRY);registry=public_registry(rb)
    counts=collections.Counter();matches={};conflicts=set()
    history_keys='id sourceMatchId leagueId leagueName homeTeamId awayTeamId homeTeamName awayTeamName kickoffTime businessDate matchDate buyEndTime status scoreHome scoreAway eventVersion resultSource resultObservedAt resultObservationSource resultObservationFallback resultSourceUpdatedAt resultProvenance sourceCycleId sourceObservedAt sourceReceivedAt'.split()
    for key,index,row in Stream(base+'/matches-history.json',entries['matches-history.json']).items():
        assert key=='$' and isinstance(row,dict),'HISTORY_SHAPE'
        counts['historyRows']+=1;t=instant(row.get('kickoffTime'));mid=str(row.get('sourceMatchId') or row.get('id') or '')
        if t is None or not instant(START)<=t<instant(END):counts['outsideWindow']+=1;continue
        if row.get('status')!='FINISHED':counts['notFinished']+=1;continue
        if not mid or len(mid)>256:counts['missingIdentity']+=1;continue
        if mid in matches:
            counts['duplicateMatchRows']+=1
            if any(matches[mid].get(k)!=row.get(k) for k in ['kickoffTime','scoreHome','scoreAway']):conflicts.add(mid)
            continue
        projected=pick(row,history_keys)
        projected['predictionMeta']=pick(row.get('predictionMeta'),['decisionId','decisionRevision','generatedAt','modelVersion','cutoffTime','lockedAt'])
        projected={name:bounded(value,512 if name!='resultProvenance' else 2500) for name,value in projected.items()}
        projected['inputFileRowIndex']=index;projected['originalObjectCanonicalSha256']=sha(encoded(row))
        if len(encoded(projected))>4500:projected['resultProvenance']=bounded(projected.get('resultProvenance'),0)
        assert len(encoded(projected))<=4500,'PROJECTED_ROW_BOUND';matches[mid]=projected
    if type(entries['matches-history.json'].get('rows')) is int:assert counts['historyRows']==entries['matches-history.json']['rows'],'HISTORY_SHAPE'
    counts['distinctSettledInWindow']=len(matches)
    selected=sorted(matches,key=lambda mid:(-instant(matches[mid]['kickoffTime']),mid))[:LIMIT]
    matches={mid:matches[mid] for mid in selected};counts['limitExcluded']=counts['distinctSettledInWindow']-len(matches)
    decision_keys='version capturedAt decisionAt sourceCycleId sourceMatchId matchId kickoffTime cutoffTime policyVersion promptVersion modelVersion calibrationVersion policyHash featureSnapshotHash sourceTimestamps clockAudit markets probabilities lambdas dataQuality selectedCandidateKey exposure'.split()
    wrapper_keys='id snapshotId matchId sourceMatchId capturedAt firstSeenAt phase decisionId decisionRevision policyVersion probabilityModelVersion featureSnapshotHash sourceCycleId kickoffTime cutoffTime modelGeneratedAt'.split()
    best={};snap_counts=collections.Counter();per_match=collections.defaultdict(collections.Counter);sample_keys={}
    for key,index,row in Stream(base+'/prediction-snapshots.json',entries['prediction-snapshots.json']).items():
        snap_counts[key if key=='rows' else 'otherArrays']+=1
        if key!='rows' or not isinstance(row,dict):continue
        if key not in sample_keys:sample_keys[key]=[name for name in wrapper_keys+['decisionSnapshot'] if name in row]
        mid=str(row.get('sourceMatchId') or '')
        if not mid and str(row.get('matchId','')).startswith('sporttery_'):mid=str(row['matchId'])[len('sporttery_'):]
        if mid not in matches:continue
        statrow=per_match[mid];statrow['snapshotsSeen']+=1;d=row.get('decisionSnapshot')
        if not isinstance(d,dict):statrow['missingDecisionSnapshot']+=1;continue
        if row.get('phase')=='review':statrow['reviewPhase']+=1;continue
        at=instant(d.get('capturedAt') or row.get('capturedAt') or row.get('firstSeenAt'))
        cutoff=instant(d.get('cutoffTime'));kickoff=instant(matches[mid]['kickoffTime'])
        if at is None or cutoff is None or at>min(kickoff,cutoff):statrow['postCutoffOrMissingClock']+=1;continue
        statrow['preCutoffDecisions']+=1
        rank=(at,d.get('version')==DECISION_VERSION,-index)
        if mid in best and rank<=best[mid][0]:continue
        best[mid]=(rank,project_snapshot(row,index))
    if type(entries['prediction-snapshots.json'].get('rows')) is int:assert snap_counts['rows']==entries['prediction-snapshots.json']['rows'],'HISTORY_SHAPE'
    rows=[{'matchId':mid,'market':'HAD','match':matches[mid],'snapshot':best.get(mid,(None,None))[1],
           'snapshotSelectionAudit':dict(per_match[mid]),'conflictingMatchRows':mid in conflicts} for mid in selected]
    # Reserve room for the envelope while retaining every chosen match and
    # decision. Availability survives any input truncation in a separate audit.
    if len(encoded(rows))>MAX_OUTPUT_BYTES-524288:
        for row in rows:
            if row['snapshot']:trim_input_diagnostics(row['snapshot'])
    if len(encoded(rows))>MAX_OUTPUT_BYTES-524288:
        for row in rows:
            if row['snapshot']:trim_input_diagnostics(row['snapshot'],all_large=True)
    files=[entries[n] for n in ['matches-history.json','prediction-snapshots.json']]
    assert pointer==small(ROOT+'/current.json') and mb==small(base+'/manifest.json'),'GENERATION_CHANGED'
    assert rb==small(REGISTRY),'REGISTRY_CHANGED'
    pages=[]
    for n in range(0,len(rows),PAGE_SIZE):
        page=rows[n:n+PAGE_SIZE];pages.append({'offset':n,'rows':len(page),'matchIds':[r['matchId'] for r in page],'canonicalSha256':sha(encoded(page))})
    result={'version':'bounded-online-history-export-v1','ok':True,'productionWrites':False,
            'source':'online-immutable-active-generation','observedAt':began,'completedAt':utc(),
            'publication':pick(p,['generationId','manifestHash','sourceCycleId','committedAt']),'pointerSha256':sha(pointer),'manifestFileSha256':sha(mb),'sameSnapshot':True,
            'collectorTrustRegistry':registry,'collectorTrustRegistryEvidence':{'path':REGISTRY,'fileSha256':sha(rb),'bytes':len(rb),'stableBeforeAfter':True,'purpose':'public keys for independent local signature verification'},
            'selection':{'from':START,'until':END,'maxMatches':LIMIT,'pageSize':PAGE_SIZE,'policy':'latest kickoff descending, ID ascending; distinct settled matches; latest pre-cutoff snapshot, no outcome-based filtering'},
            'files':files,'counts':dict(counts),'snapshotArrayCounts':dict(snap_counts),'snapshotFields':sample_keys,
            'pages':pages,'rows':rows,'rowsCanonicalSha256':sha(encoded(rows)),
            'limitations':['Immutable file projection; not a PostgreSQL transaction or reconstruction of the published evaluator event set.',
                            'Object hashes use Python canonical JSON; input file hashes are original bytes.',
                            'Source-absent/source-null and export-omitted inputs are distinct in featureProjectionAudit; no current features or local historical seeds substituted.',
                            'Signed decision evidence is retained; snapshot soft limit trims diagnostics, hard limit or total output overflow fails the entire export without changing the sample.']}
    out=encoded(result);assert len(out)+1<=MAX_OUTPUT_BYTES,'OUTPUT_BOUND';assert b'PRIVATE KEY' not in out.upper(),'PRIVATE_KEY_FORBIDDEN';print(out.decode('utf8'))

if __name__=='__main__':
    try:run()
    except Exception as error:
        print(json.dumps({'ok':False,'productionWrites':False,'errorClass':type(error).__name__,'code':str(error) if str(error) in SAFE_CODES else 'READ_ONLY_EXPORT_FAILED'}))
        raise SystemExit(1)
