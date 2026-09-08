"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createTarInventoryParser, captureReleaseArchiveSourceEvidence, validateSignedArchiveSourceEvidence,
  verifyArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");
const { publicKeyId, signManifestBytes, verifyManifestSignature, validateReleaseManifestV3,
  RELEASE_SIGNATURE_ALGORITHM } = require("./releaseSigning.cjs");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
function header(name, { type = "0", bytes = Buffer.alloc(0), size = bytes.length, mode = 0o644, prefix = "", link = "" } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  const octal = (number, start, length) => block.write(`${number.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  block.fill(32, 148, 156); block.write(type, 156, 1, "ascii"); block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii"); block.write("00", 263, 2, "ascii"); block.write(prefix, 345, 155, "utf8");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
const tar = (...members) => Buffer.concat([...members, Buffer.alloc(1024)]);
const parse = bytes => {
  const parser = createTarInventoryParser();
  // Non-header-aligned chunks exercise true streaming paths.
  for (let offset = 0; offset < bytes.length; offset += 317) parser.write(bytes.subarray(offset, offset + 317));
  return parser.finish();
};
function pax(key, value) {
  const suffix = `${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 2;
  while (Buffer.byteLength(`${length} ${suffix}`) !== length) length = Buffer.byteLength(`${length} ${suffix}`);
  return Buffer.from(`${length} ${suffix}`);
}

async function verifyReleaseArchiveSourceInventory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-source-inventory-"));
  const checks = [];
  const check = async (name, run) => { await run(); checks.push({ name, ok: true }); };
  const write = (name, data) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return target; };
  try {
    const validTar = tar(header("./src/", { type: "5", mode: 0o755 }),
      header("./src/App.tsx", { bytes: Buffer.from("export default () => <p>reference</p>;\n") }));
    const validBundle = write("valid.tgz", zlib.gzipSync(validTar));
    const evidence = await captureReleaseArchiveSourceEvidence(validBundle);
    await check("streaming actual gzip archive binds exact SHA, member bytes and modes", () => {
      assert.equal(evidence.archiveSha256, hash(fs.readFileSync(validBundle)));
      assert.equal(evidence.archiveEntryCount, 2);
      assert.deepEqual(evidence.inventory, parse(validTar));
      assert.equal(evidence.inventory.entries[1].sha256, hash(Buffer.from("export default () => <p>reference</p>;\n")));
      assert.equal(evidence.inventory.entries[0].mode, 0o755);
      assert.equal(evidence.frontendBuildBinding, null);
      assert.equal(evidence.executionMode, "full");
    });
    const damagedForFd = Buffer.from(fs.readFileSync(validBundle)); damagedForFd[damagedForFd.length - 1] ^= 1;
    const malformedHeaderForFd = Buffer.from(header("early-reject.cjs")); malformedHeaderForFd[0] ^= 1;
    const fdCases = [
      { name: "success", bundle: validBundle, cycles: 34, error: null },
      { name: "corrupt gzip", bundle: write("fd-corrupt.tgz", damagedForFd), cycles: 33, error: /check|length|data|gzip/i },
      // Incompressible trailing data keeps source I/O outstanding when the
      // first decompressed header makes the parser exit early.
      { name: "early parser rejection", bundle: write("fd-early.tgz", zlib.gzipSync(Buffer.concat([
        malformedHeaderForFd, crypto.randomBytes(256 * 1024),
      ]))), cycles: 33, error: /tar-header-checksum-mismatch/ },
    ];
    const sentinelPath = write("fd-sentinel.bin", Buffer.alloc(64));
    for (const testCase of fdCases) await check(`archive cleanup cannot close a newly reused sentinel fd after ${testCase.name}`, async () => {
      for (let cycle = 0; cycle < testCase.cycles; cycle++) {
        if (testCase.error) await assert.rejects(() => captureReleaseArchiveSourceEvidence(testCase.bundle), testCase.error);
        else assert.equal((await captureReleaseArchiveSourceEvidence(testCase.bundle)).archiveSha256, evidence.archiveSha256);
        // Open immediately in the capture's continuation, before any later
        // event-loop cleanup could close the reused descriptor number.
        const sentinel = fs.openSync(sentinelPath, fs.constants.O_RDWR), initial = fs.fstatSync(sentinel);
        let failure;
        try {
          await new Promise(resolve => setImmediate(resolve));
          await new Promise(resolve => setTimeout(resolve, 1));
          const after = fs.fstatSync(sentinel);
          assert.equal(after.dev, initial.dev); assert.equal(after.ino, initial.ino);
          const payload = Buffer.from(`${testCase.name}:${cycle}`), actual = Buffer.alloc(payload.length);
          assert.equal(fs.writeSync(sentinel, payload, 0, payload.length, 0), payload.length);
          fs.fsyncSync(sentinel);
          assert.equal(fs.readSync(sentinel, actual, 0, actual.length, 0), actual.length);
          assert.deepEqual(actual, payload);
        } catch (error) { failure = error; }
        try { fs.closeSync(sentinel); } catch (error) { failure ||= error; }
        if (failure) throw failure;
      }
    });
    await check("actual system tar archive retains nested sources and generated data", async () => {
      write("source/package.json", "{}"); write("source/src/outputs/policy.cjs", "module.exports = true;");
      write("source/public/data/sync-meta.json", '{"generation":"fixture"}');
      const bundle = path.join(root, "actual-tar.tgz");
      const result = spawnSync("tar", ["-czf", bundle, "-C", path.join(root, "source"), "./package.json", "./src", "./public"],
        { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      const actual = await captureReleaseArchiveSourceEvidence(bundle);
      assert.ok(actual.inventory.entries.some(row => row.path === "src/outputs/policy.cjs"));
      assert.ok(actual.inventory.entries.some(row => row.path === "public/data/sync-meta.json"));
      assert.equal(actual.frontendBuildBinding, null);
    });
    await check("USTAR prefix and bounded PAX/GNU names resolve to complete safe members", () => {
      const parent = "long-parent";
      assert.equal(parse(tar(header(parent, { type: "5" }), header("file.ts", { prefix: parent }))).entries[1].path, `${parent}/file.ts`);
      const p = parse(tar(header("parent", { type: "5" }),
        header("pax", { type: "x", bytes: pax("path", "parent/exact.ts") }), header("ignored.ts")));
      assert.equal(p.entries[1].path, "parent/exact.ts");
      const gnu = parse(tar(header("parent", { type: "5" }),
        header("././@LongLink", { type: "L", bytes: Buffer.from("parent/exact.ts\0") }), header("ignored.ts")));
      assert.equal(gnu.entries[1].path, "parent/exact.ts");
    });
    for (const [name, data, pattern] of [
      ["duplicate raw member", tar(header("file"), header("file")), /duplicate-or-aliased/],
      ["normalized alias", tar(header("./file"), header("file")), /duplicate-or-aliased/],
      ["case alias", tar(header("file"), header("FILE")), /duplicate-or-aliased/],
      ["path traversal", tar(header("../escape")), /unsafe-tar-member/],
      ["absolute path", tar(header("/escape")), /unsafe-tar-member/],
      ["Windows drive path", tar(header("C:/escape")), /unsafe-tar-member/],
      ["symlink", tar(header("link", { type: "2", link: "outside" })), /link-target-forbidden/],
      ["hardlink", tar(header("link", { type: "1", link: "other" })), /link-target-forbidden/],
      ["device", tar(header("device", { type: "3" })), /special-member-forbidden/],
      ["unknown GNU sparse", tar(header("sparse", { type: "S" })), /special-member-forbidden/],
      ["missing parent", tar(header("missing/file")), /missing-parent-directory/],
      ["setuid mode", tar(header("file", { mode: 0o4644 })), /unsafe-tar-permission/],
      ["oversized file claim", tar(header("file", { size: 128 * 1024 * 1024 + 1 })), /byte-limit/],
      ["PAX traversal", tar(header("pax", { type: "x", bytes: pax("path", "../escape") }), header("file")), /unsafe-tar-member/],
      ["PAX duplicate path", tar(header("pax", { type: "x", bytes: Buffer.concat([pax("path", "file"), pax("path", "other")]) }), header("file")), /duplicate-pax-key/],
      ["PAX unknown metadata", tar(header("pax", { type: "x", bytes: pax("SCHILY.xattr.security.capability", "value") }), header("file")), /unsupported-or-duplicate/],
      ["PAX global path", tar(header("pax", { type: "g", bytes: pax("path", "global") }), header("file")), /global-pax/],
      ["PAX and GNU ambiguity", tar(header("pax", { type: "x", bytes: pax("path", "file") }),
        header("gnu", { type: "L", bytes: Buffer.from("other\0") }), header("file")), /ambiguous-extended/],
      ["trailing entry after terminator", Buffer.concat([tar(header("file")), header("late")]), /after-terminator/],
      ["missing terminator", header("file"), /incomplete-tar/],
    ]) await check(`rejects ${name} before extraction or signing`, () => assert.throws(() => parse(data), pattern));
    await check("bad checksum, truncated content and damaged gzip are rejected", async () => {
      const bad = Buffer.from(validTar); bad[0] ^= 1;
      assert.throws(() => parse(bad), /checksum-mismatch/);
      assert.throws(() => parse(validTar.subarray(0, 1030)), /incomplete-tar/);
      const damaged = Buffer.from(fs.readFileSync(validBundle)); damaged[damaged.length - 1] ^= 1;
      await assert.rejects(() => captureReleaseArchiveSourceEvidence(write("damaged.tgz", damaged)));
    });
    await check("archive hardlinks cannot be accepted as immutable inputs", async () => {
      const linked = path.join(root, "linked.tgz"); fs.linkSync(validBundle, linked);
      try { await assert.rejects(() => captureReleaseArchiveSourceEvidence(linked), /non-plain-or-oversized/); }
      finally { fs.unlinkSync(linked); }
    });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    const pubPath = write("public.pem", publicKey.export({ type: "spki", format: "pem" }));
    const now = Date.now();
    const manifest = { manifestVersion: 3, site: "football-predict", channel: "production", releaseSequence: 1,
      ok: true, policyVersion: "release-secret-policy-v2", sensitiveEntries: [], blockedEntries: [], missingEntries: [],
      createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      bytes: evidence.archiveBytes, sha256: evidence.archiveSha256, entries: evidence.archiveEntryCount,
      archiveSourceEvidence: evidence, signature: { algorithm: RELEASE_SIGNATURE_ALGORITHM, keyId: publicKeyId(publicKey) } };
    const signed = value => {
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      return { manifestPath: write("manifest.json", bytes), signaturePath: write("manifest.sig", signManifestBytes(bytes, privateKey)), publicKeyPath: pubPath, now };
    };
    await check("real detached RSA signature authenticates complete member inventory", async () => {
      const verified = verifyManifestSignature(signed(manifest));
      assert.deepEqual(verified.manifest.archiveSourceEvidence, evidence);
      assert.equal((await verifyArchiveSourceEvidence(validBundle, verified.manifest)).executionMode, "full");
    });
    await check("inventory-byte tampering fails the actual detached signature", () => {
      const args = signed(manifest);
      const tampered = clone(manifest); tampered.archiveSourceEvidence.inventory.entries[1].sha256 = "a".repeat(64);
      fs.writeFileSync(args.manifestPath, JSON.stringify(tampered));
      assert.throws(() => verifyManifestSignature(args), /signature verification failed/);
    });
    await check("signed partial, mismatched or fake build success metadata is rejected", () => {
      for (const mutate of [
        value => { value.archiveSourceEvidence = null; },
        value => { value.archiveSourceEvidence.archiveSha256 = "b".repeat(64); },
        value => { value.archiveSourceEvidence.inventorySha256 = "b".repeat(64); },
        value => { value.archiveSourceEvidence.archiveEntryCount++; },
        value => { value.archiveSourceEvidence.frontendBuildBinding = { exitCode: 0 }; },
        value => { value.archiveSourceEvidence.executionMode = "frontend-only"; },
      ]) {
        const bad = clone(manifest); mutate(bad);
        assert.throws(() => verifyManifestSignature(signed(bad)));
      }
    });
    await check("legacy signed manifest remains valid but cannot supply a fast-path inventory", async () => {
      const legacy = clone(manifest); delete legacy.archiveSourceEvidence;
      const verified = verifyManifestSignature(signed(legacy));
      assert.deepEqual(validateSignedArchiveSourceEvidence(verified.manifest), { status: "legacy-unavailable", executionMode: "full" });
      assert.deepEqual(await verifyArchiveSourceEvidence(validBundle, verified.manifest), { status: "legacy-unavailable", executionMode: "full" });
    });
    await check("standalone legacy signing fixtures do not acquire undeclared module dependencies", () => {
      const isolated = write("isolated/releaseSigning.cjs", fs.readFileSync(path.join(__dirname, "releaseSigning.cjs")));
      const legacy = clone(manifest); delete legacy.archiveSourceEvidence;
      const args = signed(legacy);
      const result = spawnSync(process.execPath, ["-e",
        "const s=require(process.argv[1]);const v=s.verifyManifestSignature(JSON.parse(process.argv[2]));process.stdout.write(v.manifest.sha256);",
        isolated, JSON.stringify(args)], { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, manifest.sha256);
    });
    await check("fixed wrapper manifest contract accepts signed inventory without widening its 1 MiB cap", () => {
      const wrapper = fs.readFileSync(path.join(__dirname, "../deploy/light-server/football-release"), "utf8").replace(/\r\n/g, "\n");
      assert.ok(wrapper.includes('assert_regular_upload "$SOURCE_MANIFEST" "$UPLOAD_OWNER" $((1024 * 1024))'));
      const from = wrapper.indexOf('manifest_sequence="$(node -');
      const start = wrapper.indexOf("<<'NODE'\n", from) + "<<'NODE'\n".length;
      const end = wrapper.indexOf("\nNODE\n)", start);
      assert.ok(from >= 0 && start > from && end > start);
      const args = signed(manifest);
      let output = "";
      const context = { require, process: { argv: [process.execPath, "-", args.manifestPath, manifest.sha256,
        String(manifest.bytes), manifest.signature.keyId, "3", manifest.policyVersion, RELEASE_SIGNATURE_ALGORITHM,
        manifest.site, manifest.channel, "0"], stdout: { write: value => { output += value; } } } };
      vm.runInNewContext(wrapper.slice(start, end), context, { timeout: 1000 });
      assert.equal(output, "1");
      assert.ok(fs.statSync(args.manifestPath).size < 1024 * 1024);
    });
    await check("structurally valid but fabricated inventory fails actual archive comparison", async () => {
      const fabricated = clone(manifest);
      const inventory = fabricated.archiveSourceEvidence.inventory;
      inventory.entries[1].sha256 = hash("fabricated bytes");
      const { treeHash: _ignored, ...body } = inventory;
      inventory.treeHash = hash(JSON.stringify(body));
      fabricated.archiveSourceEvidence.inventorySha256 = inventory.treeHash;
      validateReleaseManifestV3(fabricated, { now });
      await assert.rejects(() => verifyArchiveSourceEvidence(validBundle, fabricated), /actual-archive-source-evidence-mismatch/);
    });
    await check("actual production capture block invokes child parser and checks archive/count binding", () => {
      const repoRoot = path.resolve(__dirname, "..");
      const source = fs.readFileSync(path.join(__dirname, "createReleaseBundle.cjs"), "utf8");
      const start = source.indexOf("const sourceInventoryCapture = spawnSync(");
      const end = source.indexOf("const extractedModelEvaluation =", start);
      assert.ok(start > 0 && end > start);
      const context = { spawnSync, process, rootDir: repoRoot, outputPath: validBundle, hash: evidence.archiveSha256,
        stat: fs.statSync(validBundle), entries: ["src", "src/App.tsx"], validateSignedArchiveSourceEvidence, result: null };
      vm.runInNewContext(`${source.slice(start, end)}\nresult = archiveSourceEvidence;`, context, { timeout: 40_000 });
      assert.equal(context.result.inventorySha256, evidence.inventorySha256);
      const wrong = { ...context, entries: ["incomplete"] };
      assert.throws(() => vm.runInNewContext(source.slice(start, end), wrong, { timeout: 40_000 }), /binding-mismatch/);
      assert.match(source, /entries: entries\.length,\s+archiveSourceEvidence,/);
      assert.match(source, /manifestBytes\.length > 1024 \* 1024/);
      assert.ok(source.indexOf("archiveSourceEvidence,") < source.indexOf("signManifestBytes(manifestBytes"));
    });
    return { ok: true, verifier: "release-archive-source-inventory-v1", checks,
      descriptorReuseSentinelCycles: 100, productionWrites: 0, networkCalls: 0, buildBindingAvailable: false, fastPathActivated: false };
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^football-release-source-inventory-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
module.exports = { verifyReleaseArchiveSourceInventory };
if (require.main === module) verifyReleaseArchiveSourceInventory().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
