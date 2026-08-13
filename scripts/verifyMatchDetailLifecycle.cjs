const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const detailPath = path.join(rootDir, 'src', 'pages', 'MatchDetail.tsx');
const detailSource = fs.readFileSync(detailPath, 'utf8');
const appSource = fs.readFileSync(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
const checks = [];

const check = (name, ok, details = {}) => {
  checks.push({ name, ok: Boolean(ok), ...details });
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const loadFixture = () => {
  for (const file of ['matches-current.json', 'matches-history.json', 'matches.json']) {
    const filePath = path.join(rootDir, 'public', 'data', file);
    if (!fs.existsSync(filePath)) continue;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(payload) ? payload : payload?.matches;
    const fixture = rows?.find((match) => Array.isArray(match.predictions) && match.predictions.length > 0);
    if (fixture) return fixture;
  }
  throw new Error('No match fixture with predictions is available.');
};

const contextValue = (match) => ({
  language: 'en',
  matches: [match],
  dataSync: {
    currentLoaded: true,
    historyLoaded: true,
    historyLoading: false,
    currentCount: 1,
    historyCount: 0,
    totalCount: 1
  }
});

const run = async () => {
  check('event and payload timestamps participate in detail freshness', [
    'matchEnvelope.updatedAt',
    'matchEnvelope.capturedAt',
    'match.eventVersion',
    'match.kickoffTime',
    'match.resultUpdatedAt',
    'match.resultProvenance?.observedAt',
    'match.oddsTrend?.lastCapturedAt'
  ].every((token) => detailSource.includes(token)));

  check('same-event lifecycle reconciliation precedes ordinary freshness without a time threshold', [
    'sameMatchEvent(detailMatch, contextMatch)',
    'return reconcileMatchLifecycle(resolvedDetail, resolvedContext, now)',
    'return contextFreshness > detailFreshness ? resolvedContext : resolvedDetail'
  ].every((token) => detailSource.includes(token))
    && !detailSource.includes('contextFreshness > detailFreshness + 1000'));

  check('detail clock refreshes every 30 seconds and on tab return', [
    'const [nowMs, setNowMs] = useState(() => Date.now());',
    'window.setInterval(refreshClock, 30_000)',
    "document.addEventListener('visibilitychange', refreshClockWhenVisible)",
    'window.clearInterval(intervalId)'
  ].every((token) => detailSource.includes(token)));

  check('detail route commits a lightweight shell before heavy analysis', [
    'const [detailShellState, setDetailShellState]',
    "ready: typeof window === 'undefined'",
    'window.setTimeout(() => {',
    '}, 160);',
    'if (!detailShellReady || isPastKickoffAwaitingAuthoritativeDetail) {',
    'match-detail-fast-shell',
    '比赛页面已打开，正在整理盘口、赛前记录与复盘数据',
    "window.sessionStorage.getItem('football.detailNavigationStartedAt')",
    'dataset.detailNavigationMs'
  ].every((token) => detailSource.includes(token))
    && appSource.includes("window.sessionStorage.setItem('football.detailNavigationStartedAt'"));

  check('list navigation bypasses the transient detail shell when context data is already available', [
    'const hasContextShellMatch = matches.some((item) => item.id === matchId);',
    'const detailShellReady = hasContextShellMatch',
    "|| (detailShellState.matchId === matchId && detailShellState.ready)"
  ].every((token) => detailSource.includes(token)));

  check('detail navigation measures shell, data, and interactive readiness with cleanup', [
    'detailNavigationDataMs',
    'detailNavigationDataStatus',
    'detailNavigationDataSource',
    'detailNavigationInteractiveMs',
    'detailNavigationInteractiveStatus',
    "'data', 'failed'",
    "'interactive', 'failed'",
    'clearDetailNavigationMetrics(matchId)',
    'window.cancelAnimationFrame(frameId)'
  ].every((token) => detailSource.includes(token)));

  check('detail requests have bounded preferred and compatibility fallback attempts', [
    'PRIMARY_DETAIL_FETCH_TIMEOUT_MS = 4_500',
    'FALLBACK_DETAIL_FETCH_TIMEOUT_MS = 3_500',
    'fetchDetailWithTimeout',
    "source: 'v1'",
    "source: 'legacy-fallback'",
    'maxAttempts: 2',
    'maxAttempts: 1',
    "error.name === 'DetailFetchTimeoutError'",
    'requestController.abort()',
    "markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'data', 'failed'"
  ].every((token) => detailSource.includes(token)));

  check('detail status remains neutral until the authoritative detail request settles', [
    "type DetailRequestStatus = 'loading' | 'ready' | 'failed'",
    "status: 'loading'",
    "setDetailRequestState({ matchId, status: 'ready' })",
    "setDetailRequestState({ matchId, status: 'failed' })",
    "const isScheduledStatusSyncing = match.status === 'SCHEDULED'",
    "detailRequestStatus === 'loading'",
    'data-detail-status="syncing"',
    "'比赛状态同步中'",
    'const hasAuthoritativeDetailMatch = fullMatch?.id === matchId',
    '&& !hasAuthoritativeDetailMatch',
    'isPastKickoffAwaitingAuthoritativeDetail',
    'if (!detailShellReady || isPastKickoffAwaitingAuthoritativeDetail) {'
  ].every((token) => detailSource.includes(token)));

  check('result and history freshness changes revalidate match detail and review data', [
    'dataSync.sourceHealthSummary?.resultFreshnessTime',
    'dataSync.sourceHealthSummary?.historyFreshnessTime',
    "].filter(Boolean).join('|')"
  ].every((token) => detailSource.includes(token)));

  check('past scheduled detail has an explicit syncing/result branch', [
    "const isPastScheduled = match.status === 'SCHEDULED'",
    ') : isPastScheduled ? (',
    "'Match status syncing'",
    "'Awaiting official result'"
  ].every((token) => detailSource.includes(token)));

  check('partial review fields and tip labels are guarded', [
    'reviewHitRate === null',
    'postMatchReview?.actual?.had?.label',
    'postMatchReview?.actual?.hhad?.label',
    'postMatchReview?.scoreReview?.exactTop3',
    'localizedSignalText(row.tipLabel, row.tipCode',
    'row.tipLabel?.zh || row.tipLabel?.en || tipCodeLabel'
  ].every((token) => detailSource.includes(token))
    && !detailSource.includes('postMatchReview?.actual.had.label')
    && !detailSource.includes('row.tipLabel[language]'));

  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const viteCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-match-detail-vite-'));
  let vite;

  try {
    vite = await createServer({
      root: rootDir,
      configFile: false,
      cacheDir: viteCacheDir,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [{
        name: 'expose-match-detail-state-for-verification',
        enforce: 'pre',
        transform(code, id) {
          if (!/[\\/]src[\\/]pages[\\/]MatchDetail\.tsx$/.test(id)) return null;
          return code
            .replace('const getMatchFreshnessTime =', 'export const getMatchFreshnessTime =')
            .replace('const selectFreshestMatch =', 'export const selectFreshestMatch =')
            .replace('const isFormalPostReviewRow =', 'export const isFormalPostReviewRow =');
        }
      }]
    });

    const detailModule = await vite.ssrLoadModule('/src/pages/MatchDetail.tsx');
    const contextModule = await vite.ssrLoadModule('/src/context/AppContextCore.ts');
    const { MatchDetail, getMatchFreshnessTime, isFormalPostReviewRow, selectFreshestMatch } = detailModule;
    const { AppContext } = contextModule;
    const fixture = loadFixture();
    const now = Date.now();
    const formalSettledRow = {
      performanceTrack: 'formal',
      recommendationAction: 'recommend',
      reviewRole: 'main',
      resultStatus: 'WON'
    };
    check('formal detail metrics require the explicit formal track, main role, recommend action, and settled status',
      isFormalPostReviewRow(formalSettledRow)
      && !isFormalPostReviewRow({ ...formalSettledRow, performanceTrack: 'live-model' })
      && !isFormalPostReviewRow({ ...formalSettledRow, performanceTrack: 'reference' })
      && !isFormalPostReviewRow({ ...formalSettledRow, performanceTrack: 'provisional' })
      && !isFormalPostReviewRow({ ...formalSettledRow, recommendationAction: 'reference' })
      && !isFormalPostReviewRow({ ...formalSettledRow, reviewRole: 'reference' })
      && !isFormalPostReviewRow({ ...formalSettledRow, resultStatus: 'PENDING' }));
    const kickoffTime = new Date(now + 60 * 60_000).toISOString();
    const base = {
      ...clone(fixture),
      kickoffTime,
      eventVersion: kickoffTime,
      sourceMatchId: fixture.sourceMatchId || fixture.id
    };

    const staleScheduled = {
      ...base,
      status: 'SCHEDULED',
      sourceStatus: 'SCHEDULED',
      effectiveStatus: 'SCHEDULED',
      predictionMeta: {
        ...(base.predictionMeta || {}),
        updatedAt: new Date(now + 24 * 60 * 60_000).toISOString()
      }
    };
    delete staleScheduled.scoreHome;
    delete staleScheduled.scoreAway;
    delete staleScheduled.postMatchReview;
    delete staleScheduled.resultProvenance;

    const pendingContext = {
      ...base,
      status: 'PENDING_RESULT',
      sourceStatus: 'PENDING_RESULT',
      effectiveStatus: 'PENDING_RESULT',
      resultUpdatedAt: new Date(now - 60_000).toISOString()
    };
    const pendingSelected = selectFreshestMatch(staleScheduled, pendingContext, null, now);
    check('older PENDING_RESULT context cannot be hidden by a fresher SCHEDULED detail',
      pendingSelected?.status === 'PENDING_RESULT', { selectedStatus: pendingSelected?.status });

    const finishedContext = {
      ...base,
      status: 'FINISHED',
      sourceStatus: 'FINISHED',
      effectiveStatus: 'FINISHED',
      scoreHome: 2,
      scoreAway: 1,
      sourceUrl: 'https://webapi.sporttery.cn/gateway/uniform/fb/result.qry',
      resultUpdatedAt: new Date(now - 120_000).toISOString(),
      resultProvenance: {
        provider: 'sporttery',
        official: true,
        trusted: true,
        observedAt: new Date(now - 120_000).toISOString()
      }
    };
    const finishedSelected = selectFreshestMatch(staleScheduled, finishedContext, null, now);
    check('older official FINISHED context cannot regress to a fresher SCHEDULED detail',
      finishedSelected?.status === 'FINISHED'
      && finishedSelected?.scoreHome === 2
      && finishedSelected?.scoreAway === 1, {
        selectedStatus: finishedSelected?.status,
        selectedScore: `${finishedSelected?.scoreHome}:${finishedSelected?.scoreAway}`
      });

    const review = ({ revision, generatedAt, rows }) => ({
      version: 'post-match-review-v2',
      generatedAt,
      finalScore: '2-1',
      settlement: {
        resultRevision: revision,
        resultObservedAt: new Date(now - 120_000).toISOString(),
        reviewGeneratedAt: generatedAt
      },
      predictionReview: { rows }
    });
    const olderFinished = {
      ...finishedContext,
      postMatchReview: review({
        revision: 1,
        generatedAt: new Date(now - 90_000).toISOString(),
        rows: []
      })
    };
    const newerFinished = {
      ...finishedContext,
      postMatchReview: review({
        revision: 2,
        generatedAt: new Date(now - 89_000).toISOString(),
        rows: [{ tipCode: '1', resultStatus: 'WON' }]
      })
    };
    const detailOlderContextNewer = selectFreshestMatch(olderFinished, newerFinished, null, now);
    const detailNewerContextOlder = selectFreshestMatch(newerFinished, olderFinished, null, now);
    check('detail selection keeps the newest same-score review revision in both arrival orders', [
      detailOlderContextNewer,
      detailNewerContextOlder
    ].every((selected) => (
      selected?.postMatchReview?.settlement?.resultRevision === 2
      && selected?.postMatchReview?.predictionReview?.rows?.length === 1
    )), {
      olderThenNewer: detailOlderContextNewer?.postMatchReview?.settlement?.resultRevision,
      newerThenOlder: detailNewerContextOlder?.postMatchReview?.settlement?.resultRevision
    });

    const sameRevisionOlder = {
      ...newerFinished,
      postMatchReview: review({
        revision: 2,
        generatedAt: new Date(now - 88_000).toISOString(),
        rows: []
      })
    };
    const sameRevisionNewer = {
      ...newerFinished,
      postMatchReview: review({
        revision: 2,
        generatedAt: new Date(now - 87_000).toISOString(),
        rows: [{ tipCode: '1', resultStatus: 'WON' }]
      })
    };
    const generatedOlderThenNewer = selectFreshestMatch(sameRevisionOlder, sameRevisionNewer, null, now);
    const generatedNewerThenOlder = selectFreshestMatch(sameRevisionNewer, sameRevisionOlder, null, now);
    check('detail selection keeps the newest same-revision review generation in both arrival orders', [
      generatedOlderThenNewer,
      generatedNewerThenOlder
    ].every((selected) => selected?.postMatchReview?.predictionReview?.rows?.length === 1));

    const resultUpdatedAt = new Date(now - 30_000).toISOString();
    const observedAt = new Date(now - 10_000).toISOString();
    check('result provenance is the newest supported freshness signal',
      getMatchFreshnessTime({ resultUpdatedAt, resultProvenance: { observedAt } }) === Date.parse(observedAt));

    const oldKickoffEvent = {
      ...base,
      kickoffTime: new Date(now + 60 * 60_000).toISOString(),
      eventVersion: new Date(now + 60 * 60_000).toISOString(),
      updatedAt: new Date(now + 2 * 60_000).toISOString()
    };
    const rescheduledEvent = {
      ...base,
      kickoffTime: new Date(now + 3 * 60 * 60_000).toISOString(),
      eventVersion: new Date(now + 3 * 60 * 60_000).toISOString(),
      updatedAt: new Date(now + 60_000).toISOString()
    };
    const rescheduledSelected = selectFreshestMatch(oldKickoffEvent, rescheduledEvent, null, now);
    check('same id with a newer kickoff/event version cannot select the old detail payload',
      rescheduledSelected?.kickoffTime === rescheduledEvent.kickoffTime
      && rescheduledSelected?.eventVersion === rescheduledEvent.eventVersion, {
        selectedKickoff: rescheduledSelected?.kickoffTime,
        selectedEventVersion: rescheduledSelected?.eventVersion
      });

    const oldOpaqueRevision = {
      ...base,
      kickoffTime: new Date(now - 3 * 60 * 60_000).toISOString(),
      eventVersion: 'revision-1',
      updatedAt: new Date(now - 10 * 60_000).toISOString(),
      predictionMeta: undefined,
      gptPrediction: undefined,
      probabilityModel: undefined,
      externalSignals: undefined,
      oddsTrend: undefined,
      oddsUpdatedAt: undefined,
      handicapOddsUpdatedAt: undefined,
      resultUpdatedAt: undefined,
      resultProvenance: undefined,
      postMatchReview: undefined
    };
    const newOpaqueRevision = {
      ...oldOpaqueRevision,
      eventVersion: 'revision-2',
      updatedAt: undefined,
      capturedAt: new Date(now - 60_000).toISOString()
    };
    const opaqueRevisionSelected = selectFreshestMatch(oldOpaqueRevision, newOpaqueRevision, null, now);
    check('opaque event revisions use captured/updated timestamps to reject stale detail',
      opaqueRevisionSelected?.eventVersion === 'revision-2', {
        selectedEventVersion: opaqueRevisionSelected?.eventVersion,
        selectedFreshness: getMatchFreshnessTime(opaqueRevisionSelected)
      });

    const renderMatch = (match) => renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: contextValue(match) },
        React.createElement(MatchDetail, { matchId: match.id, onBack: () => {} })
      )
    );

    const recentlyStarted = {
      ...staleScheduled,
      kickoffTime: new Date(now - 60 * 60_000).toISOString(),
      eventVersion: new Date(now - 60 * 60_000).toISOString()
    };
    const recentlyStartedHtml = renderMatch(recentlyStarted);
    check('recently started raw SCHEDULED detail holds the lightweight syncing shell until authority settles',
      recentlyStartedHtml.includes('Match status syncing')
      && recentlyStartedHtml.includes('match-detail-fast-shell')
      && !recentlyStartedHtml.includes('Score Projection'));

    const overdueScheduled = {
      ...staleScheduled,
      kickoffTime: new Date(now - 180 * 60_000).toISOString(),
      eventVersion: new Date(now - 180 * 60_000).toISOString()
    };
    const overdueHtml = renderMatch(overdueScheduled);
    check('overdue raw SCHEDULED detail resolves to awaiting official result',
      overdueHtml.includes('Awaiting official result'));

    const pendingHtml = renderMatch({
      ...pendingContext,
      kickoffTime: new Date(now - 150 * 60_000).toISOString(),
      eventVersion: new Date(now - 150 * 60_000).toISOString(),
      oddsTrend: { sampleSize: 2, direction: 'flat' }
    });
    check('pending-result insight is settlement-only and tolerates a missing trend summary',
      pendingHtml.includes('Awaiting Official Result')
      && pendingHtml.includes('Result pending')
      && !pendingHtml.includes('Pick Direction'));

    const partialReviewFinished = {
      ...finishedContext,
      postMatchReview: {
        predictionReview: {
          rows: [{
            marketType: 'BEST',
            tipCode: '1',
            resultStatus: 'WON',
            recommendationAction: 'reference',
            reviewRole: 'reference'
          }]
        }
      }
    };
    let partialReviewHtml = '';
    let partialReviewError = null;
    try {
      partialReviewHtml = renderMatch(partialReviewFinished);
    } catch (error) {
      partialReviewError = error;
    }
    check('partial post-review and missing tipLabel render without crashing',
      !partialReviewError && partialReviewHtml.includes('Post-match Review'), {
        error: partialReviewError?.message
      });
  } finally {
    try {
      await vite?.close();
    } finally {
      fs.rmSync(viteCacheDir, { recursive: true, force: true });
    }
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
