const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  readSqliteFastResultReceiptState,
  readSqliteTransitionMatches,
} = require("../server/sqliteStore.cjs");
const {
  attachStoredPreMatchArchive,
  migrateLegacyFastResultIntegrity,
  publishOfficialResultsFast,
  publishSyncMetaRevision,
} = require("./publishOfficialResultsFast.cjs");
const {
  applyFastResultObservation,
  mergeFastResultObservations,
  normalizeObservation,
  overlayFastObservedFinals,
} = require("./fastResultObservations.cjs");
const {
  isOfficialSportteryFinal,
  officialSportteryResultUrl,
  resolveMatchLifecycle,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");
const {
  attachArchivedPreMatchPredictions,
  attachPostMatchReviews,
  matchesFromSportteryRelaySnapshot,
  settleTrustedPublishedPredictions,
} = require("./syncData.cjs");
const { acquireSyncMetaCommitLock } = require("./syncMetaCommitLock.cjs");
const {
  buildCollectorCommitment,
  createCollectorKeyPair,
  signCollectorCommitment,
} = require("../src/services/collectorAttestation.cjs");
const {
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
} = require("./sportteryEndpointContract.cjs");
const {
  FAST_RESULT_PUBLISHER_MACHINE_ENV,
  parseFastResultPublisherOutput,
} = require("./fastResultPublisherProtocol.cjs");
const {
  sportteryResultObservation,
  statusFromSportteryRow,
} = require("../src/services/sportteryResultSemantics.cjs");
const {
  resultFingerprint,
} = require("./sportteryFastResultLane.cjs");
const {
  authorityHighWaterCandidate,
  authorityHighWaterRow,
  loadAuthorityHighWater,
  mergeAuthorityHighWater,
  persistAuthorityHighWater,
} = require("./fastResultAuthorityHighWater.cjs");

const rootDir = path.resolve(__dirname, "..");
const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const sha256File = (filePath) => crypto.createHash("sha256")
  .update(fs.readFileSync(filePath))
  .digest("hex");
const publisherCollector = createCollectorKeyPair({
  keyId: "fast-result-publisher-regression",
  independenceDomain: "regression/fast-result-publisher",
});

const signedRelayEndpoint = ({
  method,
  payload,
  receivedAt,
  sourceCycleId,
  url = method === "result" ? SPORTTERY_RESULT_URL : SPORTTERY_CURRENT_URL,
}) => {
  const page = method === "result" ? 1 : null;
  const role = method === "result" ? "method:result" : "current";
  const sourceRequest = { url, method: "GET", page, role };
  const commitment = buildCollectorCommitment({
    provider: "sporttery",
    endpoint: sourceRequest,
    collectorCycleId: sourceCycleId,
    requestedAt: receivedAt,
    receivedAt,
    providerObservedAt: null,
    response: {},
    payload,
  });
  const collectorAttestation = signCollectorCommitment(commitment, publisherCollector);
  return {
    id: method === "result" ? "method:result:1" : "current",
    method,
    page,
    url,
    ok: true,
    fetchedAt: receivedAt,
    requestedAt: receivedAt,
    receivedAt,
    sourceCycleId,
    sourceRequest,
    collectorRole: role,
    canonicalPayloadSha256: commitment.canonicalPayloadSha256,
    collectorAttestation,
    collectorProvenance: {
      sourceCycleId,
      requestedAt: receivedAt,
      receivedAt,
      sourceRequest,
      canonicalPayloadSha256: commitment.canonicalPayloadSha256,
      collectorAttestation,
    },
    fastResultConstituent: {
      role: method === "result" ? "probe" : "companion",
      sourceCycleId,
      sourceCycleIds: [sourceCycleId],
      mixedSourceCycles: false,
      provenancePreserved: true,
    },
    payload,
  };
};

const signedFastSnapshot = ({
  resultPayload,
  capturedAt,
  sourceCycleId,
  resultUrl = SPORTTERY_RESULT_URL,
  currentPayload = null,
}) => {
  const companionPayload = currentPayload || {
    value: {
      matchInfoList: [{
        businessDate: "2026-07-13",
        subMatchList: [{ matchId: "publisher-market-companion", matchStatus: "0" }],
      }],
    },
  };
  const endpoints = [
    signedRelayEndpoint({
      method: "current",
      payload: companionPayload,
      receivedAt: capturedAt,
      sourceCycleId: `${sourceCycleId}:current`,
    }),
    signedRelayEndpoint({
      method: "result",
      payload: resultPayload,
      receivedAt: capturedAt,
      sourceCycleId: `${sourceCycleId}:result`,
      url: resultUrl,
    }),
  ];
  return {
    payload: {
      version: 1,
      source: "sporttery-fast-result-lane",
      capturedAt,
      sourceCycleId: `${sourceCycleId}:merge`,
    },
    summary: { capturedAt },
    entries: endpoints,
  };
};

const rawFastLaneSnapshot = (snapshot) => {
  const endpoints = snapshot.entries || [];
  const resultEndpoint = endpoints.find((entry) => (
    entry.method === "result" && Number(entry.page) === 1
  ));
  const rows = endpoints.reduce((sum, entry) => sum + (
    entry?.payload?.value?.matchInfoList || []
  ).reduce((daySum, day) => daySum + (
    Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0
  ), 0), 0);
  const resultRows = endpoints
    .filter((entry) => entry.method === "result" && Number(entry.page) === 1)
    .reduce((sum, entry) => sum + (
      entry?.payload?.value?.matchInfoList || []
    ).reduce((daySum, day) => daySum + (
      Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0
    ), 0), 0);
  return {
    ...(snapshot.payload || {}),
    sourceCycleKind: "upload-merge",
    producer: {
      fastResultLane: true,
      resultFingerprint: resultFingerprint(resultEndpoint),
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows,
      resultRows,
      errors: 0,
      methods: [...new Set(endpoints.map((entry) => entry.method))].sort(),
      fastResultLane: true,
    },
    endpoints,
    errors: [],
  };
};

const createDatabase = (
  dbPath,
  currentMatches = [],
  historyMatches = [],
  predictionSnapshots = []
) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE match_snapshots (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL,
      match_id TEXT,
      source_match_id TEXT,
      kickoff_time TEXT,
      status TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE prediction_snapshots (
      id TEXT PRIMARY KEY,
      state_key TEXT UNIQUE,
      match_id TEXT,
      source_match_id TEXT,
      phase TEXT,
      captured_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO match_snapshots
      (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [dataset, rows] of [["current", currentMatches], ["history", historyMatches]]) {
    for (const match of rows) {
      insert.run(
        `${dataset}:${match.id}`,
        dataset,
        match.id,
        match.sourceMatchId,
        match.kickoffTime,
        match.status,
        JSON.stringify(match)
      );
    }
  }
  const insertPredictionSnapshot = db.prepare(`
    INSERT INTO prediction_snapshots
      (id, state_key, match_id, source_match_id, phase, captured_at,
       first_seen_at, last_seen_at, seen_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, snapshot] of predictionSnapshots.entries()) {
    const capturedAt = snapshot.capturedAt || null;
    insertPredictionSnapshot.run(
      `prediction:${snapshot.sourceMatchId || snapshot.matchId || "unknown"}:${index}`,
      `state:${snapshot.sourceMatchId || snapshot.matchId || "unknown"}:${index}`,
      snapshot.matchId || null,
      snapshot.sourceMatchId || null,
      snapshot.phase || null,
      capturedAt,
      snapshot.firstSeenAt || capturedAt,
      snapshot.lastSeenAt || capturedAt,
      Number(snapshot.seenCount || 1),
      JSON.stringify(snapshot)
    );
  }
  db.close();
};

const readDbState = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, dataset, status, payload
      FROM match_snapshots
      ORDER BY dataset, id
    `).all().map((row) => ({ ...row, match: JSON.parse(row.payload) }));
    const meta = Object.fromEntries(db.prepare(
      "SELECT key, value FROM schema_meta ORDER BY key"
    ).all().map((row) => [row.key, row.value]));
    return { rows, meta };
  } finally {
    db.close();
  }
};

const authorityRowsFromState = (state) => Object.entries(state?.meta || {})
  .filter(([key]) => key.startsWith("fast_result_authority_high_water:event:"))
  .map(([, value]) => JSON.parse(value));

const baseCurrentMatch = ({
  sourceMatchId = "fast-1001",
  kickoffTime = "2026-07-13T10:00:00+08:00",
} = {}) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  source: "sporttery",
  sourceMethod: "relay:current",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry",
  status: "PENDING_RESULT",
  sourceStatus: "PENDING_RESULT",
  effectiveStatus: "PENDING_RESULT",
  statusReason: "source-pending-result",
  kickoffTime,
  eventVersion: kickoffTime,
  buyEndTime: "2026-07-13T09:55:00+08:00",
  matchNo: "周一001",
  homeTeamId: "home-fast",
  awayTeamId: "away-fast",
  homeTeamName: "主队",
  awayTeamName: "客队",
  handicapLine: "-1",
  odds: { odds1: 1.9, oddsX: 3.2, odds2: 3.6 },
  handicapOdds: { odds1: 3.1, oddsX: 3.45, odds2: 1.85 },
  predictions: [{
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    handicapLine: "-1",
    tipCode: "2",
    tipLabel: { zh: "让负", en: "Handicap away" },
    odds: 1.85,
    trustScore: 68,
    recommendationAction: "recommend",
    recommendationTier: "multi-factor",
    multiFactorEvidence: {
      version: "multi-factor-market-evidence-v2",
      eligible: true,
      market: "HHAD",
      code: "2",
      handicapLine: "-1",
      odds: 1.85,
      blockers: [],
    },
  }],
  predictionMeta: {
    cutoffTime: "2026-07-13T09:55:00+08:00",
    lockedAt: "2026-07-13T09:55:00+08:00",
    lockedReason: "sale-cutoff",
  },
});

const referenceSnapshot = ({
  sourceMatchId = "fast-1001",
  kickoffTime = "2026-07-13T10:00:00+08:00",
  capturedAt = "2026-07-13T01:50:00.000Z",
  tipCode = "1",
} = {}) => ({
  capturedAt,
  decisionAt: capturedAt,
  sourceCycleId: `sporttery-full-sync:${capturedAt}`,
  sourceMatchId,
  matchId: `sporttery_${sourceMatchId}`,
  kickoffTime,
  eventVersion: kickoffTime,
  cutoffTime: "2026-07-13T09:55:00+08:00",
  phase: "final",
  signature: `1X2::${tipCode}:reference|BEST::${tipCode}:reference`,
  best: {
    tipCode,
    oddsPoolCode: null,
    odds: 0,
    trustScore: 38,
    recommendationAction: "reference",
    recommendationTier: "cold-start-reference",
    riskCount: 2,
  },
  oneXTwo: {
    tipCode,
    oddsPoolCode: null,
    odds: 0,
    trustScore: 38,
    recommendationAction: "reference",
    recommendationTier: "cold-start-reference",
    riskCount: 2,
  },
});

const strictOfficialReferenceSnapshot = ({
  sourceMatchId = "fast-1001",
  kickoffTime = "2026-07-13T10:00:00+08:00",
  cutoffTime = "2026-07-13T09:55:00+08:00",
  capturedAt = "2026-07-13T01:50:00.000Z",
  businessDate = "2026-07-13",
  matchNo = "鍛ㄤ竴001",
  tipCode = "X",
  odds = 4.05,
  recommendationAction = "reference",
} = {}) => ({
  capturedAt,
  decisionAt: capturedAt,
  sourceCycleId: `sporttery-full-sync:${capturedAt}`,
  sourceMatchId,
  matchId: `sporttery_${sourceMatchId}`,
  matchNo,
  businessDate,
  matchDate: kickoffTime.slice(0, 10),
  homeTeamName: baseCurrentMatch().homeTeamName,
  awayTeamName: baseCurrentMatch().awayTeamName,
  kickoffTime,
  eventVersion: kickoffTime,
  cutoffTime,
  phase: "final",
  signature: `1X2:HAD:${tipCode}:${recommendationAction}|BEST:HAD:${tipCode}:${recommendationAction}`,
  best: {
    tipCode,
    oddsPoolCode: "HAD",
    odds,
    trustScore: 62,
    recommendationAction,
    recommendationTier: "data-reference",
    riskCount: 1,
  },
  oneXTwo: {
    tipCode,
    oddsPoolCode: "HAD",
    odds,
    trustScore: 62,
    recommendationAction,
    recommendationTier: "data-reference",
    riskCount: 1,
  },
  decisionSnapshot: {
    kickoffTime,
    cutoffTime,
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      cutoffTime,
      kickoffTime,
    },
  },
});

const trustedUefaHistoryMatch = ({
  sourceMatchId = "fast-uniform-uefa-history",
  kickoffTime = "2026-07-13T10:00:00+08:00",
  scoreHome = 2,
  scoreAway = 1,
  observedAt = "2026-07-13T02:03:00.000Z",
} = {}) => {
  const match = {
    ...baseCurrentMatch({ sourceMatchId, kickoffTime }),
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    statusReason: "official-uefa-final",
    scoreHome,
    scoreAway,
    resultSource: "uefa:official-match-api",
    resultUpdatedAt: observedAt,
    resultSourceUpdatedAt: null,
    resultObservedAt: observedAt,
    resultObservationSource: "uefa-official-response-received-at",
    resultObservationFallback: false,
    settledAt: observedAt,
  };
  const responseSha256 = "a".repeat(64);
  const provenance = {
    version: "trusted-official-result-provenance-v2",
    provider: "uefa",
    source: "uefa:official-match-api",
    sourceKind: "official-competition-organizer",
    providerMatchId: `uefa-${sourceMatchId}`,
    sourceMatchId,
    eventVersion: kickoffTime,
    providerKickoffTime: kickoffTime,
    scoreKind: "regular-time",
    official: true,
    trusted: true,
    observedAt,
    observationSource: "uefa-official-response-received-at",
    resultObservationFallback: false,
    sourceUpdatedAt: null,
    responseSha256,
    resultRevision: 1,
  };
  provenance.evidenceHash = crypto.createHash("sha256").update(JSON.stringify({
    provider: "uefa",
    providerMatchId: provenance.providerMatchId,
    sourceMatchId,
    eventVersion: kickoffTime,
    providerKickoff: kickoffTime,
    scoreHome,
    scoreAway,
    scoreKind: "regular-time",
    responseSha256,
  })).digest("hex");
  return resolveMatchLifecycle({
    ...match,
    resultProvenance: provenance,
  }, { now: observedAt });
};

const relaySnapshot = ({
  sourceMatchId = "fast-1001",
  matchDate = "2026-07-13",
  matchTime = "10:00:00",
  scoreHome = 2,
  scoreAway = 1,
  url = SPORTTERY_RESULT_URL,
  capturedAt = new Date().toISOString(),
  sourceCycleId = `publisher-${sourceMatchId}-${capturedAt}`,
  rowOverrides = {},
} = {}) => signedFastSnapshot({
  capturedAt,
  sourceCycleId,
  resultUrl: url,
  resultPayload: {
      value: {
        matchInfoList: [{
          businessDate: matchDate,
          subMatchList: [{
            matchId: sourceMatchId,
            businessDate: matchDate,
            matchDate,
            matchTime,
            matchStatus: "11",
            matchStatusName: "Finished",
            matchNumStr: "周一001",
            homeTeamAllName: baseCurrentMatch().homeTeamName,
            awayTeamAllName: baseCurrentMatch().awayTeamName,
            homeTeamId: "home-fast",
            awayTeamId: "away-fast",
            leagueAllName: "fixture-league",
            sectionsNo999: `${scoreHome}:${scoreAway}`,
            ...rowOverrides,
          }],
        }],
      },
    },
});

const uniformResultRelaySnapshot = ({
  sourceMatchId = "fast-uniform-1001",
  matchDate = "2026-07-13",
  scoreHome = 2,
  scoreAway = 1,
  capturedAt = "2026-07-13T02:05:00.000Z",
} = {}) => signedFastSnapshot({
  capturedAt,
  sourceCycleId: `publisher-uniform-${sourceMatchId}-${capturedAt}`,
  resultPayload: {
      errorCode: "0",
      success: true,
      value: {
        lastUpdateTime: "2026-07-13 10:04:00",
        matchInfoList: [{
          businessDate: matchDate,
          subMatchList: [{
            matchId: sourceMatchId,
            businessDate: matchDate,
            matchDate,
            matchStatus: "11",
            matchStatusName: "赛果",
            matchResultStatus: "2",
            poolStatus: "Payout",
            matchNumStr: "周一001",
            homeTeamAllName: "主队",
            awayTeamAllName: "客队",
            homeTeamId: "home-fast",
            awayTeamId: "away-fast",
            leagueAllName: "测试联赛",
            sectionsNo999: `${scoreHome}:${scoreAway}`,
            sourceUpdatedAt: "2026-07-13T02:04:00.000Z",
            officialResultIdentity: {
              provider: "sporttery",
              endpoint: "getUniformMatchResultV1",
              matchId: sourceMatchId,
              matchResultStatus: "2",
              poolStatus: "Payout",
              providerUpdatedAt: "2026-07-13T02:04:00.000Z",
              scheduleTimeAuthority: "omitted-by-official-result-feed",
            },
          }],
        }],
      },
    },
});

const combinedRelaySnapshot = (...snapshots) => {
  const last = snapshots[snapshots.length - 1] || {};
  const capturedAt = last?.summary?.capturedAt || new Date().toISOString();
  const matchInfoList = snapshots.flatMap((snapshot) => {
    const result = (snapshot.entries || []).find((entry) => (
      entry.method === "result" && Number(entry.page) === 1
    ));
    return result?.payload?.value?.matchInfoList || [];
  });
  return signedFastSnapshot({
    capturedAt,
    sourceCycleId: `publisher-combined-${capturedAt}`,
    resultPayload: { value: { matchInfoList } },
  });
};

const scenario = (
  baseDir,
  name,
  currentMatches = [],
  historyMatches = [],
  predictionSnapshots = []
) => {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "football.db");
  const syncMetaPath = path.join(dir, "sync-meta.json");
  const ledgerPath = path.join(dir, "missing-publication-ledger.json");
  createDatabase(dbPath, currentMatches, historyMatches, predictionSnapshots);
  fs.writeFileSync(syncMetaPath, `${JSON.stringify({
    version: "fixture-sync-meta",
    sentinel: { preserve: true },
    api: { currentFreshnessTime: "2026-07-13T01:00:00.000Z" },
  }, null, 2)}\n`);
  return {
    dbPath,
    syncMetaPath,
    publicationLedgerPath: ledgerPath,
    trustRegistry: publisherCollector.registry,
  };
};

const run = async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-fast-result-"));
  try {
    const observedAt = "2026-07-13T02:05:00.000Z";
    const capturedAt = observedAt;
    const overLegacyCapCandidates = Array.from({ length: 513 }, (_, index) => (
      authorityHighWaterCandidate({
        match: {
          ...baseCurrentMatch({ sourceMatchId: `authority-cap-${index + 1}` }),
          scoreHome: index % 5,
          scoreAway: index % 3,
        },
        observedAt,
        sourceCycleId: `authority-cap-cycle-${index + 1}`,
        resultProbeRevisionId: `authority-cap-probe-${index + 1}`,
      })
    ));
    const overLegacyCapMerge = mergeAuthorityHighWater(
      { valid: true, missing: true, initialized: false, rows: [] },
      overLegacyCapCandidates,
    );
    check("authority high-water retains more than the legacy 512-event window without eviction", (
      overLegacyCapCandidates.every(Boolean)
      && overLegacyCapMerge.valid === true
      && overLegacyCapMerge.overflow === false
      && overLegacyCapMerge.rows.length === 513
      && overLegacyCapMerge.changedRows.length === 513
    ), {
      rows: overLegacyCapMerge.rows.length,
      changedRows: overLegacyCapMerge.changedRows.length,
    });

    const persistedCapFirstMatch = baseCurrentMatch({ sourceMatchId: "authority-persist-1" });
    const persistedCapPaths = scenario(
      tempRoot,
      "authority-high-water-persisted-over-512",
      [persistedCapFirstMatch],
    );
    const persistedCapFirstPublication = publishOfficialResultsFast({
      ...persistedCapPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: persistedCapFirstMatch.sourceMatchId,
        capturedAt: observedAt,
      }),
      observedAt,
    });
    const persistedCapBusinessBaseline = readDbState(persistedCapPaths.dbPath);
    const persistedCapHistoryBaseline = persistedCapBusinessBaseline.rows.find(
      (row) => row.dataset === "history"
        && row.match.sourceMatchId === persistedCapFirstMatch.sourceMatchId,
    )?.payload || null;
    const persistedCapReceiptBaseline = persistedCapBusinessBaseline.meta.fast_result_receipt || null;
    const persistedCapRevisionBaseline = persistedCapBusinessBaseline.meta.fast_result_revision || null;
    const persistedCapMatches = Array.from({ length: 513 }, (_, index) => ({
      ...baseCurrentMatch({ sourceMatchId: `authority-persist-${index + 1}` }),
      scoreHome: index === 0 ? 2 : index % 5,
      scoreAway: index === 0 ? 1 : index % 3,
    }));
    const persistedCapCandidates = persistedCapMatches.slice(1).map((match, index) => (
      authorityHighWaterCandidate({
        match,
        observedAt,
        sourceCycleId: `authority-persist-cycle-${index + 2}`,
        resultProbeRevisionId: `authority-persist-probe-${index + 2}`,
      })
    ));
    let persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath);
    let persistedCapLedger = loadAuthorityHighWater(persistedCapDb);
    const persistedCapMerge = mergeAuthorityHighWater(persistedCapLedger, persistedCapCandidates);
    persistedCapDb.exec("BEGIN IMMEDIATE");
    persistAuthorityHighWater(persistedCapDb, persistedCapMerge, observedAt);
    persistedCapDb.exec("COMMIT");
    persistedCapDb.close();

    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath, { readOnly: true });
    const persistedCapReopened513 = loadAuthorityHighWater(persistedCapDb);
    const persistedCapFirst513 = authorityHighWaterRow(
      persistedCapReopened513,
      persistedCapMatches[0],
    );
    const persistedCapLast513 = authorityHighWaterRow(
      persistedCapReopened513,
      persistedCapMatches[512],
    );
    persistedCapDb.close();

    const persistedCapMatch514 = {
      ...baseCurrentMatch({ sourceMatchId: "authority-persist-514" }),
      scoreHome: 4,
      scoreAway: 2,
    };
    const persistedCapCandidate514 = authorityHighWaterCandidate({
      match: persistedCapMatch514,
      observedAt: "2026-07-13T02:05:30.000Z",
      sourceCycleId: "authority-persist-cycle-514",
      resultProbeRevisionId: "authority-persist-probe-514",
    });
    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath);
    persistedCapLedger = loadAuthorityHighWater(persistedCapDb);
    const persistedCapMerge514 = mergeAuthorityHighWater(
      persistedCapLedger,
      [persistedCapCandidate514],
    );
    persistedCapDb.exec("BEGIN IMMEDIATE");
    persistAuthorityHighWater(
      persistedCapDb,
      persistedCapMerge514,
      persistedCapCandidate514.observedAt,
    );
    persistedCapDb.exec("COMMIT");
    persistedCapDb.close();

    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath);
    persistedCapLedger = loadAuthorityHighWater(persistedCapDb);
    const persistedCapFirstNewer = authorityHighWaterCandidate({
      match: persistedCapMatches[0],
      observedAt: "2026-07-13T02:07:00.000Z",
      sourceCycleId: "authority-persist-cycle-1-newer-noop",
      resultProbeRevisionId: "authority-persist-probe-1-newer-noop",
    });
    const persistedCapNewerMerge = mergeAuthorityHighWater(
      persistedCapLedger,
      [persistedCapFirstNewer],
    );
    persistedCapDb.exec("BEGIN IMMEDIATE");
    persistAuthorityHighWater(
      persistedCapDb,
      persistedCapNewerMerge,
      persistedCapFirstNewer.observedAt,
    );
    persistedCapDb.exec("COMMIT");
    persistedCapDb.close();

    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath, { readOnly: true });
    const persistedCapBeforeRejectedCorrection = loadAuthorityHighWater(persistedCapDb);
    persistedCapDb.close();
    const persistedCapStateBeforeRejectedCorrection = readDbState(persistedCapPaths.dbPath);
    const persistedCapHashBeforeRejectedCorrection = sha256File(persistedCapPaths.dbPath);
    const persistedCapOlderCorrection = authorityHighWaterCandidate({
      match: {
        ...persistedCapMatches[0],
        scoreHome: 3,
        scoreAway: 1,
      },
      observedAt: "2026-07-13T02:06:00.000Z",
      sourceCycleId: "authority-persist-cycle-1-older-correction",
      resultProbeRevisionId: "authority-persist-probe-1-older-correction",
    });
    const persistedCapRejectedMerge = mergeAuthorityHighWater(
      persistedCapBeforeRejectedCorrection,
      [persistedCapOlderCorrection],
    );
    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath);
    const persistedCapRejectedWrite = persistAuthorityHighWater(
      persistedCapDb,
      persistedCapRejectedMerge,
      persistedCapOlderCorrection.observedAt,
    );
    persistedCapDb.close();
    const persistedCapHashAfterRejectedCorrection = sha256File(persistedCapPaths.dbPath);
    const persistedCapStateAfterRejectedCorrection = readDbState(persistedCapPaths.dbPath);
    persistedCapDb = new DatabaseSync(persistedCapPaths.dbPath, { readOnly: true });
    const persistedCapAfterRejectedCorrection = loadAuthorityHighWater(persistedCapDb);
    const persistedCapFirstAfterRejected = authorityHighWaterRow(
      persistedCapAfterRejectedCorrection,
      persistedCapMatches[0],
    );
    const persistedCapLastAfterRejected = authorityHighWaterRow(
      persistedCapAfterRejectedCorrection,
      persistedCapMatch514,
    );
    persistedCapDb.close();
    const persistedCapHistoryAfter = persistedCapStateAfterRejectedCorrection.rows.find(
      (row) => row.dataset === "history"
        && row.match.sourceMatchId === persistedCapFirstMatch.sourceMatchId,
    )?.payload || null;
    check("SQLite authority high-water persists 513 plus one rows and rejects an older boundary correction byte-for-byte", (
      persistedCapFirstPublication.publishedRows === 1
      && persistedCapMerge.valid === true
      && persistedCapMerge.rows.length === 513
      && persistedCapReopened513.valid === true
      && persistedCapReopened513.initialized === true
      && persistedCapReopened513.manifest?.rows === 513
      && persistedCapReopened513.manifest?.rootHash
      && persistedCapFirst513?.sourceMatchId === "authority-persist-1"
      && persistedCapLast513?.sourceMatchId === "authority-persist-513"
      && persistedCapMerge514.valid === true
      && persistedCapMerge514.rows.length === 514
      && persistedCapNewerMerge.valid === true
      && persistedCapNewerMerge.changedRows.length === 1
      && persistedCapBeforeRejectedCorrection.valid === true
      && persistedCapBeforeRejectedCorrection.rows.length === 514
      && persistedCapBeforeRejectedCorrection.manifest?.updatedAt
        === persistedCapFirstNewer.observedAt
      && persistedCapRejectedMerge.valid === false
      && persistedCapRejectedMerge.scoreConflict === true
      && persistedCapRejectedWrite === false
      && persistedCapHashAfterRejectedCorrection === persistedCapHashBeforeRejectedCorrection
      && persistedCapAfterRejectedCorrection.valid === true
      && persistedCapAfterRejectedCorrection.rows.length === 514
      && persistedCapAfterRejectedCorrection.manifest?.rootHash
        === persistedCapBeforeRejectedCorrection.manifest?.rootHash
      && persistedCapFirstAfterRejected?.scoreHome === 2
      && persistedCapFirstAfterRejected?.scoreAway === 1
      && persistedCapFirstAfterRejected?.observedAt === persistedCapFirstNewer.observedAt
      && persistedCapLastAfterRejected?.sourceMatchId === "authority-persist-514"
      && persistedCapStateAfterRejectedCorrection.meta.fast_result_receipt
        === persistedCapReceiptBaseline
      && persistedCapStateAfterRejectedCorrection.meta.fast_result_revision
        === persistedCapRevisionBaseline
      && persistedCapHistoryAfter === persistedCapHistoryBaseline
      && JSON.stringify(persistedCapStateAfterRejectedCorrection)
        === JSON.stringify(persistedCapStateBeforeRejectedCorrection)
    ), {
      firstPublished: persistedCapFirstPublication.publishedRows,
      rowsAfter513: persistedCapReopened513.rows.length,
      rowsAfter514: persistedCapAfterRejectedCorrection.rows.length,
      initialized: persistedCapReopened513.initialized,
      firstPresent: Boolean(persistedCapFirst513),
      last513Present: Boolean(persistedCapLast513),
      last514Present: Boolean(persistedCapLastAfterRejected),
      maxClock: persistedCapAfterRejectedCorrection.manifest?.updatedAt || null,
      scoreConflict: persistedCapRejectedMerge.scoreConflict === true,
      rejectedWrite: persistedCapRejectedWrite,
      databaseHashUnchanged:
        persistedCapHashAfterRejectedCorrection === persistedCapHashBeforeRejectedCorrection,
      receiptUnchanged:
        persistedCapStateAfterRejectedCorrection.meta.fast_result_receipt
          === persistedCapReceiptBaseline,
      revisionUnchanged:
        persistedCapStateAfterRejectedCorrection.meta.fast_result_revision
          === persistedCapRevisionBaseline,
      historyUnchanged: persistedCapHistoryAfter === persistedCapHistoryBaseline,
      rootUnchanged:
        persistedCapAfterRejectedCorrection.manifest?.rootHash
          === persistedCapBeforeRejectedCorrection.manifest?.rootHash,
    });
    const trustedPaths = scenario(tempRoot, "trusted", [baseCurrentMatch()]);
    const trustedSnapshot = relaySnapshot({ capturedAt });
    const first = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const firstState = readDbState(trustedPaths.dbPath);
    const history = firstState.rows.find((row) => row.dataset === "history")?.match;
    const firstAuthority = authorityRowsFromState(firstState)[0] || null;
    const bestReview = history?.postMatchReview?.predictionReview?.rows?.find((row) => row.marketType === "BEST");
    const publicMeta = JSON.parse(fs.readFileSync(trustedPaths.syncMetaPath, "utf8"));
    check("trusted official result publishes current to history", (
      first.ok === true
      && first.skipped === false
      && first.publishedRows === 1
      && firstState.rows.filter((row) => row.dataset === "current").length === 0
      && firstState.rows.filter((row) => row.dataset === "history").length === 1
      && history?.status === "FINISHED"
      && history?.scoreHome === 2
      && history?.scoreAway === 1
      && firstAuthority?.scoreHome === history?.scoreHome
      && firstAuthority?.scoreAway === history?.scoreAway
      && firstAuthority?.observedAt === observedAt
    ), { publishedRows: first.publishedRows, datasets: firstState.rows.map((row) => row.dataset) });
    check("fast publication preserves displayed predictions but excludes unsnapshotted performance", (
      history?.predictions?.length === 1
      && history.predictions[0].tipCode === "2"
      && history.predictions[0].resultStatus === "LOST"
      && Boolean(history?.postMatchReview)
      && history?.postMatchReview?.predictionReview?.rows?.length === 0
      && history?.postMatchReview?.predictionReview?.referenceSettled === 0
    ), {
      predictions: history?.predictions?.length ?? null,
      cardResultStatus: history?.predictions?.[0]?.resultStatus || null,
      bestStatus: bestReview?.resultStatus || null,
    });
    check("missing publication ledger and pre-match snapshot fail closed outside performance", (
      first.ledger?.missing === true
      && bestReview === undefined
      && history?.postMatchReview?.predictionReview?.mainSettled === 0
      && history?.postMatchReview?.predictionReview?.referenceSettled === 0
    ), { ledgerMissing: first.ledger?.missing, reviewRole: bestReview?.reviewRole || null });
    check("result audit timestamps are embedded on first publication", (
      history?.resultObservedAt === observedAt
      && history?.settledAt === observedAt
      && history?.postMatchReview?.settlement?.resultObservedAt === observedAt
      && history?.postMatchReview?.settlement?.settledAt === observedAt
    ), {
      resultObservedAt: history?.resultObservedAt || null,
      settlementObservedAt: history?.postMatchReview?.settlement?.resultObservedAt || null,
    });
    check("fast result identity revisions are embedded in match and review settlement", (
      history?.sourceCycleId === first.sourceCycleId
      && history?.datasetRevision === first.datasetRevision
      && history?.postMatchReview?.settlement?.sourceCycleId === first.sourceCycleId
      && history?.postMatchReview?.settlement?.datasetRevision === first.datasetRevision
    ), {
      sourceCycleId: history?.sourceCycleId || null,
      datasetRevision: history?.datasetRevision || null,
    });
    check("schema_meta and public sync-meta freshness advance without replacing other fields", (
      firstState.meta.fast_result_published_at === first.publishedAt
      && firstState.meta.source_cycle_id === first.sourceCycleId
      && firstState.meta.dataset_revision === first.datasetRevision
      && firstState.meta.fast_result_revision === "1"
      && Boolean(firstState.meta.fast_result_receipt)
      && publicMeta.fastResultRevision === 1
      && publicMeta.fastResultPublication?.datasetRevision === first.datasetRevision
      && publicMeta.fastResultObservations?.rows?.length === 1
      && publicMeta.api.resultFreshnessTime === first.publishedAt
      && publicMeta.api.historyFreshnessTime === first.publishedAt
      && publicMeta.api.currentFreshnessTime === first.publishedAt
      && publicMeta.api.freshnessTime === first.publishedAt
      && publicMeta.sourceHealth?.currentFreshnessTime === first.publishedAt
      && publicMeta.sourceHealth?.resultFreshnessTime === first.publishedAt
      && publicMeta.sentinel?.preserve === true
    ), { schemaMeta: firstState.meta, fastResultRevision: publicMeta.fastResultRevision });
    const observation = publicMeta.fastResultObservations?.rows?.[0] || null;
    check("sync-meta persists an exact deduplicated first-result observation", (
      observation?.sourceMatchId === history?.sourceMatchId
      && Date.parse(observation?.eventVersion || "") === Date.parse(history?.eventVersion || "")
      && observation?.scoreHome === history?.scoreHome
      && observation?.scoreAway === history?.scoreAway
      && observation?.resultObservedAt === observedAt
      && observation?.sourceCycleId === first.sourceCycleId
      && observation?.datasetRevision === first.datasetRevision
    ), { observation });

    const archiveRepairPaths = scenario(
      tempRoot,
      "archive-repair",
      [],
      [history],
      [
        referenceSnapshot(),
        referenceSnapshot({
          capturedAt: "2026-07-13T02:10:00.000Z",
          tipCode: "2",
        }),
      ]
    );
    const archiveRepair = publishOfficialResultsFast({
      ...archiveRepairPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const archiveRepairState = readDbState(archiveRepairPaths.dbPath);
    const archiveRepairHistory = archiveRepairState.rows
      .find((row) => row.dataset === "history")?.match;
    const repairedArchive = archiveRepairHistory?.archivedPreMatchPrediction;
    const repairedReferenceBest = archiveRepairHistory?.postMatchReview
      ?.predictionReview?.rows?.find((row) => row.marketType === "BEST");
    let lazySnapshotReads = 0;
    const lazyRows = [referenceSnapshot(), referenceSnapshot({ capturedAt: "2026-07-13T02:10:00.000Z", tipCode: "2" })];
    const lazyPayload = () => { lazySnapshotReads++; return { rows: lazyRows }; };
    const retainedLazy = attachArchivedPreMatchPredictions([archiveRepairHistory], lazyPayload, null, observedAt)[0];
    check("valid frozen archive resolves without reading historical snapshot payloads", (
      lazySnapshotReads === 0
      && JSON.stringify(retainedLazy) === JSON.stringify(attachArchivedPreMatchPredictions([archiveRepairHistory], { rows: lazyRows }, null, observedAt)[0])
    ));
    const noReadDb = { prepare() { throw new Error("unneeded-snapshot-read"); } };
    check("fast publisher preserves a valid archive without touching prediction snapshot SQL", (
      JSON.stringify(attachStoredPreMatchArchive({ db: noReadDb, match: archiveRepairHistory, capturedAt: observedAt }))
        === JSON.stringify(retainedLazy)
    ));
    const missingLazyArchive = { ...archiveRepairHistory }; delete missingLazyArchive.archivedPreMatchPrediction;
    const rebuiltLazy = attachArchivedPreMatchPredictions([missingLazyArchive, missingLazyArchive], lazyPayload, null, observedAt);
    check("missing archive loads one complete shared snapshot index with eager-equivalent output", (
      lazySnapshotReads === 1
      && JSON.stringify(rebuiltLazy) === JSON.stringify(attachArchivedPreMatchPredictions([missingLazyArchive, missingLazyArchive], { rows: lazyRows }, null, observedAt))
    ));
    const lateOnly = { rows: [referenceSnapshot({ capturedAt: "2026-07-13T02:10:00.000Z", tipCode: "2" })] };
    check("lazy snapshot path still rejects post-cutoff evidence", (
      JSON.stringify(attachArchivedPreMatchPredictions([missingLazyArchive], () => lateOnly, null, observedAt))
        === JSON.stringify(attachArchivedPreMatchPredictions([missingLazyArchive], lateOnly, null, observedAt))
      && !attachArchivedPreMatchPredictions([missingLazyArchive], () => lateOnly, null, observedAt)[0].archivedPreMatchPrediction
    ));
    let lazyFailure = null;
    try { attachArchivedPreMatchPredictions([missingLazyArchive], () => { throw new Error("snapshot-read-failed"); }, null, observedAt); }
    catch (error) { lazyFailure = error.message; }
    check("required lazy snapshot read failures remain fail-closed", lazyFailure === "snapshot-read-failed");
    let invalidReads = 0;
    const invalidLazyArchive = { ...archiveRepairHistory, archivedPreMatchPrediction: { ...repairedArchive, capturedAt: "2026-07-13T02:10:00.000Z" } };
    const invalidLazy = attachArchivedPreMatchPredictions([invalidLazyArchive], () => { invalidReads++; return { rows: lazyRows }; }, null, observedAt);
    check("invalid frozen archive cannot bypass snapshot validation through lazy loading", (
      invalidReads === 1 && JSON.stringify(invalidLazy) === JSON.stringify(attachArchivedPreMatchPredictions([invalidLazyArchive], { rows: lazyRows }, null, observedAt))
    ));
    check("fast result repairs a missing archive only from stored pre-cutoff snapshots", (
      archiveRepair.ok === true
      && archiveRepair.skipped === false
      && archiveRepair.publishedRows === 1
      && repairedArchive?.version === "archived-pre-match-prediction-v1"
      && repairedArchive?.source === "immutable-pre-match-prediction-snapshot"
      && repairedArchive?.marketEvidenceScope === "model-only-reference"
      && repairedArchive?.capturedAt === "2026-07-13T01:50:00.000Z"
      && repairedArchive?.prediction?.oddsPoolCode === "HAD"
      && repairedArchive?.prediction?.tipCode === "1"
      && repairedArchive?.prediction?.odds === 0
      && repairedArchive?.prediction?.recommendationAction === "reference"
      && repairedReferenceBest?.tipCode === "1"
      && repairedReferenceBest?.reviewRole === "reference"
      && repairedReferenceBest?.resultStatus === "WON"
    ), {
      publishedRows: archiveRepair.publishedRows,
      archive: repairedArchive || null,
      referenceBest: repairedReferenceBest || null,
    });
    const archiveRepairReplay = publishOfficialResultsFast({
      ...archiveRepairPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const archiveReplayHistory = readDbState(archiveRepairPaths.dbPath).rows
      .find((row) => row.dataset === "history")?.match;
    check("repeated fast result polling preserves the repaired archive byte-for-byte", (
      archiveRepairReplay.ok === true
      && archiveRepairReplay.skipped === true
      && archiveRepairReplay.reason === "no-result-state-change-fast-path"
      && JSON.stringify(archiveReplayHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive)
    ), {
      reason: archiveRepairReplay.reason || null,
      archiveStable: JSON.stringify(archiveReplayHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive),
    });

    const midnightHistorySeed = JSON.parse(JSON.stringify(history));
    delete midnightHistorySeed.archivedPreMatchPrediction;
    midnightHistorySeed.kickoffTime = "2026-07-13T00:00:00+08:00";
    midnightHistorySeed.eventVersion = midnightHistorySeed.kickoffTime;
    midnightHistorySeed.matchDate = "2026-07-13";
    midnightHistorySeed.businessDate = "2026-07-13";
    midnightHistorySeed.matchNo = "鍛ㄤ竴001";
    midnightHistorySeed.buyEndTime = midnightHistorySeed.kickoffTime;
    midnightHistorySeed.predictionMeta = {
      ...(midnightHistorySeed.predictionMeta || {}),
      cutoffTime: midnightHistorySeed.kickoffTime,
    };
    midnightHistorySeed.officialResultIdentity = {
      provider: "sporttery",
      endpoint: "getUniformMatchResultV1",
      matchId: midnightHistorySeed.sourceMatchId,
      matchResultStatus: "2",
      poolStatus: "Payout",
      scheduleTimeAuthority: "inherited-pre-match-event-identity",
    };
    const strictSnapshot = strictOfficialReferenceSnapshot();
    const midnightArchivePaths = scenario(
      tempRoot,
      "midnight-history-archive-repair",
      [],
      [midnightHistorySeed],
      [strictSnapshot]
    );
    const midnightArchiveRepair = publishOfficialResultsFast({
      ...midnightArchivePaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: midnightHistorySeed.sourceMatchId,
      }),
      observedAt,
    });
    const midnightArchiveState = readDbState(midnightArchivePaths.dbPath);
    const midnightArchiveHistory = midnightArchiveState.rows
      .find((row) => row.dataset === "history")?.match;
    const midnightArchiveAssertions = {
      ok: midnightArchiveRepair.ok === true,
      notSkipped: midnightArchiveRepair.skipped === false,
      onePublished: midnightArchiveRepair.publishedRows === 1,
      kickoffRecovered: Date.parse(midnightArchiveHistory?.kickoffTime || "")
        === Date.parse(strictSnapshot.kickoffTime),
      eventRecovered: Date.parse(midnightArchiveHistory?.eventVersion || "")
        === Date.parse(strictSnapshot.eventVersion),
      recoveryVersion: midnightArchiveHistory?.resultEventClockRecovery?.version
        === "sqlite-pre-match-event-clock-recovery-v1",
      oneEvidenceRow: midnightArchiveHistory?.resultEventClockRecovery?.evidenceRows === 1,
      had: midnightArchiveHistory?.archivedPreMatchPrediction?.prediction?.oddsPoolCode === "HAD",
      draw: midnightArchiveHistory?.archivedPreMatchPrediction?.prediction?.tipCode === "X",
      odds: midnightArchiveHistory?.archivedPreMatchPrediction?.prediction?.odds === 4.05,
      reference: midnightArchiveHistory?.archivedPreMatchPrediction?.prediction?.recommendationAction
        === "reference",
    };
    check("official result midnight placeholder recovers one exact SQLite snapshot event before archive attachment", (
      Object.values(midnightArchiveAssertions).every(Boolean)
    ), {
      assertions: midnightArchiveAssertions,
      publication: midnightArchiveRepair,
      recovery: midnightArchiveHistory?.resultEventClockRecovery || null,
      archive: midnightArchiveHistory?.archivedPreMatchPrediction || null,
    });
    const midnightArchiveReplay = publishOfficialResultsFast({
      ...midnightArchivePaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: midnightHistorySeed.sourceMatchId,
      }),
      observedAt,
    });
    const midnightArchiveReplayState = readDbState(midnightArchivePaths.dbPath);
    const midnightArchiveReplayHistory = midnightArchiveReplayState.rows
      .find((row) => row.dataset === "history")?.match;
    check("replayed midnight clock and archive recovery is a strict fast-path no-op", (
      midnightArchiveReplay.ok === true
      && midnightArchiveReplay.skipped === true
      && midnightArchiveReplay.reason === "no-result-state-change-fast-path"
      && midnightArchiveReplay.writeTransactionStarted === false
      && midnightArchiveReplayState.meta.fast_result_revision === "1"
    ), {
      publication: midnightArchiveReplay,
      archiveStable: JSON.stringify(midnightArchiveReplayHistory?.archivedPreMatchPrediction || null)
        === JSON.stringify(midnightArchiveHistory?.archivedPreMatchPrediction || null),
      firstArchive: midnightArchiveHistory?.archivedPreMatchPrediction || null,
      replayArchive: midnightArchiveReplayHistory?.archivedPreMatchPrediction || null,
      firstReview: midnightArchiveHistory?.postMatchReview || null,
      replayReview: midnightArchiveReplayHistory?.postMatchReview || null,
      firstOfficialMetadata: {
        officialResultIdentity: midnightArchiveHistory?.officialResultIdentity || null,
        officialPayoutSp: midnightArchiveHistory?.officialPayoutSp || null,
        resultSourceUpdatedAt: midnightArchiveHistory?.resultSourceUpdatedAt || null,
      },
      replayOfficialMetadata: {
        officialResultIdentity: midnightArchiveReplayHistory?.officialResultIdentity || null,
        officialPayoutSp: midnightArchiveReplayHistory?.officialPayoutSp || null,
        resultSourceUpdatedAt: midnightArchiveReplayHistory?.resultSourceUpdatedAt || null,
      },
    });

    const ambiguousClockPaths = scenario(
      tempRoot,
      "ambiguous-midnight-history-clock",
      [],
      [midnightHistorySeed],
      [
        strictSnapshot,
        strictOfficialReferenceSnapshot({
          kickoffTime: "2026-07-13T11:00:00+08:00",
          cutoffTime: "2026-07-13T10:55:00+08:00",
          capturedAt: "2026-07-13T01:51:00.000Z",
          recommendationAction: "recommend",
        }),
      ]
    );
    const ambiguousClockRepair = publishOfficialResultsFast({
      ...ambiguousClockPaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: midnightHistorySeed.sourceMatchId,
      }),
      observedAt,
    });
    const ambiguousClockHistory = readDbState(ambiguousClockPaths.dbPath).rows
      .find((row) => row.dataset === "history")?.match;
    check("two qualified SQLite event clocks cannot rebind the event or generate an archive", (
      ambiguousClockRepair.ok === true
      && ambiguousClockRepair.publishedRows === 1
      && ["review-refresh", "official-result-metadata-refresh"]
        .includes(ambiguousClockRepair.published?.[0]?.changeType)
      && ambiguousClockHistory?.kickoffTime === midnightHistorySeed.kickoffTime
      && ambiguousClockHistory?.archivedPreMatchPrediction === undefined
    ), {
      publication: ambiguousClockRepair,
      kickoffTime: ambiguousClockHistory?.kickoffTime || null,
      archive: ambiguousClockHistory?.archivedPreMatchPrediction || null,
    });

    const missingArchiveOnlySeed = JSON.parse(JSON.stringify(archiveRepairHistory));
    const missingArchiveReviewBefore = JSON.stringify(missingArchiveOnlySeed.postMatchReview || null);
    delete missingArchiveOnlySeed.archivedPreMatchPrediction;
    const missingArchiveOnlyPaths = scenario(
      tempRoot,
      "missing-archive-only-repair",
      [],
      [missingArchiveOnlySeed],
      [referenceSnapshot()]
    );
    const missingArchiveOnlyRepair = publishOfficialResultsFast({
      ...missingArchiveOnlyPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const missingArchiveOnlyState = readDbState(missingArchiveOnlyPaths.dbPath);
    const missingArchiveOnlyHistory = missingArchiveOnlyState.rows
      .find((row) => row.dataset === "history")?.match;
    check("archive-only repair persists when the complete post-match review is already equivalent", (
      missingArchiveOnlyRepair.ok === true
      && missingArchiveOnlyRepair.skipped === false
      && missingArchiveOnlyRepair.publishedRows === 1
      && missingArchiveOnlyRepair.published?.[0]?.changeType === "archive-repair"
      && JSON.stringify(missingArchiveOnlyHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive)
      && JSON.stringify(missingArchiveOnlyHistory?.postMatchReview || null)
        === missingArchiveReviewBefore
      && missingArchiveOnlyState.meta.fast_result_revision === "1"
    ), {
      publication: missingArchiveOnlyRepair,
      archive: missingArchiveOnlyHistory?.archivedPreMatchPrediction || null,
      reviewStable: JSON.stringify(missingArchiveOnlyHistory?.postMatchReview || null)
        === missingArchiveReviewBefore,
      revision: missingArchiveOnlyState.meta.fast_result_revision || null,
    });
    const missingArchiveOnlyReplay = publishOfficialResultsFast({
      ...missingArchiveOnlyPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const missingArchiveOnlyReplayState = readDbState(missingArchiveOnlyPaths.dbPath);
    const missingArchiveOnlyReplayHistory = missingArchiveOnlyReplayState.rows
      .find((row) => row.dataset === "history")?.match;
    check("replayed missing-archive repair is a strict no-op with a stable revision", (
      missingArchiveOnlyReplay.ok === true
      && missingArchiveOnlyReplay.skipped === true
      && missingArchiveOnlyReplay.reason === "no-result-state-change-fast-path"
      && missingArchiveOnlyReplay.fastPath === true
      && missingArchiveOnlyReplay.writeTransactionStarted === false
      && missingArchiveOnlyReplayState.meta.fast_result_revision === "1"
      && JSON.stringify(missingArchiveOnlyReplayHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive)
    ), {
      publication: missingArchiveOnlyReplay,
      revision: missingArchiveOnlyReplayState.meta.fast_result_revision || null,
    });

    const invalidArchiveOnlySeed = JSON.parse(JSON.stringify(archiveRepairHistory));
    const invalidArchiveReviewBefore = JSON.stringify(invalidArchiveOnlySeed.postMatchReview || null);
    invalidArchiveOnlySeed.archivedPreMatchPrediction = {
      ...invalidArchiveOnlySeed.archivedPreMatchPrediction,
      eventVersion: "2026-07-13T12:00:00.000Z",
      capturedAt: "2026-07-13T10:05:00.000Z",
    };
    const invalidArchiveOnlyPaths = scenario(
      tempRoot,
      "invalid-archive-only-repair",
      [],
      [invalidArchiveOnlySeed],
      [referenceSnapshot()]
    );
    const invalidArchiveOnlyRepair = publishOfficialResultsFast({
      ...invalidArchiveOnlyPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const invalidArchiveOnlyState = readDbState(invalidArchiveOnlyPaths.dbPath);
    const invalidArchiveOnlyHistory = invalidArchiveOnlyState.rows
      .find((row) => row.dataset === "history")?.match;
    check("archive-only repair replaces an invalid archive when the complete review is already equivalent", (
      invalidArchiveOnlyRepair.ok === true
      && invalidArchiveOnlyRepair.skipped === false
      && invalidArchiveOnlyRepair.publishedRows === 1
      && invalidArchiveOnlyRepair.published?.[0]?.changeType === "archive-repair"
      && JSON.stringify(invalidArchiveOnlyHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive)
      && JSON.stringify(invalidArchiveOnlyHistory?.postMatchReview || null)
        === invalidArchiveReviewBefore
      && invalidArchiveOnlyState.meta.fast_result_revision === "1"
    ), {
      publication: invalidArchiveOnlyRepair,
      archive: invalidArchiveOnlyHistory?.archivedPreMatchPrediction || null,
      reviewStable: JSON.stringify(invalidArchiveOnlyHistory?.postMatchReview || null)
        === invalidArchiveReviewBefore,
      revision: invalidArchiveOnlyState.meta.fast_result_revision || null,
    });
    const invalidArchiveOnlyReplay = publishOfficialResultsFast({
      ...invalidArchiveOnlyPaths,
      relaySnapshot: trustedSnapshot,
      observedAt,
    });
    const invalidArchiveOnlyReplayState = readDbState(invalidArchiveOnlyPaths.dbPath);
    const invalidArchiveOnlyReplayHistory = invalidArchiveOnlyReplayState.rows
      .find((row) => row.dataset === "history")?.match;
    check("replayed invalid-archive repair is a strict no-op with a stable revision", (
      invalidArchiveOnlyReplay.ok === true
      && invalidArchiveOnlyReplay.skipped === true
      && invalidArchiveOnlyReplay.reason === "no-result-state-change-fast-path"
      && invalidArchiveOnlyReplay.fastPath === true
      && invalidArchiveOnlyReplay.writeTransactionStarted === false
      && invalidArchiveOnlyReplayState.meta.fast_result_revision === "1"
      && JSON.stringify(invalidArchiveOnlyReplayHistory?.archivedPreMatchPrediction)
        === JSON.stringify(repairedArchive)
    ), {
      publication: invalidArchiveOnlyReplay,
      revision: invalidArchiveOnlyReplayState.meta.fast_result_revision || null,
    });

    const omittedClockCurrent = baseCurrentMatch({
      sourceMatchId: "fast-uniform-current",
      kickoffTime: "2026-07-13T10:00:00+08:00",
    });
    const omittedClockPaths = scenario(
      tempRoot,
      "uniform-result-omitted-clock-current",
      [omittedClockCurrent]
    );
    const omittedClockPublication = publishOfficialResultsFast({
      ...omittedClockPaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: omittedClockCurrent.sourceMatchId,
        capturedAt: observedAt,
      }),
    });
    const omittedClockState = readDbState(omittedClockPaths.dbPath);
    const omittedClockHistory = omittedClockState.rows
      .find((row) => row.dataset === "history")?.match;
    check("uniform official result inherits the immutable pre-match event clock before fast publication", (
      omittedClockPublication.skipped === false
      && omittedClockPublication.publishedRows === 1
      && omittedClockHistory?.kickoffTime === omittedClockCurrent.kickoffTime
      && omittedClockHistory?.eventVersion === omittedClockCurrent.eventVersion
      && omittedClockHistory?.officialResultIdentity?.scheduleTimeAuthority
        === "inherited-pre-match-event-identity"
      && isOfficialSportteryFinal(omittedClockHistory)
      && omittedClockState.rows.filter((row) => row.dataset === "current").length === 0
    ), {
      published: omittedClockPublication.published,
      kickoffTime: omittedClockHistory?.kickoffTime || null,
      eventVersion: omittedClockHistory?.eventVersion || null,
      officialResultIdentity: omittedClockHistory?.officialResultIdentity || null,
    });

    const provisionalHistoryBase = baseCurrentMatch({
      sourceMatchId: "fast-uniform-history",
      kickoffTime: "2026-07-13T10:00:00+08:00",
    });
    const provisionalHistory = resolveMatchLifecycle({
      ...provisionalHistoryBase,
      sourceMethod: "relay:result",
      sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
      status: "FINISHED",
      sourceStatus: "FINISHED",
      effectiveStatus: "FINISHED",
      scoreHome: 2,
      scoreAway: 1,
      resultSource: "sporttery:official-api",
      resultUpdatedAt: "2026-07-13T02:03:00.000Z",
      resultSourceUpdatedAt: "2026-07-13T02:03:00.000Z",
      resultObservedAt: "2026-07-13T02:03:00.000Z",
      resultObservationSource: "legacy-unattributed-result-observation",
      resultObservationFallback: true,
      resultProvenance: undefined,
    }, { now: "2026-07-13T02:03:00.000Z" });
    const officialUpgradePaths = scenario(
      tempRoot,
      "uniform-result-upgrades-provisional-history",
      [],
      [provisionalHistory]
    );
    const officialUpgrade = publishOfficialResultsFast({
      ...officialUpgradePaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: provisionalHistory.sourceMatchId,
        capturedAt: "2026-07-13T02:06:00.000Z",
      }),
    });
    const officialUpgradeState = readDbState(officialUpgradePaths.dbPath);
    const upgradedHistory = officialUpgradeState.rows
      .find((row) => row.dataset === "history")?.match;
    check("same-score provisional history is upgraded to strict Sporttery result identity", (
      officialUpgrade.skipped === false
      && officialUpgrade.publishedRows === 1
      && officialUpgrade.published?.[0]?.changeType === "review-refresh"
      && upgradedHistory?.kickoffTime === provisionalHistory.kickoffTime
      && upgradedHistory?.eventVersion === provisionalHistory.eventVersion
      && upgradedHistory?.resultObservationFallback === false
      && upgradedHistory?.resultProvenance?.promotionEligible === true
      && upgradedHistory?.officialResultIdentity?.endpoint === "getUniformMatchResultV1"
      && upgradedHistory?.officialResultIdentity?.scheduleTimeAuthority
        === "inherited-pre-match-event-identity"
      && officialSportteryResultUrl(upgradedHistory)
        === "https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry?matchPage=0"
      && isOfficialSportteryFinal(upgradedHistory)
    ), {
      publication: officialUpgrade,
      published: officialUpgrade.published,
      persistedHistory: upgradedHistory,
      resultProvider: upgradedHistory?.resultProvenance?.provider || null,
      resultPromotionEligible: upgradedHistory?.resultProvenance?.promotionEligible ?? null,
      resultObservationFallback: upgradedHistory?.resultObservationFallback ?? null,
      officialResultIdentity: upgradedHistory?.officialResultIdentity || null,
    });

    const uefaHistory = trustedUefaHistoryMatch();
    const uefaUpgradePaths = scenario(
      tempRoot,
      "uniform-result-upgrades-uefa-history",
      [],
      [uefaHistory]
    );
    const uefaUpgrade = publishOfficialResultsFast({
      ...uefaUpgradePaths,
      relaySnapshot: uniformResultRelaySnapshot({
        sourceMatchId: uefaHistory.sourceMatchId,
        capturedAt: "2026-07-13T02:07:00.000Z",
      }),
    });
    const uefaUpgradeState = readDbState(uefaUpgradePaths.dbPath);
    const sportteryUpgradedHistory = uefaUpgradeState.rows
      .find((row) => row.dataset === "history")?.match;
    check("later strict Sporttery result supersedes same-score UEFA settlement evidence", (
      uefaHistory?.resultProvenance?.provider === "uefa"
      && uefaHistory?.resultProvenance?.promotionEligible === false
      && uefaUpgrade.skipped === false
      && uefaUpgrade.publishedRows === 1
      && uefaUpgrade.published?.[0]?.changeType === "review-refresh"
      && sportteryUpgradedHistory?.resultProvenance?.provider === "sporttery"
      && sportteryUpgradedHistory?.resultProvenance?.promotionEligible === true
      && sportteryUpgradedHistory?.resultObservedAt === "2026-07-13T02:03:00.000Z"
      && sportteryUpgradedHistory?.resultAuthorityObservedAt === "2026-07-13T02:07:00.000Z"
      && sportteryUpgradedHistory?.postMatchReview?.settlement?.resultObservedAt
        === "2026-07-13T02:03:00.000Z"
      && sportteryUpgradedHistory?.postMatchReview?.settlement?.resultObservationFallback === false
      && sportteryUpgradedHistory?.officialResultIdentity?.scheduleTimeAuthority
        === "inherited-pre-match-event-identity"
      && isOfficialSportteryFinal(sportteryUpgradedHistory)
    ), {
      published: uefaUpgrade.published,
      priorProvider: uefaHistory?.resultProvenance?.provider || null,
      provider: sportteryUpgradedHistory?.resultProvenance?.provider || null,
      promotionEligible:
        sportteryUpgradedHistory?.resultProvenance?.promotionEligible ?? null,
      resultObservedAt: sportteryUpgradedHistory?.resultObservedAt || null,
      resultAuthorityObservedAt:
        sportteryUpgradedHistory?.resultAuthorityObservedAt || null,
      settlementObservedAt:
        sportteryUpgradedHistory?.postMatchReview?.settlement?.resultObservedAt || null,
    });

    const monotonicMetaPath = path.join(tempRoot, "monotonic-sync-meta.json");
    fs.writeFileSync(monotonicMetaPath, `${JSON.stringify({
      updatedAt: "2026-07-13T03:00:00.000Z",
      capturedAt: "2026-07-13T03:00:00.000Z",
      api: {
        freshnessTime: "2026-07-13T03:00:00.000Z",
        currentFreshnessTime: "2026-07-13T03:00:00.000Z",
        resultFreshnessTime: "2026-07-13T03:00:00.000Z",
        historyFreshnessTime: "2026-07-13T03:00:00.000Z",
      },
    })}\n`);
    publishSyncMetaRevision({
      filePath: monotonicMetaPath,
      publishedAt: "2026-07-13T02:59:00.000Z",
      sourceCycleId: "older-fast-cycle",
      datasetRevision: "sqlite-fast-result-r9",
      publishedRows: 1,
      revision: 9,
      observations: [],
    });
    const monotonicMeta = JSON.parse(fs.readFileSync(monotonicMetaPath, "utf8"));
    check("fast sync-meta publication never regresses any trusted lane freshness clock", (
      monotonicMeta.api.freshnessTime === "2026-07-13T03:00:00.000Z"
      && monotonicMeta.api.currentFreshnessTime === "2026-07-13T03:00:00.000Z"
      && monotonicMeta.api.resultFreshnessTime === "2026-07-13T03:00:00.000Z"
      && monotonicMeta.api.historyFreshnessTime === "2026-07-13T03:00:00.000Z"
      && monotonicMeta.sourceHealth.currentFreshnessTime === "2026-07-13T03:00:00.000Z"
      && monotonicMeta.sourceHealth.resultFreshnessTime === "2026-07-13T03:00:00.000Z"
    ));

    const poisonedMetaPath = path.join(tempRoot, "future-poisoned-sync-meta.json");
    const poisonedFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const trustedPublicationTime = new Date().toISOString();
    fs.writeFileSync(poisonedMetaPath, `${JSON.stringify({
      api: {
        freshnessTime: poisonedFuture,
        currentFreshnessTime: poisonedFuture,
        resultFreshnessTime: poisonedFuture,
        historyFreshnessTime: poisonedFuture,
      },
      sourceHealth: {
        sourceFreshnessTime: poisonedFuture,
        currentFreshnessTime: poisonedFuture,
        resultFreshnessTime: poisonedFuture,
        historyFreshnessTime: poisonedFuture,
      },
    })}\n`);
    publishSyncMetaRevision({
      filePath: poisonedMetaPath,
      publishedAt: trustedPublicationTime,
      sourceCycleId: "trusted-now-cycle",
      datasetRevision: "sqlite-fast-result-r10",
      publishedRows: 1,
      revision: 10,
      observations: [],
    });
    const sanitizedMeta = JSON.parse(fs.readFileSync(poisonedMetaPath, "utf8"));
    check("future-poisoned sync-meta clocks are excluded from trusted freshness merges", (
      sanitizedMeta.api.freshnessTime === trustedPublicationTime
      && sanitizedMeta.api.currentFreshnessTime === trustedPublicationTime
      && sanitizedMeta.api.resultFreshnessTime === trustedPublicationTime
      && sanitizedMeta.api.historyFreshnessTime === trustedPublicationTime
      && sanitizedMeta.sourceHealth.sourceFreshnessTime === trustedPublicationTime
      && sanitizedMeta.sourceHealth.resultFreshnessTime === trustedPublicationTime
    ));

    const serializedMetaPath = path.join(tempRoot, "serialized-sync-meta.json");
    const parentCommitLock = acquireSyncMetaCommitLock({ filePath: serializedMetaPath });
    let childResult = null;
    let childWasBlocked = false;
    try {
      fs.writeFileSync(serializedMetaPath, `${JSON.stringify({
        version: "full-sync-before-race",
        fastResultRevision: 11,
        fastResultPublication: {
          version: "sqlite-fast-result-v1",
          publishedAt: "2026-07-13T03:00:00.000Z",
          sourceCycleId: "cycle-r11",
          datasetRevision: "sqlite-fast-result-r11",
          publishedRows: 1,
        },
      })}\n`);
      const publisherModulePath = path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs");
      const childCode = `
        const { publishSyncMetaRevision } = require(${JSON.stringify(publisherModulePath)});
        publishSyncMetaRevision(${JSON.stringify({
          filePath: serializedMetaPath,
          publishedAt: trustedPublicationTime,
          sourceCycleId: "cycle-r12",
          datasetRevision: "sqlite-fast-result-r12",
          publishedRows: 1,
          revision: 12,
          observations: [],
        })});
      `;
      const child = spawn(process.execPath, ["-e", childCode], {
        cwd: rootDir,
        env: { ...process.env, SYNC_META_COMMIT_LOCK_WAIT_MS: "5000" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childDone = new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      childWasBlocked = child.exitCode === null;
      // Simulate the full writer's final commit while it owns the shared lock.
      const fullCommit = JSON.parse(fs.readFileSync(serializedMetaPath, "utf8"));
      fs.writeFileSync(serializedMetaPath, `${JSON.stringify({
        ...fullCommit,
        fullSyncSentinel: "preserved-after-fast-reread",
      })}\n`);
      parentCommitLock.release();
      childResult = await childDone;
    } finally {
      parentCommitLock.release();
    }
    const serializedMeta = JSON.parse(fs.readFileSync(serializedMetaPath, "utf8"));
    check("a fast writer waits for the full writer then re-reads and merges instead of losing its commit", (
      childWasBlocked
      && childResult?.code === 0
      && serializedMeta.fullSyncSentinel === "preserved-after-fast-reread"
      && serializedMeta.fastResultRevision === 12
      && serializedMeta.fastResultPublication?.datasetRevision === "sqlite-fast-result-r12"
    ), { childWasBlocked, childResult });

    const laterFullSyncAt = "2026-07-13T02:25:00.000Z";
    const rebuiltByFullSync = {
      ...history,
      resultObservedAt: laterFullSyncAt,
      settledAt: laterFullSyncAt,
      sourceCycleId: "full-cycle-later",
      datasetRevision: "full-dataset-later",
      postMatchReview: undefined,
    };
    const restoredBeforeReview = applyFastResultObservation(
      rebuiltByFullSync,
      publicMeta.fastResultObservations
    );
    const settledRestored = settleTrustedPublishedPredictions(restoredBeforeReview);
    const restoredAfterReview = attachPostMatchReviews(
      [settledRestored],
      laterFullSyncAt,
      null,
      null
    ).matches[0];
    check("full rebuild reuses the fast first observation before review settlement", (
      restoredAfterReview?.resultObservedAt === observedAt
      && restoredAfterReview?.settledAt === observedAt
      && restoredAfterReview?.sourceCycleId === first.sourceCycleId
      && restoredAfterReview?.datasetRevision === first.datasetRevision
      && restoredAfterReview?.postMatchReview?.settlement?.resultObservedAt === observedAt
      && restoredAfterReview?.postMatchReview?.settlement?.settledAt === observedAt
      && restoredAfterReview?.postMatchReview?.settlement?.sourceCycleId === first.sourceCycleId
      && restoredAfterReview?.postMatchReview?.settlement?.datasetRevision === first.datasetRevision
      && restoredAfterReview?.predictions?.[0]?.resultStatus === "LOST"
    ), {
      resultObservedAt: restoredAfterReview?.resultObservedAt || null,
      cardResultStatus: restoredAfterReview?.predictions?.[0]?.resultStatus || null,
      settlement: restoredAfterReview?.postMatchReview?.settlement || null,
    });
    const scoreConflictRebuild = applyFastResultObservation({
      ...rebuiltByFullSync,
      scoreHome: history.scoreHome + 1,
    }, publicMeta.fastResultObservations);
    check("observation ledger never applies across a score conflict", (
      scoreConflictRebuild.resultObservedAt === laterFullSyncAt
      && scoreConflictRebuild.sourceCycleId === "full-cycle-later"
    ));
    const regressedCurrent = baseCurrentMatch();
    const terminalOverlay = overlayFastObservedFinals(
      [regressedCurrent],
      [history],
      publicMeta.fastResultObservations
    )[0];
    const fiveHundredResultOnly = {
      ...history,
      id: `fivehundred_${history.sourceMatchId}`,
      source: "five-hundred",
      sourceMethod: "500-fallback",
      sourceUrl: `https://odds.500.com/fenxi/shuju-${history.sourceMatchId}.shtml`,
      resultSource: "500.com:jczq-result",
      resultProvenance: null,
      resultObservationFallback: true,
    };
    const officialFinalOverFallback = overlayFastObservedFinals(
      [fiveHundredResultOnly],
      [history],
      publicMeta.fastResultObservations
    )[0];
    const untrustedResultUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        trusted: false,
      },
    });
    const foreignResultUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        sourceMatchId: "different-event",
      },
    });
    const spoofedResultUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        sourceUrl: "https://webapi.sporttery.cn.attacker.invalid/result",
      },
    });
    const missingEventVersionUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        eventVersion: null,
      },
    });
    const missingScoreUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        scoreHome: null,
      },
    });
    const conflictingScoreUrl = officialSportteryResultUrl({
      ...officialFinalOverFallback,
      resultProvenance: {
        ...officialFinalOverFallback.resultProvenance,
        scoreHome: Number(officialFinalOverFallback.resultProvenance?.scoreHome) + 1,
      },
    });
    const mismatchedOverlay = overlayFastObservedFinals(
      [baseCurrentMatch({ kickoffTime: "2026-07-14T10:00:00+08:00" })],
      [history],
      publicMeta.fastResultObservations
    )[0];
    const missingFromProviderOverlay = overlayFastObservedFinals(
      [baseCurrentMatch({ sourceMatchId: "unrelated-9001" })],
      [history],
      publicMeta.fastResultObservations
    );
    check("trusted SQLite fast final prevents a degraded full sync from reviving current", (
      terminalOverlay?.status === "FINISHED"
      && terminalOverlay?.scoreHome === history.scoreHome
      && terminalOverlay?.predictions?.[0]?.tipCode === regressedCurrent.predictions[0].tipCode
      && mismatchedOverlay?.status === "FINISHED"
      && mismatchedOverlay?.fastResultIdentityResolution?.policy
        === "trusted-official-final-over-canonical-id-conflict"
      && mismatchedOverlay?.fastResultIdentityResolution?.inheritedMismatchedPreMatchEvidence === false
      && missingFromProviderOverlay.some((match) => (
        match.sourceMatchId === history.sourceMatchId && match.status === "FINISHED"
      ))
    ), {
      restoredStatus: terminalOverlay?.status || null,
      mismatchedStatus: mismatchedOverlay?.status || null,
    });
    check("official fast final over a 500 fallback retains a validated official result URL", (
      officialFinalOverFallback?.id === `fivehundred_${history.sourceMatchId}`
      && officialFinalOverFallback?.sourceUrl?.startsWith("https://odds.500.com/")
      && officialFinalOverFallback?.resultSource === "sporttery:official-api"
      && officialSportteryResultUrl(officialFinalOverFallback) === history.resultProvenance?.sourceUrl
      && untrustedResultUrl === null
      && foreignResultUrl === null
      && spoofedResultUrl === null
      && missingEventVersionUrl === null
      && missingScoreUrl === null
      && conflictingScoreUrl === null
    ), {
      topLevelSourceUrl: officialFinalOverFallback?.sourceUrl || null,
      provenanceSourceUrl: officialFinalOverFallback?.resultProvenance?.sourceUrl || null,
      validatedResultUrl: officialSportteryResultUrl(officialFinalOverFallback),
    });

    const productionCollisionFinal = ({ sourceMatchId, kickoffTime, scoreHome, scoreAway }) => {
      const canonicalKickoff = new Date(kickoffTime).toISOString();
      return {
        ...history,
        id: `fivehundred_${sourceMatchId}`,
        sourceMatchId,
        source: "sporttery",
        sourceMethod: "relay:result",
        sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
        kickoffTime,
        eventVersion: kickoffTime,
        homeTeamId: `official-home-${sourceMatchId}`,
        awayTeamId: `official-away-${sourceMatchId}`,
        scoreHome,
        scoreAway,
        resultObservedAt: "2026-07-16T00:49:03.350Z",
        resultProvenance: {
          ...history.resultProvenance,
          sourceMatchId,
          scoreHome,
          scoreAway,
          kickoffTime: canonicalKickoff,
          eventVersion: canonicalKickoff,
          observedAt: "2026-07-16T00:49:03.350Z",
        },
      };
    };
    const productionCollisionFallback = ({ sourceMatchId, kickoffTime }) => ({
      ...baseCurrentMatch({ sourceMatchId, kickoffTime }),
      id: `fivehundred_${sourceMatchId}`,
      source: "five-hundred",
      sourceMethod: "500-fallback",
      sourceUrl: `https://trade.500.com/jczq/${sourceMatchId}`,
      homeTeamId: `fallback-home-${sourceMatchId}`,
      awayTeamId: `fallback-away-${sourceMatchId}`,
      predictions: [{ marketType: "BEST", tipCode: `conflict-only-${sourceMatchId}` }],
      resultProvenance: null,
    });
    const productionFinals = [
      productionCollisionFinal({
        sourceMatchId: "2040513",
        kickoffTime: "2026-07-16T02:15:00+08:00",
        scoreHome: 1,
        scoreAway: 2,
      }),
      productionCollisionFinal({
        sourceMatchId: "2040514",
        kickoffTime: "2026-07-16T03:00:00+08:00",
        scoreHome: 0,
        scoreAway: 2,
      }),
    ];
    const productionFallbacks = [
      productionCollisionFallback({
        sourceMatchId: "2040513",
        kickoffTime: "2026-07-16T02:15:00+08:00",
      }),
      productionCollisionFallback({
        sourceMatchId: "2040514",
        kickoffTime: "2026-07-16T03:00:00+08:00",
      }),
    ];
    const productionObservations = mergeFastResultObservations(null, productionFinals.map((match) => ({
      sourceMatchId: match.sourceMatchId,
      eventVersion: match.eventVersion,
      kickoffTime: match.kickoffTime,
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
      resultObservedAt: match.resultObservedAt,
      observationSource: "sporttery-relay-endpoint-received-at",
      settledAt: match.resultObservedAt,
      publishedAt: match.resultObservedAt,
      sourceCycleId: `production-collision-${match.sourceMatchId}`,
      datasetRevision: `sqlite-fast-result-${match.sourceMatchId}`,
    })));
    const productionResolved = overlayFastObservedFinals(
      productionFallbacks,
      [...productionFinals].reverse(),
      productionObservations
    );
    check("2040513 and 2040514 canonical collisions keep one trusted official final each", (
      productionResolved.length === 2
      && new Set(productionResolved.map((match) => match.id)).size === 2
      && new Set(productionResolved.map((match) => match.sourceMatchId)).size === 2
      && productionResolved.every((match) => (
        match.status === "FINISHED"
        && match.resultProvenance?.provider === "sporttery"
        && match.resultProvenance?.official === true
        && match.resultProvenance?.trusted === true
        && match.fastResultIdentityResolution?.discardedRows === 1
        && match.fastResultIdentityResolution?.inheritedMismatchedPreMatchEvidence === false
        && !match.predictions?.some((prediction) => String(prediction.tipCode).startsWith("conflict-only-"))
      ))
    ), {
      rows: productionResolved.map((match) => ({
        id: match.id,
        sourceMatchId: match.sourceMatchId,
        score: `${match.scoreHome}-${match.scoreAway}`,
        resolution: match.fastResultIdentityResolution || null,
      })),
    });

    const productionTrustedDuplicate = {
      ...productionFinals[0],
      sourceMethod: "all",
      kickoffTime: "2026-07-16T02:16:00+08:00",
      homeTeamId: "full-cycle-home-alias-2040513",
      awayTeamId: "full-cycle-away-alias-2040513",
      datasetRevision: "full-cycle-duplicate-copy",
    };
    const deduplicatedProductionTrustedCopies = overlayFastObservedFinals(
      [productionTrustedDuplicate],
      [productionFinals[0]],
      productionObservations
    );
    check("production-shaped equivalent trusted finals deduplicate despite fixture metadata drift", (
      deduplicatedProductionTrustedCopies.length === 1
      && deduplicatedProductionTrustedCopies[0]?.sourceMatchId === "2040513"
      && deduplicatedProductionTrustedCopies[0]?.scoreHome === 1
      && deduplicatedProductionTrustedCopies[0]?.scoreAway === 2
      && deduplicatedProductionTrustedCopies[0]?.fastResultIdentityResolution?.policy
        === "equivalent-trusted-official-finals-deduplicated"
      && deduplicatedProductionTrustedCopies[0]?.fastResultIdentityResolution?.deduplicatedTrustedFinalRows === 1
      && deduplicatedProductionTrustedCopies[0]?.fastResultIdentityResolution?.discardedUntrustedRows === 0
    ), {
      rows: deduplicatedProductionTrustedCopies.length,
      resolution: deduplicatedProductionTrustedCopies[0]?.fastResultIdentityResolution || null,
    });

    const immutableClockOwner = {
      ...productionFinals[0],
      kickoffTime: "2026-07-16T08:30:00+08:00",
      eventVersion: "2026-07-16T08:30:00+08:00",
      predictions: [{ marketType: "BEST", tipCode: "1" }],
      archivedPreMatchPrediction: {
        version: "archived-pre-match-prediction-v1",
        source: "immutable-pre-match-prediction-snapshot",
        sourceMatchId: "2040513",
        eventVersion: "2026-07-16T08:30:00+08:00",
        kickoffTime: "2026-07-16T08:30:00+08:00",
        capturedAt: "2026-07-15T08:00:00.000Z",
      },
      resultProvenance: {
        ...productionFinals[0].resultProvenance,
        kickoffTime: "2026-07-16T00:30:00.000Z",
        eventVersion: "2026-07-16T00:30:00.000Z",
      },
    };
    const midnightFastFinal = {
      ...productionFinals[0],
      kickoffTime: "2026-07-16T00:00:00+08:00",
      eventVersion: "2026-07-16T00:00:00+08:00",
      resultProvenance: {
        ...productionFinals[0].resultProvenance,
        kickoffTime: "2026-07-15T16:00:00.000Z",
        eventVersion: "2026-07-15T16:00:00.000Z",
      },
    };
    const midnightObservation = mergeFastResultObservations(null, [{
      sourceMatchId: midnightFastFinal.sourceMatchId,
      eventVersion: midnightFastFinal.eventVersion,
      kickoffTime: midnightFastFinal.kickoffTime,
      scoreHome: midnightFastFinal.scoreHome,
      scoreAway: midnightFastFinal.scoreAway,
      resultObservedAt: midnightFastFinal.resultObservedAt,
      observationSource: "sporttery-relay-endpoint-received-at",
      settledAt: midnightFastFinal.resultObservedAt,
      publishedAt: midnightFastFinal.resultObservedAt,
      sourceCycleId: "legacy-midnight-result-clock",
      datasetRevision: "sqlite-fast-result-midnight",
    }]);
    const reboundMidnightClock = overlayFastObservedFinals(
      [immutableClockOwner],
      [midnightFastFinal],
      midnightObservation
    );
    check("legacy payout midnight clock rebinds only to an immutable same-day pre-match archive", (
      reboundMidnightClock.length === 1
      && reboundMidnightClock[0]?.eventVersion === "2026-07-16T08:30:00+08:00"
      && reboundMidnightClock[0]?.kickoffTime === "2026-07-16T08:30:00+08:00"
      && reboundMidnightClock[0]?.archivedPreMatchPrediction?.sourceMatchId === "2040513"
      && reboundMidnightClock[0]?.predictions?.[0]?.tipCode === "1"
      && reboundMidnightClock[0]?.fastResultIdentityResolution?.policy
        === "legacy-midnight-result-clock-rebound-to-immutable-prematch-event"
      && reboundMidnightClock[0]?.fastResultIdentityResolution?.immutableArchiveValidated === true
    ), {
      eventVersion: reboundMidnightClock[0]?.eventVersion || null,
      resolution: reboundMidnightClock[0]?.fastResultIdentityResolution || null,
    });

    const immutableClockObservation = mergeFastResultObservations(null, [{
      sourceMatchId: immutableClockOwner.sourceMatchId,
      eventVersion: immutableClockOwner.eventVersion,
      kickoffTime: immutableClockOwner.kickoffTime,
      scoreHome: immutableClockOwner.scoreHome,
      scoreAway: immutableClockOwner.scoreAway,
      resultObservedAt: immutableClockOwner.resultObservedAt,
      observationSource: "sporttery-relay-endpoint-received-at",
      settledAt: immutableClockOwner.resultObservedAt,
      publishedAt: immutableClockOwner.resultObservedAt,
      sourceCycleId: "immutable-clock-fast-result",
      datasetRevision: "sqlite-fast-result-immutable-clock",
    }]);
    const discardedReverseMidnightClock = overlayFastObservedFinals(
      [midnightFastFinal],
      [immutableClockOwner],
      immutableClockObservation
    );
    check("archive-bound fast final discards a reverse-order legacy midnight duplicate", (
      discardedReverseMidnightClock.length === 1
      && discardedReverseMidnightClock[0]?.eventVersion === "2026-07-16T08:30:00+08:00"
      && discardedReverseMidnightClock[0]?.kickoffTime === "2026-07-16T08:30:00+08:00"
      && discardedReverseMidnightClock[0]?.archivedPreMatchPrediction?.sourceMatchId === "2040513"
      && discardedReverseMidnightClock[0]?.fastResultIdentityResolution?.policy
        === "legacy-midnight-result-clock-discarded-for-immutable-prematch-event"
      && discardedReverseMidnightClock[0]?.fastResultIdentityResolution?.immutableArchiveValidated === true
      && discardedReverseMidnightClock[0]?.fastResultIdentityResolution?.deduplicatedTrustedFinalRows === 1
      && discardedReverseMidnightClock[0]?.fastResultIdentityResolution?.discardedUntrustedRows === 0
    ), {
      eventVersion: discardedReverseMidnightClock[0]?.eventVersion || null,
      resolution: discardedReverseMidnightClock[0]?.fastResultIdentityResolution || null,
    });

    let trustedRevisionConflict = null;
    try {
      overlayFastObservedFinals(
        [{
          ...productionFinals[0],
          kickoffTime: "2026-07-17T02:15:00+08:00",
          eventVersion: "2026-07-17T02:15:00+08:00",
          resultProvenance: {
            ...productionFinals[0].resultProvenance,
            kickoffTime: "2026-07-16T18:15:00.000Z",
            eventVersion: "2026-07-16T18:15:00.000Z",
          },
        }],
        [productionFinals[0]],
        productionObservations
      );
    } catch (error) {
      trustedRevisionConflict = error;
    }
    check("conflicting trusted official event revisions fail closed instead of choosing by arrival order", (
      trustedRevisionConflict?.code === "FAST_RESULT_IDENTITY_CONFLICT"
      && trustedRevisionConflict?.reason === "conflicting-trusted-official-finals"
      && trustedRevisionConflict?.sourceMatchId === "2040513"
    ), {
      code: trustedRevisionConflict?.code || null,
      reason: trustedRevisionConflict?.reason || null,
    });

    let trustedScoreConflict = null;
    try {
      overlayFastObservedFinals(
        [{
          ...productionFinals[0],
          scoreHome: 2,
          resultProvenance: {
            ...productionFinals[0].resultProvenance,
            scoreHome: 2,
          },
        }],
        [productionFinals[0]],
        productionObservations
      );
    } catch (error) {
      trustedScoreConflict = error;
    }
    check("same-event trusted finals with conflicting scores still fail closed", (
      trustedScoreConflict?.code === "FAST_RESULT_IDENTITY_CONFLICT"
      && trustedScoreConflict?.reason === "conflicting-trusted-official-finals"
      && trustedScoreConflict?.sourceMatchId === "2040513"
    ), {
      code: trustedScoreConflict?.code || null,
      reason: trustedScoreConflict?.reason || null,
    });

    const retentionRows = Array.from({ length: 300 }, (_, index) => ({
      sourceMatchId: `retention-${index}`,
      eventVersion: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      kickoffTime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      scoreHome: index % 5,
      scoreAway: index % 3,
      resultObservedAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
      settledAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
      publishedAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
      sourceCycleId: `cycle-${index}`,
      datasetRevision: `dataset-${index}`,
    }));
    const retained = mergeFastResultObservations(null, retentionRows);
    check("observation ledger retains every exact row below its fail-closed capacity", (
      retained.rows.length === 300
      && retained.rows.some((row) => row.sourceMatchId === "retention-299")
      && retained.rows.some((row) => row.sourceMatchId === "retention-0")
    ), { rows: retained.rows.length });

    const rollingCurrentA = baseCurrentMatch({ sourceMatchId: "rolling-a" });
    const rollingCurrentB = baseCurrentMatch({ sourceMatchId: "rolling-b" });
    const rollingCurrentC = baseCurrentMatch({ sourceMatchId: "rolling-c" });
    const rollingPaths = scenario(tempRoot, "rolling-receipt", [rollingCurrentA, rollingCurrentB, rollingCurrentC]);
    const rollingA = publishOfficialResultsFast({
      ...rollingPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "rolling-a",
        capturedAt: "2026-07-13T02:06:00.000Z",
      }),
      observedAt: "2026-07-13T02:06:00.000Z",
    });
    const rollingB = publishOfficialResultsFast({
      ...rollingPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "rolling-b",
        capturedAt: "2026-07-13T02:07:00.000Z",
      }),
      observedAt: "2026-07-13T02:07:00.000Z",
    });
    const rollingC = publishOfficialResultsFast({
      ...rollingPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "rolling-c",
        capturedAt: "2026-07-13T02:08:00.000Z",
      }),
      observedAt: "2026-07-13T02:08:00.000Z",
    });
    const rollingBeforeExport = readDbState(rollingPaths.dbPath);
    const rollingReceipt = JSON.parse(rollingBeforeExport.meta.fast_result_receipt || "null");
    const rollingPayloads = new Map(rollingBeforeExport.rows
      .filter((row) => row.dataset === "history")
      .map((row) => [row.match.sourceMatchId, row.payload]));
    check("successive fast publications accumulate an immutable bounded SQLite receipt", (
      rollingA.publishedRows === 1
      && rollingB.publishedRows === 1
      && rollingC.publishedRows === 1
      && rollingReceipt?.revision === 3
      && rollingReceipt?.publishedRows === 1
      && rollingReceipt?.observations?.length === 3
      && rollingReceipt.observations.some((row) => (
        row.sourceMatchId === "rolling-a"
        && row.resultObservedAt === "2026-07-13T02:06:00.000Z"
        && row.datasetRevision === rollingA.datasetRevision
      ))
      && rollingB.receiptObservationRows === 2
      && rollingC.receiptObservationRows === 3
    ), {
      revision: rollingReceipt?.revision || null,
      observationRows: rollingReceipt?.observations?.length || 0,
    });

    fs.writeFileSync(rollingPaths.syncMetaPath, `${JSON.stringify({
      version: "fixture-sync-meta",
      fastResultRevision: 0,
      fastResultObservations: { version: "fast-result-observations-v1", rows: [] },
    })}\n`);
    const rollingRecovery = publishOfficialResultsFast({
      ...rollingPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "rolling-c",
        capturedAt: "2026-07-13T02:09:00.000Z",
      }),
      observedAt: "2026-07-13T02:09:00.000Z",
    });
    const rollingRecoveredMeta = JSON.parse(fs.readFileSync(rollingPaths.syncMetaPath, "utf8"));
    check("sync-meta recovery restores the complete rolling receipt rather than only the latest batch", (
      rollingRecovery.visibleStateChanged === true
      && rollingRecovery.publishedRows === 0
      && rollingRecoveredMeta.fastResultRevision === 3
      && rollingRecoveredMeta.fastResultObservations?.rows?.length === 3
      && rollingRecoveredMeta.fastResultObservations.rows.some((row) => (
        row.sourceMatchId === "rolling-a"
        && row.resultObservedAt === "2026-07-13T02:06:00.000Z"
      ))
    ), {
      reason: rollingRecovery.reason || null,
      observationRows: rollingRecoveredMeta.fastResultObservations?.rows?.length || 0,
    });

    const rollingPublicDataDir = path.join(tempRoot, "rolling-stale-public");
    fs.mkdirSync(rollingPublicDataDir, { recursive: true });
    fs.writeFileSync(path.join(rollingPublicDataDir, "matches-current.json"), `${JSON.stringify([
      rollingCurrentA,
      rollingCurrentB,
      rollingCurrentC,
    ])}\n`);
    fs.writeFileSync(path.join(rollingPublicDataDir, "matches-history.json"), "[]\n");
    fs.writeFileSync(path.join(rollingPublicDataDir, "sync-meta.json"), `${JSON.stringify({
      source: "simulated-long-cycle-stale-output",
      updatedAt: "2026-07-13T02:00:00.000Z",
    })}\n`);
    const rollingExport = spawnSync(process.execPath, [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")], {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        SQLITE_EXPORT_PUBLIC_DATA_DIR: rollingPublicDataDir,
        SERVER_STORE_DIR: path.dirname(rollingPaths.dbPath),
        DATASTORE_SQLITE_PATH: rollingPaths.dbPath,
        SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
        SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
        SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
        SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
      },
    });
    const rollingAfterExport = readDbState(rollingPaths.dbPath);
    const rollingAfterReceipt = JSON.parse(rollingAfterExport.meta.fast_result_receipt || "null");
    check("stale long-cycle export preserves every final from successive fast batches", (
      rollingExport.status === 0
      && rollingAfterExport.rows.filter((row) => row.dataset === "current").length === 0
      && rollingAfterExport.rows.filter((row) => row.dataset === "history").length === 3
      && rollingAfterExport.rows
        .filter((row) => row.dataset === "history")
        .every((row) => rollingPayloads.get(row.match.sourceMatchId) === row.payload)
      && rollingAfterReceipt?.observations?.length === 3
    ), {
      exportStatus: rollingExport.status,
      currentRows: rollingAfterExport.rows.filter((row) => row.dataset === "current").length,
      historyRows: rollingAfterExport.rows.filter((row) => row.dataset === "history").length,
      stderr: rollingExport.status === 0 ? "" : rollingExport.stderr.slice(-500),
    });

    const bulkFastRows = 257;
    const bulkSourceIds = Array.from({ length: bulkFastRows }, (_, index) => `bulk-fast-${index + 1}`);
    const bulkCurrents = bulkSourceIds.map((sourceMatchId) => baseCurrentMatch({ sourceMatchId }));
    const bulkPaths = scenario(tempRoot, "bulk-fast-257", bulkCurrents);
    const bulkPublication = publishOfficialResultsFast({
      ...bulkPaths,
      relaySnapshot: combinedRelaySnapshot(...bulkSourceIds.map((sourceMatchId) => relaySnapshot({
        sourceMatchId,
        capturedAt: "2026-07-13T02:07:30.000Z",
      }))),
      observedAt: "2026-07-13T02:07:30.000Z",
    });
    const bulkState = readDbState(bulkPaths.dbPath);
    const bulkReceipt = JSON.parse(bulkState.meta.fast_result_receipt || "null");
    const bulkAuthorityRows = authorityRowsFromState(bulkState);
    const bulkPublicDataDir = path.join(tempRoot, "bulk-fast-stale-public");
    fs.mkdirSync(bulkPublicDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(bulkPublicDataDir, "matches-current.json"),
      `${JSON.stringify(bulkCurrents)}\n`,
    );
    fs.writeFileSync(path.join(bulkPublicDataDir, "matches-history.json"), "[]\n");
    fs.writeFileSync(path.join(bulkPublicDataDir, "sync-meta.json"), `${JSON.stringify({
      source: "simulated-bulk-stale-output",
      updatedAt: "2026-07-13T02:00:00.000Z",
    })}\n`);
    const bulkExport = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          SQLITE_EXPORT_PUBLIC_DATA_DIR: bulkPublicDataDir,
          SERVER_STORE_DIR: path.dirname(bulkPaths.dbPath),
          DATASTORE_SQLITE_PATH: bulkPaths.dbPath,
          SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
          SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
          SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
          SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
        },
      },
    );
    const bulkAfterExport = readDbState(bulkPaths.dbPath);
    check("257-result batch remains lossless across receipt high-water and stale export guards", (
      bulkPublication.publishedRows === bulkFastRows
      && bulkReceipt?.observations?.length === bulkFastRows
      && bulkAuthorityRows.length === bulkFastRows
      && bulkExport.status === 0
      && bulkAfterExport.rows.filter((row) => row.dataset === "current").length === 0
      && bulkAfterExport.rows.filter((row) => row.dataset === "history").length === bulkFastRows
    ), {
      publishedRows: bulkPublication.publishedRows,
      receiptRows: bulkReceipt?.observations?.length || 0,
      authorityRows: bulkAuthorityRows.length,
      exportStatus: bulkExport.status,
      historyRows: bulkAfterExport.rows.filter((row) => row.dataset === "history").length,
      stderr: bulkExport.status === 0 ? "" : bulkExport.stderr.slice(-500),
    });

    const reusedSourceMatchId = "reused-5001";
    const reusedOldCurrent = baseCurrentMatch({ sourceMatchId: reusedSourceMatchId });
    const reusedPaths = scenario(tempRoot, "reused-source-id", [reusedOldCurrent]);
    const reusedOld = publishOfficialResultsFast({
      ...reusedPaths,
      relaySnapshot: relaySnapshot({ sourceMatchId: reusedSourceMatchId, capturedAt }),
      observedAt: "2026-07-13T02:08:00.000Z",
    });
    const reusedNewCurrent = baseCurrentMatch({
      sourceMatchId: reusedSourceMatchId,
      kickoffTime: "2026-07-13T14:00:00+08:00",
    });
    const reusedDb = new DatabaseSync(reusedPaths.dbPath);
    reusedDb.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES (?, 'current', ?, ?, ?, ?, ?)
    `).run(
      `current:${reusedNewCurrent.id}`,
      reusedNewCurrent.id,
      reusedSourceMatchId,
      reusedNewCurrent.kickoffTime,
      reusedNewCurrent.status,
      JSON.stringify(reusedNewCurrent)
    );
    reusedDb.close();
    const reusedNew = publishOfficialResultsFast({
      ...reusedPaths,
      relaySnapshot: combinedRelaySnapshot(
        relaySnapshot({ sourceMatchId: reusedSourceMatchId, capturedAt }),
        relaySnapshot({
          sourceMatchId: reusedSourceMatchId,
          matchDate: "2026-07-13",
          matchTime: "14:00:00",
          capturedAt: "2026-07-13T06:08:00.000Z",
        })
      ),
      observedAt: "2026-07-13T06:08:00.000Z",
    });
    const reusedState = readDbState(reusedPaths.dbPath);
    const reusedTransitionRows = await readSqliteTransitionMatches(reusedPaths.dbPath, {
      sourceMatchIds: [reusedSourceMatchId],
      limit: 8,
    });
    const reusedReceipt = JSON.parse(reusedState.meta.fast_result_receipt || "null");
    check("reused source match id publishes a different exact event without overwriting history", (
      reusedOld.publishedRows === 1
      && reusedNew.publishedRows === 1
      && reusedState.rows.filter((row) => row.dataset === "current").length === 0
      && reusedState.rows.filter((row) => row.dataset === "history").length === 2
      && new Set(reusedState.rows
        .filter((row) => row.dataset === "history")
        .map((row) => Date.parse(row.match.eventVersion || row.match.kickoffTime))).size === 2
      && new Set(reusedState.rows
        .filter((row) => row.dataset === "history")
        .map((row) => row.id)).size === 2
      && new Set(reusedState.rows
        .filter((row) => row.dataset === "history")
        .map((row) => row.match.id)).size === 1
      && reusedReceipt?.observations?.length === 2
    ), {
      oldPublished: reusedOld.publishedRows,
      newPublished: reusedNew.publishedRows,
      historyIds: reusedState.rows.filter((row) => row.dataset === "history").map((row) => row.id),
      rejected: reusedNew.rejected,
    });
    check("public transition payload preserves the exact current match id while SQLite row ids remain unique", (
      reusedTransitionRows.length === 2
      && reusedTransitionRows[0]?.id === reusedNewCurrent.id
      && Date.parse(reusedTransitionRows[0]?.eventVersion || reusedTransitionRows[0]?.kickoffTime || "")
        === Date.parse(reusedNewCurrent.eventVersion)
      && reusedNew.published?.[0]?.matchId === reusedNewCurrent.id
      && reusedState.rows
        .filter((row) => row.dataset === "history")
        .every((row) => row.match.id === reusedNewCurrent.id && !row.match.originalMatchId)
      && new Set(reusedState.rows
        .filter((row) => row.dataset === "history")
        .map((row) => row.id)).size === 2
    ), {
      currentMatchId: reusedNewCurrent.id,
      transitionMatchIds: reusedTransitionRows.map((row) => row.id),
      transitionEvents: reusedTransitionRows.map((row) => row.eventVersion || row.kickoffTime),
      sqliteRowIds: reusedState.rows.filter((row) => row.dataset === "history").map((row) => row.id),
    });
    check("same relay snapshot keeps reused source id events separate and selects the exact current event", (
      reusedNew.trustedFinishedRows === 2
      && reusedNew.publishedRows === 1
      && reusedNew.rejected?.duplicateConflict === 0
      && reusedNew.rejected?.alreadyPublished === 1
      && reusedState.rows.filter((row) => row.dataset === "current").length === 0
      && reusedState.rows.filter((row) => row.dataset === "history").length === 2
    ), {
      trustedFinishedRows: reusedNew.trustedFinishedRows,
      publishedRows: reusedNew.publishedRows,
      rejected: reusedNew.rejected,
    });

    const exactConflictSourceMatchId = "same-event-conflict-5002";
    const exactConflictPaths = scenario(tempRoot, "same-event-conflict", [baseCurrentMatch({
      sourceMatchId: exactConflictSourceMatchId,
    })]);
    const exactConflict = publishOfficialResultsFast({
      ...exactConflictPaths,
      relaySnapshot: combinedRelaySnapshot(
        relaySnapshot({ sourceMatchId: exactConflictSourceMatchId, scoreHome: 2, scoreAway: 1, capturedAt }),
        relaySnapshot({ sourceMatchId: exactConflictSourceMatchId, scoreHome: 3, scoreAway: 1, capturedAt })
      ),
      observedAt: "2026-07-13T02:09:00.000Z",
    });
    const exactConflictState = readDbState(exactConflictPaths.dbPath);
    check("same exact event with conflicting scores is rejected without hiding other event versions", (
      exactConflict.skipped === true
      && exactConflict.publishedRows === 0
      && exactConflict.rejected?.duplicateConflict === 1
      && exactConflictState.rows.filter((row) => row.dataset === "current").length === 1
      && exactConflictState.rows.filter((row) => row.dataset === "history").length === 0
    ), { reason: exactConflict.reason, rejected: exactConflict.rejected });

    const enrichedIdentitySource = "identity-enrichment-5002";
    const nameOnlyCurrent = {
      ...baseCurrentMatch({ sourceMatchId: enrichedIdentitySource }),
      homeTeamId: undefined,
      awayTeamId: undefined,
    };
    const enrichedIdentityPaths = scenario(
      tempRoot,
      "identity-enrichment",
      [nameOnlyCurrent],
    );
    const enrichedIdentityPublication = publishOfficialResultsFast({
      ...enrichedIdentityPaths,
      relaySnapshot: combinedRelaySnapshot(
        relaySnapshot({
          sourceMatchId: enrichedIdentitySource,
          capturedAt,
          rowOverrides: { homeTeamId: undefined, awayTeamId: undefined },
        }),
        relaySnapshot({ sourceMatchId: enrichedIdentitySource, capturedAt }),
      ),
      observedAt: "2026-07-13T02:09:30.000Z",
    });
    const enrichedIdentityState = readDbState(enrichedIdentityPaths.dbPath);
    check("name-only current and compatible code enrichment bind to one stable official event", (
      enrichedIdentityPublication.publishedRows === 1
      && enrichedIdentityPublication.rejected?.duplicateConflict === 0
      && enrichedIdentityState.rows.filter((row) => row.dataset === "current").length === 0
      && enrichedIdentityState.rows.filter((row) => row.dataset === "history").length === 1
    ), {
      publishedRows: enrichedIdentityPublication.publishedRows,
      rejected: enrichedIdentityPublication.rejected,
    });

    const conflictingIdentityRows = [
      { homeTeamAllName: "identity-home-a", awayTeamAllName: "identity-away-a", homeTeamId: undefined, awayTeamId: undefined },
      { homeTeamAllName: "identity-home-b", awayTeamAllName: "identity-away-b", homeTeamId: undefined, awayTeamId: undefined },
    ];
    const conflictingIdentityResults = [];
    for (const [index, orderedRows] of [
      conflictingIdentityRows,
      [...conflictingIdentityRows].reverse(),
    ].entries()) {
      const sourceMatchId = `identity-conflict-${index}`;
      const paths = scenario(tempRoot, `identity-conflict-${index}`, [baseCurrentMatch({ sourceMatchId })]);
      const publication = publishOfficialResultsFast({
        ...paths,
        relaySnapshot: combinedRelaySnapshot(...orderedRows.map((rowOverrides) => relaySnapshot({
          sourceMatchId,
          capturedAt,
          rowOverrides,
        }))),
        observedAt: "2026-07-13T02:09:40.000Z",
      });
      const state = readDbState(paths.dbPath);
      conflictingIdentityResults.push({ publication, state });
    }
    check("conflicting team identities reject the whole stable event in both arrival orders", (
      conflictingIdentityResults.every(({ publication, state }) => (
        publication.skipped === true
        && publication.publishedRows === 0
        && publication.rejected?.duplicateConflict === 1
        && state.rows.filter((row) => row.dataset === "history").length === 0
        && state.rows.filter((row) => row.dataset === "current").length === 1
      ))
    ), {
      rejected: conflictingIdentityResults.map(({ publication }) => publication.rejected),
    });
    const latencySourceMatchId = "latency-live-5003";
    const latencyCapturedAt = new Date(Date.now() - 1_000).toISOString();
    const latencyPaths = scenario(tempRoot, "latency-live", [baseCurrentMatch({
      sourceMatchId: latencySourceMatchId,
    })]);
    const latencyPublication = publishOfficialResultsFast({
      ...latencyPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: latencySourceMatchId,
        capturedAt: latencyCapturedAt,
      }),
    });
    check("new signed result probe reaches SQLite publication inside ten seconds", (
      latencyPublication.publishedRows === 1
      && Number.isFinite(latencyPublication.sourceToPublishedMs)
      && latencyPublication.sourceToPublishedMs >= 0
      && latencyPublication.sourceToPublishedMs < 10_000
    ), { sourceToPublishedMs: latencyPublication.sourceToPublishedMs });

    const firstPayload = firstState.rows.find((row) => row.dataset === "history")?.payload;
    const nextCycleSnapshot = relaySnapshot({
      capturedAt: "2026-07-13T02:10:00.000Z",
    });
    const second = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: nextCycleSnapshot,
      observedAt: "2026-07-13T02:10:00.000Z",
    });
    const secondState = readDbState(trustedPaths.dbPath);
    const secondHistory = secondState.rows.find((row) => row.dataset === "history")?.match;
    const secondAuthority = authorityRowsFromState(secondState)[0] || null;
    check("same result from a newer relay capture and source cycle is semantically idempotent", (
      second.skipped === true
      && second.publishedRows === 0
      && second.reason === "no-result-state-change-fast-path"
      && second.fastPath === true
      && second.ledgerLoaded === false
      && second.writeTransactionStarted === true
      && second.authorityHighWaterUpdated === true
      && second.sourceCycleId !== first.sourceCycleId
      && secondState.rows.find((row) => row.dataset === "history")?.payload === firstPayload
      && secondHistory?.resultObservedAt === observedAt
      && secondAuthority?.scoreHome === 2
      && secondAuthority?.scoreAway === 1
      && secondAuthority?.observedAt === "2026-07-13T02:10:00.000Z"
      && secondAuthority?.sourceCycleId === second.sourceCycleId
      && secondState.meta.fast_result_revision === "1"
    ), {
      reason: second.reason,
      fastPath: second.fastPath,
      ledgerLoaded: second.ledgerLoaded,
      writeTransactionStarted: second.writeTransactionStarted,
      resultObservedAt: secondHistory?.resultObservedAt || null,
    });

    fs.writeFileSync(trustedPaths.syncMetaPath, `${JSON.stringify({
      version: "fixture-sync-meta",
      sentinel: { preserve: true },
      fastResultRevision: 0,
      api: { currentFreshnessTime: "2026-07-13T01:00:00.000Z" },
    }, null, 2)}\n`);
    const recovered = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: trustedSnapshot,
      observedAt: "2026-07-13T02:12:00.000Z",
    });
    const recoveredMeta = JSON.parse(fs.readFileSync(trustedPaths.syncMetaPath, "utf8"));
    check("SQLite receipt repairs a lost sync-meta commit and republishes visibility", (
      recovered.skipped === false
      && recovered.visibleStateChanged === true
      && recovered.publishedRows === 0
      && recovered.fastPath === true
      && recovered.ledgerLoaded === false
      && recovered.writeTransactionStarted === false
      && recoveredMeta.fastResultRevision === 1
      && recoveredMeta.fastResultObservations?.rows?.[0]?.resultObservedAt === observedAt
      && recoveredMeta.sentinel?.preserve === true
    ), {
      reason: recovered.reason,
      revision: recoveredMeta.fastResultRevision,
    });

    const staleConflict = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:04:00.000Z",
      }),
      observedAt: "2026-07-13T02:04:00.000Z",
    });
    const staleConflictState = readDbState(trustedPaths.dbPath);
    const staleConflictHistory = staleConflictState.rows.find((row) => row.dataset === "history")?.match;
    check("conflicting score cannot overwrite terminal history when stale or same-clock", (
      staleConflict.skipped === true
      && staleConflict.publishedRows === 0
      && staleConflict.rejected?.correctionRejected === 1
      && staleConflictHistory?.scoreHome === 2
      && staleConflictHistory?.scoreAway === 1
      && staleConflictState.meta.fast_result_revision === "1"
    ), { reason: staleConflict.reason, score: `${staleConflictHistory?.scoreHome}-${staleConflictHistory?.scoreAway}` });

    const correction = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:15:00.000Z",
      }),
      observedAt: "2026-07-13T02:15:00.000Z",
    });
    const correctionState = readDbState(trustedPaths.dbPath);
    const correctionHistoryRow = correctionState.rows.find((row) => row.dataset === "history");
    const correctionHistory = correctionHistoryRow?.match;
    const correctionAuthority = authorityRowsFromState(correctionState)[0] || null;
    const correctionMeta = JSON.parse(fs.readFileSync(trustedPaths.syncMetaPath, "utf8"));
    check("strictly newer unambiguous official correction atomically recomputes review and revision", (
      correction.skipped === false
      && correction.publishedRows === 1
      && correction.published?.[0]?.changeType === "official-score-correction"
      && correction.published?.[0]?.resultRevision === 2
      && correctionHistory?.scoreHome === 3
      && correctionHistory?.scoreAway === 1
      && correctionAuthority?.scoreHome === correctionHistory?.scoreHome
      && correctionAuthority?.scoreAway === correctionHistory?.scoreAway
      && correctionAuthority?.observedAt === "2026-07-13T02:15:00.000Z"
      && correctionAuthority?.sourceCycleId === correction.sourceCycleId
      && correctionHistory?.resultObservedAt === observedAt
      && correctionHistory?.resultUpdatedAt === "2026-07-13T02:15:00.000Z"
      && correctionHistory?.postMatchReview?.finalScore === "3-1"
      && correctionHistory?.postMatchReview?.settlement?.resultRevision === 2
      && correctionHistory?.sourceCycleId === correctionHistory?.postMatchReview?.settlement?.sourceCycleId
      && correctionHistory?.datasetRevision === correctionHistory?.postMatchReview?.settlement?.datasetRevision
      && correctionHistory?.postMatchReview?.predictionReview?.rows?.length === 0
      && correctionHistory?.postMatchReview?.predictionReview?.referenceSettled === 0
      && correctionState.meta.fast_result_revision === "2"
      && correctionMeta.fastResultRevision === 2
      && correctionMeta.fastResultObservations?.rows?.some((row) => row.scoreHome === 3 && row.scoreAway === 1)
    ), {
      published: correction.published,
      score: `${correctionHistory?.scoreHome}-${correctionHistory?.scoreAway}`,
      resultRevision: correctionHistory?.postMatchReview?.settlement?.resultRevision || null,
      fastResultRevision: correctionMeta.fastResultRevision,
    });

    const correctedPayload = correctionHistoryRow?.payload;
    const repeatedCorrection = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:20:00.000Z",
      }),
      observedAt: "2026-07-13T02:20:00.000Z",
    });
    const repeatedCorrectionState = readDbState(trustedPaths.dbPath);
    const repeatedCorrectionAuthority = authorityRowsFromState(repeatedCorrectionState)[0] || null;
    check("repeated corrected result is idempotent and does not emit another visible revision", (
      repeatedCorrection.skipped === true
      && repeatedCorrection.publishedRows === 0
      && repeatedCorrection.reason === "no-result-state-change-fast-path"
      && repeatedCorrection.fastPath === true
      && repeatedCorrection.ledgerLoaded === false
      && repeatedCorrection.writeTransactionStarted === true
      && repeatedCorrection.authorityHighWaterUpdated === true
      && repeatedCorrectionState.rows.find((row) => row.dataset === "history")?.payload === correctedPayload
      && repeatedCorrectionAuthority?.scoreHome === 3
      && repeatedCorrectionAuthority?.scoreAway === 1
      && repeatedCorrectionAuthority?.observedAt === "2026-07-13T02:20:00.000Z"
      && repeatedCorrectionAuthority?.sourceCycleId === repeatedCorrection.sourceCycleId
      && repeatedCorrectionState.meta.fast_result_revision === "2"
    ), {
      reason: repeatedCorrection.reason,
      fastPath: repeatedCorrection.fastPath,
      ledgerLoaded: repeatedCorrection.ledgerLoaded,
      writeTransactionStarted: repeatedCorrection.writeTransactionStarted,
    });

    const correctedExportDir = path.join(tempRoot, "corrected-stale-public");
    fs.mkdirSync(correctedExportDir, { recursive: true });
    const aliasDriftCurrent = {
      ...baseCurrentMatch(),
      homeTeamId: "home-fast-enriched",
      awayTeamId: "away-fast-enriched",
      homeTeamName: "enriched-home-name",
      awayTeamName: "enriched-away-name",
    };
    const stalePreCorrectionHistory = {
      ...history,
      homeTeamId: "home-fast-enriched",
      awayTeamId: "away-fast-enriched",
      homeTeamName: "enriched-home-name",
      awayTeamName: "enriched-away-name",
    };
    fs.writeFileSync(
      path.join(correctedExportDir, "matches-current.json"),
      `${JSON.stringify([aliasDriftCurrent])}\n`,
    );
    fs.writeFileSync(
      path.join(correctedExportDir, "matches-history.json"),
      `${JSON.stringify([stalePreCorrectionHistory])}\n`,
    );
    fs.writeFileSync(path.join(correctedExportDir, "sync-meta.json"), `${JSON.stringify({
      source: "simulated-stale-full-sync-after-correction",
      updatedAt: "2026-07-13T02:09:00.000Z",
    })}\n`);
    const correctedExport = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          SQLITE_EXPORT_PUBLIC_DATA_DIR: correctedExportDir,
          SERVER_STORE_DIR: path.dirname(trustedPaths.dbPath),
          DATASTORE_SQLITE_PATH: trustedPaths.dbPath,
          SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
          SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
          SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
          SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
        },
      },
    );
    const correctedAfterExport = readDbState(trustedPaths.dbPath);
    const correctedAfterExportHistory = correctedAfterExport.rows.find(
      (row) => row.dataset === "history" && row.match.sourceMatchId === "fast-1001",
    )?.match;
    check("correction receipt groups retain audit history while exporter guards only the current authority score", (
      correctedExport.status === 0
      && correctedAfterExport.rows.filter((row) => row.dataset === "current").length === 0
      && correctedAfterExportHistory?.scoreHome === 3
      && correctedAfterExportHistory?.scoreAway === 1
      && JSON.parse(correctedAfterExport.meta.fast_result_receipt).observations.length === 2
    ), {
      exportStatus: correctedExport.status,
      score: `${correctedAfterExportHistory?.scoreHome}-${correctedAfterExportHistory?.scoreAway}`,
      stderr: correctedExport.status === 0 ? "" : correctedExport.stderr.slice(-500),
    });

    const makeLegacyReceiptClone = (name) => {
      const dir = path.join(tempRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, "football.db");
      const syncMetaPath = path.join(dir, "sync-meta.json");
      fs.copyFileSync(trustedPaths.dbPath, dbPath);
      fs.copyFileSync(trustedPaths.syncMetaPath, syncMetaPath);
      const db = new DatabaseSync(dbPath);
      const receiptRow = db.prepare(
        "SELECT value, updated_at FROM schema_meta WHERE key = 'fast_result_receipt'"
      ).get();
      const receipt = JSON.parse(receiptRow.value);
      delete receipt.observationsRootHash;
      receipt.version = "sqlite-fast-result-receipt-v1";
      db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'fast_result_receipt'")
        .run(JSON.stringify(receipt));
      db.prepare(`
        DELETE FROM schema_meta
        WHERE key = 'fast_result_authority_high_water'
           OR key = 'fast_result_authority_high_water:initialized'
           OR key LIKE 'fast_result_authority_high_water:event:%'
      `).run();
      db.close();
      return {
        dbPath,
        syncMetaPath,
        publicationLedgerPath: path.join(dir, "missing-publication-ledger.json"),
        trustRegistry: publisherCollector.registry,
      };
    };

    const makeLegacyMidnightAliasClone = (name, {
      includeExactObservation = true,
      immutableArchive = true,
      ambiguousAlias = false,
      unrelatedTrustedHistory = false,
    } = {}) => {
      const paths = makeLegacyReceiptClone(name);
      const db = new DatabaseSync(paths.dbPath);
      const receiptRow = db.prepare(
        "SELECT value FROM schema_meta WHERE key = 'fast_result_receipt'"
      ).get();
      const receipt = JSON.parse(receiptRow.value);
      const historyRow = db.prepare(`
        SELECT id, match_id, source_match_id, kickoff_time, status, payload
        FROM match_snapshots
        WHERE dataset = 'history' AND source_match_id = 'fast-1001'
        LIMIT 1
      `).get();
      const historyMatch = JSON.parse(historyRow.payload);
      const exactObservation = receipt.observations.find((row) => (
        sameEvent(historyMatch, row)
        && row.scoreHome === historyMatch.scoreHome
        && row.scoreAway === historyMatch.scoreAway
      ));
      const actualEvent = new Date(Date.parse(historyMatch.eventVersion || historyMatch.kickoffTime))
        .toISOString();
      const legacyMidnightEvent = "2026-07-12T16:00:00.000Z";
      historyMatch.archivedPreMatchPrediction = immutableArchive ? {
        ...(historyMatch.archivedPreMatchPrediction || {}),
        version: "archived-pre-match-prediction-v1",
        source: "immutable-pre-match-prediction-snapshot",
        sourceMatchId: historyMatch.sourceMatchId,
        matchId: historyMatch.id,
        kickoffTime: actualEvent,
        eventVersion: actualEvent,
        capturedAt: "2026-07-13T01:50:00.000Z",
      } : undefined;
      db.prepare("UPDATE match_snapshots SET payload = ? WHERE id = ?")
        .run(JSON.stringify(historyMatch), historyRow.id);
      const aliasObservation = normalizeObservation({
        ...exactObservation,
        key: null,
        kickoffTime: legacyMidnightEvent,
        eventVersion: legacyMidnightEvent,
      });
      if (!aliasObservation) {
        db.close();
        throw new Error("legacy midnight alias fixture observation invalid");
      }
      receipt.observations = includeExactObservation
        ? [aliasObservation, ...receipt.observations]
        : [aliasObservation];
      db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'fast_result_receipt'")
        .run(JSON.stringify(receipt));

      if (ambiguousAlias) {
        const secondEvent = new Date(Date.parse(actualEvent) + (60 * 1000)).toISOString();
        const ambiguousMatch = JSON.parse(JSON.stringify(historyMatch));
        ambiguousMatch.id = `${historyMatch.id}:ambiguous-event`;
        ambiguousMatch.kickoffTime = secondEvent;
        ambiguousMatch.eventVersion = secondEvent;
        ambiguousMatch.resultProvenance = {
          ...ambiguousMatch.resultProvenance,
          kickoffTime: secondEvent,
          eventVersion: secondEvent,
        };
        ambiguousMatch.archivedPreMatchPrediction = {
          ...ambiguousMatch.archivedPreMatchPrediction,
          matchId: ambiguousMatch.id,
          kickoffTime: secondEvent,
          eventVersion: secondEvent,
        };
        db.prepare(`
          INSERT INTO match_snapshots
            (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
          VALUES (?, 'history', ?, ?, ?, ?, ?)
        `).run(
          "history:fast-1001:ambiguous-midnight-event",
          ambiguousMatch.id,
          ambiguousMatch.sourceMatchId,
          secondEvent,
          historyRow.status,
          JSON.stringify(ambiguousMatch),
        );
      }

      if (unrelatedTrustedHistory) {
        const unrelatedMatch = JSON.parse(JSON.stringify(historyMatch));
        unrelatedMatch.id = "sporttery_unreceipted-history";
        unrelatedMatch.sourceMatchId = "unreceipted-history";
        unrelatedMatch.kickoffTime = "2026-07-14T02:00:00.000Z";
        unrelatedMatch.eventVersion = unrelatedMatch.kickoffTime;
        unrelatedMatch.resultProvenance = {
          ...unrelatedMatch.resultProvenance,
          sourceMatchId: unrelatedMatch.sourceMatchId,
          kickoffTime: unrelatedMatch.kickoffTime,
          eventVersion: unrelatedMatch.eventVersion,
        };
        unrelatedMatch.archivedPreMatchPrediction = {
          ...unrelatedMatch.archivedPreMatchPrediction,
          sourceMatchId: unrelatedMatch.sourceMatchId,
          matchId: unrelatedMatch.id,
          kickoffTime: unrelatedMatch.kickoffTime,
          eventVersion: unrelatedMatch.eventVersion,
          capturedAt: "2026-07-14T01:50:00.000Z",
        };
        db.prepare(`
          INSERT INTO match_snapshots
            (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
          VALUES (?, 'history', ?, ?, ?, ?, ?)
        `).run(
          "history:sporttery_unreceipted-history",
          unrelatedMatch.id,
          unrelatedMatch.sourceMatchId,
          unrelatedMatch.kickoffTime,
          historyRow.status,
          JSON.stringify(unrelatedMatch),
        );
      }
      db.close();
      return { paths, aliasObservation };
    };

    const midnightLegacy = makeLegacyMidnightAliasClone(
      "legacy-v1-midnight-alias-migration",
      { unrelatedTrustedHistory: true },
    );
    let midnightLegacyDb = new DatabaseSync(midnightLegacy.paths.dbPath);
    const midnightLegacyMigration = migrateLegacyFastResultIntegrity(midnightLegacyDb);
    midnightLegacyDb.close();
    const midnightLegacyState = readDbState(midnightLegacy.paths.dbPath);
    const midnightLegacyReceipt = JSON.parse(midnightLegacyState.meta.fast_result_receipt || "null");
    const midnightLegacyRoot = midnightLegacyReceipt?.observationsRootHash || null;
    check("legacy midnight audit rows resolve to exact receipt authority without trust expansion", (
      midnightLegacyMigration.ok === true
      && midnightLegacyMigration.migrated === true
      && midnightLegacyMigration.legacyAliasObservations === 1
      && midnightLegacyReceipt?.version === "sqlite-fast-result-receipt-v2"
      && midnightLegacyReceipt?.observations?.length === 3
      && midnightLegacyReceipt.observations.some(
        (row) => row.key === midnightLegacy.aliasObservation.key
      )
      && authorityRowsFromState(midnightLegacyState).length === 1
      && Boolean(midnightLegacyRoot)
    ), {
      migration: midnightLegacyMigration,
      observationRows: midnightLegacyReceipt?.observations?.length || 0,
      authorityRows: authorityRowsFromState(midnightLegacyState).length,
      aliasRetained: midnightLegacyReceipt?.observations?.some(
        (row) => row.key === midnightLegacy.aliasObservation.key
      ) || false,
    });

    const midnightExportDir = path.join(tempRoot, "legacy-v1-midnight-alias-export");
    fs.mkdirSync(midnightExportDir, { recursive: true });
    fs.writeFileSync(path.join(midnightExportDir, "matches-current.json"), "[]\n");
    fs.writeFileSync(path.join(midnightExportDir, "matches-history.json"), "[]\n");
    fs.writeFileSync(path.join(midnightExportDir, "sync-meta.json"), "{}\n");
    const midnightLegacyExport = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          SQLITE_EXPORT_PUBLIC_DATA_DIR: midnightExportDir,
          SERVER_STORE_DIR: path.dirname(midnightLegacy.paths.dbPath),
          DATASTORE_SQLITE_PATH: midnightLegacy.paths.dbPath,
          SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
          SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
          SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
          SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
        },
      },
    );
    const midnightAfterExport = readDbState(midnightLegacy.paths.dbPath);
    const midnightAfterExportReceipt = JSON.parse(
      midnightAfterExport.meta.fast_result_receipt || "null"
    );
    check("export guard treats a validated midnight alias as audit-only and preserves the exact final", (
      midnightLegacyExport.status === 0
      && midnightAfterExport.rows.some((row) => (
        row.dataset === "history"
        && row.match.sourceMatchId === "fast-1001"
        && row.match.scoreHome === 3
        && row.match.scoreAway === 1
      ))
      && midnightAfterExportReceipt?.observations?.length === 3
      && midnightAfterExportReceipt?.observationsRootHash === midnightLegacyRoot
    ), {
      exportStatus: midnightLegacyExport.status,
      receiptRootUnchanged: midnightAfterExportReceipt?.observationsRootHash === midnightLegacyRoot,
      stderr: midnightLegacyExport.status === 0 ? "" : midnightLegacyExport.stderr.slice(-500),
    });

    const aliasOnlyLegacy = makeLegacyMidnightAliasClone(
      "legacy-v1-midnight-alias-only",
      { includeExactObservation: false },
    );
    const aliasOnlyDb = new DatabaseSync(aliasOnlyLegacy.paths.dbPath);
    const aliasOnlyMigration = migrateLegacyFastResultIntegrity(aliasOnlyDb);
    const aliasOnlyAuthorityRows = Number(aliasOnlyDb.prepare(`
      SELECT COUNT(*) AS value FROM schema_meta
      WHERE key LIKE 'fast_result_authority_high_water%'
    `).get().value || 0);
    const aliasOnlyVersion = JSON.parse(aliasOnlyDb.prepare(
      "SELECT value FROM schema_meta WHERE key = 'fast_result_receipt'"
    ).get().value).version;
    aliasOnlyDb.close();
    check("a midnight alias without an exact current-event observation cannot create authority", (
      aliasOnlyMigration.ok === false
      && aliasOnlyMigration.mismatchKind === "current-authority-exact-observation-missing"
      && aliasOnlyVersion === "sqlite-fast-result-receipt-v1"
      && aliasOnlyAuthorityRows === 0
    ), { migration: aliasOnlyMigration, authorityRows: aliasOnlyAuthorityRows });

    const ambiguousAliasLegacy = makeLegacyMidnightAliasClone(
      "legacy-v1-midnight-alias-ambiguous",
      { ambiguousAlias: true },
    );
    const ambiguousAliasDb = new DatabaseSync(ambiguousAliasLegacy.paths.dbPath);
    const ambiguousAliasMigration = migrateLegacyFastResultIntegrity(ambiguousAliasDb);
    const ambiguousAliasAuthorityRows = Number(ambiguousAliasDb.prepare(`
      SELECT COUNT(*) AS value FROM schema_meta
      WHERE key LIKE 'fast_result_authority_high_water%'
    `).get().value || 0);
    ambiguousAliasDb.close();
    check("a midnight alias with multiple immutable event candidates fails closed", (
      ambiguousAliasMigration.ok === false
      && ambiguousAliasMigration.mismatchKind === "current-authority-event-ambiguous"
      && ambiguousAliasMigration.legacyAliasHistoryRows === 2
      && ambiguousAliasAuthorityRows === 0
    ), { migration: ambiguousAliasMigration, authorityRows: ambiguousAliasAuthorityRows });

    const noArchiveAliasLegacy = makeLegacyMidnightAliasClone(
      "legacy-v1-midnight-alias-no-archive",
      { immutableArchive: false },
    );
    const noArchiveAliasDb = new DatabaseSync(noArchiveAliasLegacy.paths.dbPath);
    const noArchiveAliasMigration = migrateLegacyFastResultIntegrity(noArchiveAliasDb);
    const noArchiveAliasAuthorityRows = Number(noArchiveAliasDb.prepare(`
      SELECT COUNT(*) AS value FROM schema_meta
      WHERE key LIKE 'fast_result_authority_high_water%'
    `).get().value || 0);
    noArchiveAliasDb.close();
    check("a midnight alias without an immutable pre-match event binding fails closed", (
      noArchiveAliasMigration.ok === false
      && noArchiveAliasMigration.mismatchKind === "current-authority-event-missing"
      && noArchiveAliasMigration.legacyAliasHistoryRows === 0
      && noArchiveAliasAuthorityRows === 0
    ), { migration: noArchiveAliasMigration, authorityRows: noArchiveAliasAuthorityRows });

    const correctedLegacyPaths = makeLegacyReceiptClone("legacy-v1-corrected-score-migration");
    let correctedLegacyDb = new DatabaseSync(correctedLegacyPaths.dbPath);
    const correctedLegacyMigration = migrateLegacyFastResultIntegrity(correctedLegacyDb);
    correctedLegacyDb.close();
    const correctedLegacyState = readDbState(correctedLegacyPaths.dbPath);
    const correctedLegacyReceipt = JSON.parse(correctedLegacyState.meta.fast_result_receipt || "null");
    const correctedLegacyAuthority = authorityRowsFromState(correctedLegacyState)[0] || null;
    check("legacy v1 correction observations migrate by event while preserving the old score audit row", (
      correctedLegacyMigration.ok === true
      && correctedLegacyMigration.migrated === true
      && correctedLegacyReceipt?.version === "sqlite-fast-result-receipt-v2"
      && correctedLegacyReceipt?.observations?.length === 2
      && correctedLegacyReceipt.observations.some((row) => row.scoreHome === 2 && row.scoreAway === 1)
      && correctedLegacyReceipt.observations.some((row) => row.scoreHome === 3 && row.scoreAway === 1)
      && correctedLegacyAuthority?.scoreHome === 3
      && correctedLegacyAuthority?.scoreAway === 1
    ), {
      migration: correctedLegacyMigration,
      receiptVersion: correctedLegacyReceipt?.version || null,
      observationRows: correctedLegacyReceipt?.observations?.length || 0,
      authorityScore: correctedLegacyAuthority
        ? `${correctedLegacyAuthority.scoreHome}-${correctedLegacyAuthority.scoreAway}`
        : null,
    });
    const correctedLegacyRoot = correctedLegacyReceipt?.observationsRootHash || null;
    correctedLegacyDb = new DatabaseSync(correctedLegacyPaths.dbPath);
    const correctedLegacyRepeat = migrateLegacyFastResultIntegrity(correctedLegacyDb);
    correctedLegacyDb.close();
    const correctedLegacyRepeatedState = readDbState(correctedLegacyPaths.dbPath);
    const correctedLegacyRepeatedReceipt = JSON.parse(
      correctedLegacyRepeatedState.meta.fast_result_receipt || "null"
    );
    check("repeating the legacy migration cannot append events or change the receipt root", (
      correctedLegacyRepeat.ok === false
      && correctedLegacyRepeat.reason === "legacy-receipt-no-longer-migratable"
      && correctedLegacyRepeatedReceipt?.observations?.length === 2
      && correctedLegacyRepeatedReceipt?.observationsRootHash === correctedLegacyRoot
      && authorityRowsFromState(correctedLegacyRepeatedState).length === 1
    ), {
      repeatReason: correctedLegacyRepeat.reason,
      receiptRootUnchanged: correctedLegacyRepeatedReceipt?.observationsRootHash === correctedLegacyRoot,
      observationRows: correctedLegacyRepeatedReceipt?.observations?.length || 0,
      authorityRows: authorityRowsFromState(correctedLegacyRepeatedState).length,
    });
    const correctedLegacyOldScoreReplay = publishOfficialResultsFast({
      ...correctedLegacyPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 2,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:14:00.000Z",
      }),
      observedAt: "2026-07-13T02:14:00.000Z",
    });
    const correctedLegacyAfterReplay = readDbState(correctedLegacyPaths.dbPath);
    const correctedLegacyAfterReplayHistory = correctedLegacyAfterReplay.rows.find(
      (row) => row.dataset === "history" && row.match.sourceMatchId === "fast-1001"
    )?.match;
    check("migrated authority high-water rejects an older replay of the superseded legacy score", (
      correctedLegacyOldScoreReplay.skipped === true
      && correctedLegacyOldScoreReplay.publishedRows === 0
      && correctedLegacyOldScoreReplay.reason === "no-result-state-change"
      && correctedLegacyOldScoreReplay.rejected?.correctionRejected === 1
      && correctedLegacyAfterReplayHistory?.scoreHome === 3
      && correctedLegacyAfterReplayHistory?.scoreAway === 1
      && JSON.parse(correctedLegacyAfterReplay.meta.fast_result_receipt).observations.length === 2
    ), {
      reason: correctedLegacyOldScoreReplay.reason,
      correctionRejected: correctedLegacyOldScoreReplay.rejected?.correctionRejected ?? null,
      score: correctedLegacyAfterReplayHistory
        ? `${correctedLegacyAfterReplayHistory.scoreHome}-${correctedLegacyAfterReplayHistory.scoreAway}`
        : null,
    });

    const ambiguousLegacyPaths = makeLegacyReceiptClone("legacy-v1-ambiguous-history-migration");
    const ambiguousLegacyDb = new DatabaseSync(ambiguousLegacyPaths.dbPath);
    const ambiguousHistory = ambiguousLegacyDb.prepare(`
      SELECT match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE dataset = 'history' AND source_match_id = 'fast-1001'
      LIMIT 1
    `).get();
    ambiguousLegacyDb.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES ('history:fast-1001:ambiguous-copy', 'history', ?, ?, ?, ?, ?)
    `).run(
      ambiguousHistory.match_id,
      ambiguousHistory.source_match_id,
      ambiguousHistory.kickoff_time,
      ambiguousHistory.status,
      ambiguousHistory.payload,
    );
    const ambiguousLegacyMigration = migrateLegacyFastResultIntegrity(ambiguousLegacyDb);
    const ambiguousLegacyReceiptVersion = JSON.parse(ambiguousLegacyDb.prepare(
      "SELECT value FROM schema_meta WHERE key = 'fast_result_receipt'"
    ).get().value).version;
    const ambiguousAuthorityRows = Number(ambiguousLegacyDb.prepare(`
      SELECT COUNT(*) AS value FROM schema_meta
      WHERE key LIKE 'fast_result_authority_high_water%'
    `).get().value || 0);
    ambiguousLegacyDb.close();
    check("legacy migration rejects duplicate current authority history without partial writes", (
      ambiguousLegacyMigration.ok === false
      && ambiguousLegacyMigration.reason === "legacy-receipt-history-mismatch"
      && ambiguousLegacyMigration.mismatchKind === "current-authority-event-ambiguous"
      && ambiguousLegacyReceiptVersion === "sqlite-fast-result-receipt-v1"
      && ambiguousAuthorityRows === 0
    ), {
      migration: ambiguousLegacyMigration,
      receiptVersion: ambiguousLegacyReceiptVersion,
      authorityRows: ambiguousAuthorityRows,
    });

    const erasedReceiptPaths = scenario(tempRoot, "erased-receipt-with-water", [baseCurrentMatch({
      sourceMatchId: "erased-receipt-1001",
    })]);
    const erasedReceiptFirst = publishOfficialResultsFast({
      ...erasedReceiptPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "erased-receipt-1001",
        capturedAt: "2026-07-13T02:30:00.000Z",
      }),
      observedAt: "2026-07-13T02:30:00.000Z",
    });
    const erasedReceiptDb = new DatabaseSync(erasedReceiptPaths.dbPath);
    erasedReceiptDb.prepare(`
      DELETE FROM schema_meta
      WHERE key IN (
        'fast_result_receipt',
        'fast_result_revision',
        'fast_result_published_at',
        'fast_result_source_cycle_id',
        'fast_result_dataset_revision'
      )
    `).run();
    erasedReceiptDb.close();
    const erasedReceiptBefore = readDbState(erasedReceiptPaths.dbPath);
    const erasedReceiptReplay = publishOfficialResultsFast({
      ...erasedReceiptPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "erased-receipt-1001",
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:31:00.000Z",
      }),
      observedAt: "2026-07-13T02:31:00.000Z",
    });
    const erasedReceiptAfter = readDbState(erasedReceiptPaths.dbPath);
    const erasedReceiptIntegrity = await readSqliteFastResultReceiptState(erasedReceiptPaths.dbPath);
    check("receipt deletion cannot masquerade as pristine bootstrap while authority high-water remains", (
      erasedReceiptFirst.publishedRows === 1
      && erasedReceiptReplay.skipped === true
      && erasedReceiptReplay.reason === "fast-result-receipt-invalid"
      && erasedReceiptIntegrity.valid === false
      && erasedReceiptIntegrity.missing === false
      && erasedReceiptIntegrity.reason === "receipt-revision-pair-uninitialized"
      && JSON.stringify(erasedReceiptAfter) === JSON.stringify(erasedReceiptBefore)
    ), {
      reason: erasedReceiptReplay.reason,
      integrity: erasedReceiptIntegrity,
      databaseUnchanged: JSON.stringify(erasedReceiptAfter) === JSON.stringify(erasedReceiptBefore),
    });

    const corruptedTimestampPaths = scenario(tempRoot, "corrupted-receipt-timestamp", [baseCurrentMatch({
      sourceMatchId: "corrupted-receipt-timestamp-1001",
    })]);
    const corruptedTimestampFirst = publishOfficialResultsFast({
      ...corruptedTimestampPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "corrupted-receipt-timestamp-1001",
        capturedAt: "2026-07-13T02:32:00.000Z",
      }),
      observedAt: "2026-07-13T02:32:00.000Z",
    });
    const corruptedTimestampDb = new DatabaseSync(corruptedTimestampPaths.dbPath);
    corruptedTimestampDb.prepare(`
      UPDATE schema_meta
      SET updated_at = ?
      WHERE key = 'fast_result_revision'
    `).run("2026-07-13T02:32:01.000Z");
    corruptedTimestampDb.close();
    const corruptedTimestampBefore = readDbState(corruptedTimestampPaths.dbPath);
    const corruptedTimestampIntegrity = await readSqliteFastResultReceiptState(
      corruptedTimestampPaths.dbPath,
    );
    const corruptedTimestampReplay = publishOfficialResultsFast({
      ...corruptedTimestampPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "corrupted-receipt-timestamp-1001",
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:33:00.000Z",
      }),
      observedAt: "2026-07-13T02:33:00.000Z",
    });
    const corruptedTimestampAfter = readDbState(corruptedTimestampPaths.dbPath);
    check("receipt metadata timestamp corruption is visible and blocks all further writes", (
      corruptedTimestampFirst.publishedRows === 1
      && corruptedTimestampIntegrity.valid === false
      && corruptedTimestampIntegrity.reason === "receipt-or-revision-invalid"
      && corruptedTimestampReplay.skipped === true
      && corruptedTimestampReplay.reason === "fast-result-receipt-invalid"
      && JSON.stringify(corruptedTimestampAfter) === JSON.stringify(corruptedTimestampBefore)
    ), {
      integrity: corruptedTimestampIntegrity,
      replayReason: corruptedTimestampReplay.reason || null,
      databaseUnchanged:
        JSON.stringify(corruptedTimestampAfter) === JSON.stringify(corruptedTimestampBefore),
    });

    const futureObservedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const futureCorrection = publishOfficialResultsFast({
      ...trustedPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 4,
        scoreAway: 1,
        capturedAt: futureObservedAt,
      }),
      observedAt: futureObservedAt,
    });
    const futureCorrectionState = readDbState(trustedPaths.dbPath);
    check("a relay capture beyond the trusted future-skew window cannot publish or correct a score", (
      futureCorrection.skipped === true
      && futureCorrection.reason === "trusted-result-probe-clock-in-future"
      && futureCorrection.publishedRows === 0
      && futureCorrectionState.rows.find((row) => row.dataset === "history")?.payload === correctedPayload
      && futureCorrectionState.meta.fast_result_revision === "2"
    ), { reason: futureCorrection.reason, observedAt: futureObservedAt });

    const staleReviewHistory = {
      ...correctionHistory,
      postMatchReview: {
        ...correctionHistory.postMatchReview,
        finalScore: "0-0",
      },
    };
    const repairPaths = scenario(tempRoot, "history-review-repair", [], [staleReviewHistory]);
    const repaired = publishOfficialResultsFast({
      ...repairPaths,
      relaySnapshot: relaySnapshot({
        scoreHome: 3,
        scoreAway: 1,
        capturedAt: "2026-07-13T02:25:00.000Z",
      }),
      observedAt: "2026-07-13T02:25:00.000Z",
    });
    const repairedState = readDbState(repairPaths.dbPath);
    const repairedHistory = repairedState.rows.find((row) => row.dataset === "history")?.match;
    const repairedMeta = JSON.parse(fs.readFileSync(repairPaths.syncMetaPath, "utf8"));
    check("an already archived same-event result repairs stale review content and advances the SSE revision", (
      repaired.skipped === false
      && repaired.publishedRows === 1
      && repaired.published?.[0]?.changeType === "review-refresh"
      && repairedHistory?.postMatchReview?.finalScore === "3-1"
      && repairedHistory?.postMatchReview?.predictionReview?.rows?.length === 0
      && repairedHistory?.postMatchReview?.predictionReview?.referenceSettled === 0
      && repairedHistory?.postMatchReview?.settlement?.resultRevision === 2
      && repairedHistory?.sourceCycleId === repairedHistory?.postMatchReview?.settlement?.sourceCycleId
      && repairedHistory?.datasetRevision === repairedHistory?.postMatchReview?.settlement?.datasetRevision
      && repairedState.meta.fast_result_revision === "1"
      && repairedMeta.fastResultRevision === 1
      && repairedMeta.api.historyFreshnessTime === repaired.publishedAt
    ), {
      published: repaired.published,
      finalScore: repairedHistory?.postMatchReview?.finalScore || null,
      revision: repairedMeta.fastResultRevision,
    });

    const untrustedPaths = scenario(tempRoot, "untrusted-url", [baseCurrentMatch({ sourceMatchId: "fast-2001" })]);
    const untrusted = publishOfficialResultsFast({
      ...untrustedPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: "fast-2001",
        url: "https://results.example.invalid/fake",
      }),
      observedAt,
    });
    const untrustedState = readDbState(untrustedPaths.dbPath);
    check("non-Sporttery HTTPS result URL is rejected", (
      untrusted.skipped === true
      && untrusted.reason === "trusted-fast-result-endpoints-unavailable"
      && untrusted.trustBlockers?.some((blocker) => blocker.includes("url-contract-invalid"))
      && untrustedState.rows.filter((row) => row.dataset === "current").length === 1
      && untrustedState.rows.filter((row) => row.dataset === "history").length === 0
    ), { reason: untrusted.reason, rejected: untrusted.rejected });

    const childRegistryPath = path.join(tempRoot, "publisher-child-trust-registry.json");
    fs.writeFileSync(
      childRegistryPath,
      `${JSON.stringify(publisherCollector.registry, null, 2)}\n`,
      "utf8",
    );
    const childRegistryWithoutDomainPath = path.join(
      tempRoot,
      "publisher-child-trust-registry-no-domain.json",
    );
    const registryWithoutDomain = JSON.parse(JSON.stringify(publisherCollector.registry));
    delete registryWithoutDomain.keys[0].independenceDomain;
    fs.writeFileSync(
      childRegistryWithoutDomainPath,
      `${JSON.stringify(registryWithoutDomain, null, 2)}\n`,
      "utf8",
    );
    const publisherChildCases = [
      { key: "valid-single-collector", mutate: null, valid: true },
      {
        key: "bad-signature",
        valid: false,
        mutate: (snapshot) => {
          const result = snapshot.endpoints.find((entry) => entry.method === "result");
          result.collectorAttestation.signature = "invalid-signature";
          result.collectorProvenance.collectorAttestation.signature = "invalid-signature";
        },
      },
      {
        key: "payload-tamper",
        valid: false,
        mutate: (snapshot) => {
          const result = snapshot.endpoints.find((entry) => entry.method === "result");
          result.payload.value.matchInfoList[0].subMatchList[0].sectionsNo999 = "9:9";
        },
      },
      {
        key: "role-relabel",
        valid: false,
        mutate: (snapshot) => {
          const result = snapshot.endpoints.find((entry) => entry.method === "result");
          result.collectorRole = "current";
        },
      },
      {
        key: "duplicate-result-key",
        valid: false,
        mutate: (snapshot) => {
          const result = snapshot.endpoints.find((entry) => entry.method === "result");
          snapshot.endpoints.push(JSON.parse(JSON.stringify(result)));
          snapshot.summary.endpoints += 1;
          snapshot.summary.usableEndpoints += 1;
          snapshot.summary.rows += 1;
        },
      },
      {
        key: "zero-result-fingerprint",
        valid: false,
        mutate: (snapshot) => {
          snapshot.producer.resultFingerprint = "0".repeat(64);
        },
      },
      {
        key: "summary-mismatch",
        valid: false,
        mutate: (snapshot) => {
          snapshot.summary.rows += 1;
        },
      },
      {
        key: "unexpected-endpoint",
        valid: false,
        mutate: (snapshot) => {
          const current = snapshot.endpoints.find((entry) => entry.method === "current");
          const unexpected = JSON.parse(JSON.stringify(current));
          unexpected.id = "method:concern:1";
          unexpected.method = "concern";
          unexpected.page = 1;
          snapshot.endpoints.push(unexpected);
          snapshot.summary.endpoints += 1;
          snapshot.summary.usableEndpoints += 1;
          snapshot.summary.rows += 1;
          snapshot.summary.methods.push("concern");
          snapshot.summary.methods.sort();
        },
      },
      {
        key: "stale-envelope",
        valid: false,
        relayMaxAgeEnv: "Infinity",
        mutate: (snapshot) => {
          snapshot.capturedAt = "2020-01-01T00:00:00.000Z";
        },
      },
      {
        key: "invalid-future-skew-env",
        valid: false,
        futureEnvelope: true,
        futureSkewEnv: "NaN",
      },
      {
        key: "missing-independence-domain",
        valid: false,
        registryPath: childRegistryWithoutDomainPath,
      },
      {
        key: "conflicting-fast-lane-aliases",
        valid: false,
        aliasConflict: true,
        expectedReason: "trusted-relay-snapshot-unavailable",
      },
    ];
    for (const fixture of publisherChildCases) {
      const sourceMatchId = `publisher-child-${fixture.key}`;
      const paths = scenario(tempRoot, fixture.key, [baseCurrentMatch({ sourceMatchId })]);
      const caseDir = path.dirname(paths.dbPath);
      const fastPath = path.join(caseDir, "sporttery-fast-lane.json");
      const fullPath = path.join(caseDir, "missing-full-relay.json");
      const capturedAt = new Date(Date.now() + (fixture.futureEnvelope ? 10 * 60_000 : -1_000)).toISOString();
      const raw = rawFastLaneSnapshot(relaySnapshot({ sourceMatchId, capturedAt }));
      fixture.mutate?.(raw);
      fs.writeFileSync(fastPath, `${JSON.stringify(raw)}\n`, "utf8");
      const conflictingFastPath = path.join(caseDir, "conflicting-fast-lane.json");
      if (fixture.aliasConflict) {
        fs.writeFileSync(conflictingFastPath, `${JSON.stringify(raw)}\n`, "utf8");
      }
      const beforeHash = sha256File(paths.dbPath);
      const child = spawnSync(process.execPath, [
        path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs"),
      ], {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          // This child exercises an isolated SQLite fixture. Production
          // readiness may itself run with PostgreSQL as the live primary;
          // inheriting that mode would redirect the fixture publisher toward
          // the production projection (or fail when its secret URL is
          // intentionally absent from the verifier environment).
          FOOTBALL_POSTGRES_MODE: "disabled",
          SERVER_STORE_DIR: caseDir,
          DATA_STORE_DIR: caseDir,
          DATASTORE_SQLITE_PATH: paths.dbPath,
          SYNC_META_PATH: paths.syncMetaPath,
          RECOMMENDATION_PUBLICATION_LEDGER_PATH: paths.publicationLedgerPath,
          SPORTTERY_RELAY_MODE: "prefer",
          SPORTTERY_RELAY_SNAPSHOT: fullPath,
          SPORTTERY_RELAY_SNAPSHOT_PATH: fullPath,
          SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: fastPath,
          SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH:
            fixture.aliasConflict ? conflictingFastPath : fastPath,
          SPORTTERY_RELAY_MAX_AGE_MINUTES: fixture.relayMaxAgeEnv || "5",
          TRUSTED_MAX_FUTURE_SKEW_SECONDS: fixture.futureSkewEnv || "300",
          SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: fixture.registryPath || childRegistryPath,
          [FAST_RESULT_PUBLISHER_MACHINE_ENV]: "1",
        },
      });
      let result = null;
      try {
        result = parseFastResultPublisherOutput(child.stdout);
      } catch {
        result = null;
      }
      const state = readDbState(paths.dbPath);
      const afterHash = sha256File(paths.dbPath);
      if (fixture.valid) {
        check("real publisher child accepts one trusted collector and publishes atomically", (
          child.status === 0
          && result?.ok === true
          && result?.skipped === false
          && result?.publishedRows === 1
          && result?.verifiedFastEndpoints === 2
          && state.rows.filter((row) => row.dataset === "current").length === 0
          && state.rows.filter((row) => row.dataset === "history").length === 1
          && Boolean(state.meta.fast_result_receipt)
          && beforeHash !== afterHash
        ), { childStatus: child.status, result, stderr: child.stderr.slice(-500) });
      } else {
        check(`real publisher child rejects ${fixture.key} with zero SQLite writes`, (
          child.status === 0
          && result?.ok === true
          && result?.skipped === true
          && result?.reason === (
            fixture.expectedReason || "trusted-fast-result-endpoints-unavailable"
          )
          && result?.publishedRows === 0
          && state.rows.filter((row) => row.dataset === "current").length === 1
          && state.rows.filter((row) => row.dataset === "history").length === 0
          && Object.keys(state.meta).length === 0
          && beforeHash === afterHash
        ), {
          childStatus: child.status,
          reason: result?.reason || null,
          blockers: result?.trustBlockers || [],
          databaseUnchanged: beforeHash === afterHash,
          stderr: child.stderr.slice(-500),
        });
      }
    }

    const payoutSourceMatchId = "publisher-payout-metadata";
    const payoutPaths = scenario(tempRoot, "payout-metadata", [baseCurrentMatch({
      sourceMatchId: payoutSourceMatchId,
    })]);
    const payoutInitial = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:40:00.000Z",
        rowOverrides: { officialPayoutSp: { had: { h: "1.50" } } },
      }),
    });
    const payoutRefresh = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:41:00.000Z",
        rowOverrides: { officialPayoutSp: { had: { h: "1.60" } } },
      }),
    });
    const payoutState = readDbState(payoutPaths.dbPath);
    const payoutHistory = payoutState.rows.find((row) => row.dataset === "history")?.match;
    check("same-score official payout metadata advances the signed SQLite result revision", (
      payoutInitial.publishedRows === 1
      && payoutRefresh.publishedRows === 1
      && payoutRefresh.published?.[0]?.changeType === "official-result-metadata-refresh"
      && payoutHistory?.officialPayoutSp?.had?.h === "1.60"
      && payoutState.meta.fast_result_revision === "2"
    ), {
      changeType: payoutRefresh.published?.[0]?.changeType || null,
      officialPayoutSp: payoutHistory?.officialPayoutSp || null,
      revision: payoutState.meta.fast_result_revision || null,
    });
    const payoutStableHash = sha256File(payoutPaths.dbPath);
    const payoutStableCycle = payoutHistory?.sourceCycleId || null;
    const payoutOlderReplay = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:40:30.000Z",
        rowOverrides: { officialPayoutSp: { had: { h: "1.40" } } },
      }),
    });
    const payoutAfterOlderReplay = readDbState(payoutPaths.dbPath);
    const payoutAfterOlderHistory = payoutAfterOlderReplay.rows
      .find((row) => row.dataset === "history")?.match;
    check("older signed payout replay cannot regress metadata or the SQLite revision", (
      payoutOlderReplay.publishedRows === 0
      && payoutOlderReplay.rejected?.correctionRejected === 1
      && payoutAfterOlderHistory?.officialPayoutSp?.had?.h === "1.60"
      && payoutAfterOlderHistory?.sourceCycleId === payoutStableCycle
      && payoutAfterOlderReplay.meta.fast_result_revision === "2"
      && sha256File(payoutPaths.dbPath) === payoutStableHash
    ), {
      reason: payoutOlderReplay.reason || null,
      correctionRejected: payoutOlderReplay.rejected?.correctionRejected ?? null,
      officialPayoutSp: payoutAfterOlderHistory?.officialPayoutSp || null,
      sourceCycleId: payoutAfterOlderHistory?.sourceCycleId || null,
      revision: payoutAfterOlderReplay.meta.fast_result_revision || null,
    });
    const payoutSameCycleReplay = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:42:00.000Z",
        sourceCycleId: String(payoutStableCycle || "").replace(/:result$/, ""),
        rowOverrides: { officialPayoutSp: { had: { h: "1.70" } } },
      }),
    });
    const payoutAfterSameCycle = readDbState(payoutPaths.dbPath);
    const payoutAfterSameCycleHistory = payoutAfterSameCycle.rows
      .find((row) => row.dataset === "history")?.match;
    check("newer clock with a replayed result cycle cannot replace payout metadata", (
      payoutSameCycleReplay.publishedRows === 0
      && payoutSameCycleReplay.rejected?.correctionRejected === 1
      && payoutAfterSameCycleHistory?.officialPayoutSp?.had?.h === "1.60"
      && payoutAfterSameCycleHistory?.sourceCycleId === payoutStableCycle
      && payoutAfterSameCycle.meta.fast_result_revision === "2"
      && sha256File(payoutPaths.dbPath) === payoutStableHash
    ), {
      reason: payoutSameCycleReplay.reason || null,
      correctionRejected: payoutSameCycleReplay.rejected?.correctionRejected ?? null,
      officialPayoutSp: payoutAfterSameCycleHistory?.officialPayoutSp || null,
      sourceCycleId: payoutAfterSameCycleHistory?.sourceCycleId || null,
      revision: payoutAfterSameCycle.meta.fast_result_revision || null,
    });
    const payoutMissingNewer = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:43:00.000Z",
        rowOverrides: { officialPayoutSp: { had: { h: null } } },
      }),
    });
    const payoutAfterMissing = readDbState(payoutPaths.dbPath);
    const payoutAfterMissingHistory = payoutAfterMissing.rows
      .find((row) => row.dataset === "history")?.match;
    check("newer signed result with missing payout preserves the last official payout", (
      payoutMissingNewer.publishedRows === 0
      && payoutMissingNewer.authorityHighWaterUpdated === true
      && payoutAfterMissingHistory?.officialPayoutSp?.had?.h === "1.60"
      && payoutAfterMissingHistory?.sourceCycleId === payoutStableCycle
      && payoutAfterMissing.meta.fast_result_revision === "2"
    ), {
      reason: payoutMissingNewer.reason || null,
      officialPayoutSp: payoutAfterMissingHistory?.officialPayoutSp || null,
      sourceCycleId: payoutAfterMissingHistory?.sourceCycleId || null,
      revision: payoutAfterMissing.meta.fast_result_revision || null,
    });
    const legacyAuthorityDb = new DatabaseSync(payoutPaths.dbPath);
    const legacyAuthorityRow = legacyAuthorityDb.prepare(`
      SELECT id, payload FROM match_snapshots WHERE dataset = 'history' LIMIT 1
    `).get();
    const legacyAuthorityMatch = JSON.parse(legacyAuthorityRow.payload);
    delete legacyAuthorityMatch.resultAuthorityObservedAt;
    legacyAuthorityMatch.postMatchReview.generatedAt = "2026-07-13T02:41:00.000Z";
    legacyAuthorityMatch.postMatchReview.settlement.reviewGeneratedAt
      = "2026-07-13T02:41:00.000Z";
    legacyAuthorityMatch.postMatchReview.settlement.sourceCycleId = payoutStableCycle;
    legacyAuthorityDb.prepare(
      "UPDATE match_snapshots SET payload = ? WHERE id = ?"
    ).run(JSON.stringify(legacyAuthorityMatch), legacyAuthorityRow.id);
    legacyAuthorityDb.close();
    const legacyAuthorityHash = sha256File(payoutPaths.dbPath);
    const legacyAuthorityReplay = publishOfficialResultsFast({
      ...payoutPaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: payoutSourceMatchId,
        capturedAt: "2026-07-13T02:40:30.000Z",
        rowOverrides: { officialPayoutSp: { had: { h: "1.30" } } },
      }),
    });
    const legacyAuthorityState = readDbState(payoutPaths.dbPath);
    const legacyAuthorityHistory = legacyAuthorityState.rows
      .find((row) => row.dataset === "history")?.match;
    check("legacy metadata revision clock rejects an intermediate replay before authority-clock migration", (
      legacyAuthorityReplay.publishedRows === 0
      && legacyAuthorityReplay.rejected?.correctionRejected === 1
      && legacyAuthorityHistory?.resultAuthorityObservedAt === undefined
      && legacyAuthorityHistory?.officialPayoutSp?.had?.h === "1.60"
      && legacyAuthorityHistory?.sourceCycleId === payoutStableCycle
      && legacyAuthorityState.meta.fast_result_revision === "2"
      && sha256File(payoutPaths.dbPath) === legacyAuthorityHash
    ), {
      reason: legacyAuthorityReplay.reason || null,
      correctionRejected: legacyAuthorityReplay.rejected?.correctionRejected ?? null,
      officialPayoutSp: legacyAuthorityHistory?.officialPayoutSp || null,
      sourceCycleId: legacyAuthorityHistory?.sourceCycleId || null,
      revision: legacyAuthorityState.meta.fast_result_revision || null,
    });

    const teamCodeSourceMatchId = "publisher-team-code-alias";
    const directCodeRow = matchesFromSportteryRelaySnapshot(relaySnapshot({
      sourceMatchId: teamCodeSourceMatchId,
      capturedAt: "2026-07-13T02:42:00.000Z",
      rowOverrides: {
        homeTeamAllName: "Direct home name",
        awayTeamAllName: "Direct away name",
        homeTeamCode: "HOME-CODE",
        awayTeamCode: "AWAY-CODE",
      },
    })).find((row) => row.sourceMethod === "relay:result");
    const abbCodeRow = matchesFromSportteryRelaySnapshot(relaySnapshot({
      sourceMatchId: teamCodeSourceMatchId,
      capturedAt: "2026-07-13T02:42:00.000Z",
      rowOverrides: {
        homeTeamAllName: "Renamed home",
        awayTeamAllName: "Renamed away",
        homeTeamAbbEnName: "HOME-CODE",
        awayTeamAbbEnName: "AWAY-CODE",
      },
    })).find((row) => row.sourceMethod === "relay:result");
    check("all four team-code aliases normalize to stable same-event identity", (
      directCodeRow?.homeTeamCode === "HOME-CODE"
      && directCodeRow?.awayTeamCode === "AWAY-CODE"
      && abbCodeRow?.homeTeamCode === "HOME-CODE"
      && abbCodeRow?.awayTeamCode === "AWAY-CODE"
      && sameEvent(directCodeRow, abbCodeRow)
    ), {
      direct: {
        home: directCodeRow?.homeTeamCode || null,
        away: directCodeRow?.awayTeamCode || null,
      },
      abb: {
        home: abbCodeRow?.homeTeamCode || null,
        away: abbCodeRow?.awayTeamCode || null,
      },
    });

    const explicitTerminalSnapshot = relaySnapshot({
      sourceMatchId: "publisher-explicit-terminal-stability",
      capturedAt: "2026-07-13T02:05:00.000Z",
      rowOverrides: {
        matchStatus: "0",
        matchStatusName: "Selling",
        matchResultStatus: "2",
        poolStatus: "Payout",
      },
    });
    const explicitTerminalEndpoint = explicitTerminalSnapshot.entries
      .find((entry) => entry.method === "result");
    const explicitTerminalRaw = explicitTerminalEndpoint.payload.value
      .matchInfoList[0].subMatchList[0];
    const earlyNow = Date.parse("2026-07-13T02:10:00.000Z");
    const lateNow = Date.parse("2026-07-13T04:10:00.000Z");
    const originalDateNow = Date.now;
    let earlyNormalized = null;
    let lateNormalized = null;
    let earlyObservation = null;
    let lateObservation = null;
    try {
      Date.now = () => earlyNow;
      earlyObservation = sportteryResultObservation(explicitTerminalRaw);
      earlyNormalized = matchesFromSportteryRelaySnapshot(explicitTerminalSnapshot)
        .find((row) => row.sourceMethod === "relay:result");
      Date.now = () => lateNow;
      lateObservation = sportteryResultObservation(explicitTerminalRaw);
      lateNormalized = matchesFromSportteryRelaySnapshot(explicitTerminalSnapshot)
        .find((row) => row.sourceMethod === "relay:result");
    } finally {
      Date.now = originalDateNow;
    }
    check("explicit result and payout status normalize to FINISHED without the 125-minute clock", (
      statusFromSportteryRow(explicitTerminalRaw, earlyNormalized?.kickoffTime, earlyNow) === "FINISHED"
      && statusFromSportteryRow(explicitTerminalRaw, lateNormalized?.kickoffTime, lateNow) === "FINISHED"
      && earlyNormalized?.status === "FINISHED"
      && lateNormalized?.status === "FINISHED"
      && JSON.stringify(earlyNormalized) === JSON.stringify(lateNormalized)
      && JSON.stringify(earlyObservation) === JSON.stringify(lateObservation)
    ), {
      earlyStatus: earlyNormalized?.status || null,
      lateStatus: lateNormalized?.status || null,
    });

    const authorityHeadId = "publisher-result-head-only";
    const companionTerminalId = "publisher-companion-terminal";
    const archiveTerminalId = "publisher-full-archive-terminal";
    const authorityCapturedAt = new Date(Date.now() - 1_000).toISOString();
    const authorityHead = relaySnapshot({
      sourceMatchId: authorityHeadId,
      capturedAt: authorityCapturedAt,
    });
    const authoritySnapshot = signedFastSnapshot({
      capturedAt: authorityCapturedAt,
      sourceCycleId: "publisher-selected-result-authority",
      resultPayload: authorityHead.entries.find((entry) => entry.method === "result").payload,
      currentPayload: relaySnapshot({
        sourceMatchId: companionTerminalId,
        capturedAt: authorityCapturedAt,
      }).entries.find((entry) => entry.method === "result").payload,
    });
    // Simulate the runtime overlay's mutable envelope cycle and a full archive
    // result page. Neither may enter the verified result:1 publication set.
    authoritySnapshot.payload.sourceCycleId = "runtime-overlay-cycle-must-not-win";
    authoritySnapshot.entries.push({
      id: "method:result:2",
      method: "result",
      page: 2,
      url: SPORTTERY_RESULT_URL,
      ok: true,
      fetchedAt: authorityCapturedAt,
      receivedAt: authorityCapturedAt,
      sourceCycleId: "full-archive-cycle-must-not-win",
      payload: relaySnapshot({
        sourceMatchId: archiveTerminalId,
        capturedAt: authorityCapturedAt,
      }).entries.find((entry) => entry.method === "result").payload,
    });
    const authorityPaths = scenario(tempRoot, "selected-result-authority", [
      baseCurrentMatch({ sourceMatchId: authorityHeadId }),
      baseCurrentMatch({ sourceMatchId: companionTerminalId }),
      baseCurrentMatch({ sourceMatchId: archiveTerminalId }),
    ]);
    const authorityPublication = publishOfficialResultsFast({
      ...authorityPaths,
      relaySnapshot: authoritySnapshot,
    });
    const authorityState = readDbState(authorityPaths.dbPath);
    check("publisher consumes only verified result:1 and ignores companion/full-overlay terminal rows", (
      authorityPublication.publishedRows === 1
      && authorityPublication.scannedRows === 1
      && authorityPublication.sourceCycleId === "publisher-selected-result-authority:result"
      && authorityState.rows.filter((row) => row.dataset === "history").length === 1
      && authorityState.rows.find((row) => row.dataset === "history")?.match?.sourceMatchId
        === authorityHeadId
      && authorityState.rows.filter((row) => row.dataset === "current").length === 2
      && authorityState.rows.some((row) => (
        row.dataset === "current" && row.match.sourceMatchId === companionTerminalId
      ))
      && authorityState.rows.some((row) => (
        row.dataset === "current" && row.match.sourceMatchId === archiveTerminalId
      ))
    ), {
      sourceCycleId: authorityPublication.sourceCycleId,
      scannedRows: authorityPublication.scannedRows,
      datasets: authorityState.rows.map((row) => `${row.dataset}:${row.match.sourceMatchId}`),
    });

    const toctouTrustedId = "publisher-toctou-trusted";
    const toctouSwapId = "publisher-toctou-swap";
    const toctouTrusted = relaySnapshot({
      sourceMatchId: toctouTrustedId,
      capturedAt: authorityCapturedAt,
    });
    const toctouSwap = relaySnapshot({
      sourceMatchId: toctouSwapId,
      capturedAt: authorityCapturedAt,
    });
    let toctouEntryReads = 0;
    const toctouSnapshot = {
      payload: toctouTrusted.payload,
      summary: toctouTrusted.summary,
    };
    Object.defineProperty(toctouSnapshot, "entries", {
      enumerable: true,
      get() {
        toctouEntryReads += 1;
        return toctouEntryReads === 1 ? toctouTrusted.entries : toctouSwap.entries;
      },
    });
    const toctouPaths = scenario(tempRoot, "toctou-snapshot", [
      baseCurrentMatch({ sourceMatchId: toctouTrustedId }),
      baseCurrentMatch({ sourceMatchId: toctouSwapId }),
    ]);
    const toctouPublication = publishOfficialResultsFast({
      ...toctouPaths,
      relaySnapshot: toctouSnapshot,
    });
    const toctouState = readDbState(toctouPaths.dbPath);
    check("publisher audits and consumes one captured in-memory snapshot without a TOCTOU reread", (
      toctouEntryReads === 1
      && toctouPublication.publishedRows === 1
      && toctouState.rows.find((row) => row.dataset === "history")?.match?.sourceMatchId
        === toctouTrustedId
      && toctouState.rows.some((row) => (
        row.dataset === "current" && row.match.sourceMatchId === toctouSwapId
      ))
    ), {
      entryReads: toctouEntryReads,
      datasets: toctouState.rows.map((row) => `${row.dataset}:${row.match.sourceMatchId}`),
    });

    const inferredTerminalId = "publisher-clock-inferred-terminal";
    const inferredPaths = scenario(tempRoot, "clock-inferred-terminal", [baseCurrentMatch({
      sourceMatchId: inferredTerminalId,
    })]);
    const inferredSnapshot = relaySnapshot({
      sourceMatchId: inferredTerminalId,
      capturedAt: authorityCapturedAt,
      rowOverrides: {
        matchStatus: "0",
        matchStatusName: "Selling",
      },
    });
    const inferredBefore = sha256File(inferredPaths.dbPath);
    const inferredPublication = publishOfficialResultsFast({
      ...inferredPaths,
      relaySnapshot: inferredSnapshot,
    });
    const inferredState = readDbState(inferredPaths.dbPath);
    check("elapsed local time plus a score cannot promote a non-terminal official status", (
      inferredPublication.skipped === true
      && inferredPublication.reason === "no-explicit-official-terminal-results"
      && inferredPublication.publishedRows === 0
      && inferredState.rows.filter((row) => row.dataset === "current").length === 1
      && inferredState.rows.filter((row) => row.dataset === "history").length === 0
      && sha256File(inferredPaths.dbPath) === inferredBefore
    ), { reason: inferredPublication.reason });

    const immediateTerminalId = "publisher-explicit-terminal-immediate";
    const immediateObservedMs = Math.floor((Date.now() - 1_000) / 1000) * 1000;
    const immediateKickoffMs = immediateObservedMs - 10 * 60_000;
    const immediateKickoff = new Date(immediateKickoffMs).toISOString();
    const immediateBeijing = new Date(immediateKickoffMs + 8 * 60 * 60_000).toISOString();
    const immediatePaths = scenario(tempRoot, "explicit-terminal-immediate", [baseCurrentMatch({
      sourceMatchId: immediateTerminalId,
      kickoffTime: immediateKickoff,
    })]);
    const immediatePublication = publishOfficialResultsFast({
      ...immediatePaths,
      relaySnapshot: relaySnapshot({
        sourceMatchId: immediateTerminalId,
        matchDate: immediateBeijing.slice(0, 10),
        matchTime: immediateBeijing.slice(11, 19),
        capturedAt: new Date(immediateObservedMs).toISOString(),
        rowOverrides: {
          matchStatus: "0",
          matchStatusName: "Selling",
          matchResultStatus: "2",
          poolStatus: "Payout",
        },
      }),
    });
    const immediateState = readDbState(immediatePaths.dbPath);
    check("publisher settles an explicitly terminal signed result before 125 elapsed minutes", (
      immediatePublication.publishedRows === 1
      && immediatePublication.skipped === false
      && immediateState.rows.filter((row) => row.dataset === "current").length === 0
      && immediateState.rows.filter((row) => row.dataset === "history").length === 1
      && immediateState.rows.find((row) => row.dataset === "history")?.match?.status === "FINISHED"
    ), {
      publishedRows: immediatePublication.publishedRows,
      reason: immediatePublication.reason || null,
    });

    const replayPaths = scenario(tempRoot, "replay", [baseCurrentMatch({
      sourceMatchId: "fast-3001",
      kickoffTime: "2026-07-14T10:00:00+08:00",
    })]);
    const replay = publishOfficialResultsFast({
      ...replayPaths,
      relaySnapshot: relaySnapshot({ sourceMatchId: "fast-3001" }),
      observedAt,
    });
    const replayState = readDbState(replayPaths.dbPath);
    check("same source id with a different event revision is rejected", (
      replay.skipped === true
      && replay.rejected?.eventMismatch === 1
      && replayState.rows.filter((row) => row.dataset === "current").length === 1
      && replayState.rows.filter((row) => row.dataset === "history").length === 0
    ), { reason: replay.reason, eventMismatch: replay.rejected?.eventMismatch });

    const missingDb = publishOfficialResultsFast({
      dbPath: path.join(tempRoot, "missing", "football.db"),
      syncMetaPath: path.join(tempRoot, "missing", "sync-meta.json"),
      publicationLedgerPath: path.join(tempRoot, "missing", "ledger.json"),
      relaySnapshot: relaySnapshot(),
    });
    check("missing database is a safe skip", (
      missingDb.ok === true && missingDb.skipped === true && missingDb.reason === "sqlite-database-missing"
    ), { reason: missingDb.reason });

    const crashPaths = scenario(tempRoot, "meta-crash", [baseCurrentMatch({ sourceMatchId: "fast-4001" })]);
    const blockedMetaPath = path.join(path.dirname(crashPaths.syncMetaPath), "blocked-meta-target");
    fs.mkdirSync(blockedMetaPath);
    let injectedMetaFailure = null;
    try {
      publishOfficialResultsFast({
        ...crashPaths,
        syncMetaPath: blockedMetaPath,
        relaySnapshot: relaySnapshot({ sourceMatchId: "fast-4001" }),
        observedAt,
      });
    } catch (error) {
      injectedMetaFailure = error;
    }
    const recoveredAfterCrash = publishOfficialResultsFast({
      ...crashPaths,
      relaySnapshot: relaySnapshot({ sourceMatchId: "fast-4001" }),
      observedAt: "2026-07-13T02:30:00.000Z",
    });
    const crashState = readDbState(crashPaths.dbPath);
    const crashMeta = JSON.parse(fs.readFileSync(crashPaths.syncMetaPath, "utf8"));
    check("post-commit sync-meta failure self-heals from the SQLite receipt", (
      Boolean(injectedMetaFailure)
      && recoveredAfterCrash.visibleStateChanged === true
      && recoveredAfterCrash.publishedRows === 0
      && crashState.rows.filter((row) => row.dataset === "history").length === 1
      && crashState.meta.fast_result_revision === "1"
      && crashMeta.fastResultRevision === 1
      && crashMeta.fastResultObservations?.rows?.length === 1
    ), {
      recoveredReason: recoveredAfterCrash.reason || null,
      revision: crashMeta.fastResultRevision,
    });

    // Exercise the facade used by full sync against the committed crash fixture.
    // Keep this legacy-storage test independent of the candidate's runtime mode.
    const facadeChild = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const { readRuntimeFastResultInput } = require('./scripts/runtimeFastResultInput.cjs');
      const { readSqliteFastResultReceipt } = require('./server/sqliteStore.cjs');
      (async () => {
        const sqlitePath = process.argv[1];
        const full = await readRuntimeFastResultInput({ sqlitePath });
        const receipt = await readSqliteFastResultReceipt(sqlitePath);
        assert.equal(full.storage, 'sqlite'); assert.deepEqual(full.receipt, receipt);
        assert.equal(full.finals.length, 1); assert.equal(full.finals[0].sourceMatchId, 'fast-4001');
        const only = await readRuntimeFastResultInput({ sqlitePath, receiptOnly: true });
        assert.deepEqual(only.receipt, receipt); assert.deepEqual(only.finals, []);
        process.stdout.write(JSON.stringify({ ok: true }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, crashPaths.dbPath], { cwd: rootDir, env: { ...process.env, FOOTBALL_STORAGE_MODE: "hybrid" },
      encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    check("runtime fast input facade preserves committed receipt and receipt-only isolation", facadeChild.status === 0,
      { status: facadeChild.status, stderr: facadeChild.status === 0 ? "" : facadeChild.stderr });

    const workerSource = fs
      .readFileSync(path.join(rootDir, "scripts", "runSyncWorker.cjs"), "utf8")
      .replace(/\r\n?/g, "\n");
    const fastIndex = workerSource.indexOf('"publish:official-results-fast"');
    const fullIndex = workerSource.indexOf('runCommand("node", ["scripts/syncData.cjs"]');
    check("worker runs non-fatal fast publication before the full official sync", (
      fastIndex >= 0
      && fullIndex > fastIndex
      && workerSource.includes('runBestEffort(\n      "publish:official-results-fast"')
    ), { fastIndex, fullIndex });
    check("worker emits fast event only for published rows and full event remains final", (
      workerSource.includes('Number(fastResultStep?.publishedRows || 0) > 0')
      && workerSource.includes('fastResultStep?.visibleStateChanged === true')
      && workerSource.includes('if (fastPhase) await onFastPublished(fastPhase);')
      && workerSource.includes('phase: "official-result-fast-published"')
      && workerSource.includes('phase: "official-result-published"')
      && workerSource.includes('officialPhaseFinishedAt = new Date(Date.parse(fastPhase.finishedAt) + 1).toISOString()')
      && workerSource.indexOf('await onOfficialPublished(officialPhase);') > workerSource.indexOf('await onFastPublished(fastPhase)')
    ));
    check("fast success cannot relabel a later full-sync failure as enrichment failure", (
      workerSource.includes('let fastPublishedThisCycle = false;')
      && workerSource.includes('let fullOfficialPublishedThisCycle = false;')
      && workerSource.includes('phase: fullOfficialPublishedThisCycle ? "slow-enrichment-failed" : "official-result-failed"')
      && workerSource.includes('eventCycle: fullOfficialPublishedThisCycle ? activeEventCycle : failedCycle')
    ));
    const syncDataSource = fs.readFileSync(path.join(rootDir, "scripts", "syncData.cjs"), "utf8");
    check("full sync applies and republishes the fast observation ledger", (
      syncDataSource.indexOf("applyFastResultObservation(match, fastResultObservations)")
        < syncDataSource.indexOf("output = output.map(settleTrustedPublishedPredictions)")
      && syncDataSource.indexOf("output = output.map(settleTrustedPublishedPredictions)")
        < syncDataSource.indexOf("const postMatchReviews = attachPostMatchReviews(")
      && syncDataSource.includes("overlayFastObservedFinals(output, sqliteFastFinals, fastResultObservations)")
      && syncDataSource.includes("fastResultObservations,")
      && syncDataSource.includes("const { receipt: sqliteFastReceipt, finals: sqliteFastFinals } = await readRuntimeFastResultInput({")
      && syncDataSource.includes("sqliteFastReceipt?.observations || []")
      && syncDataSource.includes("fastResultPublication,")
      && syncDataSource.includes("const { receipt: latestFastReceipt } = await readRuntimeFastResultInput({")
      && syncDataSource.includes("latestFastReceipt.observations || []")
    ));
    const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
    const publicSyncMetaSource = serverSource.slice(
      serverSource.indexOf("const buildPublicSyncMeta = async () =>"),
      serverSource.indexOf("const matchDetailSourceHealth =")
    );
    const dataVersionSource = serverSource.slice(
      serverSource.indexOf("const syncMetaDataVersionTime ="),
      serverSource.indexOf("const syncMetaFreshness =")
    );
    check("full sync and public API keep freshness clocks monotonic across relay, sync-meta, and SQLite receipt", (
      syncDataSource.includes("const finalResultFreshnessTime = latestTrustedIsoTime(")
      && syncDataSource.includes("latestFastReceipt?.publishedAt")
      && publicSyncMetaSource.includes("readPublicationFastResultReceiptState(basePublication)")
      && serverSource.includes("const readPublicationFastResultReceiptState = async (publication) =>")
      && serverSource.includes("publicationIdentity: identity,")
      && publicSyncMetaSource.includes("const fastResultFreshnessTime = latestIsoTime(")
      && publicSyncMetaSource.includes("const resultFreshnessTime = latestIsoTime(")
      && publicSyncMetaSource.includes("fastResultRevision: Math.max(metaFastRevision, receiptFastRevision)")
      && !dataVersionSource.includes("meta?.lastAttemptAt")
      && !serverSource.includes('resultFreshnessTime: relayResultFreshnessTime || syncMetaFreshness(meta, "result")')
      && !serverSource.includes('historyFreshnessTime: relayHistoryFreshnessTime || syncMetaFreshness(meta, "history")')
    ));
    const fastPublisherSource = fs.readFileSync(
      path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs"),
      "utf8"
    );
    const syncMetaLockSource = fs.readFileSync(
      path.join(rootDir, "scripts", "syncMetaCommitLock.cjs"),
      "utf8"
    );
    check("full and fast sync-meta writers share a re-read-under-lock commit boundary", (
      syncDataSource.includes("const syncMetaCommitLock = acquireSyncMetaCommitLock(")
      && syncDataSource.indexOf("const syncMetaCommitLock = acquireSyncMetaCommitLock(")
        < syncDataSource.indexOf("const { receipt: latestFastReceipt } = await readRuntimeFastResultInput({")
      && syncDataSource.slice(syncDataSource.indexOf("const { receipt: latestFastReceipt } = await readRuntimeFastResultInput({"),
        syncDataSource.indexOf("const { receipt: latestFastReceipt } = await readRuntimeFastResultInput({") + 240).includes("receiptOnly: true")
      && syncDataSource.includes("latestDiskSyncMeta = JSON.parse(fs.readFileSync(syncMetaCommitPath")
      && syncDataSource.includes("syncMetaCommitLock.release()")
      && fastPublisherSource.includes("const commitLock = acquireSyncMetaCommitLock({ filePath });")
      && fastPublisherSource.indexOf("const commitLock = acquireSyncMetaCommitLock({ filePath });")
        < fastPublisherSource.indexOf("const existing = readSyncMeta(filePath);")
      && fastPublisherSource.includes("commitLock.release()")
      && syncMetaLockSource.includes("SYNC_META_COMMIT_LOCK_TIMEOUT")
    ));

    const failed = checks.filter((item) => !item.ok);
    process.stdout.write(`${JSON.stringify({
      ok: failed.length === 0,
      checkedAt: new Date().toISOString(),
      summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
      checks,
    }, null, 2)}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
