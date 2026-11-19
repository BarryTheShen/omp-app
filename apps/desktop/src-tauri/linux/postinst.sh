#!/bin/sh
# omp-app-desktop's postinst. Agent access (#20) is installed idle: nothing is set up here (the Agent access panel's
# setup does it, with an administrator's password). After an upgrade, a guard already set up runs the new program:
# restarting it turns access off, so the person turns it on again with the new one. The person's agent (their own user
# service) is started again too, when it runs: it would otherwise keep the old program until they log in again.
set -e
if [ "$1" = configure ] && [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  systemctl try-restart omp-app-device-guard.service || true
  if [ -r /etc/omp-app-device/guard.json ]; then
    person=$(sed -n 's/^ *"person": *"\([a-z_][a-z0-9_-]*\)",*$/\1/p' /etc/omp-app-device/guard.json | head -n 1)
    if [ -n "$person" ]; then
      systemctl --user -M "$person@" daemon-reload 2>/dev/null || true
      systemctl --user -M "$person@" try-restart omp-app-device.service 2>/dev/null || true
    fi
  fi
fi
exit 0
