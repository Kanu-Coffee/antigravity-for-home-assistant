import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


TOKEN = "unit-test-supervisor-token"


def _bash_path() -> str | None:
    if os.name == "nt":
        candidates = (
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files\Git\usr\bin\bash.exe"),
        )
        return next((str(path) for path in candidates if path.exists()), None)
    return shutil.which("bash")


@pytest.fixture()
def api_harness(tmp_path: Path, rootfs: Path) -> tuple[str, Path, Path]:
    bash = _bash_path()
    if bash is None:
        pytest.skip("bash is required for API helper unit tests")

    jq_check = subprocess.run(
        [bash, "-lc", "command -v jq"], capture_output=True, text=True, check=False
    )
    if jq_check.returncode != 0:
        pytest.skip("jq is required for API helper unit tests")

    harness = tmp_path / "api-harness.sh"
    harness.write_text(
        """#!/usr/bin/env bash
set -Eeuo pipefail
library=$1
curl_bin=$2
shift 2
readonly API_PROGRAM_NAME=${TEST_API_PROGRAM_NAME:-test-api}
readonly API_BASE_URL=http://example.invalid
readonly API_CHECK_RESULT=${TEST_API_CHECK_RESULT:-false}
readonly API_CURL_BIN=${curl_bin}
# shellcheck source=/dev/null
. "${library}"
api_main "$@"
""",
        encoding="utf-8",
    )

    mock_curl = tmp_path / "mock-curl"
    mock_curl.write_text(
        """#!/usr/bin/env bash
set -Eeuo pipefail
fixture_dir=$(dirname "$0")
output=''
authorization_file=''
accept_header=''
request_url=''
response_body=$(cat "${fixture_dir}/response-body")
expected_token=$(cat "${fixture_dir}/expected-token")
expected_accept=$(cat "${fixture_dir}/expected-accept")
expected_url=$(cat "${fixture_dir}/expected-url")
mock_status=$(cat "${fixture_dir}/response-status")
mock_exit=$(cat "${fixture_dir}/curl-exit")
touch "${fixture_dir}/curl-called"
for forbidden_name in CURL_BIN API_CURL_BIN HA_URL SUPERVISOR_URL http_proxy https_proxy \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy CURL_HOME; do
  if [[ -v "${forbidden_name}" ]]; then
    exit 92
  fi
done
while (( $# > 0 )); do
  case "$1" in
    --output)
      output=$2
      shift 2
      ;;
    --header)
      if [[ "$2" == @* ]]; then
        authorization_file=${2#@}
      elif [[ "$2" == 'Accept: '* ]]; then
        accept_header=$2
      fi
      shift 2
      ;;
    --request|--write-out|--connect-timeout|--max-time|--data|--noproxy|--proto)
      shift 2
      ;;
    http://*)
      request_url=$1
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -z "${authorization_file}" ]] \
  || ! grep -Fqx "Authorization: Bearer ${expected_token}" "${authorization_file}"; then
  exit 90
fi
if [[ "${accept_header}" != "Accept: ${expected_accept}" ]]; then
  exit 91
fi
if [[ "${request_url}" != "${expected_url}" ]]; then
  exit 93
fi
if [[ -n "${output}" ]]; then
  printf '%s' "${response_body}" > "${output}"
fi
printf '%s' "${mock_status}"
exit "${mock_exit}"
""",
        encoding="utf-8",
    )
    mock_curl.chmod(0o755)

    library = rootfs / "usr/local/lib/antigravity-ha/api-client.sh"
    return bash, harness, library


def run_api(
    api_harness: tuple[str, Path, Path],
    *arguments: str,
    body: str = "{}",
    status: str = "200",
    check_result: bool = False,
    token: str | None = TOKEN,
    curl_exit: str = "0",
    expected_accept: str = "application/json",
    program_name: str = "test-api",
) -> subprocess.CompletedProcess[str]:
    bash, harness, library = api_harness
    mock_curl = harness.parent / "mock-curl"
    request_path = next(
        argument for argument in arguments if argument.startswith("/")
    )
    fixture_values = {
        "response-body": body,
        "response-status": status,
        "curl-exit": curl_exit,
        "expected-token": token or "",
        "expected-accept": expected_accept,
        "expected-url": f"http://example.invalid{request_path}",
    }
    for filename, value in fixture_values.items():
        (harness.parent / filename).write_text(value, encoding="utf-8")
    (harness.parent / "curl-called").unlink(missing_ok=True)
    env = os.environ.copy()
    env.update(
        {
            "CURL_BIN": "/attacker-controlled/curl",
            "API_CURL_BIN": "/attacker-controlled/api-curl",
            "HA_URL": "http://attacker.invalid/core/api",
            "SUPERVISOR_URL": "http://attacker.invalid",
            "http_proxy": "http://attacker.invalid:8080",
            "HTTPS_PROXY": "http://attacker.invalid:8080",
            "ALL_PROXY": "socks5://attacker.invalid:1080",
            "CURL_HOME": "/attacker-controlled/curl-home",
            "TEST_API_CHECK_RESULT": "true" if check_result else "false",
            "TEST_API_PROGRAM_NAME": program_name,
        }
    )
    if token is None:
        env.pop("SUPERVISOR_TOKEN", None)
    else:
        env["SUPERVISOR_TOKEN"] = token

    return subprocess.run(
        [bash, str(harness), str(library), str(mock_curl), *arguments],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def test_mock_success_returns_pretty_json(api_harness: tuple[str, Path, Path]) -> None:
    result = run_api(api_harness, "GET", "/states", body='{"value":1}')

    assert result.returncode == 0
    assert '"value": 1' in result.stdout
    assert result.stderr == ""
    assert TOKEN not in result.stdout + result.stderr


def test_supervisor_self_options_are_recursively_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    synthetic_bot_token = "synthetic-telegram-bot-token-should-never-print"
    synthetic_password = "synthetic-password-should-never-print"
    body = (
        '{"result":"ok","data":{"options":'
        f'{{"telegram_bot_token":"{synthetic_bot_token}",'
        f'"nested":{{"password":"{synthetic_password}"}},'
        '"telegram_enabled":true}}}'
    )
    result = run_api(
        api_harness,
        "GET",
        "/addons/self/options",
        body=body,
        check_result=True,
        program_name="supervisor-api",
    )

    assert result.returncode == 0
    assert synthetic_bot_token not in result.stdout + result.stderr
    assert synthetic_password not in result.stdout + result.stderr
    assert result.stdout.count("[REDACTED]") >= 1
    assert '"data": "[REDACTED]"' in result.stdout


@pytest.mark.parametrize(
    "path",
    [
        "/addons/self/options",
        "/apps/example/config",
        "/v2/apps/self/options/config",
    ],
)
def test_direct_supervisor_options_and_config_responses_redact_whole_data(
    api_harness: tuple[str, Path, Path], path: str
) -> None:
    synthetic_option = "synthetic-benign-direct-option-should-never-print"
    result = run_api(
        api_harness,
        "--raw",
        "GET",
        f"{path}?verbose=true",
        body=(
            '{"result":"ok","data":'
            f'{{"innocent_label":"{synthetic_option}"}}'
            "}"
        ),
        check_result=True,
        program_name="supervisor-api",
    )

    assert result.returncode == 0
    assert synthetic_option not in result.stdout + result.stderr
    assert '"data":"[REDACTED]"' in result.stdout


@pytest.mark.parametrize("path", ["/addons/self/info", "/v2/apps/self/info"])
def test_non_json_supervisor_info_response_is_fail_closed(
    api_harness: tuple[str, Path, Path], path: str
) -> None:
    synthetic_option = "synthetic-non-json-option-should-never-print"
    result = run_api(
        api_harness,
        "GET",
        f"{path}?verbose=true",
        body=f"innocent_label={synthetic_option}",
        status="500",
        program_name="supervisor-api",
    )

    assert result.returncode == 1
    assert synthetic_option not in result.stdout + result.stderr
    assert result.stderr.endswith("[REDACTED]\n")


def test_raw_json_cannot_bypass_sensitive_response_redaction(
    api_harness: tuple[str, Path, Path]
) -> None:
    synthetic_api_key = "synthetic-api-key-should-never-print"
    result = run_api(
        api_harness,
        "--raw",
        "GET",
        "/addons/self/info",
        body=f'{{"result":"ok","data":{{"api_key":"{synthetic_api_key}"}}}}',
        check_result=True,
        program_name="supervisor-api",
    )

    assert result.returncode == 0
    assert synthetic_api_key not in result.stdout + result.stderr
    assert '"api_key":"[REDACTED]"' in result.stdout


@pytest.mark.parametrize("raw_arg", [(), ("--raw",)])
@pytest.mark.parametrize("path", ["/addons/self/info", "/v2/apps/self/info"])
def test_query_cannot_bypass_whole_options_redaction_for_benign_keys(
    api_harness: tuple[str, Path, Path], raw_arg: tuple[str, ...], path: str
) -> None:
    synthetic_option = "synthetic-benign-option-secret-should-never-print"
    result = run_api(
        api_harness,
        *raw_arg,
        "GET",
        f"{path}?verbose=true",
        body=(
            '{"result":"ok","data":{"options":'
            f'{{"innocent_label":"{synthetic_option}"}}'
            "}}"
        ),
        check_result=True,
        program_name="supervisor-api",
    )

    assert result.returncode == 0
    assert synthetic_option not in result.stdout + result.stderr
    if raw_arg:
        assert '"options":"[REDACTED]"' in result.stdout
    else:
        assert '"options": "[REDACTED]"' in result.stdout


@pytest.mark.parametrize(
    ("method", "path", "expected_code"),
    [
        ("GET", "/backups/fixture/download", 77),
        ("GET", "/v2/backups/fixture/download", 77),
        ("POST", "/ingress/session", 77),
        ("POST", "/v2/ingress/session", 77),
        ("POST", "/ingress/validate_session", 77),
        ("GET", "/core/logs", 77),
        ("GET", "/v2/core/logs", 77),
        ("GET", "/supervisor/logs", 77),
        ("GET", "/v2/supervisor/logs", 77),
        ("GET", "/homeassistant/logs/latest", 77),
        ("GET", "/dns/logs/boots/current", 77),
        ("GET", "/audio/logs/follow", 77),
        ("GET", "/multicast/logs", 77),
        ("GET", "/host/logs/identifiers/audit", 77),
        ("GET", "/v2/host/logs/identifiers/audit", 77),
        ("GET", "/addons/example/logs/latest", 77),
        ("GET", "/v2/apps/example/logs/latest", 77),
        ("GET", "/backups/fixture/../secret/download", 64),
        ("GET", "/backups/%66ixture/download", 64),
        ("GET", "/backups//fixture/download", 64),
        ("GET", r"/backups\fixture\download", 64),
    ],
)
def test_supervisor_sensitive_endpoints_and_noncanonical_bypasses_fail_before_request(
    api_harness: tuple[str, Path, Path],
    method: str,
    path: str,
    expected_code: int,
) -> None:
    result = run_api(
        api_harness,
        method,
        path,
        body="archive-or-session-secret-must-not-print",
        program_name="supervisor-api",
    )

    assert result.returncode == expected_code
    assert "archive-or-session-secret-must-not-print" not in (
        result.stdout + result.stderr
    )
    assert not (api_harness[1].parent / "curl-called").exists()


@pytest.mark.parametrize(
    "path",
    [
        "/../../addons/self/info",
        "/%2e%2e/%2e%2e/addons/self/info",
        r"/..\../addons/self/info",
    ],
)
def test_ha_api_rejects_cross_namespace_path_traversal_before_request(
    api_harness: tuple[str, Path, Path], path: str
) -> None:
    result = run_api(
        api_harness,
        "GET",
        path,
        body="cross-namespace-secret-must-not-print",
        program_name="ha-api",
    )

    assert result.returncode == 64
    assert "cross-namespace-secret-must-not-print" not in (
        result.stdout + result.stderr
    )
    assert not (api_harness[1].parent / "curl-called").exists()


@pytest.mark.parametrize(
    ("program_name", "method", "path"),
    [
        ("ha-api", "GET", "/states/sensor.api_token"),
        ("ha-api", "GET", "/history/period/2026-08-19"),
        ("ha-api", "GET", "/logbook/2026-08-19"),
        ("ha-api", "GET", "/error_log"),
        ("ha-api", "GET", "/stream"),
        ("ha-api", "GET", "/events"),
        ("ha-api", "GET", "/camera_proxy/camera.private"),
        ("ha-api", "POST", "/template"),
        ("supervisor-api", "GET", "/core/api/states/sensor.api_token"),
        ("supervisor-api", "GET", "/homeassistant/api/error_log"),
        ("supervisor-api", "GET", "/v2/core/api/states/sensor.api_token"),
        ("supervisor-api", "POST", "/v2/core/api/template"),
    ],
)
def test_secret_prone_raw_core_reads_require_the_projected_broker(
    api_harness: tuple[str, Path, Path], program_name: str, method: str, path: str
) -> None:
    result = run_api(
        api_harness,
        method,
        path,
        body="plain-unkeyed-secret-must-not-print",
        program_name=program_name,
    )

    assert result.returncode == 77
    assert "plain-unkeyed-secret-must-not-print" not in result.stdout + result.stderr
    assert not (api_harness[1].parent / "curl-called").exists()


@pytest.mark.parametrize(
    ("program_name", "path"),
    [
        ("supervisor-api", "/v2/core/api/state[s-s]"),
        ("supervisor-api", "/backups/fixture/downloa[d-d]"),
        ("supervisor-api", "/ingres{s,s}/session"),
        ("supervisor-api", "/core/log[s-s]"),
        ("ha-api", "/state[s-s]"),
    ],
)
def test_curl_url_glob_syntax_cannot_bypass_sensitive_endpoint_policy(
    api_harness: tuple[str, Path, Path], program_name: str, path: str
) -> None:
    result = run_api(
        api_harness,
        "GET",
        path,
        body="sensitive-endpoint-glob-canary",
        program_name=program_name,
    )

    assert result.returncode == 64
    assert "sensitive-endpoint-glob-canary" not in result.stdout + result.stderr
    assert not (api_harness[1].parent / "curl-called").exists()


def test_camel_case_credential_keys_are_redacted(api_harness: tuple[str, Path, Path]) -> None:
    canaries = {
        "accessToken": "ACCESS_TOKEN_CANARY",
        "refreshToken": "REFRESH_TOKEN_CANARY",
        "authorizationCode": "AUTH_CODE_CANARY",
        "webhookId": "WEBHOOK_CANARY",
    }
    result = run_api(
        api_harness,
        "GET",
        "/safe-projected-fixture",
        body=str(canaries).replace("'", '"'),
    )

    assert result.returncode == 0
    for canary in canaries.values():
        assert canary not in result.stdout + result.stderr
    assert result.stdout.count("[REDACTED]") == len(canaries)


def test_unkeyed_common_credential_shapes_are_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    synthetic_github_token = "".join(("gh", "p_", "a" * 30))
    synthetic_telegram_token = "".join(("123456789:", "A" * 36))
    synthetic_aws_access_key = "".join(("AK", "IA", "A" * 16))
    synthetic_google_key = "".join(("AI", "za", "a" * 35))
    synthetic_slack_token = "".join(("xo", "xb-1234567890-", "a" * 16))
    synthetic_stripe_key = "".join(("sk_", "live_", "a" * 24))
    canaries = [
        "Basic dTpw",
        "Basic dXNlcjpwYXNzd29yZA==",
        "Basic mode Basic dTpw",
        "https://user:password@example.invalid/path",
        synthetic_telegram_token,
        synthetic_github_token,
        synthetic_aws_access_key,
        synthetic_google_key,
        synthetic_slack_token,
        synthetic_stripe_key,
    ]
    result = run_api(
        api_harness,
        "GET",
        "/safe-projected-fixture",
        body=json.dumps({"ordinary_values": canaries}),
    )

    assert result.returncode == 0
    for canary in canaries:
        assert canary not in result.stdout + result.stderr
    assert result.stdout.count("[REDACTED]") == len(canaries)


def test_noncredential_key_substrings_are_not_overredacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    ordinary = {
        "author": "Ada",
        "keyboard": "compact",
        "monkey": "capuchin",
        "compass": "north",
        "passage": "open",
        "decode": "complete",
        "statusCode": "ok",
        "errorCode": "none",
        "countryCode": "KR",
        "refresh": "complete",
        "basicStatus": "Basic authentication enabled",
        "basicMode": "Basic mode2",
        "bearerStatus": "Bearer authentication enabled",
    }
    result = run_api(
        api_harness,
        "GET",
        "/safe-projected-fixture",
        body=str(ordinary).replace("'", '"'),
    )

    assert result.returncode == 0
    assert "[REDACTED]" not in result.stdout
    for value in ordinary.values():
        assert value in result.stdout


def test_canonical_query_is_preserved_for_non_sensitive_endpoint(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "GET",
        "/core/info?verbose=true%20fixture",
        body='{"value":1}',
    )

    assert result.returncode == 0
    assert '"value": 1' in result.stdout


def test_mock_http_error_is_nonzero_and_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "POST",
        "/services/light/turn_on",
        "{}",
        body=f'{{"message":"request rejected for {TOKEN}"}}',
        status="403",
    )

    assert result.returncode != 0
    assert "HTTP 403" in result.stderr
    assert "[REDACTED]" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_supervisor_result_error_is_nonzero_and_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "POST",
        "/core/check",
        "{}",
        body=f'{{"result":"error","message":"failure {TOKEN}"}}',
        check_result=True,
    )

    assert result.returncode != 0
    assert "Supervisor result was not ok" in result.stderr
    assert "[REDACTED]" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_supervisor_json_without_result_is_nonzero(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "GET",
        "/core/info",
        body='{"data":{}}',
        check_result=True,
    )

    assert result.returncode != 0
    assert "missing the result field" in result.stderr


def test_supervisor_raw_response_may_omit_result(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "--raw",
        "--accept",
        "text/x-log",
        "GET",
        "/core/logs",
        body="plain log line",
        check_result=True,
        expected_accept="text/x-log",
    )

    assert result.returncode == 0
    assert result.stdout == "plain log line\n"


def test_accept_option_rejects_header_injection_without_request(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "--accept",
        "text/x-log\r\nX-Injected: true",
        "GET",
        "/core/logs",
    )

    assert result.returncode == 64
    assert "unsupported Accept media type" in result.stderr


def test_missing_token_fails_without_invoking_request(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(api_harness, "GET", "/config", token=None)

    assert result.returncode == 78
    assert "SUPERVISOR_TOKEN is unavailable" in result.stderr


def test_transport_error_does_not_disclose_token(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(api_harness, "GET", "/config", curl_exit="7")

    assert result.returncode == 69
    assert "transport failed" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_api_helper_wrappers_select_expected_result_policy(rootfs: Path) -> None:
    ha_api = (rootfs / "usr/local/bin/ha-api").read_text(encoding="utf-8")
    supervisor_api = (rootfs / "usr/local/bin/supervisor-api").read_text(
        encoding="utf-8"
    )

    assert "API_CHECK_RESULT=false" in ha_api
    assert "API_CHECK_RESULT=true" in supervisor_api
    assert "readonly API_BASE_URL=http://supervisor/core/api" in ha_api
    assert "readonly API_BASE_URL=http://supervisor" in supervisor_api
    assert "HA_URL" not in ha_api
    assert "SUPERVISOR_URL" not in supervisor_api
    assert "readonly API_CURL_BIN=/usr/bin/curl" in ha_api
    assert "readonly API_CURL_BIN=/usr/bin/curl" in supervisor_api
    assert "api_main \"$@\"" in ha_api
    assert "api_main \"$@\"" in supervisor_api


def test_api_transport_ignores_caller_routing_environment(rootfs: Path) -> None:
    environment = (
        rootfs / "usr/local/lib/antigravity-ha/environment.sh"
    ).read_text(encoding="utf-8")
    client = (
        rootfs / "usr/local/lib/antigravity-ha/api-client.sh"
    ).read_text(encoding="utf-8")
    sshd = (rootfs / "etc/ssh/sshd_config").read_text(encoding="utf-8")

    assert 'HA_URL="${HA_URL:-' not in environment
    assert 'SUPERVISOR_URL="${SUPERVISOR_URL:-' not in environment
    assert "CURL_BIN:-" not in client
    assert "/usr/bin/env -i" in client
    assert "--disable" in client
    assert "--noproxy '*'" in client
    assert "--proto '=http'" in client
    permit_environment = next(
        line for line in sshd.splitlines() if line.startswith("PermitUserEnvironment ")
    )
    assert "HA_URL" not in permit_environment
    assert "SUPERVISOR_URL" not in permit_environment


def test_log_helpers_use_only_the_token_isolated_sanitized_broker(rootfs: Path) -> None:
    core_logs = (rootfs / "usr/local/bin/ha-core-logs").read_text(encoding="utf-8")
    addon_logs = (rootfs / "usr/local/bin/ha-addon-logs").read_text(
        encoding="utf-8"
    )

    for helper in (core_logs, addon_logs):
        assert "supervisor-api" not in helper
        assert "/usr/local/share/antigravity-ha/ha-read-log-cli.mjs" in helper
        assert "SUPERVISOR_TOKEN" in helper
        assert "/usr/bin/env -i" in helper
    assert 'core "${1:-200}"' in core_logs
    assert 'addon "$1" "${2:-200}"' in addon_logs
