"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyFixtureMappingEvidence,
  createEntityRegistry,
  fixtureIdentityHashFor,
  loadEntityRegistry,
  providerEntityIdFor,
  providerIdentityScore,
  qualifyingFixtureMapping,
  validateEntityRegistry,
  writeEntityRegistryAtomic,
} = require("./entityResolutionRegistry.cjs");
const { confidenceForFixture } = require("./syncApiFootballData.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

const at = "2026-07-16T08:00:00.000Z";
const match = {
  id: "sporttery_2040186",
  sourceMatchId: "2040186",
  homeTeamId: "team_china",
  awayTeamId: "team_thailand",
  homeTeamName: "中国",
  homeTeamNameEn: "China PR",
  awayTeamName: "泰国",
  awayTeamNameEn: "Thailand",
  kickoffTime: "2026-06-09T19:35:00+08:00",
  leagueNameEn: "Friendlies",
};
const mapping = {
  fixtureId: 1546502,
  confidence: 1,
  score: { teamScore: 1, timeScore: 1, leagueScore: 1, reversed: false },
  matchedAt: at,
  fixtureDate: "2026-06-09T11:35:00.000Z",
  leagueId: 10,
  homeTeamId: 1566,
  awayTeamId: 1564,
  homeTeamName: "China",
  awayTeamName: "Thailand",
};
const providerResponseSha256 = "a".repeat(64);
mapping.providerEvidence = {
  responseSha256: providerResponseSha256,
  fixtureIdentitySha256: fixtureIdentityHashFor(mapping),
};
const trustContext = { live: true, providerResponseSha256 };

let registry = createEntityRegistry({ createdAt: at });
check(validateEntityRegistry(registry).valid, "empty registry is valid and content-addressed");
check(qualifyingFixtureMapping(mapping, {}, { match, trustContext }).eligible,
  "high-confidence direct fixture mapping with a live provider receipt is eligible evidence");
const untrustedCacheMapping = applyFixtureMappingEvidence({ registry, match, mapping, observedAt: at });
check(!untrustedCacheMapping.changed, "a cache row cannot self-assert provider trust");
check(untrustedCacheMapping.blockers.includes("provider-response-not-live-current-cycle"),
  "missing current-cycle provider receipt fails closed");

const first = applyFixtureMappingEvidence({ registry, match, mapping, observedAt: at, trustContext });
check(first.changed, "first verified mapping changes the registry");
check(first.conflictsAdded === 0, "consistent mapping adds no conflict");
registry = first.registry;
check(providerEntityIdFor(registry, "team_china") === "1566", "local home entity resolves to provider id");
check(providerEntityIdFor(registry, "team_thailand") === "1564", "local away entity resolves to provider id");
check(registry.entities.team_china.names.includes("中国"), "local Chinese name is preserved");
check(registry.entities.team_china.normalizedNames.includes("china pr"), "normalized local alias is preserved");
check(registry.entities.team_china.providers["api-football"].evidence.length === 1, "mapping has immutable evidence");
check(validateEntityRegistry(registry).valid, "populated registry validates");

const exactFixture = {
  teams: { home: { id: 1566 }, away: { id: 1564 } },
};
const exactIdentity = providerIdentityScore(registry, match, exactFixture);
check(exactIdentity.available && exactIdentity.exact && !exactIdentity.conflict, "known provider ids produce exact entity match");
const wrongFixture = {
  teams: { home: { id: 999 }, away: { id: 1564 } },
};
const wrongIdentity = providerIdentityScore(registry, match, wrongFixture);
check(wrongIdentity.available && wrongIdentity.conflict && wrongIdentity.score === 0.5, "one provider-id mismatch is an explicit conflict");

const exactConfidence = confidenceForFixture(match, {
  date: match.kickoffTime,
  league: { name: "Friendlies", round: "International Friendlies" },
  teams: { home: { id: 1566, name: "Unrelated Home Label" }, away: { id: 1564, name: "Unrelated Away Label" } },
}, registry);
check(exactConfidence.entityIdentity.exact && exactConfidence.teamScore === 1, "verified entity ids override brittle display-name differences");
const conflictConfidence = confidenceForFixture(match, {
  date: match.kickoffTime,
  league: { name: "Friendlies", round: "International Friendlies" },
  teams: { home: { id: 9999, name: "China" }, away: { id: 1564, name: "Thailand" } },
}, registry);
check(conflictConfidence.entityIdentity.conflict && conflictConfidence.teamScore <= 0.2, "provider-id conflict downgrades even a plausible fuzzy-name match");

const duplicate = applyFixtureMappingEvidence({ registry, match, mapping, observedAt: at, trustContext });
check(!duplicate.changed, "same evidence is idempotent");
check(duplicate.registry.registryHash === registry.registryHash, "idempotent evidence leaves the registry hash unchanged");

const lowConfidence = applyFixtureMappingEvidence({
  registry,
  match,
  mapping: { ...mapping, confidence: 0.7 },
  observedAt: "2026-07-16T08:01:00.000Z",
  trustContext,
});
check(!lowConfidence.changed, "low-confidence match cannot create entity evidence");
check(lowConfidence.blockers.includes("fixture-confidence-below-threshold"), "low-confidence blocker is machine readable");

const reversed = applyFixtureMappingEvidence({
  registry,
  match,
  mapping: { ...mapping, score: { ...mapping.score, reversed: true } },
  observedAt: "2026-07-16T08:01:00.000Z",
  trustContext,
});
check(!reversed.changed, "reversed fixture matching is not trusted for identity registration");
check(reversed.blockers.includes("reversed-fixture-not-eligible"), "reversed blocker is explicit");

const conflict = applyFixtureMappingEvidence({
  registry,
  match,
  mapping: (() => {
    const value = { ...mapping, homeTeamId: 7777, matchedAt: "2026-07-16T08:02:00.000Z" };
    value.providerEvidence = { ...mapping.providerEvidence, fixtureIdentitySha256: fixtureIdentityHashFor(value) };
    return value;
  })(),
  observedAt: "2026-07-16T08:02:00.000Z",
  trustContext,
});
check(conflict.changed && conflict.conflictsAdded === 1, "one local entity mapped to two provider ids is quarantined");
check(providerEntityIdFor(conflict.registry, "team_china") === null, "conflicted mapping is unavailable to automatic matching");
check(conflict.registry.entities.team_china.providers["api-football"].status === "conflicted", "conflict state is persisted");
check(validateEntityRegistry(conflict.registry).valid, "conflicted registry remains auditable");

const oneSideKnownIdentity = providerIdentityScore(conflict.registry, match, {
  teams: { home: { id: 9999 }, away: { id: 1564 } },
});
check(
  oneSideKnownIdentity.partialExact && !oneSideKnownIdentity.exact && oneSideKnownIdentity.knownSides.length === 1,
  "one known provider side is partial evidence rather than an exact fixture identity",
);
const oneSideWrongOpponent = confidenceForFixture(match, {
  date: match.kickoffTime,
  league: { name: "Friendlies", round: "International Friendlies" },
  teams: {
    home: { id: 9999, name: "Totally Wrong Opponent" },
    away: { id: 1564, name: "Thailand" },
  },
}, conflict.registry);
check(
  oneSideWrongOpponent.entityIdentity.partialExact && oneSideWrongOpponent.teamScore < 0.86,
  "one known side cannot promote a fixture whose unknown opponent name is wrong",
);

const otherMatch = {
  ...match,
  id: "sporttery_other",
  sourceMatchId: "other",
  homeTeamId: "team_other",
  awayTeamId: "team_other_away",
  homeTeamName: "Other Home",
  awayTeamName: "Other Away",
};
const reverseOwnerConflict = applyFixtureMappingEvidence({
  registry,
  match: otherMatch,
  mapping: (() => {
    const value = {
      ...mapping,
      awayTeamId: 8888,
      homeTeamName: "Other Home",
      awayTeamName: "Other Away",
      matchedAt: "2026-07-16T08:03:00.000Z",
    };
    value.providerEvidence = { ...mapping.providerEvidence, fixtureIdentitySha256: fixtureIdentityHashFor(value) };
    return value;
  })(),
  observedAt: "2026-07-16T08:03:00.000Z",
  trustContext,
});
check(reverseOwnerConflict.conflictsAdded === 1, "one provider id cannot silently belong to two local teams");
check(providerEntityIdFor(reverseOwnerConflict.registry, "team_other") === null, "reverse ownership conflict is not activated");
check(providerEntityIdFor(reverseOwnerConflict.registry, "team_other_away") === null,
  "a fixture conflict prevents the non-conflicting side from being partially committed");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-resolution-registry-"));
try {
  const file = path.join(tempDir, "registry.json");
  writeEntityRegistryAtomic(file, registry);
  const loaded = loadEntityRegistry(file);
  check(loaded.registryHash === registry.registryHash, "atomic persistence round-trips exactly");
  const concurrentCandidate = (suffix, firstProviderId) => {
    const localMatch = {
      ...match,
      id: `sporttery_writer_${suffix}`,
      sourceMatchId: `writer_${suffix}`,
      homeTeamId: `writer_${suffix}_home`,
      awayTeamId: `writer_${suffix}_away`,
      homeTeamName: `Writer ${suffix} Home`,
      homeTeamNameEn: `Writer ${suffix} Home`,
      awayTeamName: `Writer ${suffix} Away`,
      awayTeamNameEn: `Writer ${suffix} Away`,
    };
    const localMapping = {
      ...mapping,
      fixtureId: Number(`9${firstProviderId}`),
      homeTeamId: firstProviderId,
      awayTeamId: firstProviderId + 1,
      homeTeamName: localMatch.homeTeamName,
      awayTeamName: localMatch.awayTeamName,
    };
    localMapping.providerEvidence = {
      ...mapping.providerEvidence,
      fixtureIdentitySha256: fixtureIdentityHashFor(localMapping),
    };
    return applyFixtureMappingEvidence({
      registry: loaded,
      match: localMatch,
      mapping: localMapping,
      observedAt: at,
      trustContext,
    }).registry;
  };
  const writerA = concurrentCandidate("A", 9101);
  const writerB = concurrentCandidate("B", 9201);
  writeEntityRegistryAtomic(file, writerA, { expectedRegistryHash: loaded.registryHash });
  assert.throws(
    () => writeEntityRegistryAtomic(file, writerB, { expectedRegistryHash: loaded.registryHash }),
    (error) => error?.code === "REGISTRY_CONCURRENT_MODIFICATION",
  );
  assertions += 1;
  const afterConcurrentWrite = loadEntityRegistry(file);
  check(Boolean(afterConcurrentWrite.entities.writer_A_home), "first compare-and-swap writer is preserved");
  check(!afterConcurrentWrite.entities.writer_B_home, "stale concurrent writer cannot erase or replace evidence");
  const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
  tampered.entities.team_china.providers["api-football"].providerEntityId = "9999";
  fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`, "utf8");
  assert.throws(() => loadEntityRegistry(file), /invalid entity registry/);
  assertions += 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Entity resolution registry verification passed (${assertions} assertions).`);
