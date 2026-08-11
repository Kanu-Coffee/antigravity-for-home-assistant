#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: ensure-github-release.sh VERSION SOURCE_SHA NOTES ASSET..." >&2
  exit 64
fi
version=$1
source_sha=$2
notes=$3
shift 3
assets=("$@")

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 64
[[ $source_sha =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ -f $notes && ${#assets[@]} -gt 0 ]] || exit 64
for asset in "${assets[@]}"; do
  [[ -f $asset ]] || {
    echo "missing release asset: ${asset}" >&2
    exit 1
  }
done

repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
release_json="${temporary_directory}/release.json"
error_file="${temporary_directory}/release-error.txt"

# Bind the remote annotated tag object to the same commit independently of the
# workflow checkout and the release record.
gh api "/repos/${repository}/git/ref/tags/${version}" \
  > "${temporary_directory}/tag-ref.json"
jq --exit-status \
  '.object.type == "tag" and (.object.sha | test("^[0-9a-f]{40}$"))' \
  "${temporary_directory}/tag-ref.json" >/dev/null
tag_object_sha=$(jq --raw-output .object.sha \
  "${temporary_directory}/tag-ref.json")
gh api "/repos/${repository}/git/tags/${tag_object_sha}" \
  > "${temporary_directory}/tag-object.json"
jq --exit-status \
  --arg version "$version" \
  --arg source_sha "$source_sha" '
    .tag == $version
    and .object.type == "commit"
    and .object.sha == $source_sha
  ' "${temporary_directory}/tag-object.json" >/dev/null

if gh api "/repos/${repository}/releases/tags/${version}" \
  > "$release_json" 2> "$error_file"; then
  jq --exit-status \
    --arg version "$version" \
    --arg source_sha "$source_sha" '
      .tag_name == $version
      and .target_commitish == $source_sha
      and .draft == false
      and .prerelease == true
    ' \
    "$release_json" >/dev/null
  existing_body=$(jq --raw-output '.body' "$release_json")
  expected_body=$(cat "$notes")
  [[ $existing_body == "$expected_body" ]] || {
    echo "existing GitHub Release body conflicts with the deterministic notes" >&2
    exit 1
  }
  for asset in "${assets[@]}"; do
    asset_name=${asset##*/}
    count=$(jq --arg name "$asset_name" \
      '[.assets[] | select(.name == $name)] | length' "$release_json")
    if [[ $count == 0 ]]; then
      gh release upload "$version" "$asset" --repo "$repository"
      continue
    fi
    [[ $count == 1 ]] || {
      echo "existing GitHub Release has duplicate ${asset_name}" >&2
      exit 1
    }
    gh release download "$version" \
      --repo "$repository" \
      --pattern "$asset_name" \
      --dir "${temporary_directory}/assets"
    cmp --silent "$asset" "${temporary_directory}/assets/${asset_name}" || {
      echo "existing GitHub Release asset conflicts: ${asset_name}" >&2
      exit 1
    }
  done
  echo "same: GitHub Release ${version} already has the exact notes and assets"
  exit 0
fi

if ! grep -Fq '(HTTP 404)' "$error_file"; then
  cat "$error_file" >&2
  exit 1
fi

# GitHub rejects release creation with the workflow token when the resolved
# target changes .github/workflows relative to the default branch. Requiring
# the release source to already be contained in the current default branch and
# requiring the exact .github/workflows tree to match are independently
# verifiable and avoid broadening token authority. Image
# promotion and attestations remain resumable before this final publishing
# step, so a failed job can be rerun after the reviewed source is merged.
gh api "/repos/${repository}" > "${temporary_directory}/repository.json"
default_branch=$(jq --raw-output --exit-status \
  '.default_branch | select(type == "string" and length > 0)' \
  "${temporary_directory}/repository.json")
default_branch_encoded=$(jq --null-input --raw-output \
  --arg branch "$default_branch" '$branch | @uri')
gh api "/repos/${repository}/commits/${default_branch_encoded}" \
  > "${temporary_directory}/default-commit.json"
default_sha=$(jq --raw-output --exit-status \
  '.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' \
  "${temporary_directory}/default-commit.json")
gh api "/repos/${repository}/compare/${source_sha}...${default_sha}" \
  > "${temporary_directory}/default-contains-source.json"
if ! jq --exit-status \
  --arg source_sha "$source_sha" '
    (.status == "ahead" or .status == "identical")
    and .merge_base_commit.sha == $source_sha
  ' "${temporary_directory}/default-contains-source.json" >/dev/null; then
  echo "release source must be merged into the current default branch before GitHub Release creation" >&2
  exit 1
fi

workflow_tree_sha() {
  local commit_sha=$1
  local label=$2
  local commit_file="${temporary_directory}/${label}-git-commit.json"
  local root_file="${temporary_directory}/${label}-root-tree.json"
  local github_file="${temporary_directory}/${label}-github-tree.json"
  local root_tree
  local github_tree

  gh api "/repos/${repository}/git/commits/${commit_sha}" > "$commit_file" || return 1
  root_tree=$(jq --raw-output --exit-status \
    '.tree.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' \
    "$commit_file") || return 1
  gh api "/repos/${repository}/git/trees/${root_tree}" > "$root_file" || return 1
  github_tree=$(jq --raw-output --exit-status '
    [.tree[] | select(.path == ".github" and .type == "tree")]
    | if length == 1 then .[0].sha else error("invalid .github tree") end
    | select(type == "string" and test("^[0-9a-f]{40}$"))
  ' "$root_file") || return 1
  gh api "/repos/${repository}/git/trees/${github_tree}" > "$github_file" || return 1
  jq --raw-output --exit-status '
    [.tree[] | select(.path == "workflows" and .type == "tree")]
    | if length == 1 then .[0].sha else error("invalid workflows tree") end
    | select(type == "string" and test("^[0-9a-f]{40}$"))
  ' "$github_file"
}

source_workflow_tree=$(workflow_tree_sha "$source_sha" source)
default_workflow_tree=$(workflow_tree_sha "$default_sha" default)
if [[ $source_workflow_tree != "$default_workflow_tree" ]]; then
  echo "release source modifies .github/workflows relative to the current default branch" >&2
  echo "merge the exact source without later workflow drift before resuming the GitHub Release job" >&2
  exit 1
fi

gh release create "$version" \
  --repo "$repository" \
  --verify-tag \
  --target "$source_sha" \
  --title "Antigravity for Home Assistant ${version}" \
  --prerelease \
  --notes-file "$notes" \
  "${assets[@]}"
gh api "/repos/${repository}/releases/tags/${version}" \
  > "${temporary_directory}/created-release.json"
jq --exit-status \
  --arg version "$version" \
  --arg source_sha "$source_sha" '
    .tag_name == $version
    and .target_commitish == $source_sha
    and .draft == false
    and .prerelease == true
  ' "${temporary_directory}/created-release.json" >/dev/null
