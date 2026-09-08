"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const VERSION = "frozen-archive-restoration-v1";
const SOURCE = "release-bound-published-store-backup";
const DEFAULT_PATH = path.join(__dirname, "data", "frozen-archive-restoration.json");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const text = value => String(value ?? "").trim();
const instant = value => {
  const s = text(value);
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? Date.parse(s) : NaN;
};
const sourceId = match => text(match?.sourceMatchId || match?.id).replace(/^(sporttery|fivehundred)_/, "");
const team = (match, side) => text(match?.[side + "TeamName"] || match?.[side + "Team"]);
const identityKey = match => JSON.stringify([sourceId(match), instant(match?.eventVersion || match?.kickoffTime), instant(match?.kickoffTime)]);

// The SHA binds contents, not authority. Authority comes from inclusion in the
// fixed signed release; this file must never be loaded from an HTTP/env path.
function validateManifest(payload) {
  assert.equal(payload?.version, VERSION);
  assert.equal(payload?.source, SOURCE);
  const { integritySha256, ...body } = payload;
  assert.equal(digest(body), integritySha256, "restoration manifest integrity mismatch");
  const baseline = payload.baseline;
  assert.ok(Array.isArray(baseline?.records) && baseline.records.length > 0);
  assert.equal(baseline.rows, baseline.records.length);
  assert.equal(new Set(baseline.records.map(row => row.id)).size, baseline.rows);
  assert.equal(digest(baseline.records), baseline.archiveRootHash);
  assert.match(text(baseline.releaseMarker), /^[a-f0-9]{64}$/);
  assert.match(text(payload.backup?.historySha256), /^[a-f0-9]{64}$/);
  assert.match(text(payload.backup?.captureReceiptSha256), /^[a-f0-9]{64}$/);
  assert.equal(payload.backup?.stable, true);
  const baselineAt = instant(baseline.checkedAt), backupAt = instant(payload.backup.capturedAt);
  const lossAt = instant(payload.observedLoss?.checkedAt);
  assert.ok(Number.isFinite(baselineAt) && Number.isFinite(backupAt) && Number.isFinite(lossAt));
  assert.ok(baselineAt <= backupAt && backupAt < lossAt, "backup must predate observed loss");
  assert.equal(payload.observedLoss.releaseMarker, baseline.releaseMarker);
  assert.ok(Array.isArray(payload.rows) && payload.rows.length > 0);
  const expected = new Set(payload.observedLoss.sourceMatchIds);
  assert.equal(expected.size, payload.rows.length);
  const index = new Map();
  assert.equal(new Set(payload.rows.map(row => sourceId(row.identity))).size, expected.size);
  for (const row of payload.rows) {
    const id = sourceId(row.identity), key = identityKey(row.identity);
    assert.ok(id && expected.has(id));
    assert.ok(!index.has(key), "duplicate restoration event");
    assert.ok(team(row.identity, "home") && team(row.identity, "away"));
    assert.ok(Number.isFinite(instant(row.identity.kickoffTime)));
    assert.ok(Number.isFinite(instant(row.identity.eventVersion)));
    assert.equal(row.archiveSha256, digest(row.archive));
    assert.equal(sourceId(row.archive), id);
    assert.equal(identityKey(row.archive), key);
    assert.ok(baseline.records.some(record => record.id === row.identity.id
      && identityKey(record) === key && record.archiveSha256 === row.archiveSha256),
    "archive must match a complete original baseline entry");
    index.set(key, structuredClone({ ...row, manifestSha256: integritySha256, baselineRootHash: baseline.archiveRootHash, availableAfter: payload.observedLoss.checkedAt }));
  }
  return index;
}

function loadRestorations(file = DEFAULT_PATH) {
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024);
  return validateManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

function restoreMissingArchive(match, index, capturedAt, validateArchive) {
  if (!match || match.archivedPreMatchPrediction != null) return match;
  const row = index.get(identityKey(match));
  if (!row) return match;
  const now = instant(capturedAt);
  if (!Number.isFinite(now) || now < instant(row.availableAfter)) return match;
  if (team(match, "home") !== team(row.identity, "home")
    || team(match, "away") !== team(row.identity, "away")) return match;
  if (typeof validateArchive !== "function" || !validateArchive(match, row.archive)) return match;
  // No rewriting of odds, direction, capturedAt, model version or archive hash.
  // The restoration receipt is separate from the immutable original object.
  return { ...match, archivedPreMatchPrediction: structuredClone(row.archive),
    predictionMeta: { ...(match.predictionMeta || {}), frozenArchiveRestoration: {
      version: VERSION, source: SOURCE, restoredAt: capturedAt,
      originalArchiveSha256: row.archiveSha256, baselineRootHash: row.baselineRootHash,
      manifestSha256: row.manifestSha256,
      reason: "previously-published-archive-omitted-by-fresh-result-persistence",
    } } };
}
function retainedRestorationReceipt(match, existing, index, capturedAt) {
  const row = index.get(identityKey(match));
  const receipt = existing?.predictionMeta?.frozenArchiveRestoration;
  if (!row || !receipt || identityKey(existing) !== identityKey(match)) return null;
  for (const side of ["home", "away"]) {
    if (team(match, side) !== team(row.identity, side) || team(existing, side) !== team(row.identity, side)) return null;
  }
  if (!match.archivedPreMatchPrediction || digest(match.archivedPreMatchPrediction) !== row.archiveSha256) return null;
  if (receipt.version !== VERSION || receipt.source !== SOURCE
    || receipt.manifestSha256 !== row.manifestSha256
    || receipt.originalArchiveSha256 !== row.archiveSha256
    || receipt.baselineRootHash !== row.baselineRootHash) return null;
  const restoredAt = instant(receipt.restoredAt), now = instant(capturedAt);
  if (!Number.isFinite(restoredAt) || !Number.isFinite(now)
    || restoredAt < instant(row.availableAfter) || restoredAt > now) return null;
  return structuredClone(receipt);
}
module.exports = { VERSION, SOURCE, DEFAULT_PATH, digest, validateManifest, loadRestorations, restoreMissingArchive, retainedRestorationReceipt };
