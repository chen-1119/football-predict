const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCollectorCommitment,
  createCollectorKeyPair,
  extractionFromSportteryPool,
  sha256CollectorJson,
  signCollectorCommitment,
} = require("../src/services/collectorAttestation.cjs");
const {
  buildSportteryMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");

const beijingDateTime = (instant) => {
  const millis = Date.parse(instant || "");
  if (!Number.isFinite(millis)) return { updateDate: null, updateTime: null };
  const value = new Date(millis + 8 * 60 * 60 * 1000).toISOString();
  return { updateDate: value.slice(0, 10), updateTime: value.slice(11, 19) };
};

const rawOdds = (odds = {}) => ({
  h: Number(odds["1"] ?? odds.odds1 ?? odds.home),
  d: Number(odds.X ?? odds.oddsX ?? odds.draw),
  a: Number(odds["2"] ?? odds.odds2 ?? odds.away),
});

const createCollectorAttestationTestContext = ({
  keyId = "test-collector-ed25519",
  independenceDomain = "test-collector-runtime",
} = {}) => {
  const pair = createCollectorKeyPair({ keyId, independenceDomain });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-collector-trust-"));
  const registryPath = path.join(tempRoot, "collector-trust-registry.json");
  fs.writeFileSync(registryPath, `${JSON.stringify(pair.registry, null, 2)}\n`, "utf8");
  const previousRegistryPath = process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH = registryPath;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (previousRegistryPath === undefined) delete process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;
    else process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH = previousRegistryPath;
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  };
  process.once("exit", cleanup);

  const buildSignedMarketProvenance = ({
    poolCode,
    sourceMatchId = "collector-attestation-fixture",
    odds = { "1": 2.1, X: 3.2, "2": 3.4 },
    handicapLine = String(poolCode || "").toUpperCase() === "HHAD" ? -1 : 0,
    sourceUrl,
    providerObservedAt,
    sourceTiming = {},
    endpointProviderObservedAt = null,
    attestationMutator = null,
    trustRegistry = pair.registry,
  } = {}) => {
    const code = String(poolCode || "").toUpperCase();
    const observedParts = beijingDateTime(providerObservedAt);
    const poolRow = {
      poolCode: code,
      ...rawOdds(odds),
      ...(code === "HHAD" ? { goalLine: handicapLine } : {}),
      ...observedParts,
    };
    const row = { matchId: sourceMatchId, oddsList: [poolRow] };
    const payload = { value: { matchInfoList: [{ subMatchList: [row] }] } };
    const sourceRequest = {
      method: "GET",
      page: null,
      role: "test-fixture",
      ...(sourceTiming.sourceRequest || {}),
    };
    if (!sourceRequest.role) sourceRequest.role = "test-fixture";
    const endpointObservedAt = endpointProviderObservedAt || sourceTiming.providerObservedAt || providerObservedAt;
    const response = {
      httpStatus: sourceTiming.httpStatus ?? 200,
      httpDate: sourceTiming.httpDate ?? null,
      httpEtag: sourceTiming.httpEtag ?? null,
      contentType: sourceTiming.contentType ?? "application/json",
      headersSha256: sourceTiming.headersSha256 || sha256CollectorJson({}),
      rawSha256: sourceTiming.rawSha256 || "a".repeat(64),
      rawBytes: sourceTiming.rawBytes ?? 1024,
    };
    const marketExtraction = extractionFromSportteryPool({ row, poolRow, poolCode: code });
    const canonicalPayloadSha256 = sha256CollectorJson(payload);
    const commitment = buildCollectorCommitment({
      provider: "sporttery",
      endpoint: {
        url: sourceUrl,
        method: sourceRequest.method,
        page: sourceRequest.page,
        role: sourceRequest.role,
      },
      collectorCycleId: sourceTiming.sourceCycleId,
      requestedAt: sourceTiming.requestedAt,
      receivedAt: sourceTiming.receivedAt,
      providerObservedAt: endpointObservedAt,
      response,
      payload,
      canonicalPayloadSha256,
    });
    let collectorAttestation = signCollectorCommitment(commitment, pair);
    if (typeof attestationMutator === "function") {
      collectorAttestation = attestationMutator(JSON.parse(JSON.stringify(collectorAttestation)));
    }
    return buildSportteryMarketSourceProvenance({
      poolCode: code,
      sourceMatchId,
      odds,
      handicapLine,
      marketExtraction,
      sourceUrl,
      providerObservedAt,
      sourceTiming: {
        ...sourceTiming,
        ...response,
        providerObservedAt: endpointObservedAt,
        sourceRequest,
        canonicalPayloadSha256,
        collectorAttestation,
        endpointPayload: payload,
      },
      trustRegistry,
    });
  };

  return {
    buildSignedMarketProvenance,
    cleanup,
    keyId: pair.keyId,
    keyFingerprint: pair.fingerprint,
    independenceDomain,
    keyPair: pair,
    registry: pair.registry,
    registryPath,
  };
};

module.exports = { createCollectorAttestationTestContext };
