'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Read and execute real review modules in Node tests. Only their CSS is omitted;
// components and aggregation are never replaced with constant test doubles.
module.exports = function loadReviewTs(ts, filename, overrides = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.endsWith('.css')) return {};
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), id);
      const target = [base, `${base}.tsx`, `${base}.ts`].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      if (target && /\.tsx?$/.test(target)) return loadReviewTs(ts, target, overrides);
    }
    return require(id);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  return module.exports;
};
