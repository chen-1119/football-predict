"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const sandbox = require("./frontendBuildSandbox.cjs"), build = require("./frontendBuildEvidence.cjs");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
function verify({ linuxFixtureRoot = null } = {}) {
  const checks = [], executions = [], cleanup = [];
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const args = { directory: "/run/football-frontend-sandbox-" + "a".repeat(24), sandbox: "/var/lib/football-release/frontend-builds/" + "b".repeat(24) + "/sandbox-" + "a".repeat(24) + "/rootfs", unit: "football-frontend-build-" + "a".repeat(24) + "-1.service", commandIndex: 0, timeoutMs: 1000 };
  check("fixed reviewed commands agree with the ordinary experimental builder", () => assert.deepEqual(sandbox.COMMANDS, build.COMMANDS));
  check("native compatibility closure is fixed to librt, never candidate addon ldd", () => {
    assert.deepEqual(sandbox.NATIVE_COMPAT_LIBRARIES, ["librt.so.1"]); assert.ok(Object.isFrozen(sandbox.NATIVE_COMPAT_LIBRARIES));
  });
  check("unit uses private rootfs, dynamic identity, no IP network, no capabilities and whole-cgroup cleanup", () => {
    const result = sandbox.unitArguments(args);
    for (const prop of ["DynamicUser=yes", "User=fbui" + "a".repeat(24), "RootDirectory=" + args.sandbox,
      "PrivateNetwork=yes", "PrivateTmp=no", "ProtectSystem=strict", "NoNewPrivileges=yes", "ProtectProc=invisible",
      "ProcSubset=pid", "RestrictAddressFamilies=AF_UNIX", "CapabilityBoundingSet=", "RestrictNamespaces=yes",
      "KillMode=control-group", "SendSIGKILL=yes", "RemainAfterExit=yes"])
      assert.ok(result.includes("--property=" + prop), prop);
    assert.deepEqual(result.slice(result.indexOf("--") + 1), [sandbox.NODE, ...sandbox.COMMANDS[0]]);
    const writable = result.filter(a => a.startsWith("--property=ReadWritePaths=")); assert.equal(writable.length, 1);
    assert.equal(writable[0], "--property=ReadWritePaths=+/workspace/dist +/workspace/node_modules/.vite-temp +/workspace/node_modules/.tmp/tsconfig.app.tsbuildinfo +/workspace/node_modules/.tmp/tsconfig.node.tsbuildinfo");
    assert.ok(!result.some(a => /BindPaths|\/opt\/football|\/var\/lib\/football-predict/.test(a)));
    assert.ok(result.includes("--property=Environment=STATIC_DIST_STRIP_SETTLE_MS=0"));
    assert.ok(result.includes("--property=InaccessiblePaths=-+/tmp -+/var/tmp -+/dev/shm"));
    assert.ok(result.includes("--property=SystemCallFilter=~@debug @mount @reboot @swap @privileged"));
    assert.ok(result.includes("--property=SystemCallErrorNumber=EPERM"));
    assert.ok(result.includes("--property=Environment=HOME=/build-home"));
  });
  check("caller cannot select an unrelated unit, path, command or unbounded deadline", () => {
    for (const patch of [{ directory: "/tmp/untrusted" }, { unit: "football-predict.service" }, { commandIndex: 1 }, { commandIndex: 8 }, { timeoutMs: 0 }, { timeoutMs: 600001 }])
      assert.throws(() => sandbox.unitArguments({ ...args, ...patch }), /sandbox-unit/);
  });
  const quiet = { observed: true, ActiveState: "inactive", LoadState: "not-found", MainPID: "0", ControlPID: "0" };
  check("process exit alone is not descendant quiescence", () => {
    assert.equal(sandbox.unitQuiescent(quiet, true), true); assert.equal(sandbox.unitQuiescent(quiet, false), false);
    for (const patch of [{ observed: false }, { ActiveState: "active" }, { MainPID: "12" }, { ControlPID: "13" }, { LoadState: "error" }])
      assert.equal(sandbox.unitQuiescent({ ...quiet, ...patch }, true), false);
  });
  check("Windows and non-root runtimes cannot emit a sandbox build receipt", () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || process.execPath !== sandbox.NODE)
      assert.throws(() => sandbox.runSandboxedFrontendBuild({}), /fixed-clean-linux-root/);
    assert.throws(() => sandbox.runSandboxFixture({ fixtureRoot: "/tmp/not-our-fixture", rootDir: "/tmp/not-our-fixture/root" }), /fixture-boundary/);
    assert.throws(() => sandbox.runSandboxedFrontendBuild({ ok: true }), /unknown-option/);
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-sandbox-output-check-"));
  try {
    fs.writeFileSync(path.join(temp, "plain"), "safe");
    check("output inventory reads actual bounded plain bytes", () => {
      assert.deepEqual(sandbox.inspectWritableTree(temp), [{ path: "plain", bytes: 4, sha256: crypto.createHash("sha256").update("safe").digest("hex") }]);
    });
    check("sparse oversized outputs fail the complete metadata budget before any body read", () => {
      const file = path.join(temp, "oversized"), fd = fs.openSync(file, "wx");
      try { fs.ftruncateSync(fd, 129 * 1024 * 1024); } finally { fs.closeSync(fd); }
      const original = fs.readFileSync; let reads = 0;
      try { fs.readFileSync = (...a) => { reads++; return original(...a); }; assert.throws(() => sandbox.inspectWritableTree(temp), /output-size-limit/); assert.equal(reads, 0); }
      finally { fs.readFileSync = original; fs.unlinkSync(file); }
    });
    if (process.platform !== "win32") check("output hardlinks and symlinks are rejected before normalization/export", () => {
      fs.linkSync(path.join(temp, "plain"), path.join(temp, "linked")); assert.throws(() => sandbox.inspectWritableTree(temp), /nonplain/); fs.unlinkSync(path.join(temp, "linked"));
      fs.symlinkSync(path.join(temp, "plain"), path.join(temp, "linked")); assert.throws(() => sandbox.inspectWritableTree(temp), /nonplain/); fs.unlinkSync(path.join(temp, "linked"));
    });
  } finally { for (const file of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, file)); fs.rmdirSync(temp); }

  if (linuxFixtureRoot) {
    assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0); assert.ok(__filename.startsWith(linuxFixtureRoot + "/"));
    const originalUmask = process.umask(0o077);
    check("production entry rejects arbitrary private roots before any filesystem mutation", () => {
      assert.throws(() => sandbox.runSandboxedFrontendBuild({ rootDir: linuxFixtureRoot }), /production-stage-root-required/);
    });
    let count = 0;
    function fixture({ compiler, bundler, strip }) {
      const root = path.join(linuxFixtureRoot, "build-" + ++count); fs.mkdirSync(root, { mode: 0o700 });
      const write = (name, bytes) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
      write("package.json", JSON.stringify({ scripts: { build: build.BUILD_SCRIPT } })); write("package-lock.json", "{}");
      write("src/App.tsx", "fixture original"); write("node_modules/dependency.cjs", "module.exports=1");
      write("node_modules/typescript/bin/tsc", compiler); write("node_modules/vite/bin/vite.js", bundler || ""); write("scripts/stripLargeStaticPayloads.cjs", strip || "");
      const prior = path.join(linuxFixtureRoot, "baseline-" + count); fs.mkdirSync(path.join(prior, "assets"), { recursive: true });
      fs.writeFileSync(path.join(prior, "index.html"), "old fixture"); fs.writeFileSync(path.join(prior, "assets/index-aaaaaaaa.js"), "old");
      return { root, baseline: inspectPrebuiltDist(prior) };
    }
    const run = (f, timeoutMs = 15000) => {
      try {
        const result = sandbox.runSandboxFixture({ fixtureRoot: linuxFixtureRoot, rootDir: f.root, baselineDist: f.baseline, baselineReleaseSha256: "a".repeat(64), timeoutMs });
        executions.push(result); return result;
      } catch (error) {
        if (error.evidence) {
          executions.push(error.evidence);
          error.evidence.fixtureDiagnostics = [0, 1, 2].map(i => {
            const file = path.join(error.evidence.directory, "stderr-" + i + ".log");
            if (!fs.existsSync(file)) return null;
            const fd = fs.openSync(file, "r"), b = Buffer.alloc(8192);
            try { return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString("utf8"); } finally { fs.closeSync(fd); }
          });
        }
        throw error;
      }
    };
    try {
      check("real Linux units deny source/dependency/extra-cache writes, IP sockets, host paths and reap exited descendants", () => {
        const compiler = "const fs=require('fs'),net=require('net'),cp=require('child_process');" +
          "if(require('os').homedir()!=='/build-home')throw Error('unexpected home');" +
          "const denied=[];for(const p of ['src/App.tsx','node_modules/dependency.cjs','node_modules/.tmp/extra','/tmp/escape','/build-home/escape']){try{fs.writeFileSync(p,'bad');throw Error('write allowed:'+p)}catch(e){if(!['EACCES','EROFS'].includes(e.code))throw e;denied.push(p)}}" +
          "for(const p of ['/etc/football-release','/var/lib/football-predict','/opt/football-predict','/run/dbus/system_bus_socket']){if(fs.existsSync(p))throw Error('host path exposed:'+p)}" +
          "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'});child.unref();" +
          "const server=net.createServer();server.once('error',e=>{if(!['EAFNOSUPPORT','EPERM','EACCES'].includes(e.code))throw e;" +
          "fs.writeFileSync('node_modules/.tmp/tsconfig.app.tsbuildinfo',JSON.stringify({uid:process.getuid(),child:child.pid,denied,network:e.code}));});server.listen(0,'127.0.0.1');";
        const bundler = "const fs=require('fs');const c=JSON.parse(fs.readFileSync('node_modules/.tmp/tsconfig.app.tsbuildinfo'));" +
          "fs.mkdirSync('dist/assets',{recursive:true});fs.mkdirSync('dist/nested',{recursive:true});" +
          "fs.writeFileSync('dist/nested/remove.json','delete me');const fd=fs.openSync('dist/nested/remove.json','r+');" +
          "try{fs.fchownSync(fd,process.getuid(),process.getgid());throw Error('filtered fchown allowed')}catch(e){if(e.code!=='EPERM')throw e;c.fchown=e.code}finally{fs.closeSync(fd)}" +
          "fs.copyFileSync('src/App.tsx','dist/nested/remove.json');fs.copyFileSync('src/App.tsx','dist/nested/remove.json');" +
          "fs.writeFileSync('dist/assets/index-bbbbbbbb.js',JSON.stringify(c));" +
          "fs.writeFileSync('dist/index.html','new fixture');fs.writeFileSync('node_modules/.vite-temp/config.mjs','ephemeral');fs.unlinkSync('node_modules/.vite-temp/config.mjs');";
        const strip = "const fs=require('fs');fs.unlinkSync('dist/nested/remove.json');fs.rmdirSync('dist/nested');fs.appendFileSync('dist/index.html',' stripped');";
        const f = fixture({ compiler, bundler, strip }), result = run(f);
        assert.equal(result.executionAssurance, sandbox.ASSURANCE); assert.equal(result.scope, "isolated-fixture"); assert.equal(result.signingEligible, false);
        assert.equal(result.rootfsRemoved, true); assert.equal(result.runs.length, 3);
        for (const r of result.runs) { assert.ok(r.ok); assert.ok(r.dynamicUid >= 61184); assert.ok(r.cleanup.quiescent); assert.ok(sandbox.cgroupEmpty(r.unit)); }
        const data = JSON.parse(fs.readFileSync(path.join(f.root, "dist/assets/index-bbbbbbbb.js"), "utf8"));
        assert.equal(data.denied.length, 5); assert.ok(data.network); assert.equal(data.fchown,"EPERM"); assert.ok(!fs.existsSync("/proc/" + data.child));
        assert.equal(fs.readFileSync(path.join(f.root, "src/App.tsx"), "utf8"), "fixture original");
        assert.equal(fs.readFileSync(path.join(f.root, "dist/index.html"), "utf8"), "new fixture stripped");
        assert.throws(() => sandbox.readSandboxEvidence(result), /not-production-build-proof/);
      });
      check("real timeout kills detached SIGTERM-resistant descendants before cleanup and never exports dist", () => {
        const compiler = "const fs=require('fs'),cp=require('child_process');" +
          "const c=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},100)\"],{detached:true,stdio:'ignore'});" +
          "fs.writeFileSync('node_modules/.tmp/tsconfig.app.tsbuildinfo',String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);";
        const f = fixture({ compiler });
        assert.throws(() => run(f, 1500), e => {
          assert.ok(e.evidence); assert.equal(e.evidence.signingEligible, false); assert.equal(e.evidence.rootfsRemoved, true);
          assert.equal(e.evidence.runs.length, 1); assert.ok(e.evidence.runs[0].timedOut); assert.ok(e.evidence.runs[0].cleanup.quiescent);
          assert.ok(sandbox.cgroupEmpty(e.evidence.runs[0].unit)); return /command-failed/.test(e.message);
        });
        assert.ok(!fs.existsSync(path.join(f.root, "dist")));
      });
    } finally {
      process.umask(originalUmask);
      for (const execution of executions) {
        const directory = execution.directory;
        assert.match(directory, /^\/run\/football-frontend-sandbox-[a-f0-9]{24}$/); assert.equal(fs.realpathSync(directory), directory);
        assert.equal(execution.rootfsRemoved, true, "never delete evidence for a rootfs retained after failed quiescence");
        const names = fs.readdirSync(directory); assert.ok(names.length <= 8);
        for (const name of names) {
          assert.match(name, /^(?:(?:stdout|stderr)-[012]\.log|evidence\.json|complete\.json)$/);
          const file = path.join(directory, name), s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && s.nlink === 1); fs.unlinkSync(file);
        }
        fs.rmdirSync(directory); cleanup.push({ directory, removed: !fs.existsSync(directory) });
      }
    }
  }
  return { ok: true, version: sandbox.VERSION, checks, executions, cleanup, productionWrites: 0, providerRequests: 0,
    scope: linuxFixtureRoot ? "real Linux DynamicUser/rootfs/cgroup hostile fixtures, not a production frontend build" : "portable policy/output tests only; no Linux isolation claim" };
}
module.exports = { verify };
if (require.main === module) {
  try { console.log(JSON.stringify(verify(process.argv[2] === "--linux-fixture" ? { linuxFixtureRoot: process.argv[3] } : {}), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.stack, evidence: error.evidence || null }, null, 2)); process.exitCode = 1; }
}
