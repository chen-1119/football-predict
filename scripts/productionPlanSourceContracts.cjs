"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript");
const ALLOWED_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "test", "match",
  "every", "some", "map", "filter", "reduce", "sort", "slice", "join", "split", "replace", "trim",
  "toLowerCase", "toUpperCase", "keys", "entries", "values", "from", "isArray", "isFinite", "isInteger"]);
const GLOBALS = new Set(["hasAll", "scripts", "Object", "Array", "Number", "String", "Boolean", "undefined", "NaN", "Infinity"]);

function classifyPredicate(node, sourceNames) {
  const scopes = new Map(), free = new Set(), reasons = new Set();
  function binding(name, locals) {
    if (ts.isIdentifier(name)) locals.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      name.elements.forEach(e => { if (ts.isBindingElement(e)) binding(e.name, locals); });
  }
  function declarations(n) {
    if (ts.isArrowFunction(n)) { const locals = new Set(); n.parameters.forEach(p => binding(p.name, locals)); scopes.set(n, locals); }
    ts.forEachChild(n, declarations);
  }
  declarations(node);
  const locallyBound = identifier => {
    for (let p = identifier.parent; p && p !== node.parent; p = p.parent)
      if (scopes.get(p)?.has(identifier.text)) return true;
    return false;
  };
  function visit(n) {
    if (ts.isNewExpression(n) || ts.isAwaitExpression(n) || ts.isFunctionExpression(n) || ts.isBlock(n)
      || ts.isDeleteExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isPostfixUnaryExpression(n)
      || n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) reasons.add("non-source-only-expression");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) reasons.add("assignment");
    if (ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) reasons.add("mutation");
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        if (!["hasAll", "Number", "String", "Boolean"].includes(callee.text)) reasons.add("unknown-call");
      } else if (ts.isPropertyAccessExpression(callee)) {
        if (!ALLOWED_METHODS.has(callee.name.text)) reasons.add("unknown-method");
      } else reasons.add("dynamic-call");
    }
    if (ts.isPropertyAccessExpression(n) && ["constructor", "prototype", "__proto__"].includes(n.name.text)) reasons.add("metaprogramming");
    if (ts.isElementAccessExpression(n) && (!ts.isStringLiteral(n.argumentExpression)
      && !ts.isNumericLiteral(n.argumentExpression))) reasons.add("dynamic-property");
    if (ts.isElementAccessExpression(n) && ["constructor", "prototype", "__proto__"].includes(n.argumentExpression?.text)) reasons.add("metaprogramming");
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const propertyName = (ts.isPropertyAccessExpression(p) && p.name === n)
        || (ts.isPropertyAssignment(p) && p.name === n && !ts.isShorthandPropertyAssignment(p));
      if (!propertyName && !locallyBound(n)) {
        if (sourceNames.has(n.text)) free.add(n.text);
        else if (!GLOBALS.has(n.text)) reasons.add(`unknown-input:${n.text}`);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return { eligible: reasons.size === 0, sourceInputs: [...free].sort(), reasons: [...reasons].sort() };
}

function inspectProductionPlanSourceContracts(rootDir, options = {}) {
  const read = file => {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("unsafe source contract path");
    const override = options.sources?.[file];
    if (override !== undefined) return override;
    try { return fs.readFileSync(path.join(rootDir, file), "utf8").replace(/\r\n?/g, "\n"); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  };
  const text = options.planSource ?? read("scripts/verifyProductionPlanCoverage.cjs");
  const ast = ts.createSourceFile("plan.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error("production plan source does not parse");
  const inputs = new Map();
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isCallExpression(d.initializer)
        && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "readText"
        && d.initializer.arguments.length === 1 && ts.isStringLiteral(d.initializer.arguments[0]))
        inputs.set(d.name.text, d.initializer.arguments[0].text);
    }
  }
  const scripts = JSON.parse(read("package.json")).scripts, checks = [], excluded = [];
  if (!scripts || Object.values(scripts).some(v => typeof v !== "string")) throw new Error("invalid package script map");
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "pushCheck"
      && node.arguments.length >= 3 && ts.isStringLiteral(node.arguments[0]) && ts.isStringLiteral(node.arguments[1])) {
      const [phase, name, predicate] = node.arguments, classification = classifyPredicate(predicate, new Set(inputs.keys()));
      if (!classification.eligible) excluded.push({ name: name.text, reasons: classification.reasons });
      else {
        const missing = [], context = { scripts,
          hasAll: (source, needles) => { const absent = needles.filter(needle => !source.includes(needle));
            if (absent.length) missing.push(Array.from(absent)); return absent.length === 0; } };
        for (const key of classification.sourceInputs) context[key] = read(inputs.get(key));
        let ok = false, error = null;
        try { const result = vm.runInNewContext(`Boolean(${predicate.getText(ast)})`, context, { timeout: 1000,
          contextCodeGeneration: { strings: false, wasm: false } }); ok = result === true; }
        catch (e) { error = String(e.message).slice(0,300); }
        checks.push({ phase: phase.text, name: name.text, ok, error, missing,
          files: classification.sourceInputs.map(key => inputs.get(key)) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const inventory = JSON.parse(read("scripts/data/production-plan-source-contracts.json"));
  if (inventory.version !== "production-plan-required-source-contracts-v1" || !Array.isArray(inventory.required)
    || inventory.required.length === 0 || new Set(inventory.required).size !== inventory.required.length)
    throw new Error("invalid required source-contract inventory");
  const observed = new Set(checks.map(c => c.name));
  const uncoveredRequired = inventory.required.filter(name => !observed.has(name));
  return { ok: checks.length > 0 && checks.every(c => c.ok) && uncoveredRequired.length === 0,
    version: "production-plan-source-contracts-v1", uncoveredRequired,
    checks, excluded, sourceOnlyChecks: checks.length, mixedOrUnsupportedChecks: excluded.length,
    productionWrites: 0, providerRequests: 0,
    scope: "only provably source-bound predicates from the actual plan; full live plan, database and HTTP checks remain mandatory" };
}
module.exports = { classifyPredicate, inspectProductionPlanSourceContracts };
if (require.main === module) {
  const report = inspectProductionPlanSourceContracts(path.resolve(__dirname, ".."));
  console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
}
