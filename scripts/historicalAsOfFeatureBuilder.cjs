"use strict";

const crypto = require("node:crypto");

const HISTORICAL_ASOF_FEATURE_ARTIFACT_VERSION = "historical-asof-feature-artifact-v1";
const HISTORICAL_ASOF_FEATURE_SNAPSHOT_VERSION = "historical-asof-feature-snapshot-v1";
const HISTORICAL_ASOF_LABEL_VERSION = "historical-asof-label-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class HistoricalAsOfFeatureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HistoricalAsOfFeatureError";
    this.code = details.code || "HISTORICAL_ASOF_FEATURE_ERROR";
    Object.assign(this, details);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new HistoricalAsOfFeatureError("non-finite numbers cannot be committed", {
      code: "NON_FINITE_COMMITMENT",
    });
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function text(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || null;
}

function normalizeEntity(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalIso(value, field) {
  const millis = Date.parse(String(value || ""));
  if (!Number.isFinite(millis)) {
    throw new HistoricalAsOfFeatureError(`${field} must be a valid timestamp`, {
      code: "INVALID_TIMESTAMP",
      field,
    });
  }
  return new Date(millis).toISOString();
}

function canonicalDate(value, field = "date") {
  const normalized = text(value);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new HistoricalAsOfFeatureError(`${field} must be YYYY-MM-DD`, {
      code: "INVALID_DATE",
      field,
    });
  }
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== normalized) {
    throw new HistoricalAsOfFeatureError(`${field} is not a real calendar date`, {
      code: "INVALID_DATE",
      field,
    });
  }
  return normalized;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new HistoricalAsOfFeatureError(`${field} must be a non-negative integer`, {
      code: "INVALID_LABEL",
      field,
    });
  }
  return number;
}

function teamProjection(event, side) {
  const source = event?.[`${side}Team`];
  const raw = text(
    event?.[`${side}TeamName`]
      || event?.[`${side}TeamRaw`]
      || (source && typeof source === "object" ? source.raw || source.name : source),
  );
  const normalized = normalizeEntity(
    event?.[`${side}TeamNormalized`]
      || (source && typeof source === "object" ? source.normalized || source.name || source.raw : source)
      || raw,
  );
  const entityId = text(
    event?.[`${side}EntityId`]
      || (source && typeof source === "object" ? source.entityId || source.id : null),
  ) || normalized;
  if (!raw || !normalized || !entityId) {
    throw new HistoricalAsOfFeatureError(`${side} team identity is incomplete`, {
      code: "INVALID_TEAM_IDENTITY",
      side,
    });
  }
  return { entityId, normalized, raw };
}

function scoreProjection(event) {
  const outcome = event?.historicalOutcome || event?.score || {};
  const home = nonNegativeInteger(
    outcome.homeGoals ?? outcome.home ?? event?.scoreHome,
    "historicalOutcome.homeGoals",
  );
  const away = nonNegativeInteger(
    outcome.awayGoals ?? outcome.away ?? event?.scoreAway,
    "historicalOutcome.awayGoals",
  );
  return {
    home,
    away,
    outcome: home > away ? "1" : home < away ? "2" : "X",
  };
}

function normalizeHistoricalEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new HistoricalAsOfFeatureError("historical event must be an object", {
      code: "INVALID_EVENT",
    });
  }
  const sourceEventId = text(event.sourceEventId || event.id);
  if (!sourceEventId) {
    throw new HistoricalAsOfFeatureError("sourceEventId is required", {
      code: "INVALID_EVENT_ID",
    });
  }
  const date = canonicalDate(event.date || String(event.kickoff || "").slice(0, 10));
  const forecastBoundary = `${date}T00:00:00.000Z`;
  const forecastMs = Date.parse(forecastBoundary);
  const availableAt = canonicalIso(
    event.availableAt || event.resultAvailableAt || event?.availability?.availableAt,
    "availableAt",
  );
  const availableMs = Date.parse(availableAt);
  if (availableMs <= forecastMs) {
    throw new HistoricalAsOfFeatureError(
      "a result label must become available strictly after its date-batch forecast boundary",
      {
        code: "UNSAFE_RESULT_AVAILABILITY",
        sourceEventId,
        forecastBoundary,
        availableAt,
      },
    );
  }
  const homeTeam = teamProjection(event, "home");
  const awayTeam = teamProjection(event, "away");
  if (homeTeam.entityId === awayTeam.entityId) {
    throw new HistoricalAsOfFeatureError("home and away entity ids must differ", {
      code: "INVALID_TEAM_IDENTITY",
      sourceEventId,
    });
  }
  const score = scoreProjection(event);
  const match = {
    sourceEventId,
    sourceDataset: text(event.sourceDataset) || "unknown",
    competition: text(event.competition) || "unknown",
    date,
    neutral: event.neutral === true,
    homeTeam,
    awayTeam,
  };
  const labelBody = {
    version: HISTORICAL_ASOF_LABEL_VERSION,
    sourceEventId,
    date,
    availableAt,
    score: { home: score.home, away: score.away },
    outcome: score.outcome,
  };
  const label = { ...labelBody, labelHash: stableHash(labelBody) };
  const eventCommitmentHash = stableHash({ match, label: labelBody });
  return {
    availableAt,
    availableMs,
    eventCommitmentHash,
    forecastBoundary,
    forecastMs,
    label,
    match,
    sourceEventId,
  };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    throw new HistoricalAsOfFeatureError("events must be an array", {
      code: "INVALID_EVENT_COLLECTION",
    });
  }
  const normalized = events.map(normalizeHistoricalEvent);
  const byId = new Map();
  for (const event of normalized) {
    const previous = byId.get(event.sourceEventId);
    if (previous) {
      throw new HistoricalAsOfFeatureError("duplicate sourceEventId is not allowed", {
        code: previous.eventCommitmentHash === event.eventCommitmentHash
          ? "DUPLICATE_EVENT_ID"
          : "CONFLICTING_EVENT_ID",
        sourceEventId: event.sourceEventId,
      });
    }
    byId.set(event.sourceEventId, event);
  }
  return normalized.sort((left, right) => (
    left.match.date.localeCompare(right.match.date)
      || left.sourceEventId.localeCompare(right.sourceEventId)
  ));
}

function bodyWithoutHash(value, hashKey) {
  const body = { ...value };
  delete body[hashKey];
  return body;
}

function groupEventsByDate(events) {
  const groups = [];
  for (const event of events) {
    const previous = groups[groups.length - 1];
    if (previous?.date === event.match.date) previous.events.push(event);
    else groups.push({ date: event.match.date, events: [event] });
  }
  return groups.map((group) => {
    const batchAvailableMs = Math.max(...group.events.map((event) => event.availableMs));
    const batchCommitmentHash = stableHash(group.events
      .map((event) => `${event.sourceEventId}:${event.eventCommitmentHash}`)
      .sort());
    return {
      ...group,
      batchAvailableAt: new Date(batchAvailableMs).toISOString(),
      batchAvailableMs,
      batchCommitmentHash,
    };
  });
}

function assertAdapter(adapter) {
  for (const method of ["createState", "captureFeature", "applyResultBatch", "serializeState"]) {
    if (typeof adapter?.[method] !== "function") {
      throw new HistoricalAsOfFeatureError(`adapter.${method} is required`, {
        code: "INVALID_ADAPTER",
      });
    }
  }
  return {
    version: text(adapter.version) || "anonymous-date-batch-adapter-v1",
    configHash: text(adapter.configHash) || stableHash({ version: adapter.version || "anonymous" }),
  };
}

function buildHistoricalAsOfFeatureArtifact(events, adapter) {
  const adapterIdentity = assertAdapter(adapter);
  const normalized = normalizeEvents(events);
  if (!normalized.length) {
    throw new HistoricalAsOfFeatureError("at least one historical event is required", {
      code: "EMPTY_EVENT_COLLECTION",
    });
  }

  const forecastGroups = groupEventsByDate(normalized);
  const resultBatches = forecastGroups.slice().sort((left, right) => (
    left.batchAvailableMs - right.batchAvailableMs
      || left.date.localeCompare(right.date)
      || left.batchCommitmentHash.localeCompare(right.batchCommitmentHash)
  ));
  const state = adapter.createState();
  const snapshots = [];
  const labels = [];
  let resultCursor = 0;
  let consumedRows = 0;
  let consumedBatches = 0;
  let consumedRootHash = null;
  let maxConsumedAvailableAt = null;
  let maxConsumedMatchDate = null;

  const applyBatch = (batch) => {
    const rows = batch.events.map((event) => ({
      availableAt: event.availableAt,
      eventCommitmentHash: event.eventCommitmentHash,
      label: event.label,
      match: event.match,
    }));
    adapter.applyResultBatch(state, rows, {
      batchAvailableAt: batch.batchAvailableAt,
      batchCommitmentHash: batch.batchCommitmentHash,
      batchDate: batch.date,
    });
    consumedRows += rows.length;
    consumedBatches += 1;
    consumedRootHash = stableHash({
      batchCommitmentHash: batch.batchCommitmentHash,
      previousRootHash: consumedRootHash,
    });
    maxConsumedAvailableAt = batch.batchAvailableAt;
    maxConsumedMatchDate = !maxConsumedMatchDate || batch.date > maxConsumedMatchDate
      ? batch.date
      : maxConsumedMatchDate;
  };

  for (const group of forecastGroups) {
    const forecastBoundary = `${group.date}T00:00:00.000Z`;
    const forecastMs = Date.parse(forecastBoundary);
    while (resultCursor < resultBatches.length
        && resultBatches[resultCursor].batchAvailableMs < forecastMs) {
      const batch = resultBatches[resultCursor];
      if (batch.date >= group.date) {
        throw new HistoricalAsOfFeatureError("same-day or future labels reached the feature state", {
          code: "DATE_BATCH_LEAKAGE",
          batchDate: batch.date,
          forecastDate: group.date,
        });
      }
      applyBatch(batch);
      resultCursor += 1;
    }

    const stateWatermark = {
      consumedBatches,
      consumedRootHash,
      consumedRows,
      maxConsumedAvailableAt,
      maxConsumedMatchDate,
      strictBeforeForecast: maxConsumedAvailableAt === null
        || Date.parse(maxConsumedAvailableAt) < forecastMs,
    };
    for (const event of group.events) {
      const captured = adapter.captureFeature(state, event.match, {
        forecastBoundary,
        forecastDate: group.date,
        stateWatermark: { ...stateWatermark },
      });
      if (!captured || typeof captured !== "object" || Array.isArray(captured)) {
        throw new HistoricalAsOfFeatureError("adapter.captureFeature must return an object", {
          code: "INVALID_CAPTURED_FEATURE",
          sourceEventId: event.sourceEventId,
        });
      }
      const snapshotBody = {
        version: HISTORICAL_ASOF_FEATURE_SNAPSHOT_VERSION,
        sourceEventId: event.sourceEventId,
        forecastDate: group.date,
        forecastBoundary,
        match: event.match,
        stateWatermark: { ...stateWatermark },
        model: captured.model || null,
        features: captured.features || {},
        probabilities: captured.probabilities || null,
      };
      snapshots.push({ ...snapshotBody, featureHash: stableHash(snapshotBody) });
      labels.push({
        ...event.label,
        eventCommitmentHash: event.eventCommitmentHash,
      });
    }
  }

  while (resultCursor < resultBatches.length) {
    applyBatch(resultBatches[resultCursor]);
    resultCursor += 1;
  }

  const finalState = adapter.serializeState(state);
  const inputCommitments = normalized
    .map((event) => `${event.sourceEventId}:${event.eventCommitmentHash}`)
    .sort();
  const inputRootHash = stableHash(inputCommitments);
  const featureRootHash = stableHash(snapshots.map((row) => `${row.sourceEventId}:${row.featureHash}`));
  const labelRootHash = stableHash(labels.map((row) => `${row.sourceEventId}:${row.labelHash}`));
  const artifactBody = {
    version: HISTORICAL_ASOF_FEATURE_ARTIFACT_VERSION,
    shadowOnly: true,
    productionEligible: false,
    policy: {
      forecastBoundary: "UTC calendar-day start",
      resultBoundary: "consume a complete source-date batch only when max(availableAt) < forecastBoundary",
      sameDayPolicy: "capture every match on a date before applying any result from that date",
      labelIsolation: "feature snapshots and result labels are committed separately",
    },
    adapter: adapterIdentity,
    input: {
      rows: normalized.length,
      dateBatches: forecastGroups.length,
      firstDate: normalized[0].match.date,
      lastDate: normalized[normalized.length - 1].match.date,
      rootHash: inputRootHash,
    },
    snapshots,
    labels,
    finalState,
    watermark: {
      consumedRows,
      consumedBatches,
      consumedRootHash,
      maxConsumedAvailableAt,
      maxConsumedMatchDate,
      featureRootHash,
      labelRootHash,
    },
  };
  return { ...artifactBody, artifactHash: stableHash(artifactBody) };
}

function verifyHistoricalAsOfFeatureArtifact(artifact) {
  try {
    if (!artifact || artifact.version !== HISTORICAL_ASOF_FEATURE_ARTIFACT_VERSION) return false;
    if (artifact.shadowOnly !== true || artifact.productionEligible !== false) return false;
    if (!HASH_PATTERN.test(String(artifact.artifactHash || ""))) return false;
    if (stableHash(bodyWithoutHash(artifact, "artifactHash")) !== artifact.artifactHash) return false;
    const snapshots = Array.isArray(artifact.snapshots) ? artifact.snapshots : [];
    const labels = Array.isArray(artifact.labels) ? artifact.labels : [];
    if (!snapshots.length || snapshots.length !== labels.length || artifact.input?.rows !== snapshots.length) return false;

    const snapshotIds = new Set();
    const snapshotById = new Map();
    const dateWatermarks = new Map();
    for (const snapshot of snapshots) {
      if (snapshot.version !== HISTORICAL_ASOF_FEATURE_SNAPSHOT_VERSION) return false;
      if (!snapshot.sourceEventId || snapshotIds.has(snapshot.sourceEventId)) return false;
      snapshotIds.add(snapshot.sourceEventId);
      snapshotById.set(snapshot.sourceEventId, snapshot);
      if (snapshot.match?.sourceEventId !== snapshot.sourceEventId
          || snapshot.match?.date !== snapshot.forecastDate
          || snapshot.forecastBoundary !== `${snapshot.forecastDate}T00:00:00.000Z`) return false;
      if (stableHash(bodyWithoutHash(snapshot, "featureHash")) !== snapshot.featureHash) return false;
      const forecastMs = Date.parse(snapshot.forecastBoundary || "");
      const maxConsumedMs = snapshot.stateWatermark?.maxConsumedAvailableAt === null
        ? null
        : Date.parse(snapshot.stateWatermark?.maxConsumedAvailableAt || "");
      if (!Number.isFinite(forecastMs)) return false;
      if (maxConsumedMs !== null && (!Number.isFinite(maxConsumedMs) || maxConsumedMs >= forecastMs)) return false;
      if (snapshot.stateWatermark?.strictBeforeForecast !== true) return false;
      if (snapshot.stateWatermark?.maxConsumedMatchDate
          && snapshot.stateWatermark.maxConsumedMatchDate >= snapshot.forecastDate) return false;
      const dateCommitment = stableHash(snapshot.stateWatermark);
      const priorCommitment = dateWatermarks.get(snapshot.forecastDate);
      if (priorCommitment && priorCommitment !== dateCommitment) return false;
      dateWatermarks.set(snapshot.forecastDate, dateCommitment);
    }

    const labelIds = new Set();
    for (const label of labels) {
      if (label.version !== HISTORICAL_ASOF_LABEL_VERSION) return false;
      if (!label.sourceEventId || labelIds.has(label.sourceEventId) || !snapshotIds.has(label.sourceEventId)) return false;
      labelIds.add(label.sourceEventId);
      if (label.date !== snapshotById.get(label.sourceEventId)?.forecastDate) return false;
      if (!HASH_PATTERN.test(String(label.eventCommitmentHash || ""))) return false;
      const labelBody = bodyWithoutHash(bodyWithoutHash(label, "eventCommitmentHash"), "labelHash");
      if (stableHash(labelBody) !== label.labelHash) return false;
      if (stableHash({ match: snapshotById.get(label.sourceEventId)?.match, label: labelBody })
          !== label.eventCommitmentHash) return false;
      if (Date.parse(label.availableAt || "") <= Date.parse(`${label.date}T00:00:00.000Z`)) return false;
    }
    const inputRootHash = stableHash(labels
      .map((row) => `${row.sourceEventId}:${row.eventCommitmentHash}`)
      .sort());
    if (inputRootHash !== artifact.input.rootHash) return false;
    if (artifact.watermark?.consumedRows !== labels.length
        || artifact.watermark?.consumedBatches !== artifact.input?.dateBatches
        || !HASH_PATTERN.test(String(artifact.watermark?.consumedRootHash || ""))) return false;
    if (stableHash(snapshots.map((row) => `${row.sourceEventId}:${row.featureHash}`))
        !== artifact.watermark?.featureRootHash) return false;
    if (stableHash(labels.map((row) => `${row.sourceEventId}:${row.labelHash}`))
        !== artifact.watermark?.labelRootHash) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  HASH_PATTERN,
  HISTORICAL_ASOF_FEATURE_ARTIFACT_VERSION,
  HISTORICAL_ASOF_FEATURE_SNAPSHOT_VERSION,
  HISTORICAL_ASOF_LABEL_VERSION,
  HistoricalAsOfFeatureError,
  buildHistoricalAsOfFeatureArtifact,
  normalizeHistoricalEvent,
  stableHash,
  stableStringify,
  verifyHistoricalAsOfFeatureArtifact,
};
