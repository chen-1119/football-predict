const crypto = require("node:crypto");
const {
  loadCollectorTrustRegistry,
  verifyCollectorAttestation,
} = require("../src/services/collectorAttestation.cjs");
const {
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
} = require("../scripts/sportteryEndpointContract.cjs");

const MARKET_LANE_METHODS = new Set(["current", "calculator"]);

const relayEntries = (snapshot) => Array.isArray(snapshot?.endpoints)
  ? snapshot.endpoints
  : Array.isArray(snapshot?.entries)
    ? snapshot.entries
    : Array.isArray(snapshot?.payload?.endpoints)
      ? snapshot.payload.endpoints
      : Array.isArray(snapshot?.payloads)
        ? snapshot.payloads
        : [];

const relayMethod = (entry) => String(entry?.method || entry?.id || "")
  .replace(/^method:/, "")
  .split(":")[0]
  .trim()
  .toLowerCase();

const rowsInPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const countBy = (values) => values.reduce((counts, value) => {
  const key = String(value || "unknown");
  counts[key] = Number(counts[key] || 0) + 1;
  return counts;
  }, {});

const relayPage = (entry) => {
  const raw = entry?.page;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
};

const normalizeRelayRoleMethod = (value) => String(value || "")
  .replace(/^method:/, "")
  .split(":")[0]
  .trim()
  .toLowerCase();

const canonicalUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(value || "");
  }
};

const canonicalInstant = (value) => {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const officialFastEndpointUrl = (method, value) => {
  const expected = {
    current: SPORTTERY_CURRENT_URL,
    calculator: SPORTTERY_CALCULATOR_URL,
    result: SPORTTERY_RESULT_URL,
  }[String(method || "").toLowerCase()];
  return Boolean(expected && canonicalUrl(value) === canonicalUrl(expected));
};

const expectedCollectorCommitment = (entry) => {
  const provenance = entry?.collectorProvenance || {};
  const sourceRequest = entry?.sourceRequest || provenance?.sourceRequest || {};
  return {
    provider: "sporttery",
    endpoint: {
      url: sourceRequest.url || entry?.url || null,
      method: sourceRequest.method || "GET",
      page: sourceRequest.page ?? entry?.page ?? null,
      role: sourceRequest.role || entry?.collectorRole || entry?.id || entry?.method || null,
    },
    collectorCycleId: entry?.sourceCycleId || provenance?.sourceCycleId || null,
    requestedAt: entry?.requestedAt || provenance?.requestedAt || null,
    receivedAt: entry?.receivedAt || provenance?.receivedAt || null,
    providerObservedAt: entry?.providerObservedAt ?? provenance?.providerObservedAt ?? null,
    response: {
      httpStatus: entry?.httpStatus ?? provenance?.httpStatus ?? null,
      httpDate: entry?.httpDate ?? provenance?.httpDate ?? null,
      httpEtag: entry?.httpEtag ?? provenance?.httpEtag ?? null,
      contentType: entry?.contentType ?? provenance?.contentType ?? null,
      headersSha256: entry?.headersSha256 || provenance?.headersSha256 || null,
      rawSha256: entry?.rawSha256 || provenance?.rawSha256 || null,
      rawBytes: entry?.rawBytes ?? provenance?.rawBytes ?? null,
    },
    canonicalPayloadSha256: entry?.canonicalPayloadSha256
      || provenance?.canonicalPayloadSha256
      || null,
  };
};

const resultProbeRevisionId = (revision) => {
  if (!revision?.collectorCycleId || !revision?.receivedAt) return null;
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({
      collectorCycleId: revision.collectorCycleId,
      receivedAt: revision.receivedAt,
    }))
    .digest("hex")
    .slice(0, 24);
  return `relay-result-probe:${digest}`;
};

const auditTrustedFastResultEndpoints = (snapshot, options = {}) => {
  const trustRegistry = loadCollectorTrustRegistry(options.trustRegistry);
  const allEntries = relayEntries(snapshot);
  const details = allEntries.map((entry) => ({
    entry,
    method: relayMethod(entry),
    page: relayPage(entry),
  }));
  const fastDetails = details.filter(({ method, page }) => (
    (["current", "calculator"].includes(method) && page === null)
    || (method === "result" && page === 1)
  ));
  const blockers = new Set();
  if (!trustRegistry) blockers.add("collector-trust-registry-missing");
  if (options.allowAdditionalEndpoints !== true && fastDetails.length !== details.length) {
    blockers.add("relay-fast-endpoint-unexpected");
  }
  if (!fastDetails.length) blockers.add("relay-fast-endpoints-missing");

  const keyed = fastDetails.map((detail) => ({
    ...detail,
    key: `${detail.method}:${detail.page === null ? "none" : detail.page}`,
  }));
  if (new Set(keyed.map((detail) => detail.key)).size !== keyed.length) {
    blockers.add("relay-fast-endpoint-key-duplicate");
  }
  for (const detail of keyed) {
    if (
      detail.entry?.ok === false
      || !detail.entry?.payload
      || rowsInPayload(detail.entry.payload) <= 0
    ) blockers.add(`relay-fast-endpoint-unusable:${detail.key}`);
    if (!officialFastEndpointUrl(detail.method, detail.entry?.url)) {
      blockers.add(`relay-fast-endpoint-url-contract-invalid:${detail.key}`);
    }
  }
  const resultDetails = keyed.filter((detail) => detail.method === "result" && detail.page === 1);
  if (resultDetails.length !== 1) blockers.add("relay-fast-result-probe-count-invalid");
  if (
    options.requireMarketLane === true
    && !keyed.some((detail) => MARKET_LANE_METHODS.has(detail.method))
  ) blockers.add("relay-fast-market-lane-missing");

  const audits = keyed.map(({ entry }) => verifyCollectorAttestation(
    entry?.collectorAttestation ?? entry?.collectorProvenance?.collectorAttestation,
    {
      trustRegistry,
      payload: entry?.payload,
      expected: expectedCollectorCommitment(entry),
    },
  ));
  audits.forEach((audit, index) => {
    const detail = keyed[index];
    for (const blocker of audit.blockers || []) blockers.add(`${detail.key}:${blocker}`);
    const commitmentEndpoint = audit?.attestation?.commitment?.endpoint || {};
    const sourceRequest = detail.entry?.sourceRequest
      || detail.entry?.collectorProvenance?.sourceRequest
      || {};
    const idMethod = normalizeRelayRoleMethod(detail.entry?.id || detail.method);
    const sourceRole = normalizeRelayRoleMethod(sourceRequest?.role);
    const collectorRole = normalizeRelayRoleMethod(detail.entry?.collectorRole);
    const commitmentRole = normalizeRelayRoleMethod(commitmentEndpoint?.role);
    const sourcePage = sourceRequest?.page === null
      || sourceRequest?.page === undefined
      || sourceRequest?.page === ""
      ? null
      : Number(sourceRequest.page);
    const commitmentPage = commitmentEndpoint?.page === null
      || commitmentEndpoint?.page === undefined
      ? null
      : Number(commitmentEndpoint.page);
    if (
      idMethod !== detail.method
      || sourceRole !== detail.method
      || collectorRole !== detail.method
      || commitmentRole !== detail.method
      || sourcePage !== detail.page
      || commitmentPage !== detail.page
      || canonicalUrl(detail.entry?.url) !== canonicalUrl(commitmentEndpoint?.url)
    ) blockers.add(`relay-fast-endpoint-binding-invalid:${detail.key}`);
    const commitmentReceivedAt = canonicalInstant(audit?.attestation?.commitment?.receivedAt);
    const declaredFetchedAt = detail.entry?.fetchedAt === null
      || detail.entry?.fetchedAt === undefined
      || detail.entry?.fetchedAt === ""
      ? commitmentReceivedAt
      : canonicalInstant(detail.entry.fetchedAt);
    if (!commitmentReceivedAt || declaredFetchedAt !== commitmentReceivedAt) {
      blockers.add(`relay-fast-endpoint-clock-binding-invalid:${detail.key}`);
    }
  });

  const resultIndex = resultDetails.length === 1 ? keyed.indexOf(resultDetails[0]) : -1;
  const resultAudit = resultIndex >= 0 ? audits[resultIndex] : null;
  const resultCommitment = resultAudit?.eligible === true
    ? resultAudit?.attestation?.commitment
    : null;
  const resultProbeRevision = resultCommitment?.collectorCycleId && resultCommitment?.receivedAt
    ? {
        collectorCycleId: resultCommitment.collectorCycleId,
        receivedAt: resultCommitment.receivedAt,
        commitmentHash: resultAudit.commitmentHash || null,
        keyId: resultAudit.keyId || null,
      }
    : null;
  if (!resultProbeRevision) blockers.add("relay-fast-result-probe-revision-missing");

  return {
    eligible: blockers.size === 0,
    blockers: [...blockers].sort(),
    trustRegistryAvailable: Boolean(trustRegistry),
    entries: keyed.map((detail) => detail.entry),
    details: keyed,
    audits,
    resultEndpoint: resultDetails[0]?.entry || null,
    resultProbeRevision,
    resultProbeRevisionId: resultProbeRevisionId(resultProbeRevision),
  };
};

const summarizeTrustedMarketCollectorEvidence = (snapshot, options = {}) => {
  const trustRegistry = loadCollectorTrustRegistry(options.trustRegistry);
  const endpoints = relayEntries(snapshot).filter((entry) => (
    entry?.ok !== false
    && entry?.payload
    && rowsInPayload(entry.payload) > 0
    && MARKET_LANE_METHODS.has(relayMethod(entry))
  ));
  const audits = endpoints.map((entry) => verifyCollectorAttestation(
    entry?.collectorAttestation ?? entry?.collectorProvenance?.collectorAttestation,
    {
      trustRegistry,
      payload: entry.payload,
      expected: expectedCollectorCommitment(entry),
    },
  ));
  const trusted = audits.filter((audit) => audit.eligible === true);
  const keyIds = [...new Set(trusted.map((audit) => audit.keyId).filter(Boolean))].sort();
  const independenceDomains = [...new Set(
    trusted.map((audit) => audit.independenceDomain).filter(Boolean),
  )].sort();
  const unassignedKeyIds = [...new Set(
    trusted
      .filter((audit) => !audit.independenceDomain)
      .map((audit) => audit.keyId)
      .filter(Boolean),
  )].sort();
  const blockerCounts = countBy(audits.flatMap((audit) => audit.blockers || []));
  if (unassignedKeyIds.length) {
    blockerCounts["collector-independence-domain-missing"] = unassignedKeyIds.length;
  }

  return {
    version: "trusted-market-collector-evidence-v1",
    scope: "current-market-lane",
    trustRegistryAvailable: Boolean(trustRegistry),
    eligibleEndpoints: endpoints.length,
    trustedEndpoints: trusted.length,
    trustedKeyCount: keyIds.length,
    trustedCollectorCount: independenceDomains.length,
    keyIds,
    independenceDomains,
    unassignedKeyIds,
    blockerCounts,
  };
};

module.exports = {
  auditTrustedFastResultEndpoints,
  expectedCollectorCommitment,
  officialFastEndpointUrl,
  relayEntries,
  relayMethod,
  relayPage,
  resultProbeRevisionId,
  summarizeTrustedMarketCollectorEvidence,
};
