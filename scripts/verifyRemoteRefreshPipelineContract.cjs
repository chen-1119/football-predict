const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  adminDiagnosticsReady,
  buildConfig,
  runVerification,
  serializeRedactedPayload
} = require("./verifyRemoteRefreshPipeline.cjs");

const accessToken = "contract-access-token-must-never-be-printed";
const adminToken = "contract-admin-token-must-never-be-printed";
const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
const isoBefore = (milliseconds) => new Date(nowMs - milliseconds).toISOString();
const state = {
  staleCurrent: false,
  inconsistentDetail: false,
  inconsistentReview: false,
  missingNewestReviews: false,
  reflectCredential: false
};

const trustedResultProvenance = {
  provider: "sporttery",
  official: true,
  trusted: true
};

const reviewFor = (row) => ({
  version: "post-match-review-v1",
  generatedAt: isoBefore(20_000),
  matchId: row.id,
  sourceMatchId: row.sourceMatchId,
  finalScore: `${row.scoreHome}-${row.scoreAway}`,
  predictionReview: {
    settled: 1,
    won: 1,
    lost: null,
    void: null,
    hitRate: 100,
    mainSettled: 1,
    mainWon: 1,
    mainLost: null,
    mainVoid: null,
    allSettled: 1,
    allWon: 1,
    allLost: null,
    allVoid: null,
    referenceSettled: 0,
    referenceWon: 0,
    referenceLost: null,
    referenceVoid: null,
    bestStatus: "WON",
    formalBestStatus: "WON",
    referenceBestStatus: null,
    archivedBestStatus: null,
    bestRole: "main",
    oneXTwoStatus: "WON",
    handicapHit: false,
    missedHandicapLane: false,
    rows: [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      handicapLine: null,
      tipCode: "1",
      tipLabel: { zh: "主胜", en: "Home win" },
      odds: 1.9,
      actualCode: "1",
      actualLabel: { zh: "主胜", en: "Home win" },
      resultStatus: "WON",
      trustScore: 80,
      recommendationAction: "best",
      recommendationTier: "formal",
      reviewRole: "main"
    }]
  }
});

const baseHistoryRows = [
  { id: "sporttery_3003", sourceMatchId: "3003", status: "FINISHED", kickoffTime: isoBefore(3_600_000), scoreHome: 2, scoreAway: 1 },
  { id: "sporttery_3002", sourceMatchId: "3002", status: "FINISHED", kickoffTime: isoBefore(7_200_000), scoreHome: 0, scoreAway: 0 },
  { id: "sporttery_3001", sourceMatchId: "3001", status: "FINISHED", kickoffTime: isoBefore(10_800_000), scoreHome: 1, scoreAway: 3 }
].map((row) => ({ ...row, resultProvenance: trustedResultProvenance, postMatchReview: reviewFor(row) }));

const historyRows = () => {
  if (!state.missingNewestReviews) return baseHistoryRows;
  return [
    {
      id: "sporttery_3005",
      sourceMatchId: "3005",
      status: "FINISHED",
      kickoffTime: isoBefore(60_000),
      scoreHome: 1,
      scoreAway: 0,
      resultProvenance: trustedResultProvenance
    },
    {
      id: "sporttery_3004",
      sourceMatchId: "3004",
      status: "FINISHED",
      kickoffTime: isoBefore(120_000),
      scoreHome: 2,
      scoreAway: 2,
      resultProvenance: trustedResultProvenance
    },
    ...baseHistoryRows
  ];
};

const syncMeta = () => ({
  ok: true,
  updatedAt: isoBefore(20_000),
  currentListPolicy: {
    version: "kickoff-retention-v1",
    evaluatedAt: isoBefore(30_000),
    unsettledRetentionHours: 48,
    archivedUnsettled: state.staleCurrent ? 0 : 19,
    behavior: "old-unsettled-exits-current-without-fabricated-settlement"
  },
  sourceHealth: {
    resultStale: false,
    resultFreshnessTime: isoBefore(15_000),
    historyFreshnessTime: isoBefore(20_000)
  },
  api: {
    resultStale: false,
    historyStale: false,
    resultFreshnessTime: isoBefore(15_000),
    historyFreshnessTime: isoBefore(20_000)
  }
});

const currentRows = () => [
  {
    id: "sporttery_4001",
    sourceMatchId: "4001",
    status: "SCHEDULED",
    kickoffTime: isoBefore(-3_600_000)
  },
  {
    id: "sporttery_4002",
    sourceMatchId: "4002",
    status: "PENDING_RESULT",
    kickoffTime: isoBefore(state.staleCurrent ? 50 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000)
  },
  ...(state.reflectCredential ? [{
    id: accessToken,
    sourceMatchId: accessToken,
    status: "PENDING_RESULT",
    kickoffTime: isoBefore(50 * 60 * 60 * 1000)
  }, {
    id: adminToken,
    sourceMatchId: adminToken,
    status: "PENDING_RESULT",
    kickoffTime: isoBefore(50 * 60 * 60 * 1000)
  }] : [])
];

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const bearer = (req) => {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/v1/health") {
    return sendJson(res, 200, {
      ok: true,
      apiVersion: "v1",
      checkedAt: isoBefore(1_000),
      data: { currentRead: { source: "sqlite", count: currentRows().length } },
      storage: { sqlite: { available: true } }
    });
  }
  if (url.pathname === "/api/v1/sync-meta") return sendJson(res, 200, syncMeta());
  if (url.pathname === "/api/v1/source-health" && url.searchParams.get("detail") === "admin") {
    if (bearer(req) !== adminToken) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    return sendJson(res, 200, {
      ok: true,
      admin: {
        refreshPipeline: {
          cycle: {
            phase: "official-result-published",
            ok: true,
            startedAt: isoBefore(25_000),
            finishedAt: isoBefore(10_000),
            durationMs: 15_000
          },
          wake: { reason: "relay-snapshot-updated", waitedMs: 1_500 },
          relayWake: { enabled: true, eligible: true, pollSeconds: 2 }
        }
      }
    });
  }
  if (url.pathname === "/api/v1/matches/current") {
    if (bearer(req) !== accessToken) return sendJson(res, 401, { ok: false, error: "access code required" });
    return sendJson(res, 200, {
      ok: true,
      sourceUpdatedAt: isoBefore(15_000),
      stale: false,
      currentRead: { source: "sqlite", count: currentRows().length },
      rows: currentRows()
    });
  }
  if (url.pathname === "/api/v1/matches/history") {
    if (bearer(req) !== accessToken) return sendJson(res, 401, { ok: false, error: "access code required" });
    return sendJson(res, 200, {
      ok: true,
      source: "sqlite",
      sourceUpdatedAt: isoBefore(20_000),
      stale: false,
      rows: historyRows()
    });
  }
  const detailMatch = url.pathname.match(/^\/api\/v1\/matches\/([^/]+)$/);
  if (detailMatch) {
    if (bearer(req) !== accessToken) return sendJson(res, 401, { ok: false, error: "access code required" });
    const id = decodeURIComponent(detailMatch[1]);
    const row = historyRows().find((candidate) => candidate.id === id || candidate.sourceMatchId === id);
    if (!row) return sendJson(res, 404, { ok: false, error: "match not found" });
    let match = state.inconsistentDetail && row.id === "sporttery_3003"
      ? { ...row, scoreHome: 9, postMatchReview: { ...row.postMatchReview, finalScore: "9-1" } }
      : row;
    if (state.inconsistentReview && row.id === "sporttery_3003") {
      match = {
        ...row,
        postMatchReview: {
          ...row.postMatchReview,
          predictionReview: {
            ...row.postMatchReview.predictionReview,
            won: 0,
            lost: 1,
            void: 1,
            mainLost: 1,
            mainVoid: 1,
            allLost: 1,
            allVoid: 1,
            referenceLost: 1,
            referenceVoid: 1,
            hitRate: 0,
            rows: row.postMatchReview.predictionReview.rows.map((reviewRow) => ({
              ...reviewRow,
              resultStatus: "LOST"
            }))
          }
        }
      };
    }
    return sendJson(res, 200, { ok: true, apiVersion: "v1", sourceUpdatedAt: isoBefore(20_000), stale: false, match });
  }
  return sendJson(res, 404, { ok: false, error: "not found" });
});

const listen = () => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});

const close = () => new Promise((resolve) => server.close(resolve));

const assertNoSecretLeak = (payload) => {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(accessToken), false, "access token must not appear in verifier output");
  assert.equal(serialized.includes(adminToken), false, "admin token must not appear in verifier output");
  assert.equal(serialized.toLowerCase().includes("authorization: bearer"), false, "authorization headers must not appear in verifier output");
};

const byName = (payload, name) => payload.checks.find((check) => check.name === name);

const main = async () => {
  const address = await listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const common = {
    baseUrl,
    allowHttp: true,
    nowMs,
    requestTimeoutMs: 2_000,
    adminAttempts: 1,
    adminRetryDelayMs: 1,
    detailSampleSize: 3,
    retentionGraceSeconds: 0
  };
  const checks = [];

  try {
    const happy = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken,
      requireObservedRelayWake: true
    }));
    assert.equal(happy.ok, true, JSON.stringify(happy.checks.filter((check) => !check.ok), null, 2));
    assert.equal(happy.summary.observedRelayWake, true);
    assert.equal(byName(happy, "history and match detail agree")?.ok, true);
    assertNoSecretLeak(happy);
    checks.push("healthy SQLite/retention/freshness/review/relay chain passes without leaking credentials");

    const withoutAdmin = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken: ""
    }));
    assert.equal(withoutAdmin.ok, true);
    assert.equal(byName(withoutAdmin, "admin refresh diagnostics prove official publish and relay wake configuration")?.skipped, true);
    assertNoSecretLeak(withoutAdmin);
    checks.push("missing optional admin token is explicit and does not block protected data verification");

    const withoutRequiredAdmin = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken: "",
      requireAdmin: true
    }));
    const requiredAdminCheck = byName(
      withoutRequiredAdmin,
      "admin refresh diagnostics prove official publish and relay wake configuration"
    );
    assert.equal(withoutRequiredAdmin.ok, false);
    assert.equal(requiredAdminCheck?.skipped, true);
    assert.equal(requiredAdminCheck?.required, true);
    assertNoSecretLeak(withoutRequiredAdmin);
    checks.push("strict release mode fails when the required admin token is missing");

    const withoutAccess = await runVerification(buildConfig({}, {
      ...common,
      accessToken: "",
      adminToken: ""
    }));
    assert.equal(withoutAccess.ok, false);
    assert.equal(byName(withoutAccess, "protected read token is supplied by environment")?.ok, false);
    assert.equal(byName(withoutAccess, "history and match detail agree")?.skipped, true);
    assertNoSecretLeak(withoutAccess);
    checks.push("missing protected token fails clearly while protected probes are safely skipped");

    state.missingNewestReviews = true;
    const missingNewestReviews = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken: ""
    }));
    const missingNewestCheck = byName(
      missingNewestReviews,
      "history payload is fresh and contains review samples"
    );
    assert.equal(missingNewestReviews.ok, false);
    assert.equal(missingNewestCheck?.latestTrustedFinishedSamples, 3);
    assert.equal(missingNewestCheck?.availableReviewSamples, 1);
    assert.deepEqual(missingNewestCheck?.missingReviewIds, ["3005", "3004"]);
    assertNoSecretLeak(missingNewestReviews);
    state.missingNewestReviews = false;
    checks.push("newest trusted finished rows cannot be replaced by older rows when reviews are missing");

    state.inconsistentReview = true;
    const reviewOnlyDrift = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken: ""
    }));
    const reviewOnlyDriftCheck = byName(reviewOnlyDrift, "history and match detail agree");
    assert.equal(reviewOnlyDrift.ok, false);
    assert.equal(reviewOnlyDriftCheck?.ok, false);
    assert.equal(
      reviewOnlyDriftCheck?.samples?.find((sample) => sample.id === "3003")?.reviewLockedFieldsAgree,
      false
    );
    assertNoSecretLeak(reviewOnlyDrift);
    state.inconsistentReview = false;
    checks.push("review-only locked-field and row drift fails history/detail consistency");

    state.staleCurrent = true;
    state.inconsistentDetail = true;
    const inconsistent = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken: ""
    }));
    assert.equal(inconsistent.ok, false);
    assert.equal(byName(inconsistent, "current list has no expired unresolved matches")?.ok, false);
    assert.equal(byName(inconsistent, "history and match detail agree")?.ok, false);
    assertNoSecretLeak(inconsistent);
    checks.push("expired unresolved rows and history/detail drift fail the gate");

    state.staleCurrent = false;
    state.inconsistentDetail = false;
    const policyEvaluatedAt = isoBefore(30_000);
    const cycleBeforePolicy = adminDiagnosticsReady({
      status: 200,
      body: {
        admin: {
          refreshPipeline: {
            cycle: {
              phase: "official-result-published",
              ok: true,
              startedAt: isoBefore(60_000),
              finishedAt: new Date(Date.parse(policyEvaluatedAt) - 1).toISOString(),
              durationMs: 30_000
            },
            wake: null,
            relayWake: { enabled: true, eligible: true, pollSeconds: 2 }
          }
        }
      }
    }, { evaluatedAt: policyEvaluatedAt }, buildConfig({}, {
      ...common,
      futureClockSkewSeconds: 120
    }));
    assert.equal(cycleBeforePolicy.cycleMatchesPolicy, false);
    assert.equal(cycleBeforePolicy.officialReady, false);
    checks.push("same-origin worker cycle must finish at or after policy evaluation without clock-skew slack");

    state.reflectCredential = true;
    const reflectedCredentials = await runVerification(buildConfig({}, {
      ...common,
      accessToken,
      adminToken
    }));
    const rawReflectedPayload = JSON.stringify(reflectedCredentials);
    assert.equal(rawReflectedPayload.includes(accessToken), true);
    assert.equal(rawReflectedPayload.includes(adminToken), true);
    const redactedReflectedPayload = serializeRedactedPayload(reflectedCredentials, [accessToken, adminToken]);
    assert.equal(redactedReflectedPayload.includes(accessToken), false);
    assert.equal(redactedReflectedPayload.includes(adminToken), false);
    assert.equal(redactedReflectedPayload.includes("[redacted]"), true);
    state.reflectCredential = false;
    checks.push("final serialization redacts access and admin tokens reflected by a remote response");

    const insecure = await runVerification(buildConfig({}, {
      ...common,
      allowHttp: false,
      accessToken,
      adminToken: ""
    }));
    assert.equal(insecure.ok, false);
    assert.equal(byName(insecure, "remote refresh verification uses HTTPS")?.ok, false);
    assertNoSecretLeak(insecure);
    checks.push("plain HTTP fails unless the local-contract override is explicit");

    const serverSource = fs.readFileSync(path.join(__dirname, "..", "server", "index.cjs"), "utf8");
    const compactStart = serverSource.indexOf("const compactSyncWorkerRefreshDiagnostics");
    const compactEnd = serverSource.indexOf("const publicPathForData", compactStart);
    const compactBlock = serverSource.slice(compactStart, compactEnd);
    assert.ok(compactStart >= 0 && compactEnd > compactStart, "admin refresh diagnostic compactor must exist");
    assert.ok(compactBlock.includes("return { cycle, wake, relayWake }"));
    for (const forbiddenKey of ["command:", "args:", "env:", "path:", "token:"]) {
      assert.equal(compactBlock.toLowerCase().includes(forbiddenKey), false, `${forbiddenKey} must not be exposed by refresh diagnostics`);
    }
    assert.equal((serverSource.match(/refreshPipeline: compactSyncWorkerRefreshDiagnostics\(syncWorkerStatus\)/g) || []).length, 1);
    checks.push("admin-only refresh diagnostics use a fixed whitelist and are wired once");

    console.log(JSON.stringify({
      ok: true,
      verifier: "remote-refresh-pipeline-contract",
      summary: { checks: checks.length },
      checks
    }, null, 2));
  } finally {
    await close();
  }
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    verifier: "remote-refresh-pipeline-contract",
    error: String(error.message || error)
      .split(accessToken).join("[redacted]")
      .split(adminToken).join("[redacted]")
  }, null, 2));
  process.exitCode = 1;
});
