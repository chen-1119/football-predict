"use strict";

const { createHash } = require("node:crypto");
const { strictInstant } = require("./strictInstant.cjs");
const VERSION = "joint-goal-fit-v1";
const EVIDENCE_VERSION = "observed-xg-over25-history-v1";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const key = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const clock = value => strictInstant(value) ? Date.parse(value) : NaN;
const finite = value => typeof value === "number" && Number.isFinite(value);
const goal = value => Number.isInteger(value) && value >= 0 && value <= 20;
const xg = value => finite(value) && value >= 0 && value <= 8;
const over = total => 1 - Math.exp(-total) * (1 + total + total * total / 2);

function historyRow(match) {
  const stats = match?.stats;
  const statsSource = stats?.source || stats?.provenance?.source || null;
  const observedStats = stats?.observed === true || stats?.provenance?.observed === true
    || ["observed", "official-post-match", "provider-post-match"].includes(stats?.sourceType || stats?.provenance?.sourceType);
  const resultEligible = match?.resultObservationFallback !== true
    && match?.resultProvenance?.promotionEligible !== false
    && !/^500\.com/i.test(String(match?.resultSource || ""));
  return {
    sourceMatchId: String(match?.sourceMatchId || ""), kickoffTime: match?.kickoffTime,
    homeTeam: match?.homeTeamName || match?.homeTeam, awayTeam: match?.awayTeamName || match?.awayTeam,
    scoreHome: match?.scoreHome, scoreAway: match?.scoreAway,
    resultObservedAt: resultEligible ? match?.resultObservedAt : null,
    resultSource: resultEligible ? (match?.resultObservationSource || match?.resultProvenance?.source || null) : null,
    homeXg: observedStats && !/^api-football/i.test(String(statsSource || "")) ? stats?.xG?.home : null,
    awayXg: observedStats && !/^api-football/i.test(String(statsSource || "")) ? stats?.xG?.away : null,
    statsObservedAt: observedStats ? (stats?.observedAt || stats?.provenance?.observedAt) : null,
    statsSource: observedStats ? statsSource : null,
  };
}

function buildObservedGoalHistoryIndex(history) {
  const index = new Map();
  for (const match of history || []) {
    if (match?.status !== "FINISHED") continue;
    const row = historyRow(match);
    for (const team of new Set([key(row.homeTeam), key(row.awayTeam)].filter(Boolean))) {
      if (!index.has(team)) index.set(team, []);
      index.get(team).push(row);
    }
  }
  for (const [team, rows] of index) {
    rows.sort((a, b) => clock(b.kickoffTime) - clock(a.kickoffTime));
    index.set(team, rows.slice(0, 32));
  }
  return index;
}

function observedRows(rows, match, asOf) {
  const cutoff = Math.min(clock(asOf), clock(match?.kickoffTime), clock(match?.buyEndTime) || Infinity);
  const home = key(match?.homeTeamName || match?.homeTeam);
  const away = key(match?.awayTeamName || match?.awayTeam);
  if (!Number.isFinite(cutoff) || !home || !away || home === away || !Array.isArray(rows) || rows.length > 32) return null;
  const selected = { home: [], away: [] };
  const seen = new Set();
  for (const row of rows) {
    const kickoff = clock(row?.kickoffTime), resultAt = clock(row?.resultObservedAt), statsAt = clock(row?.statsObservedAt);
    const resultValid = goal(row?.scoreHome) && goal(row?.scoreAway) && !!row?.resultSource
      && Number.isFinite(resultAt) && resultAt >= kickoff && resultAt <= cutoff;
    const statsValid = xg(row?.homeXg) && xg(row?.awayXg) && !!row?.statsSource
      && Number.isFinite(statsAt) && statsAt >= kickoff && statsAt <= cutoff;
    if (!row?.sourceMatchId || !Number.isFinite(kickoff) || kickoff >= cutoff || !resultValid) continue;
    const identity = `${row.sourceMatchId}|${row.kickoffTime}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    if (identity === `${match.sourceMatchId}|${match.kickoffTime}`) continue;
    for (const [side, team] of [["home", home], ["away", away]]) {
      const isHome = key(row.homeTeam) === team;
      const isAway = key(row.awayTeam) === team;
      if (isHome === isAway) continue;
      selected[side].push({ kickoff, resultAt, statsAt: statsValid ? statsAt : null,
        over25: row.scoreHome + row.scoreAway > 2 ? 1 : 0,
        forXg: statsValid ? (isHome ? row.homeXg : row.awayXg) : null,
        againstXg: statsValid ? (isHome ? row.awayXg : row.homeXg) : null });
    }
  }
  const summaries = {};
  for (const side of ["home", "away"]) {
    const recent = selected[side].sort((a, b) => b.kickoff - a.kickoff).slice(0, 12);
    const withXg = recent.filter(row => row.statsAt !== null);
    if (recent.length < 8 || withXg.length < 5) return null;
    summaries[side] = {
      results: recent.length, xg: withXg.length,
      over25Rate: recent.reduce((n, row) => n + row.over25, 0) / recent.length,
      xgFor: withXg.reduce((n, row) => n + row.forXg, 0) / withXg.length,
      xgAgainst: withXg.reduce((n, row) => n + row.againstXg, 0) / withXg.length,
      latestObservedAt: new Date(Math.max(...recent.map(row => row.resultAt), ...withXg.map(row => row.statsAt))).toISOString(),
    };
  }
  return summaries;
}

function buildGoalFitEvidence(history, match, asOf) {
  if (!(history instanceof Map) && !Array.isArray(history) || !strictInstant(asOf) || !strictInstant(match?.kickoffTime)) return null;
  const home = key(match.homeTeamName || match.homeTeam), away = key(match.awayTeamName || match.awayTeam);
  if (!home || !away || home === away) return null;
  const indexed = history instanceof Map ? history : buildObservedGoalHistoryIndex(history);
  const cutoff = Math.min(clock(asOf), clock(match.kickoffTime), clock(match.buyEndTime) || Infinity);
  const recent = team => (indexed.get(team) || []).filter(row => clock(row.kickoffTime) < cutoff
    && clock(row.resultObservedAt) <= cutoff).slice(0, 12);
  const rows = [...new Map([...recent(home), ...recent(away)]
    .map(row => [`${row.sourceMatchId}|${row.kickoffTime}`, row])).values()]
    .sort((a, b) => clock(b.kickoffTime) - clock(a.kickoffTime));
  const sample = observedRows(rows, match, asOf);
  if (!sample) return null;
  const body = { version: EVIDENCE_VERSION, sourceMatchId: String(match.sourceMatchId || ""), kickoffTime: match.kickoffTime,
    homeTeam: match.homeTeamName || match.homeTeam, awayTeam: match.awayTeamName || match.awayTeam,
    asOf, rows, sample };
  return { ...body, contentHash: digest(body) };
}

function verifiedEvidence(match, at) {
  const evidence = match?.externalSignals?.goalFitEvidence;
  if (!evidence || evidence.version !== EVIDENCE_VERSION || !strictInstant(at)
    || evidence.sourceMatchId !== String(match.sourceMatchId || "")
    || evidence.kickoffTime !== match.kickoffTime
    || key(evidence.homeTeam) !== key(match.homeTeamName || match.homeTeam)
    || key(evidence.awayTeam) !== key(match.awayTeamName || match.awayTeam)
    || !strictInstant(evidence.asOf) || clock(evidence.asOf) > clock(at)
    || !Array.isArray(evidence.rows) || evidence.rows.length > 32) return null;
  const { contentHash, ...body } = evidence;
  if (digest(body) !== contentHash) return null;
  const sample = observedRows(evidence.rows, match, evidence.asOf);
  return sample && JSON.stringify(sample) === JSON.stringify(evidence.sample) ? { evidence, sample } : null;
}

function totalForOver25(probability) {
  let low = 0.3, high = 8;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (over(middle) < probability) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

function fitJointGoalRates(match, homeLambda, awayLambda, at) {
  const validated = verifiedEvidence(match, at);
  if (!validated || !finite(homeLambda) || !finite(awayLambda) || homeLambda <= 0 || awayLambda <= 0) return null;
  const { home, away } = validated.sample, beforeTotal = homeLambda + awayLambda;
  const homeXg = (home.xgFor + away.xgAgainst) / 2;
  const awayXg = (away.xgFor + home.xgAgainst) / 2;
  const xgTotal = homeXg + awayXg, over25Rate = (home.over25Rate + away.over25Rate) / 2;
  if (xgTotal < 0.5 || xgTotal > 7 || over25Rate <= 0.05 || over25Rate >= 0.95) return null;
  const xgWeight = 0.18, over25Weight = 0.22, shareWeight = 0.28;
  const historicalTotal = totalForOver25(over25Rate);
  const weightedTotal = beforeTotal * (1 - xgWeight - over25Weight) + xgTotal * xgWeight + historicalTotal * over25Weight;
  const total = clamp(weightedTotal, Math.max(0.4, beforeTotal - 0.35), beforeTotal + 0.35);
  const beforeShare = homeLambda / beforeTotal;
  const share = clamp(beforeShare * (1 - shareWeight) + homeXg / xgTotal * shareWeight,
    Math.max(0.05, beforeShare - 0.08), Math.min(0.95, beforeShare + 0.08));
  const fittedHome = clamp(total * share, 0.2, 12), fittedAway = clamp(total * (1 - share), 0.2, 12);
  const result = { version: VERSION, evidenceHash: validated.evidence.contentHash,
    sourceMatchId: String(match.sourceMatchId), kickoffTime: match.kickoffTime, evidenceAsOf: validated.evidence.asOf,
    before: { home: homeLambda, away: awayLambda },
    inputs: { homeXg, awayXg, over25Rate, xgTotal, historicalTotal,
      samples: { home: { results: home.results, xg: home.xg }, away: { results: away.results, xg: away.xg } } },
    weights: { xgTotal: xgWeight, over25Total: over25Weight, xgShare: shareWeight },
    output: { home: fittedHome, away: fittedAway },
    over25Probability: over(fittedHome + fittedAway),
    bttsProbability: (1 - Math.exp(-fittedHome)) * (1 - Math.exp(-fittedAway)),
  };
  return { ...result, contentHash: digest(result) };
}

function verifyJointGoalFit(fit, match, at) {
  if (!fit || fit.version !== VERSION || fit.sourceMatchId !== String(match?.sourceMatchId || "")
    || fit.kickoffTime !== match?.kickoffTime) return false;
  const { contentHash, ...body } = fit;
  if (digest(body) !== contentHash) return false;
  const recomputed = fitJointGoalRates(match, fit.before?.home, fit.before?.away, at);
  return Boolean(recomputed && recomputed.contentHash === contentHash);
}

function verifyJointGoalArithmetic(fit) {
  if (!fit || fit.version !== VERSION) return false;
  const { contentHash, ...body } = fit;
  if (digest(body) !== contentHash) return false;
  const { before, inputs, output, weights } = fit;
  if (![before?.home, before?.away, inputs?.homeXg, inputs?.awayXg, inputs?.over25Rate,
    inputs?.xgTotal, inputs?.historicalTotal, output?.home, output?.away].every(finite)
    || before.home <= 0 || before.away <= 0 || inputs.xgTotal < 0.5 || inputs.xgTotal > 7
    || inputs.over25Rate <= 0.05 || inputs.over25Rate >= 0.95
    || weights?.xgTotal !== 0.18 || weights?.over25Total !== 0.22 || weights?.xgShare !== 0.28
    || Math.abs(inputs.xgTotal - inputs.homeXg - inputs.awayXg) > 1e-12
    || Math.abs(inputs.historicalTotal - totalForOver25(inputs.over25Rate)) > 1e-12) return false;
  const beforeTotal = before.home + before.away;
  const total = clamp(beforeTotal * 0.6 + inputs.xgTotal * 0.18 + inputs.historicalTotal * 0.22,
    Math.max(0.4, beforeTotal - 0.35), beforeTotal + 0.35);
  const beforeShare = before.home / beforeTotal;
  const share = clamp(beforeShare * 0.72 + inputs.homeXg / inputs.xgTotal * 0.28,
    Math.max(0.05, beforeShare - 0.08), Math.min(0.95, beforeShare + 0.08));
  return Math.abs(output.home - clamp(total * share, 0.2, 12)) < 1e-12
    && Math.abs(output.away - clamp(total * (1 - share), 0.2, 12)) < 1e-12
    && Math.abs(fit.over25Probability - over(output.home + output.away)) < 1e-12
    && Math.abs(fit.bttsProbability - (1 - Math.exp(-output.home)) * (1 - Math.exp(-output.away))) < 1e-12;
}

module.exports = { VERSION, EVIDENCE_VERSION, buildObservedGoalHistoryIndex, buildGoalFitEvidence, fitJointGoalRates, verifyJointGoalFit, verifyJointGoalArithmetic };
