"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_BUNDLED_ARTIFACT,
  buildFootballDataDisciplineIndex,
} = require("./footballDataDiscipline.cjs");

const outputFile = path.resolve(process.env.FOOTBALL_DATA_DISCIPLINE_ARTIFACT || DEFAULT_BUNDLED_ARTIFACT);
const index = buildFootballDataDisciplineIndex({ bundledArtifactFile: path.join(__dirname, "__artifact-build-disabled__.json") });
if (index.files.length < 10 || index.accepted < 1000) {
  throw new Error("refusing to build discipline artifact from incomplete raw source data");
}

const artifact = {
  version: "football-data-discipline-artifact-v1",
  source: "football-data.co.uk-match-statistics",
  sourceUrl: "https://www.football-data.co.uk/data.php",
  asOfPolicy: "date-only-strictly-before-forecast-date",
  files: index.files,
  sourceRows: index.rows,
  acceptedRows: index.accepted,
  teams: Object.fromEntries(index.teams),
  referees: Object.fromEntries(index.referees),
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
const temporaryFile = `${outputFile}.tmp-${process.pid}`;
fs.writeFileSync(temporaryFile, `${JSON.stringify(artifact)}\n`, "utf8");
fs.renameSync(temporaryFile, outputFile);
console.log(JSON.stringify({
  ok: true,
  output: path.relative(path.join(__dirname, ".."), outputFile).replace(/\\/g, "/"),
  files: artifact.files.length,
  sourceRows: artifact.sourceRows,
  acceptedRows: artifact.acceptedRows,
  teams: Object.keys(artifact.teams).length,
  referees: Object.keys(artifact.referees).length,
  bytes: fs.statSync(outputFile).size,
}, null, 2));
