#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
REPO_URL="${REPO_URL:-https://github.com/chen-1119/football-predict.git}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/chen-1119/football-predict/main}"
AUTO_REPAIR_BIN="${AUTO_REPAIR_BIN:-/usr/local/bin/football-predict-auto-repair}"
AUTO_REPAIR_SERVICE="/etc/systemd/system/football-predict-auto-repair.service"
AUTO_REPAIR_TIMER="/etc/systemd/system/football-predict-auto-repair.timer"

echo "[root-fix 1/7] install required packages"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y git rsync curl openssh-server
fi

echo "[root-fix 2/7] ensure swap"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile || true
  sudo swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "[root-fix 3/7] harden ssh availability"
sudo mkdir -p /run/sshd /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/99-football-predict.conf >/dev/null <<'SSHCONF'
UseDNS no
LoginGraceTime 30
MaxStartups 20:30:100
ClientAliveInterval 30
ClientAliveCountMax 3
SSHCONF
sudo sshd -t
sudo systemctl daemon-reload
sudo systemctl reset-failed ssh sshd ssh.socket sshd.socket 2>/dev/null || true
if systemctl list-unit-files | grep -q '^ssh\.socket'; then
  sudo systemctl disable --now ssh.socket || true
fi
if systemctl list-unit-files | grep -q '^sshd\.socket'; then
  sudo systemctl disable --now sshd.socket || true
fi
if systemctl list-unit-files | grep -q '^ssh\.service'; then
  sudo systemctl enable --now ssh
  sudo systemctl restart ssh
elif systemctl list-unit-files | grep -q '^sshd\.service'; then
  sudo systemctl enable --now sshd
  sudo systemctl restart sshd
else
  sudo systemctl enable --now ssh || sudo systemctl enable --now sshd || true
fi
echo "[root-fix ssh] listener"
sudo ss -ltnp 'sport = :22' || true
echo "[root-fix ssh] local banner"
timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22; head -n 1 <&3' || true
echo "[root-fix ssh] recent logs"
sudo journalctl -u ssh -u sshd -u ssh.socket -u sshd.socket -n 80 --no-pager || true

echo "[root-fix 4/7] install auto repair command"
sudo curl -fsSL "$RAW_BASE/scripts/cloudAutoRepair.sh" -o "$AUTO_REPAIR_BIN"
sudo chmod 755 "$AUTO_REPAIR_BIN"

echo "[root-fix 5/7] install systemd timer"
sudo tee "$AUTO_REPAIR_SERVICE" >/dev/null <<SERVICE
[Unit]
Description=Football Predict auto repair and safe deploy
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=REPO_URL=$REPO_URL
Environment=RAW_BASE=$RAW_BASE
ExecStart=$AUTO_REPAIR_BIN
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
SERVICE

sudo tee "$AUTO_REPAIR_TIMER" >/dev/null <<'TIMER'
[Unit]
Description=Run Football Predict auto repair periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
RandomizedDelaySec=60s
Persistent=true

[Install]
WantedBy=timers.target
TIMER

sudo systemctl daemon-reload
sudo systemctl enable --now football-predict-auto-repair.timer

echo "[root-fix 6/7] run repair now"
sudo systemctl start football-predict-auto-repair.service

echo "[root-fix 7/7] status"
sudo systemctl status football-predict-auto-repair.service --no-pager -l || true
sudo systemctl list-timers football-predict-auto-repair.timer --no-pager || true
curl -fsS http://127.0.0.1:8788/api/health | head -c 5000 || true
echo
