const DEVIG_METHOD = "multiplicative-normalization-v1";

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const round = (value, digits = 6) => {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(digits));
};

const normalizeOdds = (value) => {
  if (!value || typeof value !== "object") return null;
  const one = finiteNumber(value.odds1 ?? value["1"] ?? value.home);
  const draw = finiteNumber(value.oddsX ?? value.X ?? value.draw);
  const two = finiteNumber(value.odds2 ?? value["2"] ?? value.away);
  if (![one, draw, two].every((odds) => odds !== null && odds > 1)) return null;
  return { "1": one, X: draw, "2": two };
};

const devigOdds = (value) => {
  const odds = normalizeOdds(value);
  if (!odds) return null;
  const raw = { "1": 1 / odds["1"], X: 1 / odds.X, "2": 1 / odds["2"] };
  const overround = raw["1"] + raw.X + raw["2"];
  if (!(overround > 0)) return null;
  return {
    method: DEVIG_METHOD,
    odds: Object.fromEntries(Object.entries(odds).map(([code, item]) => [code, round(item, 4)])),
    overround: round(overround),
    margin: round(overround - 1),
    probabilities: {
      "1": round(raw["1"] / overround),
      X: round(raw.X / overround),
      "2": round(raw["2"] / overround),
    },
  };
};

const logit = (value) => {
  const probability = Math.max(0.000001, Math.min(0.999999, Number(value)));
  return Math.log(probability / (1 - probability));
};

const parseLine = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "")
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-")
    .replace(/[^0-9+\-.]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const lineMovement = (openLine, currentLine) => {
  const open = parseLine(openLine);
  const current = parseLine(currentLine);
  if (open === null || current === null) return null;
  const delta = round(current - open, 2);
  return {
    open,
    current,
    delta,
    direction: delta < 0
      ? "home-gives-more"
      : delta > 0
        ? "home-gives-less"
        : "unchanged",
  };
};

const analyzeMarketMovement = ({
  pool = "HAD",
  openOdds,
  currentOdds,
  openLine = 0,
  currentLine = openLine,
  sampleSize = null,
  openObservedAt = null,
  currentObservedAt = null,
} = {}) => {
  const open = devigOdds(openOdds);
  const current = devigOdds(currentOdds);
  if (!open || !current) {
    return {
      version: "market-movement-v1",
      available: false,
      pool: String(pool || "").toUpperCase(),
      blocker: "invalid-or-incomplete-odds",
    };
  }
  const normalizedPool = String(pool || "").toUpperCase();
  const changes = {};
  for (const code of ["1", "X", "2"]) {
    changes[code] = {
      probabilityDelta: round(current.probabilities[code] - open.probabilities[code]),
      logitDelta: round(logit(current.probabilities[code]) - logit(open.probabilities[code])),
      rawOddsDelta: round(current.odds[code] - open.odds[code], 4),
    };
  }
  const overroundDelta = round(current.overround - open.overround);
  return {
    version: "market-movement-v1",
    available: true,
    pool: normalizedPool,
    sampleSize: finiteNumber(sampleSize),
    observedAt: {
      open: openObservedAt,
      current: currentObservedAt,
    },
    devigMethod: DEVIG_METHOD,
    open,
    current,
    changes,
    overroundDelta,
    overroundShiftMaterial: Math.abs(overroundDelta) >= 0.03,
    line: normalizedPool === "HHAD" ? lineMovement(openLine, currentLine) : null,
  };
};

const movementEvidenceForCode = (movement, code, {
  minimumSamples = 2,
  supportProbabilityDelta = 0.015,
  contradictionProbabilityDelta = -0.02,
} = {}) => {
  const normalizedCode = String(code || "").toUpperCase();
  const change = movement?.changes?.[normalizedCode];
  const samples = finiteNumber(movement?.sampleSize);
  if (movement?.available !== true || !change || (samples !== null && samples < minimumSamples)) {
    return {
      available: false,
      supports: false,
      contradicts: false,
      blocker: "insufficient-market-movement-sample",
    };
  }
  const delta = finiteNumber(change.probabilityDelta);
  const lineChanged = movement?.pool === "HHAD"
    && finiteNumber(movement?.line?.delta) !== null
    && finiteNumber(movement.line.delta) !== 0;
  return {
    available: delta !== null,
    supports: !lineChanged && delta !== null && delta >= supportProbabilityDelta,
    contradicts: !lineChanged && delta !== null && delta <= contradictionProbabilityDelta,
    blocker: lineChanged ? "handicap-line-changed-requires-separate-cohort" : null,
    probabilityDelta: delta,
    logitDelta: finiteNumber(change.logitDelta),
    overroundShiftMaterial: movement.overroundShiftMaterial === true,
    lineMovement: movement.line || null,
    policy: "support is measured on same-line no-vig probability movement; raw SP or cross-line movement alone never selects a direction",
  };
};

module.exports = {
  DEVIG_METHOD,
  analyzeMarketMovement,
  devigOdds,
  lineMovement,
  movementEvidenceForCode,
  normalizeOdds,
  parseLine,
};
