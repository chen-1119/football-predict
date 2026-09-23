"use strict";
const assert = require("node:assert/strict");
const { digest, validateManifest, restoreMissingArchive } = require("./frozenArchiveRestoration.cjs");
const { validArchivedPreMatchPrediction, isOfficialVoidMatch } = require("./syncData.cjs");
const SUCCESSOR_LINEAGE = require("./data/archive-successor-lineage.json");
const SUCCESSOR_LINEAGE_SHA256 = "af1524fd830d044fe0281cff8e9986160c6d762d4ae86b143d5b1f9bd2a1c520";
const REKEYED_ORIGINAL_IDS = Object.freeze({
  fivehundred_2041279: "sporttery_2041279",
  fivehundred_2041287: "sporttery_2041287",
  sporttery_2041320: "fivehundred_2041320",
  sporttery_2041321: "fivehundred_2041321",
  sporttery_2041322: "fivehundred_2041322",
  sporttery_2041323: "fivehundred_2041323",
  sporttery_2041324: "fivehundred_2041324",
  sporttery_2041325: "fivehundred_2041325",
  sporttery_2041326: "fivehundred_2041326",
  sporttery_2041327: "fivehundred_2041327",
});
const eventKey = row => JSON.stringify([String(row.id), String(row.sourceMatchId),
  Date.parse(row.eventVersion || row.kickoffTime), Date.parse(row.kickoffTime)]);
const sourceEventKey = row => JSON.stringify([String(row.sourceMatchId),
  Date.parse(row.eventVersion || row.kickoffTime), Date.parse(row.kickoffTime)]);
const shanghaiClock = value => Date.parse(String(value).replace(" ", "T") + "+08:00");

function validateSuccessorLineage(manifest) {
  const lineage = SUCCESSOR_LINEAGE;
  assert.equal(digest(lineage), SUCCESSOR_LINEAGE_SHA256, "archive successor lineage content changed");
  assert.deepEqual(Object.keys(lineage).sort(), ["version", "manifestIntegritySha256", "baselineRootHash", "original", "successor"].sort());
  assert.equal(lineage.version, "archive-successor-lineage-v1");
  assert.equal(lineage.manifestIntegritySha256, "6b74c192a0408a3c0b6ccc5aabdd4f017d3523ffbd070027d74037fc1648e913");
  assert.equal(lineage.baselineRootHash, "dd5d5325cfcafb3f704fef96ba25d47c963a345887a24632c07f71efda9bc3fa");
  assert.equal(manifest.integritySha256, lineage.manifestIntegritySha256);
  assert.equal(manifest.baseline.archiveRootHash, lineage.baselineRootHash);
  assert.equal(lineage.original.id, "fivehundred_2040739");
  assert.equal(lineage.successor.id, "sporttery_2040739");
  assert.equal(lineage.original.archiveSha256, "ef75062426a7779ca8e1b379be8d8301f65abcd54b7323045db2dff21d76356c");
  assert.equal(lineage.successor.archiveSha256, "f3afbb0499c869c7f0334fb8c7eb4e1b8621e1fe8446e450d0e777e52c2faecb");
  assert.equal(lineage.original.sourceMatchId, lineage.successor.sourceMatchId);
  assert.equal(Date.parse(lineage.original.eventVersion), Date.parse(lineage.successor.eventVersion));
  assert.equal(Date.parse(lineage.original.kickoffTime), Date.parse(lineage.successor.kickoffTime));
  const original = manifest.baseline.records.find(row => row.id === lineage.original.id);
  const originalRow = manifest.rows.find(row => row.identity.id === lineage.original.id);
  assert.ok(original && originalRow, "signed original successor baseline is missing");
  for (const field of ["id", "sourceMatchId", "eventVersion", "kickoffTime", "archiveSha256"])
    assert.equal(original[field], lineage.original[field], "signed original successor baseline changed: " + field);
  for (const field of ["id", "sourceMatchId", "eventVersion", "kickoffTime", "homeTeamName", "awayTeamName"])
    assert.equal(originalRow.identity[field], lineage.original[field], "signed original successor identity changed: " + field);
  assert.equal(originalRow.archiveSha256, lineage.original.archiveSha256);
  assert.equal(digest(originalRow.archive), lineage.original.archiveSha256);
  assert.equal(originalRow.archive.matchId, lineage.original.id);
  assert.equal(originalRow.archive.capturedAt, lineage.original.capturedAt);
  return { lineage, original };
}

function exactSuccessor(row, lineage) {
  if (!row || row.archiveSha256 !== lineage.successor.archiveSha256) return false;
  const expected = lineage.successor, match = row.match, archive = row.archiveMeta;
  if (!match || !archive) return false;
  for (const field of ["id", "sourceMatchId", "eventVersion", "kickoffTime", "homeTeamName", "awayTeamName"])
    if (match[field] !== expected[field]) return false;
  for (const [field, value] of Object.entries({ sourceMatchId: expected.sourceMatchId, matchId: expected.id,
    eventVersion: expected.eventVersion, kickoffTime: expected.kickoffTime, source: expected.source,
    capturedAt: expected.capturedAt, phase: expected.phase, cutoffTime: expected.cutoffTime,
    oddsPoolCode: expected.oddsPoolCode, tipCode: expected.tipCode, odds: expected.odds }))
    if (archive[field] !== value) return false;
  const originalAt = Date.parse(lineage.original.capturedAt), successorAt = Date.parse(archive.capturedAt);
  const cutoffAt = shanghaiClock(archive.cutoffTime), kickoffAt = Date.parse(archive.kickoffTime);
  return Number.isFinite(originalAt) && Number.isFinite(successorAt) && Number.isFinite(cutoffAt)
    && Number.isFinite(kickoffAt) && originalAt < successorAt && successorAt < cutoffAt && cutoffAt < kickoffAt;
}

function exactRekeyedOriginal(row, original, signedRow) {
  if (REKEYED_ORIGINAL_IDS[original.id] !== row?.match?.id) return false;
  if (!row || row.archiveSha256 !== original.archiveSha256 || !signedRow?.archive || !row.archiveMeta) return false;
  for (const field of ["sourceMatchId", "eventVersion", "kickoffTime", "homeTeamName", "awayTeamName"])
    if (row.match?.[field] !== signedRow.identity[field]) return false;
  const archive = signedRow.archive;
  for (const [field, value] of Object.entries({ sourceMatchId: archive.sourceMatchId, matchId: archive.matchId,
    eventVersion: archive.eventVersion, kickoffTime: archive.kickoffTime, source: archive.source,
    capturedAt: archive.capturedAt, phase: archive.phase, cutoffTime: archive.cutoffTime,
    oddsPoolCode: archive.prediction?.oddsPoolCode, tipCode: archive.prediction?.tipCode,
    odds: archive.prediction?.odds }))
    if (row.archiveMeta[field] !== value) return false;
  return true;
}

function evaluateArchivePreflight(snapshot, manifest, now = new Date().toISOString()) {
  const index = validateManifest(manifest);
  const { lineage } = validateSuccessorLineage(manifest);
  assert.equal(snapshot.version, "release-archive-observation-v1");
  assert.equal(snapshot.productionWrites, 0);
  assert.match(snapshot.releaseMarker || "", /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.generation).sort(), ["committedAt", "generationId", "manifestHash", "schemaVersion", "sourceCycleId"].sort());
  for (const field of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) assert.ok(snapshot.generation[field]);
  const age = Date.parse(now) - Date.parse(snapshot.checkedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 15 * 60 * 1000, "archive observation expired or future-dated");
  const rows = new Map(), sourceEvents = new Map();
  for (const row of snapshot.rows) {
    const key = eventKey(row.match), sourceKey = sourceEventKey(row.match);
    assert.ok(!rows.has(key), "ambiguous observed archive event"); rows.set(key, row);
    sourceEvents.set(sourceKey, [...(sourceEvents.get(sourceKey) || []), row]);
  }
  const originalRowsById = new Map(manifest.rows.map(row => [row.identity.id, row]));
  const missing = [], preserved = [], rekeyed = [], superseded = [], blockers = [];
  for (const original of manifest.baseline.records) {
    const current = rows.get(eventKey(original));
    if (!current) {
      // A provider can change the serving match id while carrying the exact
      // original archive bytes forward. This is still strict preservation,
      // never permission to replace or synthesize an archive object.
      const sameEvent = sourceEvents.get(sourceEventKey(original)) || [];
      if (sameEvent.length === 1 && exactRekeyedOriginal(sameEvent[0], original, originalRowsById.get(original.id))) {
        preserved.push(original.sourceMatchId); rekeyed.push(original.sourceMatchId); continue;
      }
      if (original.id === lineage.original.id) {
        const successor = rows.get(eventKey(lineage.successor));
        const sameSource = snapshot.rows.filter(row => row.match?.sourceMatchId === original.sourceMatchId);
        if (sameSource.length === 1 && exactSuccessor(successor, lineage)) {
          superseded.push({ sourceMatchId: original.sourceMatchId, originalArchiveSha256: original.archiveSha256,
            successorArchiveSha256: successor.archiveSha256 });
          continue;
        }
        blockers.push({ sourceMatchId: original.sourceMatchId, reason: successor ? "unverified-original-successor" : "original-event-missing" });
      } else blockers.push({ sourceMatchId: original.sourceMatchId, reason: "original-event-missing" });
      continue;
    }
    if (current.archiveSha256 !== null) {
      if (current.archiveSha256 !== original.archiveSha256) blockers.push({ sourceMatchId: original.sourceMatchId, reason: "original-object-changed" });
      else preserved.push(original.sourceMatchId);
      continue;
    }
    const restored = restoreMissingArchive(current.match, index, snapshot.checkedAt,
      (match, archive) => !isOfficialVoidMatch(match) && validArchivedPreMatchPrediction(match, archive));
    if (!restored.archivedPreMatchPrediction || digest(restored.archivedPreMatchPrediction) !== original.archiveSha256) {
      blockers.push({ sourceMatchId: original.sourceMatchId, reason: "missing-original-not-safely-restorable" });
    } else missing.push({ sourceMatchId: original.sourceMatchId, archiveSha256: original.archiveSha256 });
  }
  return { version: "release-archive-preflight-v1", checkedAt: now, observationAt: snapshot.checkedAt,
    ok: blockers.length === 0, manifestSha256: manifest.integritySha256, baselineRootHash: manifest.baseline.archiveRootHash,
    releaseMarker: snapshot.releaseMarker, generation: snapshot.generation, baselineRows: manifest.baseline.rows,
    preservedRows: preserved.length, rekeyedIdentityRows: rekeyed.length,
    restorableRows: missing.length, supersededRows: superseded.length, superseded, missing, blockers,
    productionWrites: 0, readyToCutover: false,
    scope: "Early preparation check only. Restorable originals are not yet restored; fresh final signed-release/database checks remain mandatory." };
}

// Serialized unchanged over the caller's pinned SSH connection. It only reads
// one immutable generation; no arbitrary path, command or secret is accepted.
function collectArchiveObservation(sourceIds) {
  const fs = require("node:fs"), crypto = require("node:crypto"), assert = require("node:assert/strict");
  const root = "/opt/football-predict", store = require(root + "/server/dataGenerationStore.cjs");
  const context = store.resolveCurrentGeneration({ storeDir: "/var/lib/football-predict" });
  const pointer = JSON.stringify(context.pointer), wanted = new Set(sourceIds), rows = [];
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const hash = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
  for (const name of ["matches-current.json", "matches-history.json"]) {
    const payload = store.readGenerationFile(context, name, { parseJson: true });
    for (const match of Array.isArray(payload) ? payload : payload.matches || []) {
      if (!wanted.has(String(match.sourceMatchId))) continue;
      const compact = Object.fromEntries(Object.entries(match).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)));
      compact.externalSignals = { buyEndTime: match.externalSignals?.buyEndTime || null,
        fiveHundred: { sale: { buyEndTime: match.externalSignals?.fiveHundred?.sale?.buyEndTime || null } } };
      const archive = match.archivedPreMatchPrediction;
      rows.push({ match: compact, archiveSha256: archive ? hash(archive) : null,
        archiveMeta: archive ? { sourceMatchId: archive.sourceMatchId || null, matchId: archive.matchId || null,
          eventVersion: archive.eventVersion || null, kickoffTime: archive.kickoffTime || null,
          source: archive.source || null, capturedAt: archive.capturedAt || null, phase: archive.phase || null,
          cutoffTime: archive.cutoffTime || null, oddsPoolCode: archive.prediction?.oddsPoolCode || null,
          tipCode: archive.prediction?.tipCode || null, odds: archive.prediction?.odds ?? null } : null });
    }
  }
  assert.equal(JSON.stringify(store.resolveCurrentGeneration({ storeDir: "/var/lib/football-predict" }).pointer), pointer, "generation changed during archive preflight");
  return { version: "release-archive-observation-v1", checkedAt: new Date().toISOString(),
    releaseMarker: fs.readFileSync(root + "/.release-bundle-sha256", "utf8").trim(), generation: context.pointer, rows, productionWrites: 0 };
}
function buildReadOnlyArchiveProbe(manifest) {
  validateManifest(manifest);
  return `const collect = ${collectArchiveObservation.toString()};\nconsole.log(JSON.stringify(collect(${JSON.stringify(manifest.baseline.records.map(row => row.sourceMatchId))})));`;
}
module.exports = { SUCCESSOR_LINEAGE, validateSuccessorLineage, exactSuccessor, exactRekeyedOriginal,
  evaluateArchivePreflight, collectArchiveObservation, buildReadOnlyArchiveProbe };
