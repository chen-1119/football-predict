"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isOfficialRecommendationEligible, parseHandicapLine } = require("../src/services/officialRecommendationEligibility.cjs");
const { evaluateHistoricalRecommendationGuard } = require("../src/services/recommendationHistoricalGuard.cjs");
const { isBeforeMatchSaleCutoff, eventVersionOf, canonicalSourceMatchId } = require("../src/services/matchLifecycle.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const publicDataDir = path.resolve(process.env.PUBLIC_DATA_DIR || path.join(rootDir, "public", "data"));
const ledgerFile = path.resolve(process.env.DAILY_FEATURED_COMBO_LEDGER || path.join(storeDir, "daily-featured-combos.json"));
const publicFile = path.resolve(process.env.DAILY_FEATURED_COMBO_PUBLIC || path.join(publicDataDir, "daily-featured-combos.json"));
const MINIMUMS = Object.freeze({ 2: 2.5, 3: 5 });

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const atomicWrite = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
};
const text = (value) => String(value ?? "").trim();
const iso = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const shanghaiParts = (now = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
};
const freezeHour = (weekday) => ["Sat", "Sun"].includes(weekday) ? 22 : 21;
const businessDate = (match) => {
  const explicit = text(match?.businessDate || match?.matchDate || match?.kickoffDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const kickoff = Date.parse(match?.kickoffTime || "");
  return Number.isFinite(kickoff) ? new Date(kickoff + 8 * 3600000).toISOString().slice(0, 10) : "";
};
const officialPool = (match, prediction) => {
  const pool = prediction?.oddsPoolCode === "HHAD" ? "HHAD" : "HAD";
  const odds = pool === "HHAD" ? match?.handicapOdds : match?.odds;
  const source = pool === "HHAD" ? match?.handicapOddsSource : match?.oddsSource;
  const line = pool === "HHAD" ? match?.handicapLine : 0;
  if (!odds || !String(source || "").toLowerCase().startsWith(`sporttery:${pool.toLowerCase()}`)) return null;
  const value = prediction.tipCode === "1" ? Number(odds.odds1) : prediction.tipCode === "X" ? Number(odds.oddsX) : Number(odds.odds2);
  return Number.isFinite(value) && value > 1 ? { pool, value, line } : null;
};
const formalCandidate = (match, now) => {
  if (match?.status !== "SCHEDULED" || !isBeforeMatchSaleCutoff(match, { now })) return null;
  const prediction = (match.predictions || []).find((row) => row?.marketType === "BEST" && row?.recommendationAction === "recommend");
  if (!prediction || !["1", "X", "2"].includes(prediction.tipCode)) return null;
  const official = officialPool(match, prediction);
  if (!official) return null;
  if (!isOfficialRecommendationEligible(prediction, official.value, official.line)) return null;
  const evidence = Number(prediction?.multiFactorEvidence?.evidenceScore ?? prediction?.trustScore);
  if (!Number.isFinite(evidence)) return null;
  const modelProbability = Number(prediction?.multiFactorEvidence?.modelProbability);
  const modelGap = Number(prediction?.multiFactorEvidence?.modelGap);
  const probabilityEdge = Number(prediction?.multiFactorEvidence?.probabilityEdge);
  const dataQuality = Number(prediction?.multiFactorEvidence?.dataQuality);
  const diagnostics = prediction?.multiFactorEvidence?.diagnostics || {};
  const historical = evaluateHistoricalRecommendationGuard({
    market: official.pool, code: prediction.tipCode, odds: official.value,
    modelProbability, modelGap, probabilityEdge, dataQuality,
    marketLeaderAligned: diagnostics.marketLeaderAligned === true,
    externalMarketAligned: diagnostics.externalMarketAligned === true,
    trendContradicts: diagnostics.trendContradicts === true,
  });
  if (historical.blockers.length) return null;
  const requiredEvidence = official.pool === "HHAD" || official.value >= 2.06 ? 74 : official.value >= 1.71 ? 70 : 66;
  if (evidence < requiredEvidence || official.value > 2.6) return null;
  return {
    matchId: text(match.id), sourceMatchId: canonicalSourceMatchId(match.sourceMatchId || match.id),
    eventVersion: eventVersionOf(match), kickoffTime: iso(match.kickoffTime),
    homeTeamName: match.homeTeamName || null, awayTeamName: match.awayTeamName || null,
    market: official.pool, tipCode: prediction.tipCode, handicapLine: official.pool === "HHAD" ? official.line : 0,
    odds: official.value, evidenceScore: evidence,
  };
};
const rank = (legs, floor) => {
  const totalOdds = legs.reduce((p, leg) => p * leg.odds, 1);
  const avg = legs.reduce((s, leg) => s + leg.evidenceScore, 0) / legs.length;
  const risk = legs.filter((leg) => leg.market === "HHAD").length * 4 + legs.filter((leg) => leg.odds >= 2.06).length * 3;
  return { totalOdds, avg, score: Math.log(Math.max(totalOdds, floor) / floor) * 22 + risk - avg / 10 };
};
const choose = (candidates, size) => {
  const floor = MINIMUMS[size];
  let best = null; let bestRank = null;
  const walk = (start, picked) => {
    if (picked.length === size) {
      const next = rank(picked, floor);
      if (next.totalOdds + 1e-9 < floor) return;
      if (!bestRank || next.score < bestRank.score) { best = [...picked]; bestRank = next; }
      return;
    }
    for (let i = start; i < candidates.length; i += 1) walk(i + 1, [...picked, candidates[i]]);
  };
  walk(0, []);
  return best ? { size, minimumTotalOdds: floor, totalOdds: Number(bestRank.totalOdds.toFixed(2)), averageEvidenceScore: Number(bestRank.avg.toFixed(1)), legs: best } : null;
};
const outcomeCode = (match, leg) => {
  if (!Number.isInteger(match?.scoreHome) || !Number.isInteger(match?.scoreAway)) return null;
  let home = match.scoreHome;
  if (leg.market === "HHAD") {
    const line = parseHandicapLine(leg.handicapLine);
    if (line === null) return null;
    home += line;
  }
  return home > match.scoreAway ? "1" : home < match.scoreAway ? "2" : "X";
};
const matchesLeg = (match, leg) => canonicalSourceMatchId(match?.sourceMatchId || match?.id) === leg.sourceMatchId && eventVersionOf(match) === leg.eventVersion;
const settleEntry = (entry, history, settledAt) => {
  if (entry.settlement?.status === "WON" || entry.settlement?.status === "LOST") return entry;
  const legs = entry.legs.map((leg) => {
    const match = history.find((row) => row?.status === "FINISHED" && matchesLeg(row, leg));
    const actual = match ? outcomeCode(match, leg) : null;
    return { ...leg, result: actual ? (actual === leg.tipCode ? "WON" : "LOST") : "PENDING", finalScore: match && Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway) ? `${match.scoreHome}-${match.scoreAway}` : null };
  });
  const pending = legs.some((leg) => leg.result === "PENDING");
  const status = pending ? "PENDING" : legs.every((leg) => leg.result === "WON") ? "WON" : "LOST";
  return { ...entry, legs, settlement: { status, settledAt: status === "PENDING" ? null : settledAt } };
};
const summarize = (entries, size) => {
  const rows = entries.filter((entry) => entry.size === size);
  const settled = rows.filter((entry) => ["WON", "LOST"].includes(entry.settlement?.status));
  const won = settled.filter((entry) => entry.settlement.status === "WON").length;
  return { published: rows.length, settled: settled.length, won, lost: settled.length - won, hitRate: settled.length ? Number((won / settled.length).toFixed(4)) : null };
};

function run({ now = Date.now() } = {}) {
  const clock = shanghaiParts(now);
  const current = readJson(path.join(publicDataDir, "matches-current.json"), []);
  const history = readJson(path.join(publicDataDir, "matches-history.json"), []);
  const prior = readJson(ledgerFile, { version: "daily-featured-combo-ledger-v1", entries: [] });
  let entries = Array.isArray(prior.entries) ? prior.entries : [];
  const candidates = (Array.isArray(current) ? current : [])
    .filter((match) => businessDate(match) === clock.date)
    .map((match) => formalCandidate(match, now)).filter(Boolean)
    .sort((a, b) => b.evidenceScore - a.evidenceScore || Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime)).slice(0, 18);

  const freezeReached = clock.hour > freezeHour(clock.weekday) || (clock.hour === freezeHour(clock.weekday) && clock.minute >= 0);
  if (freezeReached) {
    for (const size of [2, 3]) {
      if (entries.some((entry) => entry.businessDate === clock.date && entry.size === size)) continue;
      const selected = choose(candidates, size);
      if (!selected) continue;
      const frozenAt = new Date(now).toISOString();
      const id = crypto.createHash("sha256").update(JSON.stringify({ businessDate: clock.date, size, frozenAt, legs: selected.legs.map((leg) => [leg.sourceMatchId, leg.eventVersion, leg.market, leg.tipCode, leg.odds]) })).digest("hex");
      entries.push({ version: "daily-featured-combo-v1", id: `combo:${id}`, businessDate: clock.date, frozenAt, ...selected, settlement: { status: "PENDING", settledAt: null } });
    }
  }

  const settledAt = new Date(now).toISOString();
  entries = entries.map((entry) => settleEntry(entry, Array.isArray(history) ? history : [], settledAt));
  const payload = { version: "daily-featured-combo-ledger-v1", updatedAt: settledAt, entries };
  atomicWrite(ledgerFile, payload);
  const publicPayload = {
    version: "daily-featured-combo-public-v1", updatedAt: settledAt,
    today: entries.filter((entry) => entry.businessDate === clock.date),
    statistics: { two: summarize(entries, 2), three: summarize(entries, 3) },
    policy: { freeze: "weekday-21:00/weekend-22:00 Asia/Shanghai", twoMinimumSp: 2.5, threeMinimumSp: 5, forcedOutput: false, immutableDirections: true },
  };
  atomicWrite(publicFile, publicPayload);
  return publicPayload;
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { run, formalCandidate, choose, settleEntry, summarize, shanghaiParts };
