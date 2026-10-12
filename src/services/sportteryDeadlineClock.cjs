'use strict';
const {strictInstant}=require('./strictInstant.cjs');
// Sporttery's buyEndTime is a Beijing-local YYYY-MM-DD HH:mm:ss contract.
// Preserve original payload bytes. Only this identified field, or its exact
// copied cutoff alias, can be interpreted using that documented source zone.
function sportteryDeadlineClock(match,value,{field='buyEndTime'}={}) {
 const zoned=strictInstant(value);
 if(zoned) return {instant:zoned,normalization:null};
 const sourceId=match?.sourceMatchId;
 const identified=typeof sourceId==='string'&&/^\d{1,20}$/.test(sourceId)
  && match?.id===`sporttery_${sourceId}`;
 const copiedAlias=field!=='buyEndTime'&&value===match?.buyEndTime;
 if(!identified||!(field==='buyEndTime'||copiedAlias)||typeof value!=='string'
   ||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return {instant:null,normalization:null};
 const instant=strictInstant(value.replace(' ','T')+'+08:00');
 return {instant,normalization:instant?{field,raw:value,instant,timeZone:'Asia/Shanghai',
  basis:'sporttery-buyEndTime-contract',copiedFrom:copiedAlias?'buyEndTime':null}:null};
}
module.exports={sportteryDeadlineClock};
