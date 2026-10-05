'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {buildExperiment,compareVersions,validSeal}=require('./recommendationPlatform/strategyVersionComparison.cjs');
const {buildPublicReferenceArchive}=require('./recommendationPlatform/publicStrategyReferenceComparison.cjs');
const fileHash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const writeNew=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n',{flag:'wx'});};
function main(){
  const mode=process.argv[2],output=arg('--output');
  if(!output)throw new Error('--output directory is required');
  if(mode==='freeze'){
    const input=arg('--input'),publicInput=arg('--public-reference-input');if(!input||!publicInput)throw new Error('--input and --public-reference-input readonly online exports are required');
    const codeFiles=['scripts/recommendationPlatform/strategyVersionComparison.cjs','src/services/evidencePriceRecommendationPolicy.cjs',
      'src/services/recommendationSelectionQuality.cjs','src/services/publishedScoreDistribution.cjs','scripts/recommendationPlatform/results.cjs',
      'scripts/recommendationPlatform/publicStrategyReferenceComparison.cjs','scripts/runRecommendationVersionComparison.cjs'];
    const codeCommit=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const sourceBytes=fs.readFileSync(input),snapshot=JSON.parse(sourceBytes.toString('utf8'));
    const publicBytes=fs.readFileSync(publicInput),publicReferenceArchive=buildPublicReferenceArchive(publicBytes,snapshot.latestFull,
      {sourceSha256:crypto.createHash('sha256').update(publicBytes).digest('hex'),businessDate:snapshot.latestFull[0].businessDate});
    const experiment=buildExperiment(sourceBytes,{generatedAt:new Date().toISOString(),sourceSha256:crypto.createHash('sha256').update(sourceBytes).digest('hex'),codeCommit,
      codeHashes:Object.fromEntries(codeFiles.map(p=>[p,fileHash(p)])),publicReferenceArchive});
    const report=compareVersions(experiment.shadow,experiment.archive,snapshot.currentResultHeads||[],{asOf:experiment.shadow.generatedAt,publicReferenceArchive});
    // Refuse to rewrite either frozen artifact. Results are separate new files.
    if(['shadow-manifest.json','original-archive-manifest.json','public-reference-archive-manifest.json'].some(p=>fs.existsSync(path.join(output,p))))throw new Error('Frozen experiment already exists; cannot overwrite');
    writeNew(path.join(output,'public-reference-archive-manifest.json'),publicReferenceArchive);
    writeNew(path.join(output,'original-archive-manifest.json'),experiment.archive);
    writeNew(path.join(output,'shadow-manifest.json'),experiment.shadow);
    writeNew(path.join(output,`comparison-${Date.parse(report.asOf)}.json`),report);
    console.log(JSON.stringify({mode,generatedAt:experiment.shadow.generatedAt,shadowContentHash:experiment.shadow.contentHash,
      archiveContentHash:experiment.archive.contentHash,matches:experiment.shadow.rows.length,archiveVersions:experiment.archive.rows.length,
      publicReferences:publicReferenceArchive.rows.length,formalEligible:0,results:report.finalConfirmed,productionWrites:0}));
  }else if(mode==='compare'){
    const input=arg('--results');if(!input)throw new Error('--results timestamped readonly online export is required');
    const shadow=JSON.parse(fs.readFileSync(path.join(output,'shadow-manifest.json'),'utf8'));
    const archive=JSON.parse(fs.readFileSync(path.join(output,'original-archive-manifest.json'),'utf8'));
    const publicReferenceArchive=JSON.parse(fs.readFileSync(path.join(output,'public-reference-archive-manifest.json'),'utf8'));
    if(!validSeal(shadow)||!validSeal(archive))throw new Error('Frozen file hash changed');
    const resultBytes=fs.readFileSync(input),source=JSON.parse(resultBytes.toString('utf8'));
    if(source.readOnly!=='on'||source.productionWrites!==0||!source.observedAt||!Array.isArray(source.currentResultHeads))throw new Error('A timestamped readonly result export is required');
    const report=compareVersions(shadow,archive,source.currentResultHeads,{asOf:source.observedAt,publicReferenceArchive});
    const evidence={version:'readonly-result-comparison-evidence-v1',report,resultSourceFileSha256:crypto.createHash('sha256').update(resultBytes).digest('hex'),asOf:report.asOf};
    writeNew(path.join(output,`comparison-${Date.parse(report.asOf)}.json`),evidence);
    console.log(JSON.stringify({mode,asOf:report.asOf,finalConfirmed:report.finalConfirmed,matches:report.independentMatchCount,
      summary:report.summary,archiveCohorts:report.archiveCohorts.length,productionWrites:0}));
  }else throw new Error('Use freeze or compare');
}
try{main();}catch(error){console.error(error.message);process.exitCode=1;}
