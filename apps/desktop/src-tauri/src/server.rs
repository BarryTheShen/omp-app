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
//!
//! The app can have several windows (see `windows.rs`). Each opens the server it was given: a window on another
//! computer's server keeps to it, and the server that ends here shows the error page in the windows on this computer's
//! server only. The first window is `main`, whose server is the one the next start restores.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webkit2gtk::{
    LoadEvent, NetworkError, PolicyError, URIResponseExt, WebResourceExt, WebViewExt,
};

use crate::address;
use crate::chat_link::{self, ChatLink};
use crate::downloads;
use crate::gstreamer::RegistryScan;
use crate::keys;
use crate::remote;
use crate::webdata;
use crate::windows;

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
/// The window's commands a page may call (see `clipboard.rs` and `commands.rs`): the pages of this computer's server and
/// of the server on another computer a window opens get them from `grant_page_commands`, by their exact origin; no other
/// page has any.
const PAGE_PERMISSIONS: [&str; 10] = [
    "allow-read-clipboard-png",
    "allow-list-clipboard-files",
    "allow-read-clipboard-file",
    "allow-servers",
    "allow-connect-server",
    "allow-open-server",
    "allow-use-this-computer",
    "allow-notify",
    "allow-new-window",
    "core:webview:allow-set-webview-zoom",
];
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
    /// Set when the app quits: nothing may open in a window or show an error after this.
    quitting: bool,
    /// The origin of the server on another computer that each window opens, by the window's label (see `remote.rs`).
    /// Its pages are that window's own, besides the bundled pages and this computer's server. A window without an
    /// entry opens this computer's server.
    remote_origins: HashMap<String, String>,
    /// The origin of this computer's server, `http://127.0.0.1:<port>`, once a window opened it (see `note_local`). Only
    /// that port is the app's: a page another program serves on this computer is a link like any other.
    local_origin: Option<String>,
    /// The origins given the page commands so far (see `grant_page_commands`).
    granted: Vec<String>,
    /// The window that had the focus last (see `windows::pick`).
    last_focused: Option<String>,
    /// The windows whose close is under way: a window is gone only once its close is through, and meanwhile it does
    /// not count as one that stays (see `window_closes`).
    closing: Vec<String>,
    /// The link the app was started with (see `chat_link.rs`), until the first window's page opens: its chat goes into
    /// that page's address when it is the link's server, and is asked of the other windows otherwise.
    launch_link: Option<ChatLink>,
}

fn with_state<T>(app: &AppHandle, change: impl FnOnce(&mut State) -> T) -> T {
    let shared = app.state::<Shared>();
    let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
    change(&mut state)
}

/// Opens the app in the window (see `launch`), with the link the app was started with, if any (see `chat_link.rs`).
/// Called once, from the app's setup, which runs on the main thread.
pub fn start(app: AppHandle, link: Option<ChatLink>) {
    with_state(&app, |state| state.launch_link = link);
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
        set_remote(&self.app, windows::MAIN, Some(&link));
        Some(link)
    }

    fn open_remote(&mut self, link: Url) {
        open_remote_page(self.app.clone(), windows::MAIN.to_owned(), link);
    }

    fn running(&mut self) -> Option<Url> {
        running_server()
    }

    fn spawn_server(&mut self) -> Result<Self::Started, String> {
        spawn(&self.app)
    }

    fn open_window(&mut self, page: &'static str) -> bool {
        match build_window(&self.app, windows::MAIN, WebviewUrl::App(page.into())) {
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
        thread::spawn(move || open_server_page(&app, windows::MAIN, address));
    }

    fn watch_server(&mut self, child: Self::Started) {
        watch(self.app.clone(), windows::MAIN.to_owned(), child);
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
pub fn kept_link() -> Option<Url> {
    remote::kept(&link_file()?)
}

/// Where the window remembers the servers on other computers it opened (see `remote::remember`).
fn servers_file() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    remote::servers_file(config.as_deref(), home.as_deref())
}

/// The servers on other computers the window opened, newest first.
pub fn remembered_servers() -> Vec<Url> {
    servers_file()
        .map(|file| remote::remembered(&file))
        .unwrap_or_default()
}

/// Keeps or forgets the link the launch's arguments name (see `remote::choice`), and remembers a kept one among the
/// servers the window opened. A `--remote` with a link of another shape, or a link that cannot be kept, is refused with
/// the reason; the link itself is never printed.
pub fn apply_choice(args: &[String]) -> Result<(), String> {
    let choice = remote::choice(args)?;
    if choice == remote::Choice::Unchanged {
        return Ok(());
    }
    let file = link_file().ok_or("the home folder was not found")?;
    let done = match choice {
        remote::Choice::Remote(link) => {
            let kept = remote::keep(&file, &link);
            // Only the list of servers to offer again: the window opens the kept link whatever becomes of it.
            if kept.is_ok() {
                remember_server(&link);
            }
            kept
        }
        _ => remote::forget(&file),
    };
    done.map_err(|error| format!("{}: {error}", file.display()))
}

/// Remembers `link` first among the servers on other computers the app opened, to offer again: the list only, not the
/// link the next start opens. A link that cannot be remembered is only logged.
fn remember_server(link: &Url) {
    let Some(list) = servers_file() else {
        return;
    };
    if let Err(error) = remote::remember(&list, link) {
        eprintln!("omp app: the server could not be remembered: {error}");
    }
}

/// As `apply_choice`, for window `label` moved by a command of its page. Only a move of `main` changes the link the
/// next start opens; a move of another window changes that window alone, and its link is only remembered, so the
/// window's server can be found again (to open another window on it).
pub fn apply_choice_for(label: &str, args: &[String]) -> Result<(), String> {
    if label == windows::MAIN {
        return apply_choice(args);
    }
    if let remote::Choice::Remote(link) = remote::choice(args)? {
        remember_server(&link);
    }
    Ok(())
}

/// A second launch lands here. `--remote <link>` or `--local` moves `main`, the window whose server the kept link
/// names: its own process has already kept or forgotten the link (see `apply_choice` in `main`), and refused a bad
/// link. `--new-window` opens another window like the one focused last, and without either the window focused last
/// comes forward (any open window when it is gone).
pub fn second_launch(app: &AppHandle, args: &[String]) {
    if let Some(link) = chat_link::find(args) {
        open_chat_link(app, &link);
        return;
    }
    let moves = matches!(remote::choice(args), Ok(choice) if choice != remote::Choice::Unchanged);
    let source = if moves {
        windows::pick(None, &open_labels(app))
    } else {
        pick_window(app)
    };
    let Some(source) = source else {
        return;
    };
    if moves {
        relaunch(app, &source, args);
    }
    if windows::asks_for_new_window(args) {
        if let Err(reason) = open_window_like(app, &source) {
            eprintln!("omp app: a new window did not open: {reason}");
        }
    } else {
        focus(app, &source);
    }
}

/// Shows what a link asks (see `chat_link.rs`): its server's window comes forward (the one focused last, if it shows
/// that server) and shows the chat; with no window on that server, a new one opens on it, at the chat. A link to a
/// server the app never opened brings nothing: the window focused last comes forward, and the refusal is logged.
fn open_chat_link(app: &AppHandle, link: &ChatLink) {
    let local = local_origin(app);
    let shows = |label: &String| {
        remote_origin_of(app, label)
            .or_else(|| local.clone())
            .is_some_and(|origin| origin == link.server)
    };
    let last = with_state(app, |state| state.last_focused.clone());
    let showing = last
        .filter(|label| app.get_webview_window(label).is_some() && shows(label))
        .or_else(|| open_labels(app).into_iter().find(|label| shows(label)));
    if let Some(label) = showing {
        focus(app, &label);
        if let (Some(chat), Some(window)) = (&link.chat, app.get_webview_window(&label)) {
            if let Err(error) = window.eval(chat_link::open_script(chat)) {
                eprintln!("omp app: the chat did not open in the window: {error}");
            }
        }
        return;
    }
    // No window shows it: this computer's server, or one on another computer whose link the app keeps.
    let here =
        running_server().filter(|address| address.origin().ascii_serialization() == link.server);
    let (address, origin) = match here {
        Some(address) => (address, None),
        None => match link_for_origin(&link.server) {
            Some(address) => (address, Some(link.server.clone())),
            None => {
                eprintln!(
                    "omp app: a link named a server this app has not opened, so nothing opened"
                );
                if let Some(label) = pick_window(app) {
                    focus(app, &label);
                }
                return;
            }
        },
    };
    let address = match &link.chat {
        Some(chat) => chat_link::address_with_chat(&address, chat),
        None => address,
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || open_window_on(&handle, &address, origin));
}

/// Moves window `label` as a launch with these arguments would: to the server on another computer a link names, or
/// back to this computer's. Without either it stays where it is.
pub fn relaunch(app: &AppHandle, label: &str, args: &[String]) {
    match remote::choice(args) {
        Ok(remote::Choice::Remote(link)) => {
            set_remote(app, label, Some(&link));
            show_page(app, label, STARTING_PAGE);
            open_remote_page(app.clone(), label.to_owned(), link);
        }
        Ok(remote::Choice::Local) => {
            set_remote(app, label, None);
            show_page(app, label, STARTING_PAGE);
            open_local(app.clone(), label.to_owned());
        }
        Ok(remote::Choice::Unchanged) | Err(_) => {}
    }
}

/// Notes which server on another computer window `label` opens, if any: its pages are then that window's own.
fn set_remote(app: &AppHandle, label: &str, link: Option<&Url>) {
    let origin = link.map(remote::origin);
    with_state(app, |state| match origin {
        Some(origin) => {
            state.remote_origins.insert(label.to_owned(), origin);
        }
        None => {
            state.remote_origins.remove(label);
        }
    });
}

/// The origin of the server on another computer that window `label` opens; None for this computer's server.
fn remote_origin_of(app: &AppHandle, label: &str) -> Option<String> {
    with_state(app, |state| state.remote_origins.get(label).cloned())
}

/// The computer's name of the server on another computer that window `label` opens; None for this computer's server.
pub fn current_server(app: &AppHandle, label: &str) -> Option<String> {
    let origin = remote_origin_of(app, label)?;
    Url::parse(&origin).ok()?.host_str().map(str::to_owned)
}

/// Opens the server on another computer in window `label`, off the main thread. Its pages may call the window's
/// commands, as this computer's server's pages may. The starting page shows until the computer accepts a connection; a
/// computer that does not shows the error page, which names it.
fn open_remote_page(app: AppHandle, label: String, link: Url) {
    thread::spawn(move || {
        grant_page_commands(&app, &remote::origin(&link));
        if remote::reachable(&link) {
            open_server_page(&app, &label, link);
        } else {
            show_remote_error(&app, &label, &remote::host(&link), None);
        }
    });
}

/// Opens the app on this computer's server in window `label`: the one that runs, or one started now (as `launch` does).
fn open_local(app: AppHandle, label: String) {
    thread::spawn(move || {
        if let Some(address) = running_server() {
            open_server_page(&app, &label, address);
            return;
        }
        match spawn(&app) {
            Ok(child) => watch(app, label, child),
            Err(problem) => {
                eprintln!("omp app: the server did not start: {problem}");
                show_error(&app);
            }
        }
    });
}

/// Notes `address`, this computer's server, before a window opens it: its origin becomes the windows' own pages on this
/// computer (see `is_app_address`) and gets the window's commands. A server started again on another port moves both.
fn note_local(app: &AppHandle, address: &Url) {
    let origin = address.origin().ascii_serialization();
    with_state(app, |state| state.local_origin = Some(origin.clone()));
    grant_page_commands(app, &origin);
}

/// The origin of this computer's server the windows open; None before one opened it.
fn local_origin(app: &AppHandle) -> Option<String> {
    with_state(app, |state| state.local_origin.clone())
}

/// Gives the window's page commands to the pages of `origin`, once per origin: this computer's server (`note_local`) or
/// a server on another computer (`open_remote_page`). No other site gets anything.
fn grant_page_commands(app: &AppHandle, origin: &str) {
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
    let mut capability = CapabilityBuilder::new(format!("server-pages-{number}"))
        .remote(format!("{origin}/*"))
        .local(false)
        .window(windows::MAIN)
        .window(windows::PATTERN);
    for permission in PAGE_PERMISSIONS {
        capability = capability.permission(permission);
    }
    if let Err(error) = app.add_capability(capability) {
        eprintln!("omp app: the server's pages could not be given the window's commands: {error}");
    }
}

/// Starts the server on the desktop port (or a free one, when it is busy), with the browser opening switched off, on
/// the chat host that ships with the app (`chat-host` beside the web app): omp's own command line, built by the app,
/// which runs every chat and answers omp's own commands. The server is detached: it has a session
/// (and so a process group) of its own, and no input or output, so nothing that happens to this process reaches it.
/// It logs to its own file and records its address itself, so its output is not needed.
fn spawn(app: &AppHandle) -> Result<Child, String> {
    let folder = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or("the home folder was not found")?;
    let paths = app.path();
    let resources = paths.resource_dir().map_err(|error| error.to_string())?;
    let ui_root = resources.join("ui");
    let chat_host = resources.join("chat-host");
    // The server would fall back to other folders if these were missing; that must not happen.
    if !ui_root.join("index.html").is_file() {
        return Err(format!("the web app is not in {}", ui_root.display()));
    }
    if !chat_host.is_file() {
        return Err(format!(
            "the app's chat host is not at {}",
            chat_host.display()
        ));
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
        .env("OMP_APP_UI_ROOT", &ui_root)
        // omp is the chat host that ships with the app, never one installed on this computer.
        .env("OMP_APP_CHAT_HOST_BIN", &chat_host)
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

/// Watches the server this app started, for as long as it runs. One thread waits for the server to end; when it does
/// and no server answers (a server that found another instance running also ends, and that instance serves the
/// windows), the error page is shown. The other thread waits for the record to name a server that answers, and opens
/// the app on it in window `label`.
fn watch(app: AppHandle, label: String, mut child: Child) {
    let ender = app.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if running_server().is_none() {
            show_error(&ender);
        }
    });
    thread::spawn(move || open_when_recorded(&app, &label));
}

/// Waits for the record to name a live server that answers, and opens the app on it in window `label`. If none does
/// within `START_TIMEOUT`, the error page is shown, and the server that was started is left alone. The server's start
/// can take a long time on a busy computer, so the window shows the starting page until it answers.
fn open_when_recorded(app: &AppHandle, label: &str) {
    let Some(record) = instance_record() else {
        show_error(app);
        return;
    };
    let found = address::wait_for_instance(&record, START_TIMEOUT);
    let url = found.and_then(|address| Url::parse(&address.url).ok());
    match url {
        Some(url) => open_server_page(app, label, url),
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

/// The labels of the windows that are open now.
fn open_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows().into_keys().collect()
}

/// The window a launch or a command that names none means (see `windows::pick`): None when no window is open.
fn pick_window(app: &AppHandle) -> Option<String> {
    let open = open_labels(app);
    let last = with_state(app, |state| state.last_focused.clone());
    windows::pick(last.as_deref(), &open)
}

/// Brings a window forward: out of the minimized state, shown, and focused.
fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The window has the focus now.
pub fn focused(app: &AppHandle, label: &str) {
    with_state(app, |state| state.last_focused = Some(label.to_owned()));
}

/// Whether the window may close alone, because another window stays open that is not itself being closed. When none
/// does, this is the last window, and its close ends the app (see `quit`). A window that may close is noted as
/// closing until it is gone (see `destroyed`).
pub fn window_closes(app: &AppHandle, label: &str) -> bool {
    let open = open_labels(app);
    with_state(app, |state| {
        let alone = windows::closes_alone(&open, &state.closing, label);
        if alone {
            state.closing.push(label.to_owned());
        }
        alone
    })
}

/// The window is gone: what the app kept for it goes too.
pub fn destroyed(app: &AppHandle, label: &str) {
    with_state(app, |state| {
        state.closing.retain(|closing| closing != label);
        state.remote_origins.remove(label);
        if state.last_focused.as_deref() == Some(label) {
            state.last_focused = None;
        }
    });
}

/// The folder of every window's web data (see `webdata.rs`), shared, so the windows share their pages' storage and the
/// key a server paired the window with. Made at the first window: it copies the pages' storage from where WebKitGTK
/// kept it before the window had a folder (the first of `webdata::earlier_folders` that holds any); a copy that fails
/// is only logged. It needs the app's identifier, so it is set from the first window's app handle.
static WEB_DATA_FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();

fn web_data_folder(app: &AppHandle) -> Option<PathBuf> {
    WEB_DATA_FOLDER
        .get_or_init(|| {
            let data_home = std::env::var_os("XDG_DATA_HOME");
            let home = std::env::var_os("HOME");
            let folder = webdata::folder(data_home.as_deref(), home.as_deref())?;
            // It holds the cookie with the key a server paired the window with: this account's alone.
            if let Err(error) = webdata::make_private(&folder) {
                eprintln!(
                    "omp app: the window's data folder {} could not be made private: {error}",
                    folder.display()
                );
            }
            let identifier = app.config().identifier.clone();
            let program = gtk::glib::prgname().map(|name| name.to_string());
            let executable = std::env::current_exe().ok().and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            });
            let names: Vec<&str> = [
                Some(identifier.as_str()),
                program.as_deref(),
                executable.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            let earlier = webdata::earlier_folders(data_home.as_deref(), home.as_deref(), &names);
            match webdata::adopt(&earlier, &folder) {
                Ok(Some(from)) => eprintln!(
                    "omp app: the pages' storage was copied from {}",
                    from.display()
                ),
                Ok(None) => {}
                Err(error) => eprintln!("omp app: the pages' storage was not copied: {error}"),
            }
            Some(folder)
        })
        .clone()
}

fn new_window<'a>(
    app: &'a AppHandle,
    label: &str,
    page: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let handle = app.clone();
    let owner = label.to_owned();
    let builder = WebviewWindowBuilder::new(app, label, page)
        .title(WINDOW_TITLE)
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |target| {
            let remote = remote_origin_of(&handle, &owner);
            let local = local_origin(&handle);
            let inside = is_app_address(target, remote.as_deref(), local.as_deref());
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
        });
    // Without a folder of its own the window still opens; its cookies then end with it.
    match web_data_folder(app) {
        Some(folder) => builder.data_directory(folder),
        None => builder,
    }
}

/// Builds one of the app's windows, named `label`, with its page loads watched (see `watch_page_loads`) and its keys
/// with Super handed to the page (see `keys.rs`).
fn build_window(app: &AppHandle, label: &str, page: WebviewUrl) -> tauri::Result<WebviewWindow> {
    let window = new_window(app, label, page).build()?;
    watch_page_loads(&window);
    keys::forward_super_keys(&window);
    Ok(window)
}

/// Opens another window on the server window `source` shows, as the New window command of its page does: this
/// computer's server, or the server on another computer that `source` opens, whose link (with its token) is looked up
/// here, since a page keeps no token in its address. The new window is the next free `window-N`, and its address
/// carries that as `?window=<label>`, which tells its page which window it is.
pub fn open_window_like(app: &AppHandle, source: &str) -> Result<(), String> {
    if with_state(app, |state| state.quitting) {
        return Err("the app is quitting".to_owned());
    }
    let origin = remote_origin_of(app, source);
    let address = match &origin {
        Some(origin) => link_for_origin(origin)
            .ok_or_else(|| format!("the address of {origin} is not kept any more"))?,
        None => running_server().ok_or("this computer's server does not answer")?,
    };
    let handle = app.clone();
    app.run_on_main_thread(move || open_window_on(&handle, &address, origin))
        .map_err(|error| error.to_string())
}

/// Builds the new window. This runs on the main thread, so two windows asked for at once get different labels.
fn open_window_on(app: &AppHandle, address: &Url, origin: Option<String>) {
    let mut taken = open_labels(app);
    with_state(app, |state| taken.extend(state.closing.iter().cloned()));
    let label = windows::next_label(&taken);
    // Known before the page loads, which `on_navigation` checks against it.
    match origin {
        Some(origin) => with_state(app, |state| {
            state.remote_origins.insert(label.clone(), origin);
        }),
        None => note_local(app, address),
    }
    let page = WebviewUrl::External(window_url(address, &label));
    match build_window(app, &label, page) {
        Ok(window) => {
            focused(app, &label);
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("omp app: the new window did not open: {error}");
            destroyed(app, &label);
        }
    }
}

/// The link of the server on another computer whose origin is `origin`, from the kept link or the servers the app
/// opened: the link carries the token its pages need.
fn link_for_origin(origin: &str) -> Option<Url> {
    kept_link()
        .into_iter()
        .chain(remembered_servers())
        .find(|link| remote::origin(link) == origin)
}

/// `address` with `?window=<label>`, which tells the page which window it is. The token stays in the fragment, and a
/// query the address has stays too.
fn window_url(address: &Url, label: &str) -> Url {
    let mut url = address.clone();
    url.query_pairs_mut().append_pair("window", label);
    url
}

/// A page of the server on another computer that does not open shows the error page, naming the computer and what went
/// wrong, instead of the engine's own text. The computer accepted the connection (see `remote::reachable`), but the page
/// did not load (a failed TLS handshake, a reset connection, a certificate that is not accepted), or what answered is not
/// the app (an error status, as `tailscale serve` answers while the app behind it is stopped). A load cancelled because
/// another page opens is no failure. Pages of this computer's server are left to the server's watch, which shows the
/// error page when the server ends (see `watch`).
fn watch_page_loads(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let watched = window.with_webview(move |webview| {
        let view = webview.inner();
        let (failed, failed_label) = (app.clone(), label.clone());
        view.connect_load_failed(move |_, _, uri, error| {
            let replaced = error.matches(NetworkError::Cancelled)
                || error.matches(PolicyError::FrameLoadInterruptedByPolicyChange);
            !replaced && remote_page_failed(&failed, &failed_label, uri, &error.to_string())
        });
        let (refused, refused_label) = (app.clone(), label.clone());
        view.connect_load_failed_with_tls_errors(move |_, uri, _, _| {
            remote_page_failed(
                &refused,
                &refused_label,
                uri,
                "its certificate was not accepted",
            )
        });
        view.connect_load_changed(move |view, event| {
            if event != LoadEvent::Committed {
                return;
            }
            let Some(response) = view.main_resource().and_then(|page| page.response()) else {
                return;
            };
            let problem = answer_problem(response.status_code());
            if let (Some(problem), Some(uri)) = (problem, response.uri()) {
                remote_page_failed(&app, &label, &uri, &problem);
            }
        });
    });
    if let Err(error) = watched {
        eprintln!("omp app: the window's page loads are not watched: {error}");
    }
}

/// Shows the error page in window `label` when `uri` is a page of the server on another computer that the window
/// opens and that did not open, and logs why. Returns whether it was one.
fn remote_page_failed(app: &AppHandle, label: &str, uri: &str, problem: &str) -> bool {
    let remote = remote_origin_of(app, label);
    let Some(host) = remote_page_host(uri, remote.as_deref()) else {
        return false;
    };
    eprintln!("omp app: the app on {host} did not open: {problem}");
    show_remote_error(app, label, &host, Some(problem));
    true
}

/// The computer to name when `uri` is a page of the server on another computer (`remote`, its origin); None for any
/// other address.
fn remote_page_host(uri: &str, remote: Option<&str>) -> Option<String> {
    let origin = remote?;
    let url = Url::parse(uri).ok()?;
    let host = url.host_str()?.to_owned();
    (url.origin().ascii_serialization() == origin).then_some(host)
}

/// What an error status of the start page says: what answered is not the app, whose start page answers with success. A
/// proxy answers so when the app behind it is stopped. None below 400.
fn answer_problem(status: u32) -> Option<String> {
    (status >= 400).then(|| format!("it answered with HTTP {status}"))
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

/// Shows the app in window `label`: the starting page becomes the server's address. Nothing happens once the app is
/// quitting, and a window that is gone while others stay open is left alone (see `open_in_a_window_if_none`).
fn open_server_page(app: &AppHandle, label: &str, url: Url) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    // This computer's server (a server on another computer is https): its port is the windows' own from now on.
    if url.scheme() == "http" {
        note_local(app, &url);
    }
    // The link the app was started with: its chat opens in this page when it is the link's server; another server's
    // chat is asked of the windows once this one is on its way (see `open_chat_link`).
    let link = with_state(app, |state| state.launch_link.take());
    let origin = url.origin().ascii_serialization();
    let (url, elsewhere) = match link {
        Some(link) if link.server == origin => match &link.chat {
            Some(chat) => (chat_link::address_with_chat(&url, chat), None),
            None => (url, None),
        },
        other => (url, other),
    };
    // The app page is where the command palette opens. Without GStreamer's plugin cache, the first palette
    // open would stall while the scan runs, so the page waits here for the launch scan to finish.
    app.state::<RegistryScan>().wait(REGISTRY_SCAN_WAIT);
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(&label) {
        Some(window) => {
            if let Err(error) = window.navigate(url) {
                eprintln!("omp app: the app did not open in the window: {error}");
            }
        }
        None => open_in_a_window_if_none(&handle, &label, WebviewUrl::External(url)),
    });
    if let Some(link) = elsewhere {
        open_chat_link(app, &link);
    }
}

/// A page for a window that is gone is dropped, and the windows that stay are not touched. With no window open at all,
/// the page opens in a new one, named `label`.
fn open_in_a_window_if_none(app: &AppHandle, label: &str, page: WebviewUrl) {
    if !app.webview_windows().is_empty() {
        return;
    }
    if let Err(error) = build_window(app, label, page) {
        // Without a window nothing can be shown: quit.
        eprintln!("omp app: the window did not open: {error}");
        app.exit(1);
    }
}

/// Shows the error page in the windows on this computer's server (the ones on another computer's server do not depend
/// on it), or in a new window when none is open yet.
fn show_error(app: &AppHandle) {
    let open = open_labels(app);
    if open.is_empty() {
        show_page(app, windows::MAIN, ERROR_PAGE);
        return;
    }
    let local: Vec<String> = with_state(app, |state| {
        open.into_iter()
            .filter(|label| !state.remote_origins.contains_key(label))
            .collect()
    });
    for label in local {
        show_page(app, &label, ERROR_PAGE);
    }
}

/// Shows one of the bundled pages in window `label`, or in a new window when none is open yet.
fn show_page(app: &AppHandle, label: &str, page: &'static str) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(&label) {
        Some(window) => {
            if let Ok(url) = Url::parse(&format!("tauri://localhost/{page}")) {
                let _ = window.navigate(url);
            }
        }
        None => open_in_a_window_if_none(&handle, &label, WebviewUrl::App(page.into())),
    });
}

/// Shows the page for "the server on another computer did not open", naming the computer, in window `label`: it did
/// not answer, or it answered and the page did not open, for `problem` (see `watch_page_loads`).
fn show_remote_error(app: &AppHandle, label: &str, host: &str, problem: Option<&str>) {
    if with_state(app, |state| state.quitting) {
        return;
    }
    let Ok(mut url) = Url::parse(&format!("tauri://localhost/{REMOTE_ERROR_PAGE}")) else {
        return;
    };
    url.query_pairs_mut().append_pair("host", host);
    if let Some(problem) = problem {
        url.query_pairs_mut().append_pair("problem", problem);
    }
    let handle = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || match handle.get_webview_window(&label) {
        Some(window) => {
            let _ = window.navigate(url);
        }
        None => {
            open_in_a_window_if_none(&handle, &label, WebviewUrl::App(REMOTE_ERROR_PAGE.into()))
        }
    });
}

/// The app's own pages: the bundled pages, this computer's server (`local`, its origin `http://127.0.0.1:<port>`), and
/// the server on another computer the window opens (`remote`, its origin). Everything else is a link, also a page that
/// another program serves on this computer.
fn is_app_address(url: &Url, remote: Option<&str>, local: Option<&str>) -> bool {
    let origin = url.origin().ascii_serialization();
    match url.scheme() {
        "tauri" | "about" => true,
        "http" => local.is_some_and(|local| origin == local),
        "https" => remote.is_some_and(|remote| origin == remote),
        // The web app saves a file (the debug log) through a blob link. The address after `blob:` is the
        // app's own page's address, so the link is the app's own.
        "blob" => Url::parse(url.path()).is_ok_and(|inner| is_app_address(&inner, remote, local)),
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
    fn this_computers_server_and_its_blob_links_are_app_addresses_and_other_pages_here_are_not() {
        let local = Some("http://127.0.0.1:27183");
        let is_app = |text: &str| is_app_address(&url(text), None, local);
        assert!(is_app("http://127.0.0.1:27183/?folder=a#token=t"));
        assert!(is_app("blob:http://127.0.0.1:27183/x"));
        assert!(
            !is_app("http://127.0.0.1:8080/"),
            "a page another program serves on this computer"
        );
        assert!(!is_app("blob:http://127.0.0.1:8080/x"));
        assert!(
            !is_app("http://localhost:27183/"),
            "the same port by another name"
        );
        assert!(!is_app("blob:https://example.com/x"));
        assert!(!is_app("http://example.com"));
        let page = url("http://127.0.0.1:27183/");
        assert!(
            !is_app_address(&page, None, None),
            "before a window opened this computer's server"
        );
    }

    #[test]
    fn the_kept_servers_pages_are_app_addresses_and_other_sites_are_not() {
        let remote = Some("https://devbox.tail1234.ts.net");
        let page = url("https://devbox.tail1234.ts.net/x");
        assert!(is_app_address(&page, remote, None));
        assert!(
            !is_app_address(&page, None, None),
            "only while the link is kept"
        );
        let blob = url("blob:https://devbox.tail1234.ts.net/x");
        assert!(is_app_address(&blob, remote, None));
        let other = url("https://example.com/");
        assert!(!is_app_address(&other, remote, None));
        let plain = url("http://devbox.tail1234.ts.net/x");
        assert!(!is_app_address(&plain, remote, None));
    }

    #[test]
    fn a_failed_page_of_the_kept_server_names_its_computer_and_other_pages_do_not() {
        let remote = Some("https://devbox.tail1234.ts.net");
        let page = "https://devbox.tail1234.ts.net/#token=t";
        let named = remote_page_host(page, remote);
        assert_eq!(named.as_deref(), Some("devbox.tail1234.ts.net"));
        assert_eq!(
            remote_page_host(page, None),
            None,
            "only while a link is kept"
        );
        let local = "http://127.0.0.1:4317/#token=t";
        let watched = remote_page_host(local, remote);
        assert_eq!(watched, None, "this computer's server has its own watch");
        assert_eq!(remote_page_host("https://example.com/", remote), None);
        assert_eq!(remote_page_host("not a link", remote), None);
    }

    #[test]
    fn only_an_error_status_means_what_answered_is_not_the_app() {
        assert_eq!(answer_problem(200), None);
        assert_eq!(answer_problem(304), None);
        assert_eq!(answer_problem(399), None);
        let proxy = answer_problem(502);
        assert_eq!(proxy.as_deref(), Some("it answered with HTTP 502"));
        assert!(answer_problem(404).is_some());
    }

    #[test]
    fn a_new_windows_address_names_the_window_and_keeps_the_token_and_the_query() {
        let plain = window_url(&url("http://127.0.0.1:4317/#token=t"), "window-2");
        assert_eq!(
            plain.as_str(),
            "http://127.0.0.1:4317/?window=window-2#token=t"
        );
        let remote = window_url(&url("https://devbox.tail1234.ts.net/#token=t"), "window-3");
        assert_eq!(
            remote.as_str(),
            "https://devbox.tail1234.ts.net/?window=window-3#token=t"
        );
        let with_query = window_url(&url("http://127.0.0.1:4317/?folder=a#token=t"), "window-2");
        assert_eq!(
            with_query.as_str(),
            "http://127.0.0.1:4317/?folder=a&window=window-2#token=t"
        );
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
