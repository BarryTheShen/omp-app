//! The window's commands for the app's own pages: the servers it can open, a new window, and a desktop notification.
//! They are granted, by exact origin, to the pages of this computer's server and of the server on another computer a
//! window opens (`server::grant_page_commands`), in every window; no other site gets them.

use std::collections::HashMap;
use std::thread;

use gtk::gio;
use gtk::glib::{ToVariant, Variant};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

use crate::{remote, server};

/// The app's launcher, which the notification names: clicking the notification starts it, and a second launch only
/// brings the open window forward.
const DESKTOP_ENTRY: &str = "omp-app-desktop";
const APP_NAME: &str = "omp app";
/// How long the notification service may take to answer.
const NOTIFY_WAIT_MS: i32 = 5_000;

/// The servers the page offers: this computer's, and the servers on other computers the app opened, newest first, each
/// by its computer's name. `current` names the one the asking window shows now; null is this computer's.
#[tauri::command]
pub fn servers(app: AppHandle, window: WebviewWindow) -> Value {
    let remote: Vec<String> = server::remembered_servers()
        .iter()
        .map(remote::host)
        .collect();
    json!({
        "current": server::current_server(&app, window.label()),
        "remote": remote,
    })
}

/// Opens the server a pasted link names, as `omp-app-desktop --remote '<link>'` does: the link is remembered, and the
/// asking window moves there (the first window's server is also the one the next start opens). A link of another shape
/// is refused with the reason.
#[tauri::command]
pub fn connect_server(app: AppHandle, window: WebviewWindow, link: String) -> Result<(), String> {
    let link = remote::parse_link(&link).ok_or(remote::LINK_SHAPE)?;
    move_window(&app, window.label(), &["--remote".to_owned(), link.into()])
}

/// Opens a server on another computer the app opened before, by its computer's name, in the asking window.
#[tauri::command]
pub fn open_server(app: AppHandle, window: WebviewWindow, host: String) -> Result<(), String> {
    let link = server::remembered_servers()
        .into_iter()
        .find(|link| remote::host(link) == host)
        .ok_or_else(|| format!("{host} is not among the servers this app opened"))?;
    move_window(&app, window.label(), &["--remote".to_owned(), link.into()])
}

/// Opens this computer's server in the asking window, as `omp-app-desktop --local` does for the first window.
#[tauri::command]
pub fn use_this_computer(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    move_window(&app, window.label(), &["--local".to_owned()])
}

/// Keeps or forgets the link as a launch with these arguments would, for the first window only (see
/// `server::apply_choice_for`), then moves window `label`, as a second launch does.
fn move_window(app: &AppHandle, label: &str, args: &[String]) -> Result<(), String> {
    server::apply_choice_for(label, args)?;
    server::relaunch(app, label, args);
    Ok(())
}

/// Opens another window on the server the asking window shows (see `server::open_window_like`). Async, so the wait for
/// the server's answer is off the main thread.
#[tauri::command]
pub async fn new_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let source = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || server::open_window_like(&app, &source))
        .await
        .map_err(|error| error.to_string())?
}

/// Shows a desktop notification with the app's name and launcher. It never waits on the page: the notification
/// service is asked on a thread of its own, and a computer without one only logs why.
#[tauri::command]
pub fn notify(summary: String, body: String) {
    thread::spawn(move || {
        if let Err(error) = send_notification(&summary, &body) {
            eprintln!("omp app: a notification could not be shown: {error}");
        }
    });
}

/// The freedesktop notification service's `Notify`, on the session bus.
fn send_notification(summary: &str, body: &str) -> Result<(), gtk::glib::Error> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)?;
    let mut hints: HashMap<String, Variant> = HashMap::new();
    hints.insert("desktop-entry".to_owned(), DESKTOP_ENTRY.to_variant());
    // app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout (-1: the service decides).
    let message = (
        APP_NAME.to_owned(),
        0_u32,
        String::new(),
        summary.to_owned(),
        body.to_owned(),
        Vec::<String>::new(),
        hints,
        -1_i32,
    );
    let parameters = message.to_variant();
    bus.call_sync(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        Some(&parameters),
        None,
        gio::DBusCallFlags::NONE,
        NOTIFY_WAIT_MS,
        gio::Cancellable::NONE,
    )?;
    Ok(())
}
