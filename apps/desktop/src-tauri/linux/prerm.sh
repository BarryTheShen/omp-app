#!/bin/sh
# The prerm of omp-app-desktop and omp-app-device. Removing the package removes agent access (#20) from this computer
# as the window's "Remove" does: access off, the guard stopped, the omp-agent account and what setup made gone (the
# access log and a pending review stay until purge). An upgrade keeps it set up. Moving to the other package (the
# desktop app's to the server's, or back) is a removal too: apt removes the installed one first, so agent access is set
# up again afterwards.
set -e
if [ "$1" = remove ] && [ -z "${2:-}" ] && [ -x /usr/lib/omp-app-device/omp-app-device ]; then
  # Access off first, whatever remove then manages: the guard's stop ends every session of the account and takes its
  # key and sudo away, and the guard never keeps running from the package's deleted files.
  if [ -d /run/systemd/system ]; then
    systemctl disable --now omp-app-device-guard.service >/dev/null 2>&1 || true
  fi
  if ! env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/lib/omp-app-device/omp-app-device remove; then
    echo "agent access is off, but it was not fully removed from this computer (see above). Reinstall the package and run sudo omp-app-device remove to finish." >&2
  fi
fi
exit 0
