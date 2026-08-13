const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ALLOWED_STATIC_DATA_JSON,
  assertStaticDistDataPolicy,
  inspectStaticDistData
} = require("./staticDistDataPolicy.cjs");

const rootDir = path.resolve(__dirname, "..");
const defaultDistDir = path.join(rootDir, "dist");

const writeFixture = (distDir, relativePath, payload) => {
  const filePath = path.join(distDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

const runSelfTest = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-static-dist-policy-"));
  try {
    writeFixture(tempDir, "data/runtime-config.json", { dataApiBase: "/api/v1" });
    writeFixture(tempDir, "data/model-evaluation.json", { private: true });
    writeFixture(tempDir, "data/nested/recommendations.json", { private: true });

    const rejected = inspectStaticDistData(tempDir);
    if (
      rejected.ok
      || rejected.unapproved.length !== 2
      || !rejected.unapproved.includes("data/model-evaluation.json")
      || !rejected.unapproved.includes("data/nested/recommendations.json")
    ) {
      throw new Error("Verifier did not reject the unapproved JSON fixtures");
    }

    fs.rmSync(path.join(tempDir, "data", "model-evaluation.json"), { force: true });
    fs.rmSync(path.join(tempDir, "data", "nested"), { recursive: true, force: true });
    const accepted = assertStaticDistDataPolicy(tempDir);

    console.log(JSON.stringify({
      ok: true,
      selfTest: true,
      allowed: accepted.allowed,
      rejectedUnapproved: rejected.unapproved
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const run = () => {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const distDir = path.resolve(process.env.STATIC_DIST_DIR || defaultDistDir);
  const result = assertStaticDistDataPolicy(distDir);
  console.log(JSON.stringify({
    ok: true,
    distDir: result.distDir,
    allowed: ALLOWED_STATIC_DATA_JSON,
    artifacts: result.artifacts
  }, null, 2));
};

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error?.code || "STATIC_DIST_DATA_VERIFY_FAILED",
    message: error?.message || String(error),
    ...(error?.result || {})
  }, null, 2));
  process.exit(1);
}
