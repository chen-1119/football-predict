"use strict";
const assert = require("node:assert/strict");
const { profileFor, fixtureTeamCategoryAudit: audit } = require("./teamCategoryIdentity.cjs");
const { createEntityRegistry, applyFixtureMappingEvidence, fixtureIdentityHashFor, normalizeName, qualifyingFixtureMapping } = require("./entityResolutionRegistry.cjs");
const { confidenceForFixture, mappingVerificationState, buildVerifiedMappingSet, selectVerifiedMappedMatches } = require("./syncApiFootballData.cjs");
let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const at = "2026-09-07T00:00:00.000Z";
const match = { id: "sporttery_category-fixture", sourceMatchId: "category-fixture", homeTeamId: "synthetic_home", awayTeamId: "synthetic_away",
  homeTeamName: "Alpha", homeTeamNameEn: "Alpha", awayTeamName: "Beta", awayTeamNameEn: "Beta", kickoffTime: "2026-09-08T12:00:00Z", leagueNameEn: "Synthetic League" };
const mapping = { sportteryMatchId: match.id, sourceMatchId: match.sourceMatchId, fixtureId: 991, homeTeamId: 81, awayTeamId: 82,
  homeTeamName: "Alpha", awayTeamName: "Beta", fixtureDate: match.kickoffTime, leagueId: 99, leagueName: "Synthetic League", confidence: 1,
  score: { teamScore: 1, timeScore: 1, leagueScore: 1, reversed: false }, matchedAt: at };
const signed = value => ({ ...value, providerEvidence: { responseSha256: "a".repeat(64), fixtureIdentitySha256: fixtureIdentityHashFor(value) } });
const trustContext = { live: true, providerResponseSha256: "a".repeat(64) };
const empty = createEntityRegistry({ createdAt: at });
const registry = applyFixtureMappingEvidence({ registry: empty, match, mapping: signed(mapping), observedAt: at, trustContext }).registry;
const fixtureFor = value => ({ date: value.fixtureDate, league: { name: value.leagueName }, teams: { home: { id: value.homeTeamId, name: value.homeTeamName }, away: { id: value.awayTeamId, name: value.awayTeamName } } });

check("guard covers an actual normalization collision", () => assert.equal(normalizeName("Alpha Women U21"), normalizeName("Alpha")));
for (const label of ["Alpha Women", "Alpha U21", "Alpha U23", "Alpha Reserves", "Alpha II", "Alpha B"]) {
  check(`new and cached mapping reject erased category: ${label}`, () => {
    const changed = signed({ ...mapping, homeTeamName: label });
    const qualification = qualifyingFixtureMapping(changed, {}, { match, trustContext });
    assert.equal(qualification.eligible, false);
    assert.ok(qualification.blockers.some(b => b.startsWith("home-team-category-")));
    const applied = applyFixtureMappingEvidence({ registry: empty, match, mapping: changed, observedAt: at, trustContext });
    assert.equal(applied.changed, false);
    assert.deepEqual(applied.registry, empty);
    for (const knownRegistry of [null, registry]) {
      const scored = confidenceForFixture(match, fixtureFor(changed), knownRegistry);
      assert.equal(scored.teamScore, 0);
      assert.ok(scored.confidence < 0.74);
    }
    assert.equal(mappingVerificationState(match, changed, registry).verified, false);
    const cache = { fixtureMap: { [match.id]: changed } };
    const allowed = buildVerifiedMappingSet([match], cache, registry);
    assert.equal(allowed.size, 0);
    assert.deepEqual(selectVerifiedMappedMatches([match], cache, allowed), []);
  });
}
check("unknown local aliases cannot erase explicit Chinese category", () => {
  const local = { ...match, homeTeamName: "阿尔法女足", homeTeamAliases: ["Alpha"] };
  assert.equal(qualifyingFixtureMapping(signed(mapping), {}, { match: local, trustContext }).eligible, false);
});
check("English and Chinese age/gender markers agree", () => {
  const local = { ...match, homeTeamName: "阿尔法女子U21", homeTeamNameEn: "Alpha Women Under-21" };
  assert.equal(audit(local, { home: "Alpha W U-21", away: "Beta" }).compatible, false); // W in the middle is not asserted to mean women.
  assert.equal(audit(local, { home: "Alpha Women U21", away: "Beta" }).compatible, true);
});
check("same named youth sides can qualify without loosening name or clock gates", () => {
  const local = { ...match, homeTeamName: "Alpha U21", homeTeamNameEn: "Alpha Under-21" };
  const value = signed({ ...mapping, homeTeamName: "Alpha U-21" });
  assert.equal(qualifyingFixtureMapping(value, {}, { match: local, trustContext }).eligible, true);
  const badTime = signed({ ...value, fixtureDate: "2026-10-01T12:00:00Z" });
  assert.equal(qualifyingFixtureMapping(badTime, {}, { match: local, trustContext }).eligible, false);
});
check("different age groups, gender and ambiguous translations have explicit reasons", () => {
  assert.ok(audit({ ...match, homeTeamName: "Alpha U21", homeTeamNameEn: "Alpha U21" }, { home: "Alpha U23", away: "Beta" }).blockers.includes("home-team-category-ageGroup-conflict"));
  assert.ok(audit({ ...match, homeTeamName: "Alpha Men" }, { home: "Alpha Women", away: "Beta" }).blockers.includes("home-team-category-gender-conflict"));
  assert.ok(audit({ ...match, homeTeamName: "Alpha Women", homeTeamNameEn: "Alpha Men" }, { home: "Alpha Women", away: "Beta" }).blockers.includes("home-team-category-gender-ambiguous"));
});
check("one incompatible away side is sufficient to block the fixture", () => assert.equal(audit(match, { home: "Alpha", away: "Beta Women" }).compatible, false));
check("ordinary team names and absent categories are not labelled senior men", () => {
  for (const label of ["Young Boys", "Wolverhampton Wanderers", "West Bromwich Albion", "Bayern Munich", "Womenford FC"]) {
    assert.deepEqual(profileFor([label]), { gender: null, ageGroup: null, squad: null, ambiguous: [] });
  }
  assert.equal(audit(match, { home: "Alpha", away: "Beta" }).compatible, true);
});
check("unchanged exact-ID mapping remains reusable", () => {
  const before = JSON.stringify(registry);
  assert.equal(mappingVerificationState(match, signed(mapping), registry).verified, true);
  assert.equal(JSON.stringify(registry), before);
});
console.log(JSON.stringify({ ok: true, checks, scope: "actual fixture scoring, registry append rejection, cached identity reuse and enrichment allow-list", networkCalls: 0, productionDataTouched: false }, null, 2));
