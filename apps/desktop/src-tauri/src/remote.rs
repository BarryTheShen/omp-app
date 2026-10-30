//! The app's server on another computer of the tailnet. The server can serve a browser on another device: it then
//! runs behind `tailscale serve` with `OMP_APP_REMOTE_ORIGIN`, and logs a link for that device,
//! `https://<computer>.<tailnet>.ts.net/#token=<token>`. The window opens such a server when it keeps that link:
//! `omp-app-desktop --remote '<link>'` keeps it, and `omp-app-desktop --local` forgets it, so the window goes back to
//! this computer's server. The token is the window's login: the link is kept in a file only this account can read,
//! and it is never logged.

use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Url;

/// Where the link is kept, under the config folder.
const LINK_FOLDER: &str = "omp-app";
const LINK_FILE: &str = "desktop-server";
/// The servers on other computers the window opened, beside the kept link.
const SERVERS_FILE: &str = "desktop-servers";
/// How many of them the window remembers.
const REMEMBERED: usize = 8;
/// The paths a link may name: the app's root, or the new UI under `/v2/`.
const LINK_PATHS: [&str; 2] = ["/", "/v2/"];
/// How long the window waits for the other computer to accept a connection before it shows the error page.
const CONNECT_WAIT: Duration = Duration::from_secs(5);
/// Why a `--remote` was refused.
const MISSING_LINK: &str = "--remote needs the server's link";
pub const LINK_SHAPE: &str =
    "the link must look like https://<computer>.<tailnet>.ts.net/#token=<token>";

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Choice {
    /// Keep this link and open the server it names.
    Remote(Url),
    /// Forget the kept link: this computer's server.
    Local,
    /// Nothing asked: the kept link, or this computer's server.
    Unchanged,
}

/// Reads `--remote <link>` (or `--remote=<link>`) and `--local` from the arguments, the program's name left out. The
/// last of them counts. A `--remote` whose link is missing or has another shape is refused with the reason.
pub fn choice(args: &[String]) -> Result<Choice, String> {
    let mut found = Choice::Unchanged;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--local" {
            found = Choice::Local;
        } else if arg == "--remote" {
            let text = args.next().ok_or(MISSING_LINK)?;
            found = Choice::Remote(parse_link(text).ok_or(LINK_SHAPE)?);
        } else if let Some(text) = arg.strip_prefix("--remote=") {
            found = Choice::Remote(parse_link(text).ok_or(LINK_SHAPE)?);
        }
    }
    Ok(found)
}

/// The link of a server on another computer: an https address with a host, at the app's root or its new UI (`/v2/`),
/// whose fragment carries a token. Plain http is refused, since the token would cross the network unencrypted.
pub fn parse_link(text: &str) -> Option<Url> {
    let url = Url::parse(text.trim()).ok()?;
    let has_host = url.host_str().is_some_and(|host| !host.is_empty());
    let mut pairs = url.fragment().unwrap_or_default().split('&');
    let token = pairs.find_map(|pair| pair.strip_prefix("token="));
    let has_token = token.is_some_and(|token| !token.is_empty());
    let shaped = url.scheme() == "https" && LINK_PATHS.contains(&url.path());
    (shaped && has_host && has_token).then_some(url)
}

/// The link's origin, `https://<computer>.<tailnet>.ts.net`: the window's own pages while the link is kept.
pub fn origin(link: &Url) -> String {
    link.origin().ascii_serialization()
}

/// The computer to name in messages: the link without its token.
pub fn host(link: &Url) -> String {
    link.host_str().unwrap_or_default().to_owned()
}

/// Where the window keeps the link: `$XDG_CONFIG_HOME/omp-app/desktop-server` when that variable is an absolute path,
/// otherwise `$HOME/.config/omp-app/desktop-server`. None without a home.
pub fn link_file(config_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    let config = match config_home {
        Some(path) if Path::new(path).is_absolute() => PathBuf::from(path),
        _ => {
            let home = home.filter(|name| !name.is_empty())?;
            Path::new(home).join(".config")
        }
    };
    Some(config.join(LINK_FOLDER).join(LINK_FILE))
}

/// The kept link, if the file holds one of the right shape. A missing or damaged file means none.
pub fn kept(file: &Path) -> Option<Url> {
    parse_link(&fs::read_to_string(file).ok()?)
}

/// Writes `text` and a newline to `file`, which only this account can read or write.
fn write_private(file: &Path, text: &str) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o600);
    let mut out = options.open(file)?;
    // A file that was there before keeps its old mode when it is opened: set it.
    fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    writeln!(out, "{text}")
}

/// Keeps `link` in `file`, which only this account can read or write.
pub fn keep(file: &Path, link: &Url) -> io::Result<()> {
    write_private(file, link.as_str())
}

/// Where the window remembers the servers on other computers it opened: beside the kept link.
pub fn servers_file(config_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    Some(link_file(config_home, home)?.with_file_name(SERVERS_FILE))
}

/// The servers on other computers the window opened, newest first. A missing or damaged file means none; a line of
/// another shape is skipped.
pub fn remembered(file: &Path) -> Vec<Url> {
    fs::read_to_string(file)
        .map(|text| text.lines().filter_map(parse_link).collect())
        .unwrap_or_default()
}

/// Remembers `link` first among the servers the window opened: one per computer (a newer link replaces an older one,
/// whose token may have changed), at most `REMEMBERED`, in a file only this account can read.
pub fn remember(file: &Path, link: &Url) -> io::Result<()> {
    let mut links = vec![link.clone()];
    links.extend(
        remembered(file)
            .into_iter()
            .filter(|known| origin(known) != origin(link)),
    );
    links.truncate(REMEMBERED);
    let lines: Vec<&str> = links.iter().map(Url::as_str).collect();
    write_private(file, &lines.join("\n"))
}

/// Forgets the kept link. No file is not an error.
pub fn forget(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Whether the other computer accepts a connection on the link's port within `CONNECT_WAIT`: it is reachable, and
/// something listens there (`tailscale serve`). The page that opens then says whether the server behind it answers.
pub fn reachable(link: &Url) -> bool {
    let (Some(host), Some(port)) = (link.host_str(), link.port_or_known_default()) else {
        return false;
    };
    let Ok(mut addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses.any(|address| TcpStream::connect_timeout(&address, CONNECT_WAIT).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};

    const LINK: &str = "https://devbox.tail1234.ts.net/#token=abc-123_x";

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn the_link_the_server_logs_for_another_device_is_accepted() {
        let link = parse_link(&format!("  {LINK}\n")).unwrap();
        assert_eq!(link.as_str(), LINK);
        assert_eq!(origin(&link), "https://devbox.tail1234.ts.net");
        assert_eq!(host(&link), "devbox.tail1234.ts.net");
        let more = "https://devbox.tail1234.ts.net/#token=t&folder=%2Fhome%2Fuser";
        assert!(parse_link(more).is_some(), "other fields may follow");
        let new_ui = "https://devbox.tail1234.ts.net/v2/#token=t";
        assert!(parse_link(new_ui).is_some(), "the new UI's page");
    }

    #[test]
    fn links_of_another_shape_are_refused() {
        let refused = [
            "http://devbox.tail1234.ts.net/#token=t",
            "https://devbox.tail1234.ts.net/",
            "https://devbox.tail1234.ts.net/#token=",
            "https://devbox.tail1234.ts.net/app#token=t",
            "devbox.tail1234.ts.net/#token=t",
            "",
        ];
        for text in refused {
            assert_eq!(parse_link(text), None, "{text}");
        }
    }

    #[test]
    fn the_command_line_keeps_a_link_forgets_it_or_changes_nothing() {
        let link = Url::parse(LINK).unwrap();
        let joined = format!("--remote={LINK}");
        let remote = Ok(Choice::Remote(link));
        assert_eq!(choice(&args(&["--remote", LINK])), remote);
        assert_eq!(choice(&args(&[joined.as_str()])), remote);
        assert_eq!(choice(&args(&["--local"])), Ok(Choice::Local));
        let both = args(&["--remote", LINK, "--local"]);
        assert_eq!(choice(&both), Ok(Choice::Local), "the last one counts");
        assert_eq!(choice(&args(&[])), Ok(Choice::Unchanged));
    }

    #[test]
    fn a_remote_choice_without_a_good_link_is_refused_with_the_reason() {
        assert_eq!(choice(&args(&["--remote"])), Err(MISSING_LINK.to_owned()));
        let plain = args(&["--remote", "http://devbox.tail1234.ts.net/#token=t"]);
        assert_eq!(choice(&plain), Err(LINK_SHAPE.to_owned()));
    }

    #[test]
    fn the_link_file_follows_the_config_folder_rule() {
        let home = Some(OsStr::new("/home/u"));
        let config = link_file(Some(OsStr::new("/var/config")), home);
        let expected = PathBuf::from("/var/config/omp-app/desktop-server");
        assert_eq!(config, Some(expected));
        let relative = link_file(Some(OsStr::new("relative")), home);
        let under_home = PathBuf::from("/home/u/.config/omp-app/desktop-server");
        assert_eq!(relative, Some(under_home), "a relative folder is ignored");
        assert_eq!(link_file(None, None), None);
    }

    /// A temporary folder for one test, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let name = format!("omp-app-desktop-remote-{}-{name}", std::process::id());
            let folder = std::env::temp_dir().join(name);
            let _ = fs::remove_dir_all(&folder);
            fs::create_dir_all(&folder).unwrap();
            Self(folder)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mode(file: &Path) -> u32 {
        fs::metadata(file).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_kept_link_is_read_back_private_and_forgetting_removes_it() {
        let scratch = Scratch::new("keep");
        let file = scratch.0.join("omp-app").join(LINK_FILE);
        assert_eq!(kept(&file), None);
        let link = Url::parse(LINK).unwrap();
        keep(&file, &link).unwrap();
        assert_eq!(kept(&file), Some(link));
        assert_eq!(mode(&file), 0o600);
        forget(&file).unwrap();
        assert_eq!(kept(&file), None);
        forget(&file).unwrap();
    }

    #[test]
    fn a_link_kept_over_a_readable_file_makes_it_private() {
        let scratch = Scratch::new("mode");
        let file = scratch.0.join(LINK_FILE);
        fs::write(&file, "old").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        keep(&file, &Url::parse(LINK).unwrap()).unwrap();
        assert_eq!(mode(&file), 0o600);
    }

    #[test]
    fn a_damaged_link_file_counts_as_no_link() {
        let scratch = Scratch::new("damaged");
        let file = scratch.0.join(LINK_FILE);
        fs::write(&file, "http://devbox.tail1234.ts.net/#token=t").unwrap();
        assert_eq!(kept(&file), None);
    }

    #[test]
    fn remembered_servers_are_newest_first_one_per_computer_at_most_eight_and_private() {
        let scratch = Scratch::new("servers");
        let file = scratch.0.join("omp-app").join(SERVERS_FILE);
        assert!(remembered(&file).is_empty());
        let link = |computer: &str, token: &str| {
            Url::parse(&format!(
                "https://{computer}.tail1234.ts.net/#token={token}"
            ))
            .unwrap()
        };
        remember(&file, &link("a", "1")).unwrap();
        remember(&file, &link("b", "1")).unwrap();
        // The same computer again, with a new token: it moves first, and its old link goes.
        remember(&file, &link("a", "2")).unwrap();
        assert_eq!(remembered(&file), vec![link("a", "2"), link("b", "1")]);
        assert_eq!(mode(&file), 0o600);
        for n in 0..10 {
            remember(&file, &link(&format!("c{n}"), "1")).unwrap();
        }
        let kept = remembered(&file);
        assert_eq!(kept.len(), REMEMBERED);
        assert_eq!(kept[0], link("c9", "1"));
        assert!(!kept.contains(&link("a", "2")), "the oldest are forgotten");
    }

    #[test]
    fn the_servers_file_sits_beside_the_kept_link() {
        let home = Some(OsStr::new("/home/u"));
        let expected = PathBuf::from("/home/u/.config/omp-app/desktop-servers");
        assert_eq!(servers_file(None, home), Some(expected));
    }

    fn link_to(port: u16) -> Url {
        Url::parse(&format!("https://127.0.0.1:{port}/#token=t")).unwrap()
    }

    #[test]
    fn a_computer_that_accepts_connections_is_reachable_and_a_closed_port_is_not() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let open = listener.local_addr().unwrap().port();
        assert!(reachable(&link_to(open)));
        drop(listener);
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(!reachable(&link_to(closed_port)));
    }
}
