"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const runtime = require("./frontendInstalledRuntime.cjs");

function verifyFrontendRuntimeAlternatives() {
  assert.equal(process.platform, "linux", "real POSIX links/ownership proof requires Linux");
  const context = { module: { exports: {} }, __dirname, process, Buffer,
    require: name => name.startsWith(".") ? require(path.resolve(__dirname, name)) : require(name) };
  const source = fs.readFileSync(path.join(__dirname, "frontendInstalledRuntime.cjs"), "utf8");
  vm.runInNewContext(source + "\nmodule.exports.testContext = makeContext;", context);
  const fixture = runtime.createInstalledFrontendRuntimeFixture(), results = [];
  const write = (logical, bytes, mode = 0o755) => {
    const file = fixture.at(logical); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, bytes, { mode, flag: "wx" }); return file;
  };
  const link = (target, logical) => fs.symlinkSync(target, fixture.at(logical));
  const replaceLink = (target, logical) => { fs.unlinkSync(fixture.at(logical)); link(target, logical); };
  const check = (name, fn) => { fn(); results.push({ name, ok: true }); };
  const resolve = (logical = "/usr/bin/awk") => context.module.exports.testContext(fixture.root).resolveExecutable(logical);
  try {
    fs.mkdirSync(fixture.at("/etc/alternatives"), { recursive: true, mode: 0o755 });
    write("/usr/bin/gawk", "fixture-gawk-v1");
    link("/etc/alternatives/awk", "/usr/bin/awk"); link("/usr/bin/gawk", "/etc/alternatives/awk");
    check("exact two-hop alternative retains both links and final executable hash", () => {
      const a = resolve(); assert.equal(a.path, "/usr/bin/gawk"); assert.equal(a.links.length, 2);
      assert.deepEqual(JSON.parse(JSON.stringify(a.links)), [{ path: "/usr/bin/awk", target: "/etc/alternatives/awk" }, { path: "/etc/alternatives/awk", target: "/usr/bin/gawk" }]);
      fs.writeFileSync(fixture.at("/usr/bin/gawk"), "fixture-gawk-v2"); assert.notEqual(resolve().sha256, a.sha256);
    });
    check("merged usr alias is accepted without losing any hop", () => {
      link("usr/bin", "/bin"); assert.equal(resolve("/bin/awk").links.length, 3);
    });
    check("arbitrary alternatives and indirect entry remain rejected", () => {
      for (const target of ["/etc/alternatives/python", "/etc/alternatives/../alternatives/awk"]) {
        replaceLink(target, "/usr/bin/awk"); assert.throws(() => resolve(), /runtime-command-link-escape/);
      }
      replaceLink("/etc/alternatives/awk", "/usr/bin/awk");
      link("/etc/alternatives/awk", "/usr/bin/other"); assert.throws(() => resolve("/usr/bin/other"), /runtime-command-link-escape/);
      assert.throws(() => resolve("/etc/alternatives/awk"), /unreviewed-system-alternative-entry/);
    });
    check("unreviewed target and third-hop executable redirection remain rejected", () => {
      for (const target of ["/usr/bin/mawk", "/tmp/awk", "../../usr/bin/gawk"]) {
        replaceLink(target, "/etc/alternatives/awk"); assert.throws(() => resolve(), /unreviewed-system-alternative-target/);
      }
      replaceLink("/usr/bin/gawk", "/etc/alternatives/awk");
      fs.renameSync(fixture.at("/usr/bin/gawk"), fixture.at("/usr/bin/renamed-gawk"));
      link("/usr/bin/renamed-gawk", "/usr/bin/gawk"); assert.throws(() => resolve(), /unreviewed-system-alternative-target/);
      fs.unlinkSync(fixture.at("/usr/bin/gawk")); fs.renameSync(fixture.at("/usr/bin/renamed-gawk"), fixture.at("/usr/bin/gawk"));
    });
    check("writable parents nonexecutable binaries and changed links are not trusted", () => {
      fs.chmodSync(fixture.at("/etc/alternatives"), 0o777); assert.throws(() => resolve(), /unsafe-runtime/); fs.chmodSync(fixture.at("/etc/alternatives"), 0o755);
      fs.chmodSync(fixture.at("/usr/bin/gawk"), 0o644); assert.throws(() => resolve(), /nonexecutable/); fs.chmodSync(fixture.at("/usr/bin/gawk"), 0o755);
      const ctx = context.module.exports.testContext(fixture.root); ctx.resolveExecutable("/usr/bin/awk");
      replaceLink("/usr/bin/mawk", "/etc/alternatives/awk"); assert.throws(() => ctx.recheck(), /changed-during-capture/);
      replaceLink("/usr/bin/gawk", "/etc/alternatives/awk");
    });
    if (process.getuid() === 0) check("non-root alternative link owner fails", () => {
      fs.lchownSync(fixture.at("/etc/alternatives/awk"), 65534, 65534); assert.throws(() => resolve(), /unsafe-command-link-owner/);
      fs.lchownSync(fixture.at("/etc/alternatives/awk"), 0, 0);
    });
    check("absent conditional file is rechecked and a new file or dangling link invalidates capture", () => {
      fs.mkdirSync(fixture.at("/etc/football-predict"), { mode: 0o755 });
      const logical = "/etc/football-predict/cos-backup.env", ctx = context.module.exports.testContext(fixture.root);
      assert.equal(ctx.recordAbsent(logical).absent, true); ctx.recheck();
      write(logical, "fixture-only", 0o600); assert.throws(() => ctx.recheck(), /conditional-environment-appeared/);
      fs.unlinkSync(fixture.at(logical)); link("/missing-target", logical);
      assert.throws(() => ctx.recordAbsent(logical), /conditional-environment-appeared/);
      assert.throws(() => ctx.recheck(), /conditional-environment-appeared/);
    });
    return { ok: true, checks: results.length, results, linuxFilesystemProof: true, productionWrites: 0 };
  } finally { fixture.dispose(); }
}
module.exports = { verifyFrontendRuntimeAlternatives };
if (require.main === module) console.log(JSON.stringify(verifyFrontendRuntimeAlternatives(), null, 2));
