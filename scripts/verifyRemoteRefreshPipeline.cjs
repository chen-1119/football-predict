const http = require("node:http");
const https = require("node:https");
const {
  DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS,
  isMatchEligibleForCurrent,
  matchIdentity
} = require("./currentMatchRetention.cjs");

const finiteNumber = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback) => {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const cliRequireAdmin = process.argv.includes("--require-admin");

const buildConfig = (env = process.env, overrides = {}) => {
  const baseUrl = new URL(
    overrides.baseUrl
      || env.REMOTE_REFRESH_BASE_URL
      || env.REMOTE_BASE_URL
      || env.PUBLIC_BASE_URL
      || env.VERIFY_BASE_URL
      || "https://127.0.0.1:8788"
  );
  return {
    baseUrl,
    accessToken: overrides.accessToken ?? env.REMOTE_REFRESH_ACCESS_TOKEN ?? env.VERIFY_ACCESS_TOKEN ?? "",
    adminToken: overrides.adminToken ?? env.REMOTE_REFRESH_ADMIN_TOKEN ?? env.ADMIN_TOKEN ?? "",
    requireAdmin: overrides.requireAdmin ?? (env.REMOTE_REFRESH_REQUIRE_ADMIN === "1" || cliRequireAdmin),
    allowHttp: overrides.allowHttp ?? env.REMOTE_REFRESH_ALLOW_HTTP === "1",
    auditOnly: overrides.auditOnly ?? env.REMOTE_REFRESH_AUDIT_ONLY === "1",
    requestTimeoutMs: positiveInteger(overrides.requestTimeoutMs ?? env.REMOTE_REFRESH_REQUEST_TIMEOUT_MS, 20_000),
    responseMaxBytes: positiveInteger(overrides.responseMaxBytes ?? env.REMOTE_REFRESH_RESPONSE_MAX_BYTES, 16 * 1024 * 1024),
    historyLimit: Math.min(200, positiveInteger(overrides.historyLimit ?? env.REMOTE_REFRESH_HISTORY_LIMIT, 200)),
    detailSampleSize: Math.min(10, positiveInteger(overrides.detailSampleSize ?? env.REMOTE_REFRESH_DETAIL_SAMPLE_SIZE, 3)),
    retentionGraceSeconds: Math.max(0, finiteNumber(overrides.retentionGraceSeconds ?? env.REMOTE_REFRESH_RETENTION_GRACE_SECONDS, 300)),
    resultMaxAgeSeconds: positiveInteger(overrides.resultMaxAgeSeconds ?? env.REMOTE_REFRESH_RESULT_MAX_AGE_SECONDS, 30 * 60),
    historyMaxAgeSeconds: positiveInteger(overrides.historyMaxAgeSeconds ?? env.REMOTE_REFRESH_HISTORY_MAX_AGE_SECONDS, 4 * 60 * 60),
    officialPublishMaxAgeSeconds: positiveInteger(overrides.officialPublishMaxAgeSeconds ?? env.REMOTE_REFRESH_OFFICIAL_PUBLISH_MAX_AGE_SECONDS, 20 * 60),
    futureClockSkewSeconds: Math.max(0, finiteNumber(overrides.futureClockSkewSeconds ?? env.REMOTE_REFRESH_FUTURE_CLOCK_SKEW_SECONDS, 120)),
    maxRelayWakePollSeconds: Math.max(0.1, finiteNumber(overrides.maxRelayWakePollSeconds ?? env.REMOTE_REFRESH_MAX_RELAY_WAKE_POLL_SECONDS, 5)),
    maxObservedRelayWakeLatencyMs: positiveInteger(overrides.maxObservedRelayWakeLatencyMs ?? env.REMOTE_REFRESH_MAX_RELAY_WAKE_LATENCY_MS, 7_500),
    requireObservedRelayWake: overrides.requireObservedRelayWake ?? env.REMOTE_REFRESH_REQUIRE_OBSERVED_RELAY_WAKE === "1",
    adminAttempts: positiveInteger(overrides.adminAttempts ?? env.REMOTE_REFRESH_ADMIN_ATTEMPTS, 12),
    adminRetryDelayMs: positiveInteger(overrides.adminRetryDelayMs ?? env.REMOTE_REFRESH_ADMIN_RETRY_DELAY_MS, 5_000),
    nowMs: finiteNumber(overrides.nowMs, Date.now())
  };
};

const redactSecret = (value, secrets = []) => {
  let text = String(value || "");
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join("[redacted]");
  }
  return text.slice(0, 500);
};

const redactOutputValue = (value, secrets = []) => {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      if (secret) text = text.split(String(secret)).join("[redacted]");
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redactOutputValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    redactOutputValue(key, secrets),
    redactOutputValue(nested, secrets)
  ]));
};

const serializeRedactedPayload = (payload, secrets = []) => JSON.stringify(
  redactOutputValue(payload, secrets),
  null,
  2
);

const requestJson = (config, pathname, token = "") => {
  const target = new URL(pathname, config.baseUrl);
  const transport = target.protocol === "https:" ? https : http;
  const secrets = [config.accessToken, config.adminToken];

  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const req = transport.request(target, {
      method: "GET",
      timeout: config.requestTimeoutMs,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    }, (res) => {
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > config.responseMaxBytes) {
          req.destroy(new Error("response exceeded the configured byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        let parseError = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (error) {
          parseError = redactSecret(error.message, secrets);
        }
        finish({
          status: Number(res.statusCode || 0),
          body,
          bytes,
          parseError
        });
      });
      res.on("error", (error) => finish({
        status: 0,
        body: null,
        bytes,
        error: redactSecret(error.message, secrets)
      }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (error) => finish({
      status: 0,
      body: null,
      bytes,
      error: redactSecret(error.message, secrets)
    }));
    req.end();
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pushCheck = (checks, name, ok, details = {}, options = {}) => {
  checks.push({
    name,
    required: options.required !== false,
    skipped: options.skipped === true,
    ...details,
    ok: Boolean(ok)
  });
};

const pushSkipped = (checks, name, reason, required = false) => {
  pushCheck(checks, name, !required, { reason }, { required, skipped: true });
};

const timestampAgeSeconds = (value, nowMs) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? Math.round((nowMs - time) / 1000) : null;
};

const freshnessEvidence = (value, staleFlag, nowMs, maxAgeSeconds, futureClockSkewSeconds) => {
  const ageSeconds = timestampAgeSeconds(value, nowMs);
  return {
    ok: staleFlag === false
      && ageSeconds !== null
      && ageSeconds >= -futureClockSkewSeconds
      && ageSeconds <= maxAgeSeconds,
    updatedAt: value || null,
    stale: staleFlag ?? null,
    ageSeconds,
    maxAgeSeconds
  };
};

const statusOf = (match) => String(match?.effectiveStatus || match?.status || "").toUpperCase();
const integerScore = (value) => Number.isInteger(Number(value)) && Number(value) >= 0;
const trustedOfficialResult = (match) => statusOf(match) === "FINISHED"
  && integerScore(match?.scoreHome)
  && integerScore(match?.scoreAway)
  && match?.resultProvenance?.official === true
  && match?.resultProvenance?.trusted === true
  && (
    match?.resultProvenance?.provider === "sporttery"
    || (
      match?.resultProvenance?.provider === "uefa"
      && match?.resultProvenance?.source === "uefa:official-match-api"
      && match?.resultProvenance?.sourceKind === "official-competition-organizer"
      && match?.resultProvenance?.scoreKind === "regular-time"
      && match?.resultProvenance?.resultObservationFallback === false
    )
  );

const PREDICTION_REVIEW_LOCKED_FIELDS = Object.freeze([
  "settled",
  "won",
  "lost",
  "void",
  "hitRate",
  "mainSettled",
  "mainWon",
  "mainLost",
  "mainVoid",
  "allSettled",
  "allWon",
  "allLost",
  "allVoid",
  "referenceSettled",
  "referenceWon",
  "referenceLost",
  "referenceVoid",
  "bestStatus",
  "formalBestStatus",
  "referenceBestStatus",
  "archivedBestStatus",
  "bestRole",
  "oneXTwoStatus",
  "handicapHit",
  "missedHandicapLane"
]);

const PREDICTION_REVIEW_ROW_LOCKED_FIELDS = Object.freeze([
  "marketType",
  "oddsPoolCode",
  "handicapLine",
  "tipCode",
  "tipLabel",
  "odds",
  "actualCode",
  "actualLabel",
  "resultStatus",
  "trustScore",
  "recommendationAction",
  "recommendationTier",
  "reviewRole"
]);

const pickLockedFields = (value, fields) => Object.fromEntries(
  fields.map((field) => [field, value?.[field] ?? null])
);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
};

const hasReview = (review, match) => {
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  if (!review.version || !Number.isFinite(Date.parse(review.generatedAt || ""))) return false;
  if (!review.predictionReview || typeof review.predictionReview !== "object") return false;
  if (!Array.isArray(review.predictionReview.rows)) return false;
  if (!integerScore(match?.scoreHome) || !integerScore(match?.scoreAway)) return false;
  if (review.finalScore !== `${Number(match.scoreHome)}-${Number(match.scoreAway)}`) return false;
  const reviewId = matchIdentity(review);
  const rowId = matchIdentity(match);
  return Boolean(reviewId && rowId && reviewId === rowId);
};

const lockedReviewSnapshot = (review) => ({
  version: review?.version || null,
  generatedAt: review?.generatedAt || null,
  matchId: matchIdentity(review) || null,
  finalScore: review?.finalScore || null,
  predictionReview: pickLockedFields(review?.predictionReview, PREDICTION_REVIEW_LOCKED_FIELDS),
  rows: Array.isArray(review?.predictionReview?.rows)
    ? review.predictionReview.rows.map((row) => pickLockedFields(row, PREDICTION_REVIEW_ROW_LOCKED_FIELDS))
    : null
});

const reviewsAgree = (historyReview, detailReview) => JSON.stringify(canonicalize(lockedReviewSnapshot(historyReview)))
  === JSON.stringify(canonicalize(lockedReviewSnapshot(detailReview)));

const sameMatch = (left, right) => {
  const leftId = matchIdentity(left);
  const rightId = matchIdentity(right);
  return Boolean(leftId && rightId && leftId === rightId);
};

const compactId = (match) => matchIdentity(match) || "unknown";

const currentRetentionEvidence = (rows, policy, config) => {
  const retentionHours = Number(policy?.unsettledRetentionHours);
  const evaluatedMs = config.nowMs - config.retentionGraceSeconds * 1000;
  const evaluatedAt = new Date(evaluatedMs).toISOString();
  const unresolved = rows.filter((row) => String(row?.status || "").toUpperCase() !== "FINISHED");
  const invalidKickoff = unresolved.filter((row) => !Number.isFinite(Date.parse(row?.kickoffTime || "")));
  const expired = unresolved.filter((row) => !isMatchEligibleForCurrent(row, evaluatedAt, { retentionHours }));
  return {
    unresolved,
    invalidKickoff,
    expired,
    evaluatedAt,
    retentionHours
  };
};

const selectReviewSamples = (rows, count) => rows
  .filter(trustedOfficialResult)
  .sort((left, right) => Date.parse(right?.kickoffTime || "") - Date.parse(left?.kickoffTime || ""))
  .slice(0, count);

const adminDiagnosticsReady = (response, policy, config) => {
  const diagnostics = response.body?.admin?.refreshPipeline || null;
  const cycle = diagnostics?.cycle || null;
  const relayWake = diagnostics?.relayWake || null;
  const wake = diagnostics?.wake || null;
  const officialAgeSeconds = timestampAgeSeconds(cycle?.finishedAt, config.nowMs);
  const policyEvaluatedMs = Date.parse(policy?.evaluatedAt || "");
  const cycleFinishedMs = Date.parse(cycle?.finishedAt || "");
  const cycleMatchesPolicy = Number.isFinite(policyEvaluatedMs)
    && Number.isFinite(cycleFinishedMs)
    && cycleFinishedMs >= policyEvaluatedMs;
  const officialReady = response.status === 200
    && cycle?.phase === "official-result-published"
    && cycle?.ok === true
    && cycleMatchesPolicy
    && officialAgeSeconds !== null
    && officialAgeSeconds >= -config.futureClockSkewSeconds
    && officialAgeSeconds <= config.officialPublishMaxAgeSeconds;
  const relayConfigured = relayWake?.enabled === true
    && typeof relayWake?.eligible === "boolean"
    && Number.isFinite(Number(relayWake?.pollSeconds))
    && Number(relayWake.pollSeconds) > 0
    && Number(relayWake.pollSeconds) <= config.maxRelayWakePollSeconds;
  const observedRelayWake = wake?.reason === "relay-snapshot-updated"
    && Number.isFinite(Number(wake?.waitedMs))
    && Number(wake.waitedMs) >= 0
    && Number(wake.waitedMs) <= config.maxObservedRelayWakeLatencyMs;
  return {
    diagnostics,
    cycle,
    wake,
    relayWake,
    officialAgeSeconds,
    cycleMatchesPolicy,
    officialReady,
    relayConfigured,
    observedRelayWake,
    ready: officialReady && relayConfigured && (!config.requireObservedRelayWake || observedRelayWake)
  };
};

const pollAdminDiagnostics = async (config, policy) => {
  let response = null;
  let evidence = null;
  for (let attempt = 1; attempt <= config.adminAttempts; attempt += 1) {
    response = await requestJson(config, "/api/v1/source-health?detail=admin", config.adminToken);
    evidence = adminDiagnosticsReady(response, policy, config);
    if (evidence.ready || attempt === config.adminAttempts) return { response, evidence, attempts: attempt };
    await sleep(config.adminRetryDelayMs);
  }
  return { response, evidence, attempts: config.adminAttempts };
};

const runVerification = async (configInput = {}) => {
  const config = configInput.baseUrl instanceof URL
    ? configInput
    : buildConfig(process.env, configInput);
  const checks = [];
  const httpsRequired = config.baseUrl.protocol === "https:" || config.allowHttp;
  pushCheck(checks, "remote refresh verification uses HTTPS", httpsRequired, {
    protocol: config.baseUrl.protocol,
    localHttpOverride: config.allowHttp
  });

  const health = await requestJson(config, "/api/v1/health");
  const sqlite = health.body?.storage?.sqlite || {};
  const currentRead = health.body?.data?.currentRead || health.body?.currentRead || {};
  pushCheck(checks, "public v1 health is reachable", health.status === 200 && health.body?.apiVersion === "v1", {
    status: health.status,
    apiVersion: health.body?.apiVersion || null,
    checkedAt: health.body?.checkedAt || null,
    error: health.error || health.parseError || null
  });
  pushCheck(checks, "public health proves SQLite primary reads", health.status === 200
    && sqlite.available === true
    && currentRead.source === "sqlite", {
    sqliteAvailable: sqlite.available ?? null,
    readSource: currentRead.source || null,
    currentCount: currentRead.count ?? health.body?.data?.currentCount ?? null
  });

  const syncMetaResponse = await requestJson(config, "/api/v1/sync-meta");
  const syncMeta = syncMetaResponse.body || {};
  const policy = syncMeta.currentListPolicy || null;
  pushCheck(checks, "current list kickoff retention policy is active", syncMetaResponse.status === 200
    && policy?.version === "kickoff-retention-v1"
    && Number(policy?.unsettledRetentionHours) === DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS
    && Number.isFinite(Date.parse(policy?.evaluatedAt || "")), {
    status: syncMetaResponse.status,
    version: policy?.version || null,
    evaluatedAt: policy?.evaluatedAt || null,
    unsettledRetentionHours: policy?.unsettledRetentionHours ?? null,
    archivedUnsettled: policy?.archivedUnsettled ?? null,
    error: syncMetaResponse.error || syncMetaResponse.parseError || null
  });

  const resultFreshness = freshnessEvidence(
    syncMeta.sourceHealth?.resultFreshnessTime || syncMeta.api?.resultFreshnessTime,
    syncMeta.sourceHealth?.resultStale ?? syncMeta.api?.resultStale,
    config.nowMs,
    config.resultMaxAgeSeconds,
    config.futureClockSkewSeconds
  );
  const historyFreshness = freshnessEvidence(
    syncMeta.sourceHealth?.historyFreshnessTime || syncMeta.api?.historyFreshnessTime,
    syncMeta.api?.historyStale,
    config.nowMs,
    config.historyMaxAgeSeconds,
    config.futureClockSkewSeconds
  );
  pushCheck(checks, "official result lane is fresh", resultFreshness.ok, resultFreshness);
  pushCheck(checks, "history lane is fresh", historyFreshness.ok, historyFreshness);

  const hasAccessToken = Boolean(config.accessToken);
  pushCheck(checks, "protected read token is supplied by environment", hasAccessToken, {
    configured: hasAccessToken,
    acceptedEnvironmentKeys: ["REMOTE_REFRESH_ACCESS_TOKEN", "VERIFY_ACCESS_TOKEN"]
  });

  let current = null;
  let history = null;
  let reviewSamples = [];
  if (!hasAccessToken) {
    const reason = "protected read token not configured; protected current/history/detail checks were not attempted";
    pushSkipped(checks, "current list has no expired unresolved matches", reason);
    pushSkipped(checks, "history payload is fresh and contains review samples", reason);
    pushSkipped(checks, "history and match detail agree", reason);
  } else {
    current = await requestJson(config, "/api/v1/matches/current?view=list", config.accessToken);
    const currentRows = Array.isArray(current.body?.rows) ? current.body.rows : [];
    pushCheck(checks, "protected current list is readable from SQLite", current.status === 200
      && current.body?.ok === true
      && current.body?.currentRead?.source === "sqlite"
      && Array.isArray(current.body?.rows), {
      status: current.status,
      rows: currentRows.length,
      readSource: current.body?.currentRead?.source || null,
      sourceUpdatedAt: current.body?.sourceUpdatedAt || null,
      stale: current.body?.stale ?? null,
      error: current.error || current.parseError || null
    });
    const retention = currentRetentionEvidence(currentRows, policy, config);
    pushCheck(checks, "current unresolved rows have valid kickoff timestamps", retention.invalidKickoff.length === 0, {
      invalidCount: retention.invalidKickoff.length,
      invalidIds: retention.invalidKickoff.slice(0, 10).map(compactId)
    });
    pushCheck(checks, "current list has no expired unresolved matches", retention.expired.length === 0, {
      retentionHours: retention.retentionHours,
      graceSeconds: config.retentionGraceSeconds,
      evaluatedAt: retention.evaluatedAt,
      unresolvedCount: retention.unresolved.length,
      expiredCount: retention.expired.length,
      expiredIds: retention.expired.slice(0, 10).map(compactId)
    });

    history = await requestJson(config, `/api/v1/matches/history?limit=${config.historyLimit}`, config.accessToken);
    const historyRows = Array.isArray(history.body?.rows) ? history.body.rows : [];
    const historyPayloadFreshness = freshnessEvidence(
      history.body?.sourceUpdatedAt,
      history.body?.stale,
      config.nowMs,
      config.historyMaxAgeSeconds,
      config.futureClockSkewSeconds
    );
    reviewSamples = selectReviewSamples(historyRows, config.detailSampleSize);
    const reviewedSamples = reviewSamples.filter((row) => hasReview(row?.postMatchReview, row));
    const missingReviewIds = reviewSamples
      .filter((row) => !hasReview(row?.postMatchReview, row))
      .map(compactId);
    pushCheck(checks, "history payload is fresh and contains review samples", history.status === 200
      && history.body?.ok === true
      && Array.isArray(history.body?.rows)
      && historyPayloadFreshness.ok
      && reviewSamples.length === config.detailSampleSize
      && reviewedSamples.length === config.detailSampleSize, {
      status: history.status,
      rows: historyRows.length,
      source: history.body?.source || null,
      sourceUpdatedAt: historyPayloadFreshness.updatedAt,
      ageSeconds: historyPayloadFreshness.ageSeconds,
      stale: historyPayloadFreshness.stale,
      requiredReviewSamples: config.detailSampleSize,
      latestTrustedFinishedSamples: reviewSamples.length,
      availableReviewSamples: reviewedSamples.length,
      missingReviewIds,
      error: history.error || history.parseError || null
    });

    const detailResults = [];
    for (const historyRow of reviewSamples) {
      const id = historyRow.id || historyRow.sourceMatchId;
      const detail = await requestJson(config, `/api/v1/matches/${encodeURIComponent(id)}`, config.accessToken);
      const detailMatch = detail.body?.match || null;
      const consistent = detail.status === 200
        && detail.body?.ok === true
        && sameMatch(historyRow, detailMatch)
        && statusOf(detailMatch) === statusOf(historyRow)
        && Number(detailMatch?.scoreHome) === Number(historyRow?.scoreHome)
        && Number(detailMatch?.scoreAway) === Number(historyRow?.scoreAway)
        && hasReview(historyRow?.postMatchReview, historyRow)
        && hasReview(detailMatch?.postMatchReview, detailMatch)
        && reviewsAgree(historyRow?.postMatchReview, detailMatch?.postMatchReview);
      detailResults.push({
        id: compactId(historyRow),
        status: detail.status,
        consistent,
        historyStatus: statusOf(historyRow) || null,
        detailStatus: statusOf(detailMatch) || null,
        historyScore: integerScore(historyRow?.scoreHome) && integerScore(historyRow?.scoreAway)
          ? `${Number(historyRow.scoreHome)}-${Number(historyRow.scoreAway)}`
          : null,
        detailScore: integerScore(detailMatch?.scoreHome) && integerScore(detailMatch?.scoreAway)
          ? `${Number(detailMatch.scoreHome)}-${Number(detailMatch.scoreAway)}`
          : null,
        historyReview: hasReview(historyRow?.postMatchReview, historyRow),
        detailReview: hasReview(detailMatch?.postMatchReview, detailMatch),
        reviewLockedFieldsAgree: reviewsAgree(historyRow?.postMatchReview, detailMatch?.postMatchReview),
        error: detail.error || detail.parseError || null
      });
    }
    pushCheck(checks, "history and match detail agree", detailResults.length === config.detailSampleSize
      && detailResults.every((item) => item.consistent), {
      requiredSamples: config.detailSampleSize,
      checkedSamples: detailResults.length,
      samples: detailResults
    });
  }

  let adminEvidence = null;
  if (!config.adminToken) {
    pushSkipped(
      checks,
      "admin refresh diagnostics prove official publish and relay wake configuration",
      "REMOTE_REFRESH_ADMIN_TOKEN or ADMIN_TOKEN not configured; admin-only diagnostics were not requested",
      config.requireAdmin
    );
  } else {
    const admin = await pollAdminDiagnostics(config, policy);
    adminEvidence = admin.evidence;
    pushCheck(checks, "admin refresh diagnostics prove official publish", admin.response?.status === 200
      && adminEvidence?.officialReady === true, {
      status: admin.response?.status || 0,
      attempts: admin.attempts,
      phase: adminEvidence?.cycle?.phase || null,
      ok: adminEvidence?.cycle?.ok ?? null,
      startedAt: adminEvidence?.cycle?.startedAt || null,
      finishedAt: adminEvidence?.cycle?.finishedAt || null,
      durationMs: adminEvidence?.cycle?.durationMs ?? null,
      ageSeconds: adminEvidence?.officialAgeSeconds ?? null,
      matchesCurrentPolicyEvaluation: adminEvidence?.cycleMatchesPolicy ?? false,
      error: admin.response?.error || admin.response?.parseError || null
    });
    pushCheck(checks, "admin refresh diagnostics prove relay wake configuration", adminEvidence?.relayConfigured === true
      && (!config.requireObservedRelayWake || adminEvidence?.observedRelayWake === true), {
      attempts: admin.attempts,
      enabled: adminEvidence?.relayWake?.enabled ?? null,
      eligible: adminEvidence?.relayWake?.eligible ?? null,
      pollSeconds: adminEvidence?.relayWake?.pollSeconds ?? null,
      maxPollSeconds: config.maxRelayWakePollSeconds,
      wakeReason: adminEvidence?.wake?.reason || null,
      wakeWaitedMs: adminEvidence?.wake?.waitedMs ?? null,
      observedRelayWake: adminEvidence?.observedRelayWake ?? false,
      observedRelayWakeRequired: config.requireObservedRelayWake,
      maxObservedLatencyMs: config.maxObservedRelayWakeLatencyMs
    });
  }

  const requiredChecks = checks.filter((check) => check.required !== false);
  const failedChecks = requiredChecks.filter((check) => !check.ok);
  const payload = {
    ok: failedChecks.length === 0,
    auditOnly: config.auditOnly,
    verifier: "remote-refresh-pipeline-v1",
    checkedAt: new Date(config.nowMs).toISOString(),
    baseUrl: config.baseUrl.origin,
    summary: {
      required: requiredChecks.length,
      failed: failedChecks.length,
      skipped: checks.filter((check) => check.skipped).length,
      sqlitePrimary: sqlite.available === true && currentRead.source === "sqlite",
      retentionPolicy: policy?.version || null,
      currentRows: Array.isArray(current?.body?.rows) ? current.body.rows.length : null,
      historyRows: Array.isArray(history?.body?.rows) ? history.body.rows.length : null,
      detailSamples: reviewSamples.length,
      strictAdminRequired: config.requireAdmin,
      adminDiagnosticsChecked: Boolean(config.adminToken),
      observedRelayWake: adminEvidence?.observedRelayWake ?? null
    },
    checks
  };
  return payload;
};

const main = async () => {
  const config = buildConfig();
  const payload = await runVerification(config);
  console.log(serializeRedactedPayload(payload, [config.accessToken, config.adminToken]));
  if (!payload.ok && !config.auditOnly) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    let config = null;
    try {
      config = buildConfig();
    } catch {
      config = null;
    }
    const accessToken = config?.accessToken
      ?? process.env.REMOTE_REFRESH_ACCESS_TOKEN
      ?? process.env.VERIFY_ACCESS_TOKEN
      ?? "";
    const adminToken = config?.adminToken
      ?? process.env.REMOTE_REFRESH_ADMIN_TOKEN
      ?? process.env.ADMIN_TOKEN
      ?? "";
    console.error(serializeRedactedPayload({
      ok: false,
      verifier: "remote-refresh-pipeline-v1",
      checkedAt: new Date().toISOString(),
      baseUrl: config?.baseUrl?.origin || null,
      error: redactSecret(error.message || String(error), [accessToken, adminToken])
    }, [accessToken, adminToken]));
    if (!(config?.auditOnly ?? process.env.REMOTE_REFRESH_AUDIT_ONLY === "1")) process.exitCode = 1;
  });
}

module.exports = {
  adminDiagnosticsReady,
  buildConfig,
  currentRetentionEvidence,
  freshnessEvidence,
  reviewsAgree,
  runVerification,
  selectReviewSamples,
  serializeRedactedPayload
};
