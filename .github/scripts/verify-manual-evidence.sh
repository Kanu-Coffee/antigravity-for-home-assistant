#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 || ! -f $1 || ! -f $2 ]]; then
  echo "usage: verify-manual-evidence.sh MANUAL_EVIDENCE_JSON CANDIDATE_JSON OUTPUT_DIRECTORY" >&2
  exit 64
fi
manual_evidence=$1
candidate=$2
output_directory=$3
index=0
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

python3 "${script_directory}/release_contract.py" manual \
  --candidate "$candidate" \
  --manual "$manual_evidence"

if [[ -e $output_directory || -L $output_directory ]]; then
  echo "HAOS evidence output directory must not already exist" >&2
  exit 1
fi
temporary_directory=$(mktemp -d -- "${output_directory}.tmp.XXXXXX")
trap 'rm -rf -- "$temporary_directory"' EXIT
canonical_directory="${temporary_directory}/canonical"
install -d -m 0700 -- "$canonical_directory"

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
  python3 "${script_directory}/release_contract.py" manual-report \
    --candidate "$candidate" \
    --manual "$manual_evidence" \
    --gate "$gate" \
    --evidence "$output" \
    --output "${canonical_directory}/${gate}.json"
  chmod 0600 -- "${canonical_directory}/${gate}.json"
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
[[ $(find -P "$canonical_directory" -mindepth 1 -maxdepth 1 -type f -links 1 | wc -l) -eq 8 ]] || {
  echo "exactly eight canonical HAOS gate reports are required" >&2
  exit 1
}
mv -- "$canonical_directory" "$output_directory"
