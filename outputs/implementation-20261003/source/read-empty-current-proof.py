"""Only two signed current-market endpoint records and public registry; read-only."""
import os,stat,json,hashlib,datetime
def read(path,limit):
    before=os.lstat(path)
    assert stat.S_ISREG(before.st_mode) and before.st_size<=limit,'FILE_BOUND'
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as file:raw=file.read(limit+1);after=os.fstat(file.fileno())
    assert len(raw)<=limit and (before.st_ino,before.st_mtime_ns,before.st_size)==(after.st_ino,after.st_mtime_ns,after.st_size),'FILE_CHANGED'
    return raw
source='/var/lib/football-predict/sporttery-relay-snapshot.json'
raw=read(source,16*1024*1024);snapshot=json.loads(raw)
registry_path='/opt/football-predict/deploy/light-server/collector-trust-registry.json'
registry_raw=read(registry_path,262144);registry=json.loads(registry_raw)
assert b'PRIVATE KEY' not in registry_raw.upper(),'PRIVATE_KEY_FORBIDDEN'
selected=[row for row in snapshot['endpoints'] if row.get('method') in ['current','calculator']]
assert len(selected)==2,'ENDPOINT_BOUND'
result={'version':'signed-empty-current-proof-read-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionWrites':False,
 'source':{'path':source,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'capturedAt':snapshot.get('capturedAt'),'sourceCycleId':snapshot.get('sourceCycleId')},
 'endpoints':selected,'registry':registry,'registrySha256':hashlib.sha256(registry_raw).hexdigest()}
out=json.dumps(result,ensure_ascii=False)
assert len(out.encode())<=524288 and 'PRIVATE KEY' not in out.upper(),'OUTPUT_BOUND'
print(out)
