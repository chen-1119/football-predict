"use strict";

const ODDS_OBSERVATION_VERSION = "official-odds-observation-v1";
const ODDS_OBSERVATION_TRAIL_VERSION = "official-odds-observation-trail-v1";
const DEFAULT_MAX_OBSERVATIONS = Math.max(
  8,
  Number(process.env.ODDS_OBSERVATION_TRAIL_MAX || 128),
);

const text = (value) => String(value ?? "").trim();

const timeMs = (value) => {
  const raw = text(value);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)
    ? `${raw.replace(" ", "T")}+08:00`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value) => {
  const parsed = timeMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const officialSportteryUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === "webapi.sporttery.cn";
  } catch {
    return false;
  }
};

const marketProvenanceFor = (row) => (
  row?.marketProvenance
  || row?.oddsMarketProvenance
  || null
);

const officialSportteryContext = (row, observation = null) => {
  const provenance = marketProvenanceFor(row);
  const sourceUrl = observation?.sourceUrl
    || row?.oddsSourceUrl
    || row?.sourceUrl
    || provenance?.endpoint?.url
    || null;
  const source = text(
    observation?.source
    || row?.oddsSource
    || row?.origin
    || `${provenance?.provider?.id || ""}:${row?.poolCode || row?.pool || ""}`,
  ).toLowerCase();
  return officialSportteryUrl(sourceUrl)
    && (
      source.includes("sporttery")
      || provenance?.provider?.id === "sporttery"
      || provenance?.provider?.official === true
    );
};

const effectiveDeadlineMs = (row) => {
  const candidates = [
    row?.cutoffTime,
    row?.buyEndTime,
    row?.kickoffTime,
  ].map(timeMs).filter((value) => value !== null);
  return candidates.length ? Math.min(...candidates) : null;
};

const observationRichness = (observation) => [
  observation?.sourceCycleId,
  observation?.providerObservedAt,
  observation?.provenanceHash,
  observation?.sourceMethod,
].filter(Boolean).length;

const normalizeOddsObservation = (observation, row = {}) => {
  if (!observation || typeof observation !== "object") return null;
  const receivedAt = iso(observation.receivedAt || observation.availableAt);
  if (!receivedAt || !officialSportteryContext(row, observation)) return null;

  const receivedMs = timeMs(receivedAt);
  const deadlineMs = effectiveDeadlineMs(row);
  if (deadlineMs !== null && receivedMs > deadlineMs) return null;

  const providerObservedAt = iso(observation.providerObservedAt);
  if (providerObservedAt && timeMs(providerObservedAt) > receivedMs) return null;

  return {
    version: ODDS_OBSERVATION_VERSION,
    availableAt: receivedAt,
    receivedAt,
    providerObservedAt,
    sourceCycleId: text(observation.sourceCycleId) || null,
    provenanceHash: text(observation.provenanceHash) || null,
    sourceMethod: text(observation.sourceMethod || row?.oddsSourceMethod || row?.sourceMethod) || null,
  };
};

const directObservationCandidates = (row = {}) => {
  const provenance = marketProvenanceFor(row);
  const sourceUrl = row?.oddsSourceUrl
    || row?.sourceUrl
    || provenance?.endpoint?.url
    || null;
  const common = {
    sourceUrl,
    source: row?.oddsSource || row?.origin || null,
    providerObservedAt: row?.oddsObservedAt
      || provenance?.timing?.providerObservedAt
      || null,
    provenanceHash: provenance?.hash || null,
    sourceMethod: row?.oddsSourceMethod || row?.sourceMethod || null,
  };
  const candidates = [];
  const initialReceivedAt = row?.oddsReceivedAt
    || provenance?.timing?.receivedAt
    || null;
  if (initialReceivedAt) {
    candidates.push({
      ...common,
      receivedAt: initialReceivedAt,
      sourceCycleId: row?.sourceCycleId
        || provenance?.cycles?.collectorSourceCycleId
        || null,
    });
  }
  if (row?.lastOddsReceivedAt) {
    candidates.push({
      ...common,
      receivedAt: row.lastOddsReceivedAt,
      sourceCycleId: row?.lastSourceCycleId
        || row?.sourceCycleId
        || provenance?.cycles?.collectorSourceCycleId
        || null,
    });
  }
  return candidates;
};

const compactOddsObservations = (observations, maxRows = DEFAULT_MAX_OBSERVATIONS) => {
  const byAvailableAt = new Map();
  for (const observation of observations || []) {
    if (!observation?.availableAt) continue;
    const existing = byAvailableAt.get(observation.availableAt);
    if (!existing || observationRichness(observation) > observationRichness(existing)) {
      byAvailableAt.set(observation.availableAt, observation);
    }
  }
  const ordered = Array.from(byAvailableAt.values())
    .sort((left, right) => timeMs(left.availableAt) - timeMs(right.availableAt));
  const limit = Math.max(2, Number(maxRows || DEFAULT_MAX_OBSERVATIONS));
  if (ordered.length <= limit) return ordered;

  const indexes = new Set([0, ordered.length - 1]);
  for (let slot = 1; slot < limit - 1; slot += 1) {
    indexes.add(Math.round((slot * (ordered.length - 1)) / (limit - 1)));
  }
  return Array.from(indexes)
    .sort((left, right) => left - right)
    .map((index) => ordered[index]);
};

const oddsObservationTrailForRow = (row = {}, options = {}) => {
  const candidates = [
    ...(Array.isArray(row?.observationTrail) ? row.observationTrail : []),
    ...directObservationCandidates(row),
  ];
  const normalized = candidates
    .map((observation) => normalizeOddsObservation(observation, row))
    .filter(Boolean);
  return compactOddsObservations(normalized, options.maxRows);
};

const withOddsObservationTrail = (row = {}, sources = [], options = {}) => {
  const sourceRows = Array.isArray(sources) ? sources : [sources];
  const candidates = [
    ...oddsObservationTrailForRow(row, options),
    ...sourceRows.flatMap((source) => (
      Array.isArray(source)
        ? source
          .map((observation) => normalizeOddsObservation(observation, row))
          .filter(Boolean)
        : oddsObservationTrailForRow(source, options)
    )),
  ];
  const observationTrail = compactOddsObservations(candidates, options.maxRows);
  return {
    ...row,
    observationTrailVersion: ODDS_OBSERVATION_TRAIL_VERSION,
    observationTrail,
    observationCount: observationTrail.length,
    firstObservationAt: observationTrail[0]?.availableAt || null,
    lastObservationAt: observationTrail.at(-1)?.availableAt || null,
  };
};

module.exports = {
  DEFAULT_MAX_OBSERVATIONS,
  ODDS_OBSERVATION_TRAIL_VERSION,
  ODDS_OBSERVATION_VERSION,
  compactOddsObservations,
  normalizeOddsObservation,
  oddsObservationTrailForRow,
  withOddsObservationTrail,
};
