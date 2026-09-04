const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");

const MAX_PULL_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_LOCAL_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const requiredText = (value, name) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
};

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const validatePullUrl = (value) => {
  const url = new URL(requiredText(value, "SPORTTERY_CLOUDFLARE_EVIDENCE_URL"));
  if (url.protocol !== "https:") throw new Error("Cloudflare evidence URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Cloudflare evidence URL must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/api/sporttery-evidence") {
    throw new Error("Cloudflare evidence URL must target /api/sporttery-evidence");
  }
  return url;
};

const validateLocalUrl = (value) => {
  const url = new URL(value || "http://127.0.0.1:8788/api/admin/sporttery-collector-evidence");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("local evidence upload URL must use loopback HTTP");
  }
  if (url.pathname !== "/api/admin/sporttery-collector-evidence" || url.username || url.password) {
    throw new Error("local evidence upload URL is invalid");
  }
  return url;
};

const fetchJsonBounded = async (url, init, { timeoutMs, maxBytes, label }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`${label} response exceeds ${maxBytes} bytes`);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > maxBytes) throw new Error(`${label} response is too large`);
  let payload = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${String(payload?.error || "request rejected").slice(0, 200)}`);
  }
  return payload;
};

const validateEvidenceEnvelope = (payload) => {
  const evidence = payload?.evidence;
  if (payload?.ok !== true || evidence?.version !== "sporttery-collector-evidence-upload-v1") {
    throw new Error("Cloudflare evidence envelope is invalid");
  }
  if (!Array.isArray(evidence.endpoints) || evidence.endpoints.length < 1 || evidence.endpoints.length > 4) {
    throw new Error("Cloudflare evidence endpoint count is invalid");
  }
  if (!evidence.endpoints.every((endpoint) => (
    endpoint?.ok === true
    && endpoint?.collectorAttestation?.algorithm === "Ed25519"
    && typeof endpoint?.collectorAttestation?.signature === "string"
    && endpoint.collectorAttestation.signature.length >= 80
  ))) {
    throw new Error("Cloudflare evidence contains an unsigned endpoint");
  }
  return evidence;
};

const runTransportCommand = ({ command, args, input = null, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error(`${command} timed out`));
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    if (stdout.length < MAX_LOCAL_RESPONSE_BYTES) stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 256 * 1024) stderr += chunk.toString();
  });
  child.once("error", (error) => finish(error));
  child.once("exit", (code) => {
    if (code !== 0) {
      finish(new Error(`${command} failed ${code}: ${stderr.trim().slice(0, 300)}`));
      return;
    }
    finish(null, { stdout, status: Number(code || 0) });
  });
  child.stdin.end(input === null ? undefined : String(input));
});

const postEvidenceOverSsh = async ({ evidence, adminToken, timeoutMs }) => {
  const host = requiredText(
    process.env.SPORTTERY_RELAY_SSH_HOST || process.env.FOOTBALL_CLOUD_HOST,
    "SPORTTERY_RELAY_SSH_HOST or FOOTBALL_CLOUD_HOST",
  );
  const user = String(process.env.SPORTTERY_RELAY_SSH_USER || "ubuntu").trim();
  const port = String(process.env.SPORTTERY_RELAY_SSH_PORT || "22").trim();
  const keyPath = path.resolve(requiredText(process.env.SPORTTERY_RELAY_SSH_KEY, "SPORTTERY_RELAY_SSH_KEY"));
  const knownHostsPath = path.resolve(requiredText(
    process.env.SPORTTERY_RELAY_SSH_KNOWN_HOSTS,
    "SPORTTERY_RELAY_SSH_KNOWN_HOSTS",
  ));
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) {
    throw new Error("SSH target is invalid");
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error("SSH port is invalid");
  if (!fs.existsSync(keyPath) || !fs.existsSync(knownHostsPath)) throw new Error("SSH identity files are missing");
  const serialized = `${JSON.stringify(evidence)}\n`;
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "");
  const localPath = path.join(rootDir, ".codex-tmp", `${digest}.${stamp}.collector-evidence.json`);
  const remotePath = `/var/lib/football-relay/incoming/${digest}.${stamp}.collector-evidence.json`;
  const target = `${user}@${host}`;
  const common = [
    "-F", "none",
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath.replace(/\\/g, "/")}`,
    "-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  ];
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    await runTransportCommand({
      command: "scp",
      args: [...common, "-C", "-P", port, localPath, `${target}:${remotePath}`],
      timeoutMs,
    });
    const remoteCommand = [
      "set -eu",
      `incoming='${remotePath}'`,
      "trap 'rm -f \"$incoming\"' EXIT",
      "chmod 0600 \"$incoming\"",
      "curl --fail-with-body --silent --show-error --max-time 25 --config - --data-binary \"@$incoming\" 'http://127.0.0.1:8788/api/admin/sporttery-collector-evidence'",
    ].join("; ");
    const curlConfig = [
      'header = "content-type: application/json"',
      `header = "authorization: Bearer ${String(adminToken).replace(/[\r\n"]/g, "")}"`,
      "",
    ].join("\n");
    const result = await runTransportCommand({
      command: "ssh",
      args: [...common, "-p", port, target, remoteCommand],
      input: curlConfig,
      timeoutMs,
    });
    const payload = JSON.parse(result.stdout);
    if (payload?.ok !== true) throw new Error(`server rejected collector evidence: ${payload?.error || "unknown"}`);
    return payload;
  } finally {
    fs.rmSync(localPath, { force: true });
  }
};

const run = async ({ logger = console.log } = {}) => {
  const pullUrl = validatePullUrl(process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL);
  const pullToken = requiredText(process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN, "SPORTTERY_CLOUDFLARE_PULL_TOKEN");
  const adminToken = requiredText(
    process.env.ADMIN_TOKEN
      || process.env.FOOTBALL_CLOUD_ADMIN_TOKEN
      || process.env.ACCESS_CODE_ADMIN_TOKEN,
    "ADMIN_TOKEN, FOOTBALL_CLOUD_ADMIN_TOKEN, or ACCESS_CODE_ADMIN_TOKEN",
  );
  const timeoutMs = positiveInteger(process.env.SPORTTERY_CLOUDFLARE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const pulled = await fetchJsonBounded(pullUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pullToken}`,
      accept: "application/json",
    },
  }, { timeoutMs, maxBytes: MAX_PULL_RESPONSE_BYTES, label: "Cloudflare evidence pull" });
  const evidence = validateEvidenceEnvelope(pulled);
  const uploadTransport = String(process.env.SPORTTERY_CLOUDFLARE_UPLOAD_TRANSPORT || "local-http")
    .trim().toLowerCase();
  const accepted = uploadTransport === "ssh"
    ? await postEvidenceOverSsh({ evidence, adminToken, timeoutMs })
    : await fetchJsonBounded(validateLocalUrl(process.env.SPORTTERY_CLOUDFLARE_LOCAL_UPLOAD_URL), {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(evidence),
      }, { timeoutMs, maxBytes: MAX_LOCAL_RESPONSE_BYTES, label: "local evidence upload" });
  if (accepted?.ok !== true) throw new Error("local evidence upload was not accepted");
  const summary = {
    ok: true,
    transport: uploadTransport,
    pulledAt: new Date().toISOString(),
    capturedAt: evidence.capturedAt || null,
    sourceCycleId: evidence.sourceCycleId || null,
    endpoints: evidence.endpoints.length,
    rows: evidence.endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
    acceptedRows: Number(accepted.acceptedRows || 0),
    storeRows: Number(accepted.storeRows || 0),
    storeRootHash: accepted.storeRootHash || null,
  };
  logger?.(JSON.stringify(summary, null, 2));
  return summary;
};

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error?.message || String(error),
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  fetchJsonBounded,
  postEvidenceOverSsh,
  run,
  validateEvidenceEnvelope,
  validateLocalUrl,
  validatePullUrl,
};
