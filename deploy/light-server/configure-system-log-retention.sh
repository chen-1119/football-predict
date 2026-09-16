#!/usr/bin/env bash
set -euo pipefail

# Bound diagnostic logs without touching application evidence or databases.
test "$(id -u)" = 0
backup="/var/lib/football-release/log-retention-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp -p /etc/logrotate.d/rsyslog "$backup/rsyslog"
install -d -m 0755 /etc/systemd/journald.conf.d
if test -f /etc/systemd/journald.conf.d/football-retention.conf; then
    cp -p /etc/systemd/journald.conf.d/football-retention.conf "$backup/journald.conf"
fi
cat > /etc/systemd/journald.conf.d/football-retention.conf <<'EOF'
[Journal]
SystemMaxUse=512M
SystemKeepFree=5G
SystemMaxFileSize=64M
RuntimeMaxUse=128M
MaxRetentionSec=7day
EOF
cat > /etc/logrotate.d/rsyslog <<'EOF'
/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
    daily
    maxsize 50M
    rotate 7
    maxage 7
    missingok
    notifempty
    compress
    compressoptions -1
    su root adm
    create 0640 syslog adm
    sharedscripts
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}
EOF
# maxsize is evaluated when logrotate runs; hourly checks avoid a day of growth.
install -d -m 0755 /etc/systemd/system/logrotate.timer.d
if test -f /etc/systemd/system/logrotate.timer.d/football-hourly.conf; then
    cp -p /etc/systemd/system/logrotate.timer.d/football-hourly.conf "$backup/logrotate.timer.conf"
fi
cat > /etc/systemd/system/logrotate.timer.d/football-hourly.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=hourly
RandomizedDelaySec=5m
AccuracySec=1m
EOF
logrotate --debug /etc/logrotate.conf
systemctl daemon-reload
systemctl restart logrotate.timer
systemctl restart systemd-journald
journalctl --rotate
journalctl --vacuum-size=512M --vacuum-time=7d
printf 'Log retention configuration backup: %s\n' "$backup"
