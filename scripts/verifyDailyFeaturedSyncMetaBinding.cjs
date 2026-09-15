"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { publishDailyFeaturedToSyncMeta } = require("./publishDailyFeaturedToSyncMeta.cjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-featured-meta-"));
try {
  const meta = {
    updatedAt: "2026-09-16T12:00:00.000Z",
    files: { current: 12, history: 25 },
    api: { currentFreshnessTime: "2026-09-16T11:59:00.000Z" },
  };
  const featured = {
    version: "daily-featured-combos-v1",
    generatedAt: "2026-09-16T12:01:00.000Z",
    today: {
      businessDate: "2026-09-16",
      state: "published",
      twoLeg: { type: "2x1", status: "published", combinedSp: 2.72, legs: [] },
      threeLeg: { type: "3x1", status: "published", combinedSp: 5.31, legs: [] },
    },
    stats: {},
  };
  fs.writeFileSync(path.join(tempDir, "sync-meta.json"), JSON.stringify(meta), "utf8");
  fs.writeFileSync(path.join(tempDir, "daily-featured-combos.json"), JSON.stringify(featured), "utf8");

  const binding = publishDailyFeaturedToSyncMeta({
    dataDir: tempDir,
    now: "2026-09-16T12:02:00.000Z",
  });
  const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "sync-meta.json"), "utf8"));

  assert.deepEqual(stored.files, meta.files, "existing sync-meta fields must be preserved");
  assert.deepEqual(stored.api, meta.api, "source freshness metadata must be preserved");
  assert.deepEqual(stored.dailyFeaturedCombos, featured, "featured payload must be generation-bound without rewriting");
  assert.equal(binding.businessDate, "2026-09-16");
  assert.equal(binding.state, "published");
  assert.equal(binding.featuredGeneratedAt, featured.generatedAt);
  assert.equal(stored.dailyFeaturedCombosPublication.version, "daily-featured-sync-meta-binding-v1");
  assert.equal(stored.dailyFeaturedCombosPublication.boundAt, "2026-09-16T12:02:00.000Z");

  fs.rmSync(path.join(tempDir, "daily-featured-combos.json"));
  assert.throws(
    () => publishDailyFeaturedToSyncMeta({ dataDir: tempDir }),
    /requires daily-featured-combos\.json/,
    "missing featured payload must fail closed",
  );

  process.stdout.write(`${JSON.stringify({ ok: true, tests: 8 }, null, 2)}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
