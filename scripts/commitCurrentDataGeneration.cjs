"use strict";

const path = require("node:path");
const {
  cleanupDataGenerations,
  commitCurrentDataGeneration,
} = require("../server/dataGenerationBundle.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(
  process.env.SERVER_STORE_DIR
  || process.env.DATA_STORE_DIR
  || path.join(rootDir, "server-data"),
);
const publicDataDir = path.resolve(
  process.env.DATA_GENERATION_PUBLIC_DATA_DIR
  || process.env.SQLITE_EXPORT_PUBLIC_DATA_DIR
  || path.join(rootDir, "public", "data"),
);

// Cleanup must retain the database's accepted generation even if several raw
// publications are waiting for their PostgreSQL projection. Hold the normal
// shared projection barrier and a generation read lease through deletion.
async function cleanupCommittedDataGenerations(options, sessionOptions = {}) {
  if (!require('../server/storageMode.cjs').readStorageMode().postgresOnly) {
    return cleanupDataGenerations(options);
  }
  const session = await require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({
    ...sessionOptions, storeDir: options.storeDir, publicDataDir: options.publicDataDir, protectReceipt: true });
  try {
    return cleanupDataGenerations({ ...options, protectedGenerationIds: [session.identity.generationId] });
  } finally { await session.close(); }
}

async function main() {
  const result = commitCurrentDataGeneration({
    storeDir,
    publicDataDir,
    sourceCycleId: process.env.DATA_GENERATION_SOURCE_CYCLE_ID || null,
    committedAt: process.env.DATA_GENERATION_COMMITTED_AT || new Date().toISOString(),
  });
  let cleanup;
  try {
    cleanup = await cleanupCommittedDataGenerations({
      storeDir,
      publicDataDir,
      retainCount: Number(process.env.DATA_GENERATION_RETENTION_COUNT || 4),
      graceMs: Number(process.env.DATA_GENERATION_CLEANUP_GRACE_MINUTES || 10) * 60 * 1000,
    });
  } catch (error) {
    // Publication is already durable.  Cleanup must fail closed for deletion,
    // but must not prevent the worker from exporting the committed generation
    // to SQLite and restoring a coherent serving identity.
    cleanup = Object.freeze({
      ok: false,
      skipped: true,
      code: error?.code || null,
      error: error?.message || String(error),
    });
  }
  console.log(JSON.stringify({
    ok: true,
    version: "immutable-base-generation-v1",
    storeDir,
    publicDataDir,
    committed: result.committed,
    idempotent: result.idempotent,
    semanticNoop: result.semanticNoop,
    activeComparison: result.activeComparison || null,
    semanticHash: result.semanticHash,
    requestedSourceCycleId: result.requestedSourceCycleId,
    activeSourceCycleId: result.activeSourceCycleId,
    reusedGeneration: result.reusedGeneration,
    pointer: result.pointer,
    previousPointer: result.previousPointer,
    validation: result.validation,
    cleanup,
    runtime: {
      explicitGc: typeof global.gc === "function",
      maxRssKiB: process.resourceUsage().maxRSS,
    },
  }, null, 2));
}

module.exports = { cleanupCommittedDataGenerations };
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    version: "immutable-base-generation-v1",
    storeDir,
    publicDataDir,
    code: error?.code || null,
    error: error?.message || String(error),
    details: error?.details || null,
  }, null, 2));
  process.exitCode = 1;
});
