"use strict";
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { buildDynamicGoalStrengthAblationArtifact, verifyDynamicGoalStrengthArtifact } = require("./dynamicGoalStrengthModel.cjs");
const { partitionRows, score, direction, validProbabilities } = require("./fixedAbcResearch.cjs");
const KNOCKOUTS = Object.freeze(["without-recency", "without-venue", "without-opponent-strength"]);
function runFixedAbcAblations(events, baseRows, protocol) {
  const split = partitionRows(baseRows, protocol), test = split.segments.test;
  if (test.length < protocol.minimumFitRows) throw new Error("insufficient fixed ablation test support");
  const variants = new Map([["full-model", new Map(test.map(r => [r.eventId, r.model]))]]);
  const source = {};
  for (const name of KNOCKOUTS) {
    const artifact = buildDynamicGoalStrengthAblationArtifact(events, name);
    if (!verifyDynamicGoalStrengthArtifact(artifact)) throw new Error(`invalid ablation artifact: ${name}`);
    const snapshots = new Map(artifact.featureArtifact.snapshots.map(s => [s.sourceEventId, s]));
    const paired = new Map();
    for (const row of test) {
      const s = snapshots.get(row.eventId);
      if (!s || s.forecastBoundary !== row.forecastAt || s.stateWatermark.maxConsumedAvailableAt !== row.featureKnownThrough
          || !validProbabilities(s.probabilities?.final)) throw new Error(`ablation identity, time or probability mismatch: ${name}`);
      paired.set(row.eventId, s.probabilities.final);
    }
    variants.set(name, paired);
    source[name] = { artifactHash: artifact.artifactHash, configHash: artifact.model.configHash, modelHash: artifact.model.modelHash,
      inputHash: artifact.featureArtifact.input.rootHash, testFeatureHashes: stableHash(test.map(r => snapshots.get(r.eventId).featureHash)) };
  }
  const common = test.filter(r => direction(r.market) !== null && [...variants.values()].every(map => direction(map.get(r.eventId)) !== null));
  const full = score(test, r => r.model);
  const reports = Object.fromEntries([...variants].map(([name, map]) => {
    const all = score(test, r => map.get(r.eventId));
    return [name, { allPaired: all, commonDecisions: score(common, r => map.get(r.eventId)),
      lossIncreaseVersusFull: { brier: Number((all.brier - full.brier).toFixed(10)), logLoss: Number((all.logLoss - full.logLoss).toFixed(10)) } }];
  }));
  const body = { version: "fixed-abc-ablation-research-v1", researchOnly: true, productionEligible: false, nominationAllowed: false,
    protocolHash: protocol.protocolHash, knockouts: KNOCKOUTS,
    method: "one fixed component group removed at a time; full as-of state replay; no retuning or recalibration; raw probabilities on full-model eligible test identities",
    definitions: { "without-recency": "remove exponential elapsed-time decay from team latent strength, Elo and competition rates; retain chronological online updates, reliability shrinkage and regularization",
      "without-venue": "use neutral average goal base and zero Elo home advantage in predictions and online residual updates",
      "without-opponent-strength": "remove opponent defense from goal-rate predictions and relative Elo ratings from the Elo channel; keep each team's own attack and venue base; replay updates under this knockout" },
    rows: test.length, commonDirectionRows: common.length, testEventIdsHash: stableHash(test.map(r => r.eventId)), commonEventIdsHash: stableHash(common.map(r => r.eventId)),
    exclusions: split.excluded, source, reports, sameRowsMarket: { allPaired: score(test, r => r.market), commonDecisions: score(common, r => r.market) },
    caveat: "point-estimate component-group sensitivity, not causal attribution, no ablation winner selected, no significance claim; historical source clock proof still missing" };
  return { ...body, manifestHash: stableHash(body) };
}
module.exports = { KNOCKOUTS, runFixedAbcAblations };
