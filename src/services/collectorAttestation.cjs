const crypto = require("node:crypto");
const fs = require("node:fs");

const COLLECTOR_ATTESTATION_VERSION = "sporttery-collector-attestation-v1";
const COLLECTOR_COMMITMENT_VERSION = "sporttery-collector-commitment-v1";
const COLLECTOR_TRUST_REGISTRY_VERSION = "sporttery-collector-trust-registry-v1";
const MARKET_EXTRACTION_COMMITMENT_VERSION = "sporttery-market-extraction-v1";
const ED25519_ALGORITHM = "Ed25519";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const INDEPENDENCE_DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const text = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const canonicalInstant = (value) => {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const integer = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : null;
};

const canonicalLine = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().replace(/\u2212|\uFF0D/g, "-").replace(/\uFF0B/g, "+");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Object.is(parsed, -0) || parsed === 0 ? "0" : String(parsed);
};

const canonicalize = (value, location = "root") => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${location}[${index}]`));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} contains a non-plain object`);
    }
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key], `${location}.${key}`)]));
  }
  throw new TypeError(`${location} contains unsupported ${typeof value}`);
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256Json = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const endpointUrl = (value) => {
  try {
    return new URL(String(value || "")).toString();
  } catch {
    return text(value);
  }
};

const providerObservedAtFromPool = (poolRow) => {
  const date = text(poolRow?.updateDate);
  const time = text(poolRow?.updateTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}:\d{2}$/.test(time || "")) return null;
  const millis = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const normalizeOdds = (value) => {
  const odds = {
    "1": finiteNumber(value?.["1"] ?? value?.odds1 ?? value?.home ?? value?.h),
    X: finiteNumber(value?.X ?? value?.oddsX ?? value?.draw ?? value?.d),
    "2": finiteNumber(value?.["2"] ?? value?.odds2 ?? value?.away ?? value?.a),
  };
  return Object.values(odds).every((number) => number !== null && number > 1) ? odds : null;
};

const extractionCore = (value = {}) => {
  const poolCode = text(value.poolCode)?.toUpperCase() || null;
  return {
    version: MARKET_EXTRACTION_COMMITMENT_VERSION,
    provider: "sporttery",
    sourceMatchId: text(value.sourceMatchId),
    poolCode,
    handicapLine: poolCode === "HAD" ? "0" : canonicalLine(value.handicapLine),
    odds: normalizeOdds(value.odds),
    providerObservedAt: canonicalInstant(value.providerObservedAt),
  };
};

const buildMarketExtractionCommitment = (value = {}) => {
  const core = extractionCore(value);
  return { ...core, hash: sha256Json(core) };
};

const extractionFromSportteryPool = ({
  row,
  poolRow,
  poolCode,
  fallbackProviderObservedAt = null,
} = {}) => {
  const code = text(poolCode)?.toUpperCase() || null;
  return buildMarketExtractionCommitment({
    sourceMatchId: row?.matchId,
    poolCode: code,
    handicapLine: code === "HAD"
      ? 0
      : (poolRow?.goalLine ?? poolRow?.goalLineValue ?? row?.hhad?.goalLine),
    odds: poolRow,
    providerObservedAt: providerObservedAtFromPool(poolRow)
      || canonicalInstant(fallbackProviderObservedAt),
  });
};

const marketExtractionCommitmentsFromPayload = (payload, fallbackProviderObservedAt = null) => {
  const commitments = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const sourceMatchId = text(value.matchId);
      if (sourceMatchId) {
        const pools = Array.isArray(value.oddsList) ? value.oddsList : [];
        for (const poolRow of pools) {
          const poolCode = text(poolRow?.poolCode)?.toUpperCase();
          if (!["HAD", "HHAD"].includes(poolCode)) continue;
          const commitment = extractionFromSportteryPool({
            row: value,
            poolRow,
            poolCode,
            fallbackProviderObservedAt,
          });
          if (commitment.odds && (poolCode !== "HHAD" || commitment.handicapLine !== null)) {
            commitments.set(commitment.hash, commitment);
          }
        }
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(payload);
  return [...commitments.values()].sort((left, right) => left.hash.localeCompare(right.hash));
};

const buildCollectorCommitment = ({
  provider = "sporttery",
  endpoint = {},
  collectorCycleId,
  requestedAt,
  receivedAt,
  providerObservedAt,
  response = {},
  payload,
  canonicalPayloadSha256 = null,
  marketExtractions = null,
} = {}) => {
  const extractions = Array.isArray(marketExtractions)
    ? marketExtractions.map((item) => (
      typeof item === "string" ? item : text(item?.hash)
    )).filter((hash) => HASH_PATTERN.test(hash || ""))
    : marketExtractionCommitmentsFromPayload(payload, providerObservedAt).map((item) => item.hash);
  return {
    version: COLLECTOR_COMMITMENT_VERSION,
    provider: text(provider)?.toLowerCase() || null,
    endpoint: {
      url: endpointUrl(endpoint.url),
      method: text(endpoint.method)?.toUpperCase() || null,
      page: integer(endpoint.page),
      role: text(endpoint.role),
    },
    collectorCycleId: text(collectorCycleId),
    requestedAt: canonicalInstant(requestedAt),
    receivedAt: canonicalInstant(receivedAt),
    providerObservedAt: canonicalInstant(providerObservedAt),
    response: {
      httpStatus: integer(response.httpStatus),
      httpDate: text(response.httpDate),
      httpEtag: text(response.httpEtag),
      contentType: text(response.contentType),
      headersSha256: text(response.headersSha256)?.toLowerCase() || null,
      rawSha256: text(response.rawSha256)?.toLowerCase() || null,
      rawBytes: integer(response.rawBytes),
    },
    canonicalPayloadSha256: HASH_PATTERN.test(canonicalPayloadSha256 || "")
      ? canonicalPayloadSha256
      : sha256Json(payload),
    marketExtractionHashes: [...new Set(extractions)].sort(),
  };
};

const publicKeyFingerprint = (publicKey) => {
  const key = crypto.createPublicKey(publicKey);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
};

const publicKeyFromPrivate = (privateKey) => crypto
  .createPublicKey(crypto.createPrivateKey(privateKey))
  .export({ type: "spki", format: "pem" });

const normalizeIndependenceDomain = (value) => {
  const normalized = text(value);
  return INDEPENDENCE_DOMAIN_PATTERN.test(normalized || "") ? normalized : null;
};

const createCollectorKeyPair = ({
  keyId = `collector-${crypto.randomUUID()}`,
  independenceDomain = null,
} = {}) => {
  const normalizedKeyId = text(keyId);
  if (!normalizedKeyId) throw new TypeError("collector keyId is required");
  const normalizedIndependenceDomain = normalizeIndependenceDomain(independenceDomain);
  if (independenceDomain !== null && independenceDomain !== undefined && !normalizedIndependenceDomain) {
    throw new TypeError("collector independenceDomain is invalid");
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = publicKeyFingerprint(publicKeyPem);
  return {
    keyId: normalizedKeyId,
    privateKeyPem,
    publicKeyPem,
    fingerprint,
    registry: {
      version: COLLECTOR_TRUST_REGISTRY_VERSION,
      keys: [{
        keyId: normalizedKeyId,
        algorithm: ED25519_ALGORITHM,
        publicKeyPem,
        fingerprint,
        ...(normalizedIndependenceDomain ? { independenceDomain: normalizedIndependenceDomain } : {}),
        enabled: true,
      }],
    },
  };
};

const signCollectorCommitment = (commitment, { keyId, privateKeyPem } = {}) => {
  const normalizedKeyId = text(keyId);
  if (!normalizedKeyId || !text(privateKeyPem)) throw new TypeError("collector signer requires keyId and privateKeyPem");
  const normalizedCommitment = canonicalize(commitment);
  const commitmentHash = sha256Json(normalizedCommitment);
  const publicKeyPem = publicKeyFromPrivate(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(normalizedCommitment)), privateKeyPem).toString("base64");
  return {
    version: COLLECTOR_ATTESTATION_VERSION,
    algorithm: ED25519_ALGORITHM,
    keyId: normalizedKeyId,
    keyFingerprint: publicKeyFingerprint(publicKeyPem),
    commitmentHash,
    commitment: normalizedCommitment,
    signature,
  };
};

const normalizeCollectorAttestation = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const declaredUntrustedClaims = [
    "publicKey",
    "publicKeyPem",
    "trustedPublicKey",
    "verified",
    "signatureVerified",
  ].filter((field) => Object.prototype.hasOwnProperty.call(value, field));
  const untrustedClaims = [...new Set([
    ...(Array.isArray(value.untrustedClaims) ? value.untrustedClaims.map(text).filter(Boolean) : []),
    ...declaredUntrustedClaims,
  ])].sort();
  let commitment = null;
  try {
    commitment = value.commitment && typeof value.commitment === "object"
      ? canonicalize(value.commitment)
      : null;
  } catch {
    commitment = null;
  }
  return {
    version: text(value.version),
    algorithm: text(value.algorithm),
    keyId: text(value.keyId),
    keyFingerprint: text(value.keyFingerprint)?.toLowerCase() || null,
    commitmentHash: text(value.commitmentHash)?.toLowerCase() || null,
    commitment,
    signature: text(value.signature),
    untrustedClaims,
  };
};

const loadCollectorTrustRegistry = (source = null) => {
  if (source && typeof source === "object" && !Array.isArray(source)) return source;
  const registryPath = text(source) || text(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH);
  if (!registryPath) return null;
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    return null;
  }
};

const registryKey = (registry, keyId) => {
  if (!registry || registry.version !== COLLECTOR_TRUST_REGISTRY_VERSION || !Array.isArray(registry.keys)) return null;
  return registry.keys.find((entry) => entry?.enabled !== false && text(entry?.keyId) === keyId) || null;
};

const collectorIndependenceDomain = (registry, keyId) => normalizeIndependenceDomain(
  registryKey(registry, keyId)?.independenceDomain,
);

const compareExpectedCommitment = (commitment, expected, blockers) => {
  if (!expected) return;
  const pairs = [
    [commitment?.provider, expected.provider, "collector-attestation-provider-mismatch"],
    [commitment?.endpoint?.url, endpointUrl(expected?.endpoint?.url), "collector-attestation-endpoint-url-mismatch"],
    [commitment?.endpoint?.method, text(expected?.endpoint?.method)?.toUpperCase() || null, "collector-attestation-endpoint-method-mismatch"],
    [commitment?.endpoint?.page, integer(expected?.endpoint?.page), "collector-attestation-endpoint-page-mismatch"],
    [commitment?.endpoint?.role, text(expected?.endpoint?.role), "collector-attestation-endpoint-role-mismatch"],
    [commitment?.collectorCycleId, text(expected.collectorCycleId), "collector-attestation-cycle-mismatch"],
    [commitment?.requestedAt, canonicalInstant(expected.requestedAt), "collector-attestation-requested-at-mismatch"],
    [commitment?.receivedAt, canonicalInstant(expected.receivedAt), "collector-attestation-received-at-mismatch"],
    [commitment?.providerObservedAt, canonicalInstant(expected.providerObservedAt), "collector-attestation-provider-observed-at-mismatch"],
    [commitment?.response?.httpStatus, integer(expected?.response?.httpStatus), "collector-attestation-http-status-mismatch"],
    [commitment?.response?.httpDate, text(expected?.response?.httpDate), "collector-attestation-http-date-mismatch"],
    [commitment?.response?.httpEtag, text(expected?.response?.httpEtag), "collector-attestation-http-etag-mismatch"],
    [commitment?.response?.contentType, text(expected?.response?.contentType), "collector-attestation-content-type-mismatch"],
    [commitment?.response?.headersSha256, text(expected?.response?.headersSha256)?.toLowerCase() || null, "collector-attestation-headers-sha256-mismatch"],
    [commitment?.response?.rawSha256, text(expected?.response?.rawSha256)?.toLowerCase() || null, "collector-attestation-raw-sha256-mismatch"],
    [commitment?.response?.rawBytes, integer(expected?.response?.rawBytes), "collector-attestation-raw-bytes-mismatch"],
    [commitment?.canonicalPayloadSha256, text(expected.canonicalPayloadSha256)?.toLowerCase() || null, "collector-attestation-payload-hash-mismatch"],
  ];
  for (const [actual, wanted, blocker] of pairs) {
    if (actual !== wanted) blockers.add(blocker);
  }
  const extractionHash = text(expected.marketExtractionHash)?.toLowerCase();
  if (extractionHash && !commitment?.marketExtractionHashes?.includes(extractionHash)) {
    blockers.add("collector-attestation-market-extraction-not-committed");
  }
};

const verifyCollectorAttestation = (value, options = {}) => {
  const attestation = normalizeCollectorAttestation(value);
  const blockers = new Set();
  if (!attestation) blockers.add("collector-attestation-missing");
  if (attestation?.version !== COLLECTOR_ATTESTATION_VERSION) blockers.add("collector-attestation-version-invalid");
  if (attestation?.algorithm !== ED25519_ALGORITHM) blockers.add("collector-attestation-algorithm-invalid");
  if (!attestation?.keyId) blockers.add("collector-attestation-key-id-missing");
  if (!HASH_PATTERN.test(attestation?.keyFingerprint || "")) blockers.add("collector-attestation-key-fingerprint-invalid");
  if (!HASH_PATTERN.test(attestation?.commitmentHash || "")) blockers.add("collector-attestation-commitment-hash-invalid");
  if (!attestation?.commitment) blockers.add("collector-attestation-commitment-missing");
  if (!attestation?.signature) blockers.add("collector-attestation-signature-missing");
  if (attestation?.untrustedClaims?.length) blockers.add("collector-attestation-untrusted-claim-present");

  if (attestation?.commitment) {
    if (sha256Json(attestation.commitment) !== attestation.commitmentHash) {
      blockers.add("collector-attestation-commitment-hash-mismatch");
    }
    compareExpectedCommitment(attestation.commitment, options.expected, blockers);
    if (options.payload !== undefined
        && sha256Json(options.payload) !== attestation.commitment.canonicalPayloadSha256) {
      blockers.add("collector-attestation-payload-rehash-mismatch");
    }
  }

  const registry = loadCollectorTrustRegistry(options.trustRegistry);
  if (!registry) blockers.add("collector-trust-registry-missing");
  else if (registry.version !== COLLECTOR_TRUST_REGISTRY_VERSION || !Array.isArray(registry.keys)) {
    blockers.add("collector-trust-registry-invalid");
  }
  const key = registryKey(registry, attestation?.keyId);
  if (registry && !key) blockers.add("collector-attestation-key-unknown");
  if (key) {
    try {
      const fingerprint = publicKeyFingerprint(key.publicKeyPem);
      if (text(key.algorithm) !== ED25519_ALGORITHM) blockers.add("collector-trust-key-algorithm-invalid");
      if (text(key.fingerprint)?.toLowerCase() !== fingerprint) blockers.add("collector-trust-key-fingerprint-mismatch");
      if (attestation.keyFingerprint !== fingerprint) blockers.add("collector-attestation-key-fingerprint-mismatch");
      if (attestation.commitment && attestation.signature) {
        const valid = crypto.verify(
          null,
          Buffer.from(canonicalJson(attestation.commitment)),
          key.publicKeyPem,
          Buffer.from(attestation.signature, "base64"),
        );
        if (!valid) blockers.add("collector-attestation-signature-invalid");
      }
    } catch {
      blockers.add("collector-trust-key-invalid");
    }
  }

  const sortedBlockers = [...blockers].sort();
  return {
    eligible: sortedBlockers.length === 0,
    blockers: sortedBlockers,
    attestation,
    keyId: attestation?.keyId || null,
    keyFingerprint: attestation?.keyFingerprint || null,
    commitmentHash: attestation?.commitmentHash || null,
    independenceDomain: collectorIndependenceDomain(registry, attestation?.keyId),
    trustBoundary: options.payload === undefined
      ? "trusted-collector-signed-commitment-raw-response-not-rehashed"
      : "trusted-collector-signature-and-canonical-payload-rehash",
  };
};

module.exports = {
  COLLECTOR_ATTESTATION_VERSION,
  COLLECTOR_COMMITMENT_VERSION,
  COLLECTOR_TRUST_REGISTRY_VERSION,
  ED25519_ALGORITHM,
  HASH_PATTERN,
  INDEPENDENCE_DOMAIN_PATTERN,
  MARKET_EXTRACTION_COMMITMENT_VERSION,
  buildCollectorCommitment,
  buildMarketExtractionCommitment,
  canonicalCollectorJson: canonicalJson,
  collectorIndependenceDomain,
  createCollectorKeyPair,
  extractionFromSportteryPool,
  loadCollectorTrustRegistry,
  marketExtractionCommitmentsFromPayload,
  normalizeCollectorAttestation,
  publicKeyFingerprint,
  sha256CollectorJson: sha256Json,
  signCollectorCommitment,
  verifyCollectorAttestation,
};
