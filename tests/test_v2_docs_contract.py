"""Static integrity checks for the canonical v2 documentation package."""

from __future__ import annotations

import ast
import importlib.util
import json
import re
from collections import Counter
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
        "`input_boolean.reload`",
        "`memory_begin_change`",
        "`memory_verify_change`",
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
        "`/data/home/**` read-write",
        "완전한 token isolation로 표현하지 않는다",
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


def test_telegram_isolation_canary_is_local_and_haos_gate_remains() -> None:
    documents = {
        name: re.sub(r"\s+", " ", read(V2 / name))
        for name in (
            "security.md",
            "telegram-spec.md",
            "test-plan.md",
            "checklist.md",
        )
    }
    for name, text in documents.items():
        for fragment in (
            "global",
            "OAuth 인증 완료 전",
            "/data/antigravity-ha/telegram-home",
        ):
            assert fragment in text, f"{name} omits Telegram isolation evidence: {fragment}"

    assert "--agent ha-telegram" in documents["security.md"]
    assert "/config/.agents" in documents["security.md"]
    assert "실행되지 않" in documents["security.md"]
    assert "primary OAuth" in documents["telegram-spec.md"]
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
    assert row is not None, "missing Telegram customization-isolation milestone"
    assert "`PARTIAL`" in row and "`VERIFIED`" not in row
    assert "release blocker" in checklist


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
        ".antigravity-ha-managed",
        "/data/antigravity-ha/change-broker/",
        "/data/browser-auth/",
        "ha-sshd-runtime",
        "ha-ssh-session",
        "telegram-plugin.sh",
        "production transport ownership",
        "일반 `ha_read_*` 조회",
        "privileged mutation/browser-auth",
    ):
        assert fragment in normalized, f"architecture runtime graph drift: {fragment}"
    assert "credential-broker (longrun)" not in architecture
    assert "gateway.sock" not in architecture
    assert "defaults/" not in architecture
    assert '"target": "input_booleans.yaml"' in architecture
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
        'operation: "config_patch" | "service_call" | "device_test"',
        'format: "device-test-plan-v1"',
        "expected_prior_state",
        "always: true",
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
        "Antigravity CLI는 `1.1.11`",
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
        "oauth_isolation_persistence",
        "telegram_modes",
    }
    template = json.loads(read(V2 / "release-evidence-template.json"))
    assert set(template["gates"]) == expected_gates
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
    assert gate_test_ids["haos_aarch64_install_persistence"][-1] == "HA-006"
    assert gate_test_ids["haos_amd64_local_migration"][-1] == "HA-007"
    assert gate_test_ids["migration_modes"] == ["HA-007"]
    assert gate_test_ids["local_migration_rollback"] == ["HA-007"]
    assert gate_test_ids["oauth_isolation_persistence"] == [
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

    workflow = read(ROOT / ".github" / "workflows" / "haos-evidence.yaml")
    choice_block = workflow.split("      gate:", 1)[1].split("      report_json:", 1)[0]
    workflow_gates = set(re.findall(r"^          - ([a-z0-9_]+)$", choice_block, re.MULTILINE))
    assert workflow_gates == expected_gates

    decisions = re.sub(r"\s+", " ", read(V2 / "decisions.md"))
    assert "source contract: 최신 공개 v1 tag `1.0.4` (amd64 only)" in decisions
    assert "amd64의 post-publish `HA-005`와 aarch64의 `HA-006`" in decisions
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
        assert "haos-gates/<gate>.json" in content
        assert "haos_gate_evidence" in content
        assert 'format: "github_actions_zip"' in content
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
    assert "| GAP-007 | `IN_PROGRESS`" in gaps

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

    contract = load_python_module(contract_path, "v2_docs_release_contract")
    contract.validate_release_evidence = lambda evidence: evidence
    source_sha = "a" * 40
    generic_digest = "sha256:" + "1" * 64
    amd64_digest = "sha256:" + "2" * 64
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
        "agents/ha-telegram/agent.md",
        "mcp_config.json",
        "plugin.json",
        "rules/home-assistant-safety.md",
        "skills/ha-change-proposal/SKILL.md",
        "skills/ha-dashboard/SKILL.md",
        "skills/ha-feedback/SKILL.md",
        "skills/ha-memory/SKILL.md",
        "skills/home-assistant-operations/SKILL.md",
    }
    assert inventory == expected
    for relative in expected:
        assert relative.rsplit("/", maxsplit=1)[-1] in contract
    for stale in (
        "│  ├─ safety.md",
        "│  ├─ memory.md",
        "│  └─ browser.md",
        "ha-diagnose/SKILL.md",
        "ha-change/SKILL.md",
        "ha-dashboard-review/SKILL.md",
    ):
        assert stale not in contract
    for server in ("ha_change", "ha_memory", "ha_read", "ha_validate", "playwright"):
        assert f'"{server}"' in contract


if __name__ == "__main__":
    checks = [
        test_requirement_ids_are_stable_unique_and_contiguous,
        test_every_requirement_has_matching_test_plan_and_checklist_rows,
        test_traceability_uses_only_declared_tests_and_no_test_is_orphaned,
        test_local_v2_markdown_links_resolve,
        test_known_release_blockers_cannot_be_marked_verified,
        test_native_oauth_residual_risk_is_not_claimed_as_isolated,
        test_telegram_isolation_canary_is_local_and_haos_gate_remains,
        test_architecture_matches_current_s6_and_runtime_socket_graph,
        test_device_test_and_transport_ownership_milestones_match_local_evidence,
        test_native_auto_update_opt_out_is_required_but_not_claimed_complete,
        test_decisions_and_gap_register_are_closed_contracts,
        test_release_evidence_docs_preserve_phase_and_architecture_boundaries,
        test_antigravity_contract_matches_managed_plugin_inventory,
    ]
    for check in checks:
        check()
        print(f"PASS {check.__name__}")
