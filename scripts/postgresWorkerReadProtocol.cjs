"use strict";
const path = require("node:path");
const VERSION = "postgres-worker-read-v1";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => plain(value)
  && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
const clock = value => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const flag = step => ({ ok: step?.ok === true, skipped: step?.skipped === true });
function validateRequest(request) {
  if (!keys(request, ["version", "id", "action", "input"]) || request.version !== VERSION
    || !/^[a-f0-9]{32}$/.test(request.id) || !["observation", "counts"].includes(request.action)) throw Error("invalid native worker read request");
  const input = request.input, fields = ["storeDir", "publicDataDir"];
  if (request.action === "observation") fields.push("phase", "validationStep", "generationStep", "projectionStep");
  if (!keys(input, fields) || !fields.slice(0, 2).every(key => text(input[key]) && path.isAbsolute(input[key]) && !input[key].includes("\0"))) throw Error("invalid native worker read input");
  if (request.action === "observation" && (!(input.phase === null || text(input.phase))
    || !["validationStep", "generationStep", "projectionStep"].every(key => keys(input[key], ["ok", "skipped"])
      && typeof input[key].ok === "boolean" && typeof input[key].skipped === "boolean"))) throw Error("invalid native worker read steps");
  return request;
}
function createRequest(action, input, id) {
  const value = { storeDir: path.resolve(input.storeDir), publicDataDir: path.resolve(input.publicDataDir) };
  if (action === "observation") Object.assign(value, { phase: input.phase ?? null,
    validationStep: flag(input.validationStep), generationStep: flag(input.generationStep),
    projectionStep: flag(input.projectionStep === undefined ? input.sqliteStep : input.projectionStep) });
  return validateRequest({ version: VERSION, id, action, input: value });
}
const identity = value => plain(value) && value.mode === "active-generation"
  && ["generationId", "manifestHash", "sourceCycleId", "committedAt"].every(key => text(value[key]))
  && /^[a-f0-9]{64}$/.test(value.manifestHash) && clock(value.committedAt);
function validateResponse(response, request) {
  if (!keys(response, ["version", "id", "action", "result"]) || response.version !== VERSION
    || response.id !== request.id || response.action !== request.action) throw Error("invalid native worker read response");
  const r = response.result;
  if (request.action === "counts") {
    if (!keys(r, ["ok", "storage", "counts", "publicationIdentity"]) || r.ok !== true || r.storage !== "postgres"
      || !keys(r.counts, ["oddsSnapshots", "predictionSnapshots"])
      || !Object.values(r.counts).every(n => Number.isSafeInteger(n) && n >= 0) || !identity(r.publicationIdentity)) throw Error("invalid native worker counts");
  } else {
    const expected = ["phase", "storage", "observedAt", "public", "generation", "postgres", "validationReady", "generationReady", "projectionReady", "sameSourceCycle", "samePublicationIdentity", "publicationIdentityMismatches", "ready", "blockers"];
    if (!keys(r, expected) || r.phase !== request.input.phase || r.storage !== "postgres" || !clock(r.observedAt)
      || !["public", "generation", "postgres"].every(key => plain(r[key]))
      || !["validationReady", "generationReady", "projectionReady", "sameSourceCycle", "samePublicationIdentity", "ready"].every(key => typeof r[key] === "boolean")
      || !["publicationIdentityMismatches", "blockers"].every(key => Array.isArray(r[key]) && r[key].length <= 64 && r[key].every(text))
      || r.ready !== (r.blockers.length === 0)) throw Error("invalid native worker observation");
    for (const [ready, step] of [["validationReady", "validationStep"], ["generationReady", "generationStep"], ["projectionReady", "projectionStep"]]) {
      if (r[ready] !== (request.input[step].ok && !request.input[step].skipped)) throw Error("native worker step mismatch");
    }
    if (r.ready && (!identity(r.generation) || !identity(r.postgres) || r.postgres.readable !== true
      || !r.sameSourceCycle || !r.samePublicationIdentity || r.publicationIdentityMismatches.length
      || !["generationId", "manifestHash", "sourceCycleId", "committedAt"].every(key => r.generation[key] === r.postgres[key])
      || r.public.sourceCycleId !== r.generation.sourceCycleId)) throw Error("native worker publication mismatch");
  }
  return r;
}
function decode(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) throw Error("native worker read IPC limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
module.exports = { VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, createRequest, validateRequest, validateResponse, decode };
