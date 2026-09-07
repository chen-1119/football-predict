"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  selectOnSaleAnalysisReference,
} = require("../src/services/analysisReferenceSelection.ts");
const {
  formatEvidenceScore,
  getEvidenceScore,
  getPublishedRecommendationEvidenceBreakdown,
} = require("../src/services/predictionPresentation.ts");
const {
  buildExternalOddsAnalysisReference,
} = require("../src/services/externalOddsAnalysisReference.cjs");
const {
  buildImmutableAnalysisReferenceDecision,
} = require("../src/services/immutableAnalysisReferenceDecision.cjs");
const {
  isOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");
const {
  buildPublicRecommendationCopy,
} = require("../src/services/recommendationCopy.ts");
const {
  getAnalysisReferenceHandicapSupplement,
} = require("../src/services/displayRecommendation.ts");

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const weakBest = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "X",
  tipLabel: { zh: "\u5e73\u5c40", en: "Draw" },
  odds: 3.6,
  trustScore: 18,
  recommendationAction: "reference",
  recommendationTier: "multi-factor-watch",
  explanation: { zh: "", en: "" },
  visibilityStatus: "FREE",
  resultStatus: "PENDING",
  multiFactorEvidence: {
    evidenceScore: 18,
    modelProbability: 0.31,
    modelGap: 0,
    expectedValue: -0.1,
    dataQuality: 0.4,
    supportingFactors: [],
    blockers: ["evidence-score-below-threshold"],
    diagnostics: { scoreAligned: true, severeMissingCount: 2 },
  },
};

const baseMatch = (overrides = {}) => ({
  id: "selection-fixture",
  status: "SCHEDULED",
  kickoffTime: new Date(NOW + 4 * 60 * 60 * 1000).toISOString(),
  buyEndTime: new Date(NOW + 3.5 * 60 * 60 * 1000).toISOString(),
  odds: { odds1: 1.56, oddsX: 3.6, odds2: 4.75 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: new Date(NOW - 60_000).toISOString(),
  predictions: [weakBest],
  probabilityModel: {
    inputSufficiency: { sufficient: true },
    publicDecision: { directionPublished: true },
    unifiedPosterior: {
      generatedAt: new Date(NOW - 60_000).toISOString(),
      selectedMarket: "HAD",
      selectedCode: "X",
      selectedProbability: 0.31,
      selectionPolicy: "unified-posterior",
    },
  },
  ...overrides,
});

const scenarios = [];
const verify = (name, fn) => {
  fn();
  scenarios.push(name);
};

verify("stored BEST direction is stable when a clear official market leader disagrees", () => {
  const result = selectOnSaleAnalysisReference(baseMatch(), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.equal(result?.prediction.recommendationTier, "model-low-evidence-data-pick");
  assert.equal(result?.displayOdds, 3.6);
  assert.match(result?.prediction.explanation.en || "", /cannot overwrite the model probability leader/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("an explicit public WATCH cannot be revived as a market direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    predictions: [{
      ...weakBest,
      tipCode: "WATCH",
      tipLabel: { zh: "观察：证据不足，暂无可靠方向", en: "Watch: no reliable direction" },
      recommendationAction: "withhold",
      recommendationTier: "public-watch",
    }],
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result, undefined);
});

verify("r655 pre-cutoff model-only BEST replays the exact API-published identity", () => {
  const publicMetrics = {
    modelProbability: 0.499,
    evidenceCompleteness: 1,
    marketConsistency: "unavailable",
    calibrationSample: 0,
    freshnessQuality: 1,
    freshnessObservedAt: new Date(NOW - 60_000).toISOString(),
    freshnessAsOf: new Date(NOW - 60_000).toISOString(),
    freshnessAgeSeconds: 36,
    freshnessSource: "sporttery",
    freshnessBasis: "observed-at",
  };
  const publishedBest = {
    ...weakBest,
    oddsPoolCode: undefined,
    handicapLine: undefined,
    tipCode: "1",
    odds: 0,
    recommendationTier: "model-only-watch",
    confidence: { publicMetrics },
  };
  const match = baseMatch({
    id: "r655-model-only-published-best",
    odds: { odds1: 1.22, oddsX: 5.4, odds2: 9.8 },
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: new Date(NOW - 30_000).toISOString(),
    handicapLine: "-1",
    handicapOdds: { odds1: 2.5, oddsX: 3.25, odds2: 2.22 },
    handicapOddsSource: "sporttery:HHAD",
    handicapOddsUpdatedAt: new Date(NOW - 30_000).toISOString(),
    predictions: [publishedBest],
    predictionMeta: {
      policyVersion: "sporttery-day-formula-trace-v74-auditable-confidence-facts",
      generatedAt: new Date(NOW - 60_000).toISOString(),
      dualMarketDecision: { version: "present-but-client-companion-forbidden" },
    },
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      oneXTwo: { final: { home: 0.2, draw: 0.3, away: 0.5 } },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "MODEL_ONLY_1X2",
        selectedCode: "1",
        selectedProbability: 0.499,
        policy: "observation-only-audited",
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "published-reference");
  assert.strictEqual(result?.prediction, publishedBest,
    "the UI must replay the API object instead of synthesizing a HAD clone");
  assert.equal(result?.prediction.oddsPoolCode, undefined);
  assert.equal(result?.prediction.handicapLine, undefined);
  assert.equal(result?.prediction.tipCode, "1",
    "a later client probability leader cannot rewrite the published direction");
  const breakdown = getPublishedRecommendationEvidenceBreakdown(match, result?.prediction);
  assert.equal(breakdown.modelProbability, 49.9);
  assert.equal(breakdown.evidenceCompleteness, 100);
  assert.equal(breakdown.marketConsistency, "unavailable");
  assert.equal(breakdown.freshnessQuality, 100);
  const publicCopy = buildPublicRecommendationCopy(match, result?.prediction, "zh", {
    forceReference: true,
  });
  assert.equal(publicCopy.marketLabel, "模型 1X2");
  assert.equal(publicCopy.oddsLabel, "SP --",
    "MODEL_ONLY must not borrow the available HAD SP");
  assert.equal(
    getAnalysisReferenceHandicapSupplement(
      match,
      "zh",
      result?.prediction,
      result?.source,
    ),
    null,
    "a published reference must never synthesize a client companion, even when dualMarketDecision exists",
  );
});

verify("r655 pre-cutoff HHAD BEST keeps pool line direction and published facts", () => {
  const publishedBest = {
    ...weakBest,
    oddsPoolCode: "HHAD",
    handicapLine: "+3",
    tipCode: "1",
    odds: 2.02,
    recommendationTier: "dynamic-evidence-medium-reference",
    confidence: {
      publicMetrics: {
        modelProbability: 0.7100882247731372,
        evidenceCompleteness: 1,
        marketConsistency: "aligned",
        calibrationSample: 0,
        freshnessQuality: 1,
        freshnessObservedAt: new Date(NOW - 60_000).toISOString(),
        freshnessAsOf: new Date(NOW - 60_000).toISOString(),
        freshnessAgeSeconds: 38,
        freshnessSource: "sporttery",
        freshnessBasis: "observed-at",
      },
    },
  };
  const match = baseMatch({
    id: "r655-hhad-published-best",
    handicapLine: "+1",
    handicapOdds: { odds1: 1.44, oddsX: 4.3, odds2: 5.8 },
    handicapOddsSource: "sporttery:HHAD",
    handicapOddsUpdatedAt: new Date(NOW - 30_000).toISOString(),
    predictions: [publishedBest],
    predictionMeta: {
      policyVersion: "sporttery-day-formula-trace-v74-auditable-confidence-facts",
      generatedAt: new Date(NOW - 60_000).toISOString(),
    },
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      oneXTwo: { final: { home: 0.1, draw: 0.2, away: 0.7 } },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HHAD",
        selectedCode: "1",
        selectedProbability: 0.7100882247731372,
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "published-reference");
  assert.strictEqual(result?.prediction, publishedBest);
  assert.equal(result?.prediction.oddsPoolCode, "HHAD");
  assert.equal(result?.prediction.handicapLine, "+3");
  assert.equal(result?.prediction.tipCode, "1");
  const breakdown = getPublishedRecommendationEvidenceBreakdown(match, result?.prediction);
  assert.equal(Math.round(breakdown.modelProbability), 71);
  assert.equal(breakdown.marketConsistency, "aligned");
  const publicCopy = buildPublicRecommendationCopy(match, result?.prediction, "zh", {
    forceReference: true,
  });
  assert.equal(publicCopy.marketLabel, "让球玩法");
  assert.equal(publicCopy.oddsLabel, "SP --",
    "published HHAD +3 must not borrow current official HHAD +1 SP or its stored old-line price");
});

verify("r655 pre-cutoff BEST without public metrics keeps identity and remains unavailable", () => {
  const publishedBest = {
    ...weakBest,
    oddsPoolCode: undefined,
    handicapLine: undefined,
    tipCode: "2",
    odds: 0,
    recommendationTier: "model-only-watch",
    confidence: undefined,
  };
  const match = baseMatch({
    id: "r655-missing-public-facts",
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [publishedBest],
    predictionMeta: {
      policyVersion: "sporttery-day-formula-trace-v74-auditable-confidence-facts",
      generatedAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "published-reference");
  assert.strictEqual(result?.prediction, publishedBest);
  const breakdown = getPublishedRecommendationEvidenceBreakdown(match, result?.prediction);
  assert.equal(breakdown.modelProbability, null);
  assert.equal(breakdown.evidenceCompleteness, null);
  assert.equal(breakdown.marketConsistency, "unavailable");
  assert.equal(breakdown.freshnessQuality, null);
});

verify("r655 30-row live shape preserves every API BEST identity and fact count", () => {
  const namedRows = [
    "周三009",
    "周四002",
    ...Array.from({ length: 11 }, (_, index) => `MODEL-${index + 3}`),
    "周三010",
    ...Array.from({ length: 16 }, (_, index) => `HAD-${index + 1}`),
  ];
  const selections = namedRows.map((matchNo, index) => {
    const poolCode = index < 13 ? undefined : index === 13 ? "HHAD" : "HAD";
    const tipCode = matchNo === "周三009" || matchNo === "周四002" || matchNo === "周三010"
      ? "1"
      : index % 3 === 0 ? "X" : index % 3 === 1 ? "1" : "2";
    const publicMetrics = index < 14 ? {
      modelProbability: index === 13 ? 0.7100882247731372 : 0.499,
      evidenceCompleteness: 1,
      marketConsistency: index === 13 ? "aligned" : "unavailable",
      calibrationSample: 0,
      freshnessQuality: 1,
      freshnessObservedAt: new Date(NOW - 60_000).toISOString(),
      freshnessAsOf: new Date(NOW - 60_000).toISOString(),
      freshnessAgeSeconds: 36,
      freshnessSource: "sporttery",
      freshnessBasis: "observed-at",
    } : undefined;
    const publishedBest = {
      ...weakBest,
      oddsPoolCode: poolCode,
      handicapLine: poolCode === "HHAD" ? "+3" : poolCode === "HAD" ? "0" : undefined,
      tipCode,
      odds: poolCode ? (poolCode === "HHAD" ? 2.02 : 1.91) : 0,
      confidence: publicMetrics ? { publicMetrics } : undefined,
    };
    const match = baseMatch({
      id: `r655-live-shape-${index + 1}`,
      matchNo,
      predictions: [publishedBest],
      handicapLine: "+1",
      handicapOdds: { odds1: 1.44, oddsX: 4.3, odds2: 5.8 },
      handicapOddsSource: "sporttery:HHAD",
      handicapOddsUpdatedAt: new Date(NOW - 30_000).toISOString(),
      predictionMeta: {
        policyVersion: "sporttery-day-formula-trace-v74-auditable-confidence-facts",
        generatedAt: new Date(NOW - 60_000).toISOString(),
      },
      probabilityModel: {
        inputSufficiency: { sufficient: true },
        publicDecision: { directionPublished: true },
        unifiedPosterior: {
          generatedAt: new Date(NOW - 60_000).toISOString(),
          selectedMarket: poolCode || "MODEL_ONLY_1X2",
          selectedCode: tipCode,
          selectedProbability: publicMetrics?.modelProbability || 0.49,
        },
      },
    });
    const selected = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
    assert.equal(selected?.source, "published-reference", `${matchNo} source`);
    assert.strictEqual(selected?.prediction, publishedBest, `${matchNo} object identity`);
    assert.equal(selected?.prediction.oddsPoolCode, poolCode, `${matchNo} pool identity`);
    assert.equal(selected?.prediction.handicapLine, publishedBest.handicapLine, `${matchNo} line identity`);
    assert.equal(selected?.prediction.tipCode, tipCode, `${matchNo} direction identity`);
    return {
      selected,
      facts: getPublishedRecommendationEvidenceBreakdown(match, selected?.prediction),
      copy: buildPublicRecommendationCopy(match, selected?.prediction, "zh", { forceReference: true }),
    };
  });

  assert.equal(selections.filter(({ selected }) => selected?.prediction.oddsPoolCode === undefined).length, 13);
  assert.equal(selections.filter(({ selected }) => selected?.prediction.oddsPoolCode === "HHAD").length, 1);
  assert.equal(selections.filter(({ selected }) => selected?.prediction.oddsPoolCode === "HAD").length, 16);
  assert.equal(selections.filter(({ facts }) => facts.modelProbability !== null).length, 14);
  assert.equal(selections.filter(({ facts }) => facts.modelProbability === null).length, 16);
  assert.equal(selections.filter(({ copy }) => copy.oddsLabel === "SP --").length, 14,
    "13 MODEL_ONLY rows plus the mismatched published HHAD line must stay SP unavailable");
});

verify("r655 published replay does not bypass a closed sale cutoff", () => {
  const publishedBest = {
    ...weakBest,
    confidence: { publicMetrics: { modelProbability: 0.31 } },
  };
  const match = baseMatch({
    predictions: [publishedBest],
    buyEndTime: new Date(NOW - 1).toISOString(),
    predictionMeta: {
      policyVersion: "sporttery-day-formula-trace-v74-auditable-confidence-facts",
      generatedAt: new Date(NOW - 60_000).toISOString(),
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.notEqual(result?.source, "published-reference");
  assert.notStrictEqual(result?.prediction, publishedBest);
  assert.match(result?.prediction.riskTags?.[0]?.en || "", /Sales closed; review only/);
  assert.match(result?.prediction.explanation?.en || "", /Locked pre-cutoff data pick retained/);
});

verify("fresh inherited 500 source cannot replace a stored BEST direction", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    oddsUpdatedAt: undefined,
    externalSignals: {
      source: "500.com:jczq",
      updatedAt,
      bookmakerOdds: {
        had: { odds1: 1.54, oddsX: 3.6, odds2: 4.95 },
        hhad: { odds1: 3, oddsX: 3.1, odds2: 2.11, handicapLine: -1 },
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, null);
});

verify("fresh nested 500 source cannot replace a stored BEST direction", () => {
  const staleUpdatedAt = new Date(NOW - 13 * 60 * 60 * 1000).toISOString();
  const freshUpdatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    odds: { odds1: 1.54, oddsX: 3.6, odds2: 4.95, updatedAt: staleUpdatedAt },
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
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, null);
});

verify("low-quality stored BEST cannot be overwritten by a clear official market direction", () => {
  const opposite = {
    ...weakBest,
    tipCode: "2",
    multiFactorEvidence: { ...weakBest.multiFactorEvidence, evidenceScore: 60 },
  };
  const match = baseMatch({
    predictions: [opposite],
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HAD",
        selectedCode: "2",
        selectedProbability: 0.55,
        selectionPolicy: "unified-posterior",
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.displayOdds, 4.75);
});

verify("directional-eligible opposite model replaces rather than erases the market reference", () => {
  const opposite = {
    ...weakBest,
    tipCode: "2",
    recommendationTier: "multi-factor-reference",
    multiFactorEvidence: {
      ...weakBest.multiFactorEvidence,
      evidenceScore: 60,
      modelProbability: 0.55,
      modelGap: 0.08,
      expectedValue: 0.03,
      dataQuality: 0.8,
      supportingFactors: ["model-edge", "form", "line-movement"],
      blockers: [],
      diagnostics: {
        scoreAligned: true,
        crossMarketCompatible: true,
        externalMarketContradicted: false,
        severeMissingCount: 0,
      },
    },
  };
  const match = baseMatch({
    predictions: [opposite],
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HAD",
        selectedCode: "2",
        selectedProbability: 0.55,
        selectionPolicy: "unified-posterior",
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW });
  assert.equal(result?.source, "strong-model");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.displayOdds, 4.75);
});

verify("missing BEST pool inherits HHAD semantics, line, label, and SP from the posterior market", () => {
  const hhadBest = {
    ...weakBest,
    oddsPoolCode: undefined,
    handicapLine: undefined,
    tipCode: "2",
    tipLabel: { zh: "\u5ba2\u80dc", en: "Away win" },
    recommendationTier: "multi-factor-reference",
    multiFactorEvidence: {
      ...weakBest.multiFactorEvidence,
      evidenceScore: 60,
      modelProbability: 0.55,
      modelGap: 0.08,
      expectedValue: 0.03,
      dataQuality: 0.8,
      supportingFactors: ["model-edge", "form", "line-movement"],
      blockers: [],
      diagnostics: {
        scoreAligned: true,
        crossMarketCompatible: true,
        externalMarketContradicted: false,
        severeMissingCount: 0,
      },
    },
  };
  const match = baseMatch({
    handicapLine: "-1",
    handicapOdds: { odds1: 2.8, oddsX: 3.4, odds2: 2.05 },
    handicapOddsSource: "sporttery:HHAD",
    handicapOddsUpdatedAt: new Date(NOW - 60_000).toISOString(),
    predictions: [hhadBest],
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HHAD",
        selectedCode: "2",
        selectedProbability: 0.55,
        selectionPolicy: "unified-posterior",
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW });
  assert.equal(result?.source, "strong-model");
  assert.equal(result?.prediction.oddsPoolCode, "HHAD");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.prediction.handicapLine, "-1");
  assert.deepEqual(result?.prediction.tipLabel, { zh: "\u8ba9\u8d1f", en: "Handicap away" });
  assert.equal(result?.prediction.odds, 2.05);
  assert.equal(result?.displayOdds, 2.05);
});

verify("explicit HAD/HHAD posterior mismatch cannot enter the strong-model lane", () => {
  const mismatched = {
    ...weakBest,
    tipCode: "2",
    recommendationTier: "multi-factor-reference",
    multiFactorEvidence: {
      ...weakBest.multiFactorEvidence,
      evidenceScore: 60,
      modelProbability: 0.55,
      modelGap: 0.08,
      expectedValue: 0.03,
      dataQuality: 0.8,
      supportingFactors: ["model-edge", "form", "line-movement"],
      blockers: [],
      diagnostics: { scoreAligned: true, crossMarketCompatible: true, severeMissingCount: 0 },
    },
  };
  const match = baseMatch({
    predictions: [mismatched],
    probabilityModel: {
      ...baseMatch().probabilityModel,
      unifiedPosterior: {
        ...baseMatch().probabilityModel.unifiedPosterior,
        selectedMarket: "HHAD",
        selectedCode: "2",
        selectedProbability: 0.55,
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW });
  assert.notEqual(result?.source, "strong-model");
  assert.equal(result?.prediction.oddsPoolCode, "HAD");
});

verify("balanced official HAD supplies the stored BEST price without changing direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: { odds1: 2.55, oddsX: 3.05, odds2: 2.65 },
  }), { now: NOW });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.prediction.recommendationTier, "model-low-evidence-data-pick");
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.equal(result?.displayOdds, 3.05);
  assert.match(result?.prediction.explanation.zh || "", /\u5e02\u573a\u6982\u7387\u9996\u4f4d\u4e0d\u4f1a\u6539\u5199\u6a21\u578b\u6982\u7387\u9996\u4f4d/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("stale official HAD is not presented as a current price for the stored BEST", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    oddsUpdatedAt: new Date(NOW - 13 * 60 * 60 * 1000).toISOString(),
  }), { now: NOW });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, null);
  assert.match(result?.prediction.explanation.en || "", /No fresh verifiable official HAD SP/);
});

verify("equal official HAD prices retain the stored BEST direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: { odds1: 3, oddsX: 3, odds2: 3 },
  }), { now: NOW });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, 3);
});

verify("balanced 500 HAD cannot replace a stored BEST direction", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    externalSignals: {
      source: "500.com:jczq",
      updatedAt,
      bookmakerOdds: {
        had: { odds1: 3.15, oddsX: 3.65, odds2: 1.86 },
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.prediction.recommendationTier, "model-low-evidence-data-pick");
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.equal(result?.prediction.odds, 0);
  assert.equal(result?.displayOdds, null);
  assert.match(result?.prediction.analysisItems?.[0]?.en || "", /cannot reselect the main direction/);
  assert.equal(isOfficialRecommendationEligible(match, result?.prediction, NOW), false);
});

verify("KuPS versus Sabah keeps stored draw while official away is the market leader", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    id: "sporttery_2040643",
    odds: { odds1: 2.6, oddsX: 3.3, odds2: 2.27 },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, 3.3);
});

verify("Hearts versus Sturm Graz keeps stored draw while official home is the market leader", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    id: "sporttery_2040644",
    odds: { odds1: 1.75, oddsX: 3.75, odds2: 3.45 },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.displayOdds, 3.75);
});

verify("official market consensus may fill direction only when no BEST or model direction exists", () => {
  const match = baseMatch({
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "official-market-consensus");
  assert.equal(result?.prediction.tipCode, "1");
  assert.equal(result?.displayOdds, 1.56);
});

verify("500 market direction may fill direction only when no BEST or model direction exists", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
    externalSignals: {
      source: "500.com:jczq",
      updatedAt,
      bookmakerOdds: {
        had: { odds1: 3.15, oddsX: 3.65, odds2: 1.86 },
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.ok(["five-hundred-market", "five-hundred-low-evidence-market"].includes(result?.source));
  assert.equal(result?.prediction.tipCode, "2");
});

verify("fresh 500 HAD replaces an unaudited cold-start fingerprint but keeps one recommendation", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    odds: { odds1: 3.15, oddsX: 3.65, odds2: 1.86 },
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: updatedAt,
    probabilityModel: {
      inputSufficiency: { sufficient: false },
      oneXTwo: { final: { home: 45, draw: 30.2, away: 24.8 } },
      unifiedPosterior: {
        generatedAt: updatedAt,
        selectedMarket: "MODEL_ONLY_1X2",
        selectedCode: "1",
        selectedProbability: 45,
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "five-hundred-market");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.displayOdds, 1.86);
  assert.ok(["1", "X", "2"].includes(result?.prediction.tipCode));
});

verify("an immutable weak-model data reference keeps the same direction before and after cutoff", () => {
  const updatedAt = new Date(NOW - 60_000).toISOString();
  const match = baseMatch({
    id: "sporttery_immutable_away",
    sourceMatchId: "immutable_away",
    odds: { odds1: 1 / 0.30, oddsX: 1 / 0.29, odds2: 1 / 0.41, updatedAt },
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: updatedAt,
    probabilityModel: {
      inputSufficiency: { sufficient: false },
      oneXTwo: { final: { home: 45, draw: 30, away: 25 } },
      unifiedPosterior: {
        generatedAt: updatedAt,
        selectedMarket: "MODEL_ONLY_1X2",
        selectedCode: "1",
        selectedProbability: 45,
      },
    },
  });
  const decision = buildImmutableAnalysisReferenceDecision(match, new Date(NOW).toISOString());
  assert.ok(decision);
  const boundMatch = {
    ...match,
    predictionMeta: {
      ...(match.predictionMeta || {}),
      immutableAnalysisReferenceDecision: decision,
    },
  };
  const beforeCutoff = selectOnSaleAnalysisReference(boundMatch, { now: NOW, allowModelOnly: true });
  const afterCutoff = selectOnSaleAnalysisReference(boundMatch, {
    now: Date.parse(match.buyEndTime) + 60_000,
    allowModelOnly: true,
  });
  assert.equal(beforeCutoff?.source, "immutable-five-hundred-market");
  assert.equal(afterCutoff?.source, "immutable-five-hundred-market");
  assert.equal(beforeCutoff?.prediction.tipCode, "2");
  assert.equal(afterCutoff?.prediction.tipCode, "2");
  assert.equal(afterCutoff?.prediction.recommendationAction, "reference");
  assert.equal(isOfficialRecommendationEligible(boundMatch, afterCutoff?.prediction, NOW), false);
});

verify("no HAD odds retains the stored model direction as a low-confidence data pick without fabricating a price", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.prediction.odds, 0);
  assert.equal(result?.displayOdds, null);
  assert.equal(result?.prediction.recommendationTier, "model-low-evidence-data-pick");
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.match(result?.prediction.explanation?.en || "", /No fresh verifiable official HAD SP/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("complete stored model probabilities provide a deterministic final direction when BEST and posterior selection are absent", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [],
    probabilityModel: {
      oneXTwo: {
        final: { home: 24, draw: 31, away: 45 },
      },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
      },
    },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.prediction.odds, 0);
  assert.equal(result?.displayOdds, null);
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.equal(result?.prediction.trustScore, 45);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("weak draw safeguard cannot override the independent probability leader", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      oneXTwo: { final: { home: 46, draw: 26, away: 28 } },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HAD",
        selectedCode: "X",
        selectedProbability: 0.31,
        selectionPolicy: "score-draw-risk-safeguard",
      },
    },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "1");
  assert.equal(result?.prediction.oddsPoolCode, "HAD");
  assert.equal(result?.prediction.trustScore, 46);
  assert.equal(result?.displayOdds, 1.56);
  assert.match(result?.prediction.explanation.en || "", /independent pre-match model probability leader is Home win/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("unresolved model ties use stable match identity without a fixed draw bias", () => {
  const picks = ["tie-a", "tie-b", "tie-c", "tie-d", "tie-e", "tie-f"].map((id) => (
    selectOnSaleAnalysisReference(baseMatch({
      id,
      odds: undefined,
      oddsSource: undefined,
      oddsUpdatedAt: undefined,
      probabilityModel: {
        oneXTwo: { final: { home: 1, draw: 1, away: 1 } },
        unifiedPosterior: {
          generatedAt: new Date(NOW - 60_000).toISOString(),
          selectedCode: "X",
          selectionPolicy: "score-draw-risk-safeguard",
        },
      },
    }), { now: NOW, allowModelOnly: true })?.prediction.tipCode
  ));
  assert.ok(picks.every((code) => ["1", "X", "2"].includes(code)));
  assert.ok(new Set(picks).size > 1, `expected distributed deterministic ties, received ${picks.join(",")}`);
  assert.ok(picks.some((code) => code !== "X"), `tie-break must not force every match to draw: ${picks.join(",")}`);
});

verify("existing audited model-only direction remains the no-odds fallback", () => {
  const modelOnly = {
    ...weakBest,
    tipCode: "2",
    recommendationTier: "model-only-watch",
    odds: 0,
  };
  const match = baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [modelOnly],
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      contextSignals: {
        dataGaps: { coverageScore: 80, severeMissingCount: 0 },
      },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "MODEL_ONLY_1X2",
        selectedCode: "2",
        selectedProbability: 0.62,
        policy: "observation-only-audited",
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-only");
  assert.equal(result?.prediction.tipCode, "2");
  assert.equal(result?.displayOdds, null);
  assert.equal(result?.prediction.odds, 0);
  assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: false }), undefined);
});

verify("closed sale window retains a clocked pre-cutoff model direction as non-executable", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    buyEndTime: new Date(NOW - 1).toISOString(),
  }), { now: NOW });
  assert.equal(result?.source, "model-low-evidence");
  assert.match(result?.prediction.explanation?.en || "", /Locked pre-cutoff data pick/);
  assert.equal(result?.prediction.odds, 3.6);
});

verify("closed sale window keeps the pre-cutoff BEST ahead of a 500 market direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    buyEndTime: new Date(NOW - 1).toISOString(),
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "model-low-evidence");
  assert.equal(result?.prediction.tipCode, "X");
  assert.equal(result?.prediction.recommendationAction, "reference");
  assert.match(result?.prediction.explanation?.en || "", /Locked pre-cutoff data pick/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
});

verify("closed sale window replays the verified atomic HAD leg even when ordinary freshness expires", () => {
  const decisionAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const cutoffTime = new Date(NOW - 1).toISOString();
  const match = baseMatch({
    buyEndTime: cutoffTime,
    oddsUpdatedAt: new Date(NOW - 13 * 60 * 60 * 1000).toISOString(),
    predictionMeta: {
      generatedAt: new Date(NOW - 13 * 60 * 60 * 1000).toISOString(),
      dualMarketDecision: {
        version: "dual-market-decision-binding-v1",
        decisionSnapshotVersion: "candidate-decision-snapshot-v2",
        sourceCycleId: "verified-pre-cutoff-cycle",
        bindingHash: "a".repeat(64),
        publicBindingVersion: "dual-market-public-binding-v1",
        publicBindingHash: "b".repeat(64),
        integrityVerified: true,
        integrityVersion: "dual-market-decision-integrity-v1",
        sourceClocks: {
          decisionAt,
          cutoffTime,
          hadObservedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
          hadReceivedAt: new Date(NOW - 2.5 * 60 * 60 * 1000).toISOString(),
        },
        strategyVersions: {
          predictionPolicy: "policy-v1",
          model: "model-v1",
          calibration: "calibration-v1",
        },
        had: {
          poolCode: "HAD",
          code: "1",
          odds: 1.47,
          modelProbability: 0.509,
          marketProbability: 0.603,
          recommendationAction: "reference",
        },
      },
    },
    probabilityModel: {
      ...baseMatch().probabilityModel,
      unifiedPosterior: {
        ...baseMatch().probabilityModel.unifiedPosterior,
        generatedAt: new Date(NOW - 13 * 60 * 60 * 1000).toISOString(),
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "atomic-dual-market-reference");
  assert.equal(result?.prediction.tipCode, "1");
  assert.equal(result?.prediction.odds, 1.47);
  assert.equal(result?.prediction.trustScore, result?.prediction.confidence?.score,
    "atomic reference confidence must come from the shared dynamic evidence scorer");
  assert.equal(result?.prediction.confidence?.available, false,
    "a bound reference without observed freshness must expose unavailable confidence");
  assert.ok(result?.prediction.confidence?.unavailableReasons?.includes("freshness-quality-missing"));
  assert.equal(getEvidenceScore(result?.prediction), null);
  assert.equal(formatEvidenceScore(result?.prediction), "--");
  assert.ok(Number(result?.rankScore) >= 500,
    "confidence unavailability must not erase the locked reference source priority");
  assert.equal(result?.prediction.confidence?.priceIndependent, true);
  assert.match(result?.prediction.recommendationTier || "", /^atomic-dual-market-/);
  assert.match(result?.prediction.explanation?.en || "", /atomic decision locked HAD Home/);
  assert.ok(
    (result?.prediction.analysisItems || []).some((item) => /verified dual-market binding/.test(item?.en || "")),
    "expected the replayed direction to retain verified dual-market binding provenance"
  );
  assert.equal(isOfficialRecommendationEligible(match, result?.prediction, NOW), false);
});

verify("atomic HAD direction stays visible and SP does not impose a confidence cap", () => {
  const decisionAt = new Date(NOW - 20 * 60 * 1000).toISOString();
  const cutoffTime = new Date(NOW + 15 * 60 * 1000).toISOString();
  const match = baseMatch({
    buyEndTime: cutoffTime,
    predictions: [{ ...weakBest, tipCode: "X", odds: 3.2 }],
    predictionMeta: {
      generatedAt: decisionAt,
      dualMarketDecision: {
        version: "dual-market-decision-binding-v1",
        decisionSnapshotVersion: "candidate-decision-snapshot-v2",
        sourceCycleId: "verified-long-price-cycle",
        bindingHash: "e".repeat(64),
        publicBindingVersion: "dual-market-public-binding-v1",
        publicBindingHash: "f".repeat(64),
        integrityVerified: true,
        integrityVersion: "dual-market-decision-integrity-v1",
        sourceClocks: {
          decisionAt,
          cutoffTime,
          hadObservedAt: new Date(NOW - 25 * 60 * 1000).toISOString(),
          hadReceivedAt: new Date(NOW - 22 * 60 * 1000).toISOString(),
        },
        strategyVersions: {
          predictionPolicy: "policy-v1",
          model: "model-v1",
          calibration: "calibration-v1",
        },
        had: {
          poolCode: "HAD",
          code: "X",
          odds: 3.2,
          modelProbability: 0.61,
          marketProbability: 0.31,
          recommendationAction: "reference",
        },
      },
    },
  });
  const result = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "atomic-dual-market-reference");
  assert.equal(result?.prediction.tipCode, "X", "the visible direction must not disappear");
  assert.equal(result?.prediction.trustScore, result?.prediction.confidence?.score);
  assert.equal(result?.prediction.confidence?.priceIndependent, true);
  assert.match(result?.prediction.recommendationTier || "", /^atomic-dual-market-/);
  assert.ok(!(result?.prediction.riskTags || []).some((item) => /Long-price direction/.test(item?.en || "")));
  assert.equal(isOfficialRecommendationEligible(match, result?.prediction, NOW), false);
});

verify("verified atomic HAD direction is identical before and after cutoff when the probability leader disagrees", () => {
  const cutoffAt = NOW + 30 * 60 * 1000;
  const decisionAt = new Date(NOW - 2 * 60 * 1000).toISOString();
  const cutoffTime = new Date(cutoffAt).toISOString();
  const match = baseMatch({
    buyEndTime: cutoffTime,
    predictions: [{ ...weakBest, tipCode: "2" }],
    predictionMeta: {
      generatedAt: decisionAt,
      dualMarketDecision: {
        version: "dual-market-decision-binding-v1",
        decisionSnapshotVersion: "candidate-decision-snapshot-v2",
        sourceCycleId: "verified-visible-direction-cycle",
        bindingHash: "c".repeat(64),
        publicBindingVersion: "dual-market-public-binding-v1",
        publicBindingHash: "d".repeat(64),
        integrityVerified: true,
        integrityVersion: "dual-market-decision-integrity-v1",
        sourceClocks: {
          decisionAt,
          cutoffTime,
          hadObservedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
          hadReceivedAt: new Date(NOW - 3 * 60 * 1000).toISOString(),
        },
        strategyVersions: {
          predictionPolicy: "policy-v1",
          model: "model-v1",
          calibration: "calibration-v1",
        },
        had: {
          poolCode: "HAD",
          code: "2",
          odds: 1.83,
          modelProbability: 0.299,
          marketProbability: 0.41,
          recommendationAction: "reference",
        },
      },
    },
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      oneXTwo: { final: { home: 45.1, draw: 25, away: 29.9 } },
      unifiedPosterior: {
        generatedAt: decisionAt,
        selectedMarket: "HAD",
        selectedCode: "2",
        selectedProbability: 0.299,
        selectionPolicy: "unified-posterior",
      },
    },
  });

  const beforeCutoff = selectOnSaleAnalysisReference(match, {
    now: NOW,
    allowModelOnly: true,
  });
  const afterCutoff = selectOnSaleAnalysisReference(match, {
    now: cutoffAt + 1,
    allowModelOnly: true,
  });

  assert.equal(beforeCutoff?.source, "atomic-dual-market-reference");
  assert.equal(afterCutoff?.source, "atomic-dual-market-reference");
  assert.equal(beforeCutoff?.prediction.tipCode, "2");
  assert.equal(afterCutoff?.prediction.tipCode, "2");
  assert.equal(beforeCutoff?.prediction.odds, 1.83);
  assert.equal(afterCutoff?.prediction.odds, 1.83);
});

verify("invalid atomic hashes cannot revive a stale post-cutoff direction", () => {
  const staleAt = new Date(NOW - 13 * 60 * 60 * 1000).toISOString();
  const result = selectOnSaleAnalysisReference(baseMatch({
    buyEndTime: new Date(NOW - 1).toISOString(),
    oddsUpdatedAt: staleAt,
    predictionMeta: {
      generatedAt: staleAt,
      dualMarketDecision: {
        version: "dual-market-decision-binding-v1",
        decisionSnapshotVersion: "candidate-decision-snapshot-v2",
        sourceCycleId: "untrusted-cycle",
        bindingHash: "not-a-sha256",
        publicBindingVersion: "dual-market-public-binding-v1",
        publicBindingHash: "b".repeat(64),
        integrityVerified: true,
        integrityVersion: "dual-market-decision-integrity-v1",
        sourceClocks: {
          decisionAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
          cutoffTime: new Date(NOW - 1).toISOString(),
          hadObservedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
          hadReceivedAt: new Date(NOW - 2.5 * 60 * 60 * 1000).toISOString(),
        },
        strategyVersions: { predictionPolicy: "policy-v1", model: "model-v1", calibration: "calibration-v1" },
        had: { poolCode: "HAD", code: "1", odds: 1.47, modelProbability: 0.509, marketProbability: 0.603 },
      },
    },
    probabilityModel: {
      ...baseMatch().probabilityModel,
      unifiedPosterior: {
        ...baseMatch().probabilityModel.unifiedPosterior,
        generatedAt: staleAt,
      },
    },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result, undefined);
});

verify("post-cutoff or unclocked 500 prices cannot create a locked direction", () => {
  const closedAt = new Date(NOW - 60_000).toISOString();
  assert.equal(selectOnSaleAnalysisReference(baseMatch({
    buyEndTime: closedAt,
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: new Date(NOW).toISOString(),
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: true }), undefined);
  assert.equal(selectOnSaleAnalysisReference(baseMatch({
    buyEndTime: closedAt,
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: undefined,
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: true }), undefined);
});

verify("no market and no stored or posterior direction remains empty", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result, undefined);
});

verify("public cards keep a missing-SP fixture directionless even with a strong model candidate", () => {
  const strong = {
    ...weakBest,
    tipCode: "1",
    recommendationTier: "multi-factor-reference",
    multiFactorEvidence: {
      ...weakBest.multiFactorEvidence,
      evidenceScore: 70,
      modelProbability: 0.58,
      modelGap: 0.12,
      expectedValue: 0.04,
      dataQuality: 0.82,
      supportingFactors: ["model-edge", "form", "line-movement"],
      blockers: [],
      diagnostics: {
        scoreAligned: true,
        crossMarketCompatible: true,
        externalMarketContradicted: false,
        severeMissingCount: 0,
      },
    },
  };
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: undefined,
    oddsSource: undefined,
    oddsUpdatedAt: undefined,
    predictions: [strong],
    probabilityModel: {
      inputSufficiency: { sufficient: true },
      publicDecision: { directionPublished: true },
      unifiedPosterior: {
        generatedAt: new Date(NOW - 60_000).toISOString(),
        selectedMarket: "HAD",
        selectedCode: "1",
        selectedProbability: 0.58,
        selectionPolicy: "unified-posterior",
      },
    },
  }), { now: NOW, allowModelOnly: false });
  assert.equal(result, undefined);
});

verify("public cards do not turn a balanced official market tie into a draw direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: { odds1: 3, oddsX: 3, odds2: 3 },
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: false });
  assert.equal(result, undefined);
});

verify("internal replay can still audit the explicit neutral tie-break", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    odds: { odds1: 3, oddsX: 3, odds2: 3 },
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: true });
  assert.equal(result?.source, "official-low-evidence-market");
  assert.equal(result?.prediction.tipCode, "X");
});

verify("public cards retain a clear fresh official market direction", () => {
  const result = selectOnSaleAnalysisReference(baseMatch({
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  }), { now: NOW, allowModelOnly: false });
  assert.equal(result?.source, "official-market-consensus");
  assert.equal(result?.prediction.tipCode, "1");
  assert.equal(result?.displayOdds, 1.56);
});

verify("500 payload shape is selectable before a future cutoff", () => {
  const currentPath = path.resolve(__dirname, "..", "public", "data", "matches-current.json");
  const payload = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.matches || [];
  const currentSourceRow = rows.find((row) => {
    const topLevel500 = String(row.oddsSource || "").toLowerCase().startsWith("500.com:had");
    const nested500 = (
      row.externalSignals?.source === "500.com:jczq"
      && row.externalSignals?.bookmakerOdds?.had
    );
    if (!topLevel500 && !nested500) return false;
    const sourceUpdatedAt = Date.parse(
      row.oddsUpdatedAt
      || row.externalSignals?.bookmakerOdds?.had?.updatedAt
      || row.externalSignals?.updatedAt
      || ""
    );
    if (!Number.isFinite(sourceUpdatedAt)) return false;
    return Boolean(buildExternalOddsAnalysisReference({
      ...row,
      status: "SCHEDULED",
      kickoffTime: new Date(sourceUpdatedAt + 4 * 60 * 60 * 1000).toISOString(),
      buyEndTime: new Date(sourceUpdatedAt + 3.5 * 60 * 60 * 1000).toISOString(),
    }, sourceUpdatedAt + 60_000));
  });
  // A healthy current slate can legitimately contain no 500.com enrichment.
  // Keep this contract deterministic instead of making the verifier depend on
  // whichever leagues happen to be on sale when it runs.
  const sourceRow = currentSourceRow || baseMatch({
    id: "five-hundred-payload-fixture",
    oddsSource: "500.com:HAD",
    oddsUpdatedAt: new Date(NOW - 60_000).toISOString(),
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
  });
  const sourceUpdatedAt = Date.parse(
    sourceRow.oddsUpdatedAt
    || sourceRow.externalSignals?.bookmakerOdds?.had?.updatedAt
    || sourceRow.externalSignals?.updatedAt
    || ""
  );
  assert.ok(Number.isFinite(sourceUpdatedAt));
  const match = {
    ...sourceRow,
    predictions: [],
    probabilityModel: { unifiedPosterior: {} },
    status: "SCHEDULED",
    kickoffTime: new Date(sourceUpdatedAt + 4 * 60 * 60 * 1000).toISOString(),
    buyEndTime: new Date(sourceUpdatedAt + 3.5 * 60 * 60 * 1000).toISOString(),
  };
  const result = selectOnSaleAnalysisReference(match, {
    allowModelOnly: true,
    now: sourceUpdatedAt + 60_000,
  });
  assert.equal(result?.source, "five-hundred-market");
  assert.ok(["1", "X", "2"].includes(result.prediction.tipCode));
});

verify("retimed current shapes cannot retain old event bindings; explicitly unbound legacy shapes replay BEST", () => {
  const currentPath = path.resolve(__dirname, "..", "public", "data", "matches-current.json");
  const payload = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  const rows = (Array.isArray(payload) ? payload : payload.matches || [])
    .filter((row) => row.status === "SCHEDULED" && row.probabilityModel?.oneXTwo?.final);
  // Live slates do not guarantee any particular policy. Always exercise both
  // safeguard provenance branches using explicit synthetic rows, even off-season.
  for (const provenance of [false, true]) rows.push(baseMatch({
    id: `synthetic-safeguard-${provenance ? 'published' : 'unbound'}`,
    predictionMeta: provenance ? {
      policyVersion: 'synthetic-safeguard-v1', generatedAt: new Date(NOW - 60000).toISOString(),
    } : undefined,
    probabilityModel: {
      ...baseMatch().probabilityModel,
      oneXTwo: { final: { home: 0.7, draw: 0.2, away: 0.1 } },
      unifiedPosterior: {
        ...baseMatch().probabilityModel.unifiedPosterior,
        selectionPolicy: 'score-draw-risk-safeguard',
      },
    },
  }));

  const selections = rows.map((row, index) => {
    const unifiedPosterior = row.probabilityModel?.unifiedPosterior || {};
    const match = {
      ...row,
      kickoffTime: new Date(NOW + (4 + index) * 60 * 60 * 1000).toISOString(),
      buyEndTime: new Date(NOW + (3.5 + index) * 60 * 60 * 1000).toISOString(),
      oddsUpdatedAt: row.odds ? new Date(NOW - 60_000).toISOString() : row.oddsUpdatedAt,
      probabilityModel: {
        ...row.probabilityModel,
        unifiedPosterior: {
          ...unifiedPosterior,
          generatedAt: new Date(NOW - 60_000).toISOString(),
        },
      },
    };
    if (match.predictionMeta?.publicReferenceDecision) {
      assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true }), undefined,
        'retiming an event invalidates its original public binding');
    }
    // This separate legacy-shape test explicitly has no public record. Never
    // change event clocks and then pretend the original binding still applies.
    const legacy = { ...match, predictionMeta: { ...match.predictionMeta, publicReferenceDecision: undefined } };
    return { row, result: selectOnSaleAnalysisReference(legacy, { now: NOW, allowModelOnly: true }) };
  });

  assert.ok(selections.every(({ result }) => ["1", "X", "2"].includes(result?.prediction.tipCode)));
  const safeguardRows = selections.filter(({ row }) => (
    row.probabilityModel?.unifiedPosterior?.selectionPolicy === "score-draw-risk-safeguard"
  ));
  assert.ok(safeguardRows.length >= 2, "both deterministic safeguard provenance branches must run");
  for (const { row, result } of safeguardRows) {
    const publishedBest = (row.predictions || []).find((prediction) => (
      prediction.marketType === "BEST"
      && prediction.recommendationAction === "reference"
      && ["1", "X", "2"].includes(prediction.tipCode)
    ));
    const provenanceBound = Boolean(
      publishedBest
      && String(row.predictionMeta?.policyVersion || "").trim()
      && Number.isFinite(Date.parse(String(row.predictionMeta?.generatedAt || "")))
    );
    if (provenanceBound) {
      assert.equal(result?.source, "published-reference");
      assert.strictEqual(result?.prediction, publishedBest);
      assert.equal(result?.prediction.tipCode, publishedBest.tipCode,
        `${row.id} must replay the server-published BEST instead of client-side re-selection`);
      assert.equal(result?.prediction.oddsPoolCode, publishedBest.oddsPoolCode);
      assert.equal(result?.prediction.handicapLine, publishedBest.handicapLine);
      continue;
    }
    const final = row.probabilityModel.oneXTwo.final;
    const expected = final.home > final.draw && final.home > final.away
      ? "1"
      : final.away > final.home && final.away > final.draw
        ? "2"
        : "X";
    assert.equal(result?.prediction.tipCode, expected,
      `${row.id} without publication provenance must follow oneXTwo.final instead of the safeguard code`);
  }
});

const { bindPublicReferenceDecision } = require('../src/services/publicReferenceDecision.cjs');
const frozenFixture = () => bindPublicReferenceDecision(baseMatch({ id: 'sporttery_991030', sourceMatchId: '991030',
  predictionMeta: { generatedAt: new Date(NOW - 60000).toISOString(), decisionId: 'qa-record-1', policyVersion: 'qa-policy' },
}), null, new Date(NOW - 50000).toISOString());
verify('bound reference beats a different mutable BEST before and after sale cutoff', () => {
  const published = frozenFixture(), record = published.predictionMeta.publicReferenceDecision;
  const changed = { ...published, predictions: [{ ...weakBest, tipCode: '1', odds: 1.56 }] };
  for (const now of [NOW, Date.parse(published.buyEndTime) + 1]) {
    const selected = selectOnSaleAnalysisReference(changed, { now, allowModelOnly: true });
    assert.equal(selected?.prediction.tipCode, 'X'); assert.equal(selected?.prediction.odds, 3.6);
    assert.equal(selected?.sourceUpdatedAt, record.decisionAt);
  }
});
verify('actual public revision can update the reference while preserving revision lineage', () => {
  const previous = frozenFixture();
  const revised = bindPublicReferenceDecision({ ...previous, predictions: [{ ...weakBest, tipCode: '1', odds: 1.56 }],
    predictionMeta: { ...previous.predictionMeta, decisionId: 'qa-record-2', generatedAt: new Date(NOW - 40000).toISOString() } }, previous, new Date(NOW - 30000).toISOString());
  assert.equal(revised.predictionMeta.publicReferenceDecision.revision, 2);
  assert.equal(revised.predictionMeta.publicReferenceDecision.previousHash, previous.predictionMeta.publicReferenceDecision.contentHash);
  assert.equal(selectOnSaleAnalysisReference(revised, { now: NOW, allowModelOnly: true })?.prediction.tipCode, '1');
});
verify('strict official-card lane replays the bound HAD or withholds, never reselects', () => {
  const match = frozenFixture();
  match.predictions = [{ ...weakBest, tipCode: '1', odds: 1.56 }];
  assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: false })?.prediction.tipCode, 'X');
  for (const overrides of [
    { odds: undefined }, { oddsSource: '500.com:HAD' },
    { oddsUpdatedAt: new Date(NOW - 48 * 3600000).toISOString() },
  ]) assert.equal(selectOnSaleAnalysisReference({ ...match, ...overrides }, { now: NOW, allowModelOnly: false }), undefined);
  assert.equal(selectOnSaleAnalysisReference(match, { now: Date.parse(match.buyEndTime) + 1, allowModelOnly: false }), undefined);
});
for (const [name, mutation] of [
  ['invalid integrity', r => { r.integrityVerified = false; }],
  ['invalid hash', r => { r.contentHash = 'bad'; }],
  ['wrong event', r => { r.sourceMatchId = 'wrong'; }],
  ['wrong kickoff', r => { r.kickoffTime = new Date(NOW + 1).toISOString(); }],
  ['future record', r => { r.recordedAt = new Date(NOW + 1).toISOString(); }],
  ['decision after recording', r => { r.decisionAt = new Date(NOW).toISOString(); }],
  ['record after cutoff', r => { r.cutoffTime = new Date(NOW - 70000).toISOString(); }],
  ['invalid direction', r => { r.prediction.tipCode = 'BAD'; }],
]) verify(`invalid present public record cannot fall back to mutable BEST: ${name}`, () => {
  const match = frozenFixture(); mutation(match.predictionMeta.publicReferenceDecision);
  for (const allowModelOnly of [true, false]) {
    assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly }), undefined);
  }
});
verify('provider alias preserves the public identity and WATCH remains a public withdrawal', () => {
  const match = frozenFixture(); match.id = 'fivehundred_991030'; delete match.sourceMatchId;
  assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true })?.prediction.tipCode, 'X');
  match.predictions = [{ ...weakBest, tipCode: 'WATCH', recommendationTier: 'public-watch' }];
  assert.equal(selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true }), undefined);
});

console.log(JSON.stringify({
  ok: true,
  verifier: "analysis-reference-selection",
  scenarios: scenarios.length,
  passed: scenarios.length,
  selectionOrder: [
    "published-reference",
    "immutable-five-hundred-market",
    "atomic-dual-market-reference",
    "official-calibrated-market",
    "strong-model",
    "model-only",
    "model-low-evidence",
    "official-market-consensus",
    "five-hundred-market",
    "official-low-evidence-market",
    "five-hundred-low-evidence-market",
  ],
}, null, 2));
