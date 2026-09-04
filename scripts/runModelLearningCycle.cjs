"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  applyLearningCandidate,
  buildCandidateFromEvaluation,
  buildLearningEvidenceFromEvaluation,
  createLearningRegistry,
  sha256,
  validateLearningRegistry,
} = require("./modelLearningRegistry.cjs");
const {
  FEATURE_SCHEMA_VERSION: RESIDUAL_MARKET_FEATURE_SCHEMA_VERSION,
} = require("./residualMarketModel.cjs");

const rootDir = path.resolve(__dirname, "..");
const serverStoreDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
const evaluationFile = path.resolve(
  process.env.MODEL_LEARNING_EVALUATION_FILE
    || path.join(rootDir, "public", "data", "model-evaluation.json"),
);
const registryFile = path.resolve(
  process.env.MODEL_LEARNING_REGISTRY_FILE
    || path.join(serverStoreDir, "model-artifacts", "model-learning-registry.json"),
);
const inferenceFile = path.join(__dirname, "residualMarketModel.cjs");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
};

const main = () => {
  if (!fs.existsSync(evaluationFile)) throw new Error(`model evaluation not found: ${evaluationFile}`);
  if (!fs.existsSync(inferenceFile)) throw new Error(`residual inference implementation not found: ${inferenceFile}`);
  const evaluation = readJson(evaluationFile);
  const at = new Date().toISOString();
  const inferenceImplementationHash = sha256(fs.readFileSync(inferenceFile));
  const candidateContract = {
    inferenceImplementationHash,
    featureSchemaVersion: RESIDUAL_MARKET_FEATURE_SCHEMA_VERSION,
    policyVersion: "multi-factor-market-evidence-v2",
  };
  const productionContract = {
    inferenceImplementationHash: process.env.MODEL_LEARNING_PRODUCTION_INFERENCE_HASH || null,
    featureSchemaVersion: process.env.MODEL_LEARNING_PRODUCTION_FEATURE_SCHEMA_VERSION || null,
    policyVersion: process.env.MODEL_LEARNING_PRODUCTION_POLICY_VERSION || null,
  };
  const registry = fs.existsSync(registryFile)
    ? readJson(registryFile)
    : createLearningRegistry({ createdAt: at });
  const registryValidation = validateLearningRegistry(registry);
  if (!registryValidation.valid) {
    throw new Error(`model learning registry failed validation: ${registryValidation.errors.join(", ")}`);
  }
  const candidate = buildCandidateFromEvaluation(evaluation, candidateContract);
  const evidence = buildLearningEvidenceFromEvaluation(evaluation, candidateContract);
  const result = applyLearningCandidate({
    registry,
    candidate,
    evaluation: evidence,
    productionContract,
    at,
    actor: {
      type: "automation",
      id: process.env.MODEL_LEARNING_ACTOR_ID || "football-sync-worker",
    },
  });
  if (!result.idempotent) writeJsonAtomic(registryFile, result.registry);
  console.log(JSON.stringify({
    ok: true,
    version: result.registry.version,
    evaluationFile,
    registryFile,
    idempotent: result.idempotent,
    decision: result.decision,
    championArtifactHash: result.registry.championArtifactHash,
    registryHash: result.registry.registryHash,
    entries: result.registry.entries.length,
    policy: "Training may autonomously register shadow candidates, but production activation remains fail-closed until every evidence and runtime-contract gate passes.",
  }, null, 2));
};

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
