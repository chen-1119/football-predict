#!/opt/node-v22.22.1/bin/node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const testMode = process.env.FOOTBALL_QA_ACCESS_TEST_MODE === "1"
  && (typeof process.getuid !== "function" || process.getuid() !== 0);
const envPath = testMode
  ? path.resolve(process.env.FOOTBALL_QA_ACCESS_ENV_PATH || "")
  : "/etc/football-predict/env";
const baseUrl = testMode
  ? String(process.env.FOOTBALL_QA_ACCESS_BASE_URL || "")
  : "http://127.0.0.1:8788";
const qaLabelPattern = /^codex-qa-[a-z0-9](?:[a-z0-9-]{0,39})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (message, status = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(status);
};

const parseEnvValue = (raw) => {
  const value = String(raw || "").trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\\"nrt])/g, (_, code) => ({
      "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t",
    })[code]);
  }
  return value.replace(/\s+#.*$/, "").trim();
};

const readRuntimeEnv = () => {
  if (!envPath) fail("QA access runtime env path is missing");
  const stat = fs.lstatSync(envPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("QA access runtime env is unsafe");
  }
  if (!testMode && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
    fail("QA access runtime env ownership or mode is unsafe");
  }
  const values = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = parseEnvValue(match[2]);
  }
  const token = values.ACCESS_CODE_ADMIN_TOKEN || values.ADMIN_TOKEN || "";
  if (!token || /[\r\n\0]/.test(token)) fail("QA access admin token is unavailable or invalid");
  return token;
};

const requestJson = (method, pathname, body, token) => new Promise((resolve, reject) => {
  const target = new URL(pathname, baseUrl);
  if (!testMode && (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port !== "8788")) {
    reject(new Error("QA access target is not the fixed loopback service"));
    return;
  }
  const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
  const request = http.request(target, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(bytes ? { "content-type": "application/json", "content-length": String(bytes.length) } : {}),
    },
    timeout: 10_000,
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(new Error(`QA access service returned invalid JSON (${response.statusCode || 0})`));
        return;
      }
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        reject(new Error(`QA access service rejected request (${response.statusCode || 0}): ${payload?.error || "unknown"}`));
        return;
      }
      resolve(payload);
    });
  });
  request.on("timeout", () => request.destroy(new Error("QA access service timed out")));
  request.on("error", reject);
  if (bytes) request.write(bytes);
  request.end();
});

const main = async () => {
  if (!testMode && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
    fail("football-access-code-qa must run as root through the fixed sudo rule");
  }
  const [command = "", argument = "", extra] = process.argv.slice(2);
  if (extra !== undefined) fail("usage: football-access-code-qa create <codex-qa-label>|list|revoke <uuid>");
  const token = readRuntimeEnv();

  if (command === "create") {
    if (!qaLabelPattern.test(argument)) fail("QA access label is invalid");
    const result = await requestJson("POST", "/api/admin/access-codes", {
      label: argument,
      ttlSeconds: 900,
    }, token);
    if (!result?.id || !result?.code || result?.ttlSeconds !== 900) {
      fail("QA access service returned an incomplete short-lived code");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "list" && !argument) {
    const result = await requestJson("GET", "/api/admin/access-codes", null, token);
    const rows = Array.isArray(result?.rows)
      ? result.rows.filter((row) => String(row?.label || "").startsWith("codex-qa-"))
      : [];
    process.stdout.write(`${JSON.stringify({ ok: true, rows })}\n`);
    return;
  }

  if (command === "revoke") {
    if (!uuidPattern.test(argument)) fail("QA access code id is invalid");
    const result = await requestJson("POST", `/api/admin/access-codes/${encodeURIComponent(argument)}/revoke`, null, token);
    if (result?.ok !== true || result?.row?.status !== "revoked") fail("QA access revoke did not commit");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  fail("usage: football-access-code-qa create <codex-qa-label>|list|revoke <uuid>");
};

main().catch((error) => fail(error?.message || String(error)));
