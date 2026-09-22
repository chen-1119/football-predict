"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fixtureTeamCategoryAudit } = require("./teamCategoryIdentity.cjs");

const VERSION = "entity-resolution-registry-v1";
const DEFAULT_PROVIDER = "api-football";
const MIN_FIXTURE_CONFIDENCE = 0.9;
const MIN_TEAM_SCORE = 0.86;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class EntityResolutionError extends Error {
  constructor(message, code = "ENTITY_RESOLUTION_ERROR") {
    super(message);
    this.name = "EntityResolutionError";
    this.code = code;
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
const stableStringify = (value) => JSON.stringify(stableValue(value));
const normalizeName = (value) => compact(value)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(fc|cf|sc|afc|club|football|soccer|team|national|women|men|u23|u21|u20|u19)\b/g, " ")
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const canonicalIso = (value, field) => {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new EntityResolutionError(`${field} must be a valid timestamp`, "INVALID_TIMESTAMP");
  return new Date(parsed).toISOString();
};

const uniqSorted = (values) => Array.from(new Set(values.map(compact).filter(Boolean))).sort();

const registryBody = (registry) => {
  const { registryHash: _registryHash, ...body } = registry || {};
  return stableValue(body);
};

const finalizeRegistry = (body) => {
  const normalized = registryBody(body);
  return {
    ...normalized,
    registryHash: sha256(stableStringify(normalized)),
  };
};

const createEntityRegistry = ({ createdAt = new Date().toISOString() } = {}) => {
  const at = canonicalIso(createdAt, "createdAt");
  return finalizeRegistry({
    version: VERSION,
    createdAt: at,
    updatedAt: at,
    entities: {},
    conflicts: [],
  });
};

const validateEntityRegistry = (registry) => {
  const errors = [];
  if (!isObject(registry)) return { valid: false, errors: ["registry-invalid"] };
  if (registry.version !== VERSION) errors.push("version-invalid");
  try { canonicalIso(registry.createdAt, "createdAt"); } catch { errors.push("created-at-invalid"); }
  try { canonicalIso(registry.updatedAt, "updatedAt"); } catch { errors.push("updated-at-invalid"); }
  if (!isObject(registry.entities)) errors.push("entities-invalid");
  if (!Array.isArray(registry.conflicts)) errors.push("conflicts-invalid");
  const conflictIds = new Set();
  for (const conflict of registry.conflicts || []) {
    const body = { ...conflict };
    delete body.conflictId;
    const expected = sha256(stableStringify(body));
    if (conflict.conflictId !== expected) errors.push("conflict-hash-mismatch");
    if (conflictIds.has(conflict.conflictId)) errors.push("conflict-duplicate");
    conflictIds.add(conflict.conflictId);
  }
  const providerOwners = new Map();
  for (const [localEntityId, entity] of Object.entries(registry.entities || {})) {
    if (entity?.localEntityId !== localEntityId) errors.push(`local-entity-key-mismatch:${localEntityId}`);
    for (const [provider, mapping] of Object.entries(entity?.providers || {})) {
      if (!mapping.providerEntityId) errors.push(`provider-id-missing:${localEntityId}:${provider}`);
      if (!Array.isArray(mapping.evidence) || !mapping.evidence.length) errors.push(`provider-evidence-missing:${localEntityId}:${provider}`);
      const evidenceIds = new Set();
      for (const evidence of mapping.evidence || []) {
        const body = { ...evidence };
        delete body.evidenceId;
        const expected = sha256(stableStringify(body));
        if (evidence.evidenceId !== expected) errors.push(`evidence-hash-mismatch:${localEntityId}:${provider}`);
        if (evidenceIds.has(evidence.evidenceId)) errors.push(`evidence-duplicate:${localEntityId}:${provider}`);
        if (!HASH_PATTERN.test(compact(evidence.providerResponseSha256))) {
          errors.push(`provider-response-hash-missing:${localEntityId}:${provider}`);
        }
        if (!HASH_PATTERN.test(compact(evidence.fixtureIdentitySha256))) {
          errors.push(`fixture-identity-hash-missing:${localEntityId}:${provider}`);
        }
        if (evidence.evidenceSource !== "api-football-live-response-current-cycle") {
          errors.push(`evidence-source-untrusted:${localEntityId}:${provider}`);
        }
        evidenceIds.add(evidence.evidenceId);
      }
      if (mapping.status === "verified") {
        const reverseKey = `${provider}:${mapping.providerEntityId}`;
        const owner = providerOwners.get(reverseKey);
        if (owner && owner !== localEntityId) errors.push(`provider-id-owner-conflict:${reverseKey}`);
        providerOwners.set(reverseKey, localEntityId);
      }
    }
  }
  const expectedHash = sha256(stableStringify(registryBody(registry)));
  if (registry.registryHash !== expectedHash) errors.push("registry-hash-mismatch");
  return { valid: errors.length === 0, errors };
};

const assertRegistry = (registry) => {
  const validation = validateEntityRegistry(registry);
  if (!validation.valid) {
    throw new EntityResolutionError(`invalid entity registry: ${validation.errors.join(", ")}`, "INVALID_REGISTRY");
  }
};

const localTeamIdFor = (match, side) => compact(match?.[`${side}TeamId`]);
const localNamesFor = (match, side) => uniqSorted([
  match?.[`${side}TeamName`],
  match?.[`${side}TeamNameEn`],
  match?.[`${side}Team`],
  ...(Array.isArray(match?.[`${side}TeamAliases`]) ? match[`${side}TeamAliases`] : []),
]);

const providerMappingFor = (mapping, side) => ({
  providerEntityId: compact(mapping?.[`${side}TeamId`]),
  providerEntityName: compact(mapping?.[`${side}TeamName`]),
});

const fixtureIdentityBodyFor = (mapping) => stableValue({
  fixtureId: compact(mapping?.fixtureId),
  fixtureDate: canonicalIso(mapping?.fixtureDate, "fixtureDate"),
  leagueId: compact(mapping?.leagueId) || null,
  homeTeamId: compact(mapping?.homeTeamId),
  awayTeamId: compact(mapping?.awayTeamId),
  homeTeamName: compact(mapping?.homeTeamName) || null,
  awayTeamName: compact(mapping?.awayTeamName) || null,
});
const fixtureIdentityHashFor = (mapping) => sha256(stableStringify(fixtureIdentityBodyFor(mapping)));

const nameAgreement = (localNames, providerName) => {
  const provider = normalizeName(providerName);
  if (!provider) return 0;
  let best = 0;
  for (const localName of localNames || []) {
    const local = normalizeName(localName);
    if (!local) continue;
    if (local === provider) return 1;
    const localTokens = local.split(" ").filter(Boolean);
    const providerTokens = provider.split(" ").filter(Boolean);
    const localSet = new Set(localTokens);
    const providerSet = new Set(providerTokens);
    const overlap = localTokens.filter((token) => providerSet.has(token)).length;
    const union = new Set([...localSet, ...providerSet]).size;
    const subset = overlap === Math.min(localSet.size, providerSet.size) && overlap > 0;
    best = Math.max(best, subset ? 0.9 : overlap / Math.max(1, union));
  }
  return Number(best.toFixed(4));
};

const qualifyingFixtureMapping = (mapping, thresholds = {}, context = {}) => {
  const confidence = Number(mapping?.confidence);
  const teamScore = Number(mapping?.score?.teamScore);
  const minConfidence = Number(thresholds.minConfidence ?? MIN_FIXTURE_CONFIDENCE);
  const minTeamScore = Number(thresholds.minTeamScore ?? MIN_TEAM_SCORE);
  const blockers = [];
  if (!Number.isFinite(confidence) || confidence < minConfidence) blockers.push("fixture-confidence-below-threshold");
  if (!Number.isFinite(teamScore) || teamScore < minTeamScore) blockers.push("team-score-below-threshold");
  if (mapping?.score?.reversed === true) blockers.push("reversed-fixture-not-eligible");
  if (!compact(mapping?.fixtureId)) blockers.push("provider-fixture-id-missing");
  if (!compact(mapping?.homeTeamId) || !compact(mapping?.awayTeamId)) blockers.push("provider-team-id-missing");
  const responseSha256 = compact(mapping?.providerEvidence?.responseSha256);
  const trustedResponseSha256 = compact(context?.trustContext?.providerResponseSha256);
  if (context?.trustContext?.live !== true) blockers.push("provider-response-not-live-current-cycle");
  if (!HASH_PATTERN.test(responseSha256)) blockers.push("provider-response-hash-missing-or-invalid");
  if (!HASH_PATTERN.test(trustedResponseSha256) || responseSha256 !== trustedResponseSha256) {
    blockers.push("provider-response-hash-untrusted");
  }
  let fixtureIdentitySha256 = null;
  try {
    fixtureIdentitySha256 = fixtureIdentityHashFor(mapping);
  } catch {
    blockers.push("provider-fixture-identity-invalid");
  }
  if (!fixtureIdentitySha256
      || compact(mapping?.providerEvidence?.fixtureIdentitySha256) !== fixtureIdentitySha256) {
    blockers.push("provider-fixture-identity-hash-mismatch");
  }
  const match = context?.match;
  if (!match) {
    blockers.push("local-match-context-missing");
  } else {
    blockers.push(...fixtureTeamCategoryAudit(match, { home: mapping?.homeTeamName, away: mapping?.awayTeamName }, mapping).blockers);
    const kickoffMs = Date.parse(String(match?.kickoffTime || ""));
    const fixtureMs = Date.parse(String(mapping?.fixtureDate || ""));
    if (!Number.isFinite(kickoffMs) || !Number.isFinite(fixtureMs)
        || Math.abs(kickoffMs - fixtureMs) > 4 * 60 * 60 * 1000) {
      blockers.push("provider-fixture-time-mismatch");
    }
    for (const side of ["home", "away"]) {
      if (nameAgreement(localNamesFor(match, side), mapping?.[`${side}TeamName`]) < minTeamScore) {
        blockers.push(`${side}-provider-team-name-mismatch`);
      }
    }
  }
  return { eligible: blockers.length === 0, blockers, confidence, teamScore };
};

const evidenceBodyFor = ({ match, mapping, side, provider, at, trustContext }) => {
  const providerMapping = providerMappingFor(mapping, side);
  return stableValue({
    provider,
    providerEntityId: providerMapping.providerEntityId,
    providerEntityName: providerMapping.providerEntityName || null,
    sourceMatchId: compact(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, "")) || null,
    localMatchId: compact(match?.id) || null,
    fixtureId: compact(mapping?.fixtureId),
    fixtureDate: mapping?.fixtureDate || null,
    leagueId: compact(mapping?.leagueId) || null,
    observedAt: canonicalIso(at, "evidence observedAt"),
    confidence: Number(mapping.confidence),
    teamScore: Number(mapping.score.teamScore),
    timeScore: Number(mapping.score.timeScore),
    leagueScore: Number(mapping.score.leagueScore),
    reversed: false,
    providerResponseSha256: compact(trustContext?.providerResponseSha256),
    fixtureIdentitySha256: fixtureIdentityHashFor(mapping),
    evidenceSource: "api-football-live-response-current-cycle",
  });
};

const appendConflict = (registry, conflict) => {
  const body = stableValue(conflict);
  const conflictId = sha256(stableStringify(body));
  if (!registry.conflicts.some((item) => item.conflictId === conflictId)) {
    registry.conflicts.push({ ...body, conflictId });
    registry.conflicts.sort((a, b) => a.conflictId.localeCompare(b.conflictId));
  }
};

const applyFixtureMappingEvidence = ({
  registry,
  match,
  mapping,
  provider = DEFAULT_PROVIDER,
  observedAt = mapping?.matchedAt || new Date().toISOString(),
  thresholds = {},
  trustContext = null,
} = {}) => {
  assertRegistry(registry);
  const qualification = qualifyingFixtureMapping(mapping, thresholds, { match, trustContext });
  if (!qualification.eligible) {
    return { registry: JSON.parse(JSON.stringify(registry)), changed: false, blockers: qualification.blockers, conflictsAdded: 0 };
  }
  const next = JSON.parse(JSON.stringify(registry));
  const beforeConflicts = next.conflicts.length;
  const proposals = ["home", "away"].map((side) => {
    const localEntityId = localTeamIdFor(match, side);
    const localNames = localNamesFor(match, side);
    const providerMapping = providerMappingFor(mapping, side);
    if (!localEntityId || !providerMapping.providerEntityId) return null;
    const evidenceBody = evidenceBodyFor({ match, mapping, side, provider, at: observedAt, trustContext });
    const evidence = { ...evidenceBody, evidenceId: sha256(stableStringify(evidenceBody)) };
    return { side, localEntityId, localNames, providerMapping, evidence };
  }).filter(Boolean);
  if (proposals.length !== 2) {
    return {
      registry: JSON.parse(JSON.stringify(registry)),
      changed: false,
      blockers: ["fixture-local-team-id-missing"],
      conflictsAdded: 0,
    };
  }

  const conflicts = [];
  for (const proposal of proposals) {
    const { localEntityId, providerMapping, evidence } = proposal;
    const existingMapping = next.entities?.[localEntityId]?.providers?.[provider];
    const reverseOwner = Object.values(next.entities).find((entity) => (
      entity.localEntityId !== localEntityId
      && entity.providers?.[provider]?.status === "verified"
      && entity.providers[provider].providerEntityId === providerMapping.providerEntityId
    ));
    if (reverseOwner) {
      conflicts.push({
        type: "provider-entity-owned-by-another-local-entity",
        provider,
        providerEntityId: providerMapping.providerEntityId,
        localEntityIds: [localEntityId, reverseOwner.localEntityId].sort(),
        evidenceId: evidence.evidenceId,
        detectedAt: evidence.observedAt,
      });
    }
    if (existingMapping && existingMapping.providerEntityId !== providerMapping.providerEntityId) {
      const providerEntityIds = uniqSorted([
        ...(existingMapping.conflictingProviderEntityIds || []),
        existingMapping.providerEntityId,
        providerMapping.providerEntityId,
      ]);
      conflicts.push({
        type: "local-entity-mapped-to-multiple-provider-entities",
        provider,
        localEntityId,
        providerEntityIds,
        evidenceId: evidence.evidenceId,
        detectedAt: evidence.observedAt,
      });
    }
  }
  if (proposals[0].localEntityId !== proposals[1].localEntityId
      && proposals[0].providerMapping.providerEntityId === proposals[1].providerMapping.providerEntityId) {
    conflicts.push({
      type: "fixture-provider-entity-reused-across-sides",
      provider,
      providerEntityId: proposals[0].providerMapping.providerEntityId,
      localEntityIds: proposals.map((proposal) => proposal.localEntityId).sort(),
      evidenceIds: proposals.map((proposal) => proposal.evidence.evidenceId).sort(),
      detectedAt: canonicalIso(observedAt, "conflict detectedAt"),
    });
  }

  if (conflicts.length) {
    for (const conflict of conflicts) {
      appendConflict(next, conflict);
      if (conflict.type === "local-entity-mapped-to-multiple-provider-entities") {
        const existingMapping = next.entities?.[conflict.localEntityId]?.providers?.[provider];
        if (existingMapping) {
          existingMapping.status = "conflicted";
          existingMapping.conflictingProviderEntityIds = conflict.providerEntityIds;
        }
      }
    }
    const changed = next.conflicts.length !== beforeConflicts
      || conflicts.some((conflict) => (
        conflict.type === "local-entity-mapped-to-multiple-provider-entities"
        && next.entities?.[conflict.localEntityId]?.providers?.[provider]?.status === "conflicted"
        && registry.entities?.[conflict.localEntityId]?.providers?.[provider]?.status !== "conflicted"
      ));
    if (!changed) {
      return { registry: JSON.parse(JSON.stringify(registry)), changed: false, blockers: ["fixture-entity-conflict"], conflictsAdded: 0 };
    }
    next.updatedAt = canonicalIso(observedAt, "updatedAt");
    const finalized = finalizeRegistry(next);
    assertRegistry(finalized);
    return {
      registry: finalized,
      changed: true,
      blockers: ["fixture-entity-conflict"],
      conflictsAdded: finalized.conflicts.length - beforeConflicts,
    };
  }

  let changed = false;
  for (const proposal of proposals) {
    const { localEntityId, localNames, providerMapping, evidence } = proposal;
    const existingEntity = next.entities[localEntityId] || {
      localEntityId,
      names: [],
      normalizedNames: [],
      providers: {},
    };
    existingEntity.names = uniqSorted([...(existingEntity.names || []), ...localNames]);
    existingEntity.normalizedNames = uniqSorted([
      ...(existingEntity.normalizedNames || []),
      ...existingEntity.names.map(normalizeName),
    ]);
    const existingMapping = existingEntity.providers?.[provider];
    const providerRecord = existingMapping || {
      providerEntityId: providerMapping.providerEntityId,
      names: [],
      status: "verified",
      evidence: [],
    };
    providerRecord.names = uniqSorted([...(providerRecord.names || []), providerMapping.providerEntityName]);
    if (!providerRecord.evidence.some((item) => item.evidenceId === evidence.evidenceId)) {
      providerRecord.evidence.push(evidence);
      providerRecord.evidence.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.evidenceId.localeCompare(b.evidenceId));
      changed = true;
    }
    existingEntity.providers = existingEntity.providers || {};
    existingEntity.providers[provider] = providerRecord;
    next.entities[localEntityId] = existingEntity;
  }
  if (!changed) return { registry: JSON.parse(JSON.stringify(registry)), changed: false, blockers: [], conflictsAdded: 0 };
  next.updatedAt = canonicalIso(observedAt, "updatedAt");
  const finalized = finalizeRegistry(next);
  assertRegistry(finalized);
  return {
    registry: finalized,
    changed: true,
    blockers: [],
    conflictsAdded: finalized.conflicts.length - beforeConflicts,
  };
};

const providerEntityIdFor = (registry, localEntityId, provider = DEFAULT_PROVIDER) => {
  const mapping = registry?.entities?.[compact(localEntityId)]?.providers?.[provider];
  return mapping?.status === "verified" ? compact(mapping.providerEntityId) || null : null;
};

const providerTeamExpectations = (registry, match, provider = DEFAULT_PROVIDER) => ({
  home: providerEntityIdFor(registry, localTeamIdFor(match, "home"), provider),
  away: providerEntityIdFor(registry, localTeamIdFor(match, "away"), provider),
});

const providerIdentityScore = (registry, match, fixture, provider = DEFAULT_PROVIDER) => {
  const expected = providerTeamExpectations(registry, match, provider);
  const actual = {
    home: compact(fixture?.teams?.home?.id),
    away: compact(fixture?.teams?.away?.id),
  };
  const known = ["home", "away"].filter((side) => expected[side]);
  if (!known.length) return {
    available: false,
    exact: false,
    partialExact: false,
    fullCoverage: false,
    knownSides: [],
    conflict: false,
    score: null,
    expected,
    actual,
  };
  const matches = known.filter((side) => expected[side] === actual[side]).length;
  const conflict = known.some((side) => actual[side] && expected[side] !== actual[side]);
  const fullCoverage = known.length === 2;
  return {
    available: true,
    exact: fullCoverage && !conflict && matches === known.length,
    partialExact: !fullCoverage && !conflict && matches === known.length,
    fullCoverage,
    knownSides: known,
    conflict,
    score: Number((matches / known.length).toFixed(4)),
    expected,
    actual,
  };
};

const loadEntityRegistry = (file, { createdAt = new Date().toISOString() } = {}) => {
  if (!fs.existsSync(file)) return createEntityRegistry({ createdAt });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assertRegistry(parsed);
  return parsed;
};

const sleepSync = (milliseconds) => {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
};

const withRegistryFileLock = (file, action, { timeoutMs = 5_000, staleMs = 60_000 } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  while (!handle) {
    try {
      handle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new EntityResolutionError(`timed out waiting for registry lock: ${lockFile}`, "REGISTRY_LOCK_TIMEOUT");
      }
      sleepSync(25);
    }
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(lockFile); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
};

const writeEntityRegistryAtomic = (file, registry, { expectedRegistryHash } = {}) => {
  assertRegistry(registry);
  return withRegistryFileLock(file, () => {
    const currentHash = fs.existsSync(file) ? loadEntityRegistry(file).registryHash : null;
    if (expectedRegistryHash !== undefined && currentHash !== expectedRegistryHash) {
      throw new EntityResolutionError(
        `entity registry changed concurrently: expected ${expectedRegistryHash || "missing"}, found ${currentHash || "missing"}`,
        "REGISTRY_CONCURRENT_MODIFICATION",
      );
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return registry;
  });
};

module.exports = {
  DEFAULT_PROVIDER,
  EntityResolutionError,
  MIN_FIXTURE_CONFIDENCE,
  MIN_TEAM_SCORE,
  VERSION,
  applyFixtureMappingEvidence,
  createEntityRegistry,
  fixtureIdentityHashFor,
  loadEntityRegistry,
  normalizeName,
  providerEntityIdFor,
  providerIdentityScore,
  providerTeamExpectations,
  qualifyingFixtureMapping,
  stableStringify,
  validateEntityRegistry,
  writeEntityRegistryAtomic,
};
