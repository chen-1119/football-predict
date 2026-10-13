'use strict';
const {epochNanoseconds: instant}=require('./prematchV3Clock.cjs');
const VERSION='sporttery-eleven-opening-v1';
// User-selected daily publication boundary. This is not a claim about the
// provider's national opening rules, nor a replacement for actual sale permits.
function openingAtForBusinessDate(businessDate){
  if(typeof businessDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))return null;
  const at=businessDate+'T03:00:00.000Z';
  return instant(at)===null?null:at;
}
function assessOpening({businessDate,asOf}={}){
  const openingAt=openingAtForBusinessDate(businessDate),now=instant(asOf);
  if(openingAt===null||now===null)return {eligible:false,reason:'opening-clock-invalid',openingAt};
  return {eligible:now>=instant(openingAt),reason:now<instant(openingAt)?'opening-not-reached':'opening-ready',openingAt};
}
function assessQuoteOpening({businessDate,asOf,requestedAt,receivedAt}={}){
  const result=assessOpening({businessDate,asOf});if(!result.eligible)return result;
  const requested=instant(requestedAt),received=instant(receivedAt),now=instant(asOf);
  if(requested===null||received===null||requested>received||received>now)
    return {...result,eligible:false,reason:'opening-clock-invalid'};
  if(requested<instant(result.openingAt)||received<instant(result.openingAt))
    return {...result,eligible:false,reason:'quote-acquired-before-opening'};
  return result;
}
// Call ONLY after the maker has independently verified model, exact event and
// each signed market payload. This adds acquisition clocks, never source trust.
function assessPaperOpening(record,asOf){
  const businessDate=record?.event?.businessDate??record?.businessDate;
  const result=assessOpening({businessDate,asOf});if(!result.eligible)return result;
  const decision=assessOpening({businessDate,asOf:record?.decisionAt??asOf});if(!decision.eligible)return decision;
  const markets=['HAD','HHAD'].filter(k=>record?.markets?.[k]?.quote);
  if(!markets.length)return {...result,eligible:false,reason:'opening-clock-invalid'};
  for(const market of markets){
    const quote=record.markets[market].quote;
    const next=assessQuoteOpening({businessDate,asOf,requestedAt:quote.requestedAt,receivedAt:quote.receivedAt});
    if(!next.eligible)return next;
  }
  if(markets.includes('HHAD')){
    // HHAD uses a calculator price and the separate current event's sale state.
    // Both signed source acquisitions must be in this business day's window.
    const endpoints=record?.privateInputs?.quoteSnapshot?.endpoints;
    for(const method of ['current','calculator']){
      const rows=Array.isArray(endpoints)?endpoints.filter(e=>e?.method===method&&e?.page==null):[];
      if(rows.length!==1)return {...result,eligible:false,reason:'opening-clock-invalid'};
      const next=assessQuoteOpening({businessDate,asOf,requestedAt:rows[0].requestedAt,receivedAt:rows[0].receivedAt});
      if(!next.eligible)return next;
    }
  }
  return result;
}
// New-publication filter only. Historical receipt/decision replay is separate.
// The existing assessment must first verify the HAD receipt and input capture.
function assessDecisionOpening(record,asOf,{trustRegistry}={}){
  const businessDate=record?.businessDate,receipt=record?.quoteProvenance;
  const result=assessOpening({businessDate,asOf});if(!result.eligible)return result;
  const invalid=()=>({...result,eligible:false,reason:'opening-clock-invalid'});
  if(!['signed-live-had-receipt-v1','signed-live-had-receipt-v2'].includes(receipt?.version)
    ||receipt.requestedAt!==receipt.endpoint?.requestedAt||receipt.observedAt!==receipt.endpoint?.receivedAt)return invalid();
  const had=assessQuoteOpening({businessDate,asOf,requestedAt:receipt.requestedAt,receivedAt:receipt.observedAt});
  if(!had.eligible)return had;
  const market=record?.handicapAnalysis?.marketReference;if(!market)return result;
  const proof=market.quoteProvenance,audit=record?.inputCapture?.officialHandicap;
  const commitment=proof?.attestation?.commitment;
  if(proof?.version!=='signed-live-handicap-v1'||audit?.status!=='source-verified')return invalid();
  const {sha256CollectorJson:sha,verifyCollectorAttestation:verify}=require('./collectorAttestation.cjs');
  if(commitment?.provider!=='sporttery'||commitment.endpoint?.method!=='GET'||commitment.endpoint?.page!==null
    ||commitment.endpoint?.role!=='calculator'
    ||!require('../../server/relayCollectorEvidence.cjs').officialFastEndpointUrl('calculator',commitment.endpoint.url))return invalid();
  if(!verify(proof.attestation,{trustRegistry}).eligible||sha(commitment)!==proof.commitmentHash
    ||proof.payloadHash!==commitment.canonicalPayloadSha256||proof.sourceCycleId!==commitment.collectorCycleId
    ||proof.receivedAt!==commitment.receivedAt)return invalid();
  const current=audit.endpoints?.current,calculator=audit.endpoints?.calculator;
  if([current,calculator].some(e=>e?.reason!=='verified'||e.collectorSignatureVerified!==true)
    ||current.sourceCycleId!==calculator.sourceCycleId||calculator.sourceCycleId!==proof.sourceCycleId
    ||calculator.commitmentHash!==proof.commitmentHash||calculator.payloadHash!==proof.payloadHash
    ||current.commitmentHash!==sha(receipt.endpoint.collectorAttestation?.commitment)
    ||current.payloadHash!==sha(receipt.endpoint.payload)
    ||current.requestedAt!==receipt.requestedAt||current.receivedAt!==receipt.observedAt
    ||calculator.requestedAt!==commitment.requestedAt||calculator.receivedAt!==commitment.receivedAt)return invalid();
  for(const e of [current,calculator]){
    const next=assessQuoteOpening({businessDate,asOf,requestedAt:e.requestedAt,receivedAt:e.receivedAt});
    if(!next.eligible)return next;
  }
  return result;
}
// Only the new ephemeral assessment changes. A stale/unverified HHAD atom must
// not displace an independently eligible HAD quote. Keep the raw PG parent and
// frozen records intact; reattach HHAD only through the original signed join.
function filterNewOpeningMarkets(current,snapshot,{asOf,trustRegistry}={}){
  if(!Array.isArray(current))return current;
  const {forecastInputFor}=require('./prospectiveForecastInput.cjs');
  const fields=['handicapOdds','handicapLine','handicapOddsSource','handicapOddsPoolCode',
    'handicapOddsReceivedAt','handicapOddsObservedAt','handicapOddsUpdatedAt','handicapOddsSourceUrl','handicapQuoteProvenance'];
  const stripped=current.map(row=>{
    const input=forecastInputFor(row);if(!input)return row;
    const copy=structuredClone(row),next=copy.prospectiveForecastInput||copy;
    for(const field of fields)delete next[field];
    if(next.externalSignals?.bookmakerOdds)delete next.externalSignals.bookmakerOdds.hhad;
    return copy;
  });
  const endpoints=Array.isArray(snapshot?.endpoints)?snapshot.endpoints:[];
  const eligible=stripped.map(row=>{
    const input=forecastInputFor(row);if(!input)return false;
    return ['current','calculator'].every(method=>{
      const sources=endpoints.filter(e=>e?.method===method&&e?.page==null);
      return sources.length===1&&assessQuoteOpening({businessDate:input.businessDate,asOf,
        requestedAt:sources[0].requestedAt,receivedAt:sources[0].receivedAt}).eligible;
    });
  });
  if(!eligible.some(Boolean))return stripped;
  const epoch=instant(asOf);
  const joined=require('../../scripts/recommendationPlatform/liveOfficialHandicap.cjs').joinOfficialHandicap(stripped,snapshot,
    {now:Number(epoch/1000000n),trustRegistry});
  return stripped.map((row,index)=>eligible[index]?joined[index]:row);
}
module.exports={VERSION,openingAtForBusinessDate,assessOpening,assessQuoteOpening,assessPaperOpening,assessDecisionOpening,filterNewOpeningMarkets};
