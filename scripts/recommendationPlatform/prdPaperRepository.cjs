'use strict';
const {assessPaperOpening}=require('../../src/services/sportteryOpeningPolicy.cjs');

// Paper artifacts use the existing, create-only learning ledger. This module
// never writes learning events, active pointers, or published decisions.
const crypto = require('node:crypto');
const { withPostgresTransaction } = require('../../server/postgresStore.cjs');
const { stableStringify, MODEL_LEARNING_LEDGER_VERSION } = require('../modelLearningLedger.cjs');
const baseline = require('../zeroMarketResearchBaseline.cjs');
const { verifyZeroMarketFrozenForecast } = require('../../src/services/marketSeparatedDirectionResearch.cjs');
const { epochNanoseconds } = require('../../src/services/prematchV3Clock.cjs');

const FORWARD_TYPE = 'prd-forward-input-v1';
const PAPER_TYPE = 'prd-paper-recommendation-v1';
const ACK_TYPE = 'prd-paper-commit-ack-v1';
const MAX_TASKS = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_COMMIT_LAG_NS = 30n * 1000000000n;
const HASH = /^[a-f0-9]{64}$/;
const DB_CLOCK_SQL = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US') || '000Z' AS now`;
const HEADER = 'artifact_hash,artifact_type,media_type,byte_length,metadata_json,metadata_hash,created_at,octet_length(artifact_bytes) AS actual_byte_length,octet_length(metadata_json) AS metadata_byte_length';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const hash = v => sha(stableStringify(v));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const instant = value => epochNanoseconds(value);
// Normalize identity keys, never the frozen packet bytes. Equal instants with
// a zone offset must share one quota group without losing nanoseconds.
const identityClock = value => {
  const ns = instant(value);
  assert(ns !== null, 'PRD_IDENTITY_CLOCK', 'Exact event identity clock required');
  const fraction = ((ns % 1000000000n) + 1000000000n) % 1000000000n;
  const seconds = (ns - fraction) / 1000000000n;
  return new Date(Number(seconds * 1000n)).toISOString().replace(/\.\d{3}Z$/, '.' + fraction.toString().padStart(9, '0') + 'Z');
};
const failure = (code, message) => Object.assign(new Error(message), { code });
const assert = (ok, code, message) => { if (!ok) throw failure(code, message); };
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const same = (a, b) => stableStringify(a) === stableStringify(b);
const sealed = value => {
  if (!object(value) || !HASH.test(value.contentHash || '')) return false;
  const body = { ...value }; delete body.contentHash;
  return hash(body) === value.contentHash;
};
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

async function dbClock(client) {
  const rows = (await client.query(DB_CLOCK_SQL)).rows;
  assert(rows.length === 1 && instant(rows[0].now) !== null, 'PRD_DB_CLOCK_INVALID', 'Exact database clock unavailable');
  return rows[0].now;
}
async function initialized(client) {
  const rows = (await client.query("SELECT value FROM football.learning_ledger_meta WHERE key='version'")).rows;
  assert(rows.length === 1 && rows[0].value === MODEL_LEARNING_LEDGER_VERSION,
    'PRD_LEDGER_UNINITIALIZED', 'Verified learning ledger initialization required');
}
function deadline(record, now) {
  const at = instant(now), decided = instant(record.decisionAt);
  const made = instant(record.createdAt), cutoff = instant(record.cutoffTime), kickoff = instant(record.kickoffTime);
  assert(at !== null && decided !== null && made !== null && cutoff !== null && kickoff !== null
    && decided <= made && made <= at && at < cutoff && at < kickoff && at - decided <= MAX_COMMIT_LAG_NS,
  'PRD_PAPER_DEADLINE', 'Paper storage is future, late, or exceeds the 30-second commit budget');
}
function forwardDeadline(input, now, storedAt = now) {
  const at = instant(now), stored = instant(storedAt), f = input.forecast;
  const completed = instant(f.forecastCompletedAt), cutoff = instant(f.event.cutoffAt), kickoff = instant(f.event.eventVersion);
  assert(at !== null && stored !== null && completed !== null && cutoff !== null && kickoff !== null
    && completed <= stored && stored <= at && stored < cutoff && stored < kickoff && at < cutoff && at < kickoff,
  'PRD_FORWARD_DEADLINE', 'Forward task availability is future or crosses cutoff/kickoff');
}
function approvedModels(values) {
  assert(Array.isArray(values) && values.length <= MAX_TASKS && values.every(h => HASH.test(h))
    && new Set(values).size === values.length, 'PRD_MODEL_ALLOWLIST', 'Bounded exact approved model hashes required');
}
function validateForward(input) {
  assert(keys(input, ['version', 'researchOnly', 'formalEligible', 'productionEligible', 'businessDate', 'artifact', 'forecast', 'contentHash'])
    && input.version === FORWARD_TYPE && input.researchOnly === true
    && input.formalEligible === false && input.productionEligible === false && day(input.businessDate) && sealed(input)
    && baseline.verifyResearchArtifact(input.artifact)
    && verifyZeroMarketFrozenForecast(input.forecast, input.artifact),
  'PRD_FORWARD_INVALID', 'Exact approved independent artifact and frozen forecast required');
  return input;
}
function buildPrdForwardInput({ artifact, forecast, businessDate }) {
  const body = { version: FORWARD_TYPE, researchOnly: true, formalEligible: false,
    productionEligible: false, businessDate, artifact, forecast };
  return validateForward({ ...body, contentHash: hash(body) });
}
function forwardInputMetadata(input) {
  validateForward(input);
  const f = input.forecast, e = f.event;
  return { namespace: FORWARD_TYPE, version: FORWARD_TYPE, contentHash: input.contentHash,
    modelArtifactHash: input.artifact.contentHash, forecastContentHash: f.contentHash,
    predictionHash: f.predictionHash, sourceMatchId: e.recordedSourceMatchId,
    eventVersion: identityClock(e.eventVersion), businessDate: input.businessDate, sourceNominalDate: e.sourceNominalDate,
    orderedTeamIds: [e.homeTeamId, e.awayTeamId], orderedEntityRefs: [e.homeEntityRef, e.awayEntityRef],
    cutoffAt: identityClock(e.cutoffAt), kickoffAt: identityClock(e.eventVersion) };
}
function validateRow(row, type, expectedMetadata) {
  assert(object(row) && row.artifact_type === type && row.media_type === 'application/json'
    && HASH.test(row.artifact_hash || '') && HASH.test(row.metadata_hash || ''),
  'PRD_ARTIFACT_HEADER', 'Artifact type, media type, or hashes invalid');
  const raw = Buffer.from(row.artifact_bytes || []), n = Number(row.byte_length);
  assert(Number.isSafeInteger(n) && n >= 1 && n <= MAX_BYTES && raw.length === n
    && sha(raw) === row.artifact_hash && sha(row.metadata_json) === row.metadata_hash,
  'PRD_ARTIFACT_BYTES', 'Artifact length or raw/metadata bytes conflict');
  // Parse failures intentionally propagate: corrupt input is not an empty pool.
  const metadata = JSON.parse(row.metadata_json), value = JSON.parse(raw.toString('utf8'));
  assert(stableStringify(metadata) === row.metadata_json && same(metadata, expectedMetadata(value))
    && instant(row.created_at) !== null, 'PRD_ARTIFACT_METADATA', 'Artifact metadata or storage clock conflict');
  return { artifactHash: row.artifact_hash, rawSha256: row.artifact_hash, input: value,
    metadata, createdAt: row.created_at, byteLength: n };
}
async function rowByHash(client, artifactHash, type, budget = null) {
  assert(HASH.test(artifactHash || ''), 'PRD_ARTIFACT_HASH', 'Exact artifact hash required');
  const headers = (await client.query(`SELECT ${HEADER} FROM football.learning_model_artifacts
    WHERE artifact_hash=$1 AND artifact_type=$2 LIMIT 2`, [artifactHash, type])).rows;
  assert(headers.length === 1, 'PRD_ARTIFACT_UNAVAILABLE', 'Exact artifact original unavailable');
  boundHeaders(headers);
  if (budget) {
    const next = budget.bytes + Number(headers[0].byte_length);
    assert(next <= MAX_TOTAL_BYTES, 'PRD_ARTIFACT_TOTAL_SIZE', 'Combined paper/task/ack originals exceed 32 MiB');
    budget.bytes = next;
  }
  const rows = (await client.query(`SELECT * FROM football.learning_model_artifacts
    WHERE artifact_hash=$1 AND artifact_type=$2 LIMIT 2`, [artifactHash, type])).rows;
  assert(rows.length === 1, 'PRD_ARTIFACT_UNAVAILABLE', 'Exact artifact original unavailable');
  return rows[0];
}
function boundHeaders(rows) {
  assert(rows.length <= MAX_TASKS, 'PRD_ARTIFACT_COUNT', 'Paper artifact event/task pool exceeds 32');
  let total = 0;
  for (const row of rows) {
    const n = Number(row.byte_length), actual = Number(row.actual_byte_length), meta = Number(row.metadata_byte_length);
    assert(Number.isSafeInteger(n) && n > 0 && n <= MAX_BYTES && n === actual,
      'PRD_ARTIFACT_SIZE', 'Paper artifact header length exceeds bounds or differs from bytes');
    assert(Number.isSafeInteger(meta) && meta > 0 && meta <= 65536,
      'PRD_ARTIFACT_METADATA_SIZE', 'Paper artifact metadata exceeds 64 KiB');
    total += n;
  }
  assert(total <= MAX_TOTAL_BYTES, 'PRD_ARTIFACT_TOTAL_SIZE', 'Paper artifact batch exceeds 32 MiB');
}
const eventQuotaKey = m => hash({ modelArtifactHash: m.modelArtifactHash, businessDate: m.businessDate,
  sourceMatchId: m.sourceMatchId, eventVersion: m.eventVersion });
async function readPrdForwardInputs(client, { approvedModelHashes = [], businessDate = null } = {}) {
  approvedModels(approvedModelHashes);
  assert(businessDate === null || day(businessDate), 'PRD_BUSINESS_DATE', 'Exact business date required');
  if (!approvedModelHashes.length) return { tasks: [], blockedCount: 0, truncated: false };
  await initialized(client);
  const observedAt = await dbClock(client);
  const headers = (await client.query(`SELECT ${HEADER} FROM football.learning_model_artifacts
    WHERE artifact_type=$1 AND metadata_json::jsonb->>'modelArtifactHash'=ANY($2::text[])
      AND ($3::text IS NULL OR metadata_json::jsonb->>'businessDate'=$3)
    ORDER BY artifact_hash LIMIT 33`, [FORWARD_TYPE, approvedModelHashes, businessDate])).rows;
  boundHeaders(headers);
  const tasks = [], quotas = new Map();
  let blockedCount = 0;
  for (const header of headers) {
    const row = await rowByHash(client, header.artifact_hash, FORWARD_TYPE);
    assert(same(Object.fromEntries(Object.keys(header).filter(k => !['actual_byte_length','metadata_byte_length'].includes(k)).map(k => [k, header[k]])),
      Object.fromEntries(Object.keys(header).filter(k => !['actual_byte_length','metadata_byte_length'].includes(k)).map(k => [k, row[k]]))),
    'PRD_ARTIFACT_HEADER_CHANGED', 'Task header changed during read');
    const task = validateRow(row, FORWARD_TYPE, forwardInputMetadata), f = task.input.forecast, e = f.event;
    assert(approvedModelHashes.includes(task.input.artifact.contentHash)
      && (businessDate === null || task.input.businessDate === businessDate)
      && instant(task.createdAt) <= instant(observedAt)
      && instant(task.createdAt) >= instant(f.forecastCompletedAt)
      && instant(task.createdAt) < instant(e.cutoffAt) && instant(task.createdAt) < instant(e.eventVersion),
    'PRD_FORWARD_STORAGE_CLOCK', 'Task availability, approval hash, or date conflict');
    const quotaKey = eventQuotaKey(task.metadata), count = (quotas.get(quotaKey) || 0) + 1;
    assert(count <= 2, 'PRD_FORWARD_EVENT_QUOTA', 'More than two explicit forward tasks for this event/model/day');
    quotas.set(quotaKey, count);
    // A closed task remains an original; it never becomes a new prediction.
    if (instant(observedAt) < instant(e.cutoffAt) && instant(observedAt) < instant(e.eventVersion))
      tasks.push({ ...task, observedAt });
    else blockedCount++;
  }
  return { tasks, blockedCount, truncated: false };
}
function paperMetadata(record, taskHash) {
  assert(object(record.event) && HASH.test(taskHash || ''), 'PRD_PAPER_BINDING', 'Paper event and task original required');
  const p = record.privateInputs, e = record.event;
  assert(object(p) && object(p.artifact) && object(p.forecast), 'PRD_PAPER_INPUTS', 'Full paper private originals required');
  return { namespace: PAPER_TYPE, version: PAPER_TYPE, recordId: record.id,
    contentHash: record.contentHash, taskArtifactHash: taskHash,
    modelArtifactHash: p.artifact.contentHash, forecastContentHash: p.forecast.contentHash,
    predictionHash: p.forecast.predictionHash, sourceMatchId: e.sourceMatchId,
    eventVersion: identityClock(e.eventVersion), businessDate: e.businessDate,
    cutoffAt: identityClock(record.cutoffTime), kickoffAt: identityClock(record.kickoffTime), decisionAt: record.decisionAt,
    // The first decision wins for an approved task. A later receivedAt or a
    // renewed full quote snapshot must not multiply this frozen paper sample.
    inputKey: hash({ taskHash, forecastHash: p.forecast.contentHash,
      event: { ...e, eventVersion: identityClock(e.eventVersion) } }) };
}
function validatedPaperRow(row, { trustRegistry }) {
  const parsed = JSON.parse(Buffer.from(row.artifact_bytes || []).toString('utf8'));
  const taskHash = JSON.parse(row.metadata_json).taskArtifactHash;
  const out = validateRow(row, PAPER_TYPE, value => paperMetadata(value, taskHash));
  assert(parsed.version === PAPER_TYPE && sealed(parsed) && parsed.formalEligible === false
    && parsed.productionEligible === false && parsed.primary === null && parsed.companion === null
    && require('../../src/services/prdPaperRecommendation.cjs').verifyPrdPaperRecommendation(parsed, { trustRegistry }),
  'PRD_PAPER_INVALID', 'Paper full signature and deterministic replay failed');
  return out;
}
async function createOnly(client, { value, type, metadata, createdAt }) {
  const bytes = Buffer.from(stableStringify(value)), rawHash = sha(bytes), meta = stableStringify(metadata);
  assert(bytes.length > 0 && bytes.length <= MAX_BYTES, 'PRD_ARTIFACT_SIZE', 'Paper original exceeds byte bound');
  const inserted = await client.query(`INSERT INTO football.learning_model_artifacts
    (artifact_hash,artifact_type,media_type,artifact_bytes,byte_length,metadata_json,metadata_hash,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(artifact_hash) DO NOTHING`,
  [rawHash, type, 'application/json', bytes, bytes.length, meta, sha(meta), createdAt]);
  const row = await rowByHash(client, rawHash, type);
  assert(Buffer.from(row.artifact_bytes).equals(bytes) && row.byte_length.toString() === bytes.length.toString()
    && row.metadata_json === meta && row.metadata_hash === sha(meta) && row.media_type === 'application/json'
    && instant(row.created_at) !== null,
  'PRD_CREATE_ONLY_CONFLICT', 'Create-only artifact exact readback failed');
  return { artifactHash: rawHash, createdAt: row.created_at, inserted: inserted.rowCount === 1 };
}
async function eventHeaders(client, type, metadata) {
  const rows = (await client.query(`SELECT ${HEADER} FROM football.learning_model_artifacts
    WHERE artifact_type=$1 AND metadata_json::jsonb->>'modelArtifactHash'=$2
      AND metadata_json::jsonb->>'sourceMatchId'=$3 AND metadata_json::jsonb->>'eventVersion'=$4
      AND metadata_json::jsonb->>'businessDate'=$5 LIMIT 3`,
  [type, metadata.modelArtifactHash, metadata.sourceMatchId, metadata.eventVersion, metadata.businessDate])).rows;
  boundHeaders(rows);
  assert(rows.length <= 2, 'PRD_EVENT_QUOTA', 'More than two task/paper originals for this event/model/day');
  return rows;
}
async function transaction(pool, action, beforeCommit) {
  return withPostgresTransaction(pool, async client => {
    await client.query("SELECT set_config('lock_timeout','3000',true),set_config('statement_timeout','20000',true)");
    await initialized(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['prd-paper-artifacts-v1']);
    await client.query('SAVEPOINT prd_paper_artifact');
    try { const out = await action(client); await client.query('RELEASE SAVEPOINT prd_paper_artifact'); return out; }
    catch (error) { await client.query('ROLLBACK TO SAVEPOINT prd_paper_artifact'); throw error; }
  }, { isolationLevel: 'SERIALIZABLE', beforeCommit });
}
function ackMetadata(value) {
  return { namespace: ACK_TYPE, version: ACK_TYPE, contentHash: value.contentHash,
    paperArtifactHash: value.paperArtifactHash, taskArtifactHash: value.taskArtifactHash,
    businessDate: value.businessDate, sourceMatchId: value.sourceMatchId, eventVersion: value.eventVersion };
}
async function appendPrdForwardInput(pool, { input, approvedModelHashes = [] } = {}) {
  approvedModels(approvedModelHashes);
  assert(approvedModelHashes.length > 0, 'PRD_FORWARD_MODEL_NOT_APPROVED', 'Explicit forward model approval required');
  validateForward(input);
  assert(approvedModelHashes.includes(input.artifact.contentHash),
    'PRD_FORWARD_MODEL_NOT_APPROVED', 'Forward model is outside the exact approved allowlist');
  const bytes = Buffer.from(stableStringify(input)), artifactHash = sha(bytes), metadata = forwardInputMetadata(input);
  assert(bytes.length > 0 && bytes.length <= MAX_BYTES, 'PRD_ARTIFACT_SIZE', 'Forward original exceeds byte bound');
  let storedAt = null;
  const stored = await transaction(pool, async client => {
    const now = await dbClock(client);
    forwardDeadline(input, now);
    const headers = await eventHeaders(client, FORWARD_TYPE, metadata);
    for (const header of headers) {
      const existing = validateRow(await rowByHash(client, header.artifact_hash, FORWARD_TYPE), FORWARD_TYPE, forwardInputMetadata);
      assert(eventQuotaKey(existing.metadata) === eventQuotaKey(metadata),
        'PRD_FORWARD_EVENT_CONFLICT', 'Stored forward quota member conflicts with event/model/day');
    }
    const duplicate = headers.some(header => header.artifact_hash === artifactHash);
    assert(duplicate || headers.length < 2, 'PRD_FORWARD_EVENT_QUOTA', 'Forward event/model/day quota is already full');
    const out = await createOnly(client, { value: input, type: FORWARD_TYPE, metadata, createdAt: now });
    storedAt = out.createdAt;
    forwardDeadline(input, await dbClock(client), storedAt);
    return out;
  }, async client => { forwardDeadline(input, await dbClock(client), storedAt); });
  try {
    // The task itself is the sole original; this is a post-COMMIT observation,
    // not a manufactured task ack or a backdated model availability claim.
    const observed = await withPostgresTransaction(pool, async client => {
      await client.query('SET TRANSACTION READ ONLY');
      const now = await dbClock(client);
      const actual = validateRow(await rowByHash(client, artifactHash, FORWARD_TYPE), FORWARD_TYPE, forwardInputMetadata);
      assert(same(actual.input, input) && actual.createdAt === stored.createdAt,
        'PRD_FORWARD_READBACK_BINDING', 'Postcommit forward original changed');
      forwardDeadline(input, now, actual.createdAt);
      return now;
    }, { isolationLevel: 'REPEATABLE READ' });
    return { stored: true, inserted: stored.inserted, admitted: true, artifactHash,
      createdAt: stored.createdAt, commitObservedAt: observed, formalEligible: false, productionEligible: false };
  } catch (error) {
    return { stored: true, inserted: stored.inserted, admitted: false, artifactHash,
      createdAt: stored.createdAt, reason: error.code || 'PRD_FORWARD_COMMIT_OBSERVATION_FAILED',
      formalEligible: false, productionEligible: false };
  }
}
async function existingAck(client, paperHash, budget = null) {
  const headers = (await client.query(`SELECT ${HEADER} FROM football.learning_model_artifacts
    WHERE artifact_type=$1 AND metadata_json::jsonb->>'paperArtifactHash'=$2 LIMIT 2`, [ACK_TYPE, paperHash])).rows;
  assert(headers.length <= 1, 'PRD_ACK_CONFLICT', 'Multiple paper acknowledgements conflict');
  if (!headers.length) return null;
  boundHeaders(headers);
  return validateRow(await rowByHash(client, headers[0].artifact_hash, ACK_TYPE, budget), ACK_TYPE, ackMetadata);
}
function validAck(ack, paper, paperHash, taskHash, paperCreatedAt) {
  const e = paper.event;
  return keys(ack, ['version', 'paperArtifactHash', 'paperContentHash', 'taskArtifactHash', 'businessDate',
    'sourceMatchId', 'eventVersion', 'paperCreatedAt', 'paperCommitObservedAt', 'createdAt',
    'formalEligible', 'productionEligible', 'contentHash'])
    && sealed(ack) && ack.version === ACK_TYPE && ack.paperArtifactHash === paperHash
    && ack.paperContentHash === paper.contentHash && ack.taskArtifactHash === taskHash
    && ack.businessDate === e.businessDate && ack.sourceMatchId === e.sourceMatchId
    && ack.eventVersion === e.eventVersion && ack.paperCommitObservedAt === ack.createdAt
    && ack.paperCreatedAt === paperCreatedAt
    && ack.formalEligible === false && ack.productionEligible === false
    && instant(ack.paperCommitObservedAt) !== null && instant(ack.paperCreatedAt) !== null
    && instant(ack.paperCreatedAt) <= instant(ack.paperCommitObservedAt);
}
async function appendPrdPaper(pool, { record, task, trustRegistry }) {
  assert(object(task) && HASH.test(task.artifactHash || ''), 'PRD_FORWARD_BINDING', 'Exact stored forward task required');
  assert(record?.version === PAPER_TYPE && sealed(record) && record.formalEligible === false
    && record.productionEligible === false && record.primary === null && record.companion === null
    && require('../../src/services/prdPaperRecommendation.cjs').verifyPrdPaperRecommendation(record, { trustRegistry }),
  'PRD_PAPER_INVALID', 'Fully verified paper record required');
  let precommitRecord = record;
  const stored = await transaction(pool, async client => {
    const now = await dbClock(client), raw = await rowByHash(client, task.artifactHash, FORWARD_TYPE);
    const original = validateRow(raw, FORWARD_TYPE, forwardInputMetadata);
    assert(instant(original.createdAt) <= instant(record.decisionAt)
      && original.input.businessDate === record.event.businessDate
      && same(record.privateInputs.artifact, original.input.artifact)
      && same(record.privateInputs.forecast, original.input.forecast),
    'PRD_FORWARD_BINDING', 'Paper does not bind the exact previously stored independent task');
    const metadata = paperMetadata(record, task.artifactHash);
    assert(day(metadata.businessDate), 'PRD_BUSINESS_DATE', 'Paper business date invalid');
    const forwardHeaders = await eventHeaders(client, FORWARD_TYPE, metadata);
    assert(forwardHeaders.some(h => h.artifact_hash === task.artifactHash),
      'PRD_FORWARD_BINDING', 'Forward task absent from its exact event quota group');
    const paperHeaders = await eventHeaders(client, PAPER_TYPE, metadata);
    const duplicates = (await client.query(`SELECT ${HEADER} FROM football.learning_model_artifacts
      WHERE artifact_type=$1 AND metadata_json::jsonb->>'inputKey'=$2 LIMIT 2`, [PAPER_TYPE, metadata.inputKey])).rows;
    assert(duplicates.length <= 1, 'PRD_PAPER_INPUT_CONFLICT', 'More than one first paper original for an input');
    if (duplicates.length) {
      boundHeaders(duplicates);
      const prior = validatedPaperRow(await rowByHash(client, duplicates[0].artifact_hash, PAPER_TYPE), { trustRegistry });
      assert(prior.metadata.inputKey === metadata.inputKey && prior.metadata.taskArtifactHash === task.artifactHash,
        'PRD_PAPER_INPUT_CONFLICT', 'Paper input binding conflict');
      precommitRecord = null; // Never restamp the first actual decision.
      return { artifactHash: prior.artifactHash, createdAt: prior.createdAt, inserted: false, record: prior.input };
    }
    assert(paperHeaders.length < 2, 'PRD_PAPER_EVENT_QUOTA', 'Paper event/model/day quota is already full');
    freshOpening(record,now);deadline(record, now);
    const out = await createOnly(client, { value: record, type: PAPER_TYPE, metadata, createdAt: now });
    const completedAt=await dbClock(client);freshOpening(record,completedAt);deadline(record, completedAt);
    return { ...out, record };
  }, async client => { if (precommitRecord){const now=await dbClock(client);freshOpening(precommitRecord,now);deadline(precommitRecord,now);} });

  // This fresh DB clock is observed only AFTER the first COMMIT has completed.
  // A precommit query cannot prove that COMMIT finished before a deadline.
  let acknowledgeRecord = null;
  try {
    const acknowledgement = await transaction(pool, async client => {
      const now = await dbClock(client);
      const prior = await existingAck(client, stored.artifactHash);
      if (prior) {
        assert(validAck(prior.input, stored.record, stored.artifactHash, task.artifactHash, stored.createdAt)
          && prior.createdAt === prior.input.createdAt,
          'PRD_ACK_INVALID', 'Stored acknowledgement binding invalid');
        deadline(stored.record, prior.input.paperCommitObservedAt);
        return { artifactHash: prior.artifactHash, record: prior.input };
      }
      freshOpening(stored.record,now);deadline(stored.record, now);
      const readback = validatedPaperRow(await rowByHash(client, stored.artifactHash, PAPER_TYPE), { trustRegistry });
      assert(same(readback.input, stored.record) && readback.createdAt === stored.createdAt,
        'PRD_PAPER_READBACK', 'Postcommit paper original changed');
      const body = { version: ACK_TYPE, paperArtifactHash: stored.artifactHash,
        paperContentHash: stored.record.contentHash, taskArtifactHash: task.artifactHash,
        businessDate: stored.record.event.businessDate, sourceMatchId: stored.record.event.sourceMatchId,
        eventVersion: stored.record.event.eventVersion, paperCreatedAt: stored.createdAt,
        paperCommitObservedAt: now, createdAt: now, formalEligible: false, productionEligible: false };
      const ack = { ...body, contentHash: hash(body) };
      acknowledgeRecord = stored.record;
      const out = await createOnly(client, { value: ack, type: ACK_TYPE, metadata: ackMetadata(ack), createdAt: now });
      const completedAt=await dbClock(client);freshOpening(stored.record,completedAt);deadline(stored.record, completedAt);
      return { artifactHash: out.artifactHash, record: ack };
    }, async client => { if (acknowledgeRecord){const now=await dbClock(client);freshOpening(acknowledgeRecord,now);deadline(acknowledgeRecord,now);} });
    return { stored: true, inserted: stored.inserted, acknowledged: true, formalEligible: false,
      productionEligible: false, artifactHash: stored.artifactHash, acknowledgementHash: acknowledgement.artifactHash,
      record: stored.record, acknowledgement: acknowledgement.record };
  } catch (error) {
    return { stored: true, inserted: stored.inserted, acknowledged: false, formalEligible: false,
      productionEligible: false, artifactHash: stored.artifactHash, reason: error.code || 'PRD_ACK_FAILED' };
  }
}
function freshOpening(record,now){
  const result=assessPaperOpening(record,now);
  assert(result.eligible,'PRD_OPENING_WAIT',result.reason);
}
async function readPrdPaperProjection(client, { businessDate, trustRegistry, asOf = null }) {
  assert(day(businessDate), 'PRD_BUSINESS_DATE', 'Exact business date required');
  await initialized(client);
  const now = await dbClock(client);
  const viewAt = asOf === null ? now : asOf;
  assert(instant(viewAt) !== null && instant(viewAt) <= instant(now),
    'PRD_VIEW_CLOCK_INVALID', 'View clock must be an exact instant no later than actual DB observation');
  const headers = (await client.query(`SELECT DISTINCT ON (metadata_json::jsonb->>'sourceMatchId',metadata_json::jsonb->>'eventVersion')
    ${HEADER} FROM football.learning_model_artifacts
    WHERE artifact_type=$1 AND metadata_json::jsonb->>'businessDate'=$2
    ORDER BY metadata_json::jsonb->>'sourceMatchId',metadata_json::jsonb->>'eventVersion',created_at::timestamptz DESC,artifact_hash
    LIMIT 33`, [PAPER_TYPE, businessDate])).rows;
  boundHeaders(headers);
  const projections = [], budget = { bytes: 0 };
  let blockedCount = 0, waitingCount = 0;
  for (const header of headers) {
    const paper = validatedPaperRow(await rowByHash(client, header.artifact_hash, PAPER_TYPE, budget), { trustRegistry });
    assert(paper.metadata.businessDate === businessDate && instant(paper.createdAt) <= instant(now)
      && instant(paper.createdAt) >= instant(paper.input.createdAt),
      'PRD_PAPER_STORAGE_CLOCK', 'Paper business date or stored clock conflict');
    // Embedded inputs and an ack do not establish the original task's actual
    // existence or availability. Re-read the exact forward original as well.
    const forward = validateRow(await rowByHash(client, paper.metadata.taskArtifactHash, FORWARD_TYPE, budget),
      FORWARD_TYPE, forwardInputMetadata);
    const f = forward.input.forecast, e = paper.input.event;
    assert(same(forward.input.artifact, paper.input.privateInputs.artifact)
      && same(f, paper.input.privateInputs.forecast)
      && forward.input.businessDate === e.businessDate && e.businessDate === businessDate
      && forward.metadata.sourceMatchId === paper.metadata.sourceMatchId
      && forward.metadata.eventVersion === paper.metadata.eventVersion
      && forward.metadata.kickoffAt === identityClock(paper.input.kickoffTime)
      && same(forward.metadata.orderedTeamIds, e.orderedTeamIds)
      && same(forward.metadata.orderedEntityRefs, e.orderedEntityRefs)
      && f.event.sourceEventRef === e.sourceEventRef
      && forward.metadata.sourceNominalDate === e.sourceNominalDate
      && f.eventApproval.eventEvidenceSha256 === e.eventEvidenceSha256
      && instant(paper.input.cutoffTime) <= instant(forward.metadata.cutoffAt)
      && instant(forward.createdAt) >= instant(f.forecastCompletedAt)
      && instant(forward.createdAt) <= instant(paper.input.decisionAt)
      && instant(forward.createdAt) < instant(forward.metadata.cutoffAt)
      && instant(forward.createdAt) < instant(forward.metadata.kickoffAt),
    'PRD_FORWARD_READBACK_BINDING', 'Paper forward original identity, bytes, or actual availability conflict');
    const ack = await existingAck(client, paper.artifactHash, budget);
    if (!ack) { blockedCount++; continue; }
    assert(validAck(ack.input, paper.input, paper.artifactHash, paper.metadata.taskArtifactHash, paper.createdAt)
      && ack.createdAt === ack.input.createdAt
      && instant(ack.createdAt) <= instant(now), 'PRD_ACK_INVALID', 'Paper acknowledgement unavailable or invalid');
    deadline(paper.input, ack.input.paperCommitObservedAt);
    // A coherent earlier view may precede a valid concurrently committed paper.
    // Keep the original clocks; a later view can see this exact same record.
    if (instant(paper.createdAt) > instant(viewAt) || instant(ack.createdAt) > instant(viewAt)) {
      waitingCount++; continue;
    }
    const projection = require('../../src/services/prdPaperRecommendation.cjs').publicPrdPaperProjection(paper.input,
      { trustRegistry, storageCommit: { paperArtifactHash: paper.artifactHash, acknowledgementHash: ack.artifactHash,
        paperCommitObservedAt: ack.input.paperCommitObservedAt } });
    assert(projection !== null && object(projection) && sealed(projection) && projection.formalEligible === false
      && projection.productionEligible === false && projection.primary === null && projection.companion === null,
      'PRD_PAPER_PUBLIC_INVALID', 'Exact sealed public paper projection failed');
    projections.push(projection);
  }
  return { records: projections, blockedCount, waitingCount, truncated: false };
}

module.exports = { FORWARD_TYPE, PAPER_TYPE, ACK_TYPE, MAX_TASKS, MAX_BYTES, MAX_TOTAL_BYTES,
  buildPrdForwardInput, forwardInputMetadata, appendPrdForwardInput,
  readPrdForwardInputs, appendPrdPaper, readPrdPaperProjection };
