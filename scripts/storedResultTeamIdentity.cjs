"use strict";

const { canonicalSourceMatchId, eventVersionOf } = require("../src/services/matchLifecycle.cjs");

function derivedTeamId(name) {
  let hash = 2166136261;
  for (const character of String(name || "").split("")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `team_${(hash >>> 0).toString(36)}`;
}

const text = (value) => String(value ?? "").trim();

function storedResultTeamIdentity(match) {
  const normalized = { ...(match || {}) };
  const sourceId = canonicalSourceMatchId(match?.sourceMatchId || match?.matchId || match?.id);
  const eventVersion = eventVersionOf(match);
  if (!sourceId || !eventVersion) return normalized;

  for (const side of ["home", "away"]) {
    const name = text(match?.[`${side}TeamName`]);
    const teamId = text(match?.[`${side}TeamId`]);
    if (!name || !teamId || teamId !== derivedTeamId(name)) continue;

    // IDs proven to be display-name hashes are presentation identities, not
    // provider-owned team identities. Rebind only these synthetic values to
    // the immutable Sporttery source event so short/full-name changes do not
    // split one archived fixture into two. Real provider IDs are untouched.
    const eventTeam = `stored_${sourceId}_${eventVersion}_${side}`;
    normalized[`${side}TeamId`] = eventTeam;
    normalized[`${side}TeamName`] = eventTeam;
  }
  return normalized;
}

module.exports = { storedResultTeamIdentity, derivedTeamId };
