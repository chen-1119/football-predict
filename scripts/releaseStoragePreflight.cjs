"use strict";
// Read-only dispatch guard. The v3 release lane copies/seals SQLite and must
// never silently turn it back on after a PostgreSQL-only cutover. This is NOT
// a native release implementation or a switch authorizing data migration.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const SELECTORS = new Set(["FOOTBALL_STORAGE_MODE", "PRIVATE_MODEL_ARTIFACT_STORAGE", "POSTGRES_PROJECTION_SOURCE", "ENABLE_SQLITE_EXPORT"]);
function assertLegacyStorageEnvironment(content) {
  const values = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error("release-storage-environment-grammar-invalid");
    if (!SELECTORS.has(match[1])) continue;
    if (values.has(match[1])) throw new Error("release-storage-selector-duplicated: " + match[1]);
    let value = match[2].trim();
    if (/^["']/.test(value)) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error("release-storage-selector-quote-invalid");
      value = value.slice(1, -1);
    }
    if (!/^[a-z0-9-]*$/i.test(value)) throw new Error("release-storage-selector-value-invalid");
    values.set(match[1], value.trim().toLowerCase());
  }
  const mode = values.get("FOOTBALL_STORAGE_MODE") || "hybrid";
  if (mode !== "hybrid" || values.get("PRIVATE_MODEL_ARTIFACT_STORAGE") === "postgres"
      || values.get("POSTGRES_PROJECTION_SOURCE") === "native-generation" || values.get("ENABLE_SQLITE_EXPORT") === "0") {
    throw new Error("native-release-entrypoint-required: legacy v3 would rebuild SQLite; refused before environment changes or candidate construction");
  }
  return { ok: true, lane: "legacy-hybrid", nativeReleaseImplemented: false, databaseQueries: 0 };
}
function readFixedEnvironment() {
  const file = "/etc/football-predict/env";
  for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("release-storage-environment-parent-unsafe");
    if (directory === path.dirname(directory)) break;
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1
      || (before.mode & 0o022) || before.size > 262144) throw new Error("release-storage-environment-file-unsafe");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
    if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev
        || bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("release-storage-environment-changed");
    return bytes.toString("utf8");
  } finally { fs.closeSync(fd); }
}
module.exports = { assertLegacyStorageEnvironment };
if (require.main === module) {
  try {
    if (process.argv.length !== 2 || process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("fixed-root-release-storage-preflight-required");
    const content = readFixedEnvironment(), policy = path.resolve(__dirname, "../deploy/light-server/native-release-policy.json");
    if (fs.existsSync(policy)) {
      const native = require("./validateNativeReleasePolicy.cjs"), validated = native.readPolicy(policy);
      const marker = (name, optional = false) => { const file = "/opt/football-predict/" + name;
        let st; try { st = fs.lstatSync(file); } catch (error) { if (optional && error.code === "ENOENT") return "-"; throw error; }
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || st.nlink !== 1 || st.size > 128)
          throw new Error("native release runtime marker unsafe");
        return fs.readFileSync(file, "utf8").trim(); };
      const bundleMarker = marker(".release-bundle-sha256"), liveMarker = marker(".release-live-complete", true);
      let serverIndexSha256;
      if (liveMarker === "-") {
        const file = "/opt/football-predict/server/index.cjs", st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || st.nlink !== 1 || st.size > 8 * 1024 * 1024)
          throw new Error("unaccepted runtime entrypoint unsafe");
        serverIndexSha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      }
      const runtime = native.validateNativeRuntimeEnvironment(content, { bundleMarker, liveMarker, serverIndexSha256 });
      console.log(JSON.stringify({ ...validated, ...runtime, databaseQueries: 0 }));
    } else console.log(JSON.stringify(assertLegacyStorageEnvironment(content)));
  } catch (error) { console.error(JSON.stringify({ ok: false, phase: "storage-dispatch", reason: error.message })); process.exitCode = 1; }
}
