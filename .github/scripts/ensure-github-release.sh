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
declare -A expected_asset_paths=()
for asset in "${assets[@]}"; do
  [[ -f $asset ]] || {
    echo "missing release asset: ${asset}" >&2
    exit 1
  }
  asset_name=${asset##*/}
  [[ $asset_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] || {
    echo "unsafe release asset name: ${asset_name}" >&2
    exit 1
  }
  [[ ! ${expected_asset_paths[$asset_name]+present} ]] || {
    echo "duplicate expected release asset name: ${asset_name}" >&2
    exit 1
  }
  expected_asset_paths[$asset_name]=$asset
done

repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
release_json="${temporary_directory}/release.json"
error_file="${temporary_directory}/release-error.txt"
expected_body=$(cat "$notes")
verified_missing_assets=()

verify_release_identity() {
  local current_release=$1
  local existing_body
  jq --exit-status \
    --arg version "$version" \
    --arg source_sha "$source_sha" '
      .tag_name == $version
      and .target_commitish == $source_sha
      and .draft == false
      and .prerelease == true
    ' \
    "$current_release" >/dev/null
  existing_body=$(jq --raw-output '.body' "$current_release")
  [[ $existing_body == "$expected_body" ]] || {
    echo "existing GitHub Release body conflicts with the deterministic notes" >&2
    return 1
  }
}

verify_release_assets() {
  local current_release=$1
  local allow_missing=$2
  local download_root=$3
  local asset asset_digest asset_index asset_name asset_size count
  local download_directory existing_name
  local -A actual_asset_counts=()

  verified_missing_assets=()
  jq --exit-status '
    (.assets | type == "array")
    and all(.assets[]?;
      (.name | type == "string")
      and ((.name // "") | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$"))
    )
  ' "$current_release" >/dev/null
  while IFS= read -r existing_name; do
    if [[ ${actual_asset_counts[$existing_name]+present} ]]; then
      actual_asset_counts[$existing_name]=2
    else
      actual_asset_counts[$existing_name]=1
    fi
  done < <(jq --raw-output '.assets[].name' "$current_release")
  for existing_name in "${!actual_asset_counts[@]}"; do
    [[ ${actual_asset_counts[$existing_name]} == 1 ]] || {
      echo "existing GitHub Release has duplicate ${existing_name}" >&2
      return 1
    }
    if [[ $existing_name != ha005-acceptance.json ]] \
      && [[ $existing_name != public-install-acceptance.json ]] \
      && [[ ! ${expected_asset_paths[$existing_name]+present} ]]; then
      echo "existing GitHub Release has unexpected asset: ${existing_name}" >&2
      return 1
    fi
  done
  for acceptance_name in \
    ha005-acceptance.json \
    public-install-acceptance.json; do
    if [[ ${actual_asset_counts[$acceptance_name]:-0} == 1 ]]; then
      jq --exit-status --arg name "$acceptance_name" '
        [.assets[] | select(.name == $name)] as $matches
        | ($matches | length == 1)
          and $matches[0].state == "uploaded"
          and ($matches[0].digest | type == "string")
          and ($matches[0].digest | test("^sha256:[0-9a-f]{64}$"))
          and ($matches[0].size | type == "number"
            and . > 0 and . <= 1048576)
      ' "$current_release" >/dev/null || {
        echo "existing acceptance asset metadata is invalid: ${acceptance_name}" >&2
        return 1
      }
    fi
  done

  asset_index=0
  for asset in "${assets[@]}"; do
    asset_name=${asset##*/}
    count=${actual_asset_counts[$asset_name]:-0}
    if [[ $count == 0 ]]; then
      if [[ $allow_missing == true ]]; then
        verified_missing_assets+=("$asset")
        continue
      fi
      echo "GitHub Release is still missing expected asset: ${asset_name}" >&2
      return 1
    fi
    asset_digest="sha256:$(sha256sum "$asset" | cut -d ' ' -f 1)"
    asset_size=$(stat --format '%s' "$asset")
    jq --exit-status \
      --arg digest "$asset_digest" \
      --arg name "$asset_name" \
      --argjson size "$asset_size" '
        [.assets[] | select(.name == $name)] as $matches
        | ($matches | length == 1)
          and $matches[0].state == "uploaded"
          and $matches[0].digest == $digest
          and $matches[0].size == $size
      ' "$current_release" >/dev/null || {
        echo "existing GitHub Release asset metadata conflicts: ${asset_name}" >&2
        return 1
      }
    download_directory="${download_root}/${asset_index}"
    mkdir -p -- "$download_directory"
    gh release download "$version" \
      --repo "$repository" \
      --pattern "$asset_name" \
      --dir "$download_directory"
    cmp --silent "$asset" "${download_directory}/${asset_name}" || {
      echo "existing GitHub Release asset conflicts: ${asset_name}" >&2
      return 1
    }
    asset_index=$((asset_index + 1))
  done
}

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
  verify_release_identity "$release_json"
  verify_release_assets \
    "$release_json" true "${temporary_directory}/preflight-assets"
  missing_assets=("${verified_missing_assets[@]}")
  for asset in "${missing_assets[@]}"; do
    gh release upload "$version" "$asset" --repo "$repository"
  done
  if ((${#missing_assets[@]})); then
    post_upload_release="${temporary_directory}/post-upload-release.json"
    gh api "/repos/${repository}/releases/tags/${version}" \
      > "$post_upload_release"
    verify_release_identity "$post_upload_release"
    verify_release_assets \
      "$post_upload_release" false "${temporary_directory}/post-upload-assets"
    echo "resumed: GitHub Release ${version} now has every expected asset"
  else
    echo "same: GitHub Release ${version} already has the exact notes and assets"
  fi
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
created_release="${temporary_directory}/created-release.json"
gh api "/repos/${repository}/releases/tags/${version}" > "$created_release"
verify_release_identity "$created_release"
verify_release_assets \
  "$created_release" false "${temporary_directory}/created-assets"
