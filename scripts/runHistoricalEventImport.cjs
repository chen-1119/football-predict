"use strict";

const path = require("node:path");
const { iterateHistoricalEvents } = require("./historicalEventStore.cjs");
const {
  encodeEventPayload,
  historicalWarehouseStatus,
  importHistoricalCsvToWarehouse,
  queryHistoricalEventsAsOf,
} = require("./historicalTrainingWarehouse.cjs");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [rawKey, inline] = token.slice(2).split("=", 2);
    if (["inspect-only", "allow-rejected", "allow-derived-availability"].includes(rawKey)) {
      args[rawKey] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${rawKey}`);
    args[rawKey] = value;
  }
  return args;
}

async function inspectSource({ dataset, filePath, maxEvents, timezoneOffset = null }) {
  const rejectedByReason = {};
  const rejectedSamples = [];
  const iterator = iterateHistoricalEvents({
    dataset,
    filePath,
    timezoneOffset,
    onRejected: (row) => {
      rejectedByReason[row.reason] = Number(rejectedByReason[row.reason] || 0) + 1;
      if (rejectedSamples.length < 5) rejectedSamples.push(row);
    },
  });
  let rows = 0;
  let first = null;
  let last = null;
  let manifest = null;
  let complete = true;
  let rawEventJsonBytes = 0;
  let compressedEventBytes = 0;
  while (true) {
    const step = await iterator.next();
    if (step.done) {
      manifest = step.value;
      break;
    }
    rows += 1;
    const encoded = encodeEventPayload(step.value);
    rawEventJsonBytes += encoded.eventJsonBytes;
    compressedEventBytes += encoded.eventPayloadBytes;
    first ||= step.value.date;
    last = step.value.date;
    if (maxEvents && rows >= maxEvents) {
      complete = false;
      await iterator.return();
      break;
    }
  }
  return {
    ok: true,
    mode: "inspect-only",
    wroteDatabase: false,
    sourceFile: path.resolve(filePath),
    dataset,
    rowsRead: rows,
    firstDateSeen: first,
    lastDateSeen: last,
    complete,
    manifest,
    rejectedByReason,
    rejectedSamples,
    storageEstimate: {
      encoding: "deflate-raw-json-v1",
      rawEventJsonBytes,
      compressedEventBytes,
      payloadCompressionRatio: rawEventJsonBytes > 0 ? compressedEventBytes / rawEventJsonBytes : null,
      payloadBytesSaved: rawEventJsonBytes - compressedEventBytes,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset;
  const filePath = args.file;
  if (!dataset || !filePath) {
    throw new Error("usage: node scripts/runHistoricalEventImport.cjs --dataset xgabora --file <csv> [--db <sqlite>] [--inspect-only] [--max-events N] [--timezone-offset +08:00] [--result-delay-ms N] [--forecast-time ISO --allow-derived-availability]");
  }

  if (args["inspect-only"]) {
    const result = await inspectSource({
      dataset,
      filePath,
      maxEvents: args["max-events"] ? Math.max(1, Number(args["max-events"])) : null,
      timezoneOffset: args["timezone-offset"] || null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const dbPath = path.resolve(args.db || "server-data/training/private/historical-training.sqlite");
  const result = await importHistoricalCsvToWarehouse({
    dbPath,
    dataset,
    filePath,
    createdAt: args["created-at"],
    completedAt: args["completed-at"],
    timezoneOffset: args["timezone-offset"],
    resultDelayMs: args["result-delay-ms"],
    batchSize: args["batch-size"],
    allowRejectedRows: args["allow-rejected"] === true,
    onProgress: ({ stagedRows }) => {
      if (stagedRows % 10000 === 0) process.stderr.write(`historical import staged ${stagedRows} events\n`);
    },
  });
  const output = { ...result, status: historicalWarehouseStatus(dbPath) };
  if (args["forecast-time"]) {
    const asOf = queryHistoricalEventsAsOf({
      dbPath,
      forecastTime: new Date(args["forecast-time"]).toISOString(),
      limit: args.limit,
      allowDerivedAvailability: args["allow-derived-availability"] === true,
    });
    output.asOf = {
      forecastTime: asOf.forecastTime,
      queryPolicy: asOf.queryPolicy,
      rows: asOf.rows,
      integrity: asOf.integrity,
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error.code || "HISTORICAL_IMPORT_FAILED",
    message: error.message,
    importId: error.importId || null,
    conflicts: error.conflicts ?? null,
    rejectedRows: error.rejectedRows ?? null,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
