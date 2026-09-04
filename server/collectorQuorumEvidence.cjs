const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalCollectorJson,
  collectorIndependenceDomain,
  loadCollectorTrustRegistry,
  marketExtractionCommitmentsFromPayload,
  verifyCollectorAttestation,
} = require("../src/services/collectorAttestation.cjs");
const {
  expectedCollectorCommitment,
  relayEntries,
  relayMethod,
} = require("./relayCollectorEvidence.cjs");

const COLLECTOR_EVIDENCE_UPLOAD_VERSION = "sporttery-collector-evidence-upload-v1";
const COLLECTOR_EVIDENCE_STORE_VERSION = "sporttery-collector-evidence-store-v1";
const COLLECTOR_QUORUM_VERSION = "sporttery-market-collector-quorum-v1";
const MARKET_METHODS = new Set(["current", "calculator"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 1024;
const MAX_UPLOAD_ENDPOINTS = 4;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const instantMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value) => {
  const parsed = instantMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const sha256 = (value) => crypto
  .createHash("sha256")
  .update(canonicalCollectorJson(value))
  .digest("hex");

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Preserve the original write outcome.
    }
  }
};

const normalizedStore = (value) => ({
  version: COLLECTOR_EVIDENCE_STORE_VERSION,
  updatedAt: iso(value?.updatedAt),
  rows: Array.isArray(value?.rows) ? value.rows.filter(Boolean) : [],
});

const summarizeRecentCollectorEvidenceStore = ({
  evidenceStore,
  trustRegistry: trustRegistryInput,
  now = new Date().toISOString(),
  maxAgeMinutes = 20,
} = {}) => {
  const trustRegistry = loadCollectorTrustRegistry(trustRegistryInput);
  const nowMs = instantMs(now) ?? Date.now();
  const ageMs = Math.max(1, Number(maxAgeMinutes || 20)) * 60_000;
  const floorMs = nowMs - ageMs;
  const byDomain = new Map();
  let recentRows = 0;
  for (const row of normalizedStore(evidenceStore).rows) {
    const receivedMs = instantMs(row?.receivedAt);
    const acceptedMs = instantMs(row?.acceptedAt);
    const method = String(row?.method || "").trim().toLowerCase();
    const domain = collectorIndependenceDomain(trustRegistry, String(row?.keyId || "").trim());
    if (
      !MARKET_METHODS.has(method)
      || !domain
      || receivedMs === null
      || acceptedMs === null
      || receivedMs < floorMs
      || acceptedMs < floorMs
      || receivedMs > nowMs + MAX_FUTURE_SKEW_MS
      || acceptedMs > nowMs + MAX_FUTURE_SKEW_MS
    ) continue;
    recentRows += 1;
    const current = byDomain.get(domain) || {
      independenceDomain: domain,
      keyIds: new Set(),
      methods: new Set(),
      latestReceivedAt: null,
    };
    current.keyIds.add(row.keyId);
    current.methods.add(method);
    if (!current.latestReceivedAt || receivedMs > instantMs(current.latestReceivedAt)) {
      current.latestReceivedAt = new Date(receivedMs).toISOString();
    }
    byDomain.set(domain, current);
  }
  const domains = [...byDomain.values()]
    .filter((row) => row.methods.has("current") && row.methods.has("calculator"))
    .map((row) => ({
      independenceDomain: row.independenceDomain,
      keyIds: [...row.keyIds].sort(),
      methods: [...row.methods].sort(),
      latestReceivedAt: row.latestReceivedAt,
    }))
    .sort((left, right) => left.independenceDomain.localeCompare(right.independenceDomain));
  return {
    version: "sporttery-recent-collector-evidence-summary-v1",
    trustRegistryAvailable: Boolean(trustRegistry),
    maxAgeMinutes: Number(maxAgeMinutes),
    recentRows,
    trustedCollectorCount: domains.length,
    independenceDomains: domains.map((row) => row.independenceDomain),
    keyIds: [...new Set(domains.flatMap((row) => row.keyIds))].sort(),
    domains,
  };
};

const evidenceRowFromEndpoint = (entry, {
  trustRegistry,
  acceptedAt,
} = {}) => {
  const blockers = [];
  const acceptedMs = instantMs(acceptedAt);
  const method = relayMethod(entry);
  if (!MARKET_METHODS.has(method)) blockers.push("collector-evidence-endpoint-method-not-market-lane");
  if (!entry?.payload || typeof entry.payload !== "object") blockers.push("collector-evidence-payload-missing");
  const audit = verifyCollectorAttestation(
    entry?.collectorAttestation ?? entry?.collectorProvenance?.collectorAttestation,
    {
      trustRegistry,
      payload: entry?.payload,
      expected: expectedCollectorCommitment(entry),
    },
  );
  blockers.push(...audit.blockers);
  if (!audit.independenceDomain) blockers.push("collector-independence-domain-missing");
  const requestedAt = iso(entry?.requestedAt || entry?.collectorProvenance?.requestedAt);
  const receivedAt = iso(entry?.receivedAt || entry?.collectorProvenance?.receivedAt);
  const requestedMs = instantMs(requestedAt);
  const receivedMs = instantMs(receivedAt);
  if (acceptedMs === null) blockers.push("collector-evidence-accepted-at-invalid");
  if (requestedMs === null) blockers.push("collector-evidence-requested-at-invalid");
  if (receivedMs === null) blockers.push("collector-evidence-received-at-invalid");
  if (requestedMs !== null && receivedMs !== null && receivedMs < requestedMs) {
    blockers.push("collector-evidence-received-before-requested");
  }
  if (receivedMs !== null && acceptedMs !== null && receivedMs > acceptedMs + MAX_FUTURE_SKEW_MS) {
    blockers.push("collector-evidence-received-clock-in-future");
  }
  const providerObservedAt = iso(
    entry?.providerObservedAt || entry?.collectorProvenance?.providerObservedAt,
  );
  const extractions = entry?.payload
    ? marketExtractionCommitmentsFromPayload(entry.payload, providerObservedAt)
      .filter((row) => ["HAD", "HHAD"].includes(row?.poolCode) && HASH_PATTERN.test(row?.hash || ""))
    : [];
  if (!extractions.length) blockers.push("collector-evidence-market-extractions-missing");
  const uniqueBlockers = [...new Set(blockers)].sort();
  if (uniqueBlockers.length) {
    return { accepted: false, blockers: uniqueBlockers, audit };
  }
  const commitmentHash = String(audit.commitmentHash || "").toLowerCase();
  const rowCore = {
    version: "sporttery-collector-evidence-row-v1",
    acceptedAt: iso(acceptedAt),
    keyId: audit.keyId,
    independenceDomain: audit.independenceDomain,
    method,
    sourceCycleId: String(
      entry?.sourceCycleId || entry?.collectorProvenance?.sourceCycleId || "",
    ).trim() || null,
    requestedAt,
    receivedAt,
    providerObservedAt,
    commitmentHash,
    canonicalPayloadSha256: String(
      audit?.attestation?.commitment?.canonicalPayloadSha256 || "",
    ).toLowerCase() || null,
    marketExtractions: extractions,
  };
  return {
    accepted: true,
    blockers: [],
    audit,
    row: {
      ...rowCore,
      evidenceId: sha256({
        keyId: rowCore.keyId,
        commitmentHash: rowCore.commitmentHash,
      }),
    },
  };
};

const validateCollectorEvidenceUpload = (upload, options = {}) => {
  const trustRegistry = loadCollectorTrustRegistry(options.trustRegistry);
  const acceptedAt = iso(options.acceptedAt || new Date().toISOString());
  const blockers = [];
  if (upload?.version !== COLLECTOR_EVIDENCE_UPLOAD_VERSION) {
    blockers.push("collector-evidence-upload-version-invalid");
  }
  const endpoints = relayEntries(upload);
  if (!endpoints.length) blockers.push("collector-evidence-upload-endpoints-missing");
  if (endpoints.length > MAX_UPLOAD_ENDPOINTS) blockers.push("collector-evidence-upload-too-many-endpoints");
  if (!trustRegistry) blockers.push("collector-trust-registry-missing");
  const audits = endpoints.slice(0, MAX_UPLOAD_ENDPOINTS).map((entry) => (
    evidenceRowFromEndpoint(entry, { trustRegistry, acceptedAt })
  ));
  const rows = audits.filter((audit) => audit.accepted).map((audit) => audit.row);
  const endpointBlockers = audits.flatMap((audit) => audit.blockers);
  blockers.push(...endpointBlockers);
  return {
    ok: blockers.length === 0 && rows.length === endpoints.length,
    version: COLLECTOR_EVIDENCE_UPLOAD_VERSION,
    acceptedAt,
    endpoints: endpoints.length,
    acceptedRows: rows.length,
    rows,
    blockers: [...new Set(blockers)].sort(),
  };
};

const mergeCollectorEvidenceStore = (prior, rows, {
  now = new Date().toISOString(),
  retentionMs = DEFAULT_RETENTION_MS,
  maxRows = DEFAULT_MAX_ROWS,
} = {}) => {
  const nowMs = instantMs(now) ?? Date.now();
  const floor = nowMs - Math.max(60_000, Number(retentionMs || DEFAULT_RETENTION_MS));
  const byId = new Map();
  for (const row of [...normalizedStore(prior).rows, ...(Array.isArray(rows) ? rows : [])]) {
    const acceptedMs = instantMs(row?.acceptedAt);
    if (!row?.evidenceId || acceptedMs === null || acceptedMs < floor || acceptedMs > nowMs + MAX_FUTURE_SKEW_MS) {
      continue;
    }
    const current = byId.get(row.evidenceId);
    if (!current || instantMs(current.acceptedAt) < acceptedMs) byId.set(row.evidenceId, row);
  }
  const mergedRows = [...byId.values()]
    .sort((left, right) => (
      instantMs(right.acceptedAt) - instantMs(left.acceptedAt)
      || String(left.evidenceId).localeCompare(String(right.evidenceId))
    ))
    .slice(0, Math.max(1, Number(maxRows || DEFAULT_MAX_ROWS)));
  return {
    version: COLLECTOR_EVIDENCE_STORE_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    rows: mergedRows,
  };
};

const appendCollectorEvidenceUpload = (filePath, upload, options = {}) => {
  const validation = validateCollectorEvidenceUpload(upload, options);
  if (!validation.ok) return { ...validation, stored: false };
  const store = mergeCollectorEvidenceStore(
    readJson(filePath, null),
    validation.rows,
    { now: validation.acceptedAt },
  );
  writeJsonAtomic(filePath, store);
  return {
    ...validation,
    stored: true,
    storeRows: store.rows.length,
    storeRootHash: sha256(store),
  };
};

const decisionMarket = (snapshot, poolCode) => (
  snapshot?.decisionSnapshot?.markets?.[poolCode]
  || snapshot?.decision?.markets?.[poolCode]
  || snapshot?.markets?.[poolCode]
  || null
);

const proofForPrimaryMarket = (market, poolCode, trustRegistry) => {
  const strict = market?.provenance?.strict || {};
  const keyId = String(strict.collectorAttestationKeyId || "").trim();
  const independenceDomain = collectorIndependenceDomain(trustRegistry, keyId);
  const extractionHash = String(market?.provenance?.extraction?.hash || "").toLowerCase();
  const commitmentHash = String(strict.collectorAttestationCommitmentHash || "").toLowerCase();
  if (!keyId || !independenceDomain || !HASH_PATTERN.test(extractionHash) || !HASH_PATTERN.test(commitmentHash)) {
    return null;
  }
  return {
    poolCode,
    keyId,
    independenceDomain,
    extractionHash,
    commitmentHash,
    source: "atomic-decision-snapshot",
  };
};

const collectorQuorumForDecision = ({
  snapshot,
  deadlineAt,
  evidenceStore,
  trustRegistry: trustRegistryInput,
} = {}) => {
  const trustRegistry = loadCollectorTrustRegistry(trustRegistryInput);
  const deadlineMs = instantMs(deadlineAt);
  const markets = {};
  for (const poolCode of ["HAD", "HHAD"]) {
    const market = decisionMarket(snapshot, poolCode);
    const extractionHash = String(market?.provenance?.extraction?.hash || "").toLowerCase();
    const proofs = [];
    const primary = proofForPrimaryMarket(market, poolCode, trustRegistry);
    if (primary) proofs.push(primary);
    for (const row of normalizedStore(evidenceStore).rows) {
      const acceptedMs = instantMs(row?.acceptedAt);
      const receivedMs = instantMs(row?.receivedAt);
      if (deadlineMs === null || acceptedMs === null || receivedMs === null) continue;
      if (acceptedMs > deadlineMs || receivedMs > deadlineMs) continue;
      const extraction = (Array.isArray(row?.marketExtractions) ? row.marketExtractions : [])
        .find((item) => item?.poolCode === poolCode && item?.hash === extractionHash);
      if (!extraction || !row?.independenceDomain || !row?.keyId) continue;
      proofs.push({
        poolCode,
        keyId: row.keyId,
        independenceDomain: row.independenceDomain,
        extractionHash,
        commitmentHash: row.commitmentHash,
        acceptedAt: row.acceptedAt,
        receivedAt: row.receivedAt,
        evidenceId: row.evidenceId,
        source: "collector-evidence-store",
      });
    }
    const byDomain = new Map();
    for (const proof of proofs) {
      const current = byDomain.get(proof.independenceDomain);
      if (!current || String(proof.commitmentHash).localeCompare(String(current.commitmentHash)) < 0) {
        byDomain.set(proof.independenceDomain, proof);
      }
    }
    markets[poolCode] = {
      extractionHash: HASH_PATTERN.test(extractionHash) ? extractionHash : null,
      independenceDomains: [...byDomain.keys()].sort(),
      proofs: [...byDomain.values()].sort((left, right) => (
        left.independenceDomain.localeCompare(right.independenceDomain)
      )),
    };
  }
  const hhadDomains = new Set(markets.HHAD.independenceDomains);
  const jointIndependenceDomains = markets.HAD.independenceDomains
    .filter((domain) => hhadDomains.has(domain));
  const core = {
    version: COLLECTOR_QUORUM_VERSION,
    deadlineAt: iso(deadlineAt),
    markets,
    jointIndependenceDomains,
    trustedCollectorCount: jointIndependenceDomains.length,
    singleAttestor: jointIndependenceDomains.length < 2,
  };
  return { ...core, hash: sha256(core) };
};

module.exports = {
  COLLECTOR_EVIDENCE_STORE_VERSION,
  COLLECTOR_EVIDENCE_UPLOAD_VERSION,
  COLLECTOR_QUORUM_VERSION,
  appendCollectorEvidenceUpload,
  collectorQuorumForDecision,
  evidenceRowFromEndpoint,
  mergeCollectorEvidenceStore,
  normalizedStore,
  summarizeRecentCollectorEvidenceStore,
  validateCollectorEvidenceUpload,
};
