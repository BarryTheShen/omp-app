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
//!
//! A window that keeps the link of a server on another computer (see `remote.rs`) opens that server instead, and
//! starts, attaches to and watches nothing on this computer.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::address;
use crate::downloads;
use crate::gstreamer::RegistryScan;
use crate::remote;
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
/// The page for "the server on another computer did not answer", served from apps/desktop/ui.
const REMOTE_ERROR_PAGE: &str = "remote-error.html";
/// The window's one command a page may call (see `clipboard.rs` and `capabilities/default.json`).
const CLIPBOARD_PERMISSION: &str = "allow-read-clipboard-png";
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
    /// The origin of the server on another computer that the window opens (see `remote.rs`). Its pages are the
    /// window's own, besides the bundled pages and this computer's server.
    remote_origin: Option<String>,
    /// The origins given the clipboard command so far (see `grant_clipboard`).
    granted: Vec<String>,
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
    /// The link of the server on another computer that the window keeps, if it keeps one (see `remote.rs`).
    fn remote(&mut self) -> Option<Url>;
    /// Opens the app in the window on the server on another computer (see `open_remote_page`).
    fn open_remote(&mut self, link: Url);
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

/// Opens the server on another computer when the window keeps its link: nothing on this computer is looked for or
/// started then. Otherwise attaches to the server that already runs, or starts one. A server that runs is attached to
/// before anything starts: the window opens on the starting page and then on its address. Otherwise the server starts
/// on this thread before the window is built, so the two starts overlap (plan S2): the window then opens on the
/// starting page, or on the error page when the server did not start. A window that cannot open asks the app to exit
/// and nothing more starts.
fn launch<S: LaunchSteps>(steps: &mut S) {
    if let Some(link) = steps.remote() {
        if steps.open_window(STARTING_PAGE) {
            steps.open_remote(link);
        }
        return;
    }
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

    fn remote(&mut self) -> Option<Url> {
        let link = kept_link()?;
        set_remote(&self.app, Some(&link));
        Some(link)
    }

    fn open_remote(&mut self, link: Url) {
        open_remote_page(self.app.clone(), link);
    }

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

/// Where the window keeps the link of a server on another computer, by the variables the config folder follows.
fn link_file() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    remote::link_file(config.as_deref(), home.as_deref())
}

/// The link of a server on another computer that the window keeps, if any.
fn kept_link() -> Option<Url> {
    remote::kept(&link_file()?)
}

/// Keeps or forgets the link the launch's arguments name (see `remote::choice`). A `--remote` with a link of another
/// shape, or a link that cannot be kept, is refused with the reason; the link itself is never printed.
pub fn apply_choice(args: &[String]) -> Result<(), String> {
    let choice = remote::choice(args)?;
    if choice == remote::Choice::Unchanged {
        return Ok(());
    }
    let file = link_file().ok_or("the home folder was not found")?;
    let done = match choice {
        remote::Choice::Remote(link) => remote::keep(&file, &link),
        _ => remote::forget(&file),
    };
    done.map_err(|error| format!("{}: {error}", file.display()))
}

/// A second launch with `--remote <link>` or `--local` moves the open window to that server. Its own process has
/// already kept or forgotten the link (see `apply_choice` in `main`), and refused a bad link; without either, the
/// window only comes forward.
pub fn relaunch(app: &AppHandle, args: &[String]) {
    match remote::choice(args) {
        Ok(remote::Choice::Remote(link)) => {
            set_remote(app, Some(&link));
            show_page(app, STARTING_PAGE);
            open_remote_page(app.clone(), link);
        }
        Ok(remote::Choice::Local) => {
            set_remote(app, None);
            show_page(app, STARTING_PAGE);
            open_local(app.clone());
        }
        Ok(remote::Choice::Unchanged) | Err(_) => {}
    }
}

/// Notes which server on another computer the window opens, if any: its pages are then the window's own.
fn set_remote(app: &AppHandle, link: Option<&Url>) {
    let origin = link.map(remote::origin);
    with_state(app, |state| state.remote_origin = origin);
}

/// Opens the server on another computer, off the main thread. Its pages may read the clipboard's picture, as this
/// computer's server's pages may. The starting page shows until the computer accepts a connection; a computer that
/// does not shows the error page, which names it.
fn open_remote_page(app: AppHandle, link: Url) {
    thread::spawn(move || {
        grant_clipboard(&app, &remote::origin(&link));
        if remote::reachable(&link) {
            open_server_page(&app, link);
        } else {
            show_remote_error(&app, &remote::host(&link));
        }
    });
}

/// Opens the app on this computer's server: the one that runs, or one started now (as `launch` does).
fn open_local(app: AppHandle) {
    thread::spawn(move || {
        if let Some(address) = running_server() {
            open_server_page(&app, address);
            return;
        }
        match spawn(&app) {
            Ok(child) => watch(app, child),
            Err(problem) => {
                eprintln!("omp app: the server did not start: {problem}");
                show_error(&app);
            }
        }
    });
}

/// Gives the clipboard command to the pages of `origin` in the window, once per origin. No other site gets anything
/// (this computer's server has it from `capabilities/default.json`).
fn grant_clipboard(app: &AppHandle, origin: &str) {
    let number = with_state(app, |state| {
        if state.granted.iter().any(|granted| granted == origin) {
            return None;
        }
        state.granted.push(origin.to_owned());
        Some(state.granted.len())
    });
    let Some(number) = number else {
        return;
    };
    let capability = CapabilityBuilder::new(format!("remote-server-{number}"))
        .remote(format!("{origin}/*"))
        .local(false)
        .window(WINDOW_LABEL)
        .permission(CLIPBOARD_PERMISSION);
    if let Err(error) = app.add_capability(capability) {
        eprintln!("omp app: the server's pages could not be given the clipboard: {error}");
    }
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
    let handle = app.clone();
    WebviewWindowBuilder::new(app, WINDOW_LABEL, page)
        .title(WINDOW_TITLE)
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |target| {
            let remote = with_state(&handle, |state| state.remote_origin.clone());
            let inside = is_app_address(target, remote.as_deref());
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

/// Shows the page for "the server on another computer did not answer", naming the computer.
fn show_remote_error(app: &AppHandle, host: &str) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    let Ok(mut url) = Url::parse(&format!("tauri://localhost/{REMOTE_ERROR_PAGE}")) else {
        return;
    };
    url.query_pairs_mut().append_pair("host", host);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(WINDOW_LABEL) {
        Some(window) => {
            let _ = window.navigate(url);
        }
        None => {
            let page = WebviewUrl::App(REMOTE_ERROR_PAGE.into());
            if let Err(error) = new_window(&handle, page).build() {
                // Without a window nothing can be shown: quit.
                eprintln!("omp app: the page did not open: {error}");
                handle.exit(1);
            }
        }
    });
}

/// The app's own pages: the bundled pages, this computer's server, and the server on another computer the window
/// opens (`remote`, its origin). Everything else is a link.
fn is_app_address(url: &Url, remote: Option<&str>) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" => url.host_str() == Some("127.0.0.1"),
        "https" => remote.is_some_and(|origin| url.origin().ascii_serialization() == origin),
        // The web app saves a file (the debug log) through a blob link. The address after `blob:` is the
        // app's own page's address, so the link is the app's own.
        "blob" => Url::parse(url.path()).is_ok_and(|inner| is_app_address(&inner, remote)),
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

    fn url(text: &str) -> Url {
        Url::parse(text).expect("the test address parses")
    }

    #[test]
    fn the_app_and_its_blob_links_are_app_addresses_and_other_links_are_not() {
        let is_app = |text: &str| is_app_address(&url(text), None);
        assert!(is_app("blob:http://127.0.0.1:27183/x"));
        assert!(!is_app("blob:https://example.com/x"));
        assert!(!is_app("http://example.com"));
    }

    #[test]
    fn the_kept_servers_pages_are_app_addresses_and_other_sites_are_not() {
        let remote = Some("https://devbox.tail1234.ts.net");
        let page = url("https://devbox.tail1234.ts.net/x");
        assert!(is_app_address(&page, remote));
        assert!(!is_app_address(&page, None), "only while the link is kept");
        let blob = url("blob:https://devbox.tail1234.ts.net/x");
        assert!(is_app_address(&blob, remote));
        let other = url("https://example.com/");
        assert!(!is_app_address(&other, remote));
        let plain = url("http://devbox.tail1234.ts.net/x");
        assert!(!is_app_address(&plain, remote));
    }

    /// The address the recording steps find a server at.
    const RUNNING_ADDRESS: &str = "http://127.0.0.1:27183/#token=t";
    /// The link the recording steps keep, when they keep one.
    const REMOTE_LINK: &str = "https://devbox.tail1234.ts.net/#token=t";

    /// What a launch's steps did, in order. The fields are the answers the steps give: whether a link is kept, whether a
    /// server already runs, and whether the server or the window fails.
    #[derive(Default)]
    struct Recorder {
        steps: Vec<String>,
        remote_kept: bool,
        server_runs: bool,
        spawn_fails: bool,
        window_fails: bool,
    }

    impl LaunchSteps for Recorder {
        type Started = ();

        fn remote(&mut self) -> Option<Url> {
            self.steps.push("remote".to_owned());
            if self.remote_kept {
                Some(url(REMOTE_LINK))
            } else {
                None
            }
        }

        fn open_remote(&mut self, link: Url) {
            self.steps.push(format!("open remote {link}"));
        }

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
    fn a_kept_link_opens_that_server_and_nothing_on_this_computer_is_looked_for() {
        let mut recorder = Recorder {
            remote_kept: true,
            server_runs: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = [
            "remote",
            "window starting.html",
            "open remote https://devbox.tail1234.ts.net/#token=t",
        ];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_window_that_does_not_open_for_a_kept_link_opens_nothing() {
        let mut recorder = Recorder {
            remote_kept: true,
            window_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        assert_eq!(recorder.steps, ["remote", "window starting.html"]);
    }

    #[test]
    fn a_server_that_already_runs_is_attached_to_and_nothing_is_started() {
        let mut recorder = Recorder {
            server_runs: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = [
            "remote",
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
        let expected = [
            "remote",
            "running",
            "spawn",
            "window starting.html",
            "watch",
        ];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_server_that_does_not_start_shows_the_error_page_in_the_window() {
        let mut recorder = Recorder {
            spawn_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = ["remote", "running", "spawn", "window error.html"];
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
        let expected = ["remote", "running", "window starting.html"];
        assert_eq!(recorder.steps, expected);
    }

    #[test]
    fn a_window_that_does_not_open_after_starting_a_server_watches_nothing() {
        let mut recorder = Recorder {
            window_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder);
        let expected = ["remote", "running", "spawn", "window starting.html"];
        assert_eq!(recorder.steps, expected);
    }
}
