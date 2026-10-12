'use strict';
// Pure, bounded research staging. No fetch, files, database, model, or publisher.
// verifyOnlineRead is the existing reader's pure receipt replay; readInputs is
// never called. Literal spans and a manual identity review do not admit a source.
const crypto = require('node:crypto');
const { verifyOnlineRead, validateResponse } = require('./readPrematchV3OnlineInputs.cjs');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');

const VERSION = 'official-club-research-staging-v1';
const LIMITS = Object.freeze({ pages: 32, facts: 64, mappings: 128, pageBytes: 4 * 1024 * 1024,
  totalPageBytes: 32 * 1024 * 1024, spanBytes: 1024, totalFactBytes: 8192 });
const OFFICIAL_HOSTS = new Set(['gnistan.fi', 'fcinter.fi', 'www.veikkausliiga.com',
  'www.cbf.com.br', 'credencial.cbf.com.br', 'internacional.com.br', 'www.clubedoremo.com.br',
  'clubedoremo.com.br', 'www.redbullbragantino.com', 'chapecoense.com', 'botafogo.com.br',
  'gremio.net', 'www.gremio.net', 'mirassolfc.com.br', 'ecvitoria.com.br',
  'www.ecvitoria.com.br', 'vasco.com.br', 'www.corinthians.com.br']);
const FACT_KINDS = new Set(['schedule-confirmation', 'availability-statement', 'medical-update', 'source-metadata-conflict']);
const SHA = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function mappingDigest(mapping) { const body = { ...mapping }; delete body.mappingHash; return digest(canonical(body)); }
function check(value, code) { if (!value) throw Error(`CLUB_RESEARCH_${code}`); }
const beforeOrEqual = (a, b) => epochNanoseconds(a) !== null && epochNanoseconds(b) !== null
  && epochNanoseconds(a) <= epochNanoseconds(b);
function utf8(bytes, code) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Error(`CLUB_RESEARCH_${code}`); }
}
function replaySpan(span, page) {
  check(object(span) && Number.isSafeInteger(span.byteStart) && Number.isSafeInteger(span.byteEnd)
    && span.byteStart >= 0 && span.byteEnd > span.byteStart && span.byteEnd <= page.rawBytes.length
    && span.byteEnd - span.byteStart <= LIMITS.spanBytes && typeof span.text === 'string', 'SPAN_BOUND');
  const bytes = page.rawBytes.subarray(span.byteStart, span.byteEnd);
  check(utf8(bytes, 'SPAN_UTF8') === span.text && Buffer.from(span.text, 'utf8').equals(bytes), 'SPAN_MISMATCH');
  return { byteStart: span.byteStart, byteEnd: span.byteEnd, text: span.text, sha256: digest(bytes) };
}
function pageRecord(page, stagedAt) {
  check(object(page) && text(page.pageId) && text(page.url, 2048), 'PAGE');
  let url;
  try { url = new URL(page.url); } catch { throw Error('CLUB_RESEARCH_PAGE_URL'); }
  check(url.protocol === 'https:' && OFFICIAL_HOSTS.has(url.hostname) && !url.port && !url.username
    && !url.password && !url.hash && !url.search && url.href === page.url, 'PAGE_URL');
  // Bragantino expressly disallows these public robots paths. No hidden API.
  check(!(url.hostname === 'www.redbullbragantino.com' && /^\/v3(?:\/|$)/.test(url.pathname)), 'PAGE_PATH');
  check(Buffer.isBuffer(page.rawBytes) && page.rawBytes.length > 0 && page.rawBytes.length <= LIMITS.pageBytes
    && page.byteLength === page.rawBytes.length && SHA.test(page.rawSha256 || '')
    && digest(page.rawBytes) === page.rawSha256, 'PAGE_BYTES');
  check(!utf8(page.rawBytes, 'PAGE_UTF8').includes('\uFFFD'), 'PAGE_REPLACEMENT_CHARACTER');
  check(Number.isInteger(page.status) && page.status >= 100 && page.status <= 599
    && text(page.contentType, 128) && ['unknown', 'restricted'].includes(page.permissionStatus)
    && page.followedRedirect === false && page.retries === 0, 'PAGE_RECEIPT');
  check(page.clockBasis === 'actual-http-response-observation' && beforeOrEqual(page.requestedAt, page.receivedAt)
    && beforeOrEqual(page.receivedAt, stagedAt), 'PAGE_CLOCK');
  const accepted = page.status === 200 && /^text\/(html|plain)(?:;|$)/i.test(page.contentType);
  let sourcePublishedAt = null, publicationEvidence = null;
  if (page.publication != null) {
    check(accepted && object(page.publication) && epochNanoseconds(page.publication.instant) !== null
      && beforeOrEqual(page.publication.instant, page.receivedAt), 'PUBLICATION_CLOCK');
    publicationEvidence = replaySpan(page.publication.span, page);
    check(publicationEvidence.text === page.publication.instant, 'PUBLICATION_SPAN');
    sourcePublishedAt = page.publication.instant;
  }
  return { page, descriptor: { pageId: page.pageId, url: page.url, httpStatus: page.status,
    contentType: page.contentType, rawSha256: page.rawSha256, rawBytes: page.byteLength,
    requestedAt: page.requestedAt, receivedAt: page.receivedAt, clockBasis: page.clockBasis,
    sourcePublishedAt, publicationEvidence, permissionStatus: page.permissionStatus,
    sourceVerification: 'unverified', admittedToFeatures: false, formalEligible: false,
    acceptedForLiteralResearch: accepted, unavailableReason: accepted ? null : `http-or-content-unavailable:${page.status}` } };
}
function validateMapping(mapping, match, pages, stagedAt, onlineKnownAt) {
  check(object(mapping) && SHA.test(mapping.mappingHash || '') && mapping.mappingHash === mappingDigest(mapping)
    && mapping.sourceMatchId === match.sourceMatchId && mapping.businessDate === match.businessDate
    && epochNanoseconds(mapping.eventVersion) === epochNanoseconds(match.eventVersion)
    && mapping.homeTeamId === match.homeTeamId && mapping.awayTeamId === match.awayTeamId
    && mapping.homeOnlineName === match.homeTeamName && mapping.awayOnlineName === match.awayTeamName, 'MAPPING_EVENT');
  check(text(match.homeTeamId) && text(match.awayTeamId) && match.homeTeamId !== match.awayTeamId
    && text(match.homeTeamName) && text(match.awayTeamName) && beforeOrEqual(mapping.reviewedAt, stagedAt)
    && beforeOrEqual(onlineKnownAt, mapping.reviewedAt)
    && mapping.reviewMethod === 'manual-primary-source-event-and-ordered-team-review'
    && Array.isArray(mapping.evidence) && mapping.evidence.length <= LIMITS.pages * 2, 'MAPPING_REVIEW');
  const hasSource = mapping.status === 'manual-page-names-reviewed';
  check(hasSource || mapping.status === 'unresolved', 'MAPPING_STATUS');
  if (!hasSource) {
    check(mapping.officialHomeName === null && mapping.officialAwayName === null && mapping.evidence.length === 0, 'UNRESOLVED_MAPPING');
  } else check(text(mapping.officialHomeName) && text(mapping.officialAwayName)
    && mapping.officialHomeName !== mapping.officialAwayName, 'MAPPING_NAMES');
  const evidence = mapping.evidence.map(ref => {
    check(object(ref) && ['home', 'away'].includes(ref.side) && pages.has(ref.pageId), 'MAPPING_PAGE');
    const selected = pages.get(ref.pageId);
    check(selected.descriptor.acceptedForLiteralResearch && beforeOrEqual(selected.descriptor.receivedAt, mapping.reviewedAt), 'MAPPING_PAGE_CLOCK');
    const span = replaySpan(ref.span, selected.page);
    check(span.text === (ref.side === 'home' ? mapping.officialHomeName : mapping.officialAwayName), 'MAPPING_NAME_SPAN');
    return { pageId: ref.pageId, side: ref.side, span };
  });
  if (hasSource) check(['home', 'away'].every(side => evidence.some(ref => ref.side === side)), 'MAPPING_SIDES');
  return { sourceMatchId: match.sourceMatchId, eventVersion: match.eventVersion, businessDate: match.businessDate,
    homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, homeOnlineName: match.homeTeamName,
    awayOnlineName: match.awayTeamName, officialHomeName: mapping.officialHomeName,
    officialAwayName: mapping.officialAwayName, mappingHash: mapping.mappingHash, reviewedAt: mapping.reviewedAt,
    status: mapping.status, reviewMethod: mapping.reviewMethod, evidence,
    providerTeamIds: { home: null, away: null }, sourceVerification: 'unverified', formalEligible: false };
}
function stageOfficialClubResearchEvidence({ onlineInput, rawRemoteResponse, identityMappings, pages, facts, stagedAt } = {}) {
  check(object(onlineInput) && verifyOnlineRead(onlineInput, { date: onlineInput.businessDate, rawResponse: rawRemoteResponse }), 'ONLINE_READER_PROOF');
  const validation = validateResponse(onlineInput, onlineInput.businessDate);
  check(validation.missingFields.length === 0 && beforeOrEqual(onlineInput.transport.finishedAt, stagedAt)
    && beforeOrEqual(onlineInput.observedAt, stagedAt), 'ONLINE_READY');
  check(Array.isArray(pages) && pages.length <= LIMITS.pages && Array.isArray(facts) && facts.length <= LIMITS.facts
    && Array.isArray(identityMappings) && identityMappings.length === onlineInput.matches.length
    && identityMappings.length <= LIMITS.mappings, 'INPUT_BOUND');
  check(pages.reduce((sum, page) => sum + (page?.rawBytes?.length || 0), 0) <= LIMITS.totalPageBytes, 'TOTAL_PAGE_BYTES');
  const pageMap = new Map(), mappingMap = new Map(), matches = new Map();
  for (const page of pages) {
    const record = pageRecord(page, stagedAt);
    check(!pageMap.has(record.descriptor.pageId), 'PAGE_DUPLICATE');
    pageMap.set(record.descriptor.pageId, record);
  }
  for (const match of onlineInput.matches) {
    check(!matches.has(match.sourceMatchId), 'EVENT_DUPLICATE');
    matches.set(match.sourceMatchId, match);
  }
  for (const mapping of identityMappings) {
    check(matches.has(mapping?.sourceMatchId) && !mappingMap.has(mapping.sourceMatchId), 'MAPPING_DUPLICATE_OR_FOREIGN');
    mappingMap.set(mapping.sourceMatchId, validateMapping(mapping, matches.get(mapping.sourceMatchId), pageMap, stagedAt, onlineInput.transport.finishedAt));
  }
  const factIds = new Set(); let factBytes = 0;
  const stagedFacts = facts.map(fact => {
    const allowed = ['factId', 'kind', 'sourceMatchId', 'side', 'pageId', 'span', 'subjectNames', 'manualAvailabilityClaim'];
    check(object(fact) && Object.keys(fact).every(key => allowed.includes(key)) && text(fact.factId)
      && !factIds.has(fact.factId) && FACT_KINDS.has(fact.kind), 'FACT_KIND_OR_FIELDS');
    factIds.add(fact.factId);
    const mapping = mappingMap.get(fact.sourceMatchId), selected = pageMap.get(fact.pageId);
    check(mapping && mapping.status === 'manual-page-names-reviewed' && ['home', 'away'].includes(fact.side)
      && selected?.descriptor.acceptedForLiteralResearch
      && mapping.evidence.some(ref => ref.side === fact.side && ref.pageId === fact.pageId), 'FACT_IDENTITY');
    const excerpt = replaySpan(fact.span, selected.page);
    factBytes += excerpt.byteEnd - excerpt.byteStart;
    check(factBytes <= LIMITS.totalFactBytes && Array.isArray(fact.subjectNames) && fact.subjectNames.length <= 11
      && new Set(fact.subjectNames).size === fact.subjectNames.length
      && fact.subjectNames.every(name => text(name, 100) && excerpt.text.includes(name)), 'FACT_SUBJECTS_OR_BYTES');
    check(['out', 'unknown'].includes(fact.manualAvailabilityClaim)
      && (fact.kind === 'availability-statement' || fact.manualAvailabilityClaim === 'unknown'), 'FACT_AVAILABILITY');
    return { factId: fact.factId, kind: fact.kind, sourceMatchId: fact.sourceMatchId,
      eventVersion: mapping.eventVersion, businessDate: mapping.businessDate, side: fact.side,
      teamId: fact.side === 'home' ? mapping.homeTeamId : mapping.awayTeamId,
      pageId: fact.pageId, url: selected.descriptor.url, rawPayloadHash: selected.descriptor.rawSha256,
      receivedAt: selected.descriptor.receivedAt, sourcePublishedAt: selected.descriptor.sourcePublishedAt,
      mappingHash: mapping.mappingHash, identityMappingReviewedAt: mapping.reviewedAt, excerpt,
      extraction: 'manual-extracted-literal-research-fact;semantic-claim-not-machine-verified',
      subjects: fact.subjectNames.map(name => ({ rawName: name, playerId: null, identityStatus: 'unknown', availability: 'unknown' })),
      manualAvailabilityClaim: fact.manualAvailabilityClaim, permissionStatus: selected.descriptor.permissionStatus,
      sourceVerification: 'unverified', admittedToFeatures: false, formalEligible: false };
  });
  const coverage = onlineInput.matches.map(match => {
    const mapping = mappingMap.get(match.sourceMatchId), eventFacts = stagedFacts.filter(fact => fact.sourceMatchId === match.sourceMatchId);
    const refs = [...new Set(mapping.evidence.map(ref => ref.pageId))];
    const assessment = match.prospectiveForecastInput?.prematchV3Assessment;
    const team = assessment?.teamSnapshot;
    const featureValues = object(team?.features) ? Object.values(team.features) : null;
    const featureValuesKnown = featureValues !== null
      && featureValues.every(value => value === null || (typeof value === 'number' && Number.isFinite(value)));
    return { sourceMatchId: match.sourceMatchId, eventVersion: match.eventVersion, businessDate: match.businessDate,
      homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, identityMapping: mapping,
      collectedResearch: { nativePages: refs.length, pageIds: refs, facts: eventFacts.length,
        factIds: eventFacts.map(fact => fact.factId), targetStartingXIConfirmed: false,
        actualPreviousMatchEndedAt: null, completeTeamHistory: false, observedXg: null },
      onlineModel: { observationCount: Array.isArray(team?.observations) ? team.observations.length : null,
        knownFeatureCount: featureValuesKnown ? featureValues.filter(value => value !== null).length : null,
        totalFeatureCount: featureValues !== null ? featureValues.length : null,
        registryStatus: assessment?.modelRegistry?.status ?? null, registryBlockers: assessment?.modelRegistry?.blockers || [] },
      unavailableForFormal: ['source-verification-unverified', 'source-permission-not-admitted',
        'research-facts-not-model-features', ...(eventFacts.some(fact => fact.subjects.length) ? ['player-stable-id-unknown'] : []),
        ...(mapping.status === 'unresolved' ? ['official-page-identity-unresolved'] : []),
        ...(assessment?.modelRegistry?.blockers || [])], formalEligible: false };
  });
  const body = { version: VERSION, stagedAt, businessDate: onlineInput.businessDate,
    onlineRead: { readerValidated: true, validation, observedAt: onlineInput.observedAt,
      rawResponseSha256: digest(rawRemoteResponse), rawResponseBytes: rawRemoteResponse.length,
      generation: structuredClone(onlineInput.generation), transportStartedAt: onlineInput.transport.startedAt,
      transportFinishedAt: onlineInput.transport.finishedAt, integrityScope: 'existing-readonly-reader-replay;not-new-provider-signature-or-live-observation' },
    pages: [...pageMap.values()].map(value => value.descriptor), facts: stagedFacts, coverage,
    modelArtifacts: onlineInput.modelArtifacts.length, actualTraining: false, numericFeatures: null,
    sourceVerification: 'unverified', productionWrites: 0, publisherWrites: 0, formalEligible: false,
    scope: 'private-research-staging-only;no-result-endtime-restdays-injury-impact-xg-or-complete-history-inference' };
  return { ...body, contentHash: digest(canonical(body)) };
}

module.exports = { VERSION, LIMITS, mappingDigest, replaySpan, stageOfficialClubResearchEvidence };
