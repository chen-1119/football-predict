"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ENTRY_SCRIPTS,
  evaluateReleaseEnrichmentReuseRequest,
  inspectReleaseEnrichmentReuseRequestEnvelope,
  inspectReleaseWorkerPriorityRequest,
  prepareReleaseEnrichmentReuseRequest,
  prepareReleaseWorkerPriorityRequest,
} = require("./releaseEnrichmentReuse.cjs");

const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const writeJson = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const writeText = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
};

const fixture = (root, now) => {
  const oldRoot = path.join(root, "old");
  const newRoot = path.join(root, "new");
  const storeDir = path.join(root, "store");
  const bundleSha256 = "a".repeat(64);
  for (const releaseRoot of [oldRoot, newRoot]) {
    writeJson(path.join(releaseRoot, "package-lock.json"), {
      name: "release-reuse-fixture",
      lockfileVersion: 3,
      packages: {},
    });
    writeText(path.join(releaseRoot, "scripts", "shared.cjs"), "module.exports = { version: 1 };\n");
    for (const entry of ENTRY_SCRIPTS) {
      writeText(path.join(releaseRoot, entry), 'require("./shared.cjs");\n');
    }
    writeJson(path.join(releaseRoot, "public", "data", "matches-current.json"), [
      {
        id: "sporttery_1001",
        sourceMatchId: "1001",
        kickoffTime: "2026-07-27T12:00:00.000Z",
        homeTeamName: "Home",
        awayTeamName: "Away",
        status: "SCHEDULED",
      },
    ]);
    for (const name of [
      "external-signals.json",
      "five-hundred-details.json",
      "api-football-cache.json",
      "api-football-meta.json",
      "weather-locations.json",
      "pre-match-signals.json",
      "web-consensus-signals.json",
    ]) {
      writeJson(path.join(releaseRoot, "public", "data", name), {
        version: 1,
        source: name,
        updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      });
    }
  }
  writeText(path.join(newRoot, ".release-bundle-sha256"), `${bundleSha256}\n`);
  writeJson(path.join(storeDir, "weather-locations.json"), { locations: [] });
  writeJson(path.join(storeDir, "web-consensus", "open-research-insights.json"), { insights: [] });
  writeJson(path.join(storeDir, "training", "raw", "football-data", "fixtures", "status.json"), {
    checkedAt: new Date(now.getTime() - 60_000).toISOString(),
  });
  writeJson(path.join(storeDir, "entity-resolution", "team-registry.json"), { teams: {} });
  const startedAt = new Date(now.getTime() - 180_000).toISOString();
  const finishedAt = new Date(now.getTime() - 120_000).toISOString();
  writeJson(path.join(storeDir, "sync-worker-status.json"), {
    ok: true,
    cycleState: "sleeping",
    phase: "sleeping",
    lastCycle: {
      ok: true,
      startedAt,
      finishedAt,
      durationMs: 60_000,
      officialPhase: {
        ok: true,
        phase: "official-result-published",
        startedAt,
        finishedAt,
      },
      readinessSourceCycleObservation: {
        ready: true,
        samePublicationIdentity: true,
        blockers: [],
        public: { sourceCycleId: "cycle-1" },
        generation: {
          sourceCycleId: "cycle-1",
          generationId: "generation-1",
          manifestHash: "b".repeat(64),
        },
      },
    },
  });
  return {
    oldRoot,
    newRoot,
    storeDir,
    bundleSha256,
    requestPath: path.join(storeDir, "release-enrichment-reuse-request.json"),
  };
};

const withFixture = (now, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-reuse-"));
  try {
    return callback(fixture(root, now), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const main = () => {
  const now = new Date("2026-07-27T00:00:00.000Z");

  withFixture(now, (paths) => {
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    check("unchanged pipeline and fresh completed cycle are eligible", prepared.eligible, {
      blockers: prepared.blockers,
    });
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("prepared request is approved for the matching signed release", evaluated.approved, {
      blockers: evaluated.blockers,
    });
    const envelope = inspectReleaseEnrichmentReuseRequestEnvelope({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("a valid hash-bound request exposes a cheap release-cycle priority envelope",
      envelope.pending === true
        && envelope.blockers.length === 0
        && envelope.evidence.bundleSha256 === paths.bundleSha256,
      { blockers: envelope.blockers, evidence: envelope.evidence });
    check(
      "request binds validators generation sqlite model and formal gate",
      prepared.request?.policy?.validatorsStillRequired === true
        && prepared.request?.policy?.generationStillRequired === true
        && prepared.request?.policy?.sqliteStillRequired === true
        && prepared.request?.policy?.modelReconciliationStillRequired === true
        && prepared.request?.policy?.formalRecommendationGateUnchanged === true,
      { policy: prepared.request?.policy || null }
    );
  });

  withFixture(now, (paths) => {
    const priorityPath = path.join(paths.storeDir, "release-worker-priority-request.json");
    const prepared = prepareReleaseWorkerPriorityRequest({
      rootDir: paths.newRoot,
      bundleSha256: paths.bundleSha256,
      releaseSequence: "379",
      outputPath: priorityPath,
      now,
    });
    const inspected = inspectReleaseWorkerPriorityRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: priorityPath,
      now,
    });
    check("a signed release gets priority independently from enrichment reuse eligibility",
      prepared.ok === true
        && inspected.pending === true
        && inspected.evidence.releaseSequence === "379"
        && inspected.evidence.policy?.officialResultGateUnchanged === true
        && inspected.evidence.policy?.fastResultCannotSatisfyRelease === true,
      { blockers: inspected.blockers, evidence: inspected.evidence });
    const tampered = JSON.parse(fs.readFileSync(priorityPath, "utf8"));
    tampered.releaseSequence = "380";
    writeJson(priorityPath, tampered);
    const rejected = inspectReleaseWorkerPriorityRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: priorityPath,
      now,
    });
    check("a tampered release-priority marker cannot accelerate the worker",
      rejected.pending === false
        && rejected.blockers.includes("priority-request-hash-invalid"), {
      blockers: rejected.blockers,
    });
  });

  withFixture(now, (paths) => {
    const statusPath = path.join(paths.storeDir, "sync-worker-status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    status.lastCompleteCycle = status.lastCycle;
    status.lastCycle = {
      ok: true,
      skipped: true,
      reason: "sync-lock-busy",
      startedAt: new Date(now.getTime() - 10_000).toISOString(),
      finishedAt: new Date(now.getTime() - 9_990).toISOString(),
      durationMs: 10,
    };
    writeJson(statusPath, status);
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    check("a skipped heartbeat cannot erase the latest complete publication evidence", prepared.eligible
      && prepared.evidence?.priorCycle?.cycleEvidenceSource === "last-complete-cycle", {
      blockers: prepared.blockers,
      priorCycle: prepared.evidence?.priorCycle || null,
    });
  });

  withFixture(now, (paths) => {
    writeText(path.join(paths.newRoot, "scripts", "shared.cjs"), "module.exports = { version: 2 };\n");
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    check("transitive collector code change disables reuse", !prepared.eligible
      && prepared.blockers.includes("enrichment-code-changed"), {
      blockers: prepared.blockers,
    });
  });

  withFixture(now, (paths) => {
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    writeJson(path.join(paths.newRoot, "public", "data", "external-signals.json"), { tampered: true });
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("artifact mutation after request fails closed", prepared.eligible
      && !evaluated.approved
      && evaluated.blockers.includes("reuse-artifact-hash-mismatch"), {
      blockers: evaluated.blockers,
    });
  });

  withFixture(now, (paths) => {
    prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    const matchesPath = path.join(paths.newRoot, "public", "data", "matches-current.json");
    const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
    matches.push({
      id: "sporttery_1002",
      sourceMatchId: "1002",
      kickoffTime: "2026-07-27T14:00:00.000Z",
      homeTeamName: "New Home",
      awayTeamName: "New Away",
    });
    writeJson(matchesPath, matches);
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("changed match set invalidates reuse", !evaluated.approved
      && evaluated.blockers.includes("reuse-artifact-hash-mismatch"), {
      blockers: evaluated.blockers,
    });
  });

  withFixture(now, (paths) => {
    prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now: new Date(now.getTime() + 31 * 60 * 1000),
    });
    check("expired one-cycle request is rejected", !evaluated.approved
      && evaluated.blockers.includes("reuse-request-expired"), {
      blockers: evaluated.blockers,
    });
  });

  withFixture(now, (paths) => {
    prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    const request = JSON.parse(fs.readFileSync(paths.requestPath, "utf8"));
    request.policy.validatorsStillRequired = false;
    writeJson(paths.requestPath, request);
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("request tampering is rejected", !evaluated.approved
      && evaluated.blockers.includes("reuse-request-hash-invalid"), {
      blockers: evaluated.blockers,
    });
    const envelope = inspectReleaseEnrichmentReuseRequestEnvelope({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("a tampered request cannot receive release-cycle priority",
      envelope.pending === false
        && envelope.blockers.includes("reuse-request-hash-invalid"), {
      blockers: envelope.blockers,
    });
  });

  withFixture(now, (paths) => {
    const statusPath = path.join(paths.storeDir, "sync-worker-status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    status.lastCycle.finishedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    status.lastCycle.startedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000 - 60_000).toISOString();
    writeJson(statusPath, status);
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
      maxAgeSeconds: 90 * 60,
    });
    check("stale prior cycle cannot authorize reuse", !prepared.eligible
      && prepared.blockers.includes("prior-cycle-too-old"), {
      blockers: prepared.blockers,
    });
  });

  withFixture(now, (paths) => {
    const statusPath = path.join(paths.storeDir, "sync-worker-status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    status.lastCycle.readinessSourceCycleObservation.ready = false;
    status.lastCycle.readinessSourceCycleObservation.blockers = ["sqlite-not-ready"];
    writeJson(statusPath, status);
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    check("prior readiness blockers disable reuse", !prepared.eligible
      && prepared.blockers.includes("prior-publication-identity-not-ready")
      && prepared.blockers.includes("prior-readiness-has-blockers"), {
      blockers: prepared.blockers,
    });
  });

  withFixture(now, (paths) => {
    prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    writeText(path.join(paths.newRoot, ".release-bundle-sha256"), `${"c".repeat(64)}\n`);
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("live bundle identity mismatch rejects reuse", !evaluated.approved
      && evaluated.blockers.includes("reuse-bundle-identity-mismatch"), {
      blockers: evaluated.blockers,
    });
  });

  withFixture(now, (paths) => {
    const evaluated = evaluateReleaseEnrichmentReuseRequest({
      rootDir: paths.newRoot,
      storeDir: paths.storeDir,
      requestPath: paths.requestPath,
      now,
    });
    check("missing request fails closed without pipeline work", !evaluated.approved
      && evaluated.blockers.includes("reuse-request-missing")
      && evaluated.evidence.pipelineHash === null, {
      blockers: evaluated.blockers,
    });
  });

  withFixture(now, (paths) => {
    for (const name of [
      "external-signals.json",
      "five-hundred-details.json",
      "api-football-cache.json",
      "api-football-meta.json",
      "weather-locations.json",
      "pre-match-signals.json",
    ]) {
      fs.rmSync(path.join(paths.newRoot, "public", "data", name), { force: true });
    }
    const prepared = prepareReleaseEnrichmentReuseRequest({
      ...paths,
      outputPath: paths.requestPath,
      now,
    });
    check("insufficient preserved artifacts disable reuse", !prepared.eligible
      && prepared.blockers.includes("enrichment-artifacts-insufficient"), {
      blockers: prepared.blockers,
    });
  });

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    verifier: "release-enrichment-reuse",
    version: "release-enrichment-reuse-v1",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
};

main();
