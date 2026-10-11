//! omp app as a desktop window. The window starts the app's own server (bundled as a sidecar) on a
//! free loopback port, waits until it answers, and opens the app in the window. Closing the window,
//! or quitting the app, stops the server and every process it started; if the window process is
//! killed outright, the kernel stops the server (see `server.rs`). A second launch focuses the window
//! that is already open. The window finds the omp coding agent itself (see `omp.rs`).

mod address;
mod omp;
mod procs;
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
        .on_window_event(|window, event| {
            // Closing the window hides it at once. The app ends once the server is stopped (see
            // `server::quit`), which can take a few seconds while omp is busy.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                server::quit(window.app_handle().clone());
            }
        })
        .setup(|app| {
            signals::watch(app.handle().clone());
            server::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the omp app could not be prepared");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            server::stop(app);
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
