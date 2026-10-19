#!/usr/bin/env bash
# Smoke test of the packaged desktop app (#1040). It runs the app from the package under a virtual
# X display with a private session bus, and checks what a person would see and what must not be left
# behind. The window opens and the app loads (it connects to its server). Closing the window, SIGTERM,
# and a killed window each end the server and every process the run started. A second launch only
# focuses the window. The error page shows when the web app or the server is missing, and the app
# opens without omp. Screenshots go into a screenshots folder next to the package.
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
export HOME="$work/home" XDG_STATE_HOME="$work/state" PI_CODING_AGENT_DIR="$work/agent" OMP_APP_DATA_DIR="$work/data"
mkdir -p "$HOME" "$work/folder" "$PI_CODING_AGENT_DIR" "$OMP_APP_DATA_DIR"
root="$work/root"
app="$root/usr/bin/omp-app-desktop"
sidecar_bin="$root/usr/bin/omp-app-desktop-server"
state="$work/state/omp-app"
results=()
started=()
LAUNCHED=""

note() {
  results+=("$1")
  echo "$1"
}
finish() {
  # Ends the apps the way a person does (SIGTERM); one still running after 25 s is killed. A server
  # still in the instance record is ended too, but only if its command line names this run's folder.
  local pid leftover
  for pid in "${started[@]}"; do
    if is_alive "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for pid in "${started[@]}"; do
    wait_gone "$pid" 25 || kill -KILL "$pid" 2>/dev/null || true
  done
  leftover=""
  if [[ -f $state/instance.json ]]; then
    leftover=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$state/instance.json" 2>/dev/null || true)
  fi
  if [[ -n $leftover ]] && is_alive "$leftover" && tr '\0' ' ' <"/proc/$leftover/cmdline" 2>/dev/null | grep -qF -- "$work"; then
    note "cleanup: server $leftover was still running; stopping it"
    kill -TERM "$leftover" 2>/dev/null || true
    wait_gone "$leftover" 20 || kill -KILL "$leftover" 2>/dev/null || true
  fi
  rm -rf "$work"
  echo "== summary"
  printf '%s\n' "${results[@]}"
  if [[ ${1:-0} -eq 0 ]]; then echo "smoke test passed"; else echo "smoke test FAILED"; fi
  exit "${1:-0}"
}
fail() {
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
server_info() { # prints "<server pid> <base address>" once the server answers; $1 seconds at most
  local n pid url base
  for n in $(seq 1 $(($1 * 5))); do
    if [[ -f $state/instance.json ]]; then
      read -r pid url < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["pid"], d["url"])' "$state/instance.json" 2>/dev/null) || true
      if [[ -n ${pid:-} && -n ${url:-} ]]; then
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
stop_count() { grep -c ' stop$' "$state/omp-app.log" 2>/dev/null || echo 0; }
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

trap 'note "interrupted"; finish 1' INT TERM
dpkg-deb -x "$deb" "$root" || fail "cannot extract $deb"
[[ -x $app && -x $sidecar_bin ]] || fail "the package has no window or no server binary"

# The window finds omp on the PATH, in the home folders, or in the login shell. CI installs omp before this runs.
command -v omp >/dev/null 2>&1 || fail "T1: omp is not on this computer's PATH; install omp first (the CI workflow does this)"
note "== T1: the window opens, the app loads, and closing the window ends everything"
launch "$app"
app_pid=$LAUNCHED
wid=$(wait_window 120) || fail "T1: no window opened within 120 s"
info=$(server_info 90) || fail "T1: the server never answered its start page"
read -r side _ <<<"$info"
[[ $(readlink "/proc/$app_pid/exe") == "$app" ]] || fail "T1: the window process is not the package's binary"
[[ $(readlink "/proc/$side/exe") == "$sidecar_bin" ]] || fail "T1: the server is not the package's server binary"
cmp -s "$work/index-$side.html" "$root/usr/lib/omp-app-desktop/web/index.html" || fail "T1: the served page is not the package's web app"
wait_log 'connection.open' 60 || fail "T1: the window never connected to its server, so the app did not load"
note "T1 the window opened and the app loaded (it connected to its server)"
sleep 4
shot "$wid" app-window
close_window "$wid" || fail "T1: could not send the close request"
wait_gone "$app_pid" 40 || fail "T1: the app did not exit after its window closed"
wait "$app_pid"
note "T1 the window closed and the app exited (status $?)"
wait_gone "$side" 30 || fail "T1: the server $side is still running"
[[ -z $(group_left "$side") ]] || fail "T1: processes left in the server's group: $(group_left "$side")"
[[ ! -e $state/instance.json ]] || fail "T1: the instance record was left behind"
grep -q ' stop$' "$state/omp-app.log" || fail "T1: the server log has no stop line"
note "T1 the server stopped, logged its stop, and left no process or instance record"

note "== T2: a second launch focuses the window and starts no second server"
launch "$app"
first=$LAUNCHED
wid=$(wait_window 120) || fail "T2: no window for the first launch"
info=$(server_info 90) || fail "T2: the first server never answered"
launch "$app"
second=$LAUNCHED
wait_gone "$second" 30 || fail "T2: the second launch did not exit"
wait "$second"
note "T2 the second launch exited (status $?)"
[[ $(window_ids | wc -l) == 1 ]] || fail "T2: $(window_ids | wc -l) windows after the second launch"
servers=$(sidecars_of_run | wc -l)
[[ $servers == 1 ]] || fail "T2: $servers server processes of this run"
note "T2 one window and one server after the second launch"
is_alive "$first" || fail "T2: the first app stopped"
close_window "$wid"
wait_gone "$first" 40 || fail "T2: the first app did not exit after its window closed"
wait "$first"
wait_gone "$(cut -d' ' -f1 <<<"$info")" 30 || fail "T2: the server is still running"
note "T2 the first app and its server ended when its window closed"

note "== T3: the web app or the server is missing: the error page shows"
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

note "== T4: OMP_BIN names a missing file: the app opens and its server answers with its own omp page"
launch env OMP_BIN=/nonexistent/omp "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T4: no window"
info=$(server_info 90) || fail "T4: the server never answered"
read -r side _ <<<"$info"
sleep 4
shot "$wid" omp-bin-missing-page
close_window "$wid"
wait_gone "$p" 40 || fail "T4: the app did not exit"
wait "$p"
wait_gone "$side" 30 || fail "T4: the server $side is still running"
note "T4 the app opens with a missing OMP_BIN, and the app and its server end when the window closes"

note "== T4b: omp not found (empty home, a session PATH without omp, no login shell): the no-omp page shows and no server starts"
nohome="$work/no-omp-home"
mkdir -p "$nohome" "$work/state-no-omp"
env -i HOME="$nohome" PATH=/usr/bin:/bin SHELL=/bin/false DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" GDK_BACKEND=x11 \
  XDG_STATE_HOME="$work/state-no-omp" PI_CODING_AGENT_DIR="$work/agent-no-omp" OMP_APP_DATA_DIR="$work/data-no-omp" \
  "$app" >"$work/launch-no-omp.log" 2>&1 &
p=$!
started+=("$p")
wid=$(wait_window 120) || fail "T4b: no window"
sleep 3
shot "$wid" not-installed-page
[[ ! -e $work/state-no-omp/omp-app/instance.json ]] || fail "T4b: a server started without omp"
grep -q 'omp was not found' "$work/launch-no-omp.log" || fail "T4b: the window did not report that omp was not found"
close_window "$wid"
wait_gone "$p" 40 || fail "T4b: the app did not exit after its window closed"
wait "$p"
note "T4b omp not found: the no-omp page shows, no server started, and the app exits when its window closes"

note "== T5: SIGTERM ends the window, the server, and the app"
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T5: no window"
info=$(server_info 90) || fail "T5: the server never answered"
read -r side _ <<<"$info"
kill -TERM "$p"
wait_gone "$p" 40 || fail "T5: the app did not exit on SIGTERM"
wait "$p"
wait_gone "$side" 30 || fail "T5: the server $side is still running"
[[ -z $(group_left "$side") ]] || fail "T5: processes left in the server's group: $(group_left "$side")"
note "T5 SIGTERM ended the app, its server, and the server's processes"

note "== T6: the server dies on its own: the window stays and shows the error page"
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

note "== T7: the window is SIGKILLed (3 rounds): the kernel ends the server, and nothing of the run is left"
for round in 1 2 3; do
  stops_before=$(stop_count)
  launch "$app"
  p=$LAUNCHED
  wid=$(wait_window 120) || fail "T7 round $round: no window"
  info=$(server_info 90) || fail "T7 round $round: the server never answered"
  read -r side _ <<<"$info"
  kill -KILL "$p"
  wait_gone "$p" 10 || fail "T7 round $round: the window process did not die"
  wait "$p"
  wait_gone "$side" 30 || fail "T7 round $round: server $side still running after its window was killed"
  [[ $(stop_count) -gt $stops_before ]] || fail "T7 round $round: the server did not log its stop"
  [[ -z $(group_left "$side") ]] || fail "T7 round $round: processes left in the server's group: $(group_left "$side")"
  leftover=$(run_processes | tr '\n' ' ')
  [[ -z $leftover ]] || fail "T7 round $round: processes of this run left: $leftover"
  [[ ! -e $state/instance.json ]] || fail "T7 round $round: the instance record was left behind"
  note "T7 round $round: the server ended by the kernel's death signal, and nothing of the run is left"
done

note "== T8: New chat in the window starts omp for the chat; closing the window leaves no omp (no message is sent, so no model is called)"
launch "$app"
p=$LAUNCHED
wid=$(wait_window 120) || fail "T8: no window"
info=$(server_info 90) || fail "T8: the server never answered"
read -r side _ <<<"$info"
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
wait_gone "$side" 30 || fail "T8: the server $side is still running"
for pid in $(grep -o 'pid=[0-9]*' "$state/omp-app.log" | cut -d= -f2 | sort -u); do
  is_alive "$pid" && fail "T8: process $pid is still running after the window closed"
done
leftover=$(run_processes | tr '\n' ' ')
[[ -z $leftover ]] || fail "T8: processes of this run left: $leftover"
note "T8 no omp and no server of this run is left after the window closed"

finish 0
