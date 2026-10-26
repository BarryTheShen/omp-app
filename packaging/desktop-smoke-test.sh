#!/usr/bin/env bash
# Smoke test of the packaged desktop app (#1040). It runs the app from the package under a virtual
# X display with a private session bus, and checks what a person would see and what must not be left
# behind. The window opens and the app loads (it connects to its server), and the server finds the omp
# the package holds healthy. The server belongs to the user, not to the window: closing the window, SIGTERM,
# and a killed window each end the app and leave the server running, with its instance record. A launch while
# a server runs attaches to it and starts no second one; a second launch while a window is open only focuses
# the window. The error page shows when the web app or the server is missing (a running server is stopped
# first, or the window would attach to it) and when the server the window started dies. The test stops the
# server itself at the end, with SIGTERM to the pid in instance.json: it ends with its omp processes and
# removes its record. Screenshots go into a screenshots folder next to the package.
# A long turn does not depend on its window either: a message that starts a slow tool is sent in the window (the e2e
# harness's fake model provider answers it), the window is closed while the tool runs, and the turn finishes anyway;
# the reopened window attaches, and the chat's session file holds the message once and the final answer once (#2614).
# A server on another computer (#2649): `--remote <link>` keeps the link in the config folder, readable by this account
# only, and the window opens that server and starts none here; when the computer does not answer, the error page shows.
# A second launch with `--local` or `--remote` moves the open window: back to this computer's running server, or to the
# other computer's address (a listener there sees the window's TLS handshake; it is no https server, so the page does not
# load, and the window shows the error page naming the computer and the reason, #2664).
#
#   xvfb-run -a dbus-run-session -- packaging/desktop-smoke-test.sh dist/desktop/omp-app-desktop_<version>_amd64.deb
#
# The CI workflow runs it that way (.github/workflows/desktop.yml). It refuses to run anywhere a window
# could reach a person's session: WAYLAND_DISPLAY must be unset, and DISPLAY must be a virtual display.
set -uo pipefail

deb=${1:?usage: packaging/desktop-smoke-test.sh <package.deb>}
[[ -f $deb ]] || { echo "no such package: $deb" >&2; exit 2; }
[[ -z ${WAYLAND_DISPLAY:-} ]] || { echo "refusing to run: WAYLAND_DISPLAY is set" >&2; exit 2; }
case ${DISPLAY:-} in
  ""|:0|:0.*) echo "refusing to run: DISPLAY=${DISPLAY:-unset} is not a virtual display (run it through xvfb-run)" >&2; exit 2 ;;
esac
pgrep -af "Xvfb ${DISPLAY}( |\$)" >/dev/null || { echo "refusing to run: no Xvfb serves $DISPLAY" >&2; exit 2; }
export GDK_BACKEND=x11

shots="$(dirname "$deb")/screenshots"
mkdir -p "$shots"
work=$(mktemp -d)
export HOME="$work/home" XDG_STATE_HOME="$work/state" XDG_CONFIG_HOME="$work/config" PI_CODING_AGENT_DIR="$work/agent" OMP_APP_DATA_DIR="$work/data"
mkdir -p "$HOME" "$work/folder" "$PI_CODING_AGENT_DIR" "$OMP_APP_DATA_DIR"
root="$work/root"
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
requests="$work/requests.jsonl"
app="$root/usr/bin/omp-app-desktop"
sidecar_bin="$root/usr/bin/omp-app-desktop-server"
state="$work/state/omp-app"
link_file="$XDG_CONFIG_HOME/omp-app/desktop-server"
results=()
started=()
LAUNCHED=""
provider_pid=""
provider_in=""

note() {
  results+=("$1")
  echo "$1"
}
finish() {
  # Ends the apps the way a person does (SIGTERM); one still running after 25 s is killed. A server belongs to no app,
  # so every server of this run still running (the one in instance.json, and any other) is stopped too: SIGTERM, and
  # KILL after 20 s. The executable is this run's own extracted copy, so other programs' servers never match.
  local pid leftover
  for pid in "${started[@]}"; do
    if is_alive "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for pid in "${started[@]}"; do
    wait_gone "$pid" 25 || kill -KILL "$pid" 2>/dev/null || true
  done
  leftover=$(sidecars_of_run)
  for pid in $leftover; do
    note "cleanup: server $pid was still running; stopping it"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in $leftover; do
    wait_gone "$pid" 20 || kill -KILL "$pid" 2>/dev/null || true
  done
  stop_provider
  rm -rf "$work"
  echo "== summary"
  printf '%s\n' "${results[@]}"
  if [[ ${1:-0} -eq 0 ]]; then echo "smoke test passed"; else echo "smoke test FAILED"; fi
  exit "${1:-0}"
}
fail() {
  if [[ -f ${state:-/nonexistent}/omp-app.log ]]; then
    echo "--- the server's log, last 30 lines"
    tail -n 30 "$state/omp-app.log"
    echo "--- end of the server's log"
  fi
  note "FAIL: $1"
  finish 1
}

proc_state() { ps -o stat= -p "$1" 2>/dev/null | tr -d ' '; }
is_alive() {
  local s
  s=$(proc_state "$1")
  [[ -n $s && ${s:0:1} != Z ]]
}
wait_gone() { # waits up to $2 seconds for pid $1 to end
  local pid=$1 n
  for n in $(seq 1 $(($2 * 5))); do
    is_alive "$pid" || return 0
    sleep 0.2
  done
  return 1
}
window_ids() { xdotool search --onlyvisible --name '^omp app$' 2>/dev/null || true; }
wait_window() { # waits up to $1 seconds for the app's window, and prints its id
  local n id
  for n in $(seq 1 $(($1 * 5))); do
    id=$(window_ids | head -n 1)
    if [[ -n $id ]]; then
      echo "$id"
      return 0
    fi
    sleep 0.2
  done
  return 1
}
wait_log() { # waits up to $2 seconds until the server's log has the text $1
  local n
  for n in $(seq 1 $(($2 * 5))); do
    grep -q -- "$1" "$state/omp-app.log" 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}
count_log() { grep -c -- "$1" "$state/omp-app.log" 2>/dev/null || true; }
wait_log_count() { # waits up to $3 seconds until the server's log has at least $2 lines with the text $1
  local n
  for n in $(seq 1 $(($3 * 5))); do
    [[ $(count_log "$1") -ge $2 ]] && return 0
    sleep 0.2
  done
  return 1
}
server_info() { # prints "<server pid> <base address>" once the server answers; $1 seconds at most
  local n pid url base
  for n in $(seq 1 $(($1 * 5))); do
    if [[ -f $state/instance.json ]]; then
      read -r pid url < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["pid"], d["url"])' "$state/instance.json" 2>/dev/null) || true
      # A killed server leaves its record, and its successor listens on the same port before it records itself: only a
      # record whose process is alive names the server that answers.
      if [[ -n ${pid:-} && -n ${url:-} ]] && is_alive "$pid"; then
        base=${url%%/#*}
        if curl -sf "$base/" -o "$work/index-$pid.html" && grep -q 'id="root"' "$work/index-$pid.html"; then
          echo "$pid $base"
          return 0
        fi
      fi
    fi
    sleep 0.2
  done
  return 1
}
group_left() { ps -eo pid=,pgid=,stat= | awk -v g="$1" '$2 == g && $3 !~ /^Z/ {print}'; }
# This run's servers only: the executable is this run's own extracted copy, so other programs' servers never match.
sidecars_of_run() {
  local p
  for p in /proc/[0-9]*; do
    if [[ $(readlink "$p/exe" 2>/dev/null) == "$sidecar_bin" ]]; then echo "${p#/proc/}"; fi
  done
}
# Every process of this run: its command line names the run's folder, or its working folder is in it.
run_processes() {
  local marker p pid cwd
  marker="[${work:0:1}]${work:1}"
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -qE -- "$marker"; then
      echo "$pid"
      continue
    fi
    cwd=$(readlink "$p/cwd" 2>/dev/null || true)
    if [[ $cwd == "$work"* ]]; then echo "$pid"; fi
  done
}
stop_count() {
  local n
  n=$(grep -c ' stop$' "$state/omp-app.log" 2>/dev/null)
  echo "${n:-0}"
}
# The pid the instance record names; fails when there is no record.
record_pid() {
  [[ -f $state/instance.json ]] || return 1
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$state/instance.json" 2>/dev/null
}
is_run_server() { [[ $(readlink "/proc/$1/exe" 2>/dev/null) == "$sidecar_bin" ]]; }
# Stops the server the instance record names the way a person (or systemd) does: SIGTERM to its pid, then waits
# for it to end. Succeeds when no server of this run runs; fails when it is still running after 30 s or leaves its
# record behind.
stop_server() {
  local pid
  pid=$(record_pid) || return 0
  is_alive "$pid" && is_run_server "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  wait_gone "$pid" 30 || return 1
  [[ ! -e $state/instance.json ]]
}
shot() {
  import -window "$1" "$shots/$2.png" || fail "could not take the screenshot $2"
  note "screenshot screenshots/$2.png"
}
# Starts the given command in the background, in this shell, so that wait works on it.
launch() {
  "$@" >"$work/launch-$RANDOM$RANDOM.log" 2>&1 &
  LAUNCHED=$!
  started+=("$LAUNCHED")
}
# Sends the window the WM_DELETE_WINDOW message, which is what its close button sends.
close_window() {
  python3 - "$1" <<'PY'
import ctypes
import ctypes.util
import sys


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XSendEvent.restype = ctypes.c_int
x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit("no X display")
event = XClientMessageEvent()
event.type = 33  # ClientMessage
event.send_event = 1
event.display = display
event.window = int(sys.argv[1])
event.message_type = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
event.format = 32
event.data[0] = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
event.data[1] = 0  # CurrentTime
# XEvent is a union of 192 bytes; XSendEvent reads all of them, so the buffer must be that size.
buffer = ctypes.create_string_buffer(192)
ctypes.memmove(buffer, ctypes.byref(event), ctypes.sizeof(event))
x11.XSendEvent(display, event.window, 0, 0, ctypes.cast(buffer, ctypes.c_void_p))
x11.XFlush(display)
x11.XCloseDisplay(display)
PY
}
# The fake model provider of the e2e harness (packages/omp-rpc/scripts/fake-openai-server.ts). It answers for the agent
# folder, writes omp's models.yml and config.yml there, logs every request to $requests, and stops when its standard
# input ends, so it gets a pipe that this shell holds open. The harness passes omp `--model fake/fake-model` through
# the server's ompArgs; the packaged server takes no such argument, so the model is omp's default in config.yml.
start_provider() {
  local script="$repo/packages/omp-rpc/scripts/fake-openai-server.ts" n
  command -v bun >/dev/null 2>&1 || return 1
  [[ -f $script ]] || return 1
  coproc PROVIDER { cd "$PI_CODING_AGENT_DIR" && exec bun "$script" "$PI_CODING_AGENT_DIR" >"$work/provider.log" 2>&1; }
  provider_pid=$PROVIDER_PID
  provider_in=${PROVIDER[1]}
  for n in $(seq 1 300); do
    grep -q '^READY ' "$work/provider.log" 2>/dev/null && break
    is_alive "$provider_pid" || return 1
    sleep 0.2
  done
  grep -q '^READY ' "$work/provider.log" 2>/dev/null || return 1
  printf 'modelRoles:\n  default: fake/fake-model\n' >>"$PI_CODING_AGENT_DIR/config.yml"
}
# Ends the provider: closing its input is how the harness asks it to stop; SIGTERM, then SIGKILL, if it stays.
stop_provider() {
  [[ -n $provider_pid ]] || return 0
  if [[ -n $provider_in ]]; then
    exec {provider_in}>&-
    provider_in=""
  fi
  wait_gone "$provider_pid" 10 || kill -TERM "$provider_pid" 2>/dev/null || true
  wait_gone "$provider_pid" 10 || kill -KILL "$provider_pid" 2>/dev/null || true
  provider_pid=""
}
# Waits up to $2 seconds until a request the model provider got has the text $1.
wait_provider_request() {
  local n
  for n in $(seq 1 $(($2 * 5))); do
    grep -q -- "$1" "$requests" 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}
# What omp's session files of this run hold for the message `slow_tool`. omp writes them under
# $PI_CODING_AGENT_DIR/sessions, in one folder per chat folder (its name: sessionBucketName in
# packages/server/src/modules/A1/sessions/paths.ts), so every file below that folder is read. Prints
# "<files with the message> <user messages with it> <tool results of the slow tool> <final answers>".
session_counts() {
  python3 - "$PI_CODING_AGENT_DIR/sessions" <<'PY'
import json
import os
import sys


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


files = users = tool_results = finals = 0
for folder, _, names in os.walk(sys.argv[1]):
    for name in sorted(names):
        if not name.endswith(".jsonl"):
            continue
        has_message = False
        with open(os.path.join(folder, name), encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue  # a line omp is still writing
                message = entry.get("message") if isinstance(entry, dict) else None
                if not isinstance(message, dict):
                    continue
                text = text_of(message.get("content"))
                role = message.get("role")
                if role == "user" and "slow_tool" in text:
                    users += 1
                    has_message = True
                elif role == "toolResult" and "slow-tool-done" in text:
                    tool_results += 1
                elif role == "assistant" and "slow-tool-done" in text:
                    finals += 1
        files += 1 if has_message else 0
print(files, users, tool_results, finals)
PY
}
# Waits up to $1 seconds until the chat's session file has the slow tool's result and the final answer after it.
wait_turn_done() {
  local n c_files c_users c_tools c_finals
  for n in $(seq 1 "$1"); do
    read -r c_files c_users c_tools c_finals < <(session_counts)
    [[ ${c_tools:-0} -ge 1 && ${c_finals:-0} -ge 1 ]] && return 0
    sleep 1
  done
  return 1
}
# Clicks into the window's message box, then types the text $2 and presses Enter. A new chat that is ready centres its
# greeting and message box in the conversation pane (#2087): in the 1200 x 800 window the pane spans x 240 to 1200, and
# the box's text line sits at y 428 (measured on fix-2087's empty-chat capture at 800 px high), so the click goes to
# (720, 428). While the chat still opens, the box is a disabled line at the bottom, which is why the caller waits for
# omp first. Measure it again when the composer's layout changes. There is no window manager under Xvfb, so the window
# gets the keyboard focus from xdotool.
send_in_window() {
  xdotool windowfocus "$1" 2>/dev/null || true
  xdotool mousemove --window "$1" 720 428 click 1 || return 1
  sleep 1
  xdotool key --clearmodifiers ctrl+a || return 1
  xdotool type --delay 60 -- "$2" || return 1
  sleep 1
  xdotool key Return
}
# A port of this computer that nothing listens on now: bound, then let go.
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
# The kept link file's mode, as octal digits; empty when there is no file.
link_mode() { stat -c %a "$link_file" 2>/dev/null; }

trap 'note "interrupted"; finish 1' INT TERM
dpkg-deb -x "$deb" "$root" || fail "cannot extract $deb"
[[ -x $app && -x $sidecar_bin ]] || fail "the package has no window or no server binary"

note "== T1: the window opens, the app loads, and closing the window leaves the server running"
launch "$app"
app_pid=$LAUNCHED
wid=$(wait_window 120) || fail "T1: no window opened within 120 s"
info=$(server_info 90) || fail "T1: the server never answered its start page"
read -r side _ <<<"$info"
[[ $(readlink "/proc/$app_pid/exe") == "$app" ]] || fail "T1: the window process is not the package's binary"
[[ $(readlink "/proc/$side/exe") == "$sidecar_bin" ]] || fail "T1: the server is not the package's server binary"
cmp -s "$work/index-$side.html" "$root/usr/lib/omp-app-desktop/web/index.html" || fail "T1: the served page is not the package's web app"
wait_log 'connection.open' 60 || fail "T1: the window never connected to its server, so the app did not load"
wait_log 'omp\.probe status=ok' 30 || fail "T1: the server's log has no healthy omp probe, so the omp the package holds did not start"
note "T1 the window opened and the app loaded (it connected to its server), and the server's omp probe was healthy"
[[ $(ps -o sid= -p "$side" | tr -d ' ') == "$side" ]] || fail "T1: the server is not in a session of its own"
note "T1 the server runs in a session of its own"
sleep 4
shot "$wid" app-window
close_window "$wid" || fail "T1: could not send the close request"
wait_gone "$app_pid" 40 || fail "T1: the app did not exit after its window closed"
wait "$app_pid"
note "T1 the window closed and the app exited (status $?)"
is_alive "$side" || fail "T1: the server $side ended when the window closed"
[[ $(record_pid) == "$side" ]] || fail "T1: the instance record is gone or names another process"
[[ $(stop_count) == 0 ]] || fail "T1: the server logged a stop when the window closed"
note "T1 the server $side still runs after the window closed: its instance record stays, and it logged no stop"

note "== T2: a launch while a server runs attaches to it and starts no second one; a launch while a window is open only focuses it"
opens_before=$(count_log 'connection.open')
launch "$app"
first=$LAUNCHED
wid=$(wait_window 120) || fail "T2: no window for the launch that attaches"
info=$(server_info 90) || fail "T2: the running server stopped answering"
read -r attached _ <<<"$info"
[[ $attached == "$side" ]] || fail "T2: the window's server is $attached, not the one that was running ($side)"
wait_log_count 'connection.open' $((${opens_before:-0} + 1)) 60 || fail "T2: the window never connected to the running server"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T2: $servers server processes of this run after the window attached"
note "T2 the window attached to the running server $side: it connected, and no second server started"
launch "$app"
second=$LAUNCHED
wait_gone "$second" 30 || fail "T2: the second launch did not exit"
wait "$second"
note "T2 the second launch exited (status $?)"
[[ $(window_ids | wc -l) == 1 ]] || fail "T2: $(window_ids | wc -l) windows after the second launch"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T2: $servers server processes of this run after the second launch"
note "T2 one window and one server after the second launch"
is_alive "$first" || fail "T2: the first app stopped"
close_window "$wid"
wait_gone "$first" 40 || fail "T2: the app did not exit after its window closed"
wait "$first"
is_alive "$side" || fail "T2: the server $side ended when the window closed"
note "T2 the app ended when its window closed, and the server runs on"

note "== T3: the web app or the server is missing: the error page shows (the running server is stopped first, or the window would attach to it)"
stop_server || fail "T3: the server $side did not end on SIGTERM, or left its record"
note "T3 the server was stopped with SIGTERM: it ended and removed its instance record"
for variant in web server; do
  broken="$work/broken-$variant"
  dpkg-deb -x "$deb" "$broken" || fail "T3 $variant: cannot extract the package"
  if [[ $variant == web ]]; then
    rm -f "$broken/usr/lib/omp-app-desktop/web/index.html"
  else
    rm -f "$broken/usr/bin/omp-app-desktop-server"
  fi
  launch "$broken/usr/bin/omp-app-desktop"
  p=$LAUNCHED
  wid=$(wait_window 120) || fail "T3 $variant: no window"
  sleep 4
  shot "$wid" "error-page-$variant-missing"
  close_window "$wid"
  wait_gone "$p" 40 || fail "T3 $variant: the app did not exit after its window closed"
  wait "$p"
  note "T3 $variant missing: the error page shows, and the app exits when its window closes"
done

note "== T5: SIGTERM ends the window and the app, and the server runs on"
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T5: no window"
info=$(server_info 90) || fail "T5: the server never answered"
read -r side _ <<<"$info"
kill -TERM "$p"
wait_gone "$p" 40 || fail "T5: the app did not exit on SIGTERM"
wait "$p"
is_alive "$side" || fail "T5: the server $side ended when the window got SIGTERM"
[[ $(record_pid) == "$side" ]] || fail "T5: the instance record is gone or names another process"
note "T5 SIGTERM ended the app, and its server $side runs on"

note "== T6: the server the window started dies on its own: the window stays and shows the error page"
stop_server || fail "T6: the server $side did not end on SIGTERM, or left its record"
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T6: no window"
info=$(server_info 90) || fail "T6: the server never answered"
read -r side _ <<<"$info"
kill -KILL "$side"
sleep 5
is_alive "$p" || fail "T6: the app quit when its server died"
[[ $(window_ids | wc -l) == 1 ]] || fail "T6: the window is gone"
shot "$wid" error-page-server-died
[[ -z $(group_left "$side") ]] || fail "T6: processes left in the dead server's group: $(group_left "$side")"
close_window "$wid"
wait_gone "$p" 40 || fail "T6: the app did not exit after its window closed"
wait "$p"
note "T6 the window stayed open with the error page, and closing it ended the app"

note "== T7: the window is SIGKILLed (3 rounds): the server runs on, and no second one starts"
kept=""
for round in 1 2 3; do
  opens_before=$(count_log 'connection.open')
  launch "$app"
  p=$LAUNCHED
  wid=$(wait_window 120) || fail "T7 round $round: no window"
  info=$(server_info 90) || fail "T7 round $round: the server never answered"
  read -r side _ <<<"$info"
  [[ -n $kept ]] || kept=$side
  [[ $side == "$kept" ]] || fail "T7 round $round: the window's server is $side, not $kept: a second server started"
  wait_log_count 'connection.open' $((${opens_before:-0} + 1)) 60 || fail "T7 round $round: the window never connected to its server"
  kill -KILL "$p"
  wait_gone "$p" 10 || fail "T7 round $round: the window process did not die"
  wait "$p"
  is_alive "$side" || fail "T7 round $round: server $side ended when its window was killed"
  [[ $(record_pid) == "$side" ]] || fail "T7 round $round: the instance record is gone or names another process"
  servers=$(sidecars_of_run | wc -l)
  [[ $servers == 1 ]] || fail "T7 round $round: $servers server processes of this run"
  note "T7 round $round: the window was killed, and the server $side runs on"
done

note "== T8: New chat in the window starts omp for the chat; closing the window leaves the server running (no message is sent, so no model is called)"
stops_before=$(stop_count)
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T8: no window"
info=$(server_info 90) || fail "T8: the server never answered"
read -r side _ <<<"$info"
[[ $side == "$kept" ]] || fail "T8: the window's server is $side, not $kept: a second server started"
sleep 5
# The sidebar's New chat button: its place is fixed by the window's size (1200 x 800, server.rs) and an empty workspace
# folder. Measured in the app at that size after the UI redesign: the button's box is x 12, y 124, 215 x 32, so its
# centre is (120, 140). Measure it again (a real-omp spec reading getByRole("button", { name: "New chat" })) when the
# sidebar's layout changes.
xdotool mousemove --window "$wid" 120 140 click 1 || fail "T8: could not click New chat"
wait_log 'status=running' 90 || fail "T8: New chat did not start omp (the server logged no running omp)"
omp_pid=$(grep -o 'status=running pid=[0-9]*' "$state/omp-app.log" | tail -n 1 | cut -d= -f3)
[[ -n $omp_pid ]] || fail "T8: New chat did not start omp"
cwd=$(readlink "/proc/$omp_pid/cwd" 2>/dev/null || echo "already ended")
[[ $cwd == "$work/home" || $cwd == "already ended" ]] || fail "T8: omp runs in $cwd, not the workspace folder"
note "T8 New chat started omp (pid $omp_pid), working in the workspace folder: $cwd"
sleep 4
outcome=$(grep 'omp.process' "$state/omp-app.log" | tail -n 1 | grep -o 'status=[a-z]*')
note "T8 omp reported $outcome for the new chat (without a model or key, omp stops; the window says so)"
shot "$wid" new-chat
close_window "$wid"
wait_gone "$p" 40 || fail "T8: the app did not exit after its window closed"
wait "$p"
note "T8 the window closed and the app exited (status $?)"
is_alive "$side" || fail "T8: the server $side ended when the window closed"
[[ $(stop_count) == "$stops_before" ]] || fail "T8: the server logged a stop when the window closed"
note "T8 the server $side runs on after the window closed, and logged no stop"

note "== T9: a long turn outlives its window: slow_tool is sent in the window, the window is closed while the tool runs, the turn finishes, and the reopened window attaches (the model is the e2e harness's fake provider)"
before_server=$side
stops_before=$(stop_count)
start_provider || fail "T9: the fake model provider did not start (it needs bun on the PATH): $(tail -n 3 "$work/provider.log" 2>/dev/null | tr '\n' ' ')"
note "T9 the fake model provider runs for the agent folder, and omp's default model there is fake/fake-model"
running_before=$(count_log 'status=running')
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T9: no window"
info=$(server_info 90) || fail "T9: the server never answered"
read -r side _ <<<"$info"
[[ $side == "$before_server" ]] || fail "T9: the window's server is $side, not $before_server: a second server started"
sleep 5
xdotool mousemove --window "$wid" 120 140 click 1 || fail "T9: could not click New chat"
wait_log_count 'status=running' $((${running_before:-0} + 1)) 90 || fail "T9: New chat did not start omp (the server logged no new running omp)"
sleep 6
# The server's log has no line for a sent prompt, so the provider's request log marks the start of the turn.
sent=""
for attempt in 1 2; do
  send_in_window "$wid" slow_tool || fail "T9: could not type the message into the window"
  if wait_provider_request slow_tool 20; then
    sent=yes
    break
  fi
done
[[ -n $sent ]] || fail "T9: the message never reached the model provider, so omp did not start the turn"
note "T9 slow_tool was typed and sent in the window, and the model provider got the request: the turn runs (its tool takes 7 s)"
close_window "$wid" || fail "T9: could not send the close request"
wait_gone "$p" 40 || fail "T9: the app did not exit after its window closed"
closed_at=$SECONDS
answered=$(grep -c '"role":"tool"' "$requests" 2>/dev/null)
wait "$p"
note "T9 the window closed with the turn running, and the app exited (status $?)"
[[ ${answered:-0} == 0 ]] || fail "T9: the tool had already ended when the window closed, so the turn did not outlive its window"
is_alive "$side" || fail "T9: the server $side ended when the window closed"
[[ $(record_pid) == "$side" ]] || fail "T9: the instance record is gone or names another process"
[[ $(stop_count) == "$stops_before" ]] || fail "T9: the server logged a stop when the window closed"
note "T9 the server $side runs on after the window closed: its record stays, and it logged no stop"
wait_turn_done 60 || fail "T9: 60 s after its window closed, the chat's session file has no tool result and final answer, so the turn did not finish (files, messages, results, answers: $(session_counts))"
note "T9 the turn finished with no window open: the session file has the tool's result and the final answer ($((SECONDS - closed_at)) s after the window closed)"
opens_before=$(count_log 'connection.open')
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T9: no window for the launch that attaches"
info=$(server_info 90) || fail "T9: the running server stopped answering"
read -r attached _ <<<"$info"
[[ $attached == "$side" ]] || fail "T9: the reopened window's server is $attached, not the one that ran the turn ($side)"
wait_log_count 'connection.open' $((${opens_before:-0} + 1)) 60 || fail "T9: the reopened window never connected to the running server"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T9: $servers server processes of this run after the window reopened"
note "T9 the reopened window attached to the running server $side: it connected, and no second server started"
sleep 4
shot "$wid" long-turn-reopened
read -r n_files n_users n_tools n_finals < <(session_counts)
[[ ${n_files:-0} == 1 && ${n_users:-0} == 1 && ${n_tools:-0} == 1 && ${n_finals:-0} == 1 ]] || fail "T9: in the chat's session file slow_tool appears ${n_users:-?} times, the tool's result ${n_tools:-?} times and the final answer ${n_finals:-?} times, in ${n_files:-?} chat file(s); each must be exactly once, in one file"
note "T9 the chat's session file holds the message slow_tool once, the tool's result once, and the final answer once"
close_window "$wid"
wait_gone "$p" 40 || fail "T9: the app did not exit after its window closed"
wait "$p"
is_alive "$side" || fail "T9: the server $side ended when the reopened window closed"
stop_provider
note "T9 the reopened window closed, the server $side runs on, and the fake model provider is stopped"

note "== T10: a server on another computer (#2649): --remote keeps its link privately and opens that server, starting none here; a computer that does not answer gets the error page; a second launch with --local or --remote moves the open window"
unreachable="https://127.0.0.1:$(free_port)/#token=smoke-remote"
opens_before=$(count_log 'connection.open')
launch "$app" --remote "$unreachable"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T10: no window for the launch with --remote"
[[ $(cat "$link_file" 2>/dev/null) == "$unreachable" ]] || fail "T10: the link file holds '$(cat "$link_file" 2>/dev/null)', not the link given to --remote"
[[ $(link_mode) == 600 ]] || fail "T10: the link file's mode is '$(link_mode)', not 600"
note "T10 --remote kept the link in the config folder, readable by this account only"
sleep 8
is_alive "$p" || fail "T10: the app quit when the other computer did not answer"
[[ $(window_ids | wc -l) == 1 ]] || fail "T10: $(window_ids | wc -l) windows while the other computer did not answer"
[[ $(count_log 'connection.open') == "${opens_before:-0}" ]] || fail "T10: the window connected to this computer's server instead of the other computer"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T10: $servers server processes of this run: the launch with --remote started one here"
shot "$wid" remote-unreachable
note "T10 the other computer did not answer: the window stayed open on the error page, and it neither used nor started a server here"
launch "$app" --local
second=$LAUNCHED
wait_gone "$second" 30 || fail "T10: the second launch with --local did not exit"
wait "$second"
[[ ! -e $link_file ]] || fail "T10: the second launch with --local left the link file"
wait_log_count 'connection.open' $((${opens_before:-0} + 1)) 60 || fail "T10: after a second launch with --local the window never connected to this computer's server"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 && $(window_ids | wc -l) == 1 ]] || fail "T10: $servers server processes and $(window_ids | wc -l) windows after --local"
note "T10 a second launch with --local forgot the link and moved the open window to this computer's running server"
# A computer that answers: something listens on the link's port. It is no https server, so no page loads, but the
# first byte the window sends there (22, a TLS handshake) shows that the window went to that address.
open_port=$(free_port)
python3 - "$open_port" "$work/listener.log" <<'PY' &
import socket
import sys

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(sys.argv[1])))
server.listen(16)
with open(sys.argv[2], "a", buffering=1) as log:
    log.write("listening\n")
    while True:
        connection, _ = server.accept()
        connection.settimeout(10)
        try:
            first = connection.recv(1)
        except OSError:
            first = b""
        log.write(f"connection first={first[0] if first else 'none'}\n")
        connection.close()
PY
listener=$!
started+=("$listener")
for n in $(seq 1 50); do
  grep -q listening "$work/listener.log" 2>/dev/null && break
  sleep 0.2
done
answering="https://127.0.0.1:$open_port/#token=smoke-remote"
launch "$app" --remote "$answering"
second=$LAUNCHED
wait_gone "$second" 30 || fail "T10: the second launch with --remote did not exit"
wait "$second"
[[ $(cat "$link_file" 2>/dev/null) == "$answering" && $(link_mode) == 600 ]] || fail "T10: the second launch with --remote did not keep its link privately"
went=""
for n in $(seq 1 60); do
  grep -q 'first=22' "$work/listener.log" 2>/dev/null && { went=yes; break; }
  sleep 0.5
done
[[ -n $went ]] || fail "T10: the window never went to the other computer's address (the listener got: $(tr '\n' ' ' <"$work/listener.log" 2>/dev/null))"
# The page did not load there: the window says so in its log and shows the error page with the reason (#2664).
shown=""
for n in $(seq 1 40); do
  grep -q 'the app on 127.0.0.1 did not open' "$work"/launch-*.log 2>/dev/null && { shown=yes; break; }
  sleep 0.5
done
[[ -n $shown ]] || fail "T10: the page at the other computer's address did not load, and the window did not show the error page"
sleep 3
is_alive "$p" || fail "T10: the app quit after the window went to the other computer"
[[ $(window_ids | wc -l) == 1 ]] || fail "T10: $(window_ids | wc -l) windows after the window went to the other computer"
shot "$wid" remote-page-failed
note "T10 a second launch with --remote moved the open window to the other computer: the window began a TLS handshake there, the page did not load, and the window showed the error page ($(grep -h -o 'the app on 127.0.0.1 did not open: .*' "$work"/launch-*.log | head -n 1))"
launch "$app" --local
second=$LAUNCHED
wait_gone "$second" 30 || fail "T10: the last launch with --local did not exit"
wait "$second"
[[ ! -e $link_file ]] || fail "T10: the last launch with --local left the link file"
wait_log_count 'connection.open' $((${opens_before:-0} + 2)) 60 || fail "T10: after the last --local the window never connected to this computer's server again"
note "T10 --local again: the link is forgotten, and the window is back on this computer's server"
kill -TERM "$listener" 2>/dev/null || true
wait "$listener" 2>/dev/null || true
close_window "$wid"
wait_gone "$p" 40 || fail "T10: the app did not exit after its window closed"
wait "$p"
is_alive "$side" || fail "T10: the server $side ended"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T10: $servers server processes of this run at the end of T10"
note "T10 the window closed, and this computer's server $side runs on, the only one"

note "== end: the test stops the server itself: SIGTERM to the pid in instance.json ends it, its omp processes, and its record"
server=$(record_pid) || fail "end: there is no instance record while the server should run"
[[ $server == "$side" ]] || fail "end: the instance record names $server, not the server $side"
is_alive "$server" || fail "end: the server $server is not running"
stop_server || fail "end: the server $server did not end on SIGTERM, or left its instance record"
grep -q ' stop$' "$state/omp-app.log" || fail "end: the server log has no stop line"
for pid in $(grep -o 'pid=[0-9]*' "$state/omp-app.log" | cut -d= -f2 | sort -u); do
  is_alive "$pid" && fail "end: process $pid is still running after the server was stopped"
done
leftover=$(run_processes | tr '\n' ' ')
[[ -z $leftover ]] || fail "end: processes of this run left: $leftover"
note "end SIGTERM ended the server $server and its omp processes, and it removed its instance record; nothing of the run is left"

finish 0
