"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let ts = null;
if (process.env.VERIFY_DISPLAY_BINDING_SOURCE_ONLY !== "1") {
  try {
    ts = require("typescript");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
}

// Signed candidates intentionally prune development dependencies before
// production readiness. Keep the release gate meaningful there by checking
// the exact immutable-binding branch in source; full workspaces additionally
// execute the behavioral TypeScript fixture below.
if (!ts) {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "services", "displayRecommendation.ts"),
    "utf8"
  );
  assert.match(source, /const isAtomicallyBoundCompanion = handicapPrediction\.recommendationTier === 'handicap-companion-bound';/);
  assert.match(
    source,
    /const displayCode = isAtomicallyBoundCompanion\s*\? handicapPrediction\.tipCode\s*:\s*getCompatibleHandicapCode\(match, primaryPrediction, handicapPrediction\.tipCode\);/,
    "the verified HHAD code must bypass compatibility rewriting"
  );
  assert.match(source, /recommendationTier: 'handicap-companion-bound'/);
  assert.match(source, /getDualMarketCompanionAudit\(match, formalPrediction\)/);
  assert.match(source, /if \(requiresVerifiedBinding && !boundHandicapPrediction\) return null;/);
  assert.match(source, /stale-prediction-line-conflict/);
  console.log(JSON.stringify({
    ok: true,
    verifier: "display-recommendation-binding-integrity",
    mode: "pruned-candidate-source-contract",
    expected: { immutableBoundCode: true },
    actual: { immutableBoundCode: true },
  }, null, 2));
  process.exit(0);
}

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
  getDualMarketCompanionAudit,
  getHandicapLineResolution,
  getListHandicapSupplement,
} = require("../src/services/displayRecommendation.ts");
const {
  getPredictionTipDisplay,
} = require("../src/services/bettingDisplay.ts");

const primaryHad = {
  marketType: "1X2",
  oddsPoolCode: "HAD",
  tipCode: "1",
  tipLabel: { zh: "主胜", en: "Home" },
  odds: 1.47,
  trustScore: 51,
  recommendationAction: "reference",
  recommendationTier: "atomic-dual-market-bound-reference",
  explanation: { zh: "", en: "" },
  visibilityStatus: "FREE",
  resultStatus: "PENDING",
};

const match = {
  id: "atomic-display-binding-fixture",
  homeTeamId: "home",
  awayTeamId: "away",
  leagueId: "league",
  countryId: "country",
  homeTeamName: "主队",
  awayTeamName: "客队",
  kickoffTime: "2026-08-01T01:00:00.000+08:00",
  buyEndTime: "2026-07-31T22:00:00.000+08:00",
  status: "SCHEDULED",
  odds: { odds1: 1.53, oddsX: 3.98, odds2: 4.45 },
  oddsSource: "sporttery:HAD",
  oddsPoolCode: "HAD",
  handicapLine: "-1",
  handicapOdds: { odds1: 2.60, oddsX: 3.47, odds2: 2.19 },
  handicapOddsSource: "sporttery:HHAD",
  handicapOddsPoolCode: "HHAD",
  predictions: [primaryHad],
  predictionMeta: {
    dualMarketDecision: {
      version: "dual-market-decision-binding-v1",
      decisionSnapshotVersion: "candidate-decision-snapshot-v2",
      sourceCycleId: "atomic-display-cycle",
      featureSnapshotHash: "c".repeat(64),
      bindingHash: "a".repeat(64),
      publicBindingVersion: "dual-market-public-binding-v1",
      publicBindingHash: "b".repeat(64),
      integrityVerified: true,
      integrityVersion: "dual-market-decision-integrity-v1",
      sourceClocks: {
        capturedAt: "2026-07-31T13:59:00.000Z",
        decisionAt: "2026-07-31T13:59:00.000Z",
        cutoffTime: "2026-07-31T14:00:00.000Z",
        modelGeneratedAt: "2026-07-31T13:55:00.000Z",
        hadObservedAt: "2026-07-31T13:50:00.000Z",
        hadReceivedAt: "2026-07-31T13:51:00.000Z",
        hhadObservedAt: "2026-07-31T13:52:00.000Z",
        hhadReceivedAt: "2026-07-31T13:53:00.000Z",
      },
      strategyVersions: {
        predictionPolicy: "policy-v1",
        prompt: "prompt-v1",
        model: "model-v1",
        calibration: "calibration-v1",
        hhadCompanion: "hhad-companion-shadow-v2",
      },
      hashes: {
        policyHash: "1".repeat(64),
        hadMarketProvenanceHash: "2".repeat(64),
        hhadMarketProvenanceHash: "3".repeat(64),
        strategyHash: "4".repeat(64),
        revisionHash: "5".repeat(64),
        exposureHash: "6".repeat(64),
        pairHash: "7".repeat(64),
      },
      had: {
        poolCode: "HAD",
        code: "1",
        odds: 1.47,
        modelProbability: 0.51,
        marketProbability: 0.58,
      },
      hhad: {
        poolCode: "HHAD",
        code: "2",
        handicapLine: -1,
        odds: 2.25,
        modelProbability: 0.473,
        marketProbability: 0.393,
        recommendationAction: "reference",
      },
    },
  },
};

const companion = getListHandicapSupplement(match, "zh", primaryHad);
const companionAudit = getDualMarketCompanionAudit(match, primaryHad);

assert.equal(companion, null, "an HHAD leg on a different route must stay hidden from the public card");
assert.equal(companionAudit.status, "bound", companionAudit.blockers.join(","));

const mismatchedPrimary = { ...primaryHad, tipCode: "X" };
assert.equal(
  getListHandicapSupplement(match, "zh", mismatchedPrimary),
  null,
  "an attested HHAD leg must not be mixed with a different displayed HAD direction"
);

const wrongLineMatch = JSON.parse(JSON.stringify(match));
wrongLineMatch.predictionMeta.dualMarketDecision.hhad.handicapLine = 1;
assert.equal(
  getListHandicapSupplement(wrongLineMatch, "zh", primaryHad),
  null,
  "an attested HHAD leg must keep the exact official home-team handicap sign"
);

const stalePredictionLineMatch = JSON.parse(JSON.stringify(match));
stalePredictionLineMatch.predictions.push({
  ...primaryHad,
  oddsPoolCode: "HHAD",
  handicapLine: "+1",
  tipCode: "2",
});
const staleLineAudit = getHandicapLineResolution(stalePredictionLineMatch);
assert.equal(staleLineAudit.line, null);
assert.equal(staleLineAudit.reason, "stale-prediction-line-conflict");
assert.equal(
  getListHandicapSupplement(stalePredictionLineMatch, "zh", primaryHad),
  null,
  "a stale stored prediction line must not override or coexist with the current official line"
);

const formalWithoutBinding = JSON.parse(JSON.stringify(match));
delete formalWithoutBinding.predictionMeta.dualMarketDecision;
const formalPrimary = { ...primaryHad, recommendationAction: "recommend" };
assert.equal(
  getListHandicapSupplement(formalWithoutBinding, "zh", formalPrimary),
  null,
  "formal/live recommendation must fail closed instead of model-recomputing an HHAD companion"
);

const referenceLineMatch = JSON.parse(JSON.stringify(formalWithoutBinding));
referenceLineMatch.handicapOddsSource = "external:bookmaker:HHAD";
referenceLineMatch.probabilityModel = {
  handicap: {
    unifiedPosterior: { home: 52, draw: 30, away: 18 },
  },
};
const referenceCompanion = getListHandicapSupplement(referenceLineMatch, "zh", primaryHad);
assert.ok(referenceCompanion, "a non-formal reference lane may use a separately labelled reference line");
assert.equal(referenceCompanion.lineAudit?.official, false);
assert.match(referenceCompanion.meta, /参考让球线/);

const tamperMatrix = [
  ["binding version", (fixture) => { fixture.predictionMeta.dualMarketDecision.version = "tampered"; }],
  ["public hash", (fixture) => { fixture.predictionMeta.dualMarketDecision.publicBindingHash = "bad"; }],
  ["attestation", (fixture) => { fixture.predictionMeta.dualMarketDecision.integrityVerified = false; }],
  ["direction", (fixture) => { fixture.predictionMeta.dualMarketDecision.had.code = "X"; }],
  ["line sign", (fixture) => { fixture.predictionMeta.dualMarketDecision.hhad.handicapLine = 1; }],
  ["market probability", (fixture) => { fixture.predictionMeta.dualMarketDecision.hhad.marketProbability = 2; }],
  ["source clock", (fixture) => {
    fixture.predictionMeta.dualMarketDecision.sourceClocks.hhadReceivedAt = "2026-07-31T14:01:00.000Z";
  }],
  ["strategy version", (fixture) => { fixture.predictionMeta.dualMarketDecision.strategyVersions.model = ""; }],
  ["market provenance", (fixture) => {
    fixture.predictionMeta.dualMarketDecision.hashes.hhadMarketProvenanceHash = "bad";
  }],
];
for (const [label, mutate] of tamperMatrix) {
  const fixture = JSON.parse(JSON.stringify(match));
  mutate(fixture);
  const audit = getDualMarketCompanionAudit(fixture, primaryHad);
  assert.equal(audit.status, "blocked", `${label} tamper must block the companion`);
  assert.equal(getListHandicapSupplement(fixture, "zh", primaryHad), null);
}

let matrixChecks = 0;
for (const handicapLine of [-2, -1, 1, 2]) {
  for (const hadCode of ["1", "X", "2"]) {
    for (const hhadCode of ["1", "X", "2"]) {
      const fixture = JSON.parse(JSON.stringify(match));
      fixture.handicapLine = String(handicapLine > 0 ? `+${handicapLine}` : handicapLine);
      fixture.predictionMeta.dualMarketDecision.had.code = hadCode;
      fixture.predictionMeta.dualMarketDecision.hhad.code = hhadCode;
      fixture.predictionMeta.dualMarketDecision.hhad.handicapLine = handicapLine;
      const primary = { ...primaryHad, tipCode: hadCode };
      const result = getListHandicapSupplement(fixture, "zh", primary);
      if (hadCode === hhadCode) {
        assert.ok(result, `expected same-route ${hadCode}/${hhadCode}/${handicapLine} pair to remain visible`);
        assert.equal(result.tipCode, hhadCode, "the bound HHAD code must never be compatibility-rewritten");
        assert.equal(result.prediction.handicapLine, fixture.handicapLine);
      } else {
        assert.equal(result, null, `different-route ${hadCode}/${hhadCode}/${handicapLine} pair must stay hidden`);
      }
      matrixChecks += 1;
    }
  }
}

for (const [poolCode, code, zh] of [
  ["HAD", "1", "主胜"], ["HAD", "X", "平局"], ["HAD", "2", "客胜"],
  ["HHAD", "1", "让胜"], ["HHAD", "X", "让平"], ["HHAD", "2", "让负"],
]) {
  const label = getPredictionTipDisplay({
    ...primaryHad,
    oddsPoolCode: poolCode,
    handicapLine: poolCode === "HHAD" ? "-1" : "0",
    tipCode: code,
  }, "zh", true);
  assert.equal(label, zh, `${poolCode}:${code} must use its own result-pool semantics`);
  matrixChecks += 1;
}

console.log(JSON.stringify({
  ok: true,
  verifier: "display-recommendation-binding-integrity",
  expected: { had: "1", hhadHiddenForDifferentRoute: true, handicapLine: -1 },
  actual: {
    had: primaryHad.tipCode,
    hhadHidden: companion === null,
    handicapLine: match.handicapLine,
  },
  matrixChecks,
}, null, 2));
