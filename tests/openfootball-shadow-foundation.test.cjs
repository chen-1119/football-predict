"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const foundation = require("../scripts/openFootballShadowFoundation.cjs");
const { sha256 } = require("../scripts/historicalEventStore.cjs");
const { importHistoricalCsvToWarehouse, historicalWarehouseStatus, queryHistoricalEventsAsOf } = require("../scripts/historicalTrainingWarehouse.cjs");
const { buildHistoricalAsOfFeatureArtifact, verifyHistoricalAsOfFeatureArtifact } = require("../scripts/historicalAsOfFeatureBuilder.cjs");
const { recordSourceObservation, auditObservationStore, buildObservationReceipt, hashObject } = require("../scripts/openFootballObservationStore.cjs");
const { sourceUrl: observationSourceUrl, inspectSource } = require("../scripts/auditOpenFootballCurrentSeason.cjs");
const commit = "e6744429ee395bc86f247348c6184bb08d4eb361";
const league = foundation.LEAGUES[0]; const season = foundation.SEASONS[0];
const fixture = (change = {}) => ({ name: "English Premier League 2021/22", matches: [{ date: "2021-08-15", team1: "Club A", team2: "Club B", score: { ft: [2, 1], ht: [1, 0] }, ...change }] });
const raw = (body) => Buffer.from(JSON.stringify(body));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-shadow-foundation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const output = (root, name) => path.join(root, ".codex-tmp", "history-foundation", name);
function response(url, body) {
  const bytes = typeof body === "string" ? Buffer.from(body) : raw(body);
  const clock = new Date().toISOString();
  return { sourceUrl: url, raw: bytes, text: bytes.toString("utf8"), fileSha256: sha256(bytes), bytes: bytes.length, requestedAt: clock, acquiredAt: clock, etag: null, lastModified: "Wed, 01 Jan 2020 00:00:00 GMT" };
}
const fakeFetch = async (url) => {
  if (url.endsWith("LICENSE.md")) return response(url, "CC0 1.0 Universal\n");
  const match = url.match(/\/(\d{4}-\d{2})\/(en|de|es)\.1\.json$/);
  const name = { en: "English Premier League", de: "Deutsche Bundesliga", es: "Primera División de España" }[match[2]];
  return response(url, { name: `${name} ${match[1].replace("-", "/")}`, matches: [{ date: `${match[1].slice(0, 4)}-08-15`, team1: "Club A", team2: "Club B", score: { ft: [2, 1] } }] });
};
test("bounds exactly three club leagues and five complete seasons", () => {
  assert.equal(foundation.LEAGUES.length, 3); assert.equal(foundation.SEASONS.length, 5);
  assert.equal(foundation.sourceUrl(commit, `${season}/en.1.json`), `https://raw.githubusercontent.com/openfootball/football.json/${commit}/${season}/en.1.json`);
});
for (const [name, value] of [["branch", "master"], ["short hash", "1234567"], ["uppercase hash", commit.toUpperCase()], ["query injected", `${commit}?x=1`]]) test(`rejects non-pinned ${name}`, () => assert.throws(() => foundation.sourceUrl(value, `${season}/en.1.json`), { code: "INVALID_SOURCE_COMMIT" }));
for (const file of ["2020-21/en.1.json", "2026-27/en.1.json", "2021-22/en.2.json", "../../LICENSE.md", "2021-22/en.1-full.json"]) test(`rejects out of scope ${file}`, () => assert.throws(() => foundation.sourceUrl(commit, file), { code: "SOURCE_NOT_ALLOWLISTED" }));
test("normalizes only FT labels and omits ht, odds, timezone-unknown local times", () => {
  const parsed = foundation.parseSource(raw(fixture({ time: "20:00", odds: { home: 2 } })), league, season);
  assert.equal(parsed.rows[0].scoreHome, 2); assert.equal(parsed.csv, "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\nEPL,2021-08-15,Club A,Club B,2,1\n");
  assert.equal(parsed.completeExpectedCount, false);
});
test("source legacy two-number array is explicit label only", () => assert.equal(foundation.parseSource(raw(fixture({ score: [0, 0] })), league, season).arrayScores, 1));
for (const [name, change, code] of [
  ["negative", { score: { ft: [-1, 0] } }, "SOURCE_SCORE_FAILED"],
  ["string zero", { score: { ft: ["0", 0] } }, "SOURCE_SCORE_FAILED"],
  ["third score", { score: [1, 2, 3] }, "SOURCE_SCORE_FAILED"],
  ["same club", { team2: "club a" }, "SOURCE_TEAM_FAILED"],
  ["foreign season", { date: "2020-09-01" }, "SOURCE_DATE_FAILED"],
  ["invalid date", { date: "2021-02-31" }, "SOURCE_DATE_FAILED"],
]) test(`rejects ${name}`, () => assert.throws(() => foundation.parseSource(raw(fixture(change)), league, season), { code }));
test("et and penalties cannot substitute missing ft and missing is never 0-0", () => assert.throws(() => foundation.parseSource(raw(fixture({ score: { et: [1, 0], p: [3, 2] } })), league, season), { code: "SOURCE_EMPTY_RESULTS" }));
test("duplicate event source rows fail rather than add samples", () => { const body = fixture(); body.matches.push(body.matches[0]); assert.throws(() => foundation.parseSource(raw(body), league, season), { code: "SOURCE_DUPLICATE_EVENT" }); });
test("CSV escaping keeps comma and quoted team identity", () => { const parsed = foundation.parseSource(raw(fixture({ team1: 'Club "A", town' })), league, season); assert.match(parsed.csv, /"Club ""A"", town"/); });
test("acquisition and local availability clocks are hash bound; last-modified is not availability", () => {
  const result = response(foundation.sourceUrl(commit, `${season}/en.1.json`), fixture());
  const observation = { ...result, localAvailableAt: result.acquiredAt, providerAvailableAt: null, historicalAvailabilityProven: false };
  assert.equal(foundation.assertObservation(observation, result.raw).providerAvailableAt, null);
  for (const alteration of [{ fileSha256: "0".repeat(64) }, { bytes: 1 }, { localAvailableAt: "2020-01-01T00:00:00.000Z" }, { providerAvailableAt: observation.lastModified }, { historicalAvailabilityProven: true }]) assert.throws(() => foundation.assertObservation({ ...observation, ...alteration }, result.raw), { code: "SOURCE_OBSERVATION_FAILED" });
});
test("private output rejects existing and outside-run paths", (t) => {
  const root = temporary(t); assert.throws(() => foundation.privateOutput(root, path.join(root, "server-data")), { code: "SHADOW_PATH_REQUIRED" });
  foundation.privateOutput(root, output(root, "first")); assert.throws(() => foundation.privateOutput(root, output(root, "first")), { code: "EEXIST" });
});
test("private output rejects linked ancestors", (t) => {
  const root = temporary(t); const base = path.join(root, ".codex-tmp", "history-foundation"); fs.mkdirSync(base, { recursive: true });
  const target = path.join(root, "other"); fs.mkdirSync(target); fs.symlinkSync(target, path.join(base, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => foundation.privateOutput(root, path.join(base, "link", "run")), { code: "SHADOW_PATH_SYMLINK" });
});
test("bounded fetch drains in-flight work and starts no new work after failure", async () => {
  let active = 0; let maximum = 0; let finished = 0;
  await foundation.boundedMap([1, 2, 3, 4, 5], async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--; finished++; });
  assert.equal(maximum, 2); assert.equal(finished, 5);
  active = 0; finished = 0;
  await assert.rejects(foundation.boundedMap([1, 2, 3, 4], async (value) => { active++; await new Promise((resolve) => setTimeout(resolve, value === 1 ? 1 : 5)); active--; finished++; if (value === 1) throw new Error("stop"); }), /stop/);
  assert.equal(active, 0); assert.equal(finished, 2);
});
test("real canonical warehouse + existing as-of builder preserve strict exclusion and append-only IDs", async (t) => {
  const root = temporary(t); const result = await foundation.collectShadowFoundation({ rootDir: root, output: output(root, "pipeline"), commit, fetchSource: fakeFetch });
  assert.equal(result.audit.rows, 15); assert.equal(result.warehouse.events, 15); assert.equal(result.warehouse.conflicts, 0);
  assert.equal(result.audit.historicalFeatureCoverage.rowsWithPriorObservedResults, 0);
  assert.equal(result.audit.strata.nationalTeamRows, 0); assert.deepEqual(Object.values(result.audit.marketSnapshots), Array(7).fill(0));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, "manifest.json")));
  assert.equal(manifest.strictAsOf.rows, 0); assert.equal(manifest.strictAsOf.derivedRowsExcluded, 15); assert.equal(manifest.asOfVerification, true);
  assert.equal(manifest.observationStore.ok, true); assert.equal(manifest.observationStore.observations, 15);
  assert.ok(manifest.files.every((entry) => entry.receipt.sourceUrl === entry.observation.sourceUrl && entry.receipt.contentSha256 === entry.observation.fileSha256 && entry.receipt.sourceCommit === commit));
  const observed = JSON.parse(fs.readFileSync(path.join(result.output, "locally-observed-events.json")));
  assert.ok(observed.every((event) => event.kickoff === null && event.providerAvailableAt === null && !event.preMatchOdds));
  assert.ok(observed.every((event) => Date.parse(event.availableAt) > Date.parse(`${event.date}T00:00:00Z`)));
  const file = manifest.files[0]; const dataset = { adapter: "football-data", sourceDataset: `openfootball/football.json:${file.league}:${file.season}`, sourceUrl: file.observation.sourceUrl, license: "CC0-1.0" };
  const imported = await importHistoricalCsvToWarehouse({ dbPath: path.join(result.output, "historical-shadow.sqlite"), dataset, filePath: path.join(result.output, "normalized", `${file.season}-${file.league}.csv`), createdAt: manifest.generatedAt, completedAt: manifest.generatedAt, allowRejectedRows: false });
  assert.equal(imported.idempotent, true); assert.equal(historicalWarehouseStatus(path.join(result.output, "historical-shadow.sqlite")).events, 15);
  assert.equal(queryHistoricalEventsAsOf({ dbPath: path.join(result.output, "historical-shadow.sqlite"), forecastTime: manifest.generatedAt }).rows, 0);
  const artifact = buildHistoricalAsOfFeatureArtifact(observed, foundation.auditAdapter); assert.equal(verifyHistoricalAsOfFeatureArtifact(artifact), true);
  const modified = structuredClone(artifact); modified.labels[0].availableAt = "2020-01-01T00:00:00.000Z"; assert.equal(verifyHistoricalAsOfFeatureArtifact(modified), false);
});
test("mismatched job provenance fails before any warehouse activation", async (t) => {
  const root = temporary(t); const folder = output(root, "mismatch");
  await assert.rejects(foundation.collectShadowFoundation({ rootDir: root, output: folder, commit, fetchSource: async (url) => { const value = await fakeFetch(url); if (!url.endsWith("LICENSE.md")) value.sourceUrl = foundation.sourceUrl(commit, "2021-22/en.1.json"); return value; } }), { code: "SOURCE_REQUEST_BINDING_FAILED" });
  assert.equal(fs.existsSync(path.join(folder, "manifest.json")), false); assert.equal(fs.existsSync(path.join(folder, "historical-shadow.sqlite")), false); assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "failure.json"))).productionWrites, 0);
});
test("raw license and exact license source must match; forged text is insufficient", async (t) => {
  const root = temporary(t);
  await assert.rejects(foundation.collectShadowFoundation({ rootDir: root, output: output(root, "license"), commit, fetchSource: async (url) => ({ ...response(url, "not a license"), text: "CC0 1.0 Universal" }) }), { code: "SOURCE_LICENSE_FAILED" });
});
test("explicit shadow CLI rejects old-index arguments before default augmentation", (t) => {
  const root = temporary(t); const marker = path.join(root, "do-not-read.json"); fs.writeFileSync(marker, "not json");
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/augmentHistoricalTrainingFromOpenFootball.cjs"), "--shadow-foundation", "--output", output(root, "cli"), "--input", marker], { encoding: "utf8", env: { ...process.env, HISTORICAL_TRAINING_INDEX_PATH: marker } });
  assert.equal(result.status, 1); assert.match(result.stderr, /INVALID_SHADOW_ARGUMENT/); assert.equal(fs.readFileSync(marker, "utf8"), "not json");
});
test("pinned observations reuse existing append-only firstObserved chain without restamping", (t) => {
  const root = temporary(t); const storeDir = path.join(root, "receipts");
  const bytes = raw(fixture()); const clock = "2026-10-06T15:00:00.000Z";
  const args = { storeDir, season, league: league.code, sourceCommit: commit, raw: bytes, requestStartedAt: clock, receivedAt: clock };
  const first = recordSourceObservation(args); const second = recordSourceObservation({ ...args, receivedAt: "2026-10-06T15:00:01.000Z" });
  assert.equal(second.firstObservedAt, first.receivedAt); assert.equal(second.reusedContent, true);
  assert.equal(second.previousContentReceiptHash, first.receiptHash); assert.equal(second.sourceUrl, foundation.sourceUrl(commit, `${season}/en.1.json`));
  assert.equal(auditObservationStore(storeDir).observations, 2);
  assert.throws(() => recordSourceObservation({ ...args, sourceCommit: "master" }), /pinned source commit/);
  assert.equal(auditObservationStore(storeDir).observations, 2);
});
test("legacy master receipt body and hash stay byte-identical with absent pin", () => {
  const original = { version: "openfootball-local-observation-v1", scope: "local-complete-response-only", sequence: 1, sourceUrl: observationSourceUrl(season, "en.1"), league: "en.1", season, contentSha256: "1".repeat(64), bytes: 100, requestStartedAt: "2026-10-06T15:00:00.000Z", receivedAt: "2026-10-06T15:00:01.000Z", firstObservedAt: "2026-10-06T15:00:01.000Z", previousReceiptHash: null, previousContentReceiptHash: null, candidateRows: 1, sourceVerified: false, entityMappingStatus: "unverified", productionEligible: false, upstreamPublishedAt: null, officialSettlementAllowed: false };
  const actual = buildObservationReceipt({ sequence: original.sequence, url: original.sourceUrl, league: original.league, season, contentHash: original.contentSha256, rawBytes: original.bytes, started: original.requestStartedAt, received: original.receivedAt, firstObservedAt: original.firstObservedAt, previousReceiptHash: null, firstReceiptHash: null, candidateRows: 1 });
  assert.equal(JSON.stringify(actual), JSON.stringify(original)); assert.equal(hashObject(actual), hashObject(original));
});
test("pinned Spanish name does not broaden legacy master schema or arrays to admitted ft", () => {
  const value = raw({ name: "Primera División de España 2021/22", matches: [{ date: "2021-08-15", team1: "Club A", team2: "Club B", score: [2, 1] }] });
  assert.throws(() => inspectSource(value, { season, league: "es.1", receivedAt: "2026-10-06T15:00:00Z" }), /Unexpected league/);
  const pinned = inspectSource(value, { season, league: "es.1", sourceCommit: commit, receivedAt: "2026-10-06T15:00:00Z" });
  assert.equal(pinned.candidateRows, 0); assert.equal(pinned.excluded["no-full-time-score"], 1); assert.equal(pinned.productionAdmittedRows, 0);
});
test("bounded downloader rejects redirects, bad UTF8, and oversized responses without mirrors", async (t) => {
  const original = https.get; t.after(() => { https.get = original; });
  for (const [status, body, code] of [[302, Buffer.from("redirect"), "SOURCE_HTTP_FAILED"], [200, Buffer.from([255]), null], [200, Buffer.alloc(3 * 1024 * 1024 + 1), "SOURCE_TOO_LARGE"]]) {
    let requests = 0;
    https.get = (_url, _options, callback) => {
      requests++; const request = new EventEmitter(); request.destroy = (error) => request.emit("error", error);
      queueMicrotask(() => { const result = new EventEmitter(); result.statusCode = status; result.headers = {}; result.resume = () => {}; result.destroy = (error) => result.emit("error", error); callback(result); if (status === 200) { result.emit("data", body); result.emit("end"); } });
      return request;
    };
    if (code) await assert.rejects(foundation.download(foundation.sourceUrl(commit, `${season}/en.1.json`)), { code });
    else await assert.rejects(foundation.download(foundation.sourceUrl(commit, `${season}/en.1.json`)), /encoded data was not valid/);
    assert.equal(requests, 1);
  }
});
test("downloader total wall deadline stops a continuously live request", async (t) => {
  const originalGet = https.get; const originalTimer = global.setTimeout; let totalTimer;
  t.after(() => { https.get = originalGet; global.setTimeout = originalTimer; });
  global.setTimeout = (callback, duration, ...args) => { if (duration === 20000) { totalTimer = duration; return originalTimer(callback, 1, ...args); } return originalTimer(callback, duration, ...args); };
  https.get = () => { const request = new EventEmitter(); request.destroy = (error) => request.emit("error", error); return request; };
  await assert.rejects(foundation.download(foundation.sourceUrl(commit, `${season}/en.1.json`)), { code: "SOURCE_TIMEOUT" }); assert.equal(totalTimer, 20000);
});
