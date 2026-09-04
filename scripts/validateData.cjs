const fs = require("fs");
const path = require("path");
const {
  isMatchEligibleForCurrent,
  matchIdentity,
  resolveCurrentUnsettledRetentionHours,
} = require("./currentMatchRetention.cjs");
const {
  hasAcceptedResultOnlySource,
  hasFiveHundredResult,
} = require("./resultOnlyValidation.cjs");
const {
  boundDecisionOddsForPrediction,
} = require("../src/services/dualMarketDecisionBinding.cjs");

const publicDir = path.join(__dirname, "..", "public");
const distDir = path.join(__dirname, "..", "dist");
const matchesPath = path.join(publicDir, "matches.json");
const currentMatchesPath = path.join(publicDir, "data", "matches-current.json");
const historyMatchesPath = path.join(publicDir, "data", "matches-history.json");
const syncMetaPath = path.join(publicDir, "data", "sync-meta.json");
const oddsHistoryPath = path.join(publicDir, "odds-history.json");
const dataOddsHistoryPath = path.join(publicDir, "data", "odds-history.json");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(__dirname, "..", "server-data"));
const unresolvedArchivePath = path.resolve(
  process.env.UNRESOLVED_MATCH_ARCHIVE_PATH || path.join(storeDir, "matches-unresolved-archive.json")
);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const validateLegacyStaticPayloads = process.env.WRITE_LEGACY_STATIC_PAYLOADS !== "0";
const validateDistMirrors = process.env.MIRROR_PUBLISHED_DATA_TO_DIST !== "0";
const allowLargeStaticDist = process.env.ALLOW_LARGE_STATIC_DIST === "1";
const disabledLargeDistPayloads = new Set([
  "matches.json",
  "odds-history.json",
  "data/matches-current.json",
  "data/matches-history.json",
  "data/team-index.json",
  "data/odds-history.json",
  "data/post-match-reviews.json",
  "data/external-signals.json",
  "data/five-hundred-details.json",
  "data/pre-match-signals.json",
  "data/prediction-snapshots.json",
  "data/model-calibration.json",
  "data/model-evaluation.json",
  "data/model-strategy.json",
  "data/api-football-cache.json",
  "data/api-football-meta.json",
  "data/gpt-predictions.json",
  "data/web-consensus-signals.json",
  "data/weather-locations.json",
  "data/worldcup-kimi-dataset.json",
  "data/sync-meta.json",
]);
const rootMatches = validateLegacyStaticPayloads && fs.existsSync(matchesPath) ? readJson(matchesPath) : [];
const currentMatches = fs.existsSync(currentMatchesPath) ? readJson(currentMatchesPath) : rootMatches;
const historyMatches = fs.existsSync(historyMatchesPath) ? readJson(historyMatchesPath) : [];
const syncMeta = fs.existsSync(syncMetaPath) ? readJson(syncMetaPath) : null;
const unresolvedArchivePayload = fs.existsSync(unresolvedArchivePath) ? readJson(unresolvedArchivePath) : null;
const unresolvedArchiveRows = Array.isArray(unresolvedArchivePayload)
  ? unresolvedArchivePayload
  : (Array.isArray(unresolvedArchivePayload?.rows) ? unresolvedArchivePayload.rows : []);
const currentListEvaluatedAt = syncMeta?.currentListPolicy?.evaluatedAt
  || syncMeta?.lastAttemptAt
  || syncMeta?.updatedAt
  || new Date().toISOString();
const currentUnsettledRetentionHours = resolveCurrentUnsettledRetentionHours(
  process.env.CURRENT_UNSETTLED_RETENTION_HOURS
    ?? syncMeta?.currentListPolicy?.unsettledRetentionHours
    ?? unresolvedArchivePayload?.retentionHours
);
const currentListPolicyVersion = String(syncMeta?.currentListPolicy?.version || "").trim();
const enforcesCurrentRetention = currentListPolicyVersion === "kickoff-retention-v1";
const matches = Array.from(new Map([...currentMatches, ...historyMatches].map((match) => [match.id, match])).values());
const currentMatchIds = new Set(currentMatches.map((match) => match.id));
const historyMatchIds = new Set(historyMatches.map((match) => match.id));
const hexColor = /^#[0-9a-fA-F]{6}$/;
const jLeagueText = /(?:\u65e5\u804c|\u65e5\u8054|\u65e5\u672c)/;
const staleText = /胜\(3\)|平\(1\)|负\(0\)|当前 1X2|大于 2\.5|小于 2\.5|Both Teams to Score \(GG\)|稳胆:/;

function expectedSportterySp(match, tipCode) {
  if (tipCode === "1") return match.odds?.odds1;
  if (tipCode === "X") return match.odds?.oddsX;
  if (tipCode === "2") return match.odds?.odds2;
  return undefined;
}

function expectedPredictionSp(match, prediction) {
  const boundDecisionOdds = boundDecisionOddsForPrediction(match, prediction);
  if (boundDecisionOdds !== null) return boundDecisionOdds;
  const odds = prediction?.oddsPoolCode === "HHAD" ? match.handicapOdds : match.odds;
  if (prediction?.tipCode === "1") return odds?.odds1;
  if (prediction?.tipCode === "X") return odds?.oddsX;
  if (prediction?.tipCode === "2") return odds?.odds2;
  return undefined;
}

function parseHandicapLine(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[＋﹢]/g, "+").replace(/[－−–—]/g, "-");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function expectedPredictionResult(match, prediction) {
  if (prediction.tipCode === "WATCH") return "PENDING";
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
  const code = prediction.tipCode;

  if (prediction.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(code)) {
    const handicap = parseHandicapLine(prediction.handicapLine ?? match.handicapLine);
    if (handicap === null) return "PENDING";
    const adjustedHome = match.scoreHome + handicap;
    const actualHhad = adjustedHome > match.scoreAway ? "1" : adjustedHome < match.scoreAway ? "2" : "X";
    return code === actualHhad ? "WON" : "LOST";
  }

  if ((prediction.marketType === "1X2" || prediction.marketType === "BEST") && ["1", "X", "2"].includes(code)) {
    return code === actual1x2 ? "WON" : "LOST";
  }
  if (prediction.marketType === "GOALS") {
    if (/^[0-6]$/.test(code)) return total === Number(code) ? "WON" : "LOST";
    if (code === "7+") return total >= 7 ? "WON" : "LOST";
    if (code === "O2.5") return total > 2.5 ? "WON" : "LOST";
    if (code === "U2.5") return total < 2.5 ? "WON" : "LOST";
  }
  if (prediction.marketType === "GG_NG") {
    if (code === "GG") return match.scoreHome > 0 && match.scoreAway > 0 ? "WON" : "LOST";
    if (code === "NG") return match.scoreHome === 0 || match.scoreAway === 0 ? "WON" : "LOST";
  }
  return prediction.resultStatus;
}

function isModelOnlyReference(match) {
  const predictions = Array.isArray(match?.predictions) ? match.predictions : [];
  if (!predictions.length) return false;

  const modelOnlyVersion = String(match?.probabilityModel?.version || "").includes("model-only");
  const hasModelOnlyTag = predictions.some((prediction) => (
    Array.isArray(prediction?.riskTags) &&
    prediction.riskTags.some((tag) => /No official SP|Model-only reference/i.test(`${tag?.en || ""} ${tag?.zh || ""}`))
  ));
  const allowedPredictions = predictions.every((prediction) => (
    ["1X2", "BEST"].includes(prediction?.marketType) &&
    Number(prediction?.odds || 0) === 0 &&
    (prediction?.tipCode === "WATCH" || ["1", "X", "2"].includes(prediction?.tipCode))
  ));

  return modelOnlyVersion && hasModelOnlyTag && allowedPredictions;
}

const errors = [];
// A schedule row without a derived direction is a publishable, honest state:
// it must remain visible as awaiting analysis/official SP rather than causing
// the whole current generation (including otherwise valid fixtures) to vanish.
// Keep it observable in the validator output, but reserve hard failures for
// malformed market/result data and integrity violations.
const publicationWarnings = [];
let oddsHistoryRows = [];
let legacyStaleCurrentRows = 0;
let legacyReviewHhadWithoutLineRows = 0;
let legacyHadWithoutExplicitLineRows = 0;

if (!Array.isArray(currentMatches) || currentMatches.length === 0) {
  errors.push("matches-current.json must contain a non-empty array.");
}

if (!Array.isArray(historyMatches)) {
  errors.push("matches-history.json must contain an array.");
}

if (!Array.isArray(matches) || matches.length === 0) {
  errors.push("combined match data must contain a non-empty array.");
}

for (const match of currentMatches) {
  if (!isMatchEligibleForCurrent(match, currentListEvaluatedAt, {
    retentionHours: currentUnsettledRetentionHours,
  })) {
    if (!currentListPolicyVersion) {
      // Pre-retention snapshots legitimately kept unresolved rows in the public
      // list. The first v1 sync migrates them to the private archive; do not
      // make that migration a prerequisite for validating the legacy snapshot.
      legacyStaleCurrentRows += 1;
    } else {
      errors.push(`${match.id}: stale unsettled match must leave current after ${currentUnsettledRetentionHours}h without being marked FINISHED.`);
    }
  }
  if (match.status === "FINISHED" && !historyMatchIds.has(match.id)) {
    errors.push(`${match.id}: same-day FINISHED current row must also remain in history.`);
  }
}

if (legacyStaleCurrentRows > 0) {
  publicationWarnings.push(
    `${legacyStaleCurrentRows} stale unsettled current rows use a pre-retention snapshot and await kickoff-retention-v1 migration.`
  );
}

if (currentListPolicyVersion && !enforcesCurrentRetention) {
  errors.push(`sync-meta currentListPolicy uses unsupported version ${currentListPolicyVersion}.`);
}

for (const match of historyMatches) {
  if (match.status !== "FINISHED") {
    errors.push(`${match.id}: history must contain settled FINISHED rows only; unresolved rows belong in the private archive.`);
  }
}

const currentIdentities = new Set(currentMatches.map(matchIdentity).filter(Boolean));
const historyIdentities = new Set(historyMatches.map(matchIdentity).filter(Boolean));
for (const match of unresolvedArchiveRows) {
  const identity = matchIdentity(match);
  if (match.status === "FINISHED") {
    errors.push(`${match.id}: unresolved archive must not retain FINISHED rows.`);
  }
  if (isMatchEligibleForCurrent(match, currentListEvaluatedAt, {
    retentionHours: currentUnsettledRetentionHours,
  })) {
    errors.push(`${match.id}: recent/future unresolved row must stay in current instead of the private archive.`);
  }
  if (identity && (currentIdentities.has(identity) || historyIdentities.has(identity))) {
    errors.push(`${match.id}: unresolved archive row overlaps a published current/history identity.`);
  }
}

if (syncMeta?.currentListPolicy?.version === "kickoff-retention-v1") {
  if (Number(syncMeta?.files?.archivedUnsettled || 0) !== unresolvedArchiveRows.length) {
    errors.push("sync-meta archivedUnsettled count must match the private unresolved archive.");
  }
  if (Number(syncMeta?.currentListPolicy?.archivedUnsettled || 0) !== unresolvedArchiveRows.length) {
    errors.push("sync-meta currentListPolicy archive count must match the private unresolved archive.");
  }
}

if (syncMeta?.fallback?.keptExisting) {
  if (syncMeta.api?.stale !== true) {
    errors.push("sync-meta fallback must set api.stale=true.");
  }
  if (!syncMeta.api?.freshnessTime) {
    errors.push("sync-meta fallback must keep api.freshnessTime for the last trusted source data.");
  }
  if (!syncMeta.lastAttemptAt) {
    errors.push("sync-meta fallback must record lastAttemptAt for the failed refresh attempt.");
  }
}

if (syncMeta?.api?.freshnessTime && !Number.isFinite(Date.parse(syncMeta.api.freshnessTime))) {
  errors.push("sync-meta api.freshnessTime must be a valid ISO timestamp.");
}

if (syncMeta?.oddsHistory?.payload) {
  errors.push("sync-meta oddsHistory must not embed the full odds history payload.");
}

if (fs.existsSync(syncMetaPath) && fs.statSync(syncMetaPath).size > 1_000_000) {
  errors.push("sync-meta.json should stay below 1MB and only expose freshness summaries.");
}

if (Array.isArray(rootMatches) && rootMatches.length > currentMatches.length + 2) {
  errors.push("root matches.json should stay lightweight and contain current matches only.");
}

for (const match of matches) {
  const oddsValues = [match.odds?.odds1, match.odds?.oddsX, match.odds?.odds2];
  const hasOfficialOdds = match.oddsSource === "sporttery:HAD";
  const handicapOddsValues = [match.handicapOdds?.odds1, match.handicapOdds?.oddsX, match.handicapOdds?.odds2];
  const hasOfficialHandicapOdds = match.handicapOddsSource === "sporttery:HHAD";
  const hasReferenceOdds = String(match.oddsSource || "").startsWith("500.com")
    || String(match.handicapOddsSource || "").startsWith("500.com");
  const hasValidOdds = oddsValues.every((value) => Number.isFinite(value) && value > 1.01);
  const hasValidHandicapOdds = handicapOddsValues.every((value) => Number.isFinite(value) && value > 1.01);
  const isResultOnly = match.status === "FINISHED" && !hasOfficialOdds;
  const isFiveHundredResult = isResultOnly && hasFiveHundredResult(match);
  const hasAcceptedResultSource = isResultOnly && hasAcceptedResultOnlySource(match);
  const isScheduleOnly = match.source === "sporttery" && match.status !== "FINISHED" && !hasOfficialOdds && !hasOfficialHandicapOdds;
  if (!hasValidOdds && !hasValidHandicapOdds && !isResultOnly && !isScheduleOnly) {
    errors.push(`${match.id}: invalid SP values ${JSON.stringify(match.odds)}`);
  }

  if (match.source === "sporttery" && !isResultOnly && !isScheduleOnly && !hasOfficialOdds && !hasOfficialHandicapOdds) {
    errors.push(`${match.id}: missing official Sporttery odds source`);
  }

  if (hasOfficialOdds && !String(match.oddsSourceUrl || "").includes("webapi.sporttery.cn")) {
    errors.push(`${match.id}: missing official Sporttery odds source URL`);
  }

  if (hasOfficialHandicapOdds && !String(match.handicapOddsSourceUrl || "").includes("webapi.sporttery.cn")) {
    errors.push(`${match.id}: missing official Sporttery handicap odds source URL`);
  }

  if (hasOfficialHandicapOdds && !String(match.handicapLine || "")) {
    errors.push(`${match.id}: missing official Sporttery handicap line`);
  }

  if (isResultOnly) {
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) {
      errors.push(`${match.id}: result-only match is missing final score`);
    }
    if (!hasAcceptedResultSource) {
      errors.push(`${match.id}: result-only match is missing official result URL`);
    }
    if (!isFiveHundredResult && (match.predictions || []).length > 0) {
      errors.push(`${match.id}: result-only match must not contain model predictions`);
    }
    if (!isFiveHundredResult && match.stats) {
      errors.push(`${match.id}: result-only match must not contain simulated model stats`);
    }
  }

  if (isScheduleOnly) {
    const hasAllowedModelOnlyReference = isModelOnlyReference(match);
    if (!hasReferenceOdds && !String(match.sourceUrl || "").includes("webapi.sporttery.cn")) {
      errors.push(`${match.id}: schedule-only match is missing official source URL`);
    }
    if ((match.predictions || []).length > 0 && !hasAllowedModelOnlyReference && !hasReferenceOdds) {
      errors.push(`${match.id}: schedule-only match must not contain model predictions`);
    }
    if (match.stats && !hasAllowedModelOnlyReference && !hasReferenceOdds) {
      errors.push(`${match.id}: schedule-only match must not contain simulated model stats`);
    }
  }

  if (Array.isArray(match.standings) && match.standings.length > 0) {
    errors.push(`${match.id}: standings are not official and must not be emitted`);
  }

  if (!hexColor.test(match.homeTeamColor || "") || !hexColor.test(match.awayTeamColor || "")) {
    errors.push(`${match.id}: invalid team color ${match.homeTeamColor}/${match.awayTeamColor}`);
  }

  if (currentMatchIds.has(match.id) && jLeagueText.test(String(match.leagueName || ""))) {
    for (const [teamName, logo, logoType] of [
      [match.homeTeamName, match.homeTeamLogo, match.homeTeamLogoType],
      [match.awayTeamName, match.awayTeamLogo, match.awayTeamLogoType],
    ]) {
      if (logoType !== "crest" || !/^(?:https?:\/\/|\/|\.\/)/.test(String(logo || ""))) {
        publicationWarnings.push(`${match.id}: J-League club logo must be a crest image (${teamName || "unknown team"}).`);
      }
    }
  }

  const sportteryPick = match.predictions?.find((prediction) => prediction.marketType === "1X2");
  if (hasOfficialOdds && match.status !== "FINISHED" && !sportteryPick) {
    publicationWarnings.push(`${match.id}: missing 1X2 prediction; publishing as awaiting analysis.`);
  } else if (hasOfficialOdds && match.status !== "FINISHED" && Math.abs(expectedPredictionSp(match, sportteryPick) - sportteryPick.odds) > 1e-9) {
    errors.push(`${match.id}: 1X2 prediction SP does not match selected SP`);
  }

  for (const prediction of match.predictions || []) {
    if (staleText.test(JSON.stringify(prediction))) {
      errors.push(`${match.id}: stale betting copy in ${prediction.marketType}`);
    }
    if (match.status === "FINISHED") {
      const expectedResult = expectedPredictionResult(match, prediction);
      if (prediction.resultStatus !== expectedResult) {
        errors.push(`${match.id}: ${prediction.marketType} resultStatus ${prediction.resultStatus} should be ${expectedResult}`);
      }
    }
  }

  const reviewHhad = match.postMatchReview?.actual?.hhad;
  if (reviewHhad) {
    const reviewLine = parseHandicapLine(reviewHhad.handicapLine);
    if (reviewLine === null) {
      const reviewVersion = String(match.postMatchReview?.version || "");
      const predictionRows = Array.isArray(match.predictions) ? match.predictions : [];
      const reviewRows = Array.isArray(match.postMatchReview?.predictionReview?.rows)
        ? match.postMatchReview.predictionReview.rows
        : [];
      const hasBoundHhadEvidence = [...predictionRows, ...reviewRows].some((row) => (
        String(row?.oddsPoolCode || row?.poolCode || "").toUpperCase() === "HHAD"
      ));
      if (reviewVersion === "post-match-review-v1" && !hasBoundHhadEvidence) {
        // v1 emitted a display-only HHAD label even when no official line or
        // prediction existed. It is not a settled HHAD sample; v2+ must omit it
        // or carry a real line.
        legacyReviewHhadWithoutLineRows += 1;
      } else {
        errors.push(`${match.id}: post-match HHAD result must include a real handicap line`);
      }
    } else if (Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)) {
      const adjustedHome = Number(match.scoreHome) + reviewLine;
      const expectedHhadCode = adjustedHome > Number(match.scoreAway)
        ? "1"
        : adjustedHome < Number(match.scoreAway)
          ? "2"
          : "X";
      if (reviewHhad.code !== expectedHhadCode) {
        errors.push(`${match.id}: post-match HHAD code ${reviewHhad.code} should be ${expectedHhadCode} at ${reviewLine}`);
      }
    }
  }
}

if (legacyReviewHhadWithoutLineRows > 0) {
  publicationWarnings.push(
    `${legacyReviewHhadWithoutLineRows} unbound post-match-review-v1 HHAD labels await schema migration and are excluded from HHAD evidence.`
  );
}

const canonicalOddsHistoryPath = !validateLegacyStaticPayloads && fs.existsSync(dataOddsHistoryPath)
  ? dataOddsHistoryPath
  : (fs.existsSync(oddsHistoryPath) ? oddsHistoryPath : dataOddsHistoryPath);

if (fs.existsSync(canonicalOddsHistoryPath)) {
  const history = readJson(canonicalOddsHistoryPath);
  const oddsHistoryV2 = Number(history?.version || 1) >= 2;
  if (oddsHistoryV2 ? history?.source !== "sporttery:HAD+HHAD" : history?.source !== "sporttery:HAD") {
    errors.push(`odds-history.json has invalid official source ${history?.source || "missing"}.`);
  }

  if (!Array.isArray(history?.rows)) {
    errors.push("odds-history.json must contain a rows array.");
  } else {
    oddsHistoryRows = history.rows;
    const rowKeys = new Set();
    const historySourceIds = new Set();

    for (const row of oddsHistoryRows) {
      const sourceMatchId = String(row?.sourceMatchId || "");
      const captureBucket = String(row?.captureBucket || "");
      const poolCode = String(row?.poolCode || row?.oddsPoolCode || "HAD").toUpperCase();
      const hasExplicitHandicapLine = row?.handicapLine !== undefined
        && row?.handicapLine !== null
        && String(row.handicapLine).trim() !== "";
      const handicapLine = Number(row?.handicapLine);
      const stateSignature = String(row?.stateSignature || "");
      const key = oddsHistoryV2 ? `${sourceMatchId}|${stateSignature}` : `${sourceMatchId}|${captureBucket}`;
      const rowOdds = [row?.odds1, row?.oddsX, row?.odds2];

      if (!sourceMatchId) errors.push("odds-history.json row is missing sourceMatchId.");
      if (!Number.isFinite(Date.parse(row?.capturedAt))) errors.push(`${sourceMatchId}: invalid capturedAt.`);
      if (!Number.isFinite(Date.parse(captureBucket))) errors.push(`${sourceMatchId}: invalid captureBucket.`);
      if (!rowOdds.every((value) => Number.isFinite(value) && value > 1.01)) {
        errors.push(`${sourceMatchId}: invalid historical SP values ${JSON.stringify(rowOdds)}`);
      }
      if (!["HAD", "HHAD"].includes(poolCode)) {
        errors.push(`${sourceMatchId}: invalid odds-history pool ${poolCode}.`);
      }
      if (poolCode === "HAD" && (!hasExplicitHandicapLine ? oddsHistoryV2 : handicapLine !== 0)) {
        errors.push(`${sourceMatchId}: HAD history row must use handicapLine 0.`);
      } else if (poolCode === "HAD" && !hasExplicitHandicapLine) {
        // In v1 the HAD pool implied a zero line. v2+ requires the field so
        // state signatures and market identities remain explicit.
        legacyHadWithoutExplicitLineRows += 1;
      }
      if (poolCode === "HHAD" && !Number.isFinite(handicapLine)) {
        errors.push(`${sourceMatchId}: HHAD history row is missing a valid handicap line.`);
      }
      if (row?.oddsSource !== `sporttery:${poolCode}`) {
        errors.push(`${sourceMatchId}: historical row is not official Sporttery ${poolCode}.`);
      }
      if (!String(row?.oddsSourceUrl || "").includes("webapi.sporttery.cn")) {
        errors.push(`${sourceMatchId}: historical row is missing official odds URL.`);
      }
      if (oddsHistoryV2 && !stateSignature.startsWith(`${poolCode}|`)) {
        errors.push(`${sourceMatchId}: invalid odds state signature ${stateSignature || "missing"}.`);
      }
      const lastSeenMs = Date.parse(row?.lastSeenAt || row?.capturedAt || "");
      const rowCutoffMs = Math.min(
        ...[Date.parse(row?.cutoffTime || ""), Date.parse(row?.kickoffTime || "")].filter(Number.isFinite)
      );
      if (oddsHistoryV2 && Number.isFinite(rowCutoffMs) && Number.isFinite(lastSeenMs) && lastSeenMs > rowCutoffMs) {
        errors.push(`${sourceMatchId}: odds state was observed after cutoff/kickoff.`);
      }
      if (rowKeys.has(key)) {
        errors.push(`${sourceMatchId}: duplicate odds-history ${oddsHistoryV2 ? "state" : `bucket ${captureBucket}`}.`);
      }

      rowKeys.add(key);
      historySourceIds.add(sourceMatchId);
    }

    for (const match of matches) {
      const cutoffMs = Date.parse(match.predictionMeta?.cutoffTime || match.buyEndTime || match.kickoffTime || "");
      if (match.source !== "sporttery" || match.status !== "SCHEDULED" || match.oddsSource !== "sporttery:HAD") continue;
      if (Number.isFinite(cutoffMs) && cutoffMs < Date.now()) continue;
      const sourceMatchId = String(match.sourceMatchId || "").replace(/^sporttery_/, "");
      if (sourceMatchId && !historySourceIds.has(sourceMatchId)) {
        errors.push(`${match.id}: missing odds-history snapshot.`);
      }
    }
  }
}

if (legacyHadWithoutExplicitLineRows > 0) {
  publicationWarnings.push(
    `${legacyHadWithoutExplicitLineRows} odds-history-v1 HAD rows use the protocol's implicit zero line and await schema migration.`
  );
}

if (validateLegacyStaticPayloads && fs.existsSync(dataOddsHistoryPath)) {
  const rootHistory = fs.existsSync(oddsHistoryPath) ? readJson(oddsHistoryPath) : null;
  const dataHistory = readJson(dataOddsHistoryPath);
  if (rootHistory && JSON.stringify(rootHistory.rows || []) !== JSON.stringify(dataHistory.rows || [])) {
    errors.push("public/data/odds-history.json must mirror public/odds-history.json rows.");
  }
}

if (fs.existsSync(distDir)) {
  for (const fileName of [
    "matches.json",
    "odds-history.json",
    "data/matches-current.json",
    "data/matches-history.json",
    "data/team-index.json",
    "data/odds-history.json",
    "data/post-match-reviews.json",
    "data/external-signals.json",
    "data/five-hundred-details.json",
    "data/pre-match-signals.json",
    "data/prediction-snapshots.json",
    "data/model-calibration.json",
    "data/model-evaluation.json",
    "data/model-strategy.json",
    "data/api-football-cache.json",
    "data/api-football-meta.json",
    "data/gpt-predictions.json",
    "data/web-consensus-signals.json",
    "data/weather-locations.json",
    "data/worldcup-kimi-dataset.json",
    "data/sync-meta.json",
  ]) {
    const publicFile = path.join(publicDir, fileName);
    const distFile = path.join(distDir, fileName);
    if (disabledLargeDistPayloads.has(fileName) && !allowLargeStaticDist) {
      if (fs.existsSync(distFile)) {
        errors.push(`dist/${fileName} must be disabled; use paginated/protected API instead.`);
      }
      continue;
    }
    if (!validateDistMirrors) continue;
    if (!fs.existsSync(publicFile) && !fs.existsSync(distFile)) continue;
    if (!fs.existsSync(publicFile) || !fs.existsSync(distFile)) {
      errors.push(`dist/${fileName} must mirror public/${fileName}.`);
      continue;
    }
    const publicText = fs.readFileSync(publicFile, "utf8");
    const distText = fs.readFileSync(distFile, "utf8");
    if (publicText !== distText) {
      errors.push(`dist/${fileName} is stale; rerun sync:data to mirror current public data.`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const statuses = matches.reduce((acc, match) => {
  acc[match.status] = (acc[match.status] || 0) + 1;
  return acc;
}, {});
const officialOddsCount = matches.filter((match) => match.oddsSource === "sporttery:HAD").length;
const officialHandicapOddsCount = matches.filter((match) => match.handicapOddsSource === "sporttery:HHAD").length;
const resultOnlyCount = matches.filter((match) => match.status === "FINISHED" && match.oddsSource !== "sporttery:HAD").length;

console.log(
  JSON.stringify(
    {
      ok: true,
      count: matches.length,
      statuses,
      officialOddsCount,
      officialHandicapOddsCount,
      resultOnlyCount,
      oddsHistoryRows: oddsHistoryRows.length,
      publicationWarnings,
      currentListPolicy: {
        evaluatedAt: currentListEvaluatedAt,
        unsettledRetentionHours: currentUnsettledRetentionHours,
        archivedUnsettled: unresolvedArchiveRows.length,
      },
    },
    null,
    2
  )
);
