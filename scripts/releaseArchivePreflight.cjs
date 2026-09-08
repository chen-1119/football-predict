"use strict";
const assert = require("node:assert/strict");
const { digest, validateManifest, restoreMissingArchive } = require("./frozenArchiveRestoration.cjs");
const { validArchivedPreMatchPrediction, isOfficialVoidMatch } = require("./syncData.cjs");
const eventKey = row => JSON.stringify([String(row.sourceMatchId), Date.parse(row.eventVersion || row.kickoffTime), Date.parse(row.kickoffTime)]);

function evaluateArchivePreflight(snapshot, manifest, now = new Date().toISOString()) {
  const index = validateManifest(manifest);
  assert.equal(snapshot.version, "release-archive-observation-v1");
  assert.equal(snapshot.productionWrites, 0);
  assert.match(snapshot.releaseMarker || "", /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.generation).sort(), ["committedAt", "generationId", "manifestHash", "schemaVersion", "sourceCycleId"].sort());
  for (const field of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) assert.ok(snapshot.generation[field]);
  const age = Date.parse(now) - Date.parse(snapshot.checkedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 15 * 60 * 1000, "archive observation expired or future-dated");
  const rows = new Map();
  for (const row of snapshot.rows) { const key = eventKey(row.match); assert.ok(!rows.has(key), "ambiguous observed archive event"); rows.set(key, row); }
  const missing = [], preserved = [], blockers = [];
  for (const original of manifest.baseline.records) {
    const current = rows.get(eventKey(original));
    if (!current) { blockers.push({ sourceMatchId: original.sourceMatchId, reason: "original-event-missing" }); continue; }
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
    preservedRows: preserved.length, restorableRows: missing.length, missing, blockers,
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
      rows.push({ match: compact, archiveSha256: match.archivedPreMatchPrediction ? hash(match.archivedPreMatchPrediction) : null });
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
module.exports = { evaluateArchivePreflight, collectArchiveObservation, buildReadOnlyArchiveProbe };
