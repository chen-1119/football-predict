const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
  SPORTTERY_CALCULATOR_REFERER,
  SPORTTERY_RESULT_REFERER,
  SPORTTERY_DEFAULT_USER_AGENT,
  sportteryRefererForUrl,
  sportteryRequestHeaders,
} = require("./sportteryEndpointContract.cjs");
const {
  cleanupProfile,
  parseBrowserDocumentResponse,
  pruneStaleSportteryProfiles,
  validateSportteryBrowserUrl,
} = require("./sportteryBrowserTransport.cjs");
const {
  normalizeOfficialUniformResultPayload,
} = require("./sportteryOfficialResult.cjs");
const {
  reconcileOfficialResultClock,
} = require("./syncData.cjs");
const {
  buildPageUrl,
  classifyError,
} = require("./collectSportterySnapshot.cjs");

const rootDir = path.resolve(__dirname, "..");
const collectorSource = fs.readFileSync(
  path.join(rootDir, "scripts/collectSportterySnapshot.cjs"),
  "utf8",
);
const browserTransportSource = fs.readFileSync(
  path.join(rootDir, "scripts/sportteryBrowserTransport.cjs"),
  "utf8",
);
const productionConsumers = [
  "scripts/collectSportterySnapshot.cjs",
  "scripts/syncData.cjs",
  "scripts/checkSportteryOdds.cjs",
  "scripts/verifySportteryEgress.cjs",
];
const legacyCalculatorNeedle =
  "/gateway/jc/football/getMatchCalculatorV1.qry";

const checks = [];
const push = (name, ok, details = {}) => checks.push({
  name,
  ...details,
  ok: Boolean(ok),
});

push(
  "calculator endpoint matches the current official mobile frontend contract",
  SPORTTERY_CALCULATOR_URL
    === "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had",
  { url: SPORTTERY_CALCULATOR_URL },
);
push(
  "calculator requests use the current official calculator page as referer",
  SPORTTERY_CALCULATOR_REFERER
    === "https://m.sporttery.cn/mjc/jsq/zqhhgg/"
    && sportteryRefererForUrl(SPORTTERY_CALCULATOR_URL) === SPORTTERY_CALCULATOR_REFERER,
  { referer: SPORTTERY_CALCULATOR_REFERER },
);
push(
  "match data requests use the current official match data page as referer",
  sportteryRefererForUrl(SPORTTERY_CURRENT_URL, "concern")
    === "https://m.sporttery.cn/mjc/zqsj/?tab=concern",
  { referer: sportteryRefererForUrl(SPORTTERY_CURRENT_URL, "concern") },
);
push(
  "official payout requests use the public lottery-result page contract",
  SPORTTERY_RESULT_URL
    === "https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry?matchPage=0"
    && SPORTTERY_RESULT_REFERER === "https://www.sporttery.cn/ltkj/"
    && sportteryRefererForUrl(SPORTTERY_RESULT_URL) === SPORTTERY_RESULT_REFERER,
  {
    url: SPORTTERY_RESULT_URL,
    referer: sportteryRefererForUrl(SPORTTERY_RESULT_URL),
  },
);
const resultPageUrl = buildPageUrl("result", 2, 0);
push(
  "result collection is bound to the official latest-payout feed instead of the WAF-blocked legacy archive",
  resultPageUrl === SPORTTERY_RESULT_URL,
  { url: resultPageUrl },
);
const defaultHeaders = sportteryRequestHeaders(SPORTTERY_CURRENT_URL, "concern", {});
const overrideHeaders = sportteryRequestHeaders(SPORTTERY_CURRENT_URL, "all", {
  SPORTTERY_REQUEST_USER_AGENT: "football-test-browser/1.0",
});
push(
  "official requests default to a desktop Chromium user agent accepted by the current WAF",
  defaultHeaders["User-Agent"] === SPORTTERY_DEFAULT_USER_AGENT
    && /Windows NT 10\.0; Win64; x64/.test(defaultHeaders["User-Agent"])
    && /Chrome\/\d+/.test(defaultHeaders["User-Agent"])
    && !/iPhone|Mobile\/15E148/.test(defaultHeaders["User-Agent"]),
  { userAgent: defaultHeaders["User-Agent"] },
);
push(
  "official request headers remain referer-bound and allow an explicit user-agent override",
  defaultHeaders.Referer === sportteryRefererForUrl(SPORTTERY_CURRENT_URL, "concern")
    && overrideHeaders["User-Agent"] === "football-test-browser/1.0",
  {
    currentReferer: defaultHeaders.Referer,
    overrideUserAgent: overrideHeaders["User-Agent"],
  },
);
const resultHeaders = sportteryRequestHeaders(SPORTTERY_RESULT_URL, "result", {});
push(
  "official payout headers retain the public result page origin and referer",
  resultHeaders.Referer === SPORTTERY_RESULT_REFERER
    && resultHeaders.Origin === "https://www.sporttery.cn",
  {
    referer: resultHeaders.Referer,
    origin: resultHeaders.Origin,
  },
);

const staleConsumers = productionConsumers.filter((relativePath) => (
  fs.readFileSync(path.join(rootDir, relativePath), "utf8")
    .includes(legacyCalculatorNeedle)
));
push(
  "production consumers no longer embed the retired calculator route",
  staleConsumers.length === 0,
  { staleConsumers },
);
const retiredMobileUserAgentConsumers = productionConsumers.filter((relativePath) => (
  fs.readFileSync(path.join(rootDir, relativePath), "utf8")
    .includes("Mobile/15E148 Safari/604.1")
));
push(
  "production consumers no longer embed the WAF-blocked mobile Safari user agent",
  retiredMobileUserAgentConsumers.length === 0,
  { retiredMobileUserAgentConsumers },
);
push(
  "the signed collector falls back to an allowlisted headless Chromium document transport",
  collectorSource.includes("requestJsonViaEdgeDocument")
    && collectorSource.includes("browserFallbackEnabled")
    && browserTransportSource.includes('SPORTTERY_API_HOST = "webapi.sporttery.cn"')
    && browserTransportSource.includes('parsed.protocol !== "https:"')
    && browserTransportSource.includes('transport: "edge-cdp-document"')
    && browserTransportSource.includes('transport: "edge-cdp-official-result-page-xhr"'),
);
push(
  "the Chromium fallback is isolated, bounded, hidden, and removes only its own OS-temp profile",
  browserTransportSource.includes("fs.mkdtempSync(path.join(os.tmpdir()")
    && browserTransportSource.includes("windowsHide: true")
    && browserTransportSource.includes("MAX_RESPONSE_BYTES")
    && browserTransportSource.includes("SPORTTERY_BROWSER_FALLBACK_TIMEOUT_SECONDS")
    && browserTransportSource.includes("path.relative(tempRoot, resolved)")
    && browserTransportSource.includes("SPORTTERY_PROFILE_SUFFIX_PATTERN")
    && browserTransportSource.includes("maxRetries: 12")
    && browserTransportSource.includes("retryDelay: 250")
    && browserTransportSource.includes('spawnSync("taskkill"'),
);

const originalTmpdir = os.tmpdir;
const profileCleanupAudit = {
  exactPrefixesRemoved: false,
  cleanupIdempotent: false,
  retryConfigured: false,
  outsideRejected: false,
  similarPrefixesRejected: false,
  staleRemoved: false,
  freshRetained: false,
  bounded: false,
  pruneIdempotent: false,
  throttled: false,
  error: null,
};
let profileTestRoot = "";
let outsideTestRoot = "";
try {
  const profileTestBase = path.resolve(
    process.env.SPORTTERY_PROFILE_CLEANUP_TEST_ROOT || originalTmpdir(),
  );
  if (!fs.existsSync(profileTestBase)) {
    fs.mkdirSync(profileTestBase, { recursive: true });
  }
  profileTestRoot = fs.mkdtempSync(path.join(profileTestBase, "football-profile-cleanup-contract-"));
  outsideTestRoot = fs.mkdtempSync(path.join(profileTestBase, "football-profile-cleanup-outside-"));
  os.tmpdir = () => profileTestRoot;

  const makeDirectory = (root, name) => {
    const target = path.join(root, name);
    fs.mkdirSync(target);
    return target;
  };
  const allowedEdge = makeDirectory(profileTestRoot, "football-sporttery-edge-Ab12Z9");
  const allowedResult = makeDirectory(profileTestRoot, "football-sporttery-result-edge-K8m2Q4");
  const originalRmSync = fs.rmSync;
  let capturedCleanupOptions = null;
  fs.rmSync = (target, options) => {
    if (path.resolve(target) === path.resolve(allowedEdge)) {
      capturedCleanupOptions = { ...options };
    }
    return originalRmSync(target, options);
  };
  let exactFirst;
  try {
    exactFirst = cleanupProfile(allowedEdge);
  } finally {
    fs.rmSync = originalRmSync;
  }
  const exactSecond = cleanupProfile(allowedResult);
  profileCleanupAudit.retryConfigured = capturedCleanupOptions?.recursive === true
    && capturedCleanupOptions?.force === true
    && capturedCleanupOptions?.maxRetries === 12
    && capturedCleanupOptions?.retryDelay === 250;
  profileCleanupAudit.exactPrefixesRemoved = exactFirst
    && exactSecond
    && !fs.existsSync(allowedEdge)
    && !fs.existsSync(allowedResult);
  profileCleanupAudit.cleanupIdempotent = cleanupProfile(allowedEdge)
    && cleanupProfile(allowedResult);

  const outsideProfile = makeDirectory(
    outsideTestRoot,
    "football-sporttery-edge-OuT123",
  );
  profileCleanupAudit.outsideRejected = cleanupProfile(outsideProfile) === false
    && fs.existsSync(outsideProfile);

  const similarProfiles = [
    "football-sporttery-edgeX-Ab12Z9",
    "football-sporttery-edge-Ab12Z9-extra",
    "football-sporttery-result-edgE-Ab12Z9",
  ].map((name) => makeDirectory(profileTestRoot, name));
  profileCleanupAudit.similarPrefixesRejected = similarProfiles.every((target) => (
    cleanupProfile(target) === false && fs.existsSync(target)
  ));

  const staleProfiles = [
    makeDirectory(profileTestRoot, "football-sporttery-edge-St4lE1"),
    makeDirectory(profileTestRoot, "football-sporttery-result-edge-Old9X2"),
  ];
  const freshProfile = makeDirectory(
    profileTestRoot,
    "football-sporttery-edge-Fr3sh1",
  );
  const now = Date.now();
  const staleAt = new Date(now - (16 * 60 * 1000));
  const freshAt = new Date(now - 60_000);
  for (const target of staleProfiles) fs.utimesSync(target, staleAt, staleAt);
  fs.utimesSync(freshProfile, freshAt, freshAt);

  const firstPrune = pruneStaleSportteryProfiles({ now, limit: 1, force: true });
  const staleRemainingAfterFirst = staleProfiles.filter((target) => fs.existsSync(target)).length;
  const secondPrune = pruneStaleSportteryProfiles({ now, limit: 1, force: true });
  const thirdPrune = pruneStaleSportteryProfiles({ now, limit: 1, force: true });
  const throttledPrune = pruneStaleSportteryProfiles({ now: now + 1_000, limit: 1 });
  profileCleanupAudit.staleRemoved = staleProfiles.every((target) => !fs.existsSync(target));
  profileCleanupAudit.freshRetained = fs.existsSync(freshProfile);
  profileCleanupAudit.bounded = firstPrune.eligible === 1
    && firstPrune.removed === 1
    && staleRemainingAfterFirst === 1
    && secondPrune.eligible === 1
    && secondPrune.removed === 1;
  profileCleanupAudit.pruneIdempotent = thirdPrune.eligible === 0
    && thirdPrune.removed === 0;
  profileCleanupAudit.throttled = throttledPrune.throttled === true
    && throttledPrune.scanned === 0
    && throttledPrune.removed === 0;
} catch (error) {
  profileCleanupAudit.error = error.message;
} finally {
  os.tmpdir = originalTmpdir;
  for (const target of [profileTestRoot, outsideTestRoot]) {
    if (!target) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // The audit fields above already fail closed if the fixture did not finish.
    }
  }
}
push(
  "profile cleanup removes only exact mkdtemp names for the two owned prefixes and is idempotent",
  profileCleanupAudit.exactPrefixesRemoved
    && profileCleanupAudit.cleanupIdempotent
    && profileCleanupAudit.retryConfigured,
  profileCleanupAudit,
);
push(
  "profile cleanup rejects Temp-external paths and similar or overlong prefixes",
  profileCleanupAudit.outsideRejected
    && profileCleanupAudit.similarPrefixesRejected,
  profileCleanupAudit,
);
push(
  "stale profile pruning deletes only profiles older than fifteen minutes with a bounded batch",
  profileCleanupAudit.staleRemoved
    && profileCleanupAudit.freshRetained
    && profileCleanupAudit.bounded,
  profileCleanupAudit,
);
push(
  "stale profile pruning is idempotent and interval-throttled",
  profileCleanupAudit.pruneIdempotent
    && profileCleanupAudit.throttled,
  profileCleanupAudit,
);
let rejectedForeignHost = false;
let rejectedInsecureScheme = false;
try {
  validateSportteryBrowserUrl("https://example.com/gateway/uniform/football/getMatchListV1.qry");
} catch {
  rejectedForeignHost = true;
}
try {
  validateSportteryBrowserUrl("http://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry");
} catch {
  rejectedInsecureScheme = true;
}
push(
  "the Chromium fallback accepts only HTTPS requests on the official gateway host",
  new URL(validateSportteryBrowserUrl(SPORTTERY_CURRENT_URL)).hostname === "webapi.sporttery.cn"
    && rejectedForeignHost
    && rejectedInsecureScheme,
  { rejectedForeignHost, rejectedInsecureScheme },
);

let wafAudit = null;
try {
  parseBrowserDocumentResponse({
    targetUrl: SPORTTERY_CURRENT_URL,
    responseEvent: {
      params: {
        response: {
          status: 403,
          headers: { "content-type": "text/html", "x-waf-uuid": "fixture" },
        },
      },
    },
    rawBody: Buffer.from("<!DOCTYPE html><title>WAF</title>", "utf8"),
  });
} catch (error) {
  wafAudit = {
    message: error.message,
    statusCode: error.response?.statusCode,
    contentType: error.response?.headers?.["content-type"],
    rawBody: error.response?.rawBody,
  };
}
push(
  "the Chromium fallback preserves WAF status, headers, and raw response evidence before JSON parsing",
  wafAudit?.statusCode === 403
    && wafAudit?.contentType === "text/html"
    && Buffer.isBuffer(wafAudit?.rawBody)
    && /HTTP 403/.test(wafAudit?.message || ""),
  {
    statusCode: wafAudit?.statusCode || null,
    contentType: wafAudit?.contentType || null,
    rawBytes: wafAudit?.rawBody?.length || 0,
  },
);

const browserJsonFixture = parseBrowserDocumentResponse({
  targetUrl: SPORTTERY_CURRENT_URL,
  responseEvent: {
    params: {
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    },
  },
  rawBody: Buffer.from(JSON.stringify({ success: true, value: { totalCount: 1 } }), "utf8"),
});
push(
  "the Chromium fallback still accepts a successful official JSON document",
  browserJsonFixture.statusCode === 200
    && browserJsonFixture.payload?.success === true
    && browserJsonFixture.payload?.value?.totalCount === 1
  && browserJsonFixture.transport === "edge-cdp-document",
);
push(
  "the collector classifies EdgeOne HTTP 567 responses as WAF blocks",
  classifyError("official result endpoint -> HTTP 567 security policy blocked") === "waf-blocked",
);

const normalizedOfficialResult = normalizeOfficialUniformResultPayload({
  errorCode: "0",
  success: true,
  value: {
    lastUpdateTime: "2026-07-30 11:38:36",
    matchResult: [{
      matchId: 2040650,
      matchNumStr: "周三006",
      matchDate: "2026-07-30",
      allHomeTeam: "维多利亚",
      allAwayTeam: "帕尔梅拉斯",
      leagueNameAbbr: "巴甲",
      goalLine: "+1",
      sectionsNo1: "0:2",
      sectionsNo999: "0:4",
      poolStatus: "Payout",
      matchResultStatus: "2",
      h: "4.30",
      d: "3.30",
      a: "1.69",
    }],
  },
});
const normalizedOfficialRow = normalizedOfficialResult?.value?.matchInfoList?.[0]?.subMatchList?.[0];
push(
  "official payout rows normalize into the settlement schema without leaking post-match SP into pre-match markets",
  normalizedOfficialRow?.matchId === 2040650
    && normalizedOfficialRow?.homeTeamAllName === "维多利亚"
    && normalizedOfficialRow?.awayTeamAllName === "帕尔梅拉斯"
    && normalizedOfficialRow?.matchStatus === "11"
    && normalizedOfficialRow?.officialResultIdentity?.scheduleTimeAuthority
      === "omitted-by-official-result-feed"
    && normalizedOfficialRow?.sourceUpdatedAt === "2026-07-30T03:38:36.000Z"
    && normalizedOfficialRow?.officialPayoutSp?.h === "4.30"
    && !Object.prototype.hasOwnProperty.call(normalizedOfficialRow, "h")
    && !Object.prototype.hasOwnProperty.call(normalizedOfficialRow, "d")
    && !Object.prototype.hasOwnProperty.call(normalizedOfficialRow, "a"),
  { normalizedOfficialRow },
);
const reconciledOfficialResult = reconcileOfficialResultClock(
  {
    sourceMatchId: "2040650",
    homeTeamName: normalizedOfficialRow.homeTeamAllName,
    awayTeamName: normalizedOfficialRow.awayTeamAllName,
    kickoffTime: "2026-07-30T08:30:00+08:00",
    eventVersion: "2026-07-30T08:30:00+08:00",
    matchDate: "2026-07-30",
    businessDate: "2026-07-29",
  },
  {
    sourceMatchId: "2040650",
    homeTeamName: normalizedOfficialRow.homeTeamAllName,
    awayTeamName: normalizedOfficialRow.awayTeamAllName,
    kickoffTime: "2026-07-30T00:00:00+08:00",
    eventVersion: "2026-07-30T00:00:00+08:00",
    matchDate: "2026-07-30",
    businessDate: "2026-07-30",
    status: "FINISHED",
    scoreHome: 0,
    scoreAway: 4,
    officialResultIdentity: normalizedOfficialRow.officialResultIdentity,
  },
);
push(
  "official payout settlement inherits the immutable pre-match clock instead of replacing it with midnight",
  reconciledOfficialResult?.kickoffTime === "2026-07-30T08:30:00+08:00"
    && reconciledOfficialResult?.eventVersion === "2026-07-30T08:30:00+08:00"
    && reconciledOfficialResult?.businessDate === "2026-07-29"
    && reconciledOfficialResult?.scoreAway === 4
    && reconciledOfficialResult?.officialResultIdentity?.scheduleTimeAuthority
      === "inherited-pre-match-event-identity",
  { reconciledOfficialResult },
);

const failed = checks.filter((check) => !check.ok);
process.stdout.write(`${JSON.stringify({
  ok: failed.length === 0,
  checks,
  failed: failed.map((check) => check.name),
}, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
