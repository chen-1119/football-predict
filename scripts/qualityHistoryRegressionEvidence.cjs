"use strict";
// Independent local acceptance. No fitting, exporter, production I/O or promotion.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const CLASSES = ["home", "draw", "away"];
const HISTORY_COMMIT = "2d20938a13463294977696cc2fcef92bc746c902";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const objectHash = value => sha(JSON.stringify(value));
const eventKey = row => `${row.matchId}|${row.market}`;
const sortedKeys = rows => rows.map(eventKey).sort();
const time = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const day = row => new Date(time(row.kickoffAt) + 480 * 60_000).toISOString().slice(0, 10);
const boundary = date => Date.parse(`${date}T00:00:00+08:00`);
const inWindow = (row, window) => day(row) >= window.start && day(row) < window.end;
const decisionBoundary = (rows, window) => Math.min(boundary(window.start), ...rows.map(row => time(row.decision.at)));

function independentMetrics(records, kind) {
  const totals = { brier: 0, logLoss: 0, accuracy: 0 };
  const bins = Object.fromEntries(CLASSES.map(key => [key, Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, n: 0, positive: 0, sum: 0 }))]));
  for (const row of records) {
    const raw = CLASSES.map(key => kind === "publishedModel" ? row.decision.probabilities[key] : 1 / row.officialOdds.sp[key]);
    const total = raw.reduce((a, b) => a + b, 0), probabilities = raw.map(value => value / total);
    const actual = CLASSES.indexOf(row.result.outcome);
    if (actual < 0 || !probabilities.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("INVALID_SCORING_INPUT");
    totals.brier += probabilities.reduce((sum, p, index) => sum + (p - Number(index === actual)) ** 2, 0);
    totals.logLoss -= Math.log(Math.max(1e-15, probabilities[actual]));
    totals.accuracy += Number(probabilities.indexOf(Math.max(...probabilities)) === actual);
    probabilities.forEach((p, index) => { const bin = bins[CLASSES[index]][Math.min(9, Math.floor(p * 10))]; bin.n++; bin.sum += p; bin.positive += Number(index === actual); });
  }
  for (const values of Object.values(bins)) for (const bin of values) {
    bin.meanProbability = bin.n ? bin.sum / bin.n : null; bin.observedFrequency = bin.n ? bin.positive / bin.n : null; delete bin.sum;
  }
  return { n: records.length, denominator: records.length, coverage: records.length ? 1 : null,
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, records.length ? value / records.length : null])), reliability: bins };
}
function near(left, right) {
  if (typeof left === "number" || typeof right === "number") return typeof left === "number" && typeof right === "number" && Math.abs(left - right) < 1e-12;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  return isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort()) && Object.keys(left).every(key => near(left[key], right[key]));
}
function independentPairedInterval(records, options) {
  const grouped = new Map();
  for (const row of records) {
    const date = day(row), block = grouped.get(date) || { n: 0, brier: 0, logLoss: 0, accuracy: 0 };
    const model = independentMetrics([row], "publishedModel"), market = independentMetrics([row], "sameDecisionMarket");
    block.n++; for (const metric of ["brier", "logLoss", "accuracy"]) block[metric] += model[metric] - market[metric];
    grouped.set(date, block);
  }
  const blocks = [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([date, sums]) => ({ date, ...sums }));
  const iterations = options.iterations || 2000, seed = options.seed ?? 104729;
  const minRows = options.minRows ?? 30, minBlocks = options.minBlocks ?? 10;
  const available = blocks.length >= minBlocks && records.length >= minRows;
  const metrics = Object.fromEntries(["brier", "logLoss", "accuracy"].map(metric => [metric, {
    delta: records.length ? blocks.reduce((total, block) => total + block[metric], 0) / records.length : null, interval: null }]));
  if (available) {
    let state = seed || 1;
    const samples = { brier: [], logLoss: [], accuracy: [] };
    for (let i = 0; i < iterations; i++) {
      const sums = { n: 0, brier: 0, logLoss: 0, accuracy: 0 };
      for (let draw = 0; draw < blocks.length; draw++) {
        state = (state ^ (state << 13)) >>> 0; state = (state ^ (state >>> 17)) >>> 0; state = (state ^ (state << 5)) >>> 0;
        const block = blocks[Math.floor(state / 4294967296 * blocks.length)];
        for (const key of Object.keys(sums)) sums[key] += block[key];
      }
      for (const key of Object.keys(samples)) samples[key].push(sums[key] / sums.n);
    }
    for (const [metric, values] of Object.entries(samples)) {
      values.sort((left, right) => left - right);
      metrics[metric].interval = [values[Math.floor(iterations * 0.025)], values[Math.min(iterations - 1, Math.ceil(iterations * 0.975) - 1)]];
    }
  }
  return { pairedRows: records.length, matchDayBlocks: blocks.length, iterations, seed, minRows, minBlocks,
    intervalAvailable: available, promotionEvidence: false, metrics, blocks };
}

function auditHistory(bundle, admissionApi) {
  const { capture, admission, evidence, review, summary, replay, protocol, rawResponseBytes, prior } = bundle;
  const blockers = [], checks = [];
  const check = (name, condition) => { checks.push({ name, ok: Boolean(condition) }); if (!condition) blockers.push(name); };
  const envelope = admissionApi.verifyEnvelope(capture, { rawResponseBytes, expectedPublication: prior.publication, expectedManifestFileSha256: prior.manifestFileSha256 });
  const fresh = capture.rows.map(row => admissionApi.inspectRow(row, { collectorTrustRegistry: capture.collectorTrustRegistry, publication: capture.publication }));
  const paired = fresh.filter(row => row.pairedEligible).map(row => row.record);
  const original = fresh.filter(row => row.originalEligible).map(row => row.record);
  check("exported-events-unique", new Set(capture.rows.map(eventKey)).size === capture.rows.length);
  check("saved-admission-exactly-matches-revalidated-pairs", isDeepStrictEqual(paired, admission.records));
  check("saved-original-records-match-independent-admission", isDeepStrictEqual(original, admission.originalRecords));
  check("per-match-evidence-event-set-and-order", isDeepStrictEqual(evidence.map(row => eventKey(row.record)), capture.rows.map(eventKey)));
  check("per-match-evidence-admission-and-reasons", evidence.length === fresh.length && evidence.every((row, index) =>
    isDeepStrictEqual(row.record, fresh[index].record) && row.originalEligible === fresh[index].originalEligible
    && row.pairedEligible === fresh[index].pairedEligible && row.primaryReason === fresh[index].primaryReason && isDeepStrictEqual(row.reasons, fresh[index].reasons)));
  const counts = {}, missing = {}, featureUnavailable = {}, overlapping = {};
  for (const row of fresh) {
    counts[row.primaryReason] = (counts[row.primaryReason] || 0) + 1;
    for (const code of row.reasons) overlapping[code] = (overlapping[code] || 0) + 1;
    for (const key of row.record.features.missing) { missing[key] = (missing[key] || 0) + 1;
      const status = row.record.features.groups[key].status; featureUnavailable[status] = (featureUnavailable[status] || 0) + 1; }
  }
  const expectedFunnel = { ...capture.counts, selected: capture.rows.length, frozenProbabilityScorable: original.length,
    sameDecisionPaired: paired.length, replayFeatureEligible: 0, primaryExclusions: counts, overlappingExclusionReasons: overlapping,
    featureMissing: missing, featureUnavailability: featureUnavailable };
  check("complete-exclusion-funnel-reconciles", isDeepStrictEqual(expectedFunnel, admission.funnel) && isDeepStrictEqual(expectedFunnel, summary.funnel)
    && Object.values(counts).reduce((a, b) => a + b, 0) === capture.rows.length);
  check("selection-counts-reconcile", capture.counts.distinctSettledInWindow - capture.counts.limitExcluded === capture.rows.length
    && capture.counts.historyRows === capture.counts.outsideWindow + capture.counts.distinctSettledInWindow
      + (capture.counts.notFinished || 0) + (capture.counts.missingIdentity || 0) + (capture.counts.duplicateMatchRows || 0));
  check("feature-presence-does-not-grant-replay", fresh.every(row => row.record.features.candidateEligible === false));
  check("same-decision-odds-clocks", paired.every(row => {
    const provider = time(row.officialOdds.providerObservedAt), received = time(row.officialOdds.receivedAt), decision = time(row.decision.at), cutoff = time(row.cutoffAt);
    return [provider, received, decision, cutoff].every(Number.isFinite) && provider <= received && received <= decision && decision <= cutoff && decision < time(row.kickoffAt);
  }));
  check("paired-review-identical-events", new Set(review.perMatch.map(eventKey)).size === paired.length && isDeepStrictEqual(sortedKeys(review.perMatch), sortedKeys(paired)));
  const byId = new Map(paired.map(row => [eventKey(row), row]));
  check("model-market-same-row-probabilities-and-odds", review.perMatch.every(row => {
    const admitted = byId.get(eventKey(row)); if (!admitted) return false;
    const modelTotal = CLASSES.reduce((sum, key) => sum + admitted.decision.probabilities[key], 0);
    const marketTotal = CLASSES.reduce((sum, key) => sum + 1 / admitted.officialOdds.sp[key], 0);
    return row.inputRecordHash === objectHash(admitted) && row.decisionId === admitted.decision.id && row.decisionAt === admitted.decision.at
      && CLASSES.every(key => near(row.predictions.publishedModel[key], admitted.decision.probabilities[key] / modelTotal)
        && near(row.predictions.sameDecisionMarket[key], (1 / admitted.officialOdds.sp[key]) / marketTotal));
  }));
  const metrics = Object.fromEntries(["publishedModel", "sameDecisionMarket"].map(kind => [kind, independentMetrics(paired, kind)]));
  for (const [kind, value] of Object.entries(metrics)) check(`${kind}-metrics-and-reliability-recomputed`, near(value, review.metrics[kind]) && near(value, summary.recomputedFrozenPair.metrics[kind]));
  const interval = independentPairedInterval(paired, protocol.bootstrap);
  for (const [key, value] of Object.entries(interval)) if (key !== "blocks") check(`paired-bootstrap-${key}-recomputed`,
    near(value, review.pairedAgainstMarket.publishedModel[key]) && near(value, summary.recomputedFrozenPair.pairedAgainstMarket.publishedModel[key]));
  check("paired-counts-and-coverage", review.rows === paired.length && summary.recomputedFrozenPair.rows === paired.length
    && summary.coverage.denominator === capture.rows.length && near(summary.coverage.frozenProbability, original.length / capture.rows.length)
    && near(summary.coverage.pairedMarket, paired.length / capture.rows.length));
  for (const kind of Object.keys(metrics)) for (const name of ["league", "actualOutcome", "favoriteSpBand", "featureCoverage"]) check(`${kind}-${name}-group-counts`,
    Object.values(review.groups[kind][name]).reduce((total, value) => total + value.n, 0) === paired.length);
  check("review-replay-identity-separated", review.evaluationKind === "original-frozen-prediction-review"
    && replay.evaluationKinds.publishedModel === "original-frozen-prediction-review" && replay.evaluationKinds.candidate === "candidateReplay-not-original-prediction"
    && review.productionEligible === false && replay.shadowOnly === true && replay.productionEligible === false && summary.productionEligible === false);
  check("154-not-claimed-as-published-145", summary.historicalPublished145Reproduced === false
    && typeof summary.historicalPublished145Limitation === "string" && summary.historicalPublished145Limitation.length > 0);
  check("known-history-not-prospective-confirmation", /retrospective/i.test(protocol.source?.limitation || "")
    && /already known/i.test(protocol.source?.limitation || ""));
  check("protocol-not-changed", protocol.timeZone === "Asia/Shanghai" && isDeepStrictEqual(protocol.minimumRows, replay.protocol.minimumRows)
    && protocol.folds.length === replay.folds.length && protocol.folds.every((fold, index) => fold.id === replay.folds[index].id
      && ["train", "calibration", "validation"].every(stage => isDeepStrictEqual(fold[stage], { start: replay.folds[index].windows[stage].start, end: replay.folds[index].windows[stage].end })))
    && isDeepStrictEqual(protocol.finalTest, { start: replay.finalTest.window.start, end: replay.finalTest.window.end }));
  const finalRows = paired.filter(row => inWindow(row, protocol.finalTest)), finalDeadline = decisionBoundary(finalRows, protocol.finalTest);
  const usedTraining = [];
  protocol.folds.forEach((fold, index) => {
    const output = replay.folds[index];
    const raw = Object.fromEntries(["train", "calibration", "validation"].map(stage => [stage, paired.filter(row => inWindow(row, fold[stage]))]));
    const deadlines = { train: Math.min(decisionBoundary(raw.calibration, fold.calibration), decisionBoundary(raw.validation, fold.validation), finalDeadline),
      calibration: Math.min(decisionBoundary(raw.validation, fold.validation), finalDeadline), validation: finalDeadline };
    const expected = Object.fromEntries(Object.keys(raw).map(stage => {
      const excludedDays = new Set(raw[stage].filter(row => time(row.result.observedAt) >= deadlines[stage]).map(day));
      return [stage, raw[stage].filter(row => !excludedDays.has(day(row)))];
    }));
    usedTraining.push(expected.train.length);
    for (const stage of Object.keys(raw)) check(`${fold.id}-${stage}-chronology-membership`, output.id === fold.id
      && output.counts[stage].input === raw[stage].length && output.counts[stage].used === expected[stage].length
      && isDeepStrictEqual(sortedKeys(output.membership[stage]), sortedKeys(expected[stage])));
    const sets = [...Object.values(output.membership).map(rows => new Set(rows.map(eventKey))), new Set(finalRows.map(eventKey))];
    check(`${fold.id}-stage-event-sets-disjoint`, sets.every((set, i) => sets.slice(i + 1).every(other => [...set].every(key => !other.has(key)))));
  });
  check("insufficient-training-cannot-select-candidate", !usedTraining.every(count => count < protocol.minimumRows.training)
    || replay.selection.selectedCandidate === null && replay.selection.eligibleCandidates.length === 0);
  check("final-test-not-used-for-selection", replay.selection.finalTestUsedForSelection === false
    && summary.candidateReplay.selection.finalTestUsedForSelection === false && replay.finalTest.rows === finalRows.length
    && isDeepStrictEqual(sortedKeys(replay.finalTest.perMatch), sortedKeys(finalRows)));
  return { version: "quality-history-independent-evidence-v1", ok: blockers.length === 0, checks, blockers,
    sourceRows: capture.rows.length, frozenProbabilityRows: original.length, pairedRows: paired.length,
    trainingTimeValidRows: usedTraining, pairedDayBootstrap: interval, metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { n: value.n, brier: value.brier, logLoss: value.logLoss, accuracy: value.accuracy }])),
    envelope, funnel: expectedFunnel, retrospective: true, published145Reproduced: false, prospectiveConfirmation: false,
    productionWrites: 0, productionEligible: false, deploymentAuthorized: false,
    limitations: ["No new production connection. This rechecks the supplied production export, captured registry and receipt; provider payloads are not re-fetched.",
      "Full source-file hashes were measured by the pinned remote exporter; the complete 127 MB/766 MB source files are not available locally to independently re-stream.",
      "Original frozen probability scoring is not the original formal recommendation hit rate or the old strict 145-event cohort."] };
}

function loadHistoryBundle(historyRoot, implementationRoot = historyRoot) {
  const root = path.resolve(historyRoot), codeRoot = path.resolve(implementationRoot);
  const directory = path.join(root, "outputs/history-regression-20261002");
  const read = file => fs.readFileSync(file), json = file => JSON.parse(read(file));
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Later fixes may advance the implementation HEAD. Historical artifacts stay
  // bound to their original commit; do not rewrite its receipt for new code.
  execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", HISTORY_COMMIT, head], { stdio: "pipe" });
  const receiptBytes = read(path.join(directory, "delivery-receipt.json"));
  const committedReceipt = execFileSync("git", ["-C", root, "show", `${HISTORY_COMMIT}:outputs/history-regression-20261002/delivery-receipt.json`], { maxBuffer: 1024 * 1024 });
  if (sha(receiptBytes) !== sha(committedReceipt)) throw new Error("HISTORICAL_RECEIPT_CHANGED");
  const receipt = JSON.parse(receiptBytes);
  const fileProofs = receipt.files.map(entry => {
    const file = path.resolve(root, entry.path);
    if (!file.startsWith(root + path.sep) || path.isAbsolute(entry.path)) throw new Error("UNSAFE_RECEIPT_PATH");
    const currentBytes = read(file);
    let bytes = currentBytes, storage = "worktree-file";
    if ((bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) && /^(?:scripts|tests|docs)\//.test(entry.path)) {
      bytes = execFileSync("git", ["-C", root, "show", `${HISTORY_COMMIT}:${entry.path}`], { maxBuffer: 2 * 1024 * 1024 });
      storage = "git-blob-at-historical-commit";
    }
    const ok = bytes.length === entry.bytes && sha(bytes) === entry.sha256;
    if (!ok) throw new Error(`DELIVERY_FILE_HASH_MISMATCH:${entry.path}`);
    return { path: entry.path, bytes: bytes.length, sha256: sha(bytes), storage, currentFileSha256: sha(currentBytes), ok };
  });
  const admission = json(path.join(directory, "admission-v3.json"));
  const priorBytes = read(admission.inputs.priorReceipt.path);
  if (sha(priorBytes) !== admission.inputs.priorReceipt.sha256) throw new Error("PRIOR_RECEIPT_HASH_MISMATCH");
  const bundle = { capture: json(path.join(directory, "online-sample-v3.json")), admission,
    rawResponseBytes: read(path.join(directory, "online-sample-v3.json.remote-response.json")), prior: JSON.parse(priorBytes),
    evidence: read(path.join(directory, "report/per-match-evidence.jsonl")).toString("utf8").trim().split("\n").map(JSON.parse),
    review: json(path.join(directory, "report/review.json")), summary: json(path.join(directory, "report/summary.json")),
    replay: json(path.join(directory, "report/replay.json")), protocol: json(path.join(root, "docs/history-regression-protocol.json")) };
  const interfaces = { admission: require(path.join(codeRoot, "scripts/historyRegressionAdmission.cjs")), replay: require(path.join(codeRoot, "scripts/historyRegressionReplay.cjs")) };
  const implementationFiles = ["historyRegressionAdmission.cjs", "historyRegressionReplay.cjs"].map(file => ({ file, sha256: sha(read(path.join(codeRoot, "scripts", file))) }));
  const implementationHead = execFileSync("git", ["-C", codeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const trackedDirty = execFileSync("git", ["-C", codeRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  return { bundle, interfaces, proof: { historyCommit: HISTORY_COMMIT, evidenceWorktreeHead: head, implementationHead, implementationTrackedDirty: Boolean(trackedDirty), implementationRoot: codeRoot, implementationFiles, fileProofs,
    receiptSha256: sha(read(path.join(directory, "delivery-receipt.json"))), priorReceiptSha256: sha(priorBytes) } };
}
module.exports = { HISTORY_COMMIT, auditHistory, loadHistoryBundle, independentMetrics, independentPairedInterval, near };
if (require.main === module) {
  try {
    const loaded = loadHistoryBundle(process.argv[2], process.argv[3]);
    const report = { ...auditHistory(loaded.bundle, loaded.interfaces.admission), verifiedAt: new Date().toISOString(), proof: loaded.proof };
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, blocker: error.message, productionWrites: 0, deploymentAuthorized: false })); process.exitCode = 1; }
}
