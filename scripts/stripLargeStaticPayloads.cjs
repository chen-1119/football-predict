const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertStaticDistDataPolicy,
  inspectStaticDistData
} = require("./staticDistDataPolicy.cjs");

const rootDir = path.resolve(__dirname, "..");
const defaultDistDir = path.join(rootDir, "dist");

const disabledRootPayloads = [
  "matches.json",
  "odds-history.json"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const removeFile = (distDir, relativePath, removed) => {
  const filePath = path.join(distDir, relativePath);
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  fs.rmSync(filePath, { force: true });
  removed.push({ path: relativePath.replace(/\\/g, "/"), bytes: stat.size });
};

const stripOnce = (distDir, removed) => {
  for (const relativePath of disabledRootPayloads) {
    removeFile(distDir, relativePath, removed);
  }

  const policy = inspectStaticDistData(distDir);
  for (const relativePath of policy.unapproved) {
    removeFile(distDir, relativePath, removed);
  }
};

const run = async ({
  distDir = defaultDistDir,
  settleMs = Number(process.env.STATIC_DIST_STRIP_SETTLE_MS ?? 15_000)
} = {}) => {
  const resolvedDistDir = path.resolve(distDir);
  const safeSettleMs = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 15_000;
  const removed = [];

  // Vite's public-dir copy can lag after closeBundle on Windows when very large
  // JSON files are involved. Keep scanning for a fixed window so late copies
  // cannot reintroduce protected snapshots after the build script exits.
  const startedAt = Date.now();
  while (Date.now() - startedAt < safeSettleMs) {
    stripOnce(resolvedDistDir, removed);
    await sleep(500);
  }

  stripOnce(resolvedDistDir, removed);
  const policy = assertStaticDistDataPolicy(resolvedDistDir);

  const result = {
    ok: true,
    distDir: resolvedDistDir,
    allowed: policy.allowed,
    removedCount: removed.length,
    removed
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
};

const writeFixture = (distDir, relativePath, payload) => {
  const filePath = path.join(distDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

const runSelfTest = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-static-dist-strip-"));
  try {
    writeFixture(tempDir, "matches.json", [{ private: true }]);
    writeFixture(tempDir, "data/runtime-config.json", { dataApiBase: "/api/v1" });
    writeFixture(tempDir, "data/model-evaluation.json", { private: true });
    writeFixture(tempDir, "data/nested/recommendations.json", { private: true });
    writeFixture(tempDir, "data/external-signals.json.tmp-test", { private: true });

    const result = await run({ distDir: tempDir, settleMs: 0 });
    if (
      result.removedCount !== 4
      || !fs.existsSync(path.join(tempDir, "data", "runtime-config.json"))
      || fs.existsSync(path.join(tempDir, "matches.json"))
      || inspectStaticDistData(tempDir).unapproved.length > 0
    ) {
      throw new Error("Static dist stripping self-test failed");
    }
    console.log(JSON.stringify({ ok: true, selfTest: true }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const main = process.argv.includes("--self-test")
  ? runSelfTest
  : () => run({
    distDir: path.resolve(process.env.STATIC_DIST_DIR || defaultDistDir)
  });

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error?.code || "STATIC_DIST_STRIP_FAILED",
    message: error?.message || String(error),
    ...(error?.result || {})
  }, null, 2));
  process.exit(1);
});
