const COLLECTOR_ATTESTATION_VERSION = "sporttery-collector-attestation-v1";
const COLLECTOR_COMMITMENT_VERSION = "sporttery-collector-commitment-v1";
const MARKET_EXTRACTION_VERSION = "sporttery-market-extraction-v1";
const EVIDENCE_UPLOAD_VERSION = "sporttery-collector-evidence-upload-v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const CURRENT_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001";
const CALCULATOR_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had";
const RESULT_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry?matchPage=0";
const MARKET_ENDPOINT_IDS = new Set(["current", "calculator"]);
const RESULT_OBSERVATION_FIELDS = [...new Set([
  "matchId",
  "matchNum",
  "matchNumDate",
  "matchNumStr",
  "businessDate",
  "matchDate",
  "matchTime",
  "homeTeamAllName",
  "homeTeamAbbName",
  "awayTeamAllName",
  "awayTeamAbbName",
  "homeTeamCode",
  "homeTeamAbbEnName",
  "awayTeamCode",
  "awayTeamAbbEnName",
  "matchStatus",
  "sellStatus",
  "matchStatusName",
  "matchResultStatus",
  "poolStatus",
  "sectionsNo999",
  "sectionsNo1",
  "fullScore",
  "finalScore",
  "matchScore",
  "currentScore",
  "liveScore",
  "score",
  "homeScore",
  "homeTeamScore",
  "homeGoals",
  "homeGoal",
  "homeFullScore",
  "homeLiveScore",
  "awayScore",
  "awayTeamScore",
  "awayGoals",
  "awayGoal",
  "awayFullScore",
  "awayLiveScore",
  "sectionsNo2",
  "sectionsNo3",
  "sectionsNo4",
  "sectionsNo5",
  "result",
  "sourceUpdatedAt",
  "updatedAt",
  "updateTime",
  "lastUpdateTime",
  "matchUpdateTime",
  "officialResultIdentity",
  "officialPayoutSp",
])];

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

const boundedMilliseconds = (value, fallback, { min = 10, max = 60_000 } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
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

const providerInstant = (value) => {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw || "")) return null;
  const parsed = Date.parse(`${raw.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const normalizeOfficialResultPayload = (payload) => {
  const rows = Array.isArray(payload?.value?.matchResult) ? payload.value.matchResult : null;
  if (!rows) return payload;
  const lastUpdateTime = text(payload?.value?.lastUpdateTime);
  const providerUpdatedAt = providerInstant(lastUpdateTime);
  const grouped = new Map();
  for (const rawRow of rows) {
    const {
      h,
      d,
      a,
      oddsList: _oddsList,
      had: _had,
      hhad: _hhad,
      ...sourceRow
    } = rawRow && typeof rawRow === "object" ? rawRow : {};
    const finalScore = text(sourceRow.sectionsNo999) || "";
    const voidResult = /无效场次|取消/.test(finalScore);
    const settled = /^\d+\s*:\s*\d+$/.test(finalScore);
    const businessDate = text(sourceRow.matchDate) || "unknown";
    const normalized = {
      ...sourceRow,
      homeTeamAllName: text(sourceRow.allHomeTeam || sourceRow.homeTeam) || "",
      homeTeamAbbName: text(sourceRow.homeTeam || sourceRow.allHomeTeam) || "",
      awayTeamAllName: text(sourceRow.allAwayTeam || sourceRow.awayTeam) || "",
      awayTeamAbbName: text(sourceRow.awayTeam || sourceRow.allAwayTeam) || "",
      leagueAllName: text(sourceRow.leagueName || sourceRow.leagueNameAbbr) || "",
      leagueAbbName: text(sourceRow.leagueNameAbbr || sourceRow.leagueName) || "",
      matchStatus: voidResult ? "12" : settled ? "11" : "10",
      matchStatusName: voidResult ? "比赛取消" : settled ? "赛果" : "等待官方赛果",
      sellStatus: text(sourceRow.poolStatus) || "",
      ...(providerUpdatedAt ? { sourceUpdatedAt: providerUpdatedAt } : {}),
      officialResultIdentity: {
        provider: "sporttery",
        endpoint: "getUniformMatchResultV1",
        matchId: text(sourceRow.matchId) || "",
        matchResultStatus: text(sourceRow.matchResultStatus) || "",
        poolStatus: text(sourceRow.poolStatus) || "",
        providerUpdatedAt,
        scheduleTimeAuthority: "omitted-by-official-result-feed",
      },
      // Result-page SP values are post-match payout data. Keeping them out of
      // h/d/a prevents this lane from ever mutating pre-match recommendation odds.
      officialPayoutSp: {
        h: text(h),
        d: text(d),
        a: text(a),
      },
    };
    if (!grouped.has(businessDate)) grouped.set(businessDate, []);
    grouped.get(businessDate).push(normalized);
  }
  const {
    matchResult: _rawMatchResult,
    ...safeValue
  } = payload.value;
  return {
    ...payload,
    value: {
      ...safeValue,
      matchInfoList: [...grouped.entries()].map(([businessDate, subMatchList]) => ({
        businessDate,
        subMatchList,
      })),
      officialResultFeed: {
        endpoint: RESULT_URL,
        resultCount: rows.length,
        lastUpdateTime: lastUpdateTime || null,
        scope: "latest-official-payout-results",
      },
    },
  };
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
  origin: url === RESULT_URL ? "https://www.sporttery.cn" : "https://m.sporttery.cn",
  referer: url === RESULT_URL
    ? "https://www.sporttery.cn/ltkj/"
    : url === CALCULATOR_URL
      ? "https://m.sporttery.cn/mjc/jsq/zqhhgg/"
      : "https://m.sporttery.cn/mjc/zqsj/?tab=concern",
});

const collectorTransport = (env) => {
  const value = text(env.SPORTTERY_COLLECTOR_TRANSPORT) || "cloudflare-worker-direct";
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value) ? value : "cloudflare-worker-direct";
};

const collectorCyclePrefix = (env) => {
  const value = text(env.SPORTTERY_COLLECTOR_CYCLE_PREFIX) || "cloudflare-sporttery";
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value) ? value : "cloudflare-sporttery";
};

const responseHeaderObject = (headers) => Object.fromEntries(
  [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right)),
);

const fetchOfficialEndpoint = async ({ id, url, page = null, sourceCycleId, env }) => {
  const requestedAt = new Date().toISOString();
  const controller = new AbortController();
  const requestTimeoutMs = boundedMilliseconds(
    env.SPORTTERY_COLLECTOR_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  let raw;
  try {
    response = await fetch(url, { headers: requestHeaders(url), signal: controller.signal });
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
      throw new Error(`sporttery ${id} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    // Keep the abort timer armed until the complete body has been consumed.
    // Receiving headers alone is not a successful bounded collection.
    raw = await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
  const receivedAt = new Date().toISOString();
  if (raw.byteLength > MAX_RESPONSE_BYTES) throw new Error(`sporttery ${id} response too large`);
  if (!response.ok) throw new Error(`sporttery ${id} HTTP ${response.status}`);
  const decodedPayload = JSON.parse(new TextDecoder().decode(raw));
  if (decodedPayload?.success === false) throw new Error(`sporttery ${id} API rejected request`);
  const payload = id === "result"
    ? normalizeOfficialResultPayload(decodedPayload)
    : decodedPayload;
  const headers = responseHeaderObject(response.headers);
  const providerObservedAt = providerObservedAtFromPayload(payload);
  const canonicalPayloadSha256 = await sha256Json(payload);
  const marketExtractions = await marketExtractionsFromPayload(payload, providerObservedAt);
  const commitment = {
    version: COLLECTOR_COMMITMENT_VERSION,
    provider: "sporttery",
    endpoint: { url: new URL(url).toString(), method: "GET", page, role: id },
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
    page,
    url,
    fetchedAt: receivedAt,
    requestedAt,
    receivedAt,
    sourceCycleId,
    sourceRequest: { url, method: "GET", page, role: id },
    collectorRole: id,
    transport: collectorTransport(env),
    ...commitment.response,
    canonicalPayloadSha256,
    collectorAttestation,
    providerObservedAt,
    collectorProvenance: {
      sourceCycleId,
      requestedAt,
      receivedAt,
      sourceRequest: { url, method: "GET", page, role: id },
      transport: collectorTransport(env),
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
);

const endpointDefinitions = ({ includeResult = false } = {}) => [
  { id: "current", url: CURRENT_URL, page: null },
  { id: "calculator", url: CALCULATOR_URL, page: null },
  ...(includeResult ? [{ id: "result", url: RESULT_URL, page: 1 }] : []),
];

const collectEndpointSet = async (env, { includeResult = false } = {}) => {
  const requestedAt = new Date().toISOString();
  const sourceCycleId = `${collectorCyclePrefix(env)}:${requestedAt.replace(/[^0-9A-Za-z]/g, "")}:${crypto.randomUUID()}`;
  const definitions = endpointDefinitions({ includeResult });
  const settled = await Promise.allSettled(definitions.map((definition) => (
    fetchOfficialEndpoint({ ...definition, sourceCycleId, env })
  )));
  const endpoints = [];
  const errors = [];
  settled.forEach((row, index) => {
    const definition = definitions[index];
    if (row.status === "fulfilled") {
      endpoints.push(row.value);
      return;
    }
    errors.push({
      id: definition.id,
      method: definition.id,
      page: definition.page,
      url: definition.url,
      sourceCycleId,
      collectorProvenance: { sourceCycleId },
      error: String(row.reason?.message || row.reason || "collector request failed"),
    });
  });
  const completedAt = new Date().toISOString();
  if (!endpoints.length) {
    throw new Error(`sporttery collector returned no usable endpoint: ${errors.map((row) => row.error).join("; ")}`);
  }
  return { requestedAt, completedAt, sourceCycleId, endpoints, errors };
};

const evidenceUploadFromCollection = (collection) => ({
  version: EVIDENCE_UPLOAD_VERSION,
  capturedAt: collection.completedAt,
  sourceCycleId: collection.sourceCycleId,
  endpoints: collection.endpoints.filter((endpoint) => MARKET_ENDPOINT_IDS.has(endpoint.id)),
  errors: collection.errors.filter((error) => MARKET_ENDPOINT_IDS.has(error.id)),
});

const rowsInRelayPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const usableRelayEndpoint = (endpoint) => Boolean(
  endpoint?.payload
  && endpoint.ok !== false
  && rowsInRelayPayload(endpoint.payload) > 0
);

const resultObservationRows = (resultEndpoint) => {
  const rows = [];
  for (const day of resultEndpoint?.payload?.value?.matchInfoList || []) {
    for (const row of Array.isArray(day?.subMatchList) ? day.subMatchList : []) {
      const observation = {};
      for (const field of RESULT_OBSERVATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(row, field)) observation[field] = row[field];
      }
      rows.push(observation);
    }
  }
  return rows.sort((left, right) => {
    const leftKey = `${left.matchId ?? ""}:${left.matchNumDate ?? ""}:${left.matchNum ?? ""}`;
    const rightKey = `${right.matchId ?? ""}:${right.matchNumDate ?? ""}:${right.matchNum ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
};

const fastResultConstituent = (endpoint, role) => {
  const preserved = Array.isArray(endpoint?.fastResultConstituent?.sourceCycleIds)
    ? endpoint.fastResultConstituent.sourceCycleIds.map(text).filter(Boolean)
    : [];
  const sourceCycleIds = [...new Set(preserved.length ? preserved : [
    endpoint?.sourceCycleId,
    endpoint?.collectorProvenance?.sourceCycleId,
  ].map(text).filter(Boolean))].sort();
  return {
    ...endpoint,
    fastResultConstituent: {
      role,
      sourceCycleIds,
      sourceCycleId: sourceCycleIds.length === 1 ? sourceCycleIds[0] : null,
      mixedSourceCycles: sourceCycleIds.length > 1,
      provenancePreserved: true,
    },
  };
};

const createFastLaneSnapshot = async (collection, env) => {
  const resultEndpoint = collection.endpoints.find((endpoint) => (
    endpoint.id === "result" && Number(endpoint.page) === 1 && usableRelayEndpoint(endpoint)
  ));
  const companionEndpoints = collection.endpoints.filter((endpoint) => (
    MARKET_ENDPOINT_IDS.has(endpoint.id) && usableRelayEndpoint(endpoint)
  ));
  if (!resultEndpoint || !companionEndpoints.length) return null;
  const resultObservations = resultObservationRows(resultEndpoint);
  if (!resultObservations.length) return null;
  const resultFingerprint = await sha256Json(resultObservations);
  const endpoints = [
    ...companionEndpoints.map((endpoint) => fastResultConstituent(endpoint, "companion")),
    fastResultConstituent(resultEndpoint, "probe"),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const methods = [...new Set(endpoints.map((endpoint) => endpoint.id))];
  const capturedMs = Math.max(...endpoints.map((endpoint) => Date.parse(endpoint.receivedAt || "")));
  if (!Number.isFinite(capturedMs)) return null;
  const mergeCreatedMs = Math.max(Date.parse(collection.completedAt || ""), capturedMs);
  if (!Number.isFinite(mergeCreatedMs)) return null;
  const mergeCreatedAt = new Date(mergeCreatedMs).toISOString();
  const uploadCycleId = `sporttery-fast-upload-merge:${mergeCreatedAt.replace(/[^0-9A-Za-z]/g, "")}:${crypto.randomUUID()}`;
  const constituentCycleIds = [...new Set(endpoints.flatMap((endpoint) => (
    endpoint.fastResultConstituent.sourceCycleIds
  )))].sort();
  const mixedCollectorSourceCycles = constituentCycleIds.length > 1;
  const rows = endpoints.reduce((sum, endpoint) => sum + rowsInRelayPayload(endpoint.payload), 0);
  const sourceProducer = {
    runtime: collectorTransport(env),
    resultAuthority: "official-settlement-only",
    preMatchOddsMutation: "disabled",
  };
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt: new Date(capturedMs).toISOString(),
    sourceCycleId: uploadCycleId,
    sourceCycleKind: "upload-merge",
    uploadCycleId,
    mergeCycleId: uploadCycleId,
    mergeCreatedAt,
    constituentCycleIds,
    collectorSourceCycleId: constituentCycleIds.length === 1 ? constituentCycleIds[0] : null,
    mixedCollectorSourceCycles,
    provenanceVersion: 2,
    collectorProvenance: {
      sourceCycleId: uploadCycleId,
      cycleKind: "upload-merge",
      mergeCreatedAt,
      constituentCycleIds,
      mixedCollectorSourceCycles,
      endpointObservationClocks: "preserved-from-constituent-collectors",
    },
    maxAgeMinutes: 20,
    producer: {
      ...sourceProducer,
      fastResultLane: true,
      probeMode: "result-page-1",
      companionMode: "current-calculator-on-change",
      resultFingerprint,
      constituentProducers: {
        probe: sourceProducer,
        companion: sourceProducer,
      },
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows,
      errors: 0,
      methods,
      pageDepth: 1,
      resultPageDepth: 1,
      resultRows: rowsInRelayPayload(endpoints.find((endpoint) => endpoint.id === "result")?.payload),
      fastResultLane: true,
      sourceCycleId: uploadCycleId,
      sourceCycleKind: "upload-merge",
      constituentCycleIds,
      mixedCollectorSourceCycles,
    },
    endpoints,
    errors: [],
  };
};

const postJson = async (url, body, env, { requireWatcherEligibility = false } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let upload;
  try {
    upload = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FOOTBALL_PRODUCTION_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await upload.json().catch(() => null);
    if (!upload.ok || result?.ok !== true) {
      throw new Error(`collector upload failed ${upload.status}: ${result?.error || "rejected"}`);
    }
    if (requireWatcherEligibility && (
      result?.stored !== true
      || result?.storedValidation?.ok !== true
      || result?.watcherEligible !== true
      || result?.publicationEligibility?.eligible !== true
    )) {
      throw new Error("collector fast-lane upload stored without watcher publication eligibility");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
};

export const createSportteryEvidence = async (env) => {
  if (!sportteryCollectorConfigured(env)) {
    throw new Error("sporttery collector signing secrets are not configured");
  }
  return evidenceUploadFromCollection(await collectEndpointSet(env));
};

export const collectSportteryEvidence = async (env) => {
  if (!sportteryCollectorConfigured(env)) {
    return { ok: true, skipped: true, reason: "collector-signing-secrets-not-configured" };
  }
  if (String(env.SPORTTERY_COLLECTOR_DELIVERY_MODE || "push").trim().toLowerCase() === "pull") {
    return { ok: true, skipped: true, reason: "collector-pull-on-demand" };
  }
  if (!env.FOOTBALL_PRODUCTION_ADMIN_TOKEN) {
    return { ok: true, skipped: true, reason: "collector-upload-secret-not-configured" };
  }
  const collection = await collectEndpointSet(env, { includeResult: true });
  const evidence = evidenceUploadFromCollection(collection);
  if (!evidence.endpoints.length) {
    throw new Error("sporttery collector returned no market evidence endpoint");
  }
  const fastLaneSnapshot = await createFastLaneSnapshot(collection, env);
  const baseUrl = String(env.FOOTBALL_PRODUCTION_BASE_URL || "https://134.175.132.183").replace(/\/+$/, "");
  const marketUploadPromise = postJson(
    `${baseUrl}/api/admin/sporttery-collector-evidence`,
    evidence,
    env,
  );
  const fastUploadPromise = fastLaneSnapshot
    ? postJson(
        `${baseUrl}/api/admin/sporttery-relay-fast-lane?runSync=0`,
        { snapshot: fastLaneSnapshot, runSync: false },
        env,
        { requireWatcherEligibility: true },
      )
    : Promise.reject(new Error("official result endpoint unavailable; fast-lane upload withheld"));
  const [marketUpload, fastUpload] = await Promise.allSettled([marketUploadPromise, fastUploadPromise]);
  if (marketUpload.status === "rejected" || fastUpload.status === "rejected") {
    const failures = [marketUpload, fastUpload]
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => String(outcome.reason?.message || outcome.reason || "upload failed"));
    throw new Error(`sporttery collector publication incomplete: ${failures.join("; ")}`);
  }
  const result = marketUpload.value;
  const fastResult = fastUpload.value;
  return {
    ok: true,
    skipped: false,
    capturedAt: evidence.capturedAt,
    sourceCycleId: evidence.sourceCycleId,
    endpoints: evidence.endpoints.length,
    errors: evidence.errors,
    acceptedRows: result.acceptedRows,
    storeRows: result.storeRows,
    storeRootHash: result.storeRootHash,
    fastLane: {
      stored: fastResult?.stored === true,
      watcherEligible: fastResult?.watcherEligible === true,
      published: fastResult?.watcherEligible === true
        && fastResult?.publicationEligibility?.eligible === true,
      endpoints: fastLaneSnapshot.endpoints.length,
      resultRows: fastLaneSnapshot.summary.resultRows,
      rows: fastResult?.storedValidation?.rows ?? fastLaneSnapshot.summary.rows,
      usableEndpoints: fastResult?.storedValidation?.usableEndpoints
        ?? fastLaneSnapshot.summary.usableEndpoints,
      provenanceMode: fastResult?.storedValidation?.provenanceMode || "upload-merge",
    },
  };
};

export const sportteryCollectorInternals = {
  canonicalJson,
  createFastLaneSnapshot,
  marketExtractionsFromPayload,
  normalizeOfficialResultPayload,
  providerObservedAtFromPayload,
  sha256Json,
};
