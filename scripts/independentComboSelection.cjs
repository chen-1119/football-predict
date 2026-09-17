"use strict";

const crypto = require("node:crypto");

const VERSION = "independent-had-combo-v2-robust-ensemble";
const MINIMUMS = Object.freeze({ 2: 2.5, 3: 5 });
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const FREEZE_SAFETY_MS = 5 * 60 * 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const text = (value) => String(value ?? "").trim();
const finite = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const sourceMatchId = (value) => text(value).replace(/^sporttery_/, "");

const timeMs = (value) => {
  const raw = text(value);
  if (!raw) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)
    ? `${raw.replace(" ", "T")}+08:00`
    : raw;
  return Date.parse(normalized);
};
const iso = (value) => Number.isFinite(timeMs(value)) ? new Date(timeMs(value)).toISOString() : null;
const shanghaiDate = (value) => new Date(value + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);

const businessDateFor = (match) => {
  const explicit = text(match?.businessDate || match?.matchDate || match?.kickoffDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const kickoff = timeMs(match?.kickoffTime);
  return Number.isFinite(kickoff) ? shanghaiDate(kickoff) : "";
};

const dateMidnightShanghaiMs = (date) => timeMs(`${date}T00:00:00+08:00`);
const weekendForBusinessDate = (date) => {
  const midnight = dateMidnightShanghaiMs(date);
  if (!Number.isFinite(midnight)) return false;
  const weekday = new Date(midnight + SHANGHAI_OFFSET_MS).getUTCDay();
  return weekday === 0 || weekday === 6;
};
const dayPredictionStopMs = (date) => {
  const midnight = dateMidnightShanghaiMs(date);
  if (!Number.isFinite(midnight)) return NaN;
  return midnight + (weekendForBusinessDate(date) ? 23 : 22) * 60 * 60 * 1000;
};
const dayFreezeMs = (date) => {
  const midnight = dateMidnightShanghaiMs(date);
  if (!Number.isFinite(midnight)) return NaN;
  return midnight + (weekendForBusinessDate(date) ? 22 : 21) * 60 * 60 * 1000;
};

const normalizeProbabilityTriplet = (value) => {
  if (!value || typeof value !== "object") return null;
  const raw = [finite(value.home), finite(value.draw), finite(value.away)];
  if (raw.some((item) => item === null || item < 0)) return null;
  const total = raw.reduce((sum, item) => sum + item, 0);
  const percentageScale = Math.abs(total - 100) <= 0.5;
  const fractionScale = Math.abs(total - 1) <= 0.02;
  if (!percentageScale && !fractionScale) return null;
  const denominator = total;
  return { "1": raw[0] / denominator, X: raw[1] / denominator, "2": raw[2] / denominator };
};

const normalizeOddsTriplet = (value) => {
  if (!value || typeof value !== "object") return null;
  const odds = { "1": finite(value.odds1), X: finite(value.oddsX), "2": finite(value.odds2) };
  return Object.values(odds).every((item) => item !== null && item > 1) ? odds : null;
};
const devigProbabilities = (odds) => {
  const inverse = Object.fromEntries(Object.entries(odds).map(([code, value]) => [code, 1 / value]));
  const total = Object.values(inverse).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(inverse).map(([code, value]) => [code, value / total]));
};

const quoteMaxAgeMs = (kickoffMs, now) => {
  const untilKickoff = kickoffMs - now;
  if (untilKickoff <= 2 * 60 * 60 * 1000) return 15 * 60 * 1000;
  if (untilKickoff <= 6 * 60 * 60 * 1000) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
};
const modelMaxAgeMs = (kickoffMs, now) => {
  const untilKickoff = kickoffMs - now;
  if (untilKickoff <= 2 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (untilKickoff <= 6 * 60 * 60 * 1000) return 3 * 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
};

function selectOfficialHadQuote(match, now, deadlineMs) {
  const had = match?.externalSignals?.bookmakerOdds?.had;
  const candidates = [
    {
      odds: match?.odds,
      source: match?.oddsSource,
      updatedAt: match?.oddsUpdatedAt,
      receivedAt: match?.oddsReceivedAt,
      sourceMatchId: match?.sourceMatchId,
      eventVersion: match?.eventVersion,
      sourceCycleId: match?.sourceCycleId,
    },
    {
      odds: had,
      source: had?.source,
      updatedAt: had?.updatedAt,
      receivedAt: had?.receivedAt,
      sourceMatchId: had?.sourceMatchId,
      eventVersion: had?.eventVersion,
      sourceCycleId: had?.sourceCycleId,
    },
  ];
  const kickoffMs = timeMs(match?.kickoffTime);
  const maxAge = quoteMaxAgeMs(kickoffMs, now);
  return candidates
    .map((row) => ({ ...row, normalizedOdds: normalizeOddsTriplet(row.odds), observedMs: timeMs(row.receivedAt || row.updatedAt) }))
    .filter((row) => {
      if (!/^sporttery:had(?:$|:)/i.test(text(row.source))) return false;
      if (!row.normalizedOdds || !Number.isFinite(row.observedMs)) return false;
      if (row.observedMs > now || row.observedMs >= deadlineMs || now - row.observedMs > maxAge) return false;
      if (row.sourceMatchId && sourceMatchId(row.sourceMatchId) !== sourceMatchId(match?.sourceMatchId || match?.id)) return false;
      if (row.eventVersion && iso(row.eventVersion) !== iso(match?.eventVersion || match?.kickoffTime)) return false;
      return true;
    })
    .sort((left, right) => right.observedMs - left.observedMs)[0] || null;
}

const blendWeightForModel = (dataQuality) => {
  const quality = finite(dataQuality);
  if (quality === null) return 0.55;
  const normalized = quality > 1 ? quality / 100 : quality;
  return clamp(0.5 + clamp(normalized, 0, 1) * 0.2, 0.5, 0.7);
};

function robustDirection(modelProbabilities, marketProbabilities, dataQuality) {
  const modelWeight = blendWeightForModel(dataQuality);
  const rows = ["1", "X", "2"].map((code) => {
    const model = modelProbabilities[code];
    const market = marketProbabilities[code];
    const blended = modelWeight * model + (1 - modelWeight) * market;
    const disagreement = Math.abs(model - market);
    // Shrink disagreement toward the more conservative of model and market.
    const robust = 0.65 * blended + 0.35 * Math.min(model, market);
    return { code, modelProbability: model, marketProbability: market, blendedProbability: blended, robustProbability: robust, disagreement };
  }).sort((a, b) => b.robustProbability - a.robustProbability);
  if (Math.abs(rows[0].robustProbability - rows[1].robustProbability) < 0.005) return null;
  return { selected: rows[0], alternatives: rows.slice(1), modelWeight };
}

const effectiveDeadlineMs = (match, date) => {
  const candidates = [timeMs(match?.kickoffTime), dayPredictionStopMs(date)];
  for (const value of [match?.buyEndTime, match?.predictionMeta?.cutoffTime]) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = timeMs(value);
    if (!Number.isFinite(parsed)) return NaN;
    candidates.push(parsed);
  }
  return Math.min(...candidates.filter(Number.isFinite));
};

function independentCandidate(match, now = Date.now()) {
  match = require('../src/services/prospectiveForecastInput.cjs').forecastInputFor(match);
  if (!Number.isFinite(now) || match?.status !== "SCHEDULED" || match?.resultDisposition === "VOID") return null;
  if (match?.isOnSale === false || ["CLOSED", "SUSPENDED", "STOPPED"].includes(text(match?.saleStatus).toUpperCase())) return null;
  const id = sourceMatchId(match?.sourceMatchId || match?.id);
  const kickoffMs = timeMs(match?.kickoffTime);
  const eventVersion = iso(match?.eventVersion || match?.kickoffTime);
  if (!id || !text(match?.id) || !Number.isFinite(kickoffMs) || !eventVersion || timeMs(eventVersion) !== kickoffMs) return null;
  if (![match?.homeTeamId, match?.awayTeamId, match?.homeTeamName, match?.awayTeamName].every((value) => text(value))) return null;
  if (match.homeTeamId === match.awayTeamId) return null;

  const date = businessDateFor(match);
  if (!date || date !== shanghaiDate(now)) return null;
  const deadlineMs = effectiveDeadlineMs(match, date);
  if (!Number.isFinite(deadlineMs) || now >= deadlineMs) return null;

  const probabilityModel = match?.probabilityModel;
  const modelProbabilities = normalizeProbabilityTriplet(probabilityModel?.oneXTwo?.final);
  const modelGeneratedMs = timeMs(probabilityModel?.generatedAt || match?.predictionMeta?.generatedAt);
  if (!modelProbabilities || !Number.isFinite(modelGeneratedMs) || modelGeneratedMs > now || modelGeneratedMs >= deadlineMs) return null;
  if (now - modelGeneratedMs > modelMaxAgeMs(kickoffMs, now)) return null;
  if (probabilityModel?.eventVersion && iso(probabilityModel.eventVersion) !== eventVersion) return null;

  const quote = selectOfficialHadQuote(match, now, deadlineMs);
  if (!quote) return null;
  const marketProbabilities = devigProbabilities(quote.normalizedOdds);
  const direction = robustDirection(modelProbabilities, marketProbabilities, probabilityModel?.dataQuality ?? match?.dataQuality);
  if (!direction) return null;
  const selected = direction.selected;
  const odds = quote.normalizedOdds[selected.code];
  const quoteAgeMs = now - quote.observedMs;
  const quoteAgeLimitMs = quoteMaxAgeMs(kickoffMs, now);
  const freshnessFactor = clamp(1 - (quoteAgeMs / Math.max(quoteAgeLimitMs, 1)) * 0.04, 0.96, 1);
  const disagreementPenalty = clamp(selected.disagreement / 0.25, 0, 1) * 0.08;
  const qualityScore = clamp(selected.robustProbability * freshnessFactor - disagreementPenalty, 0.01, 0.99);
  const quoteSignature = JSON.stringify({ id, eventVersion, source: quote.source, observedAt: new Date(quote.observedMs).toISOString(), odds: quote.normalizedOdds });

  return {
    matchId: text(match.id),
    sourceMatchId: id,
    eventVersion,
    businessDate: date,
    matchNo: text(match?.matchNo || match?.matchNumStr || match?.matchNum) || null,
    kickoffTime: new Date(kickoffMs).toISOString(),
    cutoffTime: new Date(deadlineMs).toISOString(),
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    leagueId: match.leagueId || null,
    market: "HAD",
    tipCode: selected.code,
    handicapLine: 0,
    odds,
    modelProbability: selected.modelProbability,
    marketProbability: selected.marketProbability,
    blendedProbability: selected.blendedProbability,
    robustProbability: selected.robustProbability,
    marketDisagreement: selected.disagreement,
    qualityScore,
    modelWeight: direction.modelWeight,
    modelProbabilities,
    marketProbabilities,
    modelGeneratedAt: new Date(modelGeneratedMs).toISOString(),
    quoteSource: quote.source,
    quoteObservedAt: new Date(quote.observedMs).toISOString(),
    quoteUpdatedAt: iso(quote.updatedAt),
    quoteAgeSeconds: Math.round(quoteAgeMs / 1000),
    quoteMaxAgeSeconds: Math.round(quoteAgeLimitMs / 1000),
    quoteBatchId: text(quote.sourceCycleId) || null,
    quoteOdds: quote.normalizedOdds,
    quoteHash: crypto.createHash("sha256").update(quoteSignature).digest("hex"),
    evaluatedAt: new Date(now).toISOString(),
    selectionPolicy: VERSION,
    statisticsTrack: "independent-combo-v2",
  };
}

function candidatesFor(matches, now = Date.now()) {
  const bySourceId = new Map();
  for (const match of matches || []) {
    const id = sourceMatchId(match?.sourceMatchId || match?.id);
    if (!id) continue;
    const group = bySourceId.get(id) || [];
    group.push(match);
    bySourceId.set(id, group);
  }
  const accepted = [];
  for (const group of bySourceId.values()) {
    const identities = new Set(group.map((match) => JSON.stringify([
      iso(match?.eventVersion || match?.kickoffTime), match?.homeTeamId || null, match?.awayTeamId || null,
    ])));
    if (identities.size !== 1) continue;
    const candidates = group.map((match) => independentCandidate(match, now)).filter(Boolean)
      .sort((left, right) => timeMs(right.quoteObservedAt) - timeMs(left.quoteObservedAt) || left.matchId.localeCompare(right.matchId));
    if (candidates[0]) accepted.push(candidates[0]);
  }
  return accepted.sort((left, right) => right.qualityScore - left.qualityScore || left.sourceMatchId.localeCompare(right.sourceMatchId));
}

const decimalUnits = (value) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 1) return null;
  const fixed = numeric.toFixed(4);
  const [whole, fraction = ""] = fixed.split(".");
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
};
const totalOddsFor = (legs) => legs.reduce((product, leg) => product * leg.odds, 1);
const passesFloor = (legs, floor) => {
  const units = legs.map((leg) => decimalUnits(leg.odds));
  if (units.some((value) => value === null)) return false;
  const numerator = units.reduce((product, value) => product * value, 1n);
  const denominator = 10000n ** BigInt(legs.length);
  return numerator * 100n >= BigInt(Math.round(floor * 100)) * denominator;
};

function rankCombination(legs, floor) {
  const totalOdds = totalOddsFor(legs);
  const logQuality = legs.reduce((sum, leg) => sum + Math.log(clamp(leg.qualityScore, 0.01, 0.99)), 0);
  const averageDisagreement = legs.reduce((sum, leg) => sum + leg.marketDisagreement, 0) / legs.length;
  const sameLeaguePairs = legs.reduce((count, leg, index) => count + legs.slice(index + 1).filter((other) => leg.leagueId && leg.leagueId === other.leagueId).length, 0);
  const overshootPenalty = Math.log(Math.max(totalOdds, floor) / floor) * 0.08;
  const disagreementPenalty = averageDisagreement * 0.6;
  const concentrationPenalty = sameLeaguePairs * 0.015;
  return { totalOdds, score: logQuality - overshootPenalty - disagreementPenalty - concentrationPenalty, averageDisagreement };
}

function choose(candidates, size) {
  const floor = MINIMUMS[size];
  if (!floor || !Array.isArray(candidates)) return null;
  let best = null;
  let bestRank = null;
  const visit = (start, picked) => {
    if (picked.length === size) {
      if (!passesFloor(picked, floor)) return;
      const rank = rankCombination(picked, floor);
      if (!bestRank || rank.score > bestRank.score + 1e-12
        || (Math.abs(rank.score - bestRank.score) <= 1e-12 && rank.totalOdds < bestRank.totalOdds)) {
        best = [...picked];
        bestRank = rank;
      }
      return;
    }
    for (let index = start; index <= candidates.length - (size - picked.length); index += 1) {
      const leg = candidates[index];
      if (!leg?.sourceMatchId || !Number.isFinite(leg.qualityScore) || !Number.isFinite(leg.odds)) continue;
      if (picked.some((row) => row.sourceMatchId === leg.sourceMatchId)) continue;
      const teams = [leg.homeTeamId, leg.awayTeamId].filter(Boolean);
      if (picked.some((row) => teams.some((team) => [row.homeTeamId, row.awayTeamId].includes(team)))) continue;
      visit(index + 1, [...picked, leg]);
    }
  };
  visit(0, []);
  if (!best) return null;
  const earliestCutoff = Math.min(...best.map((leg) => timeMs(leg.cutoffTime)).filter(Number.isFinite));
  const scheduledFreeze = dayFreezeMs(best[0].businessDate);
  const freezeAtMs = Math.min(scheduledFreeze, earliestCutoff - FREEZE_SAFETY_MS);
  return {
    size,
    minimumTotalOdds: floor,
    totalOdds: Number(bestRank.totalOdds.toFixed(2)),
    rawTotalOdds: bestRank.totalOdds,
    averageQualityScore: Number((best.reduce((sum, leg) => sum + leg.qualityScore, 0) / best.length).toFixed(4)),
    averageMarketDisagreement: Number(bestRank.averageDisagreement.toFixed(4)),
    freezeAt: Number.isFinite(freezeAtMs) ? new Date(freezeAtMs).toISOString() : null,
    legs: best.sort((left, right) => timeMs(left.kickoffTime) - timeMs(right.kickoffTime) || left.sourceMatchId.localeCompare(right.sourceMatchId)),
    selectionPolicy: VERSION,
    statisticsTrack: "independent-combo-v2",
    rankingMethod: "robust-model-market-ensemble-with-sp-floor",
    probabilityNote: "Robust probabilities are ranking inputs only; no calibrated parlay win probability is asserted.",
  };
}

function canPublish(health, meta, publication, now) {
  const freshnessValue = meta?.api?.currentFreshnessTime || meta?.updatedAt;
  const age = now - timeMs(freshnessValue);
  const fresh = typeof meta?.api?.currentStale === "boolean" ? !meta.api.currentStale : health?.status?.dataFresh === true;
  return health?.status?.serviceOk === true
    && fresh
    && Number.isFinite(age)
    && age >= 0
    && age <= 60 * 60 * 1000
    && Boolean(publication?.manifestHash && publication?.generationId)
    && meta?.publication?.manifestHash === publication.manifestHash
    && meta?.publication?.generationId === publication.generationId;
}

module.exports = {
  VERSION,
  MINIMUMS,
  FREEZE_SAFETY_MS,
  independentCandidate,
  candidatesFor,
  choose,
  canPublish,
  normalizeProbabilityTriplet,
  normalizeOddsTriplet,
  devigProbabilities,
  robustDirection,
  quoteMaxAgeMs,
  modelMaxAgeMs,
  rankCombination,
  businessDateFor,
  dayFreezeMs,
  dayPredictionStopMs,
  timeMs,
  iso,
};
