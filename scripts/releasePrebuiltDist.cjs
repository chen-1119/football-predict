"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_VERSION = "release-prebuilt-dist-v1";
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

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

const inspectPrebuiltDist = (distInput) => {
  const distDir = path.resolve(distInput);
  const rootInfo = fs.lstatSync(distDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`prebuilt dist is not a plain directory: ${distDir}`);
  }
  const files = [];
  const pending = [distDir];
  while (pending.length) {
    const current = pending.pop();
    for (const name of fs.readdirSync(current).sort((left, right) => left.localeCompare(right, "en"))) {
      const absolutePath = path.join(current, name);
      const info = fs.lstatSync(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`prebuilt dist contains a symlink: ${absolutePath}`);
      if (info.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`prebuilt dist contains a non-plain file: ${absolutePath}`);
      }
      const relativePath = assertSafeRelative(path.relative(distDir, absolutePath));
      const bytes = fs.readFileSync(absolutePath);
      files.push(Object.freeze({
        path: relativePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
      }));
      if (files.length > MAX_FILES) throw new Error(`prebuilt dist exceeds ${MAX_FILES} files`);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (!files.length || !files.some((entry) => entry.path === "index.html")) {
    throw new Error("prebuilt dist is empty or missing index.html");
  }
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`prebuilt dist byte size is outside policy: ${totalBytes}`);
  }
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
  const info = fs.lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`prebuilt dist manifest is unsafe: ${manifestPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
