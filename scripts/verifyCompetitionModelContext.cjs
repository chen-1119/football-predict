"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { competitionModelContext: context } = require("./competitionModelContext.cjs");
const { predictionSet, blendLambdasWithForm } = require("./syncData.cjs");
let checks = 0;
const check = (name, test) => { test(); checks++; };
const fixture = () => ({ sourceMatchId: "competition-fixture", kickoffTime: "2099-09-09T03:00:00+08:00", status: "SCHEDULED",
  leagueName: "欧洲冠军联赛", leagueNameEn: "UEFA Champions League", countryName: "欧洲", homeTeam: "Synthetic Home", awayTeam: "国际米兰",
  odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 }, oddsSource: "sporttery:HAD",
  formSnapshot: { sampleSize: 24, home: { sampleSize: 12, goalsForAvg: 1.92, goalsAgainstAvg: 1.08 },
    away: { sampleSize: 12, goalsForAvg: 2.25, goalsAgainstAvg: 1.17 } } });
for (const name of ["国际米兰", "Internacional", "International FC", "Friendly Wanderers", "Japan FC", "国家竞技", "FIFA Club"]) check("team name cannot select competition weights: " + name, () => {
  const row = fixture(); row.awayTeam = name;
  assert.deepEqual(context(row).profile, { isInternational: false, isJapan: false });
  assert.equal(blendLambdasWithForm(row, 1.31, 1.13).formWeight, 0.42);
});
for (const league of ["国际友谊赛", "World Cup Qualifier", "FIFA World Cup", "International Friendly"]) check("explicit competition classification retained: " + league, () => {
  const row = fixture(); row.leagueName = league;
  assert.equal(context(row).profile.isInternational, true);
  assert.equal(blendLambdasWithForm(row, 1.31, 1.13).formWeight, 0.34);
});
check("Japan competition metadata still selects Japan profile", () => assert.equal(context({ leagueName: "日职联", countryNameEn: "Japan" }).profile.isJapan, true));
check("missing or non-string metadata does not borrow team identity", () => {
  for (const value of [null, true, {}, ["国际友谊"]]) assert.deepEqual(context({ leagueName: value, homeTeam: "国际米兰" }).profile, { isInternational: false, isJapan: false });
});
check("raw and app team field conventions produce the same context and form arithmetic", () => {
  const row = fixture(), compact = { ...row, homeTeamName: row.homeTeam, awayTeamName: row.awayTeam };
  delete compact.homeTeam; delete compact.awayTeam;
  assert.deepEqual(context(row), context(compact));
  const math = m => { const r = blendLambdasWithForm(m, 1.3108329252950126, 1.128472305474218).formUsage; return [r.before, r.candidates, r.weight, r.output]; };
  assert.deepEqual(math(row), math(compact));
});
check("actual model retains precisely the competition inputs used and bumps model identity", () => {
  const row = fixture(), before = JSON.stringify(row), model = predictionSet(row).probabilityModel;
  assert.deepEqual(model.competitionContext, context(row));
  assert.equal(model.version, "unified-poisson-bayes-v74");
  assert.equal(model.inputUsage.find(r => r.stage === "form-lambda-blend").weight, 0.42);
  assert.equal(model.competitionContext.sourceVerified, false);
  const { contentHash, ...body } = model.competitionContext;
  assert.equal(contentHash, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
  assert.equal(JSON.stringify(row), before);
});
check("classification evidence changes with competition metadata, not unrelated fields", () => {
  const row = fixture(); assert.equal(context(row).contentHash, context({ ...row, scoreHome: 5, awayTeam: "Unknown" }).contentHash);
  assert.notEqual(context(row).contentHash, context({ ...row, leagueName: "国际友谊" }).contentHash);
});
console.log(JSON.stringify({ ok: true, verifier: "competition-model-context-v1", checks, productionWrites: 0,
  scope: "team-label exclusion, executed scorer weights and captured classification inputs; not model promotion or accuracy proof" }, null, 2));
