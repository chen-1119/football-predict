"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const os = require("node:os"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const identity = require("../server/frontendReleaseIdentity.cjs");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const runtimeSha = "a".repeat(64), frontendSha = "b".repeat(64);
const frontend = { version: "frontend-release-state-v1", kind: "frontend-only", phase: "accepted", runtimeSha256: runtimeSha, runtimeSequence: 711,
  frontendSha256: frontendSha, frontendSequence: 712, indexSha256: "c".repeat(64), distTreeHash: "d".repeat(64), acceptanceSha256: "e".repeat(64),
  available: true, consistent: true };
const candidate = { releaseKind: "frontend-only", sha256: frontendSha, releaseSequence: 712, expectedFrontendIdentitySha256: "f".repeat(64) };
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

async function verifyFrontendReleaseConsumers() {
  const checks = [], check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
  await check("real health route attaches fresh identity outside business cache and disables HTTP caching without changing readiness", async () => {
    const source = read("server/index.cjs"), start = source.indexOf('  if (url.pathname === "/api/v1/health") {');
    const block = source.slice(start, source.indexOf("\n  }", start) + 4); assert.ok(start > 0);
    const cached = { ok: false, status: { serviceOk: true, recommendationReliable: false } }; let reads = 0;
    const run = () => vm.runInNewContext("(async()=>{" + block + "})()", {
      url: { pathname: "/api/v1/health" }, req: {}, res: {}, getPublicV1Health: async () => cached,
      readFrontendReleaseIdentity: () => ({ ...frontend, frontendSequence: 712 + reads++ }),
      sendJsonCached: (_req, _res, payload, options) => ({ payload, options }),
    });
    const first = await run(), second = await run();
    assert.equal(first.payload.frontendRelease.frontendSequence, 712); assert.equal(second.payload.frontendRelease.frontendSequence, 713);
    assert.equal(second.options.maxAgeSeconds, 0); assert.equal(second.payload.status, cached.status);
    assert.equal(Object.hasOwn(cached, "frontendRelease"), false);
  });
  const queueSource = read("scripts/queueServerRelease.cjs");
  const queueMatch = /observe: (\(startedAtMs\) => \{[\s\S]*?\n {6}\}),\n {4}\};/.exec(queueSource); assert.ok(queueMatch);
  const queue = (proof, selected = candidate) => {
    const observe = vm.runInNewContext("(" + queueMatch[1] + ")", {
      path: path.posix, FIXED: { app: "/fixture/app", status: "/fixture/status" }, options: { sha: selected.sha256 }, authenticatedRelease: selected, childExit: null,
      fs: { realpathSync: file => file }, assertDirectory: () => {}, assertRegular: () => ({ mode: 0o644 }),
      digest: () => selected.expectedFrontendIdentitySha256,
      regularBytes: file => Buffer.from(file.endsWith(".status") ? "bundleSha256=" + selected.sha256 + "\nstatus=complete\nok=1\nexitCode=0\nstartedAt=2026-09-08T00:00:00.000Z\n" : runtimeSha + "\n"),
      require: name => { assert.equal(name, "/fixture/app/server/frontendReleaseIdentity.cjs"); return { ...identity, readFrontendReleaseIdentity: () => proof }; },
    }); return observe(Date.parse("2026-09-08T00:00:00.000Z"));
  };
  await check("actual queue observer accepts UI receipt identity without requiring runtime markers equal frontend request", () => {
    assert.equal(queue(frontend).complete, true);
    for (const change of [{ phase: "pending" }, { consistent: false }, { frontendSequence: 713 }, { frontendSha256: runtimeSha }])
      assert.equal(queue({ ...frontend, ...change }).failed, true);
    assert.equal(queue(null, { releaseKind: "full", sha256: runtimeSha, releaseSequence: 711 }).complete, true);
  });
  const deploySource = read("scripts/deployReleaseBundle.cjs");
  const windowRouting = { cases: 0, assertions: 0 };
  await check("actual deploy pre-upload route authenticates before window, archive and clone while UI and dry-run bypass live gates", async () => {
    const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "football-ui-consumer-route-"));
    const original = fs.lstatSync(fixture), bundlePath = path.join(fixture, "candidate.tgz"), source = path.join(fixture, "source");
    const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    const signing = require("./releaseSigning.cjs"), archive = require("./releaseArchiveSourceInventory.cjs");
    const policy = require("./releaseBundlePolicy.cjs"), rotation = require("./releaseRecoveryHelperRotation.cjs");
    try {
      for (const [name, text] of [["src/App.tsx", "export default () => null;\n"],
        ["deploy/light-server/football-release-recovery.cjs", "fixture-only-helper"], [rotation.RELEASE_SHELL_ENTRY, "fixture-only-shell"]]) {
        const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
      }
      const tar = spawnSync("tar", ["-czf", bundlePath, "-C", source, "./src", "./deploy"], { encoding: "utf8", windowsHide: true });
      assert.equal(tar.status, 0, tar.stderr);
      const evidence = await archive.captureReleaseArchiveSourceEvidence(bundlePath), keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
      const publicKeyPath = path.join(fixture, "public.pem"); fs.writeFileSync(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
      fs.writeFileSync(bundlePath + ".sha256", evidence.archiveSha256 + "\n");
      const base = { manifestVersion: signing.RELEASE_MANIFEST_VERSION, site: "football-predict", channel: "production", releaseSequence: 712,
        createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), ok: true,
        signature: { algorithm: signing.RELEASE_SIGNATURE_ALGORITHM, keyId: signing.publicKeyId(keys.publicKey) },
        policyVersion: policy.RELEASE_BUNDLE_POLICY_VERSION, sha256: evidence.archiveSha256, bytes: evidence.archiveBytes,
        entries: evidence.archiveEntryCount, sensitiveEntries: [], releaseActions: [], releaseKind: "frontend-only", archiveSourceEvidence: evidence,
        frontendAuthorization: { version: "source-authorized-frontend-v1", baseline: { runtimeSha256: runtimeSha, runtimeSequence: 711,
          inventorySha256: "a".repeat(64), frontendStateSha256: "a".repeat(64), indexSha256: "a".repeat(64), distTreeHash: "a".repeat(64) },
          candidateInventorySha256: evidence.inventorySha256,
          runtime: { nodeSha256: "a".repeat(64), nodeVersion: "v22.22.1", dependencyLockSha256: "a".repeat(64),
            buildDependencySha256: "a".repeat(64), installedRuntimeSha256: "a".repeat(64) },
          policies: { authorizationSha256: "a".repeat(64), runtimeBoundarySha256: "a".repeat(64), sandboxSha256: "a".repeat(64) }, changedPaths: ["src/App.tsx"] } };
      const start = deploySource.indexOf("const shaPath = `${bundlePath}.sha256`;"), end = deploySource.indexOf("// End authenticated local routing;");
      assert.ok(start > 0 && end > start);
      const fileHelpers = deploySource.slice(deploySource.indexOf("const readShaFile ="), deploySource.indexOf("const remoteJoin ="));
      const commandStart = deploySource.indexOf("const runCommand ="), commandEnd = deploySource.indexOf("const latestBundlePath =");
      assert.ok(commandStart > 0 && commandEnd > commandStart);
      const commandHelper = deploySource.slice(commandStart, commandEnd);
      const route = async (mutate = () => {}, unsignedMutation = null, options = {}) => {
        const manifest = structuredClone(base); mutate(manifest);
        const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(bundlePath + ".manifest.json", bytes);
        fs.writeFileSync(bundlePath + ".manifest.sig", signing.signManifestBytes(bytes, keys.privateKey));
        if (unsignedMutation) { unsignedMutation(manifest); fs.writeFileSync(bundlePath + ".manifest.json", JSON.stringify(manifest)); }
        const calls = [], context = { fs, path, crypto, Buffer, process, bundlePath, rootDir: fixture, dryRun: options.dryRun === true,
          spawnSync: (command, args, spawnOptions) => {
            if (command === "tar") return spawnSync(command, args, spawnOptions);
            assert.equal(command, process.execPath); assert.equal(args[0], "scripts/verifyFastResultProductionClone.cjs");
            calls.push("clone"); return { status: 0 };
          },
          RELEASE_MANIFEST_VERSION: signing.RELEASE_MANIFEST_VERSION, RELEASE_SIGNATURE_ALGORITHM: signing.RELEASE_SIGNATURE_ALGORITHM,
          RELEASE_BUNDLE_POLICY_VERSION: policy.RELEASE_BUNDLE_POLICY_VERSION, findSensitiveReleaseEntries: policy.findSensitiveReleaseEntries,
          RELEASE_SHELL_ENTRY: rotation.RELEASE_SHELL_ENTRY, recoveryHelperEntry: "deploy/light-server/football-release-recovery.cjs",
          resolvePublicKeyPath: () => publicKeyPath,
          verifyManifestSignature: input => { calls.push("signature"); return signing.verifyManifestSignature(input); },
          fail: (message, detail) => { throw new Error(message + ":" + (detail?.reason || "")); },
          require: name => {
            if (name === "./releaseArchiveSourceInventory.cjs") return { verifyArchiveSourceEvidence: async (...args) => {
              calls.push("actual-inventory"); return archive.verifyArchiveSourceEvidence(...args);
            } };
            if (name === "./runReleaseWindowPreflight.cjs") return { runLiveReleaseWindowPreflight: () => {
              calls.push("window");
              if (options.windowThrows) throw new Error("fixture window observation failed");
              return { version: "release-window-preflight-v1", ok: options.windowOpen !== false,
                productionWrites: 0, readyToCutover: false, windowReserved: false };
            } };
            assert.equal(name, "./runReleaseArchivePreflight.cjs"); return { runLiveArchivePreflight: () => { calls.push("live-preflight"); return { report: { ok: true } }; } };
          },
        };
        try { await vm.runInNewContext("(async()=>{" + commandHelper + "\n" + fileHelpers + "\n" + deploySource.slice(start, end) + "})()", context); return { ok: true, calls }; }
        catch (error) { return { ok: false, calls, error: error.message }; }
      };
      const assertWindowRoute = (name, result, expectedOk, expectedCalls, errorPattern) => {
        assert.equal(result.ok, expectedOk, name + ": route acceptance");
        assert.deepEqual(result.calls, expectedCalls, name + ": exact ordered calls");
        windowRouting.assertions += 2;
        if (errorPattern) { assert.match(result.error, errorPattern, name + ": rejection reason"); windowRouting.assertions++; }
        windowRouting.cases++;
      };
      const asFull = m => { m.releaseKind = "full"; delete m.frontendAuthorization; };
      assertWindowRoute("UI verified inventory bypasses live gates", await route(), true, ["signature", "actual-inventory"]);
      for (const legacy of [false, true]) {
        const full = await route(m => { asFull(m); if (legacy) delete m.releaseKind; });
        assertWindowRoute(legacy ? "legacy full ordered gates" : "full ordered gates", full, true, ["signature", "window", "live-preflight", "clone"]);
      }
      assertWindowRoute("closed window stops before archive and clone", await route(asFull, null, { windowOpen: false }),
        false, ["signature", "window"], /release window unavailable before clone\/upload/);
      assertWindowRoute("throwing window stops before archive and clone", await route(asFull, null, { windowThrows: true }),
        false, ["signature", "window"], /fixture window observation failed/);
      for (const options of [{ windowOpen: false }, { windowThrows: true }])
        assertWindowRoute("UI never consults unavailable window", await route(() => {}, null, options), true, ["signature", "actual-inventory"]);
      assertWindowRoute("full dry-run performs no live probes or clone subprocess", await route(asFull, null, { dryRun: true, windowThrows: true }),
        true, ["signature"]);
      assertWindowRoute("UI dry-run still authenticates local inventory without live probes", await route(() => {}, null, { dryRun: true, windowThrows: true }),
        true, ["signature", "actual-inventory"]);
      for (const change of [m => { m.releaseKind = "unknown"; }, m => { delete m.archiveSourceEvidence; },
        m => { m.frontendAuthorization.changedPaths = ["src/services/prediction.ts"]; }, m => { m.releaseActions = ["db-migrate"]; }]) {
        const rejected = await route(change); assert.equal(rejected.ok, false); assert.deepEqual(rejected.calls, ["signature"]);
      }
      const unsigned = await route(() => {}, m => { m.frontendAuthorization.changedPaths = ["src/App.css"]; });
      assert.equal(unsigned.ok, false); assert.deepEqual(unsigned.calls, ["signature"]);
      const mismatch = await route(m => {
        const inventory = m.archiveSourceEvidence.inventory; inventory.entries.find(row => row.kind === "file").sha256 = "0".repeat(64);
        const body = { ...inventory }; delete body.treeHash; inventory.treeHash = hash(JSON.stringify(body));
        m.archiveSourceEvidence.inventorySha256 = inventory.treeHash; m.frontendAuthorization.candidateInventorySha256 = inventory.treeHash;
      });
      assert.equal(mismatch.ok, false); assert.deepEqual(mismatch.calls, ["signature", "actual-inventory"]);
      assert.match(mismatch.error, /actual-archive-source-evidence-mismatch/);
    } finally {
      const current = fs.lstatSync(fixture); assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino);
      assert.equal(current.isSymbolicLink(), false); assert.equal(fs.realpathSync(fixture), fixture); fs.rmSync(fixture, { recursive: true });
    }
  });
  const deployStart = deploySource.indexOf("if ((release.status !== 0 || frontendOnly) && !dryRun) {");
  const deployBlock = deploySource.slice(deployStart, deploySource.indexOf("\nif (releaseStep.ok === true)", deployStart)); assert.ok(deployStart > 0);
  const helpers = deploySource.slice(deploySource.indexOf("const parseKeyValue ="), deploySource.indexOf("const buildRemotePreflightCommand ="));
  const deploy = (proof, full = false, exitStatus = 0, options = {}) => {
    let businessChecks = 0, publicEnvironment = null; const releaseCandidate = full ? { releaseKind: "full", sha256: runtimeSha, releaseSequence: 711 } : candidate;
    const state = { bundleSha256: releaseCandidate.sha256, status: "complete", ok: "1", exitCode: "0", finishedAt: "2026-09-08T00:00:00.000Z", ...options.status };
    const status = Object.entries(state).map(([key, value]) => key + "=" + value).join("\n") + "\n";
    const transcript = "---status---\n" + status + "---marker---\n" + (options.marker ?? runtimeSha) + "\n---live-complete---\n" + (options.liveComplete ?? runtimeSha) +
      "\n---frontend-identity---\n" + JSON.stringify(proof) + "\n---log-tail---\n---units---\nactive\nactive\nactive\nactive\n";
    const context = { release: { status: exitStatus }, frontendOnly: !full, nativeFullRelease: full && options.native === true, releaseCandidate, actualSha256: releaseCandidate.sha256, dryRun: false,
      releaseStep: { ok: exitStatus === 0 }, steps: [], shellQuote: String, buildFrontendIdentityReaderSource: () => "reviewedInlineReader",
      frontendIdentityMatchesCandidate: identity.frontendIdentityMatchesCandidate, process: { execPath: "fixture-node", env: {} },
      remoteReleaseStatusPath: "/fixture/status", remoteReleaseLogPath: "/fixture/log", recoveryAttempts: 1, recoveryRetryDelayMs: 0,
      sshOptions: [], sshTarget: "fixture", publicBaseUrl: "https://fixture.invalid", parseJson,
      runCommand: (command, _args, runOptions) => {
        if (command === "ssh") return { status: options.sshStatus ?? 0, stdout: transcript };
        assert.equal(command, "fixture-node"); publicEnvironment = runOptions.env; businessChecks++; return { status: options.publicStatus ?? 0, stdout: options.publicBody ?? '{"ok":true}' };
      },
    };
    vm.runInNewContext(helpers + "\n" + deployBlock, context); return { ...context, businessChecks, publicEnvironment };
  };
  await check("actual deploy success and transport-recovery UI branches require receipt proof and never rerun business verification", () => {
    for (const exit of [0, 255]) { const result = deploy(frontend, false, exit); assert.equal(result.releaseStep.ok, true); assert.equal(result.businessChecks, 0); }
    assert.equal(deploy({ ...frontend, consistent: false }).releaseStep.ok, false);
    assert.equal(deploy({ ...frontend, frontendSha256: runtimeSha }).releaseStep.ok, false);
    const full = deploy(null, true, 255); assert.equal(full.releaseStep.ok, true); assert.equal(full.businessChecks, 1);
    assert.equal(full.publicEnvironment.REMOTE_REQUIRE_SQLITE, "1");
    assert.equal(full.publicEnvironment.REMOTE_REQUIRE_POSTGRES_ONLY, "0");
    const native = deploy(null, true, 255, { native: true });
    assert.equal(native.releaseStep.ok, true); assert.equal(native.businessChecks, 1);
    assert.equal(native.publicEnvironment.REMOTE_REQUIRE_SQLITE, "0");
    assert.equal(native.publicEnvironment.REMOTE_REQUIRE_POSTGRES_ONLY, "1");
    assert.equal(native.publicEnvironment.REMOTE_REQUIRED_READ_SOURCE, "postgres");
  });
  const fullRecoveryRouting = { cases: 0, assertions: 0 };
  await check("actual full recovery checks matching completion before public verification and preserves UI separation", () => {
    const test = (name, options, expectedCalls, expectedAccepted, skipReason) => {
      const result = deploy(options.ui ? options.proof || frontend : null, !options.ui, 255, options);
      assert.equal(result.businessChecks, expectedCalls, name + ": public verifier call count");
      assert.equal(result.releaseStep.ok, expectedAccepted, name + ": recovery acceptance");
      fullRecoveryRouting.assertions += 2;
      if (skipReason !== undefined) {
        assert.equal(result.steps[0].publicVerifySkipReason, skipReason, name + ": explicit skip reason");
        fullRecoveryRouting.assertions++;
      }
      fullRecoveryRouting.cases++;
    };
    const incomplete = "remote-status-not-complete-for-requested-bundle";
    test("failed request with old live markers", { status: { status: "failed", ok: "0", exitCode: "1" }, marker: frontendSha, liveComplete: frontendSha }, 0, false, incomplete);
    test("unknown status", { status: { status: "unknown" } }, 0, false, incomplete);
    test("missing completion instant", { status: { finishedAt: "" } }, 0, false, incomplete);
    test("status from another bundle", { status: { bundleSha256: frontendSha } }, 0, false, incomplete);
    test("status transport failure", { sshStatus: 255 }, 0, false, incomplete);
    test("old app marker", { marker: frontendSha }, 0, false, "bundle-marker-mismatch");
    test("old accepted marker", { liveComplete: frontendSha }, 0, false, "live-complete-marker-mismatch");
    test("matching complete full release after SSH interruption", {}, 1, true, null);
    test("matching complete release but failed public child", { publicStatus: 1 }, 1, false, null);
    test("matching complete release but unhealthy public body", { publicBody: '{"ok":false}' }, 1, false, null);
    test("matching complete release but malformed public output", { publicBody: "not-json" }, 1, false, null);
    test("UI exact receipt without business replay", { ui: true }, 0, true);
    test("UI stale receipt without business replay", { ui: true, proof: { ...frontend, consistent: false } }, 0, false);
  });
  const statusSource = read("scripts/checkReleaseStatus.cjs"), runStart = statusSource.indexOf("const run = async () => {");
  const statusBlock = statusSource.slice(runStart, statusSource.lastIndexOf("\nrun().catch(")); assert.ok(runStart > 0);
  async function status(proof, healthProof = proof, full = false) {
    let result;
    const selected = full ? { releaseKind: "full", actualSha256: runtimeSha, releaseSequence: 711 } : { releaseKind: "frontend-only", actualSha256: frontendSha, releaseSequence: 712 };
    const context = { checkBundle: () => ({ ok: true, ...selected }), checkSshBanner: async () => ({ connected: true }),
      checkSsh: () => ({ ok: true, aggregate: { frontendRelease: proof } }),
      checkRemoteReleaseMarker: () => ({ ok: true, committed: true, markerSha256: runtimeSha, liveCompleteSha256: runtimeSha }),
      checkRemotePreflight: () => ({ ok: true }), checkRemoteRecoveryHelper: () => ({ ok: true, acceptableForDeploy: true }),
      checkRemoteCandidateContinuity: () => ({ ok: true, releaseSequence: 711 }), frontendIdentityMatchesCandidate: identity.frontendIdentityMatchesCandidate,
      requestJson: async url => url === "/api/v1/health" ? { status: 200, body: { apiVersion: "v1", frontendRelease: healthProof,
        status: { serviceOk: true, recommendationReliable: false }, storage: { sqlite: { available: true } }, data: { currentRead: { source: "sqlite" } } } } :
        url.startsWith("/api/v1/matches/") || url.startsWith("/api/v1/odds/") ? { status: 401 } : { status: 404 },
      host: "fixture", user: "fixture", publicBaseUrl: new URL("https://fixture.invalid"), sshHostKeyPin: null, sshHostKeyPinError: null, strict: false,
      console: { log: text => { result = JSON.parse(text); } },
    };
    await vm.runInNewContext(statusBlock + "\nrun();", context); return result;
  }
  await check("actual check-status orchestration binds UI candidate runtime sequence and fresh public health while preserving full compatibility", async () => {
    const accepted = await status(frontend); assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.liveComplete, true);
    assert.equal(accepted.public.health.recommendationReliable, false);
    assert.equal((await status({ ...frontend, phase: "pending" })).ok, false);
    assert.equal((await status(frontend, { ...frontend, acceptanceSha256: "f".repeat(64) })).ok, false);
    assert.equal((await status(null, null, true)).ok, true);
  });
  await check("SSH status consumers embed reviewed local code and never fetch executable policy from APP", () => {
    for (const source of [deploySource, statusSource, read("scripts/releaseProgress.cjs")]) {
      assert.ok(source.includes("buildFrontendIdentityReaderSource"));
      assert.equal(/require\(["']\/opt\/football-predict\/server\/frontendReleaseIdentity/.test(source), false);
    }
    const code = identity.buildFrontendIdentityReaderSource();
    const compiled = vm.runInNewContext(code, { require: name => { assert.ok(name.startsWith("node:")); return require(name); }, Buffer, process });
    assert.equal(typeof compiled.readFrontendReleaseIdentity, "function");
  });
  return { ok: true, checks: checks.length, results: checks, actualConsumerBlocksExecuted: true, transportMocked: true,
    windowRouting, fullRecoveryRouting,
    productionWrites: 0, networkCalls: 0, modelsOrDatabaseVerificationRun: 0 };
}
if (require.main === module) verifyFrontendReleaseConsumers().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verifyFrontendReleaseConsumers };
