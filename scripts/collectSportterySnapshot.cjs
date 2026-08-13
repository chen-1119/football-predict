const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  buildCollectorCommitment,
  sha256CollectorJson,
  signCollectorCommitment,
} = require("../src/services/collectorAttestation.cjs");
const { snapshotCycleDetails } = require("./sportteryRelayCircuit.cjs");
const {
  browserFallbackEnabled,
  requestJsonViaEdgeDocument,
} = require("./sportteryBrowserTransport.cjs");
const {
  SPORTTERY_BASE,
  SPORTTERY_CALCULATOR_URL: CALCULATOR_URL,
  SPORTTERY_CURRENT_URL: CURRENT_URL,
  SPORTTERY_RESULT_URL: RESULT_URL,
  sportteryRequestHeaders,
} = require("./sportteryEndpointContract.cjs");
const {
  isOfficialUniformResultUrl,
  normalizeOfficialUniformResultPayload,
} = require("./sportteryOfficialResult.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const outputPath = process.env.SPORTTERY_RELAY_SNAPSHOT_OUT || process.env.SPORTTERY_RELAY_SNAPSHOT || path.join(storeDir, "sporttery-relay-snapshot.json");
const finiteEnvNumber = (value, fallback, options = {}) => {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : -Number.MAX_SAFE_INTEGER;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
  const clamped = Math.min(Math.max(candidate, Math.min(min, max)), Math.max(min, max));
  return options.integer === false ? clamped : Math.round(clamped);
};
const PAGE_SIZE = finiteEnvNumber(process.env.SPORTTERY_PAGE_SIZE, 80, { min: 1, max: 200 });
const PAGE_DEPTH = finiteEnvNumber(
  process.env.SPORTTERY_RELAY_PAGE_DEPTH ?? process.env.SPORTTERY_PAGE_DEPTH,
  120,
  { min: 1, max: 500 }
);
const RESULT_PAGE_DEPTH = finiteEnvNumber(process.env.SPORTTERY_RELAY_RESULT_PAGE_DEPTH, PAGE_DEPTH, {
  min: 1,
  max: 500
});
const MAX_AGE_MINUTES = finiteEnvNumber(process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES, 20, {
  min: 1,
  max: 24 * 60
});
const WRITE_FAILED_SNAPSHOT = process.env.SPORTTERY_RELAY_WRITE_FAILED === "1"
  || process.env.SPORTTERY_RELAY_OVERWRITE_ON_FAILURE === "1";
// The dedicated fast-result watcher probes only result page 1 on its normal
// cadence, then requests current/calculator exactly once when that page's
// settlement fingerprint changes. Full and one-minute relay collection keep
// the built-in initial endpoints enabled by default.
const skipInitialEndpoints = process.env.SPORTTERY_RELAY_SKIP_INITIAL === "1";
const relayMethodsInput = Object.prototype.hasOwnProperty.call(process.env, "SPORTTERY_RELAY_METHODS")
  ? process.env.SPORTTERY_RELAY_METHODS
  : Object.prototype.hasOwnProperty.call(process.env, "SPORTTERY_METHODS")
    ? process.env.SPORTTERY_METHODS
    : "concern,live,result,all";
const methods = /^(none|current-only|initial-only)$/i.test(String(relayMethodsInput).trim())
  ? []
  : relayMethodsInput
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const nowIso = () => new Date().toISOString();

const sha256Buffer = (value) => crypto
  .createHash("sha256")
  .update(Buffer.isBuffer(value) ? value : Buffer.from(value || ""))
  .digest("hex");

const createSourceCycleId = (requestedAt = nowIso()) => (
  `sporttery-relay:${String(requestedAt).replace(/[^0-9A-Za-z]/g, "")}:${crypto.randomUUID()}`
);

const loadCollectorAttestationSigner = (env = process.env) => {
  const privateKeyPath = normText(env.SPORTTERY_COLLECTOR_PRIVATE_KEY_PATH);
  const keyId = normText(env.SPORTTERY_COLLECTOR_KEY_ID);
  if (!privateKeyPath && !keyId) return null;
  if (!privateKeyPath || !keyId) {
    throw new Error("collector attestation requires both SPORTTERY_COLLECTOR_PRIVATE_KEY_PATH and SPORTTERY_COLLECTOR_KEY_ID");
  }
  return {
    keyId,
    privateKeyPem: fs.readFileSync(path.resolve(privateKeyPath), "utf8"),
  };
};

const isoAtOrAfter = (candidate, floor) => {
  const candidateMs = Date.parse(candidate || "");
  const floorMs = Date.parse(floor || "");
  if (!Number.isFinite(candidateMs)) return floor;
  if (!Number.isFinite(floorMs) || candidateMs >= floorMs) return new Date(candidateMs).toISOString();
  return new Date(floorMs).toISOString();
};

const normText = (value, fallback = "") => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
};

const outboundProxy = () => normText(process.env.SPORTTERY_OUTBOUND_PROXY || process.env.SPORTTERY_HTTP_PROXY || "");

const maskProxyUrl = (value) => {
  const proxy = normText(value);
  if (!proxy) return null;
  try {
    const parsed = new URL(proxy);
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return proxy.replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
};

const classifyError = (message) => {
  const text = String(message || "");
  if (/HTTP (?:403|429|567)|WAF|TencentCaptcha|WafCaptcha|__captcha|captcha\.qq\.com|Unexpected token '<'|<!DOCTYPE html|<script/i.test(text)) return "waf-blocked";
  if (/invalid JSON|Unexpected token '<'|<!DOCTYPE html/i.test(text)) return "html-response";
  if (/timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(text)) return "network";
  if (/sporttery_api_/i.test(text)) return "sporttery-api";
  return "unknown";
};

const curlHeaderArgs = (url, tab = "all") => Object.entries(
  sportteryRequestHeaders(url, tab),
).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);

const rowsInPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const parseProviderObservedAt = (updateDate, updateTime) => {
  const date = normText(updateDate);
  const time = normText(updateTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  const parsed = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const parseProviderLastUpdateTime = (value) => {
  const raw = normText(value);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const providerObservationFromPayload = (payload) => {
  let latest = null;
  const remember = (candidate) => {
    if (!candidate?.observedAt) return;
    if (!latest || Date.parse(candidate.observedAt) > Date.parse(latest.observedAt)) {
      latest = candidate;
    }
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const observedAt = parseProviderObservedAt(value.updateDate, value.updateTime);
      remember(observedAt ? {
        observedAt,
        updateDate: normText(value.updateDate),
        updateTime: normText(value.updateTime),
        source: "sporttery-payload-updateDate-updateTime",
      } : null);
      const lastUpdateObservedAt = parseProviderLastUpdateTime(value.lastUpdateTime);
      remember(lastUpdateObservedAt ? {
        observedAt: lastUpdateObservedAt,
        lastUpdateTime: normText(value.lastUpdateTime),
        source: "sporttery-payload-lastUpdateTime",
      } : null);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(payload);
  return latest;
};

const responseHeaders = (headers = {}) => ({
  date: normText(headers.date || headers.Date) || null,
  etag: normText(headers.etag || headers.ETag) || null,
  contentType: normText(headers["content-type"] || headers["Content-Type"]) || null,
});

const canonicalResponseHeaders = (headers = {}) => Object.fromEntries(Object.entries(headers)
  .map(([key, value]) => [String(key).trim().toLowerCase(), Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value ?? "")])
  .sort(([left], [right]) => left.localeCompare(right)));

const responseAudit = (response = null) => {
  const hasResponse = Boolean(response && typeof response === "object");
  const hasRawBody = Buffer.isBuffer(response?.rawBody);
  const rawBody = hasRawBody ? response.rawBody : Buffer.alloc(0);
  const headers = responseHeaders(response?.headers);
  return {
    httpStatus: response?.statusCode !== null
      && response?.statusCode !== undefined
      && Number.isInteger(Number(response.statusCode))
      ? Number(response.statusCode)
      : null,
    httpDate: headers.date,
    httpEtag: headers.etag,
    contentType: headers.contentType,
    headersSha256: hasResponse ? sha256CollectorJson(canonicalResponseHeaders(response?.headers)) : null,
    rawBytes: hasRawBody ? rawBody.length : null,
    rawSha256: hasResponse && hasRawBody ? sha256Buffer(rawBody) : null,
  };
};

const requestFailure = (message, response = null) => {
  const error = new Error(message);
  if (response) error.response = response;
  return error;
};

const requestJsonDirect = (url, tab = "all") => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: "GET",
    headers: sportteryRequestHeaders(url, tab),
  }, (res) => {
    const chunks = [];
    let rawBytes = 0;
    res.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      rawBytes += buffer.length;
      if (rawBytes > 20_000_000) req.destroy(new Error(`sporttery response too large: ${url}`));
    });
    res.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const response = {
        statusCode: Number(res.statusCode || 0),
        headers: res.headers || {},
        rawBody,
      };
      const body = rawBody.toString("utf8");
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(requestFailure(`${url} -> HTTP ${res.statusCode} ${body.slice(0, 180).replace(/\s+/g, " ")}`, response));
        return;
      }
      try {
        const payload = JSON.parse(body);
        if (payload?.success === false) {
          reject(requestFailure(`sporttery_api_${payload.errorCode || "unknown"}`, response));
          return;
        }
        resolve({ ...response, payload });
      } catch (error) {
        reject(requestFailure(`invalid JSON from ${url}: ${error.message}`, response));
      }
    });
  });
  const timeoutSeconds = finiteEnvNumber(process.env.SPORTTERY_TIMEOUT_SECONDS, 20, {
    min: 8,
    max: 120
  });
  req.setTimeout(timeoutSeconds * 1000, () => {
    req.destroy(new Error(`timeout: ${url}`));
  });
  req.on("error", reject);
  req.end();
});

const curlConfigQuote = (value) => {
  const text = String(value || "");
  if (!text || /[\r\n\0]/.test(text)) throw new Error("unsafe proxy configuration");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const buildCurlInvocation = (url, tab, proxy) => {
  const connectTimeoutSeconds = finiteEnvNumber(process.env.SPORTTERY_CURL_CONNECT_TIMEOUT_SECONDS, 8, {
    min: 3,
    max: 60
  });
  const maxTimeSeconds = finiteEnvNumber(process.env.SPORTTERY_CURL_MAX_TIME_SECONDS, 25, {
    min: 8,
    max: 180
  });
  return {
    args: [
      "--config",
      "-",
      "-fsSL",
      "--connect-timeout",
      String(connectTimeoutSeconds),
      "--max-time",
      String(maxTimeSeconds),
      ...curlHeaderArgs(url, tab),
      url,
    ],
    // Keep authenticated proxy URLs off argv/process listings. Curl reads this
    // one-line config through its private stdin pipe.
    stdinConfig: `proxy = ${curlConfigQuote(proxy)}\n`
  };
};

const parseCurlResponseHeaders = (text) => {
  const blocks = String(text || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => /^HTTP\//i.test(block));
  const block = blocks.at(-1) || "";
  const lines = block.split(/\r?\n/);
  const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d{3})/i);
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return {
    statusCode: statusMatch ? Number(statusMatch[1]) : null,
    headers,
  };
};

const requestJsonViaCurl = (url, tab, proxy) => new Promise((resolve, reject) => {
  let invocation;
  try {
    invocation = buildCurlInvocation(url, tab, proxy);
  } catch (error) {
    reject(error);
    return;
  }
  const headerPath = path.join(os.tmpdir(), `sporttery-curl-${process.pid}-${crypto.randomUUID()}.headers`);
  const args = [...invocation.args.slice(0, -1), "--dump-header", headerPath, invocation.args.at(-1)];
  const child = spawn(process.env.CURL_BIN || "curl", args, { cwd: rootDir, shell: false });
  const bodyChunks = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    try { fs.unlinkSync(headerPath); } catch { /* curl did not create it */ }
    reject(error);
  });
  child.on("exit", (code) => {
    const rawBody = Buffer.concat(bodyChunks);
    let parsedHeaders = { statusCode: null, headers: {} };
    try {
      parsedHeaders = parseCurlResponseHeaders(fs.readFileSync(headerPath, "utf8"));
    } catch {
      // A transport failure may happen before curl creates the header file.
    } finally {
      try { fs.unlinkSync(headerPath); } catch { /* already absent */ }
    }
    const response = { ...parsedHeaders, rawBody };
    const body = rawBody.toString("utf8");
    if (code !== 0) {
      reject(requestFailure(`${url} -> curl exited ${code}${stderr ? ` ${stderr.slice(0, 220).replace(/\s+/g, " ")}` : ""}`, response));
      return;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      reject(requestFailure(`${url} -> HTTP ${response.statusCode || "unknown"} ${body.slice(0, 180).replace(/\s+/g, " ")}`, response));
      return;
    }
    try {
      const payload = JSON.parse(body);
      if (payload?.success === false) {
        reject(requestFailure(`sporttery_api_${payload.errorCode || "unknown"}`, response));
        return;
      }
      resolve({ ...response, payload });
    } catch (error) {
      reject(requestFailure(`invalid JSON from ${url}: ${error.message}`, response));
    }
  });
  child.stdin.on("error", (error) => reject(error));
  child.stdin.end(invocation.stdinConfig);
});

const requestJson = async (url, tab = "all") => {
  const proxy = outboundProxy();
  try {
    return await (proxy
      ? requestJsonViaCurl(url, tab, proxy)
      : requestJsonDirect(url, tab));
  } catch (error) {
    if (!browserFallbackEnabled()) throw error;
    try {
      return await requestJsonViaEdgeDocument(url);
    } catch (browserError) {
      browserError.cause = error;
      const browserStatus = Number(browserError?.response?.statusCode);
      const directStatus = Number(error?.response?.statusCode);
      // A browser startup/navigation/parser failure must not erase a concrete
      // status already observed by the direct official request. Keeping the
      // response here lets the collector classify WAF 403s, retain the raw
      // response hash, and apply the long WAF backoff instead of hammering the
      // endpoint every generic collector interval.
      if (
        (!Number.isInteger(browserStatus) || browserStatus <= 0)
        && Number.isInteger(directStatus)
        && directStatus > 0
      ) {
        const wrapped = requestFailure(
          `browser fallback failed after HTTP ${directStatus}: ${browserError.message || browserError}`,
          error.response,
        );
        wrapped.cause = browserError;
        throw wrapped;
      }
      throw browserError;
    }
  }
};

const buildPageUrl = (method, pageNo = null, pageType = null) => {
  if (String(method || "").toLowerCase() === "result") return RESULT_URL;
  const params = new URLSearchParams();
  params.set("method", method);
  params.set("pageSize", String(PAGE_SIZE));
  if (pageNo !== null && pageNo !== undefined) params.set("pageNo", String(pageNo));
  if (pageType !== null && pageType !== undefined) params.set("pageType", String(pageType));
  return `${SPORTTERY_BASE}/gateway/uniform/fb/getMatchDataPageListV1.qry?${params.toString()}`;
};

const fetchEndpoint = async ({
  id,
  method,
  url,
  page = null,
  tab = "all",
  sourceCycleId,
  role = null,
  attestationSigner = null,
  request = requestJson,
  clock = nowIso,
}) => {
  const requestedAt = clock();
  const endpointRole = normText(role || id || method, "endpoint");
  const sourceRequest = { url, method: "GET", page, role: endpointRole };
  try {
    const response = await request(url, tab);
    const receivedAt = isoAtOrAfter(clock(), requestedAt);
    const payload = isOfficialUniformResultUrl(url)
      ? normalizeOfficialUniformResultPayload(response?.payload)
      : response?.payload;
    const providerObservation = providerObservationFromPayload(payload);
    const audit = responseAudit(response);
    const canonicalPayloadSha256 = sha256CollectorJson(payload);
    const collectorCommitment = buildCollectorCommitment({
      provider: "sporttery",
      endpoint: { url, method: "GET", page, role: endpointRole },
      collectorCycleId: sourceCycleId,
      requestedAt,
      receivedAt,
      providerObservedAt: providerObservation?.observedAt || null,
      response: audit,
      payload,
      canonicalPayloadSha256,
    });
    const collectorAttestation = attestationSigner
      ? signCollectorCommitment(collectorCommitment, attestationSigner)
      : null;
    return {
      id,
      method,
      page,
      url,
      fetchedAt: receivedAt,
      requestedAt,
      receivedAt,
      sourceCycleId,
      sourceRequest,
      collectorRole: endpointRole,
      transport: response?.transport || (outboundProxy() ? "curl-proxy" : "https-direct"),
      ...audit,
      canonicalPayloadSha256,
      collectorAttestation,
      providerObservedAt: providerObservation?.observedAt || null,
      providerObservation: providerObservation
        ? {
            ...providerObservation,
            source: providerObservation.source || "sporttery-payload-updateDate-updateTime",
            timezone: "+08:00",
          }
        : null,
      collectorProvenance: {
        sourceCycleId,
        requestedAt,
        receivedAt,
        sourceRequest,
        transport: response?.transport || (outboundProxy() ? "curl-proxy" : "https-direct"),
        ...audit,
        canonicalPayloadSha256,
        collectorAttestation,
      },
      ok: true,
      rows: rowsInPayload(payload),
      payload,
    };
  } catch (error) {
    const receivedAt = isoAtOrAfter(clock(), requestedAt);
    const audit = responseAudit(error?.response);
    error.collectorAudit = {
      sourceCycleId,
      requestedAt,
      receivedAt,
      fetchedAt: receivedAt,
      sourceRequest,
      ...audit,
      providerObservedAt: null,
      providerObservation: null,
    };
    throw error;
  }
};

const fetchMethodPages = async (method, sourceCycleId, options = {}) => {
  const endpoints = [];
  const firstUrl = buildPageUrl(method);
  endpoints.push(await fetchEndpoint({
    id: `method:${method}:1`,
    method,
    url: firstUrl,
    page: 1,
    tab: method,
    sourceCycleId,
    role: `method:${method}`,
    attestationSigner: options.attestationSigner || null,
  }));
  if (method === "result") return endpoints;
  if (method !== "all") return endpoints;

  const pageDepth = PAGE_DEPTH;
  for (let page = 2; page <= pageDepth; page += 1) {
    const pageUrl = buildPageUrl(method, page, 0);
    const endpoint = await fetchEndpoint({
      id: `method:${method}:${page}`,
      method,
      url: pageUrl,
      page,
      tab: method,
      sourceCycleId,
      role: `method:${method}`,
      attestationSigner: options.attestationSigner || null,
    });
    if (!endpoint.rows) break;
    endpoints.push(endpoint);
    const hasMore = endpoint.payload?.value?.prePage && String(endpoint.payload.value.prePage) !== "0";
    if (!hasMore) break;
  }
  return endpoints;
};

const collectorErrorRecord = ({
  id,
  method = null,
  url = null,
  error,
  sourceCycleId,
}) => {
  const collectorAudit = error?.collectorAudit && typeof error.collectorAudit === "object"
    ? error.collectorAudit
    : {};
  return {
    id,
    ...(method ? { method } : {}),
    ...(url ? { url } : {}),
    error: error?.message || String(error),
    ...collectorAudit,
    // A failed attempt still belongs to the collector cycle that issued it.
    // Keep that identity even when a transport replaces the original Error
    // object and drops the fetchEndpoint audit attachment.
    sourceCycleId: String(collectorAudit.sourceCycleId || sourceCycleId || "").trim() || null,
  };
};

const writeJson = (filePath, payload) => {
  if (filePath === "-") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
};

const main = async () => {
  const capturedAt = nowIso();
  const sourceCycleId = createSourceCycleId(capturedAt);
  const endpoints = [];
  const errors = [];
  const proxy = outboundProxy();
  const attestationSigner = loadCollectorAttestationSigner();
  const initial = skipInitialEndpoints ? [] : [
    { id: "calculator", method: "calculator", url: CALCULATOR_URL, tab: "concern" },
    { id: "current", method: "current", url: CURRENT_URL, tab: "concern" },
  ];

  for (const endpoint of initial) {
    try {
      endpoints.push(await fetchEndpoint({
        ...endpoint,
        sourceCycleId,
        role: endpoint.id,
        attestationSigner,
      }));
    } catch (error) {
      errors.push(collectorErrorRecord({
        id: endpoint.id,
        url: endpoint.url,
        error,
        sourceCycleId,
      }));
    }
  }

  for (const method of methods) {
    try {
      endpoints.push(...await fetchMethodPages(method, sourceCycleId, { attestationSigner }));
    } catch (error) {
      errors.push(collectorErrorRecord({
        id: `method:${method}`,
        method,
        error,
        sourceCycleId,
      }));
    }
  }

  const usable = endpoints.filter((endpoint) => endpoint.ok && endpoint.rows > 0);
  const completedAt = isoAtOrAfter(nowIso(), capturedAt);
  const payload = {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt,
    sourceCycleId,
    requestedAt: capturedAt,
    completedAt,
    provenanceVersion: 1,
    collectorProvenance: {
      sourceCycleId,
      requestedAt: capturedAt,
      completedAt,
      clock: "collector-owned-wall-clock",
    },
    maxAgeMinutes: MAX_AGE_MINUTES,
    producer: {
      host: os.hostname(),
      platform: process.platform,
      transport: proxy ? "proxy" : "direct",
      proxy: maskProxyUrl(proxy),
      collectorAttestationKeyId: attestationSigner?.keyId || null,
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: usable.length,
      rows: endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
      errors: errors.length,
      errorClasses: errors.reduce((acc, item) => {
        const key = classifyError(item.error);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      methods,
      skipInitialEndpoints,
      pageDepth: PAGE_DEPTH,
      resultPageDepth: RESULT_PAGE_DEPTH,
      resultScope: methods.includes("result") ? "latest-official-payout-results" : null,
    },
    endpoints,
    errors,
  };

  const cycleAudit = snapshotCycleDetails(payload);
  if (!cycleAudit.atomic) {
    throw new Error(`collector refused to publish a non-atomic Sporttery snapshot: ${JSON.stringify(cycleAudit)}`);
  }

  const hasUsableRows = usable.length > 0;
  const preserveExisting = !hasUsableRows
    && !WRITE_FAILED_SNAPSHOT
    && outputPath !== "-"
    && fs.existsSync(outputPath);
  const failedOutputPath = process.env.SPORTTERY_RELAY_FAILED_SNAPSHOT_OUT
    || (outputPath === "-" ? "-" : `${outputPath}.last-failed.json`);
  writeJson(preserveExisting ? failedOutputPath : outputPath, payload);
  console.error(JSON.stringify({
    ok: hasUsableRows,
    outputPath,
    writtenPath: preserveExisting ? failedOutputPath : outputPath,
    preservedExisting: preserveExisting,
    capturedAt,
    sourceCycleId,
    completedAt,
    summary: payload.summary,
    errors,
  }, null, 2));
  if (!hasUsableRows) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildPageUrl,
  buildCurlInvocation,
  classifyError,
  collectorErrorRecord,
  curlConfigQuote,
  createSourceCycleId,
  fetchEndpoint,
  finiteEnvNumber,
  loadCollectorAttestationSigner,
  parseCurlResponseHeaders,
  providerObservationFromPayload,
  canonicalResponseHeaders,
  sha256Buffer
};
