"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {commitCurrentDataGeneration,resolveServingPublication,resolveServingPublicationForSqliteIdentity}=require("../server/dataGenerationBundle.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"football-native-identity-"));
const storeDir=path.join(root,"store"),publicDataDir=path.join(root,"public");fs.mkdirSync(publicDataDir);
const marker="UNRELATED_MODEL_PAYLOAD_MUST_NOT_BE_PARSED";
try{
  const files={"matches-current.json":[],"matches-history.json":[],"sync-meta.json":{sourceCycleId:"qa-native-identity",updatedAt:"2026-09-12T00:00:00Z"},
    "external-signals.json":{matches:{}},"odds-history.json":{rows:[]},"prediction-snapshots.json":{rows:[]},"model-calibration.json":{version:"qa",generatedAt:"2026-09-12T00:00:00Z",marker}};
  for(const [name,value]of Object.entries(files))fs.writeFileSync(path.join(publicDataDir,name),JSON.stringify(value));
  commitCurrentDataGeneration({storeDir,publicDataDir,sourceCycleId:"qa-native-identity"});
  const publication=resolveServingPublication({storeDir,publicDataDir});
  const options={storeDir,publicDataDir,sqliteIdentity:publication.identity,validatePayloadSemantics:false};
  const parse=JSON.parse;let unrelatedReads=0;
  JSON.parse=function(value,...args){if(String(value).includes(marker)){unrelatedReads++;throw Error("unexpected model materialization");}return parse(value,...args);};
  try{
    assert.equal(resolveServingPublicationForSqliteIdentity(options).identity.generationId,publication.identity.generationId);
    assert.equal(unrelatedReads,0);
    assert.throws(()=>resolveServingPublicationForSqliteIdentity({...options,validatePayloadSemantics:true}),/active data generation is invalid/);
    assert.ok(unrelatedReads>0);
  }finally{JSON.parse=parse;}
  assert.throws(()=>resolveServingPublicationForSqliteIdentity({...options,sqliteIdentity:{...publication.identity,manifestHash:"0".repeat(64)}}),/identity matches neither/);
  assert.throws(()=>resolveServingPublication({...options,validatePayloadSemantics:"false"}),/must be boolean/);
  const context=publication.context;const file=path.join(storeDir,"data-generations","generations",context.generationId,"model-calibration.json");
  assert.ok(fs.existsSync(file));fs.appendFileSync(file," ");
  assert.throws(()=>resolveServingPublicationForSqliteIdentity(options),/active data generation is invalid/);
  console.log(JSON.stringify({ok:true,checks:5,unrelatedPayloadNotParsed:true,defaultSemanticValidationRetained:true,hashTamperRejected:true,identityMismatchRejected:true}));
}finally{
  const resolved=path.resolve(root),parent=path.resolve(os.tmpdir())+path.sep;
  assert.ok(resolved.startsWith(parent)&&path.basename(resolved).startsWith("football-native-identity-"));fs.rmSync(resolved,{recursive:true,force:true});
}
