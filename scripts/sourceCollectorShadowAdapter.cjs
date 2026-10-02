'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sourceInstant: instant } = require('./sourceClock.cjs');
const { diagnoseSourceCollection } = require('./sourceCollectionDiagnostic.cjs');
const { verifyCollectorAttestation, sha256CollectorJson } = require('../src/services/collectorAttestation.cjs');
const CURRENT_PATH = '/gateway/uniform/football/getMatchListV1.qry';
const hash = raw => createHash('sha256').update(raw).digest('hex');
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function currentUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'webapi.sporttery.cn'
    && u.pathname === CURRENT_PATH && !u.port && !u.username && !u.password && !u.hash; } catch { return false; }
}
function countCurrentRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.value || typeof payload.value !== 'object' || Array.isArray(payload.value)) return null;
  const list = payload.value.matchInfoList;
  if (list === undefined && payload.value.totalCount === 0) return 0;
  if (!Array.isArray(list)) return null;
  let count = 0;
  for (const group of list) {
    if (!group || !Array.isArray(group.subMatchList)) return null;
    for (const match of group.subMatchList) {
      if (!match || typeof match !== 'object' || Array.isArray(match) || !match.matchId) return null;
      count += 1;
    }
  }
  if (payload.value.totalCount !== undefined && payload.value.totalCount !== count) return null;
  return count;
}
function adaptSourceCollectorAttempt(entry, options = {}) {
  const asOf = instant(options.asOf);
  const maxAgeMs = options.maxAgeMs ?? 900000;
  if (asOf === null || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error('Explicit valid asOf/age required');
  const e = entry && typeof entry === 'object' ? entry : {};
  const audit = e.collectorAudit || e;
  const request = audit.sourceRequest || e.sourceRequest || {};
  const receivedAt = text(audit.receivedAt), requestedAt = text(audit.requestedAt);
  const received = instant(receivedAt), requested = instant(requestedAt);
  const cycle = text(audit.sourceCycleId);
  const rawSha256 = typeof audit.rawSha256 === 'string' && /^[a-f0-9]{64}$/.test(audit.rawSha256) ? audit.rawSha256 : null;
  const blockers = [];
  if (!currentUrl(request.url || e.url) || request.method !== 'GET' || request.role !== 'current') blockers.push('current-endpoint-scope-unproven');
  if (requested === null || received === null || requested > received || received > asOf) blockers.push('response-clock-invalid');
  if (received !== null && asOf - received > maxAgeMs) blockers.push('response-evidence-stale');
  if (!cycle) blockers.push('source-cycle-missing');
  if (!Number.isInteger(audit.httpStatus) || audit.httpStatus < 100 || audit.httpStatus > 599) blockers.push('http-status-unproven');
  if (!rawSha256 || !Number.isSafeInteger(audit.rawBytes) || audit.rawBytes < 0) blockers.push('raw-response-audit-missing');
  const attemptKey = cycle && receivedAt && rawSha256 ? hash(JSON.stringify([cycle, receivedAt, rawSha256])) : null;
  let payload = e.payload, rawBodyRehashed = false, parseError = false;
  if (options.rawBody !== undefined) {
    if (!Buffer.isBuffer(options.rawBody)) throw new Error('rawBody must be the original byte Buffer');
    if (hash(options.rawBody) !== rawSha256 || options.rawBody.length !== audit.rawBytes) blockers.push('raw-response-hash-mismatch');
    else {
      rawBodyRehashed = true;
      try {
        const parsed = JSON.parse(options.rawBody.toString('utf8'));
        if (payload !== undefined && sha256CollectorJson(parsed) !== sha256CollectorJson(payload)) blockers.push('raw-payload-mismatch');
        payload = parsed;
      } catch { parseError = true; }
    }
  }
  const signature = e.collectorAttestation ? verifyCollectorAttestation(e.collectorAttestation, {
    trustRegistry: options.trustRegistry, payload,
    expected: { provider: 'sporttery', endpoint: request, collectorCycleId: cycle, requestedAt, receivedAt,
      providerObservedAt: audit.providerObservedAt ?? null, response: audit,
      canonicalPayloadSha256: e.canonicalPayloadSha256 },
  }) : null;
  const signed = signature?.eligible === true;
  const httpBlocked = [403, 429, 567].includes(audit.httpStatus);
  // Signed success is necessary for a remote snapshot. Local failures may use
  // raw collector-owned audit, but cannot become publication or source eligibility.
  if (audit.httpStatus === 200 && !rawBodyRehashed && !signed) blockers.push('success-response-integrity-unproven');
  if (audit.httpStatus === 200 && payload === undefined && !parseError) blockers.push('response-payload-missing');
  if (e.collectorAttestation && !signed) blockers.push(...signature.blockers);
  const previous = options.previous;
  if (previous && (!Number.isSafeInteger(previous.consecutiveFailures) || previous.consecutiveFailures < 0)) throw new Error('Invalid prior failure count');
  const repeated = attemptKey !== null && previous?.attemptKey === attemptKey;
  const failures = repeated ? Math.max(0, (previous.consecutiveFailures || 0) - 1) : previous?.consecutiveFailures ?? 0;
  if (!Number.isSafeInteger(failures) || failures < 0) throw new Error('Invalid prior failure count');
  const evidence = { requestedAt, receivedAt, sourceCycleId: cycle, httpStatus: audit.httpStatus ?? null,
    rawSha256, rawBytes: audit.rawBytes ?? null, rawBodyRehashed, signatureVerified: signed,
    commitmentHash: signature?.commitmentHash || null,
    sourceUrl: currentUrl(request.url || e.url) ? 'https://webapi.sporttery.cn' + CURRENT_PATH : null,
    trustBoundary: signed ? signature.trustBoundary : rawBodyRehashed ? 'raw-response-integrity-only' : 'collector-failure-audit-only' };
  let diagnostic = null;
  if (blockers.length === 0) {
    const rows = countCurrentRows(payload);
    diagnostic = diagnoseSourceCollection({ source: 'sporttery', scope: 'current-schedule', observedAt: receivedAt,
      sourceDataUpdatedAt: options.sourceDataUpdatedAt ?? null, sourceCycleId: cycle, rawSha256,
      httpStatus: audit.httpStatus, schemaValid: !parseError && rows !== null,
      providerSuccess: payload?.success === true && String(payload?.errorCode ?? '0') === '0', rows,
      consecutiveFailures: failures, retryAfterSeconds: options.retryAfterSeconds ?? 0,
      closure: options.closure });
    // Only a complete raw body can prove a parse failure. Legacy JSON-error
    // messages with HTTP 200 but no body/signature remain unknown evidence.
    if (parseError && !httpBlocked) diagnostic.reason = 'raw-response-json-parse-failed';
  }
  const state = diagnostic?.state || 'unknown-evidence';
  return { version: 'source-collector-shadow-v1', state, reason: diagnostic?.reason || blockers[0],
    blockers: [...new Set(blockers)].sort(), attemptKey, repeatedObservation: repeated, evidence,
    consecutiveFailures: diagnostic?.consecutiveFailures ?? previous?.consecutiveFailures ?? 0,
    retryAfterSeconds: diagnostic?.retryAfterSeconds ?? null, nextAttemptAt: diagnostic?.nextAttemptAt ?? null,
    sourceDataUpdatedAt: options.sourceDataUpdatedAt ?? null,
    publicationAction: 'none', shadowOnly: true, schedulingApplied: false,
    note: 'Original response clocks and hashes only; no fresh business data, publication authority or actual timer change.' };
}
function adaptSourceCollectorSnapshot(snapshot, options = {}) {
  const entries = [...(Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : []),
    ...(Array.isArray(snapshot?.errors) ? snapshot.errors : [])];
  const current = entries.filter(e => e?.id === 'current' || e?.sourceRequest?.role === 'current')
    .sort((a, b) => (instant(b.receivedAt) ?? Infinity) - (instant(a.receivedAt) ?? Infinity));
  if (current.length > 1 && current[0].receivedAt === current[1].receivedAt
    && sha256CollectorJson(current[0]) !== sha256CollectorJson(current[1])) {
    return { ...adaptSourceCollectorAttempt(null, options), reason: 'conflicting-current-attempts', blockers: ['conflicting-current-attempts'] };
  }
  const result = adaptSourceCollectorAttempt(current[0], options);
  if (snapshot?.sourceCycleId && current[0]?.sourceCycleId && snapshot.sourceCycleId !== current[0].sourceCycleId) {
    return { ...result, state: 'unknown-evidence', reason: 'snapshot-source-cycle-mismatch',
      blockers: [...result.blockers, 'snapshot-source-cycle-mismatch'], retryAfterSeconds: null, nextAttemptAt: null };
  }
  return result;
}
function adaptSourceCollectorFailure(error, options = {}) {
  // fetchEndpoint attaches response audit before rethrowing. Consume its original
  // byte Buffer in-process; never reconstruct body bytes from the error message.
  return adaptSourceCollectorAttempt({ collectorAudit: error?.collectorAudit }, {
    ...options, ...(Buffer.isBuffer(error?.response?.rawBody) ? { rawBody: error.response.rawBody } : {}),
  });
}
function readSourceCollectorShadowFiles(files, options = {}) {
  if (!Array.isArray(files) || files.length > 4) throw new Error('At most four explicit source snapshot paths required');
  const candidates = [], inputFiles = [];
  for (const file of files) {
    const name = path.basename(file);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 20000000) { inputFiles.push({ name, status: 'oversized-or-not-file' }); continue; }
      const raw = fs.readFileSync(file);
      if (raw.length > 20000000) { inputFiles.push({ name, status: 'oversized' }); continue; }
      const snapshot = JSON.parse(raw.toString('utf8'));
      const result = adaptSourceCollectorSnapshot(snapshot, options);
      inputFiles.push({ name, status: 'read', bytes: raw.length, sha256: hash(raw) });
      candidates.push(result);
    } catch { inputFiles.push({ name, status: 'unavailable-or-invalid' }); }
  }
  // Missing clocks outrank valid older attempts: never silently hide an
  // unclocked failed file behind an old healthy snapshot.
  candidates.sort((a, b) => (instant(b.evidence?.receivedAt) ?? Infinity) - (instant(a.evidence?.receivedAt) ?? Infinity));
  const result = candidates[0] || adaptSourceCollectorAttempt(null, options);
  if (candidates.length > 1 && candidates[0].evidence.receivedAt === candidates[1].evidence.receivedAt
    && (candidates[0].attemptKey !== candidates[1].attemptKey || candidates[0].state !== candidates[1].state)) {
    return { ...result, state: 'unknown-evidence', reason: 'conflicting-current-files',
      blockers: [...result.blockers, 'conflicting-current-files'], retryAfterSeconds: null, nextAttemptAt: null, inputFiles };
  }
  if (inputFiles.some(f => f.status !== 'read')) return { ...result, state: 'unknown-evidence',
    reason: 'source-file-evidence-incomplete', retryAfterSeconds: null, nextAttemptAt: null,
    blockers: [...result.blockers, 'source-file-evidence-incomplete'], inputFiles };
  return { ...result, inputFiles };
}
module.exports = { adaptSourceCollectorAttempt, adaptSourceCollectorSnapshot, adaptSourceCollectorFailure,
  readSourceCollectorShadowFiles, countCurrentRows };
