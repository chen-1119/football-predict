"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const { readSelectedJsonObjectFile } = require("../server/selectedJsonObjectFile.cjs");
// A failed prefix probe must never cause an unbounded JSON.parse of the full
// snapshot warehouse. Hash the stable file in chunks, then strictly parse all
// JSON syntax while materializing only the complete observations property.
function readCandidatePublicObservations(filePath, { maxSelectedChars = 128 * 1024 * 1024, maxFileBytes = 2 * 1024 ** 3 } = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) fail("CANDIDATE_SNAPSHOT_FILE_BOUND", "snapshot file exceeds bounded object admission");
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  try {
    if (!same(before, fs.fstatSync(fd))) fail("GENERATION_FILE_CHANGED", "snapshot changed before hashing");
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break;
      bytesRead += n; if (bytesRead > before.size) fail("GENERATION_FILE_CHANGED", "snapshot grew while hashing");
      hash.update(buffer.subarray(0, n));
    }
    if (bytesRead !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(filePath))) fail("GENERATION_FILE_CHANGED", "snapshot changed while hashing");
  } finally { fs.closeSync(fd); }
  const result = readSelectedJsonObjectFile({ filePath, expectedBytes: before.size, expectedSha256: hash.digest("hex"), keys: ["observations"], maxSelectedChars });
  if (!same(before, fs.lstatSync(filePath))) fail("GENERATION_FILE_CHANGED", "snapshot changed during selected read");
  if (result.value.observations !== undefined && !Array.isArray(result.value.observations)) fail("CANDIDATE_OBSERVATIONS_INVALID", "snapshot observations must be an array");
  return { rows: result.value.observations || [], bytesRead: bytesRead + result.evidence.bytes, fileBytes: before.size,
    evidence: result.evidence };
}
module.exports = { readCandidatePublicObservations };
