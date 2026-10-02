"use strict";
// Supplemental evidence checks only. Never authorizes a release or mutates production.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { compareRecommendationProjectionPair, isResultPhase } = require("../server/recommendationProjectionParity.cjs");
const { compactFrozenReviewVersion } = require("../src/services/frozenReviewVersion.cjs");
const REQUIRED_FILES = ["matches-current.json", "model-evaluation.json", "model-strategy.json"];
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const publicationKeys = ["mode", "generationId", "manifestHash", "sourceCycleId", "committedAt"];
const publication = value => Object.fromEntries(publicationKeys.map(key => [key, value?.[key]]));
const validPublication = value => value?.mode === "active-generation"
  && SHA.test(value?.manifestHash || "") && value?.generationId === `g-${value.manifestHash}`
  && typeof value?.sourceCycleId === "string" && value.sourceCycleId.length > 0
  && Number.isFinite(Date.parse(value?.committedAt));

function auditOnlineExport(directory) {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "online-validation-inputs-receipt.json"), "utf8"));
  const blockers = [];
  const reject = (condition, code) => { if (!condition) blockers.push(code); };
  reject(receipt.version === "online-validation-inputs-v1", "receipt-version-invalid");
  reject(receipt.productionWrites === false && receipt.sameSnapshot === true, "read-only-snapshot-unproven");
  reject(receipt.source === "online-immutable-active-generation" && validPublication(receipt.publication), "publication-provenance-invalid");
  for (const phase of ["healthBefore", "healthAfter"]) reject(
    isDeepStrictEqual(publication(receipt[phase]?.publication), publication(receipt.publication)), `${phase}-publication-mismatch`);
  const entries = Array.isArray(receipt.files) ? receipt.files : [];
  const fileChecks = REQUIRED_FILES.map(name => {
    const matching = entries.filter(entry => entry.name === name);
    const entry = matching[0];
    let bytes;
    try { bytes = fs.readFileSync(path.join(directory, name)); } catch { /* missing input is a blocker */ }
    const integrity = matching.length === 1 && Boolean(bytes) && SHA.test(entry?.sha256 || "")
      && bytes.length === entry.bytes && hash(bytes) === entry.sha256;
    const provenance = entry?.provenance;
    const bound = provenance?.source === receipt.source
      && provenance?.generationId === receipt.publication?.generationId
      && provenance?.manifestHash === receipt.publication?.manifestHash
      && provenance?.manifestEntry?.path === name
      && provenance?.manifestEntry?.sha256 === entry?.sha256
      && provenance?.manifestEntry?.bytes === entry?.bytes;
    reject(integrity && bound, `${name}-integrity-or-binding-invalid`);
    let jsonValid = false;
    try { JSON.parse(bytes); jsonValid = true; } catch { /* hash does not prove JSON validity */ }
    reject(jsonValid, `${name}-json-invalid`);
    return { name, integrity, bound, jsonValid };
  });
  return { ok: blockers.length === 0, blockers, fileChecks, publication: publication(receipt.publication),
    scope: "Historical online export integrity, not current source readiness or live API parity",
    productionWrites: 0, deploymentAuthorized: false };
}

function auditContinuity(before, after, { nowMs, maxAgeMs = 15 * 60_000 } = {}) {
  const blockers = [];
  const reject = (condition, code) => { if (!condition) blockers.push(code); };
  reject(Number.isFinite(nowMs) && Number.isFinite(maxAgeMs) && maxAgeMs > 0, "observation-clock-invalid");
  for (const [name, value] of [["before", before], ["after", after]]) {
    const at = Date.parse(value?.observedAt);
    reject(Number.isFinite(at) && at <= nowMs && nowMs - at <= maxAgeMs, `${name}-observation-stale-or-invalid`);
    reject(value?.productionWrites === 0 && value?.ok === true, `${name}-read-only-capture-unproven`);
    const state = value?.frontendState;
    reject(state?.version === "frontend-release-state-v1" && state?.phase === "accepted" && ["frontend-only", "full"].includes(state?.kind)
      && ["runtimeSha256", "frontendSha256", "indexSha256", "distTreeHash", "acceptanceSha256"].every(key => SHA.test(state?.[key] || ""))
      && Number.isSafeInteger(state?.runtimeSequence) && state.runtimeSequence > 0
      && Number.isSafeInteger(state?.frontendSequence) && state.frontendSequence > 0
      && (state.kind === "full" ? state.frontendSequence === state.runtimeSequence && state.frontendSha256 === state.runtimeSha256
        : state.frontendSequence > state.runtimeSequence), `${name}-frontend-identity-invalid`);
    reject(value?.localIndexSha256 === state?.indexSha256 && value?.publicIndexSha256 === state?.indexSha256
      && SHA.test(value?.publicIndexSha256 || ""), `${name}-index-mismatch`);
    reject(value?.markers?.[".release-bundle-sha256"] === state?.runtimeSha256
      && value?.markers?.[".release-live-complete"] === state?.runtimeSha256, `${name}-runtime-marker-mismatch`);
    for (const health of [value?.health, value?.publicHealth]) {
      reject(health?.serviceOk === true && health?.readSource === "postgres" && health?.postgresAvailable === true
        && health?.postgresBaseReady === true && validPublication(health?.publication)
        && isDeepStrictEqual(publication(health?.publication), publication(value?.baselinePublication)), `${name}-health-publication-invalid`);
      reject(health?.frontendRelease?.available === true && health?.frontendRelease?.consistent === true
        && Object.keys(state || {}).every(key => health?.frontendRelease?.[key] === state[key]), `${name}-health-frontend-mismatch`);
    }
  }
  reject(Date.parse(after?.observedAt) >= Date.parse(before?.observedAt), "observation-order-invalid");
  reject(validPublication(before?.baselinePublication)
    && isDeepStrictEqual(publication(before?.baselinePublication), publication(after?.baselinePublication)), "publication-changed");
  for (const service of ["football-predict.service", "football-sync-worker.service", "nginx.service"]) {
    const a = before?.services?.[service], b = after?.services?.[service];
    reject(a?.ActiveState === "active" && b?.ActiveState === "active" && /^[1-9][0-9]*$/.test(a?.MainPID || "")
      && a.MainPID === b.MainPID && Boolean(a.ExecMainStartTimestamp) && a.ExecMainStartTimestamp === b.ExecMainStartTimestamp,
    `${service}-process-changed-or-missing`);
    if (service !== "nginx.service") reject(a?.scriptMatches === true && b?.scriptMatches === true
      && a?.fixedNodeMatches === true && b?.fixedNodeMatches === true && /^[1-9][0-9]*$/.test(a?.processStartTicks || "")
      && a.processStartTicks === b.processStartTicks && SHA.test(a?.cmdlineSha256 || "") && a.cmdlineSha256 === b.cmdlineSha256,
    `${service}-identity-changed-or-missing`);
  }
  reject(SHA.test(before?.bindingSha256 || "") && before.bindingSha256 === after?.bindingSha256, "runtime-binding-changed-or-missing");
  reject(isDeepStrictEqual(before?.markers, after?.markers), "runtime-markers-changed");
  return { ok: blockers.length === 0, blockers, productionWrites: 0, deploymentAuthorized: false,
    scope: "Read-only continuity supplement; signed asset/acceptance verification and required lane gates remain mandatory" };
}

// Compare fields visible on both API projections. Missing-on-both is reported as
// unavailable, never counted as successful probability or decision-version coverage.
function auditProjection(list, detail, nowMs) {
  const base = compareRecommendationProjectionPair(list, detail, nowMs);
  const blockers = [...base.reasons], unavailable = [];
  if (!Number.isFinite(nowMs)) blockers.push("projection-clock-invalid");
  if (!list || !detail) blockers.push("projection-input-missing");
  const selected = row => isResultPhase(row, nowMs) ? row?.archivedPreMatchPrediction?.prediction
    : (Array.isArray(row?.predictions) ? row.predictions.find(prediction => prediction?.marketType === "BEST") : undefined);
  const a = selected(list), b = selected(detail);
  const fields = {
    modelProbability: row => row?.confidence?.publicMetrics?.modelProbability,
    frozenVersion: row => row?.frozenVersion,
  };
  for (const [name, pick] of Object.entries(fields)) {
    const left = pick(a), right = pick(b);
    if (left == null && right == null) unavailable.push(name);
    else if (!isDeepStrictEqual(left, right)) blockers.push(`${name}-projection-mismatch`);
    if (name === "modelProbability") for (const value of [left, right]) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) blockers.push("modelProbability-invalid");
    }
    if (name === "frozenVersion") for (const [value, prediction] of [[left, a], [right, b]]) {
      if (value != null && !compactFrozenReviewVersion(value, prediction)) blockers.push("frozenVersion-invalid");
    }
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], unavailable,
    probabilityCovered: !unavailable.includes("modelProbability") && !blockers.some(code => code.startsWith("modelProbability")),
    decisionVersionCovered: !unavailable.includes("frozenVersion") && !blockers.some(code => code.startsWith("frozenVersion")) };
}

module.exports = { auditOnlineExport, auditContinuity, auditProjection };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/releaseQualityEvidence.cjs <online-export-directory>");
    const result = auditOnlineExport(path.resolve(process.argv[2]));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ ok: false, blocker: "export-input-unreadable", productionWrites: 0, deploymentAuthorized: false })); process.exitCode = 1; }
}
