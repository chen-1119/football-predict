const assert = require("assert/strict");
const {
  absoluteUrl,
  buildDetailSignal,
  buildResultMergeSignal,
  boundedResultArchiveDatesForRows,
  ensureSignalComponentTiming,
  mergeSignal,
  resultArchiveDatesForRows,
} = require("./sync500Details.cjs");

let checks = 0;
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks += 1;
};
const ok = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};

const preObservedAt = "2026-07-11T08:00:00.000Z";
const postObservedAt = "2026-07-11T12:00:00.000Z";
const validUntil = "2026-07-11T10:30:00.000Z";

equal(
  absoluteUrl("/fenxi/shuju-1234567.shtml"),
  "https://odds.500.com/fenxi/shuju-1234567.shtml",
  "relative 500 detail links stay on the working odds host",
);
equal(
  absoluteUrl("https://odds.500.com/fenxi/ouzhi-1234567.shtml"),
  "https://odds.500.com/fenxi/ouzhi-1234567.shtml",
  "absolute 500 detail links are not rewritten to the non-detail trade host",
);

const scheduledMatch = {
  sourceMatchId: "timing-fixture-1",
  fixtureId: "fixture-1",
  infoMatchId: "info-1",
  matchNo: "周六001",
  homeTeamName: "主队",
  awayTeamName: "客队",
  kickoffTime: "2026-07-11T18:30:00+08:00",
  buyEndTime: "2026-07-11 18:30",
  handicapLine: "-1",
  availability: { had: true, hhad: true },
  had: { odds1: 1.72, oddsX: 3.55, odds2: 4.3 },
  hhad: { odds1: 2.95, oddsX: 3.5, odds2: 2.02 },
  urls: { analysis: "https://example.test/analysis" },
};

const details = {
  analysis: {
    rank: {
      home: { teamName: "主队", fifaRank: 15 },
      away: { teamName: "客队", fifaRank: 41 },
    },
    recentForm: {
      home: { sampleSize: 6, record: "4-1-1" },
      away: { sampleSize: 6, record: "2-2-2" },
    },
    futureSchedule: {
      home: { nextGapDays: 5, rows: [{ date: "2026-07-16" }] },
      away: { nextGapDays: 4, rows: [{ date: "2026-07-15" }] },
    },
    projectedSquads: {
      home: ["甲", "乙"],
      away: ["丙", "丁"],
    },
    macauTip: { pick: "主队", summary: "fixture tip" },
  },
  europeOdds: {
    companies: 8,
    currentAverage: { odds1: 1.76, oddsX: 3.5, odds2: 4.2 },
    initialAverage: { odds1: 1.8, oddsX: 3.45, odds2: 4.1 },
    summary: "fixture average",
  },
  asianHandicap: {
    companies: 8,
    currentAverageLine: -1,
    initialAverageLine: -0.75,
  },
};

const preSignal = buildDetailSignal(scheduledMatch, details, preObservedAt);
equal(preSignal.sourceMatchId, scheduledMatch.sourceMatchId, "detail signal exposes top-level source identity");
equal(preSignal.kickoffTime, scheduledMatch.kickoffTime, "detail signal exposes top-level kickoff identity");
equal(preSignal.homeTeamName, scheduledMatch.homeTeamName, "detail signal exposes top-level home-team identity");
equal(preSignal.awayTeamName, scheduledMatch.awayTeamName, "detail signal exposes top-level away-team identity");
equal(preSignal.updatedAt, preObservedAt, "fresh signal keeps the pre-match observation time");
equal(preSignal.validUntil, validUntil, "fresh signal uses sale cutoff as validUntil");
equal(preSignal.timingPolicy, "component-as-of-v1", "fresh signal exposes timing policy");

const expectedPreComponents = [
  "bookmakerOdds.had",
  "bookmakerOdds.hhad",
  "handicapLine",
  "fiveHundred.sale",
  "fiveHundred.rank",
  "fiveHundred.recentForm",
  "fiveHundred.futureSchedule",
  "fiveHundred.europeOdds",
  "fiveHundred.asianHandicap",
  "fiveHundred.marketConsensus",
  "fiveHundred.macauTip",
  "projectedRoster",
  "externalOdds",
];

const preComponents = {
  "bookmakerOdds.had": preSignal.bookmakerOdds.had,
  "bookmakerOdds.hhad": preSignal.bookmakerOdds.hhad,
  handicapLine: preSignal.handicapLineMeta,
  "fiveHundred.sale": preSignal.fiveHundred.sale,
  "fiveHundred.rank": preSignal.fiveHundred.rank,
  "fiveHundred.recentForm": preSignal.fiveHundred.recentForm,
  "fiveHundred.futureSchedule": preSignal.fiveHundred.futureSchedule,
  "fiveHundred.europeOdds": preSignal.fiveHundred.europeOdds,
  "fiveHundred.asianHandicap": preSignal.fiveHundred.asianHandicap,
  "fiveHundred.marketConsensus": preSignal.fiveHundred.marketConsensus,
  "fiveHundred.macauTip": preSignal.fiveHundred.macauTip,
  projectedRoster: preSignal.projectedRoster,
  externalOdds: preSignal.externalOdds,
};

for (const name of expectedPreComponents) {
  const component = preComponents[name];
  ok(component, `${name} exists in fixture`);
  equal(component.sourceObservedAt, preObservedAt, `${name} keeps sourceObservedAt`);
  equal(component.receivedAt, preObservedAt, `${name} keeps receivedAt`);
  equal(component.validUntil, validUntil, `${name} has the pre-match cutoff`);
  equal(component.usableForPreMatch, true, `${name} is explicitly pre-match usable`);
  ok(preSignal.preMatchUsableComponents.includes(name), `${name} is listed as usable`);
}

const finishedMatch = {
  ...scheduledMatch,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 1,
  resultSource: "500.com:jczq-result",
  resultUpdatedAt: postObservedAt,
};
const resultOnlySignal = buildResultMergeSignal(
  finishedMatch,
  preSignal,
  postObservedAt,
  details,
  preObservedAt,
);

equal(resultOnlySignal.timingUpdateKind, "result-only", "result update is explicitly result-only");
equal(resultOnlySignal.sourceMatchId, scheduledMatch.sourceMatchId, "result update keeps top-level source identity");
equal(resultOnlySignal.kickoffTime, scheduledMatch.kickoffTime, "result update keeps top-level kickoff identity");
equal(resultOnlySignal.updatedAt, preObservedAt, "result update does not refresh root updatedAt");
equal(resultOnlySignal.sourceObservedAt, preObservedAt, "result update keeps root observation time");
equal(resultOnlySignal.latestReceivedAt, postObservedAt, "result receipt is tracked separately");
equal(resultOnlySignal.bookmakerOdds.had.sourceObservedAt, preObservedAt, "result does not refresh HAD odds");
equal(resultOnlySignal.projectedRoster.sourceObservedAt, preObservedAt, "result does not refresh projected roster");
equal(resultOnlySignal.fiveHundred.europeOdds.sourceObservedAt, preObservedAt, "result does not refresh Europe odds");
equal(resultOnlySignal.fiveHundred.result.sourceObservedAt, postObservedAt, "result owns the post-match timestamp");
equal(resultOnlySignal.fiveHundred.result.updatedAt, postObservedAt, "result compatibility updatedAt is post-match");
equal(resultOnlySignal.fiveHundred.result.usableForPreMatch, false, "result is never a pre-match input");
equal(resultOnlySignal.fiveHundred.result.observationPhase, "post-match-result", "result phase is explicit");
ok(resultOnlySignal.postMatchOnlyComponents.includes("fiveHundred.result"), "result is listed as post-match-only");

const mergedSignal = mergeSignal(preSignal, resultOnlySignal);
equal(mergedSignal.updatedAt, preObservedAt, "mergeSignal preserves the prior root observation");
equal(mergedSignal.bookmakerOdds.had.sourceObservedAt, preObservedAt, "mergeSignal preserves prior odds timing");
equal(mergedSignal.fiveHundred.updatedAt, preObservedAt, "mergeSignal preserves the 500 container observation");
equal(mergedSignal.fiveHundred.result.sourceObservedAt, postObservedAt, "mergeSignal still accepts the result time");
equal(mergedSignal.latestReceivedAt, postObservedAt, "mergeSignal exposes latest receipt separately");

const postCutoffSignal = buildDetailSignal(scheduledMatch, details, postObservedAt);
equal(postCutoffSignal.bookmakerOdds.had.usableForPreMatch, false, "post-cutoff odds fail closed");
equal(postCutoffSignal.projectedRoster.usableForPreMatch, false, "post-cutoff projected roster fails closed");
equal(postCutoffSignal.fiveHundred.europeOdds.usableForPreMatch, false, "post-cutoff Europe odds fail closed");
equal(postCutoffSignal.bookmakerOdds.had.observationPhase, "post-cutoff", "post-cutoff phase is explicit");
ok(postCutoffSignal.preMatchIneligibleComponents.includes("bookmakerOdds.had"), "post-cutoff odds are listed as ineligible");

const resultWithoutCache = buildResultMergeSignal(
  finishedMatch,
  null,
  postObservedAt,
  details,
);
equal(resultWithoutCache.sourceMatchId, scheduledMatch.sourceMatchId, "uncached result can become a fallback fixture");
equal(resultWithoutCache.kickoffTime, scheduledMatch.kickoffTime, "uncached result carries fallback kickoff identity");
equal(resultWithoutCache.homeTeamName, scheduledMatch.homeTeamName, "uncached result carries fallback home identity");
equal(resultWithoutCache.awayTeamName, scheduledMatch.awayTeamName, "uncached result carries fallback away identity");
equal(resultWithoutCache.fiveHundred.result.scoreHome, 2, "uncached result exposes the home score");
equal(resultWithoutCache.fiveHundred.result.scoreAway, 1, "uncached result exposes the away score");
equal(resultWithoutCache.bookmakerOdds.had.usableForPreMatch, false, "result-only discovery cannot backdate odds");
equal(resultWithoutCache.fiveHundred.result.usableForPreMatch, false, "result-only discovery keeps result post-match-only");

const legacyContaminatedSignal = {
  source: "500.com:jczq+500.com:details",
  updatedAt: postObservedAt,
  handicapLine: "-1",
  bookmakerOdds: {
    had: { ...scheduledMatch.had, source: "500.com:jczq", updatedAt: postObservedAt },
  },
  fiveHundred: {
    source: "500.com",
    updatedAt: postObservedAt,
    sale: { buyEndTime: scheduledMatch.buyEndTime, availability: scheduledMatch.availability },
    rank: details.analysis.rank,
  },
  lineups: { source: "500.com", summary: { en: "legacy lineup" } },
};
const upgradedLegacy = ensureSignalComponentTiming(
  legacyContaminatedSignal,
  scheduledMatch,
  postObservedAt,
);
equal(upgradedLegacy.bookmakerOdds.had.usableForPreMatch, false, "legacy post-cutoff odds fail closed");
equal(upgradedLegacy.fiveHundred.rank.usableForPreMatch, false, "legacy post-cutoff rank fails closed");
equal(upgradedLegacy.lineups.usableForPreMatch, false, "legacy post-cutoff lineup fails closed");
equal(upgradedLegacy.bookmakerOdds.had.sourceObservedAt, postObservedAt, "legacy time is not silently backdated");

const recentKickoff = new Date(Date.now() - 3 * 3600000).toISOString();
const recentBusinessDate = new Date(Date.now() - 24 * 3600000).toISOString().slice(0, 10);
const archiveDates = resultArchiveDatesForRows([], [{
  kickoffTime: recentKickoff,
  businessDate: recentBusinessDate,
}]);
ok(archiveDates.includes(recentKickoff.slice(0, 10)), "result discovery includes the kickoff day from current supporting rows");
ok(archiveDates.includes(recentBusinessDate), "result discovery also includes the Sporttery business day");
const boundedArchiveDates = boundedResultArchiveDatesForRows(1, [], [{
  kickoffTime: recentKickoff,
  businessDate: recentBusinessDate,
}]);
equal(boundedArchiveDates.length, 1, "hot result discovery caps archive requests");
equal(
  boundedArchiveDates[0],
  archiveDates.at(-1),
  "hot result discovery keeps the newest relevant archive date"
);

console.log(`500 component timing verification passed (${checks} checks).`);
