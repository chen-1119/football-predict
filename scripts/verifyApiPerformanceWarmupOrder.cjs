const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  evaluatePerformanceRun,
  readAccessTokenFile,
  writeAccessTokenFile,
  selectDetailTarget
} = require('./verifyApiPerformance.cjs');
const {
  MAX_LATENCY_RECOVERY_ATTEMPTS,
  REQUIRED_LATENCY_RECOVERY_RUNS,
  evaluatePerformanceRecovery,
  isLatencyOnlyPerformanceFailure
} = require('./apiPerformanceRecoveryPolicy.cjs');

const source = fs.readFileSync(path.resolve(__dirname, 'verifyApiPerformance.cjs'), 'utf8');
const resultsStart = source.indexOf('const results = [];');
const resultLoopStart = source.indexOf('for (let index = 0; index < endpoints.length; index += 1)', resultsStart);
const resultLoopEnd = source.indexOf('const evaluation = evaluatePerformanceRun({', resultLoopStart);
const resultLoop = source.slice(resultLoopStart, resultLoopEnd);

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check('the performance gate keeps the 800ms default p95 threshold', () => {
  assert.ok(source.includes('process.env.PERF_MAX_P95_MS || 800'));
});

check('the concurrent performance gate includes public readiness health', () => {
  assert.ok(source.includes('{ name: "public-health", path: "/api/v1/health", headers: {} }'));
  assert.ok(source.includes('{ name: "source-health", path: "/api/v1/source-health", headers: {} }'));
  assert.ok(source.includes('if (row.uniqueEtags !== 1)'));
});

check('detail pressure testing falls back to immutable history when current is empty', () => {
  assert.deepEqual(selectDetailTarget({
    currentBody: { rows: [] },
    historyBody: { rows: [{ id: 'history-1' }] }
  }), { matchId: 'history-1', source: 'history-fallback' });
  assert.deepEqual(selectDetailTarget({
    currentBody: { rows: [{ id: 'current-1' }] },
    historyBody: { rows: [{ id: 'history-1' }] }
  }), { matchId: 'current-1', source: 'current' });
  assert.equal(selectDetailTarget({ currentBody: { rows: [] }, historyBody: { rows: [] } }), null);
  assert.ok(source.includes('selectedMatchSource: detailTarget.source'));
});

check('release pressure credentials are sealed to a private file and never printed', () => {
  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'perf-token-'));
  const tokenPath = path.join(tempRoot, 'access-token');
  try {
    writeAccessTokenFile(tokenPath, 'test.performance.token');
    assert.equal(readAccessTokenFile(tokenPath), 'test.performance.token');
    assert.throws(() => writeAccessTokenFile(tokenPath, 'replacement'), /EEXIST/);
    assert.ok(source.includes('PERF_PREPARE_ACCESS_TOKEN_ONLY'));
    assert.ok(source.includes('PERF_ACCESS_TOKEN_OUTPUT_PATH'));
    assert.ok(source.includes('PERF_ACCESS_TOKEN_FILE'));
    assert.ok(source.includes('preparedAccessToken: true'));
    assert.equal(source.includes('preparedAccessToken: token'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

check('warm-up and measurement share the same endpoint loop', () => {
  assert.ok(resultLoopStart > resultsStart && resultLoopEnd > resultLoopStart);
  assert.ok(resultLoop.includes('const warmup = await runWarmup(endpoint);'));
  assert.ok(resultLoop.includes('let measured = await runEndpoint(endpoint);'));
  assert.ok(resultLoop.includes('results.push(measured);'));
});

check('each endpoint is measured immediately after its own warm-up', () => {
  const warmupIndex = resultLoop.indexOf('const warmup = await runWarmup(endpoint);');
  const measuredIndex = resultLoop.indexOf('let measured = await runEndpoint(endpoint);');
  assert.ok(warmupIndex >= 0 && measuredIndex > warmupIndex);
  assert.equal(resultLoop.slice(warmupIndex, measuredIndex).includes('await sleep('), false);
});

check('a measured cache identity transition gets exactly one bounded re-warm without threshold changes', () => {
  assert.ok(resultLoop.includes('if (measured.uniqueEtags > 1 && measured.errorRate <= maxErrorRate)'));
  assert.equal((resultLoop.match(/const retryWarmup = await runWarmup\(endpoint\);/g) || []).length, 1);
  assert.equal((resultLoop.match(/\n        measured = await runEndpoint\(endpoint\);/g) || []).length, 1);
  assert.ok(source.includes('measurementCacheIdentityRetries'));
});

check('the reported policy matches the implemented order without weakening thresholds', () => {
  assert.ok(source.includes('each endpoint is warmed immediately before its measured p95; thresholds are unchanged'));
});

check('measured p95 captures wire completion before local payload decoding', () => {
  const endHandlerStart = source.indexOf('res.on("end", () => {');
  const wireDurationIndex = source.indexOf('const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;', endHandlerStart);
  const decodeIndex = source.indexOf('zlib.gunzipSync(rawBuffer)', endHandlerStart);
  assert.ok(endHandlerStart >= 0 && wireDurationIndex > endHandlerStart && decodeIndex > wireDurationIndex);
  assert.ok(source.includes('decodeBody: false'));
  assert.ok(source.includes('client payload decode and JSON parse are excluded'));
});

check('warm-ups still validate payload integrity and participate in the gate', () => {
  assert.ok(source.includes('for (const row of warmupRows)'));
  assert.ok(source.includes('row.errorRate > errorRateLimit'));
  assert.ok(source.includes('const ok = evaluation.ok'));
  assert.ok(source.includes('warm-ups fully validate gzip and JSON'));
});

const healthyWarmups = [
  { name: 'public-health', requests: 12, errorRate: 0, uniqueEtags: 2, uniqueCheckedAt: 2 },
  { name: 'source-health', requests: 12, errorRate: 0, uniqueEtags: 2, uniqueCheckedAt: 1 },
  { name: 'current-list', requests: 12, errorRate: 0, uniqueEtags: 1, uniqueCheckedAt: 0 },
  { name: 'current-transition', requests: 12, errorRate: 0, uniqueEtags: 1, uniqueCheckedAt: 0 },
  { name: 'history-page', requests: 12, errorRate: 0, uniqueEtags: 1, uniqueCheckedAt: 0 },
  { name: 'match-detail', requests: 12, errorRate: 0, uniqueEtags: 1, uniqueCheckedAt: 0 }
];
const healthyResults = [
  { name: 'public-health', errorRate: 0, p95Ms: 12, avgBytes: 4_715, uniqueEtags: 1 },
  { name: 'source-health', errorRate: 0, p95Ms: 28, avgBytes: 3_032, uniqueEtags: 1 },
  { name: 'current-list', errorRate: 0, p95Ms: 15, avgBytes: 16_975, uniqueEtags: 1 },
  { name: 'current-transition', errorRate: 0, p95Ms: 18, avgBytes: 18_400, uniqueEtags: 1 },
  { name: 'history-page', errorRate: 0, p95Ms: 16, avgBytes: 18_152, uniqueEtags: 1 },
  { name: 'match-detail', errorRate: 0, p95Ms: 12, avgBytes: 26_334, uniqueEtags: 1 }
];
const evaluate = ({ warmups = healthyWarmups, results = healthyResults } = {}) => evaluatePerformanceRun({
  warmups,
  results,
  maxP95Ms: 800,
  maxErrorRate: 0.01,
  maxCurrentAvgBytes: 180_000
});

check('a cold-cache transition during warm-up is diagnostic, not a false failure', () => {
  const evaluation = evaluate();
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failureReasons, []);
  assert.deepEqual(evaluation.warmupCacheTransitions, [
    { name: 'public-health', uniqueEtags: 2, uniqueCheckedAt: 2 },
    { name: 'source-health', uniqueEtags: 2, uniqueCheckedAt: 1 }
  ]);
});

check('health ETags must be stable during the measured steady-state batch', () => {
  const results = healthyResults.map((row) => (
    row.name === 'source-health' ? { ...row, uniqueEtags: 2 } : row
  ));
  const evaluation = evaluate({ results });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('measured:source-health:etag-identities:2!=1'));
});

check('protected data ETags must also be stable after the bounded identity retry', () => {
  const results = healthyResults.map((row) => (
    row.name === 'match-detail' ? { ...row, uniqueEtags: 2 } : row
  ));
  const evaluation = evaluate({ results });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('measured:match-detail:etag-identities:2!=1'));
});

check('warm-up errors still fail at the unchanged error-rate threshold', () => {
  const warmups = healthyWarmups.map((row) => (
    row.name === 'source-health' ? { ...row, errorRate: 0.02 } : row
  ));
  const evaluation = evaluate({ warmups });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('warmup:source-health:error-rate:0.02>0.01'));
});

check('deployment-cutover transport resets may recover only in a fully healthy measured batch', () => {
  const warmups = healthyWarmups.map((row) => (
    row.name === 'source-health'
      ? {
          ...row,
          requests: 12,
          errors: 3,
          errorRate: 0.25,
          payloadValidatedResponses: 9,
          statuses: { 0: 3, 200: 9 }
        }
      : row
  ));
  const evaluation = evaluate({ warmups });
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failureReasons, []);
  assert.deepEqual(evaluation.warmupTransportRecoveries, [{
    name: 'source-health',
    transportErrors: 3,
    requests: 12,
    measuredErrorRate: 0,
    measuredP95Ms: 28
  }]);
});

check('warm-up HTTP failures cannot be excused by a healthy measured batch', () => {
  const warmups = healthyWarmups.map((row) => (
    row.name === 'source-health'
      ? {
          ...row,
          requests: 12,
          errors: 3,
          errorRate: 0.25,
          payloadValidatedResponses: 12,
          statuses: { 200: 9, 503: 3 }
        }
      : row
  ));
  const evaluation = evaluate({ warmups });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('warmup:source-health:error-rate:0.25>0.01'));
});

check('warm-up payload failures cannot be excused by a healthy measured batch', () => {
  const warmups = healthyWarmups.map((row) => (
    row.name === 'source-health'
      ? {
          ...row,
          requests: 12,
          errors: 3,
          errorRate: 0.25,
          payloadValidatedResponses: 12,
          statuses: { 200: 12 }
        }
      : row
  ));
  const evaluation = evaluate({ warmups });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('warmup:source-health:error-rate:0.25>0.01'));
});

check('measured errors still fail at the unchanged error-rate threshold', () => {
  const results = healthyResults.map((row) => (
    row.name === 'match-detail' ? { ...row, errorRate: 0.02 } : row
  ));
  const evaluation = evaluate({ results });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('measured:match-detail:error-rate:0.02>0.01'));
});

check('measured p95 still fails above the unchanged 800ms threshold', () => {
  const results = healthyResults.map((row) => (
    row.name === 'history-page' ? { ...row, p95Ms: 800.01 } : row
  ));
  const evaluation = evaluate({ results });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('measured:history-page:p95:800.01>800'));
});

const perfRun = ({ status = 0, ok = true, failureReasons = [] } = {}) => ({
  status,
  body: { ok, failureReasons }
});

check('only a pure measured p95 failure is eligible for bounded recovery', () => {
  const latencyOnly = perfRun({
    status: 1,
    ok: false,
    failureReasons: ['measured:current-transition:p95:993.69>800']
  });
  const mixedFailure = perfRun({
    status: 1,
    ok: false,
    failureReasons: [
      'measured:current-transition:p95:993.69>800',
      'measured:current-transition:etag-identities:2!=1'
    ]
  });
  assert.equal(isLatencyOnlyPerformanceFailure(latencyOnly), true);
  assert.equal(isLatencyOnlyPerformanceFailure(mixedFailure), false);
});

check('one passing recovery batch is insufficient and two independent passes are required', () => {
  const initialRun = perfRun({
    status: 1,
    ok: false,
    failureReasons: ['measured:current-transition:p95:993.69>800']
  });
  const onePass = evaluatePerformanceRecovery({
    initialRun,
    recoveryRuns: [perfRun()]
  });
  const twoPasses = evaluatePerformanceRecovery({
    initialRun,
    recoveryRuns: [perfRun(), perfRun()]
  });
  assert.equal(REQUIRED_LATENCY_RECOVERY_RUNS, 2);
  assert.equal(MAX_LATENCY_RECOVERY_ATTEMPTS, 3);
  assert.equal(onePass.ok, false);
  assert.equal(onePass.recoveryComplete, false);
  assert.equal(twoPasses.ok, true);
  assert.equal(twoPasses.recovered, true);
});

check('one latency spike may be followed by two consecutive passing recovery batches', () => {
  const initialRun = perfRun({
    status: 1,
    ok: false,
    failureReasons: ['measured:current-transition:p95:993.69>800']
  });
  const recovery = evaluatePerformanceRecovery({
    initialRun,
    recoveryRuns: [
      perfRun({
        status: 1,
        ok: false,
        failureReasons: ['measured:current-transition:p95:850>800']
      }),
      perfRun(),
      perfRun()
    ]
  });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.recoveryPassed, true);
  assert.equal(recovery.maximumConsecutivePassingRuns, 2);
});

check('non-consecutive passes or a non-latency recovery failure keep the gate closed', () => {
  const initialRun = perfRun({
    status: 1,
    ok: false,
    failureReasons: ['measured:current-transition:p95:993.69>800']
  });
  const interrupted = evaluatePerformanceRecovery({
    initialRun,
    recoveryRuns: [
      perfRun(),
      perfRun({
        status: 1,
        ok: false,
        failureReasons: ['measured:current-list:p95:850>800']
      }),
      perfRun()
    ]
  });
  const semanticFailure = evaluatePerformanceRecovery({
    initialRun,
    recoveryRuns: [
      perfRun(),
      perfRun({
        status: 1,
        ok: false,
        failureReasons: ['measured:current-list:etag-identities:2!=1']
      }),
      perfRun()
    ]
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.recoveryComplete, true);
  assert.equal(semanticFailure.ok, false);
  assert.equal(semanticFailure.nonLatencyRecoveryFailure, true);
});

check('current payload size still fails above the unchanged 180000-byte threshold', () => {
  const results = healthyResults.map((row) => (
    row.name === 'current-list' ? { ...row, avgBytes: 180_001 } : row
  ));
  const evaluation = evaluate({ results });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failureReasons.includes('measured:current-list:avg-bytes:180001>180000'));
});

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.cjs'), 'utf8');
const publicHealthBaseStart = serverSource.indexOf('const getPublicV1HealthBase = async () => {');
const publicHealthBaseEnd = serverSource.indexOf('const getPublicLegacyHealth = async () => {', publicHealthBaseStart);
const publicHealthBase = serverSource.slice(publicHealthBaseStart, publicHealthBaseEnd);

check('public health uses TTL caching and one global singleflight with generation-safe commits', () => {
  assert.ok(serverSource.includes('const publicV1HealthCacheTtlMs ='));
  assert.ok(serverSource.includes('if (publicV1HealthInflight)'));
  assert.ok(serverSource.includes('publicV1HealthCache = { createdAt: Date.now(), value };'));
  assert.ok(serverSource.includes('serviceOk: false'));
});

check('source health coalesces large-file refreshes behind its own short cache', () => {
  assert.ok(serverSource.includes('const sourceHealthCacheTtlMs ='));
  assert.ok(serverSource.includes('if (sourceHealthInflight)'));
  assert.ok(serverSource.includes('cachedValue: { ...health, cached: true }'));
  assert.ok(serverSource.includes('return sourceHealthCache.cachedValue || sourceHealthCache.value;'));
  assert.ok(serverSource.includes('source health refresh failed'));
});

check('source health intentionally changes its public cached marker after a cold build', () => {
  assert.ok(serverSource.includes('cached: false,'));
  assert.ok(serverSource.includes('cachedValue: { ...health, cached: true }'));
  assert.ok(serverSource.includes('cached: Boolean(health?.cached)'));
});

check('public health avoids full current payload and datastore diagnostics', () => {
  assert.ok(publicHealthBaseStart >= 0 && publicHealthBaseEnd > publicHealthBaseStart);
  assert.ok(publicHealthBase.includes('getCachedSqliteReadStatus(meta, basePublication.identity || null)'));
  assert.equal(publicHealthBase.includes('readCurrentMatchesDetailed('), false);
  assert.equal(publicHealthBase.includes('getDataStoreStatus('), false);
  assert.equal(publicHealthBase.includes('readGptPredictions('), false);
});

check('public health keeps an exact validated receipt during a bounded SQLite pair refresh', () => {
  assert.ok(serverSource.includes('const fastResultReceiptTransitionCache = new Map();'));
  assert.ok(serverSource.includes('FAST_RESULT_RECEIPT_TRANSITION_TTL_MS || 300_000'));
  assert.ok(serverSource.includes('publicationPairTransitionActive(publication)'));
  assert.ok(serverSource.includes('"generation-sqlite-replacement"'));
  assert.ok(serverSource.includes('selectFastResultReceiptDuringPairTransition({'));
  assert.ok(publicHealthBase.includes('readPublicationFastResultReceiptState(basePublication)'));
  assert.ok(publicHealthBase.includes('fastResultIntegrityRaw?.transition === true'));
  assert.ok(publicHealthBase.includes('source: sqliteReplacementPending'));
  assert.ok(publicHealthBase.includes(': countDivergence.active'));
  assert.ok(publicHealthBase.includes('? "generation-pair-refresh"'));
  assert.ok(publicHealthBase.includes('? "sqlite-pair-refresh-pending" : null'));
  assert.ok(serverSource.includes('cachedSqlitePublicationIdentity().fileToken || "unknown"'));
});

check('publication resolver waits for the configured primary projection identity', () => {
  const resolverSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'server', 'publicationResolverWorker.cjs'),
    'utf8',
  );
  assert.ok(serverSource.includes('requirePostgresPair: shouldPreferPostgresRead()'));
  assert.ok(resolverSource.includes('if (workerData.requirePostgresPair)'));
  assert.ok(resolverSource.includes('readPostgresPublicationIdentity(pool)'));
  assert.ok(resolverSource.includes('POSTGRES_PUBLICATION_IDENTITY_UNAVAILABLE'));
  assert.ok(resolverSource.includes('sqliteIdentity: postgres.publication'));
  assert.ok(resolverSource.includes('await pool.end()'));
});

check('current and history payload builds use independent bounded lanes across cache invalidation', () => {
  assert.ok(serverSource.includes('const serializeV1ListPayloadBuild = (builder, laneName = "current") => {'));
  assert.ok(serverSource.includes('const v1ListPayloadLanes = {'));
  assert.ok(serverSource.includes('process.env.V1_LIST_PAYLOAD_MAX_PENDING || 32'));
  assert.ok(serverSource.includes('V1_LIST_PAYLOAD_QUEUE_BUSY'));
  assert.ok(serverSource.includes('v1ListPayloadCacheGeneration += 1;'));
  assert.equal((serverSource.match(/const promise = serializeV1ListPayloadBuild\(async \(\) => \{/g) || []).length, 2);
  assert.ok(serverSource.includes('}, "current");'));
  assert.ok(serverSource.includes('}, "history");'));
  assert.equal((serverSource.match(/cacheGeneration === v1ListPayloadCacheGeneration/g) || []).length, 2);
  const clearStart = serverSource.indexOf('const clearApiReadCaches = () => {');
  const clearEnd = serverSource.indexOf('\n};', clearStart);
  const clearBody = serverSource.slice(clearStart, clearEnd);
  assert.equal(clearBody.includes('PayloadInflight.clear()'), false);
});

check('current list reuses one version-bound payload across the browser retry window', () => {
  assert.ok(serverSource.includes('process.env.V1_CURRENT_PAYLOAD_CACHE_TTL_MS || 30_000'));
  assert.ok(serverSource.includes('now - cached.createdAt <= v1CurrentPayloadCacheTtlMs'));
  const currentStart = serverSource.indexOf('const buildV1CurrentPayload = async (url) => {');
  const currentEnd = serverSource.indexOf('const buildV1HistoryPayload = async (url) => {', currentStart);
  const currentBuilder = serverSource.slice(currentStart, currentEnd);
  assert.ok(currentBuilder.includes('meta?.updatedAt || meta?.capturedAt || "no-version"'));
  assert.ok(currentBuilder.includes('`generation:${basePublication.identity.generationId'));
  assert.ok(currentBuilder.includes('`manifest:${basePublication.identity.manifestHash'));
  assert.ok(currentBuilder.includes('sqliteCacheToken'));
  assert.ok(currentBuilder.includes('`fast:${meta?.fastResultRevision'));
});

check('current conditional polling preserves payload identity for cached JSON and gzip bytes', () => {
  assert.ok(serverSource.includes('const v1CurrentConditionalPayloadCache = new WeakMap();'));
  const conditionalStart = serverSource.indexOf('const applyCurrentConditionalRequest = (payload, url) => {');
  const conditionalEnd = serverSource.indexOf('const buildV1CurrentPayload = async (url) => {', conditionalStart);
  const conditionalBody = serverSource.slice(conditionalStart, conditionalEnd);
  assert.ok(conditionalStart >= 0 && conditionalEnd > conditionalStart);
  assert.ok(conditionalBody.includes('if (payload.notModified === notModified) return payload;'));
  assert.ok(conditionalBody.includes('v1CurrentConditionalPayloadCache.get(payload)'));
  assert.ok(conditionalBody.includes('v1CurrentConditionalPayloadCache.set(payload, variant)'));
});

const appContextSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'context', 'AppContext.tsx'),
  'utf8'
);
const initialBootstrapStart = appContextSource.indexOf('// Current fixtures own the first authenticated request');
const initialBootstrapEnd = appContextSource.indexOf('let wakeRefreshTimer', initialBootstrapStart);
const initialBootstrap = appContextSource.slice(initialBootstrapStart, initialBootstrapEnd);

check('authenticated first paint settles current before scheduling background history', () => {
  assert.ok(initialBootstrapStart >= 0 && initialBootstrapEnd > initialBootstrapStart);
  const currentStart = initialBootstrap.indexOf('void loadCurrent(true).finally(() => {');
  const historyStart = initialBootstrap.indexOf('void loadHistory();');
  assert.ok(currentStart >= 0 && historyStart > currentStart);
  assert.ok(initialBootstrap.includes('window.setTimeout(() => {'));
  assert.equal(initialBootstrap.includes('Promise.all(['), false);
});

check('background history has an independent bounded timeout while current keeps the first-paint budget', () => {
  assert.ok(appContextSource.includes('const DATA_FETCH_TIMEOUT_MS = 6 * 1000;'));
  assert.ok(appContextSource.includes('const HISTORY_DATA_FETCH_TIMEOUT_MS = 12 * 1000;'));
  assert.ok(appContextSource.includes('timeoutMs = DATA_FETCH_TIMEOUT_MS'));
  assert.ok(appContextSource.includes('}, timeoutMs);'));
  assert.ok(appContextSource.includes('new DataFetchTimeoutError(url, timeoutMs, error)'));
  const currentStart = appContextSource.indexOf('const runCurrentRequest = async');
  const currentEnd = appContextSource.indexOf('const loadHistory =', currentStart);
  const currentLoader = appContextSource.slice(currentStart, currentEnd);
  assert.equal(currentLoader.includes('HISTORY_DATA_FETCH_TIMEOUT_MS'), false);
  assert.ok((appContextSource.match(/HISTORY_DATA_FETCH_TIMEOUT_MS/g) || []).length >= 4);
});

check('the newest history page renders before optional archive, which merges before older pagination', () => {
  const historyStart = appContextSource.indexOf('const loadHistory =');
  const historyEnd = appContextSource.indexOf('const loadCurrent =', historyStart);
  const historyLoader = appContextSource.slice(historyStart, historyEnd);
  const firstPage = historyLoader.indexOf('const historyData = await fetchFirstAvailable<unknown>');
  const progressiveApply = historyLoader.indexOf("applyData({ rows: historyRows }, 'history')");
  const pagination = historyLoader.indexOf('const seenCursors = new Set<string>();');
  const archiveAwait = historyLoader.indexOf('const unresolvedArchiveData = await unresolvedArchivePromise;');
  assert.ok(firstPage >= 0);
  assert.ok(progressiveApply > firstPage);
  assert.ok(archiveAwait > progressiveApply);
  assert.ok(pagination > archiveAwait);
  assert.equal(historyLoader.includes('const [historyData, unresolvedArchiveData] = await Promise.all(['), false);
});

check('production current list prefers atomic PostgreSQL or SQLite and retains immutable publication fallback', () => {
  assert.ok(serverSource.includes('&& !shouldPreferSqliteRead()'));
  assert.ok(serverSource.includes('&& !shouldPreferPostgresRead();'));
  assert.ok(serverSource.includes('serveInitialFromPublication'));
  assert.ok(serverSource.includes('preferPublication: serveInitialFromPublication'));
  assert.ok(serverSource.includes('!serveInitialFromPublication && shouldPreferPostgresRead()'));
  assert.ok(serverSource.includes('!serveInitialFromPublication && shouldPreferSqliteRead()'));
});

check('an immutable cached publication remains readable while the pointer writer lock is held', () => {
  assert.ok(serverSource.includes('const generationPointerLockDir ='));
  assert.ok(serverSource.includes('defaultLockDir: syncPublicationLockDir'));
  assert.ok(serverSource.includes('pointerCommitLockActive({'));
  assert.ok(serverSource.includes('staleMs: 60_000'));
  assert.ok(serverSource.includes('syncLockActive({ lockDir: syncPublicationLockDir })'));
  assert.ok(serverSource.includes('basePublicationCache?.publication && publicationWriteInProgress'));
  assert.ok(serverSource.includes('publication-write-in-progress-serving-previous'));
  assert.ok(serverSource.includes('error?.code === "POINTER_LOCK_TIMEOUT" && basePublicationCache?.publication'));
});

check('pointer rotation validation runs off the HTTP thread and keeps the previous generation live', () => {
  const workerSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'publicationResolverWorker.cjs'), 'utf8');
  assert.ok(serverSource.includes('scheduleBasePublicationRefresh(token);'));
  assert.ok(serverSource.includes('return basePublicationCache.publication;'));
  assert.ok(serverSource.includes('new Worker(path.join(__dirname, "publicationResolverWorker.cjs")'));
  assert.ok(serverSource.includes('deferReleasePublicationLease(previous?.readerLease);'));
  assert.ok(serverSource.includes('resolveBasePublication();'));
  assert.ok(workerSource.includes('resolveServingPublication({'));
  assert.ok(workerSource.includes('acquireGenerationReadLease({'));
});

check('transition cutover never parses the full history bundle on the request thread', () => {
  assert.ok(serverSource.includes('active-generation-transition-deferred')
    || serverSource.includes('`${basePublication.mode}-transition-deferred`'));
  const currentStart = serverSource.indexOf('const buildV1CurrentPayload = async (url) => {');
  const currentEnd = serverSource.indexOf('const buildV1HistoryPayload = async (url) => {', currentStart);
  const currentBuilder = serverSource.slice(currentStart, currentEnd);
  assert.equal(currentBuilder.includes('readPublicationJson(basePublication, "matches-history.json", [])'), false);
});

check('current payload conditionals are derived after shared generation singleflight', () => {
  assert.ok(serverSource.includes('const applyCurrentConditionalRequest = (payload, url) => {'));
  assert.ok(serverSource.includes('return applyCurrentConditionalRequest(await v1CurrentPayloadInflight.get(cacheKey), url);'));
  assert.equal(serverSource.includes('url.searchParams.get("since") || "",'), false);
  assert.equal(serverSource.includes('url.searchParams.get("revision") || ""'), false);
});

check('the measured endpoint set includes the background transition lane', () => {
  assert.ok(source.includes('{ name: "current-transition", path: "/api/v1/matches/current?view=list&transition=1", headers }'));
});

const readinessSource = fs.readFileSync(path.resolve(__dirname, 'verifyProductionReadiness.cjs'), 'utf8');

check('production readiness preserves performance failure reasons and warm-up evidence', () => {
  assert.ok(readinessSource.includes('failureReasons: Array.isArray(perf.body?.failureReasons)'));
  assert.ok(readinessSource.includes('warmupTransportRecoveries: Array.isArray(perf.body?.warmupTransportRecoveries)'));
  assert.ok(readinessSource.includes('warmupCacheTransitions: Array.isArray(perf.body?.warmupCacheTransitions)'));
  assert.ok(readinessSource.includes('measurementCacheIdentityRetries: Array.isArray(perf.body?.measurementCacheIdentityRetries)'));
  assert.ok(readinessSource.includes('warmups: perfWarmups.map((row) => ({'));
  assert.ok(readinessSource.includes('uniqueEtags: row.uniqueEtags'));
  assert.ok(readinessSource.includes('uniqueCheckedAt: row.uniqueCheckedAt'));
});

check('production readiness requires the configured database source and only permits the SQLite transition exception', () => {
  assert.ok(readinessSource.includes('/api/v1/matches/current?view=list&transition=1'));
  assert.ok(readinessSource.includes('currentReadSource === requiredReadSource'));
  assert.ok(readinessSource.includes('currentReadSource === "generation"'));
  assert.ok(readinessSource.includes('transitionCurrentReadSource === "sqlite"'));
});

check('parallel local readiness verifiers use process-scoped default ports', () => {
  assert.ok(readinessSource.includes('const autoLocalPort = 20000 + (process.pid % 30000);'));
  assert.ok(readinessSource.includes('process.env.VERIFY_PORT || process.env.PORT || autoLocalPort'));
});

check('local readiness waits for its own child listener before probing health', () => {
  const ownershipStart = readinessSource.indexOf('const expectedListenerLog = `[football-server] listening on http://');
  const ownershipGate = readinessSource.indexOf('if (childLogs.includes(expectedListenerLog))', ownershipStart);
  const healthProbe = readinessSource.indexOf('const health = await request("GET", "/api/v1/health")', ownershipGate);
  assert.ok(ownershipStart >= 0);
  assert.ok(ownershipGate > ownershipStart);
  assert.ok(healthProbe > ownershipGate);
  assert.ok(readinessSource.includes('"local verification listener owned by child"'));
});

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks
}, null, 2));
