"use strict";

const {
  canonicalSourceMatchId,
  eventVersionOf,
} = require("../src/services/matchLifecycle.cjs");

const asText = (value) => String(value ?? "").trim();

// Some legacy/public rows use presentation IDs derived from the display name
// instead of a provider-owned team identifier. A later canonical-name refresh
// can therefore change both the display name and that derived ID while the
// immutable Sporttery fixture itself remains unchanged.
function derivedTeamId(name) {
  let hash = 2166136261;
  for (const character of String(name || "").split("")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `team_${(hash >>> 0).toString(36)}`;
}

const sourceMatchIdFor = (match) => canonicalSourceMatchId(
  match?.sourceMatchId || match?.matchId || match?.id,
);

const isSyntheticDisplayTeamId = (match, side) => {
  const teamId = asText(match?.[`${side}TeamId`]);
  const teamName = asText(match?.[`${side}TeamName`]);
  return Boolean(teamId && teamName && teamId === derivedTeamId(teamName));
};

const comparableProviderTeamId = (match, side) => {
  const teamId = asText(match?.[`${side}TeamId`]);
  if (!teamId || isSyntheticDisplayTeamId(match, side)) return "";
  return teamId.toLowerCase();
};

const canonicalTeamName = (match, side) => asText(match?.[`${side}TeamName`])
  .toLowerCase()
  .replace(/\s+/g, " ");

const teamSideCompatible = (left, right, side) => {
  const leftProviderId = comparableProviderTeamId(left, side);
  const rightProviderId = comparableProviderTeamId(right, side);
  if (leftProviderId && rightProviderId) return leftProviderId === rightProviderId;

  // If only one side owns a provider identifier, do not compare that opaque ID
  // to a display name. The immutable event key still guards the result merge.
  if (leftProviderId || rightProviderId) return true;

  const leftName = canonicalTeamName(left, side);
  const rightName = canonicalTeamName(right, side);
  if (!leftName || !rightName) return true;
  if (leftName === rightName) return true;

  // Both IDs are presentation hashes generated from their respective names.
  // A short/full translated-name refresh is therefore not evidence of a new
  // fixture. This exception is deliberately scoped to stored result repair;
  // the general matchLifecycle.sameEvent contract remains strict.
  return isSyntheticDisplayTeamId(left, side) && isSyntheticDisplayTeamId(right, side);
};

function storedResultEventsMatch(left, right) {
  if (!left || !right) return false;
  const leftSourceId = sourceMatchIdFor(left);
  const rightSourceId = sourceMatchIdFor(right);
  if (!leftSourceId || !rightSourceId || leftSourceId !== rightSourceId) return false;

  const leftEventVersion = eventVersionOf(left);
  const rightEventVersion = eventVersionOf(right);
  if (!leftEventVersion || !rightEventVersion || leftEventVersion !== rightEventVersion) return false;

  return teamSideCompatible(left, right, "home")
    && teamSideCompatible(left, right, "away");
}

// Retained for callers/tests that still need a normalized copy. Provider-owned
// IDs are never rewritten. Synthetic IDs are left intact because matching now
// happens through storedResultEventsMatch instead of a hard-coded alias table.
function storedResultTeamIdentity(match) {
  return { ...(match || {}) };
}

module.exports = {
  storedResultTeamIdentity,
  storedResultEventsMatch,
  isSyntheticDisplayTeamId,
  derivedTeamId,
};
