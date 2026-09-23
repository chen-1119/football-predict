"use strict";

// Exercise the release shell functions with an in-memory systemctl/pgrep model.
// No command in this harness can reach the host's systemd or PostgreSQL.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "../deploy/light-server/release-from-bundle.sh"), "utf8")
  .replace(/\r\n/g, "\n");
function extractFunction(name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `missing actual release function: ${name}`);
  return match[0];
}
function extractArray(name) {
  const match = source.match(new RegExp(`^${name}=\\([^\\n]*\\)`, "m"))
    || source.match(new RegExp(`^${name}=\\([\\s\\S]*?^\\)`, "m"));
  assert.ok(match, `missing actual release array: ${name}`);
  return match[0];
}

const bash = process.platform === "win32"
  ? [process.env.GIT_BASH_PATH, "D:/app/Git/bin/bash.exe", "C:/Program Files/Git/bin/bash.exe"]
    .find(candidate => candidate && fs.existsSync(candidate))
  : "bash";
assert.ok(bash, "Git Bash is required for the Windows shell lifecycle test");

const harness = `
set -euo pipefail
${extractArray("MANAGED_TIMERS")}
${extractArray("MANAGED_STATE_UNITS")}
${extractArray("NATIVE_AUXILIARY_UNITS")}
${[
  "quiesce_managed_maintenance_for_sqlite_snapshot",
  "quiesce_native_auxiliary_writers",
  "restore_native_auxiliary_states_after_readiness",
  "restore_timer_states_after_rollback",
  "enable_managed_timers_after_readiness"
].map(extractFunction).join("\n\n")}

declare -A mock_active=() mock_enabled=()
systemctl() {
  local action="$1"; shift
  local quiet=0
  if [[ "\${1:-}" == --quiet ]]; then quiet=1; shift; fi
  local unit="\${1:-}"
  case "$action" in
    is-active)
      if [[ "$scenario" == status-error && "$unit" == football-cleanup.timer ]]; then return 1; fi
      if [[ "\${mock_active[$unit]:-0}" == 1 ]]; then
        [[ "$quiet" == 1 ]] || printf 'active\\n'
        return 0
      fi
      [[ "$quiet" == 1 ]] || printf 'inactive\\n'
      return 3 ;;
    is-enabled) [[ "\${mock_enabled[$unit]:-0}" == 1 ]] ;;
    stop) mock_active[$unit]=0 ;;
    start) mock_active[$unit]=1 ;;
    enable) mock_enabled[$unit]=1 ;;
    disable) mock_enabled[$unit]=0 ;;
    *) printf 'unexpected systemctl action: %s\\n' "$action" >&2; return 99 ;;
  esac
}
pgrep() {
  [[ "$1" == -u && "$2" == football ]] || return 99
  case "$scenario" in
    normal|timer-*) return 1 ;;
    persistent) return 0 ;;
    error) return 2 ;;
  esac
}
sleep() { :; }
stat() {
  if [[ "$*" == *managed-config/units.tsv* || "$*" == *managed-config/timers.tsv* ]]; then
    printf '0:0:600:1\\n'; return 0
  fi
  command stat "$@"
}
assert_state() {
  local unit="$1" expected_active="$2" expected_enabled="$3"
  [[ "\${mock_active[$unit]:-0}" == "$expected_active" ]] || {
    printf 'active state mismatch: %s got %s expected %s\\n' "$unit" "\${mock_active[$unit]:-0}" "$expected_active" >&2
    return 1
  }
  [[ "\${mock_enabled[$unit]:-0}" == "$expected_enabled" ]] || {
    printf 'enabled state mismatch: %s got %s expected %s\\n' "$unit" "\${mock_enabled[$unit]:-0}" "$expected_enabled" >&2
    return 1
  }
}

scenario="$1"
RECOVERY_ACTIVE=1
RECOVERY_DIR="$(mktemp -d)"
trap 'rm -f -- "$RECOVERY_DIR/managed-config/units.tsv" "$RECOVERY_DIR/managed-config/timers.tsv"; rmdir -- "$RECOVERY_DIR/managed-config" "$RECOVERY_DIR"' EXIT
mkdir -p "$RECOVERY_DIR/managed-config"
cat >"$RECOVERY_DIR/managed-config/units.tsv" <<'UNITS'
football-predict.service\t1\t1
football-sync-worker.service\t1\t1
nginx.service\t1\t1
football-market-collector.service\t1\t1
football-featured-combo.service\t0\t0
football-recommendation-settlement.service\t0\t1
UNITS
cat >"$RECOVERY_DIR/managed-config/timers.tsv" <<'TIMERS'
football-cleanup.timer\t1\t1
football-monitor.timer\t0\t0
football-daily-prematch.timer\t1\t1
football-featured-combo.timer\t0\t0
TIMERS

for unit in "\${MANAGED_TIMERS[@]}" "\${MANAGED_STATE_UNITS[@]}" \
  football-cleanup.service football-monitor.service football-daily-prematch.service; do
  mock_active[$unit]=0; mock_enabled[$unit]=0
done
for unit in football-predict.service football-sync-worker.service nginx.service \
  football-market-collector.service football-recommendation-settlement.service \
  football-cleanup.timer football-daily-prematch.timer football-daily-prematch.service; do
  mock_active[$unit]=1
done
for unit in football-predict.service football-sync-worker.service nginx.service \
  football-market-collector.service football-cleanup.timer football-daily-prematch.timer; do
  mock_enabled[$unit]=1
done

if [[ "$scenario" == status-error ]]; then
  if quiesce_managed_maintenance_for_sqlite_snapshot; then
    printf 'systemctl query error allowed timer quiesce\\n' >&2
    exit 1
  fi
  assert_state football-cleanup.timer 1 1
  assert_state football-market-collector.service 1 1
  printf 'ok %s\\n' "$scenario"
  exit 0
fi
quiesce_managed_maintenance_for_sqlite_snapshot
assert_state football-cleanup.timer 0 1
assert_state football-featured-combo.timer 0 0
assert_state football-market-collector.service 1 1
mock_active[football-predict.service]=0
mock_active[football-sync-worker.service]=0
if [[ "$scenario" == normal || "$scenario" == timer-missing || "$scenario" == timer-reordered || "$scenario" == timer-malformed ]]; then
  quiesce_native_auxiliary_writers
  assert_state football-market-collector.service 0 1
  assert_state football-recommendation-settlement.service 0 0
  restore_native_auxiliary_states_after_readiness
  if [[ "$scenario" == timer-* ]]; then
    case "$scenario" in
      timer-missing) sed -i '$d' "$RECOVERY_DIR/managed-config/timers.tsv" ;;
      timer-reordered)
        mapfile -t rows <"$RECOVERY_DIR/managed-config/timers.tsv"
        printf '%s\\n' "\${rows[1]}" "\${rows[0]}" "\${rows[2]}" "\${rows[3]}" \
          >"$RECOVERY_DIR/managed-config/timers.tsv" ;;
      timer-malformed) sed -i '4s/0$/2/' "$RECOVERY_DIR/managed-config/timers.tsv" ;;
    esac
    if enable_managed_timers_after_readiness; then
      printf 'invalid timer snapshot was accepted: %s\\n' "$scenario" >&2
      exit 1
    fi
    assert_state football-cleanup.timer 0 1
    assert_state football-monitor.timer 0 0
    assert_state football-daily-prematch.timer 0 1
    assert_state football-featured-combo.timer 0 0
    printf 'ok %s\\n' "$scenario"
    exit 0
  fi
  enable_managed_timers_after_readiness
  assert_state football-market-collector.service 1 1
  assert_state football-featured-combo.service 0 0
  assert_state football-recommendation-settlement.service 1 0
  assert_state football-cleanup.timer 1 1
  assert_state football-monitor.timer 0 0
  assert_state football-daily-prematch.timer 1 1
  assert_state football-featured-combo.timer 0 0
else
  if quiesce_native_auxiliary_writers; then
    printf 'unknown or uncheckable football process allowed cutover: %s\\n' "$scenario" >&2
    exit 1
  fi
  assert_state football-market-collector.service 0 1
  assert_state football-recommendation-settlement.service 0 0
fi
printf 'ok %s\\n' "$scenario"
`;

const workspace = path.join(__dirname, "..");
const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-sidecar-harness-"));
const harnessPath = path.join(harnessDir, "harness.sh");
fs.writeFileSync(harnessPath, harness, { flag: "wx" });
try {
  for (const scenario of ["normal", "persistent", "error", "status-error",
    "timer-missing", "timer-reordered", "timer-malformed"]) {
    const result = spawnSync(bash, [harnessPath.replace(/\\/g, "/"), scenario], {
      cwd: workspace, encoding: "utf8", timeout: 30_000, windowsHide: true
    });
    assert.equal(result.status, 0, `${scenario}: ${result.error || String(result.stderr || result.stdout).slice(-5000)}`);
    assert.equal(result.stdout.trim(), `ok ${scenario}`);
  }
} finally {
  fs.rmSync(harnessDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, cases: 7, productionWrites: 0,
  scope: "actual release Bash functions, exact sidecar/timer restore, malformed journal and uncheckable process fail-closed" }));
