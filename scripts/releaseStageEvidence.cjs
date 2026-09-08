"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const VERSION = "release-stage-evidence-v1";
const LIMITS = Object.freeze({ events: 512, eventBytes: 8192, directoryEntries: 1030, inputFiles: 64,
  inputFileBytes: 64 * 1024 * 1024, requestBytes: 65536, reportAttempts: 256 });
const HASH = /^[a-f0-9]{64}$/, TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const ZERO_HASH = "0".repeat(64);
function fail(message) { throw new Error("release-stage: " + message); }
function canonical(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  fail("non-canonical value");
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }
function token(value, label) { if (typeof value !== "string" || !TOKEN.test(value)) fail("invalid " + label); return value; }
function releaseIdentity(value) {
  if (!value || !HASH.test(value.sha256) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail("invalid release identity");
  return { sha256: value.sha256, sequence: value.sequence, runId: token(value.runId, "run ID") };
}
function commitment(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.keys(value).length || Object.keys(value).length > 64) fail("input commitment required");
  for (const [name, digest] of Object.entries(value)) if (!TOKEN.test(name) || !HASH.test(digest)) fail("invalid input commitment");
  return hash(value);
}
function safeDirectory(directory, create = false) {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory) || path.parse(resolved).root === resolved) fail("dedicated absolute journal directory required");
  let created = false;
  if (create) { try { fs.mkdirSync(resolved, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; } }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail("unsafe journal directory");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail("journal must be private to its recorder UID");
  if (created) syncDirectory(path.dirname(resolved));
  return resolved;
}
function journalDirectory(storeDir, release, create = false) {
  const store = safeDirectory(storeDir, create), identity = releaseIdentity(release);
  return safeDirectory(path.join(store, identity.sha256 + "." + identity.runId), create);
}
function safeRead(file, limit) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail("unsafe or oversized evidence file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev) fail("evidence file changed during open");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail("evidence file ownership is not private");
    const buffer = Buffer.alloc(stat.size);
    let size = 0;
    while (size < buffer.length) { const read = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!read) fail("short evidence read"); size += read; }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("evidence changed during read");
    return buffer.toString("utf8");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function syncDirectory(directory) {
  if (process.platform === "win32") return; // Node cannot fsync a Windows directory; never claim power-loss durability there.
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function eventNames(directory) {
  const handle = fs.opendirSync(directory), names = []; let count = 0;
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (++count > LIMITS.directoryEntries) fail("journal directory entry limit exceeded");
      if (/^\d{6}\.json$/.test(entry.name)) { if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe journal entry"); names.push(entry.name); }
      else if (entry.name !== ".append-lock") fail("unexpected journal entry");
    }
  } finally { handle.closeSync(); }
  if (names.length > LIMITS.events) fail("journal event limit exceeded");
  return names.sort();
}
function clock() {
  const bootId = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "process-" + process.pid;
  return { at: new Date().toISOString(), monotonicMs: Number(process.hrtime.bigint() / 1000000n), domain: bootId };
}
function validateClock(value) {
  if (!value || typeof value.at !== "string" || new Date(Date.parse(value.at)).toISOString() !== value.at
    || !Number.isSafeInteger(value.monotonicMs) || value.monotonicMs < 0 || typeof value.domain !== "string" || !TOKEN.test(value.domain)) fail("invalid clock");
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("invalid PID");
  if (process.platform !== "linux") return { pid, bootId: null, startTicks: null };
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (!/^\d+$/.test(fields[19])) fail("invalid process start identity");
  return { pid, bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTicks: fields[19] };
}
function processAlive(identity) {
  if (!identity || process.platform !== "linux" || !identity.bootId || !identity.startTicks) return null;
  try {
    process.kill(identity.pid, 0);
    const current = processIdentity(identity.pid), stat = fs.readFileSync("/proc/" + identity.pid + "/stat", "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X" && canonical(current) === canonical(identity);
  } catch { return false; }
}
function reduceEvents(events, release) {
  const attempts = new Map(), latest = new Map(), eventIds = new Set();
  for (let index = 0; index < events.length; index++) {
    const e = events[index], { eventHash, ...body } = e;
    if (e.version !== VERSION || e.ordinal !== index + 1 || canonical(e.release) !== canonical(release)
      || e.previousHash !== (index ? events[index - 1].eventHash : ZERO_HASH) || eventHash !== hash(body)) fail("journal identity or hash chain invalid");
    token(e.eventId, "event ID"); token(e.phase, "phase"); token(e.attemptId, "attempt ID"); validateClock(e.clock);
    if (eventIds.has(e.eventId)) fail("duplicate event ID"); eventIds.add(e.eventId);
    if (!HASH.test(e.inputHash)) fail("invalid input hash");
    const key = e.phase + "/" + e.attemptId, previous = attempts.get(key);
    if (e.kind === "command-start" || e.kind === "checkpoint-begin") {
      if (previous) fail("attempt already exists");
      const last = latest.get(e.phase);
      if (last && !last.end) fail("previous phase attempt remains unresolved");
      if (e.attempt !== (last ? last.attempt + 1 : 1) || !["work", "wait"].includes(e.category)) fail("invalid phase attempt");
      if (e.kind === "command-start" && (!HASH.test(e.commandHash) || !e.owner || !Number.isSafeInteger(e.owner.pid) || e.owner.pid < 1)) fail("invalid command owner");
      const attempt = { phase: e.phase, attemptId: e.attemptId, attempt: e.attempt, inputHash: e.inputHash, start: e, end: null, child: null };
      attempts.set(key, attempt); latest.set(e.phase, attempt);
    } else {
      if (!previous || previous.end || e.attempt !== previous.attempt || e.inputHash !== previous.inputHash) fail("unmatched or drifted phase event");
      if (e.clock.domain === previous.start.clock.domain && e.clock.monotonicMs < previous.start.clock.monotonicMs) fail("reversed monotonic clock");
      if (e.kind === "command-child") {
        if (previous.start.kind !== "command-start" || previous.child || !e.child || !Number.isSafeInteger(e.child.pid) || e.child.pid < 1) fail("invalid child event");
        previous.child = e;
      } else if (e.kind === "command-end") {
        if (previous.start.kind !== "command-start" || canonical(e.owner) !== canonical(previous.start.owner)) fail("invalid exit recorder");
        if (!["succeeded", "failed", "timed-out", "spawn-failed", "input-drift", "input-unavailable", "cancelled"].includes(e.result)) fail("invalid command result");
        if (e.result === "succeeded" && (!previous.child || e.exitCode !== 0 || e.signal !== null || e.timedOut !== false
          || e.cancelled !== false || e.closeObserved !== true || e.observedInputHash !== e.inputHash)) fail("success lacks matching child-close evidence");
        if (e.result === "failed" && (!previous.child || e.closeObserved !== true || (e.exitCode === 0 && e.signal === null))) fail("failure lacks child-close evidence");
        if (e.result === "timed-out" && e.timedOut !== true) fail("timeout lacks timer evidence");
        if (e.result === "cancelled" && e.cancelled !== true) fail("cancel lacks signal evidence");
        if (e.result === "input-drift" && (!HASH.test(e.observedInputHash) || e.observedInputHash === e.inputHash)) fail("drift lacks changed identity");
        previous.end = e;
      } else if (e.kind === "checkpoint-end") {
        if (previous.start.kind !== "checkpoint-begin" || !["ok", "error", "unknown"].includes(e.observedOutcome)) fail("invalid observation end");
        previous.end = e;
      } else fail("unknown event kind");
    }
  }
  return { attempts: [...attempts.values()], latest };
}
function readJournal({ storeDir, release }) {
  const identity = releaseIdentity(release), directory = journalDirectory(storeDir, identity), names = eventNames(directory);
  const events = names.map((name, i) => {
    if (name !== String(i + 1).padStart(6, "0") + ".json") fail("journal sequence gap");
    return JSON.parse(safeRead(path.join(directory, name), LIMITS.eventBytes));
  });
  const state = reduceEvents(events, identity);
  if (canonical(names) !== canonical(eventNames(directory))) fail("journal changed during observation; reobserve same run");
  return { directory, identity, events, ...state };
}
function appendEvent(options, data) {
  const identity = releaseIdentity(options.release), directory = journalDirectory(options.storeDir, identity, true), lock = path.join(directory, ".append-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") fail("append busy or interrupted; inspect same journal, no automatic lock recovery"); throw error; }
  try {
    const journal = readJournal({ storeDir: options.storeDir, release: identity });
    const duplicate = journal.events.find(e => e.eventId === data.eventId);
    if (data.attempt === null) {
      const beginning = data.kind === "command-start" || data.kind === "checkpoint-begin";
      const matching = journal.attempts.find(a => a.phase === data.phase && a.attemptId === data.attemptId);
      const last = journal.latest.get(data.phase);
      if (!beginning && !matching) fail("checkpoint end has no start");
      data = { ...data, attempt: duplicate?.attempt ?? (beginning ? (last ? last.attempt + 1 : 1) : matching.attempt) };
    }
    if (duplicate) {
      const comparable = e => { const { version, release, ordinal, previousHash, eventHash, clock: eventClock, ...rest } = e; void version; void release; void ordinal; void previousHash; void eventHash; void eventClock; return rest; };
      if (canonical(comparable(duplicate)) !== canonical(comparable(data))) fail("event ID conflicts with prior evidence");
      return duplicate;
    }
    if (journal.events.length >= LIMITS.events) fail("journal full; retain evidence, do not truncate");
    const body = { ...data, clock: data.clock || clock(), version: VERSION, release: identity,
      ordinal: journal.events.length + 1, previousHash: journal.events.at(-1)?.eventHash || ZERO_HASH };
    const event = { ...body, eventHash: hash(body) };
    reduceEvents([...journal.events, event], identity);
    const payload = canonical(event) + "\n";
    if (Buffer.byteLength(payload) > LIMITS.eventBytes) fail("event too large");
    const file = path.join(directory, String(event.ordinal).padStart(6, "0") + ".json");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(directory);
    return event;
  } finally { fs.rmdirSync(lock); syncDirectory(directory); }
}
function recordCheckpoint(options) {
  const phase = token(options.phase, "phase"), attemptId = token(options.attemptId, "attempt ID");
  const kind = options.boundary === "begin" ? "checkpoint-begin" : options.boundary === "end" ? "checkpoint-end" : fail("invalid checkpoint boundary");
  const inputHash = commitment(options.inputIdentity), eventId = token(options.eventId, "event ID");
  return appendEvent(options, { eventId, phase, attemptId, attempt: null, inputHash, kind,
    ...(kind === "checkpoint-begin" ? { category: options.category || "work" } : { observedOutcome: options.observedOutcome || "unknown" }) });
}
function fingerprintFiles(inputFiles) {
  if (!Array.isArray(inputFiles) || !inputFiles.length || inputFiles.length > LIMITS.inputFiles) fail("bounded input files required");
  const result = {};
  for (const input of inputFiles) {
    token(input.name, "input label"); if (Object.hasOwn(result, input.name)) fail("duplicate input label");
    if (!path.isAbsolute(input.file)) fail("absolute input file required");
    const before = fs.lstatSync(input.file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > LIMITS.inputFileBytes) fail("unsafe or oversized input file");
    const fd = fs.openSync(input.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const start = fs.fstatSync(fd), digest = crypto.createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
      if (start.ino !== before.ino || start.dev !== before.dev || start.size !== before.size) fail("input replaced during open");
      while (offset < start.size) { const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, start.size - offset), offset); if (!read) fail("short input read"); digest.update(buffer.subarray(0, read)); offset += read; }
      const after = fs.fstatSync(fd), named = fs.lstatSync(input.file);
      if (after.size !== start.size || after.mtimeMs !== start.mtimeMs || after.ctimeMs !== start.ctimeMs || named.ino !== start.ino || named.dev !== start.dev) fail("input changed during fingerprint");
      result[input.name] = digest.digest("hex");
    } finally { fs.closeSync(fd); }
  }
  return commitment(result);
}
async function runStage(options) {
  const phase = token(options.phase, "phase"), attemptId = token(options.attemptId || crypto.randomUUID(), "attempt ID");
  if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd) || !Array.isArray(options.args) || options.args.length > 128
    || options.args.some(a => typeof a !== "string" || a.length > 8192)) fail("invalid direct command");
  const timeoutMs = options.timeoutMs ?? 1800000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 7200000) fail("bounded timeout required");
  const inputHash = fingerprintFiles(options.inputFiles), commandHash = hash({ command: fs.realpathSync(options.command), args: options.args, cwd: fs.realpathSync(options.cwd) });
  const owner = processIdentity(process.pid);
  // A new subprocess invocation never borrows an earlier invocation's event ID.
  const base = { phase, attemptId, inputHash }, start = appendEvent(options, { ...base, attempt: null,
    eventId: crypto.randomUUID(), kind: "command-start", category: options.category || "work", commandHash, owner });
  const attempt = start.attempt; base.attempt = attempt;
  let child;
  try {
    child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env || process.env,
      stdio: options.stdio || "inherit", windowsHide: true, shell: false, detached: process.platform !== "win32" });
  } catch {
    const end = appendEvent(options, { ...base, eventId: crypto.randomUUID(), kind: "command-end", owner,
      exitCode: null, signal: null, closeObserved: false, timedOut: false, cancelled: false,
      observedInputHash: null, result: "spawn-failed" });
    return { version: VERSION, phase, attemptId, attempt, result: "spawn-failed", exitCode: null,
      startEventHash: start.eventHash, endEventHash: end.eventHash, commandSucceeded: false, reusable: false, liveAcceptanceProven: false };
  }
  let timedOut = false, cancelled = false, spawnError = false, childRecorded = false, hardTimer;
  const signalChild = signal => {
    if (!child.pid) return;
    try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* close/error remains the authority */ }
  };
  const cancel = () => { cancelled = true; signalChild("SIGTERM"); hardTimer ||= setTimeout(() => signalChild("SIGKILL"), 1000); };
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const timer = setTimeout(() => { timedOut = true; signalChild("SIGTERM"); hardTimer ||= setTimeout(() => signalChild("SIGKILL"), 1000); }, timeoutMs);
  let observation;
  try {
    observation = await new Promise((resolve, reject) => {
      child.once("spawn", () => {
        try {
          // A very short-lived child can exit before /proc is read. Its actual
          // spawn/close events still exist, but it cannot yield a live-wait claim.
          let identity; try { identity = processIdentity(child.pid); } catch { identity = { pid: child.pid, bootId: null, startTicks: null }; }
          appendEvent(options, { ...base, eventId: crypto.randomUUID(), kind: "command-child", child: identity }); childRecorded = true;
        }
        catch (error) { signalChild("SIGKILL"); reject(error); }
      });
      child.once("error", () => { spawnError = true; });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal, closeObserved: true }));
    });
  } finally { clearTimeout(timer); clearTimeout(hardTimer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
  let observedInputHash = null;
  try { observedInputHash = fingerprintFiles(options.inputFiles); } catch { /* unavailable input must not become a reusable pass */ }
  const result = timedOut ? "timed-out" : cancelled ? "cancelled" : spawnError || !childRecorded ? "spawn-failed"
    : observation.exitCode !== 0 || observation.signal !== null ? "failed" : observedInputHash === null ? "input-unavailable"
      : observedInputHash !== inputHash ? "input-drift" : "succeeded";
  const end = appendEvent(options, { ...base, eventId: crypto.randomUUID(), kind: "command-end", owner,
    ...observation, timedOut, cancelled, observedInputHash, result });
  return { version: VERSION, phase, attemptId, attempt, result, exitCode: observation.exitCode, startEventHash: start.eventHash,
    endEventHash: end.eventHash, commandSucceeded: result === "succeeded", reusable: false, liveAcceptanceProven: false };
}
function reportStages(options) {
  const journal = readJournal(options), observed = clock();
  if (journal.attempts.length > LIMITS.reportAttempts) fail("report attempt limit exceeded");
  const attempts = journal.attempts.map(a => {
    const finishClock = a.end?.clock || observed, comparable = finishClock.domain === a.start.clock.domain;
    const elapsed = comparable ? finishClock.monotonicMs - a.start.clock.monotonicMs : null;
    const command = a.start.kind === "command-start", recorderAlive = !a.end && command ? processAlive(a.start.owner) : null;
    const childAlive = !a.end && a.child ? processAlive(a.child.child) : null;
    const alive = recorderAlive === true && childAlive === true;
    const state = a.end ? command ? a.end.result : "observed-closed" : !command ? "observed-open"
      : alive === true ? a.start.category === "wait" ? "waiting" : "running" : "unconfirmed-running";
    return { phase: a.phase, attemptId: a.attemptId, attempt: a.attempt, inputHash: a.inputHash,
      evidenceKind: command ? "subprocess" : "checkpoint-observation", category: a.start.category,
      state, startedAt: a.start.clock.at, finishedAt: a.end?.clock.at || null,
      elapsedMs: elapsed !== null && elapsed >= 0 ? elapsed : null, elapsedIsFinal: Boolean(a.end),
      monotonicClockComparable: comparable, wallClockConsistent: Date.parse(finishClock.at) >= Date.parse(a.start.clock.at),
      runningConfirmed: alive, recorderAlive, childAlive,
      exitCode: a.end?.exitCode ?? null, observedOutcome: a.end?.observedOutcome || null,
      commandSucceeded: command && a.end?.result === "succeeded", reusable: false };
  });
  return { version: VERSION, release: journal.identity, checkedAt: observed.at, historyHash: journal.events.at(-1)?.eventHash || ZERO_HASH,
    eventCount: journal.events.length, bytesReadUpperBound: journal.events.length * LIMITS.eventBytes,
    attempts, productionWrites: 0, liveAcceptanceProven: false, sourceValidationExecuted: false,
    reusable: false, durability: process.platform === "win32" ? "file-fsync-no-directory-fsync" : "file-and-directory-fsync",
    nextAction: "observe-same-run-or-inspect-evidence-no-auto-restart" };
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || !["run", "report", "checkpoint"].includes(argv[0]) || !path.isAbsolute(argv[1])) fail("usage: releaseStageEvidence.cjs <run|report|checkpoint> <absolute-private-request.json>");
  const request = JSON.parse(safeRead(argv[1], LIMITS.requestBytes));
  const report = argv[0] === "run" ? await runStage(request) : argv[0] === "checkpoint" ? recordCheckpoint(request) : reportStages(request);
  // Child stdout remains untouched; structured wrapper evidence goes to stderr.
  if (argv[0] === "run") { console.error(JSON.stringify(report)); process.exitCode = report.commandSucceeded ? 0 : report.result === "timed-out" ? 124 : 1; }
  else console.log(JSON.stringify(report));
}
module.exports = { VERSION, LIMITS, releaseIdentity, commitment, fingerprintFiles, recordCheckpoint, runStage, readJournal,
  reportStages, processIdentity, processAlive, reduceEvents, canonical, hash, safeRead, safeDirectory, syncDirectory, main };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ version: VERSION, observationOk: false, error: error.message,
  reusable: false, liveAcceptanceProven: false, nextAction: "inspect-same-run-no-auto-restart" })); process.exitCode = 1; });
