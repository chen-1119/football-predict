const assert = require("node:assert/strict");
const {
  AVAILABILITY,
  classifyEvidenceAvailability,
  dynamicEvidenceWeights,
} = require("./preMatchEvidenceAvailability.cjs");
const { buildQuality } = require("./syncPreMatchSignals.cjs");

let checks = 0;
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks += 1;
};
const ok = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};

const earlyCutoffMatch = {
  id: "early-cutoff",
  kickoffTime: "2026-09-01T20:00:00+08:00",
  buyEndTime: "2026-09-01 16:00",
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.1 },
};
const lateCutoffMatch = {
  ...earlyCutoffMatch,
  id: "late-cutoff",
  buyEndTime: "2026-09-01 19:30",
};

const earlyMissingLineup = classifyEvidenceAvailability({
  match: earlyCutoffMatch,
  available: false,
  releaseLeadMinutes: 75,
});
equal(
  earlyMissingLineup.availabilityState,
  AVAILABILITY.NOT_YET_PUBLISHABLE,
  "confirmed XI missing before its publication window is not a data gap",
);
equal(
  dynamicEvidenceWeights({ lineup: earlyMissingLineup }).lineup,
  0,
  "not-yet-publishable lineup carries zero formal quality weight",
);

const lateMissingLineup = classifyEvidenceAvailability({
  match: lateCutoffMatch,
  available: false,
  releaseLeadMinutes: 75,
});
equal(
  lateMissingLineup.availabilityState,
  AVAILABILITY.MISSING_OVERDUE,
  "lineup missing after its expected publication time is overdue",
);
equal(
  dynamicEvidenceWeights({ lineup: lateMissingLineup }).lineup,
  8,
  "overdue confirmed XI keeps its full evidence weight",
);

const projected = classifyEvidenceAvailability({
  match: lateCutoffMatch,
  evidence: {
    sourceObservedAt: "2026-09-01T10:00:00.000Z",
    usableForPreMatch: true,
  },
  available: true,
  verified: false,
  releaseLeadMinutes: 75,
});
equal(projected.availabilityState, AVAILABILITY.ESTIMATED_PRE_CUTOFF, "projected roster stays estimated");
equal(dynamicEvidenceWeights({ lineup: projected }).lineup, 2, "projected roster has only weak weight");

const confirmed = classifyEvidenceAvailability({
  match: lateCutoffMatch,
  evidence: {
    sourceObservedAt: "2026-09-01T11:00:00.000Z",
    usableForPreMatch: true,
  },
  available: true,
  verified: true,
  releaseLeadMinutes: 75,
});
equal(confirmed.availabilityState, AVAILABILITY.VERIFIED_PRE_CUTOFF, "confirmed pre-cutoff XI is verified");
equal(dynamicEvidenceWeights({ lineup: confirmed }).lineup, 8, "confirmed XI receives its full weight");

const postCutoff = classifyEvidenceAvailability({
  match: lateCutoffMatch,
  evidence: {
    sourceObservedAt: "2026-09-01T12:00:00.000Z",
    usableForPreMatch: false,
    observationPhase: "post-cutoff",
  },
  available: true,
  verified: true,
  releaseLeadMinutes: 75,
});
equal(postCutoff.availabilityState, AVAILABILITY.PUBLISHED_AFTER_CUTOFF, "post-cutoff XI is display-only");
equal(postCutoff.eligibleAtCutoff, false, "post-cutoff XI cannot enter formal evidence");

const qualityBeforeLineupWindow = buildQuality({
  match: earlyCutoffMatch,
  signal: {},
  teamHistory: { home: null, away: null },
});
equal(
  qualityBeforeLineupWindow.components.lineup.status,
  "not_yet_publishable",
  "quality layer exposes lineup publication timing",
);
equal(qualityBeforeLineupWindow.weights.lineup, 0, "quality layer removes unavailable-by-design lineup weight");
ok(
  !qualityBeforeLineupWindow.missing.some((item) => item.key === "lineup"),
  "unavailable-by-design lineup is excluded from missing evidence",
);
ok(
  qualityBeforeLineupWindow.notYetPublishable.some((item) => item.key === "lineup"),
  "unavailable-by-design lineup is reported separately",
);

const projectedQuality = buildQuality({
  match: lateCutoffMatch,
  signal: {
    sourceObservedAt: "2026-09-01T10:00:00.000Z",
    projectedRoster: {
      source: "500.com:projected-roster",
      evidenceType: "projected-roster",
      summary: { zh: "预计名单", en: "Projected roster" },
      usableForPreMatch: true,
      sourceObservedAt: "2026-09-01T10:00:00.000Z",
    },
  },
  teamHistory: { home: null, away: null },
});
equal(projectedQuality.components.lineup.status, "estimated", "500 projected roster is not called a confirmed lineup");
equal(projectedQuality.components.lineup.confirmed, false, "projected roster exposes confirmed=false");
equal(projectedQuality.weights.lineup, 2, "quality layer caps projected roster weight");

const postCutoffQuality = buildQuality({
  match: lateCutoffMatch,
  signal: {
    confirmedLineup: {
      source: "official-league",
      evidenceType: "confirmed-lineup",
      verified: true,
      summary: { zh: "官方首发", en: "Official XI" },
      usableForPreMatch: false,
      observationPhase: "post-cutoff",
      sourceObservedAt: "2026-09-01T12:00:00.000Z",
    },
  },
  teamHistory: { home: null, away: null },
});
equal(postCutoffQuality.components.lineup.status, "published_after_cutoff", "quality rejects post-cutoff confirmed XI");
ok(postCutoffQuality.postCutoffOnly.some((item) => item.key === "lineup"), "post-cutoff XI is reported as display-only");

console.log(`Pre-match evidence availability verification passed (${checks} checks).`);
