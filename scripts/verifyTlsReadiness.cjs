const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log(`Usage: node scripts/verifyTlsReadiness.cjs [--bootstrap|--strict]

Environment:
  TLS_VERIFY_BASE_URL       Origin to verify (default: http://134.175.132.183)
  TLS_VERIFY_MODE           bootstrap or strict
  TLS_EXPECT_IP             Expected IP SAN in strict IP mode
  TLS_MIN_REMAINING_HOURS   Required certificate runway (default: 36)
  TLS_VERIFY_TIMEOUT_MS     Per-request timeout (default: 12000)
  TLS_BOOTSTRAP_REQUIRE_ACME       Require ACME probe 404 in bootstrap mode
  TLS_BOOTSTRAP_REQUIRE_HARDENING  Require hidden Nginx version in bootstrap mode
  TLS_REQUIRE_HTTP_REDIRECT       Require HTTP to redirect in strict mode (default: 1)
  TLS_REQUIRE_HSTS          Require HSTS for DNS names (default: 1; ignored for IP literals)
`);
  process.exit(0);
}

const requestedMode = args.has("--strict")
  ? "strict"
  : args.has("--bootstrap")
    ? "bootstrap"
    : String(process.env.TLS_VERIFY_MODE || "bootstrap").toLowerCase();
const baseUrl = new URL(process.env.TLS_VERIFY_BASE_URL
  || process.env.PUBLIC_BASE_URL
  || process.env.REMOTE_BASE_URL
  || "http://134.175.132.183");
const expectedIp = process.env.TLS_EXPECT_IP || (net.isIP(baseUrl.hostname) ? baseUrl.hostname : "");
const timeoutMs = Math.max(1000, Number(process.env.TLS_VERIFY_TIMEOUT_MS || 12000));
const minRemainingHours = Math.max(1, Number(process.env.TLS_MIN_REMAINING_HOURS || 36));
const requireHsts = process.env.TLS_REQUIRE_HSTS !== "0";
const requireHttpRedirect = process.env.TLS_REQUIRE_HTTP_REDIRECT !== "0";
const bootstrapRequireAcme = process.env.TLS_BOOTSTRAP_REQUIRE_ACME === "1";
const bootstrapRequireHardening = process.env.TLS_BOOTSTRAP_REQUIRE_HARDENING === "1";
const checks = [];

const addCheck = (name, ok, details = {}, required = true) => {
  checks.push({ name, ok: Boolean(ok), required, ...details });
};

const request = (target, options = {}) => new Promise((resolve) => {
  const transport = target.protocol === "https:" ? https : http;
  const result = {
    url: target.href,
    status: 0,
    headers: {},
    bytes: 0,
    body: "",
    authorized: null,
    authorizationError: null,
    protocol: null,
    cipher: null,
    certificate: null,
    error: null
  };
  let req;
  try {
    req = transport.request(target, {
      method: options.method || "GET",
      timeout: timeoutMs,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      minVersion: options.minVersion,
      maxVersion: options.maxVersion,
      headers: {
        "user-agent": "football-tls-readiness/1",
        ...(options.headers || {})
      }
    }, (res) => {
      result.status = res.statusCode || 0;
      result.headers = res.headers;
      if (target.protocol === "https:") {
        result.authorized = Boolean(res.socket.authorized);
        result.authorizationError = res.socket.authorizationError || null;
        result.protocol = res.socket.getProtocol?.() || null;
        result.cipher = res.socket.getCipher?.() || null;
        const peer = res.socket.getPeerCertificate?.() || {};
        result.certificate = Object.keys(peer).length ? {
          subject: peer.subject || null,
          issuer: peer.issuer || null,
          subjectaltname: peer.subjectaltname || "",
          validFrom: peer.valid_from || null,
          validTo: peer.valid_to || null,
          fingerprint256: peer.fingerprint256 || null
        } : null;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        result.bytes += Buffer.byteLength(chunk);
        if (result.body.length < 64 * 1024) result.body += chunk;
      });
      res.on("end", () => resolve(result));
    });
  } catch (error) {
    result.error = error.message || String(error);
    resolve(result);
    return;
  }
  req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  req.on("error", (error) => {
    result.error = error.message || String(error);
    resolve(result);
  });
  req.end();
});

const probeTlsVersion = (version) => new Promise((resolve) => {
  const port = Number(baseUrl.port || 443);
  const result = { version, accepted: false, negotiated: null, error: null };
  let socket;
  try {
    socket = tls.connect({
      host: baseUrl.hostname,
      port,
      servername: net.isIP(baseUrl.hostname) ? undefined : baseUrl.hostname,
      rejectUnauthorized: false,
      minVersion: version,
      maxVersion: version,
      timeout: timeoutMs
    }, () => {
      result.accepted = true;
      result.negotiated = socket.getProtocol();
      socket.end();
    });
  } catch (error) {
    result.error = error.message || String(error);
    resolve(result);
    return;
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  socket.on("error", (error) => {
    result.error = error.message || String(error);
    finish();
  });
  socket.on("timeout", () => socket.destroy(new Error(`TLS probe timed out after ${timeoutMs}ms`)));
  socket.on("close", finish);
});

const withPath = (origin, pathname) => {
  const target = new URL(origin.href);
  target.pathname = pathname;
  target.search = "";
  target.hash = "";
  return target;
};

const httpOriginFor = (origin) => {
  const target = new URL(origin.href);
  target.protocol = "http:";
  target.port = process.env.TLS_VERIFY_HTTP_PORT || "80";
  return target;
};

const serverHeaderHidesVersion = (headers) => {
  const server = String(headers.server || "");
  return server === "" || !/nginx\/[0-9]/i.test(server);
};

const runBootstrap = async () => {
  addCheck("bootstrap URL uses HTTP", baseUrl.protocol === "http:", { protocol: baseUrl.protocol });
  const root = await request(withPath(baseUrl, "/"));
  const health = await request(withPath(baseUrl, "/api/v1/health"));
  const challenge = await request(withPath(baseUrl, "/.well-known/acme-challenge/football-tls-readiness-probe"));
  addCheck("HTTP bootstrap serves application", root.status === 200, { status: root.status, error: root.error });
  addCheck("HTTP bootstrap serves v1 health", health.status === 200, { status: health.status, error: health.error });
  addCheck("ACME webroot owns challenge path", challenge.status === 404, {
    status: challenge.status,
    location: challenge.headers.location || null,
    error: challenge.error
  }, bootstrapRequireAcme);
  addCheck("Nginx version is hidden", serverHeaderHidesVersion(root.headers), {
    server: root.headers.server || null
  }, bootstrapRequireHardening);
};

const runStrict = async () => {
  addCheck("strict URL uses HTTPS", baseUrl.protocol === "https:", { protocol: baseUrl.protocol });
  if (baseUrl.protocol !== "https:") return;

  const root = await request(withPath(baseUrl, "/"));
  const health = await request(withPath(baseUrl, "/api/v1/health"));
  addCheck("HTTPS trust and identity validation succeeds", !root.error && root.authorized === true, {
    authorized: root.authorized,
    authorizationError: root.authorizationError,
    error: root.error
  });
  addCheck("HTTPS application is reachable", root.status === 200, { status: root.status, error: root.error });
  addCheck("HTTPS v1 health is reachable", health.status === 200, { status: health.status, error: health.error });
  addCheck("negotiated protocol is modern", ["TLSv1.2", "TLSv1.3"].includes(root.protocol), { protocol: root.protocol });
  addCheck("Nginx version is hidden", serverHeaderHidesVersion(root.headers), { server: root.headers.server || null });

  const validToMs = Date.parse(root.certificate?.validTo || "");
  const remainingHours = Number.isFinite(validToMs) ? (validToMs - Date.now()) / 3_600_000 : -1;
  addCheck("certificate has renewal runway", remainingHours >= minRemainingHours, {
    validTo: root.certificate?.validTo || null,
    remainingHours: Number.isFinite(remainingHours) ? Number(remainingHours.toFixed(2)) : null,
    minimumHours: minRemainingHours
  });
  if (expectedIp) {
    const san = String(root.certificate?.subjectaltname || "");
    addCheck("certificate contains expected IP SAN", san.split(/,\s*/).includes(`IP Address:${expectedIp}`), {
      expectedIp,
      subjectaltname: san || null
    });
  }

  const redirectPath = "/api/v1/health?tls-redirect-probe=1";
  const httpOrigin = httpOriginFor(baseUrl);
  const redirectTarget = new URL(redirectPath, httpOrigin);
  const redirect = await request(redirectTarget);
  const expectedLocation = `https://${baseUrl.host}${redirectPath}`;
  if (requireHttpRedirect) {
    addCheck("HTTP redirects to the fixed HTTPS identity", [301, 308].includes(redirect.status)
      && redirect.headers.location === expectedLocation, {
        status: redirect.status,
        location: redirect.headers.location || null,
        expectedLocation,
        error: redirect.error
      });
  } else {
    addCheck("HTTP remains available during provisional TLS", redirect.status === 200 && !redirect.headers.location, {
      status: redirect.status,
      location: redirect.headers.location || null,
      error: redirect.error
    });
  }

  const challenge = await request(new URL("/.well-known/acme-challenge/football-tls-readiness-probe", httpOrigin));
  addCheck("ACME challenge bypasses HTTPS redirect", challenge.status === 404 && !challenge.headers.location, {
    status: challenge.status,
    location: challenge.headers.location || null,
    error: challenge.error
  });

  const probes = {};
  for (const version of ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]) {
    probes[version] = await probeTlsVersion(version);
  }
  addCheck("TLS 1.0 and 1.1 are rejected", !probes.TLSv1.accepted && !probes["TLSv1.1"].accepted, {
    tls10: probes.TLSv1,
    tls11: probes["TLSv1.1"]
  });
  addCheck("TLS 1.2 and 1.3 are accepted", probes["TLSv1.2"].accepted && probes["TLSv1.3"].accepted, {
    tls12: probes["TLSv1.2"],
    tls13: probes["TLSv1.3"]
  });

  if (!net.isIP(baseUrl.hostname)) {
    const hsts = String(root.headers["strict-transport-security"] || "");
    addCheck("DNS HTTPS identity sends HSTS", !requireHsts || /max-age=[1-9][0-9]*/i.test(hsts), {
      required: requireHsts,
      header: hsts || null
    });
  }
};

const run = async () => {
  addCheck("verification mode is supported", ["bootstrap", "strict"].includes(requestedMode), { mode: requestedMode });
  if (requestedMode === "bootstrap") await runBootstrap();
  if (requestedMode === "strict") await runStrict();

  const failed = checks.filter((check) => check.required !== false && !check.ok);
  const advisories = checks.filter((check) => check.required === false && !check.ok);
  const payload = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    mode: requestedMode,
    baseUrl: baseUrl.origin,
    expectedIp: expectedIp || null,
    summary: { checks: checks.length, failed: failed.length, advisories: advisories.length },
    checks
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    mode: requestedMode,
    baseUrl: baseUrl.origin,
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
