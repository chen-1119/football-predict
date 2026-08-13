const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const positiveInteger = (value, fallback, minimum, label) => {
  const resolved = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return resolved;
};

const assertRealDirectory = (directory, label) => {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
};

const assertRegularFile = (filePath, label) => {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} is not a single-link regular file: ${filePath}`);
  }
  return info;
};

const readOddsPayload = (sourcePath) => {
  assertRegularFile(sourcePath, "odds history input");
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`odds history input is not valid JSON: ${error.message || error}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("odds history input must be an object");
  }
  if (!Array.isArray(payload.rows)) {
    throw new Error("odds history input must contain a rows array");
  }
  return payload;
};

const rowObservationTime = (row) => {
  if (!row || typeof row !== "object" || Array.isArray(row)) return Number.NaN;
  return Date.parse(
    row.lastSeenAt
      || row.capturedAt
      || row.oddsUpdatedAt
      || row.kickoffTime
      || "",
  );
};

const verifySerializedPayload = (body, expectedRows, label) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== expectedRows) {
    throw new Error(`${label} row count mismatch: ${parsed?.rows?.length ?? "missing"} != ${expectedRows}`);
  }
};

const compactPublicOddsHistory = ({
  appDir,
  retentionDays = 14,
  maxRows = 12000,
  nowMs = Date.now(),
} = {}) => {
  const resolvedAppDir = path.resolve(String(appDir || ""));
  if (!appDir) throw new Error("COMPACT_APP_DIR is required");
  assertRealDirectory(resolvedAppDir, "candidate app directory");

  const resolvedRetentionDays = positiveInteger(retentionDays, 14, 1, "COMPACT_RETENTION_DAYS");
  const resolvedMaxRows = positiveInteger(maxRows, 12000, 1000, "COMPACT_MAX_ROWS");
  if (!Number.isFinite(nowMs)) throw new Error("compaction clock is invalid");

  const files = [
    path.join(resolvedAppDir, "public", "data", "odds-history.json"),
    path.join(resolvedAppDir, "public", "odds-history.json"),
  ];
  const source = files.find((filePath) => fs.existsSync(filePath));
  if (!source) throw new Error("candidate odds history input is missing");

  const payload = readOddsPayload(source);
  const cutoff = nowMs - resolvedRetentionDays * 24 * 60 * 60 * 1000;
  const observedRows = payload.rows.map((row, index) => {
    const observedAt = rowObservationTime(row);
    if (!Number.isFinite(observedAt)) {
      throw new Error(`odds history row ${index} has no valid observation time`);
    }
    return { row, observedAt };
  });
  const kept = observedRows
    .filter(({ observedAt }) => observedAt >= cutoff)
    .map(({ row }) => row)
    .slice(-resolvedMaxRows);
  const compact = {
    ...payload,
    retentionDays: resolvedRetentionDays,
    maxRows: resolvedMaxRows,
    compactedAt: new Date(nowMs).toISOString(),
    rows: kept,
  };
  const body = JSON.stringify(compact, null, 2) + "\n";
  const bodyBytes = Buffer.byteLength(body);
  const bodySha256 = sha256(body);
  verifySerializedPayload(body, kept.length, "compacted odds history");
  if (kept.length > 0 && bodyBytes <= 2) {
    throw new Error("non-empty odds history serialized to an empty payload");
  }

  const staged = [];
  try {
    for (const [index, filePath] of files.entries()) {
      const parent = path.dirname(filePath);
      fs.mkdirSync(parent, { recursive: true });
      assertRealDirectory(parent, "odds history output directory");
      if (fs.existsSync(filePath)) assertRegularFile(filePath, "odds history output");
      const temporary = path.join(parent, `.${path.basename(filePath)}.compact-${process.pid}-${index}`);
      fs.rmSync(temporary, { force: true });
      staged.push({ filePath, temporary });
      fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assertRegularFile(temporary, "staged odds history output");
      const stagedBody = fs.readFileSync(temporary);
      if (stagedBody.length !== bodyBytes || sha256(stagedBody) !== bodySha256) {
        throw new Error(`staged odds history digest mismatch: ${filePath}`);
      }
      verifySerializedPayload(stagedBody.toString("utf8"), kept.length, "staged odds history output");
      const descriptor = fs.openSync(temporary, "r+");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }

    for (const { filePath, temporary } of staged) fs.renameSync(temporary, filePath);
  } finally {
    for (const { temporary } of staged) fs.rmSync(temporary, { force: true });
  }

  const outputs = files.map((filePath) => {
    const info = assertRegularFile(filePath, "installed odds history output");
    const installed = fs.readFileSync(filePath);
    const digest = sha256(installed);
    if (info.size !== bodyBytes || digest !== bodySha256) {
      throw new Error(`installed odds history digest mismatch: ${filePath}`);
    }
    verifySerializedPayload(installed.toString("utf8"), kept.length, "installed odds history output");
    return { file: filePath, bytes: info.size, sha256: digest, rows: kept.length };
  });
  if (new Set(outputs.map((output) => output.sha256)).size !== 1) {
    throw new Error("odds history mirror digests differ after compaction");
  }

  return {
    ok: true,
    version: "public-odds-history-compaction-v2",
    compactedOddsHistory: true,
    source,
    beforeRows: payload.rows.length,
    keptRows: kept.length,
    retentionDays: resolvedRetentionDays,
    maxRows: resolvedMaxRows,
    bytes: bodyBytes,
    sha256: bodySha256,
    mirrorDigestsMatch: true,
    outputs,
  };
};

if (require.main === module) {
  try {
    const result = compactPublicOddsHistory({
      appDir: process.env.COMPACT_APP_DIR,
      retentionDays: process.env.COMPACT_RETENTION_DAYS || 14,
      maxRows: process.env.COMPACT_MAX_ROWS || 12000,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  compactPublicOddsHistory,
  rowObservationTime,
};
