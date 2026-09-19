'use strict';
const {forecastInputFor}=require('../../src/services/prospectiveForecastInput.cjs');
const {warehouseQuoteForMatch}=require('../../src/services/warehouseLotterySp.cjs');
const {time}=require('../../src/services/publishedForecastPolicy.cjs');

/** Build a new decision input, never change a frozen parent or re-date a model.
 * Callers read both datasets in the same PostgreSQL transaction. A receipt
 * confirms the exact event, teams, prices and cutoff at its actual observation. */
function joinCurrentMarket(current, signals, now) {
  const grouped=new Map(),receiptHashes=new Set();
  for(const {signal} of signals){const key=String(signal.sourceMatchId);const rows=grouped.get(key)||[];rows.push(signal);grouped.set(key,rows);}
  const matches=current.map(row=>{
    const input=forecastInputFor(row);
    if(!input || (Object.hasOwn(row,'prospectiveForecastInput')&&!row.prospectiveForecastInput)
      || input.predictionMeta?.lockedAt || input.predictionMeta?.lockedReason)return row;
    const rows=grouped.get(String(input.sourceMatchId||input.id||'').replace(/^sporttery_/,''));
    if(rows?.length!==1)return row;
    const had=rows[0].bookmakerOdds?.had;
    const next={...input,externalSignals:{...input.externalSignals,bookmakerOdds:{...input.externalSignals?.bookmakerOdds,had}}};
    const deadlines=[input.kickoffTime,input.buyEndTime,input.predictionMeta?.cutoffTime].filter(v=>v!=null&&v!=='').map(time);
    const quote=warehouseQuoteForMatch(next,now,Math.min(...deadlines));
    if(!quote)return row;
    const previous=input.externalSignals?.bookmakerOdds?.had?.lotterySpReceipt;
    if(previous && time(previous.observedAt)>time(quote.at))return row;
    receiptHashes.add(quote.receipt.receiptHash);
    // Only this ephemeral snapshot pairs an unchanged, still-valid model with
    // a later observation. Its new immutable decision hash binds both clocks.
    return row.prospectiveForecastInput?{...row,prospectiveForecastInput:structuredClone(next)}:structuredClone(next);
  });
  return {current:matches,receiptHashes};
}
module.exports={joinCurrentMarket};
