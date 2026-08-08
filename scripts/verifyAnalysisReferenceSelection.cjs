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
  buildExternalOddsAnalysisReference,
} = require("../src/services/externalOddsAnalysisReference.cjs");
const {
  isOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");

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
  assert.match(result?.prediction.explanation.en || "", /cannot overwrite the generated direction/);
  assert.equal(isOfficialRecommendationEligible(baseMatch(), result?.prediction, NOW), false);
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
  assert.match(result?.prediction.explanation.zh || "", /\u5e02\u573a\u6982\u7387\u9996\u4f4d\u4e0d\u4f1a\u6539\u5199\u5df2\u751f\u6210\u65b9\u5411/);
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
  assert.equal(result?.prediction.recommendationTier, "atomic-dual-market-bound-reference");
  assert.match(result?.prediction.explanation?.en || "", /atomic decision locked HAD Home/);
  assert.ok(
    (result?.prediction.analysisItems || []).some((item) => /verified dual-market binding/.test(item?.en || "")),
    "expected the replayed direction to retain verified dual-market binding provenance"
  );
  assert.equal(isOfficialRecommendationEligible(match, result?.prediction, NOW), false);
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

verify("current 500 payload shape is selectable before a future cutoff", () => {
  const currentPath = path.resolve(__dirname, "..", "public", "data", "matches-current.json");
  const payload = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.matches || [];
  const sourceRow = rows.find((row) => {
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
  assert.ok(sourceRow, "expected at least one qualifying synced 500.com current row");
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

console.log(JSON.stringify({
  ok: true,
  verifier: "analysis-reference-selection",
  scenarios: scenarios.length,
  passed: scenarios.length,
  selectionOrder: [
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
