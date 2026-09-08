const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { collectFilesNewerThan: scan } = require("./releaseWorkspaceFreshness.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "checkReleaseStatus.cjs"), "utf8");
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check("status evidence uses one authenticated SSH command instead of one connection per field", () => {
  assert.equal((source.match(/spawnSync\("ssh"/g) || []).length, 1);
  assert.ok(source.includes("release-status-ssh-aggregate-v3"));
  assert.ok(source.includes("---marker---"));
  assert.ok(source.includes("---live-complete---"));
  assert.ok(source.includes("---candidate-continuity---"));
  assert.ok(source.includes("---recovery-helper---"));
  assert.ok(source.includes("---preflight---"));
});

check("the aggregate SSH command keeps fixed host-key options and bounded retries", () => {
  assert.ok(source.includes("buildPinnedSshBaseOptions"));
  assert.ok(source.includes("RELEASE_STATUS_SSH_ATTEMPTS || 4"));
  assert.ok(source.includes("if (result.status === 0) break;"));
  assert.ok(source.includes("sleepSync(sshRetryDelayMs)"));
});

check("public probes retry transport failures without excusing HTTP business failures", () => {
  assert.ok(source.includes("RELEASE_STATUS_HTTP_ATTEMPTS || 4"));
  assert.ok(source.includes("if (result.status !== 0) break;"));
  assert.ok(source.includes("await sleep(httpRetryDelayMs)"));
});

check("remote release identity is reported independently from workspace freshness", () => {
  const identityStart = source.indexOf("matchesLocalCandidate: Boolean(");
  const identityEnd = source.indexOf(")", identityStart);
  const identity = source.slice(identityStart, identityEnd);
  assert.ok(identityStart >= 0);
  assert.ok(identity.includes("bundle.actualSha256"));
  assert.equal(identity.includes("bundle.ok"), false);
});

check("preflight and unapproved recovery-helper mismatches remain blockers", () => {
  assert.ok(source.includes('blockers.push("remote release preflight failed")'));
  assert.ok(source.includes('blockers.push("remote cold-recovery helper does not match the candidate bundle and no signed rotation contract is available")'));
  assert.ok(source.includes("const matchesCandidate = actualSha256 === expectedSha256"));
  assert.ok(source.includes("rotationRequired = !matchesCandidate && rotationContract?.ok === true"));
  assert.ok(source.includes("remoteRecoveryHelper.acceptableForDeploy === true"));
});

check("candidate continuity proof is parsed from the same SSH aggregate and gates live completion", () => {
  assert.ok(source.includes("checkRemoteCandidateContinuity"));
  assert.ok(source.includes("candidate-release-continuity-verification-v1"));
  assert.ok(source.includes("remoteCandidateContinuity.ok"));
  assert.ok(source.includes("remoteRelease.committed"));
  assert.ok(source.includes("releaseIdentityValid"));
  assert.ok(source.includes("releaseBundleSha256 === remoteRelease?.markerSha256"));
  assert.ok(source.includes("releaseBundleSha256 === remoteRelease?.liveCompleteSha256"));
  assert.ok(source.includes('blockers.push("remote candidate release continuity proof is missing or invalid")'));
  assert.ok(source.includes("report.before.activeLedgerId === report?.after?.activeLedgerId"));
  assert.ok(source.includes("report.before.candidateRevisionId === report?.after?.candidateRevisionId"));
});

check("strict status success is derived from the complete blocker set", () => {
  assert.ok(source.includes("ok: blockers.length === 0"));
  assert.ok(source.includes('blockers.push("remote release completion marker is missing or does not match the bundle marker")'));
  assert.ok(source.includes("remotePreflight.ok"));
  assert.ok(source.includes("remoteRecoveryHelper.ok"));
});

assert.ok(source.includes('require("./releaseWorkspaceFreshness.cjs")'));
// Exercise the shared real scanner without running its SSH/HTTP entrypoint.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-status-freshness-"));
const cutoff = Date.parse("2020-01-01T00:00:00Z");
const write = (relative) => {
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "isolated-test\n");
  fs.utimesSync(target, new Date(cutoff + 2000), new Date(cutoff + 2000));
};
const paths = () => Array.from(scan(fixture, cutoff), row => row.path).sort();
try {
  check("root-only QA outputs excluded by packaging do not invalidate signed workspace freshness", () => {
    const packaging = fs.readFileSync(path.join(__dirname, "createReleaseBundle.cjs"), "utf8");
    assert.ok(packaging.includes('normalized.startsWith("outputs/")'));
    write("outputs/acceptance.json");
    write("outputs/screenshots/mobile.png");
    assert.deepEqual(paths(), []);
  });
  check("nested source directories named outputs still invalidate freshness", () => {
    write("src/outputs/decision.ts");
    write("server/outputs/contract.cjs");
    assert.deepEqual(paths(), ["server/outputs/contract.cjs", "src/outputs/decision.ts"]);
  });
  check("nearby names and ordinary production source remain freshness blockers", () => {
    write("outputs-next/release.cjs");
    write("src/decision.ts");
    write("scripts/verifyPolicy.cjs");
    assert.deepEqual(paths(), ["outputs-next/release.cjs", "scripts/verifyPolicy.cjs", "server/outputs/contract.cjs", "src/decision.ts", "src/outputs/decision.ts"]);
  });
  check("unchanged source and generated JSON retain existing freshness semantics", () => {
    write("src/old.ts");
    fs.utimesSync(path.join(fixture, "src/old.ts"), new Date(cutoff), new Date(cutoff));
    write("public/data/sync-meta.json");
    assert.equal(paths().includes("src/old.ts"), false);
    assert.equal(paths().includes("public/data/sync-meta.json"), false);
    assert.equal(paths().includes("src/decision.ts"), true);
  });
} finally {
  const resolved = fs.realpathSync(fixture);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^football-release-status-freshness-[A-Za-z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks
}, null, 2));
