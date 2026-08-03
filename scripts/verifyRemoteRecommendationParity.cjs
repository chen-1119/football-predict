const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const {
  archivedDecision,
  canonicalId,
  canonicalRecommendationDecision,
  comparablePoolRows,
  compareRecommendationProjectionPair,
  isResultPhase,
  publishedBestDecision,
  scheduledWithoutBestIds,
  storedStatusOf,
  text,
  upper,
} = require("../server/recommendationProjectionParity.cjs");

const VERSION = "remote-recommendation-parity-v1";

const compareRecommendationParity = compareRecommendationProjectionPair;

// A source can first appear after kickoff with an authoritative final score.
// It has no pre-match BEST, no pool direction, and therefore cannot honestly
// be replayed as a recommendation. Keep it visible as a result-only archive,
// while preserving fail-closed enforcement for pending rows and every row that
// ever exposed a pre-match direction.
const isAuthoritativeResultOnlyArchive = (row, nowMs = Date.now()) => {
  if (storedStatusOf(row) !== "FINISHED" || !isResultPhase(row, nowMs)) return false;
  if (archivedDecision(row) || publishedBestDecision(row)) return false;
  const directions = Array.isArray(row?.predictions)
    ? row.predictions.filter((prediction) => ["1", "X", "2"].includes(upper(prediction?.tipCode)))
    : [];
  if (directions.length > 0) return false;
  const scoreReady = Number.isFinite(Number(row?.scoreHome)) && Number.isFinite(Number(row?.scoreAway));
  const reviewScore = text(row?.postMatchReview?.finalScore);
  return scoreReady || Boolean(reviewScore);
};

const positiveInteger = (value, fallback) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const nonNegativeInteger = (value, fallback) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, Number(milliseconds || 0)));
});

const buildConfig = (env = process.env, overrides = {}) => ({
  baseUrl: new URL(
    overrides.baseUrl
      || env.REMOTE_RECOMMENDATION_BASE_URL
      || env.REMOTE_BASE_URL
      || env.PUBLIC_BASE_URL
      || "https://127.0.0.1:8788"
  ),
  accessToken: overrides.accessToken
    ?? env.REMOTE_RECOMMENDATION_ACCESS_TOKEN
    ?? env.VERIFY_ACCESS_TOKEN
    ?? "",
  accessCodeAdminToken: overrides.accessCodeAdminToken
    ?? env.REMOTE_RECOMMENDATION_ACCESS_CODE_ADMIN_TOKEN
    ?? env.ACCESS_CODE_ADMIN_TOKEN
    ?? "",
  temporaryAccessCodeLabel: text(
    overrides.temporaryAccessCodeLabel
      ?? env.REMOTE_RECOMMENDATION_ACCESS_CODE_LABEL
      ?? "remote-recommendation-parity-qa"
  ).slice(0, 80),
  temporaryAccessCodeTtlSeconds: Math.max(60, Math.min(3_600, positiveInteger(
    overrides.temporaryAccessCodeTtlSeconds
      ?? env.REMOTE_RECOMMENDATION_ACCESS_CODE_TTL_SECONDS,
    300,
  ))),
  timeoutMs: positiveInteger(
    overrides.timeoutMs ?? env.REMOTE_RECOMMENDATION_TIMEOUT_MS,
    20_000
  ),
  maxBytes: positiveInteger(
    overrides.maxBytes ?? env.REMOTE_RECOMMENDATION_MAX_BYTES,
    16 * 1024 * 1024
  ),
  detailConcurrency: Math.max(1, Math.min(12, positiveInteger(
    overrides.detailConcurrency
      ?? env.REMOTE_RECOMMENDATION_DETAIL_CONCURRENCY,
    8,
  ))),
  readRetries: Math.max(0, Math.min(3, nonNegativeInteger(
    overrides.readRetries ?? env.REMOTE_RECOMMENDATION_READ_RETRIES,
    2,
  ))),
  retryDelayMs: Math.max(50, Math.min(2_000, positiveInteger(
    overrides.retryDelayMs ?? env.REMOTE_RECOMMENDATION_RETRY_DELAY_MS,
    250,
  ))),
});

const requestJson = (config, pathname, options = {}) => new Promise((resolve) => {
  const target = new URL(pathname, config.baseUrl);
  const transport = target.protocol === "https:" ? https : http;
  const method = upper(options.method || "GET");
  const payload = options.body === undefined || options.body === null
    ? ""
    : JSON.stringify(options.body);
  const headers = {
    ...(config.accessToken
      ? { authorization: `Bearer ${config.accessToken}` }
      : {}),
    ...(payload
      ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        }
      : {}),
    ...(options.headers || {}),
  };
  let settled = false;
  let bytes = 0;
  const chunks = [];
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    resolve(payload);
  };
  const req = transport.request(target, {
    method,
    timeout: config.timeoutMs,
    headers,
  }, (res) => {
    res.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > config.maxBytes) {
        req.destroy(new Error("response exceeded configured byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      finish({ status: Number(res.statusCode || 0), body, bytes });
    });
  });
  req.on("timeout", () => req.destroy(new Error("request timeout")));
  req.on("error", (error) => finish({
    status: 0,
    body: null,
    bytes,
    error: text(error?.message).slice(0, 240),
  }));
  if (payload) req.write(payload);
  req.end();
});

const retryableTransportResponse = (response) => (
  response?.status === 0
  || response?.status === 408
  || response?.status === 429
  || Number(response?.status || 0) >= 500
);

const requestJsonWithReadRetry = async (config, pathname, options = {}) => {
  const method = upper(options.method || "GET");
  const retries = method === "GET" || method === "HEAD"
    ? Math.max(0, Number(config.readRetries || 0))
    : 0;
  let response = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    response = await requestJson(config, pathname, options);
    const retryable = retryableTransportResponse(response);
    if (!retryable || attempt >= retries) {
      return { ...response, attempts: attempt + 1 };
    }
    await sleep(Number(config.retryDelayMs || 250) * (attempt + 1));
  }
  return response;
};

const requestJsonWithSafeMutationRetry = async (config, pathname, options = {}) => {
  let response = null;
  const retries = Math.max(0, Number(config.readRetries || 0));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    response = await requestJson(config, pathname, options);
    if (!retryableTransportResponse(response) || attempt >= retries) {
      return { ...response, attempts: attempt + 1 };
    }
    await sleep(Number(config.retryDelayMs || 250) * (attempt + 1));
  }
  return response;
};

const temporaryAccessCodeLabelForRun = (config) => {
  const base = text(
    config.temporaryAccessCodeLabel || "remote-recommendation-parity-qa",
  ) || "remote-recommendation-parity-qa";
  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  return `${base.slice(0, Math.max(1, 79 - suffix.length))}-${suffix}`;
};

const revokeTemporaryAccessCodes = async (
  config,
  {
    label,
    knownId = "",
    searchByLabel = false,
  } = {},
) => {
  const ids = new Set(knownId ? [text(knownId)] : []);
  let lookupOk = !searchByLabel;
  let lookupStatus = null;
  if (searchByLabel) {
    const listed = await requestJsonWithReadRetry(
      config,
      "/api/admin/access-codes",
      {
        headers: {
          authorization: `Bearer ${config.accessCodeAdminToken}`,
        },
      },
    );
    lookupStatus = listed.status;
    if (listed.status === 200 && Array.isArray(listed.body?.rows)) {
      lookupOk = true;
      for (const row of listed.body.rows) {
        if (text(row?.label) === label && row?.status !== "revoked" && row?.id) {
          ids.add(text(row.id));
        }
      }
    }
  }
  const results = [];
  for (const id of ids) {
    const revoked = await requestJsonWithSafeMutationRetry(
      { ...config, accessToken: "" },
      `/api/admin/access-codes/${encodeURIComponent(id)}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.accessCodeAdminToken}`,
        },
      },
    );
    results.push({
      id,
      status: revoked.status,
      attempts: revoked.attempts,
      ok: revoked.status === 200 && revoked.body?.ok === true,
    });
  }
  return {
    complete: lookupOk && results.every((row) => row.ok),
    lookupOk,
    lookupStatus,
    found: ids.size,
    revoked: results.filter((row) => row.ok).length,
    results,
  };
};

const mapWithConcurrency = async (rows, limit, mapper) => {
  const source = Array.isArray(rows) ? rows : [];
  const results = new Array(source.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(source[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(source.length, Math.max(1, Number(limit || 1))) },
      () => worker(),
    ),
  );
  return results;
};

const missingAccessPayload = (config, reason = "protected-read-token-missing") => ({
  ok: false,
  verifier: VERSION,
  checkedAt: new Date().toISOString(),
  baseUrl: config.baseUrl.origin,
  summary: { rows: 0, checked: 0, scheduledWithoutBest: 0, mismatches: 1 },
  mismatches: [{ id: "configuration", reasons: [reason] }],
  checks: [],
});

const runVerificationWithAccess = async (config) => {
  const checks = [];
  const verifiedAtMs = Date.now();
  if (!config.accessToken) {
    return missingAccessPayload(config);
  }

  const current = await requestJsonWithReadRetry(
    config,
    "/api/v1/matches/current?view=list",
  );
  const rows = Array.isArray(current.body?.rows) ? current.body.rows : [];
  checks.push({
    name: "protected current recommendation list is readable",
    ok: current.status === 200 && current.body?.ok === true && Array.isArray(current.body?.rows),
    status: current.status,
    rows: rows.length,
    error: current.error || null,
  });

  const scheduledWithoutBest = scheduledWithoutBestIds(rows, verifiedAtMs);
  checks.push({
    name: "every scheduled row has an explicit BEST recommendation",
    ok: scheduledWithoutBest.length === 0,
    missingIds: scheduledWithoutBest,
  });

  const resultOnlyArchives = rows.filter((row) => isAuthoritativeResultOnlyArchive(row, verifiedAtMs));
  const resultPhaseWithoutArchive = rows
    .filter((row) => (
      isResultPhase(row, verifiedAtMs)
      && !archivedDecision(row)
      && !isAuthoritativeResultOnlyArchive(row, verifiedAtMs)
    ))
    .map((row) => canonicalId(row) || text(row?.id) || "unknown");
  const postKickoffScheduled = rows.filter((row) => (
    storedStatusOf(row) === "SCHEDULED"
    && Number.isFinite(Date.parse(row?.kickoffTime || ""))
    && Date.parse(row.kickoffTime) <= verifiedAtMs
  ));
  const archiveScopeCounts = rows.reduce((counts, row) => {
    const archive = row?.archivedPreMatchPrediction;
    if (!archive) return counts;
    const scope = text(archive.marketEvidenceScope) || "result-pool";
    counts[scope] = Number(counts[scope] || 0) + 1;
    return counts;
  }, {});
  checks.push({
    name: "every directional post-kickoff or result-phase row has an immutable pre-match archive",
    ok: resultPhaseWithoutArchive.length === 0,
    missingIds: resultPhaseWithoutArchive,
    resultOnlyArchives: resultOnlyArchives.length,
    postKickoffScheduled: postKickoffScheduled.length,
    archiveScopeCounts,
  });

  const parityRows = await mapWithConcurrency(
    rows.filter((row) => !isAuthoritativeResultOnlyArchive(row, verifiedAtMs)),
    config.detailConcurrency,
    async (row) => {
    const id = row?.id || row?.sourceMatchId;
    if (!id) {
      return {
        ok: false,
        id: "unknown",
        reasons: ["list-match-id-missing"],
      };
    }
    const detail = await requestJsonWithReadRetry(
      config,
      `/api/v1/matches/${encodeURIComponent(id)}`
    );
    if (detail.status !== 200 || detail.body?.ok !== true || !detail.body?.match) {
      return {
        ok: false,
        id: canonicalId(row) || text(id),
        reasons: ["detail-request-failed"],
        status: detail.status,
        attempts: detail.attempts,
      };
    }
    return compareRecommendationParity(row, detail.body.match, verifiedAtMs);
    },
  );

  const mismatches = parityRows
    .filter((row) => !row.ok)
    .map((row) => ({
      id: row.id,
      reasons: row.reasons,
      listDecision: row.listDecision || null,
      detailDecision: row.detailDecision || null,
      listPoolRows: row.listPoolRows || [],
      detailPoolRows: row.detailPoolRows || [],
    }));
  checks.push({
    name: "list, detail, and frozen archive expose one canonical direction",
    ok: parityRows.length === rows.length - resultOnlyArchives.length && mismatches.length === 0,
    checked: parityRows.length,
    mismatchIds: mismatches.map((row) => row.id),
  });

  const failedChecks = checks.filter((check) => !check.ok);
  return {
    ok: failedChecks.length === 0,
    verifier: VERSION,
    checkedAt: new Date().toISOString(),
    baseUrl: config.baseUrl.origin,
    summary: {
      rows: rows.length,
      checked: parityRows.length,
      scheduledWithoutBest: scheduledWithoutBest.length,
      resultPhaseWithoutArchive: resultPhaseWithoutArchive.length,
      resultOnlyArchives: resultOnlyArchives.length,
      postKickoffScheduled: postKickoffScheduled.length,
      archiveScopeCounts,
      mismatches: mismatches.length,
    },
    mismatches,
    checks,
  };
};

const runVerification = async (config = buildConfig()) => {
  if (config.accessToken) {
    const payload = await runVerificationWithAccess(config);
    return {
      ...payload,
      accessSession: {
        mode: "provided-token",
        temporary: false,
        created: false,
        verified: true,
        revoked: null,
      },
    };
  }

  if (!config.accessCodeAdminToken) {
    return {
      ...missingAccessPayload(config),
      accessSession: {
        mode: "unavailable",
        temporary: false,
        created: false,
        verified: false,
        revoked: null,
      },
    };
  }

  let temporaryCodeId = "";
  let sessionVerified = false;
  let revokeStatus = 0;
  let revoked = false;
  let createAttempts = 0;
  let createAmbiguous = false;
  let cleanup = null;
  let setupError = null;
  let payload = null;
  const runLabel = temporaryAccessCodeLabelForRun(config);
  try {
    let created = null;
    for (let attempt = 0; attempt <= config.readRetries; attempt += 1) {
      created = await requestJson(config, "/api/admin/access-codes", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.accessCodeAdminToken}`,
        },
        body: {
          label: runLabel,
          ttlSeconds: config.temporaryAccessCodeTtlSeconds,
        },
      });
      createAttempts = attempt + 1;
      if (created.status === 200 && created.body?.id && created.body?.code) break;
      if (retryableTransportResponse(created)) createAmbiguous = true;
      if (!retryableTransportResponse(created) || attempt >= config.readRetries) break;
      // A lost response can arrive after the server committed the code. The
      // unique run label lets finally revoke every ambiguous duplicate.
      await sleep(Number(config.retryDelayMs || 250) * (attempt + 1));
    }
    if (created.status !== 200 || !created.body?.id || !created.body?.code) {
      throw new Error(`temporary-access-code-create-failed:${created.status}`);
    }
    temporaryCodeId = text(created.body.id);

    const verified = await requestJson(config, "/api/access/verify", {
      method: "POST",
      body: { code: created.body.code },
    });
    const temporaryAccessToken = text(verified.body?.session?.token);
    if (verified.status !== 200 || !temporaryAccessToken) {
      throw new Error(`temporary-access-code-verify-failed:${verified.status}`);
    }
    sessionVerified = true;
    payload = await runVerificationWithAccess({
      ...config,
      accessToken: temporaryAccessToken,
    });
  } catch (error) {
    setupError = text(error?.message).slice(0, 160) || "temporary-access-session-failed";
  } finally {
    cleanup = await revokeTemporaryAccessCodes(config, {
      label: runLabel,
      knownId: temporaryCodeId,
      searchByLabel: createAmbiguous,
    });
    revokeStatus = cleanup.results.at(-1)?.status || cleanup.lookupStatus || 0;
    revoked = cleanup.complete;
  }

  if (!payload) {
    payload = missingAccessPayload(
      config,
      setupError || "temporary-access-session-failed"
    );
  }
  const accessCheck = {
    name: "temporary QA access session is created, verified, and revoked",
    ok: Boolean(temporaryCodeId) && sessionVerified && revoked,
    created: Boolean(temporaryCodeId),
    verified: sessionVerified,
    revoked,
    revokeStatus,
    createAttempts,
    cleanupFound: cleanup?.found || 0,
    cleanupRevoked: cleanup?.revoked || 0,
    error: setupError,
  };
  const mismatches = accessCheck.ok
    ? payload.mismatches
    : [
        ...(Array.isArray(payload.mismatches) ? payload.mismatches : []),
        {
          id: "access-session",
          reasons: [
            setupError || (revoked
              ? "temporary-access-session-invalid"
              : "temporary-access-code-revoke-failed"),
          ],
        },
      ];
  return {
    ...payload,
    ok: payload.ok === true && accessCheck.ok,
    summary: {
      ...(payload.summary || {}),
      mismatches: mismatches.length,
    },
    mismatches,
    checks: [
      ...(Array.isArray(payload.checks) ? payload.checks : []),
      accessCheck,
    ],
    accessSession: {
      mode: "temporary-admin-code",
      temporary: true,
      created: Boolean(temporaryCodeId),
      verified: sessionVerified,
      revoked,
      createAttempts,
      cleanupFound: cleanup?.found || 0,
      cleanupRevoked: cleanup?.revoked || 0,
    },
  };
};

if (require.main === module) {
  runVerification()
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
      if (!payload.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        verifier: VERSION,
        checkedAt: new Date().toISOString(),
        error: text(error?.message).slice(0, 240),
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  VERSION,
  archivedDecision,
  buildConfig,
  canonicalRecommendationDecision,
  comparablePoolRows,
  compareRecommendationParity,
  publishedBestDecision,
  requestJson,
  runVerification,
  isAuthoritativeResultOnlyArchive,
  runVerificationWithAccess,
  scheduledWithoutBestIds,
};
