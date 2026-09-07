"use strict";
// Optional Windows QA harness. Supply already-downloaded official PostgreSQL
// binaries; this script installs no service and never accepts an existing DB.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const root = path.resolve(__dirname, "..");
async function main() {
  if (process.platform !== "win32" || !process.argv[2]) throw new Error("Supply a PostgreSQL 16 bin directory on Windows");
  const bin = fs.realpathSync(path.resolve(process.argv[2]));
  for (const name of ["initdb", "pg_ctl", "postgres", "createdb"]) if (!fs.statSync(path.join(bin, `${name}.exe`)).isFile()) throw new Error(`Missing ${name}`);
  const password = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" };
  const run = (name, args, timeout = 60000) => {
    const r = spawnSync(path.join(bin, `${name}.exe`), args, { env, encoding: "utf8", windowsHide: true, timeout });
    if (r.status !== 0) throw new Error(`${name} failed: ${(r.error?.message || r.stderr || r.stdout || r.status).toString().replaceAll(password, "[redacted]").slice(-1800)}`);
    return r.stdout.trim();
  };
  const version = run("postgres", ["--version"]);
  if (!/PostgreSQL\) 16\./.test(version)) throw new Error("QA requires PostgreSQL major version 16");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-pg-"));
  const data = path.join(temp, "data"), passwordFile = path.join(temp, "password.txt");
  const report = { ok: false, version, scope: "disposable native Windows PostgreSQL; not production", cleanup: false };
  let startAttempted = false, pool;
  try {
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
    run("initdb", ["-D", data, "-U", "q2_test", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]);
    fs.unlinkSync(passwordFile);
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const chosen = server.address().port; server.close(error => error ? reject(error) : resolve(chosen)); });
    });
    startAttempted = true;
    run("pg_ctl", ["-D", data, "-l", path.join(temp, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c max_connections=20 -c shared_buffers=32MB`, "-w", "-t", "30", "start"]);
    const database = `q2_evidence_native_${crypto.randomBytes(5).toString("hex")}`;
    run("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "q2_test", database]);
    const connectionString = `postgresql://q2_test:${password}@127.0.0.1:${port}/${database}`;
    pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 5000, max: 1 });
    const result = await pool.query("SELECT version() AS version, current_setting('data_directory') AS directory, current_setting('listen_addresses') AS listen, host(inet_server_addr()) AS address");
    if (path.resolve(result.rows[0].directory).toLowerCase() !== path.resolve(data).toLowerCase()
      || result.rows[0].listen !== "127.0.0.1" || result.rows[0].address !== "127.0.0.1") throw new Error(`Local database identity mismatch: ${JSON.stringify({ actual: result.rows[0], expectedDirectory: data })}`);
    report.server = { version: result.rows[0].version, address: result.rows[0].address, port, isolatedDirectoryVerified: true };
    await pool.end(); pool = null;
    const test = spawnSync(process.execPath, [path.join(__dirname, "verifyPredictionEvidenceRoundtrip.cjs")], {
      cwd: root, env: { ...env, EVIDENCE_TEST_POSTGRES_URL: connectionString }, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    if (test.status !== 0) throw new Error(`Evidence verification failed: ${(test.stderr || test.stdout || test.error?.message || test.status).toString().replaceAll(password, "[redacted]").slice(-2500)}`);
    report.verification = JSON.parse(test.stdout); report.ok = report.verification.ok === true;
  } finally {
    if (pool) await pool.end();
    if (startAttempted) {
      const status = spawnSync(path.join(bin, "pg_ctl.exe"), ["-D", data, "status"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (status.status === 0) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      else if (status.status !== 3) throw new Error(`Cannot prove test database stopped; retained ${temp}`);
      const stopped = spawnSync(path.join(bin, "pg_ctl.exe"), ["-D", data, "status"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (stopped.status !== 3) throw new Error(`Test database stop not verified; retained ${temp}`);
    }
    const resolved = fs.realpathSync(temp);
    if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase()
      || !path.basename(resolved).startsWith("football-native-pg-")) throw new Error("Unsafe QA cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true }); report.cleanup = true;
  }
  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(root, "outputs/q1-native-postgres-evidence-result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
