"use strict";
// Anonymous GET observations. Uses curl's normal certificate verification;
// does not create QA accounts, follow redirects, query DBs or invoke deployment.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function read(base, pathname) {
  const raw = execFileSync(process.platform === "win32" ? "curl.exe" : "curl", ["--silent", "--show-error", "--max-time", "20",
    "--max-filesize", "8388608", "--request", "GET", "--header", "Cache-Control: no-cache", "--write-out", "\n%{http_code}",
    new URL(pathname, base).href], { maxBuffer: 9 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const split = raw.lastIndexOf(10), body = raw.subarray(0, split);
  let json; try { json = JSON.parse(body); } catch { /* index and assets need not be JSON */ }
  return { status: Number(raw.subarray(split + 1).toString()), bytes: body.length, sha256: hash(body), json, body };
}
const summary = result => ({ status: result.status, bytes: result.bytes, sha256: result.sha256 });
function protectedResponseDenied(pathname, result) {
  const body = result.json;
  const denialBody = body && typeof body === "object" && !Array.isArray(body) && body.ok === false
    && Object.keys(body).every(key => ["ok", "error", "message", "code", "use"].includes(key))
    && Object.entries(body).every(([key, value]) => key === "ok" || typeof value === "string");
  if ([401, 403].includes(result.status)) return Boolean(denialBody);
  // The server explicitly retires this large static payload before auth routing.
  return Boolean(denialBody) && pathname === "/data/matches-current.json" && result.status === 410
    && result.json?.ok === false && result.json?.error === "large static payload disabled"
    && result.json?.use === "/api/v1/matches/current?view=list";
}
function observe(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("HTTPS origin without credentials required");
  }
  const startedAt = new Date().toISOString();
  const before = read(base, "/api/v1/health");
  const index = read(base, "/");
  const assets = [...new Set([...index.body.toString("utf8").matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]))];
  const assetChecks = assets.map(pathname => ({ pathname, ...summary(read(base, pathname)) }));
  const deniedPaths = ["/api/v1/matches/current?view=list", "/api/v1/matches/sporttery_2041790",
    "/api/v1/model/evaluation?detail=admin", "/api/v1/daily-featured-combos", "/data/matches-current.json"];
  const protectedChecks = deniedPaths.map(pathname => {
    const result = read(base, pathname);
    // No business response bodies are included in the report, including leaks.
    return { pathname, ...summary(result), denied: protectedResponseDenied(pathname, result),
      businessPayloadObserved: Array.isArray(result.json?.rows) || Boolean(result.json?.match) || Array.isArray(result.json) };
  });
  const after = read(base, "/api/v1/health");
  const state = after.json?.frontendRelease;
  const publicChecks = {
    healthReadable: before.status === 200 && after.status === 200,
    frontendIdentityStable: Boolean(state) && isDeepStrictEqual(before.json?.frontendRelease, state),
    frontendAccepted: state?.phase === "accepted" && state?.available === true && state?.consistent === true,
    exactIndexMatchesHealth: index.status === 200 && index.sha256 === state?.indexSha256,
    referencedAssetsReadable: assetChecks.length > 0 && assetChecks.every(asset => asset.status === 200),
    anonymousProtectedEndpointsDenied: protectedChecks.every(check => check.denied && !check.businessPayloadObserved),
    publicationStable: Boolean(after.json?.storage?.postgres?.publication)
      && isDeepStrictEqual(before.json?.storage?.postgres?.publication, after.json?.storage?.postgres?.publication),
  };
  return { version: "release-quality-public-observation-v1", startedAt, completedAt: new Date().toISOString(), baseUrl: base.origin,
    publicObservationOk: Object.values(publicChecks).every(Boolean), checks: publicChecks, frontendRelease: state,
    readiness: Object.fromEntries(["serviceOk", "dataFresh", "sourceHealthOk", "recommendationReliable"].map(key => [key, after.json?.status?.[key] ?? null])),
    publication: after.json?.storage?.postgres?.publication ?? null, index: summary(index), assetChecks, protectedChecks,
    notVerified: ["signed acceptance receipt and signed asset hash binding", "server/worker PID and process start continuity",
      "authenticated live list/detail parity", "official current source readiness", "full release preflight gates"],
    productionWrites: 0, deploymentAuthorized: false };
}
module.exports = { observe, protectedResponseDenied };
if (require.main === module) {
  try {
    const result = observe(process.argv[2]); console.log(JSON.stringify(result, null, 2));
    if (!result.publicObservationOk) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ publicObservationOk: false, blocker: "public-observation-failed", productionWrites: 0, deploymentAuthorized: false })); process.exitCode = 1; }
}
