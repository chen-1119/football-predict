#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly TLS_IP_ADDRESS="134.175.132.183"
readonly TLS_CERT_NAME="134.175.132.183"
readonly HTTPS_PUBLIC_BASE_URL="https://134.175.132.183"
readonly HTTP_PUBLIC_BASE_URL="http://134.175.132.183"
readonly PUBLIC_BASE_URL_FILE="/etc/football-release/public-base-url"
readonly RENEWAL_CONFIG="/etc/letsencrypt/renewal/134.175.132.183.conf"
readonly SNAPSHOT_ROOT="/var/lib/football-release"
readonly TLS_SITE_AVAILABLE="/etc/nginx/sites-available/football-predict-tls"
readonly TLS_SITE_ENABLED="/etc/nginx/sites-enabled/football-predict-tls"
readonly HTTP_SITE_AVAILABLE="/etc/nginx/sites-available/football-predict"
readonly HTTP_SITE_ENABLED="/etc/nginx/sites-enabled/football-predict"
readonly TRANSITION_FALLBACK="/etc/nginx/conf.d/football-tls-transition-fallback.conf"
readonly SOURCE_ROOT="${TLS_SIGNED_SOURCE_ROOT:-}"
readonly ACME_EMAIL="${TLS_SIGNED_ACME_EMAIL:-}"
readonly CERTBOT_BIN="${CERTBOT_BIN:-$(command -v certbot 2>/dev/null || true)}"
readonly NODE_BIN="${NODE_BIN:-/opt/node-v22.22.1/bin/node}"

SNAPSHOT_DIR=""
PUBLIC_BASE_TMP=""
ROLLBACK_ARMED=0
RESTORE_FAILED=0
TLS_CUTOVER_COMMITTED=0
PRESERVE_SNAPSHOT=0
RENEW_TIMER=""
RENEW_TIMER_WAS_ENABLED=0
RENEW_TIMER_WAS_ACTIVE=0
RENEW_TIMER_STATE_CAPTURED=0

MANAGED_PATHS=(
  /etc/nginx/conf.d/football-predict-common.conf
  /etc/nginx/snippets/football-predict-server.conf
  /etc/nginx/snippets/football-predict-security-headers.conf
  /etc/nginx/sites-available/football-predict
  /etc/nginx/sites-enabled/football-predict
  /etc/nginx/sites-available/football-predict-tls
  /etc/nginx/sites-enabled/football-predict-tls
  /etc/nginx/conf.d/football-tls-transition-fallback.conf
  /etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx
  /etc/football-release/public-base-url
)

log() {
  printf '[football-signed-tls] %s\n' "$*"
}

fail() {
  printf '[football-signed-tls] error: %s\n' "$*" >&2
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

assert_safe_managed_path() {
  local target="$1"
  if [ -L "$target" ]; then
    [ "$(stat -c '%u:%g' -- "$target")" = "0:0" ] || fail "managed symlink is not root-owned: $target"
    return 0
  fi
  if [ -e "$target" ]; then
    [ -f "$target" ] && [ "$(stat -c '%u:%g:%h' -- "$target")" = "0:0:1" ] \
      || fail "managed path is not a root-owned single-link file: $target"
  fi
}

snapshot_managed_paths() {
  local index=0 target type
  SNAPSHOT_DIR="$(mktemp -d "${SNAPSHOT_ROOT}/tls-action.XXXXXX")" || return 1
  chown root:root "$SNAPSHOT_DIR"
  chmod 0700 "$SNAPSHOT_DIR"
  : >"${SNAPSHOT_DIR}/manifest.tsv"
  chown root:root "${SNAPSHOT_DIR}/manifest.tsv"
  chmod 0600 "${SNAPSHOT_DIR}/manifest.tsv"
  for target in "${MANAGED_PATHS[@]}"; do
    index=$((index + 1))
    assert_safe_managed_path "$target" || return 1
    type="absent"
    if [ -L "$target" ]; then
      type="symlink"
      cp -a --no-dereference -- "$target" "${SNAPSHOT_DIR}/${index}" || return 1
    elif [ -f "$target" ]; then
      type="file"
      cp -a --no-dereference -- "$target" "${SNAPSHOT_DIR}/${index}" || return 1
    fi
    printf '%s\t%s\t%s\n' "$index" "$type" "$target" >>"${SNAPSHOT_DIR}/manifest.tsv"
  done
  sync -f "${SNAPSHOT_DIR}/manifest.tsv"
  sync -f "$SNAPSHOT_DIR"
}

restore_managed_paths() {
  local index type target source parent
  [ -n "$SNAPSHOT_DIR" ] && [ -d "$SNAPSHOT_DIR" ] && [ ! -L "$SNAPSHOT_DIR" ] || return 1
  while IFS=$'\t' read -r index type target; do
    [[ "$index" =~ ^[1-9][0-9]*$ ]] || return 1
    [ "$target" = "${MANAGED_PATHS[$((index - 1))]}" ] || return 1
    parent="$(dirname "$target")"
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    [ ! -d "$target" ] || return 1
    rm -f -- "$target" || return 1
    case "$type" in
      absent) ;;
      file|symlink)
        source="${SNAPSHOT_DIR}/${index}"
        cp -a --no-dereference -- "$source" "$target" || return 1
        ;;
      *) return 1 ;;
    esac
    sync -f "$parent" || return 1
  done <"${SNAPSHOT_DIR}/manifest.tsv"
  nginx -t || return 1
  systemctl reload nginx || return 1
}

prepare_public_base_update() {
  local current
  [ -f "$PUBLIC_BASE_URL_FILE" ] && [ ! -L "$PUBLIC_BASE_URL_FILE" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$PUBLIC_BASE_URL_FILE")" = "0:0:644:1" ] \
    || fail "public base URL config is missing or unsafe"
  IFS= read -r current <"$PUBLIC_BASE_URL_FILE" || true
  case "$current" in
    "$HTTP_PUBLIC_BASE_URL"|"$HTTPS_PUBLIC_BASE_URL") ;;
    *) fail "public base URL config has an unexpected value" ;;
  esac
  PUBLIC_BASE_TMP="$(mktemp "/etc/football-release/.public-base-url.tls.XXXXXX")" || return 1
  printf '%s\n' "$HTTPS_PUBLIC_BASE_URL" >"$PUBLIC_BASE_TMP"
  chown root:root "$PUBLIC_BASE_TMP"
  chmod 0644 "$PUBLIC_BASE_TMP"
  sync -f "$PUBLIC_BASE_TMP"
}

commit_public_base_update() {
  [ -n "$PUBLIC_BASE_TMP" ] && [ -f "$PUBLIC_BASE_TMP" ] && [ ! -L "$PUBLIC_BASE_TMP" ] || return 1
  mv -fT -- "$PUBLIC_BASE_TMP" "$PUBLIC_BASE_URL_FILE"
  PUBLIC_BASE_TMP=""
  sync -f /etc/football-release
  [ "$(head -n 1 -- "$PUBLIC_BASE_URL_FILE")" = "$HTTPS_PUBLIC_BASE_URL" ]
}

find_renew_timer() {
  local timer
  for timer in certbot.timer snap.certbot.renew.timer; do
    if systemctl cat "$timer" >/dev/null 2>&1; then
      printf '%s\n' "$timer"
      return 0
    fi
  done
  return 1
}

capture_and_stop_renew_timer() {
  RENEW_TIMER="$1"
  systemctl is-enabled --quiet "$RENEW_TIMER" && RENEW_TIMER_WAS_ENABLED=1
  systemctl is-active --quiet "$RENEW_TIMER" && RENEW_TIMER_WAS_ACTIVE=1
  RENEW_TIMER_STATE_CAPTURED=1
  systemctl stop "$RENEW_TIMER" >/dev/null 2>&1 || return 1
  ! systemctl is-active --quiet "$RENEW_TIMER"
}

restore_renew_timer_state() {
  [ "$RENEW_TIMER_STATE_CAPTURED" = "1" ] || return 0
  if [ "$RENEW_TIMER_WAS_ENABLED" = "1" ]; then
    systemctl enable "$RENEW_TIMER" >/dev/null 2>&1 || return 1
  else
    systemctl disable "$RENEW_TIMER" >/dev/null 2>&1 || true
  fi
  if [ "$RENEW_TIMER_WAS_ACTIVE" = "1" ]; then
    systemctl start "$RENEW_TIMER" >/dev/null 2>&1 || return 1
  else
    systemctl stop "$RENEW_TIMER" >/dev/null 2>&1 || true
  fi
  RENEW_TIMER_STATE_CAPTURED=0
}

enable_production_renew_timer() {
  systemctl enable --now "$RENEW_TIMER" >/dev/null 2>&1 || return 1
  systemctl is-enabled --quiet "$RENEW_TIMER" || return 1
  systemctl is-active --quiet "$RENEW_TIMER" || return 1
  RENEW_TIMER_STATE_CAPTURED=0
}

start_renew_timer_for_cutover() {
  systemctl enable --now "$RENEW_TIMER" >/dev/null 2>&1 || return 1
  systemctl is-enabled --quiet "$RENEW_TIMER" || return 1
  systemctl is-active --quiet "$RENEW_TIMER"
}

validate_production_renewal_config() {
  "$NODE_BIN" "${SOURCE_ROOT}/scripts/validateCertbotRenewalConfig.cjs" "$RENEWAL_CONFIG"
}

ensure_https_firewall() {
  if [ -f /etc/ufw/ufw.conf ] && grep -Fx 'ENABLED=yes' /etc/ufw/ufw.conf >/dev/null; then
    command -v ufw >/dev/null 2>&1 || return 1
    ufw allow 443/tcp >/dev/null || return 1
    ufw status | grep -Eq '^[[:space:]]*443/tcp[[:space:]]+ALLOW' || return 1
  fi
}

run_tls_helper() {
  local staging="$1"
  local enable_site="$2"
  local use_existing_cert="$3"
  timeout --signal=TERM --kill-after=15s 360s env \
    APP_DIR="$SOURCE_ROOT" \
    TLS_IP_ADDRESS="$TLS_IP_ADDRESS" \
    ACME_EMAIL="$ACME_EMAIL" \
    ACME_AGREE_TOS=1 \
    ACME_STAGING="$staging" \
    TLS_ENABLE_SITE="$enable_site" \
    TLS_USE_EXISTING_CERT="$use_existing_cert" \
    CERTBOT_BIN="$CERTBOT_BIN" \
    bash "${SOURCE_ROOT}/deploy/light-server/enable-nginx-tls.sh"
}

verify_strict_tls() {
  local require_redirect="$1"
  env \
    TLS_VERIFY_BASE_URL="$HTTPS_PUBLIC_BASE_URL" \
    TLS_VERIFY_MODE=strict \
    TLS_EXPECT_IP="$TLS_IP_ADDRESS" \
    TLS_MIN_REMAINING_HOURS=36 \
    TLS_REQUIRE_HTTP_REDIRECT="$require_redirect" \
    "$NODE_BIN" "${SOURCE_ROOT}/scripts/verifyTlsReadiness.cjs" --strict
}

verify_strict_tls_with_retries() {
  local require_redirect="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if verify_strict_tls "$require_redirect"; then
      return 0
    fi
    if [ "$attempt" -lt 5 ]; then
      log "strict TLS verification hit a post-reload transient; retry ${attempt}/5"
      sleep 2
    fi
  done
  return 1
}

install_provisional_tls_site() {
  local rendered candidate
  rendered="$(mktemp)" || return 1
  candidate="${TLS_SITE_AVAILABLE}.provisional.$$"
  rm -f -- "$candidate"
  sed \
    -e "s|__TLS_IP_ADDRESS__|${TLS_IP_ADDRESS}|g" \
    -e "s|__TLS_CERT_NAME__|${TLS_CERT_NAME}|g" \
    "${SOURCE_ROOT}/deploy/light-server/nginx-tls-provisional-site.conf.template" >"$rendered" \
    || { rm -f -- "$rendered"; return 1; }
  [ -f "$HTTP_SITE_AVAILABLE" ] && [ ! -L "$HTTP_SITE_AVAILABLE" ] \
    || { rm -f -- "$rendered"; return 1; }
  install -o root -g root -m 0644 -- "$rendered" "$candidate" \
    || { rm -f -- "$rendered" "$candidate"; return 1; }
  mv -fT -- "$candidate" "$TLS_SITE_AVAILABLE" \
    || { rm -f -- "$rendered" "$candidate"; return 1; }
  ln -sfn -- "$HTTP_SITE_AVAILABLE" "$HTTP_SITE_ENABLED" \
    || { rm -f -- "$rendered"; return 1; }
  ln -sfn -- "$TLS_SITE_AVAILABLE" "$TLS_SITE_ENABLED" \
    || { rm -f -- "$rendered"; return 1; }
  rm -f -- "$rendered"
  nginx -t || return 1
  systemctl reload nginx || return 1
}

install_transition_fallback() {
  local candidate="${TRANSITION_FALLBACK}.candidate.$$"
  rm -f -- "$candidate"
  install -o root -g root -m 0644 -- \
    "${SOURCE_ROOT}/deploy/light-server/nginx-tls-transition-fallback.conf" \
    "$candidate" || return 1
  mv -fT -- "$candidate" "$TRANSITION_FALLBACK" || return 1
  sync -f /etc/nginx/conf.d || return 1
  nginx -t || return 1
  systemctl reload nginx || return 1
}

remove_transition_fallback() {
  rm -f -- "$TRANSITION_FALLBACK" || return 1
  sync -f /etc/nginx/conf.d || return 1
  nginx -t || return 1
  systemctl reload nginx || return 1
}

promote_ready_final_tls_after_interruption() {
  [ -L "$TLS_SITE_ENABLED" ] \
    && [ "$(readlink -- "$TLS_SITE_ENABLED")" = "$TLS_SITE_AVAILABLE" ] \
    && [ -f "$TLS_SITE_AVAILABLE" ] && [ ! -L "$TLS_SITE_AVAILABLE" ] \
    && grep -F 'return 308 https://134.175.132.183$request_uri;' "$TLS_SITE_AVAILABLE" >/dev/null \
    && grep -F 'ssl_certificate /etc/letsencrypt/live/134.175.132.183/fullchain.pem;' "$TLS_SITE_AVAILABLE" >/dev/null \
    && nginx -t \
    && systemctl reload nginx
}

cleanup_and_maybe_restore() {
  local status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$ROLLBACK_ARMED" = "1" ] \
    && promote_ready_final_tls_after_interruption; then
    log "final TLS configuration was already complete; rolling forward instead of withdrawing a possible 308" || true
    TLS_CUTOVER_COMMITTED=1
    ROLLBACK_ARMED=0
  fi
  if [ "$status" -ne 0 ] && [ "$TLS_CUTOVER_COMMITTED" = "1" ]; then
    log "post-cutover verification failed; preserving the working TLS listener instead of reverting a cacheable 308" || true
    enable_production_renew_timer \
      || log "warning: the production renewal timer still requires operator repair"
    PRESERVE_SNAPSHOT=1
  elif [ "$status" -ne 0 ] && [ "$ROLLBACK_ARMED" = "1" ]; then
    log "activation failed; restoring the exact pre-action Nginx and release URL configuration" || true
    restore_managed_paths || RESTORE_FAILED=1
    restore_renew_timer_state || RESTORE_FAILED=1
  fi
  if [ "$RESTORE_FAILED" = "1" ]; then
    log "FAIL-STOP: automatic HTTP restoration was incomplete; use the server console"
    log "preserved recovery snapshot: ${SNAPSHOT_DIR}"
    if [ -n "$PUBLIC_BASE_TMP" ]; then
      log "preserved prepared release URL file: ${PUBLIC_BASE_TMP}"
    fi
    exit 70
  fi
  if [ "$PRESERVE_SNAPSHOT" = "1" ]; then
    log "preserved pre-cutover recovery snapshot: ${SNAPSHOT_DIR}"
  else
    if [ -n "$PUBLIC_BASE_TMP" ]; then rm -f -- "$PUBLIC_BASE_TMP" || true; fi
    if [ -n "$SNAPSHOT_DIR" ]; then rm -rf --one-file-system -- "$SNAPSHOT_DIR" || true; fi
  fi
  exit "$status"
}

[ "${EUID:-$(id -u)}" -eq 0 ] || { fail "must run as root"; exit 1; }
[[ "$ACME_EMAIL" =~ ^[A-Za-z0-9.!#$%\&\'*+/=?^_\`\{\|\}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] \
  || { fail "validated ACME email is missing or malformed"; exit 1; }
[ -n "$SOURCE_ROOT" ] && [ -d "$SOURCE_ROOT" ] && [ ! -L "$SOURCE_ROOT" ] \
  || { fail "signed source root is missing or unsafe"; exit 1; }
for source_path in \
  "${SOURCE_ROOT}/deploy/light-server/enable-nginx-tls.sh" \
  "${SOURCE_ROOT}/deploy/light-server/nginx-tls-provisional-site.conf.template" \
  "${SOURCE_ROOT}/deploy/light-server/nginx-tls-transition-fallback.conf" \
  "${SOURCE_ROOT}/scripts/validateCertbotRenewalConfig.cjs" \
  "${SOURCE_ROOT}/scripts/verifyTlsReadiness.cjs"; do
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || { fail "required signed source file is missing: $source_path"; exit 1; }
done
for command_name in bash certbot cp curl dirname env find grep head install ln mktemp mv nginx readlink rm sed sleep stat sync systemctl timeout; do
  require_cmd "$command_name" || exit 1
done
[ -x "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] || { fail "fixed Node runtime is missing or unsafe"; exit 1; }
[ -n "$CERTBOT_BIN" ] && [ -x "$CERTBOT_BIN" ] || { fail "Certbot is missing"; exit 1; }
[ -d "$SNAPSHOT_ROOT" ] && [ ! -L "$SNAPSHOT_ROOT" ] || { fail "release state root is missing or unsafe"; exit 1; }
if find "$SNAPSHOT_ROOT" -maxdepth 1 -type d -name 'tls-action.*' -print -quit | grep -q .; then
  fail "a previous TLS action snapshot is still present; inspect it before retrying"
  exit 1
fi

nginx -t
curl -fsS --max-time 10 http://127.0.0.1:8788/api/v1/health >/dev/null
renew_timer="$(find_renew_timer)" || { fail "Certbot renewal timer is missing"; exit 1; }
trap cleanup_and_maybe_restore EXIT
snapshot_managed_paths
ROLLBACK_ARMED=1
prepare_public_base_update
capture_and_stop_renew_timer "$renew_timer"

log "validate the ACME challenge against the staging CA"
run_tls_helper 1 0 0
log "request the production short-lived IP certificate without publishing a redirect"
run_tls_helper 0 0 0
validate_production_renewal_config \
  || { fail "production renewal configuration is not pinned to the reviewed CA, webroot, profile, and hook"; exit 1; }

log "remove the staging-only certificate lineage before enabling unattended renewals"
timeout --signal=TERM --kill-after=15s 120s \
  "$CERTBOT_BIN" delete --non-interactive --cert-name "${TLS_IP_ADDRESS}-staging"

log "exercise the saved renewal configuration against the staging CA"
timeout --signal=TERM --kill-after=15s 600s \
  "$CERTBOT_BIN" renew --cert-name "$TLS_CERT_NAME" --dry-run --run-deploy-hooks \
    --no-random-sleep-on-renew --no-directory-hooks
[ -x /etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- /etc/letsencrypt/renewal-hooks/deploy/football-predict-nginx)" = "0:0:755:1" ]

log "ensure the host firewall admits HTTPS traffic"
ensure_https_firewall
log "publish provisional HTTPS while keeping HTTP available"
install_provisional_tls_site
verify_strict_tls 0

commit_public_base_update
log "install a crash-safe HTTP fallback for the final symlink transition"
install_transition_fallback
start_renew_timer_for_cutover
log "commit the final fixed HTTP-to-HTTPS redirect"
run_tls_helper 0 1 1
TLS_CUTOVER_COMMITTED=1
ROLLBACK_ARMED=0
RENEW_TIMER_STATE_CAPTURED=0
remove_transition_fallback \
  || log "warning: transition fallback remains installed; the fixed default redirect still takes precedence"
verify_strict_tls_with_retries 1
curl -fsS --max-time 10 http://127.0.0.1:8788/api/v1/health >/dev/null

ROLLBACK_ARMED=0
log "production IP TLS, renewal dry-run, and HTTPS release origin are verified"
