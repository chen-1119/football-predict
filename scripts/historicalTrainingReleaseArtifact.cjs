"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const HISTORICAL_TRAINING_RELEASE_ENTRY = ".release-model-assets/historical-training-index.json";
const HISTORICAL_TRAINING_VERSION = "historical-training-v1";
const MIN_TRAINING_ROWS = 100_000;
const MIN_TRAINING_TEAMS = 500;
const MIN_FINITE_ELO_TEAMS = 400;
const MIN_SAFE_ELO = 800;
const MAX_SAFE_ELO = 2400;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const nonBlank = (value) => typeof value === "string" && value.trim().length > 0;

const inspectHistoricalTrainingObject = (value) => {
  const teams = value?.teams && typeof value.teams === "object" && !Array.isArray(value.teams)
    ? value.teams
    : {};
  const teamRows = Object.entries(teams);
  const finiteRatings = [];
  let invalidRatingFields = 0;
  let explicitNullRatings = 0;

  for (const [, team] of teamRows) {
    const raw = team?.latestElo;
    if (raw === null || raw === undefined || raw === "") {
      explicitNullRatings += 1;
      continue;
    }
    const rating = Number(raw);
    if (!Number.isFinite(rating)) {
      invalidRatingFields += 1;
      continue;
    }
    finiteRatings.push(rating);
  }

  finiteRatings.sort((a, b) => a - b);
  const rows = Number(value?.sample?.rows);
  const declaredTeams = Number(value?.sample?.teams);
  const firstMatchDate = value?.sample?.firstMatchDate || null;
  const lastMatchDate = value?.sample?.lastMatchDate || null;
  const minElo = finiteRatings.length ? finiteRatings[0] : null;
  const maxElo = finiteRatings.length ? finiteRatings.at(-1) : null;
  const blockers = [
    ...(value?.version !== HISTORICAL_TRAINING_VERSION ? ["version-mismatch"] : []),
    ...(!nonBlank(value?.source?.name) ? ["source-name-missing"] : []),
    ...(!Number.isInteger(rows) || rows < MIN_TRAINING_ROWS ? ["training-rows-insufficient"] : []),
    ...(!Number.isInteger(declaredTeams) || declaredTeams !== teamRows.length
      ? ["training-team-count-mismatch"]
      : []),
    ...(teamRows.length < MIN_TRAINING_TEAMS ? ["training-teams-insufficient"] : []),
    ...(finiteRatings.length < MIN_FINITE_ELO_TEAMS ? ["finite-elo-coverage-insufficient"] : []),
    ...(invalidRatingFields > 0 ? ["invalid-elo-fields"] : []),
    ...(minElo === null || minElo < MIN_SAFE_ELO ? ["elo-minimum-unsafe"] : []),
    ...(maxElo === null || maxElo > MAX_SAFE_ELO ? ["elo-maximum-unsafe"] : []),
    ...(!nonBlank(firstMatchDate) || !Number.isFinite(Date.parse(`${firstMatchDate}T00:00:00.000Z`))
      ? ["first-match-date-invalid"]
      : []),
    ...(!nonBlank(lastMatchDate) || !Number.isFinite(Date.parse(`${lastMatchDate}T00:00:00.000Z`))
      ? ["last-match-date-invalid"]
      : []),
  ];

  return {
    ok: blockers.length === 0,
    version: value?.version || null,
    source: value?.source?.name || null,
    generatedAt: value?.generatedAt || null,
    rows: Number.isInteger(rows) ? rows : null,
    teams: teamRows.length,
    declaredTeams: Number.isInteger(declaredTeams) ? declaredTeams : null,
    finiteEloTeams: finiteRatings.length,
    explicitNullRatings,
    invalidRatingFields,
    minElo,
    maxElo,
    firstMatchDate,
    lastMatchDate,
    blockers,
  };
};

const inspectHistoricalTrainingBuffer = (buffer) => {
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (!Buffer.isBuffer(buffer) || bytes === 0 || bytes > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      bytes,
      sha256: Buffer.isBuffer(buffer) ? sha256(buffer) : null,
      blockers: ["artifact-size-invalid"],
    };
  }

  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    const inspection = inspectHistoricalTrainingObject(parsed);
    return {
      ...inspection,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      bytes,
      sha256: sha256(buffer),
    };
  } catch (error) {
    return {
      ok: false,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      bytes,
      sha256: sha256(buffer),
      blockers: ["artifact-json-invalid"],
      error: error.message || String(error),
    };
  }
};

const inspectHistoricalTrainingFile = (filePath) => {
  try {
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      return {
        ok: false,
        entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
        filePath,
        blockers: ["artifact-file-unsafe"],
      };
    }
    return {
      ...inspectHistoricalTrainingBuffer(fs.readFileSync(filePath)),
      filePath,
    };
  } catch (error) {
    return {
      ok: false,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      filePath,
      blockers: ["artifact-file-unavailable"],
      error: error.message || String(error),
    };
  }
};

module.exports = {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  HISTORICAL_TRAINING_VERSION,
  MAX_ARTIFACT_BYTES,
  inspectHistoricalTrainingBuffer,
  inspectHistoricalTrainingFile,
  inspectHistoricalTrainingObject,
};
