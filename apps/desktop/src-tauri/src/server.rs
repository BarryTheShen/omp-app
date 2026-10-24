//! The window's server: the window opens the app on the server that already runs, or starts one.
//!
//! The server belongs to the user, not to the window. At launch the window first reads the record the server
//! writes when it listens (see `address.rs`). If the record names a live process whose address answers, the window
//! attaches: it opens on the starting page, then on that address, and starts and watches nothing. Otherwise it starts
//! the server detached, in a session of its own and with no input or output, and waits for the record to name a live
//! server that answers. That may be another instance: a server that finds one running ends, and the record then names
//! that instance. So closing the window, quitting, SIGTERM and SIGKILL of the window never stop a server, and the
//! chats it runs keep going. The window never stops a server, and never kills the one it started, not even when none
//! answers in time: the error page shows instead.
//!
//! While the window is open and the server it started is its child, one thread waits for that server to end, and shows
//! the error page when nothing serves any more. A server that was already running is not watched. The server runs the
//! omp that ships with the app, from the package's own folder, so nothing is looked up on this computer. A server the
//! window starts asks for the port the `omp-app` command and the user service ask for (see `DESKTOP_PORT`), so the web
//! app's address, and with it its stored settings, is the same whichever of them started the server.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::address;
use crate::downloads;
use crate::gstreamer::RegistryScan;
use crate::WINDOW_LABEL;

/// The sidecar's file name: the bundler installs it next to the window binary under this name.
const SIDECAR: &str = "omp-app-desktop-server";
/// The port the server is asked for: 4317, the one the `omp-app` command and the user service ask for, so the window's
/// address, and with it the web app's stored settings, is the same whichever of them started the server. If it is busy,
/// the server picks a free port itself, as it does for the command.
const DESKTOP_PORT: &str = "4317";
/// The page shown at once, while the server starts, served from apps/desktop/ui.
const STARTING_PAGE: &str = "starting.html";
/// The page for "the app could not start", served from apps/desktop/ui.
const ERROR_PAGE: &str = "error.html";
const WINDOW_TITLE: &str = "omp app";
/// How long a server that was started has to record itself and answer. The server answers only after its omp checks,
/// and the first start of the omp the package holds also sets that omp up (it unpacks its native parts into the home
/// folder), which on a busy computer took more than 30 s; the window shows the starting page meanwhile.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long the app page waits for the launch scan of GStreamer's plugin cache (see `gstreamer.rs`).
const REGISTRY_SCAN_WAIT: Duration = Duration::from_secs(60);

/// What the threads share. Only ever locked for a moment.
#[derive(Default)]
pub struct Shared {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Set when the app quits: nothing may open in the window or show an error after this.
    quitting: bool,
}

fn with_state<T>(app: &AppHandle, change: impl FnOnce(&mut State) -> T) -> T {
    let shared = app.state::<Shared>();
    let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
    change(&mut state)
}

/// Opens the app in the window (see `launch`). Called once, from the app's setup, which runs on the main thread.
pub fn start(app: AppHandle) {
    launch(&mut AppSteps { app });
}

/// The steps a launch runs, in order. `AppSteps` runs them on the app; the tests run the same order on recording steps.
trait LaunchSteps {
    /// A server this launch started, until it is watched.
    type Started;
    /// The address of the server that already runs, if one does (see `running_server`).
    fn running(&mut self) -> Option<Url>;
    /// Starts the server, detached, on the omp that ships with the app (see `spawn`).
    fn spawn_server(&mut self) -> Result<Self::Started, String>;
    /// Builds the window on `page`. False when the window cannot open; the app is then asked to exit.
    fn open_window(&mut self, page: &'static str) -> bool;
    /// Opens the app in the window on the address of the server that already runs.
    fn open_server(&mut self, address: Url);
    /// Watches a server this launch started: the app opens on the server once it records itself and answers, and the
    /// error page shows when the server ends with nothing else serving.
    fn watch_server(&mut self, started: Self::Started);
}

/// Attaches to the server that already runs, or starts one. A server that runs is attached to before anything starts:
/// the window opens on the starting page and then on its address. Otherwise the server starts on this thread before
/// the window is built, so the two starts overlap (plan S2): the window then opens on the starting page, or on the
/// error page when the server did not start. A window that cannot open asks the app to exit and nothing more starts.
fn launch<S: LaunchSteps>(steps: &mut S) {
    if let Some(address) = steps.running() {
        if steps.open_window(STARTING_PAGE) {
            steps.open_server(address);
        }
        return;
    }
    match steps.spawn_server() {
        Ok(started) => {
            // The window opens before the server is watched: a page shown by the watch would find no window yet.
            if steps.open_window(STARTING_PAGE) {
                steps.watch_server(started);
            }
        }
        Err(problem) => {
            eprintln!("omp app: the server did not start: {problem}");
            steps.open_window(ERROR_PAGE);
        }
    }
}

/// The app's own steps: the window and the server, on the app's handle.
struct AppSteps {
    app: AppHandle,
}

impl LaunchSteps for AppSteps {
    type Started = Child;

    fn running(&mut self) -> Option<Url> {
        running_server()
    }

    fn spawn_server(&mut self) -> Result<Self::Started, String> {
        spawn(&self.app)
    }

    fn open_window(&mut self, page: &'static str) -> bool {
        match new_window(&self.app, WebviewUrl::App(page.into())).build() {
            Ok(_) => true,
            Err(error) => {
                eprintln!("omp app: the window did not open: {error}");
                self.app.exit(1);
                false
            }
        }
    }

    fn open_server(&mut self, address: Url) {
        // Off the main thread, which this runs on: the page first waits for GStreamer's launch scan (see `open_server_page`).
        let app = self.app.clone();
        thread::spawn(move || open_server_page(&app, address));
    }

    fn watch_server(&mut self, child: Self::Started) {
        watch(self.app.clone(), child);
    }
}

/// Where the server records itself, by the variables the server reads (see `address::instance_file`).
fn instance_record() -> Option<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME");
    let home = std::env::var_os("HOME");
    address::instance_file(state.as_deref(), home.as_deref())
}

/// The address of the server that runs now, from its record: its process is alive and its address answers.
fn running_server() -> Option<Url> {
    let record = instance_record()?;
    let address = address::answering_instance(&record)?;
    Url::parse(&address.url).ok()
}

/// Starts the server on the desktop port (or a free one, when it is busy), with the browser opening switched off, on
/// the omp that ships with the app (the `omp` folder beside the web app). The server is detached: it has a session
/// (and so a process group) of its own, and no input or output, so nothing that happens to this process reaches it.
/// It logs to its own file and records its address itself, so its output is not needed.
fn spawn(app: &AppHandle) -> Result<Child, String> {
    let folder = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or("the home folder was not found")?;
    let paths = app.path();
    let resources = paths.resource_dir().map_err(|error| error.to_string())?;
    let web_root = resources.join("web");
    let omp_dir = resources.join("omp");
    // The server would fall back to other folders if this one were missing; that must not happen.
    if !web_root.join("index.html").is_file() {
        return Err(format!("the web app is not in {}", web_root.display()));
    }
    let sidecar = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("the app's folder was not found")?
        .join(SIDECAR);
    let mut command = StdCommand::new(&sidecar);
    command
        .args([folder.as_os_str(), OsStr::new("--no-open")])
        .current_dir(&folder)
        .env("OMP_APP_WEB_ROOT", &web_root)
        // The omp the server runs: the one that ships with the app, never one installed on this computer.
        .env("OMP_APP_OMP_DIR", &omp_dir)
        // The server takes this port when it is free, and otherwise a free port (see DESKTOP_PORT).
        .env("OMP_APP_PORT", DESKTOP_PORT)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the closure runs in the child between fork and exec. It makes one system call and allocates
    // nothing, which is all that is allowed at that point.
    unsafe {
        command.pre_exec(|| {
            // A session of its own, and so a process group of its own, with no controlling terminal.
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map_err(|error| error.to_string())
}

/// Watches the server this window started, for as long as the window runs. One thread waits for the server to end;
/// when it does and no server answers (a server that found another instance running also ends, and that instance
/// serves the window), the error page is shown. The other thread waits for the record to name a server that answers,
/// and opens the app on it.
fn watch(app: AppHandle, mut child: Child) {
    let ender = app.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if running_server().is_none() {
            show_error(&ender);
        }
    });
    thread::spawn(move || open_when_recorded(&app));
}

/// Waits for the record to name a live server that answers, and opens the app on it. If none does within
/// `START_TIMEOUT`, the error page is shown, and the server that was started is left alone. The server's start can
/// take a long time on a busy computer, so the window shows the starting page until it answers.
fn open_when_recorded(app: &AppHandle) {
    let Some(record) = instance_record() else {
        show_error(app);
        return;
    };
    let found = address::wait_for_instance(&record, START_TIMEOUT);
    let url = found.and_then(|address| Url::parse(&address.url).ok());
    match url {
        Some(url) => open_server_page(app, url),
        None => show_error(app),
    }
}

/// The app is quitting: nothing opens in the window or shows an error from now on. No server is stopped.
pub fn quitting(app: &AppHandle) {
    with_state(app, |state| state.quitting = true);
}

/// The window was closed: the app ends, and the server keeps running. This runs on its own thread, so the window
/// (already hidden) and the event loop are not held up meanwhile.
pub fn quit(app: AppHandle) {
    thread::spawn(move || {
        quitting(&app);
        app.exit(0);
    });
}

fn new_window(
    app: &AppHandle,
    page: WebviewUrl,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, page)
        .title(WINDOW_TITLE)
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(|target| {
            let inside = is_app_address(target);
            if !inside {
                open_externally(target);
            }
            inside
        })
        .on_new_window(|target, _features| {
            open_externally(&target);
            NewWindowResponse::Deny
        })
        // The web app saves a file (the debug log) as a download. The window sets where it goes: the
        // account's Downloads folder (see `downloads.rs`), not the folder the window was started from.
        .on_download(|webview, event| match event {
            DownloadEvent::Requested { destination, .. } => {
                choose_destination(webview.app_handle(), destination)
            }
            _ => true,
        })
}

/// Puts a download in the account's Downloads folder, keeping its name, or in a numbered name if that name is
/// taken. Returns false, which cancels the download, when no folder can be used; the reason goes to the log.
fn choose_destination(app: &AppHandle, destination: &mut PathBuf) -> bool {
    let folder =
        downloads::download_folder(app.path().download_dir().ok(), app.path().home_dir().ok());
    let Some(folder) = folder else {
        eprintln!("omp app: a download was not saved: the account has no home folder");
        return false;
    };
    if let Err(error) = fs::create_dir_all(&folder) {
        eprintln!(
            "omp app: a download was not saved: {}: {error}",
            folder.display()
        );
        return false;
    }
    let name = destination
        .file_name()
        .map_or_else(|| OsString::from("download"), OsStr::to_os_string);
    *destination = downloads::unique_path(&folder, &name, |path| path.exists());
    true
}

/// Shows the app in the window: the starting page becomes the server's address. Nothing happens once
/// the app is quitting.
fn open_server_page(app: &AppHandle, url: Url) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    // The app page is where the command palette opens. Without GStreamer's plugin cache, the first palette
    // open would stall while the scan runs, so the page waits here for the launch scan to finish.
    app.state::<RegistryScan>().wait(REGISTRY_SCAN_WAIT);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(WINDOW_LABEL) {
        Some(window) => {
            if let Err(error) = window.navigate(url) {
                eprintln!("omp app: the app did not open in the window: {error}");
            }
        }
        None => {
            if let Err(error) = new_window(&handle, WebviewUrl::External(url)).build() {
                // Without a window nothing can be shown: quit.
                eprintln!("omp app: the window did not open: {error}");
                handle.exit(1);
            }
        }
    });
}

/// Shows the error page in the window, or in a new window when none is open yet.
fn show_error(app: &AppHandle) {
    show_page(app, ERROR_PAGE);
}

/// Shows one of the bundled pages in the window, or in a new window when none is open yet.
fn show_page(app: &AppHandle, page: &'static str) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(WINDOW_LABEL) {
        Some(window) => {
            if let Ok(url) = Url::parse(&format!("tauri://localhost/{page}")) {
                let _ = window.navigate(url);
            }
        }
        None => {
            if let Err(error) = new_window(&handle, WebviewUrl::App(page.into())).build() {
                // Without a window nothing can be shown: quit.
                eprintln!("omp app: the page did not open: {error}");
                handle.exit(1);
            }
        }
    });
}

/// The app's own pages: the bundled pages and the local server. Everything else is a link.
fn is_app_address(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" => url.host_str() == Some("127.0.0.1"),
        // The web app saves a file (the debug log) through a blob link. The address after `blob:` is the
        // app's own page's address, so the link is the app's own.
        "blob" => Url::parse(url.path()).is_ok_and(|inner| is_app_address(&inner)),
        _ => false,
    }
}

/// Opens a web or mail link in the default app, the way a browser tab would.
fn open_externally(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    match StdCommand::new("xdg-open")
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => eprintln!("omp app: could not open a link: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_and_its_blob_links_are_app_addresses_and_other_links_are_not() {
        let is_app =
            |text: &str| is_app_address(&Url::parse(text).expect("the test address parses"));
        assert!(is_app("blob:http://127.0.0.1:27183/x"));
        assert!(!is_app("blob:https://example.com/x"));
        assert!(!is_app("http://example.com"));
    }

    /// The address the recording steps find a server at.
    const RUNNING_ADDRESS: &str = "http://127.0.0.1:27183/#token=t";

    /// What a launch's steps did, in order. The fields are the answers the steps give: whether a server already runs,
    /// and whether the server or the window fails.
    #[derive(Default)]
    struct Recorder {
        steps: Vec<String>,
        server_runs: bool,
        spawn_fails: bool,
        window_fails: bool,
    }

    impl LaunchSteps for Recorder {
        type Started = ();

        fn running(&mut self) -> Option<Url> {
            self.steps.push("running".to_owned());
            if self.server_runs {
                Some(Url::parse(RUNNING_ADDRESS).unwrap())
            } else {
                None
            }
        }

        fn spawn_server(&mut self) -> Result<(), String> {
            self.steps.push("spawn".to_owned());
            if self.spawn_fails {
                Err("the server is missing".to_owned())
            } else {
                Ok(())
            }
        }

        fn open_window(&mut self, page: &'static str) -> bool {
            self.steps.push(format!("window {page}"));
            !self.window_fails
        }

        fn open_server(&mut self, address: Url) {
            self.steps.push(format!("open {address}"));
        }

        fn watch_server(&mut self, _started: ()) {
            self.steps.push("watch".to_owned());
        }
    }

    #[test]
    fn a_server_that_already_runs_is_attached_to_and_nothing_is_started() {
        let mut recorder = Recorder {
            server_runs: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = [
            "running",
            "window starting.html",
            "open http://127.0.0.1:27183/#token=t",
        ];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn no_server_running_starts_one_before_the_window_opens_and_then_waits_for_it() {
        let mut recorder = Recorder::default();
        launch(&mut recorder);
        let expected = ["running", "spawn", "window starting.html", "watch"];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_server_that_does_not_start_shows_the_error_page_in_the_window() {
        let mut recorder = Recorder {
            spawn_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = ["running", "spawn", "window error.html"];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_window_that_does_not_open_after_attaching_starts_nothing_more() {
        let mut recorder = Recorder {
            server_runs: true,
            window_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = ["running", "window starting.html"];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_window_that_does_not_open_after_starting_a_server_watches_nothing() {
        let mut recorder = Recorder {
            window_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = ["running", "spawn", "window starting.html"];
        assert_eq!(recorder.steps, expected);
    }
}
