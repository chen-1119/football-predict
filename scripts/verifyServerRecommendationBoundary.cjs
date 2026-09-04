const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isOfficialRecommendationEligible,
  isServerOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");

const readSource = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

const prediction = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  handicapLine: "0",
  tipCode: "1",
  recommendationAction: "recommend",
  recommendationTier: "multi-factor-a",
  multiFactorEvidence: {
    version: "multi-factor-market-evidence-v2",
    eligible: true,
    market: "HAD",
    code: "1",
    handicapLine: "0",
    odds: 2.35,
    blockers: [],
  },
};

assert.equal(isOfficialRecommendationEligible(prediction, 2.35, 0), true);
assert.equal(isServerOfficialRecommendationEligible(prediction, 2.35, {
  officialSource: true,
  globalRiskTier: "stable",
  officialHandicapLine: 0,
}), true);

const hhadPrediction = {
  ...prediction,
  oddsPoolCode: "HHAD",
  handicapLine: "-1",
  multiFactorEvidence: {
    ...prediction.multiFactorEvidence,
    market: "HHAD",
    handicapLine: "-1",
  },
};
assert.equal(isOfficialRecommendationEligible(hhadPrediction, 2.35, "-1"), true);
assert.equal(
  isOfficialRecommendationEligible(hhadPrediction, 2.35, "-2"),
  false,
  "old -1 evidence must be rejected when the current official line is -2 even if SP is unchanged",
);
assert.equal(isServerOfficialRecommendationEligible(hhadPrediction, 2.35, {
  officialSource: true,
  globalRiskTier: "stable",
  officialHandicapLine: "-2",
}), false, "server boundary must reject stale HHAD line evidence");
assert.equal(isOfficialRecommendationEligible({
  ...hhadPrediction,
  multiFactorEvidence: {
    ...hhadPrediction.multiFactorEvidence,
    handicapLine: undefined,
  },
}, 2.35, "-1"), false, "HHAD evidence without an auditable line must fail closed");
assert.equal(isOfficialRecommendationEligible(prediction, 2.35, "-1"), false, "HAD must remain a zero-line market");

const cjsPolicySource = readSource("src/services/officialRecommendationEligibility.cjs");
const tsPolicySource = readSource("src/services/officialRecommendationEligibility.ts");
for (const sharedPolicyFragment of [
  "const recommendationLinesMatch",
  "predictionLine === 0 && evidenceLine === 0 && officialLine === 0",
  "predictionLine === evidenceLine",
  "evidenceLine === officialLine",
  "recommendationLinesMatch(prediction, evidence, currentOfficialHandicapLine)",
]) {
  assert.equal(cjsPolicySource.includes(sharedPolicyFragment), true, `CJS policy is missing: ${sharedPolicyFragment}`);
  assert.equal(tsPolicySource.includes(sharedPolicyFragment), true, `TS policy is missing: ${sharedPolicyFragment}`);
}

try {
  const typescript = require("typescript");
  const compiledTsPolicy = typescript.transpileModule(tsPolicySource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const tsPolicyModule = { exports: {} };
  Function("require", "module", "exports", compiledTsPolicy)(require, tsPolicyModule, tsPolicyModule.exports);
  const tsEligibility = tsPolicyModule.exports.isOfficialRecommendationEligible;
  for (const fixture of [
    { candidate: prediction, odds: 2.35, line: 0 },
    { candidate: hhadPrediction, odds: 2.35, line: "-1" },
    { candidate: hhadPrediction, odds: 2.35, line: "-2" },
    { candidate: prediction, odds: 2.35, line: "-1" },
    {
      candidate: {
        ...hhadPrediction,
        multiFactorEvidence: { ...hhadPrediction.multiFactorEvidence, handicapLine: undefined },
      },
      odds: 2.35,
      line: "-1",
    },
  ]) {
    assert.equal(
      tsEligibility(fixture.candidate, fixture.odds, fixture.line),
      isOfficialRecommendationEligible(fixture.candidate, fixture.odds, fixture.line),
      "TS and CJS canonical gates must return the same result",
    );
  }
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

const browserImports = [
  ["src/services/displayRecommendation.ts", "./officialRecommendationEligibility"],
  ["src/services/generator.ts", "./officialRecommendationEligibility"],
  ["src/pages/BestTips.tsx", "../services/officialRecommendationEligibility"],
  ["src/pages/PredictionsList.tsx", "../services/officialRecommendationEligibility"],
];
for (const [relativePath, importPath] of browserImports) {
  const source = readSource(relativePath);
  assert.equal(
    source.includes(`from '${importPath}'`) || source.includes(`from "${importPath}"`),
    true,
    `${relativePath} must resolve the browser TS policy through an extensionless import`,
  );
  assert.equal(source.includes("officialRecommendationEligibility.cjs"), false, `${relativePath} must not import CJS`);
}
assert.equal(tsPolicySource.includes(".cjs"), false, "browser TS policy must not import its CJS sibling");
const browserSourceFiles = [];
const collectBrowserSources = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectBrowserSources(absolute);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) browserSourceFiles.push(absolute);
  }
};
collectBrowserSources(path.join(__dirname, "..", "src"));
assert.deepEqual(
  browserSourceFiles
    .filter((file) => fs.readFileSync(file, "utf8").includes("officialRecommendationEligibility.cjs"))
    .map((file) => path.relative(path.join(__dirname, ".."), file)),
  [],
  "no browser source may import the CJS canonical module",
);

assert.equal(isServerOfficialRecommendationEligible({
  ...prediction,
  recommendationAction: undefined,
}, 2.35, {
  officialSource: true,
  globalRiskTier: "stable",
  officialHandicapLine: 0,
}), false, "missing BEST action must fail closed");

assert.equal(isServerOfficialRecommendationEligible(prediction, 2.35, {
  officialSource: false,
  globalRiskTier: "stable",
  officialHandicapLine: 0,
}), false, "unverified odds source must fail closed");

for (const globalRiskTier of [undefined, "", "unknown", "watch", "degraded"]) {
  assert.equal(isServerOfficialRecommendationEligible(prediction, 2.35, {
    officialSource: true,
    globalRiskTier,
    officialHandicapLine: 0,
  }), false, `risk tier ${globalRiskTier || "missing"} must fail closed`);
}

const serverSource = readSource("server/index.cjs");
const liveEligibilitySource = readSource("src/services/liveRecommendationEligibility.cjs");
assert.match(serverSource, /require\("\.\.\/src\/services\/officialRecommendationEligibility\.cjs"\)/);
assert.match(serverSource, /hasOfficialSportterySourceForLivePrediction/);
assert.match(liveEligibilitySource, /source === `sporttery:\$\{pool\}`/);
assert.match(liveEligibilitySource, /url\.hostname\.toLowerCase\(\) === 'webapi\.sporttery\.cn'/);
assert.match(serverSource, /normalizeMatchForDetailPayload\(enforceCurrentMatchRecommendationEvidence\(match, globalRiskTier\)\)/);
assert.match(
  serverSource,
  /const dualMarketDecision = compactVerifiedDualMarketDecision\(\s*attestDualMarketDecisionBinding\(match\)\s*\);/,
  "detail payload must retain the same verified public dual-market binding used by the list payload",
);
assert.match(serverSource, /const enforceCurrentRecommendationEvidence = \(match, prediction, globalRiskTier = "unknown"\)/);
assert.match(serverSource, /if \(prediction\.marketType !== "BEST"\) return prediction;/);
assert.match(
  serverSource,
  /if \(String\(prediction\.tipCode \|\| ""\)\.toUpperCase\(\) === "WATCH"\)[\s\S]*?multiFactorEvidence:[\s\S]*?eligible: false,[\s\S]*?grade: "WATCH"/,
  "public WATCH rows must carry an explicit ineligible WATCH evidence envelope",
);
assert.match(serverSource, /if \(prediction\.recommendationAction === "reference"\) return liveEnrichedPrediction;/);
assert.match(serverSource, /isServerLiveRecommendationEligible/);
assert.match(serverSource, /isLiveRecommendationWindowOpen\(match, nowMs\)/);
assert.match(serverSource, /officialOddsFreshnessForLivePrediction\(match, prediction, nowMs\)/);
assert.match(serverSource, /official-sp-clock-missing-or-stale/);
assert.match(serverSource, /const officialHandicapLine = prediction\.oddsPoolCode === "HHAD" \? match\.handicapLine : 0/);
assert.match(serverSource, /handicapLine: evidence\.handicapLine/);
assert.match(serverSource, /const recommendationCoverageOfficialMarketAvailable = \(match, poolCode\)/);
assert.match(serverSource, /match\?\.oddsSource === "sporttery:HAD"/);
assert.match(serverSource, /match\?\.handicapOddsSource === "sporttery:HHAD"/);
assert.match(
  serverSource,
  /const hhadMarketAvailable = recommendationCoverageOfficialMarketAvailable\(match, "HHAD"\)/,
  "supplemental HHAD quotes must not masquerade as official atomic-market coverage",
);
assert.match(
  serverSource,
  /const hadMarketAvailable = recommendationCoverageOfficialMarketAvailable\(match, "HAD"\)/,
  "supplemental HAD quotes must not masquerade as official atomic-market coverage",
);

console.log("server-recommendation-boundary-ok");
