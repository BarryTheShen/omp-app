//! The bundled server: starts it, waits until it answers, opens the app in the window, and stops it,
//! with everything it started, when the app quits or the server ends on its own.
//!
//! The server is started on the main thread, because the kernel's death signal is tied to the thread
//! that starts a process (see `spawn`). When the quick lookup finds omp, the server starts before the
//! window is built, so the two starts overlap, and the window then opens on a starting page. Otherwise
//! the window opens first, and the login shell is asked on a helper thread (see `launch`). So if this
//! window process dies, even from SIGKILL, the kernel sends the server SIGTERM, and the server ends the
//! omp processes it started before it exits. `procs.rs` ends whatever is left after a quit. The server's
//! address is fixed (see `DESKTOP_PORT`), so the web app keeps its stored settings from one launch to
//! the next.
//!
//! Each start has a few threads: one reads the server's output for its address and for "already
//! running", one drains its error output (never shown or logged: it can hold the launch token), one
//! waits for the server to end and decides what the window shows, and one waits for the address and
//! then for the server to answer, before it opens the app in the window.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::address::{self, LaunchAddress};
use crate::downloads;
use crate::gstreamer::RegistryScan;
use crate::omp;
use crate::procs::{self, Proc};
use crate::WINDOW_LABEL;

/// The sidecar's file name: the bundler installs it next to the window binary under this name.
const SIDECAR: &str = "omp-app-desktop-server";
/// The port the server is asked for. Fixed, so the window's address, and with it the web app's stored
/// settings, is the same at every launch. It is below the system's ephemeral ports and is not the
/// omp-app command's 4317. If it is busy, the server picks a free port itself, as it does for the command.
const DESKTOP_PORT: &str = "27183";
/// The page shown at once, while the server starts, served from apps/desktop/ui.
const STARTING_PAGE: &str = "starting.html";
/// The page for "the app could not start", served from apps/desktop/ui.
const ERROR_PAGE: &str = "error.html";
/// The page for "omp is not installed", served from apps/desktop/ui.
const NO_OMP_PAGE: &str = "no-omp.html";
const WINDOW_TITLE: &str = "omp app";
/// How long the server has to print its address, and then to answer.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a stopping server gets to end the omp processes it started by itself.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// How long the processes that are left get after SIGTERM before SIGKILL.
const KILL_WAIT: Duration = Duration::from_secs(2);
/// How long the app page waits for the launch scan of GStreamer's plugin cache (see `gstreamer.rs`).
const REGISTRY_SCAN_WAIT: Duration = Duration::from_secs(60);

/// What the threads share. Only ever locked for a moment; never held while stopping a server.
#[derive(Default)]
pub struct Shared {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Set when the app quits: nothing may start after this, and no error is shown.
    quitting: bool,
    /// The server this app started, until it is stopped or it turns out to be another instance's.
    server: Option<Server>,
}

/// One server this app started. Its process group id is its pid.
struct Server {
    /// The server's identity (pid and start time). None if it had already ended when checked.
    leader: Option<Proc>,
}

impl Server {
    /// Ends the server and every process it started, and reports any that would not end.
    fn stop(self) {
        let Some(leader) = self.leader else {
            return;
        };
        let left = procs::stop_tree(leader, STOP_GRACE, KILL_WAIT);
        if !left.is_empty() {
            let pids: Vec<i32> = left.iter().map(|process| process.pid).collect();
            eprintln!("omp app: {} process(es) did not stop: {pids:?}", pids.len());
        }
    }
}

fn with_state<T>(app: &AppHandle, change: impl FnOnce(&mut State) -> T) -> T {
    let shared = app.state::<Shared>();
    let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
    change(&mut state)
}

/// Opens the app: the window, and the server (see `launch`). Called once, from the app's setup, which runs on the main
/// thread.
pub fn start(app: AppHandle) {
    // An OMP_BIN the user set is used as it is: the server inherits it, and no lookup runs.
    let user_set = std::env::var_os("OMP_BIN").is_some_and(|value| !value.is_empty());
    launch(&mut AppSteps { app }, user_set);
}

/// The steps a launch runs, in order. `AppSteps` runs them on the app; the tests run the same order on recording steps.
trait LaunchSteps {
    /// A server that has started, until it is adopted or discarded.
    type Started;
    /// The omp the quick lookup finds (see `omp::quick_from_environment`). Starts no process.
    fn quick_omp(&mut self) -> Option<PathBuf>;
    /// Whether the app is quitting.
    fn quitting(&self) -> bool;
    /// Starts the server with the omp given, or with the server's own search when there is none (see `spawn`).
    fn spawn_server(&mut self, omp: Option<&Path>) -> Result<Self::Started, String>;
    /// Builds the window on `page`. False when the window cannot open; the app is then asked to exit.
    fn open_window(&mut self, page: &'static str) -> bool;
    /// Keeps a started server, and watches it until it ends.
    fn adopt(&mut self, started: Self::Started);
    /// Stops a started server that the app does not keep.
    fn discard(&mut self, started: Self::Started);
    /// Shows one of the bundled pages in the window.
    fn show(&mut self, page: &'static str);
    /// Asks the login shell for omp on a helper thread. The answer comes back to `on_lookup` on the main thread.
    fn look_up_in_background(&mut self);
}

/// Opens the window and starts the server. When the quick lookup finds omp, the server starts on this thread before the
/// window is built, so the two starts overlap (plan S2): the window then opens on the starting page, or on the error page
/// when the server did not start. Otherwise the window opens at once on the starting page, and the login shell is asked in
/// the background (see `on_lookup`).
fn launch<S: LaunchSteps>(steps: &mut S, user_set: bool) {
    let early = if user_set {
        Some(None)
    } else {
        steps.quick_omp().map(Some)
    };
    let Some(omp) = early else {
        if steps.open_window(STARTING_PAGE) {
            steps.look_up_in_background();
        }
        return;
    };
    match steps.spawn_server(omp.as_deref()) {
        Ok(started) => {
            // The window opens before the server is watched: a page shown by the watch would find no window yet.
            if steps.open_window(STARTING_PAGE) {
                steps.adopt(started);
            } else {
                steps.discard(started);
            }
        }
        Err(problem) => {
            eprintln!("omp app: the server did not start: {problem}");
            steps.open_window(ERROR_PAGE);
        }
    }
}

/// The login shell's answer, on the main thread: the server starts with the omp it found, or the no-omp page shows.
fn on_lookup<S: LaunchSteps>(steps: &mut S, omp: Option<PathBuf>) {
    let Some(omp) = omp else {
        // A quit cancels the lookup, which then finds nothing: there is no page to show then.
        if !steps.quitting() {
            eprintln!("omp app: omp was not found on this computer");
            steps.show(NO_OMP_PAGE);
        }
        return;
    };
    start_server(steps, &omp);
}

/// Starts the server once the window is open, for the omp the login shell found. A quit that came first starts nothing.
fn start_server<S: LaunchSteps>(steps: &mut S, omp: &Path) {
    if steps.quitting() {
        return;
    }
    match steps.spawn_server(Some(omp)) {
        Ok(started) => steps.adopt(started),
        Err(problem) => {
            eprintln!("omp app: the server did not start: {problem}");
            steps.show(ERROR_PAGE);
        }
    }
}

/// The app's own steps: the window and the server, on the app's handle.
struct AppSteps {
    app: AppHandle,
}

impl LaunchSteps for AppSteps {
    type Started = (Child, Option<Proc>);

    fn quick_omp(&mut self) -> Option<PathBuf> {
        // The window finds omp itself (see omp.rs), because a window started from the applications menu does not have
        // the user's PATH.
        omp::quick_from_environment()
    }

    fn quitting(&self) -> bool {
        with_state(&self.app, |state| state.quitting)
    }

    fn spawn_server(&mut self, omp: Option<&Path>) -> Result<Self::Started, String> {
        spawn(&self.app, omp)
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

    fn adopt(&mut self, (child, leader): Self::Started) {
        // A quit may have come while the server was being spawned: it must not outlive the app.
        let rejected = with_state(&self.app, |state| {
            let server = Server { leader };
            if state.quitting {
                Some(server)
            } else {
                state.server = Some(server);
                None
            }
        });
        match rejected {
            Some(server) => server.stop(),
            None => watch(self.app.clone(), child),
        }
    }

    fn discard(&mut self, (_child, leader): Self::Started) {
        Server { leader }.stop();
    }

    fn show(&mut self, page: &'static str) {
        show_page(&self.app, page);
    }

    fn look_up_in_background(&mut self) {
        let helper_app = self.app.clone();
        thread::spawn(move || {
            // The whole search: the quick folders again (omp may have appeared since), then the login shell.
            let omp = omp::from_environment();
            let start_app = helper_app.clone();
            let _ = helper_app.run_on_main_thread(move || {
                on_lookup(&mut AppSteps { app: start_app }, omp);
            });
        });
    }
}

/// Starts the server on the desktop port (or a free one, when it is busy), with the browser opening
/// switched off. The server gets the kernel's death signal (SIGTERM when this process dies, even from
/// SIGKILL) and its own process group, so every process it starts stays in that group. `omp` is the
/// omp to use, if the window found one.
fn spawn(app: &AppHandle, omp: Option<&Path>) -> Result<(Child, Option<Proc>), String> {
    let folder = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or("the home folder was not found")?;
    let web_root = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("web");
    // The server would fall back to other folders if this one were missing; that must not happen.
    if !web_root.join("index.html").is_file() {
        return Err(format!("the web app is not in {}", web_root.display()));
    }
    let sidecar = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("the app's folder was not found")?
        .join(SIDECAR);
    // This process's pid. The server must still have it as its parent once the death signal is set;
    // if it does not, this process died first, and the server must not start.
    let parent = libc::pid_t::try_from(std::process::id()).map_err(|error| error.to_string())?;
    let mut command = StdCommand::new(&sidecar);
    command
        .args([folder.as_os_str(), OsStr::new("--no-open")])
        .current_dir(&folder)
        .env("OMP_APP_WEB_ROOT", &web_root)
        // The server takes this port when it is free, and otherwise a free port (see DESKTOP_PORT).
        .env("OMP_APP_PORT", DESKTOP_PORT)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(omp) = omp {
        command.env("OMP_BIN", omp);
    }
    // SAFETY: the closure runs in the child between fork and exec. It makes two system calls and
    // allocates nothing, which is all that is allowed at that point.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    let leader = procs::identify(child.id());
    Ok((child, leader))
}

/// Watches the server until it ends: its output, its error output, and the end itself.
fn watch(app: AppHandle, mut child: Child) {
    let attached = Arc::new(AtomicBool::new(false));
    let (found_tx, found_rx) = mpsc::channel();
    let stdout = child.stdout.take();
    let reader_attached = Arc::clone(&attached);
    let reader = thread::spawn(move || read_output(stdout, found_tx, &reader_attached));
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || drain(stderr));
    }
    let ender_app = app.clone();
    thread::spawn(move || {
        let _ = child.wait();
        // The end is decided only after the output is read: an "already running" line may be the last.
        let _ = reader.join();
        if attached.load(Ordering::SeqCst) {
            // Another instance serves the window, so this server was not started for the app to keep:
            // forget it. A later quit must not sweep a process group whose id may have been reused.
            with_state(&ender_app, |state| state.server.take());
        } else {
            // The server ended on its own (a quit has already taken it). The omp processes it left
            // behind are still in its process group: end them, then say so.
            stop_server(&ender_app);
            show_error(&ender_app);
        }
    });
    thread::spawn(move || open_when_answering(app, found_rx));
}

/// Reads the server's output until it ends. The first launch address goes to the thread that waits
/// for it. A server that found another instance running says so before it ends.
fn read_output(
    stdout: Option<ChildStdout>,
    found: mpsc::Sender<LaunchAddress>,
    attached: &AtomicBool,
) {
    let Some(stdout) = stdout else {
        return;
    };
    let mut lines = BufReader::new(stdout);
    let mut found = Some(found);
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // The text is never logged: it can hold the launch token.
        let text = String::from_utf8_lossy(&line);
        if address::says_already_running(&text) {
            attached.store(true, Ordering::SeqCst);
        }
        if let Some(launch) = address::find(&text) {
            if let Some(sender) = found.take() {
                let _ = sender.send(launch);
            }
        }
    }
}

/// Reads the server's error output to its end, so that the server never blocks on it. Never shown or
/// logged: it can hold the launch token.
fn drain(mut stderr: ChildStderr) {
    let _ = io::copy(&mut stderr, &mut io::sink());
}

/// Waits for the server's address and then for the server to answer, and opens the app in the window.
/// If either never comes, the server is stopped and the error page is shown. The server's start can
/// take a long time on a busy computer, so the window shows the starting page until it answers.
fn open_when_answering(app: AppHandle, found: mpsc::Receiver<LaunchAddress>) {
    let answered = match found.recv_timeout(START_TIMEOUT) {
        Ok(launch) => address::wait_for_answer(launch.port, START_TIMEOUT).then_some(launch.url),
        Err(_) => None,
    };
    match answered.and_then(|url| Url::parse(&url).ok()) {
        Some(url) => open_server_page(&app, url),
        None => {
            stop_server(&app);
            show_error(&app);
        }
    }
}

/// Stops the server this app started, if it is still known. Taking it out of the state means it is
/// stopped once, whichever thread gets there first.
fn stop_server(app: &AppHandle) {
    if let Some(server) = with_state(app, |state| state.server.take()) {
        server.stop();
    }
}

/// The app is quitting: stops the server and everything it started.
pub fn stop(app: &AppHandle) {
    let server = with_state(app, |state| {
        state.quitting = true;
        state.server.take()
    });
    // A login-shell lookup still running is ended with its group, so nothing it started outlives the app.
    omp::cancel_lookup();
    if let Some(server) = server {
        server.stop();
    }
}

/// The window was closed: the app ends once the server and what it started are stopped. This runs on
/// its own thread, so the window (already hidden) and the event loop are not held up meanwhile.
pub fn quit(app: AppHandle) {
    thread::spawn(move || {
        stop(&app);
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
                // Without a window nothing can be shown: quit, and the exit stops the server.
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
                // Without a window nothing can be shown: quit, and the exit stops the server.
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

    /// What a launch's steps did, in order. The fields are the answers the steps give: the quick lookup's omp, whether the app
    /// is quitting, and whether the server or the window fails.
    #[derive(Default)]
    struct Recorder {
        steps: Vec<String>,
        quick: Option<PathBuf>,
        quitting: bool,
        spawn_fails: bool,
        window_fails: bool,
    }

    impl Recorder {
        fn finding(omp: &str) -> Self {
            Recorder {
                quick: Some(PathBuf::from(omp)),
                ..Recorder::default()
            }
        }
    }

    impl LaunchSteps for Recorder {
        type Started = String;

        fn quick_omp(&mut self) -> Option<PathBuf> {
            self.steps.push("quick".to_owned());
            self.quick.clone()
        }

        fn quitting(&self) -> bool {
            self.quitting
        }

        fn spawn_server(&mut self, omp: Option<&Path>) -> Result<String, String> {
            let omp = omp.map_or_else(
                || "the server's own".to_owned(),
                |path| path.display().to_string(),
            );
            self.steps.push(format!("spawn {omp}"));
            if self.spawn_fails {
                Err("the server is missing".to_owned())
            } else {
                Ok(omp)
            }
        }

        fn open_window(&mut self, page: &'static str) -> bool {
            self.steps.push(format!("window {page}"));
            !self.window_fails
        }

        fn adopt(&mut self, started: String) {
            self.steps.push(format!("adopt {started}"));
        }

        fn discard(&mut self, started: String) {
            self.steps.push(format!("discard {started}"));
        }

        fn show(&mut self, page: &'static str) {
            self.steps.push(format!("show {page}"));
        }

        fn look_up_in_background(&mut self) {
            self.steps.push("look up".to_owned());
        }
    }

    fn lines(expected: &[&str]) -> Vec<String> {
        expected.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn a_quick_find_starts_the_server_before_the_window_opens() {
        let mut recorder = Recorder::finding("/home/me/.bun/bin/omp");
        launch(&mut recorder, false);
        assert_eq!(
            recorder.steps,
            lines(&[
                "quick",
                "spawn /home/me/.bun/bin/omp",
                "window starting.html",
                "adopt /home/me/.bun/bin/omp",
            ])
        );
    }

    #[test]
    fn without_a_quick_find_the_window_opens_first_and_asks_the_login_shell_later() {
        let mut recorder = Recorder::default();
        launch(&mut recorder, false);
        assert_eq!(
            recorder.steps,
            lines(&["quick", "window starting.html", "look up"])
        );
    }

    #[test]
    fn an_omp_bin_the_user_set_starts_the_server_before_the_window_and_looks_for_nothing() {
        let mut recorder = Recorder::finding("/home/me/.bun/bin/omp");
        launch(&mut recorder, true);
        assert_eq!(
            recorder.steps,
            lines(&[
                "spawn the server's own",
                "window starting.html",
                "adopt the server's own",
            ])
        );
    }

    #[test]
    fn a_login_shell_answer_starts_the_server_on_the_main_thread_and_watches_it() {
        let mut recorder = Recorder::default();
        launch(&mut recorder, false);
        recorder.steps.clear();
        on_lookup(
            &mut recorder,
            Some(PathBuf::from("/home/me/.local/bin/omp")),
        );
        assert_eq!(
            recorder.steps,
            lines(&[
                "spawn /home/me/.local/bin/omp",
                "adopt /home/me/.local/bin/omp"
            ])
        );
    }

    #[test]
    fn no_omp_anywhere_shows_the_no_omp_page_in_the_window() {
        let mut recorder = Recorder::default();
        launch(&mut recorder, false);
        recorder.steps.clear();
        on_lookup(&mut recorder, None);
        assert_eq!(recorder.steps, lines(&["show no-omp.html"]));
    }

    #[test]
    fn a_quit_before_the_login_shell_answers_starts_nothing_and_shows_nothing() {
        let mut recorder = Recorder {
            quitting: true,
            ..Recorder::default()
        };
        on_lookup(
            &mut recorder,
            Some(PathBuf::from("/home/me/.local/bin/omp")),
        );
        on_lookup(&mut recorder, None);
        assert_eq!(recorder.steps, Vec::<String>::new());
    }

    #[test]
    fn a_server_that_does_not_start_before_the_window_shows_the_error_page_in_it() {
        let mut recorder = Recorder {
            spawn_fails: true,
            ..Recorder::finding("/home/me/.bun/bin/omp")
        };
        launch(&mut recorder, false);
        assert_eq!(
            recorder.steps,
            lines(&["quick", "spawn /home/me/.bun/bin/omp", "window error.html"])
        );
    }

    #[test]
    fn a_login_shell_omp_whose_server_does_not_start_shows_the_error_page() {
        let mut recorder = Recorder {
            spawn_fails: true,
            ..Recorder::default()
        };
        launch(&mut recorder, false);
        recorder.steps.clear();
        on_lookup(
            &mut recorder,
            Some(PathBuf::from("/home/me/.local/bin/omp")),
        );
        assert_eq!(
            recorder.steps,
            lines(&["spawn /home/me/.local/bin/omp", "show error.html"])
        );
    }

    #[test]
    fn a_window_that_does_not_open_discards_the_server_it_started() {
        let mut recorder = Recorder {
            window_fails: true,
            ..Recorder::finding("/home/me/.bun/bin/omp")
        };
        launch(&mut recorder, false);
        assert_eq!(
            recorder.steps,
            lines(&[
                "quick",
                "spawn /home/me/.bun/bin/omp",
                "window starting.html",
                "discard /home/me/.bun/bin/omp",
            ])
        );
    }
}
