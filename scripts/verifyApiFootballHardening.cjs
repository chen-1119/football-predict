const assert = require("assert");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {
  applyFixtureMappingEvidence,
  createEntityRegistry,
  fixtureIdentityHashFor,
} = require("./entityResolutionRegistry.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SYNC_FILE = path.join(__dirname, "syncApiFootballData.cjs");
const CACHE_FILE = path.join(PROJECT_ROOT, "public", "data", "api-football-cache.json");
const META_FILE = path.join(PROJECT_ROOT, "public", "data", "api-football-meta.json");

let requestsDuringImport = 0;
const originalRequest = https.request;
https.request = (...args) => {
  requestsDuringImport += 1;
  throw new Error(`Unexpected network request during verifier import: ${String(args[0])}`);
};

let api;
try {
  api = require(SYNC_FILE);
} finally {
  https.request = originalRequest;
}

assert.strictEqual(requestsDuringImport, 0, "requiring syncApiFootballData.cjs must not run main or access the network");

let assertions = 1;
const check = (value, message) => {
  assertions += 1;
  assert(value, message);
};

const observedAt = "2026-07-16T10:00:00.000Z";
const cutoff = "2026-07-16T12:00:00.000Z";
const afterCutoff = "2026-07-16T12:00:00.001Z";

const activeStatus = api.normalizeAccountStatus({
  response: {
    account: { email: "fixture@example.invalid", status: "active" },
    subscription: { plan: "Free", active: true },
    requests: { current: 3, limit_day: 100 }
  }
}, { checkedAt: observedAt });
check(activeStatus.eligible === true, "active account with remaining quota should pass preflight");
check(activeStatus.quota.remaining === 97, "status normalization should calculate remaining daily quota");

const suspendedStatus = api.normalizeAccountStatus({
  response: {
    account: { status: "suspended" },
    subscription: { plan: "Free", active: false },
    requests: { current: 3, limit_day: 100 }
  }
}, { checkedAt: observedAt });
check(suspendedStatus.eligible === false, "suspended account must fail closed");
check(suspendedStatus.blockers.includes("account-suspended"), "suspension should be a machine-readable blocker");

const exhaustedStatus = api.normalizeAccountStatus({
  response: {
    account: { status: "active" },
    subscription: { plan: "Free", active: true },
    requests: { current: 100, limit_day: 100 }
  }
}, { checkedAt: new Date().toISOString() });
check(exhaustedStatus.eligible === false, "exhausted provider quota must fail closed");
check(exhaustedStatus.blockers.includes("provider-quota-unavailable"), "quota exhaustion should be explicit");

const blockedCache = api.normalizeCache(null);
blockedCache.apiAccess.status = exhaustedStatus;
check(Boolean(api.accountAccessSkipReason(blockedCache)), "cached blocked status should stop all non-status API calls");

const fallbackCache = api.normalizeCache(null);
fallbackCache.apiAccess.injuries = {
  updatedAt: new Date().toISOString(),
  bulkIdsUnsupported: true,
  bulkReason: "/injuries ids is not available on this plan"
};
const fallbackPlan = api.buildInjuryRequestPlan(fallbackCache, [7001, 7002]);
check(fallbackPlan.length === 2 && fallbackPlan.every((item) => item.mode === "fixture"), "cached bulk restriction should plan one request per fixture");
const fallbackUrl = new URL(`https://v3.football.api-sports.io${fallbackPlan[0].endpoint}`);
Object.entries(fallbackPlan[0].params).forEach(([key, value]) => fallbackUrl.searchParams.set(key, value));
check(fallbackUrl.pathname === "/injuries" && fallbackUrl.searchParams.get("fixture") === "7001" && !fallbackUrl.searchParams.has("ids"), "fallback URL must be /injuries?fixture=<id>");
check(api.isBulkIdsUnsupportedError(new Error("/injuries API error: You do not have access to the ids parameter on your plan")), "bulk plan access error should activate fixture fallback");

const mappedEntry = {
  match: {
    id: "sporttery_fixture",
    kickoffTime: "2026-07-16T12:30:00.000Z",
    buyEndTime: cutoff,
    homeTeamName: "Home",
    awayTeamName: "Away"
  },
  map: {
    fixtureId: 7001,
    homeTeamId: 11,
    awayTeamId: 22,
    homeTeamName: "Home",
    awayTeamName: "Away"
  }
};

const trustMatch = {
  ...mappedEntry.match,
  sourceMatchId: "fixture",
  homeTeamId: "local_home",
  awayTeamId: "local_away",
  homeTeamNameEn: "Home",
  awayTeamNameEn: "Away",
};
const trustMapping = {
  ...mappedEntry.map,
  sportteryMatchId: trustMatch.id,
  sourceMatchId: trustMatch.sourceMatchId,
  confidence: 1,
  score: { teamScore: 1, timeScore: 1, leagueScore: 1, reversed: false },
  fixtureDate: trustMatch.kickoffTime,
  matchedAt: observedAt,
  lastSearchAt: new Date().toISOString(),
};
const providerResponseSha256 = "b".repeat(64);
trustMapping.providerEvidence = {
  responseSha256: providerResponseSha256,
  responseFetchedAt: observedAt,
  fixtureIdentitySha256: fixtureIdentityHashFor(trustMapping),
};
const trustContext = { live: true, providerResponseSha256, responseFetchedAt: observedAt };
const trustCache = api.createCache();
trustCache.fixtureMap[trustMatch.id] = trustMapping;
const emptyRegistry = createEntityRegistry({ createdAt: observedAt });

const unverifiedPlan = api.buildFixtureResolutionPlan([trustMatch], trustCache, emptyRegistry);
check(
  unverifiedPlan.reusableKeys.size === 0
    && unverifiedPlan.byDate.get("2026-07-16")?.[0] === trustMatch
    && unverifiedPlan.audits[0]?.freshLastSearchIgnored === true,
  "fresh lastSearchAt must not suppress a live fixture search when the cache mapping is not registry-exact"
);
const emptyVerifiedSet = api.buildVerifiedMappingSet([trustMatch], trustCache, emptyRegistry);
check(emptyVerifiedSet.size === 0, "high-confidence cache without registry evidence must produce an empty verifiedMappingSet");
check(
  api.selectVerifiedMappedMatches([trustMatch], trustCache, emptyVerifiedSet).length === 0,
  "unverified cache mappings must not enter injury, lineup or odds fetch inputs"
);
const strippedUnverifiedSignal = api.stripUnverifiedApiFootballFeatures({
  source: "api-football",
  apiFootball: { fixtureId: trustMapping.fixtureId },
  injuries: { source: "api-football", temporalEligibility: { eligible: true } },
  lineups: { source: "api-football", temporalEligibility: { eligible: true } },
  externalOdds: { source: "api-football:test", temporalEligibility: { eligible: true } },
  bookmakerOdds: {
    apiFootball: { source: "api-football", had: { odds1: 2, oddsX: 3, odds2: 4 } },
    had: { source: "api-football", odds1: 2, oddsX: 3, odds2: 4 },
  },
}, { fixtureId: trustMapping.fixtureId });
check(
  !strippedUnverifiedSignal.injuries
    && !strippedUnverifiedSignal.lineups
    && !strippedUnverifiedSignal.externalOdds
    && !strippedUnverifiedSignal.bookmakerOdds
    && strippedUnverifiedSignal.apiFootball.enrichmentEligible === false,
  "unverified provider cache must be retained as audit metadata only and stripped from numeric pre-match features"
);

const learnedMapping = applyFixtureMappingEvidence({
  registry: emptyRegistry,
  match: trustMatch,
  mapping: trustMapping,
  observedAt,
  trustContext,
});
check(learnedMapping.changed === true, "current-cycle live provider evidence should commit a qualifying mapping");
const currentCycleVerifiedSet = api.buildVerifiedMappingSet(
  [trustMatch],
  trustCache,
  learnedMapping.registry,
  new Map([[trustMatch.id, trustContext]])
);
check(
  currentCycleVerifiedSet.has(trustMatch.id)
    && api.selectVerifiedMappedMatches([trustMatch], trustCache, currentCycleVerifiedSet).length === 1,
  "only a registry-consistent current-cycle verified mapping may enter provider enrichment"
);

const injuries = api.buildInjuriesByFixture([mappedEntry], [{
  fixture: { id: 7001 },
  team: { id: 11, name: "Home" },
  player: { id: 101, name: "Player One", type: "Missing Fixture", reason: "Hamstring" }
}], {
  endpoint: "/injuries",
  query: { fixture: "7001" },
  providerFixtureId: 7001,
  observedAt,
  sourceUpdatedAt: observedAt
}).get("7001");

check(Boolean(injuries?.summary?.zh) && Array.isArray(injuries?.home) && Array.isArray(injuries?.away), "injuries must retain legacy summary/home/away fields");
const injuryPlayer = injuries.players[0];
check(
  injuryPlayer.playerId === 101
    && injuryPlayer.name === "Player One"
    && injuryPlayer.type === "Missing Fixture"
    && injuryPlayer.reason === "Hamstring"
    && injuryPlayer.teamId === 11
    && injuryPlayer.side === "home"
    && Number(injuryPlayer.fixtureId) === 7001
    && injuryPlayer.observedAt === observedAt,
  "injury rows must retain structured identity, team, side, reason, fixture and observation time"
);
check(
  injuries.providerFixtureId === 7001
    && injuries.observedAt === observedAt
    && injuries.sourceUpdatedAt === observedAt
    && injuries.provenance.endpoint === "/injuries"
    && injuries.temporalEligibility.eligible === true,
  "injury fragment must carry provider, provenance and temporal eligibility"
);

const lineupResponse = [{
  team: { id: 11, name: "Home" },
  coach: { id: 301, name: "Coach Home" },
  formation: "4-3-3",
  startXI: [{ player: { id: 101, name: "Player One", number: 9, pos: "F", grid: "1:1" } }],
  substitutes: [{ player: { id: 102, name: "Player Two", number: 19, pos: "F", grid: null } }]
}, {
  team: { id: 22, name: "Away" },
  coach: { id: 302, name: "Coach Away" },
  formation: "4-4-2",
  startXI: [{ player: { id: 201, name: "Player Away", number: 1, pos: "G", grid: "1:1" } }],
  substitutes: []
}];

const preMatchLineups = api.buildLineups(mappedEntry, lineupResponse, {
  observedAt,
  sourceUpdatedAt: observedAt
});
check(Boolean(preMatchLineups?.summary?.zh) && preMatchLineups.homeFormation === "4-3-3" && preMatchLineups.awayFormation === "4-4-2", "lineups must retain legacy summary and formation fields");
check(
  preMatchLineups.home.teamId === 11
    && preMatchLineups.home.name === "Home"
    && preMatchLineups.home.coach.name === "Coach Home"
    && preMatchLineups.home.formation === "4-3-3"
    && preMatchLineups.home.startXI[0].playerId === 101
    && preMatchLineups.home.startXI[0].name === "Player One"
    && preMatchLineups.home.startXI[0].number === 9
    && preMatchLineups.home.startXI[0].position === "F"
    && preMatchLineups.home.startXI[0].grid === "1:1"
    && preMatchLineups.home.substitutes[0].playerId === 102,
  "lineups must retain structured team, coach, formation, starters and substitutes"
);
check(
  preMatchLineups.providerFixtureId === 7001
    && preMatchLineups.observedAt === observedAt
    && preMatchLineups.sourceUpdatedAt === observedAt
    && preMatchLineups.provenance.endpoint === "/fixtures/lineups"
    && preMatchLineups.temporalEligibility.eligible === true,
  "lineup fragment must carry provider, provenance and pre-match eligibility"
);

const postMatchLineups = api.buildLineups(mappedEntry, lineupResponse, {
  observedAt: afterCutoff,
  sourceUpdatedAt: afterCutoff
});
check(postMatchLineups.temporalEligibility.eligible === false, "post-cutoff lineups must never be marked pre-match eligible");
check(api.prematchCutoffFor(mappedEntry) === cutoff, "official sale cutoff must take precedence over kickoff for temporal eligibility");
const sanitizedSignal = api.mergeSignal({
  source: "api-football",
  updatedAt: afterCutoff,
  lineups: postMatchLineups
}, {
  updatedAt: afterCutoff,
  apiFootball: { fixtureId: 7001 }
});
check(!sanitizedSignal.lineups, "post-cutoff API-Football lineups must be removed from the pre-match signal path");
check(api.temporalEligibilityFor(observedAt, cutoff).eligible === true && api.temporalEligibilityFor(afterCutoff, cutoff).eligible === false, "temporal eligibility must be based on fetchedAt<=cutoff");

const teamAliasCases = [
  ["\u6770\u5c14", "ETO FC Gy\u0151r"],
  ["\u96f7\u514b\u96c5\u672a\u514b\u7ef4\u4eac\u4eba", "V\u00edkingur Reykjav\u00edk"],
  ["\u6bd4\u68ee\u963f\u6cf0\u5c14", "FC Atert Bissen"],
  ["\u514b\u62c9\u514b\u65af\u7ef4\u514b", "K\u00cd Klaksv\u00edk"],
  ["\u65b0\u5723\u5f92", "The New Saints"],
  ["\u8428\u5df4\u8d6b", "Sabah"],
  ["\u82cf\u6377\u65af\u5361", "Sutjeska"],
  ["\u963f\u62c9\u6728\u56fe\u51ef\u62c9\u7279", "Kairat"],
  ["\u5df4\u9ece\u5723\u65e5\u5c14\u66fc", "Paris Saint Germain"],
  ["\u963f\u65af\u987f\u7ef4\u62c9", "Aston Villa"],
  ["\u666e\u62c9\u6ed5\u65af", "Club Atletico Platense"],
  ["\u79d1\u91d1\u535a\u8054", "Coquimbo Unido"],
  ["\u5e15\u5c14\u6885\u62c9\u65af", "Palmeiras"],
  ["\u6ce2\u7279\u8bfa\u5c71\u4e18", "Cerro Porteno"]
];
for (const [localName, providerName] of teamAliasCases) {
  check(api.aliasesFor(localName, api.TEAM_ALIASES).includes(api.normalizeName(providerName)), `${providerName} should normalize through the local team alias map`);
}

const leagueAliasCases = [
  ["\u6b27\u7f57\u5df4", "Europa League"],
  ["\u7f8e\u804c", "MLS"],
  ["\u5df4\u7532", "Serie A"],
  ["\u6b27\u6d32\u8d85\u7ea7\u676f", "UEFA Super Cup"],
  ["\u89e3\u653e\u8005\u676f", "Copa Libertadores"]
];
for (const [localName, providerName] of leagueAliasCases) {
  check(api.aliasesFor(localName, api.LEAGUE_ALIASES).includes(api.normalizeName(providerName)), `${providerName} should normalize through the local league alias map`);
}

const source = fs.readFileSync(SYNC_FILE, "utf8");
const mainIndex = source.indexOf("const main = async () =>");
const preflightIndex = source.indexOf("await preflightAccountStatus(cache)", mainIndex);
const fixtureIndex = source.indexOf("await resolveFixtureMaps(matches, cache, stats", mainIndex);
check(mainIndex >= 0 && preflightIndex > mainIndex && fixtureIndex > preflightIndex, "/status preflight must precede fixtures and all enrichment calls");
check(
  source.includes("fetchFixturesForDate(cache, date, { forceLive: true })")
    && source.includes("hydrateCachedApiPieces(mappedMatches, cache, apiPieces, verifiedMappingSet)")
    && source.includes("mergeExternalSignals(matches, cache, apiPieces, stats, verifiedMappingSet)"),
  "the same verifiedMappingSet must guard live revalidation, cache hydration and external-signal merge"
);

let legacyCacheCompatible = null;
if (fs.existsSync(CACHE_FILE)) {
  const legacyCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  const normalized = api.normalizeCache(legacyCache);
  check(normalized.fixtureMap && normalized.fixtureSignals && normalized.apiAccess && normalized.requestLedger, "existing cache must normalize without migration or data loss");
  check(normalized.requestLedger.count === legacyCache.requestLedger.count, "existing request ledger must remain compatible");
  legacyCacheCompatible = true;
}

let legacyMetaReadable = null;
if (fs.existsSync(META_FILE)) {
  const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  check(meta && typeof meta === "object" && meta.version === 1, "existing API-Football meta remains readable and version-compatible");
  legacyMetaReadable = true;
}

console.log(JSON.stringify({
  ok: true,
  verifier: "api-football-hardening-v1",
  assertions,
  networkCalls: requestsDuringImport,
  legacyCacheCompatible,
  legacyMetaReadable,
  covered: [
    "status-preflight-fail-closed",
    "quota-block",
    "fixture-injury-fallback",
    "structured-injuries",
    "structured-lineups",
    "fragment-provenance",
    "post-cutoff-lineup-rejection",
    "fresh-unverified-cache-live-revalidation",
    "registry-exact-enrichment-allow-list",
    "unverified-cache-feature-stripping",
    "current-entity-aliases"
  ]
}, null, 2));
