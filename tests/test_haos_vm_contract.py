"""Security and behavior contracts for host-side HAOS VM automation."""

from __future__ import annotations

import ast
import json
import os
import runpy
import shlex
import shutil
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

TOOL = "tools/development/haos-vm"
PINNED_VERSION = "18.2"
PINNED_SIZE = 535_936_800
PINNED_SHA256 = (
    "254e53f354df0739e3afc09be5431a07df53f0df6b703885404f665c454f254e"
)
OVERRIDE_PREFIX = "ANTIGRAVITY_HA_VM_"
TEST_MODE_ENV = "ANTIGRAVITY_HA_DEV_TEST_MODE"


def _source(repository_root: Path) -> str:
    return (repository_root / TOOL).read_text(encoding="utf-8")


def _namespace(repository_root: Path) -> SimpleNamespace:
    values = runpy.run_path(
        str(repository_root / TOOL),
        run_name="haos_vm_contract_module",
    )
    return SimpleNamespace(**values)


def _clean_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(OVERRIDE_PREFIX) and key != TEST_MODE_ENV
    }
    return environment


def _fake_executable(path: Path, marker: Path) -> None:
    path.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' called > {shlex.quote(str(marker))}\n"
        "exit 97\n",
        encoding="utf-8",
    )
    path.chmod(0o700)


def _function_source(source: str, name: str) -> str:
    tree = ast.parse(source)
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == name
    )
    segment = ast.get_source_segment(source, function)
    assert segment is not None
    return segment


def _guest_stage_simulator(
    module: SimpleNamespace,
    description: str,
    commands: list[tuple[str, ...]],
    *,
    malicious_path: Path | None = None,
    link_kind: str | None = None,
):
    directory = module.GUEST_LOCAL_APP_DIRECTORY
    marker = module.GUEST_APP_MARKER
    config = module.GUEST_APP_CONFIG
    existing = {str(directory), str(marker), str(config)}
    created: set[str] = set()

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        *,
        input_bytes: bytes | None = None,
        check: bool = True,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        commands.append(arguments)

        def completed(returncode: int, stdout: bytes = b""):
            result = subprocess.CompletedProcess(arguments, returncode, stdout, b"")
            if check and returncode != 0:
                raise module.VmError("simulated guest path check failed")
            return result

        command = arguments[0]
        if command == "test":
            tokens = list(arguments[1:])
            negate = bool(tokens and tokens[0] == "!")
            if negate:
                tokens.pop(0)
            flag, path = tokens[-2:]
            is_malicious = malicious_path is not None and path == str(malicious_path)
            if flag == "-e":
                truth = path in existing or path in created
            elif flag in {"-L", "-h"}:
                truth = is_malicious and link_kind == "symlink"
            elif flag == "-d":
                truth = path == str(directory)
            elif flag == "-f":
                truth = path in {str(marker), str(config)} or path in created
            else:
                raise AssertionError(f"unsupported simulated test flag: {arguments}")
            if negate:
                truth = not truth
            return completed(0 if truth else 1)

        if command == "stat":
            path = arguments[-1]
            is_malicious = malicious_path is not None and path == str(malicious_path)
            if is_malicious and link_kind == "symlink":
                file_type, links = "symbolic link", 1
            elif path == str(directory):
                file_type, links = "directory", 2
            else:
                file_type = "regular file"
                links = 2 if is_malicious and link_kind == "hardlink" else 1
            mode = "700" if path == str(directory) else "600"
            format_value = "%F:%h:%a:%u"
            for index, argument in enumerate(arguments):
                if argument in {"-c", "--format"} and index + 1 < len(arguments):
                    format_value = arguments[index + 1]
                elif argument.startswith("--format="):
                    format_value = argument.partition("=")[2]
            output = (
                format_value.replace("%F", file_type)
                .replace("%h", str(links))
                .replace("%a", mode)
                .replace("%u", "0")
                .replace("%U", "root")
                + "\n"
            )
            return completed(0, output.encode("utf-8"))

        if command == "readlink":
            path = arguments[-1]
            if (
                malicious_path is not None
                and path == str(malicious_path)
                and link_kind == "symlink"
            ):
                return completed(0, b"/tmp/foreign-target\n")
            return completed(1)

        if command == "realpath":
            return completed(0, (arguments[-1] + "\n").encode("utf-8"))
        if command == "cat":
            assert arguments[-1] == str(marker)
            return completed(0, (description + "\n").encode("ascii"))
        if command == "tee":
            target = arguments[-1]
            created.add(target)
            return completed(0, input_bytes or b"")
        if command == "chmod":
            return completed(0)
        if command == "mv":
            source_path, target_path = arguments[-2:]
            created.discard(source_path)
            created.add(target_path)
            existing.add(target_path)
            return completed(0)
        if command == "rm":
            created.discard(arguments[-1])
            return completed(0)
        if command == "mkdir":
            existing.add(arguments[-1])
            return completed(0)
        if command == "mktemp":
            temporary = str(directory / ".antigravity-haos-vm.test.tmp")
            created.add(temporary)
            return completed(0, (temporary + "\n").encode("ascii"))
        raise AssertionError(f"unsupported guest staging command: {arguments}")

    return fake_ssh_run


def test_haos_vm_asset_is_exactly_pinned_and_verified_before_promotion(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    source = _source(repository_root)
    tree = ast.parse(source)
    download = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_download_image"
    )
    download_source = ast.get_source_segment(source, download)
    assert download_source is not None

    assert module.HAOS_VERSION == PINNED_VERSION
    assert module.HAOS_IMAGE_NAME == f"haos_ova-{PINNED_VERSION}.qcow2.xz"
    assert module.HAOS_IMAGE_SIZE == PINNED_SIZE
    assert module.HAOS_IMAGE_SHA256 == PINNED_SHA256
    assert len(module.HAOS_IMAGE_SHA256) == 64
    assert module.HAOS_IMAGE_URL == (
        "https://github.com/home-assistant/operating-system/releases/download/"
        f"{PINNED_VERSION}/haos_ova-{PINNED_VERSION}.qcow2.xz"
    )
    assert '"--proto"' in download_source and '"=https"' in download_source
    assert '"--tlsv1.2"' in download_source

    digest_check = download_source.index(
        "_sha256_file(partial) != HAOS_IMAGE_SHA256"
    )
    permission_hardening = download_source.index("os.chmod(partial, 0o440)")
    atomic_promotion = download_source.index(
        "os.replace(partial, context.compressed_image)"
    )
    assert digest_check < permission_hardening < atomic_promotion
    qcow2_validation = download_source.index(
        "_validate_base_image_path(\n            context,\n            partial_base,"
    )
    base_promotion = download_source.index(
        "os.replace(partial_base, context.base_image)"
    )
    assert digest_check < qcow2_validation < base_promotion
    assert "qemu-img" in source
    assert "backing-filename" in source


def test_curl_disables_user_config_first_and_caps_download_size(
    repository_root: Path,
) -> None:
    source = _source(repository_root)
    download_source = _function_source(source, "_download_image")
    tree = ast.parse(download_source)
    curl_arguments: ast.List | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.List) or not node.elts:
            continue
        first = node.elts[0]
        if not isinstance(first, ast.Call) or not isinstance(first.func, ast.Attribute):
            continue
        if (
            first.func.attr == "binary"
            and first.args
            and isinstance(first.args[0], ast.Constant)
            and first.args[0].value == "curl"
        ):
            curl_arguments = node
            break

    assert curl_arguments is not None
    assert isinstance(curl_arguments.elts[1], ast.Constant)
    assert curl_arguments.elts[1].value == "--disable"
    rendered = [ast.unparse(argument) for argument in curl_arguments.elts]
    maximum_index = rendered.index("'--max-filesize'")
    assert "HAOS_IMAGE_SIZE" in rendered[maximum_index + 1]


def test_up_requires_explicit_outbound_ack_before_any_libvirt_call(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "checkout"
    tool = checkout / TOOL
    tool.parent.mkdir(parents=True)
    shutil.copy2(repository_root / TOOL, tool)
    subprocess.run(
        ["git", "init", "--quiet", str(checkout)],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    marker = tmp_path / "virsh-called"
    fake_virsh = tmp_path / "virsh"
    _fake_executable(fake_virsh, marker)
    state_parent = tmp_path / "state-parent"
    state_parent.mkdir(mode=0o700)

    environment = _clean_environment()
    environment.update(
        {
            TEST_MODE_ENV: "1",
            "ANTIGRAVITY_HA_VM_VIRSH_BIN": str(fake_virsh),
            "ANTIGRAVITY_HA_VM_STATE_ROOT": str(state_parent / "state"),
            "ANTIGRAVITY_HA_VM_RUNTIME_ROOT": str(tmp_path / "runtime"),
        }
    )
    result = subprocess.run(
        [str(tool), "up"],
        cwd=checkout,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 64
    assert "--allow-outbound-network" in result.stderr
    assert "not isolated" in result.stderr
    assert not marker.exists(), "virsh ran before the network acknowledgement"
    assert not (tmp_path / "runtime").exists()
    assert not (state_parent / "state").exists()


def test_production_rejects_all_test_overrides_before_tool_execution(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    marker = tmp_path / "override-called"
    override = tmp_path / "virsh-override"
    _fake_executable(override, marker)
    environment = _clean_environment()
    environment["ANTIGRAVITY_HA_VM_VIRSH_BIN"] = str(override)

    rejected = subprocess.run(
        [str(repository_root / TOOL), "check"],
        cwd=repository_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert rejected.returncode == 64
    assert "overrides require" in rejected.stderr
    assert f"{TEST_MODE_ENV}=1" in rejected.stderr
    assert not marker.exists()


def test_app_stage_requires_guest_mutation_ack_before_docker_or_libvirt(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "checkout"
    tool = checkout / TOOL
    tool.parent.mkdir(parents=True)
    shutil.copy2(repository_root / TOOL, tool)
    subprocess.run(
        ["git", "init", "--quiet", str(checkout)],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    virsh_marker = tmp_path / "virsh-called"
    docker_marker = tmp_path / "docker-called"
    fake_virsh = tmp_path / "virsh"
    fake_docker = tmp_path / "docker"
    _fake_executable(fake_virsh, virsh_marker)
    _fake_executable(fake_docker, docker_marker)
    state_parent = tmp_path / "state-parent"
    state_parent.mkdir(mode=0o700)

    environment = _clean_environment()
    environment.update(
        {
            TEST_MODE_ENV: "1",
            "ANTIGRAVITY_HA_VM_VIRSH_BIN": str(fake_virsh),
            "ANTIGRAVITY_HA_VM_DOCKER_BIN": str(fake_docker),
            "ANTIGRAVITY_HA_VM_STATE_ROOT": str(state_parent / "state"),
            "ANTIGRAVITY_HA_VM_RUNTIME_ROOT": str(tmp_path / "runtime"),
        }
    )
    result = subprocess.run(
        [str(tool), "app-stage"],
        cwd=checkout,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 64
    assert "--allow-guest-mutation" in result.stderr
    assert not virsh_marker.exists()
    assert not docker_marker.exists()
    assert not (tmp_path / "runtime").exists()
    assert not (state_parent / "state").exists()


def test_status_evidence_is_non_device_non_release_and_secret_free(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    module = _namespace(repository_root)

    class AbsentContext:
        state_file = tmp_path / "missing-state.json"
        checkout_id = "0123456789ab"
        domain_name = "antigravity-haos-0123456789ab"

        def virsh(self, *arguments: str, check: bool = True):
            del check
            return subprocess.CompletedProcess(arguments, 1, b"", b"")

    evidence = module._status_evidence(AbsentContext())
    assert evidence["schema"] == "antigravity-ha-haos-vm-evidence/v1"
    assert evidence["environment_kind"] == "haos_vm"
    assert evidence["real_haos_device"] is False
    assert evidence["release_evidence_eligible"] is False
    assert evidence["network"] == {
        "kind": "shared_system_nat",
        "name": "default",
        "isolated": False,
        "guest_outbound_possible": True,
        "guest_host_and_lan_access_possible": True,
    }

    sanitized = module._safe_guest_result(
        "os-info",
        {
            "result": "ok",
            "data": {
                "board": "ova",
                "version": PINNED_VERSION,
                "supervisor_token": "must-not-escape",
                "access_token": "must-not-escape",
                "authorized_keys": "must-not-escape",
                "private_key": "must-not-escape",
            },
        },
    )
    assert sanitized == {
        "result": "ok",
        "data": {"board": "ova", "version": PINNED_VERSION},
    }
    serialized = json.dumps({"evidence": evidence, "probe": sanitized}).lower()
    for forbidden in (
        "must-not-escape",
        "supervisor_token",
        "access_token",
        "authorized_keys",
        "private_key",
        "ssh_key",
    ):
        assert forbidden not in serialized


def test_app_staging_builds_exact_amd64_image_and_streams_only_that_image(
    repository_root: Path,
) -> None:
    source = _source(repository_root)
    build = _function_source(source, "_build_app_image")
    stream = _function_source(source, "_stream_app_image")
    source_config = _function_source(source, "_source_app_config")
    string_constants = {
        node.value
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }

    assert (
        'context.repository_root / "tools" / "development" / "build-app"'
        in build
    )
    assert '[build_helper, "build", temporary_tag, "linux/amd64"]' in build
    assert 'context.binary("docker"), "image", "save", image_tag' in stream
    assert '[*_ssh_base(context, address), "docker", "image", "load"]' in stream
    assert "stdin=save_process.stdout" in stream
    assert "save_process.stdout.close()" in stream
    assert "stderr=subprocess.DEVNULL" in stream
    assert "context.repository_root" not in stream
    assert "print(load_stdout" not in stream
    assert "print(load_stderr" not in stream

    assert (
        'context.repository_root / "antigravity_home_assistant" / "config.yaml"'
        in source_config
    )
    assert "/var/run/docker.sock" not in source
    assert "docker.sock" not in source
    for forbidden_command in ("scp", "rsync", "tar", "journalctl", "logs"):
        assert forbidden_command not in string_constants


def test_guest_app_directory_and_owner_marker_are_exact_and_fail_closed(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    expected_directory = Path(
        "/mnt/data/supervisor/apps/local/antigravity_home_assistant"
    )
    expected_marker = expected_directory / ".antigravity-haos-vm-owner"
    assert module.SOURCE_APP_SLUG == "antigravity_home_assistant"
    assert module.LOCAL_APP_SLUG == "local_antigravity_home_assistant"
    assert module.GUEST_APP_CONTAINER == "app_local_antigravity_home_assistant"
    assert module.GUEST_LOCAL_APP_DIRECTORY == expected_directory
    assert module.GUEST_APP_MARKER == expected_marker
    assert module.GUEST_APP_CONFIG == expected_directory / "config.yaml"

    calls: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        calls.append(arguments)
        if arguments[0:2] == ("test", "-L"):
            return subprocess.CompletedProcess(arguments, 1, b"", b"")
        if arguments == ("test", "-e", str(expected_directory)):
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        if arguments == ("test", "-e", str(expected_marker)):
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        if arguments[0:3] == ("stat", "-c", "%F:%u:%a:%h"):
            metadata = (
                b"directory:0:700:2\n"
                if arguments[-1] == str(expected_directory)
                else b"regular file:0:600:1\n"
            )
            return subprocess.CompletedProcess(arguments, 0, metadata, b"")
        if arguments == ("cat", str(expected_marker)):
            return subprocess.CompletedProcess(arguments, 0, b"foreign-owner\n", b"")
        raise AssertionError(f"unexpected mutation after foreign marker: {arguments}")

    monkeypatch.setitem(
        module._stage_guest_app_files.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    context = SimpleNamespace(
        description="managed-by=expected-checkout",
        checkout_id="0123456789ab",
    )
    with pytest.raises(module.VmError, match="not owned by this checkout"):
        module._stage_guest_app_files(
            context,
            "192.0.2.2",
            app={"version": "1.0.0-haosvm.0123456789ab"},
        )
    assert calls[-1] == ("cat", str(expected_marker))
    assert not any(arguments[0] in {"tee", "mv"} for arguments in calls)


@pytest.mark.parametrize(
    ("target_name", "link_kind"),
    (
        ("directory", "symlink"),
        ("marker", "symlink"),
        ("marker", "hardlink"),
        ("config", "symlink"),
        ("config", "hardlink"),
    ),
)
def test_guest_staging_rejects_linked_directory_marker_and_config(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    target_name: str,
    link_kind: str,
) -> None:
    module = _namespace(repository_root)
    description = "managed-by=antigravity-haos-vm/v1;checkout=" + "c" * 64
    targets = {
        "directory": module.GUEST_LOCAL_APP_DIRECTORY,
        "marker": module.GUEST_APP_MARKER,
        "config": module.GUEST_APP_CONFIG,
    }
    commands: list[tuple[str, ...]] = []
    fake_ssh_run = _guest_stage_simulator(
        module,
        description,
        commands,
        malicious_path=targets[target_name],
        link_kind=link_kind,
    )
    monkeypatch.setitem(
        module._stage_guest_app_files.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    context = SimpleNamespace(
        description=description,
        checkout_id="0123456789ab",
        checkout_identity="c" * 64,
        repository_root=repository_root,
    )
    with pytest.raises(module.VmError):
        module._stage_guest_app_files(
            context,
            "192.0.2.2",
            app={"version": "1.0.0-haosvm.0123456789ab"},
        )
    assert not any(
        arguments[0] in {"tee", "chmod", "mv", "mkdir"}
        for arguments in commands
    )


def test_guest_staging_writes_private_temps_then_atomically_renames(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    description = "managed-by=antigravity-haos-vm/v1;checkout=" + "d" * 64
    commands: list[tuple[str, ...]] = []
    monkeypatch.setitem(
        module._stage_guest_app_files.__globals__,
        "_ssh_run",
        _guest_stage_simulator(module, description, commands),
    )
    context = SimpleNamespace(
        description=description,
        checkout_id="0123456789ab",
        checkout_identity="d" * 64,
        repository_root=repository_root,
    )
    module._stage_guest_app_files(
        context,
        "192.0.2.2",
        app={"version": "1.0.0-haosvm.0123456789ab"},
    )

    final_paths = {str(module.GUEST_APP_MARKER), str(module.GUEST_APP_CONFIG)}
    tee_targets = [arguments[-1] for arguments in commands if arguments[0] == "tee"]
    assert len(tee_targets) == 2
    assert not final_paths.intersection(tee_targets)
    for target in tee_targets:
        temporary = Path(target)
        assert temporary.parent == module.GUEST_LOCAL_APP_DIRECTORY
        assert temporary.name.startswith(".")
        assert ".tmp" in temporary.name

    rename_targets = {
        arguments[-1]
        for arguments in commands
        if arguments[0] == "mv"
    }
    assert rename_targets == final_paths


def test_app_evidence_remains_non_device_non_release_and_allowlisted(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    source = _source(repository_root)
    for function_name in ("_app_stage", "_app_smoke"):
        function = _function_source(source, function_name)
        assert '"environment_kind": "haos_vm"' in function
        assert '"real_haos_device": False' in function
        assert '"release_evidence_eligible": False' in function

    safe = module._safe_app_info(
        {
            "result": "ok",
            "data": {
                "slug": "local_antigravity_home_assistant",
                "state": "started",
                "version": "1.0.0-haosvm.0123456789ab",
                "supervisor_token": "must-not-escape",
                "options": {"credential": "must-not-escape"},
                "logs": "must-not-escape",
            },
        }
    )
    assert safe == {
        "result": "ok",
        "data": {
            "slug": "local_antigravity_home_assistant",
            "state": "started",
            "version": "1.0.0-haosvm.0123456789ab",
        },
    }
    assert "must-not-escape" not in json.dumps(safe)


def test_guest_and_app_evidence_keep_only_known_safe_scalar_values(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    token_canary = "SUPERVISOR_TOKEN=contract-canary-secret"
    oversized = "OVERSIZED_VALUE_CANARY:" + "x" * 5000

    guest = module._safe_guest_result(
        "core-info",
        {
            "result": token_canary,
            "data": {
                "machine": token_canary,
                "version": "2026.8.0",
                "version_latest": {"nested": token_canary},
                "state": oversized,
                "update_available": False,
                "port": 8123,
            },
        },
    )
    app = module._safe_app_info(
        {
            "result": token_canary,
            "data": {
                "name": token_canary,
                "repository": {"nested": token_canary},
                "webui": oversized,
                "slug": "local_antigravity_home_assistant",
                "state": "started",
                "version": "1.0.0-haosvm.0123456789ab",
                "installed": True,
                "ingress": False,
                "ingress_port": 8099,
            },
        }
    )

    assert guest.get("result") != token_canary
    assert guest.get("data") == {
        "port": 8123,
        "update_available": False,
        "version": "2026.8.0",
    }
    assert app.get("result") != token_canary
    assert app.get("data") == {
        "ingress": False,
        "ingress_port": 8099,
        "installed": True,
        "slug": "local_antigravity_home_assistant",
        "state": "started",
        "version": "1.0.0-haosvm.0123456789ab",
    }
    serialized = json.dumps({"guest": guest, "app": app}, sort_keys=True)
    assert token_canary not in serialized
    assert "OVERSIZED_VALUE_CANARY" not in serialized
    assert "nested" not in serialized


def test_ha_features_are_known_enums_and_jobs_expose_only_a_count(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    token_canary = "SUPERVISOR_TOKEN=feature-job-canary"
    feature_result = module._safe_guest_result(
        "ha-info",
        {
            "result": "ok",
            "data": {
                "machine": "qemux86-64",
                "features": [
                    "reboot",
                    "network",
                    token_canary,
                    {"nested": token_canary},
                    "x" * 5000,
                ],
            },
        },
    )
    jobs_result = module._safe_guest_result(
        "jobs",
        {
            "result": "ok",
            "data": {
                "ignore_conditions": {"nested": token_canary},
                "jobs": [
                    {
                        "name": token_canary,
                        "reference": token_canary,
                        "stage": "running",
                    },
                    {
                        "name": "x" * 5000,
                        "reference": {"nested": token_canary},
                        "stage": token_canary,
                    },
                ],
            },
        },
    )

    features = feature_result.get("data", {}).get("features")
    assert features == ["network", "reboot"]
    assert jobs_result.get("data") == {"job_count": 2}
    serialized = json.dumps(
        {"features": feature_result, "jobs": jobs_result},
        sort_keys=True,
    )
    assert token_canary not in serialized
    assert "nested" not in serialized
    assert "x" * 500 not in serialized


def test_guest_container_image_binding_uses_exact_docker_image_id(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    source = _source(repository_root)
    digest = "sha256:" + "a" * 64
    calls: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        calls.append(arguments)
        return subprocess.CompletedProcess(
            arguments,
            0,
            (digest + "\n").encode("ascii"),
            b"",
        )

    monkeypatch.setitem(
        module._guest_image_id.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    result = module._guest_image_id(
        SimpleNamespace(),
        "192.0.2.2",
        kind="container",
        reference="app_local_antigravity_home_assistant",
    )
    assert result == digest
    assert calls == [
        (
            "docker",
            "container",
            "inspect",
            "--format={{.Image}}",
            "app_local_antigravity_home_assistant",
        )
    ]

    stage = _function_source(source, "_app_stage")
    smoke = _function_source(source, "_app_smoke")
    assert 'kind="container"' in stage
    assert 'if container_id != app["image_id"]' in stage
    assert 'kind="container"' in smoke
    assert (
        'guest_image_id != app["image_id"] or container_id != app["image_id"]'
        in smoke
    )


def test_guest_pull_registry_is_digest_pinned_loopback_only_and_exactly_owned(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    source = _source(repository_root)
    start = _function_source(source, "_start_guest_registry")
    cleanup = _function_source(source, "_cleanup_guest_registry")
    container_inventory = _function_source(source, "_guest_registry_container_id")
    volume_inventory = _function_source(source, "_guest_registry_volume_present")
    stage = _function_source(source, "_app_stage")

    registry_digest = (
        "46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
    )
    assert module.REGISTRY_IMAGE == f"registry:2.8.3@sha256:{registry_digest}"
    assert module.REGISTRY_IMAGE_MANIFEST_SHA256 == registry_digest
    assert module.GUEST_REGISTRY_REPOSITORY == (
        "localhost:5000/antigravity-for-home-assistant"
    )
    assert '"--platform=linux/amd64"' in start
    assert '"--publish=127.0.0.1:5000:5000"' in start
    assert "0.0.0.0:5000" not in start
    assert "io.antigravity-ha.haos-vm.registry=true" in start
    assert "context.checkout_identity" in start
    assert '["docker", "image", "push", guest_image_tag]' in start

    assert "_guest_label_filters(context)" in container_inventory
    assert "_guest_label_filters(context)" in volume_inventory
    assert '"--no-trunc"' in container_inventory
    assert '"container", "rm", "--force", container_name' not in cleanup
    assert '["docker", "container", "rm", "--force", container_id]' in cleanup
    assert '["docker", "volume", "rm", volume_name]' in cleanup
    assert "prune" not in cleanup
    assert "finally:" in stage
    assert "_cleanup_guest_registry(context, address)" in stage
    assert stage.index("try:") < stage.index("_stage_guest_app_files(")

    reuse = _function_source(source, "_reuse_exact_app_image")
    assert "TemporaryDirectory(" in reuse
    assert "dir=context.private_instance" in reuse


def test_registry_cleanup_confirms_absence_with_authoritative_filtered_lists(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    context = SimpleNamespace(
        checkout_id="0123456789ab",
        checkout_identity="a" * 64,
    )
    commands: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        commands.append(arguments)
        assert "rm" not in arguments
        if "inspect" in arguments:
            return subprocess.CompletedProcess(arguments, 1, b"", b"not found")
        if "ls" in arguments:
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        raise AssertionError(f"unexpected guest registry command: {arguments}")

    monkeypatch.setitem(
        module._cleanup_guest_registry.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    module._cleanup_guest_registry(context, "192.0.2.2")

    inventory_calls = [arguments for arguments in commands if "ls" in arguments]
    assert len(inventory_calls) == 6
    for resource_kind in ("container", "volume"):
        resource_calls = [
            arguments
            for arguments in inventory_calls
            if resource_kind in arguments
        ]
        assert len(resource_calls) == 3
        joined_calls = [" ".join(arguments) for arguments in resource_calls]
        assert any(
            "label=io.antigravity-ha.haos-vm.registry=true" in joined
            and (
                f"label=io.antigravity-ha.haos-vm.checkout="
                f"{context.checkout_identity}"
            )
            in joined
            for joined in joined_calls
        )
        assert any("label=io.antigravity-ha.haos-vm.registry" not in joined for joined in joined_calls)
        assert all("--format=" in joined for joined in joined_calls)


@pytest.mark.parametrize(
    ("list_returncode", "list_output"),
    (
        (255, b""),
        (0, b"__duplicate_exact_name__"),
    ),
)
def test_registry_cleanup_fails_closed_on_list_transport_or_non_exact_count(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    list_returncode: int,
    list_output: bytes,
) -> None:
    module = _namespace(repository_root)
    context = SimpleNamespace(
        checkout_id="0123456789ab",
        checkout_identity="b" * 64,
    )
    container_name, volume_name = module._guest_registry_names(context)
    commands: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        *,
        check: bool = True,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        commands.append(arguments)
        if "inspect" in arguments:
            return subprocess.CompletedProcess(arguments, 1, b"", b"not found")
        if "ls" in arguments:
            effective_output = list_output
            if list_output == b"__duplicate_exact_name__":
                exact_name = container_name if "container" in arguments else volume_name
                effective_output = f"{exact_name}\n{exact_name}\n".encode("ascii")
            result = subprocess.CompletedProcess(
                arguments,
                list_returncode,
                effective_output,
                b"transport failure" if list_returncode else b"",
            )
            if check and result.returncode != 0:
                raise module.VmError("simulated guest transport failure")
            return result
        raise AssertionError(f"unexpected or destructive command: {arguments}")

    monkeypatch.setitem(
        module._cleanup_guest_registry.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    with pytest.raises(module.VmError):
        module._cleanup_guest_registry(context, "192.0.2.2")
    assert any("ls" in arguments for arguments in commands)
    assert not any("rm" in arguments for arguments in commands)


def test_registry_cleanup_preserves_foreign_same_name_resource(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    context = SimpleNamespace(
        checkout_id="0123456789ab",
        checkout_identity="e" * 64,
    )
    container_name, volume_name = module._guest_registry_names(context)
    container_id = "1" * 64
    commands: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        commands.append(arguments)
        assert "rm" not in arguments
        owned_filter = any(
            argument.startswith("label=io.antigravity-ha.haos-vm.")
            for argument in arguments
        )
        if "container" in arguments and "ls" in arguments:
            row = f"{container_id}:{container_name}\n".encode("ascii")
            output = b"" if owned_filter else row
            return subprocess.CompletedProcess(arguments, 0, output, b"")
        if "volume" in arguments and "ls" in arguments:
            output = b"" if owned_filter else (volume_name + "\n").encode("ascii")
            return subprocess.CompletedProcess(arguments, 0, output, b"")
        if "container" in arguments and "inspect" in arguments:
            output = container_id if "{{.Id}}" in " ".join(arguments) else f"/{container_name}"
            return subprocess.CompletedProcess(
                arguments,
                0,
                (output + "\n").encode("ascii"),
                b"",
            )
        if "volume" in arguments and "inspect" in arguments:
            return subprocess.CompletedProcess(
                arguments,
                0,
                (volume_name + "\n").encode("ascii"),
                b"",
            )
        raise AssertionError(f"unexpected foreign registry command: {arguments}")

    monkeypatch.setitem(
        module._cleanup_guest_registry.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    with pytest.raises(module.VmError, match="owned|foreign"):
        module._cleanup_guest_registry(context, "192.0.2.2")
    assert not any("rm" in arguments for arguments in commands)


def test_registry_cleanup_deletes_owned_container_by_immutable_full_id(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    context = SimpleNamespace(
        checkout_id="0123456789ab",
        checkout_identity="f" * 64,
    )
    container_name, volume_name = module._guest_registry_names(context)
    container_id = "2" * 64
    present = {"container": True, "volume": True}
    commands: list[tuple[str, ...]] = []

    def fake_ssh_run(
        context,
        address: str,
        remote_arguments,
        **kwargs,
    ) -> subprocess.CompletedProcess[bytes]:
        del context, address, kwargs
        arguments = tuple(str(argument) for argument in remote_arguments)
        commands.append(arguments)
        if "container" in arguments and "ls" in arguments:
            output = (
                f"{container_id}:{container_name}\n"
                if present["container"]
                else ""
            )
            return subprocess.CompletedProcess(
                arguments,
                0,
                output.encode("ascii"),
                b"",
            )
        if "volume" in arguments and "ls" in arguments:
            output = volume_name + "\n" if present["volume"] else ""
            return subprocess.CompletedProcess(
                arguments,
                0,
                output.encode("ascii"),
                b"",
            )
        if "container" in arguments and "inspect" in arguments:
            if not present["container"]:
                return subprocess.CompletedProcess(arguments, 1, b"", b"not found")
            template = " ".join(arguments)
            output = container_id if "{{.Id}}" in template else f"/{container_name}"
            return subprocess.CompletedProcess(
                arguments,
                0,
                (output + "\n").encode("ascii"),
                b"",
            )
        if "volume" in arguments and "inspect" in arguments:
            if not present["volume"]:
                return subprocess.CompletedProcess(arguments, 1, b"", b"not found")
            return subprocess.CompletedProcess(
                arguments,
                0,
                (volume_name + "\n").encode("ascii"),
                b"",
            )
        if arguments[:4] == ("docker", "container", "rm", "--force"):
            assert arguments[4] == container_id
            present["container"] = False
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        if arguments[:3] == ("docker", "volume", "rm"):
            assert arguments[3] == volume_name
            present["volume"] = False
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        raise AssertionError(f"unexpected owned registry command: {arguments}")

    monkeypatch.setitem(
        module._cleanup_guest_registry.__globals__,
        "_ssh_run",
        fake_ssh_run,
    )
    module._cleanup_guest_registry(context, "192.0.2.2")
    assert not any(
        arguments[:5] == (
            "docker",
            "container",
            "rm",
            "--force",
            container_name,
        )
        for arguments in commands
    )
    assert (
        "docker",
        "container",
        "rm",
        "--force",
        container_id,
    ) in commands


def test_guest_ip_requires_exact_mac_and_membership_in_default_nat_cidr(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    exact_mac = "52:54:00:01:23:45"
    network_xml = b"""\
<network>
  <name>default</name>
  <forward mode="nat"/>
  <ip address="192.168.122.1" netmask="255.255.255.0">
    <dhcp><range start="192.168.122.2" end="192.168.122.254"/></dhcp>
  </ip>
</network>
"""

    class AddressContext:
        domain_name = "antigravity-haos-0123456789ab"
        mac_address = exact_mac

        def __init__(self, rows: bytes) -> None:
            self.rows = rows

        def virsh(self, *arguments: str, check: bool = True):
            del check
            if arguments[:2] == ("net-dumpxml", "default"):
                return subprocess.CompletedProcess(arguments, 0, network_xml, b"")
            if arguments[:2] == ("net-info", "default"):
                return subprocess.CompletedProcess(
                    arguments,
                    0,
                    b"Active: yes\nPersistent: yes\nAutostart: yes\n",
                    b"",
                )
            if arguments[0] == "net-list" and arguments[-1] == "--name":
                return subprocess.CompletedProcess(arguments, 0, b"default\n", b"")
            if arguments[:2] == ("domifaddr", self.domain_name):
                return subprocess.CompletedProcess(arguments, 0, self.rows, b"")
            if arguments[:2] == ("net-dhcp-leases", "default"):
                return subprocess.CompletedProcess(arguments, 0, self.rows, b"")
            raise AssertionError(f"unexpected address discovery call: {arguments}")

    mixed_rows = f"""\
vnet0 52:54:00:ff:ff:ff ipv4 192.168.122.50/24
vnet1 {exact_mac} ipv4 10.9.0.5/24
vnet2 {exact_mac} ipv4 192.168.122.77/24
""".encode("ascii")
    assert module._discover_guest_ip(AddressContext(mixed_rows)) == "192.168.122.77"

    outside_only = f"vnet0 {exact_mac} ipv4 10.9.0.5/24\n".encode("ascii")
    assert module._discover_guest_ip(AddressContext(outside_only)) is None


def test_system_default_nat_is_never_described_as_isolated(
    repository_root: Path,
) -> None:
    module = _namespace(repository_root)
    source = _source(repository_root)
    help_result = subprocess.run(
        [str(repository_root / TOOL), "--help"],
        cwd=repository_root,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert module.LIBVIRT_URI == "qemu:///system"
    assert module.LIBVIRT_NETWORK == "default"
    assert module.LIBVIRT_FILTER == "clean-traffic"
    assert help_result.returncode == 0
    help_text = " ".join(help_result.stdout.lower().split())
    assert "shared" in help_text
    assert "not isolated" in help_text
    assert "outbound/host/lan access" in help_text
    assert '"network_isolated": False' in source
    assert '"isolated": False' in source
    assert "network=shared-system-nat" in source


def test_cleanup_is_exactly_scoped_and_contains_no_global_prune(
    repository_root: Path,
) -> None:
    source = _source(repository_root)
    normalized = " ".join(source.split()).lower()
    tree = ast.parse(source)

    for forbidden in (
        "--remove-all-storage",
        "net-destroy",
        "net-undefine",
        "net-define",
        "net-start",
        "net-autostart",
        "destroy --all",
        "undefine --all",
        "rm -rf",
        "shutil.rmtree",
        "docker system prune",
        "buildx prune",
        "volume prune",
        "image prune",
    ):
        assert forbidden not in normalized

    destructive_calls: list[tuple[str, ast.Call]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr != "virsh" or not node.args:
            continue
        operation = node.args[0]
        if isinstance(operation, ast.Constant) and operation.value in {
            "destroy",
            "undefine",
        }:
            destructive_calls.append((operation.value, node))

    assert {operation for operation, _ in destructive_calls} == {
        "destroy",
        "undefine",
    }
    for operation, call in destructive_calls:
        assert len(call.args) >= 2, operation
        assert ast.unparse(call.args[1]) == "context.domain_name"
        if operation == "undefine":
            assert any(
                isinstance(argument, ast.Constant)
                and argument.value == "--keep-nvram"
                for argument in call.args[2:]
            )

    functions = {
        node.name: ast.get_source_segment(source, node) or ""
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
    }
    cleanup = functions["_cleanup_instance_files"]
    preflight = functions["_preflight_instance_files"]
    destroy = functions["_destroy"]
    rollback = functions["_rollback_new_instance"]
    assert "_preflight_instance_files(" in cleanup
    assert "_directory_has_only(" in preflight
    assert preflight.count("_validate_regular_file(") == 1
    assert cleanup.count("_secure_unlink(") == 3
    assert "_validate_domain(context, state)" in destroy
    assert destroy.index("_validate_domain(context, state)") < destroy.index(
        'context.virsh("undefine"'
    )
    assert "_validate_domain(context, state, require_uuid=False)" in rollback
    domain_names = functions["_domain_names"]
    assert 'context.virsh("list", "--all", "--name")' in domain_names


def test_destroy_preserves_everything_on_domain_inventory_transport_failure(
    repository_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    calls: list[tuple[str, ...]] = []
    cleanup_called = False

    class TransportFailureContext:
        domain_name = "antigravity-haos-0123456789ab"

        def prepare_directories(self) -> None:
            return

        def virsh(self, *arguments: str, check: bool = True):
            calls.append(arguments)
            result = subprocess.CompletedProcess(
                arguments,
                255,
                b"",
                b"libvirt transport unavailable",
            )
            if check:
                raise module.VmError("simulated libvirt transport failure")
            return result

    def fake_load_state(context, *, required: bool = True):
        del context, required
        return {"domain_uuid": "01234567-89ab-cdef-0123-456789abcdef"}

    def fail_if_cleanup_called(context) -> None:
        nonlocal cleanup_called
        del context
        cleanup_called = True

    globals_ = module._destroy.__globals__
    monkeypatch.setitem(globals_, "_load_state", fake_load_state)
    monkeypatch.setitem(globals_, "_cleanup_instance_files", fail_if_cleanup_called)
    monkeypatch.setitem(
        globals_,
        "_harden_legacy_instance_directory",
        lambda context: None,
    )
    with pytest.raises(module.VmError, match="transport failure"):
        module._destroy(
            TransportFailureContext(),
            timeout_seconds=10,
            force=False,
        )

    assert calls == [("list", "--all", "--name")]
    assert not cleanup_called
    assert not any(
        operation in {"destroy", "undefine"}
        for command in calls
        for operation in command
    )


@pytest.mark.parametrize("reference_view", ("current", "inactive"))
def test_foreign_domain_xml_referencing_managed_disks_preserves_files(
    repository_root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reference_view: str,
) -> None:
    module = _namespace(repository_root)
    instance = tmp_path / "instance"
    private_instance = tmp_path / "private"
    instance.mkdir()
    private_instance.mkdir()
    instance.chmod(module.RUNTIME_DIRECTORY_MODE)
    private_instance.chmod(0o700)
    overlay = instance / "system.qcow2"
    config_disk = instance / "CONFIG.ext4"
    nvram = instance / "OVMF_VARS.fd"
    ssh_key = private_instance / "id_ed25519"
    ssh_public_key = private_instance / "id_ed25519.pub"
    known_hosts = private_instance / "known_hosts"
    state_file = private_instance / "state.json"
    managed_modes = {
        overlay: 0o660,
        config_disk: 0o440,
        nvram: 0o660,
        ssh_key: 0o600,
        ssh_public_key: 0o600,
        known_hosts: 0o600,
        state_file: 0o600,
    }
    for path, mode in managed_modes.items():
        path.write_bytes(f"preserve:{path.name}".encode("ascii"))
        path.chmod(mode)

    domain_name = "antigravity-haos-0123456789ab"
    foreign_name = "foreign-domain"
    expected_uuid = "01234567-89ab-cdef-0123-456789abcdef"
    foreign_uuid = "fedcba98-7654-3210-fedc-ba9876543210"
    description = "managed-by=antigravity-haos-vm/v1;checkout=" + "a" * 64
    foreign_xml = f"""\
<domain type="kvm">
  <name>{foreign_name}</name>
  <uuid>{foreign_uuid}</uuid>
  <description>foreign unmanaged domain</description>
  <os><nvram>{nvram}</nvram></os>
  <devices>
    <disk type="file" device="disk"><source file="{overlay}"/></disk>
    <disk type="file" device="disk">
      <source file="{config_disk}"/><readonly/>
    </disk>
    <interface type="network">
      <mac address="52:54:00:01:23:45"/>
      <source network="default"/>
      <filterref filter="clean-traffic"/>
    </interface>
    <channel><target type="virtio" name="org.qemu.guest_agent.0"/></channel>
  </devices>
</domain>
""".encode()
    unreferencing_xml = f"""\
<domain type="kvm">
  <name>{foreign_name}</name>
  <uuid>{foreign_uuid}</uuid>
  <description>foreign unmanaged domain</description>
  <devices/>
</domain>
""".encode()
    calls: list[tuple[str, ...]] = []

    class ForeignDomainContext:
        mac_address = "52:54:00:01:23:45"

        def __init__(self) -> None:
            self.kvm_gid = os.getgid()
            self.domain_name = domain_name
            self.description = description
            self.overlay = overlay
            self.config_disk = config_disk
            self.nvram = nvram
            self.instance_directory = instance
            self.private_instance = private_instance
            self.ssh_key = ssh_key
            self.ssh_public_key = ssh_public_key
            self.known_hosts = known_hosts
            self.state_file = state_file
            self.runtime_owners = {os.getuid()}

        def prepare_directories(self) -> None:
            return

        def virsh(self, *arguments: str, check: bool = True):
            assert check is True
            calls.append(arguments)
            if arguments == ("list", "--all", "--name"):
                return subprocess.CompletedProcess(
                    arguments,
                    0,
                    (foreign_name + "\n").encode("ascii"),
                    b"",
                )
            if arguments == ("list", "--all", "--persistent", "--name"):
                return subprocess.CompletedProcess(
                    arguments,
                    0,
                    (foreign_name + "\n").encode("ascii"),
                    b"",
                )
            if arguments == ("dumpxml", foreign_name):
                payload = foreign_xml if reference_view == "current" else unreferencing_xml
                return subprocess.CompletedProcess(arguments, 0, payload, b"")
            if arguments == ("dumpxml", foreign_name, "--inactive"):
                payload = foreign_xml if reference_view == "inactive" else unreferencing_xml
                return subprocess.CompletedProcess(arguments, 0, payload, b"")
            raise AssertionError(f"destructive call reached foreign domain: {arguments}")

    def fake_load_state(context, *, required: bool = True):
        del context, required
        return {"domain_uuid": expected_uuid}

    monkeypatch.setitem(module._destroy.__globals__, "_load_state", fake_load_state)
    with pytest.raises(module.VmError, match="foreign|referenc|managed"):
        module._destroy(
            ForeignDomainContext(),
            timeout_seconds=10,
            force=True,
        )

    assert any(command[:2] == ("dumpxml", foreign_name) for command in calls)
    if reference_view == "inactive":
        assert ("dumpxml", foreign_name, "--inactive") in calls
    assert not any(command[0] in {"destroy", "undefine"} for command in calls)
    for path in managed_modes:
        assert path.is_file()
        assert path.read_bytes() == f"preserve:{path.name}".encode("ascii")


@pytest.mark.parametrize("link_kind", ("symlink", "hardlink"))
def test_cleanup_preflights_every_file_before_deleting_anything(
    repository_root: Path,
    tmp_path: Path,
    link_kind: str,
) -> None:
    module = _namespace(repository_root)
    instance = tmp_path / "runtime-instance"
    private_instance = tmp_path / "private-instance"
    instance.mkdir(mode=module.RUNTIME_DIRECTORY_MODE)
    private_instance.mkdir(mode=0o700)
    instance.chmod(module.RUNTIME_DIRECTORY_MODE)
    private_instance.chmod(0o700)

    overlay = instance / "system.qcow2"
    config_disk = instance / "CONFIG.ext4"
    nvram = instance / "OVMF_VARS.fd"
    ssh_key = private_instance / "id_ed25519"
    ssh_public_key = private_instance / "id_ed25519.pub"
    known_hosts = private_instance / "known_hosts"
    state_file = private_instance / "state.json"
    managed_modes = {
        overlay: 0o660,
        config_disk: 0o440,
        nvram: 0o660,
        ssh_key: 0o600,
        ssh_public_key: 0o600,
        state_file: 0o600,
    }
    expected_contents: dict[Path, bytes] = {}
    for path, mode in managed_modes.items():
        payload = f"preserve:{path.name}".encode("ascii")
        path.write_bytes(payload)
        path.chmod(mode)
        expected_contents[path] = payload

    link_target = tmp_path / "foreign-known-hosts"
    link_target.write_bytes(b"foreign")
    link_target.chmod(0o600)
    if link_kind == "symlink":
        known_hosts.symlink_to(link_target)
    else:
        os.link(link_target, known_hosts)

    context = SimpleNamespace(
        instance_directory=instance,
        private_instance=private_instance,
        overlay=overlay,
        config_disk=config_disk,
        nvram=nvram,
        ssh_key=ssh_key,
        ssh_public_key=ssh_public_key,
        known_hosts=known_hosts,
        state_file=state_file,
        runtime_owners={os.getuid()},
        kvm_gid=os.getgid(),
    )
    with pytest.raises(module.VmError, match="private regular file"):
        module._cleanup_instance_files(context)

    for path, expected in expected_contents.items():
        assert path.is_file(), f"deleted before late {link_kind} rejection: {path.name}"
        assert path.read_bytes() == expected
    assert known_hosts.exists()
    assert link_target.read_bytes() == b"foreign"


@pytest.mark.parametrize("link_kind", ("symlink", "hardlink"))
def test_inactive_domain_rejects_linked_overlay_before_qemu_img_inspection(
    repository_root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    link_kind: str,
) -> None:
    module = _namespace(repository_root)
    instance = tmp_path / "instance"
    instance.mkdir(mode=module.RUNTIME_DIRECTORY_MODE)
    instance.chmod(module.RUNTIME_DIRECTORY_MODE)
    private_instance = tmp_path / "private"
    private_instance.mkdir(mode=0o700)
    private_instance.chmod(0o700)

    overlay = instance / "system.qcow2"
    overlay_target = tmp_path / "foreign-overlay.qcow2"
    overlay_target.write_bytes(b"foreign overlay")
    overlay_target.chmod(0o660)
    if link_kind == "symlink":
        overlay.symlink_to(overlay_target)
    else:
        os.link(overlay_target, overlay)

    config_disk = instance / "CONFIG.ext4"
    config_disk.touch()
    config_disk.chmod(0o440)
    nvram = instance / "OVMF_VARS.fd"
    nvram.touch()
    nvram.chmod(0o660)
    base_image = tmp_path / "haos-base.qcow2"

    domain_name = "antigravity-haos-0123456789ab"
    description = "managed-by=antigravity-haos-vm/v1;checkout=" + "a" * 64
    domain_uuid = "01234567-89ab-cdef-0123-456789abcdef"
    mac_address = "52:54:00:01:23:45"
    inactive_xml = f"""\
<domain type="kvm">
  <name>{domain_name}</name>
  <uuid>{domain_uuid}</uuid>
  <description>{description}</description>
  <os><nvram>{nvram}</nvram></os>
  <devices>
    <disk type="file" device="disk"><source file="{overlay}"/></disk>
    <disk type="file" device="disk">
      <source file="{config_disk}"/><readonly/>
    </disk>
    <interface type="network">
      <mac address="{mac_address}"/><source network="default"/>
      <filterref filter="clean-traffic"/>
    </interface>
    <channel><target type="virtio" name="org.qemu.guest_agent.0"/></channel>
  </devices>
</domain>
""".encode()

    class LinkedOverlayContext:
        kvm_gid = os.getgid()

        def __init__(self) -> None:
            self.runtime_owners = {os.getuid()}
            self.domain_name = domain_name
            self.description = description
            self.mac_address = mac_address
            self.instance_directory = instance
            self.private_instance = private_instance
            self.overlay = overlay
            self.config_disk = config_disk
            self.nvram = nvram
            self.base_image = base_image

        def virsh(self, *arguments: str, check: bool = True):
            assert arguments == ("dumpxml", domain_name)
            assert check is True
            return subprocess.CompletedProcess(arguments, 0, inactive_xml, b"")

    qemu_img_called = False

    def fail_qemu_image_info(context, path: Path):
        nonlocal qemu_img_called
        del context, path
        qemu_img_called = True
        raise AssertionError("qemu-img must not inspect an untrusted overlay link")

    monkeypatch.setitem(
        module._validate_domain.__globals__,
        "_qemu_image_info",
        fail_qemu_image_info,
    )
    with pytest.raises(module.VmError, match="private regular file"):
        module._validate_domain(
            LinkedOverlayContext(),
            {"domain_uuid": domain_uuid},
        )

    assert qemu_img_called is False
    assert overlay_target.read_bytes() == b"foreign overlay"
    if link_kind == "symlink":
        assert overlay.is_symlink()
    else:
        assert overlay.stat().st_nlink == 2


def test_inactive_domain_without_backing_store_uses_qemu_img_fallback(
    repository_root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _namespace(repository_root)
    instance = tmp_path / "instance"
    instance.mkdir()
    instance.chmod(module.RUNTIME_DIRECTORY_MODE)
    private_instance = tmp_path / "private"
    private_instance.mkdir(mode=0o700)
    private_instance.chmod(0o700)
    overlay = instance / "system.qcow2"
    config_disk = instance / "CONFIG.ext4"
    nvram = instance / "OVMF_VARS.fd"
    base_image = tmp_path / "haos-base.qcow2"
    for path, mode in (
        (overlay, 0o660),
        (config_disk, 0o440),
        (nvram, 0o660),
    ):
        path.touch()
        path.chmod(mode)

    domain_name = "antigravity-haos-0123456789ab"
    description = "managed-by=antigravity-haos-vm/v1;checkout=" + "a" * 64
    domain_uuid = "01234567-89ab-cdef-0123-456789abcdef"
    mac_address = "52:54:00:01:23:45"
    inactive_xml = f"""\
<domain type="kvm">
  <name>{domain_name}</name>
  <uuid>{domain_uuid}</uuid>
  <description>{description}</description>
  <os><nvram>{nvram}</nvram></os>
  <devices>
    <disk type="file" device="disk">
      <source file="{overlay}"/>
    </disk>
    <disk type="file" device="disk">
      <source file="{config_disk}"/>
      <readonly/>
    </disk>
    <interface type="network">
      <mac address="{mac_address}"/>
      <source network="default"/>
      <filterref filter="clean-traffic"/>
    </interface>
    <channel><target type="virtio" name="org.qemu.guest_agent.0"/></channel>
  </devices>
</domain>
""".encode()

    class InactiveContext:
        def __init__(self) -> None:
            self.runtime_owners = {os.getuid()}
            self.kvm_gid = os.getgid()
            self.domain_name = domain_name
            self.description = description
            self.mac_address = mac_address
            self.instance_directory = instance
            self.private_instance = private_instance
            self.overlay = overlay
            self.config_disk = config_disk
            self.nvram = nvram
            self.base_image = base_image

        def virsh(self, *arguments: str, check: bool = True):
            assert arguments == ("dumpxml", domain_name)
            assert check is True
            return subprocess.CompletedProcess(arguments, 0, inactive_xml, b"")

    metadata = {
        "format": "qcow2",
        "full-backing-filename": str(base_image),
    }
    fallback_calls: list[Path] = []

    def fake_qemu_image_info(context, path: Path):
        assert isinstance(context, InactiveContext)
        fallback_calls.append(path)
        return metadata

    monkeypatch.setitem(
        module._validate_domain.__globals__,
        "_qemu_image_info",
        fake_qemu_image_info,
    )
    context = InactiveContext()
    validated = module._validate_domain(
        context,
        {"domain_uuid": domain_uuid},
    )
    assert validated.find("./devices/disk/backingStore") is None
    assert fallback_calls == [overlay]

    metadata["full-backing-filename"] = str(tmp_path / "foreign-base.qcow2")
    with pytest.raises(module.VmError, match="backing path does not match"):
        module._validate_domain(context, {"domain_uuid": domain_uuid})


def test_tool_is_executable_and_parser_rejects_invalid_arguments_with_ex_usage(
    repository_root: Path,
) -> None:
    tool = repository_root / TOOL
    assert tool.is_file()
    assert tool.stat().st_mode & stat.S_IXUSR
    assert tool.read_bytes().startswith(b"#!/usr/bin/env python3\n")

    for arguments in (
        (),
        ("not-a-command",),
        ("guest", "read-secrets"),
        ("up", "--memory-mib", "not-an-integer"),
    ):
        result = subprocess.run(
            [str(tool), *arguments],
            cwd=repository_root,
            env=_clean_environment(),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        assert result.returncode == 64, (arguments, result.stderr)
        assert "usage:" in result.stderr.lower()
