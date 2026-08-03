const assert = require("node:assert/strict");
const http = require("node:http");
const {
  buildConfig,
  canonicalRecommendationDecision,
  compareRecommendationParity,
  isAuthoritativeResultOnlyArchive,
  runVerification,
  scheduledWithoutBestIds,
} = require("./verifyRemoteRecommendationParity.cjs");

const prediction = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "X",
  odds: 3.4,
  recommendationAction: "reference",
};
const scheduled = {
  id: "sporttery_2040643",
  sourceMatchId: "2040643",
  status: "SCHEDULED",
  kickoffTime: "2099-08-01T01:00:00+08:00",
  buyEndTime: "2099-08-01T00:55:00+08:00",
  eventVersion: "2099-08-01T01:00:00+08:00",
  predictions: [prediction],
};
const finished = {
  ...scheduled,
  status: "FINISHED",
  predictions: [{ ...prediction, tipCode: "2" }],
  archivedPreMatchPrediction: {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId: "2040643",
    eventVersion: "2099-08-01T01:00:00+08:00",
    capturedAt: "2099-07-31T16:50:00.000Z",
    cutoffTime: "2099-07-31T16:55:00.000Z",
    marketEvidenceScope: "result-pool",
    signature: "archive-signature",
    prediction,
  },
};
const projectedPending = {
  ...scheduled,
  status: "PENDING_RESULT",
  sourceStatus: "SCHEDULED",
  effectiveStatus: "PENDING_RESULT",
};
const committedPendingWithoutArchive = {
  ...scheduled,
  status: "PENDING_RESULT",
  sourceStatus: "PENDING_RESULT",
  effectiveStatus: "PENDING_RESULT",
};
const postKickoffScheduledWithArchive = {
  ...finished,
  status: "SCHEDULED",
  sourceStatus: "SCHEDULED",
  kickoffTime: "2026-07-28T01:00:00+08:00",
  buyEndTime: "2026-07-28T00:55:00+08:00",
  eventVersion: "2026-07-28T01:00:00+08:00",
  predictions: [],
  archivedPreMatchPrediction: {
    ...finished.archivedPreMatchPrediction,
    eventVersion: "2026-07-28T01:00:00+08:00",
    capturedAt: "2026-07-27T16:50:00.000Z",
    cutoffTime: "2026-07-27T16:55:00.000Z",
  },
};
const futureScheduledWithoutBest = {
  ...scheduled,
  id: "sporttery_missing_best",
  sourceMatchId: "missing_best",
  predictions: [],
};
const resultOnlyArchive = {
  id: "sporttery_result_only",
  sourceMatchId: "result_only",
  status: "FINISHED",
  sourceStatus: "FINISHED",
  kickoffTime: "2026-07-28T01:00:00+08:00",
  eventVersion: "2026-07-28T01:00:00+08:00",
  scoreHome: 1,
  scoreAway: 0,
  predictions: [],
  postMatchReview: { finalScore: "1-0" },
};

assert.deepEqual(canonicalRecommendationDecision(scheduled), {
  id: "2040643",
  eventVersion: "2099-07-31T17:00:00.000Z",
  source: "published-best",
  oddsPoolCode: "HAD",
  tipCode: "X",
  handicapLine: "0",
  odds: 3.4,
  capturedAt: null,
  signature: null,
});
assert.equal(canonicalRecommendationDecision(finished).tipCode, "X");
assert.equal(
  canonicalRecommendationDecision(projectedPending, Date.parse("2100-01-01T00:00:00.000Z")),
  null,
);
assert.equal(canonicalRecommendationDecision(committedPendingWithoutArchive), null);
assert.equal(
  canonicalRecommendationDecision(
    postKickoffScheduledWithArchive,
    Date.parse("2026-07-30T00:00:00.000Z"),
  ).source,
  "archive",
);
const invalidPostDeadlineArchive = {
  ...finished,
  archivedPreMatchPrediction: {
    ...finished.archivedPreMatchPrediction,
    capturedAt: "2099-07-31T16:56:00.000Z",
  },
};
assert.equal(
  canonicalRecommendationDecision(invalidPostDeadlineArchive),
  null,
  "an archive captured after its immutable cutoff must fail closed",
);
assert.deepEqual(
  scheduledWithoutBestIds(
    [postKickoffScheduledWithArchive, futureScheduledWithoutBest],
    Date.parse("2026-07-30T00:00:00.000Z"),
  ),
  ["missing_best"],
);
assert.equal(compareRecommendationParity(finished, { ...finished }).ok, true);
assert.equal(isAuthoritativeResultOnlyArchive(resultOnlyArchive), true);
assert.equal(isAuthoritativeResultOnlyArchive({
  ...resultOnlyArchive,
  status: "PENDING_RESULT",
  sourceStatus: "PENDING_RESULT",
}), false, "pending results remain fail-closed without an immutable archive");
assert.equal(isAuthoritativeResultOnlyArchive({
  ...resultOnlyArchive,
  predictions: [{ ...prediction, tipCode: "1" }],
}), false, "a row that exposed any direction still requires its frozen archive");
const modelOnlyScheduled = {
  ...scheduled,
  id: "model-only-1",
  sourceMatchId: "model-only-1",
  predictions: [{
    marketType: "BEST",
    tipCode: "1",
    odds: 0,
    recommendationAction: "reference",
    recommendationTier: "cold-start-reference",
  }],
};
assert.deepEqual(canonicalRecommendationDecision(modelOnlyScheduled), {
  id: "model-only-1",
  eventVersion: "2099-07-31T17:00:00.000Z",
  source: "published-best",
  oddsPoolCode: "MODEL_1X2",
  tipCode: "1",
  handicapLine: "0",
  odds: null,
  capturedAt: null,
  signature: null,
});
const modelOnlyFinished = {
  ...modelOnlyScheduled,
  status: "FINISHED",
  archivedPreMatchPrediction: {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId: "model-only-1",
    eventVersion: "2099-08-01T01:00:00+08:00",
    marketEvidenceScope: "model-only-reference",
    capturedAt: "2099-07-31T16:50:00.000Z",
    cutoffTime: "2099-07-31T16:55:00.000Z",
    signature: "model-only-archive-signature",
    prediction: {
      ...modelOnlyScheduled.predictions[0],
      oddsPoolCode: "HAD",
    },
  },
};
assert.deepEqual(canonicalRecommendationDecision(modelOnlyFinished), {
  id: "model-only-1",
  eventVersion: "2099-07-31T17:00:00.000Z",
  source: "archive",
  oddsPoolCode: "MODEL_1X2",
  tipCode: "1",
  handicapLine: "0",
  odds: null,
  capturedAt: "2099-07-31T16:50:00.000Z",
  signature: "model-only-archive-signature",
});
assert.equal(compareRecommendationParity(
  modelOnlyScheduled,
  {
    ...modelOnlyScheduled,
    predictions: [{ ...modelOnlyScheduled.predictions[0], tipCode: "2" }],
  },
).ok, false);
assert.deepEqual(
  compareRecommendationParity(finished, {
    ...finished,
    archivedPreMatchPrediction: {
      ...finished.archivedPreMatchPrediction,
      prediction: { ...prediction, tipCode: "2" },
    },
  }).reasons,
  ["canonical-decision-mismatch"]
);

const accessToken = "contract-secret-token";
const accessCodeAdminToken = "contract-access-code-admin-token";
const temporaryAccessCode = "TEMP-PARITY-CODE";
const temporaryAccessToken = "temporary-contract-access-token";
let temporaryCodesCreated = 0;
let temporaryCodesVerified = 0;
let temporaryCodesRevoked = 0;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/admin/access-codes" && req.method === "POST") {
    if (req.headers.authorization !== `Bearer ${accessCodeAdminToken}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    temporaryCodesCreated += 1;
    res.end(JSON.stringify({
      ok: true,
      id: "temporary-parity-code-id",
      code: temporaryAccessCode,
    }));
    return;
  }
  if (req.url === "/api/access/verify" && req.method === "POST") {
    temporaryCodesVerified += 1;
    res.end(JSON.stringify({
      ok: true,
      session: { token: temporaryAccessToken },
    }));
    return;
  }
  if (
    req.url === "/api/admin/access-codes/temporary-parity-code-id/revoke"
    && req.method === "POST"
  ) {
    if (req.headers.authorization !== `Bearer ${accessCodeAdminToken}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    temporaryCodesRevoked += 1;
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (
    req.headers.authorization !== `Bearer ${accessToken}`
    && req.headers.authorization !== `Bearer ${temporaryAccessToken}`
  ) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  if (req.url === "/api/v1/matches/current?view=list") {
    res.end(JSON.stringify({ ok: true, rows: [scheduled] }));
    return;
  }
  if (req.url === `/api/v1/matches/${encodeURIComponent(scheduled.id)}`) {
    res.end(JSON.stringify({ ok: true, match: scheduled }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false }));
});

server.listen(0, "127.0.0.1", async () => {
  try {
    const address = server.address();
    const payload = await runVerification(buildConfig({}, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken,
      timeoutMs: 5_000,
    }));
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.rows, 1);
    assert.equal(payload.summary.checked, 1);
    assert.equal(JSON.stringify(payload).includes(accessToken), false);
    assert.equal(payload.accessSession.mode, "provided-token");

    const temporaryPayload = await runVerification(buildConfig({}, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessCodeAdminToken,
      timeoutMs: 5_000,
    }));
    assert.equal(temporaryPayload.ok, true);
    assert.equal(temporaryPayload.summary.rows, 1);
    assert.equal(temporaryPayload.summary.checked, 1);
    assert.equal(temporaryPayload.accessSession.mode, "temporary-admin-code");
    assert.equal(temporaryPayload.accessSession.created, true);
    assert.equal(temporaryPayload.accessSession.verified, true);
    assert.equal(temporaryPayload.accessSession.revoked, true);
    assert.equal(temporaryCodesCreated, 1);
    assert.equal(temporaryCodesVerified, 1);
    assert.equal(temporaryCodesRevoked, 1);
    const serializedTemporaryPayload = JSON.stringify(temporaryPayload);
    assert.equal(serializedTemporaryPayload.includes(accessCodeAdminToken), false);
    assert.equal(serializedTemporaryPayload.includes(temporaryAccessCode), false);
    assert.equal(serializedTemporaryPayload.includes(temporaryAccessToken), false);
    console.log(JSON.stringify({
      ok: true,
      verifier: "remote-recommendation-parity-contract-v1",
      assertions: 30,
      guarantees: [
        "scheduled BEST is canonical",
        "post-kickoff SCHEDULED source lag is checked against the immutable archive rather than mutable BEST",
        "a wall-clock post-kickoff SCHEDULED row fails closed without an immutable archive",
        "committed result phase fails closed without an immutable archive",
        "cold-start model-only BEST and its immutable archive remain explicit without pretending to be official HAD",
        "result phase replays the frozen archive",
        "direction drift is detected",
        "protected list and detail parity is checked without leaking the token",
        "an admin-only temporary QA code is verified and revoked without leaking secrets",
      ],
    }, null, 2));
  } finally {
    server.close();
  }
});
