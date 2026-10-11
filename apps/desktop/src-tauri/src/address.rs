//! The address the server prints when it starts: `http://127.0.0.1:<port>/#token=<token>`. The
//! token is the window's login: it is kept in memory and never logged.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::thread::sleep;
use std::time::{Duration, Instant};

const PREFIX: &str = "http://127.0.0.1:";
const TOKEN_MARK: &str = "/#token=";

/// The launch address found in the server's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchAddress {
    /// The whole address, token included: it is the window's address.
    pub url: String,
    pub port: u16,
}

/// Finds the launch address in one line of the server's output. The line may have spaces around it.
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

/// Whether the server says another instance already runs. It then prints that instance's address.
pub fn says_already_running(line: &str) -> bool {
    line.contains("already running")
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

    #[test]
    fn recognises_the_already_running_message() {
        assert!(says_already_running("omp app 0.1.9 is already running."));
        assert!(!says_already_running("omp app 0.1.9"));
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

    #[test]
    fn a_200_answer_means_the_server_is_up() {
        let port = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
        assert!(answers(port));
    }

    #[test]
    fn any_other_answer_or_no_server_means_not_up() {
        let port = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        assert!(!answers(port));
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let free = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(!answers(free));
    }

    #[test]
    fn waiting_gives_up_after_the_timeout() {
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let free = closed.local_addr().unwrap().port();
        drop(closed);
        let started = Instant::now();
        assert!(!wait_for_answer(free, Duration::from_millis(400)));
        assert!(started.elapsed() >= Duration::from_millis(400));
    }
}
