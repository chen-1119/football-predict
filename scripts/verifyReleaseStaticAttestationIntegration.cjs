"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const bashPathFor = value => process.platform === "win32"
  ? path.resolve(value).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase())
  : value;

function findBash() {
  const explicit = process.env.VERIFY_BASH_EXECUTABLE || process.env.RELEASE_TEST_BASH;
  if (explicit) { assert.ok(fs.existsSync(explicit), "configured Bash must exist"); return explicit; }
  if (process.platform !== "win32") { assert.ok(fs.existsSync("/bin/bash"), "Bash is required"); return "/bin/bash"; }
  const found = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const candidates = (found.stdout || "").trim().split(/\r?\n/).filter(Boolean)
    .flatMap(file => [path.resolve(path.dirname(file), "../bin/bash.exe"), path.resolve(path.dirname(file), "../usr/bin/bash.exe")]);
  const bash = candidates.find(file => fs.existsSync(file));
  assert.ok(bash, "real Bash required; set VERIFY_BASH_EXECUTABLE (no silently skipped shell tests)");
  return bash;
}

function extractFunction(source, name) {
  const start = source.indexOf(`\n${name}() {\n`);
  assert.ok(start >= 0, `missing actual shell function ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated actual shell function ${name}`);
  return source.slice(start + 1, end + 3);
}

function extractCommand(source, startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `missing actual invocation: ${startText}`);
  assert.equal(source.indexOf(startText, start + 1), -1, `ambiguous actual invocation: ${startText}`);
  return source.slice(start, end + endText.length);
}

function verifyReleaseStaticAttestationIntegration() {
  const source = fs.readFileSync(path.join(rootDir, "deploy/light-server/release-from-bundle.sh"), "utf8").replace(/\r\n?/g, "\n");
  const prepare = extractFunction(source, "prepare_release_static_attestations");
  const cleanup = extractFunction(source, "cleanup_release_static_attestations");
  const main = source.slice(source.indexOf("\nrequire_cmd npm\n"));
  assert.ok(main.length > 1000, "locate the actual release main program");
  const candidate = extractCommand(main,
    'run_trusted_candidate_verifier env PATH="$PATH" HOME="$BUILD_HOME" ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN"',
    '|| abort_before_swap "candidate production readiness failed"');
  const live = extractCommand(main,
    'run_as_service_user_with_runtime_env env VERIFY_BASE_URL="http://${HOST}:${PORT}"',
    '|| rollback "post-swap production readiness failed"');
  const prepareCall = 'prepare_release_static_attestations || abort_before_swap "isolated pure verifier failed before candidate readiness"';
  assert.ok(main.includes(prepareCall));
  const bash = findBash(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "football-static-shell-test-"));
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const logicalStore = "/run/football-release-static.ABC123", releaseSha = "a".repeat(64);
  let sequence = 0;
  const run = (mode, action = "readiness") => {
    const directory = path.join(temporary, String(++sequence)); fs.mkdirSync(directory);
    const fixture = bashPathFor(directory);
    fs.mkdirSync(path.join(directory, "runtime/bin"), { recursive: true });
    fs.writeFileSync(path.join(directory, "mode"), mode + "\n");
    // Only the producer CLI and ownership observations are doubled. Exact
    // production Bash functions and readiness argument lists run unmodified.
    // The logical /run object maps to a marker in this private fixture; tests
    // never create/remove /run directories or invoke the real root producer.
    const fakeNode = `#!/bin/bash
set -euo pipefail
fixture=${quote(fixture)}
IFS= read -r mode < "$fixture/mode"
[[ "$1" == "$fixture/trusted/scripts/createRootStaticVerificationAttestations.cjs" ]] || exit 95
[[ -z "\${INHERITED_SECRET_CANARY:-}" && -z "\${NODE_OPTIONS:-}" && -z "\${NODE_PATH:-}" ]] || exit 94
printf '%s\\n' "$*" >> "$fixture/producer-calls"
if [[ "$2" == cleanup ]]; then
  [[ "$#" -eq 6 && "$3" == ${quote(logicalStore)} && "$4" == 123 && "$5" == 456 && "$6" == ${quote(releaseSha)} ]] || exit 2
  [[ "$mode" != *cleanup-fail* ]] || exit 2
  rm -f -- "$fixture/store-alive"
  printf 'cleaned\\n' >> "$fixture/cleanup-events"
  exit 0
fi
[[ "$#" -eq 4 && "$2" == --shell && "$3" == "$fixture/next" && "$4" == ${quote(releaseSha)} ]] || exit 93
case "$mode" in
  unavailable-no-directory) exit 2 ;;
  failed-no-directory) exit 3 ;;
  invalid-output) printf '/etc/not-a-proof-store\\n'; exit 0 ;;
  extra-output) printf '${logicalStore}\\nunexpected-output\\n'; exit 0 ;;
esac
: > "$fixture/store-alive"
printf '${logicalStore}\\n'
case "$mode" in failed*) exit 3 ;; unavailable*) exit 2 ;; *) exit 0 ;; esac
`;
    fs.writeFileSync(path.join(directory, "runtime/bin/node"), fakeNode, { mode: 0o755 });
    fs.chmodSync(path.join(directory, "runtime/bin/node"), 0o755);
    const capture = `
capture_state() {
  printf 'dir=%s\\nreuse=%s\\ndevice=%s\\ninode=%s\\n' "$RELEASE_STATIC_ATTESTATION_DIR" "$RELEASE_STATIC_ATTESTATION_REUSE_DIR" "$RELEASE_STATIC_ATTESTATION_DEVICE" "$RELEASE_STATIC_ATTESTATION_INODE" > "$fixture/state"
}
`;
    const actionBody = action === "readiness" ? `
prepare_rc=0
prepare_release_static_attestations || prepare_rc=$?
printf '%s\\n' "$prepare_rc" > "$fixture/prepare-rc"
capture_state
if [[ "$prepare_rc" -eq 0 ]]; then
${candidate}
${live}
fi
` : action === "abort-on-failure" ? `
abort_before_swap() { printf '%s\\n' "$*" > "$fixture/aborted"; exit 73; }
${prepareCall}
printf 'unexpected continuation\\n' > "$fixture/continued"
` : action.startsWith("cleanup:") ? `
prepare_release_static_attestations
printf '%s\\n' ${quote(mode)} > "$fixture/mode"
${action.slice("cleanup:".length)}
capture_state
` : (() => { throw new Error("unknown shell fixture action"); })();
    const harness = `set -euo pipefail
fixture=${quote(fixture)}
mode=${quote(mode)}
NODE_HOME="$fixture/runtime"
TRUSTED_SOURCE_DIR="$fixture/trusted"
NEXT_DIR="$fixture/next"
APP_DIR="$fixture/app"
BUNDLE_SHA256=${quote(releaseSha)}
RELEASE_STATIC_ATTESTATION_DIR=""
RELEASE_STATIC_ATTESTATION_REUSE_DIR=""
RELEASE_STATIC_ATTESTATION_DEVICE=""
RELEASE_STATIC_ATTESTATION_INODE=""
BUILD_HOME="$fixture/home"
CANDIDATE_ADMIN_TOKEN="fixture-admin"
HOST=127.0.0.1
PORT=8788
CANDIDATE_PORT=8789
CANDIDATE_STORE_DIR="$fixture/candidate-store"
CANDIDATE_SQLITE_PATH="$fixture/candidate-store/football.db"
LIVE_STORE_DIR="$fixture/live-store"
LIVE_SQLITE_PATH="$fixture/live-store/football.db"
PRIMARY_READ_SOURCE=postgres
export INHERITED_SECRET_CANARY=must-not-reach-producer
export NODE_OPTIONS=--require=must-not-reach-producer
export NODE_PATH=/must-not-reach-producer
export VERIFY_STATIC_RECEIPT_DIR=/untrusted-inherited-hmac
log() { printf '%s\\n' "$*" >> "$fixture/messages"; }
stat() {
  [[ "$#" -eq 4 && "$1" == -c && "$3" == -- && "$4" == ${quote(logicalStore)} ]] || return 96
  case "$2" in
    '%u:%g:%a') if [[ "$mode" == bad-permissions ]]; then printf '0:0:777'; else printf '0:0:755'; fi ;;
    '%d') if [[ "$mode" == *device-stat-failed* ]]; then return 1; else printf 123; fi ;;
    '%i') case "$mode" in *inode-stat-empty*) ;; *inode-stat-invalid*) printf 'invalid';; *) printf 456;; esac ;;
    *) return 96 ;;
  esac
}
[() {
  if [[ "$#" -eq 3 && "$1" == -d && "$2" == ${quote(logicalStore)} ]]; then builtin [ -f "$fixture/store-alive" ]; return; fi
  if [[ "$#" -eq 4 && "$1" == '!' && "$2" == -L && "$3" == ${quote(logicalStore)} ]]; then [[ "$mode" != symlink-store ]]; return; fi
  builtin [ "$@"
}
readiness_arguments() {
  local lane="$1" arg proof="missing" sha="missing" hmac="missing"
  shift
  [[ "$1" == env ]] || return 97
  for arg in "$@"; do
    printf '%s\\t%s\\n' "$lane" "$arg" >> "$fixture/readiness-arguments"
    case "$arg" in VERIFY_STATIC_ATTESTATION_DIR=*) proof="\${arg#*=}";; VERIFY_STATIC_RELEASE_SHA=*) sha="\${arg#*=}";; VERIFY_STATIC_RECEIPT_DIR=*) hmac="\${arg#*=}";; esac
  done
  [[ "$sha" == "$BUNDLE_SHA256" && "$proof" == "$RELEASE_STATIC_ATTESTATION_REUSE_DIR" && -z "$hmac" ]] || return 98
  if [[ -n "$proof" ]]; then printf '%s:proof-reference\\n' "$lane"; else printf '%s:fresh-invocation\\n' "$lane"; fi >> "$fixture/readiness-events"
}
run_trusted_candidate_verifier() { readiness_arguments candidate "$@"; }
run_as_service_user_with_runtime_env() { readiness_arguments live "$@"; }
abort_before_swap() { printf 'unexpected abort: %s\\n' "$*" >&2; return 91; }
rollback() { printf 'unexpected rollback: %s\\n' "$*" >&2; return 92; }
${cleanup}
${prepare}
${capture}
${actionBody}
`;
    const child = spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: harness, cwd: directory,
      encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, BASH_ENV: "", ENV: "", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
    assert.ifError(child.error);
    const read = name => fs.existsSync(path.join(directory, name)) ? fs.readFileSync(path.join(directory, name), "utf8").trim() : null;
    return { status: child.status, signal: child.signal, stderr: child.stderr, stdout: child.stdout,
      state: Object.fromEntries((read("state") || "").split("\n").filter(Boolean).map(row => { const i = row.indexOf("="); return [row.slice(0, i), row.slice(i + 1)]; })),
      prepareRc: read("prepare-rc"), events: read("readiness-events"), arguments: read("readiness-arguments"),
      cleanupEvents: read("cleanup-events"), calls: read("producer-calls"), aborted: read("aborted"), continued: read("continued"), alive: read("store-alive") !== null };
  };
  const passed = result => { assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.signal, null); return result; };
  try {
    check("entire actual release script has valid Bash syntax", () => {
      const child = spawnSync(bash, ["--noprofile", "--norc", "-n"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    });
    check("successful preparation binds exact root store device inode and both readiness references", () => {
      const r = passed(run("success")); assert.equal(r.prepareRc, "0");
      assert.deepEqual(r.state, { dir: logicalStore, reuse: logicalStore, device: "123", inode: "456" });
      assert.equal(r.events, "candidate:proof-reference\nlive:proof-reference"); assert.equal(r.alive, true);
      assert.ok(r.calls.includes(`--shell `));
    });
    for (const mode of ["unavailable", "unavailable-no-directory", "invalid-output", "extra-output", "bad-permissions", "symlink-store",
      "device-stat-failed", "inode-stat-empty", "inode-stat-invalid"]) check(`${mode} cannot publish a reuse pointer and retains both original readiness invocations`, () => {
      const r = passed(run(mode)); assert.equal(r.prepareRc, "0"); assert.equal(r.state.reuse, "");
      assert.equal(r.events, "candidate:fresh-invocation\nlive:fresh-invocation");
    });
    for (const mode of ["failed", "failed-no-directory", "failed-device-stat-failed", "failed-inode-stat-empty"]) check(`${mode} remains a release abort rather than an optimization miss`, () => {
      const r = run(mode, "abort-on-failure"); assert.equal(r.status, 73, r.stderr);
      assert.match(r.aborted, /isolated pure verifier failed/); assert.equal(r.continued, null);
    });
    check("unavailable producer plus cleanup failure preserves retry identity but disables reuse", () => {
      const r = passed(run("unavailable-cleanup-fail")); assert.deepEqual(r.state,
        { dir: logicalStore, reuse: "", device: "123", inode: "456" });
      assert.equal(r.events, "candidate:fresh-invocation\nlive:fresh-invocation"); assert.equal(r.alive, true);
    });
    const cleanupSites = [
      ["abort", extractFunction(source, "abort_before_swap")],
      ["rollback", extractFunction(source, "rollback")],
      ["exit trap", extractFunction(source, "release_exit_trap")],
      ["successful commit", main],
    ];
    // The success marker may evolve; use its unique warning to identify the
    // one actual cleanup command in main, never an invented lookalike.
    for (const [site, block] of cleanupSites) {
      const statements = block.match(/^\s*cleanup_release_static_attestations \|\| log "[^"\n]+"$/gm) || [];
      assert.equal(statements.length, 1, `${site} must have exactly one actual cleanup call`);
      check(`${site} actual cleanup call clears all references only after producer cleanup success`, () => {
        const r = passed(run("success", "cleanup:" + statements[0]));
        assert.deepEqual(r.state, { dir: "", reuse: "", device: "", inode: "" });
        assert.equal(r.cleanupEvents, "cleaned"); assert.equal(r.alive, false);
      });
      check(`${site} cleanup failure never retains a reusable pointer or loses cleanup authority`, () => {
        const r = passed(run("cleanup-fail", "cleanup:" + statements[0]));
        assert.deepEqual(r.state, { dir: logicalStore, reuse: "", device: "123", inode: "456" });
        assert.equal(r.cleanupEvents, null); assert.equal(r.alive, true);
      });
    }
    check("root preparation occurs once after safe assembly and before the transition lease or worker pause", () => {
      const start = main.indexOf('log "assemble brand-new final tree');
      const block = main.slice(start); const prepareAt = block.indexOf(prepareCall);
      assert.ok(prepareAt > block.indexOf('verify_worker_write_permissions "$NEXT_DIR"'));
      assert.ok(prepareAt < block.indexOf('CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT='));
      assert.ok(prepareAt < block.indexOf('start_release_sync_write_barrier'));
      assert.equal(main.split(prepareCall).length - 1, 1);
    });
    check("readiness flags are invocation-local and never enter persisted app runtime configuration", () => {
      for (const block of [candidate, live]) {
        assert.ok(block.includes('VERIFY_STATIC_ATTESTATION_DIR="$RELEASE_STATIC_ATTESTATION_REUSE_DIR"'));
        assert.ok(block.includes('VERIFY_STATIC_RELEASE_SHA="$BUNDLE_SHA256"'));
        assert.match(block, /\bVERIFY_STATIC_RECEIPT_DIR=(?:""|(?=\s))/);
      }
      assert.equal((source.match(/VERIFY_STATIC_ATTESTATION_DIR=/g) || []).length, 2);
      assert.equal((source.match(/VERIFY_STATIC_RELEASE_SHA=/g) || []).length, 2);
      assert.doesNotMatch(extractFunction(source, "prepare_runtime_env"), /VERIFY_STATIC_/);
      assert.doesNotMatch(extractFunction(source, "start_candidate_unit"), /VERIFY_STATIC_/);
      assert.match(extractFunction(source, "run_as_service_user_with_runtime_env"), /\. "\$1"; set \+a; shift; exec "\$@"/);
      for (const filename of ["deploy/light-server/env.example", "deploy/light-server/football-predict.service"]) {
        assert.doesNotMatch(fs.readFileSync(path.join(rootDir, filename), "utf8"), /VERIFY_STATIC_/);
      }
    });
    return { ok: true, verifier: "release-static-attestation-integration-v1", checks,
      shellFixtures: sequence, productionWrites: 0, providerRequests: 0,
      scope: "actual extracted Bash control flow and readiness argv with isolated producer/metadata doubles; root trust, systemd and Linux filesystem proof verified separately" };
  } finally {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^football-static-shell-test-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

module.exports = { verifyReleaseStaticAttestationIntegration };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyReleaseStaticAttestationIntegration(), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
