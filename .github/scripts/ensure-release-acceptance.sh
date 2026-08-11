#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: ensure-release-acceptance.sh VERSION SOURCE_SHA ACCEPTANCE_JSON" >&2
  exit 64
fi
version=$1
source_sha=$2
asset=$3
asset_name=${asset##*/}

[[ $version =~ ^2\.[0-9]+\.[0-9]+$ ]] || {
  echo "release acceptance requires a numeric v2 version" >&2
  exit 64
}
[[ $source_sha =~ ^[0-9a-f]{40}$ ]] || exit 64
case "$asset_name" in
  ha005-acceptance.json)
    expected_schema=antigravity-ha-ha005-acceptance/v1
    expected_test_id=HA-005
    ;;
  public-install-acceptance.json)
    expected_schema=antigravity-ha-public-install-acceptance/v1
    expected_test_id=HA-008
    ;;
  *)
    echo "unsupported release acceptance asset name: ${asset_name}" >&2
    exit 64
    ;;
esac
[[ -f $asset && ! -L $asset && $(stat --format '%h' "$asset") == 1 ]] || {
  echo "release acceptance asset must be a single regular file" >&2
  exit 64
}
asset_size=$(stat --format '%s' "$asset")
(( asset_size > 0 && asset_size <= 1048576 )) || {
  echo "release acceptance asset must be non-empty and at most 1 MiB" >&2
  exit 64
}
jq --exit-status \
  --arg schema "$expected_schema" \
  --arg test_id "$expected_test_id" \
  --arg version "$version" \
  --arg source_sha "$source_sha" '
    type == "object"
    and .schema == $schema
    and .test_id == $test_id
    and .status == "PASS"
    and (.release | type == "object")
    and .release.version == $version
    and .release.source_sha == $source_sha
  ' "$asset" >/dev/null || {
  echo "release acceptance asset schema or release binding differs: ${asset_name}" >&2
  exit 64
}
asset_digest="sha256:$(sha256sum "$asset" | cut -d ' ' -f 1)"
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT

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

release_json="${temporary_directory}/release.json"
gh api "/repos/${repository}/releases/tags/${version}" > "$release_json"
jq --exit-status \
  --arg version "$version" \
  --arg source_sha "$source_sha" '
    .tag_name == $version
    and .target_commitish == $source_sha
    and .draft == false
    and .prerelease == true
    and (.published_at | type == "string")
  ' "$release_json" >/dev/null

verify_exact_asset() {
  local current_release=$1
  local download_directory=$2
  local count
  count=$(jq --arg name "$asset_name" \
    '[.assets[] | select(.name == $name)] | length' "$current_release")
  [[ $count == 1 ]] || {
    echo "GitHub Release must contain exactly one ${asset_name}" >&2
    return 1
  }
  jq --exit-status \
    --arg name "$asset_name" \
    --arg digest "$asset_digest" \
    --argjson size "$asset_size" '
      [.assets[] | select(.name == $name)]
      | length == 1
      and .[0].state == "uploaded"
      and .[0].digest == $digest
      and .[0].size == $size
    ' "$current_release" >/dev/null
  mkdir "$download_directory"
  gh release download "$version" \
    --repo "$repository" \
    --pattern "$asset_name" \
    --dir "$download_directory"
  cmp --silent "$asset" "${download_directory}/${asset_name}" || {
    echo "existing GitHub Release acceptance asset conflicts: ${asset_name}" >&2
    return 1
  }
}

asset_count=$(jq --arg name "$asset_name" \
  '[.assets[] | select(.name == $name)] | length' "$release_json")
if [[ $asset_count == 1 ]]; then
  verify_exact_asset "$release_json" "${temporary_directory}/existing"
  echo "same: GitHub Release ${version} already has the exact ${asset_name}"
  exit 0
fi
[[ $asset_count == 0 ]] || {
  echo "GitHub Release has duplicate ${asset_name} assets" >&2
  exit 1
}

gh release upload "$version" "$asset" --repo "$repository"
gh api "/repos/${repository}/releases/tags/${version}" \
  > "${temporary_directory}/uploaded-release.json"
verify_exact_asset \
  "${temporary_directory}/uploaded-release.json" \
  "${temporary_directory}/uploaded"
echo "created: attached immutable ${asset_name} to GitHub Release ${version}"
