"use strict";

const assert = require("node:assert/strict");
const { iterateHistoricalEvents } = require("./historicalEventStore.cjs");
const {
  DATASET_CONFIG,
  SOURCE_DATASET,
  buildCombinedCsv,
  fillMissingTrainingTeams,
  parseOpenFootballSeason,
} = require("./augmentHistoricalTrainingFromOpenFootball.cjs");

async function main() {
  const source = `= Portuguese Segunda Liga 2024/25

▪ Matchday 1
  Sat Aug 10 2024
    18:00  Académico de Viseu      v GD Chaves                2-1 (2-0)
  Sun Aug 11
           FC Porto B              v Académico de Viseu       1-1

▪ Matchday 2
  Sun Jan 12 2025
    11:00  Académico de Viseu      v CS Marítimo              3-0 (1-0)
`;
  const padding = Array.from({ length: 247 }, (_, index) => (
    `  Mon Jan ${String((index % 28) + 1).padStart(2, "0")} 2025\n`
      + `    12:00  Test Home ${index}       v Test Away ${index}        1-0`
  )).join("\n");
  const parsed = parseOpenFootballSeason(`${source}${padding}\n`, "2024-25_pt2.txt");
  assert.equal(parsed.length, 250);
  assert.equal(parsed[0].date, "2024-08-10");
  assert.equal(parsed[1].date, "2024-08-11");
  assert.equal(parsed[2].date, "2025-01-12");
  assert.equal(parsed[0].homeTeam, "Académico de Viseu");

  const csv = buildCombinedCsv(parsed);
  const iterator = iterateHistoricalEvents({ dataset: DATASET_CONFIG, input: csv });
  const events = [];
  let manifest = null;
  while (true) {
    const step = await iterator.next();
    if (step.done) { manifest = step.value; break; }
    events.push({ ...step.value, recentSource: SOURCE_DATASET });
  }
  assert.equal(events.length, 250);
  assert.equal(manifest.rejected, 0);
  assert.equal(events[0].sourceDataset, SOURCE_DATASET);
  assert.equal(events[0].kickoff, null, "date-only import must not invent timezone precision");

  const index = {
    teams: {
      "gd chaves": { latestElo: 1600, matches: 50, recent: [{}, {}, {}] },
    },
  };
  const fill = fillMissingTrainingTeams(index, events);
  assert.ok(fill.filledTeamKeys.includes("academico de viseu"));
  assert.equal(index.teams["gd chaves"].latestElo, 1600, "ready teams must never be overwritten");
  assert.ok(index.teams["academico de viseu"].matches >= 3);
  assert.equal(index.teams["academico de viseu"].recent.at(-1).source, SOURCE_DATASET);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "openfootball-training-augmentation-v1",
    assertions: 12,
    parsedRows: parsed.length,
    canonicalRows: events.length,
    filledTeamKeys: fill.filledTeamKeys.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
