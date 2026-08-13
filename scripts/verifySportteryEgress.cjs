const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  SPORTTERY_BASE,
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  sportteryRequestHeaders,
} = require("./sportteryEndpointContract.cjs");

const endpoints = [
  {
    id: "current",
    tab: "all",
    url: SPORTTERY_CURRENT_URL
  },
  {
    id: "calculator",
    tab: "all",
    url: SPORTTERY_CALCULATOR_URL
  },
  {
    id: "method:all",
    tab: "all",
    url: `${SPORTTERY_BASE}/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all&pageSize=80`
  }
];

const timeoutSeconds = Math.max(5, Number(process.env.SPORTTERY_EGRESS_TIMEOUT_SECONDS || 20));
const minRows = Math.max(0, Number(process.env.SPORTTERY_EGRESS_MIN_ROWS || 1));
const auditOnly = process.env.SPORTTERY_EGRESS_AUDIT_ONLY === "1";
const requireProxy = process.env.SPORTTERY_EGRESS_REQUIRE_PROXY === "1";
const proxy = String(process.env.SPORTTERY_OUTBOUND_PROXY || process.env.SPORTTERY_HTTP_PROXY || "").trim();
const statusOut = String(process.env.SPORTTERY_EGRESS_STATUS_OUT || "").trim();

const maskProxy = (value) => {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, "//***@");
  }
};

const rowsInPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const classifyBody = (body, statusCode = 0) => {
  const text = String(body || "");
  const sample = text.slice(0, 240).replace(/\s+/g, " ").trim();
  const trimmed = text.trimStart();
  const html = trimmed.startsWith("<") || /<html|<script|<!doctype/i.test(text);
  const waf = html && /waf|risk|forbidden|forbid|captcha|script/i.test(text);
  return {
    html,
    wafBlocked: waf || statusCode === 403 || statusCode === 567,
    bodySample: sample
  };
};

const parseResponse = ({ id, url, statusCode, body, transport, error = null }) => {
  const classified = classifyBody(body, statusCode);
  let payload = null;
  let parseError = null;
  try {
    payload = body && !classified.html ? JSON.parse(body) : null;
  } catch (err) {
    parseError = err.message || String(err);
  }
  const rows = rowsInPayload(payload);
  const json = Boolean(payload && typeof payload === "object" && !parseError);
  const providerAccepted = json && payload?.success !== false;
  const providerError = json && payload?.success === false
    ? `sporttery_api_${payload?.errorCode || "unknown"}`
    : null;
  return {
    id,
    url,
    transport,
    statusCode,
    ok: statusCode >= 200 && statusCode < 400 && providerAccepted,
    json,
    providerAccepted,
    rows,
    html: classified.html,
    wafBlocked: classified.wafBlocked,
    error: error || parseError || providerError,
    bodySample: classified.bodySample
  };
};

const requestDirect = (endpoint) => new Promise((resolve) => {
  const target = new URL(endpoint.url);
  const req = https.request(target, {
    method: "GET",
    headers: sportteryRequestHeaders(endpoint.url, endpoint.tab)
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      resolve(parseResponse({
        id: endpoint.id,
        url: endpoint.url,
        statusCode: res.statusCode || 0,
        body,
        transport: "direct"
      }));
    });
  });
  req.setTimeout(timeoutSeconds * 1000, () => {
    req.destroy(new Error(`timeout after ${timeoutSeconds}s`));
  });
  req.on("error", (error) => {
    resolve(parseResponse({
      id: endpoint.id,
      url: endpoint.url,
      statusCode: 0,
      body: "",
      transport: "direct",
      error: error.message || String(error)
    }));
  });
  req.end();
});

const requestViaCurl = (endpoint) => new Promise((resolve) => {
  const marker = "__SPORTTERY_HTTP_STATUS__:";
  const args = [
    "-sS",
    "-L",
    "--connect-timeout",
    String(Math.min(timeoutSeconds, 8)),
    "--max-time",
    String(timeoutSeconds),
    "--proxy",
    proxy,
    ...Object.entries(sportteryRequestHeaders(endpoint.url, endpoint.tab))
      .flatMap(([key, value]) => ["-H", `${key}: ${value}`]),
    "-w",
    `\n${marker}%{http_code}`,
    endpoint.url
  ];
  const child = spawn(process.env.CURL_BIN || "curl", args, { shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("close", (code) => {
    const markerIndex = stdout.lastIndexOf(marker);
    const body = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
    const statusText = markerIndex >= 0 ? stdout.slice(markerIndex + marker.length).trim() : "0";
    resolve(parseResponse({
      id: endpoint.id,
      url: endpoint.url,
      statusCode: Number(statusText) || 0,
      body,
      transport: "proxy",
      error: code === 0 ? null : (stderr.trim() || `curl exited ${code}`)
    }));
  });
  child.on("error", (error) => {
    resolve(parseResponse({
      id: endpoint.id,
      url: endpoint.url,
      statusCode: 0,
      body: "",
      transport: "proxy",
      error: error.message || String(error)
    }));
  });
});

const requestEndpoint = (endpoint) => proxy ? requestViaCurl(endpoint) : requestDirect(endpoint);

const writeStatus = (payload) => {
  if (!statusOut) return;
  const target = path.resolve(statusOut);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
};

(async () => {
  const results = [];
  for (const endpoint of endpoints) {
    results.push(await requestEndpoint(endpoint));
  }

  const jsonEndpoints = results.filter((result) => result.ok).length;
  const rows = results.reduce((sum, result) => sum + Number(result.rows || 0), 0);
  const wafBlocked = results.some((result) => result.wafBlocked);
  const htmlResponses = results.filter((result) => result.html).length;
  const http403 = results.filter((result) => result.statusCode === 403).length;
  const ok = (!requireProxy || Boolean(proxy)) && jsonEndpoints > 0 && rows >= minRows;
  const guidance = [];
  if (requireProxy && !proxy) {
    guidance.push("SPORTTERY_EGRESS_REQUIRE_PROXY=1 but SPORTTERY_OUTBOUND_PROXY/SPORTTERY_HTTP_PROXY is not configured");
  }
  if (wafBlocked || htmlResponses > 0 || http403 > 0) {
    guidance.push("Sporttery returned WAF/HTML/403; use a stable authenticated mainland egress or relay snapshot collector");
  }
  if (jsonEndpoints === 0) {
    guidance.push("no Sporttery endpoint returned JSON");
  }
  if (rows < minRows) {
    guidance.push(`Sporttery JSON rows below threshold ${rows}/${minRows}`);
  }

  const payload = {
    ok,
    status: ok ? "healthy" : "blocked",
    auditOnly,
    checkedAt: new Date().toISOString(),
    transport: proxy ? "proxy" : "direct",
    proxyConfigured: Boolean(proxy),
    proxy: maskProxy(proxy),
    thresholds: {
      minRows,
      timeoutSeconds,
      requireProxy
    },
    summary: {
      endpoints: results.length,
      jsonEndpoints,
      rows,
      wafBlocked,
      htmlResponses,
      http403
    },
    guidance,
    results
  };
  writeStatus(payload);
  console.log(JSON.stringify(payload, null, 2));
  if (!ok && !auditOnly) process.exitCode = 1;
})().catch((error) => {
  const payload = {
    ok: false,
    status: "error",
    auditOnly,
    checkedAt: new Date().toISOString(),
    error: error.message || String(error)
  };
  writeStatus(payload);
  console.error(JSON.stringify(payload, null, 2));
  if (!auditOnly) process.exitCode = 1;
});
