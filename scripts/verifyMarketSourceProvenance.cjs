const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  COLLECTOR_TRUST_REGISTRY_VERSION,
} = require("../src/services/collectorAttestation.cjs");
const {
  buildSportteryMarketSourceProvenance,
  isStrictMarketSourceProvenance,
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

const clone = (value) => JSON.parse(JSON.stringify(value));
const context = createCollectorAttestationTestContext({ keyId: "market-provenance-test-ed25519" });
const {
  matchesFromSportteryRelaySnapshot,
  mergeFreshWithExistingStore,
} = require("./syncData.cjs");
const sourceCycleId = "sporttery-relay:signed-provenance-fixture";
const sourceUrl = "https://webapi.sporttery.cn/gateway/signed-fixture.qry";
const sourceTiming = {
  sourceCycleId,
  requestedAt: "2026-07-16T10:24:00.000Z",
  receivedAt: "2026-07-16T10:26:00.000Z",
  sourceRequest: { method: "GET", page: 1, role: "method:all" },
  httpStatus: 200,
  httpDate: "Thu, 16 Jul 2026 10:26:00 GMT",
  httpEtag: '"signed-fixture"',
  contentType: "application/json;charset=UTF-8",
  rawSha256: "1".repeat(64),
  rawBytes: 4096,
};

const had = context.buildSignedMarketProvenance({
  poolCode: "HAD",
  sourceMatchId: "signed-match",
  odds: { "1": 1.9, X: 3.3, "2": 4.1 },
  handicapLine: 0,
  sourceUrl,
  providerObservedAt: "2026-07-16T10:25:00.000Z",
  sourceTiming,
});
const hhad = context.buildSignedMarketProvenance({
  poolCode: "HHAD",
  sourceMatchId: "signed-match",
  odds: { "1": 2.8, X: 3.25, "2": 2.1 },
  handicapLine: -1,
  sourceUrl,
  providerObservedAt: "2026-07-16T10:25:30.000Z",
  endpointProviderObservedAt: "2026-07-16T10:25:30.000Z",
  sourceTiming: { ...sourceTiming, rawSha256: "2".repeat(64), rawBytes: 4200 },
});
assert.equal(had.strict.eligible, true, JSON.stringify(had.strict.blockers));
assert.equal(hhad.strict.eligible, true, JSON.stringify(hhad.strict.blockers));
assert.equal(isStrictMarketSourceProvenance(had, { trustRegistry: context.registry }), true);
assert.equal(isStrictMarketSourceProvenance(hhad, { trustRegistry: context.registry }), true);
assert.equal(had.market.poolCode, "HAD");
assert.equal(hhad.market.poolCode, "HHAD");
assert.notEqual(had.extraction.hash, hhad.extraction.hash);

const unsigned = buildSportteryMarketSourceProvenance({
  poolCode: "HAD",
  sourceMatchId: "unsigned-match",
  odds: { "1": 1.9, X: 3.3, "2": 4.1 },
  handicapLine: 0,
  sourceUrl,
  providerObservedAt: "2026-07-16T10:25:00.000Z",
  sourceTiming,
  trustRegistry: context.registry,
});
assert.equal(unsigned.strict.eligible, false);
assert.ok(unsigned.strict.blockers.includes("collector-attestation-missing"));

const evilHost = clone(had);
evilHost.endpoint.url = "https://webapi.sporttery.cn.evil.example/gateway/signed-fixture.qry";
const evilHostAudit = normalizeMarketSourceProvenance(evilHost, { trustRegistry: context.registry });
assert.equal(evilHostAudit.strict.eligible, false);
assert.ok(evilHostAudit.strict.blockers.includes("endpoint-not-official"));
assert.ok(evilHostAudit.strict.blockers.includes("collector-attestation-endpoint-url-mismatch"));

const selfClaimed = clone(had);
selfClaimed.attestation.verified = true;
selfClaimed.attestation.publicKeyPem = context.keyPair.publicKeyPem;
const selfClaimedAudit = normalizeMarketSourceProvenance(selfClaimed, { trustRegistry: context.registry });
assert.equal(selfClaimedAudit.strict.eligible, false);
assert.ok(selfClaimedAudit.strict.blockers.includes("collector-attestation-untrusted-claim-present"));

const unknownKeyRegistry = { version: COLLECTOR_TRUST_REGISTRY_VERSION, keys: [] };
const unknownKeyAudit = normalizeMarketSourceProvenance(had, { trustRegistry: unknownKeyRegistry });
assert.equal(unknownKeyAudit.strict.eligible, false);
assert.ok(unknownKeyAudit.strict.blockers.includes("collector-attestation-key-unknown"));

const signatureTamper = clone(had);
signatureTamper.attestation.signature = `${signatureTamper.attestation.signature.slice(0, -2)}AA`;
const signatureTamperAudit = normalizeMarketSourceProvenance(signatureTamper, { trustRegistry: context.registry });
assert.equal(signatureTamperAudit.strict.eligible, false);
assert.ok(signatureTamperAudit.strict.blockers.includes("collector-attestation-signature-invalid"));

const replayedCycle = clone(had);
replayedCycle.cycles.collectorSourceCycleId = "sporttery-relay:replayed-cycle";
const replayedCycleAudit = normalizeMarketSourceProvenance(replayedCycle, { trustRegistry: context.registry });
assert.equal(replayedCycleAudit.strict.eligible, false);
assert.ok(replayedCycleAudit.strict.blockers.includes("collector-attestation-cycle-mismatch"));

const marketSwap = clone(had);
marketSwap.market.poolCode = "HHAD";
const marketSwapAudit = normalizeMarketSourceProvenance(marketSwap, { trustRegistry: context.registry });
assert.equal(marketSwapAudit.strict.eligible, false);
assert.ok(marketSwapAudit.strict.blockers.includes("market-extraction-pool-mismatch"));

const commitmentTamper = clone(had);
commitmentTamper.attestation.commitment.canonicalPayloadSha256 = "f".repeat(64);
const commitmentTamperAudit = normalizeMarketSourceProvenance(commitmentTamper, { trustRegistry: context.registry });
assert.equal(commitmentTamperAudit.strict.eligible, false);
assert.ok(commitmentTamperAudit.strict.blockers.includes("collector-attestation-commitment-hash-mismatch"));
assert.ok(commitmentTamperAudit.strict.blockers.includes("collector-attestation-signature-invalid"));

const existingPublishedMatch = {
  id: "sporttery_signed-match",
  sourceMatchId: "signed-match",
  source: "sporttery",
  status: "SCHEDULED",
  kickoffTime: "2026-07-18T20:00:00+08:00",
  odds: { odds1: 1.9, oddsX: 3.3, odds2: 4.1 },
  oddsSource: "sporttery:HAD",
  oddsPoolCode: "HAD",
  oddsSourceMethod: "relay",
  oddsObservedAt: had.timing.providerObservedAt,
  oddsReceivedAt: had.timing.receivedAt,
  oddsSourceUrl: sourceUrl,
  oddsMarketProvenance: had,
  handicapOdds: { odds1: 2.8, oddsX: 3.25, odds2: 2.1 },
  handicapLine: "-1",
  handicapOddsSource: "sporttery:HHAD",
  handicapOddsPoolCode: "HHAD",
  handicapOddsSourceMethod: "relay",
  handicapOddsObservedAt: hhad.timing.providerObservedAt,
  handicapOddsReceivedAt: hhad.timing.receivedAt,
  handicapOddsSourceUrl: sourceUrl,
  handicapOddsMarketProvenance: hhad,
  predictions: [],
};
const unsignedNewerMatch = {
  ...clone(existingPublishedMatch),
  odds: { odds1: 1.82, oddsX: 3.45, odds2: 4.3 },
  oddsObservedAt: "2026-07-16T10:35:00.000Z",
  oddsReceivedAt: "2026-07-16T10:36:00.000Z",
  oddsMarketProvenance: null,
  handicapOdds: { odds1: 2.7, oddsX: 3.3, odds2: 2.2 },
  handicapOddsObservedAt: "2026-07-16T10:35:30.000Z",
  handicapOddsReceivedAt: "2026-07-16T10:36:00.000Z",
  handicapOddsMarketProvenance: null,
};
const preservedPublished = mergeFreshWithExistingStore(
  [existingPublishedMatch],
  [unsignedNewerMatch],
)[0];
assert.deepEqual(preservedPublished.odds, existingPublishedMatch.odds);
assert.deepEqual(preservedPublished.handicapOdds, existingPublishedMatch.handicapOdds);
assert.equal(
  isStrictMarketSourceProvenance(preservedPublished.oddsMarketProvenance, {
    trustRegistry: context.registry,
  }),
  true,
);
assert.equal(
  isStrictMarketSourceProvenance(preservedPublished.handicapOddsMarketProvenance, {
    trustRegistry: context.registry,
  }),
  true,
);

const changedSupplementalMatch = {
  ...clone(existingPublishedMatch),
  source: "500.com",
  odds: { odds1: 1.78, oddsX: 3.6, odds2: 4.6 },
  oddsSource: "500.com:HAD",
  oddsSourceMethod: "fallback",
  oddsObservedAt: "2026-07-16T10:45:00.000Z",
  oddsReceivedAt: "2026-07-16T10:46:00.000Z",
  oddsMarketProvenance: null,
  handicapOdds: { odds1: 2.58, oddsX: 3.5, odds2: 2.35 },
  handicapLine: "-1",
  handicapOddsSource: "500.com:HHAD",
  handicapOddsSourceMethod: "fallback",
  handicapOddsObservedAt: "2026-07-16T10:45:30.000Z",
  handicapOddsReceivedAt: "2026-07-16T10:46:00.000Z",
  handicapOddsMarketProvenance: null,
};
const supplementalMerge = mergeFreshWithExistingStore(
  [existingPublishedMatch],
  [changedSupplementalMatch],
)[0];
assert.deepEqual(supplementalMerge.odds, existingPublishedMatch.odds);
assert.deepEqual(supplementalMerge.handicapOdds, existingPublishedMatch.handicapOdds);
assert.equal(supplementalMerge.oddsSource, "sporttery:HAD");
assert.equal(supplementalMerge.handicapOddsSource, "sporttery:HHAD");
assert.deepEqual(supplementalMerge.oddsMarketProvenance, had);
assert.deepEqual(supplementalMerge.handicapOddsMarketProvenance, hhad);

const relayPath = path.resolve(__dirname, "..", ".codex-tmp", "sporttery-relay-snapshot.json");
let realRows = [];
if (fs.existsSync(relayPath)) {
  const raw = JSON.parse(fs.readFileSync(relayPath, "utf8"));
  realRows = matchesFromSportteryRelaySnapshot({ payload: raw, entries: raw.endpoints || [] });
}
const realMarketProvenance = realRows.flatMap((row) => [
  row.oddsMarketProvenance,
  row.handicapOddsMarketProvenance,
]).filter(Boolean);
const realStrictEligible = realMarketProvenance.filter((value) => (
  isStrictMarketSourceProvenance(value, { trustRegistry: context.registry })
)).length;
assert.equal(realStrictEligible, 0, "legacy real relay data without collector signatures must remain strict-ineligible");

console.log(JSON.stringify({
  ok: true,
  version: "market-source-provenance-verifier-v2",
  synthetic: {
    hadStrictEligible: had.strict.eligible,
    hhadStrictEligible: hhad.strict.eligible,
    unsignedNewerMarketRejected: true,
    strictMarketPreservedAtomically: true,
    supplementalMarketCannotReplaceOfficialAtom: true,
  },
  attacksRejected: [
    "unsigned",
    "evil-host",
    "claimed-verified",
    "self-contained-public-key",
    "unknown-key",
    "signature-tamper",
    "commitment-tamper",
    "replay-cycle",
    "market-swap",
  ],
  realData: {
    relayPath: fs.existsSync(relayPath) ? relayPath : null,
    matchRows: realRows.length,
    marketProvenanceRows: realMarketProvenance.length,
    strictEligible: realStrictEligible,
  },
  trustBoundary: had.strict.trustBoundary,
}, null, 2));

context.cleanup();
