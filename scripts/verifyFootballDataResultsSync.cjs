"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { currentSeasonCode, previousSeasonCode, resolveSeason, sourceList, downloadCsv, main } = require("./syncFootballDataResults.cjs");
const { footballDataResultsWorkerEnv, runCommand } = require("./runSyncWorker.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-results-sync-test-"));
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; };
const csv = "Date,HomeTeam,AwayTeam,FTHG,FTAG\n01/09/2026,Alpha,Beta,2,1\n";
let mode = "normal";
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, conditional: req.headers["if-none-match"] });
  if (req.url === "/fail") { res.writeHead(503); res.end("unavailable"); return; }
  if (req.url === "/broken") { req.socket.destroy(); return; }
  res.setHeader("content-type", mode === "html" ? "text/html" : "text/csv");
  if (mode === "304" || (mode === "conditional" && req.headers["if-none-match"])) { res.writeHead(304); res.end(); return; }
  if (mode === "large") { res.writeHead(200); res.write(csv); res.end("x".repeat(2048)); return; }
  res.setHeader("etag", '"fixture-v1"'); res.setHeader("last-modified", "Tue, 01 Sep 2026 14:00:00 GMT");
  res.end(mode === "bad-header" ? "message,not,scores\n" : mode === "changed" ? csv.replace(",2,1", ",3,1") : csv);
});

(async () => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = { code: "E0", group: "main-league-season", url: `${base}/data` };
  const destination = path.join(temp, "single.csv");
  const firstAt = "2026-09-07T01:00:00.000Z"; const laterAt = "2026-09-07T02:00:00.000Z";
  const workerSource=fs.readFileSync(path.join(__dirname,"runSyncWorker.cjs"),"utf8");
  // CRLF worktrees use the same source fragment after newline normalization.
  const normalized=workerSource.replace(/\r\n/g,"\n");
  const normalizedStart=normalized.indexOf('enrichmentSteps.push(await runEnrichment(\n      footballDataResultsDue,');
  assert.ok(normalizedStart>=0);
  const step=normalized.slice(normalizedStart,normalized.indexOf('));',normalizedStart)+3);
  const executeStep=new (Object.getPrototypeOf(async function(){}).constructor)("enrichmentSteps","runEnrichment","footballDataResultsDue","footballDataResultsWorkerEnv",step);
  for (const [name, env, expected] of [["unset",{},"2627"],["empty",{FOOTBALL_DATA_RESULTS_SEASON:""},"2627"],
    ["explicit current",{FOOTBALL_DATA_RESULTS_SEASON:"current"},"2627"],["explicit history",{FOOTBALL_DATA_RESULTS_SEASON:"previous"},"2526"],
    ["explicit season",{FOOTBALL_DATA_RESULTS_SEASON:"2425"},"2425"]]) await check("actual worker enrichment step and child resolve "+name+" season correctly",async()=>{
    const entries=[]; let captured;
    await executeStep(entries,async(enabled,script,extraEnv)=>{captured={enabled,script,extraEnv};return {ok:true};},true,()=>footballDataResultsWorkerEnv(env));
    assert.equal(captured.enabled,true); assert.equal(captured.script,"sync:football-data-results"); assert.equal(entries.length,1);
    const child=await runCommand(process.execPath,["-e",`const assert=require('node:assert/strict');const {resolveSeason}=require('./scripts/syncFootballDataResults.cjs');assert.equal(resolveSeason(process.env.FOOTBALL_DATA_RESULTS_SEASON,new Date('2026-09-07T00:00:00.000Z')),${JSON.stringify(expected)});`],captured.extraEnv,{stdio:"ignore",timeoutMs:10000});
    assert.equal(child.ok,true);
  });
  await check("disabled or not-due enrichment stays disabled and invalid explicit settings are not silently replaced",async()=>{
    let enabled;
    await executeStep([],async(value)=>{enabled=value;return {ok:true};},false,()=>footballDataResultsWorkerEnv({}));
    assert.equal(enabled,false);
    assert.throws(()=>resolveSeason(footballDataResultsWorkerEnv({FOOTBALL_DATA_RESULTS_SEASON:"2628"}).FOOTBALL_DATA_RESULTS_SEASON));
    assert.ok(normalized.includes('ageMs(footballDataResultsStatus?.completedAt) >= footballDataResultsMinIntervalMs'));
    assert.ok(normalized.includes('finiteEnvNumber("FOOTBALL_DATA_RESULTS_MIN_INTERVAL_MINUTES", 720)'));
  });
  await check("current and previous season remain distinct across the July boundary", () => {
    assert.equal(currentSeasonCode(new Date("2026-06-30T23:59:59Z")), "2526");
    assert.equal(currentSeasonCode(new Date("2026-07-01T00:00:00Z")), "2627");
    assert.equal(previousSeasonCode(new Date("2026-09-07T00:00:00Z")), "2526");
    assert.equal(resolveSeason("current", new Date("2026-09-07T00:00:00Z")), "2627");
    assert.equal(resolveSeason(undefined, new Date("2026-09-07T00:00:00Z")), "2526");
    assert.throws(() => resolveSeason("2628")); assert.throws(() => sourceList({ season: "2627", only: "UNKNOWN" }));
  });
  await check("targeted English lower-league repair selects only E2 and E3 in each explicit season", () => {
    for (const season of ["2425", "2526", "2627"]) {
      const rows = sourceList({ season: resolveSeason(season), only: " E2, e3,E2 " });
      assert.deepEqual(rows.map(row => row.code), ["E2", "E3"]);
      assert(rows.every(row => row.group === "main-league-season"));
      assert.deepEqual(rows.map(row => row.url), [
        `https://www.football-data.co.uk/mmz4281/${season}/E2.csv`,
        `https://www.football-data.co.uk/mmz4281/${season}/E3.csv`,
      ]);
    }
    assert.throws(() => sourceList({ season: "2627", only: "E2,E4" }));
  });
  const first = await downloadCsv(source, destination, {}, false, { now: () => firstAt });
  await check("actual HTTP download creates a content-bound observation, not source truth", () => {
    assert.equal(first.ok, true); assert.equal(first.changed, true);
    assert.equal(first.observation.firstObservedAt, firstAt); assert.equal(first.observation.sourceVerified, false);
    assert.equal(first.observation.sha256, first.sha256); assert.equal(fs.readFileSync(destination, "utf8"), csv);
  });
  mode = "conditional";
  const unchanged = await downloadCsv(source, destination, first, false, { now: () => laterAt });
  await check("304 retains exact hash, conditional headers and first observation clock", () => {
    assert.equal(unchanged.status, 304); assert.equal(unchanged.changed, false);
    assert.deepEqual(unchanged.observation, first.observation); assert.equal(unchanged.sha256, first.sha256);
    assert.equal(unchanged.etag, first.etag); assert.equal(unchanged.lastModified, first.lastModified);
    assert.equal(requests.at(-1).conditional, first.etag);
  });
  await check("same bytes from a full 200 response do not fabricate a new first observation", async () => {
    mode = "normal";
    const same = await downloadCsv(source, destination, first, true, { now: () => laterAt });
    assert.equal(same.changed, false); assert.deepEqual(same.observation, first.observation);
  });
  await check("legacy cache gets a real fetch and never inherits its old unchecked timestamp", async () => {
    mode = "conditional";
    const legacy = await downloadCsv(source, destination, { sha256: first.sha256, etag: first.etag, checkedAt: firstAt }, false, { now: () => laterAt });
    assert.equal(legacy.status, 200); assert.equal(requests.at(-1).conditional, undefined);
    assert.equal(legacy.observation.firstObservedAt, laterAt);
  });
  await check("new bytes receive a new content observation without historical backdating", async () => {
    mode = "changed";
    const changed = await downloadCsv(source, destination, first, false, { now: () => laterAt });
    assert.notEqual(changed.sha256, first.sha256); assert.equal(changed.observation.firstObservedAt, laterAt);
  });
  await check("304 cannot attest bytes that no longer match the cached hash", async () => {
    mode = "304";
    const rejected = await downloadCsv(source, destination, first);
    assert.equal(rejected.ok, false); assert.equal(requests.at(-1).conditional, undefined);
  });
  await check("missing cached file cannot pass an unexpected 304", async () => {
    assert.equal((await downloadCsv(source, path.join(temp, "missing.csv"), first)).ok, false);
  });
  const preserved = fs.readFileSync(destination);
  for (const failure of ["large", "html", "bad-header"]) await check(`failed ${failure} download leaves previous bytes intact and no temporary file`, async () => {
    mode = failure;
    assert.equal((await downloadCsv(source, destination, first, false, { maxBytes: 128 })).ok, false);
    assert.deepEqual(fs.readFileSync(destination), preserved);
    assert.equal(fs.readdirSync(temp).some(name => name.includes(".tmp-")), false);
  });
  await check("real batch records transport/HTTP failures and continues remaining sources", async () => {
    mode = "normal";
    const batchDir = path.join(temp, "batch"); fs.mkdirSync(batchDir);
    fs.writeFileSync(path.join(batchDir, "sync-status.json"), JSON.stringify({ sources: { retained: { checkedAt: firstAt } } }));
    const status = await main({ argv: ["--output", batchDir, "--season", "current"], quiet: true,
      sourceRows: [{ ...source, code: "FAIL", url: `${base}/fail` }, { ...source, code: "BROKEN", url: `${base}/broken` }, source] });
    assert.equal(status.summary.failed, 2); assert.equal(status.summary.downloadedOk, 1);
    assert.equal(status.sources.retained.checkedAt, firstAt);
    assert.equal(status.sources[source.url].ok, true); assert.equal(status.sources[source.url].error, null);
    assert.equal(status.postgres, null); assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.equal(JSON.parse(fs.readFileSync(path.join(batchDir, "sync-status.json"))).summary.failed, 2);
  });
  console.log(JSON.stringify({ ok: true, checks, scope: "actual worker enrichment fragment and child environment, localhost HTTP streaming and batch persistence; no upstream requests or production DB", productionDataTouched: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const target = path.resolve(temp);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("football-results-sync-test-")) throw new Error("unsafe fixture cleanup");
  fs.rmSync(target, { recursive: true, force: true });
});
