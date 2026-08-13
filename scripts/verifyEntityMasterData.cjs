"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  API_ENDPOINT,
  SOURCE_LICENSE,
  finalizeCandidateStore,
  hashJson: candidateHashJson,
} = require("./wikidataEntityCandidates.cjs");
const {
  applyWikidataCandidateApproval,
  createEntityMasterData,
  finalizeRegistry,
  hashJson,
  loadEntityMasterData,
  providerEntityIdAt,
  validateEntityMasterData,
  writeEntityMasterDataAtomic,
} = require("./entityMasterData.cjs");

const passed = [];
const check = (condition, name) => {
  assert.ok(condition, name);
  passed.push(name);
};
const expectCode = (fn, code, name) => {
  assert.throws(fn, (error) => error?.code === code, name);
  passed.push(name);
};

const receiptFor = ({ qid, at, salt }) => {
  const body = {
    sourceId: "wikidata",
    endpoint: API_ENDPOINT,
    method: "GET",
    requestUrl: `${API_ENDPOINT}?action=wbgetentities&format=json&ids=${qid}`,
    requestedAt: at,
    receivedAt: at,
    httpStatus: 200,
    responseHeaders: {
      contentType: "application/json",
      date: at,
      etag: null,
      lastModified: null,
    },
    rawSha256: candidateHashJson({ raw: qid, salt }),
    rawBytes: 128 + String(salt).length,
    canonicalPayloadSha256: candidateHashJson({ entity: qid, salt }),
  };
  return { ...body, receiptId: candidateHashJson(body) };
};

const candidateStoreFor = ({
  localEntityId,
  localName,
  qid,
  generatedAt,
  exact = true,
  football = true,
  salt = qid,
}) => {
  const receipt = receiptFor({ qid, at: generatedAt, salt });
  const candidateBody = {
    provider: "wikidata",
    providerEntityId: qid,
    labels: [localName],
    aliases: [`${localName} FC`],
    descriptions: football ? ["association football club"] : ["unrelated organization"],
    instanceOf: ["Q476028"],
    countries: ["Q148"],
    sports: football ? ["Q2736"] : [],
    officialWebsites: [`https://${localEntityId}.example.test/`],
    lastRevisionId: 123,
    queryMatches: [{
      query: localName,
      role: "base-name",
      receiptId: receipt.receiptId,
      searchRank: 1,
      matchedBy: exact ? "label" : "description",
      matchedLanguage: "en",
      matchedText: exact ? localName : `${localName} City`,
    }],
    exactBaseName: exact,
    exactContextQuery: false,
    footballEvidence: football,
    candidateConfidence: football && exact ? 0.82 : 0.4,
    reviewState: "quarantined",
    autoPromotable: false,
    blockers: [
      "manual-approval-required",
      ...(football ? [] : ["football-identity-not-established"]),
      ...(exact ? [] : ["exact-name-or-alias-not-established"]),
    ],
    receiptIds: [receipt.receiptId],
  };
  const candidate = { ...candidateBody, candidateId: candidateHashJson(candidateBody) };
  return finalizeCandidateStore({
    version: "wikidata-entity-candidates-v1",
    generatedAt,
    source: {
      sourceId: "wikidata",
      endpoint: API_ENDPOINT,
      accessMethod: "Wikibase Action API",
      license: SOURCE_LICENSE,
      licenseUrl: "https://www.wikidata.org/wiki/Wikidata:Licensing",
      userAgent: "entity-mdm-verifier/1.0",
    },
    input: {
      sourceCycleId: `cycle-${salt}`,
      dataGenerationId: `generation-${salt}`,
      matchesCurrentSha256: candidateHashJson({ matches: salt }),
      localEntityCount: 1,
    },
    policy: {
      purpose: "candidate-discovery-only",
      exactEntityRequiredForFormalUse: true,
      fuzzyMatchesQuarantined: true,
      automaticPromotionAllowed: false,
      providerFactsTrustedForProbability: false,
      manualApprovalRequired: true,
    },
    entities: [{
      localEntityId,
      names: [localName],
      contexts: [{ league: "Test League", country: "Test Country" }],
      queries: [{ query: localName, role: "base-name" }],
      candidates: [candidate],
      reviewState: "candidate-review-required",
      autoPromotable: false,
    }],
    receipts: [receipt],
  });
};

const candidateOf = (store) => store.entities[0].candidates[0];
const reviewer = { id: "reviewer-alice", kind: "human", displayName: "Alice" };
const basisAt = (at, host = "official-club.example.test") => ({
  method: "official-club-cross-check",
  summary: "Official club record confirms the football team and exact entity identity.",
  references: [{
    sourceType: "official-club",
    url: `https://${host}/teams/first-team`,
    checkedAt: at,
    independentFromCandidateSource: true,
    supportsFootballIdentity: true,
    supportsEntityEquivalence: true,
    contentSha256: hashJson({ host, at }),
    note: "Name, sport and organization context match.",
  }],
});

const approve = ({ registry, store, reviewedAt, validFrom, validTo = null, basis = basisAt(reviewedAt), human = reviewer }) => (
  applyWikidataCandidateApproval({
    registry,
    candidateStore: store,
    localEntityId: store.entities[0].localEntityId,
    candidateId: candidateOf(store).candidateId,
    expectedCandidateStoreHash: store.storeHash,
    reviewer: human,
    verificationBasis: basis,
    reviewedAt,
    validFrom,
    validTo,
  })
);

let registry = createEntityMasterData({ createdAt: "2026-01-01T00:00:00.000Z" });
check(validateEntityMasterData(registry).valid, "empty registry is valid and content-addressed");
check(registry.registryHash === hashJson((({ registryHash: _hash, ...body }) => body)(registry)),
  "registry hash commits to the canonical body");

const alphaOld = candidateStoreFor({
  localEntityId: "team_alpha",
  localName: "Alpha FC",
  qid: "Q1001",
  generatedAt: "2026-01-02T00:00:00.000Z",
  salt: "alpha-old",
});
expectCode(() => applyWikidataCandidateApproval({
  registry,
  candidateStore: alphaOld,
  localEntityId: "team_alpha",
  candidateId: candidateOf(alphaOld).candidateId,
  expectedCandidateStoreHash: alphaOld.storeHash,
  reviewer: null,
  verificationBasis: basisAt("2026-01-03T00:00:00.000Z"),
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_REVIEWER_REQUIRED", "approval without an explicit reviewer fails closed");
expectCode(() => approve({
  registry,
  store: alphaOld,
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
  basis: basisAt("2026-01-03T00:00:00.000Z", "www.wikidata.org"),
}), "MDM_VERIFICATION_REFERENCE_NOT_INDEPENDENT", "Wikidata cannot self-verify its own candidate");
expectCode(() => applyWikidataCandidateApproval({
  registry,
  candidateStore: alphaOld,
  localEntityId: "team_alpha",
  candidateId: "f".repeat(64),
  expectedCandidateStoreHash: alphaOld.storeHash,
  reviewer,
  verificationBasis: basisAt("2026-01-03T00:00:00.000Z"),
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_CANDIDATE_UNKNOWN", "unknown candidate id fails closed");
expectCode(() => applyWikidataCandidateApproval({
  registry,
  candidateStore: alphaOld,
  localEntityId: "team_alpha",
  candidateId: candidateOf(alphaOld).candidateId,
  expectedCandidateStoreHash: "a".repeat(64),
  reviewer,
  verificationBasis: basisAt("2026-01-03T00:00:00.000Z"),
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_CANDIDATE_STORE_HASH_MISMATCH", "unpinned candidate store hash fails closed");

const tamperedStore = JSON.parse(JSON.stringify(alphaOld));
tamperedStore.entities[0].candidates[0].providerEntityId = "Q9999";
expectCode(() => applyWikidataCandidateApproval({
  registry,
  candidateStore: tamperedStore,
  localEntityId: "team_alpha",
  candidateId: candidateOf(alphaOld).candidateId,
  expectedCandidateStoreHash: alphaOld.storeHash,
  reviewer,
  verificationBasis: basisAt("2026-01-03T00:00:00.000Z"),
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_CANDIDATE_STORE_INVALID", "tampered candidate content fails store validation");

const fuzzy = candidateStoreFor({
  localEntityId: "team_fuzzy", localName: "Fuzzy FC", qid: "Q2001",
  generatedAt: "2026-01-02T00:00:00.000Z", exact: false, salt: "fuzzy",
});
expectCode(() => approve({
  registry, store: fuzzy, reviewedAt: "2026-01-03T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_CANDIDATE_FUZZY_ONLY", "fuzzy-only candidate cannot be activated");
const nonFootball = candidateStoreFor({
  localEntityId: "team_not_football", localName: "Alpha Organization", qid: "Q2002",
  generatedAt: "2026-01-02T00:00:00.000Z", football: false, salt: "not-football",
});
expectCode(() => approve({
  registry, store: nonFootball, reviewedAt: "2026-01-03T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z",
}), "MDM_CANDIDATE_NOT_FOOTBALL", "non-football candidate cannot be activated");

const first = approve({
  registry,
  store: alphaOld,
  reviewedAt: "2026-01-03T00:00:00.000Z",
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: "2026-07-01T00:00:00.000Z",
});
registry = first.registry;
check(first.activated && !first.quarantined, "human-verified exact football candidate becomes an approved bounded mapping");
check(first.mapping.reviewer.id === reviewer.id && first.mapping.evidence.length === 1,
  "mapping retains reviewer and content-addressed evidence");
check(validateEntityMasterData(registry).valid, "approved temporal mapping keeps registry valid");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2025-12-31T23:59:59.999Z") === null,
  "strict as-of lookup excludes time before validFrom");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-01-01T00:00:00.000Z") === "Q1001",
  "strict as-of lookup includes validFrom boundary");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-06-30T23:59:59.999Z") === "Q1001",
  "strict as-of lookup resolves within the historical interval");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-07-01T00:00:00.000Z") === null,
  "strict as-of lookup excludes half-open validTo boundary");
expectCode(() => providerEntityIdAt(registry, "team_alpha", "wikidata", "not-a-time"),
  "MDM_INVALID_TIMESTAMP", "invalid as-of timestamp fails closed");

const alphaCurrent = candidateStoreFor({
  localEntityId: "team_alpha", localName: "Alpha FC", qid: "Q1002",
  generatedAt: "2026-07-01T12:00:00.000Z", salt: "alpha-current",
});
const second = approve({
  registry,
  store: alphaCurrent,
  reviewedAt: "2026-07-02T00:00:00.000Z",
  validFrom: "2026-07-01T00:00:00.000Z",
});
registry = second.registry;
check(second.activated, "non-overlapping successor identity can be approved as a new temporal version");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-06-30T12:00:00.000Z") === "Q1001",
  "historical lookup remains pinned to the old provider identity");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-07-02T00:00:00.000Z") === "Q1002",
  "current lookup resolves to the successor provider identity");

const alphaConflictStore = candidateStoreFor({
  localEntityId: "team_alpha", localName: "Alpha FC", qid: "Q1003",
  generatedAt: "2026-08-01T00:00:00.000Z", salt: "alpha-conflict",
});
const localConflict = approve({
  registry,
  store: alphaConflictStore,
  reviewedAt: "2026-08-02T00:00:00.000Z",
  validFrom: "2026-08-01T00:00:00.000Z",
});
registry = localConflict.registry;
check(!localConflict.activated && localConflict.quarantined && localConflict.conflicts.length === 1,
  "same local team to a different overlapping QID is quarantined");
check(localConflict.mapping.status === "quarantined-conflict",
  "conflicting proposal is retained as audit evidence rather than activated");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-08-03T00:00:00.000Z") === "Q1002",
  "local identity conflict cannot overwrite the existing approved mapping");

const betaReverseStore = candidateStoreFor({
  localEntityId: "team_beta", localName: "Beta FC", qid: "Q1002",
  generatedAt: "2026-08-03T00:00:00.000Z", salt: "beta-reverse",
});
const reverseConflict = approve({
  registry,
  store: betaReverseStore,
  reviewedAt: "2026-08-04T00:00:00.000Z",
  validFrom: "2026-08-03T00:00:00.000Z",
});
registry = reverseConflict.registry;
check(!reverseConflict.activated && reverseConflict.conflicts[0].type === "provider-entity-overlapping-local-identities",
  "same QID to a different local team is quarantined");
check(providerEntityIdAt(registry, "team_beta", "wikidata", "2026-08-05T00:00:00.000Z") === null,
  "reverse ownership conflict never becomes an as-of mapping");
check(providerEntityIdAt(registry, "team_alpha", "wikidata", "2026-08-05T00:00:00.000Z") === "Q1002",
  "reverse ownership conflict cannot overwrite the established owner");
check(validateEntityMasterData(registry).valid, "registry with quarantined conflicts remains content-valid");
expectCode(() => approve({
  registry,
  store: betaReverseStore,
  reviewedAt: "2026-08-05T00:00:00.000Z",
  validFrom: "2026-08-03T00:00:00.000Z",
}), "MDM_CANDIDATE_REPLAY", "reviewing the same candidate-store tuple twice fails closed");

const logicallyTampered = JSON.parse(JSON.stringify(registry));
const proposed = logicallyTampered.entities.team_alpha.providerMappings
  .find((mapping) => mapping.providerEntityId === "Q1003");
proposed.status = "approved";
proposed.mappingId = hashJson((({ mappingId: _mappingId, ...body }) => body)(proposed));
const logicalConflict = logicallyTampered.conflicts.find((row) => row.type === "local-entity-overlapping-provider-identities");
logicalConflict.proposedMappingId = proposed.mappingId;
logicalConflict.conflictId = hashJson((({ conflictId: _conflictId, ...body }) => body)(logicalConflict));
const rehashedTamper = finalizeRegistry(logicallyTampered);
check(!validateEntityMasterData(rehashedTamper).valid,
  "recomputed hashes cannot hide an overlapping approved logical conflict");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-mdm-verifier-"));
try {
  const file = path.join(tempDir, "entity-master-data.json");
  const persisted = writeEntityMasterDataAtomic(file, registry, { expectedRegistryHash: null });
  check(persisted.registryHash === registry.registryHash, "atomic CAS creation persists the exact content-addressed registry");
  const loaded = loadEntityMasterData(file);
  check(loaded.registryHash === registry.registryHash, "atomic registry round-trip verifies its content hash");
  expectCode(() => writeEntityMasterDataAtomic(file, registry, {}),
    "MDM_CAS_EXPECTATION_REQUIRED", "writes without a CAS expectation fail closed");

  const deltaStore = candidateStoreFor({
    localEntityId: "team_delta", localName: "Delta FC", qid: "Q4001",
    generatedAt: "2026-09-01T00:00:00.000Z", salt: "delta",
  });
  const epsilonStore = candidateStoreFor({
    localEntityId: "team_epsilon", localName: "Epsilon FC", qid: "Q4002",
    generatedAt: "2026-09-01T00:00:00.000Z", salt: "epsilon",
  });
  const delta = approve({
    registry: loaded, store: deltaStore, reviewedAt: "2026-09-02T00:00:00.000Z", validFrom: "2026-09-01T00:00:00.000Z",
  });
  const epsilon = approve({
    registry: loaded, store: epsilonStore, reviewedAt: "2026-09-02T00:00:01.000Z", validFrom: "2026-09-01T00:00:00.000Z",
  });
  writeEntityMasterDataAtomic(file, delta.registry, { expectedRegistryHash: loaded.registryHash });
  expectCode(() => writeEntityMasterDataAtomic(file, epsilon.registry, { expectedRegistryHash: loaded.registryHash }),
    "MDM_CAS_STALE", "stale concurrent writer cannot erase the winning registry version");
  const afterCas = loadEntityMasterData(file);
  check(Boolean(afterCas.entities.team_delta), "CAS winner is preserved");
  check(!afterCas.entities.team_epsilon, "stale CAS loser is not partially written");

  const tamperedRegistry = JSON.parse(fs.readFileSync(file, "utf8"));
  tamperedRegistry.entities.team_delta.providerMappings[0].providerEntityId = "Q999999";
  fs.writeFileSync(file, `${JSON.stringify(tamperedRegistry)}\n`, "utf8");
  expectCode(() => loadEntityMasterData(file), "MDM_REGISTRY_INVALID",
    "on-disk registry tampering fails closed at load time");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const cliTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-mdm-cli-verifier-"));
try {
  const cliStore = candidateStoreFor({
    localEntityId: "team_cli", localName: "CLI FC", qid: "Q5001",
    generatedAt: "2026-10-01T00:00:00.000Z", salt: "cli",
  });
  const storeFile = path.join(cliTempDir, "candidates.json");
  const basisFile = path.join(cliTempDir, "basis.json");
  const registryFile = path.join(cliTempDir, "registry.json");
  fs.writeFileSync(storeFile, `${JSON.stringify(cliStore, null, 2)}\n`, "utf8");
  fs.writeFileSync(basisFile, `${JSON.stringify(basisAt("2026-10-02T00:00:00.000Z"), null, 2)}\n`, "utf8");
  const cliOutput = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "reviewEntityCandidate.cjs"),
    "--decision", "approve",
    "--candidate-store", storeFile,
    "--registry", registryFile,
    "--basis-file", basisFile,
    "--expected-registry-hash", "missing",
    "--expected-candidate-store-hash", cliStore.storeHash,
    "--local-team-id", "team_cli",
    "--candidate-id", candidateOf(cliStore).candidateId,
    "--reviewer", "reviewer-cli-human",
    "--reviewed-at", "2026-10-02T00:00:00.000Z",
    "--valid-from", "2026-10-01T00:00:00.000Z",
  ], { encoding: "utf8", windowsHide: true }));
  check(cliOutput.ok && cliOutput.activated && !cliOutput.quarantined,
    "review CLI activates an exact candidate only through explicit approve arguments");
  const cliRegistry = loadEntityMasterData(registryFile);
  check(providerEntityIdAt(cliRegistry, "team_cli", "wikidata", "2026-10-01T00:00:00.000Z") === "Q5001",
    "review CLI atomically persists the approved temporal mapping in an isolated registry");
} finally {
  fs.rmSync(cliTempDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "entity-master-data-v1",
  assertions: passed.length,
  passed,
  guarantees: {
    candidateBoundary: "Wikidata remains quarantined until explicit human review with independent basis",
    temporalLookup: "half-open validFrom/validTo intervals with strict as-of resolution",
    conflictPolicy: "local/QID overlap is quarantined and never overwrites approved mappings",
    persistence: "content-addressed registry with mandatory compare-and-swap atomic writes",
    testIsolation: "temporary fixtures only; no network or production registry writes",
  },
}, null, 2)}\n`);
