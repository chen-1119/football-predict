'use strict';
// Select an existing archived business day. This never supplies the read clock
// or changes the current recommendation center's business day.
function parseReviewedHistoryQuery(params){
 const values=params.getAll('reviewedBusinessDate');
 if(!values.length)return undefined;
 const day=values[0],stamp=Date.parse(day+'T00:00:00Z');
 if(values.length!==1||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(stamp)
  ||new Date(stamp).toISOString().slice(0,10)!==day){
  throw Object.assign(Error('Invalid reviewed business date'),{code:'INVALID_REVIEWED_HISTORY_QUERY'});
 }
 return day;
}
module.exports={parseReviewedHistoryQuery};
