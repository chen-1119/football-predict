const MINUTE_MS = 60 * 1000;

const AVAILABILITY = Object.freeze({
  VERIFIED_PRE_CUTOFF: "verified_pre_cutoff",
  ESTIMATED_PRE_CUTOFF: "estimated_pre_cutoff",
  NOT_YET_PUBLISHABLE: "not_yet_publishable",
  PUBLISHED_AFTER_CUTOFF: "published_after_cutoff",
  MISSING_OVERDUE: "missing_overdue",
  STALE_OR_UNVERIFIED: "stale_or_unverified",
});

const normalizeShanghaiTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    return `${text.replace(/\s+/, "T")}${text.length === 16 ? ":00" : ""}+08:00`;
  }
  return text;
};

const instantMs = (value) => {
  const parsed = Date.parse(normalizeShanghaiTime(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const isoOrNull = (value) => {
  const parsed = instantMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const cutoffForMatch = (match) => (
  match?.buyEndTime
  || match?.predictionMeta?.cutoffTime
  || match?.externalSignals?.buyEndTime
  || match?.kickoffTime
  || null
);

const observedAtForEvidence = (evidence, fallbackObservedAt = null) => (
  evidence?.sourcePublishedAt
  || evidence?.sourceObservedAt
  || evidence?.observedAt
  || evidence?.receivedAt
  || evidence?.updatedAt
  || fallbackObservedAt
  || null
);

const availabilityStatus = (availabilityState, { verified = false, partial = false } = {}) => {
  if (availabilityState === AVAILABILITY.VERIFIED_PRE_CUTOFF) return verified ? "verified" : partial ? "partial" : "estimated";
  if (availabilityState === AVAILABILITY.ESTIMATED_PRE_CUTOFF) return partial ? "partial" : "estimated";
  if (availabilityState === AVAILABILITY.NOT_YET_PUBLISHABLE) return "not_yet_publishable";
  if (availabilityState === AVAILABILITY.PUBLISHED_AFTER_CUTOFF) return "published_after_cutoff";
  if (availabilityState === AVAILABILITY.STALE_OR_UNVERIFIED) return "stale_or_unverified";
  return "missing";
};

const classifyEvidenceAvailability = ({
  match,
  evidence,
  available,
  verified = false,
  releaseLeadMinutes = null,
  fallbackObservedAt = null,
}) => {
  const cutoffMs = instantMs(cutoffForMatch(match));
  const kickoffMs = instantMs(match?.kickoffTime);
  const observedAt = observedAtForEvidence(evidence, fallbackObservedAt);
  const observedMs = instantMs(observedAt);
  const expectedPublishedMs = Number.isFinite(Number(releaseLeadMinutes)) && kickoffMs !== null
    ? kickoffMs - Number(releaseLeadMinutes) * MINUTE_MS
    : null;
  const explicitPreMatchIneligible = evidence?.usableForPreMatch === false
    || evidence?.eligibleAtCutoff === false
    || evidence?.observationPhase === "post-cutoff";

  let availabilityState;
  if (available) {
    if (explicitPreMatchIneligible || (cutoffMs !== null && observedMs !== null && observedMs > cutoffMs)) {
      availabilityState = AVAILABILITY.PUBLISHED_AFTER_CUTOFF;
    } else if (observedMs === null && evidence?.usableForPreMatch !== true && !fallbackObservedAt) {
      availabilityState = AVAILABILITY.STALE_OR_UNVERIFIED;
    } else {
      availabilityState = verified
        ? AVAILABILITY.VERIFIED_PRE_CUTOFF
        : AVAILABILITY.ESTIMATED_PRE_CUTOFF;
    }
  } else if (expectedPublishedMs !== null && cutoffMs !== null && cutoffMs < expectedPublishedMs) {
    availabilityState = AVAILABILITY.NOT_YET_PUBLISHABLE;
  } else {
    availabilityState = AVAILABILITY.MISSING_OVERDUE;
  }

  return {
    availabilityState,
    eligibleAtCutoff: availabilityState === AVAILABILITY.VERIFIED_PRE_CUTOFF
      || availabilityState === AVAILABILITY.ESTIMATED_PRE_CUTOFF,
    cutoffTime: isoOrNull(cutoffForMatch(match)),
    kickoffTime: isoOrNull(match?.kickoffTime),
    sourceObservedAt: isoOrNull(observedAt),
    expectedPublishedAt: expectedPublishedMs === null ? null : new Date(expectedPublishedMs).toISOString(),
  };
};

const dynamicEvidenceWeights = (components = {}) => {
  const lineupState = components.lineup?.availabilityState;
  const refereeState = components.referee?.availabilityState;
  const injuryState = components.injuries?.availabilityState;
  const lineupWeight = lineupState === AVAILABILITY.VERIFIED_PRE_CUTOFF
    ? 8
    : lineupState === AVAILABILITY.ESTIMATED_PRE_CUTOFF
      ? 2
      : lineupState === AVAILABILITY.NOT_YET_PUBLISHABLE
        ? 0
        : 8;
  return {
    referee: refereeState === AVAILABILITY.NOT_YET_PUBLISHABLE ? 0 : 4,
    teamCards: 4,
    lineup: lineupWeight,
    injuries: injuryState === AVAILABILITY.NOT_YET_PUBLISHABLE ? 0 : 10,
    xg: 12,
    weather: 2,
    market: 18,
    motivation: 8,
    strength: 18,
    form: 16,
  };
};

module.exports = {
  AVAILABILITY,
  availabilityStatus,
  classifyEvidenceAvailability,
  cutoffForMatch,
  dynamicEvidenceWeights,
  instantMs,
  isoOrNull,
};
