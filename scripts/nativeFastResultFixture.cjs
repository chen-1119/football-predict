"use strict";
// Signed synthetic fixture shared with native-storage tests; no live credentials.
const { createCollectorKeyPair, buildCollectorCommitment, signCollectorCommitment } = require("../src/services/collectorAttestation.cjs");
const { SPORTTERY_CURRENT_URL, SPORTTERY_RESULT_URL } = require("./sportteryEndpointContract.cjs");
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


module.exports = { publisherCollector, baseCurrentMatch, relaySnapshot };
