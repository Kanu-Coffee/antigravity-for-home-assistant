#!/bin/sh

# shellcheck disable=SC1091
. /usr/local/lib/antigravity-ha/environment.sh

if [ -d /config ]; then
  cd /config || return 1
fi
