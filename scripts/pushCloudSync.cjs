const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const lockFile = path.join(tmpDir, "cloud-sync.lock");
const archiveFile = path.join(tmpDir, "football-cloud-data.tgz");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cloudHost = process.env.FOOTBALL_CLOUD_HOST || "170.106.75.73";
const cloudUser = process.env.FOOTBALL_CLOUD_USER || "ubuntu";
const cloudDir = process.env.FOOTBALL_CLOUD_DIR || "/opt/football-predict";
const keyPath = path.resolve(rootDir, process.env.FOOTBALL_CLOUD_KEY || ".codex-tmp/football.pem");
const remoteArchive = process.env.FOOTBALL_CLOUD_REMOTE_ARCHIVE || "/tmp/football-cloud-data.tgz";
const remoteExtractDir = process.env.FOOTBALL_CLOUD_REMOTE_EXTRACT_DIR || "/tmp/football-cloud-data-extract";
const supplementalSync = process.env.FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC !== "0";
const localSupplementalSync = process.env.FOOTBALL_LOCAL_SUPPLEMENTAL_SYNC !== "0";
const weatherSync = process.env.FOOTBALL_ENABLE_WEATHER_SYNC !== "0";
const apiFootballSync = process.env.FOOTBALL_ENABLE_API_FOOTBALL_SYNC === "1";
const restartService = process.env.FOOTBALL_REMOTE_RESTART === "1";
const staleLockMinutes = Math.max(5, Number(process.env.FOOTBALL_CLOUD_STALE_LOCK_MINUTES || 20));

function log(message) {
  const stamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log(`[cloud-sync] ${stamp} ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${args.join(" ")}`);
    const useShell = options.shell !== undefined
      ? options.shell
      : (process.platform === "win32" && /\.cmd$/i.test(command));
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env || {}) },
      shell: useShell,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

function ensureNoActiveLock() {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (!fs.existsSync(lockFile)) {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return;
  }

  const stat = fs.statSync(lockFile);
  const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
  if (ageMinutes > staleLockMinutes) {
    log(`发现过期锁 ${ageMinutes.toFixed(1)} 分钟，已清理`);
    fs.rmSync(lockFile, { force: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return;
  }

  throw new Error("上一轮云端推送仍在运行，跳过本轮");
}

function releaseLock() {
  fs.rmSync(lockFile, { force: true });
}

function mirrorPublicDataToDist() {
  const publicDataDir = path.join(rootDir, "public", "data");
  const distDir = path.join(rootDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const distDataDir = path.join(distDir, "data");
  fs.rmSync(distDataDir, { recursive: true, force: true });
  fs.cpSync(publicDataDir, distDataDir, { recursive: true });

  for (const fileName of ["matches.json", "odds-history.json"]) {
    const source = path.join(rootDir, "public", fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(distDir, fileName));
    }
  }
}

function remoteCommand() {
  const syncBlock = supplementalSync
    ? [
        "set +u",
        `[ -r ${cloudDir}/deploy/light-server/env ] && set -a && . ${cloudDir}/deploy/light-server/env && set +a || true`,
        "set -u",
        "npm run sync:500 || echo '[cloud-sync] sync:500 skipped/failed'",
        "npm run sync:500:details || echo '[cloud-sync] sync:500:details skipped/failed'",
        weatherSync
          ? "npm run sync:weather || echo '[cloud-sync] sync:weather skipped/failed'"
          : "echo '[cloud-sync] weather disabled'",
        apiFootballSync
          ? "ENABLE_API_FOOTBALL_SYNC=1 npm run sync:api-football || echo '[cloud-sync] sync:api-football skipped/failed'"
          : "echo '[cloud-sync] api-football disabled by default'",
        "SKIP_SPORTTERY_FETCH=1 node scripts/syncData.cjs",
        "npm run validate:data",
        "npm run validate:sources",
      ]
    : [
        "npm run validate:data",
      ];

  return [
    "set -euo pipefail",
    `cd ${cloudDir}`,
    `rm -rf ${remoteExtractDir}`,
    `mkdir -p ${remoteExtractDir}`,
    `tar -xzf ${remoteArchive} -C ${remoteExtractDir}`,
    "sudo chmod -R a+rwX public dist || true",
    "mkdir -p public/data dist/data",
    `cp -r ${remoteExtractDir}/public/data/. public/data/`,
    `cp -f ${remoteExtractDir}/public/matches.json public/matches.json`,
    `cp -f ${remoteExtractDir}/public/odds-history.json public/odds-history.json`,
    `cp -r ${remoteExtractDir}/dist/data/. dist/data/`,
    `cp -f ${remoteExtractDir}/dist/matches.json dist/matches.json`,
    `cp -f ${remoteExtractDir}/dist/odds-history.json dist/odds-history.json`,
    "mkdir -p dist/data",
    ...syncBlock,
    "sudo chown -R football:football public/data dist/data public/matches.json public/odds-history.json dist/matches.json dist/odds-history.json || true",
    "sudo chmod -R a+rwX public/data dist/data public/matches.json public/odds-history.json dist/matches.json dist/odds-history.json || true",
    restartService ? "sudo systemctl restart football-predict" : "true",
    "echo '[cloud-sync] remote data refresh complete'",
  ].join("; ");
}

async function main() {
  ensureNoActiveLock();
  try {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH key not found: ${keyPath}`);
    }

    log("开始本地中国竞彩网同步");
    if (localSupplementalSync) {
      await run("node", ["scripts/sync500Data.cjs"]);
      await run("node", ["scripts/sync500Details.cjs"]);
      if (weatherSync) {
        await run("node", ["scripts/syncWeatherData.cjs"]);
      }
      if (apiFootballSync) {
        await run("node", ["scripts/syncApiFootballData.cjs"], {
          env: { ENABLE_API_FOOTBALL_SYNC: "1" },
        });
      }
    }
    await run("node", ["scripts/syncData.cjs"], {
      env: {
        PAGE_POLL_SECONDS: process.env.PAGE_POLL_SECONDS || "20",
        SYNC_WORKFLOW_MINUTES: process.env.SYNC_WORKFLOW_MINUTES || "5",
      },
    });
    await run(npmCommand, ["run", "validate:data"]);
    mirrorPublicDataToDist();

    fs.rmSync(archiveFile, { force: true });
    const archivePathForTar = path.relative(rootDir, archiveFile).replace(/\\/g, "/");
    await run("tar", [
      "-czf",
      archivePathForTar,
      "public/data",
      "public/matches.json",
      "public/odds-history.json",
      "dist/data",
      "dist/matches.json",
      "dist/odds-history.json",
    ]);

    const remote = `${cloudUser}@${cloudHost}`;
    await run("scp", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", archiveFile, `${remote}:${remoteArchive}`]);
    await run("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", remote, remoteCommand()]);

    log("云端数据推送完成");
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(`[cloud-sync] failed: ${error.message || error}`);
  process.exit(1);
});
