#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: anonymous-candidate-preflight.sh IMAGE INDEX_DIGEST AMD64_IMAGE AMD64_STAGE ARM64_IMAGE ARM64_STAGE CONTRACT_SCRIPT" >&2
  exit 64
fi

image=$1
index_digest=$2
amd64_image=$3
amd64_stage=$4
arm64_image=$5
arm64_stage=$6
contract_script=$7
digest_pattern='^sha256:[0-9a-f]{64}$'
[[ $image == ghcr.io/kanu-coffee/antigravity-for-home-assistant ]] || exit 64
[[ $amd64_image == ghcr.io/kanu-coffee/amd64-antigravity-for-home-assistant ]] || exit 64
[[ $arm64_image == ghcr.io/kanu-coffee/aarch64-antigravity-for-home-assistant ]] || exit 64
for digest in "$index_digest" "$amd64_stage" "$arm64_stage"; do
  [[ $digest =~ $digest_pattern ]] || exit 64
done

for package in \
  antigravity-for-home-assistant \
  amd64-antigravity-for-home-assistant \
  aarch64-antigravity-for-home-assistant; do
  visibility=$(gh api "/users/Kanu-Coffee/packages/container/${package}" \
    --jq '.visibility')
  if [[ $visibility != public ]]; then
    echo "GHCR package is not public: ${package} (${visibility})" >&2
    exit 1
  fi
done

anonymous_config=$(mktemp -d)
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$anonymous_config" "$temporary_directory"' EXIT
printf '{}\n' > "${anonymous_config}/config.json"
export DOCKER_CONFIG=$anonymous_config

docker buildx imagetools inspect --raw "${image}@${index_digest}" \
  > "${temporary_directory}/candidate-index.json"
python3 "$contract_script" index \
  --manifest "${temporary_directory}/candidate-index.json" \
  --expected-arch amd64 \
  --expected-arch aarch64 \
  --expected-digest "$index_digest"

for reference in \
  "${amd64_image}@${amd64_stage}" \
  "${arm64_image}@${arm64_stage}"; do
  docker buildx imagetools inspect --raw "$reference" \
    > "${temporary_directory}/$(printf '%s' "$reference" | sha256sum | cut -d ' ' -f 1).json"
done
docker pull --platform linux/amd64 "${image}@${index_digest}"
docker pull --platform linux/arm64 "${image}@${index_digest}"
