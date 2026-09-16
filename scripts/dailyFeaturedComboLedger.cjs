"use strict";

const crypto = require("node:crypto");
const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
const { readPostgresPublicationIdentity } = require("../server/postgresProjectionStore.cjs");
const { isOfficialRecommendationEligible, parseHandicapLine } = require("../src/services/officialRecommendationEligibility.cjs");
const { evaluateHistoricalRecommendationGuard } = require("../src/services/recommendationHistoricalGuard.cjs");
const { isBeforeMatchSaleCutoff, eventVersionOf, canonicalSourceMatchId, isOfficialSportteryFinal, isOfficialSportteryVoid } = require("../src/services/matchLifecycle.cjs");

const MINIMUMS = Object.freeze({ 2: 2.5, 3: 5 });
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
    homeTeamId: match.homeTeamId || null, awayTeamId: match.awayTeamId || null,
    leagueId: match.leagueId || null,
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
    for (let i = start; i < candidates.length; i += 1) {
      const next = candidates[i];
      if (!next.sourceMatchId || picked.some((leg) => leg.sourceMatchId === next.sourceMatchId)) continue;
      // Avoid shared teams and concentration in one competition.
      const teams = [next.homeTeamId, next.awayTeamId].filter(Boolean);
      if (picked.some((leg) => teams.some((team) => [leg.homeTeamId, leg.awayTeamId].includes(team)))) continue;
      if (next.leagueId && picked.filter((leg) => leg.leagueId === next.leagueId).length >= 2) continue;
      walk(i + 1, [...picked, next]);
    }
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
  if (["WON", "LOST", "VOID"].includes(entry.settlement?.status)) return entry;
  const results = entry.legs.map((leg) => {
    const match = history.find((row) => matchesLeg(row, leg) && (isOfficialSportteryFinal(row) || isOfficialSportteryVoid(row)));
    if (match && isOfficialSportteryVoid(match)) return { sourceMatchId: leg.sourceMatchId, result: "VOID", finalScore: null };
    const actual = match ? outcomeCode(match, leg) : null;
    return { sourceMatchId: leg.sourceMatchId, result: actual ? (actual === leg.tipCode ? "WON" : "LOST") : "PENDING", finalScore: match && Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway) ? `${match.scoreHome}-${match.scoreAway}` : null };
  });
  const status = results.some((leg) => leg.result === "VOID") ? "VOID"
    : results.some((leg) => leg.result === "PENDING") ? "PENDING"
      : results.every((leg) => leg.result === "WON") ? "WON" : "LOST";
  return { ...entry, settlement: { status, results, settledAt: status === "PENDING" ? null : settledAt } };
};
const summarize = (entries, size) => {
  const rows = entries.filter((entry) => entry.size === size);
  const settled = rows.filter((entry) => ["WON", "LOST"].includes(entry.settlement?.status));
  const won = settled.filter((entry) => entry.settlement.status === "WON").length;
  return { published: rows.length, settled: settled.length, won, lost: settled.length - won, void: rows.filter((row) => row.settlement?.status === "VOID").length, hitRate: settled.length ? Number((won / settled.length).toFixed(4)) : null };
};

function buildLedger({ now = Date.now(), current, history, entries: priorEntries, publishable = false, publication }) {
  if (![current, history, priorEntries].every(Array.isArray)) throw new Error("Invalid combo inputs; refusing to replace ledger");
  const clock = shanghaiParts(now);
  let entries = [...priorEntries];
  const candidates = (publishable ? current : [])
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
      entries.push({ version: "daily-featured-combo-v2", id: `combo:${id}`, businessDate: clock.date, frozenAt, publication, ...selected, settlement: { status: "PENDING", settledAt: null } });
    }
  }

  const settledAt = new Date(now).toISOString();
  entries = entries.map((entry) => settleEntry(entry, Array.isArray(history) ? history : [], settledAt));
  const publicPayload = {
    version: "daily-featured-combo-public-v2", updatedAt: settledAt, businessDate: clock.date,
    source: "postgres", publishable, publication,
    previews: freezeReached ? [] : [choose(candidates, 2), choose(candidates, 3)].filter(Boolean),
    today: entries.filter((entry) => entry.businessDate === clock.date),
    statistics: { two: summarize(entries, 2), three: summarize(entries, 3) },
    policy: { freeze: "weekday-21:00/weekend-22:00 Asia/Shanghai", twoMinimumSp: 2.5, threeMinimumSp: 5, forcedOutput: false, immutableDirections: true, voidPolicy: "any-official-void-excludes-combo-from-hit-rate" },
  };
  return { entries, publicPayload };
}

function canPublish(health, meta, publication, now) {
  const age = now - Date.parse(meta?.updatedAt || "");
  return health?.status?.modelRiskStable === true && health?.status?.recommendationReliable === true
    && health?.status?.dataFresh === true && health?.status?.serviceOk === true
    && age >= 0 && age <= 15 * 60000
    && Boolean(publication?.manifestHash && publication?.generationId)
    && meta?.publication?.manifestHash === publication.manifestHash
    && meta?.publication?.generationId === publication.generationId;
}

async function persistLedger(client, options) {
  const previous = await client.query("SELECT payload, settlement FROM football.daily_featured_combos ORDER BY business_date, size");
  const prior = previous.rows.map((row) => ({ ...row.payload, settlement: row.settlement }));
  const result = buildLedger({ ...options, entries: prior });
  for (const entry of result.entries) {
    const { settlement, ...payload } = entry;
    const old = prior.find((row) => row.id === entry.id);
    if (!old) await client.query(`INSERT INTO football.daily_featured_combos(id,business_date,size,payload,settlement)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [entry.id, entry.businessDate, entry.size, JSON.stringify(payload), JSON.stringify(settlement)]);
    else if (JSON.stringify(old.settlement) !== JSON.stringify(settlement)) {
      await client.query("UPDATE football.daily_featured_combos SET settlement=$2::jsonb WHERE id=$1", [entry.id, JSON.stringify(settlement)]);
    }
  }
  await client.query(`INSERT INTO football.daily_featured_combo_state(id,payload) VALUES(1,$1::jsonb)
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [JSON.stringify(result.publicPayload)]);
  return result.publicPayload;
}

async function run({ now = Date.now() } = {}) {
  const base = `http://127.0.0.1:${Number(process.env.PORT || 8788)}`;
  const read = async (route) => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Combo readiness unavailable: ${response.status}`);
    return response.json();
  };
  const [health, meta] = await Promise.all([read("/api/v1/health"), read("/api/v1/sync-meta")]);
  const pool = createPostgresPool({ max: 1, applicationName: "football-featured-combos" });
  try {
    return await withPostgresTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('daily-featured-combos-v2'))");
      const identity = await readPostgresPublicationIdentity(client);
      if (!identity.available || !identity.publication?.manifestHash) throw new Error("Combo PostgreSQL publication unavailable");
      const rows = await client.query("SELECT dataset,payload FROM football.match_snapshots WHERE dataset IN ('current','history')");
      return persistLedger(client, { now, publication: identity.publication,
        publishable: canPublish(health, meta, identity.publication, now),
        current: rows.rows.filter((row) => row.dataset === "current").map((row) => row.payload),
        history: rows.rows.filter((row) => row.dataset === "history").map((row) => row.payload) });
    });
  } finally { await pool.end(); }
}

if (require.main === module) run().then((payload) => console.log(JSON.stringify(payload))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, buildLedger, canPublish, persistLedger, formalCandidate, choose, settleEntry, summarize, shanghaiParts };
