"use strict";
const fs = require("node:fs");
const path = require("node:path");

// One policy for the status, online and offline entrypoints. QA receipts are
// root-only exclusions; a source directory called outputs is still source.
const ignoredDirectories = new Set([
  ".git", ".codex", ".agents", ".codex-tmp", "node_modules", "dist",
  "server-data", "logs", "coverage", ".vite",
]);
const generatedDataPatterns = [
  /^public\/data\/[^/]+\.json$/,
  /^public\/matches\.json$/,
  /^public\/odds-history\.json$/,
];

function collectFilesNewerThan(root, cutoffMs, { includeGeneratedData = false } = {}) {
  if (!Number.isFinite(cutoffMs)) throw new TypeError("release freshness cutoff must be finite");
  const rows = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
      const firstSegment = relativePath.split("/")[0];
      if (entry.isDirectory()) {
        if (relativePath === "outputs" || ignoredDirectories.has(entry.name)
          || ignoredDirectories.has(firstSegment)) continue;
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".log")) continue;
      // Runtime settings change behavior: never treat them as sync output.
      if (!includeGeneratedData && relativePath !== "public/data/runtime-config.json"
        && generatedDataPatterns.some(pattern => pattern.test(relativePath))) continue;
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > cutoffMs + 1000) {
        rows.push({ path: relativePath, mtime: new Date(stat.mtimeMs).toISOString() });
      }
    }
  }
  visit(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// BSD tar also applies --exclude=./outputs to nested basename matches. Select
// roots explicitly instead of relying on platform-dependent exclude anchoring.
function listReleaseRootEntries(root) {
  return fs.readdirSync(root).filter(name => name !== "outputs").sort().map(name => `./${name}`);
}

module.exports = { collectFilesNewerThan, listReleaseRootEntries };
