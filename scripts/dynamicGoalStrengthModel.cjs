"use strict";

const {
  HASH_PATTERN,
  buildHistoricalAsOfFeatureArtifact,
  stableHash,
  verifyHistoricalAsOfFeatureArtifact,
} = require("./historicalAsOfFeatureBuilder.cjs");

const DYNAMIC_GOAL_STRENGTH_MODEL_VERSION = "dynamic-goal-strength-shadow-v1";
const DYNAMIC_GOAL_STRENGTH_STATE_VERSION = "dynamic-goal-strength-state-v1";
const DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION = "dynamic-goal-strength-walk-forward-v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOMES = Object.freeze(["1", "X", "2"]);

const DEFAULT_CONFIG = Object.freeze({
  baseElo: 1500,
  coldStartPriorMatches: 12,
  dixonColesRho: -0.08,
  eloHalfLifeDays: 720,
  eloHomeAdvantage: 55,
  eloKFactor: 18,
  goalLearningRate: 0.035,
  latentHalfLifeDays: 240,
  latentLimit: 1.25,
  leagueHalfLifeDays: 730,
  leaguePriorMatches: 60,
  maxGoals: 10,
  maxLambda: 4.5,
  minLambda: 0.15,
  poissonWeight: 0.78,
  priorAwayGoals: 1.12,
  priorDrawRate: 0.27,
  priorHomeGoals: 1.42,
  regularization: 0.004,
});

class DynamicGoalStrengthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DynamicGoalStrengthError";
    this.code = details.code || "DYNAMIC_GOAL_STRENGTH_ERROR";
    Object.assign(this, details);
  }
}

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new DynamicGoalStrengthError(`${field} must be finite`, {
      code: "INVALID_MODEL_CONFIG",
      field,
    });
  }
  return number;
}

function integer(value, field, minimum, maximum) {
  const number = finite(value, field);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new DynamicGoalStrengthError(`${field} is outside its supported range`, {
      code: "INVALID_MODEL_CONFIG",
      field,
    });
  }
  return number;
}

function inRange(value, field, minimum, maximum) {
  const number = finite(value, field);
  if (number < minimum || number > maximum) {
    throw new DynamicGoalStrengthError(`${field} is outside its supported range`, {
      code: "INVALID_MODEL_CONFIG",
      field,
    });
  }
  return number;
}

function normalizeConfig(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(overrides || {}) };
  const config = {
    baseElo: inRange(merged.baseElo, "baseElo", 1000, 2000),
    coldStartPriorMatches: inRange(merged.coldStartPriorMatches, "coldStartPriorMatches", 1, 100),
    dixonColesRho: inRange(merged.dixonColesRho, "dixonColesRho", -0.25, 0.2),
    eloHalfLifeDays: inRange(merged.eloHalfLifeDays, "eloHalfLifeDays", 30, 5000),
    eloHomeAdvantage: inRange(merged.eloHomeAdvantage, "eloHomeAdvantage", 0, 200),
    eloKFactor: inRange(merged.eloKFactor, "eloKFactor", 1, 100),
    goalLearningRate: inRange(merged.goalLearningRate, "goalLearningRate", 0.001, 0.2),
    latentHalfLifeDays: inRange(merged.latentHalfLifeDays, "latentHalfLifeDays", 30, 3000),
    latentLimit: inRange(merged.latentLimit, "latentLimit", 0.2, 3),
    leagueHalfLifeDays: inRange(merged.leagueHalfLifeDays, "leagueHalfLifeDays", 90, 5000),
    leaguePriorMatches: inRange(merged.leaguePriorMatches, "leaguePriorMatches", 5, 500),
    maxGoals: integer(merged.maxGoals, "maxGoals", 6, 16),
    maxLambda: inRange(merged.maxLambda, "maxLambda", 2, 8),
    minLambda: inRange(merged.minLambda, "minLambda", 0.01, 1),
    poissonWeight: inRange(merged.poissonWeight, "poissonWeight", 0, 1),
    priorAwayGoals: inRange(merged.priorAwayGoals, "priorAwayGoals", 0.3, 3),
    priorDrawRate: inRange(merged.priorDrawRate, "priorDrawRate", 0.1, 0.5),
    priorHomeGoals: inRange(merged.priorHomeGoals, "priorHomeGoals", 0.3, 3.5),
    regularization: inRange(merged.regularization, "regularization", 0, 0.1),
  };
  if (config.minLambda >= config.maxLambda) {
    throw new DynamicGoalStrengthError("minLambda must be smaller than maxLambda", {
      code: "INVALID_MODEL_CONFIG",
    });
  }
  return Object.freeze(config);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 10) {
  return Number(Number(value).toFixed(digits));
}

function normalizeTriplet(value) {
  const projected = Object.fromEntries(OUTCOMES.map((key) => [key, Math.max(0, Number(value?.[key]) || 0)]));
  const total = OUTCOMES.reduce((sum, key) => sum + projected[key], 0);
  if (!(total > 0)) return { "1": 1 / 3, X: 1 / 3, "2": 1 / 3 };
  const normalized = Object.fromEntries(OUTCOMES.map((key) => [key, projected[key] / total]));
  return {
    "1": round(normalized["1"]),
    X: round(normalized.X),
    "2": round(1 - normalized["1"] - normalized.X),
  };
}

function probabilityAudit(triplet, tolerance = 1e-8) {
  const values = OUTCOMES.map((key) => Number(triplet?.[key]));
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    valid: values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      && Math.abs(sum - 1) <= tolerance,
    sum,
    sumError: Math.abs(sum - 1),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

function poissonProbabilities(lambda, maxGoals) {
  const probabilities = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    probabilities.push((probabilities[goals - 1] * lambda) / goals);
  }
  return probabilities;
}

function dixonColesTau(homeGoals, awayGoals, homeLambda, awayLambda, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - homeLambda * awayLambda * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + homeLambda * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + awayLambda * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function dixonColesScoreMatrix(homeLambda, awayLambda, options = {}) {
  const maxGoals = integer(options.maxGoals ?? DEFAULT_CONFIG.maxGoals, "maxGoals", 6, 16);
  const rho = inRange(options.rho ?? options.dixonColesRho ?? DEFAULT_CONFIG.dixonColesRho, "rho", -0.25, 0.2);
  const home = poissonProbabilities(Math.max(0.001, Number(homeLambda)), maxGoals);
  const away = poissonProbabilities(Math.max(0.001, Number(awayLambda)), maxGoals);
  const rows = [];
  let total = 0;
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const tau = clamp(dixonColesTau(homeGoals, awayGoals, homeLambda, awayLambda, rho), 0.05, 2.5);
      const probability = home[homeGoals] * away[awayGoals] * tau;
      rows.push({ home: homeGoals, away: awayGoals, probability });
      total += probability;
    }
  }
  return rows.map((row) => ({ ...row, probability: row.probability / total }));
}

function outcomeProbabilitiesFromMatrix(matrix) {
  const triplet = { "1": 0, X: 0, "2": 0 };
  for (const row of matrix) {
    if (row.home > row.away) triplet["1"] += row.probability;
    else if (row.home < row.away) triplet["2"] += row.probability;
    else triplet.X += row.probability;
  }
  return normalizeTriplet(triplet);
}

function decayFactor(fromIso, toIso, halfLifeDays) {
  const fromMs = Date.parse(fromIso || "");
  const toMs = Date.parse(toIso || "");
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 1;
  return Math.exp((-Math.log(2) * (toMs - fromMs)) / (halfLifeDays * DAY_MS));
}

function emptyTeam(config) {
  return {
    attack: 0,
    awayMatches: 0,
    defense: 0,
    elo: config.baseElo,
    homeMatches: 0,
    lastPlayedDate: null,
    matches: 0,
    updatedAt: null,
  };
}

function emptyCompetition() {
  return {
    awayGoals: 0,
    awayWins: 0,
    draws: 0,
    homeGoals: 0,
    homeWins: 0,
    matches: 0,
    updatedAt: null,
    weightedMatches: 0,
  };
}

function createState(config) {
  return {
    appliedBatches: 0,
    appliedRows: 0,
    competitions: new Map(),
    config,
    lastAvailableAt: null,
    teams: new Map(),
  };
}

function decayedTeamView(teamInput, asOf, config) {
  const team = teamInput || emptyTeam(config);
  const latentDecay = decayFactor(team.updatedAt, asOf, config.latentHalfLifeDays);
  const eloDecay = decayFactor(team.updatedAt, asOf, config.eloHalfLifeDays);
  const reliability = team.matches / (team.matches + config.coldStartPriorMatches);
  const elo = config.baseElo + (team.elo - config.baseElo) * eloDecay;
  return {
    ...team,
    attack: team.attack * latentDecay,
    defense: team.defense * latentDecay,
    effectiveAttack: team.attack * latentDecay * reliability,
    effectiveDefense: team.defense * latentDecay * reliability,
    effectiveElo: config.baseElo + (elo - config.baseElo) * reliability,
    elo,
    reliability,
  };
}

function materializeTeam(state, entityId, asOf) {
  const view = decayedTeamView(state.teams.get(entityId), asOf, state.config);
  const materialized = {
    attack: view.attack,
    awayMatches: view.awayMatches,
    defense: view.defense,
    elo: view.elo,
    homeMatches: view.homeMatches,
    lastPlayedDate: view.lastPlayedDate,
    matches: view.matches,
    updatedAt: asOf,
  };
  state.teams.set(entityId, materialized);
  return materialized;
}

function decayedCompetitionView(input, asOf, config) {
  const competition = input || emptyCompetition();
  const decay = decayFactor(competition.updatedAt, asOf, config.leagueHalfLifeDays);
  return {
    ...competition,
    awayGoals: competition.awayGoals * decay,
    awayWins: competition.awayWins * decay,
    draws: competition.draws * decay,
    homeGoals: competition.homeGoals * decay,
    homeWins: competition.homeWins * decay,
    weightedMatches: competition.weightedMatches * decay,
  };
}

function materializeCompetition(state, key, asOf) {
  const view = decayedCompetitionView(state.competitions.get(key), asOf, state.config);
  const materialized = { ...view, updatedAt: asOf };
  state.competitions.set(key, materialized);
  return materialized;
}

function smoothedCompetitionRates(state, competitionKey, asOf) {
  const config = state.config;
  const global = decayedCompetitionView(state.competitions.get("__global__"), asOf, config);
  const globalDenominator = global.weightedMatches + config.leaguePriorMatches;
  const globalHome = (global.homeGoals + config.priorHomeGoals * config.leaguePriorMatches) / globalDenominator;
  const globalAway = (global.awayGoals + config.priorAwayGoals * config.leaguePriorMatches) / globalDenominator;
  const globalDraw = (global.draws + config.priorDrawRate * config.leaguePriorMatches) / globalDenominator;

  const competition = decayedCompetitionView(state.competitions.get(competitionKey), asOf, config);
  const denominator = competition.weightedMatches + config.leaguePriorMatches;
  return {
    awayGoals: (competition.awayGoals + globalAway * config.leaguePriorMatches) / denominator,
    drawRate: clamp((competition.draws + globalDraw * config.leaguePriorMatches) / denominator, 0.12, 0.4),
    homeGoals: (competition.homeGoals + globalHome * config.leaguePriorMatches) / denominator,
    matches: competition.matches,
    reliability: competition.weightedMatches / denominator,
    weightedMatches: competition.weightedMatches,
  };
}

function restDays(lastPlayedDate, forecastDate) {
  if (!lastPlayedDate) return null;
  const days = (Date.parse(`${forecastDate}T00:00:00.000Z`) - Date.parse(`${lastPlayedDate}T00:00:00.000Z`)) / DAY_MS;
  return Number.isFinite(days) && days >= 0 ? Math.trunc(days) : null;
}

function eloTriplet(homeElo, awayElo, drawRate, homeAdvantage) {
  const expectedHome = 1 / (1 + 10 ** (-((homeElo + homeAdvantage) - awayElo) / 400));
  const gap = Math.abs(homeElo + homeAdvantage - awayElo);
  const draw = clamp(drawRate * Math.exp(-gap / 1400), 0.12, 0.36);
  return {
    expectedHome,
    probabilities: normalizeTriplet({
      "1": (1 - draw) * expectedHome,
      X: draw,
      "2": (1 - draw) * (1 - expectedHome),
    }),
  };
}

function modelProjection(state, match, forecastBoundary) {
  const config = state.config;
  const home = decayedTeamView(state.teams.get(match.homeTeam.entityId), forecastBoundary, config);
  const away = decayedTeamView(state.teams.get(match.awayTeam.entityId), forecastBoundary, config);
  const league = smoothedCompetitionRates(state, match.competition, forecastBoundary);
  const neutralBase = (league.homeGoals + league.awayGoals) / 2;
  const homeBase = match.neutral ? neutralBase : league.homeGoals;
  const awayBase = match.neutral ? neutralBase : league.awayGoals;
  const homeLambda = clamp(
    homeBase * Math.exp(home.effectiveAttack - away.effectiveDefense),
    config.minLambda,
    config.maxLambda,
  );
  const awayLambda = clamp(
    awayBase * Math.exp(away.effectiveAttack - home.effectiveDefense),
    config.minLambda,
    config.maxLambda,
  );
  const matrix = dixonColesScoreMatrix(homeLambda, awayLambda, {
    maxGoals: config.maxGoals,
    rho: config.dixonColesRho,
  });
  const poisson = outcomeProbabilitiesFromMatrix(matrix);
  const elo = eloTriplet(
    home.effectiveElo,
    away.effectiveElo,
    league.drawRate,
    match.neutral ? 0 : config.eloHomeAdvantage,
  );
  const final = normalizeTriplet(Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    poisson[outcome] * config.poissonWeight + elo.probabilities[outcome] * (1 - config.poissonWeight),
  ])));
  return {
    model: {
      version: DYNAMIC_GOAL_STRENGTH_MODEL_VERSION,
      configHash: stableHash(config),
    },
    features: {
      competition: {
        awayGoalsRate: round(league.awayGoals),
        drawRate: round(league.drawRate),
        homeGoalsRate: round(league.homeGoals),
        matches: league.matches,
        reliability: round(league.reliability),
        weightedMatches: round(league.weightedMatches),
      },
      dixonColes: { rho: config.dixonColesRho },
      home: {
        attack: round(home.effectiveAttack),
        awayMatches: home.awayMatches,
        coldStart: home.matches < config.coldStartPriorMatches,
        defense: round(home.effectiveDefense),
        elo: round(home.effectiveElo, 4),
        homeMatches: home.homeMatches,
        priorMatches: home.matches,
        reliability: round(home.reliability),
        restDays: restDays(home.lastPlayedDate, match.date),
      },
      away: {
        attack: round(away.effectiveAttack),
        awayMatches: away.awayMatches,
        coldStart: away.matches < config.coldStartPriorMatches,
        defense: round(away.effectiveDefense),
        elo: round(away.effectiveElo, 4),
        homeMatches: away.homeMatches,
        priorMatches: away.matches,
        reliability: round(away.reliability),
        restDays: restDays(away.lastPlayedDate, match.date),
      },
      elo: {
        expectedHome: round(elo.expectedHome),
        homeAdvantage: match.neutral ? 0 : config.eloHomeAdvantage,
      },
      poisson: {
        awayLambda: round(awayLambda),
        homeLambda: round(homeLambda),
      },
    },
    probabilities: {
      elo: elo.probabilities,
      final,
      poisson,
    },
  };
}

function addTeamDelta(deltas, entityId, delta) {
  const current = deltas.get(entityId) || {
    attack: 0,
    awayMatches: 0,
    defense: 0,
    elo: 0,
    homeMatches: 0,
    lastPlayedDate: null,
    matches: 0,
  };
  current.attack += delta.attack || 0;
  current.awayMatches += delta.awayMatches || 0;
  current.defense += delta.defense || 0;
  current.elo += delta.elo || 0;
  current.homeMatches += delta.homeMatches || 0;
  current.matches += delta.matches || 0;
  if (delta.lastPlayedDate && (!current.lastPlayedDate || delta.lastPlayedDate > current.lastPlayedDate)) {
    current.lastPlayedDate = delta.lastPlayedDate;
  }
  deltas.set(entityId, current);
}

function applyCompetitionRows(state, key, rows, asOf) {
  const competition = materializeCompetition(state, key, asOf);
  for (const row of rows) {
    const home = row.label.score.home;
    const away = row.label.score.away;
    competition.homeGoals += home;
    competition.awayGoals += away;
    competition.homeWins += home > away ? 1 : 0;
    competition.draws += home === away ? 1 : 0;
    competition.awayWins += home < away ? 1 : 0;
    competition.matches += 1;
    competition.weightedMatches += 1;
  }
}

function applyResultBatch(state, rows, context) {
  const asOf = context.batchAvailableAt;
  const config = state.config;
  const projections = rows.map((row) => ({
    row,
    projection: modelProjection(state, row.match, asOf),
  }));
  const deltas = new Map();
  for (const { row, projection } of projections) {
    const homeId = row.match.homeTeam.entityId;
    const awayId = row.match.awayTeam.entityId;
    const homeGoals = row.label.score.home;
    const awayGoals = row.label.score.away;
    const homeError = homeGoals - projection.features.poisson.homeLambda;
    const awayError = awayGoals - projection.features.poisson.awayLambda;
    const actualHome = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
    const margin = Math.max(1, Math.abs(homeGoals - awayGoals));
    const marginMultiplier = margin <= 1 ? 1 : Math.min(1.8, Math.log(margin + 1));
    const eloDelta = config.eloKFactor * marginMultiplier
      * (actualHome - projection.features.elo.expectedHome);
    addTeamDelta(deltas, homeId, {
      attack: config.goalLearningRate * homeError,
      defense: -config.goalLearningRate * awayError,
      elo: eloDelta,
      homeMatches: 1,
      lastPlayedDate: row.match.date,
      matches: 1,
    });
    addTeamDelta(deltas, awayId, {
      attack: config.goalLearningRate * awayError,
      awayMatches: 1,
      defense: -config.goalLearningRate * homeError,
      elo: -eloDelta,
      lastPlayedDate: row.match.date,
      matches: 1,
    });
  }

  for (const [entityId, delta] of [...deltas.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const team = materializeTeam(state, entityId, asOf);
    team.attack = clamp(
      team.attack * (1 - config.regularization) + delta.attack,
      -config.latentLimit,
      config.latentLimit,
    );
    team.defense = clamp(
      team.defense * (1 - config.regularization) + delta.defense,
      -config.latentLimit,
      config.latentLimit,
    );
    team.elo = clamp(team.elo + delta.elo, config.baseElo - 600, config.baseElo + 600);
    team.matches += delta.matches;
    team.homeMatches += delta.homeMatches;
    team.awayMatches += delta.awayMatches;
    team.lastPlayedDate = delta.lastPlayedDate || team.lastPlayedDate;
  }

  const byCompetition = new Map();
  for (const row of rows) {
    const list = byCompetition.get(row.match.competition) || [];
    list.push(row);
    byCompetition.set(row.match.competition, list);
  }
  for (const [key, competitionRows] of [...byCompetition.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    applyCompetitionRows(state, key, competitionRows, asOf);
  }
  applyCompetitionRows(state, "__global__", rows, asOf);
  state.appliedBatches += 1;
  state.appliedRows += rows.length;
  state.lastAvailableAt = asOf;
}

function serializeState(state) {
  const teams = Object.fromEntries([...state.teams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, {
      attack: round(value.attack),
      awayMatches: value.awayMatches,
      defense: round(value.defense),
      elo: round(value.elo, 6),
      homeMatches: value.homeMatches,
      lastPlayedDate: value.lastPlayedDate,
      matches: value.matches,
      updatedAt: value.updatedAt,
    }]));
  const competitions = Object.fromEntries([...state.competitions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, {
      awayGoals: round(value.awayGoals),
      awayWins: round(value.awayWins),
      draws: round(value.draws),
      homeGoals: round(value.homeGoals),
      homeWins: round(value.homeWins),
      matches: value.matches,
      updatedAt: value.updatedAt,
      weightedMatches: round(value.weightedMatches),
    }]));
  return {
    version: DYNAMIC_GOAL_STRENGTH_STATE_VERSION,
    appliedBatches: state.appliedBatches,
    appliedRows: state.appliedRows,
    competitions,
    lastAvailableAt: state.lastAvailableAt,
    teams,
  };
}

function createModelAdapter(config) {
  const configHash = stableHash(config);
  return {
    version: `${DYNAMIC_GOAL_STRENGTH_MODEL_VERSION}:date-batch-adapter-v1`,
    configHash,
    createState: () => createState(config),
    captureFeature: (state, match, context) => modelProjection(state, match, context.forecastBoundary),
    applyResultBatch,
    serializeState,
  };
}

function withoutHash(value, key) {
  const body = { ...value };
  delete body[key];
  return body;
}

function buildDynamicGoalStrengthArtifact(events, options = {}) {
  const config = normalizeConfig(options.config || options.modelConfig || {});
  const featureArtifact = buildHistoricalAsOfFeatureArtifact(events, createModelAdapter(config));
  const modelBody = {
    version: DYNAMIC_GOAL_STRENGTH_MODEL_VERSION,
    config,
    configHash: stableHash(config),
    featureArtifactHash: featureArtifact.artifactHash,
    finalStateHash: stableHash(featureArtifact.finalState),
    trainingWatermark: featureArtifact.watermark,
  };
  const model = { ...modelBody, modelHash: stableHash(modelBody) };
  const artifactBody = {
    version: DYNAMIC_GOAL_STRENGTH_MODEL_VERSION,
    shadowOnly: true,
    productionEligible: false,
    featureArtifact,
    model,
  };
  return { ...artifactBody, artifactHash: stableHash(artifactBody) };
}

function verifyDynamicGoalStrengthArtifact(artifact) {
  try {
    if (!artifact || artifact.version !== DYNAMIC_GOAL_STRENGTH_MODEL_VERSION) return false;
    if (artifact.shadowOnly !== true || artifact.productionEligible !== false) return false;
    if (!verifyHistoricalAsOfFeatureArtifact(artifact.featureArtifact)) return false;
    if (!HASH_PATTERN.test(String(artifact.artifactHash || ""))) return false;
    if (stableHash(withoutHash(artifact, "artifactHash")) !== artifact.artifactHash) return false;
    const model = artifact.model || {};
    if (stableHash(model.config) !== model.configHash) return false;
    if (model.featureArtifactHash !== artifact.featureArtifact.artifactHash) return false;
    if (stableHash(artifact.featureArtifact.finalState) !== model.finalStateHash) return false;
    if (stableHash(withoutHash(model, "modelHash")) !== model.modelHash) return false;
    for (const snapshot of artifact.featureArtifact.snapshots) {
      for (const key of ["elo", "poisson", "final"]) {
        if (!probabilityAudit(snapshot.probabilities?.[key]).valid) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function metricSummary(rows, probabilityKey) {
  if (!rows.length) return { rows: 0, accuracy: null, brier: null, logLoss: null };
  let hits = 0;
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const probabilities = row.probabilities[probabilityKey];
    const leader = OUTCOMES.slice().sort((left, right) => probabilities[right] - probabilities[left])[0];
    if (leader === row.actual) hits += 1;
    for (const outcome of OUTCOMES) {
      const target = outcome === row.actual ? 1 : 0;
      brier += (probabilities[outcome] - target) ** 2;
    }
    logLoss += -Math.log(Math.max(1e-12, probabilities[row.actual]));
  }
  return {
    rows: rows.length,
    accuracy: round(hits / rows.length),
    brier: round(brier / rows.length),
    logLoss: round(logLoss / rows.length),
  };
}

function evaluationRows(artifact) {
  const labels = new Map(artifact.featureArtifact.labels.map((label) => [label.sourceEventId, label]));
  return artifact.featureArtifact.snapshots.map((snapshot) => {
    const label = labels.get(snapshot.sourceEventId);
    return {
      actual: label.outcome,
      eventCommitmentHash: label.eventCommitmentHash,
      featureHash: snapshot.featureHash,
      forecastBoundary: snapshot.forecastBoundary,
      forecastDate: snapshot.forecastDate,
      labelHash: label.labelHash,
      probabilities: snapshot.probabilities,
      sourceEventId: snapshot.sourceEventId,
      stateWatermark: snapshot.stateWatermark,
    };
  });
}

function groupRowsByDate(rows) {
  const groups = [];
  for (const row of rows) {
    const previous = groups[groups.length - 1];
    if (previous?.date === row.forecastDate) previous.rows.push(row);
    else groups.push({ date: row.forecastDate, rows: [row] });
  }
  return groups;
}

function aggregateMetrics(rows) {
  return {
    elo: metricSummary(rows, "elo"),
    final: metricSummary(rows, "final"),
    poisson: metricSummary(rows, "poisson"),
  };
}

function evaluateDynamicGoalStrengthWalkForward(events, options = {}) {
  const artifact = buildDynamicGoalStrengthArtifact(events, options);
  const rows = evaluationRows(artifact);
  const dateGroups = groupRowsByDate(rows);
  const minimumTrainingRows = Math.max(1, Math.trunc(Number(options.minimumTrainingRows) || 80));
  const holdoutRows = Math.max(1, Math.trunc(Number(options.holdoutRows) || 40));
  const minimumFolds = Math.max(2, Math.trunc(Number(options.minimumFolds) || 3));
  let groupIndex = dateGroups.findIndex((group) => (
    Number(group.rows[0]?.stateWatermark?.consumedRows || 0) >= minimumTrainingRows
  ));
  if (groupIndex < 0) groupIndex = dateGroups.length;
  const folds = [];
  const allHoldoutRows = [];

  while (groupIndex < dateGroups.length) {
    const startGroupIndex = groupIndex;
    const holdout = [];
    while (groupIndex < dateGroups.length && holdout.length < holdoutRows) {
      holdout.push(...dateGroups[groupIndex].rows);
      groupIndex += 1;
    }
    if (holdout.length < holdoutRows) break;
    const first = holdout[0];
    const last = holdout[holdout.length - 1];
    const trainedThrough = first.stateWatermark.maxConsumedAvailableAt;
    const strictWatermark = trainedThrough === null
      || Date.parse(trainedThrough) < Date.parse(first.forecastBoundary);
    const predictionCommitments = holdout.map((row) => ({
      actual: row.actual,
      eventCommitmentHash: row.eventCommitmentHash,
      featureHash: row.featureHash,
      labelHash: row.labelHash,
      probabilities: row.probabilities,
      sourceEventId: row.sourceEventId,
      stateWatermark: row.stateWatermark,
    }));
    const foldBody = {
      fold: folds.length + 1,
      configHash: artifact.model.configHash,
      onlinePolicy: "fixed hyperparameters; state advances only through complete result-date batches available before each forecast boundary",
      training: {
        rows: first.stateWatermark.consumedRows,
        stateRootHash: first.stateWatermark.consumedRootHash,
        trainedThrough,
        strictWatermark,
      },
      window: {
        startDate: dateGroups[startGroupIndex].date,
        endDate: last.forecastDate,
        dateBatches: groupIndex - startGroupIndex,
        rows: holdout.length,
      },
      metrics: aggregateMetrics(holdout),
      holdoutDataHash: stableHash(predictionCommitments),
      firstFeatureHash: first.featureHash,
      lastFeatureHash: last.featureHash,
    };
    folds.push({ ...foldBody, foldManifestHash: stableHash(foldBody) });
    allHoldoutRows.push(...holdout);
  }

  const blockers = [];
  if (folds.length < minimumFolds) blockers.push(`walk-forward-folds:${folds.length}<${minimumFolds}`);
  if (folds.some((fold) => fold.training.strictWatermark !== true)) blockers.push("walk-forward-watermark-not-strict");
  const probabilityInvalidRows = allHoldoutRows.filter((row) => (
    ["elo", "poisson", "final"].some((key) => !probabilityAudit(row.probabilities[key]).valid)
  )).length;
  if (probabilityInvalidRows > 0) blockers.push(`walk-forward-invalid-probabilities:${probabilityInvalidRows}`);
  const evaluationBody = {
    version: DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION,
    status: blockers.length ? "blocked-shadow" : "evaluated-shadow",
    shadowOnly: true,
    productionEligible: false,
    config: {
      minimumTrainingRows,
      holdoutRows,
      minimumFolds,
      dateBatchHoldouts: true,
    },
    source: {
      artifactHash: artifact.artifactHash,
      featureArtifactHash: artifact.featureArtifact.artifactHash,
      modelHash: artifact.model.modelHash,
      rows: artifact.featureArtifact.input.rows,
      rootHash: artifact.featureArtifact.input.rootHash,
    },
    folds,
    aggregate: aggregateMetrics(allHoldoutRows),
    probabilityAudit: {
      invalidRows: probabilityInvalidRows,
      rows: allHoldoutRows.length,
    },
    blockers,
  };
  return { ...evaluationBody, manifestHash: stableHash(evaluationBody) };
}

function verifyDynamicGoalStrengthWalkForward(evaluation) {
  try {
    if (!evaluation || evaluation.version !== DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION) return false;
    if (evaluation.shadowOnly !== true || evaluation.productionEligible !== false) return false;
    if (!HASH_PATTERN.test(String(evaluation.manifestHash || ""))) return false;
    if (stableHash(withoutHash(evaluation, "manifestHash")) !== evaluation.manifestHash) return false;
    if (!Array.isArray(evaluation.folds)) return false;
    for (const fold of evaluation.folds) {
      if (stableHash(withoutHash(fold, "foldManifestHash")) !== fold.foldManifestHash) return false;
      if (fold.training?.strictWatermark !== true) return false;
      if (fold.training.trainedThrough !== null
          && Date.parse(fold.training.trainedThrough) >= Date.parse(`${fold.window.startDate}T00:00:00.000Z`)) return false;
      if (!(fold.window?.rows >= evaluation.config.holdoutRows)) return false;
    }
    if (evaluation.status === "evaluated-shadow" && evaluation.folds.length < evaluation.config.minimumFolds) return false;
    if (evaluation.probabilityAudit?.invalidRows !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  DYNAMIC_GOAL_STRENGTH_MODEL_VERSION,
  DYNAMIC_GOAL_STRENGTH_STATE_VERSION,
  DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION,
  DynamicGoalStrengthError,
  buildDynamicGoalStrengthArtifact,
  dixonColesScoreMatrix,
  evaluateDynamicGoalStrengthWalkForward,
  normalizeConfig,
  outcomeProbabilitiesFromMatrix,
  probabilityAudit,
  verifyDynamicGoalStrengthArtifact,
  verifyDynamicGoalStrengthWalkForward,
};
