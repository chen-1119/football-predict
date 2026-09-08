"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { INVENTORY_VERSION, LIMITS, validateInventory } = require("./releaseChangeClassification.cjs");
const VERSION = "release-archive-source-evidence-v1";
const MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_TAR_BYTES = LIMITS.totalBytes + LIMITS.entries * 1024;
const MAX_PAX_BYTES = 64 * 1024;
const MAX_CAPTURE_MS = 30_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const stamp = info => [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(":");

function octal(bytes, label) {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`unsupported-or-invalid-tar-${label}`);
  const number = parseInt(text || "0", 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid-tar-${label}`);
  return number;
}

function headerText(bytes) {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && bytes.subarray(nul).some(value => value !== 0)) throw new Error("nonzero-after-tar-string-terminator");
  return utf8.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}

function normalizedMember(name, kind) {
  let relative = name.startsWith("./") ? name.slice(2) : name;
  if (kind === "directory" && relative.endsWith("/")) relative = relative.slice(0, -1);
  if (!relative || relative.length > 1024 || relative !== relative.normalize("NFC")
    || /[\\:\x00-\x1f\x7f]/.test(relative)) throw new Error("unsafe-tar-member");
  const parts = relative.split("/");
  if (parts.length > LIMITS.depth || parts.some(part => !part || part === "." || part === ".."
    || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("unsafe-tar-member");
  }
  return relative;
}

function parsePax(bytes, global = false) {
  const result = {};
  let offset = 0;
  const allowed = new Set(["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 8) throw new Error("invalid-pax-record-length");
    const rawLength = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(rawLength)) throw new Error("invalid-pax-record-length");
    const length = Number(rawLength);
    if (length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error("truncated-pax-record");
    }
    const record = utf8.decode(bytes.subarray(space + 1, offset + length - 1));
    const separator = record.indexOf("=");
    const key = record.slice(0, separator), value = record.slice(separator + 1);
    if (separator <= 0 || !allowed.has(key) || Object.hasOwn(result, key) || !value || value.includes("\0")) {
      throw new Error("unsupported-or-duplicate-pax-key");
    }
    if (global && ["path", "size"].includes(key)) throw new Error("unsafe-global-pax-member-override");
    result[key] = value;
    offset += length;
  }
  return result;
}

function createTarInventoryParser() {
  const entries = [], aliases = new Set();
  let headers = 0, totalBytes = 0, tarBytes = 0, zeroBlocks = 0;
  let headerPending = Buffer.alloc(0), current = null, padding = 0;
  let localPax = null, globalPax = {}, longName = null;
  const finishPayload = () => {
    if (current.meta) {
      const bytes = Buffer.concat(current.chunks);
      if (current.meta === "x") {
        if (localPax) throw new Error("duplicate-pending-pax-header");
        localPax = parsePax(bytes);
      } else if (current.meta === "g") globalPax = { ...globalPax, ...parsePax(bytes, true) };
      else {
        if (longName !== null || !bytes.length || bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0)) {
          throw new Error("invalid-gnu-long-name");
        }
        longName = utf8.decode(bytes.subarray(0, -1));
      }
    } else if (current.row.kind === "file") {
      current.row.sha256 = current.hash.digest("hex"); entries.push(current.row);
    } else entries.push(current.row);
    padding = (512 - current.size % 512) % 512;
    current = null;
  };
  const acceptHeader = header => {
    if (header.every(value => value === 0)) { zeroBlocks++; return; }
    if (zeroBlocks) throw new Error("nonzero-tar-content-after-terminator");
    if (++headers > LIMITS.entries * 2) throw new Error("tar-header-limit");
    const expected = octal(header.subarray(148, 156), "checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== expected) throw new Error("tar-header-checksum-mismatch");
    const magic = header.subarray(257, 263).toString("ascii");
    if (!["ustar\0", "ustar "].includes(magic)) throw new Error("unsupported-tar-format");
    const type = String.fromCharCode(header[156] || 48);
    let size = octal(header.subarray(124, 136), "size");
    const mode = octal(header.subarray(100, 108), "mode");
    if (mode > 0o777) throw new Error("unsafe-tar-permission-bits");
    if (headerText(header.subarray(157, 257))) throw new Error("tar-link-target-forbidden");
    const prefix = magic === "ustar\0" ? headerText(header.subarray(345, 500)) : "";
    let name = [prefix, headerText(header.subarray(0, 100))].filter(Boolean).join("/");
    if (["x", "g", "L"].includes(type)) {
      if (size <= 0 || size > MAX_PAX_BYTES) throw new Error("tar-metadata-size-limit");
      current = { meta: type, size, remaining: size, chunks: [] }; return;
    }
    if (!["0", "5"].includes(type)) throw new Error("tar-link-or-special-member-forbidden");
    const pax = { ...globalPax, ...(localPax || {}) };
    if (longName !== null && Object.hasOwn(pax, "path")) throw new Error("ambiguous-extended-member-name");
    name = longName ?? pax.path ?? name;
    if (Object.hasOwn(pax, "size")) {
      if (!/^(0|[1-9][0-9]*)$/.test(pax.size)) throw new Error("invalid-pax-member-size");
      size = Number(pax.size);
    }
    localPax = null; longName = null;
    const kind = type === "5" ? "directory" : "file";
    const relative = normalizedMember(name, kind);
    if (aliases.has(relative.toLowerCase())) throw new Error("duplicate-or-aliased-tar-member");
    aliases.add(relative.toLowerCase());
    if (aliases.size > LIMITS.entries) throw new Error("tar-entry-limit");
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes || totalBytes + size > LIMITS.totalBytes
      || (kind === "directory" && size !== 0)) throw new Error("tar-member-byte-limit");
    totalBytes += size;
    const row = kind === "file" ? { path: relative, kind, mode, bytes: size } : { path: relative, kind, mode };
    current = { row, size, remaining: size, hash: kind === "file" ? crypto.createHash("sha256") : null };
    if (!size) finishPayload();
  };
  return {
    write(chunk) {
      tarBytes += chunk.length;
      if (tarBytes > MAX_TAR_BYTES) throw new Error("expanded-tar-byte-limit");
      let offset = 0;
      while (offset < chunk.length) {
        if (current) {
          const count = Math.min(current.remaining, chunk.length - offset);
          const bytes = chunk.subarray(offset, offset + count);
          if (current.meta) current.chunks.push(Buffer.from(bytes)); else if (current.hash) current.hash.update(bytes);
          current.remaining -= count; offset += count;
          if (!current.remaining) finishPayload();
        } else if (padding) {
          const count = Math.min(padding, chunk.length - offset);
          if (chunk.subarray(offset, offset + count).some(value => value !== 0)) throw new Error("nonzero-tar-entry-padding");
          padding -= count; offset += count;
        } else {
          const count = Math.min(512 - headerPending.length, chunk.length - offset);
          headerPending = Buffer.concat([headerPending, chunk.subarray(offset, offset + count)]); offset += count;
          if (headerPending.length === 512) { acceptHeader(headerPending); headerPending = Buffer.alloc(0); }
        }
      }
    },
    finish() {
      if (current || padding || headerPending.length || zeroBlocks < 2 || localPax || longName !== null) throw new Error("incomplete-tar-archive");
      entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const body = { version: INVENTORY_VERSION, entries, entryCount: entries.length,
        fileCount: entries.filter(row => row.kind === "file").length, totalBytes };
      return validateInventory({ ...body, treeHash: digest(body) });
    },
  };
}

async function captureReleaseArchiveSourceEvidence(bundlePath) {
  const before = fs.lstatSync(bundlePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size <= 0 || before.size > MAX_COMPRESSED_BYTES) throw new Error("non-plain-or-oversized-release-archive");
  // FileHandle owns the descriptor state. A raw numeric fd plus destroy() and
  // closeSync() can schedule a second asynchronous close after that number has
  // already been reused by an unrelated caller.
  const handle = await fs.promises.open(bundlePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let source, gunzip, timer, sourceClosed, gunzipClosed, sourceError, failed = false;
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw new Error("archive-changed-before-read");
    const archiveHash = crypto.createHash("sha256"), parser = createTarInventoryParser();
    let archiveBytes = 0;
    source = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, start: 0, end: before.size - 1 });
    sourceClosed = new Promise(resolve => source.once("close", resolve));
    gunzip = zlib.createGunzip({ chunkSize: 64 * 1024 });
    gunzipClosed = new Promise(resolve => gunzip.once("close", resolve));
    source.on("data", chunk => { archiveHash.update(chunk); archiveBytes += chunk.length; });
    source.on("error", error => { sourceError = error; gunzip.destroy(error); });
    timer = setTimeout(() => { source.destroy(new Error("archive-capture-timeout")); gunzip.destroy(new Error("archive-capture-timeout")); }, MAX_CAPTURE_MS);
    source.pipe(gunzip);
    for await (const chunk of gunzip) parser.write(chunk);
    if (archiveBytes !== before.size || stamp(await handle.stat()) !== stamp(before)
      || stamp(fs.lstatSync(bundlePath)) !== stamp(before)) throw new Error("archive-changed-during-read");
    const inventory = parser.finish();
    return { version: VERSION, archiveSha256: archiveHash.digest("hex"), archiveBytes,
      archiveEntryCount: inventory.entryCount, inventory, inventorySha256: inventory.treeHash,
      frontendBuildBinding: null, frontendBuildBindingSha256: null,
      buildBindingStatus: "unavailable-input-tree-not-sealed", executionMode: "full" };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    clearTimeout(timer);
    source?.destroy(); gunzip?.destroy();
    // close events follow completion of pending stream I/O and its FileHandle
    // close. Wait before returning, then use the same handle's idempotent close
    // for pre-stream failures as well. Never independently close its numeric fd.
    await Promise.all([sourceClosed, gunzipClosed]);
    await handle.close();
    if (!failed && sourceError) throw sourceError;
  }
}

function validateSignedArchiveSourceEvidence(manifest) {
  if (!Object.hasOwn(manifest, "archiveSourceEvidence")) return { status: "legacy-unavailable", executionMode: "full" };
  const evidence = manifest.archiveSourceEvidence;
  if (!exactKeys(evidence, ["version", "archiveSha256", "archiveBytes", "archiveEntryCount", "inventory", "inventorySha256",
    "frontendBuildBinding", "frontendBuildBindingSha256", "buildBindingStatus", "executionMode"])
    || evidence.version !== VERSION || evidence.executionMode !== "full"
    || evidence.frontendBuildBinding !== null || evidence.frontendBuildBindingSha256 !== null
    || evidence.buildBindingStatus !== "unavailable-input-tree-not-sealed") throw new Error("invalid-signed-archive-source-evidence");
  validateInventory(evidence.inventory);
  if (evidence.archiveSha256 !== manifest.sha256 || !/^[a-f0-9]{64}$/.test(evidence.archiveSha256)
    || !Number.isSafeInteger(evidence.archiveBytes) || evidence.archiveBytes <= 0 || evidence.archiveBytes > MAX_COMPRESSED_BYTES
    || evidence.archiveBytes !== manifest.bytes || evidence.archiveEntryCount !== manifest.entries
    || evidence.archiveEntryCount !== evidence.inventory.entryCount || evidence.inventorySha256 !== evidence.inventory.treeHash) {
    throw new Error("signed-archive-source-binding-mismatch");
  }
  return { status: "authenticated-inventory-build-unavailable", executionMode: "full", inventorySha256: evidence.inventorySha256 };
}

async function verifyArchiveSourceEvidence(bundlePath, manifest) {
  const result = validateSignedArchiveSourceEvidence(manifest);
  if (result.status === "legacy-unavailable") return result;
  const actual = await captureReleaseArchiveSourceEvidence(bundlePath);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.archiveSourceEvidence)) throw new Error("actual-archive-source-evidence-mismatch");
  return { ...result, archiveSha256: actual.archiveSha256, archiveEntryCount: actual.archiveEntryCount };
}

module.exports = { VERSION, createTarInventoryParser, captureReleaseArchiveSourceEvidence,
  validateSignedArchiveSourceEvidence, verifyArchiveSourceEvidence };
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== "capture") {
    process.stderr.write("usage: releaseArchiveSourceInventory.cjs capture <archive.tgz>\n"); process.exitCode = 1;
  } else captureReleaseArchiveSourceEvidence(process.argv[3]).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
