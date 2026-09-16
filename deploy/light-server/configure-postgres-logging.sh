#!/usr/bin/env bash
set -euo pipefail

# Keep slow-query timing without logging entire JSON snapshot bind parameters.
# Run as root on the PostgreSQL 16 light server. Reload needs no DB restart.
test "$(id -u)" = 0
backup="/var/lib/football-release/postgres-logging-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp -p /var/lib/postgresql/16/main/postgresql.auto.conf "$backup/postgresql.auto.conf"
cp -p /etc/logrotate.d/postgresql-common "$backup/postgresql-common"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET log_parameter_max_length = 256;"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -c 'SELECT pg_reload_conf();'
cat > /etc/logrotate.d/postgresql-common <<'EOF'
/var/log/postgresql/*.log {
    daily
    maxsize 100M
    rotate 10
    copytruncate
    compress
    compressoptions -1
    notifempty
    missingok
    su root root
}
EOF
chmod 0644 /etc/logrotate.d/postgresql-common
logrotate --debug /etc/logrotate.d/postgresql-common
runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -c 'SHOW log_parameter_max_length;'
printf 'PostgreSQL logging backup: %s\n' "$backup"
