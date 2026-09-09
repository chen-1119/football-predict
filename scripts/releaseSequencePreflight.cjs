"use strict";
// Cheap source gate before candidate construction. Behavioral branch tests live
// in verifyReleaseSpeedFix.cjs; this never executes the privileged wrapper.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BURN = 'consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"';
function validateSequenceBranches(source) {
  source = source.replace(/\r\n?/g, "\n");
  const marker = 'if [ "$MANIFEST_KIND" = "frontend-only" ]; then';
  const begin = source.lastIndexOf(marker);
  const end = source.indexOf('\nreadonly TRUSTED_SOURCE_DIR=', begin);
  assert.ok(begin >= 0 && end > begin, "missing exclusive frontend branch");
  const frontend = source.slice(begin, end);
  const full = source.slice(end);
  const count = value => value.split(BURN).length - 1;
  assert.equal(count(frontend), 1, "frontend must consume exactly once");
  assert.equal(count(full), 1, "full must consume exactly once");
  assert.equal(count(source.slice(0, begin)), 0, "no consumption before dispatch");
  assert.ok(source.indexOf('readonly MANIFEST_SEQUENCE="$manifest_sequence"') < begin);
  assert.match(frontend, /if \[ "\$frontend_status" -ne 0 \]; then[\s\S]*?exit "\$frontend_status"\n  fi/);
  assert.match(frontend, /\n  exit 0\nfi\s*$/);
  assert.ok(frontend.indexOf(BURN) < frontend.indexOf('apply "$BUNDLE_SHA"'));
  assert.ok(full.indexOf(BURN) < full.indexOf('bash "$RELEASE_SCRIPT_PATH" "$TRUSTED_SOURCE_DIR"'));
  assert.match(source, /readonly MANIFEST_KIND=/);
  return { frontend, full };
}
module.exports = { BURN, validateSequenceBranches };
if (require.main === module) {
  try {
    validateSequenceBranches(fs.readFileSync(path.join(__dirname, "../deploy/light-server/football-release"), "utf8"));
    console.log(JSON.stringify({ ok: true, checks: [{ name: "exclusive-sequence-consumption", ok: true }] }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, phase: "sequence-preflight", reason: error.message }));
    process.exitCode = 1;
  }
}
