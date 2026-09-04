const crypto = require("node:crypto");
const {
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");

const PREDICTION_STATE_IDENTITY_VERSION = "prediction-state-v3";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashPayload = (payload, length = 24) => crypto
  .createHash("sha256")
  .update(typeof payload === "string" ? payload : stableJson(payload))
  .digest("hex")
  .slice(0, length);

const asText = (value) => String(value ?? "").trim();

const readJsonPayload = (value) => {
  if (isObject(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const timestampMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : NaN;
};

const validTimes = (values) => values
  .map((value) => ({ value, time: timestampMs(value) }))
  .filter((entry) => Number.isFinite(entry.time));

const earliestIso = (...values) => {
  const entries = validTimes(values);
  if (!entries.length) return null;
  return new Date(Math.min(...entries.map((entry) => entry.time))).toISOString();
};

const latestIso = (...values) => {
  const entries = validTimes(values);
  if (!entries.length) return null;
  return new Date(Math.max(...entries.map((entry) => entry.time))).toISOString();
};

const sourceMatchIdFor = (...values) => {
  for (const value of values) {
    const text = asText(value);
    if (!text) continue;
    return text.replace(/^sporttery_/, "");
  }
  return "";
};

const normalizedPool = (value) => {
  const text = asText(value).toUpperCase();
  if (text === "HAD" || text === "HHAD") return text;
  return text.includes("HHAD") ? "HHAD" : text.includes("HAD") ? "HAD" : null;
};

const normalizedLine = (pool, value) => {
  if (pool === "HAD") return 0;
  const normalized = asText(value)
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-");
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return Object.is(number, -0) ? 0 : number;
};

const lineForKey = (line) => {
  if (!Number.isFinite(line) || line === 0) return "0";
  const absolute = Math.abs(line);
  const text = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(3).replace(/\.?0+$/, "");
  return `${line > 0 ? "+" : "-"}${text}`;
};

const oddsTriplet = (payload) => {
  const nested = isObject(payload?.odds) ? payload.odds : null;
  const values = [
    payload?.odds1 ?? nested?.odds1 ?? nested?.home ?? nested?.["1"],
    payload?.oddsX ?? nested?.oddsX ?? nested?.draw ?? nested?.X,
    payload?.odds2 ?? nested?.odds2 ?? nested?.away ?? nested?.["2"],
  ].map(Number);
  return values.every((value) => Number.isFinite(value) && value > 1.01) ? values : null;
};

const normalizedBookmaker = (payload) => {
  const explicit = asText(payload?.bookmaker || payload?.oddsBookmaker);
  const context = [
    explicit,
    payload?.oddsSource,
    payload?.origin,
    payload?.sourceUrl,
    payload?.oddsSourceUrl,
    payload?.sourceMethod,
  ].map(asText).join(" ").toLowerCase();
  if (/500(?:\.com)?/.test(context)) return "500.com";
  if (/api[-_ ]?football/.test(context)) return explicit.toLowerCase() || "api-football";
  if (/sporttery|webapi\.sporttery\.cn/.test(context)) return "sporttery";
  if (explicit) return explicit.toLowerCase().replace(/\s+/g, "-");
  return "sporttery";
};

const canonicalOddsState = (record) => {
  const payload = readJsonPayload(record?.payload) || (isObject(record) ? record : null);
  if (!payload) return null;
  const sourceMatchId = sourceMatchIdFor(
    record?.source_match_id,
    payload.sourceMatchId,
    record?.match_id,
    payload.matchId,
    payload.id
  );
  const pool = normalizedPool(record?.pool || payload.poolCode || payload.pool || payload.oddsPoolCode || payload.oddsSource);
  const line = normalizedLine(pool, record?.handicap_line ?? payload.handicapLine ?? payload.handicap);
  const odds = oddsTriplet(payload);
  if (!sourceMatchId || !pool || line === null || !odds) return null;

  const bookmaker = asText(record?.bookmaker) || normalizedBookmaker(payload);
  const stateSignature = [pool, lineForKey(line), ...odds.map((value) => value.toFixed(3))].join("|");
  const stateKey = ["odds-state-v2", sourceMatchId, bookmaker, stateSignature].join("|");
  const firstSeenAt = earliestIso(
    record?.first_seen_at,
    payload.firstSeenAt,
    payload.capturedAt,
    payload.oddsCapturedAt,
    payload.captureBucket,
    record?.captured_at,
    payload.at
  );
  const lastSeenAt = latestIso(
    record?.last_seen_at,
    payload.lastSeenAt,
    payload.at,
    payload.oddsCapturedAt,
    payload.capturedAt,
    payload.captureBucket,
    record?.captured_at,
    payload.oddsUpdatedAt,
    payload.updatedAt
  ) || firstSeenAt;
  if (!firstSeenAt) return null;
  const seenCount = Math.max(1, Number(record?.seen_count || payload.seenCount || 1));
  const matchId = asText(record?.match_id || payload.matchId) || `sporttery_${sourceMatchId}`;
  const sourceUrl = payload.oddsSourceUrl || payload.sourceUrl || null;
  const directOdds = [payload.odds1, payload.oddsX, payload.odds2].every((value) => Number.isFinite(Number(value)));
  const quality = Math.max(
    directOdds ? 1 : 0,
    payload.dataset === "odds-history" ? 2 : 0,
    payload.stateSignature ? 3 : 0,
    String(sourceUrl || "").includes("webapi.sporttery.cn") ? 4 : 0
  );
  const canonicalPayload = withOddsObservationTrail({
    ...payload,
    matchId,
    sourceMatchId,
    poolCode: pool,
    handicapLine: pool === "HHAD" ? lineForKey(line) : 0,
    bookmaker,
    odds1: odds[0],
    oddsX: odds[1],
    odds2: odds[2],
    stateSignature,
    capturedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
  });
  if (!canonicalPayload.oddsSource) canonicalPayload.oddsSource = `${bookmaker}:${pool}`;
  if (!canonicalPayload.oddsSourceUrl && sourceUrl) canonicalPayload.oddsSourceUrl = sourceUrl;

  return {
    id: `odds-state-v2:${hashPayload(stateKey)}`,
    stateKey,
    matchId,
    sourceMatchId,
    pool,
    bookmaker,
    handicapLine: line,
    capturedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
    quality,
    payload: canonicalPayload,
  };
};

const mergeCanonicalOddsStates = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  if (left.stateKey !== right.stateKey) throw new Error("cannot merge different odds states");
  const firstSeenAt = earliestIso(left.firstSeenAt, left.capturedAt, right.firstSeenAt, right.capturedAt);
  const lastSeenAt = latestIso(left.lastSeenAt, left.capturedAt, right.lastSeenAt, right.capturedAt) || firstSeenAt;
  const seenCount = Math.max(1, Number(left.seenCount || 1), Number(right.seenCount || 1));
  const leftQuality = Number(left.quality || 0);
  const rightQuality = Number(right.quality || 0);
  const preferred = rightQuality > leftQuality
    || (rightQuality === leftQuality && timestampMs(right.lastSeenAt) > timestampMs(left.lastSeenAt))
    ? right
    : left;
  return {
    ...preferred,
    id: left.id,
    stateKey: left.stateKey,
    capturedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
    quality: Math.max(leftQuality, rightQuality),
    payload: withOddsObservationTrail({
      ...preferred.payload,
      capturedAt: firstSeenAt,
      firstSeenAt,
      lastSeenAt,
      seenCount,
    }, [left.payload, right.payload]),
  };
};

const canonicalPredictionState = (record) => {
  const payload = readJsonPayload(record?.payload) || (isObject(record) ? record : null);
  if (!payload) return null;
  const sourceMatchId = sourceMatchIdFor(record?.source_match_id, payload.sourceMatchId, record?.match_id, payload.matchId);
  const matchId = asText(record?.match_id || payload.matchId) || (sourceMatchId ? `sporttery_${sourceMatchId}` : "");
  const phase = asText(record?.phase || payload.phase);
  const signature = asText(payload.signature);
  const featureHash = asText(payload.featureSnapshotHash || payload.featureSnapshot?.hash) || "legacy";
  const firstSeenAt = earliestIso(record?.first_seen_at, payload.firstSeenAt, payload.capturedAt, record?.captured_at);
  const lastSeenAt = latestIso(record?.last_seen_at, payload.lastSeenAt, payload.capturedAt, record?.captured_at) || firstSeenAt;
  if (!sourceMatchId || !phase || !signature || !firstSeenAt) return null;
  // A capture is an observation of a semantic forecast state, not a new
  // independent forecast.  Including firstSeenAt here inflated one unchanged
  // prediction into a new warehouse row on every collector cycle and made
  // sample counts look much larger than the number of auditable decisions.
  // firstSeenAt/lastSeenAt remain on the canonical row as observation bounds.
  const stateKey = [PREDICTION_STATE_IDENTITY_VERSION, sourceMatchId, phase, signature, featureHash].join("|");
  const seenCount = Math.max(1, Number(record?.seen_count || payload.seenCount || 1));
  return {
    id: `${PREDICTION_STATE_IDENTITY_VERSION}:${hashPayload(stateKey)}`,
    stateKey,
    matchId,
    sourceMatchId,
    phase,
    capturedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
    payload: {
      ...payload,
      matchId: matchId || payload.matchId || null,
      sourceMatchId,
      phase,
      capturedAt: firstSeenAt,
      firstSeenAt,
      lastSeenAt,
      seenCount,
    },
  };
};

const mergeCanonicalPredictionStates = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  if (left.stateKey !== right.stateKey) throw new Error("cannot merge different prediction states");
  const firstSeenAt = earliestIso(left.firstSeenAt, left.capturedAt, right.firstSeenAt, right.capturedAt);
  const lastSeenAt = latestIso(left.lastSeenAt, left.capturedAt, right.lastSeenAt, right.capturedAt) || firstSeenAt;
  const seenCount = Math.max(1, Number(left.seenCount || 1), Number(right.seenCount || 1));
  const preferred = timestampMs(right.lastSeenAt) > timestampMs(left.lastSeenAt) ? right : left;
  return {
    ...preferred,
    id: left.id,
    stateKey: left.stateKey,
    capturedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
    payload: {
      ...preferred.payload,
      capturedAt: firstSeenAt,
      firstSeenAt,
      lastSeenAt,
      seenCount,
    },
  };
};

module.exports = {
  PREDICTION_STATE_IDENTITY_VERSION,
  asText,
  canonicalOddsState,
  canonicalPredictionState,
  earliestIso,
  hashPayload,
  latestIso,
  mergeCanonicalOddsStates,
  mergeCanonicalPredictionStates,
  readJsonPayload,
  sourceMatchIdFor,
  stableJson,
  timestampMs,
};
