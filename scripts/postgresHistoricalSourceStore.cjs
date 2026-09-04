"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  DATASET_CONFIGS,
  iterateHistoricalEvents,
  normalizeEntity,
  stableStringify,
} = require("./historicalEventStore.cjs");
const { withPostgresTransaction } = require("../server/postgresStore.cjs");

const SOURCE_PROFILES = Object.freeze({
  xgabora: Object.freeze({
    sourceKey: "xgabora-club-matches",
    displayName: "xgabora Club Football Match Data",
    sourceKind: "aggregated",
    sourceUrl: DATASET_CONFIGS.xgabora.sourceUrl,
    licenseCode: DATASET_CONFIGS.xgabora.license,
    authorityRank: 55,
    refreshIntervalMinutes: 7 * 24 * 60,
    scope: "club",
  }),
  martj42: Object.freeze({
    sourceKey: "martj42-international-results",
    displayName: "martj42 International Results",
    sourceKind: "community",
    sourceUrl: DATASET_CONFIGS.martj42.sourceUrl,
    licenseCode: DATASET_CONFIGS.martj42.license,
    authorityRank: 65,
    refreshIntervalMinutes: 24 * 60,
    scope: "international",
  }),
  "football-data": Object.freeze({
    sourceKey: "football-data-co-uk",
    displayName: "Football-Data.co.uk Results CSV",
    sourceKind: "aggregated",
    sourceUrl: DATASET_CONFIGS["football-data"].sourceUrl,
    licenseCode: DATASET_CONFIGS["football-data"].license,
    authorityRank: 70,
    refreshIntervalMinutes: 3 * 24 * 60,
    scope: "club",
  }),
});

const DATASET_KEYS = Object.freeze({
  club: "xgabora",
  international: "martj42",
  footballdata: "football-data",
  "xgabora/Club-Football-Match-Data-2000-2025:Matches.csv": "xgabora",
  "martj42/international_results:results.csv": "martj42",
  "football-data.co.uk:results-csv": "football-data",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const idFor = (...parts) => sha256(parts.map((part) => String(part ?? "")).join("\0"));
const canonicalIso = (value = new Date().toISOString()) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("timestamp must be valid");
  return parsed.toISOString();
};

function resolveDatasetKey(dataset) {
  if (typeof dataset === "string") {
    const requested = dataset.trim();
    if (SOURCE_PROFILES[requested]) return requested;
    if (DATASET_KEYS[requested]) return DATASET_KEYS[requested];
  }
  if (dataset && typeof dataset === "object") {
    const adapter = String(dataset.adapter || "").trim();
    if (SOURCE_PROFILES[adapter]) return adapter;
  }
  throw new TypeError(`unsupported PostgreSQL historical dataset: ${String(dataset || "(empty)")}`);
}

function nextDayAvailability(date) {
  const millis = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(millis)) throw new TypeError(`invalid historical date: ${date}`);
  return new Date(millis + 24 * 60 * 60 * 1000).toISOString();
}

function projectHistoricalEvent(event, { dataset, runId, observedAt } = {}) {
  const datasetKey = resolveDatasetKey(dataset || event?.sourceDataset);
  const profile = SOURCE_PROFILES[datasetKey];
  const date = String(event?.date || "").trim();
  const homeNormalized = normalizeEntity(event?.homeTeamNormalized || event?.homeTeamRaw);
  const awayNormalized = normalizeEntity(event?.awayTeamNormalized || event?.awayTeamRaw);
  const competitionNormalized = normalizeEntity(event?.competition || "unknown") || "unknown";
  if (!date || !homeNormalized || !awayNormalized || homeNormalized === awayNormalized) {
    throw new TypeError("historical event identity is incomplete");
  }

  const homeTeamId = idFor("team", profile.scope, homeNormalized);
  const awayTeamId = idFor("team", profile.scope, awayNormalized);
  const competitionId = idFor("competition", profile.scope, competitionNormalized);
  const canonicalKey = stableStringify({
    scope: profile.scope,
    competition: competitionNormalized,
    date,
    homeTeamId,
    awayTeamId,
  });
  const matchId = idFor("match", canonicalKey);
  const sourceEventId = String(event?.sourceEventId || "").trim();
  const eventSha256 = String(event?.eventSha256 || "").trim();
  if (!/^[0-9a-f]{64}$/.test(sourceEventId) || !/^[0-9a-f]{64}$/.test(eventSha256)) {
    throw new TypeError("historical event hashes are missing or invalid");
  }
  const homeGoals = Number(event?.score?.home);
  const awayGoals = Number(event?.score?.away);
  if (!Number.isSafeInteger(homeGoals) || homeGoals < 0
      || !Number.isSafeInteger(awayGoals) || awayGoals < 0) {
    throw new TypeError("historical event result is invalid");
  }

  const at = canonicalIso(observedAt);
  const resultOutcome = homeGoals > awayGoals ? "H" : homeGoals < awayGoals ? "A" : "D";
  const odds = event?.preMatchOdds || null;
  const oddsReady = [odds?.home, odds?.draw, odds?.away]
    .every((value) => Number.isFinite(Number(value)) && Number(value) > 1);
  return {
    profile,
    teamRows: [
      {
        team_id: homeTeamId,
        scope: profile.scope,
        normalized_name: homeNormalized,
        display_name: String(event.homeTeamRaw || event.homeTeamNormalized).trim(),
        seen_date: date,
      },
      {
        team_id: awayTeamId,
        scope: profile.scope,
        normalized_name: awayNormalized,
        display_name: String(event.awayTeamRaw || event.awayTeamNormalized).trim(),
        seen_date: date,
      },
    ],
    aliasRows: [
      {
        source_key: profile.sourceKey,
        normalized_alias: homeNormalized,
        raw_alias: String(event.homeTeamRaw || event.homeTeamNormalized).trim(),
        team_id: homeTeamId,
      },
      {
        source_key: profile.sourceKey,
        normalized_alias: awayNormalized,
        raw_alias: String(event.awayTeamRaw || event.awayTeamNormalized).trim(),
        team_id: awayTeamId,
      },
    ],
    competitionRow: {
      competition_id: competitionId,
      scope: profile.scope,
      normalized_name: competitionNormalized,
      display_name: String(event.competition || "Unknown").trim(),
    },
    matchRow: {
      match_id: matchId,
      canonical_key: canonicalKey,
      competition_id: competitionId,
      match_date: date,
      kickoff_time: event.kickoff || null,
      kickoff_local_time: event.kickoffLocalTime || null,
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      neutral: event.neutral === true ? true : event.neutral === false ? false : null,
    },
    eventRow: {
      source_key: profile.sourceKey,
      source_event_id: sourceEventId,
      match_id: matchId,
      event_sha256: eventSha256,
      raw_row_sha256: event.rawRowSha256 || null,
      source_row_number: event.sourceRowNumber || null,
      ingest_run_id: runId,
      payload: event,
      observed_at: at,
    },
    resultRow: {
      observation_id: idFor("result", profile.sourceKey, sourceEventId, eventSha256),
      match_id: matchId,
      source_key: profile.sourceKey,
      source_event_id: sourceEventId,
      home_goals: homeGoals,
      away_goals: awayGoals,
      outcome: resultOutcome,
      available_at: nextDayAvailability(date),
      availability_policy: "date-only-result-available-next-day-12z",
      observed_at: at,
    },
    oddsRow: oddsReady ? {
      observation_id: idFor("odds", profile.sourceKey, sourceEventId, eventSha256),
      match_id: matchId,
      source_key: profile.sourceKey,
      source_event_id: sourceEventId,
      home_odds: Number(odds.home),
      draw_odds: Number(odds.draw),
      away_odds: Number(odds.away),
      observed_at: at,
    } : null,
  };
}

const uniqueRows = (rows, key) => Array.from(new Map(rows.map((row) => [row[key], row])).values());

async function writeProjectedBatch(client, projected) {
  if (!projected.length) return { insertedEvents: 0 };
  const teams = uniqueRows(projected.flatMap((row) => row.teamRows), "team_id");
  const aliases = uniqueRows(projected.flatMap((row) => row.aliasRows), "normalized_alias");
  const competitions = uniqueRows(projected.map((row) => row.competitionRow), "competition_id");
  const matches = uniqueRows(projected.map((row) => row.matchRow), "match_id");
  const events = projected.map((row) => row.eventRow);
  const results = projected.map((row) => row.resultRow);
  const odds = projected.map((row) => row.oddsRow).filter(Boolean);

  await client.query(`
    INSERT INTO football.historical_teams
      (team_id, scope, normalized_name, display_name, first_seen_date, last_seen_date)
    SELECT team_id, scope, normalized_name, display_name, seen_date::date, seen_date::date
    FROM jsonb_to_recordset($1::jsonb) AS row(
      team_id text, scope text, normalized_name text, display_name text, seen_date text
    )
    ON CONFLICT (team_id) DO UPDATE SET
      display_name = CASE
        WHEN length(EXCLUDED.display_name) > length(football.historical_teams.display_name)
          THEN EXCLUDED.display_name ELSE football.historical_teams.display_name END,
      first_seen_date = LEAST(football.historical_teams.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date = GREATEST(football.historical_teams.last_seen_date, EXCLUDED.last_seen_date),
      updated_at = now()
  `, [JSON.stringify(teams)]);

  await client.query(`
    INSERT INTO football.historical_team_aliases
      (source_key, normalized_alias, raw_alias, team_id)
    SELECT source_key, normalized_alias, raw_alias, team_id
    FROM jsonb_to_recordset($1::jsonb) AS row(
      source_key text, normalized_alias text, raw_alias text, team_id text
    )
    ON CONFLICT (source_key, normalized_alias) DO UPDATE SET
      raw_alias = EXCLUDED.raw_alias,
      team_id = EXCLUDED.team_id,
      last_seen_at = now()
  `, [JSON.stringify(aliases)]);

  await client.query(`
    INSERT INTO football.historical_competitions
      (competition_id, scope, normalized_name, display_name)
    SELECT competition_id, scope, normalized_name, display_name
    FROM jsonb_to_recordset($1::jsonb) AS row(
      competition_id text, scope text, normalized_name text, display_name text
    )
    ON CONFLICT (competition_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      updated_at = now()
  `, [JSON.stringify(competitions)]);

  await client.query(`
    INSERT INTO football.historical_matches
      (match_id, canonical_key, competition_id, match_date, kickoff_time, kickoff_local_time,
       home_team_id, away_team_id, neutral)
    SELECT match_id, canonical_key, competition_id, match_date::date,
      NULLIF(kickoff_time, '')::timestamptz, NULLIF(kickoff_local_time, '')::time,
      home_team_id, away_team_id, neutral
    FROM jsonb_to_recordset($1::jsonb) AS row(
      match_id text, canonical_key text, competition_id text, match_date text,
      kickoff_time text, kickoff_local_time text, home_team_id text, away_team_id text,
      neutral boolean
    )
    ON CONFLICT (match_id) DO UPDATE SET
      kickoff_time = COALESCE(EXCLUDED.kickoff_time, football.historical_matches.kickoff_time),
      kickoff_local_time = COALESCE(EXCLUDED.kickoff_local_time, football.historical_matches.kickoff_local_time),
      last_seen_at = now()
  `, [JSON.stringify(matches)]);

  const inserted = await client.query(`
    INSERT INTO football.historical_source_events
      (source_key, source_event_id, match_id, event_sha256, raw_row_sha256,
       source_row_number, ingest_run_id, payload, observed_at)
    SELECT source_key, source_event_id, match_id, event_sha256, raw_row_sha256,
      source_row_number, ingest_run_id, payload, observed_at::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS row(
      source_key text, source_event_id text, match_id text, event_sha256 text,
      raw_row_sha256 text, source_row_number integer, ingest_run_id text,
      payload jsonb, observed_at text
    )
    ON CONFLICT (source_key, source_event_id) DO NOTHING
    RETURNING source_event_id
  `, [JSON.stringify(events)]);

  await client.query(`
    INSERT INTO football.historical_result_observations
      (observation_id, match_id, source_key, source_event_id, home_goals, away_goals,
       outcome, available_at, availability_policy, observed_at)
    SELECT observation_id, match_id, source_key, source_event_id, home_goals, away_goals,
      outcome, available_at::timestamptz, availability_policy, observed_at::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS row(
      observation_id text, match_id text, source_key text, source_event_id text,
      home_goals integer, away_goals integer, outcome text, available_at text,
      availability_policy text, observed_at text
    )
    ON CONFLICT (source_key, source_event_id) DO NOTHING
  `, [JSON.stringify(results)]);

  if (odds.length) {
    await client.query(`
      INSERT INTO football.historical_odds_observations
        (observation_id, match_id, source_key, source_event_id,
         home_odds, draw_odds, away_odds, observed_at)
      SELECT observation_id, match_id, source_key, source_event_id,
        home_odds, draw_odds, away_odds, observed_at::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        observation_id text, match_id text, source_key text, source_event_id text,
        home_odds numeric, draw_odds numeric, away_odds numeric, observed_at text
      )
      ON CONFLICT (source_key, source_event_id, market) DO NOTHING
    `, [JSON.stringify(odds)]);
  }

  return { insertedEvents: inserted.rowCount };
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function registerSource(pool, profile) {
  await pool.query(`
    INSERT INTO football.data_sources
      (source_key, display_name, source_kind, source_url, license_code,
       authority_rank, refresh_interval_minutes, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (source_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      source_kind = EXCLUDED.source_kind,
      source_url = EXCLUDED.source_url,
      license_code = EXCLUDED.license_code,
      authority_rank = EXCLUDED.authority_rank,
      refresh_interval_minutes = EXCLUDED.refresh_interval_minutes,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `, [
    profile.sourceKey,
    profile.displayName,
    profile.sourceKind,
    profile.sourceUrl,
    profile.licenseCode,
    profile.authorityRank,
    profile.refreshIntervalMinutes,
    JSON.stringify({ scope: profile.scope, role: "historical-model-input" }),
  ]);
}

async function importHistoricalFileToPostgres({
  pool,
  dataset,
  filePath,
  timezoneOffset = null,
  batchSize = 500,
  maxRejectedRatio = 0.005,
  observedAt = new Date().toISOString(),
  onProgress = null,
}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("a PostgreSQL pool is required");
  const datasetKey = resolveDatasetKey(dataset);
  const profile = SOURCE_PROFILES[datasetKey];
  const resolvedFile = path.resolve(filePath);
  const fileStat = fs.lstatSync(resolvedFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size <= 0) {
    throw new TypeError(`historical source must be a non-empty regular file: ${resolvedFile}`);
  }
  const sourceFileSha256 = await fileSha256(resolvedFile);
  const startedAt = canonicalIso(observedAt);
  const runId = idFor("ingest", profile.sourceKey, sourceFileSha256, startedAt);
  await registerSource(pool, profile);

  const prior = await pool.query(`
    SELECT run_id, completed_at, accepted_rows, manifest
    FROM football.data_ingest_runs
    WHERE source_key = $1 AND source_file_sha256 = $2 AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `, [profile.sourceKey, sourceFileSha256]);
  if (prior.rowCount > 0) {
    return {
      ok: true,
      idempotent: true,
      sourceKey: profile.sourceKey,
      sourceFileSha256,
      priorRun: prior.rows[0],
    };
  }

  await pool.query(`
    INSERT INTO football.data_ingest_runs
      (run_id, source_key, source_file_path, source_file_sha256, status, started_at)
    VALUES ($1, $2, $3, $4, 'running', $5)
  `, [runId, profile.sourceKey, resolvedFile, sourceFileSha256, startedAt]);

  const rejectedByReason = {};
  let acceptedRows = 0;
  let insertedEvents = 0;
  let manifest = null;
  try {
    const result = await withPostgresTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `football-historical-ingest:${profile.sourceKey}:${sourceFileSha256}`,
      ]);
      const nowCompleted = await client.query(`
        SELECT run_id FROM football.data_ingest_runs
        WHERE source_key = $1 AND source_file_sha256 = $2 AND status = 'completed'
        LIMIT 1
      `, [profile.sourceKey, sourceFileSha256]);
      if (nowCompleted.rowCount > 0) {
        await client.query(`
          UPDATE football.data_ingest_runs SET status = 'duplicate', completed_at = now(),
            manifest = jsonb_build_object('priorRunId', $2::text)
          WHERE run_id = $1
        `, [runId, nowCompleted.rows[0].run_id]);
        return { duplicate: true, priorRunId: nowCompleted.rows[0].run_id };
      }

      const iterator = iterateHistoricalEvents({
        dataset: datasetKey,
        filePath: resolvedFile,
        timezoneOffset,
        createdAt: startedAt,
        onRejected: ({ reason }) => {
          const key = String(reason || "unknown");
          rejectedByReason[key] = Number(rejectedByReason[key] || 0) + 1;
        },
      });
      let batch = [];
      while (true) {
        const step = await iterator.next();
        if (step.done) {
          manifest = step.value;
          break;
        }
        batch.push(projectHistoricalEvent(step.value, {
          dataset: datasetKey,
          runId,
          observedAt: startedAt,
        }));
        acceptedRows += 1;
        if (batch.length >= Math.max(50, Math.min(2000, Number(batchSize) || 500))) {
          const written = await writeProjectedBatch(client, batch);
          insertedEvents += written.insertedEvents;
          batch = [];
          if (typeof onProgress === "function") onProgress({ acceptedRows, insertedEvents });
        }
      }
      if (batch.length) {
        const written = await writeProjectedBatch(client, batch);
        insertedEvents += written.insertedEvents;
      }

      const rejectedRatio = Number(manifest?.inputRows || 0) > 0
        ? Number(manifest.rejected || 0) / Number(manifest.inputRows)
        : 0;
      if (rejectedRatio > maxRejectedRatio) {
        const error = new Error(`historical rejection ratio ${rejectedRatio} exceeds ${maxRejectedRatio}`);
        error.code = "HISTORICAL_REJECTION_RATIO_EXCEEDED";
        throw error;
      }

      const duplicateRows = Math.max(0, acceptedRows - insertedEvents);
      await client.query(`
        UPDATE football.data_ingest_runs SET
          status = 'completed', completed_at = now(), input_rows = $2,
          accepted_rows = $3, duplicate_rows = $4, rejected_rows = $5,
          manifest = $6::jsonb
        WHERE run_id = $1
      `, [
        runId,
        Number(manifest.inputRows || acceptedRows),
        acceptedRows,
        duplicateRows,
        Number(manifest.rejected || 0),
        JSON.stringify({ ...manifest, rejectedByReason }),
      ]);
      return { duplicate: false, duplicateRows };
    });

    return {
      ok: true,
      idempotent: result.duplicate === true,
      runId,
      sourceKey: profile.sourceKey,
      sourceFile: resolvedFile,
      sourceFileSha256,
      acceptedRows,
      insertedEvents,
      duplicateRows: result.duplicateRows || 0,
      manifest,
      rejectedByReason,
      priorRunId: result.priorRunId || null,
    };
  } catch (error) {
    await pool.query(`
      UPDATE football.data_ingest_runs SET status = 'failed', completed_at = now(),
        input_rows = $2, accepted_rows = $3, rejected_rows = $4,
        manifest = $5::jsonb, error_code = $6, error_message = $7
      WHERE run_id = $1
    `, [
      runId,
      Number(manifest?.inputRows || acceptedRows),
      acceptedRows,
      Number(manifest?.rejected || 0),
      JSON.stringify(manifest ? { ...manifest, rejectedByReason } : { rejectedByReason }),
      error.code || "HISTORICAL_POSTGRES_IMPORT_FAILED",
      String(error.message || error).slice(0, 2000),
    ]).catch(() => {});
    throw error;
  }
}

module.exports = {
  SOURCE_PROFILES,
  importHistoricalFileToPostgres,
  projectHistoricalEvent,
  resolveDatasetKey,
  writeProjectedBatch,
};
