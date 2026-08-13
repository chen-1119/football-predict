"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = "wikidata-entity-candidates-v1";
const SOURCE_ID = "wikidata";
const API_ORIGIN = "https://www.wikidata.org";
const API_ENDPOINT = `${API_ORIGIN}/w/api.php`;
const SOURCE_LICENSE = "CC0-1.0";
const DEFAULT_USER_AGENT = "football-predict/1.0 (entity candidate collector; https://github.com/chen-1119/football-predict)";
const QID_PATTERN = /^Q[1-9][0-9]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSOCIATION_FOOTBALL_QID = "Q2736";

class WikidataCandidateError extends Error {
  constructor(message, code = "WIKIDATA_CANDIDATE_ERROR") {
    super(message);
    this.name = "WikidataCandidateError";
    this.code = code;
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
const stableStringify = (value) => JSON.stringify(stableValue(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashJson = (value) => sha256(Buffer.from(stableStringify(value), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uniqSorted = (values) => Array.from(new Set(values.map(compact).filter(Boolean))).sort();
const canonicalIso = (value, field) => {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new WikidataCandidateError(`${field} must be a valid timestamp`, "INVALID_TIMESTAMP");
  return new Date(parsed).toISOString();
};
const normalizeName = (value) => compact(value)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[\s·•・'’._()（）\-]+/g, "")
  .replace(/足球俱乐部|足球俱樂部|国家足球队|國家足球隊|足球代表队|足球代表隊|footballclub|footballteam|soccerclub/g, "");
const rowsFrom = (value) => Array.isArray(value) ? value : Array.isArray(value?.matches) ? value.matches : Array.isArray(value?.rows) ? value.rows : [];

const candidateStoreBody = (store) => {
  const { storeHash: _storeHash, ...body } = store || {};
  return stableValue(body);
};

const finalizeCandidateStore = (store) => {
  const body = candidateStoreBody(store);
  return { ...body, storeHash: hashJson(body) };
};

const validateCandidateStore = (store) => {
  const errors = [];
  if (!isObject(store)) return { valid: false, errors: ["store-invalid"] };
  if (store.version !== VERSION) errors.push("version-invalid");
  try { canonicalIso(store.generatedAt, "generatedAt"); } catch { errors.push("generated-at-invalid"); }
  if (store?.source?.sourceId !== SOURCE_ID) errors.push("source-id-invalid");
  if (store?.source?.endpoint !== API_ENDPOINT) errors.push("source-endpoint-invalid");
  if (store?.source?.license !== SOURCE_LICENSE) errors.push("source-license-invalid");
  if (!Array.isArray(store.entities)) errors.push("entities-invalid");
  if (!Array.isArray(store.receipts)) errors.push("receipts-invalid");
  const receiptIds = new Set();
  for (const receipt of store.receipts || []) {
    if (!HASH_PATTERN.test(compact(receipt.rawSha256))) errors.push("receipt-raw-hash-invalid");
    if (!Number.isInteger(receipt.rawBytes) || receipt.rawBytes < 0) errors.push("receipt-raw-bytes-invalid");
    if (!HASH_PATTERN.test(compact(receipt.canonicalPayloadSha256))) errors.push("receipt-canonical-hash-invalid");
    if (receipt.endpoint !== API_ENDPOINT || receipt.method !== "GET") errors.push("receipt-endpoint-invalid");
    if (!compact(receipt.requestUrl).startsWith(`${API_ENDPOINT}?`)) errors.push("receipt-url-invalid");
    if (receipt.httpStatus !== 200) errors.push("receipt-http-status-invalid");
    try { canonicalIso(receipt.requestedAt, "requestedAt"); } catch { errors.push("receipt-requested-at-invalid"); }
    try { canonicalIso(receipt.receivedAt, "receivedAt"); } catch { errors.push("receipt-received-at-invalid"); }
    const receiptBody = { ...receipt };
    delete receiptBody.receiptId;
    const expected = hashJson(receiptBody);
    if (receipt.receiptId !== expected) errors.push("receipt-id-mismatch");
    if (receiptIds.has(receipt.receiptId)) errors.push("receipt-duplicate");
    receiptIds.add(receipt.receiptId);
  }
  const localIds = new Set();
  for (const entity of store.entities || []) {
    if (!compact(entity.localEntityId)) errors.push("local-entity-id-missing");
    if (localIds.has(entity.localEntityId)) errors.push("local-entity-duplicate");
    localIds.add(entity.localEntityId);
    if (!Array.isArray(entity.names) || !entity.names.length) errors.push(`entity-names-missing:${entity.localEntityId}`);
    if (!Array.isArray(entity.queries) || !entity.queries.length) errors.push(`entity-queries-missing:${entity.localEntityId}`);
    if (!Array.isArray(entity.candidates)) errors.push(`entity-candidates-invalid:${entity.localEntityId}`);
    for (const candidate of entity.candidates || []) {
      if (!QID_PATTERN.test(compact(candidate.providerEntityId))) errors.push(`candidate-qid-invalid:${entity.localEntityId}`);
      if (candidate.reviewState !== "quarantined") errors.push(`candidate-not-quarantined:${entity.localEntityId}`);
      if (candidate.autoPromotable !== false) errors.push(`candidate-auto-promotable:${entity.localEntityId}`);
      if (!Array.isArray(candidate.receiptIds) || !candidate.receiptIds.length) errors.push(`candidate-receipts-missing:${entity.localEntityId}`);
      for (const receiptId of candidate.receiptIds || []) {
        if (!receiptIds.has(receiptId)) errors.push(`candidate-receipt-unknown:${entity.localEntityId}`);
      }
      const body = { ...candidate };
      delete body.candidateId;
      if (candidate.candidateId !== hashJson(body)) errors.push(`candidate-id-mismatch:${entity.localEntityId}`);
    }
  }
  const expectedStoreHash = hashJson(candidateStoreBody(store));
  if (store.storeHash !== expectedStoreHash) errors.push("store-hash-mismatch");
  return { valid: errors.length === 0, errors };
};

const readJson = (file, fallback = null) => {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
};

const withExclusiveLock = async (lockFile, fn) => {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockFile, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new WikidataCandidateError(`collector lock already held: ${lockFile}`, "COLLECTOR_LOCKED");
    throw error;
  }
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return await fn();
  } finally {
    try { fs.closeSync(handle); } catch { /* no-op */ }
    try { fs.unlinkSync(lockFile); } catch { /* no-op */ }
  }
};

const atomicWriteRaw = (rawDir, rawSha256, text) => {
  if (!HASH_PATTERN.test(rawSha256)) throw new WikidataCandidateError("raw hash is invalid", "RAW_HASH_INVALID");
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${rawSha256}.json`);
  const resolvedRoot = `${path.resolve(rawDir)}${path.sep}`;
  if (!path.resolve(file).startsWith(resolvedRoot)) throw new WikidataCandidateError("raw artifact path escaped root", "RAW_PATH_ESCAPE");
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file);
    if (sha256(existing) !== rawSha256) throw new WikidataCandidateError("existing raw artifact hash mismatch", "RAW_ARTIFACT_TAMPERED");
    return file;
  }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* no-op */ }
    if (!fs.existsSync(file)) throw error;
    const existing = fs.readFileSync(file);
    if (sha256(existing) !== rawSha256) throw new WikidataCandidateError("concurrent raw artifact hash mismatch", "RAW_ARTIFACT_TAMPERED");
  }
  return file;
};

const teamInputsFromMatches = (matches) => {
  const byId = new Map();
  for (const match of rowsFrom(matches)) {
    for (const side of ["home", "away"]) {
      const localEntityId = compact(match?.[`${side}TeamId`]);
      const names = uniqSorted([
        match?.[`${side}TeamName`],
        match?.[`${side}TeamNameEn`],
        match?.[`${side}Team`],
      ]);
      if (!localEntityId || !names.length) continue;
      const previous = byId.get(localEntityId) || {
        localEntityId,
        names: [],
        contexts: [],
      };
      previous.names = uniqSorted([...previous.names, ...names]);
      previous.contexts.push(stableValue({
        matchId: compact(match?.id) || null,
        sourceMatchId: compact(match?.sourceMatchId) || null,
        side,
        league: compact(match?.leagueName || match?.league) || null,
        country: compact(match?.countryName || match?.country) || null,
        kickoffTime: compact(match?.kickoffTime) || null,
      }));
      byId.set(localEntityId, previous);
    }
  }
  return Array.from(byId.values())
    .map((entry) => ({ ...entry, contexts: entry.contexts.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))) }))
    .sort((a, b) => a.localEntityId.localeCompare(b.localEntityId));
};

const likelyNationalTeam = (input) => (input.contexts || []).some((context) => (
  /世界杯|欧洲杯|美洲杯|亚洲杯|非洲杯|欧国联|世预赛|world cup|nations|international/i.test(`${context.league || ""} ${context.country || ""}`)
));

const queriesForTeam = (input) => {
  const primary = input.names[0];
  const contextual = likelyNationalTeam(input) ? `${primary}国家足球队` : `${primary}足球俱乐部`;
  const rows = [{ query: contextual, role: "contextual" }];
  if (compact(primary) && compact(primary) !== compact(contextual)) {
    rows.push({ query: primary, role: "base-name" });
  }
  return rows;
};

const requestReceipt = async ({
  url,
  fetchImpl = globalThis.fetch,
  userAgent = DEFAULT_USER_AGENT,
  now = () => new Date(),
  wait = sleep,
  maxRetries = 3,
  rawDir = null,
}) => {
  if (typeof fetchImpl !== "function") throw new WikidataCandidateError("fetch implementation missing", "FETCH_MISSING");
  const parsed = new URL(String(url));
  if (parsed.origin !== API_ORIGIN || parsed.pathname !== "/w/api.php") {
    throw new WikidataCandidateError(`untrusted Wikidata endpoint: ${parsed.href}`, "ENDPOINT_UNTRUSTED");
  }
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestedAt = canonicalIso(now(), "requestedAt");
    let response;
    let text;
    try {
      response = await fetchImpl(parsed, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": userAgent },
      });
      text = await response.text();
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await wait(Math.min(4_000, 250 * (2 ** attempt)));
      continue;
    }
    const receivedAt = canonicalIso(now(), "receivedAt");
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new WikidataCandidateError("Wikidata response was not JSON", "RESPONSE_NOT_JSON");
    }
    const retryable = response.status === 429 || response.status === 503 || compact(payload?.error?.code) === "maxlag";
    if (retryable && attempt < maxRetries) {
      const retryAfterSeconds = Number(response.headers?.get?.("retry-after"));
      await wait(Number.isFinite(retryAfterSeconds) ? Math.min(10_000, retryAfterSeconds * 1000) : Math.min(4_000, 250 * (2 ** attempt)));
      continue;
    }
    if (response.status !== 200 || payload?.error) {
      throw new WikidataCandidateError(`Wikidata request failed (${response.status}): ${compact(payload?.error?.code || payload?.error?.info)}`, "REQUEST_FAILED");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const rawSha256 = sha256(Buffer.from(text, "utf8"));
    const canonicalPayloadSha256 = hashJson(payload);
    if (rawDir) atomicWriteRaw(rawDir, rawSha256, text);
    const body = stableValue({
      sourceId: SOURCE_ID,
      endpoint: API_ENDPOINT,
      method: "GET",
      requestUrl: parsed.href,
      requestedAt,
      receivedAt,
      httpStatus: response.status,
      responseHeaders: {
        contentType: compact(response.headers?.get?.("content-type")) || null,
        date: compact(response.headers?.get?.("date")) || null,
        etag: compact(response.headers?.get?.("etag")) || null,
        lastModified: compact(response.headers?.get?.("last-modified")) || null,
      },
      rawSha256,
      rawBytes: bytes,
      canonicalPayloadSha256,
    });
    return { payload, receipt: { ...body, receiptId: hashJson(body) } };
  }
  throw new WikidataCandidateError("Wikidata request retries exhausted", "RETRIES_EXHAUSTED");
};

const apiUrl = (params) => {
  const url = new URL(API_ENDPOINT);
  url.search = new URLSearchParams({
    format: "json",
    formatversion: "2",
    maxlag: "5",
    ...params,
  });
  return url;
};

const searchUrl = (query, limit) => apiUrl({
  action: "wbsearchentities",
  search: query,
  language: "zh",
  uselang: "zh",
  type: "item",
  limit: String(limit),
});

const detailsUrl = (qids) => apiUrl({
  action: "wbgetentities",
  ids: qids.join("|"),
  props: "labels|aliases|descriptions|claims|info",
  languages: "zh|zh-hans|zh-hant|en",
  languagefallback: "1",
});

const languageValues = (values) => uniqSorted(Object.values(values || {}).map((entry) => entry?.value));
const aliasValues = (aliases) => uniqSorted(Object.values(aliases || {}).flatMap((rows) => (rows || []).map((entry) => entry?.value)));
const claimEntityIds = (entity, property) => uniqSorted((entity?.claims?.[property] || []).map((claim) => (
  claim?.mainsnak?.datavalue?.value?.id
)));
const claimStrings = (entity, property) => uniqSorted((entity?.claims?.[property] || []).map((claim) => {
  const value = claim?.mainsnak?.datavalue?.value;
  return typeof value === "string" ? value : null;
}));
const footballDescription = (value) => /association football|football club|football team|soccer|足球|足協|足协/i.test(compact(value));

const candidateFor = ({ input, queryRows, qid, details, detailReceiptId }) => {
  const labels = languageValues(details?.labels);
  const aliases = aliasValues(details?.aliases);
  const descriptions = languageValues(details?.descriptions);
  const instanceOf = claimEntityIds(details, "P31");
  const countries = claimEntityIds(details, "P17");
  const sports = claimEntityIds(details, "P641");
  const officialWebsites = claimStrings(details, "P856");
  const queryMatches = queryRows.map(({ query, role, result, receiptId }) => stableValue({
    query,
    role,
    receiptId,
    searchRank: result.rank,
    matchedBy: compact(result.match?.type) || null,
    matchedLanguage: compact(result.match?.language) || null,
    matchedText: compact(result.match?.text) || null,
  }));
  const exactBaseName = [...labels, ...aliases, ...queryMatches.map((row) => row.matchedText)]
    .some((name) => input.names.some((localName) => normalizeName(name) === normalizeName(localName)));
  const exactContextQuery = queryMatches.some((row) => row.role === "contextual"
    && normalizeName(row.matchedText) === normalizeName(row.query));
  const footballEvidence = sports.includes(ASSOCIATION_FOOTBALL_QID)
    || descriptions.some(footballDescription)
    || queryMatches.some((row) => footballDescription(row.query) && footballDescription(row.matchedText));
  const confidence = footballEvidence && exactContextQuery ? 0.95
    : footballEvidence && exactBaseName ? 0.82
      : footballEvidence ? 0.65
        : exactBaseName ? 0.4
          : 0.2;
  const blockers = [
    "manual-approval-required",
    ...(footballEvidence ? [] : ["football-identity-not-established"]),
    ...(exactBaseName || exactContextQuery ? [] : ["exact-name-or-alias-not-established"]),
  ];
  const body = stableValue({
    provider: SOURCE_ID,
    providerEntityId: qid,
    labels,
    aliases,
    descriptions,
    instanceOf,
    countries,
    sports,
    officialWebsites,
    lastRevisionId: Number(details?.lastrevid) || null,
    queryMatches,
    exactBaseName,
    exactContextQuery,
    footballEvidence,
    candidateConfidence: confidence,
    reviewState: "quarantined",
    autoPromotable: false,
    blockers,
    receiptIds: uniqSorted([...queryRows.map((row) => row.receiptId), detailReceiptId]),
  });
  return { ...body, candidateId: hashJson(body) };
};

const collectWikidataCandidates = async ({
  matches,
  generatedAt = new Date().toISOString(),
  sourceCycleId = null,
  dataGenerationId = null,
  matchesCurrentSha256 = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  wait = sleep,
  delayMs = 150,
  searchLimit = 5,
  maxTeams = Infinity,
  rawDir = null,
  userAgent = process.env.WIKIDATA_USER_AGENT || DEFAULT_USER_AGENT,
}) => {
  const at = canonicalIso(generatedAt, "generatedAt");
  const inputs = teamInputsFromMatches(matches).slice(0, Number.isFinite(maxTeams) ? Math.max(0, maxTeams) : undefined);
  const receipts = [];
  const queryResults = new Map();
  for (const input of inputs) {
    for (const query of queriesForTeam(input)) {
      const { payload, receipt } = await requestReceipt({
        url: searchUrl(query.query, searchLimit), fetchImpl, userAgent, now, wait, rawDir,
      });
      receipts.push(receipt);
      const rows = (payload?.search || [])
        .filter((row) => QID_PATTERN.test(compact(row?.id)))
        .map((row, index) => ({ ...row, rank: index + 1 }));
      queryResults.set(`${input.localEntityId}:${query.role}`, { ...query, receiptId: receipt.receiptId, rows });
      if (delayMs > 0) await wait(delayMs);
    }
  }
  const qids = uniqSorted(Array.from(queryResults.values()).flatMap((entry) => entry.rows.map((row) => row.id)));
  const detailsById = {};
  const detailReceiptById = {};
  for (let offset = 0; offset < qids.length; offset += 50) {
    const batch = qids.slice(offset, offset + 50);
    const { payload, receipt } = await requestReceipt({
      url: detailsUrl(batch), fetchImpl, userAgent, now, wait, rawDir,
    });
    receipts.push(receipt);
    for (const qid of batch) {
      if (isObject(payload?.entities?.[qid])) {
        detailsById[qid] = payload.entities[qid];
        detailReceiptById[qid] = receipt.receiptId;
      }
    }
    if (delayMs > 0 && offset + 50 < qids.length) await wait(delayMs);
  }
  const entities = inputs.map((input) => {
    const queries = queriesForTeam(input);
    const byQid = new Map();
    for (const query of queries) {
      const result = queryResults.get(`${input.localEntityId}:${query.role}`);
      for (const row of result?.rows || []) {
        const previous = byQid.get(row.id) || [];
        previous.push({ query: query.query, role: query.role, result: row, receiptId: result.receiptId });
        byQid.set(row.id, previous);
      }
    }
    const candidates = Array.from(byQid.entries())
      .filter(([qid]) => detailsById[qid])
      .map(([qid, queryRows]) => candidateFor({
        input,
        queryRows,
        qid,
        details: detailsById[qid],
        detailReceiptId: detailReceiptById[qid],
      }))
      .sort((left, right) => right.candidateConfidence - left.candidateConfidence
        || left.providerEntityId.localeCompare(right.providerEntityId));
    return stableValue({
      localEntityId: input.localEntityId,
      names: input.names,
      contexts: input.contexts,
      queries,
      candidates,
      reviewState: candidates.length ? "candidate-review-required" : "no-candidate",
      autoPromotable: false,
    });
  });
  const uniqueReceipts = Array.from(new Map(receipts.map((receipt) => [receipt.receiptId, receipt])).values())
    .sort((left, right) => left.receiptId.localeCompare(right.receiptId));
  const store = finalizeCandidateStore({
    version: VERSION,
    generatedAt: at,
    source: {
      sourceId: SOURCE_ID,
      endpoint: API_ENDPOINT,
      accessMethod: "Wikibase Action API",
      license: SOURCE_LICENSE,
      licenseUrl: "https://www.wikidata.org/wiki/Wikidata:Licensing",
      userAgent,
    },
    input: {
      sourceCycleId: compact(sourceCycleId) || null,
      dataGenerationId: compact(dataGenerationId) || null,
      matchesCurrentSha256: HASH_PATTERN.test(compact(matchesCurrentSha256)) ? compact(matchesCurrentSha256) : null,
      localEntityCount: inputs.length,
    },
    policy: {
      purpose: "candidate-discovery-only",
      exactEntityRequiredForFormalUse: true,
      fuzzyMatchesQuarantined: true,
      automaticPromotionAllowed: false,
      providerFactsTrustedForProbability: false,
      manualApprovalRequired: true,
    },
    entities,
    receipts: uniqueReceipts,
  });
  const validation = validateCandidateStore(store);
  if (!validation.valid) throw new WikidataCandidateError(`candidate store invalid: ${validation.errors.join(", ")}`, "STORE_INVALID");
  return store;
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
};

const runCli = async () => {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = path.resolve(args["data-dir"] || process.env.ENTITY_CANDIDATE_DATA_DIR || path.join(rootDir, "public", "data"));
  const storeDir = path.resolve(args["store-dir"] || process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
  const outputFile = path.resolve(args.output || path.join(storeDir, "entity-resolution", "wikidata-candidates.json"));
  const rawDir = path.resolve(args["raw-dir"] || path.join(storeDir, "entity-resolution", "wikidata-raw"));
  const lockFile = `${outputFile}.lock`;
  const matchesFile = path.join(dataDir, "matches-current.json");
  const syncMetaFile = path.join(dataDir, "sync-meta.json");
  const matchesRaw = fs.readFileSync(matchesFile);
  const matches = JSON.parse(matchesRaw.toString("utf8"));
  const syncMeta = readJson(syncMetaFile, {});
  const inputSha256 = sha256(matchesRaw);
  const inputSourceCycleId = syncMeta?.sourceCycleId || syncMeta?.collectorCycleId || null;
  const store = await withExclusiveLock(lockFile, async () => {
    const collected = await collectWikidataCandidates({
      matches,
      generatedAt: new Date().toISOString(),
      sourceCycleId: inputSourceCycleId,
      dataGenerationId: syncMeta?.dataGenerationId || null,
      matchesCurrentSha256: inputSha256,
      delayMs: Number(args["delay-ms"] ?? 150),
      searchLimit: Math.max(1, Math.min(20, Number(args.limit ?? 5))),
      maxTeams: args["max-teams"] ? Number(args["max-teams"]) : Infinity,
      rawDir,
    });
    const currentMatchesRaw = fs.readFileSync(matchesFile);
    const currentSyncMeta = readJson(syncMetaFile, {});
    const currentSourceCycleId = currentSyncMeta?.sourceCycleId || currentSyncMeta?.collectorCycleId || null;
    const inputCurrentAtCommit = sha256(currentMatchesRaw) === inputSha256
      && compact(currentSourceCycleId) === compact(inputSourceCycleId);
    const committed = finalizeCandidateStore({
      ...candidateStoreBody(collected),
      completedAt: new Date().toISOString(),
      input: {
        ...collected.input,
        currentAtCommit: inputCurrentAtCommit,
        currentSourceCycleIdAtCommit: compact(currentSourceCycleId) || null,
        snapshotStatus: inputCurrentAtCommit ? "current-at-commit" : "superseded-during-collection",
      },
    });
    const validation = validateCandidateStore(committed);
    if (!validation.valid) throw new WikidataCandidateError(`committed candidate store invalid: ${validation.errors.join(", ")}`, "STORE_INVALID");
    writeJsonAtomic(outputFile, committed);
    return committed;
  });
  const eligibleCandidates = store.entities.reduce((sum, entity) => sum + entity.candidates.filter((candidate) => (
    candidate.footballEvidence && (candidate.exactBaseName || candidate.exactContextQuery)
  )).length, 0);
  console.log(JSON.stringify({
    ok: true,
    outputFile,
    rawDir,
    generatedAt: store.generatedAt,
    localEntities: store.entities.length,
    entitiesWithCandidates: store.entities.filter((entity) => entity.candidates.length).length,
    reviewableFootballCandidates: eligibleCandidates,
    autoPromoted: 0,
    inputCurrentAtCommit: store.input.currentAtCommit,
    snapshotStatus: store.input.snapshotStatus,
    receipts: store.receipts.length,
    storeHash: store.storeHash,
  }, null, 2));
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code || "ERROR", message: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  API_ENDPOINT,
  DEFAULT_USER_AGENT,
  SOURCE_LICENSE,
  VERSION,
  WikidataCandidateError,
  collectWikidataCandidates,
  finalizeCandidateStore,
  hashJson,
  normalizeName,
  queriesForTeam,
  requestReceipt,
  teamInputsFromMatches,
  validateCandidateStore,
  withExclusiveLock,
};
