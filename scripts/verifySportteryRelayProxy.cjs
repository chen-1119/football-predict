const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const logsDir = path.join(rootDir, "logs");
const envFiles = [
  path.join(rootDir, ".codex-tmp", "cloud-sync.env"),
  path.join(rootDir, ".codex-tmp", "sporttery-relay.env")
];
const statusOut = process.env.SPORTTERY_EGRESS_STATUS_OUT
  || path.join(logsDir, "sporttery-egress-proxy-status.json");

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

const readEnvFile = (filePath) => {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [name, ...rest] = trimmed.split("=");
    const key = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = rest.join("=").trim();
  }
  return env;
};

const importedEnv = envFiles.reduce((acc, filePath) => ({
  ...acc,
  ...readEnvFile(filePath)
}), {});

const effectiveEnv = {
  ...process.env,
  ...importedEnv
};
const proxy = String(effectiveEnv.SPORTTERY_OUTBOUND_PROXY || effectiveEnv.SPORTTERY_HTTP_PROXY || "").trim();
const requireProxy = String(effectiveEnv.SPORTTERY_EGRESS_REQUIRE_PROXY || "") === "1";

const basePayload = {
  checkedAt: new Date().toISOString(),
  envFiles: envFiles.map((filePath) => ({
    path: path.relative(rootDir, filePath).replace(/\\/g, "/"),
    exists: fs.existsSync(filePath)
  })),
  proxyConfigured: Boolean(proxy),
  requireProxy,
  proxy: maskProxy(proxy),
  statusOut: path.relative(rootDir, statusOut).replace(/\\/g, "/")
};

if (!proxy) {
  if (!requireProxy) {
    const result = spawnSync(process.execPath, ["scripts/verifySportteryEgress.cjs"], {
      cwd: rootDir,
      env: {
        ...effectiveEnv,
        SPORTTERY_EGRESS_REQUIRE_PROXY: "0",
        SPORTTERY_EGRESS_STATUS_OUT: statusOut
      },
      encoding: "utf8",
      windowsHide: true
    });
    let egress = null;
    try {
      egress = JSON.parse(result.stdout || "{}");
    } catch {
      egress = null;
    }
    const payload = {
      ok: result.status === 0 && egress?.ok === true,
      status: result.status === 0 && egress?.ok === true ? "direct-egress-healthy" : "direct-egress-blocked",
      ...basePayload,
      exitStatus: result.status,
      egress,
      guidance: result.status === 0 ? [] : [
        "Direct Sporttery egress is blocked; configure SPORTTERY_OUTBOUND_PROXY and rerun this verifier."
      ]
    };
    console.log(JSON.stringify(payload, null, 2));
    if (!payload.ok) process.exitCode = 1;
    return;
  }
  const payload = {
    ok: false,
    status: "missing-proxy",
    ...basePayload,
    guidance: [
      "Add SPORTTERY_OUTBOUND_PROXY=socks5h://user:password@host:port to .codex-tmp/sporttery-relay.env.",
      "Then run npm run verify:sporttery-relay-proxy before re-running npm run sync:sporttery-relay-push."
    ]
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(1);
}

fs.mkdirSync(logsDir, { recursive: true });
const result = spawnSync(process.execPath, ["scripts/verifySportteryEgress.cjs"], {
  cwd: rootDir,
  env: {
    ...effectiveEnv,
    SPORTTERY_EGRESS_REQUIRE_PROXY: "1",
    SPORTTERY_EGRESS_STATUS_OUT: statusOut
  },
  encoding: "utf8",
  windowsHide: true
});

let egress = null;
try {
  egress = JSON.parse(result.stdout || "{}");
} catch {
  egress = null;
}

const payload = {
  ok: result.status === 0 && egress?.ok === true,
  status: result.status === 0 && egress?.ok === true ? "healthy" : "blocked",
  ...basePayload,
  exitStatus: result.status,
  egress,
  stderr: result.status === 0 ? undefined : String(result.stderr || "").slice(-800)
};

console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exitCode = 1;
