const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultEnvPath = path.join(rootDir, ".codex-tmp", "sporttery-relay.env");

const args = process.argv.slice(2);

const optionValue = (name) => {
  const exact = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(exact));
  if (inline) return inline.slice(exact.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};

const hasFlag = (name) => args.includes(`--${name}`);

const envPath = path.resolve(optionValue("relay-env") || optionValue("env-file") || defaultEnvPath);
const requestedProxy = optionValue("proxy") || process.env.SPORTTERY_OUTBOUND_PROXY || "";
const clearProxy = hasFlag("clear");
const verify = hasFlag("verify");

const maskProxy = (value) => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return String(value).replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
};

const readEnvLines = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
};

const envFromLines = (lines) => {
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [name, ...rest] = trimmed.split("=");
    const key = name.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = rest.join("=").trim();
  }
  return env;
};

const validateProxy = (value) => {
  const proxy = String(value || "").trim();
  if (!proxy) return { ok: false, reason: "missing-proxy" };
  let parsed;
  try {
    parsed = new URL(proxy);
  } catch (error) {
    return { ok: false, reason: "invalid-url", error: error.message || String(error) };
  }
  const allowed = new Set(["http:", "https:", "socks5:", "socks5h:"]);
  if (!allowed.has(parsed.protocol)) {
    return {
      ok: false,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
      allowed: Array.from(allowed).map((item) => item.replace(/:$/, ""))
    };
  }
  if (!parsed.hostname || !parsed.port) {
    return { ok: false, reason: "missing-host-or-port" };
  }
  return {
    ok: true,
    protocol: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    port: parsed.port,
    hasCredentials: Boolean(parsed.username || parsed.password)
  };
};

const setEnvValue = (lines, key, value) => {
  const next = [...lines];
  const index = next.findIndex((line) => line.trim().startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (index >= 0) next[index] = entry;
  else {
    if (next.length && next[next.length - 1].trim()) next.push("");
    next.push(entry);
  }
  return next;
};

const writeEnvFile = (filePath, lines) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = `${lines.join("\n").replace(/\n*$/, "")}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is best effort on Windows.
  }
};

const runProxyVerify = () => {
  const result = spawnSync(process.execPath, ["scripts/verifySportteryRelayProxy.cjs"], {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8",
    windowsHide: true
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout || "{}");
  } catch {
    body = null;
  }
  return {
    ok: result.status === 0 && body?.ok === true,
    exitStatus: result.status,
    body,
    stderr: result.status === 0 ? undefined : String(result.stderr || "").slice(-800)
  };
};

const lines = readEnvLines(envPath);
const currentEnv = envFromLines(lines);
const currentProxy = String(currentEnv.SPORTTERY_OUTBOUND_PROXY || currentEnv.SPORTTERY_HTTP_PROXY || "").trim();

if (!requestedProxy && !clearProxy) {
  const payload = {
    ok: Boolean(currentProxy),
    status: currentProxy ? "configured" : "missing-proxy",
    checkedAt: new Date().toISOString(),
    envFile: path.relative(rootDir, envPath).replace(/\\/g, "/"),
    envFileExists: fs.existsSync(envPath),
    proxyConfigured: Boolean(currentProxy),
    proxy: maskProxy(currentProxy),
    guidance: currentProxy ? [
      "Run npm run verify:sporttery-relay-proxy to test this proxy against Sporttery."
    ] : [
      "Run npm run configure:sporttery-proxy -- --proxy=http://user:password@host:port --verify",
      "Use a stable authenticated mainland egress; do not use public/free proxies for production."
    ]
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

let nextLines = lines;
let validation = null;

if (clearProxy) {
  nextLines = setEnvValue(nextLines, "SPORTTERY_OUTBOUND_PROXY", "");
} else {
  validation = validateProxy(requestedProxy);
  if (!validation.ok) {
    console.log(JSON.stringify({
      ok: false,
      status: validation.reason,
      checkedAt: new Date().toISOString(),
      envFile: path.relative(rootDir, envPath).replace(/\\/g, "/"),
      proxy: maskProxy(requestedProxy),
      validation
    }, null, 2));
    process.exit(1);
  }
  nextLines = setEnvValue(nextLines, "SPORTTERY_OUTBOUND_PROXY", String(requestedProxy).trim());
}

writeEnvFile(envPath, nextLines);

const verifyResult = verify && !clearProxy ? runProxyVerify() : null;
const payload = {
  ok: clearProxy ? true : (!verify || verifyResult?.ok === true),
  status: clearProxy
    ? "cleared"
    : verify
      ? (verifyResult?.ok ? "verified" : "configured-but-blocked")
      : "configured",
  checkedAt: new Date().toISOString(),
  envFile: path.relative(rootDir, envPath).replace(/\\/g, "/"),
  proxyConfigured: !clearProxy,
  proxy: clearProxy ? null : maskProxy(requestedProxy),
  validation,
  verify: verifyResult
};

console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exitCode = 1;
