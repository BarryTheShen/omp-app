#!/usr/bin/env bash
# Unpacks a built package into a temporary folder and checks that the installed command works:
# it prints its version, serves the web app and its scripts, a second launch finds the first, it
# writes its debug log (private, without the launch token) and `omp-app logs` and
# `omp-app debug-report` read it, `omp-app tui` finds the chat host (and, with no terminal here, stops
# there), stopping it removes its record, a restart keeps its link, and `omp-app new-link` gives the next start a new
# one. The chat host the package
# holds is omp's own command line at the pinned release with the app's chat program in front: it passes omp's own
# smoke test, as a chat (`__omp_app_chat`) it stops at omp's model check, as omp does without a model, and the server
# and `omp-app debug-report` run omp's commands with it. Nothing outside the temporary folder is touched.
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
# The server must find the chat host the package installs beside the command, not one named for tests.
unset OMP_APP_CHAT_HOST_BIN
# The omp release the app pins: the omp package the chat host is built from.
omp_version=$(grep -o -E '"@oh-my-pi/pi-coding-agent": *"[^"]+"' "$(dirname "$0")/../packages/server/package.json" | grep -o -E '[0-9][^"]*')

expected=$(dpkg-deb -f "$package" Version)
[[ $("$app" --version) == "$expected" ]] || { echo "FAIL: --version is not $expected" >&2; exit 1; }

# The user service: installed, starting this package's command, and enabled for every user on install.
unit="$work/root/usr/lib/systemd/user/omp-app.service"
grep -q -x 'ExecStart=/usr/bin/omp-app --no-open %h' "$unit" || { echo "FAIL: the user service does not start /usr/bin/omp-app" >&2; exit 1; }
dpkg-deb -I "$package" postinst | grep -q 'systemctl --global enable omp-app.service' || { echo "FAIL: postinst does not enable the user service" >&2; exit 1; }
dpkg-deb -I "$package" prerm | grep -q 'systemctl --global disable omp-app.service' || { echo "FAIL: prerm does not disable the user service" >&2; exit 1; }

# The chat host every chat runs: omp's own command line, compiled from the pinned package into this one, with the app's
# chat program in front of it (its `__omp_app_chat` command, packages/contracts/src/chat-host/args.ts). It answers omp's
# commands as omp does, and a chat reaches omp's own model check; this run has no model and no key, so it stops there,
# with the sentence the server reads (src/ports/A0/startup-reason.ts).
chat_host="$work/root/usr/lib/omp-app/chat-host"
[[ -x $chat_host ]] || { echo "FAIL: the package has no chat host at /usr/lib/omp-app/chat-host" >&2; exit 1; }
version_line=$("$chat_host" --version 2>&1 | head -n 1)
[[ $version_line == *"$omp_version"* ]] || { echo "FAIL: the chat host is not omp $omp_version: $version_line" >&2; exit 1; }
# omp's own check of a compiled omp (its CI runs it on every binary install): every bundled worker (eval's JavaScript,
# LSP, voice, memory embeddings, the blob broker and the rest) re-enters this program and answers, and the stats
# dashboard's assets are served.
smoke=$(cd "$work/folder" && timeout 180 "$chat_host" --smoke-test 2>&1 | tail -n 5)
grep -q -x 'smoke-test: ok' <<<"$smoke" || { echo "FAIL: the chat host's own smoke test (omp --smoke-test) failed:" >&2; echo "$smoke" >&2; exit 1; }
status=0
(cd "$work/folder" && env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u OPENROUTER_API_KEY \
  timeout 60 "$chat_host" __omp_app_chat </dev/null >"$work/chat-host.out" 2>"$work/chat-host.err") || status=$?
[[ $status == 1 ]] && grep -q -E 'No default model selected|No models available|No model selected' "$work/chat-host.err" || {
  echo "FAIL: the chat host did not start and stop at omp's model check (exit $status)" >&2
  tail -n 5 "$work/chat-host.err" >&2
  exit 1
}

"$app" --no-open --port 0 "$work/folder" >"$work/out.log" 2>&1 &
pid=$!
address=""
# The server answers once it has asked omp for its version, its settings and its commands: allow a busy machine 60 s.
for _ in $(seq 1 300); do
  address=$(grep -o -E 'http://127\.0\.0\.1:[0-9]+/#token=[^ ]+' "$work/out.log" | head -1 || true)
  [[ -n $address ]] && break
  sleep 0.2
done
[[ -n $address ]] || { echo "FAIL: no address printed" >&2; cat "$work/out.log" >&2; exit 1; }
base=${address%%/#*}

# The new UI at the root, from the package: its own page, and its script.
curl -sf "$base/" -o "$work/ui.html" || { echo "FAIL: the root serves no page" >&2; exit 1; }
cmp -s "$work/ui.html" "$work/root/usr/share/omp-app/ui/index.html" || { echo "FAIL: the root is not the package's new UI" >&2; exit 1; }
script=$(grep -o -E '/assets/[^"]+\.js' "$work/ui.html" | head -1)
[[ -n $script ]] || { echo "FAIL: the new UI's page names no script" >&2; exit 1; }
curl -sf -o /dev/null "$base$script" || { echo "FAIL: the new UI's script $script is not served" >&2; exit 1; }

# The old UI under /old/ while it stays: its own page, and its script, named relative to the page.
curl -sf "$base/old/" -o "$work/web.html" || { echo "FAIL: /old/ serves no page" >&2; exit 1; }
cmp -s "$work/web.html" "$work/root/usr/share/omp-app/web/index.html" || { echo "FAIL: /old/ is not the package's old UI" >&2; exit 1; }
script=$(grep -o -E '\./assets/[^"]+\.js' "$work/web.html" | head -1)
[[ -n $script ]] || { echo "FAIL: the old UI's page names no script" >&2; exit 1; }
curl -sf -o /dev/null "$base/old/${script#./}" || { echo "FAIL: the old UI's script $script is not served under /old/" >&2; exit 1; }

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
# The server runs omp's commands with the chat host the package installs: its start line names it, and omp's version
# came from it.
grep -q -F " omp_bin=$chat_host " "$logfile" || { echo "FAIL: the server does not run omp as $chat_host" >&2; grep ' start version=' "$logfile" >&2; exit 1; }
grep -q -F " omp.probe status=ok version=$omp_version " "$logfile" || { echo "FAIL: the server's omp probe did not get omp $omp_version from the chat host" >&2; grep 'omp.probe' "$logfile" >&2; exit 1; }
token=${address##*#token=}
[[ -n $token ]] && ! grep -q -F -- "$token" "$logfile" || { echo "FAIL: the launch token is in the log" >&2; exit 1; }
logs=$("$app" logs --lines 5)
grep -q -F "Log file: $logfile" <<<"$logs" || { echo "FAIL: 'omp-app logs' does not name the log file" >&2; echo "$logs" >&2; exit 1; }
(cd "$work/folder" && "$app" debug-report >/dev/null)
report=$(find "$work/folder" -maxdepth 1 -name 'omp-app-debug-*.log' | head -1)
[[ -n $report ]] && grep -q 'omp app debug report' "$report" || { echo "FAIL: 'omp-app debug-report' wrote no report" >&2; exit 1; }
grep -q -F -x "omp: $omp_version at $chat_host" "$report" || { echo "FAIL: the debug report does not name the chat host's omp $omp_version:" >&2; grep '^omp: ' "$report" >&2; exit 1; }
! grep -q -F -- "$token" "$report" || { echo "FAIL: the launch token is in the debug report" >&2; exit 1; }
# omp in the terminal: `omp-app tui` checks the packaged chat host first, then stops, since this run has no terminal.
tui=$("$app" tui "$work/folder" </dev/null 2>&1) && { echo "FAIL: 'omp-app tui' ran without a terminal" >&2; exit 1; }
grep -q -F 'and this is not one' <<<"$tui" || { echo "FAIL: 'omp-app tui' did not stop for want of a terminal:" >&2; echo "$tui" >&2; exit 1; }

kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
[[ ! -e $XDG_STATE_HOME/omp-app/instance.json ]] || { echo "FAIL: the instance record was left behind" >&2; exit 1; }
grep -q ' stop$' "$logfile" || { echo "FAIL: the log has no stop line after quitting" >&2; tail -5 "$logfile" >&2; exit 1; }

# The link stays the same from one start to the next: its token is kept in a private file beside the instance record.
tokenfile=$XDG_STATE_HOME/omp-app/launch-token
[[ -f $tokenfile && $(stat -c %a "$tokenfile") == 600 ]] || { echo "FAIL: the launch token is not kept in a private file" >&2; exit 1; }
restart() {
  "$app" --no-open --port 0 "$work/folder" >"$work/out.log" 2>&1 &
  pid=$!
  address=""
  for _ in $(seq 1 300); do
    address=$(grep -o -E 'http://127\.0\.0\.1:[0-9]+/#token=[^ ]+' "$work/out.log" | head -1 || true)
    [[ -n $address ]] && break
    sleep 0.2
  done
  [[ -n $address ]] || { echo "FAIL: no address printed after a restart" >&2; cat "$work/out.log" >&2; exit 1; }
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  pid=""
}
restart
[[ ${address##*#token=} == "$token" ]] || { echo "FAIL: a restart changed the link" >&2; exit 1; }
# omp-app new-link: the next start prints a new link.
new_link=$("$app" new-link)
grep -q 'A new link is saved' <<<"$new_link" || { echo "FAIL: 'omp-app new-link' saved no new link:" >&2; echo "$new_link" >&2; exit 1; }
restart
[[ ${address##*#token=} != "$token" ]] || { echo "FAIL: the start after 'omp-app new-link' printed the old link" >&2; exit 1; }
echo "smoke test passed: omp-app $expected serves its web app, keeps its debug log, manages its instance record, keeps its link across restarts until new-link replaces it, and its chat host is omp $omp_version, which answers the server's omp commands"
