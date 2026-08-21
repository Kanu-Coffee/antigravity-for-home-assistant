#!/bin/bash -p
set -Eeuo pipefail
umask 077

readonly MODE_FILE=/data/onboarding-tmux-controller-mode
readonly MARKER=/run/antigravity-ha/onboarding-active
readonly TRANSACTION_HELPER=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
if [[ ! -f ${MODE_FILE} || -L ${MODE_FILE} \
  || $(/usr/bin/stat -Lc '%u:%g:%a:%h' "${MODE_FILE}") != 0:0:600:1 ]]; then
  exit 70
fi
if [[ ! -f ${MARKER} || -L ${MARKER} \
  || $(/usr/bin/stat -Lc '%u:%g:%a:%h' "${MARKER}") != 0:0:600:1 ]]; then
  exit 70
fi

if (( $# == 1 )) && [[ $1 == --privacy-finalize ]]; then
  if [[ $(< "${MARKER}") != privacy ]]; then exit 78; fi
  /usr/bin/node "${TRANSACTION_HELPER}" marker clear
  printf '%s\n' finalized > /data/onboarding-tmux-privacy-finalized
  exit 0
fi
if (( $# != 0 )); then exit 64; fi

/usr/bin/node "${TRANSACTION_HELPER}" marker privacy

case "$(< "${MODE_FILE}")" in
  success)
    printf '%s\n' \
      'TARGET-OAUTH-URL-CANARY:synthetic.invalid/success' \
      'TARGET-OAUTH-CODE-CANARY:synthetic-success-code'
    exit 0
    ;;
  forged-mismatch)
    printf '%s\n' \
      'FORGED-OAUTH-URL-CANARY:synthetic.invalid/mismatch' \
      'FORGED-OAUTH-CODE-CANARY:synthetic-mismatch-code'
    exit 0
    ;;
  sigkill)
    printf '%s\n' \
      'SIGKILL-OAUTH-URL-CANARY:synthetic.invalid/sigkill' \
      'SIGKILL-OAUTH-CODE-CANARY:synthetic-sigkill-code'
    printf '%s\n' "${PPID}" > /data/onboarding-tmux-wrapper.pid
    printf '%s\n' "$$" > /data/onboarding-tmux-controller.pid
    while :; do /bin/sleep 1; done
    ;;
  *) exit 64 ;;
esac
