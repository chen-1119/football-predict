"use strict";

const assert = require("node:assert/strict");
const { sameEventCompatible } = require("./reconcileFastResultGenerationCompat.cjs");

const base = {
  sourceMatchId: "123456",
  kickoffTime: "2026-09-16T12:00:00+08:00",
  eventVersion: "2026-09-16T12:00:00+08:00",
  homeTeamId: "team-home",
  homeTeamName: "Home Club",
  awayTeamId: "team-away",
  awayTeamName: "Away Club",
};

const cases = [
  {
    name: "same strong ids allow display-name drift",
    left: base,
    right: { ...base, homeTeamName: "Home FC", awayTeamName: "Away United" },
    expected: true,
  },
  {
    name: "id on one surface and name on the other is incomparable, not conflicting",
    left: base,
    right: {
      sourceMatchId: base.sourceMatchId,
      kickoffTime: base.kickoffTime,
      eventVersion: base.eventVersion,
      homeTeamName: "Home Club",
      awayTeamName: "Away Club",
    },
    expected: true,
  },
  {
    name: "different strong home ids stay rejected",
    left: base,
    right: { ...base, homeTeamId: "other-home" },
    expected: false,
  },
  {
    name: "swapped strong ids stay rejected",
    left: base,
    right: {
      ...base,
      homeTeamId: base.awayTeamId,
      awayTeamId: base.homeTeamId,
    },
    expected: false,
  },
  {
    name: "different provider match ids stay rejected",
    left: base,
    right: { ...base, sourceMatchId: "999999" },
    expected: false,
  },
  {
    name: "different kickoff stays rejected",
    left: base,
    right: {
      ...base,
      kickoffTime: "2026-09-16T12:30:00+08:00",
      eventVersion: "2026-09-16T12:30:00+08:00",
    },
    expected: false,
  },
  {
    name: "different explicit event version stays rejected",
    left: base,
    right: { ...base, eventVersion: "2026-09-16T12:30:00+08:00" },
    expected: false,
  },
  {
    name: "without provider id both team sides must be comparable",
    left: {
      kickoffTime: base.kickoffTime,
      homeTeamName: "Home Club",
      awayTeamName: "Away Club",
    },
    right: {
      kickoffTime: base.kickoffTime,
      homeTeamName: "Home Club",
      awayTeamName: "Away Club",
    },
    expected: true,
  },
  {
    name: "without provider id incomparable team representations do not merge",
    left: {
      kickoffTime: base.kickoffTime,
      homeTeamId: "team-home",
      awayTeamId: "team-away",
    },
    right: {
      kickoffTime: base.kickoffTime,
      homeTeamName: "Home Club",
      awayTeamName: "Away Club",
    },
    expected: false,
  },
];

for (const test of cases) {
  assert.equal(sameEventCompatible(test.left, test.right), test.expected, test.name);
}

process.stdout.write(`${JSON.stringify({ ok: true, tests: cases.length }, null, 2)}\n`);
