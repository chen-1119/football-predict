"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isBuiltin } = require("node:module");
const ts = require("typescript");
const { FRONTEND_PATHS, validateInventory } = require("./releaseChangeClassification.cjs");
const VERSION = "frontend-runtime-boundary-v1";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CLOSURE_BYTES = 64 * 1024 * 1024;
const MAX_CLOSURE_FILES = 512;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha(JSON.stringify(value));
const normalizeSource = text => text.replace(/\r\n/g, "\n");
const deepFreeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const uiPaths = new Set(FRONTEND_PATHS);
const PARSER = Object.freeze({ version: "6.0.3", sha256: "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39", node: "22.22.1" });
const ENTRYPOINTS = deepFreeze({
  "football-predict.service": { script: "server/index.cjs", args: "" },
  "football-sync-worker.service": { script: "scripts/runSyncWorker.cjs", args: " --loop" },
  "football-monitor.service": { script: "scripts/checkServerRuntime.cjs", args: "" },
  "football-cleanup.service": { script: "scripts/cleanupServerArtifacts.cjs", args: "" },
  "football-daily-prematch.service": { script: "scripts/syncDailyPrematchApi.cjs", args: "" },
  "football-featured-combo.service": { script: "scripts/dailyFeaturedComboLedger.cjs", args: " --watch" },
  "football-market-collector.service": { script: "scripts/runMarketCollector.cjs", args: " --loop" },
  "football-recommendation-settlement.service": { script: "scripts/runRecommendationSettlement.cjs", args: " --watch" },
});
const EXTERNAL_UNITS = deepFreeze({
  "football-postgres-backup.service": { executable: "/usr/local/sbin/football-postgres-backup", source: "deploy/light-server/football-postgres-backup.sh" },
  "football-postgres-cos-upload.service": { executable: "/usr/local/sbin/football-postgres-cos-upload", source: "deploy/light-server/football-postgres-cos-upload.sh" },
});
// These are existing operational command adapters, not permission to add a new
// arbitrary command. Their enclosing function source must remain exact, and
// baseline/candidate package and entire reachable-source bytes must also match.
const COMMAND_FUNCTIONS = deepFreeze({
  "scripts/syncDailyPrematchApi.cjs": ["91da78aabb2c925254c42abec031be710d4f9a5316a2ba059533b60189b3bedf"],
  "server/index.cjs": ["209dac00faf2eb81c7c6348cacd5c273dd31dfc8ef913d9f77e0cf2fd4a621b6"],
  "server/relayFastResultWatcher.cjs": ["dbea20508195f9cafdb058ff0e4242448cac19a914c163ef961cfa5d16243567"],
  "scripts/runSyncWorker.cjs": ["7ae9788ce2e4cbc8d321f4750c49de0bb653f132e19497bff992f7e08cb3ac37", "013f6d2f9ffd51b26366edb7f4f942ec80614e91101618a627277ba5d6cf2dbc"],
  "scripts/checkServerRuntime.cjs": ["d5d3198187da326fa45865895f9a10a4d8b51c47f0a5fe9848acd680f9f250ca"],
  "scripts/sportteryFastResultLane.cjs": ["af21f9e738ed81dd6e15396e57280d8b7f368c4409d1cc425d11c45d923b3b5c", "dc80987cc44ec3e0e8a97b8e5ec7bd5e428db8ead154cf4ed41e42b08e1fb1d4", "d5f09848d188090f8ca7888d4b42c99a5a7306f7100886c7b552657322944efa", "5b67586e107f6cfb30a77e18107ea027ef81f4d1b1439d06f6f209d82bab1dd1", "477857d6490abf91a0a5c78bcfe164d025540bebfc4275bf5d1404d586a6ec6d"],
  "scripts/sync500Details.cjs": ["5d0eb2c718dbfe5c53151d940cb7b842298920885bd2161165bbfb1d2822ea3a"],
  "scripts/verifySportteryEgress.cjs": ["43b3b915c4d37b9e69d9aea135bc71ff1fc9041f4b78069dee0099435f1eea4d"],
  "scripts/runReleaseCandidateHeartbeatKeeper.cjs": ["de72fa04f2980d68454849e75547b65e2c9a30983fa66aa6f284021ff04e5032", "44839db642323ef479b305893e4ad651a191d88ef06ebcbf126cee6cab385853"],
  "scripts/syncCloudflareSportteryEvidence.cjs": ["2f4776e7ebd849175b939b4d585e6088e0e497e83143f2bc50e6a3f07e56b5a5"],
  "scripts/syncData.cjs": ["cb7d3cf9ef6fc9d3b2329af516ac7fbb67fffd00cec7873158be1ad6402fe187"],
  "scripts/collectSportterySnapshot.cjs": ["e31d07cdb60aa9f1080a0ae6b68c9bedbbc5b5942c9d3c867cfb89448a90d9c5"],
  "scripts/sportteryBrowserTransport.cjs": ["ef026620a77ac16c3524867aa6e88108bacfb13dc6a93a211d82cdbb09c68940", "cc435eae6f1776d29752f9df870a429d5f37431d0756b1c8a68f2f69fbe90f3d", "4b90e02ae0df248c568dd61fb630066eb9683e07593d332451c4da41d2d3351e"],
});
const SPORTTERY_IMPORT = Object.freeze({ file: "scripts/syncServerDirectSportteryEvidence.cjs",
  target: "cloudflare/sync-trigger/src/sportteryCollector.js", expression: "import(collectorUrl)",
  functionSha256: "df21028687f58815afd285073a948fdbc996940f7399c4d550da3fc146356d50" });
const PUBLICATION_WORKER = Object.freeze({ file: "server/index.cjs", target: "server/publicationResolverWorker.cjs",
  argument: 'path.join(__dirname, "publicationResolverWorker.cjs")',
  functionSha256: "8c0aa528e4f77e431963383fc39b0b4570ca9746d57b6af5045637fe774255da" });
const PROCESS_PARAMETER_ALIAS = Object.freeze({ file: "server/relayFastResultWatcher.cjs", expression: "spawnImpl = spawn",
  functionSha256: "db38fdab1eb8e7dde20b024ed125919468dbe22fe9f7f32a1678fe9a04ee3cd5",
  target: "scripts/publishOfficialResultsFast.cjs" });
const DAILY_PREMATCH_CHILD = Object.freeze({ file: "scripts/syncDailyPrematchApi.cjs", api: "spawnSync",
  target: "scripts/syncApiFootballData.cjs",
  functionSha256: "91da78aabb2c925254c42abec031be710d4f9a5316a2ba059533b60189b3bedf",
  callSha256: "b2ebc786811b687528499c0b1127882080858bed62dc18fc4368f84f377f9ba3" });
const COMMAND_CALLER_FUNCTIONS = deepFreeze({
  "server/index.cjs": ["6444af2f96dc8c27a42b17fde3c1e8ecbbf78b431400db68705d79f435b81962",
    "69491dfa47b5ae271413cb7d26821c5fa672a9837bfcb524aff20280c24aaf57", "62533b17bd403660a466affcb7977306b864671de811e20282de706837079743"],
  "scripts/checkServerRuntime.cjs": ["597a4c17386034eb9a6e3fbec8d7e9e064f0ea264ba68f8d97a1f5f574446e22",
    "b74e76da5ab33c3324947402c71fe5bec7cfa31e05731cffcf8cfe6c1f396975", "af735eb6fea92353333bda9e4bb32b00154b2de6487eca2f04ed0b34362ad7b7",
    "e63c9f77354cb9c33033a2de5b8e92b02f98e47d795bd1893e1dd57dc3b94cc9"],
  "scripts/runSyncWorker.cjs": ["5f0e7b6a6cf61d7230ce91e034db03afc325f0a724b06588a1ed8361d3670120",
    "dc5ba7f3cc3b8e8e65d6dc9450fce24c99b9575fdca632d9c8f3c114d749dfd2", "e35c0a392d9a0ab5ca3abdd8375d0578c8b06bd508da82871c3f23e7d81751e3",
    // Reviewed native coverage await and postgres:sync routing. Commands stay
    // literal; the full reachable code and package graph are still compared.
    "994b5f575e5f8141fc06500fee5a2e036db26d6f3b4248673f462cdd97f701eb", "50b4a036b586195589da6e7b56c11c6a1daa40cc8d183f8af039bc8415e42ff5"],
});
const UNIT_SOURCE_HASHES = Object.freeze({
  "football-daily-prematch.service": "9e6af93d56635ed0940590b4a027e02ab5310080e53b2873775b520f46796d8a",
  "football-featured-combo.service": "7412039439c38effc1679bf80b9966480ff414120084c690c51ee3d434fbee42",
  "football-market-collector.service": "ea62d7e0b66c56a44cb1a61322222ddbe3a2a4cc18429baec9cede8cf3c46043",
  "football-recommendation-settlement.service": "96206e75ff7276c3d2c428324d78f4222963af775ac89d6193ec9b2bdeb8a910",
  "football-cleanup.service": "88b0b805ee484ff1b3915e8debad2e9bea512f024f77aa9ce691c8218fee0e85",
  "football-monitor.service": "7112bc1c27cfbd2edb7ff22a1fc1c5f454eb59a784a2f2dd12d5ecff76c6b31e",
  "football-postgres-backup.service": "c3ca1d47cc65ad4e7dbf9a512ca669d059484f386ba3793a84ca64f551c998fa",
  "football-postgres-backup.sh": "e8f5b6789e85b8abeca3f051daaf75a119fad7c674e835f74ebaccf9f0d21d7d",
  "football-postgres-cos-upload.service": "e6267a03da9facc1b9d421df368d70d3e333d5fb24c7a8ff83aec23a2baa7e52",
  "football-postgres-cos-upload.sh": "e9da629d53fae2ae0edfc0c230828d03c570cfdf7792ca9d8da8fbd92a6724f9",
  "football-predict.service": "392e5ab781fa24961ec05d847f354a57fb4bddc16ef34bdae5c61a687a049af3",
  "football-sync-worker.service": "06249e71449df12b4609ba0a66497b74c2810653e805417153b57b6a4e33ffb2",
});
const POLICY_HASH = digest({ version: VERSION, parser: PARSER, entrypoints: ENTRYPOINTS, externalUnits: EXTERNAL_UNITS,
  unitSourceHashes: UNIT_SOURCE_HASHES,
  commandFunctions: COMMAND_FUNCTIONS, commandCallers: COMMAND_CALLER_FUNCTIONS, commandParameterAlias: PROCESS_PARAMETER_ALIAS,
  dynamicImport: SPORTTERY_IMPORT, worker: PUBLICATION_WORKER, dailyPrematchChild: DAILY_PREMATCH_CHILD, uiPaths: FRONTEND_PATHS,
  commandGrammar: "node-reviewed-flags-local-script-arguments-and-and-v1" });
const processApis = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const clone = value => JSON.parse(JSON.stringify(value));
// Pure AST results only. Every invocation still reads and hashes each source
// against its authenticated inventory. Never cache filesystem/trust success.
const parsedModuleCache = new Map();

function enclosingFunctionHash(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return sha(normalizeSource(current.getText(sourceFile)));
  }
  return null;
}

function parseNpmCommand(command) {
  if (typeof command !== "string" || !command || command.length > 4096 || /[\r\n;$`|<>\\]/.test(command)) {
    throw new Error("unreviewed-npm-command-syntax");
  }
  const segments = command.split("&&");
  const result = [];
  for (const segment of segments) {
    if (segment.includes("&")) throw new Error("unreviewed-npm-command-syntax");
    const words = segment.trim().split(/\s+/);
    if (words[0] !== "node") throw new Error("unreviewed-npm-command-executable");
    let offset = 1;
    while (words[offset]?.startsWith("--")) {
      if (!/^--(?:expose-gc|max-old-space-size=[1-9][0-9]{0,4})$/.test(words[offset])) throw new Error("unreviewed-node-loader-or-flag");
      offset++;
    }
    const script = words[offset++];
    if (!/^scripts\/[A-Za-z0-9_/-]+\.cjs$/.test(script || "") || script.split("/").includes("..")) throw new Error("unreviewed-npm-script-path");
    for (const word of words.slice(offset)) if (!/^[A-Za-z0-9_.:/=-]+$/.test(word)) throw new Error("unreviewed-npm-command-argument");
    result.push({ script, flags: words.slice(1, offset - 1), args: words.slice(offset) });
  }
  return result;
}

function inspectFrontendRuntimeBoundary(input) {
  const blockers = [], files = [], imports = [], commands = [], npmEdges = [], externalImports = [], dynamicImports = [], workers = [];
  let inventoryHash = null, packageCommitment = null;
  try {
    if (!input || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["authenticatedInventoryHash", "inventory", "root"])) throw new Error("exact-runtime-boundary-input-required");
    const { inventory } = input;
    validateInventory(inventory);
    if (input.authenticatedInventoryHash !== inventory.treeHash) throw new Error("authenticated-inventory-mismatch");
    inventoryHash = inventory.treeHash;
    if (process.versions.node !== PARSER.node || ts.version !== PARSER.version
      || sha(fs.readFileSync(require.resolve("typescript"))) !== PARSER.sha256) throw new Error("runtime-boundary-parser-drift");
    if (!path.isAbsolute(input.root)) throw new Error("absolute-root-required");
    const root = path.resolve(input.root), rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error("non-plain-runtime-root");
    const index = new Map(inventory.entries.map(row => [row.path, row]));
    const content = new Map();
    let totalBytes = 0;
    const read = relative => {
      if (content.has(relative)) return content.get(relative);
      const entry = index.get(relative);
      if (!entry || entry.kind !== "file") throw new Error(`missing-runtime-input:${relative}`);
      if (entry.bytes > MAX_SOURCE_BYTES || totalBytes + entry.bytes > MAX_CLOSURE_BYTES) throw new Error("runtime-source-byte-limit");
      let cursor = root;
      for (const part of relative.split("/").slice(0, -1)) {
        cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe-runtime-parent:${relative}`);
      }
      const target = path.join(root, relative), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== entry.bytes) throw new Error(`unsafe-runtime-file:${relative}`);
      const sameFile = (left, right) => right.isFile() && !right.isSymbolicLink() && right.nlink === 1
        && left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        if (!sameFile(stat, fs.fstatSync(fd))) throw new Error(`runtime-file-does-not-match-inventory:${relative}`);
        // One sentinel byte detects growth without an unbounded readFileSync.
        const buffer = Buffer.alloc(entry.bytes + 1);
        let offset = 0, count;
        while (offset < buffer.length && (count = fs.readSync(fd, buffer, offset, buffer.length - offset, null)) > 0) offset += count;
        bytes = buffer.subarray(0, offset);
        if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256 || !sameFile(stat, fs.fstatSync(fd))
          || !sameFile(stat, fs.lstatSync(target))) throw new Error(`runtime-file-does-not-match-inventory:${relative}`);
      } finally { fs.closeSync(fd); }
      totalBytes += bytes.length; content.set(relative, bytes.toString("utf8"));
      files.push({ path: relative, bytes: entry.bytes, sha256: entry.sha256 });
      return content.get(relative);
    };
    const pkg = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json"));
    if (!pkg.scripts || typeof pkg.scripts !== "object" || !lock.packages
      || lock.packages["node_modules/typescript"]?.version !== PARSER.version) throw new Error("runtime-dependency-manifest-invalid-or-drifted");
    packageCommitment = digest(files.slice());
    if (inventory.entries.some(row => /(?:^|\/)(?:\.npmrc|\.node-version|\.nvmrc)$/.test(row.path))) throw new Error("unreviewed-runtime-package-loader-config");
    const declaredPackages = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }));
    const queue = [];
    for (const row of inventory.entries) if (/^deploy\/light-server\/[^/]+\.service$/.test(row.path)) {
      const name = path.posix.basename(row.path);
      if (!Object.hasOwn(ENTRYPOINTS, name) && !Object.hasOwn(EXTERNAL_UNITS, name)) throw new Error(`unreviewed-systemd-entrypoint:${name}`);
    }
    for (const [name, policy] of Object.entries({ ...ENTRYPOINTS, ...EXTERNAL_UNITS })) {
      const text = read(`deploy/light-server/${name}`);
      if (sha(normalizeSource(text)) !== UNIT_SOURCE_HASHES[name]) throw new Error(`runtime-entrypoint-policy-drift:${name}`);
      const starts = [...text.matchAll(/^ExecStart=(.*)$/gm)].map(match => match[1].trim());
      const expected = policy.script ? `/opt/node-v22.22.1/bin/node /opt/football-predict/${policy.script}${policy.args}` : policy.executable;
      if (starts.length !== 1 || starts[0] !== expected) throw new Error(`runtime-entrypoint-policy-drift:${name}`);
      if (policy.script) queue.push(policy.script);
      else if (sha(normalizeSource(read(policy.source))) !== UNIT_SOURCE_HASHES[path.posix.basename(policy.source)]) throw new Error(`runtime-external-unit-policy-drift:${name}`);
    }
    const addNpm = (from, name) => {
      if (!Object.hasOwn(pkg.scripts, name)) throw new Error(`unreviewed-npm-script-name:${name}`);
      for (const job of [`pre${name}`, name, `post${name}`]) {
        if (!Object.hasOwn(pkg.scripts, job)) continue;
        for (const command of parseNpmCommand(pkg.scripts[job])) {
          npmEdges.push({ from, name: job, invokedName: name, command: pkg.scripts[job], target: command.script }); queue.push(command.script);
        }
      }
    };
    const localImportTarget = (from, specifier) => {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
      if (base === ".." || base.startsWith("../") || specifier.includes("\\") || specifier.includes("\0")) throw new Error(`runtime-import-escape:${from}`);
      const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`, `${base}.ts`, `${base}.tsx`, `${base}/index.cjs`, `${base}/index.js`, `${base}/index.ts`];
      const target = candidates.find(name => index.get(name)?.kind === "file");
      if (!target) throw new Error(`unresolved-runtime-import:${from}:${specifier}`);
      return target;
    };
    const resolveImport = (from, specifier, kind) => {
      if (specifier.startsWith(".")) {
        const target = localImportTarget(from, specifier);
        imports.push({ from, specifier, target, kind }); queue.push(target);
      } else {
        const bare = specifier.replace(/^node:/, "");
        if (["module", "vm"].includes(bare) || bare === "worker_threads"
          && ![PUBLICATION_WORKER.file, PUBLICATION_WORKER.target].includes(from)) throw new Error(`unreviewed-runtime-loader-facility:${from}:${specifier}`);
        if (isBuiltin(specifier)) { externalImports.push({ from, specifier, kind: "node-builtin" }); return; }
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!declaredPackages.has(name) || !lock.packages[`node_modules/${name}`]?.integrity) throw new Error(`undeclared-runtime-package:${from}:${specifier}`);
        externalImports.push({ from, specifier, kind: "locked-package", package: name,
          version: lock.packages[`node_modules/${name}`].version, integrity: lock.packages[`node_modules/${name}`].integrity });
      }
    };
    const seen = new Set();
    while (queue.length) {
      const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
      if (seen.size > MAX_CLOSURE_FILES) throw new Error("runtime-closure-file-limit");
      if (uiPaths.has(file) || /^src\/(pages|components)\//.test(file) || /\.css$/.test(file)) throw new Error(`runtime-ui-boundary-overlap:${file}`);
      const source = read(file);
      if (file.endsWith(".json")) { JSON.parse(source); continue; }
      if (!/\.(cjs|js|mjs|ts|tsx)$/.test(file)) throw new Error(`unreviewed-runtime-source-type:${file}`);
      const scopePackages = [];
      for (let directory = path.posix.dirname(file); directory !== "."; directory = path.posix.dirname(directory)) {
        const scopePath = `${directory}/package.json`;
        if (index.get(scopePath)?.kind === "file") { JSON.parse(read(scopePath)); scopePackages.push({ path: scopePath, sha256: index.get(scopePath).sha256 }); }
      }
      const cacheKey = digest({ file, sha256: index.get(file).sha256, packageCommitment, scopePackages, policyHash: POLICY_HASH });
      const destinations = { imports, commands, npmEdges, externalImports, dynamicImports, workers, queue };
      const cached = parsedModuleCache.get(cacheKey);
      // Module bytes alone do not bind extension/index resolution in another
      // authenticated tree. Re-parse on changed targets; never reuse old edges.
      if (cached && cached.imports.every(row => localImportTarget(row.from, row.specifier) === row.target)) {
        parsedModuleCache.delete(cacheKey); parsedModuleCache.set(cacheKey, cached);
        for (const [key, rows] of Object.entries(cached)) destinations[key].push(...rows);
        continue;
      }
      const offsets = Object.fromEntries(Object.entries(destinations).map(([key, rows]) => [key, rows.length]));
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      if (sf.parseDiagnostics.length) throw new Error(`runtime-source-parse-error:${file}`);
      // Binding identity prevents unrelated object fields or shadowed locals
      // from being mistaken for subprocess imports. No type/whole-program claim.
      const host = { getSourceFile: name => name === file ? sf : undefined, writeFile() {}, getCurrentDirectory: () => "",
        getDirectories: () => [], fileExists: name => name === file, readFile: name => name === file ? source : undefined,
        getDefaultLibFileName: () => "", getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n" };
      const checker = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true }, host).getTypeChecker();
      const symbol = node => checker.getSymbolAtLocation(node);
      const childAliases = new Map(), childNamespaces = new Set(), workerAliases = new Set(), bindingIdentifiers = new Set();
      const requireCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null;
      const childModule = value => ["node:child_process", "child_process"].includes(value);
      const collectBindings = node => {
        if (ts.isVariableDeclaration(node) && node.initializer && childModule(requireCall(node.initializer))) {
          if (ts.isIdentifier(node.name)) { childNamespaces.add(symbol(node.name)); bindingIdentifiers.add(node.name); }
          else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name) || (element.propertyName && !ts.isIdentifier(element.propertyName))) throw new Error(`unreviewed-child-process-binding:${file}`);
            if (element.dotDotDotToken || element.initializer) throw new Error(`unreviewed-child-process-binding:${file}`);
            childAliases.set(symbol(element.name), element.propertyName?.text || element.name.text);
            bindingIdentifiers.add(element.name); if (element.propertyName) bindingIdentifiers.add(element.propertyName);
          } else throw new Error(`unreviewed-child-process-binding:${file}`);
        }
        if (ts.isImportDeclaration(node) && childModule(node.moduleSpecifier?.text)) {
          const binding = node.importClause?.namedBindings;
          if (node.importClause?.name) throw new Error(`unreviewed-child-process-binding:${file}`);
          if (binding && ts.isNamespaceImport(binding)) { childNamespaces.add(symbol(binding.name)); bindingIdentifiers.add(binding.name); }
          else if (binding && ts.isNamedImports(binding)) for (const item of binding.elements) {
            childAliases.set(symbol(item.name), item.propertyName?.text || item.name.text);
            bindingIdentifiers.add(item.name); if (item.propertyName) bindingIdentifiers.add(item.propertyName);
          }
          else throw new Error(`unreviewed-child-process-binding:${file}`);
        }
        if (ts.isCallExpression(node) && ["node:worker_threads", "worker_threads"].includes(requireCall(node))) {
          const declaration = node.parent;
          if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) throw new Error(`unreviewed-worker-binding:${file}`);
          const expected = file === PUBLICATION_WORKER.file ? ["Worker"] : ["parentPort", "workerData"];
          const actual = declaration.name.elements.map(element => element.name.getText(sf));
          if (JSON.stringify(actual) !== JSON.stringify(expected) || declaration.name.elements.some(element => element.propertyName || element.initializer || element.dotDotDotToken)) throw new Error(`unreviewed-worker-binding:${file}`);
          for (const element of declaration.name.elements) if (element.name.text === "Worker") { workerAliases.add(symbol(element.name)); bindingIdentifiers.add(element.name); }
        }
        if (ts.isImportDeclaration(node) && ["node:worker_threads", "worker_threads"].includes(node.moduleSpecifier?.text)) throw new Error(`unreviewed-worker-binding:${file}`);
        if (ts.isBindingElement(node) && node.initializer && ts.isIdentifier(node.initializer) && childAliases.has(symbol(node.initializer))) {
          if (file !== PROCESS_PARAMETER_ALIAS.file || node.getText(sf) !== PROCESS_PARAMETER_ALIAS.expression
            || enclosingFunctionHash(node, sf) !== PROCESS_PARAMETER_ALIAS.functionSha256) throw new Error(`unreviewed-process-alias-escape:${file}`);
          childAliases.set(symbol(node.name), childAliases.get(symbol(node.initializer)));
          bindingIdentifiers.add(node.name); bindingIdentifiers.add(node.initializer);
          queue.push(PROCESS_PARAMETER_ALIAS.target);
        }
        ts.forEachChild(node, collectBindings);
      };
      collectBindings(sf);
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw new Error(`unreviewed-static-import:${file}`);
          resolveImport(file, node.moduleSpecifier.text, "import-export");
        }
        if (ts.isImportEqualsDeclaration(node)) throw new Error(`unreviewed-import-equals:${file}`);
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const name = ts.isIdentifier(expression) ? expression.text : null;
          const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
          const isRequireResolve = ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            && expression.expression.text === "require" && expression.name.text === "resolve";
          if (name === "require" || isDynamicImport || isRequireResolve) {
            const specifier = node.arguments[0];
            if (node.arguments.length !== 1) throw new Error(`unreviewed-loader-arguments:${file}`);
            if (specifier && ts.isStringLiteralLike(specifier)) resolveImport(file, specifier.text, isDynamicImport ? "literal-dynamic-import" : "require");
            else if (isDynamicImport && file === SPORTTERY_IMPORT.file && node.getText(sf) === SPORTTERY_IMPORT.expression
              && enclosingFunctionHash(node, sf) === SPORTTERY_IMPORT.functionSha256) {
              dynamicImports.push(clone(SPORTTERY_IMPORT)); queue.push(SPORTTERY_IMPORT.target);
            } else throw new Error(`unreviewed-dynamic-runtime-loader:${file}`);
            if (specifier && ts.isStringLiteralLike(specifier) && childModule(specifier.text) && name === "require") {
              const parent = node.parent;
              if (!(ts.isVariableDeclaration(parent) && parent.initializer === node)
                && !(ts.isPropertyAccessExpression(parent) && parent.expression === node
                  && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) throw new Error(`unreviewed-process-module-escape:${file}`);
            }
          }
          let processApi = ts.isIdentifier(expression) ? childAliases.get(symbol(expression)) : null;
          if (ts.isPropertyAccessExpression(expression)) {
            if (ts.isIdentifier(expression.expression) && childNamespaces.has(symbol(expression.expression))) processApi = expression.name.text;
            if (childModule(requireCall(expression.expression))) processApi = expression.name.text;
            if (expression.name.text === "getBuiltinModule" || expression.name.text === "_load" || expression.name.text === "_compile") throw new Error(`unreviewed-runtime-loader-facility:${file}`);
          }
          if (ts.isElementAccessExpression(expression) && (ts.isIdentifier(expression.expression) && childNamespaces.has(symbol(expression.expression)))) throw new Error(`unreviewed-computed-process-command:${file}`);
          if (processApi) {
            const functionSha256 = enclosingFunctionHash(node, sf);
            if (!processApis.has(processApi) || !(COMMAND_FUNCTIONS[file] || []).includes(functionSha256)) throw new Error(`unreviewed-process-command:${file}`);
            commands.push({ file, api: processApi, functionSha256, callSha256: sha(normalizeSource(node.getText(sf))) });
            if (file === DAILY_PREMATCH_CHILD.file) {
              if (processApi !== DAILY_PREMATCH_CHILD.api || functionSha256 !== DAILY_PREMATCH_CHILD.functionSha256
                || sha(normalizeSource(node.getText(sf))) !== DAILY_PREMATCH_CHILD.callSha256) throw new Error(`unreviewed-prematch-child:${file}`);
              queue.push(DAILY_PREMATCH_CHILD.target);
            }
          }
          if (["eval", "Function"].includes(name)) throw new Error(`unreviewed-code-loader:${file}`);
          // An unchanged generic spawn adapter is not permission to add a new
          // dynamic command caller elsewhere in its file.
          if (name === "runCommand" && !(COMMAND_CALLER_FUNCTIONS[file] || []).includes(enclosingFunctionHash(node, sf))) throw new Error(`unreviewed-command-wrapper-caller:${file}`);
          // A literal npm invocation is a real command edge, not merely a label.
          if (name === "runCommand" && ts.isArrayLiteralExpression(node.arguments[1])) {
            const args = node.arguments[1].elements;
            if (ts.isStringLiteralLike(args[0]) && args[0].text === "run" && ts.isStringLiteralLike(args[1])) addNpm(file, args[1].text);
            if (ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "node"
              && ts.isStringLiteralLike(args[0]) && /^scripts\//.test(args[0].text)) queue.push(args[0].text);
          }
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && workerAliases.has(symbol(node.expression))) {
          if (file !== PUBLICATION_WORKER.file || node.arguments?.length !== 2 || node.arguments[0].getText(sf) !== PUBLICATION_WORKER.argument
            || enclosingFunctionHash(node, sf) !== PUBLICATION_WORKER.functionSha256) throw new Error(`unreviewed-worker-loader:${file}`);
          workers.push(clone(PUBLICATION_WORKER)); queue.push(PUBLICATION_WORKER.target);
        }
        if (ts.isIdentifier(node) && !bindingIdentifiers.has(node)) {
          const binding = symbol(node), parent = node.parent;
          if (childAliases.has(binding) && !(ts.isCallExpression(parent) && parent.expression === node)) throw new Error(`unreviewed-process-alias-escape:${file}`);
          if (childNamespaces.has(binding) && !(ts.isPropertyAccessExpression(parent) && parent.expression === node
            && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) throw new Error(`unreviewed-process-namespace-escape:${file}`);
          if (workerAliases.has(binding) && !(ts.isNewExpression(parent) && parent.expression === node)) throw new Error(`unreviewed-worker-alias-escape:${file}`);
          if (["eval", "Function"].includes(node.text) && !binding) throw new Error(`unreviewed-code-loader:${file}`);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") throw new Error(`unreviewed-code-loader:${file}`);
        if (ts.isIdentifier(node) && node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
          && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ["main", "resolve"].includes(node.parent.name.text))) {
          throw new Error(`unreviewed-require-alias:${file}`);
        }
        // Reviewed worker plans/wrappers pass these literal npm keys indirectly.
        // This deliberately over-approximates labels, rather than missing a job.
        if (ts.isStringLiteralLike(node) && Object.hasOwn(pkg.scripts, node.text)) addNpm(file, node.text);
        ts.forEachChild(node, visit);
      };
      visit(sf);
      // Bound memory while retaining frequently reused baseline modules.
      parsedModuleCache.delete(cacheKey);
      if (parsedModuleCache.size >= MAX_CLOSURE_FILES) parsedModuleCache.delete(parsedModuleCache.keys().next().value);
      parsedModuleCache.set(cacheKey, deepFreeze(Object.fromEntries(Object.entries(destinations).map(([key, rows]) => [key, rows.slice(offsets[key])]))));
    }
  } catch (error) { blockers.push(error.code || error.message); }
  const stableRows = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const body = { version: VERSION, policyHash: POLICY_HASH, parser: PARSER, inventoryHash, packageCommitment,
    files: stableRows(files), imports: stableRows(imports), npmEdges: stableRows(npmEdges), commands: stableRows(commands),
    dynamicImports: stableRows(dynamicImports), workers: stableRows(workers), externalImports: stableRows(externalImports),
    ok: blockers.length === 0, blockers, externalRuntimeAttestationRequired: true,
    scope: "Reviewed local-source module/command closure; not proof of external executable behavior, general filesystem dataflow, or deployment authorization." };
  return deepFreeze({ ...body, evidenceHash: digest(body) });
}

function compareFrontendRuntimeBoundary({ baseline, candidate } = {}) {
  const before = inspectFrontendRuntimeBoundary(baseline), after = inspectFrontendRuntimeBoundary(candidate);
  const blockers = [...before.blockers.map(reason => `baseline:${reason}`), ...after.blockers.map(reason => `candidate:${reason}`)];
  for (const field of ["policyHash", "packageCommitment", "files", "imports", "npmEdges", "commands", "dynamicImports", "workers", "externalImports"]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) blockers.push(`runtime-boundary-drift:${field}`);
  }
  const body = { version: VERSION, policyHash: POLICY_HASH, ok: blockers.length === 0, blockers,
    baselineEvidenceHash: before.evidenceHash, candidateEvidenceHash: after.evidenceHash,
    runtimeClosureHash: before.ok ? digest({ files: before.files, imports: before.imports, npmEdges: before.npmEdges,
      commands: before.commands, dynamicImports: before.dynamicImports, workers: before.workers, externalImports: before.externalImports }) : null,
    runtimeFileCount: before.files.length, moduleEdgeCount: before.imports.length, npmEdgeCount: before.npmEdges.length,
    externalRuntimeAttestationRequired: true, fastPathActivated: false };
  return deepFreeze({ ...body, evidenceHash: digest(body) });
}

module.exports = { VERSION, POLICY_HASH, ENTRYPOINTS, EXTERNAL_UNITS, SPORTTERY_IMPORT, PUBLICATION_WORKER, parseNpmCommand,
  inspectFrontendRuntimeBoundary, compareFrontendRuntimeBoundary };
