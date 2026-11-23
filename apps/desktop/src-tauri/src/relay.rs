//! The user's own browser for the app's chats, from this computer (Browser panel → Your own browser): omp's relay
//! extension in a browser here connects to 127.0.0.1:9224 on this computer. The window runs its server program's
//! `relay <address>` (the `omp-app relay` command) for the server on another computer that it shows, which carries the
//! extension's connection to that server over the server's own address, as a paired device: no tunnel, no account on
//! the server's computer. It starts when the page asks (with a one-time code the page makes, the first time), again at
//! each start of the app while it stays chosen here, and it stops with the app.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

use crate::remote;

/// The file that names the server whose browser relay this computer runs, beside the window's kept link.
const CHOICE_FILE: &str = "browser-relay";

struct Carrier {
    server: String,
    child: Child,
}

fn carrier() -> &'static Mutex<Option<Carrier>> {
    static CARRIER: OnceLock<Mutex<Option<Carrier>>> = OnceLock::new();
    CARRIER.get_or_init(|| Mutex::new(None))
}

/// The carrier's last line: what it did, or why it stopped.
fn last_line() -> &'static Mutex<String> {
    static LAST: OnceLock<Mutex<String>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(String::new()))
}

fn choice_file() -> Option<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    Some(remote::link_file(config_home.as_deref(), home.as_deref())?.with_file_name(CHOICE_FILE))
}

/// The server's address as the carrier takes it: an https origin, as the window opens servers on other computers.
fn server_origin(text: &str) -> Option<String> {
    let url = Url::parse(text.trim()).ok()?;
    let has_host = url.host_str().is_some_and(|host| !host.is_empty());
    (url.scheme() == "https" && has_host && url.path() == "/" && url.query().is_none())
        .then(|| url.origin().ascii_serialization())
}

/// A one-time pairing code as the app shows it (`K7F3-QX9M`): letters, digits and dashes, starting with a letter or digit.
fn code_shaped(code: &str) -> bool {
    code.len() <= 20
        && code.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Keeps each line the carrier prints (the last one is its state, or why it stopped).
fn keep_lines(output: impl Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            *last_line().lock().expect("the relay line lock") = line;
        }
    });
}

fn stop_running() {
    if let Some(mut running) = carrier().lock().expect("the relay lock").take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

fn start(app: &AppHandle, server: &str, code: Option<&str>) -> Result<(), String> {
    stop_running();
    let program = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join(crate::server::SERVER);
    let mut command = Command::new(program);
    command.args([OsStr::new("relay"), OsStr::new(server)]);
    if let Some(code) = code {
        command.args(["--code", code]);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("the relay could not start: {error}"))?;
    if let Some(out) = child.stdout.take() {
        keep_lines(out);
    }
    if let Some(err) = child.stderr.take() {
        keep_lines(err);
    }
    // One that cannot pair, or finds its port taken, ends at once: its reason goes back to the page.
    let deadline = Instant::now() + Duration::from_millis(2_500);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            thread::sleep(Duration::from_millis(100));
            let why = last_line().lock().expect("the relay line lock").clone();
            return Err(if why.is_empty() { "the relay stopped".to_owned() } else { why });
        }
        thread::sleep(Duration::from_millis(100));
    }
    *carrier().lock().expect("the relay lock") = Some(Carrier {
        server: server.to_owned(),
        child,
    });
    Ok(())
}

/// The page asks to carry this computer's browser to its server (another computer's), pairing with `code` the first
/// time; chosen here, it starts again with the app.
#[tauri::command]
pub async fn relay_carry(
    app: AppHandle,
    window: tauri::WebviewWindow,
    code: Option<String>,
) -> Result<(), String> {
    // The server is the one the asking window opened, and the page asking is that server's: a page brings this
    // computer's browser to its own server only.
    let opened = crate::server::window_origin(&app, window.label());
    let shown = window.url().ok().map(|url| url.origin().ascii_serialization());
    let server = match (opened, shown) {
        (Some(opened), Some(shown)) if opened == shown => server_origin(&opened),
        _ => None,
    }
    .ok_or("only a window showing a server on another computer, at its https address")?;
    if let Some(code) = code.as_deref() {
        if !code_shaped(code) {
            return Err("that is not a pairing code".to_owned());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        start(&app, &server, code.as_deref())?;
        if let Some(file) = choice_file() {
            if let Some(folder) = file.parent() {
                let _ = std::fs::create_dir_all(folder);
            }
            let _ = std::fs::write(file, format!("{server}\n"));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether this computer carries its browser to a server now, which, and its last line.
#[tauri::command]
pub fn relay_state() -> Value {
    let mut guard = carrier().lock().expect("the relay lock");
    let running = match guard.as_mut() {
        Some(carried) => match carried.child.try_wait() {
            Ok(None) => Some(carried.server.clone()),
            _ => None,
        },
        None => None,
    };
    if running.is_none() {
        *guard = None;
    }
    json!({
        "server": running,
        "line": last_line().lock().expect("the relay line lock").clone(),
    })
}

/// Stops carrying, and forgets the choice.
#[tauri::command]
pub fn relay_stop() {
    stop_running();
    if let Some(file) = choice_file() {
        let _ = std::fs::remove_file(file);
    }
}

/// At the app's start: carries again for the server chosen before.
pub fn start_kept(app: AppHandle) {
    let Some(server) = choice_file()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| server_origin(&text))
    else {
        return;
    };
    thread::spawn(move || {
        let _ = start(&app, &server, None);
    });
}

/// The app ends: so does what it carries.
pub fn quitting() {
    stop_running();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_https_server_at_its_root_and_a_code_shaped_code_are_taken() {
        assert_eq!(server_origin("https://omp.example.com/").as_deref(), Some("https://omp.example.com"));
        assert_eq!(server_origin("https://omp.example.com:8443").as_deref(), Some("https://omp.example.com:8443"));
        for bad in ["http://omp.example.com", "https://omp.example.com/x", "https://a/?q", "file:///x", "nonsense"] {
            assert_eq!(server_origin(bad), None, "{bad}");
        }
        assert!(code_shaped("ABCD-1234"));
        for bad in ["", "a b", "--port", "x".repeat(21).as_str()] {
            assert!(!code_shaped(bad), "{bad}");
        }
    }
}
