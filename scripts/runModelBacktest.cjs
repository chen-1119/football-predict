const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data");
const outputDir = path.join(serverDataDir, "model-artifacts");
const publicOutputFile = path.join(publicDataDir, "model-evaluation.json");
const serverOutputFile = path.join(outputDir, "evaluation.json");
const shadowCandidatesOutputFile = path.join(outputDir, "shadow-candidates.json");

const VERSION = "rolling-backtest-v7";

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const round = (value, digits = 4) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};

const clampProbability = (value) => Math.min(0.999, Math.max(0.001, Number(value || 0)));

const codeLabels = {
  "1": "home",
  X: "draw",
  "2": "away"
};

const resultCodeFor = (match) => {
  const home = Number(match?.scoreHome);
  const away = Number(match?.scoreAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return "";
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
};

const normalizePercent = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number > 1 ? number / 100 : number;
};

const probabilityTripletFromFinal = (final) => {
  if (!final) return null;
  const home = normalizePercent(final.home);
  const draw = normalizePercent(final.draw);
  const away = normalizePercent(final.away);
  if (![home, draw, away].every((value) => Number.isFinite(value))) return null;
  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": home / total,
    X: draw / total,
    "2": away / total
  };
};

const probabilityTripletFromSignature = (signature) => {
  const parts = String(signature || "").split("|");
  const tail = parts[parts.length - 1] || "";
  const match = tail.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return probabilityTripletFromFinal({
    home: Number(match[1]),
    draw: Number(match[2]),
    away: Number(match[3])
  });
};

const probabilityTripletFor = (match) => {
  return probabilityTripletFromFinal(match?.probabilityModel?.oneXTwo?.final)
    || probabilityTripletFromFinal(match?.probabilityFinal)
    || probabilityTripletFromSignature(match?.signature);
};

const probabilityTripletForSnapshot = (snapshot) => {
  return probabilityTripletFromFinal(snapshot?.probabilityFinal)
    || probabilityTripletFromFinal(snapshot?.probabilityModel?.oneXTwo?.final)
    || probabilityTripletFromFinal(snapshot?.probabilityModel?.final)
    || probabilityTripletFromSignature(snapshot?.signature);
};

const oddsTripletFor = (row) => {
  const source = row?.odds && typeof row.odds === "object" ? row.odds : row;
  const home = Number(source?.odds1 ?? source?.home ?? source?.h);
  const draw = Number(source?.oddsX ?? source?.draw ?? source?.d);
  const away = Number(source?.odds2 ?? source?.away ?? source?.a);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value > 1)) return null;
  return { "1": home, X: draw, "2": away };
};

const marketProbabilityTripletFor = (row) => {
  const odds = oddsTripletFor(row);
  if (!odds) return null;
  const raw = {
    "1": 1 / odds["1"],
    X: 1 / odds.X,
    "2": 1 / odds["2"]
  };
  const total = raw["1"] + raw.X + raw["2"];
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": raw["1"] / total,
    X: raw.X / total,
    "2": raw["2"] / total
  };
};

const topProbabilityCode = (probabilities) => {
  return Object.entries(probabilities || {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "";
};

const probabilityForCode = (probabilities, code) => {
  const value = Number(probabilities?.[code]);
  return Number.isFinite(value) ? value : null;
};

const oddsForCode = (odds, code) => {
  const value = Number(odds?.[code]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const oddsBucket = (odds) => {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
};

const marketTypeFor = (prediction) => {
  if (prediction?.oddsPoolCode === "HHAD" && prediction?.marketType === "1X2") return "HHAD";
  return prediction?.marketType || "unknown";
};

const profileKey = (match) => {
  const text = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.countryName,
    match?.countryNameEn
  ].filter(Boolean).join(" ");
  if (/japan|j1|j2|\u65e5\u672c|\u65e5\u804c/i.test(text)) return "japan";
  if (/international|world cup|friendly|qualifier|fifa|\u56fd\u9645|\u4e16\u754c\u676f/i.test(text)) return "international";
  return "other";
};

const summarizePredictionRows = (rows) => {
  const settled = rows.length;
  const won = rows.filter((row) => row.won).length;
  const stakeReturn = rows.reduce((sum, row) => {
    if (row.won) return sum + Math.max(0, Number(row.odds || 0) - 1);
    return sum - 1;
  }, 0);
  return {
    settled,
    won,
    lost: settled - won,
    hitRate: settled ? round(won / settled) : null,
    flatStakeRoi: settled ? round(stakeReturn / settled) : null,
    avgOdds: settled ? round(rows.reduce((sum, row) => sum + Number(row.odds || 0), 0) / settled, 3) : null
  };
};

const groupSummary = (rows, keyFn) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .map(([key, group]) => [key, summarizePredictionRows(group)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
};

const summarizeProbabilityRows = (rows) => {
  if (!rows.length) {
    return {
      rows: 0,
      brier: null,
      logLoss: null,
      accuracy: null,
      calibrationByConfidence: {}
    };
  }

  let brierSum = 0;
  let logLossSum = 0;
  let correct = 0;
  const buckets = new Map();
  for (const row of rows) {
    const actual = row.actual;
    const probabilities = row.probabilities;
    const predicted = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    if (predicted?.[0] === actual) correct += 1;
    for (const code of ["1", "X", "2"]) {
      const expected = code === actual ? 1 : 0;
      brierSum += (probabilities[code] - expected) ** 2;
    }
    logLossSum += -Math.log(clampProbability(probabilities[actual]));
    const confidence = predicted?.[1] || 0;
    const bucket = confidence < 0.4 ? "p_lt_40" : confidence < 0.5 ? "p_40_50" : confidence < 0.6 ? "p_50_60" : "p_ge_60";
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ confidence, correct: predicted?.[0] === actual });
  }

  const calibrationByConfidence = Object.fromEntries(
    Array.from(buckets.entries()).map(([bucket, group]) => {
      const avgConfidence = group.reduce((sum, row) => sum + row.confidence, 0) / group.length;
      const hitRate = group.filter((row) => row.correct).length / group.length;
      return [bucket, {
        rows: group.length,
        avgConfidence: round(avgConfidence),
        hitRate: round(hitRate),
        calibrationError: round(Math.abs(avgConfidence - hitRate))
      }];
    })
  );

  return {
    rows: rows.length,
    brier: round(brierSum / rows.length),
    logLoss: round(logLossSum / rows.length),
    accuracy: round(correct / rows.length),
    calibrationByConfidence
  };
};

const compareProbabilityMetrics = (modelMetrics, marketMetrics) => {
  if (!modelMetrics?.rows || !marketMetrics?.rows) {
    return {
      rows: 0,
      brierImprovement: null,
      logLossImprovement: null,
      accuracyDelta: null
    };
  }
  return {
    rows: Math.min(modelMetrics.rows, marketMetrics.rows),
    brierImprovement: round(marketMetrics.brier - modelMetrics.brier),
    logLossImprovement: round(marketMetrics.logLoss - modelMetrics.logLoss),
    accuracyDelta: round(modelMetrics.accuracy - marketMetrics.accuracy),
    interpretation: "positive improvement means the model beats the market baseline"
  };
};

const normalizeProbabilityTriplet = (probabilities) => {
  const home = Number(probabilities?.["1"]);
  const draw = Number(probabilities?.X);
  const away = Number(probabilities?.["2"]);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": home / total,
    X: draw / total,
    "2": away / total
  };
};

const blendProbabilityTriplets = (primary, secondary, primaryWeight) => {
  const a = normalizeProbabilityTriplet(primary);
  const b = normalizeProbabilityTriplet(secondary);
  const weight = Number(primaryWeight);
  if (!a || !b || !Number.isFinite(weight)) return null;
  return normalizeProbabilityTriplet({
    "1": a["1"] * weight + b["1"] * (1 - weight),
    X: a.X * weight + b.X * (1 - weight),
    "2": a["2"] * weight + b["2"] * (1 - weight)
  });
};

const temperatureProbabilityTriplet = (probabilities, temperature) => {
  const source = normalizeProbabilityTriplet(probabilities);
  const power = Number(temperature);
  if (!source || !Number.isFinite(power) || power <= 0) return null;
  return normalizeProbabilityTriplet({
    "1": source["1"] ** power,
    X: source.X ** power,
    "2": source["2"] ** power
  });
};

const clampSignal = (value, min = -1.25, max = 1.25) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
};

const oddsTrendSignals = (trend) => {
  if (!trend || typeof trend !== "object") return null;
  return {
    "1": clampSignal(-Number(trend.odds1Change || 0)),
    X: clampSignal(-Number(trend.oddsXChange || 0)),
    "2": clampSignal(-Number(trend.odds2Change || 0))
  };
};

const oddsTrendTiltProbabilityTriplet = (probabilities, trend, strength) => {
  const source = normalizeProbabilityTriplet(probabilities);
  const signals = oddsTrendSignals(trend);
  const weight = Number(strength);
  if (!source || !signals || !Number.isFinite(weight)) return null;
  return normalizeProbabilityTriplet({
    "1": source["1"] * Math.exp(weight * signals["1"]),
    X: source.X * Math.exp(weight * signals.X),
    "2": source["2"] * Math.exp(weight * signals["2"])
  });
};

const teamKeyFor = (...values) => {
  const value = values.find((item) => String(item || "").trim());
  return String(value || "").normalize("NFKC").trim().toLowerCase();
};

const clampNumber = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
};

const scorePairFor = (match) => {
  const home = Number(match?.scoreHome);
  const away = Number(match?.scoreAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away };
};

const emptyTeamStats = () => ({
  matches: 0,
  homeMatches: 0,
  awayMatches: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  homeFor: 0,
  homeAgainst: 0,
  awayFor: 0,
  awayAgainst: 0
});

const createHistoricalModelState = () => ({
  matches: 0,
  homeGoals: 0,
  awayGoals: 0,
  teams: new Map(),
  ratings: new Map()
});

const ensureHistoricalTeam = (state, key) => {
  if (!state.teams.has(key)) state.teams.set(key, emptyTeamStats());
  return state.teams.get(key);
};

const historicalRatingFor = (state, key) => {
  const rating = Number(state.ratings.get(key));
  return Number.isFinite(rating) ? rating : 1500;
};

const eloWinExpectation = (homeRating, awayRating, homeAdvantage = 65) => {
  return 1 / (1 + (10 ** ((awayRating - homeRating - homeAdvantage) / 400)));
};

const eloProbabilityTriplet = (homeRating, awayRating, homeAdvantage = 65) => {
  const expectedHome = eloWinExpectation(homeRating, awayRating, homeAdvantage);
  const diff = Math.abs((homeRating + homeAdvantage) - awayRating) / 400;
  const draw = clampNumber(0.28 - Math.min(0.12, diff * 0.08), 0.16, 0.3);
  return normalizeProbabilityTriplet({
    "1": expectedHome * (1 - draw),
    X: draw,
    "2": (1 - expectedHome) * (1 - draw)
  });
};

const poissonPmf = (lambda, maxGoals) => {
  const safeLambda = clampNumber(lambda, 0.05, 6);
  const values = [];
  let probability = Math.exp(-safeLambda);
  values.push(probability);
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    probability = (probability * safeLambda) / goals;
    values.push(probability);
  }
  return values;
};

const poissonOutcomeProbabilityTriplet = (homeLambda, awayLambda, maxGoals = 8) => {
  const home = poissonPmf(homeLambda, maxGoals);
  const away = poissonPmf(awayLambda, maxGoals);
  const outcomes = { "1": 0, X: 0, "2": 0 };
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const probability = home[homeGoals] * away[awayGoals];
      if (homeGoals > awayGoals) outcomes["1"] += probability;
      else if (homeGoals < awayGoals) outcomes["2"] += probability;
      else outcomes.X += probability;
    }
  }
  return normalizeProbabilityTriplet(outcomes);
};

const smoothedRate = (sum, count, prior, pseudoCount = 6) => {
  const safePrior = Number.isFinite(Number(prior)) && Number(prior) > 0 ? Number(prior) : 1.25;
  return (Number(sum || 0) + safePrior * pseudoCount) / (Number(count || 0) + pseudoCount);
};

const predictHistoricalModels = (state, row) => {
  const homeKey = teamKeyFor(row?.homeTeamName, row?.homeTeamNameEn, row?.homeTeam);
  const awayKey = teamKeyFor(row?.awayTeamName, row?.awayTeamNameEn, row?.awayTeam);
  if (!homeKey || !awayKey || homeKey === awayKey || state.matches < 20) return null;

  const homeStats = state.teams.get(homeKey) || emptyTeamStats();
  const awayStats = state.teams.get(awayKey) || emptyTeamStats();
  const globalHomeGoals = state.matches ? state.homeGoals / state.matches : 1.35;
  const globalAwayGoals = state.matches ? state.awayGoals / state.matches : 1.1;
  const homeAttack = smoothedRate(homeStats.homeFor, homeStats.homeMatches, globalHomeGoals) / globalHomeGoals;
  const awayDefense = smoothedRate(awayStats.awayAgainst, awayStats.awayMatches, globalHomeGoals) / globalHomeGoals;
  const awayAttack = smoothedRate(awayStats.awayFor, awayStats.awayMatches, globalAwayGoals) / globalAwayGoals;
  const homeDefense = smoothedRate(homeStats.homeAgainst, homeStats.homeMatches, globalAwayGoals) / globalAwayGoals;
  const homeLambda = clampNumber(globalHomeGoals * homeAttack * awayDefense, 0.2, 3.8);
  const awayLambda = clampNumber(globalAwayGoals * awayAttack * homeDefense, 0.15, 3.4);
  const homeRating = historicalRatingFor(state, homeKey);
  const awayRating = historicalRatingFor(state, awayKey);
  const eloProbabilities = eloProbabilityTriplet(homeRating, awayRating);
  const poissonProbabilities = poissonOutcomeProbabilityTriplet(homeLambda, awayLambda);
  const historicalBlendProbabilities = blendProbabilityTriplets(eloProbabilities, poissonProbabilities, 0.5);

  return {
    eloProbabilities,
    poissonProbabilities,
    historicalBlendProbabilities,
    featureSnapshot: {
      version: "historical-elo-poisson-v1",
      trainingMatches: state.matches,
      cutoffPolicy: "Only matches with kickoff at least two hours before forecastTime are used.",
      home: {
        key: homeKey,
        matches: homeStats.matches,
        homeMatches: homeStats.homeMatches,
        rating: round(homeRating, 1)
      },
      away: {
        key: awayKey,
        matches: awayStats.matches,
        awayMatches: awayStats.awayMatches,
        rating: round(awayRating, 1)
      },
      global: {
        homeGoalsPerMatch: round(globalHomeGoals),
        awayGoalsPerMatch: round(globalAwayGoals)
      },
      poisson: {
        homeLambda: round(homeLambda),
        awayLambda: round(awayLambda)
      }
    }
  };
};

const applyMatchToHistoricalState = (state, match) => {
  const score = scorePairFor(match);
  const homeKey = teamKeyFor(match?.homeTeamName, match?.homeTeamNameEn, match?.homeTeam);
  const awayKey = teamKeyFor(match?.awayTeamName, match?.awayTeamNameEn, match?.awayTeam);
  if (!score || !homeKey || !awayKey || homeKey === awayKey) return;

  const homeStats = ensureHistoricalTeam(state, homeKey);
  const awayStats = ensureHistoricalTeam(state, awayKey);
  const homeRating = historicalRatingFor(state, homeKey);
  const awayRating = historicalRatingFor(state, awayKey);
  const expectedHome = eloWinExpectation(homeRating, awayRating);
  const actualHome = score.home > score.away ? 1 : score.home < score.away ? 0 : 0.5;
  const margin = Math.max(1, Math.abs(score.home - score.away));
  const kFactor = 20 * (margin > 1 ? Math.log(margin + 1) : 1);
  const delta = kFactor * (actualHome - expectedHome);
  state.ratings.set(homeKey, homeRating + delta);
  state.ratings.set(awayKey, awayRating - delta);

  state.matches += 1;
  state.homeGoals += score.home;
  state.awayGoals += score.away;

  homeStats.matches += 1;
  homeStats.homeMatches += 1;
  homeStats.goalsFor += score.home;
  homeStats.goalsAgainst += score.away;
  homeStats.homeFor += score.home;
  homeStats.homeAgainst += score.away;

  awayStats.matches += 1;
  awayStats.awayMatches += 1;
  awayStats.goalsFor += score.away;
  awayStats.goalsAgainst += score.home;
  awayStats.awayFor += score.away;
  awayStats.awayAgainst += score.home;
};

const attachHistoricalModelFeatures = (rows, allMatches) => {
  const trainingMatches = allMatches
    .filter((match) => match?.status === "FINISHED" && scorePairFor(match))
    .map((match) => ({
      match,
      timeMs: Date.parse(match?.kickoffTime || match?.matchDate || "")
    }))
    .filter((entry) => Number.isFinite(entry.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);

  for (const row of rows) {
    const forecastMs = Date.parse(row?.forecastTime || row?.kickoffTime || "");
    const kickoffMs = Date.parse(row?.kickoffTime || "");
    const cutoffMs = (Number.isFinite(forecastMs) ? forecastMs : kickoffMs) - 2 * 60 * 60 * 1000;
    if (!Number.isFinite(cutoffMs)) continue;
    const state = createHistoricalModelState();
    for (const entry of trainingMatches) {
      if (entry.timeMs > cutoffMs) break;
      if (entry.match?.id && row?.matchId && entry.match.id === row.matchId) continue;
      if (entry.match?.sourceMatchId && row?.sourceMatchId && String(entry.match.sourceMatchId) === String(row.sourceMatchId)) continue;
      applyMatchToHistoricalState(state, entry.match);
    }
    const prediction = predictHistoricalModels(state, row);
    if (!prediction) continue;
    row.eloProbabilities = prediction.eloProbabilities;
    row.poissonProbabilities = prediction.poissonProbabilities;
    row.historicalBlendProbabilities = prediction.historicalBlendProbabilities;
    row.historicalFeatureSnapshot = prediction.featureSnapshot;
  }
};

const summarizeRollingPassRate = (windows, minLogLossImprovement = 0, minBrierImprovement = 0) => {
  const checked = (Array.isArray(windows) ? windows : []).filter((window) => (
    Number.isFinite(Number(window?.improvement?.logLossImprovement))
    && Number.isFinite(Number(window?.improvement?.brierImprovement))
  ));
  const passed = checked.filter((window) => (
    Number(window.improvement.logLossImprovement) >= minLogLossImprovement
    && Number(window.improvement.brierImprovement) >= minBrierImprovement
  ));
  return {
    windows: checked.length,
    passed: passed.length,
    passRate: checked.length ? round(passed.length / checked.length) : null,
    criteria: {
      minLogLossImprovement,
      minBrierImprovement
    },
    recentWindows: checked.slice(-4).map((window) => ({
      startKickoffTime: window.startKickoffTime,
      endKickoffTime: window.endKickoffTime,
      rows: window.rows,
      logLossImprovement: round(window.improvement.logLossImprovement),
      brierImprovement: round(window.improvement.brierImprovement),
      accuracyDelta: round(window.improvement.accuracyDelta)
    }))
  };
};

const shadowCandidateFromRows = (candidate, rows, marketMetrics) => {
  const metrics = summarizeProbabilityRows(rows);
  const rollingWindows = summarizeRollingWindows(rows);
  return {
    ...candidate,
    metrics,
    comparison: compareProbabilityMetrics(metrics, marketMetrics),
    rolling: summarizeRollingPassRate(rollingWindows)
  };
};

const evaluateShadowCandidates = (rows) => {
  const matchedRows = rows.filter((row) => row.marketProbabilities && row.probabilities);
  const baseMarketRows = matchedRows.map((row) => ({ ...row, probabilities: row.marketProbabilities }));
  const baseModelRows = matchedRows.map((row) => ({ ...row, probabilities: row.probabilities }));
  const marketMetrics = summarizeProbabilityRows(baseMarketRows);
  const candidates = [
    shadowCandidateFromRows({
      id: "market-baseline",
      label: "Sporttery market baseline",
      role: "baseline",
      weights: { market: 1, model: 0 }
    }, baseMarketRows, marketMetrics),
    shadowCandidateFromRows({
      id: "current-model",
      label: "Current pre-match probability model",
      role: "current-online-shadow",
      weights: { market: 0, model: 1 }
    }, baseModelRows, marketMetrics)
  ];

  for (const temperature of [0.75, 0.9, 1.1, 1.25, 1.5]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: temperatureProbabilityTriplet(row.marketProbabilities, temperature)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `market-temperature-${String(temperature).replace(".", "_")}`,
      label: `Market baseline temperature ${temperature}`,
      role: "shadow-feature-candidate",
      featureSet: ["sporttery-market", "temperature-calibration"],
      weights: { market: 1, model: 0, temperature }
    }, candidateRows, marketMetrics));
  }

  for (const strength of [0.15, 0.3, 0.45, 0.65, 0.9]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: oddsTrendTiltProbabilityTriplet(row.marketProbabilities, row.oddsTrend, strength)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `odds-trend-tilt-${String(strength).replace(".", "_")}`,
      label: `Sporttery odds-trend tilt ${strength}`,
      role: "shadow-feature-candidate",
      featureSet: ["sporttery-market", "sporttery-odds-trend"],
      weights: { market: 1, model: 0, oddsTrendStrength: strength }
    }, candidateRows, marketMetrics));
  }

  const historicalCandidates = [
    {
      id: "elo-rating-v1",
      label: "Historical Elo 1X2 rating",
      probabilityKey: "eloProbabilities",
      featureSet: ["historical-results", "elo-rating"],
      weights: { elo: 1 }
    },
    {
      id: "poisson-goals-v1",
      label: "Historical Poisson goal distribution",
      probabilityKey: "poissonProbabilities",
      featureSet: ["historical-results", "goal-rate-poisson"],
      weights: { poisson: 1 }
    },
    {
      id: "historical-elo-poisson-50",
      label: "Historical Elo/Poisson blend",
      probabilityKey: "historicalBlendProbabilities",
      featureSet: ["historical-results", "elo-rating", "goal-rate-poisson"],
      weights: { elo: 0.5, poisson: 0.5 }
    }
  ];

  for (const candidate of historicalCandidates) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: row[candidate.probabilityKey]
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: candidate.id,
      label: candidate.label,
      role: "shadow-model-candidate",
      featureSet: candidate.featureSet,
      weights: candidate.weights
    }, candidateRows, marketMetrics));
  }

  for (const marketWeight of [0.75, 0.85, 0.92]) {
    const historicalWeight = round(1 - marketWeight, 2);
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: blendProbabilityTriplets(row.marketProbabilities, row.historicalBlendProbabilities, marketWeight)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `market-history-blend-${Math.round(marketWeight * 100)}`,
      label: `Market/historical blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)}`,
      role: "shadow-model-candidate",
      featureSet: ["sporttery-market", "historical-results", "elo-rating", "goal-rate-poisson"],
      weights: { market: round(marketWeight, 2), historical: historicalWeight }
    }, candidateRows, marketMetrics));
  }

  for (const marketWeight of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: blendProbabilityTriplets(row.marketProbabilities, row.probabilities, marketWeight)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `blend-market-${Math.round(marketWeight * 100)}`,
      label: `Market/model blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)}`,
      role: "shadow-candidate",
      weights: {
        market: round(marketWeight, 2),
        model: round(1 - marketWeight, 2)
      }
    }, candidateRows, marketMetrics));
  }

  const ranked = candidates
    .slice()
    .sort((a, b) => {
      const aLogLoss = Number.isFinite(a.metrics?.logLoss) ? a.metrics.logLoss : Number.POSITIVE_INFINITY;
      const bLogLoss = Number.isFinite(b.metrics?.logLoss) ? b.metrics.logLoss : Number.POSITIVE_INFINITY;
      if (aLogLoss !== bLogLoss) return aLogLoss - bLogLoss;
      const aBrier = Number.isFinite(a.metrics?.brier) ? a.metrics.brier : Number.POSITIVE_INFINITY;
      const bBrier = Number.isFinite(b.metrics?.brier) ? b.metrics.brier : Number.POSITIVE_INFINITY;
      return aBrier - bBrier;
    });
  const balancedRanked = ranked.filter((candidate) => (
    candidate.id !== "market-baseline"
    && Number(candidate.comparison?.logLossImprovement) >= 0
    && Number(candidate.comparison?.brierImprovement) >= 0
  ));
  const best = balancedRanked[0] || ranked[0] || null;
  return {
    version: "shadow-candidates-v3",
    generatedAt: new Date().toISOString(),
    sample: {
      rows: matchedRows.length,
      sourceRows: rows.length
    },
    baselineId: "market-baseline",
    bestCandidateId: best?.id || null,
    bestCandidate: best || null,
    summary: {
      candidateCount: ranked.length,
      balancedCandidateCount: balancedRanked.length,
      bestLogLossImprovement: Number.isFinite(Number(best?.comparison?.logLossImprovement))
        ? round(Number(best.comparison.logLossImprovement))
        : null,
      bestBrierImprovement: Number.isFinite(Number(best?.comparison?.brierImprovement))
        ? round(Number(best.comparison.brierImprovement))
        : null,
      bestRollingPassRate: Number.isFinite(Number(best?.rolling?.passRate))
        ? round(Number(best.rolling.passRate))
        : null
    },
    selectionPolicy: balancedRanked.length
      ? "best candidate must be non-negative on both log loss and Brier before ranking by log loss"
      : "no non-baseline candidate improved both log loss and Brier; ranking falls back to lowest log loss",
    candidates: ranked,
    policy: {
      onlineEffect: "shadow-only",
      promotionRule: "A shadow candidate must beat the market baseline on log loss and Brier score over enough time-ordered samples before it can affect recommendations."
    }
  };
};

const summarizeClvRows = (rows) => {
  const clvRows = rows.filter((row) => Number.isFinite(Number(row.clvProbabilityMove)));
  if (!clvRows.length) {
    return {
      rows: 0,
      positiveClvRate: null,
      avgProbabilityMove: null,
      avgOddsRatioMove: null
    };
  }
  const positiveRows = clvRows.filter((row) => Number(row.clvProbabilityMove) > 0);
  const oddsMoveRows = clvRows.filter((row) => Number.isFinite(Number(row.clvOddsRatioMove)));
  return {
    rows: clvRows.length,
    positiveClvRate: round(positiveRows.length / clvRows.length),
    avgProbabilityMove: round(clvRows.reduce((sum, row) => sum + Number(row.clvProbabilityMove), 0) / clvRows.length),
    avgOddsRatioMove: oddsMoveRows.length
      ? round(oddsMoveRows.reduce((sum, row) => sum + Number(row.clvOddsRatioMove), 0) / oddsMoveRows.length)
      : null,
    note: "positive probability move means the closing no-vig market moved toward the model pick"
  };
};

const summarizeRollingWindows = (rows, windowSize = 50, step = 25) => {
  const sorted = rows
    .filter((row) => row.marketProbabilities && row.kickoffTime)
    .slice()
    .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""));
  if (sorted.length < Math.min(10, windowSize)) return [];

  const windows = [];
  const safeWindowSize = Math.min(windowSize, sorted.length);
  const safeStep = Math.max(1, Math.min(step, safeWindowSize));
  for (let start = 0; start <= sorted.length - safeWindowSize; start += safeStep) {
    const group = sorted.slice(start, start + safeWindowSize);
    const modelMetrics = summarizeProbabilityRows(group);
    const marketMetrics = summarizeProbabilityRows(group.map((row) => ({
      ...row,
      probabilities: row.marketProbabilities
    })));
    windows.push({
      startKickoffTime: group[0]?.kickoffTime || null,
      endKickoffTime: group[group.length - 1]?.kickoffTime || null,
      rows: group.length,
      model: {
        brier: modelMetrics.brier,
        logLoss: modelMetrics.logLoss,
        accuracy: modelMetrics.accuracy
      },
      market: {
        brier: marketMetrics.brier,
        logLoss: marketMetrics.logLoss,
        accuracy: marketMetrics.accuracy
      },
      improvement: compareProbabilityMetrics(modelMetrics, marketMetrics)
    });
  }
  return windows.slice(-12);
};

const dedupeMatches = (matches) => {
  const byKey = new Map();
  for (const match of matches) {
    const key = match?.sourceMatchId || match?.id || `${match?.homeTeamName}-${match?.awayTeamName}-${match?.kickoffTime}`;
    if (!key) continue;
    const previous = byKey.get(key);
    const score = (match?.status === "FINISHED" ? 2 : 0) + (Array.isArray(match?.predictions) ? 1 : 0);
    const previousScore = (previous?.status === "FINISHED" ? 2 : 0) + (Array.isArray(previous?.predictions) ? 1 : 0);
    if (!previous || score >= previousScore) byKey.set(key, match);
  }
  return Array.from(byKey.values());
};

const keyVariantsFor = (row) => {
  const keys = new Set();
  const matchId = String(row?.matchId || row?.id || "").trim();
  const sourceMatchId = String(row?.sourceMatchId || "").trim();
  if (matchId) {
    keys.add(matchId);
    keys.add(matchId.replace(/^sporttery_/, ""));
  }
  if (sourceMatchId) {
    keys.add(sourceMatchId);
    keys.add(`sporttery_${sourceMatchId}`);
  }
  return Array.from(keys).filter(Boolean);
};

const snapshotTimeMs = (snapshot, kickoffMs) => {
  if (snapshot?.phase === "review") return NaN;
  const captured = Date.parse(snapshot?.capturedAt || "");
  if (Number.isFinite(captured) && captured <= kickoffMs) return captured;
  const firstSeen = Date.parse(snapshot?.firstSeenAt || "");
  if (Number.isFinite(firstSeen) && firstSeen <= kickoffMs) return firstSeen;
  return NaN;
};

const buildSnapshotIndex = (snapshots) => {
  const index = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (!probabilityTripletForSnapshot(snapshot)) continue;
    for (const key of keyVariantsFor(snapshot)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(snapshot);
    }
  }
  for (const rows of index.values()) {
    rows.sort((a, b) => {
      const aTime = Date.parse(a.capturedAt || a.firstSeenAt || "") || 0;
      const bTime = Date.parse(b.capturedAt || b.firstSeenAt || "") || 0;
      return aTime - bTime;
    });
  }
  return index;
};

const buildOddsIndex = (rows) => {
  const index = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (!marketProbabilityTripletFor(row)) continue;
    const capturedMs = Date.parse(row.capturedAt || row.captureBucket || row.updatedAt || "");
    if (!Number.isFinite(capturedMs)) continue;
    for (const key of keyVariantsFor(row)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ row, capturedMs });
    }
  }
  for (const rowsForKey of index.values()) {
    rowsForKey.sort((a, b) => a.capturedMs - b.capturedMs);
  }
  return index;
};

const findLatestOddsBefore = (match, oddsIndex, cutoffMs) => {
  if (!Number.isFinite(cutoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const entry of oddsIndex.get(key) || []) {
      if (entry.capturedMs > cutoffMs) continue;
      const seenKey = `${entry.row.sourceMatchId || ""}:${entry.row.matchId || ""}:${entry.row.capturedAt || entry.row.captureBucket || ""}:${entry.row.oddsSource || ""}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      candidates.push(entry);
    }
  }
  candidates.sort((a, b) => b.capturedMs - a.capturedMs);
  return candidates[0] || null;
};

const findPreMatchSnapshotFor = (match, snapshotIndex) => {
  const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
  if (!Number.isFinite(kickoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const snapshot of snapshotIndex.get(key) || []) {
      const rowKey = `${snapshot.matchId || ""}:${snapshot.sourceMatchId || ""}:${snapshot.phase || ""}:${snapshot.capturedAt || snapshot.firstSeenAt || ""}:${snapshot.signature || ""}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      const timeMs = snapshotTimeMs(snapshot, kickoffMs);
      if (!Number.isFinite(timeMs)) continue;
      const probabilities = probabilityTripletForSnapshot(snapshot);
      if (!probabilities) continue;
      candidates.push({ snapshot, timeMs, probabilities });
    }
  }
  candidates.sort((a, b) => b.timeMs - a.timeMs);
  return candidates[0] || null;
};

const current = readJson(path.join(publicDataDir, "matches-current.json"), []);
const history = readJson(path.join(publicDataDir, "matches-history.json"), []);
const predictionSnapshots = readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });
const oddsHistory = readJson(path.join(publicDataDir, "odds-history.json"), { rows: [] });
const matches = dedupeMatches([...(Array.isArray(current) ? current : []), ...(Array.isArray(history) ? history : [])]);
const snapshotRows = Array.isArray(predictionSnapshots?.rows) ? predictionSnapshots.rows : [];
const oddsRows = Array.isArray(oddsHistory?.rows) ? oddsHistory.rows : [];
const snapshotIndex = buildSnapshotIndex(snapshotRows);
const oddsIndex = buildOddsIndex(oddsRows);

const probabilityRows = [];
const predictionRows = [];
const probabilitySourceCounts = {
  matchProbabilityModel: 0,
  preMatchSnapshot: 0,
  missing: 0
};
for (const match of matches) {
  if (match?.status !== "FINISHED") continue;
  const actual = resultCodeFor(match);
  if (!actual) continue;

  let probabilities = probabilityTripletFor(match);
  let probabilitySource = "matchProbabilityModel";
  let snapshotMeta = null;
  let selectedSnapshot = null;
  let forecastTimeMs = Date.parse(match?.predictionMeta?.lockedAt || match?.predictionMeta?.generatedAt || match?.predictionMeta?.updatedAt || "");
  if (!probabilities) {
    selectedSnapshot = findPreMatchSnapshotFor(match, snapshotIndex);
    probabilities = selectedSnapshot?.probabilities || null;
    probabilitySource = probabilities ? "preMatchSnapshot" : "missing";
    forecastTimeMs = selectedSnapshot?.timeMs || forecastTimeMs;
    snapshotMeta = selectedSnapshot ? {
      phase: selectedSnapshot.snapshot?.phase || null,
      capturedAt: selectedSnapshot.snapshot?.capturedAt || null,
      firstSeenAt: selectedSnapshot.snapshot?.firstSeenAt || null,
      policyVersion: selectedSnapshot.snapshot?.policyVersion || null,
      probabilityModelVersion: selectedSnapshot.snapshot?.probabilityModelVersion || null
    } : null;
  }
  if (probabilities) {
    const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
    const forecastOdds = findLatestOddsBefore(match, oddsIndex, Number.isFinite(forecastTimeMs) ? forecastTimeMs : kickoffMs);
    const closingOdds = findLatestOddsBefore(match, oddsIndex, kickoffMs);
    const marketProbabilities = marketProbabilityTripletFor(forecastOdds?.row);
    const closingMarketProbabilities = marketProbabilityTripletFor(closingOdds?.row);
    const modelPick = topProbabilityCode(probabilities);
    const forecastOddsTriplet = oddsTripletFor(forecastOdds?.row);
    const closingOddsTriplet = oddsTripletFor(closingOdds?.row);
    const forecastPickOdds = oddsForCode(forecastOddsTriplet, modelPick);
    const closingPickOdds = oddsForCode(closingOddsTriplet, modelPick);
    const forecastMarketPickProbability = probabilityForCode(marketProbabilities, modelPick);
    const closingMarketPickProbability = probabilityForCode(closingMarketProbabilities, modelPick);
    const clvProbabilityMove = Number.isFinite(forecastMarketPickProbability) && Number.isFinite(closingMarketPickProbability)
      ? closingMarketPickProbability - forecastMarketPickProbability
      : null;
    const clvOddsRatioMove = Number.isFinite(forecastPickOdds) && Number.isFinite(closingPickOdds) && closingPickOdds > 0
      ? (forecastPickOdds / closingPickOdds) - 1
      : null;
    probabilitySourceCounts[probabilitySource] += 1;
    probabilityRows.push({
      matchId: match.id || null,
      sourceMatchId: match.sourceMatchId || null,
      kickoffTime: match.kickoffTime || null,
      forecastTime: Number.isFinite(forecastTimeMs) ? new Date(forecastTimeMs).toISOString() : null,
      league: match.leagueName || match.leagueNameEn || "unknown",
      homeTeamName: match.homeTeamName || match.homeTeamNameEn || null,
      awayTeamName: match.awayTeamName || match.awayTeamNameEn || null,
      profile: profileKey(match),
      actual,
      probabilities,
      marketProbabilities,
      closingMarketProbabilities,
      modelPick,
      oddsTrend: selectedSnapshot?.snapshot?.oddsTrend || null,
      clvProbabilityMove,
      clvOddsRatioMove,
      probabilitySource,
      market: marketProbabilities ? {
        capturedAt: forecastOdds?.row?.capturedAt || forecastOdds?.row?.captureBucket || null,
        odds: forecastOddsTriplet,
        probabilities: marketProbabilities
      } : null,
      closingLine: closingMarketProbabilities ? {
        capturedAt: closingOdds?.row?.capturedAt || closingOdds?.row?.captureBucket || null,
        odds: closingOddsTriplet,
        probabilities: closingMarketProbabilities
      } : null,
      snapshot: snapshotMeta
    });
  } else {
    probabilitySourceCounts.missing += 1;
  }

  const seenPredictionRows = new Set();
  const addPredictionRow = (prediction) => {
    if (!prediction || prediction.tipCode === "WATCH") return;
    const status = prediction.resultStatus;
    if (status !== "WON" && status !== "LOST") return;
    const key = [
      match.id || "",
      marketTypeFor(prediction),
      prediction.oddsPoolCode || "",
      prediction.handicapLine ?? "",
      prediction.tipCode,
      prediction.odds || ""
    ].join("|");
    if (seenPredictionRows.has(key)) return;
    seenPredictionRows.add(key);
    predictionRows.push({
      matchId: match.id || null,
      kickoffTime: match.kickoffTime || null,
      league: match.leagueName || match.leagueNameEn || "unknown",
      profile: profileKey(match),
      marketType: marketTypeFor(prediction),
      tipCode: prediction.tipCode,
      odds: Number(prediction.odds || 0),
      oddsBucket: oddsBucket(prediction.odds),
      won: status === "WON"
    });
  };

  for (const prediction of Array.isArray(match.predictions) ? match.predictions : []) {
    addPredictionRow(prediction);
  }
  for (const prediction of Array.isArray(match?.postMatchReview?.predictionReview?.rows)
    ? match.postMatchReview.predictionReview.rows
    : []) {
    addPredictionRow(prediction);
  }
}

attachHistoricalModelFeatures(probabilityRows, matches);

const historicalModelRows = {
  elo: probabilityRows.filter((row) => row.eloProbabilities).length,
  poisson: probabilityRows.filter((row) => row.poissonProbabilities).length,
  historicalBlend: probabilityRows.filter((row) => row.historicalBlendProbabilities).length
};
const modelProbabilityMetrics = summarizeProbabilityRows(probabilityRows);
const marketBaselineRows = probabilityRows
  .filter((row) => row.marketProbabilities)
  .map((row) => ({
    ...row,
    probabilities: row.marketProbabilities
  }));
const marketBaselineMetrics = summarizeProbabilityRows(marketBaselineRows);
const matchedModelRows = probabilityRows.filter((row) => row.marketProbabilities);
const matchedModelMetrics = summarizeProbabilityRows(matchedModelRows);
const clvRows = probabilityRows
  .filter((row) => row.marketProbabilities && row.closingMarketProbabilities)
  .map((row) => ({
    matchId: row.matchId,
    sourceMatchId: row.sourceMatchId,
    kickoffTime: row.kickoffTime,
    forecastTime: row.forecastTime,
    modelPick: row.modelPick,
    actual: row.actual,
    clvProbabilityMove: row.clvProbabilityMove,
    clvOddsRatioMove: row.clvOddsRatioMove,
    won: row.modelPick === row.actual
  }));
const rollingWindows = summarizeRollingWindows(probabilityRows);
const shadowCandidates = evaluateShadowCandidates(probabilityRows);

const payload = {
  ok: true,
  version: VERSION,
  generatedAt: new Date().toISOString(),
  source: "settled-pre-match-predictions",
  sample: {
    matches: matches.length,
    predictionSnapshots: snapshotRows.length,
    oddsHistoryRows: oddsRows.length,
    probabilityRows: probabilityRows.length,
    marketBaselineRows: marketBaselineRows.length,
    clvRows: clvRows.length,
    historicalModelRows,
    probabilitySources: probabilitySourceCounts,
    predictionRows: predictionRows.length
  },
  probabilityMetrics: modelProbabilityMetrics,
  marketBaseline: {
    source: "sporttery-had-devigged-at-forecast-time",
    metrics: marketBaselineMetrics,
    modelOnSameRows: matchedModelMetrics,
    comparison: compareProbabilityMetrics(matchedModelMetrics, marketBaselineMetrics)
  },
  closingLineValue: summarizeClvRows(clvRows),
  rollingWindows,
  shadowCandidates: {
    version: shadowCandidates.version,
    generatedAt: shadowCandidates.generatedAt,
    sample: shadowCandidates.sample,
    baselineId: shadowCandidates.baselineId,
    bestCandidateId: shadowCandidates.bestCandidateId,
    bestCandidate: shadowCandidates.bestCandidate,
    summary: shadowCandidates.summary,
    selectionPolicy: shadowCandidates.selectionPolicy,
    candidates: shadowCandidates.candidates,
    policy: shadowCandidates.policy
  },
  recommendationMetrics: {
    total: summarizePredictionRows(predictionRows),
    byMarket: groupSummary(predictionRows, (row) => row.marketType),
    byProfile: groupSummary(predictionRows, (row) => row.profile),
    byOddsBucket: groupSummary(predictionRows, (row) => row.oddsBucket)
  },
  policy: {
    split: "time-ordered rolling backtest required before online promotion",
    leakageGuard: "probability metrics use match probabilityModel or prediction snapshots captured/first-seen no later than kickoff; market baseline uses odds captured no later than the forecast time; review snapshots are excluded",
    promotionGate: "shadow models must beat or approach the market baseline on rolling Brier/log loss before affecting online recommendations",
    llmRole: "risk review and explanation only"
  }
};

writeJson(serverOutputFile, payload);
writeJson(publicOutputFile, payload);
writeJson(shadowCandidatesOutputFile, shadowCandidates);

console.log(JSON.stringify({
  ok: true,
  outputFiles: [serverOutputFile, publicOutputFile, shadowCandidatesOutputFile],
  sample: payload.sample,
  probabilityMetrics: payload.probabilityMetrics,
  marketBaseline: payload.marketBaseline,
  shadowCandidates: {
    sample: shadowCandidates.sample,
    bestCandidateId: shadowCandidates.bestCandidateId,
    bestCandidate: shadowCandidates.bestCandidate
  },
  closingLineValue: payload.closingLineValue,
  recommendationTotal: payload.recommendationMetrics.total
}, null, 2));
