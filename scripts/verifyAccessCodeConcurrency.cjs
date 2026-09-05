const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const runningServers = [];

const assert = (condition, message, details = {}) => {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close((error) => (error ? reject(error) : resolve(port)));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = async (baseUrl, method, pathname, body, headers = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body === undefined || body === null ? {} : { "content-type": "application/json" }),
        ...headers
      },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { status: response.status, body: payload, text };
  } finally {
    clearTimeout(timeout);
  }
};

const waitForServer = async (server) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(`access-code test server exited early (${server.child.exitCode}): ${server.logs.slice(-2000)}`);
    }
    try {
      const health = await requestJson(server.baseUrl, "GET", "/api/v1/health");
      if (health.status === 200) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await sleep(100);
  }
  throw new Error(`access-code test server did not become ready: ${server.logs.slice(-2000)}`);
};

const startServer = async ({ failWriteAfter = null } = {}) => {
  const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "football-access-code-"));
  const port = await freePort();
  const adminToken = `access-admin-${crypto.randomBytes(18).toString("hex")}`;
  const child = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      // This server owns only its temporary fixture, never the host's DB.
      FOOTBALL_POSTGRES_MODE: "disabled",
      FOOTBALL_POSTGRES_URL: "",
      DATABASE_URL: "",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_STORE_DIR: storeDir,
      DATA_STORE_DIR: storeDir,
      DATASTORE_SQLITE_PATH: path.join(storeDir, "football.db"),
      DATASTORE_READ_SOURCE: "file",
      ENABLE_SQLITE_EXPORT: "0",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      ADMIN_TOKEN: `admin-${crypto.randomBytes(18).toString("hex")}`,
      ACCESS_CODE_ADMIN_TOKEN: adminToken,
      ACCESS_CODE_SECRET: `access-secret-${crypto.randomBytes(32).toString("hex")}`,
      ACCESS_SESSION_SECRET: `session-secret-${crypto.randomBytes(32).toString("hex")}`,
      ACCESS_CODE_TTL_SECONDS: "3600",
      ...(failWriteAfter === null ? {} : { ACCESS_CODE_TEST_FAIL_WRITE_AFTER: String(failWriteAfter) })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const server = {
    child,
    storeDir,
    adminToken,
    baseUrl: `http://127.0.0.1:${port}`,
    logs: ""
  };
  const collect = (chunk) => {
    server.logs = `${server.logs}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  runningServers.push(server);
  await waitForServer(server);
  return server;
};

const stopServer = async (server) => {
  if (!server) return;
  if (server.child.exitCode === null) {
    server.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.child.once("exit", resolve)),
      sleep(3000).then(() => {
        if (server.child.exitCode === null) server.child.kill("SIGKILL");
      })
    ]);
  }
  await fsp.rm(server.storeDir, { recursive: true, force: true });
};

const adminHeaders = (server) => ({ authorization: `Bearer ${server.adminToken}` });

const createCode = async (server, label, options = {}) => {
  const response = await requestJson(
    server.baseUrl,
    "POST",
    "/api/admin/access-codes",
    { ...options, label },
    adminHeaders(server),
  );
  assert(response.status === 200 && response.body?.code && response.body?.id, "failed to create test access code", response);
  return response.body;
};

const readStore = (server) => {
  const filePath = path.join(server.storeDir, "access-codes.json");
  const text = fs.readFileSync(filePath, "utf8");
  return { filePath, text, value: JSON.parse(text) };
};

const checkRevocationRace = async () => {
  const server = await startServer();
  const created = await createCode(server, "concurrent-revoke-regression");
  const seedVerify = await requestJson(server.baseUrl, "POST", "/api/access/verify", { code: created.code });
  assert(seedVerify.status === 200 && seedVerify.body?.session?.token,
    "test access code was not active before the revoke race", seedVerify);
  let monitorRunning = true;
  let parseSamples = 0;
  const parseFailures = [];
  const parseMonitor = (async () => {
    while (monitorRunning) {
      try {
        JSON.parse(await fsp.readFile(path.join(server.storeDir, "access-codes.json"), "utf8"));
        parseSamples += 1;
      } catch (error) {
        parseFailures.push({ code: error?.code || null, message: error?.message || String(error) });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  let verifyResults;
  let revoke;
  try {
    const verifyRequests = Array.from({ length: 180 }, () => (
      requestJson(server.baseUrl, "POST", "/api/access/verify", { code: created.code })
    ));
    // Let multiple verification handlers enter the read/modify/write path before
    // the revoke. The old implementation then allowed stale writers to erase it.
    await sleep(20);
    const revokeRequest = requestJson(
      server.baseUrl,
      "POST",
      `/api/admin/access-codes/${encodeURIComponent(created.id)}/revoke`,
      null,
      adminHeaders(server)
    );
    [verifyResults, revoke] = await Promise.all([Promise.all(verifyRequests), revokeRequest]);
  } finally {
    monitorRunning = false;
    await parseMonitor;
  }
  assert(parseSamples > 0 && parseFailures.length === 0,
    "access-code store was unreadable or invalid JSON during atomic replacements", {
      parseSamples,
      parseFailures: parseFailures.slice(0, 5)
    });
  assert(revoke.status === 200 && revoke.body?.row?.status === "revoked", "concurrent revoke did not commit", revoke);

  const postRevoke = await Promise.all(Array.from({ length: 30 }, () => (
    requestJson(server.baseUrl, "POST", "/api/access/verify", { code: created.code })
  )));
  assert(postRevoke.every((response) => response.status === 401 && !response.body?.session?.token),
    "a verification succeeded after revoke returned", {
      statuses: postRevoke.map((response) => response.status)
    });

  const listed = await requestJson(server.baseUrl, "GET", "/api/admin/access-codes", null, adminHeaders(server));
  const row = listed.body?.rows?.find((candidate) => candidate.id === created.id);
  assert(listed.status === 200 && row?.status === "revoked" && row?.revokedAt,
    "admin list did not retain revoked state", listed);
  const persisted = readStore(server);
  const persistedRow = persisted.value?.codes?.find((candidate) => candidate.id === created.id);
  assert(persistedRow?.revokedAt, "persisted store lost revokedAt after concurrent verification", {
    filePath: persisted.filePath,
    row: persistedRow || null
  });

  return {
    verifyRequests: verifyResults.length,
    verifySucceededBeforeLinearizedRevoke: 1 + verifyResults.filter((response) => response.status === 200).length,
    postRevokeDenied: postRevoke.length,
    finalStatus: row.status,
    jsonBytes: Buffer.byteLength(persisted.text),
    concurrentJsonParseSamples: parseSamples
  };
};

const checkWriteFailureFailsClosed = async () => {
  const server = await startServer({ failWriteAfter: 1 });
  const created = await createCode(server, "write-failure-regression");
  const verify = await requestJson(server.baseUrl, "POST", "/api/access/verify", { code: created.code });
  assert(verify.status === 500 && !verify.body?.session?.token,
    "access-code write failure did not fail closed", verify);
  const persisted = readStore(server);
  const row = persisted.value?.codes?.find((candidate) => candidate.id === created.id);
  assert(row && !row.usedAt && !row.lastUsedAt && !row.usedCount,
    "failed verification mutated the durable access-code record", row || {});
  return {
    verifyStatus: verify.status,
    sessionIssued: Boolean(verify.body?.session?.token),
    durableUsedCount: Number(row?.usedCount || 0),
    jsonParseable: true
  };
};

const checkPerCodeTtlIsShorteningOnly = async () => {
  const server = await startServer();
  const defaultCode = await createCode(server, "default-ttl");
  const minimumCode = await createCode(server, "minimum-ttl", { ttlSeconds: 30 });
  const qaCode = await createCode(server, "qa-ttl", { ttlSeconds: 300 });
  const cappedCode = await createCode(server, "capped-ttl", { ttlSeconds: 7_200 });
  assert(defaultCode.ttlSeconds === 3_600,
    "an omitted per-code TTL changed the configured default", defaultCode);
  assert(minimumCode.ttlSeconds === 60,
    "a per-code TTL below the safe minimum was not clamped", minimumCode);
  assert(qaCode.ttlSeconds === 300,
    "a short QA TTL was not preserved", qaCode);
  assert(cappedCode.ttlSeconds === 3_600,
    "a per-code TTL extended the configured service policy", cappedCode);
  const qaLifetimeSeconds = Math.round(
    (Date.parse(qaCode.expiresAt) - Date.parse(qaCode.createdAt)) / 1_000,
  );
  assert(qaLifetimeSeconds === 300,
    "the persisted QA expiration clock does not match its TTL", qaCode);
  return {
    configuredDefaultSeconds: defaultCode.ttlSeconds,
    minimumSeconds: minimumCode.ttlSeconds,
    qaSeconds: qaCode.ttlSeconds,
    cappedSeconds: cappedCode.ttlSeconds,
    qaLifetimeSeconds,
  };
};

const run = async () => {
  try {
    const revocationRace = await checkRevocationRace();
    const writeFailure = await checkWriteFailureFailsClosed();
    const perCodeTtl = await checkPerCodeTtlIsShorteningOnly();
    console.log(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      summary: { revocationRace, writeFailure, perCodeTtl }
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message || String(error),
      details: error.details || null
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await Promise.all(runningServers.map((server) => stopServer(server).catch(() => {})));
  }
};

run();
