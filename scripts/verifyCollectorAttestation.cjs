const assert = require("node:assert/strict");
const {
  fetchEndpoint,
} = require("./collectSportterySnapshot.cjs");
const {
  isStrictMarketSourceProvenance,
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
const {
  createCollectorKeyPair,
  verifyCollectorAttestation,
} = require("../src/services/collectorAttestation.cjs");
const {
  matchesFromSportteryRelaySnapshot,
} = require("./syncData.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");
const {
  summarizeTrustedMarketCollectorEvidence,
} = require("../server/relayCollectorEvidence.cjs");

const payload = {
  success: true,
  value: {
    matchInfoList: [{
      businessDate: "2026-07-16",
      subMatchList: [{
        matchId: "collector-integration-1",
        matchDate: "2026-07-16",
        matchTime: "20:00:00",
        homeTeamAllName: "Collector Home",
        awayTeamAllName: "Collector Away",
        leagueAllName: "Collector League",
        matchStatus: "Selling",
        oddsList: [{
          poolCode: "HAD",
          h: "1.90",
          d: "3.30",
          a: "4.10",
          updateDate: "2026-07-16",
          updateTime: "18:25:00",
        }, {
          poolCode: "HHAD",
          h: "2.80",
          d: "3.25",
          a: "2.10",
          goalLine: "-1",
          updateDate: "2026-07-16",
          updateTime: "18:25:30",
        }],
      }],
    }],
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const main = async () => {
  const context = createCollectorAttestationTestContext({ keyId: "collector-integration-test-ed25519" });
  const rawBody = Buffer.from(JSON.stringify(payload));
  const request = async () => ({
    statusCode: 200,
    headers: {
      date: "Thu, 16 Jul 2026 10:26:00 GMT",
      etag: '"collector-integration"',
      "content-type": "application/json;charset=UTF-8",
    },
    rawBody,
    payload,
  });
  const clockValues = ["2026-07-16T10:24:00.000Z", "2026-07-16T10:26:00.000Z"];
  const sourceCycleId = "sporttery-relay:collector-integration";
  const endpoint = await fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/collector-integration.qry",
    sourceCycleId,
    request,
    clock: () => clockValues.shift(),
    attestationSigner: context.keyPair,
  });
  const attestationAudit = verifyCollectorAttestation(endpoint.collectorAttestation, {
    trustRegistry: context.registry,
    payload,
  });
  assert.equal(attestationAudit.eligible, true, JSON.stringify(attestationAudit.blockers));
  assert.equal(endpoint.collectorAttestation.keyId, context.keyId);
  assert.equal(Object.prototype.hasOwnProperty.call(endpoint.collectorAttestation, "publicKeyPem"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(endpoint.collectorAttestation, "verified"), false);
  const trustedCollectorEvidence = summarizeTrustedMarketCollectorEvidence({
    endpoints: [endpoint],
  }, {
    trustRegistry: context.registry,
  });
  assert.equal(
    trustedCollectorEvidence.trustedCollectorCount,
    1,
    JSON.stringify(trustedCollectorEvidence),
  );
  assert.equal(
    trustedCollectorEvidence.trustedEndpoints,
    1,
    JSON.stringify(trustedCollectorEvidence),
  );
  assert.deepEqual(trustedCollectorEvidence.keyIds, [context.keyId]);
  assert.deepEqual(trustedCollectorEvidence.independenceDomains, [context.independenceDomain]);
  assert.equal(trustedCollectorEvidence.trustedKeyCount, 1);
  assert.deepEqual(trustedCollectorEvidence.unassignedKeyIds, []);

  const rotatedPair = createCollectorKeyPair({
    keyId: "collector-integration-test-rotated-ed25519",
    independenceDomain: context.independenceDomain,
  });
  const rotatedClockValues = ["2026-07-16T10:27:00.000Z", "2026-07-16T10:28:00.000Z"];
  const rotatedEndpoint = await fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/collector-integration.qry",
    sourceCycleId: `${sourceCycleId}:rotated`,
    request,
    clock: () => rotatedClockValues.shift(),
    attestationSigner: rotatedPair,
  });
  const sameRuntimeRegistry = {
    version: context.registry.version,
    keys: [...context.registry.keys, ...rotatedPair.registry.keys],
  };
  const sameRuntimeEvidence = summarizeTrustedMarketCollectorEvidence({
    endpoints: [endpoint, rotatedEndpoint],
  }, {
    trustRegistry: sameRuntimeRegistry,
  });
  assert.equal(sameRuntimeEvidence.trustedKeyCount, 2);
  assert.equal(sameRuntimeEvidence.trustedCollectorCount, 1);
  assert.deepEqual(sameRuntimeEvidence.independenceDomains, [context.independenceDomain]);

  const unassignedRegistry = {
    version: context.registry.version,
    keys: context.registry.keys.map(({ independenceDomain: _omitted, ...key }) => key),
  };
  const unassignedEvidence = summarizeTrustedMarketCollectorEvidence({
    endpoints: [endpoint],
  }, {
    trustRegistry: unassignedRegistry,
  });
  assert.equal(unassignedEvidence.trustedEndpoints, 1);
  assert.equal(unassignedEvidence.trustedKeyCount, 1);
  assert.equal(unassignedEvidence.trustedCollectorCount, 0);
  assert.deepEqual(unassignedEvidence.unassignedKeyIds, [context.keyId]);
  assert.equal(unassignedEvidence.blockerCounts["collector-independence-domain-missing"], 1);

  const independentPair = createCollectorKeyPair({
    keyId: "collector-integration-test-independent-ed25519",
    independenceDomain: "test-collector-runtime-independent",
  });
  const independentClockValues = ["2026-07-16T10:28:00.000Z", "2026-07-16T10:29:00.000Z"];
  const independentEndpoint = await fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/collector-integration.qry",
    sourceCycleId: `${sourceCycleId}:independent`,
    request,
    clock: () => independentClockValues.shift(),
    attestationSigner: independentPair,
  });
  const independentRuntimeRegistry = {
    version: context.registry.version,
    keys: [
      ...context.registry.keys,
      ...rotatedPair.registry.keys,
      ...independentPair.registry.keys,
    ],
  };
  const independentRuntimeEvidence = summarizeTrustedMarketCollectorEvidence({
    endpoints: [endpoint, rotatedEndpoint, independentEndpoint],
  }, {
    trustRegistry: independentRuntimeRegistry,
  });
  assert.equal(independentRuntimeEvidence.trustedKeyCount, 3);
  assert.equal(independentRuntimeEvidence.trustedCollectorCount, 2);
  assert.deepEqual(independentRuntimeEvidence.independenceDomains, [
    context.independenceDomain,
    "test-collector-runtime-independent",
  ]);

  const parsed = matchesFromSportteryRelaySnapshot({
    payload: { sourceCycleId, sourceCycleKind: "collector-integration" },
    entries: [endpoint],
  });
  assert.equal(parsed.length, 1);
  const had = parsed[0].oddsMarketProvenance;
  const hhad = parsed[0].handicapOddsMarketProvenance;
  assert.equal(isStrictMarketSourceProvenance(had, { trustRegistry: context.registry }), true);
  assert.equal(isStrictMarketSourceProvenance(hhad, { trustRegistry: context.registry }), true);
  assert.deepEqual(had.extraction.odds, { "1": 1.9, X: 3.3, "2": 4.1 });
  assert.deepEqual(hhad.extraction.odds, { "1": 2.8, X: 3.25, "2": 2.1 });
  assert.equal(hhad.extraction.handicapLine, "-1");

  const currentPayload = clone(payload);
  currentPayload.value.lastUpdateTime = "2026-07-16 18:25:45";
  for (const pool of currentPayload.value.matchInfoList[0].subMatchList[0].oddsList) {
    pool.updateDate = "";
    pool.updateTime = "";
  }
  const currentRawBody = Buffer.from(JSON.stringify(currentPayload));
  const currentClockValues = ["2026-07-16T10:26:00.000Z", "2026-07-16T10:27:00.000Z"];
  const currentEndpoint = await fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001",
    sourceCycleId,
    request: async () => ({
      statusCode: 200,
      headers: {
        date: "Thu, 16 Jul 2026 10:27:00 GMT",
        "content-type": "application/json;charset=UTF-8",
      },
      rawBody: currentRawBody,
      payload: currentPayload,
    }),
    clock: () => currentClockValues.shift(),
    attestationSigner: context.keyPair,
  });
  const currentParsed = matchesFromSportteryRelaySnapshot({
    payload: { sourceCycleId },
    entries: [currentEndpoint],
  });
  assert.equal(currentEndpoint.providerObservedAt, "2026-07-16T10:25:45.000Z");
  assert.equal(currentEndpoint.providerObservation.source, "sporttery-payload-lastUpdateTime");
  assert.equal(currentParsed.length, 1);
  assert.equal(currentParsed[0].oddsObservedAt, "2026-07-16T10:25:45.000Z");
  assert.equal(currentParsed[0].handicapOddsObservedAt, "2026-07-16T10:25:45.000Z");
  assert.equal(isStrictMarketSourceProvenance(
    currentParsed[0].oddsMarketProvenance,
    { trustRegistry: context.registry },
  ), true, JSON.stringify(currentParsed[0].oddsMarketProvenance?.strict?.blockers));
  assert.equal(isStrictMarketSourceProvenance(
    currentParsed[0].handicapOddsMarketProvenance,
    { trustRegistry: context.registry },
  ), true, JSON.stringify(currentParsed[0].handicapOddsMarketProvenance?.strict?.blockers));

  const tamperedEndpoint = clone(endpoint);
  tamperedEndpoint.rawSha256 = "f".repeat(64);
  const tamperedParsed = matchesFromSportteryRelaySnapshot({
    payload: { sourceCycleId },
    entries: [tamperedEndpoint],
  });
  const tamperedAudit = normalizeMarketSourceProvenance(
    tamperedParsed[0].oddsMarketProvenance,
    { trustRegistry: context.registry },
  );
  assert.equal(tamperedAudit.strict.eligible, false);
  assert.ok(tamperedAudit.strict.blockers.includes("collector-attestation-raw-sha256-mismatch"));
  const tamperedCollectorEvidence = summarizeTrustedMarketCollectorEvidence({
    endpoints: [tamperedEndpoint],
  }, {
    trustRegistry: context.registry,
  });
  assert.equal(tamperedCollectorEvidence.trustedCollectorCount, 0);
  assert.equal(tamperedCollectorEvidence.trustedEndpoints, 0);
  assert.equal(
    tamperedCollectorEvidence.blockerCounts["collector-attestation-payload-rehash-mismatch"] || 0,
    0,
  );
  assert.ok(
    Number(tamperedCollectorEvidence.blockerCounts["collector-attestation-raw-sha256-mismatch"] || 0) > 0,
  );

  const tamperedHeadersEndpoint = clone(endpoint);
  tamperedHeadersEndpoint.headersSha256 = "e".repeat(64);
  const tamperedHeadersParsed = matchesFromSportteryRelaySnapshot({
    payload: { sourceCycleId },
    entries: [tamperedHeadersEndpoint],
  });
  const tamperedHeadersAudit = normalizeMarketSourceProvenance(
    tamperedHeadersParsed[0].oddsMarketProvenance,
    { trustRegistry: context.registry },
  );
  assert.equal(tamperedHeadersAudit.strict.eligible, false);
  assert.ok(tamperedHeadersAudit.strict.blockers.includes("collector-attestation-headers-sha256-mismatch"));

  const unsignedClockValues = ["2026-07-16T10:24:00.000Z", "2026-07-16T10:26:00.000Z"];
  const unsignedEndpoint = await fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/collector-integration.qry",
    sourceCycleId,
    request,
    clock: () => unsignedClockValues.shift(),
  });
  const unsignedParsed = matchesFromSportteryRelaySnapshot({ payload: { sourceCycleId }, entries: [unsignedEndpoint] });
  assert.equal(unsignedEndpoint.collectorAttestation, null);
  assert.equal(isStrictMarketSourceProvenance(
    unsignedParsed[0].oddsMarketProvenance,
    { trustRegistry: context.registry },
  ), false);

  console.log(JSON.stringify({
    ok: true,
    version: "collector-attestation-integration-verifier-v1",
    keyId: context.keyId,
    keyFingerprint: context.keyFingerprint,
    signedMarkets: {
      HAD: had.strict.eligible,
      HHAD: hhad.strict.eligible,
    },
    currentEndpointFallbackClock: {
      observedAt: currentEndpoint.providerObservedAt,
      source: currentEndpoint.providerObservation.source,
      strictHad: true,
      strictHhad: true,
    },
    canonicalPayloadSha256: endpoint.canonicalPayloadSha256,
    extractionHashes: endpoint.collectorAttestation.commitment.marketExtractionHashes,
    trustBoundary: attestationAudit.trustBoundary,
    trustedCollectorEvidence,
    sameRuntimeKeyRotationCountedOnce: sameRuntimeEvidence.trustedCollectorCount === 1,
    unassignedRuntimeNotCounted: unassignedEvidence.trustedCollectorCount === 0,
    independentRuntimeCountedSeparately: independentRuntimeEvidence.trustedCollectorCount === 2,
    unsignedFailsClosed: true,
    tamperedRawHashFailsClosed: true,
    tamperedHeadersFailClosed: true,
  }, null, 2));
  context.cleanup();
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
