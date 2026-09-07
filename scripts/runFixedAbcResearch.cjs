"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { queryHistoricalEventsAsOf } = require("./historicalTrainingWarehouse.cjs");
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { buildDynamicGoalStrengthArtifact, verifyDynamicGoalStrengthArtifact } = require("./dynamicGoalStrengthModel.cjs");
const { canonicalMarketOdds, devigOdds } = require("./historicalMarketResearch.cjs");
const { freezeProtocol, runFixedAbcResearch } = require("./fixedAbcResearch.cjs");
const root = path.resolve(__dirname, "..");
const warehouse = process.env.HISTORICAL_TRAINING_SQLITE_PATH || path.join(root, "server-data/training/private/historical-training.sqlite");
const output = path.resolve(process.env.FIXED_ABC_OUTPUT_PATH || path.join(root, "outputs/fixed-abc-historical-v1.json"));
const outputRoot = path.join(root, "outputs");
if (!output.startsWith(outputRoot + path.sep)) throw new Error("research output must stay in this workspace outputs directory");
if (fs.existsSync(output)) throw new Error("output already exists; use a distinct replay output path");
const protocol = freezeProtocol();
const query = queryHistoricalEventsAsOf({ dbPath: warehouse, forecastTime: "2100-01-01T00:00:00.000Z", limit: 1000000,
  sourceDataset: protocol.sourceDataset, allowDerivedAvailability: true });
if (query.sourceDataset !== protocol.sourceDataset) throw new Error("source identity differs from committed canonical dataset");
const inventory = query.events.filter(e => e.date >= protocol.dates.start && e.date < protocol.dates.end)
  .sort((a, b) => a.date.localeCompare(b.date) || a.sourceEventId.localeCompare(b.sourceEventId));
// Select on event time only, never on whether the model won or a label value.
// Odds/model missingness is retained for the explicit exclusion ledger below.
const events = inventory.slice(-protocol.maximumEvents);
const dynamic = buildDynamicGoalStrengthArtifact(events);
if (!verifyDynamicGoalStrengthArtifact(dynamic)) throw new Error("as-of model artifact verification failed");
const byId = new Map(events.map(e => [e.sourceEventId, e]));
const labels = new Map(dynamic.featureArtifact.labels.map(l => [l.sourceEventId, l]));
const rows = dynamic.featureArtifact.snapshots.map(s => {
  const event = byId.get(s.sourceEventId), label = labels.get(s.sourceEventId);
  const odds = canonicalMarketOdds(event);
  const home = s.features.home, away = s.features.away;
  const values = [home?.reliability, away?.reliability, home?.restDays, away?.restDays];
  const quality = values.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
    ? Math.min(home.reliability, away.reliability) * Math.exp(-Math.max(home.restDays, away.restDays) / 60) : null;
  return { eventId: s.sourceEventId, sourceDataset: event.sourceDataset, marketFamily: "HAD", league: event.competition || "unknown",
    forecastAt: s.forecastBoundary, availableAt: label.availableAt, featureKnownThrough: s.stateWatermark.maxConsumedAvailableAt,
    trainingRows: s.stateWatermark.consumedRows, quality, market: odds ? devigOdds(odds) : null, model: s.probabilities?.final || null,
    actual: label.outcome, featureHash: s.featureHash, labelHash: label.labelHash };
});
const research = runFixedAbcResearch(rows, protocol);
const implementationFiles = ["fixedAbcResearch.cjs", "runFixedAbcResearch.cjs", "dynamicGoalStrengthModel.cjs", "historicalAsOfFeatureBuilder.cjs", "historicalTrainingWarehouse.cjs", "historicalMarketResearch.cjs", "historicalEventStore.cjs"];
const implementationHashes = Object.fromEntries(implementationFiles.map(name => [name, stableHash(fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\r\n/g, "\n"))]));
const body = { version: "fixed-abc-research-run-v1", source: { dataset: protocol.sourceDataset, warehouseRows: query.rows,
  calendarInventoryRows: inventory.length, selectedEventRows: events.length, omittedOlderCalendarRows: inventory.length - events.length,
  competitions: [...new Set(events.map(e => e.competition || "unknown"))].sort(), inputArtifactHash: dynamic.featureArtifact.input.rootHash,
  dynamicArtifactHash: dynamic.artifactHash, dynamicModelHash: dynamic.model.modelHash }, implementationHashes, research };
const result = { ...body, manifestHash: stableHash(body) };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ok: true, output, manifestHash: result.manifestHash, source: result.source,
  partitions: research.partition, exclusions: research.coverage.reasons, fitted: { residualWeight: research.fitted.residualWeight, temperatures: research.fitted.temperatures },
  results: Object.fromEntries(Object.entries(research.reports).map(([k, r]) => [k, { rows: r.allPaired.rows, hits: r.allPaired.hits, accuracy: r.allPaired.accuracy,
    decided: r.allPaired.decided, abstainedTies: r.allPaired.abstainedTies, directionCoverage: r.allPaired.directionCoverage,
    commonDirectionRows: r.commonDecisions.rows, commonDirectionHits: r.commonDecisions.hits, commonDirectionAccuracy: r.commonDecisions.accuracy,
    brier: r.allPaired.brier, logLoss: r.allPaired.logLoss, selectedRows: r.fixedFilter.rows, coverage: r.fixedFilter.coverage }])), conclusion: research.conclusion }, null, 2));
