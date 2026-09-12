#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/install.sh --after-site-optimization

Run only after the football website optimization and its release work are complete.
This installs a NEW, isolated collector and browser dependencies. It does not run
login, database migration, collection, or enable/start any systemd unit.
USAGE
}

if [[ $# -eq 1 && "$1" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 || $# -gt 2 || "$1" != "--after-site-optimization" || ( $# -eq 2 && "$2" != "--headless-only" ) ]]; then
  usage >&2
  printf '\nInstallation is deferred: the explicit after-optimization flag is required.\n' >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this installer as root using sudo.\n' >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This installer requires a Linux server running systemd.\n' >&2
  exit 1
fi

HEADLESS_ONLY=0
[[ "${2:-}" == "--headless-only" ]] && HEADLESS_ONLY=1

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR=/opt/football-leisu-collector
CONFIG_DIR=/etc/football-leisu-collector
STATE_DIR=/var/lib/football-leisu-collector
BROWSERS_DIR="$STATE_DIR/playwright"
RUN_USER=leisu-collector
RUN_GROUP=leisu-collector
SERVICE_PATH=/etc/systemd/system/leisu-prematch.service
TIMER_PATH=/etc/systemd/system/leisu-prematch.timer
RUNTIME_FILES=(package.json package-lock.json cli.cjs scope.cjs store.cjs browser.cjs mapping.cjs runtime-policy.cjs failure-policy.cjs website-adapter.cjs website-reader.cjs schema.sql)

for executable in node npm systemctl sudo useradd getent install chown chmod apt-get; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$executable" >&2
    exit 1
  fi
done
if [[ ! -d /run/systemd/system ]]; then
  printf 'systemd is not running on this host.\n' >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
if [[ "$NODE_BIN" != /usr/bin/node && "$NODE_BIN" != /usr/local/bin/node && ! "$NODE_BIN" =~ ^/opt/node-v[0-9]+\.[0-9]+\.[0-9]+/bin/node$ ]]; then
  printf 'node must be available at /usr/bin/node or /usr/local/bin/node for the service. Found: %s\n' "$NODE_BIN" >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'const actual = process.versions.node.split(".").map(Number); const required = [22, 22, 1]; for (let i = 0; i < required.length; i++) { if (actual[i] !== required[i]) process.exit(actual[i] > required[i] ? 0 : 1); } process.exit(0);'; then
  printf 'Node.js >= 22.22.1 is required. Found: %s. No installation changes have been made.\n' "$("$NODE_BIN" --version)" >&2
  exit 1
fi

for file in "${RUNTIME_FILES[@]}" team-aliases.example.json deploy/login-ui.sh deploy/collector.env.example deploy/leisu-prematch.service deploy/leisu-prematch.timer; do
  if [[ ! -f "$SOURCE_DIR/$file" || -L "$SOURCE_DIR/$file" ]]; then
    printf 'Required regular package file is missing or is a symlink: %s\n' "$file" >&2
    exit 1
  fi
done

# Fresh installation only: never overwrite an existing deployment or its state.
for target in "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR" "$SERVICE_PATH" "$TIMER_PATH"; do
  if [[ -e "$target" || -L "$target" ]]; then
    printf 'Refusing to overwrite existing path: %s\n' "$target" >&2
    exit 1
  fi
done
if getent passwd "$RUN_USER" >/dev/null || getent group "$RUN_GROUP" >/dev/null; then
  printf 'Dedicated user/group already exists; inspect the existing installation manually.\n' >&2
  exit 1
fi
for unit in leisu-prematch.service leisu-prematch.timer; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    printf 'A systemd unit with this name already exists: %s\n' "$unit" >&2
    exit 1
  fi
done
if [[ ! -x /usr/sbin/nologin ]]; then
  printf 'Required non-login shell not found: /usr/sbin/nologin\n' >&2
  exit 1
fi

trap 'printf "Installation failed. No timer was enabled or started. Inspect the new dedicated paths before any retry; this installer does not delete partial state.\n" >&2' ERR

useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
install -d -o root -g "$RUN_GROUP" -m 0750 "$INSTALL_DIR" "$CONFIG_DIR"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$STATE_DIR" "$STATE_DIR/browser" "$BROWSERS_DIR"
for file in "${RUNTIME_FILES[@]}"; do
  install -o root -g "$RUN_GROUP" -m 0640 "$SOURCE_DIR/$file" "$INSTALL_DIR/$file"
done
install -o root -g "$RUN_GROUP" -m 0640 "$SOURCE_DIR/deploy/collector.env.example" "$CONFIG_DIR/collector.env"
install -o root -g "$RUN_GROUP" -m 0640 "$SOURCE_DIR/team-aliases.example.json" "$CONFIG_DIR/team-aliases.json"
install -o root -g "$RUN_GROUP" -m 0750 "$SOURCE_DIR/deploy/login-ui.sh" "$INSTALL_DIR/login-ui.sh"
if [[ -f "$SOURCE_DIR/mappings.example.json" && ! -L "$SOURCE_DIR/mappings.example.json" ]]; then
  install -o root -g "$RUN_GROUP" -m 0640 "$SOURCE_DIR/mappings.example.json" "$CONFIG_DIR/mappings.json"
fi
if [[ -f "$SOURCE_DIR/config.example.json" && ! -L "$SOURCE_DIR/config.example.json" ]]; then
  install -o root -g "$RUN_GROUP" -m 0640 "$SOURCE_DIR/config.example.json" "$CONFIG_DIR/config.example.json"
fi

# This cwd is always the fresh collector package, never the football application.
(
  cd -- "$INSTALL_DIR"
  npm ci --omit=dev --ignore-scripts
)
if [[ ! -x "$INSTALL_DIR/node_modules/.bin/playwright" ]]; then
  printf 'The independent package must include Playwright as a production dependency.\n' >&2
  exit 1
fi

# --with-deps may install Linux system libraries with the system package manager.
# Browser binaries are kept in this collector's private state directory.
if [[ "$HEADLESS_ONLY" != 1 ]]; then
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  xvfb x11vnc novnc websockify xauth x11-utils iproute2 fonts-noto-cjk
fi
(
  cd -- "$INSTALL_DIR"
  if [[ "$HEADLESS_ONLY" == 1 ]]; then
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" "$INSTALL_DIR/node_modules/.bin/playwright" install --with-deps chromium --only-shell
  else
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" "$INSTALL_DIR/node_modules/.bin/playwright" install --with-deps chromium
  fi
)

# Every recursive ownership change is confined to directories created above.
chown -R root:"$RUN_GROUP" "$INSTALL_DIR"
chmod -R g+rX,o-rwx "$INSTALL_DIR"
chown -R "$RUN_USER":"$RUN_GROUP" "$STATE_DIR"
chmod 0700 "$STATE_DIR" "$STATE_DIR/browser" "$BROWSERS_DIR"
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/leisu-prematch.service" "$SERVICE_PATH"
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/leisu-prematch.timer" "$TIMER_PATH"
# Bind the installed service to the same verified Node runtime.
sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN $INSTALL_DIR/cli.cjs collect-once|" "$SERVICE_PATH"
systemctl daemon-reload

trap - ERR
printf '\nInstalled the isolated collector. ENABLED=0 and ACCESS_VALIDATED=0 remain unchanged.\n'
printf 'No login, migration, collection, service start, or timer enablement has been performed.\n'
printf 'Next: follow deploy/部署说明.md; configure credentials only in %s/collector.env.\n' "$CONFIG_DIR"
