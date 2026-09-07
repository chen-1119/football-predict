"use strict";
const { createHash } = require("node:crypto");
const VERSION = "prediction-execution-clock-v1";
const SCOPE = "local calculation clock reads; not provider observation, publication time or source attestation";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let active = null;
function tick(operation) {
  if (!active) return Date.now();
  if (active.replay) {
    const event = active.replay[active.index++];
    if (!event || event.operation !== operation) throw new Error("prediction-clock-sequence-mismatch");
    return event.millis;
  }
  if (active.events.length >= 256) throw new Error("prediction-clock-event-limit");
  const millis = Date.now();
  active.events.push({ operation, millis });
  return millis;
}
const predictionNowMs = () => tick("millis");
const predictionNowIso = () => new Date(tick("iso")).toISOString();
function verifyPredictionClock(clock) {
  if (!clock || clock.version !== VERSION || clock.scope !== SCOPE || Object.keys(clock).length !== 5
    || clock.sourceVerified !== false || !Array.isArray(clock.events)
    || !clock.events.length || clock.events.length > 256) return false;
  if (clock.events.some(event => !event || !["iso", "millis"].includes(event.operation)
    || !Number.isSafeInteger(event.millis) || event.millis < 0 || event.millis > 8640000000000000
    || Object.keys(event).length !== 2)) return false;
  const { contentHash, ...body } = clock;
  return digest(body) === contentHash;
}
function executeWithPredictionClock(callback, replayClock) {
  if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") throw new Error("synchronous-prediction-required");
  if (active) {
    if (replayClock !== undefined) throw new Error("nested-clock-replay-rejected");
    const output = callback();
    if (output && typeof output.then === "function") throw new Error("synchronous-prediction-required");
    return output;
  }
  if (replayClock !== undefined && !verifyPredictionClock(replayClock)) throw new Error("invalid-prediction-clock");
  const context = { events: [], replay: replayClock ? structuredClone(replayClock.events) : null, index: 0 };
  active = context;
  try {
    const output = callback();
    if (output && typeof output.then === "function") throw new Error("synchronous-prediction-required");
    if (context.replay && context.index !== context.replay.length) throw new Error("unused-prediction-clock-events");
    if (!output?.probabilityModel) return output;
    const body = { version: VERSION, events: context.replay || context.events, sourceVerified: false,
      scope: SCOPE };
    return { ...output, probabilityModel: { ...output.probabilityModel, executionClock: { ...body, contentHash: digest(body) } } };
  } finally { active = null; }
}
module.exports = { predictionNowMs, predictionNowIso, executeWithPredictionClock, verifyPredictionClock };
