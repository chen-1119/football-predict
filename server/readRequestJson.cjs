"use strict";

const { TextDecoder } = require("node:util");

// Decode the byte stream once, carrying incomplete UTF-8 characters between
// chunks. Buffer-to-string coercion on each chunk can silently change team names.
const readRequestJson = (req, maxBytes = 1024 * 1024) => new Promise((resolve, reject) => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let body = "", bytes = 0, settled = false;

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    body = "";
    req.removeListener("data", onData);
    req.removeListener("end", onEnd);
    req.removeListener("aborted", onAborted);
    req.removeListener("close", onClose);
    // Keep the error guard: destroy(error) emits asynchronously after rejection.
    if (error) reject(error);
    else resolve(value);
  };
  const failAndDestroy = (error) => {
    finish(error);
    req.destroy(error);
  };
  const abortedError = () => Object.assign(new Error("request body aborted"), {
    code: "REQUEST_BODY_ABORTED",
  });
  const onError = (error) => finish(error);
  const onAborted = () => finish(abortedError());
  const onClose = () => finish(abortedError());
  const onData = (chunk) => {
    if (settled) return;
    if (!(chunk instanceof Uint8Array)) {
      failAndDestroy(new Error("request body must be a byte stream"));
      return;
    }
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      failAndDestroy(new Error("request body too large"));
      return;
    }
    try { body += decoder.decode(chunk, { stream: true }); }
    catch { failAndDestroy(new Error("request body contains invalid UTF-8")); }
  };
  const onEnd = () => {
    if (settled) return;
    try { body += decoder.decode(); }
    catch {
      failAndDestroy(new Error("request body contains invalid UTF-8"));
      return;
    }
    // Preserve the existing empty-body and syntactically invalid JSON fallback.
    let value = {};
    if (body) { try { value = JSON.parse(body); } catch { /* existing fallback */ } }
    finish(null, value);
  };

  req.on("error", onError);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    failAndDestroy(new Error("invalid request body byte limit"));
    return;
  }
  if (req.aborted || req.destroyed) { finish(abortedError()); return; }
  req.on("data", onData);
  req.on("end", onEnd);
  req.on("aborted", onAborted);
  req.on("close", onClose);
});

module.exports = { readRequestJson };
