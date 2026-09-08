"use strict";

// Source authorization only: no source extraction, child execution, install,
// local build, deployment or provider connection occurs here.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { Readable } = require("node:stream"), { TextDecoder } = require("node:util");
const signing = require("./releaseSigning.cjs");
const { LIMITS, FRONTEND_PATHS, validateInventory } = require("./releaseChangeClassification.cjs");
const { createTarInventoryParser, captureReleaseArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");
const { VERSION: AUTH_VERSION, RUNTIME_FIELDS, POLICY_FIELDS, validateFrontendAuthorization, compareAuthorizedFrontendSources } = require("./frontendReleaseAuthorization.cjs");
const { parseFrontendReleaseState } = require("../server/frontendReleaseIdentity.cjs");
const { RELEASE_BUNDLE_POLICY_VERSION, findSensitiveReleaseEntries } = require("./releaseBundlePolicy.cjs");
const VERSION = "frontend-source-bundle-v1", RUNTIME_VERSION = "frontend-runtime-binding-v1";
const MAX_ARCHIVE = 512 * 1024 ** 2, MAX_TAR = LIMITS.totalBytes + LIMITS.entries * 1024;
const MAX_UI_FILE = 16 * 1024 ** 2, MAX_UI_TOTAL = 64 * 1024 ** 2, MAX_OPERATION_MS = 120000;
const utf8 = new TextDecoder("utf-8", { fatal: true }), HASH = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(JSON.stringify(value));
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const stamp = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
const identity = s => [s.dev, s.ino, s.mode, s.uid, s.gid].map(String).join(":");
const stat = p => fs.lstatSync(p, { bigint: true });
function requireThat(value, message) { if (!value) throw new Error(message); }
function exists(p) { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
function assertPlainDirectories(directory) {
  const rows = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const s = stat(current); requireThat(s.isDirectory() && !s.isSymbolicLink(), "frontend-nonplain-directory");
    rows.push({ path: current, identity: identity(s) }); if (path.dirname(current) === current) return rows;
  }
}
function checkDirectories(rows) { for (const row of rows) requireThat(identity(stat(row.path)) === row.identity, "frontend-directory-drift"); }
function readStable(file, maximum, observations = [], allowEmpty = false) {
  const absolute = path.resolve(file), directories = assertPlainDirectories(path.dirname(absolute)), before = stat(absolute);
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maximum)
    && before.size >= BigInt(allowEmpty ? 0 : 1), "frontend-nonplain-or-oversized-input");
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    requireThat(stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before), "frontend-input-open-race");
    let offset = 0, n;
    while (offset < bytes.length && (n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset))) offset += n;
    requireThat(offset === Number(before.size) && stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before)
      && stamp(stat(absolute)) === stamp(before), "frontend-input-read-race");
    checkDirectories(directories);
    observations.push({ path: absolute, stamp: stamp(before), directories });
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function unchanged(observations) {
  for (const row of observations) { requireThat(stamp(stat(row.path)) === row.stamp, "frontend-input-drift"); checkDirectories(row.directories); }
}
// Reject duplicate keys before returning the standard JSON value, including
// escaped aliases inside the two nested runtime binding objects.
function parseJson(bytes) {
  const text = utf8.decode(bytes), parsed = JSON.parse(text); let cursor = 0, nodes = 0;
  const space = () => { while (cursor < text.length && /\s/.test(text[cursor])) cursor++; };
  const string = () => { const m = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(cursor)); requireThat(m, "frontend-json-string"); cursor += m[0].length; return JSON.parse(m[0]); };
  function value(depth) {
    requireThat(depth <= 32 && ++nodes <= 200000, "frontend-json-budget"); space();
    if (text[cursor] === "{") {
      cursor++; space(); const seen = new Set(); if (text[cursor] === "}") { cursor++; return; }
      while (true) {
        space(); const key = string(); requireThat(!seen.has(key), "frontend-json-duplicate-key"); seen.add(key); space();
        requireThat(text[cursor++] === ":", "frontend-json-colon"); value(depth + 1); space();
        const next = text[cursor++]; if (next === "}") return; requireThat(next === ",", "frontend-json-separator");
      }
    }
    if (text[cursor] === "[") {
      cursor++; space(); if (text[cursor] === "]") { cursor++; return; }
      while (true) { value(depth + 1); space(); const next = text[cursor++]; if (next === "]") return; requireThat(next === ",", "frontend-json-separator"); }
    }
    if (text[cursor] === '"') { string(); return; }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(cursor));
    requireThat(m, "frontend-json-value"); cursor += m[0].length;
  }
  value(0); space(); requireThat(cursor === text.length, "frontend-json-trailing-data"); return parsed;
}
function validateRuntimeBinding(value, state, baseline) {
  requireThat(exact(value, ["version", "runtimeSha256", "runtimeSequence", "inventorySha256", "runtime", "policies"])
    && value.version === RUNTIME_VERSION && exact(value.runtime, RUNTIME_FIELDS) && exact(value.policies, POLICY_FIELDS), "frontend-runtime-fields");
  requireThat(value.runtimeSha256 === state.runtimeSha256 && value.runtimeSha256 === baseline.sha256
    && value.runtimeSequence === state.runtimeSequence && value.runtimeSequence === baseline.releaseSequence
    && value.inventorySha256 === baseline.archiveSourceEvidence.inventorySha256, "frontend-runtime-baseline-mismatch");
  requireThat(value.runtime.nodeVersion === "v22.22.1"
    && RUNTIME_FIELDS.filter(k => k !== "nodeVersion").every(k => HASH.test(value.runtime[k] || ""))
    && POLICY_FIELDS.every(k => HASH.test(value.policies[k] || "")), "frontend-runtime-policy-binding");
  const lock = baseline.archiveSourceEvidence.inventory.entries.find(row => row.path === "package-lock.json");
  requireThat(lock?.kind === "file" && lock.sha256 === value.runtime.dependencyLockSha256, "frontend-runtime-lock-mismatch");
  return value;
}
function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeAll(fd, bytes) { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); }
function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(length); let count = 0;
  while (count < length) { const n = fs.readSync(fd, buffer, count, length - count, offset + count); requireThat(n, "frontend-spool-short-read"); count += n; }
  return buffer;
}
// One inert tar byte spool, not an extracted application/source tree.
async function spoolArchive(bundle, destination, expected, deadline) {
  const before = stat(bundle); requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size > 0n && before.size <= BigInt(MAX_ARCHIVE), "frontend-archive-size-or-type");
  const input = await fs.promises.open(bundle, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let fd, source, gunzip, sourceClosed, gunzipClosed, timer, expanded = 0, compressed = 0;
  const parser = createTarInventoryParser(), compressedHash = crypto.createHash("sha256");
  try {
    fd = fs.openSync(destination, "wx", 0o600);
    requireThat(stamp(await input.stat({ bigint: true })) === stamp(before), "frontend-archive-open-race");
    source = input.createReadStream({ autoClose: false, start: 0, end: Number(before.size) - 1, highWaterMark: 65536 });
    gunzip = zlib.createGunzip({ chunkSize: 65536 });
    sourceClosed = new Promise(resolve => source.once("close", resolve)); gunzipClosed = new Promise(resolve => gunzip.once("close", resolve));
    source.on("data", b => { compressedHash.update(b); compressed += b.length; });
    source.on("error", e => gunzip.destroy(e));
    timer = setTimeout(() => { source.destroy(new Error("frontend-archive-timeout")); gunzip.destroy(new Error("frontend-archive-timeout")); }, Math.max(1, deadline - Date.now()));
    source.pipe(gunzip);
    for await (const chunk of gunzip) {
      expanded += chunk.length; requireThat(expanded <= MAX_TAR && Date.now() < deadline, "frontend-spool-budget"); parser.write(chunk); writeAll(fd, chunk);
    }
    const inventory = parser.finish();
    requireThat(compressed === Number(before.size) && compressed === expected.archiveBytes && compressedHash.digest("hex") === expected.archiveSha256
      && JSON.stringify(inventory) === JSON.stringify(expected.inventory), "frontend-authenticated-archive-mismatch");
    requireThat(stamp(await input.stat({ bigint: true })) === stamp(before) && stamp(stat(bundle)) === stamp(before), "frontend-archive-read-drift");
    fs.fsyncSync(fd); return expanded;
  } finally {
    clearTimeout(timer); source?.destroy(); gunzip?.destroy(); await Promise.all([sourceClosed, gunzipClosed]); await input.close(); if (fd !== undefined) fs.closeSync(fd);
  }
}
function indexAuthenticatedSpool(fd, size, inventory) {
  const rows = new Map(inventory.entries.map(row => [row.path, row])), found = new Map();
  let offset = 0, local = {}, global = {}, longName = null;
  const octal = b => parseInt(b.toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
  const text = b => utf8.decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
  while (offset + 512 <= size) {
    const header = readAt(fd, offset, 512); offset += 512; if (header.every(b => b === 0)) break;
    const type = String.fromCharCode(header[156] || 48); let length = octal(header.subarray(124, 136));
    let name = text(header.subarray(0, 100));
    if (header.subarray(257, 263).toString("ascii") === "ustar\0") name = [text(header.subarray(345, 500)), name].filter(Boolean).join("/");
    if (["x", "g", "L"].includes(type)) {
      requireThat(length > 0 && length <= 65536 && offset + length <= size, "frontend-spool-metadata-budget");
      const bytes = readAt(fd, offset, length);
      if (type === "L") longName = text(bytes);
      else {
        const fields = {}; let at = 0;
        while (at < bytes.length) {
          const space = bytes.indexOf(32, at), count = Number(bytes.subarray(at, space).toString("ascii"));
          requireThat(space > at && Number.isSafeInteger(count) && count > space - at && at + count <= bytes.length, "frontend-spool-pax");
          const record = utf8.decode(bytes.subarray(space + 1, at + count - 1)), equals = record.indexOf("=");
          fields[record.slice(0, equals)] = record.slice(equals + 1); at += count;
        }
        if (type === "g") global = { ...global, ...fields }; else local = fields;
      }
    } else {
      const pax = { ...global, ...local }; name = longName ?? pax.path ?? name; if (Object.hasOwn(pax, "size")) length = Number(pax.size);
      name = name.replace(/^\.\//, ""); if (type === "5") name = name.replace(/\/$/, "");
      const row = rows.get(name); requireThat(row && !found.has(name) && row.kind === (type === "5" ? "directory" : "file")
        && row.mode === octal(header.subarray(100, 108)) && length === (row.bytes || 0), "frontend-spool-member-mismatch");
      found.set(name, { row, offset }); local = {}; longName = null;
    }
    requireThat(Number.isSafeInteger(length) && length >= 0 && offset + length <= size, "frontend-spool-payload-budget");
    offset += length + (512 - length % 512) % 512;
  }
  requireThat(found.size === rows.size, "frontend-spool-incomplete-membership"); return found;
}
function ustarHeader(row) {
  const header = Buffer.alloc(512), relative = row.path; let name = relative, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const splits = [...relative.matchAll(/\//g)].map(m => m.index).reverse();
    const split = splits.find(n => Buffer.byteLength(relative.slice(0, n)) <= 155 && Buffer.byteLength(relative.slice(n + 1)) <= 100);
    requireThat(split !== undefined, "frontend-path-exceeds-ustar-capacity"); prefix = relative.slice(0, split); name = relative.slice(split + 1);
  }
  header.write(name, 0, 100, "utf8"); header.write(prefix, 345, 155, "utf8");
  const number = (n, start, length) => { const raw = n.toString(8); requireThat(raw.length < length, "frontend-ustar-number-overflow"); header.write(raw.padStart(length - 1, "0") + "\0", start, length, "ascii"); };
  number(row.mode, 100, 8); number(0, 108, 8); number(0, 116, 8); number(row.bytes || 0, 124, 12); number(0, 136, 12);
  header.fill(32, 148, 156); header[156] = row.kind === "directory" ? 53 : 48; header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
  const checksum = header.reduce((a, b) => a + b, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii"); return header;
}
async function writeCandidateArchive(destination, inventory, contents, deadline) {
  validateInventory(inventory); for (const row of inventory.entries) ustarHeader(row);
  async function* chunks() {
    for (const row of inventory.entries) {
      requireThat(Date.now() < deadline, "frontend-writer-timeout"); yield ustarHeader(row);
      if (row.kind === "file") {
        const h = crypto.createHash("sha256"); let bytes = 0;
        for await (const chunk of contents(row)) { bytes += chunk.length; requireThat(bytes <= row.bytes, "frontend-writer-payload-growth"); h.update(chunk); yield chunk; }
        requireThat(bytes === row.bytes && h.digest("hex") === row.sha256, "frontend-writer-payload-mismatch");
        if (bytes % 512) yield Buffer.alloc(512 - bytes % 512);
      }
    }
    yield Buffer.alloc(1024);
  }
  const fd = fs.openSync(destination, "wx", 0o600), input = Readable.from(chunks()), gzip = zlib.createGzip({ level: 6 });
  const closed = new Promise(resolve => gzip.once("close", resolve)); let written = 0;
  input.on("error", e => gzip.destroy(e)); input.pipe(gzip);
  const timer = setTimeout(() => { input.destroy(new Error("frontend-writer-timeout")); gzip.destroy(new Error("frontend-writer-timeout")); }, Math.max(1, deadline - Date.now()));
  try { for await (const chunk of gzip) { written += chunk.length; requireThat(written <= MAX_ARCHIVE, "frontend-compressed-output-budget"); writeAll(fd, chunk); } fs.fsyncSync(fd); }
  finally { clearTimeout(timer); input.destroy(); gzip.destroy(); await closed; fs.closeSync(fd); }
}
function deriveInventory(entries) {
  const body = { version: "complete-release-tree-v1", entries, entryCount: entries.length,
    fileCount: entries.filter(row => row.kind === "file").length, totalBytes: entries.reduce((n, row) => n + (row.bytes || 0), 0) };
  return validateInventory({ ...body, treeHash: digest(body) });
}
function validateBaselineArtifacts(manifest, readMember) {
  const rows = manifest.archiveSourceEvidence.inventory.entries, find = name => rows.find(row => row.path === name && row.kind === "file");
  for (const [key, entry] of [["modelEvaluationArtifact", "public/data/model-evaluation.json"], ["historicalTrainingArtifact", ".release-model-assets/historical-training-index.json"]]) {
    const metadata = manifest[key], row = find(entry);
    requireThat(metadata?.ok === true && metadata.entry === entry && row && metadata.sha256 === row.sha256
      && (key !== "historicalTrainingArtifact" || metadata.bytes === row.bytes && metadata.sourceMatchesBundle === true), "frontend-baseline-model-metadata");
  }
  const files = rows.filter(row => row.kind === "file" && row.path.startsWith("dist/")).map(row => ({ path: row.path.slice(5), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const body = { version: "release-prebuilt-dist-v1", files, fileCount: files.length, totalBytes: files.reduce((n, row) => n + row.bytes, 0) };
  requireThat(files.some(row => row.path === "index.html") && files.length <= 4096 && body.totalBytes > 0 && body.totalBytes <= 128 * 1024 ** 2, "frontend-baseline-dist-budget");
  const dist = { ...body, treeHash: digest(body) }, entry = ".release-prebuilt/dist-manifest.json";
  requireThat(JSON.stringify(parseJson(readMember(entry, 1024 ** 2))) === JSON.stringify(dist)
    && JSON.stringify(manifest.prebuiltDistArtifact) === JSON.stringify({ ok: true, entry, version: body.version, treeHash: dist.treeHash, fileCount: body.fileCount, totalBytes: body.totalBytes }), "frontend-baseline-prebuilt-metadata");
  return dist;
}
function validateBaseline(manifest, config, keyId) {
  signing.validateReleaseManifestV3(manifest, { enforceFreshness: false }); validateFrontendAuthorization(manifest);
  requireThat(manifest.ok === true && (manifest.releaseKind ?? "full") === "full" && (manifest.executionMode ?? "full") === "full"
    && manifest.archiveSourceEvidence && manifest.policyVersion === RELEASE_BUNDLE_POLICY_VERSION
    && manifest.site === config.site && manifest.channel === config.channel && manifest.signature?.algorithm === signing.RELEASE_SIGNATURE_ALGORITHM
    && manifest.signature.keyId === keyId && manifest.signature.format === "detached-binary", "frontend-authenticated-full-baseline-required");
  for (const name of ["releaseActions", "releaseActionEntries", "blockedEntries", "sensitiveEntries", "missingEntries"])
    requireThat(Array.isArray(manifest[name]) && manifest[name].length === 0, "frontend-baseline-actions-or-blockers");
  const paths = manifest.archiveSourceEvidence.inventory.entries.map(row => row.path);
  requireThat(!findSensitiveReleaseEntries(paths).length && !paths.some(p => /^(?:\.git|\.codex|\.codex-tmp|node_modules|outputs|artifacts|server-data|\.release-actions)(?:\/|$)/.test(p)
    || p === "public/data/gpt-predictions.json"), "frontend-forbidden-baseline-members");
}

async function createFrontendReleaseBundle(options = {}) {
  requireThat(options && Object.getPrototypeOf(options) === Object.prototype
    && Object.keys(options).every(key => ["workspaceRoot", "env", "now"].includes(key)), "frontend-unknown-builder-option");
  const { workspaceRoot = path.resolve(__dirname, ".."), env = process.env, now = new Date() } = options;
  requireThat(process.version === "v22.22.1", "frontend-fixed-node-version-required");
  requireThat(env.RELEASE_KIND === "frontend-only", "frontend-only-release-kind-required");
  requireThat(!Object.keys(env).some(k => k.startsWith("RELEASE_TLS_") && env[k]), "frontend-tls-action-forbidden");
  const root = path.resolve(workspaceRoot), rootDirectories = assertPlainDirectories(root), observations = [], startedAt = Date.now(), deadline = startedAt + MAX_OPERATION_MS;
  const required = name => { requireThat(typeof env[name] === "string" && env[name].trim() === env[name] && env[name].length > 0, "frontend-required-env-" + name); return path.resolve(env[name]); };
  const bundle = required("RELEASE_FRONTEND_BASELINE_BUNDLE"), statePath = required("RELEASE_FRONTEND_STATE_PATH"), runtimePath = required("RELEASE_FRONTEND_RUNTIME_PATH");
  const config = signing.resolveReleaseManifestConfig({ env, now });
  const publicPath = path.resolve(env.RELEASE_SIGNING_PUBLIC_KEY || signing.DEFAULT_RELEASE_SIGNING_PUBLIC_KEY);
  const keyBytes = readStable(publicPath, 16384, observations);
  requireThat(/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(utf8.decode(keyBytes)), "frontend-public-only-key-required");
  const publicKey = crypto.createPublicKey(keyBytes);
  requireThat(publicKey.asymmetricKeyType === "rsa" && publicKey.asymmetricKeyDetails.modulusLength >= 3072
    && publicKey.asymmetricKeyDetails.modulusLength <= 8192, "frontend-trusted-rsa-key-required");
  const keyId = signing.publicKeyId(publicKey), manifestBytes = readStable(bundle + ".manifest.json", 1024 ** 2, observations), signature = readStable(bundle + ".manifest.sig", 16384, observations);
  requireThat(signing.verifyManifestBytes(manifestBytes, signature, publicKey), "frontend-baseline-signature-invalid");
  const baseline = parseJson(manifestBytes); validateBaseline(baseline, config, keyId);
  const stateBytes = readStable(statePath, 8192, observations), state = parseFrontendReleaseState(stateBytes);
  requireThat(state.phase === "accepted" && state.runtimeSha256 === baseline.sha256 && state.runtimeSequence === baseline.releaseSequence, "frontend-state-baseline-not-accepted");
  const runtime = validateRuntimeBinding(parseJson(readStable(runtimePath, 16384, observations)), state, baseline);
  const sourceInventory = baseline.archiveSourceEvidence.inventory, originalRows = new Map(sourceInventory.entries.map(row => [row.path, row]));
  const overlays = new Map(); let uiBytes = 0;
  for (const name of FRONTEND_PATHS) {
    const before = originalRows.get(name), file = path.join(root, name), present = exists(file);
    requireThat(Boolean(before) === present, "frontend-new-or-deleted-ui-path"); if (!before) continue;
    requireThat(before.kind === "file", "frontend-ui-member-type");
    const bytes = readStable(file, MAX_UI_FILE, observations, true); uiBytes += bytes.length; requireThat(uiBytes <= MAX_UI_TOTAL, "frontend-overlay-byte-budget");
    if (process.platform !== "win32") requireThat(Number(stat(file).mode & 0o777n) === before.mode, "frontend-workspace-ui-mode-change");
    if (bytes.length !== before.bytes || hash(bytes) !== before.sha256) overlays.set(name, bytes);
  }
  requireThat(overlays.size, "frontend-no-source-changes");
  const changedPaths = [...overlays.keys()].sort(), rows = sourceInventory.entries.map(row => overlays.has(row.path)
    ? { ...row, bytes: overlays.get(row.path).length, sha256: hash(overlays.get(row.path)) } : { ...row });
  const candidateInventory = deriveInventory(rows); for (const row of rows) ustarHeader(row);
  const requested = env.RELEASE_SEQUENCE ? signing.parseStrictPositiveInteger(env.RELEASE_SEQUENCE, "RELEASE_SEQUENCE") : null;
  requireThat(requested === null || requested > state.frontendSequence, "frontend-sequence-must-follow-current-frontend");
  const explicitOutput = env.RELEASE_BUNDLE_PATH ? path.resolve(env.RELEASE_BUNDLE_PATH) : null;
  const outputDirectory = explicitOutput ? path.dirname(explicitOutput) : path.join(root, ".codex-tmp");
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 }); const outputDirectories = assertPlainDirectories(outputDirectory);
  const artifactPaths = output => [output, output + ".sha256", output + ".manifest.json", output + ".manifest.sig"];
  if (explicitOutput) requireThat(artifactPaths(explicitOutput).every(p => !exists(p)), "frontend-output-already-exists");
  const privateKeyPath = path.resolve(env.RELEASE_SIGNING_PRIVATE_KEY || signing.DEFAULT_RELEASE_SIGNING_PRIVATE_KEY);
  readStable(privateKeyPath, 32768, observations); const privateKey = signing.loadReleasePrivateKey(privateKeyPath);
  requireThat(privateKey.keyId === keyId, "frontend-signing-key-mismatch");
  const stage = fs.mkdtempSync(path.join(outputDirectory, ".frontend-source-bundle-")); fs.chmodSync(stage, 0o700); const stageIdentity = identity(stat(stage));
  const spool = path.join(stage, "original.tar"), candidate = path.join(stage, "candidate.tgz"); let spoolFd = null, published = [];
  try {
    const tarSize = await spoolArchive(bundle, spool, baseline.archiveSourceEvidence, deadline);
    spoolFd = fs.openSync(spool, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const spoolStat = stat(spool);
    const members = indexAuthenticatedSpool(spoolFd, tarSize, sourceInventory);
    const readMember = (name, maximum) => {
      const member = members.get(name); requireThat(member?.row.kind === "file" && member.row.bytes <= maximum, "frontend-required-baseline-member");
      const bytes = readAt(spoolFd, member.offset, member.row.bytes); requireThat(hash(bytes) === member.row.sha256, "frontend-baseline-member-hash"); return bytes;
    };
    const originalDist = validateBaselineArtifacts(baseline, readMember);
    if (state.kind === "full") requireThat(state.indexSha256 === originalRows.get("dist/index.html").sha256 && state.distTreeHash === originalDist.treeHash, "frontend-full-state-dist-mismatch");
    await writeCandidateArchive(candidate, candidateInventory, async function* (row) {
      if (overlays.has(row.path)) { yield overlays.get(row.path); return; }
      const member = members.get(row.path); let read = 0;
      while (read < row.bytes) { const n = Math.min(65536, row.bytes - read); yield readAt(spoolFd, member.offset + read, n); read += n; }
    }, deadline);
    requireThat(stamp(stat(spool)) === stamp(spoolStat) && stamp(fs.fstatSync(spoolFd, { bigint: true })) === stamp(spoolStat), "frontend-spool-drift");
    const archiveSourceEvidence = await captureReleaseArchiveSourceEvidence(candidate);
    const candidateStat = stat(candidate);
    requireThat(JSON.stringify(archiveSourceEvidence.inventory) === JSON.stringify(candidateInventory), "frontend-actual-candidate-inventory-mismatch");
    const authorization = {
      version: AUTH_VERSION, baseline: { runtimeSha256: state.runtimeSha256, runtimeSequence: state.runtimeSequence,
        inventorySha256: sourceInventory.treeHash, frontendStateSha256: hash(stateBytes), indexSha256: state.indexSha256, distTreeHash: state.distTreeHash },
      candidateInventorySha256: candidateInventory.treeHash, runtime: runtime.runtime, policies: runtime.policies, changedPaths,
    };
    const trial = { releaseKind: "frontend-only", releaseSequence: requested || state.frontendSequence + 1, releaseActions: [], archiveSourceEvidence, frontendAuthorization: authorization };
    const comparison = compareAuthorizedFrontendSources({ manifest: trial, baselineInventory: sourceInventory, candidateInventory });
    unchanged(observations); checkDirectories(rootDirectories); checkDirectories(outputDirectories); requireThat(Date.now() < deadline, "frontend-operation-timeout");
    const sequenceState = signing.resolveReleaseSequenceStatePath(env); let chosen = requested;
    if (chosen === null) {
      let previous = 0;
      if (exists(sequenceState)) {
        const prior = parseJson(readStable(sequenceState, 16384)); requireThat(Number.isSafeInteger(prior.highestReservedSequence) && prior.highestReservedSequence >= 0, "frontend-sequence-state-invalid");
        previous = prior.highestReservedSequence;
      }
      chosen = Math.max(previous, state.frontendSequence) + 1; requireThat(Number.isSafeInteger(chosen), "frontend-sequence-exhausted");
    }
    const reservation = signing.reserveReleaseSequence({ site: config.site, channel: config.channel, requestedSequence: chosen, statePath: sequenceState, now });
    const timeTag = config.createdAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const output = explicitOutput || path.join(outputDirectory, "football-release-" + timeTag + "-r" + reservation.releaseSequence + ".tgz"), artifacts = artifactPaths(output);
    requireThat(artifacts.every(p => !exists(p)), "frontend-output-already-exists");
    const manifest = {
      ...baseline, ...config, releaseSequence: reservation.releaseSequence, releaseKind: "frontend-only", frontendAuthorization: authorization,
      path: output, sha256Path: artifacts[1], manifestPath: artifacts[2], signaturePath: artifacts[3], bytes: archiveSourceEvidence.archiveBytes,
      sha256: archiveSourceEvidence.archiveSha256, entries: archiveSourceEvidence.archiveEntryCount, archiveSourceEvidence, releaseActions: [], releaseActionEntries: [],
      signature: { algorithm: signing.RELEASE_SIGNATURE_ALGORITHM, keyId, format: "detached-binary" },
    };
    delete manifest.ttlHours;
    signing.validateReleaseManifestV3(manifest, { now }); validateFrontendAuthorization(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); requireThat(bytes.length <= 1024 ** 2, "frontend-manifest-size-limit");
    const signed = signing.signManifestBytes(bytes, privateKey.key); requireThat(signing.verifyManifestBytes(bytes, signed, publicKey), "frontend-new-signature-selfcheck");
    // Four exclusive names; signature bytes are persisted last. Failure cleanup
    // unlinks only inodes created by this attempt, never a substituted file.
    for (const file of artifacts) { const fd = fs.openSync(file, "wx", 0o600); published.push({ file, fd, inode: identity(fs.fstatSync(fd, { bigint: true })) }); }
    const candidateFd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), copiedHash = crypto.createHash("sha256");
    try {
      requireThat(stamp(fs.fstatSync(candidateFd, { bigint: true })) === stamp(candidateStat), "frontend-candidate-open-drift");
      let at = 0; while (at < archiveSourceEvidence.archiveBytes) {
        const n = Math.min(65536, archiveSourceEvidence.archiveBytes - at), chunk = readAt(candidateFd, at, n);
        copiedHash.update(chunk); writeAll(published[0].fd, chunk); at += n;
      }
      requireThat(copiedHash.digest("hex") === manifest.sha256 && stamp(fs.fstatSync(candidateFd, { bigint: true })) === stamp(candidateStat)
        && stamp(stat(candidate)) === stamp(candidateStat), "frontend-candidate-copy-drift");
    } finally { fs.closeSync(candidateFd); }
    writeAll(published[1].fd, Buffer.from(manifest.sha256 + "  " + path.basename(output) + "\n")); writeAll(published[2].fd, bytes);
    for (const row of published.slice(0, 3)) fs.fsyncSync(row.fd);
    unchanged(observations); writeAll(published[3].fd, signed); fs.fsyncSync(published[3].fd);
    for (const row of published) { fs.closeSync(row.fd); row.fd = null; }
    syncDirectory(outputDirectory); published = [];
    return { ...manifest, bundleConstruction: {
      version: VERSION, changedPaths, localBuildExecutions: 0, networkRequests: 0,
      includedWorkspacePaths: changedPaths, otherWorkspaceChangesIncluded: false, artifactProvenance: comparison.candidateArtifactEvidence,
      carriedDist: "unchanged-authenticated-baseline-artifact-not-candidate-build-output", publishedIdentityRequiresServerRevalidation: true,
      deploymentAuthorized: false, startedAt, finishedAt: Date.now(), temporaryExecutableStageCreated: false,
    } };
  } finally {
    if (spoolFd !== null) fs.closeSync(spoolFd);
    for (const row of published) {
      if (row.fd !== null) fs.closeSync(row.fd);
      if (exists(row.file)) { requireThat(identity(stat(row.file)) === row.inode, "frontend-output-cleanup-identity-drift"); fs.unlinkSync(row.file); }
    }
    requireThat(identity(stat(stage)) === stageIdentity && fs.realpathSync(stage) === stage, "frontend-stage-cleanup-identity-drift");
    for (const name of fs.readdirSync(stage)) {
      requireThat(["original.tar", "candidate.tgz"].includes(name), "frontend-unexpected-spool-member");
      const file = path.join(stage, name), s = stat(file); requireThat(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n, "frontend-unsafe-spool-cleanup"); fs.unlinkSync(file);
    }
    fs.rmdirSync(stage);
  }
}
module.exports = { VERSION, RUNTIME_VERSION, createFrontendReleaseBundle, parseJson, validateRuntimeBinding, ustarHeader, writeCandidateArchive, deriveInventory };
if (require.main === module) {
  if (process.argv.length !== 2) { process.stderr.write("usage: createFrontendReleaseBundle.cjs (configuration via RELEASE_FRONTEND_* environment)\n"); process.exitCode = 1; }
  else createFrontendReleaseBundle().then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(error => { process.stderr.write(JSON.stringify({ ok: false, error: error.message, deploymentAuthorized: false }) + "\n"); process.exitCode = 1; });
}
