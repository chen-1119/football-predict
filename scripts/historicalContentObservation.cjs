"use strict";
const { createHash } = require("node:crypto");
const VERSION = "historical-row-content-observation-v1";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const canonicalInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const rowIdentity = row => Object.fromEntries(["source", "division", "kickoffTime", "homeKey", "awayKey", "scoreHome", "scoreAway", "side"]
  .map(key => [key, row[key] ?? null]));

// This records local receipt of exact file bytes, not upstream publication,
// official result availability, independent attestation or model eligibility.
function bindHistoricalContentObservation(row, event, observation) {
  if (!observation || observation.version !== "football-data-content-observation-v1"
    || observation.scope !== "local-fetch-only" || observation.sourceVerified !== false
    || !isHash(observation.sha256) || !canonicalInstant(observation.firstObservedAt)
    || typeof observation.sourceUrl !== "string" || !/^https:\/\/www\.football-data\.co\.uk\/(?:mmz4281\/\d{4}\/[A-Z0-9]+|new\/[A-Z0-9]+)\.csv$/.test(observation.sourceUrl)
    || !isHash(event?.sourceEventId) || !isHash(event?.eventSha256) || !isHash(event?.rawRowSha256)) return null;
  const body = { version: VERSION, scope: "local-content-receipt-only", sourceVerified: false,
    sourceUrl: observation.sourceUrl, sourceFileSha256: observation.sha256,
    firstObservedAt: observation.firstObservedAt, sourceEventId: event.sourceEventId,
    eventSha256: event.eventSha256, rawRowSha256: event.rawRowSha256, rowHash: hash(rowIdentity(row)) };
  return { ...body, contentHash: hash(body) };
}

function verifyHistoricalContentObservation(row) {
  const value = row?.sourceObservation;
  if (!value || value.version !== VERSION || value.scope !== "local-content-receipt-only" || value.sourceVerified !== false
    || !canonicalInstant(value.firstObservedAt)
    || typeof value.sourceUrl !== "string" || !/^https:\/\/www\.football-data\.co\.uk\/(?:mmz4281\/\d{4}\/[A-Z0-9]+|new\/[A-Z0-9]+)\.csv$/.test(value.sourceUrl)
    || ["sourceFileSha256", "sourceEventId", "eventSha256", "rawRowSha256", "rowHash", "contentHash"].some(key => !isHash(value[key]))) return false;
  const { contentHash, ...body } = value;
  return contentHash === hash(body) && value.rowHash === hash(rowIdentity(row));
}

module.exports = { VERSION, bindHistoricalContentObservation, verifyHistoricalContentObservation };
