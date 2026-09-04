"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  DEFAULT_BUNDLED_ARTIFACT,
  buildFootballDataDisciplineIndex,
  canonicalTeamKey,
  refereeDisciplineProfile,
  teamDisciplineProfile,
} = require("./footballDataDiscipline.cjs");

const index = buildFootballDataDisciplineIndex();
assert.ok(index.files.length >= 10, "expected the downloaded main-league Football-Data files");
assert.ok(index.accepted > 1000, "expected observed card rows from Football-Data");

const bundledIndex = buildFootballDataDisciplineIndex({
  sourceDir: path.join(__dirname, "__missing-football-data-source__"),
  bundledArtifactFile: DEFAULT_BUNDLED_ARTIFACT,
});
assert.equal(bundledIndex.asset?.kind, "signed-release-artifact", "production fallback must use the signed asset");
assert.equal(bundledIndex.accepted, index.accepted, "signed asset must preserve all accepted rows");
assert.equal(bundledIndex.teams.size, index.teams.size, "signed asset must preserve team coverage");

const cutoff = "2026-08-26T02:00:00+08:00";
for (const names of [
  ["斯托克城", "stoke"],
  ["赫尔城", "hull"],
  ["诺丁汉森林", "nottm forest"],
  ["利兹联", "leeds"],
  ["伯明翰", "birmingham"],
  ["布伦特福德", "brentford"],
  ["巴伦西亚", "valencia"],
  ["皇家贝蒂斯", "betis"],
]) {
  const profile = teamDisciplineProfile(index, names, cutoff);
  assert.ok(profile?.cardRows >= 5, `${names[0]} should have an as-of card profile`);
  assert.equal(profile.source, "football-data.co.uk-match-statistics");
  assert.ok(profile.sampleTo < "2026-08-26", "date-only rows must be strictly before the forecast date");
}

assert.equal(canonicalTeamKey("斯托克城"), "stoke");
assert.equal(canonicalTeamKey("Nott'm Forest"), "nottm forest");

const referee = refereeDisciplineProfile(index, "A Taylor", cutoff);
assert.ok(referee?.sampleSize >= 5, "known referee should have a historical card profile");
assert.ok(referee.cardsPerMatch > 0 && referee.cardsPerMatch < 10);

const leakageFixture = {
  teams: new Map([["stoke", [
    { date: "2026-08-24", yellowCards: 2, redCards: 0 },
    { date: "2026-08-25", yellowCards: 9, redCards: 1 },
  ]]]),
  referees: new Map(),
};
const leakageProfile = teamDisciplineProfile(leakageFixture, ["斯托克城"], "2026-08-25T23:00:00+08:00");
assert.equal(leakageProfile.cardRows, 1, "same-day date-only observations must be excluded");
assert.equal(leakageProfile.yellowCards, 2);

console.log(JSON.stringify({
  ok: true,
  files: index.files.length,
  sourceRows: index.rows,
  acceptedRows: index.accepted,
  verifiedTeams: 8,
  refereeSample: referee.sampleSize,
  signedFallbackTeams: bundledIndex.teams.size,
  asOfPolicy: "strictly-before-forecast-date",
}, null, 2));
