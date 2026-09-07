"use strict";
const assert = require("node:assert/strict");
const clock = require("./apiFootballClockEvidence.cjs");
const api = require("./syncApiFootballData.cjs");

function verifyClockEvidence() {
  let assertions = 0;
  const check = (ok, label) => { assert.ok(ok, label); assertions++; };
  const observedAt = "2026-09-07T13:00:00Z", cutoff = "2026-09-07T14:00:00Z";
  const entry = { match: { buyEndTime: cutoff, kickoffTime: "2026-09-07T15:00:00Z" },
    map: { fixtureId: 1, homeTeamId: 11, awayTeamId: 12 } };
  const piece = api.buildPieceMetadata({ entry, endpoint: "/fixtures/lineups", observedAt });
  check(piece.sourceUpdatedAt === null && piece.provenance.sourceUpdatedAt === null, "missing source clock stays missing");
  check(piece.clockEvidence.sourceTimeStatus === "missing", "missing source clock is exposed");
  check(piece.clockEvidence.upstreamTimeVerified === false, "receipt is not upstream proof");
  check(piece.temporalEligibility.eligible, "valid local receipt remains shadow eligible");
  check(clock.pieceClockEligible(piece, entry), "valid v2 fragment replays");
  check(api.buildPieceMetadata({ entry, endpoint: "/injuries" }).observedAt === null, "builder cannot invent fetch time");
  check(!api.buildPieceMetadata({ entry, endpoint: "/injuries" }).temporalEligibility.eligible, "missing fetch time fails closed");
  for (const bad of ["2026-02-30T12:00:00Z", "2026-09-07T24:00:00Z", "2026-09-07", "2026-09-07T13:00:00", false, 0, "", {}, []]) {
    check(!api.temporalEligibilityFor(bad, cutoff).eligible, "invalid observed clock rejected");
    check(!api.temporalEligibilityFor(observedAt, bad).eligible, "invalid cutoff rejected");
    check(api.prematchCutoffFor({ match: { buyEndTime: bad, kickoffTime: cutoff } }) === null,
      "malformed primary cutoff cannot fall through");
  }
  check(api.prematchCutoffFor({ match: { buyEndTime: null, kickoffTime: cutoff } }) === cutoff, "absent optional clock may fall through");
  check(api.temporalEligibilityFor(cutoff, cutoff).eligible, "equal receipt/cutoff remains valid");
  check(!api.temporalEligibilityFor("2026-09-07T14:00:01Z", cutoff).eligible, "late receipt rejected");
  check(api.temporalEligibilityFor("2026-09-07T21:00:00+08:00", cutoff).eligible, "real zone offsets work");
  const invalidSource = api.buildPieceMetadata({ entry, endpoint: "/odds", observedAt, sourceUpdatedAt: "2026-02-30T00:00:00Z" });
  check(!invalidSource.temporalEligibility.eligible && invalidSource.clockEvidence.sourceTimeStatus === "invalid", "invalid declared source clock rejects");
  const futureSource = api.buildPieceMetadata({ entry, endpoint: "/odds", observedAt, sourceUpdatedAt: "2026-09-07T13:01:00Z" });
  check(!futureSource.temporalEligibility.eligible && futureSource.clockEvidence.sourceTimeStatus === "after-receipt", "source clock after receipt rejects");
  const earlierSource = api.buildPieceMetadata({ entry, endpoint: "/odds", observedAt, sourceUpdatedAt: "2026-09-07T12:59:00Z" });
  check(clock.pieceClockEligible(earlierSource, entry), "honest earlier upstream clock retained");
  check(!clock.pieceClockEligible({ ...piece, clockEvidence: undefined }), "old cache boolean is not sufficient");
  check(!clock.pieceClockEligible({ ...piece, observedAt: "2026-09-07T14:01:00Z" }), "tampered receipt cannot borrow old boolean");
  check(!clock.pieceClockEligible(piece, { match: { buyEndTime: "2026-09-07T12:59:00Z" } }), "new earlier cutoff invalidates cached eligibility");
  check(!clock.pieceClockEligible({ ...piece, provenance: { ...piece.provenance, fetchedAt: cutoff } }), "provenance disagreement rejected");
  check(!clock.pieceClockEligible({ ...piece, sourceUpdatedAt: "2026-09-07T12:00:00Z" }), "source clock cannot be inserted without matching evidence");
  const legacy = { source: "api-football", temporalEligibility: { eligible: true } };
  const merged = api.mergeSignal(null, { apiFootball: {}, lineups: legacy }, entry);
  check(!merged.lineups && merged.apiFootball.temporalRejections.length === 1, "incoming legacy true cannot bypass merge");
  check(legacy.temporalEligibility.eligible === true, "raw old evidence is not rewritten");
  check(api.mergeSignal(null, { apiFootball: {}, lineups: piece }, entry).lineups === piece, "new valid piece reaches merge");
  check(!api.mergeSignal(null, { apiFootball: {}, lineups: piece }, { match: { buyEndTime: "2026-09-07T12:59:00Z" } }).lineups,
    "actual current cutoff used at final merge");
  const other = { source: "another-provider", summary: "unrelated" };
  check(api.mergeSignal(null, { apiFootball: {}, injuries: other }, entry).injuries === other, "unrelated sources unchanged");
  const lineup = api.buildLineups(entry, [{ team: { id: 11 }, startXI: [] }], { observedAt });
  check(lineup.sourceUpdatedAt === null && lineup.temporalEligibility.eligible, "actual lineup builder does not synthesize source clock");
  const injuries = api.buildInjuriesByFixture([entry], [{ fixture: { id: 1 }, team: { id: 11 }, player: { id: 2, name: "Example" } }], { observedAt }).get("1");
  check(injuries.sourceUpdatedAt === null && injuries.temporalEligibility.eligible, "actual injuries builder keeps missing upstream clock");
  const match = { id: "clock-fixture", homeTeamNameEn: "Alpha Club", awayTeamNameEn: "Beta Club",
    leagueNameEn: "La Liga", kickoffTime: "2026-03-02T12:00:00Z" };
  const fixture = { fixtureId: 1, date: "2026-02-30T12:00:00Z", league: { name: "La Liga" },
    teams: { home: { id: 11, name: "Alpha Club" }, away: { id: 12, name: "Beta Club" } } };
  check(api.confidenceForFixture(match, fixture).timeScore === 0, "impossible provider date cannot match normalized kickoff");
  check(api.confidenceForFixture({ ...match, kickoffTime: fixture.date }, { ...fixture, date: match.kickoffTime }).timeScore === 0,
    "impossible local date cannot match real provider kickoff");
  const mapping = { fixtureId: 1, confidence: 1, homeTeamId: 11, awayTeamId: 12, fixtureDate: fixture.date };
  check(api.mappingVerificationState(match, mapping, null).blockers.includes("provider-fixture-time-mismatch"),
    "cached mapping revalidation uses strict calendar clocks");
  const staleReason = { apiFootball: { temporalRejections: ["lineups:clock-evidence-not-verifiable"] } };
  check(api.mergeSignal(staleReason, { apiFootball: {}, lineups: piece }, entry).apiFootball.temporalRejections.length === 0,
    "fresh valid fragment clears previous rejection message");
  return { ok: true, assertions, networkCalls: 0, productionDataWritten: false };
}
if (require.main === module) console.log(JSON.stringify(verifyClockEvidence()));
module.exports = { verifyClockEvidence };
