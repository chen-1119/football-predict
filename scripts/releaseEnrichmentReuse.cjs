"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUEST_VERSION = "release-enrichment-reuse-v1";
const PRIORITY_REQUEST_VERSION = "release-worker-priority-v1";
const DEFAULT_MAX_AGE_SECONDS = 90 * 60;
const ENTRY_SCRIPTS = Object.freeze([
  "scripts/sync500Data.cjs",
  "scripts/sync500Details.cjs",
  "scripts/syncWeatherData.cjs",
  "scripts/footballDataFixturesSnapshot.cjs",
  "scripts/syncApiFootballData.cjs",
  "scripts/syncOpenResearchSignals.cjs",
  "scripts/syncWebConsensusSignals.cjs",
  "scripts/syncPreMatchSignals.cjs",
]);
const ROOT_ARTIFACTS = Object.freeze([
  "public/data/external-signals.json",
  "public/data/five-hundred-details.json",
  "public/data/api-football-cache.json",
  "public/data/api-football-meta.json",
  "public/data/weather-locations.json",
  "public/data/pre-match-signals.json",
  "public/data/web-consensus-signals.json",
]);
const STORE_ARTIFACTS = Object.freeze([
  "weather-locations.json",
  "web-consensus/open-research-insights.json",
  "training/raw/football-data/fixtures/status.json",
  "entity-resolution/team-registry.json",
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalValue(value[key]);
    return result;
  }, {});
};

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const canonicalHash = (value) => sha256(Buffer.from(canonicalJson(value), "utf8"));

const normalizeRelative = (value) => String(value || "").split(path.sep).join("/");
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const fileDigest = (root, relativePath) => {
  const absolute = path.resolve(root, relativePath);
  if (!inside(path.resolve(root), absolute)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  if (!fs.existsSync(absolute)) {
    return {
      path: normalizeRelative(relativePath),
      present: false,
      bytes: 0,
      sha256: null,
    };
  }
  const info = fs.lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`unsafe regular file: ${relativePath}`);
  }
  const bytes = fs.readFileSync(absolute);
  return {
    path: normalizeRelative(relativePath),
    present: true,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
};

const resolveLocalDependency = (root, importer, specifier) => {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  if (!inside(root, base)) throw new Error(`dependency escapes root: ${specifier}`);
  const candidates = path.extname(base)
    ? [base]
    : [
        base,
        `${base}.cjs`,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.json`,
        path.join(base, "index.cjs"),
        path.join(base, "index.js"),
      ];
  return candidates.find((candidate) => {
    try {
      const info = fs.lstatSync(candidate);
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
    } catch {
      return false;
    }
  }) || null;
};

const localDependencySpecifiers = (source) => {
  const found = new Set();
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+["']([^"']+)["']/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]?.startsWith(".")) found.add(match[1]);
    }
  }
  return [...found];
};

const dependencyClosure = (rootInput, entryScripts = ENTRY_SCRIPTS) => {
  const root = path.resolve(rootInput);
  const pending = entryScripts.map((entry) => path.resolve(root, entry));
  const visited = new Set();
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    if (!inside(root, current)) throw new Error(`dependency is outside release root: ${current}`);
    const info = fs.lstatSync(current);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`unsafe pipeline dependency: ${normalizeRelative(path.relative(root, current))}`);
    }
    visited.add(current);
    const bytes = fs.readFileSync(current);
    const relative = normalizeRelative(path.relative(root, current));
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    if (!/\.(?:cjs|mjs|js)$/i.test(current)) continue;
    const source = bytes.toString("utf8");
    for (const specifier of localDependencySpecifiers(source)) {
      const resolved = resolveLocalDependency(root, current, specifier);
      if (!resolved) {
        throw new Error(`unresolved local pipeline dependency: ${relative} -> ${specifier}`);
      }
      pending.push(resolved);
    }
  }
  const lock = fileDigest(root, "package-lock.json");
  files.push(lock);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: "release-enrichment-pipeline-v1",
    entries: [...entryScripts],
    files,
    snapshotHash: canonicalHash(files),
  };
};

const matchIdentitySnapshot = (rootInput) => {
  const root = path.resolve(rootInput);
  const filePath = path.join(root, "public", "data", "matches-current.json");
  const matches = readJson(filePath, []);
  const rows = (Array.isArray(matches) ? matches : []).map((match) => ({
    id: String(match?.sourceMatchId || match?.id || "").trim() || null,
    kickoffTime: match?.kickoffTime || null,
    home: match?.homeTeamName || match?.homeTeam || null,
    away: match?.awayTeamName || match?.awayTeam || null,
  })).filter((row) => row.id || (row.home && row.away && row.kickoffTime));
  rows.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    count: rows.length,
    hash: canonicalHash(rows),
  };
};

const artifactSnapshot = (rootInput, storeInput) => {
  const root = path.resolve(rootInput);
  const storeDir = path.resolve(storeInput);
  const files = [
    ...ROOT_ARTIFACTS.map((relative) => ({
      scope: "release",
      ...fileDigest(root, relative),
    })),
    ...STORE_ARTIFACTS.map((relative) => ({
      scope: "store",
      ...fileDigest(storeDir, relative),
    })),
  ].sort((left, right) => `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`));
  const matchSet = matchIdentitySnapshot(root);
  return {
    version: "release-enrichment-artifacts-v1",
    files,
    presentFiles: files.filter((file) => file.present).length,
    presentRootFiles: files.filter((file) => file.scope === "release" && file.present).length,
    matchSet,
    snapshotHash: canonicalHash({ files, matchSet }),
  };
};

const validatePriorCycle = (status, nowMs, maxAgeSeconds) => {
  const blockers = [];
  const lastCycle = status?.lastCompleteCycle && typeof status.lastCompleteCycle === "object"
    ? status.lastCompleteCycle
    : status?.lastCycle && typeof status.lastCycle === "object"
      ? status.lastCycle
      : null;
  const cycleEvidenceSource = status?.lastCompleteCycle && typeof status.lastCompleteCycle === "object"
    ? "last-complete-cycle"
    : "last-cycle";
  const finishedMs = Date.parse(lastCycle?.finishedAt || "");
  const startedMs = Date.parse(lastCycle?.startedAt || "");
  const readiness = lastCycle?.readinessSourceCycleObservation;
  const official = lastCycle?.officialPhase;
  if (!lastCycle) blockers.push("prior-cycle-missing");
  if (lastCycle?.ok !== true || lastCycle?.skipped === true) blockers.push("prior-cycle-not-complete");
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    blockers.push("prior-cycle-clock-invalid");
  }
  if (Number.isFinite(finishedMs) && nowMs - finishedMs > maxAgeSeconds * 1000) {
    blockers.push("prior-cycle-too-old");
  }
  if (Number.isFinite(finishedMs) && finishedMs > nowMs + 30_000) {
    blockers.push("prior-cycle-from-future");
  }
  if (official?.ok !== true || official?.phase !== "official-result-published") {
    blockers.push("prior-official-publication-not-ready");
  }
  if (readiness?.ready !== true || readiness?.samePublicationIdentity !== true) {
    blockers.push("prior-publication-identity-not-ready");
  }
  if (Array.isArray(readiness?.blockers) && readiness.blockers.length > 0) {
    blockers.push("prior-readiness-has-blockers");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    evidence: lastCycle
      ? {
          startedAt: lastCycle.startedAt || null,
          finishedAt: lastCycle.finishedAt || null,
          durationMs: lastCycle.durationMs ?? null,
          degraded: lastCycle.degraded === true,
          sourceCycleId:
            readiness?.generation?.sourceCycleId
            || readiness?.public?.sourceCycleId
            || null,
          generationId: readiness?.generation?.generationId || null,
          manifestHash: readiness?.generation?.manifestHash || null,
          lastCycleHash: canonicalHash(lastCycle),
          cycleEvidenceSource,
        }
      : null,
  };
};

const safeAtomicWrite = (targetInput, payload) => {
  const target = path.resolve(targetInput);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const parentInfo = fs.lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error(`unsafe request parent: ${parent}`);
  }
  if (fs.existsSync(target)) {
    const existing = fs.lstatSync(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error(`unsafe existing request: ${target}`);
    }
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o640,
  });
  fs.chmodSync(temporary, 0o640);
  fs.renameSync(temporary, target);
};

const prepareReleaseEnrichmentReuseRequest = ({
  oldRoot,
  newRoot,
  storeDir,
  bundleSha256,
  outputPath,
  now = new Date(),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
} = {}) => {
  const evaluatedAt = now instanceof Date ? now : new Date(now);
  const nowMs = evaluatedAt.getTime();
  const boundedMaxAge = Math.max(300, Math.min(6 * 60 * 60, Number(maxAgeSeconds) || DEFAULT_MAX_AGE_SECONDS));
  const blockers = [];
  if (!/^[0-9a-f]{64}$/.test(String(bundleSha256 || ""))) blockers.push("bundle-sha-invalid");
  if (!Number.isFinite(nowMs)) blockers.push("request-clock-invalid");

  let oldPipeline = null;
  let newPipeline = null;
  let artifacts = null;
  let prior = null;
  try {
    oldPipeline = dependencyClosure(oldRoot);
    newPipeline = dependencyClosure(newRoot);
    if (oldPipeline.snapshotHash !== newPipeline.snapshotHash) blockers.push("enrichment-code-changed");
  } catch (error) {
    blockers.push(`pipeline-snapshot-failed:${error.message || error}`);
  }
  try {
    artifacts = artifactSnapshot(newRoot, storeDir);
    if (artifacts.presentRootFiles < 3) blockers.push("enrichment-artifacts-insufficient");
    if (artifacts.matchSet.count < 1) blockers.push("current-match-set-empty");
  } catch (error) {
    blockers.push(`artifact-snapshot-failed:${error.message || error}`);
  }
  try {
    const status = readJson(path.join(path.resolve(storeDir), "sync-worker-status.json"), null);
    prior = validatePriorCycle(status, nowMs, boundedMaxAge);
    blockers.push(...prior.blockers);
  } catch (error) {
    blockers.push(`prior-cycle-validation-failed:${error.message || error}`);
  }

  const eligible = blockers.length === 0;
  const requestedAt = Number.isFinite(nowMs) ? evaluatedAt.toISOString() : null;
  const body = {
    version: REQUEST_VERSION,
    requestedAt,
    expiresAt: Number.isFinite(nowMs)
      ? new Date(nowMs + Math.min(boundedMaxAge * 1000, 30 * 60 * 1000)).toISOString()
      : null,
    bundleSha256: String(bundleSha256 || ""),
    maxPriorCycleAgeSeconds: boundedMaxAge,
    pipeline: newPipeline,
    artifacts,
    priorCycle: prior?.evidence || null,
    policy: {
      scope: "one-signed-release-worker-cycle",
      effect: "reuse-network-enrichment-only",
      validatorsStillRequired: true,
      generationStillRequired: true,
      sqliteStillRequired: true,
      modelReconciliationStillRequired: true,
      formalRecommendationGateUnchanged: true,
    },
  };
  const request = {
    ...body,
    requestHash: canonicalHash(body),
  };
  if (eligible && outputPath) safeAtomicWrite(outputPath, request);
  return {
    ok: true,
    eligible,
    blockers,
    request: eligible ? request : null,
    evidence: {
      oldPipelineHash: oldPipeline?.snapshotHash || null,
      newPipelineHash: newPipeline?.snapshotHash || null,
      artifactSnapshotHash: artifacts?.snapshotHash || null,
      matchSet: artifacts?.matchSet || null,
      priorCycle: prior?.evidence || null,
    },
  };
};

const inspectReleaseEnrichmentReuseRequestEnvelope = ({
  rootDir,
  storeDir,
  requestPath = path.join(path.resolve(storeDir), "release-enrichment-reuse-request.json"),
  now = new Date(),
} = {}) => {
  const root = path.resolve(rootDir);
  const checkedAt = now instanceof Date ? now : new Date(now);
  const nowMs = checkedAt.getTime();
  const blockers = [];
  let request = null;
  try {
    const info = fs.lstatSync(requestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      blockers.push("reuse-request-unsafe");
    } else {
      request = readJson(requestPath, null);
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        blockers.push("reuse-request-invalid");
      }
    }
  } catch {
    blockers.push("reuse-request-missing");
  }

  if (request) {
    if (request.version !== REQUEST_VERSION) blockers.push("reuse-request-version-invalid");
    if (!Number.isFinite(nowMs)) blockers.push("reuse-check-clock-invalid");
    const expiresMs = Date.parse(request.expiresAt || "");
    if (!Number.isFinite(expiresMs) || expiresMs < nowMs) blockers.push("reuse-request-expired");
    const requestBody = { ...request };
    delete requestBody.requestHash;
    if (!request.requestHash || canonicalHash(requestBody) !== request.requestHash) {
      blockers.push("reuse-request-hash-invalid");
    }
    const liveBundle = (() => {
      try {
        return fs.readFileSync(path.join(root, ".release-bundle-sha256"), "utf8").trim();
      } catch {
        return null;
      }
    })();
    if (!liveBundle || liveBundle !== request.bundleSha256) {
      blockers.push("reuse-bundle-identity-mismatch");
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    pending: Boolean(request) && uniqueBlockers.length === 0,
    checkedAt: Number.isFinite(nowMs) ? checkedAt.toISOString() : null,
    blockers: uniqueBlockers,
    request,
    evidence: {
      requestHash: request?.requestHash || null,
      bundleSha256: request?.bundleSha256 || null,
      priorCycle: request?.priorCycle || null,
      expiresAt: request?.expiresAt || null,
      policy: request?.policy || null,
    },
  };
};

const prepareReleaseWorkerPriorityRequest = ({
  rootDir,
  bundleSha256,
  releaseSequence,
  outputPath,
  now = new Date(),
  ttlSeconds = 30 * 60,
} = {}) => {
  const root = path.resolve(rootDir);
  const requestedAt = now instanceof Date ? now : new Date(now);
  const nowMs = requestedAt.getTime();
  const sequence = String(releaseSequence || "").trim();
  const boundedTtlSeconds = Math.max(60, Math.min(60 * 60, Number(ttlSeconds) || 30 * 60));
  if (!Number.isFinite(nowMs)) throw new Error("priority request clock is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(bundleSha256 || ""))) {
    throw new Error("priority request bundle SHA is invalid");
  }
  if (!/^[1-9][0-9]{0,15}$/.test(sequence) || Number(sequence) > Number.MAX_SAFE_INTEGER) {
    throw new Error("priority request release sequence is invalid");
  }
  const liveBundle = fs.readFileSync(path.join(root, ".release-bundle-sha256"), "utf8").trim();
  if (liveBundle !== bundleSha256) throw new Error("priority request live bundle identity differs");
  const body = {
    version: PRIORITY_REQUEST_VERSION,
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(nowMs + boundedTtlSeconds * 1000).toISOString(),
    bundleSha256,
    releaseSequence: sequence,
    policy: {
      scope: "one-signed-release-worker-cycle",
      effect: "bounded-initial-lock-wait-and-single-loop-retry",
      officialResultGateUnchanged: true,
      fastResultCannotSatisfyRelease: true,
      concurrentCycleForbidden: true,
    },
  };
  const request = { ...body, requestHash: canonicalHash(body) };
  safeAtomicWrite(outputPath, request);
  return { ok: true, request };
};

const inspectReleaseWorkerPriorityRequest = ({
  rootDir,
  storeDir,
  requestPath = path.join(path.resolve(storeDir), "release-worker-priority-request.json"),
  now = new Date(),
} = {}) => {
  const root = path.resolve(rootDir);
  const checkedAt = now instanceof Date ? now : new Date(now);
  const nowMs = checkedAt.getTime();
  const blockers = [];
  let request = null;
  try {
    const info = fs.lstatSync(requestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      blockers.push("priority-request-unsafe");
    } else {
      request = readJson(requestPath, null);
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        blockers.push("priority-request-invalid");
      }
    }
  } catch {
    blockers.push("priority-request-missing");
  }
  if (request) {
    if (request.version !== PRIORITY_REQUEST_VERSION) blockers.push("priority-request-version-invalid");
    if (!Number.isFinite(nowMs)) blockers.push("priority-request-clock-invalid");
    const expiresMs = Date.parse(request.expiresAt || "");
    if (!Number.isFinite(expiresMs) || expiresMs < nowMs) blockers.push("priority-request-expired");
    if (!/^[1-9][0-9]{0,15}$/.test(String(request.releaseSequence || ""))) {
      blockers.push("priority-request-sequence-invalid");
    }
    const requestBody = { ...request };
    delete requestBody.requestHash;
    if (!request.requestHash || canonicalHash(requestBody) !== request.requestHash) {
      blockers.push("priority-request-hash-invalid");
    }
    let liveBundle = null;
    try {
      liveBundle = fs.readFileSync(path.join(root, ".release-bundle-sha256"), "utf8").trim();
    } catch {
      // Report the same bundle mismatch used for a stale marker after rollback.
    }
    if (!liveBundle || liveBundle !== request.bundleSha256) {
      blockers.push("priority-request-bundle-identity-mismatch");
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    pending: Boolean(request) && uniqueBlockers.length === 0,
    checkedAt: Number.isFinite(nowMs) ? checkedAt.toISOString() : null,
    blockers: uniqueBlockers,
    evidence: {
      requestHash: request?.requestHash || null,
      bundleSha256: request?.bundleSha256 || null,
      releaseSequence: request?.releaseSequence || null,
      expiresAt: request?.expiresAt || null,
      policy: request?.policy || null,
    },
  };
};

const evaluateReleaseEnrichmentReuseRequest = ({
  rootDir,
  storeDir,
  requestPath = path.join(path.resolve(storeDir), "release-enrichment-reuse-request.json"),
  now = new Date(),
} = {}) => {
  const root = path.resolve(rootDir);
  const store = path.resolve(storeDir);
  const envelope = inspectReleaseEnrichmentReuseRequestEnvelope({
    rootDir: root,
    storeDir: store,
    requestPath,
    now,
  });
  const nowMs = Date.parse(envelope.checkedAt || "");
  const blockers = [...envelope.blockers];
  const request = envelope.request;
  if (!request || blockers.length > 0) {
    return {
      approved: false,
      checkedAt: envelope.checkedAt,
      blockers: [...new Set(blockers)],
      evidence: {
        requestHash: envelope.evidence.requestHash,
        bundleSha256: envelope.evidence.bundleSha256,
        pipelineHash: null,
        artifactSnapshotHash: null,
        matchSet: null,
        priorCycle: envelope.evidence.priorCycle,
        expiresAt: envelope.evidence.expiresAt,
        policy: envelope.evidence.policy,
      },
    };
  }

  let pipeline = null;
  let artifacts = null;
  try {
    pipeline = dependencyClosure(root);
    if (pipeline.snapshotHash !== request?.pipeline?.snapshotHash) blockers.push("reuse-pipeline-hash-mismatch");
  } catch (error) {
    blockers.push(`reuse-pipeline-check-failed:${error.message || error}`);
  }
  try {
    artifacts = artifactSnapshot(root, store);
    if (artifacts.snapshotHash !== request?.artifacts?.snapshotHash) blockers.push("reuse-artifact-hash-mismatch");
  } catch (error) {
    blockers.push(`reuse-artifact-check-failed:${error.message || error}`);
  }

  return {
    approved: blockers.length === 0,
    checkedAt: envelope.checkedAt,
    blockers: [...new Set(blockers)],
    evidence: {
      requestHash: request?.requestHash || null,
      bundleSha256: request?.bundleSha256 || null,
      pipelineHash: pipeline?.snapshotHash || null,
      artifactSnapshotHash: artifacts?.snapshotHash || null,
      matchSet: artifacts?.matchSet || null,
      priorCycle: request?.priorCycle || null,
      expiresAt: request?.expiresAt || null,
      policy: request?.policy || null,
    },
  };
};

const parseCli = (argv) => {
  const result = { command: argv[0] || "" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = argv[index + 1];
    index += 1;
  }
  return result;
};

const main = () => {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "prepare") {
    const result = prepareReleaseEnrichmentReuseRequest({
      oldRoot: cli.oldRoot,
      newRoot: cli.newRoot,
      storeDir: cli.storeDir,
      bundleSha256: cli.bundleSha,
      outputPath: cli.output,
      maxAgeSeconds: cli.maxAgeSeconds,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (cli.command === "evaluate") {
    const result = evaluateReleaseEnrichmentReuseRequest({
      rootDir: cli.root,
      storeDir: cli.storeDir,
      requestPath: cli.request,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.approved) process.exitCode = 2;
    return;
  }
  if (cli.command === "prepare-priority") {
    const result = prepareReleaseWorkerPriorityRequest({
      rootDir: cli.root,
      bundleSha256: cli.bundleSha,
      releaseSequence: cli.releaseSequence,
      outputPath: cli.output,
      ttlSeconds: cli.ttlSeconds,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("usage: releaseEnrichmentReuse.cjs prepare|evaluate|prepare-priority [options]");
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MAX_AGE_SECONDS,
  ENTRY_SCRIPTS,
  PRIORITY_REQUEST_VERSION,
  REQUEST_VERSION,
  artifactSnapshot,
  canonicalHash,
  dependencyClosure,
  evaluateReleaseEnrichmentReuseRequest,
  inspectReleaseEnrichmentReuseRequestEnvelope,
  inspectReleaseWorkerPriorityRequest,
  matchIdentitySnapshot,
  prepareReleaseEnrichmentReuseRequest,
  prepareReleaseWorkerPriorityRequest,
  validatePriorCycle,
};
