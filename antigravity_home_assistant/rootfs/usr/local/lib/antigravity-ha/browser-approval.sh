#!/usr/bin/env bash

# Antigravity 1.1.13 reads browser tool permissions from settings.json. The
# persistent-file updater owns that translation; startup only needs to reject
# invalid App option values before it invokes the updater.

antigravity_ha_browser_approval_policy_validate() {
  case "${1:-}" in
    safe | never | always) return 0 ;;
    *) return 1 ;;
  esac
}
