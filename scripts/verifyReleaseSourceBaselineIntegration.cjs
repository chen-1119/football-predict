"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const shellPath = value => process.platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d) => "/" + d.toLowerCase()) : value;
const SOURCE_BASELINE_HELPER_MODULES = Object.freeze(["releaseSourceBaseline.cjs", "releaseSigning.cjs", "releaseArchiveSourceInventory.cjs",
  "releaseChangeClassification.cjs", "releasePrebuiltDist.cjs", "frontendReleaseAuthorization.cjs"]);
function verify() {
  const wrapper = fs.readFileSync(path.join(root, "deploy/light-server/football-release"), "utf8").replaceAll("\r\n", "\n");
  const bootstrap = fs.readFileSync(path.join(root, "deploy/light-server/bootstrap-release-entrypoints.sh"), "utf8").replaceAll("\r\n", "\n");
  const start = wrapper.indexOf("\npreserve_signed_source_baseline() {\n"), end = wrapper.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start); const actualFunction = wrapper.slice(start + 1, end + 3);
  const callStart = wrapper.indexOf("\nif ! preserve_signed_source_baseline; then\n"), callEnd = wrapper.indexOf("\nfi\n", callStart);
  assert.ok(callStart > 0 && callEnd > callStart); const actualCall = wrapper.slice(callStart + 1, callEnd + 4);
  const modules = SOURCE_BASELINE_HELPER_MODULES;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-baseline-shell-")), checks = []; let count = 0;
  const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const gitPaths = process.platform === "win32" ? (spawnSync("where.exe", ["git.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true }).stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
  const bash = process.env.VERIFY_BASH_EXECUTABLE || (process.platform !== "win32" ? "/bin/bash" : gitPaths.map(file => path.resolve(path.dirname(file), "../bin/bash.exe")).find(file => fs.existsSync(file)));
  assert.ok(bash && fs.existsSync(bash), "real Bash required, no skipped integration fixture");
  function run(mode, guardedExit = 0) {
    const fixture = path.join(temp, String(++count)), helper = path.join(fixture, "helper"); fs.mkdirSync(helper, { recursive: true });
    for (const name of modules) fs.writeFileSync(path.join(helper, name), "// controlled helper policy fixture\n");
    if (mode === "missing") fs.unlinkSync(path.join(helper, modules[2]));
    const fakeNode = path.join(fixture, "node"), fixturePath = shellPath(fixture);
    fs.writeFileSync(fakeNode, `#!/bin/bash\nset -euo pipefail\n[[ -z "\${INHERITED_SECRET_CANARY:-}" && -z "\${NODE_OPTIONS:-}" && -z "\${NODE_PATH:-}" ]] || exit 91\n[[ "$#" == 5 && "$2" == preserve && "$3" == ${quote("a".repeat(64))} && "$4" == 712 && "$5" == ${quote(fixturePath + "/work")} ]] || exit 92\nprintf 'called\\n' >> ${quote(fixturePath + "/calls")}\nexit ${mode === "helper-failed" ? 23 : mode === "deadline" ? 124 : 0}\n`, { mode: 0o755 });
    fs.chmodSync(fakeNode, 0o755);
    // Exact production function/call; ownership observations and the helper are
    // doubled, never bootstrap or modify any real host trust path.
    const script = `set -euo pipefail\nfixture=${quote(fixturePath)}\nmode=${quote(mode)}\nSOURCE_BASELINE_HELPER_DIR=${quote(shellPath(helper))}\nNODE_BIN=${quote(shellPath(fakeNode))}\nBUNDLE_SHA=${quote("a".repeat(64))}\nMANIFEST_SEQUENCE=712\nwork_dir="$fixture/work"\nexport INHERITED_SECRET_CANARY=fixture-canary\nexport NODE_OPTIONS=fixture-only-no-real-node\nexport NODE_PATH=/fixture/injected\nstat() {\n if [[ "$mode" == bad-owner && "$*" == *releaseSigning.cjs ]]; then printf '1000:0:644:1\\n'; return; fi\n if [[ "$mode" == bad-module-mode && "$*" == *releaseSigning.cjs ]]; then printf '0:0:666:1\\n'; return; fi\n if [[ "$*" == *%u:%g:%a:%h* ]]; then printf '0:0:644:1\\n';\n elif [[ "$mode" == bad-ancestor && "\${@: -1}" == /usr/local ]]; then printf '0:0:777\\n';\n else printf '0:0:755\\n'; fi\n}\nrealpath() { if [[ "$mode" == alias-path && "\${@: -1}" == "$SOURCE_BASELINE_HELPER_DIR" ]]; then printf '/fixture/another-policy\\n'; else printf '%s\\n' "\${@: -1}"; fi; }\n${actualFunction}\n${actualCall}\nprintf 'guarded-started\\n' > "$fixture/guarded"\nexit ${guardedExit}\n`;
    const directoryProbe = 'function [ { if [[ "$1" == -d && ( "$2" == / || "$2" == /usr || "$2" == /usr/local || "$2" == /usr/local/libexec ) ]]; then return 0; fi; builtin [ "$@"; }\n';
    const file = path.join(fixture, "fixture.sh"); fs.writeFileSync(file, directoryProbe + script);
    const child = spawnSync(bash, [shellPath(file)], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, guardedExit, child.stderr);
    assert.ok(fs.existsSync(path.join(fixture, "guarded")));
    return { ...child, calls: fs.existsSync(path.join(fixture, "calls")) ? fs.readFileSync(path.join(fixture, "calls"), "utf8").trim().split("\n").length : 0 };
  }
  try {
    check("retention follows sequence consumption and precedes guarded execution and cleanup", () => {
      assert.ok(callStart > wrapper.indexOf('\nconsume_release_sequence_before_execution "$MANIFEST_SEQUENCE"'));
      assert.ok(callEnd < wrapper.indexOf('\n  bash "$RELEASE_SCRIPT_PATH" "$TRUSTED_SOURCE_DIR"'));
      assert.ok(callEnd < wrapper.lastIndexOf('rm -rf -- "$work_dir"'));
    });
    check("bootstrap pins the fixed reviewed helper closure under the existing release lock", () => {
      assert.match(bootstrap, /SOURCE_BASELINE_INSTALL_DIR="\/usr\/local\/libexec\/football-release-source-baseline"/);
      for (const name of modules) assert.ok(bootstrap.includes(name) && actualFunction.includes(name));
      assert.ok(bootstrap.indexOf('flock 9') < bootstrap.indexOf('install -d -o root -g root -m 0700 "$SOURCE_BASELINE_INSTALL_DIR"'));
      assert.ok(bootstrap.indexOf('installed source baseline policy differs') < bootstrap.indexOf('"${SCRIPT_DIR}/football-release" /usr/local/sbin/football-release'));
      assert.ok(!actualFunction.includes("TRUSTED_SOURCE_DIR") && !actualFunction.includes("APP_DIR"));
    });
    check("retention has a fixed bounded deadline and a clean environment", () => {
      assert.match(actualFunction, /timeout --kill-after=5s 45s env -i PATH="\$PATH" LANG=C.UTF-8/);
      const result = run("ok"); assert.equal(result.calls, 1, result.stderr); assert.equal(result.stderr.includes("baseline unavailable"), false);
    });
    check("optional retention cannot make timeout a fatal full-release dependency", () => {
      const runtimeStart = wrapper.indexOf("\ncheck_release_runtime() {"), runtimeEnd = wrapper.indexOf("\n}\n", runtimeStart);
      assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
      assert.doesNotMatch(wrapper.slice(runtimeStart, runtimeEnd), /\btimeout\b/);
      assert.match(actualFunction, /command -v timeout >\/dev\/null 2>&1 \|\| return 1/);
    });
    for (const mode of ["missing", "bad-owner", "bad-module-mode", "bad-ancestor", "alias-path"]) {
      check("unsafe helper is not executed and full release remains available: " + mode, () => {
        const result = run(mode); assert.equal(result.calls, 0); assert.match(result.stderr, /UI overlay remains ineligible/);
      });
    }
    for (const mode of ["helper-failed", "deadline"]) {
      check("retention failure cannot change the guarded release exit code: " + mode, () => {
        const result = run(mode, 17); assert.equal(result.calls, 1); assert.match(result.stderr, /UI overlay remains ineligible/);
      });
    }
    return { ok: true, verifier: "release-source-baseline-shell-v1", checks, actualBashFixtures: count,
      productionWrites: 0, providerRequests: 0, bootstrapExecuted: false, deadlineFixture: "helper exit 124; actual timeout argv asserted, not a 45-second timer proof" };
  } finally {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^football-baseline-shell-/);
    fs.rmSync(temp, { recursive: true });
  }
}
module.exports = { verify, SOURCE_BASELINE_HELPER_MODULES };
if (require.main === module) { try { console.log(JSON.stringify(verify(), null, 2)); } catch (error) { console.error(error.stack); process.exitCode = 1; } }
