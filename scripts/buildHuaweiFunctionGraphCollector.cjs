const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "deploy", "huawei-functiongraph");
const costPlan = require("./huaweiFunctionGraphCostPolicy.cjs").validateCostPolicy(
  require(path.join(sourceDir, "function-config.json")),
);
const tmpDir = path.join(rootDir, ".codex-tmp");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const stageDir = path.join(tmpDir, `huawei-functiongraph-collector-${stamp}`);
const zipPath = `${stageDir}.zip`;

const required = ["index.js", "index.cjs", "function-config.json", "README.md"];
for (const name of required) {
  if (!fs.statSync(path.join(sourceDir, name)).isFile()) throw new Error(`missing ${name}`);
}
fs.mkdirSync(stageDir, { recursive: false });
for (const name of required) fs.copyFileSync(path.join(sourceDir, name), path.join(stageDir, name));
fs.copyFileSync(
  path.join(rootDir, "cloudflare", "sync-trigger", "src", "sportteryCollector.js"),
  path.join(stageDir, "sportteryCollector.mjs"),
);

const sourceText = fs.readdirSync(stageDir)
  .map((name) => fs.readFileSync(path.join(stageDir, name), "utf8"))
  .join("\n");
for (const forbidden of ["FOOTBALL_PRODUCTION_ADMIN_TOKEN=", "BEGIN PRIVATE KEY-----"]) {
  if (sourceText.includes(forbidden)) throw new Error(`staged function contains forbidden secret material: ${forbidden}`);
}

let result;
if (process.platform === "win32") {
  const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`;
  result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -Path ${quoted(path.join(stageDir, "*"))} -DestinationPath ${quoted(zipPath)} -CompressionLevel Optimal`,
  ], { encoding: "utf8" });
} else {
  result = spawnSync("zip", ["-q", "-j", zipPath, ...fs.readdirSync(stageDir).map((name) => path.join(stageDir, name))], {
    encoding: "utf8",
  });
}
if (result.status !== 0 || !fs.existsSync(zipPath)) {
  throw new Error(`function ZIP failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

console.log(JSON.stringify({
  ok: true,
  stageDir,
  zipPath,
  bytes: fs.statSync(zipPath).size,
  entries: fs.readdirSync(stageDir).sort(),
  costPlan,
}, null, 2));
