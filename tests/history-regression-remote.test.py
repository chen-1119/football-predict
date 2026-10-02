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
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('history_remote', ROOT / 'scripts/historyRegressionRemote.py')
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


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

    def fixture(self):
        match = {'id':'sporttery_7','sourceMatchId':'7','kickoffTime':'2026-09-02T12:00:00Z','status':'FINISHED','scoreHome':1,'scoreAway':0}
        snapshot = {'sourceMatchId':'7','capturedAt':'2026-09-02T10:00:00Z','phase':'pre-match','decisionSnapshot':{
            'version':remote.DECISION_VERSION,'capturedAt':'2026-09-02T10:00:00Z','cutoffTime':'2026-09-02T11:30:00Z'}}
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


if __name__ == '__main__': unittest.main()
