const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { validateCollectorEvidenceUpload } = require("../server/collectorQuorumEvidence.cjs");
const { auditTrustedFastResultEndpoints } = require("../server/relayCollectorEvidence.cjs");
const { snapshotCycleDetails } = require("./sportteryRelayCircuit.cjs");
const {
  auditRelayFastResultEligibility,
  validateRelayFastResultStructure,
} = require("../server/relayFastResultWatcher.cjs");
const { sportteryPoolOdds } = require("./syncData.cjs");

const rootDir = path.resolve(__dirname, "..");
const pem = (label, bytes) => {
  const body = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

const pair = crypto.generateKeyPairSync("ed25519");
const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
const fingerprint = crypto.createHash("sha256").update(publicDer).digest("hex");
const keyId = "huawei-functiongraph-verification-fixture";
const values = {
  SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8_BASE64: Buffer.from(pem("PRIVATE KEY", privateDer)).toString("base64"),
  SPORTTERY_COLLECTOR_KEY_ID: keyId,
  SPORTTERY_COLLECTOR_KEY_FINGERPRINT: fingerprint,
  SPORTTERY_COLLECTOR_TRANSPORT: "huawei-functiongraph-direct",
  SPORTTERY_COLLECTOR_CYCLE_PREFIX: "huawei-functiongraph-verification",
  FOOTBALL_PRODUCTION_BASE_URL: "https://production.test",
  FOOTBALL_PRODUCTION_ADMIN_TOKEN: "verification-upload-token",
};
const context = {
  getUserData: (name) => values[name] || "",
  getMemorySize: () => 256,
  getRunningTimeInSeconds: () => 60,
};
const trustRegistry = {
  version: "sporttery-collector-trust-registry-v1",
  keys: [{
    keyId,
    algorithm: "Ed25519",
    publicKeyPem: pem("PUBLIC KEY", publicDer),
    fingerprint,
    independenceDomain: "huaweicloud-functiongraph-verification",
    enabled: true,
  }],
};

const marketPayload = {
  success: true,
  value: {
    lastUpdateTime: "2026-09-03 01:00:00",
    matchInfoList: [{
      businessDate: "2026-09-03",
      subMatchList: [{
        matchId: "huawei-verification-match",
        oddsList: [
          { poolCode: "HAD", "1": 1.9, X: 3.2, "2": 3.8, updateDate: "2026-09-03", updateTime: "01:00:00" },
          { poolCode: "HHAD", goalLine: "-1", "1": 3.1, X: 3.45, "2": 1.95, updateDate: "2026-09-03", updateTime: "01:00:00" },
        ],
      }],
    }],
  },
};

const resultPayload = {
  success: true,
  value: {
    lastUpdateTime: "2026-09-03 03:05:00",
    matchResult: [{
      matchId: "huawei-verification-match",
      matchDate: "2026-09-03",
      allHomeTeam: "主队全称",
      homeTeam: "主队",
      allAwayTeam: "客队全称",
      awayTeam: "客队",
      leagueName: "验证联赛",
      leagueNameAbbr: "验证",
      sectionsNo999: "2:1",
      matchResultStatus: "1",
      poolStatus: "2",
      h: "1.90",
      d: "3.20",
      a: "3.80",
      oddsList: [
        { poolCode: "HAD", h: "9.01", d: "9.02", a: "9.03" },
        { poolCode: "HHAD", goalLine: "-1", h: "8.01", d: "8.02", a: "8.03" },
      ],
      had: { h: "7.01", d: "7.02", a: "7.03" },
      hhad: { goalLine: "-1", h: "6.01", d: "6.02", a: "6.03" },
    }],
  },
};

const run = async () => {
  const { validateCostPolicy } = require("./huaweiFunctionGraphCostPolicy.cjs");
  const config = require("../deploy/huawei-functiongraph/function-config.json");
  const costPlan = validateCostPolicy(config);
  assert.equal(costPlan.worstCaseExecutionGbSeconds, 135420);
  for (const change of [
    { memoryMb: 512 }, { timeoutSeconds: 300 },
    { timer: { enabled: true, rule: "@every 1m" } },
    { async: { maxRetries: 3, maxEventAgeSeconds: 60 } },
    { reservedInstances: 1 }, { maxInstances: 10 },
  ]) assert.throws(() => validateCostPolicy({ ...config, ...change }), /cost policy/);
  globalThis.crypto = crypto.webcrypto;
  process.env.SPORTTERY_COLLECTOR_MODULE_PATH = path.join(
    rootDir,
    "cloudflare",
    "sync-trigger",
    "src",
    "sportteryCollector.js",
  );
  const originalFetch = globalThis.fetch;
  let uploadedMarket = null;
  let uploadedFastLane = null;
  let failResultFetch = false;
  let hangResultBody = false;
  let resultBodyAbortObserved = false;
  let forceStoredButWatcherIneligible = false;
  let marketUploadCount = 0;
  let fastLaneUploadCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("https://webapi.sporttery.cn/")) {
      if (failResultFetch && href.includes("getUniformMatchResultV1.qry")) {
        throw new Error("verification-result-upstream-unavailable");
      }
      if (hangResultBody && href.includes("getUniformMatchResultV1.qry")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          arrayBuffer: () => new Promise((resolve, reject) => {
            const abort = () => {
              resultBodyAbortObserved = true;
              const error = new Error("verification-result-body-aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (init.signal?.aborted) abort();
            else init.signal?.addEventListener("abort", abort, { once: true });
          }),
        };
      }
      const payload = href.includes("getUniformMatchResultV1.qry") ? resultPayload : marketPayload;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", date: new Date().toUTCString() },
      });
    }
    if (href === "https://production.test/api/admin/sporttery-collector-evidence") {
      assert.equal(init.headers.authorization, "Bearer verification-upload-token");
      marketUploadCount += 1;
      uploadedMarket = JSON.parse(init.body);
      const validation = validateCollectorEvidenceUpload(uploadedMarket, {
        trustRegistry,
        acceptedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({
        ok: validation.ok,
        acceptedRows: validation.acceptedRows,
        storeRows: validation.acceptedRows,
        storeRootHash: "verification-root-hash",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "https://production.test/api/admin/sporttery-relay-fast-lane?runSync=0") {
      assert.equal(init.headers.authorization, "Bearer verification-upload-token");
      fastLaneUploadCount += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.runSync, false);
      uploadedFastLane = body.snapshot;
      const audit = auditTrustedFastResultEndpoints(uploadedFastLane, {
        trustRegistry,
        requireMarketLane: true,
      });
      const structure = validateRelayFastResultStructure(uploadedFastLane);
      const watcherEligibility = auditRelayFastResultEligibility(uploadedFastLane, { trustRegistry });
      const rows = uploadedFastLane.endpoints.reduce((sum, endpoint) => (
        sum + (endpoint?.payload?.value?.matchInfoList || [])
          .reduce((daySum, day) => daySum + (day?.subMatchList?.length || 0), 0)
      ), 0);
      const watcherEligible = audit.eligible
        && structure.eligible
        && watcherEligibility.eligible
        && !forceStoredButWatcherIneligible;
      return new Response(JSON.stringify({
        ok: true,
        stored: true,
        watcherEligible,
        publicationEligibility: {
          version: "relay-fast-result-publication-eligibility-v1",
          validator: "auditRelayFastResultEligibility",
          eligible: watcherEligible,
          blocker: watcherEligible ? null : "verification-watcher-ineligible",
        },
        storedValidation: {
          ok: true,
          rows,
          usableEndpoints: uploadedFastLane.endpoints.length,
          provenanceMode: "upload-merge",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  try {
    const handler = require("../deploy/huawei-functiongraph/index.cjs").handler;
    // Bad console allocations must fail before either data collection or upload.
    let preflightFetches = 0;
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { preflightFetches += 1; return fixtureFetch(...args); };
    for (const invalidContext of [
      { ...context, getMemorySize: () => 512 },
      { ...context, getRunningTimeInSeconds: () => 300 },
      { ...context, getMemorySize: () => NaN },
      { getUserData: context.getUserData },
    ]) {
      await assert.rejects(handler({ trigger_type: "TIMER" }, invalidContext), /cost limits/);
    }
    assert.equal(preflightFetches, 0);
    globalThis.fetch = fixtureFetch;
    const result = await handler({ trigger_type: "TIMER" }, context);
    assert.equal(result.ok, true);
    assert.equal(result.runtime, "huawei-functiongraph");
    assert.equal(result.triggerType, "TIMER");
    assert.equal(result.endpoints, 2);
    assert.equal(result.acceptedRows, 2);
    assert.equal(result.fastLane.published, true);
    assert.equal(result.fastLane.stored, true);
    assert.equal(result.fastLane.watcherEligible, true);
    assert.equal(result.fastLane.endpoints, 3);
    assert.equal(result.fastLane.resultRows, 1);
    assert.equal(uploadedMarket.endpoints.length, 2);
    assert(uploadedMarket.endpoints.every((endpoint) => ["current", "calculator"].includes(endpoint.id)));
    assert(!uploadedMarket.endpoints.some((endpoint) => endpoint.id === "result"));
    const validation = validateCollectorEvidenceUpload(uploadedMarket, {
      trustRegistry,
      acceptedAt: new Date().toISOString(),
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.acceptedRows, 2);
    assert(validation.rows.every((row) => row.independenceDomain === "huaweicloud-functiongraph-verification"));
    assert(uploadedMarket.endpoints.every((row) => row.transport === "huawei-functiongraph-direct"));
    assert(uploadedMarket.endpoints.every((row) => (
      row.collectorProvenance?.transport === "huawei-functiongraph-direct"
    )));

    assert.equal(uploadedFastLane.endpoints.length, 3);
    const fastAudit = auditTrustedFastResultEndpoints(uploadedFastLane, {
      trustRegistry,
      requireMarketLane: true,
    });
    assert.equal(fastAudit.eligible, true);
    assert.equal(fastAudit.resultEndpoint.page, 1);
    assert.equal(fastAudit.resultEndpoint.url,
      "https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry?matchPage=0");
    assert.equal(uploadedFastLane.sourceCycleKind, "upload-merge");
    assert.equal(uploadedFastLane.collectorProvenance.cycleKind, "upload-merge");
    assert.equal(snapshotCycleDetails(uploadedFastLane).atomic, false);
    assert.match(uploadedFastLane.producer.resultFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(validateRelayFastResultStructure(uploadedFastLane).eligible, true);
    assert.equal(auditRelayFastResultEligibility(uploadedFastLane, { trustRegistry }).eligible, true);
    assert(uploadedFastLane.endpoints.every((endpoint) => (
      endpoint.sourceCycleId !== uploadedFastLane.sourceCycleId
      && endpoint.fastResultConstituent?.sourceCycleIds?.includes(endpoint.sourceCycleId)
      && endpoint.fastResultConstituent?.provenancePreserved === true
    )));
    assert.deepEqual(uploadedFastLane.constituentCycleIds, [uploadedFastLane.endpoints[0].sourceCycleId]);
    const normalizedResult = fastAudit.resultEndpoint.payload.value.matchInfoList[0].subMatchList[0];
    assert.equal(Object.hasOwn(fastAudit.resultEndpoint.payload.value, "matchResult"), false);
    assert.equal(normalizedResult.matchStatus, "11");
    assert.equal(normalizedResult.officialResultIdentity.scheduleTimeAuthority, "omitted-by-official-result-feed");
    assert.deepEqual(normalizedResult.officialPayoutSp, { h: "1.90", d: "3.20", a: "3.80" });
    assert.equal(Object.hasOwn(normalizedResult, "h"), false);
    assert.equal(Object.hasOwn(normalizedResult, "d"), false);
    assert.equal(Object.hasOwn(normalizedResult, "a"), false);
    assert.equal(Object.hasOwn(normalizedResult, "oddsList"), false);
    assert.equal(Object.hasOwn(normalizedResult, "had"), false);
    assert.equal(Object.hasOwn(normalizedResult, "hhad"), false);
    assert.equal(sportteryPoolOdds(normalizedResult, "HAD", "verification", "relay", {}), null);
    assert.equal(sportteryPoolOdds(normalizedResult, "HHAD", "verification", "relay", {}), null);
    assert.equal(uploadedFastLane.producer.resultAuthority, "official-settlement-only");
    assert.equal(uploadedFastLane.producer.preMatchOddsMutation, "disabled");

    const marketUploadsBeforeWatcherRejection = marketUploadCount;
    const fastUploadsBeforeWatcherRejection = fastLaneUploadCount;
    forceStoredButWatcherIneligible = true;
    await assert.rejects(
      handler({ trigger_type: "TIMER" }, context),
      /stored without watcher publication eligibility/,
    );
    assert.equal(marketUploadCount, marketUploadsBeforeWatcherRejection + 1);
    assert.equal(fastLaneUploadCount, fastUploadsBeforeWatcherRejection + 1);
    forceStoredButWatcherIneligible = false;

    const marketUploadsBeforeResultFailure = marketUploadCount;
    const fastUploadsBeforeResultFailure = fastLaneUploadCount;
    failResultFetch = true;
    await assert.rejects(
      handler({ trigger_type: "TIMER" }, context),
      /official result endpoint unavailable; fast-lane upload withheld/,
    );
    assert.equal(marketUploadCount, marketUploadsBeforeResultFailure + 1);
    assert.equal(fastLaneUploadCount, fastUploadsBeforeResultFailure);
    assert.equal(uploadedMarket.endpoints.length, 2);
    assert(!uploadedMarket.endpoints.some((endpoint) => endpoint.id === "result"));
    failResultFetch = false;

    const marketUploadsBeforeBodyTimeout = marketUploadCount;
    const fastUploadsBeforeBodyTimeout = fastLaneUploadCount;
    values.SPORTTERY_COLLECTOR_REQUEST_TIMEOUT_MS = "25";
    hangResultBody = true;
    resultBodyAbortObserved = false;
    const bodyTimeoutStartedAt = Date.now();
    await assert.rejects(
      handler({ trigger_type: "TIMER" }, context),
      /official result endpoint unavailable; fast-lane upload withheld/,
    );
    const bodyTimeoutElapsedMs = Date.now() - bodyTimeoutStartedAt;
    assert.equal(resultBodyAbortObserved, true);
    assert(bodyTimeoutElapsedMs >= 10 && bodyTimeoutElapsedMs < 500);
    assert.equal(marketUploadCount, marketUploadsBeforeBodyTimeout + 1);
    assert.equal(fastLaneUploadCount, fastUploadsBeforeBodyTimeout);
    hangResultBody = false;
    delete values.SPORTTERY_COLLECTOR_REQUEST_TIMEOUT_MS;

    const invalidContext = { ...context, getUserData: (name) => name === "FOOTBALL_PRODUCTION_BASE_URL" ? "http://production.test" : values[name] || "" };
    await assert.rejects(handler({ trigger_type: "TIMER" }, invalidContext), /credential-free HTTPS origin/);

    console.log(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      assertions: 71,
      costPlan,
      acceptedRows: validation.acceptedRows,
      fastLaneEndpoints: uploadedFastLane.endpoints.length,
      resultRows: result.fastLane.resultRows,
      responseBodyTimeoutAbortObserved: resultBodyAbortObserved,
      responseBodyTimeoutElapsedMs: bodyTimeoutElapsedMs,
      independenceDomain: validation.rows[0].independenceDomain,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
};

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
