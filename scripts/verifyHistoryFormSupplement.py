"""Join a reviewed online supplement to original raw evidence; never edit inputs."""
import sys, pathlib, json, hashlib, collections, importlib.util, datetime
ROOT=pathlib.Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('form_export_contract',ROOT/'scripts/historyRegressionRemote.py')
remote=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(remote)
PIN='SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to'
def check(condition,code):
    if not condition:raise ValueError(code)
def load_capture(file):
    path=pathlib.Path(file);capture=remote.strict_json(path.read_bytes())
    raw_path=pathlib.Path(str(path)+'.remote-response.json');raw=raw_path.read_bytes()
    check(capture['transport']['sourceHost']=='134.175.132.183' and capture['transport']['pinnedSshFingerprint']==PIN,'TRANSPORT_BINDING')
    check(remote.sha(raw)==capture['transport']['responseByteSha256'],'RESPONSE_HASH')
    document=remote.strict_json(raw)
    check({k:v for k,v in capture.items() if k!='transport'}==document,'CAPTURE_RAW_MISMATCH')
    return document,{'capture':str(path),'captureSha256':remote.sha(path.read_bytes()),'rawResponse':str(raw_path),
        'rawResponseSha256':remote.sha(raw),'exporterSha256':capture['transport']['exporterSha256']}
def verify_documents(base,supplement):
    check(base['version']=='bounded-online-history-export-v1','BASE_VERSION')
    check(supplement['version']=='bounded-online-history-form-supplement-v1' and supplement.get('featureFocus')=='form','SUPPLEMENT_VERSION')
    check(supplement.get('supplementOnly') is True and supplement.get('candidateEligible') is False,'SUPPLEMENT_QUALIFICATION')
    for document in [base,supplement]:
        check(document.get('ok') is True and document.get('productionWrites') is False and document.get('sameSnapshot') is True,'READ_ONLY_BINDING')
        check(document.get('source')=='online-immutable-active-generation','SOURCE_KIND')
        check(remote.sha(remote.encoded(document['rows']))==document['rowsCanonicalSha256'],'ROWS_HASH')
    for name in ['publication','files','manifestFileSha256','pointerSha256','selection','counts','snapshotArrayCounts']:
        check(base[name]==supplement[name],'SOURCE_BINDING_'+name)
    check([row['matchId'] for row in base['rows']]==[row['matchId'] for row in supplement['rows']],'COHORT_ORDER')
    check(len({row['matchId'] for row in supplement['rows']})==len(supplement['rows']),'DUPLICATE_EVENT')
    summary=collections.Counter();details=[]
    for before,after in zip(base['rows'],supplement['rows']):
        check(before['market']==after['market'] and before['snapshotSelectionAudit']==after['snapshotSelectionAudit'] and before['conflictingMatchRows']==after['conflictingMatchRows'],'SELECTION_BINDING')
        expected_match=remote.pick(before['match'],'id sourceMatchId kickoffTime inputFileRowIndex originalObjectCanonicalSha256'.split())
        check(after['match']==expected_match,'MATCH_BINDING')
        original=before['snapshot'];snapshot=after['snapshot']
        if original is None:
            check(snapshot is None,'MISSING_SNAPSHOT_CHANGED');summary['snapshotMissing']+=1;continue
        check(isinstance(snapshot,dict) and snapshot.get('supplementOnly') is True and snapshot.get('candidateEligible') is False,'ROW_QUALIFICATION')
        for field in ['inputFileRowIndex','originalObjectCanonicalSha256']:
            check(snapshot[field]==original[field],'SNAPSHOT_BINDING_'+field)
        check(snapshot['decisionBinding']==remote.pick(original['decisionSnapshot'],remote.FORM_BINDING_KEYS),'DECISION_BINDING')
        feature=original.get('featureSnapshot')
        check(snapshot['featureBinding']==remote.pick(feature,'version capturedAt modelGeneratedAt sourceCycleId modelVersion hash cutoffTime sourceMatchId kickoffTime'.split()),'FEATURE_BINDING')
        check(snapshot['sourceModelInputsCanonicalSha256']==original['featureProjectionAudit']['sourceCanonicalSha256'],'INPUT_OBJECT_BINDING')
        old_audit=original['featureProjectionAudit']['groups']['form'];audit=snapshot['formAudit']
        check(audit['sourcePresent']==old_audit['sourcePresent'] and audit['sourceNonNull']==old_audit['sourceNonNull'],'SOURCE_PRESENCE')
        check(audit['maximumBytes']==4096,'FIELD_LIMIT_CHANGED')
        old_form=(feature.get('modelInputs') or {}).get('form') if feature else None
        if old_audit['status']=='export-omitted':
            check(audit['canonicalSha256']==old_form['canonicalSha256'] and audit['canonicalBytes']==old_form['bytes'],'OMITTED_COMMITMENT')
        elif old_audit['status']=='retained':
            check(audit['canonicalSha256']==remote.sha(remote.encoded(old_form)) and audit['canonicalBytes']==len(remote.encoded(old_form)),'RETAINED_COMMITMENT')
        else:
            check(audit['status']==old_audit['status'] and snapshot['form'] is None,'MISSING_FORM_CHANGED')
        if audit['status']=='retained':
            raw=remote.encoded(snapshot['form'])
            check(len(raw)<=4096 and len(raw)==audit['canonicalBytes'] and remote.sha(raw)==audit['canonicalSha256'],'FORM_VALUE_HASH')
            if old_audit['status']=='retained':check(snapshot['form']==old_form,'RETAINED_VALUE_CHANGED')
            summary['recoveredOmitted' if old_audit['status']=='export-omitted' else 'retainedCrossChecked']+=1
        elif audit['status']=='export-omitted':
            check(snapshot['form'] is None and audit['canonicalBytes']>4096,'INVALID_OMISSION');summary['stillOverLimit']+=1
        else:summary[audit['status']]+=1
        details.append({'matchId':before['matchId'],'inputFileRowIndex':snapshot['inputFileRowIndex'],
            'originalObjectCanonicalSha256':snapshot['originalObjectCanonicalSha256'],'previousStatus':old_audit['status'],
            'status':audit['status'],'canonicalSha256':audit['canonicalSha256'],'canonicalBytes':audit['canonicalBytes'],
            'candidateEligible':False})
    return {'rows':len(base['rows']),**dict(summary)},details
def verify(base_file,supplement_file,receipt_file):
    output=pathlib.Path(receipt_file);check(not output.exists(),'OUTPUT_EXISTS')
    before,base_evidence=load_capture(base_file);after,supplement_evidence=load_capture(supplement_file)
    check(supplement_evidence['exporterSha256']==remote.sha((ROOT/'scripts/historyRegressionRemote.py').read_bytes()),'REVIEWED_EXPORTER_HASH')
    summary,details=verify_documents(before,after)
    receipt={'version':'history-form-recovery-receipt-v1','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'ok':True,'productionWrites':False,'supplementOnly':True,'candidateEligible':False,'modelPromoted':False,
        'sourcePublication':before['publication'],'sourceFiles':before['files'],'inputs':[base_evidence,supplement_evidence],
        'summary':summary,'records':details,
        'limitations':['Recovered frozen values do not establish field-level provider/received/available clocks.',
            'Original captures, admissions, scores and frozen predictions are not rewritten.']}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x',encoding='utf8') as file:json.dump(receipt,file,ensure_ascii=False,indent=2);file.write('\n')
    return receipt
if __name__=='__main__':
    if len(sys.argv)!=4:raise SystemExit('Usage: python -B scripts/verifyHistoryFormSupplement.py BASE.json SUPPLEMENT.json NEW_RECEIPT.json')
    result=verify(*sys.argv[1:]);print(json.dumps({'ok':result['ok'],'summary':result['summary'],'candidateEligible':False}))
