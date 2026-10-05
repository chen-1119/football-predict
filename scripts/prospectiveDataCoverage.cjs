"use strict";

// Diagnostic coverage and local, immutable field receipts. No model admission,
// network request, production write, or frozen-history amendment takes place.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { analyzeCapture } = require("./historyRegressionAdmission.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const VERSION = "prospective-data-coverage-v1";
const RECEIPT_VERSION = "prospective-field-receipt-v1";
const FIELDS = Object.freeze(["elo", "form", "poisson", "leaguePrior", "lineup", "injuries", "weather", "xg", "scheduleDensity"]);
const CLOCKS = Object.freeze(["providerObservedAt", "receivedAt", "availableAt"]);
const OUTPUT_ROOT = path.resolve(__dirname, "../outputs");
const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ensure = (condition, code) => { if (!condition) throw Error(code); };
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encoded = value => JSON.stringify(canonical(value));
function instant(value) {
  ensure(strictInstant(value) !== null, "STRICT_CLOCK_REQUIRED");
  const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || "";
  return BigInt(Date.parse(value.replace(/\.\d{1,9}(?=Z|[+-]\d{2}:\d{2}$)/, ""))) * 1000000n
    + BigInt(fraction.padEnd(9, "0"));
}
function safeOutput(file) {
  const target = path.resolve(file);
  ensure(target.startsWith(OUTPUT_ROOT + path.sep), "OUTPUT_MUST_BE_INSIDE_WORKTREE_OUTPUTS");
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  ensure(fs.realpathSync(parent).startsWith(fs.realpathSync(OUTPUT_ROOT) + path.sep)
    || fs.realpathSync(parent) === fs.realpathSync(OUTPUT_ROOT), "OUTPUT_SYMLINK_ESCAPE");
  if (fs.existsSync(target)) ensure(!fs.lstatSync(target).isSymbolicLink(), "OUTPUT_SYMLINK_FORBIDDEN");
  return target;
}
function readBounded(file, limit) {
  const stat = fs.lstatSync(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, "INPUT_FILE_BOUND");
  return fs.readFileSync(file);
}
function extract(payload, pointer) {
  ensure(typeof pointer === "string" && pointer.startsWith("/") && pointer.length <= 1024, "FIELD_POINTER_REQUIRED");
  let value = payload;
  for (const part of pointer.slice(1).split("/")) {
    ensure(!/~(?:[^01]|$)/.test(part), "INVALID_JSON_POINTER");
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    ensure(value !== null && typeof value === "object" && Object.hasOwn(value, key), "FIELD_POINTER_NOT_FOUND");
    value = value[key];
  }
  ensure(value !== null, "FIELD_VALUE_MISSING");
  return value;
}
function validateEvidence(metadata, payloadBytes, retainedAt) {
  ensure(metadata?.version === "prospective-field-evidence-v1", "EVIDENCE_VERSION_REQUIRED");
  ensure(["online-source-response", "synthetic-test"].includes(metadata.evidenceKind), "EVIDENCE_KIND_REQUIRED");
  ensure(FIELDS.includes(metadata.field), "UNREVIEWED_FIELD");
  ensure(Buffer.isBuffer(payloadBytes) && payloadBytes.length > 0 && payloadBytes.length <= 4 * 1024 * 1024, "PAYLOAD_BOUND");
  ensure(HASH.test(metadata.payloadSha256 || "") && sha(payloadBytes) === metadata.payloadSha256, "PAYLOAD_HASH_MISMATCH");
  const event = metadata.event, source = metadata.source, mapping = metadata.identityMapping;
  ensure(text(event?.sourceMatchId) && text(event?.sourceCycleId), "EVENT_IDENTITY_REQUIRED");
  ensure(text(source?.providerId) && text(source?.providerEventId), "PROVIDER_IDENTITY_REQUIRED");
  let sourceUrl;
  try { sourceUrl = new URL(source.url); } catch { throw Error("SOURCE_URL_REQUIRED"); }
  ensure(sourceUrl.protocol === "https:" && !sourceUrl.username && !sourceUrl.password, "SOURCE_URL_REQUIRED");
  const authorization = source.authorization;
  ensure(authorization?.status === "allowed" && ["official-public-data", "license", "explicit-permission"].includes(authorization.basis)
    && text(authorization.reference), "DECLARED_SOURCE_AUTHORIZATION_REQUIRED");
  ensure(mapping?.sourceMatchId === event.sourceMatchId && mapping?.providerEventId === source.providerEventId
    && HASH.test(mapping?.evidenceSha256 || "") && text(mapping?.reference), "DECLARED_EVENT_MAPPING_REQUIRED");
  const times = Object.fromEntries(CLOCKS.map(key => [key, instant(metadata[key])]));
  const at = instant(retainedAt), decision = instant(event.decisionAt), cutoff = instant(event.cutoffAt), kickoff = instant(event.kickoffAt);
  ensure(times.providerObservedAt <= times.receivedAt && times.receivedAt <= times.availableAt, "FIELD_CLOCK_ORDER_INVALID");
  ensure(times.availableAt <= at && at <= decision && decision <= cutoff && decision < kickoff && cutoff <= kickoff,
    "NOT_RETAINED_BEFORE_DECISION_AND_CUTOFF");
  if (Object.hasOwn(metadata, "observedAt")) {
    const observed = instant(metadata.observedAt);
    ensure(times.providerObservedAt <= observed && observed <= times.receivedAt, "OPTIONAL_CLOCK_ORDER_INVALID");
  }
  ensure(text(metadata.valueSemantics), "VALUE_SEMANTICS_REQUIRED");
  if (metadata.field === "xg") {
    ensure(metadata.valueSemantics === "provider-reported-historical-xg", "MARKET_LAMBDA_IS_NOT_OBSERVED_XG");
    ensure(instant(metadata.historicalPeriodEndAt) <= times.providerObservedAt, "XG_HISTORICAL_PERIOD_INVALID");
  }
  if (metadata.supersedesEvidenceId !== undefined) ensure(HASH.test(metadata.supersedesEvidenceId), "SUPERSEDES_ID_INVALID");
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(payloadBytes)); } catch { throw Error("PAYLOAD_JSON_REQUIRED"); }
  const value = extract(payload, metadata.valuePointer);
  return { valueSha256: sha(encoded(value)), payloadSha256: sha(payloadBytes), payloadBytes: payloadBytes.length };
}
function readReceipt(file, expectedId) {
  const receipt = JSON.parse(readBounded(file, 6 * 1024 * 1024));
  const { receiptSha256, ...body } = receipt;
  ensure(HASH.test(receiptSha256 || "") && sha(encoded(body)) === receiptSha256, "EXISTING_RECEIPT_HASH_MISMATCH");
  ensure(receipt.version === RECEIPT_VERSION && receipt.evidenceId === expectedId
    && sha(encoded(receipt.metadata)) === expectedId && receipt.candidateEligible === false
    && Number.isSafeInteger(receipt.revision) && receipt.revision >= 1, "EXISTING_RECEIPT_INVALID");
  const bytes = Buffer.from(receipt.payloadBase64, "base64");
  const facts = validateEvidence(receipt.metadata, bytes, receipt.retainedAt);
  ensure(encoded(facts) === encoded(receipt.payload), "EXISTING_RECEIPT_PAYLOAD_MISMATCH");
  return receipt;
}
function retainEvidence(metadata, payloadBytes, directory, { now = () => new Date().toISOString() } = {}) {
  const evidenceId = sha(encoded(metadata));
  const file = safeOutput(path.join(directory, evidenceId + ".json"));
  if (fs.existsSync(file)) {
    const previous = readReceipt(file, evidenceId);
    ensure(encoded(previous.metadata) === encoded(metadata) && previous.payloadBase64 === payloadBytes.toString("base64"), "DUPLICATE_RECEIPT_CONFLICT");
    return { evidenceId, path: file, duplicate: true, retainedAt: previous.retainedAt, candidateEligible: false };
  }
  const retainedAt = now();
  const payload = validateEvidence(metadata, payloadBytes, retainedAt);
  let revision = 1;
  let supersedesReceiptSha256 = null;
  if (metadata.supersedesEvidenceId) {
    const previous = readReceipt(safeOutput(path.join(directory, metadata.supersedesEvidenceId + ".json")), metadata.supersedesEvidenceId);
    ensure(previous.metadata.field === metadata.field && previous.metadata.source.providerId === metadata.source.providerId
      && previous.metadata.source.providerEventId === metadata.source.providerEventId
      && previous.metadata.event.sourceMatchId === metadata.event.sourceMatchId
      && previous.metadata.event.kickoffAt === metadata.event.kickoffAt, "CORRECTION_IDENTITY_MISMATCH");
    revision = previous.revision + 1;
    supersedesReceiptSha256 = previous.receiptSha256;
  }
  const receipt = { version: RECEIPT_VERSION, evidenceId, revision, retainedAt, supersedesReceiptSha256, metadata, payload,
    payloadBase64: payloadBytes.toString("base64"), candidateEligible: false, productionWrites: false,
    trust: { providerAuthorization: "declared-not-independently-verified", eventMapping: "declared-not-independently-verified",
      extractionSemantics: "requires-provider-adapter-review", collectorAttestation: "not-attached", clockTrust: "local-host-clock-only" },
    nextGate: "Existing signed collector, source authorization, event mapping and candidate admission must approve before model use." };
  receipt.receiptSha256 = sha(encoded(receipt));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    readReceipt(file, evidenceId);
    return { evidenceId, path: file, duplicate: true, candidateEligible: false };
  }
  return { evidenceId, path: file, duplicate: false, retainedAt, candidateEligible: false };
}
function fieldDiagnostic(snapshot, inspection, name) {
  const group = inspection.record.features.groups[name], raw = snapshot?.featureSnapshot?.modelInputs?.[name];
  const snapshotEvidenceMissing = !inspection.record.features.present;
  const capturedAt = snapshot?.featureSnapshot?.capturedAt, decisionAt = inspection.record.decision?.at;
  const frozenBoundBeforeDecision = group.available && strictInstant(capturedAt) !== null && strictInstant(decisionAt) !== null
    && instant(capturedAt) <= instant(decisionAt);
  const clocks = Object.fromEntries(CLOCKS.map(key => [key, strictInstant(raw?.[key]) !== null]));
  const requirements = ["provider identity and authorized use", "event mapping evidence", "original payload bytes and SHA-256",
    "providerObservedAt <= receivedAt <= availableAt <= decisionAt", "local retention before decision and cutoff", "reviewed extraction and value semantics"];
  const action = group.exportOmitted ? "restore-bounded-export-evidence"
    : snapshotEvidenceMissing ? "retain-future-frozen-feature-snapshot"
    : !group.valuePresent ? "collect-future-prematch-field"
    : !frozenBoundBeforeDecision ? "repair-future-snapshot-binding-and-clock"
    : "retain-field-provenance-at-next-collection";
  return { frozenStatus: group.status, valuePresent: group.valuePresent, frozenBoundBeforeDecision,
    exportOmitted: group.exportOmitted, snapshotEvidenceMissing,
    sourceSnapshotMissing: !snapshotEvidenceMissing && group.status === "source-snapshot-field-missing",
    declaredProvider: text(raw?.source) ? raw.source : null, fieldClockPresent: clocks,
    payloadHashPresent: HASH.test(raw?.payloadSha256 || ""), candidateEligible: false, action, requirements };
}
function coverageReport(capture, priorReceipt, rawResponseBytes) {
  ensure(priorReceipt?.version === "online-validation-inputs-v1" && priorReceipt.productionWrites === false
    && priorReceipt.sameSnapshot === true && priorReceipt.source === "online-immutable-active-generation"
    && priorReceipt.publication && HASH.test(priorReceipt.manifestFileSha256 || ""), "PRIOR_ONLINE_RECEIPT_REQUIRED");
  const admission = analyzeCapture(capture, { rawResponseBytes, expectedPublication: priorReceipt.publication,
    expectedManifestFileSha256: priorReceipt.manifestFileSha256 });
  const rows = admission.inspections.map((inspection, index) => ({ matchId: inspection.record.matchId,
    kickoffAt: inspection.record.kickoffAt, decisionAt: inspection.record.decision.at,
    pairedEligible: inspection.pairedEligible, frozenProbabilityScorable: inspection.originalEligible,
    historicalBackfillPermitted: false, fields: Object.fromEntries(FIELDS.map(name => [name, fieldDiagnostic(capture.rows[index].snapshot, inspection, name)])) }));
  const summarize = selected => Object.fromEntries(FIELDS.map(name => {
    const diagnostics = selected.map(row => row.fields[name]);
    const count = key => diagnostics.filter(item => item[key]).length;
    return [name, { rows: selected.length, valuePresent: count("valuePresent"), frozenBoundBeforeDecision: count("frozenBoundBeforeDecision"),
      exportOmitted: count("exportOmitted"), sourceSnapshotMissing: count("sourceSnapshotMissing"),
      snapshotEvidenceMissing: count("snapshotEvidenceMissing"),
      declaredProvider: count("declaredProvider"), payloadHashPresent: count("payloadHashPresent"),
      fieldClocks: Object.fromEntries(CLOCKS.map(key => [key, diagnostics.filter(item => item.fieldClockPresent[key]).length])),
      candidateEligible: 0, actions: Object.fromEntries([...new Set(diagnostics.map(item => item.action))].sort()
        .map(action => [action, diagnostics.filter(item => item.action === action).length])) }];
  }));
  return { version: VERSION, source: admission.source, productionWrites: false, productionEligible: false,
    statisticsMeaning: "Exported frozen evidence only; absence does not prove upstream providers have no data. No accuracy uplift is claimed.",
    funnel: { selected: rows.length, frozenProbabilityScorable: admission.originalRecords.length, sameDecisionPaired: admission.records.length,
      frozenProbabilityCoverage: rows.length ? admission.originalRecords.length / rows.length : null,
      sameDecisionPairedCoverage: rows.length ? admission.records.length / rows.length : null, featureReplayEligible: 0 },
    cohorts: { allSelected: summarize(rows), sameDecisionPaired: summarize(rows.filter(row => row.pairedEligible)) }, rows,
    collectionContract: { metadataVersion: "prospective-field-evidence-v1", fields: FIELDS, requiredClocks: CLOCKS,
      identity: "providerEventId mapped to sourceMatchId with explicit mapping reference/hash and kickoff",
      authorization: "explicit source authorization declaration retained; independent review still required",
      cutoff: "retainedAt <= decisionAt <= cutoffAt <= kickoffAt; decisionAt < kickoffAt",
      correction: "new content-addressed receipt with supersedesEvidenceId; never overwrite old evidence",
      xg: "provider-reported-historical-xg with historicalPeriodEndAt; market-implied lambda is not xG",
      modelAdmission: false },
    nextActions: [
      { priority: 1, action: "Fix future decision-clock lineage and keep first trusted result observation; never backdate old records." },
      { priority: 2, action: "Recover export-omitted feature bytes from the same immutable source generation before classifying the source as missing." },
      { priority: 3, action: "Retain future field receipts at collection time, then review authorization, mapping, attestation and extraction." },
      { priority: 4, action: "Only link verified receipts into a new frozen decision; old decisions and recommendation statistics remain immutable." },
    ] };
}
function main(argv) {
  if (argv[0] === "retain" && argv.length === 4) {
    const metadata = JSON.parse(readBounded(argv[1], 65536)), payload = readBounded(argv[2], 4 * 1024 * 1024);
    return retainEvidence(metadata, payload, argv[3]);
  }
  if (argv[0] === "report" && argv.length === 5) {
    const [, captureFile, priorFile, rawFile, outputFile] = argv;
    const capture = readBounded(captureFile, 32 * 1024 * 1024), prior = readBounded(priorFile, 4 * 1024 * 1024);
    const raw = readBounded(rawFile, 10 * 1024 * 1024 + 1), output = safeOutput(outputFile);
    ensure(![captureFile, priorFile, rawFile].some(file => path.resolve(file) === output), "OUTPUT_OVERLAPS_INPUT");
    const report = coverageReport(JSON.parse(capture), JSON.parse(prior), raw);
    report.inputs = [{ path: path.resolve(captureFile), sha256: sha(capture) }, { path: path.resolve(priorFile), sha256: sha(prior) },
      { path: path.resolve(rawFile), sha256: sha(raw) }];
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    return { output, funnel: report.funnel, fields: report.cohorts.allSelected };
  }
  throw Error("Usage: prospectiveDataCoverage.cjs report CAPTURE PRIOR_RECEIPT RAW_RESPONSE NEW_OUTPUT | retain METADATA RAW_JSON OUTPUT_DIRECTORY");
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { FIELDS, CLOCKS, VERSION, instant, extract, validateEvidence, retainEvidence, readReceipt, coverageReport, fieldDiagnostic, main };
