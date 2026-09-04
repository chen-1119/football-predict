"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  applyFixtureMappingEvidence,
  loadEntityRegistry,
  validateEntityRegistry,
  writeEntityRegistryAtomic,
} = require("./entityResolutionRegistry.cjs");

const rootDir = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.ENTITY_RESOLUTION_DATA_DIR || path.join(rootDir, "public", "data"));
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const cacheFile = path.resolve(process.env.ENTITY_RESOLUTION_CACHE_FILE || path.join(dataDir, "api-football-cache.json"));
const registryFile = path.resolve(
  process.env.ENTITY_RESOLUTION_REGISTRY_FILE
    || path.join(storeDir, "entity-resolution", "team-registry.json"),
);

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const rowsFrom = (value) => Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : [];
const validIso = (value) => Number.isFinite(Date.parse(String(value || "")));

const matches = ["matches-current.json", "matches-history.json"]
  .flatMap((name) => rowsFrom(readJson(path.join(dataDir, name), [])));
const matchesByKey = new Map();
for (const match of matches) {
  for (const key of [match?.id, match?.sourceMatchId, match?.sourceMatchId ? `sporttery_${match.sourceMatchId}` : null]) {
    if (key) matchesByKey.set(String(key), match);
  }
}

const cache = readJson(cacheFile, {});
const mappings = Object.values(cache.fixtureMap || {})
  .filter((mapping) => mapping && typeof mapping === "object")
  .sort((left, right) => String(left.matchedAt || "").localeCompare(String(right.matchedAt || "")));
const earliestEvidenceAt = mappings.map((mapping) => mapping.matchedAt).filter(validIso).sort()[0]
  || new Date().toISOString();
const registryFileExisted = fs.existsSync(registryFile);
let registry = loadEntityRegistry(registryFile, { createdAt: earliestEvidenceAt });
const expectedRegistryHash = registryFileExisted ? registry.registryHash : null;
let changedRows = 0;
let skippedRows = 0;
let unmatchedRows = 0;
let conflictsAdded = 0;
const blockerCounts = {};

for (const mapping of mappings) {
  const match = matchesByKey.get(String(mapping.sportteryMatchId || ""))
    || matchesByKey.get(String(mapping.sourceMatchId || ""));
  if (!match) {
    unmatchedRows += 1;
    continue;
  }
  const result = applyFixtureMappingEvidence({
    registry,
    match,
    mapping,
    observedAt: validIso(mapping.matchedAt) ? mapping.matchedAt : new Date().toISOString(),
  });
  if (result.changed) {
    registry = result.registry;
    changedRows += 1;
    conflictsAdded += result.conflictsAdded;
  } else {
    skippedRows += 1;
  }
  for (const blocker of result.blockers || []) blockerCounts[blocker] = Number(blockerCounts[blocker] || 0) + 1;
}

const validation = validateEntityRegistry(registry);
if (!validation.valid) throw new Error(`entity registry validation failed: ${validation.errors.join(", ")}`);
if (changedRows || !fs.existsSync(registryFile)) {
  writeEntityRegistryAtomic(registryFile, registry, { expectedRegistryHash });
}

const providerMappings = Object.values(registry.entities || {}).filter((entity) => (
  entity?.providers?.["api-football"]?.status === "verified"
)).length;
console.log(JSON.stringify({
  ok: true,
  registryFile,
  cacheFile,
  inputMappings: mappings.length,
  matchedRows: mappings.length - unmatchedRows,
  changedRows,
  skippedRows,
  unmatchedRows,
  conflictsAdded,
  blockerCounts,
  localEntities: Object.keys(registry.entities || {}).length,
  verifiedProviderMappings: providerMappings,
  totalConflicts: registry.conflicts.length,
  registryHash: registry.registryHash,
}, null, 2));
