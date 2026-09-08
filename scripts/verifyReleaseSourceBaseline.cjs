"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const baseline = require("./releaseSourceBaseline.cjs");
const { captureReleaseArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");
const { publicKeyId, signManifestBytes } = require("./releaseSigning.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

async function verifyReleaseSourceBaseline() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-source-baseline-")), checks = [];
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 }), other = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const pem = pair.publicKey.export({ format: "pem", type: "spki" }); let sequence = 1000;
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  const write = (file, bytes) => { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); fs.writeFileSync(file, bytes, { mode: 0o600 }); };
  function sealedWrite(file, bytes) { fs.chmodSync(file, 0o600); fs.writeFileSync(file, bytes); fs.chmodSync(file, 0o400); }
  async function fixture() {
    const id = ++sequence, work = path.join(root, "work-" + id), source = path.join(work, "source"), storeRoot = path.join(root, "store-" + id);
    fs.mkdirSync(work, { mode: 0o700 }); fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(path.join(source, "src"), { mode: 0o700 });
    write(path.join(source, "package.json"), '{"name":"signed-full-fixture"}\n');
    write(path.join(source, "src/App.tsx"), 'export default () => "reference only";\n');
    const archivePath = path.join(work, "original.tgz");
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", source, "./package.json", "./src"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr); fs.chmodSync(archivePath, 0o600);
    const evidence = await captureReleaseArchiveSourceEvidence(archivePath);
    const manifest = { ok: true, manifestVersion: 3, policyVersion: "release-secret-policy-v2", site: "football-predict", channel: "production",
      releaseSequence: id, createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sha256: evidence.archiveSha256, bytes: evidence.archiveBytes, entries: evidence.archiveEntryCount, archiveSourceEvidence: evidence,
      sensitiveEntries: [], blockedEntries: [], missingEntries: [], signature: { algorithm: "rsa-sha256-pkcs1-v1_5", keyId: publicKeyId(pair.publicKey), format: "detached-binary" } };
    const options = { sha256: manifest.sha256, sequence: id, site: manifest.site, channel: manifest.channel, archivePath, storeRoot,
      manifestPath: path.join(work, "manifest.json"), signaturePath: path.join(work, "manifest.sig"), publicKeyPath: path.join(work, "public.pem"),
      fixtureOwnerUid: process.platform === "win32" ? 0 : process.getuid(), fixtureTrustBoundary: root };
    function sign(value = manifest, signingPair = pair) {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"); write(options.manifestPath, bytes);
      write(options.signaturePath, signManifestBytes(bytes, signingPair.privateKey));
    }
    sign(); write(options.publicKeyPath, pem);
    return { options, manifest, sign, work, source, final: path.join(storeRoot, options.sha256) };
  }
  function makeWritable(directory) {
    const stat = fs.lstatSync(directory); if (stat.isSymbolicLink()) return;
    fs.chmodSync(directory, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of fs.readdirSync(directory)) makeWritable(path.join(directory, name));
  }
  try {
    await check("real signed original archive and raw authentication artifacts are preserved and independently reverified", async () => {
      const f = await fixture(), original = fs.readFileSync(f.options.archivePath), manifest = fs.readFileSync(f.options.manifestPath);
      const result = await baseline.preserveSourceBaseline(f.options), verified = await baseline.verifyRetained(f.options);
      assert.equal(result.sourceBaselineReady, true); assert.equal(result.uiFastPathAllowed, false);
      assert.equal(result.releaseAcceptanceProven, false); assert.equal(result.frontendBuildBindingAvailable, false);
      assert.deepEqual(fs.readFileSync(path.join(f.final, baseline.FILES.archive)), original);
      assert.deepEqual(fs.readFileSync(path.join(f.final, baseline.FILES.manifest)), manifest);
      assert.deepEqual(fs.readFileSync(path.join(f.final, baseline.FILES.signature)), fs.readFileSync(f.options.signaturePath));
      assert.deepEqual(fs.readFileSync(path.join(f.final, baseline.FILES.publicKey)), fs.readFileSync(f.options.publicKeyPath));
      assert.equal(verified.record.inventorySha256, f.manifest.archiveSourceEvidence.inventorySha256);
      assert.deepEqual(fs.readdirSync(f.final).sort(), Object.values(baseline.FILES).sort());
    });
    await check("valid repeated capture reuses exactly the same complete immutable baseline without rewriting", async () => {
      const f = await fixture(); await baseline.preserveSourceBaseline(f.options);
      const recordFile = path.join(f.final, baseline.FILES.record), before = fs.statSync(recordFile), bytes = fs.readFileSync(recordFile);
      assert.equal((await baseline.preserveSourceBaseline(f.options)).reusedExisting, true);
      assert.equal(fs.statSync(recordFile).mtimeMs, before.mtimeMs); assert.deepEqual(fs.readFileSync(recordFile), bytes);
    });
    await check("insufficient disk reserve rejects before copying without purging existing baselines", async () => {
      const f = await fixture(), statfs = fs.statfsSync;
      fs.mkdirSync(f.options.storeRoot, { mode: 0o700 });
      const sentinel = path.join(f.options.storeRoot, "previous-baseline-retained"); write(sentinel, "previous baseline");
      try {
        fs.statfsSync = () => ({ bsize: 4096n, bavail: 1024n });
        await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /insufficient-free-space/);
        assert.deepEqual(fs.readdirSync(f.options.storeRoot), ["previous-baseline-retained"]);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "previous baseline");
      } finally { fs.statfsSync = statfs; }
    });
    await check("legacy r711-shaped missing source inventory never becomes a UI baseline from mutable APP", async () => {
      const f = await fixture(); delete f.manifest.archiveSourceEvidence; f.sign();
      const result = await baseline.preserveSourceBaseline(f.options);
      assert.equal(result.status, "legacy-inventory-unavailable"); assert.equal(result.sourceBaselineReady, false);
      assert.equal(result.uiFastPathAllowed, false); assert.equal(fs.existsSync(f.options.storeRoot), false);
    });
    await check("signature tampering and wrong external signing key fail before any baseline writes", async () => {
      const f = await fixture(), sig = fs.readFileSync(f.options.signaturePath); sig[0] ^= 1; write(f.options.signaturePath, sig);
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /signature-invalid/); assert.equal(fs.existsSync(f.options.storeRoot), false);
      f.sign(); write(f.options.publicKeyPath, other.publicKey.export({ format: "pem", type: "spki" }));
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /signature-invalid/);
    });
    await check("source identity site sequence full-mode and expiry are validated under the real signature", async () => {
      const f = await fixture();
      for (const mutate of [
        value => { value.site = "different-site"; }, value => { value.releaseSequence++; },
        value => { value.executionMode = "ui"; }, value => { value.missingEntries = ["required-source"]; },
        value => { value.createdAt = new Date(Date.now() - 7200000).toISOString(); value.expiresAt = new Date(Date.now() - 3600000).toISOString(); },
      ]) {
        const value = structuredClone(f.manifest); mutate(value); f.sign(value);
        await assert.rejects(() => baseline.preserveSourceBaseline(f.options));
      }
      assert.equal(fs.existsSync(f.options.storeRoot), false);
    });
    await check("a changed original archive is refused and its incomplete staging never appears as complete", async () => {
      const f = await fixture(), bytes = fs.readFileSync(f.options.archivePath); bytes[bytes.length - 1] ^= 1; write(f.options.archivePath, bytes);
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /archive-sha-mismatch/);
      assert.equal(fs.existsSync(f.final), false);
      const staging = fs.readdirSync(f.options.storeRoot).filter(name => name.includes(".staging-"));
      assert.equal(staging.length, 1); assert.equal(fs.existsSync(path.join(f.options.storeRoot, staging[0], baseline.FILES.complete)), false);
    });
    await check("a fully signed but incorrect per-file inventory is rejected by the retained archive parser", async () => {
      const f = await fixture(), source = f.manifest.archiveSourceEvidence, inventory = source.inventory;
      inventory.entries.find(row => row.kind === "file").sha256 = "0".repeat(64);
      const { treeHash, ...body } = inventory; void treeHash; inventory.treeHash = hash(JSON.stringify(body)); source.inventorySha256 = inventory.treeHash; f.sign();
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /actual-archive-source-evidence-mismatch/);
      assert.equal(fs.existsSync(f.final), false);
    });
    await check("incomplete existing target is retained and cannot be automatically replaced", async () => {
      const f = await fixture(); fs.mkdirSync(f.options.storeRoot, { mode: 0o700 }); fs.mkdirSync(f.final, { mode: 0o500 });
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /incomplete-or-extra/);
      assert.equal(fs.existsSync(f.final), true); assert.deepEqual(fs.readdirSync(f.final), []);
    });
    await check("missing complete-last marker or altered retained bytes invalidate only that baseline", async () => {
      const f = await fixture(); await baseline.preserveSourceBaseline(f.options);
      fs.chmodSync(f.final, 0o700); fs.unlinkSync(path.join(f.final, baseline.FILES.complete)); fs.chmodSync(f.final, 0o500);
      await assert.rejects(() => baseline.verifyRetained(f.options), /incomplete-or-extra/);
      const otherFixture = await fixture(); await baseline.preserveSourceBaseline(otherFixture.options);
      sealedWrite(path.join(otherFixture.final, baseline.FILES.manifest), "{}\n");
      await assert.rejects(() => baseline.verifyRetained(otherFixture.options), /digest-mismatch/);
      assert.equal(fs.existsSync(f.final), true);
    });
    await check("retained public key is not a self-authenticating trust anchor after external key rotation", async () => {
      const f = await fixture(); await baseline.preserveSourceBaseline(f.options);
      write(f.options.publicKeyPath, other.publicKey.export({ format: "pem", type: "spki" }));
      await assert.rejects(() => baseline.verifyRetained(f.options), /not-externally-trusted/);
    });
    await check("private key PEM is rejected and never copied into a baseline", async () => {
      const f = await fixture(); write(f.options.publicKeyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /public-key-only/);
      assert.equal(fs.existsSync(f.options.storeRoot), false);
    });
    await check("interrupted capture lock is never expired or deleted automatically", async () => {
      const f = await fixture(); fs.mkdirSync(f.options.storeRoot, { mode: 0o700 });
      const lock = path.join(f.options.storeRoot, "." + f.options.sha256 + ".capture-lock"); fs.mkdirSync(lock, { mode: 0o700 });
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /busy-or-interrupted/);
      assert.equal(fs.existsSync(lock), true); assert.equal(fs.existsSync(f.final), false);
    });
    await check("original extraction and mutable runtime trees may disappear without changing retained source proof", async () => {
      const f = await fixture(); await baseline.preserveSourceBaseline(f.options);
      fs.rmSync(f.source, { recursive: true }); fs.unlinkSync(f.options.archivePath); fs.unlinkSync(f.options.manifestPath); fs.unlinkSync(f.options.signaturePath);
      assert.equal((await baseline.verifyRetained(f.options)).sourceBaselineReady, true);
    });
    await check("bounded file sizes and hard-linked input artifacts are rejected before retention", async () => {
      const f = await fixture(); write(f.options.manifestPath, Buffer.alloc(baseline.LIMITS.manifest + 1, 32));
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /oversized/); f.sign();
      fs.linkSync(f.options.signaturePath, path.join(f.work, "linked-signature"));
      await assert.rejects(() => baseline.preserveSourceBaseline(f.options), /unsafe-or-oversized/);
      assert.equal(fs.existsSync(f.options.storeRoot), false);
    });
    if (process.platform === "linux") {
      await check("real Linux retained files are sealed and writable or symlinked trust paths are rejected", async () => {
        const f = await fixture(); await baseline.preserveSourceBaseline(f.options);
        assert.equal(fs.statSync(f.final).mode & 0o777, 0o500);
        for (const name of Object.values(baseline.FILES)) assert.equal(fs.statSync(path.join(f.final, name)).mode & 0o777, 0o400);
        fs.chmodSync(path.join(f.final, baseline.FILES.manifest), 0o600);
        await assert.rejects(() => baseline.verifyRetained(f.options), /not-sealed/);
        const newer = await fixture(), key = path.join(newer.work, "key-real"); fs.renameSync(newer.options.publicKeyPath, key); fs.symlinkSync(key, newer.options.publicKeyPath);
        await assert.rejects(() => baseline.preserveSourceBaseline(newer.options), /unsafe-or-oversized/);
      });
      if (process.getuid() !== 0) await check("production entrypoint refuses non-root without writing fixed store", async () => {
        const f = await fixture(), { fixtureOwnerUid, fixtureTrustBoundary, ...productionOptions } = f.options; void fixtureOwnerUid; void fixtureTrustBoundary;
        await assert.rejects(() => baseline.preserveSourceBaseline(productionOptions), /linux-root/);
      });
    }
    await check("recorder has no APP fallback no automatic deletion and no subprocess deployment capability", () => {
      const source = fs.readFileSync(path.join(__dirname, "releaseSourceBaseline.cjs"), "utf8");
      for (const forbidden of ["node:child_process", "/opt/football-predict", "rmSync(", "unlinkSync(", "execSync(", "spawn("]) assert.equal(source.includes(forbidden), false);
      assert.equal(baseline.STORE_ROOT, "/var/lib/football-release/source-baselines");
      assert.equal(baseline.WORK_ROOT, "/var/lib/football-release/work");
    });
    return { ok: true, suite: baseline.VERSION, platform: process.platform, node: process.version, passed: checks.length, checks,
      actualRsaSignature: true, actualArchiveInventory: true, productionWrites: 0, fastPathActivated: false, temporaryFixturesRemoved: true };
  } finally {
    const exactRoot = fs.realpathSync(root);
    assert.equal(path.dirname(exactRoot), fs.realpathSync(os.tmpdir())); assert.match(path.basename(exactRoot), /^football-source-baseline-/);
    makeWritable(exactRoot); fs.rmSync(exactRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(exactRoot), false);
  }
}
module.exports = { verifyReleaseSourceBaseline };
if (require.main === module) verifyReleaseSourceBaseline().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
