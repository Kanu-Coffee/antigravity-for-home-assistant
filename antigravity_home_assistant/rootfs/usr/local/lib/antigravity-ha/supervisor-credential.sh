#!/usr/bin/env bash

# Validate and load the Supervisor credential only inside a dedicated Home
# Assistant helper. Long-running brokers use the descriptor validators below
# and never place the raw credential in their process environment.
# Interactive shells, Antigravity, Telegram, nginx and Chromium must never
# inherit it. AppArmor provides the enforcement boundary in HAOS; these checks
# also fail closed on unsafe runtime files in ordinary container tests.
antigravity_ha_validate_supervisor_credential_file() {
  local credential_file=${1:-/run/antigravity-ha/supervisor.token}
  local owner mode links kind size

  if (( $# > 1 )); then
    printf 'Invalid Supervisor credential file validator argument\n' >&2
    return 64
  fi
  if [[ -L "${credential_file}" || ! -f "${credential_file}" ]]; then
    return 78
  fi
  owner=$(stat -c '%u' "${credential_file}") || return 78
  mode=$(stat -c '%a' "${credential_file}") || return 78
  links=$(stat -c '%h' "${credential_file}") || return 78
  kind=$(stat -c '%F' "${credential_file}") || return 78
  size=$(stat -c '%s' "${credential_file}") || return 78
  if [[ "${owner}" != 0 || "${links}" != 1 || "${kind}" != 'regular file' \
    || ( "${mode}" != 400 && "${mode}" != 600 ) \
    || ! "${size}" =~ ^[0-9]+$ || "${size}" == 0 || "${size}" -gt 4096 ]]; then
    return 78
  fi
}

antigravity_ha_validate_supervisor_credential_fd() {
  local descriptor=${1:-}
  local expected_path=${2:-/run/antigravity-ha/supervisor.token}
  local fd_path owner mode links kind size target

  if (( $# < 1 || $# > 2 )) || [[ ! "${descriptor}" =~ ^[1-9][0-9]{0,3}$ ]]; then
    printf 'Invalid Supervisor credential descriptor validator argument\n' >&2
    return 64
  fi
  fd_path="/proc/self/fd/${descriptor}"
  owner=$(stat -Lc '%u' "${fd_path}") || return 78
  mode=$(stat -Lc '%a' "${fd_path}") || return 78
  links=$(stat -Lc '%h' "${fd_path}") || return 78
  kind=$(stat -Lc '%F' "${fd_path}") || return 78
  size=$(stat -Lc '%s' "${fd_path}") || return 78
  target=$(readlink "${fd_path}") || return 78
  if [[ "${target}" != "${expected_path}" || "${owner}" != 0 || "${links}" != 1 \
    || "${kind}" != 'regular file' \
    || ( "${mode}" != 400 && "${mode}" != 600 ) \
    || ! "${size}" =~ ^[0-9]+$ || "${size}" == 0 || "${size}" -gt 4096 ]]; then
    return 78
  fi
}

# Convert a validated regular credential file into an anonymous pipe before an
# AppArmor Px transition to a top-level named profile. AppArmor revalidates
# inherited descriptors against the target profile. Passing a pipe avoids
# granting the long-running broker permission to reopen the credential path
# after it has consumed the value.
antigravity_ha_open_supervisor_credential_pipe() {
  local output_name=${1:-}
  local credential_file=${2:-/run/antigravity-ha/supervisor.token}
  local source_fd handoff_fd writer_pid
  local fd_path owner mode links kind size target

  if (( $# < 1 || $# > 2 )) || [[ ! "${output_name}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    printf 'Invalid Supervisor credential pipe argument\n' >&2
    return 64
  fi
  antigravity_ha_validate_supervisor_credential_file "${credential_file}" \
    || return 78
  exec {source_fd}< "${credential_file}" || return 78
  if ! antigravity_ha_validate_supervisor_credential_fd \
    "${source_fd}" "${credential_file}"; then
    exec {source_fd}<&-
    return 78
  fi

  exec {handoff_fd}< <(/usr/bin/cat -- "/proc/self/fd/${source_fd}")
  writer_pid=$!
  if ! wait "${writer_pid}"; then
    exec {source_fd}<&-
    exec {handoff_fd}<&-
    return 78
  fi
  exec {source_fd}<&-

  fd_path="/proc/self/fd/${handoff_fd}"
  owner=$(stat -Lc '%u' "${fd_path}") || return 78
  mode=$(stat -Lc '%a' "${fd_path}") || return 78
  links=$(stat -Lc '%h' "${fd_path}") || return 78
  kind=$(stat -Lc '%F' "${fd_path}") || return 78
  size=$(stat -Lc '%s' "${fd_path}") || return 78
  target=$(readlink "${fd_path}") || return 78
  if [[ "${owner}" != 0 || "${mode}" != 600 || "${links}" != 1 \
    || "${kind}" != fifo || "${size}" != 0 \
    || ! "${target}" =~ ^pipe:\[[0-9]+\]$ ]]; then
    exec {handoff_fd}<&-
    return 78
  fi
  printf -v "${output_name}" '%s' "${handoff_fd}"
}

antigravity_ha_load_supervisor_credential() {
  local required=true
  local credential_file=/run/antigravity-ha/supervisor.token
  local token

  if [[ "${1:-}" == --optional ]]; then
    required=false
  elif (( $# != 0 )); then
    printf 'Invalid Supervisor credential loader argument\n' >&2
    return 64
  fi

  unset BASH_ENV ENV
  if ! antigravity_ha_validate_supervisor_credential_file "${credential_file}"; then
    if [[ "${required}" == true ]]; then
      printf 'Supervisor credential is unavailable or unsafe\n' >&2
      return 78
    fi
    unset SUPERVISOR_TOKEN
    return 0
  fi
  token=$(< "${credential_file}")
  if [[ -z "${token}" || "${token}" == *$'\n'* || "${token}" == *$'\r'* ]]; then
    unset token
    printf 'Supervisor credential is unavailable or unsafe\n' >&2
    return 78
  fi
  export SUPERVISOR_TOKEN=${token}
  unset token credential_file required
}
