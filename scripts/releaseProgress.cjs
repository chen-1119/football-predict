"use strict";
const { buildFrontendIdentityReaderSource } = require("../server/frontendReleaseIdentity.cjs");

// Intentionally self-contained for a read-only pinned-SSH observation.
function evaluateReleaseProgress(observation) {
  const { sha, checkedAt, status, statusStable, processes, markers, recoveryPending } = observation;
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("invalid release SHA");
  const now = Date.parse(checkedAt), start = Date.parse(status?.startedAt || ""), end = Date.parse(status?.finishedAt || "");
  if (!Number.isFinite(now)) throw new Error("invalid observation clock");
  const clocksValid = Number.isFinite(start) && start <= now && Number.isFinite(end) && end >= start && end <= now;
  const identityValid = status?.bundleSha256 === sha;
  const frontend = observation.frontendRelease;
  const isFrontendOnly = status?.releaseKind === "frontend-only";
  const releaseKindKnown = status?.releaseKind === undefined || status.releaseKind === "full" || isFrontendOnly;
  const frontendAccepted = isFrontendOnly && /^[1-9][0-9]*$/.test(status.releaseSequence || "")
    && Number.isSafeInteger(Number(status.releaseSequence)) && frontend?.available === true && frontend.consistent === true
    && frontend.phase === "accepted" && frontend.kind === "frontend-only" && frontend.frontendSha256 === sha
    && frontend.frontendSequence === Number(status.releaseSequence)
    && /^[a-f0-9]{64}$/.test(frontend.acceptanceSha256 || "")
    && markers.app === frontend.runtimeSha256 && markers.liveComplete === frontend.runtimeSha256;
  const markerProof = isFrontendOnly ? frontendAccepted : releaseKindKnown && markers.app === sha && markers.liveComplete === sha;
  const runningConfirmed = statusStable === true && identityValid && status?.status === "running"
    && processes.some(p => Number.isSafeInteger(p.pid) && p.pid > 0 && p.alive === true);
  const transactionComplete = statusStable === true && identityValid && clocksValid && status?.status === "complete"
    && status.ok === "1" && status.exitCode === "0" && markerProof && recoveryPending === false;
  let state = "unknown";
  if (!status) state = "not-found";
  else if (!statusStable) state = "observation-changed";
  else if (!identityValid) state = "identity-conflict";
  else if (transactionComplete) state = "transaction-complete";
  else if (status.status === "failed") state = "failed";
  else if (status.status === "complete") state = "terminal-incomplete";
  else if (status.status === "running") state = runningConfirmed ? "running" : "unconfirmed-running";

  // Only emit fixed stage names and safe script basenames, never raw log lines,
  // command arguments, stdout payloads, credentials or recommendation evidence.
  const stages = [
    ["build candidate inside disposable", "candidate-build"],
    ["assemble brand-new final tree", "candidate-assembly"],
    ["wait for this release worker to publish", "official-publication-wait"],
    ["wait for this release worker cycle to finish", "enrichment-wait"],
    ["swap release", "cutover"],
    ["apply PostgreSQL schema migrations", "postgres-projection"],
    ["activated CAS-verified prebuilt live SQLite", "sqlite-activated"],
  ];
  let phase = null, lastCheck = null, lastDatabaseStage = null;
  let lastBuildStep = null;
  for (const line of String(observation.logTail || "").split(/\r?\n/)) {
    const build = /^\[football-bundle-release\] step-(start|end) kind=(build|refresh) label=([a-z][a-z0-9-]{0,79})(?: status=(-?\d+) elapsedSeconds=(\d+))?$/.exec(line);
    if (build) {
      lastBuildStep = { event: build[1], kind: build[2], name: build[3], status: build[4] === undefined ? null : Number(build[4]),
        elapsedSeconds: build[5] === undefined ? null : Number(build[5]) };
      phase = build[2] === "build" ? "candidate-build" : "candidate-refresh";
    }
    const child = /^\[production-readiness\] child-(start|end|timeout) scripts\/([A-Za-z0-9_-]+\.cjs)(?:\s|$)/.exec(line);
    if (child) {
      lastCheck = { name: child[2], event: child[1], elapsedMs: null, status: null };
      const elapsed = /\belapsedMs=(\d+)\b/.exec(line), code = /\bstatus=(-?\d+)\b/.exec(line);
      if (elapsed) lastCheck.elapsedMs = Number(elapsed[1]);
      if (code) lastCheck.status = Number(code[1]);
      phase = "readiness";
    }
    const database = /^\[release-live-sqlite-prebuild\] stage=([a-z][a-z0-9_-]{0,63}) event=(start|finish)\b/.exec(line);
    if (database) {
      const elapsed = /\belapsedSeconds=(\d+)\b/.exec(line);
      lastDatabaseStage = { name: database[1], event: database[2], elapsedSeconds: elapsed ? Number(elapsed[1]) : null };
      phase = "sqlite-prebuild";
    }
    if (line.startsWith("[football-bundle-release] ")) {
      const message = line.slice("[football-bundle-release] ".length);
      for (const [prefix, name] of stages) if (message.startsWith(prefix)) phase = name;
    }
  }
  return {
    version: "release-progress-observation-v1", observationOk: true, checkedAt, sha, state,
    runningConfirmed, transactionComplete,
    elapsedSeconds: Number.isFinite(start) && start <= now ? Math.floor(((clocksValid ? end : now) - start) / 1000) : null,
    phase, lastCheck, lastDatabaseStage, ...(lastBuildStep ? { lastBuildStep } : {}), logBytesRead: observation.logBytesRead, logTotalBytes: observation.logTotalBytes,
    statusStable, processes, markers, recoveryPending, services: observation.services,
    ...(isFrontendOnly ? { releaseKind: "frontend-only", frontendRelease: frontend || null } : {}),
    productionWrites: 0, sourceValidationExecuted: false, liveAcceptanceProven: transactionComplete && frontendAccepted,
    nextAction: state === "running" ? "observe-existing-process" : transactionComplete ? (frontendAccepted ? "accepted-frontend-no-business-revalidation" : "run-live-acceptance")
      : ["not-found", "unconfirmed-running", "observation-changed"].includes(state) ? "inspect-or-reobserve-no-auto-restart" : "inspect-evidence-no-auto-restart",
  };
}

function collectReleaseProgress(sha, readFrontendIdentity = null) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("invalid release SHA");
  const fs = require("node:fs"), { execFileSync } = require("node:child_process");
  function read(file, limit, tail = false, rootOwned = false) {
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (!tail && stat.size > limit)) throw new Error("unsafe progress file");
      if (rootOwned && (stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022))) throw new Error("unsafe root status proof");
      const size = Math.min(stat.size, limit), offset = Math.max(0, stat.size - size), buffer = Buffer.alloc(size);
      const count = fs.readSync(fd, buffer, 0, size, offset);
      let text = buffer.subarray(0, count).toString("utf8");
      if (offset > 0) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
      return { text, bytesRead: count, totalBytes: stat.size };
    } finally { fs.closeSync(fd); }
  }
  const statusPath = "/var/lib/football-release/status/" + sha + ".status";
  const before = read(statusPath, 4096, false, true);
  const status = before ? Object.fromEntries(before.text.trim().split("\n").map(line => {
    const i = line.indexOf("="); if (i < 1) throw new Error("malformed status"); return [line.slice(0, i), line.slice(i + 1)];
  })) : null;
  const log = read("/var/lib/football-release/logs/" + sha + ".log", 65536, true);
  const markers = { app: read("/opt/football-predict/.release-bundle-sha256", 128)?.text.trim() || null,
    liveComplete: read("/opt/football-predict/.release-live-complete", 128)?.text.trim() || null };
  const recoveryPending = fs.existsSync("/var/lib/football-release/recovery/current");
  let frontendRelease = null;
  if (status?.releaseKind === "frontend-only" && readFrontendIdentity) {
    try { frontendRelease = readFrontendIdentity(); } catch { /* UI proof unavailable, never fallback to full markers. */ }
  }
  const processes = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = fs.readFileSync("/proc/" + name + "/cmdline", "utf8").split("\0").filter(Boolean);
      if (!args.includes(sha) || !args.some(arg => /(?:^|\/)football-release$/.test(arg))) continue;
      const pid = Number(name); process.kill(pid, 0); processes.push({ pid, alive: true });
    } catch { /* proc entry can disappear during read; never infer a restart */ }
  }
  const unitText = execFileSync("systemctl", ["show", "football-predict.service", "football-sync-worker.service",
    "--property=Id,ActiveState,MainPID", "--no-pager"], { encoding: "utf8", timeout: 5000 });
  const services = unitText.trim().split(/\n\s*\n/).map(block => Object.fromEntries(block.split("\n").filter(Boolean)
    .map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; })));
  const after = read(statusPath, 4096, false, true);
  return { sha, checkedAt: new Date().toISOString(), status, statusStable: before?.text === after?.text,
    processes, markers, recoveryPending, services, frontendRelease, logTail: log?.text || "",
    logBytesRead: log?.bytesRead || 0, logTotalBytes: log?.totalBytes || 0 };
}

function buildReadOnlyProgressProbe(sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("invalid release SHA");
  return "'use strict';\n" + evaluateReleaseProgress.toString() + "\n" + collectReleaseProgress.toString()
    + "\nconsole.log(JSON.stringify(evaluateReleaseProgress(collectReleaseProgress(" + JSON.stringify(sha)
    + ",()=>" + buildFrontendIdentityReaderSource() + ".readFrontendReleaseIdentity()))));\n";
}

module.exports = { evaluateReleaseProgress, collectReleaseProgress, buildReadOnlyProgressProbe };
