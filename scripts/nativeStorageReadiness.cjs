"use strict";
// Storage proof is independent of model promotion and source freshness gates.
// Those existing gates remain mandatory in their respective release checks.
function nativeStorageReadiness(health) {
  const storage = health?.storage || {}, pg = storage.postgres || {}, sqlite = storage.sqlite || {};
  const publication = pg.publication || {}, blockers = [];
  if (storage.primary !== "postgres" || health?.data?.currentRead?.source !== "postgres") blockers.push("native-primary-read-required");
  if (sqlite.retired !== true || sqlite.available !== false || sqlite.readSource !== "postgres") blockers.push("sqlite-not-retired");
  if (pg.available !== true || pg.baseReady === false || pg.baseBlockedReason) blockers.push("postgres-base-unavailable");
  if (publication.mode !== "active-generation" || !/^g-[a-f0-9]{64}$/.test(publication.generationId || "")
    || !/^[a-f0-9]{64}$/.test(publication.manifestHash || "") || !publication.sourceCycleId
    || !Number.isFinite(Date.parse(publication.committedAt || ""))) blockers.push("native-publication-identity-incomplete");
  if (storage.fastResultIntegrity?.valid !== true) blockers.push("native-result-receipt-invalid");
  return { ok: blockers.length === 0, storage: "postgres", sqliteRetired: sqlite.retired === true,
    publication, blockers };
}
module.exports = { nativeStorageReadiness };
