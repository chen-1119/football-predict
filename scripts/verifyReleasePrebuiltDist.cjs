"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { MANIFEST_VERSION, inspectPrebuiltDist, verifyPrebuiltDist } = require("./releasePrebuiltDist.cjs");

const helperPath = path.join(__dirname, "releasePrebuiltDist.cjs");
const helperSource = fs.readFileSync(helperPath, "utf8");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Execute the actual helper with only filesystem interception replaced. Each
// operation still reads a real isolated file; no production/global fs patching.
function instrument(hooks = {}) {
  const active = new Map(), counters = { opens: 0, closes: 0, reads: 0, maxChunk: 0, wholeReads: 0 };
  const fileSystem = {
    ...fs,
    openSync(filename, flags, ...rest) {
      hooks.beforeOpen?.(filename);
      const fd = fs.openSync(filename, flags, ...rest); active.set(fd, filename); counters.opens++;
      return fd;
    },
    closeSync(fd) { fs.closeSync(fd); active.delete(fd); counters.closes++; },
    readSync(fd, buffer, offset, length, position) {
      counters.reads++; counters.maxChunk = Math.max(counters.maxChunk, buffer.length, length);
      const filename = active.get(fd);
      hooks.beforeRead?.({ filename, fd, buffer, offset, length, position });
      if (hooks.zeroRead) return 0;
      const count = fs.readSync(fd, buffer, offset, length, position);
      hooks.afterRead?.({ filename, fd, count, position });
      return count;
    },
    readFileSync() { counters.wholeReads++; throw new Error("unbounded whole-file read forbidden in verifier fixture"); },
  };
  const module = { exports: {} };
  const isolatedRequire = name => name === "node:fs" ? fileSystem : require(name);
  vm.runInThisContext("(function(require,module,exports,__filename,__dirname){\n" + helperSource + "\n})", { filename: helperPath })
    (isolatedRequire, module, module.exports, helperPath, __dirname);
  return { ...module.exports, counters, active };
}

function verifyReleasePrebuiltDist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-prebuilt-dist-"));
  const checks = []; let sequence = 0;
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const fixture = () => {
    const directory = path.join(root, String(++sequence)), dist = path.join(directory, "dist");
    const manifestPath = path.join(directory, "manifest.json");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    const write = (name, bytes) => { const file = path.join(dist, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
    write("index.html", "<main>ok</main>\n"); write("assets/app.js", "console.log('ok');\n");
    return { directory, dist, manifestPath, write };
  };
  const logicalFile = (filename, bytes) => { const fd = fs.openSync(filename, "wx"); try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); } };
  const replace = (next, file) => {
    if (process.platform === "win32") fs.renameSync(file, `${file}.retired`);
    fs.renameSync(next, file);
  };
  const closed = observed => { assert.equal(observed.active.size, 0); assert.equal(observed.counters.opens, observed.counters.closes); assert.equal(observed.counters.wholeReads, 0); };
  try {
    check("manifest API, file ordering and tree hash are byte-compatible with the existing schema", () => {
      const f = fixture(), manifest = inspectPrebuiltDist(f.dist);
      const files = ["assets/app.js", "index.html"].map(name => {
        const bytes = fs.readFileSync(path.join(f.dist, name)); return { path: name, bytes: bytes.length, sha256: digest(bytes) };
      });
      const expected = { version: MANIFEST_VERSION, files, fileCount: 2, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0) };
      assert.deepEqual(manifest, { ...expected, treeHash: digest(Buffer.from(JSON.stringify(expected), "utf8")) });
      fs.writeFileSync(f.manifestPath, JSON.stringify(manifest));
      assert.equal(verifyPrebuiltDist({ distDir: f.dist, manifestPath: f.manifestPath }).ok, true);
    });
    check("content tampering still rejects a previously captured manifest", () => {
      const f = fixture(); fs.writeFileSync(f.manifestPath, JSON.stringify(inspectPrebuiltDist(f.dist)));
      fs.appendFileSync(path.join(f.dist, "assets/app.js"), "tamper\n");
      const result = verifyPrebuiltDist({ distDir: f.dist, manifestPath: f.manifestPath });
      assert.equal(result.ok, false); assert.notEqual(result.actualTreeHash, result.expectedTreeHash);
    });
    check("file symlinks or Windows directory junctions remain rejected", () => {
      const f = fixture();
      try { fs.symlinkSync(path.join(f.dist, "index.html"), path.join(f.dist, "linked.html")); }
      catch (error) { if (error.code !== "EPERM") throw error; fs.symlinkSync(path.join(f.dist, "assets"), path.join(f.dist, "linked-assets"), "junction"); }
      assert.throws(() => inspectPrebuiltDist(f.dist), /symlink/);
    });
    check("hardlinked file aliases remain rejected", () => {
      const f = fixture(); fs.linkSync(path.join(f.dist, "index.html"), path.join(f.directory, "alias.html"));
      assert.throws(() => inspectPrebuiltDist(f.dist), /non-plain/);
    });
    check("oversized logical/sparse files are rejected before any content descriptor is opened", () => {
      const f = fixture(); logicalFile(path.join(f.dist, "assets/oversized.bin"), 128 * 1024 * 1024 + 1);
      const observed = instrument(); assert.throws(() => observed.inspectPrebuiltDist(f.dist), /byte size.*outside policy/);
      assert.equal(observed.counters.opens, 0); assert.equal(observed.counters.reads, 0); closed(observed);
    });
    check("aggregate byte limit is checked for the whole tree before any content read", () => {
      const f = fixture();
      logicalFile(path.join(f.dist, "assets/first.bin"), 64 * 1024 * 1024);
      logicalFile(path.join(f.dist, "assets/second.bin"), 64 * 1024 * 1024);
      const observed = instrument(); assert.throws(() => observed.inspectPrebuiltDist(f.dist), /byte size.*outside policy/);
      assert.equal(observed.counters.opens, 0); assert.equal(observed.counters.reads, 0); closed(observed);
    });
    check("oversized manifest input is rejected before opening its contents", () => {
      const f = fixture(); logicalFile(f.manifestPath, 32 * 1024 * 1024 + 1);
      const observed = instrument(); assert.throws(() => observed.verifyPrebuiltDist({ distDir: f.dist, manifestPath: f.manifestPath }), /byte size.*outside policy/);
      assert.equal(observed.counters.opens, 0); assert.equal(observed.counters.reads, 0); closed(observed);
    });
    check("streamed artifact and manifest reads never allocate a file-sized read buffer", () => {
      const f = fixture(), bytes = Buffer.alloc(256 * 1024 + 7, 123); f.write("assets/large.bin", bytes);
      const observed = instrument(), manifest = observed.inspectPrebuiltDist(f.dist);
      assert.equal(manifest.files.find(row => row.path === "assets/large.bin").sha256, digest(bytes));
      fs.writeFileSync(f.manifestPath, JSON.stringify(manifest));
      assert.equal(observed.verifyPrebuiltDist({ distDir: f.dist, manifestPath: f.manifestPath }).ok, true);
      assert.ok(observed.counters.reads >= 10); assert.equal(observed.counters.maxChunk, 64 * 1024); closed(observed);
    });
    for (const stage of ["beforeOpen", "beforeRead"]) {
      check(`pathname replacement at ${stage} cannot pair metadata with a different inode`, () => {
        const f = fixture(), file = path.join(f.dist, "index.html"), next = path.join(f.directory, "next.html");
        fs.writeFileSync(next, "replacement"); let changed = false;
        const mutate = value => {
          const filename = typeof value === "string" ? value : value.filename;
          if (filename === file && !changed) { changed = true; replace(next, file); }
        };
        const observed = instrument({ [stage]: mutate }); assert.throws(() => observed.inspectPrebuiltDist(f.dist), /identity drift/);
        assert.equal(changed, true); closed(observed);
      });
    }
    for (const mutation of ["same-size", "truncate", "grow"]) {
      check(`in-place ${mutation} mutation during a read is detected and the fd closes`, () => {
        const f = fixture(), file = f.write("index.html", Buffer.alloc(128 * 1024, 1)); let changed = false;
        const observed = instrument({ afterRead: ({ filename }) => {
          if (filename !== file || changed) return; changed = true;
          if (mutation === "truncate") fs.truncateSync(file, 4);
          else if (mutation === "grow") fs.appendFileSync(file, "more");
          else { fs.writeFileSync(file, Buffer.alloc(128 * 1024, 2)); fs.utimesSync(file, new Date(), new Date(Date.now() + 2000)); }
        } });
        assert.throws(() => observed.inspectPrebuiltDist(f.dist), /(?:identity|read) drift/); closed(observed);
      });
    }
    check("an earlier file modified while hashing a later file fails the final whole-tree check", () => {
      const f = fixture(), first = path.join(f.dist, "index.html"), later = path.join(f.dist, "assets/app.js"); let changed = false;
      const observed = instrument({ afterRead: ({ filename }) => {
        if (filename === later && !changed) { changed = true; fs.appendFileSync(first, "late"); }
      } });
      assert.throws(() => observed.inspectPrebuiltDist(f.dist), /identity drift/); assert.equal(changed, true); closed(observed);
    });
    check("a new directory member appearing during hashing invalidates the inventory", () => {
      const f = fixture(); let changed = false;
      const observed = instrument({ afterRead: () => { if (!changed) { changed = true; f.write("late.txt", "not inventoried"); } } });
      assert.throws(() => observed.inspectPrebuiltDist(f.dist), /directory.*drift/); closed(observed);
    });
    check("replacing an empty directory is detected even when no file names or hashes change", () => {
      const f = fixture(), empty = path.join(f.dist, "empty"); fs.mkdirSync(empty); let changed = false;
      const observed = instrument({ afterRead: () => {
        if (!changed) { changed = true; fs.renameSync(empty, path.join(f.directory, "retired-empty")); fs.mkdirSync(empty); }
      } });
      assert.throws(() => observed.inspectPrebuiltDist(f.dist), /directory.*drift/); closed(observed);
    });
    check("short reads fail closed and release the opened descriptor", () => {
      const f = fixture(), observed = instrument({ zeroRead: true });
      assert.throws(() => observed.inspectPrebuiltDist(f.dist), /read drift/); closed(observed);
    });
    check("read exceptions release the opened descriptor", () => {
      const f = fixture(), observed = instrument({ beforeRead: () => { throw new Error("isolated read error"); } });
      assert.throws(() => observed.inspectPrebuiltDist(f.dist), /isolated read error/); closed(observed);
    });
    check("manifest pathname replacement during its read is rejected before comparison", () => {
      const f = fixture(); fs.writeFileSync(f.manifestPath, JSON.stringify(inspectPrebuiltDist(f.dist)));
      const next = path.join(f.directory, "replacement.json"); fs.copyFileSync(f.manifestPath, next); let changed = false;
      const observed = instrument({ beforeRead: ({ filename }) => {
        if (filename === f.manifestPath && !changed) { changed = true; replace(next, filename); }
      } });
      assert.throws(() => observed.verifyPrebuiltDist({ distDir: f.dist, manifestPath: f.manifestPath }), /identity drift/); closed(observed);
    });
    return { ok: true, verifier: "release-prebuilt-dist", assertions: checks.length, checks,
      guarantees: { deterministicTreeHash: true, tamperRejected: true, symlinkRejected: true,
        preReadSizeLimits: true, boundedChunkReads: true, fileIdentityDriftRejected: true, directoryDriftRejected: true, descriptorsClosed: true },
      productionWrites: 0, providerRequests: 0,
      scope: "actual scanner with real temporary files and controlled filesystem interleavings; oversized logical files are never content-read; no production or full release validation" };
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^football-prebuilt-dist-[A-Za-z0-9]+$/);
    for (const directory of fs.readdirSync(root)) {
      for (const name of ["linked.html", "linked-assets"]) {
        const link = path.join(root, directory, "dist", name);
        if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { verifyReleasePrebuiltDist };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(verifyReleasePrebuiltDist(), null, 2)}\n`); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
