const finiteNumber = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const evaluateFallbackReadiness = (status = {}, minRunwaySeconds = 600) => {
  const servingMode = status.servingMode || null;
  const fallbackAgeSeconds = finiteNumber(status.fallbackAgeSeconds);
  const fallbackMaxAgeSeconds = finiteNumber(status.fallbackMaxAgeSeconds);
  const fallbackRunwaySeconds = fallbackAgeSeconds !== null && fallbackMaxAgeSeconds !== null
    ? Math.max(0, fallbackMaxAgeSeconds - fallbackAgeSeconds)
    : null;
  const fallbackActive = String(servingMode || "").startsWith("fallback");
  const sourceHealthOk = status.sourceHealthOk === true;
  const fallbackDataFresh = status.fallbackDataFresh === true;
  const fallbackWithinReliableWindow = status.fallbackWithinReliableWindow === true;
  const fallbackReliable = sourceHealthOk && fallbackDataFresh && fallbackWithinReliableWindow;
  const safeMinRunwaySeconds = Math.max(0, Number(minRunwaySeconds) || 0);
  const ok = !fallbackActive
    || (fallbackReliable
      && fallbackRunwaySeconds !== null
      && fallbackRunwaySeconds >= safeMinRunwaySeconds);

  return {
    ok,
    servingMode,
    fallbackActive,
    sourceHealthOk,
    fallbackDataFresh,
    fallbackWithinReliableWindow,
    fallbackReliable,
    formalRecommendationReliable: status.recommendationReliable === true,
    fallbackAgeSeconds,
    fallbackMaxAgeSeconds,
    fallbackRunwaySeconds,
    minFallbackRunwaySeconds: safeMinRunwaySeconds,
  };
};

module.exports = {
  evaluateFallbackReadiness,
};
