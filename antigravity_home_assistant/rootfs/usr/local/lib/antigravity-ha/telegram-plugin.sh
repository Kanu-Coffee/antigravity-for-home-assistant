#!/bin/sh

antigravity_ha_telegram_settings_match() {
  if [ "$#" -ne 2 ] || [ ! -f "$1" ] || [ ! -f "$2" ]; then
    return 64
  fi

  # The pinned Antigravity 1.1.11 binary serializes these three explicit safe
  # defaults out of settings.json. Keep the image file explicit, but admit only
  # its byte-exact form or that one known native-normalized semantic form.
  if cmp -s -- "$1" "$2"; then
    return 0
  fi

  antigravity_ha_settings_expected_temporary=$(mktemp \
    /tmp/.telegram-settings-expected.XXXXXX) || return 1
  antigravity_ha_settings_observed_temporary=$(mktemp \
    /tmp/.telegram-settings-observed.XXXXXX) || {
    rm -f -- "${antigravity_ha_settings_expected_temporary}"
    unset antigravity_ha_settings_expected_temporary
    return 1
  }
  if ! /usr/bin/jq --exit-status --sort-keys '
      (if .toolPermission == "request-review" then del(.toolPermission) else . end)
      | (if .allowNonWorkspaceAccess == false then del(.allowNonWorkspaceAccess) else . end)
      | (if .permissions.ask == [] then del(.permissions.ask) else . end)
    ' "$1" > "${antigravity_ha_settings_expected_temporary}" \
    || ! /usr/bin/jq --exit-status --sort-keys . \
      "$2" > "${antigravity_ha_settings_observed_temporary}" \
    || ! cmp -s -- \
      "${antigravity_ha_settings_expected_temporary}" \
      "${antigravity_ha_settings_observed_temporary}"; then
    rm -f -- \
      "${antigravity_ha_settings_expected_temporary}" \
      "${antigravity_ha_settings_observed_temporary}"
    unset \
      antigravity_ha_settings_expected_temporary \
      antigravity_ha_settings_observed_temporary
    return 1
  fi
  rm -f -- \
    "${antigravity_ha_settings_expected_temporary}" \
    "${antigravity_ha_settings_observed_temporary}"
  unset \
    antigravity_ha_settings_expected_temporary \
    antigravity_ha_settings_observed_temporary
  return 0
}

antigravity_ha_render_telegram_plugin_mcp() {
  if [ "$#" -ne 1 ]; then
    return 64
  fi

  /usr/bin/jq --exit-status --sort-keys '
    if (.mcpServers | type) != "object"
      or ((.mcpServers | keys) != [
        "ha_change",
        "ha_memory",
        "ha_read",
        "ha_validate",
        "playwright"
      ])
      or (([.mcpServers[] | type] | all(. == "object")) | not)
      or (([.mcpServers[].cwd] | all(. == "/config")) | not)
    then
      error("the canonical Home Assistant plugin MCP contract is invalid")
    else
      .mcpServers |= with_entries(
        .value.cwd = "/usr/local/share/antigravity-ha/telegram-workspace"
      )
    end
  ' "$1"
}

antigravity_ha_stage_telegram_plugin() {
  if [ "$#" -ne 2 ] || [ ! -d "$1" ] || [ ! -d "$2" ] \
    || [ -n "$(find -P "$2" -mindepth 1 -print -quit)" ] \
    || find -P "$1" -type l -print -quit | grep -q .; then
    return 1
  fi

  cp -R --no-preserve=ownership,mode,timestamps "$1/." "$2/"
  telegram_plugin_mcp_temporary=$(mktemp "$2/.mcp-config.XXXXXX")
  if ! antigravity_ha_render_telegram_plugin_mcp \
    "$1/mcp_config.json" > "${telegram_plugin_mcp_temporary}"; then
    rm -f -- "${telegram_plugin_mcp_temporary}"
    return 1
  fi
  chmod 0600 "${telegram_plugin_mcp_temporary}"
  mv -f -- "${telegram_plugin_mcp_temporary}" "$2/mcp_config.json"
  unset telegram_plugin_mcp_temporary
}
