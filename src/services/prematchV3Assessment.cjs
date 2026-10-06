'use strict';
const {stableHash} = require('./webConsensusEvidence.cjs');
const {strictInstant} = require('./strictInstant.cjs');
const {epochNanoseconds: clock} = require('./prematchV3Clock.cjs');
const team = require('./prematchTeamEvidenceV3.cjs');
const asian = require('./asianHandicapEvidenceV3.cjs');
const {scoreMatrix} = require('./goalDistribution.cjs');
const VERSION = 'prematch-v3-shadow-assessment-v1';
const SOURCE_VERSION = 'prematch-v3-source-input-v1';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && v.trim() ? v.trim() : Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const stamp = body => ({...body, contentHash: stableHash(body)});
function eventFromMatch(match = {}) {
  // The legacy buyEndTime contract explicitly uses Beijing local time.
  // No other unzoned clock is inferred, and an absent sale deadline stays null.
  const buy = typeof match.buyEndTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(match.buyEndTime)
    ? match.buyEndTime.replace(' ', 'T') + '+08:00' : match.buyEndTime;
  const supplied = [buy,match.cutoffAt,match.cutoffTime,match.predictionMeta?.cutoffTime].filter(v => v != null && v !== '');
  const valid = supplied.length && supplied.every(v => strictInstant(v))
    && !(match.cutoffAt!=null && match.cutoffTime!=null && clock(match.cutoffAt)!==clock(match.cutoffTime));
  const cutoffAt = valid ? supplied.reduce((a,b) => clock(a) <= clock(b) ? a : b) : null;
  return {sourceMatchId: id(match.sourceMatchId || match.id)?.replace(/^sporttery_/, '') || null,
    eventVersion: strictInstant(match.eventVersion || match.kickoffTime), kickoffTime: strictInstant(match.kickoffTime),
    cutoffAt, homeTeamId:id(match.homeTeamId), awayTeamId:id(match.awayTeamId), status:match.status || null,
    isOnSale:typeof match.isOnSale === 'boolean' ? match.isOnSale : null, saleStatus:match.saleStatus || null,
    competition:match.competition || null, competitionId:id(match.competitionId), leagueId:id(match.leagueId),
    neutral:typeof match.neutral === 'boolean' ? match.neutral : null,
    entityMapping:match.externalSignals?.prematchV3?.entityMapping || null};
}
function marketReference(match, event, asOf) {
  const odds = { '1':match.odds?.odds1, X:match.odds?.oddsX, '2':match.odds?.odds2 };
  const observed = clock(match.oddsObservedAt), received = clock(match.oddsReceivedAt), at = clock(asOf), cutoff = clock(event.cutoffAt);
  const allowed = Object.values(odds).every(v => finite(v) && v > 1) && typeof match.oddsSource === 'string' && match.oddsSource.trim()
    && observed !== null && received !== null && at !== null && cutoff !== null && observed <= received && received <= at && received < cutoff;
  if (!allowed) return {available:false, formalEligible:false, reason:'had-quote-or-known-clock-missing', probabilities:null};
  const mass = Object.values(odds).reduce((n,v) => n + 1/v, 0);
  const source = {source:match.oddsSource,sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,
    observedAt:match.oddsObservedAt,receivedAt:match.oddsReceivedAt,odds};
  return {available:true, formalEligible:false, sourceVerification:'unverified',
    role:'same-time-normalized-inverse-HAD-price-reference;not-a-team-prediction', ...source,
    sourceHash:stableHash(source), probabilities:Object.fromEntries(Object.entries(odds).map(([k,v]) => [k,1/v/mass]))};
}
function outcomeProjection(rates, homeLine) {
  const rows = scoreMatrix(rates?.home, rates?.away);
  if (!rows.length) return null;
  const probabilities = {'1':0,X:0,'2':0}, handicap = {'1':0,X:0,'2':0};
  const lotteryLine = finite(homeLine) && Number.isInteger(homeLine);
  for (const row of rows) {
    const diff = row.home-row.away;
    probabilities[diff>0?'1':diff<0?'2':'X'] += row.probability;
    if (lotteryLine) handicap[diff+homeLine>0?'1':diff+homeLine<0?'2':'X'] += row.probability;
  }
  const mass = rows.reduce((n,row) => n+row.probability, 0);
  return {model:'independent-poisson-goal-rate-shadow-v3', probabilities,
    hhAd:lotteryLine ? {market:'HHAD',homeLine,probabilities:handicap,formalEligible:false} : null,
    scoreTop3:rows.slice().sort((a,b) => b.probability-a.probability || a.home-b.home || a.away-b.away).slice(0,3),
    scoreDistribution:{complete:true,tailMass:Math.max(0,1-mass),rows}, formalEligible:false};
}
function buildPrematchV3Assessment(match = {}, options = {}) {
  const event = eventFromMatch(match), asOf = strictInstant(options.asOf), at = clock(asOf), blockers = [];
  const cutoff = clock(event.cutoffAt), kickoff = clock(event.kickoffTime);
  if (at === null || cutoff === null || kickoff === null || clock(event.eventVersion) !== kickoff || cutoff > kickoff
    || at >= cutoff || at >= kickoff || !event.sourceMatchId || !event.homeTeamId || !event.awayTeamId
    || event.homeTeamId === event.awayTeamId || event.status !== 'SCHEDULED' || event.isOnSale === false
    || ['CLOSED','STOPPED','SUSPENDED'].includes(String(event.saleStatus || '').toUpperCase()) || match.resultDisposition === 'VOID') blockers.push('event-or-sale-clock-ineligible');
  const registry = options.modelRegistry || null;
  if (registry && (clock(registry.asOf)===null || at===null || clock(registry.asOf)>at || registry.storage!=='postgres')) blockers.push('model-registry-clock-or-storage-invalid');
  const source = match.externalSignals?.prematchV3;
  const sourceValid = object(source) && source.version === SOURCE_VERSION;
  if (!sourceValid) blockers.push('v3-source-contract-missing');
  const observations = sourceValid && Array.isArray(source.teamObservations) && source.teamObservations.length <= 300 ? source.teamObservations : [];
  const ahObservations = sourceValid && Array.isArray(source.asianHandicapObservations) && source.asianHandicapObservations.length <= 20000 ? source.asianHandicapObservations : [];
  if (sourceValid && (!Array.isArray(source.teamObservations) || source.teamObservations.length>300)) blockers.push('team-observation-contract-invalid');
  if (sourceValid && (!Array.isArray(source.asianHandicapObservations) || source.asianHandicapObservations.length>20000)) blockers.push('asian-observation-contract-invalid');
  const snapshot = team.buildPrematchTeamSnapshot({event,asOf,observations});
  const timeline = asian.buildAsianHandicapTimeline({event,asOf,observations:ahObservations});
  // Model packets are explicit private-registry/research inputs. Source JSON
  // may carry facts and mappings, but cannot fill a missing private namespace.
  const baselinePacket = options.baseline || null;
  let baseline = {status:'blocked',formalEligible:false,baseRates:null,baseRatesEvidence:null,blockers:['zero-market-trained-baseline-missing']};
  if (baselinePacket?.artifact && !blockers.includes('event-or-sale-clock-ineligible') && !blockers.includes('model-registry-clock-or-storage-invalid')) {
    const {forecastDynamicGoalStrengthV3} = require('../../scripts/dynamicGoalStrengthModel.cjs');
    baseline = forecastDynamicGoalStrengthV3({artifact:baselinePacket.artifact,event,asOf,createdAt:baselinePacket.createdAt,availableAt:baselinePacket.availableAt});
  }
  const parameters = options.parameters || null;
  const parameterCheck = parameters ? require('./prematchV3Learning.cjs').verifyPrematchV3ParameterArtifact(parameters,
    {featureSchema:team.FEATURE_SCHEMA,featureSchemaHash:team.FEATURE_SCHEMA_HASH,featureNames:parameters.featureNames}) : {valid:false,reasons:['trained-parameters-missing']};
  const effects = team.applyPrematchTeamEffects(snapshot,baseline.baseRates,parameterCheck.valid?parameters:null);
  blockers.push(...parameterCheck.reasons);
  blockers.push(...baseline.blockers, ...effects.blockers);
  const marketOnly = marketReference(match,event,asOf);
  const baselineProjection = baseline.status==='shadow-ready' ? outcomeProjection(baseline.baseRates,match.handicapLine) : null;
  const teamProjection = effects.applied && !blockers.includes('event-or-sale-clock-ineligible') ? outcomeProjection(effects.after,match.handicapLine) : null;
  const asianPrices = teamProjection && timeline.available ? timeline.latestQuotes.flatMap(quote => ['home','away'].map(side => ({
    source:quote.source,company:quote.company,sourceRowHash:quote.contentHash || stableHash(quote),side,
    ...asian.priceAsianHandicap({scoreDistribution:teamProjection.scoreDistribution,homeLine:quote.homeLine,decimalOdds:quote.decimalOdds[side],side})
  }))) : [];
  // A fixed comparator is deliberately separate from a learned production weight.
  const hybrid = teamProjection && marketOnly.available ? {formalEligible:false,
    role:'fixed-50/50-research-comparator;not-learned-or-calibrated',weights:{team:.5,market:.5},
    probabilities:Object.fromEntries(['1','X','2'].map(k => [k,(teamProjection.probabilities[k]+marketOnly.probabilities[k])/2]))} : null;
  if (!timeline.available) blockers.push('asian-timeline-missing');
  if (!marketOnly.available) blockers.push('same-time-had-market-reference-missing');
  const cleanProjection = projection => projection ? (({scoreDistribution,...summary}) => ({...summary,scoreDistributionHash:stableHash(scoreDistribution),tailMass:scoreDistribution.tailMass}))(projection) : null;
  return stamp({version:VERSION,sourceContractVersion:SOURCE_VERSION,event,asOf,status:teamProjection?'shadow-calculated':'blocked',
    formalEligible:false,productionEligible:false,primary:null,companion:null,sourceVerification:'unverified',
    blockers:[...new Set(blockers)].sort(),teamSnapshot:snapshot,asianTimeline:timeline,baseline,effects,parameterCheck,
    modelRegistry:registry?structuredClone(registry):null,
    comparisons:{baseline:cleanProjection(baselineProjection),teamOnly:cleanProjection(teamProjection),marketOnly,hybrid},asianPrices,
    legacyModel:{version:match.probabilityModel?.version || null,marketWeight:finite(match.probabilityModel?.ensembleWeights?.market)?match.probabilityModel.ensembleWeights.market:null,
      role:'existing-model-unchanged;not-used-as-zero-market-baseline'},
    policy:'prematch-shadow-only;source-shape-and-content-hashes-do-not-admit-formal-sources;no-frozen-decision-or-statistics-write'});
}
function verifyPrematchV3Assessment(value, {match,options} = {}) {
  try {
    // Re-hashing caller-provided results cannot verify their arithmetic. Replay
    // against the original inputs/artifacts is mandatory, even for blocked rows.
    if (!object(match)) return false;
    const {contentHash,...body}=value;
    return value.version===VERSION && value.formalEligible===false && value.productionEligible===false && value.primary===null && value.companion===null
      && stableHash(body)===contentHash
      && (value.status==='blocked' || (team.verifyPrematchTeamSnapshot(value.teamSnapshot) && asian.verifyAsianHandicapTimeline(value.asianTimeline)))
      && stableHash(value)===stableHash(buildPrematchV3Assessment(match,{...options,asOf:value.asOf}));
  } catch {return false;}
}
module.exports={VERSION,SOURCE_VERSION,eventFromMatch,marketReference,outcomeProjection,buildPrematchV3Assessment,verifyPrematchV3Assessment};
