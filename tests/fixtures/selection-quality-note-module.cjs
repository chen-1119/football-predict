'use strict';
// Compile the actual shared component so rendering tests exercise its real
// language, status attributes and conditional text rather than a placeholder.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {createRequire}=require('node:module');
const cache=new Map();
function compile(file){
 const absolute=require.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const compiled={exports:{}};cache.set(absolute,compiled);
 const nativeRequire=createRequire(absolute);
 const transpiled=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{fileName:absolute,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
 const errors=transpiled.diagnostics?.filter(item=>item.category===ts.DiagnosticCategory.Error)||[];
 if(errors.length)throw new Error(errors.map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')).join('\n'));
 vm.runInNewContext(transpiled.outputText,{module:compiled,exports:compiled.exports,__filename:absolute,__dirname:path.dirname(absolute),Date,Intl,Set,require:id=>{
  if(id.startsWith('.'))for(const extension of ['.ts','.tsx']){
   const dependency=path.resolve(path.dirname(absolute),id+extension);
   if(fs.existsSync(dependency))return compile(dependency);
  }
  return nativeRequire(id);
 }},{filename:absolute});
 return compiled.exports;
}
module.exports=compile('../../src/components/recommendations/SelectionQualityNote.tsx');
