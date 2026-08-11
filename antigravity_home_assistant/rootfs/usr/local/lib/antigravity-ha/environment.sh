#!/bin/sh

export HOME=/data/home
export ANTIGRAVITY_HOME=/data/antigravity
export AGY_CLI_DISABLE_AUTO_UPDATE=true
export ANTIGRAVITY_HA_OPTIONS_FILE=/run/antigravity-ha/ha-feedback-options.json
export HA_URL=http://supervisor/core/api
export SUPERVISOR_URL=http://supervisor
export HISTFILE=/data/home/.bash_history
export PATH="/usr/local/bin:${PATH}"
export TMUX_TMPDIR=/data/tmux
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

# Credentials are deliberately not loaded here. This file is sourced by
# interactive shells and Antigravity itself; privileged HA helpers load the
# Supervisor token from a separate AppArmor-protected runtime file.
unset SUPERVISOR_TOKEN
