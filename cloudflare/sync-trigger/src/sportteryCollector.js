const COLLECTOR_ATTESTATION_VERSION = "sporttery-collector-attestation-v1";
const COLLECTOR_COMMITMENT_VERSION = "sporttery-collector-commitment-v1";
const MARKET_EXTRACTION_VERSION = "sporttery-market-extraction-v1";
const EVIDENCE_UPLOAD_VERSION = "sporttery-collector-evidence-upload-v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const CURRENT_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001";
const CALCULATOR_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had";

const text = (value) => String(value ?? "").trim() || null;

const canonicalInstant = (value) => {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
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
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key], `${location}.${key}`)]));
  }
  throw new TypeError(`${location} contains unsupported ${typeof value}`);
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const hex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const sha256Bytes = async (value) => hex(await crypto.subtle.digest("SHA-256", value));
const sha256Json = async (value) => sha256Bytes(new TextEncoder().encode(canonicalJson(value)));

const base64 = (value) => {
  let binary = "";
  const bytes = new Uint8Array(value);
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const pemDer = (pem) => {
  const encoded = String(pem || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const normalizeOdds = (value) => {
  const odds = {
    "1": finiteNumber(value?.["1"] ?? value?.odds1 ?? value?.home ?? value?.h),
    X: finiteNumber(value?.X ?? value?.oddsX ?? value?.draw ?? value?.d),
    "2": finiteNumber(value?.["2"] ?? value?.odds2 ?? value?.away ?? value?.a),
  };
  return Object.values(odds).every((number) => number !== null && number > 1) ? odds : null;
};

const providerObservedAtFromPool = (poolRow) => {
  const date = text(poolRow?.updateDate);
  const time = text(poolRow?.updateTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}:\d{2}$/.test(time || "")) return null;
  const millis = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const providerObservedAtFromPayload = (payload) => {
  let latest = null;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const poolObservedAt = providerObservedAtFromPool(value);
      const lastUpdateTime = text(value.lastUpdateTime);
      const lastUpdateMs = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(lastUpdateTime || "")
        ? Date.parse(`${lastUpdateTime.replace(" ", "T")}+08:00`)
        : NaN;
      const candidates = [
        poolObservedAt,
        Number.isFinite(lastUpdateMs) ? new Date(lastUpdateMs).toISOString() : null,
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (!latest || Date.parse(candidate) > Date.parse(latest)) latest = candidate;
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(payload);
  return latest;
};

const marketExtractionsFromPayload = async (payload, fallbackObservedAt = null) => {
  const rows = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && text(value.matchId)) {
      for (const poolRow of Array.isArray(value.oddsList) ? value.oddsList : []) {
        const poolCode = text(poolRow?.poolCode)?.toUpperCase() || null;
        if (!["HAD", "HHAD"].includes(poolCode)) continue;
        rows.push({ value, poolRow, poolCode });
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(payload);
  const commitments = [];
  for (const { value, poolRow, poolCode } of rows) {
    const core = {
      version: MARKET_EXTRACTION_VERSION,
      provider: "sporttery",
      sourceMatchId: text(value.matchId),
      poolCode,
      handicapLine: poolCode === "HAD"
        ? "0"
        : canonicalLine(poolRow?.goalLine ?? poolRow?.goalLineValue ?? value?.hhad?.goalLine),
      odds: normalizeOdds(poolRow),
      providerObservedAt: canonicalInstant(providerObservedAtFromPool(poolRow) || fallbackObservedAt),
    };
    if (core.odds && (poolCode !== "HHAD" || core.handicapLine !== null)) {
      commitments.push({ ...core, hash: await sha256Json(core) });
    }
  }
  return commitments.sort((left, right) => left.hash.localeCompare(right.hash));
};

const requestHeaders = (url) => ({
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  origin: "https://m.sporttery.cn",
  referer: url === CALCULATOR_URL
    ? "https://m.sporttery.cn/mjc/jsq/zqhhgg/"
    : "https://m.sporttery.cn/mjc/zqsj/?tab=concern",
});

const responseHeaderObject = (headers) => Object.fromEntries(
  [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right)),
);

const fetchOfficialEndpoint = async ({ id, url, sourceCycleId, env }) => {
  const requestedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { headers: requestHeaders(url), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
    throw new Error(`sporttery ${id} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  const raw = await response.arrayBuffer();
  const receivedAt = new Date().toISOString();
  if (raw.byteLength > MAX_RESPONSE_BYTES) throw new Error(`sporttery ${id} response too large`);
  if (!response.ok) throw new Error(`sporttery ${id} HTTP ${response.status}`);
  const payload = JSON.parse(new TextDecoder().decode(raw));
  if (payload?.success === false) throw new Error(`sporttery ${id} API rejected request`);
  const headers = responseHeaderObject(response.headers);
  const providerObservedAt = providerObservedAtFromPayload(payload);
  const canonicalPayloadSha256 = await sha256Json(payload);
  const marketExtractions = await marketExtractionsFromPayload(payload, providerObservedAt);
  const commitment = {
    version: COLLECTOR_COMMITMENT_VERSION,
    provider: "sporttery",
    endpoint: { url: new URL(url).toString(), method: "GET", page: null, role: id },
    collectorCycleId: sourceCycleId,
    requestedAt,
    receivedAt,
    providerObservedAt,
    response: {
      httpStatus: response.status,
      httpDate: text(response.headers.get("date")),
      httpEtag: text(response.headers.get("etag")),
      contentType: text(response.headers.get("content-type")),
      headersSha256: await sha256Json(headers),
      rawSha256: await sha256Bytes(raw),
      rawBytes: raw.byteLength,
    },
    canonicalPayloadSha256,
    marketExtractionHashes: [...new Set(marketExtractions.map((row) => row.hash))].sort(),
  };
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemDer(env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonicalJson(commitment)),
  );
  const commitmentHash = await sha256Json(commitment);
  const collectorAttestation = {
    version: COLLECTOR_ATTESTATION_VERSION,
    algorithm: "Ed25519",
    keyId: env.SPORTTERY_COLLECTOR_KEY_ID,
    keyFingerprint: env.SPORTTERY_COLLECTOR_KEY_FINGERPRINT,
    commitmentHash,
    commitment,
    signature: base64(signature),
  };
  return {
    id,
    method: id,
    page: null,
    url,
    fetchedAt: receivedAt,
    requestedAt,
    receivedAt,
    sourceCycleId,
    sourceRequest: { url, method: "GET", page: null, role: id },
    collectorRole: id,
    transport: "cloudflare-worker-direct",
    ...commitment.response,
    canonicalPayloadSha256,
    collectorAttestation,
    providerObservedAt,
    collectorProvenance: {
      sourceCycleId,
      requestedAt,
      receivedAt,
      sourceRequest: { url, method: "GET", page: null, role: id },
      transport: "cloudflare-worker-direct",
      ...commitment.response,
      canonicalPayloadSha256,
      collectorAttestation,
    },
    ok: true,
    rows: marketExtractions.length,
    payload,
  };
};

export const sportteryCollectorConfigured = (env) => Boolean(
  env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8
  && env.SPORTTERY_COLLECTOR_KEY_ID
  && /^[a-f0-9]{64}$/.test(String(env.SPORTTERY_COLLECTOR_KEY_FINGERPRINT || ""))
  && env.FOOTBALL_PRODUCTION_ADMIN_TOKEN,
);

export const collectSportteryEvidence = async (env) => {
  if (!sportteryCollectorConfigured(env)) {
    return { ok: true, skipped: true, reason: "collector-secrets-not-configured" };
  }
  const requestedAt = new Date().toISOString();
  const sourceCycleId = `cloudflare-sporttery:${requestedAt.replace(/[^0-9A-Za-z]/g, "")}:${crypto.randomUUID()}`;
  const settled = await Promise.allSettled([
    fetchOfficialEndpoint({ id: "current", url: CURRENT_URL, sourceCycleId, env }),
    fetchOfficialEndpoint({ id: "calculator", url: CALCULATOR_URL, sourceCycleId, env }),
  ]);
  const endpoints = settled.filter((row) => row.status === "fulfilled").map((row) => row.value);
  const errors = settled.filter((row) => row.status === "rejected")
    .map((row) => String(row.reason?.message || row.reason || "collector request failed"));
  if (!endpoints.length) throw new Error(`sporttery collector returned no usable endpoint: ${errors.join("; ")}`);
  const evidence = {
    version: EVIDENCE_UPLOAD_VERSION,
    capturedAt: new Date().toISOString(),
    sourceCycleId,
    endpoints,
  };
  const baseUrl = String(env.FOOTBALL_PRODUCTION_BASE_URL || "https://170.106.75.73").replace(/\/+$/, "");
  const upload = await fetch(`${baseUrl}/api/admin/sporttery-collector-evidence`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.FOOTBALL_PRODUCTION_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(evidence),
  });
  const result = await upload.json().catch(() => null);
  if (!upload.ok || result?.ok !== true) {
    throw new Error(`collector evidence upload failed ${upload.status}: ${result?.error || "rejected"}`);
  }
  return {
    ok: true,
    skipped: false,
    capturedAt: evidence.capturedAt,
    sourceCycleId,
    endpoints: endpoints.length,
    errors,
    acceptedRows: result.acceptedRows,
    storeRows: result.storeRows,
    storeRootHash: result.storeRootHash,
  };
};

export const sportteryCollectorInternals = {
  canonicalJson,
  marketExtractionsFromPayload,
  providerObservedAtFromPayload,
  sha256Json,
};
