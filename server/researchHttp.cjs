'use strict';
// The prefix-wide read handler must not consume authenticated POST mutations.
function createResearchHttp({accounts,reader,submit,readiness}={}){
 const ready=require('./researchPublishReadiness.cjs').createReadinessHandler({accounts,observe:readiness});
 const write=require('./researchWriteHttp.cjs').createResearchWriteHandler({accounts,submit});
 const read=require('./researchArchiveRead.cjs').createResearchArchiveHandler({reader,authenticate:req=>accounts.authenticate(req)});
 return async(req,res,url)=>await ready(req,res,url)||await write(req,res,url)||await read(req,res,url);
}
module.exports={createResearchHttp};
