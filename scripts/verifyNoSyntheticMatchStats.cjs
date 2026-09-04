const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const rootDir = path.resolve(__dirname, "..");
const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8");
const readJson = (relativePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
  } catch {
    return fallback;
  }
};

const syncSource = readText("scripts/syncData.cjs");
const preMatchSource = readText("scripts/syncPreMatchSignals.cjs");

for (const forbidden of [
  "const possessionHome = 48 + Math.floor(rand() * 12)",
  "possession: { home: possessionHome",
  "shots: { home: Math.floor(model.homeLambda",
  "shotsOnTarget: { home: Math.floor(model.homeLambda",
  "corners: { home: 3 + Math.floor(rand() * 5)",
  "offsides: { home: Math.floor(rand() * 4)",
  "-independent-lambda`);",
  "-model-only`);",
  "-model-only-goals`);",
]) {
  assert.equal(syncSource.includes(forbidden), false, `synthetic match statistic generator remains: ${forbidden}`);
}
assert.ok(syncSource.includes('sourceType: "model-estimate"'), "model estimates must carry explicit provenance");
assert.ok(syncSource.includes('source: "derived-model-not-observed-match-statistics"'), "derived estimates must not be labelled as observed stats");
assert.ok(preMatchSource.includes("observedPostMatchStats"), "pre-match history builder lacks an observed-statistics gate");
assert.ok(preMatchSource.includes("if (!observedPostMatchStats(stats)) continue"), "unverified statistics can still feed the pre-match layer");

const selfTestOnly = process.argv.includes("--self-test");
const current = selfTestOnly ? [] : readJson("public/data/matches-current.json", []);
const forbiddenFactKeys = ["possession", "shots", "shotsOnTarget", "corners", "offsides", "fouls", "yellowCards", "redCards", "xG"];
for (const match of current) {
  const stats = match?.stats;
  if (!stats) continue;
  const observed = stats.observed === true
    || stats.provenance?.observed === true
    || ["observed", "official-post-match", "provider-post-match"].includes(String(stats.sourceType || "").toLowerCase());
  if (!observed) {
    for (const key of forbiddenFactKeys) {
      assert.equal(stats[key], undefined, `${match.id || match.sourceMatchId}: generated stats.${key} must not be published as a match fact`);
    }
    assert.equal(stats.sourceType, "model-estimate");
    assert.ok(stats.generatedAt, `${match.id || match.sourceMatchId}: model estimate timestamp missing`);
  }
}

console.log(JSON.stringify({
  ok: true,
  checkedCurrentMatches: current.length,
  policy: "observed-post-match-only; model-estimates-explicit; no-seeded-match-facts",
}, null, 2));
