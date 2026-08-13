import type { Match } from './mockData';

type LifecycleStatus = Match['status'] | 'UNKNOWN';

export const MATCH_STATUS_PRIORITY: Readonly<Record<LifecycleStatus, number>> = Object.freeze({
  UNKNOWN: 0,
  SCHEDULED: 10,
  LIVE: 20,
  PENDING_RESULT: 30,
  FINISHED: 40
});

export const PENDING_RESULT_AFTER_MINUTES = 130;

const PRE_MATCH_FIELDS: ReadonlyArray<keyof Match> = [
  'odds', 'oddsTrend', 'oddsSource', 'oddsPoolCode', 'oddsSourceMethod', 'oddsUpdatedAt', 'oddsSourceUrl',
  'handicapOdds', 'handicapLine', 'handicapOddsSource', 'handicapOddsPoolCode', 'handicapOddsSourceMethod',
  'handicapOddsUpdatedAt', 'handicapOddsSourceUrl', 'predictions', 'predictionMeta', 'gptPrediction', 'probabilityModel',
  // This is the immutable, cutoff-safe direction shown after kickoff. Current,
  // unresolved-archive, and history responses can arrive in any order; a
  // compact current response must never erase an archive loaded moments earlier.
  'archivedPreMatchPrediction'
];

const ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS: ReadonlyArray<keyof Match> = [
  'odds', 'predictions', 'predictionMeta', 'probabilityModel'
];

const VOID_FIELDS: ReadonlyArray<keyof Match> = [
  'resultDisposition', 'voidReason', 'voidSource', 'voidObservedAt', 'voidSourceUrl', 'voidSourceMethod'
];

const asText = (value: unknown) => String(value ?? '').trim();

const canonicalStatus = (value: unknown): LifecycleStatus => {
  const status = asText(value).toUpperCase() as LifecycleStatus;
  return Object.prototype.hasOwnProperty.call(MATCH_STATUS_PRIORITY, status) ? status : 'UNKNOWN';
};

const canonicalInstant = (value: unknown) => {
  const time = Date.parse(asText(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const canonicalText = (value: unknown) => asText(value)
  .toLowerCase()
  .replace(/\s+/g, ' ');

// Published ids may be prefixed even when legacy rows have no sourceMatchId.
// Only strip the two prefixes emitted by this application so unrelated
// provider identities can never be collapsed accidentally.
export const canonicalSourceMatchId = (value: unknown) => canonicalText(value)
  .replace(/^(?:sporttery|fivehundred)[_:-]/, '');

const canonicalVersion = (value: unknown) => {
  const text = asText(value);
  if (!text) return null;
  return canonicalInstant(text) || canonicalText(text);
};

export const eventVersionOf = (match?: Partial<Match> | null) => (
  canonicalVersion(match?.eventVersion) || canonicalInstant(match?.kickoffTime)
);

const sourceMatchKey = (match: Partial<Match>) => canonicalSourceMatchId(match.sourceMatchId || match.id);

const teamKey = (match: Partial<Match>, side: 'home' | 'away') => canonicalText(
  side === 'home' ? (match.homeTeamId || match.homeTeamName) : (match.awayTeamId || match.awayTeamName)
);

export const sameMatchEvent = (left?: Partial<Match> | null, right?: Partial<Match> | null) => {
  if (!left || !right) return false;
  const leftKey = sourceMatchKey(left);
  const rightKey = sourceMatchKey(right);
  if (leftKey && rightKey && leftKey !== rightKey) return false;

  const leftVersion = canonicalVersion(left.eventVersion);
  const rightVersion = canonicalVersion(right.eventVersion);
  if (leftVersion && rightVersion && leftVersion !== rightVersion) return false;

  const leftKickoff = canonicalInstant(left.kickoffTime);
  const rightKickoff = canonicalInstant(right.kickoffTime);
  if (leftKickoff && rightKickoff && leftKickoff !== rightKickoff) return false;

  const leftAnchor = leftVersion || leftKickoff;
  const rightAnchor = rightVersion || rightKickoff;
  if (Boolean(leftAnchor) !== Boolean(rightAnchor)) return false;
  if (leftAnchor && rightAnchor && leftAnchor !== rightAnchor) return false;

  const leftHome = teamKey(left, 'home');
  const rightHome = teamKey(right, 'home');
  const leftAway = teamKey(left, 'away');
  const rightAway = teamKey(right, 'away');
  if (leftHome && rightHome && leftHome !== rightHome) return false;
  if (leftAway && rightAway && leftAway !== rightAway) return false;
  const sharedIdentity = Boolean(leftKey && rightKey)
    || Boolean(leftHome && rightHome && leftAway && rightAway);
  return sharedIdentity && (!leftAnchor || Boolean(rightAnchor));
};

const isValidFinalScore = (match: Partial<Match>) => [match.scoreHome, match.scoreAway].every((score) => (
  typeof score === 'number' && Number.isInteger(score) && score >= 0
));

const isOfficialUrl = (value: unknown) => {
  try {
    const url = new URL(asText(value));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'webapi.sporttery.cn';
  } catch {
    return false;
  }
};

const hasTrustedResultProvenance = (match: Partial<Match>) => (
  match.resultProvenance?.provider === 'sporttery'
  && match.resultProvenance.official === true
  && match.resultProvenance.trusted !== false
);

const hasTrustedUefaResultProvenance = (match: Partial<Match>) => {
  const provenance = match.resultProvenance;
  const matchId = canonicalSourceMatchId(match.sourceMatchId || match.id);
  const provenanceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const eventVersion = eventVersionOf(match);
  const provenanceVersion = canonicalInstant(provenance?.eventVersion);
  const providerKickoff = canonicalInstant(provenance?.providerKickoffTime);
  const observedAt = canonicalInstant(provenance?.observedAt);
  return Boolean(
    provenance?.provider === 'uefa'
    && provenance.source === 'uefa:official-match-api'
    && provenance.sourceKind === 'official-competition-organizer'
    && provenance.scoreKind === 'regular-time'
    && provenance.official === true
    && provenance.trusted === true
    && provenance.resultObservationFallback === false
    && matchId
    && provenanceId === matchId
    && eventVersion
    && provenanceVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion)
    && /^[a-f0-9]{64}$/.test(provenance.responseSha256 || '')
    && /^[a-f0-9]{64}$/.test(provenance.evidenceHash || '')
  );
};

const isOfficialClubResultUrl = (value: unknown) => {
  try {
    const url = new URL(asText(value));
    return url.protocol === 'https:'
      && ['www.aikfotboll.se', 'www.rbk.no'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const hasTrustedOfficialClubResultProvenance = (match: Partial<Match>) => {
  const provenance = match.resultProvenance;
  const matchId = canonicalSourceMatchId(match.sourceMatchId || match.id);
  const provenanceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const eventVersion = eventVersionOf(match);
  const provenanceVersion = canonicalInstant(provenance?.eventVersion);
  const providerKickoff = canonicalInstant(provenance?.providerKickoffTime);
  const observedAt = canonicalInstant(provenance?.observedAt);
  return Boolean(
    provenance?.provider === 'official-club'
    && provenance.source === 'official-club:result-page'
    && provenance.sourceKind === 'official-club-result-page'
    && provenance.scoreKind === 'regular-time'
    && provenance.official === true
    && provenance.trusted === true
    && provenance.promotionEligible === false
    && provenance.resultObservationFallback === false
    && isOfficialClubResultUrl(provenance.sourceUrl)
    && matchId
    && provenanceId === matchId
    && eventVersion
    && provenanceVersion === eventVersion
    && providerKickoff === eventVersion
    && observedAt
    && Date.parse(observedAt) >= Date.parse(eventVersion)
    && /^[a-f0-9]{64}$/.test(provenance.responseSha256 || '')
    && /^[a-f0-9]{64}$/.test(provenance.evidenceHash || '')
  );
};

export const isOfficialSportteryFinal = (match: Partial<Match>) => (
  (canonicalStatus(match.status) === 'FINISHED' || (
    canonicalStatus(match.effectiveStatus) === 'FINISHED' && hasTrustedResultProvenance(match)
  ))
  && isValidFinalScore(match)
  && (hasTrustedResultProvenance(match) || isOfficialUrl(match.sourceUrl))
);

export const isTrustedOfficialFinal = (match: Partial<Match>) => (
  isOfficialSportteryFinal(match)
  || (
    (canonicalStatus(match.status) === 'FINISHED' || canonicalStatus(match.effectiveStatus) === 'FINISHED')
    && isValidFinalScore(match)
    && hasTrustedUefaResultProvenance(match)
  )
  || (
    (canonicalStatus(match.status) === 'FINISHED' || canonicalStatus(match.effectiveStatus) === 'FINISHED')
    && isValidFinalScore(match)
    && hasTrustedOfficialClubResultProvenance(match)
  )
);

export const isOfficialSportteryVoid = (match: Partial<Match>) => (
  asText(match.resultDisposition).toUpperCase() === 'VOID'
  && asText(match.voidSource).toLowerCase() === 'sporttery:official-api'
  && Boolean(asText(match.voidReason))
);

const clearVoidDisposition = (match: Match) => {
  const mutable = match as unknown as Record<string, unknown>;
  VOID_FIELDS.forEach((field) => delete mutable[String(field)]);
  return match;
};

const applyOfficialVoid = (base: Match, carrier: Match, reason: string): Match => {
  const merged = preservePreMatch({ ...base, ...carrier }, base, carrier);
  const mutable = merged as unknown as Record<string, unknown>;
  VOID_FIELDS.forEach((field) => {
    const key = String(field);
    if ((carrier as unknown as Record<string, unknown>)[key] !== undefined) {
      mutable[key] = (carrier as unknown as Record<string, unknown>)[key];
    }
  });
  delete merged.scoreHome;
  delete merged.scoreAway;
  delete merged.postMatchReview;
  return {
    ...merged,
    status: 'PENDING_RESULT',
    sourceStatus: canonicalStatus(carrier.sourceStatus || carrier.status),
    effectiveStatus: 'PENDING_RESULT',
    statusReason: reason,
    resultProvenance: null
  };
};

const resultProvenance = (match: Partial<Match>): Match['resultProvenance'] => ({
  ...match.resultProvenance,
  provider: match.resultProvenance?.provider || 'sporttery',
  source: match.resultProvenance?.source || match.resultSource || match.source || 'sporttery',
  sourceMethod: match.resultProvenance?.sourceMethod || match.sourceMethod || null,
  sourceUrl: match.resultProvenance?.sourceUrl || match.sourceUrl || null,
  sourceMatchId: match.resultProvenance?.sourceMatchId || match.sourceMatchId || match.id || null,
  sourceStatus: 'FINISHED',
  official: true,
  trusted: true,
  scoreHome: match.scoreHome,
  scoreAway: match.scoreAway,
  kickoffTime: canonicalInstant(match.kickoffTime),
  eventVersion: match.resultProvenance?.provider === 'uefa'
    || match.resultProvenance?.provider === 'official-club'
    ? match.resultProvenance.eventVersion
    : eventVersionOf(match),
  observedAt: canonicalInstant(match.resultUpdatedAt || match.resultProvenance?.observedAt),
  promotionEligible: match.resultProvenance?.provider === 'uefa'
    || match.resultProvenance?.provider === 'official-club'
    ? false
    : match.resultProvenance?.promotionEligible
});

type ReviewSettlementVersion = {
  resultRevision?: unknown;
  resultObservedAt?: unknown;
  reviewGeneratedAt?: unknown;
  settledAt?: unknown;
};

const reviewSettlementVersion = (match: Partial<Match>): ReviewSettlementVersion | null => {
  const review = match.postMatchReview as (typeof match.postMatchReview & {
    settlement?: ReviewSettlementVersion;
  }) | undefined;
  return review?.settlement || null;
};

const resultRevisionOf = (match: Partial<Match>) => {
  const rawRevision = reviewSettlementVersion(match)?.resultRevision;
  if (rawRevision === undefined || rawRevision === null || rawRevision === '') return null;
  const revision = Number(rawRevision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
};

const resultObservedAtMs = (match: Partial<Match>) => {
  const settlementObservedAt = reviewSettlementVersion(match)?.resultObservedAt;
  return Math.max(
    Date.parse(canonicalInstant(match.resultUpdatedAt) || '') || 0,
    Date.parse(canonicalInstant(match.resultProvenance?.observedAt) || '') || 0,
    Date.parse(canonicalInstant(settlementObservedAt) || '') || 0
  );
};

const reviewGeneratedAtMs = (match: Partial<Match>) => {
  const settlement = reviewSettlementVersion(match);
  return Math.max(
    Date.parse(canonicalInstant(match.postMatchReview?.generatedAt) || '') || 0,
    Date.parse(canonicalInstant(settlement?.reviewGeneratedAt) || '') || 0,
    Date.parse(canonicalInstant(settlement?.settledAt) || '') || 0
  );
};

/**
 * Same-score terminal rows can arrive from the current bridge and history lane
 * in either order. A result revision is the primary ordering proof; a review
 * generation timestamp is used only when revisions are equal or absent. Once a
 * versioned review is present, an unversioned response cannot replace it.
 */
const shouldAcceptIncomingTerminalReview = (current: Partial<Match>, incoming: Partial<Match>) => {
  const currentReview = current.postMatchReview;
  const incomingReview = incoming.postMatchReview;
  if (!incomingReview) return false;
  if (!currentReview) return true;

  const currentRevision = resultRevisionOf(current);
  const incomingRevision = resultRevisionOf(incoming);
  if (currentRevision !== null || incomingRevision !== null) {
    if (incomingRevision === null) return false;
    if (currentRevision === null || incomingRevision > currentRevision) return true;
    if (incomingRevision < currentRevision) return false;
  }

  const currentGeneratedAt = reviewGeneratedAtMs(current);
  const incomingGeneratedAt = reviewGeneratedAtMs(incoming);
  return incomingGeneratedAt > 0 && incomingGeneratedAt > currentGeneratedAt;
};

/**
 * A terminal score is monotonic unless the same trusted official feed carries
 * an auditable, strictly newer correction. Revision wins when either side has
 * one; timestamps are only the legacy fallback when neither side is versioned.
 */
const isStrictlyNewerOfficialCorrection = (current: Match, incoming: Match) => {
  const currentRevision = resultRevisionOf(current);
  const incomingRevision = resultRevisionOf(incoming);
  if (currentRevision !== null || incomingRevision !== null) {
    return incomingRevision !== null && incomingRevision > (currentRevision || 0);
  }

  const currentObservedAt = resultObservedAtMs(current);
  const incomingObservedAt = resultObservedAtMs(incoming);
  return incomingObservedAt > 0 && incomingObservedAt > currentObservedAt;
};

export const resolveMatchLifecycle = (match: Match, now = Date.now()): Match => {
  const sourceStatus = canonicalStatus(match.sourceStatus || match.status);
  if (isTrustedOfficialFinal(match)) {
    const provider = match.resultProvenance?.provider;
    return clearVoidDisposition({
      ...match,
      status: 'FINISHED',
      sourceStatus,
      effectiveStatus: 'FINISHED',
      statusReason: provider === 'uefa'
        ? 'official-uefa-final'
        : provider === 'official-club'
          ? 'official-club-final'
          : 'official-sporttery-final',
      resultProvenance: resultProvenance(match)
    });
  }

  if (isOfficialSportteryVoid(match)) {
    return applyOfficialVoid(match, match, 'official-sporttery-void');
  }

  const kickoffAt = Date.parse(match.kickoffTime || '');
  const overdue = Number.isFinite(kickoffAt) && now - kickoffAt >= PENDING_RESULT_AFTER_MINUTES * 60_000;
  let effectiveStatus: Match['status'] = sourceStatus === 'UNKNOWN' ? 'SCHEDULED' : sourceStatus;
  let statusReason = sourceStatus === 'UNKNOWN' ? 'unknown-source-status' : `source-${sourceStatus.toLowerCase()}`;
  if (sourceStatus === 'FINISHED') {
    effectiveStatus = 'PENDING_RESULT';
    statusReason = isValidFinalScore(match) ? 'untrusted-final-rejected' : 'invalid-final-score-rejected';
  } else if (overdue && ['SCHEDULED', 'LIVE', 'UNKNOWN'].includes(sourceStatus)) {
    effectiveStatus = 'PENDING_RESULT';
    statusReason = 'kickoff-overdue-awaiting-official-result';
  }
  const resolved: Match = {
    ...match,
    status: effectiveStatus,
    sourceStatus,
    effectiveStatus,
    statusReason,
    resultProvenance: null
  };
  if (sourceStatus === 'FINISHED' && effectiveStatus !== 'FINISHED') {
    delete resolved.scoreHome;
    delete resolved.scoreAway;
    delete resolved.postMatchReview;
  }
  return resolved;
};

const useful = (value: unknown) => value !== undefined
  && value !== null
  && (!Array.isArray(value) || value.length > 0)
  && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);

const instantMs = (value: unknown) => {
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const preMatchSnapshotVersion = (match: Partial<Match>) => {
  const meta = match.predictionMeta as (Match['predictionMeta'] & {
    decisionGeneratedAt?: unknown;
  }) | undefined;
  const model = match.probabilityModel as (Match['probabilityModel'] & {
    unifiedPosterior?: { generatedAt?: unknown };
  }) | undefined;
  const odds = match.odds as (Match['odds'] & { updatedAt?: unknown }) | undefined;
  return {
    decisionAt: Math.max(
      instantMs(meta?.decisionGeneratedAt),
      instantMs(meta?.generatedAt),
      instantMs(model?.unifiedPosterior?.generatedAt),
      instantMs(model?.generatedAt)
    ),
    publishedAt: instantMs(meta?.updatedAt),
    oddsAt: Math.max(instantMs(match.oddsUpdatedAt), instantMs(odds?.updatedAt))
  };
};

const isStrictlyNewerPreMatchSnapshot = (current: Partial<Match>, incoming: Partial<Match>) => {
  const currentVersion = preMatchSnapshotVersion(current);
  const incomingVersion = preMatchSnapshotVersion(incoming);
  return incomingVersion.decisionAt > currentVersion.decisionAt
    || (incomingVersion.decisionAt === currentVersion.decisionAt
      && incomingVersion.publishedAt > currentVersion.publishedAt)
    || (incomingVersion.decisionAt === currentVersion.decisionAt
      && incomingVersion.publishedAt === currentVersion.publishedAt
      && incomingVersion.oddsAt > currentVersion.oddsAt);
};

const hasCompleteAtomicPreMatchSnapshot = (match: Partial<Match>) => {
  const record = match as unknown as Record<string, unknown>;
  return ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS.every((field) => {
    const key = String(field);
    if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) return false;
    if (key === 'predictions') return Array.isArray(record[key]);
    return useful(record[key]);
  });
};

const shouldAdoptIncomingPreMatchSnapshot = (current: Match, incoming: Match, now: number) => (
  canonicalStatus(current.effectiveStatus || current.status) === 'SCHEDULED'
  && canonicalStatus(incoming.effectiveStatus || incoming.status) === 'SCHEDULED'
  && isBeforeMatchSaleCutoff(current, now)
  && isBeforeMatchSaleCutoff(incoming, now)
  && hasCompleteAtomicPreMatchSnapshot(incoming)
  && isStrictlyNewerPreMatchSnapshot(current, incoming)
);

const preservePreMatch = (target: Match, preferred: Match, fallback: Match, now = Date.now()) => {
  const mutable = target as unknown as Record<string, unknown>;
  const incomingOwnsSnapshot = shouldAdoptIncomingPreMatchSnapshot(preferred, fallback, now);
  const primary = (incomingOwnsSnapshot ? fallback : preferred) as unknown as Record<string, unknown>;
  const secondary = (incomingOwnsSnapshot ? preferred : fallback) as unknown as Record<string, unknown>;
  PRE_MATCH_FIELDS.forEach((field) => {
    const key = String(field);
    if (incomingOwnsSnapshot && ATOMIC_PRE_MATCH_SNAPSHOT_FIELDS.includes(field)) {
      mutable[key] = primary[key];
      return;
    }
    if (useful(primary[key])) mutable[key] = primary[key];
    else if (useful(secondary[key])) mutable[key] = secondary[key];
  });
  return target;
};

const provisionalResultObservedAtMs = (evidence?: Match['provisionalResult']) => Math.max(
  Date.parse(canonicalInstant(evidence?.latestObservedAt) || '') || 0,
  Date.parse(canonicalInstant(evidence?.observedAt) || '') || 0,
  Date.parse(canonicalInstant(evidence?.firstObservedAt) || '') || 0
);

const validProvisionalResultForMatch = (match: Match, evidence?: Match['provisionalResult']) => {
  if (!evidence) return false;
  if (
    evidence.official !== false
    || evidence.trusted !== false
    || evidence.promotionEligible !== false
    || evidence.provider !== '500.com'
    || !String(evidence.source || '').startsWith('500.com')
    || !Number.isInteger(evidence.scoreHome)
    || Number(evidence.scoreHome) < 0
    || !Number.isInteger(evidence.scoreAway)
    || Number(evidence.scoreAway) < 0
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

const mergeProvisionalResultEvidence = (target: Match, current: Match, incoming: Match) => {
  const candidates = [current.provisionalResult, incoming.provisionalResult]
    .filter((evidence): evidence is NonNullable<Match['provisionalResult']> => (
      validProvisionalResultForMatch(target, evidence)
    ))
    .sort((left, right) => {
      const revisionDelta = Number(left.resultRevision || 0) - Number(right.resultRevision || 0);
      return revisionDelta || provisionalResultObservedAtMs(left) - provisionalResultObservedAtMs(right);
    });
  if (candidates.length) target.provisionalResult = candidates.at(-1);
  else delete target.provisionalResult;
  return target;
};

const clearProvisionalResult = (match: Match) => {
  delete match.provisionalResult;
  return match;
};

export const reconcileMatchLifecycle = (currentMatch: Match, incomingMatch: Match, now = Date.now()): Match => {
  const current = resolveMatchLifecycle(currentMatch, now);
  const incoming = resolveMatchLifecycle(incomingMatch, now);
  if (!sameMatchEvent(currentMatch, incomingMatch)) {
    return { ...current, statusReason: 'incoming-event-mismatch-kept-current' };
  }

  const currentFinal = isTrustedOfficialFinal(current);
  const incomingFinal = isTrustedOfficialFinal(incoming);
  if (currentFinal) {
    const merged = preservePreMatch({ ...incoming, ...current }, current, incoming, now);
    const scoreConflict = incomingFinal
      && (incoming.scoreHome !== current.scoreHome || incoming.scoreAway !== current.scoreAway);
    if (scoreConflict && isStrictlyNewerOfficialCorrection(current, incoming)) {
      return clearProvisionalResult(clearVoidDisposition({
        ...merged,
        scoreHome: incoming.scoreHome,
        scoreAway: incoming.scoreAway,
        postMatchReview: incoming.postMatchReview,
        resultSource: incoming.resultSource,
        resultUpdatedAt: incoming.resultUpdatedAt,
        status: 'FINISHED',
        sourceStatus: 'FINISHED',
        effectiveStatus: 'FINISHED',
        statusReason: 'official-result-correction-accepted',
        resultProvenance: resultProvenance(incoming)
      }));
    }
    if (
      incomingFinal
      && incoming.scoreHome === current.scoreHome
      && incoming.scoreAway === current.scoreAway
      && shouldAcceptIncomingTerminalReview(current, incoming)
    ) {
      merged.postMatchReview = incoming.postMatchReview;
    }
    return clearProvisionalResult(clearVoidDisposition({
      ...merged,
      status: 'FINISHED',
      sourceStatus: 'FINISHED',
      effectiveStatus: 'FINISHED',
      statusReason: scoreConflict
        ? 'official-result-conflict-terminal-preserved'
        : 'terminal-final-preserved',
      resultProvenance: resultProvenance(current)
    }));
  }

  if (incomingFinal) {
    const merged = preservePreMatch({ ...incoming, ...current }, current, incoming, now);
    return clearProvisionalResult(clearVoidDisposition({
      ...merged,
      scoreHome: incoming.scoreHome,
      scoreAway: incoming.scoreAway,
      postMatchReview: incoming.postMatchReview || current.postMatchReview,
      resultSource: incoming.resultSource,
      resultUpdatedAt: incoming.resultUpdatedAt,
      status: 'FINISHED',
      sourceStatus: 'FINISHED',
      effectiveStatus: 'FINISHED',
      statusReason: `official-final-overrode-${current.effectiveStatus?.toLowerCase() || 'unknown'}`,
      resultProvenance: resultProvenance(incoming)
    }));
  }

  const currentVoid = isOfficialSportteryVoid(current);
  const incomingVoid = isOfficialSportteryVoid(incoming);
  if (currentVoid) {
    return clearProvisionalResult(applyOfficialVoid({ ...incoming, ...current }, current, incomingVoid
      ? 'terminal-void-preserved'
      : 'official-void-overrode-stale-lifecycle'));
  }
  if (incomingVoid) {
    return clearProvisionalResult(applyOfficialVoid(
      { ...current, ...incoming },
      incoming,
      'official-void-promoted'
    ));
  }

  const incomingWins = MATCH_STATUS_PRIORITY[incoming.effectiveStatus || incoming.status]
    > MATCH_STATUS_PRIORITY[current.effectiveStatus || current.status];
  const winner = incomingWins ? incoming : current;
  const merged = preservePreMatch({ ...current, ...incoming }, current, incoming, now);
  if (canonicalStatus(incomingMatch.status) === 'FINISHED') {
    if (currentMatch.scoreHome === undefined) delete merged.scoreHome;
    if (currentMatch.scoreAway === undefined) delete merged.scoreAway;
    if (currentMatch.postMatchReview === undefined) delete merged.postMatchReview;
  }
  return mergeProvisionalResultEvidence({
    ...merged,
    status: winner.effectiveStatus || winner.status,
    sourceStatus: winner.sourceStatus,
    effectiveStatus: winner.effectiveStatus || winner.status,
    statusReason: canonicalStatus(incomingMatch.status) === 'FINISHED'
      ? incoming.statusReason
      : winner.statusReason,
    resultProvenance: null
  }, current, incoming);
};

export const isBeforeMatchSaleCutoff = (match: Pick<Match, 'kickoffTime' | 'buyEndTime'>, now = Date.now()) => {
  const kickoffAt = Date.parse(match.kickoffTime || '');
  if (!Number.isFinite(kickoffAt) || now >= kickoffAt) return false;
  const buyEndAt = Date.parse(match.buyEndTime || '');
  return !Number.isFinite(buyEndAt) || now < buyEndAt;
};
