'use strict';

// Explicit local fitting output -> verified held-out packet -> CAS PostgreSQL
// shadow registry. This never changes the formal champion or old predictions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableHash: hash } = require('../src/services/webConsensusEvidence.cjs');
const learner = require('../src/services/prematchV3Learning.cjs');
const feedback = require('../src/services/prematchV3FeedbackLoop.cjs');
const runner = require('./runPrematchV3Learning.cjs');
const { epochNanoseconds: clock } = require('../src/services/prematchV3Clock.cjs');
const KEY = 'prematch-v3-parameters';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok, code) => { if (!ok) throw Error(`V3_REGISTER_${code}`); };
function verifyTrainingRun(inputBytes, report, repo = path.resolve(__dirname, '..')) {
  const request = JSON.parse(inputBytes.toString('utf8'));
  runner.validateRequest(request);
  const { contentHash, ...body } = report;
  check(report.version === runner.VERSION && hash(body) === contentHash && report.shadowOnly === true
    && report.formalEligible === false && report.productionEligible === false, 'REPORT');
  check(clock(report.fitStartedAt) !== null && clock(report.fitCompletedAt) !== null
    && clock(report.fitStartedAt) <= clock(report.fitCompletedAt)
    && clock(report.fitCompletedAt) < clock(new Date().toISOString())
    && report.actualFittedAt === report.fitCompletedAt, 'FIT_CLOCK');
  check(report.input?.sha256 === sha(inputBytes) && report.input.requestContentHash === hash(request), 'INPUT_BINDING');
  check(report.implementation?.nodeMajor === 22
    && hash(Object.keys(report.implementation.files || {}).sort()) === hash([...runner.IMPLEMENTATION_FILES].sort())
    && runner.IMPLEMENTATION_FILES.every(file => report.implementation.files[file] === sha(fs.readFileSync(path.join(repo, file)))), 'IMPLEMENTATION');
  // An edited coefficient with a recomputed hash must not be registrable.
  // This replay happens on the training/admin machine, never in runtime reads.
  const fitted = learner.learnPrematchV3Candidate({ ...request, asOf: report.fitStartedAt });
  check(fitted.status === 'shadow-candidate' && report.learning?.status === 'shadow-candidate', 'FIT_BLOCKED');
  const { contentHash: temporaryHash, ...artifactBody } = fitted.artifact;
  void temporaryHash;
  artifactBody.createdAt = report.fitCompletedAt; artifactBody.availableAt = report.fitCompletedAt;
  const artifact = { ...artifactBody, contentHash: hash(artifactBody) };
  check(hash(artifact) === hash(report.learning.artifact), 'FIT_REPLAY');
  const packet = feedback.buildValidatedParameterPacket({ artifact, records: request.records, asOf: report.fitCompletedAt });
  check(hash(packet) === hash(report.feedbackPacket), 'VALIDATION_BINDING');
  check(feedback.verifyValidatedParameterPacket(packet, new Date().toISOString()).valid, 'VALIDATION');
  return packet;
}
const SELECT = `SELECT artifact_key, artifact_version, generated_at, updated_at,
  payload::text AS payload_json, payload_sha256, payload_bytes
  FROM football.private_model_artifacts WHERE artifact_key = $1`;
function verifyBaseline(packet, baseline) {
  const baselineKey = 'prematch-v3-baseline';
  const baselineJson = JSON.stringify(baseline), baselineSha256 = sha(baselineJson || '');
  const baselineStored = { storage: 'postgres', artifactKey: baselineKey,
    artifactVersion: baseline?.artifact?.version, payload: baseline, payloadJson: baselineJson,
    payloadBytes: Buffer.byteLength(baselineJson || ''), payloadSha256: baselineSha256,
    generatedAt: baseline?.createdAt, updatedAt: baseline?.availableAt };
  check(require('../src/services/prematchV3ModelRegistry.cjs').validateStoredPrematchV3Artifact(
    baselineStored, 'baseline', new Date().toISOString()).valid
    && packet.baselineArtifactHashes.includes(baseline.artifact.artifactHash), 'BASELINE_BINDING');
  return { baselineKey, baselineJson, baselineSha256, baselineStored };
}
async function installValidatedPacket({ packet, baseline, expectedPreviousSha256, expectedBaselineSha256, pool }) {
  const { verifyRow } = require('./postgresPrivateModelArtifactStore.cjs');
  check([expectedPreviousSha256, expectedBaselineSha256].every(value => value === null || /^[a-f0-9]{64}$/.test(value || '')), 'EXPECTED_PREVIOUS');
  check(feedback.verifyValidatedParameterPacket(packet, new Date().toISOString()).valid, 'PACKET');
  const { baselineKey, baselineJson, baselineSha256, baselineStored } = verifyBaseline(packet, baseline);
  const json = JSON.stringify(packet), payloadSha256 = sha(json);
  const client = await pool.connect(); let commitAttempted = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL statement_timeout = 10000');
    await client.query('SET LOCAL lock_timeout = 2000');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['football-postgres-projection-sync-v1']);
    const priorRows = (await client.query(SELECT + ' FOR UPDATE', [KEY])).rows;
    check(priorRows.length <= 1, 'MULTIPLE_ACTIVE');
    const prior = priorRows[0] ? verifyRow(priorRows[0], KEY) : null;
    check((prior?.payloadSha256 || null) === expectedPreviousSha256, 'CONCURRENT_CHANGE');
    const priorBaselineRows = (await client.query(SELECT + ' FOR UPDATE', [baselineKey])).rows;
    check(priorBaselineRows.length <= 1, 'MULTIPLE_BASELINES');
    const priorBaseline = priorBaselineRows[0] ? verifyRow(priorBaselineRows[0], baselineKey) : null;
    check((priorBaseline?.payloadSha256 || null) === expectedBaselineSha256, 'CONCURRENT_BASELINE_CHANGE');
    const archive = async row => {
      const archiveKey = `${row.artifact_key || KEY}-history-${row.payload_sha256}`;
      const existing = (await client.query(SELECT + ' FOR UPDATE', [archiveKey])).rows;
      if (existing.length) {
        const saved = verifyRow(existing[0], archiveKey);
        check(saved.payloadJson === row.payload_json && saved.artifactVersion === row.artifact_version,
          'HISTORY_CONFLICT');
      } else await client.query(`INSERT INTO football.private_model_artifacts
        (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
        VALUES ($1,$2,$3,$4,$5::json,$6,$7)`, [archiveKey, row.artifact_version, row.generated_at,
        row.updated_at, row.payload_json, row.payload_sha256, row.payload_bytes]);
    };
    if (prior) await archive(priorRows[0]);
    if (priorBaseline) await archive(priorBaselineRows[0]);
    const databaseNow = (await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    const updatedAt = databaseNow instanceof Date ? databaseNow.toISOString() : databaseNow;
    check(typeof updatedAt === 'string' && Date.parse(updatedAt) > Math.max(Date.parse(packet.availableAt), Date.parse(baseline.availableAt)), 'DATABASE_CLOCK');
    const row = { artifact_version: feedback.VERSION, generated_at: packet.createdAt, updated_at: updatedAt,
      payload_json: json, payload_sha256: payloadSha256, payload_bytes: Buffer.byteLength(json) };
    await archive(row);
    const baseRow = { artifact_key: baselineKey, artifact_version: baselineStored.artifactVersion,
      generated_at: baseline.createdAt, updated_at: updatedAt, payload_json: baselineJson,
      payload_sha256: baselineSha256, payload_bytes: Buffer.byteLength(baselineJson) };
    await archive(baseRow);
    for (const [key, value] of [[baselineKey, baseRow], [KEY, row]]) {
      await client.query(`INSERT INTO football.private_model_artifacts
      (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
      VALUES ($1,$2,$3,$4,$5::json,$6,$7)
      ON CONFLICT (artifact_key) DO UPDATE SET artifact_version=EXCLUDED.artifact_version,
      generated_at=EXCLUDED.generated_at,updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload,
      payload_sha256=EXCLUDED.payload_sha256,payload_bytes=EXCLUDED.payload_bytes`,
      [key, value.artifact_version, value.generated_at, value.updated_at, value.payload_json, value.payload_sha256, value.payload_bytes]);
      const written = verifyRow((await client.query(SELECT, [key])).rows[0], key);
      check(written.payloadJson === value.payload_json, 'ROUNDTRIP');
    }
    commitAttempted = true;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Keep original failure. */ }
    if (commitAttempted) throw Error('V3_REGISTER_COMMIT_OUTCOME_UNKNOWN_READ_BEFORE_RETRY');
    throw error;
  } finally { client.release(); }
  // A separate read proves committed visibility. Never report adopted here:
  // only a subsequent natural publisher record can establish actual use.
  const reader = await pool.connect(); let readback;
  try {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await reader.query('SET LOCAL statement_timeout = 5000');
    readback = verifyRow((await reader.query(SELECT, [KEY])).rows[0], KEY);
    check(readback.payloadJson === json && readback.payloadSha256 === payloadSha256, 'POST_COMMIT_READBACK');
    const baselineReadback = verifyRow((await reader.query(SELECT, [baselineKey])).rows[0], baselineKey);
    check(baselineReadback.payloadJson === baselineJson, 'POST_COMMIT_BASELINE_READBACK');
  } finally {
    try { await reader.query('ROLLBACK'); } finally { reader.release(); }
  }
  return { status: 'shadow-registered', artifactKey: KEY, payloadSha256,
    baselineArtifactHash: baseline.artifact.artifactHash, baselinePayloadSha256: baselineSha256,
    parameterArtifactHash: packet.parameterArtifactHash, validationPacketHash: packet.contentHash,
    updatedAt: readback.updatedAt, commitAcknowledged: true, readbackVerified: true,
    recommendationAdoptionConfirmed: false, formalEligible: false, formalChampionChanged: false };
}
async function main(args) {
  check(Number(process.versions.node.split('.')[0]) === 22, 'NODE22');
  const mode = args.shift(), values = {};
  check(['--prepare', '--apply'].includes(mode), 'MODE');
  for (let i = 0; i < args.length; i += 2) {
    check(['--input', '--report', '--baseline', '--output', '--expected-previous-sha', '--expected-baseline-sha'].includes(args[i])
      && !Object.hasOwn(values, args[i]) && typeof args[i + 1] === 'string', 'ARGS');
    values[args[i]] = args[i + 1];
  }
  check(values['--input'] && values['--report'] && values['--baseline'] && values['--output'], 'ARGS');
  const read = file => { check(fs.statSync(file).size <= runner.MAX_INPUT_BYTES, 'INPUT_BOUND'); return fs.readFileSync(file); };
  const packet = verifyTrainingRun(read(values['--input']), JSON.parse(read(values['--report'])));
  const baseline = JSON.parse(read(values['--baseline']));
  verifyBaseline(packet, baseline);
  const output = path.resolve(values['--output']);
  // Reserve the receipt before any write. No overwrite of an existing receipt.
  const fd = fs.openSync(output, 'wx', 0o600);
  let pool;
  try {
    let result = { status: 'prepared', packetHash: packet.contentHash, productionWrites: 0, formalEligible: false };
    if (mode === '--apply') {
      check(values['--expected-previous-sha'] && values['--expected-baseline-sha'], 'EXPECTED_PREVIOUS');
      pool = require('../server/postgresStore.cjs').createPostgresPool({ applicationName: 'football-v3-parameter-registration', max: 1 });
      result = await installValidatedPacket({ packet, baseline, pool,
        expectedBaselineSha256: values['--expected-baseline-sha'] === 'absent' ? null : values['--expected-baseline-sha'],
        expectedPreviousSha256: values['--expected-previous-sha'] === 'absent' ? null : values['--expected-previous-sha'] });
    }
    fs.writeFileSync(fd, JSON.stringify({ ...result, observedAt: new Date().toISOString() }, null, 2) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    fs.writeFileSync(fd, JSON.stringify({ status: 'failed-or-unconfirmed', code: /^V3_REGISTER_/.test(error.message)
      ? error.message : 'V3_REGISTER_FAILED', observedAt: new Date().toISOString() }) + '\n');
    throw error;
  } finally { fs.closeSync(fd); if (pool) await pool.end(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write((/^V3_(REGISTER|FEEDBACK)_[A-Z_]+$/.test(error.message) ? error.message : 'V3_REGISTER_FAILED') + '\n');
  process.exitCode = 1;
});
module.exports = { KEY, verifyTrainingRun, installValidatedPacket };
