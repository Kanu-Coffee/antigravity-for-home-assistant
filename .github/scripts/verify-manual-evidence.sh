#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! -f $1 ]]; then
  echo "usage: verify-manual-evidence.sh MANUAL_EVIDENCE_JSON" >&2
  exit 64
fi
manual_evidence=$1
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
index=0

while IFS=$'\t' read -r gate uri expected_digest; do
  [[ $gate =~ ^[a-z0-9_]+$ ]]
  [[ $expected_digest =~ ^sha256:[0-9a-f]{64}$ ]]
  output="${temporary_directory}/${index}.evidence"
  curl_args=(
    --fail
    --location
    --max-filesize 67108864
    --max-time 120
    --output "$output"
    --proto '=https'
    --show-error
    --silent
  )
  case "$uri" in
    https://api.github.com/repos/Kanu-Coffee/antigravity-for-home-assistant/actions/artifacts/*/zip)
      [[ ${GH_TOKEN:-} ]] || {
        echo "GH_TOKEN is required for Actions evidence: ${gate}" >&2
        exit 1
      }
      curl_args+=(
        --header "Accept: application/vnd.github+json"
        --header "Authorization: Bearer ${GH_TOKEN}"
        --header "X-GitHub-Api-Version: 2022-11-28"
      )
      ;;
    https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases/download/*/*)
      ;;
    *)
      echo "evidence URI escaped the repository allowlist: ${gate}" >&2
      exit 1
      ;;
  esac
  curl "${curl_args[@]}" "$uri"
  actual_digest="sha256:$(sha256sum "$output" | cut -d ' ' -f 1)"
  if [[ $actual_digest != "$expected_digest" ]]; then
    echo "downloaded evidence digest mismatch: ${gate}" >&2
    exit 1
  fi
  index=$((index + 1))
done < <(jq --raw-output '
  .gates
  | to_entries
  | sort_by(.key)
  | .[]
  | [.key, .value.evidence_uri, .value.sha256]
  | @tsv
' "$manual_evidence")

[[ $index -eq 8 ]] || {
  echo "exactly eight downloaded manual evidence objects are required" >&2
  exit 1
}
