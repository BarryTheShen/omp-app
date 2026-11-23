//! omp app as a desktop window. The window opens the app on the app's own server (in its resource folder): on the
//! one that already runs, or on one it starts itself, detached (see `server.rs`). Closing a window, or quitting
//! the app, never stops a server, so running chats keep going. The app can have several windows (see `windows.rs`):
//! closing one that is not the last closes it alone, and the last one's close ends the app. A second launch focuses
//! the window that had the focus last, and `omp-app-desktop --new-window` opens another window instead. The window
//! runs the omp release that ships in its package, not one found on this computer.
//!
//! `omp-app-desktop --remote '<link>'` makes the window open the app's server on another computer,
//! from the link that server logs for another device, and `omp-app-desktop --local` brings it back to this computer's
//! server (see `remote.rs`). Each is kept for the next launches, and a second launch with either moves the first
//! window.
//!
//! `omp-app-desktop 'omp-app://chat/<chat id>?server=<origin>'`, as the system runs it for such a link (the lite view's
//! "Open in the full app"), shows that chat in a window on that server (see `chat_link.rs`).
//!
//! Agent access on this computer (#20): the commands behind the side bar's Agent access panel, the tray icon while
//! access is on and the notification during an agent session (see `access.rs`).

// Agent access and the app's own update are Linux's (sshd, polkit, a `.deb`); elsewhere their commands answer in words.
#[cfg(target_os = "linux")]
mod access;
#[cfg(not(target_os = "linux"))]
#[path = "access_elsewhere.rs"]
mod access;
mod address;
mod chat_link;
mod clipboard;
mod commands;
mod downloads;
// WebKitGTK's own needs: its GStreamer plugin cache and its Super key. Other systems' webviews have neither problem.
#[cfg(target_os = "linux")]
mod gstreamer;
#[cfg(target_os = "linux")]
mod keys;
mod relay;
mod remote;
mod server;
mod signals;
#[cfg(target_os = "linux")]
mod update;
#[cfg(not(target_os = "linux"))]
#[path = "update_elsewhere.rs"]
mod update;
mod webdata;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    // Keeps or forgets the link of a server on another computer before anything starts (see `remote.rs`).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(reason) = server::apply_choice(&args) {
        eprintln!("omp app: {reason}");
        std::process::exit(2);
    }
    // A link to a chat that started the app opens with the first window (see `chat_link.rs`).
    let link = chat_link::find(&args);
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The second launch's own arguments, its program's name left out.
            server::second_launch(app, args.get(1..).unwrap_or_default());
        }))
        .manage(server::Shared::default());
    // Notifications through the system's own service off Linux (Linux's go over D-Bus, see `commands.rs`).
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
        .invoke_handler(tauri::generate_handler![
            clipboard::read_clipboard_png,
            clipboard::list_clipboard_files,
            clipboard::read_clipboard_file,
            commands::servers,
            commands::connect_server,
            commands::open_server,
            commands::use_this_computer,
            commands::rename_server,
            commands::forget_server,
            commands::check_server,
            commands::open_server_window,
            commands::notify,
            commands::new_window,
            access::access_status,
            access::access_on,
            access::access_off,
            access::access_acknowledge,
            access::access_extend,
            access::access_sudo,
            access::access_events,
            access::access_remove,
            access::access_allow_folder,
            access::access_deny_folder,
            access::access_remove_folder,
            access::access_allow_chat,
            access::access_deny_chat,
            access::access_remove_chat,
            access::access_add_chat,
            access::access_share_folder,
            update::update_desktop_app,
            access::access_here,
            access::access_set_up_here,
            relay::relay_carry,
            relay::relay_state,
            relay::relay_stop,
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
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            app.manage(gstreamer::RegistryScan::start());
            signals::watch(app.handle().clone());
            server::start(app.handle().clone(), link);
            access::watch(app.handle().clone());
            relay::start_kept(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the omp app could not be prepared");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            server::quitting(app);
            relay::quitting();
        }
    });
}
