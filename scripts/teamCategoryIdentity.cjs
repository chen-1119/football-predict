"use strict";

// A negative identity guard, not a name matcher or an entity approval.
// Inspect original labels before alias normalization can erase squad markers.
const VERSION = "team-category-identity-v1";
const FIELDS = ["gender", "ageGroup", "squad"];
const profileFor = (names) => {
  const values = Object.fromEntries(FIELDS.map(key => [key, new Set()]));
  for (const value of names || []) {
    if (typeof value !== "string") continue;
    const text = value.normalize("NFKC").toLowerCase().trim();
    if (/\b(women(?:'s|s)?|woman|female|ladies)\b|女足|女子|女队|(?:\s|\()w\)?$/.test(text)) values.gender.add("female");
    if (/\b(men(?:'s|s)?|male)\b|男足|男子|男队/.test(text)) values.gender.add("male");
    const ages = [...text.matchAll(/(?:\bu\s*-?\s*|\bunder[ -]*)(\d{2})\b/g)].map(m => `u${m[1]}`);
    for (const age of ages) values.ageGroup.add(age);
    if (!ages.length && /\byouth\b|青年|少年/.test(text)) values.ageGroup.add("youth-unspecified");
    if (/\breserves?\b|预备队|二队|(?:^|[\s(])(?:ii|b)\)?$/.test(text)) values.squad.add("reserve");
  }
  // A general youth label can accompany a more precise translated age label.
  if (values.ageGroup.size > 1) values.ageGroup.delete("youth-unspecified");
  const ambiguous = FIELDS.filter(key => values[key].size > 1);
  return { ...Object.fromEntries(FIELDS.map(key => [key, values[key].size === 1 ? [...values[key]][0] : null])), ambiguous };
};
const rawSideNames = (match, side) => [match?.[`${side}TeamName`], match?.[`${side}TeamNameEn`], match?.[`${side}Team`]];

const fixtureTeamCategoryAudit = (match, providerNames) => {
  const blockers = [];
  const sides = {};
  for (const side of ["home", "away"]) {
    const local = profileFor(rawSideNames(match, side));
    const provider = profileFor([providerNames?.[side]]);
    sides[side] = { local, provider };
    for (const field of FIELDS) {
      if (local.ambiguous.includes(field) || provider.ambiguous.includes(field)) {
        blockers.push(`${side}-team-category-${field}-ambiguous`);
      } else if (local[field] !== provider[field]) {
        // Absence is unknown, never an implicit senior/men's identity.
        blockers.push(`${side}-team-category-${field}-${local[field] && provider[field] ? "conflict" : "unverified"}`);
      }
    }
  }
  return { version: VERSION, compatible: blockers.length === 0, blockers, sides,
    policy: "explicit-category-compatibility-only; absence-is-not-senior-or-male-proof" };
};

module.exports = { VERSION, profileFor, fixtureTeamCategoryAudit };
