"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const tools = require("./frontendReleaseInputs.cjs"), prepare = require("./prepareFrontendRelease.cjs");
const H = c => c.repeat(64), json = value => Buffer.from(JSON.stringify(value) + "\n"), checks = [];
const test = (name, fn) => { try { fn(); checks.push({ name, ok: true }); } catch(e) { checks.push({ name, ok: false, error: e.message }); } };
function fixture(kind = "frontend-only") {
  const baseline = { sha256: H("a"), releaseSequence: 718, archiveSourceEvidence: { inventorySha256: H("b"), inventory: { entries: [{ path: "package-lock.json", kind: "file", sha256: H("c") }] } } };
  const state = { version: "frontend-release-state-v1", kind, phase: "accepted", runtimeSha256: baseline.sha256, runtimeSequence: 718,
    frontendSha256: kind === "full" ? baseline.sha256 : H("d"), frontendSequence: kind === "full" ? 718 : 719, indexSha256: H("e"), distTreeHash: H("f"), acceptanceSha256: null };
  const receipt = kind === "full" ? { version: "frontend-full-baseline-acceptance-v1", runtimeSha256: state.runtimeSha256, runtimeSequence: 718,
    indexSha256: state.indexSha256, distTreeHash: state.distTreeHash, checkedAt: new Date().toISOString(), checks: { runtimeMarkers: true, health: true, sourceBaseline: true } }
    : { version: "frontend-readonly-acceptance-v1", transactionId: "a".repeat(24), runtimeSha256: state.runtimeSha256, runtimeSequence: 718,
      frontendSha256: state.frontendSha256, frontendSequence: 719, indexSha256: state.indexSha256, distTreeHash: state.distTreeHash,
      authorizationSha256: H("1"), checkedAt: new Date().toISOString(), checks: { index: true, assets: true, health: true, protected: true, services: true } };
  state.acceptanceSha256 = tools.hash(json(receipt));
  const binding = { version: "frontend-runtime-binding-v1", runtimeSha256: state.runtimeSha256, runtimeSequence: 718,
    inventorySha256: H("b"), runtime: { nodeSha256: H("2"), nodeVersion: "v22.22.1", dependencyLockSha256: H("c"), buildDependencySha256: H("3"), installedRuntimeSha256: H("4") },
    policies: { authorizationSha256: H("5"), runtimeBoundarySha256: H("6"), sandboxSha256: H("7") } };
  const observation = { version: tools.VERSION, observedAt: new Date().toISOString(), stable: true, recoveryPending: false,
    runtimeSha256: baseline.sha256, runtimeSequence: 718, marker: baseline.sha256, liveComplete: baseline.sha256, indexSha256: state.indexSha256,
    fullStatus: `status=complete\nok=1\nstartedAt=2026-09-09T06:13:31Z\nfinishedAt=2026-09-09T07:11:30Z\nexitCode=0\nbundleSha256=${baseline.sha256}\nreleaseKind=full\nreleaseSequence=718\n`, raw: {} };
  function set(name, bytes) { observation.raw[name] = { bytes: bytes.length, sha256: tools.hash(bytes), base64: bytes.toString("base64") }; }
  set("frontend-state.json", json(state)); set("frontend-runtime-binding.json", json(binding)); set("frontend-acceptance.json", json(receipt));
  return { baseline, state, binding, receipt, observation, set, validate: () => tools.validateObservation(observation, baseline) };
}
test("accepts original full/full baseline", () => assert.equal(fixture("full").validate().state.frontendSequence, 718));
test("accepts current UI newer than unchanged full runtime", () => assert.equal(fixture().validate().state.frontendSequence, 719));
test("preserves exact input bytes including whitespace", () => { const f = fixture(); const bytes = Buffer.from(JSON.stringify(f.binding, null, 2) + "\n"); f.set("frontend-runtime-binding.json", bytes); assert.ok(f.validate().bytes["frontend-runtime-binding.json"].equals(bytes)); });
for (const [name, mutate] of [
  ["pending state", f => { f.state.phase = "pending"; f.state.acceptanceSha256 = null; f.set("frontend-state.json", json(f.state)); }],
  ["wrong runtime", f => { f.observation.runtimeSha256 = H("9"); }],
  ["runtime marker mismatch", f => { f.observation.marker = H("9"); }],
  ["different index", f => { f.observation.indexSha256 = H("9"); }],
  ["stale observation", f => { f.observation.observedAt = new Date(Date.now() - 61000).toISOString(); }],
  ["future observation", f => { f.observation.observedAt = new Date(Date.now() + 61000).toISOString(); }],
  ["recovery pending", f => { f.observation.recoveryPending = true; }],
  ["unstable snapshot", f => { f.observation.stable = false; }],
  ["truncated base64", f => { f.observation.raw["frontend-state.json"].base64 += "!"; }],
  ["oversized raw artifact", f => { f.observation.raw["frontend-state.json"].bytes = 8193; }],
  ["receipt altered", f => { f.receipt.checks.health = false; f.set("frontend-acceptance.json", json(f.receipt)); }],
  ["rebound false receipt", f => { f.receipt.checks.health = false; const raw = json(f.receipt); f.state.acceptanceSha256 = tools.hash(raw); f.set("frontend-state.json",json(f.state)); f.set("frontend-acceptance.json",raw); }],
  ["binding duplicate escaped key", f => { f.set("frontend-runtime-binding.json", Buffer.from(JSON.stringify(f.binding).replace('"nodeVersion":', '"nodeVersion":"v22.22.1","nodeVersion":'))); }],
  ["lock mismatch", f => { f.binding.runtime.dependencyLockSha256 = H("9"); f.set("frontend-runtime-binding.json", json(f.binding)); }],
  ["duplicate status key", f => { f.observation.fullStatus += "status=complete\n"; }],
  ["unknown status key", f => { f.observation.fullStatus += "unknown9=x\n"; }],
  ["unfinished original release", f => { f.observation.fullStatus = f.observation.fullStatus.replace("status=complete","status=running"); }],
  ["malformed status time", f => { f.observation.fullStatus = f.observation.fullStatus.replace("T07:11:30Z", "T27:11:30Z"); }],
  ["wrong artifact set", f => { delete f.observation.raw["frontend-acceptance.json"]; }],
]) test("rejects " + name, () => { const f = fixture(); mutate(f); assert.throws(f.validate); });

function remoteFixture(mutate) {
  const f = fixture(), files = new Map(), app = "/opt/football-predict", root = "/var/lib/football-release", descriptors = new Map(); let serial = 1;
  const add = (file, bytes, mode) => files.set(file, { bytes: Buffer.from(bytes), mode, ino: serial++ });
  for (const [name, projection] of [["frontend-state.json", ".frontend-release-state.json"], ["frontend-runtime-binding.json", ".frontend-release-binding.json"]]) {
    const bytes = Buffer.from(f.observation.raw[name].base64,"base64"); add(root+"/"+name,bytes,0o600); add(app+"/"+projection,bytes,0o644);
  }
  add(app+"/.frontend-release-acceptance.json",json(f.receipt),0o644); add(app+"/.release-bundle-sha256",f.baseline.sha256+"\n",0o644);
  add(app+"/.release-live-complete",f.baseline.sha256+"\n",0o644); add(app+"/dist/index.html","index",0o644);
  add(root+"/status/"+f.baseline.sha256+".status",f.observation.fullStatus,0o640);
  const noent = () => { const e = new Error("missing"); e.code="ENOENT"; throw e; };
  const stat = file => { const row=files.get(file), dir=!row && [...files.keys()].some(p=>p.startsWith(file==="/"?"/":file+"/")); if(!row&&!dir&&file!==root+"/recovery")noent();
    return { dev:1n,ino:BigInt(row?.ino||100),mode:BigInt(row?.mode||0o755),uid:0n,gid:0n,nlink:1n,size:BigInt(row?.bytes.length||0),mtimeNs:1n,ctimeNs:1n,
      isFile:()=>!!row,isDirectory:()=>!row,isSymbolicLink:()=>false }; };
  const fake = { constants: fs.constants, lstatSync: stat, openSync(file){ const fd=serial++; descriptors.set(fd,file); return fd; },
    fstatSync(fd){return stat(descriptors.get(fd));}, readSync(fd,buffer,offset,length,position){ const file=descriptors.get(fd),bytes=files.get(file).bytes,count=Math.max(0,Math.min(length,bytes.length-position)); bytes.copy(buffer,offset,position,position+count); if(fake.afterRead)fake.afterRead(file); return count; },closeSync(fd){descriptors.delete(fd);} };
  mutate?.({files,fake,app,root,add});
  const result=vm.runInNewContext("("+tools.observeRemote.toString()+")("+JSON.stringify({sha256:f.baseline.sha256,sequence:718})+")",{Buffer,require(name){if(name==="node:fs")return fake; assert.ok(["node:crypto","node:path"].includes(name));return require(name);}});
  assert.equal(descriptors.size,0); return result;
}
test("remote read program accepts exact dual identity in VM",()=>{const r=remoteFixture();assert.equal(r.stable,true);assert.equal(r.raw["frontend-state.json"].bytes,Buffer.from(r.raw["frontend-state.json"].base64,"base64").length);});
test("remote program rejects projection mismatch",()=>assert.throws(()=>remoteFixture(({files,app})=>{files.get(app+"/.frontend-release-state.json").bytes=Buffer.from("{}");}),/projection-mismatch/));
test("remote program rejects wrong file permissions",()=>assert.throws(()=>remoteFixture(({files,root})=>{files.get(root+"/frontend-state.json").mode=0o644;}),/unsafe-file/));
test("remote program rejects recovery marker",()=>assert.throws(()=>remoteFixture(({add,root})=>add(root+"/recovery/current","x",0o600)),/recovery-pending/));
test("remote program detects read races",()=>assert.throws(()=>remoteFixture(({fake,files})=>{fake.afterRead=file=>files.get(file).ino++;}),/read-drift/));
test("Windows SSH environment retains ProgramData without credentials",()=>{const env=prepare.transportEnvironment("win32");assert.equal(env.ProgramData,"C:/ProgramData");assert.deepEqual(Object.keys(env).sort(),["PATH","ProgramData","SystemRoot","WINDIR"]);});
test("saving inputs preserves bytes and exclusively allocates a new directory",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"frontend-input-save-")), identity=fs.lstatSync(root).ino;
  try {const f=fixture(), p={baseline:f.baseline,bundle:path.join(root,"original.tgz"),snapshots:[],programSha256:H("1"),publicKeyId:H("2")};
    const a=prepare.saveInputs(p,f.observation,root),b=prepare.saveInputs(p,f.observation,root);assert.notEqual(a.reportPath,b.reportPath);
    for(const [name,row]of Object.entries(a.artifacts))assert.ok(fs.readFileSync(row.path).equals(Buffer.from(f.observation.raw[name].base64,"base64")));
    assert.equal(a.deploymentAuthorized,false);assert.equal(a.sequenceReservations,0);
    f.observation.stable=false;const count=fs.readdirSync(root).length;assert.throws(()=>prepare.saveInputs(p,f.observation,root));assert.equal(fs.readdirSync(root).length,count);
  } finally {assert.equal(fs.lstatSync(root).ino,identity);assert.equal(fs.realpathSync(root),root);fs.rmSync(root,{recursive:true});}
});
console.log(JSON.stringify({ok:checks.every(r=>r.ok),checks,scope:"portable validation and remote-reader VM; not Linux filesystem authority proof",productionWrites:0,networkRequests:0,realSequencesConsumed:0},null,2));
if(checks.some(r=>!r.ok))process.exitCode=1;
