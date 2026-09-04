"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readPointer, storePaths } = require("../server/dataGenerationStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(
  process.env.SERVER_STORE_DIR
    || process.env.DATA_STORE_DIR
    || path.join(rootDir, "server-data"),
);
const sqlitePath = path.resolve(
  process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"),
);
const identityFields = Object.freeze([
  "generationId",
  "manifestHash",
  "sourceCycleId",
  "committedAt",
]);

const normalized = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

const result = {
  ok: false,
  version: "sqlite-publication-identity-v2-metadata-only",
  storeDir,
  sqlitePath,
  generation: null,
  sqlite: null,
  samePublicationIdentity: false,
  blockers: [],
};

let db = null;
try {
  const sqliteStat = fs.lstatSync(sqlitePath);
  if (!sqliteStat.isFile() || sqliteStat.isSymbolicLink()) {
    throw new Error("candidate SQLite path is not a regular file");
  }

  const pointer = readPointer(storePaths(storeDir).currentPointer);
  result.generation = Object.fromEntries(identityFields.map((field) => [
    field,
    normalized(pointer?.[field]),
  ]));

  db = new DatabaseSync(sqlitePath, { readOnly: true });
  const schemaValue = (key) => normalized(db.prepare(
    "SELECT value FROM schema_meta WHERE key = ?",
  ).get(key)?.value);
  result.sqlite = {
    generationId: schemaValue("data_generation_id"),
    manifestHash: schemaValue("manifest_hash"),
    sourceCycleId: schemaValue("data_generation_source_cycle_id"),
    committedAt: schemaValue("committed_at"),
  };

  const missingGeneration = identityFields.filter((field) => !result.generation[field]);
  const missingSqlite = identityFields.filter((field) => !result.sqlite[field]);
  const mismatches = identityFields.filter((field) => (
    result.generation[field]
      && result.sqlite[field]
      && result.generation[field] !== result.sqlite[field]
  ));
  result.blockers = [
    ...missingGeneration.map((field) => `published-generation-identity-missing:${field}`),
    ...missingSqlite.map((field) => `sqlite-publication-identity-missing:${field}`),
    ...mismatches.map((field) => `public-sqlite-publication-identity-mismatch:${field}`),
  ];
  result.samePublicationIdentity = result.blockers.length === 0;
  result.ok = result.samePublicationIdentity;
} catch (error) {
  result.blockers.push(error?.message || String(error));
} finally {
  try { db?.close(); } catch { /* fail-closed result is already captured */ }
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
