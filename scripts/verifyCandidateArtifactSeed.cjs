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
  const cases = ["valid", "missing-registry", "symlink-registry", "hardlink-registry", "linked-parent", "unsafe-optional", "target-already-present", "wrong-destination"];
  try {
    for (const mode of cases) {
      const cwd = path.join(temporary, mode); fs.mkdirSync(cwd);
      // Exercise the exact production Bash functions with real files, no
      // mocked copy/validation commands and no access to production storage.
      const harness = `set -euo pipefail
${extract("copy_regular_file_nofollow")}
${extract("seed_candidate_model_artifacts")}
LIVE_STORE_DIR="$PWD/live"
BUILD_DIR="$PWD/build"
CANDIDATE_STORE_DIR="$BUILD_DIR/server-data"
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
if [ '${mode}' != valid ]; then
  [ "$seed_status" -ne 0 ]
  exit 0
fi
[ "$seed_status" -eq 0 ]
cmp "$registry" "$CANDIDATE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
[ "$(sha256sum "$registry" | cut -d ' ' -f 1)" = "$before" ]
printf '%s\\n' changed-in-isolated-copy >> "$CANDIDATE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
[ "$(sha256sum "$registry" | cut -d ' ' -f 1)" = "$before" ]
cmp "$LIVE_STORE_DIR/model-strategy.json" "$CANDIDATE_STORE_DIR/model-strategy.json"
[ ! -e "$CANDIDATE_STORE_DIR/model-artifacts/evaluation.json" ]
`;
      const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: harness, cwd, encoding: "utf8", timeout: 20000,
        env: { ...process.env, MSYS: "winsymlinks:nativestrict" } });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, mode === "valid" ? /^seed-status=0\r?$/m : /^seed-status=[1-9]\d*\r?$/m);
      // Fixture setup errors do not count as a validation rejection.
      assert.doesNotMatch(result.stderr || "", /failed to create symbolic link|command not found|cannot create directory/);
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
