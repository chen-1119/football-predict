"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const helperPath = path.join(rootDir, "deploy", "light-server", "football-access-code-qa.cjs");
const sudoersPath = path.join(rootDir, "deploy", "light-server", "football-automation.sudoers");
const releasePath = path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-qa-access-"));
const envPath = path.join(tempRoot, "env");
const token = `qa-test-${crypto.randomBytes(16).toString("hex")}`;
const createdId = crypto.randomUUID();
const requests = [];
fs.writeFileSync(envPath, `ACCESS_CODE_ADMIN_TOKEN=${token}\n`, { mode: 0o600 });

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    } else if (request.method === "POST" && request.url === "/api/admin/access-codes") {
      response.end(JSON.stringify({ ok: true, id: createdId, code: "ABCD-EFGH-JKLM", ttlSeconds: 900 }));
    } else if (request.method === "GET" && request.url === "/api/admin/access-codes") {
      response.end(JSON.stringify({ ok: true, rows: [
        { id: createdId, label: "codex-qa-browser", status: "active" },
        { id: crypto.randomUUID(), label: "customer", status: "active" },
      ] }));
    } else if (request.method === "POST" && request.url === `/api/admin/access-codes/${createdId}/revoke`) {
      response.end(JSON.stringify({ ok: true, row: { id: createdId, status: "revoked" } }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: "not found" }));
    }
  });
});

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [helperPath, ...args], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FOOTBALL_QA_ACCESS_TEST_MODE: "1",
      FOOTBALL_QA_ACCESS_ENV_PATH: envPath,
      FOOTBALL_QA_ACCESS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

server.listen(0, "127.0.0.1", async () => {
  try {
    const create = await run(["create", "codex-qa-browser"]);
    assert.equal(create.status, 0, create.stderr);
    assert.equal(JSON.parse(create.stdout).ttlSeconds, 900);
    assert.equal(requests[0].body.ttlSeconds, 900);

    const list = await run(["list"]);
    assert.equal(list.status, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].label, "codex-qa-browser");

    const revoke = await run(["revoke", createdId]);
    assert.equal(revoke.status, 0, revoke.stderr);
    assert.equal(JSON.parse(revoke.stdout).row.status, "revoked");

    const invalid = await run(["create", "customer-code"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /label is invalid/);

    const sudoers = fs.readFileSync(sudoersPath, "utf8");
    const release = fs.readFileSync(releasePath, "utf8");
    assert.match(sudoers, /FOOTBALL_QA_ACCESS/);
    assert.match(sudoers, /\^create\[\[:space:\]\]codex-qa-/);
    assert.match(sudoers, /\^revoke\[\[:space:\]\]\[0-9a-f-\]\{36\}\$/);
    assert.match(sudoers, /NOPASSWD: NOSETENV: FOOTBALL_RELEASE, FOOTBALL_RELAY, FOOTBALL_QA_ACCESS/);
    assert.match(release, /install_fixed_qa_access_operator/);
    assert.match(release, /visudo -cf/);
    assert.match(release, /football-access-code-qa\.cjs/);

    process.stdout.write(`${JSON.stringify({ ok: true, verifier: "qa-access-operator", checks: 13 }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
