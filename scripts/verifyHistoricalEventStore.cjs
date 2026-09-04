"use strict";

const assert = require("assert/strict");
const { Readable } = require("stream");
const {
  DATASET_CONFIGS,
  EVENT_SCHEMA_VERSION,
  HistoricalEventConflictError,
  asOf,
  importHistoricalEvents,
  iterateHistoricalEvents,
  parseCsvRecord,
} = require("./historicalEventStore.cjs");

const CREATED_AT = "2026-07-16T00:00:00.000Z";

function chunkedInput(text, widths = [1, 2, 5, 3, 11, 7]) {
  const source = Buffer.from(text, "utf8");
  const chunks = [];
  let offset = 0;
  let cursor = 0;
  while (offset < source.length) {
    const width = widths[cursor % widths.length];
    chunks.push(source.subarray(offset, Math.min(source.length, offset + width)));
    offset += width;
    cursor += 1;
  }
  return Readable.from(chunks);
}

async function callbackImport(csv, dataset, extra = {}) {
  const events = [];
  const rejectedRows = [];
  const manifest = await importHistoricalEvents({
    dataset,
    input: chunkedInput(csv),
    createdAt: CREATED_AT,
    onEvent: (event) => events.push(event),
    onRejected: (rejection) => rejectedRows.push(rejection),
    ...extra,
  });
  return { events, manifest, rejectedRows };
}

async function drainIterator(iterator) {
  const events = [];
  while (true) {
    const step = await iterator.next();
    if (step.done) return { events, manifest: step.value };
    events.push(step.value);
  }
}

async function verifyQuotedCsvAndLeakageBoundary() {
  const csv = [
    "\uFEFFDivision,MatchDate,MatchTime,HomeTeam,AwayTeam,FTHome,FTAway,OddHome,OddDraw,OddAway,HomeShots,HomeCorners",
    '"Cup,\r\nFinal",2024-01-01,20:00,"AC ""Milan"", Youth",Inter,2.0,1,1.80,3.40,4.20,99,14',
    "",
  ].join("\r\n");
  const first = await callbackImport(csv, "xgabora");
  const second = await callbackImport(csv, "xgabora");

  assert.equal(first.events.length, 1);
  const event = first.events[0];
  assert.equal(event.schemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(event.competition, "Cup, Final");
  assert.equal(event.homeTeamRaw, 'AC "Milan", Youth');
  assert.equal(event.homeTeamNormalized, "ac milan youth");
  assert.equal(event.awayTeamNormalized, "inter");
  assert.deepEqual(event.score, { home: 2, away: 1 });
  assert.equal(event.kickoff, null, "timezone-less MatchTime must not be invented as an instant");
  assert.equal(event.kickoffLocalTime, "20:00:00");
  assert.equal(event.neutral, null, "xgabora does not provide a neutral-ground field");
  assert.deepEqual(event.preMatchOdds, { home: 1.8, draw: 3.4, away: 4.2 });
  assert.equal(event.sourceRowNumber, 2, "quoted newline must remain inside one logical CSV record");
  assert.equal("homeShots" in event, false);
  assert.equal("homeCorners" in event, false);
  assert.doesNotMatch(JSON.stringify(event).toLowerCase(), /homeshots|homecorners|yellow|redcard/);

  assert.deepEqual(first.events, second.events, "canonical hashes must be deterministic");
  assert.deepEqual(first.manifest, second.manifest, "same bytes and rows must yield the same manifest");
  assert.equal(first.manifest.license, "MIT");
  assert.equal(first.manifest.sourceUrl, DATASET_CONFIGS.xgabora.sourceUrl);
  assert.match(first.manifest.sourceFileSha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.rootHash, /^[a-f0-9]{64}$/);
}

async function verifyIteratorAndMartj42() {
  const csv = [
    "date,home_team,away_team,home_score,away_score,tournament,city,country,neutral",
    '2024-03-01,"Côte d\'Ivoire",Nigeria,1,0,"Friendly, Senior",Abidjan,"Côte d\'Ivoire",FALSE',
    "",
  ].join("\n");
  const result = await drainIterator(iterateHistoricalEvents({
    dataset: "martj42",
    input: chunkedInput(csv, [1]),
    createdAt: CREATED_AT,
  }));

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].homeTeamNormalized, "cote d ivoire");
  assert.equal(result.events[0].competition, "Friendly, Senior");
  assert.equal(result.events[0].neutral, false);
  assert.equal("preMatchOdds" in result.events[0], false);
  assert.equal(result.manifest.license, "CC0");
  assert.equal(result.manifest.rows, 1);
  assert.equal(result.manifest.rejected, 0);
  assert.equal(result.manifest.conflicts, 0);
  assert.deepEqual(result.manifest.dateRange, { from: "2024-03-01", to: "2024-03-01" });
}

async function verifyAsOfBoundary() {
  const csv = [
    "Division,MatchDate,MatchTime,HomeTeam,AwayTeam,FTHome,FTAway",
    "T1,2024-01-01,,Alpha,Beta,1,0",
    "T1,2024-01-02,10:00Z,Charlie,Delta,0,0",
    "T1,2024-01-02,,Echo,Foxtrot,2,1",
    "T1,2024-01-03,09:00Z,Golf,Hotel,3,2",
    "",
  ].join("\n");
  const { events } = await callbackImport(csv, "xgabora");

  const atExactKickoff = asOf(events, "2024-01-02T10:00:00.000Z");
  assert.deepEqual(atExactKickoff.map((event) => event.homeTeamRaw), ["Alpha"]);

  const afterKickoff = asOf(events, "2024-01-02T12:00:00.000Z");
  assert.deepEqual(
    afterKickoff.map((event) => event.homeTeamRaw),
    ["Alpha", "Charlie"],
    "exact earlier kickoff is allowed but a date-only result on the forecast date is withheld",
  );

  const nextDate = asOf(events, "2024-01-03T00:00:00.000Z");
  assert.deepEqual(nextDate.map((event) => event.homeTeamRaw), ["Alpha", "Charlie", "Echo"]);
  assert.equal(nextDate.some((event) => event.homeTeamRaw === "Golf"), false);
}

async function verifyDuplicateAndConflictPolicies() {
  const header = "date,home_team,away_team,home_score,away_score,tournament,city,country,neutral";
  const row = "2024-04-01,Alpha,Beta,1,0,Friendly,X,Y,FALSE";
  const duplicate = await callbackImport([header, row, row, ""].join("\n"), "martj42");
  assert.equal(duplicate.events.length, 1);
  assert.equal(duplicate.manifest.inputRows, 2);
  assert.equal(duplicate.manifest.rows, 1);
  assert.equal(duplicate.manifest.duplicateRows, 1);
  assert.equal(duplicate.manifest.conflicts, 0);

  const conflictingCsv = [
    header,
    row,
    "2024-04-01,Alpha,Beta,2,0,Friendly,X,Y,FALSE",
    "",
  ].join("\n");
  const emitted = [];
  let thrown = null;
  try {
    await importHistoricalEvents({
      dataset: "martj42",
      input: chunkedInput(conflictingCsv),
      createdAt: CREATED_AT,
      onEvent: (event) => emitted.push(event),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof HistoricalEventConflictError);
  assert.equal(emitted.length, 1);
  assert.equal(thrown.partialManifest.rows, 1);
  assert.equal(thrown.partialManifest.conflicts, 1);
  assert.equal(thrown.conflict.firstSourceRowNumber, 2);
  assert.equal(thrown.conflict.conflictingSourceRowNumber, 3);
}

async function verifyInvalidRowsAreRejected() {
  const csv = [
    "date,home_team,away_team,home_score,away_score,tournament,city,country,neutral",
    "2024-05-01,Valid,Team,0,0,Friendly,X,Y,FALSE",
    "2024-02-30,Invalid,Date,1,0,Friendly,X,Y,FALSE",
    "2024-05-02,,MissingHome,1,0,Friendly,X,Y,FALSE",
    "2024-05-03,Negative,Score,-1,0,Friendly,X,Y,FALSE",
    "2024-05-04,Fractional,Score,1.5,0,Friendly,X,Y,FALSE",
    "2024-05-05,Invalid,Neutral,1,0,Friendly,X,Y,MAYBE",
    "",
  ].join("\n");
  const result = await callbackImport(csv, "martj42");
  assert.equal(result.events.length, 1);
  assert.equal(result.manifest.inputRows, 6);
  assert.equal(result.manifest.rows, 1);
  assert.equal(result.manifest.rejected, 5);
  assert.equal(result.rejectedRows.length, 5);
  assert.deepEqual(
    new Set(result.rejectedRows.map((row) => row.reason)),
    new Set(["INVALID_DATE", "INVALID_TEAM_NAME", "INVALID_SCORE", "INVALID_NEUTRAL"]),
  );
}

async function verifyInputOrderIsolation() {
  const header = "date,home_team,away_team,home_score,away_score,tournament,city,country,neutral";
  const older = "2023-12-01,Older,Opponent,1,0,Friendly,X,Y,FALSE";
  const future = "2025-12-01,Future,Opponent,0,1,Friendly,X,Y,FALSE";
  const a = await callbackImport([header, older, future, ""].join("\n"), "martj42");
  const b = await callbackImport([header, future, older, ""].join("\n"), "martj42");

  const signature = (events) => events
    .map((event) => `${event.sourceEventId}:${event.eventSha256}`)
    .sort();
  assert.deepEqual(signature(a.events), signature(b.events));
  assert.equal(a.manifest.rootHash, b.manifest.rootHash, "root hash must not depend on source row order");
  assert.notEqual(
    a.manifest.sourceFileSha256,
    b.manifest.sourceFileSha256,
    "raw source hash should still expose byte/order changes",
  );

  const eligibleA = asOf(a.events, "2024-06-01T00:00:00.000Z");
  const eligibleB = asOf(b.events, "2024-06-01T00:00:00.000Z");
  assert.deepEqual(signature(eligibleA), signature(eligibleB));
  assert.equal(eligibleA.length, 1);
  assert.equal(eligibleA[0].homeTeamRaw, "Older");
}

async function main() {
  assert.deepEqual(parseCsvRecord('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
  await verifyQuotedCsvAndLeakageBoundary();
  await verifyIteratorAndMartj42();
  await verifyAsOfBoundary();
  await verifyDuplicateAndConflictPolicies();
  await verifyInvalidRowsAreRejected();
  await verifyInputOrderIsolation();

  process.stdout.write(JSON.stringify({
    ok: true,
    verifier: "historical-event-store",
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    checks: [
      "quoted-and-multiline-csv",
      "callback-and-iterator-streaming",
      "canonical-hash-determinism",
      "strict-as-of-boundary",
      "exact-duplicate-deduplication",
      "same-key-conflict-fail-closed",
      "invalid-row-rejection",
      "input-order-and-future-row-isolation",
      "post-match-field-exclusion",
      "manifest-provenance",
    ],
  }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
