"use strict";

// Validate the fast-result receipt migration against a stable *copy* of the
// production SQLite database.  The caller owns creation of that copy (the
// signed release path uses its sealed rollback snapshot); this verifier never
// commits any change to it.  A legacy v1 receipt is migrated twice in separate
// rolled-back transactions so both roots must be deterministic.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  readFastResultReceiptState,
  fastResultReceiptRoot,
} = require("./fastResultReceiptIntegrity.cjs");
const {
  authorityIdentityKey,
  loadAuthorityHighWater,
  rowsRootHash,
} = require("./fastResultAuthorityHighWater.cjs");
const {
  resolveFastResultReceiptAuthorities,
} = require("./fastResultReceiptAuthority.cjs");
const {
  migrateLegacyFastResultIntegrity,
} = require("./publishOfficialResultsFast.cjs");
const {
  trustedOfficialFinal,
} = require("./fastResultObservations.cjs");

const usage = () => {
  process.stderr.write("Usage: node scripts/verifyFastResultProductionClone.cjs --sqlite-path <sealed-production-clone> [--require-receipt]\n");
  process.exit(2);
};

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sqliteArg = readArg("--sqlite-path") || process.env.FAST_RESULT_PRODUCTION_CLONE_SQLITE_PATH;
if (!sqliteArg || args.includes("--help") || args.includes("-h")) usage();
if (args.some((value, index) => value.startsWith("--")
  && !["--sqlite-path", "--require-receipt", "--transaction-child"].includes(value)
  && args[index - 1] !== "--sqlite-path")) usage();

const sqlitePath = path.resolve(sqliteArg);
const requireReceipt = args.includes("--require-receipt") || process.env.FAST_RESULT_PRODUCTION_CLONE_REQUIRE_RECEIPT === "1";
const transactionChild = args.includes("--transaction-child");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const fileSha256 = (filePath) => {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(bytes === buffer.length ? buffer : buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
};
const stableFileIdentity = (filePath) => {
  const stat = fs.lstatSync(filePath, { bigint: true });
  check(stat.isFile() && !stat.isSymbolicLink(), `production clone must be a regular file: ${filePath}`);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    sha256: fileSha256(filePath),
    // SQLite can legitimately advance mtime while rolling a write transaction
    // back to byte-identical content. Keep the clock for diagnostics, but do
    // not mistake filesystem metadata for committed database state.
    mtimeNs: String(stat.mtimeNs),
  };
};
const sameFileContent = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.sha256 === right.sha256
);
const sqliteSidecarState = (filePath) => Object.fromEntries(
  ["-journal", "-wal", "-shm"].map((suffix) => {
    const sidecarPath = `${filePath}${suffix}`;
    if (!fs.existsSync(sidecarPath)) return [suffix, null];
    return [suffix, stableFileIdentity(sidecarPath)];
  })
);
const sidecarSummary = (state) => Object.fromEntries(
  Object.entries(state).map(([suffix, value]) => [suffix, value ? {
    size: value.size,
    sha256: value.sha256,
  } : null])
);
const sameSidecarContent = (left, right) => (
  Object.keys(left).every((suffix) => {
    const before = left[suffix];
    const after = right[suffix];
    if (!before || !after) return before === after;
    return sameFileContent(before, after);
  })
);
const parsePayload = (value) => {
  try { return JSON.parse(String(value || "")); } catch { return null; }
};
const historyRows = (db) => db.prepare(`
  SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
  FROM match_snapshots
  WHERE dataset = 'history'
  ORDER BY id ASC
`).all().map((row) => ({ ...row, match: parsePayload(row.payload) }))
  .filter((row) => row.match && trustedOfficialFinal(row.match));

const validateState = (db) => {
  const receiptState = readFastResultReceiptState(db);
  check(receiptState.valid && !receiptState.legacy, `receipt v2 is invalid: ${receiptState.reason || "unknown"}`);
  if (requireReceipt) check(!receiptState.missing, "production clone is missing the required fast-result receipt");
  const authorityState = loadAuthorityHighWater(db);
  check(authorityState.valid, "authority high-water root is invalid");
  if (receiptState.missing) {
    check(authorityState.missing, "receipt-less clone unexpectedly has authority high-water state");
    return {
      receiptRootHash: null,
      authorityRootHash: null,
      observations: 0,
      authorityRows: 0,
      legacyAliasObservations: 0,
    };
  }
  check(!authorityState.missing, "receipt exists but authority high-water state is missing");
  check(receiptState.receipt.observationsRootHash === fastResultReceiptRoot(receiptState.observations), "receipt v2 root mismatch");
  check(authorityState.manifest?.rootHash === rowsRootHash(authorityState.rows), "authority high-water root mismatch");
  const resolution = resolveFastResultReceiptAuthorities({
    observations: receiptState.observations,
    historyRows: historyRows(db),
  });
  check(resolution.ok, `receipt authority resolution failed: ${resolution.reason || resolution.mismatchKind || "unknown"}`);
  const authorities = new Map(authorityState.rows.map((row) => [row.key, row]));
  for (const group of resolution.groups) {
    check(authorities.has(group.authorityIdentity.key), `authority high-water row missing: ${group.authorityIdentity.key}`);
    for (const alias of group.legacyAliasObservations) {
      const aliasIdentity = authorityIdentityKey({
        sourceMatchId: alias.sourceMatchId,
        eventVersion: alias.eventVersion || alias.kickoffTime,
      });
      check(aliasIdentity && aliasIdentity.key !== group.authorityIdentity.key, "legacy midnight alias resolved as a second authority identity");
      check(!authorities.has(aliasIdentity.key), "legacy midnight alias leaked into authority high-water");
    }
  }
  return {
    receiptRootHash: receiptState.receipt.observationsRootHash,
    authorityRootHash: authorityState.manifest.rootHash,
    observations: receiptState.observations.length,
    authorityRows: authorityState.rows.length,
    resolvedAuthorityEvents: resolution.authorityRows,
    legacyAliasObservations: resolution.legacyAliasObservations,
  };
};

const runAttempt = (db) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = readFastResultReceiptState(db);
    const migration = before.legacy
      ? migrateLegacyFastResultIntegrity(db, { transactionOpen: true })
      : { ok: true, migrated: false, reason: before.missing ? "receipt-missing" : "already-v2" };
    check(migration.ok, `legacy receipt migration failed: ${migration.reason || "unknown"}`);
    const verified = validateState(db);
    db.exec("ROLLBACK");
    return { migration, verified };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the verifier error */ }
    throw error;
  }
};

const runTransactionChild = () => {
  let db = null;
  try {
    db = new DatabaseSync(sqlitePath);
    db.exec("PRAGMA busy_timeout = 60000");
    const first = runAttempt(db);
    const second = runAttempt(db);
    check(
      first.verified.receiptRootHash === second.verified.receiptRootHash
        && first.verified.authorityRootHash === second.verified.authorityRootHash,
      "repeated clone migration changed a receipt or authority root",
    );
    db.close();
    db = null;
    process.stdout.write(`${JSON.stringify({ first, second })}\n`);
  } catch (error) {
    try { db?.close(); } catch { /* nothing to do */ }
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
};

const runParent = () => {
  let workDir = null;
  try {
    const beforeFile = stableFileIdentity(sqlitePath);
    const beforeSidecars = sqliteSidecarState(sqlitePath);
    check(
      !beforeSidecars["-journal"] || Number(beforeSidecars["-journal"].size) === 0,
      "sealed production clone has an active rollback journal",
    );
    // The release seal can legitimately contain a non-empty WAL. Opening that
    // sealed snapshot directly lets SQLite checkpoint it into the main file,
    // changing physical bytes even when both migration attempts roll back.
    // Exercise the migration on a disposable main+WAL working clone and prove
    // the sealed source (including every sidecar) stayed byte-identical.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-production-clone-verify-"));
    const workingPath = path.join(workDir, "football.db");
    fs.copyFileSync(sqlitePath, workingPath);
    if (beforeSidecars["-wal"]) fs.copyFileSync(`${sqlitePath}-wal`, `${workingPath}-wal`);
    const childArgs = [__filename, "--sqlite-path", workingPath, "--transaction-child"];
    if (requireReceipt) childArgs.push("--require-receipt");
    const child = spawnSync(process.execPath, childArgs, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    check(child.status === 0, String(child.stderr || child.stdout || "transaction child failed").trim());
    const transaction = JSON.parse(String(child.stdout || "{}"));
    const afterFile = stableFileIdentity(sqlitePath);
    const afterSidecars = sqliteSidecarState(sqlitePath);
    check(sameFileContent(beforeFile, afterFile), "sealed production clone bytes changed during migration verification");
    check(
      sameSidecarContent(beforeSidecars, afterSidecars),
      "sealed production clone sidecars changed during migration verification",
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "fast-result-production-clone-v3",
      sqlitePath,
      requireReceipt,
      cloneUnchanged: true,
      byteIdentity: {
        size: afterFile.size,
        sha256: afterFile.sha256,
        mtimeChanged: beforeFile.mtimeNs !== afterFile.mtimeNs,
        sealedSourceUnchanged: true,
        beforeSidecars: sidecarSummary(beforeSidecars),
        afterSidecars: sidecarSummary(afterSidecars),
      },
      first: transaction.first,
      second: transaction.second,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
};

if (transactionChild) runTransactionChild();
else runParent();
