"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { BOOTSTRAP_SHA, LEGACY_UNACCEPTED, NATIVE_SELECTORS } = require("./nativeReleaseJournal.cjs");
function validateNativeReleasePolicy(policy) {
  assert.deepEqual(Object.keys(policy).sort(), ["bootstrapSha256", "legacyUnaccepted", "storageMode", "transactionVersion", "version"]);
  assert.equal(policy.version, "native-release-policy-v1");
  assert.equal(policy.storageMode, "postgres-only"); assert.equal(policy.transactionVersion, 4);
  assert.match(BOOTSTRAP_SHA || "", /^[a-f0-9]{64}$/, "native release requires accepted bootstrap proof");
  assert.equal(policy.bootstrapSha256, BOOTSTRAP_SHA);
  assert.equal(Object.keys(policy.legacyUnaccepted || {}).sort().join(), "bundleSha256,serverIndexSha256",
    "unaccepted source policy has unexpected fields");
  for (const field of ["bundleSha256", "serverIndexSha256"])
    assert.equal(policy.legacyUnaccepted[field], LEGACY_UNACCEPTED[field], "unaccepted source must be exactly pinned in signed policy");
  return { ok: true, lane: "postgres-only", transactionVersion: 4, bootstrapSha256: BOOTSTRAP_SHA };
}
function validateNativeRuntimeEnvironment(content, identity) {
  assert.match(identity?.bundleMarker || "", /^[a-f0-9]{64}$/);
  const legacy = identity.liveMarker === "-";
  if (legacy) {
    assert.equal(identity.bundleMarker, LEGACY_UNACCEPTED.bundleSha256, "unaccepted source marker changed");
    assert.equal(identity.serverIndexSha256, LEGACY_UNACCEPTED.serverIndexSha256, "unaccepted source code changed");
  } else assert.equal(identity.liveMarker, identity.bundleMarker, "runtime live acceptance is missing");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    assert.ok(match, "runtime environment grammar is invalid");
    if (![...Object.keys(NATIVE_SELECTORS), "FOOTBALL_POSTGRES_URL", "DATABASE_URL"].includes(match[1])) continue;
    assert.equal(values[match[1]], undefined, "duplicate native runtime selector");
    let value = match[2].trim();
    if (/^["']/.test(value)) { assert.equal(value.at(-1), value[0]); value = value.slice(1, -1); }
    values[match[1]] = value;
  }
  if (values.FOOTBALL_STORAGE_MODE === "postgres-only") {
    assert.equal(require("../server/storageMode.cjs").readStorageMode(values).postgresOnly, true);
    return { ok: true, kind: "runtime-only", legacyUnaccepted: legacy };
  }
  require("./releaseStoragePreflight.cjs").assertLegacyStorageEnvironment(content);
  assert.equal(identity.bundleMarker, BOOTSTRAP_SHA, "hybrid source is not the accepted native-capable bootstrap");
  assert.equal(identity.liveMarker, identity.bundleMarker, "bootstrap live acceptance is missing");
  return { ok: true, kind: "initial-cutover" };
}
function readPolicy(file) {
  const st = fs.lstatSync(file); assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size < 4096);
  return validateNativeReleasePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}
module.exports = { validateNativeReleasePolicy, validateNativeRuntimeEnvironment, readPolicy };
if (require.main === module) {
  try { assert.equal(process.argv.length, 3); assert.equal(path.resolve(process.argv[2]), path.resolve(__dirname, "../deploy/light-server/native-release-policy.json"));
    console.log(JSON.stringify(readPolicy(process.argv[2])));
  } catch (error) { console.error(JSON.stringify({ ok: false, phase: "native-release-policy", error: error.message })); process.exitCode = 1; }
}
