#!/bin/sh

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
