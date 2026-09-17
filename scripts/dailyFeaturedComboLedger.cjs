"use strict";

const crypto = require("node:crypto");
const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
const { readPostgresPublicationIdentity } = require("../server/postgresProjectionStore.cjs");
const { parseHandicapLine } = require("../src/services/officialRecommendationEligibility.cjs");
const {
  eventVersionOf,
  canonicalSourceMatchId,
  isOfficialSportteryFinal,
  isOfficialSportteryVoid,
} = require("../src/services/matchLifecycle.cjs");
const {
  VERSION,
  candidatesFor,
  choose,
  canPublish,
  businessDateFor,
  timeMs,
} = require("./independentComboSelection.cjs");

const shanghaiParts = (now = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
};

const matchesLeg = (match, leg) => (
  canonicalSourceMatchId(match?.sourceMatchId || match?.id) === leg.sourceMatchId
  && eventVersionOf(match) === leg.eventVersion
);

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

const settleEntry = (entry, history, settledAt) => {
  if (["WON", "LOST", "VOID"].includes(entry?.settlement?.status)) return entry;
  const results = (entry.legs || []).map((leg) => {
    const match = history.find((row) => matchesLeg(row, leg) && (isOfficialSportteryFinal(row) || isOfficialSportteryVoid(row)));
    if (match && isOfficialSportteryVoid(match)) {
      return { sourceMatchId: leg.sourceMatchId, result: "VOID", finalScore: null };
    }
    const actual = match ? outcomeCode(match, leg) : null;
    return {
      sourceMatchId: leg.sourceMatchId,
      result: actual ? (actual === leg.tipCode ? "WON" : "LOST") : "PENDING",
      finalScore: match && Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway)
        ? `${match.scoreHome}-${match.scoreAway}`
        : null,
    };
  });
  const status = results.some((leg) => leg.result === "VOID") ? "VOID"
    : results.some((leg) => leg.result === "PENDING") ? "PENDING"
      : results.every((leg) => leg.result === "WON") ? "WON"
        : "LOST";
  return {
    ...entry,
    settlement: {
      status,
      results,
      settledAt: status === "PENDING" ? null : settledAt,
    },
  };
};

const summarize = (entries, size, track = null) => {
  const rows = entries.filter((entry) => entry.size === size && (!track || entry.statisticsTrack === track));
  const settled = rows.filter((entry) => ["WON", "LOST"].includes(entry?.settlement?.status));
  const won = settled.filter((entry) => entry.settlement.status === "WON").length;
  return {
    published: rows.length,
    settled: settled.length,
    won,
    lost: settled.length - won,
    void: rows.filter((row) => row?.settlement?.status === "VOID").length,
    hitRate: settled.length ? Number((won / settled.length).toFixed(4)) : null,
  };
};

const previewStillAuditable = (preview, now) => {
  if (!preview || !Array.isArray(preview.legs) || !preview.legs.length) return false;
  const freezeAt = timeMs(preview.freezeAt);
  const updatedAt = timeMs(preview.generatedAt || preview.evaluatedAt || preview.legs[0]?.evaluatedAt);
  if (!Number.isFinite(freezeAt) || !Number.isFinite(updatedAt) || updatedAt > freezeAt || updatedAt > now) return false;
  return preview.legs.every((leg) => {
    const quoteAt = timeMs(leg.quoteObservedAt);
    const cutoff = timeMs(leg.cutoffTime);
    const kickoff = timeMs(leg.kickoffTime);
    return Number.isFinite(quoteAt)
      && Number.isFinite(cutoff)
      && Number.isFinite(kickoff)
      && quoteAt < cutoff
      && updatedAt < cutoff
      && updatedAt < kickoff;
  });
};

const buildFrozenEntry = ({ selection, clock, now, publication }) => {
  const frozenAt = new Date(now).toISOString();
  const id = crypto.createHash("sha256").update(JSON.stringify({
    businessDate: clock.date,
    size: selection.size,
    frozenAt,
    selectionPolicy: selection.selectionPolicy,
    legs: selection.legs.map((leg) => [
      leg.sourceMatchId,
      leg.eventVersion,
      leg.tipCode,
      leg.odds,
      leg.quoteHash,
      leg.modelGeneratedAt,
    ]),
  })).digest("hex");
  return {
    version: "daily-featured-combo-v3",
    id: `combo:${id}`,
    businessDate: clock.date,
    frozenAt,
    publication,
    ...selection,
    settlement: { status: "PENDING", settledAt: null },
  };
};

function buildLedger({
  now = Date.now(),
  current,
  history,
  entries: priorEntries,
  priorState = null,
  publishable = false,
  publication,
}) {
  if (![current, history, priorEntries].every(Array.isArray) || !Number.isFinite(now)) {
    throw new Error("Invalid combo inputs; refusing to replace ledger");
  }
  const clock = shanghaiParts(now);
  let entries = [...priorEntries];
  const currentMatches = publishable
    ? current.filter((match) => businessDateFor(match) === clock.date)
    : [];
  const candidates = candidatesFor(currentMatches, now);
  const currentSelections = Object.fromEntries([2, 3].map((size) => [size, choose(candidates, size)]));
  const priorPreviewBySize = new Map(
    priorState?.businessDate === clock.date && Array.isArray(priorState?.previews)
      ? priorState.previews.map((row) => [row.size, row])
      : [],
  );

  for (const size of [2, 3]) {
    if (entries.some((entry) => entry.businessDate === clock.date && entry.size === size)) continue;
    const liveSelection = currentSelections[size];
    const previousPreview = priorPreviewBySize.get(size) || null;
    const candidateForFreeze = liveSelection
      || (previewStillAuditable(previousPreview, now) ? previousPreview : null);
    if (!candidateForFreeze) continue;
    const freezeAt = timeMs(candidateForFreeze.freezeAt);
    if (!Number.isFinite(freezeAt) || now < freezeAt) continue;
    entries.push(buildFrozenEntry({ selection: candidateForFreeze, clock, now, publication }));
  }

  const settledAt = new Date(now).toISOString();
  entries = entries.map((entry) => settleEntry(entry, history, settledAt));
  const today = entries.filter((entry) => entry.businessDate === clock.date);
  const previews = [2, 3]
    .filter((size) => !today.some((entry) => entry.size === size))
    .map((size) => currentSelections[size])
    .filter(Boolean)
    .map((selection) => ({
      ...selection,
      generatedAt: settledAt,
    }));

  return {
    entries,
    publicPayload: {
      version: "daily-featured-combo-public-v3",
      updatedAt: settledAt,
      businessDate: clock.date,
      source: "postgres",
      publishable,
      publication,
      selectionPolicy: VERSION,
      statisticsTrack: "independent-combo-v2",
      candidateCount: candidates.length,
      previewStatus: publishable ? "evaluated" : "data-unavailable",
      previews,
      today,
      statistics: {
        two: summarize(entries, 2),
        three: summarize(entries, 3),
      },
      independentStatistics: {
        two: summarize(entries, 2, "independent-combo-v2"),
        three: summarize(entries, 3, "independent-combo-v2"),
      },
      policy: {
        selection: "robust-model-market-had-ensemble",
        requiresFormalRecommendation: false,
        twoMinimumSp: 2.5,
        threeMinimumSp: 5,
        scheduledFreeze: "weekday-21:00/weekend-22:00 Asia/Shanghai",
        earlyFreeze: "5 minutes before earliest selected leg cutoff when earlier",
        forcedOutput: false,
        immutableDirections: true,
        calibratedParlayProbability: false,
        voidPolicy: "any-official-void-excludes-combo-from-hit-rate",
      },
    },
  };
}

async function persistLedger(client, options) {
  const [previous, previousState] = await Promise.all([
    client.query("SELECT payload, settlement FROM football.daily_featured_combos ORDER BY business_date, size"),
    client.query("SELECT payload FROM football.daily_featured_combo_state WHERE id=1"),
  ]);
  const prior = previous.rows.map((row) => ({ ...row.payload, settlement: row.settlement }));
  const result = buildLedger({
    ...options,
    entries: prior,
    priorState: previousState.rows[0]?.payload || null,
  });

  for (const entry of result.entries) {
    const { settlement, ...payload } = entry;
    const old = prior.find((row) => row.id === entry.id);
    if (!old) {
      await client.query(
        `INSERT INTO football.daily_featured_combos(id,business_date,size,payload,settlement)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [entry.id, entry.businessDate, entry.size, JSON.stringify(payload), JSON.stringify(settlement)],
      );
    } else if (JSON.stringify(old.settlement) !== JSON.stringify(settlement)) {
      await client.query(
        "UPDATE football.daily_featured_combos SET settlement=$2::jsonb WHERE id=$1",
        [entry.id, JSON.stringify(settlement)],
      );
    }
  }

  await client.query(
    `INSERT INTO football.daily_featured_combo_state(id,payload) VALUES(1,$1::jsonb)
     ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`,
    [JSON.stringify(result.publicPayload)],
  );
  return result.publicPayload;
}

async function run({ now = Date.now() } = {}) {
  const base = `http://127.0.0.1:${Number(process.env.PORT || 8788)}`;
  const read = async (route) => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Combo readiness unavailable: ${response.status}`);
    return response.json();
  };
  const pool = createPostgresPool({ max: 1, applicationName: "football-featured-combos" });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [health, meta] = await Promise.all([
        read("/api/v1/health"),
        read("/api/v1/sync-meta"),
      ]);
      try {
        return await withPostgresTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('daily-featured-combos-v3'))");
          const identity = await readPostgresPublicationIdentity(client);
          if (!identity.available || !identity.publication?.manifestHash) {
            throw new Error("Combo PostgreSQL publication unavailable");
          }
          const rows = await client.query(
            "SELECT dataset,payload FROM football.match_snapshots WHERE dataset IN ('current','history')",
          );
          return persistLedger(client, {
            now,
            publication: identity.publication,
            publishable: canPublish(health, meta, identity.publication, now),
            current: rows.rows.filter((row) => row.dataset === "current").map((row) => row.payload),
            history: rows.rows.filter((row) => row.dataset === "history").map((row) => row.payload),
          });
        });
      } catch (error) {
        if (error?.code !== "40001" || attempt === 2) throw error;
      }
    }
    throw new Error("Combo transaction retries exhausted");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run()
    .then((payload) => console.log(JSON.stringify(payload)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  run,
  buildLedger,
  persistLedger,
  settleEntry,
  summarize,
  shanghaiParts,
  previewStillAuditable,
};
