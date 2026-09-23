"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createFixture, runRecovery, mapped, write } = require("./verifyReleaseRecovery.cjs");

const helperSource = fs.readFileSync(path.join(__dirname, "../deploy/light-server/football-release-recovery.cjs"), "utf8");
const sidecarUnits = [
  ["football-market-collector.service", true, true],
  ["football-featured-combo.service", true, true],
  ["football-recommendation-settlement.service", false, false]
];
const sidecarTimers = [
  ["football-daily-prematch.timer", true, true],
  ["football-featured-combo.timer", false, false]
];

function installExpandedSnapshot(fixture) {
  const config = path.join(fixture.current, "managed-config");
  fs.appendFileSync(path.join(config, "units.tsv"), sidecarUnits.map(([name, enabled, active]) =>
    `${name}\t${Number(enabled)}\t${Number(active)}\n`).join(""));
  fs.appendFileSync(path.join(config, "timers.tsv"), sidecarTimers.map(([name, enabled, active]) =>
    `${name}\t${Number(enabled)}\t${Number(active)}\n`).join(""));
  const statePath = mapped(fixture.root, "/mock-systemd.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const [name, enabled, active] of [...sidecarUnits, ...sidecarTimers]) {
    state.units[name] = { exists: true, enabled, active };
  }
  state.units["football-daily-prematch.service"] = { exists: true, enabled: false, active: true };
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function assertSidecarsRestored(statePath, phase) {
  const { units } = JSON.parse(fs.readFileSync(statePath, "utf8"));
  for (const [name, enabled, active] of [...sidecarUnits, ...sidecarTimers]) {
    assert.equal(units[name].enabled, enabled, `${name} enabled state`);
    assert.equal(units[name].active, active, `${name} active state`);
  }
  assert.equal(units["football-daily-prematch.service"].active, phase === "committed",
    `${phase}: one-shot job is quiesced only when recovery must fence runtime processes`);
}

function verifyReleaseSidecarRecovery() {
let cases = 0;
for (const [phase, action] of [["candidate-validated", "rollback"], ["committed", "commit"]]) {
  const fixture = createFixture(phase);
  try {
    const statePath = installExpandedSnapshot(fixture);
    const result = runRecovery(fixture);
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).action, action);
    assertSidecarsRestored(statePath, phase);
    assert.equal(fs.existsSync(fixture.current), false);
    cases++;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const mutation of ["missing-timers", "unknown-unit", "reordered-timer"]) {
  const fixture = createFixture("candidate-validated");
  try {
    const statePath = installExpandedSnapshot(fixture);
    const config = path.join(fixture.current, "managed-config");
    if (mutation === "missing-timers") {
      write(path.join(config, "timers.tsv"),
        "football-cleanup.timer\t1\t1\nfootball-monitor.timer\t0\t0\n");
    } else if (mutation === "unknown-unit") {
      const file = path.join(config, "units.tsv");
      write(file, fs.readFileSync(file, "utf8").replace("football-market-collector.service", "football-unknown.service"));
    } else {
      const file = path.join(config, "timers.tsv");
      const rows = fs.readFileSync(file, "utf8").trimEnd().split("\n");
      [rows[2], rows[3]] = [rows[3], rows[2]];
      write(file, `${rows.join("\n")}\n`);
    }
    const before = fs.readFileSync(statePath);
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, `${mutation} must fail closed`);
    assert.deepEqual(fs.readFileSync(statePath), before, `${mutation} must fail before quiesce`);
    cases++;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture("candidate-validated", { health: false });
  try {
    const statePath = installExpandedSnapshot(fixture);
    const result = runRecovery(fixture);
    assert.notEqual(result.status, 0, "failed app health must retain recovery transaction");
    assert.equal(fs.existsSync(fixture.current), true);
    const { units } = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const [name] of sidecarUnits) assert.equal(units[name].active, false,
      `${name} must not restart before app health`);
    assert.equal(units["football-daily-prematch.service"].active, false);
    for (const [name] of sidecarTimers) assert.equal(units[name].active, false,
      `${name} must not restart before app health`);
    cases++;
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const method = helperSource.match(/  killDedicatedUserProcesses\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(method, "actual process fence method must be present");
  for (const persistent of [false, true]) {
    const polls = new Map();
    let waits = 0;
    const context = {
      TEST_MODE: false,
      Atomics: { wait: (_array, _index, _value, delay) => { assert.equal(delay, 100); waits++; } },
      Int32Array, SharedArrayBuffer,
      fail: message => { throw new Error(message); }
    };
    const adapter = vm.runInNewContext(`({${method}})`, context);
    adapter.run = (command, args) => {
      assert.deepEqual(Array.from(args).slice(-2), ["-u", args.at(-1)]);
      if (command === "pkill") return { status: 0 };
      assert.equal(command, "pgrep");
      const user = args.at(-1), count = (polls.get(user) || 0) + 1;
      polls.set(user, count);
      return { status: persistent || count < 4 ? 0 : 1 };
    };
    if (persistent) {
      assert.throws(() => adapter.killDedicatedUserProcesses(), /still has a process/);
      assert.equal(polls.get("football"), 20);
      assert.equal(waits, 19);
    } else {
      adapter.killDedicatedUserProcesses();
      assert.equal(polls.get("football"), 4);
      assert.equal(polls.get("football-build"), 4);
      assert.equal(waits, 6);
    }
    cases++;
  }
  for (const failedCommand of ["pkill", "pgrep"]) {
    const adapter = vm.runInNewContext(`({${method}})`, {
      TEST_MODE: false, Atomics, Int32Array, SharedArrayBuffer,
      fail: message => { throw new Error(message); }
    });
    adapter.run = command => ({ status: command === failedCommand ? 2 : 0 });
    assert.throws(() => adapter.killDedicatedUserProcesses(),
      failedCommand === "pkill" ? /process kill failed/ : /process probe failed/);
    cases++;
  }
}

return { ok: true, cases, productionWrites: 0,
  scope: "actual cold recovery helper, expanded and legacy journal compatibility, exact sidecar restore, fail-closed process fence" };
}

module.exports = { verifyReleaseSidecarRecovery };
if (require.main === module) console.log(JSON.stringify(verifyReleaseSidecarRecovery()));
