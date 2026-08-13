const fs = require("node:fs");
const path = require("node:path");
const {
  attachArchivedPreMatchPredictions,
  validArchivedPreMatchPrediction,
} = require("./syncData.cjs");
const {
  recoverResultEventClockFromSnapshots,
} = require("./resultEventClockRecovery.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const canonicalJson = (value) => JSON.stringify(value);

const writeJsonAtomic = (filePath, payload) => {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.archive-migration-${process.pid}-${Date.now()}.tmp`
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  fs.renameSync(temporaryPath, filePath);
};

const archiveKey = (match) => String(match?.sourceMatchId || match?.id || "")
  .replace(/^sporttery_/, "");

const normText = (value) => String(value ?? "").trim().toLowerCase();

const localDateAndClock = (value) => {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  return match ? { date: match[1], clock: `${match[2]}:${match[3]}` } : null;
};

const rowBusinessDate = (row) => {
  const match = String(row?.businessDate || row?.matchDate || "")
    .match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
};

const sameTeams = (left, right) => (
  normText(left?.homeTeamName || left?.homeTeam)
    === normText(right?.homeTeamName || right?.homeTeam)
  && normText(left?.awayTeamName || left?.awayTeam)
    === normText(right?.awayTeamName || right?.awayTeam)
);

const repairMidnightResultClock = (
  match,
  evidenceCandidates,
  predictionSnapshotsPayload,
  capturedAt
) => {
  const currentClock = localDateAndClock(match?.kickoffTime);
  const resultPhase = ["FINISHED", "PENDING_RESULT", "LIVE"]
    .includes(String(match?.status || "").trim().toUpperCase());
  if (!resultPhase || currentClock?.clock !== "00:00") return null;
  const qualified = new Map();
  for (const evidence of evidenceCandidates) {
    const evidenceClock = localDateAndClock(evidence?.kickoffTime);
    const currentBusinessDate = rowBusinessDate(match);
    const evidenceBusinessDate = rowBusinessDate(evidence);
    const sameCalendarOrBusinessDate = evidenceClock?.date === currentClock.date
      || (
        currentBusinessDate
        && evidenceBusinessDate
        && currentBusinessDate === evidenceBusinessDate
      );
    if (
      !sameTeams(match, evidence)
      || !sameCalendarOrBusinessDate
      || evidenceClock?.clock === "00:00"
    ) {
      continue;
    }
    // The signed current row can predate archive attachment. In that case,
    // prove its non-midnight event clock against the signed pre-cutoff
    // prediction snapshots before inheriting the clock. This breaks the
    // otherwise circular dependency where an archive needs the correct event
    // clock, while correcting an official result row's omitted clock used to
    // require an archive that had already been attached.
    const evidenceWithArchive = validArchivedPreMatchPrediction(evidence)
      ? evidence
      : attachArchivedPreMatchPredictions(
        [evidence],
        predictionSnapshotsPayload,
        null,
        capturedAt
      )[0];
    const evidenceArchive = validArchivedPreMatchPrediction(evidenceWithArchive);
    if (!evidenceArchive) continue;
    const eventKey = JSON.stringify([
      evidence?.eventVersion || evidence?.kickoffTime || null,
      evidence?.kickoffTime || null,
    ]);
    if (!qualified.has(eventKey)) {
      qualified.set(eventKey, { evidence, evidenceArchive });
    }
  }
  // A reused provider id or polluted signed cache can expose more than one
  // exact event. Never choose by array order: only a unique, snapshot-proven
  // event may repair the result feed's omitted clock.
  if (qualified.size !== 1) return null;
  const { evidence, evidenceArchive } = qualified.values().next().value;
  return {
      ...match,
      kickoffTime: evidence.kickoffTime,
      eventVersion: evidence.eventVersion || evidence.kickoffTime,
      matchDate: evidence.matchDate || match.matchDate,
      businessDate: evidence.businessDate || match.businessDate,
      buyEndTime: evidence.buyEndTime || match.buyEndTime,
      predictionMeta: {
        ...(match.predictionMeta || {}),
        cutoffTime: evidence?.predictionMeta?.cutoffTime
          || evidence.buyEndTime
          || evidence.kickoffTime,
      },
      resultEventClockRecovery: {
        version: "signed-pre-match-event-clock-recovery-v1",
        reason: "official-result-feed-omitted-kickoff-clock",
        recoveredFrom: "signed-release-matches-current",
        archiveEvidence: evidence?.archivedPreMatchPrediction
          ? "signed-current-archive"
          : "signed-pre-cutoff-prediction-snapshot",
        archiveCapturedAt: evidenceArchive.capturedAt,
        previousKickoffTime: match.kickoffTime,
        kickoffTime: evidence.kickoffTime,
        eventVersion: evidence.eventVersion || evidence.kickoffTime,
      },
  };
};

const snapshotIdentity = (row) => JSON.stringify([
  archiveKey(row),
  row?.eventVersion || row?.kickoffTime || null,
  row?.capturedAt || null,
  row?.signature || null,
  row?.featureSnapshotHash || row?.featureSnapshot?.hash || null,
]);

const mergeSnapshotRows = (primaryRows, evidenceRows) => {
  const merged = [];
  const seen = new Set();
  for (const row of [...primaryRows, ...evidenceRows]) {
    const identity = snapshotIdentity(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(row);
  }
  return merged;
};

const migrateArchivedPreMatchReferences = ({
  dataDir = path.join(ROOT_DIR, "public", "data"),
  evidenceDataDir = null,
  capturedAt = new Date().toISOString(),
  write = true,
} = {}) => {
  const currentPath = path.join(dataDir, "matches-current.json");
  const historyPath = path.join(dataDir, "matches-history.json");
  const snapshotsPath = path.join(dataDir, "prediction-snapshots.json");
  const current = readJson(currentPath, []);
  const history = readJson(historyPath, []);
  const snapshots = readJson(snapshotsPath, { rows: [] });
  const evidenceSnapshots = evidenceDataDir
    ? readJson(path.join(evidenceDataDir, "prediction-snapshots.json"), { rows: [] })
    : { rows: [] };
  const evidenceCurrent = evidenceDataDir
    ? readJson(path.join(evidenceDataDir, "matches-current.json"), [])
    : [];
  if (!Array.isArray(current) || !Array.isArray(history)) {
    throw new Error("matches-current.json and matches-history.json must be arrays");
  }
  if (!Array.isArray(snapshots?.rows)) {
    throw new Error("prediction-snapshots.json must expose rows");
  }
  if (!Array.isArray(evidenceSnapshots?.rows)) {
    throw new Error("evidence prediction-snapshots.json must expose rows");
  }
  if (!Array.isArray(evidenceCurrent)) {
    throw new Error("evidence matches-current.json must be an array");
  }
  const currentSourceIds = new Set(current.map(archiveKey).filter(Boolean));
  const currentEvidenceRows = evidenceSnapshots.rows.filter((row) => (
    currentSourceIds.has(archiveKey(row))
  ));
  const currentSnapshots = {
    ...snapshots,
    rows: mergeSnapshotRows(snapshots.rows, currentEvidenceRows),
  };
  const evidenceCurrentIndex = new Map();
  for (const row of evidenceCurrent) {
    const key = archiveKey(row);
    if (!key) continue;
    if (!evidenceCurrentIndex.has(key)) evidenceCurrentIndex.set(key, []);
    evidenceCurrentIndex.get(key).push(row);
  }
  let evidenceArchivesApplied = 0;
  let eventClocksRepaired = 0;
  const currentWithEvidenceArchives = current.map((match) => {
    const candidates = evidenceCurrentIndex.get(archiveKey(match)) || [];
    const repaired = repairMidnightResultClock(
      match,
      candidates,
      currentSnapshots,
      capturedAt
    );
    const currentMatch = repaired || match;
    if (repaired) eventClocksRepaired += 1;
    if (validArchivedPreMatchPrediction(currentMatch)) return currentMatch;
    const evidenceArchive = candidates
      .map((candidate) => candidate?.archivedPreMatchPrediction)
      .find((archive) => validArchivedPreMatchPrediction(currentMatch, archive));
    if (!evidenceArchive) return currentMatch;
    evidenceArchivesApplied += 1;
    return {
      ...currentMatch,
      archivedPreMatchPrediction: structuredClone(evidenceArchive),
    };
  });

  const migrateRows = (rows, snapshotPayload) => attachArchivedPreMatchPredictions(
    rows,
    snapshotPayload,
    null,
    capturedAt
  );
  const nextCurrent = migrateRows(currentWithEvidenceArchives, currentSnapshots);
  // The signed bundle is allowed to supplement only matches that remain in
  // the mutable current feed. Historical rows keep their production snapshot
  // boundary; otherwise a release could rewrite hundreds of settled archives.
  // Historical rows may already contain the official result feed's explicit
  // "schedule time omitted" midnight placeholder. Only SQLite/production
  // snapshots that independently prove one exact pre-cutoff official-SP event
  // may repair that clock; signed release snapshots are not allowed to create
  // a new historical archive across the production snapshot boundary.
  const historyWithRecoveredClocks = history.map((match) => (
    recoverResultEventClockFromSnapshots(match, snapshots.rows)
  ));
  const nextHistory = migrateRows(historyWithRecoveredClocks, snapshots);
  eventClocksRepaired += historyWithRecoveredClocks.reduce((count, match, index) => (
    canonicalJson(match) === canonicalJson(history[index]) ? count : count + 1
  ), 0);
  const changesForRows = (beforeRows, afterRows, collection) => afterRows
    .map((match, index) => ({
      sourceMatchId: archiveKey(match),
      collection,
      before: canonicalJson(beforeRows[index]?.archivedPreMatchPrediction || null),
      after: canonicalJson(match?.archivedPreMatchPrediction || null),
      archive: match?.archivedPreMatchPrediction || null,
    }))
    .filter((row) => row.before !== row.after)
    .map((row) => ({
      sourceMatchId: row.sourceMatchId,
      collection: row.collection,
      action: row.archive ? "archive-attached-or-repaired" : "invalid-archive-removed",
      marketEvidenceScope: row.archive?.marketEvidenceScope || null,
      tipCode: row.archive?.prediction?.tipCode || null,
      odds: Number(row.archive?.prediction?.odds ?? Number.NaN),
      capturedAt: row.archive?.capturedAt || null,
    }));
  const changes = [
    ...changesForRows(current, nextCurrent, "current"),
    ...changesForRows(history, nextHistory, "history"),
  ];

  if (write && canonicalJson(nextCurrent) !== canonicalJson(current)) {
    writeJsonAtomic(currentPath, nextCurrent);
  }
  if (write && canonicalJson(nextHistory) !== canonicalJson(history)) {
    writeJsonAtomic(historyPath, nextHistory);
  }

  return {
    ok: true,
    version: "archived-pre-match-reference-migration-v1",
    dataDir,
    evidenceDataDir,
    capturedAt,
    write,
    rows: {
      current: nextCurrent.length,
      history: nextHistory.length,
      snapshots: snapshots.rows.length,
      evidenceSnapshots: evidenceSnapshots.rows.length,
      currentEvidenceSnapshots: currentEvidenceRows.length,
      mergedCurrentSnapshots: currentSnapshots.rows.length,
      evidenceCurrent: evidenceCurrent.length,
      evidenceArchivesApplied,
      eventClocksRepaired,
      changed: changes.length,
    },
    changes,
  };
};

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.resolve(
    process.env.PUBLIC_DATA_DIR || path.join(ROOT_DIR, "public", "data")
  );
  const evidenceDataDir = process.env.ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR
    ? path.resolve(process.env.ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR)
    : null;
  const result = migrateArchivedPreMatchReferences({
    dataDir,
    evidenceDataDir,
    capturedAt: process.env.ARCHIVE_MIGRATION_CAPTURED_AT || new Date().toISOString(),
    write: !dryRun,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  migrateArchivedPreMatchReferences,
};
