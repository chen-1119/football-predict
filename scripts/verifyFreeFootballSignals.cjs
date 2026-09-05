"use strict";

require("./verifyExternalSignalEventIdentity.cjs");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const historicalTraining = require("../server-data/training/historical-training-index.json");
const {
  buildFreeFootballSignal,
  componentUsableBeforeCutoff,
  freeFootballCoverageRequirement,
  summarizeFreeFootballCoverage,
} = require("./syncFreeFootballSignals.cjs");
const {
  buildQuality,
  prioritizeComponentGaps,
  summarizeComponentCoverage,
} = require("./syncPreMatchSignals.cjs");
const {
  FREE_FOOTBALL_TEAM_ALIASES,
  FREE_FOOTBALL_TEAM_ALIASES_VERSION,
} = require("./freeFootballTeamAliases.cjs");

const requiredActiveAliases = Object.freeze({
  "\u9e7f\u5c9b\u9e7f\u89d2": "kashima antlers",
  "\u798f\u5188\u9ec4\u8702": "avispa fukuoka",
  "\u8d6b\u5c14\u57ce": "hull",
  "\u66fc\u5f7b\u65af\u7279\u8054": "man united",
  "\u57c3\u5f17\u987f": "everton",
  "\u6c34\u6676\u5bab": "crystal palace",
  "\u798f\u56fe\u7eb3\u9521\u5854\u5fb7": "for sittard",
  "\u963f\u5c14\u514b\u9a6c\u5c14": "az alkmaar",
  "\u7ef4\u585e\u4e4c": "academico de viseu",
  "\u6bd5\u5c14\u5df4\u9102\u7ade\u6280": "ath bilbao",
  "\u585e\u7ef4\u5229\u4e9a": "sevilla",
  "\u591a\u7279\u8499\u5fb7": "dortmund",
  "\u62dc\u4ec1\u6155\u5c3c\u9ed1": "bayern munich",
  "\u70ed\u90a3\u4e9a": "genoa",
  "\u90a3\u4e0d\u52d2\u65af": "napoli",
  "\u897f\u73ed\u7259\u4eba": "espanol",
  "\u7687\u5bb6\u9a6c\u5fb7\u91cc": "real madrid",
  "\u65af\u6258\u514b\u57ce": "stoke",
  "lask\u6797\u8328": "lask",
  "\u535a\u5fb7\u95ea\u8000": "bodo glimt",
  "\u96c5\u5178aek": "aek",
  "\u7ef4\u4eac": "viking",
  "\u5723\u56fe\u5c14\u767b": "st truiden",
  "\u5df4\u897f\u56fd\u9645": "internacional",
});
for (const [displayName, canonicalKey] of Object.entries(requiredActiveAliases)) {
  assert.equal(FREE_FOOTBALL_TEAM_ALIASES[displayName], canonicalKey);
  assert.equal(/[\u4e00-\u9fff]/u.test(displayName), true);
}
assert.match(FREE_FOOTBALL_TEAM_ALIASES_VERSION, /utf8-safe/);

const requiredHistoricalAliases = Object.freeze({
  "\u67cf\u6797\u8d6b\u5854": "hertha",
  "\u5965\u65af\u7eb3\u5e03\u5415\u514b": "osnabruck",
  "\u5e03\u6d1b\u6d85": "boulogne",
  "\u7f57\u8fbejc": "roda",
  "\u5e03\u96f7\u8fbe": "nac breda",
  "\u65af\u56fe\u52a0\u7279": "stuttgart",
  "\u96f7\u514b\u65af\u6c49\u59c6": "wrexham",
  "\u91cc\u5965\u963f\u7ef4": "rio ave",
});
for (const [displayName, canonicalKey] of Object.entries(requiredHistoricalAliases)) {
  assert.equal(FREE_FOOTBALL_TEAM_ALIASES[displayName], canonicalKey);
  const historicalTeam = historicalTraining.teams?.[canonicalKey];
  assert.ok(historicalTeam, `${displayName} must resolve to a real signed historical team`);
  assert.ok(Number(historicalTeam.matches) > 0, `${canonicalKey} must contain historical matches`);
  assert.ok(Number.isFinite(Number(historicalTeam.latestElo)), `${canonicalKey} must contain finite Elo`);
}

const kickoffTime = "2026-08-13T20:00:00+08:00";
const buyEndTime = "2026-08-13 19:30:00";
const baseMatch = {
  id: "sporttery_free_fixture",
  sourceMatchId: "free_fixture",
  kickoffTime,
  buyEndTime,
  homeTeamName: "Home",
  awayTeamName: "Away",
  predictionMeta: {
    cutoffTime: buyEndTime,
    elo: {
      homeRating: 1660,
      awayRating: 1510,
      homeMatches: 30,
      awayMatches: 28,
      historicalSource: { source: "signed-local-history" },
    },
    form: {
      home: { sampleSize: 12, pointsPerMatch: 1.9, goalsForAvg: 1.8 },
      away: { sampleSize: 12, pointsPerMatch: 1.2, goalsForAvg: 1.1 },
    },
    oneXTwo: { poisson: { home: 0.52, draw: 0.27, away: 0.21 } },
    leaguePrior: { matches: 2000 },
  },
};

const preCutoff = {
  sourceObservedAt: "2026-08-13T11:00:00.000Z",
  usableForPreMatch: true,
};
const postCutoff = {
  sourceObservedAt: "2026-08-13T12:00:01.000Z",
  usableForPreMatch: true,
};
assert.equal(componentUsableBeforeCutoff(preCutoff, buyEndTime), true);
assert.equal(componentUsableBeforeCutoff(postCutoff, buyEndTime), false);

const full = buildFreeFootballSignal({
  ...baseMatch,
  odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 },
}, {
  updatedAt: preCutoff.sourceObservedAt,
  bookmakerOdds: {
    had: { odds1: 1.84, oddsX: 3.5, odds2: 4.1, ...preCutoff },
  },
  fiveHundred: {
    recentForm: { home: {}, away: {}, ...preCutoff },
  },
});
assert.equal(full.grade, "A");
assert.equal(full.recommendationReady, true);
assert.equal(full.analysisComplete, true);
assert.equal(full.policy.postCutoffMutationAllowed, false);

const modelOnly = buildFreeFootballSignal(baseMatch, {});
assert.equal(modelOnly.grade, "C");
assert.equal(modelOnly.recommendationReady, true);
assert.equal(modelOnly.market.available, false);
assert.ok(modelOnly.sources.includes("local-history-model"));
const modelOnlyQuality = buildQuality({
  match: baseMatch,
  signal: { freeFootball: modelOnly },
  teamHistory: { home: null, away: null },
});
assert.equal(modelOnlyQuality.recommendationUsable, true);
assert.equal(modelOnlyQuality.components.strength.status, "verified");
assert.equal(modelOnlyQuality.components.form.status, "verified");
assert.equal(modelOnlyQuality.analysisComplete, false);

const componentCoverage = summarizeComponentCoverage([
  { quality: modelOnlyQuality },
  { quality: { components: modelOnlyQuality.components } },
]);
assert.equal(componentCoverage.form.verified, 2);
assert.equal(componentCoverage.form.coverage, 1);
assert.equal(componentCoverage.lineup.missing, 2);
assert.equal(componentCoverage.lineup.nextSource, "official-club-or-league-match-centre");
const componentGapPriorities = prioritizeComponentGaps(componentCoverage);
assert.ok(componentGapPriorities.some((gap) => gap.key === "lineup" && gap.missing === 2));

const probabilityModelFormOnly = buildFreeFootballSignal({
  ...baseMatch,
  predictionMeta: {
    ...baseMatch.predictionMeta,
    form: undefined,
  },
  probabilityModel: {
    form: baseMatch.predictionMeta.form,
  },
}, {});
assert.equal(probabilityModelFormOnly.form.available, true);
assert.equal(probabilityModelFormOnly.form.balanced, true);
assert.equal(probabilityModelFormOnly.form.homeSample, 12);
assert.equal(probabilityModelFormOnly.form.awaySample, 12);

const postCutoffSupplement = buildFreeFootballSignal(baseMatch, {
  updatedAt: postCutoff.sourceObservedAt,
  bookmakerOdds: {
    had: { odds1: 1.7, oddsX: 3.6, odds2: 4.8, ...postCutoff },
  },
  fiveHundred: {
    recentForm: { home: {}, away: {}, ...postCutoff },
  },
});
assert.equal(postCutoffSupplement.grade, "C");
assert.equal(postCutoffSupplement.market.fiveHundredHad, false);
assert.equal(postCutoffSupplement.supplements.fiveHundredDetails, false);

const leagueFallback = buildFreeFootballSignal({
  id: "sporttery_league_fallback",
  sourceMatchId: "league_fallback",
  kickoffTime,
  buyEndTime,
  predictionMeta: { leaguePrior: { matches: 500 } },
}, {});
assert.equal(leagueFallback.grade, "C");
assert.equal(leagueFallback.recommendationReady, true);

const noEvidence = buildFreeFootballSignal({
  id: "sporttery_no_evidence",
  sourceMatchId: "no_evidence",
  kickoffTime,
  buyEndTime,
}, {});
assert.equal(noEvidence.grade, "D");
assert.equal(noEvidence.recommendationReady, false);

const asOf = "2026-08-13T10:00:00.000Z";
const uncoveredUpcoming = buildFreeFootballSignal({
  id: "upcoming", status: "SCHEDULED", kickoffTime, buyEndTime,
}, {}, asOf);
const coveredUpcoming = buildFreeFootballSignal(baseMatch, {}, asOf);
const uncoveredFinished = buildFreeFootballSignal({
  id: "finished", status: "FINISHED", kickoffTime, buyEndTime, scoreHome: 2, scoreAway: 1,
}, {}, asOf);
assert.equal(uncoveredFinished.grade, "D");
assert.equal(uncoveredFinished.recommendationReady, false, "finished gaps must not become recommendations");
assert.equal(uncoveredFinished.policy.postCutoffMutationAllowed, false);
assert.equal(summarizeFreeFootballCoverage([coveredUpcoming, uncoveredFinished]).ok, true);
assert.equal(summarizeFreeFootballCoverage([coveredUpcoming, uncoveredUpcoming]).ok, false);
const mixedCoverage = summarizeFreeFootballCoverage([coveredUpcoming, uncoveredFinished, uncoveredUpcoming]);
assert.equal(mixedCoverage.ok, false, "finished rows must not mask a real upcoming gap");
assert.equal(mixedCoverage.recommendationCoverage, 0.3333, "all-row coverage stays honest");
assert.equal(mixedCoverage.preMatchRequired, 2);
assert.equal(mixedCoverage.preMatchReady, 1);
assert.equal(mixedCoverage.preMatchBlocked, 1);
assert.equal(mixedCoverage.excludedFromPreMatchRequirement, 1);
assert.equal(mixedCoverage.exclusionReasons["lifecycle-finished"], 1);
for (const status of ["LIVE", "PENDING_RESULT", "CANCELLED", "CANCELED", "POSTPONED", "ABANDONED", "SUSPENDED"]) {
  assert.equal(freeFootballCoverageRequirement({ status, kickoffTime }, asOf).required, false);
}
assert.equal(freeFootballCoverageRequirement({ status: "SCHEDULED", kickoffTime, buyEndTime }, "2026-08-13T11:30:00.000Z").required, false);
assert.equal(freeFootballCoverageRequirement({ status: "SCHEDULED", kickoffTime, buyEndTime: "invalid" }, "2026-08-13T12:00:00.000Z").required, false);
assert.equal(freeFootballCoverageRequirement({ status: "SCHEDULED" }, asOf).required, true);
assert.equal(freeFootballCoverageRequirement({ kickoffTime }, "invalid").required, true);
assert.equal(summarizeFreeFootballCoverage([{ grade: "D", recommendationReady: false }]).ok, false, "legacy rows without scope fail closed");
assert.equal(summarizeFreeFootballCoverage([]).ok, true, "a valid empty business day has no missing pre-match input");

const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-free-lifecycle-"));
try {
  const scriptDir = path.join(cliRoot, "scripts");
  const dataDir = path.join(cliRoot, "public", "data");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of ["syncFreeFootballSignals.cjs", "externalSignalEventIdentity.cjs"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scriptDir, name));
  }
  const runCli = (fixtures) => {
    fs.writeFileSync(path.join(dataDir, "matches-current.json"), JSON.stringify(fixtures));
    fs.writeFileSync(path.join(dataDir, "external-signals.json"), JSON.stringify({ matches: {} }));
    return spawnSync(process.execPath, [path.join(scriptDir, "syncFreeFootballSignals.cjs")], {
      cwd: cliRoot, encoding: "utf8", timeout: 15000,
    });
  };
  const closedFixture = {
    id: "finished", status: "FINISHED", kickoffTime: "2026-01-01T12:00:00Z", scoreHome: 2, scoreAway: 1,
  };
  const closedResult = runCli([closedFixture]);
  assert.equal(closedResult.status, 0, closedResult.stderr);
  assert.equal(JSON.parse(closedResult.stdout).ok, true);
  const closedOutput = JSON.parse(fs.readFileSync(path.join(dataDir, "free-football-signals.json"), "utf8"));
  assert.equal(closedOutput.matches.finished.recommendationReady, false);
  assert.equal(closedOutput.summary.recommendationCoverage, 0);
  const upcomingResult = runCli([closedFixture, {
    id: "future", status: "SCHEDULED", kickoffTime: "2099-01-01T12:00:00Z",
  }]);
  assert.equal(upcomingResult.status, 1, upcomingResult.stderr);
  assert.equal(JSON.parse(upcomingResult.stdout).preMatchBlocked, 1);
  const malformedResult = runCli({ invalid: true });
  assert.equal(malformedResult.status, 1, "malformed current data must not become a healthy empty day");
} finally {
  fs.rmSync(cliRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  verified: [
    "pre-cutoff-component-timing",
    "complete-free-source-grade",
    "model-only-recommendation-fallback",
    "probability-model-form-projection",
    "recommendation-usable-is-separate-from-analysis-complete",
    "component-gap-coverage-and-source-plan",
    "post-cutoff-supplement-rejection",
    "league-prior-cold-start",
    "fail-closed-with-no-evidence",
    "finished-input-gaps-do-not-block-official-sync",
    "upcoming-input-gaps-still-fail-closed",
    "lifecycle-and-cutoff-scoped-coverage",
    "cli-exit-code-preserves-pre-match-gates-and-rejects-malformed-input",
    "utf8-safe-active-sporttery-team-aliases",
  ],
}, null, 2));
