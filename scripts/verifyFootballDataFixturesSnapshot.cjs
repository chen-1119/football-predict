"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  OFFICIAL_SOURCE_URL,
  collectFootballDataFixtures,
  metadataHashFor,
  readStatus,
  snapshotPaths,
  verifyStoredSnapshot,
} = require("./footballDataFixturesSnapshot.cjs");

const CSV = Buffer.from([
  "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A",
  "B1,31/05/2026,17:30,Gent,Genk,2.90,3.75,2.20",
  'E0,01/06/2026,15:00,"AC, Milan",Inter,2.10,3.20,3.40',
  "",
].join("\r\n"), "utf8");

const NEWER_CSV = Buffer.from([
  "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A",
  "E0,02/06/2026,19:45,Arsenal,Chelsea,1.95,3.50,4.00",
  "D1,03/06/2026,18:30,Bayern,Dortmund,1.70,4.10,4.50",
  "",
].join("\r\n"), "utf8");

const responseHeaders = (body = CSV, overrides = {}) => ({
  date: "Thu, 16 Jul 2026 00:00:01 GMT",
  etag: '"fixture-test-v1"',
  "last-modified": "Wed, 15 Jul 2026 23:00:00 GMT",
  "content-type": "text/csv",
  "content-length": String(body.length),
  ...overrides,
});

const clockFrom = (...values) => {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const expectRejectCode = async (operation, code) => {
  let thrown = null;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code} rejection`);
  assert.equal(thrown.code, code, thrown.stack || thrown.message);
  return thrown;
};

const writeRehashedMetadata = (metadataPath, mutate) => {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  mutate(metadata);
  metadata.metadataSha256 = metadataHashFor(metadata);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
};

const collectFixture = (storeDir, clock, transport, extra = {}) => collectFootballDataFixtures({
  storeDir,
  clock,
  transport,
  maxBodyBytes: 1024 * 1024,
  ...extra,
});

async function verifyStoreIdempotence304AndOfflinePreservation(root) {
  const storeDir = path.join(root, "primary");
  const requests = [];
  const okTransport = async (request) => {
    requests.push(request);
    return { statusCode: 200, headers: responseHeaders(), body: CSV };
  };

  const first = await collectFixture(
    storeDir,
    clockFrom("2026-07-16T00:00:00.000Z", "2026-07-16T00:00:01.000Z"),
    okTransport,
  );
  assert.equal(first.status, "stored");
  assert.equal(first.stored, true);
  assert.equal(first.rowCount, 2);
  assert.equal(first.providerOddsObservedAt, null);
  assert.equal(first.researchEligible, true);
  assert.equal(first.marketShadowEligible, true);
  assert.equal(first.marketPromotionEligible, false);
  assert.equal(first.officialResultEligible, false);
  assert.equal(requests[0].url, OFFICIAL_SOURCE_URL);
  assert.equal(requests[0].headers["If-None-Match"], undefined);
  assert.equal(requests[0].headers["If-Modified-Since"], undefined);

  const initialRaw = fs.readFileSync(first.rawPath);
  const initialMetadata = fs.readFileSync(first.metadataPath);
  const initialRawMtime = fs.statSync(first.rawPath, { bigint: true }).mtimeNs;
  const initialMetadataMtime = fs.statSync(first.metadataPath, { bigint: true }).mtimeNs;
  const verified = verifyStoredSnapshot({ storeDir, rawSha256: first.rawSha256 });
  assert.equal(verified.metadata.providerOddsObservedAt, null);
  assert.equal(verified.metadata.clockPolicy.httpLastModifiedMayBeUsedAsRowObservedAt, false);
  assert.equal(verified.metadata.clockPolicy.sourceReceivedAtMayBeUsedAsProviderObservedAt, false);
  assert.equal(verified.metadata.marketPromotionEligible, false);
  assert.equal(verified.metadata.officialResultEligible, false);

  const second = await collectFixture(
    storeDir,
    clockFrom("2026-07-16T01:00:00.000Z", "2026-07-16T01:00:01.000Z"),
    okTransport,
  );
  assert.equal(second.status, "content-already-stored");
  assert.equal(second.stored, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.rawSha256, first.rawSha256);
  assert.equal(requests[1].headers["If-None-Match"], '"fixture-test-v1"');
  assert.equal(requests[1].headers["If-Modified-Since"], "Wed, 15 Jul 2026 23:00:00 GMT");
  assert.deepEqual(fs.readFileSync(first.rawPath), initialRaw, "same hash must not rewrite raw bytes");
  assert.deepEqual(fs.readFileSync(first.metadataPath), initialMetadata, "same hash must not rewrite metadata");
  assert.equal(fs.statSync(first.rawPath, { bigint: true }).mtimeNs, initialRawMtime);
  assert.equal(fs.statSync(first.metadataPath, { bigint: true }).mtimeNs, initialMetadataMtime);

  const transport304 = async (request) => {
    requests.push(request);
    return {
      statusCode: 304,
      headers: {
        date: "Thu, 16 Jul 2026 02:00:01 GMT",
        etag: '"fixture-test-v1"',
        "last-modified": "Wed, 15 Jul 2026 23:00:00 GMT",
      },
      body: Buffer.alloc(0),
    };
  };
  const third = await collectFixture(
    storeDir,
    clockFrom("2026-07-16T02:00:00.000Z", "2026-07-16T02:00:01.000Z"),
    transport304,
  );
  assert.equal(third.status, "not-modified");
  assert.equal(third.notModified, true);
  assert.equal(third.rawSha256, first.rawSha256);
  assert.equal(requests[2].headers["If-None-Match"], '"fixture-test-v1"');
  assert.deepEqual(fs.readFileSync(first.rawPath), initialRaw);
  assert.deepEqual(fs.readFileSync(first.metadataPath), initialMetadata);
  const statusBeforeFailure = fs.readFileSync(path.join(storeDir, "status.json"));

  const networkError = Object.assign(new Error("simulated network outage"), { code: "SIMULATED_NETWORK" });
  await expectRejectCode(() => collectFixture(
    storeDir,
    clockFrom("2026-07-16T03:00:00.000Z", "2026-07-16T03:00:01.000Z"),
    async () => { throw networkError; },
  ), "SIMULATED_NETWORK");
  assert.deepEqual(
    fs.readFileSync(path.join(storeDir, "status.json")),
    statusBeforeFailure,
    "network failure must preserve the previous status pointer",
  );
  assert.deepEqual(fs.readFileSync(first.rawPath), initialRaw, "network failure must preserve prior raw snapshot");

  const statusRecord = readStatus(storeDir);
  assert.equal(statusRecord.status.lastResult, "not-modified");
  assert.equal(statusRecord.status.latest.rawSha256, first.rawSha256);
  return first;
}

async function verifyTamperDetection(root) {
  const storeDir = path.join(root, "tamper");
  const result = await collectFixture(
    storeDir,
    clockFrom("2026-07-16T04:00:00.000Z", "2026-07-16T04:00:01.000Z"),
    async () => ({ statusCode: 200, headers: responseHeaders(), body: CSV }),
  );
  fs.appendFileSync(result.rawPath, Buffer.from("tamper", "utf8"));
  assert.throws(
    () => verifyStoredSnapshot({ storeDir, rawSha256: result.rawSha256 }),
    (error) => error?.code === "INTEGRITY_ERROR",
  );
}

async function verifyClockAndPromotionBoundaries(root) {
  const clockStore = path.join(root, "clock-policy");
  const clockResult = await collectFixture(
    clockStore,
    clockFrom("2026-07-16T05:00:00.000Z", "2026-07-16T05:00:01.000Z"),
    async () => ({ statusCode: 200, headers: responseHeaders(), body: CSV }),
  );
  writeRehashedMetadata(clockResult.metadataPath, (metadata) => {
    metadata.providerOddsObservedAt = metadata.receivedAt;
  });
  assert.throws(
    () => verifyStoredSnapshot({ storeDir: clockStore, rawSha256: clockResult.rawSha256 }),
    (error) => error?.code === "CLOCK_POLICY",
  );

  const promotionStore = path.join(root, "promotion-policy");
  const promotionResult = await collectFixture(
    promotionStore,
    clockFrom("2026-07-16T06:00:00.000Z", "2026-07-16T06:00:01.000Z"),
    async () => ({ statusCode: 200, headers: responseHeaders(), body: CSV }),
  );
  writeRehashedMetadata(promotionResult.metadataPath, (metadata) => {
    metadata.marketPromotionEligible = true;
  });
  assert.throws(
    () => verifyStoredSnapshot({ storeDir: promotionStore, rawSha256: promotionResult.rawSha256 }),
    (error) => error?.code === "PROMOTION_POLICY",
  );

  const reversedStore = path.join(root, "reversed-clock");
  await expectRejectCode(() => collectFixture(
    reversedStore,
    clockFrom("2026-07-16T07:00:01.000Z", "2026-07-16T07:00:00.000Z"),
    async () => ({ statusCode: 200, headers: responseHeaders(), body: CSV }),
  ), "CLOCK_BOUNDARY");
  assert.equal(fs.existsSync(path.join(reversedStore, "status.json")), false);
}

async function verifyOversizedResponse(root) {
  const storeDir = path.join(root, "oversized");
  const oversized = Buffer.alloc(65, 0x61);
  await expectRejectCode(() => collectFootballDataFixtures({
    storeDir,
    maxBodyBytes: 64,
    clock: clockFrom("2026-07-16T08:00:00.000Z", "2026-07-16T08:00:01.000Z"),
    transport: async () => ({
      statusCode: 200,
      headers: responseHeaders(oversized),
      body: oversized,
    }),
  }), "RESPONSE_TOO_LARGE");
  assert.equal(fs.existsSync(path.join(storeDir, "status.json")), false);
}

async function verify304RequiresBase(root) {
  await expectRejectCode(() => collectFootballDataFixtures({
    storeDir: path.join(root, "orphan-304"),
    clock: clockFrom("2026-07-16T09:00:00.000Z", "2026-07-16T09:00:01.000Z"),
    transport: async () => ({ statusCode: 304, headers: {}, body: Buffer.alloc(0) }),
  }), "HTTP_304_WITHOUT_SNAPSHOT");
}

async function verifyOutOfOrderCompletionCannotRegressStatus(root) {
  const storeDir = path.join(root, "out-of-order");
  const olderResponse = deferred();
  const newerResponse = deferred();

  const olderPromise = collectFixture(
    storeDir,
    clockFrom("2026-07-16T10:00:00.000Z", "2026-07-16T10:00:01.000Z"),
    async () => olderResponse.promise,
  );
  const newerPromise = collectFixture(
    storeDir,
    clockFrom("2026-07-16T10:01:00.000Z", "2026-07-16T10:01:01.000Z"),
    async () => newerResponse.promise,
  );

  newerResponse.resolve({
    statusCode: 200,
    headers: responseHeaders(NEWER_CSV, {
      date: "Thu, 16 Jul 2026 10:01:01 GMT",
      etag: '"fixture-newer"',
      "last-modified": "Thu, 16 Jul 2026 10:00:30 GMT",
    }),
    body: NEWER_CSV,
  });
  const newer = await newerPromise;
  assert.equal(newer.statusPublished, true);

  olderResponse.resolve({
    statusCode: 200,
    headers: responseHeaders(CSV, {
      date: "Thu, 16 Jul 2026 10:00:01 GMT",
      etag: '"fixture-older"',
      "last-modified": "Thu, 16 Jul 2026 09:59:30 GMT",
    }),
    body: CSV,
  });
  const older = await olderPromise;
  assert.equal(older.stored, true, "the older immutable snapshot may still be retained");
  assert.equal(older.statusPublished, false, "an older receivedAt must not replace the newer status pointer");
  assert.equal(older.statusPublicationReason, "current-status-is-newer-or-equal");
  assert.notEqual(older.rawSha256, newer.rawSha256);
  assert.equal(fs.existsSync(older.rawPath), true, "rejected pointer candidate must not delete immutable bytes");
  verifyStoredSnapshot({ storeDir, rawSha256: older.rawSha256 });

  const current = readStatus(storeDir);
  assert.equal(current.status.latest.rawSha256, newer.rawSha256);
  assert.equal(current.status.receivedAt, "2026-07-16T10:01:01.000Z");
  assert.equal(current.status.checkedAt, "2026-07-16T10:01:01.000Z");
  assert.equal(current.status.conditionals.etag, '"fixture-newer"');
  assert.equal(current.status.conditionals.lastModified, "Thu, 16 Jul 2026 10:00:30 GMT");
  assert.equal(fs.existsSync(path.join(storeDir, ".status.lock")), false, "status lock must be released");
}

async function verifyCrashedStatusLockRecovery(root) {
  const storeDir = path.join(root, "stale-lock-recovery");
  fs.mkdirSync(storeDir, { recursive: true });
  const lockPath = path.join(storeDir, ".status.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({ version: 1, pid: 999999, token: "crashed" })}\n`, "utf8");
  const staleInstant = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleInstant, staleInstant);

  const result = await collectFixture(
    storeDir,
    clockFrom("2026-07-16T11:00:00.000Z", "2026-07-16T11:00:01.000Z"),
    async () => ({ statusCode: 200, headers: responseHeaders(), body: CSV }),
    { statusLockTimeoutMs: 1_000, statusLockStaleMs: 100 },
  );
  assert.equal(result.statusPublished, true);
  assert.equal(fs.existsSync(lockPath), false, "stale crash lock must be recovered and released");
  assert.equal(
    fs.readdirSync(storeDir).some((name) => name.startsWith(".status.lock.stale-")),
    false,
    "stale lock quarantine must be cleaned",
  );
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-data-fixtures-verify-"));
  try {
    const primary = await verifyStoreIdempotence304AndOfflinePreservation(root);
    await verifyTamperDetection(root);
    await verifyClockAndPromotionBoundaries(root);
    await verifyOversizedResponse(root);
    await verify304RequiresBase(root);
    await verifyOutOfOrderCompletionCannotRegressStatus(root);
    await verifyCrashedStatusLockRecovery(root);
    const paths = snapshotPaths(path.join(root, "primary"), primary.rawSha256);
    assert.equal(path.basename(paths.snapshotDir), primary.rawSha256, "snapshot directory must be content-addressed");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "football-data-fixtures-snapshot",
      networkCalls: 0,
      checks: [
        "https-official-source-contract",
        "conditional-etag-and-last-modified",
        "http-304-preserves-snapshot",
        "same-hash-strict-idempotence",
        "immutable-raw-and-metadata-tamper-detection",
        "oversized-response-rejection",
        "request-received-clock-boundary",
        "provider-odds-observed-at-remains-null",
        "market-promotion-and-official-result-remain-false",
        "network-failure-preserves-last-status",
        "injectable-zero-network-transport",
        "out-of-order-response-cannot-regress-status-or-validators",
        "stale-crash-lock-recovery-and-atomic-status-publication",
      ],
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
