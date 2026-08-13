const crypto = require("node:crypto");
const {
  MARKET_EXTRACTION_COMMITMENT_VERSION,
  buildMarketExtractionCommitment,
  normalizeCollectorAttestation,
  verifyCollectorAttestation,
} = require("./collectorAttestation.cjs");

const MARKET_SOURCE_PROVENANCE_VERSION = "market-source-provenance-v2";
const LEGACY_MARKET_SOURCE_PROVENANCE_VERSION = "market-source-provenance-v1";
const STRICT_POLICY_VERSION = "sporttery-market-source-strict-v2";
const OFFICIAL_SPORTTERY_HOST = "webapi.sporttery.cn";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const textValue = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const canonicalInstant = (value) => {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const integerValue = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
};

const canonicalStringify = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => crypto.createHash("sha256").update(canonicalStringify(value)).digest("hex");

const endpointIdentity = (rawUrl) => {
  const url = textValue(rawUrl);
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || null;
    const official = protocol === "https:"
      && host === OFFICIAL_SPORTTERY_HOST
      && (port === null || port === "443");
    return { url: parsed.toString(), protocol, host, port, official };
  } catch {
    return { url, protocol: null, host: null, port: null, official: false };
  }
};

const uniqueSortedText = (values) => Array.from(new Set((Array.isArray(values) ? values : [])
  .map(textValue)
  .filter(Boolean))).sort();

const normalizeExtraction = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return buildMarketExtractionCommitment({
    sourceMatchId: value.sourceMatchId,
    poolCode: value.poolCode,
    handicapLine: value.handicapLine,
    odds: value.odds,
    providerObservedAt: value.providerObservedAt,
  });
};

const coreFrom = (value = {}) => {
  const endpoint = endpointIdentity(value?.endpoint?.url ?? value?.sourceUrl);
  const providerId = textValue(value?.provider?.id) || "sporttery";
  const poolCode = textValue(value?.market?.poolCode ?? value?.poolCode)?.toUpperCase() || null;
  const method = textValue(value?.endpoint?.method ?? value?.sourceMethod)?.toUpperCase() || null;
  const requestedAt = canonicalInstant(value?.timing?.requestedAt ?? value?.requestedAt);
  const receivedAt = canonicalInstant(value?.timing?.receivedAt ?? value?.receivedAt);
  const providerObservedAt = canonicalInstant(value?.timing?.providerObservedAt ?? value?.providerObservedAt);
  const endpointProviderObservedAt = canonicalInstant(
    value?.timing?.endpointProviderObservedAt
      ?? value?.endpointProviderObservedAt
      ?? providerObservedAt,
  );
  const collectorSourceCycleId = textValue(
    value?.cycles?.collectorSourceCycleId ?? value?.collectorSourceCycleId ?? value?.sourceCycleId,
  );
  const envelopeSourceCycleId = textValue(value?.cycles?.envelopeSourceCycleId ?? value?.envelopeSourceCycleId);
  const constituentSourceCycleIds = uniqueSortedText(
    value?.cycles?.constituentSourceCycleIds ?? value?.constituentSourceCycleIds,
  );
  return {
    version: MARKET_SOURCE_PROVENANCE_VERSION,
    provider: {
      id: providerId,
      official: providerId === "sporttery" && endpoint.official,
    },
    market: {
      poolCode,
      sourceMatchId: textValue(value?.market?.sourceMatchId ?? value?.sourceMatchId),
    },
    endpoint: {
      url: endpoint.url,
      method,
      page: integerValue(value?.endpoint?.page ?? value?.sourcePage),
      role: textValue(value?.endpoint?.role ?? value?.sourceEndpointRole),
      protocol: endpoint.protocol,
      host: endpoint.host,
      port: endpoint.port,
    },
    timing: {
      requestedAt,
      receivedAt,
      providerObservedAt,
      endpointProviderObservedAt,
    },
    response: {
      httpStatus: integerValue(value?.response?.httpStatus ?? value?.httpStatus),
      httpDate: textValue(value?.response?.httpDate ?? value?.httpDate),
      httpEtag: textValue(value?.response?.httpEtag ?? value?.httpEtag),
      contentType: textValue(value?.response?.contentType ?? value?.contentType),
      headersSha256: textValue(value?.response?.headersSha256 ?? value?.headersSha256)?.toLowerCase() || null,
      rawSha256: textValue(value?.response?.rawSha256 ?? value?.rawSha256)?.toLowerCase() || null,
      rawBytes: integerValue(value?.response?.rawBytes ?? value?.rawBytes),
    },
    payload: {
      canonicalSha256: textValue(
        value?.payload?.canonicalSha256 ?? value?.canonicalPayloadSha256,
      )?.toLowerCase() || null,
    },
    extraction: normalizeExtraction(value?.extraction ?? value?.marketExtraction),
    attestation: normalizeCollectorAttestation(
      value?.attestation ?? value?.collectorAttestation,
    ),
    cycles: {
      collectorSourceCycleId,
      envelopeSourceCycleId,
      envelopeCycleKind: textValue(value?.cycles?.envelopeCycleKind ?? value?.envelopeCycleKind),
      constituentSourceCycleIds,
    },
  };
};

const strictAuditForCore = (core, options = {}) => {
  const blockers = [];
  if (core.provider.id !== "sporttery") blockers.push("provider-not-sporttery");
  if (!core.provider.official) blockers.push("endpoint-not-official");
  if (core.endpoint.method !== "GET") blockers.push("endpoint-method-not-get");
  if (!core.endpoint.role) blockers.push("endpoint-role-missing");
  if (!["HAD", "HHAD"].includes(core.market.poolCode)) blockers.push("pool-code-invalid");
  if (!core.market.sourceMatchId) blockers.push("source-match-id-missing");
  if (!core.cycles.collectorSourceCycleId) blockers.push("collector-source-cycle-missing");
  if (!core.timing.requestedAt) blockers.push("requested-at-missing-or-invalid");
  if (!core.timing.receivedAt) blockers.push("received-at-missing-or-invalid");
  if (!core.timing.providerObservedAt) blockers.push("provider-observed-at-missing-or-invalid");
  if (!core.timing.endpointProviderObservedAt) blockers.push("endpoint-provider-observed-at-missing-or-invalid");
  if (core.response.httpStatus === null || core.response.httpStatus < 200 || core.response.httpStatus >= 300) {
    blockers.push("http-status-not-success");
  }
  if (!HASH_PATTERN.test(core.response.rawSha256 || "")) blockers.push("raw-sha256-missing-or-invalid");
  if (!HASH_PATTERN.test(core.response.headersSha256 || "")) blockers.push("headers-sha256-missing-or-invalid");
  if (!Number.isSafeInteger(core.response.rawBytes) || core.response.rawBytes <= 0) {
    blockers.push("raw-bytes-missing-or-invalid");
  }
  if (!HASH_PATTERN.test(core.payload.canonicalSha256 || "")) blockers.push("canonical-payload-sha256-missing-or-invalid");
  const requestedMs = Date.parse(core.timing.requestedAt || "");
  const receivedMs = Date.parse(core.timing.receivedAt || "");
  const observedMs = Date.parse(core.timing.providerObservedAt || "");
  const endpointObservedMs = Date.parse(core.timing.endpointProviderObservedAt || "");
  if (Number.isFinite(requestedMs) && Number.isFinite(receivedMs) && requestedMs > receivedMs) blockers.push("requested-after-received");
  if (Number.isFinite(observedMs) && Number.isFinite(receivedMs) && observedMs > receivedMs) blockers.push("provider-observed-after-received");
  if (Number.isFinite(endpointObservedMs) && Number.isFinite(receivedMs) && endpointObservedMs > receivedMs) {
    blockers.push("endpoint-provider-observed-after-received");
  }

  if (!core.extraction) {
    blockers.push("market-extraction-missing");
  } else {
    if (core.extraction.version !== MARKET_EXTRACTION_COMMITMENT_VERSION) blockers.push("market-extraction-version-invalid");
    if (core.extraction.provider !== "sporttery") blockers.push("market-extraction-provider-invalid");
    if (core.extraction.sourceMatchId !== core.market.sourceMatchId) blockers.push("market-extraction-source-match-mismatch");
    if (core.extraction.poolCode !== core.market.poolCode) blockers.push("market-extraction-pool-mismatch");
    if (!core.extraction.odds) blockers.push("market-extraction-odds-invalid");
    if (core.market.poolCode === "HHAD" && core.extraction.handicapLine === null) blockers.push("market-extraction-handicap-line-invalid");
    if (core.extraction.providerObservedAt !== core.timing.providerObservedAt) blockers.push("market-extraction-observed-at-mismatch");
  }

  const attestationAudit = verifyCollectorAttestation(core.attestation, {
    trustRegistry: options.trustRegistry,
    ...(Object.prototype.hasOwnProperty.call(options, "payload") ? { payload: options.payload } : {}),
    expected: {
      provider: core.provider.id,
      endpoint: core.endpoint,
      collectorCycleId: core.cycles.collectorSourceCycleId,
      requestedAt: core.timing.requestedAt,
      receivedAt: core.timing.receivedAt,
      providerObservedAt: core.timing.endpointProviderObservedAt,
      response: core.response,
      canonicalPayloadSha256: core.payload.canonicalSha256,
      marketExtractionHash: core.extraction?.hash || null,
    },
  });
  blockers.push(...attestationAudit.blockers);
  return {
    blockers: Array.from(new Set(blockers)).sort(),
    attestationAudit,
  };
};

const normalizeMarketSourceProvenance = (value, options = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const core = coreFrom(value);
  const audit = strictAuditForCore(core, options);
  return {
    ...core,
    strict: {
      policyVersion: STRICT_POLICY_VERSION,
      eligible: audit.blockers.length === 0,
      diagnosticOnly: audit.blockers.length > 0,
      blockers: audit.blockers,
      collectorAttestationKeyId: audit.attestationAudit.keyId,
      collectorAttestationKeyFingerprint: audit.attestationAudit.keyFingerprint,
      collectorAttestationCommitmentHash: audit.attestationAudit.commitmentHash,
      trustBoundary: audit.attestationAudit.trustBoundary,
    },
    hash: sha256(core),
  };
};

const buildSportteryMarketSourceProvenance = ({
  poolCode,
  sourceMatchId,
  odds,
  handicapLine,
  marketExtraction = null,
  sourceUrl,
  sourceMethod = "GET",
  sourcePage = null,
  sourceEndpointRole = null,
  providerObservedAt = null,
  sourceTiming = {},
  trustRegistry = null,
} = {}) => normalizeMarketSourceProvenance({
  provider: { id: "sporttery" },
  market: { poolCode, sourceMatchId },
  endpoint: {
    url: sourceUrl,
    method: sourceTiming?.sourceRequest?.method || sourceMethod,
    page: sourceTiming?.sourceRequest?.page ?? sourcePage,
    role: sourceTiming?.sourceRequest?.role || sourceEndpointRole,
  },
  timing: {
    requestedAt: sourceTiming?.requestedAt,
    receivedAt: sourceTiming?.receivedAt,
    providerObservedAt: providerObservedAt || sourceTiming?.providerObservedAt,
    endpointProviderObservedAt: sourceTiming?.providerObservedAt,
  },
  response: {
    httpStatus: sourceTiming?.httpStatus,
    httpDate: sourceTiming?.httpDate,
    httpEtag: sourceTiming?.httpEtag,
    contentType: sourceTiming?.contentType,
    headersSha256: sourceTiming?.headersSha256,
    rawSha256: sourceTiming?.rawSha256,
    rawBytes: sourceTiming?.rawBytes,
  },
  payload: { canonicalSha256: sourceTiming?.canonicalPayloadSha256 },
  extraction: marketExtraction || buildMarketExtractionCommitment({
    sourceMatchId,
    poolCode,
    handicapLine,
    odds,
    providerObservedAt: providerObservedAt || sourceTiming?.providerObservedAt,
  }),
  attestation: sourceTiming?.collectorAttestation,
  cycles: {
    collectorSourceCycleId: sourceTiming?.sourceCycleId,
    envelopeSourceCycleId: sourceTiming?.envelopeSourceCycleId,
    envelopeCycleKind: sourceTiming?.envelopeCycleKind,
    constituentSourceCycleIds: sourceTiming?.constituentSourceCycleIds,
  },
}, {
  trustRegistry,
  ...(Object.prototype.hasOwnProperty.call(sourceTiming, "endpointPayload")
    ? { payload: sourceTiming.endpointPayload }
    : {}),
});

const isStrictMarketSourceProvenance = (value, options = {}) => {
  const normalized = normalizeMarketSourceProvenance(value, options);
  return Boolean(
    normalized
    && normalized.strict.eligible
    && value?.version === MARKET_SOURCE_PROVENANCE_VERSION
    && value?.hash === normalized.hash,
  );
};

const marketSourceLineageId = (values) => {
  const cycles = uniqueSortedText((Array.isArray(values) ? values : [])
    .map((value) => normalizeMarketSourceProvenance(value)?.cycles?.collectorSourceCycleId));
  if (cycles.length === 0) return null;
  if (cycles.length === 1) return cycles[0];
  return `market-source-composite:${sha256(cycles)}`;
};

module.exports = {
  LEGACY_MARKET_SOURCE_PROVENANCE_VERSION,
  MARKET_SOURCE_PROVENANCE_VERSION,
  OFFICIAL_SPORTTERY_HOST,
  STRICT_POLICY_VERSION,
  buildSportteryMarketSourceProvenance,
  canonicalMarketSourceStringify: canonicalStringify,
  isStrictMarketSourceProvenance,
  marketSourceLineageId,
  normalizeMarketSourceProvenance,
};
