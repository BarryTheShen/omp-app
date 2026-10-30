//! omp app as a desktop window. The window opens the app on the app's own server (bundled as a sidecar): on the
//! one that already runs, or on one it starts itself, detached (see `server.rs`). Closing a window, or quitting
//! the app, never stops a server, so running chats keep going. The app can have several windows (see `windows.rs`):
//! closing one that is not the last closes it alone, and the last one's close ends the app. A second launch focuses
//! the window that had the focus last, and `omp-app-desktop --new-window` opens another window instead. The window
//! runs the omp release that ships in its package, not one found on this computer.
//!
//! `omp-app-desktop --remote '<link>'` makes the window open the app's server on another computer of the tailnet,
//! from the link that server logs for another device, and `omp-app-desktop --local` brings it back to this computer's
//! server (see `remote.rs`). Each is kept for the next launches, and a second launch with either moves the first
//! window.

mod address;
mod clipboard;
mod commands;
mod downloads;
mod gstreamer;
mod keys;
mod remote;
mod server;
mod signals;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    // Keeps or forgets the link of a server on another computer before anything starts (see `remote.rs`).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(reason) = server::apply_choice(&args) {
        eprintln!("omp app: {reason}");
        std::process::exit(2);
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The second launch's own arguments, its program's name left out.
            server::second_launch(app, args.get(1..).unwrap_or_default());
        }))
        .manage(server::Shared::default())
        .invoke_handler(tauri::generate_handler![
            clipboard::read_clipboard_png,
            commands::servers,
            commands::connect_server,
            commands::open_server,
            commands::use_this_computer,
            commands::notify,
            commands::new_window,
        ])
        .on_window_event(|window, event| match event {
            // A window that is not the last closes alone. The last one hides at once, and the app ends (see
            // `server::quit`). The server keeps running.
            WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                if !server::window_closes(app, window.label()) {
                    api.prevent_close();
                    let _ = window.hide();
                    server::quit(app.clone());
                }
            }
            WindowEvent::Focused(true) => server::focused(window.app_handle(), window.label()),
            WindowEvent::Destroyed => server::destroyed(window.app_handle(), window.label()),
            _ => {}
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
