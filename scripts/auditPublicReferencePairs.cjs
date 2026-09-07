"use strict";
const { digest } = require("../src/services/publicReferenceEvidence.cjs");
const { buildPublicReferenceIndex } = require("../server/publicReferenceArchive.cjs");
const { buildReferenceReviewPerformance, matchIdentity, businessDateForMatch } = require("../server/reviewPerformanceSummary.cjs");
const { auditFrozenReferenceMarket, isFrozenPairClock } = require("../src/services/frozenReferenceMarketPair.cjs");
const VERSION = "public-reference-paired-hit-audit-v1";

function buildPublicReferencePairAudit({ matches, archive, trustRegistry, generatedAt, startDate } = {}) {
  if (!Array.isArray(matches) || !isFrozenPairClock(generatedAt)) throw new Error("Explicit complete history and audit clock required");
  const history = buildReferenceReviewPerformance({ matches, generatedAt, startDate });
  // Verify the WHOLE supplied archive once. Do not filter corrupt ledger entries
  // before its membership/content validation or repeatedly hash it per match.
  const index = buildPublicReferenceIndex(archive);
  const ledger = new Map((index?.shards || []).map(shard => [shard.payload.record.contentHash, shard.payload]));
  const groups = new Map();
  for (const match of matches) {
    const key = matchIdentity(match);
    if (key) { const rows = groups.get(key) || []; rows.push(match); groups.set(key, rows); }
  }
  const audits = [];
  for (const [identity, copies] of groups) {
    const cohort = buildReferenceReviewPerformance({ matches: copies, generatedAt, startDate });
    if (!cohort.cumulative.settled) continue; // Same conflict/start/identity rules as the published total.
    const results = copies.map(match => {
      const hash = match.postMatchReview?.predictionReview?.rows?.find(row => row.marketType === "BEST" && row.performanceTrack === "reference")?.frozenVersion?.referenceHash;
      return auditFrozenReferenceMarket({ match, ...ledger.get(hash), trustRegistry, auditAt: generatedAt });
    });
    const reasons = [...new Set(results.filter(r => !r.eligible).map(r => r.reason))].sort();
    const different = new Set(results.filter(r => r.eligible).map(r => r.contentHash)).size > 1;
    const eligible = reasons.length === 0 && !different;
    const market = ["HAD", "HHAD", "UNKNOWN"].find(pool => cohort.marketBreakdown[pool].cumulative.settled === 1);
    audits.push({ identity, date: businessDateForMatch(copies[0]), market, eligible,
      reasons: [...reasons, ...(different ? ["duplicate-pair-evidence-conflict"] : [])],
      ...(eligible ? { pair: results[0] } : { details: [...new Set(results.flatMap(r => r.detail || []))].sort() }) });
  }
  audits.sort((a, b) => a.identity.localeCompare(b.identity));
  if (audits.length !== history.cumulative.settled) throw new Error("Paired cohort does not reconcile to complete reference history");
  const bucket = rows => {
    const accepted = rows.filter(r => r.eligible), n = accepted.length;
    const publishedWon = accepted.filter(r => r.pair.publishedWon).length, baselineWon = accepted.filter(r => r.pair.baselineWon).length;
    const matrix = { bothWon: 0, publicOnly: 0, baselineOnly: 0, bothLost: 0 };
    for (const { pair } of accepted) matrix[pair.publishedWon ? pair.baselineWon ? "bothWon" : "publicOnly" : pair.baselineWon ? "baselineOnly" : "bothLost"]++;
    return { settledReferenceEvents: rows.length, paired: n, excluded: rows.length - n, publishedWon, baselineWon,
      publicHitRate: n ? publishedWon / n : null, baselineHitRate: n ? baselineWon / n : null,
      hitRateDifference: n ? (publishedWon - baselineWon) / n : null,
      tiedBaselineOdds: accepted.filter(r => r.pair.tie).length, matrix };
  };
  const primaryReasons = {};
  for (const row of audits.filter(r => !r.eligible)) primaryReasons[row.reasons[0]] = (primaryReasons[row.reasons[0]] || 0) + 1;
  return { version: VERSION, generatedAt, scope: "private-supplied-reference-history-paired-hit-diagnostic",
    policy: { baseline: "inverse-decimal-odds-proportional-devig", tieOrder: ["1", "X", "2"],
      compare: "same-frozen-reference-event-market-and-decision", sourceBoundary: "trusted-collector-signed-commitment-raw-response-not-rehashed",
      resultBoundary: "existing-application-trusted-final-not-independent-result-attestation",
      parameterRevisionVerified: false, recommendationCoverage: null, admissionEligible: false,
      note: "Reconciles the full supplied history, not proof of upstream completeness. Paired availability is not recommendation coverage. No source independence, full parameter revision, raw response rehash, profit, calibration or promotion claim." },
    input: { records: matches.length, historyExclusions: history.exclusions, historyCounts: history.cumulative,
      archiveHash: archive?.contentHash || null, evidenceArchiveHash: archive?.evidenceContentHash || null,
      cohortHash: digest(audits.map(r => [r.identity, r.eligible, r.pair?.contentHash || null, r.reasons])) },
    cumulative: bucket(audits), exclusions: primaryReasons,
    markets: Object.fromEntries(["HAD", "HHAD", "UNKNOWN"].map(market => [market, bucket(audits.filter(r => r.market === market))])),
    daily: [...new Set(audits.map(r => r.date))].sort().map(date => ({ date, ...bucket(audits.filter(r => r.date === date)) })),
    rows: audits };
}
module.exports = { VERSION, buildPublicReferencePairAudit };

if (require.main === module) {
  const fs = require("node:fs"), path = require("node:path");
  const args = process.argv.slice(2), flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--history", "--archive", "--trust-registry", "--output", "--at"].includes(args[i]) || !args[i+1] || flags[args[i]]) throw new Error("Explicit --history --archive --trust-registry --output [--at] required");
    flags[args[i]] = args[i+1];
  }
  if (["--history", "--archive", "--trust-registry", "--output"].some(k => !flags[k])) throw new Error("Missing explicit audit input/output");
  const output = path.resolve(flags["--output"]), workspace = path.resolve(__dirname, "..");
  const temp = path.resolve(require("node:os").tmpdir()), relativeTemp = path.relative(temp, output).split(path.sep);
  const privateTemp = /^football-reference-pair-report-[a-zA-Z0-9]+$/.test(relativeTemp[0] || "")
    && relativeTemp.length > 1 && fs.existsSync(path.join(temp,relativeTemp[0]));
  const base = privateTemp ? path.join(temp,relativeTemp[0]) : path.join(workspace,"outputs");
  if (!output.startsWith(base + path.sep) || fs.existsSync(output)) throw new Error("Output must be a new private outputs or dedicated temporary report file");
  // Reject an existing junction/symlink anywhere below the workspace root;
  // lexical containment alone could otherwise send private output into public/.
  for (let parent = path.dirname(output); parent !== path.dirname(base); parent = path.dirname(parent)) {
    if (parent !== base && !parent.startsWith(base + path.sep)) throw new Error("Private output ancestor escapes its private root");
    if (fs.existsSync(parent) && (fs.lstatSync(parent).isSymbolicLink() || !fs.lstatSync(parent).isDirectory())) throw new Error("Private output parent is not an ordinary directory");
  }
  const read = filename => {
    const file = path.resolve(filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("Audit input must be a regular file <=64MiB");
    const bytes = fs.readFileSync(file), crypto = require("node:crypto");
    return { value: JSON.parse(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  };
  const history = read(flags["--history"]), archive = read(flags["--archive"]), trust = read(flags["--trust-registry"]);
  const matches = Array.isArray(history.value) ? history.value : history.value.matches;
  const report = buildPublicReferencePairAudit({ matches, archive: archive.value, trustRegistry: trust.value, generatedAt: flags["--at"] || new Date().toISOString() });
  report.inputFileHashes = { history: history.sha256, archive: archive.sha256, trustRegistry: trust.sha256 };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ ok: true, output, version: report.version, cumulative: report.cumulative, exclusions: report.exclusions }, null, 2));
}
