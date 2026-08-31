from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "main-release.yaml"


def _workflow() -> tuple[dict, str]:
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    return yaml.safe_load(text), text


def test_main_release_is_manual_main_only_and_minimally_authorized() -> None:
    workflow, text = _workflow()
    assert set(workflow["on"]) == {"workflow_dispatch"}
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert set(inputs) == {
        "version",
        "candidate_run_id",
        "candidate_run_attempt",
        "confirm",
    }
    assert inputs["version"]["default"] == "3.0.0"
    assert workflow["permissions"] == {"contents": "read"}
    publish = workflow["jobs"]["publish"]
    assert publish["if"] == "github.ref == 'refs/heads/main'"
    assert publish["permissions"] == {
        "actions": "read",
        "contents": "write",
        "packages": "write",
    }
    assert "[[ $CONFIRM == publish-from-main ]]" in text
    assert '[[ $GITHUB_ACTOR == "$GITHUB_REPOSITORY_OWNER" ]]' in text
    assert '[[ $RELEASE_VERSION =~ ^3\\.[0-9]+\\.[0-9]+$ ]]' in text


def test_main_release_consumes_one_exact_successful_v3_candidate() -> None:
    _, text = _workflow()
    for required in (
        '.path == ".github/workflows/candidate.yaml"',
        "/attempts/${RUN_ATTEMPT}",
        '.event == "workflow_dispatch"',
        '.conclusion == "success"',
        '.head_branch == "main"',
        '.artifacts[0].expired == false',
        "release-candidate-${source_sha}-${RUN_ID}-${RUN_ATTEMPT}",
        "artifact-ids: ${{ steps.artifact.outputs.artifact_id }}",
        "digest-mismatch: error",
        'git merge-base --is-ancestor "$SOURCE_SHA" "$GITHUB_SHA"',
        "Candidate-to-main runtime drift",
        'antigravity-ha-release-candidate/v3',
        "release_contract.py candidate-verify",
        "source-rootfs-manifest.py verify",
        "--manifest release-candidate/candidate-index.json",
    ):
        assert required in text
    for gate in (
        "exact_digest_smoke",
        "native_arm64_full_feasible",
        "source_quality",
        "spdx_leaf_sbom",
    ):
        assert f'"{gate}": "PASS"' in text


def test_main_release_promotes_exact_candidate_and_verifies_both_platforms() -> None:
    _, text = _workflow()
    promote = text.index("Carbon-copy numeric architecture and generic tags")
    amd64 = text.index("amd64_image }}:${RELEASE_VERSION}", promote)
    arm64 = text.index("arm64_image }}:${RELEASE_VERSION}", promote)
    generic = text.index("candidate.outputs.image }}:${RELEASE_VERSION}", promote)
    assert amd64 < arm64 < generic
    assert text.count("release-oci.sh ensure-tag") == 3
    assert "anonymous-candidate-preflight.sh" in text
    assert 'docker pull --platform linux/amd64' in text
    assert 'docker pull --platform linux/arm64' in text
    assert text.count('docker image rm --force "${IMAGE}@${GENERIC_DIGEST}"') == 2


def test_main_release_notes_define_the_3_0_product_and_migration() -> None:
    _, text = _workflow()
    for required in (
        "the first 3.0 start permanently deletes",
        "without creating a backup",
        "`/config`, `/share`, `/media`, and Supervisor-owned `/data/options.json`",
        "Remote Control",
        "`ha-antigravity-remote-login`",
        "starts automatically after authentication",
        "Remote name, sensitive-data read access, browser auto-auth, and log level",
        "Ingress recovery",
        "memory",
        "managed browser validation",
        "privacy-safe feedback",
        "AppArmor and Supervisor-token isolation",
        "Antigravity native permission prompts",
        "amd64 HAOS acceptance at publication: `NOT RUN`",
        "aarch64 HAOS acceptance at publication: `NOT RUN`",
        "Overall 3.0 HAOS acceptance at publication: `PARTIAL`",
    ):
        assert required in text
    assert "Overall v2 acceptance" not in text
    assert "haos_evidence_json" not in text
    assert "release-evidence.json" not in text


def test_main_release_creates_idempotent_annotated_prerelease() -> None:
    _, text = _workflow()
    for required in (
        '"/repos/${GITHUB_REPOSITORY}/git/tags"',
        "--field type=commit",
        '--field ref="refs/tags/${RELEASE_VERSION}"',
        'gh release create "$RELEASE_VERSION"',
        "--verify-tag",
        '--target "$CANDIDATE_SOURCE"',
        "--prerelease",
        ".message == $message",
        ".target_commitish == $source",
        ".name == $title",
        "grep -Fq '(HTTP 404)' \"$release_error\"",
    ):
        assert required in text


def test_repository_advertises_the_numeric_tag_published_by_main_release() -> None:
    workflow, _ = _workflow()
    config = yaml.safe_load(
        (ROOT / "antigravity_home_assistant" / "config.yaml").read_text(
            encoding="utf-8"
        )
    )
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert config["version"] == inputs["version"]["default"] == "3.0.0"
    assert (
        config["image"]
        == "ghcr.io/kanu-coffee/antigravity-for-home-assistant"
    )


def test_anonymous_candidate_preflight_clears_digest_between_platforms() -> None:
    script = (
        ROOT / ".github" / "scripts" / "anonymous-candidate-preflight.sh"
    ).read_text(encoding="utf-8")
    amd64 = script.index('docker pull --platform linux/amd64 "$candidate_ref"')
    first_remove = script.index('docker image rm --force "$candidate_ref"', amd64)
    arm64 = script.index('docker pull --platform linux/arm64 "$candidate_ref"')
    second_remove = script.index('docker image rm --force "$candidate_ref"', arm64)
    assert amd64 < first_remove < arm64 < second_remove
    assert script.count('docker image rm --force "$candidate_ref"') == 2
