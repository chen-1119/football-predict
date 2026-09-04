"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  PROVIDERS,
  createOpenResearchGateway,
} = require("../server/openResearchGateway.cjs");

const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.join(rootDir, "server-data");

const CURRENT_MATCHES_FILE = path.join(dataDir, "matches-current.json");
const EXTERNAL_SIGNALS_FILE = path.join(dataDir, "external-signals.json");
const INSIGHTS_OUTPUT_FILE = path.join(serverDataDir, "web-consensus", "open-research-insights.json");
const DEFAULT_CACHE_DIR = path.join(serverDataDir, "open-research", "cache");

const ACCESS_STATUSES = Object.freeze(["open", "metadata_only", "restricted", "unknown"]);
const ACCESS_STATUS_SET = new Set(ACCESS_STATUSES);
const PROVIDER_SET = new Set(PROVIDERS);
const TERMINAL_STATUSES = new Set([
  "FINISHED",
  "FT",
  "AET",
  "PEN",
  "CANCELLED",
  "CANCELED",
  "POSTPONED",
  "ABANDONED",
  "SUSPENDED",
]);

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
};

const parseDateTime = (value) => {
  const text = norm(value);
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  return Date.parse(normalized);
};

const isoOrNull = (value) => {
  const parsed = parseDateTime(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const readJson = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[syncOpenResearchSignals] failed to read ${filePath}: ${error.message}`);
    return fallback;
  }
};

const atomicWriteJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // New server-side research artifacts are private by default.
  }
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* best-effort cleanup */ }
    }
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Cleanup must not mask the publication error.
    }
  }
};

const sourceMatchId = (match) => norm(
  match?.sourceMatchId
  || match?.externalSignals?.sourceMatchId
  || norm(match?.id).replace(/^sporttery_/, "")
);

const teamDateKey = (match) => [
  norm(match?.homeTeamName || match?.homeTeamNameEn).toLowerCase(),
  norm(match?.awayTeamName || match?.awayTeamNameEn).toLowerCase(),
  norm(match?.kickoffTime).slice(0, 10),
].filter(Boolean).join("__");

const matchKeys = (match) => Array.from(new Set([
  sourceMatchId(match),
  norm(match?.id),
  norm(match?.matchNo),
  teamDateKey(match),
].filter(Boolean)));

const cutoffForMatch = (match) => (
  match?.buyEndTime
  || match?.predictionMeta?.cutoffTime
  || match?.externalSignals?.buyEndTime
  || match?.externalSignals?.predictionMeta?.cutoffTime
  || match?.kickoffTime
);

const eligibleMatches = (matches, { nowMs, maxMatches, lookaheadHours }) => {
  const lookaheadMs = lookaheadHours * 60 * 60_000;
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => {
      const status = norm(match?.status).toUpperCase();
      if (TERMINAL_STATUSES.has(status)) return false;
      const kickoffMs = parseDateTime(match?.kickoffTime);
      const cutoffMs = parseDateTime(cutoffForMatch(match));
      return Number.isFinite(kickoffMs)
        && kickoffMs > nowMs
        && kickoffMs <= nowMs + lookaheadMs
        && Number.isFinite(cutoffMs)
        && cutoffMs >= nowMs;
    })
    .sort((left, right) => parseDateTime(left.kickoffTime) - parseDateTime(right.kickoffTime))
    .slice(0, maxMatches);
};

const safePublicTerm = (value) => norm(value)
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/https?:\/\/\S+/gi, " ")
  .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, " ")
  .replace(/[<>`{}[\]\\|]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 80);

const buildMatchQuery = (match) => {
  const home = safePublicTerm(match?.homeTeamNameEn || match?.homeTeamName || match?.homeTeamId);
  const away = safePublicTerm(match?.awayTeamNameEn || match?.awayTeamName || match?.awayTeamId);
  const league = safePublicTerm(match?.leagueNameEn || match?.leagueName || match?.externalSignals?.leagueName);
  return [home, away, league, "football"].filter(Boolean).join(" ").slice(0, 256);
};

const safeProviderReports = (reports) => (Array.isArray(reports) ? reports : [])
  .map((report) => ({
    provider: PROVIDER_SET.has(norm(report?.provider).toLowerCase())
      ? norm(report.provider).toLowerCase()
      : "unknown",
    status: ["success", "error", "disabled", "skipped"].includes(norm(report?.status).toLowerCase())
      ? norm(report.status).toLowerCase()
      : "error",
    resultCount: boundedInteger(report?.resultCount, 0, 0, 10_000),
    durationMs: boundedInteger(report?.durationMs, 0, 0, 60_000),
  }))
  .slice(0, PROVIDERS.length);

const safeAccessStatuses = (statuses) => {
  const counts = new Map(ACCESS_STATUSES.map((status) => [status, 0]));
  for (const item of Array.isArray(statuses) ? statuses : []) {
    const status = norm(item?.accessStatus).toLowerCase();
    if (ACCESS_STATUS_SET.has(status)) {
      counts.set(status, boundedInteger(item?.resultCount, 0, 0, 10_000));
    }
  }
  return ACCESS_STATUSES.map((accessStatus) => ({
    accessStatus,
    resultCount: counts.get(accessStatus) || 0,
  }));
};

const safeHash = (value, fallback = null) => {
  const hash = norm(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : fallback;
};

const buildOpenResearchSummary = (response, updatedAt) => {
  const safe = response?.aiSafe && typeof response.aiSafe === "object" ? response.aiSafe : {};
  const observedAt = isoOrNull(safe.generatedAt || response?.generatedAt) || updatedAt;
  const providers = safeProviderReports(safe.providers || response?.providerReports);
  const resultHashes = (Array.isArray(safe.resultHashes) ? safe.resultHashes : [])
    .map((hash) => safeHash(hash))
    .filter(Boolean)
    .slice(0, 100);
  const accessStatuses = safeAccessStatuses(safe.accessStatuses);
  const resultCount = accessStatuses.reduce((total, item) => total + item.resultCount, 0);
  const requestHash = safeHash(safe.requestHash || response?.requestHash, sha256("open-research-request-unavailable"));
  const resultSetHash = safeHash(safe.resultSetHash, sha256(resultHashes.sort().join("|")));
  return {
    version: "open-research-match-summary-v1",
    updatedAt: observedAt,
    generatedAt: observedAt,
    requestHash,
    resultSetHash,
    counts: {
      resultCount,
      providerCount: providers.length,
      failureCount: providers.filter((provider) => provider.status === "error").length,
      cacheHitCount: response?.cache?.hit === true ? 1 : boundedInteger(safe?.counts?.cacheHitCount, 0, 0, 1),
    },
    providers,
    accessStatuses,
    resultHashes,
  };
};

const failedOpenResearchSummary = ({ query, updatedAt, durationMs = 0 }) => ({
  version: "open-research-match-summary-v1",
  updatedAt,
  generatedAt: updatedAt,
  requestHash: sha256(`open-research:${query}`),
  resultSetHash: sha256(""),
  counts: {
    resultCount: 0,
    providerCount: 1,
    failureCount: 1,
    cacheHitCount: 0,
  },
  providers: [{ provider: "unknown", status: "error", resultCount: 0, durationMs }],
  accessStatuses: ACCESS_STATUSES.map((accessStatus) => ({ accessStatus, resultCount: 0 })),
  resultHashes: [],
});

const sourceLicenseForResult = (result, providers) => {
  const wikipedia = providers.some((provider) => provider.startsWith("wikipedia-"));
  const ccBySa = wikipedia && /^CC BY-SA\b/i.test(norm(result?.license));
  return ccBySa
    ? {
      retrievalAllowed: true,
      storagePolicy: "metadata-only",
      redistributionAllowed: true,
      termsUrl: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use",
    }
    : {
      retrievalAllowed: false,
      storagePolicy: "metadata-only",
      redistributionAllowed: false,
      termsUrl: null,
    };
};

const insightSourceItems = (results, { matchUuid, capturedAt }) => (Array.isArray(results) ? results : [])
  .map((result) => {
    const providers = Array.isArray(result?.providers)
      ? result.providers.map((provider) => norm(provider).toLowerCase()).filter((provider) => PROVIDER_SET.has(provider))
      : [];
    const accessStatus = ACCESS_STATUS_SET.has(norm(result?.accessStatus).toLowerCase())
      ? norm(result.accessStatus).toLowerCase()
      : "unknown";
    const resultHash = safeHash(result?.id);
    const name = norm(result?.title || result?.source).slice(0, 500);
    const url = norm(result?.url).slice(0, 2_048);
    if (!name && !url) return null;
    return {
      name,
      url,
      matchUuid,
      publisherOwner: norm(result?.source || providers[0] || "unknown").slice(0, 300),
      publishedAt: isoOrNull(result?.publishedAt),
      ingestedAt: capturedAt,
      extractedAt: capturedAt,
      factCategory: "open-research-discovery-metadata",
      extractedFact: "",
      rawSnippet: "",
      riskDowngrade: `audit-only:${accessStatus}`,
      sourceLicense: sourceLicenseForResult(result, providers),
      rawSha256: null,
      discoveryHash: resultHash,
    };
  })
  .filter(Boolean)
  .slice(0, 25);

const insightForMatch = ({ match, response, summary }) => {
  const matchUuid = sourceMatchId(match) || norm(match?.id);
  return {
    version: "open-research-insight-v1",
    source: "open-research-gateway",
    sourceMatchId: matchUuid,
    matchId: norm(match?.id) || null,
    matchNo: norm(match?.matchNo) || null,
    kickoffTime: isoOrNull(match?.kickoffTime),
    cutoffTime: isoOrNull(cutoffForMatch(match)),
    homeTeamName: norm(match?.homeTeamName || match?.homeTeamNameEn) || null,
    awayTeamName: norm(match?.awayTeamName || match?.awayTeamNameEn) || null,
    capturedAt: summary.generatedAt,
    usableForModel: false,
    eligibleForNumericModel: false,
    eligibleForFormalQuality: false,
    eligibleForStrategyGate: false,
    advisoryPolicy: "audit-only",
    sourceItems: insightSourceItems(response?.results, {
      matchUuid,
      capturedAt: summary.generatedAt,
    }),
  };
};

const appendSource = (value, source) => Array.from(new Set(
  norm(value || "external-signals").split("+").concat(source).map(norm).filter(Boolean)
)).join("+");

const mergeMatchSummary = ({ externalMatches, match, summary, updatedAt }) => {
  const aliases = matchKeys(match);
  const primaryKey = aliases.find((key) => externalMatches[key]) || sourceMatchId(match) || aliases[0];
  if (!primaryKey) return false;
  const existing = externalMatches[primaryKey] && typeof externalMatches[primaryKey] === "object"
    ? externalMatches[primaryKey]
    : {};
  externalMatches[primaryKey] = {
    ...existing,
    source: appendSource(existing.source, "open-research"),
    updatedAt,
    openResearch: summary,
  };
  return true;
};

const configuredProviders = (value) => {
  const providers = norm(value).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!providers.length) return undefined;
  return Array.from(new Set(providers.filter((provider) => PROVIDER_SET.has(provider))));
};

const createConfiguredGateway = ({ cacheDir, resultLimit }) => createOpenResearchGateway({
  cacheDir,
  maxLimit: resultLimit,
  timeoutMs: boundedInteger(process.env.OPEN_RESEARCH_TIMEOUT_MS, 7_000, 250, 60_000),
  cacheTtlMs: boundedInteger(
    Number(process.env.OPEN_RESEARCH_CACHE_TTL_MINUTES) * 60_000,
    30 * 60_000,
    60_000,
    24 * 60 * 60_000
  ),
  unpaywallEmail: process.env.OPEN_RESEARCH_UNPAYWALL_EMAIL || process.env.UNPAYWALL_EMAIL || null,
  crossrefEmail: process.env.OPEN_RESEARCH_CONTACT_EMAIL
    || process.env.OPEN_RESEARCH_CROSSREF_EMAIL
    || process.env.CROSSREF_EMAIL
    || null,
  contactUrl: process.env.OPEN_RESEARCH_CONTACT_URL || null,
  searxngBaseUrl: process.env.OPEN_RESEARCH_SEARXNG_BASE_URL || process.env.SEARXNG_BASE_URL || null,
});

const syncOpenResearchSignals = async (options = {}) => {
  const nowMs = Number(typeof options.now === "function" ? options.now() : Date.now());
  const updatedAt = new Date(nowMs).toISOString();
  const currentMatchesFile = options.currentMatchesFile || CURRENT_MATCHES_FILE;
  const externalSignalsFile = options.externalSignalsFile || EXTERNAL_SIGNALS_FILE;
  const insightsOutputFile = options.insightsOutputFile || INSIGHTS_OUTPUT_FILE;
  const maxMatches = boundedInteger(
    options.maxMatches ?? process.env.OPEN_RESEARCH_MAX_MATCHES,
    4,
    1,
    20
  );
  const lookaheadHours = boundedInteger(
    options.lookaheadHours ?? process.env.OPEN_RESEARCH_LOOKAHEAD_HOURS,
    72,
    1,
    24 * 14
  );
  const resultLimit = boundedInteger(
    options.resultLimit ?? process.env.OPEN_RESEARCH_MAX_RESULTS ?? process.env.OPEN_RESEARCH_RESULT_LIMIT,
    8,
    1,
    25
  );
  const refreshMinutes = boundedInteger(
    options.refreshMinutes ?? process.env.OPEN_RESEARCH_REFRESH_MINUTES ?? process.env.OPEN_RESEARCH_CACHE_TTL_MINUTES,
    30,
    1,
    24 * 60
  );
  const providers = options.providers || configuredProviders(process.env.OPEN_RESEARCH_MATCH_PROVIDERS);
  const gateway = options.gateway || createConfiguredGateway({
    cacheDir: options.cacheDir || process.env.OPEN_RESEARCH_CACHE_DIR || DEFAULT_CACHE_DIR,
    resultLimit,
  });
  const matches = readJson(currentMatchesFile, []);
  const external = readJson(externalSignalsFile, {
    version: 1,
    source: "external-signals",
    matches: {},
    sources: {},
  });
  const selected = eligibleMatches(matches, { nowMs, maxMatches, lookaheadHours });
  const externalMatches = { ...(external?.matches || {}) };
  const previousInsightOutput = readJson(insightsOutputFile, { rows: [], summary: {} });
  const previousInsights = Array.isArray(previousInsightOutput?.rows) ? previousInsightOutput.rows : [];
  const insightByMatchKey = new Map();
  for (const insight of previousInsights) {
    for (const key of [norm(insight?.sourceMatchId), norm(insight?.matchId)].filter(Boolean)) {
      if (!insightByMatchKey.has(key)) insightByMatchKey.set(key, insight);
    }
  }
  const existingExternalForMatch = (match) => {
    const key = matchKeys(match).find((candidate) => externalMatches[candidate]);
    return key ? externalMatches[key] : null;
  };
  const previousInsightForMatch = (match) => matchKeys(match)
    .map((key) => insightByMatchKey.get(key))
    .find(Boolean) || null;
  const refreshMs = refreshMinutes * 60_000;
  const dueMatches = selected.filter((match) => {
    const summary = existingExternalForMatch(match)?.openResearch;
    const observedMs = parseDateTime(summary?.generatedAt || summary?.updatedAt);
    const providerCount = boundedInteger(summary?.counts?.providerCount, 0, 0, 100);
    const failureCount = boundedInteger(summary?.counts?.failureCount, 0, 0, 100);
    const resultCount = boundedInteger(summary?.counts?.resultCount, 0, 0, 100_000);
    const exhausted = providerCount > 0 && failureCount >= providerCount && resultCount === 0;
    const freshnessWindowMs = exhausted ? Math.min(refreshMs, 5 * 60_000) : refreshMs;
    const fresh = summary?.version === "open-research-match-summary-v1"
      && Number.isFinite(observedMs)
      && observedMs <= nowMs
      && nowMs - observedMs < freshnessWindowMs;
    return !fresh || !previousInsightForMatch(match);
  });
  if (!dueMatches.length) {
    return {
      ok: true,
      skipped: true,
      reason: selected.length ? "open-research-fresh" : "no-eligible-upcoming-matches",
      updatedAt: external?.sources?.openResearch?.updatedAt || previousInsightOutput?.updatedAt || null,
      output: path.relative(rootDir, insightsOutputFile),
      selectedMatches: selected.length,
      refreshedMatches: 0,
      resultCount: boundedInteger(previousInsightOutput?.summary?.resultCount, 0, 0, 100_000),
      partialCount: 0,
      failedCount: 0,
      cacheHitCount: 0,
      advisoryOnly: selected.length,
      numericEligible: 0,
    };
  }
  let partialCount = 0;
  let failedCount = 0;
  let cacheHitCount = 0;

  for (const match of dueMatches) {
    const query = buildMatchQuery(match);
    const startedAt = Date.now();
    let response;
    let summary;
    try {
      response = await gateway.search({
        query,
        limit: resultLimit,
        ...(providers?.length ? { providers } : {}),
      });
      summary = buildOpenResearchSummary(response, updatedAt);
      if (response?.partial === true) partialCount += 1;
      if (response?.ok !== true) failedCount += 1;
      if (response?.cache?.hit === true) cacheHitCount += 1;
    } catch {
      failedCount += 1;
      summary = failedOpenResearchSummary({
        query,
        updatedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      response = { results: [] };
    }
    mergeMatchSummary({ externalMatches, match, summary, updatedAt });
    const insight = insightForMatch({ match, response, summary });
    for (const key of [norm(insight.sourceMatchId), norm(insight.matchId)].filter(Boolean)) {
      insightByMatchKey.set(key, insight);
    }
  }

  const insights = selected
    .map((match) => previousInsightForMatch(match))
    .filter(Boolean);

  const insightOutput = {
    version: "open-research-insights-v1",
    source: "open-research-gateway",
    updatedAt,
    count: insights.length,
    rows: insights,
    summary: {
      selectedMatches: selected.length,
      refreshedMatches: dueMatches.length,
      resultCount: insights.reduce((total, insight) => total + insight.sourceItems.length, 0),
      partialCount,
      failedCount,
      cacheHitCount,
      advisoryOnly: insights.length,
      numericEligible: 0,
    },
  };
  const nextExternal = {
    ...external,
    version: external?.version || 1,
    source: appendSource(external?.source, "open-research"),
    updatedAt,
    count: Object.keys(externalMatches).length,
    matches: externalMatches,
    sources: {
      ...(external?.sources || {}),
      openResearch: {
        updatedAt,
        rows: insights.length,
        resultCount: insightOutput.summary.resultCount,
        partialCount,
        failedCount,
        cacheHitCount,
        numericEligible: 0,
      },
    },
  };

  atomicWriteJson(insightsOutputFile, insightOutput);
  atomicWriteJson(externalSignalsFile, nextExternal);
  return {
    ok: true,
    updatedAt,
    output: path.relative(rootDir, insightsOutputFile),
    ...insightOutput.summary,
  };
};

const argumentValue = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const manualSearch = async (args) => {
  const query = argumentValue(args, "--query");
  const doi = argumentValue(args, "--doi");
  const resultLimit = boundedInteger(argumentValue(args, "--limit"), 8, 1, 25);
  const providers = configuredProviders(argumentValue(args, "--providers"));
  const gateway = createConfiguredGateway({
    cacheDir: process.env.OPEN_RESEARCH_CACHE_DIR || DEFAULT_CACHE_DIR,
    resultLimit,
  });
  const response = await gateway.search({
    ...(query ? { query } : {}),
    ...(doi ? { doi } : {}),
    limit: resultLimit,
    ...(providers?.length ? { providers } : {}),
  });
  return {
    ok: response.ok === true,
    partial: response.partial === true,
    cache: response.cache,
    aiSafe: buildOpenResearchSummary(response, new Date().toISOString()),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const result = args.includes("--query") || args.includes("--doi")
    ? await manualSearch(args)
    : await syncOpenResearchSignals();
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: norm(error?.code) || "OPEN_RESEARCH_SYNC_FAILED",
      message: norm(error?.message) || "open research sync failed",
    }));
    process.exitCode = 1;
  });
} else {
  module.exports = {
    buildMatchQuery,
    buildOpenResearchSummary,
    eligibleMatches,
    insightForMatch,
    syncOpenResearchSignals,
  };
}
