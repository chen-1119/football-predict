"use strict";

// Only enumerated transport facts: never URLs, headers or arbitrary messages.
const SAFE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH",
  "EHOSTUNREACH", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_BODY_TOO_LARGE"]);
function providerFailure(error) {
  const seen = new Set(), codes = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
    seen.add(value);
    if (SAFE_CODES.has(value.code)) codes.add(value.code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) value.errors.slice(0, 8).forEach((item) => visit(item, depth + 1));
  }
  visit(error);
  const values = [...codes];
  const category = values.some((code) => ["ENOTFOUND", "EAI_AGAIN"].includes(code)) ? "dns"
    : values.some((code) => /CERT|TLS|SIGNATURE/.test(code)) ? "tls"
      : codes.has("ETIMEDOUT") ? "timeout"
        : values.length ? "transport" : "request";
  return { version: "provider-failure-v1", category, codes: values, accountState: "unknown" };
}
module.exports = { providerFailure };
