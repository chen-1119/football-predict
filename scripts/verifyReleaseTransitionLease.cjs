"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

const withCliFixture = (callback) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-transition-probe-"));
  try {
    const current = path.join(temporaryRoot, "matches-current.json");
    fs.writeFileSync(current, JSON.stringify(fixture()));
    const run = (mode, extra = [], at = "2026-08-01T13:00:00.000Z") => spawnSync(
      process.execPath,
      [path.join(__dirname, "releaseTransitionLease.cjs"), mode,
        "--current", current, "--at", at,
        "--verifier-runtime-max-seconds", "900",
        "--preverify-refresh-budget-seconds", "6690",
        "--atomic-swap-margin-seconds", "30", ...extra],
      { encoding: "utf8", timeout: 10_000 },
    );
    callback({ temporaryRoot, current, run });
  } finally {
    // This directory was created exclusively by this fixture, never supplied
    // by an operator or derived from a live release/store path.
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

check("CLI probe uses the exact create budget without writing a lease or changing its input", () => {
  withCliFixture(({ temporaryRoot, current, run }) => {
    const before = fs.readFileSync(current);
    const beforeStat = fs.statSync(current);
    const result = run("probe");
    assert.equal(result.status, 0, result.stderr);
    const { ok, mode, ...actual } = JSON.parse(result.stdout);
    assert.equal(ok, true);
    assert.equal(mode, "probe");
    assert.deepEqual(actual, createTransitionLease(fixture(), {
      refreshAt: "2026-08-01T13:00:00.000Z",
      verifierRuntimeMaxSeconds: 900,
      preverifyRefreshBudgetSeconds: 6690,
      atomicSwapMarginSeconds: 30,
    }));
    assert.equal(actual.minimumHorizonSeconds, 7620);
    assert.deepEqual(fs.readdirSync(temporaryRoot), ["matches-current.json"]);
    assert.deepEqual(fs.readFileSync(current), before);
    assert.equal(fs.statSync(current).mtimeMs, beforeStat.mtimeMs);
  });
});

check("CLI probe refuses an output path and cannot overwrite an existing lease", () => {
  withCliFixture(({ temporaryRoot, run }) => {
    const existing = path.join(temporaryRoot, "existing-lease.json");
    fs.writeFileSync(existing, "preserve-this-existing-lease");
    const result = run("probe", ["--lease", existing]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /read-only probe does not accept --lease/);
    assert.equal(fs.readFileSync(existing, "utf8"), "preserve-this-existing-lease");
    assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), ["existing-lease.json", "matches-current.json"]);
  });
});

check("early probe runs before npm install using only built-in and signed local modules", () => {
  withCliFixture(({ temporaryRoot, current }) => {
    const bootstrap = `
      const Module = require("node:module");
      const path = require("node:path");
      const originalLoad = Module._load;
      Module._load = function (id, ...args) {
        if (!Module.isBuiltin(id) && !id.startsWith(".") && !path.isAbsolute(id)) {
          throw new Error("preinstall external dependency: " + id);
        }
        return originalLoad.call(this, id, ...args);
      };
      require(${JSON.stringify(path.join(__dirname, "releaseTransitionLease.cjs"))}).main(process.argv.slice(1));
    `;
    const result = spawnSync(process.execPath, ["-e", bootstrap, "probe",
      "--current", current, "--at", "2026-08-01T13:00:00.000Z",
      "--verifier-runtime-max-seconds", "900",
      "--preverify-refresh-budget-seconds", "6690",
      "--atomic-swap-margin-seconds", "30"], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).minimumHorizonSeconds, 7620);
    assert.deepEqual(fs.readdirSync(temporaryRoot), ["matches-current.json"]);
  });
});

check("CLI probe fails closed for a short window and returns the unchanged budget diagnostics", () => {
  withCliFixture(({ temporaryRoot, run }) => {
    const result = run("probe", [], refreshAt);
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.match(failure.error, /horizon is too short/);
    assert.equal(failure.details.minimumHorizonSeconds, 7620);
    assert.ok(failure.details.nextSafeWindow?.refreshStrictlyAfter);
    assert.deepEqual(fs.readdirSync(temporaryRoot), ["matches-current.json"]);
  });
});

check("CLI probe rejects malformed clocks without producing output files", () => {
  withCliFixture(({ temporaryRoot, current, run }) => {
    const rows = fixture();
    rows[0].predictionMeta.cutoffTime = "not-a-clock";
    fs.writeFileSync(current, JSON.stringify(rows));
    const result = run("probe");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid transition clock/);
    assert.deepEqual(fs.readdirSync(temporaryRoot), ["matches-current.json"]);
  });
});

check("CLI probe accepts a directory-linked current file but retains single-link file validation", () => {
  withCliFixture(({ temporaryRoot, current, run }) => {
    const linkedDirectory = path.join(temporaryRoot, "generation-link");
    const generationDirectory = path.join(temporaryRoot, "generation");
    fs.mkdirSync(generationDirectory);
    const generationCurrent = path.join(generationDirectory, "matches-current.json");
    fs.writeFileSync(generationCurrent, fs.readFileSync(current));
    fs.symlinkSync(generationDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    const linkedCurrent = path.join(linkedDirectory, "matches-current.json");
    const accepted = run("probe", ["--current", linkedCurrent]);
    assert.equal(accepted.status, 0, accepted.stderr);
    fs.linkSync(generationCurrent, path.join(generationDirectory, "hard-link.json"));
    const rejected = run("probe", ["--current", linkedCurrent]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /single-link regular file/);
  });
});

check("a successful CLI probe cannot authorize a changed schedule or replace the final lease CAS", () => {
  withCliFixture(({ temporaryRoot, current, run }) => {
    assert.equal(run("probe").status, 0);
    const leasePath = path.join(temporaryRoot, "final-lease.json");
    const created = run("create", ["--lease", leasePath]);
    assert.equal(created.status, 0, created.stderr);
    const rows = fixture();
    rows[0].predictionMeta.cutoffTime = "2026-08-01T13:20:00.000Z";
    fs.writeFileSync(current, JSON.stringify(rows));
    const rechecked = run("create", ["--lease", path.join(temporaryRoot, "changed-lease.json")]);
    assert.equal(rechecked.status, 1);
    assert.match(rechecked.stderr, /horizon is too short/);
    assert.equal(fs.existsSync(path.join(temporaryRoot, "changed-lease.json")), false);
    const verified = run("verify", ["--lease", leasePath], "2026-08-01T13:01:00.000Z");
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /data changed after lease creation/);
  });
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
