#!/usr/bin/env bash
# Unpacks a built package into a temporary folder and checks that the installed command works:
# it prints its version, serves the web app and its scripts, a second launch finds the first, and
# stopping it removes its record. No omp is needed; nothing outside the temporary folder is touched.
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
mkdir -p "$HOME" "$work/folder"

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

kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
[[ ! -e $XDG_STATE_HOME/omp-app/instance.json ]] || { echo "FAIL: the instance record was left behind" >&2; exit 1; }
echo "smoke test passed: omp-app $expected serves its web app and manages its instance record"
