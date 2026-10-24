//! The address of the running server. The server records itself when it listens, in `instance.json` in its
//! state folder (`$XDG_STATE_HOME/omp-app`, or `~/.local/state/omp-app`): its pid and its address
//! `http://127.0.0.1:<port>/#token=<token>`. The window reads that record to attach to a server that already
//! runs, and to learn the address of one it started. The token is the window's login: it is kept in memory and
//! never logged.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

const PREFIX: &str = "http://127.0.0.1:";
const TOKEN_MARK: &str = "/#token=";
/// The record's place under the state folder (see `stateDirectory` and `instanceFile` in packages/server).
const RECORD_FOLDER: &str = "omp-app";
const RECORD_FILE: &str = "instance.json";
/// How long a record that names a live process gets to answer before it counts as stale.
const ANSWER_WAIT: Duration = Duration::from_secs(2);
/// How often a wait for the record looks at it again.
const RECORD_POLL: Duration = Duration::from_millis(100);

/// The address a server is recorded at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchAddress {
    /// The whole address, token included: it is the window's address.
    pub url: String,
    pub port: u16,
}

/// Finds the server's address in a text. The text may have spaces around it.
pub fn find(line: &str) -> Option<LaunchAddress> {
    let start = line.find(PREFIX)?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = &rest[..end];
    let digits = &url[PREFIX.len()..];
    let digit_count = digits.bytes().take_while(u8::is_ascii_digit).count();
    let port: u16 = digits[..digit_count].parse().ok()?;
    let token = digits[digit_count..].strip_prefix(TOKEN_MARK)?;
    if token.is_empty() {
        return None;
    }
    Some(LaunchAddress {
        url: url.to_string(),
        port,
    })
}

/// Where the server records itself: `$XDG_STATE_HOME/omp-app/instance.json` when that variable is an absolute
/// path, otherwise `$HOME/.local/state/omp-app/instance.json`, the rule the server follows. None without a home.
pub fn instance_file(state_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    let state = match state_home {
        Some(path) if Path::new(path).is_absolute() => PathBuf::from(path),
        _ => {
            let home = home.filter(|name| !name.is_empty())?;
            Path::new(home).join(".local").join("state")
        }
    };
    Some(state.join(RECORD_FOLDER).join(RECORD_FILE))
}

/// Whether a process with this pid exists. Signal 0 checks that without sending anything; EPERM means the
/// process exists and belongs to someone else.
fn is_alive(pid: libc::pid_t) -> bool {
    // SAFETY: `kill` with signal 0 sends nothing; it only reports whether the process exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The address in `record`, if the record parses and the process it names is alive. A missing or corrupt record,
/// or one of a process that has ended, is None. Whether the address answers is not asked.
pub fn read_live_instance(record: &Path) -> Option<LaunchAddress> {
    let text = fs::read_to_string(record).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = value.get("pid")?.as_i64()?;
    let pid = libc::pid_t::try_from(pid).ok()?;
    // A pid of 0 or below would make `kill` signal a whole group instead of one process.
    if pid <= 0 {
        return None;
    }
    let address = find(value.get("url")?.as_str()?)?;
    is_alive(pid).then_some(address)
}

/// The server recorded in `record`, if it is really running: its process is alive and its address answers
/// within `ANSWER_WAIT`. A missing, corrupt or stale record means nothing runs.
pub fn answering_instance(record: &Path) -> Option<LaunchAddress> {
    let address = read_live_instance(record)?;
    let answered = wait_for_answer(address.port, ANSWER_WAIT);
    answered.then_some(address)
}

/// Waits until `record` names a live process whose address answers, for at most `timeout`. The process may not be
/// the one that was started: a server that finds another instance running ends, and the record names that instance.
pub fn wait_for_instance(record: &Path, timeout: Duration) -> Option<LaunchAddress> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(address) = read_live_instance(record) {
            if answers(address.port) {
                return Some(address);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep(RECORD_POLL);
    }
}

/// Whether the server on this loopback port answers its start page with 200.
pub fn answers(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return false;
    };
    let timeout = Some(Duration::from_secs(3));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut head = Vec::new();
    let mut chunk = [0_u8; 64];
    while head.len() < 12 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&chunk[..n]),
        }
    }
    head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200")
}

/// Waits until the server answers, for at most `timeout`.
pub fn wait_for_answer(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if answers(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(150));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// What a running server answers its start page with.
    const OK_PAGE: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi";
    const UNDER_STATE: &str = "/var/state/omp-app/instance.json";
    const UNDER_HOME: &str = "/home/u/.local/state/omp-app/instance.json";

    #[test]
    fn finds_the_address_on_a_line_with_spaces_around_it() {
        let found = find("  http://127.0.0.1:4317/#token=abc-123_x  \n").unwrap();
        assert_eq!(found.url, "http://127.0.0.1:4317/#token=abc-123_x");
        assert_eq!(found.port, 4317);
    }

    #[test]
    fn ignores_lines_that_are_not_a_launch_address() {
        assert_eq!(find("omp app 0.1.9"), None);
        assert_eq!(find("http://127.0.0.1:4317/"), None, "no token");
        assert_eq!(find("http://127.0.0.1:4317/#token="), None, "empty token");
        assert_eq!(find("http://localhost:4317/#token=x"), None, "other host");
        assert_eq!(
            find("http://127.0.0.1:99999/#token=x"),
            None,
            "port out of range"
        );
        assert_eq!(find("http://127.0.0.1:/#token=x"), None, "no port");
    }

    /// A one-shot server on a free loopback port that answers the first request with `response`.
    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 512];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    /// A loopback port that nothing listens on.
    fn free_port() -> u16 {
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        closed.local_addr().unwrap().port()
    }

    #[test]
    fn a_200_answer_means_the_server_is_up() {
        let port = serve_once(OK_PAGE);
        assert!(answers(port));
    }

    #[test]
    fn any_other_answer_or_no_server_means_not_up() {
        let port = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        assert!(!answers(port));
        assert!(!answers(free_port()));
    }

    #[test]
    fn waiting_gives_up_after_the_timeout() {
        let free = free_port();
        let started = Instant::now();
        assert!(!wait_for_answer(free, Duration::from_millis(400)));
        assert!(started.elapsed() >= Duration::from_millis(400));
    }

    /// A temporary folder for one test, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let name = format!("omp-app-desktop-test-{}-{name}", std::process::id());
            let folder = std::env::temp_dir().join(name);
            let _ = fs::remove_dir_all(&folder);
            fs::create_dir_all(&folder).unwrap();
            Self(folder)
        }

        fn record(&self) -> PathBuf {
            self.0.join(RECORD_FILE)
        }

        fn put(&self, text: &str) {
            fs::write(self.record(), text).unwrap();
        }

        /// Writes a record the way the server does: a pid, the address on a port, and a version.
        fn put_record(&self, pid: i64, port: u16) {
            self.put(&record_text(pid, port));
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record_text(pid: i64, port: u16) -> String {
        let url = format!("http://127.0.0.1:{port}/#token=t0k-en");
        format!(r#"{{"pid":{pid},"url":"{url}","version":"0.1.9"}}"#)
    }

    /// The pid of this test process: alive for as long as the test runs.
    fn own_pid() -> i64 {
        i64::from(std::process::id())
    }

    fn check_file(state: Option<&str>, home: Option<&str>, expected: Option<&str>) {
        let found = instance_file(state.map(OsStr::new), home.map(OsStr::new));
        assert_eq!(found, expected.map(PathBuf::from), "{state:?} {home:?}");
    }

    #[test]
    fn the_record_is_where_the_server_writes_it() {
        check_file(Some("/var/state"), Some("/home/u"), Some(UNDER_STATE));
        check_file(Some("/var/state"), None, Some(UNDER_STATE));
        check_file(None, Some("/home/u"), Some(UNDER_HOME));
        check_file(Some("relative"), Some("/home/u"), Some(UNDER_HOME));
        check_file(Some(""), Some("/home/u"), Some(UNDER_HOME));
        check_file(None, None, None);
        check_file(None, Some(""), None);
    }

    #[test]
    fn a_record_of_a_live_process_gives_its_address() {
        let scratch = Scratch::new("valid");
        scratch.put_record(own_pid(), 4317);
        let expected = LaunchAddress {
            url: "http://127.0.0.1:4317/#token=t0k-en".to_owned(),
            port: 4317,
        };
        assert_eq!(read_live_instance(&scratch.record()), Some(expected));
    }

    #[test]
    fn a_missing_record_is_nothing_running() {
        let scratch = Scratch::new("missing");
        assert_eq!(read_live_instance(&scratch.record()), None);
    }

    #[test]
    fn a_corrupt_record_is_nothing_running() {
        let scratch = Scratch::new("corrupt");
        for text in [
            "",
            "{",
            "not json",
            r#"{"pid":"#,
            "[]",
            r#"{"url":"http://127.0.0.1:4317/#token=t"}"#,
            r#"{"pid":1}"#,
            r#"{"pid":"12","url":"http://127.0.0.1:4317/#token=t"}"#,
            r#"{"pid":1.5,"url":"http://127.0.0.1:4317/#token=t"}"#,
            r#"{"pid":1,"url":"http://example.com/#token=t"}"#,
            r#"{"pid":1,"url":4317}"#,
        ] {
            scratch.put(text);
            assert_eq!(read_live_instance(&scratch.record()), None, "{text:?}");
        }
    }

    #[test]
    fn a_pid_that_cannot_name_one_process_is_nothing_running() {
        let scratch = Scratch::new("odd-pid");
        for pid in [0, -1, i64::from(i32::MAX) + 1] {
            scratch.put_record(pid, 4317);
            assert_eq!(read_live_instance(&scratch.record()), None, "pid {pid}");
        }
    }

    #[test]
    fn a_record_of_a_process_that_has_ended_is_nothing_running() {
        let scratch = Scratch::new("dead-pid");
        // Above the largest pid Linux hands out, so no process has it.
        scratch.put_record(i64::from(i32::MAX), 4317);
        assert_eq!(read_live_instance(&scratch.record()), None);
    }

    #[test]
    fn a_live_record_whose_address_answers_is_the_running_server() {
        let scratch = Scratch::new("answering");
        let port = serve_once(OK_PAGE);
        scratch.put_record(own_pid(), port);
        let found = answering_instance(&scratch.record()).unwrap();
        assert_eq!(found.port, port);
    }

    #[test]
    fn waiting_for_the_record_finds_it_once_it_is_written_and_answers() {
        let scratch = Scratch::new("appears");
        let port = serve_once(OK_PAGE);
        let record = scratch.record();
        let text = record_text(own_pid(), port);
        let writer = thread::spawn(move || {
            sleep(Duration::from_millis(300));
            fs::write(&record, text).unwrap();
        });
        let found = wait_for_instance(&scratch.record(), Duration::from_secs(10));
        writer.join().unwrap();
        assert_eq!(found.map(|address| address.port), Some(port));
    }

    #[test]
    fn waiting_for_the_record_gives_up_after_the_timeout() {
        let scratch = Scratch::new("never");
        // A record of a live process whose address does not answer is not enough either.
        scratch.put_record(own_pid(), free_port());
        let started = Instant::now();
        let found = wait_for_instance(&scratch.record(), Duration::from_millis(400));
        assert_eq!(found, None);
        assert!(started.elapsed() >= Duration::from_millis(400));
    }
}
