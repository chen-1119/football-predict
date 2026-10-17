'use strict';
// Used only inside the installed root release broker. No HTTP route is added.
const { createHash } = require('node:crypto');
const reports = require('./researchReportStore.cjs');
const runtime = require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const policy = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code, retryWriteAutomatically: false }); };
const MAX_REQUEST_BYTES = 1024 * 1024;
function decodeRequest(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_REQUEST_BYTES) fail('RESEARCH_REQUEST_BOUND');
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) fail('RESEARCH_REQUEST_UTF8');
  let r; try { r = JSON.parse(text); } catch { fail('RESEARCH_REQUEST_JSON'); }
  if (!r || r.version !== 'research-broker-request-v1' || !['archive', 'archive-read', 'publish', 'publication-read','revision-publish','revision-read','combo-revision-publish','combo-revision-read','publication-retry'].includes(r.action)) fail('RESEARCH_REQUEST_ACTION');
  if(r.action==='publication-retry'){
    const input=require('./researchPublicationRetry.cjs').original(r);
    decodeRequest(Buffer.from(r.originalRequestJson));
    if(input.action!=='publish')fail('RESEARCH_REQUEST_ACTION');
    return r;
  }
  const fields = r.action === 'publication-read' ? 'action,draftHash,recordKey,version'
    : r.action === 'archive-read' ? 'action,businessDate,reportKind,sha256,version'
      : r.action === 'archive' || r.action.includes('revision-') ? 'action,json,sha256,version' : 'action,draftHash,json,sha256,version';
  if (Object.keys(r).sort().join(',') !== fields) fail('RESEARCH_REQUEST_FIELDS');
  if (r.action === 'archive-read') {
    reports.reportKey(r.businessDate,r.reportKind);
    if (!/^[a-f0-9]{64}$/.test(r.sha256 || '')) fail('RESEARCH_REQUEST_HASH');
    return r;
  }
  if (r.action === 'publication-read') {
    if (!/^[a-f0-9]{64}$/.test(r.draftHash || '')
      || !/^reviewed-analysis-\d{4}-\d{2}-\d{2}-batch-[a-f0-9]{64}$/.test(r.recordKey || '')
      || !r.recordKey.endsWith('-' + r.draftHash)) fail('RESEARCH_REQUEST_IDENTITY');
    return r;
  }
  if (typeof r.json !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256 || '') || sha(r.json) !== r.sha256) fail('RESEARCH_REQUEST_HASH');
  if (r.action.includes('revision-')) {
    let request; try { request=JSON.parse(r.json); } catch { fail('RESEARCH_DRAFT_JSON'); }
    (r.action.startsWith('combo-')?require('./researchComboRevision.cjs'):require('./researchReviewedRevision.cjs')).validate(request);
  } else if (r.action === 'archive') reports.prepare(Buffer.from(r.json), r.sha256);
  else {
    let draft; try { draft = JSON.parse(r.json); } catch { fail('RESEARCH_DRAFT_JSON'); }
    if (draft?.version !== 3 || !/^[a-f0-9]{64}$/.test(r.draftHash || '') || policy.hash(draft) !== r.draftHash) fail('RESEARCH_DRAFT_HASH');
  }
  return r;
}
function createResearchWriteService({ pool, runExclusive } = {}) {
  if (!pool?.connect || typeof runExclusive !== 'function') fail('RESEARCH_BROKER_REQUIRED');
  const store = reports.createResearchReportStore({ pool, runExclusive });
  const revisions = require('./researchReviewedRevision.cjs').createRevisionStore({ pool, runExclusive });
  const combos = require('./researchComboRevision.cjs').createComboRevisionStore({ pool, runExclusive });
  async function observe(key, draftHash) {
    const c = await pool.connect(); let broken;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL statement_timeout='8000ms'");
      await c.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const rows = (await c.query(`SELECT artifact_key,payload_sha256 FROM football.private_model_artifacts WHERE artifact_key=ANY($1) LIMIT 3`, [[key, key + '-ack']])).rows;
      const record = rows.find(r => r.artifact_key === key), ack = rows.find(r => r.artifact_key === key + '-ack');
      let result;
      if (!record) result = { state: ack ? 'orphan-ack-unverified' : 'not-observed', recordKey: key, verified: false, retryWriteAutomatically: false };
      else if (!ack) result = { state: 'record-present-ack-missing', recordKey: key, verified: false, retryWriteAutomatically: false };
      else {
        const at = (await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
        const replay = await runtime.readPublication(c, key, new Date(at).toISOString());
        if (replay.v.record.draftHash !== draftHash || policy.hash(replay.v.draft) !== draftHash) fail('RESEARCH_PUBLICATION_BINDING');
        result = { state: 'committed-and-acknowledged', recordKey: key, verified: true,
          payloadSha256: record.payload_sha256, ackSha256: ack.payload_sha256,
          recordHash: replay.v.record.contentHash, records: replay.v.record.records,
          frozenAt: replay.v.record.originalFrozenAt, publishedAt: replay.v.record.createdAt,
          modelAdoption: false, formalEligible: false, retryWriteAutomatically: false };
      }
      await c.query('COMMIT'); return result;
    } catch (e) { try { await c.query('ROLLBACK'); } catch (rollback) { broken = rollback; } throw e; }
    finally { c.release(broken); }
  }
  async function execute(raw) {
    const input=decodeRequest(raw),retry=input.action==='publication-retry';
    const r=retry?decodeRequest(Buffer.from(input.originalRequestJson)):input;
    if(r.action==='combo-revision-publish')return combos.publish(JSON.parse(r.json));
    if(r.action==='combo-revision-read')return runExclusive(()=>combos.read(JSON.parse(r.json)));
    if(r.action==='revision-publish')return revisions.publish(JSON.parse(r.json));
    if(r.action==='revision-read')return runExclusive(()=>revisions.read(JSON.parse(r.json)));
    if (r.action === 'archive') return store.archive(Buffer.from(r.json), r.sha256);
    const result=await runExclusive(async () => {
      if (r.action === 'archive-read') return store.read(r.businessDate,r.reportKind,r.sha256);
      if (r.action === 'publication-read') return observe(r.recordKey, r.draftHash);
      const draft = JSON.parse(r.json), key = 'reviewed-analysis-' + draft.businessDate + '-batch-' + r.draftHash;
      const before = await observe(key, r.draftHash);
      if (before.state !== 'not-observed') return { ...before, submitted: false };
      // The original publisher revalidates DB clock, ordered identities, signed
      // quotes and sale cutoffs. Its original second-transaction ACK is retained.
      await runtime.publish(draft, { pool, expectedDraftHash: r.draftHash });
      const after = await observe(key, r.draftHash);
      if (!after.verified) fail('RESEARCH_COMMITTED_READBACK_UNVERIFIED');
      return { ...after, submitted: true };
    });
    return retry?{...result,explicitRetry:true,originalRequestSha256:input.originalRequestSha256}:result;
  }
  return { execute };
}
module.exports = { MAX_REQUEST_BYTES, decodeRequest, createResearchWriteService };
