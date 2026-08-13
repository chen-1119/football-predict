const assert = require("node:assert/strict");
const {
  createCollectorKeyPair,
} = require("../src/services/collectorAttestation.cjs");
const {
  fetchEndpoint,
} = require("./collectSportterySnapshot.cjs");
const {
  matchesFromSportteryRelaySnapshot,
} = require("./syncData.cjs");
const {
  COLLECTOR_EVIDENCE_UPLOAD_VERSION,
  collectorQuorumForDecision,
  mergeCollectorEvidenceStore,
  validateCollectorEvidenceUpload,
} = require("../server/collectorQuorumEvidence.cjs");
const {
  collectorQuorumRecordBlockers,
} = require("./candidateProspectiveLedger.cjs");

const payloadForOdds = ({ home = "1.90", draw = "3.30", away = "4.10" } = {}) => ({
  success: true,
  value: {
    matchInfoList: [{
      businessDate: "2026-07-31",
      subMatchList: [{
        matchId: "collector-quorum-1",
        matchDate: "2026-07-31",
        matchTime: "22:30:00",
        homeTeamAllName: "Quorum Home",
        awayTeamAllName: "Quorum Away",
        leagueAllName: "Quorum League",
        matchStatus: "Selling",
        oddsList: [{
          poolCode: "HAD",
          h: home,
          d: draw,
          a: away,
          updateDate: "2026-07-31",
          updateTime: "21:00:00",
        }, {
          poolCode: "HHAD",
          h: "2.80",
          d: "3.25",
          a: "2.10",
          goalLine: "-1",
          updateDate: "2026-07-31",
          updateTime: "21:00:00",
        }],
      }],
    }],
  },
});

const endpointFor = async ({ pair, payload, cycle, requestedAt, receivedAt }) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const clocks = [requestedAt, receivedAt];
  return fetchEndpoint({
    id: "current",
    method: "current",
    role: "current",
    url: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001",
    sourceCycleId: cycle,
    request: async () => ({
      statusCode: 200,
      headers: {
        date: "Fri, 31 Jul 2026 13:01:00 GMT",
        "content-type": "application/json;charset=UTF-8",
      },
      rawBody,
      payload,
    }),
    clock: () => clocks.shift(),
    attestationSigner: pair,
  });
};

const uploadFor = (endpoint) => ({
  version: COLLECTOR_EVIDENCE_UPLOAD_VERSION,
  capturedAt: endpoint.receivedAt,
  endpoints: [endpoint],
});

const main = async () => {
  const primaryPair = createCollectorKeyPair({
    keyId: "collector-quorum-primary",
    independenceDomain: "collector-runtime-primary",
  });
  const independentPair = createCollectorKeyPair({
    keyId: "collector-quorum-independent",
    independenceDomain: "collector-runtime-independent",
  });
  const rotatedPair = createCollectorKeyPair({
    keyId: "collector-quorum-primary-rotated",
    independenceDomain: "collector-runtime-primary",
  });
  const payload = payloadForOdds();
  const primaryEndpoint = await endpointFor({
    pair: primaryPair,
    payload,
    cycle: "collector-quorum:primary",
    requestedAt: "2026-07-31T13:00:00.000Z",
    receivedAt: "2026-07-31T13:01:00.000Z",
  });
  const independentEndpoint = await endpointFor({
    pair: independentPair,
    payload,
    cycle: "collector-quorum:independent",
    requestedAt: "2026-07-31T13:02:00.000Z",
    receivedAt: "2026-07-31T13:03:00.000Z",
  });
  const rotatedEndpoint = await endpointFor({
    pair: rotatedPair,
    payload,
    cycle: "collector-quorum:rotated",
    requestedAt: "2026-07-31T13:02:30.000Z",
    receivedAt: "2026-07-31T13:03:30.000Z",
  });
  const registry = {
    version: primaryPair.registry.version,
    keys: [
      ...primaryPair.registry.keys,
      ...independentPair.registry.keys,
      ...rotatedPair.registry.keys,
    ],
  };
  const parsed = matchesFromSportteryRelaySnapshot({
    payload: { sourceCycleId: "collector-quorum:primary" },
    entries: [primaryEndpoint],
  });
  assert.equal(parsed.length, 1);
  const snapshot = {
    decisionSnapshot: {
      markets: {
        HAD: { provenance: parsed[0].oddsMarketProvenance },
        HHAD: { provenance: parsed[0].handicapOddsMarketProvenance },
      },
    },
  };
  const independentValidation = validateCollectorEvidenceUpload(
    uploadFor(independentEndpoint),
    { trustRegistry: registry, acceptedAt: "2026-07-31T13:04:00.000Z" },
  );
  assert.equal(independentValidation.ok, true, JSON.stringify(independentValidation.blockers));
  assert.equal(independentValidation.rows.length, 1);
  const evidenceStore = mergeCollectorEvidenceStore(null, independentValidation.rows, {
    now: "2026-07-31T13:05:00.000Z",
  });
  const deadlineAt = "2026-07-31T13:10:00.000Z";
  const independentQuorum = collectorQuorumForDecision({
    snapshot,
    deadlineAt,
    evidenceStore,
    trustRegistry: registry,
  });
  assert.equal(independentQuorum.trustedCollectorCount, 2);
  assert.equal(independentQuorum.singleAttestor, false);
  assert.deepEqual(independentQuorum.jointIndependenceDomains, [
    "collector-runtime-independent",
    "collector-runtime-primary",
  ]);
  const quorumEvent = {
    trustedCollectorCount: independentQuorum.trustedCollectorCount,
    singleAttestor: independentQuorum.singleAttestor,
    decisionDeadlineAt: deadlineAt,
    collectorQuorum: independentQuorum,
    collectorQuorumHash: independentQuorum.hash,
  };
  assert.deepEqual(collectorQuorumRecordBlockers(quorumEvent), []);
  const tamperedQuorumEvent = JSON.parse(JSON.stringify(quorumEvent));
  const storedProof = tamperedQuorumEvent.collectorQuorum.markets.HAD.proofs
    .find((proof) => proof.source === "collector-evidence-store");
  storedProof.acceptedAt = "2026-07-31T13:10:01.000Z";
  assert.ok(
    collectorQuorumRecordBlockers(tamperedQuorumEvent)
      .includes("had-collector-quorum-evidence-after-deadline"),
  );

  const rotatedValidation = validateCollectorEvidenceUpload(uploadFor(rotatedEndpoint), {
    trustRegistry: registry,
    acceptedAt: "2026-07-31T13:04:30.000Z",
  });
  assert.equal(rotatedValidation.ok, true);
  const rotatedStore = mergeCollectorEvidenceStore(null, rotatedValidation.rows, {
    now: "2026-07-31T13:05:00.000Z",
  });
  const rotatedQuorum = collectorQuorumForDecision({
    snapshot,
    deadlineAt,
    evidenceStore: rotatedStore,
    trustRegistry: registry,
  });
  assert.equal(rotatedQuorum.trustedCollectorCount, 1);
  assert.equal(rotatedQuorum.singleAttestor, true);

  const lateValidation = validateCollectorEvidenceUpload(uploadFor(independentEndpoint), {
    trustRegistry: registry,
    acceptedAt: "2026-07-31T13:11:00.000Z",
  });
  assert.equal(lateValidation.ok, true);
  const lateStore = mergeCollectorEvidenceStore(null, lateValidation.rows, {
    now: "2026-07-31T13:11:30.000Z",
  });
  const lateQuorum = collectorQuorumForDecision({
    snapshot,
    deadlineAt,
    evidenceStore: lateStore,
    trustRegistry: registry,
  });
  assert.equal(lateQuorum.trustedCollectorCount, 1);

  const mismatchedEndpoint = await endpointFor({
    pair: independentPair,
    payload: payloadForOdds({ home: "2.05" }),
    cycle: "collector-quorum:mismatched",
    requestedAt: "2026-07-31T13:05:00.000Z",
    receivedAt: "2026-07-31T13:06:00.000Z",
  });
  const mismatchedValidation = validateCollectorEvidenceUpload(uploadFor(mismatchedEndpoint), {
    trustRegistry: registry,
    acceptedAt: "2026-07-31T13:07:00.000Z",
  });
  assert.equal(mismatchedValidation.ok, true);
  const mismatchedStore = mergeCollectorEvidenceStore(null, mismatchedValidation.rows, {
    now: "2026-07-31T13:08:00.000Z",
  });
  const mismatchedQuorum = collectorQuorumForDecision({
    snapshot,
    deadlineAt,
    evidenceStore: mismatchedStore,
    trustRegistry: registry,
  });
  assert.equal(mismatchedQuorum.trustedCollectorCount, 1);

  const tampered = JSON.parse(JSON.stringify(independentEndpoint));
  tampered.collectorAttestation.signature = `${tampered.collectorAttestation.signature.slice(0, -4)}AAAA`;
  tampered.collectorProvenance.collectorAttestation = tampered.collectorAttestation;
  const tamperedValidation = validateCollectorEvidenceUpload(uploadFor(tampered), {
    trustRegistry: registry,
    acceptedAt: "2026-07-31T13:04:00.000Z",
  });
  assert.equal(tamperedValidation.ok, false);
  assert.ok(tamperedValidation.blockers.includes("collector-attestation-signature-invalid"));

  console.log(JSON.stringify({
    ok: true,
    version: "collector-quorum-evidence-verifier-v1",
    independentBeforeDeadlineCount: independentQuorum.trustedCollectorCount,
    rotatedSameRuntimeCount: rotatedQuorum.trustedCollectorCount,
    lateEvidenceCount: lateQuorum.trustedCollectorCount,
    mismatchedMarketCount: mismatchedQuorum.trustedCollectorCount,
    tamperedSignatureRejected: !tamperedValidation.ok,
    eventQuorumValidationPassed: collectorQuorumRecordBlockers(quorumEvent).length === 0,
    quorumHash: independentQuorum.hash,
  }, null, 2));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
