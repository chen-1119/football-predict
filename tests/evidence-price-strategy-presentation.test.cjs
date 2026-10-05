'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createRequire}=require('node:module'),cache=new Map();
function compile(file){
 const absolute=require.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const module={exports:{}};cache.set(absolute,module);const native=createRequire(absolute);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,Intl,Set,require:id=>{
  if(id.endsWith('.css'))return {};
  if(id.startsWith('.'))for(const ext of ['.ts','.tsx']){const dependency=path.resolve(path.dirname(absolute),id+ext);if(fs.existsSync(dependency))return compile(dependency);}
  return native(id);
 }},{filename:absolute});return module.exports;
}
const {parseRecommendationCenter}=compile('../src/services/recommendationCenterView.ts');
const {StrategyAssessmentNote}=compile('../src/components/recommendations/SelectionQualityNote.tsx');
const {evaluateEvidencePriceRecommendation,validEvidencePriceRecommendation,VERSION}=require('../src/services/evidencePriceRecommendationPolicy.cjs');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication,memoryPorts,validators}=require('./recommendationFixture.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');

function fixture({available=true,probabilities={home:45.6,draw:26.4,away:28},odds={odds1:1.32,oddsX:4.6,odds2:6.3},asOf=NOW,calibrationEvidence=null}={}){
 const source=match(2041806,NOW,{homeTeamName:'法国',awayTeamName:'比利时',odds,
  handicapLine:-1,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:available?'sporttery:HHAD':'unknown',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
  probabilityModel:{version:'evidence-price-ui-regression',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.7175127632029212,away:1.3237417615322957}}}}});
 const decision=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:'coherent-market-primary-v1'}).decision;assert(decision);
 const context={asOf,calibrationEvidence},strategyAssessment=evaluateEvidencePriceRecommendation(decision,context);
 assert(validEvidencePriceRecommendation(strategyAssessment,decision,context));
 return {decision,settlement:{state:'PENDING'},strategyAssessment};
}
function shadowEligibleFixture(){
 // Parser-only shadow fixture, not a claim that the policy or real seven
 // matches admitted this candidate. Preserve its actual positive price math.
 const row=fixture(),assessment=row.strategyAssessment,candidate=assessment.candidates.find(c=>c.modelExpectedValue>0);assert(candidate);
 candidate.researchValueEligible=true;candidate.reasons=[];
 assessment.eligibleCandidates=assessment.candidates.filter(c=>c.researchValueEligible).map(c=>structuredClone(c));
 assessment.selectionStatus='research-value-candidates';assessment.reasons=assessment.reasons.filter(reason=>reason!=='no-research-value-candidate');
 return row;
}
function payload(row){
 const summary={published:1,settled:0,won:0,lost:0,pending:1,void:0,disputed:0,hitRate:null};
 const empty={...summary,published:0,pending:0};
 return {recommendationCenter:{version:'recommendation-center-v1',updatedAt:row.decision.publishedAt,businessDate:row.decision.businessDate,inputAsOf:null,resultAsOf:null,
  lanes:{},current:[row],previews:[],todayCombos:[],overlapDecisionIds:[],review:{singles:[],combos:[],limit:0,statistics:{single:summary,two:empty,three:empty},definition:'test'},excludedCorruptRecords:0,modelValidation:'unvalidated'}};
}
const parse=row=>parseRecommendationCenter(payload(row)).current[0].strategyAssessment;
const render=(assessment,language='zh')=>renderToStaticMarkup(React.createElement(StrategyAssessmentNote,{assessment,language}));
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function optionRows(markup){
 return [...markup.matchAll(/<p\b([^>]*data-strategy-option="([^"]+)"[^>]*)>([\s\S]*?)<\/p>/g)]
  .map(([,attributes,key,body])=>({key,ev:attributes.match(/data-model-ev="([^"]+)"/)?.[1],text:plain(body)}));
}
function rejects(mutations){
 const original=fixture(),before=JSON.stringify(original);
 for(const [name,mutate] of mutations){const changed=structuredClone(original);mutate(changed.strategyAssessment);assert.throws(()=>parse(changed),undefined,name);}
 assert.equal(JSON.stringify(original),before);
}

test('actual policy output parses and renders six shadow candidates without promoting any formal primary',()=>{
 const row=fixture(),before=JSON.stringify(row),raw=row.strategyAssessment,assessment=parse(row),markup=render(assessment);
 assert.equal(raw.version,VERSION);assert.equal(assessment.version,VERSION);assert.equal(assessment.decisionId,row.decision.decisionId);assert.equal(assessment.decisionRecordHash,row.decision.recordHash);
 assert.equal(assessment.id,raw.id);assert.equal(assessment.contentHash,raw.contentHash);assert.equal(assessment.scope,'shadow-reference-only');
 assert.equal(assessment.formalEligible,false);assert.equal(assessment.primary,null);assert.equal(assessment.companion,null);assert.equal(assessment.calibration.status,'unavailable');
 assert.equal(assessment.candidates.length,6);const options=optionRows(markup);assert.equal(options.length,6);
 raw.candidates.forEach((candidate,index)=>{const parsed=assessment.candidates[index];assert.equal(parsed.id,candidate.id);assert.equal(parsed.modelProbability,candidate.modelProbability);assert.equal(parsed.modelExpectedValue,candidate.modelExpectedValue);assert.equal(parsed.researchValueEligible,candidate.researchValueEligible);
  assert.equal(options[index].key,`${candidate.market}:${candidate.tipCode}`,'presentation must preserve the policy candidate order');
  assert(options[index].text.includes(candidate.modelExpectedValue===null?'模型期望值 —':`模型期望值 ${(candidate.modelExpectedValue*100).toFixed(1)}%`));
 });
 assert.match(markup,/data-strategy-assessment="evidence-price-recommendation-v1"/);assert.match(markup,/data-formal-eligible="false"/);
 assert.match(markup,/策略审查 · 未校准/);assert.match(markup,/正式主方向：无 · 观察/);assert.match(markup,/正模型期望值均不等于正式推荐/);
 assert.doesNotMatch(markup,/<details[^>]*\bopen[\s=>]/);assert.equal(JSON.stringify(row),before);
});

test('negative and zero model EV remain observation rather than a value recommendation',()=>{
 for(const row of [fixture(),fixture({probabilities:{home:50,draw:25,away:25},odds:{odds1:2,oddsX:3.8,odds2:4.5}})]){
  const assessment=parse(row),candidate=assessment.candidates.find(c=>c.market==='HAD'&&c.tipCode==='1');assert(candidate.modelExpectedValue<=0);assert.equal(candidate.researchValueEligible,false);
  const output=optionRows(render(assessment)).find(option=>option.key==='HAD:1');assert.equal(output.ev,'nonpositive');assert.match(output.text,/观察/);assert.match(output.text,/模型期望值不为正/);assert.doesNotMatch(output.text,/仅研究候选|价值推荐|正式推荐/);
  assert.equal(assessment.formalEligible,false);assert.equal(assessment.primary,null);
 }
 const zero=parse(fixture({probabilities:{home:50,draw:25,away:25},odds:{odds1:2,oddsX:3.8,odds2:4.5}})).candidates.find(c=>c.market==='HAD'&&c.tipCode==='1');assert.equal(zero.modelExpectedValue,0);
});

test('missing HHAD prices preserve null EV, false eligibility and absent calibration rather than inventing numbers',()=>{
 const row=fixture({available:false}),before=JSON.stringify(row),assessment=parse(row),markup=render(assessment),options=optionRows(markup);
 for(const candidate of assessment.candidates.filter(c=>c.market==='HHAD')){
  assert.equal(candidate.modelExpectedValue,null);assert.equal(candidate.researchValueEligible,false);
  const output=options.find(option=>option.key===`HHAD:${candidate.tipCode}`);assert.match(output.text,/模型期望值 —/);assert.match(output.text,/观察/);assert.equal(output.ev,'unvalidated');
 }
 assert.equal(assessment.calibration.status,'unavailable');assert.equal(assessment.primary,null);assert.equal(assessment.companion,null);assert.equal(JSON.stringify(row),before);
});

test('caller calibration claims and post-cutoff assessments remain unverified or unavailable with no formal selection',()=>{
 const claimed=fixture({calibrationEvidence:{passed:true,promoted:true,settled:10000}}),assessment=parse(claimed);
 assert.equal(assessment.calibration.status,'unverified');assert.equal(assessment.formalEligible,false);assert.equal(assessment.primary,null);assert.match(render(assessment),/校准证据尚未核验/);
 const closed=fixture({asOf:Date.parse(claimed.decision.cutoffTime)}),closedAssessment=parse(closed);
 assert.equal(closedAssessment.selectionStatus,'unavailable');assert.equal(closedAssessment.primary,null);assert.match(render(closedAssessment),/正式主方向：无 · 观察（审查输入暂不可用）/);
 assert.match(render(assessment,'en'),/Strategy assessment · uncalibrated/);assert.match(render(assessment,'en'),/Formal primary: none · watch/);
});

test('legacy rows without an assessment and explicit null remain readable without a strategy panel',()=>{
 const row=fixture();delete row.strategyAssessment;const before=JSON.stringify(row);
 assert.equal(parse(row),undefined);assert.equal(render(parse(row)),'');assert.equal(JSON.stringify(row),before);
 row.strategyAssessment=null;assert.equal(parse(row),null);assert.equal(render(parse(row)),'');
});

test('the actual publishing runtime exposes a parseable current assessment without changing frozen records after cutoff',async()=>{
 const ports=memoryPorts(),runtime=createRuntime(ports,{validators});await runtime.publishingCycle();
 const frozen=JSON.stringify(ports.state.decisions),data=parseRecommendationCenter({recommendationCenter:ports.state.view});assert.equal(data.current.length,3);
 for(const row of data.current){assert(row.strategyAssessment,'current runtime rows must carry the strategy projection');assert.equal(row.strategyAssessment.asOf,new Date(ports.now).toISOString());assert.equal(row.strategyAssessment.decisionId,row.decision.decisionId);assert.equal(row.strategyAssessment.primary,null);assert.equal(row.strategyAssessment.formalEligible,false);assert.match(render(row.strategyAssessment),/策略审查 · 未校准/);}
 ports.now=Math.max(...ports.state.decisions.map(decision=>Date.parse(decision.cutoffTime)));await runtime.view();
 const after=parseRecommendationCenter({recommendationCenter:ports.state.view});assert.equal(after.current.length,3);
 for(const row of after.current){assert.equal(row.strategyAssessment.selectionStatus,'unavailable');assert.equal(row.strategyAssessment.primary,null);assert.equal(row.strategyAssessment.companion,null);assert.equal(row.strategyAssessment.formalEligible,false);assert(row.strategyAssessment.reasons.includes('after-cutoff'));}
 assert.equal(JSON.stringify(ports.state.decisions),frozen);
});

const onlineInputPath=process.env.ONLINE_RECOMMENDATION_INPUT||path.join(__dirname,'../outputs/recommendation-policy-v2-20261005/precutoff-target-versions.json');
test('all seven target versions use complete frozen decisions for strategy assessment and still parse after cutoff',{skip:!process.env.ONLINE_RECOMMENDATION_INPUT&&!fs.existsSync(onlineInputPath)},()=>{
 const inputPath=onlineInputPath;
 const input=JSON.parse(fs.readFileSync(inputPath,'utf8')),before=JSON.stringify(input),full=input.latestFull;
 assert(Array.isArray(full)&&full.length===7);assert.equal(input.center.current.length,7);
 for(const raw of input.center.current){
  const decision=full.find(decision=>decision.decisionId===raw.decision.decisionId);assert(decision,'complete decision must bind to the exact target version');assert.equal(decision.recordHash,raw.decision.recordHash);
  for(const asOf of [decision.publishedAt,decision.cutoffTime]){
   const assessment=evaluateEvidencePriceRecommendation(decision,{asOf});assert(!assessment.reasons.includes('frozen-decision-invalid'));
   const parsed=parse({...raw,strategyAssessment:assessment});assert.equal(parsed.primary,null);assert.equal(parsed.companion,null);assert.equal(parsed.formalEligible,false);assert.equal(optionRows(render(parsed)).length,6);
   if(asOf===decision.cutoffTime)assert.equal(parsed.selectionStatus,'unavailable');
  }
 }
 assert.equal(JSON.stringify(input),before);
});

test('parser rejects unknown policy, detached identity or event binding, malformed hashes and invalid clocks',()=>rejects([
 ['unknown version',a=>{a.version='evidence-price-recommendation-v2';}],['live scope',a=>{a.scope='production';}],
 ['decision ID',a=>{a.decisionId='decision_'+'a'.repeat(64);}],['decision hash',a=>{a.decisionRecordHash='f'.repeat(64);}],
 ['source event',a=>{a.sourceMatchId='other-match';}],['event version',a=>{a.eventVersion='2030-01-01T00:00:00.000Z';}],['match day',a=>{a.businessDate='2030-01-01';}],
 ['assessment ID shape',a=>{a.id='assessment_invalid';}],['content hash shape',a=>{a.contentHash='invalid';}],['assessment clock',a=>{a.asOf='not-a-timestamp';}],
]));

test('parser rejects pseudo formal picks, calibrated claims and candidate promotion',()=>rejects([
 ['formal flag',a=>{a.formalEligible=true;}],['primary',a=>{a.primary=a.candidates[0];}],['companion',a=>{a.companion=a.candidates[1];}],
 ['missing primary',a=>{delete a.primary;}],['validated calibration',a=>{a.calibration.status='verified';}],['conservative probability',a=>{a.calibration.conservativeProbability=.8;}],
 ['candidate formal flag',a=>{a.candidates[0].formalEligible=true;}],['candidate calibrated probability',a=>{a.candidates[0].calibratedProbability=.5;}],
 ['candidate conservative probability',a=>{a.candidates[0].conservativeProbability=.5;}],['candidate conservative EV',a=>{a.candidates[0].conservativeExpectedValue=.2;}],
 ['nonpositive EV promotion',a=>{const c=a.candidates.find(c=>c.modelExpectedValue<0);c.researchValueEligible=true;c.reasons=[];a.eligibleCandidates=a.candidates.filter(c=>c.researchValueEligible);a.selectionStatus='research-value-candidates';}],
]));

test('finite-tree validation rejects NaN and infinities even outside the rendered candidate fields',()=>rejects([
 ['NaN probability',a=>{a.candidates[0].modelProbability=NaN;}],['infinite EV',a=>{a.candidates[0].modelExpectedValue=Infinity;}],
 ['negative infinite risk evidence',a=>{a.referenceDiagnostic.extra={values:[-Infinity]};}],['deep nonfinite calibration',a=>{a.calibration.extra={audit:{probability:NaN}};}],
]));

test('probability vectors and candidate EV, gap and break-even arithmetic cannot drift',()=>rejects([
 ['out of range vector',a=>{a.distributions.HAD.modelProbabilities['1']=1.1;}],
 ['unnormalized market vector',a=>{a.distributions.HAD.marketProbabilities.X+=.1;}],
 ['changed frozen vector',a=>{a.distributions.HAD.modelProbabilities['1']+=.01;a.distributions.HAD.modelProbabilities.X-=.01;}],
 ['conditional distribution',a=>{a.distributions.HHAD.probabilityBasis='conditional';}],['validated distribution',a=>{a.distributions.HAD.modelValidation='validated';}],
 ['candidate probability',a=>{a.candidates[0].modelProbability+=.01;}],['candidate EV',a=>{a.candidates[0].modelExpectedValue+=.1;}],
 ['candidate gap',a=>{a.candidates[0].modelMarketGap+=.1;}],['candidate break-even',a=>{a.candidates[0].breakEvenProbability+=.01;}],
 ['candidate odds',a=>{a.candidates[0].odds=1;}],['missing computed EV',a=>{a.candidates[0].modelExpectedValue=null;}],['conditional candidate',a=>{a.candidates[0].probabilityBasis='conditional';}],
]));

test('six candidate identities and the eligible subset must agree with the status',()=>rejects([
 ['missing candidate',a=>{a.candidates.pop();}],['duplicate market outcome',a=>{a.candidates[1]={...a.candidates[0],id:a.candidates[1].id};}],
 ['duplicate candidate ID',a=>{a.candidates[1].id=a.candidates[0].id;}],['unknown market',a=>{a.candidates[0].market='SCORE';}],
 ['invented eligible ID',a=>{a.eligibleCandidates=[{id:'option_unknown'}];}],
 ['duplicate eligible ID',a=>{a.eligibleCandidates=[a.candidates[0],a.candidates[0]];}],
 ['eligibility state mismatch',a=>{a.selectionStatus=a.eligibleCandidates.length?'observation':'research-value-candidates';}],
 ['nonboolean eligibility',a=>{a.candidates[0].researchValueEligible='false';}],
]));

test('self-consistent candidate SP/EV and fair-probability/gap rewrites cannot detach from their bound distribution',()=>rejects([
 ['self-consistent SP and EV',a=>{const c=a.candidates[0];c.odds+=1;c.modelExpectedValue=c.modelProbability*c.odds-1;c.breakEvenProbability=1/c.odds;}],
 ['self-consistent fair probability and gap',a=>{const c=a.candidates[0];c.marketProbability+=.01;c.modelMarketGap=c.modelProbability-c.marketProbability;}],
]));

test('an eligible copy with the same ID cannot change candidate values',()=>{
 const row=shadowEligibleFixture();assert.equal(parse(row).selectionStatus,'research-value-candidates');
 const changed=structuredClone(row);changed.strategyAssessment.eligibleCandidates[0].modelExpectedValue+=.01;
 assert.equal(changed.strategyAssessment.eligibleCandidates[0].id,row.strategyAssessment.eligibleCandidates[0].id);
 assert.throws(()=>parse(changed),/Strategy eligible candidate differs from source/);
});

test('eligible copies with recursively reordered object keys remain valid without changing shadow eligibility',()=>{
 const row=shadowEligibleFixture(),before=JSON.stringify(row),original=parse(row);
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
 const changed=structuredClone(row);changed.strategyAssessment.eligibleCandidates=changed.strategyAssessment.eligibleCandidates.map(reorder);
 assert.notDeepEqual(Object.keys(changed.strategyAssessment.eligibleCandidates[0]),Object.keys(row.strategyAssessment.eligibleCandidates[0]));
 const parsed=parse(changed);assert.equal(JSON.stringify(parsed),JSON.stringify(original));assert.equal(parsed.formalEligible,false);assert.equal(parsed.primary,null);assert.equal(parsed.companion,null);
 assert.match(render(parsed),/存在研究候选，仍非正式推荐/);assert.equal(JSON.stringify(row),before);
});
