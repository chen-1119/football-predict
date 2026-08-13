const { boundedRuntimeEnv, boundedRuntimeNumber } = require("./boundedRuntimeNumber.cjs");

const CURRENT_METHODS = new Set(["current", "calculator"]);
const HISTORY_METHODS = new Set(["result", "all"]);
const RESULT_METHODS = new Set(["result"]);
const DEFAULT_MAX_FUTURE_SKEW_MINUTES = boundedRuntimeEnv(
  process.env,
  "TRUSTED_MAX_FUTURE_SKEW_SECONDS",
  { fallback: 300, min: 0, max: 3600 },
) / 60;

const asMethod = (endpoint) => String(endpoint?.method || endpoint?.id || "").trim().toLowerCase();

const rowsInRelayPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const rowsInEndpoint = (endpoint) => {
  const explicit = Number(endpoint?.rows);
  const payloadRows = rowsInRelayPayload(endpoint?.payload);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : payloadRows;
};

const endpointCapturedMs = (endpoint) => {
  for (const value of [endpoint?.fetchedAt, endpoint?.capturedAt, endpoint?.updatedAt]) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return time;
  }
  return NaN;
};

const usableEndpoint = (endpoint) => Boolean(endpoint?.payload)
  && endpoint?.ok !== false
  && rowsInEndpoint(endpoint) > 0;

const endpointPage = (endpoint) => {
  if (endpoint?.page === null || endpoint?.page === undefined || endpoint?.page === "") return 1;
  const page = Number(endpoint.page);
  return Number.isFinite(page) ? page : null;
};

const summarizeLane = (endpoints, options = {}) => {
  const usable = endpoints.filter(usableEndpoint);
  const times = usable.map(endpointCapturedMs).filter(Number.isFinite);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMinutes = boundedRuntimeNumber(options.maxAgeMinutes, {
    fallback: 20, min: 1, max: 30 * 24 * 60,
  });
  const maxFutureSkewMinutes = boundedRuntimeNumber(options.maxFutureSkewMinutes, {
    fallback: DEFAULT_MAX_FUTURE_SKEW_MINUTES, min: 0, max: 60,
  });
  const completenessTimeMs = times.length ? Math.min(...times) : NaN;
  const latestTimeMs = times.length ? Math.max(...times) : NaN;
  const rawAgeMinutes = Number.isFinite(completenessTimeMs)
    ? (nowMs - completenessTimeMs) / 60000
    : Infinity;
  const futureClock = times.some((time) => time > nowMs + maxFutureSkewMinutes * 60000);
  const ageMinutes = Number.isFinite(rawAgeMinutes) ? Math.max(0, rawAgeMinutes) : Infinity;
  return {
    capturedAt: Number.isFinite(completenessTimeMs) ? new Date(completenessTimeMs).toISOString() : null,
    latestCapturedAt: Number.isFinite(latestTimeMs) ? new Date(latestTimeMs).toISOString() : null,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
    maxAgeMinutes,
    maxFutureSkewMinutes,
    futureClock,
    stale: !Number.isFinite(ageMinutes) || futureClock || ageMinutes > maxAgeMinutes,
    rows: usable.reduce((sum, endpoint) => sum + rowsInEndpoint(endpoint), 0),
    usableEndpoints: usable.length,
    methods: Array.from(new Set(usable.map(asMethod).filter(Boolean))).sort(),
  };
};

const summarizeLatestLane = (endpoints, options = {}) => {
  const usable = endpoints.filter(usableEndpoint);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMinutes = boundedRuntimeNumber(options.maxAgeMinutes, {
    fallback: 20, min: 1, max: 30 * 24 * 60,
  });
  const maxFutureSkewMinutes = boundedRuntimeNumber(options.maxFutureSkewMinutes, {
    fallback: DEFAULT_MAX_FUTURE_SKEW_MINUTES, min: 0, max: 60,
  });
  const latestEndpoint = usable.reduce((selected, endpoint) => {
    const capturedMs = endpointCapturedMs(endpoint);
    if (!Number.isFinite(capturedMs)) return selected;
    if (!selected || capturedMs >= endpointCapturedMs(selected)) return endpoint;
    return selected;
  }, null);
  const latestTimeMs = endpointCapturedMs(latestEndpoint);
  const latestEndpoints = latestEndpoint ? [latestEndpoint] : [];
  const rawAgeMinutes = Number.isFinite(latestTimeMs)
    ? (nowMs - latestTimeMs) / 60000
    : Infinity;
  const futureClock = Number.isFinite(latestTimeMs)
    && latestTimeMs > nowMs + maxFutureSkewMinutes * 60000;
  const ageMinutes = Number.isFinite(rawAgeMinutes) ? Math.max(0, rawAgeMinutes) : Infinity;
  const capturedAt = Number.isFinite(latestTimeMs) ? new Date(latestTimeMs).toISOString() : null;
  return {
    capturedAt,
    latestCapturedAt: capturedAt,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
    maxAgeMinutes,
    maxFutureSkewMinutes,
    futureClock,
    stale: !Number.isFinite(ageMinutes) || futureClock || ageMinutes > maxAgeMinutes,
    rows: latestEndpoints.reduce((sum, endpoint) => sum + rowsInEndpoint(endpoint), 0),
    usableEndpoints: latestEndpoints.length,
    methods: Array.from(new Set(latestEndpoints.map(asMethod).filter(Boolean))).sort(),
  };
};

const summarizeRelayLanes = (snapshot, options = {}) => {
  const endpoints = Array.isArray(snapshot?.endpoints)
    ? snapshot.endpoints
    : Array.isArray(snapshot?.payloads)
      ? snapshot.payloads
      : [];
  const currentEndpoints = endpoints.filter((endpoint) => CURRENT_METHODS.has(asMethod(endpoint)));
  const fullEndpoints = endpoints.filter((endpoint) => !CURRENT_METHODS.has(asMethod(endpoint)));
  const explicitHistoryEndpoints = fullEndpoints.filter((endpoint) => HISTORY_METHODS.has(asMethod(endpoint)));
  const historyEndpoints = explicitHistoryEndpoints.length > 0 ? explicitHistoryEndpoints : fullEndpoints;
  const resultEndpoints = endpoints.filter((endpoint) => (
    RESULT_METHODS.has(asMethod(endpoint)) && endpointPage(endpoint) === 1
  ));
  const currentMaxAgeMinutes = boundedRuntimeNumber(options.currentMaxAgeMinutes, {
    fallback: 20, min: 1, max: 30 * 24 * 60,
  });
  const historyMaxAgeMinutes = boundedRuntimeNumber(options.historyMaxAgeMinutes, {
    fallback: 180, min: currentMaxAgeMinutes, max: 30 * 24 * 60,
  });
  const maxFutureSkewMinutes = boundedRuntimeNumber(options.maxFutureSkewMinutes, {
    fallback: DEFAULT_MAX_FUTURE_SKEW_MINUTES, min: 0, max: 60,
  });
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return {
    current: summarizeLane(currentEndpoints, { nowMs, maxAgeMinutes: currentMaxAgeMinutes, maxFutureSkewMinutes }),
    result: summarizeLatestLane(resultEndpoints, { nowMs, maxAgeMinutes: currentMaxAgeMinutes, maxFutureSkewMinutes }),
    full: summarizeLane(fullEndpoints, { nowMs, maxAgeMinutes: historyMaxAgeMinutes, maxFutureSkewMinutes }),
    history: summarizeLane(historyEndpoints, { nowMs, maxAgeMinutes: historyMaxAgeMinutes, maxFutureSkewMinutes }),
  };
};

module.exports = {
  CURRENT_METHODS,
  HISTORY_METHODS,
  RESULT_METHODS,
  endpointCapturedMs,
  endpointPage,
  rowsInEndpoint,
  summarizeRelayLanes,
  usableEndpoint,
};
