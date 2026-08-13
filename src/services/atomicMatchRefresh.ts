import type { Match } from './mockData.ts';
import {
  eventVersionOf,
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
  sameMatchEvent
} from './matchLifecycle.ts';

// Covers the small publication window between the current lane removing a
// fixture and the history lane exposing its official result. The source keeps
// unresolved rows much longer; this browser-only grace is deliberately short.
export const CURRENT_TRANSITION_GRACE_MS = 6 * 60 * 60 * 1000;

const normalizeIdentityPart = (value: unknown) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const getMatchSourceKey = (match: Partial<Match>) => normalizeIdentityPart(
  match.sourceMatchId || match.id
).replace(/^sporttery[_:-]/, '');

/**
 * Stable browser identity for one concrete fixture. Current/history payloads
 * can use different row ids for the same event, while a provider match id can
 * be reused after a reschedule. The event anchor and teams keep both cases
 * distinct without tying React state to a storage-row id.
 */
export const getMatchEventKey = (match: Partial<Match>) => {
  const sourceKey = getMatchSourceKey(match);
  const eventAnchor = normalizeIdentityPart(eventVersionOf(match) || match.kickoffTime);
  const homeKey = normalizeIdentityPart(match.homeTeamId || match.homeTeamName);
  const awayKey = normalizeIdentityPart(match.awayTeamId || match.awayTeamName);
  return [sourceKey || 'unknown-source', eventAnchor || 'unknown-event', homeKey, awayKey].join('|');
};

export const mergeMatches = (
  baseMatches: Match[],
  nextMatches: Match[],
  options: { preferIncomingEvent?: boolean; now?: number } = {}
) => {
  const now = options.now ?? Date.now();
  const merged: Match[] = [];

  baseMatches.forEach((match) => {
    const resolved = resolveMatchLifecycle(match, now);
    const existingIndex = merged.findIndex((existing) => sameMatchEvent(existing, resolved));
    if (existingIndex >= 0) {
      merged[existingIndex] = reconcileMatchLifecycle(merged[existingIndex], resolved, now);
    } else {
      merged.push(resolved);
    }
  });

  nextMatches.forEach((match) => {
    const incoming = resolveMatchLifecycle(match, now);
    const existingIndex = merged.findIndex((existing) => sameMatchEvent(existing, incoming));
    if (existingIndex >= 0) {
      merged[existingIndex] = reconcileMatchLifecycle(merged[existingIndex], incoming, now);
      return;
    }

    if (options.preferIncomingEvent) {
      const sourceKey = getMatchSourceKey(incoming);
      const replacedEventIndex = sourceKey
        ? merged.findIndex((existing) => getMatchSourceKey(existing) === sourceKey)
        : -1;
      if (replacedEventIndex >= 0) {
        merged[replacedEventIndex] = incoming;
        return;
      }
    }

    merged.push(incoming);
  });

  return merged.sort((a, b) => (
    new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime()
  ));
};

const eventKeySet = (matches: Match[]) => new Set(matches.map(getMatchEventKey));

const containsSameEvent = (keys: ReadonlySet<string>, match: Match) => (
  keys.has(getMatchEventKey(match))
);

export const retainFinishedHistoryMatches = (
  matches: Match[],
  currentLaneIds: ReadonlySet<string> = new Set<string>()
) => matches
  .map((match) => resolveMatchLifecycle(match))
  .filter((match) => match.status === 'FINISHED' && !currentLaneIds.has(match.id));

const shouldRetainAwaitingTransition = (match: Match, now: number, graceMs: number) => {
  if (match.status === 'FINISHED') return false;
  const kickoffAt = Date.parse(match.kickoffTime || '');
  return Number.isFinite(kickoffAt)
    && kickoffAt <= now
    && now - kickoffAt <= graceMs;
};

export type CurrentRefreshSnapshot = {
  matches: Match[];
  currentCount: number;
  transitionCount: number;
};

/**
 * Applies the authoritative current rows and trusted terminal bridge rows in
 * one state value. Transition rows never contribute to currentCount and an
 * untrusted/invalid FINISHED claim is rejected by resolveMatchLifecycle.
 */
export const mergeCurrentRefreshSnapshot = (
  previousMatches: Match[],
  currentRows: Match[],
  transitionRows: Match[],
  options: { now?: number; graceMs?: number } = {}
): CurrentRefreshSnapshot => {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? CURRENT_TRANSITION_GRACE_MS;
  const safeCurrentRows = currentRows.filter((match) => match && typeof match.id === 'string');
  const safeTransitionRows = transitionRows
    .filter((match) => match && typeof match.id === 'string')
    .map((match) => resolveMatchLifecycle(match, now))
    .filter((match) => match.status === 'FINISHED');
  const compatibleTransitionRows = safeTransitionRows.filter((transitionMatch) => {
    const sourceKey = getMatchSourceKey(transitionMatch);
    if (!sourceKey) return true;
    return !safeCurrentRows.some((currentMatch) => (
      getMatchSourceKey(currentMatch) === sourceKey
      && !sameMatchEvent(currentMatch, transitionMatch)
    ));
  });
  const currentEventKeys = eventKeySet(safeCurrentRows);
  const transitionEventKeys = eventKeySet(compatibleTransitionRows);

  const baseMatches = previousMatches
    .map((match) => resolveMatchLifecycle(match, now))
    .filter((match) => (
      containsSameEvent(currentEventKeys, match)
      || containsSameEvent(transitionEventKeys, match)
      || match.status === 'FINISHED'
      || shouldRetainAwaitingTransition(match, now, graceMs)
    ));

  const withCurrent = mergeMatches(baseMatches, safeCurrentRows, {
    preferIncomingEvent: true,
    now
  });
  const matches = mergeMatches(withCurrent, compatibleTransitionRows, { now });

  return {
    matches,
    currentCount: safeCurrentRows.length,
    transitionCount: compatibleTransitionRows.length
  };
};
