//! WebKit plays media through GStreamer, and GStreamer builds its plugin cache the first time it runs.
//! On a machine without that cache, the first run scans every plugin and blocks the page's main thread
//! for several seconds. The command palette was the first thing to wait for that scan (#1124). This
//! starts the scan at launch, in the background, and the app page waits for it to finish before it
//! opens (see `server.rs`), so the palette cannot open while the scan is still running. Without the
//! tool nothing waits: the scan then happens on first use, as before.

use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

/// Part of the `gstreamer1.0-tools` package, which the .deb recommends.
const REGISTRY_TOOL: &str = "gst-inspect-1.0";

/// The launch scan. Tauri keeps it in its state, and the app page's opener waits on it.
pub struct RegistryScan(Mutex<Option<mpsc::Receiver<()>>>);

impl RegistryScan {
    /// Starts the scan at once, in a background thread. `--exists identity` makes GStreamer load its
    /// registry, which writes the cache that the page's WebKit process reads.
    pub fn start() -> Self {
        Self::start_with(REGISTRY_TOOL)
    }

    fn start_with(tool: &str) -> Self {
        let (finished, done) = mpsc::channel();
        let tool = tool.to_owned();
        thread::spawn(move || {
            let _ = registry_command(&tool).status();
            let _ = finished.send(());
        });
        Self(Mutex::new(Some(done)))
    }

    /// Waits for the scan to finish, for at most `limit`. A scan that already finished returns at once,
    /// and so does every call after the first.
    pub fn wait(&self, limit: Duration) {
        let done = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(done) = done {
            let _ = done.recv_timeout(limit);
        }
    }
}

fn registry_command(tool: &str) -> Command {
    let mut command = Command::new(tool);
    command
        .args(["--exists", "identity"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn the_scan_checks_one_core_element_quietly() {
        let command = registry_command(REGISTRY_TOOL);
        assert_eq!(command.get_program().to_str(), Some(REGISTRY_TOOL));
        let args: Vec<&str> = command.get_args().filter_map(|arg| arg.to_str()).collect();
        assert_eq!(args, ["--exists", "identity"]);
    }

    #[test]
    fn a_machine_without_the_tool_does_not_hold_the_page_back() {
        let scan = RegistryScan::start_with("omp-app-no-such-gstreamer-tool");
        let started = Instant::now();
        scan.wait(Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_later_wait_returns_at_once() {
        let scan = RegistryScan::start_with("omp-app-no-such-gstreamer-tool");
        scan.wait(Duration::from_secs(10));
        let started = Instant::now();
        scan.wait(Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
