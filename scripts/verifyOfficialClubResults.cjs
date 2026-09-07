const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  applyOfficialClubResult,
  buildEvidenceRecord,
  evidenceHashForRecord,
  isTrustedOfficialClubResult,
  loadSourceManifest,
  parseOfficialClubPage,
  validOfficialClubEvidenceForMatch,
} = require("./syncOfficialClubResults.cjs");
const {
  isTrustedOfficialClubFinal,
  isTrustedOfficialFinal,
} = require("../src/services/matchLifecycle.cjs");

const manifest = loadSourceManifest();
assert.equal(manifest.sources.length, 2);
const sourceById = new Map(manifest.sources.map((source) => [source.sourceMatchId, source]));
const observedAt = "2026-07-29T00:00:00.000Z";
const responseFor = (source, html) => ({
  url: source.sourceUrl,
  html,
  responseSha256: crypto.createHash("sha256").update(html).digest("hex"),
});
const matchFor = (source, homeTeamName, awayTeamName) => ({
  id: `sporttery_${source.sourceMatchId}`,
  sourceMatchId: source.sourceMatchId,
  kickoffTime: source.providerKickoffTime,
  eventVersion: source.providerKickoffTime,
  status: "PENDING_RESULT",
  homeTeamName,
  awayTeamName,
});

const aikSource = sourceById.get("2040641");
const aikMatch = matchFor(aikSource, "赫根", "索尔纳");
const aikHtml = [
  "<title>BK Häcken - AIK Herr | Allsvenskan | 27 juli 2026</title>",
  "<span>Spelad match</span>",
  "<span>19:00</span>",
  "<span>0<!-- --> - <!-- -->0</span>",
].join("");
const aikParsed = parseOfficialClubPage(aikHtml, aikSource);
assert.deepEqual([aikParsed.scoreHome, aikParsed.scoreAway], [0, 0]);
const aikRecord = buildEvidenceRecord(
  aikMatch,
  aikSource,
  aikParsed,
  responseFor(aikSource, aikHtml),
  observedAt,
);
assert.equal(validOfficialClubEvidenceForMatch(aikMatch, aikRecord), true);
const settledAik = applyOfficialClubResult(aikMatch, {
  version: "official-club-results-v1",
  matches: { "2040641": aikRecord },
});
assert.equal(settledAik.status, "FINISHED");
assert.equal(settledAik.scoreHome, 0);
assert.equal(settledAik.scoreAway, 0);
assert.equal(settledAik.resultProvenance.promotionEligible, false);
assert.equal(isTrustedOfficialClubResult(settledAik), true);
assert.equal(isTrustedOfficialClubFinal(settledAik), true);
assert.equal(isTrustedOfficialFinal(settledAik), true);

const rbkSource = sourceById.get("2040642");
const rbkMatch = matchFor(rbkSource, "罗森博格", "腓特烈");
const rbkHtml = [
  "<title>Kamp: Rosenborg - Fredrikstad / Rosenborg</title>",
  "<table><tr><td>Dato</td><td>27. juli 2026</td></tr>",
  "<tr><td>Avspark</td><td>19:00</td></tr>",
  "<tr><td>Sluttresultat</td><td>4 - 0</td></tr></table>",
].join("");
const rbkParsed = parseOfficialClubPage(rbkHtml, rbkSource);
assert.deepEqual([rbkParsed.scoreHome, rbkParsed.scoreAway], [4, 0]);
const rbkRecord = buildEvidenceRecord(
  rbkMatch,
  rbkSource,
  rbkParsed,
  responseFor(rbkSource, rbkHtml),
  observedAt,
);
assert.equal(validOfficialClubEvidenceForMatch(rbkMatch, rbkRecord), true);

assert.equal(
  validOfficialClubEvidenceForMatch(rbkMatch, { ...rbkRecord, scoreHome: 3 }),
  false,
  "a score change without a matching evidence hash must fail closed",
);
assert.equal(
  validOfficialClubEvidenceForMatch(rbkMatch, {
    ...rbkRecord,
    sourceUrl: "https://example.com/fake-result",
  }),
  false,
  "an unapproved host must fail closed",
);

let strictAdmissionChecks = 0;
for (const side of ["scoreHome", "scoreAway"]) {
  for (const value of [null, undefined, false, true, "", " ", "0", [], [0], {}, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...aikRecord, [side]: value };
    invalid.evidenceHash = evidenceHashForRecord(invalid);
    assert.equal(validOfficialClubEvidenceForMatch(aikMatch, invalid), false,
      `non-numeric or invalid ${side} must not become a result, even with a recomputed hash`);
    assert.equal(applyOfficialClubResult(aikMatch, { matches: { "2040641": invalid } }), aikMatch);
    assert.equal(isTrustedOfficialClubResult({ ...settledAik, [side]: value,
      resultProvenance: { ...settledAik.resultProvenance, evidenceHash: invalid.evidenceHash } }), false);
    assert.throws(() => buildEvidenceRecord(aikMatch, aikSource, { ...aikParsed, [side]: value }, responseFor(aikSource, aikHtml), observedAt));
    strictAdmissionChecks++;
  }
}
for (const observedAt of ["2026-09-31T00:00:00Z", "2026-07-28T24:00:00Z", "2026-07-29 00:00:00", true]) {
  const invalid = { ...aikRecord, observedAt };
  assert.equal(validOfficialClubEvidenceForMatch(aikMatch, invalid), false, "invalid or timezone-less observation clock must be rejected");
  assert.throws(() => buildEvidenceRecord(aikMatch, aikSource, aikParsed, responseFor(aikSource, aikHtml), observedAt));
  strictAdmissionChecks++;
}
for (const eventVersion of ["2026-02-30T12:00:00Z", "2026-07-27T24:00:00Z", "2026-07-28 17:00:00"]) {
  const malformedMatch = { ...aikMatch, kickoffTime: eventVersion, eventVersion };
  const invalid = { ...aikRecord, kickoffTime: eventVersion, eventVersion, providerKickoffTime: eventVersion };
  invalid.evidenceHash = evidenceHashForRecord(invalid);
  assert.equal(validOfficialClubEvidenceForMatch(malformedMatch, invalid), false, "normalization cannot turn an invalid event clock into source proof");
  assert.throws(() => buildEvidenceRecord(malformedMatch, { ...aikSource, providerKickoffTime: eventVersion }, aikParsed, responseFor(aikSource, aikHtml), observedAt));
  strictAdmissionChecks++;
}
assert.throws(() => buildEvidenceRecord(aikMatch, { ...aikSource, sourceMatchId: "wrong-event" }, aikParsed, responseFor(aikSource, aikHtml), observedAt));
strictAdmissionChecks++;
const laterAt = "2026-07-30T00:00:00.000Z";
const invalidPrevious = { ...aikRecord, scoreHome: null, firstObservedAt: "1900-01-01T00:00:00Z" };
invalidPrevious.evidenceHash = evidenceHashForRecord(invalidPrevious);
const freshAfterInvalid = buildEvidenceRecord(aikMatch, aikSource, aikParsed, responseFor(aikSource, aikHtml), laterAt, invalidPrevious);
assert.equal(freshAfterInvalid.firstObservedAt, laterAt, "invalid previous null score cannot donate a fake first observation to a real zero score");
assert.equal(freshAfterInvalid.resultRevision, 1);
strictAdmissionChecks++;
const repeated = buildEvidenceRecord(aikMatch, aikSource, aikParsed, responseFor(aikSource, aikHtml), laterAt, aikRecord);
assert.equal(repeated.firstObservedAt, aikRecord.firstObservedAt);
assert.equal(repeated.resultRevision, aikRecord.resultRevision);
assert.equal(repeated.evidenceHash, aikRecord.evidenceHash, "valid legacy score and event hash contract is unchanged");
strictAdmissionChecks++;
const corrected = buildEvidenceRecord(aikMatch, aikSource, { ...aikParsed, scoreHome: 1 }, responseFor(aikSource, aikHtml), laterAt, aikRecord);
assert.equal(corrected.firstObservedAt, laterAt);
assert.equal(corrected.resultRevision, aikRecord.resultRevision + 1);
strictAdmissionChecks++;
// Deliberate parser-generated synthetic evidence for offline recovery tests.
// Never use this store as production input or proof that a page was fetched.
module.exports = { syntheticStore: { version: "official-club-results-v1", matches: { "2040641": aikRecord, "2040642": rbkRecord } }, strictAdmissionChecks };
if (require.main === module) console.log(JSON.stringify({
  ok: true,
  verifier: "official-club-results-v1",
  sources: manifest.sources.length,
  provenScores: {
    "2040641": `${aikParsed.scoreHome}:${aikParsed.scoreAway}`,
    "2040642": `${rbkParsed.scoreHome}:${rbkParsed.scoreAway}`,
  },
  promotionEligible: false,
  tamperRejected: true,
  strictAdmissionChecks,
  syntheticInput: true,
  networkCalls: 0,
}, null, 2));
