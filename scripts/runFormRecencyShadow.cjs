"use strict";
// Offline receipt-bound form-stage counterfactuals. No public direction changes.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { POLICY, POLICY_HASH, buildFormRecencyShadowInput } = require("./formRecencyShadow.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { verifyModelInputUsage, summarizeModelInputUsage } = require("../src/services/modelInputUsage.cjs");
const { blendLambdasWithForm } = require("./syncData.cjs");
const root = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const arithmetic = receipt => ({ before: receipt.before, candidates: receipt.candidates, weight: receipt.weight, output: receipt.output });
function evaluateRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { excluded: { id: null, reason: "invalid-match-row" } };
  const model = row.probabilityModel, evaluatedAt = model?.generatedAt;
  const receipts = Array.isArray(model?.inputUsage) ? model.inputUsage : [];
  const receipt = receipts.find(value => value?.stage === "form-lambda-blend");
  if (!receipt) return { excluded: { id: row.id, reason: "original-form-arithmetic-receipt-missing" } };
  if (!strictInstant(evaluatedAt) || !strictInstant(row.kickoffTime) || Date.parse(evaluatedAt) >= Date.parse(row.kickoffTime)
    || !receipts.every(value => value && strictInstant(value.recordedAt) && strictInstant(value.kickoffTime))
    || !verifyModelInputUsage(receipt) || !summarizeModelInputUsage(model, row)) {
    return { excluded: { id: row.id, reason: "original-form-receipt-or-model-binding-invalid" } };
  }
  // Published rows omit formSnapshot. Reconstruct only this stage's input from
  // stored model form, then require exact old arithmetic replay. This is NOT
  // reconstruction of the full initial prediction pipeline.
  const stageInput = structuredClone(row);
  if (model.form) stageInput.formSnapshot = structuredClone(model.form);
  else delete stageInput.formSnapshot;
  const originalHash = hash(JSON.stringify(row));
  const baseline = blendLambdasWithForm(stageInput, receipt.before.home, receipt.before.away);
  if (JSON.stringify(arithmetic(baseline.formUsage)) !== JSON.stringify(arithmetic(receipt))) {
    return { excluded: { id: row.id, reason: "original-form-arithmetic-replay-mismatch" } };
  }
  const shadow = buildFormRecencyShadowInput(stageInput, evaluatedAt);
  const alternative = blendLambdasWithForm(shadow.input, receipt.before.home, receipt.before.away);
  assert.ok(verifyModelInputUsage(alternative.formUsage));
  assert.equal(hash(JSON.stringify(row)), originalHash);
  return { result: { id: row.id, sourceMatchId: row.sourceMatchId, eventVersion: row.eventVersion || row.kickoffTime,
    audit: shadow.audit, originalReceiptHash: receipt.contentHash, originalArithmeticReplayMatched: true,
    baseline: arithmetic(receipt), alternative: arithmetic(alternative.formUsage),
    lambdaDelta: { home: alternative.homeLambda - baseline.homeLambda, away: alternative.awayLambda - baseline.awayLambda },
    originalPublicRecordHash: row.predictionMeta?.publicReferenceDecision?.contentHash || null,
    originalPublishedDirection: row.predictionMeta?.publicReferenceDecision?.prediction?.tipCode || null,
    originalInputHash: originalHash } };
}
function run(inputFile, outputFile) {
  const input = path.resolve(inputFile), output = path.resolve(outputFile), outputs = path.join(root, "outputs");
  const relative = path.relative(outputs, output);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && output.endsWith(".json"), "output must be a new JSON inside this worktree outputs");
  assert.equal(fs.existsSync(output), false, "existing research output must not be overwritten");
  const stat = fs.lstatSync(input); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, "bounded fixture input required");
  const bytes = fs.readFileSync(input), rows = JSON.parse(bytes); assert.ok(Array.isArray(rows) && rows.length <= 500);
  const implementationFiles = [__filename, path.join(__dirname, "formRecencyShadow.cjs"), path.join(__dirname, "syncData.cjs"), path.join(__dirname, "competitionModelContext.cjs"), path.join(root, "src/services/modelInputUsage.cjs"), path.join(root, "src/services/strictInstant.cjs")];
  const implementation = implementationFiles.map(file => ({ file: path.relative(root, file).replaceAll("\\", "/"), sha256: hash(fs.readFileSync(file)) }));
  const seen = new Set(), excluded = [], reports = [];
  for (const row of rows) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row) && (row.sourceMatchId || row.id), "identified match object required");
    const identity = `${row.sourceMatchId || row.id}|${row.eventVersion || row.kickoffTime}`;
    assert.ok(!seen.has(identity), "duplicate event in shadow input"); seen.add(identity);
    const evaluated = evaluateRow(row);
    if (evaluated.excluded) excluded.push(evaluated.excluded); else reports.push(evaluated.result);
  }
  assert.equal(hash(fs.readFileSync(input)), hash(bytes));
  assert.ok(implementation.every(entry => hash(fs.readFileSync(path.join(root, entry.file))) === entry.sha256));
  const body = { version: "form-recency-shadow-run-v2-receipt-bound", policy: POLICY, policyHash: POLICY_HASH,
    inputSha256: hash(bytes), implementation, productionEligible: false, nominationAllowed: false,
    scope: "exact original form-stage replay, then clock-filtered stage counterfactual; NOT full model ablation, public forecast replay, hit rate or source attestation",
    summary: { total: rows.length, evaluated: reports.length, excluded: excluded.length,
      inputFiltered: reports.filter(row => row.audit.removedSources.length).length,
      fullFormWeightRemoved: reports.filter(row => row.baseline.weight > 0 && row.alternative.weight === 0).length },
    excluded, rows: reports, originalFileUnchanged: true, productionWrites: 0, providerRequests: 0 };
  const result = { ...body, manifestHash: hash(JSON.stringify(body)) };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { ok: true, output, summary: result.summary, manifestHash: result.manifestHash, productionWrites: 0, providerRequests: 0 };
}
module.exports = { evaluateRow, run };
if (require.main === module) {
  try { assert.equal(process.argv.length, 4, "usage: node runFormRecencyShadow.cjs INPUT OUTPUT"); console.log(JSON.stringify(run(...process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
