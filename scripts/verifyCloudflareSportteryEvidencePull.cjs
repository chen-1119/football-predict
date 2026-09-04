const assert = require("node:assert/strict");
const {
  run,
  validateEvidenceEnvelope,
  validateLocalUrl,
  validatePullUrl,
} = require("./syncCloudflareSportteryEvidence.cjs");

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const evidence = {
  version: "sporttery-collector-evidence-upload-v1",
  capturedAt: "2026-08-21T12:00:00.000Z",
  sourceCycleId: "cloudflare-sporttery:verification",
  endpoints: [{
    ok: true,
    id: "current",
    rows: 2,
    collectorAttestation: {
      algorithm: "Ed25519",
      signature: "A".repeat(88),
    },
  }],
};

const runVerification = async () => {
  assert.equal(validatePullUrl("https://worker.example/api/sporttery-evidence").protocol, "https:");
  assert.throws(() => validatePullUrl("http://worker.example/api/sporttery-evidence"), /HTTPS/);
  assert.throws(() => validatePullUrl("https://worker.example/wrong"), /must target/);
  assert.equal(validateLocalUrl().hostname, "127.0.0.1");
  assert.throws(() => validateLocalUrl("http://example.com/api/admin/sporttery-collector-evidence"), /loopback/);
  assert.equal(validateEvidenceEnvelope({ ok: true, evidence }), evidence);
  assert.throws(() => validateEvidenceEnvelope({ ok: true, evidence: { ...evidence, endpoints: [] } }), /count/);

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalEnv = {
    url: process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL,
    pullToken: process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN,
    adminToken: process.env.ADMIN_TOKEN,
  };
  const requests = [];
  try {
    process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL = "https://worker.example/api/sporttery-evidence";
    process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN = "verification-pull-token";
    process.env.ADMIN_TOKEN = "verification-admin-token";
    console.log = () => {};
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).startsWith("https://worker.example/")) {
        return response({ ok: true, evidence, summary: { endpoints: 1, rows: 2, errors: [] } });
      }
      return response({
        ok: true,
        acceptedRows: 1,
        storeRows: 1,
        storeRootHash: "0".repeat(64),
      });
    };
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalEnv.url === undefined) delete process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL;
    else process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL = originalEnv.url;
    if (originalEnv.pullToken === undefined) delete process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN;
    else process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN = originalEnv.pullToken;
    if (originalEnv.adminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalEnv.adminToken;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.authorization, "Bearer verification-pull-token");
  assert.equal(requests[1].url, "http://127.0.0.1:8788/api/admin/sporttery-collector-evidence");
  assert.equal(requests[1].init.headers.authorization, "Bearer verification-admin-token");
  assert.deepEqual(JSON.parse(requests[1].init.body), evidence);
  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: 11,
  }, null, 2));
};

runVerification().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
