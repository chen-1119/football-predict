'use strict';
// Compile the actual shared component so rendering tests exercise its real
// language, status attributes and conditional text rather than a placeholder.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const file=require.resolve('../../src/components/recommendations/SelectionQualityNote.tsx');
const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const compiled={exports:{}};
vm.runInNewContext(code,{module:compiled,exports:compiled.exports,require,Date},{filename:file});
module.exports=compiled.exports;
