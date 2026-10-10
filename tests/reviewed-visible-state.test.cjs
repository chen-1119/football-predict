'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{createRequire}=require('node:module');
function load(file){const filename=path.resolve(file),m={exports:{}},native=createRequire(filename);vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:m,exports:m.exports,Date,Intl,require:id=>id.startsWith('.')?load(path.resolve(path.dirname(filename),id+'.tsx')):native(id)});return m.exports;}
const ui=load('src/components/recommendations/ReviewedAnalysis.tsx'),lane=load('src/components/recommendations/LeagueBaselineDirections.tsx');
const record={eventId:'42',selection:'a',sp:1.76,originalSp:1.8,scores:[[1,2],[0,1]],confidence:'低',reason:'Synthetic reviewed fixture',limitations:['Unknown lineup'],analysisUrl:'https://example.com/preview',cutoffAt:'2030-01-01T10:00:00Z',quoteObservedAt:'2030-01-01T08:00:00Z'};
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
test('reviewed price uses frozen official price and labels it non-live',()=>{const html=render(ui.ReviewedMatchPrice,{record,language:'zh'});a.match(html,/1\.76/);a.match(html,/发布时官方 SP/);a.match(html,/非即时价/);a.doesNotMatch(html,/待核|1\.80/);});
test('published record is upcoming before cutoff, result pending at and after cutoff',()=>{for(const [time,label]of [['2030-01-01T09:59:59Z','已发布 · 待开赛'],['2030-01-01T10:00:00Z','已发布 · 待核赛果'],['2030-01-02T10:00:00Z','已发布 · 待核赛果']]){const html=render(ui.ReviewedMatchStatus,{record,now:Date.parse(time),language:'zh'});a.match(html,new RegExp(label));a.doesNotMatch(html,/待发布|命中/);}});
test('missing adoption states no published pick without claiming collection failure',()=>{const html=render(lane.TrainedMatchPick,{record:null,language:'zh'});a.match(html,/暂无推荐/);a.match(html,/赛程与赔率更新单独显示/);a.doesNotMatch(html,/待验证|球队模型 · 未校准参考/);});
test('reviewed record is visible without trained parameters',()=>{const html=render(lane.TrainedMatchPick,{record:null,reviewed:record,now:Date.parse('2030-01-01T09:00:00Z'),language:'zh'});a.match(html,/人工审核/);a.match(html,/客胜/);a.match(html,/1\.76/);a.doesNotMatch(html,/暂无推荐|待验证/);});
test('English publication status does not imply settled result',()=>{a.match(render(ui.ReviewedMatchStatus,{record,now:Date.parse(record.cutoffAt),language:'en'}),/Published · Result pending/);});

test('HHAD label keeps signed line and never calls handicap draw ordinary draw',()=>{
 const html=render(ui.ReviewedMatchPick,{record:{...record,market:'HHAD',handicap:-1,selection:'d',scores:[[1,0],[2,1]]}});
 a.match(html,/让平\(-1\)/);a.doesNotMatch(html,/>平局/);a.match(html,/1-0/);
});
test('positive handicap label retains plus sign',()=>{a.match(render(ui.ReviewedMatchPick,{record:{...record,market:'HHAD',handicap:1,selection:'a',scores:[[0,2],[1,3]]}}),/让负\(\+1\)/);});
