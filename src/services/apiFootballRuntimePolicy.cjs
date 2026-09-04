"use strict";

const API_FOOTBALL_SHADOW_MODE = "shadow-enrichment";

const configuredKeyFor = (env = {}) => String(
  env.API_FOOTBALL_KEY || env.APISPORTS_KEY || "",
).trim();

const apiFootballRuntimePolicyFor = (env = {}) => {
  const rawSwitch = env.ENABLE_API_FOOTBALL_SYNC;
  const requested = rawSwitch === "1";
  const mode = String(env.API_FOOTBALL_SYNC_MODE || API_FOOTBALL_SHADOW_MODE);
  const modeSupported = mode === API_FOOTBALL_SHADOW_MODE;
  const configured = Boolean(configuredKeyFor(env));
  const enabled = requested && modeSupported && configured;
  const status = rawSwitch === undefined || rawSwitch === "" || rawSwitch === "0"
    ? "disabled"
    : !requested
      ? "disabled-invalid-switch"
      : !modeSupported
        ? "disabled-unsupported-mode"
        : !configured
          ? "enabled-key-missing"
          : API_FOOTBALL_SHADOW_MODE;

  return {
    requested,
    configured,
    enabled,
    status,
    mode,
    modeSupported,
    shadowOnly: true,
    features: {
      injuries: env.API_FOOTBALL_INJURIES_ENABLED !== "0",
      lineups: env.API_FOOTBALL_LINEUPS_ENABLED !== "0",
      liveScore: env.API_FOOTBALL_LIVE_SCORE_ENABLED !== "0",
      // Third-party odds are a namespaced analysis/display signal only. They
      // never become a generic HAD quote or official Sporttery evidence.
      odds: env.API_FOOTBALL_ODDS_ENABLED === "1",
    },
    authority: {
      officialFixtureIdentity: false,
      officialOdds: false,
      officialResult: false,
      settlement: false,
      formalRecommendation: false,
    },
  };
};

module.exports = {
  API_FOOTBALL_SHADOW_MODE,
  apiFootballRuntimePolicyFor,
  configuredKeyFor,
};
