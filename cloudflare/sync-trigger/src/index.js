const DEFAULT_RECENT_RUN_SECONDS = 240;
const DEFAULT_PUBLIC_DATA_CACHE_SECONDS = 20;

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

const readConfig = (env) => ({
  owner: env.GITHUB_OWNER || "chen-1119",
  repo: env.GITHUB_REPO || "football-predict",
  workflowId: env.GITHUB_WORKFLOW_ID || "sync.yml",
  ref: env.GITHUB_REF || "main",
  recentRunSeconds: Number(env.MIN_SECONDS_BETWEEN_DISPATCHES || DEFAULT_RECENT_RUN_SECONDS),
  publicDataCacheSeconds: Number(env.PUBLIC_DATA_CACHE_SECONDS || DEFAULT_PUBLIC_DATA_CACHE_SECONDS)
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
  "sync-meta": "public/data/sync-meta.json",
  "matches/current": "public/data/matches-current.json",
  "matches/history": "public/data/matches-history.json",
  "matches/root": "public/matches.json",
  "odds/history": "public/data/odds-history.json",
  "predictions/snapshots": "public/data/prediction-snapshots.json",
  "model/calibration": "public/data/model-calibration.json",
  "teams/index": "public/data/team-index.json"
};

const rawGithubUrl = (config, filePath) => {
  const cacheBucket = Math.floor(Date.now() / Math.max(5, config.publicDataCacheSeconds) / 1000);
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.ref}/${filePath}?v=${cacheBucket}`;
};

const fetchPublicJson = async (env, filePath) => {
  const config = readConfig(env);
  const response = await fetch(rawGithubUrl(config, filePath), {
    headers: {
      "accept": "application/json",
      "user-agent": "football-predict-data-api"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: config.publicDataCacheSeconds
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Public data ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
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

const fetchPublicApi = async (env, pathname) => {
  const key = resolveApiKey(pathname);
  const filePath = publicDataFileMap[key];
  if (!filePath) return json({ ok: false, error: "unknown api resource", key }, 404);

  try {
    const payload = await fetchPublicJson(env, filePath);
    const directPayloadKeys = new Set(["sync-meta", "matches/current", "matches/history", "matches/root"]);
    if (directPayloadKeys.has(key)) {
      return json(payload);
    }
    return json(withApiMeta(payload, filePath));
  } catch (error) {
    if (key === "matches/current") {
      try {
        return json(await fetchPublicJson(env, publicDataFileMap["matches/root"]));
      } catch {
        // Preserve the original error below.
      }
    }
    return json({ ok: false, error: error.message || String(error), key }, 502);
  }
};

const isAuthorizedManualTrigger = (request, env) => {
  if (!env.MANUAL_TRIGGER_TOKEN) return false;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const auth = request.headers.get("authorization") || "";
  const bearerToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";

  return queryToken === env.MANUAL_TRIGGER_TOKEN || bearerToken === env.MANUAL_TRIGGER_TOKEN;
};

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      triggerSync(env, "cloudflare-cron").catch((error) => {
        console.error("Cloudflare cron dispatch failed:", error);
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        worker: "football-predict-sync-trigger",
        cron: "* * * * * guarded by MIN_SECONDS_BETWEEN_DISPATCHES",
        api: ["/api/sync-meta", "/api/matches/current", "/api/matches/history"],
        workflow: `${env.GITHUB_OWNER || "chen-1119"}/${env.GITHUB_REPO || "football-predict"}/${env.GITHUB_WORKFLOW_ID || "sync.yml"}`,
        checkedAt: new Date().toISOString()
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return fetchPublicApi(env, url.pathname);
    }

    if (publicDataFileMap[resolveApiKey(`/api${url.pathname}`)]) {
      return fetchPublicApi(env, `/api${url.pathname}`);
    }

    if (url.pathname === "/trigger") {
      if (!isAuthorizedManualTrigger(request, env)) {
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
