"use strict";
const crypto = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const POLICY = Object.freeze({ version: "form-recency-input-shadow-v1", maximumAgeDays: 240, recentWindowDays: 60,
  clock: "explicit-evaluation-clock-not-kickoff", missingClock: "exclude-source", futureClock: "exclude-source",
  sources: Object.freeze(["training-history", "500-recent-form"]), productionEligible: false, nominationAllowed: false });
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const POLICY_HASH = digest(POLICY);
function assessFormRecency(form, evaluatedAt) {
  if (!strictInstant(evaluatedAt)) throw new Error("strict shadow evaluation clock required");
  if (!form) return { status: "missing", usable: false, ageDays: [null, null], blockers: ["form-missing"] };
  const decisionMs = Date.parse(evaluatedAt);
  const sides = ["home", "away"].map(side => {
    const value = form?.[side]?.lastMatchAt;
    if (!strictInstant(value)) return { ageDays: null, blocker: `${side}-last-match-clock-missing-or-invalid` };
    const age = (decisionMs - Date.parse(value)) / 86400000;
    return { ageDays: age >= 0 ? age : null,
      blocker: age < 0 ? `${side}-last-match-after-evaluation` : age > POLICY.maximumAgeDays ? `${side}-form-older-than-${POLICY.maximumAgeDays}-days` : null };
  });
  const blockers = sides.map(side => side.blocker).filter(Boolean);
  return { status: blockers.length ? "excluded" : sides.some(side => side.ageDays > POLICY.recentWindowDays) ? "aged-history" : "recent",
    usable: blockers.length === 0, ageDays: sides.map(side => side.ageDays), blockers };
}
function buildFormRecencyShadowInput(match, evaluatedAt) {
  if (!match || typeof match !== "object" || Array.isArray(match)) throw new Error("shadow match object required");
  const input = JSON.parse(JSON.stringify(match));
  const sourceInputs = { "training-history": match.formSnapshot, "500-recent-form": match.externalSignals?.fiveHundred?.recentForm };
  const assessments = Object.fromEntries(POLICY.sources.map(source => [source, assessFormRecency(sourceInputs[source], evaluatedAt)]));
  const removedSources = POLICY.sources.filter(source => sourceInputs[source] && !assessments[source].usable);
  if (removedSources.includes("training-history")) delete input.formSnapshot;
  if (removedSources.includes("500-recent-form")) delete input.externalSignals.fiveHundred.recentForm;
  return { input, audit: { version: POLICY.version, policyHash: POLICY_HASH, evaluatedAt, assessments, removedSources,
    productionEligible: false, nominationAllowed: false, sourceVerified: false,
    scope: "input-removal-shadow-only; remaining history is not certified as recent or independently observed" } };
}
module.exports = { POLICY, POLICY_HASH, assessFormRecency, buildFormRecencyShadowInput };
