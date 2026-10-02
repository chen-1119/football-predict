"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { verifyModelInputUsage, summarizeModelInputUsage } = require("../src/services/modelInputUsage.cjs");
const resign = receipt => { const { contentHash: ignored, ...body } = receipt; void ignored; return { ...body, contentHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") }; };
function fixture() {
  const receipt = resign({ version: "model-input-usage-v1", stage: "form-lambda-blend", sourceMatchId: "synthetic-1",
    recordedAt: "2026-10-03T01:00:00.000000000Z", kickoffTime: "2026-10-03T02:00:00Z", before: { home: 1.5, away: 1.1 },
    candidates: [], weight: 0, output: { home: 1.5, away: 1.1 } });
  return { receipt, model: { generatedAt: "2026-10-03T01:00:00.000000000Z", lambdaBlend: { formWeight: 0 }, inputUsage: [receipt] },
    match: { sourceMatchId: "synthetic-1", kickoffTime: "2026-10-03T02:00:00Z" } };
}
for (const value of ["2026-02-30T01:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03 01:00:00", null]) {
  test(`receipt rejects invalid original calendar ${value}`, () => {
    for (const field of ["recordedAt", "kickoffTime"]) {
      const { receipt } = fixture(); receipt[field] = value;
      assert.equal(verifyModelInputUsage(resign(receipt)), false);
    }
  });
}
test("self-consistent arithmetic recorded one nanosecond after model generation cannot claim verified use", () => {
  const { receipt, model, match } = fixture(); receipt.recordedAt = "2026-10-03T01:00:00.000000001Z"; model.inputUsage = [resign(receipt)];
  assert.equal(verifyModelInputUsage(model.inputUsage[0]), true);
  assert.equal(summarizeModelInputUsage(model, match), null);
});
test("kickoff identity differing by one nanosecond is not the same event", () => {
  const { model, match } = fixture(); match.kickoffTime = "2026-10-03T02:00:00.000000001Z";
  assert.equal(summarizeModelInputUsage(model, match), null);
});
test("invalid generatedAt cannot borrow JavaScript date rollover", () => {
  const { model, match, receipt } = fixture(); model.generatedAt = "2026-02-30T01:00:00Z";
  receipt.recordedAt = "2026-03-02T01:00:00Z"; model.inputUsage = [resign(receipt)];
  assert.equal(summarizeModelInputUsage(model, match), null);
});
test("valid timezone-equivalent clocks retain original bytes, hashes and summary", () => {
  const { model, match, receipt } = fixture(); const bytes = JSON.stringify(model);
  assert.equal(verifyModelInputUsage(receipt), true);
  const expected = summarizeModelInputUsage(model, match);
  assert.ok(expected); assert.equal(expected.sourceVerified, false);
  const offsetModel = structuredClone(model); offsetModel.generatedAt = "2026-10-03T09:00:00.000000000+08:00";
  assert.deepEqual(summarizeModelInputUsage(offsetModel, { ...match, kickoffTime: "2026-10-03T10:00:00+08:00" }), expected);
  assert.equal(JSON.stringify(model), bytes);
});
test("seven actual scorer cases preserve parent-version math, original receipt hashes and valid summaries", () => {
  const { execFileSync } = require("node:child_process"), path = require("node:path");
  const script = String.raw`
    const path=require('node:path'),Module=require('node:module'),cp=require('node:child_process');
    Date.now=()=>Date.parse('2026-09-07T00:00:00Z');
    if(process.argv[1]==='parent'){
      const file=path.resolve('src/services/modelInputUsage.cjs'), previous=new Module(file);
      previous.filename=file;previous.paths=Module._nodeModulePaths(path.dirname(file));
      previous._compile(cp.execFileSync('git',['show','295a173d117cbb0f889197dbeff13501d79dfd15:src/services/modelInputUsage.cjs'],{encoding:'utf8'}),file);
      require.cache[file]=previous;
    }
    const {predictionSet}=require('./scripts/syncData.cjs'), {summarizeModelInputUsage}=require('./src/services/modelInputUsage.cjs');
    const fixture=()=>({sourceMatchId:'synthetic-compatible',kickoffTime:'2026-09-08T12:00:00Z',status:'SCHEDULED',
      homeTeamName:'Synthetic Home',awayTeamName:'Synthetic Away',leagueName:'Synthetic League',
      odds:{odds1:2.1,oddsX:3.4,odds2:3.3},oddsSource:'sporttery:HAD',oddsUpdatedAt:'2026-09-07T00:00:00Z',
      eloSnapshot:{probabilities:{home:0.45,draw:0.3,away:0.25},homeMatches:20,awayMatches:20,diff:50},
      formSnapshot:{sampleSize:24,home:{sampleSize:12,goalsForAvg:1.8,goalsAgainstAvg:1.1,lastMatchAt:'2026-09-01T12:00:00Z'},
        away:{sampleSize:12,goalsForAvg:1.2,goalsAgainstAvg:1.5,lastMatchAt:'2026-09-01T12:00:00Z'}}});
    const mutations=[()=>{},m=>delete m.formSnapshot,m=>delete m.eloSnapshot,m=>m.formSnapshot.home.goalsForAvg=0,
      m=>m.formSnapshot.home.goalsForAvg=null,m=>m.formSnapshot.away.sampleSize=0,m=>m.oddsSource='500.com:HAD'];
    console.log(JSON.stringify(mutations.map(mutate=>{const match=fixture();mutate(match);const output=predictionSet(match),model=output.probabilityModel;
      return {math:{oneXTwo:model.oneXTwo,weights:model.ensembleWeights,lambdaBlend:model.lambdaBlend,goalLines:model.goalLines,handicap:model.handicap,predictions:output.predictions},
        receipts:model.inputUsage,summary:summarizeModelInputUsage(model,match)}})));
  `;
  const options = { cwd: path.resolve(__dirname, ".."), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 };
  const parent = JSON.parse(execFileSync(process.execPath, ["-e", script, "parent"], options));
  const current = JSON.parse(execFileSync(process.execPath, ["-e", script, "current"], options));
  assert.equal(parent.length, 7); assert.ok(parent.every(row => row.summary));
  assert.deepEqual(current, parent);
});
