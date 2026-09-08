"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_VERSION = "release-prebuilt-dist-v1";
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_TOTAL_BYTES;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORIES = MAX_FILES + 1;
const READ_CHUNK_BYTES = 64 * 1024;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => JSON.stringify(value, Object.keys(value || {}).sort());

const normalizeRelative = (value) => String(value || "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "");

const assertSafeRelative = (relativePath) => {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`unsafe dist entry: ${relativePath}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe dist entry: ${relativePath}`);
  }
  return normalized;
};

const fileIdentity = (info) => [info.dev, info.ino, info.mode, info.nlink,
  info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
const lstat = (filename) => fs.lstatSync(filename, { bigint: true });
const assertPlainFile = (info, filename, maxBytes) => {
  if (info.isSymbolicLink()) throw new Error(`prebuilt dist contains a symlink: ${filename}`);
  if (!info.isFile() || info.nlink !== 1n) throw new Error(`prebuilt dist contains a non-plain file: ${filename}`);
  if (info.size < 0n || info.size > BigInt(maxBytes)) throw new Error(`prebuilt file byte size is outside policy: ${filename}`);
};
const assertFileIdentity = (filename, expected, observed = lstat(filename)) => {
  if (fileIdentity(observed) !== fileIdentity(expected)) throw new Error(`prebuilt file identity drift: ${filename}`);
};

// The descriptor must still describe the inventoried path before and after
// streaming. A replaced path must not silently authorize the old open inode.
const readStableFile = (filename, expected, maxBytes, onChunk) => {
  assertPlainFile(expected, filename, maxBytes);
  const before = lstat(filename);
  assertPlainFile(before, filename, maxBytes); assertFileIdentity(filename, expected, before);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assertPlainFile(opened, filename, maxBytes); assertFileIdentity(filename, expected, opened);
    const length = Number(opened.size), buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (!count) throw new Error(`prebuilt file read drift: ${filename}`);
      onChunk(buffer.subarray(0, count)); offset += count;
    }
    assertFileIdentity(filename, expected, fs.fstatSync(fd, { bigint: true }));
    assertFileIdentity(filename, expected);
    return length;
  } finally { fs.closeSync(fd); }
};

const inspectPrebuiltDist = (distInput) => {
  const distDir = path.resolve(distInput);
  const rootInfo = lstat(distDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`prebuilt dist is not a plain directory: ${distDir}`);
  }
  const rootRealPath = fs.realpathSync(distDir);
  const files = [], inventory = [], directories = [];
  let totalBytes = 0;
  const namesFor = (directory) => fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  const assertDirectory = (entry) => {
    const current = lstat(entry.path);
    if (!current.isDirectory() || current.isSymbolicLink()
      || fileIdentity(current) !== entry.identity
      || JSON.stringify(namesFor(entry.path)) !== JSON.stringify(entry.names)
      || fileIdentity(lstat(entry.path)) !== entry.identity) {
      throw new Error(`prebuilt directory identity or membership drift: ${entry.path}`);
    }
  };
  const pending = [distDir];
  while (pending.length) {
    const current = pending.pop();
    const prior = lstat(current);
    if (!prior.isDirectory() || prior.isSymbolicLink()) throw new Error(`prebuilt dist contains a symlink or non-directory: ${current}`);
    if (current === distDir && fileIdentity(prior) !== fileIdentity(rootInfo)) throw new Error("prebuilt root identity drift");
    const directory = { path: current, identity: fileIdentity(prior), names: namesFor(current) };
    directories.push(directory);
    if (directories.length > MAX_DIRECTORIES) throw new Error("prebuilt dist directory count is outside policy");
    for (const name of directory.names) {
      const absolutePath = path.join(current, name);
      const info = lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`prebuilt dist contains a symlink: ${absolutePath}`);
      if (info.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      assertPlainFile(info, absolutePath, MAX_FILE_BYTES);
      const relativePath = assertSafeRelative(path.relative(distDir, absolutePath));
      totalBytes += Number(info.size);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`prebuilt dist byte size is outside policy: ${totalBytes}`);
      inventory.push({ path: relativePath, absolutePath, info });
      if (inventory.length > MAX_FILES) throw new Error(`prebuilt dist exceeds ${MAX_FILES} files`);
    }
    assertDirectory(directory);
  }
  if (!inventory.length || !inventory.some((entry) => entry.path === "index.html")) {
    throw new Error("prebuilt dist is empty or missing index.html");
  }
  if (totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`prebuilt dist byte size is outside policy: ${totalBytes}`);
  }
  // All sizes/counts are checked before opening any artifact content, including
  // sparse files. Per-file streaming allocation stays bounded at 64 KiB.
  for (const entry of inventory) {
    const digest = crypto.createHash("sha256");
    const bytes = readStableFile(entry.absolutePath, entry.info, MAX_FILE_BYTES, chunk => digest.update(chunk));
    files.push(Object.freeze({ path: entry.path, bytes, sha256: digest.digest("hex") }));
  }
  // Recheck earlier files after hashing later ones; directory metadata alone
  // cannot reveal an in-place content edit to an already-read file.
  for (const entry of inventory) assertFileIdentity(entry.absolutePath, entry.info);
  for (const directory of directories) assertDirectory(directory);
  if (fs.realpathSync(distDir) !== rootRealPath) throw new Error("prebuilt root path drift");
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const body = {
    version: MANIFEST_VERSION,
    files,
    fileCount: files.length,
    totalBytes,
  };
  return Object.freeze({ ...body, treeHash: sha256(Buffer.from(JSON.stringify(body), "utf8")) });
};

const readManifest = (manifestInput) => {
  const manifestPath = path.resolve(manifestInput);
  const info = lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new Error(`prebuilt dist manifest is unsafe: ${manifestPath}`);
  }
  const chunks = [];
  const bytes = readStableFile(manifestPath, info, MAX_MANIFEST_BYTES, chunk => chunks.push(Buffer.from(chunk)));
  const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  if (!parsed || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.files)) {
    throw new Error("prebuilt dist manifest has an invalid structure");
  }
  return parsed;
};

const verifyPrebuiltDist = ({ distDir, manifestPath }) => {
  const expected = readManifest(manifestPath);
  const actual = inspectPrebuiltDist(distDir);
  const matches = JSON.stringify(expected) === JSON.stringify(actual);
  return Object.freeze({
    ok: matches,
    version: MANIFEST_VERSION,
    expectedTreeHash: expected.treeHash || null,
    actualTreeHash: actual.treeHash,
    fileCount: actual.fileCount,
    totalBytes: actual.totalBytes,
  });
};

const writeManifest = (outputInput, manifest) => {
  const outputPath = path.resolve(outputInput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
};

const parseCli = (argv) => {
  const result = { command: argv[0] || "" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || argv[index + 1] === undefined) continue;
    result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
    index += 1;
  }
  return result;
};

const main = () => {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "capture") {
    const manifest = inspectPrebuiltDist(cli.dist);
    writeManifest(cli.output, manifest);
    process.stdout.write(`${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`);
    return;
  }
  if (cli.command === "verify") {
    const result = verifyPrebuiltDist({ distDir: cli.dist, manifestPath: cli.manifest });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  throw new Error("usage: releasePrebuiltDist.cjs capture --dist <dir> --output <file> | verify --dist <dir> --manifest <file>");
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MANIFEST_VERSION,
  inspectPrebuiltDist,
  verifyPrebuiltDist,
};
