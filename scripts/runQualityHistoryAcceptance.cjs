"use strict";
// Local acceptance runner; outputs only inside this quality worktree's outputs.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { loadHistoryBundle, auditHistory } = require("./qualityHistoryRegressionEvidence.cjs");
const root = path.resolve(__dirname, "..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function run(historyRoot, implementationRoot, outputDirectory) {
  const out = path.resolve(outputDirectory);
  if (!out.startsWith(path.join(root, "outputs") + path.sep)) throw new Error("OUTPUT_MUST_BE_IN_QUALITY_WORKTREE");
  if (fs.existsSync(out)) throw new Error("OUTPUT_ALREADY_EXISTS_USE_NEW_DIRECTORY");
  const before = loadHistoryBundle(historyRoot, implementationRoot);
  const { FRONTEND_PATHS, POLICY_HASH } = require(path.join(path.resolve(implementationRoot), "scripts/releaseChangeClassification.cjs"));
  const report = { ...auditHistory(before.bundle, before.interfaces.admission), verifiedAt: new Date().toISOString(), proof: before.proof };
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(root, "tests/quality-history-interface.test.cjs")], {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: { ...process.env,
      QUALITY_HISTORY_EVIDENCE_ROOT: path.resolve(historyRoot), QUALITY_HISTORY_IMPLEMENTATION_ROOT: path.resolve(implementationRoot) } });
  const after = loadHistoryBundle(historyRoot, implementationRoot);
  const implementationStable = before.proof.implementationHead === after.proof.implementationHead
    && isDeepStrictEqual(before.proof.implementationFiles, after.proof.implementationFiles);
  const evidenceStable = before.proof.receiptSha256 === after.proof.receiptSha256 && isDeepStrictEqual(before.proof.fileProofs, after.proof.fileProofs);
  const count = name => Number((result.stdout?.match(new RegExp(`# ${name} ([0-9]+)`)) || [])[1]);
  const receipt = { version: "quality-history-acceptance-receipt-v1", verifiedAt: new Date().toISOString(), historyCommit: before.proof.historyCommit,
    implementationHead: before.proof.implementationHead, implementationStable, evidenceStable,
    implementationCommitted: !before.proof.implementationTrackedDirty && !after.proof.implementationTrackedDirty,
    realEvidenceChecks: report.checks.length, realEvidencePassed: report.ok, sourceRows: report.sourceRows, pairedRows: report.pairedRows,
    tests: { total: count("tests"), passed: count("pass"), failed: count("fail"), exitCode: result.status },
    interfaceAcceptancePassed: result.status === 0, historicalPublished145Reproduced: false, prospectiveConfirmation: false,
    uiFrontendLaneBlocker: { publicBrowseAllowed: FRONTEND_PATHS.includes("src/pages/PublicBrowse.tsx"),
      publicBrowseCssAllowed: FRONTEND_PATHS.includes("src/styles/public-browse.css"), policyHash: POLICY_HASH,
      boundaryRelaxed: false, meaning: "These new UI paths require the existing full release process; this task does not expand the frontend lane" },
    productionWrites: 0, productionEligible: false, deploymentAuthorized: false };
  receipt.ok = report.ok && result.status === 0 && implementationStable && evidenceStable && receipt.implementationCommitted;
  fs.mkdirSync(out, { recursive: true });
  const files = { "independent-evidence.json": Buffer.from(JSON.stringify(report, null, 2) + "\n"),
    "interface-tests.tap": Buffer.from((result.stdout || "") + (result.stderr || "")) };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(out, name), bytes, { flag: "wx" });
  receipt.files = Object.entries(files).map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha(bytes) }));
  receipt.validatorFiles = ["scripts/qualityHistoryRegressionEvidence.cjs", "scripts/runQualityHistoryAcceptance.cjs", "tests/quality-history-interface.test.cjs"]
    .map(file => ({ file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
  fs.writeFileSync(path.join(out, "acceptance-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}
module.exports = { run };
if (require.main === module) {
  try {
    if (process.argv.length !== 5) throw new Error("Usage: node scripts/runQualityHistoryAcceptance.cjs HISTORY_ROOT IMPLEMENTATION_ROOT NEW_OUTPUT_DIRECTORY");
    const receipt = run(...process.argv.slice(2)); console.log(JSON.stringify(receipt, null, 2)); if (!receipt.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, blocker: error.message, productionWrites: 0, deploymentAuthorized: false })); process.exitCode = 1; }
}
