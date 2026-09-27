"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const MAX_FILE_JSON_BYTES = 768 * 1024 * 1024;
const FILE_JSON_CHUNK_BYTES = 256 * 1024;
// Only this factory can admit a file. A JSON object containing a path must never
// turn into a filesystem read when it reaches the ordinary projection writer.
const admitted = new WeakMap();
const failure = (message, code = "POSTGRES_FILE_JSON_INVALID") => Object.assign(new Error(message), { code });
const signature = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const regularSingleFile = stat => stat.isFile() && stat.nlink === 1n;

const openChecked = (filePath, expected) => {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!regularSingleFile(before)) throw failure("JSON payload must be a regular single-link file");
  // O_NOFOLLOW is unavailable on Windows. The lstat/fstat identity checks also
  // reject final-component symlinks and replacements on that platform.
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const after = fs.lstatSync(filePath, { bigint: true });
    if (!regularSingleFile(opened) || !regularSingleFile(after)
      || signature(before) !== signature(opened) || signature(after) !== signature(opened)
      || (expected && signature(opened) !== expected)) {
      throw failure("JSON payload file changed before reading", "POSTGRES_FILE_JSON_CHANGED");
    }
    return { fd, stat: opened };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
};

const createFileJsonPayload = (filePath, { bytes, sha256, maxBytes = MAX_FILE_JSON_BYTES } = {}) => {
  if (typeof filePath !== "string" || !filePath || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1 || maxBytes > MAX_FILE_JSON_BYTES || !Number.isSafeInteger(bytes)
    || bytes < 1 || bytes > maxBytes || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw failure("Invalid bounded JSON payload descriptor");
  }
  const resolved = path.resolve(filePath);
  const { fd, stat } = openChecked(resolved);
  try {
    if (stat.size !== BigInt(bytes)) throw failure("JSON payload size does not match descriptor", "POSTGRES_FILE_JSON_SIZE_MISMATCH");
    const payload = Object.freeze({ filePath: resolved, bytes, sha256, maxBytes });
    admitted.set(payload, signature(stat));
    return payload;
  } finally {
    fs.closeSync(fd);
  }
};

const isFileJsonPayload = payload => Boolean(payload && admitted.has(payload));

async function* fileJsonPayloadChunks(payload, { onBytes } = {}) {
  if (!isFileJsonPayload(payload)) throw failure("Unbranded JSON file payload");
  if (onBytes !== undefined && typeof onBytes !== "function") throw failure("Invalid JSON payload byte observer");
  const expected = admitted.get(payload);
  const { fd } = openChecked(payload.filePath, expected);
  const rawHash = crypto.createHash("sha256"), textHash = crypto.createHash("sha256");
  const decoder = new StringDecoder("utf8");
  // The decoder can carry at most three UTF-8 bytes into the next chunk.
  const buffer = Buffer.allocUnsafe(FILE_JSON_CHUNK_BYTES - 3);
  let bytes = 0;
  try {
    for (;;) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      bytes += length;
      if (bytes > payload.bytes || bytes > payload.maxBytes) {
        throw failure("JSON payload exceeds admitted byte limit", "POSTGRES_FILE_JSON_SIZE_MISMATCH");
      }
      const raw = buffer.subarray(0, length);
      rawHash.update(raw);
      if (onBytes) onBytes(raw);
      const piece = decoder.write(raw);
      textHash.update(piece);
      if (piece) yield piece;
    }
    const tail = decoder.end();
    textHash.update(tail);
    if (tail) yield tail;
    const after = fs.lstatSync(payload.filePath, { bigint: true });
    if (!regularSingleFile(after) || signature(fs.fstatSync(fd, { bigint: true })) !== expected
      || signature(after) !== expected) {
      throw failure("JSON payload file changed while reading", "POSTGRES_FILE_JSON_CHANGED");
    }
    if (bytes !== payload.bytes) throw failure("JSON payload byte count changed", "POSTGRES_FILE_JSON_SIZE_MISMATCH");
    const digest = rawHash.digest("hex");
    if (digest !== payload.sha256) throw failure("JSON payload hash does not match descriptor", "POSTGRES_FILE_JSON_HASH_MISMATCH");
    if (textHash.digest("hex") !== digest) throw failure("JSON payload is not lossless UTF-8", "POSTGRES_FILE_JSON_UTF8_INVALID");
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { createFileJsonPayload, isFileJsonPayload, fileJsonPayloadChunks, MAX_FILE_JSON_BYTES, FILE_JSON_CHUNK_BYTES };
