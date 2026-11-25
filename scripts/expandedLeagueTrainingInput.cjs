'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {parse,parseText,PIN}=require('./collectExpandedLeagueHistory.cjs');
const {hash,instant}=require('./expandedLeagueHistoryParser.cjs');
const {LEAGUES}=require('../src/services/leagueBaselineScope.cjs');
const TEXT_PIN='0bf83f88e8feb22904c5f9d93c6407574c1347e0';
const TEXT_LEAGUES={sweden:'se.1',norway:'no.1',netherlands:'nl.2'};
const JSON_FILES=['2021-22','2022-23','2023-24','2024-25','2025-26'].flatMap(season=>
  ['de.1','de.2','en.1','en.2','es.1','fr.1','it.1','nl.1','pt.1'].map(league=>`${season}/${league}.json`))
  .concat(['2024-25/fr.2.json','2025-26/fr.2.json','2025/br.1.json','2025/jp.1.json','2026/br.1.json'],
    ['de.1','en.1','en.2','es.1','fr.1','it.1','nl.1','pt.1'].map(league=>`2026-27/${league}.json`));
const TEXT_FILES=['2021-22','2022-23','2023-24','2024-25'].map(season=>`netherlands/${season}_nl2.txt`)
  .concat(['norway','sweden'].flatMap(directory=>[2023,2024,2025].map(season=>`${directory}/${season}_${directory==='norway'?'no1':'se1'}.txt`)));
function load(file,league,asOf=new Date().toISOString()){
  assert(path.isAbsolute(file)&&LEAGUES.includes(league)&&!['br1','fi1'].includes(league),'expanded league input scope');
  assert(instant(asOf)&&fs.statSync(file).size<=16*1024*1024,'input bound/clock');
  const bytes=fs.readFileSync(file),document=JSON.parse(bytes),{contentHash,...body}=document;
  assert.equal(hash(JSON.stringify(body)),contentHash,'history content hash');
  const text=document.version==='expanded-text-history-v1';
  assert(text||document.version==='expanded-league-history-v1','history version');
  const pin=text?TEXT_PIN:PIN,repo=text?'europe':'football.json';
  assert.equal(text?document.commit:document.source?.commit,pin,'history commit');
  if(!text)assert.equal(document.source.repo,'https://github.com/openfootball/football.json.git','history repository');
  assert(instant(document.knownAt)&&document.knownAt<=asOf,'history availability');
  const license=fs.readFileSync(path.join(path.dirname(file),'raw','LICENSE.md'));
  assert(license.toString('utf8').startsWith('CC0 1.0 Universal'),'history license');
  if(!text)assert.equal(hash(license),document.source.licenseHash,'history license hash');
  assert(Array.isArray(document.files)&&document.files.length>=1&&document.files.length<=120,'file count');
  assert.deepEqual(document.files.map(source=>source.file).sort(),[...(text?TEXT_FILES:JSON_FILES)].sort(),'source coverage');
  const rederived=[],seen=new Set();
  for(const source of document.files){
    assert(typeof source.file==='string'&&/^[a-z0-9._\/-]+$/.test(source.file)&&source.file.split('/').length===2
      &&!source.file.split('/').includes('..')&&!seen.has(source.file),'source path');
    seen.add(source.file);
    const sourceLeague=text?TEXT_LEAGUES[source.file.split('/')[0]]:source.league;
    const season=text?path.basename(source.file).split('_')[0]:source.season;
    if(!text)assert.equal(source.file,`${season}/${sourceLeague}.json`,'file league identity');
    assert.equal(source.sourceUrl,`https://raw.githubusercontent.com/openfootball/${repo}/${pin}/${source.file}`,'source URL');
    const rawPath=path.join(path.dirname(file),'raw',source.file.replace('/','-'));
    assert(fs.statSync(rawPath).size<=2*1024*1024,'raw bound');
    const raw=fs.readFileSync(rawPath);assert.equal(hash(raw),source.sha256,'raw source hash');
    if(source.bytes!==undefined)assert.equal(raw.length,source.bytes,'raw source bytes');
    const parsed=(text?parseText:parse)(raw,{league:sourceLeague,season,knownAt:document.knownAt});
    assert.equal(parsed.rows.length,source.rows,'parsed row count');
    assert.equal(parsed.excluded.length,source.excluded,'parsed exclusion count');
    rederived.push(...parsed.rows.map(row=>({...row,sourceSha256:source.sha256,sourceUrl:source.sourceUrl})));
  }
  assert.equal(hash(JSON.stringify(rederived)),hash(JSON.stringify(document.rows)),'raw rows differ');
  const rows=rederived.filter(row=>row.league===league);
  assert(rows.length>0&&rows.length<=10000,'league row bound');
  assert(rows.every(row=>row.knownAt===document.knownAt&&row.date<document.knownAt.slice(0,10)
    &&row.historicalKnownAt===null&&row.actualEndedAt===null),'label availability');
  return {bytes,document,rows,sha256:hash(bytes),sourceFiles:document.files.map(source=>({url:source.sourceUrl,sha256:source.sha256,receivedAt:document.knownAt})),
    historicalAsOfVerified:false,productionWrites:0};
}
module.exports={load,JSON_FILES,TEXT_FILES};
