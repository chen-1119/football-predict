export type RefreshableServerEventType =
  | 'sync_completed'
  | 'sync_completed_with_warnings'
  | 'sync_failed'
  | 'gpt_prediction_completed'
  | 'gpt_prediction_completed_with_warnings';

export type ServerEventPayload = Record<string, unknown>;

export interface ServerEventRefreshState {
  lastAppliedRevision: string;
  activeRevision: string | null;
  pendingRevision: string;
  pendingType: RefreshableServerEventType | '';
  pendingNeedsHistory: boolean;
}

export interface PendingServerRefresh {
  type: RefreshableServerEventType;
  revision: string;
  refreshHistory: boolean;
}

export const createServerEventRefreshState = (): ServerEventRefreshState => ({
  lastAppliedRevision: '',
  activeRevision: null,
  pendingRevision: '',
  pendingType: '',
  pendingNeedsHistory: false
});

export const getServerEventRevision = (
  type: RefreshableServerEventType,
  payload: ServerEventPayload
) => {
  const revisionValue = payload.datasetRevision
    || payload.sourceCycleId
    || payload.publishedAt
    || payload.finishedAt
    || payload.id;
  if (!revisionValue) return '';
  const revisionScope = type.startsWith('sync_') ? 'sync' : type;
  return `${revisionScope}:${String(revisionValue)}`;
};

const needsHistoryRefresh = (type: RefreshableServerEventType) => (
  type === 'sync_completed' || type === 'sync_completed_with_warnings'
);

export const queueServerEventRefresh = (
  state: ServerEventRefreshState,
  type: RefreshableServerEventType,
  payload: ServerEventPayload
): { state: ServerEventRefreshState; shouldSchedule: boolean } => {
  const revision = getServerEventRevision(type, payload);
  const refreshHistory = needsHistoryRefresh(type);
  if (revision && revision === state.lastAppliedRevision) {
    return { state, shouldSchedule: false };
  }
  if (revision && revision === state.activeRevision) {
    return { state, shouldSchedule: false };
  }
  if (revision && revision === state.pendingRevision) {
    return {
      state: {
        ...state,
        pendingType: type,
        pendingNeedsHistory: state.pendingNeedsHistory || refreshHistory
      },
      shouldSchedule: false
    };
  }

  return {
    state: {
      ...state,
      pendingRevision: revision,
      pendingType: type,
      pendingNeedsHistory: state.pendingNeedsHistory || refreshHistory
    },
    shouldSchedule: true
  };
};

export const consumeServerEventRefresh = (
  state: ServerEventRefreshState
): { state: ServerEventRefreshState; refresh: PendingServerRefresh | null } => {
  if (state.activeRevision !== null || !state.pendingType) return { state, refresh: null };
  const refresh = {
    type: state.pendingType,
    revision: state.pendingRevision,
    refreshHistory: state.pendingNeedsHistory
  };
  return {
    state: {
      ...state,
      activeRevision: state.pendingRevision,
      pendingRevision: '',
      pendingType: '',
      pendingNeedsHistory: false
    },
    refresh
  };
};

/**
 * A revision becomes applied only after every lane requested by the event has
 * refreshed successfully. Failed work is coalesced back into the pending slot;
 * a newer pending revision supersedes it while inheriting its history need.
 */
export const settleServerEventRefresh = (
  state: ServerEventRefreshState,
  refresh: PendingServerRefresh,
  applied: boolean
): ServerEventRefreshState => {
  if (state.activeRevision !== refresh.revision) return state;

  const nextState: ServerEventRefreshState = {
    ...state,
    lastAppliedRevision: applied && refresh.revision
      ? refresh.revision
      : state.lastAppliedRevision,
    activeRevision: null
  };
  if (applied) return nextState;

  if (nextState.pendingType) {
    return {
      ...nextState,
      pendingNeedsHistory: nextState.pendingNeedsHistory || refresh.refreshHistory
    };
  }

  return {
    ...nextState,
    pendingRevision: refresh.revision,
    pendingType: refresh.type,
    pendingNeedsHistory: refresh.refreshHistory
  };
};
