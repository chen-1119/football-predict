const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const syncDataPath = path.resolve(__dirname, "syncData.cjs");
const {
  writeJson,
  filesHaveSameBytes,
  retainPredictionSnapshotRows,
  shouldUseStreamingJson,
} = require(syncDataPath);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-sync-json-"));
const checks = [];

const check = (name, operation) => {
  operation();
  checks.push({ name, ok: true });
};

const expectedJson = (payload) => `${JSON.stringify(payload, null, 2)}\n`;
const read = (filePath) => fs.readFileSync(filePath, "utf8");
const tempResidueFor = (filePath) => fs.readdirSync(path.dirname(filePath))
  .filter((name) => name.startsWith(`${path.basename(filePath)}.`) && name.endsWith(".tmp"));

try {
  const nestedRows = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    label: `球队-${index}`,
    nested: { values: [index, null, `line\n${index}`] },
  }));
  const arrayPath = path.join(tempRoot, "array.json");
  check("streaming boundary stays at 100 rows", () => {
    assert.equal(shouldUseStreamingJson(nestedRows.slice(0, 99)), false);
    assert.equal(shouldUseStreamingJson(nestedRows), true);
    assert.equal(shouldUseStreamingJson({ rows: nestedRows.slice(0, 99) }), false);
    assert.equal(shouldUseStreamingJson({ rows: nestedRows }), true);
  });

  check("100-row top-level arrays stream with byte-identical pretty JSON", () => {
    assert.equal(writeJson(arrayPath, nestedRows), true);
    assert.equal(read(arrayPath), expectedJson(nestedRows));
    assert.deepEqual(JSON.parse(read(arrayPath)), nestedRows);
  });

  const rowPayload = {
    version: 1,
    source: "memory-safety-fixture",
    rows: nestedRows,
    summary: { rows: nestedRows.length },
  };
  const rowPayloadPath = path.join(tempRoot, "row-payload.json");
  check("objects with a large rows array stream with byte-identical property order", () => {
    assert.equal(writeJson(rowPayloadPath, rowPayload), true);
    assert.equal(read(rowPayloadPath), expectedJson(rowPayload));
    assert.deepEqual(JSON.parse(read(rowPayloadPath)), rowPayload);
  });

  check("streaming no-op comparison is chunked and preserves the existing file", () => {
    const before = fs.statSync(rowPayloadPath);
    assert.equal(writeJson(rowPayloadPath, rowPayload), false);
    const after = fs.statSync(rowPayloadPath);
    assert.equal(after.size, before.size);
    assert.equal(filesHaveSameBytes(arrayPath, rowPayloadPath), false);
    assert.deepEqual(tempResidueFor(rowPayloadPath), []);
  });

  check("a changed streamed row is atomically published", () => {
    const changed = structuredClone(rowPayload);
    changed.rows[99].label = "changed";
    assert.equal(writeJson(rowPayloadPath, changed), true);
    assert.deepEqual(JSON.parse(read(rowPayloadPath)), changed);
    assert.deepEqual(tempResidueFor(rowPayloadPath), []);
  });

  check("compatibility mirror keeps only the latest bounded snapshots per match", () => {
    const rows = ["a", "b"].flatMap((sourceMatchId) => (
      Array.from({ length: 10 }, (_, index) => ({
        sourceMatchId,
        capturedAt: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
        sequence: index,
      }))
    ));
    const retained = retainPredictionSnapshotRows(rows, {
      maxRows: 500,
      maxRowsPerMatch: 6,
    });
    assert.equal(retained.length, 12);
    for (const sourceMatchId of ["a", "b"]) {
      assert.deepEqual(
        retained.filter((row) => row.sourceMatchId === sourceMatchId).map((row) => row.sequence),
        [4, 5, 6, 7, 8, 9]
      );
    }
  });

  check("serialization failure leaves the previous file intact and no temp residue", () => {
    const before = read(rowPayloadPath);
    const invalid = {
      version: 2,
      rows: Array.from({ length: 100 }, (_, index) => ({
        index,
        value: index === 50 ? 1n : index,
      })),
    };
    assert.throws(() => writeJson(rowPayloadPath, invalid), /BigInt|serialize/i);
    assert.equal(read(rowPayloadPath), before);
    assert.deepEqual(tempResidueFor(rowPayloadPath), []);
  });

  check("shared 40MB payload writes under a 64MB V8 heap", () => {
    const pressurePath = path.join(tempRoot, "pressure.json");
    const child = spawnSync(process.execPath, [
      "--max-old-space-size=64",
      "-e",
      [
        "const fs=require('node:fs');",
        "const {writeJson}=require(process.env.SYNC_DATA_MODULE);",
        "const shared='x'.repeat(256*1024);",
        "const rows=Array.from({length:160},(_,index)=>({index,payload:shared}));",
        "const changed=writeJson(process.env.SYNC_DATA_TARGET,{version:1,rows});",
        "const stat=fs.statSync(process.env.SYNC_DATA_TARGET);",
        "const fd=fs.openSync(process.env.SYNC_DATA_TARGET,'r');",
        "const head=Buffer.alloc(1);const tail=Buffer.alloc(2);",
        "fs.readSync(fd,head,0,1,0);fs.readSync(fd,tail,0,2,Math.max(0,stat.size-2));fs.closeSync(fd);",
        "process.stdout.write(JSON.stringify({changed,bytes:stat.size,validBoundary:head.toString()==='{'&&tail.toString()==='}\\n'}));",
      ].join(""),
    ], {
      cwd: path.dirname(__dirname),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SYNC_DATA_MODULE: syncDataPath,
        SYNC_DATA_TARGET: pressurePath,
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.changed, true);
    assert.equal(result.validBoundary, true);
    assert.ok(result.bytes > 40 * 1024 * 1024, `unexpected pressure fixture size ${result.bytes}`);
    assert.deepEqual(tempResidueFor(pressurePath), []);
  });

  console.log(JSON.stringify({
    ok: true,
    verifier: "sync-data-memory-safety",
    assertions: checks.length,
    checks,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    verifier: "sync-data-memory-safety",
    assertions: checks.length,
    checks,
    error: error?.stack || error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`)) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
