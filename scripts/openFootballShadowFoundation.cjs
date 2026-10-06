"use strict";

// Public CC0 results, not official Sporttery results or historical quotes.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { TextDecoder } = require("node:util");
const { iterateHistoricalEvents, normalizeEntity, sha256, stableStringify } = require("./historicalEventStore.cjs");
const { importHistoricalCsvToWarehouse, historicalWarehouseStatus, queryHistoricalEventsAsOf } = require("./historicalTrainingWarehouse.cjs");
const { buildHistoricalAsOfFeatureArtifact, verifyHistoricalAsOfFeatureArtifact } = require("./historicalAsOfFeatureBuilder.cjs");
const { recordSourceObservation, auditObservationStore } = require("./openFootballObservationStore.cjs");

const VERSION = "openfootball-shadow-foundation-v1";
const REPOSITORY = "https://github.com/openfootball/football.json";
const SEASONS = Object.freeze(["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]);
const LEAGUES = Object.freeze([
  Object.freeze({ code: "en.1", division: "EPL", name: /Premier League/, expectedRows: 380 }),
  Object.freeze({ code: "de.1", division: "Bundesliga", name: /Bundesliga/, expectedRows: 306 }),
  Object.freeze({ code: "es.1", division: "LaLiga", name: /Primera|La Liga|LaLiga/, expectedRows: 380 }),
]);
const MAX_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 2;
const hash = (body) => sha256(Buffer.isBuffer(body) ? body : Buffer.from(stableStringify(body)));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function instant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("INVALID_OBSERVATION_CLOCK", "canonical UTC observation clock required");
  return value;
}
function sourceUrl(commit, file) {
  if (!/^[a-f0-9]{40}$/.test(commit || "")) fail("INVALID_SOURCE_COMMIT", "an explicit 40-character source commit is required");
  const permitted = file === "LICENSE.md" || SEASONS.some((season) => LEAGUES.some((league) => file === `${season}/${league.code}.json`));
  if (!permitted) fail("SOURCE_NOT_ALLOWLISTED", "source file is outside three leagues and five seasons");
  return `https://raw.githubusercontent.com/openfootball/football.json/${commit}/${file}`;
}
function parsePinnedUrl(url) {
  const match = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/openfootball\/football\.json\/([a-f0-9]{40})\/(.+)$/);
  if (!match || sourceUrl(match[1], match[2]) !== url) fail("SOURCE_NOT_ALLOWLISTED", "fixed official raw source URL required");
}
function download(url) {
  parsePinnedUrl(url);
  const requestedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    let settled = false; let timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const request = https.get(url, { timeout: 20000, headers: { "User-Agent": "football-shadow-foundation/1.0", Accept: "text/plain, application/json" } }, (response) => {
      // No redirects, authentication, cached fallback, or alternate mirrors.
      if (response.statusCode !== 200) { response.resume(); finish(Object.assign(new Error(`source returned HTTP ${response.statusCode}`), { code: "SOURCE_HTTP_FAILED" })); return; }
      const chunks = []; let bytes = 0;
      response.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_BYTES) response.destroy(Object.assign(new Error("source exceeded bounded size"), { code: "SOURCE_TOO_LARGE" })); else chunks.push(chunk); });
      response.on("error", (error) => finish(error));
      response.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
          if (text.includes("\uFFFD")) fail("SOURCE_INVALID_TEXT", "replacement characters are not accepted");
          const acquiredAt = new Date().toISOString();
          finish(null, { raw, text, requestedAt, acquiredAt, sourceUrl: url, fileSha256: hash(raw), bytes: raw.length, etag: response.headers.etag || null, lastModified: response.headers["last-modified"] || null });
        } catch (error) { finish(error); }
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("source timed out"), { code: "SOURCE_TIMEOUT" })));
    request.on("error", (error) => finish(error));
    timer = setTimeout(() => request.destroy(Object.assign(new Error("source exceeded total wall deadline"), { code: "SOURCE_TIMEOUT" })), 20000);
  });
}
function csvCell(value) { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function parseSource(raw, league, season) {
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!LEAGUES.includes(league) || !SEASONS.includes(season) || typeof document.name !== "string" || !league.name.test(document.name) || !document.name.includes(season.replace("-", "/")) || !Array.isArray(document.matches) || document.matches.length > 500) fail("SOURCE_SCHEMA_FAILED", "league, season, or bounded match schema mismatch");
  const rows = []; const seen = new Set(); let missingResults = 0; let arrayScores = 0;
  for (const match of document.matches) {
    const date = match?.date;
    const startYear = Number(season.slice(0, 4));
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date || date < `${startYear}-07-01` || date >= `${startYear + 1}-07-01`) fail("SOURCE_DATE_FAILED", "invalid or out-of-season calendar date");
    const home = match.team1; const away = match.team2;
    if (typeof home !== "string" || typeof away !== "string" || home.length > 180 || away.length > 180 || !normalizeEntity(home) || !normalizeEntity(away) || normalizeEntity(home) === normalizeEntity(away)) fail("SOURCE_TEAM_FAILED", "invalid distinct club identities");
    const score = Array.isArray(match.score) ? match.score : match.score?.ft;
    if (score === undefined || score === null) { missingResults += 1; continue; }
    if (!Array.isArray(score) || score.length !== 2 || score.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 99)) fail("SOURCE_SCORE_FAILED", "only explicit two-integer full-time result labels are accepted");
    if (Array.isArray(match.score)) arrayScores += 1;
    const identity = `${date}|${normalizeEntity(home)}|${normalizeEntity(away)}`;
    if (seen.has(identity)) fail("SOURCE_DUPLICATE_EVENT", "duplicate event in source file");
    seen.add(identity);
    // Local time has no documented timezone. Do not invent UTC kickoff or use ht.
    rows.push({ division: league.division, date, home, away, scoreHome: score[0], scoreAway: score[1] });
  }
  if (rows.length === 0) fail("SOURCE_EMPTY_RESULTS", "no result labels were supplied");
  const csv = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\n" + rows.map((row) => [row.division, row.date, row.home, row.away, row.scoreHome, row.scoreAway].map(csvCell).join(",")).join("\n") + "\n";
  return { csv, rows, missingResults, arrayScores, expectedRows: league.expectedRows, completeExpectedCount: rows.length === league.expectedRows };
}
function assertObservation(observation, raw) {
  parsePinnedUrl(observation.sourceUrl);
  instant(observation.requestedAt); instant(observation.acquiredAt); instant(observation.localAvailableAt);
  if (observation.requestedAt > observation.acquiredAt || observation.acquiredAt > observation.localAvailableAt || observation.bytes !== raw.length || hash(raw) !== observation.fileSha256 || observation.providerAvailableAt !== null || observation.historicalAvailabilityProven !== false) fail("SOURCE_OBSERVATION_FAILED", "source hash or separate acquisition/availability clocks failed");
  return observation;
}
function exclusiveWrite(file, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const descriptor = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return hash(bytes);
}
function privateOutput(root, output) {
  const base = path.resolve(root, ".codex-tmp", "history-foundation");
  const resolved = path.resolve(output || "");
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) fail("SHADOW_PATH_REQUIRED", "output must be a new run below this worktree's .codex-tmp/history-foundation");
  let cursor = path.dirname(resolved);
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail("SHADOW_PATH_SYMLINK", "shadow output ancestors must not be links");
    if (cursor === path.resolve(root)) break;
    cursor = path.dirname(cursor);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.mkdirSync(resolved, { mode: 0o700 }); // Never reuse/overwrite another run.
  return resolved;
}
const auditAdapter = Object.freeze({
  version: "zero-market-coverage-audit-adapter-v1",
  createState: () => ({ rows: 0 }),
  captureFeature: (state) => ({ features: { priorObservedResultRows: state.rows }, probabilities: null }),
  applyResultBatch: (state, rows) => { state.rows += rows.length; },
  serializeState: (state) => ({ ...state }),
});
async function canonicalEvents(csv, config) {
  const iterator = iterateHistoricalEvents({ dataset: config, input: csv }); const events = [];
  while (true) { const step = await iterator.next(); if (step.done) return { events, manifest: step.value }; events.push(step.value); }
}
async function boundedMap(items, fn) {
  const values = new Array(items.length); let cursor = 0; let failure = null;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (!failure && cursor < items.length) { const index = cursor++; try { values[index] = await fn(items[index], index); } catch (error) { failure ||= error; } } }));
  if (failure) throw failure;
  return values;
}
function coverageAudit(files, events, artifact) {
  return {
    rows: events.length, sourceFiles: files.length,
    strata: { clubLeagueRows: events.length, nationalTeamRows: 0, crossStratumTrainingAllowed: false },
    leagueSeasons: files.map((file) => ({ league: file.league, season: file.season, rows: file.rows, expectedRows: file.expectedRows, completeExpectedCount: file.completeExpectedCount, missingResults: file.missingResults })),
    marketSnapshots: { HAD: 0, HHAD: 0, asianHandicap: 0, totalGoals: 0, closing: 0, fiveTimepointEvents: 0, providerQuoteTimestampRows: 0 },
    clocks: { locallyObservedRows: events.length, providerHistoricalAvailabilityRows: 0, fabricatedHistoricalAvailableAtRows: 0, exactUtcKickoffRows: 0 },
    historicalFeatureCoverage: { rowsWithPriorObservedResults: artifact.snapshots.filter((row) => row.features.priorObservedResultRows > 0).length, snapshots: artifact.snapshots.length },
    productionEligible: false, strictPromotionEligible: false,
    blockers: ["HISTORICAL_PROVIDER_AVAILABILITY_UNKNOWN", "HISTORICAL_MARKET_SNAPSHOTS_ABSENT", "INTERNATIONAL_STRATUM_ABSENT", "EXACT_KICKOFF_TIMEZONE_UNKNOWN", "LINEUPS_INJURIES_XG_WEATHER_ABSENT", "COMMUNITY_RESULTS_NOT_OFFICIAL_SETTLEMENT"],
  };
}
async function collectShadowFoundation({ rootDir, output, commit, fetchSource = download }) {
  sourceUrl(commit, "LICENSE.md");
  const runDir = privateOutput(rootDir, output);
  const rawDir = path.join(runDir, "raw"); const csvDir = path.join(runDir, "normalized");
  fs.mkdirSync(rawDir, { mode: 0o700 }); fs.mkdirSync(csvDir, { mode: 0o700 });
  const writeJson = (file, value) => exclusiveWrite(path.join(runDir, file), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const license = await fetchSource(sourceUrl(commit, "LICENSE.md"));
    const licenseObservation = assertObservation({ ...license, raw: undefined, text: undefined, localAvailableAt: new Date().toISOString(), providerAvailableAt: null, historicalAvailabilityProven: false }, license.raw);
    if (license.sourceUrl !== sourceUrl(commit, "LICENSE.md") || !new TextDecoder("utf-8", { fatal: true }).decode(license.raw).includes("CC0 1.0 Universal")) fail("SOURCE_LICENSE_FAILED", "fixed commit must include the CC0 license");
    exclusiveWrite(path.join(rawDir, "LICENSE.md"), license.raw);
    const jobs = SEASONS.flatMap((season) => LEAGUES.map((league) => ({ season, league })));
    // Only network fetch and parse are concurrent. SQLite activation stays single writer.
    const downloaded = await boundedMap(jobs, async ({ season, league }) => {
      const url = sourceUrl(commit, `${season}/${league.code}.json`);
      const source = await fetchSource(url);
      if (source.sourceUrl !== url) fail("SOURCE_REQUEST_BINDING_FAILED", "response must bind the exact requested commit and file");
      const parsed = parseSource(source.raw, league, season);
      const stem = `${season}-${league.code}`;
      exclusiveWrite(path.join(rawDir, `${stem}.json`), source.raw);
      const csvSha256 = exclusiveWrite(path.join(csvDir, `${stem}.csv`), parsed.csv);
      const localAvailableAt = new Date().toISOString();
      const observation = assertObservation({ ...source, raw: undefined, text: undefined, localAvailableAt, providerAvailableAt: null, historicalAvailabilityProven: false }, source.raw);
      return { ...parsed, observation, stem, season, league: league.code, csvSha256 };
    });
    const dbPath = path.join(runDir, "historical-shadow.sqlite");
    const observationStore = path.join(runDir, "observations");
    const files = []; const observedEvents = [];
    // Preserve complete-response clock order despite concurrent requests.
    downloaded.sort((a, b) => a.observation.acquiredAt.localeCompare(b.observation.acquiredAt) || a.stem.localeCompare(b.stem));
    for (const file of downloaded) {
      const receipt = recordSourceObservation({ storeDir: observationStore, season: file.season, league: file.league, sourceCommit: commit, raw: fs.readFileSync(path.join(rawDir, `${file.stem}.json`)), requestStartedAt: file.observation.requestedAt, receivedAt: file.observation.acquiredAt });
      const dataset = { adapter: "football-data", sourceDataset: `openfootball/football.json:${file.league}:${file.season}`, sourceUrl: file.observation.sourceUrl, license: "CC0-1.0" };
      const canonical = await canonicalEvents(file.csv, dataset);
      if (canonical.manifest.rejectedRows || canonical.events.length !== file.rows.length || canonical.events.some((event) => event.preMatchOdds || event.kickoff !== null)) fail("NORMALIZATION_FAILED", "score-only canonical projection mismatch");
      const imported = await importHistoricalCsvToWarehouse({ dbPath, dataset, filePath: path.join(csvDir, `${file.stem}.csv`), createdAt: file.observation.localAvailableAt, completedAt: new Date().toISOString(), allowRejectedRows: false });
      if (!imported.ok) fail("SHADOW_IMPORT_FAILED", "canonical shadow warehouse import did not activate");
      for (const event of canonical.events) observedEvents.push({ ...event, availableAt: file.observation.localAvailableAt, teamType: "club", availabilityScope: "local-observation-only", providerAvailableAt: null });
      files.push({ league: file.league, season: file.season, rows: file.rows.length, expectedRows: file.expectedRows, completeExpectedCount: file.completeExpectedCount, missingResults: file.missingResults, legacyArrayScores: file.arrayScores, csvSha256: file.csvSha256, canonicalRootHash: canonical.manifest.rootHash, importId: imported.importId, observation: file.observation, receipt });
    }
    const generatedAt = new Date().toISOString();
    const artifact = buildHistoricalAsOfFeatureArtifact(observedEvents, auditAdapter);
    const verification = verifyHistoricalAsOfFeatureArtifact(artifact);
    if (verification !== true) fail("ASOF_ARTIFACT_FAILED", "as-of audit artifact failed existing verifier");
    const strict = queryHistoricalEventsAsOf({ dbPath, forecastTime: generatedAt });
    if (strict.rows !== 0 || strict.integrity.derivedAvailabilityAllowed) fail("DERIVED_AVAILABILITY_LEAK", "derived warehouse timestamps must remain excluded by default");
    const audit = coverageAudit(files, observedEvents, artifact);
    const artifactSha256 = writeJson("asof-feature-audit.json", artifact);
    const eventSha256 = writeJson("locally-observed-events.json", observedEvents);
    writeJson("zero-market-data-inventory.json", { version: VERSION, generatedAt, available: ["club identity and division", "date-only full-time result labels", "future as-of local observation receipts"], excludedModelInputs: ["odds", "closing prices", "five-timepoint movement", "post-match ht and statistics as same-match predictors"], missing: audit.blockers, sourceMarketInputs: 0, existingModelWeightsChanged: false, modelTrained: false, trainingPromotionEligible: false });
    const manifest = { version: VERSION, ok: true, generatedAt, sourceCommit: commit, repository: REPOSITORY, license: "CC0-1.0", licenseEvidence: licenseObservation, sourcePermissionReview: { footballData: "excluded: provider restricts automated data-training use", policyUrl: "https://football-data.co.uk/contact.php", verifiedDate: "2026-10-06" }, concurrency: CONCURRENCY, writes: "isolated-private-shadow-only", productionWrites: 0, previousLocalMatchInputsRead: 0, sourceVerifiedForOfficialSettlement: false, files, audit, observationStore: auditObservationStore(observationStore), warehouse: historicalWarehouseStatus(dbPath), strictAsOf: { rows: strict.rows, derivedRowsExcluded: strict.integrity.derivedRowsExcluded, queryPolicy: strict.queryPolicy }, asOfVerification: verification, bindings: { artifactSha256, eventSha256 } };
    manifest.contentHash = hash(manifest);
    writeJson("manifest.json", manifest);
    return { ok: true, output: runDir, manifestSha256: hash(fs.readFileSync(path.join(runDir, "manifest.json"))), contentHash: manifest.contentHash, audit, warehouse: manifest.warehouse };
  } catch (error) {
    writeJson("failure.json", { ok: false, observedAt: new Date().toISOString(), code: error.code || "SHADOW_FOUNDATION_FAILED", message: error.message, productionWrites: 0 });
    throw error;
  }
}
async function runShadowFoundationCli(args) {
  const allowed = new Set(["--shadow-foundation", "--source-commit", "--output"]); const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]; if (!allowed.has(arg) || Object.hasOwn(values, arg)) fail("INVALID_SHADOW_ARGUMENT", "only explicit bounded shadow arguments are allowed");
    values[arg] = arg === "--shadow-foundation" ? true : args[++index];
  }
  if (!values["--shadow-foundation"] || !values["--output"]) fail("INVALID_SHADOW_ARGUMENT", "shadow flag and explicit private output required");
  const result = await collectShadowFoundation({ rootDir: path.resolve(__dirname, ".."), output: values["--output"], commit: values["--source-commit"] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result;
}
module.exports = { VERSION, LEAGUES, SEASONS, sourceUrl, download, parseSource, assertObservation, privateOutput, boundedMap, coverageAudit, canonicalEvents, auditAdapter, collectShadowFoundation, runShadowFoundationCli };
