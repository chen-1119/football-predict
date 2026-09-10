"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
const { openPostgresRuntimeReadSession } = require("./postgresRuntimeReadSession.cjs");

async function readPostgresWorkerObservation({ phase = null, validationStep, generationStep, sqliteStep,
  projectionStep = sqliteStep, storeDir, publicDataDir, pool } = {}) {
  storeDir = path.resolve(storeDir || process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(__dirname, "../server-data"));
  publicDataDir = path.resolve(publicDataDir || process.env.DATA_GENERATION_PUBLIC_DATA_DIR || path.join(__dirname, "../public/data"));
  const result = { phase, storage: "postgres", observedAt: new Date().toISOString(),
    public: {}, generation: {}, postgres: { readable: false },
    validationReady: validationStep?.ok === true && validationStep?.skipped !== true,
    generationReady: generationStep?.ok === true && generationStep?.skipped !== true,
    projectionReady: projectionStep?.ok === true && projectionStep?.skipped !== true,
    sameSourceCycle: false, samePublicationIdentity: false, publicationIdentityMismatches: [], ready: false, blockers: [] };
  let session;
  try {
    const mutable = JSON.parse(fs.readFileSync(path.join(publicDataDir, "sync-meta.json"), "utf8"));
    session = await openPostgresRuntimeReadSession({ storeDir, publicDataDir, pool });
    // Serving may use the previous immutable pair during a handoff, but worker
    // readiness may only acknowledge the currently active generation.
    const active = resolveActivePublication({ storeDir, publicDataDir });
    result.generation = active.identity;
    result.public = { sourceCycleId: active.identity.sourceCycleId, mutableSourceCycleId: mutable.sourceCycleId || null,
      updatedAt: mutable.updatedAt || null, capturedAt: mutable.capturedAt || null };
    const meta = await session.client.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1", ["sync-meta:current"]);
    const source = meta.rows[0] ? JSON.parse(meta.rows[0].payload) : null;
    result.postgres = { ...session.identity, generationSourceCycleId: session.identity.sourceCycleId,
      sourceCycleId: source?.sourceCycleId || null, readable: true, reason: null };
    const fields = ["generationId", "manifestHash", "sourceCycleId", "committedAt"];
    result.publicationIdentityMismatches = fields.filter(key => !active.identity[key] || active.identity[key] !== session.identity[key]);
    result.samePublicationIdentity = !result.publicationIdentityMismatches.length;
    result.sameSourceCycle = Boolean(source?.sourceCycleId && source.sourceCycleId === active.identity.sourceCycleId);
    result.blockers.push(...result.publicationIdentityMismatches.map(key => `public-postgres-publication-identity-mismatch:${key}`));
    if (!result.sameSourceCycle) result.blockers.push("public-postgres-source-cycle-mismatch");
  } catch {
    // Do not expose connection errors or silently substitute JSON/SQLite.
    result.postgres.reason = "postgres-worker-observation-unavailable";
    result.blockers.push(result.postgres.reason);
  } finally { await session?.close(); }
  if (!result.validationReady) result.blockers.push("post-enrichment-validation-not-ready");
  if (!result.generationReady) result.blockers.push("post-enrichment-generation-not-ready");
  if (!result.projectionReady) result.blockers.push("post-enrichment-postgres-projection-not-ready");
  result.ready = !result.blockers.length;
  return result;
}

async function readPostgresWorkerCounts(options = {}) {
  const session = await openPostgresRuntimeReadSession(options);
  try {
    const result = await session.client.query(`SELECT
      (SELECT count(*) FROM football.odds_snapshots)::text AS odds,
      (SELECT count(*) FROM football.prediction_snapshots)::text AS predictions`);
    const counts = { oddsSnapshots: Number(result.rows[0].odds), predictionSnapshots: Number(result.rows[0].predictions) };
    if (!Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("unsafe warehouse count");
    return { ok: true, storage: "postgres", counts, publicationIdentity: session.identity };
  } finally { await session.close(); }
}
module.exports = { readPostgresWorkerObservation, readPostgresWorkerCounts };
