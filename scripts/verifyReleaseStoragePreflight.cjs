"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { assertLegacyStorageEnvironment } = require("./releaseStoragePreflight.cjs");
const root = path.resolve(__dirname, ".."), checks = [];
for (const content of ["", "# storage\nFOOTBALL_POSTGRES_MODE=primary\n", "FOOTBALL_STORAGE_MODE=hybrid\nENABLE_SQLITE_EXPORT=1\n",
  "FOOTBALL_STORAGE_MODE='HYBRID'\n", " export FOOTBALL_STORAGE_MODE=hybrid\n"]) {
  assert.equal(assertLegacyStorageEnvironment(content).lane, "legacy-hybrid"); checks.push("legacy-compatible");
}
for (const content of ["FOOTBALL_STORAGE_MODE=postgres-only", " FOOTBALL_STORAGE_MODE = 'postgres-only' ",
  "export FOOTBALL_STORAGE_MODE=POSTGRES-ONLY", "PRIVATE_MODEL_ARTIFACT_STORAGE=postgres", "POSTGRES_PROJECTION_SOURCE=native-generation",
  "ENABLE_SQLITE_EXPORT=0", "FOOTBALL_STORAGE_MODE=unknown", "FOOTBALL_STORAGE_MODE=hybrid\n FOOTBALL_STORAGE_MODE=postgres-only",
  "FOOTBALL_STORAGE_MODE=\"hybrid", "FOOTBALL_STORAGE_MODE=hybrid\\\n", "not an environment assignment"]) {
  assert.throws(() => assertLegacyStorageEnvironment(content)); checks.push("reject-native-partial-or-ambiguous");
}
const read = name => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n?/g, "\n");
const source = read("deploy/light-server/release-from-bundle.sh"), wrapper = read("deploy/light-server/football-release");
const entryCall = '"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseStoragePreflight.cjs"';
const wrapperCall = 'env -i PATH="$PATH" "$NODE_BIN" "$TRUSTED_SOURCE_DIR/scripts/releaseStoragePreflight.cjs"';
const entryIndex = source.indexOf(entryCall), wrapperIndex = wrapper.indexOf(wrapperCall);
assert.ok(entryIndex > 0 && entryIndex < source.indexOf('node -e "require(\'node:sqlite\')"'));
assert.ok(entryIndex < source.indexOf('\nrotate_fixed_recovery_helper \\'));
assert.ok(entryIndex < source.indexOf('\ninitialize_release_recovery_snapshot\n'));
assert.ok(wrapperIndex > wrapper.indexOf('readonly RELEASE_SCRIPT_PATH='));
assert.ok(wrapperIndex < wrapper.lastIndexOf('consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"'));
const bash = process.env.VERIFY_BASH_EXECUTABLE || (process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash");
for (const [name, text, index, command] of [["entrypoint", source, entryIndex, "node"], ["wrapper", wrapper, wrapperIndex, "env"]]) {
  const end = text.indexOf("\n", text.indexOf("\n", index) + 1), fragment = text.slice(index, end);
  for (const status of [0, 1]) {
    const script = `set -eu\nNODE_HOME=''; NODE_BIN=node; TRUSTED_SOURCE_DIR=/fixture\nfunction ${command === "node" ? "/bin/node" : "env"}() { return ${status}; }\ndie() { exit 1; }\n${fragment}\nprintf 'expensive-work\\n'\n`;
    const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], { input: script, encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8" } });
    assert.equal(result.status, status, result.stderr); assert.equal(result.stdout.includes("expensive-work"), status === 0);
    checks.push(name + (status ? "-rejects-before-work" : "-continues-hybrid"));
  }
}
for (const file of ["scripts/createReleaseBundle.cjs", "scripts/verifyReleaseBundleSafety.cjs"])
  assert.ok(read(file).includes('"scripts/releaseStoragePreflight.cjs"'));
console.log(JSON.stringify({ ok: true, checks: checks.length, scope: "storage parsing and actual early shell dispatch fragments", databaseQueries: 0, providerRequests: 0 }));
