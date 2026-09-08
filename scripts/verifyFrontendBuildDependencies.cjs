"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const deps = require("./frontendBuildDependencies.cjs"), build = require("./frontendBuildEvidence.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), lockSha256 = "a".repeat(64);
function header({ path: filename, kind, mode = 0o755, bytes, link = "", size, type }) {
  const block = Buffer.alloc(512), text = (at, length, value) => { if (Buffer.byteLength(value) > length) throw Error("fixture tar field overflow"); block.write(value, at, length, "utf8"); };
  text(0, 100, filename); text(100, 8, mode.toString(8).padStart(7, "0") + "\0"); text(108, 8, "0000000\0"); text(116, 8, "0000000\0");
  text(124, 12, (size ?? bytes?.length ?? 0).toString(8).padStart(11, "0") + "\0"); text(136, 12, "00000000000\0"); block.fill(32, 148, 156);
  block[156] = (type || (kind === "directory" ? "5" : kind === "bin-alias" ? "2" : "0")).charCodeAt(0);
  text(157, 100, link); text(257, 6, "ustar "); text(263, 2, " \0");
  const checksum = block.reduce((sum, byte) => sum + byte, 0); text(148, 8, checksum.toString(8).padStart(6, "0") + "\0 "); return block;
}
function pack(rows, extras = []) {
  const pieces = [];
  for (const row of [...rows, ...extras]) {
    let name = row.path, link = row.link || "";
    if (Buffer.byteLength(name) > 100) { const data = Buffer.from(name + "\0"); pieces.push(header({ path: "././@LongLink", type: "L", bytes: data }), data, Buffer.alloc((512 - data.length % 512) % 512)); name = "truncated"; }
    if (Buffer.byteLength(link) > 100) { const data = Buffer.from(link + "\0"); pieces.push(header({ path: "././@LongLink", type: "K", bytes: data }), data, Buffer.alloc((512 - data.length % 512) % 512)); link = "truncated"; }
    pieces.push(header({ ...row, path: name, link }));
    if (row.bytes?.length) pieces.push(row.bytes, Buffer.alloc((512 - row.bytes.length % 512) % 512));
  }
  pieces.push(Buffer.alloc(1024)); return zlib.gzipSync(Buffer.concat(pieces));
}
function dir(p, mode = 0o755) { return { path: p, kind: "directory", mode }; }
function file(p, content, mode = 0o644) { return { path: p, kind: "file", bytes: Buffer.isBuffer(content) ? content : Buffer.from(content), mode }; }
function alias(p, link) { return { path: p, kind: "bin-alias", mode: 0o777, link }; }
function basics() { return [dir("node_modules"), dir("node_modules/.bin"), dir("node_modules/pkg"),
  file("node_modules/pkg/package.json", '{"name":"pkg","scripts":{"postinstall":"never execute"}}'), file("node_modules/pkg/cli.js", "throw Error('must not execute package code');", 0o755),
  file("node_modules/pkg/empty", Buffer.alloc(0)), alias("node_modules/.bin/pkg", "../pkg/cli.js")]; }
function put(fixture, rows = basics(), extras = [], amend) {
  const archive = pack(rows, extras), inventory = rows.filter(row => row.path !== "node_modules").map(row => {
    const p = row.path.slice("node_modules/".length);
    return row.kind === "directory" ? { path: p, kind: row.kind, mode: row.mode }
      : row.kind === "bin-alias" ? { path: p, kind: row.kind, target: path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.link)).slice("node_modules/".length) }
        : { path: p, kind: row.kind, bytes: row.bytes.length, mode: row.mode, sha256: hash(row.bytes) };
  });
  const manifest = { kind: "task-private-dependency-material-not-acceptance", createdAt: Date.now(), lockSha256, archiveSha256: hash(archive), inventory, install: { status: 0 }, signingEligible: false };
  amend?.(manifest); const raw = Buffer.from(JSON.stringify(manifest));
  for (const [name, bytes] of [["dependencies.tgz", archive], ["manifest.json", raw]]) { const target = path.join(fixture.materialDir, name); fs.writeFileSync(target, bytes, { mode: 0o400 }); fs.chmodSync(target, 0o400); }
  return { materialDir: fixture.materialDir, materialManifestSha256: hash(raw), materialArchiveSha256: hash(archive), lockSha256 };
}
async function verify() {
  if (process.platform !== "linux") throw Error("real Linux dependency alias/fd/fsync fixtures required");
  const checks = [], check = async (name, run) => { await run(); checks.push({ name, ok: true }); };
  await check("offline import exact 3-member publication matches actual consumer dependencyHash; no code execution", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const input = put(f), result = await f.import(input); assert.equal(result.ok, true); assert.equal(result.networkRequests, 0); assert.equal(result.packageExecutions, 0);
      assert.deepEqual(fs.readdirSync(result.root).sort(), ["complete.json", "dependencies.json", "node_modules"]);
      const record = fs.readFileSync(path.join(result.root, "dependencies.json")), complete = JSON.parse(fs.readFileSync(path.join(result.root, "complete.json")));
      assert.equal(complete.recordSha256, hash(record)); assert.equal(result.record.dependencySha256, build.snapshotBuildInputs(result.root, { beforeBuild: true }).dependencyHash);
      assert.equal(fs.statSync(result.root).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(result.root, "node_modules/pkg/cli.js")).mode & 0o777, 0o755);
      assert.equal(fs.lstatSync(path.join(result.root, "node_modules/.bin/pkg")).isSymbolicLink(), true);
      assert.equal((await f.import(input)).reused, true);
    } finally { f.dispose(); }
  });
  await check("nested npm package chains and bounded GNU long path/long link retain valid alias semantics", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const filename = "long-" + "a".repeat(120) + ".js", rows = [...basics(), dir("node_modules/pkg/node_modules"), dir("node_modules/pkg/node_modules/.bin"), dir("node_modules/pkg/node_modules/sub"),
        file("node_modules/pkg/node_modules/sub/cli.js", "nested executable", 0o755), alias("node_modules/pkg/node_modules/.bin/sub", "../sub/cli.js"),
        file("node_modules/pkg/" + filename, "long executable", 0o755), alias("node_modules/.bin/long", "../pkg/" + filename)];
      const result = await f.import(put(f, rows)); assert.equal(result.ok, true);
      assert.equal(fs.realpathSync(path.join(result.root, "node_modules/pkg/node_modules/.bin/sub")), path.join(result.root, "node_modules/pkg/node_modules/sub/cli.js"));
    } finally { f.dispose(); }
  });
  const unsafe = [
    ["parent traversal", file("node_modules/../../escape", "bad")], ["absolute path", file("/tmp/escape", "bad")],
    ["hardlink", { path: "node_modules/link", type: "1", link: "node_modules/pkg/cli.js" }],
    ["device", { path: "node_modules/device", type: "3" }], ["pax hidden path", { path: "node_modules/pax", type: "x", bytes: Buffer.from("25 path=../../escape\n") }],
    ["symlink outside bin", alias("node_modules/pkg/link", "cli.js")], ["absolute bin target", alias("node_modules/.bin/absolute", "/tmp/escape")],
    ["escaped bin target", alias("node_modules/.bin/outside", "../../escape")], ["hidden target", alias("node_modules/.bin/hidden", "../.hidden/cli.js")],
    ["symlink parent", file("node_modules/.bin/pkg/escape", "bad")], ["missing parent", file("node_modules/missing/file", "bad")],
    ["duplicate entry", file("node_modules/pkg/cli.js", "bad")], ["cache input", dir("node_modules/.tmp")],
    ["oversized declared file", { path: "node_modules/huge", kind: "file", size: 161 * 1024 * 1024 }],
  ];
  for (const [name, entry] of unsafe) await check(`complete metadata scan rejects ${name} before any extraction stage`, async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      await assert.rejects(() => f.import(put(f, basics(), [entry]))); assert.equal(fs.existsSync(f.store), false);
    } finally { f.dispose(); }
  });
  await check("material inventory file hash and alias target cannot disagree with actual archive", async () => {
    for (const amend of [m => { m.inventory.find(row => row.kind === "file").sha256 = "b".repeat(64); }, m => { m.inventory.find(row => row.kind === "bin-alias").target = "pkg/empty"; }]) {
      const f = deps.createFrontendBuildDependenciesFixture(); try { await assert.rejects(() => f.import(put(f, basics(), [], amend)), /inventory-mismatch/); } finally { f.dispose(); }
    }
  });
  await check("corrupt gzip returns only after its FileHandle streams close and leaves later descriptors valid", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const input = put(f), archivePath = path.join(f.materialDir, "dependencies.tgz"), manifestPath = path.join(f.materialDir, "manifest.json");
      const damaged = fs.readFileSync(archivePath); damaged[damaged.length - 8] ^= 0xff;
      const manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.archiveSha256 = hash(damaged); const raw = Buffer.from(JSON.stringify(manifest));
      for (const [target, body] of [[archivePath, damaged], [manifestPath, raw]]) { fs.chmodSync(target, 0o600); fs.writeFileSync(target, body); fs.chmodSync(target, 0o400); }
      await assert.rejects(() => f.import({ ...input, materialArchiveSha256: hash(damaged), materialManifestSha256: hash(raw) }));
      const sentinel = path.join(f.root, "unrelated-descriptor"), fd = fs.openSync(sentinel, "wx");
      try { await new Promise(resolve => setImmediate(resolve)); fs.writeSync(fd, "still open"); assert.equal(fs.fstatSync(fd).size, 10); } finally { fs.closeSync(fd); }
      assert.equal(fs.existsSync(f.store), false);
    } finally { f.dispose(); }
  });
  await check("exact material directory, both hashes, lock and sealed file identity are required", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const input = put(f);
      for (const change of [{ materialDir: f.root }, { materialManifestSha256: "b".repeat(64) }, { materialArchiveSha256: "b".repeat(64) }, { lockSha256: "b".repeat(64) }, { extra: true }]) await assert.rejects(() => f.import({ ...input, ...change }));
      fs.chmodSync(path.join(f.materialDir, "manifest.json"), 0o644); await assert.rejects(() => f.import(input), /not-sealed/);
      assert.equal(fs.existsSync(f.store), false);
    } finally { f.dispose(); }
  });
  await check("insufficient extraction budget preserves the 4 GiB floor and creates no stage", async () => {
    const f = deps.createFrontendBuildDependenciesFixture({ freeBytes: 4n * 1024n ** 3n }); try {
      await assert.rejects(() => f.import(put(f)), /insufficient/); assert.deepEqual(fs.readdirSync(f.store), []);
    } finally { f.dispose(); }
  });
  await check("failure before complete retains private incomplete stage without publishing a store", async () => {
    const f = deps.createFrontendBuildDependenciesFixture({ onStep: () => { throw Error("fixture stop"); } }); try {
      await assert.rejects(() => f.import(put(f)), /fixture stop/); assert.equal(fs.existsSync(path.join(f.store, lockSha256)), false);
      const names = fs.readdirSync(f.store); assert.equal(names.length, 1); assert.match(names[0], /^\.import-/);
      assert.equal(fs.existsSync(path.join(f.store, names[0], "complete.json")), false);
    } finally { f.dispose(); }
  });
  await check("existing conflicting or modified stores are never overwritten", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const input = put(f), result = await f.import(input), filename = path.join(result.root, "node_modules/pkg/cli.js");
      fs.writeFileSync(filename, "externally modified"); await assert.rejects(() => f.import(input), /store-content-drift/); assert.equal(fs.readFileSync(filename, "utf8"), "externally modified");
    } finally { f.dispose(); }
  });
  await check("trusted TypeScript two-file installation is pinned and atomic, not loaded/executed", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      const ts = path.resolve(__dirname, "../node_modules/typescript"), rows = [...basics(), dir("node_modules/typescript"), dir("node_modules/typescript/lib"),
        file("node_modules/typescript/package.json", fs.readFileSync(path.join(ts, "package.json"))),
        file("node_modules/typescript/lib/typescript.js", fs.readFileSync(path.join(ts, "lib/typescript.js")))];
      await f.import(put(f, rows)); const installed = f.installParser({ lockSha256 }); assert.equal(installed.ok, true); assert.equal(installed.reused, false);
      assert.deepEqual(fs.readdirSync(installed.root).sort(), ["lib", "package.json"]); assert.equal(hash(fs.readFileSync(path.join(installed.root, "lib/typescript.js"))), installed.sha256);
      assert.equal(f.installParser({ lockSha256 }).reused, true);
      fs.writeFileSync(path.join(installed.root, "lib/typescript.js"), "changed"); assert.throws(() => f.installParser({ lockSha256 }), /conflict/);
    } finally { f.dispose(); }
  });
  await check("forged parser bytes never become the fixed parser", async () => {
    const f = deps.createFrontendBuildDependenciesFixture(); try {
      await f.import(put(f, [...basics(), dir("node_modules/typescript"), dir("node_modules/typescript/lib"),
        file("node_modules/typescript/package.json", '{"name":"typescript","version":"6.0.3","main":"./lib/typescript.js"}'), file("node_modules/typescript/lib/typescript.js", "fake parser")]));
      assert.throws(() => f.installParser({ lockSha256 }), /parser-pin/); assert.equal(fs.existsSync(path.join(f.parserRoot, "typescript")), false);
    } finally { f.dispose(); }
  });
  return { ok: true, checks, version: "frontend-offline-dependencies-verification-v1", networkRequests: 0, packageExecutions: 0, productionWrites: 0,
    scope: "Synthetic tar fixtures plus pinned real TypeScript byte copy, isolated filesystem only; not approval/import of retained production material." };
}
if (require.main === module) verify().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verify };
