"""Synthetic parser/transport contract tests only; no SSH or business samples."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import types
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('history_remote', ROOT / 'scripts/historyRegressionRemote.py')
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)
VERIFY_SPEC=importlib.util.spec_from_file_location('form_verify',ROOT/'scripts/verifyHistoryFormSupplement.py')
form_verify=importlib.util.module_from_spec(VERIFY_SPEC);VERIFY_SPEC.loader.exec_module(form_verify)


class RemoteExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        # O_NOFOLLOW is a production Linux requirement. Synthetic Windows
        # parser tests use regular files created privately by this test.
        self.no_follow = mock.patch.object(remote.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True)
        self.no_follow.start()
        self.addCleanup(self.no_follow.stop)

    def stream(self, raw, chunk=65536, entry=None):
        file = self.root / 'sample.json'
        file.write_bytes(raw)
        entry = entry or {'bytes': len(raw), 'sha256': remote.sha(raw)}
        with mock.patch.object(remote, 'READ_CHUNK', chunk):
            return list(remote.Stream(str(file), entry).items())

    def test_chunk_boundaries_numbers_utf8_and_empty_arrays(self):
        raw = b'{"metadata":12345e-8,"other":[true,false,null,12.345,-6.2e+12,"\xe4\xb8\xad\xe6\x96\x87"],"rows":[],"tail":1234}'
        expected = json.loads(raw)['other']
        for chunk in range(1, 49):
            with self.subTest(chunk=chunk):
                self.assertEqual([row[2] for row in self.stream(raw, chunk)], expected)

    def test_duplicate_keys_at_every_depth_are_rejected(self):
        for raw in [b'{"x":1,"x":2}', b'[{"a":1,"a":2}]', b'{"rows":[{"a":{"b":1,"b":2}}]}']:
            with self.subTest(raw=raw), self.assertRaisesRegex(AssertionError, 'JSON_DUPLICATE_KEY'):
                self.stream(raw, 3)

    def test_invalid_or_nonfinite_json_rejected(self):
        invalid = [b'[01]', b'[1e]', b'[1,]', b'{"rows":[],}', b'[1]garbage', b'[NaN]', b'[Infinity]', b'[1e999]', b'["\xff"]', '[1,\u00a02]'.encode()]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises((AssertionError, UnicodeError)):
                self.stream(raw, 2)

    def test_hash_and_item_bounds(self):
        raw = b'[123]'
        with self.assertRaisesRegex(AssertionError, 'SOURCE_HASH'):
            self.stream(raw, entry={'bytes': len(raw), 'sha256': '0'*64})
        with mock.patch.object(remote, 'MAX_ITEM_BYTES', 16), self.assertRaisesRegex(AssertionError, 'ITEM_BOUND'):
            self.stream(b'["' + b'x'*30 + b'"]', chunk=4)

    def registry(self):
        return {'version':'sporttery-collector-trust-registry-v1', 'keys':[
            {'keyId':'synthetic', 'algorithm':'Ed25519', 'publicKeyPem':'-----BEGIN PUBLIC KEY-----\nsynthetic-only\n-----END PUBLIC KEY-----\n',
             'fingerprint':'a'*64, 'independenceDomain':'synthetic-domain', 'enabled':True, 'unrequested':'not exported'}]}

    def test_registry_whitelist_and_private_key_rejection(self):
        projected = remote.public_registry(remote.encoded(self.registry()))
        self.assertNotIn('unrequested', projected['keys'][0])
        bad = self.registry()
        bad['unexpected'] = '-----BEGIN PRIVATE KEY-----'
        with self.assertRaisesRegex(AssertionError, 'PRIVATE_KEY_FORBIDDEN'):
            remote.public_registry(remote.encoded(bad))
        duplicate = self.registry()
        duplicate['keys'] *= 2
        with self.assertRaisesRegex(AssertionError, 'REGISTRY_INVALID'):
            remote.public_registry(remote.encoded(duplicate))

    def test_projection_is_bounded_and_records_omissions(self):
        row = {'sourceMatchId':'7', 'decisionSnapshot':{'version':remote.DECISION_VERSION,
            'markets':{'HAD':{'provenance':'x'*20000}}, 'dataQuality':'z'*20000},
            'probabilityModel':{'version':'test','scoreDistribution':['x'*10000]*10},
            'featureSnapshot':{'modelInputs':{'usageSummary':'x'*30000,'elo':{'rating':1500}}}, 'notAllowed':'secret-like synthetic text'}
        projected = remote.project_snapshot(row, 3)
        self.assertLessEqual(len(remote.encoded(projected)), remote.SNAPSHOT_HARD_BYTES)
        self.assertEqual(projected['inputFileRowIndex'], 3)
        self.assertEqual(projected['decisionSnapshot']['markets'], row['decisionSnapshot']['markets'])
        self.assertNotIn('omitted', projected['decisionSnapshot'])
        self.assertNotIn('probabilityModel', projected)
        self.assertEqual(projected['featureProjectionAudit']['groups']['usageSummary']['status'], 'export-omitted')
        self.assertTrue(projected['featureProjectionAudit']['groups']['usageSummary']['sourceNonNull'])
        self.assertEqual(projected['featureProjectionAudit']['groups']['elo']['status'], 'retained')
        self.assertEqual(projected['featureProjectionAudit']['groups']['weather']['status'], 'source-absent')
        self.assertNotIn('notAllowed', projected)
        self.assertEqual(projected['originalObjectCanonicalSha256'], remote.sha(remote.encoded(row)))

    def test_typical_five_kib_inputs_retained_and_large_decision_not_dropped(self):
        inputs = {'usageSummary':'s'*4800,'elo':{'homeRating':1540},'form':{'home':0.6},'weather':None}
        row = {'decisionSnapshot':{'version':remote.DECISION_VERSION,'markets':{'HAD':{'proof':'d'*14500}}},
            'featureSnapshot':{'modelInputs':inputs,'hash':'test-binding'}}
        projected = remote.project_snapshot(row, 2)
        self.assertEqual(projected['featureSnapshot']['modelInputs'], inputs)
        self.assertEqual(projected['featureProjectionAudit']['groups']['weather']['status'], 'source-null')
        row['decisionSnapshot']['markets']['HAD']['proof'] = 'd'*26555
        projected = remote.project_snapshot(row, 2)
        self.assertEqual(projected['decisionSnapshot']['markets'], row['decisionSnapshot']['markets'])
        self.assertEqual(projected['featureProjectionAudit']['groups']['usageSummary']['status'], 'export-omitted')
        self.assertEqual(projected['featureSnapshot']['modelInputs']['elo'], inputs['elo'])

    def test_oversized_decision_fails_export_instead_of_losing_evidence(self):
        with self.assertRaisesRegex(AssertionError, 'PROJECTED_ROW_BOUND'):
            remote.project_snapshot({'decisionSnapshot':{'markets':{'proof':'x'*40000}}}, 0)

    def test_model_input_cap_preserves_source_availability_for_each_key(self):
        inputs = {name:'x'*1000 for name in remote.MODEL_INPUT_KEYS}
        projected,audit = remote.project_model_inputs(inputs)
        self.assertLessEqual(len(remote.encoded(projected)), remote.MODEL_INPUT_BYTES)
        self.assertTrue(all(group['sourcePresent'] and group['sourceNonNull'] for group in audit['groups'].values()))
        self.assertTrue(any(group['status']=='export-omitted' for group in audit['groups'].values()))

    def fixture(self, feature_snapshot=None):
        match = {'id':'sporttery_7','sourceMatchId':'7','kickoffTime':'2026-09-02T12:00:00Z','status':'FINISHED','scoreHome':1,'scoreAway':0}
        snapshot = {'sourceMatchId':'7','capturedAt':'2026-09-02T10:00:00Z','phase':'pre-match','decisionSnapshot':{
            'version':remote.DECISION_VERSION,'capturedAt':'2026-09-02T10:00:00Z','cutoffTime':'2026-09-02T11:30:00Z'}}
        if feature_snapshot is not None:snapshot['featureSnapshot']=feature_snapshot
        contents = {'matches-history.json':remote.encoded([match]), 'prediction-snapshots.json':remote.encoded({'publicReferenceLedger':[{'version':'synthetic'}],'rows':[snapshot]})}
        files = [{'path':name,'bytes':len(raw),'sha256':remote.sha(raw),'rows':1,'core':True} for name,raw in contents.items()]
        projection = {'schemaVersion':1,'sourceCycleId':'synthetic-cycle','coreFiles':list(contents),'files':files}
        manifest_hash = remote.sha(remote.encoded(projection))
        generation = 'g-' + manifest_hash
        manifest = {**projection,'generationId':generation,'manifestHash':manifest_hash}
        pointer = {'generationId':generation,'manifestHash':manifest_hash,'sourceCycleId':'synthetic-cycle'}
        base = self.root / 'generations' / generation
        base.mkdir(parents=True)
        (self.root / 'current.json').write_bytes(remote.encoded(pointer))
        (base / 'manifest.json').write_bytes(remote.encoded(manifest))
        for name, raw in contents.items(): (base / name).write_bytes(raw)
        registry_path = self.root / 'registry.json'
        registry_path.write_bytes(remote.encoded(self.registry()))
        return generation, registry_path

    def test_synthetic_export_whitelist_generation_and_registry(self):
        generation, registry = self.fixture()
        output = io.StringIO()
        with mock.patch.multiple(remote, ROOT=str(self.root), GENERATION=generation, REGISTRY=str(registry)), contextlib.redirect_stdout(output):
            remote.run()
        result = json.loads(output.getvalue())
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['snapshotArrayCounts'], {'otherArrays':1,'rows':1})
        self.assertTrue(result['collectorTrustRegistryEvidence']['stableBeforeAfter'])
        self.assertEqual(result['collectorTrustRegistryEvidence']['fileSha256'], remote.sha(registry.read_bytes()))

    def test_generation_change_blocks_emission(self):
        generation, registry = self.fixture()
        original = remote.small
        calls = 0
        def changed(path, limit=262144):
            nonlocal calls
            data = original(path, limit)
            if str(path).endswith('/current.json'):
                calls += 1
                if calls > 1: return data+b' '
            return data
        output = io.StringIO()
        with mock.patch.multiple(remote, ROOT=str(self.root), GENERATION=generation, REGISTRY=str(registry)), mock.patch.object(remote,'small',changed), contextlib.redirect_stdout(output):
            with self.assertRaisesRegex(AssertionError, 'GENERATION_CHANGED'): remote.run()
        self.assertEqual(output.getvalue(), '')

    def test_failure_receipt_redaction_and_python_hash_domain(self):
        script = "const assert=require('node:assert/strict'); const {failureReceipt}=require('./scripts/captureHistoryRegression.cjs'); const a=failureReceipt({status:1,stdout:Buffer.from(JSON.stringify({ok:false,code:'OUTPUT_BOUND',errorClass:'AssertionError'}))}); assert.equal(a.code,'OUTPUT_BOUND'); const b=failureReceipt({status:1,stdout:JSON.stringify({ok:false,code:'SECRET ABC',errorClass:'sensitive'})}); assert.equal(b.code,'REMOTE_EXIT'); assert.equal(b.errorClass,null); assert.equal(failureReceipt({status:124,stdout:''}).code,'REMOTE_TIMEOUT'); process.stdout.write(JSON.stringify({x:1.0}));"
        result = subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,check=True)
        self.assertNotEqual(remote.encoded({'x':1.0}), result.stdout)
        self.assertEqual(json.loads(remote.encoded({'x':1.0})), json.loads(result.stdout))

    def test_form_focus_arguments_reject_unknown_or_combined_modes(self):
        self.assertIsNone(remote.feature_focus_argument([]))
        self.assertEqual(remote.feature_focus_argument(['--feature-focus=form']), 'form')
        for args in [['--feature-focus=xg'], ['--feature-focus', 'form'], ['--feature-focus=form', '--offset=50'], ['--feature-focus=form', '--feature-focus=form']]:
            with self.subTest(args=args), self.assertRaisesRegex(AssertionError, 'EXPORT_MODE_NOT_ALLOWED'):
                remote.feature_focus_argument(args)
        with self.assertRaisesRegex(AssertionError, 'EXPORT_MODE_NOT_ALLOWED'): remote.run('xg')

    def test_default_export_is_byte_identical_to_reviewed_original_with_fixed_clock(self):
        original_source=subprocess.run(['git','show','c2f9be1bc1ae2b902e5bb4f15d161f3fff35f734:scripts/historyRegressionRemote.py'],cwd=ROOT,capture_output=True,check=True).stdout
        original=types.ModuleType('original_history_exporter');exec(compile(original_source,'original_history_exporter','exec'),original.__dict__)
        generation,registry=self.fixture({'hash':'binding','modelInputs':{'form':{'rating':1.0},'elo':{'rating':1500}}})
        outputs=[]
        for module in [original,remote]:
            output=io.StringIO()
            with mock.patch.multiple(module,ROOT=str(self.root),GENERATION=generation,REGISTRY=str(registry)),mock.patch.object(module,'utc',return_value='2026-10-02T15:00:00+00:00'),contextlib.redirect_stdout(output):module.run()
            outputs.append(output.getvalue())
        self.assertEqual(outputs[0],outputs[1])

    def test_form_focus_keeps_complete_hash_binding_without_probabilities_or_unrequested_fields(self):
        row={'decisionSnapshot':{'version':remote.DECISION_VERSION,'sourceCycleId':'cycle','probabilities':{'HAD':{'1':0.5}},'scoreHome':3},
             'featureSnapshot':{'hash':'binding','modelInputs':{'form':{'home':1.0,'history':['a']*300},'weather':{'unrequested':'no'}}},
             'scoreHome':3,'privateMetadata':'synthetic excluded value'}
        projected=remote.project_form_snapshot(row,42)
        self.assertEqual(projected['form'],row['featureSnapshot']['modelInputs']['form'])
        self.assertEqual(projected['inputFileRowIndex'],42)
        self.assertEqual(projected['originalObjectCanonicalSha256'],remote.sha(remote.encoded(row)))
        self.assertEqual(projected['sourceModelInputsCanonicalSha256'],remote.sha(remote.encoded(row['featureSnapshot']['modelInputs'])))
        self.assertEqual(projected['formAudit']['canonicalSha256'],remote.sha(remote.encoded(projected['form'])))
        self.assertEqual(projected['formAudit']['canonicalBytes'],len(remote.encoded(projected['form'])))
        self.assertNotIn('probabilities',projected['decisionBinding'])
        self.assertNotIn('scoreHome',projected)
        self.assertNotIn('weather',projected)
        self.assertFalse(projected['candidateEligible'])
        self.assertTrue(projected['supplementOnly'])

    def test_form_focus_exact_byte_limit_and_overflow(self):
        for size in [4096,4097]:
            value='x'*(size-2)
            projected=remote.project_form_snapshot({'decisionSnapshot':{},'featureSnapshot':{'modelInputs':{'form':value}}},0)
            self.assertEqual(projected['formAudit']['canonicalBytes'],size)
            self.assertEqual(projected['formAudit']['canonicalSha256'],remote.sha(remote.encoded(value)))
            self.assertEqual(projected['formAudit']['status'],'retained' if size==4096 else 'export-omitted')
            self.assertEqual(projected['form'],value if size==4096 else None)

    def test_form_focus_source_absent_and_null_are_distinct(self):
        for inputs,status in [({},'source-absent'),({'form':None},'source-null')]:
            row=remote.project_form_snapshot({'featureSnapshot':{'modelInputs':inputs}},0)
            self.assertEqual(row['formAudit']['status'],status)
            self.assertEqual(row['formAudit']['sourcePresent'],'form' in inputs)
            self.assertFalse(row['formAudit']['sourceNonNull'])

    def test_form_focus_export_same_source_and_selection_as_default(self):
        form={'rating':1.0,'evidence':['比赛']*250}
        generation,registry=self.fixture({'hash':'binding','modelInputs':{'form':form}})
        docs=[]
        with mock.patch.multiple(remote,ROOT=str(self.root),GENERATION=generation,REGISTRY=str(registry)):
            for mode in [None,'form']:
                output=io.StringIO()
                with contextlib.redirect_stdout(output):remote.run(mode)
                docs.append(json.loads(output.getvalue()))
        before,after=docs
        self.assertEqual(before['version'],'bounded-online-history-export-v1')
        self.assertNotIn('featureFocus',before)
        self.assertEqual(after['version'],'bounded-online-history-form-supplement-v1')
        for name in ['publication','files','manifestFileSha256','pointerSha256','selection','counts','snapshotArrayCounts']:
            self.assertEqual(before[name],after[name],name)
        self.assertEqual([r['matchId'] for r in before['rows']],[r['matchId'] for r in after['rows']])
        self.assertEqual(before['rows'][0]['snapshot']['originalObjectCanonicalSha256'],after['rows'][0]['snapshot']['originalObjectCanonicalSha256'])
        self.assertEqual(after['rows'][0]['snapshot']['form'],form)
        self.assertNotIn('scoreHome',after['rows'][0]['match'])
        self.assertFalse(after['candidateEligible'])
        self.assertLessEqual(len(remote.encoded(after)),remote.MAX_OUTPUT_BYTES)

    def test_form_focus_still_fails_generation_race_and_output_bound(self):
        generation,registry=self.fixture({'modelInputs':{'form':{'x':1}}})
        original=remote.small;calls=0
        def changed(path,limit=262144):
            nonlocal calls
            data=original(path,limit)
            if str(path).endswith('/current.json'):
                calls+=1
                if calls>1:return data+b' '
            return data
        with mock.patch.multiple(remote,ROOT=str(self.root),GENERATION=generation,REGISTRY=str(registry)),mock.patch.object(remote,'small',changed):
            with self.assertRaisesRegex(AssertionError,'GENERATION_CHANGED'):remote.run('form')
        with mock.patch.multiple(remote,ROOT=str(self.root),GENERATION=generation,REGISTRY=str(registry),MAX_OUTPUT_BYTES=128):
            with self.assertRaisesRegex(AssertionError,'OUTPUT_BOUND'):remote.run('form')

    def test_form_focus_wrapper_rejects_invalid_mode_and_existing_output_before_ssh(self):
        output=self.root/'already-there.json';output.write_text('unchanged')
        script="const a=require('node:assert/strict'),p=require('node:path'),{capture}=require('./scripts/captureHistoryRegression.cjs'); a.throws(()=>capture({programFile:'invalid',outputFile:'invalid',featureFocus:'xg'}),/EXPORT_MODE_NOT_ALLOWED/); a.throws(()=>capture({programFile:p.resolve('scripts/historyRegressionRemote.py'),outputFile:process.argv[1],featureFocus:'form'}),/OUTPUT_EXISTS/);"
        subprocess.run(['node','-e',script,str(output)],cwd=ROOT,capture_output=True,check=True)
        self.assertEqual(output.read_text(),'unchanged')

    def form_pair(self):
        inputs={name:'x'*1000 for name in remote.MODEL_INPUT_KEYS}
        inputs['form']={'rating':1.0,'evidence':'比赛'*500}
        generation,registry=self.fixture({'hash':'binding','modelInputs':inputs})
        docs=[]
        with mock.patch.multiple(remote,ROOT=str(self.root),GENERATION=generation,REGISTRY=str(registry)):
            for mode in [None,'form']:
                output=io.StringIO()
                with contextlib.redirect_stdout(output):remote.run(mode)
                docs.append(json.loads(output.getvalue()))
        return docs

    def rehash(self,document):
        document['rowsCanonicalSha256']=remote.sha(remote.encoded(document['rows']))

    def test_form_supplement_independent_join_recovers_only_committed_form(self):
        before,after=self.form_pair()
        self.assertEqual(before['rows'][0]['snapshot']['featureProjectionAudit']['groups']['form']['status'],'export-omitted')
        summary,details=form_verify.verify_documents(before,after)
        self.assertEqual(summary['recoveredOmitted'],1)
        self.assertEqual(details[0]['canonicalBytes'],after['rows'][0]['snapshot']['formAudit']['canonicalBytes'])
        self.assertFalse(details[0]['candidateEligible'])

    def test_form_supplement_rejects_changed_value_and_original_snapshot_hash(self):
        before,after=self.form_pair()
        changed=copy.deepcopy(after);changed['rows'][0]['snapshot']['form']['rating']=3.0;self.rehash(changed)
        with self.assertRaisesRegex(ValueError,'FORM_VALUE_HASH'):form_verify.verify_documents(before,changed)
        changed=copy.deepcopy(after);changed['rows'][0]['snapshot']['originalObjectCanonicalSha256']='0'*64;self.rehash(changed)
        with self.assertRaisesRegex(ValueError,'SNAPSHOT_BINDING'):form_verify.verify_documents(before,changed)

    def test_form_supplement_rejects_changed_generation_cohort_or_qualification(self):
        before,after=self.form_pair()
        changed=copy.deepcopy(after);changed['publication']['generationId']='g-'+'0'*64
        with self.assertRaisesRegex(ValueError,'SOURCE_BINDING_publication'):form_verify.verify_documents(before,changed)
        changed=copy.deepcopy(after);changed['rows'][0]['matchId']='8';self.rehash(changed)
        with self.assertRaisesRegex(ValueError,'COHORT_ORDER'):form_verify.verify_documents(before,changed)
        changed=copy.deepcopy(after);changed['candidateEligible']=True
        with self.assertRaisesRegex(ValueError,'SUPPLEMENT_QUALIFICATION'):form_verify.verify_documents(before,changed)

    def test_form_supplement_receipt_raw_binding_and_no_overwrite(self):
        before,after=self.form_pair()
        files=[]
        for index,document in enumerate([before,after]):
            file=self.root/f'capture-{index}.json';raw=remote.encoded(document)
            pathlib.Path(str(file)+'.remote-response.json').write_bytes(raw)
            transport={'sourceHost':'134.175.132.183','pinnedSshFingerprint':form_verify.PIN,'responseByteSha256':remote.sha(raw),
                       'exporterSha256':remote.sha((ROOT/'scripts/historyRegressionRemote.py').read_bytes())}
            file.write_bytes(remote.encoded({**document,'transport':transport}));files.append(file)
        receipt=self.root/'receipt.json'
        result=form_verify.verify(*files,receipt)
        self.assertEqual(result['summary']['recoveredOmitted'],1)
        self.assertFalse(result['candidateEligible'])
        with self.assertRaisesRegex(ValueError,'OUTPUT_EXISTS'):form_verify.verify(*files,receipt)
        pathlib.Path(str(files[1])+'.remote-response.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'RESPONSE_HASH'):form_verify.load_capture(files[1])


if __name__ == '__main__': unittest.main()
