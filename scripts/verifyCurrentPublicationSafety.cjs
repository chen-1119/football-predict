"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  selectCurrentPublicationRows,
  sqliteGenerationCountDivergence,
  sqliteAtomicReplacementFallbackActive,
} = require("../server/currentPublicationSafety.cjs");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const generationRows = [{ id: "today-1" }, { id: "today-2" }];
const recovered = selectCurrentPublicationRows({ sqliteRows: [], generationRows });
check(recovered.degraded === true, "empty SQLite must be degraded when its generation has fixtures");
check(recovered.rows === generationRows, "the immutable generation rows must be served during empty-SQLite divergence");
check(recovered.source === "generation-sqlite-empty-divergence", "the fallback source must stay observable");
check(recovered.blockedReason === "sqlite-current-empty-generation-nonempty", "the exact divergence reason must be exposed");
check(recovered.sqliteCount === 0 && recovered.generationCount === 2, "both sides of the count comparison must be reported");

const legitimateEmpty = selectCurrentPublicationRows({ sqliteRows: [], generationRows: [] });
check(legitimateEmpty.degraded === false, "both paired datasets empty is a legitimate empty current list");
check(legitimateEmpty.source === "sqlite", "a legitimate empty current list stays SQLite-authoritative");

const sqliteRows = [{ id: "sqlite-today" }];
const normal = selectCurrentPublicationRows({ sqliteRows, generationRows });
check(normal.degraded === false, "a non-empty paired SQLite projection must remain authoritative");
check(normal.rows === sqliteRows, "normal reads must preserve the SQLite row array");

const healthDivergence = sqliteGenerationCountDivergence({ sqliteCount: 0, generationCount: 17 });
check(healthDivergence.active === true, "health must flag zero SQLite rows against a non-empty generation");
check(healthDivergence.blockedReason === "sqlite-current-empty-generation-nonempty", "health must publish the same blocker");
check(sqliteGenerationCountDivergence({ sqliteCount: 0, generationCount: 0 }).active === false, "health must accept a genuinely empty generation");

check(sqliteAtomicReplacementFallbackActive({
  sqliteAvailable: false,
  generationAvailable: true,
  workerRunning: true,
  lastAvailableAtMs: 10_000,
  nowMs: 25_000,
  ttlMs: 30_000,
}) === true, "a recent healthy SQLite read must protect the bounded atomic replacement window");
check(sqliteAtomicReplacementFallbackActive({
  sqliteAvailable: false,
  generationAvailable: true,
  workerRunning: true,
  lastAvailableAtMs: 10_000,
  nowMs: 45_001,
  ttlMs: 30_000,
}) === false, "the atomic replacement fallback must fail closed after its TTL");
check(sqliteAtomicReplacementFallbackActive({
  sqliteAvailable: false,
  generationAvailable: true,
  workerRunning: false,
  lastAvailableAtMs: 10_000,
  nowMs: 20_000,
  ttlMs: 30_000,
}) === false, "the atomic replacement fallback must require an active sync worker");

const serverSource = fs.readFileSync(path.resolve(__dirname, "../server/index.cjs"), "utf8");
const validatorSource = fs.readFileSync(path.resolve(__dirname, "validateData.cjs"), "utf8");
check(serverSource.includes("selectCurrentPublicationRows({"), "the production current reader must use the safety selector");
check(serverSource.includes("sqliteGenerationCountDivergence({"), "public health must use the same count-divergence rule");
check(serverSource.includes("sqliteAtomicReplacementFallbackActive({"), "public health must guard the atomic SQLite replacement window");
check(serverSource.includes("generation-sqlite-empty-divergence"), "the degraded read source must remain visible in production health");
check(
  validatorSource.includes("publicationWarnings.push(`${match.id}: missing 1X2 prediction; publishing as awaiting analysis.`)"),
  "a missing derived direction must remain a publishable warning",
);
check(
  !validatorSource.includes("errors.push(`${match.id}: missing 1X2 prediction`)"),
  "a missing derived direction must not abort the whole current generation",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "current-publication-safety",
  checks,
}, null, 2));
