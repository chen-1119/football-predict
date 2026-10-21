"use strict";

// The administrator enrolls this fixed, root-owned trust store. Public keys
// supplied in release archives or requests are never trust authorities.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = "football-release-signing-trust-v1";
const LEGACY = "/etc/football-release/signing-public.pem";
const STORE = "/etc/football-release/signing-trust-v1";
const JOURNAL = "/var/lib/football-release/trust-recovery";
const SEQUENCE = "/var/lib/football-release/highest-accepted-sequence";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(reason) { throw new Error("RELEASE_SIGNING_TRUST: " + reason); }
function exact(value, fields) {
  if (!value || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) fail("fields");
}
function iso(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("clock"); }
function key(bytes) {
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(bytes.toString("utf8"))) fail("public key PEM");
  const value = crypto.createPublicKey(bytes), bits = value.asymmetricKeyDetails?.modulusLength;
  if (value.asymmetricKeyType !== "rsa" || !Number.isSafeInteger(bits) || bits < 3072 || bits > 8192) fail("RSA key");
  return { key: value, keyId: hash(value.export({ type: "spki", format: "der" })), bytes, sha256: hash(bytes) };
}
function reader(options = {}) {
  const prefix = options.fixtureRoot ? path.resolve(options.fixtureRoot) : "", owner = options.fixtureOwnerUid ?? 0;
  if (!prefix && owner !== 0) fail("fixed owner");
  if ((prefix && prefix === path.parse(prefix).root) || (prefix && !path.isAbsolute(prefix))) fail("fixture root");
  const locate = name => prefix ? path.join(prefix, name) : name;
  const stamp = s => [s.dev,s.ino,s.size,s.mode,s.uid,s.gid,s.nlink,s.mtimeMs,s.ctimeMs].join(":");
  function directory(file) {
    const end = prefix || path.parse(file).root;
    for (let at = file; ; at = path.dirname(at)) {
      const st = fs.lstatSync(at);
      if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(at) !== at
        || (process.platform !== "win32" && (st.uid !== owner || (st.mode & 0o022)))) fail("directory permissions");
      if (at === end) break;
      if (path.dirname(at) === at) fail("directory boundary");
    }
  }
  function read(name, maximum = 16384) {
    const file = locate(name); directory(path.dirname(file));
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maximum
      || (process.platform !== "win32" && (before.uid !== owner || (before.mode & 0o022)))) fail("file permissions or size");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (stamp(before) !== stamp(fs.fstatSync(fd))) fail("file replaced before read");
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length-offset, offset); if (!n) fail("short read"); offset += n; }
      if (stamp(before) !== stamp(fs.fstatSync(fd)) || stamp(before) !== stamp(fs.lstatSync(file))) fail("file changed during read");
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  return { locate, directory, read };
}
function loadReleaseSigningTrust(options = {}) {
  const r = reader(options), legacy = { ...key(r.read(LEGACY)), path: r.locate(LEGACY) };
  let absent = false;
  try { fs.lstatSync(r.locate(STORE)); } catch (error) { if (error.code !== "ENOENT") throw error; absent = true; }
  if (absent) return { version: "legacy-single-key", legacy, active: legacy, cutoverSequence: null, proof: legacy.sha256 };
  r.directory(r.locate(STORE));
  if (JSON.stringify(fs.readdirSync(r.locate(STORE)).sort()) !== JSON.stringify(["active-public.pem","legacy-public.pem","trust.json"])) fail("store members");
  const bytes = r.read(STORE + "/trust.json"), record = JSON.parse(bytes);
  exact(record,["version","enrollmentId","enrolledAt","cutoverSequence","legacy","active"]);
  if (record.version !== VERSION || !/^trust-recovery-[0-9]{13}-[a-f0-9]{16}$/.test(record.enrollmentId)) fail("record identity");
  iso(record.enrolledAt);
  if (!Number.isSafeInteger(record.cutoverSequence) || record.cutoverSequence < 1 || record.cutoverSequence >= Number.MAX_SAFE_INTEGER) fail("sequence boundary");
  for (const member of [record.legacy,record.active]) { exact(member,["keyId","sha256"]); if (![member.keyId,member.sha256].every(s=>typeof s==="string" && /^[a-f0-9]{64}$/.test(s))) fail("key descriptor"); }
  const retained = key(r.read(STORE + "/legacy-public.pem")), active = { ...key(r.read(STORE + "/active-public.pem")), path:r.locate(STORE + "/active-public.pem") };
  for (const [observed,expected] of [[legacy,record.legacy],[retained,record.legacy],[active,record.active]]) if (observed.keyId !== expected.keyId || observed.sha256 !== expected.sha256) fail("key binding");
  if (legacy.keyId === active.keyId) fail("same key");
  const receiptBytes = r.read(JOURNAL + "/" + record.enrollmentId + "/completed.json"), receipt = JSON.parse(receiptBytes);
  exact(receipt,["version","enrollmentId","trustSha256","completedAt","cutoverSequence","legacySha256","activeSha256"]);
  iso(receipt.completedAt);
  if (receipt.version !== VERSION || receipt.enrollmentId !== record.enrollmentId || receipt.trustSha256 !== hash(bytes)
    || receipt.cutoverSequence !== record.cutoverSequence || receipt.legacySha256 !== legacy.sha256 || receipt.activeSha256 !== active.sha256
    || Date.parse(receipt.completedAt) < Date.parse(record.enrolledAt)) fail("enrollment completion");
  const sequence = r.read(SEQUENCE).toString().trim();
  if (!/^[1-9][0-9]*$/.test(sequence) || !Number.isSafeInteger(Number(sequence)) || Number(sequence) < record.cutoverSequence) fail("sequence rollback");
  // Re-establish directory durability even if an administrator process died
  // after the final rename or completion write but before its directory fsync.
  if (process.platform !== "win32") for (const name of [STORE,"/etc/football-release",JOURNAL+"/"+record.enrollmentId,JOURNAL]) {
    const fd = fs.openSync(r.locate(name),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!r.read(STORE + "/trust.json").equals(bytes) || !r.read(LEGACY).equals(legacy.bytes)) fail("trust changed during read");
  return { version: VERSION, legacy, active, cutoverSequence:record.cutoverSequence, proof:hash(Buffer.concat([bytes,receiptBytes])), record };
}
function selectReleaseSigningKey(manifest, options = {}) {
  const trust = loadReleaseSigningTrust(options);
  if (!manifest) return { ...trust.active, proof:trust.proof };
  if (!Number.isSafeInteger(manifest.releaseSequence) || manifest.releaseSequence < 1) fail("manifest sequence");
  const selected = trust.cutoverSequence === null || manifest.releaseSequence <= trust.cutoverSequence ? trust.legacy : trust.active;
  if (manifest.signature?.keyId !== selected.keyId) fail("key outside sequence interval");
  return { ...selected, proof:trust.proof };
}
module.exports = { VERSION, LEGACY, STORE, JOURNAL, SEQUENCE, reader, key, hash, loadReleaseSigningTrust, selectReleaseSigningKey };
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== "active-path" || process.platform !== "linux" || process.getuid() !== 0) fail("fixed root CLI");
  process.stdout.write(selectReleaseSigningKey().path + "\n");
}
