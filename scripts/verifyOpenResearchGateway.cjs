"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createOpenResearchGateway,
  validateSearxngBaseUrl,
} = require("../server/openResearchGateway.cjs");
const { syncOpenResearchSignals } = require("./syncOpenResearchSignals.cjs");

const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

const caughtCode = async (operation) => {
  try {
    await operation();
    return null;
  } catch (error) {
    return error?.code || error?.name || "ERROR";
  }
};

const exactKeys = (value, expected) => value && typeof value === "object"
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.slice().sort());

const run = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-open-research-"));
  try {
    let unsafeSearxCode = null;
    try {
      validateSearxngBaseUrl("http://169.254.169.254/search");
    } catch (error) {
      unsafeSearxCode = error?.code;
    }
    check("SearXNG rejects remote plaintext HTTP", unsafeSearxCode === "UNSAFE_SEARXNG_URL", { unsafeSearxCode });
    let privateHttpsCode = null;
    try {
      validateSearxngBaseUrl("https://169.254.169.254/latest/meta-data");
    } catch (error) {
      privateHttpsCode = error?.code;
    }
    check("SearXNG rejects private or link-local HTTPS literals", privateHttpsCode === "UNSAFE_SEARXNG_URL", { privateHttpsCode });
    check("SearXNG permits explicit loopback HTTP", (
      validateSearxngBaseUrl("http://127.0.0.1:8080") === "http://127.0.0.1:8080/search"
      && validateSearxngBaseUrl("http://[::1]:8080/searx") === "http://[::1]:8080/searx/search"
    ));
    check("SearXNG permits HTTPS and fixes its search path", (
      validateSearxngBaseUrl("https://search.example.org/searx/") === "https://search.example.org/searx/search"
    ));

    const rejectedCalls = [];
    const rejectingGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "reject-cache"),
      fetchImpl: async (url) => {
        rejectedCalls.push(String(url));
        return jsonResponse({});
      },
    });
    const arbitraryFieldCode = await caughtCode(() => rejectingGateway.search({
      url: "http://169.254.169.254/latest/meta-data",
    }));
    const urlQueryCode = await caughtCode(() => rejectingGateway.search({
      query: "http://127.0.0.1:9000/private",
    }));
    const doiUrlCode = await caughtCode(() => rejectingGateway.search({
      doi: "https://doi.org/10.1234/test",
    }));
    check("gateway accepts query or bare DOI but never an arbitrary fetch URL", (
      arbitraryFieldCode === "UNSUPPORTED_REQUEST_FIELD"
      && urlQueryCode === "URL_QUERY_REJECTED"
      && doiUrlCode === "INVALID_DOI"
      && rejectedCalls.length === 0
    ), { arbitraryFieldCode, urlQueryCode, doiUrlCode, fetchCalls: rejectedCalls.length });
    const invalidContactCode = await caughtCode(async () => createOpenResearchGateway({
      cacheDir: path.join(tempDir, "invalid-contact-cache"),
      contactUrl: "https://research.example.org/\r\nX-Injected: yes",
      fetchImpl: async () => jsonResponse({}),
    }));
    check("research contact identity rejects header injection", invalidContactCode === "INVALID_CONTACT_URL", { invalidContactCode });

    const calls = [];
    const rawQuery = "private-fixture-query-7319";
    const rawWikiSnippet = "WIKI_SNIPPET_SECRET_7319";
    const rawAbstract = "CROSSREF_PAYWALLED_ABSTRACT_SECRET_7319";
    const rawSearxContent = "SEARX_EXTRACTED_CONTENT_SECRET_7319";
    const paidArticleUrl = "https://paid.example/article?id=91&utm_source=fixture";
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      calls.push({
        url: parsed.toString(),
        redirect: init?.redirect,
        method: init?.method,
        userAgent: init?.headers?.["user-agent"],
        apiUserAgent: init?.headers?.["api-user-agent"],
      });
      if (parsed.hostname === "zh.wikipedia.org") {
        return jsonResponse({ query: { search: [{
          pageid: 1,
          title: "中文开放条目",
          snippet: `<span>${rawWikiSnippet}</span>`,
          timestamp: "2026-07-16T08:00:00Z",
        }] } });
      }
      if (parsed.hostname === "en.wikipedia.org") {
        return jsonResponse({ query: { search: [{
          pageid: 2,
          title: "Open encyclopedia item",
          snippet: "OPEN_ENGLISH_SNIPPET",
          timestamp: "2026-07-16T08:01:00Z",
        }] } });
      }
      if (parsed.hostname === "api.gdeltproject.org") {
        return jsonResponse({ articles: [{
          title: "Indexed paid news title",
          url: paidArticleUrl,
          seendate: "2026-07-16T08:02:00Z",
          domain: "paid.example",
          body: "GDELT_BODY_MUST_NOT_ESCAPE",
        }] });
      }
      if (parsed.hostname === "api.crossref.org") {
        return jsonResponse({ message: {
          DOI: "10.1234/open-fixture",
          title: ["Shared scholarly work"],
          abstract: rawAbstract,
          URL: "https://publisher.example/paywall/open-fixture",
          type: "journal-article",
          publisher: "Fixture Publisher",
          issued: { "date-parts": [[2026, 7, 1]] },
          author: [{ given: "Test", family: "Author" }],
        } });
      }
      if (parsed.hostname === "api.unpaywall.org") {
        return jsonResponse({
          doi: "10.1234/open-fixture",
          title: "Shared scholarly work",
          is_oa: true,
          oa_status: "gold",
          best_oa_location: {
            url_for_pdf: "https://repository.example/legal-open-copy.pdf",
            license: "cc-by",
            host_type: "repository",
          },
        });
      }
      if (parsed.hostname === "search.example.org") {
        return jsonResponse({ results: [{
          title: "Search discovery metadata",
          url: "https://search-result.example/page?utm_medium=test",
          content: rawSearxContent,
          engine: "fixture-engine",
        }] });
      }
      throw new Error(`unexpected fetch target: ${parsed.hostname}`);
    };

    let nowMs = Date.parse("2026-07-17T00:00:00Z");
    const cacheDir = path.join(tempDir, "cache");
    const gateway = createOpenResearchGateway({
      cacheDir,
      cacheTtlMs: 1_000,
      timeoutMs: 100,
      now: () => nowMs,
      fetchImpl,
      unpaywallEmail: "research@example.org",
      contactUrl: "https://research.example.org/open-research",
      searxngBaseUrl: "https://search.example.org/searx",
    });
    const request = {
      query: rawQuery,
      doi: "10.1234/open-fixture",
      limit: 10,
      providers: ["wikipedia-zh", "wikipedia-en", "gdelt", "crossref", "unpaywall", "searxng"],
    };
    const first = await gateway.search(request);
    const firstCallCount = calls.length;
    check("all provider adapters use fixed GET JSON endpoints with redirects disabled", (
      firstCallCount === 6
      && calls.every((call) => call.method === "GET" && call.redirect === "error")
      && calls.every((call) => call.userAgent.includes("https://research.example.org/open-research"))
      && calls.every((call) => call.apiUserAgent === call.userAgent)
      && calls.every((call) => [
        "zh.wikipedia.org",
        "en.wikipedia.org",
        "api.gdeltproject.org",
        "api.crossref.org",
        "api.unpaywall.org",
        "search.example.org",
      ].includes(new URL(call.url).hostname))
      && !calls.some((call) => call.url.startsWith(paidArticleUrl))
    ), { firstCallCount, hosts: calls.map((call) => new URL(call.url).hostname) });

    const shared = first.results.find((result) => result.doi === "10.1234/open-fixture");
    check("Crossref and Unpaywall records are normalized and deduplicated by DOI", (
      first.ok === true
      && first.partial === false
      && shared?.accessStatus === "open"
      && shared?.url === "https://repository.example/legal-open-copy.pdf"
      && JSON.stringify(shared?.providers) === JSON.stringify(["crossref", "unpaywall"])
      && first.results.length === 5
    ), { resultCount: first.results.length, sharedProviders: shared?.providers || [] });

    const serializedResults = JSON.stringify(first.results);
    const nonOpenRows = first.results.filter((result) => result.accessStatus !== "open");
    check("paid or access-unknown sources expose discovery metadata only", (
      nonOpenRows.length === 2
      && nonOpenRows.every((result) => !("snippet" in result))
      && !serializedResults.includes(rawAbstract)
      && !serializedResults.includes(rawSearxContent)
      && !serializedResults.includes("GDELT_BODY_MUST_NOT_ESCAPE")
      && serializedResults.includes("https://paid.example/article?id=91")
      && !serializedResults.includes("utm_source")
    ), { nonOpenCount: nonOpenRows.length });

    const safe = first.aiSafe;
    const safeJson = JSON.stringify(safe);
    check("AI-safe summary has only hashes, counts, times, providers, and access statuses", (
      exactKeys(safe, ["requestHash", "resultSetHash", "generatedAt", "expiresAt", "counts", "providers", "accessStatuses", "resultHashes"])
      && exactKeys(safe.counts, ["resultCount", "providerCount", "failureCount", "cacheHitCount"])
      && safe.providers.every((entry) => exactKeys(entry, ["provider", "status", "resultCount", "durationMs"]))
      && safe.accessStatuses.every((entry) => exactKeys(entry, ["accessStatus", "resultCount"]))
      && !safeJson.includes(rawQuery)
      && !safeJson.includes(rawWikiSnippet)
      && !safeJson.includes(rawAbstract)
      && !safeJson.includes(rawSearxContent)
      && !first.results.some((result) => safeJson.includes(result.title) || (result.url && safeJson.includes(result.url)))
    ), { safeKeys: Object.keys(safe) });

    const second = await gateway.search(request);
    const cacheFiles = fs.readdirSync(cacheDir);
    const cacheText = fs.readFileSync(path.join(cacheDir, cacheFiles.find((name) => name.endsWith(".json"))), "utf8");
    check("fresh cache prevents repeat provider fetches and publishes atomically", (
      second.cache?.hit === true
      && second.aiSafe?.counts?.cacheHitCount === 1
      && calls.length === firstCallCount
      && cacheFiles.filter((name) => name.endsWith(".json")).length === 1
      && !cacheFiles.some((name) => name.endsWith(".tmp"))
      && !cacheText.includes(rawQuery)
    ), { cacheFiles, fetchCalls: calls.length });

    nowMs += 1_001;
    const expired = await gateway.search(request);
    check("expired cache is refreshed after TTL", expired.cache?.hit === false && calls.length === firstCallCount * 2, {
      fetchCalls: calls.length,
    });

    const defaultCalls = [];
    const defaultGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "default-cache"),
      cacheTtlMs: 1_000,
      timeoutMs: 100,
      fetchImpl: async (...args) => {
        defaultCalls.push(new URL(args[0]).hostname);
        return fetchImpl(...args);
      },
      contactUrl: "https://research.example.org/open-research",
    });
    const defaultFirst = await defaultGateway.search({ query: "stable default fixture", limit: 3 });
    const defaultCallCount = defaultCalls.length;
    const defaultSecond = await defaultGateway.search({ query: "stable default fixture", limit: 3 });
    check("default query excludes latency-sensitive GDELT while explicit GDELT remains supported", (
      defaultFirst.ok === true
      && defaultFirst.partial === false
      && defaultFirst.providerReports.map((report) => report.provider).join(",") === "wikipedia-zh,wikipedia-en,crossref"
      && !defaultCalls.includes("api.gdeltproject.org")
      && defaultSecond.cache?.hit === true
      && defaultCalls.length === defaultCallCount
    ), { defaultCalls, providerReports: defaultFirst.providerReports });

    const partialCalls = [];
    const partialGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "partial-cache"),
      timeoutMs: 50,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        partialCalls.push(parsed.hostname);
        if (parsed.hostname === "zh.wikipedia.org") {
          return jsonResponse({ query: { search: [{ title: "Surviving open result", snippet: "safe" }] } });
        }
        return jsonResponse({ error: "temporary" }, 503);
      },
    });
    const partial = await partialGateway.search({
      query: "partial failure fixture",
      providers: ["wikipedia-zh", "gdelt"],
      limit: 3,
    });
    check("one provider outage returns useful results as an explicit partial failure", (
      partial.ok === true
      && partial.partial === true
      && partial.results.length === 1
      && partial.providerReports.find((report) => report.provider === "gdelt")?.errorCode === "PROVIDER_HTTP_ERROR"
      && partial.aiSafe?.counts?.failureCount === 1
      && !fs.existsSync(path.join(tempDir, "partial-cache"))
    ), { providerReports: partial.providerReports });

    const timeoutGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "timeout-cache"),
      timeoutMs: 15,
      fetchImpl: async () => new Promise(() => {}),
    });
    const timedOut = await timeoutGateway.search({ query: "timeout fixture", providers: ["gdelt"], limit: 1 });
    check("provider timeout is bounded and reported without throwing raw network text", (
      timedOut.ok === false
      && timedOut.partial === true
      && timedOut.providerReports[0]?.errorCode === "PROVIDER_TIMEOUT"
      && timedOut.results.length === 0
    ), { providerReports: timedOut.providerReports });

    const restrictedGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "restricted-cache"),
      unpaywallEmail: "research@example.org",
      fetchImpl: async () => jsonResponse({
        doi: "10.5555/closed",
        title: "Closed fixture metadata",
        is_oa: false,
        best_oa_location: { url_for_pdf: "https://publisher.example/paid.pdf", license: "closed" },
        raw: "PAYWALL_BODY_MUST_NOT_ESCAPE",
      }),
    });
    const restricted = await restrictedGateway.search({
      doi: "10.5555/closed",
      providers: ["unpaywall"],
      limit: 1,
    });
    check("Unpaywall never returns a URL when the record is not legally open", (
      restricted.results[0]?.accessStatus === "restricted"
      && restricted.results[0]?.url === null
      && !JSON.stringify(restricted).includes("publisher.example/paid.pdf")
      && !JSON.stringify(restricted).includes("PAYWALL_BODY_MUST_NOT_ESCAPE")
    ));

    const limitGateway = createOpenResearchGateway({
      cacheDir: path.join(tempDir, "limit-cache"),
      maxLimit: 3,
      fetchImpl: async () => jsonResponse({ query: { search: [1, 2, 3, 4].map((id) => ({ title: `Result ${id}` })) } }),
    });
    const limited = await limitGateway.search({ query: "bounded result fixture", providers: ["wikipedia-zh"], limit: 99 });
    check("query result limit is clamped to the configured hard maximum", limited.results.length === 3, {
      resultCount: limited.results.length,
    });

    const syncDir = path.join(tempDir, "sync-integration");
    const currentMatchesFile = path.join(syncDir, "matches-current.json");
    const externalSignalsFile = path.join(syncDir, "external-signals.json");
    const insightsOutputFile = path.join(syncDir, "open-research-insights.json");
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(currentMatchesFile, JSON.stringify([
      {
        id: "sporttery_open_research_future",
        sourceMatchId: "open_research_future",
        status: "SCHEDULED",
        homeTeamName: "Future Home",
        awayTeamName: "Future Away",
        leagueName: "Fixture League",
        kickoffTime: "2026-07-17T02:00:00.000Z",
        buyEndTime: "2026-07-17T01:30:00.000Z",
      },
      {
        id: "sporttery_open_research_started",
        sourceMatchId: "open_research_started",
        status: "SCHEDULED",
        homeTeamName: "Started Home",
        awayTeamName: "Started Away",
        kickoffTime: "2026-07-16T23:00:00.000Z",
        buyEndTime: "2026-07-16T22:30:00.000Z",
      },
    ]));
    fs.writeFileSync(externalSignalsFile, JSON.stringify({ version: 1, source: "fixture", matches: {}, sources: {} }));
    const observedQueries = [];
    const syncResultHash = "e".repeat(64);
    const syncGateway = {
      search: async ({ query }) => {
        observedQueries.push(query);
        return {
          ok: true,
          partial: false,
          generatedAt: "2026-07-17T01:00:00.000Z",
          requestHash: "f".repeat(64),
          cache: { hit: false, ttlMs: 60_000 },
          providerReports: [{ provider: "wikipedia-en", status: "success", resultCount: 1, durationMs: 2 }],
          results: [{
            id: syncResultHash,
            providers: ["wikipedia-en"],
            accessStatus: "open",
            title: "SYNC_RAW_TITLE_MUST_NOT_ENTER_AI_SUMMARY",
            url: "https://en.wikipedia.org/wiki/Fixture",
            snippet: "SYNC_RAW_SNIPPET_MUST_NOT_ENTER_AUDIT",
            source: "en.wikipedia.org",
            license: "CC BY-SA",
          }],
          aiSafe: {
            requestHash: "f".repeat(64),
            resultSetHash: "1".repeat(64),
            generatedAt: "2026-07-17T01:00:00.000Z",
            expiresAt: "2026-07-17T01:01:00.000Z",
            counts: { resultCount: 1, providerCount: 1, failureCount: 0, cacheHitCount: 0 },
            providers: [{ provider: "wikipedia-en", status: "success", resultCount: 1, durationMs: 2 }],
            accessStatuses: [{ accessStatus: "open", resultCount: 1 }],
            resultHashes: [syncResultHash],
          },
        };
      },
    };
    const syncResult = await syncOpenResearchSignals({
      now: () => Date.parse("2026-07-17T01:00:00.000Z"),
      currentMatchesFile,
      externalSignalsFile,
      insightsOutputFile,
      gateway: syncGateway,
      maxMatches: 4,
      lookaheadHours: 24,
      resultLimit: 4,
    });
    const syncedExternal = JSON.parse(fs.readFileSync(externalSignalsFile, "utf8"));
    const syncedInsights = JSON.parse(fs.readFileSync(insightsOutputFile, "utf8"));
    const firstExternalText = fs.readFileSync(externalSignalsFile, "utf8");
    const firstInsightsText = fs.readFileSync(insightsOutputFile, "utf8");
    const freshSyncResult = await syncOpenResearchSignals({
      now: () => Date.parse("2026-07-17T01:05:00.000Z"),
      currentMatchesFile,
      externalSignalsFile,
      insightsOutputFile,
      gateway: syncGateway,
      maxMatches: 4,
      lookaheadHours: 24,
      resultLimit: 4,
      refreshMinutes: 30,
    });
    const safeMatchSummary = syncedExternal?.matches?.open_research_future?.openResearch;
    const safeMatchJson = JSON.stringify(safeMatchSummary);
    const insightJson = JSON.stringify(syncedInsights);
    check("scheduled-match sync writes audit-only evidence and never changes prediction state", (
      syncResult.ok === true
      && syncResult.selectedMatches === 1
      && observedQueries.length === 1
      && freshSyncResult.skipped === true
      && freshSyncResult.reason === "open-research-fresh"
      && fs.readFileSync(externalSignalsFile, "utf8") === firstExternalText
      && fs.readFileSync(insightsOutputFile, "utf8") === firstInsightsText
      && exactKeys(safeMatchSummary, ["version", "updatedAt", "generatedAt", "requestHash", "resultSetHash", "counts", "providers", "accessStatuses", "resultHashes"])
      && safeMatchSummary.counts.resultCount === 1
      && !safeMatchJson.includes("SYNC_RAW_TITLE")
      && !safeMatchJson.includes("wikipedia.org/wiki")
      && !safeMatchJson.includes("SYNC_RAW_SNIPPET")
      && !insightJson.includes("SYNC_RAW_SNIPPET")
      && syncedInsights.rows[0]?.usableForModel === false
      && syncedInsights.rows[0]?.eligibleForNumericModel === false
      && !insightJson.includes('"prediction"')
      && !insightJson.includes('"probability"')
      && !insightJson.includes('"features"')
      && !syncedExternal.matches.open_research_started
    ), {
      selectedMatches: syncResult.selectedMatches,
      observedQueries: observedQueries.length,
      summaryKeys: Object.keys(safeMatchSummary || {}),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.ok);
  const output = {
    ok: failed.length === 0,
    verifier: "open-research-gateway",
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    verifier: "open-research-gateway",
    fatal: { code: error?.code || "VERIFY_FAILED", message: error?.message || String(error) },
    checks,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
