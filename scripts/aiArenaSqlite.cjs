"use strict";

const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const ensureSchema = (db) => db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS ai_players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    style TEXT NOT NULL,
    month_key TEXT NOT NULL,
    balance REAL NOT NULL,
    rank INTEGER,
    status TEXT NOT NULL,
    brier_score REAL,
    max_drawdown REAL NOT NULL,
    stage_score REAL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_predictions (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL,
    ai_id TEXT NOT NULL,
    month_key TEXT NOT NULL,
    week_start TEXT NOT NULL,
    pick TEXT NOT NULL CHECK (pick IN ('1', 'X', '2')),
    probability_home REAL NOT NULL,
    probability_draw REAL NOT NULL,
    probability_away REAL NOT NULL,
    confidence INTEGER NOT NULL,
    projected_score TEXT NOT NULL,
    stake REAL NOT NULL,
    odds REAL NOT NULL,
    result TEXT,
    profit REAL,
    submission_hash TEXT NOT NULL,
    locked_at TEXT NOT NULL,
    settled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ai_predictions_week
    ON ai_predictions(month_key, week_start, match_id, ai_id);
  CREATE INDEX IF NOT EXISTS idx_ai_predictions_agent
    ON ai_predictions(ai_id, settled_at);

  CREATE TABLE IF NOT EXISTS ai_balance_history (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    ai_id TEXT NOT NULL,
    month_key TEXT NOT NULL,
    balance REAL NOT NULL,
    delta REAL,
    match_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ai_balance_history_agent
    ON ai_balance_history(month_key, ai_id, date);

  CREATE TABLE IF NOT EXISTS ai_arena_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const ensurePredictionAuditColumns = (db) => {
  const columns = new Set(db.prepare("PRAGMA table_info(ai_predictions)").all().map((row) => row.name));
  if (!columns.has("decision_version")) db.exec("ALTER TABLE ai_predictions ADD COLUMN decision_version TEXT");
  if (!columns.has("decision_evidence_json")) db.exec("ALTER TABLE ai_predictions ADD COLUMN decision_evidence_json TEXT");
  if (!columns.has("draw_signal_score")) db.exec("ALTER TABLE ai_predictions ADD COLUMN draw_signal_score REAL");
  if (!columns.has("adversarial_risk_score")) db.exec("ALTER TABLE ai_predictions ADD COLUMN adversarial_risk_score REAL");
};

const persistAiArenaSqlite = ({ dbPath, state, payload }) => {
  if (!DatabaseSync) throw new Error("node:sqlite is unavailable for AI arena persistence");
  const resolvedPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedPath);
  try {
    ensureSchema(db);
    ensurePredictionAuditColumns(db);
    const insertPlayer = db.prepare(`
      INSERT INTO ai_players (
        id, name, model, style, month_key, balance, rank, status,
        brier_score, max_drawdown, stage_score, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, model=excluded.model, style=excluded.style,
        month_key=excluded.month_key, balance=excluded.balance, rank=excluded.rank,
        status=excluded.status, brier_score=excluded.brier_score,
        max_drawdown=excluded.max_drawdown, stage_score=excluded.stage_score,
        updated_at=excluded.updated_at
    `);
    const insertPrediction = db.prepare(`
      INSERT INTO ai_predictions (
        id, match_id, ai_id, month_key, week_start, pick,
        probability_home, probability_draw, probability_away,
        confidence, projected_score, stake, odds, result, profit,
        submission_hash, locked_at, settled_at,
        decision_version, decision_evidence_json, draw_signal_score, adversarial_risk_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        result=excluded.result, profit=excluded.profit, settled_at=excluded.settled_at
    `);
    const insertBalance = db.prepare(`
      INSERT INTO ai_balance_history (
        id, date, ai_id, month_key, balance, delta, match_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        balance=excluded.balance, delta=excluded.delta, match_id=excluded.match_id
    `);
    const upsertMeta = db.prepare(`
      INSERT INTO ai_arena_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const player of payload.standings || []) {
        insertPlayer.run(
          player.id,
          player.name,
          player.model || "strategy-profile-v1",
          player.style,
          payload.monthKey,
          player.balance,
          player.wealthRank,
          player.status,
          player.brierScore,
          player.maxDrawdown,
          player.stageScore,
          payload.generatedAt,
        );
        for (let index = 0; index < (player.balanceHistory || []).length; index += 1) {
          const row = player.balanceHistory[index];
          insertBalance.run(
            `${payload.monthKey}:${player.id}:${index}:${row.at}`,
            row.at,
            player.id,
            payload.monthKey,
            row.balance,
            row.delta ?? null,
            row.matchId ?? null,
          );
        }
      }

      for (const month of Object.values(state.months || {})) {
        for (const week of Object.values(month.weeks || {})) {
          if (week?.status !== "LOCKED") continue;
          const matchById = new Map((week.pool || []).map((match) => [match.id, match]));
          for (const [agentId, submission] of Object.entries(week.agentForecasts || {})) {
            for (const forecast of submission.forecasts || []) {
              const match = matchById.get(forecast.matchId);
              if (!match) continue;
              const settlement = week.settlements?.[forecast.matchId] || null;
              const result = settlement?.status === "SETTLED" ? settlement.outcome
                : settlement?.status === "VOID" ? "VOID"
                : null;
              const profit = settlement?.status === "VOID" || !forecast.investment ? 0
                : settlement?.status === "SETTLED"
                  ? (forecast.pick === settlement.outcome
                    ? forecast.stake * (match.odds[forecast.pick] - 1)
                    : -forecast.stake)
                  : null;
              insertPrediction.run(
                `${week.weekStart}:${forecast.matchId}:${agentId}`,
                forecast.matchId,
                agentId,
                month.monthKey,
                week.weekStart,
                forecast.pick,
                forecast.probabilities["1"],
                forecast.probabilities.X,
                forecast.probabilities["2"],
                forecast.confidence,
                forecast.projectedScore,
                forecast.stake,
                match.odds[forecast.pick],
                result,
                profit,
                submission.submissionHash,
                week.lockedAt,
                settlement?.settledAt || null,
                forecast.decisionAudit?.version || null,
                forecast.decisionAudit ? JSON.stringify(forecast.decisionAudit) : null,
                forecast.decisionAudit?.drawSignalScore ?? null,
                forecast.decisionAudit?.adversarialRiskScore ?? null,
              );
            }
          }
        }
      }
      upsertMeta.run("state_hash", payload.integrity?.stateHash || "", payload.generatedAt);
      upsertMeta.run("submission_root_hash", payload.submissionRootHash || "", payload.generatedAt);
      upsertMeta.run("payload_version", payload.version, payload.generatedAt);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }

    return {
      ok: true,
      path: resolvedPath,
      counts: {
        players: Number(db.prepare("SELECT COUNT(*) AS count FROM ai_players").get().count || 0),
        predictions: Number(db.prepare("SELECT COUNT(*) AS count FROM ai_predictions").get().count || 0),
        balanceHistory: Number(db.prepare("SELECT COUNT(*) AS count FROM ai_balance_history").get().count || 0),
      },
    };
  } finally {
    db.close();
  }
};

module.exports = {
  persistAiArenaSqlite,
};
