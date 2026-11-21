//! Ctrl+C, SIGTERM and SIGHUP quit the app the way closing the window does: the app ends, and the server keeps
//! running. Windows sends a windowed app none of these; closing its window quits it there.

#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Duration;

use tauri::AppHandle;

#[cfg(unix)]
static REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_signal(_signal: libc::c_int) {
    REQUESTED.store(true, Ordering::SeqCst);
}

/// Installs the handlers, and starts a thread that quits the app when one of them has fired.
#[cfg(unix)]
pub fn watch(app: AppHandle) {
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic flag, which is safe inside a signal handler.
        unsafe { libc::signal(signal, on_signal as *const () as libc::sighandler_t) };
    }
    thread::spawn(move || loop {
        if REQUESTED.load(Ordering::SeqCst) {
            app.exit(0);
            return;
        }
        thread::sleep(Duration::from_millis(100));
    });
}

/// Nothing to install on Windows.
#[cfg(not(unix))]
pub fn watch(_app: AppHandle) {}
