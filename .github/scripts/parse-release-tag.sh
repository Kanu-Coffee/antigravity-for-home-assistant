#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: parse-release-tag.sh NUMERIC_VERSION" >&2
  exit 64
fi
version=$1
tag_ref="refs/tags/${version}"
[[ ${GITHUB_OUTPUT:-} ]] || {
  echo "GITHUB_OUTPUT is required" >&2
  exit 64
}
[[ $(git cat-file -t "$tag_ref") == tag ]] || {
  echo "Release tag must be annotated" >&2
  exit 1
}
source_sha=$(git rev-list --max-count=1 "$tag_ref")
[[ $source_sha =~ ^[0-9a-f]{40}$ ]]
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
trailers="${temporary_directory}/release-trailers.txt"
git for-each-ref --format='%(contents)' "$tag_ref" \
  | git interpret-trailers --parse > "$trailers"
test "$(wc -l < "$trailers")" -eq 6

trailer() {
  local key=$1
  local -a values
  mapfile -t values < <(sed -n "s/^${key}: //p" "$trailers")
  [[ ${#values[@]} -eq 1 ]] || {
    echo "Annotated tag needs exactly one ${key} trailer" >&2
    exit 1
  }
  printf '%s\n' "${values[0]}"
}

candidate_run_id=$(trailer Candidate-Run-ID)
candidate_run_attempt=$(trailer Candidate-Run-Attempt)
evidence_run_id=$(trailer Release-Evidence-Run-ID)
evidence_run_attempt=$(trailer Release-Evidence-Run-Attempt)
evidence_artifact=$(trailer Release-Evidence-Artifact)
evidence_digest=$(trailer Release-Evidence-SHA256)
for number in \
  "$candidate_run_id" "$candidate_run_attempt" \
  "$evidence_run_id" "$evidence_run_attempt"; do
  [[ $number =~ ^[1-9][0-9]*$ ]]
done
[[ $evidence_digest =~ ^sha256:[0-9a-f]{64}$ ]]
expected_artifact="release-evidence-${version}-${source_sha}-${candidate_run_id}-${candidate_run_attempt}-${evidence_run_id}-${evidence_run_attempt}"
[[ $evidence_artifact == "$expected_artifact" ]] || {
  echo "Release evidence artifact name is not bound to tag/source/runs" >&2
  exit 1
}
{
  printf 'candidate_run_attempt=%s\n' "$candidate_run_attempt"
  printf 'candidate_run_id=%s\n' "$candidate_run_id"
  printf 'evidence_artifact=%s\n' "$evidence_artifact"
  printf 'evidence_digest=%s\n' "$evidence_digest"
  printf 'evidence_run_attempt=%s\n' "$evidence_run_attempt"
  printf 'evidence_run_id=%s\n' "$evidence_run_id"
  printf 'source_sha=%s\n' "$source_sha"
} >> "$GITHUB_OUTPUT"
