'use strict';
const instant = value => {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : value.replace(' ', 'T') + '+08:00');
};
const identity = m => JSON.stringify([String(m?.sourceMatchId || m?.id || '').replace(/^sporttery_/, ''), instant(m?.eventVersion || m?.kickoffTime), m?.homeTeamId, m?.awayTeamId]);
const fields = [
  'id','sourceMatchId','eventVersion','businessDate','matchDate','kickoffDate','kickoffTime','buyEndTime','matchNo','matchNumStr',
  'status','resultDisposition','isOnSale','saleStatus','homeTeamId','awayTeamId','homeTeamName','awayTeamName','leagueId',
  'odds','oddsSource','oddsReceivedAt','oddsObservedAt','oddsUpdatedAt','sourceCycleId',
  'handicapOdds','handicapLine','handicapOddsSource','handicapOddsPoolCode','handicapOddsReceivedAt','handicapOddsObservedAt',
  'handicapOddsUpdatedAt','handicapOddsSourceUrl'
];
function compactScoreInputs(model) {
  if (!model || typeof model !== 'object') return {};
  const lambdas=model.calculationTrace?.poisson?.lambdas;
  const expected=model.calculationTrace?.expectedGoals?.values;
  const blend=model.lambdaBlend;
  return {
    calculationTrace: {
      poisson: { lambdas: { home: lambdas?.home ?? null, away: lambdas?.away ?? null } },
      expectedGoals: { values: { finalHome: expected?.finalHome ?? null, finalAway: expected?.finalAway ?? null } },
    },
    lambdaBlend: {
      marketHomeLambda: blend?.marketHomeLambda ?? null,
      marketAwayLambda: blend?.marketAwayLambda ?? null,
    },
  };
}

// The current-cycle model and quote travel together. Frozen display decisions
// keep their original probabilities and timestamps in the parent match.
function attachProspectiveForecastInputs(matches, freshMatches, now) {
  const grouped = new Map();
  for (const row of freshMatches) { const key = identity(row); const rows = grouped.get(key) || []; rows.push(row); grouped.set(key, rows); }
  return matches.map(match => {
    const result = { ...match, prospectiveForecastInput: null };
    const rows = grouped.get(identity(match));
    if (rows?.length !== 1 || match.status !== 'SCHEDULED') return result;
    const fresh = rows[0], model = fresh.probabilityModel;
    const cutoffValues = [fresh.kickoffTime, fresh.buyEndTime, fresh.predictionMeta?.cutoffTime].filter(v => v != null && v !== '');
    const cutoffs = cutoffValues.map(instant), generated = instant(model?.generatedAt);
    if (fresh.status !== 'SCHEDULED' || fresh.predictionMeta?.lockedAt || fresh.predictionMeta?.lockedReason
      || !Number.isFinite(now) || !Number.isFinite(generated) || generated > now
      || cutoffs.some(v => !Number.isFinite(v)) || !cutoffs.length || now >= Math.min(...cutoffs)) return result;
    const input = Object.fromEntries(fields.filter(key => fresh[key] !== undefined).map(key => [key, fresh[key]]));
    input.probabilityModel = {
      version: model.version,
      generatedAt: model.generatedAt,
      sourceMatchId: fresh.sourceMatchId,
      eventVersion: fresh.eventVersion || fresh.kickoffTime,
      dataQuality: model.dataQuality,
      oneXTwo: { final: model.oneXTwo?.final },
      ...compactScoreInputs(model),
    };
    input.predictionMeta = { cutoffTime: fresh.predictionMeta?.cutoffTime };
    // Carry current-cycle HAD/HHAD source objects only. Never borrow a later
    // quote from the parent frozen match or refresh a receipt by copying metadata.
    const had = fresh.externalSignals?.bookmakerOdds?.had;
    const hhad = fresh.externalSignals?.bookmakerOdds?.hhad;
    if (had?.lotterySpReceipt || hhad) {
      input.externalSignals = { bookmakerOdds: {
        ...(had?.lotterySpReceipt ? { had: structuredClone(had) } : {}),
        ...(hhad ? { hhad: structuredClone(hhad) } : {}),
      } };
    }
    result.prospectiveForecastInput = structuredClone(input);
    return result;
  });
}
function forecastInputFor(match) {
  if (!match?.prospectiveForecastInput) return match;
  const input = match.prospectiveForecastInput;
  if (identity(input) !== identity(match) || input.id !== match.id || input.status !== match.status
    || input.businessDate !== match.businessDate || input.buyEndTime !== match.buyEndTime
    || match.resultDisposition === 'VOID' || match.isOnSale === false
    || ['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(match.saleStatus || '').toUpperCase())) return null;
  return input;
}
module.exports = { attachProspectiveForecastInputs, forecastInputFor, compactScoreInputs };
