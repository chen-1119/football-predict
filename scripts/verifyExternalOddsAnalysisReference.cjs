"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION,
  EXTERNAL_ODDS_MIN_LEADER_GAP,
  EXTERNAL_ODDS_MIN_LEADER_PROBABILITY,
  OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS,
  buildExternalOddsAnalysisReference,
} = require("../src/services/externalOddsAnalysisReference.cjs");
const {
  isOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");
const {
  isLiveRecommendationEligible,
} = require("../src/services/liveRecommendationEligibility.cjs");

const NOW = Date.parse("2026-07-21T00:00:00.000Z");
const STRONG_HOME_ODDS = {
  odds1: 5 / 3,
  oddsX: 4,
  odds2: 20 / 3,
};
const BASE_MATCH = {
  status: "SCHEDULED",
  kickoffTime: "2026-07-21T12:00:00.000Z",
  buyEndTime: "2026-07-21T11:50:00.000Z",
  odds: {
    ...STRONG_HOME_ODDS,
    updatedAt: "2026-07-20T23:55:00.000Z",
  },
  oddsSource: "500.com:HAD",
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const build = (overrides = {}, at = NOW) => buildExternalOddsAnalysisReference({
  ...clone(BASE_MATCH),
  ...overrides,
}, at);

const scenarios = [];
const verify = (name, test) => {
  test();
  scenarios.push(name);
};

verify("valid 500.com HAD source produces a home reference", () => {
  const result = build();
  assert.ok(result);
  assert.equal(result.version, "external-odds-analysis-reference-v5");
  assert.equal(result.version, EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION);
  assert.equal(result.market, "HAD");
  assert.equal(result.tipCode, "1");
  assert.equal(result.hadDirection.label.zh, "主胜");
  assert.equal(result.referenceAction, "reference");
  assert.equal(result.source.provider, "500.com");
  assert.equal(result.source.official, false);
  assert.equal(result.source.rawSource, "500.com:HAD");
  assert.equal(result.sourceUpdatedAt, BASE_MATCH.odds.updatedAt);
  assert.equal(result.selectedSourceOdds, STRONG_HOME_ODDS.odds1);
  assert.ok(result.leaderProbability > EXTERNAL_ODDS_MIN_LEADER_PROBABILITY);
  assert.equal(result.minimumLeaderProbability, EXTERNAL_ODDS_MIN_LEADER_PROBABILITY);
  assert.equal(result.minimumLeaderGap, EXTERNAL_ODDS_MIN_LEADER_GAP);
  assert.ok(Math.abs(
    result.deviggedProbabilities.home
      + result.deviggedProbabilities.draw
      + result.deviggedProbabilities.away
      - 1
  ) < 0.000002);
});

verify("bookmaker HAD source is supported", () => {
  const result = build({
    odds: null,
    oddsSource: null,
    externalSignals: {
      bookmakerOdds: {
        had: { ...STRONG_HOME_ODDS, source: "500.com:HAD" },
      },
    },
  });
  assert.equal(result?.tipCode, "1");
});

verify("500 child odds inherit the verified parent source and clock", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const bookmaker = build({
    odds: null,
    oddsSource: null,
    externalSignals: {
      source: "500.com:jczq",
      updatedAt,
      bookmakerOdds: {
        had: { ...STRONG_HOME_ODDS },
      },
    },
  });
  const generic = build({
    odds: null,
    oddsSource: null,
    externalSignals: {
      source: "500.com:jczq",
      updatedAt,
      externalOdds: { ...STRONG_HOME_ODDS, source: "500.com" },
    },
  });
  assert.equal(bookmaker?.source.rawSource, "500.com:jczq");
  assert.equal(bookmaker?.sourceUpdatedAt, updatedAt);
  assert.equal(generic?.source.rawSource, "500.com:jczq");
  assert.equal(generic?.sourceUpdatedAt, updatedAt);
});

verify("fresh nested 500 HAD replaces an older top-level 500 snapshot", () => {
  const staleUpdatedAt = new Date(NOW - 13 * 60 * 60 * 1000).toISOString();
  const freshUpdatedAt = new Date(NOW - 60_000).toISOString();
  const result = build({
    odds: { ...STRONG_HOME_ODDS, updatedAt: staleUpdatedAt },
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: staleUpdatedAt,
    externalSignals: {
      bookmakerOdds: {
        had: {
          odds1: 7,
          oddsX: 4,
          odds2: 5 / 3,
          source: "500.com:jczq",
          updatedAt: freshUpdatedAt,
        },
      },
    },
  });
  assert.equal(result?.tipCode, "2");
  assert.equal(result?.source.rawSource, "500.com:jczq");
  assert.equal(result?.sourceUpdatedAt, freshUpdatedAt);
  assert.equal(result?.selectedSourceOdds, 5 / 3);
});

verify("generic externalOdds requires an explicit 500 source", () => {
  const result = build({
    odds: null,
    oddsSource: null,
    externalSignals: {
      externalOdds: { ...STRONG_HOME_ODDS, source: "500.com:HAD" },
    },
  });
  assert.equal(result?.source.rawSource, "500.com:HAD");
});

verify("500 current-average Europe odds are not mislabeled as HAD", () => {
  const result = build({
    odds: null,
    oddsSource: null,
    externalSignals: {
      fiveHundred: {
        source: "500.com",
        updatedAt: "2026-07-20T23:40:00.000Z",
        europeOdds: {
          currentAverage: { odds1: 2, oddsX: 10 / 3, odds2: 5 },
        },
      },
    },
  });
  assert.equal(result, null);
});

verify("a leader just below forty percent is rejected even with a wide gap", () => {
  assert.equal(build({
    odds: { odds1: 1 / 0.3999, oddsX: 1 / 0.3001, odds2: 1 / 0.30 },
  }), null);
});

verify("exactly forty percent is accepted", () => {
  const result = build({ odds: { odds1: 1 / 0.40, oddsX: 1 / 0.32, odds2: 1 / 0.28 } });
  assert.ok(result);
  assert.equal(result.leaderProbability, EXTERNAL_ODDS_MIN_LEADER_PROBABILITY);
});

verify("an eight-point gap alone is insufficient below the absolute probability floor", () => {
  assert.equal(build({
    odds: { odds1: 1 / 0.3999, oddsX: 1 / 0.3199, odds2: 1 / 0.2802 },
  }), null);
  assert.equal(EXTERNAL_ODDS_MIN_LEADER_GAP, 0.08);
});

verify("less than eight percentage points is rejected", () => {
  assert.equal(build({
    odds: { odds1: 1 / 0.4399, oddsX: 1 / 0.36, odds2: 1 / 0.2001 },
  }), null);
});

verify("buy-end cutoff is fail-closed and exclusive", () => {
  assert.equal(build({}, Date.parse(BASE_MATCH.buyEndTime)), null);
});

verify("prediction cutoff can close before buy-end", () => {
  const cutoffTime = "2026-07-21T11:30:00.000Z";
  assert.equal(build({ predictionMeta: { cutoffTime } }, Date.parse(cutoffTime)), null);
});

verify("kickoff is fail-closed when buy-end is missing", () => {
  assert.equal(build({ buyEndTime: null }, Date.parse(BASE_MATCH.kickoffTime)), null);
});

verify("invalid kickoff and invalid clock are rejected", () => {
  assert.equal(build({ kickoffTime: "not-a-date" }), null);
  assert.equal(build({}, Number.NaN), null);
});

verify("non-scheduled and void matches are rejected", () => {
  assert.equal(build({ status: "LIVE" }), null);
  assert.equal(build({ status: "FINISHED" }), null);
  assert.equal(build({ resultDisposition: "VOID" }), null);
});

verify("source-less and non-500 odds are rejected", () => {
  assert.equal(build({ oddsSource: null }), null);
  assert.equal(build({ oddsSource: "other:HAD" }), null);
});

verify("official Sporttery HAD source is rejected", () => {
  assert.equal(build({ oddsSource: "sporttery:HAD" }), null);
});

verify("fresh official HAD availability blocks a nested 500 fallback", () => {
  assert.equal(build({
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: new Date(NOW - OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS + 60_000).toISOString(),
    externalSignals: {
      externalOdds: { ...STRONG_HOME_ODDS, source: "500.com:HAD" },
    },
  }), null);
});

verify("fresh official HAD metadata without a valid odds triplet cannot block 500", () => {
  const missing = build({
    odds: null,
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: new Date(NOW - 60_000).toISOString(),
    externalSignals: {
      externalOdds: {
        ...STRONG_HOME_ODDS,
        source: "500.com:HAD",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      },
    },
  });
  const malformed = build({
    odds: { odds1: 1.35, oddsX: 4.05 },
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: new Date(NOW - 60_000).toISOString(),
    externalSignals: {
      externalOdds: {
        ...STRONG_HOME_ODDS,
        source: "500.com:HAD",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      },
    },
  });
  assert.equal(missing?.tipCode, "1");
  assert.equal(malformed?.tipCode, "1");
});

verify("stale or unclocked official HAD allows a fresh nested 500 fallback", () => {
  const stale = build({
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: new Date(NOW - OFFICIAL_HAD_FRESHNESS_MAX_AGE_MS - 60_000).toISOString(),
    externalSignals: {
      externalOdds: {
        ...STRONG_HOME_ODDS,
        source: "500.com:HAD",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      },
    },
  });
  const unclocked = build({
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: null,
    odds: { ...STRONG_HOME_ODDS, updatedAt: null },
    externalSignals: {
      externalOdds: {
        ...STRONG_HOME_ODDS,
        source: "500.com:HAD",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      },
    },
  });
  assert.equal(stale?.source.provider, "500.com");
  assert.equal(unclocked?.source.provider, "500.com");
});

verify("invalid odds fail closed", () => {
  const invalid = [
    { odds1: 2, oddsX: 3 },
    { odds1: Number.NaN, oddsX: 3, odds2: 4 },
    { odds1: Number.POSITIVE_INFINITY, oddsX: 3, odds2: 4 },
    { odds1: 1, oddsX: 3, odds2: 4 },
    { odds1: -2, oddsX: 3, odds2: 4 },
    { odds1: "2", oddsX: 3, odds2: 4 },
  ];
  for (const odds of invalid) assert.equal(build({ odds }), null);
});

verify("draw and away leaders map to explicit HAD directions", () => {
  const draw = build({ odds: { odds1: 4, oddsX: 5 / 3, odds2: 20 / 3 } });
  const away = build({ odds: { odds1: 4, oddsX: 20 / 3, odds2: 5 / 3 } });
  assert.equal(draw?.tipCode, "X");
  assert.equal(draw?.hadDirection.label.zh, "平局");
  assert.equal(away?.tipCode, "2");
  assert.equal(away?.hadDirection.label.zh, "客胜");
});

verify("conflicting 500 HHAD only adds avoid-handicap risk", () => {
  const result = build({
    handicapOdds: { odds1: 5, oddsX: 10 / 3, odds2: 2 },
    handicapOddsSource: "500.com:HHAD",
    handicapLine: "-1",
  });
  assert.ok(result, "HAD reference must survive an HHAD conflict");
  assert.equal(result.tipCode, "1");
  assert.equal(result.handicapRisk?.code, "avoid-handicap");
  assert.equal(result.handicapRisk?.label.zh, "不碰让球");
  assert.equal(result.handicapRisk?.hhadDirection.code, "2");
  assert.equal(result.handicapRisk?.handicapLine, -1);
});

verify("aligned HHAD adds no risk", () => {
  const result = build({
    handicapOdds: { odds1: 2, oddsX: 10 / 3, odds2: 5 },
    handicapOddsSource: "500.com:HHAD",
    handicapLine: -1,
  });
  assert.ok(result);
  assert.equal(result.handicapRisk, null);
});

verify("official or invalid HHAD never vetoes the HAD reference", () => {
  const official = build({
    handicapOdds: { odds1: 5, oddsX: 10 / 3, odds2: 2 },
    handicapOddsSource: "sporttery:HHAD",
    handicapLine: -1,
  });
  const invalid = build({
    handicapOdds: { odds1: 5, oddsX: 3 },
    handicapOddsSource: "500.com:HHAD",
    handicapLine: -1,
  });
  assert.equal(official?.tipCode, "1");
  assert.equal(official?.handicapRisk, null);
  assert.equal(invalid?.tipCode, "1");
  assert.equal(invalid?.handicapRisk, null);
});

verify("bookmaker HHAD conflict is reported without an HHAD pick", () => {
  const result = build({
    externalSignals: {
      bookmakerOdds: {
        hhad: {
          odds1: 5,
          oddsX: 10 / 3,
          odds2: 2,
          source: "500.com:HHAD",
          handicapLine: "HHAD: -1",
        },
      },
    },
  });
  assert.equal(result?.handicapRisk?.label.zh, "不碰让球");
  assert.equal(Object.hasOwn(result ?? {}, "hhadTipCode"), false);
});

verify("reference cannot satisfy formal, live, or bet-slip gates", () => {
  const result = build();
  assert.ok(result);
  assert.equal(result.publicationTrack, "analysis-only");
  assert.equal(result.statisticsTrack, "analysis-only");
  assert.equal(result.executable, false);
  assert.equal(result.formalEligible, false);
  assert.equal(result.liveEligible, false);
  assert.equal(result.betSlipEligible, false);
  for (const forbiddenField of [
    "marketType",
    "oddsPoolCode",
    "odds",
    "recommendationAction",
    "recommendationTier",
    "multiFactorEvidence",
    "liveRecommendationAction",
    "liveRecommendation",
  ]) {
    assert.equal(Object.hasOwn(result, forbiddenField), false, forbiddenField);
  }
  assert.equal(isOfficialRecommendationEligible(result, result.selectedSourceOdds, 0), false);
  assert.equal(isLiveRecommendationEligible(result, result.selectedSourceOdds, 0, BASE_MATCH, NOW), false);
});

verify("builder is pure and does not mutate input", () => {
  const input = {
    ...clone(BASE_MATCH),
    handicapOdds: { odds1: 5, oddsX: 10 / 3, odds2: 2 },
    handicapOddsSource: "500.com:HHAD",
    handicapLine: -1,
  };
  const before = JSON.stringify(input);
  assert.ok(buildExternalOddsAnalysisReference(input, NOW));
  assert.equal(JSON.stringify(input), before);
});

verify("presentation freshness window is twelve hours", () => {
  const presentationSource = fs.readFileSync(
    path.join(__dirname, "../src/services/externalOddsReferencePresentation.ts"),
    "utf8",
  );
  assert.match(
    presentationSource,
    /FIVE_HUNDRED_REFERENCE_MAX_AGE_MS\s*=\s*12\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
  );
  assert.doesNotMatch(
    presentationSource,
    /FIVE_HUNDRED_REFERENCE_MAX_AGE_MS\s*=\s*36\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
  );
});

verify("nullish and malformed inputs return null without throwing", () => {
  assert.equal(buildExternalOddsAnalysisReference(null, NOW), null);
  assert.equal(buildExternalOddsAnalysisReference(undefined, NOW), null);
  assert.equal(buildExternalOddsAnalysisReference({}, NOW), null);
  assert.equal(buildExternalOddsAnalysisReference("bad input", NOW), null);
});

console.log(JSON.stringify({
  ok: true,
  verifier: "external-odds-analysis-reference",
  policyVersion: EXTERNAL_ODDS_ANALYSIS_POLICY_VERSION,
  minimumLeaderGap: EXTERNAL_ODDS_MIN_LEADER_GAP,
  minimumLeaderProbability: EXTERNAL_ODDS_MIN_LEADER_PROBABILITY,
  scenarios: scenarios.length,
  passed: scenarios.length,
}, null, 2));
