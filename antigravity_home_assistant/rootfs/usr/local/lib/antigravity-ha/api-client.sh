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
    && "${response_path}" =~ ^/(addons|apps)/[^/]+/(info|options|config)(/|$) ]]; then
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
        test(
          "(^|[_ -])(access[_ -]?key|api[_ -]?key|auth(orization)?|bearer|client[_ -]?secret|code|cookie|credential|key|pass(code|phrase|word)?|pin|private[_ -]?key|psk|secret|session([_ -]?id)?|token|webhook)([_ -]|$)";
          "i"
        );
      def sensitive_value:
        type == "string" and test(
          "(^|[[:space:]])bearer[[:space:]]+[^[:space:]]|-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}";
          "i"
        );
      def redact_sensitive:
        if type == "object" then
          with_entries(
            if (
              (.key | sensitive_key) or
              (
                $api_program == "supervisor-api" and
                ($api_path | test("^/(addons|apps)/[^/]+/(info|options|config)(/|$)")) and
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
        ($api_path | test("^/(addons|apps)/[^/]+/(options|config)(/|$)"))
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
    || ${#path} -gt 2048 || "${path}" == *'#'* || "${path}" == *\\* ]]; then
    printf '%s: path must be a relative API path beginning with one slash\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  path_only=${path%%\?*}
  if [[ "${path_only}" == *'%'* || "${path_only}" == *'//'* \
    || "${path_only}" =~ (^|/)\.{1,2}(/|$) ]]; then
    printf '%s: path contains a non-canonical segment\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  if [[ "${API_PROGRAM_NAME}" == supervisor-api ]] && {
    [[ "${path_only}" =~ ^/backups/[^/]+/download$ ]] \
      || [[ "${path_only}" =~ ^/ingress/ ]];
  }; then
    printf '%s: sensitive credential-bearing endpoint is unavailable\n' \
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
