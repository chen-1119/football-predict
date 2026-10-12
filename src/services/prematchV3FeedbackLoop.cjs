'use strict';

// A parameter file is not evidence of successful validation. Keep the actual
// held-out records so a loader can recompute metrics, without fitting on server.
const learning = require('./prematchV3Learning.cjs');
const { stableHash: hash } = require('./webConsensusEvidence.cjs');
const { epochNanoseconds: clock } = require('./prematchV3Clock.cjs');
const VERSION = 'prematch-v3-validated-parameters-v1';
const MAX_BYTES = 16 * 1024 * 1024;
const seal = body => ({ ...body, contentHash: hash(body) });
const fail = code => { throw new Error(`V3_FEEDBACK_${code}`); };
const check = (ok, code) => { if (!ok) fail(code); };
function goodMetrics(evaluation) {
  const metrics = evaluation?.validation?.metrics;
  if (evaluation?.status !== 'shadow-evaluated' || !metrics) return false;
  const candidate = metrics.candidate;
  return candidate?.rows >= learning.RESEARCH_FLOORS.testRows
    && ['baseline', 'marketOnly'].every(name => metrics[name]?.rows === candidate.rows
      && ['brier', 'logLoss'].every(key => Number.isFinite(candidate[key])
        && Number.isFinite(metrics[name][key]) && candidate[key] < metrics[name][key]));
}
function evaluate(artifact, records, asOf) {
  return learning.evaluatePrematchV3Records({ artifact, records, asOf,
    mode: 'retrospective-shadow-replay', testDays: artifact.evaluationPlan.testDays });
}
function buildValidatedParameterPacket({ artifact, records, asOf }) {
  check(learning.verifyPrematchV3ParameterArtifact(artifact).valid, 'PARAMETERS_INVALID');
  check(clock(asOf) !== null && clock(asOf) >= clock(artifact.availableAt), 'CLOCK_INVALID');
  check(Array.isArray(records) && records.length <= 100000, 'RECORDS_INVALID');
  const validation = evaluate(artifact, records, asOf);
  check(goodMetrics(validation), 'HOLDOUT_NOT_IMPROVED');
  // Use the evaluator's admitted paired rows; extra rejected/duplicate records
  // cannot inflate the denominator or silently change the loaded candidate.
  const admitted = new Set(validation.validation.rows.map(row => row.inputHash));
  const heldOutRecords = records.filter(row => admitted.has(row.contentHash));
  check(new Set(heldOutRecords.map(row => row.contentHash)).size === heldOutRecords.length,
    'DUPLICATE_HOLDOUT_RECORD');
  const replay = evaluate(artifact, heldOutRecords, asOf);
  check(goodMetrics(replay) && hash(replay.validation) === hash(validation.validation), 'HOLDOUT_REPLAY');
  const body = { version: VERSION, createdAt: asOf, availableAt: asOf,
    shadowOnly: true, formalEligible: false, productionEligible: false,
    artifact: structuredClone(artifact), parameterArtifactHash: artifact.contentHash,
    heldOutRecords: structuredClone(heldOutRecords), validation: replay.validation,
    baselineArtifactHashes: [...new Set(heldOutRecords.map(record => record.baseRatesEvidence.artifactHash))].sort(),
    scope: 'time-held-out-research;not-prospective-calibration-or-formal-promotion',
    trainingInputsHash: artifact.training.artifactHash };
  const packet = seal(body);
  check(Buffer.byteLength(JSON.stringify(packet)) <= MAX_BYTES, 'PACKET_TOO_LARGE');
  return packet;
}
function verifyValidatedParameterPacket(packet, asOf) {
  try {
    check(packet?.version === VERSION && packet.shadowOnly === true
      && packet.formalEligible === false && packet.productionEligible === false, 'PACKET_VERSION');
    const { contentHash, ...body } = packet;
    check(hash(body) === contentHash && Buffer.byteLength(JSON.stringify(packet)) <= MAX_BYTES, 'PACKET_HASH');
    check(clock(asOf) !== null && clock(packet.availableAt) !== null
      && clock(packet.availableAt) < clock(asOf) && packet.createdAt === packet.availableAt, 'PACKET_CLOCK');
    check(packet.parameterArtifactHash === packet.artifact?.contentHash
      && packet.trainingInputsHash === packet.artifact?.training?.artifactHash, 'PARAMETER_BINDING');
    const rebuilt = buildValidatedParameterPacket({ artifact: packet.artifact,
      records: packet.heldOutRecords, asOf: packet.availableAt });
    check(hash(rebuilt) === hash(packet), 'PACKET_REPLAY');
    return { valid: true, blockers: [], artifact: structuredClone(packet.artifact),
      receipt: { version: VERSION, packetHash: contentHash, parameterArtifactHash: packet.parameterArtifactHash,
        parametersHash: packet.artifact.parametersHash, trainingInputsHash: packet.trainingInputsHash,
        baselineArtifactHashes: [...packet.baselineArtifactHashes],
        heldOutRows: packet.validation.rows.length, metrics: structuredClone(packet.validation.metrics),
        availableAt: packet.availableAt, formalEligible: false } };
  } catch (error) {
    return { valid: false, artifact: null, receipt: null,
      blockers: [/^V3_FEEDBACK_[A-Z_]+$/.test(error.message) ? error.message : 'V3_FEEDBACK_PACKET_INVALID'] };
  }
}
module.exports = { VERSION, MAX_BYTES, buildValidatedParameterPacket, verifyValidatedParameterPacket };
