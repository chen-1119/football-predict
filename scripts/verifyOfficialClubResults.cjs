const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  applyOfficialClubResult,
  buildEvidenceRecord,
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

console.log(JSON.stringify({
  ok: true,
  verifier: "official-club-results-v1",
  sources: manifest.sources.length,
  provenScores: {
    "2040641": `${aikParsed.scoreHome}:${aikParsed.scoreAway}`,
    "2040642": `${rbkParsed.scoreHome}:${rbkParsed.scoreAway}`,
  },
  promotionEligible: false,
  tamperRejected: true,
}, null, 2));
