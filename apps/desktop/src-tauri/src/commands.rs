//! The window's commands for the app's own pages: the servers it can open, a new window, and a desktop notification.
//! They are granted, by exact origin, to the pages of this computer's server and of the server on another computer a
//! window opens (`server::grant_page_commands`), in every window; the window's own page for a server that did not open
//! may call the four that choose the window's server (`capabilities/app-pages.json`); no other site gets them.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::thread;

#[cfg(target_os = "linux")]
use gtk::gio;
#[cfg(target_os = "linux")]
use gtk::glib::{ToVariant, Variant};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

use crate::{remote, server};

// The freedesktop notification service, on Linux. The other systems' notifications go through Tauri's notification
// plugin (`notify`); the lasting and request kinds belong to agent access, which is Linux's alone (platforms PLAN, P4).

/// The app's launcher, which the notification names: clicking the notification starts it, and a second launch only
/// brings the open window forward.
#[cfg(target_os = "linux")]
const DESKTOP_ENTRY: &str = "omp-app-desktop";
#[cfg(target_os = "linux")]
const APP_NAME: &str = "omp app";
/// How long the notification service may take to answer.
#[cfg(target_os = "linux")]
const NOTIFY_WAIT_MS: i32 = 5_000;

/// The servers the page offers: this computer's, and the servers on other computers the app opened, newest first, each
/// by its computer's name. `current` names the one the asking window shows now; null is this computer's. `names` holds
/// the names the person gave them, by host.
#[tauri::command]
pub fn servers(app: AppHandle, window: WebviewWindow) -> Value {
    let remote: Vec<String> = server::remembered_servers()
        .iter()
        .map(remote::host)
        .collect();
    json!({
        "current": server::current_server(&app, window.label()),
        "remote": remote,
        "names": server::server_names(),
    })
}

/// Names a server the app opened before (an empty name takes the name away).
#[tauri::command]
pub fn rename_server(host: String, name: String) -> Result<(), String> {
    known(&host)?;
    server::name_server(&host, &name)
}

/// Forgets a server the app opened before, and its name. The server the asking window shows is not forgotten: the
/// window moves elsewhere first.
#[tauri::command]
pub fn forget_server(app: AppHandle, window: WebviewWindow, host: String) -> Result<(), String> {
    if server::current_server(&app, window.label()).as_deref() == Some(host.as_str()) {
        return Err("This window shows that server; open another one first.".to_owned());
    }
    known(&host)?;
    server::forget_remembered(&host).map(|_| ())
}

/// Whether a server the app opened before accepts a connection now (within a few seconds); off the main thread.
#[tauri::command]
pub async fn check_server(host: String) -> Result<bool, String> {
    let link = known(&host)?;
    tauri::async_runtime::spawn_blocking(move || remote::reachable(&link))
        .await
        .map_err(|error| error.to_string())
}

/// The remembered link of the server on `host`, or why there is none.
fn known(host: &str) -> Result<tauri::Url, String> {
    server::remembered_servers()
        .into_iter()
        .find(|link| remote::host(link) == host)
        .ok_or_else(|| format!("{host} is not among the servers this app opened"))
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

/// Opens another window on a server on another computer the app opened before, by its computer's name; the asking
/// window stays on its own server.
#[tauri::command]
pub async fn open_server_window(app: AppHandle, host: String) -> Result<(), String> {
    server::open_server_window(&app, known(&host)?)
}

/// Shows a desktop notification with the app's name and launcher. It never waits on the page: the notification
/// service is asked on a thread of its own, and a computer without one only logs why.
#[tauri::command]
pub fn notify(app: AppHandle, summary: String, body: String) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        thread::spawn(move || {
            if let Err(error) = send_notification(&summary, &body, Style::Plain) {
                eprintln!("omp app: a notification could not be shown: {error}");
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(error) = app
            .notification()
            .builder()
            .title(summary)
            .body(body)
            .show()
        {
            eprintln!("omp app: a notification could not be shown: {error}");
        }
    }
}

/// A notification that stays until the person dismisses it (urgency critical), as for an agent session on this
/// computer (`access.rs`). Never from a page: no command reaches it.
#[cfg(target_os = "linux")]
pub fn notify_lasting(summary: &str, body: &str) {
    let (summary, body) = (summary.to_owned(), body.to_owned());
    thread::spawn(move || {
        if let Err(error) = send_notification(&summary, &body, Style::Lasting) {
            eprintln!("omp app: a notification could not be shown: {error}");
        }
    });
}

/// An agent's request (a chat or a folder asks to reach this computer): a notification that stays
/// until it is clicked or dismissed, with the desktop's question sound, and no buttons. A click (the `default` action,
/// see `on_notification_click`) opens the app's Agent access panel, where Allow asks the person's password; nothing
/// here ever opens a password dialog. Returns the notification's id, to withdraw it once the request is answered. Asks
/// the service on the calling thread: call it off the main thread. Never from a page.
#[cfg(target_os = "linux")]
pub fn notify_request(summary: &str, body: &str) -> Option<u32> {
    match send_notification(summary, body, Style::Request) {
        Ok(id) => Some(id),
        Err(error) => {
            eprintln!("omp app: a notification could not be shown: {error}");
            None
        }
    }
}

/// Takes a notification away (the freedesktop `CloseNotification`), on a thread of its own.
#[cfg(target_os = "linux")]
pub fn close_notification(id: u32) {
    thread::spawn(move || {
        let closed = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).and_then(|bus| {
            bus.call_sync(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "CloseNotification",
                Some(&(id,).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                NOTIFY_WAIT_MS,
                gio::Cancellable::NONE,
            )
        });
        if let Err(error) = closed {
            eprintln!("omp app: a notification could not be taken away: {error}");
        }
    });
}

/// Calls `clicked` with a notification's id whenever the person clicks a notification (its `default` action). Call it
/// on the main thread: the bus delivers the signal through the main loop that runs there.
#[cfg(target_os = "linux")]
pub fn on_notification_click(clicked: impl Fn(u32) + 'static) {
    match gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
        Ok(bus) => {
            // The subscription lives as long as the app: its id is never needed to end it.
            let _ = bus.signal_subscribe(
                Some("org.freedesktop.Notifications"),
                Some("org.freedesktop.Notifications"),
                Some("ActionInvoked"),
                Some("/org/freedesktop/Notifications"),
                None,
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, parameters| {
                    if let Some((id, action)) = parameters.get::<(u32, String)>() {
                        if action == "default" {
                            clicked(id);
                        }
                    }
                },
            );
        }
        Err(error) => eprintln!("omp app: notification clicks cannot be followed: {error}"),
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq)]
enum Style {
    /// Shown and gone, as the desktop decides.
    Plain,
    /// Stays until dismissed: an agent session at work.
    Lasting,
    /// Stays until clicked or dismissed, with a sound; a click is its `default` action.
    Request,
}

/// The freedesktop notification service's `Notify`, on the session bus; returns the notification's id.
#[cfg(target_os = "linux")]
fn send_notification(summary: &str, body: &str, style: Style) -> Result<u32, gtk::glib::Error> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)?;
    let mut hints: HashMap<String, Variant> = HashMap::new();
    hints.insert("desktop-entry".to_owned(), DESKTOP_ENTRY.to_variant());
    if style != Style::Plain {
        // Critical urgency: the desktop keeps it until it is dismissed (the notification specification's `urgency` 2).
        hints.insert("urgency".to_owned(), 2_u8.to_variant());
        hints.insert("resident".to_owned(), true.to_variant());
    }
    if style == Style::Request {
        // The specification's sound theme name for a question to the person.
        hints.insert("sound-name".to_owned(), "dialog-question".to_variant());
    }
    // A `default` action is what a click on the notification itself invokes; it shows no button.
    let actions = if style == Style::Request {
        vec!["default".to_owned(), "Open Agent access".to_owned()]
    } else {
        Vec::new()
    };
    // app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout (-1: the service decides).
    let message = (
        APP_NAME.to_owned(),
        0_u32,
        String::new(),
        summary.to_owned(),
        body.to_owned(),
        actions,
        hints,
        -1_i32,
    );
    let parameters = message.to_variant();
    let reply = bus.call_sync(
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
    Ok(reply.get::<(u32,)>().map_or(0, |(id,)| id))
}
