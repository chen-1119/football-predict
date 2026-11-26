"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const adapter = require("../scripts/collectFootballDataOrgResearch.cjs");
const NOW = Date.parse("2026-10-24T00:00:00Z");
const TOKEN = "fixture-only-token-0123456789";
const metadata = { id: 2021, code: "PL", type: "LEAGUE", currentSeason: { id: 990, startDate: "2026-08-01", endDate: "2027-06-01" } };
const season = adapter.currentSeason(metadata, "PL", NOW, "2026-10-24");
const config = { competitions: ["PL"], businessDate: "2026-10-24", maxRequests: 3 };
const match = (id = 100, extra = {}) => ({ id, competition: { id: 2021, code: "PL" }, season: { id: 990 }, utcDate: "2026-10-18T12:00:00Z", homeTeam: { id: 10, name: "Home" }, awayTeam: { id: 20, name: "Away" }, status: "FINISHED", score: { duration: "REGULAR", fullTime: { home: 2, away: 1 } }, lastUpdated: "2026-10-18T14:00:00Z", ...extra });
const listed = rows => ({ competition: { id: 2021, code: "PL" }, resultSet: { count: rows.length }, matches: rows });
const standing = id => ({ team: { id, name: "Team " + id }, position: id === 10 ? 1 : 2, playedGames: 5, won: 3, draw: 1, lost: 1, points: 10, goalsFor: 8, goalsAgainst: 4, goalDifference: 4 });
const table = () => ({ competition: { id: 2021, code: "PL" }, season: { id: 990 }, standings: [{ type: "TOTAL", stage: "REGULAR_SEASON", group: null, table: [standing(10), standing(20)] }] });
const binding = () => ({ officialEventId: "2042188", orderedOfficialTeamIds: [2, 12], competitionCode: "PL", seasonId: 990, providerMatchId: 200, orderedProviderTeamIds: [10, 20], kickoff: "2026-10-24T11:30:00Z", reviewEvidenceSha256: "a".repeat(64) });

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "football-data-org-test-"));
}

function runtime(responses = []) {
  let time = NOW;
  const calls = [], sleeps = [];
  return {
    calls, sleeps, env: { FOOTBALL_DATA_ORG_TOKEN: TOKEN }, stateRoot: sandbox(), now: () => time,
    sleep: async milliseconds => { sleeps.push(milliseconds); time += milliseconds; },
    fetch: async (url, options) => {
      calls.push({ url, options, at: time });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json", "x-authenticated-client": "private-user-do-not-store" } });
    },
  };
}

test("missing token is non-success and performs no network or filesystem setup", async () => {
  let requests = 0;
  const result = await adapter.collect(config, { env: {}, fetch: async () => { requests += 1; } });
  assert.equal(result.status, "keymissing"); assert.equal(result.ok, false); assert.equal(requests, 0); assert.equal(result.requests, 0);
});

test("actual CLI dry-run with isolated empty environment returns keymissing, not success", () => {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/collectFootballDataOrgResearch.cjs"), "--competitions", "PL", "--business-date", "2026-10-24", "--dry-run"], { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot || "", PATH: path.dirname(process.execPath) } });
  assert.equal(child.status, 2); assert.equal(JSON.parse(child.stdout).status, "keymissing"); assert.equal(child.stderr, "");
});

test("key-present dry-run does not claim remote success or access the API", async () => {
  const dependencies = runtime();
  const result = await adapter.collect({ ...config, dryRun: true }, dependencies);
  assert.equal(result.status, "dry-run-key-configured-network-not-tested"); assert.equal(result.ok, false); assert.equal(dependencies.calls.length, 0);
});

test("budget and explicit free-league scope reject paid, duplicate, oversized and undersized inputs", () => {
  for (const options of [{ ...config, competitions: ["JJL"] }, { ...config, competitions: ["PL", "PL"] }, { ...config, maxRequests: 2 }, { ...config, maxRequests: 31 }, { ...config, businessDate: "2026-13-99" }]) assert.throws(() => adapter.validateConfig(options));
  assert.throws(() => adapter.parseCli(["--url", "https://example.invalid"]));
});

test("current-season metadata must match actual and requested dates, exact competition and season", () => {
  for (const changed of [{ ...metadata, id: 2016 }, { ...metadata, currentSeason: null }, { ...metadata, currentSeason: { ...metadata.currentSeason, endDate: "2025-06-01" } }]) assert.throws(() => adapter.currentSeason(changed, "PL", NOW, "2026-10-24"));
  assert.throws(() => adapter.currentSeason(metadata, "PL", NOW, "2027-10-24"));
});

test("history needs finished regular-duration integer score and past clock", () => {
  assert.equal(adapter.regularResult(match(), NOW).accepted, true);
  for (const row of [match(1, { status: "AWARDED" }), match(1, { status: "TIMED" }), match(1, { score: { duration: "EXTRA_TIME", fullTime: { home: 3, away: 2 } } }), match(1, { score: { duration: "PENALTY_SHOOTOUT", fullTime: { home: 1, away: 1 } } }), match(1, { score: { duration: "REGULAR", fullTime: { home: null, away: 0 } } }), match(1, { score: { duration: "REGULAR", fullTime: { home: "2", away: 0 } } }), match(1, { utcDate: "2026-10-25T00:00:00Z" }), match(1, { lastUpdated: "2026-10-25T00:00:00Z" })]) assert.equal(adapter.regularResult(row, NOW).accepted, false);
});

test("match list rejects wrong season, missing ordered IDs, duplicate match IDs and unknown completeness", () => {
  for (const payload of [listed([match(1, { season: { id: 989 } })]), listed([match(1, { awayTeam: { id: 10, name: "Home" } })]), listed([match(1), match(1)]), { ...listed([match()]), resultSet: {} }, listed([match(1, { utcDate: null })])]) assert.throws(() => adapter.inspectMatches(payload, "PL", season, NOW, "2026-10-24"));
});

test("standings reject grouped ambiguity, missing values, duplicate team and inconsistent arithmetic", () => {
  assert.equal(adapter.inspectStandings(table(), "PL", season).length, 2);
  const missing = table(); missing.standings[0].table[0].points = null;
  const duplicate = table(); duplicate.standings[0].table[1].team.id = 10;
  const groups = table(); groups.standings[0].group = "A";
  const arithmetic = table(); arithmetic.standings[0].table[0].playedGames = 6;
  for (const payload of [missing, duplicate, groups, arithmetic]) assert.throws(() => adapter.inspectStandings(payload, "PL", season));
});

test("explicit binding checks exact ordered IDs/kickoff and cannot grant mapping authority", () => {
  const payload = listed([match(), match(200, { utcDate: "2026-10-24T11:30:00Z", status: "TIMED" })]);
  const matches = adapter.inspectMatches(payload, "PL", season, NOW, "2026-10-24");
  const standings = adapter.inspectStandings(table(), "PL", season);
  const result = adapter.inspectBinding(binding(), matches, standings, season, "PL");
  assert.equal(result.matchedCallerSuppliedIdentity, true); assert.equal(result.mappingAuthorityIndependentlyVerified, false); assert.equal(result.formalEligible, false);
  assert.deepEqual(result.histories.map(item => item.missing), [4, 4]);
  for (const changed of [{ ...binding(), orderedProviderTeamIds: [20, 10] }, { ...binding(), kickoff: "2026-10-24T11:31:00Z" }, { ...binding(), seasonId: 989 }, { ...binding(), reviewEvidenceSha256: "" }]) assert.throws(() => adapter.inspectBinding(changed, matches, standings, season, "PL"));
});

test("GET-only normal collection preserves complete bytes and redacts credentials/client headers", async () => {
  const dependencies = runtime([metadata, listed([match()]), table()]);
  const result = await adapter.collect(config, dependencies);
  assert.equal(result.ok, true); assert.equal(result.status, "collected-research-only"); assert.equal(result.formalEligible, false);
  assert.equal(result.requests, 3); assert.deepEqual(dependencies.sleeps, [6100, 6100, 6100]);
  assert(dependencies.calls.every(call => call.url.startsWith("https://api.football-data.org/v4/competitions/PL") && call.options.method === "GET" && call.options.redirect === "manual"));
  assert.equal(fs.readFileSync(path.join(result.outputDirectory, "001.body"), "utf8"), JSON.stringify(metadata));
  for (const file of fs.readdirSync(result.outputDirectory)) {
    const bytes = fs.readFileSync(path.join(result.outputDirectory, file), "utf8");
    assert(!bytes.includes(TOKEN)); assert(!bytes.includes("private-user-do-not-store"));
  }
  assert.throws(() => fs.writeFileSync(path.join(result.outputDirectory, "001.body"), "overwrite", { flag: "wx" }), { code: "EEXIST" });
  assert.equal(fs.existsSync(path.join(dependencies.stateRoot, "collector.lock")), false);
});

test("persistent rate ledger survives runs and stops concurrent acquisition", async () => {
  const dependencies = runtime();
  const rate = adapter.limiter(dependencies.stateRoot, dependencies);
  assert.throws(() => adapter.limiter(dependencies.stateRoot, dependencies), { code: "EEXIST" });
  for (let index = 0; index < 11; index += 1) await rate.reserve();
  const timestamps = fs.readdirSync(path.join(dependencies.stateRoot, "requests")).map(name => Number(name.slice(0, 13))).sort();
  assert.equal(timestamps[10] - timestamps[0], 61000);
  rate.release();
  const later = adapter.limiter(dependencies.stateRoot, dependencies); await later.reserve(); later.release();
  assert.equal(dependencies.sleeps.at(-1), 6100);
});

test("future rate ledger clock and symlink state fail closed", async () => {
  const dependencies = runtime();
  const rate = adapter.limiter(dependencies.stateRoot, dependencies);
  fs.writeFileSync(path.join(dependencies.stateRoot, "requests", (NOW + 10000) + "-" + "a".repeat(24) + ".json"), "{}", { flag: "wx" });
  await assert.rejects(rate.reserve(), { code: "CLOCK_MOVED_BACKWARD" }); rate.release();
  const parent = sandbox(), target = sandbox(), link = path.join(parent, "linked");
  fs.symlinkSync(target, link, "junction");
  assert.throws(() => adapter.limiter(link, dependencies), { code: "UNSAFE_DIRECTORY" });
});

for (const [status, reason] of [[401, "AUTH_REJECTED"], [403, "PLAN_OR_COMPETITION_DENIED"], [429, "RATE_LIMITED"], [302, "HTTP_NOT_OK"]]) {
  test("HTTP " + status + " preserves failure, never follows or retries", async () => {
    const dependencies = runtime([new Response('{"message":"blocked"}', { status, headers: { "content-type": "application/json", location: "https://example.invalid" } })]);
    const result = await adapter.collect(config, dependencies);
    assert.equal(result.ok, false); assert.equal(result.competitions[0].reason, reason); assert.equal(dependencies.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "001.receipt.json"))).completeBody, true);
  });
}

test("credential echo has no raw body persisted and no secret in output", async () => {
  const dependencies = runtime([{ message: TOKEN }]);
  const result = await adapter.collect(config, dependencies);
  assert.equal(result.competitions[0].reason, "CREDENTIAL_ECHO_NOT_PERSISTED");
  assert.equal(fs.existsSync(path.join(result.outputDirectory, "001.body")), false);
  for (const file of fs.readdirSync(result.outputDirectory)) assert(!fs.readFileSync(path.join(result.outputDirectory, file), "utf8").includes(TOKEN));
});

test("oversized and non-JSON bodies cannot become data success", async () => {
  const oversized = runtime([new Response("x".repeat(adapter.LIMITS.maxBodyBytes + 1), { headers: { "content-type": "application/json" } })]);
  const result = await adapter.collect(config, oversized);
  assert.equal(result.competitions[0].reason, "RESPONSE_TOO_LARGE");
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "001.receipt.json"))).completeBody, false);
  const html = runtime([new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } })]);
  assert.equal((await adapter.collect(config, html)).competitions[0].reason, "NON_JSON_RESPONSE");
});

test("empty data is explicitly unbound research and cannot satisfy near-five", async () => {
  const dependencies = runtime([metadata, listed([]), table()]);
  const result = await adapter.collect(config, dependencies);
  const report = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "report.json")));
  assert.equal(report.researchOnly, true); assert.equal(report.formalEligible, false); assert.equal(report.independentSourceApproved, false);
  assert.deepEqual(report.competitions[0].discoveredFixtures, []);
  assert.equal(report.productionWrites, 0); assert.equal(report.publicationWrites, 0); assert.equal(report.modelWrites, 0);
});

test("season-date conflicts are preserved but never admitted as history, target, or H2H", () => {
  const early = match(999, { utcDate: "2026-07-31T20:00:00Z" });
  const payload = listed([early, match(), match(200, { utcDate: "2026-10-24T11:30:00Z", status: "TIMED" })]);
  const inspected = adapter.inspectMatches(payload, "PL", season, NOW, "2026-10-24");
  assert.deepEqual(inspected.quarantined[0].originalRow, early);
  assert.equal(inspected.quarantined[0].sourceIndex, 0);
  assert.equal(inspected.quarantined[0].reason, "MATCH_OUTSIDE_SEASON");
  assert.equal(inspected.historyAccepted.some(row => row.providerMatchId === 999), false);
  assert.equal(inspected.rows.some(row => row.id === 999), false);
  const bound = adapter.inspectBinding(binding(), inspected, adapter.inspectStandings(table(), "PL", season), season, "PL");
  assert.deepEqual(bound.h2h.relatedQuarantineIds, [999]);
  assert.equal(bound.h2h.rows.some(row => row.providerMatchId === 999), false);
  assert.equal(bound.h2h.complete, false);
});

test("quarantine in latest five consumes its slot, never promotes the old sixth match", () => {
  const future = match(200, { utcDate: "2026-10-24T11:30:00Z", status: "TIMED" });
  const rows = [18, 17, 16, 15, 14, 13].map(day => match(day, { utcDate: `2026-10-${day}T12:00:00Z` }));
  const inspected = adapter.inspectMatches(listed([...rows, future]), "PL", season, NOW, "2026-10-24");
  inspected.quarantined = [{ providerMatchId: 999, kickoff: "2026-10-16T18:00:00Z", attributionReliable: true, kickoffReliable: true, orderedProviderTeamIds: [10, 20], status: "FINISHED" }];
  const result = adapter.inspectBinding(binding(), inspected, adapter.inspectStandings(table(), "PL", season), season, "PL");
  assert.deepEqual(result.histories[0].rows.map(row => row.providerMatchId), [18, 17, 16, 15]);
  assert.equal(result.histories[0].missing, 1);
  assert.equal(result.histories[0].completeFiveWithinObservedRows, false);
  assert.deepEqual(result.histories[0].quarantineWithinLatestFive, [999]);
});

test("unassignable quarantine or unconfirmed status blocks last-five completeness", () => {
  const future = match(200, { utcDate: "2026-10-24T11:30:00Z", status: "TIMED" });
  for (const quarantine of [{ providerMatchId: 999, kickoff: "2026-07-31T20:00:00Z", attributionReliable: false, kickoffReliable: true, status: "FINISHED" }, { providerMatchId: 999, kickoff: "2026-07-31T20:00:00Z", attributionReliable: true, kickoffReliable: true, orderedProviderTeamIds: [10, 20], status: "SUSPENDED" }]) {
    const inspected = adapter.inspectMatches(listed([match(), future]), "PL", season, NOW, "2026-10-24");
    inspected.quarantined = [quarantine];
    const result = adapter.inspectBinding(binding(), inspected, adapter.inspectStandings(table(), "PL", season), season, "PL");
    assert.equal(result.histories[0].rankingUncertain, true);
    assert.equal(result.histories[0].missing, 5);
    assert.deepEqual(result.histories[0].rows, []);
  }
});

test("quarantined season data is explicitly partial, while wrong season IDs still reject", async () => {
  const dependencies = runtime([metadata, listed([match(999, { utcDate: "2026-07-31T20:00:00Z" }), match()]), table()]);
  const result = await adapter.collect(config, dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.competitions[0].status, "partial-research-only");
  const report = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "report.json")));
  assert.equal(report.competitions[0].quarantined.length, 1);
  assert.equal(report.competitions[0].sourceSeasonCompletenessVerified, false);
  assert.throws(() => adapter.inspectMatches(listed([match(999, { utcDate: "2026-07-31T20:00:00Z", season: { id: 989 } })]), "PL", season, NOW, "2026-10-24"), { code: "MATCH_SEASON_IDENTITY" });
});

for (const [reason, changed] of [["FULL_TIME_SCORE_MISSING", { score: { duration: "REGULAR", fullTime: { home: null, away: 1 } } }], ["REGULAR_90_MINUTES_NOT_PROVEN", { score: { duration: "EXTRA_TIME", fullTime: { home: 2, away: 1 } } }], ["UPDATE_CLOCK_INVALID", { lastUpdated: "2026-10-25T00:00:00Z" }]]) {
  test("in-season latest finished " + reason + " occupies missing slot without promoting sixth", () => {
    const rows = [18, 17, 16, 15, 14, 13].map(day => match(day, { utcDate: `2026-10-${day}T12:00:00Z` }));
    rows[0] = { ...rows[0], ...changed };
    const inspected = adapter.inspectMatches(listed([...rows, match(200, { utcDate: "2026-10-24T11:30:00Z", status: "TIMED" })]), "PL", season, NOW, "2026-10-24");
    const result = adapter.inspectBinding(binding(), inspected, [], season, "PL");
    assert.deepEqual(result.histories[0].rows.map(row => row.providerMatchId), [17, 16, 15, 14]);
    assert.equal(result.histories[0].missing, 1);
    assert.equal(result.histories[0].completeFiveWithinObservedRows, false);
    assert.deepEqual(result.histories[0].excludedFinishedWithinLatestFive, [{ providerMatchId: 18, kickoff: "2026-10-18T12:00:00Z", reason }]);
  });
}

test("response completion spacing remains safe after variable reservation persistence delay", async () => {
  let now = NOW;
  const dependencies = { stateRoot: sandbox(), now: () => now, sleep: async duration => { now += duration; } };
  const rate = adapter.limiter(dependencies.stateRoot, dependencies), dispatches = [], completions = [];
  for (let index = 0; index < 12; index += 1) {
    await rate.reserve();
    now += index === 0 ? 65000 : index % 2 === 0 ? 500 : 0;
    dispatches.push(now);
    now += 1000;
    completions.push(now);
    rate.completed();
  }
  assert(dispatches.slice(1).every((clock, index) => clock - completions[index] >= 6100));
  assert(dispatches.every(clock => dispatches.filter(other => other <= clock && other > clock - 61000).length <= 10));
  rate.release();
});

test("new lock owner waits from acquisition without changing prior immutable ledger bytes", async () => {
  let now = NOW;
  const stateRoot = sandbox(), runtime = { now: () => now, sleep: async duration => { now += duration; } };
  const first = adapter.limiter(stateRoot, runtime);
  await first.reserve(); now += 65000; first.completed(); first.release();
  const files = fs.readdirSync(path.join(stateRoot, "requests"));
  const priorBytes = fs.readFileSync(path.join(stateRoot, "requests", files[0]));
  const acquiredAt = now, second = adapter.limiter(stateRoot, runtime);
  await second.reserve();
  assert(now - acquiredAt >= 6100);
  assert.deepEqual(fs.readFileSync(path.join(stateRoot, "requests", files[0])), priorBytes);
  second.release();
});

test("legacy serial callers without completion notification use conservative current-call cooldown", async () => {
  let now = NOW;
  const runtime = { now: () => now, sleep: async duration => { now += duration; } };
  const rate = adapter.limiter(sandbox(), runtime);
  await rate.reserve(); now += 65000;
  const nextInvocationAt = now;
  await rate.reserve();
  assert(now - nextInvocationAt >= 6100);
  rate.release();
});

test("completion callback rejects reversed clocks and duplicate completion", async () => {
  let now = NOW;
  const runtime = { now: () => now, sleep: async duration => { now += duration; } };
  const rate = adapter.limiter(sandbox(), runtime);
  assert.throws(() => rate.completed(), { code: "RATE_COMPLETION_CLOCK_INVALID" });
  await rate.reserve(); const reservedAt = now; now -= 1;
  assert.throws(() => rate.completed(), { code: "RATE_COMPLETION_CLOCK_INVALID" });
  now = reservedAt; rate.completed();
  assert.throws(() => rate.completed(), { code: "RATE_COMPLETION_CLOCK_INVALID" });
  rate.release();
});
