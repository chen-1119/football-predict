"use strict";
// Actual policy text and filesystem operations in the existing Linux VM
// adapter. RSA/archive/dependency/receipt validation are real; privileged
// paths, flock, service/HTTP observations and runtime capture are explicit
// adapters. This is not installed production policy or a release acceptance.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createControllerFixture } = require("./verifyFrontendReleaseController.cjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex"), json = v => Buffer.from(JSON.stringify(v) + "\n"), digest = v => sha(JSON.stringify(v));
const ROOT = "/var/lib/football-release", APP = "/opt/football-predict", INSTALL = "/usr/local/libexec/football-release-frontend";
const BINDING = ROOT + "/frontend-runtime-binding.json", PUBLIC = APP + "/.frontend-release-binding.json", STATE = ROOT + "/frontend-state.json", CURRENT = ROOT + "/recovery/current";
function policies(pins) { return { authorizationSha256: digest(pins), runtimeBoundarySha256: pins.find(p => p.name === "frontendRuntimeBoundary.cjs").sha256,
  sandboxSha256: digest(pins.filter(p => ["frontendBuildSandbox.cjs", "frontendBuildEvidence.cjs", "releasePrebuiltDist.cjs"].includes(p.name))) }; }
async function fixture(options = {}) {
  const f = await createControllerFixture(options);
  await f.apply();
  f.put(ROOT + "/highest-accepted-sequence", "14\n"); // Failed newer attempts can consume sequence; never rewind it.
  for (const [hash, seq, kind] of [[f.runtimeSHA, f.runtimeSequence, "full"], [f.candidateSHA, f.sequence, "frontend-only"]])
    f.put(ROOT + "/status/" + hash + ".status", `status=complete\nok=1\nstartedAt=2026-10-05T00:00:00Z\nfinishedAt=2026-10-05T00:01:00Z\nexitCode=0\nbundleSha256=${hash}\nreleaseKind=${kind}\nreleaseSequence=${seq}\n`, 0o640);
  const modulePins = f.controller.MODULES.map(name => ({ name, sha256: sha(f.get(INSTALL + "/" + name)) }));
  const oldPins = modulePins.filter(p => !["frontendPolicyRefresh.cjs", "frontendReleaseAttempt.cjs"].includes(p.name)).map(p => p.name === "frontendBuildSandbox.cjs" ? { ...p, sha256: sha("previous reviewed 768M policy") } : p);
  const oldBinding = { ...f.binding, policies: policies(oldPins) };
  f.put(BINDING, json(oldBinding)); f.put(PUBLIC, json(oldBinding), 0o644);
  const auditId = "a".repeat(24), files = [BINDING, PUBLIC, STATE, APP + "/.frontend-release-state.json", APP + "/.frontend-release-acceptance.json", ROOT + "/highest-accepted-sequence", APP + "/.release-bundle-sha256", APP + "/.release-live-complete"];
  const protectedFiles = files.map(name => ({ path: name, sha256: sha(f.get(name)) }));
  const audit = { version: "frontend-policy-bootstrap-v1", id: auditId, bootstrapSha256: sha("independently reviewed bootstrap fixture"),
    before: { modulePins: oldPins, policies: policies(oldPins), protectedFiles }, after: { modulePins, policies: policies(modulePins), protectedFiles } };
  const auditPath = ROOT + "/frontend-policy-bootstrap/" + auditId + "/complete.json";
  f.put(auditPath, json(audit)); f.put(ROOT + "/frontend-policy-bootstrap/current.json", json({ version: audit.version, id: auditId, recordSha256: sha(json(audit)) }));
  const preserved = files.filter(name => ![BINDING, PUBLIC].includes(name)).map(name => ({ name, bytes: f.get(name) }));
  preserved.push({ name: APP + "/runtime-sentinel", bytes: f.get(APP + "/runtime-sentinel") }, { name: ROOT + "/database-sentinel", bytes: f.get(ROOT + "/database-sentinel") });
  const expected = { expectedBindingSha256: sha(f.get(BINDING)), expectedStateSha256: sha(f.get(STATE)) };
  const distBefore = f.controller.load().dist.inspectPrebuiltDist(APP + "/dist");
  return Object.assign(f, { expected, oldBinding, auditPath, audit, preserved, distBefore,
    refresh: () => f.controller.main(["refresh-policies", expected.expectedBindingSha256, expected.expectedStateSha256]),
    preservedUnchanged() { for (const row of preserved) assert.ok(f.get(row.name).equals(row.bytes), row.name); assert.deepEqual(f.controller.load().dist.inspectPrebuiltDist(APP + "/dist"), distBefore); },
  });
}
async function verify() {
  if (process.platform !== "linux") throw new Error("linux-policy-refresh-fixtures-required");
  const checks = [], check = async (name, body) => { try { await body(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: e.stack }); } };
  const withFixture = async (opts, body) => { const f = await fixture(opts); try { await body(f); } finally { await f.dispose(); } };
  await check("normal refresh derives installed policy hashes and preserves accepted UI/runtime/receipt/dist/high-water bytes", () => withFixture({}, async f => {
    const before = f.counters(), result = await f.refresh(); assert.equal(result.ok, true); assert.equal(result.frontendSequence, 12); assert.equal(result.runtimeSequence, 11);
    assert.equal(result.releaseSequenceConsumed, false); assert.equal(result.acceptedStateRewritten, false); assert.equal(result.servicesRestarted, false);
    const binding = f.parsed(BINDING); assert.deepEqual(binding, { ...f.oldBinding, policies: JSON.parse(JSON.stringify(f.controller.load().policies)) });
    assert.ok(f.get(BINDING).equals(f.get(PUBLIC))); assert.equal(fs.existsSync(f.physical(CURRENT)), false); f.preservedUnchanged();
    const after = f.counters(); assert.equal(after.sandboxCalls, before.sandboxCalls); assert.equal(after.beginCalls, before.beginCalls); assert.equal(after.acceptedCalls, before.acceptedCalls);
    assert.ok(!f.events.some(v => /restart|stop|kill|npm|systemd-run/.test(v)));
  }));
  const reject = (name, mutate, pattern, opts = {}) => check(name, () => withFixture(opts, async f => {
    const before = f.get(BINDING), beforePublic = f.get(PUBLIC); await mutate(f); await assert.rejects(f.refresh(), pattern);
    // Mutation tests may deliberately edit a binding; the refresh must not
    // perform either policy rename in any rejection before a durable intent.
    assert.ok(!f.events.some(v => v === "rename:" + BINDING || v === "rename:" + PUBLIC));
    if (!name.includes("binding")) { assert.ok(f.get(BINDING).equals(before)); assert.ok(f.get(PUBLIC).equals(beforePublic)); }
  }));
  await check("API rejects paths, caller runtime/policies, booleans and extra fields before root authority", () => withFixture({}, async f => {
    for (const input of [{}, { ...f.expected, policies: f.oldBinding.policies }, { ...f.expected, runtime: f.oldBinding.runtime }, { ...f.expected, fixtureRoot: "/tmp/x" }, { ...f.expected, verified: true }, { ...f.expected, expectedBindingSha256: "bad" }])
      await assert.rejects(f.policyRefresh.refreshPolicies(input), /invalid-policy-refresh-input/);
  }));
  await reject("wrong expected current state hash", f => { f.expected.expectedStateSha256 = sha("wrong"); }, /expected-current/);
  await reject("wrong expected current binding hash", f => { f.expected.expectedBindingSha256 = sha("wrong"); }, /expected-current/);
  await reject("public binding differs from trusted root binding", f => f.put(PUBLIC, json({ ...f.oldBinding, inventorySha256: sha("changed") }), 0o644), /expected-current/);
  await reject("duplicate/canonical binding bytes are rejected", f => { f.put(BINDING, Buffer.from(f.get(BINDING).toString().trim() + "  \n")); f.expected.expectedBindingSha256 = sha(f.get(BINDING)); }, /binding-contract/);
  await reject("unheld inherited exclusive root lock is rejected", f => { f.options.lockFailure = true; }, /missing-lock/);
  await reject("nonroot fixed runtime is rejected", f => { f.vmProcess.getuid = () => 1001; }, /fixed-clean-root/);
  await reject("NODE_OPTIONS loader injection is rejected", f => { f.vmProcess.env.NODE_OPTIONS = "--require=/tmp/evil"; }, /fixed-clean-root/);
  await reject("pending accepted state is not a policy baseline", f => { const v = { ...f.parsed(STATE), phase: "pending", acceptanceSha256: null }; f.put(STATE, json(v)); f.put(APP + "/.frontend-release-state.json", json(v), 0o644); f.expected.expectedStateSha256 = sha(f.get(STATE)); }, /accepted-state/);
  await reject("public accepted state drift is rejected", f => f.put(APP + "/.frontend-release-state.json", json({ ...f.parsed(STATE), indexSha256: sha("wrong") }), 0o644), /accepted-state/);
  await reject("accepted receipt hash drift is rejected", f => f.put(APP + "/.frontend-release-acceptance.json", "{}\n", 0o644), /receipt-unbound/);
  await reject("runtime marker drift is rejected", f => f.put(APP + "/.release-live-complete", sha("wrong") + "\n", 0o644), /runtime-marker/);
  await reject("consumed sequence below accepted frontend is rejected", f => f.put(ROOT + "/highest-accepted-sequence", "11\n"), /high-water/);
  await reject("actual dist bytes mismatch is rejected", f => f.put(APP + "/dist/index.html", "changed", 0o644), /dist-mismatch/);
  await reject("runtime completed status is required", f => f.put(ROOT + "/status/" + f.runtimeSHA + ".status", `status=failed\nok=0\nexitCode=1\nbundleSha256=${f.runtimeSHA}\n`, 0o640), /release-not-accepted/);
  await reject("active sandbox unit blocks policy mutation", f => { f.options.activeBuild = true; }, /active-release-or-build/);
  await reject("unit observation failure cannot imply idle", f => { f.options.unitObservationFailure = true; }, /fixed-command-failed/);
  await reject("populated cgroup blocks even an apparently absent unit", f => f.put("/sys/fs/cgroup/system.slice/football-frontend-build-left.service/cgroup.events", "populated 1\nfrozen 0\n", 0o444), /live-or-unobservable-cgroup/);
  await reject("unobservable cgroup blocks even absent unit", f => f.put("/sys/fs/cgroup/system.slice/football-frontend-build-left.service/cgroup.events", "unknown\n", 0o444), /live-or-unobservable-cgroup/);
  await reject("retained signature drift is rejected before binding writes", f => f.put(ROOT + "/source-baselines/" + f.runtimeSHA + "/manifest.sig", "wrong signature"), /assert|false|signature/);
  await reject("offline material raw complete binding drift is rejected", f => f.put(f.dependencyRoot + "/complete.json", "{}\n"), /dependency-store-binding/);
  await reject("actual installed runtime drift is rejected", f => { f.options.runtimeDriftAt = f.counters().installedCalls + 1; }, /runtime-or-material/);
  await reject("bootstrap audit fake after pins is rejected", f => { const v = f.audit; v.after.modulePins[0].sha256 = sha("wrong"); f.put(f.auditPath, json(v)); f.put(ROOT + "/frontend-policy-bootstrap/current.json", json({ version: v.version, id: v.id, recordSha256: sha(json(v)) })); }, /derived-pin|installed-pin/);
  await reject("bootstrap audit before protection must match after", f => { const v = f.audit; v.after.protectedFiles = v.after.protectedFiles.slice(1); f.put(f.auditPath, json(v)); f.put(ROOT + "/frontend-policy-bootstrap/current.json", json({ version: v.version, id: v.id, recordSha256: sha(json(v)) })); }, /preservation-mismatch/);
  await reject("another recovery journal blocks new maintenance", f => f.put(CURRENT + "/unknown.json", "{}\n"), /recovery-pending/);
  await reject("dangling recovery symlink blocks new maintenance", f => fs.symlinkSync("missing", f.physical(CURRENT)), /recovery-pending/);
  for (const phase of [CURRENT, BINDING, PUBLIC]) await check("durable journal recovery resumes the known pair after interruption at " + path.basename(phase), () => withFixture({}, async f => {
    f.options.afterRename = (_from, to) => { if (to === phase) { f.options.afterRename = null; throw new Error("fixture-interrupted-after-rename"); } };
    await assert.rejects(f.refresh(), /interrupted-after-rename/);
    assert.equal(fs.existsSync(f.physical(CURRENT)), true); const record = f.parsed(CURRENT + "/frontend-policy-refresh.json");
    assert.equal(record.proof.state.frontendSequence, 12); f.preservedUnchanged();
    const result = await f.controller.main(["recover"]); assert.equal(result.ok, true); assert.ok(f.get(BINDING).equals(f.get(PUBLIC))); f.preservedUnchanged();
    assert.equal(fs.existsSync(f.physical(CURRENT)), false);
  }));
  const interrupted = async (f, target = CURRENT) => { f.options.afterRename = (_from, to) => { if (to === target) { f.options.afterRename = null; throw new Error("fixture-stop"); } }; await assert.rejects(f.refresh(), /fixture-stop/); };
  for (const [name, mutate, pattern] of [
    ["foreign accepted state", f => f.put(STATE, json({ ...f.parsed(STATE), acceptanceSha256: sha("wrong") })), /accepted-state|receipt/],
    ["third binding value", f => f.put(BINDING, json({ ...f.oldBinding, inventorySha256: sha("foreign") })), /pair-cas/],
    ["identical old binding with unknown inode", f => { const name = f.physical(BINDING); const bytes = fs.readFileSync(name); fs.unlinkSync(name); fs.writeFileSync(name, bytes, { mode: 0o600 }); }, /pair-cas/],
    ["unknown extra journal member", f => f.put(CURRENT + "/frontend-transaction.json", "{}\n"), /journal-membership/],
    ["journal raw checksum drift", f => f.put(CURRENT + "/complete.json", "{}\n"), /journal-contract/],
    ["changed installed module policy", f => f.put(INSTALL + "/frontendBuildSandbox.cjs", "changed policy"), /target-policy-changed/],
    ["offline dependency record changes", f => f.put(f.dependencyRoot + "/complete.json", "{}\n"), /dependency-store-binding/],
    ["new staged temp substituted", f => { const r = f.parsed(CURRENT + "/frontend-policy-refresh.json"); f.put(PUBLIC + ".policy-" + r.id, json(r.newBinding), 0o644); }, /staged-file-drift/],
  ]) await check("recovery refuses " + name + " and retains intent", () => withFixture({}, async f => {
    await interrupted(f); await mutate(f); const beforeRoot = f.get(BINDING), beforePublic = f.get(PUBLIC);
    await assert.rejects(f.controller.main(["recover"]), pattern); assert.ok(f.get(BINDING).equals(beforeRoot)); assert.ok(f.get(PUBLIC).equals(beforePublic)); assert.equal(fs.existsSync(f.physical(CURRENT)), true);
  }));
  return { version: "frontend-policy-refresh-verification-v1", ok: checks.every(c => c.ok), checks, sourceSha256: sha(fs.readFileSync(require.resolve("./frontendPolicyRefresh.cjs"))),
    productionWrites: 0, deployments: 0, nativeBuildExecutions: 0, boundary: "Linux VM filesystem CAS/recovery plus real RSA/archive/dependency/receipt checks. Privileged paths/flock/runtime/HTTP/services are explicit adapters; this is not production maintenance or actual installed capture proof." };
}
module.exports = { verify };
if (require.main === module) verify().then(r => { console.log(JSON.stringify(r)); if (!r.ok) process.exitCode = 1; }).catch(e => { console.error(e.stack); process.exitCode = 1; });
