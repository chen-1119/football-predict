"use strict";

const publicLiveRecommendationSummary = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const qualifiedCount = Number(value.qualifiedCount);
  return {
    version: typeof value.version === "string" ? value.version : null,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    qualifiedCount: Number.isSafeInteger(qualifiedCount) && qualifiedCount >= 0
      ? qualifiedCount
      : 0,
  };
};

module.exports = {
  publicLiveRecommendationSummary,
};
