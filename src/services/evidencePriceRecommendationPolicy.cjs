'use strict';

const { hash } = require('./publishedForecastPolicy.cjs');
const { strictInstant } = require('./strictInstant.cjs');
const { rawSelectionQuality, MATERIAL_MARKET_GAP } = require('./recommendationSelectionQuality.cjs');
const { validDecision } = require('../../scripts/recommendationPlatform/decision.cjs');
const { selectionFor, standaloneHandicap } = require('../../scripts/recommendationPlatform/comboSelections.cjs');
const { attestPublicReferenceDecision } = require('./publicReferenceDecision.cjs');
const { verifyPublicReferenceEvidence } = require('./publicReferenceEvidence.cjs');

const VERSION = 'evidence-price-recommendation-v1';
const CODES = Object.freeze(['1', 'X', '2']);
const MARKETS = Object.freeze(['HAD', 'HHAD']);
// Reuse the existing disagreement magnitude symmetrically as a research risk,
// not a fitted claim about profitable prices or a newly calibrated probability.
const MATERIAL_ABSOLUTE_MARKET_GAP = Math.abs(MATERIAL_MARKET_GAP);
const QUOTE_MAX_AGE_NS = 15n * 60n * 1000000000n;
const clone = value => value == null ? null : structuredClone(value);
const vector = p => p && CODES.every(c => Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1)
  && Math.abs(CODES.reduce((sum,c) => sum + p[c],0) - 1) <= 1e-6;
const oddsVector = q => q && CODES.every(c => typeof q[c] === 'number' && Number.isFinite(q[c]) && q[c] > 1);
const unique = values => [...new Set(values)];
const leaders = p => vector(p) ? CODES.filter(c => CODES.every(other => p[c] >= p[other] - 1e-12)) : [];
const digest = value => { try { return value == null ? null : hash(value); } catch { return null; } };

function instant(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()) ? BigInt(value) * 1000000n : null;
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/,'');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9,'0'));
}
function clockText(value) {
  if (instant(value) === null) return null;
  return typeof value === 'number' ? new Date(value).toISOString() : value;
}
function eventRange(market,code,line) {
  if (!MARKETS.includes(market) || !CODES.includes(code)
    || !Number.isSafeInteger(line) || (market === 'HAD' ? line !== 0 : line === 0)) return null;
  return code === '1' ? { minimum:1-line, maximum:null }
    : code === 'X' ? { minimum:-line, maximum:-line } : { minimum:null, maximum:-1-line };
}
function eventsConflict(a,b) {
  const x=eventRange(a?.market,a?.tipCode,a?.handicapLine),y=eventRange(b?.market,b?.tipCode,b?.handicapLine);
  if (!x || !y) return null;
  return Math.max(x.minimum ?? -Infinity,y.minimum ?? -Infinity) > Math.min(x.maximum ?? Infinity,y.maximum ?? Infinity);
}

function referenceContext(decision,{referenceMatch,referenceEvidence},asOf) {
  const input = referenceMatch?.predictionMeta?.publicReferenceDecision;
  const absent = { status:'absent',referenceHash:null,event:null,sourceVerified:false,reasons:[] };
  if (!input) return absent;
  const fail = reason => ({...absent,status:'unverified',referenceHash:typeof input.contentHash === 'string' ? input.contentHash : null,reasons:[reason]});
  if (String(referenceMatch.sourceMatchId || '').replace(/^sporttery_/,'') !== decision.sourceMatchId
    || referenceMatch.homeTeamId !== decision.homeTeamId || referenceMatch.awayTeamId !== decision.awayTeamId
    || instant(referenceMatch.eventVersion || referenceMatch.kickoffTime) !== instant(decision.eventVersion)) return fail('reference-identity-mismatch');
  const record = attestPublicReferenceDecision(input,referenceMatch);
  if (!record) return fail('reference-record-unverified');
  const recorded=instant(record.recordedAt),decided=instant(record.decisionAt),cutoff=instant(decision.cutoffTime);
  if (asOf === null || recorded === null || decided === null || cutoff === null
    || decided > recorded || recorded > asOf || recorded >= cutoff) return fail('reference-clock-invalid');
  const market=record.prediction.oddsPoolCode,tipCode=record.prediction.tipCode;
  const handicapLine=market === 'HAD' ? 0 : Number(record.prediction.handicapLine);
  if (!eventRange(market,tipCode,handicapLine)) return fail('reference-event-invalid');
  const event={market,tipCode,handicapLine};
  // A hash and a sourceVerified boolean are not original evidence. An omitted
  // original stays diagnostic; callers cannot turn it into an admission gate.
  if (!verifyPublicReferenceEvidence(referenceEvidence,record)) return {...fail('reference-original-evidence-unverified'),event};
  const e=referenceEvidence.evidence;
  const clocks=[e.featureSnapshot?.capturedAt,e.probabilityModel?.generatedAt];
  if (e.probabilityModel?.unifiedPosterior?.generatedAt != null) clocks.push(e.probabilityModel.unifiedPosterior.generatedAt);
  if (clocks.some(value => instant(value) === null || instant(value) > decided)) return {...fail('reference-original-clock-invalid'),event};
  return {status:'content-verified',referenceHash:record.contentHash,event,sourceVerified:false,
    knownAtOriginalPublication:recorded <= instant(decision.publishedAt),reasons:[]};
}

function calibrationContext(evidence) {
  // This first policy has NO production calibration authorization adapter.
  // Do not trust caller-supplied passed/promoted/sample-count claims. A future
  // reviewed adapter must verify the existing prospective registry, its 500
  // settled rows / 6 windows / >=50 per window / >=5 wins, exact model+market
  // binding, predecision clocks and an independently justified probability
  // lower bound before a separate version may offer formal recommendations.
  return {status:evidence == null ? 'unavailable' : 'unverified',suppliedEvidenceHash:digest(evidence),
    conservativeProbability:null,formalAdapter:'not-integrated',trainingPerformed:false,
    reasons:[evidence == null ? 'calibration-evidence-missing' : 'calibration-evidence-unverified',
      'formal-calibration-adapter-unavailable']};
}

function evaluateEvidencePriceRecommendation(decision,{asOf,referenceMatch=null,referenceEvidence=null,calibrationEvidence=null}={}) {
  const at=instant(asOf),valid=Boolean(decision && validDecision(decision));
  const reasons=[];
  if (!valid) reasons.push('frozen-decision-invalid');
  if (at === null) reasons.push('evaluation-clock-invalid');
  if (valid && at !== null) {
    const published=instant(decision.publishedAt),cutoff=instant(decision.cutoffTime),kickoff=instant(decision.kickoffTime),modelAt=instant(decision.modelGeneratedAt);
    if ([published,cutoff,kickoff,modelAt].some(value => value === null)) reasons.push('frozen-clock-invalid');
    else {
      if (published > at || modelAt > at) reasons.push('frozen-input-after-evaluation');
      if (at >= cutoff || at >= kickoff) reasons.push('after-cutoff');
      const hours=kickoff-at <= 2n*3600000000000n ? 1n : kickoff-at <= 6n*3600000000000n ? 3n : 12n;
      if (at-modelAt > hours*3600000000000n) reasons.push('model-data-stale');
    }
  }
  const calibration=calibrationContext(calibrationEvidence);
  const reference=valid ? referenceContext(decision,{referenceMatch,referenceEvidence},at)
    : {status:'unverified',referenceHash:null,event:null,sourceVerified:false,reasons:['frozen-decision-invalid']};
  const distributions={},candidates=[];
  for (const market of MARKETS) {
    let bound=null;
    if (valid) { try { bound=selectionFor(decision,market); } catch { /* Missing frozen quote is not a live quote. */ } }
    const p=valid ? (market === 'HAD' ? decision.probabilities : standaloneHandicap(decision.handicapAnalysis)) : null;
    const probabilities=vector(p) ? clone(p) : null;
    const quote=bound && oddsVector(bound.quoteOdds) ? clone(bound.quoteOdds) : null;
    const total=quote ? CODES.reduce((sum,c)=>sum+1/quote[c],0) : null;
    const marketP=quote ? Object.fromEntries(CODES.map(c=>[c,(1/quote[c])/total])) : null;
    const modelLeaders=leaders(probabilities),marketLeaders=leaders(marketP);
    const line=market === 'HAD' ? 0 : (valid ? decision.handicapAnalysis?.handicapLine ?? null : null);
    const clock=bound ? instant(bound.quoteObservedAt) : null;
    const quoteReasons=[];
    if (!bound || !quote) quoteReasons.push('official-market-quote-unavailable');
    if (bound && (clock === null || at === null || clock > at)) quoteReasons.push('quote-clock-invalid');
    if (bound && clock !== null && at !== null && at-clock > QUOTE_MAX_AGE_NS) quoteReasons.push('quote-stale');
    distributions[market]={modelProbabilities:probabilities,marketProbabilities:marketP,
      modelLeader:modelLeaders.length === 1 ? modelLeaders[0] : null,modelLeaderCodes:modelLeaders,
      marketLeader:marketLeaders.length === 1 ? marketLeaders[0] : null,marketLeaderCodes:marketLeaders,
      quoteOdds:quote,quoteObservedAt:bound?.quoteObservedAt || null,quoteSource:bound?.quoteSource || null,
      handicapLine:line,probabilityBasis:'unconditional',modelValidation:'unvalidated',
      quoteBinding:bound ? 'frozen-decision-market-quote' : 'unavailable',sourceVerified:false,
      quoteReasons};
    for (const tipCode of CODES) {
      const modelProbability=probabilities?.[tipCode] ?? null,marketProbability=marketP?.[tipCode] ?? null,odds=quote?.[tipCode] ?? null;
      const modelExpectedValue=modelProbability !== null && odds !== null ? modelProbability*odds-1 : null;
      const modelMarketGap=modelProbability !== null && marketProbability !== null ? modelProbability-marketProbability : null;
      const selection={market,tipCode,probabilities:probabilities || {},quoteOdds:quote || {}};
      const rawQuality=valid ? rawSelectionQuality(decision,selection) : null;
      const candidateReasons=[...reasons,...quoteReasons,...(rawQuality?.reasons || [])],risks=[];
      if (!probabilities) candidateReasons.push('unconditional-probabilities-unavailable');
      if (modelExpectedValue === null) candidateReasons.push('price-evaluation-unavailable');
      else if (modelExpectedValue <= 0) candidateReasons.push('nonpositive-model-expected-value');
      if (modelMarketGap !== null && Math.abs(modelMarketGap) >= MATERIAL_ABSOLUTE_MARKET_GAP-1e-12) {
        risks.push('material-absolute-model-market-gap');candidateReasons.push('market-disagreement-needs-validation');
      }
      const event={market,tipCode,handicapLine:line};
      const structuralConflict=reference.event ? eventsConflict(reference.event,event) : null;
      const blocking=reference.status === 'content-verified' && structuralConflict === true;
      if (blocking) candidateReasons.push('verified-reference-event-conflict');
      else if (structuralConflict === true) risks.push('unverified-reference-event-conflict');
      const body={market,tipCode,handicapLine:line,modelProbability,marketProbability,odds,
        breakEvenProbability:odds === null ? null : 1/odds,modelExpectedValue,modelMarketGap,
        probabilityBasis:'unconditional',rawQuality,quoteObservedAt:bound?.quoteObservedAt || null,
        researchValueEligible:candidateReasons.length === 0,formalEligible:false,
        calibratedProbability:null,conservativeProbability:null,conservativeExpectedValue:null,
        reasons:unique(candidateReasons),risks,referenceConflict:{referenceHash:reference.referenceHash,
          structuralConflict,blocking,evidenceStatus:reference.status,sourceVerified:false}};
      candidates.push({id:`option_${hash([VERSION,decision?.recordHash || null,clockText(asOf),market,tipCode,body])}`,...body});
    }
  }
  const eligibleCandidates=candidates.filter(c=>c.researchValueEligible);
  const body={version:VERSION,scope:'shadow-reference-only',asOf:clockText(asOf),
    decisionId:typeof decision?.decisionId === 'string' ? decision.decisionId : null,
    decisionRecordHash:typeof decision?.recordHash === 'string' ? decision.recordHash : null,
    sourceMatchId:typeof decision?.sourceMatchId === 'string' ? decision.sourceMatchId : null,
    eventVersion:typeof decision?.eventVersion === 'string' ? decision.eventVersion : null,
    businessDate:typeof decision?.businessDate === 'string' ? decision.businessDate : null,
    modelVersion:typeof decision?.upstreamModelVersion === 'string' ? decision.upstreamModelVersion : null,
    selectionStatus:reasons.length ? 'unavailable' : eligibleCandidates.length ? 'research-value-candidates' : 'observation',
    reasons:unique([...reasons,'model-uncalibrated',...calibration.reasons,...(!eligibleCandidates.length ? ['no-research-value-candidate'] : [])]),
    formalEligible:false,primary:null,companion:null,eligibleCandidateScope:'research-value-only',
    materialAbsoluteMarketGap:MATERIAL_ABSOLUTE_MARKET_GAP,calibration,referenceDiagnostic:reference,
    distributions,candidates,eligibleCandidates};
  const id=`assessment_${hash(body)}`;
  return {...body,id,contentHash:hash({...body,id})};
}

function validEvidencePriceRecommendation(record,decision,context) {
  try { return hash(record) === hash(evaluateEvidencePriceRecommendation(decision,context)); } catch { return false; }
}

module.exports={VERSION,MATERIAL_ABSOLUTE_MARKET_GAP,eventRange,eventsConflict,
  evaluateEvidencePriceRecommendation,validEvidencePriceRecommendation};
