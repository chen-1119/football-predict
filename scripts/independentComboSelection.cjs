"use strict";

const crypto = require("node:crypto");
const VERSION = "independent-had-combo-v1";
const MINIMUMS = Object.freeze({ 2: 2.5, 3: 5 });
const MAX_QUOTE_AGE_MS = 15 * 60_000;
const text = (v) => String(v ?? "").trim();
const number = (v) => (typeof v === "number" || (typeof v === "string" && v.trim())) && Number.isFinite(Number(v)) ? Number(v) : null;
const sourceId = (v) => text(v).replace(/^sporttery_/, "");
const time = (v) => {
  const raw = text(v);
  const explicit = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)
    ? `${raw.replace(" ", "T")}+08:00` : raw;
  return Date.parse(explicit);
};
const iso = (v) => Number.isFinite(time(v)) ? new Date(time(v)).toISOString() : null;
const dayAt = (now) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
const businessDate = (m) => {
  const date = text(m?.businessDate || m?.matchDate || m?.kickoffDate).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : Number.isFinite(time(m?.kickoffTime)) ? dayAt(time(m.kickoffTime)) : "";
};
const stopAt = (date) => {
  const midnight = time(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(midnight)) return NaN;
  const weekday = new Date(midnight + 8 * 3_600_000).getUTCDay();
  return midnight + ([0, 6].includes(weekday) ? 23 : 22) * 3_600_000;
};

function probabilities(value) {
  if (!value || typeof value !== "object") return null;
  const values = [value.home, value.draw, value.away].map(number);
  if (values.some((v) => v === null || v < 0)) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  // Accept fractions or rounded percentages, not arbitrary confidence scores.
  if (!(Math.abs(total - 1) <= 0.02 || Math.abs(total - 100) <= 0.2)) return null;
  return Object.fromEntries(["1", "X", "2"].map((key, i) => [key, values[i] / total]));
}

function decimalUnits(value) {
  if (number(value) === null || Number(value) <= 1) return null;
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
}
function productFor(legs, floor) {
  const units = legs.map((leg) => decimalUnits(leg.odds));
  if (!units.length || units.some((v) => v === null)) return null;
  const numerator = units.reduce((a, b) => a * b, 1n);
  const denominator = 10000n ** BigInt(units.length);
  return { passes: numerator * 100n >= BigInt(Math.round(floor * 100)) * denominator,
    value: Number(numerator) / Number(denominator) };
}

function quoteFor(match, now, deadline) {
  // Source, clock and all three prices travel together. Never mix a market
  // average/European quote with a Sporttery label or another source's clock.
  const had = match?.externalSignals?.bookmakerOdds?.had;
  const candidates = [
    { odds: match?.odds, source: match?.oddsSource, updatedAt: match?.oddsUpdatedAt,
      receivedAt: match?.oddsReceivedAt, sourceMatchId: match?.sourceMatchId,
      eventVersion: match?.eventVersion, batch: match?.sourceCycleId },
    { odds: had, source: had?.source, updatedAt: had?.updatedAt,
      receivedAt: had?.receivedAt, sourceMatchId: had?.sourceMatchId,
      eventVersion: had?.eventVersion, batch: had?.sourceCycleId },
  ];
  return candidates.filter((row) => {
    if (!/^sporttery:had(?:$|:)/i.test(text(row.source))) return false;
    if (![row.odds?.odds1, row.odds?.oddsX, row.odds?.odds2].every((v) => decimalUnits(v) !== null)) return false;
    if (row.sourceMatchId && sourceId(row.sourceMatchId) !== sourceId(match.sourceMatchId || match.id)) return false;
    if (row.eventVersion && iso(row.eventVersion) !== iso(match.eventVersion || match.kickoffTime)) return false;
    const seen = time(row.receivedAt || row.updatedAt);
    return Number.isFinite(seen) && seen <= now && seen < deadline && now - seen <= MAX_QUOTE_AGE_MS;
  }).sort((a, b) => time(b.receivedAt || b.updatedAt) - time(a.receivedAt || a.updatedAt))[0] || null;
}

function independentCandidate(match, now = Date.now()) {
  if (!Number.isFinite(now) || match?.status !== "SCHEDULED") return null;
  const id = sourceId(match.sourceMatchId || match.id);
  const kickoff = time(match.kickoffTime), event = iso(match.eventVersion || match.kickoffTime);
  if (!id || !text(match.id) || !event || !Number.isFinite(kickoff) || time(event) !== kickoff) return null;
  const date = businessDate(match);
  if (date !== dayAt(now)) return null;
  const deadlines = [kickoff, stopAt(date)];
  for (const value of [match.buyEndTime, match.predictionMeta?.cutoffTime]) {
    if (value === null || value === undefined || value === "") continue;
    if (!Number.isFinite(time(value))) return null;
    deadlines.push(time(value));
  }
  const deadline = Math.min(...deadlines);
  if (now >= deadline || match.resultDisposition === "VOID") return null;
  if (match.isOnSale === false || ["CLOSED", "SUSPENDED", "STOPPED"].includes(text(match.saleStatus).toUpperCase())) return null;
  if (![match.homeTeamId, match.awayTeamId, match.homeTeamName, match.awayTeamName].every((v) => text(v))) return null;
  if (match.homeTeamId === match.awayTeamId) return null;

  const model = match.probabilityModel;
  const distribution = probabilities(model?.oneXTwo?.final);
  const modelAt = time(model?.generatedAt || match.predictionMeta?.generatedAt);
  if (!distribution || !Number.isFinite(modelAt) || modelAt > now || modelAt >= deadline) return null;
  if (model?.eventVersion && iso(model.eventVersion) !== event) return null;
  // Do not consume BEST, recommendationAction, trustScore or formal risk tier.
  // A reference model can be evaluated here without being promoted to formal.
  const ranked = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] - ranked[1][1] < 1e-8) return null;
  const [code, probability] = ranked[0];
  const quote = quoteFor(match, now, deadline);
  if (!quote) return null;
  const key = code === "1" ? "odds1" : code === "X" ? "oddsX" : "odds2";
  const quoteOdds = Object.fromEntries(["odds1", "oddsX", "odds2"].map((k) => [k, Number(quote.odds[k])]));
  const evidence = number(model?.dataQuality);
  const signature = JSON.stringify({ id, event, odds: quoteOdds, source: quote.source, observedAt: quote.receivedAt || quote.updatedAt });
  return {
    matchId: text(match.id), sourceMatchId: id, eventVersion: event,
    businessDate: date, matchNo: text(match.matchNo || match.matchNumStr || match.matchNum) || null,
    kickoffTime: new Date(kickoff).toISOString(), cutoffTime: new Date(deadline).toISOString(),
    homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    homeTeamName: match.homeTeamName, awayTeamName: match.awayTeamName, leagueId: match.leagueId || null,
    market: "HAD", tipCode: code, handicapLine: 0, odds: quoteOdds[key], evidenceScore: null,
    modelProbability: probability, modelProbabilities: distribution, modelGeneratedAt: new Date(modelAt).toISOString(),
    probabilitySource: "probabilityModel.oneXTwo.final", probabilityCalibration: "not-asserted",
    dataQuality: evidence, selectionPolicy: VERSION, statisticsTrack: "independent-combo",
    quoteSource: quote.source, quoteUpdatedAt: iso(quote.updatedAt), quoteObservedAt: iso(quote.receivedAt || quote.updatedAt),
    quoteBatchId: text(quote.batch) || null, quoteHash: crypto.createHash("sha256").update(signature).digest("hex"),
    quoteOdds, evaluatedAt: new Date(now).toISOString(),
  };
}

function candidatesFor(matches, now) {
  const groups = new Map();
  for (const match of matches) {
    const id = sourceId(match?.sourceMatchId || match?.id);
    const group = groups.get(id) || [];
    group.push(match); groups.set(id, group);
  }
  const accepted = [];
  for (const group of groups.values()) {
    // Conflicting aliases/versions cannot silently create a second leg.
    const identities = new Set(group.map((m) => JSON.stringify([iso(m?.eventVersion || m?.kickoffTime), m?.homeTeamId, m?.awayTeamId])));
    if (identities.size !== 1) continue;
    const rows = group.map((m) => independentCandidate(m, now)).filter(Boolean);
    rows.sort((a, b) => time(b.quoteObservedAt) - time(a.quoteObservedAt) || a.matchId.localeCompare(b.matchId));
    if (rows[0]) accepted.push(rows[0]);
  }
  return accepted.sort((a, b) => b.modelProbability - a.modelProbability || a.sourceMatchId.localeCompare(b.sourceMatchId));
}

function choose(candidates, size) {
  const floor = MINIMUMS[size];
  if (!floor || !Array.isArray(candidates)) return null;
  let best = null, bestScore = -Infinity, bestProduct = null;
  function visit(start, picked, score) {
    if (picked.length === size) {
      const product = productFor(picked, floor);
      if (!product?.passes) return;
      if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && product.value < bestProduct.value)) {
        best = [...picked]; bestScore = score; bestProduct = product;
      }
      return;
    }
    for (let i = start; i <= candidates.length - (size - picked.length); i++) {
      const leg = candidates[i];
      if (!leg?.sourceMatchId || !Number.isFinite(leg.modelProbability) || leg.modelProbability <= 0 || leg.modelProbability > 1 || decimalUnits(leg.odds) === null) continue;
      if (picked.some((p) => p.sourceMatchId === leg.sourceMatchId)) continue;
      const teams = [leg.homeTeamId, leg.awayTeamId].filter(Boolean);
      if (picked.some((p) => teams.some((team) => [p.homeTeamId, p.awayTeamId].includes(team)))) continue;
      visit(i + 1, [...picked, leg], score + Math.log(leg.modelProbability));
    }
  }
  visit(0, [], 0);
  return best ? {
    size, minimumTotalOdds: floor, totalOdds: Number(bestProduct.value.toFixed(2)), rawTotalOdds: bestProduct.value,
    averageEvidenceScore: null, legs: best.sort((a, b) => time(a.kickoffTime) - time(b.kickoffTime) || a.sourceMatchId.localeCompare(b.sourceMatchId)),
    selectionPolicy: VERSION, statisticsTrack: "independent-combo",
    rankingMethod: "maximum-sum-log-model-probability-subject-to-sp-floor",
    jointProbability: null, probabilityNote: "Ranking assumes independence; no calibrated combo win probability is asserted.",
  } : null;
}

function canPublish(health, meta, publication, now) {
  const age = now - time(meta?.api?.currentFreshnessTime || meta?.updatedAt);
  const fresh = typeof meta?.api?.currentStale === "boolean" ? !meta.api.currentStale : health?.status?.dataFresh === true;
  return health?.status?.serviceOk === true && fresh && age >= 0 && age <= MAX_QUOTE_AGE_MS
    && Boolean(publication?.manifestHash && publication?.generationId)
    && meta?.publication?.manifestHash === publication.manifestHash
    && meta?.publication?.generationId === publication.generationId;
}

module.exports = { VERSION, MINIMUMS, MAX_QUOTE_AGE_MS, independentCandidate, candidatesFor, choose, canPublish, probabilities, productFor, time, iso, businessDate };
