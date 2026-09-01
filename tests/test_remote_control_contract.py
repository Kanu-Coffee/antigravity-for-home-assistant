import os
import stat
import subprocess
from pathlib import Path


S6_REMOTE = Path("etc/s6-overlay/s6-rc.d/antigravity-remote")
RUNTIME = Path("usr/local/libexec/ha-antigravity-remote-runtime")
LOGIN = Path("usr/local/bin/ha-antigravity-remote-login")
SERIALIZATION_SMOKE = Path("tests/remote-login-serialization-smoke.sh")
SERIALIZATION_FIXTURE = Path("tests/fixtures/fake-remote-control-agy")


def test_remote_control_s6_service_contract(rootfs: Path) -> None:
    service = rootfs / S6_REMOTE

    assert (service / "type").read_text(encoding="utf-8").strip() == "longrun"
    assert (service / "dependencies.d/antigravity-ha-init").is_file()
    assert (rootfs / "etc/s6-overlay/s6-rc.d/user/contents.d/antigravity-remote").is_file()

    run = (service / "run").read_text(encoding="utf-8")
    finish = (service / "finish").read_text(encoding="utf-8")
    assert run.startswith("#!/command/with-contenv bashio\n")
    assert "unset SUPERVISOR_TOKEN" in run
    assert "exec /usr/bin/env --default-signal=INT --default-signal=QUIT -i" in run
    assert "TERM=xterm-256color" in run
    assert "/usr/local/libexec/ha-antigravity-remote-runtime" in run
    assert "retrying in 5s" in finish


def test_remote_runtime_uses_official_headless_contract(rootfs: Path) -> None:
    runtime = (rootfs / RUNTIME).read_text(encoding="utf-8")

    assert "readonly REMOTE_TOKEN=${GEMINI_HOME}/jetski-standalone-oauth-token" in runtime
    assert "readonly MIN_REMOTE_PORT=4400" in runtime
    assert "readonly MAX_REMOTE_PORT=4499" in runtime
    assert '"/dev/tcp/127.0.0.1/${port}"' in runtime
    assert (
        "/usr/local/bin/agy \\\n"
        "      --remote-control \\\n"
        '      --hub-port "${port}" \\\n'
        '      --remote-control-name "${name}"'
    ) in runtime
    assert "remote_control_name" in runtime
    assert "readonly DEFAULT_REMOTE_NAME=home-assistant" in runtime
    assert runtime.count('--remote-control-name "${name}"') == 1
    assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in runtime
    assert "< /dev/null" in runtime
    assert "readonly SAFE_TERM=xterm-256color" in runtime
    assert "TERM=${SAFE_TERM}" in runtime
    assert 'TERM="${TERM' not in runtime


def test_remote_runtime_waits_for_safe_opaque_auth(rootfs: Path) -> None:
    runtime = (rootfs / RUNTIME).read_text(encoding="utf-8")

    assert "OAuth token is opaque and is never read" not in runtime
    assert "The token is opaque and is never read" in runtime
    assert "${mode} != 600" in runtime
    assert "${links} != 1" in runtime
    assert "size > MAX_TOKEN_BYTES" in runtime
    assert "if (( size < 2 )); then" in runtime
    assert "printf 'pending\\n'" in runtime
    assert "${raw_mode} =~ ^8[0-9a-fA-F]{3}$" in runtime
    assert "'%f:%d:%i:%u:%g:%a:%h:%s:%Y:%Z'" in runtime
    assert "state=$(remote_token_state)" in runtime
    assert "stable_remote_token_state()" in runtime
    assert "Require a second independent unsafe observation" in runtime
    assert "OAuth token changed before Remote Control could start" in runtime
    assert "metadata is unsafe or unstable" in runtime
    assert "waiting for ha-antigravity-remote-login" in runtime
    assert "while true" in runtime
    assert "/bin/sleep 2" in runtime
    assert "absent | pending" in runtime
    assert "cat \"${REMOTE_TOKEN}\"" not in runtime
    assert "< \"${REMOTE_TOKEN}\"" not in runtime
    assert "sha256" not in runtime.split("remote_token_state()", 1)[1].split(
        "remote_name()", 1
    )[0]
    assert "jq" not in runtime.split("remote_token_state()", 1)[1].split(
        "remote_name()", 1
    )[0]


def test_remote_login_is_interactive_serialized_and_auto_starting(rootfs: Path) -> None:
    helper = (rootfs / LOGIN).read_text(encoding="utf-8")
    runtime = (rootfs / RUNTIME).read_text(encoding="utf-8")

    assert "Usage: ha-antigravity-remote-login" in helper
    assert "--exclusive" in runtime
    assert "--nonblock" in runtime
    assert "--close" not in helper
    assert "set -o noclobber" in runtime
    assert "'%f:%d:%i:%u:%g:%a:%h:%s'" in runtime
    assert "/usr/local/libexec/ha-antigravity-remote-runtime --login" in helper
    assert "login requires an authenticated interactive terminal" in runtime
    assert "! -t 0 || ! -t 1 || ! -t 2" in runtime
    assert "< /dev/tty" in runtime
    assert "2> /dev/tty" in runtime
    assert "while /bin/kill -0" in runtime
    assert "terminate_remote_cli()" in runtime
    assert "acquire_login_lock" in runtime
    assert 'readonly LOGIN_LOCK_FD=9' in runtime
    assert "9>&-" in runtime
    assert "attempt < 5" in runtime
    assert '/bin/kill -KILL "${pid}"' in runtime
    assert "The background service is starting automatically" in runtime
    assert "no App restart is required" in runtime


def test_remote_service_waits_until_interactive_login_has_fully_exited(
    rootfs: Path,
) -> None:
    runtime = (rootfs / RUNTIME).read_text(encoding="utf-8")
    service = runtime.split("service_main()", 1)[1].split("login_main()", 1)[0]

    assert "readonly LOGIN_LOCK=${RUNTIME_DIR}/remote-login.lock" in runtime
    assert "remote_login_state()" in runtime
    assert "exec {lock_fd}<>\"${LOGIN_LOCK}\"" in runtime
    assert "--exclusive --nonblock --conflict-exit-code 75" in runtime
    assert "state=active" in runtime
    assert "state=idle" in runtime
    assert "login_state=$(remote_login_state)" in service
    assert "ready:active)" in service
    assert "ready:idle | ready:absent)" in service
    assert service.index("login_state=$(remote_login_state)") < service.index(
        "launch_remote service"
    )


def test_remote_launches_with_clean_environment_and_no_cli_log_output(
    rootfs: Path,
) -> None:
    runtime = (rootfs / RUNTIME).read_text(encoding="utf-8")
    helper = (rootfs / LOGIN).read_text(encoding="utf-8")
    launch = runtime.split("launch_remote()", 1)[1].split("service_main()", 1)[0]

    assert "unset BASH_ENV CDPATH ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN" in runtime
    assert "IFS=$' \\t\\n'" in runtime
    assert "PATH=${SAFE_PATH}" in runtime
    assert (
        launch.count("/usr/bin/env --default-signal=INT --default-signal=QUIT -i")
        == 2
    )
    assert (
        "< /dev/null \\\n"
        "      > /dev/null \\\n"
        "      2>&1"
    ) in launch
    assert (
        "< /dev/tty \\\n"
        "    > /dev/tty \\\n"
        "    2> /dev/tty &"
    ) in launch
    for forbidden in (
        "SUPERVISOR_TOKEN=",
        "NODE_OPTIONS=",
        "NODE_PATH=",
        "LD_PRELOAD=",
        "PYTHONPATH=",
    ):
        assert forbidden not in launch

    assert "/usr/bin/env --default-signal=INT --default-signal=QUIT -i" in helper
    assert "HOME=/data/home" in helper
    assert "TERM=${SAFE_TERM}" in helper


def test_remote_options_and_packaging_integration(
    addon_root: Path, rootfs: Path, addon_config: dict
) -> None:
    assert addon_config["options"]["remote_control_name"] == "home-assistant"
    assert addon_config["schema"]["remote_control_name"] == (
        "match(^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$)"
    )

    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    assert (
        "readonly OPTIONS_SNAPSHOT=${RUNTIME_DIR}/ha-feedback-options.json"
        in init_script
    )
    assert (
        'remote_control_name: option_string("remote_control_name"; "home-assistant")'
        in init_script
    )
    assert 'test("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")' in init_script
    assert 'chmod 0600 "${options_tmp}"' in init_script
    assert "readonly REMOTE_LOGIN_LOCK=${RUNTIME_DIR}/remote-login.lock" in init_script
    assert 'install -m 0600 /dev/null "${REMOTE_LOGIN_LOCK}"' in init_script

    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert "/etc/s6-overlay/s6-rc.d/antigravity-remote/run" in dockerfile
    assert "/etc/s6-overlay/s6-rc.d/antigravity-remote/finish" in dockerfile
    assert "/usr/local/bin/*" in dockerfile
    assert "/usr/local/libexec/*" in dockerfile


def test_remote_shell_entrypoints_are_executable_and_parse(rootfs: Path) -> None:
    paths = (
        S6_REMOTE / "run",
        S6_REMOTE / "finish",
        RUNTIME,
        LOGIN,
    )
    for relative_path in paths:
        path = rootfs / relative_path
        if os.name != "nt":
            assert path.stat().st_mode & stat.S_IXUSR, path
        subprocess.run(["bash", "-n", str(path)], check=True)


def test_remote_login_serialization_smoke_contract(repository_root: Path) -> None:
    smoke_path = repository_root / SERIALIZATION_SMOKE
    fixture_path = repository_root / SERIALIZATION_FIXTURE
    smoke = smoke_path.read_text(encoding="utf-8")

    assert smoke_path.stat().st_mode & stat.S_IXUSR
    assert fixture_path.stat().st_mode & stat.S_IXUSR
    subprocess.run(["bash", "-n", str(smoke_path)], check=True)
    subprocess.run(["bash", "-n", str(fixture_path)], check=True)
    assert "/usr/local/bin/ha-antigravity-remote-login" in smoke
    assert "fake-remote-overlap-detected" in smoke
    assert "fake-remote-service-started" in smoke
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )
    assert "tests/remote-login-serialization-smoke.sh" in docker_smoke
