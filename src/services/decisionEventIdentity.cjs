"use strict";

const supplied = (value) => value !== null && value !== undefined
  && !(typeof value === "string" && value.trim() === "");
const identityText = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(text) && text.length <= 160 ? text : "";
};

// These are internal aliases of an official event, not raw external provider
// fixture IDs. Both explicit source IDs and the exact kickoff must agree.
// Never strip an arbitrary prefix or join by display/team names.
const exactDecisionEventMatch = (decision, match) => {
  const identityFields = [decision?.matchId, decision?.sourceMatchId, match?.matchId, match?.id, match?.sourceMatchId];
  if (identityFields.some((value) => supplied(value) && !identityText(value))) return false;
  const decisionKickoff = Date.parse(decision?.kickoffTime || "");
  const matchKickoff = Date.parse(match?.kickoffTime || match?.matchDate || "");
  if (!Number.isFinite(decisionKickoff) || decisionKickoff !== matchKickoff) return false;
  const decisionId = identityText(decision?.matchId);
  const matchId = identityText(match?.matchId || match?.id);
  const decisionSource = identityText(decision?.sourceMatchId);
  const matchSource = identityText(match?.sourceMatchId);
  if (decisionSource && matchSource && decisionSource !== matchSource) return false;
  if (decision?.eventVersion && match?.eventVersion) {
    const version = Date.parse(decision.eventVersion);
    if (!Number.isFinite(version) || version !== Date.parse(match.eventVersion)) return false;
  }
  if (decisionId && matchId && decisionId !== matchId) {
    if (!decisionSource || decisionSource !== matchSource) return false;
    const aliases = new Set([`sporttery_${decisionSource}`, `fivehundred_${decisionSource}`]);
    return aliases.has(decisionId) && aliases.has(matchId);
  }
  return Boolean((decisionId && matchId && decisionId === matchId)
    || (decisionSource && matchSource && decisionSource === matchSource));
};

module.exports = { exactDecisionEventMatch };
