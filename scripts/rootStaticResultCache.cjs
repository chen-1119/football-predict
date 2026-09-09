"use strict";
// Root-only reuse between releases, restricted to the existing audited pure
// profiles. A new per-release Ed25519 attestation is still issued by root.
const fs = require("node:fs"), path = require("node:path");
const { privateStore, hashValue, sealReceipt, openReceipt, MAX_AGE_MS } = require("./staticVerificationReceipts.cjs");
const DIRECTORY = "/var/lib/football-release/static-result-cache";
function cacheIdentity(identity, now = Date.now()) {
  const { releaseSha, ...sourceAndRuntime } = identity;
  if (!/^[a-f0-9]{64}$/.test(releaseSha || "")) throw new Error("invalid-release-identity");
  return { ...sourceAndRuntime, cacheVersion: "root-static-result-cache-v1", epoch: Math.floor(now / MAX_AGE_MS),
    cachePolicyHash: hashValue(fs.readFileSync(__filename).toString("utf8")) };
}
function openRootResultCache() {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0) return null;
    require("./rootStaticVerificationAttestations.cjs").protectedRootPath(path.dirname(DIRECTORY), { directory: true });
    try { fs.mkdirSync(DIRECTORY, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (fs.readdirSync(DIRECTORY).length > 4096) return null;
    const store = privateStore(DIRECTORY); if (!store) return null;
    return {
      read(identity, now = Date.now()) {
        try {
          const input = cacheIdentity(identity, now), record = JSON.parse(store.read(`${hashValue(input)}.json`));
          const result = openReceipt(record, { identity: input, key: store.key, now });
          return result ? { result, checkedAt: record.payload.checkedAt, elapsedMs: record.payload.elapsedMs } : null;
        } catch { return null; }
      },
      write(identity, result, elapsedMs, checkedAt = Date.now()) {
        try {
          const input = cacheIdentity(identity, checkedAt);
          const record = sealReceipt({ identity: input, result, key: store.key, now: checkedAt, elapsedMs });
          return store.write(`${hashValue(input)}.json`, JSON.stringify(record));
        } catch { return false; }
      },
    };
  } catch { return null; }
}
module.exports = { DIRECTORY, cacheIdentity, openRootResultCache };
