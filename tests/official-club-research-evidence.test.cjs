'use strict';
// Entire fixture is synthetic contract data. No website, PG, past local match,
// prediction accuracy, provider admission or training is exercised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { VERSION: READER_VERSION, validateTransport } = require('../scripts/readPrematchV3OnlineInputs.cjs');
const { mappingDigest, stageOfficialClubResearchEvidence, LIMITS } = require('../scripts/officialClubResearchEvidence.cjs');
const { FEATURE_SCHEMA } = require('../src/services/prematchTeamEvidenceV3.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function span(bytes, text) {
  const byteStart = bytes.indexOf(Buffer.from(text));
  assert.ok(byteStart >= 0, 'fixture text must exist');
  return { byteStart, byteEnd: byteStart + Buffer.byteLength(text), text };
}
function reseal(fixture) { fixture.identityMappings[0].mappingHash = mappingDigest(fixture.identityMappings[0]); return fixture; }
function changeAssessment(fixture, change) {
  const original = JSON.parse(fixture.rawRemoteResponse);
  change(original.matches[0].prospectiveForecastInput.prematchV3Assessment);
  fixture.rawRemoteResponse = Buffer.from(JSON.stringify(original));
  fixture.onlineInput = { ...original, transport: { ...fixture.onlineInput.transport,
    remoteResponseSha256: hash(fixture.rawRemoteResponse), bytes: fixture.rawRemoteResponse.length } };
  return fixture;
}
function fixture() {
  const original = { version: READER_VERSION, readOnly: 'on', productionWrites: 0, businessDate: '2026-10-07',
    observedAt: '2026-10-07T12:00:00Z', generation: { data_generation_id: 'synthetic-research-generation', manifest_hash: 'a'.repeat(64), committed_at: '2026-10-07T11:00:00Z' },
    modelArtifacts: [], modelArtifactInventory: [], matches: [{ id: 'sporttery_123', sourceMatchId: '123',
      businessDate: '2026-10-07', homeTeamId: 'synthetic-alpha', awayTeamId: 'synthetic-bravo',
      homeTeamName: '合成甲', awayTeamName: '合成乙', kickoffTime: '2026-10-07T23:00:00Z',
      eventVersion: '2026-10-07T23:00:00Z', cutoffAt: '2026-10-07T22:00:00Z',
      prospectiveForecastInput: { prematchV3Assessment: { teamSnapshot: { version: 'prematch-team-evidence-v3', observations: [],
        features: Object.fromEntries(FEATURE_SCHEMA.features.map(name => [name, null])) },
        modelRegistry: { status: 'missing', blockers: ['baseline:missing', 'parameters:missing'] } } } }] };
  const rawRemoteResponse = Buffer.from(JSON.stringify(original));
  const transport = { hostKeyPinVerified: true, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`,
    startedAt: '2026-10-07T11:59:59Z', finishedAt: '2026-10-07T12:00:01Z',
    remoteResponseSha256: hash(rawRemoteResponse), remoteResponseFile: 'synthetic.remote-response.json', bytes: rawRemoteResponse.length };
  Object.assign(transport, validateTransport(transport, original.observedAt));
  const body = Buffer.from('<title>Alpha vs Bravo: synthetic</title><time>2026-10-07T11:00:00Z</time><p>Åda is absent; other players are fit.</p><p>Future placeholder: 0-0, 90 minutes; planned endTime 23:59.</p>');
  const page = { pageId: 'synthetic-page', url: 'https://gnistan.fi/synthetic-fixture/', rawBytes: body,
    byteLength: body.length, rawSha256: hash(body), status: 200, contentType: 'text/html; charset=utf-8',
    requestedAt: '2026-10-07T11:59:57Z', receivedAt: '2026-10-07T11:59:58Z',
    clockBasis: 'actual-http-response-observation', permissionStatus: 'unknown', followedRedirect: false, retries: 0,
    publication: { instant: '2026-10-07T11:00:00Z', span: span(body, '2026-10-07T11:00:00Z') } };
  const identity = { sourceMatchId: '123', eventVersion: original.matches[0].eventVersion, businessDate: original.businessDate,
    homeTeamId: 'synthetic-alpha', awayTeamId: 'synthetic-bravo', homeOnlineName: '合成甲', awayOnlineName: '合成乙',
    officialHomeName: 'Alpha', officialAwayName: 'Bravo', reviewedAt: '2026-10-07T12:00:02Z',
    reviewMethod: 'manual-primary-source-event-and-ordered-team-review', status: 'manual-page-names-reviewed',
    evidence: [{ pageId: page.pageId, side: 'home', span: span(body, 'Alpha') }, { pageId: page.pageId, side: 'away', span: span(body, 'Bravo') }] };
  const fact = { factId: 'synthetic-absence', kind: 'availability-statement', sourceMatchId: '123', side: 'home', pageId: page.pageId,
    span: span(body, 'Åda is absent; other players are fit.'), subjectNames: ['Åda'], manualAvailabilityClaim: 'out' };
  return reseal({ onlineInput: { ...original, transport }, rawRemoteResponse, identityMappings: [identity], pages: [page], facts: [fact], stagedAt: '2026-10-07T12:00:03Z' });
}

test('literal facts are hash-bound to valid readonly reader and remain research only', () => {
  const f = fixture(), out = stageOfficialClubResearchEvidence(f);
  assert.equal(out.onlineRead.readerValidated, true); assert.equal(out.onlineRead.rawResponseSha256, hash(f.rawRemoteResponse));
  assert.equal(out.facts[0].excerpt.text, f.facts[0].span.text); assert.equal(out.facts[0].manualAvailabilityClaim, 'out');
  assert.deepEqual(out.facts[0].subjects, [{ rawName: 'Åda', playerId: null, identityStatus: 'unknown', availability: 'unknown' }]);
  assert.equal(out.facts[0].rawPayloadHash, hash(f.pages[0].rawBytes));
  assert.equal(out.sourceVerification, 'unverified'); assert.equal(out.formalEligible, false);
  assert.equal(out.numericFeatures, null); assert.equal(out.actualTraining, false);
  assert.equal(out.productionWrites, 0); assert.equal(out.publisherWrites, 0);
  assert.equal(out.pages[0].admittedToFeatures, false); assert.equal(out.coverage[0].onlineModel.knownFeatureCount, 0);
  assert.equal(out.coverage[0].onlineModel.observationCount, 0);
  assert.equal(out.coverage[0].onlineModel.totalFeatureCount, FEATURE_SCHEMA.features.length);
});
test('actual teamSnapshot structure reports nonzero observed counts including a numeric zero feature', () => {
  const f = changeAssessment(fixture(), assessment => {
    assessment.teamSnapshot.observations = [{ synthetic: 'first' }, { synthetic: 'second' }];
    assessment.teamSnapshot.features['home.fatigue.restDays'] = 0;
    assessment.teamSnapshot.features['away.fatigue.restDays'] = 3;
  });
  const out = stageOfficialClubResearchEvidence(f);
  assert.equal(out.coverage[0].onlineModel.observationCount, 2);
  assert.equal(out.coverage[0].onlineModel.knownFeatureCount, 2);
  assert.equal(out.numericFeatures, null); assert.equal(out.formalEligible, false);
});
test('missing teamSnapshot remains unknown rather than reporting invented zero coverage', () => {
  for (const remove of [assessment => { delete assessment.teamSnapshot; }, assessment => { assessment.teamSnapshot = null; }]) {
    const f = changeAssessment(fixture(), remove), out = stageOfficialClubResearchEvidence(f);
    assert.equal(out.coverage[0].onlineModel.observationCount, null);
    assert.equal(out.coverage[0].onlineModel.knownFeatureCount, null);
    assert.equal(out.coverage[0].onlineModel.totalFeatureCount, null);
  }
});
test('obsolete teamEvidence cannot hide or substitute the actual teamSnapshot', () => {
  const f = changeAssessment(fixture(), assessment => {
    assessment.teamEvidence = { observations: [{ misleading: true }], features: { imaginary: 99 } };
  });
  assert.equal(stageOfficialClubResearchEvidence(f).coverage[0].onlineModel.observationCount, 0);
  const missing = changeAssessment(f, assessment => { delete assessment.teamSnapshot; });
  assert.equal(stageOfficialClubResearchEvidence(missing).coverage[0].onlineModel.observationCount, null);
});
test('malformed snapshot collections or nonnumeric feature values remain unknown', () => {
  const f = changeAssessment(fixture(), assessment => {
    assessment.teamSnapshot.observations = 'not observations'; assessment.teamSnapshot.features = [];
  });
  const out = stageOfficialClubResearchEvidence(f);
  assert.equal(out.coverage[0].onlineModel.observationCount, null);
  assert.equal(out.coverage[0].onlineModel.knownFeatureCount, null);
  const value = changeAssessment(fixture(), assessment => { assessment.teamSnapshot.features['home.fatigue.restDays'] = 'unknown'; });
  assert.equal(stageOfficialClubResearchEvidence(value).coverage[0].onlineModel.knownFeatureCount, null);
});
test('same immutable inputs give same content hash without input mutation', () => {
  const f = fixture(), before = JSON.stringify(f);
  assert.equal(stageOfficialClubResearchEvidence(f).contentHash, stageOfficialClubResearchEvidence(f).contentHash);
  assert.equal(JSON.stringify(f), before);
});
test('unknown or restricted permission never promotes sources or features', () => {
  for (const permissionStatus of ['unknown', 'restricted']) {
    const f = fixture(); f.pages[0].permissionStatus = permissionStatus;
    const out = stageOfficialClubResearchEvidence(f);
    assert.equal(out.pages[0].permissionStatus, permissionStatus);
    assert.equal(out.pages[0].sourceVerification, 'unverified'); assert.equal(out.formalEligible, false);
    assert.equal(out.numericFeatures, null);
  }
});
test('remote original bytes and parsed online payload cannot drift independently', () => {
  const f = fixture(); f.rawRemoteResponse = Buffer.concat([f.rawRemoteResponse, Buffer.from(' ')]);
  assert.throws(() => stageOfficialClubResearchEvidence(f), /ONLINE_READER_PROOF/);
  const changed = fixture(); changed.onlineInput.matches[0].homeTeamId = 'other';
  assert.throws(() => stageOfficialClubResearchEvidence(changed), /ONLINE_READER_PROOF/);
});
test('an unpinned claimed online receipt is rejected', () => {
  const f = fixture(); f.onlineInput.transport.hostKeyPinVerified = false;
  assert.throws(() => stageOfficialClubResearchEvidence(f), /ONLINE_READER_PROOF/);
});
test('missing cutoff is not repaired by a website schedule', () => {
  const f = fixture(); const original = JSON.parse(f.rawRemoteResponse); delete original.matches[0].cutoffAt;
  f.rawRemoteResponse = Buffer.from(JSON.stringify(original));
  f.onlineInput = { ...original, transport: { ...f.onlineInput.transport, remoteResponseSha256: hash(f.rawRemoteResponse), bytes: f.rawRemoteResponse.length } };
  assert.throws(() => stageOfficialClubResearchEvidence(f), /ONLINE_READY/);
});
for (const key of ['homeTeamId', 'awayTeamId', 'homeOnlineName', 'businessDate', 'eventVersion']) {
  test(`explicit mapping rejects changed ${key} even after local hash re-seal`, () => {
    const f = fixture(); f.identityMappings[0][key] = 'different-event-or-team'; reseal(f);
    assert.throws(() => stageOfficialClubResearchEvidence(f), /MAPPING_EVENT/);
  });
}
test('swapping sides and using HJK without literal Gnistan mapping evidence fails', () => {
  const f = fixture(); [f.identityMappings[0].homeTeamId, f.identityMappings[0].awayTeamId] = [f.identityMappings[0].awayTeamId, f.identityMappings[0].homeTeamId]; reseal(f);
  assert.throws(() => stageOfficialClubResearchEvidence(f), /MAPPING_EVENT/);
  const guessed = fixture(); guessed.identityMappings[0].officialHomeName = 'HJK'; reseal(guessed);
  assert.throws(() => stageOfficialClubResearchEvidence(guessed), /MAPPING_NAME_SPAN/);
});
test('manual review must occur after both receipt and current online identity knowledge', () => {
  const f = fixture(); f.identityMappings[0].reviewedAt = '2026-10-07T12:00:00Z'; reseal(f);
  assert.throws(() => stageOfficialClubResearchEvidence(f), /MAPPING_REVIEW/);
  const future = fixture(); future.identityMappings[0].reviewedAt = '2026-10-07T12:00:03.000000001Z'; reseal(future);
  assert.throws(() => stageOfficialClubResearchEvidence(future), /MAPPING_REVIEW/);
});
test('raw page hash, byte count, and UTF8 must all be exact', () => {
  const changed = fixture(); changed.pages[0].rawSha256 = 'f'.repeat(64);
  assert.throws(() => stageOfficialClubResearchEvidence(changed), /PAGE_BYTES/);
  const count = fixture(); count.pages[0].byteLength += 1;
  assert.throws(() => stageOfficialClubResearchEvidence(count), /PAGE_BYTES/);
  const invalid = fixture(); invalid.pages[0].rawBytes = Buffer.from([0xff]); invalid.pages[0].byteLength = 1; invalid.pages[0].rawSha256 = hash(invalid.pages[0].rawBytes);
  assert.throws(() => stageOfficialClubResearchEvidence(invalid), /PAGE_UTF8/);
  const replacement = fixture(); replacement.pages[0].rawBytes = Buffer.from('�'); replacement.pages[0].byteLength = 3; replacement.pages[0].rawSha256 = hash(replacement.pages[0].rawBytes);
  assert.throws(() => stageOfficialClubResearchEvidence(replacement), /PAGE_REPLACEMENT_CHARACTER/);
});
test('literal span offsets and Unicode byte boundaries must replay precisely', () => {
  const f = fixture(); f.facts[0].span.text = 'invented injury';
  assert.throws(() => stageOfficialClubResearchEvidence(f), /SPAN_MISMATCH/);
  const partial = fixture(); partial.facts[0].span.byteStart += 1;
  assert.throws(() => stageOfficialClubResearchEvidence(partial), /SPAN_UTF8/);
});
test('page or publication observation one nanosecond in the future is rejected', () => {
  const f = fixture(); f.pages[0].receivedAt = '2026-10-07T12:00:03.000000001Z';
  assert.throws(() => stageOfficialClubResearchEvidence(f), /PAGE_CLOCK/);
  const publication = fixture(); publication.pages[0].publication.instant = '2026-10-07T12:00:04Z';
  assert.throws(() => stageOfficialClubResearchEvidence(publication), /PUBLICATION_CLOCK/);
});
test('date-only text cannot be invented into a publication instant', () => {
  const f = fixture(); f.pages[0].publication = null;
  assert.equal(stageOfficialClubResearchEvidence(f).pages[0].sourcePublishedAt, null);
  const date = fixture(); date.pages[0].publication.instant = '2026-10-07';
  assert.throws(() => stageOfficialClubResearchEvidence(date), /PUBLICATION_CLOCK/);
});
test('blocked pages remain unavailable; no inferred source or fact is produced', () => {
  const f = fixture(); f.pages[0].status = 403; f.pages[0].publication = null; f.facts = [];
  Object.assign(f.identityMappings[0], { status: 'unresolved', officialHomeName: null, officialAwayName: null, evidence: [] }); reseal(f);
  const out = stageOfficialClubResearchEvidence(f);
  assert.equal(out.pages[0].acceptedForLiteralResearch, false); assert.equal(out.coverage[0].collectedResearch.nativePages, 0);
  assert.deepEqual(out.facts, []); assert.equal(out.coverage[0].formalEligible, false);
});
test('future 0-0, default 90 minutes and planned endTime are never typed results or rest', () => {
  const f = fixture(); f.facts = [];
  const out = stageOfficialClubResearchEvidence(f);
  assert.equal(out.coverage[0].collectedResearch.actualPreviousMatchEndedAt, null);
  assert.equal(out.coverage[0].collectedResearch.completeTeamHistory, false); assert.equal(out.numericFeatures, null);
  for (const kind of ['result', 'match-ended-at', 'fatigue', 'rest-days', 'xg', 'complete-history', 'roster-confirmed']) {
    const bad = fixture(); bad.facts[0].kind = kind;
    assert.throws(() => stageOfficialClubResearchEvidence(bad), /FACT_KIND_OR_FIELDS/);
  }
});
test('medical bulletins retain unknown availability and no stable player ID', () => {
  const f = fixture(); f.facts[0].kind = 'medical-update'; f.facts[0].manualAvailabilityClaim = 'unknown';
  assert.equal(stageOfficialClubResearchEvidence(f).facts[0].subjects[0].availability, 'unknown');
  const guessed = fixture(); guessed.facts[0].kind = 'medical-update';
  assert.throws(() => stageOfficialClubResearchEvidence(guessed), /FACT_AVAILABILITY/);
  const id = fixture(); id.facts[0].playerId = 'guessed-player';
  assert.throws(() => stageOfficialClubResearchEvidence(id), /FACT_KIND_OR_FIELDS/);
});
test('a quoted name absent from the literal span cannot be attached as a player', () => {
  const f = fixture(); f.facts[0].subjectNames = ['someone else'];
  assert.throws(() => stageOfficialClubResearchEvidence(f), /FACT_SUBJECTS_OR_BYTES/);
});
test('unapproved domains, file URLs, credentials, query routes and hidden APIs fail closed', () => {
  for (const url of ['file:///tmp/data', 'http://gnistan.fi/a', 'https://evil.invalid/a',
    'https://x:y@gnistan.fi/a', 'https://gnistan.fi/a?api=1', 'https://www.redbullbragantino.com/v3/api/graphql/v1']) {
    const f = fixture(); f.pages[0].url = url;
    assert.throws(() => stageOfficialClubResearchEvidence(f), /PAGE_URL|PAGE_PATH/);
  }
});
test('duplicate pages, mappings, facts and oversized spans are rejected', () => {
  const page = fixture(); page.pages.push(page.pages[0]);
  assert.throws(() => stageOfficialClubResearchEvidence(page), /PAGE_DUPLICATE/);
  const fact = fixture(); fact.facts.push(fact.facts[0]);
  assert.throws(() => stageOfficialClubResearchEvidence(fact), /FACT_KIND_OR_FIELDS/);
  const mapping = fixture(); mapping.identityMappings.push(mapping.identityMappings[0]);
  assert.throws(() => stageOfficialClubResearchEvidence(mapping), /INPUT_BOUND/);
  const huge = fixture(); huge.facts[0].span.byteEnd = huge.facts[0].span.byteStart + LIMITS.spanBytes + 1;
  assert.throws(() => stageOfficialClubResearchEvidence(huge), /SPAN_BOUND/);
});
