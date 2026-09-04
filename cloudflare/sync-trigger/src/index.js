import {
  collectSportteryEvidence,
  createSportteryEvidence,
  sportteryCollectorConfigured,
} from "./sportteryCollector.js";

const DEFAULT_RECENT_RUN_SECONDS = 240;
const DEFAULT_PUBLIC_DATA_CACHE_SECONDS = 20;
const DEFAULT_CURRENT_DATA_CACHE_SECONDS = 5;
const DEFAULT_HISTORY_DATA_CACHE_SECONDS = 180;
const DEFAULT_STALE_DATA_SECONDS = 600;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type"
};

const json = (payload, status = 200) => new Response(JSON.stringify(payload, null, 2), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders
  }
});

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const safeSecretEqual = async (actual, expected) => {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(actual || ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected || ""))),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
};

const readConfig = (env) => ({
  owner: env.GITHUB_OWNER || "chen-1119",
  repo: env.GITHUB_REPO || "football-predict",
  workflowId: env.GITHUB_WORKFLOW_ID || "sync.yml",
  ref: env.GITHUB_REF || "main",
  recentRunSeconds: positiveNumber(env.MIN_SECONDS_BETWEEN_DISPATCHES, DEFAULT_RECENT_RUN_SECONDS),
  publicDataCacheSeconds: positiveNumber(env.PUBLIC_DATA_CACHE_SECONDS, DEFAULT_PUBLIC_DATA_CACHE_SECONDS),
  currentDataCacheSeconds: positiveNumber(env.CURRENT_DATA_CACHE_SECONDS, DEFAULT_CURRENT_DATA_CACHE_SECONDS),
  historyDataCacheSeconds: positiveNumber(env.HISTORY_DATA_CACHE_SECONDS, DEFAULT_HISTORY_DATA_CACHE_SECONDS),
  staleDataSeconds: positiveNumber(env.STALE_DATA_SECONDS, DEFAULT_STALE_DATA_SECONDS)
});

const githubRequest = async (env, path, init = {}) => {
  if (!env.GITHUB_TOKEN) {
    throw new Error("Missing Worker secret GITHUB_TOKEN");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": "football-predict-cloudflare-cron",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }

  if (response.status === 204) return null;
  return response.json();
};

const getRecentRuns = async (env, config) => {
  const path = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowId}/runs?branch=${config.ref}&per_page=5`;
  const payload = await githubRequest(env, path);
  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
};

const hasActiveOrRecentRun = (runs, recentRunSeconds) => {
  const activeStatuses = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
  const now = Date.now();

  const active = runs.find((run) => activeStatuses.has(run.status));
  if (active) {
    return {
      skip: true,
      reason: `workflow already ${active.status}`,
      runId: active.id,
      url: active.html_url
    };
  }

  const latest = runs[0];
  const latestTime = Date.parse(latest?.created_at || latest?.run_started_at || "");
  if (Number.isFinite(latestTime)) {
    const ageSeconds = Math.floor((now - latestTime) / 1000);
    if (ageSeconds >= 0 && ageSeconds < recentRunSeconds) {
      return {
        skip: true,
        reason: `latest run started ${ageSeconds}s ago`,
        runId: latest.id,
        url: latest.html_url
      };
    }
  }

  return { skip: false };
};

const dispatchWorkflow = async (env, config, source) => {
  const path = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowId}/dispatches`;
  await githubRequest(env, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref: config.ref,
      inputs: { source }
    })
  });
};

const triggerSync = async (env, source = "cloudflare-cron") => {
  const config = readConfig(env);
  const runs = await getRecentRuns(env, config);
  const guard = hasActiveOrRecentRun(runs, config.recentRunSeconds);

  if (guard.skip) {
    return {
      ok: true,
      dispatched: false,
      source,
      guard,
      checkedAt: new Date().toISOString()
    };
  }

  await dispatchWorkflow(env, config, source);
  return {
    ok: true,
    dispatched: true,
    source,
    workflow: `${config.owner}/${config.repo}/${config.workflowId}`,
    ref: config.ref,
    checkedAt: new Date().toISOString()
  };
};

const publicDataFileMap = {
  "sync-meta": "public/data/sync-meta.json"
};

const disabledProtectedDataResources = new Map([
  ["matches/current", "/api/v1/matches/current?view=list"],
  ["matches/history", "/api/v1/matches/history?limit=50"],
  ["matches/root", "/api/v1/matches/current?view=list"],
  ["odds/history", "/api/v1/odds/history?matchId=<matchId>&limit=200"],
  ["predictions/snapshots", "/api/v1/model/evaluation?detail=admin"],
  ["model/calibration", "/api/v1/model/evaluation"],
  ["teams/index", "/api/v1/matches/current?view=list"],
  ["source-health", "/api/v1/source-health"],
  ["model/evaluation", "/api/v1/model/evaluation"]
]);

const getResourceCacheSeconds = (config, key) => {
  if (key === "sync-meta" || key === "matches/current" || key === "matches/root") {
    return Math.max(3, config.currentDataCacheSeconds);
  }

  if (key === "matches/history" || key === "odds/history" || key === "predictions/snapshots") {
    return Math.max(30, config.historyDataCacheSeconds);
  }

  return Math.max(5, config.publicDataCacheSeconds);
};

const rawGithubUrl = (config, filePath, cacheSeconds) => {
  const cacheBucket = Math.floor(Date.now() / Math.max(3, cacheSeconds) / 1000);
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.ref}/${filePath}?v=${cacheBucket}`;
};

const fetchPublicJson = async (env, filePath, key = "sync-meta") => {
  const config = readConfig(env);
  const cacheSeconds = getResourceCacheSeconds(config, key);
  const response = await fetch(rawGithubUrl(config, filePath, cacheSeconds), {
    headers: {
      "accept": "application/json",
      "cache-control": "no-cache",
      "user-agent": "football-predict-data-api"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: cacheSeconds
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Public data ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
};

const parseTimeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const runFreshnessMs = (run) => (
  parseTimeMs(run?.updated_at) ??
  parseTimeMs(run?.run_started_at) ??
  parseTimeMs(run?.created_at)
);

const summarizeRun = (run) => run ? {
  id: run.id,
  status: run.status,
  conclusion: run.conclusion,
  updatedAt: run.updated_at,
  startedAt: run.run_started_at,
  createdAt: run.created_at,
  url: run.html_url
} : null;

const getSyncHealth = (meta, config, latestRun = null) => {
  const checkedAt = new Date().toISOString();
  const metaFreshnessTime =
    parseTimeMs(meta?.lastAttemptAt) ??
    parseTimeMs(meta?.updatedAt) ??
    parseTimeMs(meta?.capturedAt);
  const workflowFreshnessTime = runFreshnessMs(latestRun);
  const freshnessTime = Math.max(metaFreshnessTime || 0, workflowFreshnessTime || 0) || null;
  const ageSeconds = freshnessTime === null
    ? null
    : Math.max(0, Math.floor((Date.now() - freshnessTime) / 1000));
  const stale = ageSeconds === null || ageSeconds > config.staleDataSeconds;

  return {
    checkedAt,
    freshnessTime: freshnessTime === null ? null : new Date(freshnessTime).toISOString(),
    metaFreshnessTime: metaFreshnessTime === null ? null : new Date(metaFreshnessTime).toISOString(),
    workflowFreshnessTime: workflowFreshnessTime === null ? null : new Date(workflowFreshnessTime).toISOString(),
    ageSeconds,
    stale,
    staleAfterSeconds: config.staleDataSeconds,
    triggerGuardSeconds: config.recentRunSeconds,
    latestWorkflowRun: summarizeRun(latestRun)
  };
};

const triggerStaleSync = (env, ctx, health, source) => {
  if (!health.stale || !ctx?.waitUntil || !env.GITHUB_TOKEN) return false;

  ctx.waitUntil(
    triggerSync(env, source).catch((error) => {
      console.error("Stale data sync dispatch failed:", error);
    })
  );
  return true;
};

const withApiMeta = (payload, filePath) => ({
  ok: true,
  file: filePath,
  checkedAt: new Date().toISOString(),
  data: payload
});

const resolveApiKey = (pathname) => {
  const normalized = pathname.replace(/^\/api\/?/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized || "sync-meta";
};

const fetchPublicApi = async (env, pathname, ctx) => {
  const key = resolveApiKey(pathname);
  const filePath = publicDataFileMap[key];
  const replacement = disabledProtectedDataResources.get(key);
  if (replacement) {
    return json({
      ok: false,
      error: "protected data API disabled on sync worker",
      key,
      replacement,
      note: "This Worker is a scheduler and freshness helper. C-end recommendation data must be served by the protected Node /api/v1 service."
    }, 410);
  }
  if (!filePath) return json({ ok: false, error: "unknown api resource", key }, 404);

  try {
    const payload = await fetchPublicJson(env, filePath, key);
    if (key === "sync-meta") {
      const config = readConfig(env);
      let latestRun = null;
      try {
        const runs = env.GITHUB_TOKEN ? await getRecentRuns(env, config) : [];
        latestRun = runs[0] || null;
      } catch (error) {
        console.warn("Unable to read latest workflow run:", error.message || error);
      }
      const health = getSyncHealth(payload, config, latestRun);
      const syncTriggered = triggerStaleSync(env, ctx, health, "cloudflare-api-stale");
      return json({
        ...payload,
        refreshPolicy: {
          ...(payload?.refreshPolicy || {}),
          workflowMinutes: Math.max(1, Math.round(config.recentRunSeconds / 60)),
          pagePollSeconds: Math.min(30, Math.max(15, payload?.refreshPolicy?.pagePollSeconds || 30))
        },
        api: {
          ...health,
          syncTriggered,
          source: "cloudflare-worker",
          cacheSeconds: getResourceCacheSeconds(config, key)
        }
      });
    }
    return json(withApiMeta(payload, filePath));
  } catch (error) {
    return json({ ok: false, error: error.message || String(error), key }, 502);
  }
};

const isAuthorizedManualTrigger = async (request, env) => {
  if (!env.MANUAL_TRIGGER_TOKEN) return false;

  const auth = request.headers.get("authorization") || "";
  const bearerToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";

  return safeSecretEqual(bearerToken, env.MANUAL_TRIGGER_TOKEN);
};

export default {
  async scheduled(_event, env) {
    const outcomes = await Promise.allSettled([
      triggerSync(env, "cloudflare-cron"),
      collectSportteryEvidence(env),
    ]);
    const labels = ["github-sync", "sporttery-collector"];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        console.error(JSON.stringify({
          event: "scheduled-task-failed",
          task: labels[index],
          error: outcome.reason?.message || String(outcome.reason),
        }));
      } else {
        console.log(JSON.stringify({ event: "scheduled-task-finished", task: labels[index], result: outcome.value }));
      }
    });
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        worker: "football-predict-sync-trigger",
        cron: "* * * * *; GitHub dispatch guarded by MIN_SECONDS_BETWEEN_DISPATCHES; Sporttery evidence generated on authenticated pull",
        api: ["/api/sync-meta", "/api/health", "/api/sporttery-evidence"],
        protectedDataPolicy: "C-end matches, odds, and model details are disabled here; use the protected Node /api/v1 service.",
        sportteryIndependentCollectorConfigured: sportteryCollectorConfigured(env),
        workflow: `${env.GITHUB_OWNER || "chen-1119"}/${env.GITHUB_REPO || "football-predict"}/${env.GITHUB_WORKFLOW_ID || "sync.yml"}`,
        checkedAt: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/health") {
      const config = readConfig(env);
      return json({
        ok: true,
        worker: "football-predict-sync-trigger",
        config: {
          minSecondsBetweenDispatches: config.recentRunSeconds,
          currentDataCacheSeconds: config.currentDataCacheSeconds,
          historyDataCacheSeconds: config.historyDataCacheSeconds,
          staleDataSeconds: config.staleDataSeconds,
          sportteryIndependentCollectorConfigured: sportteryCollectorConfigured(env)
        },
        checkedAt: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/sporttery-evidence") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (!await isAuthorizedManualTrigger(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      try {
        const evidence = await createSportteryEvidence(env);
        return json({
          ok: true,
          evidence: {
            version: evidence.version,
            capturedAt: evidence.capturedAt,
            sourceCycleId: evidence.sourceCycleId,
            endpoints: evidence.endpoints,
          },
          summary: {
            endpoints: evidence.endpoints.length,
            rows: evidence.endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
            errors: evidence.errors,
          },
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "sporttery-evidence-pull-failed",
          error: error?.message || String(error),
        }));
        return json({ ok: false, error: "sporttery evidence collection failed" }, 502);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return fetchPublicApi(env, url.pathname, ctx);
    }

    if (publicDataFileMap[resolveApiKey(`/api${url.pathname}`)]) {
      return fetchPublicApi(env, `/api${url.pathname}`, ctx);
    }

    if (url.pathname === "/trigger") {
      if (!await isAuthorizedManualTrigger(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      try {
        return json(await triggerSync(env, "cloudflare-manual"));
      } catch (error) {
        return json({ ok: false, error: error.message || String(error) }, 500);
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  }
};
