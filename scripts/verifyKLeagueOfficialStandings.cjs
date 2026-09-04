"use strict";

const assert = require("node:assert/strict");
const {
  applyKLeagueOfficialResult,
  buildFixtureSignal,
  buildStandingSignal,
  officialKickoffInstant,
  resolveOfficialFixture,
  resolveStanding,
  resolveTeamId,
  validKLeagueFixtureEvidenceForMatch,
} = require("./syncKLeagueOfficialStandings.cjs");
const {
  isTrustedKLeagueOfficialFinal,
  isTrustedOfficialFinal,
  resolveMatchLifecycle,
} = require("../src/services/matchLifecycle.cjs");
const {
  predictionSetWithoutOfficialOdds,
} = require("./syncData.cjs");

const rows = [
  { teamId: "K05", teamName: "JEONBUK", rank: 3, gainPoint: 37, gameCount: 24, winCnt: 10, tieCnt: 7, lossCnt: 7, gainGoal: 31, lossGoal: 22, game01: "W", game02: "L", game03: "L", game04: "D", game05: "W", game06: "D" },
  { teamId: "K04", teamName: "JEJU", rank: 5, gainPoint: 35, gameCount: 24, winCnt: 9, tieCnt: 8, lossCnt: 7, gainGoal: 27, lossGoal: 24, game01: "D", game02: "W", game03: "W", game04: "D", game05: "W", game06: "D" },
  { teamId: "K03", teamName: "POHANG", rank: 7, gainPoint: 31, gameCount: 24, winCnt: 9, tieCnt: 4, lossCnt: 11, gainGoal: 22, lossGoal: 28, game01: "L", game02: "W", game03: "L", game04: "L", game05: "L", game06: "L" },
  { teamId: "K35", teamName: "GIMCHEON", rank: 11, gainPoint: 26, gameCount: 24, winCnt: 4, tieCnt: 14, lossCnt: 6, gainGoal: 23, lossGoal: 29, game01: "D", game02: "D", game03: "D", game04: "W", game05: "W", game06: "D" },
];

const observedAt = "2026-08-25T04:00:00.000Z";
const sourceUrl = "https://www.kleague.com/record/teamRank.do?leagueId=1&year=2026&stadium=all&recordType=rank";
const fixture = (sourceMatchId, homeTeamName, awayTeamName) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  homeTeamName,
  awayTeamName,
  leagueName: "韩职",
  kickoffTime: "2026-08-25T18:30:00+08:00",
  buyEndTime: "2026-08-25T18:20:00+08:00",
});

const withSignal = (match, signal) => ({
  ...match,
  externalSignals: { kLeagueOfficial: signal },
});

const gimcheon = fixture("2041049", "金泉尚武", "全北现代");
const jeju = fixture("2041050", "济州SK", "浦项制铁");
const gimcheonSignal = buildStandingSignal({ match: gimcheon, rows, observedAt, sourceUrl, year: 2026 });
const jejuSignal = buildStandingSignal({ match: jeju, rows, observedAt, sourceUrl, year: 2026 });

assert.equal(resolveStanding(rows, "金泉尚武")?.teamName, "GIMCHEON");
assert.equal(resolveStanding(rows, "全北现代")?.teamName, "JEONBUK");
assert.equal(gimcheonSignal?.source, "K League official JSON");
assert.equal(jejuSignal?.home?.teamName, "JEJU");

const gimcheonPrediction = predictionSetWithoutOfficialOdds(withSignal(gimcheon, gimcheonSignal));
const jejuPrediction = predictionSetWithoutOfficialOdds(withSignal(jeju, jejuSignal));
const best = (result) => result.predictions.find((row) => row.marketType === "BEST");

assert.equal(best(gimcheonPrediction)?.tipCode, "2", "official K League form should lean away for Gimcheon v Jeonbuk");
assert.equal(best(jejuPrediction)?.tipCode, "1", "official K League form should lean home for Jeju v Pohang");
assert.equal(gimcheonPrediction.probabilityModel.inputSufficiency.sufficient, true);
assert.equal(gimcheonPrediction.probabilityModel.inputSufficiency.officialLeague.ready, true);

const afterCutoffSignal = { ...gimcheonSignal, observedAt: "2026-08-25T11:00:00.000Z", receivedAt: "2026-08-25T11:00:00.000Z" };
const afterCutoffPrediction = predictionSetWithoutOfficialOdds(withSignal(gimcheon, afterCutoffSignal));
assert.equal(afterCutoffPrediction.probabilityModel.inputSufficiency.sufficient, false, "post-cutoff standings must fail closed");
assert.equal(afterCutoffPrediction.probabilityModel.inputSufficiency.officialLeague.ready, false);

const resultMatch = {
  ...fixture("2041152", "仁川联", "全北现代"),
  kickoffTime: "2026-08-30T18:30:00+08:00",
  eventVersion: "2026-08-30T18:30:00+08:00",
  status: "PENDING_RESULT",
};
const scheduleRows = [{
  year: 2026,
  leagueId: 1,
  roundId: 26,
  gameId: 154,
  gameDate: "2026.08.30",
  gameTime: "19:30",
  homeTeam: "K18",
  homeTeamName: "INCHEON",
  awayTeam: "K05",
  awayTeamName: "JEONBUK",
  fieldNameFull: "Incheon Football",
  homeGoal: 1,
  awayGoal: 1,
  gameStatus: "FE",
  refreeName1: "김대용",
}];
const responseSha256 = "b".repeat(64);
const scheduleUrl = "https://www.kleague.com/getScheduleList.do";

assert.equal(resolveTeamId("仁川联"), "K18");
assert.equal(resolveTeamId("全北现代"), "K05");
assert.equal(resolveOfficialFixture(scheduleRows, resultMatch)?.gameId, 154);
assert.equal(officialKickoffInstant(scheduleRows[0]), "2026-08-30T10:30:00.000Z");
assert.equal(
  Date.parse(officialKickoffInstant(scheduleRows[0])),
  Date.parse(resultMatch.kickoffTime),
  "19:30 Korea time must equal 18:30 Beijing time",
);

const tooEarlyFixture = buildFixtureSignal({
  match: resultMatch,
  rows: scheduleRows,
  observedAt: "2026-08-30T11:00:00.000Z",
  sourceUrl: scheduleUrl,
  responseSha256,
});
assert.equal(tooEarlyFixture.status, "SCHEDULED", "an early FE placeholder must not settle a match");
assert.equal(tooEarlyFixture.scoreHome, null);

const finalFixture = buildFixtureSignal({
  match: resultMatch,
  rows: scheduleRows,
  observedAt: "2026-08-30T12:20:00.000Z",
  sourceUrl: scheduleUrl,
  responseSha256,
});
assert.equal(finalFixture.status, "FINISHED");
assert.equal(finalFixture.referee, "김대용");
assert.equal(validKLeagueFixtureEvidenceForMatch(resultMatch, finalFixture), true);

const settled = applyKLeagueOfficialResult({
  ...resultMatch,
  externalSignals: {
    kLeagueOfficial: {
      version: "k-league-official-standings-v1",
      fixture: finalFixture,
    },
  },
});
assert.equal(settled.status, "FINISHED");
assert.deepEqual([settled.scoreHome, settled.scoreAway], [1, 1]);
assert.equal(settled.resultProvenance.provider, "k-league");
assert.equal(settled.resultProvenance.promotionEligible, false);
assert.equal(isTrustedKLeagueOfficialFinal(settled), true);
assert.equal(isTrustedOfficialFinal(settled), true);
assert.equal(resolveMatchLifecycle(settled).statusReason, "official-k-league-final");
assert.equal(
  validKLeagueFixtureEvidenceForMatch(resultMatch, { ...finalFixture, scoreHome: 9 }),
  false,
  "a score change without a matching evidence hash must fail closed",
);

const officialSporttery = {
  ...resultMatch,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  resultProvenance: { provider: "sporttery", official: true, trusted: true },
  externalSignals: { kLeagueOfficial: { fixture: finalFixture } },
};
assert.equal(applyKLeagueOfficialResult(officialSporttery), officialSporttery);

console.log("K League official standings and result verification passed (30 checks).");
