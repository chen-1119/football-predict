"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { iterateHistoricalEvents } = require("./historicalEventStore.cjs");
const {
  SOURCE_PROFILES,
  projectHistoricalEvent,
} = require("./postgresHistoricalSourceStore.cjs");
const {
  MAIN_DIVISIONS,
  WORLD_DIVISIONS,
  previousSeasonCode,
  sourceList,
} = require("./syncFootballDataResults.cjs");

async function firstEvent(csv) {
  const iterator = iterateHistoricalEvents({ dataset: "football-data", input: csv });
  const step = await iterator.next();
  assert.equal(step.done, false);
  await iterator.return();
  return step.value;
}

(async () => {
  const main = await firstEvent([
    "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HS,AS,AvgCH,AvgCD,AvgCA,PSH,PSD,PSA",
    "E0,15/08/2025,20:00,Liverpool,Bournemouth,4,2,H,19,10,1.31,5.96,8.31,1.28,6.56,9.07",
  ].join("\n"));
  assert.equal(main.competition, "E0");
  assert.deepEqual(main.score, { home: 4, away: 2 });
  assert.deepEqual(main.preMatchOdds, { home: 1.31, draw: 5.96, away: 8.31 });
  assert.equal(Object.hasOwn(main, "homeshots"), false);

  const worldwide = await firstEvent([
    "Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA,MaxCH,MaxCD,MaxCA,AvgCH,AvgCD,AvgCA",
    "China,Super League,2026,07/03/2026,11:00,Shandong Taishan,Zhejiang,1,0,H,1.9,3.5,4.1,2,3.6,4.2,1.88,3.42,4.05",
  ].join("\n"));
  assert.equal(worldwide.competition, "Super League");
  assert.equal(worldwide.date, "2026-03-07");
  assert.deepEqual(worldwide.preMatchOdds, { home: 1.88, draw: 3.42, away: 4.05 });

  const projected = projectHistoricalEvent(worldwide, {
    dataset: "football-data",
    runId: "test-run",
    observedAt: "2026-08-21T10:00:00.000Z",
  });
  assert.equal(projected.profile.sourceKey, "football-data-co-uk");
  assert.equal(projected.profile.scope, "club");
  assert.equal(projected.teamRows.length, 2);
  assert.notEqual(projected.teamRows[0].team_id, projected.teamRows[1].team_id);
  assert.equal(projected.resultRow.outcome, "H");
  assert.equal(projected.resultRow.available_at, "2026-03-08T12:00:00.000Z");
  assert.equal(projected.resultRow.availability_policy, "date-only-result-available-next-day-12z");
  assert.equal(projected.oddsRow.home_odds, 1.88);
  assert.match(projected.eventRow.event_sha256, /^[0-9a-f]{64}$/);

  assert.equal(SOURCE_PROFILES.xgabora.authorityRank < SOURCE_PROFILES["football-data"].authorityRank, true);
  assert.equal(MAIN_DIVISIONS.includes("E0"), true);
  assert.equal(WORLD_DIVISIONS.includes("CHN"), true);
  assert.equal(previousSeasonCode(new Date("2026-08-21T00:00:00Z")), "2526");
  assert.deepEqual(sourceList({ season: "2526", only: "E0,CHN" }).map((row) => row.code), ["E0", "CHN"]);

  const migration = fs.readFileSync(path.join(
    __dirname,
    "..",
    "server",
    "postgres",
    "migrations",
    "004_free_source_warehouse.sql",
  ), "utf8");
  for (const table of [
    "data_sources",
    "data_ingest_runs",
    "historical_teams",
    "historical_team_aliases",
    "historical_matches",
    "historical_source_events",
    "historical_result_observations",
    "historical_odds_observations",
    "historical_feature_snapshots",
    "data_source_conflicts",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS football\\.${table}\\b`));
  }
  assert.match(migration, /CREATE OR REPLACE VIEW football\.historical_resolved_results/);
  assert.match(migration, /source\.authority_rank DESC/);

  console.log(JSON.stringify({
    ok: true,
    adapters: ["football-data-main", "football-data-worldwide"],
    sourceProfiles: Object.keys(SOURCE_PROFILES),
    mainDivisions: MAIN_DIVISIONS.length,
    worldwideDivisions: WORLD_DIVISIONS.length,
    postgresTablesVerified: 10,
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
