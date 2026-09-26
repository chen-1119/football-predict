"use strict";

// Only exact, audited source scanners or isolated fixtures are eligible. This is not a generic
// "skip verification" switch: changed verifier code and unknown commands run.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const VERSION = "static-verification-receipt-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const PROFILES = Object.freeze({
  "scripts/verifyBetSlipRecommendationGate.cjs": Object.freeze({
    auditedSha256: "783fe09683a9ee0fddb4b4e9ac23ab570ada27b1d0f67ac5324a7cf8b2f3b8eb",
    files: ["src/services/generator.ts", "src/pages/BetSlipGenerator.tsx", "src/components/recommendations/RecommendationCenter.tsx", "src/services/recommendationCenterView.ts"],
    trees: [],
  }),
  "scripts/verifyFrontendEvidenceSemantics.cjs": Object.freeze({
    auditedSha256: "fc2c54d0157292e6a06087a70dd87652d49b1f66ab727428dfd7021e422f6346",
    files: ["server/index.cjs", "src/services/publishedRecommendationStatus.cjs"],
    // Entire src tree, including membership, nested paths, CSS and TS/TSX.
    // TS/TSX is only scanned. The no-import status helper is the sole executed
    // application module and must match its separately audited code hash.
    trees: ["src"],
    auditedModules: Object.freeze({
      "src/services/publishedRecommendationStatus.cjs": "03d869c32b22eefcdcca519fac3e6d408c5c21ede5458fce175e4fc6e186b384",
    }),
  }),
  "scripts/verifySelectedJsonObjectFile.cjs": Object.freeze({
    auditedSha256: "f1d8b0db55c699ad692f56b07375031a73b1f9ac7586ec1fa0a0c4ac70376b39",
    files: ["server/selectedJsonObjectFile.cjs", "server/dataGenerationStore.cjs", "server/chunkedJsonFile.cjs"],
    trees: [],
    // These CJS modules execute; pin their audited code as well as hashing
    // actual input bytes. A newly introduced dependency requires a new audit.
    auditedModules: Object.freeze({
      "server/selectedJsonObjectFile.cjs": "93bb9b7144e283a8ad54669d2ff5851eecb72ea4fc9553350169b51decaf4d99",
      "server/dataGenerationStore.cjs": "d4560309af14336d90fc24903b321c8374c1574a492e4cb8f27bfe2cb71875fb",
      "server/chunkedJsonFile.cjs": "da65cde36f12868209d29f830d49c2ba37c27e6931e3a46dfac1a02d799705c3",
    }),
    absentEnvironment: ["VERIFY_SELECTED_JSON_SKIP_LARGE"],
    resultContract: "selected-json-complete-v1",
  }),
});
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const serialize = value => JSON.stringify(canonical(value));
const hashValue = value => digest(serialize(value));

function regularFile(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === "." || p === "..")) {
    throw new Error("unsafe dependency path");
  }
  const full = path.join(root, relative);
  // Reject symlinks/junctions in every component, not just the final file.
  let cursor = root;
  for (const part of relative.split(/[\\/]/)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("linked dependency");
  }
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.size > 16 * MAX_BYTES) throw new Error("invalid dependency file");
  return fs.readFileSync(full);
}

function collectInputs(root, args, env = {}) {
  const profile = args.length === 1 ? PROFILES[args[0]] : null;
  if (!profile) return null;
  if ((profile.absentEnvironment || []).some(name => env[name])) return null;
  root = fs.realpathSync(root);
  const entry = regularFile(root, args[0]);
  if (digest(entry.toString("utf8").replace(/\r\n?/g, "\n")) !== profile.auditedSha256) return null;
  for (const [name, sha] of Object.entries(profile.auditedModules || {})) {
    if (digest(regularFile(root, name).toString("utf8").replace(/\r\n?/g, "\n")) !== sha) return null;
  }
  const names = new Set([args[0], "package.json", "package-lock.json", ...profile.files]);
  const memberships = [];
  function walk(relative) {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("linked source directory");
    const entries = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    memberships.push([relative, entries.map(e => [e.name, e.isDirectory() ? "directory" : "file"])]);
    for (const e of entries) {
      if (e.isSymbolicLink()) throw new Error("linked source entry");
      const name = `${relative}/${e.name}`;
      if (e.isDirectory()) walk(name); else names.add(name);
      if (names.size + memberships.length > 5000) throw new Error("dependency count cap");
    }
  }
  profile.trees.forEach(walk);
  const files = [...names].sort().map(name => [name, digest(regularFile(root, name))]);
  // Policy/runner changes also invalidate old receipts; do not only hash tests.
  files.push(["receipt-policy", digest(fs.readFileSync(__filename))]);
  return { version: VERSION, command: args, files, memberships, profile: profile.auditedSha256,
    resultContract: profile.resultContract || "all-green-checks-v1" };
}

function success(result, inputs) {
  try {
    if (!(result?.status === 0 && result.timedOut !== true && result.body?.ok === true
      && typeof result.stdout === "string" && Buffer.byteLength(result.stdout) < MAX_BYTES
      && hashValue(JSON.parse(result.stdout)) === hashValue(result.body))) return false;
    if (inputs?.resultContract === "selected-json-complete-v1") {
      const body = result.body, evidence = body.largeEvidence?.evidence;
      const expectedBytes = 472 * 1024 * 1024 + Buffer.byteLength(
        '{"ignored":"","keep":{"x":"中😀","n":[1,true,null],"bulk":""},"updatedAt":"2026-09-07"}');
      return inputs.command?.length === 1 && inputs.command[0] === "scripts/verifySelectedJsonObjectFile.cjs"
        && inputs.profile === PROFILES[inputs.command[0]].auditedSha256
        && body.checks === 10 && Array.isArray(body.cases) && body.cases.length === 10
        && hashValue(body.cases) === "a883c248ada1a2297807fb1515a33d2a4f33f3b7cbde1493edc0b93843abe4f7"
        && evidence?.bytes === expectedBytes && /^[a-f0-9]{64}$/.test(evidence.sha256)
        && evidence.selectedChars >= 32 * 1024 * 1024 && evidence.selectedChars < 33 * 1024 * 1024
        && evidence.maxObservedDepth === 3
        && hashValue(evidence.selectedKeys) === hashValue(["keep", "updatedAt"])
        && Number.isFinite(body.largeEvidence.maxRssKiB) && body.largeEvidence.maxRssKiB > 0
        && body.largeEvidence.maxRssKiB < 320 * 1024;
    }
    if (inputs?.resultContract && inputs.resultContract !== "all-green-checks-v1") return false;
    return Array.isArray(result.body.checks) && result.body.checks.length > 0
      && result.body.checks.every(check => check?.ok === true);
  } catch { return false; }
}

function sealReceipt({ identity, result, key, now = Date.now(), elapsedMs }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !success(result, identity.inputs)) throw new Error("not a successful verifier result");
  const payload = { version: VERSION, identity, checkedAt: now, elapsedMs,
    result: { status: 0, body: result.body, stdout: result.stdout, stderr: "", timedOut: false } };
  return { payload, mac: crypto.createHmac("sha256", key).update(serialize(payload)).digest("hex") };
}

function openReceipt(receipt, { identity, key, now = Date.now() }) {
  try {
    const p = receipt.payload;
    if (p.version !== VERSION || !Number.isFinite(p.checkedAt) || p.checkedAt > now
      || now - p.checkedAt > MAX_AGE_MS || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0
      || hashValue(p.identity) !== hashValue(identity) || !success(p.result, identity.inputs)
      || !/^[a-f0-9]{64}$/.test(receipt.mac)) return null;
    const mac = crypto.createHmac("sha256", key).update(serialize(p)).digest();
    if (!crypto.timingSafeEqual(mac, Buffer.from(receipt.mac, "hex"))) return null;
    return { ...p.result, verificationReceipt: { reused: true, verifiedAt: p.checkedAt,
      observedAt: now, originalElapsedMs: p.elapsedMs, identityHash: hashValue(identity) } };
  } catch { return null; }
}

function privateStore(directory) {
  // No unverified Windows ACL assumption: that platform executes fresh checks.
  if (process.platform !== "linux" || typeof process.getuid !== "function"
    || !path.isAbsolute(directory)) return null;
  const resolved = fs.realpathSync(directory);
  if (resolved !== path.resolve(directory) || resolved === path.parse(resolved).root) return null;
  const uid = process.getuid(), stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) return null;
  // A writable ancestor could substitute the private directory between checks.
  for (let parent = path.dirname(resolved); ; parent = path.dirname(parent)) {
    const p = fs.lstatSync(parent);
    if (!p.isDirectory() || p.isSymbolicLink() || (p.uid !== 0 && p.uid !== uid)
      || (p.mode & 0o022) !== 0) return null;
    if (parent === path.parse(parent).root) break;
  }
  const keyPath = path.join(resolved, "receipt.key");
  if (!fs.existsSync(keyPath)) {
    try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const safeRead = (name, max) => {
    const file = path.join(resolved, name);
    const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(handle);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== uid
        || (s.mode & 0o777) !== 0o600 || s.size > max) throw new Error("unsafe receipt file");
      const bytes = fs.readFileSync(handle);
      if (bytes.length !== s.size || bytes.length > max) throw new Error("receipt changed during read");
      return bytes;
    } finally { fs.closeSync(handle); }
  };
  const key = safeRead("receipt.key", 32);
  if (key.length !== 32) return null;
  return { key, read: name => safeRead(name, MAX_BYTES),
    write: (name, bytes) => {
      // Create-only receipts: a conflicting existing artifact is never replaced.
      if (Buffer.byteLength(bytes) > MAX_BYTES) return false;
      try { fs.writeFileSync(path.join(resolved, name), bytes, { flag: "wx", mode: 0o600 }); return true; }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
    } };
}

async function runWithStaticReceipt({ rootDir, args, env, execute }) {
  if (env.VERIFY_STATIC_ATTESTATION_DIR) {
    // Lazy import avoids a module-init cycle: the root attestor uses the same
    // exact input/result contracts, while its private key never leaves root.
    try {
      const attested = require("./rootStaticVerificationAttestations.cjs").readRootAttestation({ rootDir, args, env });
      if (attested) return attested;
    } catch { /* Missing attestor code/evidence is a miss, not a passed check. */ }
    // A failed root handoff must not downgrade to a service-writable HMAC cache.
    return execute();
  }
  let inputs, identity, store, name;
  const startedAt = Date.now();
  try {
    // Explicit operator provisioning and per-release identity are required.
    // Any uncertain configuration falls back to the unchanged real verifier.
    if (!/^[a-f0-9]{64}$/.test(env.VERIFY_STATIC_RELEASE_SHA || "")
      || !env.VERIFY_STATIC_RECEIPT_DIR || env.NODE_OPTIONS || env.NODE_PATH
      || process.execArgv.length > 0) return execute();
    inputs = collectInputs(rootDir, args, env);
    if (!inputs) return execute();
    store = privateStore(env.VERIFY_STATIC_RECEIPT_DIR);
    if (!store) return execute();
    identity = { inputs, releaseSha: env.VERIFY_STATIC_RELEASE_SHA,
      runtime: { node: process.versions, platform: process.platform, arch: process.arch,
        osRelease: os.release(), nodeBinarySha256: digest(fs.readFileSync(process.execPath)),
        locale: { TZ: env.TZ || null, LANG: env.LANG || null, LC_ALL: env.LC_ALL || null } } };
    name = `${hashValue(identity)}.json`;
    const receipt = openReceipt(JSON.parse(store.read(name)), { identity, key: store.key });
    if (receipt && hashValue(collectInputs(rootDir, args, env)) === hashValue(inputs)) return receipt;
  } catch { /* Missing/invalid evidence cannot turn a failed test into a pass. */ }
  const result = await execute();
  try {
    if (store && identity && name && success(result, inputs)
      && hashValue(collectInputs(rootDir, args, env)) === hashValue(inputs)) {
      const receipt = sealReceipt({ identity, result, key: store.key, elapsedMs: Date.now() - startedAt });
      const written = store.write(name, serialize(receipt));
      return { ...result, verificationReceipt: { reused: false, written, identityHash: hashValue(identity) } };
    }
  } catch { /* Receipt storage is an optimization, never a new release gate. */ }
  return result;
}

module.exports = { VERSION, MAX_AGE_MS, PROFILES, collectInputs, hashValue, success,
  sealReceipt, openReceipt, privateStore, runWithStaticReceipt };
