"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  queryHistoricalEventsAsOf,
} = require("./historicalTrainingWarehouse.cjs");
const {
  buildHistoricalMarketResearch,
  canonicalMarketOdds,
  verifyHistoricalMarketResearch,
} = require("./historicalMarketResearch.cjs");

const rootDir = path.resolve(__dirname, "..");
const serverStoreDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const warehouseFile = path.resolve(
  process.env.HISTORICAL_MARKET_RESEARCH_WAREHOUSE_FILE
    || path.join(serverStoreDir, "training", "private", "historical-training.sqlite"),
);
const outputFile = path.resolve(
  process.env.HISTORICAL_MARKET_RESEARCH_OUTPUT_FILE
    || path.join(serverStoreDir, "model-artifacts", "historical-market-research.json"),
);
const sourceDataset = process.env.HISTORICAL_MARKET_RESEARCH_SOURCE_DATASET || "xgabora";

const positiveInteger = (value, fallback, minimum = 1, maximum = 1_000_000) => {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
};

const maxEvents = positiveInteger(process.env.HISTORICAL_MARKET_RESEARCH_MAX_EVENTS, 20_000, 1_000);
const minimumTrainingRows = positiveInteger(process.env.HISTORICAL_MARKET_RESEARCH_MIN_TRAINING_ROWS, 5_000, 100);
const holdoutRows = positiveInteger(process.env.HISTORICAL_MARKET_RESEARCH_HOLDOUT_ROWS, 2_000, 50);
const minimumFolds = positiveInteger(process.env.HISTORICAL_MARKET_RESEARCH_MIN_FOLDS, 6, 2, 100);
const minimumModelTrainingRows = positiveInteger(
  process.env.HISTORICAL_MARKET_RESEARCH_MIN_MODEL_TRAINING_ROWS,
  80,
  1,
);

const writeJsonAtomic = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
};

const main = () => {
  if (!fs.existsSync(warehouseFile)) throw new Error(`historical warehouse not found: ${warehouseFile}`);
  const query = queryHistoricalEventsAsOf({
    dbPath: warehouseFile,
    forecastTime: "2100-01-01T00:00:00.000Z",
    limit: 1_000_000,
    sourceDataset,
    allowDerivedAvailability: true,
  });
  const fullOddsRows = query.events.filter((event) => canonicalMarketOdds(event));
  const events = fullOddsRows.slice(-maxEvents);
  if (events.length < minimumTrainingRows + minimumFolds * holdoutRows) {
    throw new Error(
      `not enough full-odds rows for research walk-forward: ${events.length}`
        + ` < ${minimumTrainingRows + minimumFolds * holdoutRows}`,
    );
  }
  const artifact = buildHistoricalMarketResearch(events, {
    minimumTrainingRows,
    holdoutRows,
    minimumFolds,
    minimumModelTrainingRows,
  });
  if (!verifyHistoricalMarketResearch(artifact)) {
    throw new Error("historical market research artifact failed self-verification");
  }
  writeJsonAtomic(outputFile, artifact);
  console.log(JSON.stringify({
    ok: true,
    version: artifact.version,
    status: artifact.status,
    outputFile,
    warehouseFile,
    sourceDataset: artifact.source.dataset,
    warehouseRows: query.rows,
    fullOddsRows: fullOddsRows.length,
    selectedRows: events.length,
    // source.evaluatedRows is the legacy model-ready pool, not the scored
    // holdout denominator (warmup, delayed labels and tail windows differ).
    modelReadyRows: artifact.source.evaluatedRows,
    evaluatedRows: artifact.walkForward.aggregate.market.rows,
    coverage: artifact.walkForward.coverage,
    folds: artifact.walkForward.folds.length,
    aggregate: artifact.walkForward.aggregate,
    evidenceBoundary: artifact.evidenceBoundary,
    manifestHash: artifact.manifestHash,
  }, null, 2));
};

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
