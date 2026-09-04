const assert = require("assert");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  applyFixtureMappingEvidence,
  createEntityRegistry,
  fixtureIdentityHashFor,
} = require("./entityResolutionRegistry.cjs");
const { attachExternalSignals, buildFiveHundredFallbackMatches } = require("./syncData.cjs");
const { buildOddsSnapshots } = require("../server/dataStore.cjs");

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

const defaultPolicy = api.runtimePolicyFor({});
check(
  defaultPolicy.enabled === false
    && defaultPolicy.requested === false
    && defaultPolicy.mode === "shadow-enrichment"
    && defaultPolicy.features.injuries === true
    && defaultPolicy.features.lineups === true
    && defaultPolicy.features.liveScore === true
    && defaultPolicy.features.odds === false,
  "API-Football must be explicit opt-in with enrichment features enabled and third-party odds disabled by default"
);
const enabledPolicy = api.runtimePolicyFor({
  ENABLE_API_FOOTBALL_SYNC: "1",
  API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
  API_FOOTBALL_KEY: "test-key",
});
check(
  enabledPolicy.enabled === true
    && enabledPolicy.shadowOnly === true
    && Object.values(enabledPolicy.authority).every((allowed) => allowed === false),
  "the only supported runtime mode must remain shadow-only with no official or formal authority"
);
check(
  api.runtimePolicyFor({
    ENABLE_API_FOOTBALL_SYNC: "1",
    API_FOOTBALL_SYNC_MODE: "primary"
  }).enabled === false,
  "an unsupported primary mode must fail closed even when the enable switch is set"
);
check(
  api.runtimePolicyFor({
    ENABLE_API_FOOTBALL_SYNC: "true",
    API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
    API_FOOTBALL_KEY: "test-key",
  }).enabled === false,
  "the enable switch must accept only the exact value 1"
);
check(
  api.runtimePolicyFor({
    ENABLE_API_FOOTBALL_SYNC: "1",
    API_FOOTBALL_SYNC_MODE: " shadow-enrichment ",
    API_FOOTBALL_KEY: "test-key",
  }).enabled === false,
  "shadow mode must be exact and must not silently normalize unsupported values"
);
const missingKeyPolicy = api.runtimePolicyFor({
  ENABLE_API_FOOTBALL_SYNC: "1",
  API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
});
check(
  missingKeyPolicy.enabled === false
    && missingKeyPolicy.configured === false
    && missingKeyPolicy.status === "enabled-key-missing",
  "a missing key must prevent scheduling even when flag and mode are otherwise valid"
);
check(
  api.maxCallsPerSyncFor({}) === 12
    && api.maxCallsPerSyncFor({ API_FOOTBALL_MAX_CALLS_PER_SYNC: "" }) === 12
    && api.maxCallsPerSyncFor({ API_FOOTBALL_MAX_CALLS_PER_SYNC: "NaN" }) === 12
    && api.maxCallsPerSyncFor({ API_FOOTBALL_MAX_CALLS_PER_SYNC: "Infinity" }) === 12
    && api.maxCallsPerSyncFor({ API_FOOTBALL_MAX_CALLS_PER_SYNC: "-1" }) === 12
    && api.maxCallsPerSyncFor({ API_FOOTBALL_MAX_CALLS_PER_SYNC: "7.9" }) === 7,
  "the per-sync cap must default and fail back to 12 while accepting bounded numeric overrides"
);

const observedAt = "2026-07-16T10:00:00.000Z";
const futureKickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const apiOddsPiece = {
  source: "api-football",
  updatedAt: observedAt,
  temporalEligibility: { eligible: true },
  had: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
};
const sanitizedApiOddsSignal = api.mergeSignal({
  source: "api-football",
  updatedAt: observedAt,
  externalOdds: {
    source: "api-football:odds",
    odds1: 2.1,
    oddsX: 3.2,
    odds2: 3.4,
    temporalEligibility: { eligible: true },
  },
  bookmakerOdds: {
    had: { source: "api-football", odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  },
}, {
  sourceMatchId: "api-odds-only",
  kickoffTime: futureKickoff,
  homeTeamName: "Home",
  awayTeamName: "Away",
  updatedAt: observedAt,
  apiFootball: { fixtureId: 7001 },
  bookmakerOdds: { apiFootball: apiOddsPiece },
});
check(
  !sanitizedApiOddsSignal.externalOdds
    && !sanitizedApiOddsSignal.bookmakerOdds?.had
    && sanitizedApiOddsSignal.bookmakerOdds?.apiFootball === apiOddsPiece,
  "API-Football odds must stay namespaced and historical generic copies must be removed"
);

const apiOnlyMatch = {
  id: "api-odds-only",
  sourceMatchId: "api-odds-only",
  kickoffTime: futureKickoff,
  externalSignals: sanitizedApiOddsSignal,
};
const apiOnlySnapshots = buildOddsSnapshots(apiOnlyMatch, "runtime-test");
check(
  apiOnlySnapshots.length === 1
    && apiOnlySnapshots[0].origin === "api-football:odds"
    && apiOnlySnapshots.every((row) => row.origin !== "500.com:jczq"),
  "dataStore must not relabel namespaced or legacy API-Football odds as 500.com rows"
);

const previousFallbackSwitch = process.env.ENABLE_500_MATCH_FALLBACK;
process.env.ENABLE_500_MATCH_FALLBACK = "1";
try {
  const apiOnlyFallback = buildFiveHundredFallbackMatches({
    matches: {
      apiOnly: {
        source: "api-football",
        sourceMatchId: "api-only-fallback",
        kickoffTime: futureKickoff,
        homeTeamName: "Home",
        awayTeamName: "Away",
        externalOdds: { source: "api-football", odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        bookmakerOdds: {
          had: { source: "api-football", odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        },
      },
    },
  });
  check(apiOnlyFallback.length === 0, "API-Football generic odds must never synthesize a five-hundred fallback match");

  const genuineFiveHundredFallback = buildFiveHundredFallbackMatches({
    matches: {
      genuine: {
        source: "500.com:jczq",
        sourceMatchId: "500-fallback",
        kickoffTime: futureKickoff,
        homeTeamName: "Home",
        awayTeamName: "Away",
        bookmakerOdds: {
          had: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        },
      },
    },
  });
  check(
    genuineFiveHundredFallback.length === 1
      && genuineFiveHundredFallback[0].oddsSource === "500.com:HAD",
    "a genuine 500.com signal with inherited source provenance must remain usable"
  );
} finally {
  if (previousFallbackSwitch === undefined) delete process.env.ENABLE_500_MATCH_FALLBACK;
  else process.env.ENABLE_500_MATCH_FALLBACK = previousFallbackSwitch;
}

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
check(api.statusRefreshMinutesFor(suspendedStatus) >= 1440, "suspended credentials must use a day-scale probe cooldown");

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

const suspendedCache = api.normalizeCache(null);
const oldFingerprint = api.credentialFingerprintFor("old-suspended-key");
suspendedCache.apiAccess = { credentialFingerprint: oldFingerprint, status: suspendedStatus };
const credentialReset = api.synchronizeCredentialState(
  suspendedCache,
  api.credentialFingerprintFor("replacement-key")
);
check(credentialReset.changed === true, "a replacement credential must reset provider suspension state");
check(!suspendedCache.apiAccess.status, "a replacement credential must receive a fresh /status preflight");

const freeRangeCache = api.normalizeCache(null);
freeRangeCache.apiAccess.fixtures = {
  updatedAt: observedAt,
  reason: "legacy suspended credential",
  suspended: true,
};
api.rememberFixtureAccessError(
  freeRangeCache,
  new Error("/fixtures API error: plan: Free plans do not have access to this date, try from 2026-07-15 to 2026-07-17."),
);
check(
  freeRangeCache.apiAccess.fixtures.suspended === false
    && freeRangeCache.apiAccess.fixtures.allowedFrom === "2026-07-15"
    && freeRangeCache.apiAccess.fixtures.allowedTo === "2026-07-17"
    && !api.fixtureAccessSkipReason(freeRangeCache, "2026-07-16")
    && Boolean(api.fixtureAccessSkipReason(freeRangeCache, "2026-07-18")),
  "a free-plan date range must clear stale suspension state and skip only out-of-range fixture dates",
);

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

const liveScoreFixture = {
  fixtureId: 7001,
  date: mappedEntry.match.kickoffTime,
  status: { short: "2H", elapsed: 67, long: "Second Half" },
  goals: { home: 2, away: 1 }
};
const liveScore = api.buildLiveScoreObservation(mappedEntry, liveScoreFixture, {
  observedAt: "2026-07-16T13:37:00.000Z",
  providerResponseSha256: "a".repeat(64)
});
check(
  liveScore?.scoreHome === 2
    && liveScore?.scoreAway === 1
    && liveScore?.minute === 67
    && liveScore?.phase === "second-half"
    && liveScore?.trusted === true
    && liveScore?.usagePolicy?.formalRecommendation === false
    && liveScore?.usagePolicy?.officialResult === false
    && liveScore?.settlementEligible === false,
  "verified provider fixture response must produce a display-only live score observation"
);
check(
  api.buildLiveScoreObservation(mappedEntry, {
    ...liveScoreFixture,
    status: { short: "FT", elapsed: 90 }
  }, { observedAt }) === null,
  "terminal provider status must not enter the live display channel"
);
const livePlanCache = api.createCache();
const livePlan = api.buildLiveScoreRequestPlan(
  [mappedEntry],
  livePlanCache,
  new Set([mappedEntry.match.id]),
  Date.parse(mappedEntry.match.kickoffTime) + 30 * 60 * 1000
);
check(
  livePlan.length === 1
    && livePlan[0].params.ids === "7001"
    && livePlan[0].entries[0] === mappedEntry,
  "live score refresh must batch only verified mapped fixtures inside the in-play window"
);
const liveAttached = attachExternalSignals([{
  ...mappedEntry.match,
  sourceMatchId: "fixture"
}], {
  source: "external-signals",
  updatedAt: liveScore.observedAt,
  matches: {
    fixture: {
      sourceMatchId: "fixture",
      kickoffTime: mappedEntry.match.kickoffTime,
      liveScore: { ...liveScore, sourceMatchId: "fixture" }
    }
  }
});
check(
  liveAttached[0]?.liveScore?.scoreHome === 2
    && liveAttached[0]?.liveScore?.settlementEligible === false,
  "event-matched live score must reach the match projection without entering settlement"
);
const rejectedLiveAttached = attachExternalSignals([{
  ...mappedEntry.match,
  sourceMatchId: "fixture"
}], {
  source: "external-signals",
  updatedAt: liveScore.observedAt,
  matches: {
    fixture: {
      sourceMatchId: "fixture",
      kickoffTime: mappedEntry.match.kickoffTime,
      liveScore: { ...liveScore, sourceMatchId: "different-fixture" }
    }
  }
});
check(!rejectedLiveAttached[0]?.liveScore, "mismatched live score identity must fail closed");

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
  liveScore,
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
    && !strippedUnverifiedSignal.liveScore
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

const localizedTrustMatch = {
  ...trustMatch,
  id: "sporttery_2041233",
  sourceMatchId: "2041233",
  homeTeamId: "team_santos",
  awayTeamId: "team_palmeiras",
  homeTeamName: "\u6851\u6258\u65af",
  homeTeamNameEn: "\u6851\u6258\u65af",
  awayTeamName: "\u5e15\u5c14\u6885\u62c9\u65af",
  awayTeamNameEn: "\u5e15\u5c14\u6885\u62c9\u65af",
};
const localizedMapping = {
  ...trustMapping,
  sportteryMatchId: localizedTrustMatch.id,
  sourceMatchId: localizedTrustMatch.sourceMatchId,
  homeTeamId: 128,
  awayTeamId: 121,
  homeTeamName: "Santos",
  awayTeamName: "Palmeiras",
};
localizedMapping.providerEvidence = {
  responseSha256: providerResponseSha256,
  responseFetchedAt: observedAt,
  fixtureIdentitySha256: fixtureIdentityHashFor(localizedMapping),
};
const localizedCache = api.createCache();
localizedCache.fixtureMap[localizedTrustMatch.id] = localizedMapping;
const localizedLearned = api.absorbEntityResolutionEvidence(
  [localizedTrustMatch],
  localizedCache,
  createEntityRegistry({ createdAt: observedAt }),
  new Map([[localizedTrustMatch.id, trustContext]]),
);
check(
  localizedLearned.changedRows === 1
    && localizedLearned.registry.entities.team_santos?.providers?.["api-football"]?.providerEntityId === "128"
    && localizedLearned.registry.entities.team_palmeiras?.providers?.["api-football"]?.providerEntityId === "121",
  "a live Chinese-to-provider alias match must commit the same verified entity identity used by fixture scoring",
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
    && injuries.usagePolicy?.shadowOnly === true
    && injuries.usagePolicy?.formalRecommendation === false
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
    && preMatchLineups.usagePolicy?.shadowOnly === true
    && preMatchLineups.usagePolicy?.formalRecommendation === false
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
  ["\u5df4\u897f\u676f", "Copa Do Brasil"],
  ["\u6b27\u6d32\u8d85\u7ea7\u676f", "UEFA Super Cup"],
  ["\u89e3\u653e\u8005\u676f", "Copa Libertadores"]
];
for (const [localName, providerName] of leagueAliasCases) {
  check(api.aliasesFor(localName, api.LEAGUE_ALIASES).includes(api.normalizeName(providerName)), `${providerName} should normalize through the local league alias map`);
}

const brazilCupScore = api.confidenceForFixture(
  {
    ...localizedTrustMatch,
    leagueName: "\u5df4\u897f\u676f",
    leagueNameEn: "\u5df4\u897f\u676f",
    kickoffTime: "2026-09-03T08:30:00+08:00",
  },
  {
    date: "2026-09-03T08:30:00+08:00",
    teams: {
      home: { id: 128, name: "Santos" },
      away: { id: 121, name: "Palmeiras" },
    },
    league: { id: 73, name: "Copa Do Brasil", round: "Quarter-finals" },
  },
  createEntityRegistry({ createdAt: observedAt }),
);
check(
  brazilCupScore.teamScore === 1
    && brazilCupScore.timeScore === 1
    && brazilCupScore.leagueScore === 1
    && brazilCupScore.confidence >= 0.9,
  "the live Santos-Palmeiras Brazil Cup shape must clear the append-only entity evidence threshold without lowering it",
);

const parseChildResult = (child, marker, label) => {
  check(child.status === 0 && !child.error, `${label} child process must exit cleanly: ${child.stderr || child.error || "unknown error"}`);
  const line = String(child.stdout || "")
    .split(/\r?\n/)
    .find((item) => item.startsWith(marker));
  check(Boolean(line), `${label} child process must emit a machine-readable result`);
  return JSON.parse(line.slice(marker.length));
};

const budgetMarker = "__API_FOOTBALL_BUDGET_RESULT__";
const budgetRunner = `
  const https = require("node:https");
  const api = require(${JSON.stringify(SYNC_FILE)});
  let transportCalls = 0;
  https.request = () => {
    transportCalls += 1;
    throw new Error("simulated transport failure");
  };
  (async () => {
    const cache = api.createCache();
    const budget = api.createRequestBudget();
    const errors = [];
    for (let index = 0; index < 13; index += 1) {
      try {
        await api.apiGet(cache, "/status", {}, budget);
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }
    console.log(${JSON.stringify(budgetMarker)} + JSON.stringify({
      transportCalls,
      attempts: budget.attempts,
      ledgerCount: cache.requestLedger.count,
      statusAttempts: budget.byEndpoint["/status"],
      budgetErrors: errors.filter((message) => /API_FOOTBALL_MAX_CALLS_PER_SYNC/.test(message)).length,
    }));
  })().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
`;
const budgetChild = spawnSync(process.execPath, ["-e", budgetRunner], {
  cwd: PROJECT_ROOT,
  encoding: "utf8",
  timeout: 10_000,
  windowsHide: true,
  env: {
    ...process.env,
    ENABLE_API_FOOTBALL_SYNC: "0",
    API_FOOTBALL_KEY: "",
    APISPORTS_KEY: "",
    API_FOOTBALL_MAX_CALLS_PER_SYNC: "",
  },
});
const budgetRuntime = parseChildResult(budgetChild, budgetMarker, "per-sync request budget");
check(
  budgetRuntime.transportCalls === 12
    && budgetRuntime.attempts === 12
    && budgetRuntime.ledgerCount === 12
    && budgetRuntime.statusAttempts === 12
    && budgetRuntime.budgetErrors === 1,
  "the real request path must pre-reserve exactly 12 attempts and count transport failures before blocking attempt 13"
);

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-api-shadow-"));
const runtimeMarker = "__API_FOOTBALL_RUNTIME_RESULT__";
const runtimeRunner = `
  const fs = require("node:fs");
  const https = require("node:https");
  let networkCalls = 0;
  https.request = () => {
    networkCalls += 1;
    throw new Error("simulated runtime transport failure");
  };
  const api = require(${JSON.stringify(SYNC_FILE)});
  api.main().then(() => {
    const meta = JSON.parse(fs.readFileSync(process.env.API_FOOTBALL_META_FILE, "utf8"));
    console.log(${JSON.stringify(runtimeMarker)} + JSON.stringify({ networkCalls, meta }));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
`;
const runRuntimeScenario = (name, overrides) => {
  const scenarioDir = path.join(runtimeRoot, name);
  fs.mkdirSync(scenarioDir, { recursive: true });
  const currentFile = path.join(scenarioDir, "matches-current.json");
  const fallbackFile = path.join(scenarioDir, "matches.json");
  const metaFile = path.join(scenarioDir, "api-football-meta.json");
  fs.writeFileSync(currentFile, "[]\n", "utf8");
  fs.writeFileSync(fallbackFile, "[]\n", "utf8");
  const child = spawnSync(process.execPath, ["-e", runtimeRunner], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...process.env,
      API_FOOTBALL_DATA_DIR: scenarioDir,
      API_FOOTBALL_CURRENT_MATCHES_FILE: currentFile,
      API_FOOTBALL_FALLBACK_MATCHES_FILE: fallbackFile,
      API_FOOTBALL_EXTERNAL_SIGNALS_FILE: path.join(scenarioDir, "external-signals.json"),
      API_FOOTBALL_CACHE_FILE: path.join(scenarioDir, "api-football-cache.json"),
      API_FOOTBALL_META_FILE: metaFile,
      SERVER_STORE_DIR: path.join(scenarioDir, "server-data"),
      ENTITY_RESOLUTION_REGISTRY_FILE: path.join(scenarioDir, "team-registry.json"),
      API_FOOTBALL_KEY: "",
      APISPORTS_KEY: "",
      API_FOOTBALL_MAX_CALLS_PER_SYNC: "12",
      ...overrides,
    },
  });
  return parseChildResult(child, runtimeMarker, `runtime scenario ${name}`);
};

try {
  const invalidSwitchRuntime = runRuntimeScenario("invalid-switch", {
    ENABLE_API_FOOTBALL_SYNC: "true",
    API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
    API_FOOTBALL_KEY: "test-key",
  });
  const invalidModeRuntime = runRuntimeScenario("invalid-mode", {
    ENABLE_API_FOOTBALL_SYNC: "1",
    API_FOOTBALL_SYNC_MODE: "shadow-enrichment ",
    API_FOOTBALL_KEY: "test-key",
  });
  const missingKeyRuntime = runRuntimeScenario("missing-key", {
    ENABLE_API_FOOTBALL_SYNC: "1",
    API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
  });
  const enabledRuntime = runRuntimeScenario("enabled", {
    ENABLE_API_FOOTBALL_SYNC: "1",
    API_FOOTBALL_SYNC_MODE: "shadow-enrichment",
    API_FOOTBALL_KEY: "test-key",
  });
  check(
    invalidSwitchRuntime.networkCalls === 0
      && invalidSwitchRuntime.meta.enabled === false
      && invalidSwitchRuntime.meta.runtimePolicy.status === "disabled-invalid-switch",
    "the actual sync runtime must reject non-exact enable values before network access"
  );
  check(
    invalidModeRuntime.networkCalls === 0
      && invalidModeRuntime.meta.enabled === false
      && invalidModeRuntime.meta.runtimePolicy.status === "disabled-unsupported-mode",
    "the actual sync runtime must reject non-exact shadow mode before network access"
  );
  check(
    missingKeyRuntime.networkCalls === 0
      && missingKeyRuntime.meta.enabled === false
      && missingKeyRuntime.meta.runtimePolicy.status === "enabled-key-missing",
    "the actual sync runtime must reject missing credentials before network access"
  );
  check(
    enabledRuntime.networkCalls === 1
      && enabledRuntime.meta.enabled === true
      && enabledRuntime.meta.runtimePolicy.status === "shadow-enrichment"
      && enabledRuntime.meta.callsThisSync === 1,
    "only exact flag, exact shadow mode and a configured key may reach the real request path"
  );
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

const source = fs.readFileSync(SYNC_FILE, "utf8");
const mainIndex = source.indexOf("const main = async () =>");
const preflightIndex = source.indexOf("await preflightAccountStatus(cache, requestBudget)", mainIndex);
const fixtureIndex = source.indexOf("const liveTrustContexts = await resolveFixtureMaps(", mainIndex);
check(mainIndex >= 0 && preflightIndex > mainIndex && fixtureIndex > preflightIndex, "/status preflight must precede fixtures and all enrichment calls");
check(
  source.includes("fetchFixturesForDate(cache, date, { forceLive: true }, requestBudget)")
    && source.includes("await fetchLiveScores(mappedMatches, cache, stats, apiPieces, verifiedMappingSet, requestBudget)")
    && source.includes("hydrateCachedApiPieces(mappedMatches, cache, apiPieces, verifiedMappingSet)")
    && source.includes("mergeExternalSignals(matches, cache, apiPieces, stats, verifiedMappingSet)"),
  "the same verifiedMappingSet must guard live revalidation, cache hydration and external-signal merge"
);
check(
  source.includes("const RUNTIME_POLICY = Object.freeze(runtimePolicyFor(process.env))")
    && source.includes("if (LIVE_SCORE_ENABLED)")
    && source.includes("if (INJURIES_ENABLED && !accountAccessSkipReason(cache))")
    && source.includes("if (LINEUPS_ENABLED && !accountAccessSkipReason(cache))")
    && source.includes("if (ODDS_ENABLED && !accountAccessSkipReason(cache))"),
  "runtime execution must be exact opt-in, shadow-mode-only and independently gated per enrichment component"
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
    "current-entity-aliases",
    "display-only-live-score-observations",
    "explicit-shadow-runtime-policy",
    "selective-enrichment-component-gates",
    "namespaced-odds-only",
    "five-hundred-source-validation",
    "pre-reserved-per-sync-request-budget",
    "real-runtime-flag-mode-key-gates"
  ]
}, null, 2));
