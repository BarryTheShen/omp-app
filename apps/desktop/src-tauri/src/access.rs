//! Agent access on this computer (#20), as the desktop app shows it: the commands behind the side bar's Agent access
//! panel, the red tray icon while access is on, and a notification that stays while an agent session runs.
//!
//! The app talks to this computer's agent (`omp-app-device run`, a user service) over its control socket,
//! `$XDG_RUNTIME_DIR/omp-app-device/agent.sock`. The panel is a page of the server, so each command acts only for a
//! window whose server, by the window's own record, is the one this computer is linked to (`refused_for`); turning
//! access on, extending it, sudo and acknowledging a review then ask the person's password with the system's own
//! dialog, whose words the agent's guard writes from what it grants. Lengths are capped here and by the guard.

use std::collections::VecDeque;
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

/// Why a page may not act on this computer's agent access, or None when it may. Only a page of the server this
/// computer is linked to may: the window's own record of its server (never the page's word) and the address the page
/// was loaded from (`shown`) must both be that server, so a page of any other server, or of this computer's own, is
/// refused before anything is asked and cannot even make the password dialog appear. `linked` is the agent's record of
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
        Some(server) if server == origin => None,
        Some(server) => Some(format!(
            "This computer is linked to {server}, not to the server this window shows."
        )),
        None if allow_unlinked => None,
        None => Some("This computer is not linked to the server this window shows.".to_owned()),
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
const LONGEST_ON: u32 = 120;
/// The longest sudo grant, in minutes.
const LONGEST_SUDO: u32 = 30;

#[tauri::command]
pub async fn access_status(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    for_linked_window(&app, &window, false, |_| ask(json!({ "op": "status" }))).await
}

/// Turns access on for `minutes` (1 to 120): the system asks the person's password for this app's process first, in a
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

/// `minutes` (1 to 120) more while on, never past two hours from now (the system asks the person's password again).
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

/// What the app's Agent access panel shows for this computer: whether the parts are installed, set up, and linked to
/// the server of the window asking (`here`).
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
/// A computer linked to another server is never moved here (it is removed there first); one set up but linked to no
/// server is linked only after an administrator's password again; one linked to this server is linked again without
/// (its server forgot it). So no page links this computer to its server without a password.
/// Answers `{ ok, problems, changes, linked }`.
#[tauri::command]
pub async fn access_set_up_here(
    app: AppHandle,
    window: tauri::WebviewWindow,
    code: String,
) -> Result<Value, String> {
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
                return Err(format!(
                    "This computer is linked to {server}. Remove agent access in that server's Agent access panel first, then set it up here."
                ));
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
            match ask(
                json!({ "op": "enroll", "server": origin, "code": code.trim(), "alias": name }),
            ) {
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
/// its server to forget this computer first). Only for a page of the server this computer is linked to, or of any server
/// when it is linked to none (a setup that never linked).
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
/// shows, for the panel's live view. Only for a page of the server this computer is linked to.
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

/// Follows the agent: keeps its events for the panel, shows the tray while access is on, and when a session starts,
/// says so in a notification that stays. Waits for an agent that is not running yet.
pub fn watch(app: AppHandle) {
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
            // The agent stopped: access is off with it.
            take(
                &app,
                json!({ "type": "state", "state": { "on": false }, "linked": false }),
            );
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
        // Sudo allowed, and the summary when access turns off.
        Some("notice") => {
            let text = notification_text(event["text"].as_str().unwrap_or(""), 600);
            commands::notify("Agent access".to_string(), text);
        }
        _ => {}
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
    use super::{notification_text, refused_for};
    use serde_json::{json, Value};

    #[test]
    fn only_a_window_on_the_linked_server_acts_on_agent_access() {
        let a = Some("https://a.example:8445");
        let linked = json!({ "server": "https://a.example:8445", "alias": "laptop" });
        // The window on the linked server, its page loaded from there: allowed.
        assert_eq!(refused_for(a, a, Some(&linked), false), None);
        // Another server, the same host on another port, this computer's own server, or no server: refused, also for
        // Remove.
        for origin in [
            Some("https://b.example:8445"),
            Some("https://a.example:8446"),
            Some("http://127.0.0.1:4317"),
            None,
        ] {
            assert!(
                refused_for(origin, origin, Some(&linked), false).is_some(),
                "{origin:?}"
            );
            assert!(
                refused_for(origin, origin, Some(&linked), true).is_some(),
                "{origin:?}"
            );
        }
        // The window's record says the linked server but the page came from elsewhere (it has not moved yet): refused.
        assert!(refused_for(a, Some("https://b.example:8445"), Some(&linked), false).is_some());
        assert!(refused_for(a, None, Some(&linked), false).is_some());
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
}
