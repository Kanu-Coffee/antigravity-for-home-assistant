"""Static integrity checks for the canonical v2 documentation package."""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import re
from collections import Counter
from collections.abc import Callable, Mapping
from pathlib import Path
from types import ModuleType
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
V2 = ROOT / "docs" / "v2"

REQUIREMENT_SOURCES = {
    "FR": V2 / "product-spec.md",
    "SEC": V2 / "security.md",
    "TG": V2 / "telegram-spec.md",
    "MIG": V2 / "migration-release.md",
}

REQUIREMENT_TOKEN = re.compile(r"\b(?:FR|SEC|TG|MIG)-\d{3}\b")
REQUIREMENT_HEADING = re.compile(
    r"^#{2,4}\s+((?:FR|SEC|TG|MIG)-\d{3})(?:\s|$)", re.MULTILINE
)
TEST_TOKEN = re.compile(r"\b(?:ST|AG|IM|HA|AA)-\d{3}\b")
TEST_TABLE_DECLARATION = re.compile(
    r"^\|\s*((?:ST|AG|IM)-\d{3})\s*\|", re.MULTILINE
)
TEST_HEADING_DECLARATION = re.compile(
    r"^#{2,4}\s+((?:HA|AA)-\d{3})(?:\s|$)", re.MULTILINE
)
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")

LINK_CHECK_FILES = (
    ROOT / "README.md",
    ROOT / "README.en.md",
    ROOT / "CONTRIBUTING.md",
    ROOT / "docs" / "README.md",
    ROOT / "docs" / "development" / "README.md",
    ROOT / "antigravity_home_assistant" / "DOCS.md",
    ROOT / "antigravity_home_assistant" / "DOCS.en.md",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def literal_assignment(path: Path, name: str) -> object:
    tree = ast.parse(read(path), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"missing literal assignment {name} in {path.relative_to(ROOT)}")


def load_python_module(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def requirement_declarations() -> dict[str, Path]:
    declarations: dict[str, Path] = {}
    for prefix, path in REQUIREMENT_SOURCES.items():
        identifiers = REQUIREMENT_HEADING.findall(read(path))
        assert identifiers, f"{path.relative_to(ROOT)} declares no {prefix} requirements"
        assert all(identifier.startswith(f"{prefix}-") for identifier in identifiers)
        duplicates = [item for item, count in Counter(identifiers).items() if count > 1]
        assert not duplicates, f"duplicate requirement declarations: {duplicates}"

        numbers = [int(identifier.rsplit("-", 1)[1]) for identifier in identifiers]
        assert numbers == list(range(1, len(numbers) + 1)), (
            f"{prefix} identifiers must be ordered and contiguous: {numbers}"
        )
        for identifier in identifiers:
            assert identifier not in declarations, f"duplicate requirement ID: {identifier}"
            declarations[identifier] = path
    return declarations


def declared_test_ids() -> set[str]:
    text = read(V2 / "test-plan.md")
    identifiers = TEST_TABLE_DECLARATION.findall(text)
    identifiers.extend(TEST_HEADING_DECLARATION.findall(text))
    duplicates = [item for item, count in Counter(identifiers).items() if count > 1]
    assert not duplicates, f"duplicate test ID declarations: {duplicates}"

    by_prefix: dict[str, list[int]] = {}
    for identifier in identifiers:
        prefix, number = identifier.split("-")
        by_prefix.setdefault(prefix, []).append(int(number))
    for prefix, numbers in by_prefix.items():
        assert numbers == list(range(1, len(numbers) + 1)), (
            f"{prefix} test identifiers must be ordered and contiguous: {numbers}"
        )
    return set(identifiers)


def traceability_map(path: Path) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for line in read(path).splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells or not re.fullmatch(r"(?:FR|SEC|TG|MIG)-\d{3}", cells[0]):
            continue
        requirement = cells[0]
        assert requirement not in result, (
            f"duplicate traceability row for {requirement} in {path.relative_to(ROOT)}"
        )
        tests = set(TEST_TOKEN.findall(cells[-1]))
        assert tests, f"{requirement} has no test IDs in {path.relative_to(ROOT)}"
        result[requirement] = tests
    return result


def test_requirement_ids_are_stable_unique_and_contiguous() -> None:
    declarations = requirement_declarations()
    all_v2_text = "\n".join(read(path) for path in sorted(V2.glob("*.md")))
    references = set(REQUIREMENT_TOKEN.findall(all_v2_text))
    unknown = references - set(declarations)
    assert not unknown, f"unknown v2 requirement references: {sorted(unknown)}"


def test_every_requirement_has_matching_test_plan_and_checklist_rows() -> None:
    requirements = set(requirement_declarations())
    plan = traceability_map(V2 / "test-plan.md")
    checklist = traceability_map(V2 / "checklist.md")

    assert set(plan) == requirements, (
        f"test-plan requirement orphans: missing={sorted(requirements - set(plan))}, "
        f"unknown={sorted(set(plan) - requirements)}"
    )
    assert set(checklist) == requirements, (
        f"checklist requirement orphans: missing={sorted(requirements - set(checklist))}, "
        f"unknown={sorted(set(checklist) - requirements)}"
    )
    assert plan == checklist, "test-plan and checklist test mappings differ"


def test_traceability_uses_only_declared_tests_and_no_test_is_orphaned() -> None:
    declared = declared_test_ids()
    plan = traceability_map(V2 / "test-plan.md")
    mapped = set().union(*plan.values())
    assert mapped == declared, (
        f"test ID traceability mismatch: undeclared={sorted(mapped - declared)}, "
        f"orphaned={sorted(declared - mapped)}"
    )

    checklist_references = set(TEST_TOKEN.findall(read(V2 / "checklist.md")))
    assert checklist_references <= declared, (
        f"checklist references undeclared tests: {sorted(checklist_references - declared)}"
    )

    all_v2_references = set(
        TEST_TOKEN.findall("\n".join(read(path) for path in sorted(V2.glob("*.md"))))
    )
    assert all_v2_references <= declared, (
        "v2 documents reference undeclared tests: "
        f"{sorted(all_v2_references - declared)}"
    )


def test_local_v2_markdown_links_resolve() -> None:
    failures: list[str] = []
    sources = sorted({*V2.glob("*.md"), *LINK_CHECK_FILES})
    for source in sources:
        for raw_target in MARKDOWN_LINK.findall(read(source)):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            path_part = unquote(target.split("#", 1)[0])
            resolved = (source.parent / path_part).resolve()
            if not resolved.exists():
                failures.append(f"{source.relative_to(ROOT)} -> {target}")
    assert not failures, "unresolved local Markdown links:\n" + "\n".join(failures)


def test_known_release_blockers_cannot_be_marked_verified() -> None:
    checklist = read(V2 / "checklist.md")
    normalized = re.sub(r"\s+", " ", checklist)
    assert "`TODO`, `IN_PROGRESS`, `BLOCKED`, `PARTIAL`, `VERIFIED`" in normalized
    readme = read(V2 / "README.md")
    assert "체크리스트 상태는 다음 다섯 값만 사용한다." in readme
    assert "| `PARTIAL` |" in readme
    for milestone in ("M3-03", "M5-07"):
        row = next(
            (line for line in checklist.splitlines() if line.startswith(f"| {milestone} |")),
            None,
        )
        assert row is not None, f"missing checklist row: {milestone}"
        assert "`VERIFIED`" not in row, f"{milestone} has an unresolved preview blocker"

    required_fragments = (
        "broker-generated secret-safe bounded structured diff",
        "expected SHA",
        "exact restore/recheck",
        "모든 App-managed broker config patch",
        "실제 HAOS safe change",
    )
    for fragment in required_fragments:
        assert fragment in normalized, f"missing release-blocker contract: {fragment}"

    test_plan = re.sub(r"\s+", " ", read(V2 / "test-plan.md"))
    for fragment in (
        "`119 passed`",
        "current working tree `158 passed`",
        "sha256:de1992f8c0df09a0b138a8c22659f68dc1e817079f6828149f68305df79ddb04",
        "sha256:89fbca725e87f93af8d93f136b520f9e99738882ba3db2d6dc5e8db0f4d38a2b",
        "sha256:3cac3dcc76ba9d1410d3aac2369431a0568841f340f6b9748824b307cbd087df",
        "sha256:1b63cf5afb9fb104426f94a1bdc9d6c3822c5fcc274a35515ee1d08fca17d82a",
        "installed `ha-memory` subprocess boundary",
        "managed-auth",
        "managed-plugin",
        "MCP/rules tamper fail-closed",
        "native arm64/HAOS | NOT RUN",
        "actual HAOS | NOT RUN",
    ):
        assert fragment in test_plan, f"test-plan omits current local evidence: {fragment}"


def test_native_oauth_residual_risk_is_not_claimed_as_isolated() -> None:
    security = read(V2 / "security.md")
    normalized = re.sub(r"\s+", " ", security)
    for fragment in (
        "Native OAuth 잔여 위험",
        "`HOME=/data/home`과 `/config`를 의도적으로 공유",
        "global 및 workspace plugin·agent·rule·MCP 상속을 제품 계약",
        "credential isolation 보장이 아니다",
        "release blocker",
    ):
        assert fragment in normalized, f"missing native OAuth residual-risk text: {fragment}"


def test_apparmor_docs_describe_discrete_px_profiles() -> None:
    documents = {
        path.relative_to(ROOT).as_posix(): re.sub(r"\s+", " ", read(path))
        for path in (
            V2 / "security.md",
            V2 / "architecture.md",
            ROOT / "antigravity_home_assistant" / "DOCS.md",
            ROOT / "antigravity_home_assistant" / "DOCS.en.md",
            ROOT / "antigravity_home_assistant" / "CHANGELOG.md",
        )
    }
    for name, text in documents.items():
        assert "`Px` transition" in text, (
            f"{name} does not identify the discrete Px transition"
        )
        assert not re.search(r"\bchild profiles?\b", text, re.IGNORECASE), (
            f"{name} incorrectly describes top-level Px targets as child profiles"
        )


def test_v213_docs_preserve_the_real_haos_result_and_owner_waiver_boundary() -> None:
    changelog = re.sub(
        r"\s+",
        " ",
        read(ROOT / "antigravity_home_assistant" / "CHANGELOG.md"),
    )
    assert changelog.startswith(
        "# Changelog All notable changes to this App are documented in this file. "
        "## [2.0.13] - 2026-08-18"
    )
    for fragment in (
        "23 unindented top-level",
        "exactly one `^profile[ ]`",
        "22 independent global profile declarations",
        "`docker-default (enforce)`",
        "App restart/reconnect",
        "aarch64 testing remains `NOT RUN`",
        "owner explicitly waived",
        "is not an aarch64 `PASS`",
    ):
        assert fragment in changelog, f"2.0.13 changelog evidence drift: {fragment}"

    plan = re.sub(r"\s+", " ", read(V2 / "test-plan.md"))
    for fragment in (
        "2.0.13 Supervisor AppArmor primary declaration 호환성",
        "2.0.11→2.0.12 `preserve` update",
        "App restart/reconnect는 `PASS`",
        "`docker-default (enforce)`여서 `FAIL`",
        "aarch64 실기기 결과는 장비 부재로 `NOT RUN`",
        "이 면제를 PASS 증거로 기록하지 않는다",
        "2.0.13 실기기 AppArmor 결과는 현재 `NOT RUN`",
    ):
        assert fragment in plan, f"2.0.13 test-plan evidence drift: {fragment}"


def test_telegram_shared_context_inheritance_is_local_and_haos_gate_remains() -> None:
    documents = {
        name: re.sub(r"\s+", " ", read(V2 / name))
        for name in (
            "security.md",
            "telegram-spec.md",
            "test-plan.md",
            "checklist.md",
        )
    }
    expected_by_document = {
        "security.md": (
            "HOME=/data/home",
            "/config",
            "관리자 주 채널",
            "global 및 workspace plugin·agent·rule·MCP",
            "positive canary",
        ),
        "telegram-spec.md": (
            "/data/home",
            "/config",
            "global/workspace plugin·agent·rule·MCP",
            "`/new`",
            "encrypted outbox",
        ),
        "test-plan.md": (
            "shared `/data/home`·`/config`",
            "positive inheritance",
            "shared settings policy read canary",
            "`agy-settings patch` 일반 설정 수정",
            "실제 HAOS",
        ),
        "checklist.md": (
            "`/data/home`, `/config`, OAuth",
            "positive control",
            "`/new`",
            "reply outbox",
        ),
    }
    for name, fragments in expected_by_document.items():
        for fragment in fragments:
            assert fragment in documents[name], (
                f"{name} omits Telegram shared-context evidence: {fragment}"
            )
        assert "/data/antigravity-ha/telegram-home" not in documents[name]
        assert "--agent ha-telegram" not in documents[name]

    assert "AG-013" in documents["test-plan.md"]

    checklist = documents["checklist.md"]
    row = next(
        (
            line
            for line in read(V2 / "checklist.md").splitlines()
            if line.startswith("| M5-11 |")
        ),
        None,
    )
    assert row is not None, "missing Telegram shared-customization milestone"
    assert "`PARTIAL`" in row and "`VERIFIED`" not in row
    assert "HAOS OAuth/AppArmor TODO" in row


def test_architecture_matches_current_s6_and_runtime_socket_graph() -> None:
    architecture = read(V2 / "architecture.md")
    normalized = re.sub(r"\s+", " ", architecture)
    for fragment in (
        "현재 구현에는 별도 `credential-broker` longrun이 없다",
        "ha-read-broker (longrun)",
        "/run/antigravity-ha/supervisor.token",
        "ha-read.sock",
        "change-proposal.sock",
        "change-broker.sock",
        "browser gateway는 별도 s6 longrun이 아니다",
        "/etc/antigravity/settings.json",
        "안전한 ownership marker",
        "/data/antigravity-ha/change-broker/",
        "/data/browser-auth/",
        "ha-sshd-runtime",
        "ha-ssh-session",
        "ha-telegram-runtime",
        "Telegram은 별도 settings/plugin copy를 만들지 않고",
        "공유 `/data/home`, `/config`, OAuth",
        "production transport ownership",
        "일반 `ha_read_*` 조회",
        "privileged mutation/browser-auth",
    ):
        assert fragment in normalized, f"architecture runtime graph drift: {fragment}"
    assert "credential-broker (longrun)" not in architecture
    assert "gateway.sock" not in architecture
    assert "defaults/" not in architecture
    assert "ha-telegram-worker" not in architecture
    assert "telegram-plugin.sh" not in architecture
    assert '"target": "automations.yaml"' in architecture
    assert '"targets"' not in architecture

    telegram = read(V2 / "telegram-spec.md")
    proposal_section = telegram.split("## TG-008", 1)[1].split("## TG-009", 1)[0]
    for fragment in (
        "proposal_id: string",
        "user_id: string",
        "chat_id: string",
        "risk: \"low\" | \"high\"",
        "preview_digest: `sha256:${string}`",
        "expires_at: string",
        "expected_sha256",
        "replacement_sha256",
        "mutation_sha256",
        "omitted_before_lines",
        "omitted_after_lines",
        '"multi_choice_service_call"',
        'format: "device-test-plan-v1"',
        "expected_prior_state",
        "always: true",
        'kind: "automation_reload" | "script_reload" | "scene_reload"',
        'format: "ha-service-call-v1"',
        'format: "ha-multi-choice-service-call-v1"',
        "| MultiChoiceServiceCallPreview",
        "choice_id: string",
        "cancel_label: string",
        "service_data: Record<string, unknown>",
    ):
        assert fragment in proposal_section, f"Telegram proposal schema drift: {fragment}"
    for forbidden in (
        "proposalId",
        "userId",
        "chatId",
        "previewDigest",
        "brokerRisk",
        "reversible: boolean",
        "expiresAt",
    ):
        assert forbidden not in proposal_section, (
            f"Telegram public proposal uses non-wire field: {forbidden}"
        )


def test_v211_docs_define_proposal_first_managed_approval_boundary() -> None:
    documents = {
        name: re.sub(r"\s+", " ", read(path))
        for name, path in {
            "readme-ko": ROOT / "README.md",
            "readme-en": ROOT / "README.en.md",
            "docs-ko": ROOT / "antigravity_home_assistant" / "DOCS.md",
            "docs-en": ROOT / "antigravity_home_assistant" / "DOCS.en.md",
            "contract": V2 / "antigravity-contract.md",
            "telegram": V2 / "telegram-spec.md",
            "security": V2 / "security.md",
            "migration": V2 / "migration-release.md",
        }.items()
    }
    for name in ("readme-ko", "readme-en", "docs-ko", "docs-en"):
        assert "request-review" in documents[name], f"{name} omits new-install default"
        assert "service_data" in documents[name], f"{name} omits all-service payload"
        assert "secrets.yaml" in documents[name] and ".storage" in documents[name]
        assert "ha_change_propose" in documents[name], (
            f"{name} omits the managed broker routing boundary"
        )
        assert "telegram_action_propose" in documents[name], (
            f"{name} omits the managed action routing boundary"
        )
        assert "fail closed" in documents[name] or "fail-closed" in documents[name]
        assert "OAuth" in documents[name] and "NOT RUN" in documents[name]

    assert '"ask": []' in documents["contract"]
    managed_allow = documents["contract"].split('"allow": [', 1)[1].split('"ask": []', 1)[0]
    assert '"mcp(*)"' not in managed_allow
    assert '"command(*)"' not in managed_allow
    assert "mcp(telegram_action/telegram_action_propose)" in managed_allow
    assert "resume" in documents["telegram"]
    assert "requester FIFO" in documents["telegram"]
    assert "exactly" in documents["telegram"] or "정확히 한 번" in documents["telegram"]
    assert (
        "모든 App-managed broker `service_call`, `multi_choice_service_call`, "
        "`config_patch`"
    ) in documents["security"]
    assert "transparent" in documents["security"] and "fail closed" in documents["security"]
    assert "antigravity_terminal_sandbox" in documents["contract"]
    assert "deprecated/no-op" in documents["contract"]
    assert "`true`와 `false`를 모두 `false`로 정규화" in documents["contract"]
    assert "effective native argv contains no native sandbox flag" in documents["contract"]
    assert "antigravity_home_assistant-command" in documents["contract"]
    assert "full_access" in documents["contract"] and "SYS_ADMIN" in documents["contract"]
    assert "`settings.json` 직접 write는 exact deny" in documents["contract"]
    assert "`agy-settings sha256`" in documents["contract"]
    assert "`agy-settings patch`" in documents["contract"]
    for protected_key in (
        "`permissions`",
        "`enableTerminalSandbox`",
        "`allowNonWorkspaceAccess`",
        "`toolPermission`",
        "`artifactReviewPolicy`",
    ):
        assert protected_key in documents["contract"]
    assert "Telegram button으로 자동 broker되지 않는다" in documents["telegram"]
    assert "v4a" in documents["telegram"] and "v4c" in documents["telegram"]
    assert "commit" in documents["telegram"] and "in_doubt" in documents["telegram"]
    assert "credential-free executor" in documents["telegram"]
    assert "antigravity-ha-local-<checkout-hash>" in documents["migration"]
    assert "io.antigravity-ha.local-build.owner" in documents["migration"]
    assert "cache-gha-scope: antigravity-home-assistant" in documents["migration"]
    assert "experimental numeric prerelease" in documents["migration"]
    assert "MIG-010` 완료, stable 또는 v2 수용으로 표시할 수 없" in documents["migration"]
    assert "evidence-complete acceptance" in documents["migration"]
    assert "managed-plugin transaction" in documents["migration"]
    assert "최신 총 두 개" in documents["migration"]
    assert "user-files" in documents["migration"]
    assert "change-broker" in documents["migration"]

    for name in ("readme-ko", "readme-en", "docs-ko", "docs-en", "contract"):
        text = documents[name]
        assert "strict" in text and "request-review" in text
        assert "upgrade" in text and ("입력 호환" in text or "input compatibility" in text)

    for rule in (
        "mcp(playwright/browser_console_messages)",
        "mcp(playwright/browser_network_requests)",
        "mcp(playwright/browser_snapshot)",
        "mcp(playwright/browser_take_screenshot)",
    ):
        assert rule in managed_allow
    for rule in (
        "mcp(playwright/browser_close)",
        "mcp(playwright/browser_hover)",
        "mcp(playwright/browser_navigate)",
        "mcp(playwright/browser_navigate_back)",
        "mcp(playwright/browser_resize)",
        "mcp(playwright/browser_tabs)",
        "mcp(playwright/browser_wait_for)",
    ):
        assert rule not in managed_allow
    assert "typed adapter" in documents["telegram"]

    for name in ("readme-ko", "readme-en", "docs-ko", "docs-en", "telegram"):
        text = documents[name]
        assert "crash-durable" in text
        assert "seal" in text or "봉인" in text
        assert "repeat" in text or "다시 보내" in text
        assert "double-fork" in text and "in_doubt" in text

    for name in ("readme-ko", "readme-en", "docs-ko", "docs-en", "migration"):
        text = documents[name]
        assert "reset_v2" in text
        assert "ownership state" in text
        assert "exact" in text
        assert "preserve" in text

    translation_ko = read(ROOT / "antigravity_home_assistant" / "translations" / "ko.yaml")
    translation_en = read(ROOT / "antigravity_home_assistant" / "translations" / "en.yaml")
    assert "effective 값은 request-review 하나" in translation_ko
    assert "request-review is the only effective value" in translation_en
    assert "strict, always-proceed, proceed-in-sandbox" in translation_ko
    assert "strict, always-proceed, and proceed-in-sandbox" in translation_en
    assert "ownership state와" in translation_ko
    assert "regardless of ownership" in translation_en
    assert "터미널 샌드박스(폐기 예정)" in translation_ko
    assert "어느 값이든 false로 정규화" in translation_ko
    assert "terminal sandbox (deprecated)" in translation_en
    assert "normalizes either value to false" in translation_en


def test_haos_image_lifecycle_guidance_keeps_supervisor_ownership_boundary() -> None:
    documents = {
        "readme_ko": read(ROOT / "README.md"),
        "readme_en": read(ROOT / "README.en.md"),
        "docs_ko": read(ROOT / "antigravity_home_assistant" / "DOCS.md"),
        "docs_en": read(ROOT / "antigravity_home_assistant" / "DOCS.en.md"),
        "migration": read(V2 / "migration-release.md"),
        "decisions": read(V2 / "decisions.md"),
    }
    for key in ("docs_ko", "docs_en"):
        text = documents[key]
        assert "https://developers.home-assistant.io/docs/apps/publishing/" in text
        assert (
            "https://developers.home-assistant.io/docs/api/supervisor/endpoints/"
            "#supervisorrepair"
        ) in text
        assert (
            "https://developers.home-assistant.io/docs/api/supervisor/endpoints/"
            "#get-hostdisksdiskusage"
        ) in text
        assert "ha_read_storage_usage" in text
        assert "NOT RUN" in text
    assert "Docker socket" in documents["readme_ko"]
    assert "Docker socket" in documents["readme_en"]
    assert "host prune" in documents["migration"]
    assert "최신 64개" in documents["migration"]
    assert "`running` row" in documents["migration"]
    assert "자동 `/supervisor/repair`" in documents["decisions"]


def test_v210_docs_define_receipt_fallback_multi_choice_and_restart_boundary() -> None:
    documents = {
        name: re.sub(r"\s+", " ", read(path))
        for name, path in {
            "readme-ko": ROOT / "README.md",
            "readme-en": ROOT / "README.en.md",
            "docs-ko": ROOT / "antigravity_home_assistant" / "DOCS.md",
            "docs-en": ROOT / "antigravity_home_assistant" / "DOCS.en.md",
            "contract": V2 / "antigravity-contract.md",
            "telegram": V2 / "telegram-spec.md",
            "architecture": V2 / "architecture.md",
            "security": V2 / "security.md",
            "plan": V2 / "test-plan.md",
            "checklist": V2 / "checklist.md",
            "migration": V2 / "migration-release.md",
            "changelog": ROOT / "antigravity_home_assistant" / "CHANGELOG.md",
        }.items()
    }

    for name in ("readme-ko", "readme-en", "docs-ko", "docs-en"):
        text = documents[name]
        assert "multi_choice_service_call" in text, f"{name} omits multi-choice"
        assert "31" in text and "32" in text, f"{name} omits keyboard bounds"
        assert "v3c" in text and "v3d" in text
        assert "v2a" in text and "v2d" in text
        assert "toolAction" in text and "toolSummary" in text
        assert "mcp(*)" in text

    telegram = documents["telegram"]
    for fragment in (
        "1~31",
        "4×8",
        "64-byte 상한",
        "opaque choice token",
        "selectedChoiceId",
        "proposal 없는 빈 response",
        "1,024 UTF-8 byte",
        "bridge-only restart",
        "full App/broker restart",
    ):
        assert fragment in telegram, f"Telegram 2.0.10 contract drift: {fragment}"

    for name in ("architecture", "security", "plan", "checklist", "changelog"):
        text = documents[name]
        assert "multi_choice_service_call" in text, f"{name} omits multi-choice"
        assert "bridge" in text and "broker" in text

    contract = documents["contract"]
    assert "`Arguments`, `ServerName`, `ToolName`" in contract
    assert "optional `toolAction`/`toolSummary`" in contract
    assert "NUL·비공백 control character" in contract
    assert "Home Assistant 변경 제안을 준비했습니다." in contract
    assert "proposal 없는 빈 response" in contract

    security = documents["security"]
    assert "token→choice mapping" in security
    assert "proposal digest/choice/capability/idempotency" in security
    assert "mutation을 다시 dispatch하지 않는다" in security

    changelog = documents["changelog"].split("## [2.0.9]", 1)[0]
    assert "## [2.0.10]" in changelog
    assert "full App or broker restart rejects an unstarted in-memory proposal" in changelog
    assert "live Telegram/OAuth E2E" not in changelog
    assert 'version: "2.0.13"' in documents["migration"]


def test_v209_docs_match_native_sandbox_and_mediated_settings_policy() -> None:
    paths = (
        ROOT / "README.md",
        ROOT / "README.en.md",
        ROOT / "antigravity_home_assistant" / "DOCS.md",
        ROOT / "antigravity_home_assistant" / "DOCS.en.md",
        ROOT / "antigravity_home_assistant" / "CHANGELOG.md",
        V2 / "antigravity-contract.md",
        V2 / "architecture.md",
        V2 / "checklist.md",
        V2 / "decisions.md",
        V2 / "migration-release.md",
        V2 / "product-spec.md",
        V2 / "security.md",
        V2 / "telegram-spec.md",
        V2 / "test-plan.md",
    )
    forbidden = (
        "mandatory native sandbox",
        "native `--sandbox`는 세 채널 모두 필수",
        "native `--sandbox`를 강제",
        "native `--sandbox`를 항상 추가",
        "normalized to `true`",
        "`false`도 `true`로 정규화",
        "legacy false 입력의 true 정규화",
    )
    for path in paths:
        text = read(path)
        for fragment in forbidden:
            assert fragment not in text, (
                f"{path.relative_to(ROOT)} retains obsolete native sandbox claim: "
                f"{fragment}"
            )

    contract = read(V2 / "antigravity-contract.md")
    assert '"write_file(/data/home/.gemini/antigravity-cli/settings.json)"' in (
        contract.split('"deny": [', 1)[1]
    )
    assert '"write_file(/data/home/.gemini/antigravity-cli/settings.json)"' not in (
        contract.split('"allow": [', 1)[1].split('"ask": []', 1)[0]
    )
    assert "raw file tool" in contract
    assert "`agy-settings sha256`" in contract
    assert "`agy-settings patch`" in contract
    for protected_key in (
        "`permissions`",
        "`enableTerminalSandbox`",
        "`allowNonWorkspaceAccess`",
        "`toolPermission`",
        "`artifactReviewPolicy`",
    ):
        assert protected_key in contract

    security = re.sub(r"\s+", " ", read(V2 / "security.md"))
    for fragment in (
        "interactive-runtime-restricted",
        "interactive-runtime-sensitive-read",
        "antigravity_home_assistant-command",
        "전체 same-process credential isolation 보장이 아니다",
        "실제 HAOS `NOT RUN`",
    ):
        assert fragment in security


def test_device_test_and_transport_ownership_milestones_match_local_evidence() -> None:
    checklist = read(V2 / "checklist.md")
    device_row = next(
        line for line in checklist.splitlines() if line.startswith("| M3-04 |")
    )
    transport_row = next(
        line for line in checklist.splitlines() if line.startswith("| M4-01 |")
    )
    assert "`PARTIAL`" in device_row and "HAOS safe test TODO" in device_row
    assert "`VERIFIED`" in transport_row and "shared failure injection PASS" in transport_row

    gaps = read(V2 / "gap-register.md")
    gap_device = next(
        line for line in gaps.splitlines() if line.startswith("| GAP-008 |")
    )
    gap_transport = next(
        line for line in gaps.splitlines() if line.startswith("| GAP-009 |")
    )
    assert "`OPEN`" in gap_device and "실제 safe entity restore E2E" in gap_device
    assert "`CLOSED`" in gap_transport and "ha-read broker" in gap_transport

    plan = re.sub(r"\s+", " ", read(V2 / "test-plan.md"))
    for fragment in (
        "separate typed operation",
        "initial-call-error",
        "rollback-failed",
        "durable replay fixture",
        "shared ha-read broker static/failure injection",
    ):
        assert fragment in plan, f"missing bounded M3/M4 evidence: {fragment}"


def test_native_auto_update_opt_out_is_required_but_not_claimed_complete() -> None:
    documents = {
        name: re.sub(r"\s+", " ", read(V2 / name))
        for name in (
            "antigravity-contract.md",
            "test-plan.md",
            "checklist.md",
            "migration-release.md",
        )
    }
    for name, content in documents.items():
        assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in content, (
            f"{name} omits the native updater opt-out contract"
        )

    plan = documents["test-plan.md"]
    assert "AG-014" in plan and "spawn=1" in plan and "spawn=0" in plan

    milestone = next(
        (
            line
            for line in read(V2 / "checklist.md").splitlines()
            if line.startswith("| M2-09 |")
        ),
        None,
    )
    assert milestone is not None, "missing runtime self-updater milestone"
    assert "`PARTIAL`" in milestone and "`VERIFIED`" not in milestone

    all_docs = "\n".join(read(path) for path in sorted(V2.glob("*.md")))
    assert "check_for_update_on_startup" not in all_docs


def test_decisions_and_gap_register_are_closed_contracts() -> None:
    decisions = read(V2 / "decisions.md")
    gaps = read(V2 / "gap-register.md")
    checklist = read(V2 / "checklist.md")

    for identifier in ("ADR-001", "ADR-002", "ADR-003", "ADR-004", "ADR-005"):
        assert decisions.count(f"## {identifier} ") == 1
    for fragment in (
        "target App version: `2.0.0`",
        "source contract: 최신 공개 v1 tag `1.0.4`",
        "`1.0.4 → 2.0.0`",
        "HA-005",
        "HA-006",
        "AppArmor는 항상 ON",
        "Telegram bridge 전면 교체",
        "Antigravity CLI는 `1.1.13`",
    ):
        assert fragment in decisions, f"missing v2 decision contract: {fragment}"

    for number in range(1, 10):
        assert gaps.count(f"| GAP-{number:03d} |") == 1
    assert "Supervisor credential" in gaps
    assert "임의 mock 성공으로 닫지 않는다" in gaps
    assert "| M0-03 | `VERIFIED`" in checklist
    assert "| M0-04 | `VERIFIED`" in checklist


def test_release_evidence_docs_preserve_phase_and_architecture_boundaries() -> None:
    expected_gates = {
        "apparmor_enforce",
        "haos_aarch64_install_persistence",
        "haos_amd64_local_migration",
        "local_migration_rollback",
        "migration_modes",
        "native_updater_canary",
        "shared_runtime_persistence",
        "telegram_session_delivery",
    }
    template = json.loads(read(V2 / "release-evidence-template.json"))
    assert template["version"] == "2.0.13"
    assert set(template["gates"]) == expected_gates
    assert "HA-008" not in json.dumps(template, sort_keys=True)
    for gate in template["gates"].values():
        assert gate == {
            "status": "NOT_RUN",
            "evidence_uri": "",
            "sha256": "",
            "format": "",
        }

    contract_path = ROOT / ".github" / "scripts" / "release_contract.py"
    assert literal_assignment(contract_path, "EXPECTED_MANUAL_GATES") == expected_gates
    gate_test_ids = literal_assignment(contract_path, "EXPECTED_HAOS_GATE_TEST_IDS")
    assert isinstance(gate_test_ids, dict)
    assert set(gate_test_ids) == expected_gates
    assert all("HA-005" not in identifiers for identifiers in gate_test_ids.values())
    assert all("HA-008" not in identifiers for identifiers in gate_test_ids.values())
    assert gate_test_ids["haos_aarch64_install_persistence"][-1] == "HA-006"
    assert gate_test_ids["haos_amd64_local_migration"][-1] == "HA-007"
    assert gate_test_ids["migration_modes"] == ["HA-007"]
    assert gate_test_ids["local_migration_rollback"] == ["HA-007"]
    assert gate_test_ids["shared_runtime_persistence"] == [
        "HA-001",
        "HA-004",
        "HA-006",
        "AA-001",
    ]
    assert gate_test_ids["native_updater_canary"] == ["HA-001", "HA-006"]
    gate_checks = literal_assignment(contract_path, "EXPECTED_HAOS_GATE_CHECKS")
    migration_checks = gate_checks["haos_amd64_local_migration"]
    assert "oauth_browser_memory_persist_after_update" in migration_checks
    assert "native_updater_disabled_after_migration" in migration_checks
    shared_runtime_checks = gate_checks["shared_runtime_persistence"]
    assert "telegram_shared_identity_login" in shared_runtime_checks
    assert "user_global_customization_inherited" in shared_runtime_checks
    assert "user_global_customization_mutable" in shared_runtime_checks
    assert "cli_version_1_1_13" in gate_checks["native_updater_canary"]
    assert "cli_version_1_1_11" not in gate_checks["native_updater_canary"]
    assert "telegram_separate_identity_login" not in shared_runtime_checks
    assert "user_global_mcp_absent_before_and_after_auth" not in shared_runtime_checks
    telegram_delivery_checks = gate_checks["telegram_session_delivery"]
    assert "explicit_new_only_session_rotation" in telegram_delivery_checks
    assert "response_outbox_crash_recovery" in telegram_delivery_checks
    assert "shared_customization_inherited" in telegram_delivery_checks
    assert "telegram_home_customization_isolated" not in telegram_delivery_checks

    workflow = read(ROOT / ".github" / "workflows" / "haos-evidence.yaml")
    choice_block = workflow.split("      gate:", 1)[1].split("      report_json:", 1)[0]
    workflow_gates = set(re.findall(r"^          - ([a-z0-9_]+)$", choice_block, re.MULTILINE))
    assert workflow_gates == expected_gates

    decisions = re.sub(r"\s+", " ", read(V2 / "decisions.md"))
    assert "source contract: 최신 공개 v1 tag `1.0.4` (amd64 only)" in decisions
    assert "amd64의 post-publish `HA-005`" in decisions
    assert "pre-publish aarch64 `HA-006`" in decisions
    assert "양 architecture에서 fresh install하는 post-publish `HA-008`" in decisions
    assert "amd64와 aarch64에서 `HA-005`" not in decisions

    plan_text = re.sub(r"\s+", " ", read(V2 / "test-plan.md"))
    migration = re.sub(r"\s+", " ", read(V2 / "migration-release.md"))
    for content in (plan_text, migration):
        assert "/addons/antigravity_home_assistant" in content
        assert "original custom repository" in content
        assert "post-publish" in content
        assert "HA-005" in content
        assert "HA-006" in content
        assert "HA-007" in content
        assert "HA-008" in content
        assert "haos-gates/<gate>.json" in content
        assert "haos_gate_evidence" in content
        assert 'format: "github_actions_zip"' in content

    template_cli = (
        "python3 .github/scripts/release_contract.py haos-report-templates \\ "
        "--candidate candidate.json \\ --output-dir haos-report-templates"
    )
    for content in (plan_text, migration):
        assert template_cli in content
        assert "haos-report-templates/" in content
        assert "unchanged template" in content or "template 원본" in content

    deadline_formulas = (
        "min(candidate artifact expires_at, earliest gate artifact expires_at, "
        "oldest HAOS observed_at_utc + 30 days)",
        "min(candidate artifact expires_at, finalizer artifact expires_at, "
        "oldest embedded HAOS observed_at_utc + 30 days)",
        "min(finalizer artifact expires_at, "
        "oldest embedded HAOS observed_at_utc + 30 days, "
        "oldest HA-008 installation observed_at_utc + 30 days)",
    )
    for content in (plan_text, migration):
        assert "`retention-days`" in content
        assert "`expires_at`" in content and "authoritative" in content
        assert all(formula in content for formula in deadline_formulas)
        assert "만료된 artifact를 재업로드" in content
        assert "attempt" in content and "섞" in content
        assert "annotated tag" in content and "이동하지 않는다" in content
        assert "**Re-run all jobs**" in content
        assert "새 version" in content
    assert "`Post-publish HA-005 acceptance`" in plan_text
    assert "`.github/workflows/postpublish-ha005.yaml`" in plan_text
    assert "`antigravity-ha-ha005-acceptance/v1`" in plan_text
    assert "`ha005-acceptance.json`" in plan_text
    assert "non-draft prerelease" in plan_text
    assert "pre-finalize evidence에 포함하지 않는다" in plan_text
    assert 'installation_source: "local_addons_source_build"' in plan_text
    assert 'repository_identity: "same_local_repository_identity"' in plan_text
    assert 'installation_source: "original_custom_repository_source_build"' in plan_text
    assert "`repository_id_sha256`" in plan_text
    assert "`data_identity_sha256`" in plan_text
    assert "v1 registry digest가 아니라" in plan_text
    assert "observation은 Release publish 시각 후여야" in plan_text
    assert "report 제출 시점에 관찰 시각이 30일보다 오래되지 않아야" in plan_text
    assert "finalizer artifact의 retention은 30일" in plan_text
    assert "artifact availability 창은 report 관찰 시각의 30일 freshness" in plan_text

    trace = traceability_map(V2 / "test-plan.md")
    assert "HA-008" in declared_test_ids()
    assert "HA-008" in trace["FR-001"]
    assert "HA-008" in trace["MIG-010"]
    for requirement in (
        "SEC-003",
        "SEC-012",
        "MIG-002",
        "MIG-003",
        "MIG-004",
        "MIG-005",
        "MIG-006",
        "MIG-007",
        "MIG-009",
        "MIG-010",
    ):
        assert "HA-007" in trace[requirement]
    assert "HA-005" not in trace["MIG-008"]
    assert {"HA-001", "HA-006"} <= trace["MIG-008"]
    assert {"HA-006", "HA-007"} <= trace["MIG-009"]

    gaps = read(V2 / "gap-register.md")
    assert "| GAP-005 | `OPEN`" in gaps and "original repository/add-on identity" in gaps
    gap006 = next(line for line in gaps.splitlines() if line.startswith("| GAP-006 |"))
    assert "`OPEN`" in gap006 and "HA-008" in gap006
    assert "HA-005" not in gap006
    gap007 = next(line for line in gaps.splitlines() if line.startswith("| GAP-007 |"))
    assert "`OPEN`" in gap007 and "non-blocking advisory" in gap007

    assert literal_assignment(contract_path, "HA005_REPORT_SCHEMA") == (
        "antigravity-ha-ha005-acceptance/v1"
    )
    ha005_template = json.loads(read(V2 / "ha005-acceptance-template.json"))
    assert set(ha005_template) == {
        "schema",
        "test_id",
        "status",
        "release",
        "previous_release",
        "transitions",
        "checks",
        "environment",
        "observed_at_utc",
        "sanitization",
        "attestation",
    }
    assert ha005_template["schema"] == literal_assignment(
        contract_path, "HA005_REPORT_SCHEMA"
    )
    assert ha005_template["test_id"] == "HA-005"
    assert ha005_template["status"] == "NOT_RUN"
    assert set(ha005_template["release"]) == {
        "version",
        "source_sha",
        "published_at_utc",
        "generic_image",
        "generic_digest",
        "amd64_runtime_digest",
    }
    assert set(ha005_template["previous_release"]) == {
        "version",
        "source_sha",
        "repository_url",
        "addon_slug",
        "installation_source",
        "repository_id_sha256",
        "local_image_id",
        "data_identity_sha256",
    }
    assert set(ha005_template["transitions"]) == {"update", "rollback"}
    assert set(ha005_template["transitions"]["update"]) == {
        "status",
        "from_version",
        "to_version",
        "repository_id_sha256",
        "addon_slug",
        "data_identity_sha256",
        "observed_generic_digest",
        "observed_amd64_runtime_digest",
    }
    assert set(ha005_template["transitions"]["rollback"]) == {
        "status",
        "from_version",
        "to_version",
        "repository_id_sha256",
        "addon_slug",
        "data_identity_sha256",
        "source_sha",
        "selected_local_image_id",
        "matching_managed_backup_restored",
    }
    expected_ha005_checks = literal_assignment(contract_path, "EXPECTED_HA005_CHECKS")
    assert set(ha005_template["checks"]) == expected_ha005_checks
    assert set(ha005_template["checks"].values()) == {"NOT_RUN"}
    assert set(ha005_template["environment"]) == {
        "platform",
        "architecture",
        "haos_version",
        "supervisor_version",
        "core_version",
        "final_app_version",
    }
    assert ha005_template["environment"]["platform"] == "HAOS"
    assert ha005_template["environment"]["architecture"] == "amd64"
    assert set(ha005_template["sanitization"]) == {
        "contains_credentials",
        "contains_entity_or_chat_identifiers",
        "contains_raw_logs_or_prompts",
        "contains_private_host_or_user_identifiers",
    }
    assert set(ha005_template["sanitization"].values()) == {True}
    assert set(ha005_template["attestation"]) == {
        "real_haos_device",
        "original_public_repository_verified",
        "public_release_observed_after_publish",
        "sanitized_by_maintainer",
        "scope_reviewed",
    }
    assert set(ha005_template["attestation"].values()) == {False}
    assert ha005_template["transitions"]["update"]["status"] == "NOT_RUN"
    assert ha005_template["transitions"]["rollback"]["status"] == "NOT_RUN"
    assert ha005_template["release"]["generic_image"] == literal_assignment(
        contract_path, "PUBLIC_GENERIC_IMAGE"
    )
    previous = ha005_template["previous_release"]
    assert previous["source_sha"] == literal_assignment(
        contract_path, "PUBLIC_V1_SOURCE_SHA"
    )
    assert previous["repository_url"] == literal_assignment(
        contract_path, "PUBLIC_REPOSITORY_URL"
    )
    assert previous["addon_slug"] == literal_assignment(contract_path, "PUBLIC_APP_SLUG")

    public_install_template = json.loads(
        read(V2 / "public-install-acceptance-template.json")
    )
    assert set(public_install_template) == {
        "schema",
        "test_id",
        "status",
        "release",
        "installations",
        "sanitization",
        "attestation",
    }
    assert public_install_template["schema"] == literal_assignment(
        contract_path, "PUBLIC_INSTALL_REPORT_SCHEMA"
    )
    assert public_install_template["test_id"] == "HA-008"
    assert public_install_template["status"] == "NOT_RUN"
    public_release = public_install_template["release"]
    assert set(public_release) == {
        "version",
        "source_sha",
        "published_at_utc",
        "repository_url",
        "addon_slug",
        "generic_image",
        "generic_digest",
        "runtime_digests",
    }
    assert public_release["repository_url"] == literal_assignment(
        contract_path, "PUBLIC_REPOSITORY_URL"
    )
    assert public_release["addon_slug"] == literal_assignment(
        contract_path, "PUBLIC_APP_SLUG"
    )
    assert public_release["generic_image"] == literal_assignment(
        contract_path, "PUBLIC_GENERIC_IMAGE"
    )
    assert public_release["runtime_digests"] == {"amd64": "", "aarch64": ""}
    expected_public_install_checks = literal_assignment(
        contract_path, "EXPECTED_PUBLIC_INSTALL_CHECKS"
    )
    assert set(public_install_template["installations"]) == {"amd64", "aarch64"}
    for architecture, installation in public_install_template["installations"].items():
        assert set(installation) == {
            "status",
            "installation_source",
            "repository_id_sha256",
            "data_identity_before_restart_sha256",
            "data_identity_after_restart_sha256",
            "observed_repository_version",
            "observed_generic_digest",
            "observed_runtime_digest",
            "checks",
            "environment",
            "observed_at_utc",
        }
        assert installation["status"] == "NOT_RUN"
        assert (
            installation["installation_source"]
            == "original_custom_repository_prebuilt_image"
        )
        assert set(installation["checks"]) == expected_public_install_checks
        assert set(installation["checks"].values()) == {"NOT_RUN"}
        assert set(installation["environment"]) == {
            "platform",
            "architecture",
            "haos_version",
            "supervisor_version",
            "core_version",
            "final_app_version",
            "apparmor_mode",
        }
        assert installation["environment"]["platform"] == "HAOS"
        assert installation["environment"]["architecture"] == architecture
        assert installation["observed_at_utc"] == ""
    assert set(public_install_template["sanitization"]) == {
        "contains_credentials",
        "contains_entity_or_chat_identifiers",
        "contains_raw_logs_or_prompts",
        "contains_private_host_or_user_identifiers",
    }
    assert set(public_install_template["sanitization"].values()) == {True}
    assert set(public_install_template["attestation"]) == {
        "real_haos_devices",
        "original_public_repository_verified",
        "public_release_observed_after_publish",
        "independent_fresh_installs_verified",
        "both_architectures_scope_reviewed",
        "sanitized_by_maintainer",
    }
    assert set(public_install_template["attestation"].values()) == {False}

    contract = load_python_module(contract_path, "v2_docs_release_contract")
    contract.validate_release_evidence = lambda evidence: evidence
    source_sha = "a" * 40
    generic_digest = "sha256:" + "1" * 64
    amd64_digest = "sha256:" + "2" * 64
    aarch64_digest = "sha256:" + "3" * 64
    release_evidence = {
        "candidate": {
            "version": "2.0.0",
            "source_sha": source_sha,
            "images": {
                "generic": {
                    "name": contract.PUBLIC_GENERIC_IMAGE,
                    "digest": generic_digest,
                },
                "amd64": {"runtime_digest": amd64_digest},
                "aarch64": {"runtime_digest": aarch64_digest},
            },
        }
    }
    try:
        contract.validate_ha005_report(
            release_evidence,
            ha005_template,
            version="2.0.0",
            source_sha=source_sha,
            generic_digest=generic_digest,
            amd64_runtime_digest=amd64_digest,
            published_at_utc="2020-01-01T00:00:00Z",
        )
    except contract.ContractError as error:
        assert str(error) == "HA-005 report did not pass"
    else:
        raise AssertionError("unchanged HA-005 template unexpectedly passed validation")

    try:
        contract.validate_public_install_report(
            release_evidence,
            public_install_template,
            version="2.0.0",
            source_sha=source_sha,
            generic_digest=generic_digest,
            amd64_runtime_digest=amd64_digest,
            aarch64_runtime_digest=aarch64_digest,
            published_at_utc="2020-01-01T00:00:00Z",
        )
    except contract.ContractError as error:
        assert str(error) == "public-install report did not pass"
    else:
        raise AssertionError(
            "unchanged public-install template unexpectedly passed validation"
        )

    template_args = contract.build_parser().parse_args(
        [
            "haos-report-templates",
            "--candidate",
            "candidate.json",
            "--output-dir",
            "haos-report-templates",
        ]
    )
    assert template_args.command == "haos-report-templates"
    assert template_args.candidate == Path("candidate.json")
    assert template_args.output_dir == Path("haos-report-templates")
    assert callable(template_args.handler)

    build_workflow = re.sub(
        r"\s+", " ", read(ROOT / ".github" / "workflows" / "build-app.yaml")
    )
    assert template_cli in build_workflow
    assert "haos-report-templates/" in build_workflow
    assert "haos-report-templates/<gate>.json" in build_workflow
    assert "Unchanged NOT_RUN templates are rejected" in build_workflow
    assert "haos-report-templates/<gate>.json" in workflow
    assert "unchanged NOT_RUN template is rejected" in workflow

    candidate_workflow = read(ROOT / ".github" / "workflows" / "candidate.yaml")
    builder_workflow = read(ROOT / ".github" / "workflows" / "builder.yaml")
    for artifact_workflow in (build_workflow, workflow, candidate_workflow):
        assert "retention-days: 30" in artifact_workflow
    assert ".expired == false" in workflow
    assert ".expired == false" in candidate_workflow
    assert builder_workflow.count(".expired == false") >= 2

    postpublish = read(ROOT / ".github" / "workflows" / "postpublish-ha005.yaml")
    for token in (
        "Post-publish HA-005 acceptance",
        "ha005-report",
        "ha005-acceptance.json",
        "release-evidence/haos-gates",
        "anonymous public verification",
    ):
        assert token in postpublish
    inputs_block = postpublish.split("    inputs:", 1)[1].split("\n\npermissions:", 1)[0]
    assert re.findall(r"^      ([a-z0-9_]+):$", inputs_block, re.MULTILINE) == [
        "version",
        "report_json",
    ]
    assert 'refs/tags/${RELEASE_VERSION}' in postpublish
    assert ".draft == false" in postpublish
    assert ".prerelease == true" in postpublish
    artifact_name = (
        "ha005-acceptance-${{ inputs.version }}-"
        "${{ steps.release.outputs.source_sha }}-"
        "${{ github.run_id }}-${{ github.run_attempt }}"
    )
    assert artifact_name in postpublish
    assert "Candidate / finalize" not in postpublish
    assert "ha005-acceptance-<version>-<source_sha>-<run_id>-<run_attempt>" in plan_text
    assert "ha005-acceptance.json" in migration
    assert "pre-finalize gate나 Candidate evidence로 순환시키지 않는다" in migration
    assert "tag-bound finalizer Actions artifact와 GitHub Release" in migration
    assert "artifact가 만료하면" in migration

    public_install_workflow = read(
        ROOT / ".github" / "workflows" / "postpublish-public-install.yaml"
    )
    for token in (
        "Post-publish public install acceptance",
        literal_assignment(contract_path, "PUBLIC_INSTALL_REPORT_SCHEMA"),
        "public-install-report",
        "public-install-acceptance.json",
        "docker pull --platform linux/amd64",
        "docker pull --platform linux/arm64",
        ".expired == false",
    ):
        assert token in public_install_workflow
    assert "Candidate / finalize" not in public_install_workflow
    assert "ha005-acceptance.json" not in public_install_workflow


def test_antigravity_contract_matches_managed_plugin_inventory() -> None:
    contract = read(V2 / "antigravity-contract.md")
    plugin = (
        ROOT
        / "antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/plugins/home-assistant"
    )
    inventory = {
        path.relative_to(plugin).as_posix()
        for path in plugin.rglob("*")
        if path.is_file()
    }
    expected = {
        "mcp_config.json",
        "plugin.json",
        "rules/home-assistant-safety.md",
        "skills/ha-change-proposal/SKILL.md",
        "skills/ha-dashboard/SKILL.md",
        "skills/ha-feedback/SKILL.md",
        "skills/ha-memory/SKILL.md",
        "skills/home-assistant-operations/SKILL.md",
        "skills/telegram-action-proposal/SKILL.md",
    }
    assert inventory == expected
    for relative in expected:
        assert relative.rsplit("/", maxsplit=1)[-1] in contract
    for stale in (
        "agents/ha-telegram/agent.md",
        "ha-telegram-worker",
        "│  ├─ safety.md",
        "│  ├─ memory.md",
        "│  └─ browser.md",
        "ha-diagnose/SKILL.md",
        "ha-change/SKILL.md",
        "ha-dashboard-review/SKILL.md",
    ):
        assert stale not in contract
    for server in (
        "ha_change",
        "telegram_action",
        "ha_memory",
        "ha_read",
        "ha_validate",
        "playwright",
    ):
        assert f'"{server}"' in contract


def direct_test_checks(
    namespace: Mapping[str, object] | None = None,
) -> list[tuple[str, Callable[[], None]]]:
    scope = globals() if namespace is None else namespace
    checks: list[tuple[str, Callable[[], None]]] = []
    invalid: list[str] = []
    for name in sorted(scope):
        check = scope[name]
        if not name.startswith("test_") or not callable(check):
            continue
        try:
            signature = inspect.signature(check)
        except (TypeError, ValueError):
            invalid.append(f"{name} (uninspectable signature)")
            continue
        if signature.parameters:
            invalid.append(f"{name}{signature}")
            continue
        checks.append((name, check))

    if invalid:
        raise AssertionError(
            "direct runner requires zero-argument test_* callables: "
            + ", ".join(invalid)
        )
    return checks


if __name__ == "__main__":
    for name, check in direct_test_checks():
        check()
        print(f"PASS {name}")
