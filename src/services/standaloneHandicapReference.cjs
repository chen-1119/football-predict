'use strict';

// Pure, independent HHAD reference adapter. This module has no production
// repository, writer, scheduler, migration or formal-promotion adapter.
const path = require('node:path');
const { hash, time, day, probabilities } = require('./publishedForecastPolicy.cjs');
const { forecastInputFor } = require('./prospectiveForecastInput.cjs');
const { buildInputEvidence, validInputEvidence } = require('./recommendationInputEvidence.cjs');
const { buildHandicapMarginDecision, validHandicapMarginDecision } = require('./handicapMarginDecision.cjs');
const { selectionQuality, VERSION: QUALITY_VERSION } = require('./recommendationSelectionQuality.cjs');
const { MATERIAL_ABSOLUTE_MARKET_GAP, eventRange, eventsConflict } = require('./evidencePriceRecommendationPolicy.cjs');
const { verifyCollectorAttestation, loadCollectorTrustRegistry, extractionFromSportteryPool } = require('./collectorAttestation.cjs');
const { expectedCollectorCommitment, officialFastEndpointUrl } = require('../../server/relayCollectorEvidence.cjs');
const { attestPublicReferenceDecision } = require('./publicReferenceDecision.cjs');
const { verifyPublicReferenceEvidence } = require('./publicReferenceEvidence.cjs');
const { validResultEvent, key } = require('../../scripts/recommendationPlatform/results.cjs');

const VERSION = 'independent-handicap-reference-v1';
const TRACK = 'independent-handicap-reference-only';
const CODES = ['1', 'X', '2'];
const MAX_AGE = 15 * 60000;
const MAX_ENDPOINT_BYTES = 4 * 1024 * 1024;
const clone = v => v == null ? null : structuredClone(v);
const sourceId = v => String(v || '').replace(/^sporttery_/, '').trim();
const identity = v => typeof v === 'string' && v.trim().length > 0;
const top = p => CODES.reduce((best,c) => p[c] > p[best] + 1e-12 ? c : best, '1');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const registryFor = value => loadCollectorTrustRegistry(value || process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || path.resolve(__dirname, '../../deploy/light-server/collector-trust-registry.json'));

function inputSnapshotFor(match) {
  const input = forecastInputFor(match), model = input?.probabilityModel;
  if (!input || !model) return null;
  const evidence = model.inputEvidence || buildInputEvidence(model, input);
  if (!evidence || !validInputEvidence(evidence,model,input)) return null;
  const fields = ['id','sourceMatchId','eventVersion','businessDate','kickoffTime','buyEndTime','cutoffAt','cutoffTime','status','resultDisposition',
    'isOnSale','saleStatus','homeTeamId','awayTeamId','homeTeamName','awayTeamName','leagueId','matchNo'];
  const value = Object.fromEntries(fields.filter(k => input[k] !== undefined).map(k => [k,clone(input[k])]));
  value.predictionMeta = { cutoffTime:input.predictionMeta?.cutoffTime || null,
    lockedAt:input.predictionMeta?.lockedAt || null,lockedReason:input.predictionMeta?.lockedReason || null };
  value.probabilityModel = { version:model.version,generatedAt:model.generatedAt,
    sourceMatchId:model.sourceMatchId,eventVersion:model.eventVersion,
    oneXTwo:{final:clone(model.oneXTwo?.final)},
    calculationTrace:{poisson:{lambdas:clone(model.calculationTrace?.poisson?.lambdas)},
      expectedGoals:{values:clone(model.calculationTrace?.expectedGoals?.values)}},
    lambdaBlend:{marketHomeLambda:model.lambdaBlend?.marketHomeLambda,marketAwayLambda:model.lambdaBlend?.marketAwayLambda},
    inputEvidence:clone(evidence) };
  return validInputEvidence(evidence,value.probabilityModel,value) ? value : null;
}

function compactEndpoint(entry) {
  const expected = expectedCollectorCommitment(entry);
  return { method:entry.method,url:entry.url,page:entry.page ?? null,ok:entry.ok,
    sourceRequest:clone(expected.endpoint),sourceCycleId:expected.collectorCycleId,
    requestedAt:expected.requestedAt,receivedAt:expected.receivedAt,providerObservedAt:expected.providerObservedAt,
    ...clone(expected.response),canonicalPayloadSha256:expected.canonicalPayloadSha256,
    collectorAttestation:clone(entry.collectorAttestation),payload:clone(entry.payload) };
}

function signedEndpoint(snapshot,method,now,registry) {
  const entries = snapshot?.endpoints?.filter(e => e.method === method);
  if (!Array.isArray(entries) || entries.length !== 1) return null;
  const original = entries[0];
  if (Buffer.byteLength(JSON.stringify(original),'utf8') > MAX_ENDPOINT_BYTES) return null;
  const entry = compactEndpoint(original),requested=time(entry.requestedAt),received=time(entry.receivedAt),provider=time(entry.providerObservedAt);
  if (entry.ok !== true || !identity(entry.sourceCycleId) || entry.payload?.success !== true || JSON.stringify(entry.payload).includes('\uFFFD')
    || entry.page !== null || !officialFastEndpointUrl(method,entry.url)
    || !officialFastEndpointUrl(method,entry.sourceRequest.url)
    || entry.sourceRequest.page !== null || entry.sourceRequest.role !== method || entry.sourceRequest.method !== 'GET'
    || entry.httpStatus !== 200 || !Number.isFinite(requested) || !Number.isFinite(received)
    || requested > received || received > now || now - requested > MAX_AGE || now - received > MAX_AGE
    || (entry.providerObservedAt!=null&&(!Number.isFinite(provider)||provider>received))) return null;
  // Always rehash the retained parsed payload. No raw-HTTP-rehash claim is made.
  const proof = verifyCollectorAttestation(entry.collectorAttestation,
    {trustRegistry:registry,payload:entry.payload,expected:expectedCollectorCommitment(entry)});
  if (!proof.eligible) return null;
  const groups = entry.payload?.value?.matchInfoList;
  if (!Array.isArray(groups)) return null;
  const rows = groups.flatMap(g => Array.isArray(g.subMatchList) ? g.subMatchList : []);
  if (rows.length > 512) return null;
  return {entry,rows,proof};
}

function signedQuoteFor(input,snapshot,now,cutoff,registry) {
  const calculator=signedEndpoint(snapshot,'calculator',now,registry),schedule=signedEndpoint(snapshot,'current',now,registry);
  if (!calculator || !schedule || calculator.entry.sourceCycleId!==schedule.entry.sourceCycleId) return null;
  const pick = list => list.filter(row => sourceId(row.matchId) === sourceId(input.sourceMatchId || input.id));
  const quotes=pick(calculator.rows),fixtures=pick(schedule.rows);
  if (quotes.length !== 1 || fixtures.length !== 1) return null;
  const q=quotes[0],fixture=fixtures[0],event=time(input.eventVersion || input.kickoffTime);
  for (const row of [q,fixture]) {
    if (time(`${row.matchDate}T${row.matchTime}+08:00`) !== event || row.businessDate !== input.businessDate
      || String(row.homeTeamAllName || row.homeTeamAbbName || '').trim() !== input.homeTeamName.trim()
      || String(row.awayTeamAllName || row.awayTeamAbbName || '').trim() !== input.awayTeamName.trim()
      || row.matchStatus !== 'Selling' || Number(row.sellStatus) !== 1) return null;
  }
  const pools=(q.oddsList || []).filter(row => row.poolCode === 'HHAD'),sales=(q.poolList || []).filter(row => row.poolCode === 'HHAD');
  // The schedule need not carry HHAD prices, but an explicit same-cycle
  // HHAD sale suspension cannot be hidden by a Selling fixture-level status.
  const currentSales=(fixture.poolList || []).filter(row => row.poolCode === 'HHAD');
  if (currentSales.length>1 || (currentSales.length===1&&(currentSales[0].poolStatus!=='Selling'
    || Number(currentSales[0].bettingAllup ?? currentSales[0].allUp)!==1))) return null;
  if (pools.length !== 1 || sales.length !== 1 || sales[0].poolStatus !== 'Selling'
    || Number(sales[0].bettingAllup ?? sales[0].allUp) !== 1) return null;
  const pool=pools[0],line=Number(pool.goalLine),odds={'1':Number(pool.h),X:Number(pool.d),'2':Number(pool.a)};
  const extraction=extractionFromSportteryPool({row:q,poolRow:pool,poolCode:'HHAD',fallbackProviderObservedAt:calculator.entry.providerObservedAt});
  const poolClockPresent=pool.updateDate!=null||pool.updateTime!=null;
  const poolClock=poolClockPresent?time(`${pool.updateDate}T${pool.updateTime}+08:00`):null;
  if (pool.goalLine == null || pool.goalLine === '' || !Number.isSafeInteger(line) || !line || Math.abs(line)>12
    || CODES.some(c => !Number.isFinite(odds[c]) || odds[c]<=1 || !/^\d+(?:\.\d{1,4})?$/.test(String(odds[c])))
    || !calculator.entry.collectorAttestation.commitment.marketExtractionHashes.includes(extraction.hash)
    || (poolClockPresent&&(!Number.isFinite(poolClock)||poolClock>time(calculator.entry.receivedAt)))
    || time(calculator.entry.receivedAt) >= cutoff || time(schedule.entry.receivedAt) >= cutoff) return null;
  return {market:'HHAD',line,odds,receivedAt:calculator.entry.receivedAt,
    sourceEvidence:{version:'signed-hhad-and-event-payload-v1',calculator:calculator.entry,current:schedule.entry},
    trustBoundary:'trusted-collector-signature-and-canonical-payload-rehash;raw-http-bytes-not-rehashed'};
}

/** Net score d=home-away: integer event sets, never compare unrelated codes. */
function compareMarketEvents(a,b) {
  const left=eventRange(a?.market,a?.tipCode,a?.handicapLine),right=eventRange(b?.market,b?.tipCode,b?.handicapLine);
  if (!left || !right) return {status:'unverified',structuralConflict:null,intersection:null};
  const lo=Math.max(left.minimum ?? -Infinity,right.minimum ?? -Infinity),hi=Math.min(left.maximum ?? Infinity,right.maximum ?? Infinity);
  return {status:'verified-arithmetic',structuralConflict:eventsConflict(a,b),
    intersection:lo>hi ? null : {minimum:Number.isFinite(lo)?lo:null,maximum:Number.isFinite(hi)?hi:null}};
}

function referenceConflict(input,pick,{referenceMatch,referenceEvidence},now,cutoff) {
  const absent={status:'absent',structuralConflict:null,blocking:false,sourceVerified:false,referenceHash:null,reasons:[]};
  const value=referenceMatch?.predictionMeta?.publicReferenceDecision;
  if (!value) return absent;
  const fail=reason => ({...absent,status:'unverified',referenceHash:typeof value.contentHash==='string'?value.contentHash:null,reasons:[reason]});
  if (sourceId(referenceMatch.sourceMatchId || referenceMatch.id)!==sourceId(input.sourceMatchId || input.id)
    || referenceMatch.homeTeamId!==input.homeTeamId || referenceMatch.awayTeamId!==input.awayTeamId
    || time(referenceMatch.eventVersion || referenceMatch.kickoffTime)!==time(input.eventVersion || input.kickoffTime)) return fail('reference-identity-mismatch');
  const record=attestPublicReferenceDecision(value,referenceMatch);
  if (!record) return fail('reference-record-unverified');
  const recorded=time(record.recordedAt),decided=time(record.decisionAt);
  if (!Number.isFinite(recorded) || !Number.isFinite(decided) || decided>recorded || recorded>now || recorded>=cutoff) return fail('reference-clock-invalid');
  const event={market:record.prediction.oddsPoolCode,tipCode:record.prediction.tipCode,
    handicapLine:record.prediction.oddsPoolCode==='HAD'?0:Number(record.prediction.handicapLine)};
  const comparison=compareMarketEvents(event,pick);
  if (comparison.structuralConflict===null) return fail('reference-market-event-invalid');
  const original=verifyPublicReferenceEvidence(referenceEvidence,record);
  const e=referenceEvidence?.evidence;
  const clocks=original?[e.featureSnapshot?.capturedAt,e.probabilityModel?.generatedAt,
    ...(e.probabilityModel?.unifiedPosterior?.generatedAt?[e.probabilityModel.unifiedPosterior.generatedAt]:[])]:[];
  const verified=original&&clocks.every(v=>Number.isFinite(time(v))&&time(v)<=decided);
  return {status:verified?'content-verified':'unverified',structuralConflict:comparison.structuralConflict,
    blocking:verified&&comparison.structuralConflict===true,sourceVerified:false,referenceHash:record.contentHash,
    knownAtPublication:recorded<=now,referenceEvent:event,reasons:verified?[]:['reference-original-evidence-unverified']};
}

function createStandaloneHandicapReference(match,{now,publication,snapshot,trustRegistry,referenceMatch=null,referenceEvidence=null}={}) {
  const fail = reason => ({record:null,reason});
  try {
    if (!Number.isSafeInteger(now)) return fail('clock-invalid');
    const input=inputSnapshotFor(match);
    if (!input) return fail('model-input-evidence-invalid');
    if (input.status!=='SCHEDULED' || input.resultDisposition==='VOID' || input.isOnSale===false
      || ['CLOSED','SUSPENDED','STOPPED'].includes(String(input.saleStatus || '').toUpperCase())
      || input.predictionMeta.lockedAt || input.predictionMeta.lockedReason) return fail('not-open-pregame');
    if (!identity(input.id) || !sourceId(input.sourceMatchId || input.id)
      || ![input.homeTeamId,input.awayTeamId,input.homeTeamName,input.awayTeamName].every(identity)
      || input.homeTeamId===input.awayTeamId) return fail('event-identity-invalid');
    const kickoff=time(input.kickoffTime),event=time(input.eventVersion);
    if (!Number.isFinite(kickoff) || event!==kickoff || input.businessDate!==day(now)) return fail('event-version-or-business-date-invalid');
    const midnight=Date.parse(`${input.businessDate}T00:00:00+08:00`),weekend=[0,6].includes(new Date(midnight+8*3600000).getUTCDay());
    const deadlines=[kickoff,midnight+(weekend?23:22)*3600000];
    for (const value of [input.buyEndTime,input.cutoffAt,input.cutoffTime,input.predictionMeta.cutoffTime]) {
      if (value==null || value==='') continue;
      const at=time(value);if(!Number.isFinite(at))return fail('cutoff-invalid');deadlines.push(at);
    }
    const cutoff=Math.min(...deadlines);if(now>=cutoff)return fail('after-cutoff');
    const committed=time(publication?.committedAt);
    if (!/^[a-f0-9]{64}$/.test(publication?.manifestHash || '') || !identity(publication?.generationId)
      || !Number.isFinite(committed) || committed>now) return fail('publication-binding-invalid');
    const model=input.probabilityModel,modelAt=time(model.generatedAt),straight=probabilities(model.oneXTwo?.final);
    const ageLimit=kickoff-now<=2*3600000?3600000:kickoff-now<=6*3600000?3*3600000:12*3600000;
    if (!straight || !Number.isFinite(modelAt) || modelAt>committed || modelAt>now || modelAt>=cutoff || now-modelAt>ageLimit) return fail('model-data-invalid-or-stale');
    const registry=registryFor(trustRegistry);if(!registry)return fail('collector-trust-registry-unavailable');
    const quote=signedQuoteFor(input,snapshot,now,cutoff,registry);
    if (!quote) return fail('signed-independent-hhad-quote-unavailable');
    const next={...input,handicapLine:String(quote.line),handicapOdds:{odds1:quote.odds['1'],oddsX:quote.odds.X,odds2:quote.odds['2']},
      handicapOddsSource:'sporttery:HHAD',handicapOddsPoolCode:'HHAD',handicapOddsReceivedAt:quote.receivedAt};
    const analysis=buildHandicapMarginDecision(next,{now,cutoffTime:new Date(cutoff).toISOString(),straightTipCode:top(straight)});
    if (!analysis || !validHandicapMarginDecision(analysis) || !analysis.marketReference
      || analysis.marketReference.handicapLine!==quote.line || hash(analysis.marketReference.odds)!==hash(quote.odds)) return fail('unconditional-hhad-model-unavailable');
    const p=analysis.overallProbabilities,tipCode=top(p),pick={market:'HHAD',tipCode,handicapLine:quote.line};
    const quality=selectionQuality({...input,selectionPolicyVersion:QUALITY_VERSION,inputEvidence:{model}},
      {...pick,probabilities:p,quoteOdds:quote.odds});
    const ev=p[tipCode]*quote.odds[tipCode]-1,gap=p[tipCode]-analysis.marketReference.probabilities[tipCode];
    const conflict=referenceConflict(input,pick,{referenceMatch,referenceEvidence},now,cutoff);
    const reasons=[...quality.reasons,...(ev<=0?['nonpositive-model-expected-value']:[]),
      ...(Math.abs(gap)>=MATERIAL_ABSOLUTE_MARKET_GAP-1e-12?['market-disagreement-needs-validation']:[]),
      ...(conflict.blocking?['verified-reference-event-conflict']:[])];
    const body={version:VERSION,policyVersion:VERSION,statisticsTrack:TRACK,publicationStatus:'FROZEN_REFERENCE',
      referenceOnly:true,formalEligible:false,formalPromotion:false,primary:null,companion:null,
      market:'HHAD',handicapLine:quote.line,tipCode,modelProbability:p[tipCode],probabilities:clone(p),
      probabilityBasis:'unconditional-coherent-score-matrix',modelValidation:'unvalidated',
      odds:quote.odds[tipCode],quoteOdds:clone(quote.odds),quoteSource:'sporttery:HHAD',quoteObservedAt:quote.receivedAt,
      sourceMatchId:sourceId(input.sourceMatchId || input.id),matchId:input.id,eventVersion:new Date(event).toISOString(),
      businessDate:input.businessDate,kickoffTime:new Date(kickoff).toISOString(),cutoffTime:new Date(cutoff).toISOString(),
      homeTeamId:input.homeTeamId,awayTeamId:input.awayTeamId,homeTeamName:input.homeTeamName,awayTeamName:input.awayTeamName,
      recordedAt:new Date(now).toISOString(),modelGeneratedAt:new Date(modelAt).toISOString(),upstreamModelVersion:model.version,
      publication:{generationId:publication.generationId,manifestHash:publication.manifestHash,committedAt:new Date(committed).toISOString()},
      inputSnapshot:input,inputSnapshotHash:hash(input),modelEvidenceHash:model.inputEvidence.contentHash,
      sourceEvidence:quote.sourceEvidence,sourceEvidenceHash:hash(quote.sourceEvidence),trustRegistryHash:hash(registry),
      sourceTrustBoundary:quote.trustBoundary,analysis,
      researchAssessment:{selectionStatus:reasons.length?'observation':'research-value-candidate',researchValueEligible:reasons.length===0,
        formalEligible:false,primary:null,companion:null,reasons:[...new Set(reasons)],rawQuality:quality,
        modelExpectedValue:ev,modelMarketGap:gap,materialAbsoluteMarketGap:MATERIAL_ABSOLUTE_MARKET_GAP,
        referenceConflict:conflict,calibration:'unvalidated',calibratedProbability:null,
        conservativeProbability:null,formalCalibrationAdapter:'not-integrated'},
      referenceContext:{match:clone(referenceMatch),evidence:clone(referenceEvidence)}};
    const id=`hhad_reference_${hash([VERSION,body.sourceMatchId,body.eventVersion,body.inputSnapshotHash,body.sourceEvidenceHash,body.recordedAt])}`;
    return {record:freeze({...body,id,recordHash:hash({...body,id})}),reason:null};
  } catch { return fail('malformed-independent-hhad-input'); }
}

function validStandaloneHandicapReference(record,{trustRegistry}={}) {
  try {
    if (record?.version!==VERSION || record.market!=='HHAD' || record.referenceOnly!==true || record.formalEligible!==false
      || record.formalPromotion!==false || record.primary!==null || record.companion!==null) return false;
    const recreated=createStandaloneHandicapReference(record.inputSnapshot,{now:time(record.recordedAt),publication:record.publication,
      snapshot:{endpoints:[record.sourceEvidence?.calculator,record.sourceEvidence?.current]},trustRegistry,
      referenceMatch:record.referenceContext?.match,referenceEvidence:record.referenceContext?.evidence}).record;
    return Boolean(recreated&&hash(recreated)===hash(record));
  } catch { return false; }
}

function projectStandaloneHandicapReference(record,{trustRegistry}={}) {
  if (!validStandaloneHandicapReference(record,{trustRegistry})) return null;
  return {version:VERSION,id:record.id,recordHash:record.recordHash,statisticsTrack:TRACK,
    referenceOnly:true,formalEligible:false,formalPromotion:false,primary:null,companion:null,
    sourceMatchId:record.sourceMatchId,eventVersion:record.eventVersion,businessDate:record.businessDate,
    homeTeamId:record.homeTeamId,awayTeamId:record.awayTeamId,homeTeamName:record.homeTeamName,awayTeamName:record.awayTeamName,
    recordedAt:record.recordedAt,cutoffTime:record.cutoffTime,
    modelTendency:{market:'HHAD',handicapLine:record.handicapLine,tipCode:record.tipCode,
      modelProbability:record.modelProbability,probabilityBasis:record.probabilityBasis,
      modelValidation:'unvalidated',odds:record.odds,quoteSource:record.quoteSource,quoteObservedAt:record.quoteObservedAt},
    researchAssessment:clone(record.researchAssessment),inputSnapshotHash:record.inputSnapshotHash,
    sourceEvidenceHash:record.sourceEvidenceHash,sourceTrustBoundary:record.sourceTrustBoundary};
}

function settleStandaloneHandicapReference(record,event,{trustRegistry}={}) {
  if (!validStandaloneHandicapReference(record,{trustRegistry})) throw new Error('Invalid independent HHAD reference');
  const base={statisticsTrack:TRACK,researchOnly:true,formalEligible:false,resultEventId:null};
  if (!event) return {...base,state:'PENDING'};
  if (!validResultEvent(event)) return {...base,state:'DISPUTED',reason:'result-event-invalid'};
  if (key(record)!==key(event) || event.homeTeamId!==record.homeTeamId || event.awayTeamId!==record.awayTeamId)
    return {...base,state:'DISPUTED',resultEventId:event.eventId,reason:'event-identity-conflict'};
  if (event.state==='VOID' || event.state==='DISPUTED') return {...base,state:event.state,resultEventId:event.eventId};
  if (event.state!=='FINAL' || ![event.scoreHome,event.scoreAway].every(n=>Number.isSafeInteger(n)&&n>=0))
    return {...base,state:'DISPUTED',resultEventId:event.eventId,reason:'result-score-invalid'};
  const adjusted=event.scoreHome+record.handicapLine,actual=adjusted>event.scoreAway?'1':adjusted<event.scoreAway?'2':'X';
  return {...base,state:actual===record.tipCode?'WON':'LOST',actual,resultEventId:event.eventId,
    definition:'90-minute-score-plus-integer-home-handicap',resultRevision:event.revision ?? null};
}

module.exports={VERSION,TRACK,createStandaloneHandicapReference,validStandaloneHandicapReference,
  projectStandaloneHandicapReference,settleStandaloneHandicapReference,compareMarketEvents};
