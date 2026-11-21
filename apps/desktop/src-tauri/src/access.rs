//! Agent access on this computer (#20), as the desktop app shows it: the commands behind the side bar's Agent access
//! panel, the red tray icon while access is on, a notification that stays while an agent session runs, and one that
//! stays for each agent's request until it is answered (a click opens the panel).
//!
//! The app talks to this computer's agent (`omp-app-device run`, a user service) over its control socket,
//! `$XDG_RUNTIME_DIR/omp-app-device/agent.sock`. The panel controls this computer's agent access from a window on any
//! server, its page loaded from the server that window shows (`refused_for`); turning access on, extending it, sudo and
//! acknowledging a review ask the person's password with the system's own dialog, whose words the agent's guard writes
//! from what it grants (and which name the server whose agents get in). Lengths are capped here and by the guard.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::commands;

const TRAY: &str = "agent-access";
/// The most events kept for the panel (each session's output comes as events), and the most of their output.
const EVENTS_KEPT: usize = 4_000;
const OUTPUT_KEPT: usize = 16 * 1024 * 1024;

/// What the agent told, numbered, for the panel to read on from where it left off; with each, the size of its output.
/// `server` is the server they were read for: another server's page never reads them (`access_events`).
struct Events {
    next: u64,
    kept: VecDeque<(u64, Value, usize)>,
    output: usize,
    server: Option<String>,
}

fn events() -> &'static Mutex<Events> {
    static EVENTS: OnceLock<Mutex<Events>> = OnceLock::new();
    EVENTS.get_or_init(|| {
        Mutex::new(Events {
            next: 1,
            kept: VecDeque::new(),
            output: 0,
            server: None,
        })
    })
}

/// Forgets the events kept so far: the sessions of a link that changed are not the next server's to read.
fn forget_events() {
    let mut kept = events().lock().expect("the events lock");
    kept.kept.clear();
    kept.output = 0;
    kept.server = None;
}

/// When access turns off by itself, as the agent last said, measured on this app's clock.
fn deadline() -> &'static Mutex<Option<Instant>> {
    static DEADLINE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    DEADLINE.get_or_init(|| Mutex::new(None))
}

fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("omp-app-device").join("agent.sock")
}

/// One request to the agent and its one-line answer: `ok <json>` or `error <reason>`.
fn ask(request: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket_path()).map_err(|_| {
        "Agent access is not set up on this computer (its agent is not running).".to_owned()
    })?;
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|error| error.to_string())?;
    // The agent answers within its own limits (5 minutes while a password is asked); never wait past them.
    stream
        .set_read_timeout(Some(Duration::from_secs(330)))
        .map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let line = line.trim_end();
    if let Some(body) = line.strip_prefix("ok ") {
        return serde_json::from_str(body).map_err(|error| error.to_string());
    }
    if line == "ok" {
        return Ok(Value::Null);
    }
    Err(line
        .strip_prefix("error ")
        .unwrap_or("The agent did not answer.")
        .to_owned())
}

/// Why a page may not act on this computer's agent access, or None when it may. A page of any server a window shows
/// may, as long as the window's own record of its server (never the page's word) and the address the page was loaded
/// from (`shown`) agree, so a page that is not the window's server's own is refused. `linked` is the agent's record of
/// the link, None when the agent did not answer (never taken as linked to nothing). `allow_unlinked` lets a computer
/// whose agent says it is linked to no server be acted on (Remove only).
fn refused_for(
    origin: Option<&str>,
    shown: Option<&str>,
    linked: Option<&Value>,
    allow_unlinked: bool,
) -> Option<String> {
    let Some(origin) = origin else {
        return Some("This window shows no server.".to_owned());
    };
    if shown != Some(origin) {
        return Some("This page is not from the server this window shows.".to_owned());
    }
    let Some(linked) = linked else {
        return Some(
            "This computer's agent does not answer (omp-app-device.service). To remove agent access without it, run sudo omp-app-device remove."
                .to_owned(),
        );
    };
    match linked["server"].as_str() {
        Some(_) => None,
        None if allow_unlinked => None,
        None => Some("This computer is not linked to any server.".to_owned()),
    }
}

/// Runs `request` off the main thread, with the agent's record of the link, once the asking window passes
/// `refused_for`.
async fn for_linked_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    allow_unlinked: bool,
    request: impl FnOnce(&Value) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    let origin = crate::server::window_origin(app, window.label());
    let shown = window
        .url()
        .ok()
        .map(|url| url.origin().ascii_serialization());
    tauri::async_runtime::spawn_blocking(move || {
        let linked = linked().ok();
        if let Some(why) = refused_for(
            origin.as_deref(),
            shown.as_deref(),
            linked.as_ref(),
            allow_unlinked,
        ) {
            return Err(why);
        }
        request(linked.as_ref().unwrap_or(&Value::Null))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One password dialog at a time: a page asking again while one is open is refused, so dialogs never stack.
fn one_dialog(request: Value) -> Result<Value, String> {
    static OPEN: AtomicBool = AtomicBool::new(false);
    if OPEN.swap(true, Ordering::SeqCst) {
        return Err("A password dialog is already open.".to_owned());
    }
    let answer = ask(request);
    OPEN.store(false, Ordering::SeqCst);
    answer
}

/// The longest access at once, in minutes (the guard caps it too, and says the capped length in its password dialog).
const LONGEST_ON: u32 = 480;
/// The longest sudo grant, in minutes.
const LONGEST_SUDO: u32 = 30;

#[tauri::command]
pub async fn access_status(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    for_linked_window(&app, &window, false, |_| ask(json!({ "op": "status" }))).await
}

/// Turns access on for `minutes` (1 to 480): the system asks the person's password for this app's process first, in a
/// dialog whose words the guard writes from the length it grants.
#[tauri::command]
pub async fn access_on(
    app: AppHandle,
    window: tauri::WebviewWindow,
    minutes: u32,
) -> Result<Value, String> {
    let pid = std::process::id();
    let minutes = minutes.clamp(1, LONGEST_ON);
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "on", "pid": pid, "minutes": minutes }))
    })
    .await
}

#[tauri::command]
pub async fn access_off(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    for_linked_window(&app, &window, false, |_| ask(json!({ "op": "off" }))).await
}

/// The person looked at what changed during the last access (the system asks their password).
#[tauri::command]
pub async fn access_acknowledge(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    let pid = std::process::id();
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "acknowledge", "pid": pid }))
    })
    .await
}

/// `minutes` (1 to 480) more while on, never past eight hours from now (the system asks the person's password again).
#[tauri::command]
pub async fn access_extend(
    app: AppHandle,
    window: tauri::WebviewWindow,
    minutes: u32,
) -> Result<Value, String> {
    let pid = std::process::id();
    let minutes = minutes.clamp(1, LONGEST_ON);
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "extend", "pid": pid, "minutes": minutes }))
    })
    .await
}

/// Sudo for the agent account for `minutes` (1 to 30) while access is on (the system asks the person's password again).
#[tauri::command]
pub async fn access_sudo(
    app: AppHandle,
    window: tauri::WebviewWindow,
    minutes: u32,
) -> Result<Value, String> {
    let pid = std::process::id();
    let minutes = minutes.clamp(1, LONGEST_SUDO);
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "sudo", "pid": pid, "minutes": minutes }))
    })
    .await
}

/// Allows an agent's request for one of the person's folders (#20, PLAN §7d): the system asks the person's password, in
/// a dialog whose words the guard writes from the folder and whether its files may be changed (`write`, only when the
/// agent asked for that).
#[tauri::command]
pub async fn access_allow_folder(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    write: bool,
) -> Result<Value, String> {
    let pid = std::process::id();
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "allow-folder", "pid": pid, "id": id, "write": write }))
    })
    .await
}

/// Turns an agent's folder request down (no password: it grants nothing).
#[tauri::command]
pub async fn access_deny_folder(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Value, String> {
    for_linked_window(&app, &window, false, move |_| {
        ask(json!({ "op": "deny-folder", "id": id }))
    })
    .await
}

/// Stops sharing a folder; the guard unmounts it at once (no password: it only takes away).
#[tauri::command]
pub async fn access_remove_folder(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Value, String> {
    for_linked_window(&app, &window, false, move |_| {
        ask(json!({ "op": "remove-folder", "path": path }))
    })
    .await
}

/// Allows a chat that asked to reach this computer (PLAN §7f): the system asks the person's password, in a dialog whose
/// words the guard writes from the chat's name and the server.
#[tauri::command]
pub async fn access_allow_chat(
    app: AppHandle,
    window: tauri::WebviewWindow,
    thread_id: String,
) -> Result<Value, String> {
    let pid = std::process::id();
    for_linked_window(&app, &window, false, move |_| {
        one_dialog(json!({ "op": "allow-chat", "pid": pid, "threadId": thread_id }))
    })
    .await
}

/// Turns a chat's request down (no password: it grants nothing).
#[tauri::command]
pub async fn access_deny_chat(
    app: AppHandle,
    window: tauri::WebviewWindow,
    thread_id: String,
) -> Result<Value, String> {
    for_linked_window(&app, &window, false, move |_| {
        ask(json!({ "op": "deny-chat", "threadId": thread_id }))
    })
    .await
}

/// Takes a chat's access away; its sessions end (no password: it only takes away).
#[tauri::command]
pub async fn access_remove_chat(
    app: AppHandle,
    window: tauri::WebviewWindow,
    thread_id: String,
) -> Result<Value, String> {
    for_linked_window(&app, &window, false, move |_| {
        ask(json!({ "op": "remove-chat", "threadId": thread_id }))
    })
    .await
}

/// The program the app installs for agent access (idle until set up).
const PROGRAM: &str = "/usr/lib/omp-app-device/omp-app-device";

/// Whether `omp-app-device setup` ran here: its guard is enabled.
fn is_set_up() -> bool {
    Command::new("systemctl")
        .args(["is-enabled", "--quiet", "omp-app-device-guard.service"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The name agents reach this computer by: its host name in the letters, digits and dashes a name may hold.
fn computer_name() -> String {
    let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
    let name: String = host
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let name = name.trim_matches('-');
    let name: String = name.chars().take(31).collect();
    if name.is_empty() {
        "computer".to_owned()
    } else {
        name
    }
}

/// The server this computer is linked to, from its agent: `{ server, alias }`, or null while not linked; an error while
/// the agent does not answer.
fn linked() -> Result<Value, String> {
    ask(json!({ "op": "status" })).map(|status| status["enrolled"].clone())
}

/// What the app's Agent access panel shows for this computer: whether the parts are installed, set up, which server it
/// is linked to, and whether that is the server of the window asking (`here`).
#[tauri::command]
pub async fn access_here(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    let origin = crate::server::window_origin(&app, window.label());
    tauri::async_runtime::spawn_blocking(move || {
        let set_up = is_set_up();
        let linked = if set_up {
            linked().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let here = origin.is_some() && linked["server"].as_str() == origin.as_deref();
        Ok(json!({
            "installed": Path::new(PROGRAM).exists(),
            "setUp": set_up,
            "linked": linked,
            "here": here,
            "name": computer_name(),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One click in the app's Agent access panel: sets agent access up on this computer (an administrator's password,
/// asked by the system), starts the person's agent, and links the computer to the server the asking window shows, with
/// a one-time code that page asked its server for. The address is the window's own record, never the page's; the code
/// only proves the link to that server. Access stays off: turning it on is the panel's, with the password each time.
/// A computer linked to another server moves here only when the panel asks to (`moving`), after an administrator's
/// password: the server it was linked to forgets it (`leave`), then it links here. One set up but linked to no server
/// is linked only after an administrator's password again; one linked to this server is linked again without (its
/// server forgot it). So no page links this computer to its server without a password.
/// Answers `{ ok, problems, changes, linked }`.
#[tauri::command]
pub async fn access_set_up_here(
    app: AppHandle,
    window: tauri::WebviewWindow,
    code: String,
    moving: Option<bool>,
) -> Result<Value, String> {
    let moving = moving == Some(true);
    let origin = crate::server::window_origin(&app, window.label())
        .ok_or_else(|| "This window shows no server yet.".to_owned())?;
    let shown = window
        .url()
        .ok()
        .map(|url| url.origin().ascii_serialization());
    if shown.as_deref() != Some(origin.as_str()) {
        return Err("This page is not from the server this window shows.".to_owned());
    }
    let host = tauri::Url::parse(&origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    if host == "127.0.0.1" || host == "localhost" || host == "[::1]" {
        return Err(
            "This window shows the app's server on this computer; agent access lets agents of a server on another computer in here."
                .to_owned(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut answer = json!({ "ok": true, "problems": [], "changes": [] });
        let fresh = !is_set_up();
        if fresh {
            answer = as_administrator("setup")?;
            if answer["ok"] != json!(true) {
                return Ok(answer);
            }
        }
        if !agent_service(true) {
            answer["ok"] = json!(false);
            push(
                &mut answer,
                "problems",
                "Your agent did not start (omp-app-device.service).",
            );
            return Ok(answer);
        }
        // The agent just started: its control socket comes up within moments.
        let started = Instant::now();
        while UnixStream::connect(socket_path()).is_err()
            && started.elapsed() < Duration::from_secs(10)
        {
            thread::sleep(Duration::from_millis(200));
        }
        let was = linked().map_err(|reason| format!("Your agent did not answer: {reason}"))?;
        match was["server"].as_str() {
            Some(server) if server != origin => {
                if !moving {
                    return Err(format!(
                        "This computer is linked to {server}. Move agent access to this server to link it here instead."
                    ));
                }
                // Moving: an administrator's password first, then the server it was linked to forgets it.
                if !fresh {
                    answer = as_administrator("setup")?;
                    if answer["ok"] != json!(true) {
                        return Ok(answer);
                    }
                }
                let _ = ask(json!({ "op": "off" }));
                match ask(json!({ "op": "leave" })) {
                    Ok(_) => push(&mut answer, "changes", &format!("unlinked this computer from {server}")),
                    Err(reason) => push(
                        &mut answer,
                        "changes",
                        &format!(
                            "unlinked this computer from {server}, which could not be told ({reason}): it may still list this computer"
                        ),
                    ),
                }
                forget_events();
            }
            // Linked to this server, which forgot it: linked again, no password.
            Some(_) => {}
            None if fresh => {}
            // Set up earlier and linked to no server: an administrator's password before any server gets it.
            None => {
                answer = as_administrator("setup")?;
                if answer["ok"] != json!(true) {
                    return Ok(answer);
                }
            }
        }
        // Linked again even when this computer's record already names this server: the page asks only when that server
        // does not list it (it was removed there), and the record alone cannot tell.
        {
            let name = computer_name();
            // A setup just now restarted the guard: until it answers, the agent says so before it asks the server
            // anything (the code is not spent), so the link is tried again for a while.
            let enroll = || {
                ask(json!({ "op": "enroll", "server": origin, "code": code.trim(), "alias": name }))
            };
            let started = Instant::now();
            let mut linked_now = enroll();
            while matches!(&linked_now, Err(reason) if reason.contains("the guard is not running"))
                && started.elapsed() < Duration::from_secs(20)
            {
                thread::sleep(Duration::from_millis(500));
                linked_now = enroll();
            }
            match linked_now {
                Ok(_) => push(
                    &mut answer,
                    "changes",
                    &format!("linked this computer to {origin} as {name}"),
                ),
                Err(reason) => {
                    answer["ok"] = json!(false);
                    push(
                        &mut answer,
                        "problems",
                        &format!("This computer could not be linked: {reason}"),
                    );
                }
            }
        }
        forget_events();
        answer["linked"] = linked().unwrap_or(Value::Null);
        Ok(answer)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn push(answer: &mut Value, list: &str, line: &str) {
    if !answer[list].is_array() {
        answer[list] = json!([]);
    }
    if let Some(items) = answer[list].as_array_mut() {
        items.push(json!(line));
    }
}

/// `omp-app-device setup` or `remove` as root, through pkexec: the system asks an administrator's password (the polkit
/// actions `dev.ompapp.device.setup` and `.remove`). The program names the person from pkexec itself, never from here.
fn as_administrator(action: &str) -> Result<Value, String> {
    // One at a time: a second click while the password dialog is open does nothing.
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("Agent access is already being set up or removed.".to_owned());
    }
    // pkexec from its own path, never one found on the person's PATH.
    let done = Command::new("/usr/bin/pkexec")
        .args([PROGRAM, action, "--json"])
        .output();
    RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    let done = done.map_err(|_| "pkexec is not installed: sudo apt install pkexec".to_owned())?;
    match done.status.code() {
        Some(126) => return Err("The password was not given.".to_owned()),
        // pkexec's 127: not authorized, or no password dialog could be shown (no polkit agent); its words say which.
        Some(127) => {
            let why = String::from_utf8_lossy(&done.stderr).trim().to_owned();
            return Err(if why.is_empty() {
                "The administrator's password could not be asked for, or was refused.".to_owned()
            } else {
                format!(
                    "The administrator's password could not be asked for, or was refused: {why}"
                )
            });
        }
        _ => {}
    }
    let out = String::from_utf8_lossy(&done.stdout);
    let answer = out
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .ok_or_else(|| format!("omp-app-device {action} did not answer."))?;
    serde_json::from_str(answer).map_err(|error| error.to_string())
}

/// The person's agent (a user service of theirs: no administrator needed), on or off.
fn agent_service(on: bool) -> bool {
    let args: &[&str] = if on {
        &["--user", "enable", "--now", "omp-app-device.service"]
    } else {
        &["--user", "disable", "--now", "omp-app-device.service"]
    };
    Command::new("systemctl")
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Removes agent access from this computer: access off, then everything setup made (the remove asks the agent to tell
/// its server to forget this computer first). From a window on any server, as is the rest of the panel; an
/// administrator's password is asked.
#[tauri::command]
pub async fn access_remove(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    for_linked_window(&app, &window, true, |_| {
        let _ = ask(json!({ "op": "off" }));
        let answer = as_administrator("remove")?;
        agent_service(false);
        forget_events();
        Ok(answer)
    })
    .await
}

/// The agent's events after number `after`, oldest first, with their numbers: each session's commands and what it
/// shows, for the panel's live view, in a window on any server.
#[tauri::command]
pub async fn access_events(
    app: AppHandle,
    window: tauri::WebviewWindow,
    after: u64,
) -> Result<Value, String> {
    for_linked_window(&app, &window, false, move |linked| {
        let server = linked["server"].as_str().map(str::to_owned);
        let mut kept = events().lock().expect("the events lock");
        // Kept for one server's page: when the link has moved since, what was kept is not this server's to read.
        if kept.server.is_some() && kept.server != server {
            kept.kept.clear();
            kept.output = 0;
        }
        kept.server = server;
        Ok(Value::Array(
            kept.kept
                .iter()
                .filter(|(number, _, _)| *number > after)
                .map(|(number, event, _)| json!({ "n": number, "event": event }))
                .collect(),
        ))
    })
    .await
}

/// Brings the app's window forward (the tray's "Show the app"): agent access lives in its side bar's panel.
fn show_app(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Follows the agent: keeps its events for the panel, shows the tray while access is on, when a session starts says so
/// in a notification that stays, and keeps one notification for each request waiting for the person (a click opens the
/// Agent access panel). Waits for an agent that is not running yet.
pub fn watch(app: AppHandle) {
    let _ = started().set(Instant::now());
    let clicks = app.clone();
    let _ = app.run_on_main_thread(move || {
        commands::on_notification_click(move |id| {
            let ours = requests().lock().expect("the requests lock").values().any(|each| *each == id);
            if ours {
                open_access_panel(&clicks);
            }
        });
    });
    let ticker = app.clone();
    thread::spawn(move || loop {
        if let Ok(stream) = UnixStream::connect(socket_path()) {
            let writer = stream.try_clone();
            if let Ok(mut writer) = writer {
                if writer.write_all(b"{\"op\":\"watch\"}\n").is_ok() {
                    for line in BufReader::new(stream).lines() {
                        let Ok(line) = line else { break };
                        let Ok(event) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        take(&app, event);
                    }
                }
            }
            // The agent stopped: access is off with it, and its requests are gone.
            take(
                &app,
                json!({ "type": "state", "state": { "on": false }, "linked": false }),
            );
            keep_request_notifications("", Vec::new());
        }
        thread::sleep(Duration::from_secs(3));
    });
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(30));
        refresh_tray(&ticker);
    });
}

fn take(app: &AppHandle, event: Value) {
    {
        let mut kept = events().lock().expect("the events lock");
        let number = kept.next;
        kept.next += 1;
        let size = event["event"]["bytes"].as_str().map_or(0, str::len);
        kept.kept.push_back((number, event.clone(), size));
        kept.output += size;
        while kept.kept.len() > EVENTS_KEPT || kept.output > OUTPUT_KEPT {
            match kept.kept.pop_front() {
                Some((_, _, gone)) => kept.output -= gone,
                None => break,
            }
        }
    }
    match event["type"].as_str() {
        Some("state") => {
            let on = event["state"]["on"].as_bool().unwrap_or(false);
            let left = event["leftSeconds"].as_u64();
            *deadline().lock().expect("the deadline lock") = left
                .filter(|_| on)
                .map(|left| Instant::now() + Duration::from_secs(left));
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                if on {
                    show_tray(&app);
                } else {
                    let _ = app.remove_tray_by_id(TRAY);
                    *left_item().lock().expect("the tray line lock") = None;
                }
            });
        }
        Some("wrapper") if event["event"]["type"].as_str() == Some("start") => {
            // A lasting notification and the red tray icon say an agent is at work; what it runs shows in the panel.
            let command = notification_text(event["event"]["command"].as_str().unwrap_or(""), 200);
            commands::notify_lasting("omp agent is controlling this computer", &command);
        }
        // A request's own notification comes from the `chats` and `folders` events below, so its notice is not shown.
        Some("notice") if event["kind"].as_str() == Some("request") => {}
        // Sudo allowed, and the summary when access turns off.
        Some("notice") => {
            let text = notification_text(event["text"].as_str().unwrap_or(""), 600);
            commands::notify(app.clone(), "Agent access".to_string(), text);
        }
        Some("chats") => {
            let waiting = chat_requests(&event["chats"]);
            open_if_just_started(app, !waiting.is_empty());
            keep_request_notifications("chat:", waiting);
        }
        Some("folders") => {
            let waiting = folder_requests(&event["folders"]);
            open_if_just_started(app, !waiting.is_empty());
            keep_request_notifications("folder:", waiting);
        }
        _ => {}
    }
}

/// The notifications shown for requests that wait for the person, by request (`chat:<thread>`, `folder:<id>`).
fn requests() -> &'static Mutex<HashMap<String, u32>> {
    static REQUESTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One request as its notification says it: its key, the summary and the body.
type RequestNotice = (String, String, String);

/// The chats asking to reach this computer, as the agent's `chats` event lists them.
fn chat_requests(chats: &Value) -> Vec<RequestNotice> {
    let empty = Vec::new();
    chats["requests"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|request| {
            let thread = request["threadId"].as_str()?;
            let chat = notification_text(request["chat"].as_str().unwrap_or("A chat"), 120);
            let server = request["server"].as_str().unwrap_or("");
            let host = notification_text(server.split("://").nth(1).unwrap_or(server).trim_end_matches('/'), 80);
            Some((
                format!("chat:{thread}"),
                "A chat asks to reach this computer".to_owned(),
                format!("\u{201c}{chat}\u{201d} on {host}. Click to open Agent access, where Allow asks your password."),
            ))
        })
        .collect()
}

/// The agents' folder requests, as the agent's `folders` event lists them.
fn folder_requests(folders: &Value) -> Vec<RequestNotice> {
    let empty = Vec::new();
    folders["asks"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|ask| {
            let id = ask["id"].as_str()?;
            let path = notification_text(ask["path"].as_str().unwrap_or(""), 200);
            let how = if ask["write"].as_bool().unwrap_or(false) { "read and change" } else { "read" };
            let why = notification_text(ask["why"].as_str().unwrap_or(""), 300);
            let reason = if why.is_empty() { String::new() } else { format!(": {why}") };
            Some((
                format!("folder:{id}"),
                format!("An agent asks to {how} a folder"),
                format!("{path}{reason}. Click to open Agent access, where Allow asks your password."),
            ))
        })
        .collect()
}

/// Shows a notification for each request of this kind (`prefix`) that has none yet, and takes away the notifications
/// of requests no longer waiting (answered in the panel, given up, or the agent stopped). An empty prefix is every kind.
fn keep_request_notifications(prefix: &str, waiting: Vec<RequestNotice>) {
    let gone: Vec<u32> = {
        let mut shown = requests().lock().expect("the requests lock");
        let keys: Vec<String> = shown
            .keys()
            .filter(|key| key.starts_with(prefix) && !waiting.iter().any(|(each, _, _)| each == *key))
            .cloned()
            .collect();
        keys.iter().filter_map(|key| shown.remove(key)).collect()
    };
    for id in gone {
        commands::close_notification(id);
    }
    for (key, summary, body) in waiting {
        if requests().lock().expect("the requests lock").contains_key(&key) {
            continue;
        }
        // Off the lock: the notification service is asked on this (the watcher's) thread.
        if let Some(id) = commands::notify_request(&summary, &body) {
            requests().lock().expect("the requests lock").insert(key, id);
        }
    }
}

/// When the app started (`watch`).
fn started() -> &'static OnceLock<Instant> {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    &STARTED
}

/// The app was started while a request waits, most likely from the agent's own notification of it (`omp-app-device`
/// shows one while no window watches, and a click starts the app): it opens on the Agent access panel, once, a few
/// seconds in so its page is there to hear it.
fn open_if_just_started(app: &AppHandle, waiting: bool) {
    static OPENED: AtomicBool = AtomicBool::new(false);
    let just = started().get().is_some_and(|at| at.elapsed() < Duration::from_secs(20));
    if waiting && just && !OPENED.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(4));
            open_access_panel(&app);
        });
    }
}

/// Brings the app's window forward on its Agent access panel: the page opens the panel it is told of
/// (`omp-app:show-panel`, `apps/ui/src/panels/panel-state.ts`).
fn open_access_panel(app: &AppHandle) {
    show_app(app);
    if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
        let _ = window.eval(
            "window.dispatchEvent(new CustomEvent(\"omp-app:show-panel\", { detail: \"access\" }))",
        );
    }
}

/// A session's text as a notification body: notification services may read the body as markup (the freedesktop
/// notification spec's `body-markup`), so `&`, `<` and `>` are escaped and control characters dropped; at most `most`
/// characters.
fn notification_text(text: &str, most: usize) -> String {
    let mut out = String::new();
    for character in text.chars().filter(|each| !each.is_control()).take(most) {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

/// "Agent access on · 1 h 42 min left", from the deadline the agent last gave.
fn tray_text() -> String {
    let until = *deadline().lock().expect("the deadline lock");
    match until.map(|until| until.saturating_duration_since(Instant::now()).as_secs()) {
        Some(left) => {
            let (hours, minutes) = (left / 3600, (left % 3600).div_ceil(60).min(59));
            if hours > 0 {
                format!("Agent access on · {hours} h {minutes} min left")
            } else {
                format!("Agent access on · {minutes} min left")
            }
        }
        None => "Agent access on".to_owned(),
    }
}

/// The tray menu's first line, the time left, kept to update it in place (the menu stays open while it changes).
fn left_item() -> &'static Mutex<Option<MenuItem<tauri::Wry>>> {
    static LEFT: OnceLock<Mutex<Option<MenuItem<tauri::Wry>>>> = OnceLock::new();
    LEFT.get_or_init(|| Mutex::new(None))
}

/// The red icon, with no text beside it: GNOME's tray draws an indicator's label as a small dot next to the icon. The
/// time left is the menu's first line and the tooltip.
fn show_tray(app: &AppHandle) {
    if app.tray_by_id(TRAY).is_some() {
        refresh_tray(app);
        return;
    }
    let built = (|| -> tauri::Result<()> {
        let left = MenuItem::with_id(app, "access-left", tray_text(), false, None::<&str>)?;
        let show = MenuItem::with_id(app, "access-show", "Show the app", true, None::<&str>)?;
        let sudo = MenuItem::with_id(
            app,
            "access-sudo",
            "Allow sudo for 30 min",
            true,
            None::<&str>,
        )?;
        let extend = MenuItem::with_id(app, "access-extend", "Extend 1 h", true, None::<&str>)?;
        let off = MenuItem::with_id(app, "access-off", "Turn off", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&left, &show, &extend, &sudo, &off])?;
        *left_item().lock().expect("the tray line lock") = Some(left);
        TrayIconBuilder::with_id(TRAY)
            .icon(Image::from_bytes(include_bytes!("../icons/access-on.png"))?)
            .tooltip(tray_text())
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "access-show" => show_app(app),
                "access-extend" => {
                    let pid = std::process::id();
                    thread::spawn(move || {
                        if let Err(error) =
                            ask(json!({ "op": "extend", "pid": pid, "minutes": 60 }))
                        {
                            eprintln!("omp app: agent access was not extended: {error}");
                        }
                    });
                }
                "access-sudo" => {
                    let pid = std::process::id();
                    thread::spawn(move || {
                        if let Err(error) = ask(json!({ "op": "sudo", "pid": pid, "minutes": 30 }))
                        {
                            eprintln!("omp app: sudo was not allowed: {error}");
                        }
                    });
                }
                "access-off" => {
                    thread::spawn(|| {
                        if let Err(error) = ask(json!({ "op": "off" })) {
                            eprintln!("omp app: agent access could not be turned off: {error}");
                        }
                    });
                }
                _ => {}
            })
            .build(app)?;
        Ok(())
    })();
    if let Err(error) = built {
        eprintln!("omp app: the agent access icon could not be shown: {error}");
    }
}

fn refresh_tray(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(tray) = app.tray_by_id(TRAY) {
            let _ = tray.set_tooltip(Some(tray_text()));
        }
        if let Some(left) = left_item().lock().expect("the tray line lock").as_ref() {
            let _ = left.set_text(tray_text());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{chat_requests, folder_requests, notification_text, refused_for};
    use serde_json::{json, Value};

    #[test]
    fn a_window_on_any_server_controls_this_computers_agent_access() {
        let a = Some("https://a.example:8445");
        let linked = json!({ "server": "https://a.example:8445", "alias": "laptop" });
        // The window on the linked server, another server, the same host on another port, or this computer's own
        // server, each with its page loaded from there: allowed.
        for origin in [
            a,
            Some("https://b.example:8445"),
            Some("https://a.example:8446"),
            Some("http://127.0.0.1:4317"),
        ] {
            assert_eq!(
                refused_for(origin, origin, Some(&linked), false),
                None,
                "{origin:?}"
            );
        }
        // No server, or a page that did not come from the server its window shows: refused, also for Remove.
        assert!(refused_for(None, None, Some(&linked), true).is_some());
        assert!(refused_for(a, Some("https://b.example:8445"), Some(&linked), false).is_some());
        assert!(refused_for(a, None, Some(&linked), true).is_some());
        // Linked to no server: only Remove goes ahead, and only from a window showing a server.
        assert!(refused_for(a, a, Some(&Value::Null), false).is_some());
        assert_eq!(refused_for(a, a, Some(&Value::Null), true), None);
        assert!(refused_for(None, None, Some(&Value::Null), true).is_some());
        // The agent did not answer: never taken as linked to nothing, so not even Remove goes ahead.
        assert!(refused_for(a, a, None, true).is_some());
    }

    #[test]
    fn a_session_text_shows_as_text_in_a_notification_never_as_markup() {
        assert_eq!(
            notification_text("curl <a href=\"x\">a & b</a>\u{1b}[2J", 200),
            "curl &lt;a href=\"x\"&gt;a &amp; b&lt;/a&gt;[2J"
        );
        assert_eq!(notification_text("abcdef", 3), "abc");
    }

    #[test]
    fn each_waiting_request_is_one_notification_keyed_by_its_request_and_shown_as_text() {
        let chats = json!({ "requests": [
            { "threadId": "t1", "chat": "Fix <b>it</b>", "server": "https://server.example:8443/", "askedAt": "x" },
            { "chat": "no thread id: skipped" },
        ], "granted": [] });
        let listed = chat_requests(&chats);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "chat:t1");
        assert_eq!(listed[0].1, "A chat asks to reach this computer");
        assert!(listed[0].2.starts_with("\u{201c}Fix &lt;b&gt;it&lt;/b&gt;\u{201d} on server.example:8443."));
        assert!(listed[0].2.ends_with("Click to open Agent access, where Allow asks your password."));

        let folders = json!({ "asks": [
            { "id": "a1", "path": "~/Documents", "write": false, "why": "read the notes", "server": null },
            { "id": "a2", "path": "~/code", "write": true, "why": "", "server": null },
        ], "shared": [] });
        let asked = folder_requests(&folders);
        assert_eq!(asked.iter().map(|each| each.0.as_str()).collect::<Vec<_>>(), ["folder:a1", "folder:a2"]);
        assert_eq!(asked[0].1, "An agent asks to read a folder");
        assert!(asked[0].2.starts_with("~/Documents: read the notes. Click"));
        assert_eq!(asked[1].1, "An agent asks to read and change a folder");
        assert!(asked[1].2.starts_with("~/code. Click"));
        // A guard before folder requests sends none: no notifications.
        assert!(folder_requests(&json!({})).is_empty());
        assert!(chat_requests(&json!({})).is_empty());
    }
}
