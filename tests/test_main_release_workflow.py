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
    assert inputs["version"]["default"] == "2.0.1"
    assert workflow["permissions"] == {"contents": "read"}
    publish = workflow["jobs"]["publish"]
    assert publish["if"] == "github.ref == 'refs/heads/main'"
    assert publish["permissions"] == {
        "actions": "read",
        "contents": "write",
        "packages": "write",
    }
    assert "[[ $CONFIRM == publish-from-main ]]" in text
    assert "[[ $GITHUB_ACTOR == \"$GITHUB_REPOSITORY_OWNER\" ]]" in text


def test_main_release_consumes_one_exact_successful_candidate() -> None:
    _, text = _workflow()
    assert '.path == ".github/workflows/candidate.yaml"' in text
    assert "/attempts/${RUN_ATTEMPT}" in text
    assert '.event == "workflow_dispatch"' in text
    assert '.conclusion == "success"' in text
    assert '.head_branch == "main"' in text
    assert '[[ $remote_main == "$GITHUB_SHA" ]]' in text
    assert ".artifacts[0].expired == false" in text
    assert "release-candidate-${source_sha}-${RUN_ID}-${RUN_ATTEMPT}" in text
    assert "artifact-ids: ${{ steps.artifact.outputs.artifact_id }}" in text
    assert "digest-mismatch: error" in text
    assert 'git merge-base --is-ancestor "$SOURCE_SHA" "$GITHUB_SHA"' in text
    assert "Candidate-to-main runtime drift" in text
    assert ".github/scripts/anonymous-candidate-preflight.sh" in text
    assert ".github/scripts/release-oci.sh" in text
    assert ".github/workflows/main-release.yaml" in text
    assert "tests/test_release_workflow_contract.py" in text
    assert "tests/test_main_release_workflow.py" in text
    assert "source-rootfs-manifest.py verify" in text
    assert ".gap007_release.source_rootfs_sha256" in text
    assert "gap007_release.evidence_sha256" in text
    assert "--manifest release-candidate/candidate-index.json" in text
    assert "Reject conflicting tag or Release before registry mutation" in text
    for gate in (
        "exact_digest_smoke",
        "gap007_performance_durability",
        "native_arm64_full_feasible",
        "source_quality",
        "spdx_leaf_sbom",
    ):
        assert f'"{gate}": "PASS"' in text


def test_main_release_carbon_copies_generic_last_and_verifies_anonymously() -> None:
    _, text = _workflow()
    promote = text.index("Carbon-copy numeric architecture and generic tags")
    amd64 = text.index("amd64_image }}:${RELEASE_VERSION}", promote)
    arm64 = text.index("arm64_image }}:${RELEASE_VERSION}", promote)
    generic = text.index("candidate.outputs.image }}:${RELEASE_VERSION}", promote)
    assert amd64 < arm64 < generic
    assert text.count("release-oci.sh ensure-tag") == 3
    assert "anonymous-candidate-preflight.sh" in text
    assert "--expected-digest \"$GENERIC_DIGEST\"" in text
    assert 'docker pull --platform linux/amd64' in text
    assert 'docker pull --platform linux/arm64' in text
    assert text.count('docker image rm --force "${IMAGE}@${GENERIC_DIGEST}"') == 2
    assert '"${AMD64_IMAGE}:${RELEASE_VERSION}|${AMD64_STAGE_DIGEST}"' in text
    assert '"${ARM64_IMAGE}:${RELEASE_VERSION}|${ARM64_STAGE_DIGEST}"' in text


def test_main_release_creates_annotated_tag_and_prerelease_without_fake_evidence() -> None:
    _, text = _workflow()
    assert '"/repos/${GITHUB_REPOSITORY}/git/tags"' in text
    assert '--field type=commit' in text
    assert '--field ref="refs/tags/${RELEASE_VERSION}"' in text
    assert "gh release create \"$RELEASE_VERSION\"" in text
    assert "--verify-tag" in text
    assert '--target "$CANDIDATE_SOURCE"' in text
    assert "--prerelease" in text
    assert ".message == $message" in text
    assert ".target_commitish == $source" in text
    assert ".name == $title" in text
    assert "grep -Fq '(HTTP 404)' \"$release_error\"" in text
    assert "real-device acceptance continues after publication" in text
    assert "haos_evidence_json" not in text
    assert "release-evidence.json" not in text


def test_repository_advertises_the_numeric_tag_published_by_main_release() -> None:
    workflow, _ = _workflow()
    config = yaml.safe_load(
        (ROOT / "antigravity_home_assistant" / "config.yaml").read_text(
            encoding="utf-8"
        )
    )
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert config["version"] == inputs["version"]["default"] == "2.0.1"
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
