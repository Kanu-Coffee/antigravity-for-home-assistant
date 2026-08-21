#!/bin/bash -p
set -Eeuo pipefail
umask 077

readonly CASE_FILE=/data/onboarding-controller-case
readonly CLI_HOME=${HOME:?}/.gemini/antigravity-cli
readonly SETTINGS=${CLI_HOME}/settings.json
readonly OAUTH=${CLI_HOME}/antigravity-oauth-token
readonly ONBOARDING=${CLI_HOME}/cache/onboarding.json

rewrite_settings() {
  /usr/bin/jq '.enableTelemetry = false' "${SETTINGS}" > "${SETTINGS}.stub"
  /bin/chmod 0600 "${SETTINGS}.stub"
  /bin/mv -fT "${SETTINGS}.stub" "${SETTINGS}"
}

write_consumer_state() {
  local consumer=$1
  /usr/bin/install -d -m 0700 "${CLI_HOME}/cache"
  printf '%s\n' 'synthetic-opaque-oauth-state' > "${OAUTH}"
  printf \
    '{"consumerOnboardingComplete":%s,"enterpriseOnboardingComplete":false}\n' \
    "${consumer}" > "${ONBOARDING}"
  /bin/chmod 0600 "${OAUTH}" "${ONBOARDING}"
}

write_consumer_marker_only() {
  local consumer=$1
  /usr/bin/install -d -m 0700 "${CLI_HOME}/cache"
  printf \
    '{"consumerOnboardingComplete":%s,"enterpriseOnboardingComplete":false}\n' \
    "${consumer}" > "${ONBOARDING}"
  /bin/chmod 0600 "${ONBOARDING}"
}

case "$(< "${CASE_FILE}")" in
  success)
    rewrite_settings
    write_consumer_state true
    exit 130
    ;;
  incomplete)
    rewrite_settings
    write_consumer_state false
    exit 0
    ;;
  unexpected)
    rewrite_settings
    write_consumer_state true
    exit 42
    ;;
  timeout)
    rewrite_settings
    write_consumer_state true
    exit 124
    ;;
  quarantine)
    /usr/bin/jq '.futureSecurityPolicy = "disabled"' \
      "${SETTINGS}" > "${SETTINGS}.stub"
    /bin/chmod 0600 "${SETTINGS}.stub"
    /bin/mv -fT "${SETTINGS}.stub" "${SETTINGS}"
    write_consumer_state true
    exit 0
    ;;
  upgrade-oauth)
    rewrite_settings
    write_consumer_marker_only true
    exit 130
    ;;
  upgrade-complete)
    rewrite_settings
    exit 130
    ;;
  marker-without-oauth)
    exit 0
    ;;
  enterprise)
    exit 99
    ;;
  *)
    exit 64
    ;;
esac
