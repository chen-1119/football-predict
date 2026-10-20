'use strict';
// A separate editorial read DTO. No native/model match row is invented, and
// no mutable current/history or original reference companion is repaired.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const runtime=require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const {transaction}=require('../scripts/recommendationPlatform/leagueBaselineRuntime.cjs');
const VERSION='official-editorial-reference-view-v1',MAX_BYTES=512*1024;
async function read(pool,businessDate){
 p.check(typeof businessDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(businessDate)
  &&new Date(businessDate+'T00:00:00Z').toISOString().slice(0,10)===businessDate,'OFFICIAL_REFERENCE_DAY');
 return transaction(pool,true,async client=>{
  const value=(await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  const asOf=value instanceof Date?value.toISOString():value;
  p.check(Number.isFinite(Date.parse(asOf)),'OFFICIAL_REFERENCE_CLOCK');
  let view=await runtime.projection(client,businessDate,asOf,{historical:true});
  // Recover only genuinely committed original group archives. Reading never
  // creates an anchor or recalculates a purported historical combination.
  view=await require('./researchFrozenCombos.cjs').freezeOriginalGroups(client,view,asOf,{anchor:false});
  const officialEventIds=view.records.filter(r=>r.eventAuthority?.version==='signed-official-events-v1').map(r=>r.eventId);
  // Only normal immutable revision chains with their own second ACK can
  // replace the displayed decision. Missing result heads remain PENDING.
  const revisions=officialEventIds.length
   ?await require('./researchReviewProjection.cjs').projection(client,view,asOf,[])
   :null;
  const result={version:VERSION,businessDate,updatedAt:asOf,original:view,officialEventIds,revisions,
   formalEligible:false,modelAdoption:false};
  p.check(Buffer.byteLength(JSON.stringify(result))<=MAX_BYTES,'OFFICIAL_REFERENCE_BOUND');
  return result;
 });
}
module.exports={VERSION,MAX_BYTES,read};
