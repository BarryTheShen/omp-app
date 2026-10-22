//! Finds the omp coding agent for the server. A window started from the applications menu gets the
//! desktop session's PATH, which often lacks the folders omp is installed in: the owner's shell adds
//! `~/.bun/bin`, the session does not. So the window looks for omp itself and passes what it finds to
//! the server as `OMP_BIN`. The steps, in order: the window's PATH, `~/.bun/bin`, `~/.local/bin`,
//! `/usr/local/bin`, `/usr/bin`, and last the user's login shell, which sees the PATH the user set up.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long the login shell may take to answer. Shell start-up files can be slow, so this stays short.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// The system folders, checked after the home folders.
const SYSTEM_DIRS: [&str; 2] = ["/usr/local/bin", "/usr/bin"];

/// Where to look for omp.
pub struct Search<'a> {
    /// The window's PATH.
    pub path: Option<&'a OsStr>,
    /// The user's home folder.
    pub home: Option<&'a Path>,
    /// The user's login shell (from SHELL).
    pub shell: Option<&'a Path>,
    /// The system folders, in the order to check them.
    pub system_dirs: &'a [&'a Path],
    /// How long the login shell may take to answer.
    pub shell_timeout: Duration,
    /// The handle that quitting cancels the login-shell lookup with (see `cancel_lookup`).
    pub lookup: &'a Lookup,
}

/// The search as the app runs it: the steps that need no shell, then the login shell.
pub fn from_environment() -> Option<PathBuf> {
    environment_search(true)
}

/// The steps that need no shell: the window's PATH, the home folders and the system folders. No process starts, so the
/// window can ask this before it is built (see `server.rs`).
pub fn quick_from_environment() -> Option<PathBuf> {
    environment_search(false)
}

/// The search as the app runs it. `login` adds the login shell as the last step.
fn environment_search(login: bool) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let shell = std::env::var_os("SHELL").map(PathBuf::from);
    let path = std::env::var_os("PATH");
    let system_dirs = SYSTEM_DIRS.map(Path::new);
    let search = Search {
        path: path.as_deref(),
        home: home.as_deref(),
        shell: shell.as_deref(),
        system_dirs: &system_dirs,
        shell_timeout: LOGIN_SHELL_TIMEOUT,
        lookup: &LOOKUP,
    };
    if login {
        find(&search)
    } else {
        quick(&search)
    }
}

/// The first executable file named omp in the steps above, or None if no step finds one.
pub fn find(search: &Search) -> Option<PathBuf> {
    quick(search).or_else(|| login_shell(search))
}

/// The first executable file named omp in the folders of the search: the window's PATH, `~/.bun/bin`, `~/.local/bin` and
/// the system folders, in that order. Starts no process.
pub fn quick(search: &Search) -> Option<PathBuf> {
    let mut folders: Vec<PathBuf> = search
        .path
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    if let Some(home) = search.home {
        folders.push(home.join(".bun").join("bin"));
        folders.push(home.join(".local").join("bin"));
    }
    folders.extend(search.system_dirs.iter().map(|dir| dir.to_path_buf()));
    folders
        .into_iter()
        // A relative PATH entry would mean "the folder the app was started in": never searched.
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("omp"))
        .find(|candidate| is_executable(candidate))
}

/// Asks the search's login shell for omp, if it has one. The shell starts only when `quick` found nothing.
fn login_shell(search: &Search) -> Option<PathBuf> {
    search
        .shell
        .and_then(|shell| ask_login_shell(shell, search.shell_timeout, search.lookup))
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Asks the login shell where omp is, the way a terminal would see it: `command -v omp` in an
/// interactive login shell, which reads the user's start-up files. The answer is written to a file,
/// not a pipe, so a background process that a start-up file leaves behind cannot hold it open. The
/// wait ends when the shell exits. A shell still running after `timeout` is ended with its whole
/// process group, so nothing it started keeps running.
fn ask_login_shell(shell: &Path, timeout: Duration, lookup: &Lookup) -> Option<PathBuf> {
    let answer_path = answer_file()?;
    let answer = {
        // Created under the lookup's lock: a cancel that comes later finds the file and removes it.
        let mut state = lookup.lock();
        if state.cancelled {
            return None;
        }
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&answer_path)
            .ok()?;
        state.answer = Some(answer_path.clone());
        file
    };
    let found = run_shell(shell, &answer, timeout, lookup).and_then(|()| read_answer(&answer_path));
    let mut state = lookup.lock();
    state.answer = None;
    let _ = fs::remove_file(&answer_path);
    found
}

/// A new file name in the temporary folder. `create_new` refuses a name that already exists.
fn answer_file() -> Option<PathBuf> {
    // A counter as well as the time: two lookups in one process must never pick the same name.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let number = NEXT.fetch_add(1, Ordering::Relaxed);
    Some(std::env::temp_dir().join(format!(
        "omp-app-omp-{}-{nanos}-{number}",
        std::process::id()
    )))
}

/// Starts the login shell with `answer` as its output: its own process group, so a shell that hangs, and
/// what it started, can be ended together. The retry below is explained where it is.
fn spawn_login_shell(shell: &Path, answer: &File) -> io::Result<Child> {
    let mut attempts = 0;
    loop {
        let started = Command::new(shell)
            .args(["-ilc", "command -v omp"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(answer.try_clone()?))
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
        // The retry is for a shell file that was written a moment ago, as a package upgrade does and as the
        // tests do. Until every process that holds the file open for writing has started its own program (a
        // fork that is still starting does), starting the file fails with ETXTBSY ("text file busy"). Only that
        // error is retried, 25 times 20 ms apart (half a second); every other error is returned at once.
        match started {
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 25 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

/// Runs the login shell until it exits, or ends it with its process group after `timeout`. Returns
/// Some once the shell has exited, whatever it answered.
fn run_shell(shell: &Path, answer: &File, timeout: Duration, lookup: &Lookup) -> Option<()> {
    let mut child = spawn_login_shell(shell, answer).ok()?;
    let group = child.id() as libc::pid_t;
    {
        let mut state = lookup.lock();
        if state.cancelled {
            // The app quit while the shell was starting.
            drop(state);
            kill_group(group);
            let _ = child.wait();
            return None;
        }
        state.group = Some(group);
    }
    let started = Instant::now();
    let mut exited = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            _ => break,
        }
    }
    if !exited {
        // Still running after `timeout` (or the wait failed): end the shell's group with it.
        kill_group(group);
    }
    lookup.lock().group = None;
    let _ = child.wait();
    exited.then_some(())
}

/// The last absolute path in the answer that is an executable file. Start-up files may print other
/// lines first.
fn read_answer(path: &Path) -> Option<PathBuf> {
    fs::read_to_string(path)
        .ok()?
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .filter(|candidate| is_executable(candidate))
}

/// The one login-shell lookup the app makes. Quitting cancels it (see `cancel_lookup`).
static LOOKUP: Lookup = Lookup::new();

/// The app is quitting: a login-shell lookup still running is ended with its process group, and its
/// answer file is removed. Safe to call more than once.
pub fn cancel_lookup() {
    LOOKUP.cancel();
}

/// A login-shell lookup that another thread can cancel. Cancelling ends the shell's process group (the
/// shell and what it started) and removes the answer file; a lookup that starts after a cancel does nothing.
pub struct Lookup {
    state: Mutex<LookupState>,
}

#[derive(Default)]
struct LookupState {
    /// The shell's process group while the shell runs; its id is the shell's pid.
    group: Option<libc::pid_t>,
    /// The answer file, from its creation until it is removed.
    answer: Option<PathBuf>,
    /// Set by `cancel`: nothing starts after it.
    cancelled: bool,
}

impl Lookup {
    const fn new() -> Lookup {
        Lookup {
            state: Mutex::new(LookupState {
                group: None,
                answer: None,
                cancelled: false,
            }),
        }
    }

    /// Ends the lookup: the shell's group is killed and the answer file removed.
    pub fn cancel(&self) {
        let mut state = self.lock();
        state.cancelled = true;
        if let Some(group) = state.group.take() {
            kill_group(group);
        }
        if let Some(answer) = state.answer.take() {
            let _ = fs::remove_file(answer);
        }
    }

    fn lock(&self) -> MutexGuard<'_, LookupState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Ends the process group `group`, the login shell's group (its id is the shell's pid).
fn kill_group(group: libc::pid_t) {
    // SAFETY: the id is the pid of a login shell this process started, and the lookup clears it once the
    // shell has ended, so it still names that shell's group. killpg sends SIGKILL to that group only.
    unsafe { libc::killpg(group, libc::SIGKILL) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// The lookup the tests that search without cancelling share. It is never cancelled.
    static TEST_LOOKUP: Lookup = Lookup::new();

    /// A test folder under the system's temporary folder, removed when it is dropped.
    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Folder {
            let path =
                std::env::temp_dir().join(format!("omp-app-lookup-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("the test folder is created");
            Folder(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// Writes an omp file with `mode` into `dir` (relative to the test folder) and returns it.
        fn omp_in(&self, dir: &str, mode: u32) -> PathBuf {
            let folder = self.0.join(dir);
            fs::create_dir_all(&folder).expect("the folder is created");
            let file = folder.join("omp");
            fs::write(&file, "#!/bin/sh\nexit 0\n").expect("omp is written");
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).expect("mode is set");
            file
        }

        /// Writes a login shell that runs `body` (a shell command) and returns its path.
        fn shell(&self, name: &str, body: &str) -> PathBuf {
            let file = self.0.join(name);
            fs::write(&file, format!("#!/bin/sh\n{body}\n")).expect("the shell is written");
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).expect("mode is set");
            file
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn search<'a>(
        path: Option<&'a OsStr>,
        home: Option<&'a Path>,
        system_dirs: &'a [&'a Path],
        shell: Option<&'a Path>,
    ) -> Search<'a> {
        Search {
            path,
            home,
            shell,
            system_dirs,
            shell_timeout: Duration::from_secs(5),
            lookup: &TEST_LOOKUP,
        }
    }

    /// Whether a process with this pid is alive (a zombie is not).
    fn process_is_alive(pid: u32) -> bool {
        fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().next())
                .is_some_and(|state| state != "Z")
        })
    }

    #[test]
    fn the_windows_path_is_searched_first() {
        let folder = Folder::new("path-first");
        let on_path = folder.omp_in("on-path", 0o755);
        let _ = folder.omp_in("home/.bun/bin", 0o755);
        let _ = folder.omp_in("sys", 0o755);
        let path = std::env::join_paths([folder.path().join("on-path")]).unwrap();
        let home = folder.path().join("home");
        let sys = folder.path().join("sys");
        let system = [sys.as_path()];
        assert_eq!(
            find(&search(Some(path.as_os_str()), Some(&home), &system, None)),
            Some(on_path)
        );
    }

    #[test]
    fn the_path_is_searched_in_its_own_order() {
        let folder = Folder::new("path-order");
        let first = folder.omp_in("first", 0o755);
        let _ = folder.omp_in("second", 0o755);
        let path =
            std::env::join_paths([folder.path().join("first"), folder.path().join("second")])
                .unwrap();
        assert_eq!(
            find(&search(Some(path.as_os_str()), None, &[], None)),
            Some(first)
        );
    }

    #[test]
    fn the_home_bun_bin_is_searched_when_the_path_lacks_omp() {
        let folder = Folder::new("home-bun");
        let bun = folder.omp_in("home/.bun/bin", 0o755);
        let _ = folder.omp_in("home/.local/bin", 0o755);
        let home = folder.path().join("home");
        assert_eq!(find(&search(None, Some(&home), &[], None)), Some(bun));
    }

    #[test]
    fn the_home_local_bin_is_searched_after_bun_bin() {
        let folder = Folder::new("home-local");
        let local = folder.omp_in("home/.local/bin", 0o755);
        let home = folder.path().join("home");
        assert_eq!(
            find(&search(None, Some(&home), &[], None)),
            Some(local.clone())
        );
        let bun = folder.omp_in("home/.bun/bin", 0o755);
        assert_eq!(find(&search(None, Some(&home), &[], None)), Some(bun));
    }

    #[test]
    fn the_system_folders_are_searched_after_the_home_folders_in_order() {
        let folder = Folder::new("system");
        let usr_local = folder.omp_in("usr-local-bin", 0o755);
        let usr = folder.omp_in("usr-bin", 0o755);
        let home = folder.path().join("home");
        let local = folder.path().join("usr-local-bin");
        let bin = folder.path().join("usr-bin");
        let system = [local.as_path(), bin.as_path()];
        assert_eq!(
            find(&search(None, Some(&home), &system, None)),
            Some(usr_local)
        );
        fs::remove_file(folder.path().join("usr-local-bin/omp")).unwrap();
        assert_eq!(find(&search(None, Some(&home), &system, None)), Some(usr));
    }

    #[test]
    fn the_login_shell_is_asked_only_when_no_folder_has_omp() {
        let folder = Folder::new("login");
        let answer = folder.omp_in("login/omp-dir", 0o755);
        let shell = folder.shell("sh", &format!("echo '{}'", answer.display()));
        assert_eq!(
            find(&search(None, None, &[], Some(&shell))),
            Some(answer.clone())
        );

        // A folder with omp wins: the shell's answer is not needed, so a different answer is ignored.
        let other = folder.omp_in("other/omp-dir", 0o755);
        let path = std::env::join_paths([folder.path().join("other/omp-dir")]).unwrap();
        let shell_other = folder.shell("sh2", &format!("echo '{}'", answer.display()));
        assert_eq!(
            find(&search(
                Some(path.as_os_str()),
                None,
                &[],
                Some(&shell_other)
            )),
            Some(other)
        );
    }

    #[test]
    fn the_login_shell_answer_may_follow_other_lines_but_must_be_an_executable_path() {
        let folder = Folder::new("login-answer");
        let answer = folder.omp_in("answer", 0o755);
        let noisy = folder.shell(
            "noisy",
            &format!("echo 'Welcome back'; echo '{}'", answer.display()),
        );
        assert_eq!(
            find(&search(None, None, &[], Some(&noisy))),
            Some(answer.clone())
        );

        let bare = folder.shell("bare", "echo omp");
        assert_eq!(
            find(&search(None, None, &[], Some(&bare))),
            None,
            "a bare name is not a path"
        );

        let alias = folder.shell("alias", "echo 'omp: aliased to /x/omp'");
        assert_eq!(
            find(&search(None, None, &[], Some(&alias))),
            None,
            "an alias is not a path"
        );

        let not_executable = folder.omp_in("plain", 0o644);
        let plain = folder.shell(
            "plain-answer",
            &format!("echo '{}'", not_executable.display()),
        );
        assert_eq!(
            find(&search(None, None, &[], Some(&plain))),
            None,
            "a file that cannot run is refused"
        );

        let silent = folder.shell("silent", "true");
        assert_eq!(
            find(&search(None, None, &[], Some(&silent))),
            None,
            "no answer is no omp"
        );
    }

    #[test]
    fn the_login_shell_answer_is_read_when_the_shell_exits_not_when_its_output_closes() {
        // The shell answers and exits, but leaves a background process running. The answer must come
        // back at once: the lookup does not wait for a process that a start-up file left behind.
        let folder = Folder::new("login-exit");
        let answer = folder.omp_in("answer", 0o755);
        let pid_file = folder.path().join("background.pid");
        let body = format!(
            "echo '{}'; sleep 60 & echo $! > '{}'",
            answer.display(),
            pid_file.display()
        );
        let shell = folder.shell("leaves-a-process", &body);
        let started = Instant::now();
        let found = ask_login_shell(&shell, Duration::from_secs(10), &Lookup::new());
        let waited = started.elapsed();
        if let Ok(text) = fs::read_to_string(&pid_file) {
            if let Ok(pid) = text.trim().parse::<u32>() {
                // SAFETY: a plain kill(2) of the test's own background process.
                unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            }
        }
        assert_eq!(found, Some(answer));
        assert!(
            waited < Duration::from_secs(5),
            "waited for a process that was not the shell: {waited:?}"
        );
    }

    #[test]
    fn a_login_shell_that_hangs_is_ended_with_everything_it_started() {
        // The shell starts a background process, then hangs. At the timeout the whole group must end,
        // so the background process must end too.
        let folder = Folder::new("login-hang");
        let pid_file = folder.path().join("child.pid");
        let body = format!("sleep 60 & echo $! > '{}'; sleep 60", pid_file.display());
        let shell = folder.shell("hangs", &body);
        let started = Instant::now();
        let found = ask_login_shell(&shell, Duration::from_secs(1), &Lookup::new());
        let waited = started.elapsed();
        assert_eq!(found, None);
        assert!(
            waited < Duration::from_secs(10),
            "the wait was not bounded: {waited:?}"
        );
        let pid: u32 = fs::read_to_string(&pid_file)
            .expect("the shell wrote its background pid")
            .trim()
            .parse()
            .expect("the pid is a number");
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_is_alive(pid),
            "the shell's background process kept running"
        );
    }

    #[test]
    fn a_non_executable_omp_on_the_path_is_skipped_for_the_next_step() {
        let folder = Folder::new("not-executable");
        let _ = folder.omp_in("on-path", 0o644);
        let bun = folder.omp_in("home/.bun/bin", 0o755);
        let path = std::env::join_paths([folder.path().join("on-path")]).unwrap();
        let home = folder.path().join("home");
        assert_eq!(
            find(&search(Some(path.as_os_str()), Some(&home), &[], None)),
            Some(bun)
        );
    }

    #[test]
    fn nothing_found_is_none() {
        let folder = Folder::new("nothing");
        let home = folder.path().join("home");
        let sys = folder.path().join("sys");
        let system = [sys.as_path()];
        assert_eq!(find(&search(None, Some(&home), &system, None)), None);
    }

    #[test]
    fn relative_path_entries_are_never_searched() {
        let folder = Folder::new("relative");
        let home = folder.path().join("home");
        let path = OsStr::new("relative-folder:");
        assert_eq!(find(&search(Some(path), Some(&home), &[], None)), None);
    }

    #[test]
    fn cancelling_a_lookup_ends_its_shell_and_what_it_started_and_removes_its_answer() {
        let folder = Folder::new("cancel");
        let pids = folder.path().join("pids");
        // The shell and a background process it starts both keep running until they are ended.
        let shell = folder.shell(
            "shell",
            &format!(
                "echo $$ > '{p}.shell'; sleep 30 & echo $! > '{p}.background'; sleep 31",
                p = pids.display()
            ),
        );
        let lookup = Arc::new(Lookup::new());
        let worker = {
            let lookup = Arc::clone(&lookup);
            let shell = shell.clone();
            thread::spawn(move || ask_login_shell(&shell, Duration::from_secs(20), &lookup))
        };
        let read_pid =
            |path: PathBuf| -> Option<u32> { fs::read_to_string(path).ok()?.trim().parse().ok() };
        let shell_file = pids.with_extension("shell");
        let background_file = pids.with_extension("background");
        let started = Instant::now();
        let (shell_pid, background_pid) = loop {
            if let (Some(shell_pid), Some(background_pid)) = (
                read_pid(shell_file.clone()),
                read_pid(background_file.clone()),
            ) {
                break (shell_pid, background_pid);
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the shell never started"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let (group, answer) = {
            let state = lookup.lock();
            (state.group, state.answer.clone())
        };
        let answer = answer.expect("the answer file exists while the shell runs");
        assert_eq!(
            group,
            Some(shell_pid as libc::pid_t),
            "the shell leads its own group"
        );

        let cancelled = Instant::now();
        lookup.cancel();
        assert_eq!(worker.join().expect("the lookup thread ends"), None);
        assert!(
            cancelled.elapsed() < Duration::from_secs(5),
            "the lookup ended at once, not at its timeout"
        );
        assert!(!answer.exists(), "the answer file is removed");
        let ended = Instant::now();
        while process_is_alive(shell_pid) || process_is_alive(background_pid) {
            assert!(
                ended.elapsed() < Duration::from_secs(5),
                "the shell or what it started still runs"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_lookup_cancelled_before_it_starts_asks_nothing() {
        let folder = Folder::new("cancelled-first");
        let marker = folder.path().join("ran");
        let shell = folder.shell("shell", &format!("touch '{}'", marker.display()));
        let lookup = Lookup::new();
        lookup.cancel();
        assert_eq!(
            ask_login_shell(&shell, Duration::from_secs(5), &lookup),
            None
        );
        assert!(!marker.exists(), "the shell did not start");
    }

    #[test]
    fn the_quick_lookup_starts_no_process_so_the_login_shell_is_not_asked_first() {
        let folder = Folder::new("quick-no-shell");
        let marker = folder.path().join("ran");
        let shell = folder.shell("shell", &format!("touch '{}'", marker.display()));
        let home = folder.path().join("home");
        let sys = folder.path().join("sys");
        fs::create_dir_all(&sys).expect("the system folder is created");
        let system_dirs = [sys.as_path()];
        let search_of = search(None, Some(&home), &system_dirs, Some(&shell));
        assert_eq!(quick(&search_of), None);
        assert!(!marker.exists(), "the quick lookup started the login shell");
        assert_eq!(find(&search_of), None);
        assert!(
            marker.exists(),
            "the full lookup did not ask the login shell"
        );
    }
}
