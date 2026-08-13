const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_STATIC_DATA_JSON = Object.freeze([
  "data/runtime-config.json"
]);

const allowedStaticDataJsonSet = new Set(ALLOWED_STATIC_DATA_JSON);

const normalizeRelativePath = (value) => String(value || "").replace(/\\/g, "/");

const isStaticDataJsonArtifact = (relativePath) => {
  const normalized = normalizeRelativePath(relativePath);
  return /^data\/.+\.json$/i.test(normalized)
    || /^data\/.+\.json\.tmp-[^/]+$/i.test(normalized);
};

const listStaticDataJsonArtifacts = (distDir) => {
  const resolvedDistDir = path.resolve(distDir);
  const dataDir = path.join(resolvedDistDir, "data");
  const artifacts = [];

  if (!fs.existsSync(dataDir)) return artifacts;

  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(resolvedDistDir, entryPath));
      if ((entry.isFile() || entry.isSymbolicLink()) && isStaticDataJsonArtifact(relativePath)) {
        artifacts.push(relativePath);
      }
    }
  };

  visit(dataDir);
  return artifacts.sort();
};

const inspectStaticDistData = (distDir) => {
  const resolvedDistDir = path.resolve(distDir);
  const distExists = fs.existsSync(resolvedDistDir);
  const artifacts = distExists ? listStaticDataJsonArtifacts(resolvedDistDir) : [];
  const unapproved = artifacts.filter((relativePath) => !allowedStaticDataJsonSet.has(relativePath));
  const missingRequired = ALLOWED_STATIC_DATA_JSON.filter(
    (relativePath) => !fs.existsSync(path.join(resolvedDistDir, relativePath))
  );

  return {
    ok: distExists && unapproved.length === 0 && missingRequired.length === 0,
    distDir: resolvedDistDir,
    distExists,
    allowed: [...ALLOWED_STATIC_DATA_JSON],
    artifacts,
    unapproved,
    missingRequired
  };
};

const assertStaticDistDataPolicy = (distDir) => {
  const result = inspectStaticDistData(distDir);
  if (!result.ok) {
    const error = new Error("Static dist data policy violation");
    error.code = "STATIC_DIST_DATA_POLICY_VIOLATION";
    error.result = result;
    throw error;
  }
  return result;
};

module.exports = {
  ALLOWED_STATIC_DATA_JSON,
  assertStaticDistDataPolicy,
  inspectStaticDistData,
  isStaticDataJsonArtifact,
  listStaticDataJsonArtifacts,
  normalizeRelativePath
};
