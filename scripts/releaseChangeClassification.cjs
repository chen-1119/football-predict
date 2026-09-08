"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { verifyPrebuiltDist } = require("./releasePrebuiltDist.cjs");

const INVENTORY_VERSION = "complete-release-tree-v1";
const POLICY_VERSION = "release-change-classification-v1";
const BUILD_VERSION = "release-frontend-build-binding-v1";
const LIMITS = Object.freeze({ entries: 20000, fileBytes: 128 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, depth: 32 });
// Exact reviewed browser modules, not a src/**, public/** or extension wildcard.
// AppContext and all shared services deliberately remain outside this boundary.
const FRONTEND_PATHS = Object.freeze([
  "src/App.tsx", "src/App.css", "src/main.tsx", "src/index.css",
  "src/styles/ai-arena.css", "src/styles/base.css", "src/styles/best-tips.css",
  "src/styles/leagues.css", "src/styles/match-detail.css", "src/styles/predictions-refresh.css",
  "src/styles/predictions.css", "src/styles/recommendation-evidence.css", "src/styles/shell.css", "src/styles/tokens.css",
  "src/pages/AccessCodeAdmin.tsx", "src/pages/AIArena.tsx", "src/pages/Auth.tsx",
  "src/pages/BestTips.tsx", "src/pages/BetSlipGenerator.tsx", "src/pages/BigFiveLeagues.tsx",
  "src/pages/HitAndWin.tsx", "src/pages/MatchDetail.tsx", "src/pages/PredictionsList.tsx", "src/pages/WorldCup.tsx",
  "src/components/ContactDock.tsx", "src/components/Footer.tsx", "src/components/GlossaryModal.tsx",
  "src/components/Navbar.tsx", "src/components/TeamBadge.tsx", "src/components/WorldCupLastDance.tsx",
  "src/components/WorldCupSpotlight.tsx", "src/components/predictions/AIArenaPreview.tsx",
  "src/components/predictions/DataAdoptionDetails.tsx", "src/components/predictions/DateScopeBar.tsx",
  "src/components/predictions/MatchSummaryRow.tsx", "src/components/predictions/PredictionsPageHeader.tsx",
  "src/components/predictions/RecommendationEvidenceFacts.tsx",
  "src/components/review/ReviewEvidenceOverview.tsx", "src/components/review/review.css",
].sort());
const frontendPaths = new Set(FRONTEND_PATHS);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha256(JSON.stringify(value));
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const deepFreeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const POLICY_HASH = digest({ version: POLICY_VERSION, frontendPaths: FRONTEND_PATHS, limits: LIMITS,
  generatedDataPolicy: "never-infer-adoption", artifactPolicy: "authenticated-complete-input-output-build-binding" });

function safeRelative(value) {
  if (typeof value !== "string" || value.length > 1024 || value !== value.normalize("NFC")
    || /[\\:\x00-\x1f\x7f]/.test(value)) throw new Error("unsafe-path");
  const segments = value.split("/");
  if (!value || segments.length > LIMITS.depth || segments.some(part => !part || part === "." || part === ".."
    || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("unsafe-path");
  }
  return value;
}

function plainRoot(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("absolute-root-required");
  const root = path.resolve(input);
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const info = fs.lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("non-plain-root-or-ancestor");
    if (cursor === path.dirname(cursor)) break;
  }
  return root;
}

function stamp(info) {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function scanOnce(root) {
  const entries = [];
  const aliases = new Set();
  let totalBytes = 0;
  function visit(dir, relative = "") {
    const before = fs.lstatSync(dir);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("non-plain-directory");
    for (const name of fs.readdirSync(dir).sort()) {
      const item = safeRelative(relative ? `${relative}/${name}` : name);
      const alias = item.toLowerCase();
      if (aliases.has(alias)) throw new Error("duplicate-or-case-alias");
      aliases.add(alias);
      if (aliases.size > LIMITS.entries) throw new Error("entry-limit");
      const target = path.join(dir, name);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) throw new Error("symlink-entry");
      if (info.isDirectory()) {
        entries.push({ path: item, kind: "directory", mode: info.mode & 0o777 });
        visit(target, item);
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new Error("non-plain-file");
        if (info.size > LIMITS.fileBytes || totalBytes + info.size > LIMITS.totalBytes) throw new Error("byte-limit");
        const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = fs.fstatSync(fd);
          if (stamp(opened) !== stamp(info)) throw new Error("entry-changed-before-read");
          const hash = crypto.createHash("sha256");
          const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, info.size)));
          let byteCount = 0;
          while (byteCount < info.size) {
            const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, info.size - byteCount), byteCount);
            if (!read) throw new Error("entry-changed-during-read");
            hash.update(buffer.subarray(0, read)); byteCount += read;
          }
          if (fs.readSync(fd, buffer, 0, 1, byteCount) !== 0 || stamp(fs.fstatSync(fd)) !== stamp(opened)
            || stamp(fs.lstatSync(target)) !== stamp(opened)) throw new Error("entry-changed-during-read");
          entries.push({ path: item, kind: "file", mode: info.mode & 0o777, bytes: byteCount, sha256: hash.digest("hex") });
          totalBytes += byteCount;
        } finally { fs.closeSync(fd); }
      }
    }
    if (stamp(fs.lstatSync(dir)) !== stamp(before)) throw new Error("directory-changed-during-read");
  }
  visit(root);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const body = { version: INVENTORY_VERSION, entries, entryCount: entries.length,
    fileCount: entries.filter(row => row.kind === "file").length, totalBytes };
  if (!body.fileCount) throw new Error("empty-release-tree");
  return { ...body, treeHash: digest(body) };
}

// No git-list, mtime-only shortcut, generated-data omission or caller excludes.
// The caller must seal both extracted trees against concurrent writes.
function captureReleaseSourceInventory(rootInput) {
  const root = plainRoot(rootInput);
  const first = scanOnce(root);
  const second = scanOnce(root);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("tree-changed-between-scans");
  return deepFreeze(second);
}

function validateInventory(inventory) {
  if (!exactKeys(inventory, ["version", "entries", "entryCount", "fileCount", "totalBytes", "treeHash"])
    || inventory.version !== INVENTORY_VERSION || !Array.isArray(inventory.entries)
    || !hex(inventory.treeHash) || inventory.entries.length > LIMITS.entries) throw new Error("malformed-inventory");
  const seen = new Map();
  const aliases = new Set();
  let prior = "";
  let totalBytes = 0;
  let fileCount = 0;
  for (const row of inventory.entries) {
    if (!row || !["file", "directory"].includes(row.kind)
      || !exactKeys(row, row.kind === "file" ? ["path", "kind", "mode", "bytes", "sha256"] : ["path", "kind", "mode"])) {
      throw new Error("malformed-entry");
    }
    safeRelative(row.path);
    if (row.path <= prior || aliases.has(row.path.toLowerCase())) throw new Error("duplicate-or-unsorted-entry");
    if (!Number.isSafeInteger(row.mode) || row.mode < 0 || row.mode > 0o777) throw new Error("malformed-mode");
    prior = row.path; aliases.add(row.path.toLowerCase()); seen.set(row.path, row);
    const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
    if (parent && seen.get(parent)?.kind !== "directory") throw new Error("missing-parent-directory");
    if (row.kind === "file") {
      if (!hex(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > LIMITS.fileBytes) {
        throw new Error("malformed-file");
      }
      fileCount++; totalBytes += row.bytes;
    }
  }
  const body = { version: INVENTORY_VERSION, entries: inventory.entries, entryCount: inventory.entries.length, fileCount, totalBytes };
  if (!fileCount || totalBytes > LIMITS.totalBytes || inventory.entryCount !== body.entryCount
    || inventory.fileCount !== fileCount || inventory.totalBytes !== totalBytes || inventory.treeHash !== digest(body)) {
    throw new Error("inventory-commitment-mismatch");
  }
  return inventory;
}

function pathCategory(relative) {
  if (frontendPaths.has(relative)) return "frontend-source";
  if (relative === "dist" || relative.startsWith("dist/") || relative === ".release-prebuilt"
    || relative === ".release-prebuilt/dist-manifest.json") return "derived-frontend-artifact";
  if (relative === "public/matches.json" || relative === "public/odds-history.json"
    || relative === "public/data" || relative.startsWith("public/data/")
    || relative === ".release-model-assets" || relative.startsWith(".release-model-assets/")) return "generated-or-model-data";
  if (/^(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|vite\.config\.|tsconfig|eslint|\.npmrc)/.test(relative)) {
    return "dependency-or-build-config";
  }
  if (/^(server|scripts|deploy|src\/(services|context|data))\//.test(relative)) return "runtime-model-database-or-shared";
  return "unknown-or-unreviewed";
}

function partitionHashes(inventory) {
  validateInventory(inventory);
  const source = inventory.entries.filter(row => pathCategory(row.path) !== "derived-frontend-artifact");
  const artifacts = inventory.entries.filter(row => pathCategory(row.path) === "derived-frontend-artifact");
  const dependencies = ["package.json", "package-lock.json", "vite.config.ts", "scripts/stripLargeStaticPayloads.cjs"]
    .map(name => inventory.entries.find(row => row.path === name && row.kind === "file"));
  if (dependencies.some(row => !row)) throw new Error("build-dependency-input-missing");
  if (!artifacts.some(row => row.path === "dist/index.html" && row.kind === "file")
    || !artifacts.some(row => row.path === ".release-prebuilt/dist-manifest.json" && row.kind === "file")) {
    throw new Error("complete-derived-artifact-missing");
  }
  return { sourceTreeHash: digest(source), artifactTreeHash: digest(artifacts), dependencyHash: digest(dependencies) };
}

// This constructs bytes for the trusted builder to sign, NOT evidence that a
// build ran. Call only after success and unchanged input checks; authenticate
// its hash separately in the outer release manifest, never a JSON `ok` flag.
function buildFrontendBinding(inventory, { nodeSha256, nodeVersion, buildEnvironmentHash } = {}) {
  if (!hex(nodeSha256) || !hex(buildEnvironmentHash) || !/^v22\.[0-9]+\.[0-9]+$/.test(nodeVersion || "")) {
    throw new Error("build-runtime-identity-missing");
  }
  return deepFreeze({ version: BUILD_VERSION, ...partitionHashes(inventory), nodeSha256, nodeVersion,
    buildEnvironmentHash, command: "npm run build", exitCode: 0 });
}

function validateBuildBinding(inventory, binding, expectedHash, root) {
  if (!hex(expectedHash) || !exactKeys(binding, ["version", "sourceTreeHash", "artifactTreeHash", "dependencyHash",
    "nodeSha256", "nodeVersion", "buildEnvironmentHash", "command", "exitCode"]) || digest(binding) !== expectedHash
    || binding.version !== BUILD_VERSION || binding.command !== "npm run build" || binding.exitCode !== 0
    || !hex(binding.nodeSha256) || !hex(binding.buildEnvironmentHash) || !/^v22\.[0-9]+\.[0-9]+$/.test(binding.nodeVersion || "")) {
    throw new Error("authenticated-build-binding-required");
  }
  const actual = partitionHashes(inventory);
  for (const key of Object.keys(actual)) if (binding[key] !== actual[key]) throw new Error(`build-${key}-mismatch`);
  if (!verifyPrebuiltDist({ distDir: path.join(root, "dist"),
    manifestPath: path.join(root, ".release-prebuilt/dist-manifest.json") }).ok) throw new Error("derived-dist-manifest-mismatch");
}

function classifyReleaseChanges(options = {}) {
  const blockers = [];
  const changes = [];
  const identities = { baseline: null, candidate: null };
  const inventories = {};
  for (const side of ["baseline", "candidate"]) {
    const input = options[side];
    try {
      if (!input) throw new Error("missing-release-input");
      const identity = input.authenticatedIdentity;
      if (!exactKeys(identity, ["releaseSha256", "inventorySha256", "buildBindingSha256"])
        || !hex(identity.releaseSha256) || !hex(identity.inventorySha256)
        || !(identity.buildBindingSha256 === null || hex(identity.buildBindingSha256))) throw new Error("authenticated-identity-required");
      validateInventory(input.inventory);
      if (input.inventory.treeHash !== identity.inventorySha256) throw new Error("authenticated-inventory-mismatch");
      const actual = captureReleaseSourceInventory(input.root);
      if (JSON.stringify(actual) !== JSON.stringify(input.inventory)) throw new Error("filesystem-inventory-mismatch");
      identities[side] = { ...identity };
      inventories[side] = actual;
    } catch (error) { blockers.push(`${side}:${error.code || error.message}`); }
  }
  if (!blockers.length) {
    const before = new Map(inventories.baseline.entries.map(row => [row.path, row]));
    const after = new Map(inventories.candidate.entries.map(row => [row.path, row]));
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const oldEntry = before.get(name) || null;
      const newEntry = after.get(name) || null;
      if (JSON.stringify(oldEntry) === JSON.stringify(newEntry)) continue;
      let category = pathCategory(name);
      if ((oldEntry && oldEntry.kind !== "file") || (newEntry && newEntry.kind !== "file")) {
        if (category !== "derived-frontend-artifact") category = "directory-or-type-change";
      }
      if (oldEntry && newEntry && oldEntry.mode !== newEntry.mode) category = "permission-change";
      changes.push({ path: name, action: !oldEntry ? "added" : !newEntry ? "removed" : "modified", category,
        before: oldEntry, after: newEntry });
    }
    for (const row of changes) if (!["frontend-source", "derived-frontend-artifact"].includes(row.category)) {
      blockers.push(`full-required:${row.category}:${row.path}`);
    }
    if (changes.some(row => row.category === "derived-frontend-artifact")
      && !changes.some(row => row.category === "frontend-source")) blockers.push("artifact-change-without-frontend-source-change");
    if (changes.length && !blockers.length) {
      for (const side of ["baseline", "candidate"]) {
        try { validateBuildBinding(inventories[side], options[side].buildBinding, identities[side].buildBindingSha256, options[side].root); }
        catch (error) { blockers.push(`${side}:${error.message}`); }
      }
      if (!blockers.length) {
        for (const field of ["nodeSha256", "nodeVersion", "buildEnvironmentHash", "dependencyHash"]) {
          if (options.baseline.buildBinding[field] !== options.candidate.buildBinding[field]) blockers.push(`build-environment-change:${field}`);
        }
      }
    }
  }
  const classification = blockers.length ? "full" : changes.length ? "frontend-only" : "unchanged";
  const body = { version: POLICY_VERSION, policyHash: POLICY_HASH, identities,
    classification, executionMode: "full", fastPathActivated: false, skippedStages: [], changes, blockers,
    activationRequirements: ["authenticated-current-live-baseline-and-sealed-candidate",
      "audited-runtime-entrypoint-and-ui-dependency-boundary", "retained-frontend-semantics-browser-and-live-acceptance",
      "explicit-tested-frontend-only-cutover-implementation"],
    explanation: classification === "frontend-only"
      ? "Only reviewed browser source and authenticated derived artifacts differ; this plan does not skip model, database or runtime checks."
      : classification === "unchanged" ? "Both complete authenticated trees match; this is not deployment no-op authorization."
        : "Missing evidence or changes outside the reviewed browser boundary require the full release path." };
  return deepFreeze({ ...body, planHash: digest(body) });
}

module.exports = { INVENTORY_VERSION, POLICY_VERSION, POLICY_HASH, BUILD_VERSION, LIMITS, FRONTEND_PATHS,
  captureReleaseSourceInventory, validateInventory, partitionHashes, buildFrontendBinding, classifyReleaseChanges };
