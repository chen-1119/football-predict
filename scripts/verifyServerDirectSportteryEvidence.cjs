const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createCollectorKeyPair } = require("../src/services/collectorAttestation.cjs");
const { summarizeRecentCollectorEvidenceStore, validateCollectorEvidenceUpload } = require("../server/collectorQuorumEvidence.cjs");
const { auditRelayFastResultEligibility } = require("../server/relayFastResultWatcher.cjs");
const { SPORTTERY_CURRENT_URL, SPORTTERY_RESULT_URL } = require("./sportteryEndpointContract.cjs");
const {
  buildFastLaneSnapshot,
  collectServerDirectEvidence,
  publishServerDirectCollection,
  validateFastLaneUploadUrl,
} = require("./syncServerDirectSportteryEvidence.cjs");

const now = "2026-08-21T15:00:00.000Z";
const pair = createCollectorKeyPair({
  keyId: "server-direct-verifier",
  independenceDomain: "server-direct-verifier-runtime",
});
const row = (method, receivedAt = now) => ({
  evidenceId: `${method}-${receivedAt}`,
  acceptedAt: receivedAt,
  receivedAt,
  method,
  keyId: pair.keyId,
  independenceDomain: "untrusted-claim-is-ignored",
});
const summary = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current"), row("calculator")] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(summary.trustedCollectorCount, 1);
assert.deepEqual(summary.independenceDomains, ["server-direct-verifier-runtime"]);
assert.deepEqual(summary.domains[0].methods, ["calculator", "current"]);

const incomplete = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current")] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(incomplete.trustedCollectorCount, 0, "both official market endpoints are required");

const stale = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [
    row("current", "2026-08-21T14:30:00.000Z"),
    row("calculator", "2026-08-21T14:30:00.000Z"),
  ] },
  trustRegistry: pair.registry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(stale.trustedCollectorCount, 0, "stale collector evidence is not counted");

const disabledRegistry = {
  ...pair.registry,
  keys: pair.registry.keys.map((key) => ({ ...key, enabled: false })),
};
const disabled = summarizeRecentCollectorEvidenceStore({
  evidenceStore: { rows: [row("current"), row("calculator")] },
  trustRegistry: disabledRegistry,
  now,
  maxAgeMinutes: 20,
});
assert.equal(disabled.trustedCollectorCount, 0, "disabled trust keys are not counted");

const rootDir = path.resolve(__dirname, "..");
const syncSource = fs.readFileSync(path.join(__dirname, "syncServerDirectSportteryEvidence.cjs"), "utf8");
const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
assert.ok(
  syncSource.indexOf("process.env.ADMIN_TOKEN") < syncSource.indexOf("process.env.FOOTBALL_CLOUD_ADMIN_TOKEN"),
  "the local admin endpoint token must take precedence over unrelated cloud tokens",
);
assert.ok(serverSource.includes("collectorEvidenceStoreSummary.independenceDomains"));

const fastLane = buildFastLaneSnapshot({
  sourceCycleId: "new-server-sporttery:test-cycle",
  endpoints: [
    {
      id: "current",
      method: "current",
      ok: true,
      rows: 32,
      requestedAt: "2026-08-21T14:59:58.000Z",
      receivedAt: "2026-08-21T14:59:59.000Z",
      payload: { value: [] },
    },
    {
      id: "calculator",
      method: "calculator",
      ok: true,
      rows: 32,
      requestedAt: "2026-08-21T14:59:59.000Z",
      receivedAt: now,
      payload: { value: [] },
    },
  ],
  errors: [],
}, { keyId: pair.keyId, maxAgeMinutes: 20 });
assert.equal(fastLane.source, "sporttery-relay-snapshot");
assert.equal(fastLane.summary.rows, 64);
assert.deepEqual(fastLane.summary.methods, ["calculator", "current"]);
assert.equal(fastLane.capturedAt, "2026-08-21T14:59:58.000Z");
assert.equal(fastLane.completedAt, now);
assert.equal(
  validateFastLaneUploadUrl().href,
  "http://127.0.0.1:8788/api/admin/sporttery-relay-fast-lane?runSync=0",
);
assert.throws(
  () => validateFastLaneUploadUrl("http://127.0.0.1/api/admin/sporttery-relay-fast-lane?runSync=1"),
  /invalid/,
);
assert.throws(
  () => buildFastLaneSnapshot({ ...fastLane, endpoints: fastLane.endpoints.slice(0, 1) }, { keyId: pair.keyId }),
  /complete current and calculator/,
);

const verifyCollection = async () => {
  const { createSportteryEvidence } = await import(pathToFileURL(path.join(
    rootDir, "cloudflare", "sync-trigger", "src", "sportteryCollector.js",
  )).href);
  const collectorEnv = {
    SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8: pair.privateKeyPem,
    SPORTTERY_COLLECTOR_KEY_ID: pair.keyId,
    SPORTTERY_COLLECTOR_KEY_FINGERPRINT: pair.fingerprint,
    SPORTTERY_COLLECTOR_TRANSPORT: "new-server-direct",
  };
  const marketPayload = {
    success: true,
    value: { matchInfoList: [{ subMatchList: [{
      matchId: "direct-market-fixture",
      oddsList: [{ poolCode: "HAD", h: 2.1, d: 3.2, a: 3.3 }],
    }] }] },
  };
  const resultPayload = {
    success: true,
    value: {
      lastUpdateTime: "2026-09-06 15:00:00",
      matchResult: [{
        matchId: "direct-result-fixture", matchDate: "2026-09-06", matchNum: 101,
        allHomeTeam: "主队", allAwayTeam: "客队", leagueName: "测试联赛",
        sectionsNo999: "2:2", matchResultStatus: "2", poolStatus: "Payout",
        h: "1.9", d: "3.6", a: "4.1",
      }],
    },
  };
  const originalFetch = globalThis.fetch;
  let failMarket = false;
  let failResult = false;
  let resultRequests = 0;
  const extraChecks = [];
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith("https://webapi.sporttery.cn/"), "fixture must never call a real host");
    if (failMarket && String(url) === SPORTTERY_CURRENT_URL) throw new Error("simulated current endpoint failure");
    return new Response(JSON.stringify(marketPayload), {
      status: 200, headers: { "content-type": "application/json", date: new Date().toUTCString() },
    });
  };
  const collectOptions = {
    collectorEnv, keyId: pair.keyId, privateKeyPem: pair.privateKeyPem,
    maxAgeMinutes: 20, createMarketEvidence: createSportteryEvidence,
    resultRequest: async (url) => {
      assert.equal(url, SPORTTERY_RESULT_URL);
      resultRequests += 1;
      if (failResult) throw Object.assign(new Error("simulated result timeout"), { code: "ETIMEDOUT" });
      return {
        payload: resultPayload, rawBody: Buffer.from(JSON.stringify(resultPayload)),
        statusCode: 200, headers: { "content-type": "application/json", date: new Date().toUTCString() },
      };
    },
  };
  try {
    const collected = await collectServerDirectEvidence(collectOptions);
    assert.equal(resultRequests, 1);
    assert.equal(collected.resultProbe.collected, true);
    assert.deepEqual(collected.fastLaneSnapshot.summary.methods, ["calculator", "current", "result"]);
    const audit = auditRelayFastResultEligibility(collected.fastLaneSnapshot, { trustRegistry: pair.registry });
    assert.equal(audit.eligible, true, JSON.stringify(audit.endpointTrust?.blockers || audit.blocker));
    const resultEndpoint = collected.fastLaneSnapshot.endpoints.find((endpoint) => endpoint.method === "result");
    assert.equal(resultEndpoint.page, 1);
    assert.equal(resultEndpoint.sourceRequest.role, "result");
    assert.equal(resultEndpoint.fastResultConstituent.role, "probe");
    assert.equal(audit.endpointTrust.resultProbeRevision.receivedAt, resultEndpoint.receivedAt);
    assert.equal(audit.endpointTrust.resultProbeRevision.collectorCycleId, resultEndpoint.sourceCycleId);
    extraChecks.push("one official result GET produces a correctly signed result:1 probe with preserved clocks");
    const resultRow = resultEndpoint.payload.value.matchInfoList[0].subMatchList[0];
    assert.equal(resultRow.matchStatus, "11");
    assert.equal(resultRow.sectionsNo999, "2:2");
    assert.equal(resultRow.homeTeamAllName, "主队");
    assert.equal(resultRow.officialResultIdentity.scheduleTimeAuthority, "omitted-by-official-result-feed");
    assert.equal(resultRow.officialPayoutSp.d, "3.6");
    assert.equal(Object.hasOwn(resultRow, "d"), false);
    assert.equal(Object.hasOwn(resultRow, "had"), false);
    extraChecks.push("official payout normalization cannot create pre-match odds or kickoff authority");
    const marketValidation = validateCollectorEvidenceUpload(collected.marketEvidence, {
      trustRegistry: pair.registry, acceptedAt: new Date().toISOString(),
    });
    assert.equal(marketValidation.ok, true, JSON.stringify(marketValidation.errors));
    assert.deepEqual(collected.marketEvidence.endpoints.map((endpoint) => endpoint.id).sort(), ["calculator", "current"]);
    extraChecks.push("collector evidence quorum receives only current and calculator despite result collection");
    for (const mutate of [
      (endpoint) => { endpoint.payload.value.matchInfoList[0].subMatchList[0].sectionsNo999 = "3:2"; },
      (endpoint) => { endpoint.sourceRequest.role = "current"; },
      (endpoint) => { endpoint.receivedAt = new Date(Date.parse(endpoint.receivedAt) - 1000).toISOString(); },
      (endpoint) => { endpoint.page = 2; },
    ]) {
      const bad = JSON.parse(JSON.stringify(collected.fastLaneSnapshot));
      mutate(bad.endpoints.find((endpoint) => endpoint.method === "result"));
      assert.equal(auditRelayFastResultEligibility(bad, { trustRegistry: pair.registry }).eligible, false);
    }
    extraChecks.push("result score, role, signed clock and page tampering are rejected");
    const uploads = [];
    const upload = async (url, init) => {
      const body = JSON.parse(init.body);
      uploads.push({ url: String(url), body });
      return body.snapshot ? {
        ok: true, stored: true, watcherEligible: true, publicationEligibility: { eligible: true },
        storedValidation: { ok: true, rows: body.snapshot.summary.rows, capturedAt: body.snapshot.capturedAt },
        mergedWithPreviousResult: !body.snapshot.summary.methods.includes("result"),
      } : { ok: true, acceptedRows: 2, storeRows: 2 };
    };
    const published = await publishServerDirectCollection({ collection: collected, adminToken: "fixture-only", upload, logger: null });
    assert.equal(published.degraded, false);
    assert.equal(published.resultProbe.refreshed, true);
    assert.equal(published.resultProbe.scorePublicationConfirmed, false);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].body.endpoints.some((endpoint) => endpoint.method === "result"), false);
    extraChecks.push("trusted result storage is reported separately from actual score publication");
    await assert.rejects(() => publishServerDirectCollection({
      collection: collected, adminToken: "fixture-only", logger: null,
      upload: async () => ({ ok: true, storedValidation: { ok: true }, watcherEligible: false }),
    }), /trusted watcher eligibility/);
    extraChecks.push("stored-but-untrusted fast result response cannot count as successful refresh");
    failResult = true;
    const degraded = await collectServerDirectEvidence(collectOptions);
    assert.equal(degraded.resultProbe.collected, false);
    assert.equal(degraded.resultProbe.receivedAt, null);
    assert.equal(degraded.resultProbe.errorCode, "ETIMEDOUT");
    assert.deepEqual(degraded.fastLaneSnapshot.summary.methods, ["calculator", "current"]);
    const degradedSummary = await publishServerDirectCollection({ collection: degraded, adminToken: "fixture-only", upload, logger: null });
    assert.equal(degradedSummary.ok, true);
    assert.equal(degradedSummary.degraded, true);
    assert.equal(degradedSummary.resultProbe.refreshed, false);
    assert.equal(degradedSummary.resultProbe.previousResultPreserved, true);
    assert.equal(degradedSummary.resultProbe.receivedAt, null);
    assert.equal(uploads.at(-2).body.snapshot.endpoints.some((endpoint) => endpoint.method === "result"), false);
    extraChecks.push("failed result request preserves successful market collection without fabricating or clearing a result");
    const emptyResult = await collectServerDirectEvidence({
      ...collectOptions,
      resultRequest: async () => ({ payload: { value: { matchResult: [] } }, statusCode: 200, rawBody: Buffer.from("{}"), headers: {} }),
    });
    assert.equal(emptyResult.resultProbe.collected, false);
    assert.equal(emptyResult.resultProbe.reason, "official-result-empty");
    assert.deepEqual(emptyResult.fastLaneSnapshot.summary.methods, ["calculator", "current"]);
    extraChecks.push("empty official result response cannot replace the preserved result lane or claim freshness");
    failResult = false;
    failMarket = true;
    const uploadsBefore = uploads.length;
    await assert.rejects(() => collectServerDirectEvidence(collectOptions), /complete current and calculator/);
    assert.equal(uploads.length, uploadsBefore);
    extraChecks.push("market endpoint failure remains fail-closed even when result collection is attempted");
    return extraChecks;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

verifyCollection().then((extraChecks) => console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: 14 + extraChecks.length,
  trustedCollectorCount: summary.trustedCollectorCount,
  independenceDomains: summary.independenceDomains,
  resultCollectionChecks: extraChecks,
}, null, 2))).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
