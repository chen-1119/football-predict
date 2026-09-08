"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const VERSION = "frontend-release-state-v1";
const STATE_FIELDS = Object.freeze([
  "version", "kind", "phase", "runtimeSha256", "runtimeSequence", "frontendSha256",
  "frontendSequence", "indexSha256", "distTreeHash", "acceptanceSha256",
]);
const PRODUCTION_PATHS = Object.freeze({
  rootState: "/var/lib/football-release/frontend-state.json",
  app: "/opt/football-predict",
  projection: "/opt/football-predict/.frontend-release-state.json",
  acceptance: "/opt/football-predict/.frontend-release-acceptance.json",
  runtimeMarker: "/opt/football-predict/.release-bundle-sha256",
  acceptedRuntimeMarker: "/opt/football-predict/.release-live-complete",
  index: "/opt/football-predict/dist/index.html",
});
const MAX_STATE_BYTES = 8192;
const MAX_RECEIPT_BYTES = 10 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = () => Object.freeze(Object.fromEntries([
  ...STATE_FIELDS.map(key => [key, key === "version" ? VERSION : null]),
  ["available", false], ["consistent", false],
]));

function validateFrontendReleaseState(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== STATE_FIELDS.length ||
      !STATE_FIELDS.every(key => Object.hasOwn(value, key))) throw new Error("frontend-state-fields");
  if (value.version !== VERSION || !["full", "frontend-only"].includes(value.kind) ||
      !["pending", "accepted"].includes(value.phase)) throw new Error("frontend-state-version-kind-phase");
  for (const key of ["runtimeSha256", "frontendSha256", "indexSha256", "distTreeHash"])
    if (typeof value[key] !== "string" || !HEX.test(value[key])) throw new Error("frontend-state-hash");
  for (const key of ["runtimeSequence", "frontendSequence"])
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error("frontend-state-sequence");
  if (value.phase === "pending" ? value.acceptanceSha256 !== null :
      typeof value.acceptanceSha256 !== "string" || !HEX.test(value.acceptanceSha256))
    throw new Error("frontend-state-acceptance");
  if (value.kind === "full" && (value.runtimeSha256 !== value.frontendSha256 ||
      value.runtimeSequence !== value.frontendSequence)) throw new Error("frontend-state-full-identity");
  if (value.kind === "frontend-only" && (value.frontendSequence <= value.runtimeSequence ||
      value.frontendSha256 === value.runtimeSha256)) throw new Error("frontend-state-ui-identity");
  return Object.freeze(Object.fromEntries(STATE_FIELDS.map(key => [key, value[key]])));
}

function parseFrontendReleaseState(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_STATE_BYTES)
    throw new Error("frontend-state-size");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  // This schema is flat. Tokenize complete scalar members as well as JSON.parse
  // so duplicate/escaped duplicate keys cannot be silently overwritten.
  const scalarMember = /\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|null|true|false)\s*/y;
  let cursor = text.search(/\S/) + 1;
  const seen = new Set();
  if (text[cursor - 1] !== "{") throw new Error("frontend-state-object");
  while (true) {
    scalarMember.lastIndex = cursor;
    const member = scalarMember.exec(text);
    if (!member) throw new Error("frontend-state-scalar-members");
    const key = JSON.parse(member[1]);
    if (seen.has(key)) throw new Error("frontend-state-duplicate-key");
    seen.add(key); cursor = scalarMember.lastIndex;
    if (text[cursor] === "}") {
      if (text.slice(cursor + 1).trim()) throw new Error("frontend-state-trailing-data");
      break;
    }
    if (text[cursor] !== ",") throw new Error("frontend-state-member-separator");
    cursor++;
  }
  return validateFrontendReleaseState(value);
}

function parseReceiptJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), parsed = JSON.parse(text);
  let cursor = 0;
  const scalar = /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|null|true|false/y;
  const whitespace = () => { while (/\s/.test(text[cursor] || "") && cursor < text.length) cursor++; };
  const value = depth => {
    whitespace(); if (depth > 4) throw new Error("frontend-receipt-depth");
    if (text[cursor] === "{") {
      cursor++; whitespace(); const seen = new Set();
      if (text[cursor] === "}") { cursor++; return; }
      for (;;) {
        whitespace(); scalar.lastIndex = cursor; const keyToken = scalar.exec(text);
        if (!keyToken || keyToken[0][0] !== '"') throw new Error("frontend-receipt-key");
        const key = JSON.parse(keyToken[0]); if (seen.has(key)) throw new Error("frontend-receipt-duplicate-key");
        seen.add(key); cursor = scalar.lastIndex; whitespace();
        if (text[cursor++] !== ":") throw new Error("frontend-receipt-colon"); value(depth + 1); whitespace();
        if (text[cursor] === "}") { cursor++; return; }
        if (text[cursor++] !== ",") throw new Error("frontend-receipt-separator");
      }
    }
    scalar.lastIndex = cursor; const token = scalar.exec(text);
    if (!token) throw new Error("frontend-receipt-scalar"); cursor = scalar.lastIndex;
  };
  value(0); whitespace(); if (cursor !== text.length) throw new Error("frontend-receipt-trailing"); return parsed;
}
function validateFrontendAcceptanceReceipt(bytes, stateInput) {
  const state = validateFrontendReleaseState(stateInput);
  if (state.phase !== "accepted" || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RECEIPT_BYTES ||
      sha256(bytes) !== state.acceptanceSha256) throw new Error("frontend-receipt-unbound");
  const receipt = parseReceiptJson(bytes);
  const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const same = keys => keys.every(key => receipt[key] === state[key]);
  const checkedAt = () => typeof receipt.checkedAt === "string" && Number.isFinite(Date.parse(receipt.checkedAt)) &&
    new Date(receipt.checkedAt).toISOString() === receipt.checkedAt;
  const checks = fields => exact(receipt.checks, fields) && fields.every(key => receipt.checks[key] === true);
  if (receipt?.version === "frontend-full-baseline-acceptance-v1") {
    if (state.kind !== "full" || !exact(receipt, ["version", "runtimeSha256", "runtimeSequence", "indexSha256", "distTreeHash", "checkedAt", "checks"]) ||
        !same(["runtimeSha256", "runtimeSequence", "indexSha256", "distTreeHash"]) || !checkedAt() ||
        !checks(["runtimeMarkers", "health", "sourceBaseline"])) throw new Error("frontend-full-receipt-contract");
  } else if (receipt?.version === "frontend-readonly-acceptance-v1") {
    if (state.kind !== "frontend-only" || !exact(receipt, ["version", "transactionId", "runtimeSha256", "runtimeSequence", "frontendSha256", "frontendSequence",
      "indexSha256", "distTreeHash", "authorizationSha256", "checkedAt", "checks"]) || !/^[a-f0-9]{24}$/.test(receipt.transactionId || "") ||
      !HEX.test(receipt.authorizationSha256 || "") || !same(["runtimeSha256", "runtimeSequence", "frontendSha256", "frontendSequence", "indexSha256", "distTreeHash"]) ||
      !checkedAt() || !checks(["index", "assets", "health", "protected", "services"])) throw new Error("frontend-ui-receipt-contract");
  } else if (receipt?.version === "frontend-rollback-acceptance-v1") {
    if (!exact(receipt, ["version", "transactionId", "authorizationSha256", "previousState", "indexSha256", "distTreeHash", "retainedAssetsSha256",
      "retainedAssetCount", "newFrontendAccepted"]) || !/^[a-f0-9]{24}$/.test(receipt.transactionId || "") ||
      !HEX.test(receipt.authorizationSha256 || "") || !HEX.test(receipt.retainedAssetsSha256 || "") ||
      !Number.isSafeInteger(receipt.retainedAssetCount) || receipt.retainedAssetCount < 0 || receipt.retainedAssetCount > 4096 ||
      receipt.newFrontendAccepted !== false || !same(["indexSha256", "distTreeHash"])) throw new Error("frontend-rollback-receipt-contract");
    const previous = validateFrontendReleaseState(receipt.previousState);
    if (previous.phase !== "accepted" || !STATE_FIELDS.filter(key => !["distTreeHash", "acceptanceSha256"].includes(key)).every(key => previous[key] === state[key]))
      throw new Error("frontend-rollback-identity-changed");
  } else throw new Error("frontend-receipt-version");
  return true;
}

function frontendIdentityMatchesCandidate(identity, candidate) {
  if (!candidate || !["full", "frontend-only"].includes(candidate.releaseKind) || !HEX.test(candidate.sha256 || "") ||
      !Number.isSafeInteger(candidate.releaseSequence) || candidate.releaseSequence < 1) return false;
  if (identity?.available !== true || identity.consistent !== true || identity.phase !== "accepted") return false;
  try { validateFrontendReleaseState(Object.fromEntries(STATE_FIELDS.map(key => [key, identity[key]]))); } catch { return false; }
  return candidate.releaseKind === "frontend-only" && identity.kind === "frontend-only" && identity.frontendSha256 === candidate.sha256 &&
    identity.frontendSequence === candidate.releaseSequence;
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid,
    stat.nlink, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}
function directoryIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String).join(":");
}
function assertDirectory(directory, policy) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(policy.ownerUid) ||
      (!policy.windowsFixture && (stat.mode & 0o7022n) !== 0n)) throw new Error("frontend-unsafe-directory");
  return { file: directory, identity: directoryIdentity(stat), directory: true };
}
function readChecked(file, maxBytes, policy) {
  const before = fs.lstatSync(file, { bigint: true });
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    stat.uid === BigInt(policy.ownerUid) && (stat.mode & 0o7777n) === (policy.windowsFixture ? 0o666n : 0o644n) &&
    stat.size > 0n && stat.size <= BigInt(maxBytes);
  if (!valid(before)) throw new Error("frontend-unsafe-file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fileIdentity(fs.fstatSync(fd, { bigint: true })) !== fileIdentity(before))
      throw new Error("frontend-file-open-race");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0, read;
    while (count < buffer.length && (read = fs.readSync(fd, buffer, count, buffer.length - count, count)) > 0) count += read;
    if (count !== Number(before.size) || fileIdentity(fs.fstatSync(fd, { bigint: true })) !== fileIdentity(before) ||
        fileIdentity(fs.lstatSync(file, { bigint: true })) !== fileIdentity(before)) throw new Error("frontend-file-read-race");
    return { bytes: buffer.subarray(0, count), file, identity: fileIdentity(before) };
  } finally { fs.closeSync(fd); }
}
function readAt(paths, policy) {
  let state = null;
  try {
    const observations = policy.directories.map(directory => assertDirectory(directory, policy));
    const projection = readChecked(paths.projection, MAX_STATE_BYTES, policy);
    observations.push(projection);
    state = parseFrontendReleaseState(projection.bytes);
    const marker = readChecked(paths.runtimeMarker, 65, policy);
    const acceptedMarker = readChecked(paths.acceptedRuntimeMarker, 65, policy);
    const index = readChecked(paths.index, MAX_INDEX_BYTES, policy);
    observations.push(marker, acceptedMarker, index);
    if (state.phase === "accepted") {
      const receipt = readChecked(paths.acceptance, MAX_RECEIPT_BYTES, policy); observations.push(receipt);
      validateFrontendAcceptanceReceipt(receipt.bytes, state);
    }
    const markerMatches = entry => entry.bytes.equals(Buffer.from(state.runtimeSha256 + "\n", "ascii")) ||
      entry.bytes.equals(Buffer.from(state.runtimeSha256, "ascii"));
    let consistent = markerMatches(marker) && markerMatches(acceptedMarker) && sha256(index.bytes) === state.indexSha256;
    for (const observation of observations) {
      const stat = fs.lstatSync(observation.file, { bigint: true });
      if ((observation.directory ? directoryIdentity(stat) : fileIdentity(stat)) !== observation.identity) consistent = false;
    }
    // The complete tree is committed by the exact validated root receipt, not
    // rescanned on every health request. The current index is freshly hashed.
    return Object.freeze({ ...state, available: true, consistent });
  } catch {
    // Never expose filesystem paths, private receipt contents or raw errors.
    return state ? Object.freeze({ ...state, available: true, consistent: false }) : failure();
  }
}

function readFrontendReleaseIdentity() {
  if (arguments.length) throw new TypeError("frontend-identity-production-paths-are-fixed");
  if (process.platform !== "linux") return failure();
  return readAt(PRODUCTION_PATHS, {
    ownerUid: 0, windowsFixture: false,
    directories: ["/", "/opt", PRODUCTION_PATHS.app, PRODUCTION_PATHS.app + "/dist"],
  });
}

// Remote status tools embed their own reviewed reader bytes. They never fetch
// executable policy from the mutable online APP in order to trust its answer.
function buildFrontendIdentityReaderSource() {
  const source = fs.readFileSync(__filename, "utf8");
  return "(()=>{const module={exports:{}};((module,require)=>{\n" + source + "\n})(module,require);return module.exports;})()";
}

// Isolated filesystem fixtures only: callers cannot redirect the production
// reader, set an owner exemption, or point this factory at an existing tree.
function createFrontendReleaseIdentityFixture() {
  if (arguments.length) throw new TypeError("frontend-identity-fixture-takes-no-paths");
  const temp = fs.realpathSync(os.tmpdir());
  for (const production of [PRODUCTION_PATHS.app, path.dirname(PRODUCTION_PATHS.rootState)]) {
    const resolved = path.resolve(production);
    if (temp === resolved || temp.startsWith(resolved + path.sep)) throw new Error("frontend-identity-unsafe-fixture-root");
  }
  const root = fs.mkdtempSync(path.join(temp, "football-frontend-identity-"));
  fs.chmodSync(root, 0o700);
  const app = path.join(root, "app");
  fs.mkdirSync(app, { mode: 0o755 }); fs.mkdirSync(path.join(app, "dist"), { mode: 0o755 });
  const paths = Object.freeze({ app, projection: path.join(app, ".frontend-release-state.json"),
    acceptance: path.join(app, ".frontend-release-acceptance.json"),
    runtimeMarker: path.join(app, ".release-bundle-sha256"), acceptedRuntimeMarker: path.join(app, ".release-live-complete"),
    index: path.join(app, "dist/index.html") });
  const rootIdentity = directoryIdentity(fs.lstatSync(root, { bigint: true }));
  const policy = { ownerUid: process.platform === "win32" ? 0 : process.getuid(), windowsFixture: process.platform === "win32",
    directories: [root, app, path.join(app, "dist")] };
  return Object.freeze({ root, paths, posixMetadataEnforced: !policy.windowsFixture,
    read() { return readAt(paths, policy); },
    dispose() {
      if (directoryIdentity(fs.lstatSync(root, { bigint: true })) !== rootIdentity || fs.realpathSync(root) !== root)
        throw new Error("frontend-identity-fixture-root-changed");
      fs.rmSync(root, { recursive: true, force: false });
    },
  });
}

module.exports = { VERSION, STATE_FIELDS, PRODUCTION_PATHS, MAX_STATE_BYTES, MAX_RECEIPT_BYTES, MAX_INDEX_BYTES,
  validateFrontendReleaseState, parseFrontendReleaseState, validateFrontendAcceptanceReceipt, frontendIdentityMatchesCandidate,
  readFrontendReleaseIdentity, buildFrontendIdentityReaderSource, createFrontendReleaseIdentityFixture };
