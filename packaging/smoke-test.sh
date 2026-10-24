#!/usr/bin/env bash
# Unpacks a built package into a temporary folder and checks that the installed command works:
# it prints its version, serves the web app and its scripts, a second launch finds the first, it
# writes its debug log (private, without the launch token) and `omp-app logs` and
# `omp-app debug-report` read it, and stopping it removes its record. No omp is needed: a stand-in
# that will not start takes the place of the omp the app pins, so nothing is downloaded. Nothing
# outside the temporary folder is touched.
#
#   packaging/smoke-test.sh dist/release/omp-app_0.1.451_amd64.deb
set -euo pipefail

package=${1:?usage: packaging/smoke-test.sh <package.deb>}
work=$(mktemp -d)
pid=""
cleanup() {
  [[ -n $pid ]] && kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

dpkg-deb -x "$package" "$work/root"
app="$work/root/usr/bin/omp-app"
export HOME="$work/home" XDG_STATE_HOME="$work/state" PI_CODING_AGENT_DIR="$work/agent" OMP_APP_DATA_DIR="$work/data"
mkdir -p "$HOME" "$work/folder" "$work/omp"
pinned=$(grep -o -E '"version": *"[^"]+"' "$(dirname "$0")/../packages/server/src/omp-pin/pin.json" | grep -o -E '[0-9][^"]*')
printf '#!/bin/sh\nexit 1\n' >"$work/omp/omp-$pinned"
chmod +x "$work/omp/omp-$pinned"
export OMP_APP_OMP_DIR="$work/omp"

expected=$(dpkg-deb -f "$package" Version)
[[ $("$app" --version) == "$expected" ]] || { echo "FAIL: --version is not $expected" >&2; exit 1; }

"$app" --no-open --port 0 "$work/folder" >"$work/out.log" 2>&1 &
pid=$!
address=""
for _ in $(seq 1 50); do
  address=$(grep -o -E 'http://127\.0\.0\.1:[0-9]+/#token=[^ ]+' "$work/out.log" | head -1 || true)
  [[ -n $address ]] && break
  sleep 0.2
done
[[ -n $address ]] || { echo "FAIL: no address printed" >&2; cat "$work/out.log" >&2; exit 1; }
base=${address%%/#*}

page=$(curl -sf "$base/")
grep -q 'id="root"' <<<"$page" || { echo "FAIL: the page has no app root" >&2; exit 1; }
script=$(grep -o -E '/assets/[^"]+\.js' <<<"$page" | head -1)
curl -sf -o /dev/null "$base$script" || { echo "FAIL: the app script $script is not served" >&2; exit 1; }

second=$("$app" --no-open)
grep -q 'already running' <<<"$second" || { echo "FAIL: a second launch did not find the first" >&2; echo "$second" >&2; exit 1; }

# The debug log: written from the first moment, private, and never holding the launch token.
logfile="$XDG_STATE_HOME/omp-app/omp-app.log"
for _ in $(seq 1 25); do
  grep -q 'listening port=' "$logfile" 2>/dev/null && break
  sleep 0.2
done
grep -q ' start version=' "$logfile" || { echo "FAIL: the log has no start line" >&2; cat "$logfile" >&2; exit 1; }
grep -q 'listening port=' "$logfile" || { echo "FAIL: the log has no listening line" >&2; cat "$logfile" >&2; exit 1; }
[[ $(stat -c %a "$logfile") == 600 ]] || { echo "FAIL: the log is not private (mode 600)" >&2; exit 1; }
token=${address##*#token=}
[[ -n $token ]] && ! grep -q -F -- "$token" "$logfile" || { echo "FAIL: the launch token is in the log" >&2; exit 1; }
logs=$("$app" logs --lines 5)
grep -q -F "Log file: $logfile" <<<"$logs" || { echo "FAIL: 'omp-app logs' does not name the log file" >&2; echo "$logs" >&2; exit 1; }
(cd "$work/folder" && "$app" debug-report >/dev/null)
report=$(find "$work/folder" -maxdepth 1 -name 'omp-app-debug-*.log' | head -1)
[[ -n $report ]] && grep -q 'omp app debug report' "$report" || { echo "FAIL: 'omp-app debug-report' wrote no report" >&2; exit 1; }
! grep -q -F -- "$token" "$report" || { echo "FAIL: the launch token is in the debug report" >&2; exit 1; }

kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
[[ ! -e $XDG_STATE_HOME/omp-app/instance.json ]] || { echo "FAIL: the instance record was left behind" >&2; exit 1; }
grep -q ' stop$' "$logfile" || { echo "FAIL: the log has no stop line after quitting" >&2; tail -5 "$logfile" >&2; exit 1; }
echo "smoke test passed: omp-app $expected serves its web app, keeps its debug log and manages its instance record"
