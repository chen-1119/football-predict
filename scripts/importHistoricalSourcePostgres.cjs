"use strict";

const {
  createPostgresPool,
  getPostgresHealth,
  runPostgresMigrations,
} = require("../server/postgresStore.cjs");
const { importHistoricalFileToPostgres } = require("./postgresHistoricalSourceStore.cjs");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [key, inline] = token.slice(2).split("=", 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset || !args.file) {
    throw new Error("usage: node scripts/importHistoricalSourcePostgres.cjs --dataset <xgabora|martj42|football-data> --file <csv> [--timezone-offset +08:00] [--batch-size 500] [--max-rejected-ratio 0.005]");
  }
  const pool = createPostgresPool({ applicationName: "football-historical-source-import" });
  try {
    const health = await getPostgresHealth(pool);
    const migrations = await runPostgresMigrations(pool);
    const result = await importHistoricalFileToPostgres({
      pool,
      dataset: args.dataset,
      filePath: args.file,
      timezoneOffset: args["timezone-offset"] || null,
      batchSize: Number(args["batch-size"] || 500),
      maxRejectedRatio: Number(args["max-rejected-ratio"] || 0.005),
      onProgress: ({ acceptedRows, insertedEvents }) => {
        if (acceptedRows % 10_000 === 0) {
          process.stderr.write(`PostgreSQL historical import ${acceptedRows} rows (${insertedEvents} new)\n`);
        }
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, health, migrations, result }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error.code || "HISTORICAL_POSTGRES_IMPORT_FAILED",
    error: error.message || String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
