"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const VERSION = "football-data-org-local-research-v3";
const API = "https://api.football-data.org/v4";
const FREE_LEAGUES = Object.freeze({ PL: 2021, ELC: 2016, BL1: 2002, DED: 2003, FL1: 2015, SA: 2019, PD: 2014, PPL: 2017, BSA: 2013 });
const LIMITS = Object.freeze({ maxRequests: 30, intervalMs: 6100, rollingWindowMs: 61000, requestsPerWindow: 10, timeoutMs: 30000, maxBodyBytes: 4 * 1024 * 1024 });
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireValue = (condition, code) => { if (!condition) fail(code); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const iso = value => new Date(value).toISOString();
const businessDate = value => new Date(value + 8 * 3600000).toISOString().slice(0, 10);

function writeNew(file, bytes) {
  const descriptor = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function safeDirectory(directory) {
  const absolute = path.resolve(directory), parent = path.dirname(absolute);
  if (parent !== absolute) safeDirectory(parent);
  try { fs.lstatSync(absolute); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { fs.mkdirSync(absolute, { mode: 0o700 }); } catch (created) { if (created.code !== "EEXIST") throw created; }
  }
  const stat = fs.lstatSync(absolute);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "UNSAFE_DIRECTORY");
  return absolute;
}

function validateConfig(options) {
  const competitions = options.competitions;
  requireValue(Array.isArray(competitions) && competitions.length > 0 && new Set(competitions).size === competitions.length, "COMPETITIONS_REQUIRED");
  requireValue(competitions.every(code => Object.hasOwn(FREE_LEAGUES, code)), "FREE_LEAGUE_NOT_ALLOWLISTED");
  requireValue(date(options.businessDate), "BUSINESS_DATE_REQUIRED");
  const maxRequests = options.maxRequests ?? 6;
  requireValue(Number.isInteger(maxRequests) && maxRequests >= competitions.length * 3 && maxRequests <= LIMITS.maxRequests, "REQUEST_BUDGET_INVALID");
  return { competitions, businessDate: options.businessDate, maxRequests };
}

function currentSeason(metadata, code, observedAt, targetDate) {
  requireValue(metadata?.id === FREE_LEAGUES[code] && metadata?.code === code && metadata?.type === "LEAGUE", "COMPETITION_IDENTITY");
  const season = metadata.currentSeason;
  requireValue(positiveId(season?.id) && date(season.startDate) && date(season.endDate) && season.startDate <= season.endDate, "CURRENT_SEASON_MISSING");
  const today = new Date(observedAt).toISOString().slice(0, 10);
  requireValue(season.startDate <= today && today <= season.endDate && season.startDate <= targetDate && targetDate <= season.endDate, "CURRENT_SEASON_DATE_MISMATCH");
  return { id: season.id, startDate: season.startDate, endDate: season.endDate, year: Number(season.startDate.slice(0, 4)) };
}

function validateMatch(row, code, season) {
  requireValue(positiveId(row?.id) && row.competition?.id === FREE_LEAGUES[code] && row.competition?.code === code, "MATCH_COMPETITION_IDENTITY");
  requireValue(row.season?.id === season.id, "MATCH_SEASON_IDENTITY");
  requireValue(Number.isFinite(instant(row.utcDate)), "MATCH_KICKOFF_MISSING");
  const day = row.utcDate.slice(0, 10);
  requireValue(season.startDate <= day && day <= season.endDate, "MATCH_OUTSIDE_SEASON");
  requireValue(positiveId(row.homeTeam?.id) && positiveId(row.awayTeam?.id) && row.homeTeam.id !== row.awayTeam.id, "ORDERED_TEAM_IDS_MISSING");
  requireValue(typeof row.homeTeam.name === "string" && row.homeTeam.name.length > 0 && typeof row.awayTeam.name === "string" && row.awayTeam.name.length > 0, "TEAM_LABEL_MISSING");
  return row;
}

function regularResult(row, observedAt) {
  if (row.status !== "FINISHED") return { accepted: false, reason: "NOT_FINISHED" };
  if (!(instant(row.utcDate) < observedAt)) return { accepted: false, reason: "RESULT_NOT_BEFORE_OBSERVATION" };
  if (row.score?.duration !== "REGULAR") return { accepted: false, reason: "REGULAR_90_MINUTES_NOT_PROVEN" };
  if (![row.score.fullTime?.home, row.score.fullTime?.away].every(nonnegative)) return { accepted: false, reason: "FULL_TIME_SCORE_MISSING" };
  if (row.lastUpdated !== undefined && (!Number.isFinite(instant(row.lastUpdated)) || instant(row.lastUpdated) > observedAt)) return { accepted: false, reason: "UPDATE_CLOCK_INVALID" };
  return { accepted: true, providerMatchId: row.id, orderedProviderTeamIds: [row.homeTeam.id, row.awayTeam.id], kickoff: row.utcDate, score: [row.score.fullTime.home, row.score.fullTime.away], resultBasis: "provider-FINISHED-and-REGULAR-fullTime", independentlyVerified90Minutes: false, sourcePublishedAt: null, providerLastUpdated: row.lastUpdated || null };
}

function inspectMatches(payload, code, season, observedAt, targetDate) {
  requireValue(payload?.competition?.id === FREE_LEAGUES[code] && payload.competition.code === code, "MATCH_LIST_COMPETITION");
  requireValue(Array.isArray(payload.matches) && payload.matches.length <= 1000, "MATCH_LIST_SHAPE");
  requireValue(payload.resultSet?.count === payload.matches.length, "MATCH_LIST_COMPLETENESS_UNPROVEN");
  const ids = new Set();
  const validRows = [], quarantined = [];
  for (const [sourceIndex, row] of payload.matches.entries()) {
    requireValue(positiveId(row?.id), "MATCH_IDENTITY_MISSING");
    requireValue(!ids.has(row.id), "DUPLICATE_MATCH_ID");
    ids.add(row.id);
    try {
      validateMatch(row, code, season);
      validRows.push(row);
    } catch (error) {
      if (error.code !== "MATCH_OUTSIDE_SEASON") throw error;
      const attributionReliable = positiveId(row.homeTeam?.id) && positiveId(row.awayTeam?.id) && row.homeTeam.id !== row.awayTeam.id;
      quarantined.push({ sourceIndex, providerMatchId: row.id, rowSha256: sha256(JSON.stringify(row)), reason: error.code, kickoff: row.utcDate, kickoffReliable: Number.isFinite(instant(row.utcDate)), attributionReliable, orderedProviderTeamIds: attributionReliable ? [row.homeTeam.id, row.awayTeam.id] : null, status: row.status || null, metadataSeason: season, originalRow: row });
    }
  }
  const history = validRows.map(row => ({ row, result: regularResult(row, observedAt) }));
  return {
    rows: validRows, quarantined, responseCountSelfConsistent: true, sourceSeasonCompletenessVerified: false,
    discoveredFixtures: validRows.filter(row => businessDate(instant(row.utcDate)) === targetDate).map(row => ({ providerMatchId: row.id, competitionCode: code, seasonId: season.id, kickoff: row.utcDate, orderedProviderTeamIds: [row.homeTeam.id, row.awayTeam.id], names: [row.homeTeam.name, row.awayTeam.name], status: row.status, officialEventId: null, identityBindingApproved: false })),
    historyAccepted: history.filter(item => item.result.accepted).map(item => item.result),
    historyExcluded: [...history.filter(item => !item.result.accepted).map(item => ({ providerMatchId: item.row.id, reason: item.result.reason })), ...quarantined.map(item => ({ providerMatchId: item.providerMatchId, reason: item.reason }))],
    currentSeasonOnly: true, historicalSeasonsNotCollected: true,
  };
}

function inspectStandings(payload, code, season) {
  requireValue(payload?.competition?.id === FREE_LEAGUES[code] && payload.competition.code === code && payload.season?.id === season.id, "STANDINGS_SEASON_IDENTITY");
  const totals = payload.standings?.filter(row => row.type === "TOTAL" && row.stage === "REGULAR_SEASON" && row.group == null);
  requireValue(totals?.length === 1 && Array.isArray(totals[0].table) && totals[0].table.length > 0, "STANDINGS_TOTAL_AMBIGUOUS_OR_MISSING");
  const ids = new Set();
  return totals[0].table.map(row => {
    requireValue(positiveId(row.team?.id) && !ids.has(row.team.id), "STANDINGS_TEAM_IDENTITY");
    ids.add(row.team.id);
    requireValue([row.playedGames, row.won, row.draw, row.lost, row.goalsFor, row.goalsAgainst].every(nonnegative) && positiveId(row.position) && Number.isInteger(row.points), "STANDINGS_VALUES_MISSING");
    requireValue(row.playedGames === row.won + row.draw + row.lost && row.goalDifference === row.goalsFor - row.goalsAgainst, "STANDINGS_ARITHMETIC");
    return { providerTeamId: row.team.id, name: row.team.name || null, played: row.playedGames, points: row.points, rank: row.position, sourcePublishedAt: null };
  });
}

function inspectBinding(binding, matches, standings, season, code) {
  requireValue(typeof binding?.officialEventId === "string" && /^\d+$/.test(binding.officialEventId), "BINDING_OFFICIAL_ID");
  requireValue(Array.isArray(binding.orderedOfficialTeamIds) && binding.orderedOfficialTeamIds.length === 2 && binding.orderedOfficialTeamIds.every(positiveId) && binding.orderedOfficialTeamIds[0] !== binding.orderedOfficialTeamIds[1], "BINDING_OFFICIAL_TEAMS");
  requireValue(binding.competitionCode === code && binding.seasonId === season.id && positiveId(binding.providerMatchId), "BINDING_SEASON");
  requireValue(Array.isArray(binding.orderedProviderTeamIds) && binding.orderedProviderTeamIds.length === 2 && binding.orderedProviderTeamIds.every(positiveId), "BINDING_PROVIDER_TEAMS");
  requireValue(Number.isFinite(instant(binding.kickoff)) && /^[a-f0-9]{64}$/.test(binding.reviewEvidenceSha256 || ""), "BINDING_REVIEW_REQUIRED");
  const row = matches.rows.find(item => item.id === binding.providerMatchId);
  requireValue(row && instant(row.utcDate) === instant(binding.kickoff) && row.homeTeam.id === binding.orderedProviderTeamIds[0] && row.awayTeam.id === binding.orderedProviderTeamIds[1], "BINDING_ORDERED_ID_OR_KICKOFF_MISMATCH");
  const histories = binding.orderedProviderTeamIds.map(teamId => {
    const valid = matches.historyAccepted.filter(item => item.orderedProviderTeamIds.includes(teamId) && instant(item.kickoff) < instant(binding.kickoff)).sort((left, right) => instant(right.kickoff) - instant(left.kickoff));
    const affected = (matches.quarantined || []).filter(item => !item.attributionReliable || item.orderedProviderTeamIds.includes(teamId));
    const acceptedIds = new Set(matches.historyAccepted.map(item => item.providerMatchId));
    const excludedFinished = matches.rows.filter(item => item.status === "FINISHED" && !acceptedIds.has(item.id) && [item.homeTeam.id, item.awayTeam.id].includes(teamId) && instant(item.utcDate) < instant(binding.kickoff)).map(item => ({ providerMatchId: item.id, kickoff: item.utcDate, reason: matches.historyExcluded.find(excluded => excluded.providerMatchId === item.id)?.reason || "RESULT_UNAVAILABLE" }));
    const rankingUncertain = affected.some(item => !item.attributionReliable || !item.kickoffReliable || item.status !== "FINISHED");
    const latestSlots = [...valid.map(item => ({ kind: "valid", item })), ...affected.filter(item => item.kickoffReliable && instant(item.kickoff) < instant(binding.kickoff)).map(item => ({ kind: "quarantined", item })), ...excludedFinished.map(item => ({ kind: "excluded-finished", item }))].sort((left, right) => instant(right.item.kickoff) - instant(left.item.kickoff)).slice(0, 5);
    const rows = rankingUncertain ? [] : latestSlots.filter(slot => slot.kind === "valid").map(slot => slot.item);
    return { providerTeamId: teamId, scope: "current-season-league-only", rows, missing: Math.max(0, 5 - rows.length), completeFiveWithinObservedRows: !rankingUncertain && rows.length === 5, rankingUncertain, quarantineWithinLatestFive: latestSlots.filter(slot => slot.kind === "quarantined").map(slot => slot.item.providerMatchId), excludedFinishedWithinLatestFive: latestSlots.filter(slot => slot.kind === "excluded-finished").map(slot => slot.item), allRelatedQuarantineIds: affected.map(item => item.providerMatchId), candidateValidRowsNotCertifiedLatest: rankingUncertain ? valid.slice(0, 5) : [], standings: standings.find(item => item.providerTeamId === teamId) || null };
  });
  return { officialEventId: binding.officialEventId, providerMatchId: row.id, matchedCallerSuppliedIdentity: true, mappingAuthorityIndependentlyVerified: false, reviewEvidenceSha256: binding.reviewEvidenceSha256, histories, h2h: { rows: matches.historyAccepted.filter(item => item.orderedProviderTeamIds.every(teamId => binding.orderedProviderTeamIds.includes(teamId)) && instant(item.kickoff) < instant(binding.kickoff)), relatedQuarantineIds: (matches.quarantined || []).filter(item => !item.attributionReliable || item.orderedProviderTeamIds.every(teamId => binding.orderedProviderTeamIds.includes(teamId))).map(item => item.providerMatchId), complete: false, scope: "current-season-only-not-complete-historical-H2H" }, formalEligible: false };
}

function limiter(stateRoot, runtime) {
  const directory = safeDirectory(stateRoot);
  const ledger = safeDirectory(path.join(directory, "requests"));
  const lockFile = path.join(directory, "collector.lock");
  writeNew(lockFile, JSON.stringify({ version: VERSION, pid: process.pid, acquiredAt: iso(runtime.now()) }) + "\n");
  const held = fs.lstatSync(lockFile);
  let completedAt = runtime.now(), pendingRequest = false, lastReservedAt = null;
  return {
    async reserve() {
      const entries = fs.readdirSync(ledger);
      requireValue(entries.length <= 100000, "RATE_LEDGER_REVIEW_REQUIRED");
      const clocks = entries.map(name => {
        requireValue(/^\d{13}-[a-f0-9]{24}\.json$/.test(name), "RATE_LEDGER_INVALID");
        const file = path.join(ledger, name), stat = fs.lstatSync(file);
        requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "RATE_LEDGER_UNSAFE");
        return Number(name.slice(0, 13));
      }).sort((left, right) => left - right);
      let now = runtime.now();
      requireValue(clocks.every(clock => clock <= now), "CLOCK_MOVED_BACKWARD");
      const recent = clocks.filter(clock => clock > now - LIMITS.rollingWindowMs);
      const afterSpacing = clocks.length ? clocks.at(-1) + LIMITS.intervalMs : now;
      const afterWindow = recent.length >= LIMITS.requestsPerWindow ? recent.at(-LIMITS.requestsPerWindow) + LIMITS.rollingWindowMs : now;
      requireValue(completedAt <= now, "CLOCK_MOVED_BACKWARD");
      const afterCompletion = (pendingRequest ? now : completedAt) + LIMITS.intervalMs;
      const notBefore = Math.max(now, afterSpacing, afterWindow, afterCompletion);
      if (notBefore > now) await runtime.sleep(notBefore - now);
      now = runtime.now();
      requireValue(now >= notBefore, "RATE_WAIT_NOT_COMPLETED");
      writeNew(path.join(ledger, now + "-" + crypto.randomBytes(12).toString("hex") + ".json"), JSON.stringify({ requestedAt: iso(now) }) + "\n");
      lastReservedAt = now;
      pendingRequest = true;
    },
    completed() {
      const now = runtime.now();
      requireValue(pendingRequest && now >= lastReservedAt && now >= completedAt, "RATE_COMPLETION_CLOCK_INVALID");
      completedAt = now;
      pendingRequest = false;
    },
    release() {
      const current = fs.lstatSync(lockFile);
      requireValue(current.isFile() && !current.isSymbolicLink() && current.dev === held.dev && current.ino === held.ino, "RATE_LOCK_CHANGED");
      fs.unlinkSync(lockFile);
    },
  };
}

async function fetchOriginal(url, token, outputDirectory, ordinal, runtime) {
  requireValue(new URL(url).origin === new URL(API).origin && url.startsWith(API + "/competitions/"), "ENDPOINT_NOT_ALLOWLISTED");
  const requestedAt = iso(runtime.now()), abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIMITS.timeoutMs);
  timer.unref();
  let response, body = Buffer.alloc(0), complete = false, reason = null;
  const chunks = [];
  try {
    response = await runtime.fetch(url, { method: "GET", redirect: "manual", signal: abort.signal, headers: { "X-Auth-Token": token, Accept: "application/json", "Accept-Encoding": "identity" } });
    const reader = response.body?.getReader();
    requireValue(reader, "RESPONSE_BODY_MISSING");
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      total += part.value.byteLength;
      if (total > LIMITS.maxBodyBytes) { abort.abort(); reason = "RESPONSE_TOO_LARGE"; break; }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    reason = abort.signal.aborted ? "REQUEST_TIMEOUT_OR_ABORTED" : "REQUEST_FAILED";
  } finally { clearTimeout(timer); body = Buffer.concat(chunks); }
  const receivedAt = iso(runtime.now());
  const echoedCredential = body.includes(Buffer.from(token));
  const basename = String(ordinal).padStart(3, "0");
  const rawName = echoedCredential ? null : basename + (complete ? ".body" : ".partial.body");
  if (rawName) writeNew(path.join(outputDirectory, rawName), body);
  const headers = {};
  for (const name of ["content-type", "date", "last-modified", "etag", "x-requestcounter-reset", "x-requestsavailable"]) {
    const value = response?.headers.get(name);
    if (value && !value.includes(token)) headers[name] = value;
  }
  const receipt = { url, method: "GET", requestedAt, receivedAt, statusCode: response?.status || null, headers, auth: "X-Auth-Token: [REDACTED]", rawName, bytes: body.length, sha256: sha256(body), completeBody: complete, transport: "HTTPS response entity bytes; no redirect followed", credentialEchoDetected: echoedCredential, sourcePublishedAt: null, httpDateIsNotPublication: true };
  if (echoedCredential) reason = "CREDENTIAL_ECHO_NOT_PERSISTED";
  else if (!reason && !complete) reason = "RESPONSE_INCOMPLETE";
  else if (!reason && response.status !== 200) reason = response.status === 401 ? "AUTH_REJECTED" : response.status === 403 ? "PLAN_OR_COMPETITION_DENIED" : response.status === 429 ? "RATE_LIMITED" : "HTTP_NOT_OK";
  if (!reason && !/application\/json/i.test(headers["content-type"] || "")) reason = "NON_JSON_RESPONSE";
  let payload = null;
  if (!reason) { try { payload = JSON.parse(body.toString("utf8")); } catch { reason = "INVALID_JSON"; } }
  receipt.ok = reason === null;
  receipt.reason = reason;
  writeNew(path.join(outputDirectory, basename + ".receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return { receipt, payload };
}

async function collect(options, dependencies = {}) {
  const config = validateConfig(options);
  const env = dependencies.env || process.env;
  const token = env.FOOTBALL_DATA_ORG_TOKEN;
  if (typeof token !== "string" || token.trim() === "") return { version: VERSION, ok: false, status: "keymissing", requests: 0, productionWrites: 0, formalEligible: false };
  requireValue(/^[A-Za-z0-9_-]{16,256}$/.test(token), "TOKEN_FORMAT_INVALID");
  if (options.dryRun) return { version: VERSION, ok: false, status: "dry-run-key-configured-network-not-tested", requests: 0, productionWrites: 0, formalEligible: false };
  const runtime = { now: dependencies.now || Date.now, sleep: dependencies.sleep || (duration => new Promise(resolve => setTimeout(resolve, duration))), fetch: dependencies.fetch || globalThis.fetch };
  const stateRoot = dependencies.stateRoot || path.join(os.homedir(), ".football-predict", "football-data-org");
  const rate = limiter(stateRoot, runtime);
  let outputDirectory, requests = 0;
  try {
    outputDirectory = path.join(safeDirectory(path.join(stateRoot, "observations")), runtime.now() + "-" + crypto.randomBytes(12).toString("hex"));
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const report = { version: VERSION, startedAt: iso(runtime.now()), config, requests: 0, competitions: [], researchOnly: true, formalEligible: false, independentSourceApproved: false, productionWrites: 0, modelWrites: 0, publicationWrites: 0, missingCapabilities: ["Sporttery signed SP", "independently reviewed official-event bindings", "independent second source", "verified source publication clocks", "three-day injuries and suspensions", "confirmed lineups", "complete historical H2H", "validated prediction probability"] };
    const request = async suffix => {
      requireValue(requests < config.maxRequests, "REQUEST_BUDGET_EXHAUSTED");
      await rate.reserve();
      requests += 1;
      const result = await fetchOriginal(API + suffix, token, outputDirectory, requests, runtime);
      rate.completed();
      if (!result.receipt.ok) fail(result.receipt.reason);
      return result;
    };
    for (const code of config.competitions) {
      const partialSources=[];let partialSeason;
      try {
        const metadata = await request("/competitions/" + code);
        const season = currentSeason(metadata.payload, code, runtime.now(), config.businessDate);
        partialSeason=season;partialSources.push(metadata.receipt);
        const matchResponse = await request("/competitions/" + code + "/matches?season=" + season.year);
        const matches = inspectMatches(matchResponse.payload, code, season, runtime.now(), config.businessDate);
        partialSources.push(matchResponse.receipt);
        const tableResponse = await request("/competitions/" + code + "/standings?season=" + season.year);
        const standings = inspectStandings(tableResponse.payload, code, season);
        partialSources.push(tableResponse.receipt);
        const bindings = (options.bindings || []).filter(binding => binding.competitionCode === code).map(binding => {
          try { return inspectBinding(binding, matches, standings, season, code); } catch (error) { return { officialEventId: binding.officialEventId || null, matchedCallerSuppliedIdentity: false, reason: error.code || "BINDING_INVALID", formalEligible: false }; }
        });
        report.competitions.push({ code, season, status: matches.quarantined.length ? "partial-research-only" : "collected-research-only", discoveredFixtures: matches.discoveredFixtures, historyAccepted: matches.historyAccepted, historyExcluded: matches.historyExcluded, quarantined: matches.quarantined, responseCountSelfConsistent: matches.responseCountSelfConsistent, sourceSeasonCompletenessVerified: false, standings, bindings, sourceReceipts: [metadata.receipt, matchResponse.receipt, tableResponse.receipt] });
      } catch (error) {
        const reason = error.code || "COLLECTION_FAILED";
        report.competitions.push({ code, status: "blocked", reason, ...(partialSeason?{season:partialSeason,partialSources}:{}) });
        if (["AUTH_REJECTED", "RATE_LIMITED", "CREDENTIAL_ECHO_NOT_PERSISTED", "CLOCK_MOVED_BACKWARD"].includes(reason)) break;
      }
    }
    report.requests = requests;
    report.finishedAt = iso(runtime.now());
    report.ok = report.competitions.length === config.competitions.length && report.competitions.every(item => item.status === "collected-research-only");
    report.status = report.ok ? "collected-research-only" : "blocked";
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
    writeNew(path.join(outputDirectory, "report.json"), bytes);
    return { version: VERSION, ok: report.ok, status: report.status, requests, outputDirectory, reportSha256: sha256(bytes), competitions: report.competitions.map(item => ({ code: item.code, status: item.status, reason: item.reason || null, discovered: item.discoveredFixtures?.length || 0 })), productionWrites: 0, formalEligible: false };
  } finally { rate.release(); }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") { requireValue(!options.dryRun, "DUPLICATE_OPTION"); options.dryRun = true; continue; }
    requireValue(["--competitions", "--business-date", "--max-requests", "--bindings"].includes(key), "UNKNOWN_OPTION");
    requireValue(argv[index + 1] && !Object.hasOwn(options, key), "OPTION_VALUE_REQUIRED");
    options[key] = argv[++index];
  }
  let bindings = [];
  if (options["--bindings"]) {
    const stat = fs.lstatSync(options["--bindings"]);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, "BINDINGS_FILE_INVALID");
    bindings = JSON.parse(fs.readFileSync(options["--bindings"], "utf8"));
    requireValue(Array.isArray(bindings) && bindings.length <= 100, "BINDINGS_SHAPE");
  }
  return { competitions: (options["--competitions"] || "").split(","), businessDate: options["--business-date"], maxRequests: options["--max-requests"] === undefined ? undefined : Number(options["--max-requests"]), dryRun: options.dryRun || false, bindings };
}

if (require.main === module) {
  Promise.resolve().then(() => collect(parseCli(process.argv.slice(2)))).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.ok) process.exitCode = 2;
  }).catch(error => {
    process.stdout.write(JSON.stringify({ version: VERSION, ok: false, status: "blocked", reason: error.code || "LOCAL_VALIDATION_FAILED", productionWrites: 0, formalEligible: false }) + "\n");
    process.exitCode = 2;
  });
}

module.exports = { VERSION, LIMITS, FREE_LEAGUES, validateConfig, currentSeason, regularResult, inspectMatches, inspectStandings, inspectBinding, limiter, fetchOriginal, collect, parseCli };
