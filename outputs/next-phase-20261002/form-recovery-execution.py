"""Record the completed single read-only run; this script makes no remote calls."""
import pathlib,json,hashlib,datetime
base=pathlib.Path(__file__).resolve().parent;root=base.parents[1]
sha=lambda data:hashlib.sha256(data).hexdigest()
supplement=json.loads((base/'form-supplement.json.remote-response.json').read_bytes())
capture=json.loads((base/'form-supplement.json').read_bytes())
receipt=json.loads((base/'form-recovery-receipt.json').read_bytes())
expected={
 'outputs/history-regression-20261002/online-sample-v3.json':'151a20c0678b89ec41d0555f06149be75182beba0dbc17cd4a1b5a76435470e1',
 'outputs/history-regression-20261002/admission-v3.json':'f6438a625a8bd48505a6e12f08c0e6fac6dd4a4363bace896c49cd498448e287',
 'outputs/history-regression-20261002/report/summary.json':'2d5412b2836fc699c469fa42eccca2d8ec69672cc4e7a3eea7c0326ddd4c6262',
}
unchanged=[]
for name,expected_sha in expected.items():
 actual=sha((root/name).read_bytes());assert actual==expected_sha,name
 unchanged.append({'path':name,'sha256':actual,'unchanged':True})
files=[]
for name in ['form-supplement.json','form-supplement.json.remote-response.json','form-recovery-receipt.json','form-supplement-local-verification.json']:
 raw=(base/name).read_bytes();files.append({'path':name,'sha256':sha(raw),'bytes':len(raw)})
result={'version':'history-form-recovery-execution-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'remoteInvocations':1,'readOnly':True,'productionWrites':False,'nodeVersion':'v22.22.1',
 'remoteStartedAt':supplement['observedAt'],'remoteCompletedAt':supplement['completedAt'],'receivedAt':capture['transport']['receivedAt'],
 'durationSeconds':(datetime.datetime.fromisoformat(supplement['completedAt'])-datetime.datetime.fromisoformat(supplement['observedAt'])).total_seconds(),
 'exporterSha256':capture['transport']['exporterSha256'],'summary':receipt['summary'],
 'formValuesBefore':24,'formValuesAfter':379,'cohortRows':432,'candidateEligible':False,'modelPromoted':False,
 'oldInputs':unchanged,'files':files,
 'interpretation':'Frozen form values recovered from the same immutable online source; not a new live data-source connection, validated field availability time, or prediction accuracy increase.'}
output=base/'form-recovery-execution.json'
with output.open('x',encoding='utf8') as file:json.dump(result,file,ensure_ascii=False,indent=2);file.write('\n')
print(json.dumps({'ok':True,'summary':result['summary'],'oldInputsUnchanged':len(unchanged),'remoteInvocations':1}))
