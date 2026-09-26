'use strict';

const { hash } = require('./publishedForecastPolicy.cjs');
const VERSION = 'baseline-ensemble-policy-v2';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Preserve the baseline weights; this is a sample-admission correction, not a
// fitted or validated accuracy improvement. Learned candidates still require
// the existing shadow/holdout promotion process.
function selectEnsemblePolicy({ eloAvailable, eloHome, eloAway, formHome, formAway, formConfidence, worldCupPriorAvailable }) {
  const samples = { elo:{home:count(eloHome),away:count(eloAway)}, form:{home:count(formHome),away:count(formAway)} };
  const confidence = typeof formConfidence === 'number' && Number.isFinite(formConfidence)
    ? Math.max(0, Math.min(1, formConfidence)) : 0;
  const eloReady = eloAvailable === true && samples.elo.home >= 6 && samples.elo.away >= 6;
  const formReady = samples.form.home >= 8 && samples.form.away >= 8 && confidence >= 0.25;
  const regime = eloReady ? (formReady ? 'elo-and-form' : 'elo-only') : (formReady ? 'form-only' : 'cold-start');
  let weights = eloReady && formReady ? {market:0.1,teamStrength:0.15,elo:0.3,poisson:0.45}
    : eloReady ? {market:0.12,teamStrength:0.18,elo:0.35,poisson:0.35}
    : formReady ? {market:0.12,teamStrength:0.24,elo:0,poisson:0.64}
    : {market:0.15,teamStrength:0.35,elo:0,poisson:0.5};
  if (worldCupPriorAvailable === true) weights = Object.fromEntries(Object.entries(weights).map(([key,value]) => [key,Number((value*0.82).toFixed(3))]));
  weights.worldCupPrior = worldCupPriorAvailable === true ? 0.18 : 0;
  return {version:VERSION,source:'heuristic-baseline',validation:'unvalidated',regime,
    requirements:{eloPerTeam:6,formPerTeam:8,formConfidence:0.25},samples,
    eloAvailable:eloAvailable === true,formConfidence:confidence,worldCupPriorAvailable:worldCupPriorAvailable === true,weights};
}
function validEnsemblePolicy(policy, weights) {
  if (!policy || policy.version !== VERSION) return false;
  const expected = selectEnsemblePolicy({eloAvailable:policy.eloAvailable,
    eloHome:policy.samples?.elo?.home,eloAway:policy.samples?.elo?.away,
    formHome:policy.samples?.form?.home,formAway:policy.samples?.form?.away,
    formConfidence:policy.formConfidence,worldCupPriorAvailable:policy.worldCupPriorAvailable});
  return hash(policy) === hash(expected) && hash(weights) === hash(expected.weights);
}
module.exports = { VERSION, selectEnsemblePolicy, validEnsemblePolicy };
