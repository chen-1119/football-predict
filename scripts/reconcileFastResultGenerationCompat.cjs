"use strict";

/**
 * Compatibility entrypoint for the legacy review reconciliation lane.
 *
 * Historical rows do not always carry the same team identity representation:
 * one surface can have an internal team id while another only has a provider
 * display name. Comparing those two strings directly creates a false event
 * mismatch even when sourceMatchId + event clock are identical.
 *
 * This wrapper keeps every immutable event guard (provider match id, explicit
 * eventVersion and kickoff clock) and only relaxes team comparison when the two
 * rows do not share a comparable representation. If both sides have ids, codes
 * or names, those values still must match. Strong id conflicts therefore remain
 * fail-closed.
 */

const lifecycle = require("../src/services/matchLifecycle.cjs");

const text = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const canonicalInstant = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const canonicalVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return canonicalInstant(raw) || text(raw);
};

const sourceMatchKey = (match) => {
  const explicit = lifecycle.canonicalSourceMatchId(match?.sourceMatchId);
  if (explicit) return explicit;
  return lifecycle.canonicalSourceMatchId(match?.matchId ?? match?.id);
};

const teamIdentity = (match, side) => ({
  id: text(match?.[`${side}TeamId`] ?? match?.[`${side}Id`]),
  code: text(match?.[`${side}TeamCode`]),
  name: text(match?.[`${side}TeamName`] ?? match?.[`${side}Team`]),
});

const comparableTeamIdentity = (left, right) => {
  if (left.id && right.id) return { comparable: true, same: left.id === right.id, kind: "id" };
  if (left.code && right.code) return { comparable: true, same: left.code === right.code, kind: "code" };
  if (left.name && right.name) return { comparable: true, same: left.name === right.name, kind: "name" };
  return { comparable: false, same: true, kind: null };
};

const sameEventCompatible = (left, right) => {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftKey = sourceMatchKey(left);
  const rightKey = sourceMatchKey(right);
  if (leftKey && rightKey && leftKey !== rightKey) return false;

  const leftExplicitVersion = canonicalVersion(left.eventVersion);
  const rightExplicitVersion = canonicalVersion(right.eventVersion);
  if (leftExplicitVersion && rightExplicitVersion && leftExplicitVersion !== rightExplicitVersion) return false;

  const leftKickoff = canonicalInstant(left.kickoffTime ?? left.kickoff);
  const rightKickoff = canonicalInstant(right.kickoffTime ?? right.kickoff);
  if (leftKickoff && rightKickoff && leftKickoff !== rightKickoff) return false;

  const leftAnchor = leftExplicitVersion || leftKickoff;
  const rightAnchor = rightExplicitVersion || rightKickoff;
  if (Boolean(leftAnchor) !== Boolean(rightAnchor)) return false;
  if (leftAnchor && rightAnchor && leftAnchor !== rightAnchor) return false;

  const home = comparableTeamIdentity(teamIdentity(left, "home"), teamIdentity(right, "home"));
  const away = comparableTeamIdentity(teamIdentity(left, "away"), teamIdentity(right, "away"));
  if ((home.comparable && !home.same) || (away.comparable && !away.same)) return false;

  // Exact provider event identity is sufficient when team identity surfaces are
  // incomparable (id on one row, display name on the other). Without provider
  // identity, require comparable home + away identities to avoid broad merges.
  if (leftKey && rightKey) return true;
  return home.comparable && home.same && away.comparable && away.same;
};

// reconcileFastResultGeneration destructures sameEvent at module load time, so
// install the compatibility comparator before loading that module. This keeps
// the change scoped to the legacy reconciliation lane instead of weakening the
// global lifecycle contract used by result admission and frozen predictions.
lifecycle.sameEvent = sameEventCompatible;

const {
  reconcileFastResultGeneration,
  reconcileFastResultGenerationPostgres,
} = require("./reconcileFastResultGeneration.cjs");

const main = async () => {
  const native = require("../server/storageMode.cjs").readStorageMode().postgresOnly;
  const result = native
    ? await reconcileFastResultGenerationPostgres()
    : reconcileFastResultGeneration();
  process.stdout.write(`${JSON.stringify({
    ...result,
    identityCompatibility: "representation-aware-team-identity-v1",
  }, null, 2)}\n`);
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message || String(error),
      errorCode: error.code || null,
      identityCompatibility: "representation-aware-team-identity-v1",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  comparableTeamIdentity,
  sameEventCompatible,
  teamIdentity,
};
