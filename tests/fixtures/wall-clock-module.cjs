'use strict';
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

// Compile the real clock hook with the render harness's React and clock.
module.exports = function wallClockModule(react, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../../src/hooks/useWallClock.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Date, ...globals,
    require: id => { if (id === 'react') return react; throw Error(id); },
  });
  return module.exports;
};
