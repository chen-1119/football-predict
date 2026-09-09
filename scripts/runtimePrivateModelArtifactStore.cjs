"use strict";
// Fail closed on unknown selectors and PostgreSQL errors. No automatic SQLite
// fallback is allowed after the native audit backend is selected.
const HHAD_COMPANION_AUDIT_KEY = "hhad-companion-audit";
function privateArtifactStorage(value = process.env.PRIVATE_MODEL_ARTIFACT_STORAGE || "sqlite") {
  if (!["sqlite", "postgres"].includes(value)) throw new Error("invalid PRIVATE_MODEL_ARTIFACT_STORAGE");
  return value;
}
function backend(options) {
  return privateArtifactStorage(options.storage) === "postgres"
    ? require("./postgresPrivateModelArtifactStore.cjs") : require("./privateModelArtifactStore.cjs");
}
async function readPrivateModelArtifact(options) { return backend(options).readPrivateModelArtifact(options); }
async function writePrivateModelArtifact(options) { return backend(options).writePrivateModelArtifact(options); }
module.exports = { HHAD_COMPANION_AUDIT_KEY, privateArtifactStorage, readPrivateModelArtifact, writePrivateModelArtifact };
