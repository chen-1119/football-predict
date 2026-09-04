"use strict";

const assert = require("node:assert/strict");
const {
  TRANSITION_TYPES,
  createTransitionLease,
  transitionProjection,
  verifyTransitionLease,
} = require("./releaseTransitionLease.cjs");

const checks = [];
const check = (name, callback) => {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error });
  }
};

const refreshAt = "2026-08-01T15:00:00.000Z";
const fixture = () => ([
  {
    id: "sporttery_1001",
    sourceMatchId: "1001",
    status: "SCHEDULED",
    kickoffTime: "2026-08-02T00:30:00+08:00",
    predictionMeta: { cutoffTime: "2026-08-01T16:10:00.000Z" },
    buyEndTime: "2026-08-02 00:15:00",
  },
  {
    id: "sporttery_1002",
    sourceMatchId: "1002",
    status: "EXCLUDED",
    kickoffTime: "2026-08-01T16:40:00.000Z",
    predictionMeta: { cutoffTime: "2026-08-02T00:30:00+08:00" },
    cutoffTime: "2026-08-01T16:35:00.000Z",
  },
]);

check("mixed timezone clocks are epoch ordered and same epochs retain every transition type", () => {
  const projection = transitionProjection(fixture(), refreshAt);
  assert.ok(projection.transitions.length > 0);
  assert.deepEqual(
    projection.transitions.map((row) => row.epochMs),
    [...projection.transitions.map((row) => row.epochMs)].sort((left, right) => left - right),
  );
  const shared = projection.transitions.find((row) => row.at === "2026-08-01T16:10:00.000Z");
  assert.ok(shared);
  assert.ok(shared.types.includes(TRANSITION_TYPES.decision));
  assert.ok(shared.types.includes(TRANSITION_TYPES.live));
});

check("excluded matches still retain their kickoff archive transition", () => {
  const projection = transitionProjection(fixture(), refreshAt);
  const kickoff = projection.transitions.find((row) => (
    row.events.some((event) => (
      event.type === TRANSITION_TYPES.kickoff && event.matchIds.includes("1002")
    ))
  ));
  assert.equal(kickoff?.at, "2026-08-01T16:40:00.000Z");
});

check("decision finalization is included as its own conservative transition", () => {
  const projection = transitionProjection(fixture(), refreshAt);
  assert.ok(projection.transitions.some((row) => (
    row.types.includes(TRANSITION_TYPES.finalization) && row.matchIds.includes("1001")
  )));
});

check("invalid candidate clocks fail closed", () => {
  const invalid = fixture();
  invalid[0].predictionMeta.cutoffTime = "not-a-clock";
  assert.throws(
    () => transitionProjection(invalid, refreshAt),
    /invalid transition clock/,
  );
});

check("lease creation refuses a horizon shorter than refresh plus verifier plus swap budget", () => {
  assert.throws(
    () => createTransitionLease(fixture(), {
      refreshAt,
      verifierRuntimeMaxSeconds: 5000,
      preverifyRefreshBudgetSeconds: 60,
      atomicSwapMarginSeconds: 30,
    }),
    (error) => {
      assert.match(error.message, /horizon is too short/);
      assert.ok(error.details.upcomingTransitionCount > 0);
      assert.ok(error.details.upcomingTransitions.length > 0);
      assert.ok(error.details.nextSafeWindow?.refreshStrictlyAfter);
      return true;
    },
  );
});

check("lease verification accepts archive-only mutations because transition data is unchanged", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 5,
  });
  const archived = structuredClone(rows);
  archived[0].archivedPreMatchPrediction = { version: "archived-pre-match-prediction-v1" };
  const verified = verifyTransitionLease(archived, lease, {
    verifiedAt: "2026-08-01T15:20:00.000Z",
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.dataDigest, lease.dataDigest);
  assert.equal(verified.sourceClockChanged, false);
});

check("lease verification records source clock representation drift without rejecting unchanged semantics", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 5,
  });
  const reformatted = structuredClone(rows);
  reformatted[0].kickoffTime = "2026-08-01T16:30:00.000Z";
  reformatted[0].buyEndTime = "2026-08-01T16:15:00.000Z";
  const projection = transitionProjection(reformatted, refreshAt);
  assert.equal(projection.dataDigest, lease.dataDigest);
  assert.equal(projection.transitionDigest, lease.transitionDigest);
  assert.notEqual(projection.sourceClockDigest, lease.sourceClockDigest);
  const verified = verifyTransitionLease(reformatted, lease, {
    verifiedAt: "2026-08-01T15:20:00.000Z",
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.sourceClockChanged, true);
});

check("lease verification accepts expired-row inventory churn outside the leased future transition set", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 5,
  });
  const withExpiredRow = structuredClone(rows);
  withExpiredRow.push({
    id: "sporttery_expired",
    sourceMatchId: "expired",
    status: "FINISHED",
    kickoffTime: "2026-08-01T14:00:00.000Z",
    predictionMeta: { cutoffTime: "2026-08-01T13:50:00.000Z" },
    buyEndTime: "2026-08-01T13:55:00.000Z",
  });
  const projection = transitionProjection(withExpiredRow, refreshAt);
  assert.equal(projection.dataDigest, lease.dataDigest);
  assert.equal(projection.transitionDigest, lease.transitionDigest);
  assert.notEqual(projection.inventoryDigest, lease.inventoryDigest);
  assert.equal(projection.activeMatches, lease.activeMatches);
  assert.equal(projection.matches, lease.matches + 1);
  const verified = verifyTransitionLease(withExpiredRow, lease, {
    verifiedAt: "2026-08-01T15:20:00.000Z",
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.inventoryChanged, true);
  assert.equal(verified.matchesChanged, true);
});

check("lease verification rejects upcoming-row additions and removals", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 5,
  });
  const removed = rows.slice(0, 1);
  assert.throws(
    () => verifyTransitionLease(removed, lease, { verifiedAt: "2026-08-01T15:20:00.000Z" }),
    /data changed/,
  );
  const added = structuredClone(rows);
  added.push({
    id: "sporttery_1003",
    sourceMatchId: "1003",
    status: "SCHEDULED",
    kickoffTime: "2026-08-01T18:00:00.000Z",
    predictionMeta: { cutoffTime: "2026-08-01T17:50:00.000Z" },
    buyEndTime: "2026-08-01T17:55:00.000Z",
  });
  assert.throws(
    () => verifyTransitionLease(added, lease, { verifiedAt: "2026-08-01T15:20:00.000Z" }),
    /data changed/,
  );
});

check("transition projection rejects duplicate match identities before digest set folding", () => {
  const rows = fixture();
  rows.push(structuredClone(rows[0]));
  assert.throws(
    () => transitionProjection(rows, refreshAt),
    /duplicate match identity/,
  );
});

check("lease verification rejects schedule drift, crossed transitions and lost swap margin", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 30,
  });
  const changed = structuredClone(rows);
  changed[0].predictionMeta.cutoffTime = "2026-08-01T16:09:00.000Z";
  assert.throws(
    () => verifyTransitionLease(changed, lease, { verifiedAt: "2026-08-01T15:10:00.000Z" }),
    /data changed/,
  );
  assert.throws(
    () => verifyTransitionLease(rows, lease, { verifiedAt: "2026-08-01T16:09:45.000Z" }),
    /lacks required transition margin/,
  );
  assert.throws(
    () => verifyTransitionLease(rows, lease, { verifiedAt: "2026-08-01T16:10:00.000Z" }),
    /was crossed/,
  );
});

check("lease verification rejects a changed match identity even when the row count is unchanged", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 30,
  });
  const changed = structuredClone(rows);
  changed[0].sourceMatchId = "replacement-1001";
  assert.throws(
    () => verifyTransitionLease(changed, lease, { verifiedAt: "2026-08-01T15:10:00.000Z" }),
    /data changed/,
  );
});

check("post-swap waits can reserve a larger rollback margin without weakening the lease", () => {
  const rows = fixture();
  const lease = createTransitionLease(rows, {
    refreshAt,
    verifierRuntimeMaxSeconds: 30,
    preverifyRefreshBudgetSeconds: 10,
    atomicSwapMarginSeconds: 30,
  });
  const safe = verifyTransitionLease(rows, lease, {
    verifiedAt: "2026-08-01T16:04:00.000Z",
    requiredMarginSeconds: 300,
  });
  assert.equal(safe.requiredMarginSeconds, 300);
  assert.throws(
    () => verifyTransitionLease(rows, lease, {
      verifiedAt: "2026-08-01T16:06:00.001Z",
      requiredMarginSeconds: 300,
    }),
    /lacks required transition margin/,
  );
});

for (const result of checks) {
  if (result.ok) console.log(`PASS ${result.name}`);
  else {
    console.error(`FAIL ${result.name}`);
    console.error(result.error?.stack || result.error);
  }
}

const failed = checks.filter((result) => !result.ok);
if (failed.length) {
  console.error(`release transition lease verification failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`release transition lease verification passed: ${checks.length}/${checks.length}`);
