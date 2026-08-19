#!/usr/bin/env bash
set -Eeuo pipefail

api_usage() {
  printf 'Usage: %s [--raw] [--accept MEDIA_TYPE] METHOD /path [JSON_BODY|-]\n' \
    "${API_PROGRAM_NAME}" >&2
}

redact_stream() {
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -n "${SUPERVISOR_TOKEN:-}" ]]; then
      line=${line//"${SUPERVISOR_TOKEN}"/[REDACTED]}
    fi
    printf '%s\n' "${line}"
  done
}

render_body() {
  local body_file=$1
  local raw=$2
  local response_path=$3
  local sensitive_supervisor_response=false
  local -a jq_args
  if [[ "${API_PROGRAM_NAME}" == supervisor-api \
    && "${response_path}" =~ ^/(addons|apps|v2/apps)/[^/]+/(info|options|config)(/|$) ]]; then
    sensitive_supervisor_response=true
  fi
  if ! jq --exit-status . "${body_file}" >/dev/null 2>&1; then
    if [[ "${sensitive_supervisor_response}" == true ]]; then
      printf '%s\n' '[REDACTED]'
    else
      redact_stream < "${body_file}"
    fi
  else
    jq_args=()
    if [[ "${raw}" == true ]]; then
      jq_args+=(--compact-output)
    fi
    jq "${jq_args[@]}" \
      --arg api_program "${API_PROGRAM_NAME}" \
      --arg api_path "${response_path}" '
      def sensitive_key:
        gsub("(?<lower>[a-z0-9])(?<upper>[A-Z])"; "\(.lower)_\(.upper)")
        | test(
          "(^|[_ -])(access[_ -]?(key|token)|api[_ -]?(key|token)|auth(orization)?([_ -]?code)?|oauth[_ -]?code|bearer[_ -]?token|client[_ -]?secret|cookie|credential|key|pass(code|phrase|word)?|pin|private[_ -]?key|proxy[_ -]?authorization|psk|refresh[_ -]?token|secret|session([_ -]?id)?|set[_ -]?cookie|token|webhook([_ -]?id)?)([_ -]|$)";
          "i"
        );
      def basic_credential:
        if type != "string" then false
        else
          [splits("[[:space:]]+")] as $parts
          | any(
              range(0; (($parts | length) - 1 | if . > 0 then . else 0 end));
              (($parts[.] | ascii_downcase) == "basic") and
              (
                $parts[. + 1] as $encoded
                | ($encoded | test("^[A-Za-z0-9+/]+={0,2}$")) and
                  (
                    try (
                      ($encoded | @base64d) as $decoded
                      | ($decoded | contains(":")) and
                        (
                          ($decoded | @base64 | rtrimstr("=")) ==
                          ($encoded | rtrimstr("="))
                        )
                    ) catch false
                  )
              )
            )
        end;
      def sensitive_value:
        type == "string" and (
          test(
            "(^|[[:space:]])bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}([[:space:]]|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?://[^[:space:]/@:]+:[^[:space:]/@]+@|(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|(^|[^0-9])([0-9]{8,12}:[A-Za-z0-9_-]{30,})([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})([^A-Za-z0-9_]|$)|(^|[^A-Z0-9])((AKIA|ASIA)[A-Z0-9]{16})([^A-Z0-9]|$)|(^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|(sk|rk)_live_[A-Za-z0-9]{16,})([^A-Za-z0-9_-]|$)";
            "i"
          ) or basic_credential
        );
      def redact_sensitive:
        if type == "object" then
          with_entries(
            if (
              (.key | sensitive_key) or
              (
                $api_program == "supervisor-api" and
                ($api_path | test("^/(addons|apps|v2/apps)/[^/]+/(info|options|config)(/|$)")) and
                (.key | test("^(options|config)$"; "i"))
              )
            ) then
              .value = "[REDACTED]"
            else
              .value |= redact_sensitive
            end
          )
        elif type == "array" then
          map(redact_sensitive)
        elif sensitive_value then
          "[REDACTED]"
        else
          .
        end;
      if (
        $api_program == "supervisor-api" and
        ($api_path | test("^/(addons|apps|v2/apps)/[^/]+/(options|config)(/|$)"))
      ) then
        if type == "object" then
          with_entries(
            if (.key | test("^(data|options|config)$"; "i")) then
              .value = "[REDACTED]"
            else
              .value |= redact_sensitive
            end
          )
        else
          "[REDACTED]"
        end
      else
        redact_sensitive
      end
    ' "${body_file}" | redact_stream
  fi
}

api_main() {
  local raw=false
  local accept='application/json'
  local method
  local path
  local path_only
  local core_path=''
  local body=''
  local has_body=false
  local request_dir
  local header_file
  local response_file
  local http_status
  local curl_status
  local curl_bin=${API_CURL_BIN:?API_CURL_BIN must select the image-managed curl binary}
  local -a curl_args

  while (( $# > 0 )); do
    case "$1" in
      --raw)
        raw=true
        shift
        ;;
      --accept)
        if (( $# < 2 )); then
          api_usage
          return 64
        fi
        accept=$2
        shift 2
        ;;
      --)
        shift
        break
        ;;
      -*)
        printf '%s: unknown option: %s\n' "${API_PROGRAM_NAME}" "$1" >&2
        return 64
        ;;
      *)
        break
        ;;
    esac
  done

  case "${accept}" in
    application/json | text/plain | text/x-log) ;;
    *)
      printf '%s: unsupported Accept media type\n' "${API_PROGRAM_NAME}" >&2
      return 64
      ;;
  esac

  if (( $# < 2 || $# > 3 )); then
    api_usage
    return 64
  fi

  method=${1^^}
  path=$2
  if [[ ! "${method}" =~ ^[A-Z]+$ ]]; then
    printf '%s: invalid HTTP method\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  if [[ "${path}" != /* || "${path}" == //* || "${path}" =~ [[:space:]] \
    || ${#path} -gt 2048 || "${path}" == *'#'* || "${path}" == *\\* \
    || "${path}" == *'['* || "${path}" == *']'* \
    || "${path}" == *'{'* || "${path}" == *'}'* ]]; then
    printf '%s: path must be a relative API path beginning with one slash\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  path_only=${path%%\?*}
  if [[ "${path_only}" == *'%'* || "${path_only}" == *'//'* \
    || "${path_only}" =~ (^|/)\.{1,2}(/|$) ]]; then
    printf '%s: path contains a non-canonical segment\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  if [[ "${API_PROGRAM_NAME}" == ha-api ]]; then
    core_path=${path_only}
  elif [[ "${API_PROGRAM_NAME}" == supervisor-api \
    && "${path_only}" =~ ^/(v2/)?(core|homeassistant)/api(/.*)?$ ]]; then
    core_path=${BASH_REMATCH[3]:-/}
  fi
  if [[ "${API_PROGRAM_NAME}" == supervisor-api ]] && {
    [[ "${path_only}" =~ ^/(v2/)?backups/[^/]+/download$ ]] \
      || [[ "${path_only}" =~ ^/(v2/)?ingress/ ]];
  }; then
    printf '%s: sensitive credential-bearing endpoint is unavailable\n' \
      "${API_PROGRAM_NAME}" >&2
    return 77
  fi
  if [[ "${API_PROGRAM_NAME}" == supervisor-api ]] && {
    [[ "${path_only}" =~ ^/(v2/)?(core|homeassistant|supervisor|host|dns|audio|multicast)/logs(/|$) ]] \
      || [[ "${path_only}" =~ ^/(v2/)?(addons|apps)/[^/]+/logs(/|$) ]];
  }; then
    printf '%s: raw log endpoint is unavailable; use the managed sanitized log reader\n' \
      "${API_PROGRAM_NAME}" >&2
    return 77
  fi
  if [[ -n "${core_path}" ]] && {
    { [[ "${method}" == GET ]] \
      && [[ "${core_path}" =~ ^/(states|history|logbook|error_log|stream|events|camera_proxy)(/|$) ]]; } \
      || [[ "${core_path}" =~ ^/template(/|$) ]];
  }; then
    printf '%s: secret-prone raw read is unavailable; use the managed projected reader\n' \
      "${API_PROGRAM_NAME}" >&2
    return 77
  fi

  if (( $# == 3 )); then
    has_body=true
    if [[ "$3" == - ]]; then
      body=$(cat)
    else
      body=$3
    fi
    if ! jq --exit-status . >/dev/null 2>&1 <<< "${body}"; then
      printf '%s: request body is not valid JSON\n' "${API_PROGRAM_NAME}" >&2
      return 65
    fi
  fi

  if [[ -z "${SUPERVISOR_TOKEN:-}" ]]; then
    printf '%s: SUPERVISOR_TOKEN is unavailable; run inside the Home Assistant App\n' "${API_PROGRAM_NAME}" >&2
    return 78
  fi

  request_dir=$(mktemp -d)
  chmod 0700 "${request_dir}"
  header_file="${request_dir}/headers"
  response_file="${request_dir}/response"
  trap 'rm -rf -- "${request_dir}"' RETURN
  printf 'Authorization: Bearer %s\n' "${SUPERVISOR_TOKEN}" > "${header_file}"
  chmod 0600 "${header_file}"

  curl_args=(
    --disable
    --globoff
    --silent
    --show-error
    --noproxy '*'
    --proto '=http'
    --request "${method}"
    --header "@${header_file}"
    --header "Accept: ${accept}"
    --output "${response_file}"
    --write-out '%{http_code}'
    --connect-timeout 10
    --max-time 300
  )
  if [[ "${has_body}" == true ]]; then
    curl_args+=(--header 'Content-Type: application/json' --data "${body}")
  fi
  curl_args+=("${API_BASE_URL%/}${path}")

  set +e
  http_status=$(
    /usr/bin/env -i \
      HOME=/nonexistent \
      LANG=C.UTF-8 \
      LC_ALL=C.UTF-8 \
      PATH=/usr/bin:/bin \
      "${curl_bin}" "${curl_args[@]}"
  )
  curl_status=$?
  set -e

  if (( curl_status != 0 )); then
    printf '%s: request transport failed (curl exit %d)\n' "${API_PROGRAM_NAME}" "${curl_status}" >&2
    return 69
  fi
  if [[ ! "${http_status}" =~ ^[0-9]{3}$ ]]; then
    printf '%s: request returned an invalid HTTP status\n' "${API_PROGRAM_NAME}" >&2
    return 69
  fi

  if (( http_status < 200 || http_status >= 300 )); then
    printf '%s: HTTP %s\n' "${API_PROGRAM_NAME}" "${http_status}" >&2
    render_body "${response_file}" "${raw}" "${path_only}" >&2
    return 1
  fi

  if [[ "${API_CHECK_RESULT}" == true ]]; then
    if jq --exit-status 'type == "object" and has("result")' \
      "${response_file}" >/dev/null 2>&1; then
      if jq --exit-status '.result != "ok"' "${response_file}" >/dev/null 2>&1; then
        printf '%s: Supervisor result was not ok\n' "${API_PROGRAM_NAME}" >&2
        render_body "${response_file}" "${raw}" "${path_only}" >&2
        return 1
      fi
    elif [[ "${raw}" != true ]]; then
      printf '%s: Supervisor response is missing the result field\n' "${API_PROGRAM_NAME}" >&2
      render_body "${response_file}" "${raw}" "${path_only}" >&2
      return 1
    fi
  fi

  render_body "${response_file}" "${raw}" "${path_only}"
}
