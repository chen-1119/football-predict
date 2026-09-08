"use strict";
// Source-only regressions. No production files, fixture data, providers or DB.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const vm = require("node:vm"), crypto = require("node:crypto"), ts = require("typescript");
const root = path.resolve(__dirname, ".."), timelineFile = "scripts/asOfResultTimeline.cjs";
const lifecycleFile = "src/services/matchLifecycle.cjs", clockFile = "src/services/strictInstant.cjs";
const sources = Object.fromEntries([timelineFile, lifecycleFile, clockFile]
  .map(file => [file, fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n?/g, "\n")]));

// Resolve lexical symbols, not identifier spelling: a callback/local binding
// cannot accidentally hide a real module dependency of the same name.
function inspectClosure(file, source, roots, imports = {}) {
  const absolute = path.join(root, file), options = { allowJs: true, checkJs: true, noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => path.resolve(name) === absolute
    ? ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) : original(name, ...rest);
  const program = ts.createProgram([absolute], options, host), checker = program.getTypeChecker();
  const ast = program.getSourceFile(absolute), top = new Map(), symbols = new Map();
  assert.equal(ast.parseDiagnostics.length, 0, "closure source must parse");
  for (const statement of ast.statements) {
    const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations
      : ts.isFunctionDeclaration(statement) ? [statement] : [];
    for (const declaration of declarations) {
      const names = ts.isIdentifier(declaration.name) ? [declaration.name]
        : ts.isObjectBindingPattern(declaration.name) ? declaration.name.elements.map(e => e.name) : [];
      for (const name of names) {
        assert.ok(ts.isIdentifier(name), "unsupported module binding");
        assert.ok(!top.has(name.text), "duplicate module binding");
        top.set(name.text, declaration); symbols.set(checker.getSymbolAtLocation(name), name.text);
      }
    }
  }
  const seen = new Set(), unknown = new Set();
  const globals = new Set(["String", "Number", "Object", "Array", "Boolean", "Date", "JSON", "URL",
    "RegExp", "Math", "Set", "Map", "TypeError", "undefined", "Infinity", "NaN"]);
  function visitRoot(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const declaration = top.get(name); assert.ok(declaration, `unknown module dependency ${name}`);
    if (Object.hasOwn(imports, name)) {
      const init = declaration.initializer;
      assert.ok(ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require"
        && init.arguments.length === 1 && ts.isStringLiteral(init.arguments[0])
        && init.arguments[0].text === imports[name], `unreviewed import binding ${name}`);
      if (ts.isObjectBindingPattern(declaration.name)) {
        const binding = declaration.name.elements.find(e => e.name.text === name);
        assert.ok(binding && (!binding.propertyName || binding.propertyName.text === name), `unreviewed imported export ${name}`);
      }
      return;
    }
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node)
          || ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
        if (!property) {
          const symbol = ts.isShorthandPropertyAssignment(parent)
            ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
          const dependency = symbols.get(symbol);
          if (dependency && dependency !== name) visitRoot(dependency);
          else if (!globals.has(node.text) && (!symbol || !symbol.declarations?.some(d => d.getSourceFile() === ast))) unknown.add(node.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration);
  }
  roots.forEach(visitRoot);
  assert.deepEqual([...unknown], [], "unresolved/dynamic module dependency is not committed");
  return [...seen].sort();
}

function loadIsolated(overrides = {}) {
  const text = { ...sources, ...overrides }, cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    assert.ok(Object.hasOwn(text, file), `unreviewed module import ${file}`);
    const module = { exports: {} }; cache.set(file, module);
    const requireBound = name => {
      if (name === "node:crypto") return crypto;
      assert.ok(name.startsWith("."), `unreviewed external import ${name}`);
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)));
    };
    const wrapper = vm.runInNewContext(`(function(require,module,exports){${text[file]}\n})`, { URL }, { timeout: 1000 });
    wrapper(requireBound, module, module.exports);
    return module.exports;
  }
  return { timeline: load(timelineFile), lifecycle: load(lifecycleFile), clock: load(clockFile) };
}

const base = loadIsolated();
const hash = loaded => loaded.timeline.resultTimelineSemanticHash();
const legacyHash = loaded => crypto.createHash("sha256").update(JSON.stringify({
  version: "result-input-timeline-commitment-v1",
  functions: [loaded.clock.strictInstant, loaded.timeline.timeMs, loaded.timeline.forecastTimeForMatch,
    loaded.timeline.resultObservationForMatch, loaded.timeline.forEachForecastAsOf, loaded.lifecycle.buildResultProvenance]
    .map(fn => fn.toString().replace(/\r\n?/gu, "\n")),
})).digest("hex");
const replace = (file, from, to) => {
  assert.equal(sources[file].split(from).length, 2, "mutation must hit exactly once");
  return { [file]: sources[file].replace(from, to) };
};
const fixture = (id, kickoffTime, extra = {}) => ({ id, sourceMatchId: id, kickoffTime, eventVersion: kickoffTime,
  sourceUrl: "https://webapi.sporttery.cn/result", resultSource: "sporttery:official-api", status: "SCHEDULED", ...extra });
const settled = fixture("A", "2026-01-01T12:00:00Z", { status: "FINISHED", scoreHome: 1, scoreAway: 0,
  resultObservedAt: "2026-01-01T14:00:00Z", resultObservationSource: "sporttery-relay-endpoint-fetched-at" });
function replay(loaded) {
  const seen = [];
  const summary = loaded.timeline.forEachForecastAsOf([settled, fixture("B", "2026-01-01T15:00:00Z")],
    { onResult: row => seen.push(row.id), onForecast: () => {} });
  return { resultEvents: summary.resultEvents, appliedResults: summary.appliedResults, seen };
}
const checks = [];
const check = (name, fn) => { try { fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); } };
function declaredFunctionSource(text, name) {
  const ast = ts.createSourceFile("commitment.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name.text === name) return statement.getText(ast);
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) {
        assert.ok(ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer), `${name} is not a function`);
        return d.initializer.getText(ast);
      }
    }
  }
  assert.fail(`unresolved function source ${name}`);
}
function assertInventory(text = sources, loaded = base) {
  const descriptor = loaded.timeline.resultTimelineSemanticCommitment();
  assert.equal(descriptor.version, "result-input-timeline-commitment-v2");
  assert.deepEqual(Object.keys(descriptor.functions).sort(), inspectClosure(timelineFile, text[timelineFile],
    ["forEachForecastAsOf", "forecastTimeForMatch", "resultObservationForMatch"],
    { strictInstant: "../src/services/strictInstant.cjs", buildResultProvenance: "../src/services/matchLifecycle.cjs" }));
  const provenance = descriptor.dependencies.resultProvenance;
  assert.deepEqual(Object.keys(provenance.functions).concat(Object.keys(provenance.constants), "crypto").sort(),
    inspectClosure(lifecycleFile, text[lifecycleFile], ["buildResultProvenance"], { strictInstant: "./strictInstant.cjs", crypto: "node:crypto" }));
  assert.deepEqual(inspectClosure(clockFile, text[clockFile], ["strictInstant"]), ["strictInstant"]);
  assert.deepEqual(JSON.parse(JSON.stringify(provenance.builtins)), ["node:crypto"]);
  assert.ok(Object.values(provenance.functions).every(value => typeof value === "string" && value.length));
  for (const [name, value] of Object.entries(descriptor.functions)) {
    const file = name === "strictInstant" ? clockFile : name === "buildResultProvenance" ? lifecycleFile : timelineFile;
    assert.equal(value, declaredFunctionSource(text[file], name), `wrong committed timeline function ${name}`);
  }
  for (const [name, value] of Object.entries(provenance.functions)) {
    assert.equal(value, declaredFunctionSource(text[name === "strictInstant" ? clockFile : lifecycleFile], name),
      `wrong committed provenance function ${name}`);
  }
  const dataOnly = value => value === null || ["string", "boolean"].includes(typeof value)
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "object" && Object.values(value).every(dataOnly));
  assert.ok(dataOnly(provenance.constants), "constants cannot silently drop functions from JSON");
  assert.deepEqual(JSON.parse(JSON.stringify(provenance.constants)),
    { MATCH_STATUS_PRIORITY: JSON.parse(JSON.stringify(loaded.lifecycle.MATCH_STATUS_PRIORITY)) });
}

check("complete lexical dependency inventory, including imported clock closure", () => assertInventory());
check("unchanged synthetic result admission remains one result", () => assert.deepEqual(replay(base),
  { resultEvents: 1, appliedResults: 1, seen: ["A"] }));
check("legacy missing settled-score dependency is reproduced and v2 catches it", () => {
  const changed = loadIsolated(replace(timelineFile, "const hasSettledScore = (match) => (", "const hasSettledScore = (match) => (false &&"));
  assert.equal(replay(changed).appliedResults, 0); assert.equal(legacyHash(changed), legacyHash(base));
  assert.notEqual(hash(changed), hash(base));
});
check("legacy transitive score-validation gap is reproduced and v2 catches it", () => {
  const changed = loadIsolated(replace(lifecycleFile, "&& home >= 0", "&& home > 1"));
  assert.equal(replay(changed).appliedResults, 0);
  assert.equal(changed.lifecycle.buildResultProvenance.toString(), base.lifecycle.buildResultProvenance.toString());
  assert.equal(legacyHash(changed), legacyHash(base)); assert.notEqual(hash(changed), hash(base));
});
check("identity tie-break implementation is committed", () => {
  const changed = loadIsolated(replace(timelineFile, "const matchIdentity = (match) => String(", "const matchIdentity = (match) => String(\"changed:\" +"));
  assert.equal(legacyHash(changed), legacyHash(base)); assert.notEqual(hash(changed), hash(base));
});
check("reachable lifecycle constants are committed", () => {
  const changed = loadIsolated(replace(lifecycleFile, "FINISHED: 40,", "FINISHED: 41,"));
  assert.notEqual(hash(changed), hash(base));
});
check("deep clock parsing change changes admission and commitment", () => {
  const changed = loadIsolated(replace(clockFile, "year < 1 ||", "year < 2027 ||"));
  assert.equal(replay(changed).appliedResults, 0); assert.notEqual(hash(changed), hash(base));
});
check("all three modules normalize Windows/Linux line endings", () => {
  const crlf = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, text.replace(/\n/g, "\r\n")]));
  assert.equal(hash(loadIsolated(crlf)), hash(base));
});
check("unrelated lifecycle orchestration change does not retire a candidate", () => {
  const changed = loadIsolated(replace(lifecycleFile,
    "if (value instanceof Date) return value.getTime();", "if (value instanceof Date) return value.getTime() + 1;"));
  assert.equal(hash(changed), hash(base)); assert.deepEqual(replay(changed), replay(base));
});
check("new helper omitted from declared closure fails before release", () => {
  const patch = replace(lifecycleFile, "&& home >= 0", "&& newlyRequiredLimit(home)");
  patch[lifecycleFile] = "const newlyRequiredLimit = value => value > 1;\n" + patch[lifecycleFile];
  assert.throws(() => assertInventory({ ...sources, ...patch }, loadIsolated(patch)), /newlyRequiredLimit/);
});
check("imported clock cannot hide a new uncommitted helper", () => {
  const patch = replace(clockFile, "year < 1 ||", "invalidYear(year) ||");
  patch[clockFile] = "const invalidYear = value => value < 1;\n" + patch[clockFile];
  assert.throws(() => assertInventory({ ...sources, ...patch }, loadIsolated(patch)), /invalidYear/);
});
check("nested binding of the same name cannot mask module dependencies", () => {
  const file = "scripts/closure-fixture.cjs", source = "const limit = x => x; const root = rows => rows.map(limit => limit).map(value => limit(value));";
  assert.deepEqual(inspectClosure(file, source, ["root"]), ["limit", "root"]);
});
check("computed property references still resolve module dependencies", () => {
  assert.deepEqual(inspectClosure("scripts/closure-fixture.cjs",
    "const key = 'field'; const root = row => row[key];", ["root"]), ["key", "root"]);
});
check("unreviewed global or require cannot be silently treated as a pure helper", () => {
  for (const source of ["const root = row => hiddenInput(row);", "const helper = require('./extra.cjs'); const root = row => helper(row);"])
    assert.throws(() => inspectClosure("scripts/closure-fixture.cjs", source, ["root"]), /unresolved/);
});
check("an import target change cannot hide behind the same local symbol", () => {
  const patch = replace(lifecycleFile, 'require("node:crypto")', 'require("node:fs")');
  assert.throws(() => assertInventory({ ...sources, ...patch }), /unreviewed import binding crypto/);
});
check("an imported export alias cannot hide a different implementation closure", () => {
  const patch = replace(lifecycleFile, "const { strictInstant }", "const { otherParser: strictInstant }");
  assert.throws(() => assertInventory({ ...sources, ...patch }), /unreviewed imported export strictInstant/);
});
check("matching names cannot hide a substituted committed function", () => {
  const patch = replace(lifecycleFile, "    isValidFinalScore,\n    kLeagueEvidenceHash,", "    isValidFinalScore: asText,\n    kLeagueEvidenceHash,");
  assert.throws(() => assertInventory({ ...sources, ...patch }, loadIsolated(patch)), /wrong committed provenance function isValidFinalScore/);
});
const report = { ok: checks.every(c => c.ok), version: "result-timeline-semantic-closure-verifier-v1", checks,
  oldCommitment: legacyHash(base), newCommitment: hash(base), productionWrites: 0, providerRequests: 0,
  scope: "exact pure source closure and synthetic counterexamples; not a live revision transition, historical provenance, model promotion or accuracy proof" };
console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
