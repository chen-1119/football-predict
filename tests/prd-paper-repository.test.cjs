'use strict';
// Synthetic model/event fixtures and a SQL protocol double only. Maker replay
// is a controlled boundary double here; its signature tests run separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const baseline = require('../scripts/zeroMarketResearchBaseline.cjs');
const { MODEL_LEARNING_LEDGER_VERSION, stableStringify } = require('../scripts/modelLearningLedger.cjs');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const hash = v => sha(stableStringify(v));
const copy = v => structuredClone(v);
const seal = body => ({ ...body, contentHash: hash(body) });
const stamp = ms => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const ago = ms => new Date(Date.now() - ms).toISOString();
let makerChecks = 0;
const filename = require.resolve('../scripts/recommendationPlatform/prdPaperRepository.cjs');
const realRequire = createRequire(filename), sandbox = { module: { exports: {} }, Buffer, Date, Set, Map, Object, Array, Number, JSON, BigInt, RegExp };
sandbox.require = path => path.endsWith('/prdPaperRecommendation.cjs') ? {
  verifyPrdPaperRecommendation: value => { makerChecks++; const body = { ...value }; delete body.contentHash;
    return value.status === 'paper-screened' && value.syntheticMakerValid === true && hash(body) === value.contentHash; },
  publicPrdPaperProjection: (value, { storageCommit } = {}) => seal({ version: 'synthetic-paper-public',
    id: value.id, paperPrimary: value.paperPrimary, ...storageCommit, formalEligible: false, productionEligible: false, primary: null, companion: null }),
} : realRequire(path);
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
const repo = sandbox.module.exports;

async function fixture({ eventOffset = false } = {}) {
  const ns = 'synthetic/prd-repository-season-2000', digest = 'c'.repeat(64);
  const entities = ['alpha', 'bravo', 'charlie', 'delta'].map((literalName, i) => ({ literalName, namespace: ns, entityRef: ns + '#research-entity/' + (i + 1) }));
  const rows = [], attack = [3, 2, 1, 1], defense = [1, 0, 0, -1]; let k = 0;
  for (let round = 0; round < 6; round++) for (let h = 0; h < 4; h++) for (let a = 0; a < 4; a++) {
    if (h === a) continue;
    const sourceNominalDate = new Date(Date.UTC(2000, 0, 1) + k * 86400000).toISOString().slice(0, 10);
    rows.push({ sourceRecordRef: ns + '#row/' + (++k), sourceNominalDate,
      homeEntityRef: entities[h].entityRef, awayEntityRef: entities[a].entityRef,
      homeGoals: Math.max(0, attack[h] - defense[a] + round % 3 - 1),
      awayGoals: Math.max(0, attack[a] - defense[h] - round % 3 + 1),
      sourceFormat: 'ordinary-ft', knownAt: ago(3000), neutral: null, historicalAsOf: null, actualEndedAt: null });
  }
  const input = { version: baseline.INPUT_VERSION, researchOnly: true,
    source: { namespace: ns, rawSha256: digest, license: 'CC0-1.0', licenseRawSha256: digest,
      formatEvidenceSha256: digest, observedAt: ago(6000), formatKnownAt: ago(5000), coverageThrough: '2000-03-12', completeCompetitionHistory: false },
    entities, rows, approval: { version: baseline.APPROVAL_VERSION, approved: true, researchOnly: true,
      reviewId: 'synthetic-review', reviewer: 'synthetic-only', reviewedAt: ago(4000),
      scope: 'future-only-source-format-ft', venuePolicy: 'venue-agnostic', sourceNamespace: ns,
      approvedInputHash: null, sourceEntityMapApproved: true, partialCoverageAccepted: true }, config: { iterations: 800 } };
  input.approval.approvedInputHash = baseline.researchInputHash(input);
  const fitted = baseline.fitZeroMarketResearch(input); assert.equal(fitted.status, 'research-fitted', JSON.stringify(fitted.reasons));
  await new Promise(resolve => setTimeout(resolve, 3));
  const artifact = fitted.artifact, future = Date.now() + 86400000;
  const kickoffVersion = eventOffset ? new Date(future + 8 * 3600000).toISOString().replace('Z', '+08:00') : new Date(future).toISOString();
  const event = { sourceEventRef: ns + '#future/a-b', recordedSourceMatchId: 'synthetic-provider-1',
    eventVersion: kickoffVersion, sourceNominalDate: new Date(future).toISOString().slice(0, 10),
    cutoffAt: new Date(future - 3600000).toISOString(), homeTeamId: 'provider-a', awayTeamId: 'provider-b',
    homeEntityRef: entities[0].entityRef, awayEntityRef: entities[1].entityRef,
    observedAt: ago(1000), knownAt: ago(500), status: 'SCHEDULED', saleStatus: 'OPEN', neutral: null, integerHandicap: -1 };
  const approval = { version: baseline.EVENT_APPROVAL_VERSION, approved: true, researchOnly: true,
    reviewId: 'synthetic-event-review', reviewer: 'synthetic-only', reviewedAt: ago(700), inputHash: artifact.inputHash,
    sourceEventRef: event.sourceEventRef, eventVersion: event.eventVersion, cutoffAt: event.cutoffAt,
    orderedTeamIds: [event.homeTeamId, event.awayTeamId], orderedEntityRefs: [event.homeEntityRef, event.awayEntityRef],
    sourceNominalDate: event.sourceNominalDate, sourceTimezoneMappingApproved: true, sourceAliasApproved: true,
    approvedEventHash: baseline.hash(event), eventEvidenceSha256: digest };
  const made = baseline.forecastZeroMarketResearch({ artifact, event, approval }); assert.equal(made.status, 'research-frozen');
  await new Promise(resolve => setTimeout(resolve, 3));
  // Deliberately different: an explicitly reviewed official business day is
  // not a formula derived from the source's nominal fixture day.
  const businessDate = new Date(Date.now()+8*3600000).toISOString().slice(0, 10);
  const forward = repo.buildPrdForwardInput({ artifact, forecast: made.forecast, businessDate });
  // The SQL double explicitly observes an after-opening clock; this is not a
  // claim about production DB time or admission of the synthetic model.
  const storedAt = stamp(Date.now()), nowMs = Math.max(Date.now()+20,Date.parse(businessDate+'T03:00:00Z')+20);
  const body = { version: repo.PAPER_TYPE, status: 'paper-screened', syntheticMakerValid: true,
    id: 'synthetic-paper-1', decisionAt: new Date(nowMs - 10).toISOString(), createdAt: new Date(nowMs - 9).toISOString(),
    cutoffTime: event.cutoffAt, kickoffTime: new Date(future).toISOString(), formalEligible: false, productionEligible: false, primary: null, companion: null,
    markets:{HAD:{quote:{requestedAt:stamp(nowMs-12),receivedAt:stamp(nowMs-11)}}},
    event: { sourceMatchId: event.recordedSourceMatchId, eventVersion: new Date(future).toISOString(), businessDate,
      orderedTeamIds: approval.orderedTeamIds, orderedEntityRefs: approval.orderedEntityRefs,
      sourceEventRef: event.sourceEventRef, sourceNominalDate: event.sourceNominalDate, eventEvidenceSha256: digest }, paperPrimary: null,
    privateInputs: { artifact, forecast: made.forecast, match: { id: 'synthetic-provider-1' }, quoteSnapshot: { synthetic: true, receivedAt: stamp(nowMs - 11) } } };
  const record = seal(body), taskRow = artifactRow(forward, repo.FORWARD_TYPE, repo.forwardInputMetadata(forward), storedAt);
  return { artifact, forward, record, taskRow, task: { artifactHash: taskRow.artifact_hash }, now: stamp(nowMs), nowMs, businessDate };
}
function artifactRow(value, type, metadata, createdAt) {
  const bytes = Buffer.from(stableStringify(value)), meta = stableStringify(metadata);
  return { artifact_hash: sha(bytes), artifact_type: type, media_type: 'application/json', artifact_bytes: bytes,
    byte_length: bytes.length, metadata_json: meta, metadata_hash: sha(meta), created_at: createdAt };
}
function header(row) { const { artifact_bytes, ...rest } = row;
  return { ...rest, actual_byte_length: artifact_bytes.length, metadata_byte_length: Buffer.byteLength(row.metadata_json) }; }
class SqlDouble {
  constructor(f, options = {}) {
    this.rows = new Map([[f.taskRow.artifact_hash, copy(f.taskRow)]]); this.now = f.now;
    this.options = options; this.calls = []; this.commits = 0; this.releases = 0; this.insertions = 0;
  }
  async connect() { return this; }
  release() { this.releases++; }
  async query(sql, values = []) {
    this.calls.push({ sql, values }); const q = sql.replace(/\s+/g, ' ').trim();
    const rows = () => [...this.rows.values()];
    if (q.startsWith('BEGIN')) { this.backup = copy([...this.rows]); return { rows: [] }; }
    if (q === 'COMMIT') {
      this.commits++;
      if (this.options.failCommit === this.commits) throw Object.assign(new Error('Synthetic commit failure'), { code: 'SYNTHETIC_COMMIT_FAILURE' });
      if (this.options.afterCommit) this.options.afterCommit(this);
      return { rows: [] };
    }
    if (q === 'ROLLBACK') { this.rows = new Map(this.backup); return { rows: [] }; }
    if (q === 'SAVEPOINT prd_paper_artifact') { this.saved = copy([...this.rows]); return { rows: [] }; }
    if (q === 'ROLLBACK TO SAVEPOINT prd_paper_artifact') { this.rows = new Map(this.saved); return { rows: [] }; }
    if (q === 'RELEASE SAVEPOINT prd_paper_artifact' || q === 'SET TRANSACTION READ ONLY'
      || q.includes('set_config') || q.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (q.includes('clock_timestamp()')) return { rows: [{ now: this.now }] };
    if (q.includes('learning_ledger_meta')) return { rows: [{ value: this.options.uninitialized ? 'bad-version' : MODEL_LEARNING_LEDGER_VERSION }] };
    if (q.startsWith('INSERT INTO football.learning_model_artifacts')) {
      this.insertions++; const [h, type, media, raw, length, meta, metaHash, at] = values;
      if (this.rows.has(h)) return { rows: [], rowCount: 0 };
      this.rows.set(h, { artifact_hash: h, artifact_type: type, media_type: media, artifact_bytes: Buffer.from(raw), byte_length: length,
        metadata_json: meta, metadata_hash: metaHash, created_at: at });
      if (this.options.afterInsert) this.options.afterInsert(this, type);
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('SELECT') && q.includes('learning_model_artifacts')) {
      let found;
      if (q.includes('WHERE artifact_hash=$1')) found = rows().filter(r => r.artifact_hash === values[0] && r.artifact_type === values[1]);
      else {
        found = rows().filter(r => r.artifact_type === values[0]);
        if (q.includes("modelArtifactHash'=ANY")) found = found.filter(r => values[1].includes(JSON.parse(r.metadata_json).modelArtifactHash)
          && (values[2] === null || JSON.parse(r.metadata_json).businessDate === values[2]));
        else if (q.includes("modelArtifactHash'=$2")) found = found.filter(r => {
          const m = JSON.parse(r.metadata_json); return m.modelArtifactHash === values[1] && m.sourceMatchId === values[2]
            && m.eventVersion === values[3] && m.businessDate === values[4]; });
        else if (q.includes("inputKey'=$2")) found = found.filter(r => JSON.parse(r.metadata_json).inputKey === values[1]);
        else if (q.includes("paperArtifactHash'=$2")) found = found.filter(r => JSON.parse(r.metadata_json).paperArtifactHash === values[1]);
        else if (q.includes("businessDate'=$2")) found = found.filter(r => JSON.parse(r.metadata_json).businessDate === values[1]);
        else throw new Error('Unsupported synthetic artifact selector: ' + q);
      }
      if (q.includes('DISTINCT ON')) {
        const grouped = new Map();
        for (const r of found.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
          const m = JSON.parse(r.metadata_json), key = m.sourceMatchId + '|' + m.eventVersion;
          if (!grouped.has(key)) grouped.set(key, r);
        }
        found = [...grouped.values()];
      }
      const limit = Number(/LIMIT (\d+)/.exec(q)?.[1] || Infinity);
      found = found.slice(0, limit);
      if (!q.startsWith('SELECT *')) {
        const heads = found.map(header);
        return { rows: this.options.headerOverride ? this.options.headerOverride(q, heads, values) : heads };
      }
      return { rows: found.map(copy) };
    }
    throw new Error('Unsupported synthetic SQL: ' + q);
  }
}
const types = db => [...db.rows.values()].map(r => r.artifact_type);
const stored = async (f, options) => { const db = new SqlDouble(f, options);
  const out = await repo.appendPrdPaper(db, { record: f.record, task: f.task, trustRegistry: 'synthetic-trust' }); return { db, out }; };
const base = fixture();

test('new append rejects signed-price boundary clocks from an early cache without consuming the task',async()=>{
  const f=await base,db=new SqlDouble(f),record=copy(f.record);delete record.contentHash;
  const opening=Date.parse(f.businessDate+'T03:00:00Z');
  record.markets.HAD.quote={requestedAt:stamp(opening-1),receivedAt:stamp(opening)};record.contentHash=hash(record);
  await assert.rejects(repo.appendPrdPaper(db,{record,task:f.task}),{code:'PRD_OPENING_WAIT'});
  assert.equal(db.insertions,0);assert.deepEqual(types(db),[repo.FORWARD_TYPE]);
});
test('new append cannot infer missing acquisition clocks from a record creation or upload time',async()=>{
  const f=await base,db=new SqlDouble(f),record=copy(f.record);delete record.contentHash;
  delete record.markets.HAD.quote.requestedAt;record.privateInputs.quoteSnapshot.uploadedAt=f.now;record.contentHash=hash(record);
  await assert.rejects(repo.appendPrdPaper(db,{record,task:f.task}),{code:'PRD_OPENING_WAIT'});assert.equal(db.insertions,0);
});
test('HHAD append checks its current sale-state acquisition as well as calculator acquisition',async()=>{
  const f=await base,db=new SqlDouble(f),record=copy(f.record);delete record.contentHash;
  const fresh=copy(record.markets.HAD.quote),opening=Date.parse(f.businessDate+'T03:00:00Z');
  record.markets={HHAD:{quote:fresh}};record.privateInputs.quoteSnapshot.endpoints=[
    {method:'calculator',page:null,...fresh},{method:'current',page:null,requestedAt:stamp(opening-1),receivedAt:stamp(opening)}];
  record.contentHash=hash(record);
  await assert.rejects(repo.appendPrdPaper(db,{record,task:f.task}),{code:'PRD_OPENING_WAIT'});assert.equal(db.insertions,0);
});

test('empty approval list does not query or write anything', async () => {
  const client = { query: () => { throw new Error('Must not query'); } };
  assert.deepEqual(JSON.parse(JSON.stringify(await repo.readPrdForwardInputs(client))), { tasks: [], blockedCount: 0, truncated: false });
});
test('reads actual independent task bytes with explicit, different official business day', async () => {
  const f = await base, db = new SqlDouble(f);
  const out = await repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash], businessDate: f.businessDate });
  assert.equal(out.tasks.length, 1); assert.equal(out.tasks[0].input.businessDate, f.businessDate);
  assert.notEqual(out.tasks[0].input.businessDate, out.tasks[0].metadata.sourceNominalDate);
  assert.equal(db.insertions, 0);
});
test('missing official business day is rejected instead of inferred from nominal source day', async () => {
  const f = await base;
  assert.throws(() => repo.buildPrdForwardInput({ artifact: f.artifact, forecast: f.forward.forecast }), { code: 'PRD_FORWARD_INVALID' });
});
test('forward registration requires explicit approved hashes and never treats an empty list as activation', async () => {
  const f = await base, db = new SqlDouble(f);
  await assert.rejects(repo.appendPrdForwardInput(db, { input: f.forward }), { code: 'PRD_FORWARD_MODEL_NOT_APPROVED' });
  await assert.rejects(repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: ['0'.repeat(64)] }), { code: 'PRD_FORWARD_MODEL_NOT_APPROVED' });
  assert.equal(db.calls.length, 0);
});
test('forward registration stores exact bytes with real DB clock and a separate postcommit observation', async () => {
  const f = await base, db = new SqlDouble(f); db.rows.clear();
  const out = await repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(out.stored, true); assert.equal(out.inserted, true); assert.equal(out.admitted, true);
  assert.equal(out.createdAt, f.now); assert.equal(out.commitObservedAt, f.now);
  assert.equal(out.formalEligible, false); assert.equal(out.productionEligible, false);
  assert.deepEqual(types(db), [repo.FORWARD_TYPE]); assert.equal(db.commits, 2);
  assert.ok(Buffer.from(db.rows.get(out.artifactHash).artifact_bytes).equals(Buffer.from(stableStringify(f.forward))));
  assert.ok(db.calls.some(c => c.sql === 'SET TRANSACTION READ ONLY'));
});
test('duplicate exact forward registration retains the original created clock and one task', async () => {
  const f = await base, db = new SqlDouble(f);
  const out = await repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(out.inserted, false); assert.equal(out.createdAt, f.taskRow.created_at);
  assert.equal(out.artifactHash, f.task.artifactHash); assert.equal(db.rows.size, 1);
});
test('future forecast availability, strict cutoff and kickoff reject forward registration', async () => {
  const f = await base;
  for (const now of [stamp(Date.parse(f.forward.forecast.forecastCompletedAt) - 1), f.record.cutoffTime, f.record.kickoffTime]) {
    const db = new SqlDouble(f); db.rows.clear(); db.now = now;
    await assert.rejects(repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: [f.artifact.contentHash] }), { code: 'PRD_FORWARD_DEADLINE' });
    assert.equal(db.rows.size, 0);
  }
});
test('a forward COMMIT that completes late preserves the original but reports stored-not-admitted', async () => {
  const f = await base, db = new SqlDouble(f, { afterCommit: db => { if (db.commits === 1) db.now = f.record.cutoffTime; } }); db.rows.clear();
  const out = await repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(out.stored, true); assert.equal(out.admitted, false); assert.equal(out.reason, 'PRD_FORWARD_DEADLINE');
  assert.deepEqual(types(db), [repo.FORWARD_TYPE]);
  const later = await repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(later.tasks.length, 0); assert.equal(later.blockedCount, 1);
});
test('forward postcommit failure does not claim admission or erase the stored original', async () => {
  const f = await base, db = new SqlDouble(f, { failCommit: 2 }); db.rows.clear();
  const out = await repo.appendPrdForwardInput(db, { input: f.forward, approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(out.stored, true); assert.equal(out.admitted, false); assert.equal(out.reason, 'SYNTHETIC_COMMIT_FAILURE');
  assert.equal(db.rows.size, 1);
});
test('two explicit forward tasks exhaust event/model/day quota; a third fresh forecast cannot bypass it', async () => {
  const f = await base, db = new SqlDouble(f); db.rows.clear();
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 3));
    const made = baseline.forecastZeroMarketResearch({ artifact: f.artifact,
      event: f.forward.forecast.event, approval: f.forward.forecast.eventApproval });
    assert.equal(made.status, 'research-frozen');
    const input = repo.buildPrdForwardInput({ artifact: f.artifact, forecast: made.forecast, businessDate: f.businessDate });
    db.now = stamp(Date.now() + 20);
    if (i < 2) assert.equal((await repo.appendPrdForwardInput(db, { input, approvedModelHashes: [f.artifact.contentHash] })).admitted, true);
    else await assert.rejects(repo.appendPrdForwardInput(db, { input, approvedModelHashes: [f.artifact.contentHash] }), { code: 'PRD_FORWARD_EVENT_QUOTA' });
  }
  assert.equal(db.rows.size, 2);
});
test('an approved +08:00 event matches canonical maker metadata and append quota without rewriting the original', async () => {
  const f = await fixture({ eventOffset: true }), bytesBefore = Buffer.from(f.taskRow.artifact_bytes), db = new SqlDouble(f);
  assert.ok(f.forward.forecast.event.eventVersion.endsWith('+08:00'));
  assert.equal(f.taskRow.metadata_json.includes('+08:00'), false);
  assert.equal(JSON.parse(f.taskRow.metadata_json).eventVersion, stamp(Date.parse(f.record.event.eventVersion)));
  const read = await repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash], businessDate: f.businessDate });
  assert.equal(read.tasks.length, 1);
  const out = await repo.appendPrdPaper(db, { record: f.record, task: f.task }); assert.equal(out.acknowledged, true);
  assert.ok(Buffer.from(db.rows.get(f.task.artifactHash).artifact_bytes).equals(bytesBefore));
  const quotaCalls = db.calls.filter(c => c.sql.includes("modelArtifactHash'=$2"));
  assert.ok(quotaCalls.every(c => c.values[3] === stamp(Date.parse(f.record.event.eventVersion))));
  const projected = await repo.readPrdPaperProjection(db, { businessDate: f.businessDate });
  assert.equal(projected.records.length, 1);
});
test('invalid or duplicate approved hashes are rejected', async () => {
  const f = await base, db = new SqlDouble(f);
  await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: ['*'] }), { code: 'PRD_MODEL_ALLOWLIST' });
  await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash, f.artifact.contentHash] }), { code: 'PRD_MODEL_ALLOWLIST' });
});
test('unapproved model never becomes a task and never falls back to old mixed probabilities', async () => {
  const f = await base, db = new SqlDouble(f);
  const out = await repo.readPrdForwardInputs(db, { approvedModelHashes: ['f'.repeat(64)] });
  assert.equal(out.tasks.length, 0); assert.equal(db.insertions, 0);
});
test('raw bytes and metadata conflicts fail instead of silently returning an empty task pool', async () => {
  const f = await base, db = new SqlDouble(f);
  db.rows.get(f.task.artifactHash).artifact_bytes[0] ^= 1;
  await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] }), { code: 'PRD_ARTIFACT_BYTES' });
  const db2 = new SqlDouble(f); db2.rows.get(f.task.artifactHash).metadata_hash = '0'.repeat(64);
  await assert.rejects(repo.readPrdForwardInputs(db2, { approvedModelHashes: [f.artifact.contentHash] }), { code: 'PRD_ARTIFACT_BYTES' });
});
test('bad JSON is an explicit failure, not unavailable data', async () => {
  const f = await base, db = new SqlDouble(f), row = db.rows.get(f.task.artifactHash);
  row.metadata_json = '{broken'; row.metadata_hash = sha(row.metadata_json);
  await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] }), SyntaxError);
});
test('task pool count, individual length and aggregate bytes are bounded before payload reads', async () => {
  const f = await base;
  for (const [heads, code] of [[Array(33).fill(header(f.taskRow)), 'PRD_ARTIFACT_COUNT'],
    [[{ ...header(f.taskRow), byte_length: repo.MAX_BYTES + 1, actual_byte_length: repo.MAX_BYTES + 1 }], 'PRD_ARTIFACT_SIZE'],
    [Array(5).fill({ ...header(f.taskRow), byte_length: repo.MAX_BYTES, actual_byte_length: repo.MAX_BYTES }), 'PRD_ARTIFACT_TOTAL_SIZE']]) {
    const db = new SqlDouble(f, { headerOverride: (q, original) => q.includes("modelArtifactHash'=ANY") ? heads : original });
    await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] }), { code });
    assert.equal(db.calls.some(c => c.sql.startsWith('SELECT *')), false);
  }
});
test('submillisecond future task availability is rejected without a Date.parse truncation', async () => {
  const f = await base, db = new SqlDouble(f), row = db.rows.get(f.task.artifactHash);
  row.created_at = f.now.replace(/000000Z$/, '000001Z');
  await assert.rejects(repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] }), { code: 'PRD_FORWARD_STORAGE_CLOCK' });
});
test('late tasks remain originals but are reported blocked rather than new predictions', async () => {
  const f = await base, db = new SqlDouble(f); db.now = f.record.cutoffTime;
  const out = await repo.readPrdForwardInputs(db, { approvedModelHashes: [f.artifact.contentHash] });
  assert.equal(out.tasks.length, 0); assert.equal(out.blockedCount, 1); assert.equal(db.insertions, 0);
});
test('first paper COMMIT is followed by an independent acknowledgement transaction and public projection', async () => {
  const f = await base, { db, out } = await stored(f);
  assert.equal(out.stored, true); assert.equal(out.inserted, true); assert.equal(out.acknowledged, true);
  assert.equal(db.commits, 2); assert.equal(types(db).filter(t => t === repo.PAPER_TYPE).length, 1);
  assert.equal(types(db).filter(t => t === repo.ACK_TYPE).length, 1);
  const commitIndex = db.calls.findIndex(c => c.sql === 'COMMIT');
  const postClockIndex = db.calls.findIndex((c, i) => i > commitIndex && c.sql.includes('clock_timestamp()'));
  assert.ok(postClockIndex > commitIndex);
  const publicView = await repo.readPrdPaperProjection(db, { businessDate: f.businessDate, trustRegistry: 'synthetic-trust' });
  assert.equal(publicView.records.length, 1); assert.equal(publicView.records[0].formalEligible, false);
  assert.equal(publicView.records[0].paperArtifactHash, out.artifactHash);
  assert.equal(makerChecks > 0, true);
});
test('a valid commit one nanosecond after an earlier view waits, then the next view sees the unchanged paper', async () => {
  const f = await base, { db, out } = await stored(f);
  const earlier = stamp(f.nowMs - 1).replace(/000000Z$/, '999999Z'), before = copy([...db.rows]);
  const buffered = await repo.readPrdPaperProjection(db, { businessDate: f.businessDate, asOf: earlier });
  assert.equal(buffered.records.length, 0); assert.equal(buffered.waitingCount, 1); assert.equal(buffered.blockedCount, 0);
  const next = await repo.readPrdPaperProjection(db, { businessDate: f.businessDate, asOf: f.now });
  assert.equal(next.records.length, 1); assert.equal(next.waitingCount, 0);
  assert.equal(next.records[0].paperArtifactHash, out.artifactHash); assert.deepEqual(copy([...db.rows]), before);
});
test('view asOf cannot be a future DB instant or a loose caller clock', async () => {
  const f = await base, { db } = await stored(f);
  for (const asOf of [f.now.replace(/000000Z$/, '000001Z'), Date.parse(f.now), '2026-02-30T00:00:00Z'])
    await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate, asOf }), { code: 'PRD_VIEW_CLOCK_INVALID' });
});
test('an actual-future paper row remains corrupt even when an older view would otherwise buffer it', async () => {
  const f = await base, { db, out } = await stored(f);
  db.rows.get(out.artifactHash).created_at = f.now.replace(/000000Z$/, '000001Z');
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate,
    asOf: stamp(f.nowMs - 1) }), { code: 'PRD_PAPER_STORAGE_CLOCK' });
});
test('an actual-future ack cannot be hidden as merely newer than the view', async () => {
  const f = await base, { db, out } = await stored(f), prior = db.rows.get(out.acknowledgementHash);
  const ack = JSON.parse(Buffer.from(prior.artifact_bytes).toString('utf8')); delete ack.contentHash;
  ack.createdAt = f.now.replace(/000000Z$/, '000001Z'); ack.paperCommitObservedAt = ack.createdAt; ack.contentHash = hash(ack);
  const metadata = JSON.parse(prior.metadata_json); metadata.contentHash = ack.contentHash;
  const future = artifactRow(ack, repo.ACK_TYPE, metadata, ack.createdAt);
  db.rows.delete(out.acknowledgementHash); db.rows.set(future.artifact_hash, future);
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate,
    asOf: stamp(f.nowMs - 1) }), { code: 'PRD_ACK_INVALID' });
});
test('new receivedAt and snapshot payload cannot create a second paper for the same task', async () => {
  const f = await base, { db, out } = await stored(f), changed = copy(f.record);
  delete changed.contentHash; changed.id = 'synthetic-paper-renewed'; changed.decisionAt = new Date(f.nowMs).toISOString();
  changed.createdAt = changed.decisionAt; changed.privateInputs.quoteSnapshot.receivedAt = f.now;
  changed.privateInputs.quoteSnapshot.newFullPayload = ['changed']; changed.contentHash = hash(changed);
  const before = db.insertions;
  const again = await repo.appendPrdPaper(db, { record: changed, task: f.task, trustRegistry: 'synthetic-trust' });
  assert.equal(again.inserted, false); assert.equal(again.artifactHash, out.artifactHash);
  assert.equal(again.record.decisionAt, f.record.decisionAt); assert.equal(db.insertions, before);
});
test('public paper requires its exact forward original; a persisted paper and ack cannot replace a missing task', async () => {
  const f = await base, { db } = await stored(f); db.rows.delete(f.task.artifactHash);
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate }), { code: 'PRD_ARTIFACT_UNAVAILABLE' });
});
test('public paper rejects tampered forward bytes even when the paper and acknowledgement still replay', async () => {
  const f = await base, { db } = await stored(f); db.rows.get(f.task.artifactHash).artifact_bytes[0] ^= 1;
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate }), { code: 'PRD_ARTIFACT_BYTES' });
});
test('a forward task stored one nanosecond after the decision cannot gain eligibility from paper or ack', async () => {
  const f = await base, { db } = await stored(f);
  db.rows.get(f.task.artifactHash).created_at = stamp(Date.parse(f.record.decisionAt)).replace(/000000Z$/, '000001Z');
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate }), { code: 'PRD_FORWARD_READBACK_BINDING' });
});
test('a forward task falsely stored before forecast completion is rejected by the public reader', async () => {
  const f = await base, { db } = await stored(f);
  db.rows.get(f.task.artifactHash).created_at = stamp(Date.parse(f.forward.forecast.forecastCompletedAt) - 1);
  await assert.rejects(repo.readPrdPaperProjection(db, { businessDate: f.businessDate }), { code: 'PRD_FORWARD_READBACK_BINDING' });
});
test('no candidate is still the first frozen paper sample and is not replaced later', async () => {
  const f = await base, { db, out } = await stored(f), altered = copy(f.record);
  delete altered.contentHash; altered.paperPrimary = { market: 'HAD', code: 'H' }; altered.contentHash = hash(altered);
  const again = await repo.appendPrdPaper(db, { record: altered, task: f.task, trustRegistry: 'synthetic-trust' });
  assert.equal(again.artifactHash, out.artifactHash); assert.equal(again.record.paperPrimary, null);
});
test('wrong task model/forecast or business day rolls back the whole write', async () => {
  const f = await base;
  for (const mutate of [r => { r.privateInputs.artifact.contentHash = '0'.repeat(64); }, r => { r.event.businessDate = '2000-01-01'; }]) {
    const r = copy(f.record); delete r.contentHash; mutate(r); r.contentHash = hash(r);
    const db = new SqlDouble(f);
    await assert.rejects(repo.appendPrdPaper(db, { record: r, task: f.task }), { code: 'PRD_FORWARD_BINDING' });
    assert.deepEqual(types(db), [repo.FORWARD_TYPE]);
    assert.ok(db.calls.some(c => c.sql === 'ROLLBACK TO SAVEPOINT prd_paper_artifact'));
  }
});
test('strict cutoff, kickoff and a 30 seconds plus one nanosecond lag all fail before insert', async () => {
  const f = await base;
  for (const now of [f.record.cutoffTime, f.record.kickoffTime,
    stamp(Date.parse(f.record.decisionAt) + 30000).replace(/000000Z$/, '000001Z')]) {
    const db = new SqlDouble(f); db.now = now;
    await assert.rejects(repo.appendPrdPaper(db, { record: f.record, task: f.task }), { code: 'PRD_PAPER_DEADLINE' });
    assert.equal(db.insertions, 0);
  }
});
test('cutoff crossed after first COMMIT preserves paper but creates no eligible acknowledgement', async () => {
  const f = await base, { db, out } = await stored(f, { afterCommit: db => { if (db.commits === 1) db.now = f.record.cutoffTime; } });
  assert.equal(out.stored, true); assert.equal(out.acknowledged, false); assert.equal(out.reason, 'PRD_PAPER_DEADLINE');
  assert.equal(types(db).includes(repo.PAPER_TYPE), true); assert.equal(types(db).includes(repo.ACK_TYPE), false);
  const publicView = await repo.readPrdPaperProjection(db, { businessDate: f.businessDate });
  assert.equal(publicView.records.length, 0); assert.equal(publicView.blockedCount, 1);
});
test('first COMMIT failure publishes neither a paper original nor acknowledgement', async () => {
  const f = await base, db = new SqlDouble(f, { failCommit: 1 });
  await assert.rejects(repo.appendPrdPaper(db, { record: f.record, task: f.task }), { code: 'SYNTHETIC_COMMIT_FAILURE' });
  assert.deepEqual(types(db), [repo.FORWARD_TYPE]);
});
test('ack COMMIT failure retains only the first original and excludes the public record', async () => {
  const f = await base, { db, out } = await stored(f, { failCommit: 2 });
  assert.equal(out.acknowledged, false); assert.equal(out.reason, 'SYNTHETIC_COMMIT_FAILURE');
  assert.equal(types(db).includes(repo.PAPER_TYPE), true); assert.equal(types(db).includes(repo.ACK_TYPE), false);
});
test('an over-quota forward group is refused before any paper write', async () => {
  const f = await base, db = new SqlDouble(f, { headerOverride: (q, heads, values) =>
    q.includes("modelArtifactHash'=$2") && values[0] === repo.FORWARD_TYPE ? Array(3).fill(header(f.taskRow)) : heads });
  await assert.rejects(repo.appendPrdPaper(db, { record: f.record, task: f.task }), { code: 'PRD_EVENT_QUOTA' });
  assert.equal(db.insertions, 0);
});
test('quota full at two prior distinct paper tasks refuses a third sample', async () => {
  const f = await base, db = new SqlDouble(f, { headerOverride: (q, heads, values) =>
    q.includes("modelArtifactHash'=$2") && values[0] === repo.PAPER_TYPE ? Array(2).fill(header(f.taskRow)) : heads });
  await assert.rejects(repo.appendPrdPaper(db, { record: f.record, task: f.task }), { code: 'PRD_PAPER_EVENT_QUOTA' });
  assert.equal(db.insertions, 0);
});
test('maker rejection and uninitialized ledger cannot write a paper record', async () => {
  const f = await base, r = copy(f.record); delete r.contentHash; r.syntheticMakerValid = false; r.contentHash = hash(r);
  const db = new SqlDouble(f);
  await assert.rejects(repo.appendPrdPaper(db, { record: r, task: f.task }), { code: 'PRD_PAPER_INVALID' });
  await assert.rejects(repo.appendPrdPaper(new SqlDouble(f, { uninitialized: true }), { record: f.record, task: f.task }), { code: 'PRD_LEDGER_UNINITIALIZED' });
  assert.equal(db.calls.length, 0);
});
test('all mutations are create-only learning artifact writes, never pointer/events/old decision changes', async () => {
  const f = await base, { db } = await stored(f);
  assert.equal(db.calls.some(c => /\bUPDATE\b|\bDELETE\b|learning_active_model_pointer|learning_events|recommendation_decisions/.test(c.sql)), false);
  assert.equal(db.calls.filter(c => c.sql.startsWith('INSERT')).every(c => c.sql.includes('ON CONFLICT(artifact_hash) DO NOTHING')), true);
  assert.equal(db.calls.filter(c => c.sql.startsWith('INSERT')).every(c => c.values.length === 8), true);
});
