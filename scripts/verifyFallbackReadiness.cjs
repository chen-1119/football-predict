const { evaluateFallbackReadiness } = require("./fallbackReadiness.cjs");

const checks = [];
const push = (name, ok, details = {}) => checks.push({ name, ...details, ok: Boolean(ok) });

const shadowModelWithFreshFallback = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: true,
  fallbackDataFresh: true,
  fallbackWithinReliableWindow: true,
  recommendationReliable: false,
  fallbackAgeSeconds: 399,
  fallbackMaxAgeSeconds: 3600,
}, 600);
push("fresh fallback data is deployable while the formal model remains shadow",
  shadowModelWithFreshFallback.ok === true
    && shadowModelWithFreshFallback.fallbackReliable === true
    && shadowModelWithFreshFallback.formalRecommendationReliable === false,
  shadowModelWithFreshFallback);

const staleFallbackWithPromotedModel = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: true,
  fallbackDataFresh: false,
  fallbackWithinReliableWindow: true,
  recommendationReliable: true,
  fallbackAgeSeconds: 399,
  fallbackMaxAgeSeconds: 3600,
}, 600);
push("formal model promotion cannot make stale fallback data deployable",
  staleFallbackWithPromotedModel.ok === false
    && staleFallbackWithPromotedModel.fallbackReliable === false
    && staleFallbackWithPromotedModel.formalRecommendationReliable === true,
  staleFallbackWithPromotedModel);

const outsideReliableWindow = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: true,
  fallbackDataFresh: true,
  fallbackWithinReliableWindow: false,
  fallbackAgeSeconds: 3601,
  fallbackMaxAgeSeconds: 3600,
}, 600);
push("fallback outside its reliable window fails closed",
  outsideReliableWindow.ok === false && outsideReliableWindow.fallbackRunwaySeconds === 0,
  outsideReliableWindow);

const insufficientRunway = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: true,
  fallbackDataFresh: true,
  fallbackWithinReliableWindow: true,
  fallbackAgeSeconds: 3201,
  fallbackMaxAgeSeconds: 3600,
}, 600);
push("fresh fallback with insufficient runway still fails closed",
  insufficientRunway.ok === false && insufficientRunway.fallbackRunwaySeconds === 399,
  insufficientRunway);

const primaryMode = evaluateFallbackReadiness({
  servingMode: "primary",
  fallbackDataFresh: false,
  fallbackWithinReliableWindow: false,
  recommendationReliable: false,
}, 600);
push("primary mode does not require fallback runway",
  primaryMode.ok === true && primaryMode.fallbackActive === false,
  primaryMode);

const missingFallbackClock = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: true,
  fallbackDataFresh: true,
  fallbackWithinReliableWindow: true,
  fallbackAgeSeconds: null,
  fallbackMaxAgeSeconds: "",
}, 0);
push("fallback with missing age clocks fails closed even when minimum runway is zero",
  missingFallbackClock.ok === false
    && missingFallbackClock.fallbackAgeSeconds === null
    && missingFallbackClock.fallbackMaxAgeSeconds === null
    && missingFallbackClock.fallbackRunwaySeconds === null,
  missingFallbackClock);

const unhealthySourceWithFreshFallback = evaluateFallbackReadiness({
  servingMode: "fallback-degraded",
  sourceHealthOk: false,
  fallbackDataFresh: true,
  fallbackWithinReliableWindow: true,
  fallbackAgeSeconds: 399,
  fallbackMaxAgeSeconds: 3600,
}, 600);
push("unhealthy source state cannot be hidden by fresh supplemental timestamps",
  unhealthySourceWithFreshFallback.ok === false
    && unhealthySourceWithFreshFallback.fallbackReliable === false,
  unhealthySourceWithFreshFallback);

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  verifier: "fallback-readiness",
  assertions: checks.length,
  checks,
}, null, 2));
if (!ok) process.exit(1);
