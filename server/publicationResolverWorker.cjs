"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  acquireGenerationReadLease,
  resolveServingPublication,
  resolveServingPublicationForSqliteIdentity,
} = require("./dataGenerationBundle.cjs");
const { readSqlitePublicationIdentity } = require("./sqliteStore.cjs");

let lease = null;

try {
  const sqlite = workerData.requireSqlitePair
    ? readSqlitePublicationIdentity(workerData.sqliteDbPath)
    : null;
  if (workerData.requireSqlitePair && sqlite?.available !== true) {
    const error = new Error(sqlite?.reason || "SQLite publication identity is unavailable");
    error.code = "SQLITE_PUBLICATION_IDENTITY_UNAVAILABLE";
    throw error;
  }
  const publication = workerData.requireSqlitePair
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
} catch (error) {
  try { lease?.release?.(); } catch { /* best-effort worker cleanup */ }
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code || null,
      message: error?.message || String(error),
    },
  });
}
