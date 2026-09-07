"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { iterateHistoricalEvents } = require("./historicalEventStore.cjs");
const { downloadCsv } = require("./syncFootballDataResults.cjs");
const { applyEvent, sourceObservationForFile } = require("./augmentHistoricalTrainingFromFootballData.cjs");
const { verifyHistoricalContentObservation: verify } = require("./historicalContentObservation.cjs");
const { summarizeRecentFormEvidence } = require("./recentFormEvidence.cjs");
const { buildFormSnapshots, predictionSet, buildPredictionFeatureSnapshot } = require("./syncData.cjs");
const { bindPublicReferenceDecision: bind, pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "football-content-receipt-test-"));
const clone = v => JSON.parse(JSON.stringify(v));
let checks = 0; const check = (name, fn) => { fn(); checks++; };
const originalFetch = global.fetch;
(async () => {
  const source = { url: "https://www.football-data.co.uk/mmz4281/2627/E0.csv", code: "E0", group: "main-league-season" };
  const file = path.join(tmp, source.group, "E0-2627.csv");
  const firstAt = "2026-09-06T12:00:00.000Z"; const decisionAt = "2026-09-07T01:00:00.000Z";
  global.fetch = async () => new Response("Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\nE0,01/09/2026,Alpha,Beta,0,1\n", { headers: { "content-type": "text/csv" } });
  const downloaded = await downloadCsv(source, file, {}, false, { now: () => firstAt });
  global.fetch = originalFetch;
  const status = { sources: { [source.url]: { ...downloaded, destination: file } } };
  const iterator = iterateHistoricalEvents({ dataset: "football-data", filePath: file });
  const events = []; let manifest;
  while (true) { const next = await iterator.next(); if (next.done) { manifest = next.value; break; } events.push(next.value); }
  assert.equal(events.length, 1); const event = events[0];
  const observation = sourceObservationForFile(file, tmp, status, manifest, Date.parse(decisionAt));
  check("actual streaming download and CSV parser bind the same exact bytes and original first clock", () => {
    assert.equal(downloaded.ok, true); assert.equal(observation.firstObservedAt, firstAt);
    assert.equal(observation.sha256, manifest.sourceFileSha256);
  });
  for (const [name, mutate] of [
    ["no receipt", s => { delete s.sources[source.url].observation; }],
    ["wrong source", s => { s.sources[source.url].observation.sourceUrl = "https://example.test/E0.csv"; }],
    ["wrong digest", s => { s.sources[source.url].observation.sha256 = "0".repeat(64); }],
    ["wrong destination", s => { s.sources[source.url].destination = path.join(tmp, "other.csv"); }],
    ["future clock", s => { s.sources[source.url].observation.firstObservedAt = "2099-01-01T00:00:00.000Z"; }],
    ["impossible clock", s => { s.sources[source.url].observation.firstObservedAt = "2026-02-30T00:00:00.000Z"; }],
    ["date only", s => { s.sources[source.url].observation.firstObservedAt = "2026-09-06"; }],
    ["verified forgery", s => { s.sources[source.url].observation.sourceVerified = true; }],
  ]) check("reject " + name, () => { const s=clone(status); mutate(s); assert.equal(sourceObservationForFile(file,tmp,s,manifest,Date.parse(decisionAt)),null); });
  check("failed refresh can retain an exact older receipt without a new timestamp", () => {
    const s=clone(status); s.sources[source.url].ok=false;
    assert.deepEqual(sourceObservationForFile(file,tmp,s,manifest,Date.parse(decisionAt)),observation);
  });
  check("parsed-manifest mismatch cannot bind unrelated bytes", () => assert.equal(sourceObservationForFile(file,tmp,status,{...manifest,sourceFileSha256:"0".repeat(64)}),null));
  const plain={teams:{}}; const withReceipt={teams:{}};
  applyEvent(plain,event); applyEvent(withReceipt,event,observation);
  const row=withReceipt.teams.alpha.recent[0];
  check("both team rows bind separately; no official result clock or receipt is manufactured", () => {
    assert.ok(verify(row)); assert.ok(verify(withReceipt.teams.beta.recent[0]));
    assert.notEqual(row.sourceObservation.rowHash,withReceipt.teams.beta.recent[0].sourceObservation.rowHash);
    assert.equal(row.resultObservedAt,undefined); assert.equal(row.resultObservationSource,undefined);
    assert.equal(row.sourceObservation.sourceVerified,false);
  });
  check("import arithmetic and selection are byte-identical after removing only optional receipt metadata", () => {
    const cleaned=clone(withReceipt); for(const team of Object.values(cleaned.teams)) for(const r of team.recent) delete r.sourceObservation;
    assert.deepEqual(cleaned,plain);
  });
  for(const key of ["scoreHome","homeKey","kickoffTime","side"]) check("row binding rejects changed "+key, () => {
    const changed=clone(row); changed[key]=key==="scoreHome"?3:"changed"; assert.equal(verify(changed),false);
    assert.equal(summarizeRecentFormEvidence([changed],"alpha",decisionAt).contentObservation,undefined);
  });
  check("form distinguishes file receipt from missing historical result observation", () => {
    const e=summarizeRecentFormEvidence([row],"alpha",decisionAt);
    assert.equal(e.observedRows,0); assert.equal(e.missingObservedAtRows,1); assert.equal(e.temporalStatus,"unverified");
    assert.equal(e.contentObservation.receivedRows,1); assert.equal(e.contentObservation.latestFirstObservedAt,firstAt);
    assert.equal(e.contentObservation.afterDecisionRows,0);
    assert.equal(summarizeRecentFormEvidence([row],"alpha","2026-09-05T01:00:00.000Z").contentObservation.afterDecisionRows,1);
    assert.equal(summarizeRecentFormEvidence([row],"alpha",null).contentObservation.afterDecisionRows,null);
  });
  const kickoff="2026-09-08T12:00:00.000Z";
  const match={sourceMatchId:"content-receipt-fixture",eventVersion:kickoff,kickoffTime:kickoff,status:"SCHEDULED",homeTeamName:"Alpha",awayTeamName:"Beta",
    odds:{odds1:2.1,oddsX:3.3,odds2:3.4},oddsSource:"sporttery:HAD",predictionMeta:{generatedAt:decisionAt}};
  match.formSnapshot=buildFormSnapshots([match],withReceipt).get(match.sourceMatchId);
  const NativeDate=Date;
  global.Date=class extends NativeDate { constructor(...args) { super(...(args.length?args:[decisionAt])); } static now() { return NativeDate.parse(decisionAt); } };
  try { match.probabilityModel=predictionSet(match).probabilityModel; } finally { global.Date=NativeDate; }
  match.predictionMeta={...match.predictionMeta,decisionId:"content-observation-test",modelVersion:match.probabilityModel.version,policyVersion:"synthetic-policy"};
  match.predictionMeta.featureSnapshot=buildPredictionFeatureSnapshot(match,decisionAt);
  match.predictions=[{marketType:"BEST",oddsPoolCode:"HAD",tipCode:"X",odds:3.3,recommendationAction:"reference"}];
  const published=bind(match,null,decisionAt);
  check("actual seeded form, model, feature and frozen public binding retain a private-safe compact summary", () => {
    const publicSummary=published.predictionMeta.publicReferenceDecision.dataGaps.inputSummaries.form.home.resultEvidence;
    assert.equal(publicSummary.contentObservation.receivedRows,1); assert.equal(publicSummary.sourceVerified,false);
    assert.equal(publicSummary.contentObservation.sourceUrl,undefined); assert.equal(publicSummary.contentObservation.rawRowSha256,undefined);
    assert.deepEqual(pending(published).evidence.featureSnapshot.modelInputs.form.home.resultEvidence.contentObservation,publicSummary.contentObservation);
  });
  // Exercise the actual importer CLI with an explicitly synthetic, isolated index.
  const teams=Object.fromEntries(Array.from({length:500},(_,i)=>[i===0?"alpha":i===1?"beta":`fixture team ${i}`,{latestElo:1500,matches:1,lastMatchDate:"2026-08-30",recent:[]}]));
  const seed={version:"historical-training-v1",source:{name:"synthetic-content-receipt-test"},sample:{rows:100000,teams:500,firstMatchDate:"2020-01-01",lastMatchDate:"2026-08-30"},teams};
  const seedFile=path.join(tmp,"seed.json"); const output=path.join(tmp,"output.json");
  fs.writeFileSync(seedFile,JSON.stringify(seed)); fs.writeFileSync(path.join(tmp,"sync-status.json"),JSON.stringify(status));
  const run = input => JSON.parse(execFileSync(process.execPath,[path.join(__dirname,"augmentHistoricalTrainingFromFootballData.cjs")],{encoding:"utf8",env:{...process.env,HISTORICAL_TRAINING_INDEX_PATH:input,HISTORICAL_TRAINING_OUTPUT_PATH:output,FOOTBALL_DATA_RESULTS_DIR:tmp},maxBuffer:1024*1024}));
  check("real CLI transfers observation only to newly accepted rows", () => { assert.equal(run(seedFile).acceptedRows,1); assert.ok(verify(JSON.parse(fs.readFileSync(output,"utf8")).teams.alpha.recent[0])); });
  const before=fs.readFileSync(output);
  check("unchanged importer replay neither writes nor restamps observations", () => { assert.equal(run(output).idempotent,true); assert.deepEqual(fs.readFileSync(output),before); });
  check("legacy CLI cache gets no observation invented from file mtime or import time", () => {
    fs.writeFileSync(path.join(tmp,"sync-status.json"),"{}"); run(seedFile);
    assert.equal(JSON.parse(fs.readFileSync(output,"utf8")).teams.alpha.recent[0].sourceObservation,undefined);
  });
  check("changing file bytes after parsing fails closed", () => { fs.appendFileSync(file,"\n"); assert.equal(sourceObservationForFile(file,tmp,status,manifest),null); });
  console.log(JSON.stringify({ok:true,checks,scope:"real streaming downloader with synthetic response, CSV parser, file hashes, importer CLI and actual frozen feature chain",productionDataTouched:false,modelWeightsChanged:false},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  global.fetch=originalFetch;
  if(path.dirname(path.resolve(tmp))!==path.resolve(os.tmpdir())||!path.basename(tmp).startsWith("football-content-receipt-test-")) throw new Error("unsafe fixture cleanup");
  fs.rmSync(tmp,{recursive:true,force:true});
});
