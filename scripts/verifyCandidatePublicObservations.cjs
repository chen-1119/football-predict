"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readCandidatePublicObservations } = require("./readCandidatePublicObservations.cjs");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
if (process.argv[2] === "--bounded-child") {
  const vm = require("node:vm"), file = process.argv[3];
  const source = fs.readFileSync(path.join(__dirname, "captureCandidateProspectiveDeadline.cjs"), "utf8");
  const a = source.indexOf("const readTopLevelArrayProperty = ("), b = source.indexOf("\nconst publicOddsRows", a);
  assert.ok(a > 0 && b > a);
  const result = vm.runInNewContext(source.slice(a, b) + '\n({rows:publicSnapshotRows({observationsOnly:true}),audit:publicSnapshotReadAudit});', {
    fs, Buffer, publicSnapshotPrefixMaxBytes: 8 * 1024 * 1024, publicSnapshotsFile: file, require,
    readJson: () => { throw new Error("unbounded full-JSON fallback must not execute"); },
  }, { timeout: 30000 });
  assert.equal(result.audit.mode, "observations-streamed"); assert.equal(result.rows.length, 2);
  console.log(JSON.stringify({ ok: true, mode: result.audit.mode, rows: result.rows.length, noteHash: digest(result.rows[0].note),
    second: result.rows[1], fileBytes: result.audit.fileBytes, maxRssKiB: process.resourceUsage().maxRSS }));
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "football-capture-memory-")), file = path.join(dir, "snapshots.json");
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  try {
    const note = "观测😀[]\\\"".repeat(640000), expected = [{ sourceMatchId: "preserved-draw", note }, { sourceMatchId: "last-row", direction: "draw", capturedAt: "2026-09-11T01:00:00Z" }];
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, '{"observations":' + JSON.stringify(expected) + ',"rows":[{"ignored":"');
      const chunk = "x".repeat(1024 * 1024); for (let i = 0; i < 96; i++) fs.writeSync(fd, chunk);
      fs.writeSync(fd, '"}]}');
    } finally { fs.closeSync(fd); }
    check("actual prefix-overflow caller preserves all observations under 96 MiB V8 heap", () => {
      const child = spawnSync(process.execPath, ["--max-old-space-size=96", __filename, "--bounded-child", file],
        { encoding: "utf8", windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
      assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.signal, null);
      const report = JSON.parse(child.stdout); assert.equal(report.ok, true); assert.equal(report.noteHash, digest(note));
      assert.deepEqual(report.second, expected[1]); assert.ok(report.fileBytes > 100 * 1024 * 1024);
      assert.ok(report.maxRssKiB < 320 * 1024, "bounded reader exceeded 320 MiB RSS"); checks.push({ name: "observed bounded child memory", ok: true, ...report });
    });
    const small = value => fs.writeFileSync(file, value);
    check("non-prefix nested lookalikes cannot replace actual top-level observations", () => {
      small(JSON.stringify({ rows: [{ observations: ["wrong"] }], observations: expected.slice(1) }));
      assert.deepEqual(readCandidatePublicObservations(file).rows, expected.slice(1));
    });
    check("malformed skipped history fails closed", () => { small('{"observations":[],"rows":[1,]}'); assert.throws(() => readCandidatePublicObservations(file), { code: "FILE_JSON_INVALID" }); });
    check("invalid observation type fails closed", () => { small('{"observations":{}}'); assert.throws(() => readCandidatePublicObservations(file), { code: "CANDIDATE_OBSERVATIONS_INVALID" }); });
    check("selected-value bound does not fall back to a full parse", () => { small('{"observations":["' + "x".repeat(200) + '"]}'); assert.throws(() => readCandidatePublicObservations(file, { maxSelectedChars: 100 }), { code: "SELECTED_JSON_VALUE_LIMIT" }); });
    check("file admission bound rejects before loading data", () => assert.throws(() => readCandidatePublicObservations(file, { maxFileBytes: 10 }), { code: "CANDIDATE_SNAPSHOT_FILE_BOUND" }));
    check("absent observations remains empty after validating complete JSON", () => { small('{"rows":[]}'); assert.deepEqual(readCandidatePublicObservations(file).rows, []); });
    console.log(JSON.stringify({ ok: true, verifier: "candidate-public-observations-v1", checks, productionWrites: 0, providerRequests: 0 }, null, 2));
  } finally {
    const resolved = fs.realpathSync(dir); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-capture-memory-")); fs.rmSync(resolved, { recursive: true });
  }
}
