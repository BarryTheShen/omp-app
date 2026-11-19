#!/bin/sh
# The postrm of omp-app-desktop and omp-app-device. A purge also deletes what agent access (#20) kept after its
# removal: the access log, a pending review and the log's rotation settings. Both packages carry agent access; while
# the other one is installed (it took over), these are its own and stay.
set -e
if [ "$1" = purge ]; then
  case "${DPKG_MAINTSCRIPT_PACKAGE:-}" in
    omp-app-desktop) other=omp-app-device ;;
    *) other=omp-app-desktop ;;
  esac
  if [ "$(dpkg-query -W -f='${db:Status-Status}' "$other" 2>/dev/null || true)" != installed ]; then
    rm -rf /var/log/omp-app-device /var/lib/omp-app-device
    rm -f /etc/logrotate.d/omp-app-device
  fi
fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
fi
exit 0
