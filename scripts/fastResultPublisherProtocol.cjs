"use strict";

const FAST_RESULT_PUBLISHER_PROTOCOL = "official-result-fast-publisher-v1";
const FAST_RESULT_PUBLISHER_MACHINE_ENV = "FAST_RESULT_PUBLISHER_MACHINE_MODE";
const VALID_PHASES = new Set([
  "official-result-fast-publication",
  "official-result-fast-published",
]);

const invalidOutput = (message, cause = null) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "PUBLISHER_OUTPUT_INVALID";
  return error;
};

const validateFastResultPublisherResult = (result) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw invalidOutput("fast result publisher protocol payload must be an object");
  }
  if (result.protocol !== FAST_RESULT_PUBLISHER_PROTOCOL) {
    throw invalidOutput("fast result publisher protocol version is missing or unsupported");
  }
  if (typeof result.ok !== "boolean" || typeof result.skipped !== "boolean") {
    throw invalidOutput("fast result publisher protocol requires boolean ok and skipped fields");
  }
  if (!VALID_PHASES.has(result.phase)) {
    throw invalidOutput("fast result publisher protocol phase is invalid");
  }
  if (!Number.isFinite(result.publishedRows) || result.publishedRows < 0) {
    throw invalidOutput("fast result publisher protocol publishedRows is invalid");
  }
  return result;
};

const encodeFastResultPublisherOutput = (result) => `${JSON.stringify({
  ...result,
  protocol: FAST_RESULT_PUBLISHER_PROTOCOL,
})}\n`;

const parseFastResultPublisherOutput = (stdout) => {
  const text = String(stdout || "").trim();
  if (!text) throw invalidOutput("fast result publisher protocol output is empty");
  let result;
  try {
    result = JSON.parse(text);
  } catch (cause) {
    throw invalidOutput("fast result publisher stdout is not one protocol JSON document", cause);
  }
  return validateFastResultPublisherResult(result);
};

module.exports = {
  FAST_RESULT_PUBLISHER_MACHINE_ENV,
  FAST_RESULT_PUBLISHER_PROTOCOL,
  encodeFastResultPublisherOutput,
  parseFastResultPublisherOutput,
  validateFastResultPublisherResult,
};
