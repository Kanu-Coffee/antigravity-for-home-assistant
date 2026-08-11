#!/usr/bin/env bash

readonly ANTIGRAVITY_HA_OPTIONS_FILE=${ANTIGRAVITY_HA_OPTIONS_FILE:-/run/antigravity-ha/ha-feedback-options.json}

antigravity_ha_config_validate() {
  [[ -r "${ANTIGRAVITY_HA_OPTIONS_FILE}" ]] \
    && jq --exit-status 'type == "object"' "${ANTIGRAVITY_HA_OPTIONS_FILE}" >/dev/null
}

antigravity_ha_config_string() {
  local key=$1
  local default_value=$2
  jq --exit-status --raw-output \
    --arg key "${key}" \
    --arg default_value "${default_value}" \
    'if has($key) then .[$key] else $default_value end
      | if type == "string" then . else error("option is not a string") end' \
    "${ANTIGRAVITY_HA_OPTIONS_FILE}"
}

antigravity_ha_config_true() {
  local key=$1
  jq --exit-status --arg key "${key}" \
    'has($key) and .[$key] == true' "${ANTIGRAVITY_HA_OPTIONS_FILE}" >/dev/null
}

antigravity_ha_config_bool() {
  local key=$1
  local default_value=$2
  if [[ "${default_value}" != true && "${default_value}" != false ]]; then
    return 2
  fi
  jq --raw-output \
    --arg key "${key}" \
    --argjson default_value "${default_value}" \
    'if has($key) then .[$key] else $default_value end
      | if type == "boolean" then . else error("option is not a boolean") end' \
    "${ANTIGRAVITY_HA_OPTIONS_FILE}"
}

antigravity_ha_config_json() {
  local key=$1
  local default_json=$2
  jq --compact-output \
    --arg key "${key}" \
    --argjson default_json "${default_json}" \
    'if has($key) then .[$key] else $default_json end' \
    "${ANTIGRAVITY_HA_OPTIONS_FILE}"
}
