const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const SPORTTERY_API_HOST = "webapi.sporttery.cn";
const SPORTTERY_BROWSER_REFERER = "https://m.sporttery.cn/";
const SPORTTERY_BROWSER_RESULT_PAGE = "https://www.sporttery.cn/ltkj/";
const MAX_RESPONSE_BYTES = 20_000_000;
const SPORTTERY_PROFILE_PREFIXES = Object.freeze([
  "football-sporttery-edge-",
  "football-sporttery-result-edge-",
]);
const STALE_PROFILE_MIN_AGE_MS = 15 * 60 * 1000;
const STALE_PROFILE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_PROFILE_PRUNE_LIMIT = 32;
const STALE_PROFILE_PRUNE_TIME_BUDGET_MS = 2_000;
const SPORTTERY_PROFILE_SUFFIX_PATTERN = /^[A-Za-z0-9]{6}$/u;
let lastProfilePruneAt = 0;
const {
  isOfficialUniformResultUrl,
} = require("./sportteryOfficialResult.cjs");

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const finiteTimeoutMs = (env = process.env) => {
  const seconds = Number(env.SPORTTERY_BROWSER_FALLBACK_TIMEOUT_SECONDS || 25);
  return Math.max(8, Math.min(60, Number.isFinite(seconds) ? seconds : 25)) * 1000;
};

const validateSportteryBrowserUrl = (value) => {
  const parsed = new URL(String(value || ""));
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== SPORTTERY_API_HOST
    || !parsed.pathname.startsWith("/gateway/")
  ) {
    throw new Error("browser transport only permits the official Sporttery gateway");
  }
  return parsed.toString();
};

const edgeCandidates = (env = process.env) => [
  env.SPORTTERY_BROWSER_EXECUTABLE,
  env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : "",
  env["ProgramFiles(x86)"]
    ? path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe")
    : "",
  env.ProgramFiles
    ? path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")
    : "",
].filter(Boolean);

const resolveSportteryBrowserExecutable = (env = process.env) => {
  if (process.platform !== "win32") return null;
  return edgeCandidates(env).find((candidate) => {
    try {
      return fs.statSync(path.resolve(candidate)).isFile();
    } catch {
      return false;
    }
  }) || null;
};

const browserFallbackEnabled = (env = process.env) => (
  process.platform === "win32"
  && env.SPORTTERY_BROWSER_FALLBACK !== "0"
  && Boolean(resolveSportteryBrowserExecutable(env))
);

const stopBrowserTree = (child) => {
  if (!child?.pid) return;
  try {
    child.kill();
  } catch {
    // The browser may already have exited after a failed navigation.
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {
      // The exact process tree is already gone.
    }
  }
};

const ownedProfileName = (name) => SPORTTERY_PROFILE_PREFIXES.some((prefix) => (
  String(name || "").startsWith(prefix)
  && SPORTTERY_PROFILE_SUFFIX_PATTERN.test(String(name).slice(prefix.length))
));

const ownedProfilePath = (profileDir) => {
  if (typeof profileDir !== "string" || !profileDir) return null;
  let tempRoot;
  let resolved;
  try {
    tempRoot = path.resolve(os.tmpdir());
    resolved = path.resolve(profileDir);
  } catch {
    return null;
  }
  const relative = path.relative(tempRoot, resolved);
  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
    || !ownedProfileName(relative)
  ) return null;
  return resolved;
};

const cleanupProfile = (profileDir) => {
  const resolved = ownedProfilePath(profileDir);
  if (!resolved) return false;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    // Chromium can retain lock files briefly after its process tree exits.
    // Node's bounded retry loop prevents those transient Windows locks from
    // turning every polling cycle into a permanent multi-megabyte profile.
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 250,
    });
    return !fs.existsSync(resolved);
  } catch {
    return false;
  }
};

const pruneStaleSportteryProfiles = ({
  now = Date.now(),
  minAgeMs = STALE_PROFILE_MIN_AGE_MS,
  limit = STALE_PROFILE_PRUNE_LIMIT,
  timeBudgetMs = STALE_PROFILE_PRUNE_TIME_BUDGET_MS,
  force = false,
} = {}) => {
  const numericNow = Number(now);
  const safeNow = Number.isFinite(numericNow) ? numericNow : Date.now();
  const numericMinAgeMs = Number(minAgeMs);
  const safeMinAgeMs = Math.max(
    60_000,
    Number.isFinite(numericMinAgeMs) ? numericMinAgeMs : STALE_PROFILE_MIN_AGE_MS,
  );
  const numericLimit = Number(limit);
  const safeLimit = Math.max(
    1,
    Math.min(2_048, Math.floor(Number.isFinite(numericLimit) ? numericLimit : STALE_PROFILE_PRUNE_LIMIT)),
  );
  const numericTimeBudgetMs = Number(timeBudgetMs);
  const safeTimeBudgetMs = Math.max(
    100,
    Math.min(10_000, Number.isFinite(numericTimeBudgetMs)
      ? numericTimeBudgetMs
      : STALE_PROFILE_PRUNE_TIME_BUDGET_MS),
  );
  const elapsedSincePrune = safeNow - lastProfilePruneAt;
  if (
    !force
    && lastProfilePruneAt > 0
    && elapsedSincePrune >= 0
    && elapsedSincePrune < STALE_PROFILE_PRUNE_INTERVAL_MS
  ) return { scanned: 0, eligible: 0, removed: 0, throttled: true };
  lastProfilePruneAt = safeNow;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return { scanned: 0, eligible: 0, removed: 0, throttled: false };
  }
  let eligible = 0;
  let removed = 0;
  const pruneStartedAt = Date.now();
  const candidates = entries
    .filter((entry) => (
      entry.isDirectory()
      && ownedProfileName(entry.name)
    ))
    .map((entry) => path.join(os.tmpdir(), entry.name))
    .filter((entryPath) => {
      try {
        const stat = fs.lstatSync(entryPath);
        return stat.isDirectory()
          && !stat.isSymbolicLink()
          && lastProfilePruneAt - stat.mtimeMs >= safeMinAgeMs;
      } catch {
        return false;
      }
    })
    .slice(0, safeLimit);
  eligible = candidates.length;
  for (const candidate of candidates) {
    // Stale-profile hygiene must never consume the live collector's network
    // deadline. One slow Windows lock cleanup is enough for this cycle; the
    // next short-lived collector will continue the bounded backlog sweep.
    if (Date.now() - pruneStartedAt >= safeTimeBudgetMs) break;
    if (cleanupProfile(candidate)) removed += 1;
  }
  return { scanned: entries.length, eligible, removed, throttled: false };
};

const createSportteryProfile = (prefix) => {
  if (!SPORTTERY_PROFILE_PREFIXES.includes(prefix)) {
    throw new Error("refusing to create an unowned Sporttery browser profile");
  }
  pruneStaleSportteryProfiles();
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
};

const waitForDevToolsUrl = async (profileDir, timeoutMs) => {
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port, websocketPath] = fs
        .readFileSync(activePortPath, "utf8")
        .trim()
        .split(/\r?\n/);
      if (port && websocketPath) {
        return `ws://127.0.0.1:${port}${websocketPath}`;
      }
    } catch {
      // Edge has not opened the debugging socket yet.
    }
    await wait(100);
  }
  throw new Error("Sporttery browser transport DevTools startup timeout");
};

const openCdp = async (websocketUrl, timeoutMs) => {
  if (typeof WebSocket !== "function") {
    throw new Error("Sporttery browser transport requires a Node WebSocket runtime");
  }
  const socket = new WebSocket(websocketUrl);
  const pending = new Map();
  const events = [];
  let commandId = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Sporttery browser transport WebSocket timeout")),
      timeoutMs,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Sporttery browser transport WebSocket failed"));
    };
  });
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) events.push(message);
  };
  const send = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Sporttery browser transport command timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    }));
  });
  return {
    close: () => {
      try {
        socket.close();
      } catch {
        // The browser process may already have closed the socket.
      }
    },
    events,
    send,
  };
};

const waitForJsonDocument = async ({ cdp, sessionId, targetUrl, timeoutMs }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: "({readyState:document.readyState,text:document.body?.innerText||''})",
      returnByValue: true,
    }, sessionId);
    const value = evaluated?.result?.value || {};
    if (value.readyState === "complete" && value.text) {
      const rawBody = Buffer.from(String(value.text), "utf8");
      if (rawBody.length > MAX_RESPONSE_BYTES) {
        throw new Error("Sporttery browser response exceeded the byte limit");
      }
      // Do not parse before the Network response metadata is inspected. A WAF
      // response is an HTML document whose body is ready before the caller can
      // classify its HTTP 403. Parsing here used to replace that authoritative
      // status with a generic "invalid JSON" error and discard the response
      // audit needed by the signed collector.
      return { rawBody };
    }
    await wait(100);
  }
  throw new Error(`Sporttery browser document timeout: ${targetUrl}`);
};

const browserResponseFailure = (message, response = null) => {
  const error = new Error(message);
  if (response) error.response = response;
  return error;
};

const sameGatewayRequest = (observedUrl, targetUrl) => {
  try {
    const observed = new URL(String(observedUrl || ""));
    const target = new URL(String(targetUrl || ""));
    if (
      observed.protocol !== target.protocol
      || observed.hostname.toLowerCase() !== target.hostname.toLowerCase()
      || observed.pathname !== target.pathname
    ) return false;
    return Array.from(target.searchParams.entries())
      .every(([key, value]) => observed.searchParams.get(key) === value);
  } catch {
    return false;
  }
};

const parseBrowserDocumentResponse = ({
  targetUrl,
  responseEvent = null,
  rawBody,
}) => {
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ""), "utf8");
  const response = responseEvent?.params?.response || {};
  const statusValue = Number(response.status);
  const statusCode = Number.isInteger(statusValue) && statusValue > 0
    ? statusValue
    : null;
  const auditedResponse = {
    statusCode,
    headers: response.headers || {},
    rawBody: bodyBuffer,
  };
  const bodyText = bodyBuffer.toString("utf8");
  if (!statusCode) {
    throw browserResponseFailure(
      `Sporttery browser response metadata missing: ${targetUrl}`,
      auditedResponse,
    );
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw browserResponseFailure(
      `${targetUrl} -> HTTP ${statusCode} ${bodyText.slice(0, 180).replace(/\s+/g, " ")}`,
      auditedResponse,
    );
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    throw browserResponseFailure(
      `invalid JSON from ${targetUrl}: ${error.message}`,
      auditedResponse,
    );
  }
  if (payload?.success === false) {
    throw browserResponseFailure(
      `sporttery_api_${payload.errorCode || "unknown"}`,
      auditedResponse,
    );
  }
  return {
    ...auditedResponse,
    payload,
    transport: "edge-cdp-document",
  };
};

const waitForNetworkJsonResponse = async ({
  cdp,
  sessionId,
  targetUrl,
  timeoutMs,
}) => {
  const deadline = Date.now() + timeoutMs;
  let lastBodyError = null;
  while (Date.now() < deadline) {
    const responseEvent = [...cdp.events].reverse().find((entry) => (
      entry.sessionId === sessionId
      && entry.method === "Network.responseReceived"
      && sameGatewayRequest(entry.params?.response?.url, targetUrl)
    ));
    if (responseEvent?.params?.requestId) {
      try {
        const body = await cdp.send("Network.getResponseBody", {
          requestId: responseEvent.params.requestId,
        }, sessionId);
        const rawBody = Buffer.from(
          String(body?.body || ""),
          body?.base64Encoded ? "base64" : "utf8",
        );
        if (rawBody.length > MAX_RESPONSE_BYTES) {
          throw new Error("Sporttery browser response exceeded the byte limit");
        }
        return parseBrowserDocumentResponse({
          targetUrl,
          responseEvent,
          rawBody,
        });
      } catch (error) {
        if (error?.response || /exceeded the byte limit/i.test(error?.message || "")) throw error;
        lastBodyError = error;
      }
    }
    await wait(100);
  }
  throw new Error(
    `Sporttery official result page response timeout: ${targetUrl}`
      + (lastBodyError ? ` (${lastBodyError.message || lastBodyError})` : ""),
  );
};

const waitForPageReady = async ({ cdp, sessionId, timeoutMs }) => {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    }, sessionId);
    if (evaluated?.result?.value === "complete") return;
    await wait(100);
  }
  throw new Error("Sporttery official result page document timeout");
};

const requestJsonViaOfficialResultPage = async (
  url,
  options = {},
) => {
  const targetUrl = validateSportteryBrowserUrl(url);
  if (!isOfficialUniformResultUrl(targetUrl)) {
    throw new Error("official result page transport only permits the latest football payout endpoint");
  }
  const env = options.env || process.env;
  const executable = resolveSportteryBrowserExecutable(env);
  if (!executable) throw new Error("Sporttery browser executable unavailable");
  const timeoutMs = Number(options.timeoutMs || finiteTimeoutMs(env));
  const headfulResultBrowser = env.SPORTTERY_BROWSER_RESULT_HEADFUL === "1";
  const profileDir = createSportteryProfile("football-sporttery-result-edge-");
  const child = spawn(executable, [
    ...(headfulResultBrowser
      ? ["--window-position=-32000,-32000", "--window-size=800,600"]
      : ["--headless=new"]),
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
  let cdp = null;
  try {
    const websocketUrl = await waitForDevToolsUrl(profileDir, timeoutMs);
    cdp = await openCdp(websocketUrl, timeoutMs);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Network.setExtraHTTPHeaders", {
      headers: {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    }, sessionId);
    const navigation = await cdp.send("Page.navigate", {
      url: SPORTTERY_BROWSER_RESULT_PAGE,
      referrer: "https://www.sporttery.cn/",
    }, sessionId);
    if (navigation?.errorText) {
      throw new Error(`Sporttery official result page navigation failed: ${navigation.errorText}`);
    }
    await waitForPageReady({ cdp, sessionId, timeoutMs });
    // The public page normally requests this endpoint itself. Trigger one
    // same-page fetch as a deterministic fallback when a deferred script or
    // cache suppresses that initial XHR; the Network domain still captures the
    // original official response bytes and headers for attestation.
    await cdp.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(targetUrl)}, { credentials: "include" }).catch(() => null)`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    let response;
    try {
      response = await waitForNetworkJsonResponse({
        cdp,
        sessionId,
        targetUrl,
        timeoutMs,
      });
    } catch (error) {
      const documentState = await cdp.send("Runtime.evaluate", {
        expression: "({href:location.href,title:document.title,readyState:document.readyState})",
        returnByValue: true,
      }, sessionId).catch(() => null);
      const observed = cdp.events
        .filter((entry) => (
          entry.sessionId === sessionId
          && ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed"].includes(entry.method)
        ))
        .map((entry) => {
          try {
            const url = entry.params?.response?.url || entry.params?.request?.url || "";
            const parsed = new URL(String(url));
            return {
              event: entry.method.replace("Network.", ""),
              host: parsed.hostname,
              path: parsed.pathname,
              status: Number(entry.params?.response?.status || 0) || null,
              error: entry.params?.errorText || null,
            };
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && (
          /webapi\.sporttery\.cn$/i.test(entry.host)
          || entry.event === "loadingFailed"
        ))
        .slice(-20);
      throw new Error(`${error.message || error}; page=${JSON.stringify(
        documentState?.result?.value || null,
      )}; observed=${JSON.stringify(observed)}`);
    }
    return {
      ...response,
      transport: "edge-cdp-official-result-page-xhr",
    };
  } finally {
    cdp?.close();
    stopBrowserTree(child);
    cleanupProfile(profileDir);
  }
};

const requestJsonViaEdgeDocument = async (
  url,
  options = {},
) => {
  const targetUrl = validateSportteryBrowserUrl(url);
  if (isOfficialUniformResultUrl(targetUrl)) {
    return requestJsonViaOfficialResultPage(targetUrl, options);
  }
  const env = options.env || process.env;
  const executable = resolveSportteryBrowserExecutable(env);
  if (!executable) throw new Error("Sporttery browser executable unavailable");
  const timeoutMs = Number(options.timeoutMs || finiteTimeoutMs(env));
  const profileDir = createSportteryProfile("football-sporttery-edge-");
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
  let cdp = null;
  try {
    const websocketUrl = await waitForDevToolsUrl(profileDir, timeoutMs);
    cdp = await openCdp(websocketUrl, timeoutMs);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Network.setExtraHTTPHeaders", {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Origin: "https://m.sporttery.cn",
      },
    }, sessionId);
    const navigation = await cdp.send("Page.navigate", {
      url: targetUrl,
      referrer: SPORTTERY_BROWSER_REFERER,
    }, sessionId);
    if (navigation?.errorText) {
      throw new Error(`Sporttery browser navigation failed: ${navigation.errorText}`);
    }
    const document = await waitForJsonDocument({
      cdp,
      sessionId,
      targetUrl,
      timeoutMs,
    });
    const responseEvent = [...cdp.events].reverse().find((entry) => (
      entry.sessionId === sessionId
      && entry.method === "Network.responseReceived"
      && entry.params?.response?.url === targetUrl
    ));
    return parseBrowserDocumentResponse({
      targetUrl,
      responseEvent,
      rawBody: document.rawBody,
    });
  } finally {
    cdp?.close();
    stopBrowserTree(child);
    cleanupProfile(profileDir);
  }
};

module.exports = {
  SPORTTERY_API_HOST,
  SPORTTERY_BROWSER_REFERER,
  SPORTTERY_BROWSER_RESULT_PAGE,
  browserFallbackEnabled,
  cleanupProfile,
  parseBrowserDocumentResponse,
  pruneStaleSportteryProfiles,
  requestJsonViaOfficialResultPage,
  requestJsonViaEdgeDocument,
  resolveSportteryBrowserExecutable,
  sameGatewayRequest,
  validateSportteryBrowserUrl,
};
