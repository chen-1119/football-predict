"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const { mirrorPostgresCandidate, assertMirrorSourceCatalog } = require("./postgresReleaseMirror.cjs");

async function runFixture() {
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/q2_evidence_native_[a-f0-9]+$/);
  const source = new Pool({ connectionString: url.href, ssl: false, max: 1 });
  const name = `football_release_${crypto.randomBytes(6).toString("hex")}_${Math.floor(Date.now() / 1000)}`;
  const parentId = "01234567-89ab-4cde-8f01-23456789abcd";
  const childId = "abcdef01-2345-4678-9abc-def012345678";
  const schema = `CREATE SCHEMA football;
    CREATE TABLE football.publications(publication_id text PRIMARY KEY,state text NOT NULL);
    CREATE TABLE football.prediction_snapshots(id text PRIMARY KEY,payload json);
    CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text);
    CREATE TABLE football.uuid_parent(id uuid PRIMARY KEY,label text NOT NULL);
    CREATE TABLE football.uuid_child(id uuid PRIMARY KEY,parent_id uuid NOT NULL REFERENCES football.uuid_parent(id),label text NOT NULL);
    CREATE FUNCTION football.reject_candidate_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_database() LIKE 'football_release_%' THEN RAISE EXCEPTION 'candidate user trigger fired'; END IF;
      RETURN COALESCE(NEW,OLD); END $$;
    CREATE TRIGGER parent_immutable BEFORE UPDATE OR DELETE ON football.uuid_parent
      FOR EACH ROW EXECUTE FUNCTION football.reject_candidate_trigger();
    CREATE TRIGGER meta_wake AFTER INSERT OR UPDATE ON football.projection_meta
      FOR EACH ROW EXECUTE FUNCTION football.reject_candidate_trigger();
    CREATE CONSTRAINT TRIGGER child_deadline AFTER INSERT ON football.uuid_child
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football.reject_candidate_trigger();`;
  let candidate, created = false;
  try {
    await source.query(schema);
    await source.query(`CREATE DATABASE "${name}"`);
    created = true;
    const candidateUrl = new URL(url);
    candidateUrl.pathname = `/${name}`;
    candidate = new Pool({ connectionString: candidateUrl.href, ssl: false, max: 1 });
    await candidate.query(schema);
    await source.query("INSERT INTO football.uuid_parent VALUES($1,'source parent')", [parentId]);
    await source.query("INSERT INTO football.uuid_child VALUES($1,$2,'source child')", [childId, parentId]);
    await source.query("INSERT INTO football.projection_meta VALUES('generation','fixture')");
    const key = crypto.randomBytes(32);
    const run = async () => {
      const client = await source.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return await mirrorPostgresCandidate({ sourceSession: { client, pool: source, identity: { generationId: "uuid-fixture" } },
          candidatePool: candidate, key, expectedSourceDatabase: url.pathname.slice(1) });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const read = (pool, table) => pool.query(`SELECT * FROM football.${table}`).then(result => result.rows);
    const preflight = await (async () => { const client = await source.connect(); try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return await assertMirrorSourceCatalog(client);
    } finally { await client.query("ROLLBACK"); client.release(); } })();
    assert.equal(preflight.userTriggers, 3);
    const first = await run();
    assert.equal(first.ok, true);
    assert.equal(first.copiedRows, 3);
    for (const table of ["uuid_parent", "uuid_child"])
      assert.deepEqual(await read(candidate, table), await read(source, table));
    const triggerState = async pool => (await pool.query(`SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='football' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
    assert.deepEqual(await triggerState(candidate), await triggerState(source));
    assert.ok((await triggerState(candidate)).every(row => row.tgenabled === "O"));
    await assert.rejects(candidate.query("UPDATE football.uuid_parent SET label='blocked' WHERE id=$1", [parentId]), /candidate user trigger fired/);
    const warm = await run();
    assert.equal(warm.mode, "incremental");
    assert.equal(warm.copiedRows, 0);
    const tamper = await candidate.connect();
    try {
      await tamper.query("BEGIN");
      await tamper.query("ALTER TABLE football.uuid_parent DISABLE TRIGGER USER");
      await tamper.query("UPDATE football.uuid_parent SET label='candidate changed' WHERE id=$1", [parentId]);
      await tamper.query("UPDATE football.uuid_child SET label='candidate changed' WHERE id=$1", [childId]);
      await tamper.query("ALTER TABLE football.uuid_parent ENABLE TRIGGER USER");
      await tamper.query("COMMIT");
    } catch (error) { await tamper.query("ROLLBACK"); throw error; }
    finally { tamper.release(); }
    const repaired = await run();
    assert.equal(repaired.copiedRows, 2);
    for (const table of ["uuid_parent", "uuid_child"])
      assert.deepEqual(await read(candidate, table), await read(source, table));

    // The allowlist must remain closed: supporting UUID must not permit other
    // native types without an explicit copy-and-compare contract.
    const unsupported = "CREATE TABLE football.unsupported_duration(id text PRIMARY KEY,duration interval NOT NULL)";
    await source.query(unsupported);
    await candidate.query(unsupported);
    await assert.rejects(run(), /unsupported mirror column type: interval/);
    await assert.rejects((async () => { const client = await source.connect(); try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return await assertMirrorSourceCatalog(client);
    } finally { await client.query("ROLLBACK"); client.release(); } })(), /unsupported mirror column type: interval/);
    assert.deepEqual(await read(candidate, "uuid_child"), await read(source, "uuid_child"));
    assert.deepEqual(await triggerState(candidate), await triggerState(source));
    console.log(JSON.stringify({ ok: true, verifier: "postgres-mirror-uuid-trigger-and-type-allowlist", copiedRows: first.copiedRows,
      repairedRows: repaired.copiedRows, warmCopiedRows: warm.copiedRows, userTriggers: preflight.userTriggers,
      unsupportedTypeRejectedBeforeBackup: true, productionWrites: 0 }));
  } finally {
    if (candidate) await candidate.end();
    if (created) await source.query(`DROP DATABASE "${name}"`);
    await source.end();
  }
}

async function runDisposablePostgres(binPath) {
  if (process.platform !== "win32" || !binPath) throw Error("Supply a PostgreSQL 16 bin directory on Windows");
  const bin = fs.realpathSync(binPath);
  for (const name of ["initdb", "pg_ctl", "postgres", "createdb"])
    if (!fs.statSync(path.join(bin, `${name}.exe`)).isFile()) throw Error(`Missing ${name}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-mirror-uuid-"));
  const data = path.join(temp, "data"), passwordFile = path.join(temp, "password.txt");
  const password = crypto.randomBytes(32).toString("hex");
  const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" };
  const command = (name, args, timeout = 60000) => {
    const result = spawnSync(path.join(bin, `${name}.exe`), args, { env, encoding: "utf8", windowsHide: true, timeout });
    if (result.status !== 0) throw Error(`${name} failed: ${(result.error?.message || result.stderr || result.stdout || result.status).toString().replaceAll(password, "[redacted]").slice(-1200)}`);
    return result.stdout.trim();
  };
  let startAttempted = false;
  try {
    assert.match(command("postgres", ["--version"]), /PostgreSQL\) 16\./);
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
    command("initdb", ["-D", data, "-U", "q2_test", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]);
    fs.unlinkSync(passwordFile);
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const chosen = server.address().port; server.close(error => error ? reject(error) : resolve(chosen)); });
    });
    startAttempted = true;
    command("pg_ctl", ["-D", data, "-l", path.join(temp, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -c max_connections=15 -c shared_buffers=32MB`, "-w", "-t", "30", "start"]);
    const database = `q2_evidence_native_${crypto.randomBytes(5).toString("hex")}`;
    command("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "q2_test", database]);
    const result = spawnSync(process.execPath, [__filename], {
      env: { ...env, EVIDENCE_TEST_POSTGRES_URL: `postgresql://q2_test:${password}@127.0.0.1:${port}/${database}` },
      encoding: "utf8", windowsHide: true, timeout: 120000,
    });
    if (result.status !== 0) throw Error(`UUID mirror fixture failed: ${(result.error?.message || result.stderr || result.stdout || result.status).toString().replaceAll(password, "[redacted]").slice(-1600)}`);
    console.log(result.stdout.trim());
  } finally {
    if (startAttempted) {
      const status = spawnSync(path.join(bin, "pg_ctl.exe"), ["-D", data, "status"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (status.status === 0) command("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      else if (status.status !== 3) throw Error(`Cannot prove test database stopped; retained ${temp}`);
      const stopped = spawnSync(path.join(bin, "pg_ctl.exe"), ["-D", data, "status"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (stopped.status !== 3) throw Error(`Test database stop not verified; retained ${temp}`);
    }
    const resolved = fs.realpathSync(temp);
    if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase()
      || !path.basename(resolved).startsWith("football-mirror-uuid-")) throw Error("Unsafe QA cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

(process.env.EVIDENCE_TEST_POSTGRES_URL ? runFixture() : runDisposablePostgres(process.argv[2]))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
