"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = Object.freeze([
  "wikipedia-zh",
  "wikipedia-en",
  "gdelt",
  "crossref",
  "unpaywall",
  "searxng",
]);
const PROVIDER_SET = new Set(PROVIDERS);
const ACCESS_STATUSES = Object.freeze(["open", "metadata_only", "restricted", "unknown"]);
const ACCESS_RANK = Object.freeze({ unknown: 0, restricted: 1, metadata_only: 2, open: 3 });
const DEFAULT_LIMIT = 8;
const ABSOLUTE_MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 256;
const MAX_DOI_LENGTH = 255;
const MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 7_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const CACHE_VERSION = 1;

class OpenResearchGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenResearchGatewayError";
    this.code = code;
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
};

const cleanText = (value, maximum = 500) => {
  if (typeof value !== "string") return null;
  const decoded = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return decoded ? decoded.slice(0, maximum) : null;
};

const firstText = (value, maximum = 500) => {
  if (Array.isArray(value)) return cleanText(value.find((entry) => typeof entry === "string"), maximum);
  return cleanText(value, maximum);
};

const normalizeIsoTime = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const normalizeCrossrefDate = (value) => {
  const parts = value?.["date-parts"]?.[0];
  if (!Array.isArray(parts) || !Number.isInteger(Number(parts[0]))) return null;
  const year = Number(parts[0]);
  const month = boundedInteger(parts[1], 1, 1, 12);
  const day = boundedInteger(parts[2], 1, 1, 31);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeDoi = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new OpenResearchGatewayError("INVALID_DOI", "doi must be a string");
  const doi = value.trim().toLowerCase();
  if (!doi || doi.length > MAX_DOI_LENGTH || /[\u0000-\u001f\u007f\s]/.test(doi)
    || !/^10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+$/i.test(doi)) {
    throw new OpenResearchGatewayError("INVALID_DOI", "doi must be a bare DOI, not a URL");
  }
  return doi;
};

const tryNormalizeDoi = (value) => {
  try {
    return normalizeDoi(value);
  } catch {
    return null;
  }
};

const isLoopbackHostname = (hostname) => {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255));
};

const isPrivateLiteralHostname = (hostname) => {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(host) || host === "0.0.0.0" || host === "::") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match || !match.slice(1).every((part) => Number(part) <= 255)) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || a === 0;
};

const validateSearxngBaseUrl = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new OpenResearchGatewayError("INVALID_SEARXNG_URL", "SearXNG base URL must be a string");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpenResearchGatewayError("INVALID_SEARXNG_URL", "SearXNG base URL is invalid");
  }
  const loopbackHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new OpenResearchGatewayError(
      "UNSAFE_SEARXNG_URL",
      "SearXNG requires HTTPS, except HTTP on an explicit loopback host",
    );
  }
  if (isPrivateLiteralHostname(parsed.hostname) && !isLoopbackHostname(parsed.hostname)) {
    throw new OpenResearchGatewayError(
      "UNSAFE_SEARXNG_URL",
      "SearXNG cannot target a private or link-local literal address",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OpenResearchGatewayError("INVALID_SEARXNG_URL", "SearXNG URL cannot contain credentials, query, or fragment");
  }
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/search")) pathname = `${pathname}/search`;
  parsed.pathname = pathname.replace(/^\/\//, "/");
  return parsed.toString();
};

const normalizeDiscoveryUrl = (value, { httpsOnly = false } = {}) => {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((httpsOnly && parsed.protocol !== "https:")
    || (!httpsOnly && parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username || parsed.password || isPrivateLiteralHostname(parsed.hostname)) return null;
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
};

const validateRequest = (input, configuredMaxLimit) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OpenResearchGatewayError("INVALID_REQUEST", "request must be an object");
  }
  const allowedKeys = new Set(["query", "doi", "limit", "providers"]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new OpenResearchGatewayError("UNSUPPORTED_REQUEST_FIELD", `unsupported request field: ${unknownKeys[0]}`);
  }
  let query = null;
  if (input.query !== undefined && input.query !== null && input.query !== "") {
    if (typeof input.query !== "string") {
      throw new OpenResearchGatewayError("INVALID_QUERY", "query must be a string");
    }
    query = input.query.replace(/\s+/g, " ").trim();
    if (!query || query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
      throw new OpenResearchGatewayError("INVALID_QUERY", `query must contain 1-${MAX_QUERY_LENGTH} safe characters`);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) {
      throw new OpenResearchGatewayError("URL_QUERY_REJECTED", "URL-shaped input is not accepted as a fetch target");
    }
  }
  const doi = normalizeDoi(input.doi);
  if (!query && !doi) throw new OpenResearchGatewayError("MISSING_QUERY", "query or doi is required");

  const limit = input.limit === undefined
    ? Math.min(DEFAULT_LIMIT, configuredMaxLimit)
    : boundedInteger(input.limit, NaN, 1, configuredMaxLimit);
  if (!Number.isInteger(limit)) throw new OpenResearchGatewayError("INVALID_LIMIT", "limit must be an integer");

  let providers = null;
  if (input.providers !== undefined) {
    if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > PROVIDERS.length) {
      throw new OpenResearchGatewayError("INVALID_PROVIDERS", "providers must be a non-empty bounded array");
    }
    providers = [...new Set(input.providers.map((provider) => String(provider).toLowerCase()))];
    const unsupported = providers.find((provider) => !PROVIDER_SET.has(provider));
    if (unsupported) throw new OpenResearchGatewayError("UNSUPPORTED_PROVIDER", `unsupported provider: ${unsupported}`);
  }
  return { query, doi, limit, providers };
};

const responseJson = async (response) => {
  if (!response || typeof response !== "object") {
    throw new OpenResearchGatewayError("INVALID_PROVIDER_RESPONSE", "provider returned no response");
  }
  if (!response.ok) {
    throw new OpenResearchGatewayError("PROVIDER_HTTP_ERROR", `provider returned HTTP ${Number(response.status) || 0}`);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new OpenResearchGatewayError("PROVIDER_RESPONSE_TOO_LARGE", "provider response exceeded the size limit");
  }
  let text;
  if (typeof response.text === "function") {
    text = await response.text();
  } else if (typeof response.json === "function") {
    text = JSON.stringify(await response.json());
  } else {
    throw new OpenResearchGatewayError("INVALID_PROVIDER_RESPONSE", "provider response was not JSON-readable");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new OpenResearchGatewayError("PROVIDER_RESPONSE_TOO_LARGE", "provider response exceeded the size limit");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenResearchGatewayError("INVALID_PROVIDER_JSON", "provider returned invalid JSON");
  }
};

const fetchJsonWithTimeout = async ({ fetchImpl, url, timeoutMs, headers = {} }) => {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OpenResearchGatewayError("PROVIDER_TIMEOUT", "provider request timed out"));
    }, timeoutMs);
  });
  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
    }));
    return await responseJson(await Promise.race([fetchPromise, timeout]));
  } catch (error) {
    if (error instanceof OpenResearchGatewayError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new OpenResearchGatewayError("PROVIDER_TIMEOUT", "provider request timed out");
    }
    throw new OpenResearchGatewayError("PROVIDER_NETWORK_ERROR", "provider request failed");
  } finally {
    clearTimeout(timer);
  }
};

const wikipediaAdapter = async ({ language, query, limit, requestJson }) => {
  const endpoint = new URL(`https://${language}.wikipedia.org/w/api.php`);
  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("formatversion", "2");
  endpoint.searchParams.set("list", "search");
  endpoint.searchParams.set("srsearch", query);
  endpoint.searchParams.set("srlimit", String(limit));
  endpoint.searchParams.set("srprop", "snippet|timestamp");
  const body = await requestJson(endpoint);
  const rows = Array.isArray(body?.query?.search) ? body.query.search : [];
  return rows.slice(0, limit).map((row) => {
    const title = firstText(row?.title, 300);
    return {
      provider: `wikipedia-${language}`,
      accessStatus: "open",
      type: "encyclopedia",
      title,
      snippet: firstText(row?.snippet, 500),
      url: title ? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : null,
      publishedAt: normalizeIsoTime(row?.timestamp),
      language,
      source: `${language}.wikipedia.org`,
      license: "CC BY-SA",
    };
  });
};

const gdeltAdapter = async ({ query, limit, requestJson }) => {
  const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("mode", "artlist");
  endpoint.searchParams.set("maxrecords", String(limit));
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("sort", "datedesc");
  const body = await requestJson(endpoint);
  const rows = Array.isArray(body?.articles) ? body.articles : [];
  return rows.slice(0, limit).map((row) => ({
    provider: "gdelt",
    accessStatus: "metadata_only",
    type: "news-index",
    title: firstText(row?.title, 500),
    url: normalizeDiscoveryUrl(row?.url),
    publishedAt: normalizeIsoTime(row?.seendate),
    language: firstText(row?.language, 40),
    source: firstText(row?.domain, 255),
  }));
};

const crossrefItem = (row) => {
  const doi = tryNormalizeDoi(row?.DOI);
  const authors = Array.isArray(row?.author)
    ? row.author.slice(0, 20).map((author) => cleanText([author?.given, author?.family].filter(Boolean).join(" "), 150)).filter(Boolean)
    : [];
  return {
    provider: "crossref",
    accessStatus: "metadata_only",
    type: firstText(row?.type, 80) || "scholarly-work",
    title: firstText(row?.title, 500),
    doi,
    url: doi ? `https://doi.org/${encodeURI(doi)}` : normalizeDiscoveryUrl(row?.URL),
    publishedAt: normalizeCrossrefDate(row?.published || row?.issued || row?.created),
    source: firstText(row?.publisher || row?.["container-title"], 300),
    authors,
  };
};

const crossrefAdapter = async ({ query, doi, limit, requestJson, contactEmail }) => {
  const endpoint = doi
    ? new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    : new URL("https://api.crossref.org/works");
  if (!doi) {
    endpoint.searchParams.set("query.bibliographic", query);
    endpoint.searchParams.set("rows", String(limit));
  }
  if (contactEmail) endpoint.searchParams.set("mailto", contactEmail);
  const body = await requestJson(endpoint);
  const message = body?.message;
  const rows = doi ? (message && typeof message === "object" ? [message] : [])
    : (Array.isArray(message?.items) ? message.items : []);
  return rows.slice(0, limit).map(crossrefItem);
};

const validEmail = (value) => typeof value === "string"
  && value.length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const normalizeContactUrl = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500 || /[\r\n]/.test(value)) {
    throw new OpenResearchGatewayError("INVALID_CONTACT_URL", "research contact URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpenResearchGatewayError("INVALID_CONTACT_URL", "research contact URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new OpenResearchGatewayError("INVALID_CONTACT_URL", "research contact URL must be public HTTPS without credentials or a fragment");
  }
  return parsed.toString();
};

const unpaywallAdapter = async ({ doi, requestJson, contactEmail }) => {
  const endpoint = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
  endpoint.searchParams.set("email", contactEmail);
  const body = await requestJson(endpoint);
  const locations = [body?.best_oa_location, ...(Array.isArray(body?.oa_locations) ? body.oa_locations : [])]
    .filter(Boolean);
  const legalLocation = body?.is_oa === true
    ? locations.find((location) => normalizeDiscoveryUrl(location?.url_for_pdf || location?.url, { httpsOnly: true }))
    : null;
  const oaUrl = legalLocation
    ? normalizeDiscoveryUrl(legalLocation?.url_for_pdf || legalLocation?.url, { httpsOnly: true })
    : null;
  return [{
    provider: "unpaywall",
    accessStatus: oaUrl ? "open" : (body?.is_oa === false ? "restricted" : "metadata_only"),
    type: "scholarly-work",
    title: firstText(body?.title, 500),
    doi,
    url: oaUrl,
    publishedAt: normalizeIsoTime(body?.published_date),
    source: firstText(legalLocation?.host_type || body?.journal_name, 200),
    license: oaUrl ? firstText(legalLocation?.license || body?.oa_status, 100) : null,
  }];
};

const searxngAdapter = async ({ query, limit, requestJson, baseUrl }) => {
  const endpoint = new URL(baseUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("safesearch", "1");
  endpoint.searchParams.set("categories", "general");
  const body = await requestJson(endpoint);
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.slice(0, limit).map((row) => ({
    provider: "searxng",
    accessStatus: "metadata_only",
    type: "web-index",
    title: firstText(row?.title, 500),
    url: normalizeDiscoveryUrl(row?.url),
    publishedAt: normalizeIsoTime(row?.publishedDate || row?.published_date),
    source: firstText(row?.engine || row?.parsed_url?.[1], 200),
    // SearXNG's `content` is deliberately not returned: its licensing and
    // paywall status are not known. The gateway exposes discovery metadata only.
  }));
};

const normalizeProviderResult = (input) => {
  if (!input || typeof input !== "object" || !PROVIDER_SET.has(input.provider)) return null;
  const accessStatus = ACCESS_STATUSES.includes(input.accessStatus) ? input.accessStatus : "unknown";
  const doi = input.doi ? tryNormalizeDoi(input.doi) : null;
  const title = firstText(input.title, 500);
  const url = normalizeDiscoveryUrl(input.url, { httpsOnly: input.provider === "unpaywall" });
  const snippet = accessStatus === "open" && input.provider.startsWith("wikipedia-")
    ? firstText(input.snippet, 500)
    : null;
  if (!title && !url && !doi) return null;
  const result = {
    id: null,
    providers: [input.provider],
    accessStatus,
    type: firstText(input.type, 80) || "resource",
    title,
    url,
    doi,
    publishedAt: normalizeIsoTime(input.publishedAt),
    language: firstText(input.language, 40),
    source: firstText(input.source, 300),
    authors: Array.isArray(input.authors) ? input.authors.map((author) => firstText(author, 150)).filter(Boolean).slice(0, 20) : [],
    license: firstText(input.license, 100),
    ...(snippet ? { snippet } : {}),
  };
  const identity = doi
    ? `doi:${doi}`
    : url
      ? `url:${url.toLowerCase()}`
      : `title:${String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
  result.id = sha256(identity);
  return result;
};

const mergeResults = (rows, limit) => {
  const byId = new Map();
  for (const raw of rows) {
    const result = normalizeProviderResult(raw);
    if (!result) continue;
    const previous = byId.get(result.id);
    if (!previous) {
      byId.set(result.id, result);
      continue;
    }
    const preferred = ACCESS_RANK[result.accessStatus] > ACCESS_RANK[previous.accessStatus] ? result : previous;
    const fallback = preferred === result ? previous : result;
    byId.set(result.id, {
      ...fallback,
      ...preferred,
      providers: [...new Set([...previous.providers, ...result.providers])].sort(),
      authors: preferred.authors?.length ? preferred.authors : fallback.authors,
      ...(preferred.snippet ? { snippet: preferred.snippet } : {}),
    });
  }
  return [...byId.values()].slice(0, limit);
};

const aiSafeSummary = ({ requestHash, generatedAt, expiresAt, results, providerReports, cacheHitCount = 0 }) => {
  const accessCounts = new Map(ACCESS_STATUSES.map((status) => [status, 0]));
  for (const result of results) accessCounts.set(result.accessStatus, (accessCounts.get(result.accessStatus) || 0) + 1);
  const resultHashes = results.map((result) => result.id).sort();
  return {
    requestHash,
    resultSetHash: sha256(resultHashes.join("|")),
    generatedAt,
    expiresAt,
    counts: {
      resultCount: results.length,
      providerCount: providerReports.length,
      failureCount: providerReports.filter((report) => report.status === "error").length,
      cacheHitCount,
    },
    providers: providerReports.map((report) => ({
      provider: report.provider,
      status: report.status,
      resultCount: report.resultCount,
      durationMs: report.durationMs,
    })),
    accessStatuses: [...accessCounts].map(([accessStatus, resultCount]) => ({ accessStatus, resultCount })),
    resultHashes,
  };
};

const atomicWriteJson = (targetPath, value) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup must not hide the original cache publication error.
    }
  }
};

const readCache = ({ cachePath, requestHash, nowMs }) => {
  try {
    const envelope = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (envelope?.version !== CACHE_VERSION || envelope?.requestHash !== requestHash
      || !Number.isFinite(Number(envelope?.expiresAtMs)) || Number(envelope.expiresAtMs) <= nowMs
      || !envelope?.value || !Array.isArray(envelope.value.results) || !Array.isArray(envelope.value.providerReports)) return null;
    return envelope.value;
  } catch {
    return null;
  }
};

const defaultProviderSelection = ({ query, doi, searxngBaseUrl, unpaywallEmail }) => {
  const selected = [];
  // Keep the customer-facing default latency bounded to providers that are
  // consistently reachable from production. GDELT remains available when a
  // caller explicitly requests it, but must not hold every default query open
  // until the provider timeout or prevent an otherwise complete cache entry.
  if (query) selected.push("wikipedia-zh", "wikipedia-en", "crossref");
  if (doi && !selected.includes("crossref")) selected.push("crossref");
  if (doi && unpaywallEmail) selected.push("unpaywall");
  if (query && searxngBaseUrl) selected.push("searxng");
  return selected;
};

const createOpenResearchGateway = (options = {}) => {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OpenResearchGatewayError("FETCH_UNAVAILABLE", "a WHATWG-compatible fetch implementation is required");
  }
  const maxLimit = boundedInteger(options.maxLimit, ABSOLUTE_MAX_LIMIT, 1, ABSOLUTE_MAX_LIMIT);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 60_000);
  const cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1_000, 24 * 60 * 60_000);
  const cacheDir = path.resolve(options.cacheDir || process.env.OPEN_RESEARCH_CACHE_DIR
    || path.join(process.cwd(), "data", "open-research-cache"));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const unpaywallEmail = options.unpaywallEmail
    || process.env.OPEN_RESEARCH_UNPAYWALL_EMAIL
    || process.env.UNPAYWALL_EMAIL
    || null;
  const crossrefEmail = options.crossrefEmail
    || process.env.OPEN_RESEARCH_CONTACT_EMAIL
    || process.env.CROSSREF_EMAIL
    || unpaywallEmail
    || null;
  const contactUrl = normalizeContactUrl(
    options.contactUrl
    || process.env.OPEN_RESEARCH_CONTACT_URL
    || null
  );
  if (unpaywallEmail && !validEmail(unpaywallEmail)) {
    throw new OpenResearchGatewayError("INVALID_UNPAYWALL_EMAIL", "Unpaywall requires a valid contact email");
  }
  if (crossrefEmail && !validEmail(crossrefEmail)) {
    throw new OpenResearchGatewayError("INVALID_CROSSREF_EMAIL", "Crossref contact email is invalid");
  }
  const searxngBaseUrl = validateSearxngBaseUrl(
    options.searxngBaseUrl
    || process.env.OPEN_RESEARCH_SEARXNG_BASE_URL
    || process.env.SEARXNG_BASE_URL
    || null
  );

  const userAgent = contactUrl
    ? `football-open-research-gateway/1.0 (${contactUrl}; metadata-only)`
    : "football-open-research-gateway/1.0 (metadata-only)";
  const requestJson = (url) => fetchJsonWithTimeout({
    fetchImpl,
    url: url.toString(),
    timeoutMs,
    headers: {
      "user-agent": userAgent,
      "api-user-agent": userAgent,
    },
  });

  const runProvider = async (provider, request) => {
    if (provider === "unpaywall" && !unpaywallEmail) return { status: "disabled", rows: [] };
    if (provider === "searxng" && !searxngBaseUrl) return { status: "disabled", rows: [] };
    if ((provider === "unpaywall") && !request.doi) return { status: "skipped", rows: [] };
    if (["wikipedia-zh", "wikipedia-en", "gdelt", "searxng"].includes(provider) && !request.query) {
      return { status: "skipped", rows: [] };
    }
    if (provider === "wikipedia-zh") {
      return { status: "success", rows: await wikipediaAdapter({ language: "zh", ...request, requestJson }) };
    }
    if (provider === "wikipedia-en") {
      return { status: "success", rows: await wikipediaAdapter({ language: "en", ...request, requestJson }) };
    }
    if (provider === "gdelt") return { status: "success", rows: await gdeltAdapter({ ...request, requestJson }) };
    if (provider === "crossref") {
      return { status: "success", rows: await crossrefAdapter({ ...request, requestJson, contactEmail: crossrefEmail }) };
    }
    if (provider === "unpaywall") {
      return { status: "success", rows: await unpaywallAdapter({ ...request, requestJson, contactEmail: unpaywallEmail }) };
    }
    if (provider === "searxng") {
      return { status: "success", rows: await searxngAdapter({ ...request, requestJson, baseUrl: searxngBaseUrl }) };
    }
    throw new OpenResearchGatewayError("UNSUPPORTED_PROVIDER", "unsupported provider");
  };

  const search = async (input) => {
    const request = validateRequest(input, maxLimit);
    const providers = request.providers || defaultProviderSelection({
      ...request,
      searxngBaseUrl,
      unpaywallEmail,
    });
    const requestHash = sha256(stableJson({
      version: CACHE_VERSION,
      query: request.query,
      doi: request.doi,
      limit: request.limit,
      providers,
      searxng: searxngBaseUrl ? sha256(searxngBaseUrl) : null,
      unpaywall: Boolean(unpaywallEmail),
    }));
    const cachePath = path.join(cacheDir, `${requestHash}.json`);
    const nowMs = Number(now());
    const cached = readCache({ cachePath, requestHash, nowMs });
    if (cached) {
      return {
        ...cached,
        cache: { hit: true, ttlMs: cacheTtlMs },
        aiSafe: aiSafeSummary({ ...cached, requestHash, cacheHitCount: 1 }),
      };
    }

    const executions = await Promise.all(providers.map(async (provider) => {
      const startedAt = Number(now());
      try {
        const outcome = await runProvider(provider, request);
        return {
          provider,
          status: outcome.status,
          resultCount: outcome.rows.length,
          durationMs: Math.max(0, Number(now()) - startedAt),
          rows: outcome.rows,
        };
      } catch (error) {
        return {
          provider,
          status: "error",
          errorCode: typeof error?.code === "string" ? error.code : "PROVIDER_FAILURE",
          resultCount: 0,
          durationMs: Math.max(0, Number(now()) - startedAt),
          rows: [],
        };
      }
    }));
    const results = mergeResults(executions.flatMap((execution) => execution.rows), request.limit);
    const providerReports = executions.map(({ rows: _rows, ...report }) => report);
    const generatedAt = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + cacheTtlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const successCount = providerReports.filter((report) => report.status === "success").length;
    const response = {
      ok: successCount > 0,
      partial: providerReports.some((report) => report.status === "error"),
      requestHash,
      generatedAt,
      expiresAt,
      results,
      providerReports,
      cache: { hit: false, ttlMs: cacheTtlMs },
    };
    response.aiSafe = aiSafeSummary({ ...response, cacheHitCount: 0 });

    if (successCount > 0 && !response.partial) {
      const cacheValue = { ...response };
      delete cacheValue.cache;
      delete cacheValue.aiSafe;
      try {
        atomicWriteJson(cachePath, {
          version: CACHE_VERSION,
          requestHash,
          createdAtMs: nowMs,
          expiresAtMs,
          value: cacheValue,
        });
      } catch {
        // Cache is an optimization. A filesystem failure must not erase useful
        // provider results or turn a partial external outage into a hard outage.
      }
    }
    return response;
  };

  return Object.freeze({
    search,
    toAiSafeSummary: (response) => aiSafeSummary({
      requestHash: response?.requestHash,
      generatedAt: response?.generatedAt,
      expiresAt: response?.expiresAt,
      results: Array.isArray(response?.results) ? response.results : [],
      providerReports: Array.isArray(response?.providerReports) ? response.providerReports : [],
      cacheHitCount: response?.cache?.hit ? 1 : 0,
    }),
    configuration: Object.freeze({
      maxLimit,
      timeoutMs,
      cacheTtlMs,
      providers: PROVIDERS.slice(),
      unpaywallEnabled: Boolean(unpaywallEmail),
      searxngEnabled: Boolean(searxngBaseUrl),
      contactUrlConfigured: Boolean(contactUrl),
    }),
  });
};

module.exports = {
  ACCESS_STATUSES,
  OpenResearchGatewayError,
  PROVIDERS,
  createOpenResearchGateway,
  validateSearxngBaseUrl,
};
