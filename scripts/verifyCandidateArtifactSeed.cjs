"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");

function verifyCandidateArtifactSeed({ source } = {}) {
  const script = (source || fs.readFileSync(path.join(__dirname, "../deploy/light-server/release-from-bundle.sh"), "utf8")).replace(/\r\n/g, "\n");
  const extract = name => {
    const start = script.indexOf(`${name}() {\n`), end = script.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, name);
    return script.slice(start, end + 3);
  };
  const main = script.slice(script.indexOf('log "create isolated build tree from trusted source"'));
  const markers = ['stop_worker_for_release_window', 'preserve_live_public_data_cache', 'seed_candidate_model_artifacts',
    'stop_release_sync_write_barrier clean', 'restart_worker_if_needed', 'run_build_step npm-ci', 'run_candidate_model_artifact_catchup'];
  let previous = -1;
  for (const marker of markers) { const at = main.indexOf(marker); assert.ok(at > previous, marker); previous = at; }
  assert.match(main, /seed_candidate_model_artifacts \\\n  \|\| abort_before_swap "candidate model artifact snapshot is missing or unsafe"/);
  assert.equal(process.platform, "linux", "Run the real permission/link tests in an isolated Linux directory; Windows ACL behavior is not equivalent");
  const bash = process.env.VERIFY_BASH_EXECUTABLE || "/bin/bash";
  assert.ok(fs.existsSync(bash), "Bash is required: set VERIFY_BASH_EXECUTABLE; no silent behavioral-test skip");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-seed-"));
  const cases = ["valid", "valid-private-audit", "missing-registry", "symlink-registry", "hardlink-registry", "linked-parent", "unsafe-optional", "target-already-present", "wrong-destination"];
  const trustedRoot = path.resolve(__dirname, ".."), helperPath = path.join(__dirname, "releasePrivateModelSeed.cjs");
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    for (const mode of cases) {
      const cwd = path.join(temporary, mode); fs.mkdirSync(cwd);
      const runtime = path.join(cwd, "fixture-runtime"), proof = path.join(cwd, "seed-proof.json");
      fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
      // The production CLI intentionally requires root. This unprivileged
      // fixture launcher invokes its unchanged exported implementation, with
      // exact helper and disposable store paths asserted before any operation.
      // No copy/SQLite/model validation is mocked or removed.
      fs.writeFileSync(path.join(runtime, "bin/node"), `#!${process.execPath}\n"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs");
assert.deepEqual(process.argv.slice(2),${JSON.stringify([helperPath, path.join(cwd,"live"), path.join(cwd,"build/server-data")])});
const result=require(${JSON.stringify(helperPath)}).seedPrivateModelAudit({sourceStore:process.argv[3],candidateStore:process.argv[4]});
fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify(result),{flag:"wx",mode:0o600});
`, { flag: "wx", mode: 0o700 });
      if (mode === "valid-private-audit") require("./verifyReleasePrivateModelSeed.cjs").fixture(path.join(cwd, "live"));
      // Exercise the exact production Bash functions with real files, no
      // mocked copy/validation commands and no access to production storage.
      const harness = `set -euo pipefail
${extract("copy_regular_file_nofollow")}
${extract("seed_candidate_model_artifacts")}
LIVE_STORE_DIR="$PWD/live"
BUILD_DIR="$PWD/build"
CANDIDATE_STORE_DIR="$BUILD_DIR/server-data"
NODE_HOME=${quote(runtime)}
TRUSTED_SOURCE_DIR=${quote(trustedRoot)}
mkdir -p "$LIVE_STORE_DIR/model-artifacts" "$CANDIDATE_STORE_DIR"
registry="$LIVE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
printf '%s\\n' '{"preserve":"all-original-events","unknownField":123}' > "$registry"
printf '%s\\n' '{"strategy":"preserved"}' > "$LIVE_STORE_DIR/model-strategy.json"
before="$(sha256sum "$registry" | cut -d ' ' -f 1)"
case '${mode}' in
  missing-registry) mv "$registry" "$LIVE_STORE_DIR/retained.json" ;;
  symlink-registry) mv "$registry" "$LIVE_STORE_DIR/retained.json"; ln -s ../retained.json "$registry" ;;
  hardlink-registry) ln "$registry" "$LIVE_STORE_DIR/retained.json" ;;
  linked-parent) mv "$LIVE_STORE_DIR/model-artifacts" "$LIVE_STORE_DIR/retained-artifacts"; ln -s retained-artifacts "$LIVE_STORE_DIR/model-artifacts" ;;
  unsafe-optional) ln -s ../model-strategy.json "$LIVE_STORE_DIR/model-artifacts/evaluation.json" ;;
  target-already-present) mkdir "$CANDIDATE_STORE_DIR/model-artifacts" ;;
  wrong-destination) CANDIDATE_STORE_DIR="$LIVE_STORE_DIR" ;;
esac
seed_status=0
seed_candidate_model_artifacts || seed_status="$?"
printf 'seed-status=%s\\n' "$seed_status"
if [ '${mode}' != valid ] && [ '${mode}' != valid-private-audit ]; then
  [ "$seed_status" -ne 0 ]
  exit 0
fi
[ "$seed_status" -eq 0 ]
cmp "$registry" "$CANDIDATE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
[ "$(sha256sum "$registry" | cut -d ' ' -f 1)" = "$before" ]
printf '%s\\n' changed-in-isolated-copy >> "$CANDIDATE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
[ "$(sha256sum "$registry" | cut -d ' ' -f 1)" = "$before" ]
cmp "$LIVE_STORE_DIR/model-strategy.json" "$CANDIDATE_STORE_DIR/model-strategy.json"
if [ '${mode}' = valid ]; then
  [ ! -e "$CANDIDATE_STORE_DIR/model-artifacts/evaluation.json" ]
else
  cmp "$LIVE_STORE_DIR/model-artifacts/evaluation.json" "$CANDIDATE_STORE_DIR/model-artifacts/evaluation.json"
  [ -s "$CANDIDATE_STORE_DIR/football.db" ]
fi
`;
      const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: harness, cwd, encoding: "utf8", timeout: 20000,
        env: { ...process.env, MSYS: "winsymlinks:nativestrict" } });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      const valid = mode === "valid" || mode === "valid-private-audit";
      assert.match(result.stdout, valid ? /^seed-status=0\r?$/m : /^seed-status=[1-9]\d*\r?$/m);
      if (valid) {
        const seeded = JSON.parse(fs.readFileSync(proof, "utf8"));
        assert.equal(seeded.mode, mode === "valid" ? "recompute" : "seeded");
        assert.equal(seeded.seeded, mode === "valid-private-audit");
        if (mode === "valid-private-audit") {
          const { validateReusablePrivateAudit } = require("./releasePrivateModelSeed.cjs");
          const source = validateReusablePrivateAudit({ storeDir: path.join(cwd, "live") });
          const target = validateReusablePrivateAudit({ storeDir: path.join(cwd, "build/server-data") });
          assert.equal(source.payloadSha256, target.payloadSha256); assert.equal(source.updatedAt, target.updatedAt);
        }
      }
      // Fixture setup errors do not count as a validation rejection.
      assert.doesNotMatch(result.stderr || "", /failed to create symbolic link|command not found|cannot create directory|unbound variable/);
    }
  } finally {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("football-candidate-seed-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  return { ok: true, cases: cases.length, orderingChecks: markers.length, scope: "real Bash functions and isolated filesystem; no production writes" };
}
if (require.main === module) { try { console.log(JSON.stringify(verifyCandidateArtifactSeed())); } catch (error) { console.error(error); process.exitCode = 1; } }
module.exports = { verifyCandidateArtifactSeed };
