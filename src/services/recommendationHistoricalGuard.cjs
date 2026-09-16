"use strict";

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const evaluateHistoricalRecommendationGuard = (input = {}) => {
  const market = String(input.market || "").toUpperCase();
  const code = String(input.code || "").toUpperCase();
  const odds = finite(input.odds);
  const modelProbability = finite(input.modelProbability);
  const modelGap = finite(input.modelGap);
  const probabilityEdge = finite(input.probabilityEdge);
  const dataQuality = finite(input.dataQuality);
  const marketLeaderAligned = input.marketLeaderAligned === true;
  const externalMarketAligned = input.externalMarketAligned === true;
  const trendContradicts = input.trendContradicts === true;
  const blockers = [];
  const reasons = [];

  if (!odds || odds <= 1) return { blockers, reasons, tier: "unknown" };

  if (odds > 2.60) {
    blockers.push("historical-high-sp-cooling");
    reasons.push("single-sp-above-2.60-reference-only");
  } else if (odds >= 2.06) {
    if (modelProbability === null || modelProbability < 0.52) blockers.push("high-sp-model-probability-too-low");
    if (modelGap === null || modelGap < 0.10) blockers.push("high-sp-model-separation-too-thin");
    if (probabilityEdge === null || probabilityEdge < 0.03) blockers.push("high-sp-market-edge-too-thin");
    if (!marketLeaderAligned && !externalMarketAligned) blockers.push("high-sp-market-confirmation-missing");
    if (dataQuality === null || dataQuality < 0.62) blockers.push("high-sp-data-quality-too-low");
    reasons.push("sp-2.06-2.60-tightened");
  } else if (odds >= 1.71) {
    if (modelGap === null || modelGap < 0.07) blockers.push("mid-sp-model-separation-too-thin");
    if (dataQuality === null || dataQuality < 0.50) blockers.push("mid-sp-data-quality-too-low");
    reasons.push("sp-1.71-2.05-standard-plus");
  } else {
    reasons.push("sp-at-or-below-1.70-standard");
  }

  if (market === "HHAD") {
    if (modelProbability === null || modelProbability < 0.56) blockers.push("hhad-model-probability-too-low");
    if (modelGap === null || modelGap < 0.10) blockers.push("hhad-model-separation-too-thin");
    if (dataQuality === null || dataQuality < 0.65) blockers.push("hhad-data-quality-too-low");
    if (!marketLeaderAligned && !externalMarketAligned) blockers.push("hhad-market-confirmation-missing");
    reasons.push("hhad-historical-cooling");
  }

  if (trendContradicts && odds >= 1.71) blockers.push("historical-guard-trend-contradiction");
  if (code === "X" && odds >= 2.06 && (modelProbability === null || modelProbability < 0.42)) {
    blockers.push("high-sp-draw-probability-too-low");
  }

  return {
    version: "historical-recommendation-guard-v1",
    tier: odds > 2.60 ? "reference-only" : odds >= 2.06 || market === "HHAD" ? "tight" : "standard",
    blockers: [...new Set(blockers)],
    reasons,
  };
};

module.exports = { evaluateHistoricalRecommendationGuard };
