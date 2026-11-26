'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {load,JSON_FILES}=require('../scripts/expandedLeagueTrainingInput.cjs');
const {PIN}=require('../scripts/collectExpandedLeagueHistory.cjs');
const {parse,hash}=require('../scripts/expandedLeagueHistoryParser.cjs');
const trainer=require('../scripts/runLeagueBaselineExperiment.cjs');
const model=require('../src/services/leagueBaselineModel.cjs');
const registry=require('../scripts/leagueBaselineRegistry.cjs');
const expanded=require('../scripts/runExpandedLeagueBaselineExperiment.cjs');
const registration=require('../scripts/registerExpandedLeagueBaseline.cjs');
function historyFixture(action){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'football-expanded-training-'));
  try{
    fs.mkdirSync(path.join(directory,'raw'));
    const license=Buffer.from('CC0 1.0 Universal'),knownAt='2026-10-09T16:41:07.028Z';
    fs.writeFileSync(path.join(directory,'raw','LICENSE.md'),license);
    const document={version:'expanded-league-history-v1',knownAt,source:{repo:'https://github.com/openfootball/football.json.git',commit:PIN,licenseHash:hash(license)},files:[],rows:[]};
    for(const file of JSON_FILES){
      const [season,base]=file.split('/'),league=base.replace('.json','');
      const raw=Buffer.from(JSON.stringify({name:'Synthetic '+season.replace('-','/'),matches:[{date:season.slice(0,4)+'-08-15',team1:'Alpha',team2:'Bravo',score:{ft:[2,1]}}]}));
      const parsed=parse(raw,{league,season,knownAt}),source={file,league,season,sha256:hash(raw),bytes:raw.length,sourceUrl:`https://raw.githubusercontent.com/openfootball/football.json/${PIN}/${file}`,rows:parsed.rows.length,excluded:parsed.excluded.length};
      document.files.push(source);document.rows.push(...parsed.rows.map(row=>({...row,sourceSha256:source.sha256,sourceUrl:source.sourceUrl})));
      fs.writeFileSync(path.join(directory,'raw',file.replace('/','-')),raw);
    }
    const target=path.join(directory,'history.json');
    const save=()=>fs.writeFileSync(target,JSON.stringify({...document,contentHash:hash(JSON.stringify(document))}));save();
    return action({directory,document,target,save});
  }finally{
    assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('football-expanded-training-'));
    fs.rmSync(directory,{recursive:true});
  }
}
test('expanded loader verifies fixed complete original files and keeps real availability',()=>historyFixture(({target})=>{
  const verified=load(target,'nl.1','2026-10-23T00:00:00.000Z');
  assert.equal(verified.rows.length,6);assert(verified.rows.every(row=>row.league==='nl.1'&&row.historicalKnownAt===null));
  assert.equal(verified.productionWrites,0);
}));
for(const [label,mutate,pattern]of [
  ['derived score',document=>document.rows[0].homeGoals++,/raw rows differ/],
  ['source league',document=>document.files[0].league='nl.1',/file league identity/],
  ['missing file',document=>document.files.pop(),/source coverage/],
  ['future receipt',document=>document.knownAt='2099-01-01T00:00:00.000Z',/availability/],
  ['path escape',document=>document.files[0].file='../other.json',/source coverage/],
  ['upstream pin',document=>document.source.commit='a'.repeat(40),/commit/]
])test('expanded loader rejects '+label,()=>historyFixture(({document,target,save})=>{mutate(document);save();assert.throws(()=>load(target,'nl.1'),pattern);}));
test('raw bytes remain authoritative after an outer hash is recomputed',()=>historyFixture(({directory,target,document,save})=>{
  fs.appendFileSync(path.join(directory,'raw',document.files[0].file.replace('/','-')),' ');save();
  assert.throws(()=>load(target,'nl.1'),/raw source hash/);
}));
test('replayed report binds the original source and implementation; insufficient samples cannot prepare',()=>historyFixture(({directory,target})=>{
  const output=path.join(directory,'experiment.json');expanded.run(target,'nl.1',output);
  const source=load(target,'nl.1'),bytes=fs.readFileSync(output),report=expanded.inspect(source,bytes,'nl.1');
  assert.equal(report.reports[0].status,'blocked');
  assert.throws(()=>registration.build(target,output,'nl.1',[],'2099-01-01T00:00:00.000Z'),/PREPARED_CLOCK/);
  assert.throws(()=>registration.build(target,output,'nl.1'),/HOLDOUT_BLOCKED/);
  assert.throws(()=>expanded.run(target,'nl.1',output),/new absolute output/);
  for(const change of [value=>value.reports[0].statisticalGatePassed=true,value=>value.inputSha256='a'.repeat(64),value=>value.implementation['runLeagueBaselineExperiment.cjs']='a'.repeat(64)]){
    const {contentHash,...body}=structuredClone(report);change(body);
    assert.throws(()=>expanded.inspect(source,Buffer.from(JSON.stringify({...body,contentHash:hash(JSON.stringify(body))})),'nl.1'));
  }
}));
function synthetic(){return [2023,2024,2025].flatMap(year=>Array.from({length:110},(_,index)=>({id:`${year}-${index}`,league:'nl.1',
  date:new Date(Date.UTC(year,0,1+index)).toISOString().slice(0,10),home:index%2?'Alpha':'Bravo',away:index%2?'Bravo':'Alpha',homeGoals:index%3?2:0,awayGoals:index%5?1:0})));}
test('new real league IDs use the existing fit without renaming to Brazil',()=>{
  const rows=synthetic(),result=trainer.experiment(rows);assert.equal(result.reports[0].league,'nl.1');
  assert.throws(()=>trainer.experiment(rows.map(row=>({...row,league:'unsupported'}))),/date\/league/);
});
test('2025 labels cannot alter 2024 selection or held-out parameters for expanded leagues',()=>{
  const rows=synthetic(),first=trainer.experiment(rows).reports[0];
  const changed=trainer.experiment(rows.map(row=>row.date.startsWith('2025')?{...row,homeGoals:8,awayGoals:0}:row)).reports[0];
  assert.deepEqual(first.selection,changed.selection);assert.deepEqual(first.holdoutModel,changed.holdoutModel);assert.notDeepEqual(first.evaluation,changed.evaluation);
});
test('registry allows only exact league and immutable history keys',async()=>{
  const client={async query(){throw Error('EXPECTED_SQL_REACHED');}};
  await assert.rejects(registry.put(client,'league-baseline-nl.1',{}),/EXPECTED_SQL_REACHED/);
  await assert.rejects(registry.put(client,'league-baseline-nl.1-history-'+'a'.repeat(64),{}),/EXPECTED_SQL_REACHED/);
  for(const key of ['league-baseline-nlX1','league-baseline-jp.1','league-baseline-nl.1-history-'+ 'a'.repeat(63),'league-baseline-nl.1-history-'+ 'a'.repeat(64)+'-extra'])
    await assert.rejects(registry.put(client,key,{}),/WRITE_KEY_SCOPE/);
});
const {fixture,poolAt}=require('./league-model-adoption.test.cjs');
test('expanded league uses existing CAS, immutable history, replay and model validation',async()=>{
  const source=fixture(),{contentHash,...body}=source.packet,packet=model.seal({...body,league:'nl.1'});
  assert.equal(model.verifyPacket(packet,source.asOf).valid,true);
  const database=poolAt(Date.parse(source.asOf)-1000);
  const installed=await registry.install(packet,{pool:database.pool,expectedSha256:null});assert.equal(installed.key,'league-baseline-nl.1');
  assert.equal(installed.formalEligible,false);assert.equal(installed.recommendationAdoptionConfirmed,false);
  const loaded=await registry.load(database.client,source.asOf);assert.equal(loaded.packets.length,1);assert.equal(loaded.packets[0].league,'nl.1');
  await assert.rejects(registry.install(packet,{pool:database.pool,expectedSha256:null}),/REGISTRY_CHANGED/);
  const parameters={...packet.parameters,poissonWeight:.75};
  const mixed=model.seal({...body,league:'nl.1',parameters,parametersHash:model.hash(parameters)});
  assert.deepEqual(model.verifyPacket(mixed,source.asOf),{valid:false,blockers:['LEAGUE_MODEL_MODEL_SCOPE']});
});
