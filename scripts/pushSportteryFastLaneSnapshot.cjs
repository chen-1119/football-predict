const fs = require("node:fs");
const path = require("node:path");
const {
  postSnapshot,
  rowsInRelayPayload,
} = require("./sportteryFastResultLane.cjs");

const rootDir = path.resolve(__dirname, "..");
const snapshotPath = path.resolve(
  process.argv[2]
  || process.env.SPORTTERY_FAST_RESULT_SNAPSHOT_PATH
  || path.join(rootDir, ".codex-tmp", "sporttery-fast-result-snapshot.json"),
);
const baseUrl = String(
  process.env.SPORTTERY_FAST_RESULT_PUSH_BASE_URL
  || process.env.SPORTTERY_RELAY_PUSH_BASE_URL
  || process.env.FOOTBALL_CLOUD_API_BASE
  || process.env.REMOTE_BASE_URL
  || "",
).trim();
const adminToken = String(
  process.env.SPORTTERY_FAST_RESULT_ADMIN_TOKEN
  || process.env.SPORTTERY_RELAY_ADMIN_TOKEN
  || process.env.FOOTBALL_CLOUD_ADMIN_TOKEN
  || process.env.ACCESS_CODE_ADMIN_TOKEN
  || process.env.ADMIN_TOKEN
  || "",
).trim();
const currentOnly = process.argv.includes("--current-only");

const currentMarketSubset = (snapshot) => {
  const endpoints = (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : [])
    .filter((entry) => (
      ["current", "calculator"].includes(String(entry?.method || entry?.id || ""))
      && entry?.ok !== false
      && rowsInRelayPayload(entry?.payload) > 0
    ));
  const cycles = [...new Set(endpoints.map((entry) => String(
    entry?.sourceCycleId || entry?.collectorProvenance?.sourceCycleId || "",
  )).filter(Boolean))];
  if (endpoints.length === 0) throw new Error("fast-lane-current-market-endpoint-missing");
  if (cycles.length !== 1 || endpoints.some((entry) => !(
    entry?.sourceCycleId || entry?.collectorProvenance?.sourceCycleId
  ))) {
    throw new Error("fast-lane-current-market-cycle-not-atomic");
  }
  const rows = endpoints.reduce((sum, entry) => (
    sum + rowsInRelayPayload(entry.payload)
  ), 0);
  return {
    ...snapshot,
    producer: {
      ...(snapshot?.producer || {}),
      uploadMode: "current",
      atomicSubset: endpoints.length !== (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints.length : 0),
    },
    summary: {
      ...(snapshot?.summary || {}),
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows,
      errors: 0,
      methods: [...new Set(endpoints.map((entry) => String(entry?.method || entry?.id || "")))],
      uploadMode: "current",
    },
    endpoints,
    errors: [],
  };
};

const main = async () => {
  if (!fs.existsSync(snapshotPath)) throw new Error("fast-lane-snapshot-missing");
  if (!baseUrl) throw new Error("fast-lane-push-base-url-missing");
  if (!adminToken) throw new Error("fast-lane-push-admin-token-missing");
  const sourceSnapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const snapshot = currentOnly ? currentMarketSubset(sourceSnapshot) : sourceSnapshot;
  const result = await postSnapshot({
    baseUrl,
    adminToken,
    snapshot,
    timeoutMs: Math.max(
      5_000,
      Number(process.env.SPORTTERY_FAST_RESULT_UPLOAD_TIMEOUT_SECONDS || 30) * 1000,
    ),
  });
  console.log(JSON.stringify({
    ok: true,
    snapshotPath,
    sourceCycleId: snapshot?.sourceCycleId || null,
    capturedAt: snapshot?.capturedAt || null,
    currentOnly,
    ...result,
  }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    status: Number(error?.status || 0) || null,
    validation: error?.response?.validation || null,
    code: error?.response?.code || null,
  }, null, 2));
  process.exitCode = 1;
});
