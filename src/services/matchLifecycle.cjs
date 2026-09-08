"use strict";

const crypto = require("node:crypto");
const { strictInstant } = require("./strictInstant.cjs");

const MATCH_STATUS_PRIORITY = Object.freeze({
  UNKNOWN: 0,
  SCHEDULED: 10,
  LIVE: 20,
  PENDING_RESULT: 30,
  FINISHED: 40,
});

const PENDING_RESULT_AFTER_MINUTES = 130;

const PRE_MATCH_FIELDS = Object.freeze([
  "odds",
  "oddsTrend",
  "oddsSource",
  "oddsPoolCode",
  "oddsSourceMethod",
  "oddsObservedAt",
  "oddsReceivedAt",
  "oddsUpdatedAt",
  "oddsSourceUrl",
  "oddsMarketProvenance",
  "handicapOdds",
  "handicapLine",
  "handicapOddsSource",
  "handicapOddsPoolCode",
  "handicapOddsSourceMethod",
  "handicapOddsObservedAt",
  "handicapOddsReceivedAt",
  "handicapOddsUpdatedAt",
  "handicapOddsSourceUrl",
  "handicapOddsMarketProvenance",
  "predictions",
  "predictionMeta",
  "gptPrediction",
  "probabilityModel",
  // Preserve the immutable cutoff snapshot across out-of-order current,
  // unresolved-archive, and history responses.
  "archivedPreMatchPrediction",
]);

const ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS = Object.freeze([
  "odds",
  "predictions",
  "predictionMeta",
  "probabilityModel",
]);

const RESULT_FIELDS = Object.freeze([
  "resultSource",
  "resultUpdatedAt",
  "resultObservedAt",
  "resultObservationSource",
  "resultObservationFallback",
  "resultSourceUpdatedAt",
  "eventVersion",
  "sourceCycleId",
  "datasetRevision",
  "postMatchReview",
]);

const VOID_FIELDS = Object.freeze([
  "resultDisposition",
  "voidReason",
  "voidSource",
  "voidObservedAt",
  "voidSourceUrl",
  "voidSourceMethod",
]);

const asText = (value) => String(value ?? "").trim();

const canonicalMatchStatus = (value) => {
  const status = asText(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(MATCH_STATUS_PRIORITY, status)
    ? status
    : "UNKNOWN";
};

const canonicalInstant = (value) => {
  const text = strictInstant(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const canonicalText = (value) => asText(value)
  .toLowerCase()
  .replace(/\s+/g, " ");

// Published match ids carry a presentation/source prefix, while upstream
// sourceMatchId values do not. Older 500.com fallback rows can lack the
// explicit sourceMatchId, so both forms must resolve to the same event key.
// Keep this list narrow: stripping an arbitrary prefix could collapse two
// unrelated provider identities.
const canonicalSourceMatchId = (value) => canonicalText(value)
  .replace(/^(?:sporttery|fivehundred)[_:-]/, "");

const canonicalVersion = (value) => {
  const text = asText(value);
  if (!text) return null;
  return canonicalInstant(text) || canonicalText(text);
};

const eventVersionOf = (match) => canonicalVersion(match?.eventVersion)
  || canonicalInstant(match?.kickoffTime ?? match?.kickoff);

const sourceMatchKey = (match) => {
  const explicit = canonicalSourceMatchId(match?.sourceMatchId);
  if (explicit) return explicit;
  return canonicalSourceMatchId(match?.matchId ?? match?.id);
};

const teamKey = (match, side) => canonicalText(
  match?.[`${side}TeamId`]
  ?? match?.[`${side}Id`]
  ?? match?.[`${side}TeamCode`]
  ?? match?.[`${side}TeamName`]
  ?? match?.[`${side}Team`]
);

/**
 * Matches a result to one exact fixture revision. A shared source match id is
 * necessary when present, while both kickoff and an explicit eventVersion are
 * treated as independent anti-reschedule guards.
 */
const sameEvent = (left, right) => {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftKey = sourceMatchKey(left);
  const rightKey = sourceMatchKey(right);
  if (leftKey && rightKey && leftKey !== rightKey) return false;

  const leftExplicitVersion = canonicalVersion(left.eventVersion);
  const rightExplicitVersion = canonicalVersion(right.eventVersion);
  if (leftExplicitVersion && rightExplicitVersion && leftExplicitVersion !== rightExplicitVersion) return false;

  const leftKickoff = canonicalInstant(left.kickoffTime ?? left.kickoff);
  const rightKickoff = canonicalInstant(right.kickoffTime ?? right.kickoff);
  if (leftKickoff && rightKickoff && leftKickoff !== rightKickoff) return false;

  const leftAnchor = leftExplicitVersion || leftKickoff;
  const rightAnchor = rightExplicitVersion || rightKickoff;
  if (Boolean(leftAnchor) !== Boolean(rightAnchor)) return false;
  if (leftAnchor && rightAnchor && leftAnchor !== rightAnchor) return false;

  const leftHome = teamKey(left, "home");
  const rightHome = teamKey(right, "home");
  const leftAway = teamKey(left, "away");
  const rightAway = teamKey(right, "away");
  if (leftHome && rightHome && leftHome !== rightHome) return false;
  if (leftAway && rightAway && leftAway !== rightAway) return false;

  const sharedIdentity = Boolean(leftKey && rightKey)
    || Boolean(leftHome && rightHome && leftAway && rightAway);
  return sharedIdentity && (!leftAnchor || Boolean(rightAnchor));
};

const isValidFinalScore = (match) => {
  const home = match?.scoreHome;
  const away = match?.scoreAway;
  return typeof home === "number"
    && typeof away === "number"
    && Number.isFinite(home)
    && Number.isFinite(away)
    && Number.isInteger(home)
    && Number.isInteger(away)
    && home >= 0
    && away >= 0;
};

const isOfficialSportteryUrl = (value) => {
  try {
    const url = new URL(asText(value));
    return url.protocol === "https:" && url.hostname.toLowerCase() === "webapi.sporttery.cn";
  } catch {
    return false;
  }
};

const isTrustedSportteryProvenance = (value) => {
  if (!value || typeof value !== "object") return false;
  const provider = asText(value.provider ?? value.source).toLowerCase();
  return provider === "sporttery" && value.official === true && value.trusted === true;
};

const uefaEvidenceHash = (match, provenance) => crypto
  .createHash("sha256")
  .update(JSON.stringify({
    provider: "uefa",
    providerMatchId: asText(provenance?.providerMatchId),
    sourceMatchId: canonicalSourceMatchId(provenance?.sourceMatchId),
    eventVersion: provenance?.eventVersion || match?.kickoffTime || null,
    providerKickoff: provenance?.providerKickoffTime || null,
    scoreHome: Number(match?.scoreHome),
    scoreAway: Number(match?.scoreAway),
    scoreKind: "regular-time",
    responseSha256: provenance?.responseSha256 || null,
  }))
  .digest("hex");

const isTrustedUefaOfficialFinal = (match) => {
  const provenance = match?.resultProvenance;
  const matchId = canonicalSourceMatchId(match?.sourceMatchId ?? match?.id);
  const provenanceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const eventVersion = eventVersionOf(match);
  const provenanceVersion = canonicalVersion(provenance?.eventVersion);
  const providerKickoff = canonicalInstant(provenance?.providerKickoffTime);
  const observedAt = canonicalInstant(provenance?.observedAt ?? match?.resultObservedAt);
  return Boolean(
    match
    && canonicalMatchStatus(match?.status ?? match?.effectiveStatus) === "FINISHED"
    && isValidFinalScore(match)
    && provenance?.provider === "uefa"
    && provenance?.source === "uefa:official-match-api"
    && provenance?.sourceKind === "official-competition-organizer"
    && provenance?.scoreKind === "regular-time"
    && provenance?.official === true
    && provenance?.trusted === true
    && provenance?.resultObservationFallback === false
    && matchId
    && provenanceId === matchId
    && eventVersion
    && provenanceVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion)
    && /^[a-f0-9]{64}$/.test(asText(provenance?.responseSha256))
    && /^[a-f0-9]{64}$/.test(asText(provenance?.evidenceHash))
    && provenance.evidenceHash === uefaEvidenceHash(match, provenance)
  );
};

const isOfficialClubResultUrl = (value) => {
  try {
    const url = new URL(asText(value));
    return url.protocol === "https:"
      && ["www.aikfotboll.se", "www.rbk.no"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const officialClubEvidenceHash = (match, provenance) => crypto
  .createHash("sha256")
  .update(JSON.stringify({
    provider: "official-club",
    providerMatchId: asText(provenance?.providerMatchId),
    sourceMatchId: canonicalSourceMatchId(provenance?.sourceMatchId),
    eventVersion: provenance?.eventVersion || match?.kickoffTime || null,
    providerKickoff: provenance?.providerKickoffTime || null,
    scoreHome: Number(match?.scoreHome),
    scoreAway: Number(match?.scoreAway),
    scoreKind: "regular-time",
    sourceUrl: provenance?.sourceUrl || null,
    responseSha256: provenance?.responseSha256 || null,
  }))
  .digest("hex");

const isTrustedOfficialClubFinal = (match) => {
  const provenance = match?.resultProvenance;
  const matchId = canonicalSourceMatchId(match?.sourceMatchId ?? match?.id);
  const provenanceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const eventVersion = eventVersionOf(match);
  const provenanceVersion = canonicalVersion(provenance?.eventVersion);
  const providerKickoff = canonicalInstant(provenance?.providerKickoffTime);
  const observedAt = canonicalInstant(provenance?.observedAt ?? match?.resultObservedAt);
  return Boolean(
    match
    && canonicalMatchStatus(match?.status ?? match?.effectiveStatus) === "FINISHED"
    && isValidFinalScore(match)
    && provenance?.provider === "official-club"
    && provenance?.source === "official-club:result-page"
    && provenance?.sourceKind === "official-club-result-page"
    && provenance?.scoreKind === "regular-time"
    && provenance?.official === true
    && provenance?.trusted === true
    && provenance?.promotionEligible === false
    && provenance?.resultObservationFallback === false
    && isOfficialClubResultUrl(provenance?.sourceUrl)
    && matchId
    && provenanceId === matchId
    && eventVersion
    && provenanceVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion)
    && /^[a-f0-9]{64}$/.test(asText(provenance?.responseSha256))
    && /^[a-f0-9]{64}$/.test(asText(provenance?.evidenceHash))
    && provenance.evidenceHash === officialClubEvidenceHash(match, provenance)
  );
};

const isOfficialKLeagueResultUrl = (value) => {
  try {
    const url = new URL(asText(value));
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "www.kleague.com"
      && url.pathname === "/getScheduleList.do";
  } catch {
    return false;
  }
};

const kLeagueEvidenceHash = (match, provenance) => crypto
  .createHash("sha256")
  .update(JSON.stringify({
    provider: "k-league",
    providerMatchId: asText(provenance?.providerMatchId),
    sourceMatchId: canonicalSourceMatchId(provenance?.sourceMatchId),
    eventVersion: provenance?.eventVersion || match?.kickoffTime || null,
    providerKickoffTime: provenance?.providerKickoffTime || null,
    homeTeamId: provenance?.homeTeamId || null,
    awayTeamId: provenance?.awayTeamId || null,
    scoreHome: Number(match?.scoreHome),
    scoreAway: Number(match?.scoreAway),
    scoreKind: "regular-time",
    responseSha256: provenance?.responseSha256 || null,
  }))
  .digest("hex");

const isTrustedKLeagueOfficialFinal = (match) => {
  const provenance = match?.resultProvenance;
  const matchId = canonicalSourceMatchId(match?.sourceMatchId ?? match?.id);
  const provenanceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const eventVersion = eventVersionOf(match);
  const provenanceVersion = canonicalVersion(provenance?.eventVersion);
  const providerKickoff = canonicalInstant(provenance?.providerKickoffTime);
  const observedAt = canonicalInstant(provenance?.observedAt ?? match?.resultObservedAt);
  return Boolean(
    match
    && canonicalMatchStatus(match?.status ?? match?.effectiveStatus) === "FINISHED"
    && isValidFinalScore(match)
    && provenance?.provider === "k-league"
    && provenance?.source === "k-league:official-schedule-api"
    && provenance?.sourceKind === "official-competition-organizer"
    && provenance?.scoreKind === "regular-time"
    && provenance?.official === true
    && provenance?.trusted === true
    && provenance?.promotionEligible === false
    && provenance?.resultObservationFallback === false
    && isOfficialKLeagueResultUrl(provenance?.sourceUrl)
    && /^K\d{2}$/.test(asText(provenance?.homeTeamId))
    && /^K\d{2}$/.test(asText(provenance?.awayTeamId))
    && matchId
    && provenanceId === matchId
    && eventVersion
    && provenanceVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion) + 100 * 60 * 1000
    && /^[a-f0-9]{64}$/.test(asText(provenance?.responseSha256))
    && /^[a-f0-9]{64}$/.test(asText(provenance?.evidenceHash))
    && provenance.evidenceHash === kLeagueEvidenceHash(match, provenance)
  );
};

const isTrustedOfficialFinal = (match) => (
  isOfficialSportteryFinal(match)
  || isTrustedUefaOfficialFinal(match)
  || isTrustedOfficialClubFinal(match)
  || isTrustedKLeagueOfficialFinal(match)
);

const officialSportteryResultUrl = (match) => {
  if (!match || typeof match !== "object") return null;
  const provenance = match.resultProvenance;
  if (isTrustedSportteryProvenance(provenance) && isOfficialSportteryUrl(provenance.sourceUrl)) {
    const matchId = canonicalSourceMatchId(match.sourceMatchId ?? match.id);
    const provenanceId = canonicalSourceMatchId(provenance.sourceMatchId);
    const matchVersion = eventVersionOf(match);
    const provenanceVersion = canonicalVersion(provenance.eventVersion);
    const sameIdentity = Boolean(matchId && provenanceId && matchId === provenanceId);
    const sameVersion = Boolean(matchVersion && provenanceVersion && matchVersion === provenanceVersion);
    const sameResult = isValidFinalScore(match)
      && isValidFinalScore(provenance)
      && match.scoreHome === provenance.scoreHome
      && match.scoreAway === provenance.scoreAway;
    if (sameIdentity && sameVersion && sameResult) return asText(provenance.sourceUrl);
  }

  for (const candidate of [match.resultUrl, match.sourceUrl]) {
    if (isOfficialSportteryUrl(candidate)) return asText(candidate);
  }
  return null;
};

/**
 * `source: "sporttery"` alone is not a sufficient trust signal. Raw rows must
 * retain the exact official HTTPS host, or carry previously validated internal
 * provenance. This prevents fallback and user-supplied rows from closing a game.
 */
const isOfficialSportterySource = (match) => {
  if (!match || typeof match !== "object") return false;
  if (isTrustedSportteryProvenance(match.resultProvenance)) return true;
  // A fallback score must not borrow trust from the fixture row's original
  // Sporttery URL. This is especially important when a 500.com result is
  // attached to an otherwise official pre-match row.
  const explicitResultSource = asText(match.resultSource).toLowerCase();
  if (explicitResultSource && !/^sporttery(?::|$)/.test(explicitResultSource)) return false;
  if (isOfficialSportteryUrl(match.sourceUrl ?? match.resultUrl)) return true;
  return match.official === true && /^sporttery(?::|$)/.test(explicitResultSource);
};

const isOfficialSportteryFinal = (match) => {
  const directFinal = canonicalMatchStatus(match?.status) === "FINISHED";
  const reconciledFinal = canonicalMatchStatus(match?.effectiveStatus) === "FINISHED"
    && isTrustedSportteryProvenance(match?.resultProvenance);
  return (directFinal || reconciledFinal)
    && isValidFinalScore(match)
    && isOfficialSportterySource(match);
};

const isOfficialSportteryVoid = (match) => (
  asText(match?.resultDisposition).toUpperCase() === "VOID"
  && asText(match?.voidSource).toLowerCase() === "sporttery:official-api"
  && Boolean(asText(match?.voidReason))
);

const buildResultProvenance = (match) => {
  if (isTrustedUefaOfficialFinal(match)
      || isTrustedOfficialClubFinal(match)
      || isTrustedKLeagueOfficialFinal(match)) {
    return {
      ...match.resultProvenance,
      sourceStatus: "FINISHED",
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
      kickoffTime: canonicalInstant(match.kickoffTime ?? match.kickoff) || null,
      // Preserve the signed representation. Canonicalization is used only for
      // comparison; rewriting this value would invalidate the evidence hash.
      eventVersion: match.resultProvenance.eventVersion,
      promotionEligible: false,
    };
  }
  if (!isOfficialSportteryFinal(match)) return null;
  const existing = isTrustedSportteryProvenance(match.resultProvenance)
    ? match.resultProvenance
    : null;
  const observedAt = canonicalInstant(
    existing?.observedAt
    ?? match.resultObservedAt
    ?? match.resultMeta?.observedAt
  );
  const explicitObservationSource = asText(
    existing?.observationSource
    ?? match.resultObservationSource
    ?? match.resultMeta?.observationSource
  ) || null;
  // Older trusted Sporttery provenance already persisted the relay observation
  // instant as `observedAt`, but predated the `observationSource` field. Treat
  // only that exact trusted provenance clock as attributed; never infer a
  // source for a root-level/generic sync timestamp.
  const inferredTrustedObservationSource = !explicitObservationSource
    && existing
    && canonicalInstant(existing.observedAt)
    ? "sporttery-trusted-provenance-observed-at"
    : null;
  const observationSource = explicitObservationSource || inferredTrustedObservationSource;
  const observationSourceInferred = existing?.observationSourceInferred === true
    || Boolean(inferredTrustedObservationSource);
  const sourceUpdatedAt = canonicalInstant(
    existing?.sourceUpdatedAt
    ?? match.resultSourceUpdatedAt
    ?? match.resultMeta?.sourceUpdatedAt
  );
  const actualKickoffAt = canonicalInstant(
    existing?.actualKickoffAt
    ?? existing?.actualKickoffTime
    ?? match.actualKickoffAt
    ?? match.actualKickoffTime
    ?? match.resultMeta?.actualKickoffAt
    ?? match.resultMeta?.actualKickoffTime
  );
  const actualKickoffSource = asText(
    existing?.actualKickoffSource
    ?? match.actualKickoffSource
    ?? match.resultMeta?.actualKickoffSource
  ) || null;
  const firstInPlayObservedAt = canonicalInstant(
    existing?.firstInPlayObservedAt
    ?? match.firstInPlayObservedAt
    ?? match.resultMeta?.firstInPlayObservedAt
  );
  const inPlayObservationSource = asText(
    existing?.inPlayObservationSource
    ?? match.inPlayObservationSource
    ?? match.resultMeta?.inPlayObservationSource
  ) || null;
  const kickoffTime = canonicalInstant(match.kickoffTime ?? match.kickoff) || null;
  const observationAfterKickoff = Boolean(
    observedAt
    && kickoffTime
    && Date.parse(observedAt) >= Date.parse(kickoffTime)
  );
  const declaredEventVersions = [match.eventVersion, existing?.eventVersion]
    .map(canonicalVersion)
    .filter(Boolean);
  const eventVersion = declaredEventVersions[0] || null;
  const eventVersionConsistent = Boolean(
    kickoffTime
    && eventVersion
    && declaredEventVersions.every((value) => value === kickoffTime)
  );
  const resultObservationFallback = Boolean(
    existing?.resultObservationFallback === true
    || existing?.observationFallback === true
    || match.resultObservationFallback === true
    || match.resultMeta?.observationFallback === true
    || !observedAt
    || !observationSource
    || !observationAfterKickoff
    || !eventVersionConsistent
    || /(?:fallback|kickoff-plus|legacy-unattributed)/i.test(observationSource || "")
  );
  return {
    version: "result-provenance-v2",
    provider: "sporttery",
    official: true,
    trusted: true,
    source: asText(existing?.source ?? match.resultSource ?? match.source) || "sporttery",
    sourceMethod: asText(existing?.sourceMethod ?? match.sourceMethod) || null,
    sourceUrl: asText(existing?.sourceUrl ?? match.sourceUrl) || null,
    sourceMatchId: asText(existing?.sourceMatchId ?? match.sourceMatchId ?? match.matchId ?? match.id) || null,
    sourceStatus: "FINISHED",
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
    kickoffTime,
    actualKickoffAt,
    actualKickoffSource,
    firstInPlayObservedAt,
    inPlayObservationSource,
    eventVersion,
    eventVersionConsistent,
    observationSource,
    observationSourceInferred,
    observationSourceDerivation: asText(existing?.observationSourceDerivation)
      || (inferredTrustedObservationSource
        ? "trusted-legacy-sporttery-provenance"
        : (explicitObservationSource ? "explicit" : null)),
    observedAt,
    observationAfterKickoff,
    sourceUpdatedAt,
    sourceUpdatedAtAvailable: Boolean(sourceUpdatedAt),
    resultObservationFallback,
    promotionEligible: Boolean(
      observedAt
      && observationSource
      && eventVersion
      && eventVersionConsistent
      && observationAfterKickoff
      && !resultObservationFallback
    ),
  };
};

// Commit the complete pure dependency closure of result admission, not the
// whole lifecycle module (unrelated display/merge changes are not a new trial).
// verifyResultTimelineSemanticClosure checks this inventory against lexical
// dependencies and rejects newly introduced helpers that are not committed.
const resultProvenanceSemanticCommitment = () => ({
  version: "result-provenance-semantic-closure-v1",
  constants: { MATCH_STATUS_PRIORITY },
  builtins: ["node:crypto"],
  functions: Object.fromEntries(Object.entries({
    asText,
    buildResultProvenance,
    canonicalInstant,
    canonicalMatchStatus,
    canonicalSourceMatchId,
    canonicalText,
    canonicalVersion,
    eventVersionOf,
    isOfficialClubResultUrl,
    isOfficialKLeagueResultUrl,
    isOfficialSportteryFinal,
    isOfficialSportterySource,
    isOfficialSportteryUrl,
    isTrustedKLeagueOfficialFinal,
    isTrustedOfficialClubFinal,
    isTrustedSportteryProvenance,
    isTrustedUefaOfficialFinal,
    isValidFinalScore,
    kLeagueEvidenceHash,
    officialClubEvidenceHash,
    strictInstant,
    uefaEvidenceHash,
  }).map(([name, fn]) => [name, fn.toString().replace(/\r\n?/gu, "\n")])),
});

const nowMsFrom = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : Date.now();
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const deriveMatchLifecycle = (match, options = {}) => {
  const sourceStatus = canonicalMatchStatus(match?.sourceStatus ?? match?.status);
  const trustedFinalMatch = { ...match, sourceStatus };
  const trustedFinal = isTrustedOfficialFinal(trustedFinalMatch);
  if (trustedFinal) {
    const provider = trustedFinalMatch?.resultProvenance?.provider;
    return {
      sourceStatus,
      effectiveStatus: "FINISHED",
      statusReason: provider === "uefa"
        ? "official-uefa-final"
        : provider === "official-club"
          ? "official-club-final"
          : provider === "k-league"
            ? "official-k-league-final"
            : "official-sporttery-final",
      resultProvenance: buildResultProvenance(trustedFinalMatch),
    };
  }


  if (isOfficialSportteryVoid(match)) {
    return {
      sourceStatus,
      effectiveStatus: "PENDING_RESULT",
      statusReason: "official-sporttery-void",
      resultProvenance: null,
    };
  }

  const nowMs = nowMsFrom(options.now);
  const kickoffMs = Date.parse(asText(match?.kickoffTime ?? match?.kickoff));
  const pendingAfterMinutes = Number.isFinite(Number(options.pendingAfterMinutes))
    ? Math.max(0, Number(options.pendingAfterMinutes))
    : PENDING_RESULT_AFTER_MINUTES;
  const elapsedMinutes = Number.isFinite(kickoffMs) ? (nowMs - kickoffMs) / 60000 : null;
  const isFuture = elapsedMinutes !== null && elapsedMinutes < 0;
  const isOverdue = elapsedMinutes !== null && elapsedMinutes >= pendingAfterMinutes;

  if (sourceStatus === "FINISHED") {
    const statusReason = isValidFinalScore(match)
      ? "untrusted-final-rejected"
      : "invalid-final-score-rejected";
    return {
      sourceStatus,
      effectiveStatus: isFuture ? "SCHEDULED" : "PENDING_RESULT",
      statusReason,
      resultProvenance: null,
    };
  }

  if (sourceStatus === "PENDING_RESULT") {
    return {
      sourceStatus,
      effectiveStatus: "PENDING_RESULT",
      statusReason: "source-pending-result",
      resultProvenance: null,
    };
  }

  if (isOverdue && (sourceStatus === "SCHEDULED" || sourceStatus === "LIVE" || sourceStatus === "UNKNOWN")) {
    return {
      sourceStatus,
      effectiveStatus: "PENDING_RESULT",
      statusReason: "kickoff-overdue-awaiting-official-result",
      resultProvenance: null,
    };
  }

  if (sourceStatus === "LIVE") {
    return {
      sourceStatus,
      effectiveStatus: "LIVE",
      statusReason: "source-live",
      resultProvenance: null,
    };
  }

  if (!isFuture && (sourceStatus === "SCHEDULED" || sourceStatus === "UNKNOWN")) {
    return {
      sourceStatus,
      effectiveStatus: "LIVE",
      statusReason: "kickoff-passed-awaiting-official-result",
      resultProvenance: null,
    };
  }

  return {
    sourceStatus,
    effectiveStatus: "SCHEDULED",
    statusReason: sourceStatus === "SCHEDULED" ? "source-scheduled" : "unknown-source-status",
    resultProvenance: null,
  };
};

const resolveMatchLifecycle = (match, options = {}) => {
  const input = match && typeof match === "object" ? match : {};
  const lifecycle = deriveMatchLifecycle(input, options);
  const resolved = {
    ...input,
    status: lifecycle.effectiveStatus,
    ...lifecycle,
  };
  if (lifecycle.sourceStatus === "FINISHED" && lifecycle.effectiveStatus !== "FINISHED") {
    delete resolved.scoreHome;
    delete resolved.scoreAway;
    delete resolved.postMatchReview;
  }
  return resolved;
};

const hasUsefulValue = (value) => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return asText(value) !== "";
};

const richerPreMatchValue = (currentValue, incomingValue) => {
  if (!hasUsefulValue(currentValue)) return incomingValue;
  if (!hasUsefulValue(incomingValue)) return currentValue;
  if (Array.isArray(currentValue) && Array.isArray(incomingValue)) {
    return incomingValue.length > currentValue.length ? incomingValue : currentValue;
  }
  return currentValue;
};

const instantMs = (value) => {
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const preMatchSnapshotVersion = (match) => ({
  decisionAt: Math.max(
    instantMs(match?.predictionMeta?.decisionGeneratedAt),
    instantMs(match?.predictionMeta?.generatedAt),
    instantMs(match?.probabilityModel?.unifiedPosterior?.generatedAt),
    instantMs(match?.probabilityModel?.generatedAt)
  ),
  publishedAt: instantMs(match?.predictionMeta?.updatedAt),
  oddsAt: Math.max(instantMs(match?.oddsUpdatedAt), instantMs(match?.odds?.updatedAt)),
});

const isStrictlyNewerPreMatchSnapshot = (current, incoming) => {
  const currentVersion = preMatchSnapshotVersion(current);
  const incomingVersion = preMatchSnapshotVersion(incoming);
  return incomingVersion.decisionAt > currentVersion.decisionAt
    || (incomingVersion.decisionAt === currentVersion.decisionAt
      && incomingVersion.publishedAt > currentVersion.publishedAt)
    || (incomingVersion.decisionAt === currentVersion.decisionAt
      && incomingVersion.publishedAt === currentVersion.publishedAt
      && incomingVersion.oddsAt > currentVersion.oddsAt);
};

const hasCompleteAtomicPreMatchSnapshot = (match) => (
  ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(match || {}, field) || match?.[field] === undefined) return false;
    if (field === "predictions") return Array.isArray(match[field]);
    if (field === "odds") {
      // Model-only references deliberately carry an explicit null odds field
      // until official HAD opens. Treat that explicit absence as part of the
      // atomic snapshot; otherwise these rows can never replace an obsolete
      // probability payload before cutoff.
      return hasUsefulValue(match[field]) || (
        match[field] === null
        && String(match?.probabilityModel?.version || "").includes("model-only")
      );
    }
    return hasUsefulValue(match[field]);
  })
);

const isBeforeMatchSaleCutoff = (match, options = {}) => {
  const nowMs = nowMsFrom(options && typeof options === "object" ? options.now : options);
  const kickoffAt = Date.parse(asText(match?.kickoffTime ?? match?.kickoff));
  if (!Number.isFinite(kickoffAt) || nowMs >= kickoffAt) return false;
  const buyEndAt = Date.parse(asText(match?.buyEndTime));
  return !Number.isFinite(buyEndAt) || nowMs < buyEndAt;
};

const shouldAdoptIncomingPreMatchSnapshot = (current, incoming, options = {}) => (
  canonicalMatchStatus(current?.effectiveStatus ?? current?.status) === "SCHEDULED"
  && canonicalMatchStatus(incoming?.effectiveStatus ?? incoming?.status) === "SCHEDULED"
  && isBeforeMatchSaleCutoff(current, options)
  && isBeforeMatchSaleCutoff(incoming, options)
  && hasCompleteAtomicPreMatchSnapshot(incoming)
  && isStrictlyNewerPreMatchSnapshot(current, incoming)
);

const mergeDefined = (fallback, preferred) => {
  const merged = { ...(fallback || {}) };
  for (const [key, value] of Object.entries(preferred || {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const provisionalResultObservedAtMs = (evidence) => Math.max(
  Date.parse(canonicalInstant(evidence?.latestObservedAt) || "") || 0,
  Date.parse(canonicalInstant(evidence?.observedAt) || "") || 0,
  Date.parse(canonicalInstant(evidence?.firstObservedAt) || "") || 0
);

const validProvisionalResultForMatch = (match, evidence) => {
  if (!match || !evidence || typeof evidence !== "object") return false;
  if (
    evidence.official !== false
    || evidence.trusted !== false
    || evidence.promotionEligible !== false
    || evidence.provider !== "500.com"
    || !String(evidence.source || "").startsWith("500.com")
    || !Number.isInteger(evidence.scoreHome)
    || evidence.scoreHome < 0
    || !Number.isInteger(evidence.scoreAway)
    || evidence.scoreAway < 0
  ) {
    return false;
  }
  const matchId = canonicalSourceMatchId(match.sourceMatchId || match.id);
  const evidenceId = canonicalSourceMatchId(evidence.sourceMatchId);
  if (!matchId || !evidenceId || matchId !== evidenceId) return false;
  const matchEvent = canonicalInstant(eventVersionOf(match));
  const evidenceEvent = canonicalInstant(evidence.eventVersion || evidence.kickoffTime);
  if (!matchEvent || !evidenceEvent || matchEvent !== evidenceEvent) return false;
  const observedAtMs = provisionalResultObservedAtMs(evidence);
  return observedAtMs > 0 && observedAtMs >= Date.parse(matchEvent);
};

const mergeProvisionalResultEvidence = (target, current, incoming) => {
  const candidates = [current?.provisionalResult, incoming?.provisionalResult]
    .filter((evidence) => validProvisionalResultForMatch(target, evidence));
  if (!candidates.length) {
    delete target.provisionalResult;
    return target;
  }
  candidates.sort((left, right) => {
    const revisionDelta = Number(left?.resultRevision || 0) - Number(right?.resultRevision || 0);
    return revisionDelta || provisionalResultObservedAtMs(left) - provisionalResultObservedAtMs(right);
  });
  target.provisionalResult = candidates.at(-1);
  return target;
};

const clearProvisionalResult = (match) => {
  if (match && typeof match === "object") delete match.provisionalResult;
  return match;
};

const mergePreMatchFields = (target, current, incoming, options = {}) => {
  const incomingOwnsSnapshot = shouldAdoptIncomingPreMatchSnapshot(current, incoming, options);
  const primary = incomingOwnsSnapshot ? incoming : current;
  const secondary = incomingOwnsSnapshot ? current : incoming;
  for (const field of PRE_MATCH_FIELDS) {
    if (incomingOwnsSnapshot && ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS.includes(field)) {
      target[field] = primary[field];
      continue;
    }
    const value = richerPreMatchValue(primary?.[field], secondary?.[field]);
    if (value !== undefined) target[field] = value;
  }
  return target;
};

const withLifecycle = (match, lifecycle) => ({
  ...match,
  status: lifecycle.effectiveStatus,
  sourceStatus: lifecycle.sourceStatus,
  effectiveStatus: lifecycle.effectiveStatus,
  statusReason: lifecycle.statusReason,
  resultProvenance: lifecycle.resultProvenance,
});

const reviewSettlement = (match) => {
  const settlement = match?.postMatchReview?.settlement;
  return settlement && typeof settlement === "object" ? settlement : null;
};

const reviewResultRevision = (match) => {
  const revision = Number(reviewSettlement(match)?.resultRevision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
};

const reviewGeneratedAtMs = (match) => {
  const settlement = reviewSettlement(match);
  return Math.max(
    Date.parse(canonicalInstant(match?.postMatchReview?.generatedAt) || "") || 0,
    Date.parse(canonicalInstant(settlement?.reviewGeneratedAt) || "") || 0,
    Date.parse(canonicalInstant(settlement?.settledAt) || "") || 0
  );
};

const shouldAcceptIncomingTerminalReview = (current, incoming) => {
  if (!incoming?.postMatchReview) return false;
  if (!current?.postMatchReview) return true;

  const currentRevision = reviewResultRevision(current);
  const incomingRevision = reviewResultRevision(incoming);
  if (currentRevision !== null || incomingRevision !== null) {
    if (incomingRevision === null) return false;
    if (currentRevision === null || incomingRevision > currentRevision) return true;
    if (incomingRevision < currentRevision) return false;
  }

  const currentGeneratedAt = reviewGeneratedAtMs(current);
  const incomingGeneratedAt = reviewGeneratedAtMs(incoming);
  return incomingGeneratedAt > 0 && incomingGeneratedAt > currentGeneratedAt;
};

const mergeOfficialResult = (current, result, lifecycle, reason) => {
  const merged = mergePreMatchFields(mergeDefined(result, current), current, result);
  merged.scoreHome = result.scoreHome;
  merged.scoreAway = result.scoreAway;
  for (const field of RESULT_FIELDS) {
    if (result[field] !== undefined) merged[field] = result[field];
  }
  for (const field of VOID_FIELDS) delete merged[field];
  return clearProvisionalResult(withLifecycle(merged, {
    ...lifecycle,
    effectiveStatus: "FINISHED",
    statusReason: reason,
    resultProvenance: buildResultProvenance({
      ...result,
      actualKickoffAt: result.actualKickoffAt ?? current.actualKickoffAt,
      actualKickoffTime: result.actualKickoffTime ?? current.actualKickoffTime,
      actualKickoffSource: result.actualKickoffSource ?? current.actualKickoffSource,
      firstInPlayObservedAt: result.firstInPlayObservedAt ?? current.firstInPlayObservedAt,
      inPlayObservationSource: result.inPlayObservationSource ?? current.inPlayObservationSource,
    }),
  }));
};

const mergeOfficialVoid = (current, carrier, reason) => {
  const merged = mergePreMatchFields(mergeDefined(current, carrier), current, carrier);
  for (const field of VOID_FIELDS) {
    if (carrier[field] !== undefined) merged[field] = carrier[field];
  }
  delete merged.scoreHome;
  delete merged.scoreAway;
  delete merged.postMatchReview;
  return clearProvisionalResult(withLifecycle(merged, {
    sourceStatus: canonicalMatchStatus(carrier.sourceStatus ?? carrier.status),
    effectiveStatus: "PENDING_RESULT",
    statusReason: reason,
    resultProvenance: null,
  }));
};

/**
 * Reconciles a current/read-model row with an asynchronously arriving row.
 * The first argument remains the preferred source for pre-match information;
 * only a same-event trusted official final can supply terminal fields.
 */
const reconcileMatchLifecycle = (currentMatch, incomingMatch, options = {}) => {
  if (!currentMatch || typeof currentMatch !== "object") {
    return resolveMatchLifecycle(incomingMatch, options);
  }
  if (!incomingMatch || typeof incomingMatch !== "object") {
    return resolveMatchLifecycle(currentMatch, options);
  }

  const current = resolveMatchLifecycle(currentMatch, options);
  const incoming = resolveMatchLifecycle(incomingMatch, options);

  if (!sameEvent(currentMatch, incomingMatch)) {
    return withLifecycle(current, {
      sourceStatus: current.sourceStatus,
      effectiveStatus: current.effectiveStatus,
      statusReason: "incoming-event-mismatch-kept-current",
      resultProvenance: current.resultProvenance,
    });
  }

  const currentFinal = isTrustedOfficialFinal(current);
  const incomingFinal = isTrustedOfficialFinal(incoming);

  if (currentFinal) {
    if (incomingFinal
      && (incoming.scoreHome !== current.scoreHome || incoming.scoreAway !== current.scoreAway)) {
      return mergeOfficialResult(current, current, current, "official-result-conflict-terminal-preserved");
    }
    if (
      incomingFinal
      && current?.resultProvenance?.promotionEligible !== true
      && incoming?.resultProvenance?.promotionEligible === true
    ) {
      return mergeOfficialResult(current, {
        ...current,
        resultSource: incoming.resultSource,
        resultUpdatedAt: incoming.resultUpdatedAt,
        resultObservedAt: incoming.resultObservedAt,
        resultObservationSource: incoming.resultObservationSource,
        resultObservationFallback: false,
        resultSourceUpdatedAt: incoming.resultSourceUpdatedAt,
        eventVersion: incoming.eventVersion || eventVersionOf(incoming),
        resultProvenance: incoming.resultProvenance,
      }, incoming, "terminal-final-observation-upgraded");
    }
    const resultCarrier = incomingFinal && shouldAcceptIncomingTerminalReview(current, incoming)
      ? { ...current, postMatchReview: incoming.postMatchReview }
      : current;
    return mergeOfficialResult(
      mergePreMatchFields(mergeDefined(incoming, resultCarrier), current, incoming),
      resultCarrier,
      current,
      "terminal-final-preserved"
    );
  }

  if (incomingFinal) {
    return mergeOfficialResult(
      current,
      incoming,
      incoming,
      `official-final-overrode-${String(current.effectiveStatus || "unknown").toLowerCase()}`
    );
  }


  const currentVoid = isOfficialSportteryVoid(current);
  const incomingVoid = isOfficialSportteryVoid(incoming);
  if (currentVoid) {
    return mergeOfficialVoid(
      mergePreMatchFields(mergeDefined(incoming, current), current, incoming),
      current,
      incomingVoid ? "terminal-void-preserved" : "official-void-overrode-stale-lifecycle"
    );
  }
  if (incomingVoid) {
    return mergeOfficialVoid(
      mergePreMatchFields(mergeDefined(current, incoming), current, incoming),
      incoming,
      "official-void-promoted"
    );
  }

  const currentPriority = MATCH_STATUS_PRIORITY[current.effectiveStatus] || 0;
  const incomingPriority = MATCH_STATUS_PRIORITY[incoming.effectiveStatus] || 0;
  const lifecycleWinner = incomingPriority > currentPriority ? incoming : current;
  const merged = mergePreMatchFields(mergeDefined(incoming, current), current, incoming, options);

  // A rejected FINISHED row must not smuggle a score or review into the read model.
  if (canonicalMatchStatus(incomingMatch.status) === "FINISHED") {
    if (currentMatch.scoreHome === undefined) delete merged.scoreHome;
    if (currentMatch.scoreAway === undefined) delete merged.scoreAway;
    if (currentMatch.postMatchReview === undefined) delete merged.postMatchReview;
  }

  return mergeProvisionalResultEvidence(withLifecycle(merged, {
    sourceStatus: lifecycleWinner.sourceStatus,
    effectiveStatus: lifecycleWinner.effectiveStatus,
    statusReason: lifecycleWinner === incoming
      ? `higher-status-${incoming.statusReason}`
      : (canonicalMatchStatus(incomingMatch.status) === "FINISHED"
        ? incoming.statusReason
        : current.statusReason),
    resultProvenance: null,
  }), current, incoming);
};

module.exports = {
  MATCH_STATUS_PRIORITY,
  PENDING_RESULT_AFTER_MINUTES,
  PRE_MATCH_FIELDS,
  ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS,
  canonicalSourceMatchId,
  canonicalMatchStatus,
  eventVersionOf,
  sameEvent,
  isValidFinalScore,
  officialSportteryResultUrl,
  isOfficialSportterySource,
  isOfficialSportteryFinal,
  isTrustedUefaOfficialFinal,
  isTrustedOfficialClubFinal,
  isTrustedKLeagueOfficialFinal,
  isTrustedOfficialFinal,
  isOfficialSportteryVoid,
  buildResultProvenance,
  resultProvenanceSemanticCommitment,
  deriveMatchLifecycle,
  resolveMatchLifecycle,
  isBeforeMatchSaleCutoff,
  reconcileMatchLifecycle,
  mergeMatchLifecycle: reconcileMatchLifecycle,
};
