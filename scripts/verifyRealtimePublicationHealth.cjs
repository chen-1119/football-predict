"use strict";

const assert = require("node:assert/strict");
const { buildRealtimePublicationHealth } = require("./writeRealtimePublicationHealth.cjs");

const now = Date.parse("2026-09-16T12:00:00.000Z");
const matches = [{ businessDate: "2026-09-16" }, { businessDate: "2026-09-16" }];

const live = buildRealtimePublicationHealth({
  nowMs: now,
  matches,
  projectionCompletedAt: "2026-09-16T11:55:00.000Z",
  syncMeta: { api: { currentFreshnessTime: "2026-09-16T11:56:00.000Z" } },
});
assert.equal(live.status, "live");
assert.equal(live.source.fresh, true);
assert.equal(live.publication.fresh, true);
assert.equal(live.current.count, 2);

const delayed = buildRealtimePublicationHealth({
  nowMs: now,
  matches,
  projectionCompletedAt: "2026-09-16T11:20:00.000Z",
  syncMeta: { api: { currentFreshnessTime: "2026-09-16T11:58:00.000Z" } },
});
assert.equal(delayed.status, "publication-delayed");
assert.equal(delayed.source.fresh, true);
assert.equal(delayed.publication.fresh, false);

const stale = buildRealtimePublicationHealth({
  nowMs: now,
  matches,
  projectionCompletedAt: "2026-09-16T11:58:00.000Z",
  syncMeta: { api: { currentFreshnessTime: "2026-09-16T10:30:00.000Z" } },
});
assert.equal(stale.status, "source-stale");
assert.equal(stale.source.fresh, false);
assert.equal(stale.publication.fresh, true);

process.stdout.write(`${JSON.stringify({ ok: true, tests: 11 }, null, 2)}\n`);
