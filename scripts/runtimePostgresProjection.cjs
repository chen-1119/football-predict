"use strict";
function postgresProjectionSource(env = process.env) {
  const source = String(env.POSTGRES_PROJECTION_SOURCE || "sqlite").trim().toLowerCase();
  if (!["sqlite", "native-generation"].includes(source)) throw new Error("invalid POSTGRES_PROJECTION_SOURCE");
  return source;
}
async function syncRuntimePostgresProjection(options = {}) {
  const source = postgresProjectionSource();
  const writer = require("./postgresProjectionSync.cjs");
  if (source === "sqlite") return writer.syncPostgresProjectionFromSqlite(options);
  if (options.mode === "fast-result") throw new Error("native fast results commit atomically; call the native result publisher, not a projection replay");
  const { createPostgresGenerationSource } = require("./postgresGenerationSource.cjs");
  return writer.syncPostgresProjectionFromSource(createPostgresGenerationSource(options), options);
}
module.exports = { postgresProjectionSource, syncRuntimePostgresProjection };
