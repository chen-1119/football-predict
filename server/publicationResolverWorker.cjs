"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  acquireGenerationReadLease,
  resolveServingPublication,
  resolveServingPublicationForSqliteIdentity,
} = require("./dataGenerationBundle.cjs");
const { readSqlitePublicationIdentity } = require("./sqliteStore.cjs");
const {
  createPostgresPool,
  postgresEnabled,
} = require("./postgresStore.cjs");
const {
  readPostgresPublicationIdentity,
} = require("./postgresProjectionStore.cjs");

let lease = null;

const resolvePrimaryPairedPublication = async () => {
  if (workerData.requirePostgresPair) {
    if (!postgresEnabled()) {
      const error = new Error("PostgreSQL publication identity is unavailable");
      error.code = "POSTGRES_PUBLICATION_IDENTITY_UNAVAILABLE";
      throw error;
    }
    const pool = createPostgresPool({
      max: 1,
      min: 0,
      applicationName: "football-publication-resolver",
    });
    try {
      const postgres = await readPostgresPublicationIdentity(pool);
      if (postgres?.available !== true) {
        const error = new Error(postgres?.reason || "PostgreSQL publication identity is unavailable");
        error.code = "POSTGRES_PUBLICATION_IDENTITY_UNAVAILABLE";
        throw error;
      }
      // The pairing helper compares immutable publication identities. It is
      // intentionally storage-agnostic even though its historical name says
      // SQLite; using the PostgreSQL identity here keeps the application on
      // the previous complete generation until the production primary read
      // projection has committed the same generation.
      return resolveServingPublicationForSqliteIdentity({
        storeDir: workerData.storeDir,
        publicDataDir: workerData.publicDataDir,
        sqliteIdentity: postgres.publication,
        allowPrevious: true,
      });
    } finally {
      await pool.end();
    }
  }

  const sqlite = workerData.requireSqlitePair
    ? readSqlitePublicationIdentity(workerData.sqliteDbPath)
    : null;
  if (workerData.requireSqlitePair && sqlite?.available !== true) {
    const error = new Error(sqlite?.reason || "SQLite publication identity is unavailable");
    error.code = "SQLITE_PUBLICATION_IDENTITY_UNAVAILABLE";
    throw error;
  }
  return workerData.requireSqlitePair
    ? resolveServingPublicationForSqliteIdentity({
        storeDir: workerData.storeDir,
        publicDataDir: workerData.publicDataDir,
        sqliteIdentity: sqlite.publication,
        allowPrevious: true,
      })
    : resolveServingPublication({
        storeDir: workerData.storeDir,
        publicDataDir: workerData.publicDataDir,
        allowPrevious: true,
      });
};

const main = async () => {
  const publication = await resolvePrimaryPairedPublication();
  lease = publication.context
    ? acquireGenerationReadLease({
        storeDir: workerData.storeDir,
        generationId: publication.context.generationId,
        context: publication.context,
        owner: `football-server:${workerData.ownerPid}:publication-worker`,
      })
    : null;
  parentPort.postMessage({
    ok: true,
    publication,
    lease: lease ? {
      version: lease.version,
      leaseId: lease.leaseId,
      generationId: lease.generationId,
      owner: lease.owner,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      path: lease.path,
    } : null,
  });
};

main().catch((error) => {
  try { lease?.release?.(); } catch { /* best-effort worker cleanup */ }
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code || null,
      message: error?.message || String(error),
    },
  });
});
