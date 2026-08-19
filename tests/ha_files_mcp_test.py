import errno
import io
import os
from pathlib import Path
from types import ModuleType


SOURCE = (
    Path(__file__).parents[1]
    / "antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-files-mcp.py"
)


def load_server():
    # Compile directly so source-tree tests never create a rootfs __pycache__
    # that could accidentally enter an App build context.
    module = ModuleType("ha_files_mcp")
    module.__file__ = str(SOURCE)
    source = SOURCE.read_text(encoding="utf-8")
    exec(compile(source, str(SOURCE), "exec"), module.__dict__)
    return module


def call(module, name: str, arguments: dict):
    response = module._handle(
        {
            "jsonrpc": "2.0",
            "id": "call",
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
    )
    assert response["id"] == "call"
    return response["result"]


def configure_roots(module, tmp_path: Path):
    config = tmp_path / "config"
    home = tmp_path / "home"
    share = tmp_path / "share"
    for directory in (config, home, share):
        directory.mkdir()
    module.ROOT_ROLES = {
        str(config): "config",
        str(home): "home",
        str(share): "ordinary",
    }
    module.SENSITIVE_READ_MARKER = str(tmp_path / "sensitive.enabled")
    return config, home, share


def test_mcp_lists_reads_and_atomically_writes_bounded_text(tmp_path: Path) -> None:
    module = load_server()
    config, _home, share = configure_roots(module, tmp_path)
    source = config / "configuration.yaml"
    source.write_text("homeassistant:\n  name: fixture\n", encoding="utf-8")

    initialized = module._handle(
        {
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05"},
        }
    )
    assert initialized["result"]["serverInfo"]["name"] == "antigravity-ha-files"
    listed_tools = module._handle(
        {"jsonrpc": "2.0", "id": "list", "method": "tools/list", "params": {}}
    )
    assert {tool["name"] for tool in listed_tools["result"]["tools"]} == {
        "ha_files_read_text",
        "ha_files_list",
        "ha_files_write_text",
    }

    read = call(module, "ha_files_read_text", {"path": str(source)})
    assert read["isError"] is False
    assert read["structuredContent"]["result"]["text"].endswith("name: fixture\n")
    previous_hash = read["structuredContent"]["result"]["sha256"]

    target = share / "automation-fragment.yaml"
    created = call(
        module,
        "ha_files_write_text",
        {"path": str(target), "text": "enabled: true\n"},
    )
    assert created["isError"] is False
    assert created["structuredContent"]["result"]["created"] is True
    assert target.read_text(encoding="utf-8") == "enabled: true\n"
    assert not list(share.glob(".ha-files-*.tmp"))

    replaced = call(
        module,
        "ha_files_write_text",
        {
            "path": str(source),
            "text": "homeassistant:\n  name: replaced\n",
            "expected_sha256": previous_hash,
        },
    )
    assert replaced["isError"] is False
    assert replaced["structuredContent"]["result"]["created"] is False
    assert source.read_text(encoding="utf-8").endswith("name: replaced\n")
    assert not list(config.glob(".ha-files-*.tmp"))

    conflict = call(
        module,
        "ha_files_write_text",
        {
            "path": str(source),
            "text": "must-not-land\n",
            "expected_sha256": "0" * 64,
        },
    )
    assert conflict["isError"] is True
    assert conflict["structuredContent"] == {"error": "conflict"}
    assert "must-not-land" not in source.read_text(encoding="utf-8")

    listing = call(module, "ha_files_list", {"path": str(config), "limit": 20})
    assert listing["isError"] is False
    assert {entry["name"] for entry in listing["structuredContent"]["result"]["entries"]} == {
        "configuration.yaml"
    }


def test_credentials_links_hardlinks_and_unsafe_types_fail_closed(
    tmp_path: Path,
) -> None:
    module = load_server()
    config, home, _share = configure_roots(module, tmp_path)
    storage = config / ".storage"
    storage.mkdir()
    storage_secret = storage / "core.config"
    storage_secret.write_text("STORAGE_SECRET_CANARY", encoding="utf-8")
    secrets_file = config / "secrets.yaml"
    secrets_file.write_text("SECRET_CANARY", encoding="utf-8")
    gemini = home / ".gemini" / "antigravity-cli"
    gemini.mkdir(parents=True)
    oauth = gemini / "oauth-unknown.json"
    oauth.write_text("OAUTH_SECRET_CANARY", encoding="utf-8")

    aliases = {
        config / "storage-alias": storage_secret,
        config / "secrets-alias": secrets_file,
        config / "oauth-alias": oauth,
    }
    for alias, target in aliases.items():
        alias.symlink_to(target)
        result = call(module, "ha_files_read_text", {"path": str(alias)})
        assert result["isError"] is True
        assert result["structuredContent"]["error"] == "unsafe_path"
        write = call(
            module,
            "ha_files_write_text",
            {"path": str(alias), "text": "tampered"},
        )
        assert write["isError"] is True
        assert write["structuredContent"]["error"] == "unsafe_path"
    assert storage_secret.read_text(encoding="utf-8") == "STORAGE_SECRET_CANARY"
    assert secrets_file.read_text(encoding="utf-8") == "SECRET_CANARY"
    assert oauth.read_text(encoding="utf-8") == "OAUTH_SECRET_CANARY"

    hardlink = config / "storage-hardlink"
    os.link(storage_secret, hardlink)
    hardlink_read = call(module, "ha_files_read_text", {"path": str(hardlink)})
    assert hardlink_read["isError"] is True
    assert hardlink_read["structuredContent"] == {"error": "unsafe_file"}
    hardlink_write = call(
        module,
        "ha_files_write_text",
        {"path": str(hardlink), "text": "tampered"},
    )
    assert hardlink_write["isError"] is True
    assert hardlink_write["structuredContent"] == {"error": "unsafe_file"}
    assert storage_secret.read_text(encoding="utf-8") == "STORAGE_SECRET_CANARY"

    fifo = config / "unsafe-fifo"
    os.mkfifo(fifo)
    fifo_read = call(module, "ha_files_read_text", {"path": str(fifo)})
    assert fifo_read["isError"] is True
    assert fifo_read["structuredContent"] == {"error": "unsafe_file"}

    for protected in (storage_secret, secrets_file, oauth):
        result = call(module, "ha_files_read_text", {"path": str(protected)})
        assert result["isError"] is True
        assert result["structuredContent"] == {"error": "access_denied"}
    listing = call(module, "ha_files_list", {"path": str(config), "limit": 20})
    names = {entry["name"] for entry in listing["structuredContent"]["result"]["entries"]}
    assert ".storage" not in names
    assert "secrets.yaml" not in names


def test_nested_credential_names_are_not_treated_as_ordinary_files(
    tmp_path: Path,
) -> None:
    module = load_server()
    config, home, _share = configure_roots(module, tmp_path)
    protected = (
        home / "workspace" / ".ssh" / "id_ed25519",
        home / "workspace" / ".gemini" / "oauth.json",
        home / "workspace" / ".config" / "gcloud" / "credentials.db",
        config / "package" / ".storage" / "credential",
    )
    for path in protected:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("NESTED_CREDENTIAL_CANARY", encoding="utf-8")
        result = call(module, "ha_files_read_text", {"path": str(path)})
        assert result["isError"] is True
        assert result["structuredContent"] == {"error": "access_denied"}


def test_atomic_replace_restores_the_destination_after_a_namespace_race(
    tmp_path: Path,
) -> None:
    module = load_server()
    config, _home, _share = configure_roots(module, tmp_path)
    target = config / "configuration.yaml"
    target.write_text("original: true\n", encoding="utf-8")
    original_exchange = module._exchange
    injected = False

    def racing_exchange(directory: int, temporary: str, leaf: str) -> None:
        nonlocal injected
        if not injected:
            injected = True
            os.rename(
                temporary,
                ".attacker-moved-helper-temp",
                src_dir_fd=directory,
                dst_dir_fd=directory,
            )
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=directory,
            )
            try:
                os.write(descriptor, b"attacker replacement\n")
            finally:
                os.close(descriptor)
        original_exchange(directory, temporary, leaf)

    module._exchange = racing_exchange
    result = call(
        module,
        "ha_files_write_text",
        {"path": str(target), "text": "must-not-land\n"},
    )
    assert injected is True
    assert result["isError"] is True
    assert result["structuredContent"] == {"error": "concurrent_change"}
    assert target.read_text(encoding="utf-8") == "original: true\n"


def test_path_normalization_recorder_write_and_request_validation(
    tmp_path: Path,
) -> None:
    module = load_server()
    config, _home, _share = configure_roots(module, tmp_path)
    recorder = config / "home-assistant_v2.db"
    recorder.write_text("RECORDER_CANARY", encoding="utf-8")

    for path in (
        str(config / ".." / "outside"),
        f"{config}//configuration.yaml",
        "relative.yaml",
    ):
        result = call(module, "ha_files_read_text", {"path": path})
        assert result["isError"] is True
        assert result["structuredContent"]["error"] == "invalid_path"

    recorder_read = call(
        module, "ha_files_read_text", {"path": str(recorder)}
    )
    assert recorder_read["isError"] is True
    assert recorder_read["structuredContent"] == {"error": "access_denied"}
    recorder_write = call(
        module,
        "ha_files_write_text",
        {"path": str(recorder), "text": "tampered"},
    )
    assert recorder_write["isError"] is True
    assert recorder_write["structuredContent"] == {"error": "access_denied"}
    assert recorder.read_text(encoding="utf-8") == "RECORDER_CANARY"

    invalid = call(
        module,
        "ha_files_read_text",
        {"path": str(config / "missing"), "unexpected": True},
    )
    assert invalid["isError"] is True
    assert invalid["structuredContent"] == {"error": "invalid_request"}


def test_raw_symlink_open_returns_eloop_before_content_is_read(tmp_path: Path) -> None:
    module = load_server()
    config, _home, _share = configure_roots(module, tmp_path)
    target = config / "target"
    target.write_text("CANARY", encoding="utf-8")
    alias = config / "alias"
    alias.symlink_to(target)
    parent, leaf = module._open_parent(str(alias))
    try:
        try:
            os.open(leaf, module._READ_FLAGS, dir_fd=parent)
        except OSError as error:
            assert error.errno == errno.ELOOP
        else:
            raise AssertionError("O_NOFOLLOW unexpectedly opened a symlink")
    finally:
        os.close(parent)


def test_repeated_reads_do_not_leak_the_pinned_file_descriptor(
    tmp_path: Path,
) -> None:
    module = load_server()
    config, _home, _share = configure_roots(module, tmp_path)
    target = config / "configuration.yaml"
    target.write_text("homeassistant:\n", encoding="utf-8")
    descriptor_directory = Path("/proc/self/fd")
    if not descriptor_directory.is_dir():
        return
    before = len(list(descriptor_directory.iterdir()))
    for _ in range(64):
        result = call(module, "ha_files_read_text", {"path": str(target)})
        assert result["isError"] is False
    after = len(list(descriptor_directory.iterdir()))
    assert after == before


def test_oversized_json_rpc_line_is_drained_with_a_real_memory_bound() -> None:
    module = load_server()
    module.MAX_REQUEST_BYTES = 64
    valid = b'{"jsonrpc":"2.0","method":"ping"}\n'
    stream = io.BytesIO((b"x" * 200) + b"\n" + valid)
    frames = list(module._bounded_request_lines(stream))
    assert frames == [None, valid]
