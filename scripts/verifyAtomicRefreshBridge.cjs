const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const {
  readSqliteCurrentTransitionSnapshot,
  readSqliteTransitionMatches,
} = require("../server/sqliteStore.cjs");
const {
  sameEvent,
  reconcileMatchLifecycle: reconcileMatchLifecycleCjs,
} = require("../src/services/matchLifecycle.cjs");

const rootDir = path.join(__dirname, "..");
const checks = [];
const check = (name, ok, details = {}) => {
  checks.push({ name, ok: Boolean(ok), ...details });
};

const trustedFinal = ({ id, kickoffTime, eventVersion = kickoffTime, scoreHome = 2, scoreAway = 1 }) => ({
  id,
  sourceMatchId: id,
  source: "sporttery",
  sourceStatus: "FINISHED",
  status: "FINISHED",
  effectiveStatus: "FINISHED",
  kickoffTime,
  eventVersion,
  homeTeamId: `${id}-home`,
  awayTeamId: `${id}-away`,
  scoreHome,
  scoreAway,
  resultUpdatedAt: new Date(Date.parse(kickoffTime) + 2 * 60 * 60 * 1000).toISOString(),
  resultProvenance: {
    provider: "sporttery",
    source: "sporttery:official-results",
    sourceMatchId: id,
    sourceStatus: "FINISHED",
    official: true,
    trusted: true,
    scoreHome,
    scoreAway,
    kickoffTime,
    eventVersion
  }
});

const scheduled = ({ id, kickoffTime, eventVersion = kickoffTime }) => ({
  id,
  sourceMatchId: id,
  source: "sporttery",
  sourceStatus: "SCHEDULED",
  status: "SCHEDULED",
  effectiveStatus: "SCHEDULED",
  kickoffTime,
  eventVersion,
  homeTeamId: `${id}-home`,
  awayTeamId: `${id}-away`,
  predictions: [{ marketType: "BEST", recommendationAction: "observe" }]
});

const withPreMatchSnapshot = (match, marker, generatedAt, buyEndTime) => ({
  ...match,
  buyEndTime,
  odds: { odds1: marker === "new" ? 1.55 : 1.95, oddsX: 3.2, odds2: 4.1, marker },
  predictions: [{ marketType: "BEST", tipCode: marker === "new" ? "2" : "1", marker }],
  predictionMeta: { generatedAt, updatedAt: generatedAt, marker },
  probabilityModel: { generatedAt, marker },
});

const preMatchSnapshotSignature = (match) => JSON.stringify({
  odds: match?.odds,
  predictions: match?.predictions,
  predictionMeta: match?.predictionMeta,
  probabilityModel: match?.probabilityModel,
});

const run = async () => {
  const moduleUrl = pathToFileURL(path.join(rootDir, "src", "services", "atomicMatchRefresh.ts")).href;
  const { CURRENT_TRANSITION_GRACE_MS, getMatchEventKey, mergeCurrentRefreshSnapshot } = await import(moduleUrl);
  const lifecycleModuleUrl = pathToFileURL(path.join(rootDir, "src", "services", "matchLifecycle.ts")).href;
  const {
    sameMatchEvent,
    reconcileMatchLifecycle: reconcileMatchLifecycleTs,
  } = await import(lifecycleModuleUrl);
  const serverEventModuleUrl = pathToFileURL(path.join(rootDir, "src", "services", "serverEventRefresh.ts")).href;
  const {
    consumeServerEventRefresh,
    createServerEventRefreshState,
    queueServerEventRefresh,
    settleServerEventRefresh,
  } = await import(serverEventModuleUrl);
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const sevenHoursAgo = new Date(now - 7 * 60 * 60 * 1000).toISOString();
  const future = new Date(now + 2 * 60 * 60 * 1000).toISOString();

  const buyEndBeforeKickoff = new Date(now + 90 * 60 * 1000).toISOString();
  const olderPreMatch = {
    ...withPreMatchSnapshot(
      scheduled({ id: "atomic-pre-match", kickoffTime: future }),
      "old",
      new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      buyEndBeforeKickoff
    ),
    // A source-odds clock alone must not make an older model snapshot win.
    oddsUpdatedAt: new Date(now - 30 * 60 * 1000).toISOString(),
  };
  const newerPreMatch = {
    ...withPreMatchSnapshot(
      scheduled({ id: "atomic-pre-match", kickoffTime: future }),
      "new",
      new Date(now - 60 * 60 * 1000).toISOString(),
      buyEndBeforeKickoff
    ),
    oddsUpdatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
  };
  const refreshedPreMatch = mergeCurrentRefreshSnapshot(
    [olderPreMatch],
    [newerPreMatch],
    [],
    { now }
  );
  const refreshedPreMatchMatch = refreshedPreMatch.matches[0];
  check("new current response atomically refreshes all pre-match decision fields", (
    refreshedPreMatch.matches.length === 1
    && refreshedPreMatchMatch?.odds?.marker === "new"
    && refreshedPreMatchMatch?.predictions?.[0]?.marker === "new"
    && refreshedPreMatchMatch?.predictionMeta?.marker === "new"
    && refreshedPreMatchMatch?.probabilityModel?.marker === "new"
  ), { signature: preMatchSnapshotSignature(refreshedPreMatchMatch) });

  const stalePreMatchArrivedLast = mergeCurrentRefreshSnapshot(
    refreshedPreMatch.matches,
    [olderPreMatch],
    [],
    { now }
  );
  check("out-of-order old current response cannot roll back pre-match decision fields", (
    stalePreMatchArrivedLast.matches[0]?.odds?.marker === "new"
    && stalePreMatchArrivedLast.matches[0]?.predictions?.[0]?.marker === "new"
    && stalePreMatchArrivedLast.matches[0]?.predictionMeta?.marker === "new"
    && stalePreMatchArrivedLast.matches[0]?.probabilityModel?.marker === "new"
  ), { signature: preMatchSnapshotSignature(stalePreMatchArrivedLast.matches[0]) });

  const cutoffPassedOld = withPreMatchSnapshot(
    scheduled({ id: "atomic-cutoff", kickoffTime: future }),
    "old",
    new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    new Date(now - 60_000).toISOString()
  );
  const cutoffPassedNew = withPreMatchSnapshot(
    scheduled({ id: "atomic-cutoff", kickoffTime: future }),
    "new",
    new Date(now - 30 * 60 * 1000).toISOString(),
    new Date(now - 60_000).toISOString()
  );
  const terminalOld = withPreMatchSnapshot(
    trustedFinal({ id: "atomic-terminal-freeze", kickoffTime: future }),
    "old",
    new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    buyEndBeforeKickoff
  );
  const terminalNew = withPreMatchSnapshot(
    scheduled({ id: "atomic-terminal-freeze", kickoffTime: future }),
    "new",
    new Date(now - 30 * 60 * 1000).toISOString(),
    buyEndBeforeKickoff
  );
  const preMatchParityCases = [
    { name: "newer-before-cutoff", current: olderPreMatch, incoming: newerPreMatch, marker: "new" },
    { name: "older-after-newer", current: refreshedPreMatchMatch, incoming: olderPreMatch, marker: "new" },
    { name: "post-cutoff-freeze", current: cutoffPassedOld, incoming: cutoffPassedNew, marker: "old" },
    { name: "terminal-freeze", current: terminalOld, incoming: terminalNew, marker: "old" },
  ].map((testCase) => {
    const ts = reconcileMatchLifecycleTs(testCase.current, testCase.incoming, now);
    const cjs = reconcileMatchLifecycleCjs(testCase.current, testCase.incoming, { now });
    return {
      name: testCase.name,
      marker: testCase.marker,
      ts: preMatchSnapshotSignature(ts),
      cjs: preMatchSnapshotSignature(cjs),
      tsMarker: ts?.predictionMeta?.marker,
      cjsMarker: cjs?.predictionMeta?.marker,
    };
  });
  check("TypeScript and CommonJS pre-match snapshot reconciliation stay in parity", preMatchParityCases.every((item) => (
    item.ts === item.cjs && item.tsMarker === item.marker && item.cjsMarker === item.marker
  )), { parityCases: preMatchParityCases });

  const archivedDirection = {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId: "atomic-archive",
    matchId: "atomic-archive",
    kickoffTime: threeHoursAgo,
    eventVersion: threeHoursAgo,
    capturedAt: new Date(Date.parse(threeHoursAgo) - 60 * 60 * 1000).toISOString(),
    cutoffTime: new Date(Date.parse(threeHoursAgo) - 30 * 60 * 1000).toISOString(),
    prediction: {
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "X",
      odds: 3.4,
      recommendationAction: "reference",
    },
  };
  const archivedPending = {
    ...scheduled({ id: "atomic-archive", kickoffTime: threeHoursAgo }),
    status: "PENDING_RESULT",
    effectiveStatus: "PENDING_RESULT",
    archivedPreMatchPrediction: archivedDirection,
  };
  const compactCurrentWithoutArchive = {
    ...scheduled({ id: "atomic-archive", kickoffTime: threeHoursAgo }),
    status: "PENDING_RESULT",
    effectiveStatus: "PENDING_RESULT",
    archivedPreMatchPrediction: null,
  };
  const archiveThenCurrent = mergeCurrentRefreshSnapshot(
    [archivedPending],
    [compactCurrentWithoutArchive],
    [],
    { now }
  );
  const currentThenArchive = mergeCurrentRefreshSnapshot(
    [compactCurrentWithoutArchive],
    [archivedPending],
    [],
    { now }
  );
  check("immutable archived direction survives either current/archive response order", (
    archiveThenCurrent.matches[0]?.archivedPreMatchPrediction?.prediction?.tipCode === "X"
    && currentThenArchive.matches[0]?.archivedPreMatchPrediction?.prediction?.tipCode === "X"
  ), {
    archiveThenCurrent: archiveThenCurrent.matches[0]?.archivedPreMatchPrediction?.prediction?.tipCode || null,
    currentThenArchive: currentThenArchive.matches[0]?.archivedPreMatchPrediction?.prediction?.tipCode || null,
  });

  const previous = scheduled({ id: "atomic-1", kickoffTime: threeHoursAgo });
  const finished = trustedFinal({ id: "atomic-1", kickoffTime: threeHoursAgo });
  const atomic = mergeCurrentRefreshSnapshot([previous], [], [finished], { now });
  check("terminal bridge replaces the missing current row atomically", (
    atomic.matches.length === 1
    && atomic.matches[0].status === "FINISHED"
    && atomic.matches[0].scoreHome === 2
    && atomic.matches[0].scoreAway === 1
  ), { rows: atomic.matches.length, status: atomic.matches[0]?.status || null });
  check("terminal bridge does not inflate currentCount", (
    atomic.currentCount === 0 && atomic.transitionCount === 1
  ), { currentCount: atomic.currentCount, transitionCount: atomic.transitionCount });

  const inFlight = mergeCurrentRefreshSnapshot([previous], [], [], { now });
  check("publication gap retains a recently started fixture", (
    inFlight.matches.length === 1 && inFlight.matches[0].status === "PENDING_RESULT"
  ), { status: inFlight.matches[0]?.status || null });
  const historyArrivedLater = mergeCurrentRefreshSnapshot(inFlight.matches, [], [finished], { now });
  check("history arriving after current closes the retained fixture", (
    historyArrivedLater.matches.length === 1
    && historyArrivedLater.matches[0].status === "FINISHED"
    && historyArrivedLater.matches[0].scoreHome === 2
  ), { status: historyArrivedLater.matches[0]?.status || null });
  const staleCurrentArrivedLast = mergeCurrentRefreshSnapshot(
    historyArrivedLater.matches,
    [previous],
    [],
    { now }
  );
  check("out-of-order stale current response cannot regress a terminal result", (
    staleCurrentArrivedLast.matches.length === 1
    && staleCurrentArrivedLast.matches[0].status === "FINISHED"
    && staleCurrentArrivedLast.matches[0].scoreHome === 2
  ), { status: staleCurrentArrivedLast.matches[0]?.status || null });

  const currentStorageRow = {
    ...scheduled({ id: "current-storage-row", kickoffTime: threeHoursAgo }),
    sourceMatchId: "shared-provider-event",
    homeTeamId: "shared-home",
    awayTeamId: "shared-away"
  };
  const historyStorageRow = {
    ...trustedFinal({ id: "history-storage-row", kickoffTime: threeHoursAgo }),
    sourceMatchId: "shared-provider-event",
    homeTeamId: "shared-home",
    awayTeamId: "shared-away",
    postMatchReview: { generatedAt: new Date(now).toISOString(), predictionReview: { rows: [] } },
    resultProvenance: {
      ...trustedFinal({ id: "history-storage-row", kickoffTime: threeHoursAgo }).resultProvenance,
      sourceMatchId: "shared-provider-event"
    }
  };
  const differentStorageIds = mergeCurrentRefreshSnapshot(
    [currentStorageRow],
    [],
    [historyStorageRow],
    { now }
  );
  check("current and history storage ids collapse into one stable event card", (
    getMatchEventKey(currentStorageRow) === getMatchEventKey(historyStorageRow)
    && differentStorageIds.matches.length === 1
    && differentStorageIds.matches[0].id === currentStorageRow.id
    && differentStorageIds.matches[0].status === "FINISHED"
    && Boolean(differentStorageIds.matches[0].postMatchReview)
  ), {
    rows: differentStorageIds.matches.length,
    retainedId: differentStorageIds.matches[0]?.id || null,
    status: differentStorageIds.matches[0]?.status || null
  });

  let serverEventState = createServerEventRefreshState();
  const firstServerEvent = queueServerEventRefresh(
    serverEventState,
    "sync_completed",
    { datasetRevision: 42 }
  );
  serverEventState = firstServerEvent.state;
  const duplicatePendingServerEvent = queueServerEventRefresh(
    serverEventState,
    "sync_completed_with_warnings",
    { datasetRevision: 42 }
  );
  serverEventState = duplicatePendingServerEvent.state;
  const consumedServerEvent = consumeServerEventRefresh(serverEventState);
  serverEventState = consumedServerEvent.state;
  const duplicateActiveServerEvent = queueServerEventRefresh(
    serverEventState,
    "sync_completed",
    { datasetRevision: 42 }
  );
  serverEventState = settleServerEventRefresh(
    serverEventState,
    consumedServerEvent.refresh,
    true
  );
  const duplicateAppliedServerEvent = queueServerEventRefresh(
    serverEventState,
    "sync_completed",
    { datasetRevision: 42 }
  );
  const nextServerEvent = queueServerEventRefresh(
    serverEventState,
    "sync_completed",
    { datasetRevision: 43 }
  );
  check("one SSE publication revision schedules exactly one atomic refresh", (
    firstServerEvent.shouldSchedule === true
    && duplicatePendingServerEvent.shouldSchedule === false
    && consumedServerEvent.refresh?.revision === "sync:42"
    && consumedServerEvent.refresh?.refreshHistory === true
    && consumedServerEvent.state.lastAppliedRevision === ""
    && consumedServerEvent.state.activeRevision === "sync:42"
    && duplicateActiveServerEvent.shouldSchedule === false
    && serverEventState.lastAppliedRevision === "sync:42"
    && serverEventState.activeRevision === null
    && duplicateAppliedServerEvent.shouldSchedule === false
    && nextServerEvent.shouldSchedule === true
  ), {
    firstScheduled: firstServerEvent.shouldSchedule,
    duplicatePendingScheduled: duplicatePendingServerEvent.shouldSchedule,
    duplicateActiveScheduled: duplicateActiveServerEvent.shouldSchedule,
    duplicateAppliedScheduled: duplicateAppliedServerEvent.shouldSchedule,
    nextScheduled: nextServerEvent.shouldSchedule,
  });

  const failedEventQueued = queueServerEventRefresh(
    serverEventState,
    "sync_completed",
    { datasetRevision: 44 }
  );
  const failedEventConsumed = consumeServerEventRefresh(failedEventQueued.state);
  const failedEventSettled = settleServerEventRefresh(
    failedEventConsumed.state,
    failedEventConsumed.refresh,
    false
  );
  const failedEventRetry = consumeServerEventRefresh(failedEventSettled);
  const retriedEventSettled = settleServerEventRefresh(
    failedEventRetry.state,
    failedEventRetry.refresh,
    true
  );
  check("SSE revision is committed only after refresh success and failure remains retryable", (
    failedEventConsumed.state.lastAppliedRevision === "sync:42"
    && failedEventConsumed.state.activeRevision === "sync:44"
    && failedEventSettled.lastAppliedRevision === "sync:42"
    && failedEventSettled.pendingRevision === "sync:44"
    && failedEventRetry.refresh?.revision === "sync:44"
    && retriedEventSettled.lastAppliedRevision === "sync:44"
    && retriedEventSettled.activeRevision === null
  ), {
    beforeFailure: failedEventConsumed.state,
    afterFailure: failedEventSettled,
    afterRetry: retriedEventSettled
  });

  const utcKickoff = "2026-07-13T02:00:00.000Z";
  const offsetKickoff = "2026-07-13T10:00:00+08:00";
  const timezoneEquivalent = mergeCurrentRefreshSnapshot(
    [trustedFinal({ id: "atomic-timezone", kickoffTime: utcKickoff, eventVersion: utcKickoff })],
    [scheduled({ id: "atomic-timezone", kickoffTime: offsetKickoff, eventVersion: offsetKickoff })],
    [],
    { now }
  );
  check("timezone-equivalent stale current cannot regress a terminal result or clear its score", (
    timezoneEquivalent.matches.length === 1
    && timezoneEquivalent.matches[0].status === "FINISHED"
    && timezoneEquivalent.matches[0].scoreHome === 2
    && timezoneEquivalent.matches[0].scoreAway === 1
  ), {
    status: timezoneEquivalent.matches[0]?.status || null,
    score: `${timezoneEquivalent.matches[0]?.scoreHome ?? "?"}:${timezoneEquivalent.matches[0]?.scoreAway ?? "?"}`
  });

  const auditedFinal = ({ scoreHome, scoreAway, observedAt, resultRevision = null }) => {
    const match = trustedFinal({
      id: "atomic-official-correction",
      kickoffTime: threeHoursAgo,
      scoreHome,
      scoreAway
    });
    return {
      ...match,
      resultUpdatedAt: observedAt,
      resultProvenance: {
        ...match.resultProvenance,
        scoreHome,
        scoreAway,
        observedAt
      },
      postMatchReview: {
        generatedAt: observedAt,
        finalScore: `${scoreHome}-${scoreAway}`,
        predictionReview: { rows: [] },
        ...(resultRevision === null ? {} : {
          settlement: { resultRevision, resultObservedAt: observedAt }
        })
      }
    };
  };
  const firstOfficialFinal = auditedFinal({
    scoreHome: 2,
    scoreAway: 1,
    observedAt: "2026-07-13T11:00:00.000Z",
    resultRevision: 1
  });
  const newerOfficialCorrection = auditedFinal({
    scoreHome: 3,
    scoreAway: 1,
    observedAt: "2026-07-13T11:05:00.000Z",
    resultRevision: 2
  });
  const acceptedOfficialCorrection = mergeCurrentRefreshSnapshot(
    [firstOfficialFinal],
    [],
    [newerOfficialCorrection],
    { now }
  );
  check("strictly newer trusted official resultRevision replaces terminal score and review", (
    acceptedOfficialCorrection.matches.length === 1
    && acceptedOfficialCorrection.matches[0].scoreHome === 3
    && acceptedOfficialCorrection.matches[0].scoreAway === 1
    && acceptedOfficialCorrection.matches[0].postMatchReview?.finalScore === "3-1"
    && acceptedOfficialCorrection.matches[0].postMatchReview?.settlement?.resultRevision === 2
    && acceptedOfficialCorrection.matches[0].statusReason === "official-result-correction-accepted"
  ), {
    score: `${acceptedOfficialCorrection.matches[0]?.scoreHome ?? "?"}:${acceptedOfficialCorrection.matches[0]?.scoreAway ?? "?"}`,
    reviewScore: acceptedOfficialCorrection.matches[0]?.postMatchReview?.finalScore || null,
    statusReason: acceptedOfficialCorrection.matches[0]?.statusReason || null
  });

  const sameRevisionConflict = auditedFinal({
    scoreHome: 4,
    scoreAway: 1,
    observedAt: "2026-07-13T11:10:00.000Z",
    resultRevision: 2
  });
  const rejectedSameRevision = mergeCurrentRefreshSnapshot(
    acceptedOfficialCorrection.matches,
    [],
    [sameRevisionConflict],
    { now }
  );
  check("same or older official resultRevision cannot overwrite a terminal score", (
    rejectedSameRevision.matches[0].scoreHome === 3
    && rejectedSameRevision.matches[0].scoreAway === 1
    && rejectedSameRevision.matches[0].postMatchReview?.settlement?.resultRevision === 2
    && rejectedSameRevision.matches[0].statusReason === "official-result-conflict-terminal-preserved"
  ), {
    score: `${rejectedSameRevision.matches[0]?.scoreHome ?? "?"}:${rejectedSameRevision.matches[0]?.scoreAway ?? "?"}`,
    statusReason: rejectedSameRevision.matches[0]?.statusReason || null
  });

  const unversionedFirst = auditedFinal({
    scoreHome: 1,
    scoreAway: 1,
    observedAt: "2026-07-13T11:00:00.000Z"
  });
  const unversionedNewer = auditedFinal({
    scoreHome: 1,
    scoreAway: 2,
    observedAt: "2026-07-13T11:01:00.000Z"
  });
  const acceptedTimestampCorrection = mergeCurrentRefreshSnapshot(
    [unversionedFirst],
    [],
    [unversionedNewer],
    { now }
  );
  const unversionedSameTime = auditedFinal({
    scoreHome: 5,
    scoreAway: 2,
    observedAt: "2026-07-13T11:01:00.000Z"
  });
  const rejectedSameTimestamp = mergeCurrentRefreshSnapshot(
    acceptedTimestampCorrection.matches,
    [],
    [unversionedSameTime],
    { now }
  );
  check("unversioned correction requires a strictly newer trusted result timestamp", (
    acceptedTimestampCorrection.matches[0].scoreHome === 1
    && acceptedTimestampCorrection.matches[0].scoreAway === 2
    && acceptedTimestampCorrection.matches[0].statusReason === "official-result-correction-accepted"
    && rejectedSameTimestamp.matches[0].scoreHome === 1
    && rejectedSameTimestamp.matches[0].scoreAway === 2
    && rejectedSameTimestamp.matches[0].statusReason === "official-result-conflict-terminal-preserved"
  ), {
    acceptedScore: `${acceptedTimestampCorrection.matches[0]?.scoreHome ?? "?"}:${acceptedTimestampCorrection.matches[0]?.scoreAway ?? "?"}`,
    afterSameTimestamp: `${rejectedSameTimestamp.matches[0]?.scoreHome ?? "?"}:${rejectedSameTimestamp.matches[0]?.scoreAway ?? "?"}`
  });

  const spacedIdentityCurrent = {
    ...scheduled({ id: "identity-current-row", kickoffTime: threeHoursAgo }),
    sourceMatchId: "sporttery_spacing   event",
    homeTeamId: "",
    awayTeamId: "",
    homeTeamName: "Alpha   FC",
    awayTeamName: "Beta  United"
  };
  const spacedIdentityFinal = {
    ...trustedFinal({ id: "identity-history-row", kickoffTime: threeHoursAgo }),
    sourceMatchId: "spacing event",
    homeTeamId: "",
    awayTeamId: "",
    homeTeamName: "Alpha FC",
    awayTeamName: "Beta United",
    resultProvenance: {
      ...trustedFinal({ id: "identity-history-row", kickoffTime: threeHoursAgo }).resultProvenance,
      sourceMatchId: "spacing event"
    }
  };
  const normalizedIdentityMerge = mergeCurrentRefreshSnapshot(
    [spacedIdentityCurrent],
    [],
    [spacedIdentityFinal],
    { now }
  );
  check("event identity canonicalization prevents whitespace variants from producing duplicate React keys", (
    sameMatchEvent(spacedIdentityCurrent, spacedIdentityFinal) === true
    && sameEvent(spacedIdentityCurrent, spacedIdentityFinal) === true
    && getMatchEventKey(spacedIdentityCurrent) === getMatchEventKey(spacedIdentityFinal)
    && normalizedIdentityMerge.matches.length === 1
    && normalizedIdentityMerge.matches[0].status === "FINISHED"
  ), {
    sameTsEvent: sameMatchEvent(spacedIdentityCurrent, spacedIdentityFinal),
    sameCjsEvent: sameEvent(spacedIdentityCurrent, spacedIdentityFinal),
    rows: normalizedIdentityMerge.matches.length,
    keys: normalizedIdentityMerge.matches.map(getMatchEventKey)
  });

  const parityCases = [
    {
      name: "equivalent timezone instants",
      left: scheduled({ id: "parity-timezone", kickoffTime: utcKickoff, eventVersion: utcKickoff }),
      right: scheduled({ id: "parity-timezone", kickoffTime: offsetKickoff, eventVersion: offsetKickoff }),
      expected: true
    },
    {
      name: "normalized opaque event versions",
      left: scheduled({ id: "parity-opaque", kickoffTime: future, eventVersion: " Fixture   Revision A " }),
      right: scheduled({ id: "parity-opaque", kickoffTime: future, eventVersion: "fixture revision a" }),
      expected: true
    },
    {
      name: "different opaque event versions",
      left: scheduled({ id: "parity-revision", kickoffTime: future, eventVersion: "fixture-revision-a" }),
      right: scheduled({ id: "parity-revision", kickoffTime: future, eventVersion: "fixture-revision-b" }),
      expected: false
    },
    {
      name: "different kickoff instants",
      left: scheduled({ id: "parity-kickoff", kickoffTime: utcKickoff, eventVersion: utcKickoff }),
      right: scheduled({ id: "parity-kickoff", kickoffTime: future, eventVersion: future }),
      expected: false
    }
  ];
  const parityResults = parityCases.map((testCase) => ({
    name: testCase.name,
    expected: testCase.expected,
    ts: sameMatchEvent(testCase.left, testCase.right),
    cjs: sameEvent(testCase.left, testCase.right)
  }));
  check("TypeScript and CommonJS event identity stay in parity", parityResults.every((item) => (
    item.ts === item.cjs && item.ts === item.expected
  )), { parityResults });

  const expired = mergeCurrentRefreshSnapshot([
    scheduled({ id: "atomic-expired", kickoffTime: sevenHoursAgo })
  ], [], [], { now });
  check("transition grace is bounded", (
    CURRENT_TRANSITION_GRACE_MS === 6 * 60 * 60 * 1000 && expired.matches.length === 0
  ), { graceMs: CURRENT_TRANSITION_GRACE_MS, rows: expired.matches.length });

  const futureMissing = mergeCurrentRefreshSnapshot([
    scheduled({ id: "atomic-future", kickoffTime: future })
  ], [], [], { now });
  check("missing future fixture remains authoritative-current removal", futureMissing.matches.length === 0, {
    rows: futureMissing.matches.length
  });

  const untrusted = {
    ...trustedFinal({ id: "atomic-untrusted", kickoffTime: threeHoursAgo }),
    resultProvenance: { provider: "fallback", official: false, trusted: false }
  };
  const rejected = mergeCurrentRefreshSnapshot([], [], [untrusted], { now });
  check("untrusted FINISHED bridge is rejected", (
    rejected.matches.length === 0 && rejected.transitionCount === 0
  ), { rows: rejected.matches.length, transitionCount: rejected.transitionCount });

  const current = scheduled({ id: "atomic-current", kickoffTime: future });
  const extraFinal = trustedFinal({ id: "atomic-history", kickoffTime: threeHoursAgo });
  const counted = mergeCurrentRefreshSnapshot([], [current], [extraFinal], { now });
  check("current and transition row accounting stays separate", (
    counted.matches.length === 2 && counted.currentCount === 1 && counted.transitionCount === 1
  ), { rows: counted.matches.length, currentCount: counted.currentCount, transitionCount: counted.transitionCount });

  const samePublicationBatchSize = 20;
  const samePublicationPrevious = Array.from({ length: samePublicationBatchSize }, (_, index) => {
    const kickoffTime = new Date(now - (2 * 60 * 60 * 1000) - index * 60_000).toISOString();
    return scheduled({ id: `atomic-batch-${index}`, kickoffTime });
  });
  const samePublicationFinals = samePublicationPrevious.map((match, index) => trustedFinal({
    id: match.id,
    kickoffTime: match.kickoffTime,
    scoreHome: index % 4,
    scoreAway: (index + 1) % 3,
  }));
  const samePublicationMerged = mergeCurrentRefreshSnapshot(
    samePublicationPrevious,
    [],
    samePublicationFinals,
    { now }
  );
  const samePublicationIds = new Set(samePublicationMerged.matches.map((match) => match.id));
  check("a 20-match result publication closes every prior card in one atomic merge", (
    samePublicationMerged.matches.length === samePublicationBatchSize
    && samePublicationMerged.currentCount === 0
    && samePublicationMerged.transitionCount === samePublicationBatchSize
    && samePublicationMerged.matches.every((match) => match.status === "FINISHED")
    && samePublicationFinals.every((match) => samePublicationIds.has(match.id))
  ), {
    rows: samePublicationMerged.matches.length,
    currentCount: samePublicationMerged.currentCount,
    transitionCount: samePublicationMerged.transitionCount,
  });

  const oldKickoff = threeHoursAgo;
  const rescheduledKickoff = future;
  const rescheduled = mergeCurrentRefreshSnapshot(
    [],
    [scheduled({ id: "atomic-rescheduled", kickoffTime: rescheduledKickoff })],
    [trustedFinal({ id: "atomic-rescheduled", kickoffTime: oldKickoff })],
    { now }
  );
  check("stale terminal bridge cannot overwrite a rescheduled event", (
    rescheduled.matches.length === 1
    && rescheduled.matches[0].status === "SCHEDULED"
    && rescheduled.matches[0].kickoffTime === rescheduledKickoff
  ), { status: rescheduled.matches[0]?.status || null, kickoffTime: rescheduled.matches[0]?.kickoffTime || null });

  const authoritativeReschedule = mergeCurrentRefreshSnapshot(
    [trustedFinal({ id: "atomic-reschedule-replace", kickoffTime: oldKickoff })],
    [scheduled({ id: "atomic-reschedule-replace", kickoffTime: rescheduledKickoff })],
    [],
    { now }
  );
  check("a genuinely different current event replaces the old terminal fixture", (
    authoritativeReschedule.matches.length === 1
    && authoritativeReschedule.matches[0].status === "SCHEDULED"
    && authoritativeReschedule.matches[0].kickoffTime === rescheduledKickoff
    && !Object.prototype.hasOwnProperty.call(authoritativeReschedule.matches[0], "scoreHome")
    && !Object.prototype.hasOwnProperty.call(authoritativeReschedule.matches[0], "scoreAway")
  ), {
    status: authoritativeReschedule.matches[0]?.status || null,
    kickoffTime: authoritativeReschedule.matches[0]?.kickoffTime || null
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-delayed-transition-"));
  try {
    const dbPath = path.join(tempDir, "football.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE match_snapshots (
        id TEXT PRIMARY KEY, dataset TEXT NOT NULL, match_id TEXT,
        source_match_id TEXT, kickoff_time TEXT, status TEXT, payload TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
    `);
    for (let index = 0; index < 40; index += 1) {
      const kickoffTime = new Date(now - index * 60_000).toISOString();
      const match = trustedFinal({ id: `recent-${index}`, kickoffTime });
      insert.run(`history:${match.id}`, match.id, match.sourceMatchId, kickoffTime, JSON.stringify(match));
    }
    const delayedKickoff = new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString();
    const delayed = trustedFinal({ id: "delayed-final", kickoffTime: delayedKickoff });
    insert.run(`history:${delayed.id}`, delayed.id, delayed.sourceMatchId, delayedKickoff, JSON.stringify(delayed));
    const sqliteBatch = Array.from({ length: samePublicationBatchSize }, (_, index) => {
      const kickoffTime = new Date(now - (2 * 60 * 60 * 1000) - index * 60_000).toISOString();
      return trustedFinal({
        id: `sqlite-batch-${index}`,
        kickoffTime,
        scoreHome: index % 4,
        scoreAway: (index + 2) % 3,
      });
    });
    const reusedSourceOldEvent = trustedFinal({
      id: sqliteBatch[0].id,
      kickoffTime: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
      scoreHome: 1,
      scoreAway: 0,
    });
    insert.run(
      `history:${reusedSourceOldEvent.id}:old-event`,
      reusedSourceOldEvent.id,
      reusedSourceOldEvent.sourceMatchId,
      reusedSourceOldEvent.kickoffTime,
      JSON.stringify(reusedSourceOldEvent)
    );
    for (const match of sqliteBatch) {
      insert.run(`history:${match.id}`, match.id, match.sourceMatchId, match.kickoffTime, JSON.stringify(match));
    }
    db.prepare("INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run("fast_result_revision", "7", new Date(now).toISOString());
    db.close();

    const exactSourceMatchIds = [delayed.sourceMatchId, ...sqliteBatch.map((match) => match.sourceMatchId)];
    const transitionRows = await readSqliteTransitionMatches(dbPath, {
      sourceMatchIds: exactSourceMatchIds,
      limit: 64,
    });
    const snapshot = await readSqliteCurrentTransitionSnapshot(dbPath, {
      sourceMatchIds: exactSourceMatchIds,
      limit: 64,
    });
    const transitionSourceIds = new Set(transitionRows.map((match) => match.sourceMatchId));
    const snapshotTransitionSourceIds = new Set(snapshot.transitionRows.map((match) => match.sourceMatchId));
    const reusedSourceRows = transitionRows.filter((match) => match.sourceMatchId === sqliteBatch[0].sourceMatchId);
    check("delayed final bypasses kickoff top-32 through exact id and rowid bridge", (
      transitionRows[0]?.sourceMatchId === delayed.sourceMatchId
      && snapshot.available === true
      && snapshot.currentRows.length === 0
      && snapshot.transitionRows[0]?.sourceMatchId === delayed.sourceMatchId
      && snapshot.meta.fast_result_revision?.value === "7"
    ), {
      firstSourceMatchId: transitionRows[0]?.sourceMatchId || null,
      currentRows: snapshot.currentRows.length,
    });
    check("SQLite transition query preserves every row in a 20-match publication batch", (
      sqliteBatch.every((match) => transitionSourceIds.has(match.sourceMatchId))
      && sqliteBatch.every((match) => snapshotTransitionSourceIds.has(match.sourceMatchId))
      && transitionRows.length >= samePublicationBatchSize
      && snapshot.transitionRows.length >= samePublicationBatchSize
    ), {
      expectedRows: samePublicationBatchSize,
      transitionRows: transitionRows.length,
      snapshotTransitionRows: snapshot.transitionRows.length,
    });
    check("exact-source transition order puts the newly inserted event before an older reused id", (
      reusedSourceRows.length === 2
      && sameEvent(reusedSourceRows[0], sqliteBatch[0])
      && !sameEvent(reusedSourceRows[0], reusedSourceRows[1])
    ), {
      reusedSourceRows: reusedSourceRows.length,
      firstEventVersion: reusedSourceRows[0]?.eventVersion || null,
      expectedEventVersion: sqliteBatch[0].eventVersion,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
  const currentPayloadStart = serverSource.indexOf("const buildV1CurrentPayload = async (url) => {");
  const currentPayloadEnd = serverSource.indexOf("\nconst buildV1HistoryPayload = async (url) => {", currentPayloadStart);
  const currentPayloadSource = currentPayloadStart >= 0 && currentPayloadEnd > currentPayloadStart
    ? serverSource.slice(currentPayloadStart, currentPayloadEnd)
    : "";
  const appContextSource = fs.readFileSync(path.join(rootDir, "src", "context", "AppContext.tsx"), "utf8");
  const appSource = fs.readFileSync(path.join(rootDir, "src", "App.tsx"), "utf8");
  const predictionsSource = fs.readFileSync(path.join(rootDir, "src", "pages", "PredictionsList.tsx"), "utf8");
  const matchSummaryRowSource = fs.readFileSync(path.join(rootDir, "src", "components", "predictions", "MatchSummaryRow.tsx"), "utf8");
  check("current API builds an opt-in capped compact history bridge", [
    "currentTransitionRowLimit",
    "CURRENT_TRANSITION_DEFAULT_ROWS = 16",
    "CURRENT_TRANSITION_MAX_ROWS = 32",
    "effectiveCurrentTransitionRowLimit",
    "currentFastPublicationObservations",
    'url.searchParams.get("transition") === "1"',
    "readHistoryMatchesForListDetailed",
    ".map(compactHistoryMatchForList)",
    "const identity = match?.sourceMatchId",
    "transitionRows,",
    'version: "current-history-transition-v1"',
    "!currentIds.has(match?.id)"
  ].every((needle) => serverSource.includes(needle)));
  const atomicTransitionDetailIndex = currentPayloadSource.indexOf('"postgres-atomic" : "sqlite-atomic"');
  const deferredGenerationDetailIndex = currentPayloadSource.indexOf("-transition-deferred`");
  const legacyTransitionFallbackIndex = currentPayloadSource.indexOf("readHistoryMatchesForListDetailed(transitionRowLimit)");
  check("atomic PostgreSQL/SQLite transition snapshot bypasses immutable history JSON", (
    /\? atomicSqliteSnapshot\.available\s+\? Promise\.resolve\(\{ source: shouldPreferPostgresRead\(\) \? "postgres-atomic" : "sqlite-atomic", rows: \[\] \}\)/.test(currentPayloadSource)
    && /\? Promise\.resolve\(atomicSqliteSnapshot\.transitionRows\)/.test(currentPayloadSource)
    && atomicTransitionDetailIndex >= 0
    && deferredGenerationDetailIndex > atomicTransitionDetailIndex
    && legacyTransitionFallbackIndex > deferredGenerationDetailIndex
    && !currentPayloadSource.includes('readPublicationJson(basePublication, "matches-history.json", [])')
  ), {
    currentPayloadFound: currentPayloadSource.length > 0,
    atomicTransitionDetailIndex,
    deferredGenerationDetailIndex,
    legacyTransitionFallbackIndex,
    immutableHistoryParseInCurrentPayload: currentPayloadSource.includes(
      'readPublicationJson(basePublication, "matches-history.json", [])'
    ),
  });
  check("current API cache varies on history freshness", (
    serverSource.includes('syncMetaFreshness(meta, "history") || ""')
    && serverSource.includes('syncMetaLaneStale(meta, "history") ? "history-stale" : "history-fresh"')
    && serverSource.includes('`fast-batch:${fastBatchCacheToken}`')
  ));
  check("current API version and notModified use current plus transition freshness", (
    serverSource.includes("latestIsoTime(currentSourceUpdatedAt, transitionSourceUpdatedAt)")
    && serverSource.includes("meta?.fastResultPublication?.publishedAt")
    && serverSource.includes("const revisionToken = Math.max(")
    && serverSource.includes("&& revisionMatches")
    && serverSource.includes('sqliteFreshEnough(sqliteStatus, "currentMatches", 0)')
  ));
  check("AppContext commits current and bridge rows together", (
    appContextSource.includes("const transitionRows = transitionRowsFromPayload(data)")
    && appContextSource.includes("&transition=1")
    && appContextSource.includes("setMatches((current) => mergeCurrentRefreshSnapshot(")
    && appContextSource.includes("return rows.length;")
  ));
  check("AppContext keeps the rendered current publication count authoritative", (
    appContextSource.includes("currentCount: current.currentCount")
    && appContextSource.includes("totalCount: current.currentCount + Math.max(current.historyCount, metaHistoryCount ?? 0)")
    && !appContextSource.includes("currentCount: metaCurrentCount ?? current.currentCount")
  ));
  check("AppContext coalesces overlapping SSE, focus and poll refreshes", (
    appContextSource.includes("let currentRequestInFlight: Promise<boolean> | null = null")
    && appContextSource.includes("let currentRefreshQueued = false")
    && appContextSource.includes("if (currentRequestInFlight)")
    && appContextSource.includes("currentRefreshQueued = true")
    && appContextSource.includes("currentLoading: isInitial && !current.currentLoaded")
  ));
  check("SSE refreshes are deduplicated by publication revision", (
    appContextSource.includes("createServerEventRefreshState()")
    && appContextSource.includes("queueServerEventRefresh(serverEventRefreshState, type, payload)")
    && appContextSource.includes("consumeServerEventRefresh(serverEventRefreshState)")
    && appContextSource.includes("settleServerEventRefresh(")
    && appContextSource.includes("const [currentSucceeded, historySucceeded] = await Promise.all([")
    && appContextSource.includes("refreshFromServerEvent(eventType as RefreshableServerEventType, payload)")
  ));
  check("prediction cards use event identity and preserve the visible scroll anchor", (
    predictionsSource.includes("key={matchEventKey}")
    && predictionsSource.includes("eventKey={matchEventKey}")
    && matchSummaryRowSource.includes("data-match-event-key={eventKey}")
    && predictionsSource.includes("refreshScrollAnchorRef")
    && predictionsSource.includes("window.scrollBy({ top: delta")
  ));
  check("background refresh and detail return preserve list query state and position", (
    predictionsSource.includes("readStoredListViewState(viewMode)")
    && predictionsSource.includes("window.sessionStorage.setItem(listViewStorageKey(viewMode)")
    && predictionsSource.includes("restoredViewState?.selectedDate")
    && predictionsSource.includes("restoredViewState?.selectedLeagues")
    && predictionsSource.includes("listReturnScrollKey(viewMode)")
    && predictionsSource.includes("window.scrollTo({ top:")
    && appSource.includes("`football.listReturnScroll.${location.pathname}`")
    && appSource.includes("if (!location.pathname.startsWith('/match/')) return")
    && appSource.includes("window.scrollTo({ top: 0, left: 0, behavior: 'auto' })")
    && appSource.includes("if (routeState?.openedFromList)")
    && appSource.includes("navigate(-1)")
  ));

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    summary: { checks: checks.length, failed: failed.length },
    checks
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
};

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
