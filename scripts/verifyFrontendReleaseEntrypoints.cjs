"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const shellPath = value => process.platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase()) : value;
const normalize = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");
function section(source, begin, end, from = 0) {
  const start = source.indexOf(begin, from), finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= from && finish > start, "missing exact source boundary: " + begin);
  return { source: source.slice(start, finish), start, end: finish };
}
function shellFunction(source, name) {
  const start = source.indexOf("\n" + name + "() {\n"), end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "missing shell function " + name); return source.slice(start + 1, end + 3);
}
function heredoc(source, after) {
  const start = source.indexOf("<<'NODE'\n", source.indexOf(after)), end = source.indexOf("\nNODE\n", start);
  assert.ok(start >= 0 && end > start); return source.slice(start + "<<'NODE'\n".length, end);
}
async function verifyFrontendReleaseEntrypoints() {
  const wrapperPath = path.join(root, "deploy/light-server/football-release"), bootstrapPath = path.join(root, "deploy/light-server/bootstrap-release-entrypoints.sh");
  const rawWrapper = fs.readFileSync(wrapperPath), rawBootstrap = fs.readFileSync(bootstrapPath);
  const wrapper = normalize(rawWrapper), bootstrap = normalize(rawBootstrap), checks = [], startedAt = Date.now();
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "football-frontend-entrypoints-")), inode = fs.lstatSync(temp).ino;
  fs.chmodSync(temp, 0o700); let count = 0, bashRuns = 0;
  const gitPaths = process.platform === "win32" ? (spawnSync("where.exe", ["git.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true }).stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
  const bash = process.env.VERIFY_BASH_EXECUTABLE || (process.platform === "win32"
    ? gitPaths.map(file => path.resolve(path.dirname(file), "../bin/bash.exe")).find(file => fs.existsSync(file)) : "/bin/bash");
  assert.ok(bash && fs.existsSync(bash), "actual Bash is required; no skipped branch fixtures");
  const sourceHashes = [
    { name: "deploy/light-server/football-release", sha256: hash(rawWrapper) },
    { name: "deploy/light-server/bootstrap-release-entrypoints.sh", sha256: hash(rawBootstrap) },
    { name: "deploy/light-server/football-release-recovery.cjs", sha256: hash(fs.readFileSync(path.join(root, "deploy/light-server/football-release-recovery.cjs"))) },
    { name: "scripts/verifyFrontendReleaseEntrypoints.cjs", sha256: hash(fs.readFileSync(__filename)) },
  ];
  const check = async (name, fn) => { const begin = Date.now(); await fn(); checks.push({ name, ok: true, elapsedMs: Date.now() - begin }); };
  const write = (file, contents, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, contents, { mode }); fs.chmodSync(file, mode); };
  const runBash = (f, script, args = []) => {
    bashRuns += 1;
    const file = path.join(f.directory, "fixture.sh"); write(file, script + "\n");
    const child = spawnSync(bash, [shellPath(file), ...args], { cwd: f.directory, encoding: "utf8", timeout: 10000, maxBuffer: 262144, windowsHide: true });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    return { ...child, trace: fs.existsSync(f.trace) ? fs.readFileSync(f.trace, "utf8").trim().split("\n").filter(Boolean) : [] };
  };
  function fixture(mode = "ok") {
    const directory = path.join(temp, "case-" + ++count); fs.mkdirSync(directory);
    const f = { directory, mode, trace: path.join(directory, "trace"), lock: path.join(directory, "lock"), sequence: path.join(directory, "sequence"),
      statuses: path.join(directory, "status"), recovery: path.join(directory, "recovery-current"), work: path.join(directory, "work"),
      node: path.join(directory, "fixed-node"), helper: path.join(directory, "fixed-controller"), legacy: path.join(directory, "fixed-legacy.cjs"),
      sha: "a".repeat(64), seq: 712 };
    fs.mkdirSync(f.statuses); fs.mkdirSync(f.work); fs.mkdirSync(f.helper); write(f.sequence, "711\n");
    f.status = path.join(f.statuses, f.sha + ".status");
    f.uploads = ["bundle", "sha", "manifest", "signature"].map(name => path.join(directory, "upload-" + name));
    for (const file of f.uploads) write(file, "fixture upload");
    const clean = '[[ "$(env)" != *INHERITED_SECRET_CANARY=* && "$(env)" != *NODE_OPTIONS=* && "$(env)" != *NODE_PATH=* ]] || exit 91';
    const fixedController = shellPath(path.join(f.helper, "frontendReleaseController.cjs"));
    const fakeNode = [
      "#!/bin/bash", "set -euo pipefail", clean, '[[ -e /dev/fd/9 ]] || exit 92',
      "printf 'inherited-fd9\\n' >&9",
      process.platform === "linux" ? "if /usr/bin/flock -n " + quote(shellPath(f.lock)) + " true; then exit 93; fi" : ":",
      "if [[ \"$1\" == " + quote(fixedController) + " ]]; then",
      '  case "$2" in',
      '    apply) [[ "$#" == 5 && "$3" == ' + quote(f.sha) + ' && "$4" == 712 && "$5" == ' + quote(shellPath(f.work)) + " ]] || exit 94 ;;",
      '    initialize) [[ "$#" == 4 && "$3" == ' + quote(f.sha) + ' && "$4" == 712 ]] || exit 95',
      "      grep -qx 'status=complete' " + quote(shellPath(f.status)) + " || exit 96 ;;",
      '    recover) [[ "$#" == 2 ]] || exit 97 ;;',
      "    *) exit 98 ;;", "  esac",
      "  printf 'controller:%s\\n' \"$2\" >>" + quote(shellPath(f.trace)),
      "  exit " + (mode === "controller-fail" || mode === "initialize-fail" ? "23" : "0"),
      "elif [[ \"$1\" == " + quote(shellPath(f.legacy)) + ' && "$#" == 1 ]]; then',
      "  printf 'legacy-recovery\\n' >>" + quote(shellPath(f.trace)), "  exit 0", "fi", "exit 99",
    ].join("\n");
    write(f.node, fakeNode, 0o755);
    return f;
  }
  function prelude(f, kind = "frontend-only") {
    return [
      "set -Eeuo pipefail", "umask 077",
      "TRACE=" + quote(shellPath(f.trace)), "LOCK_FILE=" + quote(shellPath(f.lock)), "HIGHEST_SEQUENCE_FILE=" + quote(shellPath(f.sequence)),
      "STATUS_DIR=" + quote(shellPath(f.statuses)), "RECOVERY_CURRENT=" + quote(shellPath(f.recovery)), "work_dir=" + quote(shellPath(f.work)),
      "NODE_BIN=" + quote(shellPath(f.node)), "FRONTEND_HELPER_DIR=" + quote(shellPath(f.helper)), "RECOVERY_HELPER=" + quote(shellPath(f.legacy)),
      "BUNDLE_SHA=" + quote(f.sha), "MANIFEST_SEQUENCE=712", "HIGHEST_ACCEPTED_SEQUENCE=711", "MANIFEST_KIND=" + quote(kind),
      "TRUSTED_KEY_ID=fixture-key", "STARTED_AT=2026-09-08T00:00:00Z", "UPLOAD_GROUP=fixture", "status_finalized=0",
      ...["SOURCE_BUNDLE", "SOURCE_SHA", "SOURCE_MANIFEST", "SOURCE_SIGNATURE"].map((name, i) => name + "=" + quote(shellPath(f.uploads[i]))),
      "export INHERITED_SECRET_CANARY=fixture-only NODE_OPTIONS=fixture-injection NODE_PATH=/fixture/injection",
      'die() { printf "%s\\n" "$*" >&2; exit 1; }',
      'assert_root_controlled_file() { [[ -f "$1" && ! -L "$1" ]] || die "fixture nonplain"; }',
      'check_recovery_runtime() { printf "runtime-check\\n" >>"$TRACE"; }',
      'assert_frontend_controller() { printf "controller-guard\\n" >>"$TRACE"; }',
      // Ownership/durability are explicit doubles; file writes, rename, status
      // serialization and fd 9 propagation remain real within the private tree.
      'chown() { return 0; }', 'sync() { return 0; }',
      'mv() { local target="¤{@: -1}"; command mv "$@" || return; if [[ "$target" == "$HIGHEST_SEQUENCE_FILE" ]]; then printf "sequence-consumed\\n" >>"$TRACE"; elif [[ "$target" == "$STATUS_DIR/"* ]]; then local first; IFS= read -r first <"$target"; printf "%s\\n" "$first" >>"$TRACE"; fi; }',
      process.platform === "linux"
        ? 'flock() { command flock "$@" || return; printf "locked-fd9\\n" >>"$TRACE"; }'
        : 'flock() { [[ "$*" == "-n 9" && -e /dev/fd/9 ]] || return 1; printf "locked-fd9\\n" >>"$TRACE"; }',
      shellFunction(wrapper, "read_single_line"), shellFunction(wrapper, "acquire_release_lock"),
      shellFunction(wrapper, "consume_release_sequence_before_execution"), shellFunction(wrapper, "write_status"),
    ].join("\n").replaceAll("¤", "$");
  }
  const uiStart = wrapper.indexOf('if [ "$MANIFEST_KIND" = "frontend-only" ]; then', wrapper.indexOf("\nPY\n"));
  const ui = section(wrapper, 'if [ "$MANIFEST_KIND" = "frontend-only" ]; then', '\nreadonly TRUSTED_SOURCE_DIR=', uiStart);
  const recovery = section(wrapper, 'if [ "¤{1:-}" = "--recover" ]; then'.replace("¤", "$"), '\n[ "$#" -eq 1 ] || die "usage: football-release --check|--recover|');
  const tail = section(wrapper, 'if [ "$release_status" -ne 0 ]; then', "\nexit 0", ui.end).source + "\nexit 0";
  const bootstrapModules = /readonly FRONTEND_MODULES=\(([^)]+)\)/.exec(bootstrap)?.[1].split(/\s+/);
  assert.ok(bootstrapModules?.length);
  try {
    await check("actual normalized Bash syntax and actual Node syntax of the fixed installed controller closure", () => {
      for (const [name, source] of [["wrapper.sh", wrapper], ["bootstrap.sh", bootstrap]]) {
        const file = path.join(temp, name); write(file, source);
        const child = spawnSync(bash, ["-n", shellPath(file)], { encoding: "utf8", timeout: 10000, windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
      }
      for (const name of [...bootstrapModules.map(name => "scripts/" + name), "server/frontendReleaseIdentity.cjs"]) {
        const file = path.join(root, name), bytes = fs.readFileSync(file); sourceHashes.push({ name, sha256: hash(bytes) });
        const child = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10000, windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
      }
    });
    await check("signature-authenticated kind parser actually rejects unknown kinds before route or sequence selection", () => {
      const body = heredoc(wrapper, "manifest_kind="), pair = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
      const f = fixture(), file = path.join(f.directory, "signed-manifest.json");
      assert.ok(wrapper.indexOf("openssl dgst -sha256 -verify") < wrapper.indexOf("manifest_kind="));
      assert.match(wrapper.slice(wrapper.indexOf("manifest_kind="), wrapper.indexOf("<<'NODE'", wrapper.indexOf("manifest_kind="))), /env -i.*"\$NODE_BIN"/s);
      assert.match(wrapper.slice(wrapper.indexOf("manifest_sequence="), wrapper.indexOf("<<'NODE'", wrapper.indexOf("manifest_sequence="))), /env -i.*"\$NODE_BIN"/s);
      for (const [value, expected] of [[{}, "full"], [{ releaseKind: "full" }, "full"], [{ releaseKind: "frontend-only" }, "frontend-only"],
        ...["unknown", "", null, false, [], {}].map(releaseKind => [{ releaseKind }, null]), [{ frontendAuthorization: {} }, null]]) {
        const bytes = Buffer.from(JSON.stringify(value)), signature = crypto.sign("sha256", bytes, pair.privateKey);
        assert.equal(crypto.verify("sha256", bytes, pair.publicKey, signature), true); write(file, bytes);
        const child = spawnSync(process.execPath, ["-", file], { input: body, encoding: "utf8", timeout: 10000, windowsHide: true,
          env: { PATH: path.dirname(process.execPath), ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } });
        assert.equal(child.error, undefined);
        if (expected) { assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, expected); }
        else { assert.notEqual(child.status, 0); assert.match(child.stderr, /unsupported signed release kind/); }
      }
    });
    await check("UI success consumes once on inherited fd9 and exits before old full extraction or candidate execution", () => {
      const f = fixture(), result = runBash(f, prelude(f) + "\nacquire_release_lock\n" + ui.source + '\nprintf "FULL-FALLBACK\\n" >>"$TRACE"\n');
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.trace, ["locked-fd9", "sequence-consumed", "controller:apply", "status=complete"]);
      assert.equal(fs.readFileSync(f.sequence, "utf8"), "712\n"); assert.equal(fs.readFileSync(f.lock, "utf8"), "inherited-fd9\n");
      assert.ok(f.uploads.every(file => !fs.existsSync(file))); assert.ok(ui.end < wrapper.indexOf('bash "$RELEASE_SCRIPT_PATH" "$TRUSTED_SOURCE_DIR"'));
      const status = fs.readFileSync(f.status, "utf8"); assert.match(status, /^releaseKind=frontend-only$/m); assert.match(status, /^releaseSequence=712$/m); assert.match(status, /^ok=1$/m);
    });
    await check("UI failure preserves controller exit status with no full fallback or second build and consumes once", () => {
      const f = fixture("controller-fail"), result = runBash(f, prelude(f) + "\nacquire_release_lock\n" + ui.source + '\nprintf "FULL-FALLBACK\\n" >>"$TRACE"\n');
      assert.equal(result.status, 23, result.stderr); assert.deepEqual(result.trace, ["locked-fd9", "sequence-consumed", "controller:apply", "status=failed"]);
      const status = fs.readFileSync(f.status, "utf8"); assert.match(status, /^exitCode=23$/m); assert.match(status, /^releaseKind=frontend-only$/m); assert.match(status, /^releaseSequence=712$/m);
      assert.ok(f.uploads.every(file => fs.existsSync(file))); assert.match(result.stdout, /no full fallback/);
    });
    await check("pending recovery blocks UI before consuming a sequence and full kind still reaches its untouched old continuation", () => {
      const f = fixture(); fs.mkdirSync(f.recovery);
      const blocked = runBash(f, prelude(f) + "\nacquire_release_lock\n" + ui.source); assert.equal(blocked.status, 1); assert.deepEqual(blocked.trace, ["locked-fd9"]); assert.equal(fs.readFileSync(f.sequence, "utf8"), "711\n");
      const full = fixture(), result = runBash(full, prelude(full, "full") + "\nacquire_release_lock\n" + ui.source + '\nprintf "FULL-CONTINUATION\\n" >>"$TRACE"\n');
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.trace, ["locked-fd9", "FULL-CONTINUATION"]);
    });
    await check("real status writer records validated kind and sequence for running full and UI observations", () => {
      for (const kind of ["full", "frontend-only"]) {
        const f = fixture(), result = runBash(f, prelude(f, kind) + '\nwrite_status running 0 "" "$BUNDLE_SHA" "$STARTED_AT" "$UPLOAD_GROUP"\n');
        assert.equal(result.status, 0, result.stderr); const status = fs.readFileSync(f.status, "utf8"); assert.match(status, /^status=running$/m);
        assert.ok(status.includes("releaseKind=" + kind + "\n")); assert.match(status, /^releaseSequence=712$/m);
      }
    });
    await check("accepted full initialization is optional and post-completion even when the fixed controller fails", () => {
      for (const mode of ["ok", "initialize-fail"]) {
        const f = fixture(mode), result = runBash(f, prelude(f, "full") + "\nacquire_release_lock\nrelease_status=0\n" + tail);
        assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.trace, ["locked-fd9", "status=complete", "controller-guard", "controller:initialize"]);
        assert.equal(fs.readFileSync(f.sequence, "utf8"), "711\n"); assert.match(fs.readFileSync(f.status, "utf8"), /^status=complete$/m);
        assert.equal(result.stderr.includes("full release accepted"), mode === "initialize-fail");
      }
    });
    await check("failed full release exits before optional initialization without replay", () => {
      const f = fixture(), result = runBash(f, prelude(f, "full") + "\nacquire_release_lock\nrelease_status=17\n" + tail);
      assert.equal(result.status, 17); assert.deepEqual(result.trace, ["locked-fd9", "status=failed"]); assert.equal(fs.readFileSync(f.sequence, "utf8"), "711\n");
    });
    await check("frontend recovery markers execute only the fixed controller using the same fd9 and never legacy fallback", () => {
      for (const marker of ["frontend-transaction.json", "phase.json"]) {
        const f = fixture("controller-fail"); fs.mkdirSync(f.recovery); write(path.join(f.recovery, marker), "{}");
        const result = runBash(f, prelude(f) + "\n" + recovery.source + '\nprintf "RECOVERY-FALLBACK\\n" >>"$TRACE"\n', ["--recover"]);
        assert.equal(result.status, 23, result.stderr); assert.deepEqual(result.trace, ["runtime-check", "locked-fd9", "controller-guard", "controller:recover"]);
        assert.equal(fs.readFileSync(f.sequence, "utf8"), "711\n");
      }
    });
    await check("legacy and absent recovery markers retain fixed cold helper routing without frontend execution", () => {
      for (const present of [false, true]) {
        const f = fixture(); if (present) { fs.mkdirSync(f.recovery); write(path.join(f.recovery, "state.json"), "{}"); }
        const result = runBash(f, prelude(f) + "\n" + recovery.source, ["--recover"]);
        assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.trace, ["runtime-check", "locked-fd9", "legacy-recovery"]);
      }
      assert.doesNotMatch(fs.readFileSync(path.join(root, "deploy/light-server/football-release-recovery.cjs"), "utf8"), /phase\.json|frontend-transaction\.json/);
    });
    await verifyBootstrap();
    const sourcesUnchanged = sourceHashes.every(row => hash(fs.readFileSync(path.join(root, row.name))) === row.sha256); assert.equal(sourcesUnchanged, true);
    return { ok: true, suite: "frontend-release-entrypoints-v1", checks, startedAt, finishedAt: Date.now(), sourceHashes, sourcesUnchanged,
      privateFixtureCount: count, actualBashFixtures: bashRuns, actualNodeSyntaxChecks: bootstrapModules.length + 1, actualOsFlockProof: process.platform === "linux",
      ownershipAndDurability: "doubled observations; no production owner/ACL or durability claim", controllerExecution: "fixed command double, not a build or deployment",
      installByteCopyAndMode: process.platform === "linux" ? "real GNU install with fixture ownership; production root ownership not exercised" : "real byte copy; POSIX install mode and ownership doubled on Windows",
      parserImport: "actual bootstrap JS ordering with offline import double; dependency importer separately verified", productionWrites: 0, providerRequests: 0,
      oldFullSuitesExecuted: 0, fixture: temp, temporaryFixturesRemoved: true };
  } finally {
    assert.equal(fs.lstatSync(temp).ino, inode); assert.equal(fs.realpathSync(temp), temp); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(temp), /^football-frontend-entrypoints-/); fs.rmSync(temp, { recursive: true }); assert.equal(fs.existsSync(temp), false);
  }

  async function verifyBootstrap() {
    const copied = section(bootstrap, 'if [ -e "$FRONTEND_INSTALL_DIR" ]', '\ninstall -o root -g root -m 0755 "¤{SCRIPT_DIR}/football-relay-promote"'.replace("¤", "$"));
    const importBody = heredoc(bootstrap, 'if [ -n "$FRONTEND_MATERIAL" ]; then');
    const controllerSource = fs.readFileSync(path.join(root, "scripts/frontendReleaseController.cjs"), "utf8");
    const controllerModules = /const MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(controllerSource)?.[1].match(/"[^"]+\.cjs"/g)?.map(name => JSON.parse(name));
    assert.ok(controllerModules?.length);
    await check("bootstrap copies the exact runtime closure plus offline importer and identity with byte hashes", () => {
      assert.deepEqual([...bootstrapModules, "frontendReleaseIdentity.cjs"].sort(), [...controllerModules, "frontendBuildDependencies.cjs"].sort());
      const guard = shellFunction(wrapper, "assert_frontend_controller");
      for (const name of controllerModules) assert.ok(guard.includes(name));
      assert.ok(!guard.includes("TRUSTED_SOURCE_DIR") && !guard.includes("APP_DIR"));
      assert.ok(bootstrap.indexOf("flock 9") < copied.start); assert.ok(bootstrap.indexOf("node --check") < copied.start);
      assert.match(bootstrap, /readonly FRONTEND_INSTALL_DIR="\/usr\/local\/libexec\/football-release-frontend"/);
      assert.match(wrapper, /readonly FRONTEND_HELPER_DIR="\/usr\/local\/libexec\/football-release-frontend"/);
    });
    for (const mode of ["ok", "import-failure", "corrupt-copy"]) await check("actual bootstrap copy and import-before-wrapper routing: " + mode, () => {
      const f = fixture(), sourceRoot = path.join(f.directory, "source"), scriptDir = path.join(sourceRoot, "deploy/light-server");
      fs.mkdirSync(scriptDir, { recursive: true }); const modulesDir = path.join(sourceRoot, "scripts");
      for (const name of bootstrapModules) write(path.join(modulesDir, name), fs.readFileSync(path.join(root, "scripts", name)));
      write(path.join(sourceRoot, "server/frontendReleaseIdentity.cjs"), fs.readFileSync(path.join(root, "server/frontendReleaseIdentity.cjs")));
      write(path.join(scriptDir, "football-release"), rawWrapper);
      const driver = path.join(f.directory, "import-driver.cjs");
      write(driver, [
        '"use strict"; const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");',
        "const trace=" + JSON.stringify(f.trace) + ",mode=" + JSON.stringify(mode) + ";",
        'const helper={async importFrontendBuildDependencies(input){assert.deepEqual(Object.keys(input).sort(),["lockSha256","materialArchiveSha256","materialDir","materialManifestSha256"]);fs.appendFileSync(trace,"offline-import\\n");if(mode==="import-failure")throw Error("fixture import rejected");return {fixture:true};},',
        'async installFrontendBuildParser(input){assert.deepEqual(Object.keys(input),["lockSha256"]);fs.appendFileSync(trace,"parser-installed\\n");return {fixture:true};}};',
        'const p={argv:["node",...process.argv.slice(2)],exitCode:0};',
        'vm.runInNewContext(fs.readFileSync(0,"utf8"),{process:p,console,require(name){assert.equal(name,"/usr/local/libexec/football-release-frontend/frontendBuildDependencies.cjs");return helper;}});',
        'setImmediate(()=>{process.exitCode=p.exitCode;});',
      ].join("\n"));
      const targetWrapper = path.join(f.directory, "installed-wrapper"), target = shellPath(f.directory);
      const script = [
        "set -Eeuo pipefail", "umask 077", "fixture=" + quote(target), "TRACE=" + quote(shellPath(f.trace)),
        "SOURCE_BASELINE_SOURCE_DIR=" + quote(shellPath(modulesDir)), "SCRIPT_DIR=" + quote(shellPath(scriptDir)),
        "FRONTEND_INSTALL_DIR=" + quote(shellPath(f.helper)), "FRONTEND_MODULES=(" + bootstrapModules.join(" ") + ")",
        "FRONTEND_MATERIAL=/tmp/football-frontend-materials-FIXTURE", "FRONTEND_MATERIAL_MANIFEST_SHA=" + "a".repeat(64),
        "FRONTEND_MATERIAL_ARCHIVE_SHA=" + "b".repeat(64), "FRONTEND_DEPENDENCY_LOCK_SHA=" + "c".repeat(64),
        'die() { printf "%s\\n" "$*" >&2; exit 1; }', 'stat() { printf "0:0:700\\n"; }',
        'install() { local args=() target; while (($#)); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; target="¤{args[¤{#args[@]}-1]}";',
        '  if [[ "$target" == /usr/local/sbin/football-release ]]; then target=' + quote(shellPath(targetWrapper)) + '; args[¤{#args[@]}-1]="$target"; printf "wrapper-installed\\n" >>"$TRACE"; fi;',
        '  [[ "$target" == "$fixture/"* ]] || die "outside private fixture";',
        process.platform === "win32"
          ? '  if [[ "¤{args[0]}" == -d ]]; then command mkdir -p "$target"; else command cp -- "¤{args[¤{#args[@]}-2]}" "$target"; fi || return;'
          : '  command install "¤{args[@]}" || return;',
        mode === "corrupt-copy" ? '  if [[ "$target" == "$FRONTEND_INSTALL_DIR/frontendRuntimeBoundary.cjs" ]]; then printf "tamper\\n" >"$target"; fi;' : ":;",
        "}",
        'env() { [[ "$1" == -i && "$2" == PATH=/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin && "$3" == LANG=C.UTF-8 && "$4" == /opt/node-v22.22.1/bin/node ]] || die "unexpected bootstrap node"; shift 4;',
        "  command env -i PATH=/usr/bin:/bin " + quote(shellPath(process.execPath)) + " " + quote(shellPath(driver)) + ' "$@";',
        "}",
        copied.source,
      ].join("\n").replaceAll("¤", "$");
      const result = runBash(f, script);
      if (mode === "ok") {
        assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.trace, ["offline-import", "parser-installed", "wrapper-installed"]);
        for (const name of bootstrapModules) assert.equal(hash(fs.readFileSync(path.join(f.helper, name))), hash(fs.readFileSync(path.join(modulesDir, name))));
        if (process.platform === "linux") {
          assert.equal(fs.lstatSync(f.helper).mode & 0o777, 0o700);
          for (const name of [...bootstrapModules, "frontendReleaseIdentity.cjs"]) assert.equal(fs.lstatSync(path.join(f.helper, name)).mode & 0o777, 0o644);
          assert.equal(fs.lstatSync(targetWrapper).mode & 0o777, 0o755);
        }
        assert.equal(hash(fs.readFileSync(path.join(f.helper, "frontendReleaseIdentity.cjs"))), hash(fs.readFileSync(path.join(sourceRoot, "server/frontendReleaseIdentity.cjs"))));
        assert.equal(hash(fs.readFileSync(targetWrapper)), hash(rawWrapper));
      } else {
        assert.notEqual(result.status, 0); assert.equal(fs.existsSync(targetWrapper), false);
        assert.deepEqual(result.trace, mode === "import-failure" ? ["offline-import"] : []);
      }
      assert.ok(copied.source.indexOf("installFrontendBuildParser") < copied.source.indexOf('/usr/local/sbin/football-release'));
      assert.equal(importBody.includes("npm"), false);
    });
  }
}
module.exports = { verifyFrontendReleaseEntrypoints };
if (require.main === module) verifyFrontendReleaseEntrypoints().then(report => console.log(JSON.stringify(report, null, 2)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
