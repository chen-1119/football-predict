"""Offline audit of already captured online evidence; no remote execution/writes."""
import json, hashlib, pathlib, collections
BASE = pathlib.Path(__file__).resolve().parent
ROOT = BASE.parents[1]
paths = [ROOT / 'outputs/history-regression-20261002/online-sample-v3.json',
 pathlib.Path('C:/Users/86188/Documents/football/.codex/worktrees/05-history-regression/outputs/history-regression-20261002/online-sample-v2.json')]
def encoded(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False).encode('utf8')
retained = {}; files = []; omitted = []
for file in paths:
    raw=file.read_bytes(); capture=json.loads(raw); counts=collections.Counter(); sizes=[]
    for row in capture['rows']:
        snapshot=row.get('snapshot') or {}; feature=snapshot.get('featureSnapshot') or {}; inputs=feature.get('modelInputs') or {}
        form=inputs.get('form'); audit=((snapshot.get('featureProjectionAudit') or {}).get('groups') or {}).get('form') or {}
        counts[audit.get('status') or ('retained-unclassified' if form is not None else 'not-exported')]+=1
        if isinstance(form, dict) and form.get('omitted'):
            sizes.append(form.get('bytes')); omitted.append({'file':str(file),'matchId':row['matchId'],'formCanonicalSha256':form.get('canonicalSha256'),'bytes':form.get('bytes')})
        elif form is not None:
            retained[hashlib.sha256(encoded(form)).hexdigest()]={'file':str(file),'matchId':row['matchId']}
    files.append({'file':str(file),'sha256':hashlib.sha256(raw).hexdigest(),'generationId':capture['publication']['generationId'],
                  'capturedAt':capture['completedAt'],'sourceFiles':capture['files'],'exporterSha256':capture['transport']['exporterSha256'],
                  'rows':len(capture['rows']),'formStates':dict(counts),
                  'omittedBytes':{'min':min(sizes) if sizes else None,'max':max(sizes) if sizes else None,
                                  'total':sum(sizes),'over8192':sum(n>8192 for n in sizes),'over1024':sum(n>1024 for n in sizes)}})
matches=[{**row,'existingRetainedEvidence':retained[row['formCanonicalSha256']]} for row in omitted if row['formCanonicalSha256'] in retained]
out={'version':'existing-online-form-export-audit-v1','productionWrites':False,'remoteCalls':0,'files':files,
     'alreadyRetainedCanonicalMatches':matches,'newlyRecoveredRows':0,
     'conclusion':'Current exporter has no CLI/env pagination or field-selection controls. PAGE_SIZE is output hash metadata only. Per-row MODEL_INPUT_BYTES and trim thresholds apply before pagination, so re-running unchanged exporter cannot restore omitted form.'}
(BASE / 'release-readiness-form-export-audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'files':files,'alreadyRetainedCanonicalMatchCount':len(matches),'newlyRecoveredRows':0},ensure_ascii=False,indent=2))
