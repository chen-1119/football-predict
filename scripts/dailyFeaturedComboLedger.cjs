"use strict";

const crypto = require("node:crypto");
const { VERSION, candidatesFor, choose, canPublish } = require("./independentComboSelection.cjs");

const shanghaiParts = (now = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
};
const freezeHour = (weekday) => ["Sat", "Sun"].includes(weekday) ? 22 : 21;

const settleEntry = (entry, history, settledAt) => {
  if (["WON", "LOST", "VOID"].includes(entry.settlement?.status)) return entry;
  // Settlement retains the existing official-result policy, including legacy HHAD.
  const { parseHandicapLine } = require("../src/services/officialRecommendationEligibility.cjs");
  const { eventVersionOf, canonicalSourceMatchId, isOfficialSportteryFinal, isOfficialSportteryVoid } = require("../src/services/matchLifecycle.cjs");
  const results = entry.legs.map((leg) => {
    const match = history.find((row) => canonicalSourceMatchId(row?.sourceMatchId || row?.id) === leg.sourceMatchId
      && eventVersionOf(row) === leg.eventVersion && (isOfficialSportteryFinal(row) || isOfficialSportteryVoid(row)));
    if (match && isOfficialSportteryVoid(match)) return { sourceMatchId: leg.sourceMatchId, result: "VOID", finalScore: null };
    const line = leg.market === "HHAD" ? parseHandicapLine(leg.handicapLine) : 0;
    const scored = match && Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway) && line !== null;
    const actual = scored ? match.scoreHome + line > match.scoreAway ? "1" : match.scoreHome + line < match.scoreAway ? "2" : "X" : null;
    return { sourceMatchId: leg.sourceMatchId, result: actual ? actual === leg.tipCode ? "WON" : "LOST" : "PENDING",
      finalScore: scored ? `${match.scoreHome}-${match.scoreAway}` : null };
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
  return { published: rows.length, settled: settled.length, won, lost: settled.length - won,
    void: rows.filter((row) => row.settlement?.status === "VOID").length,
    hitRate: settled.length ? Number((won / settled.length).toFixed(4)) : null };
};

function buildLedger({ now = Date.now(), current, history, entries: priorEntries, publishable = false, publication }) {
  if (![current, history, priorEntries].every(Array.isArray) || !Number.isFinite(now)) throw new Error("Invalid combo inputs; refusing to replace ledger");
  const clock = shanghaiParts(now);
  const candidates = publishable ? candidatesFor(current, now) : [];
  let entries = [...priorEntries];
  const freezeReached = clock.hour >= freezeHour(clock.weekday);
  const selections = [2, 3].map((size) => choose(candidates, size)).filter(Boolean);
  if (freezeReached) {
    for (const selected of selections) {
      if (entries.some((entry) => entry.businessDate === clock.date && entry.size === selected.size)) continue;
      const frozenAt = new Date(now).toISOString();
      const hash = crypto.createHash("sha256").update(JSON.stringify({ date: clock.date, size: selected.size, frozenAt, policy: VERSION, legs: selected.legs })).digest("hex");
      entries.push({ version: "daily-featured-combo-v3", id: `combo:${hash}`, businessDate: clock.date,
        frozenAt, publication, ...selected, settlement: { status: "PENDING", settledAt: null } });
    }
  }
  const settledAt = new Date(now).toISOString();
  // No-history runs cannot settle anything and need not load the model runtime.
  if (history.length) entries = entries.map((entry) => settleEntry(entry, history, settledAt));
  const today = entries.filter((entry) => entry.businessDate === clock.date);
  const independent = entries.filter((entry) => entry.statisticsTrack === "independent-combo");
  return { entries, publicPayload: {
    version: "daily-featured-combo-public-v2", updatedAt: settledAt, businessDate: clock.date,
    source: "postgres", publishable, publication, selectionPolicy: VERSION, statisticsTrack: "independent-combo",
    candidateCount: candidates.length, previewStatus: publishable ? "evaluated" : "data-unavailable",
    previews: selections.filter((selection) => !today.some((entry) => entry.size === selection.size)), today,
    statistics: { two: summarize(entries, 2), three: summarize(entries, 3) },
    independentStatistics: { two: summarize(independent, 2), three: summarize(independent, 3) },
    policy: { selection: "independent-model-had", requiresFormalRecommendation: false,
      freeze: "weekday-21:00/weekend-22:00 Asia/Shanghai", twoMinimumSp: 2.5, threeMinimumSp: 5,
      forcedOutput: false, immutableDirections: true, probabilityCalibration: "not-asserted",
      voidPolicy: "any-official-void-excludes-combo-from-hit-rate" },
  } };
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

async function run({ now } = {}) {
  const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
  const { readPostgresPublicationIdentity } = require("../server/postgresProjectionStore.cjs");
  const base = `http://127.0.0.1:${Number(process.env.PORT || 8788)}`;
  const read = async (route) => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Combo readiness unavailable: ${response.status}`);
    return response.json();
  };
  const pool = createPostgresPool({ max: 1, applicationName: "football-featured-combos" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [health, meta] = await Promise.all([read("/api/v1/health"), read("/api/v1/sync-meta")]);
      try {
        return await withPostgresTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('daily-featured-combos-v2'))");
          const identity = await readPostgresPublicationIdentity(client);
          if (!identity.available || !identity.publication?.manifestHash) throw new Error("Combo PostgreSQL publication unavailable");
          const rows = await client.query("SELECT dataset,payload FROM football.match_snapshots WHERE dataset IN ('current','history')");
          const evaluatedAt = now ?? Date.now();
          return persistLedger(client, { now: evaluatedAt, publication: identity.publication,
            publishable: canPublish(health, meta, identity.publication, evaluatedAt),
            current: rows.rows.filter((row) => row.dataset === "current").map((row) => row.payload),
            history: rows.rows.filter((row) => row.dataset === "history").map((row) => row.payload) });
        });
      } catch (error) {
        if (error.code !== "40001" || attempt === 2) throw error;
      }
    }
  } finally { await pool.end(); }
}

if (require.main === module) run().then((payload) => console.log(JSON.stringify(payload))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, buildLedger, canPublish, persistLedger, choose, settleEntry, summarize, shanghaiParts };
