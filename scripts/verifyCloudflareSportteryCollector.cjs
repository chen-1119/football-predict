const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  validateCollectorEvidenceUpload,
} = require("../server/collectorQuorumEvidence.cjs");

const rootDir = path.resolve(__dirname, "..");
const collectorUrl = pathToFileURL(path.join(
  rootDir,
  "cloudflare",
  "sync-trigger",
  "src",
  "sportteryCollector.js",
)).href;

const pem = (label, bytes) => {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
};

const jsonResponse = (body, status = 200, headers = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  },
);

const run = async () => {
  globalThis.crypto = crypto.webcrypto;
  const collector = await import(collectorUrl);
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
  const keyId = "cloudflare-collector-verification-fixture";
  const fingerprint = crypto.createHash("sha256").update(publicDer).digest("hex");
  const trustRegistry = {
    version: "sporttery-collector-trust-registry-v1",
    keys: [{
      keyId,
      algorithm: "Ed25519",
      publicKeyPem: pem("PUBLIC KEY", publicDer),
      fingerprint,
      independenceDomain: "cloudflare-worker-verification-runtime",
      enabled: true,
    }],
  };
  const poolRows = [
    {
      poolCode: "HAD",
      "1": 1.82,
      X: 3.45,
      "2": 4.2,
      updateDate: "2026-07-31",
      updateTime: "21:45:00",
    },
    {
      poolCode: "HHAD",
      goalLine: "-1",
      "1": 3.1,
      X: 3.55,
      "2": 1.91,
      updateDate: "2026-07-31",
      updateTime: "21:45:00",
    },
  ];
  const payload = {
    success: true,
    value: {
      matchList: [{ matchId: "verification-match-001", oddsList: poolRows }],
    },
  };
  let uploaded = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("webapi.sporttery.cn")) {
      return jsonResponse(payload, 200, {
        date: new Date().toUTCString(),
        etag: "verification-fixture",
      });
    }
    if (href.endsWith("/api/admin/sporttery-collector-evidence")) {
      uploaded = JSON.parse(String(init.body || "{}"));
      const validation = validateCollectorEvidenceUpload(uploaded, {
        trustRegistry,
        acceptedAt: new Date().toISOString(),
      });
      return jsonResponse({
        ok: validation.ok,
        acceptedRows: validation.acceptedRows,
        storeRows: validation.acceptedRows,
        storeRootHash: "0".repeat(64),
        blockers: validation.blockers,
      }, validation.ok ? 200 : 422);
    }
    throw new Error(`unexpected verification fetch ${href}`);
  };

  try {
    const deployWorkflow = fs.readFileSync(path.join(
      rootDir,
      ".github",
      "workflows",
      "deploy-cloudflare-sync.yml",
    ), "utf8");
    const operationsDoc = fs.readFileSync(path.join(
      rootDir,
      "docs",
      "cloudflare-cron-sync.md",
    ), "utf8");
    const env = {
      SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8: pem("PRIVATE KEY", privateDer),
      SPORTTERY_COLLECTOR_KEY_ID: keyId,
      SPORTTERY_COLLECTOR_KEY_FINGERPRINT: fingerprint,
      FOOTBALL_PRODUCTION_ADMIN_TOKEN: "verification-only-token",
      FOOTBALL_PRODUCTION_BASE_URL: "https://production.test",
    };
    const result = await collector.collectSportteryEvidence(env);
    const validation = validateCollectorEvidenceUpload(uploaded, {
      trustRegistry,
      acceptedAt: new Date().toISOString(),
    });
    const checks = [
      { name: "collector reports configured only with all secrets", ok: collector.sportteryCollectorConfigured(env) },
      { name: "both official market endpoints signed", ok: result?.ok === true && result?.endpoints === 2 },
      { name: "server accepts every signed endpoint", ok: validation.ok && validation.acceptedRows === 2 },
      {
        name: "evidence contains HAD and HHAD extraction hashes",
        ok: validation.rows.every((row) => {
          const pools = new Set(row.marketExtractions.map((item) => item.poolCode));
          return pools.has("HAD") && pools.has("HHAD");
        }),
      },
      {
        name: "accepted evidence is assigned to independent worker runtime",
        ok: validation.rows.every((row) => row.independenceDomain === "cloudflare-worker-verification-runtime"),
      },
      {
        name: "CI deploy uploads the independent collector secret pair only as a pair",
        ok: deployWorkflow.includes("SYNC_WORKER_FOOTBALL_PRODUCTION_ADMIN_TOKEN")
          && deployWorkflow.includes("SYNC_WORKER_SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8")
          && deployWorkflow.includes('echo "collector_ready=true"')
          && deployWorkflow.includes('steps.secrets.outputs.collector_ready }}" = "true"')
          && deployWorkflow.includes("secret put FOOTBALL_PRODUCTION_ADMIN_TOKEN")
          && deployWorkflow.includes("secret put SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8")
          && deployWorkflow.includes("Independent Sporttery collector secret pair is incomplete."),
      },
      {
        name: "operations guide forbids treating deployment as collector quorum proof",
        ok: operationsDoc.includes("trustedCollectorCount=2")
          && operationsDoc.includes("Merely deploying the Worker or storing")
          && operationsDoc.includes("is not redundancy proof"),
      },
    ];
    const ok = checks.every((check) => check.ok);
    console.log(JSON.stringify({
      ok,
      checkedAt: new Date().toISOString(),
      acceptedRows: validation.acceptedRows,
      checks,
    }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: error.stack || error.message || String(error),
  }, null, 2));
  process.exit(1);
});
