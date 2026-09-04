#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
TLS_IP_ADDRESS="${TLS_IP_ADDRESS:-134.175.132.183}"
ACME_EMAIL="${ACME_EMAIL:-}"
ACME_AGREE_TOS="${ACME_AGREE_TOS:-0}"
ACME_STAGING="${ACME_STAGING:-1}"
TLS_ENABLE_SITE="${TLS_ENABLE_SITE:-1}"
TLS_USE_EXISTING_CERT="${TLS_USE_EXISTING_CERT:-0}"
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/letsencrypt}"
CERTBOT_BIN="${CERTBOT_BIN:-$(command -v certbot 2>/dev/null || true)}"
TLS_SITE_AVAILABLE="${TLS_SITE_AVAILABLE:-/etc/nginx/sites-available/football-predict-tls}"
TLS_SITE_ENABLED="${TLS_SITE_ENABLED:-/etc/nginx/sites-enabled/football-predict-tls}"
HTTP_SITE_AVAILABLE="${HTTP_SITE_AVAILABLE:-/etc/nginx/sites-available/football-predict}"
HTTP_SITE_ENABLED="${HTTP_SITE_ENABLED:-/etc/nginx/sites-enabled/football-predict}"
HTTP_COMMON_TARGET="${HTTP_COMMON_TARGET:-/etc/nginx/conf.d/football-predict-common.conf}"
SERVER_COMMON_TARGET="${SERVER_COMMON_TARGET:-/etc/nginx/snippets/football-predict-server.conf}"
SECURITY_HEADERS_TARGET="${SECURITY_HEADERS_TARGET:-/etc/nginx/snippets/football-predict-security-headers.conf}"
RENEW_HOOK_PATH="${RENEW_HOOK_PATH:-/etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx}"
ACME_PRODUCTION_SERVER="https://acme-v02.api.letsencrypt.org/directory"
ACME_STAGING_SERVER="https://acme-staging-v02.api.letsencrypt.org/directory"

if [ -z "${TLS_CERT_NAME+x}" ]; then
  if [ "$ACME_STAGING" = "1" ]; then
    TLS_CERT_NAME="${TLS_IP_ADDRESS}-staging"
  else
    TLS_CERT_NAME="$TLS_IP_ADDRESS"
  fi
fi

log() {
  printf '[football-tls] %s\n' "$*"
}

fail() {
  printf '[football-tls] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

validate_ipv4() {
  local value="$1"
  local part
  local parts=()
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS='.' read -r -a parts <<<"$value"
  [ "${#parts[@]}" -eq 4 ] || return 1
  for part in "${parts[@]}"; do
    [[ "$part" =~ ^[0-9]+$ ]] || return 1
    [ "$part" -ge 0 ] && [ "$part" -le 255 ] || return 1
  done
}

certbot_version_supported() {
  local raw
  local version
  local major
  local minor
  raw="$($CERTBOT_BIN --version 2>&1)" || return 1
  version="$(printf '%s\n' "$raw" | grep -Eo '[0-9]+\.[0-9]+([.][0-9]+)?' | head -n 1)"
  [ -n "$version" ] || return 1
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -ge 4 ]; }
}

find_renew_timer() {
  local candidate
  if [ -n "${ACME_RENEW_TIMER:-}" ]; then
    systemctl cat "$ACME_RENEW_TIMER" >/dev/null 2>&1 || return 1
    printf '%s\n' "$ACME_RENEW_TIMER"
    return 0
  fi
  for candidate in certbot.timer snap.certbot.renew.timer; do
    if systemctl cat "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

install_managed_nginx_files() {
  install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
  install -d -m 0755 "$ACME_WEBROOT" "${ACME_WEBROOT}/.well-known" "${ACME_WEBROOT}/.well-known/acme-challenge"
  install -m 0644 "${APP_DIR}/deploy/light-server/nginx-http-common.conf" "$HTTP_COMMON_TARGET"
  install -m 0644 "${APP_DIR}/deploy/light-server/nginx-server-common.conf" "$SERVER_COMMON_TARGET"
  install -m 0644 "${APP_DIR}/deploy/light-server/nginx-security-headers.conf" "$SECURITY_HEADERS_TARGET"
  install -m 0644 "${APP_DIR}/deploy/light-server/nginx.conf" "$HTTP_SITE_AVAILABLE"

  if [ ! -e "$TLS_SITE_ENABLED" ] && [ ! -L "$TLS_SITE_ENABLED" ]; then
    ln -sfn "$HTTP_SITE_AVAILABLE" "$HTTP_SITE_ENABLED"
  fi
}

install_renew_hook() {
  local hook_tmp="$1"
  install -d -m 0755 "$(dirname "$RENEW_HOOK_PATH")"
  cat >"$hook_tmp" <<'HOOK'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
HOOK
  install -m 0755 "$hook_tmp" "$RENEW_HOOK_PATH"
}

render_tls_site() {
  local output="$1"
  sed \
    -e "s|__TLS_IP_ADDRESS__|${TLS_IP_ADDRESS}|g" \
    -e "s|__TLS_CERT_NAME__|${TLS_CERT_NAME}|g" \
    "${APP_DIR}/deploy/light-server/nginx-tls-site.conf.template" >"$output"
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fail "run as root (for example: sudo -E bash deploy/light-server/enable-nginx-tls.sh)"
fi
if [ "$ACME_AGREE_TOS" != "1" ]; then
  fail "ACME_AGREE_TOS=1 is required; review the CA subscriber agreement before running"
fi
if [[ ! "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  fail "ACME_EMAIL must be a valid non-empty contact email"
fi
case "$ACME_STAGING" in
  0|1) ;;
  *) fail "ACME_STAGING must be 0 or 1" ;;
esac
case "$TLS_ENABLE_SITE" in
  0|1) ;;
  *) fail "TLS_ENABLE_SITE must be 0 or 1" ;;
esac
case "$TLS_USE_EXISTING_CERT" in
  0|1) ;;
  *) fail "TLS_USE_EXISTING_CERT must be 0 or 1" ;;
esac
if [ "$TLS_USE_EXISTING_CERT" = "1" ] && [ "$ACME_STAGING" != "0" ]; then
  fail "TLS_USE_EXISTING_CERT=1 is supported only for the production certificate"
fi
validate_ipv4 "$TLS_IP_ADDRESS" || fail "TLS_IP_ADDRESS must be a valid IPv4 address"
[[ "$TLS_CERT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || fail "TLS_CERT_NAME contains unsupported characters"
[ -n "$CERTBOT_BIN" ] && [ -x "$CERTBOT_BIN" ] || fail "certbot is required; install Certbot 5.4 or newer"
certbot_version_supported || fail "Certbot 5.4 or newer is required for IP webroot certificates"

for command_name in nginx openssl systemctl install sed grep head mktemp readlink; do
  require_cmd "$command_name"
done
for source_path in \
  "${APP_DIR}/deploy/light-server/nginx.conf" \
  "${APP_DIR}/deploy/light-server/nginx-http-common.conf" \
  "${APP_DIR}/deploy/light-server/nginx-server-common.conf" \
  "${APP_DIR}/deploy/light-server/nginx-security-headers.conf" \
  "${APP_DIR}/deploy/light-server/nginx-tls-site.conf.template"; do
  [ -f "$source_path" ] || fail "required repository file missing: $source_path"
done

renew_timer="$(find_renew_timer)" || fail "no Certbot renewal timer found (checked certbot.timer and snap.certbot.renew.timer)"
install_managed_nginx_files
nginx -t
systemctl reload nginx

pre_hook_tmp="$(mktemp)"
if ! install_renew_hook "$pre_hook_tmp"; then
  rm -f "$pre_hook_tmp"
  fail "could not install the reviewed Nginx deploy hook"
fi
rm -f "$pre_hook_tmp"

if [ "$TLS_USE_EXISTING_CERT" = "1" ]; then
  log "reuse the already issued and renewal-tested production certificate"
else
  acme_config_tmp="$(mktemp /run/football-acme-config.XXXXXX)"
  cleanup_acme_config() {
    if [ -n "${acme_config_tmp:-}" ]; then rm -f "$acme_config_tmp" || true; fi
  }
  trap cleanup_acme_config EXIT
  printf 'non-interactive = true\nagree-tos = true\nemail = %s\n' "$ACME_EMAIL" >"$acme_config_tmp"
  chmod 0600 "$acme_config_tmp"

  certbot_args=(
    --config "$acme_config_tmp"
    certonly
    --preferred-profile shortlived
    --webroot
    --webroot-path "$ACME_WEBROOT"
    --ip-address "$TLS_IP_ADDRESS"
    --cert-name "$TLS_CERT_NAME"
    --deploy-hook "$RENEW_HOOK_PATH"
  )
  if [ "$ACME_STAGING" = "1" ]; then
    certbot_args+=(--server "$ACME_STAGING_SERVER" --force-renewal)
  else
    certbot_args+=(--server "$ACME_PRODUCTION_SERVER" --keep-until-expiring)
  fi

  log "request ${TLS_IP_ADDRESS} short-lived certificate (staging=${ACME_STAGING})"
  if ! "$CERTBOT_BIN" "${certbot_args[@]}"; then
    rm -f "$acme_config_tmp"
    fail "Certbot certificate request failed"
  fi
  rm -f "$acme_config_tmp"
  acme_config_tmp=""
  trap - EXIT
fi

cert_dir="/etc/letsencrypt/live/${TLS_CERT_NAME}"
[ -s "${cert_dir}/fullchain.pem" ] || fail "certificate was not created: ${cert_dir}/fullchain.pem"
[ -s "${cert_dir}/privkey.pem" ] || fail "private key was not created: ${cert_dir}/privkey.pem"
openssl x509 -in "${cert_dir}/fullchain.pem" -noout -checkend 0 >/dev/null || fail "issued certificate is already expired"

if [ "$ACME_STAGING" = "1" ]; then
  log "staging certificate validated; TLS site was not enabled"
  log "rerun with ACME_STAGING=0 after confirming the staging flow"
  exit 0
fi

tls_tmp="$(mktemp)"
hook_tmp="$(mktemp)"
tls_candidate="${TLS_SITE_AVAILABLE}.candidate.$$"
tls_backup=""
cleanup() {
  rm -f "$tls_tmp" "$hook_tmp" "$tls_candidate"
  if [ -n "$tls_backup" ]; then
    rm -f "$tls_backup"
  fi
}
trap cleanup EXIT

render_tls_site "$tls_tmp"
if [ -e "$TLS_SITE_AVAILABLE" ]; then
  tls_backup="$(mktemp)"
  cp -p "$TLS_SITE_AVAILABLE" "$tls_backup"
fi
install -m 0644 "$tls_tmp" "$tls_candidate"
install_renew_hook "$hook_tmp"

if [ "$TLS_ENABLE_SITE" = "0" ]; then
  log "production certificate and renewal automation validated; public TLS site remains disabled"
  exit 0
fi

previous_tls_target="$(readlink "$TLS_SITE_ENABLED" 2>/dev/null || true)"
had_http_link=0
if [ -e "$HTTP_SITE_ENABLED" ] || [ -L "$HTTP_SITE_ENABLED" ]; then
  had_http_link=1
fi
rm -f "$HTTP_SITE_ENABLED"
ln -sfn "$tls_candidate" "$TLS_SITE_ENABLED"

rollback_switch() {
  rm -f "$TLS_SITE_ENABLED"
  if [ -n "$previous_tls_target" ]; then
    ln -sfn "$previous_tls_target" "$TLS_SITE_ENABLED"
  fi
  if [ "$had_http_link" = "1" ]; then
    ln -sfn "$HTTP_SITE_AVAILABLE" "$HTTP_SITE_ENABLED"
  fi
  if [ -n "$tls_backup" ] && [ -f "$tls_backup" ]; then
    install -m 0644 "$tls_backup" "$TLS_SITE_AVAILABLE"
  fi
}

if ! nginx -t; then
  rollback_switch
  nginx -t || true
  fail "rendered TLS candidate failed Nginx validation; previous site restored"
fi
install -m 0644 "$tls_tmp" "$TLS_SITE_AVAILABLE"
ln -sfn "$TLS_SITE_AVAILABLE" "$TLS_SITE_ENABLED"
if ! nginx -t; then
  rollback_switch
  nginx -t || true
  fail "installed TLS site failed Nginx validation; previous site restored"
fi
if ! systemctl reload nginx; then
  rollback_switch
  nginx -t || true
  systemctl reload nginx || true
  fail "Nginx reload failed; bootstrap site restored"
fi

log "TLS enabled for https://${TLS_IP_ADDRESS}/"
log "renewal timer: ${renew_timer}; deploy hook: ${RENEW_HOOK_PATH}"
