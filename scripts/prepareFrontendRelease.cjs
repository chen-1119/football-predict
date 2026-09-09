"use strict";

const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { spawnSync } = require("node:child_process");
const signing = require("./releaseSigning.cjs");
const { buildPinnedSshBaseOptions } = require("./releaseSshHostKeyPin.cjs");
const { VERSION, hash, validateObservation, observeRemote } = require("./frontendReleaseInputs.cjs");
const { parseJson } = require("./createFrontendReleaseBundle.cjs");
const ROOT = path.resolve(__dirname, ".."), NODE_VERSION = "v22.22.1";
function check(value, message) { if (!value) throw new Error(message); }
const stamp = s => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
function plainParents(filename) {
  const rows = [];
  for (let p = path.dirname(filename);; p = path.dirname(p)) {
    const s = fs.lstatSync(p); check(s.isDirectory() && !s.isSymbolicLink(), "frontend-prepare-nonplain-parent");
    rows.push([p, s.dev, s.ino, s.mode, s.uid, s.gid]);
    if (p === path.dirname(p)) break;
  }
  return rows;
}
function readLocal(filename, maximum) {
  const parents = plainParents(filename), before = fs.lstatSync(filename, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum), "frontend-prepare-invalid-local-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    check(stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before), "frontend-prepare-input-open-drift");
    const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0, count;
    while (offset < buffer.length && (count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset))) offset += count;
    const bytes = buffer.subarray(0, offset);
    check(bytes.length === Number(before.size) && stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before)
      && stamp(fs.lstatSync(filename, { bigint: true })) === stamp(before), "frontend-prepare-input-read-drift");
    check(JSON.stringify(plainParents(filename)) === JSON.stringify(parents), "frontend-prepare-parent-drift"); return bytes;
  } finally { fs.closeSync(fd); }
}
function transportEnvironment(platform = process.platform) {
  return platform === "win32" ? { SystemRoot: "C:/Windows", WINDIR: "C:/Windows", ProgramData: "C:/ProgramData", PATH: "C:/Windows/System32;C:/Windows" }
    : { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
}
function prepare(env = process.env) {
  check(process.version === NODE_VERSION && !process.execArgv.length && !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some(k => env[k] || process.env[k]), "frontend-prepare-clean-node22-required");
  const required = name => { check(typeof env[name] === "string" && env[name].trim() === env[name] && env[name].length > 0, "frontend-prepare-required-" + name); return env[name]; };
  const bundle = path.resolve(required("RELEASE_FRONTEND_BASELINE_BUNDLE")), publicKeyPath = path.resolve(required("RELEASE_SIGNING_PUBLIC_KEY"));
  const manifestPath = bundle + ".manifest.json", signaturePath = bundle + ".manifest.sig";
  const snapshots = [[manifestPath, 1024 * 1024], [signaturePath, 16384], [publicKeyPath, 16384]].map(([file, max]) => ({ file, max, bytes: readLocal(file, max) }));
  const verified = signing.verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath, enforceFreshness: false });
  const baseline = verified.manifest;
  check((baseline.releaseKind || "full") === "full" && baseline.ok === true && baseline.archiveSourceEvidence?.inventory
    && /^[a-f0-9]{64}$/.test(baseline.sha256) && Number.isSafeInteger(baseline.releaseSequence) && baseline.releaseSequence > 0, "frontend-prepare-signed-full-baseline-required");
  check(baseline.site === required("RELEASE_SITE") && baseline.channel === required("RELEASE_CHANNEL"), "frontend-prepare-site-channel-mismatch");
  for (const name of ["releaseActions", "releaseActionEntries", "blockedEntries", "sensitiveEntries", "missingEntries"])
    check(Array.isArray(baseline[name]) && baseline[name].length === 0, "frontend-prepare-baseline-actions-or-blockers");
  // The normal constructor independently streams/authenticates the archive.
  // Check its presence/shape now without duplicating that large archive scan.
  plainParents(bundle); const archive = fs.lstatSync(bundle);
  check(archive.isFile() && !archive.isSymbolicLink() && archive.nlink === 1 && archive.size === baseline.bytes && archive.size <= 512 * 1024 ** 2, "frontend-prepare-original-archive-shape");
  const host = required("RELEASE_DEPLOY_HOST"), user = required("RELEASE_DEPLOY_USER"), port = Number(env.RELEASE_DEPLOY_PORT || 22), key = path.resolve(required("RELEASE_DEPLOY_KEY"));
  check(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host) && /^[a-z_][a-z0-9_-]{0,63}$/i.test(user), "frontend-prepare-ssh-target-invalid");
  plainParents(key); const keyStat = fs.lstatSync(key); check(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1, "frontend-prepare-key-not-plain");
  // Existing pin resolver reads process.env; pass explicit values to its pure
  // validator instead so tests/configuration cannot accidentally use ambient pins.
  const pin = require("./releaseSshHostKeyPin.cjs").validateReleaseSshHostKeyPin({ knownHostsPath: required("RELEASE_DEPLOY_KNOWN_HOSTS"), host, port,
    expectedFingerprint: required("RELEASE_DEPLOY_HOST_KEY_SHA256"), expectedKeyType: env.RELEASE_DEPLOY_HOST_KEY_TYPE || "ssh-ed25519" });
  const hosts = { file: pin.sshKnownHostsPath, max: 16384, bytes: readLocal(pin.sshKnownHostsPath, 16384) }; snapshots.push(hosts);
  const target = { sha256: baseline.sha256, sequence: baseline.releaseSequence };
  const program = "try{console.log(JSON.stringify((" + observeRemote.toString() + ")(" + JSON.stringify(target)
    + ")));}catch(e){console.error(/^[A-Za-z0-9_-]{1,100}$/.test(e.message)?e.message:'frontend-input-read-failed');process.exitCode=1;}";
  new vm.Script(program);
  const executable = process.platform === "win32" ? "C:/Windows/System32/OpenSSH/ssh.exe" : "/usr/bin/ssh";
  const command = { executable, args: ["-T", "-p", String(port), ...buildPinnedSshBaseOptions({ keyPath: key, pin }),
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", user + "@" + host,
    "sudo -n /usr/bin/timeout --signal=TERM --kill-after=3s 15s /usr/bin/env -i PATH=/opt/node-v22.22.1/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/node-v22.22.1/bin/node -"], env: transportEnvironment() };
  for (const row of snapshots) check(readLocal(row.file, row.max).equals(row.bytes), "frontend-prepare-local-input-drift");
  return { target, baseline, bundle, snapshots, command, program, programSha256: hash(program), publicKeyId: verified.keyId };
}
function saveInputs(prepared, observation, outputParent) {
  const checked = validateObservation(observation, prepared.baseline);
  for (const row of prepared.snapshots) check(readLocal(row.file, row.max).equals(row.bytes), "frontend-prepare-local-input-drift");
  const parent = path.resolve(outputParent); plainParents(path.join(parent, "unused"));
  const dir = fs.mkdtempSync(path.join(parent, "frontend-inputs-r" + checked.state.frontendSequence + "-"));
  const outputParents = plainParents(path.join(dir, "unused"));
  const checkOutput = () => check(JSON.stringify(plainParents(path.join(dir, "unused"))) === JSON.stringify(outputParents), "frontend-prepare-output-directory-drift");
  const artifacts = {};
  for (const [name, bytes] of Object.entries(checked.bytes)) {
    checkOutput(); const filename = path.join(dir, name); plainParents(filename);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    check(readLocal(filename, bytes.length).equals(bytes), "frontend-prepare-output-readback");
    artifacts[name] = { path: filename, bytes: bytes.length, sha256: hash(bytes) };
    checkOutput();
  }
  const report = { version: VERSION, ok: true, observedAt: observation.observedAt, preparedAt: new Date().toISOString(),
    runtimeSequence: checked.state.runtimeSequence, frontendSequence: checked.state.frontendSequence, stateSha256: checked.stateSha256,
    bindingSha256: checked.bindingSha256, programSha256: prepared.programSha256, publicKeyId: prepared.publicKeyId, artifacts,
    environment: { RELEASE_FRONTEND_BASELINE_BUNDLE: prepared.bundle, RELEASE_FRONTEND_STATE_PATH: artifacts["frontend-state.json"].path,
      RELEASE_FRONTEND_RUNTIME_PATH: artifacts["frontend-runtime-binding.json"].path },
    sshInvocations: 1, automaticRetries: 0, remoteWrites: 0, sequenceReservations: 0, buildExecutions: 0, deploymentAuthorized: false,
    proofScope: "current accepted state, exact receipt, runtime markers and index only; constructor and server must revalidate archive/runtime/build/acceptance" };
  checkOutput(); const reportPath = path.join(dir, "preparation.json"); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); checkOutput();
  return { ...report, reportPath };
}
function main(args = process.argv.slice(2), env = process.env) {
  check(args.length === 0 || args.length === 1 && args[0] === "--check", "usage-prepareFrontendRelease-no-args-or-check");
  const prepared = prepare(env);
  if (args[0] === "--check") return { ok: true, target: prepared.target, programSha256: prepared.programSha256, remoteCommands: 0, deploymentAuthorized: false };
  const result = spawnSync(prepared.command.executable, prepared.command.args, { input: prepared.program, env: prepared.command.env,
    encoding: "utf8", windowsHide: true, timeout: 25000, maxBuffer: 128 * 1024 });
  if (result.status !== 0 || result.error || result.signal) {
    const error = new Error("frontend-prepare-ssh-observation-failed");
    error.transportStatus = Number.isInteger(result.status) ? result.status : null;
    const reason = String(result.stderr || "").trim();
    error.remoteReason = /^frontend-input-[a-z0-9-]{1,100}$/.test(reason) ? reason : null;
    throw error;
  }
  const observation = parseJson(Buffer.from(result.stdout));
  validateObservation(observation, prepared.baseline); // Reject before creating any output directory.
  const output = path.resolve(env.RELEASE_FRONTEND_INPUTS_OUTPUT_DIR || path.join(ROOT, ".codex-tmp"));
  if (!fs.existsSync(output)) { plainParents(output); fs.mkdirSync(output, { mode: 0o700 }); }
  return saveInputs(prepared, observation, output);
}
module.exports = { prepare, saveInputs, main, readLocal, transportEnvironment };
if (require.main === module) { try { console.log(JSON.stringify(main(), null, 2)); } catch (e) { console.error(JSON.stringify({ ok: false,
  error: /^[A-Za-z0-9_-]{1,160}$/.test(e.message) ? e.message : "frontend-prepare-failed",
  ...(Object.hasOwn(e, "transportStatus") ? { transportStatus: e.transportStatus, remoteReason: e.remoteReason } : {}), deploymentAuthorized: false })); process.exitCode = 1; } }
