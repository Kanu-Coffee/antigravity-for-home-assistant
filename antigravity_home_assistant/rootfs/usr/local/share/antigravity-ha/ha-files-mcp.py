#!/usr/bin/python3
"""Image-managed MCP server for bounded ordinary file operations.

The native Antigravity file tools cannot safely mediate a symlink whose lexical
path is allowed but whose resolved target is a credential.  This server keeps
that boundary outside the native process: every component is opened relative
to a pinned directory descriptor with O_NOFOLLOW, regular files must have one
link, writes are staged in the target directory, and AppArmor independently
mediates the resolved inode path.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from typing import Any


SERVER_NAME = "antigravity-ha-files"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
DEFAULT_READ_BYTES = 256 * 1024
MAX_LIST_ENTRIES = 200
MAX_PATH_BYTES = 4096
SENSITIVE_READ_MARKER = "/run/antigravity-ha/sensitive-data-access.enabled"
ROOT_ROLES = {
    "/config": "config",
    "/share": "ordinary",
    "/media": "ordinary",
    "/data/home": "home",
    "/tmp": "ordinary",
    "/var/tmp": "ordinary",
}

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
_CREATE_FLAGS = (
    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
)
_RECORDER_NAME = re.compile(
    r"\.(?:db|sqlite|sqlite3)(?:$|[.\-~])", re.IGNORECASE
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_HOME_SECRET_COMPONENTS = frozenset(
    {".ssh", ".gnupg", ".aws", ".azure", ".kube"}
)
_HOME_SECRET_FILES = frozenset(
    {".netrc", ".npmrc", ".pypirc", ".git-credentials"}
)
_CONFIG_SECRET_COMPONENTS = frozenset(
    {".storage", ".ssh", ".cloud", "ssl", "backups"}
)


class FileBoundaryError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _normalize_path(value: Any) -> tuple[str, str, tuple[str, ...]]:
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise FileBoundaryError("invalid_path")
    if len(value.encode("utf-8")) > MAX_PATH_BYTES:
        raise FileBoundaryError("invalid_path")
    raw_parts = value.split("/")
    if raw_parts[0] != "" or any(part in {"", ".", ".."} for part in raw_parts[1:]):
        raise FileBoundaryError("invalid_path")
    if any(len(part.encode("utf-8")) > 255 for part in raw_parts[1:]):
        raise FileBoundaryError("invalid_path")
    normalized = "/" + "/".join(raw_parts[1:])
    for root in ROOT_ROLES:
        if normalized == root:
            return normalized, root, ()
        prefix = f"{root}/"
        if normalized.startswith(prefix):
            return normalized, root, tuple(normalized[len(prefix) :].split("/"))
    raise FileBoundaryError("access_denied")


def _is_recorder_path(root: str, relative: tuple[str, ...]) -> bool:
    return ROOT_ROLES[root] == "config" and bool(relative) and bool(
        _RECORDER_NAME.search(relative[-1])
    )


def _sensitive_read_enabled() -> bool:
    try:
        descriptor = os.open(SENSITIVE_READ_MARKER, _READ_FLAGS)
    except OSError:
        return False
    try:
        metadata = os.fstat(descriptor)
        return (
            stat.S_ISREG(metadata.st_mode)
            and metadata.st_uid == 0
            and metadata.st_nlink == 1
        )
    finally:
        os.close(descriptor)


def _assert_not_protected(
    root: str,
    relative: tuple[str, ...],
    *,
    write: bool,
) -> None:
    lowered = tuple(component.casefold() for component in relative)
    if ROOT_ROLES[root] == "home" and lowered:
        if ".gemini" in lowered or any(
            component in _HOME_SECRET_COMPONENTS for component in lowered
        ):
            raise FileBoundaryError("access_denied")
        if any(component in _HOME_SECRET_FILES for component in lowered):
            raise FileBoundaryError("access_denied")
        protected_pairs = {
            (".config", "gcloud"),
            (".config", "gh"),
            (".docker", "config.json"),
        }
        if any(
            lowered[index : index + 2] in protected_pairs
            for index in range(len(lowered) - 1)
        ):
            raise FileBoundaryError("access_denied")
    if ROOT_ROLES[root] == "config" and lowered:
        if any(
            component in _CONFIG_SECRET_COMPONENTS for component in lowered
        ):
            raise FileBoundaryError("access_denied")
        if lowered[-1] in {"secrets.yaml", "secrets.yml"}:
            raise FileBoundaryError("access_denied")
        if len(lowered) >= 3 and (
            lowered[:3] == (".agents", "plugins", "home-assistant")
            or lowered[:3] == ("_agents", "plugins", "home-assistant")
        ):
            raise FileBoundaryError("access_denied")
    if _is_recorder_path(root, relative):
        if write or not _sensitive_read_enabled():
            raise FileBoundaryError("access_denied")


def _open_directory(components: tuple[str, ...]) -> int:
    descriptor = os.open("/", _DIRECTORY_FLAGS)
    try:
        for component in components:
            next_descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _path_components(path: str) -> tuple[str, ...]:
    return tuple(path.removeprefix("/").split("/"))


def _open_parent(path: str) -> tuple[int, str]:
    components = _path_components(path)
    if len(components) < 2:
        raise FileBoundaryError("invalid_path")
    return _open_directory(components[:-1]), components[-1]


def _assert_safe_regular(metadata: os.stat_result) -> None:
    if not _is_safe_regular(metadata):
        raise FileBoundaryError("unsafe_file")


def _is_safe_regular(metadata: os.stat_result) -> bool:
    return stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1


def _same_snapshot(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_mode == after.st_mode
        and before.st_nlink == after.st_nlink
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and stat.S_IFMT(left.st_mode) == stat.S_IFMT(right.st_mode)
    )


def _same_replaced_file(left: os.stat_result, right: os.stat_result) -> bool:
    # A directory-entry exchange may advance ctime even though the pinned file
    # itself was not replaced or edited. Preserve every content-bearing and
    # alias-safety field while deliberately excluding that rename timestamp.
    return (
        _same_inode(left, right)
        and left.st_mode == right.st_mode
        and left.st_nlink == right.st_nlink
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
    )


def _read_descriptor(descriptor: int, limit: int) -> tuple[bytes, os.stat_result]:
    before = os.fstat(descriptor)
    _assert_safe_regular(before)
    if before.st_size > limit:
        raise FileBoundaryError("too_large")
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        chunk = os.read(descriptor, min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > limit:
        raise FileBoundaryError("too_large")
    after = os.fstat(descriptor)
    _assert_safe_regular(after)
    if not _same_snapshot(before, after):
        raise FileBoundaryError("concurrent_change")
    return b"".join(chunks), after


def _read_text(path_value: Any, max_bytes_value: Any) -> dict[str, Any]:
    path, root, relative = _normalize_path(path_value)
    _assert_not_protected(root, relative, write=False)
    if max_bytes_value is None:
        limit = DEFAULT_READ_BYTES
    elif (
        not isinstance(max_bytes_value, int)
        or isinstance(max_bytes_value, bool)
        or not 1 <= max_bytes_value <= MAX_TEXT_BYTES
    ):
        raise FileBoundaryError("invalid_request")
    else:
        limit = max_bytes_value
    parent, leaf = _open_parent(path)
    try:
        descriptor = os.open(leaf, _READ_FLAGS, dir_fd=parent)
        try:
            content, metadata = _read_descriptor(descriptor, limit)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise FileBoundaryError("not_utf8") from error
    if "\0" in text:
        raise FileBoundaryError("not_text")
    return {
        "path": path,
        "text": text,
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "mode": f"{stat.S_IMODE(metadata.st_mode) & 0o777:04o}",
    }


def _list_directory(path_value: Any, limit_value: Any) -> dict[str, Any]:
    path, root, relative = _normalize_path(path_value)
    _assert_not_protected(root, relative, write=False)
    if limit_value is None:
        limit = 100
    elif (
        not isinstance(limit_value, int)
        or isinstance(limit_value, bool)
        or not 1 <= limit_value <= MAX_LIST_ENTRIES
    ):
        raise FileBoundaryError("invalid_request")
    else:
        limit = limit_value
    directory = _open_directory(_path_components(path))
    entries: list[dict[str, Any]] = []
    truncated = False
    scanned = 0
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                scanned += 1
                if scanned > MAX_LIST_ENTRIES * 8:
                    truncated = True
                    break
                child_relative = relative + (entry.name,)
                try:
                    _assert_not_protected(root, child_relative, write=False)
                except FileBoundaryError:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISLNK(metadata.st_mode):
                    kind = "symlink"
                elif stat.S_ISDIR(metadata.st_mode):
                    kind = "directory"
                elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                    kind = "file"
                else:
                    kind = "unsafe"
                entries.append({"name": entry.name, "type": kind})
                if len(entries) > limit:
                    entries.pop()
                    truncated = True
                    break
    finally:
        os.close(directory)
    entries.sort(key=lambda item: item["name"])
    return {"path": path, "entries": entries, "truncated": truncated}


def _sync_directory(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EROFS}:
            raise


_LIBC = ctypes.CDLL(None, use_errno=True)
_RENAMEAT2 = getattr(_LIBC, "renameat2", None)
if _RENAMEAT2 is not None:
    _RENAMEAT2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    _RENAMEAT2.restype = ctypes.c_int
_RENAME_EXCHANGE = 2


def _exchange(directory: int, left: str, right: str) -> None:
    if _RENAMEAT2 is None:
        raise FileBoundaryError("atomic_replace_unavailable")
    result = _RENAMEAT2(
        directory,
        os.fsencode(left),
        directory,
        os.fsencode(right),
        _RENAME_EXCHANGE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _safe_unlink(directory: int, name: str, expected: os.stat_result) -> None:
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    if _same_inode(current, expected):
        os.unlink(name, dir_fd=directory)


def _restore_exchange(
    directory: int,
    temporary: str,
    leaf: str,
    installed: os.stat_result,
    displaced: os.stat_result,
) -> bool:
    """Reverse an exchange only while both directory entries remain pinned."""
    try:
        current_temporary = os.stat(
            temporary, dir_fd=directory, follow_symlinks=False
        )
        current_leaf = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not (
        _same_inode(current_temporary, displaced)
        and _same_inode(current_leaf, installed)
    ):
        return False
    _exchange(directory, temporary, leaf)
    return True


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        offset += written


def _write_text(
    path_value: Any,
    content_value: Any,
    expected_sha256_value: Any,
) -> dict[str, Any]:
    path, root, relative = _normalize_path(path_value)
    if not relative:
        raise FileBoundaryError("invalid_path")
    _assert_not_protected(root, relative, write=True)
    if not isinstance(content_value, str) or "\0" in content_value:
        raise FileBoundaryError("invalid_request")
    content = content_value.encode("utf-8")
    if len(content) > MAX_TEXT_BYTES:
        raise FileBoundaryError("too_large")
    if expected_sha256_value is not None and (
        not isinstance(expected_sha256_value, str)
        or not _SHA256.fullmatch(expected_sha256_value)
    ):
        raise FileBoundaryError("invalid_request")

    parent, leaf = _open_parent(path)
    old_descriptor: int | None = None
    temporary = f".ha-files-{secrets.token_hex(16)}.tmp"
    temporary_descriptor: int | None = None
    temporary_metadata: os.stat_result | None = None
    try:
        try:
            old_descriptor = os.open(leaf, _READ_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            old_descriptor = None
        old_metadata: os.stat_result | None = None
        mode = 0o644
        owner = os.geteuid()
        group = os.getegid()
        if old_descriptor is not None:
            old_metadata = os.fstat(old_descriptor)
            _assert_safe_regular(old_metadata)
            mode = stat.S_IMODE(old_metadata.st_mode) & 0o777
            owner = old_metadata.st_uid
            group = old_metadata.st_gid
            if expected_sha256_value is not None:
                previous, verified = _read_descriptor(
                    old_descriptor, MAX_TEXT_BYTES
                )
                if not _same_snapshot(old_metadata, verified):
                    raise FileBoundaryError("concurrent_change")
                if hashlib.sha256(previous).hexdigest() != expected_sha256_value:
                    raise FileBoundaryError("conflict")
        elif expected_sha256_value is not None:
            raise FileBoundaryError("conflict")

        temporary_descriptor = os.open(
            temporary, _CREATE_FLAGS, mode, dir_fd=parent
        )
        os.fchown(temporary_descriptor, owner, group)
        os.fchmod(temporary_descriptor, mode)
        _write_all(temporary_descriptor, content)
        os.fsync(temporary_descriptor)
        temporary_metadata = os.fstat(temporary_descriptor)
        _assert_safe_regular(temporary_metadata)

        # Pin both names immediately before the namespace mutation.  A process
        # with concurrent access to the ordinary directory may rename entries,
        # but it cannot make this helper silently operate on the replacement.
        current_temporary = os.stat(
            temporary, dir_fd=parent, follow_symlinks=False
        )
        _assert_safe_regular(current_temporary)
        if not _same_snapshot(temporary_metadata, current_temporary):
            raise FileBoundaryError("concurrent_change")
        if old_metadata is not None:
            current_old = os.fstat(old_descriptor)
            _assert_safe_regular(current_old)
            if not _same_snapshot(old_metadata, current_old):
                raise FileBoundaryError("concurrent_change")

        if old_metadata is None:
            try:
                os.link(
                    temporary,
                    leaf,
                    src_dir_fd=parent,
                    dst_dir_fd=parent,
                    follow_symlinks=False,
                )
            except FileExistsError as error:
                raise FileBoundaryError("concurrent_change") from error
            linked = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if not (
                stat.S_ISREG(linked.st_mode)
                and linked.st_nlink == 2
                and _same_inode(linked, temporary_metadata)
            ):
                _safe_unlink(parent, leaf, linked)
                raise FileBoundaryError("concurrent_change")
            os.unlink(temporary, dir_fd=parent)
            installed = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if not (
                _is_safe_regular(installed)
                and _same_inode(installed, temporary_metadata)
            ):
                raise FileBoundaryError("concurrent_change")
            try:
                os.lseek(temporary_descriptor, 0, os.SEEK_SET)
                verified_content, verified_metadata = _read_descriptor(
                    temporary_descriptor, MAX_TEXT_BYTES
                )
            except (FileBoundaryError, OSError) as error:
                _safe_unlink(parent, leaf, installed)
                raise FileBoundaryError("concurrent_change") from error
            if (
                verified_content != content
                or not _same_replaced_file(verified_metadata, installed)
            ):
                _safe_unlink(parent, leaf, installed)
                raise FileBoundaryError("concurrent_change")
        else:
            try:
                _exchange(parent, temporary, leaf)
            except FileNotFoundError as error:
                raise FileBoundaryError("concurrent_change") from error
            installed = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            displaced = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
            if not (
                _is_safe_regular(installed)
                and _same_inode(installed, temporary_metadata)
                and _same_replaced_file(displaced, old_metadata)
            ):
                # The exchange itself is atomic. Restore whichever exact pair
                # was exchanged if a concurrent rename replaced either name.
                _restore_exchange(
                    parent, temporary, leaf, installed, displaced
                )
                raise FileBoundaryError("concurrent_change")

            # Keep the new inode pinned through validation.  This catches a
            # hardlink or content mutation before the displaced old file is
            # unlinked, so the exchange can still be reversed safely.
            try:
                os.lseek(temporary_descriptor, 0, os.SEEK_SET)
                verified_content, verified_metadata = _read_descriptor(
                    temporary_descriptor, MAX_TEXT_BYTES
                )
            except (FileBoundaryError, OSError) as error:
                _restore_exchange(
                    parent, temporary, leaf, installed, displaced
                )
                raise FileBoundaryError("concurrent_change") from error
            if (
                verified_content != content
                or not _same_replaced_file(verified_metadata, installed)
            ):
                _restore_exchange(
                    parent, temporary, leaf, installed, displaced
                )
                raise FileBoundaryError("concurrent_change")
            os.unlink(temporary, dir_fd=parent)
        _sync_directory(parent)
        return {
            "path": path,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "created": old_metadata is None,
        }
    finally:
        if temporary_descriptor is not None:
            os.close(temporary_descriptor)
        if temporary_metadata is not None:
            _safe_unlink(parent, temporary, temporary_metadata)
        if old_descriptor is not None:
            os.close(old_descriptor)
        os.close(parent)


TOOLS = (
    {
        "name": "ha_files_read_text",
        "title": "Read one bounded ordinary text file",
        "description": (
            "Read UTF-8 text from an ordinary operational file without following "
            "links or crossing the managed credential and policy boundary."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_BYTES},
                "max_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_TEXT_BYTES,
                    "default": DEFAULT_READ_BYTES,
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "ha_files_list",
        "title": "List one bounded ordinary directory",
        "description": (
            "List bounded entry names and types without following links or "
            "showing protected credential and policy entries."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_BYTES},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIST_ENTRIES,
                    "default": 100,
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "ha_files_write_text",
        "title": "Atomically write one bounded ordinary text file",
        "description": (
            "Atomically create or replace an ordinary operational UTF-8 file. "
            "Optional expected_sha256 provides an optimistic concurrency check."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": MAX_PATH_BYTES},
                "text": {"type": "string"},
                "expected_sha256": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{64}$",
                },
            },
            "required": ["path", "text"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
)
_TOOL_NAMES = {tool["name"] for tool in TOOLS}


def _result(identifier: Any, value: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": identifier, "result": value}


def _rpc_error(identifier: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": identifier,
        "error": {"code": code, "message": message},
    }


def _tool_success(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(value, indent=2)}],
        "structuredContent": {"result": value},
        "isError": False,
    }


def _tool_error(code: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": f"File operation failed: {code}"}],
        "structuredContent": {"error": code},
        "isError": True,
    }


def _validate_call(message: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    params = message.get("params")
    if not _is_plain_object(params):
        raise FileBoundaryError("invalid_request")
    if any(key not in {"name", "arguments", "_meta"} for key in params):
        raise FileBoundaryError("invalid_request")
    name = params.get("name")
    arguments = params.get("arguments", {})
    if name not in _TOOL_NAMES or not _is_plain_object(arguments):
        raise FileBoundaryError("invalid_request")
    allowed = {
        "ha_files_read_text": {"path", "max_bytes"},
        "ha_files_list": {"path", "limit"},
        "ha_files_write_text": {"path", "text", "expected_sha256"},
    }[name]
    if any(key not in allowed for key in arguments):
        raise FileBoundaryError("invalid_request")
    return name, arguments


def _handle(message: Any) -> dict[str, Any] | None:
    if (
        not _is_plain_object(message)
        or message.get("jsonrpc") != "2.0"
        or not isinstance(message.get("method"), str)
    ):
        return _rpc_error(None, -32600, "Invalid Request")
    has_identifier = "id" in message
    identifier = message.get("id")
    method = message["method"]
    if method == "notifications/initialized" or not has_identifier:
        return None
    if method == "initialize":
        requested = message.get("params", {}).get("protocolVersion")
        if not isinstance(requested, str):
            requested = PROTOCOL_VERSION
        return _result(
            identifier,
            {
                "protocolVersion": requested,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "Bounded image-managed ordinary file tools. Native file tools "
                    "remain disabled; protected credentials, policy files, links, "
                    "multi-linked files, devices, and unsafe concurrent changes fail closed."
                ),
            },
        )
    if method == "ping":
        return _result(identifier, {})
    if method == "tools/list":
        return _result(identifier, {"tools": list(TOOLS)})
    if method != "tools/call":
        return _rpc_error(identifier, -32601, "Method not found")
    try:
        name, arguments = _validate_call(message)
        if name == "ha_files_read_text":
            value = _read_text(arguments.get("path"), arguments.get("max_bytes"))
        elif name == "ha_files_list":
            value = _list_directory(arguments.get("path"), arguments.get("limit"))
        else:
            value = _write_text(
                arguments.get("path"),
                arguments.get("text"),
                arguments.get("expected_sha256"),
            )
        return _result(identifier, _tool_success(value))
    except FileBoundaryError as error:
        return _result(identifier, _tool_error(error.code))
    except OSError as error:
        if error.errno == errno.ENOENT:
            code = "not_found"
        elif error.errno in {errno.EACCES, errno.EPERM}:
            code = "access_denied"
        elif error.errno in {errno.ELOOP, errno.ENOTDIR}:
            code = "unsafe_path"
        elif error.errno == errno.EEXIST:
            code = "concurrent_change"
        else:
            code = "operation_failed"
        return _result(identifier, _tool_error(code))


def _bounded_request_lines(stream: Any):
    """Yield bounded JSON-RPC lines; use None for one drained oversize line."""
    while True:
        raw_line = stream.readline(MAX_REQUEST_BYTES + 1)
        if raw_line == b"":
            return
        if len(raw_line) <= MAX_REQUEST_BYTES:
            yield raw_line
            continue

        # readline's limit prevents the oversized request from being retained
        # in memory. Drain only bounded chunks through its newline (or EOF) so
        # a later well-formed request can still be handled independently.
        while not raw_line.endswith(b"\n"):
            raw_line = stream.readline(MAX_REQUEST_BYTES + 1)
            if raw_line == b"":
                break
        yield None


def main() -> int:
    for key in (
        "SUPERVISOR_TOKEN",
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
    ):
        os.environ.pop(key, None)
    if len(sys.argv) != 1:
        return 64
    for raw_line in _bounded_request_lines(sys.stdin.buffer):
        if raw_line is None:
            response = _rpc_error(None, -32700, "Request exceeded the size limit")
        else:
            try:
                message = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                response = _rpc_error(None, -32700, "Parse error")
            else:
                response = _handle(message)
        if response is not None:
            encoded = json.dumps(
                response, ensure_ascii=True, separators=(",", ":")
            ).encode("ascii")
            sys.stdout.buffer.write(encoded + b"\n")
            sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0) from None
