'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createRequire}=require('node:module'),cache=new Map();
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX};
function compile(file){
 const absolute=require.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const module={exports:{}};cache.set(absolute,module);const native=createRequire(absolute);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,Intl,Set,require:id=>{
  if(id.endsWith('.css'))return {};
  if(id.startsWith('.'))for(const ext of ['.ts','.tsx']){const dependency=path.resolve(path.dirname(absolute),id+ext);if(fs.existsSync(dependency))return compile(dependency);}
  return native(id);
 }},{filename:absolute});return module.exports;
}
const {MixedModelEstimateNote,PublishedMatchPick}=compile('../src/components/recommendations/PublishedMatchPick.tsx');
const {formatSourceNeutralText}=compile('../src/components/predictions/sourceNeutralText.ts');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectEnsemblePolicy}=require('../src/services/baselineEnsemblePolicy.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const misleading=/赛前独立模型|先计算独立模型概率|SP\s*(?:只做|只用于|只参与)|去水支持率仅用于市场校验|SP (?:is validation only|only validates|is market-divergence validation only)|已通过概率校准|validated probability estimate/i;

function mixedSource(){
 const policy=selectEnsemblePolicy({eloAvailable:true,eloHome:12,eloAway:12,formHome:12,formAway:12,formConfidence:.8});
 const source=withVerifiedInputEvidence(match(781,NOW),{weights:policy.weights,formHome:12,formAway:12,formWeight:.3});
 const model=source.probabilityModel,p=model.oneXTwo.final;
 model.calculationTrace={version:'saved-trace-with-stale-description',
  policy:{zh:'先计算独立模型概率，再做风险校准；SP 只做市场校验。',en:'Compute independent model probabilities first; SP is validation only.'},
  marketUse:{formula:'marketWeight=0',zh:'SP 只做校验。',en:'SP is validation only.'},
  outcome:{weights:policy.weights,components:Object.entries(policy.weights).map(([key,weight])=>({key,weight,probabilities:p,
   label:key==='market'?{zh:'SP只做校验',en:'SP is validation only'}:key==='teamStrength'?{zh:'独立强度',en:'Independent strength'}:{zh:key,en:key},
   role:key==='market'?'validation-only':'model'})),
   calibration:{applied:true,adjustments:[{code:'1',penalty:.05,reason:'international-low-sp-shrink'}]}}};
 assert.equal(policy.validation,'unvalidated');
 const receipt=model.inputUsage.find(item=>item.stage==='base-outcome-blend');
 assert.equal(receipt.weights.market,.1);assert(receipt.inputs.market);assert(receipt.inputs.teamStrength);assert(receipt.inputs.poisson);
 return source;
}

// Render the real page-local JSX and its formatters without mounting unrelated
// fetch/effect/UI dependencies. The production function body is not copied here.
const detailFile=path.join(__dirname,'../src/pages/MatchDetail.tsx');
const detailSource=fs.readFileSync(detailFile,'utf8');
const ast=ts.createSourceFile(detailFile,detailSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function initializer(name){
 const found=[];function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found.push(node.initializer);ts.forEachChild(node,visit);}visit(ast);
 assert.equal(found.length,1,`one production declaration for ${name}`);return found[0].getText(ast);
}
function formulaRenderer(calculationTrace,language){
 const declarations=['displayText','formatProbabilityValue','formatModelWeight','formatDecimal','outcomeLabels','renderOutcomeLine','renderCalculationFormulaPanel'];
 const code=ts.transpileModule(`${declarations.map(name=>`const ${name}=${initializer(name)};`).join('\n')} module.exports=renderCalculationFormulaPanel;`,{compilerOptions}).outputText;
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require,calculationTrace,language,MixedModelEstimateNote,formatSourceNeutralText});
 return module.exports;
}

test('published cards label a receipt-backed mixed-input fixture as uncalibrated in both languages without changing frozen probabilities',()=>{
 const source=mixedSource(),decision=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:'coherent-market-primary-v1'}).decision;
 assert(decision);const row={decision,settlement:{state:'PENDING'}},before=JSON.stringify({source,row});
 for(const language of ['zh','en'])for(const compact of [true,false]){
  const markup=render(PublishedMatchPick,{row,language,compact,now:NOW}),text=plain(markup);
  assert.match(markup,/data-model-source="mixed-uncalibrated"/);assert.doesNotMatch(text,misleading);
  if(language==='zh'){
   assert.match(text,/混合模型估计·未校准/);assert.match(text,/市场概率和球队\/比分输入/);assert.match(text,/本条实际采用项以可核验回执为准/);assert.match(text,/赔率换算概率不等于独立预测/);
  }else{
   assert.match(text,/Mixed model estimate · uncalibrated/);assert.match(text,/market probabilities and team\/score inputs/);assert.match(text,/require a verifiable receipt/);assert.match(text,/Odds-implied probabilities are not independent predictions/);
  }
  for(const code of ['1','X','2'])assert(text.includes(`${(decision.probabilities[code]*100).toFixed(1)}%`));
 }
 assert.equal(JSON.stringify({source,row}),before);
});

test('actual MatchDetail formula JSX exposes positive market weight despite stale role/prose and never invents a zero weight',()=>{
 const source=mixedSource(),trace=source.probabilityModel.calculationTrace,before=JSON.stringify(trace);
 for(const language of ['zh','en']){
  const text=plain(render(formulaRenderer(trace,language),{}));assert.doesNotMatch(text,misleading);assert.doesNotMatch(text,/marketWeight=0|独立强度|Independent strength/);
  assert.match(text,language==='zh'?/市场概率输入 10%/:/Market probability input 10%/);
  assert.match(text,language==='zh'?/基础市场权重 10%/:/Base market weight 10%/);
  assert.match(text,language==='zh'?/启发式风险调整，概率仍未校准/:/heuristic risk rules applied; probabilities remain uncalibrated/);
  const missing={...trace,outcome:{...trace.outcome,weights:{},components:trace.outcome.components.filter(item=>item.key!=='market')}};
  const missingText=plain(render(formulaRenderer(missing,language),{}));assert.match(missingText,language==='zh'?/基础市场权重 --/:/Base market weight --/);assert.doesNotMatch(missingText,misleading);
 }
 assert.equal(JSON.stringify(trace),before);
});
