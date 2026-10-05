'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const filename=path.join(__dirname,'../src/services/lotterySalesCalendar.ts');
const moduleObject={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:moduleObject,exports:moduleObject.exports,Date,Number});
const {activeLotterySalesClosure:active}=moduleObject.exports;
test('official closure follows exact Beijing start and exclusive end',()=>{
 assert.equal(active(Date.parse('2026-09-30T15:59:59.999Z')),null);
 assert.equal(active(Date.parse('2026-09-30T16:00:00Z')).id,'cn-lottery-national-day-2026');
 assert.ok(active(Date.parse('2026-10-04T15:59:59.999Z')));
 assert.equal(active(Date.parse('2026-10-04T16:00:00Z')),null);
});
test('missing clocks and another year never imply a scheduled closure',()=>{
 for(const value of [NaN,Infinity,Date.parse('2027-10-02T12:00:00+08:00')])assert.equal(active(value),null);
 assert.match(active(Date.parse('2026-10-02T12:00:00+08:00')).sourceUrl,/^https:\/\/www\.mof\.gov\.cn\//);
});
