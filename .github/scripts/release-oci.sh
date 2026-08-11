#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: release-oci.sh ensure-tag TARGET:TAG SOURCE@SHA256 EXPECTED_SHA256" >&2
  exit 64
}

[[ $# -eq 4 && $1 == ensure-tag ]] || usage
target=$2
source_ref=$3
expected_digest=$4

digest_pattern='^sha256:[0-9a-f]{64}$'
reference_pattern='^ghcr\.io/kanu-coffee/(amd64-|aarch64-)?antigravity-for-home-assistant'
[[ $expected_digest =~ $digest_pattern ]] || usage
[[ $target =~ ${reference_pattern}:[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[[ $source_ref =~ ${reference_pattern}@sha256:[0-9a-f]{64}$ ]] || usage
[[ ${target%:*} == "${source_ref%@*}" ]] || {
  echo "target and immutable source must use the same repository" >&2
  exit 64
}
[[ ${source_ref##*@} == "$expected_digest" ]] || {
  echo "source reference and expected digest differ" >&2
  exit 1
}

owner=Kanu-Coffee
target_without_registry=${target#ghcr.io/kanu-coffee/}
package=${target_without_registry%%:*}
tag=${target_without_registry##*:}
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT

# API success is a precondition for deciding that a tag is absent. A 403,
# network error, malformed response, or even a package-level 404 is fatal.
gh api --paginate --slurp \
  "/users/${owner}/packages/container/${package}/versions?per_page=100" \
  > "${temporary_directory}/versions.json"
jq --exit-status 'type == "array" and all(.[]; type == "array")' \
  "${temporary_directory}/versions.json" >/dev/null
matching_versions=$(jq --arg tag "$tag" '
  [.[][] | select(.metadata.container.tags | index($tag))] | length
' "${temporary_directory}/versions.json")
[[ $matching_versions =~ ^[0-9]+$ ]] || exit 1
if (( matching_versions > 1 )); then
  echo "registry API returned duplicate versions for ${target}" >&2
  exit 1
fi

inspect_digest() {
  local reference=$1
  local output=$2
  if ! docker buildx imagetools inspect --raw "$reference" > "$output"; then
    return 1
  fi
  printf 'sha256:%s\n' "$(sha256sum "$output" | cut -d ' ' -f 1)"
}

if (( matching_versions == 1 )); then
  current_digest=$(inspect_digest "$target" "${temporary_directory}/existing.json")
  if [[ $current_digest == "$expected_digest" ]]; then
    echo "same: ${target} already resolves to ${expected_digest}"
    exit 0
  fi
  echo "conflict: ${target} resolves to ${current_digest}, expected ${expected_digest}" >&2
  exit 1
fi

# The package versions API can lag behind a registry-visible mutable tag. Do a
# second, authenticated registry lookup immediately before creation so a
# visible same/conflicting tag is never overwritten merely because the API
# returned zero matches. Only a narrow manifest-missing response proves absent;
# authorization, transport, and other registry errors fail closed.
precheck_error="${temporary_directory}/precheck-error.txt"
if current_digest=$(inspect_digest \
  "$target" "${temporary_directory}/precheck.json" 2> "$precheck_error"); then
  if [[ $current_digest == "$expected_digest" ]]; then
    echo "same: ${target} already resolves to ${expected_digest}"
    exit 0
  fi
  echo "conflict: ${target} resolves to ${current_digest}, expected ${expected_digest}" >&2
  exit 1
fi
if ! grep -Eiq \
  'manifest unknown|no such manifest|manifest[^[:cntrl:]]*not found' \
  "$precheck_error"; then
  cat "$precheck_error" >&2
  echo "registry absence was not established for ${target}; refusing to create" >&2
  exit 1
fi

metadata_file="${temporary_directory}/metadata.json"
docker buildx imagetools create \
  --metadata-file "$metadata_file" \
  --tag "$target" \
  "$source_ref"
published_digest=$(jq --raw-output '."containerimage.descriptor".digest' "$metadata_file")
[[ $published_digest == "$expected_digest" ]] || {
  echo "promotion was not a carbon copy: ${published_digest}" >&2
  exit 1
}
resolved_digest=$(inspect_digest "$target" "${temporary_directory}/promoted.json")
[[ $resolved_digest == "$expected_digest" ]] || {
  echo "promoted tag does not resolve to the expected digest" >&2
  exit 1
}
echo "absent->created: ${target} now resolves to ${expected_digest}"
