'use strict';
const path = require('node:path');
const { forecastInputFor } = require('../../src/services/prospectiveForecastInput.cjs');
const { epochNanoseconds } = require('../../src/services/prematchV3Clock.cjs');
const { derivedTeamId } = require('../storedResultTeamIdentity.cjs');
const { verifyCollectorAttestation, loadCollectorTrustRegistry, sha256CollectorJson,
  extractionFromSportteryPool } = require('../../src/services/collectorAttestation.cjs');
const { expectedCollectorCommitment, officialFastEndpointUrl } = require('../../server/relayCollectorEvidence.cjs');

const VERSION = 'signed-live-had-receipt-v2';
const LEGACY_VERSION = 'signed-live-had-receipt-v1';
const SOURCE = 'sporttery:HAD:signed-live';
const SOURCE_VERIFICATION = 'trusted-collector-signed-live-had';
const MAX_AGE_MS = 15 * 60000, MAX_SOURCE_BYTES = 4 * 1024 * 1024, MAX_RECEIPT_BYTES = 256 * 1024, MAX_ROWS = 512;
const REASONS = Object.freeze(['not-open-prospective-input', 'event-missing-or-ambiguous', 'event-identity-conflict',
  'event-not-selling', 'had-pool-unavailable', 'had-market-invalid', 'cutoff-crossed-or-invalid',
  'input-quote-newer-than-snapshot', 'receipt-too-large', 'had-applied']);
const ENDPOINT_REASONS = Object.freeze(['endpoint-missing-or-ambiguous', 'endpoint-contract-invalid',
  'endpoint-cycle-invalid', 'endpoint-clock-invalid', 'endpoint-acquired-after-asof', 'endpoint-expired',
  'collector-attestation-invalid', 'endpoint-payload-invalid', 'endpoint-row-limit', 'source-too-large', 'verified']);
const text = v => (typeof v === 'string' || typeof v === 'number') && String(v).trim() === String(v)
  && Buffer.byteLength(String(v), 'utf8') > 0 && Buffer.byteLength(String(v), 'utf8') <= 255
  && !/[\x00-\x1f\x7f\ufffd]/.test(String(v)) ? String(v) : null;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const bounded = (v, limit = MAX_SOURCE_BYTES) => { try { return Buffer.byteLength(JSON.stringify(v), 'utf8') <= limit; } catch { return false; } };
const clock = v => epochNanoseconds(typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)
  ? v.replace(' ', 'T') + '+08:00' : v);
const ms = v => { const n = clock(v); return n === null || n % 1000000n !== 0n ? NaN : Number(n / 1000000n); };
const instant = v => typeof v === 'string' && Number.isFinite(ms(v)) && new Date(ms(v)).toISOString() === v;
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && clock(v + 'T00:00:00Z') !== null;
const day = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const registryFor = registry => loadCollectorTrustRegistry(registry || process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || path.resolve(__dirname, '../../deploy/light-server/collector-trust-registry.json'));
const numberFlag = v => v === 1 || v === '1';

// This is the actual current endpoint role, not the calculator role. Some real
// fast uploads intentionally contain current/result with no calculator.
function compactEndpoint(e) {
  const keys = ['method', 'page', 'ok', 'url', 'requestedAt', 'receivedAt', 'sourceCycleId', 'sourceRequest',
    'providerObservedAt', 'httpStatus', 'httpDate', 'httpEtag', 'contentType', 'headersSha256', 'rawSha256',
    'rawBytes', 'canonicalPayloadSha256', 'collectorAttestation', 'payload'];
  return structuredClone(Object.fromEntries(keys.filter(k => e[k] !== undefined).map(k => [k, e[k]])));
}
function verifiedCurrent(e, now, registry, audit) {
  const fail = reason => { if (audit) audit.reason = reason; return null; };
  if (!e || !bounded(e) || e.method !== 'current' || e.page !== null || e.ok !== true
    || !officialFastEndpointUrl('current', e.url) || e.sourceRequest?.method !== 'GET'
    || e.sourceRequest?.role !== 'current' || e.sourceRequest?.page !== null
    || !officialFastEndpointUrl('current', e.sourceRequest?.url) || e.httpStatus !== 200
    || !/^application\/json(?:\s*;|$)/i.test(e.contentType || '') || !hex(e.rawSha256)
    || !hex(e.headersSha256) || !hex(e.canonicalPayloadSha256)
    || !Number.isSafeInteger(e.rawBytes) || e.rawBytes < 1 || e.rawBytes > MAX_SOURCE_BYTES)
    return fail('endpoint-contract-invalid');
  if (audit) Object.assign(audit, {requestedAt: instant(e.requestedAt) ? e.requestedAt : null,
    receivedAt: instant(e.receivedAt) ? e.receivedAt : null, sourceCycleId: text(e.sourceCycleId)});
  if (!text(e.sourceCycleId)) return fail('endpoint-cycle-invalid');
  if (!instant(e.requestedAt) || !instant(e.receivedAt) || ms(e.requestedAt) > ms(e.receivedAt)) return fail('endpoint-clock-invalid');
  if (e.providerObservedAt !== null && e.providerObservedAt !== undefined
    && (!instant(e.providerObservedAt) || ms(e.providerObservedAt) > ms(e.receivedAt))) return fail('endpoint-clock-invalid');
  if (ms(e.receivedAt) > now) return fail('endpoint-acquired-after-asof');
  if (now - ms(e.requestedAt) > MAX_AGE_MS || now - ms(e.receivedAt) > MAX_AGE_MS) return fail('endpoint-expired');
  const proof = verifyCollectorAttestation(e.collectorAttestation, {trustRegistry: registry, payload: e.payload,
    expected: expectedCollectorCommitment(e)});
  if (!proof.eligible) return fail('collector-attestation-invalid');
  if (audit) Object.assign(audit, {collectorSignatureVerified: true, payloadHash: sha256CollectorJson(e.payload),
    commitmentHash: proof.commitmentHash});
  if (e.payload?.success !== true || !Array.isArray(e.payload?.value?.matchInfoList)) return fail('endpoint-payload-invalid');
  const records = [];
  for (const group of e.payload.value.matchInfoList) {
    if (!group || !Array.isArray(group.subMatchList)) return fail('endpoint-payload-invalid');
    for (const row of group.subMatchList) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('endpoint-payload-invalid');
      records.push({row, group});
    }
  }
  if (records.length > MAX_ROWS) return fail('endpoint-row-limit');
  if (audit) Object.assign(audit, {reason: 'verified', rows: records.length});
  return {entry: e, records};
}
function inputIdentity(input) {
  const sourceMatchId = text(input?.sourceMatchId), matchId = input?.id || input?.matchId;
  if (!/^[1-9]\d{0,19}$/.test(sourceMatchId || '')
    || ![`sporttery_${sourceMatchId}`, `fivehundred_${sourceMatchId}`].includes(matchId)
    || !text(input.homeTeamName) || !text(input.awayTeamName) || input.homeTeamName === input.awayTeamName
    || input.homeTeamId !== derivedTeamId(input.homeTeamName) || input.awayTeamId !== derivedTeamId(input.awayTeamName)
    || input.homeTeamId === input.awayTeamId || !date(input.businessDate)) return null;
  const event = clock(input.eventVersion), kickoff = clock(input.kickoffTime), matchNo = text(input.matchNo || input.matchNumStr);
  if (event === null || kickoff !== event || event % 1000000n !== 0n || !matchNo
    || (input.matchNumStr && input.matchNumStr !== matchNo)) return null;
  return {sourceMatchId, eventVersion: new Date(Number(event / 1000000n)).toISOString(), businessDate: input.businessDate,
    homeTeamId: input.homeTeamId, awayTeamId: input.awayTeamId, homeTeamName: input.homeTeamName,
    awayTeamName: input.awayTeamName, matchNo, teamIdentityBasis: 'syncData-name-derived-team-id-v1'};
}
function sameOfficialEvent(identity, record) {
  const {row, group} = record, home = text(row.homeTeamAllName || row.homeTeamAbbName), away = text(row.awayTeamAllName || row.awayTeamAbbName);
  const rawKickoff = typeof row.matchDate === 'string' && typeof row.matchTime === 'string'
    ? clock(`${row.matchDate}T${row.matchTime}+08:00`) : null;
  const businessDate = row.businessDate || group.businessDate;
  return String(row.matchId) === identity.sourceMatchId && rawKickoff !== null
    && rawKickoff === clock(identity.eventVersion) && home === identity.homeTeamName && away === identity.awayTeamName
    && text(row.matchNumStr) === identity.matchNo && businessDate === identity.businessDate
    && (!row.businessDate || !group.businessDate || row.businessDate === group.businessDate);
}
function saleOpen(row, pool) {
  if (row.matchStatus !== 'Selling' || !numberFlag(row.sellStatus) || pool.poolStatus !== 'Selling') return false;
  // Recognized explicit all-up permits only. Define/OddsIn and missing permits
  // are never changed into Selling merely because an SP number is present.
  const permits = ['bettingAllup', 'allUp', 'intAllUp', 'cbtAllUp'].filter(k => pool[k] !== undefined);
  return permits.length > 0 && permits.every(k => numberFlag(pool[k]));
}
// Official fixed-odds consumer jc_szsc_gz.js selects the CBT namespace.
// INT and single-game flags do not veto or grant the fixed all-up product.
// The V1 function above remains exact for previously frozen receipt replay.
function fixedAllupSaleOpen(row, pool) {
  return row.matchStatus === 'Selling' && numberFlag(row.sellStatus) && pool.poolStatus === 'Selling'
    && numberFlag(pool.cbtValue) && numberFlag(pool.cbtAllUp);
}
function saleDeadline(input, record) {
  const event = ms(input.eventVersion || input.kickoffTime), midnight = Date.parse(input.businessDate + 'T00:00:00+08:00');
  const dow = new Date(midnight + 8 * 3600000).getUTCDay();
  const values = [input.kickoffTime, input.buyEndTime, input.cutoffAt, input.cutoffTime, input.predictionMeta?.cutoffTime]
    .filter(v => v !== undefined && v !== null && v !== '').map(ms);
  for (const k of ['buyEndTime', 'matchEndTime', 'sellEndTime', 'stopSaleTime', 'endTime']) {
    const v = record.row[k];
    if (v === undefined || v === null || v === '') continue;
    const n = ms(v);
    if (!Number.isFinite(n) || n < event - 72 * 3600000 || n > event + 30 * 60000) return NaN;
    values.push(n);
  }
  if (values.some(v => !Number.isFinite(v)) || !Number.isFinite(midnight)) return NaN;
  return Math.min(...values, midnight + ([0, 6].includes(dow) ? 23 : 22) * 3600000);
}
function assessEvent(input, verified, now, receiptVersion = VERSION) {
  const identity = inputIdentity(input);
  if (!identity || identity.businessDate !== day(now)) return {reason: 'event-identity-conflict'};
  const records = verified.records.filter(r => String(r.row.matchId) === identity.sourceMatchId);
  if (records.length !== 1) return {reason: 'event-missing-or-ambiguous'};
  const record = records[0];
  if (!sameOfficialEvent(identity, record)) return {reason: 'event-identity-conflict'};
  const sales = (Array.isArray(record.row.poolList) ? record.row.poolList : []).filter(p => p?.poolCode === 'HAD');
  if (sales.length !== 1) return {reason: 'had-pool-unavailable'};
  const sale = receiptVersion === LEGACY_VERSION ? saleOpen : fixedAllupSaleOpen;
  if (!sale(record.row, sales[0])) return {reason: 'event-not-selling'};
  const pools = (Array.isArray(record.row.oddsList) ? record.row.oddsList : []).filter(p => p?.poolCode === 'HAD');
  if (pools.length !== 1) return {reason: 'had-pool-unavailable'};
  const pool = pools[0], quoteOdds = {odds1: Number(pool.h), oddsX: Number(pool.d), odds2: Number(pool.a)};
  // The actual current payload can contain both provider clock fields blank.
  // Those blanks mean unknown, not an invented update time. Any supplied clock
  // must be a valid complete pair known no later than this response receipt.
  const providerClockPresent = [pool.updateDate, pool.updateTime].some(v => v !== null && v !== undefined && v !== '');
  const providerClock = providerClockPresent ? ms(`${pool.updateDate}T${pool.updateTime}+08:00`) : null;
  if ([pool.h, pool.d, pool.a].some(v => v === null || v === '' || typeof v === 'boolean')
    || Object.values(quoteOdds).some(v => !Number.isFinite(v) || v <= 1 || !/^\d+(?:\.\d{1,4})?$/.test(String(v)))
    || (providerClockPresent && (!Number.isFinite(providerClock) || providerClock > ms(verified.entry.receivedAt))))
    return {reason: 'had-market-invalid'};
  const cutoff = saleDeadline(input, record);
  if (!Number.isFinite(cutoff) || now >= cutoff || ms(verified.entry.receivedAt) >= cutoff) return {reason: 'cutoff-crossed-or-invalid'};
  const extraction = extractionFromSportteryPool({row: record.row, poolRow: pool, poolCode: 'HAD',
    fallbackProviderObservedAt: verified.entry.providerObservedAt});
  const proof = verifyCollectorAttestation(verified.entry.collectorAttestation, {expected: {
    ...expectedCollectorCommitment(verified.entry), marketExtractionHash: extraction.hash},
    trustRegistry: verified.registry, payload: verified.entry.payload});
  if (!proof.eligible) return {reason: 'had-market-invalid'};
  return {identity, quoteOdds, cutoff, extraction, rowHash: sha256CollectorJson(record.row)};
}

/** Full signed current payload is retained, rather than an unsigned row/hash
 * summary. Replay rehashes that payload, verifies its signature, finds the
 * unique exact event, derives both existing team IDs and verifies the signed
 * HAD extraction membership. The trust registry is external, never embedded. */
function validSignedLiveHadReceipt(receipt, {match, now, cutoffTime, trustRegistry} = {}) {
  try {
    if (!Number.isSafeInteger(now) || !bounded(receipt, MAX_RECEIPT_BYTES) || !exactKeys(receipt, ['version', 'source', 'market',
      'sourceVerification', 'identity', 'quoteOdds', 'requestedAt', 'observedAt', 'sourceCycleId', 'saleCutoff',
      'marketExtraction', 'rowHash', 'endpoint', 'receiptHash']) || ![LEGACY_VERSION, VERSION].includes(receipt.version) || receipt.source !== SOURCE
      || receipt.market !== 'HAD' || receipt.sourceVerification !== SOURCE_VERIFICATION || !hex(receipt.receiptHash)) return false;
    const {receiptHash, ...body} = receipt;
    if (sha256CollectorJson(body) !== receiptHash) return false;
    const registry = registryFor(trustRegistry), verified = verifiedCurrent(receipt.endpoint, now, registry);
    if (!verified) return false;
    verified.registry = registry;
    const assessed = assessEvent(match, verified, now, receipt.version);
    if (assessed.reason || sha256CollectorJson(assessed.identity) !== sha256CollectorJson(receipt.identity)
      || sha256CollectorJson(assessed.quoteOdds) !== sha256CollectorJson(receipt.quoteOdds)
      || sha256CollectorJson(assessed.extraction) !== sha256CollectorJson(receipt.marketExtraction)
      || assessed.rowHash !== receipt.rowHash || receipt.requestedAt !== verified.entry.requestedAt
      || receipt.observedAt !== verified.entry.receivedAt || receipt.sourceCycleId !== verified.entry.sourceCycleId
      || receipt.saleCutoff !== new Date(assessed.cutoff).toISOString()) return false;
    const deadline = typeof cutoffTime === 'number' ? cutoffTime : ms(cutoffTime);
    return Number.isFinite(deadline) && now < Math.min(deadline, assessed.cutoff)
      && ms(receipt.observedAt) < Math.min(deadline, assessed.cutoff);
  } catch { return false; }
}
function signedLiveHadQuoteForMatch(match, now, cutoffMs, {trustRegistry, allowLegacyReplay = false} = {}) {
  const receipt = match?.officialHadQuoteReceipt;
  // V1 keeps its original validator for frozen history. Fresh candidates must
  // use the fixed CBT contract, including when an authentic V1 receipt exists.
  if (receipt?.version !== VERSION && !(allowLegacyReplay === true && receipt?.version === LEGACY_VERSION)) return null;
  if (!validSignedLiveHadReceipt(receipt, {match, now, cutoffTime: cutoffMs, trustRegistry})) return null;
  return {odds: structuredClone(receipt.quoteOdds), source: SOURCE, at: receipt.observedAt,
    id: receipt.identity.sourceMatchId, event: receipt.identity.eventVersion,
    cutoffMs: Math.min(cutoffMs, ms(receipt.saleCutoff)), receipt, sourceVerification: SOURCE_VERIFICATION};
}
function joinOfficialHad(current, snapshot, {now, trustRegistry, audit = null} = {}) {
  const receiptHashes = new Set(), registry = registryFor(trustRegistry);
  if (audit) Object.assign(audit, {version: 'official-had-input-audit-v1', asOf: Number.isSafeInteger(now) ? new Date(now).toISOString() : null,
    snapshotHash: bounded(snapshot) ? sha256CollectorJson(snapshot) : null, status: 'source-unavailable',
    endpoints: {current: {reason: 'endpoint-missing-or-ambiguous'}}, reasonCounts: {}, samples: []});
  const note = (reason, row) => { if (audit) { audit.reasonCounts[reason] = (audit.reasonCounts[reason] || 0) + 1;
    if (audit.samples.length < 32) audit.samples.push({sourceMatchId: text(row?.sourceMatchId) || '', reason}); } return row; };
  if (!Number.isSafeInteger(now)) return {current, receiptHashes};
  if (!bounded(snapshot)) { if (audit) audit.endpoints.current.reason = 'source-too-large'; return {current, receiptHashes}; }
  const entries = (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : []).filter(e => e?.method === 'current');
  if (entries.length !== 1) { if (audit) audit.endpoints.current.reason = 'endpoint-missing-or-ambiguous'; return {current, receiptHashes}; }
  const verified = verifiedCurrent(entries[0], now, registry, audit?.endpoints.current);
  if (!verified) return {current, receiptHashes};
  verified.registry = registry;
  if (audit) audit.status = 'source-verified';
  const next = current.map(row => {
    const input = forecastInputFor(row);
    if (!input || (Object.hasOwn(row, 'prospectiveForecastInput') && !row.prospectiveForecastInput)
      || row.status !== 'SCHEDULED' || input.status !== 'SCHEDULED' || input.predictionMeta?.lockedAt
      || input.predictionMeta?.lockedReason || input.isOnSale === false
      || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(input.saleStatus || '').toUpperCase())) return note('not-open-prospective-input', row);
    const assessed = assessEvent(input, verified, now);
    if (assessed.reason) {
      note(assessed.reason, row);
      // A newly verified exact event that is not selling is a negative sale
      // observation, not permission to fall back to an older fresh SP label.
      if (assessed.reason === 'event-not-selling') {
        const blocked = {...input, isOnSale: false, saleStatus: 'SUSPENDED'};
        return row.prospectiveForecastInput ? {...row, prospectiveForecastInput: structuredClone(blocked)} : structuredClone(blocked);
      }
      return row;
    }
    const oldHad = input.externalSignals?.bookmakerOdds?.had;
    const oldClocks = [input.oddsReceivedAt || input.oddsUpdatedAt, oldHad?.receivedAt || oldHad?.updatedAt,
      oldHad?.lotterySpReceipt?.observedAt, input.officialHadQuoteReceipt?.observedAt].filter(Boolean).map(ms);
    if (oldClocks.some(v => Number.isFinite(v) && v > ms(verified.entry.receivedAt))) return note('input-quote-newer-than-snapshot', row);
    const body = {version: VERSION, source: SOURCE, market: 'HAD', sourceVerification: SOURCE_VERIFICATION,
      identity: assessed.identity, quoteOdds: assessed.quoteOdds, requestedAt: verified.entry.requestedAt,
      observedAt: verified.entry.receivedAt, sourceCycleId: verified.entry.sourceCycleId,
      saleCutoff: new Date(assessed.cutoff).toISOString(), marketExtraction: assessed.extraction,
      rowHash: assessed.rowHash, endpoint: compactEndpoint(verified.entry)};
    const receipt = {...body, receiptHash: sha256CollectorJson(body)};
    if (!bounded(receipt, MAX_RECEIPT_BYTES)) return note('receipt-too-large', row);
    const joined = {...input, odds: structuredClone(assessed.quoteOdds), oddsSource: SOURCE,
      oddsReceivedAt: receipt.observedAt, officialHadQuoteReceipt: receipt};
    // A parent frozen display record and its model clock are never modified.
    const result = row.prospectiveForecastInput ? {...row, prospectiveForecastInput: structuredClone(joined)} : structuredClone(joined);
    receiptHashes.add(receipt.receiptHash); note('had-applied', row); return result;
  });
  return {current: next, receiptHashes};
}
/** Bounded capture diagnostics only: these hashes and booleans never grant
 * source admission. Receipt validation independently rechecks actual bytes. */
function validOfficialHadAudit(audit, capturedAt) {
  try {
    if (Buffer.byteLength(JSON.stringify(audit), 'utf8') > 16384
      || !instant(capturedAt) || !exactKeys(audit, ['version', 'asOf', 'snapshotHash', 'status', 'endpoints', 'reasonCounts', 'samples'])
      || audit.version !== 'official-had-input-audit-v1' || audit.asOf !== capturedAt
      || (audit.snapshotHash !== null && !hex(audit.snapshotHash))
      || !['source-unavailable', 'source-verified'].includes(audit.status) || !exactKeys(audit.endpoints, ['current'])
      || !audit.reasonCounts || typeof audit.reasonCounts !== 'object' || Array.isArray(audit.reasonCounts)
      || Object.keys(audit.reasonCounts).length > REASONS.length || !Array.isArray(audit.samples) || audit.samples.length > 32
      || Object.entries(audit.reasonCounts).some(([reason, count]) => !REASONS.includes(reason) || !Number.isSafeInteger(count) || count < 0)
      || audit.samples.some(sample => !exactKeys(sample, ['sourceMatchId', 'reason'])
        || (sample.sourceMatchId !== '' && !text(sample.sourceMatchId)) || !REASONS.includes(sample.reason))) return false;
    const e = audit.endpoints.current;
    const keys = ['reason', 'receivedAt', 'requestedAt', 'sourceCycleId', 'collectorSignatureVerified', 'payloadHash', 'commitmentHash', 'rows'];
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => !keys.includes(k))
      || !ENDPOINT_REASONS.includes(e.reason) || ['receivedAt', 'requestedAt'].some(k => e[k] !== undefined && e[k] !== null && !instant(e[k]))
      || (e.sourceCycleId !== undefined && e.sourceCycleId !== null && !text(e.sourceCycleId))
      || ['payloadHash', 'commitmentHash'].some(k => e[k] !== undefined && !hex(e[k]))
      || (e.collectorSignatureVerified !== undefined && e.collectorSignatureVerified !== true)
      || (e.rows !== undefined && (!Number.isSafeInteger(e.rows) || e.rows < 0 || e.rows > MAX_ROWS))) return false;
    if (audit.status === 'source-verified' && (e.reason !== 'verified' || e.collectorSignatureVerified !== true
      || !hex(e.payloadHash) || !hex(e.commitmentHash) || !text(e.sourceCycleId) || !instant(e.requestedAt) || !instant(e.receivedAt)
      || !Number.isSafeInteger(e.rows) || ms(e.requestedAt) > ms(e.receivedAt) || ms(e.receivedAt) > ms(capturedAt))) return false;
    return true;
  } catch { return false; }
}
/** Identity-only replay of a complete collector-signed current endpoint. A
 * valid event need not have an open HAD pool. This grants no sale, model or
 * provider admission and never borrows a quote or a frozen decision. */
function identityEndpointClockKnown(endpoint,at) {
  const requested=epochNanoseconds(endpoint?.requestedAt),received=epochNanoseconds(endpoint?.receivedAt);
  const provider=endpoint?.providerObservedAt==null?null:epochNanoseconds(endpoint.providerObservedAt);
  const age=BigInt(MAX_AGE_MS)*1000000n;
  return at!==null&&requested!==null&&received!==null&&requested<=received&&received<=at
    &&at-requested<=age&&at-received<=age
    &&(endpoint?.providerObservedAt==null||(provider!==null&&provider<=received));
}
function verifySignedCurrentEndpointIdentity(endpoint,{asOf,trustRegistry}={}) {
  try {
    const at=epochNanoseconds(asOf),now=at===null?NaN:Number(at/1000000n);
    return Boolean(trustRegistry&&typeof trustRegistry==='object'&&!Array.isArray(trustRegistry)
      &&Number.isSafeInteger(now)&&identityEndpointClockKnown(endpoint,at)&&verifiedCurrent(endpoint,now,trustRegistry));
  }catch{return false;}
}
function verifySignedCurrentEventIdentity(match, endpoint, {asOf, trustRegistry} = {}) {
  try {
    // No implicit filesystem/environment trust in this pure entry point.
    if (!trustRegistry || typeof trustRegistry !== 'object' || Array.isArray(trustRegistry)) return null;
    const at = epochNanoseconds(asOf);
    if (at === null) return null;
    const now = Number(at / 1000000n), identity = inputIdentity(match);
    if (!Number.isSafeInteger(now) || !identity || !identityEndpointClockKnown(endpoint,at)) return null;
    const verified = verifiedCurrent(endpoint, now, trustRegistry);
    if (!verified) return null;
    const rows = verified.records.filter(r => String(r.row.matchId) === identity.sourceMatchId);
    if (rows.length !== 1 || !sameOfficialEvent(identity, rows[0])) return null;
    // Only Sporttery's identified buyEndTime (or its exact copied alias) may
    // supply a local-zone deadline. Explicit prediction deadlines may differ.
    const fields = [['buyEndTime',match.buyEndTime],['cutoffAt',match.cutoffAt],['cutoffTime',match.cutoffTime],
      ['predictionMeta.cutoffTime',match.predictionMeta?.cutoffTime]];
    for (const [field,value] of fields.filter(([,v]) => v != null && v !== '')) {
      const local = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
      if (local && field !== 'buyEndTime' && value !== match.buyEndTime) return null;
      if (clock(value) === null) return null;
    }
    if (match.cutoffAt != null && match.cutoffTime != null && clock(match.cutoffAt) !== clock(match.cutoffTime)) return null;
    const cutoff = saleDeadline(match, rows[0]), event = epochNanoseconds(match.eventVersion);
    if (!Number.isFinite(cutoff) || event === null || BigInt(cutoff)*1000000n > event
      || at >= BigInt(cutoff)*1000000n || epochNanoseconds(endpoint.receivedAt) >= BigInt(cutoff)*1000000n) return null;
    const body = {version:'signed-current-event-identity-v1',source:'sporttery:current:collector-signed',
      sourceVerification:'trusted-collector-signature-and-canonical-payload-rehash;not-provider-signature',
      identity,asOf,saleCutoff:new Date(cutoff).toISOString(),requestedAt:endpoint.requestedAt,
      receivedAt:endpoint.receivedAt,providerObservedAt:endpoint.providerObservedAt ?? null,
      sourceCycleId:endpoint.sourceCycleId,endpointHash:sha256CollectorJson(compactEndpoint(endpoint)),
      payloadHash:sha256CollectorJson(endpoint.payload),rowHash:sha256CollectorJson(rows[0].row),
      collectorCommitmentHash:sha256CollectorJson(endpoint.collectorAttestation.commitment),
      formalEligible:false,productionEligible:false};
    return {...body,contentHash:sha256CollectorJson(body)};
  } catch { return null; }
}
module.exports = {VERSION, LEGACY_VERSION, SOURCE, SOURCE_VERIFICATION, MAX_AGE_MS, MAX_SOURCE_BYTES, MAX_RECEIPT_BYTES, MAX_ROWS,
  verifySignedCurrentEventIdentity,verifySignedCurrentEndpointIdentity,
  REASONS, ENDPOINT_REASONS, joinOfficialHad, signedLiveHadQuoteForMatch, validSignedLiveHadReceipt, validOfficialHadAudit};
