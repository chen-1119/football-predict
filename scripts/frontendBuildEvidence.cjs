"use strict";

// Build evidence only. This module cannot authorize a UI deployment, accept a
// caller-supplied success flag or sign an artifact. Direct child execution is
// explicitly experimental: only the separate sandbox controller can constrain
// filesystem/network authority and prove descendant quiescence.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { inspectPrebuiltDist, MANIFEST_VERSION } = require("./releasePrebuiltDist.cjs");
const VERSION = "frontend-executed-build-evidence-v2";
const BUILD_SCRIPT = "tsc -b && vite build && node scripts/stripLargeStaticPayloads.cjs";
const COMMANDS = Object.freeze([
  ["node_modules/typescript/bin/tsc", "-b"],
  ["node_modules/vite/bin/vite.js", "build"],
  ["scripts/stripLargeStaticPayloads.cjs"],
]);
const CACHE_FILES = new Set(["node_modules/.tmp/tsconfig.app.tsbuildinfo", "node_modules/.tmp/tsconfig.node.tsbuildinfo"]);
const MAX_FILES = 100000, MAX_FILE_BYTES = 160 * 1024 * 1024, MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const hash = value => digest(JSON.stringify(value));
const stamp = s => [s.dev, s.ino, s.nlink, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(":");

function safePath(relative) {
  if (typeof relative !== "string" || !relative || /[\\:\x00-\x1f]/.test(relative)
    || relative.split("/").some(p => !p || p === "." || p === "..")) throw new Error("unsafe-build-input-path");
  return relative;
}
function plainRoot(input) {
  if (!path.isAbsolute(input)) throw new Error("absolute-private-build-root-required");
  const root = path.resolve(input), s = fs.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(root) !== root
    || (process.platform !== "win32" && (s.uid !== process.getuid() || (s.mode & 0o077)))) throw new Error("private-build-root-required");
  return root;
}
function fileDigest(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) throw new Error("non-plain-build-input");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd); if (stamp(opened) !== stamp(before)) throw new Error("build-input-open-drift");
    const h = crypto.createHash("sha256"), bytes = Buffer.alloc(65536); let total = 0;
    while (total < opened.size) {
      const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, opened.size - total), total);
      if (!n) throw new Error("build-input-read-drift"); total += n; h.update(bytes.subarray(0, n));
    }
    if (stamp(fs.fstatSync(fd)) !== stamp(opened) || stamp(fs.lstatSync(file)) !== stamp(opened)) throw new Error("build-input-read-drift");
    return { bytes: total, sha256: h.digest("hex"), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function validateBuildBinAlias(relative, target) {
  safePath(relative); safePath(target);
  // npm may install a dependency's own .bin under nested node_modules. Only
  // package/node_modules chains are allowed, never arbitrary symlink locations.
  const packageName = "(?:@[A-Za-z0-9_-][A-Za-z0-9._-]*/)?[A-Za-z0-9_-][A-Za-z0-9._-]*";
  const alias = new RegExp("^node_modules/(?:(?:" + packageName + ")/node_modules/)*\\.bin/[A-Za-z0-9_-][A-Za-z0-9._-]*$");
  if (!alias.test(relative)) throw new Error("unreviewed-build-symlink");
  if (!target.startsWith("node_modules/") || target.split("/").some(part => part.startsWith("."))) throw new Error("escaping-build-bin-alias");
}
function snapshotBuildInputs(rootInput, { beforeBuild = false } = {}) {
  const root = plainRoot(rootInput), source = [], dependencies = [], outputs = []; let totalBytes = 0, entries = 0;
  function walk(relative = "") {
    const dir = path.join(root, relative), prior = fs.lstatSync(dir), names = fs.readdirSync(dir).sort();
    if (!prior.isDirectory() || prior.isSymbolicLink()) throw new Error("linked-build-directory");
    for (const name of names) {
      const rel = safePath(relative ? relative + "/" + name : name), full = path.join(root, rel), s = fs.lstatSync(full);
      if (++entries > MAX_FILES) throw new Error("build-input-count-limit");
      if (rel === "dist") {
        if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("linked-build-output");
        if (beforeBuild && fs.readdirSync(full).length) throw new Error("fresh-empty-build-output-required");
        continue;
      }
      if (rel === "node_modules/.tmp" || rel === "node_modules/.vite-temp") {
        if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("linked-build-cache");
        for (const child of fs.readdirSync(full)) {
          const cache = rel + "/" + child;
          if (beforeBuild || !CACHE_FILES.has(cache)) throw new Error("unexpected-or-preexisting-build-cache");
          outputs.push({ path: cache, ...fileDigest(path.join(root, cache)) });
        }
        continue;
      }
      const rows = rel === "node_modules" || rel.startsWith("node_modules/") ? dependencies : source;
      if (s.isSymbolicLink()) {
        // npm's local executable aliases may target only already-inventoried
        // dependency files, never source, another root, or an arbitrary cache.
        const resolved = fs.realpathSync(full), target = path.relative(root, resolved).replaceAll(path.sep, "/");
        validateBuildBinAlias(rel, target);
        rows.push({ path: rel, kind: "bin-alias", target, ...fileDigest(resolved) });
      } else if (s.isDirectory()) {
        rows.push({ path: rel, kind: "directory", mode: s.mode & 0o777 }); walk(rel);
      } else {
        const entry = fileDigest(full); totalBytes += entry.bytes;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("build-input-byte-limit");
        rows.push({ path: rel, kind: "file", ...entry });
      }
    }
    if (stamp(fs.lstatSync(dir)) !== stamp(prior)) throw new Error("build-directory-drift");
  }
  walk();
  return { sourceHash: hash(source), dependencyHash: hash(dependencies), source, dependencies, cacheOutputs: outputs };
}
function buildEnvironment(root) {
  const env = { PATH: path.dirname(process.execPath) + path.delimiter + path.join(root, "node_modules", ".bin"),
    NODE_ENV: "production", VITE_BASE_PATH: "/", TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  if (process.platform === "win32") {
    if (!process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot)) throw new Error("windows-system-root-required");
    env.SystemRoot = process.env.SystemRoot; env.PATH += path.delimiter + path.join(process.env.SystemRoot, "System32");
  } else env.PATH += ":/usr/bin:/bin";
  return env;
}
function validateDistManifest(input) {
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
  if (!exactKeys(input, ["version", "files", "fileCount", "totalBytes", "treeHash"])
    || input.version !== MANIFEST_VERSION || !Array.isArray(input.files)
    || input.files.length < 1 || input.files.length > 4096 || input.fileCount !== input.files.length
    || !/^[a-f0-9]{64}$/.test(input.treeHash)) throw new Error("invalid-overlay-dist-manifest");
  const seen = new Set(); let total = 0, previous = null;
  const files = input.files.map(row => {
    if (!exactKeys(row, ["path", "bytes", "sha256"]) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.bytes > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error("invalid-overlay-dist-row");
    const name = safePath(row.path);
    if (name.startsWith("/") || seen.has(name) || (previous !== null && previous.localeCompare(name, "en") >= 0)) throw new Error("duplicate-or-unordered-overlay-dist-row");
    for (const parent of name.split("/").slice(0, -1).map((_, i) => name.split("/").slice(0, i + 1).join("/"))) {
      if (seen.has(parent)) throw new Error("overlay-dist-file-directory-collision");
    }
    seen.add(name); previous = name; total += row.bytes;
    if (total > 128 * 1024 * 1024) throw new Error("overlay-dist-byte-limit");
    return { path: name, bytes: row.bytes, sha256: row.sha256 };
  });
  if (!seen.has("index.html") || total <= 0 || input.totalBytes !== total) throw new Error("invalid-overlay-dist-summary");
  const body = { version: MANIFEST_VERSION, files, fileCount: files.length, totalBytes: total };
  if (hash(body) !== input.treeHash) throw new Error("overlay-dist-tree-hash-mismatch");
  return { ...body, treeHash: input.treeHash };
}
function inspectOverlayArtifacts(baseline, candidate) {
  baseline = validateDistManifest(baseline); candidate = validateDistManifest(candidate);
  const old = new Map(baseline.files.map(row => [row.path, row])), next = new Map(candidate.files.map(row => [row.path, row]));
  const assets = [];
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(name), b = next.get(name);
    if (JSON.stringify(a) === JSON.stringify(b) || name === "index.html") continue;
    if (!/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name)) throw new Error("non-overlay-artifact-change:" + name);
    if (a && b && a.sha256 !== b.sha256) throw new Error("immutable-asset-name-collision:" + name);
    if (b) assets.push(b); // Old assets intentionally remain available on the server.
  }
  if (!next.has("index.html") || !old.has("index.html")) throw new Error("missing-index-artifact");
  return { index: next.get("index.html"), previousIndex: old.get("index.html"), newAssets: assets,
    retainPreviousAssets: true, deletes: [] };
}
function executeFrontendBuild({ rootDir, baselineDist, baselineReleaseSha256, timeoutMs = 300000 }) {
  const root = plainRoot(rootDir);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("invalid-build-timeout");
  baselineDist = validateDistManifest(baselineDist);
  if (typeof baselineReleaseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baselineReleaseSha256)) throw new Error("baseline-release-sha256-required");
  // Binding is not authentication: an outer trusted controller must verify the
  // retained detached signature and the release currently running before reuse.
  const baseline = { releaseSha256: baselineReleaseSha256, distTreeHash: baselineDist.treeHash,
    manifestHash: hash(baselineDist), authentication: "not-proven-by-this-module" };
  if (process.execArgv.length || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error("clean-build-controller-required");
  const packageFile = path.join(root, "package.json");
  if (fileDigest(packageFile).bytes > 1024 * 1024) throw new Error("oversized-build-package");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (pkg.scripts?.build !== BUILD_SCRIPT || pkg.scripts?.prebuild || pkg.scripts?.postbuild) throw new Error("unreviewed-build-command");
  const before = snapshotBuildInputs(root, { beforeBuild: true }), env = buildEnvironment(root);
  const policies = [__filename, require.resolve("./releasePrebuiltDist.cjs")].map(file => ({ file, sha256: fileDigest(file).sha256 }));
  for (const args of COMMANDS) fileDigest(path.join(root, args[0]));
  const toolchain = { node: fileDigest(process.execPath).sha256, versions: process.versions,
    platform: process.platform, arch: process.arch, osRelease: os.release(), environment: env };
  const startedAt = Date.now(), runs = [];
  for (const args of COMMANDS) {
    const remaining = timeoutMs - (Date.now() - startedAt); if (remaining <= 0) throw new Error("frontend-build-deadline");
    const start = Date.now(), child = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8",
      timeout: remaining, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    runs.push({ args, status: child.status, signal: child.signal, error: child.error?.code || null,
      elapsedMs: Date.now() - start, stdoutSha256: digest(child.stdout || ""), stderrSha256: digest(child.stderr || "") });
    if (child.status !== 0 || child.signal || child.error) {
      const error = new Error("frontend-build-command-failed:" + args[0]);
      error.evidence = { runs, stdout: (child.stdout || "").slice(-8192), stderr: (child.stderr || "").slice(-8192) };
      throw error;
    }
  }
  const after = snapshotBuildInputs(root), artifact = inspectPrebuiltDist(path.join(root, "dist"));
  if (before.sourceHash !== after.sourceHash || before.dependencyHash !== after.dependencyHash) throw new Error("frontend-build-input-drift");
  if (fileDigest(process.execPath).sha256 !== toolchain.node) throw new Error("frontend-build-runtime-drift");
  if (policies.some(p => fileDigest(p.file).sha256 !== p.sha256)) throw new Error("frontend-builder-policy-drift");
  const overlay = inspectOverlayArtifacts(baselineDist, artifact);
  const body = { version: VERSION, baseline, sourceHash: before.sourceHash, dependencyHash: before.dependencyHash,
    toolchain, commandPolicyHash: hash({ BUILD_SCRIPT, COMMANDS, caches: [...CACHE_FILES] }),
    builderPolicies: policies.map(p => ({ name: path.basename(p.file), sha256: p.sha256 })), startedAt, finishedAt: Date.now(), runs,
    cacheOutputs: after.cacheOutputs, artifact, overlay,
    executionAssurance: "unsandboxed-direct-children-only", descendantsQuiescent: null,
    externalInputIsolation: false, productionWrites: null, providerRequests: null,
    signingEligible: false, deploymentAuthorized: false };
  return { ...body, evidenceHash: hash(body) };
}
module.exports = { VERSION, BUILD_SCRIPT, COMMANDS, snapshotBuildInputs, buildEnvironment, validateBuildBinAlias, validateDistManifest, inspectOverlayArtifacts, executeFrontendBuild };
