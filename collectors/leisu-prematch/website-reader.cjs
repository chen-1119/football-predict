'use strict';
// Preserve the established injury/lineup validators and their public contract.
const legacy=require('./legacy-website-reader.cjs');
function createWebsiteReader(options){
  const enabled=options?.sourceReader||process.env.FOOTBALL_DATA_SOURCES_ENABLED==='1';
  if(!enabled)return legacy.createWebsiteReader(options);
  return async siteMatchId=>{
    if(typeof siteMatchId!=='string'||!/^sporttery_[1-9]\d*$/.test(siteMatchId))return {status:'invalid-id',predictionEligible:false};
    // One authoritative fixture read for both providers. No network access is
    // performed in this GET path, and an optional source never blocks the old view.
    const fixture=await options.readFixture(siteMatchId);
    if(!fixture||fixture.id!==siteMatchId)return {matchId:siteMatchId,status:'missing',predictionEligible:false};
    const base=legacy.createWebsiteReader({...options,readFixture:async()=>fixture});
    const factsReader=options.sourceReader||require('../football-sources/reader.cjs').readFacts;
    const [old,supplementary]=await Promise.all([
      base(siteMatchId).catch(()=>({matchId:siteMatchId,status:'unavailable',predictionEligible:false})),
      Promise.resolve().then(()=>factsReader(fixture)).catch(()=>({status:'source-store-unavailable',fields:{},predictionEligible:false})),
    ]);
    const any=supplementary&&Object.values(supplementary.fields||{}).some(s=>s.data);
    return {...old,...(any&&!['ok','partial'].includes(old.status)?{status:'partial'}:{}),supplementary:supplementary||{status:'awaiting-first-collection',fields:{},predictionEligible:false}};
  };
}
function createWebsiteHandler(options){
  if(typeof options?.authorize!=='function')throw new TypeError('An explicit website authorization callback is required');
  const read=createWebsiteReader(options);
  return async(req,res,id)=>{
    const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'});res.end(req.method==='HEAD'?'':JSON.stringify(body));};
    if(!['GET','HEAD'].includes(req.method))return send(405,{status:'method-not-allowed'});
    let ok=false;try{ok=await options.authorize(req)===true;}catch{}
    if(!ok)return send(401,{status:'unauthorized'});
    try{const data=await read(id);return send(data.status==='invalid-id'?400:data.status==='missing'?404:200,data);}catch{return send(503,{status:'unavailable',predictionEligible:false});}
  };
}
module.exports={...legacy,createWebsiteReader,createWebsiteHandler};
