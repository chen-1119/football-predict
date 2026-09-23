"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { digest } = require("./frozenArchiveRestoration.cjs");
const { fixedAuthority, fixedManifest, archiveObservation, evaluateSuccessorRows,
  evaluateFullBaselineObservations } = require("./verifyReleaseArchiveSuccessor.cjs");

function verifyReleaseArchiveSuccessorContracts() {
  const signed = fixedAuthority();
  assert.equal(signed.original.archiveSha256, "ef75062426a7779ca8e1b379be8d8301f65abcd54b7323045db2dff21d76356c");
  assert.equal(signed.successor.archiveSha256, "f3afbb0499c869c7f0334fb8c7eb4e1b8621e1fe8446e450d0e777e52c2faecb");
  const successor = signed.successor;
  const archive = { source: successor.source, sourceMatchId: successor.sourceMatchId, matchId: successor.id,
    eventVersion: successor.eventVersion, kickoffTime: successor.kickoffTime, capturedAt: successor.capturedAt,
    phase: successor.phase, cutoffTime: successor.cutoffTime,
    prediction: { oddsPoolCode: successor.oddsPoolCode, tipCode: successor.tipCode, odds: successor.odds } };
  const lineage = { ...signed, successor: { ...successor, archiveSha256: digest(archive) } };
  const match = { id: successor.id, sourceMatchId: successor.sourceMatchId,
    eventVersion: successor.eventVersion, kickoffTime: successor.kickoffTime,
    homeTeamName: successor.homeTeamName, awayTeamName: successor.awayTeamName,
    archivedPreMatchPrediction: archive };
  const pointer = { generationId: "g-" + "a".repeat(64), manifestHash: "b".repeat(64),
    sourceCycleId: "official-1", committedAt: "2026-09-23T00:00:00.000Z" };
  const identity = { mode: "active-generation", ...pointer };
  const history = [{ dataset: "history", match }];
  const postgresRows = [{ rowId: `history:${successor.id}`, dataset: "history", matchId: successor.id, match: structuredClone(match) }];
  const input = { lineage, generationRows: history, postgresRows,
    postgresIdentity: identity, generationPointer: pointer };
  const accepted = evaluateSuccessorRows(input);
  assert.equal(accepted.ok, true); assert.equal(accepted.databaseWrites, 0);
  const fail = (change, reason) => assert.throws(() => evaluateSuccessorRows(change), reason);
  fail({ ...input, postgresRows: [] }, /exactly one/);
  fail({ ...input, generationRows: [...history, ...history] }, /exactly one/);
  fail({ ...input, postgresRows: [{ ...postgresRows[0], dataset: "current" }] }, /historical/);
  fail({ ...input, postgresRows: [{ ...postgresRows[0], rowId: `history:other` }] }, /row identity/);
  fail({ ...input, postgresRows: [{ ...postgresRows[0], matchId: "other" }] }, /match identity/);
  fail({ ...input, postgresIdentity: { ...identity, manifestHash: "c".repeat(64) } }, /manifestHash mismatch/);
  fail({ ...input, postgresIdentity: { ...identity, sourceCycleId: "other" } }, /sourceCycleId mismatch/);
  fail({ ...input, postgresIdentity: { ...identity, committedAt: "2026-09-22T00:00:00.000Z" } }, /commit timestamp mismatch/);
  fail({ ...input, postgresRows: [{ ...postgresRows[0], match: {
    ...match, archivedPreMatchPrediction: { ...archive, prediction: { ...archive.prediction, tipCode: "H" } } } }] }, /exact signed/);
  fail({ ...input, generationRows: [{ dataset: "history", match: { ...match, homeTeamName: "other" } }] }, /exact signed/);
  fail({ ...input, generationRows: [{ dataset: "history", match: {
    ...match, archivedPreMatchPrediction: { ...archive, capturedAt: "2026-08-08T00:00:00.000Z" } } }] }, /exact signed/);
  const manifest = fixedManifest(), rekeys = {
    fivehundred_2041279: "sporttery_2041279", fivehundred_2041287: "sporttery_2041287",
    sporttery_2041320: "fivehundred_2041320", sporttery_2041321: "fivehundred_2041321",
    sporttery_2041322: "fivehundred_2041322", sporttery_2041323: "fivehundred_2041323",
    sporttery_2041324: "fivehundred_2041324", sporttery_2041325: "fivehundred_2041325",
    sporttery_2041326: "fivehundred_2041326", sporttery_2041327: "fivehundred_2041327",
  };
  const generationBaseline = manifest.rows.map(row => archiveObservation({ dataset: "history", match: {
    ...row.identity, id: rekeys[row.identity.id] || row.identity.id,
    archivedPreMatchPrediction: row.archive } }));
  const successorRow = generationBaseline.find(row => row.match.sourceMatchId === signed.original.sourceMatchId);
  Object.assign(successorRow.match, signed.successor);
  successorRow.archiveSha256 = signed.successor.archiveSha256;
  successorRow.archiveMeta = { sourceMatchId: signed.successor.sourceMatchId, matchId: signed.successor.id,
    eventVersion: signed.successor.eventVersion, kickoffTime: signed.successor.kickoffTime,
    source: signed.successor.source, capturedAt: signed.successor.capturedAt, phase: signed.successor.phase,
    cutoffTime: signed.successor.cutoffTime, oddsPoolCode: signed.successor.oddsPoolCode,
    tipCode: signed.successor.tipCode, odds: signed.successor.odds };
  const postgresBaseline = generationBaseline.map(row => ({ ...structuredClone(row), rowId: `history:${row.match.id}`,
    matchId: row.match.id, sourceMatchIdColumn: row.match.sourceMatchId }));
  const full = { manifest, generationRows: generationBaseline, postgresRows: postgresBaseline,
    generationPointer: { schemaVersion: 1, ...pointer }, releaseSha: "c".repeat(64) };
  const failFull = (change, reason) => assert.throws(() => evaluateFullBaselineObservations(change), reason);
  const baseline = evaluateFullBaselineObservations(full);
  assert.equal(baseline.baselineRows, 601); assert.equal(baseline.preservedRows, 600);
  assert.equal(baseline.rekeyedIdentityRows, 10); assert.equal(baseline.supersededRows, 1);
  const originalSource = generationBaseline.find(row => row.match.sourceMatchId !== signed.original.sourceMatchId).match.sourceMatchId;
  const changedPg = structuredClone(postgresBaseline);
  changedPg.find(row => row.match.sourceMatchId === originalSource).archiveSha256 = "0".repeat(64);
  failFull({ ...full, postgresRows: changedPg }, /archive differs/);
  const changedGeneration = structuredClone(generationBaseline);
  changedGeneration.find(row => row.match.sourceMatchId === originalSource).archiveSha256 = "0".repeat(64);
  failFull({ ...full, generationRows: changedGeneration }, /archive differs/);
  const missingOriginal = structuredClone(generationBaseline);
  missingOriginal.find(row => row.match.sourceMatchId === originalSource).archiveSha256 = null;
  const matchingMissingPg = structuredClone(postgresBaseline);
  matchingMissingPg.find(row => row.match.sourceMatchId === originalSource).archiveSha256 = null;
  failFull({ ...full, generationRows: missingOriginal, postgresRows: matchingMissingPg }, /unmaterialized/);
  const changedPgId = structuredClone(postgresBaseline);
  changedPgId[0].rowId = "history:other";
  failFull({ ...full, postgresRows: changedPgId }, /row identity differs/);
  const swappedSourceColumns = structuredClone(postgresBaseline);
  [swappedSourceColumns[0].sourceMatchIdColumn, swappedSourceColumns[1].sourceMatchIdColumn] =
    [swappedSourceColumns[1].sourceMatchIdColumn, swappedSourceColumns[0].sourceMatchIdColumn];
  failFull({ ...full, postgresRows: swappedSourceColumns }, /source column differs/);
  const removed = structuredClone(generationBaseline).slice(1);
  failFull({ ...full, generationRows: removed }, /all 601/);
  const lane = fs.readFileSync(path.join(__dirname, "../deploy/light-server/release-native.sh"), "utf8");
  const candidate = lane.indexOf('verifyReleaseArchiveSuccessor.cjs" candidate "$BUNDLE_SHA256" "$CANDIDATE_STORE_DIR"');
  const live = lane.indexOf('verifyReleaseArchiveSuccessor.cjs" live "$BUNDLE_SHA256"');
  assert.ok(candidate > lane.indexOf("native_materialize_candidate") && candidate < lane.indexOf("run_trusted_candidate_verifier"),
    "candidate lineage gate must precede candidate acceptance");
  assert.ok(live > lane.indexOf("native_finish_readiness()") && live < lane.indexOf('"$APP_DIR/.release-live-complete.next"'),
    "live lineage gate must precede final acceptance marker");
  return { ok: true, checks: 21, productionWrites: 0 };
}
module.exports = { verifyReleaseArchiveSuccessorContracts };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyReleaseArchiveSuccessorContracts())); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
