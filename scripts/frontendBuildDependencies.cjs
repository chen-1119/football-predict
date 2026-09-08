"use strict";

// Independently bootstrapped offline material import, not candidate authority.
// No CLI, package execution, npm/network, application write or signing key.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const { TextDecoder } = require("node:util"), build = require("./frontendBuildEvidence.cjs");
const VERSION = "frontend-build-dependencies-v1", STORE = "/var/lib/football-release/frontend-dependencies";
const PARSER_ROOT = "/usr/local/libexec/football-release-frontend/node_modules";
const PARSER_SHA = "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39", HASH = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE = 512 * 1024 * 1024, MAX_FILE = 160 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024, MAX_ENTRIES = 100000;
const MAX_MANIFEST = 32 * 1024 * 1024, FREE_FLOOR = 4n * 1024n ** 3n, utf8 = new TextDecoder("utf-8", { fatal: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), json = value => Buffer.from(JSON.stringify(value) + "\n");
const stamp = s => [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(":");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unsafeCharacters = value => /[\\:]/.test(value) || [...value].some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
function fail(reason) { throw new Error(reason); }
function directory(context, filename, privateMode = false) {
  for (let cursor = filename; ; cursor = path.dirname(cursor)) {
    const s = fs.lstatSync(cursor);
    const stickyTmp = !context.fixture && cursor === "/tmp" && s.uid === 0 && Boolean(s.mode & 0o1000);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(cursor) !== cursor || s.uid !== context.uid
      || ((s.mode & 0o022) && !stickyTmp) || (cursor === filename && privateMode && (s.mode & 0o077))) fail("untrusted-dependency-directory");
    if (cursor === context.boundary) break;
    if (path.dirname(cursor) === cursor) fail("dependency-trust-boundary");
  }
}
function syncDir(filename) { const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function ensureDir(context, filename, mode) {
  if (!fs.existsSync(filename)) { directory(context, path.dirname(filename)); fs.mkdirSync(filename, { mode }); fs.chmodSync(filename, mode); syncDir(path.dirname(filename)); }
  directory(context, filename, mode === 0o700);
}
function fileInfo(context, filename, limit) {
  directory(context, path.dirname(filename)); const s = fs.lstatSync(filename, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || Number(s.uid) !== context.uid || (s.mode & 0o022n)
    || s.size <= 0n || s.size > BigInt(limit)) fail("unsafe-or-oversized-dependency-file"); return s;
}
function read(context, filename, limit) {
  const s = fileInfo(context, filename, limit), fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), buffer = Buffer.alloc(Number(s.size));
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)) fail("dependency-read-open-drift");
    let offset = 0; while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, Math.min(65536, buffer.length - offset), offset); if (!count) fail("dependency-short-read"); offset += count; }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s) || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(s)) fail("dependency-read-drift");
    return buffer;
  } finally { fs.closeSync(fd); }
}
function write(context, filename, bytes, mode = 0o600) {
  directory(context, path.dirname(filename)); const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDir(path.dirname(filename));
}
function safePath(input, isDirectory = false) {
  let name = input.startsWith("./") ? input.slice(2) : input;
  if (isDirectory && name.endsWith("/")) name = name.slice(0, -1);
  if (!name || name.length > 2048 || name !== name.normalize("NFC") || unsafeCharacters(name)
    || name.split("/").length > 64 || name.split("/").some(p => !p || p === "." || p === ".." || p.length > 255)
    || !(name === "node_modules" || name.startsWith("node_modules/"))
    || /^node_modules\/(?:\.tmp|\.vite-temp)(?:\/|$)/.test(name)) fail("unsafe-dependency-member-path");
  return name;
}
function octal(bytes) { const value = bytes.toString("ascii").replace(/\0.*$/, "").trim(); if (!/^[0-7]*$/.test(value)) fail("invalid-dependency-tar-number"); const n = parseInt(value || "0", 8); if (!Number.isSafeInteger(n) || n < 0) fail("invalid-dependency-tar-number"); return n; }
function textField(bytes) { const nul = bytes.indexOf(0); if (nul >= 0 && bytes.subarray(nul).some(v => v)) fail("nonzero-tar-string-suffix"); return utf8.decode(nul < 0 ? bytes : bytes.subarray(0, nul)); }
function parser(writer = null) {
  const rows = [], aliases = new Set(); let header = Buffer.alloc(0), active = null, padding = 0, zeroes = 0, total = 0, expanded = 0, headers = 0, longName = null, longLink = null;
  const finish = () => {
    if (active.meta) {
      const data = Buffer.concat(active.chunks);
      if (!data.length || data.at(-1) !== 0 || data.subarray(0, -1).includes(0)) fail("invalid-gnu-dependency-extension");
      const value = utf8.decode(data.subarray(0, -1));
      if (active.meta === "L") { if (longName !== null) fail("duplicate-gnu-name"); longName = value; }
      else { if (longLink !== null) fail("duplicate-gnu-link"); longLink = value; }
    } else {
      if (active.row.kind === "file") active.row.sha256 = active.hash.digest("hex");
      writer?.finish(active.row); rows.push(active.row);
    }
    padding = (512 - active.size % 512) % 512; active = null;
  };
  const accept = block => {
    if (block.every(v => v === 0)) { zeroes++; return; }
    if (zeroes) fail("nonzero-dependency-tar-after-end"); if (++headers > MAX_ENTRIES * 3) fail("dependency-header-limit");
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
    if (sum !== octal(block.subarray(148, 156))) fail("dependency-tar-checksum");
    const magic = block.subarray(257, 263).toString("ascii"); if (!["ustar\0", "ustar "].includes(magic)) fail("unsupported-dependency-tar-format");
    const size = octal(block.subarray(124, 136)), mode = octal(block.subarray(100, 108)), type = String.fromCharCode(block[156] || 48);
    if (mode > 0o777) fail("unsafe-dependency-tar-mode");
    let name = [magic === "ustar\0" ? textField(block.subarray(345, 500)) : "", textField(block.subarray(0, 100))].filter(Boolean).join("/");
    let link = textField(block.subarray(157, 257));
    if (["L", "K"].includes(type)) {
      if (name !== "././@LongLink" || link || !size || size > 4096) fail("unsafe-gnu-dependency-extension");
      active = { meta: type, size, left: size, chunks: [] }; return;
    }
    if (!["0", "5", "2"].includes(type)) fail("dependency-hardlink-special-or-pax-forbidden");
    name = longName ?? name; link = longLink ?? link; longName = null; longLink = null;
    const kind = type === "0" ? "file" : type === "5" ? "directory" : "bin-alias", relative = safePath(name, kind === "directory");
    if (aliases.has(relative.toLowerCase()) || aliases.size >= MAX_ENTRIES) fail("duplicate-aliased-or-excess-dependency-member"); aliases.add(relative.toLowerCase());
    if (size > MAX_FILE || total + size > MAX_TOTAL || (kind !== "file" && size !== 0) || (kind !== "bin-alias" && link)) fail("dependency-member-size-or-link"); total += size;
    let row;
    if (kind === "bin-alias") {
      if (!link || path.posix.isAbsolute(link) || unsafeCharacters(link)) fail("unsafe-dependency-bin-link");
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
      build.validateBuildBinAlias(relative, target); row = { path: relative, kind, target };
    } else row = kind === "file" ? { path: relative, kind, bytes: size, mode } : { path: relative, kind, mode };
    active = { row, size, left: size, hash: kind === "file" ? crypto.createHash("sha256") : null }; writer?.start(row);
    if (!size) finish();
  };
  return {
    write(chunk) {
      expanded += chunk.length; if (expanded > MAX_TOTAL + MAX_ENTRIES * 2048) fail("expanded-dependency-archive-limit"); let at = 0;
      while (at < chunk.length) {
        if (active) { const n = Math.min(active.left, chunk.length - at), part = chunk.subarray(at, at + n);
          if (active.meta) active.chunks.push(Buffer.from(part)); else { active.hash?.update(part); writer?.data(part); }
          active.left -= n; at += n; if (!active.left) finish();
        } else if (padding) { const n = Math.min(padding, chunk.length - at); if (chunk.subarray(at, at + n).some(v => v)) fail("nonzero-dependency-tar-padding"); padding -= n; at += n;
        } else { const n = Math.min(512 - header.length, chunk.length - at); header = Buffer.concat([header, chunk.subarray(at, at + n)]); at += n; if (header.length === 512) { accept(header); header = Buffer.alloc(0); } }
      }
    },
    finish() {
      if (active || padding || header.length || zeroes < 2 || longName !== null || longLink !== null || !rows.length) fail("incomplete-dependency-tar");
      const map = new Map(rows.map(row => [row.path, row]));
      if (map.get("node_modules")?.kind !== "directory") fail("missing-dependency-root-directory");
      for (const row of rows) {
        for (let parent = path.posix.dirname(row.path); parent !== "."; parent = path.posix.dirname(parent)) if (map.get(parent)?.kind !== "directory") fail("dependency-parent-not-real-directory");
        if (row.kind === "bin-alias" && map.get(row.target)?.kind !== "file") fail("dependency-bin-target-not-regular-member");
      }
      return { rows: rows.sort((a, b) => a.path.localeCompare(b.path, "en")), totalBytes: total, expandedBytes: expanded };
    },
  };
}
async function scan(context, filename, expectedHash, writer = null) {
  const prior = fileInfo(context, filename, MAX_ARCHIVE), handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let source, unzip, sourceClosed, unzipClosed, timer, sourceError, failure, result;
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(prior)) fail("dependency-archive-open-drift");
    const digest = crypto.createHash("sha256"), parse = parser(writer); let count = 0;
    source = handle.createReadStream({ autoClose: false, highWaterMark: 65536, start: 0, end: Number(prior.size) - 1 }); sourceClosed = new Promise(resolve => source.once("close", resolve));
    unzip = zlib.createGunzip({ chunkSize: 65536 }); unzipClosed = new Promise(resolve => unzip.once("close", resolve));
    source.on("data", chunk => { count += chunk.length; digest.update(chunk); });
    source.on("error", error => { sourceError = error; unzip.destroy(error); });
    timer = setTimeout(() => { source.destroy(new Error("dependency-archive-timeout")); unzip.destroy(new Error("dependency-archive-timeout")); }, 120000);
    source.pipe(unzip); for await (const chunk of unzip) parse.write(chunk);
    if (count !== Number(prior.size) || digest.digest("hex") !== expectedHash || stamp(await handle.stat({ bigint: true })) !== stamp(prior)
      || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(prior)) fail("dependency-archive-hash-or-identity-drift");
    result = parse.finish();
  } catch (error) { failure = error; }
  finally { clearTimeout(timer); source?.destroy(); unzip?.destroy(); await Promise.all([sourceClosed, unzipClosed]); await handle.close(); }
  if (failure) throw failure; if (sourceError) throw sourceError; return result;
}
function guard(context) {
  if (context.fixture) context.validateFixture();
  else require("./frontendReleaseTransaction.cjs").assertFrontendReleaseLock();
  directory(context, path.dirname(context.store)); directory(context, context.parserParent);
}
function inputManifest(context, input) {
  if (!exact(input, ["materialDir", "materialManifestSha256", "materialArchiveSha256", "lockSha256"]) || ["materialManifestSha256", "materialArchiveSha256", "lockSha256"].some(key => !HASH.test(input[key] || ""))) fail("exact-dependency-material-identities-required");
  if (context.fixture ? input.materialDir !== context.material : !/^\/tmp\/football-frontend-materials-[A-Za-z0-9]{6,32}$/.test(input.materialDir || "")) fail("fixed-root-dependency-material-required");
  directory(context, input.materialDir, true);
  if (!equal(fs.readdirSync(input.materialDir).sort(), ["dependencies.tgz", "manifest.json"])) fail("dependency-material-membership");
  for (const name of ["manifest.json", "dependencies.tgz"]) if ((fileInfo(context, path.join(input.materialDir, name), name === "manifest.json" ? MAX_MANIFEST : MAX_ARCHIVE).mode & 0o777n) !== 0o400n) fail("dependency-material-not-sealed");
  const raw = read(context, path.join(input.materialDir, "manifest.json"), MAX_MANIFEST); if (hash(raw) !== input.materialManifestSha256) fail("dependency-material-manifest-hash");
  const value = JSON.parse(utf8.decode(raw));
  if (!exact(value, ["kind", "createdAt", "lockSha256", "archiveSha256", "inventory", "install", "signingEligible"])
    || value.kind !== "task-private-dependency-material-not-acceptance" || value.signingEligible !== false
    || value.lockSha256 !== input.lockSha256 || value.archiveSha256 !== input.materialArchiveSha256
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.inventory) || value.inventory.length >= MAX_ENTRIES) fail("dependency-material-manifest-contract");
  return { raw, value };
}
function materialRows(rows) { return rows.filter(row => row.path !== "node_modules").map(row => {
  const value = { ...row, path: row.path.slice("node_modules/".length) }; if (value.kind === "bin-alias") value.target = value.target.slice("node_modules/".length); return value;
}); }
function compareMaterialInventory(value, rows) {
  const supplied = value.inventory.map(row => {
    if (!exact(row, row.kind === "file" ? ["path", "kind", "bytes", "mode", "sha256"] : row.kind === "directory" ? ["path", "kind", "mode"] : ["path", "kind", "target"])) fail("invalid-material-inventory-row");
    return row.kind === "file" ? { path: row.path, kind: row.kind, bytes: row.bytes, mode: row.mode, sha256: row.sha256 }
      : row.kind === "directory" ? { path: row.path, kind: row.kind, mode: row.mode } : { path: row.path, kind: row.kind, target: row.target };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (!equal(supplied, materialRows(rows))) fail("actual-material-inventory-mismatch");
}
function normalizedRows(rows) { return rows.map(row => row.kind === "bin-alias" ? { ...row } : { ...row, mode: row.kind === "directory" || (row.mode & 0o111) ? 0o755 : 0o644 }); }
function dependencyRows(rows) {
  const map = new Map(rows.map(row => [row.path, row]));
  return rows.map(row => row.kind === "bin-alias" ? { ...row, bytes: map.get(row.target).bytes, sha256: map.get(row.target).sha256, mode: map.get(row.target).mode } : row);
}
function expectedSnapshot(rows) {
  // snapshotBuildInputs uses sorted-name depth-first traversal, not locale sort.
  const children = new Map(); for (const row of dependencyRows(rows)) { const parent = path.posix.dirname(row.path); if (!children.has(parent)) children.set(parent, []); children.get(parent).push(row); }
  const result = []; const visit = name => { for (const row of (children.get(name) || []).sort((a, b) => path.posix.basename(a.path) < path.posix.basename(b.path) ? -1 : 1)) {
    const ordered = row.kind === "directory" ? { path: row.path, kind: row.kind, mode: row.mode }
      : row.kind === "file" ? { path: row.path, kind: row.kind, bytes: row.bytes, sha256: row.sha256, mode: row.mode }
        : { path: row.path, kind: row.kind, target: row.target, bytes: row.bytes, sha256: row.sha256, mode: row.mode };
    result.push(ordered); if (row.kind === "directory") visit(row.path);
  } }; visit("."); return result;
}
function verifyTree(context, root, expected) {
  const snapshot = build.snapshotBuildInputs(root, { beforeBuild: true });
  if (!equal(snapshot.dependencies, expectedSnapshot(expected))) fail("extracted-dependency-tree-mismatch");
  for (const row of expected) {
    const full = path.join(root, row.path), s = fs.lstatSync(full); if (s.uid !== context.uid) fail("dependency-owner-mismatch");
    if (row.kind === "directory") directory(context, full);
    else if (row.kind === "file" && (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== row.mode)) fail("dependency-file-identity-or-mode");
    else if (row.kind === "bin-alias" && (!s.isSymbolicLink() || fs.realpathSync(full) !== path.join(root, row.target))) fail("dependency-alias-drift");
  }
  return snapshot;
}
function verifyStore(context, lockSha256) {
  if (!HASH.test(lockSha256 || "")) fail("invalid-dependency-lock-hash"); const root = path.join(context.store, lockSha256); directory(context, root, true);
  if (!equal(fs.readdirSync(root).sort(), ["complete.json", "dependencies.json", "node_modules"])) fail("dependency-store-membership");
  const raw = read(context, path.join(root, "dependencies.json"), 16384), record = JSON.parse(raw), complete = JSON.parse(read(context, path.join(root, "complete.json"), 4096));
  if (!exact(record, ["version", "lockSha256", "dependencySha256", "materialManifestSha256", "materialArchiveSha256", "entryCount", "totalBytes", "importedAt", "origin"])
    || record.version !== VERSION || record.lockSha256 !== lockSha256 || !HASH.test(record.dependencySha256 || "")
    || !exact(complete, ["version", "recordSha256"]) || complete.version !== VERSION || complete.recordSha256 !== hash(raw)) fail("dependency-store-record-binding");
  const observed = build.snapshotBuildInputs(root, { beforeBuild: true }); if (observed.dependencyHash !== record.dependencySha256) fail("dependency-store-content-drift");
  for (const row of observed.dependencies) {
    const filename = path.join(root, row.path), s = fs.lstatSync(filename);
    if (s.uid !== context.uid || (row.kind !== "bin-alias" && (s.mode & 0o022))) fail("dependency-store-ownership-or-mode-drift");
    if (row.kind === "directory") directory(context, filename);
  }
  return { root, record, observed };
}
async function importMaterial(context, input) {
  guard(context); const material = inputManifest(context, input), archive = path.join(input.materialDir, "dependencies.tgz"), observed = await scan(context, archive, input.materialArchiveSha256);
  compareMaterialInventory(material.value, observed.rows); const rows = normalizedRows(observed.rows);
  ensureDir(context, context.store, 0o700);
  const final = path.join(context.store, input.lockSha256);
  if (fs.existsSync(final)) {
    const prior = verifyStore(context, input.lockSha256);
    if (prior.record.materialManifestSha256 !== input.materialManifestSha256 || prior.record.materialArchiveSha256 !== input.materialArchiveSha256) fail("existing-dependency-material-conflict");
    verifyTree(context, final, rows); return { version: VERSION, ok: true, reused: true, root: final, record: prior.record, networkRequests: 0, packageExecutions: 0 };
  }
  const statfs = fs.statfsSync(context.store, { bigint: true }), available = context.fixture && context.freeBytes !== undefined ? BigInt(context.freeBytes) : statfs.bavail * statfs.bsize;
  const extractionBudget = BigInt(observed.totalBytes) + BigInt(observed.rows.length) * 8192n + 4n * 1024n * 1024n;
  if (available < FREE_FLOOR + extractionBudget) fail("insufficient-dependency-import-space");
  const stage = path.join(context.store, ".import-" + crypto.randomBytes(12).toString("hex")); ensureDir(context, stage, 0o700);
  for (const row of rows.filter(row => row.kind === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length)) ensureDir(context, path.join(stage, row.path), row.mode);
  const expected = new Map(observed.rows.map(row => [row.path, row])); let fd = null, writing = null;
  const writer = {
    start(row) {
      const wanted = expected.get(row.path); if (!wanted || row.kind !== wanted.kind || (row.kind === "file" && (row.bytes !== wanted.bytes || row.mode !== wanted.mode))) fail("second-pass-metadata-drift");
      if (row.kind === "file") { const filename = path.join(stage, row.path); directory(context, path.dirname(filename));
        fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, row.mode & 0o111 ? 0o755 : 0o644); fs.fchmodSync(fd, row.mode & 0o111 ? 0o755 : 0o644); writing = row.path; }
    },
    data(chunk) { if (fd !== null) fs.writeFileSync(fd, chunk); },
    finish(row) { if (!equal(row, expected.get(row.path))) fail("second-pass-member-drift"); if (fd !== null) { fs.fsyncSync(fd); fs.closeSync(fd); fd = null; syncDir(path.dirname(path.join(stage, writing))); writing = null; } },
  };
  try {
    const repeated = await scan(context, archive, input.materialArchiveSha256, writer); if (!equal(repeated, observed)) fail("second-pass-archive-drift");
  } finally { if (fd !== null) fs.closeSync(fd); }
  for (const row of rows.filter(row => row.kind === "bin-alias")) { const target = path.join(stage, row.path); directory(context, path.dirname(target));
    fs.symlinkSync(path.relative(path.dirname(target), path.join(stage, row.target)), target); syncDir(path.dirname(target)); }
  const snapshot = verifyTree(context, stage, rows);
  if (!read(context, path.join(input.materialDir, "manifest.json"), MAX_MANIFEST).equals(material.raw)) fail("dependency-material-changed-before-publication");
  guard(context); context.onStep?.("before-complete");
  const record = { version: VERSION, lockSha256: input.lockSha256, dependencySha256: snapshot.dependencyHash,
    materialManifestSha256: input.materialManifestSha256, materialArchiveSha256: input.materialArchiveSha256,
    entryCount: rows.length, totalBytes: observed.totalBytes, importedAt: new Date().toISOString(), origin: "independently-approved-offline-material-not-release-authorization" };
  write(context, path.join(stage, "dependencies.json"), json(record)); write(context, path.join(stage, "complete.json"), json({ version: VERSION, recordSha256: hash(json(record)) }));
  if (fs.existsSync(final)) fail("dependency-store-publication-conflict");
  verifyTree(context, stage, rows); fs.renameSync(stage, final); syncDir(context.store);
  return { version: VERSION, ok: true, reused: false, root: final, record, networkRequests: 0, packageExecutions: 0 };
}
function installParser(context, input) {
  guard(context); if (!exact(input, ["lockSha256"])) fail("exact-parser-import-input-required"); const material = verifyStore(context, input.lockSha256);
  const packageBytes = read(context, path.join(material.root, "node_modules/typescript/package.json"), 65536), library = read(context, path.join(material.root, "node_modules/typescript/lib/typescript.js"), 16 * 1024 * 1024);
  const pkg = JSON.parse(packageBytes);
  if (pkg.name !== "typescript" || pkg.version !== "6.0.3" || pkg.main !== "./lib/typescript.js" || Object.hasOwn(pkg, "exports")
    || (Object.hasOwn(pkg, "type") && pkg.type !== "commonjs") || hash(library) !== PARSER_SHA) fail("trusted-typescript-parser-pin-mismatch");
  ensureDir(context, context.parserRoot, 0o755); const destination = path.join(context.parserRoot, "typescript");
  const verifyInstalled = root => {
    directory(context, root); directory(context, path.join(root, "lib"));
    if (!equal(fs.readdirSync(root).sort(), ["lib", "package.json"]) || !equal(fs.readdirSync(path.join(root, "lib")), ["typescript.js"])
      || !read(context, path.join(root, "package.json"), 65536).equals(packageBytes) || !read(context, path.join(root, "lib/typescript.js"), 16 * 1024 * 1024).equals(library)) fail("installed-typescript-parser-conflict");
  };
  if (fs.existsSync(destination)) { verifyInstalled(destination); return { ok: true, reused: true, version: "6.0.3", sha256: PARSER_SHA, root: destination }; }
  const stage = path.join(context.parserRoot, ".typescript-" + crypto.randomBytes(12).toString("hex")); ensureDir(context, stage, 0o755); ensureDir(context, path.join(stage, "lib"), 0o755);
  write(context, path.join(stage, "package.json"), packageBytes, 0o644); write(context, path.join(stage, "lib/typescript.js"), library, 0o644); verifyInstalled(stage);
  guard(context); if (fs.existsSync(destination)) fail("parser-publication-conflict"); fs.renameSync(stage, destination); syncDir(context.parserRoot);
  return { ok: true, reused: false, version: "6.0.3", sha256: PARSER_SHA, root: destination };
}
function production() { return { uid: 0, boundary: "/", fixture: false, store: STORE, parserRoot: PARSER_ROOT, parserParent: path.dirname(PARSER_ROOT) }; }
function createFrontendBuildDependenciesFixture({ freeBytes, onStep } = {}) {
  if (process.platform !== "linux") fail("linux-dependency-fixture-required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-dependency-import-fixture-")); fs.chmodSync(root, 0o700);
  const material = path.join(root, "materials"), install = path.join(root, "install"); fs.mkdirSync(material, { mode: 0o700 }); fs.mkdirSync(install, { mode: 0o700 });
  const identity = stamp(fs.statSync(root, { bigint: true })); let disposed = false;
  const context = { uid: process.getuid(), boundary: root, fixture: true, store: path.join(root, "store"), material, parserRoot: path.join(install, "node_modules"), parserParent: install, freeBytes, onStep,
    validateFixture() { const now = fs.statSync(root, { bigint: true }); if (disposed || fs.realpathSync(root) !== root || String(now.ino) !== identity.split(":")[1] || Number(now.uid) !== process.getuid() || (now.mode & 0o777n) !== 0o700n) fail("dependency-fixture-identity"); } };
  return Object.freeze({ fixtureOnly: true, deploymentAuthorized: false, root, materialDir: material, store: context.store, parserRoot: context.parserRoot,
    import: input => importMaterial(context, input), installParser: input => installParser(context, input),
    dispose() { context.validateFixture(); fs.rmSync(root, { recursive: true }); disposed = true; } });
}
module.exports = { VERSION, importFrontendBuildDependencies: input => importMaterial(production(), input),
  installFrontendBuildParser: input => installParser(production(), input), createFrontendBuildDependenciesFixture };
