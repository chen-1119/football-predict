"use strict";
const assert = require("node:assert/strict");
const { createCollectorAttestationTestContext } = require("./collectorAttestationTestFixture.cjs");
const trust = createCollectorAttestationTestContext({ keyId: "synthetic-paired-market-only" });
const { buildPredictionFeatureSnapshot, buildArchivedPreMatchPrediction, buildPostMatchReview } = require("./syncData.cjs");
const { bindPublicReferenceDecision: bind, pendingPublicReferenceEvidence } = require("../src/services/publicReferenceDecision.cjs");
const { buildPublicReferenceArchive } = require("../server/publicReferenceArchive.cjs");
const { buildPublicReferencePairAudit } = require("./auditPublicReferencePairs.cjs");
const { auditFrozenReferenceMarket, auditFrozenDecisionMarket } = require("../src/services/frozenReferenceMarketPair.cjs");
const clone = v => JSON.parse(JSON.stringify(v));
const auditAt = "2026-09-07T15:00:00.000Z";
function fixture({ id = "997701", day = "2026-09-07", pool = "HAD", scores = [1, 1], quote = { odds1: 2.2, oddsX: 3.4, odds2: 3.1 }, receivedAt = `${day}T00:58:00.000Z`, mutateSource = () => {} } = {}) {
  const at = `${day}T01:00:00.000Z`;
  const proof = trust.buildSignedMarketProvenance({ poolCode: pool, sourceMatchId: id,
    odds: { "1": quote.odds1, X: quote.oddsX, "2": quote.odds2 }, handicapLine: pool === "HHAD" ? -1 : 0,
    sourceUrl: "https://webapi.sporttery.cn/gateway/synthetic-pair.qry", providerObservedAt: `${day}T00:57:00.000Z`,
    sourceTiming: { requestedAt: `${day}T00:56:00.000Z`, receivedAt, sourceCycleId: "synthetic-market-pair-cycle" } });
  const source = { id: `sporttery_${id}`, sourceMatchId: id, status: "SCHEDULED", businessDate: day,
    kickoffTime: `${day}T12:00:00.000Z`, eventVersion: `${day}T12:00:00.000Z`, buyEndTime: `${day}T11:55:00.000Z`,
    homeTeamName: "SYNTHETIC HOME", awayTeamName: "SYNTHETIC AWAY", source: "sporttery",
    ...(pool === "HAD" ? { odds: quote, oddsMarketProvenance: proof } : { handicapOdds: quote, handicapLine: -1, handicapOddsMarketProvenance: proof }),
    predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: pool, tipCode: "X", odds: quote.oddsX, ...(pool === "HHAD" ? { handicapLine: -1 } : {}) }],
    predictionMeta: { generatedAt: at, decisionGeneratedAt: at, decisionId: `synthetic-pair-${id}`, modelVersion: "synthetic-model", policyVersion: "synthetic-policy" },
    probabilityModel: { version: "synthetic-model", generatedAt: at, oneXTwo: { final: { home: 35, draw: 40, away: 25 } } } };
  source.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(source, at);
  mutateSource(source);
  const published = bind(source, null, `${day}T01:00:01.000Z`);
  const record = published.predictionMeta.publicReferenceDecision, entry = pendingPublicReferenceEvidence(published);
  assert.ok(entry, "real public builder captures original evidence");
  const match = { ...published, status: "FINISHED", scoreHome: scores[0], scoreAway: scores[1],
    resultProvenance: { provider: "sporttery", official: true, trusted: true, scoreHome: scores[0], scoreAway: scores[1] } };
  match.archivedPreMatchPrediction = buildArchivedPreMatchPrediction(match, new Map(), null, auditAt);
  match.postMatchReview = buildPostMatchReview(match, auditAt, new Map());
  return { match, record, entry };
}
function report(fixtures, matches = fixtures.map(f => f.match), archiveMutate = () => {}) {
  const unique = [...new Map(fixtures.map(f => [f.record.contentHash, f])).values()];
  const archive = buildPublicReferenceArchive({ publicReferenceDecisions: unique.map(f => f.record), publicReferenceEvidence: unique.map(f => f.entry) });
  archiveMutate(archive);
  return buildPublicReferencePairAudit({ matches, archive, trustRegistry: trust.registry, generatedAt: auditAt });
}
const inspect = f => auditFrozenReferenceMarket({ ...f, trustRegistry: trust.registry, auditAt });
const best = f => f.match.postMatchReview.predictionReview.rows.find(r => r.marketType === "BEST");
module.exports = { fixture, report, trust, auditAt };
if (require.main === module) {
  const checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  try {
    check("actual public capture, signed extraction, archive and settlement produce an exact paired diagnostic", () => {
      const f = fixture(), result = inspect(f);
      assert.equal(result.eligible, true, JSON.stringify(result)); assert.equal(result.publicCode, "X"); assert.equal(result.baselineCode, "1");
      assert.equal(result.publishedWon, true); assert.equal(result.baselineWon, false);
      assert.ok(Math.abs(Object.values(result.probabilities).reduce((n,p) => n+p, 0) - 1) < 1e-12);
      assert.equal(report([f]).cumulative.matrix.publicOnly, 1);
    });
    check("pre-settlement quote audit cannot fabricate a finished match or win rate", () => {
      const f = fixture(); f.match.status = "SCHEDULED"; delete f.match.postMatchReview;
      delete f.match.scoreHome; delete f.match.scoreAway; delete f.match.resultProvenance;
      const market = auditFrozenDecisionMarket({ ...f, trustRegistry: trust.registry });
      assert.equal(market.eligible, true); assert.equal(market.version, "frozen-decision-market-audit-v1");
      assert.equal(market.actual, undefined); assert.equal(market.publishedWon, undefined);
      assert.equal(inspect(f).reason, "frozen-reference-settlement-missing");
    });
    check("HHAD uses its frozen integer line and own odds, not HAD or current line", () => {
      const f = fixture({ pool: "HHAD", scores: [2,1] }); f.match.handicapLine = 4; f.match.odds = { odds1: 99, oddsX: 1.01, odds2: 99 };
      const p = inspect(f); assert.equal(p.eligible, true, JSON.stringify(p)); assert.equal(p.actual, "X"); assert.equal(p.line, -1);
      const r = report([f]); assert.equal(r.markets.HHAD.paired, 1); assert.equal(r.markets.HAD.paired, 0);
    });
    check("later mutable prices, clocks and model values cannot change a historical pair", () => {
      const f = fixture(), before = inspect(f); f.match.odds = { odds1: 8, oddsX: 1.2, odds2: 9 };
      f.match.oddsReceivedAt = auditAt; f.match.probabilityModel = { version: "later", generatedAt: auditAt };
      f.match.predictionMeta.featureSnapshot = { capturedAt: auditAt, market: {} };
      assert.deepEqual(inspect(f), before);
    });
    check("legacy missing frozen version remains excluded without changing original reference totals", () => {
      const f = fixture(); delete best(f).frozenVersion;
      const r = report([f]); assert.equal(r.cumulative.settledReferenceEvents, 1); assert.equal(r.cumulative.excluded, 1);
      assert.equal(r.cumulative.baselineHitRate, null); assert.equal(r.input.historyCounts.won, 1);
    });
    check("missing original ledger entry cannot be replaced with current evidence", () => {
      const f = fixture(); assert.equal(inspect({ ...f, entry: null }).reason, "original-public-evidence-missing-or-invalid");
      assert.equal(inspect({ ...f, record: null }).reason, "original-public-record-missing-or-invalid");
    });
    for (const [name, mutate, expected] of [
      ["missing frozen market", s => delete s.predictionMeta.featureSnapshot.market.had, "frozen-market-missing"],
      ["invalid complete quote", s => s.predictionMeta.featureSnapshot.market.had.odds.odds2 = 0, "frozen-market-odds-invalid"],
      ["changed selected odds", s => s.predictionMeta.featureSnapshot.market.had.odds.oddsX = 9, "frozen-selection-quote-mismatch"],
      ["unsigned snapshot", s => delete s.predictionMeta.featureSnapshot.market.had.provenance, "frozen-market-provenance-missing"],
      ["forged signature", s => s.predictionMeta.featureSnapshot.market.had.provenance.attestation.signature = "AAAA", "frozen-market-provenance-invalid"],
      ["signed quote disagrees", s => s.predictionMeta.featureSnapshot.market.had.odds.odds1 = 4, "signed-extraction-quote-mismatch"],
      ["claimed receive clock differs", s => s.predictionMeta.featureSnapshot.market.had.receivedAt = "2026-09-07T00:58:30.000Z", "frozen-market-clock-binding-mismatch"],
      ["timezone-less clock", s => s.predictionMeta.featureSnapshot.market.had.receivedAt = "2026-09-07T00:58:00", "frozen-market-clock-invalid"],
      ["illegal calendar", s => s.predictionMeta.featureSnapshot.market.had.observedAt = "2026-02-31T00:58:00Z", "frozen-market-clock-invalid"],
    ]) check(`${name} remains unavailable despite a valid public content hash`, () => {
      assert.equal(inspect(fixture({ mutateSource: mutate })).reason, expected);
    });
    check("a genuinely signed late receipt is excluded, even when public content is bound", () => {
      assert.equal(inspect(fixture({ receivedAt: "2026-09-07T01:00:00.500Z" })).reason, "frozen-market-not-available-at-decision");
    });
    check("untrusted registry and revoked key fail revalidation of an old eligible claim", () => {
      const f = fixture();
      for (const registry of [{}, { ...trust.registry, keys: trust.registry.keys.map(k => ({ ...k, enabled: false })) }]) {
        assert.equal(auditFrozenReferenceMarket({ ...f, trustRegistry: registry, auditAt }).reason, "frozen-market-provenance-invalid");
      }
    });
    check("untrusted, void or tampered score cannot create a paired win", () => {
      for (const mutate of [f => f.match.resultProvenance.trusted = false, f => f.match.resultDisposition = "VOID", f => f.match.scoreHome = null]) {
        const f = fixture(); mutate(f); assert.equal(inspect(f).reason, "trusted-final-score-missing");
      }
      const f = fixture(); f.match.scoreHome = 5; assert.equal(inspect(f).reason, "frozen-settlement-score-conflict");
    });
    check("future final and an invalid audit clock cannot enter the paired total", () => {
      const f = fixture();
      for (const at of ["2026-09-07T10:00:00.000Z", "2026-02-31T15:00:00Z"]) assert.equal(auditFrozenReferenceMarket({ ...f, trustRegistry: trust.registry, auditAt: at }).reason, "audit-before-kickoff-or-invalid");
    });
    check("exact equal odds use declared fixed tie order, never the winning result", () => {
      const f = fixture({ quote: { odds1: 3, oddsX: 3, odds2: 3 } }), p = inspect(f);
      assert.equal(p.baselineCode, "1"); assert.equal(p.tie, true); assert.equal(p.baselineWon, false); assert.equal(report([f]).cumulative.tiedBaselineOdds, 1);
    });
    check("duplicate aliases dedupe; missing evidence on a copy excludes the pair in either order", () => {
      const f = fixture(), alias = clone(f.match); alias.id = alias.id.replace("sporttery_", "fivehundred_");
      assert.equal(report([f], [f.match, alias]).cumulative.paired, 1);
      delete alias.postMatchReview.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion;
      assert.deepEqual(report([f], [f.match, alias]), report([f], [alias, f.match]));
      const r = report([f], [f.match, alias]); assert.equal(r.cumulative.excluded, 1); assert.equal(r.input.historyCounts.settled, 1);
    });
    check("complete mixed cohort reconciles eligible plus excluded and retains negative results", () => {
      const a = fixture(), b = fixture({ id: "997702", scores: [2,0] }), c = fixture({ id: "997703", pool: "HHAD" });
      delete best(c).frozenVersion;
      const r = report([a,b,c]); assert.equal(r.cumulative.settledReferenceEvents, 3); assert.equal(r.cumulative.paired, 2);
      assert.equal(r.cumulative.matrix.publicOnly, 1); assert.equal(r.cumulative.matrix.baselineOnly, 1);
      assert.equal(r.cumulative.hitRateDifference, 0); assert.equal(r.markets.HHAD.excluded, 1);
      assert.equal(Object.values(r.exclusions).reduce((n,x) => n+x, 0), r.cumulative.excluded);
      assert.equal(r.policy.recommendationCoverage, null); assert.equal(r.policy.admissionEligible, false);
    });
    check("corrupt or orphaned archive entries abort the whole report, not silently shrink its denominator", () => {
      const f = fixture();
      assert.throws(() => report([f], [f.match], a => a.evidence[0].evidence.probabilityModel.version = "tamper"));
      assert.throws(() => report([f], [f.match], a => a.rows.push(a.rows[0])));
    });
    check("real CLI binds input bytes, produces private output once, rejects public and malformed inputs", () => {
      const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
      const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-pair-cli-"));
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-reference-pair-report-"));
      try {
        const f = fixture(), historyPath = path.join(temp,"history.json"), archivePath = path.join(temp,"archive.json");
        const sourceArchive = buildPublicReferenceArchive({publicReferenceDecisions:[f.record],publicReferenceEvidence:[f.entry]});
        fs.writeFileSync(historyPath, JSON.stringify([f.match])); fs.writeFileSync(archivePath, JSON.stringify(sourceArchive));
        const before = [fs.readFileSync(historyPath,"utf8"),fs.readFileSync(archivePath,"utf8")];
        const args = ["--history",historyPath,"--archive",archivePath,"--trust-registry",trust.registryPath,"--at",auditAt];
        const outputPath = path.join(outputDir,"result.json");
        const run = (extra, argumentsToUse = args) => spawnSync(process.execPath,[path.join(__dirname,"auditPublicReferencePairs.cjs"),...argumentsToUse,...extra],{cwd:root,encoding:"utf8",timeout:20000,windowsHide:true});
        const first = run(["--output",outputPath]); assert.equal(first.status,0,first.stderr);
        const saved = JSON.parse(fs.readFileSync(outputPath,"utf8")); assert.equal(saved.cumulative.paired,1);
        assert.equal(saved.inputFileHashes.history,require("node:crypto").createHash("sha256").update(before[0]).digest("hex"));
        assert.notEqual(run(["--output",outputPath]).status,0);
        assert.notEqual(run(["--output",path.join(root,"public","pair-should-never-exist.json")]).status,0);
        assert.notEqual(run(["--output",path.join(outputDir,"invalid-clock.json")], args.map(v=>v===auditAt?"2026-02-31T15:00:00Z":v)).status,0);
        assert.equal(fs.existsSync(path.join(outputDir,"invalid-clock.json")),false);
        assert.deepEqual([fs.readFileSync(historyPath,"utf8"),fs.readFileSync(archivePath,"utf8")],before);
      } finally {
        assert.ok(path.dirname(path.resolve(outputDir)) === path.resolve(os.tmpdir()) && path.basename(outputDir).startsWith("football-reference-pair-report-"));
        assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
        fs.rmSync(outputDir,{recursive:true,force:true}); fs.rmSync(temp,{recursive:true,force:true});
      }
    });
    console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks }, null, 2));
  } finally { trust.cleanup(); }
}
