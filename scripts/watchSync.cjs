const { spawn } = require("node:child_process");

const intervalMinutes = Math.max(1, Number(process.env.SYNC_WATCH_MINUTES || 5));
const intervalMs = intervalMinutes * 60 * 1000;
let timer = null;
let running = false;
let stopped = false;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const runCommand = (command, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAGE_POLL_SECONDS: process.env.PAGE_POLL_SECONDS || "30",
        SYNC_WORKFLOW_MINUTES: process.env.SYNC_WORKFLOW_MINUTES || String(intervalMinutes)
      },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
};

const runSync = async () => {
  if (running || stopped) return;
  running = true;
  const startedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log(`\n[watch-sync] ${startedAt} 开始同步竞彩足球数据`);

  try {
    await runCommand("node", ["scripts/syncData.cjs"]);
    await runCommand(npmCommand, ["run", "validate:data"]);
    const endedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`[watch-sync] ${endedAt} 同步完成，页面会在 30 秒内自动读到新数据`);
  } catch (error) {
    console.error("[watch-sync] 同步失败，下一轮会继续重试：", error);
  } finally {
    running = false;
    if (!stopped) {
      timer = setTimeout(runSync, intervalMs);
    }
  }
};

const stop = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  console.log("\n[watch-sync] 已停止");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`[watch-sync] 本地自动同步已启动：每 ${intervalMinutes} 分钟执行一次`);
void runSync();
