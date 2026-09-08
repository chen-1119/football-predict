"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const receipts = require("./staticVerificationReceipts.cjs"), a = require("./rootStaticVerificationAttestations.cjs");
const producer = require("./createRootStaticVerificationAttestations.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
async function verify() {
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const inputs = receipts.collectInputs(root, ["scripts/verifyBetSlipRecommendationGate.cjs"]);
  assert.ok(inputs);
  const identity = { version: a.VERSION, releaseSha: "a".repeat(64), inputs, runtime: { node: "fixture" }, attestorPolicySha256: "b".repeat(64) };
  const body = { ok: true, checks: [{ name: "synthetic attestation contract only", ok: true }] };
  const result = { status: 0, body, stdout: JSON.stringify(body), stderr: "", timedOut: false };
  const now = 1788850000000;
  const sealed = a.sealAttestation({ identity, result, privateKey, checkedAt: now, elapsedMs: 6000 });
  const open = (value = sealed, options = {}) => a.openAttestation(value, { identity, publicKey: pem, now: now + 100, ...options });
  check("public key alone verifies the original root-signed complete result", () => {
    const received = open(); assert.deepEqual(received.body, body);
    assert.equal(received.verificationReceipt.trust, a.VERSION); assert.equal(received.verificationReceipt.verifiedAt, now);
    assert.equal(received.verificationReceipt.originalElapsedMs, 6000);
  });
  check("public key does not grant signing authority", () => assert.throws(() => a.sealAttestation({ identity, result, privateKey: pem, checkedAt: now, elapsedMs: 1 })));
  check("another root test key cannot authenticate the stored result", () => {
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    assert.equal(open(sealed, { publicKey: other }), null);
  });
  for (const field of ["releaseSha", "runtime", "inputs", "attestorPolicySha256", "issuerPolicySha256"]) check(`changed ${field} invalidates the attestation`, () => {
    const changed = clone(identity); changed[field] = "different"; assert.equal(open(sealed, { identity: changed }), null);
  });
  for (const [name, change] of [
    ["signature bytes", r => { r.signature = "A".repeat(86) + "=="; }],
    ["output body", r => { r.payload.result.body.checks[0].name = "tampered"; }],
    ["output bytes", r => { r.payload.result.stdout += " "; }],
    ["original time", r => { r.payload.checkedAt--; }],
    ["duration", r => { r.payload.elapsedMs++; }],
    ["record format", r => { r.payload.version = "unknown"; }],
  ]) check(`${name} tampering cannot become reusable success`, () => { const changed = clone(sealed); change(changed); assert.equal(open(changed), null); });
  check("future verification rejected", () => assert.equal(open(sealed, { now: now - 1 }), null));
  check("expired verification rejected", () => assert.equal(open(sealed, { now: now + receipts.MAX_AGE_MS + 1 }), null));
  check("exact age boundary keeps original verification time", () => assert.ok(open(sealed, { now: now + receipts.MAX_AGE_MS })));
  for (const [name, patch] of [["failed", { status: 1 }], ["timed out", { timedOut: true }],
    ["partial", { stdout: "{" }], ["empty checks", { body: { ok: true, checks: [] }, stdout: '{"ok":true,"checks":[]}' }]])
    check(`${name} execution cannot be signed`, () => assert.throws(() => a.sealAttestation({ identity, result: { ...result, ...patch }, privateKey, checkedAt: now, elapsedMs: 1 })));
  for (const options of ["--require injected.cjs", "--max-old-space-size=1536 --require=x", "--max-old-space-size=1536;id", "--inspect"])
    check(`unsafe inherited Node options reject reuse: ${options}`, () => assert.equal(a.parentRuntimeAllowed({ NODE_OPTIONS: options }), false));
  check("only absent or resource-only inherited Node options accepted", () => {
    assert.equal(a.parentRuntimeAllowed({}), true); assert.equal(a.parentRuntimeAllowed({ NODE_OPTIONS: "--max-old-space-size=1536" }), true);
    assert.equal(a.parentRuntimeAllowed({ NODE_PATH: "/untrusted" }), false);
  });
  const unitName = `football-static-check-${"a".repeat(24)}.service`;
  check("cgroup v1 or hybrid paths never satisfy unified completion", () => {
    const fs = require("node:fs"), original = fs.statfsSync;
    try { fs.statfsSync = () => ({ type: 0x01021994 }); assert.equal(producer.cgroupV2Available(), false); }
    finally { fs.statfsSync = original; }
  });
  const unit = producer.unitArguments({ rootDir: "/opt/football-predict.next", command: "scripts/verifySelectedJsonObjectFile.cjs", unit: unitName });
  check("source-only producer has no provider network or production directory access", () => {
    for (const property of ["PrivateNetwork=yes", "RestrictAddressFamilies=AF_UNIX", "ProtectSystem=strict", "NoNewPrivileges=yes", "PrivateTmp=yes", "KillMode=control-group", "RuntimeMaxSec=120s"])
      assert.ok(unit.includes(`--property=${property}`));
    assert.ok(unit.includes("--property=DynamicUser=yes")); assert.ok(unit.includes("--property=User=fbst" + "a".repeat(24)));
    assert.ok(!unit.some(arg => arg.startsWith("--uid="))); assert.ok(unit.includes("-i"));
    assert.ok(unit.includes("--property=InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release"));
  });
  check("producer arguments cannot select arbitrary commands or privileged users", () => {
    for (const patch of [{ command: "scripts/verifyApiContracts.cjs" }, { user: "root" }, { unit: "football-predict.service" }, { rootDir: "/opt/unsafe path" }])
      assert.throws(() => producer.unitArguments({ rootDir: "/opt/football-predict.next", command: "scripts/verifySelectedJsonObjectFile.cjs", unit: unitName, ...patch }));
  });
  const inactive = { observed: true, ActiveState: "inactive", LoadState: "not-found", MainPID: "0", ControlPID: "0", ControlGroup: "" };
  check("authoritatively collected unit is quiescent", () => assert.equal(producer.unitQuiescent(inactive, () => { throw new Error("not needed"); }), true));
  for (const patch of [{ observed: false }, { MainPID: "12" }, { ControlPID: "13" }, { ActiveState: "active" }, { LoadState: "error" }])
    check(`unknown or still-live unit cannot attest: ${JSON.stringify(patch)}`, () => assert.equal(producer.unitQuiescent({ ...inactive, ...patch }, () => true), false));
  const failed = { ...inactive, LoadState: "loaded", ActiveState: "failed", ControlGroup: "/system.slice/" + unitName };
  check("failed unit with surviving cgroup tasks is not complete", () => assert.equal(producer.unitQuiescent(failed, () => false), false));
  check("failed-unit cgroup observation errors are not successful cleanup", () => assert.equal(producer.unitQuiescent(failed, () => { throw new Error("read denied"); }), false));
  let calls = 0;
  const fresh = await receipts.runWithStaticReceipt({ rootDir: root, args: ["scripts/verifyBetSlipRecommendationGate.cjs"],
    env: { VERIFY_STATIC_ATTESTATION_DIR: "/untrusted", VERIFY_STATIC_RELEASE_SHA: "a".repeat(64), VERIFY_STATIC_RECEIPT_DIR: "/untrusted-service-cache" },
    execute: async () => { calls++; return { status: 37 }; } });
  check("missing root proof executes original exactly once, with no private-cache downgrade", () => { assert.equal(calls, 1); assert.equal(fresh.status, 37); });
  check("non-root producer refuses before running any check or creating a store", () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0)
      assert.throws(() => producer.create({ rootDir: root, releaseSha: "a".repeat(64) }), /clean-root-runtime-required/);
  });
  return { ok: true, verifier: a.VERSION, checks, productionWrites: 0, providerRequests: 0,
    scope: "signature, scope, output and process-argument contracts; actual Linux cross-UID filesystem/systemd proof required separately" };
}
module.exports = { verify };
if (require.main === module) verify().then(report => console.log(JSON.stringify(report, null, 2)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
