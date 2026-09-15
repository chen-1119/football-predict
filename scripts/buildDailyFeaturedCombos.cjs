"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  isOfficialRecommendationEligible,
  parseHandicapLine,
} = require("../src/services/officialRecommendationEligibility.cjs");
const {
  canonicalSourceMatchId,
  eventVersionOf,
} = require("../src/services/matchLifecycle.cjs");

const VERSION = "daily-featured-combos-v1";
const SHANGHAI_OFFSET = "+08:00";
const TWO_LEG_MIN_SP = 2.5;
const THREE_LEG_MIN_SP = 5.0;
const MIN_EVIDENCE_SCORE = 62;
const MIN_LEG_SP = 1.2;
const MAX_LEG_SP = 4.0;
const DEFAULT_STORE_DIR = path.resolve(
  process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(__dirname, "..", "server-data")
);
const DEFAULT_PUBLIC_DIR = path.resolve(
  process.env.DATA_GENERATION_PUBLIC_DATA_DIR || path.join(__dirname, "..", "public", "data")
);

const text = (value) => String(value ?? "").trim();
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const atomicWriteJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temp, filePath);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
};

const shanghaiDate = (value = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
};

const isWeekendBusinessDate = (date) => {
  const day = new Date(`${date}T12:00:00${SHANGHAI_OFFSET}`).getUTCDay();
  return day === 0 || day === 6;
};

const businessFreezeAt = (date) => Date.parse(
  `${date}T${isWeekendBusinessDate(date) ? "22" : "21"}:00:00${SHANGHAI_OFFSET}`
);
const businessHardCutoffAt = (date) => Date.parse(
  `${date}T${isWeekendBusinessDate(date) ? "23" : "22"}:00:00${SHANGHAI_OFFSET}`
);

const matchBusinessDate = (match) => text(match?.businessDate)
  || (Number.isFinite(Date.parse(match?.kickoffTime || "")) ? shanghaiDate(Date.parse(match.kickoffTime)) : "");

const officialPool = (match, pool) => {
  if (pool === "HHAD") {
    if (!String(match?.handicapOddsSource || "").toLowerCase().startsWith("sporttery:hhad")) return null;
    const odds = match?.handicapOdds;
    const line = parseHandicapLine(match?.handicapLine);
    if (!odds || line === null) return null;
    return { odds, line, source: match.handicapOddsSource };
  }
  if (!String(match?.oddsSource || "").toLowerCase().startsWith("sporttery:had")) return null;
  return match?.odds ? { odds: match.odds, line: 0, source: match.oddsSource } : null;
};

const oddForCode = (odds, code) => {
  const value = code === "1" ? odds?.odds1 : code === "X" ? odds?.oddsX : code === "2" ? odds?.odds2 : null;
  return finite(value);
};

const evidenceScore = (prediction) => {
  const explicit = finite(prediction?.multiFactorEvidence?.evidenceScore);
  if (explicit !== null && explicit >= 0 && explicit <= 100) return explicit;
  const legacy = finite(prediction?.trustScore);
  return legacy !== null && legacy >= 0 && legacy <= 100 ? legacy : null;
};

const hardRisk = (prediction) => (prediction?.riskTags || []).some((tag) => {
  const value = `${tag?.zh || ""} ${tag?.en || ""}`.toLowerCase();
  return /reference|model[-_ ]?only|watch|market disagreement|handicap support weak|heavy favorite|数据不足|市场分歧|让球支持不足/.test(value);
});

const candidateFromMatch = (match, nowMs) => {
  if (match?.status !== "SCHEDULED") return null;
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return null;
  const buyEndMs = Date.parse(match?.buyEndTime || "");
  if (Number.isFinite(buyEndMs) && nowMs >= buyEndMs) return null;

  const predictions = Array.isArray(match?.predictions) ? match.predictions : [];
  const prediction = predictions.find((row) => (
    row?.marketType === "BEST"
    && row?.recommendationAction === "recommend"
    && ["HAD", "HHAD"].includes(row?.oddsPoolCode)
    && ["1", "X", "2"].includes(row?.tipCode)
  ));
  if (!prediction || hardRisk(prediction)) return null;

  const score = evidenceScore(prediction);
  if (score === null || score < MIN_EVIDENCE_SCORE) return null;
  const pool = prediction.oddsPoolCode === "HHAD" ? "HHAD" : "HAD";
  const official = officialPool(match, pool);
  if (!official) return null;
  const sp = oddForCode(official.odds, prediction.tipCode);
  if (sp === null || sp < MIN_LEG_SP || sp > MAX_LEG_SP) return null;
  if (!isOfficialRecommendationEligible(prediction, sp, official.line)) return null;

  const eventVersion = eventVersionOf(match);
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  if (!eventVersion || !sourceMatchId) return null;

  return {
    matchId: text(match.id),
    sourceMatchId,
    eventVersion,
    matchNo: text(match.matchNo) || null,
    leagueName: text(match.leagueName || match.leagueShortName) || null,
    kickoffTime: match.kickoffTime,
    homeTeamName: text(match.homeTeamName) || null,
    awayTeamName: text(match.awayTeamName) || null,
    pool,
    handicapLine: pool === "HHAD" ? official.line : 0,
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel || null,
    sp: round(sp, 3),
    evidenceScore: round(score, 1),
    predictionPolicyVersion: text(match?.predictionMeta?.policyVersion || match?.predictionMeta?.version) || null,
    evidenceVersion: text(prediction?.multiFactorEvidence?.version) || null,
  };
};

const combinationScore = (legs, minSp) => {
  const totalSp = legs.reduce((product, leg) => product * leg.sp, 1);
  const averageEvidence = legs.reduce((sum, leg) => sum + leg.evidenceScore, 0) / legs.length;
  const evidenceFloor = Math.min(...legs.map((leg) => leg.evidenceScore));
  const targetDistance = Math.abs(Math.log(totalSp / minSp));
  return {
    totalSp,
    averageEvidence,
    evidenceFloor,
    rank: averageEvidence * 1.6 + evidenceFloor * 0.8 - targetDistance * 18,
  };
};

const combinations = (items, count) => {
  const out = [];
  const walk = (start, selected) => {
    if (selected.length === count) {
      out.push(selected.slice());
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      selected.push(items[index]);
      walk(index + 1, selected);
      selected.pop();
    }
  };
  walk(0, []);
  return out;
};

const selectFeaturedCombination = (candidates, count, minSp) => {
  const eligible = combinations(candidates, count)
    .map((legs) => ({ legs, ...combinationScore(legs, minSp) }))
    .filter((row) => row.totalSp >= minSp)
    .sort((left, right) => (
      right.rank - left.rank
      || right.averageEvidence - left.averageEvidence
      || left.totalSp - right.totalSp
    ));
  return eligible[0] || null;
};

const frozenEdition = ({ businessDate, type, selected, generatedAt }) => {
  const count = type === "2x1" ? 2 : 3;
  const minSp = type === "2x1" ? TWO_LEG_MIN_SP : THREE_LEG_MIN_SP;
  if (!selected) {
    return {
      type,
      status: "insufficient-qualified-pool",
      minCombinedSp: minSp,
      requiredLegs: count,
      publishedAt: null,
      comboId: null,
      combinedSp: null,
      averageEvidence: null,
      legs: [],
      settlement: { status: "UNSETTLED", settledAt: null },
    };
  }
  const legs = selected.legs.map((leg) => ({ ...leg, resultStatus: "PENDING", finalScore: null }));
  const identity = {
    version: VERSION,
    businessDate,
    type,
    legs: legs.map((leg) => ({
      sourceMatchId: leg.sourceMatchId,
      eventVersion: leg.eventVersion,
      pool: leg.pool,
      handicapLine: leg.handicapLine,
      tipCode: leg.tipCode,
      sp: leg.sp,
    })),
  };
  return {
    type,
    status: "published",
    minCombinedSp: minSp,
    requiredLegs: count,
    publishedAt: generatedAt,
    comboId: `combo:${sha256(JSON.stringify(identity))}`,
    combinedSp: round(selected.totalSp, 3),
    averageEvidence: round(selected.averageEvidence, 1),
    legs,
    settlement: { status: "UNSETTLED", settledAt: null },
  };
};

const canonicalEventKey = (match) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const eventVersion = eventVersionOf(match);
  return sourceMatchId && eventVersion ? `${sourceMatchId}|${eventVersion}` : "";
};

const settleLeg = (leg, matches) => {
  const expectedKey = `${leg.sourceMatchId}|${leg.eventVersion}`;
  const match = matches.find((row) => canonicalEventKey(row) === expectedKey);
  if (!match) return { ...leg, resultStatus: "PENDING", finalScore: null };
  if (match.resultDisposition === "VOID") return { ...leg, resultStatus: "VOID", finalScore: null };
  if (match.status !== "FINISHED" || !Number.isInteger(match.scoreHome) || !Number.isInteger(match.scoreAway)) {
    return { ...leg, resultStatus: "PENDING", finalScore: null };
  }
  let actual;
  if (leg.pool === "HHAD") {
    const adjusted = match.scoreHome + Number(leg.handicapLine || 0);
    actual = adjusted > match.scoreAway ? "1" : adjusted < match.scoreAway ? "2" : "X";
  } else {
    actual = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
  }
  return {
    ...leg,
    resultStatus: actual === leg.tipCode ? "WON" : "LOST",
    finalScore: `${match.scoreHome}-${match.scoreAway}`,
  };
};

const settleEdition = (edition, matches, nowIso) => {
  if (!edition || edition.status !== "published") return edition;
  const legs = edition.legs.map((leg) => settleLeg(leg, matches));
  const statuses = legs.map((leg) => leg.resultStatus);
  const status = statuses.some((value) => value === "PENDING")
    ? "UNSETTLED"
    : statuses.some((value) => value === "LOST")
      ? "LOST"
      : statuses.some((value) => value === "VOID")
        ? "VOID"
        : "WON";
  const prior = edition.settlement || {};
  return {
    ...edition,
    legs,
    settlement: {
      status,
      settledAt: status === "UNSETTLED" ? null : (prior.settledAt || nowIso),
    },
  };
};

const summarize = (rows) => {
  const editions = rows.flatMap((row) => [row.twoLeg, row.threeLeg]).filter((row) => row?.status === "published");
  const byType = (type) => {
    const subset = editions.filter((row) => row.type === type);
    const settled = subset.filter((row) => ["WON", "LOST"].includes(row?.settlement?.status));
    const won = settled.filter((row) => row.settlement.status === "WON").length;
    const lost = settled.filter((row) => row.settlement.status === "LOST").length;
    const voided = subset.filter((row) => row?.settlement?.status === "VOID").length;
    return {
      published: subset.length,
      settled: settled.length,
      won,
      lost,
      voided,
      hitRate: settled.length ? round((won / settled.length) * 100, 1) : null,
      averageCombinedSp: subset.length
        ? round(subset.reduce((sum, row) => sum + Number(row.combinedSp || 0), 0) / subset.length, 2)
        : null,
    };
  };
  return { twoLeg: byType("2x1"), threeLeg: byType("3x1") };
};

const buildDailyFeaturedCombos = ({
  nowMs = Date.now(),
  currentMatches = [],
  historyMatches = [],
  ledger = { version: VERSION, rows: [] },
} = {}) => {
  const nowIso = new Date(nowMs).toISOString();
  const businessDate = shanghaiDate(nowMs);
  const allMatches = [...currentMatches, ...historyMatches];
  const rows = Array.isArray(ledger?.rows) ? ledger.rows.map((row) => ({ ...row })) : [];

  for (let index = 0; index < rows.length; index += 1) {
    rows[index] = {
      ...rows[index],
      twoLeg: settleEdition(rows[index].twoLeg, allMatches, nowIso),
      threeLeg: settleEdition(rows[index].threeLeg, allMatches, nowIso),
    };
  }

  let today = rows.find((row) => row.businessDate === businessDate);
  const todaysMatches = currentMatches.filter((match) => matchBusinessDate(match) === businessDate);
  const candidates = todaysMatches.map((match) => candidateFromMatch(match, nowMs)).filter(Boolean)
    .sort((a, b) => b.evidenceScore - a.evidenceScore || Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
  const earliestKickoff = candidates.length ? Math.min(...candidates.map((row) => Date.parse(row.kickoffTime))) : Infinity;
  const decisionAt = Math.min(businessFreezeAt(businessDate), earliestKickoff - 60 * 60 * 1000);
  const hardCutoffAt = businessHardCutoffAt(businessDate);
  const decisionReached = Number.isFinite(decisionAt) && nowMs >= decisionAt;

  if (!today) {
    today = {
      version: VERSION,
      businessDate,
      evaluatedAt: nowIso,
      decisionAt: Number.isFinite(decisionAt) ? new Date(decisionAt).toISOString() : null,
      hardCutoffAt: new Date(hardCutoffAt).toISOString(),
      candidateCount: candidates.length,
      state: decisionReached ? "decision-reached" : "waiting-decision-window",
      twoLeg: null,
      threeLeg: null,
    };
    rows.push(today);
  }

  today.evaluatedAt = nowIso;
  today.candidateCount = candidates.length;
  today.decisionAt = Number.isFinite(decisionAt) ? new Date(decisionAt).toISOString() : today.decisionAt;
  today.hardCutoffAt = new Date(hardCutoffAt).toISOString();

  if (decisionReached) {
    if (!today.twoLeg) {
      today.twoLeg = frozenEdition({
        businessDate,
        type: "2x1",
        selected: selectFeaturedCombination(candidates, 2, TWO_LEG_MIN_SP),
        generatedAt: nowIso,
      });
    }
    if (!today.threeLeg) {
      today.threeLeg = frozenEdition({
        businessDate,
        type: "3x1",
        selected: selectFeaturedCombination(candidates, 3, THREE_LEG_MIN_SP),
        generatedAt: nowIso,
      });
    }
    today.state = [today.twoLeg, today.threeLeg].some((row) => row?.status === "published")
      ? "published"
      : "no-qualified-combo";
  } else {
    today.state = "waiting-decision-window";
  }

  // A no-pick decision is immutable after the configured hard cutoff. Before
  // then it may be re-evaluated if new official fixtures/markets arrive.
  if (nowMs < hardCutoffAt) {
    for (const key of ["twoLeg", "threeLeg"]) {
      if (today[key]?.status === "insufficient-qualified-pool") today[key] = null;
    }
  }

  rows.sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));
  return {
    ledger: { version: VERSION, updatedAt: nowIso, rows },
    publicPayload: {
      version: VERSION,
      generatedAt: nowIso,
      policy: {
        twoLegMinCombinedSp: TWO_LEG_MIN_SP,
        threeLegMinCombinedSp: THREE_LEG_MIN_SP,
        minEvidenceScore: MIN_EVIDENCE_SCORE,
        formalOfficialOnly: true,
        forcedPublication: false,
      },
      today,
      stats: summarize(rows),
      recent: rows.slice(-30).reverse(),
    },
  };
};

const runDailyFeaturedCombos = ({
  nowMs = Date.now(),
  storeDir = DEFAULT_STORE_DIR,
  publicDir = DEFAULT_PUBLIC_DIR,
} = {}) => {
  const currentPath = path.join(publicDir, "matches-current.json");
  const historyPath = path.join(publicDir, "matches-history.json");
  const ledgerPath = path.join(storeDir, "daily-featured-combos-ledger.json");
  const publicPath = path.join(publicDir, "daily-featured-combos.json");
  const statusPath = path.join(storeDir, "daily-featured-combos-status.json");
  const currentMatches = readJson(currentPath, []);
  const historyMatches = readJson(historyPath, []);
  const ledger = readJson(ledgerPath, { version: VERSION, rows: [] });
  if (!Array.isArray(currentMatches) || !Array.isArray(historyMatches)) {
    throw new Error("daily featured combos require readable current/history match arrays");
  }
  const result = buildDailyFeaturedCombos({ nowMs, currentMatches, historyMatches, ledger });
  atomicWriteJson(ledgerPath, result.ledger);
  atomicWriteJson(publicPath, result.publicPayload);
  atomicWriteJson(statusPath, {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    businessDate: result.publicPayload.today.businessDate,
    state: result.publicPayload.today.state,
    candidateCount: result.publicPayload.today.candidateCount,
    twoLegStatus: result.publicPayload.today.twoLeg?.status || "waiting",
    threeLegStatus: result.publicPayload.today.threeLeg?.status || "waiting",
  });
  return result.publicPayload;
};

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(runDailyFeaturedCombos(), null, 2)}\n`);
  } catch (error) {
    const statusPath = path.join(DEFAULT_STORE_DIR, "daily-featured-combos-status.json");
    atomicWriteJson(statusPath, {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message || String(error),
      errorCode: error.code || null,
    });
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  THREE_LEG_MIN_SP,
  TWO_LEG_MIN_SP,
  buildDailyFeaturedCombos,
  candidateFromMatch,
  selectFeaturedCombination,
  settleEdition,
  summarize,
  runDailyFeaturedCombos,
};
