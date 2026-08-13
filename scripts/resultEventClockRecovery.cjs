const RESULT_PHASES = new Set(["FINISHED", "PENDING_RESULT", "LIVE"]);
const PRE_MATCH_PHASES = new Set(["baseline", "mid", "late", "final", "locked"]);

const text = (value) => String(value ?? "").trim();
const normText = (value) => text(value).toLowerCase();
const sourceMatchIdOf = (row) => text(row?.sourceMatchId || row?.id)
  .replace(/^sporttery_/, "");
const timeOf = (value) => Date.parse(text(value));
const isoOf = (value) => {
  const time = timeOf(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const shanghaiMidnight = (value) => {
  const time = timeOf(value);
  if (!Number.isFinite(time)) return false;
  const shanghai = new Date(time + 8 * 60 * 60 * 1000);
  return shanghai.getUTCHours() === 0
    && shanghai.getUTCMinutes() === 0
    && shanghai.getUTCSeconds() === 0;
};

const rowBusinessDate = (row) => text(row?.businessDate || row?.matchDate)
  .match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;

const sameRequiredIdentity = (match, snapshot) => {
  const sourceMatchId = sourceMatchIdOf(match);
  const snapshotSourceMatchId = sourceMatchIdOf(snapshot);
  const matchNo = normText(match?.matchNo);
  const snapshotMatchNo = normText(snapshot?.matchNo);
  const businessDate = rowBusinessDate(match);
  const snapshotBusinessDate = rowBusinessDate(snapshot);
  const home = normText(match?.homeTeamName || match?.homeTeam);
  const snapshotHome = normText(snapshot?.homeTeamName || snapshot?.homeTeam);
  const away = normText(match?.awayTeamName || match?.awayTeam);
  const snapshotAway = normText(snapshot?.awayTeamName || snapshot?.awayTeam);
  return Boolean(
    sourceMatchId
    && sourceMatchId === snapshotSourceMatchId
    && matchNo
    && matchNo === snapshotMatchNo
    && businessDate
    && businessDate === snapshotBusinessDate
    && home
    && home === snapshotHome
    && away
    && away === snapshotAway
  );
};

const snapshotClockAudit = (snapshot) => (
  snapshot?.clockAudit
  || snapshot?.decisionSnapshot?.clockAudit
  || null
);

const snapshotKickoff = (snapshot) => (
  snapshot?.eventVersion
  || snapshot?.decisionSnapshot?.kickoffTime
  || snapshot?.kickoffTime
  || null
);

const snapshotHasOfficialBest = (snapshot) => {
  const best = snapshot?.best;
  return ["reference", "recommend"].includes(text(best?.recommendationAction).toLowerCase())
    && ["HAD", "HHAD"].includes(text(best?.oddsPoolCode).toUpperCase())
    && ["1", "X", "2"].includes(text(best?.tipCode).toUpperCase())
    && Number.isFinite(Number(best?.odds))
    && Number(best.odds) > 1;
};

const eligibleClockEvidence = (match, snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!sameRequiredIdentity(match, snapshot)) return false;
  if (!PRE_MATCH_PHASES.has(normText(snapshot?.phase))) return false;
  if (snapshotClockAudit(snapshot)?.eligible !== true) return false;
  if (!snapshotHasOfficialBest(snapshot)) return false;

  const capturedAt = timeOf(snapshot?.capturedAt);
  const cutoffTime = timeOf(
    snapshotClockAudit(snapshot)?.cutoffTime
    || snapshot?.decisionSnapshot?.cutoffTime
    || snapshot?.cutoffTime
  );
  const kickoffTime = timeOf(snapshotKickoff(snapshot));
  return Number.isFinite(capturedAt)
    && Number.isFinite(cutoffTime)
    && Number.isFinite(kickoffTime)
    && capturedAt <= cutoffTime
    && capturedAt < kickoffTime
    && cutoffTime <= kickoffTime
    && !shanghaiMidnight(snapshotKickoff(snapshot));
};

const officialResultClockWasOmitted = (match) => (
  match?.officialResultIdentity?.endpoint === "getUniformMatchResultV1"
  && [
    "omitted-by-official-result-feed",
    // Older reconciliation could label a midnight placeholder "inherited"
    // after inheriting that placeholder from an already polluted current row.
    // The midnight + unique strict snapshot guards below remain mandatory.
    "inherited-pre-match-event-identity",
  ].includes(match?.officialResultIdentity?.scheduleTimeAuthority)
);

const recoverResultEventClockFromSnapshots = (match, snapshots) => {
  if (!match || typeof match !== "object") return match;
  if (!RESULT_PHASES.has(text(match?.status).toUpperCase())) return match;
  if (!officialResultClockWasOmitted(match) || !shanghaiMidnight(match?.kickoffTime)) return match;

  const qualified = (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => eligibleClockEvidence(match, snapshot));
  const events = new Map();
  for (const snapshot of qualified) {
    const kickoffTime = isoOf(snapshotKickoff(snapshot));
    const eventVersion = isoOf(snapshot?.eventVersion || snapshotKickoff(snapshot));
    if (!kickoffTime || !eventVersion) continue;
    const key = JSON.stringify([kickoffTime, eventVersion]);
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(snapshot);
  }
  // Provider ids can be reused. Array order is never enough to select an
  // event: recovery is allowed only when all independently qualified rows
  // prove one exact non-midnight event.
  if (events.size !== 1) return match;

  const eventSnapshots = events.values().next().value;
  const evidence = eventSnapshots.slice().sort((left, right) => (
    timeOf(left.capturedAt) - timeOf(right.capturedAt)
  )).at(-1);
  const kickoffTime = isoOf(snapshotKickoff(evidence));
  const eventVersion = isoOf(evidence?.eventVersion || snapshotKickoff(evidence));
  const cutoffTime = isoOf(
    snapshotClockAudit(evidence)?.cutoffTime
    || evidence?.decisionSnapshot?.cutoffTime
    || evidence?.cutoffTime
  );
  if (!kickoffTime || !eventVersion || !cutoffTime) return match;

  return {
    ...match,
    kickoffTime,
    eventVersion,
    matchDate: evidence.matchDate || kickoffTime.slice(0, 10),
    businessDate: evidence.businessDate || match.businessDate,
    buyEndTime: cutoffTime,
    predictionMeta: {
      ...(match.predictionMeta || {}),
      cutoffTime,
    },
    resultEventClockRecovery: {
      version: "sqlite-pre-match-event-clock-recovery-v1",
      reason: "official-result-feed-omitted-kickoff-clock",
      recoveredFrom: "sqlite-pre-cutoff-prediction-snapshots",
      previousKickoffTime: match.kickoffTime,
      kickoffTime,
      eventVersion,
      cutoffTime,
      evidenceRows: eventSnapshots.length,
      latestEvidenceCapturedAt: isoOf(evidence.capturedAt),
      sourceMatchId: sourceMatchIdOf(match),
    },
  };
};

module.exports = {
  eligibleClockEvidence,
  recoverResultEventClockFromSnapshots,
};
