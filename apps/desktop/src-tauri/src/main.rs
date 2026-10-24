//! omp app as a desktop window. The window opens the app on the app's own server (bundled as a sidecar): on the
//! one that already runs, or on one it starts itself, detached (see `server.rs`). Closing the window, or quitting
//! the app, never stops a server, so running chats keep going. A second launch focuses the window that is already
//! open. The window runs the omp release that ships in its package, not one found on this computer.

mod address;
mod clipboard;
mod downloads;
mod gstreamer;
mod server;
mod signals;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// The app's one window.
const WINDOW_LABEL: &str = "main";

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_window(app)
        }))
        .manage(server::Shared::default())
        .invoke_handler(tauri::generate_handler![clipboard::read_clipboard_png])
        .on_window_event(|window, event| {
            // Closing the window hides it at once, and the app ends (see `server::quit`). The server keeps running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                server::quit(window.app_handle().clone());
            }
        })
        .setup(|app| {
            app.manage(gstreamer::RegistryScan::start());
            signals::watch(app.handle().clone());
            server::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the omp app could not be prepared");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            server::quitting(app);
        }
    });
}

/// A second launch lands here: the window that is already open comes forward.
fn focus_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
