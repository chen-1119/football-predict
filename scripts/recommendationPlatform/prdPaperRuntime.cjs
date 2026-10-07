'use strict';

// Independent prospective paper lane. This never changes the active learning
// pointer, a published legacy decision, its selections, or its settlement.
const { withPostgresTransaction } = require('../../server/postgresStore.cjs');
const { Repository } = require('./repository.cjs');
const paper = require('./prdPaperRepository.cjs');
const { createPrdPaperRecommendation } = require('../../src/services/prdPaperRecommendation.cjs');
const { readLiveOfficialSnapshot } = require('./liveOfficialHandicap.cjs');
const { day } = require('../../src/services/publishedForecastPolicy.cjs');
const { loadCollectorTrustRegistry } = require('../../src/services/collectorAttestation.cjs');

const VERSION = 'prd-paper-pipeline-view-v1';
const REQUESTED = 'prd-paper-recommendation-v1';
const LEGACY = 'coherent-market-primary-v1';
const errorCode = e => /^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code || '') ? e.code : 'PRD_PAPER_FAILED';

function approvedModelHashes(env = process.env) {
  const raw = env.PRD_PAPER_APPROVED_MODEL_HASHES;
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1200) throw Object.assign(new Error('Invalid paper model configuration'), { code: 'PRD_MODEL_CONFIG_INVALID' });
  let value;
  try { value = JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid paper model configuration'), { code: 'PRD_MODEL_CONFIG_INVALID' }); }
  if (!Array.isArray(value) || value.length > 16 || value.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) || new Set(value).size !== value.length) {
    throw Object.assign(new Error('Invalid paper model configuration'), { code: 'PRD_MODEL_CONFIG_INVALID' });
  }
  return value;
}

async function runPrdPaperCycle({ pool, trustRegistry, env = process.env } = {}) {
  const modelHashes = approvedModelHashes(env);
  if (!modelHashes.length) return { enabled: true, status: 'awaiting-inputs', attempted: 0, created: 0, acknowledged: 0, blockedCount: 0, truncated: false, reasons: ['approved-paper-model-missing'], formalEligible: false };
  // Load configured trust outside the pure maker. A quote-supplied key or
  // boolean cannot establish the collector's identity.
  const registry = loadCollectorTrustRegistry(trustRegistry || env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
    || require('node:path').resolve(__dirname, '../../deploy/light-server/collector-trust-registry.json'));
  const batch = await withPostgresTransaction(pool, async client => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = 7000');
    await client.query('SET LOCAL lock_timeout = 1000');
    const repo = new Repository(client, { trustRegistry: registry });
    const now = Date.now();
    const tasks = await paper.readPrdForwardInputs(client, { approvedModelHashes: modelHashes, businessDate: day(now) });
    // Do not acquire or duplicate source payloads when there is no admitted task.
    const inputs = tasks.tasks?.length ? await repo.currentInputs(now) : null;
    return { tasks, matches: inputs?.current || [] };
  }, { isolationLevel: 'REPEATABLE READ' });
  const tasks = batch.tasks.tasks || [];
  const report = { enabled: true, status: 'awaiting-inputs', attempted: tasks.length, created: 0, acknowledged: 0, blockedCount: batch.tasks.blockedCount || 0, truncated: batch.tasks.truncated === true, reasons: [], formalEligible: false };
  if (!tasks.length) { report.reasons = ['admitted-forward-input-missing']; return report; }
  const snapshot = readLiveOfficialSnapshot(env);
  if (!snapshot) return { ...report, status: 'blocked', blockedCount: report.blockedCount + tasks.length, reasons: ['signed-quote-snapshot-unavailable'] };
  for (const task of tasks) {
    const input = task.input;
    const event = input?.forecast?.event;
    const matching = batch.matches.filter(m => String(m.sourceMatchId || m.id || '').replace(/^(sporttery_|fivehundred_)/, '') === event?.recordedSourceMatchId
      && m.businessDate === input?.businessDate
      && m.homeTeamId === event?.homeTeamId && m.awayTeamId === event?.awayTeamId
      && Date.parse(m.eventVersion || m.kickoffTime) === Date.parse(event?.eventVersion));
    if (matching.length !== 1) { report.blockedCount++; continue; }
    const made = createPrdPaperRecommendation({ artifact: input.artifact, forecast: input.forecast, match: matching[0], quoteSnapshot: snapshot, trustRegistry: registry });
    if (made?.version !== REQUESTED || made.status !== 'paper-screened') { report.blockedCount++; continue; }
    try {
      const saved = await paper.appendPrdPaper(pool, { record: made, task, trustRegistry: registry });
      if (saved.inserted) report.created++;
      if (saved.acknowledged) report.acknowledged++;
      else report.blockedCount++;
    } catch (e) {
      // Keep classification only: SQL, credentials and captured source bytes
      // are never returned to worker logs or the public status.
      report.blockedCount++;
      if (!report.reasons.includes(errorCode(e))) report.reasons.push(errorCode(e));
    }
  }
  report.status = report.acknowledged ? 'paper-recorded' : 'blocked';
  if (report.status === 'blocked' && !report.reasons.length) report.reasons.push('paper-input-or-commit-ineligible');
  return report;
}

function pipelineView({ businessDate, updatedAt, lane, projection, readFailed = false }) {
  return { version: VERSION, businessDate, updatedAt,
    status: readFailed || lane?.status === 'error' || lane?.paperStatus === 'blocked' ? 'blocked' : projection?.records?.length ? 'paper-recorded' : 'awaiting-inputs',
    requestedStrategy: REQUESTED, activeFormalStrategy: null, legacyReferenceStrategy: LEGACY, formalStrategyChanged: false, formalEligible: false,
    records: projection?.records || [], blockedCount: projection?.blockedCount ?? lane?.blockedCount ?? 0,
    truncated: projection?.truncated === true,
    reasons: readFailed ? ['paper-projection-unavailable'] : lane?.errorCode ? [lane.errorCode] : lane?.reasons || (projection?.records?.length ? [] : ['admitted-forward-input-missing']) };
}

module.exports = { VERSION, REQUESTED, LEGACY, approvedModelHashes, runPrdPaperCycle, pipelineView, errorCode };
