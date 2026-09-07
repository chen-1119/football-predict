"use strict";
const { createHash } = require("node:crypto");
const FIELDS = Object.freeze(["leagueName", "leagueNameEn", "leagueShortName", "countryName", "countryNameEn"]);
function competitionProfile(match) {
  // Team names are identities, not evidence of competition type. In particular,
  // 国际米兰 and Internacional must never select national/friendly model weights.
  const input = Object.fromEntries(FIELDS.map(key => [key, typeof match?.[key] === "string" ? match[key] : null]));
  const text = Object.values(input).filter(Boolean).join(" ");
  return {
      isInternational: /(国际|友谊|世界杯|世预|国家|international|friendly|world cup|qualifier|fifa)/i.test(text),
      isJapan: /(日职|日联|日本|j1|j2|japan)/i.test(text),
  };
}
function competitionModelContext(match) {
  const input = Object.fromEntries(FIELDS.map(key => [key, typeof match?.[key] === "string" ? match[key] : null]));
  const body = { version: "competition-model-context-v1", input, profile: competitionProfile(input),
    sourceVerified: false, scope: "competition-metadata-only; not independently verified event classification" };
  return { ...body, contentHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
module.exports = { FIELDS, competitionProfile, competitionModelContext };
