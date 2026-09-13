#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR=/opt/football-leisu-collector
CONFIG_FILE=/etc/football-leisu-collector/collector.env
STATE_DIR=/var/lib/football-leisu-collector
RUN_USER=leisu-collector
DISPLAY_NUMBER=92
VNC_PORT=5902
WEB_PORT=6082

usage() {
  cat <<'USAGE'
Usage: sudo /opt/football-leisu-collector/login-ui.sh

After the deferred installation, start a temporary, non-root login desktop.
Only 127.0.0.1:5902 and 127.0.0.1:6082 are used; X11 TCP is disabled.
Access through an authenticated SSH local-forward only. Close the browser or
press Ctrl+C here to stop this session. The persistent browser profile is kept.
USAGE
}

check_free() {
  local port
  for port in "$VNC_PORT" "$WEB_PORT"; do
    if [[ -n "$(ss -H -ltn "sport = :$port")" ]]; then
      printf 'Refusing to use occupied TCP port %s. No existing listener will be stopped.\n' "$port" >&2
      return 1
    fi
  done
  if [[ -e /tmp/.X92-lock || -S /tmp/.X11-unix/X92 ]]; then
    printf 'Display :92 is already reserved. No existing display or lock will be removed.\n' >&2
    return 1
  fi
}

if [[ $# -eq 1 && "$1" == --help ]]; then
  usage
  exit 0
fi
if [[ $# -eq 0 ]]; then
  [[ $EUID -eq 0 ]] || { printf 'Run this launcher using sudo.\n' >&2; exit 1; }
  [[ "$(uname -s)" == Linux && -d /run/systemd/system ]] || { printf 'Linux with systemd is required.\n' >&2; exit 1; }
  for command in systemd-run systemctl ss; do
    command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 1; }
  done
  [[ -f "$CONFIG_FILE" && -f "$INSTALL_DIR/cli.cjs" && -f "$INSTALL_DIR/login-ui.sh" ]] || {
    printf 'Complete the deferred isolated installation first.\n' >&2; exit 1;
  }
  if systemctl is-active --quiet leisu-prematch.timer || systemctl is-active --quiet leisu-prematch.service; then
    printf 'Pause the collector timer and wait for its current run to finish before interactive login.\n' >&2
    exit 1
  fi
  check_free
  UNIT="leisu-login-ui-$(date +%s)-$$"
  if [[ "$(systemctl show --property=LoadState --value "$UNIT.service")" != not-found ]]; then
    printf 'Refusing to reuse a pre-existing transient unit.\n' >&2
    exit 1
  fi
  cleanup_unit() {
    local result=$?
    trap - EXIT INT TERM HUP
    # UNIT is unique to this launcher; never stop a named website/other session.
    systemctl stop "$UNIT.service" >/dev/null 2>&1 || true
    exit "$result"
  }
  trap cleanup_unit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  printf 'Temporary unit: %s.service\n' "$UNIT"
  printf 'No public listener or firewall rule will be created. Keep this terminal open.\n'
  systemd-run --quiet --wait --pipe --collect --unit="$UNIT" \
    --uid="$RUN_USER" --gid="$RUN_USER" \
    --working-directory="$INSTALL_DIR" \
    --property="EnvironmentFile=$CONFIG_FILE" \
    --property="RuntimeDirectory=$UNIT" --property=RuntimeDirectoryMode=0700 \
    --property=UMask=0077 --property=NoNewPrivileges=yes \
    --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateTmp=yes --property="ReadWritePaths=$STATE_DIR" \
    --property=KillMode=mixed --property=TimeoutStopSec=20s \
    --property=RuntimeMaxSec=1h \
    --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
    /bin/bash "$INSTALL_DIR/login-ui.sh" --worker "/run/$UNIT"
  exit 0
fi

# Internal mode is restricted to the dedicated user in a systemd invocation.
if [[ $# -ne 2 || "$1" != --worker || "$(id -un)" != "$RUN_USER" || -z "${INVOCATION_ID:-}" ]]; then
  usage >&2
  exit 2
fi
RUNTIME_DIR="$2"
if [[ ! "$RUNTIME_DIR" =~ ^/run/leisu-login-ui-[0-9]+-[0-9]+$ || ! -d "$RUNTIME_DIR" ]]; then
  printf 'Unexpected private runtime directory.\n' >&2
  exit 1
fi
if [[ "${LEISU_STATE_DIR:-$STATE_DIR}" != "$STATE_DIR" || "${LEISU_PROFILE_DIR:-$STATE_DIR/browser}" != "$STATE_DIR/browser" ]]; then
  printf 'This login launcher requires the documented dedicated state/profile paths.\n' >&2
  exit 1
fi
for command in Xvfb x11vnc websockify xauth xdpyinfo ss node; do
  command -v "$command" >/dev/null || { printf 'Missing login UI dependency: %s\n' "$command" >&2; exit 1; }
done
[[ -f /usr/share/novnc/vnc.html ]] || { printf 'noVNC web files missing at /usr/share/novnc.\n' >&2; exit 1; }
[[ ! -e "$STATE_DIR/collector.lock" ]] || { printf 'Collector lock exists. Inspect it before interactive login; no lock will be deleted.\n' >&2; exit 1; }
check_free

CHILDREN=()
BROWSER_PID=
WORKER_PID=$BASHPID
own_child_alive() {
  local pid="$1" parent=
  [[ -r "/proc/$pid/status" ]] || return 1
  while read -r key value rest; do
    if [[ "$key" == PPid: ]]; then parent="$value"; break; fi
  done < "/proc/$pid/status"
  [[ "$parent" == "$WORKER_PID" ]] && kill -0 "$pid" 2>/dev/null
}
cleanup_children() {
  local result=$? pid attempt
  trap - EXIT INT TERM HUP
  set +e
  # First close this script's X server so Chromium can close and release its lock.
  if [[ -n "${XVFB_PID:-}" ]] && own_child_alive "$XVFB_PID"; then kill -TERM "$XVFB_PID"; fi
  if [[ -n "$BROWSER_PID" ]]; then
    for attempt in {1..50}; do
      own_child_alive "$BROWSER_PID" || break
      sleep 0.1
    done
  fi
  for pid in "${CHILDREN[@]}"; do
    own_child_alive "$pid" && kill -TERM "$pid"
  done
  for attempt in {1..50}; do
    local live=0
    for pid in "${CHILDREN[@]}"; do own_child_alive "$pid" && live=1; done
    [[ $live -eq 0 ]] && break
    sleep 0.1
  done
  for pid in "${CHILDREN[@]}"; do
    own_child_alive "$pid" && kill -KILL "$pid"
    wait "$pid" 2>/dev/null || true
  done
  printf 'Temporary login UI stopped; browser profile retained at %s/browser.\n' "$STATE_DIR"
  exit "$result"
}
trap cleanup_children EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

export DISPLAY=":$DISPLAY_NUMBER"
export XAUTHORITY="$RUNTIME_DIR/Xauthority"
export LEISU_HEADLESS=0
# Cookie travels over stdin, never argv, journal output, or an external service.
: > "$XAUTHORITY"
chmod 0600 "$XAUTHORITY"
printf 'add %s MIT-MAGIC-COOKIE-1 %s\n' "$DISPLAY" "$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")" | xauth -f "$XAUTHORITY" source -
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp -auth "$XAUTHORITY" >"$RUNTIME_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
CHILDREN+=("$XVFB_PID")
ready=0
for attempt in {1..100}; do
  own_child_alive "$XVFB_PID" || break
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
[[ $ready -eq 1 ]] || { printf 'Private Xvfb display failed to start.\n' >&2; exit 1; }

x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost -listen 127.0.0.1 \
  -noipv6 -rfbport "$VNC_PORT" -forever -shared -nopw -noremote -noxdamage \
  >"$RUNTIME_DIR/x11vnc.log" 2>&1 &
VNC_PID=$!
CHILDREN+=("$VNC_PID")
websockify --web=/usr/share/novnc "127.0.0.1:$WEB_PORT" "127.0.0.1:$VNC_PORT" \
  >"$RUNTIME_DIR/websockify.log" 2>&1 &
WEB_PID=$!
CHILDREN+=("$WEB_PID")

for port in "$VNC_PORT" "$WEB_PORT"; do
  ready=0
  for attempt in {1..100}; do
    own_child_alive "$VNC_PID" && own_child_alive "$WEB_PID" || break
    listener="$(ss -H -ltn "sport = :$port")"
    if [[ -n "$listener" ]]; then
      while read -r socket_state recv send address peer rest; do
        [[ "$address" == "127.0.0.1:$port" ]] || { printf 'Unexpected listener address; stopping this login UI.\n' >&2; exit 1; }
      done <<< "$listener"
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ $ready -eq 1 ]] || { printf 'Private login listener failed on port %s.\n' "$port" >&2; exit 1; }
done

printf 'Ready: SSH-forward local 6082 to server 127.0.0.1:6082, then open http://127.0.0.1:6082/vnc.html\n'
printf 'This temporary loopback UI has no VNC password. Only use a trusted local machine and authenticated SSH tunnel.\n'
node "$INSTALL_DIR/cli.cjs" login &
BROWSER_PID=$!
CHILDREN+=("$BROWSER_PID")
while own_child_alive "$BROWSER_PID"; do
  for pid in "$XVFB_PID" "$VNC_PID" "$WEB_PID"; do
    own_child_alive "$pid" || {
      printf 'A login UI process exited; closing this session.\n' >&2
      tail -n 20 "$RUNTIME_DIR/xvfb.log" "$RUNTIME_DIR/x11vnc.log" "$RUNTIME_DIR/websockify.log" >&2
      exit 1
    }
  done
  sleep 1
done
wait "$BROWSER_PID"
