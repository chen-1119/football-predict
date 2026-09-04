"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  EntityMasterDataError,
  applyWikidataCandidateApproval,
  createEntityMasterData,
  loadEntityMasterData,
  writeEntityMasterDataAtomic,
} = require("./entityMasterData.cjs");

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
};

const requiredArg = (args, name) => {
  const value = String(args[name] ?? "").trim();
  if (!value) throw new EntityMasterDataError(`--${name} is required`, "MDM_CLI_ARGUMENT_REQUIRED");
  return value;
};

const readJson = (file, label) => {
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); } catch (error) {
    throw new EntityMasterDataError(`${label} JSON is unreadable: ${error.message}`, "MDM_CLI_JSON_UNREADABLE");
  }
};

const parseExpectedRegistryHash = (value) => {
  const normalized = String(value || "").trim();
  if (normalized.toLowerCase() === "missing") return null;
  return normalized;
};

const reviewEntityCandidate = ({
  registry,
  candidateStore,
  localEntityId,
  candidateId,
  expectedCandidateStoreHash,
  reviewerId,
  reviewerDisplayName = null,
  verificationBasis,
  reviewedAt,
  validFrom,
  validTo = null,
}) => applyWikidataCandidateApproval({
  registry,
  candidateStore,
  localEntityId,
  candidateId,
  expectedCandidateStoreHash,
  reviewer: { id: reviewerId, kind: "human", displayName: reviewerDisplayName },
  verificationBasis,
  reviewedAt,
  validFrom,
  validTo,
});

const runCli = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.decision && args.decision !== "approve") {
    throw new EntityMasterDataError("only an explicit --decision approve is supported", "MDM_CLI_DECISION_INVALID");
  }
  const candidateStoreFile = path.resolve(requiredArg(args, "candidate-store"));
  const registryFile = path.resolve(requiredArg(args, "registry"));
  const basisFile = path.resolve(requiredArg(args, "basis-file"));
  const expectedRegistryHash = parseExpectedRegistryHash(requiredArg(args, "expected-registry-hash"));
  const expectedCandidateStoreHash = requiredArg(args, "expected-candidate-store-hash");
  const reviewedAt = requiredArg(args, "reviewed-at");
  const validFrom = requiredArg(args, "valid-from");
  const candidateStore = readJson(candidateStoreFile, "candidate store");
  const verificationBasis = readJson(basisFile, "verification basis");
  const registry = fs.existsSync(registryFile)
    ? loadEntityMasterData(registryFile)
    : createEntityMasterData({ createdAt: reviewedAt });
  if ((fs.existsSync(registryFile) ? registry.registryHash : null) !== expectedRegistryHash) {
    throw new EntityMasterDataError("CLI registry expectation is already stale", "MDM_CAS_STALE");
  }
  const result = reviewEntityCandidate({
    registry,
    candidateStore,
    localEntityId: requiredArg(args, "local-team-id"),
    candidateId: requiredArg(args, "candidate-id"),
    expectedCandidateStoreHash,
    reviewerId: requiredArg(args, "reviewer"),
    reviewerDisplayName: args["reviewer-display-name"] || null,
    verificationBasis,
    reviewedAt,
    validFrom,
    validTo: args["valid-to"] || null,
  });
  const persisted = writeEntityMasterDataAtomic(registryFile, result.registry, { expectedRegistryHash });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    decision: result.review.decision,
    activated: result.activated,
    quarantined: result.quarantined,
    localEntityId: result.mapping.localEntityId,
    provider: result.mapping.provider,
    providerEntityId: result.mapping.providerEntityId,
    validFrom: result.mapping.validFrom,
    validTo: result.mapping.validTo,
    mappingId: result.mapping.mappingId,
    reviewId: result.review.reviewId,
    conflicts: result.conflicts.map((conflict) => conflict.conflictId),
    registryHash: persisted.registryHash,
    registryFile,
  }, null, 2)}\n`);
};

if (require.main === module) {
  try { runCli(); } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "ERROR",
      message: error?.message || String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  reviewEntityCandidate,
  runCli,
};
