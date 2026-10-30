//! The window's commands for the app's own pages: the servers it can open, and a desktop notification. They are granted
//! to this computer's server's pages (`capabilities/default.json`) and to the pages of the server on another computer
//! the window opens (`server::grant_page_commands`); no other site gets them.

use std::collections::HashMap;
use std::thread;

use gtk::gio;
use gtk::glib::{ToVariant, Variant};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{remote, server};

/// The app's launcher, which the notification names: clicking the notification starts it, and a second launch only
/// brings the open window forward.
const DESKTOP_ENTRY: &str = "omp-app-desktop";
const APP_NAME: &str = "omp app";
/// How long the notification service may take to answer.
const NOTIFY_WAIT_MS: i32 = 5_000;

/// The servers the page offers: this computer's, and the servers on other computers the window opened, newest first,
/// each by its computer's name. `current` names the one the window shows now; null is this computer's.
#[tauri::command]
pub fn servers() -> Value {
    let remote: Vec<String> = server::remembered_servers()
        .iter()
        .map(remote::host)
        .collect();
    json!({
        "current": server::kept_link().as_ref().map(remote::host),
        "remote": remote,
    })
}

/// Opens the server a pasted link names, as `omp-app-desktop --remote '<link>'` does: the link is kept and remembered,
/// and the window moves there. A link of another shape is refused with the reason.
#[tauri::command]
pub fn connect_server(app: AppHandle, link: String) -> Result<(), String> {
    let link = remote::parse_link(&link).ok_or(remote::LINK_SHAPE)?;
    move_window(&app, &["--remote".to_owned(), link.into()])
}

/// Opens a server on another computer the window opened before, by its computer's name.
#[tauri::command]
pub fn open_server(app: AppHandle, host: String) -> Result<(), String> {
    let link = server::remembered_servers()
        .into_iter()
        .find(|link| remote::host(link) == host)
        .ok_or_else(|| format!("{host} is not among the servers this window opened"))?;
    move_window(&app, &["--remote".to_owned(), link.into()])
}

/// Opens this computer's server, as `omp-app-desktop --local` does.
#[tauri::command]
pub fn use_this_computer(app: AppHandle) -> Result<(), String> {
    move_window(&app, &["--local".to_owned()])
}

/// Keeps or forgets the link as a launch with these arguments would, then moves the open window, as a second launch does.
fn move_window(app: &AppHandle, args: &[String]) -> Result<(), String> {
    server::apply_choice(args)?;
    server::relaunch(app, args);
    Ok(())
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
