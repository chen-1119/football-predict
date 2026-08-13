#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly TARGET_USER="ubuntu"
readonly KEY_SOURCE="/tmp/football-operator.pub"
readonly EXPECTED_FINGERPRINT="${FOOTBALL_OPERATOR_KEY_FINGERPRINT:-}"

die() {
  printf 'restore-ubuntu-operator-key: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root from the cloud console"

for command_name in awk cat chown chmod getent id install mktemp mv rm ssh-keygen sshd stat sync tail od tr; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing command: ${command_name}"
done

[ -f "$KEY_SOURCE" ] && [ ! -L "$KEY_SOURCE" ] \
  || die "${KEY_SOURCE} must be a regular non-symlink file"
[ "$(stat -c '%h' -- "$KEY_SOURCE")" = "1" ] \
  || die "${KEY_SOURCE} must have exactly one hard link"
key_source_bytes="$(stat -c '%s' -- "$KEY_SOURCE")"
[[ "$key_source_bytes" =~ ^[0-9]+$ ]] && (( key_source_bytes > 0 && key_source_bytes <= 16384 )) \
  || die "${KEY_SOURCE} size is outside the allowed range"

key_lines=()
mapfile -t key_lines <"$KEY_SOURCE"
[ "${#key_lines[@]}" -eq 1 ] || die "${KEY_SOURCE} must contain exactly one line"
key_line="${key_lines[0]}"

[[ "$key_line" =~ ^ssh-rsa[[:space:]][A-Za-z0-9+/]+={0,2}([[:space:]][^[:cntrl:]]*)?$ ]] \
  || die "input must be one OpenSSH ssh-rsa public-key line"
read -r key_type key_blob _ <<<"$key_line"
[ "$key_type" = "ssh-rsa" ] && [ -n "$key_blob" ] \
  || die "input public key is malformed"

key_check="$(mktemp /tmp/.football-operator-key-check.XXXXXX)"
authorized_tmp=""
cleanup() {
  rm -f -- "$key_check"
  if [ -n "$authorized_tmp" ]; then
    rm -f -- "$authorized_tmp"
  fi
}
trap cleanup EXIT
printf '%s\n' "$key_line" >"$key_check"

fingerprint_output="$(ssh-keygen -l -E sha256 -f "$key_check" 2>/dev/null)" \
  || die "input is not a valid OpenSSH RSA public key"
read -r key_bits actual_fingerprint _ <<<"$fingerprint_output"
[[ "$key_bits" =~ ^[0-9]+$ ]] && (( key_bits >= 2048 )) \
  || die "RSA public key must be at least 2048 bits"
[[ "$actual_fingerprint" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] \
  || die "could not derive a SHA-256 public-key fingerprint"

if [ -n "$EXPECTED_FINGERPRINT" ]; then
  [[ "$EXPECTED_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] \
    || die "FOOTBALL_OPERATOR_KEY_FINGERPRINT is malformed"
  [ "$actual_fingerprint" = "$EXPECTED_FINGERPRINT" ] \
    || die "public-key fingerprint does not match FOOTBALL_OPERATOR_KEY_FINGERPRINT"
fi

passwd_entry="$(getent passwd "$TARGET_USER")" \
  || die "target user does not exist: ${TARGET_USER}"
IFS=: read -r passwd_name _ target_uid target_gid _ target_home _ <<<"$passwd_entry"
[ "$passwd_name" = "$TARGET_USER" ] || die "target passwd entry is inconsistent"
[[ "$target_uid" =~ ^[0-9]+$ ]] && [[ "$target_gid" =~ ^[0-9]+$ ]] \
  || die "target uid/gid is invalid"
[[ "$target_home" = /* ]] && [ "$target_home" != "/" ] \
  || die "target home path is unsafe"
[ -d "$target_home" ] && [ ! -L "$target_home" ] \
  || die "target home must be an existing non-symlink directory"

target_group="$(id -gn "$TARGET_USER")" \
  || die "could not resolve the target user's primary group"
ssh_dir="${target_home}/.ssh"
authorized_keys="${ssh_dir}/authorized_keys"

/usr/sbin/sshd -t

if [ -e "$ssh_dir" ] || [ -L "$ssh_dir" ]; then
  [ -d "$ssh_dir" ] && [ ! -L "$ssh_dir" ] \
    || die "${ssh_dir} must be a non-symlink directory"
fi
install -d -o "$TARGET_USER" -g "$target_group" -m 0700 -- "$ssh_dir"
[ "$(stat -c '%u:%g:%a' -- "$ssh_dir")" = "${target_uid}:${target_gid}:700" ] \
  || die "could not enforce ubuntu:ubuntu 0700 on ${ssh_dir}"

if [ -e "$authorized_keys" ] || [ -L "$authorized_keys" ]; then
  [ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ] \
    || die "${authorized_keys} must be a regular non-symlink file"
  [ "$(stat -c '%h' -- "$authorized_keys")" = "1" ] \
    || die "${authorized_keys} must have exactly one hard link"
fi

authorized_tmp="$(mktemp "${ssh_dir}/.authorized_keys.XXXXXX")"
if [ -f "$authorized_keys" ]; then
  cat -- "$authorized_keys" >"$authorized_tmp"
fi

key_present=0
if awk -v wanted_blob="$key_blob" '
  {
    for (field = 1; field < NF; field += 1) {
      if ($field == "ssh-rsa" && $(field + 1) == wanted_blob) {
        found = 1
      }
    }
  }
  END { exit(found ? 0 : 1) }
' "$authorized_tmp"; then
  key_present=1
fi

if [ "$key_present" -eq 0 ]; then
  if [ -s "$authorized_tmp" ]; then
    final_byte="$(tail -c 1 "$authorized_tmp" | od -An -t u1 | tr -d '[:space:]')"
    [ "$final_byte" = "10" ] || printf '\n' >>"$authorized_tmp"
  fi
  printf '%s\n' "$key_line" >>"$authorized_tmp"
fi

chown "$TARGET_USER:$target_group" "$authorized_tmp"
chmod 0600 "$authorized_tmp"
sync -f "$authorized_tmp"
mv -fT -- "$authorized_tmp" "$authorized_keys"
authorized_tmp=""
sync -f "$ssh_dir"

[ "$(stat -c '%u:%g:%a:%h' -- "$authorized_keys")" = "${target_uid}:${target_gid}:600:1" ] \
  || die "could not enforce ubuntu:ubuntu 0600 on ${authorized_keys}"
/usr/sbin/sshd -t

printf 'operator key ready; user=%s fingerprint=%s alreadyPresent=%s sshdConfigValid=1\n' \
  "$TARGET_USER" "$actual_fingerprint" "$key_present"
