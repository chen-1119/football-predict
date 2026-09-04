const fs = require('node:fs');
const path = require('node:path');
const { buildPredictionReviewRows } = require('./syncData.cjs');

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
const list = read('src/pages/PredictionsList.tsx');
const detail = read('src/pages/MatchDetail.tsx');
const predictionInsight = read('src/services/predictionInsight.ts');
const displayRecommendation = read('src/services/displayRecommendation.ts');
const appContext = read('src/context/AppContext.tsx');
const atomicRefresh = read('src/services/atomicMatchRefresh.ts');
const serverEventRefresh = read('src/services/serverEventRefresh.ts');
const syncData = read('scripts/syncData.cjs');
const server = read('server/index.cjs');
const archivedPreMatchPrediction = read('src/services/archivedPreMatchPrediction.ts');
const predictionsCss = read('src/styles/predictions.css');
const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const hasAll = (source, values) => values.every((value) => source.includes(value));

const currentValidatorStart = appContext.indexOf('const assertFreshCurrentMatches =');
const currentValidatorEnd = appContext.indexOf('const normalizeApiBase =', currentValidatorStart);
const currentValidatorSource = appContext.slice(currentValidatorStart, currentValidatorEnd);
const applyDataStart = appContext.indexOf('const applyData =');
const applyDataEnd = appContext.indexOf('const runCurrentRequest =', applyDataStart);
const applyDataSource = appContext.slice(applyDataStart, applyDataEnd);

check('empty current payload is a valid authoritative snapshot', hasAll(currentValidatorSource, [
  'if (rows.length === 0) return;',
  'current payload is not a match array'
]) && !currentValidatorSource.includes('current payload is empty'));

check('current lane atomically merges terminal bridge rows with bounded publication-gap retention', hasAll(atomicRefresh, [
  'const shouldRetainAwaitingTransition =',
  "match.status === 'FINISHED'",
  'now - kickoffAt <= graceMs',
  "filter((match) => match.status === 'FINISHED')",
  'const withCurrent = mergeMatches(baseMatches, safeCurrentRows',
  'const matches = mergeMatches(withCurrent, compatibleTransitionRows'
]) && hasAll(applyDataSource, [
  'const transitionRows = transitionRowsFromPayload(data)',
  'setMatches((current) => mergeCurrentRefreshSnapshot(',
  'return rows.length;'
]));

check('successful empty current response completes the current lane', appContext.includes('currentLoaded: true,'));

check('initial transient cutover retains a short-lived session snapshot without weakening access control', hasAll(appContext, [
  "const RETAINED_CURRENT_SNAPSHOT_KEY = 'football.currentSnapshot.v1'",
  'const RETAINED_CURRENT_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000',
  'window.sessionStorage.setItem(RETAINED_CURRENT_SNAPSHOT_KEY',
  'window.sessionStorage.removeItem(RETAINED_CURRENT_SNAPSHOT_KEY)',
  'const retainedSessionIdentity = (session: AccessSession | null | undefined)',
  'retainedSessionIdentity(snapshot.session as AccessSession) !== sessionIdentity',
  'isAccessSessionValid(accessSession || null, now)',
  'isRetainableCurrentPayload(snapshot.data)',
  'invalidatesRetainedSnapshot(error)',
  '/\\bHTTP (401|403|410)\\b/',
  'const retainedSnapshot = isInitial && transientFailure',
  "dataChannel: 'retained'",
  'serviceTransitioning: true',
  'retainCurrentSnapshot(dataResult.data, activeAccessSession)',
  'clearRetainedCurrentSnapshot();'
]) && !appContext.includes("localStorage.setItem(RETAINED_CURRENT_SNAPSHOT_KEY"));

const authPrimeStart = appContext.indexOf('const primeAuthenticatedCurrentSnapshot = async');
const authPrimeEnd = appContext.indexOf('const normalizeApiBase =', authPrimeStart);
const authPrimeSource = appContext.slice(authPrimeStart, authPrimeEnd);
const newSessionPrime = appContext.indexOf('await primeAuthenticatedCurrentSnapshot(session);');
check('successful access verification performs a bounded current-lane warm-up before routing', hasAll(authPrimeSource, [
  "buildApiUrl('/api/v1/matches/current?view=list')",
  'fetchJsonOnce<unknown>(url, session.token, controller.signal)',
  "assertFreshCurrentMatches(data, { url, channel: 'api' })",
  'retainCurrentSnapshot(data, session)',
  '() => controller.abort()',
  'return false;'
]) && appContext.includes('const AUTH_CURRENT_PREFETCH_TIMEOUT_MS = 1200')
  && newSessionPrime > appContext.indexOf('persistAccessSession(session);')
  && newSessionPrime < appContext.indexOf('setAccessSession(session);', newSessionPrime));

const protectedAuthInvalidations = appContext.match(/invalidateActiveAccessSession\(error\)/g) || [];
const newSessionStart = appContext.indexOf('const session = payload.session as AccessSession;');
const newSessionPersist = appContext.indexOf('persistAccessSession(session);', newSessionStart);
const nextSessionClear = appContext.indexOf('clearRetainedCurrentSnapshot();', newSessionStart);
check('current history and SSE share fail-closed protected-session invalidation', hasAll(appContext, [
  'const invalidateActiveAccessSession = (error: unknown)',
  'jsonResponseCache.clear();',
  'effectRequestController.abort();',
  'setMatches([]);',
  'setDataSync(emptyDataSyncState());',
  '}, [isAccessVerified, accessSession]);'
]) && protectedAuthInvalidations.length >= 3
  && newSessionPersist > newSessionStart
  && (nextSessionClear < 0 || newSessionPersist < nextSessionClear));

check('retained cutover state is exposed for browser-visible verification', hasAll(list, [
  "data-data-channel={dataSync.dataChannel || ''}",
  'data-service-transitioning={String(Boolean(dataSync.serviceTransitioning))}',
  "data-retained-data-at={dataSync.retainedDataAt || ''}"
]));

check('transient current failures retry in three seconds and return to the configured steady cadence', hasAll(appContext, [
  'const TRANSIENT_CURRENT_REFRESH_MS = 3 * 1000',
  'const setCurrentRefreshCadence = (',
  'const nextRefreshMs = transientFailure',
  'const refreshIntervalSeconds = setCurrentRefreshCadence(transientFailure);',
  'currentRefreshHealthy: false,',
  'currentRefreshHealthy: true,',
  'if (!cancelled) scheduleCurrentRefresh();'
]));

check('cutover recovery probes only the authoritative current lane and throttle SSE replay', hasAll(appContext, [
  'const recoveryProbeOnly = refreshMsRef.current === TRANSIENT_CURRENT_REFRESH_MS;',
  'const diagnosticDue = (',
  'if (recoveryProbeOnly) return false;',
  "const metaPromise = diagnosticDue('syncMeta', SYNC_META_REFRESH_MS) ? fetchSyncMeta() : null;",
  "const sourceHealthPromise = diagnosticDue('sourceHealth', SOURCE_HEALTH_REFRESH_MS)",
  "const modelEvaluationPromise = diagnosticDue('modelEvaluation', MODEL_EVALUATION_REFRESH_MS)",
  "const publicHealthPromise = diagnosticDue('publicHealth', PUBLIC_HEALTH_REFRESH_MS)",
  'let serverEventRefreshFailureCount = 0;',
  'serverEventRefreshFailureCount = applied',
  'TRANSIENT_CURRENT_REFRESH_MS * (2 ** Math.min(serverEventRefreshFailureCount - 1, 3))'
]));

const listGuard = list.indexOf('if (isFinished && !reviewRow && !livePublishedRecommendation && !archivedPreMatchPrediction) {');
const listSupplement = list.indexOf('getAnalysisReferenceHandicapSupplement(', listGuard);
const listGuardEnd = list.indexOf("const companionCandidate = !isFinished", listGuard);

check('finished and pending-result rows preserve a proven pre-match BEST while failing closed without one', hasAll(list, [
  "match.status === 'FINISHED'",
  "match.status === 'PENDING_RESULT'",
  'const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);',
  'if (isFinished && !reviewRow && !livePublishedRecommendation && !archivedPreMatchPrediction) {',
  "const livePublishedRecommendation = publishedRecommendation?.publicationTrack === 'live'",
  "'赛前数据推荐归档 · 待官方赛果'",
  '这是截止前已冻结的原赛前方向'
]));

check('a LIVE fixture exposes its immutable original pre-match pick without entering result settlement', hasAll(
  archivedPreMatchPrediction,
  ["match.status === 'LIVE'", 'const archiveReadablePhase =']
) && hasAll(list, [
  'const isInPlayArchiveFallback',
  "match.status === 'LIVE'",
  'Original pre-match pick',
  'Original pre-match archive',
  'live score and post-kickoff prices cannot rewrite it.'
]) && hasAll(detail, [
  'const isInPlayArchivedPrimaryDirection = Boolean(',
  '|| archivedPreMatchPrediction',
  '|| analysisReferencePrediction'
]));

check('pending settlement without a frozen BEST returns before any handicap supplement', listGuard >= 0
  && listGuardEnd > listGuard
  && listSupplement > listGuardEnd
  && list.slice(listGuard, listGuardEnd).includes('return (')
  && list.slice(listGuard, listGuardEnd).includes('!archivedPreMatchPrediction'), {
  listGuard,
  listGuardEnd,
  listSupplement
});

const listCompanionStart = list.indexOf('const companionCandidate = !isFinished');
const listCompanionEnd = list.indexOf('const companionOfficialOdds =', listCompanionStart);
const listCompanionSource = list.slice(listCompanionStart, listCompanionEnd);
const detailCompanionStart = detail.indexOf('const companionRecommendation = isResultPhase || primaryPostReviewPrediction');
const detailCompanionEnd = detail.indexOf('const rawBestOutcomePrediction =', detailCompanionStart);
const detailCompanionSource = detail.slice(detailCompanionStart, detailCompanionEnd);
const referenceCompanionGuardStart = displayRecommendation.indexOf('export const getAnalysisReferenceHandicapSupplement = (');
const referenceCompanionGuardEnd = displayRecommendation.indexOf('const getOneXTwoSupport =', referenceCompanionGuardStart);
const referenceCompanionGuardSource = displayRecommendation.slice(referenceCompanionGuardStart, referenceCompanionGuardEnd);

check('handicap supplement is restricted to pre-result state and published references fail closed',
  listCompanionStart >= 0
  && listCompanionEnd > listCompanionStart
  && hasAll(listCompanionSource, [
    'const companionCandidate = !isFinished',
    '? displayRecommendation?.companion',
    '|| getAnalysisReferenceHandicapSupplement(',
    'displayRecommendation?.prediction || analysisReference,',
    'analysisReferenceSelection?.source',
    ': undefined;'
  ])
  && detailCompanionStart >= 0
  && detailCompanionEnd > detailCompanionStart
  && hasAll(detailCompanionSource, [
    'const companionRecommendation = isResultPhase || primaryPostReviewPrediction',
    '? undefined',
    ': displayRecommendation?.companion',
    '|| getAnalysisReferenceHandicapSupplement(',
    'canonicalPublishedRecommendation?.prediction || analysisReferencePrediction,',
    'detailAnalysisReferenceSelection?.source'
  ])
  && referenceCompanionGuardStart >= 0
  && referenceCompanionGuardEnd > referenceCompanionGuardStart
  && hasAll(referenceCompanionGuardSource, [
    "referenceSource === 'published-reference'",
    '? null',
    ': getListHandicapSupplement(match, language, primaryPrediction)'
  ]), {
  listCompanionStart,
  listCompanionEnd,
  detailCompanionStart,
  detailCompanionEnd,
  referenceCompanionGuardStart,
  referenceCompanionGuardEnd
});

check('only formal main rows receive hit/miss colors', hasAll(list, [
  "row.recommendationAction === 'recommend'",
  "row.reviewRole === 'main'",
  "const showFormalHit = isFinished && reviewIsFormal && settledStatus === 'WON'",
  "const showFormalMiss = isFinished && reviewIsFormal && settledStatus === 'LOST'",
  "${showFormalHit ? 'is-hit' : ''}",
  "${showFormalMiss ? 'is-miss' : ''}",
  "'推荐命中'",
  "'推荐未中'"
]));

check('reference settlement uses neutral copy and neutral class', hasAll(list, [
  "'数据推荐归档'",
  'showReferenceOutcome',
  'className="mini-watch"',
  "'分析参考符合赛果'",
  "'分析参考不符合赛果'"
]) && !list.includes('{showHit && <span className="mini-hit">')
  && !list.includes('{showMiss && <span className="mini-miss">'));

check('detail retains an immutable live publication while waiting for settlement', hasAll(detail, [
  'const isResultPhase = isFinished || isPendingResult;',
  'const hasImmutableLivePublication = Boolean(',
  'const isPublishedLiveAwaitingSettlement = Boolean(',
  '&& !isPublishedLiveAwaitingSettlement',
  "'赛前记录结算中'",
  "'已发布 · 待结算'",
  "'不可变发布记录'",
  "'不计入正式推荐命中率'",
  '不会使用赛后盘口生成临时方向。',
  'const primaryOutcomePrediction = isPreMatchRecordSettling',
  '&& !hasReviewPredictions',
  '&& hasImmutableLivePublication'
]));

check('detail preserves the same proven pre-match BEST while official settlement is pending', hasAll(detail, [
  'const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);',
  '&& !archivedPreMatchPrediction;',
  'const canonicalPreMatchPrediction = canonicalPublishedRecommendation?.prediction',
  '|| archivedPreMatchPrediction',
  '|| analysisReferencePrediction;',
  "'赛前推荐归档 · 待官方赛果'",
  '这是截止前已冻结的原赛前方向',
  "'赛前原方向已锁定'"
]));

check('non-official scores stay visible only as a shadow reference while formal settlement waits', hasAll(list, [
  'getProvisionalArchivedOutcome(match, nowMs)',
  'External-result shadow reference',
  'Original pre-match directions remain unchanged.',
  'Official settlement and external-result references use separate denominators.',
  'data-provisional-reference-settled={dailyReviewStats.provisionalReferenceSettled}'
]) && hasAll(detail, [
  'getProvisionalArchivedOutcome(match, nowMs)',
  '外部赛果 · 待竞彩确认',
  '仅进入影子参考统计',
  '不计入正式命中率'
]));

check('partial odds-trend payloads cannot crash multilingual detail rendering', hasAll(detail, [
  'const oddsTrendSummaryText = localizedSignalText(match.oddsTrend?.summary);',
  "oddsTrendSummaryText || (language === 'zh'",
  "localizedSignalText(matchInsight.summary, '--')"
]) && hasAll(predictionInsight, [
  "const oddsTrendSummaryZh = multiText(match.oddsTrend?.summary, 'zh');",
  "const oddsTrendSummaryEn = multiText(match.oddsTrend?.summary, 'en');"
]) && !detail.includes('match.oddsTrend.summary[language]')
  && !predictionInsight.includes('match.oddsTrend.summary.zh')
  && !predictionInsight.includes('match.oddsTrend.summary.en'));

check('detail formal/live/reference settlement labels are track aware', hasAll(detail, [
  'const isFormalPostReviewRow =',
  "row.recommendationAction === 'recommend'",
  "row.reviewRole === 'main'",
  "row.performanceTrack === 'formal'",
  'const isLivePostReviewRow =',
  "row?.performanceTrack === 'live-model'",
  "'推荐命中'",
  "'推荐未中'",
  "'实时推荐命中'",
  "'实时推荐未中'",
  "'实时推荐归档'",
  "'分析参考符合赛果'",
  "'分析参考不符合赛果'"
]));

check('detail applies won/lost row styling only to formal rows', detail.includes(
  "className={`post-review-row${isFormalPostReviewRow(row) ? ` is-${row.resultStatus.toLowerCase()}` : ''}`}"
) && !detail.includes('className={`post-review-row is-${row.resultStatus.toLowerCase()}`}'));

check('archived BEST remains the reference fallback', hasAll(list, [
  "settledRows.find((row) => row.marketType === 'BEST')",
  '|| archivedPreMatchPrediction',
  '|| analysisReference;'
]) && hasAll(detail, [
  "settledRows.find((row) => row.marketType === 'BEST')",
  'const primaryOutcomePrediction = isPreMatchRecordSettling',
  'const canonicalPreMatchPrediction = canonicalPublishedRecommendation?.prediction',
  '|| archivedPreMatchPrediction',
  '|| analysisReferencePrediction;'
]));

check('HHAD review eligibility uses the immutable prediction line first', hasAll(syncData, [
  'prediction.handicapLine ?? match.handicapLine',
  'isOfficialRecommendationEligible(',
  'officialHandicapLine'
]));

const frozenHhadRows = buildPredictionReviewRows({
  scoreHome: 0,
  scoreAway: 1,
  predictions: [{
    marketType: 'BEST',
    oddsPoolCode: 'HHAD',
    handicapLine: '-1',
    tipCode: '2',
    tipLabel: { zh: '让负', en: 'Away + handicap' },
    odds: 1.65,
    resultStatus: 'WON',
    recommendationAction: 'recommend',
    recommendationTier: 'multi-factor',
    multiFactorEvidence: {
      version: 'multi-factor-market-evidence-v2',
      eligible: true,
      market: 'HHAD',
      code: '2',
      handicapLine: '-1',
      odds: 1.65,
      blockers: []
    }
  }]
}, {
  scoreHome: 0,
  scoreAway: 1,
  had: '2',
  hhad: '2',
  overUnder25: 'U2.5',
  btts: 'NG'
});
check('snapshot-owned HHAD BEST without a publication ledger remains reference with its frozen SP',
  frozenHhadRows.length === 1
  && frozenHhadRows[0].reviewRole === 'reference'
  && frozenHhadRows[0].recommendationAction === 'reference'
  && frozenHhadRows[0].publicationId === null
  && frozenHhadRows[0].odds === 1.65
  && frozenHhadRows[0].handicapLine === '-1');

check('same-event official history can upgrade current while stale responses cannot regress terminal state', hasAll(appContext, [
  'let currentRequestGeneration = 0;',
  'let historyRequestGeneration = 0;',
  'requestGeneration !== currentRequestGeneration',
  'requestGeneration !== historyRequestGeneration'
]) && hasAll(atomicRefresh, [
  'reconcileMatchLifecycle(merged[existingIndex], incoming, now)',
  'sameMatchEvent(existing, incoming)',
  'preferIncomingEvent: true'
]) && !appContext.includes('authoritativeCurrentIds'));

check('formal recommendation display fails closed after sale cutoff', hasAll(
  displayRecommendation,
  [
    "import { isBeforeMatchSaleCutoff } from './matchLifecycle';",
    "match.status !== 'SCHEDULED' || !isBeforeMatchSaleCutoff(match)"
  ]
));

const loadCurrentStart = appContext.indexOf('const runCurrentRequest = async');
const loadCurrentEnd = appContext.indexOf('const loadHistory =', loadCurrentStart);
const loadCurrentSource = appContext.slice(loadCurrentStart, loadCurrentEnd);
check('authoritative current rows commit before independent optional diagnostics finish', hasAll(loadCurrentSource, [
  'const diagnosticDue = (',
  "const metaPromise = diagnosticDue('syncMeta', SYNC_META_REFRESH_MS) ? fetchSyncMeta() : null;",
  "const sourceHealthPromise = diagnosticDue('sourceHealth', SOURCE_HEALTH_REFRESH_MS)",
  "const modelEvaluationPromise = diagnosticDue('modelEvaluation', MODEL_EVALUATION_REFRESH_MS)",
  "const publicHealthPromise = diagnosticDue('publicHealth', PUBLIC_HEALTH_REFRESH_MS)",
  'const dataResult = await fetchFirstAvailable<unknown>(',
  "const currentCount = applyData(dataResult.data, 'current');",
  'if (metaPromise) void metaPromise.then((meta) => {',
  'if (sourceHealthPromise) void sourceHealthPromise.then((sourceHealth) => {',
  'if (modelEvaluationPromise) void modelEvaluationPromise.then((modelEvaluation) => {',
  'if (publicHealthPromise) void publicHealthPromise.then((publicHealth) => {'
])
  && !loadCurrentSource.includes('const [dataResult, meta, sourceHealth, modelEvaluation, publicHealth] = await Promise.all')
  && !loadCurrentSource.includes('const diagnosticsPromise = recoveryProbeOnly ? null : Promise.all([')
  && loadCurrentSource.indexOf("const currentCount = applyData(dataResult.data, 'current');")
    < loadCurrentSource.indexOf('const diagnosticDue = (')
  && loadCurrentSource.indexOf('const diagnosticDue = (')
    < loadCurrentSource.indexOf('if (sourceHealthPromise) void sourceHealthPromise.then')
  && loadCurrentSource.indexOf('if (modelEvaluationPromise) void modelEvaluationPromise.then')
    < loadCurrentSource.indexOf('if (publicHealthPromise) void publicHealthPromise.then'));

check('async metadata and diagnostics cannot overwrite a newer current request',
  (loadCurrentSource.match(/requestGeneration !== currentRequestGeneration/g) || []).length >= 3);

const loadHistoryStart = appContext.indexOf('const loadHistory =');
const loadHistoryEnd = appContext.indexOf('const dataUrls =', loadHistoryStart);
const loadHistorySource = appContext.slice(loadHistoryStart, loadHistoryEnd);
check('history refresh is single-flight with one coalesced follow-up', hasAll(appContext, [
  'let historyRequestInFlight: Promise<boolean> | null = null;',
  'let historyRefreshQueued = false;'
]) && hasAll(loadHistorySource, [
  'if (historyRequestInFlight)',
  'if (!queueIfBusy) return activeRequest;',
  'historyRefreshQueued = true;',
  'queuedRequest && queuedRequest !== activeRequest',
  'requestGeneration !== historyRequestGeneration || historyRefreshQueued',
  'historyRequestInFlight = trackedRequest;',
  'if (historyRefreshQueued && !cancelled)',
  'void loadHistory();'
]));

check('history paging and the protected unresolved archive restore older original picks', hasAll(loadHistorySource, [
  "dataUrls('/matches/history?view=list&limit=200', [])",
  "dataUrls('/matches/unresolved-archive?view=list&limit=200', [])",
  'let pageInfo = historyPageInfoFromPayload(historyData.data);',
  'const seenCursors = new Set<string>();',
  '&& accumulatedHistory.length < 1200',
  'cursor=${encodeURIComponent(cursor)}',
  "applyData({ rows: accumulatedHistory }, 'history')",
  "applyData(unresolvedArchiveData.data, 'archive')"
]));

const initialLoadStart = appContext.indexOf('// Same-origin /api/v1 is the production fast path.');
const initialLoadEnd = appContext.indexOf('let wakeRefreshTimer', initialLoadStart);
const initialLoadSource = appContext.slice(initialLoadStart, initialLoadEnd);
check('initial current owns first paint before recent-history hydration starts', hasAll(initialLoadSource, [
  'void loadCurrent(true).finally(() => {',
  'scheduleCurrentRefresh();',
  'window.setTimeout(() => {',
  'if (!cancelled) void loadHistory();'
])
  && !initialLoadSource.includes('return loadHistory();')
  && initialLoadSource.indexOf('if (!cancelled) void loadHistory();')
    > initialLoadSource.indexOf('void loadCurrent(true).finally(() => {'));

const compactHistoryStart = server.indexOf('const compactHistoryMatchForList =');
const compactHistoryEnd = server.indexOf('const readUnresolvedArchiveForListDetailed =', compactHistoryStart);
const compactHistorySource = server.slice(compactHistoryStart, compactHistoryEnd);
check('history list projection preserves immutable BEST reconstruction and provisional result fields', hasAll(
  compactHistorySource,
  [
    'provisionalResult: compactProvisionalResultForList(match.provisionalResult)',
    'handicapLine: match.handicapLine',
    'predictionMeta: compactPredictionMetaForList(match.predictionMeta, match)',
    '.map(compactPredictionForHistoryList)'
  ]
) && hasAll(server, [
  'oddsPoolCode: prediction.oddsPoolCode',
  'handicapLine: prediction.handicapLine',
  '"/api/v1/matches/unresolved-archive"',
  'source: "server-private-unresolved-archive"'
]));

const priorityReviewIndex = list.indexOf('className="daily-review-panel is-compact is-priority"');
const leagueStackIndex = list.indexOf('className="league-stack"');
check('yesterday result summary is visible before the archived fixture list', priorityReviewIndex >= 0
  && leagueStackIndex > priorityReviewIndex
  && list.includes('effectiveSelectedDate < todayStr')
  && list.includes('dailyReviewStats.resultPhaseFixtures === 0')
  && hasAll(list.slice(priorityReviewIndex, leagueStackIndex), [
    'data-formal-settled={dailyReviewStats.formalSettled}',
    'data-provisional-reference-settled={dailyReviewStats.provisionalReferenceSettled}',
    'data-awaiting-official={dailyReviewStats.awaitingOfficial}',
    'data-archived-directions={dailyReviewStats.archivedDirections}',
    'data-not-yet-result-phase={dailyReviewStats.notYetResultPhase}',
    'await official results',
    'dailyReviewStats.archivedDirections',
    'dailyReviewStats.awaitingOfficial',
    'dailyReviewStats.notYetResultPhase',
    'dailyReviewStats.provisionalReferenceWon',
    'dailyReviewStats.finished'
  ])
  && predictionsCss.includes('.daily-review-panel.is-priority'));

const fetchJsonOnceStart = appContext.indexOf('const fetchJsonOnce =');
const fetchJsonEnd = appContext.indexOf('type DataFetchValidator', fetchJsonOnceStart);
const fetchJsonSource = appContext.slice(fetchJsonOnceStart, fetchJsonEnd);
check('internally timed out fetches are typed and receive the bounded transient retry', hasAll(appContext, [
  'class DataFetchTimeoutError',
  "type FetchAbortCause = 'timeout' | 'caller' | null",
  'error instanceof DataFetchTimeoutError',
  'transientFetchRetryDelaysMs'
]) && hasAll(fetchJsonSource, [
  'requestSignal?: AbortSignal',
  "abortCause = 'timeout'",
  "abortCause === 'timeout'",
  'throw new DataFetchTimeoutError',
  'for (let attempt = 0; attempt <= transientFetchRetryDelaysMs.length; attempt += 1)',
  'attempt >= transientFetchRetryDelaysMs.length'
]));

const loadCurrentCatchStart = loadCurrentSource.indexOf('} catch (error: unknown)');
const loadCurrentCatchSource = loadCurrentSource.slice(loadCurrentCatchStart);
const loadHistoryCatchStart = loadHistorySource.indexOf('} catch (error: unknown)');
const loadHistoryCatchEnd = loadHistorySource.indexOf('})();', loadHistoryCatchStart);
const loadHistoryCatchSource = loadHistorySource.slice(loadHistoryCatchStart, loadHistoryCatchEnd);
check('caller aborts are silent while real current and history failures remain observable', hasAll(appContext, [
  'const isSilentFetchCancellation =',
  'const effectRequestController = new AbortController();',
  'const effectRequestSignal = effectRequestController.signal;',
  'requestSignal?.throwIfAborted();',
  'fetchJson<T>(candidate.url, accessToken, requestSignal, timeoutMs)',
  'effectRequestController.abort();'
])
  && loadCurrentCatchSource.indexOf('isSilentFetchCancellation(error, effectRequestController.signal)') >= 0
  && loadCurrentCatchSource.indexOf('isSilentFetchCancellation(error, effectRequestController.signal)')
    < loadCurrentCatchSource.indexOf('console.error(error)')
  && loadHistoryCatchSource.indexOf('isSilentFetchCancellation(error, effectRequestController.signal)') >= 0
  && loadHistoryCatchSource.indexOf('isSilentFetchCancellation(error, effectRequestController.signal)')
    < loadHistoryCatchSource.indexOf("console.warn('History data is unavailable; current matches remain usable.', error)"));

check('one failed history refresh preserves the previously loaded history state', hasAll(loadHistoryCatchSource, [
  'setDataSync((current) => ({',
  '...current,',
  'historyLoading: false,',
  'error: formatError(error)'
])
  && !loadHistoryCatchSource.includes('historyLoaded: false')
  && !loadHistoryCatchSource.includes('historyCount: 0')
  && !loadHistoryCatchSource.includes('setMatches('));

const eventRefreshStart = appContext.indexOf('const scheduleServerEventRefresh =');
const eventRefreshEnd = appContext.indexOf('const openEventStream =', eventRefreshStart);
const eventRefreshSource = appContext.slice(eventRefreshStart, eventRefreshEnd);
check('SSE sync completion refreshes current and coalesces the result/history lane immediately', hasAll(
  eventRefreshSource,
  [
    'queueServerEventRefresh(serverEventRefreshState, type, payload)',
    'const refresh = consumed.refresh;',
    'const [currentSucceeded, historySucceeded] = await Promise.all([',
    'loadCurrent(false)',
    'loadHistory({ queueIfBusy: true })',
    'settleServerEventRefresh(',
    'scheduleServerEventRefresh(retryDelayMs)'
  ]
) && hasAll(serverEventRefresh, [
  "type === 'sync_completed' || type === 'sync_completed_with_warnings'",
  'revision === state.lastAppliedRevision',
  'revision === state.activeRevision',
  'revision === state.pendingRevision',
  'lastAppliedRevision: applied && refresh.revision'
]));

const ok = checks.every((item) => item.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  summary: {
    total: checks.length,
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).length
  },
  checks
}, null, 2));

if (!ok) process.exitCode = 1;
