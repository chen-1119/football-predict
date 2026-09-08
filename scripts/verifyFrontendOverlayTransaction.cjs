"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http"), vm = require("node:vm");
const { spawn } = require("node:child_process");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
const modulePath = path.join(__dirname, "frontendOverlayTransaction.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const artifact = value => { const bytes = Buffer.from(value); return { bytes, sha256: hash(bytes) }; };

function observedModule() {
  const events = [], handles = new Map();
  const filesystem = { ...fs,
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); handles.set(fd, file); return fd; },
    closeSync(fd) { fs.closeSync(fd); handles.delete(fd); },
    fsyncSync(fd) { events.push({ kind: "fsync", file: handles.get(fd) }); return fs.fsyncSync(fd); },
    renameSync(from, to) { events.push({ kind: "rename", from, to }); return fs.renameSync(from, to); },
  };
  const module = { exports: {} }, code = fs.readFileSync(modulePath, "utf8");
  const evaluate = vm.runInThisContext("(function(require,module,exports,__dirname,__filename){\n" + code + "\n})", { filename: modulePath });
  evaluate(name => name === "node:fs" ? filesystem : require(name), module, module.exports, __dirname, modulePath);
  return { ...module.exports, events, handles };
}
function request(port, url = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: url, agent: false }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject); res.on("aborted", () => reject(new Error("truncated fixture HTTP response")));
      res.on("end", () => resolve({ status: res.statusCode, length: Number(res.headers["content-length"]), body: Buffer.concat(chunks) }));
    }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("fixture HTTP deadline")));
  });
}

async function verifyFrontendOverlayTransaction() {
  if (process.platform !== "linux") throw new Error("this verifier requires real Linux atomic rename and directory fsync; no Windows success substitute");
  const checks = [];
  const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  function fixture(onStep) {
    const observed = observedModule(), adapter = observed.createFrontendOverlayFixtureAdapter({ onStep });
    fs.mkdirSync(path.join(adapter.distDir, "assets"));
    const original = artifact("<main>original page</main>"), candidate = artifact("<main>new page</main>"), oldAsset = artifact("old immutable asset"), newAsset = artifact("new immutable asset");
    fs.writeFileSync(path.join(adapter.distDir, "index.html"), original.bytes, { mode: 0o644 }); fs.chmodSync(path.join(adapter.distDir, "index.html"), 0o644);
    fs.writeFileSync(path.join(adapter.distDir, "assets/old-aaaaaaaa.js"), oldAsset.bytes);
    fs.writeFileSync(path.join(adapter.distDir, "robots.txt"), "unchanged robots");
    const plan = () => ({ expectedDistManifest: inspectPrebuiltDist(adapter.distDir), expectedIndexSha256: original.sha256, candidateIndex: candidate,
      newAssets: [{ path: "assets/new-bbbbbbbb.js", ...newAsset }] });
    return { adapter, observed, original, candidate, oldAsset, newAsset, plan,
      index: () => fs.readFileSync(path.join(adapter.distDir, "index.html")),
      journal: result => fs.readFileSync(result.journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line)),
      dispose: () => { assert.equal(observed.handles.size, 0); adapter.dispose(); assert.equal(fs.existsSync(adapter.rootDir), false); } };
  }
  await check("fixture boundary never accepts a production root or confers deployment authorization", () => {
    const f = fixture(); try {
      assert.equal(f.adapter.fixtureOnly, true); assert.equal(f.adapter.deploymentAuthorized, false);
      assert.equal(f.adapter.requiresOuterTrustedAuthorization, true); assert.equal(f.adapter.requiresSharedReleaseLock, true);
      assert.ok(path.basename(f.adapter.rootDir).startsWith("football-frontend-overlay-fixture-"));
    } finally { f.dispose(); }
  });
  await check("success fsyncs its journal/files/directories and changes index by one atomic rename", () => {
    const f = fixture(); try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.ok, true); assert.equal(result.state, "committed");
      assert.deepEqual(f.index(), f.candidate.bytes); assert.deepEqual(result.deletes, []);
      assert.deepEqual(fs.readFileSync(path.join(f.adapter.distDir, "assets/old-aaaaaaaa.js")), f.oldAsset.bytes);
      assert.deepEqual(fs.readFileSync(path.join(f.adapter.distDir, "assets/new-bbbbbbbb.js")), f.newAsset.bytes);
      assert.equal(fs.readFileSync(path.join(f.adapter.distDir, "robots.txt"), "utf8"), "unchanged robots");
      const renames = f.observed.events.filter(event => event.kind === "rename"); assert.equal(renames.length, 1);
      assert.equal(renames[0].to, path.join(f.adapter.distDir, "index.html")); assert.ok(renames[0].from.endsWith("index.next"));
      const phases = f.journal(result).map(row => row.phase);
      assert.deepEqual(phases, ["prepared", "asset-installed", "index-switch-intent", "index-committed", "complete"]);
      assert.ok(f.observed.events.some(event => event.kind === "fsync" && event.file === result.journalPath));
      assert.ok(f.observed.events.some(event => event.kind === "fsync" && event.file === f.adapter.distDir));
      assert.equal(fs.statSync(path.join(f.adapter.distDir, "assets/new-bbbbbbbb.js")).nlink, 1);
    } finally { f.dispose(); }
  });
  await check("existing same-name identical assets are reused without replacing their inode", () => {
    const f = fixture(); try {
      const target = path.join(f.adapter.distDir, "assets/old-aaaaaaaa.js"), before = fs.statSync(target, { bigint: true });
      const plan = f.plan(); plan.newAssets.push({ path: "assets/old-aaaaaaaa.js", ...f.oldAsset });
      const result = f.adapter.apply(plan); assert.equal(result.ok, true); assert.deepEqual(result.reusedAssets, ["assets/old-aaaaaaaa.js"]);
      assert.equal(fs.statSync(target, { bigint: true }).ino, before.ino);
    } finally { f.dispose(); }
  });
  await check("immutable name collisions reject without overwriting existing content", () => {
    const f = fixture(); try {
      const plan = f.plan(); plan.newAssets = [{ path: "assets/old-aaaaaaaa.js", ...f.newAsset }];
      assert.throws(() => f.adapter.apply(plan), /collision/); assert.deepEqual(f.index(), f.original.bytes);
      assert.deepEqual(fs.readFileSync(path.join(f.adapter.distDir, "assets/old-aaaaaaaa.js")), f.oldAsset.bytes);
    } finally { f.dispose(); }
  });
  await check("only index and declared safe hashed asset paths can enter a plan", () => {
    const f = fixture(); try {
      for (const name of ["index.html", "robots.txt", "../outside.js", "/assets/a-bbbbbbbb.js", "assets/nested/a-bbbbbbbb.js", "assets/.hidden-bbbbbbbb.js", "assets/nohash.js"]) {
        const plan = f.plan(); plan.newAssets = [{ path: name, ...f.newAsset }]; assert.throws(() => f.adapter.apply(plan), /asset-path/);
      }
      const plan = f.plan(); plan.newAssets.push(plan.newAssets[0]); assert.throws(() => f.adapter.apply(plan), /asset-path/);
      assert.deepEqual(f.index(), f.original.bytes);
    } finally { f.dispose(); }
  });
  await check("stale full-tree/index bindings and dishonest content digests cannot authorize a switch", () => {
    const f = fixture(); try {
      const digestPlan = f.plan(); digestPlan.candidateIndex = { bytes: f.candidate.bytes, sha256: "f".repeat(64) };
      assert.throws(() => f.adapter.apply(digestPlan), /digest-mismatch/);
      const stale = f.plan(); fs.appendFileSync(path.join(f.adapter.distDir, "robots.txt"), "external change");
      assert.throws(() => f.adapter.apply(stale), /baseline-mismatch/); assert.deepEqual(f.index(), f.original.bytes);
    } finally { f.dispose(); }
  });
  await check("failure before index leaves old index and all old/new assets intact", () => {
    const f = fixture(({ phase }) => { if (phase === "asset-installed") throw new Error("fixture failure after asset installation"); });
    try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.ok, false); assert.equal(result.state, "aborted-before-index");
      assert.deepEqual(f.index(), f.original.bytes); assert.equal(fs.existsSync(path.join(f.adapter.distDir, "assets/new-bbbbbbbb.js")), true);
      assert.equal(f.observed.events.filter(event => event.kind === "rename").length, 0); assert.deepEqual(result.deletes, []);
    } finally { f.dispose(); }
  });
  await check("post-switch failure restores only matching candidate index and preserves its original readable mode", () => {
    const f = fixture(({ phase }) => { if (phase === "index-committed") throw new Error("fixture post-switch failure"); });
    try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.ok, false); assert.equal(result.rollback, "restored-original");
      assert.deepEqual(f.index(), f.original.bytes); assert.equal(fs.statSync(path.join(f.adapter.distDir, "index.html")).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(path.join(f.adapter.distDir, "assets/new-bbbbbbbb.js")), true);
      assert.equal(f.observed.events.filter(event => event.kind === "rename").length, 2);
      assert.ok(f.journal(result).some(row => row.phase === "rollback-complete"));
    } finally { f.dispose(); }
  });
  for (const identical of [false, true]) {
    await check(`rollback refuses another writer's ${identical ? "same-content new inode" : "different index"}`, () => {
      let f;
      f = fixture(({ phase, distDir, directory }) => {
        if (phase !== "index-committed") return;
        const other = path.join(directory, "external-index"); fs.writeFileSync(other, identical ? f.candidate.bytes : "external writer");
        fs.renameSync(other, path.join(distDir, "index.html")); throw new Error("fixture external update after switch");
      });
      try {
        const result = f.adapter.apply(f.plan()); assert.equal(result.rollback, "refused-external-index-change");
        assert.deepEqual(f.index(), identical ? f.candidate.bytes : Buffer.from("external writer"));
        assert.equal(f.observed.events.filter(event => event.kind === "rename").length, 1);
      } finally { f.dispose(); }
    });
  }
  await check("an external index update before the final comparison is not overwritten", () => {
    const f = fixture(({ phase, distDir, directory }) => {
      if (phase === "before-index-compare") { const other = path.join(directory, "external-index"); fs.writeFileSync(other, "new external index"); fs.renameSync(other, path.join(distDir, "index.html")); }
    });
    try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.state, "aborted-before-index"); assert.equal(f.index().toString(), "new external index");
      assert.equal(f.observed.events.filter(event => event.kind === "rename").length, 0);
    } finally { f.dispose(); }
  });
  await check("undeclared dist changes before commit abort without publishing the candidate", () => {
    const f = fixture(({ phase, distDir }) => { if (phase === "before-index-compare") fs.writeFileSync(path.join(distDir, "robots.txt"), "external robots"); });
    try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.state, "aborted-before-index"); assert.deepEqual(f.index(), f.original.bytes);
      assert.equal(fs.readFileSync(path.join(f.adapter.distDir, "robots.txt"), "utf8"), "external robots");
    } finally { f.dispose(); }
  });
  await check("fixture lock prevents a competing transaction while the first holds its boundary", () => {
    let f, conflict = false;
    f = fixture(({ phase }) => { if (phase === "prepared") { assert.throws(() => f.adapter.apply(f.plan()), /lock-busy/); conflict = true; } });
    try { assert.equal(f.adapter.apply(f.plan()).ok, true); assert.equal(conflict, true); }
    finally { f.dispose(); }
  });
  await check("symlink replacement of assets directory never writes outside the verified dist", () => {
    const f = fixture(({ phase, distDir, directory }) => {
      if (phase === "prepared") { fs.renameSync(path.join(distDir, "assets"), path.join(directory, "old-assets")); fs.mkdirSync(path.join(directory, "foreign")); fs.symlinkSync(path.join(directory, "foreign"), path.join(distDir, "assets")); }
    });
    try {
      const result = f.adapter.apply(f.plan()); assert.equal(result.ok, false); assert.deepEqual(f.index(), f.original.bytes);
      assert.equal(fs.readdirSync(path.join(path.dirname(result.journalPath), "foreign")).length, 0);
    } finally { f.dispose(); }
  });
  await check("real Linux HTTP clients with old open handles and new requests both receive complete pages across atomic replacement", async () => {
    const f = fixture(); let child;
    try {
      const oldBytes = Buffer.from("old 中😀 ".repeat(24000)), newBytes = Buffer.from("new 页面 ".repeat(41000));
      fs.writeFileSync(path.join(f.adapter.distDir, "index.html"), oldBytes);
      const plan = { ...f.plan(), expectedIndexSha256: hash(oldBytes), candidateIndex: artifact(newBytes) };
      const childSource = String.raw`
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path');
const {sendStaticFileResponse}=require(process.argv[1]);const dist=process.argv[2];let hold=true,opened=0;const waiters=[];
const server=http.createServer((req,res)=>{const file=path.join(dist,req.url==='/'?'index.html':req.url.slice(1));
sendStaticFileResponse({res,filePath:file,prepare:stat=>({headers:{'content-length':stat.size,'content-type':'text/html'}}),onNotFound:()=>{res.writeHead(404);res.end();}},
{openFile:async(...args)=>{const handle=await fs.open(...args);if(hold&&file===path.join(dist,'index.html')){process.send({opened:++opened});await new Promise(resolve=>waiters.push(resolve));}return handle;}});});
process.on('message',message=>{if(message==='release'){hold=false;for(const resolve of waiters.splice(0))resolve();}if(message==='stop'){server.closeAllConnections();server.close(()=>process.exit(0));}});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
`;
      let readyResolve, openedResolve;
      const ready = new Promise(resolve => { readyResolve = resolve; }), opened = new Promise(resolve => { openedResolve = resolve; });
      child = spawn(process.execPath, ["-e", childSource, path.join(__dirname, "../server/staticFileResponse.cjs"), f.adapter.distDir], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: path.dirname(process.execPath), LANG: "C.UTF-8" } });
      let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
      child.on("message", message => { if (message.port) readyResolve(message.port); if (message.opened === 16) openedResolve(); });
      const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture server startup/open deadline: " + stderr)), 5000); timer.unref(); });
      const port = await Promise.race([ready, deadline]);
      const oldRequests = Array.from({ length: 16 }, () => request(port));
      await Promise.race([opened, deadline]);
      const result = f.adapter.apply(plan); assert.equal(result.ok, true); child.send("release");
      const newRequests = Array.from({ length: 16 }, () => request(port));
      const [oldResponses, newResponses] = await Promise.all([Promise.all(oldRequests), Promise.all(newRequests)]);
      for (const [responses, expected] of [[oldResponses, oldBytes], [newResponses, newBytes]]) {
        for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.length, expected.length); assert.deepEqual(response.body, expected); }
      }
      for (const [url, expected] of [["/assets/old-aaaaaaaa.js", f.oldAsset.bytes], ["/assets/new-bbbbbbbb.js", f.newAsset.bytes]]) {
        const response = await request(port, url); assert.equal(response.status, 200); assert.deepEqual(response.body, expected);
      }
      assert.equal(f.observed.events.filter(event => event.kind === "rename").length, 1);
      await new Promise((resolve, reject) => { child.once("exit", code => code === 0 ? resolve() : reject(new Error("fixture HTTP child exit: " + code))); child.send("stop"); }); child = null;
    } finally {
      if (child && child.exitCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
      f.dispose();
    }
  });
  return { ok: true, verifier: "frontend-overlay-fixture-transaction-v1", checks, productionWrites: 0, providerRequests: 0,
    deploymentAuthorized: false, fixtureOnly: true, requiresOuterTrustedAuthorization: true, requiresSharedReleaseLock: true,
    atomicIndexReplacement: "one Linux rename per successful switch", concurrentHttp: { oldOpenedBeforeSwitch: 16, newAfterSwitch: 16, retainedAssetsChecked: 2 },
    scope: "private temp-tree file transaction plus real child-process loopback HTTP; no production CLI, signature authorization or shared production lock integration" };
}
module.exports = { verifyFrontendOverlayTransaction };
if (require.main === module) verifyFrontendOverlayTransaction().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
