'use strict';
// These are clocks of accepted immutable decisions, never a freshness bypass.
// Repeated quote observations are not new odds movements or independent games.
function summarizeQuotePublicationLatency(decisions){
  const rows=[];
  for(const d of decisions){
    const p=d?.quoteProvenance;
    if(d?.quoteSource!=='sporttery:HAD:signed-live'||p?.version!=='signed-live-had-receipt-v1')continue;
    const requested=Date.parse(p.requestedAt),received=Date.parse(p.observedAt),published=Date.parse(d.publishedAt);
    if(![requested,received,published].every(Number.isSafeInteger)||requested>received||received>published)continue;
    rows.push({sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,decisionId:d.decisionId,
      receiptHash:p.receiptHash,requestedAt:p.requestedAt,receivedAt:p.observedAt,publishedAt:d.publishedAt,
      collectionDurationMs:received-requested,publicationLagMs:published-received,
      acquisitionToPublicationMs:published-requested});
  }
  rows.sort((a,b)=>a.sourceMatchId.localeCompare(b.sourceMatchId)||a.decisionId.localeCompare(b.decisionId));
  const lag=rows.map(r=>r.publicationLagMs).sort((a,b)=>a-b);
  return {version:'signed-had-publication-latency-v1',
    meaning:'actual receipt acquisition to this immutable decision publication; not first-publication latency or odds movement',
    measuredRows:rows.length,minMs:lag.length?lag[0]:null,maxMs:lag.length?lag.at(-1):null,
    p95Ms:lag.length?lag[Math.ceil(lag.length*.95)-1]:null,rows};
}
module.exports={summarizeQuotePublicationLatency};
